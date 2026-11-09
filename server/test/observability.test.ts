// Logs, CLI checks and /api/health, with the fake claude and codex CLIs and no mock provider.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import type { Health, ProviderInfo } from '../../shared/types.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { SCHEDULER_STALE_INTERVALS } from '../src/health.ts';
import { captureLogs, formatLine, isJournalStream, log, redact, setLogLevel } from '../src/log.ts';
import { type Captured, type CliCheck, CliChecker, checkCli, parseClaudeLogin, parseCodexLogin } from '../src/providers/cli-check.ts';
import { fakeCli, loadFixture } from './fixtures/fake-cli.ts';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

test('a log line is one JSON object with ts, level, msg and the fields; errors become error and stack; secrets are masked', () => {
  const at = new Date('2026-11-05T03:00:00.000Z');
  const line = formatLine('error', 'turn ended', { botId: 'bot_1', durationMs: 12, exitCode: null, skipped: undefined, err: new Error('boom\nsecond line') }, at);
  assert.ok(!line.includes('\n'), 'one line');
  const { stack, ...parsed } = JSON.parse(line);
  assert.deepEqual(parsed, { ts: '2026-11-05T03:00:00.000Z', level: 'error', msg: 'turn ended', botId: 'bot_1', durationMs: 12, exitCode: null, error: 'boom\nsecond line' });
  assert.match(stack, /^Error: boom\nsecond line\n\s+at /);
  // Fields can't overwrite ts, level or msg; a value that isn't an Error is logged as text.
  const odd = JSON.parse(formatLine('info', 'm', { msg: 'other', level: 'debug', err: { code: 42 }, n: 10n }, at));
  assert.deepEqual(odd, { ts: '2026-11-05T03:00:00.000Z', level: 'info', msg: 'm', error: '{"code":42}', n: '10' });
  // A field that can't be serialized costs the fields, not the line.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const safe = JSON.parse(formatLine('warn', 'still here', { cyclic }, at));
  assert.equal(safe.msg, 'still here');
  assert.match(safe.logError, /fields not logged/);

  const device = `mdt_${'a'.repeat(43)}`;
  const boton = `mmt_${'B-_9'.repeat(10)}`;
  const text = `token ${device} and ${boton}; Authorization: Bearer s3cr3t-value; /hooks/routines/rt_1?key=abc123&wait=1`;
  assert.equal(redact(text), 'token mdt_[redacted] and mmt_[redacted]; Authorization: Bearer [redacted]; /hooks/routines/rt_1?key=[redacted]&wait=1');
  const masked = JSON.parse(formatLine('info', `called with ${device}`, { path: '/x?key=zzz' }));
  assert.deepEqual([masked.msg, masked.path], ['called with mdt_[redacted]', '/x?key=[redacted]']);
});

test('BOTONS_LOG_LEVEL drops less severe lines, and the config rejects unknown levels', () => {
  const logged = captureLogs();
  try {
    setLogLevel('warn');
    log.info('quiet');
    log.debug('quieter');
    log.warn('loud', { botId: 'bot_1' });
    log.error('louder');
  } finally {
    logged.restore();
  }
  assert.deepEqual(logged.lines.map((l) => [l.level, l.msg]), [['warn', 'loud'], ['error', 'louder']]);

  const env = { BOTONS_HOME: tempDir('botons-log-cfg-'), BOTONS_NO_TAILSCALE: '1', BOTONS_HOST: '127.0.0.1' };
  assert.equal(loadConfig(env).logLevel, 'info');
  assert.equal(loadConfig({ ...env, BOTONS_LOG_LEVEL: 'DEBUG' }).logLevel, 'debug');
  assert.throws(
    () => loadConfig({ ...env, BOTONS_LOG_LEVEL: 'verbose' }),
    (err: ConfigError) => err instanceof ConfigError && /BOTONS_LOG_LEVEL must be one of debug, info, warn, error; got "verbose"/.test(err.errors.join()),
  );
});

test('under systemd (JOURNAL_STREAM names stdout) lines carry a syslog priority prefix for journald', () => {
  const stat = () => ({ dev: 64769n, ino: 123456n });
  assert.equal(isJournalStream('64769:123456', stat), true);
  assert.equal(isJournalStream('64769:999', stat), false, 'stdout redirected elsewhere (say, a child of the service)');
  assert.equal(isJournalStream(undefined, stat), false);
  assert.equal(isJournalStream('garbage', stat), false);
  const broken = () => {
    throw new Error('EBADF');
  };
  assert.equal(isJournalStream('1:2', broken), false);
});

const out = (o: Partial<Captured>): Captured => ({ code: 0, stdout: '', stderr: '', error: null, timedOut: false, ...o });
const fixtureOut = (name: string): Captured => {
  const fx = loadFixture(name);
  return out({ code: fx.exitCode as number, stdout: fx.stdout.join('\n'), stderr: fx.stderr });
};

test('the login checks read what `claude auth status` and `codex login status` really print', () => {
  assert.deepEqual(parseClaudeLogin(fixtureOut('claude/auth-status-logged-in'), 'myhost'), { loggedIn: true, reason: null });
  const claudeOut = 'Claude Code is not signed in. Run `claude auth login` on myhost, as the user the server runs as.';
  assert.deepEqual(parseClaudeLogin(fixtureOut('claude/auth-status-logged-out'), 'myhost'), { loggedIn: false, reason: claudeOut });
  assert.deepEqual(parseCodexLogin(fixtureOut('codex/login-status-logged-in'), 'myhost'), { loggedIn: true, reason: null });
  const codexOut = 'Codex is not signed in. Run `codex login` on myhost, as the user the server runs as.';
  assert.deepEqual(parseCodexLogin(fixtureOut('codex/login-status-logged-out'), 'myhost'), { loggedIn: false, reason: codexOut });
  // Anything else is "don't know", not signed out.
  const odd = parseClaudeLogin(out({ code: 1, stderr: 'error: unknown command "auth"\n' }));
  assert.equal(odd.loggedIn, null);
  assert.match(odd.reason!, /Could not check the Claude login \(`claude auth status`\): error: unknown command "auth"/);
  assert.match(parseCodexLogin(out({ code: null, timedOut: true })).reason!, /did not answer within 10s/);
});

test('a CLI check finds the version and login, and reuses them until invalidated', async (t) => {
  const dir = tempDir('botons-cli-check-');
  const claude = fakeCli(dir, 'claude');
  const fine = await checkCli(claude.bin, ['auth', 'status'], parseClaudeLogin);
  assert.deepEqual({ ...fine, checkedAt: 'x' }, { installed: true, version: '0.0.0 (fake)', loggedIn: true, reason: null, checkedAt: 'x', problem: null });
  claude.login('claude/auth-status-logged-out');
  const out = await checkCli(claude.bin, ['auth', 'status'], parseClaudeLogin);
  assert.equal(out.loggedIn, false);
  assert.match(out.reason!, /claude auth login/);
  const missing = await checkCli(join(dir, 'no-such-cli'), ['auth', 'status'], parseClaudeLogin);
  assert.equal(missing.installed, false);
  assert.equal(missing.reason, `\`${join(dir, 'no-such-cli')}\` was not found on PATH`);

  let runs = 0;
  const checker = new CliChecker('claude-cli', async () => ({ installed: true, version: null, loggedIn: runs++ === 0, reason: null, checkedAt: '' }));
  const logged = captureLogs();
  t.after(logged.restore);
  assert.equal((await Promise.all([checker.get(), checker.get()]))[0].loggedIn, true);
  assert.equal(runs, 1, 'callers share one check');
  await checker.get();
  assert.equal(runs, 1, 'reused');
  checker.invalidate();
  assert.equal((await checker.get()).loggedIn, false);
  assert.equal(runs, 2);
  assert.deepEqual(logged.lines.map((l) => [l.level, l.provider, l.loggedIn]), [['warn', 'claude-cli', false]]);
});

test('rechecks asked for while a CLI check runs wait for it and share one new check, so checks never overlap', async (t) => {
  let running = 0;
  let most = 0;
  const started: Array<(c: CliCheck) => void> = [];
  const checker = new CliChecker('claude-cli', () => {
    most = Math.max(most, ++running);
    return new Promise<CliCheck>((resolve) =>
      started.push((c) => {
        running--;
        resolve(c);
      }),
    );
  });
  const check = (loggedIn: boolean): CliCheck => ({ installed: true, version: null, loggedIn, reason: loggedIn ? null : 'signed out', checkedAt: '' });
  const recheck = () => {
    checker.invalidate();
    return checker.get();
  };
  const settle = () => new Promise((r) => setImmediate(r));
  const logged = captureLogs();
  t.after(logged.restore);

  const first = recheck();
  await settle();
  assert.equal(started.length, 1);
  const queued = [recheck(), recheck(), recheck()];
  await settle();
  assert.equal(started.length, 1, 'the next check waits for the running one');
  started[0](check(true));
  assert.equal((await first).loggedIn, true);
  await settle();
  assert.equal(started.length, 2, 'the rechecks share one new check');
  started[1](check(false));
  // Each from a check that started after it was asked for.
  for (const p of queued) assert.equal((await p).loggedIn, false);
  // Done: a recheck now runs a new check at once.
  const later = recheck();
  await settle();
  assert.equal(started.length, 3);
  started[2](check(true));
  assert.equal((await later).loggedIn, true);
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(logged.lines.map((l) => [l.level, l.loggedIn]), [['warn', false], ['info', true]]);
});

const INTERVAL_MS = 60_000;
useTestCodexHome(tempDir());
// Ticks once at start, then not again.
const { app, cfg, claude, codex, call, chat: turn, storeBot } = await startServer({ fakeClis: true, env: { BOTONS_ENABLE_MOCK: '0', BOTONS_SCHEDULER_MS: String(INTERVAL_MS) } });

beforeEach(async () => {
  claude.login('claude/auth-status-logged-in');
  codex.login('codex/login-status-logged-in');
  claude.script('claude/reply');
  app.health.schedulerTicked();
  await app.providers.infos({ recheck: true });
});

const health = (paired = false) => call<Health>('GET', '/api/health', undefined, paired ? undefined : null);
const claudeInfo = async (path = '/api/providers') => (await call<ProviderInfo[]>('GET', path)).data.find((p) => p.id === 'claude-cli')!;
const claudeBot = (name: string) => storeBot(name, 'claude-cli').id;

test('/api/providers reports each CLI version and login; a signed-out claude shows loggedIn:false with a reason', async () => {
  const fine = await claudeInfo();
  assert.deepEqual([fine.available, fine.installed, fine.loggedIn, fine.version, fine.reason], [true, true, true, '0.0.0 (fake)', null]);
  assert.ok(fine.checkedAt);

  claude.login('claude/auth-status-logged-out');
  assert.equal((await claudeInfo()).loggedIn, true, 'checks are reused');
  const out = await claudeInfo('/api/providers?recheck=1');
  assert.deepEqual([out.loggedIn, out.available, out.installed], [false, false, true]);
  assert.match(out.reason!, /Claude Code is not signed in\. Run `claude auth login` on /);
  assert.equal(await app.providers.defaultProvider(), 'codex-cli');
});

test('every turn logs a start and an end line; a failed one has the stderr tail, and counts as the provider\'s last error', async (t) => {
  const bot = claudeBot('Logan');
  const logged = captureLogs();
  t.after(logged.restore);
  claude.script('claude/reply');
  assert.equal((await turn(bot, 'hello')).role, 'bot');
  claude.script('claude/model-not-found');
  assert.equal((await turn(bot, 'again')).role, 'error');
  const lines = logged.lines.filter((l) => l.botId === bot && l.msg.startsWith('turn '));
  const started = ['turn started', 'info', undefined, 'chat', 'claude-cli'];
  assert.deepEqual(lines.map((l) => [l.msg, l.level, l.outcome, l.trigger, l.provider]), [
    started,
    ['turn ended', 'info', 'ok', 'chat', 'claude-cli'],
    started,
    ['turn ended', 'error', 'error', 'chat', 'claude-cli'],
  ]);
  const failed = lines[3];
  assert.deepEqual([typeof failed.durationMs, failed.exitCode, failed.timedOut], ['number', 1, false]);
  assert.match(String(failed.stderr), /\[claude-code:unrecognized_model\]/);
  assert.match(String(failed.error), /issue with the selected model/);
  assert.ok(!JSON.stringify(logged.lines).includes('pong'));

  const info = await claudeInfo();
  assert.ok(info.lastSuccessAt);
  assert.match(info.lastError!.message, /issue with the selected model/);
  assert.ok(info.lastError!.at >= info.lastSuccessAt!);
});

test('a login that expires between checks: the failed turn makes the server check again at once, and that is logged', async (t) => {
  const bot = claudeBot('Night owl');
  assert.equal((await claudeInfo()).loggedIn, true);
  claude.login('claude/auth-status-logged-out');
  claude.script('claude/error');
  const logged = captureLogs();
  t.after(logged.restore);
  assert.equal((await turn(bot, 'morning brief')).role, 'error');
  const noticed = await until(() => logged.lines.find((l) => l.msg.startsWith("claude-cli can't run turns")));
  assert.deepEqual([noticed.level, noticed.loggedIn], ['warn', false]);
  assert.match(noticed.msg, /claude auth login/);
  const info = await claudeInfo();
  assert.deepEqual([info.loggedIn, info.available], [false, false]);
});

test('a turn stopped by the owner logs outcome stopped and is not held against the provider', async (t) => {
  const bot = claudeBot('Halt');
  const before = (await claudeInfo()).lastError;
  claude.script({ fixture: 'claude/reply', hang: true });
  const logged = captureLogs();
  t.after(logged.restore);
  app.engine.sendMessage(bot, 'take your time');
  await until(() => app.engine.statusOf(bot).state === 'working' && logged.lines.some((l) => l.msg === 'turn started' && l.botId === bot));
  app.engine.stop(bot);
  const end = await until(() => logged.lines.find((l) => l.msg === 'turn ended' && l.botId === bot));
  assert.deepEqual([end.outcome, end.level], ['stopped', 'info']);
  assert.deepEqual((await claudeInfo()).lastError, before);
});

test('/api/health: 503 naming the failing check (providers, scheduler, database), with details only for a paired device', async (t) => {
  const ok = await health();
  assert.deepEqual([ok.status, ok.data], [200, { ok: true, build: cfg.build, failing: [] }]);

  claude.login('claude/auth-status-logged-out');
  codex.login('codex/login-status-logged-out');
  await app.providers.infos({ recheck: true });
  const down = await health();
  assert.deepEqual([down.status, Object.keys(down.data).sort(), down.data.failing, down.data.ok], [503, ['build', 'failing', 'ok'], ['providers'], false]);
  const { status, data } = await health(true);
  assert.equal(status, 503);
  assert.deepEqual(data.details!.providers.map((p) => [p.id, p.loggedIn, p.available]), [
    ['claude-cli', false, false],
    ['codex-cli', false, false],
    // No API key: no key brain to fall back on.
    ['anthropic-api', false, false],
    ['openai-api', false, false],
  ]);
  assert.deepEqual([data.details!.database.ok, data.details!.scheduler.intervalMs], [true, INTERVAL_MS]);

  // One provider back is enough.
  codex.login('codex/login-status-logged-in');
  await app.providers.infos({ recheck: true });
  assert.equal((await health()).status, 200);

  app.health.schedulerTicked(Date.now() - SCHEDULER_STALE_INTERVALS * INTERVAL_MS + 5_000);
  assert.equal((await health()).status, 200, 'not yet');
  app.health.schedulerTicked(Date.now() - SCHEDULER_STALE_INTERVALS * INTERVAL_MS - 1_000);
  const stale = await health(true);
  assert.deepEqual([stale.status, stale.data.failing], [503, ['scheduler']]);
  assert.ok(stale.data.details!.scheduler.lastTickAt);
  app.health.schedulerTicked();

  t.mock.method(app.store.db, 'prepare', () => {
    throw new Error('database disk image is malformed');
  });
  const broken = await app.health.check();
  t.mock.restoreAll();
  assert.deepEqual([broken.ok, broken.failing, broken.details.database.error], [false, ['database'], 'database disk image is malformed']);
});
