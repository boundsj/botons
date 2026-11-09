import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditEvent, RoutineRun, RunsAttention, WebhookRunStatus } from '../../shared/types.ts';
import { ProviderError } from '../src/providers/types.ts';
import { startServer, type TestServer, tempDir, until } from './helpers.ts';

const home = tempDir('botons-cancel-');
const s = await startServer({ home, env: { BOTONS_SCHEDULER_MS: '1h' } });
const { app, call } = s;

const runOf = async (routineId: string, runId: string) => (await s.runsOf(routineId)).find((r) => r.id === runId)!;
const runWith = (routineId: string, runId: string, status: RoutineRun['status']) => until(async () => ((await runOf(routineId, runId))?.status === status ? runOf(routineId, runId) : null));
const runNow = async (routineId: string) => (await call<RoutineRun>('POST', `/api/routines/${routineId}/run`)).data;
const attention = async () => (await call<RunsAttention>('GET', '/api/runs/attention')).data;

test('cancelling a running run stops only its turn: the chat and the next run carry on, nothing retries or pushes', async () => {
  const bot = await s.newBot('Kevin');
  const slow = await s.newRoutine(bot.id, { name: 'Slow', instruction: 'SLOW_PLEASE:30000' });
  const next = await s.newRoutine(bot.id, { name: 'Next', instruction: 'Quick one' });
  const run = await runNow(slow.id);
  await runWith(slow.id, run.id, 'running');
  const after = await runNow(next.id);
  assert.equal((await s.send(bot.id, 'Are you there?')).status, 202);

  const res = await call<RoutineRun>('POST', `/api/runs/${run.id}/cancel`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.status, 'failed');
  assert.equal(res.data.error, 'Cancelled');
  assert.equal(res.data.meta?.cancelled?.started, true);
  assert.ok(res.data.finishedAt);

  // Only that run: the run queued behind it and the waiting chat message both get their turn.
  assert.equal((await runWith(next.id, after.id, 'succeeded')).status, 'succeeded');
  await until(async () => (await s.messagesOf(bot.id)).some((m) => m.role === 'bot' && m.text.includes('Are you there?')));
  await s.untilState(bot.id, 'idle');

  const ended = await runOf(slow.id, run.id);
  assert.equal(ended.status, 'failed');
  assert.equal(ended.attempts, 1);
  assert.equal(ended.retryAt, null, 'never retried by itself');
  assert.equal(ended.meta?.notifications, undefined, 'no push about a failure the owner caused');
  const turn = app.store.db.prepare('select outcome from turns where run_id = ?').get(run.id) as { outcome: string };
  assert.equal(turn.outcome, 'stopped');
  const chips = (await s.messagesOf(bot.id)).filter((m) => m.meta?.runId === run.id);
  assert.ok(chips.some((m) => m.role === 'event' && m.text === 'Cancelled' && m.meta?.kind === 'turn.stopped'));
  assert.ok(!chips.some((m) => m.role === 'error'), 'no error in the chat');
  assert.ok(!(await attention()).failed.some((r) => r.id === run.id), 'not listed to check');

  const audit = (await call<AuditEvent[]>('GET', '/api/audit')).data.find((e) => e.action === 'run.cancelled' && e.details.runId === run.id);
  assert.ok(audit, 'in the audit log');
  assert.equal(audit.details.was, 'running');
  assert.equal(audit.target?.label, 'Slow');

  // The owner may still run it again by hand.
  const retried = await call<RoutineRun>('POST', `/api/runs/${run.id}/retry`);
  assert.equal(retried.status, 202, retried.text);
  await call('POST', `/api/runs/${retried.data.id}/cancel`);
});

test('cancelling a queued run means it never starts; the run ahead of it keeps running', async () => {
  const bot = await s.newBot('Stuart');
  const slow = await s.newRoutine(bot.id, { name: 'Ahead', instruction: 'SLOW_PLEASE:30000' });
  const waiting = await s.newRoutine(bot.id, { name: 'Behind', instruction: 'NEVER_RUN_ME' });
  const first = await runNow(slow.id);
  await runWith(slow.id, first.id, 'running');
  const second = await runNow(waiting.id);

  const res = await call<RoutineRun>('POST', `/api/runs/${second.id}/cancel`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.data.status, res.data.error, res.data.meta?.cancelled?.started], ['failed', 'Cancelled', false]);
  assert.equal((await runOf(slow.id, first.id)).status, 'running', 'the run ahead is untouched');

  await call('POST', `/api/runs/${first.id}/cancel`);
  await s.untilState(bot.id, 'idle');
  assert.ok(!s.turnsOf(bot.id).some((t) => t.prompt.includes('NEVER_RUN_ME')), 'the cancelled run never reached the agent');
  assert.equal((await runOf(waiting.id, second.id)).attempts, 0);
});

test('a queued run waiting for a free agent slot is cancelled without waiting for the slot', async () => {
  const bot = await s.newBot('Bob');
  const other = await s.newBot('Dave');
  const busy = await s.newRoutine(other.id, { name: 'Busy', instruction: 'SLOW_PLEASE:30000' });
  const waiting = await s.newRoutine(bot.id, { name: 'Waiting', instruction: 'NEVER_RUN_ME_EITHER' });
  const slots = s.cfg.maxConcurrentTurns;
  const fillers = [busy];
  for (let i = 1; i < slots; i++) fillers.push(await s.newRoutine((await s.newBot(`Filler ${i}`)).id, { name: 'Busy', instruction: 'SLOW_PLEASE:30000' }));
  const running = [];
  for (const r of fillers) running.push({ r, run: await runNow(r.id) });
  for (const { r, run } of running) await runWith(r.id, run.id, 'running');
  const queued = await runNow(waiting.id);
  await s.untilState(bot.id, 'queued');

  const res = await call<RoutineRun>('POST', `/api/runs/${queued.id}/cancel`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.meta?.cancelled?.started, false);
  await s.untilState(bot.id, 'idle');
  for (const { run } of running) await call('POST', `/api/runs/${run.id}/cancel`);
  assert.ok(!s.turnsOf(bot.id).some((t) => t.prompt.includes('NEVER_RUN_ME_EITHER')));
});

test('a run held to try again later can be cancelled, and is no longer waiting', async () => {
  const bot = await s.newBot('Kevin Held');
  const routine = await s.newRoutine(bot.id, { name: 'Held' });
  const run = app.store.createRun(app.store.getRoutine(routine.id), 'schedule', null);
  app.store.holdRun(run.id, new Date(Date.now() + 3_600_000), 'API Error: Connection error.', 'retry');
  assert.ok((await attention()).held.some((r) => r.id === run.id));

  const res = await call<RoutineRun>('POST', `/api/runs/${run.id}/cancel`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.status, 'failed');
  assert.equal(res.data.lastError, 'API Error: Connection error.');
  const list = await attention();
  assert.ok(!list.held.some((r) => r.id === run.id) && !list.failed.some((r) => r.id === run.id));
});

test('only the owner cancels, and only a run that has not ended', async () => {
  const bot = await s.newBot('Stuart Owner');
  const routine = await s.newRoutine(bot.id, { name: 'Guarded', instruction: 'SLOW_PLEASE:30000' });
  const run = await runNow(routine.id);
  await runWith(routine.id, run.id, 'running');
  const boton = app.auth.mintBotonToken(bot.id);
  try {
    assert.equal((await call('POST', `/api/runs/${run.id}/cancel`, undefined, boton.token)).status, 403);
  } finally {
    boton.revoke();
  }
  assert.equal((await runOf(routine.id, run.id)).status, 'running');
  assert.equal((await call('POST', `/api/runs/${run.id}/cancel`)).status, 200);
  const again = await call<{ error: string }>('POST', `/api/runs/${run.id}/cancel`);
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already ended \(failed\)/);
  assert.equal((await call('POST', '/api/runs/run_nope/cancel')).status, 404);
  await s.untilState(bot.id, 'idle');
});

test('Stop and cancelling the queue mark their runs cancelled too', async () => {
  const bot = await s.newBot('Bob Stop');
  const routine = await s.newRoutine(bot.id, { name: 'Stopped one', instruction: 'SLOW_PLEASE:30000' });
  const run = await runNow(routine.id);
  await runWith(routine.id, run.id, 'running');
  const queued = await runNow(routine.id);
  assert.equal((await call('POST', `/api/bots/${bot.id}/cancel-runs`)).status, 200);
  await call('POST', `/api/bots/${bot.id}/stop`);
  const stopped = await runWith(routine.id, run.id, 'failed');
  assert.deepEqual([stopped.error, stopped.meta?.cancelled?.started], ['Stopped', true]);
  const dropped = await runOf(routine.id, queued.id);
  assert.deepEqual([dropped.error, dropped.meta?.cancelled?.started], ['Cancelled', false]);
  assert.ok(!(await attention()).failed.some((r) => r.id === run.id || r.id === queued.id));
  await s.untilState(bot.id, 'idle');
});

const networkError = () => new ProviderError('API Error: Connection error.', false, { kind: 'transient' });

/** A scheduled run whose first attempt failed on a network error, now held to try again. */
async function heldAfterNetworkError(t: TestServer, botId: string, routineId: string): Promise<RoutineRun> {
  t.mock.failNext(botId, networkError());
  const run = t.app.engine.triggerRoutine(routineId, 'schedule');
  return until(async () => {
    const r = (await t.runsOf(routineId)).find((x) => x.id === run.id);
    return r?.status === 'queued' && r.attempts === 1 && r.retryAt ? r : null;
  });
}

test('cancelling a run held after a network error says its earlier attempt may have partly run, after a restart and in a manual retry too', async () => {
  const ownHome = tempDir('botons-cancel-held-');
  let t = await startServer({ home: ownHome, env: { BOTONS_SCHEDULER_MS: '1h' } });
  try {
    const bot = await t.newBot('Kevin Network');
    const routine = await t.newRoutine(bot.id, { name: 'Report', instruction: 'Send the report' });
    const held = await heldAfterNetworkError(t, bot.id, routine.id);
    assert.equal(t.turnsOf(bot.id).length, 1, 'the first attempt reached the agent');

    const res = await t.call<RoutineRun>('POST', `/api/runs/${held.id}/cancel`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([res.data.status, res.data.error, res.data.attempts, res.data.meta?.cancelled?.started], ['failed', 'Cancelled', 1, true]);
    assert.equal(res.data.lastError, 'API Error: Connection error.');
    assert.equal(t.turnsOf(bot.id).length, 1, 'not tried again');
    await t.stop();

    t = await startServer({ home: ownHome, env: { BOTONS_SCHEDULER_MS: '1h' } });
    const after = (await t.runsOf(routine.id)).find((r) => r.id === held.id)!;
    assert.deepEqual([after.status, after.meta?.cancelled?.started], ['failed', true]);
    assert.ok(!(await t.call<RunsAttention>('GET', '/api/runs/attention')).data.failed.some((r) => r.id === held.id));

    // The owner's retry tells the Boton to check what the earlier attempt already did.
    const retried = await t.call<RoutineRun>('POST', `/api/runs/${held.id}/retry`);
    assert.equal(retried.status, 202, retried.text);
    await until(async () => (await t.runsOf(routine.id)).find((r) => r.id === retried.data.id)?.status === 'succeeded');
    assert.match(t.turnsOf(bot.id).at(-1)!.prompt, /may have partly run, so check what was already done/);
  } finally {
    await t.stop();
  }
});

test("cancelling a Boton's queue keeps a held run's earlier attempt on record", async () => {
  const bot = await s.newBot('Stuart Network');
  const routine = await s.newRoutine(bot.id, { name: 'Sync' });
  const held = await heldAfterNetworkError(s, bot.id, routine.id);
  const fresh = app.store.createRun(app.store.getRoutine(routine.id), 'manual', null);
  assert.equal((await call('POST', `/api/bots/${bot.id}/cancel-runs`)).status, 200);
  const [h, f] = [await runOf(routine.id, held.id), await runOf(routine.id, fresh.id)];
  assert.deepEqual([h.status, h.meta?.cancelled?.started], ['failed', true]);
  assert.deepEqual([f.status, f.meta?.cancelled?.started], ['failed', false]);
  assert.equal(s.turnsOf(bot.id).length, 1);
});

/** Holds every turn's connector setup until released, so an owner's action lands before any agent process starts. */
function holdConnectorSetup(t: TestServer) {
  const connectors = t.app.connectors;
  const real = connectors.resolve;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const waiting = new Promise<void>((r) => (reached = r));
  connectors.resolve = async (...args) => {
    reached();
    await gate;
    return real.apply(connectors, args);
  };
  return {
    waiting,
    release: () => {
      connectors.resolve = real;
      release();
    },
  };
}

const turnOutcome = (t: TestServer, runId: string) => (t.app.store.db.prepare('select outcome from turns where run_id = ?').get(runId) as { outcome: string } | undefined)?.outcome;

for (const how of ['cancel', 'stop', 'pause'] as const) {
  test(`${how} while a run's connectors are being set up: no agent process starts, and the Boton's next work still runs`, async () => {
    const bot = await s.newBot(`Bob Setup ${how}`);
    const routine = await s.newRoutine(bot.id, { name: 'Setup', instruction: 'NEVER_REACH_THE_AGENT' });
    const hold = holdConnectorSetup(s);
    let ended: Promise<RoutineRun> | undefined;
    try {
      const run = await runNow(routine.id);
      await hold.waiting;
      assert.equal((await runOf(routine.id, run.id)).status, 'running');
      if (how === 'cancel') ended = app.engine.cancelRun(run.id);
      else assert.equal((await call('POST', how === 'stop' ? `/api/bots/${bot.id}/stop` : `/api/bots/${bot.id}/pause`)).status, 200);
      hold.release();
      const done = await (ended ?? runWith(routine.id, run.id, 'failed'));
      assert.deepEqual([done.status, done.error, done.meta?.cancelled?.started], ['failed', how === 'cancel' ? 'Cancelled' : 'Stopped', false]);
      await s.untilState(bot.id, 'idle');
      assert.equal(s.turnsOf(bot.id).length, 0, 'the agent never got the prompt');
      assert.equal(turnOutcome(s, run.id), 'stopped');
      assert.ok(!(await attention()).failed.some((r) => r.id === run.id));
    } finally {
      hold.release();
      await ended?.catch(() => {});
    }
    // Only that job was ended: the Boton's next run and chat get their turns.
    if (how === 'pause') await call('POST', `/api/bots/${bot.id}/resume`);
    const next = await runNow((await s.newRoutine(bot.id, { name: 'After', instruction: 'Quick one' })).id);
    assert.equal((await runWith(next.routineId, next.id, 'succeeded')).status, 'succeeded');
    assert.equal((await s.send(bot.id, 'Still there?')).status, 202);
    await until(async () => (await s.messagesOf(bot.id)).some((m) => m.role === 'bot' && m.text.includes('Still there?')));
    await s.untilState(bot.id, 'idle');
  });
}

test('stop while a held run is setting up its retry: no agent process starts, and its earlier attempt stays on record', async () => {
  const t = await startServer({ home: tempDir('botons-cancel-setup-'), env: { BOTONS_SCHEDULER_MS: '1h', BOTONS_RUN_RETRY_DELAY: '200ms' } });
  try {
    const bot = await t.newBot('Dave Setup');
    const routine = await t.newRoutine(bot.id, { name: 'Retry setup' });
    const held = await heldAfterNetworkError(t, bot.id, routine.id);
    const again = holdConnectorSetup(t);
    try {
      await again.waiting;
      assert.equal((await t.runsOf(routine.id)).find((r) => r.id === held.id)!.attempts, 2);
      assert.equal((await t.call('POST', `/api/bots/${bot.id}/stop`)).status, 200);
    } finally {
      again.release();
    }
    const done = await until(async () => {
      const r = (await t.runsOf(routine.id)).find((x) => x.id === held.id);
      return r?.status === 'failed' ? r : null;
    });
    assert.deepEqual([done.error, done.attempts, done.meta?.cancelled?.started], ['Stopped', 2, true]);
    assert.equal(t.turnsOf(bot.id).length, 1, 'only the first attempt reached the agent');
  } finally {
    await t.stop();
  }
});

test('a cancelled run reads as cancelled after a restart, to the owner and to the webhook sender', async () => {
  const bot = await s.newBot('Dave Restart');
  const routine = await s.newRoutine(bot.id, { name: 'Hooked', instruction: 'SLOW_PLEASE:30000', webhook: true });
  const res = await s.hook(routine, '', { method: 'POST', body: '{"n":1}', headers: { 'content-type': 'application/json' } });
  const { runId } = (await res.json()) as { runId: string };
  await runWith(routine.id, runId, 'running');
  await call('POST', `/api/runs/${runId}/cancel`);
  await s.untilState(bot.id, 'idle');
  await s.stop();

  const again = await startServer({ home, env: { BOTONS_SCHEDULER_MS: '1h' } });
  try {
    const run = (await again.runsOf(routine.id)).find((r) => r.id === runId)!;
    assert.deepEqual([run.status, run.error, run.meta?.cancelled?.started], ['failed', 'Cancelled', true]);
    assert.ok(!(await again.call<RunsAttention>('GET', '/api/runs/attention')).data.failed.some((r) => r.id === runId));
    const status = (await (await fetch(`${again.base}/hooks/routines/${routine.id}/runs/${runId}`, { headers: { authorization: `Bearer ${routine.webhook!.key}` } })).json()) as WebhookRunStatus;
    assert.deepEqual([status.status, status.cancelled], ['failed', true]);
  } finally {
    await again.stop();
  }
});

test('Stop after a shutdown interrupt preserves restart recovery instead of recording cancellation', async () => {
  const t = await startServer();
  const bot = await t.newBot('Dave');
  const routine = await t.newRoutine(bot.id, { name: 'Interrupted' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.script = async (req) => {
    await gate;
    throw req.signal.reason;
  };
  const run = (await t.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
  await until(() => t.mock.turns.length === 1);
  const drained = t.app.engine.drain(0);
  try {
    await until(() => t.mock.turns[0].signal.aborted);
    assert.equal((await t.call('POST', `/api/bots/${bot.id}/stop`)).status, 200);
  } finally {
    release();
  }
  await drained;
  const saved = t.app.store.getRun(run.id);
  assert.equal(saved.meta?.cancelled, undefined);
  assert.notEqual(saved.error, 'Stopped');
  assert.notEqual(saved.error, 'Cancelled');
});
