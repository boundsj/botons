import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './helpers.ts';

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
