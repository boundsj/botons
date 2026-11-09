import { cliHomesEnv } from './cli-homes.ts';
import { withLegacyTurnNames } from '../../shared/legacy-names.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccessLevel,
  ApprovalOrigin,
  AskResult,
  Bot,
  BotStatus,
  CancelRunsResult,
  FileRef,
  Message,
  MessageMeta,
  NotifyPolicy,
  NotifyResult,
  BrainRef,
  ProviderHandoff,
  ProviderSwitchInput,
  ProviderSwitchPreview,
  SwitchSummaryOffer,
  BrainReadiness,
  Routine,
  RoutineRun,
  RunTrigger,
  Settings,
  ShareResult,
  StopResult,
  TokenUsage,
  TurnDraft,
  TurnOutcome,
  TurnStep,
  UpdateBotInput,
} from '../../shared/types.ts';
import { effortProblem, type ModelEfforts } from '../../shared/effort.ts';
import { BROWSER_CONNECTOR, BROWSER_SERVER, durationText, isPastOneOff, totalTokens } from '../../shared/util.ts';
import type { Approvals } from './approvals.ts';
import type { Browser } from './browser.ts';
import { splitRules } from './ask-rules.ts';
import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import { type Connectors, OFF_REASON, type ResolvedConnectors } from './connectors.ts';
import type { LaunchPolicy } from './connector-launch.ts';
import type { EventHub } from './events.ts';
import { fileRef, resolveInWorkspace } from './files.ts';
import { snapshotInstructions } from './instructions.ts';
import { privatePaths } from './isolation.ts';
import { RunLimiter } from './limits.ts';
import { type LogFields, log } from './log.ts';
import type { Notifier, PushRequest } from './notify.ts';
import {
  ASK_HOP_LIMIT,
  attachmentNote,
  chatInput,
  reactionFollowUpPrompt,
  chatTrigger,
  contextBlock,
  parseQuiet,
  routinePrompt,
  sessionKey,
  sessionStart,
  type TurnBrain,
  skillInvocation,
  summaryRequest,
  systemPrompt,
  type Trigger,
} from './prompt.ts';
import type { ProviderRegistry } from './providers/index.ts';
import { DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS } from './providers/failures.ts';
import { type McpStartup, type Provider, ProviderError, type TurnResult, type TurnUsage } from './providers/types.ts';
import type { Skills } from './skills.ts';
import type { StarterGate } from './starter-gate.ts';
import { excerptOf, type Feedback, ownersOwn, type Reactions } from './reactions.ts';
import { type WorkFeed, workEventPrompt } from './work-feed.ts';
import { MESSAGE_LIMIT, PIN_LIMIT, REPLAY_BUDGET, type Replayable, WEBHOOK_HISTORY_BUDGET, WEBHOOK_HISTORY_MAX } from './replay.ts';
import { type BotRecord, HttpError, runChip, type Store, type TurnStamp } from './store.ts';

/** A switch preview as the server checks it: all but the replay's estimate, which no confirmation binds. */
type SwitchFacts = Omit<ProviderSwitchPreview, 'replayNow'>;

type PendingHandoff = NonNullable<ReturnType<Store['pendingHandoff']>>;
/** What the summary offer goes by of the Boton's provider now (see Engine.#switchBrains). */
type OldBrain = Pick<BrainReadiness, 'state' | 'problem'>;
import { clipText, newId, nowIso, orNull } from './util.ts';

type Work = { kind: 'chat' } | { kind: 'routine'; runId: string };

/** A Boton's job, from when it starts waiting for a slot until it ends. */
interface Job {
  wait: AbortController;
  /** The queued run this job waits for a slot to start. */
  runId?: string;
  turn?: AbortController;
  run?: { runId: string; routineId: string; routineName: string; trigger: RunTrigger };
  /**
   * Why this job was ended (Stop, a pause, Cancel), kept for a turn that has no agent process yet (its connectors are
   * still being set up): #invoke ends it before one starts. The first reason stays.
   */
  aborted?: Error;
  /** Its turn handed the agent CLI its prompt, so a run it ends may have partly run. */
  spawned?: boolean;
  /**
   * What its turn read, set once with the read and before anything awaits: the Boton (its stamp), the handoff note
   * pending then, and the session it runs on (a routine's own, or the chat's). A switch while it sets up or runs (even
   * away and back) keeps its session and its note's ack out, and ends the saved session it is on (see updateBot).
   */
  read?: Readonly<{ stamp: TurnStamp; handoff: PendingHandoff | null; own: string | null; fresh: boolean }>;
}

type Chain = { threadId: string; hop: number };

export const ROUTINE_QUEUE_MAX = 3;
const QUEUE_FULL_RETRY_S = 60;
const CHIP_EVERY_MS = 3_600_000;
const ASK_MAX = 20_000;
export const DRAFT_EVERY_MS = 150;
const NOTIFY_PUSHES_PER_HOUR = 10;
const CUT_OFF_LIMIT = 3;
/** Each list in a handoff note holds at most this many. */
const HANDOFF_ITEMS = 5;
/** The summary a move asks the old session for: its turn's time limit, and how much of what it writes is kept. */
export const SWITCH_SUMMARY_MS = 120_000;
export const SWITCH_SUMMARY_CHARS = 2000;
const RETRY_STEPS = [1, 5, 15];
const DRAIN_GRACE_MS = 10_000;
/** How long a Cancel waits for the run's agent process to exit (process.ts kills its group within 3 s). */
const CANCEL_WAIT_MS = 10_000;

/** Abort reasons: a shutdown leaves the turn's work for the next server process; Stop or a pause ends it; Cancel ends one run. */
const INTERRUPTED = new Error('Interrupted by a restart');
const STOPPED = new Error('Stopped');
/** Why a move's summary was stopped by a pause (see #halt). */
const PAUSED = new Error('Paused');
/** A move's summary refused once it had a slot: what it was asked for changed while it waited, and no turn ran. */
const NOT_STARTED = new Error('Not started');
const CANCELLED = new Error('Cancelled');

/** What ended the job's turn, even one ended before it had an agent process to stop. */
const abortReason = (job: Job): unknown => job.aborted ?? job.turn?.signal.reason;

/** A turn that ended [quiet] on a reaction, with every reacted-to message of the owner's answered. */
const QUIET_ONLY = /^\[quiet\]$/i;
/** Ahead of the messages a turn reacted around without answering. Turn text: it starts no new session. */
const unansweredNote = (owner: string) =>
  `(Note from the Botons server: your last turn reacted to some of ${owner}'s messages and ended [quiet], so the ones below that got no reaction have no answer yet. Answer them in words: a question, request, decision or error always gets words.)`;

export const INTERRUPTED_NOTE =
  '(Note from the Botons server: your previous attempt at some or all of the messages below was cut off, by a server restart or a usage limit, so it may have partly run. Check what was already done before you repeat anything with side effects.)';

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function threadOf(messages: Message[]): Chain | null {
  let best: Chain | null = null;
  for (const m of messages) {
    if (!m.meta?.fromBotId || !m.meta.threadId) continue;
    const hop = m.meta.hop ?? 1;
    if (!best || hop > best.hop) best = { threadId: m.meta.threadId, hop };
  }
  return best;
}

interface TurnInfo {
  /** Its row in the turns table; "" until it starts. */
  id: string;
  model: string;
  /** The level it asked for; "": the provider's default. */
  effort: string;
  usage: TurnUsage | null;
  steps: number;
  /** Its time limit, in ms: set as it starts. */
  limitMs: number;
}

/**
 * The level a turn asks for: its routine's own, else the Boton's (`effort`), with what the model's own list says
 * (`known`, see shared/effort.ts). It asks for none ("", the CLI's default) for a level the provider or that list
 * doesn't have, which the store refuses to save but which a Boton's change or a new model list can leave behind; the
 * level it would have asked for is `dropped`.
 */
function turnEffort(bot: Pick<BotRecord, 'provider' | 'effort'>, routine: Pick<Routine, 'effort'> | null, known: ModelEfforts | null): { effort: string; dropped: string } {
  const effort = routine?.effort || bot.effort;
  return effort && effortProblem(bot.provider, effort, known) ? { effort: '', dropped: effort } : { effort, dropped: '' };
}

const newTurnInfo = (): TurnInfo => ({ id: '', model: '', effort: '', usage: null, steps: 0, limitMs: 0 });

/**
 * The turn's agent process ran past its time limit before anything else ended it (runJsonl, and the mock, keep only
 * the first of a timeout and a stop), so a stop, cancel or shutdown that came while it was exiting doesn't change why.
 */
const timedOut = (err: unknown): boolean => err instanceof ProviderError && !!err.exit?.timedOut;

/** Text that is, or may yet become, a quiet routine reply ("[quiet] …"): a routine run doesn't show it as a draft. */
function mayBeQuiet(text: string): boolean {
  const t = text.replace(/^[\s*_`]+/, '').toLowerCase();
  return t.length < 7 ? '[quiet]'.startsWith(t) : t.startsWith('[quiet]');
}

/**
 * A webhook run's payload (or a webhook routine's test run's) comes from outside. Sandboxed (outside, with
 * Workspace access): its token can't change routines or memories or ask other Botons, and it gets no shared
 * folder, so the payload can't reach later turns or other Botons.
 */
function turnScope(bot: BotRecord, trigger: Trigger): { access: AccessLevel; outside: boolean; sandboxed: boolean } {
  if (trigger.kind === 'chat') return { access: bot.access, outside: false, sandboxed: false };
  const outside = fromOutside(trigger.routine, trigger.run.trigger);
  const access = bot.access === 'host' && outside && trigger.routine.webhookWorkspace ? 'workspace' : bot.access;
  return { access, outside, sandboxed: outside && access === 'workspace' };
}

const fromOutside = (routine: Pick<Routine, 'webhook'>, trigger: RunTrigger): boolean => trigger === 'webhook' || (trigger === 'test' && !!routine.webhook);

/**
 * The session a routine's run is on. A webhook run never carries on the chat's session, whatever the routine's
 * `session` says, since a session holds all the chat it has seen: it gets a fresh session that ends with the run
 * ('fresh'), given only the chat's latest `webhookHistory` messages (the owner's choice, none by default), so no run
 * sees more of the chat than that. A routine's own session holds none of the chat, so one without that history
 * carries on there.
 */
export function runSession(routine: Pick<Routine, 'session' | 'webhookHistory' | 'webhook'>, trigger: RunTrigger): 'chat' | 'own' | 'fresh' {
  if (!fromOutside(routine, trigger)) return routine.session;
  return routine.session === 'own' && routine.webhookHistory === 0 ? 'own' : 'fresh';
}

/** The first `n` of a lazy list: read no further. */
function* take(list: Iterable<Replayable>, n: number): Generator<Replayable> {
  if (n <= 0) return;
  let i = 0;
  for (const x of list) {
    yield x;
    if (++i >= n) return;
  }
}

class Semaphore {
  #free: number;
  #waiting: Array<() => void> = [];
  constructor(n: number) {
    this.#free = n;
  }
  acquire(signal: AbortSignal): Promise<boolean> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const granted = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const i = this.#waiting.indexOf(granted);
        if (i >= 0) this.#waiting.splice(i, 1);
        resolve(false);
      };
      this.#waiting.push(granted);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free++;
  }
}

/** One serial queue per Boton (chat and routine runs share its conversation); a semaphore caps agent processes. */
export class Engine {
  store!: Store;
  auth!: Auth;
  notifier!: Notifier;
  connectors!: Connectors;
  skills!: Skills;
  approvals!: Approvals;
  reactions!: Reactions;
  browser?: Browser;
  workFeed!: WorkFeed;
  /** Notes what a starter's test runs ran on (starter-gate.ts). */
  starterGate?: StarterGate;
  #cfg: Config;
  #hub: EventHub;
  #providers: ProviderRegistry;
  #status = new Map<string, BotStatus>();
  #chains = new Map<string, Promise<void>>();
  #queued = new Map<string, number>();
  /** Per Boton, the owner's messages a turn ended [quiet] on after reacting to others only: they still want words. */
  #unanswered = new Map<string, Set<string>>();
  #jobs = new Map<string, Job>();
  /** A move waiting for the old session's summary holds its Boton (see #moveWithSummary). */
  #summaries = new Map<string, { hold: symbol; controller: AbortController }>();
  /** While a turn's `botons` token is valid. `bot` as the turn read it, so what it posts is marked stale like its reply. */
  #turns = new Map<string, { bot: BotRecord; origin: ApprovalOrigin; access: AccessLevel; chain: Chain | null; connectors: string[] }>();
  #slots: Semaphore;
  #draining = false;
  #maintenance = false;
  #closing = new AbortController();
  #interruptedCount = 0;
  #notifyPushes = new Map<string, number[]>();
  #limiter: RunLimiter;
  #askLimiter: RunLimiter;
  #chipAt = new Map<string, number>();
  #cooldowns = new Map<string, { until: Date; reason: string }>();
  #noticed = new Map<string, number>();
  #timers = new Map<string, NodeJS.Timeout>();

  constructor(cfg: Config, hub: EventHub, providers: ProviderRegistry) {
    this.#cfg = cfg;
    this.#hub = hub;
    this.#providers = providers;
    this.#slots = new Semaphore(cfg.maxConcurrentTurns);
    this.#limiter = new RunLimiter(cfg.routineRunsPerHour, cfg.runsPerHour);
    this.#askLimiter = new RunLimiter(cfg.asksPerPairPerHour, cfg.asksPerHour);
  }

  statusOf = (botId: string): BotStatus => this.#status.get(botId) ?? { state: 'idle', activity: null, since: null };

  turnOrigin = (botId: string): ApprovalOrigin | null => this.#turns.get(botId)?.origin ?? null;

  turnAccess = (botId: string): AccessLevel | null => this.#turns.get(botId)?.access ?? null;
  /** The turns running now that were given connector `id`: turning it off doesn't reach into those turns. */
  turnsWith = (id: string): { botId: string; turnId: string }[] => [...this.#turns].flatMap(([botId, t]) => (t.connectors.includes(id) && t.origin.turnId ? [{ botId, turnId: t.origin.turnId }] : []));

  queueChat(botId: string): void {
    if (this.store.hasBot(botId) && !this.store.pausedReason(botId)) this.#enqueue(botId, { kind: 'chat' });
  }

  #setStatus(botId: string, state: BotStatus['state'], activity: string | null = null) {
    const prev = this.statusOf(botId);
    if (prev.state === state && prev.activity === activity) return;
    const status: BotStatus = { state, activity, since: prev.state === state && prev.since ? prev.since : nowIso() };
    if (state === 'working' && prev.state === 'working' && prev.draft) status.draft = prev.draft;
    if (state === 'idle') this.#status.delete(botId);
    else this.#status.set(botId, status);
    this.#hub.publish({ type: 'bot.status', botId, status: this.statusOf(botId) });
  }

  /** `end()` drops the draft without an event: the turn's message (same turnId) replaces it on clients. */
  #drafts(botId: string, turnId: string, routine: boolean): { push: (text: string) => void; end: () => void } {
    let pending: string | null = null;
    let last = 0;
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    const publish = () => {
      timer = undefined;
      const s = this.#status.get(botId);
      if (pending === null || ended || s?.state !== 'working') return;
      const draft: TurnDraft = { turnId, text: pending, at: nowIso() };
      pending = null;
      last = Date.now();
      this.#status.set(botId, { ...s, draft });
      this.#hub.publish({ type: 'message.draft', botId, draft });
    };
    return {
      push: (text) => {
        if (ended || !text.trim() || (routine && mayBeQuiet(text))) return;
        pending = text;
        if (timer) return;
        const wait = last + DRAFT_EVERY_MS - Date.now();
        if (wait <= 0) publish();
        else timer = setTimeout(publish, wait);
      },
      end: () => {
        ended = true;
        clearTimeout(timer);
        const s = this.#status.get(botId);
        if (s?.draft?.turnId === turnId) this.#status.set(botId, { ...s, draft: null });
      },
    };
  }

  #chipDue(key: string): boolean {
    const now = Date.now();
    if (now - (this.#chipAt.get(key) ?? 0) < CHIP_EVERY_MS) return false;
    this.#chipAt.set(key, now);
    return true;
  }

  // ------------------------------------------------------------------ inputs

  sendMessage(botId: string, text: string, attachments: FileRef[] = []): Message {
    this.#refuseWhileDraining();
    const t = text.trim();
    if (!t && !attachments.length) throw new HttpError(400, 'text is required');
    if (t.length > 50_000) throw new HttpError(400, 'Message is too long');
    this.store.getBot(botId);
    const message = this.store.addMessage(botId, 'user', t, attachments.length ? { attachments } : null, true);
    if (!this.store.pausedReason(botId)) this.#enqueue(botId, { kind: 'chat' });
    return message;
  }

  /** Nothing waits for the answer (it comes back as a message, see #answerAsks), so two Botons asking each other can't deadlock. */
  ask(fromId: string, toId: string, text: unknown): AskResult {
    this.#refuseWhileDraining();
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    const t = text.trim();
    if (t.length > ASK_MAX) throw new HttpError(400, `text is too long (max ${ASK_MAX} characters)`);
    const from = this.store.getBot(fromId);
    if (toId === fromId) throw new HttpError(400, "You can't ask yourself. Do the work in this turn instead.");
    if (!this.store.hasBot(toId)) throw new HttpError(404, `No Boton with id ${toId}. Run \`botons team\` to see who is on the team.`);
    const to = this.store.getBot(toId);
    const running = this.#turns.get(fromId);
    const hop = (running?.chain?.hop ?? 0) + 1;
    const threadId = running?.chain?.threadId ?? newId('thr');
    const about: MessageMeta = { toBotId: to.id, toBotName: to.name, askText: t, threadId, hop };
    const chip = (kind: 'ask.refused' | 'ask.sent', label: string) => this.store.addMessage(from.id, 'event', label, this.#postMeta(running?.bot ?? from, { kind, ...about }));
    const fields: LogFields = { botId: from.id, toBotId: to.id, threadId, hop };

    if (hop > ASK_HOP_LIMIT) {
      chip('ask.refused', `Didn't ask ${to.name}: ${ASK_HOP_LIMIT} asks in a row is the limit`);
      log.info('ask refused: hop limit', fields);
      const owner = this.store.getSettings().ownerName;
      throw new HttpError(
        409,
        `${to.name} was not asked: this thread between Botons already has ${ASK_HOP_LIMIT} asks in a row, the limit. Put what you have in your reply instead; ${owner} can see it in your chat.`,
      );
    }
    const pair = pairKey(from.id, to.id);
    const hit = this.#askLimiter.check(pair);
    if (hit) {
      const { s, wait } = retryAfter(hit.retryAfterMs);
      const between = hit.limit === 'routine' ? `${from.name} and ${to.name}` : 'all Botons';
      if (this.#chipDue(pair)) chip('ask.refused', `Didn't ask ${to.name}: too many asks (limit: ${hit.max} an hour between ${between})`);
      log.warn('ask refused: rate limit', { ...fields, limit: hit.limit === 'routine' ? 'pair' : 'total', max: hit.max });
      throw new HttpError(429, `${to.name} was not asked: ${between} have sent ${hit.max} asks in the last hour, the limit. Try again in ${wait}, or put it in your reply.`, {
        'retry-after': String(s),
      });
    }
    this.#askLimiter.record(pair);
    const message = this.store.addMessage(to.id, 'user', t, { kind: 'ask', fromBotId: from.id, fromBotName: from.name, threadId, hop }, true);
    chip('ask.sent', `Asked ${to.name}`);
    log.info('ask sent', fields);
    if (!this.store.pausedReason(to.id)) this.#enqueue(to.id, { kind: 'chat' });
    return { message, threadId, hop };
  }

  /** Only asks are answered, never replies, so two Botons can't loop. */
  #answerAsks(bot: BotRecord, answered: Message[], text: string) {
    const asks = new Map<string, Message>();
    for (const m of answered) {
      const asker = m.meta?.kind === 'ask' ? m.meta.fromBotId : undefined;
      if (!asker) continue;
      const prev = asks.get(asker);
      if (!prev || (m.meta?.hop ?? 1) >= (prev.meta?.hop ?? 1)) asks.set(asker, m);
    }
    for (const [asker, ask] of asks) {
      if (!this.store.hasBot(asker)) continue;
      const reply = text.length > ASK_MAX ? `${text.slice(0, ASK_MAX)}…` : text;
      this.store.addMessage(asker, 'user', reply, { kind: 'ask.reply', fromBotId: bot.id, fromBotName: bot.name, threadId: ask.meta?.threadId, hop: ask.meta?.hop, askId: ask.id }, true);
      log.info('ask answered', { botId: asker, fromBotId: bot.id, threadId: ask.meta?.threadId, hop: ask.meta?.hop });
      if (!this.store.pausedReason(asker)) this.#enqueue(asker, { kind: 'chat' });
    }
  }

  triggerRoutine(routineId: string, trigger: RunTrigger, payload: string | null = null, headers: Record<string, string> | null = null): RoutineRun {
    this.#refuseWhileDraining();
    const routine = this.store.getRoutine(routineId);
    const limited = trigger !== 'schedule';
    const paused = this.store.pausedReason(routine.botId);
    if (limited && paused) throw new HttpError(409, `${paused}. Resume to run routines.`);
    if (limited) this.#checkLimits(routine, trigger);
    const run = this.store.createRun(routine, trigger, payload, headers);
    if (limited) this.#limiter.record(routine.id);
    log.info('run queued', { botId: routine.botId, routineId: routine.id, runId: run.id, trigger });
    this.#enqueue(routine.botId, { kind: 'routine', runId: run.id });
    return run;
  }

  /** The owner's retry of a failed run: a new run with its trigger, payload and headers, under the limits a manual run has. */
  retryRun(runId: string): RoutineRun {
    this.#refuseWhileDraining();
    const failed = this.store.getRun(runId);
    const routine = this.store.getRoutine(failed.routineId);
    const paused = this.store.pausedReason(routine.botId);
    if (paused) throw new HttpError(409, `${paused}. Resume to run routines.`);
    if (failed.status !== 'failed') throw new HttpError(409, `Only a failed run can be retried; this one is ${failed.status}`);
    if (failed.meta?.retriedAs) throw new HttpError(409, `This run was already retried as ${failed.meta.retriedAs}`);
    this.#checkLimits(routine, failed.trigger);
    const run = this.store.createRetryRun(failed);
    this.#limiter.record(routine.id);
    log.info('run queued', { botId: routine.botId, routineId: routine.id, runId: run.id, trigger: run.trigger, retryOf: failed.id });
    this.#enqueue(routine.botId, { kind: 'routine', runId: run.id });
    return run;
  }

  fireScheduled(routine: Routine): RoutineRun | null {
    // A one-off has no next slot (firing it retired the routine): its run is queued, never skipped.
    if (routine.schedule?.startsWith('once ')) return this.triggerRoutine(routine.id, 'schedule');
    const skip = (reason: string) => {
      const run = this.store.recordSkippedRun(routine, 'schedule', reason);
      log.info('scheduled run skipped', { botId: routine.botId, routineId: routine.id, runId: run.id, trigger: 'schedule', reason });
      return null;
    };
    const paused = this.store.pausedReason(routine.botId);
    if (paused) return skip(paused);
    const bot = this.store.getBot(routine.botId);
    const until = this.#coolingUntil(bot.provider);
    if (until) return skip(`${this.#providerName(bot.provider)} usage limit until ${when(until, bot.timezone)}`);
    if (this.store.activeRunCount(routine.id) > 0) return skip('The previous run was still queued or running');
    return this.triggerRoutine(routine.id, 'schedule');
  }

  #checkLimits(routine: Routine, trigger: RunTrigger) {
    let refusal: { message: string; chip: string; retryAfterS: number };
    if (this.store.queuedRunCount(routine.id) >= ROUTINE_QUEUE_MAX) {
      // Waiting out a usage limit, the queue moves at the reset.
      const reset = this.#coolingUntil(this.#providerOf(routine.botId));
      refusal = {
        message: `Routine “${routine.name}” already has ${ROUTINE_QUEUE_MAX} runs waiting to start. Try again once they have run.`,
        chip: `${ROUTINE_QUEUE_MAX} already waiting`,
        retryAfterS: reset ? Math.max(QUEUE_FULL_RETRY_S, Math.ceil((reset.getTime() - Date.now()) / 1000)) : QUEUE_FULL_RETRY_S,
      };
    } else {
      const hit = this.#limiter.check(routine.id);
      if (!hit) return;
      const { s, wait } = retryAfter(hit.retryAfterMs);
      refusal =
        hit.limit === 'routine'
          ? { message: `Routine “${routine.name}” has started ${hit.max} webhook and manual runs in the last hour, its limit. Try again in ${wait}.`, chip: `${hit.max} an hour for this routine`, retryAfterS: s }
          : { message: `Botons has started ${hit.max} webhook and manual runs in the last hour, its limit. Try again in ${wait}.`, chip: `${hit.max} an hour for all routines`, retryAfterS: s };
    }
    if (this.#chipDue(routine.id)) {
      this.store.addMessage(routine.botId, 'event', `Refused ${trigger} runs (limit: ${refusal.chip})`, {
        kind: 'routine.rate_limited',
        routineId: routine.id,
        routineName: routine.name,
        trigger,
      });
    }
    throw new HttpError(429, refusal.message, { 'retry-after': String(refusal.retryAfterS) });
  }

  noteCutOffTurns(turns: { id: string; botId: string; steps: number }[]): void {
    for (const t of turns) {
      if (!this.store.hasBot(t.botId)) continue;
      const chip = this.store.addMessage(t.botId, 'event', 'Cut off by a restart', { kind: 'turn.interrupted', turnId: t.id, steps: t.steps });
      this.store.linkTurnMessage(t.id, chip.id);
    }
  }

  /** Before resume(): messages a turn that crashes the server would cut off forever get an error instead. */
  giveUpCutOffChats(): void {
    for (const [botId, messages] of this.store.countCutOffChats(CUT_OFF_LIMIT)) {
      const bot = orNull(() => this.store.getBot(botId));
      if (!bot) continue;
      const ids = messages.map((m) => m.id);
      this.store.markProcessed(ids);
      const why = `The last ${CUT_OFF_LIMIT} attempts to answer this were cut off by a restart or crash, so it was not tried again. Some of it may have run. Send it again to retry.`;
      this.#post(bot, 'error', why);
      this.#answerAsks(bot, messages, `(${bot.name} could not answer: ${why})`);
      log.warn('gave up on chat messages cut off at every start', { botId, messages: ids.length, limit: CUT_OFF_LIMIT });
    }
  }

  resume(): void {
    for (const c of this.store.cooldowns()) {
      if (c.until.getTime() <= Date.now()) this.store.clearCooldown(c.provider);
      else this.#startCooldown(c.provider, c.until, c.reason);
    }
    this.#resumeWork(() => true);
  }

  #resumeWork(which: (botId: string) => boolean): void {
    const ok = (botId: string) => which(botId) && !this.store.pausedReason(botId);
    const work: { at: string; botId: string; work: Work }[] = [];
    for (const c of this.store.pendingChats()) {
      if (ok(c.botId) && !this.#coolingUntil(this.#providerOf(c.botId))) work.push({ at: c.since, botId: c.botId, work: { kind: 'chat' } });
    }
    for (const r of this.store.queuedRuns()) {
      if (!ok(r.botId)) continue;
      if (r.retryAt && new Date(r.retryAt).getTime() > Date.now()) this.#wakeRun(r);
      else work.push({ at: r.startedAt, botId: r.botId, work: { kind: 'routine', runId: r.id } });
    }
    work.sort((a, b) => a.at.localeCompare(b.at));
    for (const w of work) this.#enqueue(w.botId, w.work);
  }

  #providerOf(botId: string): string {
    return orNull(() => this.store.getBot(botId).provider) ?? '';
  }

  #providerName(id: string): string {
    return (this.#providers.get(id)?.label ?? id).replace(/ \(.*\)$/, '');
  }

  // ------------------------------------------------------------ usage limits

  usageLimit(provider: string): { until: string; reason: string } | null {
    const c = this.#cooldowns.get(provider);
    return c && c.until.getTime() > Date.now() ? { until: c.until.toISOString(), reason: c.reason } : null;
  }

  #coolingUntil(provider: string): Date | null {
    const c = this.#cooldowns.get(provider);
    return c && c.until.getTime() > Date.now() ? c.until : null;
  }

  #startCooldown(provider: string, until: Date, reason: string) {
    const prev = this.#cooldowns.get(provider);
    if (prev && prev.until.getTime() >= until.getTime()) return;
    this.#cooldowns.set(provider, { until, reason });
    this.store.setCooldown(provider, until, reason);
    log.warn('usage limit hit: holding its turns until the reset', { provider, until: until.toISOString(), reason: reason.slice(0, 200) });
    this.#wakeAt(`cooldown:${provider}`, until, () => {
      this.#cooldowns.delete(provider);
      this.store.clearCooldown(provider);
      log.info('usage limit has reset: resuming its Botons', { provider });
      this.#resumeWork((botId) => this.#providerOf(botId) === provider);
    });
  }

  #noticeUsageLimit(bot: BotRecord, until: Date) {
    if (this.#noticed.get(bot.id) === until.getTime() || !this.store.hasBot(bot.id)) return;
    this.#noticed.set(bot.id, until.getTime());
    this.store.addMessage(bot.id, 'event', `${this.#providerName(bot.provider)} usage limit reached; continuing ${when(until, bot.timezone)}`, {
      kind: 'usage.limit',
      retryAt: until.toISOString(),
    });
  }

  /** Run `fn` at `at` (in steps, for waits longer than a timer can). Skipped once the engine is draining. */
  #wakeAt(key: string, at: Date, fn: () => void) {
    clearTimeout(this.#timers.get(key));
    const t = setTimeout(
      () => {
        this.#timers.delete(key);
        if (this.#draining) return;
        if (Date.now() < at.getTime()) return this.#wakeAt(key, at, fn);
        try {
          fn();
        } catch (err) {
          log.error('wake-up failed', { wakeUp: key, err });
        }
      },
      Math.min(Math.max(0, at.getTime() - Date.now()) + 5, 2 ** 31 - 1),
    );
    t.unref();
    this.#timers.set(key, t);
  }

  #wakeRun(run: RoutineRun) {
    if (!run.retryAt) return;
    this.#wakeAt(`run:${run.id}`, new Date(run.retryAt), () => this.#enqueue(run.botId, { kind: 'routine', runId: run.id }));
  }

  // ------------------------------------------------------- stopping, pausing

  get draining(): boolean {
    return this.#draining;
  }

  #refuseWhileDraining() {
    if (this.#draining) throw new HttpError(503, 'Botons is restarting. Try again in a minute.');
  }

  /** Hold persisted queued work, let active work finish, then resume even if maintenance fails. */
  async maintain<T>(run: () => Promise<T>, budgetMs = 60_000): Promise<T> {
    if (this.#maintenance || this.#draining) throw new HttpError(409, 'Botons is already updating or restarting.');
    this.#maintenance = true;
    try {
      if (!(await this.#settled(budgetMs))) throw new HttpError(409, 'Running turns are still finishing. Try Update now again when they finish.');
      if (this.#draining) throw new HttpError(409, 'Botons is restarting. Try again after it starts.');
      return await run();
    } finally {
      this.#maintenance = false;
      if (!this.#draining) this.#resumeWork(() => true);
    }
  }

  async drain(budgetMs: number): Promise<{ interrupted: number }> {
    this.#draining = true;
    // Retries and usage-limit resets are saved with their runs and cooldowns; the next process sets them again.
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    if (!(await this.#settled(budgetMs))) {
      this.interruptAll();
      if (!(await this.#settled(DRAIN_GRACE_MS))) log.warn('some agent processes did not exit in time');
    }
    return { interrupted: this.#interruptedCount };
  }

  interruptAll(): void {
    for (const { controller } of this.#summaries.values()) controller.abort(INTERRUPTED);
    for (const { turn } of this.#jobs.values()) {
      if (!turn || turn.signal.aborted) continue;
      turn.abort(INTERRUPTED);
      this.#interruptedCount++;
    }
  }

  async #settled(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
    try {
      return await Promise.race([Promise.allSettled([...this.#chains.values()]).then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  stopAll(): void {
    for (const { controller } of this.#summaries.values()) controller.abort(STOPPED);
    for (const job of this.#jobs.values()) job.turn?.abort();
  }

  stop(botId: string, opts: { clearQueue?: boolean } = {}): StopResult {
    const stopped = this.#jobs.has(botId) || this.#summaries.has(botId);
    this.#halt(botId);
    let cancelledRuns = 0;
    if (opts.clearQueue) {
      cancelledRuns = this.store.cancelQueuedRuns(botId, 'Cancelled');
      this.store.dropPendingChat(botId);
    }
    return { stopped, cancelledRuns, queuedRuns: this.store.queuedRuns(botId).length };
  }

  cancelQueuedRuns(botId: string): CancelRunsResult {
    this.store.getBot(botId);
    return { cancelledRuns: this.store.cancelQueuedRuns(botId, 'Cancelled') };
  }

  /**
   * The owner ends one run, and nothing else: a queued one (held to try again included) never starts; a running one
   * has only its own turn's agent process stopped, so the Boton's chat and its other runs carry on. Resolves with the
   * run as it ended: one that finished before the stop reached it keeps its own outcome.
   */
  async cancelRun(runId: string): Promise<RoutineRun> {
    const run = this.store.getRun(runId);
    if (run.status === 'queued') {
      clearTimeout(this.#timers.get(`run:${run.id}`));
      this.#timers.delete(`run:${run.id}`);
      // Held to try again: an earlier attempt ran, so it may have partly run.
      const started = run.attempts > 0;
      const ended = this.store.updateRun(run.id, { status: 'failed', error: 'Cancelled', cancelled: { started } });
      // A job waiting for a slot to start it gives up the wait (and, no longer queued, the run); any other finds it gone.
      const job = this.#jobs.get(run.botId);
      if (job && !job.run && job.runId === run.id) job.wait.abort();
      if (this.store.hasBot(run.botId)) this.#postStopped(run.botId, ended, undefined, 'Cancelled');
      log.info('run cancelled', { botId: run.botId, routineId: run.routineId, runId: run.id, trigger: run.trigger, was: 'queued', started });
      return ended;
    }
    if (run.status !== 'running') throw new HttpError(409, `This run already ended (${run.status})`);
    const job = this.#jobs.get(run.botId);
    if (job?.run?.runId !== run.id) throw new HttpError(409, 'This run is not running on this server; it ends as interrupted at the next start');
    this.#abortTurn(job, CANCELLED);
    log.info('run cancelled', { botId: run.botId, routineId: run.routineId, runId: run.id, trigger: run.trigger, was: 'running' });
    const ended = await this.waitForRun(run, CANCEL_WAIT_MS);
    if (ended.status === 'running') throw new HttpError(504, 'The run was told to stop, but its agent process has not exited yet');
    return ended;
  }

  pauseBot(botId: string, paused: boolean): Bot {
    const before = this.store.getBot(botId);
    if (before.paused === paused) return this.store.publicBot(before);
    const bot = this.store.setBotPaused(botId, paused);
    this.store.addMessage(botId, 'event', paused ? 'Paused' : 'Resumed', { kind: paused ? 'bot.paused' : 'bot.resumed' });
    if (paused) this.#halt(botId, PAUSED);
    else this.#resumeWork((id) => id === botId);
    return bot;
  }

  /**
   * What moving the Boton to `input.provider` keeps and loses, as the update would do it. The provider is part of
   * every session's key (sessionKey), so the chat's session and each routine's own end with the move; the model is
   * not, so a model change alone keeps them, and needs no preview.
   */
  async switchPreview(botId: string, input: ProviderSwitchInput, connections?: string[]): Promise<ProviderSwitchPreview> {
    this.#checkSwitchInput(input);
    const from = this.store.getBot(botId).provider;
    const { ready: readiness, old } = await this.#switchBrains(from, input.provider);
    // Moved by another update while the providers were checked: what the old one's check found is not this one's.
    if (this.store.getBot(botId).provider !== from) throw new HttpError(409, 'The Boton moved while this was checked: review it again');
    const facts = this.#switchPreview(botId, input, connections, readiness, old);
    return { ...facts, replayNow: this.#replayNow(botId, facts) };
  }

  /** What the new session's first turn would be given of the chat now, as the turn builds it: an estimate for the preview. */
  #replayNow(botId: string, facts: SwitchFacts): ProviderSwitchPreview['replayNow'] {
    const bot = this.store.getBot(botId);
    const handoff = facts.from.provider !== facts.to.provider ? this.#handoff(bot, facts) : null;
    const summary = handoff?.summary ? this.store.handoffSummary(bot.id, handoff.summary.messageId) : null;
    const src = this.store.replaySource(bot.id, bot.contextSince, summary ? [summary.id] : []);
    const { plan } = sessionStart({ handoff, summary, ...src }, this.store.getSettings(), bot.timezone);
    return { used: plan.used, messages: plan.messages, routines: plan.routines, pinned: plan.pinned, excerpts: plan.excerpts, olderLeftOut: plan.olderLeftOut, since: plan.since };
  }

  #checkSwitchInput(input: ProviderSwitchInput) {
    if (typeof input?.provider !== 'string' || !this.#providers.ids().has(input.provider)) throw new HttpError(400, 'provider must be one of this server\'s providers');
    if (input.model !== undefined && typeof input.model !== 'string') throw new HttpError(400, 'model must be a string');
    if (input.effort !== undefined && typeof input.effort !== 'string') throw new HttpError(400, 'effort must be a level name, or "" for the provider\'s default');
  }

  /** Both sides of a switch come from one registry snapshot, so no intervening check can split its facts. */
  async #switchBrains(from: string, to: string): Promise<{ ready: Pick<ProviderSwitchPreview['readiness'], 'state' | 'reason'>; old: OldBrain }> {
    const infos = await this.#providers.infos();
    const destination = infos.find((p) => p.id === to);
    const state = !destination ? 'unknown' : !destination.available ? 'unavailable' : destination.checkedAt && destination.loggedIn === true ? 'ready' : 'unknown';
    const source = infos.find((p) => p.id === from)?.readiness;
    return {
      ready: { state, reason: destination?.reason ?? null },
      old: source ? { state: source.state, problem: source.problem } : { state: 'unknown', problem: 'not-checked' },
    };
  }

  /**
   * Synchronous, so the update can check a confirmation and apply the move with nothing in between. `old`: what the
   * last check found of the Boton's provider now. `hold`: the move with a summary that holds the Boton, which
   * doesn't count as busy for itself.
   */
  #switchPreview(
    botId: string,
    input: ProviderSwitchInput,
    connections: string[] | undefined,
    ready: Pick<ProviderSwitchPreview['readiness'], 'state' | 'reason'>,
    old: OldBrain,
    hold?: symbol,
  ): SwitchFacts {
    this.#checkSwitchInput(input);
    const bot = this.store.getBot(botId);
    const provider = input.provider;
    const moved = provider !== bot.provider;
    // As the update cleans them.
    const model = input.model !== undefined ? input.model.trim() : bot.model;
    const effortReset = input.effort === undefined && !!bot.effort && !!effortProblem(provider, bot.effort, this.store.effortCaps(provider, model));
    const effort = input.effort !== undefined ? input.effort.trim() : effortReset ? '' : bot.effort;
    const routines = this.store.listRoutines(botId);
    const routineModels = moved ? routines.flatMap((r) => (r.model ? [{ id: r.id, name: r.name, model: r.model }] : [])) : [];
    // A moved Boton's routines run its model (their own was the old provider's), as resetRoutineEfforts then checks.
    const routineEfforts = routines.flatMap((r) =>
      r.effort && effortProblem(provider, r.effort, this.store.effortCaps(provider, (moved ? '' : r.model) || model)) ? [{ id: r.id, name: r.name, effort: r.effort }] : [],
    );
    // A turn that has read the Boton (setting up its connectors, or running) is on the old provider: the session it
    // is starting or carrying on is one the move ends, even before it is saved. One still waiting for a slot reads the
    // Boton when it starts, so it runs on the new provider.
    const underway = this.#underway(bot);
    const working = !!underway;
    const busyOwn = underway?.own ? routines.find((r) => r.id === underway.own) : undefined;
    const key = sessionKey(bot.provider, systemPrompt(bot, this.store.getSettings(), this.#cfg));
    const savedChat = !!bot.sessionId && bot.sessionKey === key;
    const saved = this.store.routineSessions(botId).flatMap((r) => (r.sessionKey === key ? [{ id: r.id, name: r.name }] : []));
    const sessions = moved
      ? {
          chat: savedChat || (working && !busyOwn),
          routines: busyOwn && !saved.some((r) => r.id === busyOwn.id) ? [...saved, { id: busyOwn.id, name: busyOwn.name }] : saved,
        }
      : { chat: false, routines: [] };
    const catalog = this.connectors.catalog().connectors;
    const lost = moved
      ? (connections ?? bot.connections).flatMap((id) => {
          const c = catalog.find((x) => x.id === id);
          return c && c.providers.includes(bot.provider) && !c.providers.includes(provider) ? [{ id, name: c.name }] : [];
        })
      : [];
    const required = moved && (sessions.chat || sessions.routines.length > 0);
    const { runs } = this.store.activeRuns(botId, new Date(), 1000);
    const noSummary = this.#noSummary(bot, required, savedChat, old, hold);
    const shown: Omit<SwitchFacts, 'confirmation' | 'summary'> & { summary: Omit<SwitchSummaryOffer, 'confirmation'> } = {
      from: { ...this.#brainRef(bot.provider, bot.model), effort: bot.effort },
      to: { ...this.#brainRef(provider, model), effort },
      required,
      sessions,
      working: moved && working,
      queuedRuns: runs.filter((r) => r.status === 'queued').length,
      replay: { budget: REPLAY_BUDGET, messageLimit: MESSAGE_LIMIT, pinned: this.store.pinnedMessages(botId).length, pinLimit: PIN_LIMIT },
      kept: { memories: this.store.listMemories(botId).length, routines: routines.length },
      effortReset,
      routineModels,
      routineEfforts,
      connectors: lost,
      readiness: { ...ready, usageLimitUntil: this.usageLimit(provider)?.until ?? null },
      oldUsageLimitUntil: moved ? (this.usageLimit(bot.provider)?.until ?? null) : null,
      summary: { available: !noSummary, reason: noSummary, timeoutMs: SWITCH_SUMMARY_MS, maxChars: SWITCH_SUMMARY_CHARS },
    };
    // Stands for everything the owner is shown, for this Boton only (no clock in it, so the same facts give the same
    // confirmation): any change to it refuses the update until the owner reviews it again. Moving with the summary
    // has its own, so the owner's choice of it is bound too: one can't stand for the other.
    const digest = (kind: string) => `sw_${createHash('sha256').update(JSON.stringify([kind, botId, shown])).digest('base64url').slice(0, 32)}`;
    const confirmation = required ? digest('botons-switch') : null;
    return { ...shown, confirmation, summary: { ...shown.summary, confirmation: noSummary ? null : digest('botons-switch-summary') } };
  }

  /**
   * Why the old session can't be asked for a summary now (null: it can). Only a saved chat session on the provider
   * the Boton is on, with nothing else running for it, on a provider that is there, usable and not out of usage.
   */
  #noSummary(bot: BotRecord, required: boolean, savedChat: boolean, old: OldBrain, hold?: symbol): string | null {
    const from = this.#providerName(bot.provider);
    if (!required) return 'No session ends with this move';
    // A summary turn must be given no tools at all, not only a sandbox around them: only a CLI that can do that asks.
    const provider = this.#providers.get(bot.provider);
    if (provider && !provider.toolFree) {
      return `${from} can't be asked for a summary: its CLI can't run a turn with no tools (shell, file edits and others stay on)`;
    }
    if (!savedChat) return `${bot.name} has no chat session on ${from} to ask`;
    const held = this.#summaries.get(bot.id);
    if (held && held.hold !== hold) return `A summary for a move is already being written`;
    if (!held && (this.#chains.has(bot.id) || this.#jobs.has(bot.id))) return `${bot.name} is busy: a summary can be asked for once it is idle`;
    if (this.#maintenance) return 'Botons is updating its CLI';
    if (this.#draining) return 'Botons is restarting';
    if (this.store.pausedReason(bot.id)) return `${bot.name} is paused`;
    if (!provider) return `${from} is not on this server`;
    const limit = this.#coolingUntil(bot.provider);
    if (limit) return `${from} is out of usage until ${when(limit, bot.timezone)}`;
    if (old.state !== 'ready') return `${from} isn't confirmed ready on this server (${old.state}${old.problem && old.problem !== old.state ? `: ${old.problem}` : ''}); check it in Settings`;
    return null;
  }

  /**
   * The session of the turn that read the Boton as it is now (its provider, since its latest switch), if one is
   * underway. One that read it before a later switch (moved away and back, say) was that switch's: the session it
   * was on is already ended.
   */
  #underway(bot: BotRecord): { own: string | null; fresh: boolean } | null {
    const read = this.#jobs.get(bot.id)?.read;
    return read && read.stamp.provider === bot.provider && read.stamp.generation === this.store.switchGeneration(bot.id) ? { own: read.own, fresh: read.fresh } : null;
  }

  #brainRef(provider: string, model: string) {
    return { provider, label: this.#providerName(provider), model };
  }

  /**
   * A switch that would end a session needs `switchConfirmation` from a preview of exactly this switch (see
   * switchPreview): the owner saw what is kept and lost, and nothing it showed changed since. The provider checks are
   * the only wait: from reading the Boton to saving the move nothing awaits, so what is checked is what is applied.
   * With `switchSummary`, the old session writes its summary first (see #moveWithSummary).
   */
  async updateBot(botId: string, input: UpdateBotInput, providers: Set<string>, switchConfirmation?: unknown, switchSummary?: unknown): Promise<Bot> {
    if (switchSummary !== undefined && typeof switchSummary !== 'boolean') throw new HttpError(400, 'switchSummary must be true or false');
    const target = typeof input?.provider === 'string' && providers.has(input.provider) ? input.provider : null;
    const was = this.store.getBot(botId).provider;
    const brains = target && target !== was ? await this.#switchBrains(was, target) : null;
    const ready = brains?.ready ?? null;
    const old = brains?.old ?? null;
    const current = this.store.getBot(botId);
    const before = current.provider;
    if (input.connections !== undefined) input = { ...input, connections: this.connectors.check(input.connections, current.connections) };
    if (input.skills !== undefined) input = { ...input, skills: this.skills.checkAllowlist(input.skills, current.skills) };
    const switching = input.provider !== undefined && input.provider !== before && providers.has(input.provider);
    if (switchSummary === true && !switching) throw new HttpError(400, 'switchSummary goes with a move to another provider');
    let handoff: ProviderHandoff | null = null;
    if (switching) {
      // Moved elsewhere by another update while the providers were checked: what was reviewed is not this.
      if (!ready || !old || was !== before) throw new HttpError(409, `What moving ${current.name} keeps and loses changed since you reviewed it: review it again`);
      // A move asked for with a summary holds the Boton until it is done: no other move goes under it.
      if (this.#summaries.has(botId)) throw new HttpError(409, `${current.name}'s session is writing a summary for a move: wait for it, then review the move again`);
      const move = { provider: input.provider!, model: input.model, effort: input.effort };
      const preview = this.#switchPreview(botId, move, input.connections, ready, old);
      if (switchSummary === true) {
        if (!preview.summary.available) throw new HttpError(409, `${preview.summary.reason}, so its session can't write a summary now: review the move again`);
        if (switchConfirmation !== preview.summary.confirmation) throw new HttpError(409, `What moving ${current.name} to ${preview.to.label} keeps and loses changed since you reviewed it: review it again`);
        return this.#moveWithSummary(current, input, providers, move, preview);
      }
      if (preview.required && switchConfirmation !== preview.confirmation) {
        throw new HttpError(
          409,
          switchConfirmation === undefined
            ? `Moving ${current.name} to ${preview.to.label} ends its session on ${preview.from.label}: review what is kept and lost (POST /api/bots/${botId}/switch-preview), then send its confirmation as switchConfirmation`
            : `What moving ${current.name} to ${preview.to.label} keeps and loses changed since you reviewed it: review it again`,
        );
      }
      handoff = this.#handoff(current, preview);
    }
    // The turn underway carries on its session on the old provider past what is saved, and that context can't come
    // with the move: the saved session it is on ends with it, so no later move back resumes it. Read with the
    // preview, so it is the session the owner was shown ending.
    const underway = switching ? this.#underway(current) : null;
    // The move, its event (whose seq is the new switch generation) and the session it ends together, or none.
    const bot = this.store.atomically(() => {
      const b = this.store.updateBot(botId, input, providers);
      if (b.provider !== before && handoff) {
        this.#recordSwitch(b, this.#brainRef(current.provider, current.model), handoff);
        if (underway?.own) this.store.dropRoutineSession(underway.own);
        else if (underway && !underway.fresh) this.store.dropSession(botId);
      }
      return b;
    });
    this.#afterUpdate(current, bot, input);
    return bot;
  }

  #afterUpdate(current: BotRecord, bot: Bot, input: UpdateBotInput): void {
    const botId = bot.id;
    if (bot.provider !== current.provider) {
      // A routine's own model is one of the old provider's: the new CLI would be asked for it on every run.
      const reset = this.store.resetRoutineModels(botId);
      if (reset.length) {
        const names = reset.map((r) => `“${r.name}” (was ${r.model})`).join(', ');
        const one = reset.length === 1 ? reset[0] : null;
        this.store.addMessage(botId, 'event', `Moved to ${this.#providerName(bot.provider)}, so ${reset.length === 1 ? 'routine' : 'routines'} ${names} now use${reset.length === 1 ? 's' : ''} the Boton's model`, {
          kind: 'routine.model_reset',
          ...(one ? { routineId: one.id, routineName: one.name } : {}),
        });
        log.info("routine models reset: the Boton moved to another provider", { botId, provider: bot.provider, routines: reset.map((r) => r.id) });
      }
      this.store.releaseUsageLimitHolds(botId);
      this.#resumeWork((id) => id === botId);
    }
    this.#effortNotes(current, bot, input);
  }

  /**
   * The move, once the old session has written its summary for the new one. The Boton is held meanwhile: its chat
   * and runs wait behind it (in its queue), and no other move or summary starts, so the summary turn is the only one
   * on the session. Everything the confirmation stands for (the providers' readiness and limits, the session, a reset,
   * another move, a pause, a restart) is checked again before the turn starts, once it has a slot, and again after it,
   * with the abort, right before the write: any change refuses the move, and the summary goes unsaved. Saved, the
   * summary and the move are one write, so the new session never starts without the summary that was asked for. A
   * summary that can't be written (no reply, a failure, its time limit, Stop, a pause) refuses the move.
   */
  async #moveWithSummary(
    current: BotRecord,
    input: UpdateBotInput,
    providers: Set<string>,
    move: ProviderSwitchInput,
    preview: SwitchFacts,
  ): Promise<Bot> {
    const botId = current.id;
    const hold = Symbol('switch summary');
    const controller = new AbortController();
    const { signal } = controller;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Free to take: the offer needs nothing queued or running for the Boton, and nothing awaited since it was read.
    this.#summaries.set(botId, { hold, controller });
    this.#chains.set(botId, gate);
    const generation = this.store.switchGeneration(botId);
    // The move as the owner confirmed it, if it still is (synchronous): the Boton, its session, and the same preview.
    const unchanged = (r: Pick<ProviderSwitchPreview['readiness'], 'state' | 'reason'>, o: OldBrain) => {
      if (!this.store.hasBot(botId)) return null;
      const now = this.store.getBot(botId);
      const same =
        now.provider === current.provider &&
        now.contextSince === current.contextSince &&
        now.sessionId === current.sessionId &&
        now.sessionKey === current.sessionKey &&
        this.store.switchGeneration(botId) === generation;
      const again = same ? this.#switchPreview(botId, move, input.connections, r, o, hold) : null;
      return again && again.summary.confirmation === preview.summary.confirmation ? { now, again } : null;
    };
    const aborted = () => (signal.reason === INTERRUPTED ? 'Botons is restarting' : signal.reason === PAUSED ? 'it was paused' : 'it was stopped');
    try {
      let written: { text: string; turnId: string };
      try {
        // Refresh both brains after acquiring the slot; a changed preview must spend no turn.
        written = await this.#writeSummary(current, preview, signal, async () => {
          const { ready: r, old: o } = await this.#switchBrains(current.provider, move.provider);
          return () => !!unchanged(r, o);
        });
      } catch (err) {
        if (err === NOT_STARTED && !signal.aborted) {
          throw new HttpError(409, `What moving ${current.name} to ${preview.to.label} keeps and loses changed while its summary waited to start, so nothing ran and nothing moved: review it again`);
        }
        const why = signal.aborted ? aborted() : errorText(err);
        throw new HttpError(409, `${current.name}'s session on ${preview.from.label} didn't write a summary (${why}), so nothing moved: move it without one, or try again`);
      }
      const { ready: r, old: o } = await this.#switchBrains(current.provider, move.provider);
      // Nothing awaits from here to the write: what is checked is what is saved.
      if (signal.aborted) {
        log.info('switch summary not saved: stopped once it was written', { botId, turnId: written.turnId, why: aborted() });
        throw new HttpError(409, `Moving ${current.name} was stopped (${aborted()}) once its summary was written, so nothing moved and the summary wasn't kept (its turn on ${preview.from.label} still ran)`);
      }
      const still = unchanged(r, o);
      if (!still) {
        log.info('switch summary not saved: the move changed while it was written', { botId, turnId: written.turnId });
        throw new HttpError(
          409,
          `What moving ${current.name} to ${preview.to.label} keeps and loses changed while its summary was being written, so nothing moved and the summary wasn't kept (its turn on ${preview.from.label} still ran): review it again`,
        );
      }
      const { now, again } = still;
      const handoff = this.#handoff(now, again);
      const { bot, summary } = this.store.atomically(() => {
        const summary = this.store.addMessage(botId, 'bot', written.text, { kind: 'provider.summary', provider: now.provider, providerLabel: preview.from.label, turnId: written.turnId });
        const bot = this.store.updateBot(botId, input, providers);
        this.#recordSwitch(bot, this.#brainRef(now.provider, now.model), { ...handoff, summary: { messageId: summary.id } });
        return { bot, summary };
      });
      this.store.linkTurnMessage(written.turnId, summary.id);
      this.#afterUpdate(now, bot, input);
      return bot;
    } finally {
      this.#summaries.delete(botId);
      release();
      if (this.#chains.get(botId) === gate) this.#chains.delete(botId);
      this.#setStatus(botId, (this.#queued.get(botId) ?? 0) > 0 ? 'queued' : 'idle');
    }
  }

  /**
   * One turn on the Boton's chat session asking for its summary (summaryRequest): no tools or connectors at all
   * (TurnRequest.toolFree, only on a provider that can run one), no token for the `botons` CLI, its own time limit,
   * and never tried again. `stillAsked` is checked once it has a slot, before anything runs. It counts as a chat turn on the old provider, usage and all. The reply is the old agent's, bounded (clipText), never trusted.
   */
  async #writeSummary(bot: BotRecord, preview: SwitchFacts, signal: AbortSignal, refreshAsked: () => Promise<() => boolean>): Promise<{ text: string; turnId: string }> {
    const provider = this.#providers.get(bot.provider);
    if (!provider) throw new Error(`${preview.from.label} is not on this server`);
    if (!provider.toolFree) throw new Error(`${preview.from.label} can't run a turn with no tools`);
    if (!(await this.#slots.acquire(signal))) throw new Error('Stopped');
    // The slot is held from here: released once, in the finally, whether the turn runs or not.
    try {
      if (signal.aborted) throw new Error('Stopped');
      const stillAsked = await refreshAsked();
      if (signal.aborted) throw new Error('Stopped');
      if (!stillAsked()) throw NOT_STARTED;
      const settings = this.store.getSettings();
      const sys = systemPrompt(bot, settings, this.#cfg);
      if (!bot.sessionId || bot.sessionKey !== sessionKey(provider.id, sys)) throw new Error(`no chat session on ${preview.from.label}`);
      const model = bot.model;
      const effort = turnEffort(bot, null, this.store.effortCaps(bot.provider, model)).effort;
      const turnId = this.store.startTurn({ botId: bot.id, trigger: 'chat', routineId: null, runId: null, provider: provider.id, requestedModel: model });
      const fields: LogFields = { botId: bot.id, turnId, provider: provider.id, model: model || undefined, ...(effort ? { effort } : {}) };
      const label = 'Writing a summary for the move';
      this.#setStatus(bot.id, 'working', label);
      log.info('switch summary started', fields);
      const started = Date.now();
      let result: TurnResult;
      try {
        result = await provider.runTurn({
          cwd: bot.workspace,
          sessionId: bot.sessionId,
          systemPrompt: sys,
          prompt: summaryRequest(preview.from, preview.to, settings.ownerName),
          model,
          ...(effort ? { effort } : {}),
          access: 'workspace',
          privatePaths: privatePaths({
                env: { ...process.env, ...cliHomesEnv() },
            workspace: bot.workspace,
            cli: provider.cli ?? null,
            botonsHome: this.#cfg.home,
            workspacesDir: this.#cfg.workspacesDir,
            extra: this.#cfg.privatePaths,
            shared: [],
          }),
          sharedDirs: [],
          protectInstructions: true,
          groupDir: this.#cfg.agentsDir,
          // No BOTONS_API or BOTON_TOKEN: nothing in this turn may act as the Boton.
          env: {},
          toolFree: true,
          spend: { botId: bot.id, turnId, runId: null, routineId: null },
          signal,
          timeoutMs: SWITCH_SUMMARY_MS,
          onActivity: (a) => this.#setStatus(bot.id, 'working', `${label}: ${a}`),
        });
      } catch (err) {
        const outcome = timedOut(err) ? 'timeout' : signal.aborted ? (signal.reason === INTERRUPTED ? 'interrupted' : 'stopped') : 'error';
        const usage = err instanceof ProviderError ? (err.usage ?? null) : null;
        this.store.finishTurn(turnId, { outcome, errorKind: outcome === 'error' && err instanceof ProviderError ? err.kind : null, durationMs: Date.now() - started, usage, model: usage?.model, replayedTranscript: false });
        if (err instanceof ProviderError && err.kind === 'usage_limit' && !signal.aborted) this.#limitHit(bot, err);
        if (outcome === 'error') this.#providers.recordTurn(provider.id, { ok: false, error: errorText(err) });
        log.warn('switch summary failed', { ...fields, outcome, error: errorText(err) });
        if (outcome === 'timeout') throw new Error(`it ran past its time limit (${durationText(SWITCH_SUMMARY_MS)})`);
        throw err;
      }
      this.store.finishTurn(turnId, { outcome: 'ok', durationMs: Date.now() - started, usage: result.usage ?? null, model: result.usage?.model, replayedTranscript: false });
      this.#providers.recordTurn(provider.id, { ok: true });
      const { text, cut } = clipText(result.text, SWITCH_SUMMARY_CHARS);
      log.info('switch summary written', { ...fields, chars: text.length, cut, ...usageFields(result.usage ?? null) });
      if (!text) throw new Error('it replied with nothing');
      return { text, turnId };
    } finally {
      this.#slots.release();
    }
  }

  /**
   * The note for the new provider's first turn, taken now from what Botons stores. A switch whose note no turn has
   * had yet hands on what that one was moving away from: the provider whose session and context were last live.
   */
  #handoff(bot: BotRecord, preview: SwitchFacts): ProviderHandoff {
    const now = new Date();
    // Back to where it was before a switch no turn ran on, with the session saved there to resume: that one was the
    // move, not this. A session that move ended (a turn was on it) is not there to go back to, so its note stands.
    const pending = this.store.pendingHandoff(bot.id, bot.contextSince);
    const underway = this.#underway(bot);
    const resumes = !!bot.sessionId && !(underway && !underway.own && !underway.fresh);
    const earlier = pending && (pending.meta.handoff.from.provider !== preview.to.provider || !resumes) ? pending : null;
    const { runs, dueSoon } = this.store.activeRuns(bot.id, new Date(now.getTime() + 86_400_000), HANDOFF_ITEMS);
    return {
      from: earlier ? earlier.meta.handoff.from : { provider: preview.from.provider, label: preview.from.label, model: preview.from.model },
      to: { provider: preview.to.provider, label: preview.to.label, model: preview.to.model },
      at: now.toISOString(),
      sessionEnded: preview.sessions.chat || !!earlier?.meta.handoff.sessionEnded,
      ...(preview.working || earlier?.meta.handoff.working ? { working: true } : {}),
      kept: preview.kept,
      waiting: this.approvals
        .pendingFor(bot.id)
        .slice(-HANDOFF_ITEMS)
        .map((a) => ({ id: a.id, title: a.title })),
      runs,
      dueSoon,
      decisions: this.approvals.recentDecisions(bot.id, new Date(now.getTime() - 7 * 86_400_000), HANDOFF_ITEMS),
      // The summary an earlier move's session wrote, which no turn has had yet (a move with one replaces it).
      ...(earlier?.meta.handoff.summary ? { summary: earlier.meta.handoff.summary } : {}),
    };
  }

  /** `from`: what this move left, which the note's `from` is not when it hands on an earlier move's. */
  #recordSwitch(bot: Bot, from: BrainRef, handoff: ProviderHandoff): void {
    const earlier = this.store.pendingHandoff(bot.id, this.store.contextSince(bot.id));
    if (earlier) this.store.endHandoff(earlier.id);
    const name = (b: ProviderHandoff['from']) => `${b.label} (${b.model || 'its default model'})`;
    const tail = handoff.sessionEnded ? `: its session on ${handoff.from.label} ended, so the next turn starts a new one with a handoff note` : ': the next turn starts with a handoff note';
    this.store.addMessage(bot.id, 'event', `Moved from ${name(from)} to ${name(handoff.to)}${tail}`, { kind: 'provider.switched', provider: bot.provider, handoff });
    log.info('provider switched: the next chat turn starts with a handoff note', { botId: bot.id, provider: bot.provider });
  }

  /**
   * What an update did to the levels turns ask for, said in the chat: a level the Boton's new provider or model
   * doesn't have, which goes back to the default (the Boton's own, unless this update set it: the owner's choice, said
   * nowhere), and routines whose own model's list leaves out the Boton's new level, whose runs then ask for none.
   */
  #effortNotes(before: BotRecord, bot: Bot, input: UpdateBotInput): void {
    const name = this.#providerName(bot.provider);
    const gap = (effort: string, model: string) =>
      effortProblem(bot.provider, effort) ? `${name} has no effort level “${effort}”` : `${name}'s model list has no effort level “${effort}” for ${model || 'its default model'}`;
    const moved = bot.provider !== before.provider || bot.model !== before.model;
    if (moved) {
      for (const r of this.store.resetRoutineEfforts(bot.id)) {
        this.store.addMessage(bot.id, 'event', `${gap(r.effort!, r.model || bot.model)}, so routine “${r.name}” (was ${r.effort}) now uses the Boton's effort`, {
          kind: 'effort.reset',
          routineId: r.id,
          routineName: r.name,
        });
      }
    }
    if (moved && input.effort === undefined && before.effort && !bot.effort) {
      this.store.addMessage(bot.id, 'event', `${gap(before.effort, bot.model)}, so this Boton now asks for none: the CLI uses its default`, { kind: 'effort.reset' });
    }
    if (bot.effort && (bot.effort !== before.effort || moved)) {
      for (const r of this.store.listRoutines(bot.id)) {
        if (r.effort || !r.model || !effortProblem(bot.provider, bot.effort, this.store.effortCaps(bot.provider, r.model))) continue;
        this.store.addMessage(bot.id, 'event', `${gap(bot.effort, r.model)}, so routine “${r.name}” asks for none on its runs: give it an effort of its own`, {
          kind: 'effort.reset',
          routineId: r.id,
          routineName: r.name,
        });
      }
    }
  }

  pauseAll(paused: boolean): Settings {
    const settings = this.store.setPausedAll(paused);
    // A move's summary too, waiting for a slot or writing: stopped for good, so a resume doesn't bring it back.
    if (paused) for (const botId of new Set([...this.#jobs.keys(), ...this.#summaries.keys()])) this.#halt(botId, PAUSED);
    else this.#resumeWork(() => true);
    return settings;
  }

  /** `why`: what a move's summary being written is told (the Boton's jobs are stopped either way). */
  #halt(botId: string, why: Error = STOPPED) {
    this.#summaries.get(botId)?.controller.abort(why);
    const job = this.#jobs.get(botId);
    job?.wait.abort();
    if (job) this.#abortTurn(job, STOPPED);
  }

  /** Ends the job's turn: its agent process, or (its connectors still being set up) the one it was about to start. */
  #abortTurn(job: Job, reason: Error) {
    job.aborted ??= job.turn?.signal.aborted ? job.turn.signal.reason : reason;
    job.turn?.abort(job.aborted);
  }

  /** Never rejects: a run whose row is gone resolves as failed. */
  waitForRun(run: RoutineRun, timeoutMs: number, signal?: AbortSignal): Promise<RoutineRun> {
    return new Promise((resolve) => {
      let last = run;
      const current = (reason: string) => this.store.findRun(run.id) ?? goneRun(last, reason);
      const done = (r: RoutineRun) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        this.#closing.signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => done(current('Run was deleted'));
      this.#closing.signal.addEventListener('abort', onAbort, { once: true });
      const unsubscribe = this.#hub.subscribe((ev) => {
        if (ev.type === 'run.upserted' && ev.run.id === run.id) {
          last = ev.run;
          if (isFinished(ev.run)) done(ev.run);
        } else if (ev.type === 'routine.deleted' && ev.routineId === run.routineId) {
          done(current('Routine was deleted'));
        } else if (ev.type === 'bot.deleted' && ev.botId === run.botId) {
          done(current('Boton was deleted'));
        }
      });
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const now = current('Run was deleted');
      if (isFinished(now) || signal?.aborted || this.#closing.signal.aborted) done(now);
    });
  }

  get closing(): AbortSignal {
    return this.#closing.signal;
  }

  endWaits(): void {
    this.#closing.abort();
  }

  // ------------------------------------------------------------------- queue

  #enqueue(botId: string, work: Work) {
    this.#queued.set(botId, (this.#queued.get(botId) ?? 0) + 1);
    if (this.statusOf(botId).state === 'idle') this.#setStatus(botId, 'queued');
    const prev = this.#chains.get(botId) ?? Promise.resolve();
    const next = prev
      .then(() => this.#execute(botId, work))
      .catch((err) => log.error('job failed', { botId, err }));
    this.#chains.set(botId, next);
    void next.then(() => {
      if (this.#chains.get(botId) === next) this.#chains.delete(botId);
    });
  }

  async #execute(botId: string, work: Work) {
    this.#queued.set(botId, (this.#queued.get(botId) ?? 1) - 1);
    try {
      // Shutting down: the message stays pending and the run queued, for the next process.
      if (this.#draining || this.#maintenance) return;
      if (!this.store.hasBot(botId)) {
        if (work.kind === 'routine') this.#failRunQuietly(work.runId, 'Boton was deleted');
        return;
      }
      // Paused: resuming queues it again.
      if (!this.#hasWork(botId, work) || this.store.pausedReason(botId)) return;
      const job: Job = { wait: new AbortController(), ...(work.kind === 'routine' ? { runId: work.runId } : {}) };
      this.#jobs.set(botId, job);
      let slot = false;
      try {
        slot = await this.#slots.acquire(job.wait.signal);
        if (this.#draining || this.#maintenance || this.store.pausedReason(botId)) return;
        // Only stop(), pausing and cancelling its run give up the wait.
        if (!slot) return this.#stoppedBeforeStart(botId, work);
        if (work.kind === 'chat') await this.#chatTurn(botId, job);
        else await this.#routineTurn(botId, work.runId, job);
      } finally {
        if (slot) this.#slots.release();
        this.#jobs.delete(botId);
      }
    } finally {
      this.#setStatus(botId, (this.#queued.get(botId) ?? 0) > 0 ? 'queued' : 'idle');
    }
  }

  #hasWork(botId: string, work: Work): boolean {
    if (work.kind === 'chat') return this.store.hasPendingChat(botId);
    const run = this.store.findRun(work.runId);
    if (run?.status !== 'queued') return false;
    if (run.retryAt && new Date(run.retryAt).getTime() > Date.now()) {
      this.#wakeRun(run);
      return false;
    }
    return true;
  }

  #stoppedBeforeStart(botId: string, work: Work) {
    if (work.kind === 'chat') {
      if (this.store.dropPendingChat(botId)) this.#postStopped(botId);
      return;
    }
    const run = this.store.findRun(work.runId);
    if (run?.status !== 'queued') return;
    this.#failRunQuietly(run.id, 'Stopped', { cancelled: { started: run.attempts > 0 } });
    this.#postStopped(botId, run);
  }

  #chipCutOff(botId: string, turn: TurnInfo, text: string) {
    if (!turn.id || !turn.steps) return;
    try {
      if (!this.store.hasBot(botId)) return;
      this.#linkTurn(turn, this.store.addMessage(botId, 'event', text, { kind: 'turn.interrupted', ...this.#turnMeta(turn) }));
    } catch (err) {
      log.debug('could not post the chip of a cut-off turn', { botId, err });
    }
  }

  #postStopped(botId: string, run?: RoutineRun, turn?: TurnInfo, text = 'Stopped'): Message {
    const name = run ? this.store.findRoutineName(run.routineId) : null;
    return this.store.addMessage(botId, 'event', text, {
      kind: 'turn.stopped',
      ...(run ? { routineId: run.routineId, ...(name ? { routineName: name } : {}), runId: run.id } : {}),
      ...(turn ? this.#turnMeta(turn) : {}),
    });
  }

  #failRunQuietly(runId: string, error: string, how?: { cancelled?: { started: boolean }; timedOut?: { limitMs: number } }) {
    try {
      this.store.updateRun(runId, { status: 'failed', error, ...how });
    } catch {}
  }

  // ------------------------------------------------------------------- turns

  /** The turn has read the Boton: what it runs on from now, whatever the Boton changes to meanwhile. Synchronous. */
  #readBy(job: Job, bot: BotRecord, routine?: { routine: Routine; trigger: RunTrigger }) {
    const session = routine ? runSession(routine.routine, routine.trigger) : 'chat';
    job.read = Object.freeze({
      stamp: Object.freeze({ contextSince: bot.contextSince, provider: bot.provider, generation: this.store.switchGeneration(bot.id) }),
      handoff: this.store.pendingHandoff(bot.id, bot.contextSince),
      own: session === 'own' ? routine!.routine.id : null,
      fresh: session === 'fresh',
    });
  }

  async #chatTurn(botId: string, job: Job) {
    const bot = orNull(() => this.store.getBot(botId));
    if (!bot) return;
    this.#readBy(job, bot);
    const until = this.#coolingUntil(bot.provider);
    if (until) return this.#noticeUsageLimit(bot, until);
    // Marks them in flight: if the process dies before the reply is saved, the next one re-runs them with a note.
    const { messages: pending, interrupted, more } = this.store.startChatTurn(botId);
    if (!pending.length) return;
    // Messages for another audience wait for a turn of their own, once this one's are answered.
    const next = () => {
      if (more && !this.store.pausedReason(botId)) this.#enqueue(botId, { kind: 'chat' });
    };
    const ids = pending.map((m) => m.id);
    const started = Date.now();
    const startedAt = nowIso();
    const turn = newTurnInfo();
    // The owner's reactions not yet given (to a turn for the owner, never a colleague's ask), and the owner's own
    // messages it may react to.
    const feedback = pending.some((m) => m.meta?.kind === 'ask') ? [] : this.reactions.feedback(botId);
    const reactable = pending.filter(ownersOwn).map((m) => m.id);
    try {
      const owner = this.store.getSettings().ownerName;
      const found = await attachmentsNow(bot.workspace, pending);
      const text = chatInput(
        pending.map((m) => {
          // What the Boton reads of a decision comes from the approval request as saved.
          if (m.meta?.kind === 'approval.decided') return { ...m, text: this.approvals.decisionPrompt(m, owner) };
          if (m.meta?.kind === 'work.event') return { ...m, text: workEventPrompt(m.meta.work, owner) };
          if (m.meta?.kind === 'connector.granted') return { ...m, text: grantedPrompt(m.meta.connectorId ?? '') };
          if (m.meta?.kind === 'reaction.followup') return { ...m, text: this.#followUpText(m, owner) };
          if (m.meta?.kind === 'card.answered') return { ...m, text: `(${owner}'s answer to your card ${(m.meta.cardId ?? '').replace(/[^A-Za-z0-9_-]/g, '')}, from the chat:)\n${m.text}` };
          // Only the owner's messages run a /<skill>, not another Boton's.
          const call = m.meta?.fromBotId || m.meta?.kind ? null : this.skills.invoked(bot, m.text);
          const typed = call ? { ...m, text: skillInvocation(m.text, call.skill, call.input, owner) } : m;
          return { ...typed, text: withAttachments(typed, bot.workspace, found, owner) };
        }),
        owner,
      );
      const images = pending.flatMap((m) => m.meta?.attachments ?? []).flatMap((a) => {
        const at = found.get(a.path);
        return at && isAttachableImage(a) ? [at] : [];
      });
      const askers = [...new Set(pending.flatMap((m) => (m.meta?.kind === 'ask' && m.meta.fromBotName ? [m.meta.fromBotName] : [])))];
      const left = this.#unanswered.get(botId);
      this.#unanswered.delete(botId);
      const unanswered = !!left && pending.some((m) => left.has(m.id));
      const body = `${interrupted ? `${INTERRUPTED_NOTE}\n\n` : ''}${unanswered ? `${unansweredNote(owner)}\n\n` : ''}${text}`;
      const result = await this.#invoke(bot, chatTrigger(pending), body, turn, job, { ids, images, askers, chain: threadOf(pending), reactable, feedback });
      this.reactions.markTold(feedback);
      const note = this.#quietReply(result.text, pending.some(ownersOwn), turn);
      if (note !== null) {
        this.store.atomically(() => {
          // Linked and marked together: a quiet turn whose first message is marked has exactly its own marked.
          this.store.linkTurnMessage(turn.id, ids[0]!);
          this.store.markProcessed(ids);
          // Nothing was posted, so the wake-ups it answered and what it did in the chat leave the transcript too (the
          // API and history keep them).
          this.store.markQuiet(turn.id, ids);
        });
        this.#answerAsks(bot, pending, note || '(nothing to report)');
        return next();
      }
      // Reacted instead of replying (exactly [quiet], nothing more), to the owner's own messages only: each message it
      // reacted to in this turn is answered with nothing posted. One it didn't react to waits for another turn, which
      // ends: each such turn answers at least one message, and one that reacts to none posts its reply as usual.
      const quiet = !result.text.trim() || QUIET_ONLY.test(result.text.trim());
      const reacted = quiet && pending.every(ownersOwn) ? this.reactions.botonReactedTo(botId, ids, startedAt) : new Set<string>();
      if (reacted.size) {
        const waiting = ids.filter((id) => !reacted.has(id));
        this.store.atomically(() => {
          this.store.markProcessed([...reacted]);
          this.store.requeueChat(waiting);
        });
        if (waiting.length) {
          this.#unanswered.set(botId, new Set(waiting));
          this.#enqueue(botId, { kind: 'chat' });
        } else next();
        return;
      }
      const reply = result.text.trim() || '(no reply)';
      const posted = this.store.finishChatTurn(ids, botId, reply, this.#postMeta(bot, this.#replyMeta(bot, started, turn)));
      this.store.linkTurnMessage(turn.id, posted.id);
      this.#answerAsks(bot, pending, reply);
      next();
    } catch (err) {
      // Ran past its time limit first: an error like any other, whatever came while it was exiting.
      const reason = timedOut(err) ? null : abortReason(job);
      // Cut off by a shutdown: the messages stay in flight for the next process.
      if (reason === INTERRUPTED) return void this.#chipCutOff(botId, turn, 'Cut off by a restart');
      // The usage limit: they stay in flight too (so the retry gets the note) until it resets.
      if (err instanceof ProviderError && err.kind === 'usage_limit' && reason !== STOPPED) {
        this.#noticeUsageLimit(bot, this.#limitHit(bot, err));
        this.#chipCutOff(botId, turn, 'Cut off by the usage limit');
        return;
      }
      this.store.markProcessed(ids);
      if (!this.store.hasBot(botId)) return;
      next();
      if (reason === STOPPED) return void this.#linkTurn(turn, this.#postStopped(botId, undefined, turn));
      const msg = timedOut(err) ? `Stopped: the turn ran past its time limit (${durationText(turn.limitMs)}). It may have partly run.` : errorText(err);
      this.#linkTurn(turn, this.#post(bot, 'error', msg, this.#turnMeta(turn)));
      // A Boton waiting on an answer hears that none is coming (not when the owner stopped the turn: they meant to).
      this.#answerAsks(bot, pending, `(${bot.name} could not answer: ${msg})`);
    }
  }

  async #routineTurn(botId: string, runId: string, job: Job) {
    const started = Date.now();
    const queued = this.store.findRun(runId);
    // Gone: its routine or Boton was deleted while it was queued, and the delete already failed it.
    if (!queued || queued.status !== 'queued') return;
    const routine = orNull(() => this.store.getRoutine(queued.routineId));
    if (!routine) return this.#failRunQuietly(runId, 'Routine was deleted');
    const bot = orNull(() => this.store.getBot(botId));
    if (!bot) return this.#failRunQuietly(runId, 'Boton was deleted');
    this.#readBy(job, bot, { routine, trigger: queued.trigger });
    // A network retry is dropped once its routine is paused or (a scheduled one) its next slot has come; one held for a usage limit runs at the reset.
    if (queued.attempts > 0 && this.store.runHeldFor(runId) !== 'usage_limit') {
      const paused = routinePaused(routine, queued);
      const slotDue = queued.trigger === 'schedule' && !!routine.nextRunAt && new Date(routine.nextRunAt).getTime() <= Date.now();
      if (paused || slotDue) return this.#failRun(bot, routine, queued, queued.lastError ?? 'Failed', paused ? 'the routine was paused' : 'its next scheduled run is due');
    }
    const until = this.#coolingUntil(bot.provider);
    if (until) {
      this.store.holdRun(runId, until, `${this.#providerName(bot.provider)} usage limit until ${when(until, bot.timezone)}`, 'usage_limit');
      this.#noticeUsageLimit(bot, until);
      return;
    }
    const run = this.store.startRun(runId);
    job.run = { runId, routineId: routine.id, routineName: routine.name, trigger: run.trigger };
    const turn = newTurnInfo();
    try {
      const trigger: Trigger = { kind: 'routine', routine, run };
      const { access, sandboxed } = turnScope(bot, trigger);
      const skill = routine.skill ? (this.skills.enabledFor(bot, routine.skill) ?? { missing: routine.skill }) : undefined;
      // The run record has the whole payload, which RoutineRun only previews.
      const prompt = routinePrompt(routine, this.store.findRunRecord(runId)!, { owner: this.store.getSettings().ownerName, sandboxed, held: access !== bot.access, skill, limitMs: this.#limitFor(routine), session: runSession(routine, run.trigger) });
      const result = await this.#invoke(bot, trigger, prompt, turn, job);
      const note = this.#quietReply(result.text, false, turn);
      if (note !== null) {
        if (this.store.findRun(runId)) this.store.updateRun(runId, { status: 'succeeded', quiet: true, reply: note ? note.slice(0, 8000) : null });
        // What it did in the chat goes with it.
        if (this.store.hasBot(botId)) this.store.markQuiet(turn.id, []);
        return;
      }
      const text = result.text.trim() || '(no reply)';
      // The routine (and this run) may have been deleted during the turn, by the Boton even: the reply still belongs in the chat.
      if (this.store.hasBot(botId)) {
        this.#postRunChip(bot, routine, run);
        this.#linkTurn(turn, this.#post(bot, 'bot', text, { ...this.#replyMeta(bot, started, turn), routineId: routine.id, routineName: routine.name, runId }));
      }
      if (this.store.findRun(runId)) {
        this.store.updateRun(runId, { status: 'succeeded', reply: text.slice(0, 8000) });
        if (this.#policyOf(routine) === 'always' && run.trigger !== 'test') {
          this.#pushForRun(runId, {
            bot,
            reason: 'result',
            detail: `“${routine.name}”: ${text}`,
            generic: 'A routine has a new result.',
            priority: 'default',
          });
        }
      }
    } catch (err) {
      // Ran past its time limit before a stop, cancel or shutdown reached it: it ends as timed out.
      const reason = timedOut(err) ? null : abortReason(job);
      // Cut off by a shutdown: the run stays running, and the next process marks it interrupted.
      if (reason === INTERRUPTED) return;
      // Deleted mid-turn: it already ended as failed.
      if (!this.store.findRun(runId)) return;
      // The owner ended it: never retried by itself, and no push about a failure they caused.
      if (reason === STOPPED || reason === CANCELLED) {
        const why = reason === CANCELLED ? 'Cancelled' : 'Stopped';
        // An agent process got this attempt's prompt, or an earlier attempt (held to try again) ran.
        this.#failRunQuietly(runId, why, { cancelled: { started: !!job.spawned || run.attempts > 1 } });
        if (this.store.hasBot(botId)) {
          this.#postRunChip(bot, routine, run);
          this.#linkTurn(turn, this.#postStopped(botId, this.store.getRun(runId), turn, why));
        }
        return;
      }
      // Never tried again by itself (not even a scheduled run): it may have partly run, and would likely run as long again.
      if (timedOut(err)) {
        log.warn('run stopped at its time limit', { botId, routineId: routine.id, runId, trigger: run.trigger, attempt: run.attempts, timeLimitMs: turn.limitMs });
        return this.#failRun(bot, routine, run, `Ran past its time limit (${durationText(turn.limitMs)}) and was stopped`, undefined, turn, turn.limitMs);
      }
      const msg = errorText(err);
      if (err instanceof ProviderError && err.kind === 'usage_limit') {
        const reset = this.#limitHit(bot, err);
        this.store.holdRun(runId, reset, msg, 'usage_limit');
        this.#noticeUsageLimit(bot, reset);
        return;
      }
      const delay = this.#retryDelay(run, err);
      if (delay !== null) {
        const held = this.store.holdRun(runId, new Date(Date.now() + delay), msg, 'retry');
        log.warn('run failed on a network error: trying again later', { botId, routineId: routine.id, runId, trigger: run.trigger, attempt: held.attempts, retryAt: held.retryAt, error: msg.slice(0, 200) });
        this.#wakeRun(held);
        return;
      }
      const unknownModel = err instanceof ProviderError && err.kind === 'other' && !!routine.model && routine.model !== bot.model;
      const hint = unknownModel ? ` (This routine asks for the model “${routine.model}”, not the Boton's: if ${this.#providerName(bot.provider)} doesn't have it, change or clear the routine's model.)` : '';
      this.#failRun(bot, routine, run, `${msg}${hint}`, undefined, turn);
    }
  }

  /**
   * What every turn's local connectors never see (connector-launch.ts), whatever the Boton's access: the data folder,
   * every workspace and the shared folder by any path, and this Boton's private paths where they fall in their view.
   */
  #connectorLaunch(bot: BotRecord, provider: Provider): LaunchPolicy {
    const workspaces = this.store.listBots().map((b) => b.workspace);
    const apart = [this.#cfg.home, this.#cfg.workspacesDir, this.#cfg.sharedDir, bot.workspace, ...workspaces];
    const hidden = privatePaths({
      env: { ...process.env, ...cliHomesEnv() },
      workspace: bot.workspace,
      cli: provider.cli ?? null,
      botonsHome: this.#cfg.home,
      workspacesDir: this.#cfg.workspacesDir,
      extra: this.#cfg.privatePaths,
      shared: [this.#cfg.sharedDir],
    });
    return { apart, hidden, dir: this.connectors.launchDir };
  }

  /** A turn's time limit: a routine's own, never past the server's (which may have been lowered since it was set). */
  #limitFor(routine: Routine | null): number {
    return Math.min(routine?.timeLimitMs ?? this.#cfg.turnTimeoutMs, this.#cfg.turnTimeoutMs);
  }

  #postRunChip(bot: BotRecord, routine: Routine, run: RoutineRun) {
    this.#post(bot, 'event', ...runChip(run, routine.name));
  }

  /** `timedOutAt`: the time limit it ran past, in ms. */
  #failRun(bot: BotRecord, routine: Routine, run: RoutineRun, msg: string, why?: string, turn?: TurnInfo, timedOutAt?: number) {
    this.#failRunQuietly(run.id, msg, timedOutAt ? { timedOut: { limitMs: timedOutAt } } : undefined);
    const tries = run.attempts > 1 ? ` after ${run.attempts} attempts` : '';
    const raise =
      timedOutAt === undefined
        ? ''
        : timedOutAt < this.#cfg.turnTimeoutMs
          ? `. It may have partly run, so it isn't tried again by itself. If it needs longer, raise its time limit (up to ${durationText(this.#cfg.turnTimeoutMs)}).`
          : `. It may have partly run, so it isn't tried again by itself. ${durationText(timedOutAt)} is the longest this server lets a turn run (BOTONS_TURN_TIMEOUT_MS).`;
    const note = why ? ` (not tried again: ${why})` : raise;
    if (this.store.hasBot(bot.id)) {
      this.#postRunChip(bot, routine, run);
      const meta: MessageMeta = { routineId: routine.id, routineName: routine.name, runId: run.id, ...(turn ? this.#turnMeta(turn) : {}) };
      const error = this.#post(bot, 'error', `Routine “${routine.name}” failed${tries}: ${msg}${note}`, meta);
      if (turn) this.#linkTurn(turn, error);
    }
    if (this.#policyOf(routine) !== 'never' && run.trigger !== 'test') {
      this.#pushForRun(run.id, {
        bot,
        reason: 'failure',
        detail: `“${routine.name}” failed${tries}: ${msg}`,
        generic: 'A routine failed.',
        priority: 'high',
      });
    }
  }

  #limitHit(bot: BotRecord, err: ProviderError): Date {
    let reset = err.retryAt ?? new Date(Date.now() + DEFAULT_COOLDOWN_MS);
    // A reset that has already come would re-run the turn at once: wait a minute instead.
    if (reset.getTime() <= Date.now()) reset = new Date(Date.now() + MIN_COOLDOWN_MS);
    this.#startCooldown(bot.provider, reset, err.message);
    return this.#coolingUntil(bot.provider) ?? reset;
  }

  #retryDelay(run: RoutineRun, err: unknown): number | null {
    if (!(err instanceof ProviderError) || err.kind !== 'transient') return null;
    if (byHand(run) || run.attempts > this.#cfg.runRetries) return null;
    const delay = this.#cfg.runRetryDelayMs * RETRY_STEPS[Math.min(run.attempts, RETRY_STEPS.length) - 1];
    const routine = orNull(() => this.store.getRoutine(run.routineId));
    if (!routine || routinePaused(routine, run)) return null;
    if (run.trigger === 'schedule' && routine.nextRunAt && new Date(routine.nextRunAt).getTime() <= Date.now() + delay) return null;
    return delay;
  }

  pushInterrupted(runs: RoutineRun[]): void {
    for (const run of runs) {
      const routine = orNull(() => this.store.getRoutine(run.routineId));
      const bot = routine && orNull(() => this.store.getBot(run.botId));
      if (!routine || !bot || routine.notify === 'never' || run.trigger === 'test') continue;
      this.#pushForRun(run.id, {
        bot,
        reason: 'failure',
        detail: `“${routine.name}” was interrupted by a restart`,
        generic: 'A routine failed.',
        priority: 'high',
      });
    }
  }

  /** The routine's notify policy now (the Boton may have changed it during the run), else as the run started. */
  #policyOf(routine: Routine): NotifyPolicy {
    return orNull(() => this.store.getRoutine(routine.id).notify) ?? routine.notify;
  }

  #pushForRun(runId: string, req: PushRequest): void {
    void this.notifier
      .push(req)
      .then((deliveries) => {
        for (const d of deliveries) this.store.addRunDelivery(runId, d);
      })
      .catch((err) => log.warn('could not record a push for a run', { runId, err }));
  }

  async notify(botId: string, text: unknown, priority: unknown = 'default'): Promise<NotifyResult> {
    const bot = this.store.getBot(botId);
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    const t = text.trim();
    if (t.length > 1000) throw new HttpError(400, 'text is too long (max 1000 characters)');
    if (priority !== 'default' && priority !== 'high') throw new HttpError(400, 'priority must be "default" or "high"');
    const current = this.#jobs.get(botId)?.run;
    const chip: MessageMeta = { kind: 'notify.sent', notifyText: t, priority, ...runMeta(current) };
    const message = this.store.addMessage(botId, 'event', 'Sent a notification', this.#postMeta(this.#turns.get(botId)?.bot ?? bot, chip));

    let skipped: string | null = null;
    const policy = current ? orNull(() => this.store.getRoutine(current.routineId).notify) : null;
    const now = Date.now();
    const recent = (this.#notifyPushes.get(botId) ?? []).filter((at) => now - at < 3_600_000);
    if (!this.notifier.enabled) skipped = 'push notifications are not set up';
    else if (current?.trigger === 'test') skipped = `this is a test run of routine “${current.routineName}”, which pushes nothing`;
    else if (policy === 'never') skipped = `routine “${current!.routineName}” is set to never notify`;
    else if (policy === 'failures') skipped = `routine “${current!.routineName}” only notifies about failures`;
    else if (recent.length >= NOTIFY_PUSHES_PER_HOUR) skipped = `already sent ${NOTIFY_PUSHES_PER_HOUR} pushes in the last hour`;
    if (skipped) return { message, deliveries: [], skipped };

    this.#notifyPushes.set(botId, [...recent, now]);
    const deliveries = await this.notifier.push({ bot, reason: 'notify', detail: t, generic: 'New notification.', priority });
    if (current) for (const d of deliveries) this.store.addRunDelivery(current.runId, d);
    return { message, deliveries, skipped: null };
  }

  async shareFile(botId: string, path: unknown, title: unknown): Promise<ShareResult> {
    const bot = this.store.getBot(botId);
    if (typeof path !== 'string' || !path.trim()) throw new HttpError(400, 'path is required');
    if (title !== undefined && title !== null && typeof title !== 'string') throw new HttpError(400, 'title must be a string');
    const t = (title ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > 200) throw new HttpError(400, 'title is too long (max 200 characters)');
    const found = await resolveInWorkspace(bot.workspace, path.trim());
    if (found.stat.isDirectory()) throw new HttpError(400, `${path.trim()} is a folder: share a file in it`);
    if (!found.stat.isFile()) throw new HttpError(400, `${path.trim()} is not a regular file`);
    const file = fileRef(found);
    const chip: MessageMeta = { kind: 'file.shared', file: { ...file, ...(t ? { title: t } : {}) }, ...runMeta(this.#jobs.get(botId)?.run) };
    const message = this.store.addMessage(botId, 'event', `Shared ${file.path}`, this.#postMeta(this.#turns.get(botId)?.bot ?? bot, chip));
    return { message, file };
  }

  /** A follow-up reaction's request, from the message as saved (its start) and the reaction the server recorded. */
  #followUpText(m: Message, owner: string): string {
    const target = m.meta?.reactionTo ? this.store.findMessage(m.meta.reactionTo) : null;
    return reactionFollowUpPrompt(m.meta?.emoji ?? '', m.meta?.reactionTo ?? '', target && target.botId === m.botId ? excerptOf(target.text) : null, owner);
  }

  /** All automatic replies share the same suppression rule; owner replies use reactions instead. */
  #quietReply(text: string, owner: boolean, turn: TurnInfo): string | null {
    const note = owner ? null : parseQuiet(text);
    if (note !== null) {
      this.store.saveQuietTurnNote(turn.id, turn.steps++, note);
    }
    return note;
  }

  #post(bot: BotRecord, role: 'bot' | 'error' | 'event', text: string, meta: MessageMeta | null = null): Message {
    return this.store.addMessage(bot.id, role, text, this.#postMeta(bot, meta));
  }

  /** A message answering a conversation reset since `bot` was read is marked stale, out of the new transcript. */
  #postMeta(bot: BotRecord, meta: MessageMeta | null): MessageMeta | null {
    const stale = this.store.contextSince(bot.id) !== bot.contextSince;
    return stale ? { ...meta, staleContext: true } : meta;
  }

  #context(
    bot: BotRecord,
    trigger: Trigger,
    settings: Settings,
    mcp: ResolvedConnectors & { offForWebhook: boolean },
    lastTurn: { id: string; reason: string }[],
    sandboxed: boolean,
    askFirst: boolean,
    chat: { reactable?: string[]; feedback?: Feedback[] } = {},
  ): string {
    const team = settings.primaryBotId === bot.id ? this.store.team(bot.id) : undefined;
    // Chat-side context, so never for a run on its own session or a webhook run's fresh one.
    const results = trigger.kind === 'chat' || runSession(trigger.routine, trigger.run.trigger) === 'chat' ? this.store.ownSessionResults(bot.id) : [];
    const routine = trigger.kind === 'routine' ? trigger.routine : null;
    const model = routine?.model || bot.model;
    const known = this.store.effortCaps(bot.provider, model);
    const { effort, dropped } = turnEffort(bot, routine, known);
    const brain: TurnBrain = {
      provider: this.#providerName(bot.provider),
      model,
      effort,
      ...(dropped ? { dropped } : {}),
      ...(!effort && known?.defaultEffort ? { listedDefault: known.defaultEffort } : {}),
      ...(routine?.model ? { routineModel: true } : {}),
      ...(routine?.effort && !dropped ? { routineEffort: true } : {}),
    };
    return contextBlock(bot, settings, trigger, this.store.listRoutines(bot.id), this.store.listMemories(bot.id), {
      brain,
      team,
      sharedDir: sandboxed ? undefined : this.#cfg.sharedDir,
      connectors: mcp.servers.map((s) => s.name),
      connectorsOff: mcp.offForWebhook,
      connectorsLeftOut: mcp.skipped,
      connectorsLastTurn: lastTurn,
      connectorsRemoved: this.connectors
        .notices(bot)
        .filter((n) => n.kind === 'removed')
        .map((n) => n.name),
      requestable: sandboxed || mcp.offForWebhook ? 0 : this.connectors.forBoton(bot).filter((c) => c.state === 'available').length,
      // The browser comes as one of its connectors, so only when it got the connector's server this turn.
      browser: mcp.ids[BROWSER_SERVER] === BROWSER_CONNECTOR && this.browser ? { sites: this.browser.sites(bot.id) } : null,
      skills: this.skills.index(bot),
      results,
      reactable: chat.reactable,
      feedback: chat.feedback,
      approvals: {
        pending: this.approvals.pendingFor(bot.id),
        alwaysAllow: bot.alwaysAllow,
        askFirst: askFirst ? splitRules(bot.askFirst, bot.alwaysAllow, sandboxed).ask : [],
      },
    });
  }

  /**
   * What the CLI showed of the connectors it was given: the ones it couldn't start go to the owner like the ones the
   * turn went without; the ones it said nothing about are logged as unconfirmed, never as working.
   */
  #noteStartup(botId: string, mcp: ResolvedConnectors, startup: McpStartup[] | undefined, fields: LogFields) {
    if (!mcp.servers.length) return;
    const shown = new Map((startup ?? []).map((s) => [s.name, s]));
    const started = mcp.servers.filter((s) => shown.get(s.name)?.started).map((s) => s.name);
    const notStarted = mcp.servers.flatMap((s) => {
      const r = shown.get(s.name);
      return r && !r.started ? [{ name: s.name, reason: r.reason ?? 'it did not start' }] : [];
    });
    const unconfirmed = mcp.servers.filter((s) => !shown.has(s.name)).map((s) => s.name);
    const tools = Object.fromEntries(started.flatMap((name) => (shown.get(name)?.tools ? [[name, shown.get(name)!.tools!.length]] : [])));
    (notStarted.length ? log.warn : log.info)('connectors at the end of the turn', { ...fields, started, ...(Object.keys(tools).length ? { tools } : {}), notStarted, unconfirmed });
    try {
      if (startup?.length) this.connectors.recordStartup(botId, mcp.ids, startup);
    } catch (err) {
      // The Boton was deleted mid-turn.
      log.debug('could not record what the CLI showed of its connectors', { ...fields, err });
    }
  }

  #replyMeta(bot: BotRecord, started: number, turn: TurnInfo): MessageMeta {
    return { provider: bot.provider, model: turn.model, ...(turn.effort ? { effort: turn.effort } : {}), durationMs: Date.now() - started, ...this.#turnMeta(turn) };
  }

  #turnMeta(turn: TurnInfo): MessageMeta | null {
    if (!turn.id) return null;
    const u = turn.usage;
    const usage = u && totalTokens(u) > 0 ? tokenUsage(u) : null;
    return { turnId: turn.id, ...(usage ? { usage } : {}), ...(turn.steps ? { steps: turn.steps } : {}) };
  }

  #linkTurn(turn: TurnInfo, message: Message) {
    if (turn.id) this.store.linkTurnMessage(turn.id, message.id);
  }

  /** Leaves out of `mcp` each connector the owner has turned off since it was resolved, and returns those. */
  #leaveOutTurnedOff(mcp: ResolvedConnectors): { id: string; reason: string }[] {
    const off = Object.entries(mcp.ids).filter(([, id]) => this.connectors.isOff(id));
    for (const [name] of off) {
      mcp.servers = mcp.servers.filter((s) => s.name !== name);
      delete mcp.ids[name];
    }
    const skipped = off.map(([, id]) => ({ id, reason: OFF_REASON }));
    mcp.skipped.push(...skipped);
    return skipped;
  }

  async #invoke(
    bot: BotRecord,
    trigger: Trigger,
    body: string,
    turn: TurnInfo,
    job: Job,
    chat: { ids?: string[]; images?: string[]; askers?: string[]; chain?: Chain | null; reactable?: string[]; feedback?: Feedback[] } = {},
  ): Promise<TurnResult> {
    const r = trigger.kind === 'routine' ? trigger : null;
    const about = r ? { trigger: r.run.trigger, routineId: r.routine.id, runId: r.run.id } : { trigger: 'chat' as const, ...(chat.chain ? { threadId: chat.chain.threadId } : {}) };
    const { access, outside, sandboxed } = turnScope(bot, trigger);
    const session = r ? runSession(r.routine, r.run.trigger) : 'chat';
    const own = session === 'own' ? r!.routine : null;
    const fresh = session === 'fresh';
    const requestedModel = r?.routine.model || bot.model;
    turn.model = requestedModel;
    const requestedEffort = turnEffort(bot, r?.routine ?? null, this.store.effortCaps(bot.provider, requestedModel)).effort;
    turn.effort = requestedEffort;
    const limitMs = this.#limitFor(r?.routine ?? null);
    turn.limitMs = limitMs;
    const settings = this.store.getSettings();
    const provider = this.#providers.get(bot.provider);
    // No connectors with a payload from outside: their tools run without asking, so it could have the Boton read mail or post as the owner.
    // A token can't be swapped in mid-turn, so it must last the whole turn (or half its lifetime, if shorter).
    // A starter's test run: what it runs on, before and after waiting on its connectors (see StarterGate.noteTest).
    const gate = r?.run.trigger === 'test' && this.store.starterPending(r.routine.id) ? this.starterGate : undefined;
    const gateBefore = gate?.parts(bot, r!.routine);
    const mcp: ResolvedConnectors & { offForWebhook: boolean } = outside
      ? { servers: [], skipped: [], ids: {}, offForWebhook: bot.connections.length > 0 }
      : { ...(await this.connectors.resolve(bot.connections, provider, { forMs: limitMs + 60_000, launch: provider ? this.#connectorLaunch(bot, provider) : undefined })), offForWebhook: false };
    // Its launch files last from here to the end of the turn, however it ends (a setup step that throws included).
    try {
      // Resolving waits (an OAuth token, say), and the owner may turn one off meanwhile: left out here, in the same tick as
      // the context and notices below, so neither lists one this turn won't get. Checked again right before each CLI starts.
      this.#leaveOutTurnedOff(mcp);
      if (gate && gateBefore) {
        try {
          gate.noteTest(r!.run, gateBefore, gate.parts(bot, r!.routine));
        } catch (err) {
          // Not noted, so it can't count for turning the routine on; the run itself goes ahead.
          log.warn('could not note what a test run runs on', { botId: bot.id, routineId: r!.routine.id, runId: r!.run.id, err });
        }
      }
      // Connectors this turn gets that the last one went without (a CLI that couldn't start one, say): its notice says why.
      const given = new Set(Object.values(mcp.ids));
      const lastTurn = outside ? [] : this.connectors.notices(bot).flatMap((n) => (n.kind === 'skipped' && given.has(n.connectorId) ? [{ id: n.connectorId, reason: n.reason }] : []));
      // What it went without, and why, is the owner's to see in the Boton's settings: never only in the log.
      if (!outside) this.connectors.recordTurn(bot.id, mcp);
      const promptNow = () => {
        const givenNow = new Set(Object.values(mcp.ids));
        const recovering = lastTurn.filter((n) => givenNow.has(n.id));
        return `${this.#context(bot, trigger, settings, mcp, recovering, sandboxed, !!provider?.askFirst, chat)}\n\n${body}`;
      };
      let prompt = promptNow();
      const row = { botId: bot.id, trigger: about.trigger, routineId: r?.routine.id ?? null, runId: r?.run.id ?? null, provider: bot.provider, requestedModel };
      if (!provider) {
        log.error('turn not started: its provider is not on this server', { botId: bot.id, ...about, provider: bot.provider });
        turn.id = this.store.startTurn(row);
        this.store.finishTurn(turn.id, { outcome: 'error', durationMs: 0, replayedTranscript: false });
        throw new Error(`Provider "${bot.provider}" is not available on this server.`);
      }
      mkdirSync(bot.workspace, { recursive: true });

      const sys = systemPrompt(bot, settings, this.#cfg);
      const key = sessionKey(provider.id, sys);
      const saved = fresh ? { sessionId: null, sessionKey: null } : own ? this.store.routineSession(own.id) : { sessionId: bot.sessionId, sessionKey: bot.sessionKey };
      const existing = saved.sessionKey === key ? saved.sessionId : null;
      // The first chat-session turn on the provider a switch moved it to, whose new session starts with the note.
      // Pending when the turn read the Boton, not now: a switch since is not this turn's.
      const stamp = job.read!.stamp;
      const pendingHandoff = own || fresh ? null : job.read!.handoff;
      const handoff = pendingHandoff?.meta.handoff.to.provider === provider.id ? pendingHandoff : null;
      turn.id = this.store.startTurn(row);
      const started = Date.now();
      // Never the prompt or the reply: only what the turn was and how it went.
      const fields: LogFields = {
        botId: bot.id,
        ...about,
        turnId: turn.id,
        provider: provider.id,
        model: requestedModel || undefined,
        ...(requestedEffort ? { effort: requestedEffort } : {}),
        ...(own ? { routineSession: 'own' } : fresh ? { routineSession: 'fresh', webhookHistory: r!.routine.webhookHistory } : {}),
        ...(limitMs !== this.#cfg.turnTimeoutMs ? { timeLimitMs: limitMs } : {}),
      };
      if (mcp.skipped.length) log.info('connectors left out of the turn', { ...fields, skipped: mcp.skipped });
      if (mcp.offForWebhook) log.info('connectors left out of the turn: a webhook started it', { ...fields, connectors: bot.connections });
      if (saved.sessionId && !existing) log.info('session reset: the system prompt or provider changed, so the turn starts a new session', { ...fields, sessionId: saved.sessionId });

      const controller = new AbortController();
      job.turn = controller;
      // Stopped, paused or cancelled while its connectors were being set up: no agent process starts.
      if (job.aborted) controller.abort(job.aborted);
      const label = r ? `Running routine “${r.routine.name}”` : chat.askers?.length ? `Answering ${chat.askers.join(' and ')}` : undefined;
      this.#setStatus(bot.id, 'working', label ?? 'Thinking');
      const turnToken = this.auth.mintBotonToken(bot.id, { sandboxed });
      // Its managed browser, when the browser connector is among the servers it got: driven only with this turn's token.
      const browserTurn = !!this.browser && mcp.ids[BROWSER_SERVER] === BROWSER_CONNECTOR;
      if (browserTurn) this.browser!.beginTurn(bot.id, turnToken.id);
      const running = {
        bot,
        access,
        chain: chat.chain ?? null,
        connectors: Object.values(mcp.ids),
        origin: {
          trigger: about.trigger,
          turnId: turn.id,
          routineId: r?.routine.id ?? null,
          routineName: r?.routine.name ?? null,
          runId: r?.run.id ?? null,
          sandboxed,
          askedBy: chat.askers ?? [],
        },
      };
      this.#turns.set(bot.id, running);
      const sharedDirs = sandboxed ? [] : [this.#cfg.sharedDir];
      let replayed = false;
      // The time limit runs from the first agent process: waiting in the queue or on connectors doesn't count, and a retry
      // in a new session (the first found its session gone) gets what is left, not a limit of its own.
      let deadline: number | null = null;
      const drafts = this.#drafts(bot.id, turn.id, trigger.kind === 'routine' || (trigger.kind === 'chat' && !chat?.reactable?.length));
      const onStep = (s: TurnStep) => {
        try {
          this.store.addTurnStep(turn.id, turn.steps, s);
          turn.steps++;
        } catch (err) {
          // The Boton was deleted mid-turn, and its turns with it.
          log.debug('could not save a step', { ...fields, err });
        }
      };

      const attempt = (sessionId: string | null) => {
        // A retry in a new session after the turn's time ran out: it timed out, and no new agent process starts.
        if (deadline !== null && Date.now() >= deadline) {
          const err = new ProviderError(`${provider.label} timed out.`, false);
          err.exit = { exitCode: null, signal: null, timedOut: true, stderrTail: '' };
          return Promise.reject(err);
        }
        if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
        // Turned off since the prompt was built (a sandboxed turn waits on its instruction files first, a retry on the
        // first attempt): left out after all, and the prompt and notices say so. From here to the CLI starting nothing
        // waits, and from then on the turn is listed as having the rest: turning one off says it keeps it until it ends.
        const turnedOff = this.#leaveOutTurnedOff(mcp);
        if (turnedOff.length) {
          this.connectors.recordTurn(bot.id, { skipped: turnedOff, ids: {} });
          running.connectors = Object.values(mcp.ids);
          prompt = promptNow();
        }
        let input = prompt;
        replayed = false;
        // A webhook run's fresh session: the chat's latest messages the owner gave its routine, nothing more (no pins, no
        // routine results, no handoff), inside a budget of their own.
        if (fresh && r!.routine.webhookHistory > 0) {
          const src = this.store.replaySource(bot.id, bot.contextSince, []);
          const start = sessionStart({ chat: take(src.chat, Math.min(r!.routine.webhookHistory, WEBHOOK_HISTORY_MAX)), routines: [], pins: [], budget: WEBHOOK_HISTORY_BUDGET }, settings, bot.timezone);
          input = [start.text, prompt].filter(Boolean).join('\n\n');
          replayed = start.plan.messages > 0;
          log.info('webhook run: the chat it was given was sized to its budget', { ...fields, replay: start.plan });
        }
        // A routine's own session starts with its context and instruction only, not the chat.
        else if (!sessionId && !own && !fresh) {
          // The summary the old session wrote for the move goes in the note, so not in the replay as well.
          const summary = handoff?.meta.handoff.summary ? this.store.handoffSummary(bot.id, handoff.meta.handoff.summary.messageId) : null;
          const src = this.store.replaySource(bot.id, bot.contextSince, [...(chat.ids ?? []), ...(summary ? [summary.id] : [])]);
          const start = sessionStart({ handoff: handoff?.meta.handoff ?? null, summary, ...src }, settings, bot.timezone);
          input = [start.text, prompt].filter(Boolean).join('\n\n');
          replayed = start.plan.messages + start.plan.routines + start.plan.pinned > 0;
          // Sizes only, never the text: what the new session was given.
          log.info('new session: the replay was sized to its budget', { ...fields, replay: start.plan });
        }
        job.spawned = true;
        deadline ??= Date.now() + limitMs;
        const api = withLegacyTurnNames({ BOTONS_API: `http://127.0.0.1:${this.#cfg.port}`, BOTON_BOT_ID: bot.id, BOTON_TOKEN: turnToken.token });
        return provider.runTurn({
          cwd: bot.workspace,
          sessionId,
          systemPrompt: sys,
          prompt: input,
          model: requestedModel,
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          access,
          images: chat.images ?? [],
          privatePaths:
            access === 'workspace'
              ? privatePaths({
                  env: { ...process.env, ...cliHomesEnv() },
                  workspace: bot.workspace,
                  cli: provider.cli ?? null,
                  botonsHome: this.#cfg.home,
                  workspacesDir: this.#cfg.workspacesDir,
                  extra: this.#cfg.privatePaths,
                  shared: sharedDirs,
                })
              : [],
          sharedDirs,
          protectInstructions: sandboxed,
          groupDir: this.#cfg.agentsDir,
          env: withLegacyTurnNames({
            BOTONS_API: `http://127.0.0.1:${this.#cfg.port}`,
            BOTON_BOT_ID: bot.id,
            // The `botons` CLI runs on the server's own Node, which may not be on PATH (under systemd, say).
            BOTONS_NODE: process.execPath,
            BOTON_TOKEN: turnToken.token,
            // The only folder `botons skill --file` reads from (the CLI runs outside a Workspace Boton's sandbox).
            BOTON_WORKSPACE: bot.workspace,
            // server/bin/legacy: the command's deprecated names, for one release (shared/legacy-names.mjs).
          PATH: `${this.#cfg.botonBinDir}:${join(this.#cfg.botonBinDir, 'legacy')}:${process.env.PATH ?? ''}`,
          }),
          // The browser's server reaches the Botons API as this turn (Codex reads the token from its environment, never argv).
          mcpServers: mcp.servers.map((x) => (browserTurn && x.name === BROWSER_SERVER && x.kind === 'stdio' ? { ...x, env: { ...x.env, ...api } } : x)),
          privateDir: this.connectors.privateDir,
          // An API key brain's spending caps count this turn (its own row) and, for a routine, its run.
          spend: { botId: bot.id, turnId: turn.id, runId: r?.run.id ?? null, routineId: r?.routine.id ?? null },
          botonCli: join(this.#cfg.botonBinDir, 'botons'),
          // A sandboxed turn asks about the always-allowed rules too.
          ...(provider.askFirst && bot.askFirst.length
            ? { askFirst: { ...splitRules(bot.askFirst, bot.alwaysAllow, sandboxed), command: join(this.#cfg.botonBinDir, 'botons'), args: ['mcp'] } }
            : {}),
          signal: controller.signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
          onActivity: (a) => this.#setStatus(bot.id, 'working', label ? `${label}: ${a}` : a),
          onText: drafts.push,
          onStep,
          onToolResult: (obs) => {
            const connectorId = mcp.ids[obs.server];
            if (connectorId) this.workFeed?.observe(bot.id, connectorId, obs);
          },
        });
      };

      let sessionLost: true | undefined;
      // What the attempt that found its session gone used: the turn's row counts it with the retry's.
      let lostUsage: TurnUsage | null = null;
      const finish = (outcome: Exclude<TurnOutcome, 'running'>, used: TurnUsage | null, errorKind: string | null = null) => {
        const durationMs = Date.now() - started;
        const usage = addUsage(used, lostUsage);
        turn.usage = usage;
        turn.model = usage?.model ?? requestedModel;
        this.store.finishTurn(turn.id, { outcome, errorKind, durationMs, usage, model: usage?.model, replayedTranscript: replayed });
        return { durationMs, usage };
      };
      // Given to the CLI, not yet known to have started: #noteStartup logs what the CLI showed of them.
      log.info('turn started', { ...fields, session: existing ? 'resume' : 'new', ...(mcp.servers.length ? { connectorsGiven: mcp.servers.map((s) => s.name) } : {}) });
      let result: TurnResult;
      // A sandboxed turn must leave the instruction files later turns load as they were (see instructions.ts).
      const putBack = sandboxed
        ? await snapshotInstructions(bot.workspace).catch((err) => {
            log.warn('the instruction files could not be noted before a sandboxed turn, so they will not be put back after it (the CLI sandbox still keeps it from writing them)', { ...fields, err });
            return null;
          })
        : null;
      try {
        try {
          result = await attempt(existing);
        } catch (err) {
          // Only a session the provider says is gone, before the turn did anything: the retry runs the whole prompt again.
          if (!(existing && err instanceof ProviderError && err.sessionLost) || controller.signal.aborted) throw err;
          sessionLost = true;
          lostUsage = err.usage ?? null;
          log.warn('session lost: starting a new one', { ...fields, sessionId: existing, sessionLost });
          result = await attempt(null);
        } finally {
          turnToken.revoke();
          this.#turns.delete(bot.id);
          if (browserTurn) await this.browser!.endTurn(bot.id, turnToken.id).catch((err) => log.warn('the browser did not close cleanly', { ...fields, err }));
          drafts.end();
          if (putBack) await this.#putBackInstructions(bot, putBack, fields);
        }
      } catch (err) {
        if (err instanceof ProviderError) this.#noteStartup(bot.id, mcp, err.mcpStartup, fields);
        const signal = controller.signal;
        const outcome = timedOut(err) ? 'timeout' : signal.aborted ? (signal.reason === INTERRUPTED ? 'interrupted' : 'stopped') : 'error';
        const { durationMs, usage } = finish(outcome, err instanceof ProviderError ? (err.usage ?? null) : null, outcome === 'error' && err instanceof ProviderError ? err.kind : null);
        const exit = err instanceof ProviderError ? err.exit : undefined;
        const end: LogFields = { ...fields, ...usageFields(usage), outcome, durationMs, sessionLost, error: errorText(err) };
        if (exit) Object.assign(end, { exitCode: exit.exitCode, signal: exit.signal ?? undefined, timedOut: exit.timedOut, stderr: exit.stderrTail || undefined });
        if (outcome === 'stopped' || outcome === 'interrupted') log.info('turn ended', end);
        else {
          this.#providers.recordTurn(provider.id, { ok: false, error: errorText(err) });
          log.error('turn ended', end);
        }
        throw err;
      }
      this.#noteStartup(bot.id, mcp, result.mcpStartup, fields);
      const { durationMs, usage } = finish('ok', result.usage ?? null);
      this.#providers.recordTurn(provider.id, { ok: true });
      log.info('turn ended', { ...fields, outcome: 'ok', durationMs, sessionLost, ...usageFields(usage) });
      if (result.warnings?.length) {
        log.warn(`turn completed after ${result.warnings.length} ${provider.id} error(s)`, { ...fields, lastWarning: result.warnings.at(-1) });
      }
      // Started fresh during the turn (or deleted): keep the reset, drop this session.
      // Moved to another provider during the turn (or reset): the turn's reply stands, but its session is not kept, so
      // the next turn starts on the Boton's provider as the move said.
      // Moved away and back counts too (the generation): the move ended this session, whatever the provider is now.
      const at: TurnStamp = { ...stamp, provider: provider.id };
      // A fresh session ends with its run: nothing it was told carries on.
      const kept = fresh || this.store.atomically(() => {
        const saved = own ? this.store.setRoutineSession(own.id, result.sessionId, key, at) : this.store.setSession(bot.id, result.sessionId, key, at);
        // The new provider's chat session has its turn now (with the note, or carrying on one that was its own before).
        if (saved && handoff) this.store.endHandoff(handoff.id, at.generation);
        return saved;
      });
      if (!kept && this.store.hasBot(bot.id)) {
        const moved = this.#providerOf(bot.id) !== provider.id || this.store.switchGeneration(bot.id) !== at.generation;
        log.info(
          moved
            ? 'moved to another provider during the turn; not keeping its session'
            : own
              ? "the routine's session was reset or changed during the turn; not keeping it"
              : 'conversation was reset during the turn; not keeping its session',
          { ...fields, sessionId: result.sessionId },
        );
      }
      return result;
    } finally {
      this.connectors.release(mcp);
    }
  }

  async #putBackInstructions(bot: BotRecord, putBack: () => Promise<string[]>, fields: LogFields) {
    let undone: string[];
    try {
      undone = await putBack();
    } catch (err) {
      log.warn('could not check the instruction files after a sandboxed turn', { ...fields, err });
      return;
    }
    if (!undone.length) return;
    log.warn('a sandboxed turn changed instruction files; put them back', { ...fields, files: undone });
    if (!this.store.hasBot(bot.id)) return;
    const list = undone.join(', ');
    this.store.addMessage(bot.id, 'event', `Undid this webhook run's changes to ${list}: later turns would have followed ${undone.length > 1 ? 'them' : 'it'} as instructions`, {
      kind: 'instructions.restored',
    });
  }
}

/** The follow-up turn for a connector granted on request, from the server. */
function grantedPrompt(connectorId: string): string {
  const id = connectorId.replace(/[^a-z0-9:_-]/g, '');
  return `(From the Botons server: the connector ${id} you asked for was added to your connectors, so its tools are yours from this turn on. Carry on with what you needed it for, then say what you did.)`;
}

/** Runs started by hand (Run now, or a test): never retried, and run whether or not the routine is paused. */
const byHand = (run: Pick<RoutineRun, 'trigger'>) => run.trigger === 'manual' || run.trigger === 'test';

/** A one-off that has fired is disabled too, but retired, not paused: its run still gets its retries. */
function routinePaused(routine: Routine, run: RoutineRun): boolean {
  return !routine.enabled && !byHand(run) && !isPastOneOff(routine.schedule);
}

function isFinished(run: RoutineRun): boolean {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'skipped';
}

function goneRun(last: RoutineRun, reason: string): RoutineRun {
  if (isFinished(last)) return last;
  return { ...last, status: 'failed', error: reason, finishedAt: nowIso() };
}

function when(at: Date, tz: string): string {
  return at.toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function retryAfter(ms: number): { s: number; wait: string } {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return { s, wait: s < 120 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes` };
}

function runMeta(run: Job['run']) {
  return run ? { routineId: run.routineId, routineName: run.routineName, runId: run.runId } : {};
}

function isAttachableImage(a: FileRef): boolean {
  // Codex splits --image values on commas.
  return /^image\/(png|jpeg|gif|webp)$/.test(a.type) && !a.path.includes(',');
}

/** Checked again as the turn starts: the Boton may have replaced a file with a symlink leading outside (Codex's --image would read it). */
async function attachmentsNow(workspace: string, messages: Message[]): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (const a of messages.flatMap((m) => m.meta?.attachments ?? [])) {
    if (found.has(a.path)) continue;
    const at = await resolveInWorkspace(workspace, a.path).then(
      (r) => (r.stat.isFile() ? join(workspace, r.rel) : null),
      () => null,
    );
    found.set(a.path, at);
  }
  return found;
}

function withAttachments(m: Message, workspace: string, found: Map<string, string | null>, owner: string): string {
  const files = m.meta?.attachments ?? [];
  if (!files.length) return m.text;
  const note = attachmentNote(
    files.map((f) => {
      const at = found.get(f.path);
      return { ...f, path: at ?? join(workspace, f.path), missing: !at };
    }),
    owner,
  );
  return m.text ? `${m.text}\n\n${note}` : note;
}

/** The cost is known only if both attempts' are. */
function addUsage(u: TurnUsage | null, earlier: TurnUsage | null): TurnUsage | null {
  if (!earlier || totalTokens(earlier) === 0) return u ?? earlier;
  if (!u) return earlier;
  const sum: TurnUsage = {
    ...u,
    inputTokens: u.inputTokens + earlier.inputTokens,
    outputTokens: u.outputTokens + earlier.outputTokens,
    cacheReadTokens: u.cacheReadTokens + earlier.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens + earlier.cacheWriteTokens,
  };
  if (u.costUsd !== undefined && earlier.costUsd !== undefined) sum.costUsd = u.costUsd + earlier.costUsd;
  else delete sum.costUsd;
  if (u.costHeldUsd || earlier.costHeldUsd) sum.costHeldUsd = (u.costHeldUsd ?? 0) + (earlier.costHeldUsd ?? 0);
  if (earlier.numTurns !== undefined) sum.numTurns = (u.numTurns ?? 0) + earlier.numTurns;
  return sum;
}

function tokenUsage(u: TurnUsage): TokenUsage {
  const out: TokenUsage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
  if (u.costUsd !== undefined) out.costUsd = u.costUsd;
  if (u.costBasis) out.costBasis = u.costBasis;
  if (u.costHeldUsd) out.costHeldUsd = u.costHeldUsd;
  return out;
}

function usageFields(u: TurnUsage | null): LogFields {
  return u ? { modelRan: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens } : {};
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg;
}
