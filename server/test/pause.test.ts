import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, CancelRunsResult, Settings, StopResult } from '../../shared/types.ts';
import { type ServerOptions, sleep, startServer, until } from './helpers.ts';

const start = (opts: ServerOptions = {}) => startServer({ ...opts, env: { BOTONS_SCHEDULER_MS: '100', ...opts.env } });

test('with one slot, Stop on a Boton waiting for it says stopped and its turn never reaches the provider; a Boton token may not stop or pause', async () => {
  const s = await start({ env: { BOTONS_MAX_CONCURRENT: '1' } });
  const busy = await s.newBot('Busy');
  const waiting = await s.newBot('Waiting');
  await s.send(busy.id, 'SLOW_PLEASE:1200');
  await s.untilState(busy.id, 'working');
  await s.send(waiting.id, 'hello?');
  await s.untilState(waiting.id, 'queued');

  const res = await s.call<StopResult>('POST', `/api/bots/${waiting.id}/stop`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { stopped: true, cancelledRuns: 0, queuedRuns: 0 });
  // It gives up its place at once, without waiting for the slot.
  await s.untilState(waiting.id, 'idle', 500);
  const chips = (await s.messagesOf(waiting.id)).filter((m) => m.role !== 'user');
  assert.deepEqual(chips.map((m) => [m.role, m.meta?.kind]), [['event', 'turn.stopped']]);

  await s.untilState(busy.id, 'idle', 4000);
  await sleep(200);
  assert.equal(s.turnsOf(waiting.id).length, 0);
  assert.equal(s.app.store.hasPendingChat(waiting.id), false);
  assert.equal((await s.messagesOf(waiting.id)).filter((m) => m.role === 'bot' || m.role === 'error').length, 0);
  assert.equal((await s.call<StopResult>('POST', `/api/bots/${waiting.id}/stop`)).data.stopped, false);

  const { token, revoke } = s.app.auth.mintBotonToken(busy.id);
  try {
    for (const path of [`/api/bots/${busy.id}/stop`, `/api/bots/${busy.id}/cancel-runs`, `/api/bots/${busy.id}/pause`, `/api/bots/${busy.id}/resume`, '/api/pause', '/api/resume']) {
      assert.equal((await s.call('POST', path, {}, token)).status, 403, path);
    }
  } finally {
    revoke();
  }
  assert.equal((await s.call<Bot>('GET', `/api/bots/${busy.id}`)).data.paused, false);
});

test('Stop ends the running run and the queue carries on; with clearQueue it also cancels the queued runs', async () => {
  const s = await start();
  const bot = await s.newBot('Kevin');
  const slow = await s.newRoutine(bot.id, { instruction: 'SLOW_PLEASE', webhook: true });
  assert.equal((await s.hook(slow)).status, 202);
  const first = await until(async () => (await s.runsOf(slow.id)).find((r) => r.status === 'running'));
  for (let i = 0; i < 3; i++) assert.equal((await s.hook(slow)).status, 202);

  assert.deepEqual((await s.call<StopResult>('POST', `/api/bots/${bot.id}/stop`)).data, { stopped: true, cancelledRuns: 0, queuedRuns: 3 });
  const second = await until(async () => (await s.runsOf(slow.id)).find((r) => r.status === 'running' && r.id !== first.id));
  // A run is running from when its turn is set up: its agent process (the mock's turn) can start a moment later.
  await until(() => s.mock.turns.length >= 2);
  const turns = s.mock.turns.length;
  const res = await s.call<StopResult>('POST', `/api/bots/${bot.id}/stop`, { clearQueue: true });
  assert.deepEqual(res.data, { stopped: true, cancelledRuns: 2, queuedRuns: 0 });
  await s.untilState(bot.id, 'idle');
  const runs = await s.runsOf(slow.id);
  assert.deepEqual(runs.map((r) => [r.status, r.error]).sort(), [['failed', 'Cancelled'], ['failed', 'Cancelled'], ['failed', 'Stopped'], ['failed', 'Stopped']]);
  await sleep(200);
  assert.equal(s.mock.turns.length, turns);
  // A stop is an event chip, not an error bubble.
  const msgs = await s.messagesOf(bot.id);
  assert.deepEqual(msgs.filter((m) => m.role === 'error'), []);
  const chip = msgs.find((m) => m.meta?.kind === 'turn.stopped' && m.meta.runId === second.id)!;
  assert.equal(chip.meta?.routineName, 'Job');
  assert.equal((await s.call('POST', `/api/bots/${bot.id}/stop`, { clearQueue: 'yes' })).status, 400);
});

test('cancelling queued runs (the Stop toast’s "Cancel them") leaves the job running now and unanswered messages alone', async () => {
  const s = await start();
  const bot = await s.newBot('Bob');
  const slow = await s.newRoutine(bot.id, { instruction: 'SLOW_PLEASE:600', webhook: true });
  const quick = await s.newRoutine(bot.id, { webhook: true });
  await s.hook(slow);
  const running = await until(async () => (await s.runsOf(slow.id)).find((r) => r.status === 'running'));
  for (let i = 0; i < 2; i++) assert.equal((await s.hook(quick)).status, 202);
  await s.send(bot.id, 'still there?');

  const res = await s.call<CancelRunsResult>('POST', `/api/bots/${bot.id}/cancel-runs`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { cancelledRuns: 2 });
  assert.deepEqual((await s.runsOf(quick.id)).map((r) => [r.status, r.error]), [['failed', 'Cancelled'], ['failed', 'Cancelled']]);
  await until(async () => (await s.runsOf(slow.id)).find((r) => r.id === running.id && r.status === 'succeeded'));
  await until(async () => (await s.messagesOf(bot.id)).find((m) => m.role === 'bot' && m.text.includes('still there?')));
  assert.equal(s.turnsOf(bot.id).length, 2);
  assert.equal((await s.call('POST', '/api/bots/bot_nope/cancel-runs')).status, 404);
});

test('pausing a Boton stops its turn and holds every kind of work: no chat, scheduled, manual or webhook run starts, and a due one-off waits, until it is resumed', async () => {
  const s = await start();
  const bot = await s.newBot('Dave');
  const routine = await s.newRoutine(bot.id, { webhook: true });
  await s.call('PATCH', `/api/routines/${routine.id}`, { schedule: 'every 1m' });
  const remind = await s.newRoutine(bot.id, { name: 'Remind', instruction: 'Remind me', schedule: 'in 1h' });
  await s.send(bot.id, 'SLOW_PLEASE first');
  await s.untilState(bot.id, 'working');

  const paused = await s.call<Bot>('POST', `/api/bots/${bot.id}/pause`);
  assert.equal(paused.status, 200);
  assert.equal(paused.data.paused, true);
  await s.untilState(bot.id, 'idle');
  const turns = s.turnsOf(bot.id).length;

  const refused = await s.hook(routine);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Dave is paused/);
  assert.equal((await s.call('POST', `/api/routines/${routine.id}/run`)).status, 409);
  assert.equal((await s.send(bot.id, 'are you there?')).status, 202);
  // A scheduled slot is skipped and says why; a one-off waits instead of being lost.
  const past = new Date(Date.now() - 1000).toISOString();
  s.app.store.db.prepare('update routines set next_run_at = ? where id = ?').run(past, routine.id);
  s.app.store.db.prepare('update routines set schedule = ?, next_run_at = ? where id = ?').run(`once ${past}`, past, remind.id);
  const skipped = await until(async () => (await s.runsOf(routine.id)).find((r) => r.status === 'skipped'));
  assert.equal(skipped.error, 'Dave is paused');
  const queued = await until(async () => (await s.runsOf(remind.id))[0]);
  assert.equal(queued.status, 'queued');
  await sleep(300);
  assert.equal(s.turnsOf(bot.id).length, turns);
  assert.equal((await s.runsOf(remind.id)).length, 1);
  assert.equal(s.app.engine.statusOf(bot.id).state, 'idle');
  const msgs = await s.messagesOf(bot.id);
  assert.deepEqual(msgs.filter((m) => m.role === 'bot' || m.role === 'error'), []);
  assert.ok(msgs.some((m) => m.meta?.kind === 'turn.stopped'));
  assert.ok(msgs.some((m) => m.meta?.kind === 'bot.paused'));

  // Resuming answers the waiting message (not the stopped turn's) and runs the one-off.
  const resumed = await s.call<Bot>('POST', `/api/bots/${bot.id}/resume`);
  assert.equal(resumed.data.paused, false);
  const reply = await until(async () => (await s.messagesOf(bot.id)).find((m) => m.role === 'bot' && !m.meta?.runId));
  assert.match(reply.text, /are you there\?/);
  assert.doesNotMatch(reply.text, /first/);
  await until(() => s.app.store.findRun(queued.id)?.status === 'succeeded');
  assert.equal((await s.hook(routine)).status, 202);
});

test('Pause all holds every Boton and survives a restart; a paused Boton’s queued run waits across the restart too', async () => {
  const s1 = await start();
  const a = await s1.newBot('Jerry');
  const b = await s1.newBot('Phil');
  const routine = await s1.newRoutine(a.id, { webhook: true });
  // A run queued behind a slow chat turn stays queued when A is paused.
  await s1.send(a.id, 'SLOW_PLEASE');
  await s1.untilState(a.id, 'working');
  const { runId } = (await (await s1.hook(routine)).json()) as { runId: string };
  await s1.call('POST', `/api/bots/${a.id}/pause`);
  await s1.untilState(a.id, 'idle');
  assert.equal(s1.app.store.findRun(runId)?.status, 'queued');

  const all = await s1.call<Settings>('POST', '/api/pause');
  assert.equal(all.data.paused, true);
  assert.equal((await s1.send(b.id, 'hi B')).status, 202);
  const refused = await s1.hook(routine);
  assert.equal(refused.status, 409);
  await sleep(200);
  assert.equal(s1.turnsOf(b.id).length, 0);
  // Only POST /api/pause and /api/resume flip it.
  assert.equal((await s1.call('PATCH', '/api/settings', { paused: false })).status, 400);
  await s1.stop();

  const s2 = await start({ home: s1.home, token: s1.token });
  assert.equal((await s2.call<Settings>('GET', '/api/settings')).data.paused, true);
  assert.equal((await s2.call<Bot>('GET', `/api/bots/${a.id}`)).data.paused, true);
  await sleep(300);
  assert.equal(s2.mock.turns.length, 0);
  assert.equal(s2.app.store.findRun(runId)?.status, 'queued');

  // Resume all: B answers; A is still paused on its own, so its run still waits.
  await s2.call('POST', '/api/resume');
  await until(async () => (await s2.messagesOf(b.id)).some((m) => m.role === 'bot'));
  await sleep(200);
  assert.equal(s2.app.store.findRun(runId)?.status, 'queued');
  await s2.call('POST', `/api/bots/${a.id}/resume`);
  await until(() => s2.app.store.findRun(runId)?.status === 'succeeded');
});
