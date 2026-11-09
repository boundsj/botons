import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Bot, Message, Routine } from '../../shared/types.ts';
import type { LogLine } from '../src/log.ts';
import { runJsonl } from '../src/providers/process.ts';
import { fakeCli } from './fixtures/fake-cli.ts';
import { freePort, noRealClis, sleep, tempDir, until } from './helpers.ts';

const here = import.meta.dirname;

/** `node server/src/index.ts` (with `preload`, if any) on a fresh data folder (or `home`), once it is running; killed after the test. */
async function spawnServer(t: TestContext, env: Record<string, string> = {}, preload?: string, home = tempDir('botons-proc-test-')) {
  const port = await freePort();
  const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), join(here, '../src/index.ts')], {
    env: {
      // Inherited PORT would override BOTONS_PORT, and other BOTONS_* settings would leak in.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT' && !k.startsWith('BOTONS_'))),
      BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(port), BOTONS_NO_TAILSCALE: '1', BOTONS_ENABLE_MOCK: '1', ...noRealClis(home),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.exitCode === null && child.kill('SIGKILL'));
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out.stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (out.stderr += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const lines = (): LogLine[] => out.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const base = `http://127.0.0.1:${port}`;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    (await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;
  await until(() => out.stdout.includes('is running'));
  return { child, out, lines, exited, home, base, api };
}

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the server logs unhandled rejections and keeps serving, and exits non-zero on an uncaught exception', async (t) => {
  const s = await spawnServer(t, {}, join(here, 'fixtures/fault-on-signal.ts'));
  const health = async () => (await fetch(`${s.base}/api/health`)).status;
  assert.equal(await health(), 200);

  s.child.kill('SIGUSR2');
  await until(() => s.out.stdout.includes('test unhandled rejection'));
  const rejection = s.lines().find((l) => l.msg === 'unhandled promise rejection');
  assert.equal(rejection?.level, 'error');
  assert.match(String(rejection?.stack), /^Error: test unhandled rejection\n\s+at /);
  assert.equal(await health(), 200);

  s.child.kill('SIGUSR2');
  assert.equal(await s.exited, 1);
  const fatal = s.lines().find((l) => l.msg.startsWith('fatal uncaughtException'));
  assert.equal(fatal?.level, 'error');
  assert.match(String(fatal?.stack), /^Error: test uncaught exception\n\s+at /);
  assert.equal(s.out.stderr, '');
});

test('everything the server prints is a JSON log line: turns, runs, webhooks and resets, with no message text, payload or key; SIGHUP drains', async (t) => {
  // The scheduler ticks fast so a scheduled run fires.
  const s = await spawnServer(t, { BOTONS_AUTH: 'off', BOTONS_SCHEDULER_MS: '100ms', BOTONS_LOG_LEVEL: 'debug' });
  const { api } = s;
  const replies = (botId: string, n: number) =>
    until(async () => (await api<Message[]>('GET', `/api/bots/${botId}/messages`)).filter((m) => m.role === 'bot' || m.role === 'error').length >= n);
  const bot = await api<Bot>('POST', '/api/bots', { name: 'Logan', provider: 'mock' });
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'private words: tangerine-umbrella' });
  await replies(bot.id, 1);
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'FAIL_PLEASE' });
  await replies(bot.id, 2);

  const routine = await api<Routine>('POST', `/api/bots/${bot.id}/routines`, { name: 'Hook', instruction: 'Look at it', webhook: true });
  const key = routine.webhook!.key;
  const hook = await fetch(`${s.base}/hooks/routines/${routine.id}?key=${key}`, { method: 'POST', body: 'payload words: walrus-carousel' });
  assert.equal(hook.status, 202);
  assert.equal((await fetch(`${s.base}/hooks/routines/${routine.id}?key=wrong`, { method: 'POST' })).status, 401);
  await replies(bot.id, 3);
  // A scheduled routine that is due now (schedules are at least a minute apart).
  const tick = await api<Routine>('POST', `/api/bots/${bot.id}/routines`, { name: 'Tick', instruction: 'Tock', schedule: 'every 1h' });
  const db = new DatabaseSync(join(s.home, 'botons.db'));
  try {
    db.exec('pragma busy_timeout = 5000');
    db.prepare('update routines set next_run_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), tick.id);
  } finally {
    db.close();
  }
  await until(() => s.lines().some((l) => l.msg === 'run queued' && l.trigger === 'schedule'));
  await replies(bot.id, 4);
  await api('POST', `/api/bots/${bot.id}/reset`);
  assert.equal((await fetch(`${s.base}/api/health`)).status, 200);

  // The terminal running `npm start` closed: drain and exit like SIGTERM.
  s.child.kill('SIGHUP');
  assert.equal(await s.exited, 0);
  assert.equal(s.out.stderr, '');
  // Every line parses, and has a timestamp, a level and a message.
  const lines = s.lines();
  for (const l of lines) {
    assert.ok(!Number.isNaN(Date.parse(l.ts)), JSON.stringify(l));
    assert.ok(['debug', 'info', 'warn', 'error'].includes(l.level), JSON.stringify(l));
    assert.equal(typeof l.msg, 'string');
  }

  // Each turn: a start line and an end line with the Boton, duration and outcome.
  const mine = lines.filter((l) => l.botId === bot.id);
  const ends = mine.filter((l) => l.msg === 'turn ended');
  assert.equal(mine.filter((l) => l.msg === 'turn started').length, 4);
  assert.equal(ends.length, 4);
  for (const e of ends) assert.equal(typeof e.durationMs, 'number');
  assert.deepEqual(ends.map((e) => [e.trigger, e.outcome, e.provider]), [
    ['chat', 'ok', 'mock'],
    ['chat', 'error', 'mock'],
    ['webhook', 'ok', 'mock'],
    ['schedule', 'ok', 'mock'],
  ]);
  assert.deepEqual([ends[1].level, ends[1].error, ends[2].routineId, typeof ends[2].runId], ['error', 'Mock failure requested', routine.id, 'string']);
  // Runs as they are queued, the webhook call itself, and the reset.
  assert.ok(lines.some((l) => l.msg === 'run queued' && l.trigger === 'webhook' && l.routineId === routine.id && l.runId === ends[2].runId));
  const hooks = lines.filter((l) => l.msg === 'webhook');
  assert.deepEqual(hooks.map((h) => [h.routineId, h.status, h.remote, h.level]), [
    [routine.id, 202, '127.0.0.1', 'info'],
    [routine.id, 401, '127.0.0.1', 'warn'],
  ]);
  assert.ok(lines.some((l) => l.msg.startsWith('conversation reset') && l.botId === bot.id));
  assert.ok(lines.some((l) => l.msg.startsWith('shutdown: SIGHUP')));
  assert.ok(lines.some((l) => l.msg === 'shutdown: done'));
  // Never the chat text, the payload or the webhook key.
  assert.doesNotMatch(s.out.stdout, /tangerine-umbrella|walrus-carousel/);
  assert.ok(!s.out.stdout.includes(key), 'the webhook key was logged');
});

test('a server killed without draining: the next start stops the agent CLI it left running before it answers the message again', async (t) => {
  const home = tempDir('botons-proc-test-');
  const claude = fakeCli(home, 'claude');
  // The first attempt hangs (still "at work" when the server dies); the re-run answers.
  claude.script({ fixture: 'claude/reply', hang: true }, 'claude/reply');
  const env = { BOTONS_AUTH: 'off', BOTONS_CLAUDE_BIN: claude.bin };
  const agents = join(home, 'run', 'agents');
  let orphan = 0;
  t.after(() => orphan && groupAlive(orphan) && process.kill(-orphan, 'SIGKILL'));

  const first = await spawnServer(t, env, undefined, home);
  const bot = await first.api<Bot>('POST', '/api/bots', { name: 'Worker', provider: 'claude-cli', access: 'host' });
  await first.api('POST', `/api/bots/${bot.id}/messages`, { text: 'do the thing' });
  await until(() => existsSync(agents) && readdirSync(agents).length === 1);
  orphan = Number(readdirSync(agents)[0].replace(/\.json$/, ''));
  assert.ok(groupAlive(orphan));

  first.child.kill('SIGKILL');
  await first.exited;
  assert.ok(groupAlive(orphan), 'the agent CLI outlived the server');
  await sleep(500);
  assert.ok(groupAlive(orphan), 'and keeps working');

  const second = await spawnServer(t, env, undefined, home);
  assert.equal(groupAlive(orphan), false, 'stopped by the next start');
  const reaped = second.lines().findIndex((l) => l.msg.startsWith('stopping an agent CLI that a previous server process left running') && l.pid === orphan);
  assert.ok(reaped >= 0, `${orphan}\n${second.out.stdout}`);
  await until(async () => (await second.api<Message[]>('GET', `/api/bots/${bot.id}/messages`)).some((m) => m.role === 'bot'));
  const started = second.lines().findIndex((l) => l.msg === 'turn started' && l.botId === bot.id);
  assert.ok(started > reaped, 'the message ran again only after the old attempt was stopped');
  assert.deepEqual(readdirSync(agents), [], 'the re-run is done, so nothing is recorded');
  second.child.kill('SIGTERM');
  assert.equal(await second.exited, 0);
});

test("an agent process's first ending is why it ended: a timeout then a stop is timed out, a stop then a timeout is stopped", { timeout: 20_000 }, async () => {
  // Slow to exit, as a busy CLI can be: SIGTERM is ignored, so it ends at the SIGKILL 3 s later, after the other reason came.
  const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const run = async (timeoutMs: number, stopAfterMs: number) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), stopAfterMs);
    try {
      const r = await runJsonl(process.execPath, ['-e', stubborn], { cwd: tempDir('botons-runjsonl-'), env: { PATH: process.env.PATH ?? '' }, stdin: '', signal: stop.signal, timeoutMs, onEvent: () => {} });
      return { aborted: r.aborted, timedOut: r.timedOut };
    } finally {
      clearTimeout(timer);
    }
  };
  const [timedOut, stopped] = await Promise.all([run(200, 600), run(1200, 200)]);
  assert.deepEqual(timedOut, { aborted: false, timedOut: true });
  assert.deepEqual(stopped, { aborted: true, timedOut: false });
});
