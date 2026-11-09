-- The schema at version 22, for the upgrade test.
CREATE TABLE settings (
  key text primary key,
  value text not null
);
CREATE TABLE bots (
  id text primary key,
  name text not null,
  title text not null default '',
  instructions text not null default '',
  look text not null,
  provider text not null,
  model text not null default '',
  access text not null default 'workspace',
  group_name text not null default '',
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
);
CREATE TABLE messages (
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
CREATE INDEX messages_bot on messages(bot_id, seq);
CREATE INDEX messages_pending on messages(bot_id, pending) where pending = 1;
CREATE TABLE routines (
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
);
CREATE INDEX routines_due on routines(enabled, next_run_at);
CREATE TABLE routine_runs (
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
CREATE INDEX runs_routine on routine_runs(routine_id, seq);
CREATE TABLE memories (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  text text not null,
  created_at text not null
);
CREATE TABLE auth_tokens (
  id text primary key,
  hash text not null unique,
  kind text not null check (kind in ('device', 'minion')),
  bot_id text references bots(id) on delete cascade,
  label text not null default '',
  created_at text not null,
  last_used_at text,
  check ((kind = 'minion') = (bot_id is not null))
);
CREATE INDEX auth_tokens_bot on auth_tokens(bot_id);
CREATE TABLE provider_cooldowns (
  provider text primary key,
  until text not null,
  reason text not null
);
CREATE TABLE webhook_deliveries (
  routine_id text not null references routines(id) on delete cascade,
  delivery_id text not null,
  run_id text not null,
  created_at text not null,
  primary key (routine_id, delivery_id)
);
CREATE INDEX webhook_deliveries_created on webhook_deliveries(created_at);
CREATE TABLE mcp_servers (
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
CREATE TABLE discovered_connectors (
  provider text primary key,
  checked_at text,
  error text,
  servers text not null default '[]'
);
CREATE TABLE skills (
  name text primary key,
  description text not null,
  body text not null,
  created_by text not null,
  updated_by text not null,
  created_at text not null,
  updated_at text not null
);
CREATE TABLE turns (
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
CREATE INDEX turns_started on turns(started_at);
CREATE INDEX turns_bot on turns(bot_id, started_at);
CREATE INDEX turns_run on turns(run_id) where run_id is not null;
CREATE INDEX turns_message on turns(message_id) where message_id is not null;
CREATE TABLE turn_steps (
  turn_id text not null references turns(id) on delete cascade,
  idx integer not null,
  kind text not null,
  label text not null,
  detail text not null,
  at text not null,
  primary key (turn_id, idx)
);
CREATE TABLE approvals (
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
CREATE INDEX approvals_bot on approvals(bot_id, created_at);
CREATE INDEX approvals_pending on approvals(status, expires_at) where status = 'pending';
CREATE INDEX approvals_tool on approvals(bot_id, tool_key) where tool_key is not null;
CREATE TABLE oauth_connections (
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
CREATE TABLE oauth_flows (
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
CREATE INDEX oauth_flows_expiry on oauth_flows(expires_at);
CREATE TABLE connector_policies (
  connector_id text primary key,
  on_request integer not null default 0,
  grant_mode text not null default 'approval' check (grant_mode in ('approval', 'immediate')),
  generation integer not null default 1,
  updated_at text not null
);
CREATE TABLE work_jobs (
  connection_id text not null references oauth_connections(id) on delete cascade,
  job_id text not null,
  bot_id text not null references bots(id) on delete cascade,
  call_id text,
  created_at text not null,
  primary key (connection_id, job_id)
);
CREATE TABLE work_feed_seen (
  connection_id text not null references oauth_connections(id) on delete cascade,
  key text not null,
  value text not null default '',
  at text not null,
  primary key (connection_id, key)
);
CREATE INDEX work_feed_seen_at on work_feed_seen(connection_id, at);
CREATE TABLE work_feed_held (
  connection_id text not null references oauth_connections(id) on delete cascade,
  event_id text not null,
  job_id text not null,
  event text not null,
  held_at text not null,
  primary key (connection_id, event_id)
);
CREATE TABLE audit_events (
  seq integer primary key autoincrement,
  at text not null,
  actor_kind text not null check (actor_kind in ('device', 'minion', 'host', 'system')),
  actor_id text,
  actor_label text not null default '',
  action text not null,
  target_kind text,
  target_id text,
  target_label text not null default '',
  details text not null default '{}'
);
CREATE INDEX audit_events_at on audit_events(at);
CREATE TABLE pairing_requests (
  secret_hash text primary key,
  code_hash text not null unique,
  label text not null default '',
  created_at text not null,
  expires_at text not null,
  approved_at text,
  approved_label text
);
