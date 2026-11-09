import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { Message, Routine, RoutineRun, RunCallback, RunsAttention, ServerInfo, WebhookRunStatus } from '../../shared/types.ts';
import { ProviderError } from '../src/providers/types.ts';
import { botonCli, sleep, startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

// A fake ntfy server and a callback receiver on loopback: nothing reaches the network.
const got: { pushes: { message: string; priority: number }[]; callbacks: RunCallback[] } = { pushes: [], callbacks: [] };
const receiver = createServer((req, res) => {
  let data = '';
  req.setEncoding('utf8').on('data', (d: string) => (data += d));
  req.on('end', () => {
    if (req.url === '/callback') got.callbacks.push(JSON.parse(data));
    else got.pushes.push(JSON.parse(data));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"abc","event":"message"}');
  });
});
await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => receiver.close(r)));
const at = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

const home = tempDir('botons-time-limit-');
const LIMIT = 20 * 60_000;
const s = await startServer({ home, env: { BOTONS_SCHEDULER_MS: '1h' }, configure: (cfg) => (cfg.callbacks.allow = ['127.0.0.1']) });
const { app, call } = s;
await call('PATCH', '/api/settings', { ownerName: 'Sam', ntfy: { enabled: true, server: at, topic: 'botons-test', preview: true } });
afterEach(() => {
  s.mock.script = null;
});

const runOf = async (routineId: string, runId: string) => (await s.runsOf(routineId)).find((r) => r.id === runId)!;
const runEnded = (routineId: string, runId: string) => until(async () => {
  const r = await runOf(routineId, runId);
  return r && (r.status === 'succeeded' || r.status === 'failed') ? r : null;
});
const runNow = async (routineId: string) => (await call<RoutineRun>('POST', `/api/routines/${routineId}/run`)).data;
const outcomes = (runId: string) => app.store.db.prepare('select outcome from turns where run_id = ? order by rowid').all(runId).map((r) => r.outcome);

test("a routine's time limit is optional, in ms, from 1 second up to the server's limit, and goes back to the server's with null", async () => {
  const info = (await call<ServerInfo>('GET', '/api/info')).data;
  assert.equal(info.turnTimeoutMs, LIMIT);
  const bot = await s.newBot('Kevin');
  const plain = await s.newRoutine(bot.id);
  assert.equal(plain.timeLimitMs, null);
  const timed = await s.newRoutine(bot.id, { timeLimitMs: 5 * 60_000 });
  assert.equal(timed.timeLimitMs, 5 * 60_000);
  for (const bad of [0, 999, LIMIT + 1, 1.5, '5m', true]) {
    const res = await call('POST', `/api/bots/${bot.id}/routines`, { name: 'Bad', instruction: 'x', timeLimitMs: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)}: ${res.text}`);
    assert.match(res.data.error, /timeLimitMs must be/);
  }
  assert.match((await call('POST', `/api/bots/${bot.id}/routines`, { name: 'Bad', instruction: 'x', timeLimitMs: LIMIT + 1 })).data.error, /between 1 second and 20 minutes \(the server's limit/);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${plain.id}`, { timeLimitMs: LIMIT })).data.timeLimitMs, LIMIT);
  assert.equal((await call('PATCH', `/api/routines/${plain.id}`, { timeLimitMs: -1 })).status, 400);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${plain.id}`, { name: 'Renamed' })).data.timeLimitMs, LIMIT, 'kept by other edits');
  assert.equal((await call<Routine>('PATCH', `/api/routines/${plain.id}`, { timeLimitMs: null })).data.timeLimitMs, null);
});

test("a run past its routine's time limit is stopped and fails as timed out: on record, in the chat, pushed, listed to check, sent to its callback, and never retried", async () => {
  got.pushes.length = 0;
  got.callbacks.length = 0;
  const bot = await s.newBot('Stuart');
  const routine = await s.newRoutine(bot.id, { name: 'Digest', instruction: 'SLOW_PLEASE:30000', webhook: true, callbackUrl: `${at}/callback`, timeLimitMs: 1000 });
  const started = Date.now();
  const { runId } = (await (await s.hook(routine, '', { method: 'POST', body: '{"n":1}', headers: { 'content-type': 'application/json' } })).json()) as { runId: string };
  const run = await runEnded(routine.id, runId);
  const took = Date.now() - started;
  assert.ok(took >= 1000 && took < 10_000, `${took} ms`);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Ran past its time limit (1 second) and was stopped');
  assert.equal(run.meta?.timedOut?.limitMs, 1000);
  assert.equal(run.meta?.cancelled, undefined);
  assert.equal(run.attempts, 1);
  assert.equal(run.retryAt, null);
  assert.deepEqual(outcomes(runId), ['timeout']);
  await s.untilState(bot.id, 'idle');

  const error = (await s.messagesOf(bot.id)).find((m) => m.role === 'error' && m.meta?.runId === runId)!;
  assert.equal(
    error.text,
    "Routine “Digest” failed: Ran past its time limit (1 second) and was stopped. It may have partly run, so it isn't tried again by itself. If it needs longer, raise its time limit (up to 20 minutes).",
  );
  await until(() => got.pushes.length === 1);
  assert.match(got.pushes[0].message, /“Digest” failed: Ran past its time limit \(1 second\)/);
  assert.equal(got.pushes[0].priority, 4);
  await until(() => got.callbacks.length === 1);
  assert.deepEqual([got.callbacks[0].runId, got.callbacks[0].status, got.callbacks[0].timedOut, got.callbacks[0].cancelled], [runId, 'failed', true, false]);
  const status = (await (await fetch(`${s.base}/hooks/routines/${routine.id}/runs/${runId}`, { headers: { authorization: `Bearer ${routine.webhook!.key}` } })).json()) as WebhookRunStatus;
  assert.deepEqual([status.status, status.timedOut, status.cancelled], ['failed', true, false]);
  const attention = (await call<RunsAttention>('GET', '/api/runs/attention')).data;
  assert.ok(attention.failed.some((r) => r.id === runId), 'the owner is asked to check it: it may have partly run');
  assert.ok(!attention.held.some((r) => r.id === runId));
  // Nothing tries it again by itself.
  await sleep(300);
  assert.equal((await s.runsOf(routine.id)).length, 1);
});

test("a routine without its own limit has the server's; time queued behind other work doesn't count against a limit", async () => {
  const bot = await s.newBot('Bob');
  const quick = await s.newRoutine(bot.id, { name: 'Quick', instruction: 'SLOW_PLEASE:600', timeLimitMs: 1000 });
  const plain = await s.newRoutine(bot.id, { name: 'Plain', instruction: 'SLOW_PLEASE:100' });
  // A chat turn longer than the routine's limit goes first.
  assert.equal((await s.send(bot.id, 'SLOW_PLEASE:1500')).status, 202);
  await s.untilState(bot.id, 'working');
  const a = await runNow(quick.id);
  const b = await runNow(plain.id);
  assert.equal((await runEnded(quick.id, a.id)).status, 'succeeded');
  assert.equal((await runEnded(plain.id, b.id)).status, 'succeeded');
  const asked = s.turnsOf(bot.id).map((t) => t.timeoutMs);
  assert.equal(asked.length, 3);
  assert.ok(asked[0] <= LIMIT && asked[0] > LIMIT - 1000, `a chat turn has the server limit: ${asked[0]}`);
  assert.ok(asked[1] <= 1000 && asked[1] > 900, `the routine's own, from its start: ${asked[1]}`);
  assert.ok(asked[2] <= LIMIT && asked[2] > LIMIT - 1000, `the server's: ${asked[2]}`);
});

test("a run that ends within its limit leaves no timer behind: the next run on the Boton isn't cut short by it", async () => {
  const bot = await s.newBot('Dave');
  const short = await s.newRoutine(bot.id, { name: 'Short', instruction: 'SLOW_PLEASE:100', timeLimitMs: 1000 });
  const long = await s.newRoutine(bot.id, { name: 'Long', instruction: 'SLOW_PLEASE:1600' });
  const a = await runNow(short.id);
  const b = await runNow(long.id);
  assert.equal((await runEnded(short.id, a.id)).status, 'succeeded');
  const ended = await runEnded(long.id, b.id);
  assert.equal(ended.status, 'succeeded', ended.error ?? '');
  assert.deepEqual(outcomes(b.id), ['ok']);
});

test("a retry in a new session (the first attempt found its session gone) gets what is left of the run's limit, not a limit of its own", async () => {
  const bot = await s.newBot('Kevin Session');
  await s.chat(bot.id, 'hello');
  const routine = await s.newRoutine(bot.id, { name: 'Resume', instruction: 'Quick one', timeLimitMs: 5000 });
  let first = true;
  s.mock.script = async () => {
    if (!first) return 'done';
    first = false;
    await sleep(400);
    throw new ProviderError('No conversation found', true);
  };
  const run = await runNow(routine.id);
  assert.equal((await runEnded(routine.id, run.id)).status, 'succeeded');
  const [a, b] = s.turnsOf(bot.id).slice(-2).map((t) => t.timeoutMs);
  assert.ok(a <= 5000 && a > 4500, String(a));
  assert.ok(b <= a - 300, `${b} after ${a}`);
});

test('a session found gone only once the limit has passed starts no new agent process: the run times out', async () => {
  const bot = await s.newBot('Kevin Gone');
  await s.chat(bot.id, 'hello');
  const routine = await s.newRoutine(bot.id, { name: 'Gone', instruction: 'Quick one', timeLimitMs: 1000 });
  const before = s.turnsOf(bot.id).length;
  s.mock.script = async () => {
    await sleep(1100);
    throw new ProviderError('No conversation found', true);
  };
  const run = await runNow(routine.id);
  const ended = await runEnded(routine.id, run.id);
  assert.deepEqual([ended.status, ended.error, ended.meta?.timedOut?.limitMs], ['failed', 'Ran past its time limit (1 second) and was stopped', 1000]);
  assert.deepEqual(outcomes(run.id), ['timeout']);
  assert.equal(s.turnsOf(bot.id).length - before, 1, 'only the attempt that found its session gone');
});

test('a stop that comes while a timed-out turn is still exiting leaves it timed out; one that comes first leaves it cancelled', async () => {
  const bot = await s.newBot('Stuart Race');
  const routine = await s.newRoutine(bot.id, { name: 'Race', instruction: 'Slow', timeLimitMs: 1000 });
  // Times out first, then takes a while to exit, as an agent process killed at its limit can: the owner cancels meanwhile.
  let runId = '';
  let cancelled: Promise<{ status: number; data: RoutineRun }> | null = null;
  s.mock.script = async (req) => {
    await sleep(req.timeoutMs);
    cancelled = call<RoutineRun>('POST', `/api/runs/${runId}/cancel`);
    await until(() => req.signal.aborted);
    const err = new ProviderError('Mock timed out.', false);
    err.exit = { exitCode: null, signal: 'SIGTERM', timedOut: true, stderrTail: '' };
    throw err;
  };
  runId = (await runNow(routine.id)).id;
  const timedOut = await runEnded(routine.id, runId);
  // The cancel answers with the run as it ended: it finished (timed out) before the stop reached it.
  const answer = await until(() => cancelled);
  assert.deepEqual([answer.status, answer.data.error, !!answer.data.meta?.timedOut], [200, 'Ran past its time limit (1 second) and was stopped', true]);
  assert.deepEqual([timedOut.error, !!timedOut.meta?.timedOut, timedOut.meta?.cancelled], ['Ran past its time limit (1 second) and was stopped', true, undefined]);
  assert.deepEqual(outcomes(runId), ['timeout']);
  await s.untilState(bot.id, 'idle');

  // Cancelled before its limit: cancelled, not timed out.
  s.mock.script = null;
  const slow = await s.newRoutine(bot.id, { name: 'Slow', instruction: 'SLOW_PLEASE:30000', timeLimitMs: 3000 });
  const run = await runNow(slow.id);
  await until(async () => (await runOf(slow.id, run.id)).status === 'running');
  const res = await call<RoutineRun>('POST', `/api/runs/${run.id}/cancel`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.data.error, res.data.meta?.timedOut, !!res.data.meta?.cancelled], ['Cancelled', undefined, true]);
  assert.deepEqual(outcomes(run.id), ['stopped']);
});

test('a chat turn past the server limit says so, and the next message gets its turn', async () => {
  const t = await startServer({ env: { BOTONS_TURN_TIMEOUT_MS: '1s' } });
  try {
    const bot = await t.newBot('Bob Chat');
    const reply = await t.chat(bot.id, 'SLOW_PLEASE:30000');
    assert.equal(reply.role, 'error');
    assert.equal(reply.text, 'Stopped: the turn ran past its time limit (1 second). It may have partly run.');
    const next: Message = await t.chat(bot.id, 'Are you there?');
    assert.equal(next.role, 'bot');
    assert.match(next.text, /Are you there\?/);
  } finally {
    await t.stop();
  }
});

test('a timed-out run reads as timed out after a restart, and a limit set above a lowered server limit runs at the server limit', async () => {
  const own = tempDir('botons-time-limit-restart-');
  let t = await startServer({ home: own, env: { BOTONS_SCHEDULER_MS: '1h' } });
  const bot = await t.newBot('Dave Restart');
  const routine = await t.newRoutine(bot.id, { name: 'Long', instruction: 'SLOW_PLEASE:30000', webhook: true, timeLimitMs: 1000 });
  const capped = await t.newRoutine(bot.id, { name: 'Capped', instruction: 'SLOW_PLEASE:30000', timeLimitMs: 10 * 60_000 });
  const run = (await t.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
  await until(async () => (await t.runsOf(routine.id)).find((r) => r.id === run.id && r.status === 'failed'));
  await t.untilState(bot.id, 'idle');
  const token = t.token;
  await t.stop();

  t = await startServer({ home: own, token, env: { BOTONS_SCHEDULER_MS: '1h', BOTONS_TURN_TIMEOUT_MS: '1500ms' } });
  try {
    const again = (await t.runsOf(routine.id)).find((r) => r.id === run.id)!;
    assert.deepEqual([again.status, again.error, again.meta?.timedOut?.limitMs], ['failed', 'Ran past its time limit (1 second) and was stopped', 1000]);
    assert.ok((await t.call<RunsAttention>('GET', '/api/runs/attention')).data.failed.some((r) => r.id === run.id));
    // Kept as set, but no turn runs longer than the server lets it.
    assert.equal((await t.call<Routine[]>('GET', `/api/bots/${bot.id}/routines`)).data.find((r) => r.id === capped.id)!.timeLimitMs, 10 * 60_000);
    const c = (await t.call<RoutineRun>('POST', `/api/routines/${capped.id}/run`)).data;
    const ended = await until(async () => (await t.runsOf(capped.id)).find((r) => r.id === c.id && r.status === 'failed'));
    assert.equal(ended.meta?.timedOut?.limitMs, 1500);
    const said = (await t.messagesOf(bot.id)).find((m) => m.role === 'error' && m.meta?.runId === c.id)!;
    assert.match(said.text, /1\.5 seconds is the longest this server lets a turn run \(BOTONS_TURN_TIMEOUT_MS\)\.$/);
  } finally {
    await t.stop();
  }
});

test('the agent process of a run past its limit is killed, and the next run on the Boton starts its own', async () => {
  const t = await startServer({ fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h' } });
  try {
    const bot = t.storeBot('Kevin Cli', 'claude-cli');
    const routine = await t.newRoutine(bot.id, { name: 'Hangs', instruction: 'Do it', timeLimitMs: 1000 });
    t.claude.script({ fixture: 'claude/reply', lines: 1, hang: true }, 'claude/reply');
    const run = (await t.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
    const ended = await until(async () => (await t.runsOf(routine.id)).find((r) => r.id === run.id && r.status === 'failed'));
    assert.equal(ended.meta?.timedOut?.limitMs, 1000);
    const next = (await t.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
    const done = await until(async () => (await t.runsOf(routine.id)).find((r) => r.id === next.id && r.status !== 'queued' && r.status !== 'running'));
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.equal(t.claude.calls().length, 2);
  } finally {
    await t.stop();
  }
});

test('a CLI that writes a successful result once killed at the limit still times the run out, on record and at its callback, and the next run is its own', async () => {
  const t = await startServer({ fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h' }, configure: (cfg) => (cfg.callbacks.allow = ['127.0.0.1']) });
  try {
    useTestCodexHome(t.home);
    for (const [provider, cli, fixture] of [['claude-cli', t.claude, 'claude/reply'], ['codex-cli', t.codex, 'codex/reply']] as const) {
      got.callbacks.length = 0;
      const bot = t.storeBot(`Kevin Late ${provider}`, provider);
      const routine = await t.newRoutine(bot.id, { name: 'Late', instruction: 'Do it', webhook: true, ...(process.platform !== 'linux' && { webhookWorkspace: false }), callbackUrl: `${at}/callback`, timeLimitMs: 1000 });
      // It answers SIGTERM with the rest of its output, a successful result included, and exits 0.
      cli.script({ fixture, hang: true, lines: 2, lateResult: true }, fixture);
      const { runId } = (await (await t.hook(routine, '', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()) as { runId: string };
      const ended = await until(async () => (await t.runsOf(routine.id)).find((r) => r.id === runId && (r.status === 'failed' || r.status === 'succeeded')));
      assert.deepEqual([ended.status, ended.error, ended.meta?.timedOut?.limitMs, ended.reply], ['failed', 'Ran past its time limit (1 second) and was stopped', 1000, null], provider);
      assert.deepEqual(t.app.store.db.prepare('select outcome from turns where run_id = ?').all(runId).map((r) => r.outcome), ['timeout'], provider);
      await t.untilState(bot.id, 'idle');
      const said = (await t.messagesOf(bot.id)).filter((m) => m.meta?.runId === runId && (m.role === 'bot' || m.role === 'error'));
      assert.deepEqual(said.map((m) => m.role), ['error'], provider);
      assert.match(said[0].text, /^Routine “Late” failed: Ran past its time limit \(1 second\)/);
      await until(() => got.callbacks.length === 1);
      assert.deepEqual([got.callbacks[0].runId, got.callbacks[0].status, got.callbacks[0].timedOut], [runId, 'failed', true], provider);
      assert.ok((await t.call<RunsAttention>('GET', '/api/runs/attention')).data.failed.some((r) => r.id === runId), provider);
      assert.equal((await t.runsOf(routine.id)).length, 1, 'not tried again by itself');
      // The next run gets an agent process of its own, with the whole limit, and succeeds.
      const next = (await t.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
      const done = await until(async () => (await t.runsOf(routine.id)).find((r) => r.id === next.id && r.status !== 'queued' && r.status !== 'running'));
      assert.deepEqual([done.status, done.reply], ['succeeded', 'pong'], `${provider}: ${done.error ?? ''}`);
      assert.equal(cli.calls().length, 2, provider);
    }
  } finally {
    await t.stop();
  }
});

test("a routine's time limit goes with it into a duplicate and a template, and a template's is no longer than this server's limit", async () => {
  const bot = await s.newBot('Bob Copies');
  await s.newRoutine(bot.id, { name: 'Timed', timeLimitMs: 7 * 60_000 });
  await s.newRoutine(bot.id, { name: 'Untimed' });
  const limits = async (botId: string) => (await call<Routine[]>('GET', `/api/bots/${botId}/routines`)).data.map((r) => [r.name, r.timeLimitMs]);
  const copy = (await call<{ id: string }>('POST', `/api/bots/${bot.id}/duplicate`, {})).data;
  assert.deepEqual(await limits(copy.id), [['Timed', 7 * 60_000], ['Untimed', null]]);

  const tpl = (await call<{ id: string; routines: { name: string; timeLimitMs: number | null }[] }>('POST', '/api/templates', { fromBotId: bot.id })).data;
  assert.deepEqual(tpl.routines.map((r) => [r.name, r.timeLimitMs]), [['Timed', 7 * 60_000], ['Untimed', null]]);
  const made = (await call<{ id: string }>('POST', '/api/bots', { name: 'Bob Templated', provider: 'mock', templateId: tpl.id })).data;
  assert.deepEqual(await limits(made.id), [['Timed', 7 * 60_000], ['Untimed', null]]);

  // Saved on a server that lets turns run longer.
  const file = join(home, 'templates', `${tpl.id}.json`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.routines[0].timeLimitMs = 3 * 3_600_000;
  writeFileSync(file, JSON.stringify(saved));
  const capped = (await call<{ id: string }>('POST', '/api/bots', { name: 'Bob Capped', provider: 'mock', templateId: tpl.id })).data;
  assert.deepEqual(await limits(capped.id), [['Timed', LIMIT], ['Untimed', null]]);
});

test('a Boton sets, shows and clears a routine time limit with `botons routine`', async () => {
  const bot = await s.newBot('Kevin Cli Limit');
  const cli = (...args: string[]) => botonCli(app, s.base, bot.id, ...args);
  const made = await cli('routine', 'create', '--name', 'Scan', '--instruction', 'Scan it', '--time-limit', '10m', '--json');
  assert.equal(made.code, 0, made.stderr);
  const r = JSON.parse(made.stdout) as Routine;
  assert.equal(r.timeLimitMs, 10 * 60_000);
  assert.match((await cli('routine', 'list')).stdout, /Scan {2}\(no schedule, active, time limit 10 minutes\)/);
  assert.equal(JSON.parse((await cli('routine', 'update', r.id, '--time-limit', '90s', '--json')).stdout).timeLimitMs, 90_000);
  assert.equal(JSON.parse((await cli('routine', 'update', r.id, '--no-time-limit', '--json')).stdout).timeLimitMs, null);
  const bad = await cli('routine', 'update', r.id, '--time-limit', 'soon');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--time-limit must be a duration such as 10m/);
  const tooLong = await cli('routine', 'update', r.id, '--time-limit', '2h');
  assert.match(tooLong.stderr, /between 1 second and 20 minutes/);
});
