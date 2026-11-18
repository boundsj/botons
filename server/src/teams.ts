import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AskResult,
  BotTeamsView,
  TeamItemAction,
  TeamItemActionResult,
  TeamItemDetail,
  AuditAction,
  BotStatus,
  BotTeamRef,
  Message,
  MessageMeta,
  Team,
  TeamCompletion,
  TeamDeliveryOutcome,
  TeamDelivery,
  TeamDeliveryWaiting,
  TeamDetail,
  TeamEscalation,
  TeamEvent,
  TeamEventKind,
  TeamEvidence,
  TeamItem,
  TeamItemStatus,
  TeamItemWaiting,
  TeamLimits,
  TeamMemberInput,
  TeamMessage,
  TeamPausedReason,
  TeamRefusalCode,
  TeamRole,
  TeamSearchHit,
  TeamThreadDetail,
  TeamsAttention,
  TeamThread,
} from '../../shared/types.ts';
import {
  afterCheckinMs,
  assess,
  type AssessFacts,
  assessTeam,
  actorFor,
  ITEM_ACTIONS,
  ITEM_TRANSITIONS,
  completionRefusal,
  EVIDENCE_KINDS,
  itemNeedsOwner,
  leadEscalationRefusal,
  limitsRefusal,
  scopeRefusal,
  type TeamActor,
  type TeamRefusal,
  TEAM_CONTEXT,
  TEAM_LIFETIME,
  TEAM_LIMITS,
  TEAM_TEXT,
  teamLimits,
  transitionRefusal,
  type TurnScope,
} from '../../shared/teams.ts';
import type { Audit } from './audit.ts';
import type { Principal } from './auth.ts';
import { log } from './log.ts';
import type { PushRequest } from './notify.ts';
import { ASK_HOP_LIMIT, botonMessage, newNonce } from './prompt.ts';
import { sidebarGroupKey } from './schema.ts';
import { type BotRecord, HttpError, type Store } from './store.ts';
import { newId, parseJson, type Row } from './util.ts';

/*
 * Teams and every message between Botons (shared/teams.ts holds the rules). One transport: `botons ask`, item
 * assignments and the supervisor's check-ins all go through here, and no other code writes `ask` or `ask.reply`
 * messages.
 *
 * A request is a team_messages row with a team_deliveries row (the outbox). dispatch() moves a recipient's queued
 * requests into its chat as ordinary pending `ask` messages, at most dispatchedPerRecipient at once, in seq order, so
 * the engine's own guarantees (in flight, re-run after a restart, give up after cut-offs, pause, usage limit) carry
 * the last hop. replied() answers them inside the transaction that ends the turn, on every path, so an asker is never
 * left waiting by a crash between the two. Asks from before Teams (no teamMessageId) are answered as they always were.
 *
 * Every hourly count is a SQL count over team_messages, so a restart resets none of them.
 */

const HOUR = 3_600_000;
const CHIP_EVERY_MS = HOUR;

/** What Teams needs of the running turn of the Boton that calls it, from the engine (never from what the Boton says). */
export interface TeamTurn {
  /** The Boton as the turn read it. */
  bot: BotRecord;
  turnId: string | null;
  /** What stays the same when this work is re-run after a restart: `chat:<oldest message it answers>` or `run:<runId>`. */
  origin: string | null;
  /** The thread and hop of the ask it answers, if any. */
  chain: { threadId: string; hop: number } | null;
  /** The item gens it may act on (Teams.turnScope), taken when it started; null: none (a sandboxed turn). */
  scope: TurnScope | null;
}

/** Who takes an item action: the owner (a paired device), or a Boton by its turn token. */
export type TeamActorRef = { owner: true; by: Principal | null } | { owner: false; botId: string };

/** The engine and notifier, as Teams uses them; the app wires them. */
export interface TeamsHost {
  /** Queue a chat turn for this Boton (not while it is paused). */
  wake(botId: string): void;
  turn(botId: string): TeamTurn | null;
  /** A chip in the Boton's chat, marked as its running turn's activity. */
  chip(botId: string, text: string, meta: MessageMeta): Message;
  statusOf(botId: string): BotStatus;
  /** When the provider's usage limit resets, while one holds it. */
  usageLimitUntil(provider: string): string | null;
  /** A push to the owner's devices (never throws, never waits). */
  push(req: PushRequest): void;
  /** The owner's Stop work: stop the running turns that carry this team's work. */
  stopTeamTurns(teamId: string): void;
  /** A card the server writes in a Boton's chat (cards.ts), in the caller's transaction. */
  postCard(botId: string, card: unknown, ttlMs: number, about?: Pick<MessageMeta, 'teamId' | 'teamName' | 'itemId' | 'itemTitle'>): Message;
}

/** Team actions in the audit log: ids and names only, never what anyone wrote. */
type TeamAuditAction = Extract<AuditAction, `team.${string}`>;

export type ReplyOutcome = 'replied' | 'quiet' | 'failed' | 'stopped' | 'dropped';

type Actor = TeamEvent['actor'];
const SERVER: Actor = { kind: 'server', botId: null, name: 'Botons' };

/** What an assignment's answer did to its item: nothing (it answered a replaced one), or it ended with no outcome. */
interface ItemEffect {
  stale: boolean;
  silent: boolean;
}

export interface TeamsOptions {
  store: Store;
  audit?: Audit | null;
  asksPerPairPerHour: number;
  asksPerHour: number;
  /** Tests move it on. Everything Teams writes is stamped with it. */
  clock?: () => number;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** A refusal with its code, in the body beside the error (409 unless said otherwise). */
export function refused(r: TeamRefusal, status = 409): HttpError {
  return new HttpError(status, r.message, undefined, r.code);
}
const refusal = (code: TeamRefusalCode, message: string, status = 409) => refused({ code, message }, status);

/** A one-line name or title: required, whitespace folded, at most `max`. */
function title(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} is required`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) throw new HttpError(400, `${field} is required`);
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}

/** Free text (may span lines): trimmed, "" when absent, at most `max`. */
function prose(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}

const STATUSES: TeamItemStatus[] = ['open', 'working', 'blocked', 'done', 'cancelled'];

/** A LIKE pattern that matches `text` literally anywhere (its % and _ escaped, with \\). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** At most 160 characters of `text` around the first match of `term` (case-insensitive), on one line. */
export function snippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0 || flat.length <= 160) return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
  const start = Math.max(0, at - 60);
  const end = Math.min(flat.length, start + 160);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The owner's or a Boton's words in the context block: one line, no angle brackets (they can't open or close a block), clipped. */
export function contextWords(text: string, max: number): string {
  const t = text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A team.update chip's words: "Started Schema review". */
const ACTION_WORDS: Record<TeamItemAction, string> = {
  assign: 'Assigned',
  start: 'Started',
  progress: 'Updated',
  block: 'Blocked',
  done: 'Finished',
  retry: 'Retried',
  cancel: 'Cancelled',
  reopen: 'Reopened',
};
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function retryAfter(ms: number): { s: number; wait: string } {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return { s, wait: s < 120 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes` };
}

/** The first line of `text`, one line, at most `max` characters. */
export function firstLine(text: string, max: number = TEAM_TEXT.subject): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line || '(no subject)';
}

/** An optional string field of a request body, trimmed; absent and "" are undefined. */
function optional(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}

export class Teams {
  /** Check-ins whose text was built in this process: their end marks only what that text told (#checkinEnded). */
  #built = new Set<string>();
  #store: Store;
  #db: DatabaseSync;
  #perPair: number;
  #perHour: number;
  #clock: () => number;
  #chipAt = new Map<string, number>();
  #audit: Audit | null;
  host!: TeamsHost;

  constructor(opts: TeamsOptions) {
    this.#store = opts.store;
    this.#audit = opts.audit ?? null;
    this.#db = opts.store.db;
    this.#perPair = opts.asksPerPairPerHour;
    this.#perHour = opts.asksPerHour;
    this.#clock = opts.clock ?? Date.now;
  }

  now(): number {
    return this.#clock();
  }

  #iso(ms = this.#clock()): string {
    return new Date(ms).toISOString();
  }

  #all(sql: string, ...params: any[]): Row[] {
    return this.#db.prepare(sql).all(...params) as Row[];
  }
  #get(sql: string, ...params: any[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }
  #run(sql: string, ...params: any[]) {
    return this.#db.prepare(sql).run(...params);
  }

  #chipDue(key: string): boolean {
    const now = this.#clock();
    if (now - (this.#chipAt.get(key) ?? -Infinity) < CHIP_EVERY_MS) return false;
    this.#chipAt.set(key, now);
    return true;
  }

  // ------------------------------------------------------------------ sending

  /**
   * `botons ask` (POST /api/bots/:id/asks): the sender is the token's Boton. Nothing waits for the answer (it comes
   * back as a message, see replied), so two Botons asking each other can't deadlock.
   */
  send(fromId: string, toId: string, input: unknown): AskResult {
    // A bare string is the text alone (the engine's own callers); the route passes the request's body.
    const body = (typeof input === 'string' ? { text: input } : input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const text = body.text;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    const t = text.trim();
    if (t.length > TEAM_TEXT.message) throw new HttpError(400, `text is too long (max ${TEAM_TEXT.message} characters)`);
    const from = this.#store.getBot(fromId);
    if (toId === fromId) throw new HttpError(400, "You can't ask yourself. Do the work in this turn instead.");
    if (!this.#store.hasBot(toId)) throw new HttpError(404, `No Boton with id ${toId}. Run \`botons team\` to see who is on the team.`);
    const to = this.#store.getBot(toId);
    const explicitThread = optional(body, 'thread', 64);
    const key = optional(body, 'key', TEAM_TEXT.key);
    const turn = this.host.turn(fromId);

    // The same send from the same work (a re-run after a restart included) is found before anything is resolved:
    // an implicit thread would be new on a re-run, so it is never part of the key.
    const idem = turn?.origin ? `send:${turn.origin}:${to.id}:${explicitThread ?? ''}:${key ?? sha(t)}` : null;
    if (idem) {
      const prev = this.#get('select * from team_messages where idem_key = ?', idem);
      if (prev) return this.#askResult(prev, true);
    }

    const owner = this.#store.getSettings();
    const hop = (turn?.chain?.hop ?? 0) + 1;
    let thread: Row | null = null;
    if (explicitThread) {
      thread = this.#thread(explicitThread) ?? null;
      if (!thread) throw new HttpError(404, `No thread ${explicitThread}`);
      if (!this.#mayRead(thread, from.id)) throw new HttpError(403, `You are not in thread ${explicitThread}`);
      if (thread.closed_at) throw new HttpError(409, `Thread ${explicitThread} is closed: leave out --thread to start a new one.`);
      if (thread.message_count >= TEAM_LIMITS.messagesPerThread) {
        throw new HttpError(409, `Thread ${explicitThread} has ${TEAM_LIMITS.messagesPerThread} messages, the limit: start a new thread (leave out --thread).`);
      }
    }

    // A team's message: both hold a seat in it now, and it is active. An item's: the sender leads it or holds it.
    const itemRef = optional(body, 'item', 64);
    const item = itemRef ? this.#get('select * from team_items where id = ?', itemRef) : undefined;
    if (itemRef && !item) throw new HttpError(404, `No item ${itemRef}`);
    const teamRef = optional(body, 'team', 80);
    let team: Row | undefined = teamRef ? this.teamByRef(teamRef) : item ? this.#get('select * from teams where id = ?', item.team_id) : thread?.team_id ? this.#get('select * from teams where id = ?', thread.team_id) : undefined;
    if (teamRef && !team) throw new HttpError(404, `No team ${teamRef}. Run \`botons team\` to see your teams.`);
    if (team) {
      if (team.state === 'archived') throw new HttpError(404, `No team ${teamRef ?? team.id}. Run \`botons team\` to see your teams.`);
      if (!this.#seat(team.id, from.id)) throw new HttpError(403, `You hold no seat in team ${team.name}.`);
      if (!this.#seat(team.id, to.id)) throw new HttpError(403, `${to.name} holds no seat in team ${team.name}: ask it outside the team (leave out --team), or ask ${owner.ownerName} to add it.`);
      if (team.state !== 'active') throw refusal('team_not_active', `Team ${team.name} is ${team.state}: nothing is sent in it until ${owner.ownerName} resumes it.`);
      if (item && item.team_id !== team.id) throw new HttpError(400, `${item.id} is not an item of team ${team.name}`);
      if (item && item.assignee_bot_id !== from.id && this.#leadOf(team.id)?.bot_id !== from.id) throw new HttpError(403, `Only ${item.id}'s lead or its assignee asks about it.`);
      if (thread && thread.team_id !== team.id) throw new HttpError(409, `Thread ${thread.id} is not team ${team.name}'s: leave out --thread.`);
    } else if (!owner.asksOutsideTeams) {
      throw new HttpError(403, `${owner.ownerName} turned off asks outside a team. Ask with --team, in a team you and ${to.name} both hold a seat in.`);
    }
    team = team ?? undefined;
    let threadId: string;
    const chain = turn?.chain ? this.#thread(turn.chain.threadId) : undefined;
    const fits = (t: Row | undefined) => !!t && (t.team_id ?? null) === (team?.id ?? null) && !t.closed_at && t.message_count < TEAM_LIMITS.messagesPerThread;
    if (thread) threadId = thread.id;
    else if (turn?.chain && (!chain ? !team : fits(chain))) {
      // The thread of the ask this turn answers, as before (one without a row is an ask from before Teams).
      thread = chain ?? null;
      threadId = turn.chain.threadId;
    } else if (item?.thread_id && fits(this.#thread(item.thread_id))) {
      thread = this.#thread(item.thread_id)!;
      threadId = thread.id;
    } else threadId = newId('thr');

    const about: MessageMeta = { toBotId: to.id, toBotName: to.name, askText: t, threadId, hop };
    const fields = { botId: from.id, toBotId: to.id, threadId, hop };

    if (hop > ASK_HOP_LIMIT) {
      this.host.chip(from.id, `Didn't ask ${to.name}: ${ASK_HOP_LIMIT} asks in a row is the limit`, { kind: 'ask.refused', ...about });
      if (thread) this.#system(thread.id, `${from.name} did not ask ${to.name}: ${ASK_HOP_LIMIT} asks in a row is the limit.`, null);
      log.info('ask refused: hop limit', fields);
      throw new HttpError(
        409,
        `${to.name} was not asked: this thread between Botons already has ${ASK_HOP_LIMIT} asks in a row, the limit. Put what you have in your reply instead; ${owner.ownerName} can see it in your chat.`,
      );
    }

    const now = this.#clock();
    const backlog = this.#openFor(to.id);
    if (backlog >= TEAM_LIMITS.recipientBacklog) {
      log.warn('ask refused: recipient backlog', { ...fields, backlog });
      throw new HttpError(429, `${to.name} has ${backlog} messages waiting, the limit. Try again later, or put it in your reply.`, { 'retry-after': '300' });
    }
    const pair = pairKey(from.id, to.id);
    const hit = this.#rateHit(from.id, to.id, now);
    if (hit) {
      const { s, wait } = retryAfter(hit.retryAfterMs);
      const between = hit.pair ? `${from.name} and ${to.name}` : 'all Botons';
      if (this.#chipDue(pair)) this.host.chip(from.id, `Didn't ask ${to.name}: too many asks (limit: ${hit.max} an hour between ${between})`, { kind: 'ask.refused', ...about });
      log.warn('ask refused: rate limit', { ...fields, limit: hit.pair ? 'pair' : 'total', max: hit.max });
      throw new HttpError(429, `${to.name} was not asked: ${between} have sent ${hit.max} asks in the last hour, the limit. Try again in ${wait}, or put it in your reply.`, {
        'retry-after': String(s),
      });
    }

    if (team) {
      const hour = this.#teamMessages(team.id, now - HOUR);
      if (hour >= TEAM_LIMITS.messagesPerTeamPerHour) {
        throw refusal('limit', `${to.name} was not asked: team ${team.name} has sent ${TEAM_LIMITS.messagesPerTeamPerHour} messages in the last hour, the limit. Try again later, or put it in your reply.`, 429);
      }
      const perDay = this.#limits(team).messagesPerDay;
      if (this.#teamMessages(team.id, this.#dayFrom(team, now)) >= perDay) {
        const teamId = String(team.id);
        this.#store.atomically(() => this.#pauseTeam(teamId, 'budget', `it sent ${perDay} messages today, its daily budget`));
        throw refusal('limit', `${to.name} was not asked: team ${team.name} has sent ${perDay} messages today, its budget, so it is paused until ${owner.ownerName} resumes it.`, 429);
      }
    }

    const out = this.#store.atomically(() => {
      const row = this.#request({
        threadId,
        thread,
        subject: item ? String(item.title) : firstLine(t),
        teamId: team?.id ?? null,
        itemId: item?.id ?? null,
        // A colleague's help on an item is about the item, not an assignment of it: no gen.
        itemGen: null,
        from: { id: from.id, name: from.name },
        to: { id: to.id, name: to.name },
        text: t,
        hop,
        turnId: turn?.turnId ?? null,
        origin: turn?.origin ?? null,
        idem,
      });
      this.host.chip(from.id, `Asked ${to.name}`, { kind: 'ask.sent', ...about, teamMessageId: row.id, ...this.#teamMeta(row) });
      return row;
    });
    log.info('ask sent', fields);
    return this.#askResult(out, false);
  }

  /** The AskResult for a request (its delivery as it stands now). */
  #askResult(m: Row, duplicate: boolean): AskResult {
    const d = this.#get('select * from team_deliveries where message_id = ?', m.id);
    const queued = d?.state === 'queued';
    const message = !queued && d?.chat_message_id ? this.#store.findMessage(String(d.chat_message_id)) : null;
    const ahead = queued
      ? Number(
          this.#get(
            "select count(*) as n from team_deliveries d join team_messages m on m.id = d.message_id where d.to_bot_id = ? and d.state = 'queued' and m.seq < ?",
            d.to_bot_id,
            m.seq,
          )!.n,
        )
      : 0;
    return { message, threadId: String(m.thread_id), hop: Number(m.hop), duplicate, state: queued ? 'queued' : 'dispatched', teamMessageId: String(m.id), ahead };
  }

  /** Requests a team sent since `since` (ms). */
  #teamMessages(teamId: string, since: number): number {
    return Number(this.#get("select count(*) as n from team_messages where team_id = ? and kind = 'request' and created_at > ?", teamId, this.#iso(since))!.n);
  }

  /**
   * Whether a Boton may read a thread now, by its seats now: a Direct thread, its participants; a team's, a participant
   * that holds a seat in the team now, or the team's lead now. A member removed from the team reads none of it.
   */
  #mayRead(t: Row, botId: string): boolean {
    const participant = parseJson<string[]>(t.participants, []).includes(botId);
    if (!t.team_id) return participant;
    if (this.#leadOf(t.team_id)?.bot_id === botId) return true;
    return participant && !!this.#seat(t.team_id, botId);
  }

  /** queued + dispatched for one recipient. */
  #openFor(botId: string): number {
    return Number(this.#get("select count(*) as n from team_deliveries where to_bot_id = ? and state in ('queued', 'dispatched')", botId)!.n);
  }

  /**
   * The pair's or the server's hourly limit, if this send would pass it: which, its number, and when a slot frees.
   * Assignment requests (with an item gen) are not asks: the team's own budgets count them, so asks keep their numbers.
   */
  #rateHit(a: string, b: string, now: number): { pair: boolean; max: number; retryAfterMs: number } | null {
    const since = this.#iso(now - HOUR);
    const pair = this.#all(
      `select created_at from team_messages where kind = 'request' and item_gen is null and created_at > ?
         and ((from_bot_id = ? and to_bot_id = ?) or (from_bot_id = ? and to_bot_id = ?)) order by created_at`,
      since,
      a,
      b,
      b,
      a,
    ).map((r) => Date.parse(r.created_at));
    if (pair.length >= this.#perPair) return { pair: true, max: this.#perPair, retryAfterMs: pair[pair.length - this.#perPair]! + HOUR - now };
    const total = this.#all("select created_at from team_messages where kind = 'request' and item_gen is null and from_bot_id is not null and created_at > ? order by created_at", since).map((r) =>
      Date.parse(r.created_at),
    );
    if (total.length >= this.#perHour) return { pair: false, max: this.#perHour, retryAfterMs: total[total.length - this.#perHour]! + HOUR - now };
    return null;
  }

  #thread(id: string): Row | undefined {
    return this.#get('select * from team_threads where id = ?', id);
  }

  /** In the caller's transaction: the thread (made when new), the request and its queued delivery, then dispatch. */
  #request(r: {
    threadId: string;
    thread: Row | null;
    subject: string;
    teamId: string | null;
    itemId: string | null;
    itemGen: number | null;
    from: { id: string | null; name: string };
    to: { id: string; name: string };
    replyTo?: string | null;
    text: string;
    hop: number;
    turnId: string | null;
    origin: string | null;
    idem: string | null;
    /** An item's assignment: its delivery carries the item and gen (replies to it are checked against them). */
    assignment?: boolean;
  }): Row {
    const now = this.#iso();
    if (!r.thread) {
      this.#run(
        'insert into team_threads (id, team_id, item_id, subject, participants, last_at, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        r.threadId,
        r.teamId,
        r.itemId,
        r.subject,
        '[]',
        now,
        now,
      );
    }
    const id = newId('tmsg', 10);
    this.#run(
      `insert into team_messages (id, thread_id, team_id, item_id, item_gen, kind, from_bot_id, from_name, to_bot_id, to_name, text, hop, turn_id, origin_key, idem_key, created_at)
         values (?, ?, ?, ?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      r.threadId,
      r.teamId,
      r.itemId,
      r.itemGen,
      r.from.id,
      r.from.name,
      r.to.id,
      r.to.name,
      r.text,
      r.hop,
      r.turnId,
      r.origin,
      r.idem,
      now,
    );
    const row = this.#get('select * from team_messages where id = ?', id)!;
    this.#touchThread(r.threadId, row, [r.from.id, r.to.id]);
    this.#run(
      `insert into team_deliveries (message_id, to_bot_id, reply_to_bot_id, item_id, item_gen, state, queued_at, expires_at) values (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      id,
      r.to.id,
      r.replyTo === undefined ? r.from.id : r.replyTo,
      r.assignment ? r.itemId : null,
      r.assignment ? r.itemGen : null,
      now,
      this.#iso(this.#clock() + TEAM_LIMITS.deliveryTtlMs),
    );
    this.#publishMessage(id);
    this.dispatch(r.to.id);
    return row;
  }

  /** A message's thread counts it, and takes its sender and recipient in. */
  #touchThread(threadId: string, m: Row, people: (string | null)[]) {
    const t = this.#thread(threadId)!;
    const participants = parseJson<string[]>(t.participants, []);
    for (const p of people) if (p && !participants.includes(p)) participants.push(p);
    this.#run('update team_threads set participants = ?, message_count = message_count + 1, last_seq = ?, last_at = ? where id = ?', JSON.stringify(participants), m.seq, m.created_at, threadId);
    this.#publishThread(threadId);
  }

  /** A line the server writes in a thread, so the owner sees why something stopped. */
  #system(threadId: string, text: string, idem: string | null): void {
    this.#store.atomically(() => {
      if (idem && this.#get('select 1 from team_messages where idem_key = ?', idem)) return;
      const t = this.#thread(threadId);
      if (!t) return;
      const id = newId('tmsg', 10);
      this.#run(
        `insert into team_messages (id, thread_id, team_id, item_id, kind, from_name, text, idem_key, created_at) values (?, ?, ?, ?, 'system', 'Botons', ?, ?, ?)`,
        id,
        threadId,
        t.team_id,
        t.item_id,
        text,
        idem,
        this.#iso(),
      );
      this.#touchThread(threadId, this.#get('select * from team_messages where id = ?', id)!, []);
      this.#publishMessage(id);
    });
  }

  // ------------------------------------------------------------------ the outbox

  /**
   * Moves this recipient's queued requests into its chat, oldest first, while fewer than dispatchedPerRecipient are
   * there and the request's team is active (or it is Direct). Each chat message and its delivery's change commit
   * together, so a request enters a chat exactly once. Returns how many moved.
   */
  dispatch(botId: string): number {
    return this.#store.atomically(() => {
      if (!this.#store.hasBot(botId)) return 0;
      const room = TEAM_LIMITS.dispatchedPerRecipient - Number(this.#get("select count(*) as n from team_deliveries where to_bot_id = ? and state = 'dispatched'", botId)!.n);
      if (room <= 0) return 0;
      const rows = this.#all(
        `select m.*, t.name as team_name, i.title as item_title, d.item_id as assigned_item from team_deliveries d join team_messages m on m.id = d.message_id
           left join teams t on t.id = m.team_id left join team_items i on i.id = m.item_id
           where d.to_bot_id = ? and d.state = 'queued' and d.expires_at > ? and (m.team_id is null or t.state = 'active')
           order by m.seq limit ?`,
        botId,
        this.#iso(),
        room,
      );
      for (const m of rows) {
        const meta: MessageMeta = {
          kind: 'ask',
          ...(m.from_bot_id ? { fromBotId: m.from_bot_id } : {}),
          fromBotName: m.from_name,
          threadId: m.thread_id,
          hop: Number(m.hop),
          teamMessageId: m.id,
          ...(m.team_id ? { teamId: m.team_id, teamName: m.team_name } : {}),
          ...(m.item_id ? { itemId: m.item_id, itemTitle: m.item_title ?? '' } : {}),
          // Only an assignment names its gen: the turn that answers it may act on that assignment (turnScope).
          ...(m.assigned_item ? { itemGen: Number(m.item_gen) } : {}),
        };
        const chat = this.#store.addMessage(botId, 'user', m.text, meta, true);
        this.#run("update team_deliveries set state = 'dispatched', chat_message_id = ?, dispatched_at = ? where message_id = ?", chat.id, this.#iso(), m.id);
        this.#publishMessage(m.id);
      }
      if (rows.length) this.#store.afterCommit(() => this.host.wake(botId));
      return rows.length;
    });
  }

  /** Every recipient with something queued. */
  dispatchAll(): void {
    for (const r of this.#all("select distinct to_bot_id from team_deliveries where state = 'queued'")) this.dispatch(String(r.to_bot_id));
  }

  /** Queued requests past their life: expired, never delivered. */
  expireDue(): number {
    // Looked at every tick: no write lock unless something is due.
    if (!this.#get("select 1 from team_deliveries where state = 'queued' and expires_at <= ? limit 1", this.#iso())) return 0;
    return this.#store.atomically(() => {
      const rows = this.#all("select * from team_deliveries where state = 'queued' and expires_at <= ?", this.#iso());
      for (const r of rows) {
        this.#run("update team_deliveries set state = 'expired', outcome = 'expired', handled_at = ? where message_id = ?", this.#iso(), r.message_id);
        this.#publishMessage(r.message_id);
        const item = r.item_id ? this.#get('select * from team_items where id = ?', r.item_id) : undefined;
        if (item && Number(item.gen) === Number(r.item_gen) && item.status !== 'done' && item.status !== 'cancelled') {
          const why = `The request to ${this.#botName(String(r.to_bot_id))} waited a day without being delivered`;
          this.#event(item.team_id, item.id, Number(item.gen), 'expired', { kind: 'server', botId: null, name: 'Botons' }, why, { wake: true });
          this.#addEvidence(item.id, { kind: 'expired', gen: Number(item.gen), detail: why, at: this.#iso() });
          this.#publishItem(item.id);
        }
        // Whoever asked hears it was never delivered (the item keeps its own evidence above).
        this.#answerUnanswered(r, 'the request waited a day without being delivered', { evidence: false });
      }
      return rows.length;
    });
  }

  /**
   * At start, before the engine resumes: expire what is past its life; close a dispatched request whose chat message
   * is gone or no longer waiting (so whoever asked hears instead of waiting forever); then dispatch what is queued.
   * Asks from before Teams have no delivery and are left to the engine, which runs them as it always has.
   */
  resume(): void {
    // Nothing open: nothing to write (a start with no Boton-to-Boton work in flight opens no transaction).
    if (!this.#get("select 1 from team_deliveries where state in ('queued', 'dispatched') limit 1")) return;
    this.expireDue();
    this.#store.atomically(() => {
      const lost = this.#all(
        `select d.*, c.pending as chat_pending from team_deliveries d left join messages c on c.id = d.chat_message_id
           where d.state = 'dispatched' and (c.id is null or c.pending = 0)`,
      );
      for (const d of lost) if (this.#close(d, 'lost', null)) this.#answerUnanswered(d, 'it was lost at a restart');
      if (lost.length) log.warn('closed requests lost at a restart', { count: lost.length });
    });
    this.dispatchAll();
  }

  /** A delivery handled, with how it ended (only while it is still open). */
  #close(d: Row, outcome: TeamDeliveryOutcome, turnId: string | null, state: 'handled' | 'cancelled' = 'handled'): boolean {
    const changed = Number(
      this.#run("update team_deliveries set state = ?, outcome = ?, turn_id = ?, handled_at = ? where message_id = ? and state in ('queued', 'dispatched')", state, outcome, turnId, this.#iso(), d.message_id)
        .changes,
    );
    if (changed) {
      this.#publishMessage(String(d.message_id));
      // A slot in that recipient's chat is free.
      this.#store.afterCommit(() => this.dispatch(String(d.to_bot_id)));
    }
    return changed > 0;
  }

  /**
   * Recalls requests that have not started: a queued one is cancelled; one in the recipient's chat that is still
   * waiting (pending 1) leaves the transcript (quiet) and is cancelled, in one step that only succeeds if it had not
   * started. One in flight is left to finish. `back` puts the recalled ones in the queue again instead (a pause).
   * `answer`: why, when whoever asked is to hear it will not be answered (the team finished or was archived).
   */
  recall(where: { messageIds?: string[]; teamId?: string }, back = false, answer?: string): number {
    return this.#store.atomically(() => {
      const rows = where.teamId
        ? this.#all("select d.* from team_deliveries d join team_messages m on m.id = d.message_id where m.team_id = ? and d.state in ('queued', 'dispatched')", where.teamId)
        : (where.messageIds ?? []).flatMap((id) => this.#all("select * from team_deliveries where message_id = ? and state in ('queued', 'dispatched')", id));
      let n = 0;
      for (const d of rows) {
        if (d.state === 'dispatched') {
          if (!d.chat_message_id || !this.#store.recallPending(String(d.chat_message_id))) continue;
          if (back) {
            this.#run("update team_deliveries set state = 'queued', chat_message_id = null, dispatched_at = null where message_id = ?", d.message_id);
            this.#publishMessage(String(d.message_id));
            n++;
            continue;
          }
        } else if (back) continue;
        if (this.#close(d, 'recalled', null, 'cancelled')) {
          n++;
          // The team was stopped, finished or archived: the answer is kept in the asker's chat and the thread, but it
          // wakes no one (a stopped or ended team starts no new turns).
          if (answer) this.#answerUnanswered(d, answer, { evidence: false, wake: false });
        }
      }
      return n;
    });
  }

  // ------------------------------------------------------------------ replies

  /**
   * The answers to the asks a chat turn answered, in the caller's transaction (the one that ends the turn): per asker
   * (the latest hop wins), a reply in the thread, the delivery handled, and a pending `ask.reply` in the asker's chat.
   * Stopped and dropped answer nobody but close their deliveries. Replies are never answered, so two Botons can't loop.
   */
  replied(bot: Pick<BotRecord, 'id' | 'name'>, answered: Message[], text: string, outcome: ReplyOutcome, turnId: string | null = null): void {
    // The turn's work, as the engine names it (C3): its oldest message, the same when it is re-run after a restart.
    const origin = answered.length ? `chat:${answered[0]!.id}` : null;
    this.#store.atomically(() => {
      for (const m of answered) if (m.meta?.kind === 'team.checkin') this.#checkinEnded(bot, m, outcome);
      const byAsker = new Map<string, Message[]>();
      for (const m of answered) {
        const asker = m.meta?.kind === 'ask' ? m.meta.fromBotId : undefined;
        if (!asker) continue;
        byAsker.set(asker, [...(byAsker.get(asker) ?? []), m]);
      }
      const reply = text.length > TEAM_TEXT.message ? `${text.slice(0, TEAM_TEXT.message)}…` : text;
      for (const [asker, asks] of byAsker) {
        let latest: Message | null = null;
        for (const m of asks) if (!latest || (m.meta?.hop ?? 1) >= (latest.meta?.hop ?? 1)) latest = m;
        // Every delivery among them closes; one already closed (recalled, or answered by an earlier attempt) is left.
        const open = new Map<string, Row>();
        for (const m of asks) {
          const d = m.meta?.teamMessageId ? this.#get('select * from team_deliveries where message_id = ?', m.meta.teamMessageId) : undefined;
          if (d && (d.state === 'queued' || d.state === 'dispatched')) open.set(m.id, d);
        }
        const deliveryOutcome: TeamDeliveryOutcome = outcome;
        // What each assignment's answer does to its item, only while that assignment is the item's own (its gen).
        const effects = new Map<string, ItemEffect>();
        for (const d of open.values()) {
          this.#close(d, deliveryOutcome, turnId);
          if (d.item_id) effects.set(String(d.message_id), this.#replyEffect(d, bot, outcome, origin));
        }
        if (outcome === 'stopped' || outcome === 'dropped') continue;
        // Every request answered has its reply in its own thread (marked stale when it answered a replaced
        // assignment); the asker gets one message, for the latest.
        for (const [id, d] of open) {
          if (id === latest!.id) continue;
          const request = this.#get('select * from team_messages where id = ?', d.message_id);
          if (request) this.#reply(request, bot, reply, turnId, effects.get(String(d.message_id))?.stale ?? false);
        }
        const tracked = !!latest!.meta?.teamMessageId;
        if (tracked && !open.has(latest!.id)) continue;
        if (!this.#store.hasBot(asker)) continue;
        const meta: MessageMeta = { kind: 'ask.reply', fromBotId: bot.id, fromBotName: bot.name, threadId: latest!.meta?.threadId, hop: latest!.meta?.hop, askId: latest!.id };
        if (tracked) {
          const request = this.#get('select * from team_messages where id = ?', latest!.meta!.teamMessageId)!;
          const effect = effects.get(String(request.id));
          const replyRow = this.#reply(request, bot, reply, turnId, effect?.stale ?? false);
          Object.assign(meta, { teamMessageId: replyRow.id, ...this.#teamMeta(request) });
          if (effect?.stale) meta.stale = true;
          if (effect?.silent) meta.silent = true;
          if (request.item_gen !== null && request.item_gen !== undefined && effect) meta.itemGen = Number(request.item_gen);
        }
        this.#store.addMessage(asker, 'user', reply, meta, true);
        log.info('ask answered', { botId: asker, fromBotId: bot.id, threadId: latest!.meta?.threadId, hop: latest!.meta?.hop });
        this.#store.afterCommit(() => this.host.wake(asker));
      }
    });
  }

  /**
   * In replied()'s transaction: what an assignment's answer does to its item. Only when the delivery's gen is still
   * the item's and the replier still holds it; otherwise it answers a replaced assignment and touches nothing.
   */
  #replyEffect(d: Row, bot: Pick<BotRecord, 'id' | 'name'>, outcome: ReplyOutcome, origin: string | null): ItemEffect {
    const r = this.#get('select * from team_items where id = ?', d.item_id);
    if (!r) return { stale: true, silent: false };
    // The assignee finished it in this very work: its `done` moved the gen on by one, so the reply is the current
    // assignment's on exact proof only (the done event names this gen, this Boton and this work's origin). Being the
    // same Boton, or the item being done, proves nothing: an older attempt's late reply stays stale.
    if (Number(r.gen) === Number(d.item_gen) + 1 && r.status === 'done' && origin && outcome !== 'stopped' && outcome !== 'dropped') {
      const finished = this.#get(
        "select 1 from team_events where item_id = ? and kind = 'done' and gen = ? and from_gen = ? and actor_kind = 'boton' and actor_bot_id = ? and actor_origin = ? limit 1",
        r.id,
        Number(r.gen),
        Number(d.item_gen),
        bot.id,
        origin,
      );
      return { stale: !finished, silent: false };
    }
    if (Number(r.gen) !== Number(d.item_gen) || r.assignee_bot_id !== bot.id) return { stale: true, silent: false };
    const gen = Number(r.gen);
    const limits = this.#limits(this.#teamRow(r.team_id));
    const at = this.#iso();
    const server: Actor = { kind: 'server', botId: null, name: 'Botons' };
    if (outcome === 'stopped' || outcome === 'dropped') {
      if (r.status !== 'open' && r.status !== 'working') return { stale: false, silent: false };
      this.#stopItem(r, server);
      return { stale: false, silent: false };
    }
    if (r.status !== 'open' && r.status !== 'working') return { stale: false, silent: false };
    if (outcome === 'failed') {
      this.#event(r.team_id, r.id, gen, 'turn_failed', server, `${bot.name}'s turn on it failed`);
      this.#addEvidence(r.id, { kind: 'turn_failed', gen, detail: `${bot.name}'s turn on it failed`, at });
    } else {
      // Progress noted during the turn counts as an outcome of it; a turn that left nothing on record ended silently.
      const noted = this.#get("select 1 from team_events where item_id = ? and gen = ? and kind in ('progress', 'started') and actor_bot_id = ? and at >= ? limit 1", r.id, gen, bot.id, d.dispatched_at ?? d.queued_at);
      if (noted) return { stale: false, silent: false };
      this.#event(r.team_id, r.id, gen, 'silent_end', server, `${bot.name}'s turn ended without marking it done or blocked`);
      this.#addEvidence(r.id, { kind: 'silent_end', gen, detail: `${bot.name}'s turn ended without marking it done or blocked`, at });
    }
    this.#run('update team_items set next_check_at = ?, version = version + 1, updated_at = ? where id = ?', this.#iso(this.#clock() + limits.stallAfterMs), at, r.id);
    this.#publishItem(r.id);
    return { stale: false, silent: outcome !== 'failed' };
  }

  /** The reply row in the request's thread (once per delivery). */
  #reply(request: Row, bot: Pick<BotRecord, 'id' | 'name'>, text: string, turnId: string | null, stale = false): Row {
    const idem = `reply:${request.id}`;
    const prev = this.#get('select * from team_messages where idem_key = ?', idem);
    if (prev) return prev;
    const id = newId('tmsg', 10);
    this.#run(
      `insert into team_messages (id, thread_id, team_id, item_id, item_gen, kind, from_bot_id, from_name, to_bot_id, to_name, text, hop, in_reply_to, stale, turn_id, idem_key, created_at)
         values (?, ?, ?, ?, ?, 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      request.thread_id,
      request.team_id,
      request.item_id,
      request.item_gen,
      bot.id,
      bot.name,
      request.from_bot_id,
      request.from_name,
      text,
      request.hop,
      request.id,
      stale ? 1 : 0,
      turnId,
      idem,
      this.#iso(),
    );
    const row = this.#get('select * from team_messages where id = ?', id)!;
    this.#touchThread(String(request.thread_id), row, [bot.id]);
    this.#publishMessage(id);
    return row;
  }

  // ------------------------------------------------------------------ teams and seats

  #owner(): string {
    return this.#store.getSettings().ownerName;
  }

  #record(by: Principal | null, action: TeamAuditAction, team: { id: string; name: string }, details: Record<string, string | number | boolean | null | string[] | undefined> = {}) {
    this.#audit?.record(by, { action, target: { kind: 'team', id: team.id, label: team.name }, details });
  }

  #teamRow(id: string): Row {
    const t = this.#get('select * from teams where id = ?', id);
    if (!t) throw new HttpError(404, `No team ${id}`);
    return t;
  }

  /** A team by id or name (not archived), as a Boton or the CLI names it. */
  teamByRef(ref: string): Row | undefined {
    return this.#get('select * from teams where id = ?', ref) ?? this.#get("select * from teams where name_key = ? and state <> 'archived'", sidebarGroupKey(ref.trim()));
  }

  #seat(teamId: string, botId: string): Row | undefined {
    return this.#get('select * from team_members where team_id = ? and bot_id = ?', teamId, botId);
  }

  #leadOf(teamId: string): Row | undefined {
    return this.#get("select m.*, b.name, b.paused, b.provider from team_members m join bots b on b.id = m.bot_id where m.team_id = ? and m.role = 'lead'", teamId);
  }

  #limits(t: Row): TeamLimits {
    return teamLimits(parseJson(t.limits, {}));
  }

  #checkVersion(t: Row, version: unknown): void {
    if (version === undefined) return;
    if (typeof version !== 'number' || version !== Number(t.version)) {
      throw refusal('stale_version', `This team changed since you loaded it (now version ${t.version}). Load it again and retry.`);
    }
  }

  #members(raw: unknown, teamId: string | null): (Required<TeamMemberInput> & { name: string })[] {
    if (!Array.isArray(raw)) throw new HttpError(400, 'members must be a list of { botId, role, roleTitle?, responsibilities? }');
    if (!raw.length) throw new HttpError(400, 'A team needs members, one of them its lead');
    if (raw.length > TEAM_LIMITS.membersPerTeam) throw new HttpError(400, `A team has at most ${TEAM_LIMITS.membersPerTeam} members`);
    const seen = new Set<string>();
    const out = raw.map((m, i) => {
      if (!m || typeof m !== 'object') throw new HttpError(400, `members[${i}] must be an object`);
      const o = m as Record<string, unknown>;
      if (typeof o.botId !== 'string' || !this.#store.hasBot(o.botId)) throw new HttpError(400, `members[${i}].botId must be a Boton's id`);
      if (seen.has(o.botId)) throw new HttpError(400, `${o.botId} is listed twice`);
      seen.add(o.botId);
      if (o.role !== 'lead' && o.role !== 'member') throw new HttpError(400, `members[${i}].role must be "lead" or "member"`);
      const name = this.#store.getBot(o.botId).name;
      return {
        botId: o.botId,
        role: o.role as TeamRole,
        roleTitle: o.roleTitle === undefined || o.roleTitle === null || o.roleTitle === '' ? '' : title(o.roleTitle, `members[${i}].roleTitle`, TEAM_TEXT.roleTitle),
        responsibilities: prose(o.responsibilities, `members[${i}].responsibilities`, TEAM_TEXT.responsibilities),
        name,
      };
    });
    if (out.filter((m) => m.role === 'lead').length !== 1) throw new HttpError(400, 'A team has exactly one lead');
    for (const m of out) {
      const seats = Number(
        this.#get("select count(*) as n from team_members m join teams t on t.id = m.team_id where m.bot_id = ? and t.state <> 'archived' and t.id <> ?", m.botId, teamId ?? '')!.n,
      );
      if (seats >= TEAM_LIMITS.teamsPerBot) throw new HttpError(409, `${m.name} is already in ${TEAM_LIMITS.teamsPerBot} teams, the limit`);
    }
    return out;
  }

  #nameFree(name: string, teamId: string | null): string {
    const key = sidebarGroupKey(name);
    if (this.#get("select 1 from teams where name_key = ? and state <> 'archived' and id <> ?", key, teamId ?? '')) throw new HttpError(409, `There is already a team called ${name}`);
    return key;
  }

  /** The owner's new team: active at once, so its lead gets the kickoff check-in. */
  create(input: unknown, by: Principal | null = null): Team {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const name = title(o.name, 'name', TEAM_TEXT.name);
    const goal = prose(o.goal, 'goal', TEAM_TEXT.goal);
    const members = this.#members(o.members, null);
    const id = this.#store.atomically(() => {
      const key = this.#nameFree(name, null);
      if (Number(this.#get("select count(*) as n from teams where state <> 'archived'")!.n) >= TEAM_LIMITS.teams) throw new HttpError(409, `There are already ${TEAM_LIMITS.teams} teams, the limit. Archive one first.`);
      const id = newId('team');
      const now = this.#iso();
      this.#run('insert into teams (id, name, name_key, goal, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', id, name, key, goal, now, now);
      members.forEach((m, i) => {
        this.#run(
          'insert into team_members (team_id, bot_id, role, role_title, responsibilities, position, joined_at) values (?, ?, ?, ?, ?, ?, ?)',
          id,
          m.botId,
          m.role,
          m.roleTitle,
          m.responsibilities,
          i,
          now,
        );
      });
      this.#event(id, null, null, 'team_created', { kind: by?.kind === 'boton' ? 'boton' : 'owner', botId: null, name: this.#owner() }, name);
      this.#record(by, 'team.created', { id, name }, { members: members.map((m) => m.botId), lead: members.find((m) => m.role === 'lead')!.botId });
      for (const m of members) this.#store.emitBot(m.botId);
      this.#publishTeam(id);
      return id;
    });
    log.info('team created', { teamId: id, members: members.length });
    return this.get(id);
  }

  update(id: string, input: unknown, by: Principal | null = null): Team {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    this.#store.atomically(() => {
      const t = this.#teamRow(id);
      if (t.state === 'archived') throw new HttpError(409, 'This team is archived: restore it first');
      this.#checkVersion(t, o.version);
      const changed: string[] = [];
      if (o.name !== undefined) {
        const name = title(o.name, 'name', TEAM_TEXT.name);
        if (name !== t.name) {
          this.#run('update teams set name = ?, name_key = ? where id = ?', name, this.#nameFree(name, id), id);
          changed.push('name');
        }
      }
      if (o.goal !== undefined) {
        const goal = prose(o.goal, 'goal', TEAM_TEXT.goal);
        if (goal !== t.goal) {
          this.#run('update teams set goal = ? where id = ?', goal, id);
          changed.push('goal');
        }
      }
      if (o.limits !== undefined) {
        const problem = limitsRefusal(o.limits);
        if (problem) throw new HttpError(400, problem);
        const next = { ...parseJson<Record<string, number>>(t.limits, {}), ...(o.limits as Record<string, number>) };
        this.#run('update teams set limits = ? where id = ?', JSON.stringify(next), id);
        this.#record(by, 'team.limits_changed', { id, name: t.name }, { limits: Object.keys(o.limits as object) });
      }
      if (!changed.length && o.limits === undefined) return;
      this.#run('update teams set version = version + 1, updated_at = ? where id = ?', this.#iso(), id);
      if (changed.length) {
        this.#record(by, 'team.updated', { id, name: String(this.#teamRow(id).name) }, { fields: changed });
        this.#event(id, null, null, 'team_updated', this.#ownerActor(), changed.join(', '));
      }
      for (const m of this.#all('select bot_id from team_members where team_id = ?', id)) this.#store.emitBot(String(m.bot_id));
      this.#publishTeam(id);
    });
    return this.get(id);
  }

  /** PUT /api/teams/:id/members: the whole roster at once (exactly one lead). Removed members' work is unassigned. */
  setMembers(id: string, input: unknown, by: Principal | null = null): Team {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    this.#store.atomically(() => {
      const t = this.#teamRow(id);
      if (t.state === 'archived') throw new HttpError(409, 'This team is archived: restore it first');
      this.#checkVersion(t, o.version);
      const members = this.#members(o.members, id);
      const before = new Map(this.#all('select * from team_members where team_id = ?', id).map((r) => [String(r.bot_id), r]));
      const team = { id, name: String(t.name) };
      const now = this.#iso();
      const touched = new Set<string>();
      // The old lead steps down before the new one takes the seat (one lead at a time).
      this.#run("update team_members set role = 'member' where team_id = ? and role = 'lead'", id);
      for (const [botId] of before) {
        if (members.some((m) => m.botId === botId)) continue;
        this.#run('delete from team_members where team_id = ? and bot_id = ?', id, botId);
        this.#unassign(botId, id, 'unavailable', `${this.#botName(botId)} left the team`);
        this.#recallFrom(botId, id);
        this.#record(by, 'team.member_removed', team, { boton: botId });
        this.#event(id, null, null, 'member_removed', this.#ownerActor(), this.#botName(botId));
        touched.add(botId);
      }
      members.forEach((m, i) => {
        const was = before.get(m.botId);
        if (!was) {
          this.#run(
            'insert into team_members (team_id, bot_id, role, role_title, responsibilities, position, joined_at) values (?, ?, ?, ?, ?, ?, ?)',
            id,
            m.botId,
            m.role,
            m.roleTitle,
            m.responsibilities,
            i,
            now,
          );
          this.#record(by, 'team.member_added', team, { boton: m.botId, role: m.role });
          this.#event(id, null, null, 'member_added', this.#ownerActor(), m.name);
          touched.add(m.botId);
          return;
        }
        this.#run('update team_members set role = ?, role_title = ?, responsibilities = ?, position = ? where team_id = ? and bot_id = ?', m.role, m.roleTitle, m.responsibilities, i, id, m.botId);
        if (was.role !== m.role || was.role_title !== m.roleTitle || was.responsibilities !== m.responsibilities) {
          this.#record(by, 'team.member_changed', team, { boton: m.botId, role: m.role, ...(was.role !== m.role ? { from: String(was.role) } : {}) });
          this.#event(id, null, null, 'member_changed', this.#ownerActor(), m.name);
          touched.add(m.botId);
        }
      });
      this.#run('update teams set version = version + 1, updated_at = ? where id = ?', now, id);
      this.#repointToLead(id);
      // A team paused for want of a lead has one again.
      if (t.state === 'paused' && t.paused_reason === 'no_lead') this.#resumeTeam(id, this.#ownerActor());
      for (const botId of touched) if (this.#store.hasBot(botId)) this.#store.emitBot(botId);
      this.#publishTeam(id);
    });
    return this.get(id);
  }

  /**
   * The owner's Pause, Resume, Stop work and Archive. Pause: nothing dispatches, no check-ins, what had not started
   * goes back to the queue, running turns finish. Stop work: a pause that also stops the running turns on this team's
   * work, takes back what had not started, closes what was in flight as stopped, and blocks working items for the owner.
   */
  setState(id: string, input: unknown, by: Principal | null = null): Team {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const state = o.state;
    if (state !== 'active' && state !== 'paused' && state !== 'archived') throw new HttpError(400, 'state must be "active", "paused" or "archived"');
    if (o.stop !== undefined && typeof o.stop !== 'boolean') throw new HttpError(400, 'stop must be true or false');
    const stop = o.stop === true;
    if (stop && state !== 'paused') throw new HttpError(400, 'stop goes with state "paused"');
    let stopTurns = false;
    this.#store.atomically(() => {
      const t = this.#teamRow(id);
      this.#checkVersion(t, o.version);
      const team = { id, name: String(t.name) };
      const from = String(t.state);
      if (state === 'paused') {
        if (from === 'archived' || from === 'done') throw new HttpError(409, `This team is ${from}: only an active team pauses`);
        if (from === 'paused' && !stop) return;
        if (from === 'active') this.#pauseTeam(id, stop ? 'stopped' : 'owner', stop ? `Stopped by ${this.#owner()}` : `Paused by ${this.#owner()}`);
        else this.#run("update teams set paused_reason = ?, version = version + 1, updated_at = ? where id = ?", stop ? 'stopped' : 'owner', this.#iso(), id);
        if (stop) {
          this.#stopWork(id);
          stopTurns = true;
          this.#record(by, 'team.stopped', team);
        }
      } else if (state === 'active') {
        if (from === 'active') return;
        if (!this.#leadOf(id)) throw refusal('not_allowed', 'This team has no lead: give it one (Edit team) before resuming it.');
        if (from === 'archived') this.#nameFree(String(t.name), id);
        if (from === 'done') this.#run('update teams set completion = null, reviewed_at = null, wrapup_told_at = null where id = ?', id);
        this.#resumeTeam(id, this.#ownerActor());
      } else {
        if (from === 'archived') return;
        this.#run("update teams set state = 'archived', paused_reason = null, inactive_since = coalesce(inactive_since, ?), version = version + 1, updated_at = ? where id = ?", this.#iso(), this.#iso(), id);
        this.recall({ teamId: id }, false, `team ${t.name} was archived before it was delivered`);
        this.#record(by, 'team.archived', team);
      }
      if (state !== 'archived') this.#record(by, 'team.state_changed', team, { from, to: state, ...(stop ? { stop } : {}) });
      for (const m of this.#all('select bot_id from team_members where team_id = ?', id)) this.#store.emitBot(String(m.bot_id));
      this.#publishTeam(id);
    });
    if (stopTurns) this.host.stopTeamTurns(id);
    return this.get(id);
  }

  /** Stop work's record: not-started requests taken back, in-flight ones closed as stopped, working items blocked. */
  #stopWork(teamId: string): void {
    // What had not started is taken back, and whoever asked hears so; what was in flight closes as stopped (its
    // turn is stopped, and like any stopped turn it answers nobody).
    this.recall({ teamId }, false, `team ${this.#teamRow(teamId).name} was stopped before it was delivered`);
    for (const d of this.#all("select d.* from team_deliveries d join team_messages m on m.id = d.message_id where m.team_id = ? and d.state = 'dispatched'", teamId)) this.#close(d, 'stopped', null);
    // Every live item starts a new assignment, so no turn that started before can act on any of them: working ones
    // wait for the owner, blocked and unassigned ones keep their status.
    for (const r of this.#all("select * from team_items where team_id = ? and status in ('open', 'working', 'blocked')", teamId)) {
      if ((r.status === 'open' || r.status === 'working') && r.assignee_bot_id) this.#stopItem(r, this.#ownerActor());
      else this.#fence(r, this.#ownerActor());
    }
  }

  /** A new assignment (gen) of an item whose status stays: what a turn of the old one does is refused. */
  #fence(r: Row, actor: Actor): void {
    const why = `Stopped by ${this.#owner()}`;
    const at = this.#iso();
    const gen = Number(r.gen) + 1;
    this.#recallItem(String(r.id), Number(r.gen));
    this.#run('update team_items set gen = ?, gen_started_at = ?, nudges = 0, version = version + 1, updated_at = ? where id = ?', gen, at, at, r.id);
    this.#event(String(r.team_id), String(r.id), gen, 'stopped', actor, why);
    this.#addEvidence(String(r.id), { kind: 'stopped', gen, detail: why, at });
    this.#publishItem(String(r.id));
  }

  /**
   * The owner stopped the work on an item: it waits for them, blocked, as a new assignment (gen), so whatever a turn
   * that started before (the assignee's, the lead's, a routine run's) still tries about it is refused. What of the old
   * one had not started is recalled.
   */
  #stopItem(r: Row, actor: Actor): void {
    const why = `Stopped by ${this.#owner()}`;
    const at = this.#iso();
    const gen = Number(r.gen) + 1;
    this.#recallItem(String(r.id), Number(r.gen));
    this.#run(
      "update team_items set status = 'blocked', blocked_reason = ?, blocked_need = 'owner', gen = ?, gen_started_at = ?, nudges = 0, version = version + 1, updated_at = ?, last_activity_at = ? where id = ?",
      why,
      gen,
      at,
      at,
      at,
      r.id,
    );
    this.#event(String(r.team_id), String(r.id), gen, 'stopped', actor, why);
    this.#addEvidence(String(r.id), { kind: 'stopped', gen, detail: why, at });
    this.#publishItem(String(r.id));
  }

  /** The owner marks a finished team's completion reviewed: it needs them no longer. */
  review(id: string, by: Principal | null = null): Team {
    this.#store.atomically(() => {
      const t = this.#teamRow(id);
      if (t.state !== 'done' || !t.completion) throw new HttpError(409, 'Only a finished team is reviewed');
      if (t.reviewed_at) return;
      this.#run('update teams set reviewed_at = ?, version = version + 1, updated_at = ? where id = ?', this.#iso(), this.#iso(), id);
      this.#event(id, null, null, 'team_reviewed', this.#ownerActor(), '');
      this.#record(by, 'team.reviewed', { id, name: String(t.name) });
      this.#publishTeam(id);
    });
    return this.get(id);
  }

  /** Hard delete: an archived team only, owner only, audited. Its threads go with it. */
  remove(id: string, by: Principal | null = null): void {
    this.#store.atomically(() => {
      const t = this.#teamRow(id);
      if (t.state !== 'archived') throw new HttpError(409, 'Archive the team before deleting it');
      const members = this.#all('select bot_id from team_members where team_id = ?', id).map((r) => String(r.bot_id));
      this.#run('delete from team_deliveries where message_id in (select id from team_messages where team_id = ?)', id);
      this.#run('delete from team_messages where team_id = ?', id);
      this.#run('delete from teams where id = ?', id);
      this.#record(by, 'team.deleted', { id, name: String(t.name) });
      for (const b of members) this.#store.emitBot(b);
      this.#store.publish({ type: 'team.deleted', teamId: id });
      this.#publishAttention();
    });
  }

  #botName(botId: string): string {
    return String(this.#get('select name from bots where id = ?', botId)?.name ?? botId);
  }

  #ownerActor(): Actor {
    return { kind: 'owner', botId: null, name: this.#owner() };
  }

  /** A Boton's seats in teams that are not archived (Bot.teams), in the teams' order. */
  botTeams(botId: string): BotTeamRef[] {
    return this.#all(
      "select t.id, t.name, m.role, m.role_title from team_members m join teams t on t.id = m.team_id where m.bot_id = ? and t.state <> 'archived' order by t.created_at, t.id",
      botId,
    ).map((r) => ({ id: r.id, name: r.name, role: r.role, roleTitle: r.role_title }));
  }

  /**
   * In Store.deleteBot's transaction, before the Boton goes: its open requests close as gone (whoever asked hears it
   * could not answer), the items it held are free again, and a team it led pauses for want of a lead.
   */
  botDeleted(botId: string): void {
    const name = this.#botName(botId);
    for (const d of this.#all("select * from team_deliveries where to_bot_id = ? and state in ('queued', 'dispatched')", botId)) {
      if (this.#close(d, 'gone', null)) this.#answerUnanswered(d, 'it was deleted');
    }
    const teams = this.#all('select team_id, role from team_members where bot_id = ?', botId);
    for (const seat of teams) {
      const teamId = String(seat.team_id);
      this.#unassign(botId, teamId, 'unavailable', `${name} was deleted`);
      this.#event(teamId, null, null, 'member_removed', { kind: 'server', botId: null, name: 'Botons' }, name);
      this.#run('delete from team_members where team_id = ? and bot_id = ?', teamId, botId);
      this.#run('update teams set version = version + 1, updated_at = ? where id = ?', this.#iso(), teamId);
      if (seat.role === 'lead') {
        const t = this.#teamRow(teamId);
        if (t.state === 'active') this.#pauseTeam(teamId, 'no_lead', `${name}, its lead, was deleted`);
        else if (t.state === 'paused') this.#run("update teams set paused_reason = 'no_lead' where id = ?", teamId);
        this.#repointToLead(teamId);
      }
      this.#publishTeam(teamId);
    }
  }

  /**
   * A request that will never be answered (its recipient was deleted, its chat message was lost at a restart, it
   * expired undelivered, or its team finished or was archived first): its asker hears so, as it would of a failed
   * turn, and an assignment's item records it as evidence (unless the caller recorded its own).
   */
  #answerUnanswered(d: Row, why: string, opts: { evidence?: boolean; wake?: boolean } = {}): void {
    const request = this.#get('select * from team_messages where id = ?', d.message_id);
    const to = String(d.to_bot_id);
    const name = this.#botName(to) === to ? String(request?.to_name ?? to) : this.#botName(to);
    if (d.item_id && opts.evidence !== false) {
      const r = this.#get('select * from team_items where id = ?', d.item_id);
      if (r && Number(r.gen) === Number(d.item_gen) && (r.status === 'open' || r.status === 'working')) {
        const detail = `The request to ${name} could not be answered: ${why}`;
        this.#event(String(r.team_id), String(r.id), Number(r.gen), 'turn_failed', SERVER, detail, { wake: true });
        this.#addEvidence(String(r.id), { kind: 'turn_failed', gen: Number(r.gen), detail, at: this.#iso() });
        this.#publishItem(String(r.id));
      }
    }
    const asker = d.reply_to_bot_id ? String(d.reply_to_bot_id) : null;
    if (!request || !asker || asker === to || !this.#store.hasBot(asker)) return;
    const text = `(${name} could not answer: ${why})`;
    const reply = this.#reply(request, { id: to, name }, text, null);
    const wake = opts.wake !== false;
    // Not waking: on record (not pending), so it is no turn's input.
    this.#store.addMessage(asker, 'user', text, { kind: 'ask.reply', fromBotId: to, fromBotName: name, threadId: request.thread_id, hop: Number(request.hop), askId: d.chat_message_id ?? undefined, teamMessageId: reply.id, ...this.#teamMeta(request) }, wake);
    if (wake) this.#store.afterCommit(() => this.host.wake(asker));
  }

  /** The team and item a request belongs to, for a chat message's meta. */
  #teamMeta(m: Row): MessageMeta {
    if (!m.team_id) return {};
    const team = this.#get('select name from teams where id = ?', m.team_id);
    const item = m.item_id ? this.#get('select title, status from team_items where id = ?', m.item_id) : undefined;
    return {
      teamId: m.team_id,
      teamName: String(team?.name ?? ''),
      ...(m.item_id ? { itemId: m.item_id, itemTitle: String(item?.title ?? ''), ...(item ? { itemStatus: item.status } : {}) } : {}),
    };
  }

  list(): Team[] {
    return this.#all("select * from teams order by case when state = 'archived' then 1 else 0 end, created_at, id").map((t) => this.#toTeam(t));
  }

  get(id: string): Team {
    return this.#toTeam(this.#teamRow(id));
  }

  detail(id: string): TeamDetail {
    const team = this.get(id);
    const items = this.#all('select * from team_items where team_id = ? order by created_at, id', id).map((r) => this.#toItem(r));
    const events = this.#all('select * from team_events where team_id = ? order by seq desc limit 50', id).map((r) => this.#toEvent(r));
    return { team, items, events };
  }

  /** What needs the owner across teams (the badge), and threads with unread messages (a dot). */
  attention(): TeamsAttention {
    let count = 0;
    for (const t of this.#all("select * from teams where state <> 'archived'")) count += this.#teamAttention(t);
    const unreadThreads = Number(this.#get('select count(*) as n from team_threads where last_seq > owner_read_seq')!.n);
    return { count, unreadThreads };
  }

  #teamAttention(t: Row): number {
    let n = 0;
    if (t.state === 'paused' && (t.paused_reason === 'budget' || t.paused_reason === 'no_lead')) n++;
    if (t.state === 'done' && t.completion && !t.reviewed_at) n++;
    for (const r of this.#all("select status, escalation, held, blocked_need from team_items where team_id = ? and status not in ('done', 'cancelled')", t.id)) {
      if (itemNeedsOwner({ status: r.status, escalation: parseJson<TeamEscalation | null>(r.escalation, null), held: r.held ?? null, blockedNeed: r.blocked_need ?? null })) n++;
    }
    return n;
  }

  #toTeam(t: Row): Team {
    const members = this.#all('select m.*, b.name, b.paused from team_members m join bots b on b.id = m.bot_id where m.team_id = ? order by m.position, m.joined_at', t.id).map((m) => ({
      botId: String(m.bot_id),
      name: String(m.name),
      role: m.role as TeamRole,
      roleTitle: String(m.role_title),
      responsibilities: String(m.responsibilities),
      state: this.host.statusOf(String(m.bot_id)).state,
      paused: !!m.paused,
    }));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TeamItemStatus, number>;
    for (const r of this.#all('select status, count(*) as n from team_items where team_id = ? group by status', t.id)) counts[r.status as TeamItemStatus] = Number(r.n);
    const lead = members.find((m) => m.role === 'lead');
    return {
      id: t.id,
      name: t.name,
      goal: t.goal,
      state: t.state,
      pausedReason: (t.paused_reason as TeamPausedReason | null) ?? null,
      lead: lead ? { botId: lead.botId, name: lead.name } : null,
      members,
      counts,
      attention: t.state === 'archived' ? 0 : this.#teamAttention(t),
      unreadThreads: Number(this.#get('select count(*) as n from team_threads where team_id = ? and last_seq > owner_read_seq', t.id)!.n),
      limits: this.#limits(t),
      completion: parseJson<TeamCompletion | null>(t.completion, null),
      reviewedAt: t.reviewed_at ?? null,
      version: Number(t.version),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  #toItem(r: Row): TeamItem {
    const assignee = r.assignee_bot_id ? this.#get('select name from bots where id = ?', r.assignee_bot_id) : undefined;
    const escalation = parseJson<TeamEscalation | null>(r.escalation, null);
    return {
      id: r.id,
      teamId: r.team_id,
      title: r.title,
      detail: r.detail,
      status: r.status,
      assigneeBotId: r.assignee_bot_id ?? null,
      assigneeName: assignee ? String(assignee.name) : null,
      gen: Number(r.gen),
      attempts: Number(r.attempts),
      nudges: Number(r.nudges),
      lifetime: { attempts: Number(r.total_attempts), checkins: Number(r.total_checkins), escalations: Number(r.total_escalations) },
      held: r.held ?? null,
      blockedReason: r.blocked_reason ?? null,
      blockedNeed: r.blocked_need ?? null,
      result: r.result ?? null,
      closedReason: r.closed_reason ?? null,
      closedBy: r.closed_by ?? null,
      waiting: this.#waiting(r, escalation),
      evidence: parseJson<TeamEvidence[]>(r.evidence, []),
      escalation,
      threadId: r.thread_id ?? null,
      nextCheckAt: r.next_check_at ?? null,
      lastActivityAt: r.last_activity_at,
      version: Number(r.version),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at ?? null,
    };
  }

  #toEvent(r: Row): TeamEvent {
    return {
      seq: Number(r.seq),
      teamId: r.team_id,
      itemId: r.item_id ?? null,
      gen: r.gen === null || r.gen === undefined ? null : Number(r.gen),
      kind: r.kind,
      actor: { kind: r.actor_kind, botId: r.actor_bot_id ?? null, name: r.actor_name },
      detail: r.detail,
      at: r.at,
    };
  }

  /** What the supervisor knows about an item's assignee and its work now (the engine's state and the database). */
  facts(r: Row): AssessFacts {
    const team = this.#get('select state from teams where id = ?', r.team_id);
    const botId = r.assignee_bot_id ? String(r.assignee_bot_id) : null;
    const bot = botId ? this.#get('select paused, provider from bots where id = ?', botId) : undefined;
    const status = botId && bot ? this.host.statusOf(botId).state : 'idle';
    const assignee: AssessFacts['assignee'] = !botId || !bot ? 'missing' : bot.paused || this.#store.pausedReason(botId) ? 'paused' : status === 'working' ? 'running' : status === 'queued' ? 'queued' : 'idle';
    const requestOpen = !!this.#get("select 1 from team_deliveries where item_id = ? and item_gen = ? and to_bot_id = ? and state in ('queued', 'dispatched') limit 1", r.id, r.gen, botId ?? '');
    // The owner's answer it waits on: an approval asked in one of the assignee's turns that started while this
    // assignment was current; or, since then (messages carry no turn, so their time stands in for it), a card it posted
    // and the owner hasn't answered, or its browser handed to the owner (asked for and not expired, or taken and not yet
    // handed back). One from older work, or about something else before this assignment, holds nothing.
    const since = String(r.gen_started_at);
    const now = this.#iso();
    const waitingOwner =
      !!botId &&
      (!!this.#get(
        "select 1 from approvals a join turns t on t.id = a.turn_id where a.bot_id = ? and a.status = 'pending' and t.bot_id = a.bot_id and t.started_at >= ? limit 1",
        botId,
        since,
      ) ||
        // One scan of its messages for both (the time test first, so older messages aren't parsed).
        !!this.#get(
          `select 1 from messages where bot_id = ? and role = 'event' and created_at >= ? and (
             (json_extract(meta, '$.kind') = 'card.posted' and json_extract(meta, '$.teamId') is null
               and json_extract(meta, '$.card.status') = 'pending' and json_extract(meta, '$.card.expiresAt') > ?)
             or (json_extract(meta, '$.kind') = 'browser.handoff'
               and (json_extract(meta, '$.browserHandoff.state') = 'taken'
                 or (json_extract(meta, '$.browserHandoff.state') = 'requested' and json_extract(meta, '$.browserHandoff.expiresAt') > ?)))) limit 1`,
          botId,
          since,
          now,
          now,
        ));
    // A teammate that is paused answers nothing until it resumes: asking it holds nothing.
    const teammateAsked = this.#all(
      "select d.to_bot_id from team_deliveries d join team_messages m on m.id = d.message_id where m.item_id = ? and m.from_bot_id = ? and d.state in ('queued', 'dispatched')",
      r.id,
      botId ?? '',
    ).some((d) => !this.#store.pausedReason(String(d.to_bot_id)));
    return {
      assignee,
      requestOpen,
      waitingOwner,
      usageLimitUntil: bot ? this.host.usageLimitUntil(String(bot.provider)) : null,
      teammateAsked,
      teamPaused: team?.state !== 'active',
    };
  }

  /** What an item waits on that is not a stall (the board's words), from the same facts and order the supervisor reads. */
  #waiting(r: Row, escalation: TeamEscalation | null): TeamItemWaiting | null {
    if (r.status === 'done' || r.status === 'cancelled') return null;
    if (r.held) return 'held';
    const f = this.facts(r);
    if (f.teamPaused) return 'team_paused';
    if (escalation) return 'owner';
    if (r.status !== 'blocked') {
      if (f.assignee === 'paused') return 'paused';
      if (f.usageLimitUntil && Date.parse(f.usageLimitUntil) > this.#clock()) return 'usage_limit';
    }
    // Past its age bound, nothing going on is a reason to wait (shared/teams.ts assess).
    if (r.status !== 'blocked' && f.assignee !== 'missing' && this.#clock() - Date.parse(r.gen_started_at) >= TEAM_LIMITS.genOverdueMs) return null;
    if (f.waitingOwner) return 'approval';
    if (r.status === 'blocked') return null;
    if (f.assignee === 'running' || f.assignee === 'queued' || f.requestOpen) return 'running';
    if (f.teammateAsked) return 'teammate';
    return null;
  }

  #publishTeam(id: string): void {
    const t = this.#get('select * from teams where id = ?', id);
    if (t) this.#store.publish({ type: 'team.upserted', team: this.#toTeam(t) });
    this.#publishAttention();
  }

  #publishAttention(): void {
    this.#store.publish({ type: 'teams.attention', attention: this.attention() });
  }

  #publishItem(id: string): void {
    const r = this.#get('select * from team_items where id = ?', id);
    if (r) this.#store.publish({ type: 'team.item.upserted', item: this.#toItem(r) });
  }

  /**
   * A row of what happened to a team or an item. Returns its seq. `wake`: its lead hears of it at the next check-in;
   * `origin` is then the check-in that told it (checkinPrompt), so a re-run of that turn is told the same.
   */
  #event(
    teamId: string,
    itemId: string | null,
    gen: number | null,
    kind: TeamEventKind,
    actor: Actor,
    detail: string,
    opts: { wake?: boolean; idem?: string | null; origin?: string | null; fromGen?: number | null; actorOrigin?: string | null } = {},
  ): number {
    const d = detail.length > 600 ? `${detail.slice(0, 599)}…` : detail;
    const res = this.#run(
      'insert into team_events (team_id, item_id, gen, kind, actor_kind, actor_bot_id, actor_name, detail, wake, idem_key, origin_key, from_gen, actor_origin, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      teamId,
      itemId,
      gen,
      kind,
      actor.kind,
      actor.botId,
      actor.name,
      d,
      opts.wake ? 1 : 0,
      opts.idem ?? null,
      opts.origin ?? null,
      opts.fromGen ?? null,
      opts.actorOrigin ?? null,
      this.#iso(),
    );
    return Number(res.lastInsertRowid);
  }

  /**
   * The items a Boton holds in a team go back to open and unassigned (it left, or was deleted): a new gen, so whatever
   * its turns still do about them changes nothing.
   */
  #unassign(botId: string, teamId: string, kind: 'unavailable', why: string): void {
    for (const r of this.#all("select * from team_items where team_id = ? and assignee_bot_id = ? and status in ('open', 'working', 'blocked')", teamId, botId)) {
      const gen = Number(r.gen) + 1;
      this.#recallItem(r.id, Number(r.gen));
      this.#run(
        `update team_items set status = 'open', assignee_bot_id = null, gen = ?, gen_started_at = ?, nudges = 0, blocked_reason = null, blocked_need = null,
           evidence = '[]', escalation = null, next_check_at = ?, last_activity_at = ?, version = version + 1, updated_at = ? where id = ?`,
        gen,
        this.#iso(),
        this.#iso(),
        this.#iso(),
        this.#iso(),
        r.id,
      );
      this.#event(teamId, r.id, gen, kind, { kind: 'server', botId: null, name: 'Botons' }, why, { wake: true });
      this.#addEvidence(r.id, { kind, gen, detail: why, at: this.#iso() });
      this.#publishItem(r.id);
    }
  }

  /**
   * Retention: each item's newest eventsPerItem and each team's newest eventsPerTeam events stay, and never one of an
   * item's current gen (the gates read the counters and evidence on the item row, so nothing they need goes), and
   * never one of the last day (the daily budgets count check-ins and escalations from these rows).
   */
  pruneEvents(): number {
    let n = 0;
    const kept = this.#iso(this.#clock() - 24 * HOUR);
    for (const r of this.#all('select item_id from team_events where item_id is not null group by item_id having count(*) > ?', TEAM_LIMITS.eventsPerItem)) {
      n += Number(
        this.#run(
          `delete from team_events where item_id = ? and seq < (select seq from team_events where item_id = ? order by seq desc limit 1 offset ?)
             and gen is not (select gen from team_items where id = ?) and at <= ?`,
          r.item_id,
          r.item_id,
          TEAM_LIMITS.eventsPerItem - 1,
          r.item_id,
          kept,
        ).changes,
      );
    }
    for (const r of this.#all('select team_id from team_events group by team_id having count(*) > ?', TEAM_LIMITS.eventsPerTeam)) {
      n += Number(
        this.#run(
          `delete from team_events where team_id = ? and seq < (select seq from team_events where team_id = ? order by seq desc limit 1 offset ?)
             and not exists (select 1 from team_items i where i.id = team_events.item_id and i.gen = team_events.gen) and at <= ?`,
          r.team_id,
          r.team_id,
          TEAM_LIMITS.eventsPerTeam - 1,
          kept,
        ).changes,
      );
    }
    return n;
  }

  /** The not-started requests of an item's gen: recalled. */
  #recallItem(itemId: string, gen: number): void {
    const ids = this.#all("select message_id from team_deliveries where item_id = ? and item_gen = ? and state in ('queued', 'dispatched')", itemId, gen).map((r) => String(r.message_id));
    if (ids.length) this.recall({ messageIds: ids });
  }

  /** What a Boton that left a team had asked in it, not yet started: recalled. */
  #recallFrom(botId: string, teamId: string): void {
    const ids = this.#all(
      "select d.message_id from team_deliveries d join team_messages m on m.id = d.message_id where m.team_id = ? and (d.to_bot_id = ? or m.from_bot_id = ?) and d.state in ('queued', 'dispatched')",
      teamId,
      botId,
      botId,
    ).map((r) => String(r.message_id));
    if (ids.length) this.recall({ messageIds: ids });
  }

  #addEvidence(itemId: string, fact: TeamEvidence): void {
    const r = this.#get('select evidence, gen from team_items where id = ?', itemId);
    if (!r) return;
    const list = parseJson<TeamEvidence[]>(r.evidence, []).filter((e) => e.gen === Number(r.gen));
    list.push(fact);
    this.#run('update team_items set evidence = ? where id = ?', JSON.stringify(list.slice(-TEAM_LIMITS.evidenceMax)), itemId);
  }

  /** Paused by a budget or for want of a lead: nothing dispatches, what had not started goes back to the queue. One push. */
  #pauseTeam(teamId: string, reason: TeamPausedReason, why: string): void {
    const t = this.#teamRow(teamId);
    if (t.state !== 'active') return;
    this.#run("update teams set state = 'paused', paused_reason = ?, inactive_since = ?, version = version + 1, updated_at = ? where id = ?", reason, this.#iso(), this.#iso(), teamId);
    this.recall({ teamId }, true);
    this.publishOpen({ teamId });
    this.#event(teamId, null, null, 'team_paused', { kind: reason === 'owner' || reason === 'stopped' ? 'owner' : 'server', botId: null, name: reason === 'owner' || reason === 'stopped' ? this.#owner() : 'Botons' }, why);
    this.#publishTeam(teamId);
    if (reason === 'budget' || reason === 'no_lead') {
      const lead = this.#leadOf(teamId);
      const text = reason === 'budget' ? `Team ${t.name} paused: ${why}.` : `Team ${t.name} paused: ${why}.`;
      if (lead) this.#store.addMessage(String(lead.bot_id), 'event', text, { kind: 'team.notice', teamId, teamName: String(t.name) });
      this.#store.afterCommit(() =>
        this.host.push({
          bot: lead ? { id: String(lead.bot_id), name: String(lead.name) } : null,
          reason: 'team',
          detail: `${t.name}: ${why}`,
          generic: 'A team needs you.',
          priority: 'default',
          teamId,
        }),
      );
      log.info('team paused', { teamId, reason });
    }
  }

  /** Active again: what waited dispatches in order, and every item's clock starts again, so a pause never reads as a stall. */
  #resumeTeam(teamId: string, actor: Actor): void {
    const t = this.#teamRow(teamId);
    const limits = this.#limits(t);
    const now = this.#clock();
    // Paused time counts toward no clock: the stall, the start and the age bound of every live item.
    const pausedFor = t.inactive_since ? Math.max(0, now - Date.parse(String(t.inactive_since))) : 0;
    this.#run("update teams set state = 'active', paused_reason = null, kickoff_told_at = null, resumed_at = ?, inactive_since = null, version = version + 1, updated_at = ? where id = ?", this.#iso(now), this.#iso(now), teamId);
    for (const r of this.#all("select id, status, gen_started_at from team_items where team_id = ? and status in ('open', 'working', 'blocked')", teamId)) {
      const genStarted = r.status === 'open' ? now : Math.min(now, Date.parse(String(r.gen_started_at)) + pausedFor);
      this.#run('update team_items set next_check_at = ?, last_activity_at = ?, gen_started_at = ? where id = ?', this.#iso(now + limits.stallAfterMs), this.#iso(now), this.#iso(genStarted), r.id);
    }
    this.#event(teamId, null, null, 'team_resumed', actor, '');
    this.publishOpen({ teamId });
    for (const r of this.#all("select distinct d.to_bot_id from team_deliveries d join team_messages m on m.id = d.message_id where m.team_id = ? and d.state = 'queued'", teamId)) {
      this.#store.afterCommit(() => this.dispatch(String(r.to_bot_id)));
    }
    this.#publishTeam(teamId);
  }

  // ------------------------------------------------------------------ items

  /**
   * The item gens a turn may act on, taken as it starts: the gen each assignment it answers names, then the current
   * gen of every item it holds or leads. Only its own successful actions change it afterwards (see scopeRefusal), so
   * a turn of an assignment that was replaced, or a lead's turn about an item that moved on, can't move the item.
   */
  turnScope(botId: string, pending: Message[]): TurnScope {
    const scope: TurnScope = new Map();
    for (const m of pending) {
      if (m.meta?.kind !== 'ask' || !m.meta.itemId || m.meta.itemGen === undefined) continue;
      scope.set(m.meta.itemId, Math.max(m.meta.itemGen, scope.get(m.meta.itemId) ?? -1));
    }
    const rows = this.#all(
      `select i.id, i.gen from team_items i join teams t on t.id = i.team_id where t.state <> 'archived' and (i.assignee_bot_id = ?
         or i.team_id in (select team_id from team_members where bot_id = ? and role = 'lead'))`,
      botId,
      botId,
    );
    for (const r of rows) if (!scope.has(String(r.id))) scope.set(String(r.id), Number(r.gen));
    return scope;
  }

  #item(id: string): Row {
    const r = this.#get('select * from team_items where id = ?', id);
    if (!r) throw new HttpError(404, `No item ${id}`);
    return r;
  }

  item(id: string): TeamItemDetail {
    const r = this.#item(id);
    return { item: this.#toItem(r), events: this.#all('select * from team_events where item_id = ? order by seq desc limit 100', id).map((e) => this.#toEvent(e)) };
  }

  /** A Boton's own view of an item: only of a team it holds a seat in. */
  itemFor(botId: string, id: string): TeamItemDetail {
    const r = this.#item(id);
    if (!this.#seat(r.team_id, botId)) throw new HttpError(403, `You hold no seat in ${id}'s team.`);
    return this.item(id);
  }

  /** A Boton's seats, each with its team, and its items there (all of them for a team it leads). */
  botView(botId: string): BotTeamsView {
    this.#store.getBot(botId);
    const seats = this.#all(
      "select m.*, t.id as tid from team_members m join teams t on t.id = m.team_id where m.bot_id = ? and t.state <> 'archived' order by t.created_at, t.id",
      botId,
    );
    return {
      teams: seats.map((m) => ({
        team: this.get(String(m.tid)),
        role: m.role,
        roleTitle: m.role_title,
        responsibilities: m.responsibilities,
        items: this.#all(
          m.role === 'lead' ? 'select * from team_items where team_id = ? order by created_at, id' : 'select * from team_items where team_id = ? and assignee_bot_id = ? order by created_at, id',
          ...(m.role === 'lead' ? [m.tid] : [m.tid, botId]),
        ).map((r) => this.#toItem(r)),
      })),
    };
  }

  /** A team's board, to a Boton that holds a seat in it. */
  boardFor(botId: string, teamRef: string): TeamDetail {
    const t = this.teamByRef(teamRef);
    if (!t || t.state === 'archived') throw new HttpError(404, `No team ${teamRef}`);
    if (!this.#seat(t.id, botId)) throw new HttpError(403, `You hold no seat in team ${t.name}.`);
    return this.detail(String(t.id));
  }

  /** The identity of a Boton's action: the same action with the same input, from the same work, applies once. */
  #actionKey(actor: TeamActorRef, action: string, args: unknown, key: string | undefined): string | null {
    if (actor.owner) return key ? `owner:${key}` : null;
    const turn = this.host.turn(actor.botId);
    const origin = turn?.origin ?? turn?.turnId ?? null;
    if (!origin) return null;
    return `${actor.botId}:${origin}:${action}:${key ?? sha(JSON.stringify(args))}`;
  }

  /** The owner adds, assigns, retries or reopens only in a team that can deliver: not an archived or finished one. */
  #ownerMaySend(t: Row): void {
    if (t.state === 'archived') throw refusal('team_not_active', `Team ${t.name} is archived: restore the team first.`);
    if (t.state === 'done') throw refusal('team_not_active', `Team ${t.name} is finished: reopen the team first.`);
  }

  /** The Boton's turn scope, or a refusal: a team action is taken during a turn, never by a sandboxed one. */
  #scopeOf(botId: string): TurnScope | null {
    return this.host.turn(botId)?.scope ?? null;
  }

  #actorName(actor: TeamActorRef): Actor {
    return actor.owner ? this.#ownerActor() : { kind: 'boton', botId: actor.botId, name: this.#botName(actor.botId) };
  }

  /** The lead's (or the owner's) new item; with an assignee it is assigned at once (attempt 1). */
  addItem(teamRef: string, input: unknown, actor: TeamActorRef): TeamItemActionResult {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const name = title(o.title, 'title', TEAM_TEXT.itemTitle);
    const detail = prose(o.detail, 'detail', TEAM_TEXT.itemDetail);
    const assignee = o.assigneeBotId === undefined || o.assigneeBotId === null || o.assigneeBotId === '' ? null : o.assigneeBotId;
    if (assignee !== null && typeof assignee !== 'string') throw new HttpError(400, 'assigneeBotId must be a Boton id');
    const key = optional(o, 'key', TEAM_TEXT.key);
    const t = this.teamByRef(teamRef);
    if (!t || (t.state === 'archived' && !actor.owner)) throw new HttpError(404, `No team ${teamRef}`);
    if (!actor.owner) {
      const seat = this.#seat(t.id, actor.botId);
      if (!seat) throw new HttpError(403, `You hold no seat in team ${t.name}.`);
      if (seat.role !== 'lead') throw refusal('not_allowed', `Only the lead (or ${this.#owner()}) adds items to team ${t.name}.`, 403);
      if (t.state !== 'active') throw refusal('team_not_active', `Team ${t.name} is ${t.state}: only ${this.#owner()} changes its work now.`);
      if (!this.#scopeOf(actor.botId)) throw refusal('not_in_turn', 'Team actions are taken during a turn, with `botons team`.');
    } else this.#ownerMaySend(t);
    const idem = this.#actionKey(actor, 'add', { name, detail, assignee }, key);
    if (idem) {
      const prev = this.#get("select item_id from team_events where team_id = ? and kind = 'created' and idem_key = ?", t.id, idem);
      if (prev) return { item: this.#toItem(this.#item(String(prev.item_id))), duplicate: true };
    }
    if (assignee && !this.#seat(t.id, assignee)) throw new HttpError(400, `${this.#botName(assignee)} holds no seat in team ${t.name}`);
    if (!actor.owner) {
      const today = Number(this.#get("select count(*) as n from team_items where team_id = ? and created_by <> 'owner' and created_at > ?", t.id, this.#iso(this.#clock() - 24 * HOUR))!.n);
      if (today >= TEAM_LIMITS.itemsPerTeamPerDay) {
        throw refusal('limit', `Team ${t.name} has had ${TEAM_LIMITS.itemsPerTeamPerDay} items added today, the limit for its Botons: finish or reuse what is there, or ask ${this.#owner()} to add it.`, 429);
      }
      if (assignee) this.#assignmentBudget(t, assignee, `“${name}” was not added`);
    }
    const id = this.#store.atomically(() => {
      const live = Number(this.#get("select count(*) as n from team_items where team_id = ? and status in ('open', 'working', 'blocked')", t.id)!.n);
      if (live >= TEAM_LIMITS.openItemsPerTeam) throw refusal('limit', `Team ${t.name} has ${TEAM_LIMITS.openItemsPerTeam} open items, the limit: finish or cancel some first.`);
      const id = newId('item');
      const now = this.#clock();
      const limits = this.#limits(t);
      this.#run(
        `insert into team_items (id, team_id, title, detail, status, gen, gen_started_at, next_check_at, last_activity_at, created_by, created_at, updated_at)
           values (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, ?, ?)`,
        id,
        t.id,
        name,
        detail,
        this.#iso(now),
        this.#iso(now + limits.startWithinMs),
        this.#iso(now),
        actor.owner ? 'owner' : actor.botId,
        this.#iso(now),
        this.#iso(now),
      );
      this.#event(t.id, id, 0, 'created', this.#actorName(actor), name, { idem });
      if (assignee) this.#apply(this.#item(id), 'assign', { assigneeBotId: assignee }, actor, null);
      // The turn's own item, at the gen its own assignment made.
      if (!actor.owner) this.#scopeOf(actor.botId)?.set(id, Number(this.#item(id).gen));
      if (actor.owner) this.#record(actor.by, 'team.item_overridden', { id: t.id, name: String(t.name) }, { item: id, action: 'add' });
      else this.host.chip(actor.botId, `Added ${name}`, { kind: 'team.update', teamId: t.id, teamName: String(t.name), itemId: id, itemTitle: name, itemStatus: 'open' });
      this.#publishItem(id);
      this.#publishTeam(t.id);
      return id;
    });
    return { item: this.#toItem(this.#item(id)), duplicate: false };
  }

  /**
   * One item action, by the owner or a Boton (shared/teams.ts says who may do what, from which status). A Boton's is
   * checked against its turn's scope first, so one about an assignment that moved on changes nothing.
   */
  act(itemId: string, input: unknown, actor: TeamActorRef): TeamItemActionResult {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const action = o.action as TeamItemAction;
    if (!ITEM_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${ITEM_ACTIONS.join(', ')}`);
    const args = {
      ...(o.assigneeBotId !== undefined ? { assigneeBotId: o.assigneeBotId } : {}),
      ...(o.reason !== undefined ? { reason: prose(o.reason, 'reason', TEAM_TEXT.reason) } : {}),
      ...(o.need !== undefined ? { need: o.need } : {}),
      ...(o.result !== undefined ? { result: prose(o.result, 'result', TEAM_TEXT.result) } : {}),
      ...(o.note !== undefined ? { note: prose(o.note, 'note', TEAM_TEXT.note) } : {}),
    } as Record<string, unknown>;
    const key = optional(o, 'key', TEAM_TEXT.key);
    const r = this.#item(itemId);
    const t = this.#teamRow(r.team_id);
    if (!actor.owner && !this.#seat(t.id, actor.botId)) throw new HttpError(403, `You hold no seat in team ${t.name}.`);
    const idem = this.#actionKey(actor, action, args, key);
    if (idem) {
      const prev = this.#get('select 1 from team_events where item_id = ? and idem_key = ?', itemId, idem);
      if (prev) return { item: this.#toItem(r), duplicate: true };
    }
    // An archived or finished team delivers nothing: the owner's work that would send or reopen waits for it to be active.
    if (actor.owner && (ITEM_TRANSITIONS[action].sends || action === 'reopen')) this.#ownerMaySend(t);
    if (actor.owner && o.version !== undefined && o.version !== Number(r.version)) {
      throw refusal('stale_version', `${itemId} changed since you loaded it (now version ${r.version}). Load it again and retry.`);
    }
    const lead = this.#leadOf(t.id);
    const role: TeamActor = actorFor({ owner: actor.owner, botId: actor.owner ? null : actor.botId, leadBotId: lead ? String(lead.bot_id) : null, assigneeBotId: r.assignee_bot_id ?? null });
    const view = this.#toItem(r);
    if (!actor.owner) {
      const scoped = scopeRefusal(this.#scopeOf(actor.botId), view, role);
      if (scoped) throw refused(scoped);
      if (ITEM_TRANSITIONS[action].sends || action === 'assign') {
        // A Boton's action that would loop past a lifetime bound waits for the owner instead.
        if (view.lifetime.attempts >= TEAM_LIFETIME.attempts) this.#holdForOwner(r, 'attempts');
      }
    }
    // The same transition again: the item as it is, nothing more (start, block, done, cancel are idempotent).
    if ((action === 'start' && r.status === 'working') || (action === 'block' && r.status === 'blocked') || (action === 'done' && r.status === 'done') || (action === 'cancel' && r.status === 'cancelled')) {
      return { item: view, duplicate: true };
    }
    const why = transitionRefusal(action, role, { ...view, progressNotes: Number(r.progress_notes) }, {
      teamState: t.state,
      maxAttempts: this.#limits(t).maxAttempts,
      leadIsAssignee: !!lead && lead.bot_id === r.assignee_bot_id,
      input: args,
    });
    if (why) throw refused(why, why.code === 'not_allowed' && !t.state ? 400 : 409);
    if (action === 'assign') {
      if (typeof args.assigneeBotId !== 'string' || !this.#seat(t.id, args.assigneeBotId)) throw new HttpError(400, `The assignee must hold a seat in team ${t.name}`);
      if (!lead) throw refusal('not_allowed', `Team ${t.name} has no lead to send the assignment for: give it one first.`);
    }
    if (action === 'retry' && !r.assignee_bot_id) throw refusal('not_allowed', `${itemId} has no assignee to try again: assign it.`);
    if (!actor.owner && (action === 'assign' || action === 'retry')) {
      const to = action === 'assign' ? String(args.assigneeBotId) : String(r.assignee_bot_id);
      this.#assignmentBudget(t, to, action === 'assign' ? `${itemId} was not assigned to ${this.#botName(to)}` : `${itemId} was not retried`, itemId);
    }
    const after = this.#store.atomically(() => {
      this.#apply(r, action, args, actor, idem);
      if (actor.owner) this.#record(actor.by, 'team.item_overridden', { id: t.id, name: String(t.name) }, { item: itemId, action });
      const now = this.#item(itemId);
      if (!actor.owner) {
        // The turn's own action: its scope follows the gen it made.
        this.#scopeOf(actor.botId)?.set(itemId, Number(now.gen));
        this.host.chip(actor.botId, `${ACTION_WORDS[action]} ${now.title}`, { kind: 'team.update', teamId: t.id, teamName: String(t.name), itemId, itemTitle: String(now.title), itemStatus: now.status });
      }
      this.#publishItem(itemId);
      this.#publishTeam(t.id);
      return now;
    });
    return { item: this.#toItem(after), duplicate: false };
  }

  /**
   * A Boton's assignment (assign, retry, or an item added with an assignee) is a request like an ask, under the same
   * bounds: refused while its recipient has recipientBacklog waiting, or once the team has sent its hour's or its day's
   * messages (past the day's, the team pauses, with one notice). Assignments count toward those budgets; the owner's
   * own are not refused. `what` begins the refusal: "item_x was not assigned to Stuart".
   */
  #assignmentBudget(t: Row, toId: string, what: string, itemId: string | null = null): void {
    const lead = this.#leadOf(String(t.id));
    // The lead holding its own item is sent nothing.
    if (!lead || lead.bot_id === toId) return;
    // The item's own earlier request is recalled by the new one, so it doesn't count.
    const own = itemId ? Number(this.#get("select count(*) as n from team_deliveries where to_bot_id = ? and item_id = ? and state in ('queued', 'dispatched')", toId, itemId)!.n) : 0;
    const backlog = this.#openFor(toId) - own;
    if (backlog >= TEAM_LIMITS.recipientBacklog) {
      throw new HttpError(429, `${what}: ${this.#botName(toId)} has ${backlog} messages waiting, the limit. Try again later, or give it to someone else.`, { 'retry-after': '300' }, 'limit');
    }
    const now = this.#clock();
    if (this.#teamMessages(String(t.id), now - HOUR) >= TEAM_LIMITS.messagesPerTeamPerHour) {
      throw refusal('limit', `${what}: team ${t.name} has sent ${TEAM_LIMITS.messagesPerTeamPerHour} messages in the last hour, the limit. Try again later.`, 429);
    }
    const perDay = this.#limits(t).messagesPerDay;
    if (this.#teamMessages(String(t.id), this.#dayFrom(t, now)) >= perDay) {
      const teamId = String(t.id);
      this.#store.atomically(() => this.#pauseTeam(teamId, 'budget', `it sent ${perDay} messages today, its daily budget`));
      throw refusal('limit', `${what}: team ${t.name} has sent ${perDay} messages today, its budget, so it is paused until ${this.#owner()} resumes it.`, 429);
    }
  }

  /** Past a lifetime bound: the item waits for the owner, with one attention entry and no more check-ins. */
  #holdForOwner(r: Row, what: string): never {
    this.#store.atomically(() => {
      if (!r.held) {
        this.#run("update team_items set held = 'owner', version = version + 1, updated_at = ? where id = ?", this.#iso(), r.id);
        this.#event(r.team_id, r.id, Number(r.gen), 'held', { kind: 'server', botId: null, name: 'Botons' }, `lifetime ${what}`);
        this.#publishItem(r.id);
        this.#publishTeam(r.team_id);
      }
    });
    throw refusal('limit', `${r.id} reached its lifetime limit of ${what}: it waits for ${this.#owner()} now.`);
  }

  /** In the caller's transaction: the action's change to the item, its event, and what it sends or recalls. */
  #apply(r: Row, action: TeamItemAction, args: Record<string, unknown>, actor: TeamActorRef, idem: string | null): void {
    const t = this.#teamRow(r.team_id);
    const limits = this.#limits(t);
    const now = this.#clock();
    const at = this.#iso(now);
    const who = this.#actorName(actor);
    const gen = Number(r.gen);
    const next = gen + 1;
    const set = (sql: string, ...params: unknown[]) => this.#run(`update team_items set ${sql}, version = version + 1, updated_at = ? where id = ?`, ...params, at, r.id);
    // A Boton's action records the assignment it acted on and the work it came from (see #replyEffect).
    const actorOrigin = actor.owner ? null : (this.host.turn(actor.botId)?.origin ?? null);
    const ev = (kind: TeamEventKind, g: number, detail: string, wake = false) => this.#event(t.id, r.id, g, kind, who, detail, { wake, idem, fromGen: gen, actorOrigin });
    const terminal = () => this.#run('update teams set last_terminal_at = ? where id = ?', at, t.id);
    switch (action) {
      case 'assign':
      case 'retry': {
        const to = action === 'assign' ? String(args.assigneeBotId) : String(r.assignee_bot_id);
        this.#recallItem(r.id, gen);
        set(
          `status = 'open', assignee_bot_id = ?, gen = ?, gen_started_at = ?, attempts = attempts + 1, total_attempts = total_attempts + 1, nudges = 0, held = null,
             blocked_reason = null, blocked_need = null, evidence = '[]', escalation = null, progress_notes = 0, next_check_at = ?, last_activity_at = ?`,
          to,
          next,
          at,
          this.#iso(now + limits.startWithinMs),
          at,
        );
        ev(action === 'assign' ? 'assigned' : 'retry', next, action === 'assign' ? `to ${this.#botName(to)}` : `${this.#botName(to)} again`);
        this.#sendAssignment(this.#item(r.id), typeof args.note === 'string' ? args.note : '');
        return;
      }
      case 'start':
        set("status = 'working', nudges = 0, last_activity_at = ?, next_check_at = ?", at, this.#iso(now + limits.stallAfterMs));
        ev('started', gen, '');
        return;
      case 'progress':
        set('progress_notes = progress_notes + 1, last_activity_at = ?, next_check_at = case when nudges = 0 then ? else next_check_at end', at, this.#iso(now + limits.stallAfterMs));
        ev('progress', gen, String(args.note));
        return;
      case 'block':
        // Keeps the check-in count: a block is a reason, not progress.
        set("status = 'blocked', blocked_reason = ?, blocked_need = ?, last_activity_at = ?, next_check_at = ?", args.reason, args.need, at, this.#iso(now + limits.stallAfterMs));
        ev('blocked', gen, `needs ${args.need === 'owner' ? this.#owner() : 'the lead'}: ${args.reason}`, true);
        this.#addEvidence(r.id, { kind: 'blocked', gen, detail: String(args.reason), at });
        return;
      case 'done': {
        this.#recallItem(r.id, gen);
        set(
          "status = 'done', result = ?, gen = ?, nudges = 0, held = null, escalation = null, closed_by = ?, closed_at = ?, next_check_at = null, last_activity_at = ?",
          args.result,
          next,
          actor.owner ? 'owner' : actor.botId,
          at,
          at,
        );
        // The lead reviews what its assignee finished.
        const byAssignee = !actor.owner && actor.botId === r.assignee_bot_id && actor.botId !== this.#leadOf(t.id)?.bot_id;
        ev('done', next, String(args.result), byAssignee);
        terminal();
        return;
      }
      case 'cancel':
        this.#recallItem(r.id, gen);
        set(
          "status = 'cancelled', closed_reason = ?, closed_by = ?, gen = ?, held = null, escalation = null, closed_at = ?, next_check_at = null, last_activity_at = ?",
          args.reason,
          actor.owner ? 'owner' : actor.botId,
          next,
          at,
          at,
        );
        ev('cancelled', next, String(args.reason));
        terminal();
        return;
      case 'reopen':
        set(
          `status = 'open', assignee_bot_id = null, gen = ?, gen_started_at = ?, nudges = 0, result = null, closed_reason = null, closed_by = null, closed_at = null,
             blocked_reason = null, blocked_need = null, evidence = '[]', escalation = null, progress_notes = 0, next_check_at = ?, last_activity_at = ?`,
          next,
          at,
          this.#iso(now + limits.startWithinMs),
          at,
        );
        ev('reopened', next, '');
        return;
    }
  }

  /**
   * The assignee's request in the item's thread, from the lead, keyed by its cause (the item's gen): two attempts
   * with the same words are two requests. The lead holding its own item gets none.
   */
  #sendAssignment(r: Row, note: string): void {
    const lead = this.#leadOf(r.team_id);
    const to = String(r.assignee_bot_id);
    if (!lead || lead.bot_id === to || !this.#store.hasBot(to)) return;
    let threadId = r.thread_id ? String(r.thread_id) : null;
    const thread = threadId ? this.#thread(threadId) : undefined;
    if (!thread || thread.message_count >= TEAM_LIMITS.messagesPerThread) {
      threadId = newId('thr');
      this.#run('update team_items set thread_id = ? where id = ?', threadId, r.id);
    }
    const parts = [String(r.title), r.detail ? String(r.detail) : '', note ? `Note: ${note}` : ''].filter(Boolean);
    this.#request({
      threadId: threadId!,
      thread: thread && thread.id === threadId ? thread : null,
      subject: String(r.title),
      teamId: r.team_id,
      itemId: r.id,
      itemGen: Number(r.gen),
      from: { id: String(lead.bot_id), name: String(lead.name) },
      to: { id: to, name: this.#botName(to) },
      text: parts.join('\n\n'),
      hop: 1,
      turnId: null,
      origin: null,
      idem: `item:${r.id}:gen:${r.gen}`,
      assignment: true,
    });
  }

  // ------------------------------------------------------------------ the supervisor

  /**
   * One supervisor tick (team-supervisor.ts runs it; it never calls a model): expire, dispatch as a safety net, then
   * per active team look at every item whose next_check_at has passed (shared/teams.ts assess) and at the team as a
   * whole (assessTeam: kickoff, all done), and wake its lead with one check-in when something needs it, within the
   * team's check-in budgets. Returns what it did, for tests and the log.
   */
  supervise(): { checkins: number; escalations: number } {
    const out = { checkins: 0, escalations: 0 };
    this.expireDue();
    this.dispatchAll();
    if (this.#clock() - this.#prunedAt > HOUR) {
      this.#prunedAt = this.#clock();
      this.pruneEvents();
    }
    for (const t of this.#all("select * from teams where state = 'active' order by created_at, id")) {
      try {
        const r = this.#superviseTeam(String(t.id));
        out.checkins += r.checkin ? 1 : 0;
        out.escalations += r.escalations;
      } catch (err) {
        log.error('could not supervise a team', { teamId: t.id, err });
      }
    }
    return out;
  }

  #prunedAt = 0;

  #superviseTeam(teamId: string): { checkin: boolean; escalations: number } {
    return this.#store.atomically(() => {
      const t = this.#teamRow(teamId);
      const limits = this.#limits(t);
      const now = this.#clock();
      const lead = this.#leadOf(teamId);
      if (!lead) {
        this.#pauseTeam(teamId, 'no_lead', 'it has no lead');
        return { checkin: false, escalations: 0 };
      }
      // A paused lead (or every Boton paused) holds the team for this tick: nothing changes, its items stay due, and
      // the next tick after the resume picks them up. Never a state change or a push.
      if (lead.paused || this.#store.pausedReason(String(lead.bot_id))) return { checkin: false, escalations: 0 };
      // So does a lead held by its provider's usage limit: a check-in it can't run counts no nudge.
      const limited = this.host.usageLimitUntil(String(lead.provider));
      if (limited && Date.parse(limited) > now) return { checkin: false, escalations: 0 };
      const due: { r: Row; reason: string }[] = [];
      const escalate: Row[] = [];
      for (const r of this.#all("select * from team_items where team_id = ? and status in ('open', 'working', 'blocked') and next_check_at is not null and next_check_at <= ?", teamId, this.#iso(now))) {
        const a = assess(
          {
            status: r.status,
            assigneeBotId: r.assignee_bot_id ?? null,
            nudges: Number(r.nudges),
            lastActivityAt: r.last_activity_at,
            held: r.held ?? null,
            escalation: parseJson<TeamEscalation | null>(r.escalation, null),
            lifetime: { attempts: Number(r.total_attempts), checkins: Number(r.total_checkins), escalations: Number(r.total_escalations) },
            genStartedAt: r.gen_started_at,
          },
          this.facts(r),
          now,
          limits,
        );
        if (a.kind === 'none') this.#run('update team_items set next_check_at = null where id = ?', r.id);
        else if (a.kind === 'hold' || a.kind === 'wait') this.#run('update team_items set next_check_at = ? where id = ?', a.at, r.id);
        else if (a.kind === 'checkin') due.push({ r, reason: a.reason });
        else if (a.kind === 'escalate') escalate.push(r);
        else this.#holdItem(r, 'It reached a lifetime limit of check-ins or escalations: it waits for the owner now');
      }
      const escalations = this.#escalateDue(t, escalate);
      // The escalation budget may have paused it just now: then nothing more this tick.
      if (this.#teamRow(teamId).state !== 'active') return { checkin: false, escalations };
      const untold = Number(this.#get('select count(*) as n from team_events where team_id = ? and wake = 1 and told_at is null and origin_key is null', teamId)!.n);
      const counts = Object.fromEntries(STATUSES.map((st) => [st, 0])) as Record<TeamItemStatus, number>;
      for (const c of this.#all('select status, count(*) as n from team_items where team_id = ? group by status', teamId)) counts[c.status as TeamItemStatus] = Number(c.n);
      const whole = assessTeam({ state: t.state, counts, kickoffToldAt: t.kickoff_told_at ?? null, wrapupToldAt: t.wrapup_told_at ?? null, lastTerminalAt: t.last_terminal_at ?? null });
      if (!due.length && !untold && !whole) return { checkin: false, escalations };

      // Reasons merge only into a check-in that waits, not started, in the chat of the lead now.
      const waiting = t.checkin_message_id ? this.#get('select id from messages where id = ? and pending = 1 and bot_id = ?', t.checkin_message_id, lead.bot_id) : undefined;
      if (!waiting) {
        // A new wake of the lead counts against the team's budgets; merging into one that has not started doesn't.
        const sent = (since: number) => Number(this.#get("select count(*) as n from team_events where team_id = ? and kind = 'checkin' and item_id is null and at > ?", teamId, this.#iso(since))!.n);
        // Each item it would have told of is looked at again when a check-in may go (a resume starts every clock).
        const later = (at: number) => {
          for (const { r } of due) this.#run('update team_items set next_check_at = ? where id = ?', this.#iso(Math.max(at, now + 1000)), r.id);
        };
        if (sent(this.#dayFrom(t, now)) >= limits.checkinsPerDay) {
          this.#pauseTeam(teamId, 'budget', `its lead was checked in with ${limits.checkinsPerDay} times today, its daily budget`);
          later(now + limits.stallAfterMs);
          return { checkin: false, escalations };
        }
        // Over the hour's budget: left for when the hour's oldest check-in drops out of it (the events stay untold).
        if (sent(now - HOUR) >= TEAM_LIMITS.checkinsPerTeamPerHour) {
          const oldest = this.#get("select min(at) as at from team_events where team_id = ? and kind = 'checkin' and item_id is null and at > ?", teamId, this.#iso(now - HOUR))!.at;
          later(Date.parse(String(oldest)) + HOUR + 1000);
          return { checkin: false, escalations };
        }
      }
      for (const { r, reason } of due) {
        const nudges = Number(r.nudges) + 1;
        const kind: TeamEventKind = reason === 'unassigned' ? 'not_started' : (reason as TeamEventKind);
        const why = this.#reasonText(r, reason, now);
        this.#run(
          'update team_items set nudges = ?, total_checkins = total_checkins + 1, next_check_at = ?, version = version + 1, updated_at = ? where id = ?',
          nudges,
          this.#iso(now + afterCheckinMs(nudges, limits)),
          this.#iso(now),
          r.id,
        );
        this.#event(teamId, r.id, Number(r.gen), kind, SERVER, why, { wake: true });
        this.#addEvidence(r.id, { kind, gen: Number(r.gen), detail: why, at: this.#iso(now) });
        this.#publishItem(r.id);
      }
      if (whole === 'kickoff') this.#run('update teams set kickoff_told_at = ? where id = ?', this.#iso(now), teamId);
      if (whole === 'all_done') this.#run('update teams set wrapup_told_at = ? where id = ?', this.#iso(now), teamId);
      if (!waiting) {
        const m = this.#store.addMessage(String(lead.bot_id), 'user', `Check-in on team ${t.name}`, { kind: 'team.checkin', teamId, teamName: String(t.name) }, true);
        this.#run('update teams set checkin_message_id = ? where id = ?', m.id, teamId);
        this.#event(teamId, null, null, 'checkin', SERVER, whole ?? 'sent');
        this.#store.afterCommit(() => this.host.wake(String(lead.bot_id)));
        log.info('team check-in', { teamId, botId: lead.bot_id, items: due.length, whole: whole ?? undefined });
      }
      this.#publishTeam(teamId);
      return { checkin: true, escalations };
    });
  }

  /** Why an item needs its lead, in the server's words (names and times only). */
  #reasonText(r: Row, reason: string, now: number): string {
    const who = r.assignee_bot_id ? this.#botName(String(r.assignee_bot_id)) : null;
    const since = (iso: string) => {
      const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
      return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
    };
    switch (reason) {
      case 'stalled':
        return `No movement for ${since(r.last_activity_at)} (${who ?? 'no one'} is idle with nothing pending)`;
      case 'not_started':
        return `${who ?? 'Its assignee'} has not started it in ${since(r.gen_started_at)}`;
      case 'unassigned':
        return `Not assigned for ${since(r.gen_started_at)}`;
      case 'overdue':
        return `Not done or blocked ${since(r.gen_started_at)} after this assignment began`;
      case 'unavailable':
        return who ? `${who} can't work on it now` : 'No one holds it';
      case 'blocked':
        return `Still blocked after ${since(r.last_activity_at)}`;
      default:
        return reason;
    }
  }

  /**
   * A lead's check-in, as its turn reads it, built when the turn starts from the database as it is then: each reason
   * still true (its item's gen unchanged and its condition holding), each item's attempts and check-in count, the
   * board, and the commands that fit. The server writes it; what Botons wrote sits in a nonce'd block. Reasons it
   * gives (or drops as no longer true) are marked told by this message, so a re-run gives the same ones.
   */
  checkinPrompt(m: Message, owner: string, nonce = newNonce()): string {
    const teamId = m.meta?.teamId ?? '';
    const t = this.#get('select * from teams where id = ?', teamId);
    if (!t) return `(From the Botons server: a check-in on a team that no longer exists. Nothing needs you: answer [quiet].)`;
    // Only the lead now is told anything (and marks it told): a check-in left in an old lead's chat is a stub.
    if (this.#leadOf(teamId)?.bot_id !== m.botId) return `(From the Botons server: a check-in on team ${t.name}, which you no longer lead. Nothing needs you now: answer [quiet].)`;
    const limits = this.#limits(t);
    const tag = `checkin:${m.id}`;
    // Built: its end leaves later events alone (a re-run after a restart builds it again, so this refills).
    this.#built.add(m.id);
    const now = this.#iso();
    this.#run("update team_events set told_at = ?, origin_key = ? where team_id = ? and wake = 1 and told_at is null and origin_key is null", now, tag, teamId);
    const events = this.#all('select * from team_events where team_id = ? and origin_key = ? order by seq', teamId, tag);
    const lines: string[] = [];
    const quoted: { who: string; text: string }[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      const r = e.item_id ? this.#get('select * from team_items where id = ?', e.item_id) : undefined;
      if (!r || seen.has(`${r.id}:${e.kind}`)) continue;
      if (!this.#stillHolds(e, r)) continue;
      seen.add(`${r.id}:${e.kind}`);
      const head = `- ${r.id} (assignment ${r.gen}, attempt ${r.attempts} of ${limits.maxAttempts}${r.assignee_bot_id ? `, held by ${this.#botName(String(r.assignee_bot_id))}` : ''})`;
      const count = Number(r.nudges) > 0 ? ` Check-in ${r.nudges} of ${TEAM_LIMITS.maxNudges}; after ${TEAM_LIMITS.maxNudges} it goes to ${owner}.` : '';
      if (e.kind === 'done') {
        lines.push(`${head}: done by ${e.actor_name}. Review the result (quoted below) and move on.`);
        quoted.push({ who: e.actor_name, text: `Result of ${r.id}: ${r.result ?? ''}` });
      } else if (e.kind === 'blocked') {
        lines.push(`${head}: blocked, needing ${r.blocked_need === 'owner' ? owner : 'you'}. Retry it, give it to someone else, cancel it with a reason, or escalate it.${count}`);
        quoted.push({ who: e.actor_name, text: `Why ${r.id} is blocked: ${r.blocked_reason ?? ''}` });
      } else lines.push(`${head}: ${e.detail}.${count}`);
    }
    const counts = Object.fromEntries(STATUSES.map((st) => [st, 0])) as Record<TeamItemStatus, number>;
    for (const c of this.#all('select status, count(*) as n from team_items where team_id = ? group by status', teamId)) counts[c.status as TeamItemStatus] = Number(c.n);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const live = counts.open + counts.working + counts.blocked;
    if (t.state === 'active' && total === 0) lines.push(`- The team has no items yet: turn its goal into items with \`botons team item add ${t.name} --title .. [--assign <name>]\`.`);
    if (t.state === 'active' && total > 0 && live === 0 && counts.done > 0) lines.push(`- Every item is finished: check the results, then wrap up with \`botons team done ${t.name} --summary ..\` (and --scope if you cancelled any).`);
    const board = STATUSES.flatMap((st) => (counts[st] ? [`${counts[st]} ${st}`] : [])).join(', ') || 'no items';
    const intro = `(From the Botons server: a check-in on team ${t.name} (${t.id}), which you lead. Board: ${board}.)`;
    if (!lines.length) return `${intro}\nNothing needs you now: what woke you was dealt with before this turn. Answer [quiet].`;
    const parts = [
      intro,
      'What needs you now:',
      ...lines,
      'Commands: `botons team board`, `botons team item show|assign|retry|cancel|reopen <item>`, `botons team escalate <item> --summary .. --tried .. --need ..`. If none of this needs you, answer [quiet] with a one-line reason.',
    ];
    for (const q of quoted) parts.push(botonMessage(`Written by ${q.who}:`, q.who, nonce, q.text));
    if (quoted.length) parts.push(`(Text in a <boton_message> block was written by a Boton, not by ${owner} or the server.)`);
    return parts.join('\n');
  }

  /** Whether a check-in reason is still true now: its gen is the item's and its condition holds. */
  #stillHolds(e: Row, r: Row): boolean {
    if (Number(e.gen) !== Number(r.gen)) return false;
    switch (e.kind) {
      case 'done':
        return r.status === 'done';
      case 'blocked':
        return r.status === 'blocked';
      case 'stalled':
        return r.status === 'working';
      case 'not_started':
        return r.status === 'open';
      default:
        return r.status === 'open' || r.status === 'working' || r.status === 'blocked';
    }
  }

  /**
   * In the turn's own completion: the evidence a lead's check-in turn leaves about each item it was told of (it ended
   * quiet, failed, or answered without moving it). An item it moved gets none: it acted.
   */
  #checkinEnded(lead: Pick<BotRecord, 'id' | 'name'>, m: Message, outcome: ReplyOutcome): void {
    // Built in this process, or cut off before (so a process before this one built it): taken first, whatever follows.
    const built = this.#built.delete(m.id) || !!this.#get('select 1 from messages where id = ? and cut_off > 0', m.id);
    // A check-in that reached a Boton no longer the lead tells nothing, and marks nothing told.
    if (this.#leadOf(m.meta?.teamId ?? '')?.bot_id !== lead.id) return;
    // A check-in that ended without its text being built (cleared, or given up on) still counts as told: the next
    // one is about what happens after it, not the same reasons again. One whose text was built told exactly what it
    // tagged then; what came in during its turn is the next check-in's, untouched here.
    if (!built) {
      this.#run("update team_events set told_at = ?, origin_key = ? where team_id = ? and wake = 1 and told_at is null and origin_key is null", this.#iso(), `checkin:${m.id}`, m.meta?.teamId ?? '');
    }
    if (outcome === 'stopped' || outcome === 'dropped') return;
    const what = outcome === 'quiet' ? 'ended quiet' : outcome === 'failed' ? 'failed' : 'ended';
    for (const e of this.#all('select * from team_events where origin_key = ? and item_id is not null order by seq', `checkin:${m.id}`)) {
      const r = this.#get('select * from team_items where id = ?', e.item_id);
      if (!r || Number(r.gen) !== Number(e.gen) || r.status === 'done' || r.status === 'cancelled') continue;
      const moved = this.#get("select 1 from team_events where item_id = ? and seq > ? and actor_kind <> 'server' limit 1", r.id, e.seq);
      if (moved) continue;
      const detail = `${lead.name}'s check-in turn ${what} without changing it`;
      if (this.#get("select 1 from team_events where item_id = ? and kind = 'checkin' and idem_key = ?", r.id, `told:${e.seq}`)) continue;
      this.#event(r.team_id, r.id, Number(r.gen), 'checkin', SERVER, detail, { idem: `told:${e.seq}` });
      this.#addEvidence(r.id, { kind: 'checkin', gen: Number(r.gen), detail, at: this.#iso() });
    }
  }

  /**
   * Items at the check-in cap with nothing changed: the server escalates them itself, on the evidence it recorded (the
   * check-ins and what each lead turn did), never inventing an attempt. One open escalation per item, the team's daily
   * escalation budget (past it the team pauses, with one notice), and one push for all of this tick's.
   */
  #escalateDue(t: Row, items: Row[]): number {
    const opened: { item: Row; card: Message }[] = [];
    const limits = this.#limits(t);
    for (const [i, r] of items.entries()) {
      if (r.escalation) continue;
      const evidence = parseJson<TeamEvidence[]>(r.evidence, []).filter((e) => e.gen === Number(r.gen) && EVIDENCE_KINDS.has(e.kind));
      if (!evidence.length) {
        this.#holdItem(r, 'It could not be escalated: nothing on record for this assignment. It waits for the owner now');
        continue;
      }
      if (this.#escalationsToday(String(t.id)) >= TEAM_LIMITS.escalationsPerTeamPerDay) {
        this.#pauseTeam(String(t.id), 'budget', `it escalated ${TEAM_LIMITS.escalationsPerTeamPerDay} items today, its daily limit`);
        // The team is paused (resuming starts every clock again); these are looked at again then, not every tick.
        for (const rest of items.slice(i)) this.#run('update team_items set next_check_at = ? where id = ?', this.#iso(this.#clock() + limits.stallAfterMs), rest.id);
        break;
      }
      const lead = this.#leadOf(String(t.id));
      const checkins = evidence.filter((e) => e.kind === 'checkin').map((e) => e.detail);
      const card = this.#openEscalation(r, 'server', {
        summary: `No progress on “${contextWords(String(r.title), 200)}” after ${r.nudges} check-ins with ${lead ? lead.name : 'its lead'}.`,
        tried: checkins.length ? checkins.join('; ') : `${lead ? lead.name : 'The lead'} was checked in with ${r.nudges} times; the item did not move.`,
        need: 'Decide what happens to it: try it again, give it to someone else, or drop it.',
      });
      if (card) opened.push({ item: r, card });
      else this.#holdItem(r, 'It could not be escalated: the team has no lead to post the card for. It waits for the owner now');
    }
    if (opened.length) {
      const lead = this.#leadOf(String(t.id));
      const first = opened[0]!;
      const detail = opened.length === 1 ? `${t.name}: ${contextWords(String(first.item.title), 120)} needs you` : `${t.name}: ${opened.length} items need you`;
      this.#store.afterCommit(() =>
        this.host.push({
          bot: lead ? { id: String(lead.bot_id), name: String(lead.name) } : null,
          reason: 'team',
          detail,
          generic: 'A team needs you.',
          priority: 'default',
          messageId: first.card.id,
          teamId: String(t.id),
          itemId: String(first.item.id),
        }),
      );
    }
    return opened.length;
  }

  /** An item the supervisor can do no more about: held for the owner (one attention entry), looked at again a day later. */
  #holdItem(r: Row, why: string): void {
    const now = this.#clock();
    this.#run("update team_items set held = 'owner', next_check_at = ?, version = version + 1, updated_at = ? where id = ?", this.#iso(now + TEAM_LIMITS.heldRecheckMs), this.#iso(now), r.id);
    this.#event(String(r.team_id), String(r.id), Number(r.gen), 'held', SERVER, why);
    this.#publishItem(String(r.id));
  }

  #escalationsToday(teamId: string): number {
    return Number(this.#get("select count(*) as n from team_events where team_id = ? and kind = 'escalated' and at > ?", teamId, this.#iso(this.#dayFrom(this.#teamRow(teamId), this.#clock())))!.n);
  }

  /**
   * Where a team's daily budgets start counting (ms): the last day, or the owner's last resume if later, so a team
   * the owner resumes after a budget ran out gets a fresh day instead of pausing again at once.
   */
  #dayFrom(t: Row, now: number): number {
    return Math.max(now - 24 * HOUR, t.resumed_at ? Date.parse(String(t.resumed_at)) : 0);
  }

  /**
   * In the caller's transaction: the escalation card in the lead's chat, built by the server (the summary, what was
   * tried, what the owner must decide, the server's evidence with times, and one form), and the item's record of it.
   */
  #openEscalation(r: Row, by: 'lead' | 'server', text: { summary: string; tried: string; need: string }): Message | null {
    const lead = this.#leadOf(String(r.team_id));
    if (!lead) return null;
    const card = this.#postEscalationCard(r, lead, this.#escalationCard(r, by, String(lead.name), text));
    const at = this.#iso();
    const escalation: TeamEscalation = { cardMessageId: card.id, botId: String(lead.bot_id), by, summary: text.summary, need: text.need, at };
    const limits = this.#limits(this.#teamRow(String(r.team_id)));
    this.#run(
      'update team_items set escalation = ?, total_escalations = total_escalations + 1, next_check_at = ?, version = version + 1, updated_at = ? where id = ?',
      JSON.stringify(escalation),
      this.#iso(this.#clock() + limits.stallAfterMs),
      at,
      r.id,
    );
    const actor: Actor = by === 'lead' ? { kind: 'boton', botId: String(lead.bot_id), name: String(lead.name) } : SERVER;
    this.#event(String(r.team_id), String(r.id), Number(r.gen), 'escalated', actor, text.summary);
    this.#audit?.record(
      { kind: by === 'lead' ? 'boton' : 'system', id: by === 'lead' ? String(lead.bot_id) : null, label: by === 'lead' ? String(lead.name) : 'Botons' },
      { action: 'team.escalated', target: { kind: 'team', id: String(r.team_id), label: String(this.#teamRow(String(r.team_id)).name) }, details: { item: String(r.id), by, card: card.id } },
    );
    this.#publishItem(String(r.id));
    this.#publishTeam(String(r.team_id));
    log.info('team item escalated', { teamId: r.team_id, itemId: r.id, by, cardId: card.id });
    return card;
  }

  /** The escalation card's descriptor, built by the server (no one else's words but the item's title and the texts). */
  #escalationCard(r: Row, by: 'lead' | 'server', leadName: string, text: { summary: string; tried: string; need: string }): unknown {
    const evidence = parseJson<TeamEvidence[]>(r.evidence, []).filter((e) => e.gen === Number(r.gen)).slice(-TEAM_LIMITS.evidenceMax);
    const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    return {
      v: 1,
      title: clip(`Blocked: ${String(r.title)}`, 120),
      blocks: [
        { type: 'status', tone: 'warning', text: clip(text.summary, 300) },
        {
          type: 'text',
          text: clip(`${r.id} of team ${this.#teamRow(String(r.team_id)).name}, ${r.assignee_bot_id ? `held by ${this.#botName(String(r.assignee_bot_id))}` : 'not assigned'} (${r.status}). Escalated by ${by === 'lead' ? leadName : 'Botons, after its check-ins went unanswered'}.`, 2000),
        },
        { type: 'text', text: clip(`Tried: ${text.tried}`, 2000) },
        { type: 'text', text: clip(`Needs from you: ${text.need}`, 2000) },
        ...(evidence.length ? [{ type: 'table', columns: ['When', 'On record'], rows: evidence.map((e) => [e.at.replace('T', ' ').slice(0, 16), clip(`${e.kind}: ${e.detail}`, 200)]) }] : []),
        {
          type: 'form',
          id: 'answer',
          fields: [
            {
              id: 'next',
              label: 'What next',
              kind: 'select',
              required: true,
              options: [
                { id: 'retry', label: "I've unblocked it: try again" },
                { id: 'reassign', label: 'Give it to someone else' },
                { id: 'drop', label: 'Drop this item' },
                { id: 'other', label: 'Something else' },
              ],
            },
            { id: 'note', label: 'Note', kind: 'textarea' },
          ],
        },
      ],
    };
  }

  /** In the caller's transaction: an escalation card in the lead's chat. */
  #postEscalationCard(r: Row, lead: Row, descriptor: unknown): Message {
    const team = this.#teamRow(String(r.team_id));
    return this.host.postCard(String(lead.bot_id), descriptor, TEAM_LIMITS.escalationTtlMs, { teamId: String(r.team_id), teamName: String(team.name), itemId: String(r.id), itemTitle: String(r.title) });
  }

  /**
   * The lead changed, or left: what was the old lead's becomes the lead's now. A check-in that had not started leaves
   * the old lead's chat (its reasons stay untold, for the lead's next one). An open escalation's card moves to the
   * lead's chat, the old one closed as expired, so the owner's answer reaches whoever leads; it is the same
   * escalation, so no budget or lifetime count moves.
   */
  #repointToLead(teamId: string): void {
    const t = this.#teamRow(teamId);
    const lead = this.#leadOf(teamId);
    const leadId = lead ? String(lead.bot_id) : null;
    if (t.checkin_message_id) {
      const m = this.#store.findMessage(String(t.checkin_message_id));
      if (!m || m.botId !== leadId) {
        if (m) this.#store.recallPending(m.id);
        this.#run('update teams set checkin_message_id = null where id = ?', teamId);
      }
    }
    // What an old lead's check-in turn still under way was told goes back to untold, so the new lead's next check-in
    // carries it (that turn's own end is a stub for a Boton that no longer leads).
    for (const c of this.#all(
      `select distinct e.origin_key as tag, m.bot_id as bot from team_events e join messages m on m.id = substr(e.origin_key, 9)
         where e.team_id = ? and e.wake = 1 and e.told_at is not null and e.origin_key like 'checkin:%' and m.pending in (1, 2)`,
      teamId,
    )) {
      if (String(c.bot) !== leadId) this.#run('update team_events set told_at = null, origin_key = null where team_id = ? and origin_key = ?', teamId, c.tag);
    }
    if (!lead) return;
    for (const r of this.#all("select * from team_items where team_id = ? and escalation is not null and status in ('open', 'working', 'blocked')", teamId)) {
      const esc = parseJson<TeamEscalation | null>(r.escalation, null);
      if (!esc || esc.botId === leadId) continue;
      const old = this.#store.findMessage(esc.cardMessageId);
      const card = old?.meta?.card;
      if (old && card && card.status !== 'pending') continue;
      if (old && card) this.#store.closeCard(old.id, { ...card, status: 'expired' });
      const descriptor = card?.descriptor ?? this.#escalationCard(r, esc.by, String(lead.name), { summary: esc.summary, tried: 'See the item’s record.', need: esc.need });
      const moved = this.#postEscalationCard(r, lead, descriptor);
      this.#run('update team_items set escalation = ?, version = version + 1, updated_at = ? where id = ?', JSON.stringify({ ...esc, cardMessageId: moved.id, botId: leadId }), this.#iso(), r.id);
      this.#publishItem(String(r.id));
      log.info('team escalation moved to the new lead', { teamId, itemId: r.id, botId: leadId, cardId: moved.id });
    }
  }

  /**
   * `botons team escalate`: the lead's, through the server's gate (shared/teams.ts leadEscalationRefusal): only what is
   * stuck, only on recorded evidence, after the lead tried something (unless the assignee says it needs the owner),
   * with the three texts, one open per item, within the team's daily limit. One card and one push.
   */
  escalate(itemId: string, input: unknown, botId: string): TeamItemActionResult {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const texts = {
      summary: o.summary === undefined ? undefined : prose(o.summary, 'summary', TEAM_TEXT.escalationSummary),
      tried: o.tried === undefined ? undefined : prose(o.tried, 'tried', TEAM_TEXT.escalationTried),
      need: o.need === undefined ? undefined : prose(o.need, 'need', TEAM_TEXT.escalationNeed),
    };
    const r = this.#item(itemId);
    const t = this.#teamRow(r.team_id);
    if (!this.#seat(t.id, botId)) throw new HttpError(403, `You hold no seat in team ${t.name}.`);
    const lead = this.#leadOf(t.id);
    if (lead?.bot_id !== botId) throw refusal('not_allowed', `Only ${t.name}'s lead escalates its items.`, 403);
    if (t.state !== 'active') throw refusal('team_not_active', `Team ${t.name} is ${t.state}: only ${this.#owner()} changes its work now.`);
    const view = this.#toItem(r);
    const scoped = scopeRefusal(this.#scopeOf(botId), view, 'lead');
    if (scoped) throw refused(scoped);
    if (view.escalation) return { item: view, duplicate: true };
    const leadTried =
      !!this.#get("select 1 from team_events where item_id = ? and kind = 'retry' limit 1", r.id) ||
      Number(this.#get("select count(*) as n from team_events where item_id = ? and kind = 'assigned'", r.id)!.n) >= 2;
    const today = this.#escalationsToday(t.id);
    const why = leadEscalationRefusal(view, { maxAttempts: this.#limits(t).maxAttempts, leadTried, escalationsToday: today, input: texts });
    if (why) {
      if (why.code === 'limit' && today >= TEAM_LIMITS.escalationsPerTeamPerDay) {
        this.#store.atomically(() => this.#pauseTeam(t.id, 'budget', `it escalated ${TEAM_LIMITS.escalationsPerTeamPerDay} items today, its daily limit`));
      }
      throw refused(why);
    }
    const card = this.#store.atomically(() => {
      const card = this.#openEscalation(r, 'lead', { summary: texts.summary!, tried: texts.tried!, need: texts.need! });
      this.host.chip(botId, `Escalated ${r.title}`, { kind: 'team.update', teamId: t.id, teamName: String(t.name), itemId: r.id, itemTitle: String(r.title), itemStatus: r.status });
      return card;
    });
    if (card) {
      this.host.push({
        bot: { id: botId, name: String(lead.name) },
        reason: 'team',
        detail: `${t.name}: ${texts.summary}`,
        generic: 'A team needs you.',
        priority: 'default',
        messageId: card.id,
        teamId: String(t.id),
        itemId: String(r.id),
      });
    }
    return { item: this.#toItem(this.#item(itemId)), duplicate: false };
  }

  /**
   * The owner answered an escalation card (Cards.onAnswered, in the answer's transaction): the escalation closes and
   * the item's attempts and check-ins start again, so the lead can act on the answer. Lifetime counts stay.
   */
  ownerAnswered(botId: string, cardId: string, by: Principal | null): void {
    const r = this.#get("select * from team_items where json_extract(escalation, '$.cardMessageId') = ? and json_extract(escalation, '$.botId') = ?", cardId, botId);
    if (!r) return;
    const t = this.#teamRow(r.team_id);
    const limits = this.#limits(t);
    this.#run(
      'update team_items set escalation = null, attempts = 0, nudges = 0, next_check_at = ?, last_activity_at = ?, version = version + 1, updated_at = ? where id = ?',
      this.#iso(this.#clock() + limits.stallAfterMs),
      this.#iso(),
      this.#iso(),
      r.id,
    );
    this.#event(t.id, r.id, Number(r.gen), 'owner_answered', this.#ownerActor(), '');
    this.#record(by, 'team.escalation_answered', { id: t.id, name: String(t.name) }, { item: String(r.id), card: cardId });
    this.#publishItem(r.id);
    this.#publishTeam(t.id);
  }

  /**
   * `botons team done`: the lead finishes the team (shared/teams.ts completionRefusal): nothing left open, something
   * done, and what was cancelled accounted for. The completion record holds the server's own list of every item's
   * result and every cancellation; it is the owner's to review. One push.
   */
  finish(teamRef: string, input: unknown, botId: string): Team {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const summary = o.summary === undefined ? undefined : prose(o.summary, 'summary', TEAM_TEXT.completionSummary);
    const scope = o.scope === undefined ? undefined : prose(o.scope, 'scope', TEAM_TEXT.completionScope);
    const t = this.teamByRef(teamRef);
    if (!t || t.state === 'archived') throw new HttpError(404, `No team ${teamRef}`);
    if (!this.#seat(t.id, botId)) throw new HttpError(403, `You hold no seat in team ${t.name}.`);
    const lead = this.#leadOf(t.id);
    if (lead?.bot_id !== botId) throw refusal('not_allowed', `Only ${t.name}'s lead finishes it.`, 403);
    if (t.state !== 'active') throw refusal('team_not_active', `Team ${t.name} is ${t.state}: only an active team is finished.`);
    if (!this.#scopeOf(botId)) throw refusal('not_in_turn', 'Team actions are taken during a turn, with `botons team`.');
    const items = this.#all('select * from team_items where team_id = ? order by created_at, id', t.id);
    const why = completionRefusal(
      items.map((r) => ({ id: r.id, status: r.status, closedBy: r.closed_by ?? null })),
      { leadBotId: botId, summary, scope },
    );
    if (why) throw refused(why);
    const nameOf = (by: string | null) => (by === 'owner' ? this.#owner() : by ? this.#botName(by) : '');
    const completion: TeamCompletion = {
      summary: summary!,
      scope: scope ?? '',
      by: { botId, name: String(lead.name) },
      at: this.#iso(),
      done: items.filter((r) => r.status === 'done').map((r) => ({ itemId: r.id, title: r.title, result: r.result ?? '' })),
      cancelled: items.filter((r) => r.status === 'cancelled').map((r) => ({ itemId: r.id, title: r.title, reason: r.closed_reason ?? '', by: nameOf(r.closed_by ?? null) })),
    };
    this.#store.atomically(() => {
      this.#run("update teams set state = 'done', completion = ?, reviewed_at = null, inactive_since = ?, version = version + 1, updated_at = ? where id = ?", JSON.stringify(completion), this.#iso(), this.#iso(), t.id);
      this.#event(t.id, null, null, 'team_done', { kind: 'boton', botId, name: String(lead.name) }, summary!);
      // Nothing more is delivered in a finished team: what had not started is taken back, and whoever asked hears so.
      this.recall({ teamId: String(t.id) }, false, `team ${t.name} was finished before it was delivered`);
      this.#store.addMessage(botId, 'event', `Team ${t.name} finished: ${completion.done.length} done, ${completion.cancelled.length} cancelled. For ${this.#owner()} to review.`, {
        kind: 'team.notice',
        teamId: t.id,
        teamName: String(t.name),
      });
      this.#publishTeam(t.id);
    });
    this.host.push({ bot: { id: botId, name: String(lead.name) }, reason: 'team', detail: `${t.name} finished: review it`, generic: 'A team finished its work.', priority: 'default', teamId: String(t.id) });
    log.info('team finished', { teamId: t.id, done: completion.done.length, cancelled: completion.cancelled.length });
    return this.get(String(t.id));
  }

  // ------------------------------------------------------------------ the role context

  /**
   * The teams part of a Boton's context block, in the teams' fixed order (created, id). Part A, always given and
   * bounded: per team its id, name, state, this Boton's role, role title and responsibilities, and the lead. Part B
   * fills what is left of TEAM_CONTEXT.total in the same order: the goal, teammates, the board and its items. What
   * does not fit is named, with the command that shows it, never cut silently. Null when it holds no seat.
   * What the owner or a Boton wrote (role titles, responsibilities, the goal, item titles) is cleaned, clipped and put
   * in a <team_text> element with this turn's nonce, so it reads as data and nothing in it can pass as the server's;
   * ids, names, states, counts and commands are the server's and stay outside.
   */
  contextFor(botId: string, nonce: string = newNonce()): string[] | null {
    const OPEN = `<team_text id="${nonce}">`;
    const CLOSE = '</team_text>';
    const words = (text: string, max: number) => `${OPEN}${contextWords(text, max)}${CLOSE}`;
    const seats = this.#all(
      `select m.*, t.id as tid, t.name as tname, t.state as tstate, t.goal from team_members m join teams t on t.id = m.team_id
         where m.bot_id = ? and t.state <> 'archived' order by t.created_at, t.id limit ?`,
      botId,
      TEAM_LIMITS.teamsPerBot,
    );
    if (!seats.length) return null;
    const lines: string[] = [];
    const parts: { team: string; label: string; lines: string[] }[] = [];
    for (const m of seats) {
      const teamId = String(m.tid);
      const name = contextWords(String(m.tname), TEAM_TEXT.name);
      const lead = this.#leadOf(teamId);
      const role = m.role === 'lead' ? 'you are the lead' : 'you are a member';
      const leadText = m.role === 'lead' ? '' : lead ? ` Lead: ${contextWords(String(lead.name), 60)} (${lead.bot_id}).` : ' No lead now.';
      const state = m.tstate === 'active' ? '' : `, ${m.tstate}${m.tstate === 'paused' ? ' (nothing is sent in it until it resumes)' : ''}`;
      // The server's facts first and whole (the team, its state, the role and the lead); then the role's words, the
      // title whole and the responsibilities clipped to what is left of the part's bound.
      const head = `- ${name} (${teamId}${state}): ${role}.${leadText}`;
      let roleText = '';
      if (m.role_title || m.responsibilities) {
        const leadIn = ' Your role: ';
        const titled = m.role_title ? `“${contextWords(String(m.role_title), TEAM_CONTEXT.roleTitle)}”` : '';
        const sep = titled && m.responsibilities ? ': ' : '';
        const room = TEAM_CONTEXT.critical - head.length - leadIn.length - OPEN.length - CLOSE.length - titled.length - sep.length - 1;
        const owns = m.responsibilities && room > 1 ? contextWords(String(m.responsibilities), Math.min(TEAM_CONTEXT.responsibilities, room)) : '';
        roleText = `${leadIn}${OPEN}${titled}${owns ? `${sep}${owns}` : ''}${CLOSE}.`;
      }
      lines.push(`${head}${roleText}`);
      // Part B, in pieces that are each given whole or named as left out.
      if (m.goal) parts.push({ team: name, label: `the goal of ${name}`, lines: [`  ${name} goal: ${words(String(m.goal), TEAM_CONTEXT.goal)}`] });
      const mates = this.#all('select m.*, b.name, b.paused from team_members m join bots b on b.id = m.bot_id where m.team_id = ? and m.bot_id <> ? order by m.position, m.joined_at', teamId, botId);
      if (mates.length) {
        const list = mates.map((t) => {
          const st = this.host.statusOf(String(t.bot_id)).state;
          const bits = [st === 'idle' ? 'idle' : st === 'queued' ? 'up next' : 'working', ...(t.paused ? ['paused'] : []), ...(t.role === 'lead' ? ['lead'] : [])];
          const said = [t.role_title ? contextWords(String(t.role_title), TEAM_CONTEXT.roleTitle) : '', t.responsibilities ? contextWords(String(t.responsibilities), TEAM_CONTEXT.teammateResponsibilities) : '']
            .filter(Boolean)
            .join(': ');
          return `${contextWords(String(t.name), 60)} (${t.bot_id})${said ? ` ${OPEN}${said}${CLOSE}` : ''} [${bits.join(', ')}]`;
        });
        parts.push({ team: name, label: `teammates of ${name}`, lines: [`  ${name} teammates: ${list.join('; ')}`] });
      }
      const counts = this.#all('select status, count(*) as n from team_items where team_id = ? group by status', teamId);
      const board = STATUSES.flatMap((st) => {
        const n = Number(counts.find((c) => c.status === st)?.n ?? 0);
        return n ? [`${n} ${st}`] : [];
      });
      const mine = this.#all(
        m.role === 'lead'
          ? "select * from team_items where team_id = ? and status in ('open', 'working', 'blocked') order by case status when 'blocked' then 0 when 'open' then 1 else 2 end, created_at limit ?"
          : "select * from team_items where team_id = ? and assignee_bot_id = ? and status in ('open', 'working', 'blocked') order by created_at limit ?",
        ...(m.role === 'lead' ? [teamId] : [teamId, botId]),
        TEAM_CONTEXT.items,
      );
      const itemLines = mine.map((r) => {
        const who = m.role === 'lead' ? (r.assignee_bot_id ? `, ${this.#botName(String(r.assignee_bot_id))}` : ', not assigned') : '';
        const need = r.status === 'blocked' ? (r.blocked_need === 'owner' ? `: needs ${this.#owner()}` : ': needs the lead') : '';
        return `${r.id} ${words(String(r.title), 80)} (${r.status}${need}${who}, assignment ${r.gen}${r.escalation ? `, escalated to ${this.#owner()}` : ''})`;
      });
      const live = Number(this.#get("select count(*) as n from team_items where team_id = ? and status in ('open', 'working', 'blocked')", teamId)!.n);
      const more = m.role === 'lead' && live > mine.length ? `; ${live - mine.length} more` : '';
      parts.push({
        team: name,
        label: `the board of ${name}`,
        lines: [`  ${name} board: ${board.length ? board.join(', ') : 'no items yet'}.${itemLines.length ? ` ${m.role === 'lead' ? 'Open work' : 'Your items'}: ${itemLines.join('; ')}${more}.` : ''}`],
      });
    }
    // Part B pieces in order while they fit, with room for the line naming what was left out; if that line itself
    // doesn't fit, the last pieces given are named instead, until the whole is within its bound.
    const notShown = (left: typeof parts) => {
      if (!left.length) return [];
      const teams = [...new Set(left.map((p) => p.team))];
      return [`  Not shown here: ${left.map((p) => p.label).join(', ')}. Run ${teams.map((t) => `\`botons team show ${t}\``).join(' or ')}, \`botons team board <team>\` or \`botons team item show <item>\`.`];
    };
    const size = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, 0);
    const given: typeof parts = [];
    const left: typeof parts = [];
    let used = size(lines);
    for (const p of parts) {
      const n = size(p.lines);
      if (used + n > TEAM_CONTEXT.total - 200) left.push(p);
      else {
        given.push(p);
        used += n;
      }
    }
    while (given.length && size(lines) + size(given.flatMap((p) => p.lines)) + size(notShown(left)) > TEAM_CONTEXT.total) left.unshift(given.pop()!);
    // In the teams' order, as they were built.
    left.sort((a, b) => parts.indexOf(a) - parts.indexOf(b));
    return [...lines, ...given.flatMap((p) => p.lines), ...notShown(left)];
  }

  // ------------------------------------------------------------------ reading

  threadOf(id: string): TeamThread | null {
    const t = this.#thread(id);
    return t ? this.#toThread(t) : null;
  }

  /** The owner's list of threads, newest first: of a team (or `direct`), an item, a Boton, or matching `q`. */
  threads(opts: { team?: string | null; item?: string | null; bot?: string | null; q?: string | null; before?: number; limit?: number } = {}): TeamThread[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.team === 'direct') where.push('t.team_id is null');
    else if (opts.team) {
      where.push('t.team_id = ?');
      params.push(opts.team);
    }
    if (opts.item) {
      where.push('t.item_id = ?');
      params.push(opts.item);
    }
    if (opts.bot) {
      where.push('exists (select 1 from json_each(t.participants) where value = ?)');
      params.push(opts.bot);
    }
    if (opts.before) {
      where.push('t.last_seq < ?');
      params.push(opts.before);
    }
    const q = opts.q?.trim();
    if (q) {
      const like = likePattern(q);
      where.push(`(t.subject like ? escape '\\' or exists (select 1 from team_items i where i.id = t.item_id and i.title like ? escape '\\')
        or exists (select 1 from team_messages m where m.thread_id = t.id and m.text like ? escape '\\'))`);
      params.push(like, like, like);
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 50);
    return this.#all(`select t.* from team_threads t ${where.length ? `where ${where.join(' and ')}` : ''} order by t.last_seq desc limit ?`, ...params, limit).map((t) => this.#toThread(t));
  }

  threadDetail(id: string): TeamThreadDetail {
    const t = this.#thread(id);
    if (!t) throw new HttpError(404, `No thread ${id}`);
    const team = t.team_id ? this.#get('select * from teams where id = ?', t.team_id) : undefined;
    const item = t.item_id ? this.#get('select * from team_items where id = ?', t.item_id) : undefined;
    return { thread: this.#toThread(t), team: team ? this.#toTeam(team) : null, item: item ? this.#toItem(item) : null };
  }

  /**
   * A Boton's read of a thread, by its seats now: a Direct thread's participants; a team thread's participants that
   * still hold a seat, and the team's lead. Anyone else (a member since removed included) is refused.
   */
  threadFor(botId: string, id: string): TeamThreadDetail & { messages: TeamMessage[] } {
    const t = this.#thread(id);
    if (!t) throw new HttpError(404, `No thread ${id}`);
    if (!this.#mayRead(t, botId)) throw new HttpError(403, `You can't read thread ${id}: only who takes part in it now (and its team's lead) can.`);
    return { ...this.threadDetail(id), messages: this.messagesOf(id, { limit: 200 }) };
  }

  /** The owner read a thread up to `upTo` (a seq): the marker only moves forward, so an older device can't undo it. */
  markThreadRead(id: string, upTo: unknown): TeamThread {
    const t = this.#thread(id);
    if (!t) throw new HttpError(404, `No thread ${id}`);
    const seq = upTo === undefined ? Number(t.last_seq) : upTo;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'upTo must be a message seq');
    const to = Math.min(seq, Number(t.last_seq));
    const moved = Number(this.#run('update team_threads set owner_read_seq = ? where id = ? and owner_read_seq < ?', to, id, to).changes);
    if (moved) {
      this.#publishThread(id);
      if (t.team_id) this.#publishTeam(String(t.team_id));
      else this.#publishAttention();
    }
    return this.#toThread(this.#thread(id)!);
  }

  /**
   * Search, newest first: a case-insensitive match (its wildcards taken literally) in what Botons said, a thread's
   * subject or its item's title, with a snippet around it. Volumes are bounded by the budgets, so no index of its own.
   */
  search(q: unknown, opts: { team?: string | null; limit?: number } = {}): TeamSearchHit[] {
    if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'q is required');
    const term = q.trim().slice(0, 200);
    const like = likePattern(term);
    const params: unknown[] = [like, like, like];
    let scope = '';
    if (opts.team === 'direct') scope = 'and t.team_id is null';
    else if (opts.team) {
      scope = 'and t.team_id = ?';
      params.push(opts.team);
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 50);
    const rows = this.#all(
      `select m.*, t.subject, i.title as item_title from team_messages m join team_threads t on t.id = m.thread_id left join team_items i on i.id = t.item_id
         where (m.text like ? escape '\\' or ((t.subject like ? escape '\\' or i.title like ? escape '\\')
           and m.seq = (select min(seq) from team_messages where thread_id = m.thread_id))) ${scope}
         order by m.seq desc limit ?`,
      ...params,
      limit,
    );
    return rows.map((r) => {
      const inText = String(r.text).toLowerCase().includes(term.toLowerCase());
      const source = inText ? String(r.text) : String(r.subject).toLowerCase().includes(term.toLowerCase()) ? String(r.subject) : String(r.item_title ?? r.subject);
      return {
        threadId: r.thread_id,
        messageId: r.id,
        seq: Number(r.seq),
        teamId: r.team_id ?? null,
        itemId: r.item_id ?? null,
        subject: r.subject,
        from: r.from_name,
        to: r.to_name,
        snippet: snippet(source, term),
        at: r.created_at,
      };
    });
  }

  messagesOf(threadId: string, opts: { before?: number; after?: number; limit?: number } = {}): TeamMessage[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
    // With neither bound: the newest page (a thread opens at its end; server lines can take it past its send limit).
    const rows = opts.after
      ? this.#all('select * from team_messages where thread_id = ? and seq > ? order by seq limit ?', threadId, opts.after, limit)
      : this.#all('select * from team_messages where thread_id = ? and seq < ? order by seq desc limit ?', threadId, opts.before ?? Number.MAX_SAFE_INTEGER, limit).reverse();
    return rows.map((r) => this.#toMessage(r));
  }

  #toThread(t: Row): TeamThread {
    const ids = parseJson<string[]>(t.participants, []);
    const names = new Map(ids.length ? this.#all(`select id, name from bots where id in (${ids.map(() => '?').join(', ')})`, ...ids).map((r) => [String(r.id), String(r.name)]) : []);
    const last = this.#get('select from_name, to_name, text from team_messages where thread_id = ? order by seq desc limit 1', t.id);
    const lastDelivery = this.#get(
      "select d.* from team_deliveries d join team_messages m on m.id = d.message_id where m.thread_id = ? and m.kind = 'request' order by m.seq desc limit 1",
      t.id,
    );
    const team = t.team_id ? this.#get('select name from teams where id = ?', t.team_id) : undefined;
    const item = t.item_id ? this.#get('select title from team_items where id = ?', t.item_id) : undefined;
    // Names of Botons since deleted come from the thread's own messages.
    const nameOf = (id: string) => names.get(id) ?? String(this.#get('select from_name from team_messages where from_bot_id = ? limit 1', id)?.from_name ?? id);
    return {
      id: t.id,
      teamId: t.team_id ?? null,
      teamName: team ? String(team.name) : null,
      itemId: t.item_id ?? null,
      itemTitle: item ? String(item.title) : null,
      subject: t.subject,
      participants: ids.map((botId) => ({ botId, name: nameOf(botId) })),
      messageCount: Number(t.message_count),
      lastSeq: Number(t.last_seq),
      lastAt: t.last_at,
      last: last ? { fromName: last.from_name, toName: last.to_name, text: last.text.length > 200 ? `${last.text.slice(0, 199)}…` : last.text } : null,
      lastDelivery: lastDelivery ? this.#toDelivery(lastDelivery) : null,
      unread: Number(t.last_seq) > Number(t.owner_read_seq),
      closedAt: t.closed_at ?? null,
    };
  }

  #toMessage(r: Row): TeamMessage {
    const d = r.kind === 'request' ? this.#get('select * from team_deliveries where message_id = ?', r.id) : undefined;
    return {
      seq: Number(r.seq),
      id: r.id,
      threadId: r.thread_id,
      teamId: r.team_id ?? null,
      itemId: r.item_id ?? null,
      itemGen: r.item_gen === null || r.item_gen === undefined ? null : Number(r.item_gen),
      kind: r.kind,
      from: { botId: r.from_bot_id ?? null, name: r.from_name },
      to: { botId: r.to_bot_id ?? null, name: r.to_name },
      text: r.text,
      hop: Number(r.hop),
      inReplyTo: r.in_reply_to ?? null,
      stale: !!r.stale,
      createdAt: r.created_at,
      delivery: d ? this.#toDelivery(d) : null,
    };
  }

  #toDelivery(d: Row): TeamDelivery {
    return {
      state: d.state,
      outcome: d.outcome ?? null,
      waitingOn: this.#waitingOn(d),
      chatMessageId: d.chat_message_id ?? null,
      botId: d.to_bot_id,
      queuedAt: d.queued_at,
      at: d.handled_at ?? d.dispatched_at ?? d.queued_at,
    };
  }

  /** Why an open delivery has not been answered yet. */
  #waitingOn(d: Row): TeamDeliveryWaiting {
    if (d.state !== 'queued' && d.state !== 'dispatched') return null;
    const paused = !!this.#store.pausedReason(String(d.to_bot_id));
    if (d.state === 'dispatched') return paused ? 'paused' : null;
    const team = this.#get('select t.state from team_messages m join teams t on t.id = m.team_id where m.id = ?', d.message_id);
    // Archived or finished, nothing waits on a pause (what had not started was taken back).
    if (team && (team.state === 'archived' || team.state === 'done')) return null;
    if (team && team.state !== 'active') return 'team_paused';
    return paused ? 'paused' : 'backlog';
  }

  /** A message changed (a request's delivery, mostly): it, and its thread's row, which shows the newest delivery. */
  #publishMessage(id: string): void {
    const r = this.#get('select * from team_messages where id = ?', id);
    if (!r) return;
    this.#store.publish({ type: 'team.message.created', message: this.#toMessage(r) });
    if (r.kind === 'request') this.#publishThread(String(r.thread_id));
  }

  /**
   * Every open request (and its thread) of a team, of a Boton's, or of all: what each waits on is worked out as it is
   * read (a pause, the team paused), so a change to either republishes them.
   */
  publishOpen(where: { teamId?: string; botId?: string }): void {
    const rows = this.#all(
      `select m.id from team_deliveries d join team_messages m on m.id = d.message_id where d.state in ('queued', 'dispatched')
         ${where.teamId ? 'and m.team_id = ?' : ''} ${where.botId ? 'and d.to_bot_id = ?' : ''} order by m.seq`,
      ...[where.teamId, where.botId].filter((x) => x !== undefined),
    );
    for (const r of rows) this.#publishMessage(String(r.id));
  }

  #publishThread(id: string): void {
    const t = this.#thread(id);
    if (t) this.#store.publish({ type: 'team.thread.upserted', thread: this.#toThread(t) });
  }
}
