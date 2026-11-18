// The rules of Teams, as pure code: limits, who may do which item action, when the supervisor looks again, what
// counts as a stall or a hold, the escalation gates, which audience a chat turn answers, and the words the apps show.
// The server enforces these; the web app and the CLI read them. Builtins only (the `botons` CLI imports it).

import type {
  TeamBlockedNeed,
  TeamDelivery,
  TeamEventKind,
  TeamEvidence,
  TeamItem,
  TeamItemAction,
  TeamItemStatus,
  TeamItemWaiting,
  TeamLimits,
  TeamRefusalCode,
  TeamState,
  TeamPausedReason,
} from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Fixed bounds. Every hourly and daily count is a SQL count, so a restart resets none of them. */
export const TEAM_LIMITS = {
  membersPerTeam: 8,
  teamsPerBot: 5,
  teams: 20,
  openItemsPerTeam: 30,
  /** Items a team's Botons may add in a day (the owner's own are not counted or refused). */
  itemsPerTeamPerDay: 60,
  /** Check-ins about one item before the server escalates it itself. */
  maxNudges: 3,
  messagesPerTeamPerHour: 60,
  messagesPerThread: 200,
  /** queued + dispatched for one recipient. */
  recipientBacklog: 10,
  /** In a recipient's chat at once. */
  dispatchedPerRecipient: 3,
  deliveryTtlMs: 24 * HOUR,
  checkinsPerTeamPerHour: 6,
  escalationsPerTeamPerDay: 5,
  /** An item not done or blocked this long after its assignment began gets a check-in, progress or not. */
  genOverdueMs: 24 * HOUR,
  /** The owner's messages go first, unless another audience's oldest has waited this long. */
  ownerFirstStarveMs: 10 * MINUTE,
  /** How soon after a usage limit resets an item held by it is looked at again. */
  usageLimitGraceMs: 5 * MINUTE,
  /** A held item is looked at again this often (it only waits for the owner). */
  heldRecheckMs: 24 * HOUR,
  evidenceMax: 6,
  eventsPerItem: 300,
  eventsPerTeam: 2000,
  /** An unanswered escalation card's life. */
  escalationTtlMs: 7 * 24 * HOUR,
} as const;

/** Per item, never reset (not even by the owner's answer to an escalation): past one, the item waits for the owner. */
export const TEAM_LIFETIME = {
  attempts: 12,
  checkins: 24,
  escalations: 3,
  progressPerGen: 200,
} as const;

export const TEAM_LIMIT_DEFAULTS: TeamLimits = {
  stallAfterMs: 30 * MINUTE,
  startWithinMs: 15 * MINUTE,
  maxAttempts: 3,
  messagesPerDay: 300,
  checkinsPerDay: 40,
};

/** What the owner may set each tunable limit to, inclusive. */
export const TEAM_LIMIT_BOUNDS: Record<keyof TeamLimits, readonly [number, number]> = {
  stallAfterMs: [5 * MINUTE, 24 * HOUR],
  startWithinMs: [5 * MINUTE, 24 * HOUR],
  maxAttempts: [1, 6],
  messagesPerDay: [20, 1000],
  checkinsPerDay: [5, 100],
};

/** The stored overrides, read leniently: anything not a whole number in bounds falls back to its default. */
export function teamLimits(overrides: unknown): TeamLimits {
  const o = overrides && typeof overrides === 'object' ? (overrides as Record<string, unknown>) : {};
  const out = { ...TEAM_LIMIT_DEFAULTS };
  for (const key of Object.keys(TEAM_LIMIT_BOUNDS) as (keyof TeamLimits)[]) {
    const v = o[key];
    const [min, max] = TEAM_LIMIT_BOUNDS[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}

/** The owner's change to a team's limits: null when it is valid, else what is wrong. */
export function limitsRefusal(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'limits must be an object';
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    const bounds = TEAM_LIMIT_BOUNDS[key as keyof TeamLimits];
    if (!bounds) return `Unknown limit ${key}`;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < bounds[0] || v > bounds[1]) return `${key} must be a whole number from ${bounds[0]} to ${bounds[1]}`;
  }
  return null;
}

/** The longest each text may be, in characters. */
export const TEAM_TEXT = {
  name: 60,
  goal: 4000,
  roleTitle: 60,
  responsibilities: 600,
  itemTitle: 120,
  itemDetail: 4000,
  result: 2000,
  reason: 600,
  note: 2000,
  escalationSummary: 300,
  escalationTried: 600,
  escalationNeed: 300,
  completionSummary: 2000,
  completionScope: 2000,
  subject: 120,
  key: 120,
  message: 20_000,
} as const;

// ------------------------------------------------------------------ roles and transitions

/** Who acts on an item: the owner, the team's lead, the item's assignee, or any other member. */
export type TeamActor = 'owner' | 'lead' | 'assignee' | 'member';

export interface ItemTransition {
  from: readonly TeamItemStatus[];
  by: readonly TeamActor[];
  /** null: the status stays. */
  to: TeamItemStatus | null;
  /** It begins or ends an assignment: the item's gen moves on, and anything about the old one is fenced off. */
  bumpsGen: boolean;
  /** Counts toward attempts (and the lifetime attempts). */
  attempt: boolean;
  /** Sends the assignee its request in the item's thread. */
  sends: boolean;
  needs: readonly ('assigneeBotId' | 'reason' | 'need' | 'result' | 'note')[];
}

export const ITEM_TRANSITIONS: Record<TeamItemAction, ItemTransition> = {
  assign: { from: ['open', 'working', 'blocked'], by: ['owner', 'lead'], to: 'open', bumpsGen: true, attempt: true, sends: true, needs: ['assigneeBotId'] },
  start: { from: ['open'], by: ['assignee'], to: 'working', bumpsGen: false, attempt: false, sends: false, needs: [] },
  progress: { from: ['working'], by: ['assignee'], to: null, bumpsGen: false, attempt: false, sends: false, needs: ['note'] },
  block: { from: ['open', 'working'], by: ['assignee'], to: 'blocked', bumpsGen: false, attempt: false, sends: false, needs: ['reason', 'need'] },
  done: { from: ['open', 'working'], by: ['assignee', 'lead', 'owner'], to: 'done', bumpsGen: true, attempt: false, sends: false, needs: ['result'] },
  retry: { from: ['blocked'], by: ['lead', 'owner'], to: 'open', bumpsGen: true, attempt: true, sends: true, needs: [] },
  cancel: { from: ['open', 'working', 'blocked', 'done'], by: ['lead', 'owner'], to: 'cancelled', bumpsGen: true, attempt: false, sends: false, needs: ['reason'] },
  // Reopened unassigned: the lead (or the owner) assigns it again, which is a new attempt.
  reopen: { from: ['done', 'cancelled'], by: ['lead', 'owner'], to: 'open', bumpsGen: true, attempt: false, sends: false, needs: [] },
};

export const ITEM_ACTIONS = Object.keys(ITEM_TRANSITIONS) as TeamItemAction[];

/** The role an actor plays for one item: the lead stays the lead even when it holds the item itself. */
export function actorFor(opts: { owner?: boolean; botId?: string | null; leadBotId: string | null; assigneeBotId: string | null }): TeamActor {
  if (opts.owner) return 'owner';
  if (opts.botId && opts.botId === opts.leadBotId) return 'lead';
  if (opts.botId && opts.botId === opts.assigneeBotId) return 'assignee';
  return 'member';
}

export interface TeamRefusal {
  code: TeamRefusalCode;
  message: string;
}

const refuse = (code: TeamRefusalCode, message: string): TeamRefusal => ({ code, message });

/**
 * Whether `actor` may take `action` on an item now. A lead that is also the assignee may do what either may.
 * Inputs are checked for presence here; their lengths are checked where they are read.
 */
export function transitionRefusal(
  action: TeamItemAction,
  actor: TeamActor,
  item: Pick<TeamItem, 'id' | 'status' | 'assigneeBotId' | 'held' | 'lifetime' | 'attempts'> & { progressNotes?: number },
  ctx: { teamState: TeamState; maxAttempts: number; leadIsAssignee?: boolean; input?: Partial<Record<ItemTransition['needs'][number], unknown>> },
): TeamRefusal | null {
  const t = ITEM_TRANSITIONS[action];
  if (!t) return refuse('not_allowed', `Unknown action ${String(action)}`);
  const roles: TeamActor[] = actor === 'lead' && ctx.leadIsAssignee ? ['lead', 'assignee'] : [actor];
  if (!roles.some((r) => t.by.includes(r))) return refuse('not_allowed', `${whoMay(t.by)} can ${action} an item.`);
  if (actor !== 'owner') {
    if (ctx.teamState !== 'active' && ctx.teamState !== 'paused') return refuse('team_not_active', `The team is ${ctx.teamState}: only the owner can change its items.`);
    // While paused, the record keeps going (so a turn that was running can end its work properly), but nothing is sent.
    if (ctx.teamState === 'paused' && t.sends) return refuse('team_not_active', 'The team is paused: nothing is assigned or retried until the owner resumes it.');
    // Held for the owner: nothing that starts another attempt. The assignee still ends its own work (a result is never
    // lost), and the lead may still cancel it.
    if (item.held && (action === 'assign' || action === 'retry' || action === 'reopen')) {
      return refuse('limit', `${item.id} is held for the owner: it reached a lifetime limit, so only the owner can give it out again.`);
    }
  }
  if (!t.from.includes(item.status)) return refuse('not_allowed', `${item.id} is ${item.status}: ${action} needs it ${t.from.join(' or ')}.`);
  for (const need of t.needs) {
    const v = ctx.input?.[need];
    if (typeof v !== 'string' || !v.trim()) return refuse('not_allowed', `${action} needs --${need === 'assigneeBotId' ? 'assignee' : need}.`);
  }
  if (action === 'block' && ctx.input?.need !== 'lead' && ctx.input?.need !== 'owner') return refuse('not_allowed', 'block needs --need lead or --need owner.');
  if (t.attempt && actor !== 'owner') {
    if (item.attempts >= ctx.maxAttempts) return refuse('limit', `${item.id} has had ${item.attempts} attempts, its limit. Escalate it to the owner or cancel it with a reason.`);
    if (item.lifetime.attempts >= TEAM_LIFETIME.attempts) return refuse('limit', `${item.id} has had ${TEAM_LIFETIME.attempts} attempts in all, the lifetime limit: only the owner can assign it now.`);
  }
  if (action === 'progress' && (item.progressNotes ?? 0) >= TEAM_LIFETIME.progressPerGen) {
    return refuse('limit', `${item.id} has ${TEAM_LIFETIME.progressPerGen} progress notes on this assignment, the limit. Mark it done or blocked.`);
  }
  return null;
}

function whoMay(by: readonly TeamActor[]): string {
  const names = by.map((r) => ({ owner: 'the owner', lead: 'the lead', assignee: 'the assignee', member: 'a member' })[r]);
  const text = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ------------------------------------------------------------------ turn scope (assignment fencing)

/** The item gens a turn may act on: taken when it starts, changed only by its own successful actions. */
export type TurnScope = Map<string, number>;

/**
 * Whether a Boton's turn may act on this item now (see the scope rules in the module comment of server/src/teams.ts):
 * the item must be in the turn's scope at exactly its current gen. Reading the item never changes the scope.
 */
export function scopeRefusal(
  scope: ReadonlyMap<string, number> | null,
  item: Pick<TeamItem, 'id' | 'gen' | 'status' | 'assigneeBotId' | 'assigneeName'>,
  actor: TeamActor,
): TeamRefusal | null {
  if (actor === 'owner') return null;
  if (!scope) return refuse('not_in_turn', 'Team actions are taken during a turn, with `botons team`.');
  const had = scope.get(item.id);
  if (had === undefined) {
    return refuse('not_in_turn', `${item.id} was given to you after this turn started (assignment ${item.gen}). It arrives as its own request; don't act on it in this turn.`);
  }
  if (had === item.gen) return null;
  const now = `now assignment ${item.gen}, ${item.status}${item.assigneeName ? `, ${item.assigneeName}` : ''}`;
  if (actor === 'lead') return refuse('changed', `${item.id} changed during this turn (${now}). A check-in will bring it; don't act on it in this turn.`);
  return refuse('replaced', `Assignment ${had} of ${item.id} was replaced (${now}). Stop work on it; your reply is kept as about the replaced assignment.`);
}

// ------------------------------------------------------------------ the supervisor's schedule

/**
 * The one schedule. The first check-in comes when the condition first holds (a stall: last activity + stallAfterMs;
 * not started: its assignment + startWithinMs). After check-in n (nudges = n), the next look is stallAfterMs × 2^n.
 * At the look after check-in maxNudges, with nothing changed, the server escalates it. Defaults: 0:30, 1:30, 3:30,
 * then one escalation at 7:30.
 */
export function afterCheckinMs(nudges: number, limits: Pick<TeamLimits, 'stallAfterMs'>): number {
  return limits.stallAfterMs * 2 ** Math.max(1, nudges);
}

/** What the supervisor knows about an item's assignee and its work, from the engine and the database. */
export interface AssessFacts {
  /** missing: none assigned, or its Boton is gone. running/queued: the engine says so. */
  assignee: 'missing' | 'paused' | 'running' | 'queued' | 'idle';
  /** Its assignment request has not been answered yet (queued, or in its chat, started or not). */
  requestOpen: boolean;
  /** A pending approval or card of the assignee's, or its browser handed to the owner, from while this assignment was current. */
  waitingOwner: boolean;
  usageLimitUntil: string | null;
  /** The assignee asked a teammate about this item, that is still open, and the teammate is not paused. */
  teammateAsked: boolean;
  /** The team is not active. */
  teamPaused: boolean;
}

export type AssessItem = Pick<TeamItem, 'status' | 'assigneeBotId' | 'nudges' | 'lastActivityAt' | 'held' | 'escalation' | 'lifetime'> & {
  genStartedAt: string;
};

export type CheckinReason = 'stalled' | 'not_started' | 'unassigned' | 'blocked' | 'overdue' | 'unavailable';

export type Assessment =
  /** Terminal: nothing to watch. */
  | { kind: 'none' }
  /** Justified waiting: no nudge; look again at `at`. */
  | { kind: 'hold'; waiting: TeamItemWaiting; at: string }
  /** Nothing due yet: look again at `at`. */
  | { kind: 'wait'; at: string }
  /** Wake the lead; the caller adds 1 to nudges and looks again afterCheckinMs(nudges + 1) later. */
  | { kind: 'checkin'; reason: CheckinReason }
  /** The nudge cap with nothing changed: the server escalates it (escalateByServer). */
  | { kind: 'escalate' }
  /** A lifetime bound (check-ins or escalations) reached: it waits for the owner, with no more check-ins. */
  | { kind: 'held' };

const at = (ms: number) => new Date(ms).toISOString();

/**
 * What the supervisor does about one item it looks at now (`now` at or after the item's next_check_at). The holds that
 * stop any check-in come first (held, the team paused, an escalation open, the assignee paused or at a usage limit);
 * then, unless the assignment is past its age bound, the holds of work going on (approval, running, a teammate asked).
 */
export function assess(item: AssessItem, facts: AssessFacts, now: number, limits: TeamLimits): Assessment {
  if (item.status === 'done' || item.status === 'cancelled') return { kind: 'none' };
  if (item.held) return { kind: 'hold', waiting: 'held', at: at(now + TEAM_LIMITS.heldRecheckMs) };
  const recheck = at(now + limits.stallAfterMs);
  if (facts.teamPaused) return { kind: 'hold', waiting: 'team_paused', at: recheck };
  if (item.escalation) return { kind: 'hold', waiting: 'owner', at: recheck };
  if (item.status !== 'blocked') {
    if (facts.assignee === 'paused') return { kind: 'hold', waiting: 'paused', at: recheck };
    if (facts.usageLimitUntil && Date.parse(facts.usageLimitUntil) > now) {
      return { kind: 'hold', waiting: 'usage_limit', at: at(Date.parse(facts.usageLimitUntil) + TEAM_LIMITS.usageLimitGraceMs) };
    }
  }
  // Past the age bound, work going on is no reason to wait: the lead hears it is overdue.
  const overdue = item.status !== 'blocked' && facts.assignee !== 'missing' && now - Date.parse(item.genStartedAt) >= TEAM_LIMITS.genOverdueMs;
  if (!overdue) {
    if (facts.waitingOwner) return { kind: 'hold', waiting: 'approval', at: recheck };
    if (item.status !== 'blocked') {
      if (facts.assignee === 'running' || facts.assignee === 'queued' || facts.requestOpen) return { kind: 'hold', waiting: 'running', at: recheck };
      if (facts.teammateAsked) return { kind: 'hold', waiting: 'teammate', at: recheck };
    }
  }
  const reason: CheckinReason =
    item.status === 'blocked'
      ? 'blocked'
      : facts.assignee === 'missing'
        ? item.assigneeBotId
          ? 'unavailable'
          : 'unassigned'
        : overdue
          ? 'overdue'
          : item.status === 'open'
            ? 'not_started'
            : 'stalled';
  if (item.nudges === 0) {
    // The first check-in waits for the condition to have held its full time.
    const since = reason === 'not_started' || reason === 'unassigned' ? Date.parse(item.genStartedAt) : Date.parse(item.lastActivityAt);
    const threshold = reason === 'not_started' || reason === 'unassigned' ? limits.startWithinMs : limits.stallAfterMs;
    if (reason !== 'overdue' && reason !== 'unavailable' && now < since + threshold) return { kind: 'wait', at: at(since + threshold) };
  } else if (reason === 'stalled' && now < Date.parse(item.lastActivityAt) + limits.stallAfterMs) {
    // Progress keeps it from stalling (it doesn't take the count back): look again a stall time after the last of it.
    return { kind: 'wait', at: at(Date.parse(item.lastActivityAt) + limits.stallAfterMs) };
  }
  // A lifetime bound reached: no more check-ins and no more escalations, the item waits for the owner.
  if (item.lifetime.checkins >= TEAM_LIFETIME.checkins || item.lifetime.escalations >= TEAM_LIFETIME.escalations) return { kind: 'held' };
  if (item.nudges >= TEAM_LIMITS.maxNudges) return { kind: 'escalate' };
  return { kind: 'checkin', reason };
}

/** Team-wide wakes, looked at on every tick apart from any item's next_check_at (a finished item has none). */
export function assessTeam(team: {
  state: TeamState;
  counts: Record<TeamItemStatus, number>;
  kickoffToldAt: string | null;
  wrapupToldAt: string | null;
  lastTerminalAt: string | null;
}): 'kickoff' | 'all_done' | null {
  if (team.state !== 'active') return null;
  const total = Object.values(team.counts).reduce((a, b) => a + b, 0);
  if (total === 0) return team.kickoffToldAt ? null : 'kickoff';
  const live = team.counts.open + team.counts.working + team.counts.blocked;
  if (live === 0 && team.counts.done > 0 && (!team.wrapupToldAt || (team.lastTerminalAt !== null && team.wrapupToldAt < team.lastTerminalAt))) return 'all_done';
  return null;
}

// ------------------------------------------------------------------ escalation gates

/** Facts the server wrote (or the assignee's own block), never the lead's say-so: what an escalation may rest on. */
export const EVIDENCE_KINDS: ReadonlySet<TeamEventKind> = new Set(['blocked', 'turn_failed', 'silent_end', 'stalled', 'not_started', 'overdue', 'unavailable', 'expired', 'checkin', 'stopped']);

/** The newest facts of the item's current gen, at most evidenceMax, newest last. */
export function addEvidence(list: TeamEvidence[], fact: TeamEvidence): TeamEvidence[] {
  if (!EVIDENCE_KINDS.has(fact.kind)) return list;
  return [...list.filter((e) => e.gen === fact.gen), fact].slice(-TEAM_LIMITS.evidenceMax);
}

/** The lead's `botons team escalate`: null when it may, else what is missing. */
export function leadEscalationRefusal(
  item: Pick<TeamItem, 'id' | 'status' | 'attempts' | 'nudges' | 'blockedNeed' | 'evidence' | 'escalation' | 'gen' | 'assigneeName'>,
  ctx: { maxAttempts: number; leadTried: boolean; escalationsToday: number; input: { summary?: unknown; tried?: unknown; need?: unknown } },
): TeamRefusal | null {
  if (item.status !== 'blocked' && item.attempts < ctx.maxAttempts && item.nudges < TEAM_LIMITS.maxNudges) {
    return refuse('gate', `${item.id} is ${item.status}, not blocked, and has not run out of attempts or check-ins. Escalate only what is stuck.`);
  }
  const evidence = item.evidence.filter((e) => e.gen === item.gen && EVIDENCE_KINDS.has(e.kind));
  if (!evidence.length) {
    const who = item.assigneeName ?? 'the assignee';
    return refuse('gate', `Nothing on record shows this is blocked. Retry or reassign it first, or have ${who} record the block with \`botons team item block\`.`);
  }
  if (item.blockedNeed !== 'owner' && !ctx.leadTried && item.attempts < 2) {
    return refuse('gate', `Try something first: retry it or give it to someone else, unless ${item.assigneeName ?? 'the assignee'} says it needs the owner.`);
  }
  const missing = (['summary', 'tried', 'need'] as const).filter((k) => typeof ctx.input[k] !== 'string' || !(ctx.input[k] as string).trim());
  if (missing.length) return refuse('gate', `An escalation needs ${missing.map((k) => `--${k}`).join(', ')}: what is wrong, what was tried, and exactly what the owner must decide or do.`);
  if (ctx.escalationsToday >= TEAM_LIMITS.escalationsPerTeamPerDay) return refuse('limit', `This team has escalated ${TEAM_LIMITS.escalationsPerTeamPerDay} items today, the limit.`);
  return null;
}

/** `botons team done`: null when the lead may finish the team, else why not. */
export function completionRefusal(items: Pick<TeamItem, 'id' | 'status' | 'closedBy'>[], ctx: { leadBotId: string; summary?: unknown; scope?: unknown }): TeamRefusal | null {
  const live = items.filter((i) => i.status === 'open' || i.status === 'working' || i.status === 'blocked');
  if (live.length) return refuse('gate', `${live.map((i) => i.id).join(', ')} ${live.length === 1 ? 'is' : 'are'} not finished: finish, cancel with a reason, or escalate each one first.`);
  if (!items.some((i) => i.status === 'done')) return refuse('gate', 'No item is done: a team finishes with work done, not only cancelled.');
  if (typeof ctx.summary !== 'string' || !ctx.summary.trim()) return refuse('gate', 'Finishing needs --summary: what the team delivered, and where.');
  const cancelledByLead = items.some((i) => i.status === 'cancelled' && i.closedBy === ctx.leadBotId);
  if (cancelledByLead && (typeof ctx.scope !== 'string' || !ctx.scope.trim())) {
    return refuse('gate', 'You cancelled some of the work, so finishing needs --scope: what was left out of the goal and why.');
  }
  return null;
}

// ------------------------------------------------------------------ chat audiences (the owner first)

/** Which reply a pending chat message waits for: the owner's, one colleague's (an ask), or a team's (check-ins and team replies). */
export function audienceOf(meta: { kind?: string; fromBotId?: string; teamId?: string } | null | undefined): string {
  if (meta?.kind === 'ask') return `ask:${meta.fromBotId ?? ''}`;
  if (meta?.kind === 'team.checkin' || (meta?.kind === 'ask.reply' && meta.teamId)) return `team:${meta.teamId ?? ''}`;
  return 'owner';
}

/**
 * The audience a chat turn answers, from the pending messages oldest first: the owner's when the owner has one waiting,
 * unless another audience's oldest has waited ownerFirstStarveMs; otherwise the oldest's. null when nothing waits.
 */
export function chooseAudience(pending: readonly { audience: string; createdAt: string }[], now: number): string | null {
  if (!pending.length) return null;
  const oldest = pending[0]!;
  if (oldest.audience === 'owner') return 'owner';
  if (!pending.some((m) => m.audience === 'owner')) return oldest.audience;
  return now - Date.parse(oldest.createdAt) >= TEAM_LIMITS.ownerFirstStarveMs ? oldest.audience : 'owner';
}

/** A turn for another Boton or a team: it takes the team semaphore before a slot. */
export const isTeamAudience = (audience: string | null): boolean => !!audience && audience !== 'owner';

// ------------------------------------------------------------------ the role context (bounded, never silently cut)

export const TEAM_CONTEXT = {
  /** The whole teams section of the context block. */
  total: 4500,
  /** Each team's part that is always given (id, name, state, role, title, responsibilities, lead). */
  critical: 420,
  roleTitle: 60,
  responsibilities: 240,
  goal: 400,
  teammateResponsibilities: 120,
  items: 6,
} as const;

// ------------------------------------------------------------------ words

export const ITEM_STATUS_WORDS: Record<TeamItemStatus, string> = {
  open: 'open',
  working: 'working',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
};

export const WAITING_WORDS: Record<TeamItemWaiting, string> = {
  owner: 'waiting for you',
  approval: 'waiting for you: approval',
  usage_limit: 'waiting for the usage limit',
  paused: 'waiting: the Boton is paused',
  team_paused: 'team paused',
  running: 'being worked on',
  teammate: 'waiting on a teammate',
  held: 'held for you',
};

export const PAUSED_WORDS: Record<TeamPausedReason, string> = {
  owner: 'Paused',
  budget: 'Paused: a daily budget ran out',
  no_lead: 'Paused: it has no lead',
  stopped: 'Stopped',
};

/** "3m", "2h", "4d": how long ago, for status lines. */
export function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / (24 * HOUR))}d ago`;
}

/** An item's status line in words: what both apps show on a board row. */
export function itemStatusLine(item: Pick<TeamItem, 'status' | 'assigneeName' | 'blockedNeed' | 'blockedReason' | 'waiting' | 'nudges' | 'lastActivityAt' | 'escalation' | 'held'>, now: number, leadName?: string | null): string {
  if (item.held) return WAITING_WORDS.held;
  if (item.escalation) return 'waiting for you: escalated';
  if (item.status === 'blocked') return item.blockedNeed === 'owner' ? 'blocked: needs you' : `blocked: needs ${leadName || 'the lead'}`;
  if (item.status === 'done' || item.status === 'cancelled') return `${item.status} · ${ago(item.lastActivityAt, now)}`;
  if (item.status === 'open' && !item.assigneeName) return 'open · not assigned';
  const parts = [item.waiting ? WAITING_WORDS[item.waiting] : `${item.status} · updated ${ago(item.lastActivityAt, now)}`];
  if (item.nudges > 0) parts.push(`check-in ${item.nudges} of ${TEAM_LIMITS.maxNudges}`);
  return parts.join(' · ');
}

/** A request's delivery line under it in a thread: Queued, Delivered, Answered in 2m, Could not answer... */
export function deliveryLine(d: Pick<TeamDelivery, 'state' | 'outcome' | 'waitingOn'> & { queuedAt?: string; at: string }, recipient: string): string {
  if (d.state === 'queued') {
    const why = { paused: `${recipient} is paused`, usage_limit: 'the usage limit', backlog: `${recipient} has others waiting`, team_paused: 'the team is paused' } as const;
    return d.waitingOn ? `Waiting: ${why[d.waitingOn]}` : 'Queued';
  }
  if (d.state === 'dispatched') return d.waitingOn === 'paused' ? `Waiting: ${recipient} is paused` : 'Delivered';
  if (d.state === 'expired') return 'Expired';
  if (d.state === 'cancelled') return 'Cancelled';
  switch (d.outcome) {
    case 'replied':
    case 'quiet': {
      const took = d.queuedAt ? Math.max(0, Date.parse(d.at) - Date.parse(d.queuedAt)) : null;
      return took === null ? 'Answered' : `Answered in ${took < MINUTE ? 'under a minute' : took < HOUR ? `${Math.round(took / MINUTE)}m` : `${Math.round(took / HOUR)}h`}`;
    }
    case 'failed':
    case 'lost':
      return 'Could not answer';
    case 'stopped':
      return 'Stopped by you';
    case 'dropped':
      return 'Cleared from the queue';
    case 'gone':
      return `${recipient} was deleted`;
    default:
      return 'Handled';
  }
}

/** Board order: what needs the owner, then blocked, working, open; done and cancelled last. */
export function boardGroup(item: Pick<TeamItem, 'status' | 'escalation' | 'held' | 'blockedNeed'>): 'needs_you' | 'blocked' | 'working' | 'open' | 'done' {
  if (item.escalation || item.held || (item.status === 'blocked' && item.blockedNeed === 'owner')) return 'needs_you';
  if (item.status === 'blocked') return 'blocked';
  if (item.status === 'working') return 'working';
  if (item.status === 'open') return 'open';
  return 'done';
}

/** Does this item need the owner (one of the things TeamsAttention counts)? */
export const itemNeedsOwner = (item: Pick<TeamItem, 'status' | 'escalation' | 'held' | 'blockedNeed'>): boolean => boardGroup(item) === 'needs_you';

export type { TeamBlockedNeed };
