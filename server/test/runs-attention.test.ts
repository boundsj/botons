import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoutineRun, RunsAttention } from '../../shared/types.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer();
const { app } = s;

const attention = async () => {
  const r = await s.call<RunsAttention>('GET', '/api/runs/attention');
  assert.equal(r.status, 200, r.text);
  return r.data;
};

test('runs to check: failed and not retried across Botons, newest first, then held runs; a retry takes a run off the list', async () => {
  const kevin = await s.newBot('Kevin');
  const stuart = await s.newBot('Stuart');
  const deploys = app.store.getRoutine((await s.newRoutine(kevin.id, { name: 'Deploys', webhook: true })).id);
  const report = app.store.getRoutine((await s.newRoutine(stuart.id, { name: 'Report' })).id);
  const fail = (routine: typeof deploys, trigger: RoutineRun['trigger'], error: string) => {
    const run = app.store.createRun(routine, trigger, trigger === 'webhook' ? '{"deploy":"v2"}' : null);
    return app.store.updateRun(run.id, { status: 'failed', error });
  };
  const interrupted = fail(report, 'schedule', 'Interrupted by a restart');
  const crashed = fail(deploys, 'webhook', 'The CLI crashed');
  fail(deploys, 'test', 'A test run the owner watched');
  const old = fail(report, 'manual', 'Too long ago');
  app.store.db.prepare("update routine_runs set finished_at = '2020-01-01T00:00:00.000Z' where id = ?").run(old.id);
  const ok = app.store.createRun(report, 'manual', null);
  app.store.updateRun(ok.id, { status: 'succeeded' });
  // Held after a network error, far enough ahead that it does not run during the test.
  const waiting = app.store.createRun(deploys, 'schedule', null);
  app.store.holdRun(waiting.id, new Date(Date.now() + 3_600_000), 'connect ECONNREFUSED', 'retry');

  const heldTest = app.store.createRun(deploys, 'test', null);
  app.store.holdRun(heldTest.id, new Date(Date.now() + 3_600_000), 'usage limit', 'usage_limit');

  let list = await attention();
  assert.ok(Date.parse(list.since) < Date.now() - 6 * 86_400_000);
  assert.deepEqual(
    list.failed.map((r) => [r.id, r.botName, r.routineName, r.error]),
    [
      [crashed.id, 'Kevin', 'Deploys', 'The CLI crashed'],
      [interrupted.id, 'Stuart', 'Report', 'Interrupted by a restart'],
    ],
  );
  assert.equal(list.failed[0].payloadPreview, '{"deploy":"v2"}', 'the owner sees what a retry would send again');
  assert.deepEqual(
    list.held.map((r) => [r.id, r.botName, r.routineName, r.lastError]),
    [[waiting.id, 'Kevin', 'Deploys', 'connect ECONNREFUSED']],
  );
  assert.ok(list.held[0].retryAt);

  // Retrying from the list: the failed run leaves it, and the retry runs like any other.
  s.mock.failNext(stuart.id, new Error('retry failed'));
  const retried = await s.call<RoutineRun>('POST', `/api/runs/${interrupted.id}/retry`);
  assert.equal(retried.status, 202, retried.text);
  list = await attention();
  assert.deepEqual(
    list.failed.filter((r) => r.id !== retried.data.id).map((r) => r.id),
    [crashed.id],
  );
  const done = await until(async () => {
    const r = (await s.runsOf(report.id)).find((x) => x.id === retried.data.id);
    return r && r.status !== 'queued' && r.status !== 'running' ? r : null;
  });
  assert.equal(done.status, 'failed');
  assert.ok((await attention()).failed.some((r) => r.id === retried.data.id));
  app.store.updateRun(waiting.id, { status: 'succeeded' });
  assert.deepEqual((await attention()).held, [], 'completed held runs leave the refreshed overview');
});

test('only paired devices see runs to check: it spans every Boton', async () => {
  const bob = await s.newBot('Bob');
  const boton = app.auth.mintBotonToken(bob.id).token;
  assert.equal((await s.call('GET', '/api/runs/attention', undefined, boton)).status, 403);
  assert.equal((await s.call('GET', '/api/runs/attention', undefined, null)).status, 401);
});
