// Teams in the web app's shell, as pure code: the addresses of its screens, how live events change what the page
// holds, the sidebar's badge, and the roster an edit sends. What only the Teams screens use (their words, the board's
// groups, the forms' checks) is in team-words.ts, which loads with them (components/Teams*.tsx) when Teams first opens.

import type { ServerEvent, Team, TeamEvent, TeamItem, TeamMemberInput, TeamMessage, TeamSeat, TeamThread, TeamsAttention } from '../../shared/types.ts';

// ------------------------------------------------------------------ addresses

export type TeamsTab = 'work' | 'conversations' | 'team';
export const TEAMS_TABS: readonly TeamsTab[] = ['work', 'conversations', 'team'];

export type TeamsRoute =
  | { view: 'list' }
  | { view: 'team'; teamId: string; tab: TeamsTab }
  | { view: 'direct' }
  /** `messageId`: open the thread at that message (a search hit). */
  | { view: 'thread'; threadId: string; messageId: string | null }
  | { view: 'item'; itemId: string };

/** What the address shows: a chat (at one of its messages, when given), a Teams screen, or nothing chosen. */
export type AppRoute = { kind: 'chat'; botId: string; messageId: string | null } | { kind: 'teams'; route: TeamsRoute } | null;

const ID = '([\\w-]+)';

/** `#/teams`, `#/teams/<team>[/<tab>]`, `#/teams/direct`, `#/teams/t/<thread>[/<message>]`, `#/teams/i/<item>`. */
export function parseTeamsHash(hash: string): TeamsRoute | null {
  const path = hash.replace(/^#/, '').replace(/[?].*$/, '');
  if (!/^\/teams(\/|$)/.test(path)) return null;
  const parts = path.split('/').slice(2).filter(Boolean);
  const ok = (s: string | undefined): s is string => !!s && new RegExp(`^${ID}$`).test(s);
  if (!parts.length) return { view: 'list' };
  const [a, b, c] = parts;
  if (a === 'direct' && parts.length === 1) return { view: 'direct' };
  if (a === 't' && ok(b) && parts.length <= 3) return { view: 'thread', threadId: b, messageId: ok(c) ? c : null };
  if (a === 'i' && ok(b) && parts.length === 2) return { view: 'item', itemId: b };
  if (ok(a) && a !== 't' && a !== 'i' && a !== 'direct' && parts.length <= 2) {
    const tab = (TEAMS_TABS as readonly string[]).includes(b ?? '') ? (b as TeamsTab) : 'work';
    return { view: 'team', teamId: a, tab };
  }
  return { view: 'list' };
}

/** The address of a Teams screen, as `location.hash` takes it (with its leading `#`). */
export function teamsHash(route: TeamsRoute): string {
  const e = encodeURIComponent;
  switch (route.view) {
    case 'list':
      return '#/teams';
    case 'direct':
      return '#/teams/direct';
    case 'team':
      return route.tab === 'work' ? `#/teams/${e(route.teamId)}` : `#/teams/${e(route.teamId)}/${route.tab}`;
    case 'thread':
      return `#/teams/t/${e(route.threadId)}${route.messageId ? `/${e(route.messageId)}` : ''}`;
    case 'item':
      return `#/teams/i/${e(route.itemId)}`;
  }
}

/** A chat's address, at one of its messages when given: `#/m/<bot>[/<message>]`. */
export const chatHash = (botId: string, messageId?: string | null) => `#/m/${encodeURIComponent(botId)}${messageId ? `/${encodeURIComponent(messageId)}` : ''}`;

export function readRoute(hash: string): AppRoute {
  const teams = parseTeamsHash(hash);
  if (teams) return { kind: 'teams', route: teams };
  const m = new RegExp(`^#/m/${ID}(?:/${ID})?`).exec(hash);
  return m ? { kind: 'chat', botId: m[1]!, messageId: m[2] ?? null } : null;
}

// ------------------------------------------------------------------ what the page holds, and live events

/** A page of conversations, newest first: by scope, `all`, `direct` or a team id. */
export interface ThreadList {
  ids: string[];
  /** Older ones than the last exist on the server. */
  hasMore: boolean;
}

/** A thread's messages, by seq. */
export interface MessagePage {
  items: TeamMessage[];
  /** Earlier ones than the first exist on the server. */
  hasMore: boolean;
}

export interface TeamsSlice {
  /** Loaded with the first Teams visit, then kept live; archived last. */
  teams: Team[] | null;
  /** Loaded at start for the sidebar's badge, refreshed when the page catches up. */
  teamsAttention: TeamsAttention | null;
  /** Items by id: every item of a team whose board was loaded, and each item opened on its own. */
  teamItems: Record<string, TeamItem>;
  /** Teams whose board is loaded (a new item arriving live belongs on it), with their newest events. */
  teamBoards: Record<string, TeamEvent[]>;
  /** Each item opened on its own: its history. */
  itemEvents: Record<string, TeamEvent[]>;
  /** Threads by id: those of the lists loaded, and each thread opened. */
  teamThreads: Record<string, TeamThread>;
  threadLists: Record<string, ThreadList>;
  /** Each thread opened: its messages. */
  threadMessages: Record<string, MessagePage>;
}

export const emptyTeams = (): TeamsSlice => ({
  teams: null,
  teamsAttention: null,
  teamItems: {},
  teamBoards: {},
  itemEvents: {},
  teamThreads: {},
  threadLists: {},
  threadMessages: {},
});

/** The list scope a thread belongs to (besides `all`). */
export const threadScope = (t: Pick<TeamThread, 'teamId'>) => t.teamId ?? 'direct';

/**
 * Whether `next` may replace what the page holds: an answer or a page read before a live event can land after it,
 * and the copy with the higher version is the newer one.
 */
export const isNewer = (cur: { version: number } | undefined, next: { version: number }) => !cur || next.version >= cur.version;

const archivedLast = (list: Team[]) => [...list.filter((t) => t.state !== 'archived'), ...list.filter((t) => t.state === 'archived')];

/** Replaced where it is (unless the page holds a newer copy), or added at the end; archived teams stay last. */
export function upsertTeam(list: Team[], team: Team): Team[] {
  const at = list.findIndex((t) => t.id === team.id);
  if (at >= 0 && !isNewer(list[at], team)) return list;
  return archivedLast(at < 0 ? [...list, team] : list.map((t, i) => (i === at ? team : t)));
}

/** The list as the server read it, in its order, keeping any team the page already holds a newer copy of. */
export function mergeTeams(held: Team[] | null, fetched: Team[]): Team[] {
  const now = new Map((held ?? []).map((t) => [t.id, t]));
  return archivedLast(fetched.map((t) => (isNewer(now.get(t.id), t) ? t : now.get(t.id)!)));
}

/** An item put in, unless the page holds a newer copy. */
export function putItem(items: Record<string, TeamItem>, item: TeamItem): Record<string, TeamItem> {
  return isNewer(items[item.id], item) ? { ...items, [item.id]: item } : items;
}

/** Ids newest first, by each thread's last message. */
export function sortThreadIds(ids: string[], threads: Record<string, TeamThread>): string[] {
  return [...new Set(ids)].filter((id) => threads[id]).sort((a, b) => threads[b]!.lastSeq - threads[a]!.lastSeq || a.localeCompare(b));
}

/** Messages by seq, each once: a later copy of one (its delivery moved on) replaces the earlier. */
export function mergeMessages(current: readonly TeamMessage[], incoming: readonly TeamMessage[]): TeamMessage[] {
  const byId = new Map<string, TeamMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** A page of threads from the server put into the lists (`append`: an older page after the ones shown). */
export function putThreads(s: Pick<TeamsSlice, 'teamThreads' | 'threadLists'>, scope: string, page: TeamThread[], more: boolean, append: boolean): Pick<TeamsSlice, 'teamThreads' | 'threadLists'> {
  const teamThreads = { ...s.teamThreads };
  for (const t of page) teamThreads[t.id] = t;
  const before = append ? (s.threadLists[scope]?.ids ?? []) : [];
  return { teamThreads, threadLists: { ...s.threadLists, [scope]: { ids: sortThreadIds([...before, ...page.map((t) => t.id)], teamThreads), hasMore: more } } };
}

/** What one live event changes, or null when it changes nothing the page holds. Unknown events are ignored. */
export function teamsEvent(s: TeamsSlice, ev: ServerEvent): Partial<TeamsSlice> | null {
  switch (ev.type) {
    case 'team.upserted': {
      if (!s.teams) return null;
      const teams = upsertTeam(s.teams, ev.team);
      return teams === s.teams ? null : { teams };
    }
    case 'team.deleted': {
      const id = ev.teamId;
      const gone = new Set(Object.values(s.teamThreads).filter((t) => t.teamId === id).map((t) => t.id));
      const drop = <T>(map: Record<string, T>, keep: (k: string, v: T) => boolean) => Object.fromEntries(Object.entries(map).filter(([k, v]) => keep(k, v)));
      return {
        teams: s.teams?.filter((t) => t.id !== id) ?? null,
        teamItems: drop(s.teamItems, (_, i) => i.teamId !== id),
        teamBoards: drop(s.teamBoards, (k) => k !== id),
        teamThreads: drop(s.teamThreads, (k) => !gone.has(k)),
        threadMessages: drop(s.threadMessages, (k) => !gone.has(k)),
        threadLists: Object.fromEntries(Object.entries(s.threadLists).filter(([k]) => k !== id).map(([k, l]) => [k, { ...l, ids: l.ids.filter((x) => !gone.has(x)) }])),
      };
    }
    case 'team.item.upserted': {
      const i = ev.item;
      if (!s.teamBoards[i.teamId] && !s.teamItems[i.id]) return null;
      const teamItems = putItem(s.teamItems, i);
      return teamItems === s.teamItems ? null : { teamItems };
    }
    case 'team.thread.upserted': {
      const t = ev.thread;
      const scopes = ['all', threadScope(t)].filter((k) => s.threadLists[k]);
      if (!scopes.length && !s.teamThreads[t.id]) return null;
      const teamThreads = { ...s.teamThreads, [t.id]: t };
      const threadLists = { ...s.threadLists };
      for (const k of scopes) threadLists[k] = { ...threadLists[k]!, ids: sortThreadIds([t.id, ...threadLists[k]!.ids], teamThreads) };
      return { teamThreads, threadLists };
    }
    case 'team.message.created': {
      const m = ev.message;
      const page = s.threadMessages[m.threadId];
      if (!page) return null;
      return { threadMessages: { ...s.threadMessages, [m.threadId]: { ...page, items: mergeMessages(page.items, [m]) } } };
    }
    case 'teams.attention':
      return { teamsAttention: ev.attention };
    default:
      return null;
  }
}

/** The items of one team, from what the page holds. */
export const itemsOf = (items: Record<string, TeamItem>, teamId: string) => Object.values(items).filter((i) => i.teamId === teamId);

/** A board just read from the server: the team's items as it has them (one gone from it is gone here too), each kept where the page holds a newer copy. */
export function putBoard(items: Record<string, TeamItem>, teamId: string, board: TeamItem[]): Record<string, TeamItem> {
  const next = Object.fromEntries(Object.entries(items).filter(([, i]) => i.teamId !== teamId));
  for (const i of board) next[i.id] = isNewer(items[i.id], i) ? i : items[i.id]!;
  return next;
}

// ------------------------------------------------------------------ the sidebar's badge and the title

/** A number when something needs the owner, else a dot for unread conversations only, else nothing. */
export type TeamsBadge = { kind: 'count'; count: number; label: string } | { kind: 'dot'; label: string } | null;

export function teamsBadge(a: TeamsAttention | null): TeamsBadge {
  if (!a) return null;
  if (a.count > 0) return { kind: 'count', count: a.count, label: a.count === 1 ? '1 thing needs you' : `${a.count} things need you` };
  if (a.unreadThreads > 0) return { kind: 'dot', label: a.unreadThreads === 1 ? '1 unread conversation' : `${a.unreadThreads} unread conversations` };
  return null;
}

/** The document title's count: unread chat messages and what needs the owner in Teams, never unread conversations. */
export const titleCount = (unread: number, a: TeamsAttention | null) => unread + (a?.count ?? 0);

// ------------------------------------------------------------------ the roster an edit sends

/** The lead first, then the others in their order. */
export function rosterOrder(members: TeamSeat[]): TeamSeat[] {
  return [...members.filter((m) => m.role === 'lead'), ...members.filter((m) => m.role !== 'lead')];
}

export interface SeatDraft {
  botId: string;
  roleTitle: string;
  responsibilities: string;
}

export interface TeamDraft {
  name: string;
  goal: string;
  /** In the order chosen. */
  seats: SeatDraft[];
  leadBotId: string | null;
}

/**
 * A draft moved onto a newer copy of the team after a save was refused as stale (three ways: what the editor started
 * from, the owner's draft, the team now). What the owner changed keeps the owner's value; everything they didn't touch
 * takes the team's value now, so saving again never puts back what another device changed. Seats the same way: the
 * owner's adds, removals and edited seats; every other seat as it is now; the lead the owner picked, else the current.
 */
export function rebaseDraft(origin: TeamDraft, draft: TeamDraft, latest: TeamDraft): TeamDraft {
  const pick = <T>(o: T, d: T, l: T) => (d !== o ? d : l);
  const seatOf = (d: TeamDraft, id: string) => d.seats.find((s) => s.botId === id);
  const removed = new Set(origin.seats.filter((s) => !seatOf(draft, s.botId)).map((s) => s.botId));
  const seats: SeatDraft[] = latest.seats
    .filter((s) => !removed.has(s.botId))
    .map((l) => {
      const d = seatOf(draft, l.botId);
      if (!d) return l;
      // A seat both sides added has no origin: compared with an empty one, so the owner's blank fields don't clear the other device's.
      const o = seatOf(origin, l.botId) ?? { botId: l.botId, roleTitle: '', responsibilities: '' };
      return { botId: l.botId, roleTitle: pick(o.roleTitle, d.roleTitle, l.roleTitle), responsibilities: pick(o.responsibilities, d.responsibilities, l.responsibilities) };
    });
  for (const d of draft.seats) if (!seatOf(origin, d.botId) && !seats.some((s) => s.botId === d.botId)) seats.push(d);
  const has = (id: string | null) => !!id && seats.some((s) => s.botId === id);
  // The lead the owner picked; else the current one; else the one the owner kept; only then the first seat.
  const lead =
    draft.leadBotId !== origin.leadBotId && has(draft.leadBotId) ? draft.leadBotId : has(latest.leadBotId) ? latest.leadBotId : has(draft.leadBotId) ? draft.leadBotId : (seats[0]?.botId ?? null);
  return { name: pick(origin.name, draft.name, latest.name), goal: pick(origin.goal, draft.goal, latest.goal), seats, leadBotId: lead };
}

/**
 * The seats whose role or responsibilities the owner edited but which another device removed meanwhile: the removal
 * stands (rebaseDraft drops them), so the owner is told their edits there could not apply. Bot ids, in draft order.
 */
export function droppedSeatEdits(origin: TeamDraft, draft: TeamDraft, latest: TeamDraft): string[] {
  const gone = (id: string) => !latest.seats.some((s) => s.botId === id);
  const out = draft.seats
    .filter((d) => {
      const o = origin.seats.find((s) => s.botId === d.botId);
      return !!o && (o.roleTitle !== d.roleTitle || o.responsibilities !== d.responsibilities) && gone(d.botId);
    })
    .map((d) => d.botId);
  // The lead the owner picked, taken off the team elsewhere: that choice couldn't apply either.
  const lead = draft.leadBotId;
  if (lead && lead !== origin.leadBotId && origin.seats.some((s) => s.botId === lead) && gone(lead) && !out.includes(lead)) out.push(lead);
  return out;
}

/** The roster as the server takes it: exactly one lead, titles and responsibilities trimmed. */
export function rosterInput(d: TeamDraft): TeamMemberInput[] {
  return d.seats.map((s) => ({ botId: s.botId, role: s.botId === d.leadBotId ? 'lead' : 'member', roleTitle: s.roleTitle.trim(), responsibilities: s.responsibilities.trim() }));
}

/** Whether the roster in a draft differs from the team's. */
export function rosterChanged(team: Pick<Team, 'members'>, d: TeamDraft): boolean {
  const now = rosterInput(d);
  const was = rosterOrder(team.members).map((m) => ({ botId: m.botId, role: m.role, roleTitle: m.roleTitle, responsibilities: m.responsibilities }));
  if (now.length !== was.length) return true;
  const key = (m: TeamMemberInput) => JSON.stringify([m.botId, m.role, m.roleTitle ?? '', m.responsibilities ?? '']);
  const a = new Set(was.map(key));
  return now.some((m) => !a.has(key(m)));
}
