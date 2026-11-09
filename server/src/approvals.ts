import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AccessLevel,
  Approval,
  ApprovalDecisionInput,
  ApprovalOrigin,
  ApprovalRequestInput,
  ApprovalRequestResult,
  ApprovalStatus,
  ApprovalToolCall,
  ConnectorRequestResult,
  Message,
  MessageMeta,
  Skill,
  ToolCallInput,
  ToolCallVerdict,
} from '../../shared/types.ts';
import { callKey, describeCall, matchRule, ruleKey } from './ask-rules.ts';
import type { Connectors } from './connectors.ts';
import { formatDuration, parseDuration } from './config.ts';
import type { EventHub } from './events.ts';
import { RunLimiter } from './limits.ts';
import { type LogFields, log } from './log.ts';
import type { Notifier } from './notify.ts';
import type { Skills } from './skills.ts';
import { actionKey, flag, HttpError, type Store } from './store.ts';
import { newId, nowIso, type Row } from './util.ts';

const APPROVAL_TTL_MS = 24 * 3_600_000;
const APPROVAL_TTL_MIN_MS = 60_000;
const APPROVAL_TTL_MAX_MS = 7 * 24 * 3_600_000;
const PENDING_MAX = 10;
const REQUESTS_PER_HOUR = 30;
const TITLE_MAX = 200;
const DETAILS_MAX = 4000;
const FOLLOW_UP_MAX = 20_000;
const NOTE_MAX = 2000;
const TOOL_INPUT_MAX = 64_000;

/** The tool_key of a request the managed browser holds: never the key of a CLI's tool call (those are JSON). */
export const BROWSER_KEY = 'browser-op:';

/** What the approvals need of the managed browser (browser.ts): whether it still holds a request, and to hear of its decision. */
export interface BrowserHolds {
  holds(approvalId: string): boolean;
  decided(approvalId: string): void;
}

/** Where a request comes from when no turn of the Boton is running (a token minted by hand, say). */
const NO_TURN: ApprovalOrigin = { trigger: 'chat', turnId: null, routineId: null, routineName: null, runId: null, sandboxed: false, askedBy: [] };

/** A string field, trimmed; `required` ones are titles, folded to one line. */
function text(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = required ? v.replace(/\s+/g, ' ').trim() : v.trim();
  if (required && !t) throw new HttpError(400, `${field} is required`);
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}

/** Where a request was asked: "a webhook run of routine “Triage”". */
function originText(from: ApprovalOrigin, names = true): string {
  const asked = from.askedBy.length ? ` answering ${from.askedBy.join(' and ')}` : '';
  if (from.trigger === 'chat') return names ? `a chat turn${asked}` : 'a chat turn';
  const run = from.trigger === 'schedule' ? 'scheduled run' : `${from.trigger} run`;
  return names && from.routineName ? `a ${run} of routine “${from.routineName}”` : `a ${run} of a routine`;
}

/** Text that would open or close an <approved_action> block, defused. */
const escapeBlock = (text: string) => text.replace(/<(?=\s*\/?\s*approved_action)/gi, '&lt;');

const pastTense: Record<ApprovalStatus, string> = {
  pending: 'still waiting',
  allowed: 'allowed',
  denied: 'denied',
  expired: 'expired',
  cancelled: 'withdrawn',
};

/** A skill card shows the body too (every Boton would follow it), cut to fit. */
function skillDetails(skill: Pick<Skill, 'description' | 'body'>): string {
  const head = `${skill.description}\n\n---\n\n`;
  const room = DETAILS_MAX - head.length;
  if (skill.body.length <= room) return head + skill.body;
  const note = `\n\n… (${skill.body.length.toLocaleString('en-US')} characters in all: read the rest on the Skills screen before approving it)`;
  return head + skill.body.slice(0, Math.max(0, room - note.length)) + note;
}

export class Approvals {
  #db: DatabaseSync;
  #store: Store;
  #notifier: Notifier;
  #wake: (botId: string) => void;
  #origin: (botId: string) => ApprovalOrigin | null;
  #access: (botId: string) => AccessLevel | null;
  #waitMs: number;
  /** In memory: a restart resets it. */
  #limiter = new RunLimiter(REQUESTS_PER_HOUR, Number.MAX_SAFE_INTEGER);
  /**
   * The one call (its `botons mcp` request) waiting on each paused tool call's card, by approval id: only it is
   * answered with an allow. In memory: a call answered in its turn needs that turn running in this process.
   */
  #waiters = new Map<string, string>();
  skills!: Skills;
  connectors!: Connectors;
  browser: BrowserHolds | null = null;

  constructor(opts: {
    store: Store;
    hub: EventHub;
    notifier: Notifier;
    wake: (botId: string) => void;
    origin: (botId: string) => ApprovalOrigin | null;
    access: (botId: string) => AccessLevel | null;
    waitMs: number;
  }) {
    this.#store = opts.store;
    this.#db = opts.store.db;
    this.#notifier = opts.notifier;
    this.#wake = opts.wake;
    this.#origin = opts.origin;
    this.#access = opts.access;
    this.#waitMs = opts.waitMs;
  }

  #toApproval(r: Row): Approval {
    return {
      id: r.id,
      botId: r.bot_id,
      kind: r.kind,
      title: r.title,
      details: r.details,
      followUp: r.follow_up,
      action: r.action,
      skillName: r.skill_name,
      connectorId: r.connector_id ?? null,
      status: r.status,
      always: !!r.always,
      auto: !!r.auto,
      note: r.note,
      from: {
        trigger: r.trigger,
        turnId: r.turn_id,
        routineId: r.routine_id,
        routineName: r.routine_name,
        runId: r.run_id,
        sandboxed: !!r.sandboxed,
        askedBy: JSON.parse(r.asked_by),
      },
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
      messageId: r.message_id,
      notifications: JSON.parse(r.notifications),
      tool: r.tool_name
        ? toolCall(r)
        : null,
    };
  }

  #select(sql: string, ...args: string[]): Approval[] {
    return this.#db
      .prepare(sql)
      .all(...args)
      .map((r) => this.#toApproval(r as Row));
  }

  find(id: string): Approval | null {
    return this.#select('select * from approvals where id = ?', id)[0] ?? null;
  }

  get(id: string): Approval {
    const a = this.find(id);
    if (!a) throw new HttpError(404, `No approval request with id ${id}`);
    return a;
  }

  /** The Boton a request belongs to, or null. */
  owner(id: string): string | null {
    return (this.#db.prepare('select bot_id from approvals where id = ?').get(id) as Row | undefined)?.bot_id ?? null;
  }

  /** Newest first, at most 200; `status` is "all" or one status (default pending). */
  list(opts: { botId?: string; status?: string | null }): Approval[] {
    const status = opts.status || 'pending';
    if (status !== 'all' && !(status in pastTense)) throw new HttpError(400, 'status must be "all" or one of pending, allowed, denied, expired, cancelled');
    if (opts.botId) this.#store.getBot(opts.botId);
    const where: string[] = [];
    const args: string[] = [];
    if (opts.botId) {
      where.push('bot_id = ?');
      args.push(opts.botId);
    }
    if (status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    return this.#select(`select * from approvals ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc, rowid desc limit 200`, ...args);
  }

  /** The Boton's own action requests still waiting, oldest first (for its context block). */
  pendingFor(botId: string): Approval[] {
    return this.#select("select * from approvals where bot_id = ? and kind in ('action', 'connector') and status = 'pending' order by created_at, rowid", botId);
  }

  /** The owner's own latest decisions on its requests since `since`, newest first (not ones an always-allow rule made). */
  recentDecisions(botId: string, since: Date, limit: number): { title: string; decision: 'allowed' | 'denied'; at: string }[] {
    return (
      this.#db
        .prepare("select title, status, decided_at from approvals where bot_id = ? and status in ('allowed', 'denied') and auto = 0 and decided_at >= ? order by decided_at desc, rowid desc limit ?")
        .all(botId, since.toISOString(), limit) as Row[]
    ).map((r) => ({ title: String(r.title), decision: r.status as 'allowed' | 'denied', at: String(r.decided_at) }));
  }

  #emit(id: string): Approval {
    const approval = this.get(id);
    this.#store.publish({ type: 'approval.upserted', approval });
    return approval;
  }

  #meta(a: Pick<Approval, 'id' | 'title' | 'from'>, kind: MessageMeta['kind']): MessageMeta {
    const run = a.from.routineId ? { routineId: a.from.routineId, ...(a.from.routineName ? { routineName: a.from.routineName } : {}), ...(a.from.runId ? { runId: a.from.runId } : {}) } : {};
    return { kind, approvalId: a.id, approvalTitle: a.title, ...run };
  }

  /** The turn running now as the engine knows it (never what the Boton says); a sandboxed token makes it sandboxed. */
  #from(botId: string, sandboxed: boolean): ApprovalOrigin {
    const turn = this.#origin(botId) ?? NO_TURN;
    return { ...turn, sandboxed: sandboxed || turn.sandboxed };
  }

  /** `botons approval request`, from Boton `botId`'s turn token. */
  request(botId: string, input: ApprovalRequestInput, opts: { sandboxed: boolean }): ApprovalRequestResult {
    const bot = this.#store.getBot(botId);
    const title = text(input.title, 'title', TITLE_MAX, true);
    const details = text(input.details, 'details', DETAILS_MAX);
    const followUp = text(input.followUp, 'followUp', FOLLOW_UP_MAX);
    const action = input.action === undefined || input.action === null || input.action === '' ? null : actionKey(input.action);
    const expiresIn: unknown = input.expiresIn;
    const ttl = expiresIn === undefined || expiresIn === null || expiresIn === '' ? APPROVAL_TTL_MS : typeof expiresIn === 'string' ? parseDuration(expiresIn) : Number.NaN;
    if (Number.isNaN(ttl)) throw new HttpError(400, 'expiresIn must be a duration such as "30m", "2h" or "3d"');
    if (ttl < APPROVAL_TTL_MIN_MS || ttl > APPROVAL_TTL_MAX_MS) {
      throw new HttpError(400, `expiresIn must be between ${formatDuration(APPROVAL_TTL_MIN_MS)} and ${formatDuration(APPROVAL_TTL_MAX_MS)}`);
    }
    const from = this.#from(botId, opts.sandboxed);
    const fields: LogFields = { botId, trigger: from.trigger, routineId: from.routineId ?? undefined, runId: from.runId ?? undefined, turnId: from.turnId ?? undefined, sandboxed: from.sandboxed, action: action ?? undefined };

    // Asked again (a retry, or a turn that forgot it asked): the one already waiting.
    const same = this.#db
      .prepare("select id from approvals where bot_id = ? and kind = 'action' and status = 'pending' and tool_key is null and title = ? and details = ? and follow_up = ? order by created_at limit 1")
      .get(botId, title, details, followUp) as Row | undefined;
    if (same) return { approval: this.get(String(same.id)), duplicate: true };

    this.#limit(botId, fields);
    // Never auto-allowed from a sandboxed turn: its follow-up runs with the Boton's usual access and connectors.
    const auto = !!action && !from.sandboxed && bot.alwaysAllow.includes(action);
    const id = this.#insert(botId, from, { title, details, followUp, action, auto, ttl });
    if (auto) {
      log.info('approval request allowed by an always-allow rule', { ...fields, approvalId: id });
      return { approval: this.#emit(id), duplicate: false };
    }
    const approval = this.#emit(id);
    log.info('approval requested', { ...fields, approvalId: id, expiresAt: approval.expiresAt });
    this.#push(approval, bot);
    return { approval, duplicate: false };
  }

  /** Save an action request with its card (pending), or its chip when allowed at once (`auto`). */
  #insert(
    botId: string,
    from: ApprovalOrigin,
    r: { title: string; details: string; followUp?: string; action: string | null; auto: boolean; ttl: number; tool?: { name: string; input: string; key: string; rule: string | null; waitUntil?: string } },
  ): string {
    const id = newId('apr');
    const now = new Date();
    const at = now.toISOString();
    const { tool } = r;
    this.#store.atomically(() => {
      this.#db
        .prepare(
          `insert into approvals (id, bot_id, kind, title, details, follow_up, action, status, auto, trigger, turn_id, routine_id, routine_name, run_id, sandboxed, asked_by, created_at, expires_at, decided_at,
                                  tool_name, tool_input, tool_key, tool_rule, wait_until, in_turn)
           values (?, ?, 'action', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          botId,
          r.title,
          r.details,
          r.followUp ?? '',
          r.action,
          r.auto ? 'allowed' : 'pending',
          r.auto ? 1 : 0,
          from.trigger,
          from.turnId,
          from.routineId,
          from.routineName,
          from.runId,
          from.sandboxed ? 1 : 0,
          JSON.stringify(from.askedBy),
          at,
          r.auto ? null : new Date(now.getTime() + r.ttl).toISOString(),
          r.auto ? at : null,
          tool?.name ?? null,
          tool?.input ?? null,
          tool?.key ?? null,
          tool?.rule ?? null,
          tool ? (tool.waitUntil ?? at) : null,
          tool && r.auto ? 1 : 0,
        );
      const meta = this.#meta({ id, title: r.title, from }, r.auto ? 'approval.auto' : 'approval.requested');
      const message = r.auto
        ? this.#store.addMessage(botId, 'event', `Allowed without asking: ${r.title}`, { ...meta, approvalAction: r.action! })
        : this.#store.addMessage(botId, 'event', `Asks for your approval: ${r.title}`, meta);
      this.#db.prepare('update approvals set message_id = ? where id = ?').run(message.id, id);
    });
    return id;
  }

  /** Refuse a new request beyond PENDING_MAX waiting (409) or REQUESTS_PER_HOUR (429); else count it. */
  #limit(botId: string, fields: LogFields): void {
    const pending = Number((this.#db.prepare("select count(*) as n from approvals where bot_id = ? and kind = 'action' and status = 'pending'").get(botId) as Row).n);
    if (pending >= PENDING_MAX) {
      const owner = this.#store.getSettings().ownerName;
      throw new HttpError(409, `You already have ${PENDING_MAX} approval requests waiting for ${owner}. Wait for their decisions, or withdraw one with \`botons approval cancel <id>\` (see \`botons approval list\`).`);
    }
    const hit = this.#limiter.check(botId);
    if (hit) {
      const retryAfterS = Math.max(1, Math.ceil(hit.retryAfterMs / 1000));
      log.warn('approval request refused: rate limit', { ...fields, max: hit.max });
      throw new HttpError(429, `You have made ${hit.max} approval requests in the last hour, the limit. Try again in ${Math.ceil(retryAfterS / 60)} minutes, or put it in your reply.`, {
        'retry-after': String(retryAfterS),
      });
    }
    this.#limiter.record(botId);
  }

  /** One push per request, recorded on it; none for a test run (a dry run). */
  #push(a: Approval, bot: { id: string; name: string }) {
    if (a.from.trigger === 'test') return;
    void this.#notifier
      .push({
        bot,
        reason: 'approval',
        detail: `Asks for your approval: ${a.title} (from ${originText(a.from)})${a.followUp ? `. Then: ${a.followUp.replace(/\s+/g, ' ')}` : ''}`,
        generic: `Needs your approval (from ${originText(a.from, false)}).`,
        priority: 'high',
      })
      .then((deliveries) => {
        if (!deliveries.length || !this.find(a.id)) return;
        this.#db.prepare('update approvals set notifications = ? where id = ?').run(JSON.stringify([...a.notifications, ...deliveries]), a.id);
        this.#emit(a.id);
      })
      .catch((err) => log.warn('could not record the push for an approval request', { botId: a.botId, approvalId: a.id, err }));
  }

  /**
   * A permission prompt from the Boton's CLI (`botons mcp`): a call an Ask
   * first rule covers, or (Full computer) one Claude Code asked about.
   */
  toolCall(botId: string, input: ToolCallInput, opts: { sandboxed: boolean }): ToolCallVerdict {
    const bot = this.#store.getBot(botId);
    const toolName = text(input.toolName, 'toolName', 200, true);
    const toolUseId = typeof input.toolUseId === 'string' ? input.toolUseId.slice(0, 200) : undefined;
    const args = input.input ?? {};
    const json = JSON.stringify(args);
    if (json.length > TOOL_INPUT_MAX) throw new HttpError(400, `input must be JSON of at most ${TOOL_INPUT_MAX} characters`);
    const from = this.#from(botId, opts.sandboxed);
    const access = this.#access(botId) ?? (from.sandboxed ? 'workspace' : bot.access);
    const rule = matchRule(bot.askFirst, toolName, args, { cwd: bot.workspace, home: homedir() });
    const key = callKey(toolName, args);
    const fields: LogFields = { botId, trigger: from.trigger, turnId: from.turnId ?? undefined, sandboxed: from.sandboxed, tool: toolName, rule: rule ?? undefined, toolUseId };

    if (!rule && access === 'workspace') {
      const owner = this.#store.getSettings().ownerName;
      log.info('tool call denied: no Ask first rule covers it, and Workspace access does not allow it', fields);
      return {
        behavior: 'deny',
        message: `This call needs more than your Workspace access allows, so it was denied (only calls that one of ${owner}'s Ask first rules covers go to ${owner}). Do the work inside your workspace, or ask ${owner} with \`botons approval request\`.`,
        approval: null,
      };
    }
    const action = rule ? ruleKey(rule) : null;
    const call = { ...describeCall(toolName, args), action, ttl: APPROVAL_TTL_MS };
    if (action && !from.sandboxed && bot.alwaysAllow.includes(action)) {
      const id = this.#insert(botId, from, { ...call, auto: true, tool: { name: toolName, input: json, key, rule } });
      log.info('tool call allowed by an always-allow rule', { ...fields, approvalId: id });
      return { behavior: 'allow', message: null, approval: this.#emit(id) };
    }
    // Allowed after it stopped waiting: this same call (every argument), once, spent as it is handed out (never
    // from a sandboxed turn).
    if (!from.sandboxed) {
      const grants = this.#db
        .prepare("select id, tool_name, tool_input from approvals where bot_id = ? and tool_name = ? and tool_key not like 'browser-op:%' and status = 'allowed' and in_turn = 0 and auto = 0 and used_at is null order by decided_at")
        .all(botId, toolName) as Row[];
      for (const granted of grants.filter((r) => sameCall(r, key))) {
        if (!Number(this.#db.prepare('update approvals set used_at = ? where id = ? and used_at is null').run(nowIso(), granted.id).changes)) continue;
        log.info('tool call allowed: the owner allowed it after it stopped waiting', { ...fields, approvalId: granted.id });
        return { behavior: 'allow', message: null, approval: this.#emit(String(granted.id)) };
      }
    }
    const waitUntil = new Date(Date.now() + this.#waitMs).toISOString();
    const waiter = newId('wt', 16);
    // The same call again while its card waits, from the same kind of turn (so the card's warning holds): it waits on
    // that card, but only once no other call does (each allow answers one call). The call it replaces hears no allow.
    const same = (
      this.#db
        .prepare("select id, tool_name, tool_input from approvals where bot_id = ? and tool_name = ? and tool_key not like 'browser-op:%' and status = 'pending' and sandboxed = ? order by created_at")
        .all(botId, toolName, from.sandboxed ? 1 : 0) as Row[]
    )
      .filter((r) => sameCall(r, key))
      .map((r) => this.get(String(r.id)))
      .find((a) => !this.#waiters.has(a.id) || !this.#waiting(a));
    if (same) {
      this.#db.prepare('update approvals set wait_until = ?, turn_id = ? where id = ?').run(waitUntil, from.turnId, same.id);
      this.#wait(same.id, waiter);
      log.info('tool call waits on its card again', { ...fields, approvalId: same.id });
      return { behavior: 'wait', message: null, approval: this.#emit(same.id), waiter };
    }
    this.#limit(botId, fields);
    const id = this.#insert(botId, from, { ...call, auto: false, tool: { name: toolName, input: json, key, rule, waitUntil } });
    this.#wait(id, waiter);
    log.info('tool call paused for approval', { ...fields, approvalId: id, waitUntil });
    const approval = this.#emit(id);
    this.#push(approval, bot);
    return { behavior: 'wait', message: null, approval, waiter };
  }

  /** `waiter` is now the call waiting on the card; waiters of cards long answered go once there are many. */
  #wait(id: string, waiter: string) {
    if (this.#waiters.size >= 1000) {
      for (const k of this.#waiters.keys()) {
        const a = this.find(k);
        if (!a || (a.status !== 'pending' && !(a.tool?.inTurn && this.#origin(a.botId)?.turnId === a.from.turnId))) this.#waiters.delete(k);
      }
    }
    this.#waiters.set(id, waiter);
  }

  /** Whether a paused call still waits: in its wait, and its turn still running. */
  #waiting(a: Approval): boolean {
    return !!a.tool && a.tool.waitUntil > nowIso() && !!a.from.turnId && this.#origin(a.botId)?.turnId === a.from.turnId;
  }

  /**
   * How a paused call stands, for the CLI waiting on it. `waiter` is the one its toolCall gave it: an allow goes only
   * to the call that waits on the card now, and is spent as it is handed out (asking again hears it again).
   */
  toolVerdict(id: string, waiter: string | null = null): ToolCallVerdict {
    const a = this.get(id);
    if (!a.tool) throw new HttpError(400, `${id} is not a paused tool call`);
    const owner = this.#store.getSettings().ownerName;
    const note = a.note ? ` ${owner}'s note: ${a.note}` : '';
    const deny = (message: string): ToolCallVerdict => ({ behavior: 'deny', message, approval: a });
    const current = this.#waiters.get(a.id);
    const mine = !!waiter && waiter === current;
    if (waiter && current && !mine) {
      return deny(`Another call of yours now waits on this approval card (${a.id}), so this one is denied. Don't retry it in this turn: carry on without it, and say in your reply that it waits for ${owner}.`);
    }
    if (a.status === 'pending') {
      if (a.tool.waitUntil > nowIso()) return { behavior: 'wait', message: null, approval: a };
      return deny(
        `${owner} hasn't decided yet, so this call is denied for now. It stays on ${owner}'s approval card (${a.id}): if ${owner} allows it, you get a new turn in which this same call is allowed once. Don't retry it in this turn or do it another way: carry on without it, and say in your reply that it waits for ${owner}.`,
      );
    }
    if (a.status === 'allowed' && a.tool.inTurn) {
      // Kept for the call it went to, so the same call asking again hears the same answer.
      if (!mine) return deny(`${owner} allowed one call on this card (${a.id}), not this one. Don't make this call in this turn.`);
      if (a.tool.usedAt) return { behavior: 'allow', message: null, approval: a };
      this.#db.prepare('update approvals set used_at = ? where id = ? and used_at is null').run(nowIso(), a.id);
      return { behavior: 'allow', message: null, approval: this.#emit(a.id) };
    }
    this.#waiters.delete(a.id);
    if (a.status === 'denied' && a.tool.inTurn) {
      return deny(`${owner} denied this call${a.tool.rule ? ` (Ask first rule ${a.tool.rule})` : ''}.${note} Don't do it another way; say in your reply that ${owner} denied it.`);
    }
    if (a.status === 'allowed' || a.status === 'denied') {
      return deny(`${owner} decided after this call stopped waiting: you get a new turn with the decision. Don't make this call in this turn.`);
    }
    return deny(a.status === 'expired' ? 'Nobody decided on this call in time, so it was not made.' : 'This request was withdrawn, so the call was not made.');
  }

  /** The owner's decision (the route takes only paired devices). */
  decide(id: string, input: ApprovalDecisionInput, deviceId: string | null): Approval {
    const a = this.get(id);
    if (input.decision !== 'allow' && input.decision !== 'deny') throw new HttpError(400, 'decision must be "allow" or "deny"');
    const allow = input.decision === 'allow';
    const always = flag(input.always, 'always', false);
    const note = text(input.note, 'note', NOTE_MAX) || null;
    if (always && !allow) throw new HttpError(400, 'always goes with allow');
    if (always && !a.action) throw new HttpError(400, "This request names no kind of action, so it can't be always allowed");
    if (a.status === 'pending' && a.expiresAt && a.expiresAt <= nowIso()) this.#expire(a);
    const current = this.get(id);
    if (current.status !== 'pending') throw new HttpError(409, `This request was already ${pastTense[current.status]}`);
    if (a.kind === 'skill') return this.#decideSkill(a, allow, note, deviceId);
    if (a.kind === 'connector') return this.#decideConnector(a, allow, note, deviceId);
    if (a.tool?.browser) return this.#decideBrowser(current, allow, note, deviceId);

    const decision = allow ? 'allowed' : 'denied';
    // A paused call still waiting gets the answer itself: no follow-up turn.
    const inTurn = this.#waiting(current);
    this.#store.atomically(() => {
      const changed = this.#db
        .prepare("update approvals set status = ?, always = ?, note = ?, decided_at = ?, decided_by = ?, in_turn = ? where id = ? and status = 'pending'")
        .run(decision, always ? 1 : 0, note, nowIso(), deviceId, inTurn ? 1 : 0, id).changes;
      if (!Number(changed)) throw new HttpError(409, 'This request was already decided');
      if (always) this.#store.addAlwaysAllow(a.botId, a.action!);
      const meta: MessageMeta = { kind: 'approval.decided', approvalId: id, approvalTitle: a.title, decision, ...(note ? { note } : {}) };
      if (inTurn) this.#store.addMessage(a.botId, 'event', `${allow ? 'Allowed' : 'Denied'}: ${a.title}`, meta);
      // A pending user message: it starts the follow-up turn (see decisionPrompt), and waits out a pause or a usage limit.
      else this.#store.addMessage(a.botId, 'user', `${allow ? 'Allowed' : 'Denied'}: ${a.title}`, meta, true);
    });
    log.info('approval decided', { botId: a.botId, approvalId: id, decision, always, inTurn: inTurn || undefined, deviceId: deviceId ?? undefined });
    const out = this.#emit(id);
    if (!inTurn) this.#wake(a.botId);
    return out;
  }

  /**
   * `botons connector request <id>`: a connector the owner made available on request. Granted at once only if its
   * policy says so and the turn is not sandboxed (a payload from outside must not widen what later turns can reach);
   * else a card, which names the connector by id and the policy generation it was asked under.
   */
  requestConnector(botId: string, connectorId: unknown, opts: { sandboxed: boolean }): ConnectorRequestResult {
    const bot = this.#store.getBot(botId);
    if (typeof connectorId !== 'string' || !/^[a-z]+:[a-z0-9][a-z0-9_-]{0,63}$/.test(connectorId)) throw new HttpError(400, 'connector must be a connector id from `botons connector list`, such as oauth:fleet');
    const view = () => this.connectors.forBoton(this.#store.getBot(botId)).find((c) => c.id === connectorId)!;
    if (bot.connections.includes(connectorId)) return { connector: view(), outcome: 'already', approval: null };
    const problem = this.connectors.grantProblem(bot, connectorId);
    if (problem) throw new HttpError(problem.startsWith('There is no') ? 404 : 403, `${problem}. See \`botons connector list\`.`);
    const policy = this.connectors.policyOf(connectorId);
    const name = this.connectors.catalog().connectors.find((c) => c.id === connectorId)!.name;
    const from = this.#from(botId, opts.sandboxed);
    const fields: LogFields = { botId, connector: connectorId, sandboxed: from.sandboxed, trigger: from.trigger };
    if (policy.grant === 'immediate' && !from.sandboxed) {
      this.#store.atomically(() => this.#grantConnector(botId, connectorId, name, null));
      log.info('connector granted at once on request', fields);
      this.#wake(botId);
      return { connector: view(), outcome: 'granted', approval: null };
    }
    const same = this.#db.prepare("select id from approvals where bot_id = ? and kind = 'connector' and status = 'pending' and connector_id = ? order by created_at limit 1").get(botId, connectorId) as Row | undefined;
    if (same) return { connector: view(), outcome: 'pending', approval: this.get(String(same.id)) };
    this.#limit(botId, fields);
    const id = newId('apr');
    const now = new Date();
    const title = `Give ${bot.name} the connector “${name}”`;
    const details = `${bot.name} asks to use the connector ${name} (${connectorId}). If you allow it, it becomes one of ${bot.name}'s connectors from its next turn, until you take it off in its settings.`;
    this.#store.atomically(() => {
      this.#db
        .prepare(
          `insert into approvals (id, bot_id, kind, title, details, connector_id, connector_generation, status, trigger, turn_id, routine_id, routine_name, run_id, sandboxed, asked_by, created_at, expires_at)
           values (?, ?, 'connector', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, botId, title, details, connectorId, policy.generation, from.trigger, from.turnId, from.routineId, from.routineName, from.runId, from.sandboxed ? 1 : 0, JSON.stringify(from.askedBy), now.toISOString(), new Date(now.getTime() + APPROVAL_TTL_MS).toISOString());
      const card = this.#store.addMessage(botId, 'event', `Asks for your approval: ${title}`, { ...this.#meta({ id, title, from }, 'approval.requested'), connectorId });
      this.#db.prepare('update approvals set message_id = ? where id = ?').run(card.id, id);
    });
    log.info('connector requested: waiting for approval', { ...fields, approvalId: id });
    const approval = this.#emit(id);
    this.#push(approval, bot);
    return { connector: view(), outcome: 'pending', approval };
  }

  /** Inside a transaction: the connector joins the Boton's list, with a chip and a turn that says so. */
  #grantConnector(botId: string, connectorId: string, name: string, approvalId: string | null): void {
    const bot = this.#store.getBot(botId);
    if (!bot.connections.includes(connectorId)) this.#store.setConnections(botId, [...bot.connections, connectorId]);
    this.#store.addMessage(botId, 'user', `Connector ${name} added`, { kind: 'connector.granted', connectorId, ...(approvalId ? { approvalId } : {}) }, true);
  }

  #decideConnector(a: Approval, allow: boolean, note: string | null, deviceId: string | null): Approval {
    // As recorded, unconverted: a missing one (null) or one not issued as connectors.ts issues them is never allowed.
    const generation: unknown = (this.#db.prepare('select connector_generation from approvals where id = ?').get(a.id) as Row).connector_generation;
    const connectorId = a.connectorId ?? '';
    if (allow) {
      // Checked again now: the connector, its policy (same generation) and the Boton's brain may have changed.
      const bot = this.#store.getBot(a.botId);
      const problem = bot.connections.includes(connectorId) ? null : this.connectors.grantProblem(bot, connectorId, generation ?? null);
      if (problem) {
        this.#close(a.id, 'cancelled');
        throw new HttpError(409, `${problem}, so this request was withdrawn.`);
      }
    }
    const decision = allow ? 'allowed' : 'denied';
    this.#store.atomically(() => {
      const changed = this.#db.prepare("update approvals set status = ?, note = ?, decided_at = ?, decided_by = ? where id = ? and status = 'pending'").run(decision, note, nowIso(), deviceId, a.id).changes;
      if (!Number(changed)) throw new HttpError(409, 'This request was already decided');
      const meta: MessageMeta = { kind: 'approval.decided', approvalId: a.id, approvalTitle: a.title, decision, connectorId, ...(note ? { note } : {}) };
      if (allow) {
        const bot = this.#store.getBot(a.botId);
        if (!bot.connections.includes(connectorId)) this.#store.setConnections(a.botId, [...bot.connections, connectorId]);
      }
      this.#store.addMessage(a.botId, 'user', `${allow ? 'Allowed' : 'Denied'}: ${a.title}`, meta, true);
    });
    log.info('approval decided', { botId: a.botId, approvalId: a.id, connector: connectorId, decision, deviceId: deviceId ?? undefined });
    const out = this.#emit(a.id);
    this.#wake(a.botId);
    return out;
  }

  #decideSkill(a: Approval, allow: boolean, note: string | null, deviceId: string | null): Approval {
    const name = a.skillName ?? '';
    const skill = this.skills.find(name);
    if (allow && !skill) {
      this.#close(a.id, 'cancelled');
      throw new HttpError(409, `The skill ${name} no longer exists`);
    }
    // Allowing approves the skill as the card showed it, never a body swapped in since.
    const version = (this.#db.prepare('select skill_version from approvals where id = ?').get(a.id) as Row).skill_version;
    if (allow && skill!.version !== version) {
      throw new HttpError(409, `The skill ${name} has changed since this request was made. Read it again (the newer request, or the Skills screen) before approving it.`);
    }
    const decision = allow ? 'allowed' : 'denied';
    this.#db.prepare("update approvals set status = ?, note = ?, decided_at = ?, decided_by = ? where id = ? and status = 'pending'").run(decision, note, nowIso(), deviceId, a.id);
    // After the update, so Skills.approve finds no card left to resolve.
    if (allow) this.skills.approve(name, version);
    const bot = this.#store.getBot(a.botId);
    this.#store.addMessage(a.botId, 'event', allow ? `Approved the skill ${name} for every Boton` : `Kept the skill ${name} as ${bot.name}'s own`, {
      kind: 'approval.decided',
      approvalId: a.id,
      approvalTitle: a.title,
      decision,
      skillName: name,
      ...(note ? { note } : {}),
    });
    log.info('approval decided', { botId: a.botId, approvalId: a.id, skill: name, decision, deviceId: deviceId ?? undefined });
    return this.#emit(a.id);
  }

  /**
   * A request the managed browser holds (browser.ts), as one card: bound to `key` (the request's fingerprint, see
   * browser-request.ts), waiting until `waitUntil` in the turn running now. Never always-allowed (it names no kind of
   * action) and never auto-allowed: every request the browser would send gets its own card.
   */
  browserRequest(botId: string, r: { title: string; details: string; input: unknown; key: string; waitUntil: string }): Approval {
    const bot = this.#store.getBot(botId);
    const from = this.#from(botId, false);
    const fields: LogFields = { botId, trigger: from.trigger, turnId: from.turnId ?? undefined, tool: 'browser' };
    this.#limit(botId, fields);
    const ttl = Math.max(1000, new Date(r.waitUntil).getTime() - Date.now());
    const id = this.#insert(botId, from, {
      title: r.title,
      details: r.details,
      action: null,
      auto: false,
      ttl,
      tool: { name: 'browser', input: JSON.stringify(r.input), key: `${BROWSER_KEY}${r.key}`, rule: null, waitUntil: r.waitUntil },
    });
    log.info('browser request held for approval', { ...fields, approvalId: id, waitUntil: r.waitUntil });
    const approval = this.#emit(id);
    this.#push(approval, bot);
    return approval;
  }

  /**
   * The owner's decision on a held browser request: only while the browser still holds it, in the turn that made it,
   * and before its wait ends. Otherwise the card is withdrawn (409): nothing is ever sent later, or in another turn.
   */
  #decideBrowser(a: Approval, allow: boolean, note: string | null, deviceId: string | null): Approval {
    // The browser holds a request only inside the turn that made it: its turn ending closes the browser, which withdraws the card.
    const live = a.tool!.waitUntil > nowIso() && !!this.browser?.holds(a.id);
    if (!live) {
      if (this.#close(a.id, 'cancelled')) this.#store.addMessage(a.botId, 'event', `Withdrew an approval request: ${a.title}`, this.#meta(a, 'approval.cancelled'));
      throw new HttpError(409, 'The browser step that held this request has ended, so it was withdrawn and nothing was sent.');
    }
    const decision = allow ? 'allowed' : 'denied';
    this.#store.atomically(() => {
      const changed = this.#db
        .prepare("update approvals set status = ?, note = ?, decided_at = ?, decided_by = ?, in_turn = 1 where id = ? and status = 'pending'")
        .run(decision, note, nowIso(), deviceId, a.id).changes;
      if (!Number(changed)) throw new HttpError(409, 'This request was already decided');
      this.#store.addMessage(a.botId, 'event', `${allow ? 'Allowed' : 'Denied'}: ${a.title}`, { kind: 'approval.decided', approvalId: a.id, approvalTitle: a.title, decision, ...(note ? { note } : {}) });
    });
    log.info('approval decided', { botId: a.botId, approvalId: a.id, decision, tool: 'browser', deviceId: deviceId ?? undefined });
    const out = this.#emit(a.id);
    this.browser?.decided(a.id);
    return out;
  }

  /**
   * The browser is about to send an allowed request: spent here, once (whoever comes second gets false), and only for
   * the fingerprint the card was made for.
   */
  spendBrowser(id: string, key: string): boolean {
    const changed = Number(
      this.#db
        .prepare("update approvals set used_at = ?, tool_input = json_set(tool_input, '$.delivery', 'sending') where id = ? and tool_key = ? and status = 'allowed' and in_turn = 1 and used_at is null")
        .run(nowIso(), id, `${BROWSER_KEY}${key}`).changes,
    );
    if (changed) this.#emit(id);
    return changed > 0;
  }

  /**
   * What became of a spent browser request: `sent` (the site answered), `not-sent` (it failed before it left), or
   * `unknown` (it was written and the connection broke before an answer: the site may have acted on it). Until this is
   * recorded it stays `sending`, which reads as unknown too (the server stopped mid-send).
   */
  browserDelivered(id: string, delivery: 'sent' | 'not-sent' | 'unknown'): void {
    const changed = Number(
      this.#db.prepare("update approvals set tool_input = json_set(tool_input, '$.delivery', ?) where id = ? and used_at is not null and json_extract(tool_input, '$.delivery') = 'sending'").run(delivery, id).changes,
    );
    if (changed) this.#emit(id);
  }

  /**
   * The browser no longer holds a request whose card still waits: its wait ran out (`time`), or the browser closed
   * (the turn ended, Stop, the connector taken away). Withdrawn; false if it was decided first.
   */
  endBrowserWait(id: string, reason: 'time' | 'closed'): boolean {
    const a = this.find(id);
    if (!a || !this.#close(id, 'cancelled')) return false;
    const why = reason === 'time' ? 'nobody decided while the browser step waited' : 'the browser closed';
    this.#store.addMessage(a.botId, 'event', `Withdrew an approval request (${why}, so nothing was sent): ${a.title}`, this.#meta(a, 'approval.cancelled'));
    log.info('browser request withdrawn', { botId: a.botId, approvalId: id, timedOut: reason === 'time' });
    return true;
  }

  /**
   * `botons approval cancel`. A sandboxed turn may withdraw only requests
   * sandboxed turns made: else an outside payload could change what later turns do.
   */
  cancel(id: string, opts: { sandboxed: boolean }): Approval {
    const a = this.get(id);
    if (opts.sandboxed && !a.from.sandboxed) {
      throw new HttpError(403, `This run was started by a webhook, so it can only withdraw requests that webhook runs made, not ${a.id}, which ${originText(a.from)} made.`);
    }
    if (a.status !== 'pending') throw new HttpError(409, `This request was already ${pastTense[a.status]}`);
    this.#close(a.id, 'cancelled');
    this.#store.addMessage(a.botId, 'event', `Withdrew an approval request: ${a.title}`, this.#meta(a, 'approval.cancelled'));
    log.info('approval request withdrawn', { botId: a.botId, approvalId: id });
    return this.get(id);
  }

  /** End a pending request (no message). Returns whether it was still pending. */
  #close(id: string, status: 'expired' | 'cancelled' | 'allowed'): boolean {
    const changed = Number(this.#db.prepare("update approvals set status = ?, decided_at = ? where id = ? and status = 'pending'").run(status, nowIso(), id).changes);
    if (changed) {
      const a = this.#emit(id);
      if (a.tool?.browser) this.#store.afterCommit(() => this.browser?.decided(id));
    }
    return changed > 0;
  }

  #expire(a: Approval): void {
    if (!this.#close(a.id, 'expired')) return;
    this.#store.addMessage(a.botId, 'event', `Approval request expired: ${a.title}`, this.#meta(a, 'approval.expired'));
    log.info('approval request expired', { botId: a.botId, approvalId: a.id });
  }

  /** Expire the requests whose time has come (every scheduler tick, and at startup). Returns how many. */
  expireDue(now = new Date()): number {
    const due = this.#select("select * from approvals where status = 'pending' and expires_at is not null and expires_at <= ? order by expires_at", now.toISOString());
    for (const a of due) {
      try {
        this.#expire(a);
      } catch (err) {
        log.error('could not expire an approval request', { botId: a.botId, approvalId: a.id, err });
      }
    }
    return due.length;
  }

  /**
   * A Boton saved or changed `skill`: a card that allows exactly this version.
   * A card waiting for an earlier version is withdrawn first. No push and no expiry.
   */
  forSkill(botId: string, skill: Skill): void {
    const name = skill.name;
    const open = this.#db
      .prepare("select * from approvals where kind = 'skill' and skill_name = ? and status = 'pending'")
      .all(name)
      .map((r) => ({ a: this.#toApproval(r as Row), version: (r as Row).skill_version as string | null }));
    if (open.length === 1 && open[0].version === skill.version) return;
    for (const { a } of open) {
      if (!this.#close(a.id, 'cancelled')) continue;
      this.#store.addMessage(a.botId, 'event', `Changed the skill ${name} while it waited, so the request to approve it starts over`, {
        ...this.#meta(a, 'approval.cancelled'),
        skillName: name,
      });
    }
    const from = this.#from(botId, false);
    const id = newId('apr');
    const title = `Let the other Botons use the skill “${name}”`;
    this.#store.atomically(() => {
      this.#db
        .prepare(
          `insert into approvals (id, bot_id, kind, title, details, skill_name, skill_version, status, trigger, turn_id, routine_id, routine_name, run_id, sandboxed, asked_by, created_at)
           values (?, ?, 'skill', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, botId, title, skillDetails(skill), name, skill.version, from.trigger, from.turnId, from.routineId, from.routineName, from.runId, from.sandboxed ? 1 : 0, JSON.stringify(from.askedBy), nowIso());
      const card = this.#store.addMessage(botId, 'event', `Asks you to approve the skill ${name}`, { ...this.#meta({ id, title, from }, 'approval.requested'), skillName: name });
      this.#db.prepare('update approvals set message_id = ? where id = ?').run(card.id, id);
    });
    log.info('skill waiting for approval', { botId, approvalId: id, skill: name, version: skill.version });
    this.#emit(id);
  }

  /** Skill `name` was approved or edited by the owner (`allowed`), or deleted (`cancelled`): close its waiting card. */
  resolveSkill(name: string, status: 'allowed' | 'cancelled'): void {
    const open = this.#db.prepare("select id from approvals where kind = 'skill' and skill_name = ? and status = 'pending'").all(name) as Row[];
    for (const r of open) this.#close(r.id, status);
  }

  /** What the follow-up turn reads for a decision message: built from the request as saved, never from the message's text. */
  decisionPrompt(m: Message, owner: string): string {
    const found = m.meta?.approvalId ? this.find(m.meta.approvalId) : null;
    if (!found) return `(From the Botons server: ${owner} decided on one of your approval requests, which no longer exists: ${escapeBlock(m.text)})`;
    // The Boton wrote these: none of it may open or close the block below.
    const a = { ...found, title: escapeBlock(found.title), details: escapeBlock(found.details), followUp: escapeBlock(found.followUp) };
    const note = a.note ? `\n${owner}'s note: ${a.note}` : '';
    if (a.kind === 'connector') {
      const id = escapeBlock(a.connectorId ?? '');
      return a.status === 'denied'
        ? `(From the Botons server: ${owner} denied your request ${a.id} for the connector ${id}. Don't try to reach it another way.)${note}\nSay briefly what you will do instead, if anything.`
        : `(From the Botons server: ${owner} allowed your request ${a.id}: the connector ${id} is yours from this turn on; its tools are listed with your connectors.)${note}\nCarry on with what you needed it for, then say what you did.`;
    }
    if (a.status === 'denied') {
      return `(From the Botons server: ${owner} denied your approval request ${a.id}, “${a.title}”. Don't do it.)${note}
Say briefly what you will do instead, if anything.`;
    }
    const always = a.always && a.action ? ` ${owner} also always allows “${a.action}” from now on: a request with --action "${a.action}" comes back allowed at once.` : '';
    const outside = a.from.sandboxed
      ? `\nYou wrote this request during ${originText(a.from)}, whose payload came from outside. ${owner} read it on the approval card and allowed exactly this; this turn has your usual access and connectors.`
      : `\nYou asked during ${originText(a.from)}.`;
    if (a.tool?.browser) {
      return `(From the Botons server: ${owner} decided on your browser's request ${a.id} after the browser step ended, so nothing was sent. Don't send it another way; read the page again if you still need it.)`;
    }
    if (a.tool) {
      const rule = a.tool.rule ? `${owner}'s Ask first rule ${escapeBlock(a.tool.rule)}` : 'Claude Code';
      return `(From the Botons server: ${owner} allowed your approval request ${a.id}, “${a.title}”.${always})${note}
It is a tool call ${rule} paused during ${originText(a.from)}, which stopped waiting before ${owner} decided. Make that same call again now (${escapeBlock(a.tool.name)}, with the same input): it is allowed once.
<approved_action id="${a.id}">
${a.details || a.title}
</approved_action>
Only this call was allowed, nothing more. When you are done, say what you did.`;
    }
    const what = a.followUp || [a.title, a.details].filter(Boolean).join('\n');
    return `(From the Botons server: ${owner} allowed your approval request ${a.id}, “${a.title}”.${always})${note}${outside}
Do it now, as you said you would once allowed:
<approved_action id="${a.id}">
${what}
</approved_action>
Only this was allowed, nothing more. When you are done, say what you did.`;
  }
}

/** A paused or held tool call, as the owner sees it; a browser request's delivery comes from its input (no column of its own). */
/**
 * Whether a stored tool call is the call with this key, judged from its whole stored input rather than its stored key
 * (a key made by a rule that left an argument out names more than the one call its card shows).
 */
function sameCall(r: Row, key: string): boolean {
  try {
    return !!r.tool_name && r.tool_input != null && callKey(r.tool_name, JSON.parse(r.tool_input)) === key;
  } catch {
    return false;
  }
}

function toolCall(r: Row): ApprovalToolCall {
  const input = JSON.parse(r.tool_input ?? 'null');
  const browser = String(r.tool_key ?? '').startsWith(BROWSER_KEY);
  const d = browser && input && typeof input === 'object' ? (input as { delivery?: unknown }).delivery : undefined;
  const delivery = d === 'sending' || d === 'sent' || d === 'not-sent' || d === 'unknown' ? d : null;
  if (delivery) delete (input as { delivery?: unknown }).delivery;
  return { name: r.tool_name!, input, rule: r.tool_rule, waitUntil: r.wait_until!, inTurn: !!r.in_turn, usedAt: r.used_at, browser, delivery };
}
