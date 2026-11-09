import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Config, loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import { backup } from '../src/backup.ts';
import { lookFor, lookFromTater, parseLook, randomLook } from '../../shared/look.ts';
import { parseTater, taterLookFor } from '../../shared/look-tater.ts';
import { RENAMED } from '../../shared/legacy-names.mjs';
import { SCHEMA_VERSION, SchemaError } from '../src/schema.ts';
import { Store } from '../src/store.ts';
import { freePort, noRealClis, tempDir } from './helpers.ts';

const tmpHome = () => loadConfig({ BOTONS_HOME: tempDir('botons-schema-test-'), BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1' });
const open = (cfg: Config) => new Store(cfg, new EventHub(), () => ({ state: 'idle', activity: null, since: null }));

function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Tables a later upgrade adds, empty after it: left out when comparing an upgrade's tables with the ones before. */
const ADDED_LATER = ['skill_history', 'message_reactions', 'reaction_followups', 'api_requests'];

const tablesOf = (d: { schema: unknown[] }) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
/** A dump's rows of these tables, in this order. */
const rowsOf = (d: { schema: unknown[]; rows: unknown[][] }, names: string[]) => names.map((n) => d.rows[tablesOf(d).indexOf(n)]);

/**
 * The schema version, the schema and every row, with each Boton's previous and tater looks and each routine's
 * webhook_history set aside: 31 to 32, 32 to 33 and 33 to 34 fill them in on every upgrade from before, and their own
 * tests read them.
 */
const dump = (path: string) =>
  withDb(path, (db) => ({
    version: db.prepare('pragma user_version').get()!.user_version,
    schema: db.prepare('select type, name, sql from sqlite_master order by name').all(),
    rows: db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map(({ name }) =>
        db
          .prepare(`select * from "${name}" order by rowid`)
          .all()
          .map(({ previous_look, tater_look, ...r }) => (name === 'bots' ? r : { previous_look, tater_look, ...r }))
          .map(({ webhook_history, ...r }) => (name === 'routines' ? r : { webhook_history, ...r })),
      ),
  }));

/**
 * A dump at the latest version as it reads at 26, for the older upgrades: no sidebar_groups, and each Boton's group
 * by name in group_name again (27 keeps it as a group row; its own test checks the order).
 */
function as26(d: ReturnType<typeof dump>): ReturnType<typeof dump> {
  const names = d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  const groups = d.rows[names.indexOf('sidebar_groups')];
  const nameOf = new Map(groups.map((g) => [g.id, g.name]));
  const rows = d.rows.map((r, i) =>
    names[i] !== 'bots' ? r : r.map(({ group_id, position: _p, pin_position: _q, ...b }) => ({ ...b, group_name: nameOf.get(group_id) ?? '' })),
  );
  const keep = names.map((n) => n !== 'sidebar_groups');
  return {
    ...d,
    schema: d.schema.filter((x) => !String((x as { name: string }).name).startsWith('sidebar_groups')),
    rows: rows.filter((_, i) => keep[i]),
  };
}

/**
 * A table's rows with each Boton's look and effort, and each routine's effort, set aside: every upgrade ends at the
 * latest version, 31 to 32 and 32 to 33 turn each look into a Boton (their own tests check how), 25 to 26 adds the
 * efforts and 27 to 28 each skill's source and switch. Asserts that every look after is a Boton, every effort the default, and every
 * skill written here and on.
 */
const lookless = (name: string, rows: unknown, after = false) =>
  name === 'skills'
    ? (rows as Record<string, unknown>[]).map(({ source, disabled, ...r }) => {
        if (after) assert.deepEqual([source, disabled], [null, 0], `${String(r.name)} stays written here, and on`);
        return r;
      })
    : name === 'routines'
    ? (rows as Record<string, unknown>[]).map(({ effort, ...r }) => {
        if (after) assert.equal(effort, null, `${String(r.id)} uses its Boton's effort`);
        return r;
      })
    : name !== 'bots'
      ? rows
      : (rows as Record<string, unknown>[]).map(({ look, effort, ...r }) => {
          if (after) {
            assert.ok(parseLook(JSON.parse(String(look))), `${String(r.id)}'s look is a Boton: ${String(look)}`);
            assert.equal(effort, '', `${String(r.id)} runs at its provider's default effort`);
          }
          return r;
        });

/**
 * A dump's rows with each Boton's look set aside, for the upgrades before 32 to 33: every one ends at the latest
 * version, where 32 to 33 draws each look as a Boton (its own test checks how). Asserts every look after is one.
 */
function looksAside(d: ReturnType<typeof dump>, after = false): unknown[][] {
  const names = tablesOf(d);
  return d.rows.map((rows, i) =>
    names[i] !== 'bots'
      ? rows
      : (rows as Record<string, unknown>[]).map(({ look, ...r }) => {
          if (after) assert.ok(parseLook(JSON.parse(String(look))), `${String(r.id)}'s look is a Boton: ${String(look)}`);
          return r;
        }),
  );
}

test('a new database gets the schema at SCHEMA_VERSION; reopening it changes nothing and keeps its rows', () => {
  const cfg = tmpHome();
  let store = open(cfg);
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1, String(SCHEMA_VERSION));
  assert.equal(store.db.prepare('pragma user_version').get()!.user_version, SCHEMA_VERSION);
  assert.equal(store.db.prepare('pragma foreign_keys').get()!.foreign_keys, 1);
  const bot = store.createBot({ name: 'Fresh Face', provider: 'mock' }, new Set(['mock']), 'mock');
  store.addMessage(bot.id, 'user', 'hello');
  // Workspaces are stored relative to the workspaces folder; an absolute one reads as it is.
  assert.equal(store.db.prepare('select workspace from bots where id = ?').get(bot.id)!.workspace, `fresh-face-${bot.id.slice(4)}`);
  assert.equal(bot.workspace, join(cfg.workspacesDir, `fresh-face-${bot.id.slice(4)}`));
  const other = store.createBot({ name: 'Elsewhere', provider: 'mock' }, new Set(['mock']), 'mock');
  store.db.prepare('update bots set workspace = ? where id = ?').run('/srv/elsewhere', other.id);
  store.db.close();

  const before = dump(cfg.dbPath);
  store = open(cfg);
  assert.deepEqual(store.listMessages(bot.id).map((m) => m.text), ['hello']);
  assert.equal(store.getBot(other.id).workspace, '/srv/elsewhere');
  store.db.close();
  assert.deepEqual(dump(cfg.dbPath), before);
});

test('a database at any other version is refused and left as it was', () => {
  // 20 to 31 are upgraded in place; anything older is refused.
  const [lower, higher] = [19, SCHEMA_VERSION + 1];
  const cases: [string, RegExp][] = [
    ["create table bots (id text primary key); insert into bots values ('bot_1')", /has no schema version/],
    ['create table bots (id text primary key); pragma user_version = 20', /is at schema version 20, but upgrading it to \d+ failed \(no such table: approvals\), so it was left as it was/],
    ['create table audit_events (seq integer); pragma user_version = 21', /is at schema version 21, but upgrading it to \d+ failed \(table audit_events already exists\), so it was left as it was/],
    ['create table connector_notices (x integer); pragma user_version = 22', /is at schema version 22, but upgrading it to \d+ failed \(table connector_notices already exists\), so it was left as it was/],
    ['create table routines (id text primary key, time_limit_ms integer); pragma user_version = 23', /is at schema version 23, but upgrading it to \d+ failed \(duplicate column name: time_limit_ms\), so it was left as it was/],
    ['create table settings (key text primary key); pragma user_version = 24', /is at schema version 24, but upgrading it to \d+ failed \(no such table: bots\), so it was left as it was/],
    ['create table bots (id text primary key, effort text); pragma user_version = 25', /is at schema version 25, but upgrading it to \d+ failed \(duplicate column name: effort\), so it was left as it was/],
    ['create table sidebar_groups (x integer); pragma user_version = 26', /is at schema version 26, but upgrading it to \d+ failed \(table sidebar_groups already exists\), so it was left as it was/],
    ['create table skills (name text primary key, source text); pragma user_version = 27', /is at schema version 27, but upgrading it to \d+ failed \(duplicate column name: source\), so it was left as it was/],
    ['create table messages (bot_id text, seq integer); create index messages_pinned on messages(bot_id); pragma user_version = 28', /is at schema version 28, but upgrading it to \d+ failed \(index messages_pinned already exists\), so it was left as it was/],
    ['create table message_reactions (x integer); pragma user_version = 29', /is at schema version 29, but upgrading it to \d+ failed \(table message_reactions already exists\), so it was left as it was/],
    ['create table bots (id text primary key, previous_look text); pragma user_version = 31', /is at schema version 31, but upgrading it to \d+ failed \(duplicate column name: previous_look\), so it was left as it was/],
    ['create table bots (id text primary key, tater_look text); pragma user_version = 32', /is at schema version 32, but upgrading it to \d+ failed \(duplicate column name: tater_look\), so it was left as it was/],
    [`create table bots (id text primary key); pragma user_version = ${higher}`, new RegExp(`is at schema version ${higher}, but this version of Botons only knows versions up to ${SCHEMA_VERSION}\\.`)],
  ];
  if (lower > 0) {
    cases.push([
      `create table bots (id text primary key); pragma user_version = ${lower}`,
      new RegExp(`is at schema version ${lower}, but this version of Botons only opens schema version ${SCHEMA_VERSION} \\(or 20 or 21 or 22 or 23 or 24 or 25 or 26 or 27 or 28 or 29 or 30 or 31 or 32 or 33 or 34, which it upgrades\\) or an empty database\\.`),
    ]);
  }
  for (const [sql, message] of cases) {
    const cfg = tmpHome();
    withDb(cfg.dbPath, (db) => db.exec(sql));
    const before = dump(cfg.dbPath);
    assert.throws(() => open(cfg), (err: Error) => err instanceof SchemaError && message.test(err.message));
    assert.deepEqual(dump(cfg.dbPath), before, sql);
  }
});

/** Start the server on `cfg.home` and wait for it to exit (it should not get as far as listening). */
async function startAndExit(cfg: Config, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/index.ts')], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT' && !k.startsWith('BOTONS_'))),
      BOTONS_HOME: cfg.home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(await freePort()), BOTONS_NO_TAILSCALE: '1', ...noRealClis(cfg.home),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  // One that starts listening instead is stopped, and fails the test for its exit code.
  const stop = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  clearTimeout(stop);
  return { code, stdout };
}

test('the server exits 78 and says why when it cannot open the database', async () => {
  const cfg = tmpHome();
  withDb(cfg.dbPath, (db) => db.exec('create table bots (id text primary key)'));
  const { code, stdout } = await startAndExit(cfg);
  assert.equal(code, 78, stdout);
  const why = stdout.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.level === 'error');
  assert.ok(why?.msg.startsWith(`Botons cannot open ${cfg.dbPath}: The database has no schema version`), stdout);
  assert.doesNotMatch(stdout, /is running/);
});

test('20 upgrades to 21 in place (and on): every row kept (sessions, connectors, grants, approvals, routines, devices), and the schema a new database gets', async () => {
  const cfg = tmpHome();
  const v20 = readFileSync(join(import.meta.dirname, 'fixtures/schema-20.sql'), 'utf8');
  const now = '2026-11-05T09:00:00.000Z';
  withDb(cfg.dbPath, (db) => {
    db.exec(`${v20}\npragma user_version = 20;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare(
      "insert into bots (id, name, look, provider, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at, connections, always_allow) values ('bot_kevin', 'Kevin', '{}', 'claude-cli', 'UTC', 'kevin', 'sess-1', 'key-1', ?, ?, ?, '[\"lib:github\",\"claude:linear\"]', '[\"git push\"]')",
    ).run(now, now, now);
    db.prepare("insert into mcp_servers (name, transport, url, headers, created_at, updated_at) values ('github', 'http', 'https://mcp.example.com/mcp', '{\"Authorization\":\"Bearer kept\"}', ?, ?)").run(now, now);
    db.prepare("insert into routines (id, bot_id, name, instruction, schedule, timezone, webhook_key, created_at, updated_at) values ('rtn_1', 'bot_kevin', 'Brief', 'Do it', 'cron 0 8 * * *', 'UTC', 'whk_1', ?, ?)").run(now, now);
    db.prepare("insert into auth_tokens (id, hash, kind, label, created_at) values ('dev_1', 'hash-1', 'device', 'Phone', ?)").run(now);
    db.prepare("insert into pairing_codes (hash, label, created_at, expires_at) values ('code-hash', 'iPad', ?, ?)").run(now, now);
    for (const [, , , extra] of [
      ['apr_a', 'action', 'pending', "action, tool_name, tool_input, tool_key, wait_until) values ('apr_a', 'bot_kevin', 'action', 'Push', 'pending', 'chat', '[]', '2026-11-05T09:00:00.000Z', 'git push', 'Bash', '{}', 'k1', '2026-11-05T09:00:00.000Z')"],
      ['apr_s', 'skill', 'allowed', "skill_name, skill_version) values ('apr_s', 'bot_kevin', 'skill', 'Skill', 'allowed', 'chat', '[]', '2026-11-05T09:00:00.000Z', 'weekly', 'v1')"],
    ] as const) {
      db.exec(`insert into approvals (id, bot_id, kind, title, status, trigger, asked_by, created_at, ${extra}`);
    }
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  assert.equal(store.db.prepare('pragma user_version').get()!.user_version, SCHEMA_VERSION);
  const bot = store.getBot('bot_kevin');
  // 23 takes the connector from Claude Code's own settings off it, with a notice.
  assert.deepEqual([bot.sessionId, bot.sessionKey, bot.connections, bot.alwaysAllow], ['sess-1', 'key-1', ['lib:github'], ['git push']]);
  assert.deepEqual(store.db.prepare('select bot_id, connector_id, kind, name from connector_notices').all().map((r) => ({ ...r })), [
    { bot_id: 'bot_kevin', connector_id: 'claude:linear', kind: 'removed', name: 'linear' },
  ]);
  assert.equal(store.getRoutine('rtn_1').name, 'Brief');
  const approvals = store.db.prepare('select id, kind, status, tool_key, skill_version, connector_id from approvals order by id').all();
  assert.deepEqual(approvals.map((r) => ({ ...r })), [
    { id: 'apr_a', kind: 'action', status: 'pending', tool_key: 'k1', skill_version: null, connector_id: null },
    { id: 'apr_s', kind: 'skill', status: 'allowed', tool_key: null, skill_version: 'v1', connector_id: null },
  ]);
  // Connector requests are a kind of approval now.
  store.db.prepare("insert into approvals (id, bot_id, kind, title, status, trigger, asked_by, created_at, connector_id, connector_generation) values ('apr_c', 'bot_kevin', 'connector', 'Fleet', 'pending', 'chat', '[]', ?, 'oauth:fleet', 1)").run(now);
  store.db.prepare("delete from approvals where id = 'apr_c'").run();
  store.db.close();
  const after = as26(dump(cfg.dbPath));
  // Every table that was there has the same rows (approvals gained two empty columns), except pairing codes, which 22
  // drops, and the CLIs' own connectors, which 23 drops (a Boton's connections lose them).
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.ok(!tables(after).includes('pairing_codes'));
  assert.ok(!tables(after).includes('discovered_connectors'));
  for (const [i, name] of tables(before).entries()) {
    if (name === 'pairing_codes' || name === 'discovered_connectors') continue;
    const j = tables(after).indexOf(name);
    // Routines gained a time limit (24), none set: each keeps the server's.
    const keep = (r: Record<string, unknown>) =>
      name === 'approvals'
        ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('connector_')))
        : name === 'bots'
          ? { ...r, connections: undefined, look: undefined, effort: undefined }
          : name === 'routines'
            ? Object.fromEntries(Object.entries(r).filter(([k, v]) => !((k === 'time_limit_ms' || k === 'effort') && v === null)))
            : { ...r };
    assert.deepEqual((after.rows[j] as Record<string, unknown>[]).map(keep), (before.rows[i] as Record<string, unknown>[]).map(keep), name);
    lookless(name, after.rows[j], true);
  }
  // The same schema as a new database.
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(dump(cfg.dbPath).version, SCHEMA_VERSION);

  // A backup of the upgraded database (with an OAuth connector's tokens in it) is private and complete.
  const db = new DatabaseSync(cfg.dbPath);
  db.prepare("insert into oauth_connections (id, name, url, status, access_token, refresh_token, created_at, updated_at) values ('oac_1', 'fleet', 'https://gw.example.com/mcp', 'connected', 'at', 'rt', ?, ?)").run(now, now);
  db.close();
  const result = backup({ home: cfg.home });
  const copy = new DatabaseSync(join(result.dir, 'botons.db'), { readOnly: true });
  assert.equal(copy.prepare('select count(*) as n from oauth_connections').get()!.n, 1);
  copy.close();
  assert.equal(statSync(result.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(result.dir, 'botons.db')).mode & 0o777, 0o600);
});

test('21 upgrades to 22 in place: every row kept and devices still paired, pairing codes dropped (a code alone pairs nothing now), and the schema a new database gets', () => {
  const cfg = tmpHome();
  const v21 = readFileSync(join(import.meta.dirname, 'fixtures/schema-21.sql'), 'utf8');
  const now = '2026-11-06T09:00:00.000Z';
  withDb(cfg.dbPath, (db) => {
    db.exec(`${v21}\npragma user_version = 21;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare(
      "insert into bots (id, name, look, provider, access, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at, connections) values ('bot_dave', 'Dave', '{}', 'claude-cli', 'host', 'UTC', 'dave', 'sess-2', 'key-2', ?, ?, ?, '[\"oauth:fleet\"]')",
    ).run(now, now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_dave', 'user', 'hi', ?)").run(now);
    db.prepare("insert into auth_tokens (id, hash, kind, label, created_at) values ('dev_1', 'hash-1', 'device', 'Phone', ?)").run(now);
    db.prepare("insert into pairing_codes (hash, label, created_at, expires_at) values ('code-hash', 'iPad', ?, '2999-01-01T00:00:00.000Z')").run(now);
    db.prepare("insert into oauth_connections (id, name, url, status, refresh_token, created_at, updated_at) values ('oac_1', 'fleet', 'https://gw.example.com/mcp', 'connected', 'rt', ?, ?)").run(now, now);
    db.prepare("insert into connector_policies (connector_id, on_request, grant_mode, updated_at) values ('oauth:fleet', 1, 'immediate', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  assert.equal(store.db.prepare('pragma user_version').get()!.user_version, SCHEMA_VERSION);
  assert.deepEqual([store.getBot('bot_dave').access, store.getBot('bot_dave').sessionId], ['host', 'sess-2']);
  assert.equal(store.db.prepare('select count(*) as n from audit_events').get()!.n, 0);
  assert.equal(store.db.prepare('select count(*) as n from pairing_requests').get()!.n, 0);
  assert.deepEqual({ ...store.db.prepare("select id, hash, kind, label from auth_tokens where id = 'dev_1'").get() }, { id: 'dev_1', hash: 'hash-1', kind: 'device', label: 'Phone' });
  store.db.close();
  const after = as26(dump(cfg.dbPath));
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.ok(!tables(after).includes('pairing_codes'));
  for (const [i, name] of tables(before).entries()) {
    if (name === 'pairing_codes' || name === 'discovered_connectors') continue;
    assert.deepEqual(lookless(name, after.rows[tables(after).indexOf(name)], true), lookless(name, before.rows[i]), name);
  }
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
});

test('20 upgrades through 21 and 22 to 23 in one start', () => {
  const cfg = tmpHome();
  withDb(cfg.dbPath, (db) => db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-20.sql'), 'utf8')}\npragma user_version = 20;`));
  open(cfg).db.close();
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(dump(cfg.dbPath).version, SCHEMA_VERSION);
});

test("22 upgrades to 23 in place, after a backup: connectors from the CLIs' own settings come off each Boton as notices, nothing else changes, and the schema a new database gets", async () => {
  const cfg = tmpHome();
  const v22 = readFileSync(join(import.meta.dirname, 'fixtures/schema-22.sql'), 'utf8');
  const now = '2026-11-06T09:00:00.000Z';
  const codexServers = JSON.stringify([
    { name: 'notes', status: 'ok', note: null, config: { type: 'streamable_http', url: 'https://mcp.notes.example.com/mcp?workspace=1', bearer_token_env_var: 'NOTES_TOKEN' } },
    { name: 'tracker', status: 'ok', note: null, config: { type: 'stdio', command: '/usr/local/bin/tracker-mcp', args: ['--token', 'not-shown'] } },
  ]);
  const claudeServers = JSON.stringify([{ name: 'docs', status: 'ok', note: null, config: { type: 'http', url: 'https://docs.example.com/mcp/' } }]);
  withDb(cfg.dbPath, (db) => {
    db.exec(`${v22}\npragma user_version = 22;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    const bot = db.prepare(
      "insert into bots (id, name, look, provider, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at, connections) values (?, ?, '{}', ?, 'UTC', ?, ?, ?, ?, ?, ?, ?)",
    );
    bot.run('bot_kevin', 'Kevin', 'claude-cli', 'kevin', 'sess-k', 'key-k', now, now, now, '["codex:notes","lib:wiki","codex:tracker"]');
    bot.run('bot_stuart', 'Stuart', 'codex-cli', 'stuart', 'sess-s', 'key-s', now, now, now, '["claude:docs","oauth:notes"]');
    bot.run('bot_bob', 'Bob', 'codex-cli', 'bob', null, null, now, now, now, '["lib:wiki"]');
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
    db.prepare("insert into discovered_connectors (provider, checked_at, servers) values ('codex-cli', ?, ?), ('claude-cli', ?, ?)").run(now, codexServers, now, claudeServers);
    db.prepare("insert into mcp_servers (name, transport, url, created_at, updated_at) values ('wiki', 'http', 'https://docs.example.com/mcp', ?, ?)").run(now, now);
    db.prepare("insert into oauth_connections (id, name, url, status, created_at, updated_at) values ('oac_1', 'notes', 'https://mcp.notes.example.com/mcp', 'connected', ?, ?)").run(now, now);
    db.prepare("insert into connector_policies (connector_id, on_request, grant_mode, updated_at) values ('codex:tracker', 1, 'immediate', ?), ('oauth:notes', 1, 'approval', ?)").run(now, now);
    const approval = db.prepare("insert into approvals (id, bot_id, kind, title, status, trigger, asked_by, created_at, connector_id, connector_generation) values (?, 'bot_bob', 'connector', 'Use it', ?, 'chat', '[]', ?, ?, 1)");
    approval.run('apr_cli', 'pending', now, 'codex:tracker');
    approval.run('apr_own', 'pending', now, 'oauth:notes');
    approval.run('apr_old', 'denied', now, 'codex:notes');
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);

  // A backup of the database as it was, made first.
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => {
    assert.equal(db.prepare('pragma user_version').get()!.user_version, 22);
    assert.equal(db.prepare("select connections from bots where id = 'bot_kevin'").get()!.connections, '["codex:notes","lib:wiki","codex:tracker"]');
  });

  assert.deepEqual(store.getBot('bot_kevin').connections, ['lib:wiki']);
  assert.deepEqual(store.getBot('bot_stuart').connections, ['oauth:notes']);
  assert.deepEqual(store.getBot('bot_bob').connections, ['lib:wiki']);
  // Sessions are kept: nothing in the system prompt changed.
  assert.deepEqual([store.getBot('bot_kevin').sessionId, store.getBot('bot_kevin').sessionKey], ['sess-k', 'key-k']);
  const notices = store.db.prepare('select bot_id, connector_id, kind, name, target, reason from connector_notices order by bot_id, connector_id').all().map((r) => ({ ...r }));
  assert.deepEqual(
    notices.map(({ reason, ...r }) => r),
    [
      { bot_id: 'bot_kevin', connector_id: 'codex:notes', kind: 'removed', name: 'notes', target: 'https://mcp.notes.example.com/mcp' },
      { bot_id: 'bot_kevin', connector_id: 'codex:tracker', kind: 'removed', name: 'tracker', target: 'tracker-mcp' },
      { bot_id: 'bot_stuart', connector_id: 'claude:docs', kind: 'removed', name: 'docs', target: 'https://docs.example.com/mcp/' },
    ],
  );
  assert.match(String(notices[0].reason), /no longer uses MCP servers from Codex's own settings/);
  assert.match(String(notices[2].reason), /from Claude Code's own settings/);
  assert.deepEqual(store.db.prepare('select connector_id from connector_policies').all().map((r) => r.connector_id), ['oauth:notes']);
  assert.deepEqual(
    store.db.prepare('select id, status from approvals order by id').all().map((r) => ({ ...r })),
    [
      { id: 'apr_cli', status: 'cancelled' },
      { id: 'apr_old', status: 'denied' },
      { id: 'apr_own', status: 'pending' },
    ],
  );
  store.db.close();

  const after = as26(dump(cfg.dbPath));
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.ok(!tables(after).includes('discovered_connectors'));
  for (const [i, name] of tables(before).entries()) {
    if (['discovered_connectors', 'bots', 'approvals', 'connector_policies'].includes(name)) continue;
    assert.deepEqual(after.rows[tables(after).indexOf(name)], before.rows[i], name);
  }
  // Bots differ only in their connections, approvals only in the withdrawn one.
  const without = (rows: unknown[], key: string) => (rows as Record<string, unknown>[]).map((r) => ({ ...r, [key]: undefined }));
  assert.deepEqual(lookless('bots', without(after.rows[tables(after).indexOf('bots')], 'connections'), true), lookless('bots', without(before.rows[tables(before).indexOf('bots')], 'connections')));
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test("23 upgrades to 24 in place, after a backup: every routine keeps the server's time limit, every row stays, and the schema a new database gets", () => {
  const cfg = tmpHome();
  const now = '2026-11-06T09:00:00.000Z';
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-23.sql'), 'utf8')}\npragma user_version = 23;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare(
      "insert into bots (id, name, look, provider, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at) values ('bot_kevin', 'Kevin', '{}', 'mock', 'UTC', 'kevin', 'sess-k', 'key-k', ?, ?, ?)",
    ).run(now, now, now);
    const routine = db.prepare(
      "insert into routines (id, bot_id, name, instruction, schedule, timezone, webhook_key, enabled, next_run_at, callback_url, session, session_id, session_key, created_at, updated_at) values (?, 'bot_kevin', ?, 'Do it', ?, 'UTC', ?, 1, ?, ?, ?, ?, ?, ?, ?)",
    );
    routine.run('rt_brief', 'Brief', 'cron 0 8 * * *', null, '2026-11-07T08:00:00.000Z', null, 'chat', null, null, now, now);
    routine.run('rt_hook', 'Hook', null, 'whk_1', null, 'https://hooks.example.com/done', 'own', 'sess-r', 'key-r', now, now);
    db.prepare(
      "insert into routine_runs (id, routine_id, bot_id, trigger, status, error, started_at, finished_at, attempts, meta) values ('run_1', 'rt_brief', 'bot_kevin', 'schedule', 'failed', 'Claude timed out.', ?, ?, 1, '{}'), ('run_2', 'rt_hook', 'bot_kevin', 'webhook', 'queued', null, ?, null, 0, null)",
    ).run(now, now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);

  // A backup of the database as it was, made first.
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => {
    assert.equal(db.prepare('pragma user_version').get()!.user_version, 23);
    assert.equal(db.prepare('select count(*) as n from routines').get()!.n, 2);
  });
  assert.deepEqual(
    store.listRoutines('bot_kevin').map((r) => [r.id, r.timeLimitMs, r.session, r.nextRunAt]),
    [
      ['rt_brief', null, 'chat', '2026-11-07T08:00:00.000Z'],
      ['rt_hook', null, 'own', null],
    ],
  );
  // Sessions are kept: nothing in the system prompt changed.
  assert.deepEqual(store.routineSession('rt_hook'), { sessionId: 'sess-r', sessionKey: 'key-r' });
  assert.deepEqual([store.getBot('bot_kevin').sessionId, store.getBot('bot_kevin').sessionKey], ['sess-k', 'key-k']);
  store.db.close();

  const after = as26(dump(cfg.dbPath));
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.deepEqual(tables(after).filter((t) => !ADDED_LATER.includes(t)), tables(before));
  // Every row as it was; routines only gained an empty time limit.
  for (const [i, name] of tables(before).entries()) {
    const rows = after.rows[tables(after).indexOf(name)] as Record<string, unknown>[];
    if (name !== 'routines') assert.deepEqual(lookless(name, rows, true), lookless(name, before.rows[i]), name);
    else {
      assert.deepEqual(rows.map((r) => r.time_limit_ms), [null, null]);
      assert.deepEqual((lookless(name, rows, true) as Record<string, unknown>[]).map(({ time_limit_ms, ...r }) => r), (before.rows[i] as Record<string, unknown>[]).map((r) => ({ ...r })), name);
    }
  }
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('24 upgrades in place, after a backup: every look becomes its closest Boton (through its Critter and tater look), the same on every run, the one it had kept, and nothing else changes', () => {
  const now = '2026-11-06T09:00:00.000Z';
  // What a version-24 install can hold: the capsule editor's swatches (yellow, one eye), a custom color from the
  // API, a look missing a field, one that isn't JSON, and an empty one.
  const looks: [string, string][] = [
    ['bot_kevin', JSON.stringify({ body: '#f6c90e', bg: '#2f6fed', eyes: 2, hair: 'sprout', mouth: 'smile' })],
    ['bot_stuart', JSON.stringify({ body: '#7bd389', bg: '#14b8c4', eyes: 1, hair: 'antenna', mouth: 'o' })],
    ['bot_bob', JSON.stringify({ body: '#5fb3f9', bg: '#8b5cf6', eyes: 2, hair: 'combed', mouth: 'flat' })],
    ['bot_dave', JSON.stringify({ body: '#123456', bg: '#abcdef', eyes: 2, hair: 'spiky', mouth: 'grin' })],
    ['bot_jerry', JSON.stringify({ body: '#ff8fab', eyes: 2, hair: 'none', mouth: 'smile' })],
    ['bot_carl', 'not json'],
    ['bot_phil', '{}'],
  ];
  const upgraded = () => {
    const cfg = tmpHome();
    withDb(cfg.dbPath, (db) => {
      db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-24.sql'), 'utf8')}\npragma user_version = 24;`);
      db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
      const bot = db.prepare(
        "insert into bots (id, name, look, provider, access, pinned, group_name, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at, connections, always_allow, ask_first) values (?, ?, ?, 'mock', ?, ?, 'Ops', 'UTC', ?, ?, ?, ?, ?, ?, '[\"oauth:notes\"]', '[\"git push\"]', '[\"rm\"]')",
      );
      for (const [i, [id, look]] of looks.entries()) bot.run(id, id.slice(4)[0].toUpperCase() + id.slice(5), look, i % 2 ? 'host' : 'workspace', i % 2, id.slice(4), `sess-${i}`, `key-${i}`, now, now, now);
      db.prepare("insert into routines (id, bot_id, name, instruction, schedule, timezone, webhook_key, enabled, next_run_at, session, created_at, updated_at, time_limit_ms) values ('rt_1', 'bot_kevin', 'Brief', 'Do it', 'cron 0 8 * * *', 'UTC', 'whk_1', 1, '2026-11-07T08:00:00.000Z', 'chat', ?, ?, 60000)").run(now, now);
      db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
      db.prepare("insert into memories (id, bot_id, text, created_at) values ('mem_1', 'bot_bob', 'likes tea', ?)").run(now);
      db.prepare("insert into auth_tokens (id, hash, kind, label, created_at) values ('dev_1', 'hash-1', 'device', 'Phone', ?)").run(now);
      db.prepare("insert into oauth_connections (id, name, url, status, created_at, updated_at) values ('oac_1', 'notes', 'https://mcp.notes.example.com/mcp', 'connected', ?, ?)").run(now, now);
      db.prepare("insert into connector_policies (connector_id, on_request, grant_mode, updated_at) values ('oauth:notes', 1, 'approval', ?)").run(now);
      db.prepare("insert into approvals (id, bot_id, kind, title, status, trigger, asked_by, created_at, action) values ('apr_1', 'bot_stuart', 'action', 'Push', 'pending', 'chat', '[]', ?, 'git push')").run(now);
    });
    const before = dump(cfg.dbPath);
    const store = open(cfg);
    const bots = looks.map(([id]) => store.getBot(id));
    store.db.close();
    return { cfg, before, after: as26(dump(cfg.dbPath)), bots };
  };
  const { cfg, before, after, bots } = upgraded();

  // A backup of the database as it was, made first.
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => {
    assert.equal(db.prepare('pragma user_version').get()!.user_version, 24);
    assert.equal(db.prepare("select look from bots where id = 'bot_kevin'").get()!.look, looks[0][1]);
  });

  const look = Object.fromEntries(bots.map((b) => [b.id, b.look]));
  for (const b of bots) assert.deepEqual(parseLook(b.look), b.look, b.id);
  // Each keeps what made it recognizable: what it wore on top, its mouth, its eyes, its color family and its
  // backdrop's hue.
  assert.deepEqual([look.bot_kevin.top, look.bot_kevin.mouth, look.bot_kevin.backdrop], ['antenna', 'smile', 'ice']);
  assert.ok(['signal', 'steel', 'snow', 'teal'].includes(look.bot_kevin.shell), look.bot_kevin.shell);
  assert.ok(['dots', 'bars'].includes(look.bot_kevin.eyes));
  assert.deepEqual([look.bot_stuart.top, look.bot_stuart.ears, look.bot_stuart.eyes, look.bot_stuart.mouth, look.bot_stuart.shell, look.bot_stuart.backdrop], ['none', 'pods', 'happy', 'o', 'teal', 'mint']);
  assert.deepEqual([look.bot_bob.top, look.bot_bob.mouth, look.bot_bob.shell, look.bot_bob.backdrop], ['beacon', 'wave', 'sun', 'lilac']);
  assert.deepEqual([look.bot_dave.top, look.bot_dave.mouth], ['fin', 'grin']);
  assert.equal(look.bot_jerry.shell, 'graphite');
  // The looks each had are kept as they were, so the change can be undone: the capsule, and the tater look.
  withDb(cfg.dbPath, (db) => {
    for (const [id, stored] of looks) {
      const row = db.prepare('select previous_look, tater_look from bots where id = ?').get(id)!;
      assert.equal(row.previous_look, stored, id);
      assert.deepEqual(lookFromTater(parseTater(JSON.parse(String(row.tater_look)))!), look[id], id);
    }
  });

  // The same every time: a second install with the same data gets the same looks.
  assert.deepEqual(upgraded().bots.map((b) => b.look), bots.map((b) => b.look));

  // Names, sessions, grants and everything else stay as they were.
  assert.deepEqual(
    bots.map((b) => [b.id, b.name, b.sessionId, b.sessionKey, b.access, b.pinned, b.group, b.connections, b.alwaysAllow]),
    looks.map(([id], i) => [id, id.slice(4)[0].toUpperCase() + id.slice(5), `sess-${i}`, `key-${i}`, i % 2 ? 'host' : 'workspace', !!(i % 2), 'Ops', ['oauth:notes'], ['git push']]),
  );
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.deepEqual(tables(after).filter((t) => !ADDED_LATER.includes(t)), tables(before));
  for (const [i, name] of tables(before).entries()) assert.deepEqual(lookless(name, after.rows[tables(after).indexOf(name)], true), lookless(name, before.rows[i]), name);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test("25 upgrades to 26 in place, after a backup: every Boton runs at its provider's default effort and every routine at its Boton's, sessions kept, every row stays, and the schema a new database gets", () => {
  const cfg = tmpHome();
  const now = '2026-11-06T09:00:00.000Z';
  const look = JSON.stringify(randomLook());
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-25.sql'), 'utf8')}\npragma user_version = 25;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    const bot = db.prepare(
      "insert into bots (id, name, look, provider, model, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at) values (?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?, ?)",
    );
    bot.run('bot_carl', 'Carl', look, 'codex-cli', 'gpt-5.5', 'carl', 'thread-c', 'key-c', now, now, now);
    bot.run('bot_kevin', 'Kevin', look, 'claude-cli', '', 'kevin', 'sess-k', 'key-k', now, now, now);
    const routine = db.prepare(
      "insert into routines (id, bot_id, name, instruction, schedule, timezone, enabled, model, session, session_id, session_key, time_limit_ms, created_at, updated_at) values (?, ?, ?, 'Do it', 'cron 0 8 * * *', 'UTC', 1, ?, ?, ?, ?, ?, ?, ?)",
    );
    routine.run('rt_check', 'bot_kevin', 'Check', 'haiku', 'own', 'sess-r', 'key-r', 60000, now, now);
    routine.run('rt_brief', 'bot_carl', 'Brief', null, 'chat', null, null, null, now, now);
    db.prepare("insert into messages (id, bot_id, role, text, meta, created_at) values ('msg_1', 'bot_carl', 'bot', 'Done.', '{\"provider\":\"codex-cli\",\"model\":\"gpt-5.5\"}', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);

  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 25));
  assert.deepEqual(
    ['bot_carl', 'bot_kevin'].map((id) => store.getBot(id)).map((b) => [b.id, b.provider, b.model, b.effort, b.sessionId, b.sessionKey]),
    [
      ['bot_carl', 'codex-cli', 'gpt-5.5', '', 'thread-c', 'key-c'],
      ['bot_kevin', 'claude-cli', '', '', 'sess-k', 'key-k'],
    ],
  );
  assert.deepEqual(
    [...store.listRoutines('bot_kevin'), ...store.listRoutines('bot_carl')].map((r) => [r.id, r.model, r.effort, r.timeLimitMs]),
    [
      ['rt_check', 'haiku', null, 60000],
      ['rt_brief', null, null, null],
    ],
  );
  assert.deepEqual(store.routineSession('rt_check'), { sessionId: 'sess-r', sessionKey: 'key-r' });
  store.db.close();

  const after = as26(dump(cfg.dbPath));
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.deepEqual(tables(after).filter((t) => !ADDED_LATER.includes(t)), tables(before));
  for (const [i, name] of tables(before).entries()) assert.deepEqual(lookless(name, after.rows[tables(after).indexOf(name)], true), lookless(name, before.rows[i]), name);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('27 upgrades to 28 in place, after a backup: every skill stays written here and on, every Boton keeps its skills, groups, order, pins, sessions, capabilities, connectors, routines and effort, every row stays, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const now = '2026-11-07T09:00:00.000Z';
  const look = JSON.stringify(randomLook());
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-27.sql'), 'utf8')}\npragma user_version = 27;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare("insert into settings (key, value) values ('sidebarPinnedCollapsed', '1')").run();
    const group = db.prepare('insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)');
    group.run('grp_work', 'Work', 'work', 1, 0, now, now);
    group.run('grp_equipe', 'Équipe', 'équipe', 0, 1, now, now);
    const bot = db.prepare(
      "insert into bots (id, name, look, provider, model, effort, access, timezone, workspace, session_id, session_key, connections, skills, always_allow, ask_first, group_id, position, pinned, pin_position, created_at, updated_at, last_activity_at) values (?, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    bot.run('bot_kevin', 'Kevin', look, 'claude-cli', '', 'high', 'host', 'kevin', 'sess-k', 'key-k', '["oauth:notes"]', null, '["git push"]', '["rm"]', 'grp_work', 1, 1, 1, now, now, now);
    bot.run('bot_bob', 'Bob', look, 'codex-cli', 'gpt-5.5', '', 'workspace', 'bob', 'thread-b', 'key-b', '[]', '["weekly"]', '[]', '[]', 'grp_work', 0, 1, 0, now, now, now);
    bot.run('bot_stuart', 'Stuart', look, 'mock', '', '', 'workspace', 'stuart', null, null, '[]', '[]', '[]', '[]', 'grp_equipe', 0, 0, 0, now, now, now);
    bot.run('bot_dave', 'Dave', look, 'mock', '', '', 'workspace', 'dave', null, null, '[]', null, '[]', '[]', null, 0, 0, 0, now, now, now);
    db.prepare(
      "insert into routines (id, bot_id, name, instruction, schedule, timezone, enabled, model, effort, session, session_id, session_key, time_limit_ms, skill, created_at, updated_at) values ('rt_check', 'bot_kevin', 'Check', 'Do it', 'cron 0 8 * * *', 'UTC', 1, 'haiku', 'low', 'own', 'sess-r', 'key-r', 60000, 'standup', ?, ?)",
    ).run(now, now);
    db.prepare("insert into connector_policies (connector_id, on_request, grant_mode, generation, updated_at) values ('oauth:notes', 1, 'immediate', 3, ?)").run(now);
    const skill = db.prepare('insert into skills (name, description, body, created_by, updated_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)');
    skill.run('weekly', 'Write the weekly report.', 'Steps.', '{"kind":"owner"}', '{"kind":"owner"}', now, now);
    skill.run('standup', 'Write the standup.', 'Steps.', '{"kind":"boton","botId":"bot_kevin","name":"Kevin"}', '{"kind":"boton","botId":"bot_kevin","name":"Kevin"}', now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 27));
  assert.deepEqual(
    ['bot_kevin', 'bot_bob', 'bot_stuart', 'bot_dave']
      .map((id) => store.getBot(id))
      .map((b) => [b.id, b.skills, b.sessionId, b.sessionKey, b.effort, b.access, b.connections, b.alwaysAllow, b.askFirst, b.groupId, b.pinned]),
    [
      ['bot_kevin', null, 'sess-k', 'key-k', 'high', 'host', ['oauth:notes'], ['git push'], ['rm'], 'grp_work', true],
      ['bot_bob', ['weekly'], 'thread-b', 'key-b', '', 'workspace', [], [], [], 'grp_work', true],
      ['bot_stuart', [], null, null, '', 'workspace', [], [], [], 'grp_equipe', false],
      ['bot_dave', null, null, null, '', 'workspace', [], [], [], null, false],
    ],
  );
  const layout = store.sidebarLayout();
  assert.deepEqual(
    layout.groups.map((g) => [g.id, g.name, g.collapsed, g.botIds]),
    [
      ['grp_equipe', 'Équipe', true, ['bot_stuart']],
      ['grp_work', 'Work', false, ['bot_bob', 'bot_kevin']],
    ],
  );
  assert.deepEqual(layout.pinned, { collapsed: true, botIds: ['bot_bob', 'bot_kevin'] });
  assert.deepEqual(layout.ungrouped.botIds, ['bot_dave']);
  // Names still compare by Unicode case folding after the upgrade.
  assert.throws(() => store.createSidebarGroup({ name: 'ÉQUIPE' }), /already a group called Équipe/);
  assert.deepEqual(
    store.listRoutines('bot_kevin').map((r) => [r.id, r.model, r.effort, r.timeLimitMs, r.skill]),
    [['rt_check', 'haiku', 'low', 60000, 'standup']],
  );
  assert.deepEqual(store.routineSession('rt_check'), { sessionId: 'sess-r', sessionKey: 'key-r' });
  assert.equal(store.db.prepare('select count(*) as n from skill_history').get()!.n, 0);
  store.db.close();

  const after = dump(cfg.dbPath);
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.deepEqual(tables(after).filter((t) => !ADDED_LATER.includes(t)), tables(before));
  // Every row as it was, efforts and all (looks are drawn as Botons at 33); skills only gained their source and switch.
  const sourceless = (name: string, rows: unknown, after = false) => (name === 'skills' ? lookless(name, rows, after) : rows);
  const [aRows, bRows] = [looksAside(after, true), looksAside(before)];
  for (const [i, name] of tables(before).entries()) assert.deepEqual(sourceless(name, aRows[tables(after).indexOf(name)], true), sourceless(name, bRows[i]), name);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('28 upgrades to 29 in place, after a backup: every message, pin, routine message, reset, skill, group, pin in the sidebar, session and grant stays, a meta that is not JSON included, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const now = '2026-11-07T09:00:00.000Z';
  const at = (m: number) => new Date(Date.parse(now) + m * 60_000).toISOString();
  const look = JSON.stringify(randomLook());
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-28.sql'), 'utf8')}\npragma user_version = 28;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare("insert into settings (key, value) values ('sidebarPinnedCollapsed', '1')").run();
    db.prepare("insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values ('grp_equipe', 'Équipe', 'équipe', 0, 1, ?, ?)").run(now, now);
    const bot = db.prepare(
      "insert into bots (id, name, look, provider, effort, access, timezone, workspace, session_id, session_key, context_since, connections, skills, always_allow, group_id, position, pinned, pin_position, created_at, updated_at, last_activity_at) values (?, ?, ?, 'mock', ?, ?, 'UTC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    bot.run('bot_kevin', 'Kevin', look, 'high', 'host', 'kevin', 'sess-k', 'key-k', at(10), '["oauth:notes"]', '["weekly"]', '["git push"]', 'grp_equipe', 0, 1, 0, now, now, now);
    bot.run('bot_stuart', 'Stuart', look, '', 'workspace', 'stuart', null, null, null, '[]', null, '[]', null, 0, 0, 0, now, now, now);
    db.prepare("insert into routines (id, bot_id, name, instruction, schedule, timezone, enabled, session, session_id, session_key, created_at, updated_at) values ('rt_brief', 'bot_kevin', 'Brief', 'Do it', 'cron 0 8 * * *', 'UTC', 1, 'own', 'sess-r', 'key-r', ?, ?)").run(now, now);
    db.prepare("insert into connector_policies (connector_id, on_request, grant_mode, generation, updated_at) values ('oauth:notes', 1, 'immediate', 3, ?)").run(now);
    db.prepare("insert into skills (name, description, body, source, disabled, created_by, updated_by, created_at, updated_at) values ('weekly', 'Write the weekly report.', 'Steps.', 'packages/weekly', 1, '{\"kind\":\"owner\"}', '{\"kind\":\"owner\"}', ?, ?)").run(now, now);
    db.prepare("insert into skill_history (name, version, description, body, source, replaced_at, replaced_by) values ('weekly', 'v1', 'Old.', 'Old steps.', null, ?, '{\"kind\":\"owner\"}')").run(now);
    const msg = db.prepare('insert into messages (id, bot_id, role, text, meta, created_at) values (?, ?, ?, ?, ?, ?)');
    msg.run('msg_old', 'bot_kevin', 'user', 'before the reset', null, at(1));
    msg.run('msg_oldpin', 'bot_kevin', 'bot', 'pinned before the reset', JSON.stringify({ pinned: { at: at(2) } }), at(2));
    msg.run('msg_reset', 'bot_kevin', 'event', 'Started a fresh conversation', JSON.stringify({ kind: 'session.reset' }), at(10));
    msg.run('msg_decide', 'bot_kevin', 'user', 'We ship on Friday.', JSON.stringify({ pinned: { at: at(11) } }), at(11));
    msg.run('msg_brief', 'bot_kevin', 'bot', 'The brief.', JSON.stringify({ routineId: 'rt_brief', routineName: 'Brief' }), at(12));
    msg.run('msg_bad', 'bot_kevin', 'bot', 'meta that is not JSON', '{"pinned":', at(13));
    msg.run('msg_hi', 'bot_kevin', 'bot', 'Hello.', null, at(14));
    msg.run('msg_stuart', 'bot_stuart', 'user', 'hi', JSON.stringify({ pinned: { at: at(15) } }), at(15));
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 28));
  const kevin = store.getBot('bot_kevin');
  assert.deepEqual([kevin.sessionId, kevin.sessionKey, kevin.contextSince, kevin.effort, kevin.access, kevin.connections, kevin.skills, kevin.alwaysAllow, kevin.groupId, kevin.pinned], ['sess-k', 'key-k', at(10), 'high', 'host', ['oauth:notes'], ['weekly'], ['git push'], 'grp_equipe', true]);
  assert.deepEqual(store.routineSession('rt_brief'), { sessionId: 'sess-r', sessionKey: 'key-r' });
  assert.deepEqual(store.sidebarLayout().groups.map((g) => [g.name, g.collapsed, g.botIds]), [['Équipe', true, ['bot_kevin']]]);
  assert.deepEqual(store.sidebarLayout().pinned, { collapsed: true, botIds: ['bot_kevin'] });
  // The pins since the reset, the replay's streams on their indexes, and the message whose meta is not JSON read as chat.
  assert.deepEqual(store.pinnedMessages('bot_kevin').map((m) => m.id), ['msg_decide']);
  const src = store.replaySource('bot_kevin', kevin.contextSince, []);
  assert.deepEqual(src.pins.map((p) => p.message.id), ['msg_decide']);
  assert.deepEqual([...src.routines].map((p) => p.message.id), ['msg_brief']);
  assert.deepEqual([...src.chat].map((p) => p.message.id), ['msg_hi', 'msg_bad', 'msg_decide']);
  assert.deepEqual(store.listMessages('bot_kevin').map((m) => [m.id, m.meta ?? null]).find(([id]) => id === 'msg_bad'), ['msg_bad', null]);
  assert.deepEqual(store.pinnedMessages('bot_stuart').map((m) => m.id), ['msg_stuart']);
  store.db.close();

  const after = dump(cfg.dbPath);
  // Every row exactly as it was; only the indexes are new (and, from 30 on, the reactions' empty tables; from 31, the API requests' table).
  assert.deepEqual(rowsOf({ ...after, rows: looksAside(after, true) }, tablesOf(before)), looksAside(before));
  const indexes = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'index').map((x) => (x as { name: string }).name);
  assert.deepEqual(indexes(after).filter((n) => !indexes(before).includes(n) && !/reaction|api_requests/.test(n)).sort(), ['messages_chat', 'messages_pinned', 'messages_reset', 'messages_routine']);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('29 upgrades to 30 in place, after a backup: the reactions start empty and work, every message, pin, card, setting and session stays, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const now = '2026-11-07T09:00:00.000Z';
  const at = (m: number) => new Date(Date.parse(now) + m * 60_000).toISOString();
  const look = JSON.stringify(randomLook());
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-29.sql'), 'utf8')}\npragma user_version = 29;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare("insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values ('grp_crew', 'Crew', 'crew', 0, 0, ?, ?)").run(now, now);
    db.prepare(
      "insert into bots (id, name, look, provider, access, timezone, workspace, session_id, session_key, context_since, group_id, position, pinned, pin_position, created_at, updated_at, last_activity_at) values ('bot_kevin', 'Kevin', ?, 'mock', 'workspace', 'UTC', 'kevin', 'sess-k', 'key-k', null, 'grp_crew', 0, 1, 0, ?, ?, ?)",
    ).run(look, now, now, now);
    const msg = db.prepare("insert into messages (id, bot_id, role, text, meta, pending, created_at) values (?, 'bot_kevin', ?, ?, ?, ?, ?)");
    msg.run('msg_ask', 'user', 'Draft the notes.', null, 0, at(1));
    msg.run('msg_reply', 'bot', 'Here are the notes.', JSON.stringify({ pinned: { at: at(3) } }), 0, at(2));
    msg.run('msg_card', 'event', 'Which report?', JSON.stringify({ kind: 'card.posted', card: { status: 'pending' } }), 0, at(4));
    msg.run('msg_wait', 'user', 'And the agenda?', null, 1, at(5));
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 29));
  assert.deepEqual(store.listMessages('bot_kevin').map((m) => [m.id, m.reactions]), [['msg_ask', undefined], ['msg_reply', undefined], ['msg_card', undefined], ['msg_wait', undefined]]);
  assert.deepEqual(store.getSettings().reactionFollowUps, ['👎'], 'the default, with nothing saved');
  assert.deepEqual(store.pinnedMessages('bot_kevin').map((m) => m.id), ['msg_reply']);
  assert.ok(store.hasPendingChat('bot_kevin'));
  const kevin = store.getBot('bot_kevin');
  assert.deepEqual([kevin.sessionId, kevin.sessionKey, kevin.groupId, kevin.pinned], ['sess-k', 'key-k', 'grp_crew', true]);
  // The new tables take reactions, one of the Boton's per message, and go with their message's Boton.
  store.db.prepare("insert into message_reactions (message_id, bot_id, actor, emoji, created_at) values ('msg_reply', 'bot_kevin', 'owner', '👍', ?)").run(at(6));
  store.db.prepare("insert into message_reactions (message_id, bot_id, actor, emoji, created_at) values ('msg_ask', 'bot_kevin', 'boton', '👀', ?)").run(at(6));
  assert.throws(() => store.db.prepare("insert into message_reactions (message_id, bot_id, actor, emoji, created_at) values ('msg_ask', 'bot_kevin', 'boton', '✅', ?)").run(at(7)), /UNIQUE/);
  assert.throws(() => store.db.prepare("insert into message_reactions (message_id, bot_id, actor, emoji, created_at) values ('msg_ask', 'bot_kevin', 'someone', '✅', ?)").run(at(7)), /CHECK/);
  assert.deepEqual(store.findMessage('msg_reply')!.reactions, [{ emoji: '👍', by: 'owner', at: at(6) }]);
  store.db.prepare("delete from message_reactions").run();
  store.db.close();

  const after = dump(cfg.dbPath);
  // Every row exactly as it was; the reactions' tables are new and empty.
  assert.deepEqual(rowsOf({ ...after, rows: looksAside(after, true) }, tablesOf(before)), looksAside(before));
  assert.deepEqual(tablesOf(after).filter((t) => !tablesOf(before).includes(t)).sort(), ['api_requests', 'message_reactions', 'reaction_followups']);
  assert.deepEqual(rowsOf(after, ['api_requests', 'message_reactions', 'reaction_followups']), [[], [], []]);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('30 upgrades to 31 in place, after a backup: API-key turns already recorded become the request account (so today and a run spend what they did), every other row stays, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const now = '2026-11-07T09:00:00.000Z';
  const look = JSON.stringify(randomLook());
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-30.sql'), 'utf8')}\npragma user_version = 30;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam'), ('spendCap:bot:bot_kevin', '1')").run();
    db.prepare(
      "insert into bots (id, name, look, provider, access, timezone, workspace, session_id, session_key, context_since, group_id, position, pinned, pin_position, created_at, updated_at, last_activity_at) values ('bot_kevin', 'Kevin', ?, 'anthropic-api', 'workspace', 'UTC', 'kevin', 'anthropic-00000000-0000-0000-0000-000000000000', 'key-k', null, null, 0, 0, 0, ?, ?, ?)",
    ).run(look, now, now, now);
    const turn = db.prepare(
      "insert into turns (id, bot_id, routine_id, run_id, trigger, provider, requested_model, model, started_at, outcome, input_tokens, output_tokens, cost_usd) values (?, 'bot_kevin', ?, ?, 'chat', ?, 'claude-sonnet-5-5', ?, ?, 'ok', ?, ?, ?)",
    );
    turn.run('turn_priced', null, null, 'anthropic-api', 'claude-sonnet-5-5', now, 1000, 100, 0.25);
    turn.run('turn_run', 'rt_check', 'run_one', 'anthropic-api', null, now, 10, 10, 0.5);
    turn.run('turn_unpriced', null, null, 'openai-api', 'gpt-unknown', now, 10, 10, null);
    turn.run('turn_cli', null, null, 'claude', 'claude-sonnet-5-5', now, 5000, 500, 3);
    turn.run('turn_nothing', null, null, 'openai-api', null, now, 0, 0, null);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 30));
  const rows = store.db.prepare('select id, turn_id, run_id, model, at, reserved_usd, cost_usd, state from api_requests order by id').all();
  assert.deepEqual(
    rows.map((r: any) => [r.turn_id, r.run_id, r.model, r.at, r.reserved_usd, r.cost_usd, r.state]),
    [
      ['turn_priced', null, 'claude-sonnet-5-5', now, 0.25, 0.25, 'settled'],
      ['turn_run', 'run_one', 'claude-sonnet-5-5', now, 0.5, 0.5, 'settled'],
      ['turn_unpriced', null, 'gpt-unknown', now, null, null, 'settled'],
    ],
    'only API-key turns with tokens or a cost; a CLI turn is not the caps\' to count',
  );
  store.db.close();

  const after = dump(cfg.dbPath);
  assert.deepEqual(rowsOf({ ...after, rows: looksAside(after, true) }, tablesOf(before)), looksAside(before));
  assert.deepEqual(tablesOf(after).filter((t) => !tablesOf(before).includes(t)), ['api_requests']);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('31 upgrades to 32 and on in place, after a backup: every Critter becomes its closest tater look and then Boton, the looks it had are kept beside it, every other row stays, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const now = '2026-11-08T09:00:00.000Z';
  const critters: [string, string][] = [
    ['bot_kevin', JSON.stringify({ body: 'loaf', ears: 'floppy', eyes: 'arc', mouth: 'open', marks: 'belly', cheeks: true, color: 'lilac', backdrop: 'forest' })],
    ['bot_stuart', JSON.stringify({ body: 'round', ears: 'round', eyes: 'dot', mouth: 'smile', marks: 'cap', cheeks: false, color: 'sky', backdrop: 'navy' })],
    // The guardrails apply on the way: a sky Critter's spots were never drawn.
    ['bot_bob', JSON.stringify({ body: 'bun', ears: 'point', eyes: 'bean', mouth: 'w', marks: 'spots', cheeks: true, color: 'sky', backdrop: 'slate' })],
    ['bot_dave', 'not json'],
  ];
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-31.sql'), 'utf8')}\npragma user_version = 31;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    const bot = db.prepare(
      "insert into bots (id, name, look, provider, access, timezone, workspace, session_id, session_key, effort, position, pinned, pin_position, created_at, updated_at, last_activity_at) values (?, ?, ?, 'mock', 'workspace', 'UTC', ?, ?, ?, 'high', ?, ?, ?, ?, ?, ?)",
    );
    for (const [i, [id, look]] of critters.entries()) bot.run(id, id.slice(4), look, id.slice(4), `sess-${i}`, `key-${i}`, i, i % 2, i, now, now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
    db.prepare("insert into memories (id, bot_id, text, created_at) values ('mem_1', 'bot_bob', 'likes tea', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  const bots = critters.map(([id]) => store.getBot(id));
  store.db.close();

  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => {
    assert.equal(db.prepare('pragma user_version').get()!.user_version, 31);
    assert.equal(db.prepare("select look from bots where id = 'bot_kevin'").get()!.look, critters[0][1]);
  });

  for (const b of bots) assert.deepEqual(parseLook(b.look), b.look, b.id);
  // At 32 each was its closest tater look, exactly as before.
  const taters = withDb(cfg.dbPath, (db) => critters.map(([id]) => JSON.parse(String(db.prepare('select tater_look from bots where id = ?').get(id)!.tater_look))));
  assert.deepEqual(taters[0], { shape: 'tall', toast: 'purple', eyes: 'happy', brows: 'none', mouth: 'grin', hat: 'beanie', glasses: 'none', extra: 'scarf', arms: 'nubs', wear: 'plum', backdrop: 'sage', cheeks: true });
  assert.deepEqual([taters[1].shape, taters[1].hat, taters[1].extra, taters[1].toast, taters[1].backdrop, taters[1].cheeks], ['chunky', 'beret', 'pin', 'golden', 'sky', false]);
  assert.deepEqual([taters[2].hat, taters[2].eyes, taters[2].mouth, taters[2].extra, taters[2].backdrop], ['cap', 'ovals', 'w', 'scarf', 'night']);
  // Unreadable: a tater look seeded by its id, the same on every machine.
  assert.deepEqual(taters[3], taterLookFor(null, 'bot_dave'));
  // And at 33, each is the Boton closest to it.
  for (const [i, b] of bots.entries()) assert.deepEqual(b.look, lookFromTater(taters[i]), b.id);
  assert.deepEqual(bots[0].look, { shape: 'key', shell: 'violet', glow: 'violet', eyes: 'happy', brows: 'none', mouth: 'grin', top: 'beacon', ears: 'none', visor: 'none', panel: 'grill', arms: 'nubs', backdrop: 'mint', cheeks: true });

  // The look each had stays beside it, byte for byte: undoing is `update bots set look = previous_look`.
  withDb(cfg.dbPath, (db) => {
    for (const [id, stored] of critters) assert.equal(db.prepare('select previous_look from bots where id = ?').get(id)!.previous_look, stored, id);
  });

  // Every other column and row stays as it was.
  const after = dump(cfg.dbPath);
  assert.deepEqual(tablesOf(after), tablesOf(before));
  for (const [i, name] of tablesOf(before).entries()) {
    const strip = (rows: unknown) => (name === 'bots' ? (rows as Record<string, unknown>[]).map(({ look, ...r }) => r) : rows);
    assert.deepEqual(strip(after.rows[tablesOf(after).indexOf(name)]), strip(before.rows[i]), name);
  }
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('32 upgrades to 33 in place, after a backup: every tater look becomes its closest Boton, the look it had is kept beside it, every other row stays, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const now = '2026-11-08T09:00:00.000Z';
  const tater = (o: Record<string, unknown>) => JSON.stringify({ shape: 'classic', toast: 'golden', eyes: 'dots', brows: 'none', mouth: 'smile', hat: 'none', glasses: 'none', extra: 'none', arms: 'nubs', wear: 'tomato', backdrop: 'cream', cheeks: true, ...o });
  const already = { shape: 'pill', shell: 'teal', glow: 'lime', eyes: 'bars', brows: 'soft', mouth: 'calm', top: 'dish', ears: 'none', visor: 'none', panel: 'leds', arms: 'none', backdrop: 'grid', cheeks: false };
  const looks: [string, string, string | null][] = [
    ['bot_kevin', tater({}), '{"body":"bun"}'],
    ['bot_stuart', tater({ shape: 'tall', toast: 'purple', hat: 'headphones', glasses: 'round', extra: 'scarf', wear: 'sky', backdrop: 'cocoa', mouth: 'w', eyes: 'buttons' }), null],
    ['bot_bob', tater({ shape: 'chunky', toast: 'crispy', hat: 'party', glasses: 'shades', extra: 'lanyard', wear: 'ink', backdrop: 'night', arms: 'cheer', cheeks: false }), 'not json'],
    // A Boton already (a newer client wrote it): it stays as it is.
    ['bot_dave', JSON.stringify(already), null],
    ['bot_jerry', 'not json', null],
  ];
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-32.sql'), 'utf8')}\npragma user_version = 32;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    const bot = db.prepare(
      "insert into bots (id, name, look, previous_look, provider, access, timezone, workspace, session_id, session_key, effort, position, pinned, pin_position, connections, always_allow, created_at, updated_at, last_activity_at) values (?, ?, ?, ?, 'mock', ?, 'UTC', ?, ?, ?, 'high', ?, ?, ?, '[\"oauth:notes\"]', '[\"git push\"]', ?, ?, ?)",
    );
    for (const [i, [id, look, previous]] of looks.entries()) bot.run(id, id.slice(4), look, previous, i % 2 ? 'host' : 'workspace', id.slice(4), `sess-${i}`, `key-${i}`, i, i % 2, i, now, now, now);
    db.prepare("insert into routines (id, bot_id, name, instruction, schedule, timezone, enabled, session, created_at, updated_at) values ('rt_1', 'bot_kevin', 'Brief', 'Do it', 'cron 0 8 * * *', 'UTC', 1, 'chat', ?, ?)").run(now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
    db.prepare("insert into memories (id, bot_id, text, created_at) values ('mem_1', 'bot_bob', 'likes tea', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  const bots = looks.map(([id]) => store.getBot(id));
  store.db.close();

  // A backup of the database as it was, made first.
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => {
    assert.equal(db.prepare('pragma user_version').get()!.user_version, 32);
    assert.equal(db.prepare("select look from bots where id = 'bot_stuart'").get()!.look, looks[1][1]);
  });

  for (const b of bots) assert.deepEqual(parseLook(b.look), b.look, b.id);
  assert.deepEqual(bots[0].look, { shape: 'round', shell: 'sun', glow: 'pink', eyes: 'dots', brows: 'none', mouth: 'smile', top: 'none', ears: 'none', visor: 'none', panel: 'none', arms: 'nubs', backdrop: 'mist', cheeks: true });
  assert.deepEqual(bots[1].look, { shape: 'key', shell: 'violet', glow: 'cyan', eyes: 'rings', brows: 'none', mouth: 'wave', top: 'none', ears: 'pods', visor: 'goggles', panel: 'grill', arms: 'nubs', backdrop: 'plum', cheeks: true });
  assert.deepEqual([bots[2].look.shape, bots[2].look.shell, bots[2].look.top, bots[2].look.visor, bots[2].look.panel, bots[2].look.glow, bots[2].look.backdrop, bots[2].look.arms, bots[2].look.cheeks], ['pill', 'graphite', 'twin', 'band', 'leds', 'ice', 'night', 'cheer', false]);
  assert.deepEqual(bots[3].look, already);
  // Unreadable: a Boton seeded by its id, the same on every machine.
  assert.deepEqual(bots[4].look, lookFor(null, 'bot_jerry'));

  // The look each had stays beside it, byte for byte, and previous_look keeps what it held: undoing is
  // `update bots set look = tater_look`.
  withDb(cfg.dbPath, (db) => {
    for (const [id, stored, previous] of looks) {
      const row = db.prepare('select tater_look, previous_look from bots where id = ?').get(id)!;
      assert.deepEqual([row.tater_look, row.previous_look], [stored, previous], id);
    }
  });

  // Every other column and row stays as it was.
  const after = dump(cfg.dbPath);
  assert.deepEqual(tablesOf(after), tablesOf(before));
  for (const [i, name] of tablesOf(before).entries()) {
    const strip = (rows: unknown) => (name === 'bots' ? (rows as Record<string, unknown>[]).map(({ look, ...r }) => r) : rows);
    assert.deepEqual(strip(after.rows[tablesOf(after).indexOf(name)]), strip(before.rows[i]), name);
  }
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test("33 upgrades to 34 in place, after a backup: every routine's webhook runs share none of the chat (whatever its session), every other row stays, and the schema a new database gets", () => {
  const cfg = tmpHome();
  const now = '2026-11-08T09:00:00.000Z';
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-33.sql'), 'utf8')}\npragma user_version = 33;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare(
      "insert into bots (id, name, look, provider, access, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at) values ('bot_kevin', 'Kevin', ?, 'mock', 'host', 'UTC', 'kevin', 'sess-1', 'key-1', ?, ?, ?)",
    ).run(JSON.stringify(randomLook()), now, now, now);
    const routine = db.prepare("insert into routines (id, bot_id, name, instruction, timezone, webhook_key, enabled, session, session_id, created_at, updated_at) values (?, 'bot_kevin', ?, 'Do it', 'UTC', ?, 1, ?, ?, ?, ?)");
    routine.run('rt_chat', 'Shared', 'key-chat', 'chat', null, now, now);
    routine.run('rt_own', 'Own', 'key-own', 'own', 'sess-own', now, now);
    routine.run('rt_daily', 'Daily', null, 'chat', null, now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  assert.deepEqual(store.listRoutines('bot_kevin').map((r) => [r.id, r.session, r.webhookHistory]), [['rt_chat', 'chat', 0], ['rt_own', 'own', 0], ['rt_daily', 'chat', 0]]);
  store.db.close();
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 33));
  const after = dump(cfg.dbPath);
  assert.deepEqual(after.rows, before.rows);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test("34 upgrades to 35 in place, after a backup: the names stored under the app's earlier name take its current one (actor kinds, audit actions and keys, the browser connector's id), every other row stays, and the schema a new database gets", () => {
  const cfg = tmpHome();
  const now = '2026-11-08T09:00:00.000Z';
  const old = RENAMED.boton;
  const browser = `lib:${RENAMED.botons_browser}`;
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-34.sql'), 'utf8')}\npragma user_version = 34;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.prepare(
      "insert into bots (id, name, look, provider, access, timezone, workspace, connections, session_id, session_key, created_at, updated_at, last_activity_at) values ('bot_kevin', 'Kevin', ?, 'mock', 'host', 'UTC', 'kevin', ?, 'sess-1', 'key-1', ?, ?, ?)",
    ).run(JSON.stringify(randomLook()), JSON.stringify([browser, 'lib:github', 'lib:botons_browser']), now, now, now);
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', ?)").run(now);
    const react = db.prepare("insert into message_reactions (message_id, bot_id, actor, emoji, created_at) values ('msg_1', 'bot_kevin', ?, ?, ?)");
    react.run(old, '👍', now);
    react.run('owner', '❤️', now);
    const token = db.prepare("insert into auth_tokens (id, hash, kind, bot_id, label, created_at) values (?, ?, ?, ?, ?, ?)");
    token.run('tok_dev', 'hash-dev', 'device', null, 'Phone', now);
    token.run('tok_turn', 'hash-turn', old, 'bot_kevin', 'turn', now);
    const audit = db.prepare("insert into audit_events (at, actor_kind, actor_id, actor_label, action, target_kind, target_id, target_label, details) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    audit.run(now, 'device', 'tok_dev', 'Phone', `${old}.created`, old, 'bot_kevin', 'Kevin', JSON.stringify({ [old]: 'bot_kevin', provider: 'mock' }));
    audit.run(now, old, 'bot_kevin', 'Kevin', 'connector.requested', 'connector', browser, 'Browser', '{}');
    audit.run(now, 'host', null, 'this machine', `skill.${old}s_changed`, 'skill', 'standup', 'standup', JSON.stringify({ [`${old}s`]: ['bot_kevin'] }));
    db.prepare("insert into skills (name, description, body, created_by, updated_by, created_at, updated_at) values ('standup', 'Run the standup.', 'Steps.', ?, '{\"kind\":\"owner\"}', ?, ?)").run(JSON.stringify({ kind: old, botId: 'bot_kevin', name: 'Kevin' }), now, now);
    // The owner's own connector that already has the browser's new name.
    db.prepare("insert into mcp_servers (name, transport, url, created_at, updated_at) values ('botons_browser', 'http', 'https://mcp.example.com/mcp', ?, ?)").run(now, now);
    db.prepare("insert into connector_policies (connector_id, on_request, updated_at) values ('lib:botons_browser', 0, ?)").run(now);
    // Turned off, and a policy left by a connector since deleted holds the first free name.
    db.prepare("insert into settings (key, value) values ('connector_off:lib:botons_browser', '1')").run();
    db.prepare("insert into connector_policies (connector_id, on_request, updated_at) values ('lib:botons_browser_2', 0, ?)").run(now);
    db.prepare("insert into connector_policies (connector_id, on_request, updated_at) values (?, 1, ?)").run(browser, now);
    db.prepare("insert into connector_notices (bot_id, connector_id, kind, name, reason, at) values ('bot_kevin', ?, 'skipped', 'Browser', 'test', ?)").run(browser, now);
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);
  store.db.close();
  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 34));
  withDb(cfg.dbPath, (db) => {
    const all = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
    assert.deepEqual(all('select actor, emoji from message_reactions order by rowid'), [{ actor: 'boton', emoji: '👍' }, { actor: 'owner', emoji: '❤️' }]);
    assert.deepEqual(all('select id, kind from auth_tokens order by id'), [{ id: 'tok_dev', kind: 'device' }, { id: 'tok_turn', kind: 'boton' }]);
    assert.deepEqual(all('select seq, actor_kind, action, target_kind, target_id, details from audit_events order by seq'), [
      { seq: 1, actor_kind: 'device', action: 'boton.created', target_kind: 'boton', target_id: 'bot_kevin', details: JSON.stringify({ boton: 'bot_kevin', provider: 'mock' }) },
      { seq: 2, actor_kind: 'boton', action: 'connector.requested', target_kind: 'connector', target_id: browser, details: '{}' },
      { seq: 3, actor_kind: 'host', action: 'skill.botons_changed', target_kind: 'skill', target_id: 'standup', details: JSON.stringify({ botons: ['bot_kevin'] }) },
    ]);
    assert.deepEqual(JSON.parse(String(db.prepare("select connections from bots where id = 'bot_kevin'").get()!.connections)), ['lib:botons_browser', 'lib:github', 'lib:botons_browser_3'], "the owner's own connector keeps its grant under a free name");
    assert.deepEqual(db.prepare('select name from mcp_servers').all().map((r) => r.name), ['botons_browser_3']);
    assert.deepEqual(db.prepare('select connector_id, on_request from connector_policies order by connector_id').all().map((r) => ({ ...r })), [{ connector_id: 'lib:botons_browser', on_request: 1 }, { connector_id: 'lib:botons_browser_2', on_request: 0 }, { connector_id: 'lib:botons_browser_3', on_request: 0 }]);
    assert.deepEqual(db.prepare("select key from settings where key like 'connector_off:%'").all().map((r) => r.key), ['connector_off:lib:botons_browser_3'], 'and stays turned off');
    assert.deepEqual(JSON.parse(String(db.prepare("select created_by from skills where name = 'standup'").get()!.created_by)), { kind: 'boton', botId: 'bot_kevin', name: 'Kevin' });
    assert.equal(db.prepare('select connector_id from connector_notices').get()!.connector_id, 'lib:botons_browser');
    // The new seq carries on after the rows kept.
    db.prepare("insert into audit_events (at, actor_kind, action) values (?, 'system', 'probe')").run(now);
    assert.equal(db.prepare("select seq from audit_events where action = 'probe'").get()!.seq, 4);
  });
  // Every other row as it was.
  const after = dump(cfg.dbPath);
  for (const [i, name] of tablesOf(before).entries()) {
    if (['audit_events', 'message_reactions', 'auth_tokens', 'bots', 'connector_policies', 'connector_notices', 'mcp_servers', 'settings', 'skills', 'sqlite_sequence'].includes(name)) continue;
    assert.deepEqual(after.rows[tablesOf(after).indexOf(name)], before.rows[i], name);
  }
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(after.schema, dump(fresh.dbPath).schema);
  assert.equal(after.version, SCHEMA_VERSION);
});

test('26 upgrades to 27 in place, after a backup: each group name becomes a group, in the order the sidebar showed, pins kept, every other row stays, and the schema a new database gets', () => {
  const cfg = tmpHome();
  const look = JSON.stringify(randomLook());
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-26.sql'), 'utf8')}\npragma user_version = 26;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    const bot = db.prepare(
      "insert into bots (id, name, look, provider, group_name, pinned, timezone, workspace, session_id, session_key, created_at, updated_at, last_activity_at) values (?, ?, ?, 'mock', ?, ?, 'UTC', ?, ?, ?, '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z', ?)",
    );
    // [id, group, pinned, last activity]: the sidebar showed groups by name, each one's Botons and the pinned by activity.
    for (const [id, group, pinned, at] of [
      ['bot_kevin', 'Work', 1, '2026-11-06T09:00:00.000Z'],
      ['bot_stuart', 'work', 0, '2026-11-06T10:00:00.000Z'],
      ['bot_bob', '', 1, '2026-11-06T11:00:00.000Z'],
      ['bot_dave', 'Home', 0, '2026-11-06T08:00:00.000Z'],
      ['bot_carl', '', 0, '2026-11-06T07:00:00.000Z'],
      // Differ in case beyond ASCII (SQLite's nocase would keep them apart).
      ['bot_jerry', 'Équipe', 0, '2026-11-06T05:00:00.000Z'],
      ['bot_tim', 'équipe', 0, '2026-11-06T06:00:00.000Z'],
    ] as const) {
      bot.run(id, id.slice(4), look, group, pinned, id.slice(4), `sess-${id}`, `key-${id}`, at);
    }
    db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_kevin', 'user', 'hi', '2026-11-06T09:00:00.000Z')").run();
    db.prepare("insert into skills (name, description, body, created_by, updated_by, created_at, updated_at) values ('weekly', 'Write the weekly report.', 'Steps.', '{\"kind\":\"owner\"}', '{\"kind\":\"owner\"}', '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z')").run();
  });
  const before = dump(cfg.dbPath);
  const store = open(cfg);

  const backups = readdirSync(join(cfg.home, 'backups'));
  assert.equal(backups.length, 1);
  withDb(join(cfg.home, 'backups', backups[0], 'botons.db'), (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 26));
  const layout = store.sidebarLayout();
  const work = layout.groups.find((g) => g.name === 'Work')!;
  // "Work" and "work" are one group, and so are "Équipe" and "équipe", each spelled as the first in code-point order;
  // groups by name, as the sidebar showed.
  assert.deepEqual(
    layout.groups.map((g) => [g.name, g.collapsed, g.botIds]),
    [
      ['Équipe', false, ['bot_tim', 'bot_jerry']],
      ['Home', false, ['bot_dave']],
      ['Work', false, ['bot_stuart', 'bot_kevin']],
    ],
  );
  assert.deepEqual(layout.ungrouped, { collapsed: false, botIds: ['bot_bob', 'bot_carl'] });
  assert.deepEqual(layout.pinned, { collapsed: false, botIds: ['bot_bob', 'bot_kevin'] });
  assert.deepEqual(
    ['bot_kevin', 'bot_stuart', 'bot_bob'].map((id) => store.getBot(id)).map((b) => [b.id, b.groupId, b.group, b.pinned, b.sessionId, b.sessionKey]),
    [
      ['bot_kevin', work.id, 'Work', true, 'sess-bot_kevin', 'key-bot_kevin'],
      ['bot_stuart', work.id, 'Work', false, 'sess-bot_stuart', 'key-bot_stuart'],
      ['bot_bob', null, '', true, 'sess-bot_bob', 'key-bot_bob'],
    ],
  );
  // After the upgrade, the server compares names as the upgrade did.
  assert.throws(() => store.createSidebarGroup({ name: 'ÉQUIPE' }), /already a group called Équipe/);
  store.db.close();

  const after = as26(dump(cfg.dbPath));
  const tables = (d: ReturnType<typeof dump>) => d.schema.filter((x) => (x as { type: string }).type === 'table').map((x) => (x as { name: string }).name);
  assert.deepEqual(tables(after).filter((t) => !ADDED_LATER.includes(t)), tables(before));
  // Every row as it was, but "work" reads as the group it joined; the skill went on through 27 to 28 written here and on.
  const spelled = (name: string, rows: unknown, after = false) =>
    name === 'bots'
      ? (rows as Record<string, unknown>[]).map((r) => ({ ...r, group_name: String(r.group_name).toLowerCase() }))
      : name === 'skills'
        ? lookless(name, rows, after)
        : rows;
  const [aRows, bRows] = [looksAside(after, true), looksAside(before)];
  for (const [i, name] of tables(before).entries()) assert.deepEqual(spelled(name, aRows[tables(after).indexOf(name)], true), spelled(name, bRows[i]), name);
  const fresh = tmpHome();
  open(fresh).db.close();
  assert.deepEqual(dump(cfg.dbPath).schema, dump(fresh.dbPath).schema);
  assert.equal(dump(cfg.dbPath).version, SCHEMA_VERSION);
});

test('an upgrade whose backup fails leaves the database as it was, and says why', () => {
  const cfg = tmpHome();
  withDb(cfg.dbPath, (db) => db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-22.sql'), 'utf8')}\npragma user_version = 22;`));
  // A file where the backups folder goes: the backup can't be made.
  writeFileSync(join(cfg.home, 'backups'), 'not a folder');
  const before = dump(cfg.dbPath);
  assert.throws(() => open(cfg), (err: Error) => err instanceof SchemaError && /is at schema version 22 and needs upgrading to \d+, but backing it up first failed .*so it was left as it was/.test(err.message));
  assert.deepEqual(dump(cfg.dbPath), before);
});

test('an upgrade whose backup has the database but not the workspaces does not start: exit 78, and the database is byte for byte as it was', async () => {
  const cfg = tmpHome();
  withDb(cfg.dbPath, (db) => {
    // As a running install has it: WAL mode, checkpointed.
    db.exec(`pragma journal_mode = wal; ${readFileSync(join(import.meta.dirname, 'fixtures/schema-22.sql'), 'utf8')}\npragma user_version = 22;`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    db.exec('pragma wal_checkpoint(truncate)');
  });
  mkdirSync(join(cfg.home, 'workspaces', 'kevin'), { recursive: true });
  writeFileSync(join(cfg.home, 'workspaces', 'kevin', 'notes.md'), 'banana');
  const bytes = readFileSync(cfg.dbPath);
  const bin = tempDir('botons-fake-tar-');
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\necho "tar: workspaces.tar.gz: Cannot write: No space left on device" >&2\nexit 2\n', { mode: 0o755 });

  const { code, stdout } = await startAndExit(cfg, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(code, 78, stdout);
  const why = stdout.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.level === 'error');
  assert.match(why?.msg ?? '', /is at schema version 22 and needs upgrading to \d+, but backing it up first failed \(the workspaces were not backed up \(tar failed \(exit 2\): .*No space left on device\); the database alone is in .*\), so it was left as it was/, stdout);
  assert.doesNotMatch(stdout, /backed up the database before upgrading|is running/);
  assert.ok(readFileSync(cfg.dbPath).equals(bytes), 'the database file is unchanged');
  const wal = `${cfg.dbPath}-wal`;
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'nothing is waiting in the WAL either');
  withDb(cfg.dbPath, (db) => assert.equal(db.prepare('pragma user_version').get()!.user_version, 22));

  // The backup is still there for what it holds (the database), as any backup whose tar failed is.
  const [dir] = readdirSync(join(cfg.home, 'backups'));
  assert.deepEqual(readdirSync(join(cfg.home, 'backups', dir)).sort(), ['botons.db', 'manifest.json']);

  // With tar working again the same start upgrades it.
  const store = open(cfg);
  assert.equal(store.db.prepare('pragma user_version').get()!.user_version, SCHEMA_VERSION);
  store.db.close();
  const done = readdirSync(join(cfg.home, 'backups')).sort().at(-1)!;
  assert.deepEqual(readdirSync(join(cfg.home, 'backups', done)).sort(), ['botons.db', 'manifest.json', 'workspaces.tar.gz']);
});


test('corrupt inherited legacy look names fall back by field and stay valid after reopening', () => {
  const cfg = tmpHome();
  const values = ['constructor', 'toString', '__proto__'];
  withDb(cfg.dbPath, (db) => {
    db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-24.sql'), 'utf8')}\npragma user_version = 24;`);
    for (const [i, value] of values.entries()) {
      db.prepare("insert into bots (id, name, look, provider, timezone, workspace, created_at, updated_at, last_activity_at) values (?, 'Kevin', ?, 'mock', 'UTC', ?, ?, ?, ?)")
        .run(`bot_corrupt_${i}`, JSON.stringify({ body: '#7bd389', bg: '#14b8c4', eyes: 1, hair: value, mouth: value }), `workspace-${i}`, '2026-11-06T09:00:00.000Z', '2026-11-06T09:00:00.000Z', '2026-11-06T09:00:00.000Z');
    }
  });
  let store = open(cfg);
  const saved = values.map((_, i) => {
    const id = `bot_corrupt_${i}`;
    const look = JSON.parse(store.db.prepare('select look from bots where id = ?').get(id)!.look as string);
    assert.deepEqual(parseLook(look), look);
    assert.deepEqual([look.mouth, look.shell, look.backdrop, look.eyes], ['smile', 'teal', 'mint', 'happy']);
    assert.deepEqual(store.getBot(id).look, look);
    return look;
  });
  store.db.close();
  store = open(cfg);
  assert.deepEqual(values.map((_, i) => store.getBot(`bot_corrupt_${i}`).look), saved);
  store.db.close();
});
