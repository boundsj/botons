import { execFileSync } from 'node:child_process';
import { currentName } from '../../shared/legacy-names.mjs';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  AccessLevel,
  AttentionRun,
  BackgroundActivity,
  BackgroundItem,
  Bot,
  CallbackDelivery,
  BotStatus,
  CreateBotInput,
  CreateRoutineInput,
  DuplicateBotInput,
  Memory,
  Message,
  MessageMeta,
  MessageReaction,
  MessageRole,
  BotonLook,
  NotifyDelivery,
  NotifyPolicy,
  ProviderHandoff,
  ReactionActor,
  Routine,
  RoutineRun,
  RoutineSession,
  RunMeta,
  RunsAttention,
  RunPayload,
  RunStatus,
  RunTrigger,
  ServerEvent,
  Settings,
  SidebarImportResult,
  SidebarLayout,
  SidebarTransfer,
  SidebarSectionKey,
  TeamMember,
  TokenUsage,
  TurnOutcome,
  TurnStep,
  TurnSteps,
  TurnTrigger,
  UpdateBotInput,
  UpdateRoutineInput,
  UpdateSettingsInput,
  WebhookFilter,
  WebhookSource,
  UsageReport,
  UsageRow,
} from '../../shared/types.ts';
import type { TranscriptCard } from '../../shared/cards.ts';
import type { BrowserHandoff } from '../../shared/handoff.ts';
import { lookFor, lookFromTater, parseLook, randomLook } from '../../shared/look.ts';
import { parseTater, taterFromCritter } from '../../shared/look-tater.ts';
import { critterFromLook24, isLook24, parseCritter } from '../../shared/look-critter.ts';
import { effortProblem, type ModelEfforts, providerEffort } from '../../shared/effort.ts';
import { INBOX_CLEANUP_CHOICES, INBOX_CLEANUP_DEFAULT_DAYS, INBOX_PINS_MAX } from '../../shared/files.ts';
import { DEFAULT_REACTION_FOLLOW_UPS, REACTION_FOLLOW_UP_MAX, reactionEmoji } from '../../shared/reactions.ts';
import { isAutomaticWake, mayBeQuiet, parseQuiet, routineLabel, TURN_ACTIVITY, wakeLabel } from '../../shared/wake.ts';
import { copyName, durationText, isPastOneOff, isValidTimezone, MIN_TIME_LIMIT_MS, totalTokens } from '../../shared/util.ts';
import { actingTurn } from './acting.ts';
import type { Config } from './config.ts';
import type { EventHub } from './events.ts';
import { askFirstList } from './ask-rules.ts';
import { log } from './log.ts';
import type { NtfyConfig } from './notify.ts';
import { backup } from './backup.ts';
import { PIN_LIMIT, REPLAY_PAGE, type Replayable, WEBHOOK_HISTORY_MAX } from './replay.ts';
import { CHAT_MESSAGE, MESSAGE_META, openSchema, PINNED_MESSAGE, RESET_EVENT, ROUTINE_MESSAGE, SCHEMA_VERSION, sidebarGroupKey } from './schema.ts';
import { describeSchedule, nextRun, parseSchedule, toSpec } from './schedule.ts';
import { newId, newSecret, nowIso, parseJson, type Row, strings, truncate } from './util.ts';
import { type HookSecrets, isWebhookSource, parseFilter, WEBHOOK_SOURCES } from './webhooks.ts';

export class HttpError extends Error {
  status: number;
  headers: Record<string, string> | undefined;
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const RUN_HISTORY = 20;
/** At most this many of each kind in the runs-needing-attention overview. */
const ATTENTION_LIMIT = 50;
export const TURN_RETENTION_MS = 90 * 86_400_000;
export const MAX_STEPS = 200;
export const MAX_STEP_DETAIL = 2000;
/**
 * At most this many results of one routine waiting to reach its callback URL. Each waits through its retries (about
 * three minutes); a routine finishing runs faster than its receiver answers gets the rest recorded as not sent, in
 * Runs to check, rather than an ever-growing backlog. Pending rows are kept apart from RUN_HISTORY too.
 */
export const PENDING_CALLBACK_LIMIT = 20;
/** Kept apart from RUN_HISTORY so skipped slots can't push real runs out. */
const SKIP_HISTORY = 10;
export const MAX_ROUTINES_PER_BOT = 50;
/** The Boton as a turn read it: a session it starts or carries on is kept only while the Boton is still so. */
export interface TurnStamp {
  contextSince: string | null;
  provider: string;
  generation: number;
}
/** The latest provider switch of the Boton `bot` (a bound parameter by default): see Store.switchGeneration. */
const generationSql = (bot = '?') =>
  `coalesce((select g.seq from messages g where g.bot_id = ${bot} and g.role = 'event' and json_extract(case when json_valid(g.meta) then g.meta end, '$.kind') = 'provider.switched' order by g.seq desc limit 1), 0)`;
const GENERATION_SQL = generationSql();
/** Each repeats the condition of its partial index (schema.ts) word for word, so SQLite reads that index. */
const PINNED_SQL = PINNED_MESSAGE;
const NOT_STALE_SQL = `coalesce(json_extract(${MESSAGE_META}, '$.staleContext'), 0) = 0`;
export const NOTIFY_POLICIES: NotifyPolicy[] = ['auto', 'always', 'failures', 'never'];
const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

/** `fallback` when it is left out. */
export function flag(v: unknown, field: string, fallback?: boolean): boolean {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return v;
}

/** The owner's follow-up reactions: emoji only, each once, at most REACTION_FOLLOW_UP_MAX. */
export function followUpsInput(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'reactionFollowUps must be a list of emoji ([] for none)');
  const out: string[] = [];
  for (const x of v) {
    const e = reactionEmoji(x);
    if (!e) throw new HttpError(400, `reactionFollowUps: ${JSON.stringify(String(x)).slice(0, 40)} is not one emoji`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > REACTION_FOLLOW_UP_MAX) throw new HttpError(400, `reactionFollowUps: at most ${REACTION_FOLLOW_UP_MAX} emoji`);
  return out;
}

function webhookHistory(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > WEBHOOK_HISTORY_MAX) {
    throw new HttpError(400, `webhookHistory must be a whole number of messages from 0 to ${WEBHOOK_HISTORY_MAX}`);
  }
  return v;
}

function routineSession(v: unknown): RoutineSession {
  if (v !== 'chat' && v !== 'own') throw new HttpError(400, 'session must be "chat" or "own"');
  return v;
}

/** A routine's own time limit, in ms: null keeps the server's; never longer than the server's (BOTONS_TURN_TIMEOUT_MS). */
function timeLimitMs(v: unknown, max: number): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, 'timeLimitMs must be a whole number of milliseconds, or null for the server\'s limit');
  if (v < MIN_TIME_LIMIT_MS || v > max) {
    throw new HttpError(400, `timeLimitMs must be between ${durationText(MIN_TIME_LIMIT_MS)} and ${durationText(max)} (the server's limit, BOTONS_TURN_TIMEOUT_MS); got ${v}`);
  }
  return v;
}

function routineModel(v: unknown): string | null {
  if (v === null) return null;
  return clean(v, 'model', 120) || null;
}

/**
 * A Boton's effort for `provider` and its model: "" is the provider's default; a level the provider doesn't have, or
 * one the model's own list (`known`) leaves out, is refused with the ones it has.
 */
function botEffort(v: unknown, provider: string, known: ModelEfforts | null): string {
  if (typeof v !== 'string') throw new HttpError(400, 'effort must be a level name, or "" for the provider\'s default');
  const effort = v.trim();
  const problem = effortProblem(provider, effort, known);
  if (problem) throw new HttpError(400, problem);
  return effort;
}

/** A routine's own effort, checked like a Boton's against the model its runs use: null (or "") is the Boton's. */
function routineEffort(v: unknown, provider: string, known: ModelEfforts | null): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'effort must be a level name, or null for the Boton\'s effort');
  const effort = v.trim();
  if (!effort) return null;
  const problem = effortProblem(provider, effort, known);
  if (problem) throw new HttpError(400, problem.replace(/, or "" for its default.*$/, ', or leave it out for the Boton\'s effort'));
  return effort;
}

/**
 * Why a routine with its own model can't take its Boton's effort: the model's own list leaves that level out. null
 * when it can, or when nothing is known about the model (the CLI is then asked for the level as it is).
 */
export function inheritedEffortProblem(provider: string, botonEffort: string, known: ModelEfforts | null): string | null {
  if (!botonEffort || !known || known.levels.includes(botonEffort)) return null;
  const name = providerEffort(provider)?.name ?? provider;
  const usable = (providerEffort(provider)?.levels ?? []).filter((l) => known.levels.includes(l.id)).map((l) => l.id);
  return `${name}'s model list has no effort level "${botonEffort}" (the Boton's) for ${known.model}: give the routine its own effort, one of ${usable.join(', ')}`;
}

function notifyPolicy(v: unknown): NotifyPolicy {
  if (!NOTIFY_POLICIES.includes(v as NotifyPolicy)) throw new HttpError(400, `notify must be one of ${NOTIFY_POLICIES.map((p) => `"${p}"`).join(', ')}`);
  return v as NotifyPolicy;
}

/** What an ntfy token is bound to: the server's origin ("" for none or one that isn't a URL). */
export function ntfyOrigin(server: string): string {
  try {
    return server ? new URL(server).origin : '';
  } catch {
    return '';
  }
}

type StoredNtfy = { enabled: boolean; server: string; topic: string; token: string | null; preview: boolean };
const NTFY_DEFAULTS: StoredNtfy = { enabled: false, server: '', topic: '', token: null, preview: false };

type HeldFor = 'retry' | 'usage_limit';

export interface RunRecord extends RoutineRun {
  payload: string | null;
}

const PAYLOAD_PREVIEW_BYTES = 2048;
const DELIVERY_TTL_MS = 24 * 3_600_000;

/** Not the payload, which can be a megabyte and goes out with every run.upserted: only its start and size. */
const RUN_COLUMNS = `seq, id, routine_id, bot_id, trigger, status, error, reply, quiet, meta, started_at, finished_at, attempts, last_error, retry_at, held_for, headers,
  substr(payload, 1, ${PAYLOAD_PREVIEW_BYTES}) as payload_preview, coalesce(length(cast(payload as blob)), 0) as payload_bytes`;

function utf8Prefix(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  // Back up to the start of a character (continuation bytes are 10xxxxxx).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

interface TurnStart {
  botId: string;
  trigger: TurnTrigger;
  routineId?: string | null;
  runId?: string | null;
  provider: string;
  requestedModel: string;
}

interface TurnEnd {
  outcome: Exclude<TurnOutcome, 'running'>;
  errorKind?: string | null;
  durationMs: number;
  usage?: (TokenUsage & { numTurns?: number }) | null;
  model?: string | null;
  replayedTranscript: boolean;
}

/** A test run of a starter's routine, with what it ran on (starter-gate.ts); `parts` null: it changed during the run. */
export interface StarterTestRecord {
  runId: string;
  routineId: string;
  at: string;
  parts: Record<string, string> | null;
}

/** What the server keeps for a Boton installed from a starter (starterKey in settings). */
export interface StarterRecord {
  templateId: string;
  templateName: string;
  version: number;
  slots: Record<string, string | null>;
  installedAt: string;
  pending: string[];
  tests: StarterTestRecord[];
}

export const starterKey = (botId: string) => `starter:${botId}`;

export interface BotRecord extends Bot {
  sessionId: string | null;
  sessionKey: string | null;
  contextSince: string | null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'boton';

/** A Boton row with its sidebar group's name. */
const BOT_SELECT = 'select b.*, g.name as group_name from bots b left join sidebar_groups g on g.id = b.group_id';

const SIDEBAR_GROUP_NAME_MAX = 40;
const SIDEBAR_GROUPS_MAX = 100;
const SIDEBAR_COLLAPSED: Record<SidebarSectionKey, string> = { pinned: 'sidebarPinnedCollapsed', ungrouped: 'sidebarUngroupedCollapsed' };

/** A place in a list of `length` (once the item is in it): missing or past the end is last. */
function sidebarIndex(v: unknown, length: number): number {
  if (v === undefined || v === null) return length;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new HttpError(400, 'index must be a whole number, 0 or more');
  return Math.min(v, length);
}

const SIDEBAR_FORMAT = 'botons-sidebar';
const SIDEBAR_IDS_MAX = 10_000;

/** A layout file checked whole (see SidebarTransfer), or a 400 saying what is wrong with it. */
export function sidebarTransfer(v: unknown): SidebarTransfer {
  const bad = (why: string): never => {
    throw new HttpError(400, `Not a sidebar layout this server can import: ${why}`);
  };
  const object = (x: unknown, what: string): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : bad(`${what} must be an object`));
  const f = object(v, 'the file');
  // A layout exported under the format's deprecated name reads the same (shared/legacy-names.mjs).
  if (currentName(String(f.format)) !== SIDEBAR_FORMAT) bad(`format must be "${SIDEBAR_FORMAT}"`);
  if (f.version !== 1) bad('version must be 1');
  const ids = (x: unknown, what: string): string[] => {
    if (!Array.isArray(x)) return bad(`${what}.botIds must be a list`);
    if (x.length > SIDEBAR_IDS_MAX) bad(`${what}.botIds has more than ${SIDEBAR_IDS_MAX} Botons`);
    for (const id of x) if (typeof id !== 'string' || !id || id.length > 100) bad(`${what}.botIds must be Boton ids`);
    return x as string[];
  };
  const section = (x: unknown, what: string) => {
    const o = object(x, what);
    if (typeof o.collapsed !== 'boolean') bad(`${what}.collapsed must be true or false`);
    return { collapsed: o.collapsed as boolean, botIds: ids(o.botIds, what) };
  };
  if (!Array.isArray(f.groups)) bad('groups must be a list');
  const list = f.groups as unknown[];
  if (list.length > SIDEBAR_GROUPS_MAX) bad(`it has more than ${SIDEBAR_GROUPS_MAX} groups`);
  const names = new Set<string>();
  const groups = list.map((g, i) => {
    const what = `groups[${i}]`;
    const name = (() => {
      try {
        return clean(object(g, what).name, `${what}.name`, SIDEBAR_GROUP_NAME_MAX, true);
      } catch (e) {
        return bad((e as Error).message);
      }
    })();
    if (names.has(sidebarGroupKey(name))) bad(`two groups are called ${name}`);
    names.add(sidebarGroupKey(name));
    return { name, ...section(g, what) };
  });
  const pinned = section(f.pinned, 'pinned');
  const ungrouped = section(f.ungrouped, 'ungrouped');
  const seen = new Set<string>();
  for (const id of [...groups.flatMap((g) => g.botIds), ...ungrouped.botIds]) {
    if (seen.has(id)) bad(`${id} is in more than one place`);
    seen.add(id);
  }
  if (new Set(pinned.botIds).size !== pinned.botIds.length) bad('a Boton is pinned twice');
  return { format: SIDEBAR_FORMAT, version: 1, pinned, groups, ungrouped };
}

export function clean(s: unknown, field: string, max: number, required = false): string {
  if (s === undefined || s === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof s !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = s.trim();
  if (required && !t) throw new HttpError(400, `${field} is required`);
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}

/** The data folder and the database hold every chat and the webhook keys: they are the user's alone. */
function secureDataFiles(cfg: Config) {
  try {
    chmodSync(cfg.home, 0o700);
    for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  } catch (err) {
    log.warn(`could not make ${cfg.home} private (mode 0700, database 0600): ${(err as Error).message}`);
  }
}

export class Store {
  db: DatabaseSync;
  #hub: EventHub;
  #cfg: Config;
  #statusOf: (botId: string) => BotStatus;
  #tx: { events: (ServerEvent | (() => void))[]; dirs: string[] } | null = null;
  /** What a provider's own model list says a model takes (ProviderRegistry.modelEfforts); the app sets it. */
  effortCaps: (provider: string, model: string) => ModelEfforts | null = () => null;

  constructor(cfg: Config, hub: EventHub, statusOf: (botId: string) => BotStatus) {
    this.#cfg = cfg;
    this.#hub = hub;
    this.#statusOf = statusOf;
    this.db = new DatabaseSync(cfg.dbPath);
    try {
      this.db.exec('pragma busy_timeout = 5000; pragma journal_mode = wal; pragma foreign_keys = on;');
      // A full backup before any upgrade in place: going back is the old release and this backup.
      openSchema(this.db, {
        beforeUpgrade: (version) => {
          const done = backup({ home: cfg.home });
          // Going back needs the workspaces too: a backup of the database alone is no way back, so no upgrade.
          if (done.manifest.workspacesError) throw new Error(`the workspaces were not backed up (${done.manifest.workspacesError}); the database alone is in ${done.dir}`);
          log.info('backed up the database before upgrading its schema', { from: version, to: SCHEMA_VERSION, backup: done.dir, workspaces: done.manifest.workspaces, ...(done.manifest.tarWarning ? { tarWarning: done.manifest.tarWarning } : {}) });
        },
      });
      secureDataFiles(cfg);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  #all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  #get(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  #run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }

  #publish(event: ServerEvent): void {
    if (this.#tx) this.#tx.events.push(event);
    else this.#hub.publish(event);
  }

  /**
   * One transaction: its events, and what afterCommit() was given, go out after the commit, in order; a rollback
   * drops them and removes the workspace folders it made. Every component publishes through here (publish()), so
   * nothing a rolled-back transaction did is ever seen.
   */
  atomically<T>(fn: () => T): T {
    if (this.#tx) return fn();
    const tx: { events: (ServerEvent | (() => void))[]; dirs: string[] } = { events: [], dirs: [] };
    this.db.exec('begin immediate');
    this.#tx = tx;
    let out: T;
    try {
      out = fn();
      this.db.exec('commit');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('rollback');
      for (const dir of tx.dirs) rmSync(dir, { recursive: true, force: true });
      throw err;
    } finally {
      this.#tx = null;
    }
    for (const event of tx.events) {
      if (typeof event !== 'function') this.#hub.publish(event);
      else {
        try {
          event();
        } catch (err) {
          log.error('a step after a commit failed', { err });
        }
      }
    }
    return out;
  }

  /** `fn` once the transaction it is in commits (at once outside one); never if it rolls back. For in-memory effects. */
  afterCommit(fn: () => void): void {
    if (this.#tx) this.#tx.events.push(fn);
    else fn();
  }

  #makeWorkspace(name: string): void {
    const dir = join(this.#cfg.workspacesDir, name);
    const existed = existsSync(dir);
    mkdirSync(dir, { recursive: true });
    if (!existed) this.#tx?.dirs.push(dir);
  }

  // ---------------------------------------------------------------- settings

  getSettings(): Settings {
    const rows = this.#all('select key, value from settings');
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const { token, ...ntfy } = this.#storedNtfy();
    const primary = map.primaryBotId && this.hasBot(map.primaryBotId) ? (map.primaryBotId as string) : null;
    return {
      ownerName: map.ownerName ?? defaultOwner(),
      timezone: map.timezone ?? this.#cfg.defaultTimezone,
      primaryBotId: primary,
      // Never the token: it is write-only.
      ntfy: { ...ntfy, hasToken: !!token },
      paused: map.paused === '1',
      reactionFollowUps: map.reactionFollowUps === undefined ? [...DEFAULT_REACTION_FOLLOW_UPS] : parseJson<string[]>(map.reactionFollowUps, []),
      inboxCleanupDays: map.inboxCleanupDays === undefined ? INBOX_CLEANUP_DEFAULT_DAYS : map.inboxCleanupDays === 'off' ? null : Number(map.inboxCleanupDays) || INBOX_CLEANUP_DEFAULT_DAYS,
    };
  }

  // The inbox files the owner keeps (trash.ts): names directly in the Boton's inbox. Never set by a Boton.
  inboxPins(botId: string): string[] {
    return parseJson<string[]>(this.#get('select value from settings where key = ?', `inboxPins:${botId}`)?.value, []);
  }

  /** Every pin is kept: a new one past INBOX_PINS_MAX is refused, never made room for. */
  setInboxPin(botId: string, name: string, pinned: boolean): void {
    const was = this.inboxPins(botId);
    if (pinned && was.includes(name)) return;
    const now = was.filter((n) => n !== name);
    if (pinned) {
      if (now.length >= INBOX_PINS_MAX) throw new HttpError(409, `At most ${INBOX_PINS_MAX} files can be kept in one inbox; stop keeping some first`);
      now.push(name);
    }
    this.#writeInboxPins(botId, now);
  }

  /** Pins only for names still in the inbox (`present`): one a Boton deleted or renamed is no longer kept. */
  pruneInboxPins(botId: string, present: Set<string>): void {
    const was = this.inboxPins(botId);
    const now = was.filter((n) => present.has(n));
    if (now.length !== was.length) this.#writeInboxPins(botId, now);
  }

  #writeInboxPins(botId: string, names: string[]) {
    if (names.length) this.#setSetting(`inboxPins:${botId}`, JSON.stringify(names));
    else this.#run('delete from settings where key = ?', `inboxPins:${botId}`);
  }

  /** The storage cleanup's own bookkeeping (when it last ran). */
  storageState(key: string): string | null {
    return (this.#get('select value from settings where key = ?', key)?.value as string | undefined) ?? null;
  }

  setStorageState(key: string, value: string): void {
    this.#setSetting(key, value);
  }

  #storedNtfy(): StoredNtfy {
    const raw = this.#get("select value from settings where key = 'ntfy'")?.value;
    return { ...NTFY_DEFAULTS, ...parseJson<Partial<StoredNtfy>>(raw, {}) };
  }

  #setSetting(key: string, value: string) {
    this.#run('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value', key, value);
  }

  ntfyConfig(): NtfyConfig | null {
    const n = this.#storedNtfy();
    return n.server && n.topic ? n : null;
  }

  updateSettings(patch: UpdateSettingsInput): Settings {
    // Check everything before saving anything.
    if ((patch as { paused?: unknown }).paused !== undefined) throw new HttpError(400, 'Pause or resume every Boton with POST /api/pause or POST /api/resume');
    const ownerName = patch.ownerName !== undefined ? clean(patch.ownerName, 'ownerName', 80, true) : undefined;
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) throw new HttpError(400, `Unknown timezone ${patch.timezone}`);
    const ntfy = patch.ntfy !== undefined ? this.#nextNtfy(patch.ntfy) : undefined;
    const primary = patch.primaryBotId !== undefined ? this.#primaryInput(patch.primaryBotId) : undefined;
    const followUps = patch.reactionFollowUps !== undefined ? followUpsInput(patch.reactionFollowUps) : undefined;
    const cleanup = patch.inboxCleanupDays;
    if (cleanup !== undefined && cleanup !== null && !INBOX_CLEANUP_CHOICES.includes(cleanup as number)) {
      throw new HttpError(400, `inboxCleanupDays must be one of ${INBOX_CLEANUP_CHOICES.join(', ')}, or null for off`);
    }
    if (ownerName !== undefined) this.#setSetting('ownerName', ownerName);
    if (primary === null) this.#run("delete from settings where key = 'primaryBotId'");
    else if (primary !== undefined) this.#setSetting('primaryBotId', primary);
    if (patch.timezone !== undefined) this.#setSetting('timezone', patch.timezone);
    if (ntfy) this.#setSetting('ntfy', JSON.stringify(ntfy));
    if (followUps) this.#setSetting('reactionFollowUps', JSON.stringify(followUps));
    if (cleanup !== undefined) this.#setSetting('inboxCleanupDays', cleanup === null ? 'off' : String(cleanup));
    const settings = this.getSettings();
    this.#publish({ type: 'settings.updated', settings });
    return settings;
  }

  #primaryInput(v: unknown): string | null {
    if (v === null || v === '') return null;
    if (typeof v !== 'string') throw new HttpError(400, 'primaryBotId must be a Boton id or null');
    if (!this.hasBot(v)) throw new HttpError(400, `No Boton with id ${v}`);
    return v;
  }

  #nextNtfy(input: unknown): StoredNtfy {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new HttpError(400, 'ntfy must be an object');
    const p = input as NonNullable<UpdateSettingsInput['ntfy']>;
    const next = this.#storedNtfy();
    next.enabled = flag(p.enabled, 'ntfy.enabled', next.enabled);
    next.preview = flag(p.preview, 'ntfy.preview', next.preview);
    if (p.server !== undefined) {
      const server = clean(p.server, 'ntfy.server', 500).replace(/\/+$/, '');
      if (server) {
        let url: URL;
        try {
          url = new URL(server);
        } catch {
          throw new HttpError(400, 'ntfy.server must be a URL such as https://ntfy.sh');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'ntfy.server must be an http:// or https:// URL');
        if (url.username || url.password || url.search || url.hash) throw new HttpError(400, 'ntfy.server must be a plain URL (put an access token in ntfy.token)');
      }
      next.server = server;
    }
    if (p.topic !== undefined) {
      const topic = clean(p.topic, 'ntfy.topic', 64);
      if (topic && !NTFY_TOPIC.test(topic)) throw new HttpError(400, 'ntfy.topic may use only letters, digits, - and _ (at most 64)');
      next.topic = topic;
    }
    // The token is the credential of one ntfy server: a different server (scheme, host or port) never gets it.
    // Without a token of its own in the same change, the saved one is removed.
    if (p.token === undefined && next.token && ntfyOrigin(next.server) !== ntfyOrigin(this.#storedNtfy().server)) next.token = null;
    if (p.token !== undefined) {
      if (p.token === null || p.token === '') next.token = null;
      else if (typeof p.token !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(p.token.trim())) throw new HttpError(400, 'ntfy.token must be a token such as tk_…');
      else next.token = p.token.trim();
    }
    if (next.enabled && (!next.server || !next.topic)) throw new HttpError(400, 'Set the ntfy server and topic before turning push notifications on');
    return next;
  }

  setPausedAll(paused: boolean): Settings {
    const changed = this.getSettings().paused !== paused;
    this.#setSetting('paused', paused ? '1' : '0');
    const settings = this.getSettings();
    if (changed) this.#publish({ type: 'settings.updated', settings });
    return settings;
  }

  pausedReason(botId: string): string | null {
    const r = this.#get("select b.paused, b.name, (select value from settings where key = 'paused') as all_paused from bots b where b.id = ?", botId);
    if (!r) return null;
    if (r.all_paused === '1') return 'All Botons are paused';
    if (r.paused) return `${r.name} is paused`;
    return null;
  }

  // -------------------------------------------------------------------- bots

  #toBot(r: Row): BotRecord {
    const last = this.#get(
      // A wake-up whose turn ended [quiet] isn't in the transcript, so it isn't the chat's latest line either.
      `select role, text, created_at, json_extract(${MESSAGE_META}, '$.fromBotName') as from_name from messages where bot_id = ? and role != 'event'
         and coalesce(json_extract(${MESSAGE_META}, '$.quiet'), 0) = 0 order by seq desc limit 1`,
      r.id,
    );
    const unread = this.#get("select count(*) as n from messages where bot_id = ? and seq > ? and role in ('bot', 'error')", r.id, r.read_seq)!;
    return {
      id: r.id,
      name: r.name,
      title: r.title,
      instructions: r.instructions,
      look: lookFor(parseJson<unknown>(r.look, null), r.id),
      provider: r.provider,
      model: r.model,
      effort: r.effort ?? '',
      access: r.access as AccessLevel,
      groupId: r.group_id ?? null,
      group: r.group_name ?? '',
      pinned: !!r.pinned,
      timezone: r.timezone,
      // Stored relative to the workspaces folder (absolute values resolve as they are).
      workspace: resolve(this.#cfg.workspacesDir, r.workspace),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessage: last
        ? { role: last.role as MessageRole, text: last.text.slice(0, 200), createdAt: last.created_at, ...(last.from_name ? { from: String(last.from_name) } : {}) }
        : null,
      unread: Number(unread.n),
      status: this.#statusOf(r.id),
      paused: !!r.paused,
      connections: parseList(r.connections),
      skills: r.skills === null ? null : parseList(r.skills),
      alwaysAllow: parseList(r.always_allow),
      askFirst: parseList(r.ask_first),
      sessionId: r.session_id ?? null,
      sessionKey: r.session_key ?? null,
      contextSince: r.context_since ?? null,
    };
  }

  publicBot(b: BotRecord): Bot {
    const { sessionId: _s, sessionKey: _k, contextSince: _c, ...bot } = b;
    return bot;
  }

  listBots(): Bot[] {
    return this.#all(`${BOT_SELECT} order by b.last_activity_at desc`).map((r) => this.publicBot(this.#toBot(r)));
  }

  getBot(id: string): BotRecord {
    const r = this.#get(`${BOT_SELECT} where b.id = ?`, id);
    if (!r) throw new HttpError(404, `No Boton with id ${id}`);
    return this.#toBot(r);
  }

  hasBot(id: string): boolean {
    return !!this.#get('select 1 from bots where id = ?', id);
  }

  #validateBotFields(input: UpdateBotInput, providers: Set<string>) {
    if (input.access !== undefined && input.access !== 'workspace' && input.access !== 'host') {
      throw new HttpError(400, 'access must be "workspace" or "host"');
    }
    if (input.provider !== undefined && !providers.has(input.provider)) {
      throw new HttpError(400, `Unknown provider ${input.provider}`);
    }
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      throw new HttpError(400, `Unknown timezone ${input.timezone}`);
    }
    if (input.look !== undefined) lookInput(input.look, '');
    if (input.connections !== undefined && (!Array.isArray(input.connections) || !input.connections.every((c) => typeof c === 'string'))) {
      throw new HttpError(400, 'connections must be a list of connector ids');
    }
    if (input.skills !== undefined && input.skills !== null && (!Array.isArray(input.skills) || !input.skills.every((c) => typeof c === 'string'))) {
      throw new HttpError(400, 'skills must be a list of skill names, or null for every skill');
    }
    if (input.alwaysAllow !== undefined) alwaysAllowList(input.alwaysAllow);
    if (input.askFirst !== undefined) askFirstList(input.askFirst);
  }

  createBot(input: CreateBotInput, providers: Set<string>, defaultProvider: string): Bot {
    this.#validateBotFields(input, providers);
    const id = newId('bot');
    const name = clean(input.name, 'name', 60, true);
    const now = nowIso();
    const workspace = `${slug(name)}-${id.slice(4)}`;
    const provider = input.provider ?? defaultProvider;
    const model = clean(input.model, 'model', 120);
    const row = [
      id,
      name,
      clean(input.title, 'title', 80),
      clean(input.instructions, 'instructions', 20_000),
      JSON.stringify(input.look !== undefined ? lookInput(input.look, id) : randomLook()),
      provider,
      model,
      input.effort === undefined ? '' : botEffort(input.effort, provider, this.effortCaps(provider, model)),
      input.access ?? 'workspace',
      input.pinned ? 1 : 0,
      input.timezone ?? this.getSettings().timezone,
      workspace,
      JSON.stringify(input.connections ?? []),
      input.skills ? JSON.stringify(input.skills) : null,
      now,
      now,
      now,
    ];
    return this.atomically(() => {
      const groupId = this.#groupInput(input) ?? null;
      this.#makeWorkspace(workspace);
      this.#run(
        `insert into bots (id, name, title, instructions, look, provider, model, effort, access, pinned, timezone, workspace, connections, skills, created_at, updated_at, last_activity_at, group_id, position, pin_position)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...row,
        groupId,
        this.#nextPosition(groupId),
        input.pinned ? this.#nextPinPosition() : 0,
      );
      this.#publishSidebar();
      return this.emitBot(id);
    });
  }

  updateBot(id: string, input: UpdateBotInput, providers: Set<string>): Bot {
    const current = this.getBot(id);
    this.#validateBotFields(input, providers);
    const provider = input.provider ?? current.provider;
    const model = input.model !== undefined ? clean(input.model, 'model', 120) : current.model;
    const known = this.effortCaps(provider, model);
    // A level the new provider or model doesn't have goes back to the default, unless this update sets one (the engine
    // says so in the chat); a level it has stays.
    const moved = provider !== current.provider || model !== current.model;
    const effort =
      input.effort !== undefined ? botEffort(input.effort, provider, known) : moved && effortProblem(provider, current.effort, known) ? '' : undefined;
    const sets: string[] = [];
    const vals: any[] = [];
    const set = (col: string, v: any) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (input.name !== undefined) set('name', clean(input.name, 'name', 60, true));
    if (input.title !== undefined) set('title', clean(input.title, 'title', 80));
    if (input.instructions !== undefined) set('instructions', clean(input.instructions, 'instructions', 20_000));
    if (input.look !== undefined) set('look', JSON.stringify(lookInput(input.look, id)));
    if (input.provider !== undefined) set('provider', input.provider);
    if (input.model !== undefined) set('model', model);
    if (effort !== undefined) set('effort', effort);
    if (input.access !== undefined) set('access', input.access);
    if (input.pinned !== undefined) flag(input.pinned, 'pinned');
    if (input.timezone !== undefined) set('timezone', input.timezone);
    if (input.connections !== undefined) set('connections', JSON.stringify(input.connections));
    if (input.skills !== undefined) set('skills', input.skills === null ? null : JSON.stringify(input.skills));
    if (input.alwaysAllow !== undefined) set('always_allow', JSON.stringify(alwaysAllowList(input.alwaysAllow)));
    if (input.askFirst !== undefined) set('ask_first', JSON.stringify(askFirstList(input.askFirst)));
    return this.atomically(() => {
      // Its place in the sidebar: a new group or a pin goes last there; the same one keeps its place.
      const groupId = this.#groupInput(input);
      let moved = false;
      if (groupId !== undefined && groupId !== current.groupId) {
        set('group_id', groupId);
        set('position', this.#nextPosition(groupId));
        moved = true;
      }
      if (input.pinned !== undefined && input.pinned !== current.pinned) {
        set('pinned', input.pinned ? 1 : 0);
        set('pin_position', input.pinned ? this.#nextPinPosition() : 0);
        moved = true;
      }
      if (sets.length) {
        set('updated_at', nowIso());
        this.#run(`update bots set ${sets.join(', ')} where id = ?`, ...vals, id);
      }
      if (moved) this.#publishSidebar();
      return this.emitBot(id);
    });
  }

  duplicateBot(id: string, input: DuplicateBotInput): Bot {
    const src = this.getBot(id);
    const withRoutines = flag(input.withRoutines, 'withRoutines', true);
    const withMemories = flag(input.withMemories, 'withMemories', false);
    const given = input.name === undefined || input.name === null ? '' : clean(input.name, 'name', 60);
    const name = given || copyName(src.name, new Set(this.#all('select name from bots').map((r) => String(r.name).toLowerCase())));
    const routines = withRoutines ? this.#all('select * from routines where bot_id = ? order by created_at, id', id) : [];
    const memories = withMemories ? this.#all('select * from memories where bot_id = ? order by created_at, id', id) : [];
    const newBotId = newId('bot');
    const workspace = `${slug(name)}-${newBotId.slice(4)}`;
    const now = nowIso();
    const routineIds: string[] = [];
    const copiedIds = new Map<string, string>();
    const memoryIds: string[] = [];
    const bot = this.atomically(() => {
      this.#makeWorkspace(workspace);
      this.#run(
        `insert into bots (id, name, title, instructions, look, provider, model, effort, access, group_id, position, pinned, timezone, workspace, connections, skills, ask_first, created_at, updated_at, last_activity_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newBotId,
        name,
        src.title,
        src.instructions,
        JSON.stringify(src.look),
        src.provider,
        src.model,
        src.effort,
        src.access,
        src.groupId,
        this.#nextPosition(src.groupId),
        src.timezone,
        workspace,
        JSON.stringify(src.connections),
        src.skills === null ? null : JSON.stringify(src.skills),
        // Not always_allow: what it may do without asking stays with the original.
        JSON.stringify(src.askFirst),
        now,
        now,
        now,
      );
      for (const r of routines) {
        const row: Row = {
          ...r,
          id: newId('rt'),
          bot_id: newBotId,
          enabled: 0,
          next_run_at: null,
          last_run_at: null,
          last_status: null,
          session_id: null,
          session_key: null,
          created_at: now,
          updated_at: now,
        };
        row.webhook_key = r.webhook_key ? newSecret() : null;
        // Otherwise the copy's results would reach the original's receiver, signed with another key.
        row.webhook_secret = null;
        row.callback_url = null;
        const cols = Object.keys(row);
        this.#run(`insert into routines (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
        routineIds.push(row.id);
        copiedIds.set(String(r.id), row.id);
      }
      // A starter's routines still waiting on the owner wait on them in the copy too, with no test run of their own yet.
      const starter = this.starterRecord(id);
      if (starter) {
        const pending = starter.pending.flatMap((x) => (copiedIds.has(x) ? [copiedIds.get(x)!] : []));
        if (pending.length) this.saveStarterRecord(newBotId, { ...starter, installedAt: now, pending, tests: [] });
      }
      for (const m of memories) {
        const memId = newId('mem');
        this.#run('insert into memories (id, bot_id, text, created_at) values (?, ?, ?, ?)', memId, newBotId, m.text, m.created_at);
        memoryIds.push(memId);
      }
      this.#publishSidebar();
      const made = this.emitBot(newBotId);
      for (const rid of routineIds) this.#emitRoutine(rid);
      for (const memory of this.listMemories(newBotId)) this.#publish({ type: 'memory.upserted', memory });
      this.addMessage(newBotId, 'event', `Duplicated from ${src.name}`, {
        kind: 'bot.duplicated',
        sourceBotId: src.id,
        sourceName: src.name,
        copiedRoutines: routineIds.length,
        copiedMemories: memoryIds.length,
      });
      return made;
    });
    log.info('Boton duplicated', { botId: newBotId, sourceBotId: src.id, routines: routineIds.length, memories: memoryIds.length });
    return bot;
  }

  /** Takes `name` off every Boton's list of connectors or skills. */
  dropFromBots(column: 'connections' | 'skills', name: string): void {
    for (const r of this.#all(`select id, ${column} as list from bots where ${column} is not null`)) {
      const list = parseList(r.list);
      if (!list.includes(name)) continue;
      this.#run(`update bots set ${column} = ? where id = ?`, JSON.stringify(list.filter((x) => x !== name)), r.id);
      this.emitBot(r.id);
    }
  }

  /** A Boton's skills: null for every skill. */
  setSkills(id: string, skills: string[] | null): Bot {
    this.getBot(id);
    this.#run('update bots set skills = ?, updated_at = ? where id = ?', skills === null ? null : JSON.stringify(skills), nowIso(), id);
    return this.emitBot(id);
  }

  /** Published when the transaction it is in commits (at once outside one). */
  publish(event: ServerEvent): void {
    this.#publish(event);
  }

  setConnections(id: string, connections: string[]): Bot {
    this.getBot(id);
    this.#run('update bots set connections = ?, updated_at = ? where id = ?', JSON.stringify(connections), nowIso(), id);
    return this.emitBot(id);
  }

  setBotPaused(id: string, paused: boolean): Bot {
    this.getBot(id);
    this.#run('update bots set paused = ? where id = ?', paused ? 1 : 0, id);
    return this.emitBot(id);
  }

  addAlwaysAllow(id: string, action: string): Bot {
    const bot = this.getBot(id);
    if (bot.alwaysAllow.includes(action)) return this.publicBot(bot);
    this.#run('update bots set always_allow = ?, updated_at = ? where id = ?', JSON.stringify(alwaysAllowList([...bot.alwaysAllow, action])), nowIso(), id);
    return this.emitBot(id);
  }

  deleteBot(id: string): void {
    this.getBot(id);
    this.#failActiveRuns('bot_id', id, 'Boton was deleted');
    this.#run('delete from bots where id = ?', id);
    this.#run('delete from settings where key = ?', starterKey(id));
    this.#run('delete from settings where key = ?', `inboxPins:${id}`);
    this.#publish({ type: 'bot.deleted', botId: id });
    this.#publishSidebar();
    if (Number(this.#run("delete from settings where key = 'primaryBotId' and value = ?", id).changes)) {
      this.#publish({ type: 'settings.updated', settings: this.getSettings() });
    }
  }

  // ----------------------------------------------------------------- sidebar
  // One layout for the owner, on every device: groups in order, each Boton in one group or ungrouped at its
  // position there, and the pinned ones in their own order. Every change publishes the whole layout.

  sidebarLayout(): SidebarLayout {
    const settings = Object.fromEntries(this.#all(`select key, value from settings where key in ('${SIDEBAR_COLLAPSED.pinned}', '${SIDEBAR_COLLAPSED.ungrouped}')`).map((r) => [r.key, r.value]));
    const bots = this.#all('select id, group_id, pinned from bots order by position, created_at, id');
    const groups = this.#all('select id, name, collapsed from sidebar_groups order by position, created_at, id').map((g) => ({
      id: String(g.id),
      name: String(g.name),
      collapsed: !!g.collapsed,
      botIds: bots.filter((b) => b.group_id === g.id).map((b) => String(b.id)),
    }));
    return {
      pinned: {
        collapsed: settings[SIDEBAR_COLLAPSED.pinned] === '1',
        botIds: this.#all('select id from bots where pinned = 1 order by pin_position, created_at, id').map((r) => String(r.id)),
      },
      groups,
      ungrouped: { collapsed: settings[SIDEBAR_COLLAPSED.ungrouped] === '1', botIds: bots.filter((b) => b.group_id === null).map((b) => String(b.id)) },
    };
  }

  #publishSidebar(): void {
    this.#publish({ type: 'sidebar.updated', layout: this.sidebarLayout() });
  }

  /** Changes the layout in one transaction, then publishes it; returns it. */
  #sidebarChange(fn: () => void): SidebarLayout {
    return this.atomically(() => {
      fn();
      const layout = this.sidebarLayout();
      this.#publish({ type: 'sidebar.updated', layout });
      return layout;
    });
  }

  #group(id: unknown): Row {
    const g = typeof id === 'string' ? this.#get('select * from sidebar_groups where id = ?', id) : undefined;
    if (!g) throw new HttpError(404, `No sidebar group with id ${String(id)}`);
    return g;
  }

  #groupName(name: unknown, except: string | null = null): string {
    const n = clean(name, 'name', SIDEBAR_GROUP_NAME_MAX, true);
    const taken = this.#get('select name from sidebar_groups where name_key = ? and id is not ?', sidebarGroupKey(n), except);
    if (taken) throw new HttpError(409, `There is already a group called ${taken.name}`);
    return n;
  }

  #addGroup(name: string, index?: number): string {
    if (Number(this.#get('select count(*) as n from sidebar_groups')!.n) >= SIDEBAR_GROUPS_MAX) {
      throw new HttpError(400, `The sidebar can have at most ${SIDEBAR_GROUPS_MAX} groups`);
    }
    const id = newId('grp');
    const now = nowIso();
    this.#run(
      'insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values (?, ?, ?, ?, 0, ?, ?)',
      id,
      name,
      sidebarGroupKey(name),
      this.#nextGroupPosition(),
      now,
      now,
    );
    if (index !== undefined) this.#reorder('sidebar_groups', this.#groupIds(), id, index);
    return id;
  }

  /**
   * The group a Boton's input names: by id (null or "": ungrouped), or by name in any case, made last if there is
   * none ("": ungrouped). undefined: it names none.
   */
  #groupInput(input: { groupId?: unknown; group?: unknown }): string | null | undefined {
    if (input.groupId !== undefined && input.group !== undefined) throw new HttpError(400, 'Give a group by groupId or by name (group), not both');
    if (input.groupId !== undefined) return input.groupId === null || input.groupId === '' ? null : String(this.#group(input.groupId).id);
    if (input.group === undefined) return undefined;
    const name = clean(input.group, 'group', SIDEBAR_GROUP_NAME_MAX);
    if (!name) return null;
    const found = this.#get('select id from sidebar_groups where name_key = ?', sidebarGroupKey(name));
    return found ? String(found.id) : this.#addGroup(name);
  }

  #nextPosition(groupId: string | null): number {
    return Number(this.#get('select coalesce(max(position) + 1, 0) as n from bots where group_id is ?', groupId)!.n);
  }

  #nextPinPosition(): number {
    return Number(this.#get('select coalesce(max(pin_position) + 1, 0) as n from bots where pinned = 1')!.n);
  }

  #nextGroupPosition(): number {
    return Number(this.#get('select coalesce(max(position) + 1, 0) as n from sidebar_groups')!.n);
  }

  #groupIds(): string[] {
    return this.#all('select id from sidebar_groups order by position, created_at, id').map((r) => String(r.id));
  }

  /** Puts `id` at `index` in `ids` (the list it is in or moves into) and numbers the list again from 0. */
  #reorder(table: 'sidebar_groups' | 'bots', ids: string[], id: string, index: unknown, column: 'position' | 'pin_position' = 'position'): void {
    const list = ids.filter((x) => x !== id);
    list.splice(sidebarIndex(index, list.length), 0, id);
    this.#renumber(table, list, column);
  }

  #renumber(table: 'sidebar_groups' | 'bots', ids: string[], column: 'position' | 'pin_position' = 'position'): void {
    const save = this.db.prepare(`update ${table} set ${column} = ? where id = ?`);
    ids.forEach((x, i) => save.run(i, x));
  }

  createSidebarGroup(input: { name?: unknown; index?: unknown }): { id: string; layout: SidebarLayout } {
    let id = '';
    const layout = this.#sidebarChange(() => {
      const name = this.#groupName(input?.name);
      id = this.#addGroup(name, input.index === undefined ? undefined : sidebarIndex(input.index, Number.MAX_SAFE_INTEGER));
    });
    return { id, layout };
  }

  updateSidebarGroup(id: string, input: { name?: unknown; collapsed?: unknown }): SidebarLayout {
    return this.#sidebarChange(() => {
      this.#group(id);
      const name = input?.name !== undefined ? this.#groupName(input.name, id) : undefined;
      const collapsed = input?.collapsed !== undefined ? flag(input.collapsed, 'collapsed') : undefined;
      if (name !== undefined) this.#run('update sidebar_groups set name = ?, name_key = ?, updated_at = ? where id = ?', name, sidebarGroupKey(name), nowIso(), id);
      if (collapsed !== undefined) this.#run('update sidebar_groups set collapsed = ?, updated_at = ? where id = ?', collapsed ? 1 : 0, nowIso(), id);
      // A Boton shows its group's name: a rename changes how each of them reads.
      if (name !== undefined) for (const r of this.#all('select id from bots where group_id = ?', id)) this.emitBot(String(r.id));
    });
  }

  /** Deleting a group deletes no Boton: its Botons go last among the ungrouped, in their order; pins stay. */
  deleteSidebarGroup(id: string): SidebarLayout {
    return this.#sidebarChange(() => {
      this.#group(id);
      const members = this.#all('select id from bots where group_id = ? order by position, created_at, id', id).map((r) => String(r.id));
      let next = this.#nextPosition(null);
      for (const m of members) this.#run('update bots set group_id = null, position = ? where id = ?', next++, m);
      this.#run('delete from sidebar_groups where id = ?', id);
      this.#renumber('sidebar_groups', this.#groupIds());
      for (const m of members) this.emitBot(m);
    });
  }

  moveSidebarGroup(id: string, input: { index?: unknown }): SidebarLayout {
    return this.#sidebarChange(() => {
      this.#group(id);
      this.#reorder('sidebar_groups', this.#groupIds(), id, input?.index);
    });
  }

  /** Into a group (or ungrouped, groupId null) at `index` there: within its own group, a reorder. */
  moveSidebarBot(botId: string, input: { groupId?: unknown; index?: unknown }): SidebarLayout {
    return this.#sidebarChange(() => {
      const bot = this.getBot(botId);
      if (input?.groupId === undefined) throw new HttpError(400, 'groupId is required: a group\'s id, or null for ungrouped');
      const groupId = this.#groupInput({ groupId: input.groupId })!;
      const members = this.#all('select id from bots where group_id is ? order by position, created_at, id', groupId).map((r) => String(r.id));
      if (groupId !== bot.groupId) this.#run('update bots set group_id = ?, updated_at = ? where id = ?', groupId, nowIso(), botId);
      this.#reorder('bots', members, botId, input.index);
      if (groupId !== bot.groupId) this.emitBot(botId);
    });
  }

  /** Pins it at `index` among the pinned (pinned again: a reorder), or unpins it; its group stays. */
  pinSidebarBot(botId: string, input: { pinned?: unknown; index?: unknown }): SidebarLayout {
    return this.#sidebarChange(() => {
      const bot = this.getBot(botId);
      const pinned = flag(input?.pinned, 'pinned');
      if (pinned) {
        const pins = this.#all('select id from bots where pinned = 1 order by pin_position, created_at, id').map((r) => String(r.id));
        this.#run('update bots set pinned = 1 where id = ?', botId);
        this.#reorder('bots', pins, botId, input.index, 'pin_position');
      } else {
        if (input.index !== undefined) throw new HttpError(400, 'index is only for pinning');
        this.#run('update bots set pinned = 0, pin_position = 0 where id = ?', botId);
      }
      if (pinned !== bot.pinned) {
        this.#run('update bots set updated_at = ? where id = ?', nowIso(), botId);
        this.emitBot(botId);
      }
    });
  }

  setSidebarSection(key: string, input: { collapsed?: unknown }): SidebarLayout {
    if (key !== 'pinned' && key !== 'ungrouped') throw new HttpError(404, 'The sections are pinned and ungrouped; a group is changed by its id');
    const collapsed = flag(input?.collapsed, 'collapsed');
    return this.#sidebarChange(() => this.#setSetting(SIDEBAR_COLLAPSED[key as SidebarSectionKey], collapsed ? '1' : '0'));
  }

  exportSidebar(): SidebarTransfer {
    const l = this.sidebarLayout();
    return {
      format: SIDEBAR_FORMAT,
      version: 1,
      exportedAt: nowIso(),
      pinned: l.pinned,
      groups: l.groups.map((g) => ({ name: g.name, collapsed: g.collapsed, botIds: g.botIds })),
      ungrouped: l.ungrouped,
    };
  }

  /** See SidebarTransfer: the whole file is checked before anything changes, and it changes in one transaction. */
  importSidebar(input: unknown): SidebarImportResult {
    const file = sidebarTransfer(input);
    const skipped = new Set<string>();
    const layout = this.#sidebarChange(() => {
      const before = new Map(this.#all('select id, group_id, pinned from bots').map((r) => [String(r.id), r]));
      const known = (ids: string[]) => {
        for (const id of ids) if (!before.has(id)) skipped.add(id);
        return ids.filter((id) => before.has(id));
      };

      // Groups: the same name keeps its id, the rest are made; the ones the file lacks go, ungrouping their Botons.
      const existing = new Map(this.#all('select id, name_key from sidebar_groups').map((r) => [String(r.name_key), String(r.id)]));
      const now = nowIso();
      const groupIds = file.groups.map((g, i) => {
        const id = existing.get(sidebarGroupKey(g.name));
        if (id) {
          existing.delete(sidebarGroupKey(g.name));
          this.#run('update sidebar_groups set name = ?, name_key = ?, position = ?, collapsed = ?, updated_at = ? where id = ?', g.name, sidebarGroupKey(g.name), i, g.collapsed ? 1 : 0, now, id);
          return id;
        }
        const made = newId('grp');
        this.#run(
          'insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
          made,
          g.name,
          sidebarGroupKey(g.name),
          i,
          g.collapsed ? 1 : 0,
          now,
          now,
        );
        return made;
      });
      for (const gone of existing.values()) {
        this.#run('update bots set group_id = null where group_id = ?', gone);
        this.#run('delete from sidebar_groups where id = ?', gone);
      }

      // Botons: where the file puts them; the ones it doesn't mention after the ungrouped it lists, in their order.
      const placed = new Set<string>();
      const place = this.db.prepare('update bots set group_id = ?, position = ? where id = ?');
      file.groups.forEach((g, i) =>
        known(g.botIds).forEach((id, n) => {
          place.run(groupIds[i], n, id);
          placed.add(id);
        }),
      );
      const ungrouped = known(file.ungrouped.botIds);
      for (const id of ungrouped) placed.add(id);
      const rest = this.#all('select id from bots order by position, created_at, id')
        .map((r) => String(r.id))
        .filter((id) => !placed.has(id));
      [...ungrouped, ...rest].forEach((id, n) => place.run(null, n, id));

      // Pins: the file's, in its order; a Boton it doesn't mention keeps its pin, after them.
      const mentioned = new Set([...placed, ...file.pinned.botIds]);
      const pins = known(file.pinned.botIds);
      const kept = this.#all('select id from bots where pinned = 1 order by pin_position, created_at, id')
        .map((r) => String(r.id))
        .filter((id) => !mentioned.has(id));
      this.db.prepare('update bots set pinned = 0, pin_position = 0').run();
      const pin = this.db.prepare('update bots set pinned = 1, pin_position = ? where id = ?');
      [...pins, ...kept].forEach((id, n) => pin.run(n, id));

      this.#setSetting(SIDEBAR_COLLAPSED.pinned, file.pinned.collapsed ? '1' : '0');
      this.#setSetting(SIDEBAR_COLLAPSED.ungrouped, file.ungrouped.collapsed ? '1' : '0');
      // A Boton whose group or pin changed reads differently, and so may one in a group the file spells anew.
      for (const [id, was] of before) {
        const b = this.getBot(id);
        const moved = b.groupId !== (was.group_id ?? null) || b.pinned !== !!was.pinned;
        if (moved) this.#run('update bots set updated_at = ? where id = ?', now, id);
        if (moved || b.groupId) this.emitBot(id);
      }
    });
    return { layout, skipped: [...skipped] };
  }

  team(botId: string): TeamMember[] {
    this.getBot(botId);
    const primary = this.getSettings().primaryBotId;
    return this.#all('select id, name, title, paused from bots order by name collate nocase, id').map((r) => ({
      id: r.id,
      name: r.name,
      title: r.title,
      state: this.#statusOf(r.id).state,
      paused: !!r.paused,
      primary: r.id === primary,
      self: r.id === botId,
    }));
  }

  emitBot(id: string): Bot {
    const bot = this.publicBot(this.getBot(id));
    this.#publish({ type: 'bot.upserted', bot });
    return bot;
  }

  /** The marker never moves back, so an older device catching up can't make read messages unread. */
  markRead(botId: string, upTo?: string): Bot {
    this.getBot(botId);
    let seq: number;
    if (upTo === undefined) {
      seq = Number(this.#get('select coalesce(max(seq), 0) as seq from messages where bot_id = ?', botId)!.seq);
    } else {
      const row = this.#get('select seq from messages where id = ? and bot_id = ?', upTo, botId);
      if (!row) throw new HttpError(400, `upTo must be a message in this chat; ${upTo} is not`);
      seq = Number(row.seq);
    }
    const moved = Number(this.#run('update bots set read_seq = ? where id = ? and read_seq < ?', seq, botId, seq).changes);
    return moved ? this.emitBot(botId) : this.publicBot(this.getBot(botId));
  }

  /**
   * Kept only while the Boton is as the turn read it: the same conversation (no reset since), the same provider, and
   * no provider switch since (`switchGeneration`), so a move away and back can't hand the old turn's session back.
   */
  setSession(botId: string, sessionId: string | null, sessionKey: string | null, at: TurnStamp): boolean {
    const r = this.#run(
      `update bots set session_id = ?, session_key = ? where id = ? and context_since is ? and provider = ? and ${GENERATION_SQL} = ?`,
      sessionId,
      sessionKey,
      botId,
      at.contextSince,
      at.provider,
      botId,
      at.generation,
    );
    return Number(r.changes) > 0;
  }

  /** Ends the chat's saved session: the next chat turn starts a new one. */
  dropSession(botId: string): void {
    this.#run('update bots set session_id = null, session_key = null where id = ?', botId);
  }

  /**
   * The Boton's provider switches so far, as the seq of the latest one's event (0 before any): seqs are never reused,
   * so each switch gives a new value, for good, across restarts. A turn reads it with the Boton.
   */
  switchGeneration(botId: string): number {
    return Number(this.#get(`select ${GENERATION_SQL} as g`, botId)?.g ?? 0);
  }

  contextSince(botId: string): string | null {
    const r = this.#get('select context_since from bots where id = ?', botId);
    if (!r) throw new HttpError(404, `No Boton with id ${botId}`);
    return r.context_since ?? null;
  }

  /**
   * Starts the chat fresh: no session, and nothing from before is given to a new one. The pins go with the rest, in
   * the same transaction, and every device is told, so no message still shows a pin no session will be given.
   */
  resetContext(botId: string): Message {
    this.getBot(botId);
    return this.atomically(() => {
      this.#run('update bots set session_id = null, session_key = null, context_since = ? where id = ?', nowIso(), botId);
      this.#run('update routines set session_id = null, session_key = null where bot_id = ?', botId);
      const pins = this.#all(`select * from messages where bot_id = ? and ${PINNED_SQL}`, botId);
      for (const r of pins) this.#publish({ type: 'message.updated', message: this.#unpin(r) });
      log.info('conversation reset: the next turn starts a new session', { botId, unpinned: pins.length });
      return this.addMessage(botId, 'event', 'Started a fresh conversation', { kind: 'session.reset' });
    });
  }

  /** Takes the pin off a message's meta, keeping the rest of it. */
  #unpin(r: Row): Message {
    const { pinned: _p, ...meta } = parseJson<MessageMeta>(r.meta, {});
    this.#run('update messages set meta = ? where id = ?', Object.keys(meta).length ? JSON.stringify(meta) : null, r.id);
    return this.#toMessage(this.#get('select * from messages where id = ?', r.id)!);
  }

  // ---------------------------------------------------------------- messages

  #reactionsQuery: StatementSync | null = null;

  /** Every read of a message has its reactions, so an event that replaces one on a client never drops them. */
  #toMessage(r: Row): Message {
    const reactions = this.reactionsOf(r.id);
    return {
      id: r.id,
      botId: r.bot_id,
      role: r.role as MessageRole,
      text: r.text,
      // A meta that isn't JSON reads as none, as it does in SQL (MESSAGE_META): the message still shows.
      meta: r.meta ? parseJson<MessageMeta | null>(r.meta, null) : null,
      createdAt: r.created_at,
      ...(reactions.length ? { reactions } : {}),
    };
  }

  /** A message's reactions, oldest first (on the table's primary key). */
  reactionsOf(messageId: string): MessageReaction[] {
    // Prepared once: every message read runs it.
    this.#reactionsQuery ??= this.db.prepare('select actor, emoji, created_at from message_reactions where message_id = ? order by created_at, rowid');
    return (this.#reactionsQuery.all(messageId) as Row[]).map((x) => ({
      emoji: x.emoji,
      by: x.actor as ReactionActor,
      at: x.created_at,
    }));
  }

  /**
   * Oldest first: the newest `limit`, the `limit` just before `before`, or the `limit` just after `after`
   * (a chat that let its newest pages go reads its way back to them). An `after` not in this chat is a 404.
   */
  listMessages(botId: string, opts: { before?: string; after?: string; limit?: number } = {}): Message[] {
    this.getBot(botId);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    if (opts.before && opts.after) throw new HttpError(400, 'Pass before or after, not both');
    let rows: Row[];
    if (opts.after) {
      const ref = this.#get('select seq from messages where id = ? and bot_id = ?', opts.after, botId);
      if (!ref) throw new HttpError(404, `No message ${opts.after} in this chat`);
      return this.#withQuiet(botId, this.#all('select * from messages where bot_id = ? and seq > ? order by seq asc limit ?', botId, ref.seq, limit));
    }
    if (opts.before) {
      const ref = this.#get('select seq from messages where id = ?', opts.before);
      rows = this.#all('select * from messages where bot_id = ? and seq < ? order by seq desc limit ?', botId, ref?.seq ?? 0, limit);
    } else {
      rows = this.#all('select * from messages where bot_id = ? order by seq desc limit ?', botId, limit);
    }
    return this.#withQuiet(botId, rows.reverse());
  }

  /** Rows of one chat, oldest first, as messages, with what the transcript leaves out marked quiet (see #quietOf). */
  #withQuiet(botId: string, rows: Row[]): Message[] {
    const messages = rows.map((r) => this.#toMessage(r));
    const quiet = this.#quietOf(botId, rows, messages);
    return quiet.size ? messages.map((m) => (quiet.has(m.id) && !m.meta?.quiet ? { ...m, meta: { ...m.meta, quiet: true, ...(quiet.get(m.id) ? { quietTurn: quiet.get(m.id)! } : {}) } } : m)) : messages;
  }

  /**
   * Which of these messages (one chat's, oldest first) the transcript leaves out, each with its quiet turn when known.
   * Marked ones as they are. Chat history from before the server marked them reads the same from the turn records,
   * whatever page the messages come in (nothing is written):
   * - a wake-up a quiet turn took: the turn is linked to the first message it took (a turn that took one of the owner's
   *   never ends quiet). The server marks exactly the ones it took, so a turn whose first message is marked is never
   *   read from times. An unmarked one took that first message and some of those after it up to when it started: it
   *   read them a little before it started (attachments, connectors), so one that came in between went to the next
   *   turn. Later ones count only when the next chat turn is quiet too and starts after them; processed state
   *   alone cannot prove a quiet reply, since preparation failures may not create a turn record;
   * - a posted [quiet] reply to wake-ups only, with the wake-ups it answered, and a routine run's with its run chip;
   * - what a quiet turn did in the chat (TURN_ACTIVITY): only by the turn it is tagged with. An untagged one (written
   *   before events said which turn did them) always shows: the owner can do the same (save a memory, change a
   *   routine) while a turn runs, and nothing recorded tells the two apart, so it is never guessed from its time.
   * Only messages mayBeQuiet allows: never the owner's, an error, an approval or a card.
   */
  #quietOf(botId: string, rows: Row[], messages: Message[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!rows.length) return out;
    const seqOf = new Map(rows.map((r, i) => [messages[i].id, Number(r.seq)]));
    const minAt = rows[0].created_at as string;
    const maxSeq = Number(rows.at(-1)!.seq);
    for (const m of messages) if (m.meta?.quiet && mayBeQuiet(m)) out.set(m.id, m.meta.quietTurn ?? null);
    const open = messages.filter((m) => !out.has(m.id) && mayBeQuiet(m));
    if (!open.length) return out;

    // Quiet chat turns that could have taken one of these: started from a little before the page (a turn's longest
    // run) on, with their first message at or before the page's end (a turn may start long after its messages: a
    // paused Boton).
    const slack = new Date(Date.parse(minAt) - this.#cfg.turnTimeoutMs - 60_000).toISOString();
    const chatTurns = this.#all(
      `select t.rowid as n, t.id, t.started_at, a.id as a_id, a.seq as a_seq, a.meta as a_meta from turns t join messages a on a.id = t.message_id
         where t.bot_id = ? and t.started_at >= ? and a.seq <= ? and a.role = 'user'
           and exists (select 1 from turn_steps s where s.turn_id = t.id and s.label = 'Quiet reply')`,
      botId,
      slack,
      maxSeq,
    ).filter((t) => {
      const meta = t.a_meta ? parseJson<MessageMeta | null>(t.a_meta, null) : null;
      // Marked by the server: exactly what it took is marked, nothing to read from times.
      return isAutomaticWake({ role: 'user', meta }) && !meta?.quiet;
    });
    // The chat turn after each (by when it started): the quiet one's anchor, if it is quiet.
    const nextOf = new Map<string, { anchorSeq: number | null } | null>();
    const nextTurn = (t: Row) => {
      const id = String(t.id);
      if (!nextOf.has(id)) {
        const n = this.#get(
          `select t.id, case when exists (select 1 from turn_steps s where s.turn_id = t.id and s.label = 'Quiet reply') then a.seq end as a_seq
             from turns t left join messages a on a.id = t.message_id and a.role = 'user'
             where t.bot_id = ? and t.trigger = 'chat' and (t.started_at > ? or (t.started_at = ? and t.rowid > ?)) order by t.started_at, t.rowid limit 1`,
          botId,
          t.started_at,
          t.started_at,
          t.n,
        );
        nextOf.set(id, n ? { anchorSeq: n.a_seq == null ? null : Number(n.a_seq) } : null);
      }
      return nextOf.get(id)!;
    };
    for (const m of messages) {
      if (m.role !== 'user' || out.has(m.id) || !mayBeQuiet(m)) continue;
      const seq = seqOf.get(m.id)!;
      const t = chatTurns.find((t) => Number(t.a_seq) <= seq && m.createdAt <= t.started_at);
      if (!t) continue;
      if (t.a_id !== m.id) {
        const next = nextTurn(t);
        const taken = next !== null && next.anchorSeq !== null && next.anchorSeq > seq;
        if (!taken) continue;
      }
      out.set(m.id, String(t.id));
    }

    // Posted [quiet] replies: in the page, and the reply after each wake-up left whose reply isn't (on another page).
    const replies = messages.filter((m) => m.role === 'bot' && !out.has(m.id) && parseQuiet(m.text) !== null);
    const seqs = new Map(seqOf);
    const looked = new Set<number>();
    // Wake-ups with a reply or error after them in the page need no look further.
    const answeredHere = new Set<string>();
    let replied = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'bot' || messages[i].role === 'error') replied = true;
      else if (replied) answeredHere.add(messages[i].id);
    }
    for (const m of open) {
      if (m.role !== 'user' || out.has(m.id) || answeredHere.has(m.id)) continue;
      const next = this.#get("select * from messages where bot_id = ? and seq > ? and role in ('bot', 'error') order by seq limit 1", botId, seqOf.get(m.id)!);
      if (!next || seqOf.has(next.id) || looked.has(Number(next.seq))) continue;
      looked.add(Number(next.seq));
      const reply = this.#toMessage(next);
      if (reply.role === 'bot' && parseQuiet(reply.text) !== null) {
        replies.push(reply);
        seqs.set(reply.id, Number(next.seq));
      }
    }
    for (const r of replies) {
      if (r.meta?.routineId) {
        out.set(r.id, r.meta.turnId ?? null);
        continue;
      }
      const seq = seqs.get(r.id)!;
      const answered = this.#all(
        `select * from messages where bot_id = ? and role = 'user' and seq < ?
           and seq > coalesce((select max(seq) from messages where bot_id = ? and seq < ? and role in ('bot', 'error')), 0)`,
        botId,
        seq,
        botId,
        seq,
      ).map((x) => this.#toMessage(x));
      if (!answered.length || !answered.every(isAutomaticWake)) continue;
      out.set(r.id, r.meta?.turnId ?? null);
      for (const w of answered) out.set(w.id, r.meta?.turnId ?? null);
    }
    // A routine run's chip goes with its run's quiet reply, in this page or another.
    const chips = messages.filter((m) => m.role === 'event' && m.meta?.kind === 'routine.run' && m.meta.runId && !out.has(m.id));
    if (chips.length) {
      const runs = new Set(
        this.#all(
          `select text, json_extract(${MESSAGE_META}, '$.runId') as run_id from messages where bot_id = ? and role = 'bot'
             and json_extract(${MESSAGE_META}, '$.runId') in (${chips.map(() => '?').join(', ')})`,
          botId,
          ...chips.map((c) => c.meta!.runId!),
        )
          .filter((x) => parseQuiet(String(x.text)) !== null)
          .map((x) => String(x.run_id)),
      );
      for (const c of chips) if (runs.has(c.meta!.runId!)) out.set(c.id, null);
    }

    // What a quiet turn did in the chat.
    const activity = open.filter((m) => m.role === 'event' && TURN_ACTIVITY.has(m.meta?.kind ?? '') && !out.has(m.id));
    if (activity.length) {
      const tagged = activity.flatMap((m) => (m.meta?.byTurn ? [m.meta.byTurn] : []));
      const quietTagged = new Set(
        tagged.length
          ? this.#all(
              `select t.id from turns t where t.id in (${tagged.map(() => '?').join(', ')})
                 and (exists (select 1 from turn_steps s where s.turn_id = t.id and s.label = 'Quiet reply') or exists (select 1 from routine_runs r where r.id = t.run_id and r.quiet = 1))`,
              ...tagged,
            ).map((x) => String(x.id))
          : [],
      );
      // Tagged as no turn's (the owner, the server), or untagged (no record of who did it): always shown.
      for (const m of activity) if (m.meta?.byTurn && quietTagged.has(m.meta.byTurn)) out.set(m.id, m.meta.byTurn);
    }
    return out;
  }

  /**
   * A turn that ended [quiet]: the wake-ups it answered (the owner's messages never) and what it did in the chat are
   * marked, so the transcript leaves them out.
   */
  markQuiet(turnId: string | null, ids: string[]): void {
    const bots = new Set<string>();
    const mark = (r: Row) => {
      this.#run(
        `update messages set meta = json_set(coalesce(${MESSAGE_META}, '{}'), '$.quiet', json('true')${turnId ? ", '$.quietTurn', ?" : ''}) where id = ?`,
        ...(turnId ? [turnId] : []),
        r.id,
      );
      this.#publish({ type: 'message.updated', message: this.findMessage(r.id)! });
      bots.add(r.bot_id);
    };
    for (const id of ids) {
      const r = this.#get('select * from messages where id = ?', id);
      if (r && isAutomaticWake(this.#toMessage(r))) mark(r);
    }
    if (turnId) {
      for (const r of this.#all(`select * from messages where role = 'event' and json_extract(${MESSAGE_META}, '$.byTurn') = ?`, turnId)) {
        if (TURN_ACTIVITY.has(this.#toMessage(r).meta?.kind ?? '')) mark(r);
      }
    }
    for (const b of bots) this.emitBot(b);
  }

  /**
   * What a Boton did in the background lately: its routine turns (scheduled, manual, webhook, test) and the wake-ups
   * that started a chat turn (connector updates, other Botons, follow-ups). The last hour's count and how many ended
   * quiet, when the latest of them all was, and the last day's newest 100 as a list (each with its quiet note or its
   * reply's turn), for the chat's background line and what it opens. At most 500 of each kind a day are counted.
   */
  backgroundActivity(botId: string, now = Date.now()): BackgroundActivity {
    this.getBot(botId);
    const hour = new Date(now - 3_600_000).toISOString();
    const day = new Date(now - 86_400_000).toISOString();
    const items: BackgroundItem[] = [];
    const note = (turnId: string | null): string =>
      turnId ? ((this.#get("select detail from turn_steps where turn_id = ? and label = 'Quiet reply' order by idx desc limit 1", turnId)?.detail as string | undefined) ?? '') : '';
    for (const t of this.#all(
      `select t.id, t.started_at, t.outcome, t.trigger, t.run_id, t.routine_id, t.step_count, r.quiet, r.reply, r.attempts, r.trigger as run_trigger, ro.name
         from turns t left join routine_runs r on r.id = t.run_id left join routines ro on ro.id = t.routine_id
         where t.bot_id = ? and t.started_at >= ? and t.trigger != 'chat' order by t.started_at desc, t.rowid desc limit 500`,
      botId,
      day,
    )) {
      const quiet = Number(t.quiet) === 1;
      const label = routineLabel({ routineName: (t.name as string | null) ?? undefined, trigger: (t.run_trigger ?? t.trigger) as RunTrigger, attempt: Number(t.attempts ?? 1) });
      items.push({
        at: t.started_at,
        label: label.text,
        detail: t.run_id ? `Run ${t.run_id}` : label.text,
        quiet,
        note: quiet ? ((t.reply as string | null) ?? note(String(t.id))) : null,
        outcome: t.outcome,
        stepsMessageId: null,
        steps: Number(t.step_count ?? 0),
        runId: t.run_id ?? null,
        routineId: t.routine_id ?? null,
        warn: t.outcome === 'error',
      });
    }
    const turns = items.length;
    // Wake-ups, newest first: the last day's, read as the chat reads them (quiet or not), and the latest of any day.
    const rows: Row[] = [];
    let lastWake: string | null = null;
    let looked = 0;
    for (const r of this.db.prepare(`select * from messages where bot_id = ? and role = 'user' order by seq desc`).iterate(botId) as Iterable<Row>) {
      // A long chat of the owner's: enough rows looked at.
      if (++looked > 5000) break;
      if (r.created_at < day && lastWake) break;
      const m = this.#toMessage(r);
      if (!isAutomaticWake(m)) continue;
      lastWake ??= r.created_at as string;
      if (r.created_at < day) break;
      if (rows.length < 500) rows.push(r);
    }
    rows.reverse();
    const quiet = this.#quietOf(botId, rows, rows.map((r) => this.#toMessage(r)));
    for (const r of rows) {
      const m = this.#toMessage(r);
      const label = wakeLabel(m);
      const isQuiet = quiet.has(m.id);
      let turnId = isQuiet ? quiet.get(m.id)! : null;
      let stepsMessageId: string | null = null;
      let outcome: string | null = null;
      let steps = 0;
      if (isQuiet) {
        const t = turnId ? this.#get('select message_id, step_count from turns where id = ?', turnId) : null;
        stepsMessageId = (t?.message_id as string | null | undefined) ?? null;
        steps = Number(t?.step_count ?? 0);
        outcome = 'ok';
      } else {
        // Its reply: the first reply or error after it.
        const reply = this.#get("select * from messages where bot_id = ? and seq > ? and role in ('bot', 'error') order by seq limit 1", botId, r.seq);
        const rm = reply ? this.#toMessage(reply) : null;
        turnId = rm?.meta?.turnId ?? null;
        stepsMessageId = rm?.meta?.turnId ? rm.id : null;
        steps = rm?.meta?.steps ?? 0;
        outcome = rm ? (rm.role === 'error' ? 'error' : 'ok') : r.pending ? 'running' : null;
      }
      items.push({
        at: m.createdAt,
        label: label.text,
        detail: label.detail,
        quiet: isQuiet,
        note: isQuiet ? note(turnId) : null,
        outcome,
        stepsMessageId,
        steps,
        runId: null,
        routineId: null,
        warn: label.warn || outcome === 'error',
      });
    }
    // Newest first; at the same millisecond, wake-ups before routine turns, each the later one first.
    const order = new Map(items.map((item, i) => [item, i < turns ? -i : i]));
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : order.get(b)! - order.get(a)!));
    const recent = items.slice(0, 100);
    const lastHour = items.filter((i) => i.at >= hour);
    const lastRun = this.#get("select max(started_at) as at from turns where bot_id = ? and trigger != 'chat'", botId)?.at as string | null;
    const lastAt = [lastRun, lastWake].filter((x): x is string => !!x).sort().at(-1) ?? null;
    return { lastHour: lastHour.length, quietLastHour: lastHour.filter((i) => i.quiet).length, lastAt, recent };
  }

  addMessage(botId: string, role: MessageRole, text: string, meta: MessageMeta | null = null, pending = false): Message {
    // What a Boton does in the chat says which turn did it (null: the owner or the server), so a quiet turn's goes with it.
    if (role === 'event' && meta?.kind && TURN_ACTIVITY.has(meta.kind) && meta.byTurn === undefined) meta = { ...meta, byTurn: actingTurn(botId) };
    const id = newId('msg', 10);
    const now = nowIso();
    this.#run(
      'insert into messages (id, bot_id, role, text, meta, pending, created_at) values (?, ?, ?, ?, ?, ?, ?)',
      id,
      botId,
      role,
      text,
      meta ? JSON.stringify(meta) : null,
      pending ? 1 : 0,
      now,
    );
    this.#run('update bots set last_activity_at = ? where id = ?', now, botId);
    const message = this.#toMessage(this.#get('select * from messages where id = ?', id)!);
    this.#publish({ type: 'message.created', message });
    if (role !== 'event') this.emitBot(botId);
    return message;
  }

  findMessage(id: string): Message | null {
    const r = this.#get('select * from messages where id = ?', id);
    return r ? this.#toMessage(r) : null;
  }

  /**
   * A posted card's new state, only if it is still pending: the one place a card changes, so an answer counts once
   * however many arrive together. Returns the message as it is now, or null (it was not pending any more).
   */
  closeCard(id: string, card: TranscriptCard): Message | null {
    const changed = this.#run(
      `update messages set meta = json_set(meta, '$.card', json(?)) where id = ? and role = 'event'
         and json_extract(meta, '$.kind') = 'card.posted' and json_extract(meta, '$.card.status') = 'pending'`,
      JSON.stringify(card),
      id,
    ).changes;
    if (!Number(changed)) return null;
    const message = this.findMessage(id)!;
    this.#publish({ type: 'message.updated', message });
    return message;
  }

  /**
   * A browser handoff's new record (shared/handoff.ts), only if it is still in state `from`: the one place a handoff
   * changes, so two takes or two hand-backs arriving together count once. Returns the message as it is now, or null.
   */
  setHandoff(id: string, from: BrowserHandoff['state'], next: BrowserHandoff): Message | null {
    const changed = this.#run(
      `update messages set meta = json_set(meta, '$.browserHandoff', json(?)) where id = ? and role = 'event'
         and json_extract(meta, '$.kind') = 'browser.handoff' and json_extract(meta, '$.browserHandoff.state') = ?`,
      JSON.stringify(next),
      id,
      from,
    ).changes;
    if (!Number(changed)) return null;
    const message = this.findMessage(id)!;
    this.#publish({ type: 'message.updated', message });
    return message;
  }

  /** A Boton's browser handoffs still requested or taken, newest first (`botId` null: every Boton's). Requests past their expiry are closed as they are found, so this stays short. */
  openHandoffs(botId: string | null): Message[] {
    return this.#all(
      `select * from messages where (? is null or bot_id = ?) and role = 'event' and json_extract(meta, '$.kind') = 'browser.handoff'
         and json_extract(meta, '$.browserHandoff.state') in ('requested', 'taken') order by seq desc`,
      botId,
      botId,
    ).map((r) => this.#toMessage(r));
  }

  /** A Boton's cards still pending and not yet past their expiry. */
  pendingCards(botId: string, now = nowIso()): number {
    return Number(
      this.#get(
        `select count(*) as n from messages where bot_id = ? and role = 'event' and json_extract(meta, '$.kind') = 'card.posted'
           and json_extract(meta, '$.card.status') = 'pending' and json_extract(meta, '$.card.expiresAt') > ?`,
        botId,
        now,
      )!.n,
    );
  }

  /** A pending card of this Boton's with exactly this content, if there is one (a retry posts nothing new). */
  samePendingCard(botId: string, descriptor: string, now = nowIso()): Message | null {
    const r = this.#get(
      `select * from messages where bot_id = ? and role = 'event' and json_extract(meta, '$.kind') = 'card.posted'
         and json_extract(meta, '$.card.status') = 'pending' and json_extract(meta, '$.card.expiresAt') > ?
         and json(json_extract(meta, '$.card.descriptor')) = json(?) order by seq desc limit 1`,
      botId,
      now,
      descriptor,
    );
    return r ? this.#toMessage(r) : null;
  }

  // A user message's `pending`: 1 waiting for a reply, 2 in flight (a 2 found at startup was cut off), 0 answered.

  /**
   * The pending messages one chat turn answers: the oldest and those after it with the same audience, the one its reply
   * goes to (the owner, or the colleague whose ask it is). Never two audiences, since one reply is sent to each asker.
   */
  startChatTurn(botId: string): { messages: Message[]; interrupted: boolean; more: boolean } {
    const all = this.#all("select * from messages where bot_id = ? and role = 'user' and pending in (1, 2) order by seq", botId);
    const audience = (r: Row) => {
      const meta = r.meta ? parseJson<MessageMeta | null>(r.meta, null) : null;
      return meta?.kind === 'ask' ? `ask:${meta.fromBotId ?? ''}` : 'owner';
    };
    const first = all[0] ? audience(all[0]) : null;
    const end = all.findIndex((r) => audience(r) !== first);
    const rows = end === -1 ? all : all.slice(0, end);
    const interrupted = rows.some((r) => r.pending === 2);
    for (const r of rows) if (r.pending === 1) this.#run('update messages set pending = 2 where id = ?', r.id);
    return { messages: rows.map((r) => this.#toMessage(r)), interrupted, more: rows.length < all.length };
  }

  /** One transaction, so a crash cannot leave the reply without its messages marked answered, or the reverse. */
  finishChatTurn(ids: string[], botId: string, text: string, meta: MessageMeta | null): Message {
    return this.atomically(() => {
      const reply = this.addMessage(botId, 'bot', text, meta);
      this.markProcessed(ids);
      return reply;
    });
  }

  pendingChats(): { botId: string; since: string }[] {
    return this.#all("select bot_id, min(created_at) as since from messages where role = 'user' and pending in (1, 2) group by bot_id").map((r) => ({
      botId: r.bot_id as string,
      since: r.since as string,
    }));
  }

  markProcessed(ids: string[]): void {
    for (const id of ids) this.#run('update messages set pending = 0 where id = ?', id);
  }

  /** Messages of a turn that ended without answering them: waiting again (not in flight), for the next turn. */
  requeueChat(ids: string[]): void {
    for (const id of ids) this.#run("update messages set pending = 1 where id = ? and role = 'user' and pending = 2", id);
  }

  hasPendingChat(botId: string): boolean {
    return !!this.#get("select 1 from messages where bot_id = ? and role = 'user' and pending in (1, 2) limit 1", botId);
  }

  dropPendingChat(botId: string): number {
    return Number(this.#run("update messages set pending = 0 where bot_id = ? and role = 'user' and pending in (1, 2)", botId).changes);
  }

  /**
   * What a new session may be given of the chat since the reset, newest first: the chat and, apart, routine messages
   * (so a run of busy routines can't push the owner's out), each read a page at a time only as far as sessionStart's
   * budget takes it, and the owner's pins (see setMessagePinned). Never a message still waiting for its reply: it is
   * the input of a turn, and one waiting for another audience's turn (the owner's, or another colleague's ask) is not
   * this turn's to see.
   */
  replaySource(botId: string, since: string | null, excludeIds: string[]): { chat: Iterable<Replayable>; routines: Iterable<Replayable>; pins: Replayable[] } {
    const waiting = this.#all("select id from messages where bot_id = ? and role = 'user' and pending in (1, 2)", botId).map((r) => r.id as string);
    const exclude = new Set([...excludeIds, ...waiting]);
    const store = this;
    const after = this.#resetFloor(botId, since);
    const newest = (where: string): Iterable<Replayable> => ({
      *[Symbol.iterator]() {
        let before = Number.MAX_SAFE_INTEGER;
        for (;;) {
          const rows = store.#replayRows(botId, since, after, where, before, REPLAY_PAGE);
          for (const r of rows) if (!exclude.has(r.id)) yield { message: store.#toMessage(r), seq: Number(r.seq) };
          if (rows.length < REPLAY_PAGE) return;
          before = Number(rows.at(-1)!.seq);
        }
      },
    });
    return {
      chat: newest(CHAT_MESSAGE),
      routines: newest(ROUTINE_MESSAGE),
      pins: this.#replayRows(botId, since, after, PINNED_SQL, Number.MAX_SAFE_INTEGER, PIN_LIMIT + exclude.size)
        .filter((r) => !exclude.has(r.id))
        .slice(0, PIN_LIMIT)
        .map((r) => ({ message: this.#toMessage(r), seq: Number(r.seq) })),
    };
  }

  /**
   * The seq every message since the reset at `since` is after, found on messages_reset: resetContext adds its event
   * right after it sets the time, in one transaction, so every message before that event was written before it.
   * Reading only after it, the reads below stop at the reset instead of reading the whole chat before it to find
   * nothing newer. The `created_at > since` they keep decides as it always has; this only ends the read sooner. 0
   * (read from the start) with no reset, or none found for it.
   */
  #resetFloor(botId: string, since: string | null): number {
    if (!since) return 0;
    const r = this.#get(`select seq from messages where bot_id = ? and created_at >= ? and ${RESET_EVENT} order by created_at, seq limit 1`, botId, since);
    return r ? Number(r.seq) - 1 : 0;
  }

  /**
   * One page of a replay's messages after `after` and older than `before`, newest first, on the index whose
   * condition `where` is (messages_chat, messages_routine or messages_pinned).
   */
  #replayRows(botId: string, since: string | null, after: number, where: string, before: number, n: number): Row[] {
    return this.#all(
      `select * from messages where bot_id = ? and seq < ? and seq > ? and created_at > ?
         and ${NOT_STALE_SQL}
         and ${where}
       order by seq desc limit ?`,
      botId,
      before,
      after,
      since ?? '',
      n,
    );
  }

  /**
   * The replayable messages of this chat since the reset, oldest first: pins are only these. setMessagePinned keeps
   * them to PIN_LIMIT; one more is read, so a count past it would show rather than hide.
   */
  pinnedMessages(botId: string): Message[] {
    const since = this.contextSince(botId);
    return this.#replayRows(botId, since, this.#resetFloor(botId, since), PINNED_SQL, Number.MAX_SAFE_INTEGER, PIN_LIMIT + 1)
      .reverse()
      .map((r) => this.#toMessage(r));
  }

  /**
   * Pins one of the owner's or the Boton's messages, so every new session is given it whatever its age (a long one
   * as an excerpt, its start and end), or unpins it. Only the owner's route calls this: the pin is the server's mark
   * in the message's meta, never anything a message's text or a Boton can set. A chat holds at most PIN_LIMIT pins
   * since its reset, which the replay budget always has room for: one more is refused, not silently dropped later.
   */
  setMessagePinned(botId: string, messageId: string, pinned: boolean): Message {
    return this.atomically(() => {
      const r = this.#get('select * from messages where id = ? and bot_id = ?', messageId, botId);
      if (!r) throw new HttpError(404, `No message ${messageId} in this chat`);
      const m = this.#toMessage(r);
      // Checked before the pin already there counts: a mark no session is given is not a pin to confirm.
      if (pinned) {
        if (m.role !== 'user' && m.role !== 'bot') throw new HttpError(400, 'Only messages can be pinned, not events or errors');
        const since = this.contextSince(botId);
        if (Number(r.seq) <= this.#resetFloor(botId, since) || m.createdAt <= (since ?? '') || m.meta?.staleContext) {
          throw new HttpError(400, 'This message is from before the chat was started fresh, so no session is given it: send it again to keep it');
        }
      }
      if (!!m.meta?.pinned === pinned) return m;
      if (pinned && this.pinnedMessages(botId).length >= PIN_LIMIT) {
        throw new HttpError(409, `${PIN_LIMIT} messages are pinned already, as many as a new session has room for: unpin one first`);
      }
      if (pinned) this.#run('update messages set meta = ? where id = ?', JSON.stringify({ ...m.meta, pinned: { at: nowIso() } }), messageId);
      const updated = pinned ? this.#toMessage(this.#get('select * from messages where id = ?', messageId)!) : this.#unpin(r);
      this.#publish({ type: 'message.updated', message: updated });
      return updated;
    });
  }



  // ---------------------------------------------------------------- routines

  #toRoutine(r: Row): Routine {
    return {
      id: r.id,
      botId: r.bot_id,
      name: r.name,
      instruction: r.instruction,
      schedule: r.schedule ?? null,
      scheduleText: r.schedule ? describeSchedule(r.schedule, r.timezone) : null,
      timezone: r.timezone,
      webhook: r.webhook_key
        ? {
            url: `${this.#cfg.hooks.publicUrl ?? this.#cfg.publicUrl}/hooks/routines/${r.id}`,
            key: r.webhook_key,
            source: r.webhook_source as WebhookSource,
            hasSecret: !!r.webhook_secret,
            filter: r.webhook_filter ? (JSON.parse(r.webhook_filter) as WebhookFilter) : null,
            callbackUrl: r.callback_url ?? null,
          }
        : null,
      enabled: !!r.enabled,
      nextRunAt: r.enabled ? (r.next_run_at ?? null) : null,
      lastRunAt: r.last_run_at ?? null,
      lastStatus: (r.last_status as RunStatus) ?? null,
      notify: r.notify as NotifyPolicy,
      webhookWorkspace: r.webhook_workspace !== 0,
      skill: r.skill ?? null,
      model: r.model ?? null,
      effort: r.effort ?? null,
      session: r.session === 'own' ? 'own' : 'chat',
      webhookHistory: Number(r.webhook_history ?? 0),
      timeLimitMs: r.time_limit_ms ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listRoutines(botId: string): Routine[] {
    this.getBot(botId);
    return this.#all('select * from routines where bot_id = ? order by created_at', botId).map((r) => this.#toRoutine(r));
  }

  getRoutine(id: string): Routine {
    const r = this.#get('select * from routines where id = ?', id);
    if (!r) throw new HttpError(404, `No routine with id ${id}`);
    return this.#toRoutine(r);
  }

  #emitRoutine(id: string): Routine {
    const routine = this.getRoutine(id);
    this.#publish({ type: 'routine.upserted', routine });
    return routine;
  }

  #chip(routine: Routine, kind: MessageMeta['kind'], label: string) {
    this.addMessage(routine.botId, 'event', label, { kind, routineId: routine.id, routineName: routine.name });
  }

  #normalizeSchedule(schedule: string | null | undefined, tz: string): string | null {
    if (schedule === undefined || schedule === null || schedule.trim() === '' || schedule.trim().toLowerCase() === 'none') return null;
    try {
      return toSpec(parseSchedule(schedule, tz));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  /** The API checks a callback URL's host (ssrf.ts) before this: that takes a DNS lookup. */
  #hookSettings(input: CreateRoutineInput | UpdateRoutineInput) {
    const out: { source?: WebhookSource; secret?: string | null; filter?: string | null; callbackUrl?: string | null } = {};
    if (input.callbackUrl !== undefined) {
      if (input.callbackUrl !== null && typeof input.callbackUrl !== 'string') throw new HttpError(400, 'callbackUrl must be a URL or null');
      const url = (input.callbackUrl ?? '').trim();
      if (url.length > 2000) throw new HttpError(400, 'callbackUrl is too long (max 2000 characters)');
      out.callbackUrl = url || null;
    }
    if (input.webhookSource !== undefined) {
      if (!isWebhookSource(input.webhookSource)) throw new HttpError(400, `webhookSource must be one of ${WEBHOOK_SOURCES.map((s) => `"${s}"`).join(', ')}`);
      out.source = input.webhookSource;
    }
    if (input.webhookSecret !== undefined) {
      if (input.webhookSecret !== null && typeof input.webhookSecret !== 'string') throw new HttpError(400, 'webhookSecret must be a string or null');
      const secret = (input.webhookSecret ?? '').trim();
      if (secret.length > 500) throw new HttpError(400, 'webhookSecret is too long (max 500 characters)');
      out.secret = secret || null;
    }
    if (input.webhookFilter !== undefined) {
      try {
        const filter = parseFilter(input.webhookFilter);
        out.filter = filter ? JSON.stringify(filter) : null;
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    return out;
  }

  createRoutine(botId: string, input: CreateRoutineInput, opts: { chip?: boolean } = {}): Routine {
    const bot = this.getBot(botId);
    // Spent one-offs (their time has passed and they have no webhook) don't count.
    const count = this.#get(
      "select count(*) as n from routines where bot_id = ? and not (schedule is not null and schedule like 'once %' and substr(schedule, 6) <= ? and webhook_key is null)",
      botId,
      nowIso(),
    )!.n as number;
    if (count >= MAX_ROUTINES_PER_BOT) throw new HttpError(400, `A Boton can own at most ${MAX_ROUTINES_PER_BOT} routines`);
    const name = clean(input.name, 'name', 80, true);
    const instruction = clean(input.instruction, 'instruction', 20_000, true);
    const tz = input.timezone ?? bot.timezone;
    if (!isValidTimezone(tz)) throw new HttpError(400, `Unknown timezone ${tz}`);
    const schedule = this.#normalizeSchedule(input.schedule, tz);
    const notify = input.notify === undefined ? 'auto' : notifyPolicy(input.notify);
    const webhookWorkspace = flag(input.webhookWorkspace, 'webhookWorkspace', true);
    const hook = input.webhook ? this.#hookSettings(input) : {};
    if (!input.webhook && input.callbackUrl) throw new HttpError(400, 'A callbackUrl needs a webhook: its key signs the results');
    const skill = skillName(input.skill);
    const model = input.model === undefined ? null : routineModel(input.model);
    const effort = input.effort === undefined ? null : routineEffort(input.effort, bot.provider, this.effortCaps(bot.provider, model || bot.model));
    const inherited = effort === null && model ? inheritedEffortProblem(bot.provider, bot.effort, this.effortCaps(bot.provider, model)) : null;
    if (inherited) throw new HttpError(400, inherited);
    // A webhook's runs share the chat (what the owner said in it) only when asked to: their payloads come from outside.
    const session = input.session === undefined ? (input.webhook ? 'own' : 'chat') : routineSession(input.session);
    const history = input.webhookHistory === undefined ? 0 : webhookHistory(input.webhookHistory);
    const timeLimit = input.timeLimitMs === undefined ? null : timeLimitMs(input.timeLimitMs, this.#cfg.turnTimeoutMs);
    const id = newId('rt');
    const now = nowIso();
    const enabled = input.enabled === false ? 0 : 1;
    const next = schedule ? (nextRun(schedule, tz, new Date())?.toISOString() ?? null) : null;
    this.#run(
      `insert into routines (id, bot_id, name, instruction, schedule, timezone, webhook_key, enabled, next_run_at, notify, webhook_workspace,
         webhook_source, webhook_secret, webhook_filter, callback_url, skill, model, effort, session, webhook_history, time_limit_ms, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      botId,
      name,
      instruction,
      schedule,
      tz,
      input.webhook ? newSecret() : null,
      enabled,
      next,
      notify,
      webhookWorkspace ? 1 : 0,
      hook.source ?? 'generic',
      hook.secret ?? null,
      hook.filter ?? null,
      hook.callbackUrl ?? null,
      skill,
      model,
      effort,
      session,
      history,
      timeLimit,
      now,
      now,
    );
    const routine = this.#emitRoutine(id);
    if (opts.chip !== false) this.#chip(routine, 'routine.created', 'Created routine');
    return routine;
  }

  resetRoutineModels(botId: string): Routine[] {
    const had = this.listRoutines(botId).filter((r) => r.model);
    for (const r of had) {
      this.#run('update routines set model = null, updated_at = ? where id = ?', nowIso(), r.id);
      this.#emitRoutine(r.id);
    }
    return had;
  }

  /**
   * Clears each routine's own effort that the Boton's provider, or the model the routine runs, doesn't have; returns
   * them as they were.
   */
  resetRoutineEfforts(botId: string): Routine[] {
    const { provider, model } = this.getBot(botId);
    const had = this.listRoutines(botId).filter((r) => r.effort && effortProblem(provider, r.effort, this.effortCaps(provider, r.model || model)));
    for (const r of had) {
      this.#run('update routines set effort = null, updated_at = ? where id = ?', nowIso(), r.id);
      this.#emitRoutine(r.id);
    }
    return had;
  }

  /**
   * `opts.starterActivation` only from the owner's activation (starter-gate.ts), which has checked its test run or
   * been told to override: every other caller, whoever it is for, can't turn a starter's routine on.
   */
  updateRoutine(id: string, input: UpdateRoutineInput, opts: { starterActivation?: true } = {}): Routine {
    const before = this.getRoutine(id);
    const row = this.#get('select * from routines where id = ?', id)!;
    const sets: string[] = [];
    const vals: any[] = [];
    const set = (col: string, v: any) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (input.name !== undefined) set('name', clean(input.name, 'name', 80, true));
    if (input.instruction !== undefined) set('instruction', clean(input.instruction, 'instruction', 20_000, true));
    const tz = input.timezone ?? before.timezone;
    if (input.timezone !== undefined) {
      if (!isValidTimezone(tz)) throw new HttpError(400, `Unknown timezone ${tz}`);
      set('timezone', tz);
    }
    let schedule: string | null = row.schedule;
    if (input.schedule !== undefined) set('schedule', (schedule = this.#normalizeSchedule(input.schedule, tz)));
    // A retired one-off comes back with a new schedule, unless this update pauses it.
    const retired = !before.enabled && isPastOneOff(before.schedule);
    const enabled = input.enabled ?? (retired && input.schedule !== undefined ? true : before.enabled);
    const willHaveWebhook = input.webhook ?? !!row.webhook_key;
    if (enabled && !before.enabled && isPastOneOff(schedule) && !willHaveWebhook) {
      throw new HttpError(400, 'This one-off routine already ran (or its time passed). Give it a new time to run it again.');
    }
    // Any way it would come on (asked for, or a retired one-off given a new time) waits on the owner while it's a starter's.
    if (enabled && !before.enabled && !opts.starterActivation && this.starterPending(id)) {
      const owner = this.getSettings().ownerName;
      throw new HttpError(
        409,
        `“${before.name}” came with a starter and waits on ${owner}: only ${owner} turns it on, from its setup check, after a test run of its current settings passes (or by overriding that).`,
      );
    }
    if (input.enabled !== undefined || enabled !== before.enabled) set('enabled', enabled ? 1 : 0);
    if (input.schedule !== undefined || input.timezone !== undefined || (enabled && !before.enabled)) {
      set('next_run_at', schedule ? (nextRun(schedule, tz, new Date())?.toISOString() ?? null) : null);
    }
    if (input.webhook === true && (!row.webhook_key || input.rotateKey)) set('webhook_key', newSecret());
    else if (input.webhook === undefined && input.rotateKey && row.webhook_key) set('webhook_key', newSecret());
    if (input.webhook === false) {
      set('webhook_key', null);
      set('webhook_source', 'generic');
      set('webhook_secret', null);
      set('webhook_filter', null);
      set('callback_url', null);
    } else {
      const hook = this.#hookSettings(input);
      if (hook.callbackUrl && !willHaveWebhook) throw new HttpError(400, 'A callbackUrl needs a webhook: its key signs the results');
      if (willHaveWebhook) {
        if (hook.source !== undefined) set('webhook_source', hook.source);
        if (hook.secret !== undefined) set('webhook_secret', hook.secret);
        if (hook.filter !== undefined) set('webhook_filter', hook.filter);
        if (hook.callbackUrl !== undefined) set('callback_url', hook.callbackUrl);
      }
    }
    if (input.notify !== undefined) set('notify', notifyPolicy(input.notify));
    if (input.webhookWorkspace !== undefined) set('webhook_workspace', flag(input.webhookWorkspace, 'webhookWorkspace') ? 1 : 0);
    if (input.skill !== undefined) set('skill', skillName(input.skill));
    if (input.model !== undefined || input.effort !== undefined) {
      const bot = this.getBot(before.botId);
      const model = input.model !== undefined ? routineModel(input.model) : before.model;
      let effort = input.effort !== undefined ? routineEffort(input.effort, bot.provider, null) : before.effort;
      // Checked against the model when either changes: the editor sends both back with every save, and a level that
      // stopped fitting after the Boton changed must not block other changes (its runs then ask for none; see turnEffort).
      if (model !== before.model || effort !== before.effort) {
        effort = routineEffort(effort, bot.provider, this.effortCaps(bot.provider, model || bot.model));
        const inherited = effort === null && model ? inheritedEffortProblem(bot.provider, bot.effort, this.effortCaps(bot.provider, model)) : null;
        if (inherited) throw new HttpError(400, inherited);
      }
      if (input.model !== undefined) set('model', model);
      if (input.effort !== undefined) set('effort', effort);
    }
    if (input.session !== undefined) {
      const session = routineSession(input.session);
      set('session', session);
      if (session !== before.session) {
        set('session_id', null);
        set('session_key', null);
      }
    }
    if (input.webhookHistory !== undefined) set('webhook_history', webhookHistory(input.webhookHistory));
    if (input.timeLimitMs !== undefined) set('time_limit_ms', timeLimitMs(input.timeLimitMs, this.#cfg.turnTimeoutMs));
    if (!sets.length) return before;
    set('updated_at', nowIso());
    this.#run(`update routines set ${sets.join(', ')} where id = ?`, ...vals, id);
    const routine = this.#emitRoutine(id);

    const onlyToggle = Object.keys(input).every((k) => k === 'enabled');
    if (onlyToggle && input.enabled === false && before.enabled) this.#chip(routine, 'routine.paused', 'Paused routine');
    else if (onlyToggle && input.enabled === true && !before.enabled) this.#chip(routine, 'routine.resumed', 'Resumed routine');
    else if (!onlyToggle) this.#chip(routine, 'routine.updated', 'Updated routine');
    return routine;
  }

  deleteRoutine(id: string): void {
    const routine = this.getRoutine(id);
    this.#failActiveRuns('routine_id', id, 'Routine was deleted');
    this.#run('delete from routines where id = ?', id);
    const starter = this.starterRecord(routine.botId);
    if (starter) this.saveStarterRecord(routine.botId, { ...starter, pending: starter.pending.filter((x) => x !== id), tests: starter.tests.filter((t) => t.routineId !== id) });
    this.#publish({ type: 'routine.deleted', routineId: id, botId: routine.botId });
    this.#chip(routine, 'routine.deleted', 'Deleted routine');
  }

  // ----------------------------------------------------------- starters
  // A Boton installed from a starter: a settings row (starterKey), so it needs no table of its own. Written only by the
  // server (the install, the owner's activation, the engine noting a test run's settings), never from a request body.

  /** What the server saved when `botId` was installed from a starter, or null. A row it can't read holds every routine. */
  starterRecord(botId: string): StarterRecord | null {
    const raw = this.#get('select value from settings where key = ?', starterKey(botId))?.value;
    if (raw === undefined) return null;
    const v = parseJson<Partial<StarterRecord> | null>(raw, null);
    const ok = v && typeof v.templateId === 'string' && Array.isArray(v.pending) && v.pending.every((x) => typeof x === 'string');
    if (!ok) {
      // Never on by accident: every routine of it waits on the owner, who can still override.
      const all = this.#all('select id from routines where bot_id = ?', botId).map((r) => String(r.id));
      return { templateId: typeof v?.templateId === 'string' ? v.templateId : '', templateName: '', version: 0, slots: {}, installedAt: '', pending: all, tests: [] };
    }
    return {
      templateId: v.templateId!,
      templateName: typeof v.templateName === 'string' ? v.templateName : v.templateId!,
      version: typeof v.version === 'number' ? v.version : 0,
      slots: v.slots && typeof v.slots === 'object' ? Object.fromEntries(Object.entries(v.slots).map(([k, x]) => [k, typeof x === 'string' ? x : null])) : {},
      installedAt: typeof v.installedAt === 'string' ? v.installedAt : '',
      pending: v.pending!,
      tests: Array.isArray(v.tests) ? v.tests.filter((t) => t && typeof t.runId === 'string' && typeof t.routineId === 'string') : [],
    };
  }

  saveStarterRecord(botId: string, record: StarterRecord): void {
    this.#run('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value', starterKey(botId), JSON.stringify(record));
  }

  /** Whether routine `id` came with a starter and still waits on the owner's decision to turn it on. */
  starterPending(id: string): boolean {
    const botId = this.routineOwner(id);
    return !!botId && !!this.starterRecord(botId)?.pending.includes(id);
  }

  /**
   * The key the starter checks' hashes are made with (starter-gate.ts), made on first use and kept with the data: so a
   * hash a client sees says nothing about the secrets folded into it.
   */
  starterSecret(): string {
    const have = this.#get("select value from settings where key = 'starterSecret'")?.value;
    if (typeof have === 'string' && have) return have;
    this.#run("insert into settings(key, value) values ('starterSecret', ?) on conflict(key) do nothing", newSecret());
    return String(this.#get("select value from settings where key = 'starterSecret'")!.value);
  }

  dueRoutines(now: Date): Routine[] {
    return this.#all(
      'select * from routines where enabled = 1 and next_run_at is not null and next_run_at <= ? order by next_run_at',
      now.toISOString(),
    ).map((r) => this.#toRoutine(r));
  }

  setNextRun(id: string, next: Date | null): void {
    this.#run('update routines set next_run_at = ? where id = ?', next?.toISOString() ?? null, id);
    this.#emitRoutine(id);
  }

  retireOneOff(id: string): void {
    this.#run(
      `update routines set next_run_at = null,
         enabled = case when webhook_key is null then 0 else enabled end,
         schedule = case when webhook_key is null then schedule else null end
       where id = ?`,
      id,
    );
    this.#emitRoutine(id);
  }

  findRoutineName(id: string): string | null {
    return (this.#get('select name from routines where id = ?', id)?.name as string | undefined) ?? null;
  }

  routineOwner(id: string): string | null {
    return (this.#get('select bot_id from routines where id = ?', id)?.bot_id as string | undefined) ?? null;
  }

  webhookSecrets(id: string): HookSecrets | null {
    const r = this.#get('select webhook_key, webhook_secret from routines where id = ?', id);
    return r?.webhook_key ? { key: r.webhook_key, secret: r.webhook_secret ?? null } : null;
  }

  callbackTarget(routineId: string): { url: string; key: string } | null {
    const r = this.#get('select callback_url, webhook_key from routines where id = ?', routineId);
    return r?.callback_url && r.webhook_key ? { url: r.callback_url, key: r.webhook_key } : null;
  }

  setRunCallback(id: string, delivery: CallbackDelivery): RoutineRun | null {
    const run = this.findRun(id);
    if (!run) return null;
    const meta: RunMeta = { ...run.meta, callback: delivery };
    this.#run('update routine_runs set meta = ? where id = ?', JSON.stringify(meta), id);
    return this.#emitRun(id);
  }

  findDelivery(routineId: string, deliveryId: string): string | null {
    const since = new Date(Date.now() - DELIVERY_TTL_MS).toISOString();
    return (this.#get('select run_id from webhook_deliveries where routine_id = ? and delivery_id = ? and created_at > ?', routineId, deliveryId, since)?.run_id as string | undefined) ?? null;
  }

  recordDelivery(routineId: string, deliveryId: string, runId: string): void {
    this.#run('delete from webhook_deliveries where created_at <= ?', new Date(Date.now() - DELIVERY_TTL_MS).toISOString());
    this.#run(
      'insert into webhook_deliveries (routine_id, delivery_id, run_id, created_at) values (?, ?, ?, ?) on conflict(routine_id, delivery_id) do update set run_id = excluded.run_id, created_at = excluded.created_at',
      routineId,
      deliveryId,
      runId,
      nowIso(),
    );
  }

  /** Its routines that keep a session of their own and have one now. */
  routineSessions(botId: string): { id: string; name: string; sessionKey: string | null }[] {
    return this.#all("select id, name, session_key from routines where bot_id = ? and session = 'own' and session_id is not null order by created_at, id", botId).map((r) => ({
      id: r.id,
      name: r.name,
      sessionKey: r.session_key ?? null,
    }));
  }

  /** Its runs queued or running now, oldest first, and its scheduled runs due before `until`, soonest first. */
  activeRuns(botId: string, until: Date, limit: number): { runs: ProviderHandoff['runs']; dueSoon: ProviderHandoff['dueSoon'] } {
    const runs = this.#all(
      `select rr.routine_id, rr.status, r.name from routine_runs rr join routines r on r.id = rr.routine_id
       where rr.bot_id = ? and rr.status in ('queued', 'running') order by rr.started_at, rr.rowid limit ?`,
      botId,
      limit,
    ).map((r) => ({ routineId: r.routine_id, routineName: r.name, status: r.status as 'queued' | 'running' }));
    const dueSoon = this.#all(
      'select id, name, next_run_at from routines where bot_id = ? and enabled = 1 and next_run_at is not null and next_run_at <= ? order by next_run_at, id limit ?',
      botId,
      until.toISOString(),
      limit,
    ).map((r) => ({ routineId: r.id, routineName: r.name, at: r.next_run_at }));
    return { runs, dueSoon };
  }

  /**
   * The latest provider switch since the conversation was last reset, while no turn has run on the new provider's
   * chat session since: the first such turn starts with its handoff note.
   */
  pendingHandoff(botId: string, since: string | null): (Message & { meta: MessageMeta & { handoff: ProviderHandoff } }) | null {
    const r = this.#get(
      `select * from messages where bot_id = ? and created_at > ? and role = 'event' and json_extract(${MESSAGE_META}, '$.kind') = 'provider.switched'
       order by seq desc limit 1`,
      botId,
      since ?? '',
    );
    if (!r) return null;
    const m = this.#toMessage(r);
    return m.meta?.handoff && !m.meta.handoffDone ? (m as Message & { meta: MessageMeta & { handoff: ProviderHandoff } }) : null;
  }

  /** The summary a handoff names (Message.meta.handoff.summary), if it is still the Boton's. */
  handoffSummary(botId: string, messageId: string): Message | null {
    const r = this.#get(`select * from messages where id = ? and bot_id = ? and role = 'bot' and json_extract(${MESSAGE_META}, '$.kind') = 'provider.summary'`, messageId, botId);
    return r ? this.#toMessage(r) : null;
  }

  /**
   * The note is not given again (`pendingHandoff` no longer returns it). With `generation`, only while that switch is
   * still the Boton's latest: a turn from before a later switch can't mark that one's note done.
   */
  endHandoff(messageId: string, generation?: number): boolean {
    const r =
      generation === undefined
        ? this.#run("update messages set meta = json_set(meta, '$.handoffDone', json('true')) where id = ?", messageId)
        : this.#run(
            `update messages set meta = json_set(meta, '$.handoffDone', json('true')) where id = ? and seq = ? and ${generationSql('messages.bot_id')} = ?`,
            messageId,
            generation,
            generation,
          );
    return Number(r.changes) > 0;
  }

  /** Ends the routine's own saved session: its next run starts a new one. */
  dropRoutineSession(id: string): void {
    this.#run('update routines set session_id = null, session_key = null where id = ?', id);
  }

  routineSession(id: string): { sessionId: string | null; sessionKey: string | null } {
    const r = this.#get('select session_id, session_key from routines where id = ?', id);
    return { sessionId: r?.session_id ?? null, sessionKey: r?.session_key ?? null };
  }

  /** Not saved if the routine went back to the chat's session since the run read the Boton, nor (as setSession) if the Boton changed since. */
  setRoutineSession(id: string, sessionId: string | null, sessionKey: string | null, at: TurnStamp): boolean {
    const bot = this.#get('select bot_id from routines where id = ?', id)?.bot_id ?? null;
    const r = this.#run(
      `update routines set session_id = ?, session_key = ?
       where id = ? and session = 'own' and bot_id = ?
       and (select context_since from bots where bots.id = routines.bot_id) is ?
       and (select provider from bots where bots.id = routines.bot_id) = ? and ${GENERATION_SQL} = ?`,
      sessionId,
      sessionKey,
      id,
      bot,
      at.contextSince,
      at.provider,
      bot,
      at.generation,
    );
    return Number(r.changes) > 0;
  }

  /** Each routine's latest run first, so one that runs every few minutes can't push the others' results out. */
  ownSessionResults(botId: string, limit = 3): (RoutineRun & { routineName: string })[] {
    return this.#all(
      `select * from (
         select r.*, t.name as routine_name,
           substr(r.payload, 1, ${PAYLOAD_PREVIEW_BYTES}) as payload_preview, coalesce(length(cast(r.payload as blob)), 0) as payload_bytes,
           row_number() over (partition by r.routine_id order by r.finished_at desc, r.seq desc) as nth
         from routine_runs r join routines t on t.id = r.routine_id
         where t.bot_id = ? and t.session = 'own' and r.status in ('succeeded', 'failed') and r.finished_at is not null
         order by nth = 1 desc, r.finished_at desc, r.seq desc limit ?
       ) order by finished_at desc, seq desc`,
      botId,
      limit,
    ).map((r) => ({ ...this.#toRun(r), routineName: r.routine_name as string }));
  }

  // -------------------------------------------------------------------- runs

  #toRun(r: Row): RoutineRun {
    return {
      id: r.id,
      routineId: r.routine_id,
      botId: r.bot_id,
      trigger: r.trigger as RunTrigger,
      status: r.status as RunStatus,
      error: r.error ?? null,
      payloadPreview: r.payload_preview == null ? null : utf8Prefix(r.payload_preview, PAYLOAD_PREVIEW_BYTES),
      payloadBytes: Number(r.payload_bytes),
      headers: r.headers ? (JSON.parse(r.headers) as Record<string, string>) : null,
      reply: r.reply ?? null,
      quiet: !!r.quiet,
      meta: r.meta ? (JSON.parse(r.meta) as RunMeta) : null,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? null,
      attempts: Number(r.attempts),
      lastError: r.last_error ?? null,
      retryAt: r.retry_at ?? null,
      ...this.#runTurns(r.id),
    };
  }

  #runTurns(runId: string): Pick<RoutineRun, 'usage' | 'model' | 'steps'> {
    const t = this.#get(
      `select count(*) as n, sum(input_tokens) as input, sum(output_tokens) as output, sum(cache_read_tokens) as cache_read,
         sum(cache_write_tokens) as cache_write, sum(cost_usd) as cost, sum(step_count) as steps,
         (select coalesce(model, nullif(requested_model, '')) from turns where run_id = ? order by started_at desc, rowid desc limit 1) as model
       from turns where run_id = ?`,
      runId,
      runId,
    )!;
    if (!Number(t.n)) return { usage: null, model: null, steps: 0 };
    const usage: TokenUsage = {
      inputTokens: Number(t.input ?? 0),
      outputTokens: Number(t.output ?? 0),
      cacheReadTokens: Number(t.cache_read ?? 0),
      cacheWriteTokens: Number(t.cache_write ?? 0),
      ...(t.cost ? { costUsd: Number(t.cost) } : {}),
    };
    return { usage: totalTokens(usage) ? usage : null, model: (t.model as string | null) ?? null, steps: Number(t.steps ?? 0) };
  }

  createRun(routine: Routine, trigger: RunTrigger, payload: string | null, headers: Record<string, string> | null = null): RoutineRun {
    const id = newId('run');
    const now = nowIso();
    this.#run(
      `insert into routine_runs (id, routine_id, bot_id, trigger, status, payload, headers, started_at) values (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id,
      routine.id,
      routine.botId,
      trigger,
      payload,
      headers ? JSON.stringify(headers) : null,
      now,
    );
    if (trigger !== 'test') {
      this.#run("update routines set last_run_at = ?, last_status = 'queued' where id = ?", now, routine.id);
      this.#emitRoutine(routine.id);
    }
    return this.#emitRun(id);
  }

  /** A new queued run with a failed one's trigger, payload and headers; each run is retried at most once. */
  createRetryRun(failed: RoutineRun): RoutineRun {
    if (failed.status !== 'failed') throw new HttpError(409, `Only a failed run can be retried; this one is ${failed.status}`);
    if (failed.meta?.retriedAs) throw new HttpError(409, `This run was already retried as ${failed.meta.retriedAs}`);
    const routine = this.getRoutine(failed.routineId);
    const id = newId('run');
    const now = nowIso();
    const meta: RunMeta = { retryOf: { runId: failed.id, error: failed.error } };
    return this.atomically(() => {
      // Claims the failed run first, so two retries at once start one run.
      const claimed = this.#run(
        "update routine_runs set meta = json_set(coalesce(meta, '{}'), '$.retriedAs', ?) where id = ? and status = 'failed' and json_extract(coalesce(meta, '{}'), '$.retriedAs') is null",
        id,
        failed.id,
      );
      if (!Number(claimed.changes)) throw new HttpError(409, 'This run was already retried');
      this.#run(
        `insert into routine_runs (id, routine_id, bot_id, trigger, status, payload, headers, meta, started_at)
         select ?, routine_id, bot_id, trigger, 'queued', payload, headers, ?, ? from routine_runs where id = ?`,
        id,
        JSON.stringify(meta),
        now,
        failed.id,
      );
      // Delivery lookup must survive pruning of the original run and of retry ancestors.
      // Preserve created_at so an owner retry does not extend the dedupe window.
      this.#run('update webhook_deliveries set run_id = ? where routine_id = ? and run_id = ?', id, routine.id, failed.id);
      if (failed.trigger !== 'test') {
        this.#run("update routines set last_run_at = ?, last_status = 'queued' where id = ?", now, routine.id);
        this.#emitRoutine(routine.id);
      }
      this.#emitRun(failed.id);
      return this.#emitRun(id);
    });
  }

  /** The run a delivery ends at: a failed run's retry, and that one's, while they exist. */
  latestRetry(run: RoutineRun): RoutineRun {
    let at = run;
    for (let hops = 0; hops < RUN_HISTORY && at.meta?.retriedAs; hops++) {
      const next = this.findRun(at.meta.retriedAs);
      if (!next) break;
      at = next;
    }
    return at;
  }

  recordSkippedRun(routine: Routine, trigger: RunTrigger, reason: string): RoutineRun {
    const id = newId('run');
    const now = nowIso();
    this.#run(
      `insert into routine_runs (id, routine_id, bot_id, trigger, status, error, started_at, finished_at) values (?, ?, ?, ?, 'skipped', ?, ?, ?)`,
      id,
      routine.id,
      routine.botId,
      trigger,
      reason,
      now,
      now,
    );
    this.#run(
      `delete from routine_runs
       where routine_id = ? and status = 'skipped'
         and seq not in (select seq from routine_runs where routine_id = ? and status = 'skipped' order by seq desc limit ?)`,
      routine.id,
      routine.id,
      SKIP_HISTORY,
    );
    return this.#emitRun(id);
  }

  activeRunCount(routineId: string): number {
    return Number(this.#get("select count(*) as n from routine_runs where routine_id = ? and status in ('queued', 'running')", routineId)!.n);
  }

  queuedRunCount(routineId: string): number {
    return Number(this.#get("select count(*) as n from routine_runs where routine_id = ? and status = 'queued'", routineId)!.n);
  }

  findRun(id: string): RoutineRun | null {
    const r = this.#get(`select ${RUN_COLUMNS} from routine_runs where id = ?`, id);
    return r ? this.#toRun(r) : null;
  }

  findRunRecord(id: string): RunRecord | null {
    const run = this.findRun(id);
    if (!run) return null;
    const payload = (this.#get('select payload from routine_runs where id = ?', id)?.payload as string | null | undefined) ?? null;
    return { ...run, payload };
  }

  runPayload(id: string): RunPayload {
    const run = this.findRunRecord(id);
    if (!run) throw new HttpError(404, `No run with id ${id}`);
    return { runId: run.id, payload: run.payload, headers: run.headers, bytes: run.payloadBytes };
  }

  runOwner(id: string): string | null {
    return (this.#get('select bot_id from routine_runs where id = ?', id)?.bot_id as string | undefined) ?? null;
  }

  getRun(id: string): RoutineRun {
    const run = this.findRun(id);
    if (!run) throw new HttpError(404, `No run with id ${id}`);
    return run;
  }

  #emitRun(id: string): RoutineRun {
    const run = this.getRun(id);
    this.#publish({ type: 'run.upserted', run });
    return run;
  }

  /** A run that finishes also records its callback as pending, in the same transaction, so no crash can lose it. */
  updateRun(
    id: string,
    patch: { status: RunStatus; error?: string | null; reply?: string | null; quiet?: boolean; cancelled?: { started: boolean }; timedOut?: { limitMs: number } },
  ): RoutineRun {
    return this.atomically(() => {
      const finished = patch.status === 'succeeded' || patch.status === 'failed' ? nowIso() : null;
      this.#run(
        `update routine_runs set status = ?, error = coalesce(?, error), reply = coalesce(?, reply), quiet = coalesce(?, quiet), finished_at = ? where id = ?`,
        patch.status,
        patch.error ?? null,
        patch.reply ?? null,
        patch.quiet === undefined ? null : patch.quiet ? 1 : 0,
        finished,
        id,
      );
      // In the same write as the failure, so a restart never shows a cancelled run as one that needs the owner.
      if (patch.cancelled) {
        const cancelled: NonNullable<RunMeta['cancelled']> = { at: finished ?? nowIso(), started: patch.cancelled.started };
        this.#run("update routine_runs set meta = json_set(coalesce(meta, '{}'), '$.cancelled', json(?)) where id = ?", JSON.stringify(cancelled), id);
      }
      // In the same write too, so its callback says why it failed.
      if (patch.timedOut) {
        const timedOut: NonNullable<RunMeta['timedOut']> = { at: finished ?? nowIso(), limitMs: patch.timedOut.limitMs };
        this.#run("update routine_runs set meta = json_set(coalesce(meta, '{}'), '$.timedOut', json(?)) where id = ?", JSON.stringify(timedOut), id);
      }
      const run = this.getRun(id);
      if (finished) {
        this.#owePendingCallback(run);
        this.#pruneRuns(run.routineId, id);
      }
      this.#setLastStatus(run, patch.status);
      return this.#emitRun(id);
    });
  }

  /**
   * Records a just-finished run's callback as owed: pending, which Callbacks sends (on this write's run.upserted, or at
   * the next start), or not sent when the routine already has PENDING_CALLBACK_LIMIT waiting. Not for test runs.
   */
  #owePendingCallback(run: RoutineRun): void {
    if (run.trigger === 'test' || run.meta?.callback) return;
    const r = this.#get('select callback_url, webhook_key from routines where id = ?', run.routineId);
    if (!r?.callback_url || !r.webhook_key) return;
    const waiting = this.pendingCallbackCount(run.routineId);
    const delivery: CallbackDelivery =
      waiting >= PENDING_CALLBACK_LIMIT
        ? { url: r.callback_url, ok: false, status: null, error: `Not sent: ${waiting} earlier results were still waiting for the callback URL`, attempts: 0, at: nowIso() }
        : { url: r.callback_url, ok: false, status: null, error: null, attempts: 0, at: nowIso(), pending: true };
    if (!delivery.pending) log.warn('callback not sent: too many results waiting for the callback URL', { runId: run.id, routineId: run.routineId, waiting });
    const meta: RunMeta = { ...run.meta, callback: delivery };
    this.#run('update routine_runs set meta = ? where id = ?', JSON.stringify(meta), run.id);
  }

  pendingCallbackCount(routineId: string): number {
    return Number(this.#get("select count(*) as n from routine_runs where routine_id = ? and json_extract(meta, '$.callback.pending') = 1", routineId)!.n);
  }

  #setLastStatus(run: RoutineRun, status: RunStatus) {
    if (run.trigger === 'test' || !this.#get('select 1 from routines where id = ?', run.routineId)) return;
    this.#run('update routines set last_status = ? where id = ?', status, run.routineId);
    this.#emitRoutine(run.routineId);
  }

  addRunDelivery(id: string, delivery: NotifyDelivery): RoutineRun | null {
    const run = this.findRun(id);
    if (!run) return null;
    const meta: RunMeta = { ...run.meta, notifications: [...(run.meta?.notifications ?? []), delivery] };
    this.#run('update routine_runs set meta = ? where id = ?', JSON.stringify(meta), id);
    return this.#emitRun(id);
  }

  startRun(id: string): RoutineRun {
    this.#run("update routine_runs set status = 'running', started_at = ?, attempts = attempts + 1, retry_at = null, held_for = null where id = ?", nowIso(), id);
    return this.#runChanged(id, 'running');
  }

  holdRun(id: string, retryAt: Date, lastError: string, heldFor: HeldFor): RoutineRun {
    this.#run(
      "update routine_runs set status = 'queued', retry_at = ?, last_error = ?, held_for = ?, finished_at = null where id = ?",
      retryAt.toISOString(),
      lastError.slice(0, 2000),
      heldFor,
      id,
    );
    return this.#runChanged(id, 'queued');
  }

  releaseUsageLimitHolds(botId: string): void {
    const ids = this.#all("select id from routine_runs where bot_id = ? and status = 'queued' and held_for = 'usage_limit' and retry_at is not null", botId).map((r) => r.id as string);
    for (const id of ids) {
      this.#run('update routine_runs set retry_at = null where id = ?', id);
      this.#emitRun(id);
    }
  }

  runHeldFor(id: string): HeldFor | null {
    return (this.#get('select held_for from routine_runs where id = ?', id)?.held_for as HeldFor | null | undefined) ?? null;
  }

  #runChanged(id: string, status: RunStatus): RoutineRun {
    this.#setLastStatus(this.getRun(id), status);
    return this.#emitRun(id);
  }

  /**
   * Never queued or running runs: callers hold their ids (a webhook's 202 runId) and the engine still has to run them.
   * Nor runs whose callback is pending, which still have to be sent (at most PENDING_CALLBACK_LIMIT per routine); once
   * sent or failed, a later finish prunes them.
   */
  #pruneRuns(routineId: string, keepId: string) {
    this.#run(
      `delete from routine_runs
       where routine_id = ? and id != ? and status in ('succeeded', 'failed')
         and coalesce(json_extract(meta, '$.callback.pending'), 0) = 0
         and seq not in (select seq from routine_runs where routine_id = ? and status in ('succeeded', 'failed') order by seq desc limit ?)`,
      routineId,
      keepId,
      routineId,
      RUN_HISTORY,
    );
  }

  /** Before a delete: webhook waiters and clients see each run end before the cascade removes its row. */
  #failActiveRuns(column: 'routine_id' | 'bot_id', id: string, error: string) {
    const rows = this.#all(`select id from routine_runs where ${column} = ? and status in ('queued', 'running')`, id);
    if (!rows.length) return;
    this.atomically(() => {
      this.#run(
        `update routine_runs set status = 'failed', error = ?, finished_at = ? where ${column} = ? and status in ('queued', 'running')`,
        error,
        nowIso(),
        id,
      );
      for (const r of rows) {
        this.#owePendingCallback(this.getRun(r.id));
        this.#emitRun(r.id);
      }
    });
  }

  listRuns(routineId: string): RoutineRun[] {
    this.getRoutine(routineId);
    return this.#all(`select ${RUN_COLUMNS} from routine_runs where routine_id = ? order by seq desc`, routineId).map((r) => this.#toRun(r));
  }

  /** Failed runs not yet retried (since `since`, not test runs nor runs the owner cancelled), and queued runs held to try again later. */
  attentionRuns(since: string, limit = ATTENTION_LIMIT): RunsAttention {
    const select = `select ${RUN_COLUMNS}, (select name from bots b where b.id = r.bot_id) as bot_name,
      (select name from routines t where t.id = r.routine_id) as routine_name from routine_runs r`;
    const named = (r: Row): AttentionRun => ({ ...this.#toRun(r), botName: r.bot_name as string, routineName: r.routine_name as string });
    const failed = this.#all(
      `${select} where status = 'failed' and trigger != 'test' and finished_at >= ?
         and json_extract(coalesce(meta, '{}'), '$.retriedAs') is null
         and json_extract(coalesce(meta, '{}'), '$.cancelled') is null
       order by finished_at desc, seq desc limit ?`,
      since,
      limit,
    ).map(named);
    const held = this.#all(`${select} where status = 'queued' and trigger != 'test' and retry_at is not null order by retry_at, seq limit ?`, limit).map(named);
    // Only while the routine still has a callback URL: without one there is nothing to resend.
    const callbacks = this.#all(
      `${select} where trigger != 'test' and finished_at >= ?
         and json_extract(meta, '$.callback.ok') = 0 and coalesce(json_extract(meta, '$.callback.pending'), 0) = 0
         and (select callback_url from routines t where t.id = r.routine_id) is not null
       order by finished_at desc, seq desc limit ?`,
      since,
      limit,
    ).map(named);
    return { since, failed, held, callbacks };
  }

  /** Finished runs whose callback was being sent when the server last stopped. */
  pendingCallbackRuns(): RoutineRun[] {
    return this.#all(`select ${RUN_COLUMNS} from routine_runs where json_extract(meta, '$.callback.pending') = 1 order by seq`).map((r) => this.#toRun(r));
  }

  failInterruptedRuns(): RoutineRun[] {
    const rows = this.#all(
      "select r.id, r.bot_id, r.routine_id, t.name from routine_runs r left join routines t on t.id = r.routine_id where r.status = 'running' order by r.seq",
    );
    return rows.map((r) => {
      const run = this.updateRun(r.id, { status: 'failed', error: 'Interrupted by a restart' });
      const name = (r.name as string | null) ?? 'routine';
      this.addMessage(r.bot_id, 'event', ...runChip(run, name));
      this.addMessage(r.bot_id, 'error', `Routine “${name}” was interrupted by a restart`, { routineId: r.routine_id, routineName: name, runId: r.id });
      return run;
    });
  }

  queuedRuns(botId?: string): RoutineRun[] {
    const rows = botId
      ? this.#all(`select ${RUN_COLUMNS} from routine_runs where status = 'queued' and bot_id = ? order by seq`, botId)
      : this.#all(`select ${RUN_COLUMNS} from routine_runs where status = 'queued' order by seq`);
    return rows.map((r) => this.#toRun(r));
  }

  cancelQueuedRuns(botId: string, error: string): number {
    const runs = this.queuedRuns(botId);
    // One held to try again had an earlier attempt run, so it may have partly run.
    for (const r of runs) this.updateRun(r.id, { status: 'failed', error, cancelled: { started: r.attempts > 0 } });
    return runs.length;
  }

  // ------------------------------------------------------------------- turns

  #prunedTurnsAt = 0;

  startTurn(t: TurnStart): string {
    const id = newId('turn', 10);
    this.#run(
      `insert into turns (id, bot_id, routine_id, run_id, trigger, provider, requested_model, started_at, outcome) values (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
      id,
      t.botId,
      t.routineId ?? null,
      t.runId ?? null,
      t.trigger,
      t.provider,
      t.requestedModel,
      nowIso(),
    );
    if (Date.now() - this.#prunedTurnsAt > 3_600_000) this.pruneTurns();
    return id;
  }

  finishTurn(id: string, end: TurnEnd): void {
    const u = end.usage;
    this.#run(
      `update turns set outcome = ?, error_kind = ?, duration_ms = ?, model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
         cache_write_tokens = ?, cost_usd = ?, num_turns = ?, replayed_transcript = ? where id = ?`,
      end.outcome,
      end.errorKind ?? null,
      Math.round(end.durationMs),
      end.model ?? null,
      Math.round(u?.inputTokens ?? 0),
      Math.round(u?.outputTokens ?? 0),
      Math.round(u?.cacheReadTokens ?? 0),
      Math.round(u?.cacheWriteTokens ?? 0),
      u?.costUsd ?? null,
      u?.numTurns ?? null,
      end.replayedTranscript ? 1 : 0,
      id,
    );
  }

  linkTurnMessage(turnId: string, messageId: string): void {
    this.#run('update turns set message_id = ? where id = ?', messageId, turnId);
  }

  endInterruptedTurns(): { id: string; botId: string; steps: number }[] {
    const chat = this.#all("select id, bot_id, step_count from turns where outcome = 'running' and run_id is null and message_id is null and step_count > 0");
    this.#run("update turns set outcome = 'interrupted' where outcome = 'running'");
    return chat.map((r) => ({ id: String(r.id), botId: String(r.bot_id), steps: Number(r.step_count) }));
  }

  /** Once per startup: every message still in flight was cut off once more. */
  countCutOffChats(limit: number): Map<string, Message[]> {
    this.#run("update messages set cut_off = cut_off + 1 where role = 'user' and pending = 2");
    const out = new Map<string, Message[]>();
    for (const r of this.#all("select * from messages where role = 'user' and pending = 2 and cut_off >= ? order by seq", limit)) {
      const list = out.get(String(r.bot_id)) ?? [];
      list.push(this.#toMessage(r));
      out.set(String(r.bot_id), list);
    }
    return out;
  }

  pruneTurns(): number {
    this.#prunedTurnsAt = Date.now();
    return Number(this.#run('delete from turns where started_at < ?', new Date(this.#prunedTurnsAt - TURN_RETENTION_MS).toISOString()).changes);
  }

  /** Saved as each step starts, so a turn that is stopped, fails or is cut off keeps what it did. Past MAX_STEPS a step is only counted. */
  addTurnStep(turnId: string, index: number, step: TurnStep): void {
    if (index < MAX_STEPS) {
      this.#run(
        'insert or replace into turn_steps (turn_id, idx, kind, label, detail, at) values (?, ?, ?, ?, ?, ?)',
        turnId,
        index,
        step.kind,
        step.label.slice(0, 300),
        truncate(step.detail, MAX_STEP_DETAIL),
        step.at,
      );
    }
    this.#run('update turns set step_count = max(step_count, ?) where id = ?', index + 1, turnId);
  }

  /** A quiet reply is history even when the tool-step budget is exhausted. */
  saveQuietTurnNote(turnId: string, index: number, note: string): void {
    this.#run('insert or replace into turn_steps (turn_id, idx, kind, label, detail, at) values (?, ?, ?, ?, ?, ?)',
      turnId, index, 'tool', 'Quiet reply', note, nowIso());
    this.#run('update turns set step_count = max(step_count, ?) where id = ?', index + 1, turnId);
  }

  #turnSteps(t: Row): TurnSteps {
    const steps = this.#all('select kind, label, detail, at from turn_steps where turn_id = ? order by idx', t.id).map((r) => ({
      kind: r.kind,
      label: r.label,
      detail: r.detail,
      at: r.at,
    })) as TurnStep[];
    return { turnId: t.id, startedAt: t.started_at, outcome: t.outcome as TurnOutcome, total: Number(t.step_count), steps };
  }

  messageSteps(messageId: string): TurnSteps | null {
    const t = this.#get('select id, started_at, outcome, step_count from turns where message_id = ?', messageId);
    return t ? this.#turnSteps(t) : null;
  }

  runSteps(runId: string): TurnSteps[] {
    return this.#all('select id, started_at, outcome, step_count from turns where run_id = ? order by started_at, rowid', runId).map((t) => this.#turnSteps(t));
  }

  turnRow(id: string): Row | undefined {
    return this.#get('select * from turns where id = ?', id);
  }

  usage(opts: { since: Date; group: 'bot' | 'routine'; botId?: string }): UsageReport {
    const until = new Date();
    const byRoutine = opts.group === 'routine';
    const rows = this.#all(
      `select t.bot_id, b.name as bot_name, ${byRoutine ? 't.routine_id, r.name as routine_name,' : ''}
         count(*) as turns, sum(t.input_tokens) as input, sum(t.output_tokens) as output, sum(t.cache_read_tokens) as cache_read,
         sum(t.cache_write_tokens) as cache_write, sum(t.cost_usd) as cost
       from turns t join bots b on b.id = t.bot_id ${byRoutine ? 'left join routines r on r.id = t.routine_id' : ''}
       where t.started_at >= ? and t.started_at < ? ${opts.botId ? 'and t.bot_id = ?' : ''}
       group by t.bot_id${byRoutine ? ', t.routine_id' : ''}`,
      opts.since.toISOString(),
      until.toISOString(),
      ...(opts.botId ? [opts.botId] : []),
    );
    const out: UsageRow[] = rows.map((r) => ({
      botId: r.bot_id,
      botName: r.bot_name,
      ...(byRoutine ? { routineId: r.routine_id ?? null, routineName: r.routine_name ?? null } : {}),
      turns: Number(r.turns),
      inputTokens: Number(r.input ?? 0),
      outputTokens: Number(r.output ?? 0),
      cacheReadTokens: Number(r.cache_read ?? 0),
      cacheWriteTokens: Number(r.cache_write ?? 0),
      ...(r.cost ? { costUsd: Number(r.cost) } : {}),
    }));
    out.sort((a, b) => totalTokens(b) - totalTokens(a) || b.turns - a.turns);
    return { since: opts.since.toISOString(), until: until.toISOString(), group: opts.group, rows: out };
  }

  // ----------------------------------------------------- provider cooldowns

  cooldowns(): { provider: string; until: Date; reason: string }[] {
    return this.#all('select * from provider_cooldowns').map((r) => ({ provider: r.provider, until: new Date(r.until), reason: r.reason }));
  }

  setCooldown(provider: string, until: Date, reason: string): void {
    this.#run(
      'insert into provider_cooldowns (provider, until, reason) values (?, ?, ?) on conflict(provider) do update set until = excluded.until, reason = excluded.reason',
      provider,
      until.toISOString(),
      reason.slice(0, 2000),
    );
  }

  clearCooldown(provider: string): void {
    this.#run('delete from provider_cooldowns where provider = ?', provider);
  }

  // ---------------------------------------------------------------- memories

  listMemories(botId: string): Memory[] {
    this.getBot(botId);
    return this.#all('select * from memories where bot_id = ? order by created_at', botId).map((r) => ({
      id: r.id,
      botId: r.bot_id,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  addMemory(botId: string, text: string): Memory {
    this.getBot(botId);
    const t = clean(text, 'text', 2000, true);
    const memory: Memory = { id: newId('mem'), botId, text: t, createdAt: nowIso() };
    this.#run('insert into memories (id, bot_id, text, created_at) values (?, ?, ?, ?)', memory.id, botId, t, memory.createdAt);
    this.#publish({ type: 'memory.upserted', memory });
    this.addMessage(botId, 'event', 'Saved to memory', { kind: 'memory.saved', memoryText: t });
    return memory;
  }

  memoryOwner(id: string): string | null {
    return (this.#get('select bot_id from memories where id = ?', id)?.bot_id as string | undefined) ?? null;
  }

  deleteMemory(id: string): void {
    const r = this.#get('select * from memories where id = ?', id);
    if (!r) throw new HttpError(404, `No memory with id ${id}`);
    this.#run('delete from memories where id = ?', id);
    this.#publish({ type: 'memory.deleted', memoryId: id, botId: r.bot_id });
    this.addMessage(r.bot_id, 'event', 'Forgot a memory', { kind: 'memory.forgotten', memoryText: r.text });
  }
}

/** The chip a run posts in its Boton's chat when it ends. */
export function runChip(run: RoutineRun, routineName: string): [string, MessageMeta] {
  const retried = run.attempts > 1;
  return [
    retried ? `Retried routine (attempt ${run.attempts})` : 'Ran routine',
    { kind: 'routine.run', routineId: run.routineId, routineName, runId: run.id, trigger: run.trigger, ...(retried ? { attempt: run.attempts } : {}) },
  ];
}

/** Whether the Boton may use it is checked by the caller (skills.ts). */
function skillName(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, 'skill must be a skill name or null');
  return v;
}

const ALWAYS_ALLOW_MAX = 50;

export function actionKey(v: unknown, field = 'action'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const key = v.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key) throw new HttpError(400, `${field} is empty`);
  if (key.length > 80) throw new HttpError(400, `${field} is too long (max 80 characters)`);
  if (!/^[\p{L}\p{N} _.:/#@*()-]+$/u.test(key)) throw new HttpError(400, `${field} may use only letters, digits, spaces and - _ . : / # @ * ( )`);
  return key;
}

export function alwaysAllowList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'alwaysAllow must be a list of kinds of action');
  const list = [...new Set(v.map((a) => actionKey(a, 'each alwaysAllow entry')))];
  if (list.length > ALWAYS_ALLOW_MAX) throw new HttpError(400, `alwaysAllow can hold at most ${ALWAYS_ALLOW_MAX} kinds of action`);
  return list;
}

const parseList = (raw: unknown): string[] => strings(parseJson(raw, []));

let ownerCache: string | null = null;
function defaultOwner(): string {
  if (ownerCache) return ownerCache;
  try {
    ownerCache = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 2000 }).trim() || null;
  } catch {}
  ownerCache ??= process.env.USER ?? 'you';
  return ownerCache;
}

/** A version-24 look with every field valid: what the capsule editor could send. */
function validLook24(v: unknown): v is Record<string, unknown> {
  if (!isLook24(v)) return false;
  const hex = /^#[0-9a-fA-F]{6}$/;
  return typeof v.body === 'string' && hex.test(v.body) && typeof v.bg === 'string' && hex.test(v.bg) && (v.eyes === 1 || v.eyes === 2) &&
    ['none', 'sprout', 'spiky', 'combed', 'antenna'].includes(v.hair as string) && ['smile', 'grin', 'o', 'flat'].includes(v.mouth as string);
}

/**
 * A look as stored from outside (a request, a saved template): a Boton, or a tater look, a valid Critter or a
 * version-24 look as its closest Boton; null for anything else.
 */
export function storedLook(v: unknown, seed: string): BotonLook | null {
  const look = parseLook(v);
  if (look) return look;
  const critter = parseCritter(v) ?? (validLook24(v) ? critterFromLook24(v, seed) : null);
  const tater = parseTater(v) ?? (critter ? taterFromCritter(critter) : null);
  return tater ? lookFromTater(tater) : null;
}

/** A look from a request, for the Boton `seed` names: as storedLook, or a 400. */
export function lookInput(v: unknown, seed: string): BotonLook {
  const look = storedLook(v, seed);
  if (!look) throw new HttpError(400, 'look must have shape, shell, glow, eyes, brows, mouth, top, ears, visor, panel, arms, backdrop and cheeks (true or false), each one of its listed values');
  return look;
}
