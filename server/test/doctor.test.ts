import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync, truncateSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Finding, diagnose, egressFinding, isProblem } from '../../scripts/doctor.ts';
import { backup } from '../src/backup.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { noRealClis, startServer, tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const NO_TS = () => ({ ip: null, dnsName: null });

/** Settings for a doctor run that never looks at this machine's own install. */
function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HOME: home, BOTONS_HOME: home, BOTONS_NO_TAILSCALE: '1', XDG_CONFIG_HOME: join(home, 'xdg'), PATH: process.env.PATH, BOTONS_BROWSER_PATH: join(repo, 'server/test/fixtures/doctor-browser.sh'), ...noRealClis(home), ...extra };
}

const of = (findings: Finding[], check: string) => findings.filter((f) => f.check === check);
const statuses = (findings: Finding[], check: string) => of(findings, check).map((f) => f.status);

test('a bad setting fails the doctor with the server’s own message, and nothing is created', async () => {
  const home = join(tempDir(), 'not-yet');
  const findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home, { BOTONS_PORT: 'eighty', BOTONS_AUTH: 'maybe' }), container: false, health: async () => null });
  const config = of(findings, 'config');
  assert.equal(config.length, 2);
  assert.ok(config.every((f) => f.status === 'fail'));
  assert.match(config[0].message, /BOTONS_PORT must be a whole number/);
  assert.equal(existsSync(home), false);
});

test('a fresh install: no database yet, nothing running, no CLI that can run turns', async () => {
  const home = join(tempDir(), 'fresh');
  const findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home), container: false, health: async () => null });
  assert.deepEqual(statuses(findings, 'config'), ['ok']);
  assert.deepEqual(statuses(findings, 'data'), ['info']);
  assert.deepEqual(statuses(findings, 'database'), ['info']);
  assert.deepEqual(statuses(findings, 'server'), ['info']);
  assert.deepEqual(statuses(findings, 'backups'), []);
  assert.deepEqual(statuses(findings, 'agent CLIs'), ['info', 'info', 'info']);
  assert.equal(existsSync(home), false, 'the doctor creates nothing');
});

test('a running, paired install with signed-in CLIs; then a backup, a stale backup, and a signed-out CLI', async () => {
  const s = await startServer({ fakeClis: true });
  const env = envFor(s.home, { BOTONS_PORT: String(s.port), BOTONS_CLAUDE_BIN: s.claude.bin, BOTONS_CODEX_BIN: s.codex.bin });
  let findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false });
  assert.equal(of(findings, 'browser')[0].status, 'ok');
  assert.deepEqual(statuses(findings, 'config'), ['ok']);
  assert.deepEqual(statuses(findings, 'exposure'), ['ok']);
  assert.deepEqual(statuses(findings, 'data'), ['ok']);
  assert.deepEqual(statuses(findings, 'database'), ['ok']);
  assert.match(of(findings, 'devices')[0].message, /^1 paired device$/);
  assert.deepEqual(statuses(findings, 'server'), ['ok']);
  assert.deepEqual(statuses(findings, 'agent CLIs'), ['ok', 'ok']);
  assert.deepEqual(statuses(findings, 'backups'), ['warn']);

  backup({ home: s.home });
  findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false, skipClis: true });
  assert.deepEqual(statuses(findings, 'backups'), ['ok']);
  findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false, skipClis: true, now: Date.now() + 3 * 86_400_000 });
  assert.match(of(findings, 'backups')[0].message, /is 3 days old/);

  s.claude.login('claude/auth-status-logged-out');
  findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: { ...env, BOTONS_CODEX_BIN: join(s.home, 'no-codex') }, container: false });
  const clis = of(findings, 'agent CLIs');
  assert.deepEqual(
    clis.map((f) => f.status),
    ['warn', 'info', 'info'],
  );
  assert.match(clis[0].fix!, /^claude auth login/);

  // The same port answering for another data folder is called out.
  const other = tempDir();
  findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(other, { BOTONS_PORT: String(s.port) }), container: false, skipClis: true });
  assert.match(of(findings, 'server')[0].message, /none is using/);

  // Unhealthy: the server says which checks fail.
  findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false, skipClis: true, health: async () => ({ status: 503, body: { ok: false, failing: ['providers'] } }) });
  assert.match(of(findings, 'server')[0].message, /unhealthy: providers/);
});

test('exposure: auth off fails; every interface warns on a machine and is required in a container; plain HTTP off the tailnet warns', async () => {
  const home = tempDir();
  const run = (extra: Record<string, string>, container: boolean) => diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home, extra), container, health: async () => null, skipClis: true });

  assert.deepEqual(statuses(await run({ BOTONS_AUTH: 'off' }, false), 'auth'), ['fail']);
  // Every interface, and so a plain-HTTP URL with this machine's name.
  assert.deepEqual(statuses(await run({ BOTONS_HOST: '0.0.0.0' }, false), 'exposure'), ['warn', 'warn']);
  assert.deepEqual(statuses(await run({ BOTONS_HOST: '127.0.0.1' }, true), 'exposure'), ['fail']);
  assert.deepEqual(statuses(await run({ BOTONS_HOST: '0.0.0.0', BOTONS_PUBLIC_URL: 'http://localhost:7777' }, true), 'exposure'), ['info']);
  assert.deepEqual(statuses(await run({ BOTONS_HOST: '0.0.0.0', BOTONS_PUBLIC_URL: 'https://botons.example.com' }, true), 'exposure'), ['info']);
  const plain = await run({ BOTONS_HOST: '0.0.0.0', BOTONS_PUBLIC_URL: 'http://botons.example.com' }, true);
  assert.deepEqual(statuses(plain, 'exposure'), ['info', 'warn']);
  assert.deepEqual(statuses(await run({ BOTONS_PUBLIC_URL: 'http://myhost.example-tailnet.ts.net:7777' }, false), 'exposure'), ['ok']);

  // In a container, a data folder that is not a volume is lost with it.
  const findings = await run({ BOTONS_HOST: '0.0.0.0' }, true);
  if (process.platform === 'linux') assert.ok(of(findings, 'data').some((f) => f.status === 'fail' && /not a volume/.test(f.message)));
});

test('npm run doctor: --json, exit 1 on a failure, and it reads the settings only from the environment it is given', () => {
  const home = tempDir();
  mkdirSync(join(home, 'xdg'), { recursive: true });
  const run = (extra: Record<string, string>) =>
    spawnSync(process.execPath, [join(repo, 'scripts/doctor.ts'), '--json', '--skip-clis', '--skip-network'], {
      env: { ...(envFor(home, { BOTONS_PORT: '17999', ...extra }) as Record<string, string>), HOME: home },
      encoding: 'utf8',
    });
  const ok = run({});
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.home, home);
  assert.ok(parsed.findings.some((f: Finding) => f.check === 'config' && f.status === 'ok'));
  const bad = run({ BOTONS_TZ: 'Mars/Olympus' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /BOTONS_TZ is not a timezone/);
  assert.deepEqual(readdirSync(home).sort(), ['xdg'], 'nothing written to the data folder');
});

test('doctor leaves a stopped WAL database and its directory unchanged', async () => {
  const home = tempDir();
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`pragma journal_mode=WAL; pragma user_version=${SCHEMA_VERSION}; create table sample (n); insert into sample values (1)`);
  db.close();
  const before = readdirSync(home);
  const findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home), container: false, health: async () => null, skipClis: true });
  assert.deepEqual(statuses(findings, 'database'), ['ok']);
  assert.deepEqual(readdirSync(home), before);
});

test('doctor reports the access mode, and a public one without HTTPS fails', async () => {
  const home = tempDir();
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`pragma user_version=${SCHEMA_VERSION}; create table settings (key text primary key, value text not null); create table auth_tokens (kind text)`);
  db.close();
  const run = () => diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home), container: false, health: async () => null, skipClis: true });
  assert.deepEqual(statuses(await run(), 'access'), ['info']);
  const set = (mode: string) => {
    const w = new DatabaseSync(join(home, 'botons.db'));
    w.prepare("insert into settings (key, value) values ('accessMode', ?) on conflict(key) do update set value = excluded.value").run(mode);
    w.close();
  };
  set('tailscale');
  assert.deepEqual(statuses(await run(), 'access'), ['ok']);
  set('public');
  const findings = await run();
  assert.deepEqual(statuses(findings, 'access'), ['fail']);
  assert.match(findings.find((f) => f.check === 'access')!.fix!, /npm run pair -- --access-mode/);
});

test('doctor counts routine runs to check: failed and not retried in the last week, interrupted ones, and held ones', async () => {
  const s = await startServer();
  const env = envFor(s.home, { BOTONS_PORT: String(s.port) });
  const run = () => diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false, skipClis: true });
  let findings = await run();
  assert.deepEqual(statuses(findings, 'runs'), ['ok']);
  assert.match(of(findings, 'runs')[0].message, /^No routine run failed in the last 7 days or is waiting to try again$/);

  const bot = await s.newBot('Dave');
  const routine = s.app.store.getRoutine((await s.newRoutine(bot.id)).id);
  const fail = (trigger: 'schedule' | 'manual' | 'test', error: string) => s.app.store.updateRun(s.app.store.createRun(routine, trigger, null).id, { status: 'failed', error });
  const cut = fail('schedule', 'Interrupted by a restart');
  fail('manual', 'boom');
  fail('test', 'not counted');
  s.app.store.holdRun(s.app.store.createRun(routine, 'schedule', null).id, new Date(Date.now() + 3_600_000), 'connect ECONNREFUSED', 'retry');
  s.app.store.holdRun(s.app.store.createRun(routine, 'test', null).id, new Date(Date.now() + 3_600_000), 'usage limit', 'usage_limit');
  findings = await run();
  assert.deepEqual(
    of(findings, 'runs').map((f) => [f.status, f.message]),
    [
      ['info', '2 routine runs failed in the last 7 days and were not retried (1 interrupted by a restart)'],
      ['info', '1 routine run is waiting to try again by itself (a network error or a usage limit)'],
    ],
  );
  assert.match(of(findings, 'runs')[0].fix!, /Settings → Runs to check/);

  s.app.store.createRetryRun(s.app.store.getRun(cut.id));
  findings = await run();
  assert.equal(of(findings, 'runs')[0].message, '1 routine run failed in the last 7 days and was not retried');

  // A result the callback URL never got is listed; one still being sent, or with nowhere to go now, is not.
  const hooked = s.app.store.getRoutine((await s.newRoutine(bot.id, { name: 'Hooked', webhook: true })).id);
  s.app.store.db.prepare("update routines set callback_url = 'https://hooks.example.com/r' where id = ?").run(hooked.id);
  const finishedRun = () => s.app.store.updateRun(s.app.store.createRun(hooked, 'webhook', null).id, { status: 'succeeded' });
  const delivery = { url: 'https://hooks.example.com/r', status: 500, error: 'HTTP 500', attempts: 4, at: new Date().toISOString() };
  s.app.store.setRunCallback(finishedRun().id, { ...delivery, ok: false });
  s.app.store.setRunCallback(finishedRun().id, { ...delivery, ok: false, pending: true });
  s.app.store.setRunCallback(finishedRun().id, { ...delivery, ok: true, status: 200, error: null });
  findings = await run();
  const callbacks = of(findings, 'runs').filter((f) => /callback URL/.test(f.message));
  assert.deepEqual(callbacks.map((f) => [f.status, f.message]), [['info', '1 routine run in the last 7 days could not send its result to the callback URL']]);
  assert.match(callbacks[0].fix!, /Settings → Runs to check .* resend/);
  s.app.store.db.prepare('update routines set callback_url = null where id = ?').run(hooked.id);
  assert.ok(!of(await run(), 'runs').some((f) => /callback URL/.test(f.message)));
  await s.stop();
});

test('doctor names the Botons a missing or signed-out brain leaves without answers, and a usage limit they wait on', async () => {
  const s = await startServer({ fakeClis: true });
  const env = envFor(s.home, { BOTONS_PORT: String(s.port), BOTONS_CLAUDE_BIN: s.claude.bin, BOTONS_CODEX_BIN: s.codex.bin });
  for (const name of ['Kevin', 'Stuart', 'Bob']) s.storeBot(name, 'claude-cli');
  s.storeBot('Dave', 'codex-cli');
  let clis = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false }), 'agent CLIs');
  assert.deepEqual(clis.map((f) => f.status), ['ok', 'ok']);
  assert.match(clis[0].message, /: signed in; 3 Botons \(Kevin, Stuart and Bob\) use it$/);
  assert.match(clis[1].message, /: signed in; Dave uses it$/);

  s.claude.login('claude/auth-status-logged-out');
  const partial = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false }), 'agent CLIs');
  assert.deepEqual(partial.map(f => f.status), ['fail', 'ok']);
  assert.ok(partial.some(isProblem), 'a working unused CLI cannot mask an assigned brain failure');
  clis = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env: { ...env, BOTONS_CODEX_BIN: join(s.home, 'no-codex') }, container: false }), 'agent CLIs');
  assert.deepEqual(clis.map((f) => f.status), ['fail', 'fail', 'fail']);
  assert.ok(clis.some(isProblem), 'established Botons without any usable CLI remain a real problem');
  assert.match(clis[0].message, /not signed in; 3 Botons \(Kevin, Stuart and Bob\) use it and can't answer until it is$/);
  assert.match(clis[0].fix!, /^claude auth login .*, or move those Botons to another brain in their settings$/);
  assert.match(clis[1].message, /^codex: not installed \(.*\); Dave uses it and can't answer$/);
  assert.match(clis[1].fix!, /BOTONS_CODEX_BIN\), or move that Boton to another brain in its settings\.$/);

  // An unused brain that is missing stays a note.
  s.app.store.db.prepare("update bots set provider = 'claude-cli' where provider = 'codex-cli'").run();
  clis = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env: { ...env, BOTONS_CODEX_BIN: join(s.home, 'no-codex') }, container: false }), 'agent CLIs');
  assert.equal(clis[1].status, 'info');
  assert.match(clis[1].message, /^codex: not installed \([^)]*\)$/);

  // A usage limit still in force is reported with its reset; one that has passed is not.
  const run = () => diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false, skipClis: true });
  assert.deepEqual(of(await run(), 'limits'), []);
  s.app.store.setCooldown('claude-cli', new Date('2099-01-02T03:04:00.000Z'), 'usage limit reached');
  s.app.store.setCooldown('codex-cli', new Date(Date.now() - 60_000), 'usage limit reached');
  const limits = of(await run(), 'limits');
  assert.deepEqual(
    limits.map((f) => [f.status, f.message]),
    [['info', 'claude reached its usage limit: 4 Botons (Kevin, Stuart, Bob and 1 more) wait until 2099-01-02 03:04 UTC, then carry on by themselves, unless paused (resume first)']],
  );
  assert.match(limits[0].fix!, /move a Boton to another signed-in brain in its settings/);
  s.app.store.db.prepare("update bots set provider = 'codex-cli' where name != 'Dave'").run();
  assert.match(of(await run(), 'limits')[0].message, /: Dave waits until 2099-01-02 03:04 UTC, then carries on by itself, unless paused \(resume first\)$/);
  s.app.store.db.prepare("update provider_cooldowns set until = 'zzz' where provider = 'codex-cli'").run();
  const malformed = await run();
  assert.ok(of(malformed, 'limits').some((f) => f.status === 'warn' && /invalid/.test(f.message)));
  assert.ok(of(malformed, 'runs').length > 0, 'unrelated run diagnostics still execute');
  await s.stop();
});

test("doctor shows each Boton's configured brain: provider, model, configured effort, and routines with their own", async () => {
  const s = await startServer();
  const run = async () => of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(s.home, { BOTONS_PORT: String(s.port) }), container: false, skipClis: true }), 'brain');
  const carl = s.storeBot('Carl', 'claude-cli', { model: 'sonnet', effort: 'high' });
  s.storeBot('Kevin', 'codex-cli');
  s.app.store.createRoutine(carl.id, { name: 'Quick check', instruction: 'Look', effort: 'low' });
  s.app.store.createRoutine(carl.id, { name: 'Deep', instruction: 'Dig', model: 'opus' });
  s.app.store.createRoutine(carl.id, { name: 'Plain', instruction: 'Do' });
  assert.deepEqual(
    (await run()).map((f) => [f.status, f.message]),
    [
      ['info', 'Carl: claude-cli, model sonnet, configured effort high; routines with their own: “Quick check” configured effort low; “Deep” model opus'],
      ['info', "Kevin: codex-cli, model default, configured effort none (the CLI's default)"],
    ],
  );
  // A stored level the provider doesn't have runs at its default, and says so.
  s.app.store.db.prepare("update bots set effort = 'turbo' where id = ?").run(carl.id);
  assert.match((await run())[0].message, /^Carl: claude-cli, model sonnet, configured effort turbo \(not one of claude-cli's levels: not asked for\);/);
  await s.stop();
});

test("doctor lists the Botons whose connectors can't be used: before the upgrade, what it takes off; after, notices and broken grants", async () => {
  const home = tempDir();
  const now = '2026-11-06T09:00:00.000Z';
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-22.sql'), 'utf8')}\npragma user_version = 22;`);
  const bot = db.prepare("insert into bots (id, name, look, provider, timezone, workspace, created_at, updated_at, last_activity_at, connections) values (?, ?, '{}', 'codex-cli', 'UTC', ?, ?, ?, ?, ?)");
  bot.run('bot_kevin', 'Kevin', 'kevin', now, now, now, '["codex:notes","oauth:notes"]');
  bot.run('bot_bob', 'Bob', 'bob', now, now, now, '["lib:wiki"]');
  db.prepare("insert into mcp_servers (name, transport, url, created_at, updated_at) values ('wiki', 'http', 'https://wiki.example.com/mcp', ?, ?)").run(now, now);
  db.prepare("insert into oauth_connections (id, name, url, status, created_at, updated_at) values ('oac_1', 'notes', 'https://mcp.notes.example.com/mcp', 'reconnect', ?, ?)").run(now, now);
  db.close();
  const run = () => diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home), container: false, health: async () => null, skipClis: true });

  let found = of(await run(), 'connectors');
  assert.deepEqual(found.map((f) => [f.status, f.message]), [['info', "The upgrade takes Kevin's connectors from the CLIs' own settings off it: codex:notes"]]);

  // The server's start upgrades it (after a backup); then the notice and the signed-out grant are listed.
  const s = await startServer({ home });
  await s.stop();
  found = of(await run(), 'connectors');
  assert.deepEqual(
    found.map((f) => [f.status, f.message]),
    [
      ['warn', 'Kevin lost connectors from the CLIs\' own settings in the upgrade: codex:notes'],
      ['warn', "Kevin has connectors it can't use: oauth:notes (needs signing in)"],
    ],
  );
  assert.match(found[0].fix ?? '', /Boton's settings/);
});

test('managed release doctor uses Botons commands while checkout hints keep npm commands', async () => {
  const home = tempDir();
  const managedRoot = tempDir();
  const app = join(managedRoot, 'releases/1.2.3');
  mkdirSync(app, { recursive: true });
  const { writeFileSync } = await import('node:fs');
  const { openSchema } = await import('../src/schema.ts');
  writeFileSync(join(managedRoot, 'installer.json'), '{}');
  const db = new DatabaseSync(join(home, 'botons.db'));
  openSchema(db);
  db.close();
  const options = { env: envFor(home), container: false, skipClis: true, health: async () => null };
  const managed = await diagnose({ egress: async () => ({ v4: true, v6: true }), ...options, app });
  assert.match(of(managed, 'devices')[0].fix!, /botons pair --approve/);
  assert.match(of(managed, 'backups')[0].fix!, /botons backup/);
  assert.doesNotMatch(of(managed, 'backups')[0].fix!, /npm run/);
  assert.match(of(managed, 'browser')[0].fix!, /botons repair/);
  assert.ok(managed.every(finding => !finding.fix?.includes('npm ci')));
  const checkout = await diagnose({ egress: async () => ({ v4: true, v6: true }), ...options, app: repo });
  assert.match(of(checkout, 'devices')[0].fix!, /npm run pair/);
  assert.match(of(checkout, 'backups')[0].fix!, /npm run backup/);
});

test('doctor reports incompatible Codex with upgrade guidance instead of a sign-in repair', async () => {
  const s = await startServer({ fakeClis: true });
  try {
    s.storeBot('Dave', 'codex-cli');
    s.codex!.version('codex-cli 0.160.0');
    const env = envFor(s.home, { BOTONS_CODEX_BIN: s.codex!.bin });
    const findings = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false, health: async () => null }), 'agent CLIs');
    const codex = findings.find((f) => f.message.startsWith('codex 0.160.0 (system copy)'))!;
    assert.equal(codex.status, 'fail');
    assert.match(codex.message, /needs update; Dave uses it and can't answer/);
    assert.match(codex.fix!, /0\.166\.0.*Bad file descriptor.*Upgrade Codex/);
    assert.ok(findings.some((f) => f.status === 'fail'), 'an incompatible CLI cannot count as available');
  } finally { s.codex!.version('codex-cli 0.166.0'); }
});

test('doctor detects symlinked Codex instructions and skills without reading or replacing them', async () => {
  const home = tempDir();
  const config = join(home, 'agent-config');
  mkdirSync(config);
  const target = join(home, 'instructions.md');
  writeFileSync(target, 'private fixture content must not appear');
  symlinkSync(target, join(config, 'AGENTS.md'));
  symlinkSync(join(home, 'missing-skills'), join(config, 'skills'));
  const findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home, { CODEX_HOME: config }), container: false, skipClis: true, health: async () => null });
  assert.equal(of(findings, 'Codex config').length, 0);
  writeFileSync(join(config, 'auth.json'), '{}');
  const [finding] = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env: envFor(home, { CODEX_HOME: config }), container: false, skipClis: true, health: async () => null }), 'Codex config');
  assert.equal(finding.status, 'warn');
  assert.match(finding.message, /CODEX_HOME\/AGENTS.md.*CODEX_HOME\/skills.*Can't mount on symlink destination/);
  assert.match(finding.fix!, /owner can replace.*reviewed copies/);
  assert.ok(!JSON.stringify(findings).includes('private fixture content'));
  assert.ok(lstatSync(join(config, 'AGENTS.md')).isSymbolicLink());
  assert.equal(readFileSync(target, 'utf8'), 'private fixture content must not appear');
});

test('CLI update notices point to Settings without exposing installation commands', async () => {
  const s = await startServer({ fakeClis: true });
  try {
    s.claude.version('2.1.316 (Claude Code)');
    writeFileSync(join(s.home, 'release-checks.json'), JSON.stringify({
      'claude-cli': { latest: '99.0.0', checkedAt: Date.now(), failed: false },
      'codex-cli': { latest: '99.0.0', checkedAt: Date.now(), failed: false },
    }));
    const env = envFor(s.home, { BOTONS_CLAUDE_BIN: s.claude.bin, BOTONS_CODEX_BIN: s.codex.bin });
    const notices = of(await diagnose({ egress: async () => ({ v4: true, v6: true }), env, container: false }), 'CLI updates');
    assert.equal(notices.length, 2);
    assert.deepEqual(notices.map(f => f.fix), ['Update Claude Code in Settings → Brains.', 'Update Codex in Settings → Brains.']);
    assert.ok(notices.every(f => f.message.includes(f.fix!)), 'normal output includes the action');
    assert.doesNotMatch(JSON.stringify(notices), /npm-cli|--prefix|Botons update|confirm this command/);
  } finally { await s.stop(); }
});

test('doctor JSON remains a single document when the production sandbox is unavailable', () => {
  const home = tempDir();
  const result = spawnSync(process.execPath, [join(repo, 'scripts/doctor.ts'), '--json', '--skip-clis', '--skip-network'], {
    env: { HOME: home, BOTONS_HOME: join(home, 'data'), BOTONS_PORT: '19873', BOTONS_NO_TAILSCALE: '1', BOTONS_BROWSER_PATH: join(home, 'no-browser'), PATH: join(home, 'no-programs') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(result.status, 2, result.stderr);
  const document = JSON.parse(result.stdout);
  const notices = document.findings.filter((f: Finding) => /Workspace.*unavailable/.test(f.message));
  assert.equal(notices.length, 1, 'one summary even when multiple sandboxes are unavailable');
  assert.equal(notices[0].check, 'Workspace');
  assert.equal(notices[0].status, 'info');
  assert.match(notices[0].message, process.platform === 'darwin' ? /Claude, Codex, API tools/ : /Claude, API tools/);
  assert.ok(notices[0].message.length < 160);
  assert.equal(notices[0].fix, undefined);
  assert.ok(!result.stdout.includes('"level":"warn"'), 'diagnostic logs never precede the JSON document');
});

test("the browser's network: no IPv6 is only information, nothing reached at all a warning", () => {
  assert.deepEqual(egressFinding({ v4: true, v6: false }), { status: 'info', message: 'IPv6 isn’t available on this server; the browser uses IPv4' });
  assert.equal(egressFinding({ v4: true, v6: true }).status, 'ok');
  assert.equal(egressFinding({ v4: false, v6: false }).status, 'warn');
});

test('doctor sums what files take in one line, and warns past 1 GB in an inbox or 5 GB in all, pointing at Clear inbox and the trash', async () => {
  const s = await startServer();
  const run = async () => of(await diagnose({ env: envFor(s.home, { BOTONS_PORT: String(s.port) }), container: false, skipClis: true }), 'storage');
  const bob = s.storeBot('Bob');
  mkdirSync(join(bob.workspace, 'inbox'), { recursive: true });
  writeFileSync(join(bob.workspace, 'inbox', 'a.bin'), 'a'.repeat(2048));
  writeFileSync(join(bob.workspace, 'notes.txt'), 'n'.repeat(1024));
  writeFileSync(join(s.cfg.sharedDir, 'shared.txt'), 's'.repeat(1024));
  assert.deepEqual(
    (await run()).map((f) => [f.status, f.message]),
    [['info', 'Files take 4 KB: workspaces 3 KB (inboxes 2 KB), trash 0 B, shared 1 KB']],
  );
  // Sparse: its size, not its blocks, is what counts.
  truncateSync(join(bob.workspace, 'inbox', 'a.bin'), 1.5 * 1024 ** 3);
  const [big] = await run();
  assert.equal(big.status, 'warn');
  assert.match(big.message, /big inbox: Bob 1\.5 GB/);
  assert.match(big.fix ?? '', /Clear inbox/);
  await s.stop();
});
