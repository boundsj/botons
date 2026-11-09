import { serverCommand } from './install-type.ts';
import type { DatabaseSync } from 'node:sqlite';
import { lookFor } from '../../shared/look.ts';
import { taterLookFor } from '../../shared/look-tater.ts';
import { newId } from './util.ts';
import { RENAMED } from '../../shared/legacy-names.mjs';

export const SCHEMA_VERSION = 35;

// Approvals is rebuilt by the upgrade from 20 (a check constraint can't be altered), so it is kept apart.
const APPROVALS = `create table approvals (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  kind text not null check (kind in ('action', 'skill', 'connector')),
  title text not null,
  details text not null default '',
  follow_up text not null default '',
  action text,
  skill_name text,
  status text not null check (status in ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  always integer not null default 0,
  auto integer not null default 0,
  note text,
  trigger text not null,
  turn_id text,
  routine_id text,
  routine_name text,
  run_id text,
  sandboxed integer not null default 0,
  asked_by text not null default '[]',
  message_id text,
  decided_by text,
  notifications text not null default '[]',
  created_at text not null,
  expires_at text,
  decided_at text,
  tool_name text,
  tool_input text,
  tool_key text,
  tool_rule text,
  wait_until text,
  in_turn integer not null default 0,
  used_at text,
  skill_version text,
  connector_id text,
  connector_generation integer
);
`;

const APPROVAL_INDEXES = `create index approvals_bot on approvals(bot_id, created_at);
create index approvals_pending on approvals(status, expires_at) where status = 'pending';
create index approvals_tool on approvals(bot_id, tool_key) where tool_key is not null;
`;

/** New in 21: OAuth connectors, which connectors Botons may ask for, and work started through a connector. */
const CONNECTORS_21 = `
create table oauth_connections (
  id text primary key,
  name text not null unique,
  url text not null,
  status text not null check (status in ('new', 'connected', 'reconnect')),
  status_reason text,
  generation integer not null default 0,
  resource text not null default '',
  issuer text not null default '',
  as_metadata text not null default '{}',
  client_id text not null default '',
  client_for text not null default '',
  scope text not null default '',
  access_token text,
  access_expires_at text,
  access_lifetime_ms integer,
  refresh_token text,
  refreshed_at text,
  refresh_error text,
  refresh_error_kind text,
  refresh_retry_at text,
  refresh_started_at text,
  keep_connected integer not null default 1,
  keepalive_at text,
  notified_generation integer,
  unknown_jobs text not null default 'nowhere' check (unknown_jobs in ('nowhere', 'primary')),
  feed integer not null default 0,
  feed_cursor text,
  feed_ready integer not null default 0,
  feed_checked_at text,
  feed_error text,
  created_at text not null,
  updated_at text not null
);
create table oauth_flows (
  state_hash text primary key,
  connection_id text not null references oauth_connections(id) on delete cascade,
  device_id text not null,
  generation integer not null,
  issuer text not null,
  resource text not null,
  metadata text not null,
  scope text not null default '',
  client_id text not null,
  redirect_uri text not null,
  code_verifier text not null,
  return_to text not null,
  created_at text not null,
  expires_at text not null
);
create index oauth_flows_expiry on oauth_flows(expires_at);
create table connector_policies (
  connector_id text primary key,
  on_request integer not null default 0,
  grant_mode text not null default 'approval' check (grant_mode in ('approval', 'immediate')),
  generation integer not null default 1,
  updated_at text not null
);
create table work_jobs (
  connection_id text not null references oauth_connections(id) on delete cascade,
  job_id text not null,
  bot_id text not null references bots(id) on delete cascade,
  call_id text,
  created_at text not null,
  primary key (connection_id, job_id)
);
create table work_feed_seen (
  connection_id text not null references oauth_connections(id) on delete cascade,
  key text not null,
  value text not null default '',
  at text not null,
  primary key (connection_id, key)
);
create index work_feed_seen_at on work_feed_seen(connection_id, at);
create table work_feed_held (
  connection_id text not null references oauth_connections(id) on delete cascade,
  event_id text not null,
  job_id text not null,
  event text not null,
  held_at text not null,
  primary key (connection_id, event_id)
);
`;

/**
 * New in 22: the audit log of consequential actions (pairing, access, setup, approvals, connectors).
 * Rows name who did what to which thing; they never hold a token, code, secret or message text.
 */
const AUDIT_EVENTS = `
create table audit_events (
  seq integer primary key autoincrement,
  at text not null,
  actor_kind text not null check (actor_kind in ('device', 'boton', 'host', 'system')),
  actor_id text,
  actor_label text not null default '',
  action text not null,
  target_kind text,
  target_id text,
  target_label text not null default '',
  details text not null default '{}'
);
create index audit_events_at on audit_events(at);
`;
const AUDIT_22 = AUDIT_EVENTS;

/**
 * New in 22: a device asking to pair. It holds the request's secret (only its hash is here) and shows
 * the code; the owner approves the code on the server's machine or on a paired device, and only then can
 * the holder of the secret turn it into a device token. A code alone never pairs anything.
 */
const PAIRING_22 = `
create table pairing_requests (
  secret_hash text primary key,
  code_hash text not null unique,
  label text not null default '',
  created_at text not null,
  expires_at text not null,
  approved_at text,
  approved_label text
);
`;

/**
 * New in 23: what the owner should know about a Boton's connectors, one row per Boton and connector id
 * (ConnectorNotice in shared/types.ts). The Connectors class owns it.
 */
const NOTICES_23 = `
create table connector_notices (
  bot_id text not null references bots(id) on delete cascade,
  connector_id text not null,
  kind text not null check (kind in ('removed', 'skipped')),
  name text not null,
  target text not null default '',
  reason text not null,
  at text not null,
  primary key (bot_id, connector_id)
);
`;

/**
 * A sidebar group name as it is compared: two names are the same group when their keys are equal. Unicode case
 * folding in JavaScript, after NFC (so "Équipe", "ÉQUIPE" and a decomposed "équipe" are one group), because SQLite's
 * nocase folds ASCII only. The upgrade, the lookups and the unique index (on name_key) all use it.
 */
export function sidebarGroupKey(name: string): string {
  return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
}

/**
 * New in 27: the owner's sidebar groups, in their order, each collapsed or not, names unique by sidebarGroupKey. A
 * Boton is in at most one (bots.group_id; none is ungrouped) at bots.position among its section, and pinned ones
 * are ordered by bots.pin_position. Whether Pinned and Ungrouped are collapsed are settings.
 */
const SIDEBAR_27 = `create table sidebar_groups (
  id text primary key,
  name text not null,
  name_key text not null,
  position integer not null,
  collapsed integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create unique index sidebar_groups_name on sidebar_groups(name_key);
`;

/**
 * New in 28: the texts a skill had before it was replaced, so the owner can put one back (a few per skill; skills.ts
 * keeps them).
 */
const SKILL_HISTORY_28 = `
create table skill_history (
  id integer primary key autoincrement,
  name text not null,
  version text not null,
  description text not null,
  body text not null,
  source text,
  replaced_at text not null,
  replaced_by text not null
);
create index skill_history_name on skill_history (name, id);
`;

/**
 * A message's meta as SQL, read as JSON only when it is: like parseJson, a meta that isn't JSON reads as none, so it
 * can't fail a write, an index or a query (json_extract throws on malformed text).
 */
export const MESSAGE_META = 'case when json_valid(meta) then meta end';
/** A pinned message (store.ts's setMessagePinned): only the owner's and the Boton's messages carry a pin. */
export const PINNED_MESSAGE = `json_extract(${MESSAGE_META}, '$.pinned') is not null and role in ('user', 'bot')`;
/** A message about a routine (its run's output, or an event about it): the replay reads these apart from the chat. */
export const ROUTINE_MESSAGE = `json_extract(${MESSAGE_META}, '$.routineId') is not null`;
/** Any other message: the chat a replay reads, newest first, apart from routine messages. */
export const CHAT_MESSAGE = `json_extract(${MESSAGE_META}, '$.routineId') is null`;
/** The event store.ts's resetContext adds as it starts the chat fresh: every message after it is since the reset. */
export const RESET_EVENT = `json_extract(${MESSAGE_META}, '$.kind') = 'session.reset' and role = 'event'`;

/**
 * New in 29: a chat's pins, its routine messages and the rest, each in seq order, so a new session's replay, the
 * pins' reads and a reset read only their own rows rather than scanning past many others for a few (routine output
 * can far outnumber the chat, and pins are a handful); and its resets by time, so a read since a reset starts at its
 * event rather than reading every message before it to find none newer. SQLite uses a partial index only for a query
 * whose WHERE repeats its condition, so store.ts builds its queries from these same constants.
 */
const MESSAGE_INDEXES_29 = `create index messages_pinned on messages(bot_id, seq) where ${PINNED_MESSAGE};
create index messages_routine on messages(bot_id, seq) where ${ROUTINE_MESSAGE};
create index messages_chat on messages(bot_id, seq) where ${CHAT_MESSAGE};
create index messages_reset on messages(bot_id, created_at) where ${RESET_EVENT};
`;

/**
 * New in 30: emoji reactions on chat messages. The owner reacts to the Boton's messages and the Boton to the
 * owner's, each emoji at most once per message by each, and the Boton with one emoji at most. told_at is when one of
 * the Boton's turns was given an owner's reaction as feedback (null: not yet). reaction_followups keeps which
 * reactions on which message started a follow-up turn, so taking one off and adding it again starts none.
 */
const MESSAGE_REACTIONS = `create table message_reactions (
  message_id text not null references messages(id) on delete cascade,
  bot_id text not null references bots(id) on delete cascade,
  actor text not null check (actor in ('owner', 'boton')),
  emoji text not null,
  created_at text not null,
  told_at text,
  primary key (message_id, actor, emoji)
);
create unique index message_reactions_boton on message_reactions(message_id) where actor = 'boton';
create index message_reactions_untold on message_reactions(bot_id, created_at) where actor = 'owner' and told_at is null;
`;
const REACTIONS_30 = `${MESSAGE_REACTIONS}create table reaction_followups (
  message_id text not null references messages(id) on delete cascade,
  emoji text not null,
  at text not null,
  primary key (message_id, emoji)
);
`;

/**
 * New in 31: the account of API-key requests (spend.ts), one row per request to a model, for the spending caps. `at`
 * is when it was reserved, just before it was sent: the day it counts on. `state`: reserved (sent or about to be),
 * settled (`cost_usd` is what its reported tokens cost), held (its tokens are unknown: it counts at `reserved_usd`) or
 * released (refused before anything was generated). `reserved_usd` null: a model with no known price.
 */
const API_REQUESTS_31 = `create table api_requests (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  turn_id text not null,
  run_id text,
  routine_id text,
  provider text not null,
  model text not null,
  at text not null,
  reserved_usd real,
  cost_usd real,
  state text not null check (state in ('reserved', 'settled', 'held', 'released')),
  ended_at text
);
create index api_requests_bot on api_requests(bot_id, at);
create index api_requests_run on api_requests(run_id) where run_id is not null;
`;

const AUTH_TOKENS = `create table auth_tokens (
  id text primary key,
  hash text not null unique,
  kind text not null check (kind in ('device', 'boton')),
  bot_id text references bots(id) on delete cascade,
  label text not null default '',
  created_at text not null,
  last_used_at text,
  check ((kind = 'boton') = (bot_id is not null))
);
create index auth_tokens_bot on auth_tokens(bot_id);
`;

const SCHEMA = `
create table settings (
  key text primary key,
  value text not null
);
create table bots (
  id text primary key,
  name text not null,
  title text not null default '',
  instructions text not null default '',
  look text not null,
  provider text not null,
  model text not null default '',
  access text not null default 'workspace',
  pinned integer not null default 0,
  timezone text not null,
  workspace text not null,
  session_id text,
  session_key text,
  context_since text,
  created_at text not null,
  updated_at text not null,
  last_activity_at text not null,
  read_seq integer not null default 0,
  paused integer not null default 0,
  connections text not null default '[]',
  skills text,
  always_allow text not null default '[]',
  ask_first text not null default '[]'
, effort text not null default '', group_id text references sidebar_groups(id) on delete set null, position integer not null default 0, pin_position integer not null default 0, previous_look text, tater_look text);
create table messages (
  seq integer primary key autoincrement,
  id text not null unique,
  bot_id text not null references bots(id) on delete cascade,
  role text not null,
  text text not null,
  meta text,
  pending integer not null default 0,
  created_at text not null,
  cut_off integer not null default 0
);
create index messages_bot on messages(bot_id, seq);
create index messages_pending on messages(bot_id, pending) where pending = 1;
create table routines (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  name text not null,
  instruction text not null,
  schedule text,
  timezone text not null,
  webhook_key text,
  enabled integer not null default 1,
  next_run_at text,
  last_run_at text,
  last_status text,
  created_at text not null,
  updated_at text not null,
  notify text not null default 'auto',
  webhook_workspace integer not null default 1,
  webhook_source text not null default 'generic',
  webhook_secret text,
  webhook_filter text,
  callback_url text,
  skill text,
  model text,
  session text not null default 'chat',
  session_id text,
  session_key text
, time_limit_ms integer, effort text, webhook_history integer not null default 0);
create index routines_due on routines(enabled, next_run_at);
create table routine_runs (
  seq integer primary key autoincrement,
  id text not null unique,
  routine_id text not null references routines(id) on delete cascade,
  bot_id text not null references bots(id) on delete cascade,
  trigger text not null,
  status text not null,
  error text,
  payload text,
  reply text,
  started_at text not null,
  finished_at text,
  quiet integer not null default 0,
  meta text,
  attempts integer not null default 0,
  last_error text,
  retry_at text,
  held_for text,
  headers text
);
create index runs_routine on routine_runs(routine_id, seq);
create table memories (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  text text not null,
  created_at text not null
);
${AUTH_TOKENS}create table provider_cooldowns (
  provider text primary key,
  until text not null,
  reason text not null
);
create table webhook_deliveries (
  routine_id text not null references routines(id) on delete cascade,
  delivery_id text not null,
  run_id text not null,
  created_at text not null,
  primary key (routine_id, delivery_id)
);
create index webhook_deliveries_created on webhook_deliveries(created_at);
create table mcp_servers (
  name text primary key,
  transport text not null check (transport in ('stdio', 'http')),
  command text not null default '',
  args text not null default '[]',
  url text not null default '',
  env text not null default '{}',
  headers text not null default '{}',
  created_at text not null,
  updated_at text not null
);
create table skills (
  name text primary key,
  description text not null,
  body text not null,
  created_by text not null,
  updated_by text not null,
  created_at text not null,
  updated_at text not null
, source text, disabled integer not null default 0);
create table turns (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  routine_id text,
  run_id text,
  message_id text,
  trigger text not null,
  provider text not null,
  requested_model text not null default '',
  model text,
  started_at text not null,
  duration_ms integer,
  outcome text not null,
  error_kind text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd real,
  num_turns integer,
  replayed_transcript integer not null default 0,
  step_count integer not null default 0
);
create index turns_started on turns(started_at);
create index turns_bot on turns(bot_id, started_at);
create index turns_run on turns(run_id) where run_id is not null;
create index turns_message on turns(message_id) where message_id is not null;
create table turn_steps (
  turn_id text not null references turns(id) on delete cascade,
  idx integer not null,
  kind text not null,
  label text not null,
  detail text not null,
  at text not null,
  primary key (turn_id, idx)
);
${APPROVALS}${APPROVAL_INDEXES}${CONNECTORS_21}${AUDIT_22}${PAIRING_22}${NOTICES_23}${SIDEBAR_27}${SKILL_HISTORY_28}${MESSAGE_INDEXES_29}${REACTIONS_30}${API_REQUESTS_31}`;

/** The columns approvals had at 20, all copied as they are. */
const APPROVAL_COLUMNS_20 =
  'id, bot_id, kind, title, details, follow_up, action, skill_name, status, always, auto, note, trigger, turn_id, routine_id, routine_name, run_id, sandboxed, asked_by, message_id, decided_by, notifications, created_at, expires_at, decided_at, tool_name, tool_input, tool_key, tool_rule, wait_until, in_turn, used_at, skill_version';

/** 20 to 21 in place, inside openSchema's transaction: approvals may be connector requests now, and the new tables. */
function upgradeFrom20(db: DatabaseSync): void {
  db.exec(`alter table approvals rename to approvals_20;
${APPROVALS}
insert into approvals (${APPROVAL_COLUMNS_20}) select ${APPROVAL_COLUMNS_20} from approvals_20 order by rowid;
drop table approvals_20;
${APPROVAL_INDEXES}${CONNECTORS_21}
pragma user_version = 21;`);
}

/**
 * 21 to 22 in place, inside openSchema's transaction: new tables, and pairing_codes is dropped. Pairing takes
 * the owner's approval of a request, since a bearer code pairs whoever types it (a Boton that saw one in chat
 * included); any code in it expires within minutes anyway. Every other row stays as it is.
 */
function upgradeFrom21(db: DatabaseSync): void {
  db.exec(`${AUDIT_22}${PAIRING_22}
drop table pairing_codes;
pragma user_version = 22;`);
}

/** Connector ids from a provider CLI's own MCP setup, which Botons no longer uses. */
const CLI_CONNECTOR = /^(claude|codex):(.+)$/;
const CLI_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Where a server from a CLI's setup pointed, for the owner: an address without query or credentials, or a command's name. */
function cliTarget(config: unknown): string {
  const c = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  if (typeof c.url === 'string') {
    try {
      const u = new URL(c.url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return '';
    }
  }
  return typeof c.command === 'string' ? (c.command.split('/').pop() ?? '') : '';
}

/**
 * 22 to 23 in place, inside openSchema's transaction. Every connector is Botons' own now, so a Boton's
 * connectors from a CLI's own MCP setup ("claude:<name>", "codex:<name>") come off it, and each becomes a
 * "removed" notice the owner sees in the Boton's settings, with where it pointed, so nothing is dropped
 * unreported. Their request policies go, a pending request for one is withdrawn, and the saved lookups of
 * the CLIs' servers (discovered_connectors) are dropped: nothing reads a CLI's MCP setup any more.
 */
function upgradeFrom22(db: DatabaseSync): void {
  db.exec(NOTICES_23);
  const targets = new Map<string, string>();
  for (const r of db.prepare('select provider, servers from discovered_connectors').all()) {
    const cli = String(r.provider).replace(/-cli$/, '');
    let servers: unknown = [];
    try {
      servers = JSON.parse(String(r.servers));
    } catch {}
    if (!Array.isArray(servers)) continue;
    for (const x of servers) if (x && typeof x.name === 'string') targets.set(`${cli}:${x.name}`, cliTarget(x.config));
  }
  const now = new Date().toISOString();
  const notice = db.prepare("insert or ignore into connector_notices (bot_id, connector_id, kind, name, target, reason, at) values (?, ?, 'removed', ?, ?, ?, ?)");
  const save = db.prepare('update bots set connections = ? where id = ?');
  for (const b of db.prepare('select id, connections from bots order by rowid').all()) {
    let ids: unknown = [];
    try {
      ids = JSON.parse(String(b.connections));
    } catch {}
    if (!Array.isArray(ids)) continue;
    const kept = ids.filter((id) => !(typeof id === 'string' && CLI_CONNECTOR.test(id)));
    if (kept.length === ids.length) continue;
    for (const id of ids) {
      const m = typeof id === 'string' ? CLI_CONNECTOR.exec(id) : null;
      if (!m) continue;
      notice.run(b.id, id, m[2], targets.get(id) ?? '', `Botons no longer uses MCP servers from ${CLI_NAME[m[1]]}'s own settings, so it was taken off this Boton.`, now);
    }
    save.run(JSON.stringify(kept), b.id);
  }
  db.prepare("update approvals set status = 'cancelled', decided_at = ? where kind = 'connector' and status = 'pending' and (connector_id like 'claude:%' or connector_id like 'codex:%')").run(now);
  db.exec(`delete from connector_policies where connector_id like 'claude:%' or connector_id like 'codex:%';
drop table discovered_connectors;
pragma user_version = 23;`);
}

/**
 * 23 to 24 in place, inside openSchema's transaction: a routine may have its own time limit for a run. Every routine
 * starts without one, so each keeps the server's limit (BOTONS_TURN_TIMEOUT_MS) as before; every row stays as it is.
 * The column is written in SCHEMA as this "add column" leaves it, so a new database gets the same schema.
 */
function upgradeFrom23(db: DatabaseSync): void {
  db.exec(`alter table routines add column time_limit_ms integer;
pragma user_version = 24;`);
}

/**
 * 24 to 25 in place, inside openSchema's transaction: the version marks a new kind of look, which a release that
 * draws capsules cannot read. Looks themselves change in 31 to 32, which reads a capsule as well.
 */
function upgradeFrom24(db: DatabaseSync): void {
  db.exec('pragma user_version = 25;');
}

/**
 * 25 to 26 in place, inside openSchema's transaction: a Boton may set how hard its agent CLI thinks, and a routine
 * may set its own. Every Boton starts at "" (the provider's default) and every routine at null (the Boton's), so
 * each turn runs as before; every row stays as it is. The columns are written in SCHEMA as these "add column"s leave
 * them, so a new database gets the same schema.
 */
function upgradeFrom25(db: DatabaseSync): void {
  db.exec(`alter table bots add column effort text not null default '';
alter table routines add column effort text;
pragma user_version = 26;`);
}

/**
 * 26 to 27 in place, inside openSchema's transaction: groups in the sidebar become their own rows, with an id that
 * stays when they are renamed, an order and a collapsed state, and Botons keep an order there. Each group name in
 * use becomes a group (names with the same sidebarGroupKey become one, spelled as the first in code-point order), the
 * groups ordered by name, each group's Botons and the pinned ones by latest activity: the order the sidebar shows
 * them in. bots.group_name goes; every other row stays as it is. The columns are written in SCHEMA as these
 * "alter table"s leave them, so a new database gets the same schema.
 */
function upgradeFrom26(db: DatabaseSync): void {
  db.exec(`${SIDEBAR_27}alter table bots add column group_id text references sidebar_groups(id) on delete set null;
alter table bots add column position integer not null default 0;
alter table bots add column pin_position integer not null default 0;`);
  const now = new Date().toISOString();
  const names = new Map<string, string>();
  for (const r of db.prepare("select distinct group_name from bots where group_name != '' order by group_name").all()) {
    const name = String(r.group_name);
    if (!names.has(sidebarGroupKey(name))) names.set(sidebarGroupKey(name), name);
  }
  const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));
  const add = db.prepare('insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values (?, ?, ?, ?, 0, ?, ?)');
  const ids = new Map<string, string>();
  sorted.forEach((name, i) => {
    const id = newId('grp');
    ids.set(sidebarGroupKey(name), id);
    add.run(id, name, sidebarGroupKey(name), i, now, now);
  });
  const place = db.prepare('update bots set group_id = ?, position = ? where id = ?');
  const next = new Map<string | null, number>();
  for (const b of db.prepare('select id, group_name from bots order by last_activity_at desc, rowid').all()) {
    const group = String(b.group_name) ? ids.get(sidebarGroupKey(String(b.group_name)))! : null;
    const n = next.get(group) ?? 0;
    next.set(group, n + 1);
    place.run(group, n, b.id);
  }
  const pin = db.prepare('update bots set pin_position = ? where id = ?');
  db.prepare('select id from bots where pinned = 1 order by last_activity_at desc, rowid')
    .all()
    .forEach((b, i) => pin.run(i, b.id));
  db.exec(`alter table bots drop column group_name;
pragma user_version = 27;`);
}

/**
 * 27 to 28 in place, inside openSchema's transaction: a skill may come from a package (its source) and may be turned
 * off, and replaced texts are kept. Every skill starts written here (no source) and on, so each Boton sees the skills
 * it saw before; every row stays as it is. The columns are written in SCHEMA as these "add column"s leave them, so a
 * new database gets the same schema.
 */
function upgradeFrom27(db: DatabaseSync): void {
  db.exec(`alter table skills add column source text;
alter table skills add column disabled integer not null default 0;
${SKILL_HISTORY_28}pragma user_version = 28;`);
}

/**
 * 28 to 29 in place, inside openSchema's transaction: the messages' indexes for the replay. Rows are only
 * read, so every message, pin, session and setting stays as it was; a meta that isn't JSON reads as none.
 */
function upgradeFrom28(db: DatabaseSync): void {
  db.exec(`${MESSAGE_INDEXES_29}pragma user_version = 29;`);
}

/**
 * 29 to 30 in place, inside openSchema's transaction: the reactions' tables, empty. Every message, pin and setting
 * stays as it was.
 */
function upgradeFrom29(db: DatabaseSync): void {
  db.exec(`${REACTIONS_30}pragma user_version = 30;`);
}

/**
 * 30 to 31 in place, inside openSchema's transaction: the account of API-key requests. A turn on an API key already
 * recorded becomes one settled row at its start, at the cost it recorded (or, with tokens and no cost, one with no
 * known price), so today's spending and a run's stay what they were. Every other row stays as it was.
 */
function upgradeFrom30(db: DatabaseSync): void {
  db.exec(`${API_REQUESTS_31}insert into api_requests (id, bot_id, turn_id, run_id, routine_id, provider, model, at, reserved_usd, cost_usd, state, ended_at)
  select 'req_' || t.id, t.bot_id, t.id, t.run_id, t.routine_id, t.provider, coalesce(t.model, t.requested_model), t.started_at, t.cost_usd, t.cost_usd, 'settled', t.started_at
  from turns t join bots b on b.id = t.bot_id
  where t.provider in ('anthropic-api', 'openai-api') and (t.cost_usd is not null or t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens > 0);
pragma user_version = 31;`);
}

/**
 * 31 to 32 in place, inside openSchema's transaction: every Boton's look becomes a tater look. A Critter (or a capsule)
 * maps to its closest tater look (taterLookFor in shared/look-tater.ts), the same on every machine; a look that can't
 * be read gets one seeded by the Boton's id. The look it had is kept, as it was, in previous_look, so nothing is lost and the
 * change can be undone. Only those two columns change: ids, names, sessions, grants, connectors, routines and every
 * other row stay as they are.
 */
function upgradeFrom31(db: DatabaseSync): void {
  db.exec('alter table bots add column previous_look text;');
  const save = db.prepare('update bots set look = ?, previous_look = ? where id = ?');
  for (const b of db.prepare('select id, look from bots order by rowid').all()) {
    let stored: unknown = null;
    try {
      stored = JSON.parse(String(b.look));
    } catch {}
    save.run(JSON.stringify(taterLookFor(stored, String(b.id))), String(b.look), b.id);
  }
  db.exec('pragma user_version = 32;');
}

/**
 * 32 to 33 in place, inside openSchema's transaction: every Boton's look becomes a Boton. A tater look maps to its
 * closest Boton (lookFor in shared/look.ts), field by field and the same on every machine; a look that is already a
 * Boton stays as it is, and one that can't be read gets a Boton seeded by the Boton's id. The look it had is kept, as
 * it was, in tater_look, so nothing is lost and the change can be undone (previous_look keeps what it holds). Only
 * those two columns change: ids, names, sessions, grants, connectors, routines and every other row stay as they are.
 */
function upgradeFrom32(db: DatabaseSync): void {
  db.exec('alter table bots add column tater_look text;');
  const save = db.prepare('update bots set look = ?, tater_look = ? where id = ?');
  for (const b of db.prepare('select id, look from bots order by rowid').all()) {
    let stored: unknown = null;
    try {
      stored = JSON.parse(String(b.look));
    } catch {}
    save.run(JSON.stringify(lookFor(stored, String(b.id))), String(b.look), b.id);
  }
  db.exec('pragma user_version = 33;');
}

/**
 * 33 to 34 in place, inside openSchema's transaction: each routine's webhook_history, how many of the chat's latest
 * messages its webhook runs are given, starts at 0 (none) whatever its session: sharing the chat with a payload from
 * outside is the owner's to turn on. Every other column and row stays as it was.
 */
function upgradeFrom33(db: DatabaseSync): void {
  db.exec(`alter table routines add column webhook_history integer not null default 0;
pragma user_version = 34;`);
}

/**
 * 34 to 35 in place, inside openSchema's transaction: the names stored under the app's earlier name take its
 * current one (shared/legacy-names.mjs). An actor's kind becomes "boton" in the audit log, reactions and turn
 * tokens, and of a skill's author; the audit log's actions, target kinds and detail keys follow; and the managed browser's connector id is
 * lib:botons_browser wherever a connector id is kept. The three tables whose CHECKs name the kind are rebuilt with
 * the same rows, under the same definitions a new database gets. Nothing else changes.
 */
function upgradeFrom34(db: DatabaseSync): void {
  const old = RENAMED.boton;
  const kind = (col: string) => `case ${col} when '${old}' then 'boton' else ${col} end`;
  db.exec(`drop index audit_events_at;
alter table audit_events rename to audit_events_34;
${AUDIT_EVENTS}
insert into audit_events (seq, at, actor_kind, actor_id, actor_label, action, target_kind, target_id, target_label, details)
  select seq, at, ${kind('actor_kind')}, actor_id, actor_label,
    case when action like '${old}.%' then 'boton.' || substr(action, ${old.length + 2}) else replace(action, '.${old}s_changed', '.botons_changed') end,
    ${kind('target_kind')}, target_id, target_label, replace(replace(details, '"${old}":', '"boton":'), '"${old}s":', '"botons":')
  from audit_events_34 order by seq;
delete from sqlite_sequence where name = 'audit_events';
insert into sqlite_sequence (name, seq) select 'audit_events', seq from sqlite_sequence where name = 'audit_events_34';
drop table audit_events_34;
drop index if exists message_reactions_${old};
drop index if exists message_reactions_boton;
drop index message_reactions_untold;
alter table message_reactions rename to message_reactions_34;
${MESSAGE_REACTIONS}
insert into message_reactions (message_id, bot_id, actor, emoji, created_at, told_at)
  select message_id, bot_id, ${kind('actor')}, emoji, created_at, told_at from message_reactions_34 order by rowid;
drop table message_reactions_34;
drop index auth_tokens_bot;
alter table auth_tokens rename to auth_tokens_34;
${AUTH_TOKENS}
insert into auth_tokens (id, hash, kind, bot_id, label, created_at, last_used_at)
  select id, hash, ${kind('kind')}, bot_id, label, created_at, last_used_at from auth_tokens_34 order by rowid;
drop table auth_tokens_34;`);
  // Who wrote a skill (or a text it replaced), kept as JSON with the author's kind.
  const author = (col: string) => `${col} = replace(${col}, '"kind":"${old}"', '"kind":"boton"')`;
  db.exec(`update skills set ${author('created_by')}, ${author('updated_by')};
update skill_history set ${author('replaced_by')};`);
  // A connector id, wherever one is kept, from `from` to `to`: grants, policies, notices, approvals and whether it is off.
  const renameConnector = (from: string, to: string) => {
    for (const table of ['approvals', 'connector_policies', 'connector_notices']) db.prepare(`update ${table} set connector_id = ? where connector_id = ?`).run(to, from);
    db.prepare('update bots set connections = replace(connections, ?, ?) where instr(connections, ?) > 0').run(JSON.stringify(from), JSON.stringify(to), JSON.stringify(from));
    db.prepare('update settings set key = ? where key = ?').run(`connector_off:${to}`, `connector_off:${from}`);
  };
  // An id nothing refers to yet: no connector, grant, policy, notice, approval or off switch has it.
  const taken = (id: string) =>
    !!db.prepare('select 1 from mcp_servers where name = ?').get(id.slice(4)) ||
    ['approvals', 'connector_policies', 'connector_notices'].some((t) => db.prepare(`select 1 from ${t} where connector_id = ?`).get(id)) ||
    !!db.prepare('select 1 from bots where instr(connections, ?) > 0').get(JSON.stringify(id)) ||
    !!db.prepare('select 1 from settings where key = ?').get(`connector_off:${id}`);
  // A connector of the owner's own that already has the browser's new name takes a free one first, with every grant,
  // policy, notice and off switch of it, so none of them ever reads as the browser's.
  if (db.prepare("select 1 from mcp_servers where name = 'botons_browser'").get()) {
    let n = 2;
    while (taken(`lib:botons_browser_${n}`)) n++;
    renameConnector('lib:botons_browser', `lib:botons_browser_${n}`);
    db.prepare("update mcp_servers set name = ? where name = 'botons_browser'").run(`botons_browser_${n}`);
  }
  renameConnector(`lib:${RENAMED.botons_browser}`, 'lib:botons_browser');
  db.exec('pragma user_version = 35;');
}

/** Each step takes the database one version up; openSchema runs them in order from the version it finds. */
const UPGRADES: Record<number, (db: DatabaseSync) => void> = {
  20: upgradeFrom20,
  21: upgradeFrom21,
  22: upgradeFrom22,
  23: upgradeFrom23,
  24: upgradeFrom24,
  25: upgradeFrom25,
  26: upgradeFrom26,
  27: upgradeFrom27,
  28: upgradeFrom28,
  29: upgradeFrom29,
  30: upgradeFrom30,
  31: upgradeFrom31,
  32: upgradeFrom32,
  33: upgradeFrom33,
  34: upgradeFrom34,
};

/** The older versions openSchema upgrades in place. */
export const UPGRADABLE_VERSIONS: readonly number[] = Object.keys(UPGRADES).map(Number);

/** The database is not one this code can open. Restarting will not help. */
export class SchemaError extends Error {}

const userVersion = (db: DatabaseSync) => Number(db.prepare('pragma user_version').get()!.user_version);

/**
 * Use a database at SCHEMA_VERSION as it is, or create the schema in an empty one; refuse anything else. An older
 * version it can upgrade is upgraded in place, after `beforeUpgrade` (a backup) has returned: it runs under the
 * write lock, so nothing changes between the two, and if it throws the database is left as it was.
 */
export function openSchema(db: DatabaseSync, opts: { beforeUpgrade?: (version: number) => void } = {}): void {
  if (userVersion(db) === SCHEMA_VERSION) return;
  db.exec('begin immediate');
  try {
    // Read again under the lock: another process may have created it meanwhile.
    const version = userVersion(db);
    if (version === 0 && !db.prepare('select 1 from sqlite_master limit 1').get()) db.exec(`${SCHEMA}pragma user_version = ${SCHEMA_VERSION};`);
    else if (UPGRADES[version]) {
      try {
        opts.beforeUpgrade?.(version);
      } catch (err) {
        throw new SchemaError(`The database is at schema version ${version} and needs upgrading to ${SCHEMA_VERSION}, but backing it up first failed (${(err as Error).message}), so it was left as it was. Fix that (or run \`${serverCommand('backup')}\` to see why) and start again.`);
      }
      for (let v = version; v < SCHEMA_VERSION; v++) {
        try {
          UPGRADES[v](db);
        } catch (err) {
          throw new SchemaError(`The database is at schema version ${version}, but upgrading it to ${SCHEMA_VERSION} failed (${(err as Error).message}), so it was left as it was. Restore a backup (see docs/backups.md).`);
        }
      }
    }
    else if (version !== SCHEMA_VERSION) throw new SchemaError(refusal(version));
    db.exec('commit');
  } catch (err) {
    if (db.isTransaction) db.exec('rollback');
    throw err;
  }
}

function refusal(version: number): string {
  if (version > SCHEMA_VERSION) {
    return (
      `The database is at schema version ${version}, but this version of Botons only knows versions up to ${SCHEMA_VERSION}. ` +
      'It was upgraded by a newer Botons. Run that newer version, or restore a backup taken before the upgrade (see docs/backups.md).'
    );
  }
  return (
    `The database ${version ? `is at schema version ${version}` : 'has no schema version'}, but this version of Botons only opens schema version ${SCHEMA_VERSION} (or ${Object.keys(UPGRADES).join(' or ')}, which it upgrades) or an empty database. ` +
    `Restore a backup at version ${SCHEMA_VERSION} (see docs/backups.md), or set BOTONS_HOME to an empty folder to start over.`
  );
}
