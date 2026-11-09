import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Routine, SchedulePreview } from '../../shared/types.ts';
import { ROUTINE_QUEUE_MAX } from '../src/engine.ts';
import { captureLogs } from '../src/log.ts';
import { sleep, startServer, type TestServer, until } from './helpers.ts';

const env = { BOTONS_SCHEDULER_MS: '100' };
const s = await startServer({ env });

const rowCount = (srv: TestServer, routineId: string) =>
  Number((srv.app.store.db.prepare('select count(*) as n from routine_runs where routine_id = ?').get(routineId) as { n: number }).n);

function forceDue(srv: TestServer, routineId: string) {
  srv.app.store.db.prepare('update routines set next_run_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), routineId);
}

function oneOffDue(routineId: string) {
  const past = new Date(Date.now() - 1000).toISOString();
  s.app.store.db.prepare('update routines set schedule = ?, next_run_at = ? where id = ?').run(`once ${past}`, past, routineId);
}

test('a slot that comes while the previous run is still running is skipped, visibly, and the schedule moves on', async (t) => {
  const logs = captureLogs();
  t.after(logs.restore);
  const bot = await s.newBot('Kevin');
  const routine = await s.newRoutine(bot.id, { schedule: 'every 1m', instruction: 'SLOW_PLEASE:1500 crunch' });

  forceDue(s, routine.id);
  const first = await until(async () => (await s.runsOf(routine.id)).find((r) => r.status === 'running'));
  const turns = s.mock.turns.length;

  forceDue(s, routine.id);
  const skipped = await until(async () => (await s.runsOf(routine.id)).find((r) => r.status === 'skipped'));
  assert.equal(skipped.trigger, 'schedule');
  assert.equal(skipped.error, 'The previous run was still queued or running');
  assert.ok(skipped.finishedAt);
  const line = logs.lines.find((l) => l.msg === 'scheduled run skipped');
  assert.deepEqual(
    line && { routineId: line.routineId, runId: line.runId, trigger: line.trigger, reason: line.reason },
    { routineId: routine.id, runId: skipped.id, trigger: 'schedule', reason: 'The previous run was still queued or running' },
  );
  // The schedule moved on, no second run or turn started, and the routine's last status is unchanged.
  const after = (await s.call<Routine>('GET', `/api/routines/${routine.id}`)).data;
  assert.ok(after.nextRunAt && new Date(after.nextRunAt).getTime() > Date.now(), after.nextRunAt ?? 'null');
  const runs = await s.runsOf(routine.id);
  assert.deepEqual(runs.map((r) => r.status).sort(), ['running', 'skipped']);
  assert.equal(s.mock.turns.length, turns);
  assert.equal(after.lastStatus, 'running');

  await until(async () => (await s.runsOf(routine.id)).find((r) => r.id === first.id && r.status === 'succeeded'), 6000);
  const msgs = await s.messagesOf(bot.id);
  assert.equal(msgs.filter((m) => m.meta?.kind === 'routine.run').length, 1);
  assert.deepEqual(msgs.filter((m) => m.role === 'error'), []);
});

test(`with ${ROUTINE_QUEUE_MAX} runs queued, another webhook or manual run is refused with 429 and Retry-After, and no run is created`, async () => {
  const bot = await s.newBot('Stuart');
  const routine = await s.newRoutine(bot.id, { webhook: true });
  // A slow chat turn holds the queue.
  await s.send(bot.id, 'SLOW_PLEASE');
  await s.untilState(bot.id, 'working');

  for (let i = 0; i < ROUTINE_QUEUE_MAX; i++) assert.equal((await s.hook(routine)).status, 202);
  assert.equal(rowCount(s, routine.id), ROUTINE_QUEUE_MAX);

  const refused = await s.hook(routine);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0, `Retry-After: ${refused.headers.get('retry-after')}`);
  assert.match((await refused.json()).error, /already has 3 runs waiting/);
  const manual = await s.call<{ error: string }>('POST', `/api/routines/${routine.id}/run`);
  assert.equal(manual.status, 429);
  assert.ok(Number(manual.res.headers.get('retry-after')) > 0);
  assert.equal(rowCount(s, routine.id), ROUTINE_QUEUE_MAX);

  // One chip, however many requests were refused.
  const chips = (await s.messagesOf(bot.id)).filter((m) => m.meta?.kind === 'routine.rate_limited');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].meta?.routineId, routine.id);
  assert.match(chips[0].text, /Refused webhook runs/);

  // The queued ones still run once the queue moves.
  await s.call('POST', `/api/bots/${bot.id}/stop`);
  await until(async () => (await s.runsOf(routine.id)).filter((r) => r.status === 'succeeded').length === ROUTINE_QUEUE_MAX, 6000);
  assert.equal((await s.hook(routine)).status, 202);
});

test('the hourly limits per routine and in total (30 and 100 unless the env vars say) refuse webhook and manual runs with 429', async () => {
  assert.deepEqual([s.cfg.routineRunsPerHour, s.cfg.runsPerHour], [30, 100]);
  const limited = await startServer({ env: { ...env, BOTONS_ROUTINE_RUNS_PER_HOUR: '2', BOTONS_RUNS_PER_HOUR: '3' } });
  const bot = await limited.newBot('Dave');
  const a = await limited.newRoutine(bot.id, { name: 'A', webhook: true });
  const b = await limited.newRoutine(bot.id, { name: 'B', webhook: true });

  assert.equal((await limited.call('POST', `/api/routines/${a.id}/run`)).status, 202);
  assert.equal((await limited.hook(a)).status, 202);
  const overRoutine = await limited.hook(a);
  assert.equal(overRoutine.status, 429);
  const retry = Number(overRoutine.headers.get('retry-after'));
  assert.ok(retry > 3500 && retry <= 3600, `Retry-After ${retry}`);
  assert.match((await overRoutine.json()).error, /“A” has started 2 webhook and manual runs in the last hour/);
  assert.equal((await limited.call('POST', `/api/routines/${a.id}/run`)).status, 429);

  // B has its own allowance, but all routines together have 3.
  assert.equal((await limited.hook(b)).status, 202);
  const overTotal = await limited.call<{ error: string }>('POST', `/api/routines/${b.id}/run`);
  assert.equal(overTotal.status, 429);
  assert.match(overTotal.data.error, /Botons has started 3 webhook and manual runs in the last hour/);
  assert.equal(rowCount(limited, a.id) + rowCount(limited, b.id), 3);

  // Scheduled runs are not limited.
  await until(async () => [...(await limited.runsOf(a.id)), ...(await limited.runsOf(b.id))].every((r) => r.status === 'succeeded'));
  limited.app.store.db.prepare("update routines set schedule = 'every 60m' where id = ?").run(b.id);
  forceDue(limited, b.id);
  await until(async () => (await limited.runsOf(b.id)).some((r) => r.trigger === 'schedule' && r.status === 'succeeded'));
  const chips = (await limited.messagesOf(bot.id)).filter((m) => m.meta?.kind === 'routine.rate_limited');
  assert.deepEqual(chips.map((m) => m.meta?.routineName).sort(), ['A', 'B']);
});

test('a one-off time that is not in the future is refused when creating, updating or previewing', async () => {
  const bot = await s.newBot('Phil');
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const created = await s.call<{ error: string }>('POST', `/api/bots/${bot.id}/routines`, {
    name: 'Late',
    instruction: 'x',
    schedule: `at ${yesterday} 09:00`,
    timezone: 'UTC',
  });
  assert.equal(created.status, 400);
  assert.match(created.data.error, /has already passed/);

  const preview = await s.call<SchedulePreview>('POST', '/api/schedule/preview', { schedule: `at ${yesterday} 09:00`, timezone: 'UTC' });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.ok, false);
  assert.match(preview.data.error ?? '', /has already passed/);
  assert.equal((await s.call<SchedulePreview>('POST', '/api/schedule/preview', { schedule: 'in 10m' })).data.ok, true);

  const routine = await s.newRoutine(bot.id, { schedule: 'in 2h' });
  const updated = await s.call<{ error: string }>('PATCH', `/api/routines/${routine.id}`, { schedule: `${yesterday} 09:00`, timezone: 'UTC' });
  assert.equal(updated.status, 400);
  assert.match(updated.data.error, /has already passed/);
});

test('a one-off fires once and is retired, out of the Boton context until given a new time; one with a webhook keeps it and drops the spent schedule', async () => {
  const bot = await s.newBot('Jerry');
  const routine = await s.newRoutine(bot.id, { name: 'Reminder', schedule: 'in 1h', instruction: 'Remind me' });
  const hooked = await s.newRoutine(bot.id, { name: 'Hooked', schedule: 'in 1h', webhook: true });
  oneOffDue(routine.id);
  oneOffDue(hooked.id);

  for (const r of [routine, hooked]) await until(async () => (await s.runsOf(r.id)).find((run) => run.status === 'succeeded'));
  const fired = (await s.call<Routine>('GET', `/api/routines/${routine.id}`)).data;
  assert.deepEqual([fired.enabled, fired.nextRunAt], [false, null]);
  const firedHook = (await s.call<Routine>('GET', `/api/routines/${hooked.id}`)).data;
  assert.deepEqual([firedHook.enabled, firedHook.schedule], [true, null]);
  await sleep(300);
  assert.equal((await s.runsOf(routine.id)).length, 1);

  const other = await s.newRoutine(bot.id, { name: 'Weekly', schedule: 'mondays at 9am' });
  const seen = s.mock.turns.length;
  await s.send(bot.id, 'what are your routines?');
  const turn = await until(() => s.mock.turns.slice(seen).find((t) => t.env.BOTON_BOT_ID === bot.id));
  const context = turn.prompt.slice(turn.prompt.indexOf('<boton_context>'), turn.prompt.indexOf('</boton_context>'));
  assert.ok(!context.includes(routine.id), context);
  assert.ok(context.includes(other.id), context);

  const resumed = await s.call<{ error: string }>('PATCH', `/api/routines/${routine.id}`, { enabled: true });
  assert.equal(resumed.status, 400);
  assert.match(resumed.data.error, /already ran/);
  const again = await s.call<Routine>('PATCH', `/api/routines/${routine.id}`, { schedule: 'in 3h' });
  assert.equal(again.status, 200);
  assert.equal(again.data.enabled, true);
  assert.ok(again.data.nextRunAt);
  assert.equal((await s.hook(firedHook)).status, 202);
});

test('spent one-offs do not count toward the 50-routine cap', async () => {
  const bot = await s.newBot('Tim');
  for (let i = 0; i < 49; i++) s.app.store.createRoutine(bot.id, { name: `R${i}`, instruction: 'x' });
  const spent = s.app.store.createRoutine(bot.id, { name: 'Spent', instruction: 'x', schedule: 'in 1h' });
  assert.equal((await s.call('POST', `/api/bots/${bot.id}/routines`, { name: 'Over', instruction: 'x' })).status, 400);
  const past = new Date(Date.now() - 1000).toISOString();
  s.app.store.db.prepare('update routines set schedule = ?, enabled = 0, next_run_at = null where id = ?').run(`once ${past}`, spent.id);
  assert.equal((await s.call('POST', `/api/bots/${bot.id}/routines`, { name: 'Fits', instruction: 'x' })).status, 201);
  assert.equal((await s.call('POST', `/api/bots/${bot.id}/routines`, { name: 'Over', instruction: 'x' })).status, 400);
});
