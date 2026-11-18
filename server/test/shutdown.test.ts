import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoutineRun } from '../../shared/types.ts';
import { startServer, until } from './helpers.ts';

test('an event stream open during a drain gets the drained turn’s reply and its idle status before the server closes', async () => {
  const s = await startServer();
  const bot = await s.newBot('Drainer');
  const sse = await s.events();
  await s.send(bot.id, 'SLOW_PLEASE:600 hi');
  await s.untilState(bot.id, 'working');
  const { interrupted } = await s.stop({ drainMs: 10_000 });
  assert.equal(interrupted, 0);
  await sse.ended;
  const { events } = sse;
  const reply = events.find((e) => e.type === 'message.created' && e.message.role === 'bot');
  assert.ok(reply && reply.type === 'message.created' && reply.message.text === 'Echo: SLOW_PLEASE:600 hi', JSON.stringify(events.map((e) => e.type)));
  const last = events.filter((e) => e.type === 'bot.status' && e.botId === bot.id).at(-1);
  assert.ok(last && last.type === 'bot.status' && last.status.state === 'idle', JSON.stringify(last));
});

test('a webhook caller waiting with ?wait=1 when the server stops gets a 503 naming its run, not a cut connection', async () => {
  const s = await startServer();
  const bot = await s.newBot('Waiter');
  const routine = await s.newRoutine(bot.id, { name: 'Slow', instruction: 'SLOW_PLEASE:20000 work', webhook: true });
  const waiting = s.hook(routine, 'wait=1&timeout=60', { body: '{}' });
  await s.untilState(bot.id, 'working');
  const closed = s.stop({ drainMs: 100 });
  const res = await waiting;
  assert.equal(res.status, 503);
  assert.match(res.headers.get('location') ?? '', new RegExp(`/hooks/routines/${routine.id}/runs/run_`));
  const body = (await res.json()) as { ok: boolean; runId: string; status: string; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.status, 'running');
  assert.match(body.runId, /^run_/);
  assert.match(body.error, /restarting before this run finished/);
  assert.deepEqual(await closed, { interrupted: 1 });
});

for (const kind of ['chat', 'routine'] as const) {
  for (const first of ['interrupt', 'stop'] as const) {
    test(`${kind} stopped during connector setup: ${first} stays the reason and no agent starts`, async () => {
      const s = await startServer();
      const bot = await s.newBot('Bob');
      const connectors = s.app.connectors;
      const resolve = connectors.resolve;
      const gate = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      connectors.resolve = async (...args) => {
        waiting.resolve();
        await gate.promise;
        return resolve.apply(connectors, args);
      };
      let run: RoutineRun | undefined;
      try {
        if (kind === 'chat') await s.send(bot.id, 'Finish the setup');
        else {
          const routine = await s.newRoutine(bot.id, { name: 'Setup', instruction: 'Finish the setup' });
          run = (await s.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
        }
        await waiting.promise;
        if (first === 'stop') s.app.engine.stop(bot.id);
        s.app.engine.interruptAll();
        // A repeated shutdown signal and a later Stop must neither replace the reason nor count it twice.
        s.app.engine.interruptAll();
        if (first === 'interrupt') s.app.engine.stop(bot.id);
      } finally {
        connectors.resolve = resolve;
        gate.resolve();
      }
      await s.untilState(bot.id, 'idle');
      assert.equal(s.turnsOf(bot.id).length, 0, 'the provider never receives the prompt');
      const turn = s.app.store.db.prepare('select outcome from turns where bot_id = ?').get(bot.id);
      assert.equal(turn?.outcome, first === 'interrupt' ? 'interrupted' : 'stopped');
      assert.equal(s.app.store.hasPendingChat(bot.id), kind === 'chat' && first === 'interrupt');
      if (run) {
        const saved = s.app.store.getRun(run.id);
        assert.equal(saved.status, first === 'interrupt' ? 'running' : 'failed');
        assert.deepEqual(saved.meta?.cancelled, first === 'interrupt' ? undefined : { at: saved.finishedAt, started: false });
      }
      assert.deepEqual(await s.stop(), { interrupted: first === 'interrupt' ? 1 : 0 });

      const resumed = await startServer({ home: s.home, token: s.token });
      try {
        if (kind === 'chat' && first === 'interrupt') {
          await until(async () => (await resumed.messagesOf(bot.id)).some((m) => m.role === 'bot'));
          assert.equal(resumed.turnsOf(bot.id).length, 1);
          assert.equal(resumed.app.store.hasPendingChat(bot.id), false);
        } else {
          assert.equal(resumed.app.store.hasPendingChat(bot.id), false);
          assert.equal(resumed.turnsOf(bot.id).length, 0);
        }
        if (run) {
          const saved = resumed.app.store.getRun(run.id);
          assert.equal(saved.status, 'failed');
          assert.equal(saved.error, first === 'interrupt' ? 'Interrupted by a restart' : 'Stopped');
        }
      } finally {
        await resumed.stop();
      }
    });
  }
}
