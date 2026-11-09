// Each brain's readiness: what the server's checks of the fake CLIs found, as fixed words, the owner's rate-limited
// "check again", and the owner view. Never the real claude or codex CLI.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import type { OperationsStatus, ProviderInfo } from '../../shared/types.ts';
import { type CheckClock, type CliCheck, checkCli, checkCodexCli, cliStatus, CliChecker, parseClaudeLogin, parseCodexLogin } from '../src/providers/cli-check.ts';
import { OWNER_RECHECK_WINDOW_MS, OWNER_RECHECKS, ProviderRegistry } from '../src/providers/index.ts';
import { brainReadiness, CHECK_OUTDATED_MS } from '../src/providers/readiness.ts';
import type { ProviderStatus } from '../src/providers/types.ts';
import { fakeCli } from './fixtures/fake-cli.ts';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: 'claude-cli', label: 'Claude Code', kind: 'cli', available: true, reason: null, installed: true, version: '2.1.3', loggedIn: true,
  checkedAt: new Date(NOW - 60_000).toISOString(), models: [], defaultModel: '', check: { problem: null, generation: 7 }, ...over,
});
const stateOf = (over: Partial<ProviderStatus>, limit: string | null = null) => {
  const r = brainReadiness(status(over), limit, NOW);
  return [r.state, r.problem];
};

test('readiness: ready only when a recent check confirmed it installed and signed in; what it could not tell is unknown', () => {
  assert.deepEqual(brainReadiness(status(), null, NOW, 'boot-1'), { state: 'ready', problem: null, checkedAt: status().checkedAt, usageLimitUntil: null, boot: 'boot-1', generation: 7 });
  assert.deepEqual(stateOf({ checkedAt: null, check: undefined }), ['unknown', 'not-checked']);
  assert.deepEqual(stateOf({ checkedAt: new Date(NOW - CHECK_OUTDATED_MS - 1).toISOString() }), ['unknown', 'outdated']);
  // A check that found it signed in long ago says nothing of now.
  assert.deepEqual(stateOf({ checkedAt: new Date(NOW - CHECK_OUTDATED_MS - 1).toISOString(), loggedIn: true }), ['unknown', 'outdated']);
  const failed = (problem: NonNullable<ProviderStatus['check']>['problem'], over: Partial<ProviderStatus> = {}) => stateOf({ check: { problem, generation: 7 }, ...over });
  assert.deepEqual(failed('not-found', { installed: false, available: false, loggedIn: null }), ['not-installed', 'not-found']);
  assert.deepEqual(failed('not-runnable', { installed: false, available: false, loggedIn: null }), ['unavailable', 'not-runnable']);
  assert.deepEqual(failed('version-failed', { installed: false, available: false, loggedIn: null }), ['unavailable', 'version-failed']);
  // `installed` is false when --version doesn't answer: that alone doesn't mean it isn't there.
  assert.deepEqual(failed('timed-out', { installed: false, available: false, loggedIn: null }), ['unknown', 'timed-out']);
  assert.deepEqual(failed('timed-out', { loggedIn: null }), ['unknown', 'timed-out']);
  assert.deepEqual(failed('login-unreadable', { loggedIn: null }), ['unknown', 'login-unreadable']);
  assert.deepEqual(failed('signed-out', { loggedIn: false, available: false }), ['signed-out', 'signed-out']);
  // A provider whose check doesn't name its problem.
  assert.deepEqual(stateOf({ check: undefined, loggedIn: null }), ['unknown', 'login-unreadable']);
  assert.deepEqual(stateOf({ check: undefined, installed: false, available: false }), ['not-installed', 'not-found']);
  assert.deepEqual(stateOf({ check: undefined, loggedIn: false, available: false }), ['signed-out', 'signed-out']);
  assert.deepEqual(stateOf({ check: undefined, available: false }), ['unavailable', 'unavailable']);
});

test('readiness: a usage limit holds a brain that is (or may be) signed in, never hides that it is signed out or missing', () => {
  const until = '2026-11-06T15:00:00.000Z';
  assert.deepEqual(brainReadiness(status(), until, NOW), { state: 'usage-limited', problem: 'usage-limit', checkedAt: status().checkedAt, usageLimitUntil: until, boot: '', generation: 7 });
  assert.deepEqual(stateOf({ checkedAt: null, check: undefined }, until), ['usage-limited', 'usage-limit']);
  assert.deepEqual(stateOf({ check: { problem: 'signed-out', generation: 7 }, loggedIn: false, available: false }, until), ['signed-out', 'signed-out']);
  assert.deepEqual(stateOf({ check: { problem: 'not-found', generation: 7 }, installed: false, available: false }, until), ['not-installed', 'not-found']);
});

test('readiness: a check stamped later than the clock now (it was set back) is unknown, however recent it says it is', () => {
  const at = (ms: number) => ({ checkedAt: new Date(NOW + ms).toISOString() });
  assert.deepEqual(stateOf(at(60 * 60_000)), ['unknown', 'clock-changed'], 'an hour ahead');
  assert.deepEqual(stateOf(at(1)), ['unknown', 'clock-changed']);
  assert.deepEqual(stateOf(at(0)), ['ready', null]);
  assert.deepEqual(stateOf(at(-CHECK_OUTDATED_MS)), ['ready', null], 'at the edge it still counts');
  assert.deepEqual(stateOf(at(-CHECK_OUTDATED_MS - 1)), ['unknown', 'outdated']);
  // A signed-out answer from the future is no more trusted than a signed-in one.
  assert.deepEqual(stateOf({ ...at(60 * 60_000), check: { problem: 'signed-out', generation: 7 }, loggedIn: false, available: false }), ['unknown', 'clock-changed']);
});

/** A stand-in CLI: `--version` and the login status do what the script says. */
function script(dir: string, name: string, body: string, executable = true, fastVersion = false): string {
  const bin = join(dir, name);
  const program = `#!${process.execPath} --no-warnings\nconst args = process.argv.slice(2).join(' ');\n${body}\n`;
  if (fastVersion) {
    // The short deadline exercises login, not Node startup on a busy runner.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(`${bin}.mjs`, program);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = --version ]; then printf '1.0.0\\n'; exit 0; fi\nexec ${quote(process.execPath)} --no-warnings ${quote(`${bin}.mjs`)} "$@"\n`);
  } else writeFileSync(bin, program);
  chmodSync(bin, executable ? 0o755 : 0o644);
  return bin;
}

test('checks name what they found as a fixed word: missing, not runnable, --version failing, no answer, an unreadable or signed-out login', async () => {
  const dir = tempDir();
  const claude = fakeCli(dir, 'claude');
  const check = (bin: string, timeoutMs?: number) => checkCli(bin, ['auth', 'status'], parseClaudeLogin, timeoutMs);
  assert.equal((await check(claude.bin)).problem, null);
  claude.login('claude/auth-status-logged-out');
  assert.deepEqual([(await check(claude.bin)).problem, (await check(claude.bin)).loggedIn], ['signed-out', false]);
  assert.equal((await check(join(dir, 'no-such-cli'))).problem, 'not-found');
  assert.equal((await check(script(dir, 'not-executable', "process.stdout.write('1.0.0')", false))).problem, 'not-runnable');
  assert.equal((await check(script(dir, 'broken', 'process.exitCode = 3;'))).problem, 'version-failed');
  const hangs = script(dir, 'hangs', "if (args === '--version') process.stdout.write('1.0.0\\n'); else setInterval(() => {}, 1000);", true, true);
  const slow = await check(hangs, 300);
  assert.deepEqual([slow.installed, slow.loggedIn, slow.problem], [true, null, 'timed-out']);
  const odd = script(dir, 'odd', "if (args === '--version') process.stdout.write('1.0.0\\n'); else { process.stdout.write('token sk-test-secret at /home/you'); process.exitCode = 1; }");
  const unreadable = await check(odd);
  assert.deepEqual([unreadable.loggedIn, unreadable.problem], [null, 'login-unreadable']);
  const codexOdd = await checkCli(odd, ['login', 'status'], parseCodexLogin);
  assert.equal(codexOdd.problem, 'login-unreadable');
});

test('a login check that didn\'t answer in time, or failed, never confirms a sign-in, whatever it printed', async () => {
  const dir = tempDir();
  const fake = (name: string, login: string) => script(dir, name, `if (args === '--version') process.stdout.write('1.0.0\\n'); else { ${login} }`, true, true);
  const claude = (bin: string, timeoutMs?: number) => checkCli(bin, ['auth', 'status'], parseClaudeLogin, timeoutMs);
  const seen = (c: CliCheck) => [c.installed, c.loggedIn, c.problem];
  // It says signed in, then hangs until killed.
  const hangs = await claude(fake('says-in-then-hangs', "process.stdout.write(JSON.stringify({ loggedIn: true })); setInterval(() => {}, 1000);"), 300);
  assert.deepEqual(seen(hangs), [true, null, 'timed-out']);
  assert.match(hangs.reason!, /did not answer within 0\.3s/);
  const outHangs = await claude(fake('says-out-then-hangs', "process.stdout.write(JSON.stringify({ loggedIn: false })); setInterval(() => {}, 1000);"), 300);
  assert.deepEqual(seen(outHangs), [true, null, 'timed-out'], 'no answer is no answer, either way');
  // It says signed in, and fails.
  const fails = await claude(fake('says-in-fails', "process.stdout.write(JSON.stringify({ loggedIn: true })); process.exitCode = 1;"));
  assert.deepEqual(seen(fails), [true, null, 'login-unreadable']);
  // Signed out on a failed exit is what claude auth status does: taken.
  assert.deepEqual(seen(await claude(fake('says-out-fails', "process.stdout.write(JSON.stringify({ loggedIn: false })); process.exitCode = 1;"))), [true, false, 'signed-out']);
  for (const [name, out] of [['string', '{"loggedIn":"true"}'], ['malformed', '{"loggedIn":tr'], ['partial', '{}'], ['empty', '']]) {
    for (const code of [0, 1]) {
      const c = await claude(fake(`${name}-${code}`, `process.stdout.write(${JSON.stringify(out)}); process.exitCode = ${code};`));
      assert.deepEqual(seen(c), [true, null, 'login-unreadable'], `${name}, exit ${code}`);
    }
  }
  // Codex says so in words; a hang after them confirms nothing either.
  const codex = await checkCli(fake('codex-hangs', "process.stdout.write('Logged in using ChatGPT\\n'); setInterval(() => {}, 1000);"), ['login', 'status'], parseCodexLogin, 300);
  assert.deepEqual(seen(codex), [true, null, 'timed-out']);
});

/** Clocks a test sets: `elapsed` only goes forward, `wall` can be set back. */
function clocks(): CheckClock & { elapsedMs: number; wallMs: number } {
  const c = { elapsedMs: 0, wallMs: NOW, elapsed: () => c.elapsedMs, now: () => c.wallMs };
  return c;
}

test('each check the checker finishes has a higher generation, counted per run of the server: its boot tells runs apart', async () => {
  let loggedIn = true;
  const checker = new CliChecker('claude-cli', async () => ({ installed: true, version: null, loggedIn, reason: null, checkedAt: new Date().toISOString() }));
  const first = await checker.get();
  assert.equal(first.generation, 1);
  assert.equal((await checker.get()).generation, first.generation, 'a reused check keeps its generation');
  loggedIn = false;
  checker.invalidate();
  const second = await checker.get();
  assert.equal(second.loggedIn, false);
  assert.equal(second.generation, 2);
  // A restarted server counts from 1 again, under a new boot: never from the clock, which can be set back.
  const [a, b] = [new ProviderRegistry({ enableMock: true }), new ProviderRegistry({ enableMock: true })];
  assert.notEqual(a.boot, b.boot);
  assert.match(a.boot, /^[0-9a-f-]{36}$/);
  const mock = (await a.infos()).find((p) => p.id === 'mock')!;
  assert.deepEqual([mock.readiness.boot, mock.readiness.generation], [a.boot, 0]);
});

test('a cached check ages by a clock that only goes forward, and one stamped later than the wall clock now is run again', async () => {
  const clock = clocks();
  let runs = 0;
  const checker = new CliChecker('claude-cli', async () => (runs++, { installed: true, version: null, loggedIn: true, reason: null, checkedAt: new Date(clock.wallMs).toISOString() }), clock);
  await checker.get();
  assert.equal(runs, 1);
  clock.wallMs += 24 * 60 * 60_000;
  await checker.get();
  assert.equal(runs, 1, 'the wall clock jumping ahead doesn\'t age it');
  clock.elapsedMs += 5 * 60_000 - 1;
  await checker.get();
  assert.equal(runs, 1, 'just under the TTL');
  clock.elapsedMs += 1;
  await checker.get();
  assert.equal(runs, 2, 'at the TTL, whatever the wall clock says');
  // The wall clock goes back an hour: the cached check is from "the future", so the next ask runs a new one at once.
  clock.wallMs -= 60 * 60_000;
  const again = await checker.get();
  assert.equal(runs, 3);
  assert.equal(Date.parse(again.checkedAt), clock.wallMs);
  await checker.get();
  assert.equal(runs, 3, 'stamped with the clock as it is now, it is cached as usual');
  assert.equal(brainReadiness({ ...status(), checkedAt: again.checkedAt }, null, clock.wallMs).state, 'ready');
});

test('the owner\'s rechecks are limited per provider; past the limit they get the last check until the window passes', () => {
  const rechecks: string[] = [];
  const registry = new ProviderRegistry({ enableMock: true, claudeBin: '/nonexistent/claude', codexBin: '/nonexistent/codex' });
  for (const id of ['claude-cli', 'codex-cli']) registry.get(id)!.recheck = () => rechecks.push(id);
  const t0 = 1_000_000;
  for (let i = 0; i < OWNER_RECHECKS; i++) assert.deepEqual(registry.ownerRecheck(t0 + i), ['claude-cli', 'codex-cli']);
  assert.deepEqual(registry.ownerRecheck(t0 + 100), [], 'over the limit');
  assert.equal(rechecks.length, OWNER_RECHECKS * 2);
  assert.deepEqual(registry.ownerRecheck(t0 + OWNER_RECHECK_WINDOW_MS), ['claude-cli', 'codex-cli'], 'the oldest left the window');
});

useTestCodexHome(tempDir());
const s = await startServer({ fakeClis: true, env: { BOTONS_ENABLE_MOCK: '0' } });
const { app, claude, codex, call } = s;

beforeEach(async () => {
  claude!.login('claude/auth-status-logged-in');
  codex!.login('codex/login-status-logged-in');
  claude!.script('claude/reply');
  await app.providers.infos({ recheck: true });
});

const brains = async (recheck = false) => (await call<ProviderInfo[]>('GET', `/api/providers${recheck ? '?recheck=1' : ''}`)).data;
const brain = async (id: string, recheck = false) => (await brains(recheck)).find((p) => p.id === id)!;

test('/api/providers: each brain\'s readiness; the owner\'s check again finds a sign-out, with a newer generation', async () => {
  const before = await brain('claude-cli');
  assert.deepEqual([before.readiness.state, before.readiness.problem], ['ready', null]);
  assert.equal(before.readiness.checkedAt, before.checkedAt);
  claude!.login('claude/auth-status-logged-out');
  assert.equal((await brain('claude-cli')).readiness.state, 'ready', 'the last check stands until one is asked for');
  const after = await brain('claude-cli', true);
  assert.deepEqual([after.readiness.state, after.readiness.problem], ['signed-out', 'signed-out']);
  assert.ok(after.readiness.generation > before.readiness.generation);
  assert.equal((await brain('codex-cli')).readiness.state, 'ready');
});

test('a turn that hits a usage limit makes its brain usage-limited until the reset, in /api/providers and the owner view', async () => {
  const bot = s.storeBot('Kevin', 'claude-cli').id;
  claude!.script('claude/usage-limit');
  app.engine.sendMessage(bot, 'hello');
  const held = await until(async () => {
    const p = await brain('claude-cli');
    return p.readiness.state === 'usage-limited' && p;
  });
  assert.equal(held.readiness.problem, 'usage-limit');
  assert.equal(held.readiness.usageLimitUntil, held.usageLimit?.until);
  const ops = (await call<OperationsStatus>('GET', '/api/operations')).data;
  const owner = ops.health.details.providers.find((p) => p.id === 'claude-cli')!;
  assert.deepEqual([owner.readiness.state, owner.readiness.usageLimitUntil], ['usage-limited', held.usageLimit?.until]);
  assert.equal((await brain('codex-cli')).readiness.state, 'ready', 'only that brain');
});

test('the owner view carries readiness as fixed words: never the check\'s text, the CLI\'s path or its output', async () => {
  claude!.login('claude/auth-status-logged-out');
  await brains(true);
  const r = await call<OperationsStatus>('GET', '/api/operations');
  const owner = r.data.health.details.providers.find((p) => p.id === 'claude-cli')!;
  assert.deepEqual([owner.readiness.state, owner.readiness.problem], ['signed-out', 'signed-out']);
  const raw = (await brain('claude-cli')).reason!;
  assert.match(raw, /claude auth login/, 'the paired device\'s own list keeps what the check said');
  for (const text of [raw, claude!.bin, s.home, 'auth login']) assert.ok(!r.text.includes(text), text);
});

test('Codex compatibility: refuse unsafe or unrecognized versions before login, and expose upgrade guidance to setup', async () => {
  const dir = tempDir();
  for (const version of ['codex-cli 0.160.0', 'codex-cli 0.165.0', 'unknown', 'codex-cli 0.166.0-alpha.1']) {
    const bin = script(dir, 'incompatible', `if (args === '--version') process.stdout.write(${JSON.stringify(version)}); else throw new Error('login must not run');`);
    const c = await checkCodexCli(bin);
    assert.equal(c.installed, true);
    assert.equal(c.problem, 'incompatible-version');
    assert.match(c.reason!, /0\.166\.0.*bubblewrap/);
    const p = status({ ...cliStatus(c) });
    assert.equal(p.available, false);
    assert.equal(brainReadiness(p, null).state, 'unavailable');
  }
  for (const version of ['codex-cli 0.166.0', 'codex-cli 0.167.0', 'codex-cli 1.0.0']) {
    const bin = script(dir, 'compatible', `process.stdout.write(args === '--version' ? ${JSON.stringify(version)} : 'Logged in using ChatGPT');`);
    assert.equal((await checkCodexCli(bin)).problem, null);
  }
});
