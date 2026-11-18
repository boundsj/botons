// The words and checks of the Teams screens, as pure code: team states, board groups, thread rows, deliveries,
// history, what needs the owner, the owner's item actions, and the editor's and limits' checks. The item and delivery
// words themselves come from shared/teams.ts, which the native app and the CLI read too. Loaded with the screens.

import type { Team, TeamEvent, TeamEventKind, TeamItem, TeamItemStatus, TeamLimits, TeamMessage, TeamSeat, TeamThread } from '../../shared/types.ts';
import { boardGroup, deliveryLine, itemNeedsOwner, itemStatusLine, PAUSED_WORDS, TEAM_LIMIT_BOUNDS, TEAM_LIMITS, TEAM_TEXT } from '../../shared/teams.ts';
import { itemsOf, rosterOrder, type TeamDraft } from './teams.ts';

export function teamStateText(t: Pick<Team, 'state' | 'pausedReason' | 'reviewedAt'>): string {
  switch (t.state) {
    case 'active':
      return 'Active';
    case 'paused':
      return PAUSED_WORDS[t.pausedReason ?? 'owner'];
    case 'done':
      return t.reviewedAt ? 'Finished' : 'Finished, review it';
    case 'archived':
      return 'Archived';
  }
}

/** For the state chip's look: words carry the meaning, this only tints it. */
export function teamStateTone(t: Pick<Team, 'state' | 'pausedReason' | 'reviewedAt'>): 'ok' | 'warn' | 'muted' {
  if (t.state === 'active') return 'ok';
  if (t.state === 'paused') return t.pausedReason === 'owner' ? 'muted' : 'warn';
  if (t.state === 'done') return t.reviewedAt ? 'muted' : 'warn';
  return 'muted';
}

const COUNT_ORDER: TeamItemStatus[] = ['working', 'blocked', 'open', 'done', 'cancelled'];

/** "2 working · 1 blocked · 3 done". */
export function countsLine(counts: Record<TeamItemStatus, number>): string {
  const parts = COUNT_ORDER.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(' · ') : 'No work yet';
}

/** The goal's first line, for a card. */
export function firstLine(text: string, max = 140): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A seat's live state in words. */
export function seatStateText(s: Pick<TeamSeat, 'state' | 'paused'>): string {
  if (s.paused) return 'paused';
  return s.state === 'working' ? 'working' : s.state === 'queued' ? 'up next' : 'idle';
}

export type BoardGroupKey = ReturnType<typeof boardGroup>;
export interface BoardGroup {
  key: BoardGroupKey;
  label: string;
  items: TeamItem[];
}

const GROUP_LABELS: Record<BoardGroupKey, string> = { needs_you: 'Needs you', blocked: 'Blocked', working: 'Working', open: 'Open', done: 'Done' };
const GROUP_ORDER: BoardGroupKey[] = ['needs_you', 'blocked', 'working', 'open', 'done'];

/** The board in its groups, empty ones left out: live work in the order it was added, finished work newest first. */
export function boardGroups(items: readonly TeamItem[]): BoardGroup[] {
  const by = new Map<BoardGroupKey, TeamItem[]>();
  for (const i of items) {
    const k = boardGroup(i);
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  return GROUP_ORDER.filter((k) => by.get(k)?.length).map((k) => {
    const list = by.get(k)!;
    const sorted =
      k === 'done'
        ? [...list].sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt))
        : [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const label = k === 'done' && list.some((i) => i.status === 'cancelled') ? (list.every((i) => i.status === 'cancelled') ? 'Cancelled' : 'Done or cancelled') : GROUP_LABELS[k];
    return { key: k, label, items: sorted };
  });
}

/** What the "Needs you" list shows: items and teams that wait for the owner, each with why in words. */
export type NeedsYou = { kind: 'item'; key: string; team: Team; item: TeamItem; why: string } | { kind: 'team'; key: string; team: Team; why: string };

export function needsYou(teams: readonly Team[], items: Record<string, TeamItem>, now: number): NeedsYou[] {
  const out: NeedsYou[] = [];
  for (const team of teams) {
    if (team.state === 'archived') continue;
    if (team.state === 'paused' && (team.pausedReason === 'budget' || team.pausedReason === 'no_lead')) out.push({ kind: 'team', key: `team:${team.id}`, team, why: PAUSED_WORDS[team.pausedReason] });
    if (team.state === 'done' && !team.reviewedAt) out.push({ kind: 'team', key: `team:${team.id}`, team, why: 'Finished, review it' });
    const waiting = itemsOf(items, team.id).filter((i) => itemNeedsOwner(i) && i.status !== 'done' && i.status !== 'cancelled');
    for (const item of waiting.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      out.push({ kind: 'item', key: `item:${item.id}`, team, item, why: itemStatusLine(item, now, team.lead?.name) });
    }
  }
  return out;
}

/** The thread row's people: "Kevin → Stuart", with "+1" for each more. */
export function threadPeople(t: Pick<TeamThread, 'participants' | 'last'>): string {
  const [a, b, ...rest] = t.participants;
  if (!a) return t.last ? `${t.last.fromName} → ${t.last.toName}` : '';
  if (!b) return a.name;
  return `${a.name} → ${b.name}${rest.length ? ` +${rest.length}` : ''}`;
}

/** A thread row's last line: "Stuart: Mapped 14 of 20 tables…". */
export function lastLine(t: Pick<TeamThread, 'last'>, max = 120): string {
  if (!t.last) return '';
  const text = t.last.text.replace(/\s+/g, ' ').trim();
  const clipped = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return t.last.fromName ? `${t.last.fromName}: ${clipped}` : clipped;
}

/** A message's kind, as a short label beside its sender. */
export const MESSAGE_KIND_WORDS: Record<TeamMessage['kind'], string> = { request: 'asked', reply: 'replied', system: 'Botons' };

/** Under a request: where its delivery stands ("Queued", "Answered in 2m", "Could not answer"…). */
export function messageDelivery(m: Pick<TeamMessage, 'kind' | 'delivery' | 'createdAt' | 'to'>): string | null {
  if (m.kind !== 'request' || !m.delivery) return null;
  return deliveryLine({ ...m.delivery, queuedAt: m.delivery.queuedAt ?? m.createdAt }, m.to.name || 'the Boton');
}

/** A delivery line that says nothing out of the ordinary. */
const plainDelivery = (line: string) => line === 'Delivered' || line === 'Handled' || line.startsWith('Answered');

/**
 * The delivery state a thread row shows when it is not plain ("Waiting: Stuart is paused", "Could not answer"): the
 * newest request's: from its messages when they are loaded (they are the freshest), else the row's own lastDelivery.
 */
export function threadDeliveryNote(messages: readonly TeamMessage[] | undefined, thread?: Pick<TeamThread, 'lastDelivery' | 'participants'>): string | null {
  const last = messages && [...messages].reverse().find((m) => m.kind === 'request' && m.delivery);
  if (last) {
    const line = messageDelivery(last);
    return line && !plainDelivery(line) ? line : null;
  }
  const d = thread?.lastDelivery;
  if (!d) return null;
  const line = deliveryLine(d, thread.participants.find((p) => p.botId === d.botId)?.name || 'the Boton');
  return plainDelivery(line) ? null : line;
}

/** A search snippet in parts, the matches of `q` (any case) marked, for <mark>. */
export function matchParts(text: string, q: string): { text: string; match: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  const hay = text.toLowerCase();
  let at = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    if (i > at) out.push({ text: text.slice(at, i), match: false });
    out.push({ text: text.slice(i, i + needle.length), match: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

/** The seq to mark a thread read up to: its newest message loaded. */
export const readUpTo = (messages: readonly TeamMessage[]) => messages.reduce((n, m) => Math.max(n, m.seq), 0);

const EVENT_WORDS: Record<TeamEventKind, string> = {
  created: 'added it',
  assigned: 'assigned it',
  started: 'started it',
  progress: 'noted progress',
  blocked: 'marked it blocked',
  done: 'marked it done',
  reopened: 'reopened it',
  cancelled: 'cancelled it',
  retry: 'asked for another try',
  stalled: 'saw no progress',
  not_started: 'saw it was not started',
  overdue: 'saw it was overdue',
  turn_failed: 'recorded a failed turn',
  silent_end: 'saw a turn end without done or blocked',
  stopped: 'stopped it',
  unavailable: 'saw the assignee was unavailable',
  expired: 'saw a request expire unread',
  checkin: 'checked in with the lead',
  escalated: 'escalated it to you',
  owner_answered: 'answered the escalation',
  held: 'held it for you',
  team_created: 'made the team',
  team_updated: 'changed the team',
  team_paused: 'paused the team',
  team_resumed: 'resumed the team',
  team_done: 'finished the team',
  team_reviewed: 'reviewed the finished team',
  member_added: 'added a member',
  member_changed: 'changed a seat',
  member_removed: 'removed a member',
};

/** One history line: "You cancelled it", "Botons saw no progress", "Kevin escalated it to you". */
export function eventText(e: Pick<TeamEvent, 'kind' | 'actor'>): string {
  const who = e.actor.kind === 'owner' ? 'You' : e.actor.kind === 'server' ? 'Botons' : e.actor.name || 'A Boton';
  return `${who} ${EVENT_WORDS[e.kind] ?? e.kind.replace(/_/g, ' ')}`;
}

/** An evidence fact's kind in words, for the escalation's list. */
export function evidenceText(kind: TeamEventKind): string {
  return (
    { blocked: 'Blocked', turn_failed: 'A turn failed', silent_end: 'A turn ended without done or blocked', stalled: 'No progress', not_started: 'Not started', overdue: 'Overdue', unavailable: 'Assignee unavailable', expired: 'Request expired unread', checkin: 'Lead checked in', stopped: 'Stopped' } as Partial<Record<TeamEventKind, string>>
  )[kind] ?? EVENT_WORDS[kind] ?? kind;
}

/** Announcements for the polite live region: a team that changed state since the page last saw it. */
export function stateChanges(before: readonly Pick<Team, 'id' | 'name' | 'state' | 'pausedReason' | 'reviewedAt'>[] | null, after: readonly Team[] | null): string[] {
  if (!before || !after) return [];
  const was = new Map(before.map((t) => [t.id, teamStateText(t)]));
  return after.filter((t) => was.has(t.id) && was.get(t.id) !== teamStateText(t)).map((t) => `${t.name}: ${teamStateText(t)}.`);
}

// ------------------------------------------------------------------ the owner's item actions

/** Why an item has no actions: its team is finished or archived. */
export function ownerActionsNote(teamState?: Team['state']): string | null {
  if (teamState === 'done') return 'The team is finished: reopen it (Team tab) to work on its items again.';
  if (teamState === 'archived') return 'The team is archived: restore it (Team tab) to work on its items again.';
  return null;
}

export type OwnerItemAction = 'assign' | 'retry' | 'done' | 'cancel' | 'reopen';

/**
 * What the owner may do to an item now (the owner may do any action the state allows, but not the assignee's own).
 * Nothing on a finished or archived team: reopen or restore the team first (ownerActionsNote says so).
 */
export function ownerActions(item: Pick<TeamItem, 'status' | 'assigneeBotId'>, teamState?: Team['state']): OwnerItemAction[] {
  if (teamState === 'done' || teamState === 'archived') return [];
  const out: OwnerItemAction[] = [];
  if (item.status === 'open' || item.status === 'working' || item.status === 'blocked') out.push('assign');
  if (item.status === 'blocked') out.push('retry');
  if (item.status === 'open' || item.status === 'working') out.push('done');
  if (item.status !== 'cancelled') out.push('cancel');
  if (item.status === 'done' || item.status === 'cancelled') out.push('reopen');
  return out;
}

export const OWNER_ACTION_WORDS: Record<OwnerItemAction, string> = { assign: 'Reassign', retry: 'Try again', done: 'Mark done', cancel: 'Cancel', reopen: 'Reopen' };

/** A one-use key for an owner action, so a repeated request applies once. */
export const actionKey = () => `web:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

// ------------------------------------------------------------------ the team editor

export function draftOf(team: Pick<Team, 'name' | 'goal' | 'members'> | null): TeamDraft {
  if (!team) return { name: '', goal: '', seats: [], leadBotId: null };
  return {
    name: team.name,
    goal: team.goal,
    seats: rosterOrder(team.members).map((m) => ({ botId: m.botId, roleTitle: m.roleTitle, responsibilities: m.responsibilities })),
    leadBotId: team.members.find((m) => m.role === 'lead')?.botId ?? null,
  };
}

/** What is wrong with a draft, before it is sent (the server checks the same and more), or null. */
export function draftProblem(d: TeamDraft): string | null {
  const name = d.name.trim();
  if (!name) return 'Give the team a name.';
  if (name.length > TEAM_TEXT.name) return `A team's name is at most ${TEAM_TEXT.name} characters.`;
  if (d.goal.length > TEAM_TEXT.goal) return `The goal is at most ${TEAM_TEXT.goal} characters.`;
  if (!d.seats.length) return 'Choose the Botons on the team.';
  if (d.seats.length > TEAM_LIMITS.membersPerTeam) return `A team has at most ${TEAM_LIMITS.membersPerTeam} Botons.`;
  if (!d.leadBotId || !d.seats.some((s) => s.botId === d.leadBotId)) return 'Choose one of them to lead the team.';
  for (const s of d.seats) {
    if (s.roleTitle.length > TEAM_TEXT.roleTitle) return `A role title is at most ${TEAM_TEXT.roleTitle} characters.`;
    if (s.responsibilities.length > TEAM_TEXT.responsibilities) return `Responsibilities are at most ${TEAM_TEXT.responsibilities} characters.`;
  }
  return null;
}

// ------------------------------------------------------------------ limits, as the owner sets them

/** The form's fields: times in minutes, counts as they are. */
export type LimitDraft = Record<keyof TeamLimits, string>;

const MINUTE_LIMITS = new Set<keyof TeamLimits>(['stallAfterMs', 'startWithinMs']);
export const LIMIT_FIELDS: { key: keyof TeamLimits; label: string; unit: string; help: string }[] = [
  { key: 'stallAfterMs', label: 'Stalled after', unit: 'minutes', help: 'Working with no word for this long gets the lead a check-in.' },
  { key: 'startWithinMs', label: 'Start within', unit: 'minutes', help: 'Assigned and not started for this long gets the lead a check-in.' },
  { key: 'maxAttempts', label: 'Attempts per item', unit: 'attempts', help: 'Assignments and retries before the lead must escalate or cancel it.' },
  { key: 'messagesPerDay', label: 'Messages a day', unit: 'messages', help: 'Past this the team pauses until you resume it.' },
  { key: 'checkinsPerDay', label: 'Lead check-ins a day', unit: 'check-ins', help: 'Past this the team pauses until you resume it.' },
];

/** The bounds of a field in its own unit. */
export function limitBoundsOf(key: keyof TeamLimits): [number, number] {
  const [min, max] = TEAM_LIMIT_BOUNDS[key];
  return MINUTE_LIMITS.has(key) ? [min / 60_000, max / 60_000] : [min, max];
}

export function limitDraft(l: TeamLimits): LimitDraft {
  const out = {} as LimitDraft;
  for (const { key } of LIMIT_FIELDS) out[key] = String(MINUTE_LIMITS.has(key) ? Math.round(l[key] / 60_000) : l[key]);
  return out;
}

/** The changed limits, or what is wrong with a field. Only whole numbers within TEAM_LIMIT_BOUNDS are sent. */
export function limitsPatch(d: LimitDraft, current: TeamLimits): { patch: Partial<TeamLimits> } | { error: string; key: keyof TeamLimits } {
  const patch: Partial<TeamLimits> = {};
  for (const { key, label, unit } of LIMIT_FIELDS) {
    const raw = d[key].trim();
    const n = Number(raw);
    const [min, max] = limitBoundsOf(key);
    if (!/^\d+$/.test(raw) || n < min || n > max) return { error: `${label}: a whole number of ${unit} from ${min} to ${max}.`, key };
    const value = MINUTE_LIMITS.has(key) ? n * 60_000 : n;
    if (value !== current[key]) patch[key] = value;
  }
  return { patch };
}

