-- The schema at version 20, for the upgrade test.
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
);
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
create table auth_tokens (
  id text primary key,
  hash text not null unique,
  kind text not null check (kind in ('device', 'minion')),
  bot_id text references bots(id) on delete cascade,
  label text not null default '',
  created_at text not null,
  last_used_at text,
  check ((kind = 'minion') = (bot_id is not null))
);
create index auth_tokens_bot on auth_tokens(bot_id);
create table pairing_codes (
  hash text primary key,
  label text not null default '',
  created_at text not null,
  expires_at text not null
);
create table provider_cooldowns (
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
create table discovered_connectors (
  provider text primary key,
  checked_at text,
  error text,
  servers text not null default '[]'
);
create table skills (
  name text primary key,
  description text not null,
  body text not null,
  created_by text not null,
  updated_by text not null,
  created_at text not null,
  updated_at text not null
);
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
create table approvals (
  id text primary key,
  bot_id text not null references bots(id) on delete cascade,
  kind text not null check (kind in ('action', 'skill')),
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
  skill_version text
);
create index approvals_bot on approvals(bot_id, created_at);
create index approvals_pending on approvals(status, expires_at) where status = 'pending';
create index approvals_tool on approvals(bot_id, tool_key) where tool_key is not null;
