import { types } from 'node:util';
import { EFFORT_IDS } from '../../shared/effort.ts';
import type { RecentLogEntry, RecentLogField, RecentLogHelp, RecentLogLevel, RecentLogs as RecentLogsAnswer } from '../../shared/types.ts';
import { type LogFields, type LogLevel, tapLogs } from './log.ts';

/*
 * Settings → Server events: a selection of what this process logged, kept in memory only (a restart starts it
 * again; nothing reaches the disk or a backup). It is not the log. Nothing a line carries is copied as text:
 *
 * - The message is looked up, whole and exactly, in EVENTS below, a catalog of the fixed messages the server
 *   writes. A known message becomes its event code and label (both written here, in the source); any other
 *   message, including every message built from values, becomes "unclassified" with a fixed label.
 * - Only the field names in FIELDS are read, each through its own data property (never a getter, proxy trap,
 *   toJSON, toString or prototype), and a value is kept only when its validator accepts it: ids of the server's
 *   own shape, enum words, booleans and bounded whole numbers. Anything else is left out, never transformed.
 * - A thrown value (`err`) becomes a fixed error category from its own `code` (or its cause's), never its text.
 *
 * Every check reads a fixed number of properties and looks at no more than a short string's length first, so a
 * line costs the same whatever it holds. The full log, with error text, stays where the service sends stdout.
 */

/** Newest lines kept; the oldest go first. */
export const RECENT_LOG_ENTRIES = 1000;
/** And at most this many UTF-8 bytes (the entries' JSON), whichever limit comes first. */
export const RECENT_LOG_BYTES = 512 * 1024;
/** Lines one answer holds at most. */
export const RECENT_LOG_PAGE = 200;

export const UNCLASSIFIED = { event: 'unclassified', label: 'Unclassified server event' } as const;

const LEVELS: readonly RecentLogLevel[] = ['info', 'warn', 'error'];
/** Longer than any message in EVENTS: a longer message is unclassified without being looked at. */
const MESSAGE_MAX = 200;
const QUERY_MAX = 100;

type EventDef = readonly [message: string, event: string, help?: RecentLogHelp, label?: string];

/** The server's fixed log messages (server/test/recent-logs.test.ts keeps this in step with server/src). */
const EVENTS: readonly EventDef[] = [
  ["routine models reset: the Boton moved to another provider", 'routine.models_reset'],
  ["codex turn's own tokens are unknown: turn.completed has the thread's running totals, and its rollout doesn't say where this turn started", 'codex.usage_unknown'],
  ['a setting uses a deprecated name, which works for this release only', 'config.earlier_name'],
  ['a setting is set under both its name and a deprecated name, to different values: its name is used', 'config.earlier_name_conflict'],
  ['did not put back an instruction file a sandboxed turn changed: a folder on its way is now a link, which is not followed', 'sandbox.restore_link_refused'],
  ['a connector test failed', 'connector.test_failed', 'connector'],
  ['a connector was turned off or on during a poll of its work feed; the rest of that poll was dropped', 'connector.feed_poll_dropped'],
  ['agent CLIs left by a previous server process would not stop', 'agents.orphans_kept', 'bug'],
  ['API key removed', 'api_key.removed'],
  ['API key saved', 'api_key.saved'],
  ['API key tested', 'api_key.tested'],
  ['api turn', 'api.turn'],
  ['approval decided', 'approval.decided'],
  ['approval request allowed by an always-allow rule', 'approval.always_allowed'],
  ['approval requested', 'approval.requested'],
  ['approval request expired', 'approval.expired'],
  ['approval request refused: rate limit', 'approval.rate_limited'],
  ['approval request withdrawn', 'approval.withdrawn'],
  ['a sandboxed turn changed instruction files; put them back', 'sandbox.instructions_restored'],
  ['the Workspace sandbox for API-key Botons is unavailable', 'sandbox.unavailable'],
  ['the Workspace sandbox leaves out folders another filesystem is mounted inside', 'sandbox.mount_parents_omitted'],
  ['could not save an API session', 'api.session_save_failed'],
  ['spending caps changed', 'spending.caps_changed'],
  ['API requests a stopped server left reserved are held at their most', 'spending.reservations_held'],
  ['ask answered', 'ask.answered'],
  ['ask refused: hop limit', 'ask.hop_limited'],
  ['ask refused: rate limit', 'ask.rate_limited'],
  ['ask sent', 'ask.sent'],
  ['auth is OFF (BOTONS_AUTH=off): anyone who can reach this server can use it, Botons included.', 'auth.off', 'auth-off'],
  ['backed up the database before upgrading its schema', 'schema.backed_up'],
  ['browser closed', 'browser.closed'],
  ['browser handoff handed back', 'browser.handoff_handed_back'],
  ['browser handoff requested', 'browser.handoff_requested'],
  ['browser handover ended', 'browser.handover_ended'],
  ['browser handover started', 'browser.handover_started'],
  ['browser request held for approval', 'browser.request_held'],
  ['browser request sent', 'browser.request_sent'],
  ['browser request withdrawn', 'browser.request_withdrawn'],
  ['browser sites changed', 'browser.sites_changed'],
  ['browser started', 'browser.started'],
  ['callback failed', 'callback.failed', 'run'],
  ['callback not sent: too many results waiting for the callback URL', 'callback.backlog', 'run'],
  ['callback resumed after a restart', 'callback.resumed'],
  ['callback sent', 'callback.sent'],
  ['card answered', 'card.answered'],
  ['card posted', 'card.posted'],
  ['connector granted at once on request', 'connector.granted'],
  ['connector requested: waiting for approval', 'connector.requested'],
  ['connector request policy changed', 'connector.policy_changed'],
  ["connector's Botons changed", 'connector.botons_changed'],
  ['connectors left out of the turn', 'turn.connectors_left_out'],
  ['connectors left out of the turn: a webhook started it', 'turn.connectors_left_out_webhook'],
  ['conversation reset: the next turn starts a new session', 'session.reset_by_owner'],
  ['closed file descriptors the server was started with, so no sandboxed command gets them', 'sandbox.inherited_descriptors_closed'],
  ['could not check OAuth keep-alive', 'oauth.keepalive_check_failed', 'bug'],
  ['could not check the instruction files after a sandboxed turn', 'sandbox.check_failed'],
  ['could not delete a handover browser profile', 'browser.handover_profile_left'],
  ['could not delete a trash item', 'trash.purge_failed'],
  ['could not expire an approval request', 'approval.expire_failed', 'bug'],
  ['could not expire approval requests', 'approval.expire_all_failed', 'bug'],
  ['could not list a connector’s tools', 'connector.tools_failed', 'connector'],
  ['could not note what a test run runs on', 'starter.test_not_noted', 'bug'],
  ['could not push a browser handoff', 'push.handoff_failed', 'push'],
  ['could not push about a connector that needs signing in', 'push.reconnect_failed', 'push'],
  ['could not put back an instruction file a sandboxed turn changed', 'sandbox.restore_failed'],
  ['could not put back an instruction file a sandboxed turn changed: it was too big to keep a copy of', 'sandbox.restore_too_big'],
  ['could not put back the instruction files a sandboxed turn changed: its workspace could not be opened', 'sandbox.restore_unopened'],
  ['could not read a connector’s work feed; trying again later', 'connector.feed_failed', 'connector'],
  ['could not read a job’s link; its update goes without one', 'work.link_unreadable'],
  ['could not read the browser profile\'s cookies', 'browser.cookies_unread'],
  ['could not record a callback for a run', 'callback.record_failed', 'bug'],
  ['could not record an agent process group', 'agents.record_failed'],
  ['could not record a push for a run', 'push.record_run_failed'],
  ['could not record a restore rehearsal', 'backup.rehearsal_record_failed', 'bug'],
  ['could not record a tool result', 'tool.record_failed'],
  ['could not record the push for an approval request', 'push.record_approval_failed'],
  ['could not remove a local connector’s launch file', 'connector.launch_file_left'],
  ['could not save the handover\'s cookies to the browser profile', 'browser.cookies_unsaved'],
  ['could not send the error response', 'http.error_response_failed', 'bug'],
  ['could not start looking at a signed-in connector', 'connector.look_failed', 'connector'],
  ['could not stop running turns', 'shutdown.stop_failed', 'bug'],
  ['could not write to the browser journal', 'browser.journal_failed'],
  ['could not write an audit event', 'audit.write_failed', 'bug'],
  ['event listener failed', 'events.listener_failed', 'bug'],
  ['file uploaded', 'file.uploaded'],
  ['gave up on chat messages cut off at every start', 'chat.cut_off_given_up'],
  ['job failed', 'jobs.failed', 'bug'],
  ['keep-alive refresh failed', 'oauth.keepalive_failed', 'reconnect'],
  ['looked at a connector’s tools', 'connector.looked'],
  ['MCP server added to the library', 'mcp.added'],
  ['MCP server in the library changed', 'mcp.changed'],
  ['MCP server left out of a codex turn', 'mcp.left_out'],
  ['MCP server removed from the library', 'mcp.removed'],
  ['Boton created from a template', 'boton.created_from_template'],
  ['Boton duplicated', 'boton.duplicated'],
  ['new claude session', 'session.new'],
  ['new session: the replay was sized to its budget', 'session.replay'],
  ['webhook run: the chat it was given was sized to its budget', 'session.replay'],
  ['OAuth callback refused: the authorization response came from another issuer', 'oauth.callback_wrong_issuer', 'reconnect'],
  ['OAuth callback refused: the device that started it is no longer paired', 'oauth.callback_unpaired', 'reconnect'],
  ['OAuth code exchange failed', 'oauth.exchange_failed', 'reconnect'],
  ['OAuth connector added', 'oauth.added'],
  ['OAuth connector removed', 'oauth.removed'],
  ['OAuth connector signed in', 'oauth.signed_in'],
  ['OAuth refresh answer lost: the refresh token is not used again; the connector needs signing in again', 'oauth.refresh_lost', 'reconnect'],
  ['OAuth refresh discarded: the connector changed while it ran', 'oauth.refresh_discarded'],
  ['OAuth refresh failed; the grant is kept', 'oauth.refresh_failed', 'reconnect'],
  ['OAuth refresh interrupted: the refresh token is not used again; the connector needs signing in again', 'oauth.refresh_interrupted', 'reconnect'],
  ['OAuth refresh refused: the connector needs signing in again', 'oauth.refresh_refused', 'reconnect'],
  ['OAuth sign-in declined at the authorization server', 'oauth.declined', 'reconnect'],
  ['OAuth sign-in discarded: the device that started it was unpaired while it finished', 'oauth.sign_in_discarded', 'reconnect'],
  ['OAuth sign-in started', 'oauth.sign_in_started'],
  ['OAuth token refreshed', 'oauth.refreshed'],
  ['provider switched: the next chat turn starts with a handoff note', 'provider.switched'],
  ['push failed', 'push.failed', 'push'],
  ['reaction added', 'reaction.added'],
  ['reaction removed', 'reaction.removed'],
  ['reactions imported', 'reactions.imported'],
  ['registered Botons with an authorization server', 'oauth.registered'],
  ['request failed', 'http.request_failed', 'bug'],
  ['restore rehearsal failed', 'backup.rehearsal_failed'],
  ['restore rehearsal passed', 'backup.rehearsal_passed'],
  ['run cancelled', 'run.cancelled'],
  ['run failed on a network error: trying again later', 'run.network_retry'],
  ['run queued', 'run.queued'],
  ['run stopped at its time limit', 'run.time_limit', 'run'],
  ['scheduled routine failed to start', 'run.schedule_failed', 'run'],
  ['scheduled run skipped', 'run.skipped'],
  ['session lost: starting a new one', 'session.lost'],
  ['session reset: the system prompt or provider changed, so the turn starts a new session', 'session.reset_by_change'],
  ['shutdown failed', 'shutdown.failed', 'bug'],
  ['skill approved', 'skill.approved'],
  ['skill changed', 'skill.changed'],
  ['skill deleted', 'skill.deleted'],
  ['skill saved', 'skill.saved'],
  ['skill installed', 'skill.installed'],
  ['skill restored', 'skill.restored'],
  ['skill imported', 'skill.imported'],
  ['skill turned off', 'skill.turned_off'],
  ['skill turned on', 'skill.turned_on'],
  ["skill's Botons changed", 'skill.botons_changed'],
  ['skill waiting for approval', 'skill.waiting'],
  ['some agent processes did not exit in time', 'agents.exit_late'],
  ['stopped polling a connector’s feed: it needs signing in again', 'connector.feed_stopped', 'reconnect'],
  ['stopping an agent CLI that a previous server process left running (it died without draining), before its work runs again', 'agents.orphan_stopped'],
  ['switch summary failed', 'switch.summary_failed'],
  ['switch summary not saved: stopped once it was written', 'switch.summary_stopped'],
  ['switch summary not saved: the move changed while it was written', 'switch.summary_discarded'],
  ['switch summary started', 'switch.summary_started'],
  ['switch summary written', 'switch.summary_written'],
  ['Tailscale check failed', 'tailscale.check_failed', 'tailscale'],
  ['template saved', 'template.saved'],
  ['configuration exported', 'config.exported'],
  ['configuration imported', 'config.imported'],
  ['templates imported', 'template.imported'],
  ['the list of imported templates waiting to be put in place is unreadable: it is dropped', 'template.outbox_unreadable'],
  ['a step after a commit failed', 'server.after_commit_failed'],
  ['the browser did not say its user agent: it keeps its headless one', 'browser.user_agent_unknown'],
  ['the browser did not close cleanly', 'browser.close_failed'],
  ['the browser did not start', 'browser.start_failed'],
  ['the instruction files could not be noted before a sandboxed turn, so they will not be put back after it (the CLI sandbox still keeps it from writing them)', 'sandbox.snapshot_failed'],
  ['the managed browser did not start', 'browser.check_failed'],
  ['the managed browser is not available', 'browser.unavailable'],
  ['the authorization server issued no refresh token: the connector needs signing in again when the access token expires', 'oauth.no_refresh_token', 'reconnect'],
  ['tool call allowed by an always-allow rule', 'tool.always_allowed'],
  ['tool call allowed: the owner allowed it after it stopped waiting', 'tool.allowed_late'],
  ['tool call denied: no Ask first rule covers it, and Workspace access does not allow it', 'tool.denied'],
  ['tool call paused for approval', 'tool.paused'],
  ['tool call waits on its card again', 'tool.waits_again'],
  ['turn ended', 'turn.ended'],
  ['turn not started: its provider is not on this server', 'turn.no_provider', 'brain'],
  ['turn started', 'turn.started'],
  ['unhandled promise rejection', 'process.unhandled_rejection', 'bug'],
  ['usage limit has reset: resuming its Botons', 'usage.reset'],
  ['usage limit hit: holding its turns until the reset', 'usage.limited', 'usage-limit'],
  ['wake-up failed', 'wakeup.failed', 'bug'],
  ['could not move an inbox file to the trash', 'trash.inbox_move_failed'],
  ['a file changed while it was moved to the trash; what was moved is kept in the trash', 'trash.move_changed_kept'],
  ['a restored file was not where it was put', 'trash.restore_not_placed', 'bug'],
  ['a restored file’s folder was moved out of reach as it landed', 'trash.restore_folder_moved'],
  ['the daily storage cleanup failed', 'trash.cleanup_failed', 'bug'],
  ['a trash item whose meta.json is unreadable or not valid was kept as it is', 'trash.unreadable_kept'],
  ['a trash item whose deletion time is in the future was kept as it is', 'trash.future_kept'],
  ['could not remove an unfinished trash item', 'trash.staging_left'],
  ['the inbox cleanup was skipped: files are moved to the trash only through folders held open (/proc/self/fd, on Linux)', 'trash.no_handles'],
  ['webhook', 'webhook.request', undefined, 'webhook request'],
  ['webhook caller hung up before the answer', 'webhook.caller_left'],
  ['webhook redelivery of a run that did not succeed: running it again', 'webhook.redelivery'],
  ['work_feed events without a usable cursor or job id were skipped', 'work.feed_events_skipped'],
  ['work started through a connector', 'work.started'],
  ['work_start returned a job another Boton started; it stays theirs', 'work.job_theirs'],
  ['work update for a job no Boton is known to have started: not delivered', 'work.update_undelivered'],
];

interface Event {
  event: string;
  label: string;
  help: RecentLogHelp | null;
}

const CATALOG: ReadonlyMap<string, Event> = new Map(EVENTS.map(([message, event, help, label]) => [message, { event, label: label ?? message, help: help ?? null }]));

/** For the test that keeps EVENTS in step with the messages in server/src. */
export const CATALOG_MESSAGES: readonly string[] = EVENTS.map(([m]) => m);

/** The event a message is: an exact match on a short primitive string, or unclassified. Never reads a long text. */
export function classify(msg: unknown): Event {
  if (typeof msg !== 'string' || msg.length > MESSAGE_MAX) return { ...UNCLASSIFIED, help: null };
  return CATALOG.get(msg) ?? { ...UNCLASSIFIED, help: null };
}

// ---- fields ----

type Validator = (v: unknown) => RecentLogField | undefined;

/** One of the server's own ids (`newId` in util.ts): its prefix, then a fixed number of [0-9a-z]. */
const id = (prefix: string, length = 8): Validator => {
  const re = new RegExp(`^${prefix}_[0-9a-z]{${length}}$`);
  const size = prefix.length + 1 + length;
  return (v) => (typeof v === 'string' && v.length === size && re.test(v) ? v : undefined);
};
const oneOf = (...words: string[]): Validator => {
  const set = new Set(words);
  return (v) => (typeof v === 'string' && v.length <= 32 && set.has(v) ? v : undefined);
};
const whole = (min: number, max: number): Validator => (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined);
const flag: Validator = (v) => (typeof v === 'boolean' ? v : undefined);
const either = (a: Validator, b: Validator): Validator => (v) => a(v) ?? b(v);

const COUNT = whole(0, 1_000_000_000);
const MS = whole(0, 1_000_000_000_000);

/** The only names read from a line's fields, and what each may hold. */
const FIELDS: Readonly<Record<string, Validator>> = {
  botId: id('bot'),
  fromBotId: id('bot'),
  routineId: id('rt'),
  runId: id('run'),
  retryOf: id('run'),
  approvalId: id('apr'),
  connectionId: id('oac'),
  threadId: id('thr'),
  deviceId: id('dev'),
  templateId: id('tpl'),
  provider: oneOf('claude-cli', 'codex-cli', 'mock'),
  api: oneOf('anthropic', 'openai'),
  effort: oneOf(...EFFORT_IDS),
  trigger: oneOf('chat', 'schedule', 'webhook', 'manual', 'test'),
  kind: oneOf('chat', 'routine'),
  outcome: oneOf('running', 'ok', 'error', 'timeout', 'stopped', 'interrupted', 'granted', 'pending'),
  decision: oneOf('allow', 'deny'),
  session: oneOf('new', 'resume'),
  was: oneOf('queued', 'running'),
  status: either(oneOf('queued', 'running', 'succeeded', 'failed', 'skipped'), whole(100, 599)),
  method: oneOf('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'),
  channel: oneOf('ntfy'),
  origin: oneOf('uncaughtException', 'unhandledRejection'),
  signal: oneOf('SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGABRT'),
  limit: either(oneOf('pair', 'total'), COUNT),
  ok: flag,
  headless: flag,
  sandbox: flag,
  always: flag,
  inTurn: flag,
  duplicate: flag,
  rotated: flag,
  timedOut: flag,
  sessionLost: flag,
  workFeed: flag,
  exitCode: whole(-1_000_000, 1_000_000),
  durationMs: MS,
  timeLimitMs: MS,
  retryInMs: MS,
  attempt: COUNT,
  attempts: COUNT,
  routines: COUNT,
  tools: COUNT,
  sites: COUNT,
  messages: COUNT,
  max: COUNT,
  hop: COUNT,
  size: COUNT,
  interrupted: COUNT,
  skipped: COUNT,
};
const FIELD_NAMES = Object.keys(FIELDS);

/** The standard OAuth error codes (RFC 6749, 6750): an `error` field that is exactly one of them is shown. */
const OAUTH_ERROR = oneOf(
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
  'access_denied', 'unsupported_response_type', 'server_error', 'temporarily_unavailable', 'invalid_token', 'insufficient_scope',
);

/** What a thrown value's own `code` says, as a fixed category. */
const ERROR_CODES: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection-refused',
  ECONNRESET: 'connection-reset',
  EPIPE: 'connection-reset',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
  ABORT_ERR: 'aborted',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  UND_ERR_SOCKET: 'connection-reset',
  CERT_HAS_EXPIRED: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
  EACCES: 'permission',
  EPERM: 'permission',
  ENOENT: 'not-found',
  ENOSPC: 'disk-full',
  EDQUOT: 'disk-full',
  EADDRINUSE: 'address-in-use',
  EADDRNOTAVAIL: 'address-unavailable',
  EMFILE: 'too-many-files',
  ENFILE: 'too-many-files',
  SQLITE_BUSY: 'database-busy',
  SQLITE_FULL: 'disk-full',
  SQLITE_CORRUPT: 'database-corrupt',
  ERR_SQLITE_ERROR: 'database',
};

/** An own data property's value, or undefined: never a getter, a proxy trap or anything on the prototype. */
function ownValue(o: unknown, key: string): unknown {
  if (typeof o !== 'object' || o === null || types.isProxy(o)) return undefined;
  let d: PropertyDescriptor | undefined;
  try {
    d = Object.getOwnPropertyDescriptor(o, key);
  } catch {
    return undefined;
  }
  return d && 'value' in d ? d.value : undefined;
}

function codeCategory(o: unknown): string | undefined {
  const code = ownValue(o, 'code');
  return typeof code === 'string' && code.length <= 40 && Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : undefined;
}

/** A thrown value as a category: its own `code`, else its cause's; 'other' when it says nothing known. */
export function errorCategory(err: unknown): string {
  return codeCategory(err) ?? codeCategory(ownValue(err, 'cause')) ?? 'other';
}

/** The kept fields of a line: only FIELDS (and `err`, `error`), each validated, read without running any code. */
export function selectFields(fields: unknown): Record<string, RecentLogField> {
  const out: Record<string, RecentLogField> = {};
  if (typeof fields !== 'object' || fields === null || types.isProxy(fields)) return out;
  for (const name of FIELD_NAMES) {
    const v = FIELDS[name](ownValue(fields, name));
    if (v !== undefined) out[name] = v;
  }
  const err = ownValue(fields, 'err');
  if (err !== undefined && err !== null) out.errorCategory = errorCategory(err);
  const oauth = OAUTH_ERROR(ownValue(fields, 'error'));
  if (oauth !== undefined) out.oauthError = oauth;
  return out;
}

// ---- the buffer ----

export class RecentLogs {
  #entries: RecentLogEntry[] = [];
  #sizes: number[] = [];
  #bytes = 0;
  #seq = 0;
  #dropped = 0;
  #since = new Date().toISOString();
  #threshold: () => LogLevel;
  #untap: (() => void) | null = null;

  constructor(opts: { threshold: () => LogLevel }) {
    this.#threshold = opts.threshold;
  }

  /** Starts seeing the server's log lines; stop() ends it. */
  start(): this {
    this.#untap ??= tapLogs((level, msg, fields, at) => this.add(level, msg, fields, at));
    return this;
  }

  stop(): void {
    this.#untap?.();
    this.#untap = null;
  }

  add(level: LogLevel, msg: unknown, fields: LogFields | unknown, at = new Date()): void {
    if (level !== 'info' && level !== 'warn' && level !== 'error') return;
    const { event, label, help } = classify(msg);
    const entry: RecentLogEntry = { seq: ++this.#seq, ts: at.toISOString(), level, event, label, help, fields: selectFields(fields) };
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    this.#entries.push(entry);
    this.#sizes.push(size);
    this.#bytes += size;
    while (this.#entries.length > RECENT_LOG_ENTRIES || (this.#bytes > RECENT_LOG_BYTES && this.#entries.length > 1)) {
      this.#entries.shift();
      this.#bytes -= this.#sizes.shift() ?? 0;
      this.#dropped++;
    }
  }

  /** Newest first. `level` is the least severe kept; `q` matches the label, event code and field values, ignoring case. */
  list(opts: { level?: string | null; q?: string | null; boton?: string | null; before?: number | null; limit?: number | null } = {}): RecentLogsAnswer {
    const min = LEVELS.indexOf((LEVELS as readonly string[]).includes(opts.level ?? '') ? (opts.level as RecentLogLevel) : 'info');
    const q = (opts.q ?? '').slice(0, QUERY_MAX).trim().toLowerCase();
    const boton = (opts.boton ?? '').trim();
    const before = opts.before && opts.before > 0 ? opts.before : Number.POSITIVE_INFINITY;
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), RECENT_LOG_PAGE);
    const counts: Record<RecentLogLevel, number> = { info: 0, warn: 0, error: 0 };
    const entries: RecentLogEntry[] = [];
    let more = false;
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const e = this.#entries[i];
      counts[e.level]++;
      if (e.seq >= before || LEVELS.indexOf(e.level) < min) continue;
      if (boton && e.fields.botId !== boton && e.fields.fromBotId !== boton) continue;
      if (q && !matches(e, q)) continue;
      if (entries.length >= limit) {
        more = true;
        continue;
      }
      entries.push(e);
    }
    const threshold = this.#threshold();
    return {
      entries,
      more,
      since: this.#since,
      oldestAt: this.#entries[0]?.ts ?? null,
      dropped: this.#dropped,
      kept: this.#entries.length,
      counts,
      bytes: this.#bytes,
      limits: { entries: RECENT_LOG_ENTRIES, bytes: RECENT_LOG_BYTES, page: RECENT_LOG_PAGE },
      threshold: threshold === 'debug' ? 'info' : threshold,
    };
  }
}

function matches(e: RecentLogEntry, q: string): boolean {
  if (e.label.toLowerCase().includes(q) || e.event.includes(q)) return true;
  for (const v of Object.values(e.fields)) if (String(v).toLowerCase().includes(q)) return true;
  return false;
}
