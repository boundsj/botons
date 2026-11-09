import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditEvent, RoutineRun, WebhookRunStatus } from '../../shared/types.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer();
const { app } = s;

const settled = (routineId: string, runId: string) =>
  until(async () => {
    const r = (await s.runsOf(routineId)).find((x) => x.id === runId);
    return r && (r.status === 'succeeded' || r.status === 'failed') ? r : null;
  });

test('webhook delivery references survive history pruning and long retry chains without extending expiry', async () => {
  const bot = await s.newBot('Retention');
  const routine = await s.newRoutine(bot.id, { name: 'Retained delivery', webhook: true });
  const stored = app.store.getRoutine(routine.id);
  let run = app.store.createRun(stored, 'webhook', '{"event":"retention"}');
  run = app.store.updateRun(run.id, { status: 'failed', error: 'interrupted' });
  const originalId = run.id;
  app.store.recordDelivery(routine.id, 'retention-key', run.id);
  const createdAt = () => app.store.db.prepare('select created_at from webhook_deliveries where routine_id = ?').get(routine.id)!.created_at;
  const expiryStart = createdAt();
  for (let i = 0; i < 19; i++) {
    const other = app.store.createRun(stored, 'manual', null);
    app.store.updateRun(other.id, { status: 'succeeded' });
  }
  for (let i = 0; i < 22; i++) {
    run = app.store.createRetryRun(run);
    run = app.store.updateRun(run.id, { status: i === 21 ? 'succeeded' : 'failed', error: 'interrupted' });
    assert.equal(app.store.findDelivery(routine.id, 'retention-key'), run.id);
    assert.equal(createdAt(), expiryStart);
    assert.equal(app.store.findRun(originalId), null);
  }
  assert.equal(app.store.findRun(app.store.findDelivery(routine.id, 'retention-key')!)!.status, 'succeeded');
});

test('the owner retries a failed webhook run: same trigger, payload and headers, sandboxed, told it may have partly run, once only', async () => {
  const bot = await s.newBot('Kevin', { access: 'host' });
  const routine = await s.newRoutine(bot.id, { name: 'Deploys', instruction: 'Check the deploy.', webhook: true });
  s.mock.failNext(bot.id, new Error('The CLI crashed'));
  const body = JSON.stringify({ deploy: 'v2' });
  const res = await s.hook(routine, '', { method: 'POST', body, headers: { 'content-type': 'application/json', 'idempotency-key': 'delivery-1' } });
  assert.equal(res.status, 202);
  const { runId } = (await res.json()) as { runId: string };
  const failed = await settled(routine.id, runId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /The CLI crashed/);

  const retried = await s.call<RoutineRun>('POST', `/api/runs/${runId}/retry`);
  assert.equal(retried.status, 202, retried.text);
  const retry = retried.data;
  assert.equal(retry.trigger, 'webhook');
  assert.equal(retry.payloadPreview, body);
  assert.deepEqual(retry.headers, failed.headers);
  assert.deepEqual(retry.meta?.retryOf, { runId, error: failed.error });
  const done = await settled(routine.id, retry.id);
  assert.equal(done.status, 'succeeded');
  const turn = s.turnsOf(bot.id).at(-1)!;
  assert.equal(turn.access, 'workspace', 'a retried webhook run keeps the webhook sandbox');
  assert.match(turn.prompt, /asked to retry an earlier run of this routine that failed \(.*The CLI crashed.*\), with the same trigger and payload/);
  assert.match(turn.prompt, /"deploy": "v2"/);

  const old = (await s.runsOf(routine.id)).find((r) => r.id === runId)!;
  assert.equal(old.meta?.retriedAs, retry.id);
  // Once only, and never a run that did not fail.
  const again = await s.call<{ error: string }>('POST', `/api/runs/${runId}/retry`);
  assert.equal(again.status, 409);
  assert.match(again.data.error, new RegExp(`already retried as ${retry.id}`));
  assert.equal((await s.call('POST', `/api/runs/${retry.id}/retry`)).status, 409);
  assert.equal((await s.call('POST', '/api/runs/run_nope/retry')).status, 404);

  // The sender, holding the first run's id, sees where it went; a redelivery gets the retry, not a third run.
  const status = (await (await fetch(`${s.base}/hooks/routines/${routine.id}/runs/${runId}`, { headers: { authorization: `Bearer ${routine.webhook!.key}` } })).json()) as WebhookRunStatus;
  assert.equal(status.status, 'failed');
  assert.equal(status.retriedAs, retry.id);
  const redelivered = await s.hook(routine, '', { method: 'POST', body, headers: { 'content-type': 'application/json', 'idempotency-key': 'delivery-1' } });
  assert.equal(redelivered.status, 200);
  assert.deepEqual(await redelivered.json(), { ok: true, runId: retry.id, status: 'succeeded', duplicate: true });
  assert.equal((await s.runsOf(routine.id)).length, 2);

  const audit = (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'run.retried');
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].target, { kind: 'routine', id: routine.id, label: 'Deploys' });
  assert.deepEqual(audit[0].details, { boton: bot.id, runId, retryRunId: retry.id, trigger: 'webhook' });
});

test('only the owner retries, and not while the Boton is paused; a manual run is retried as a manual run', async () => {
  const bot = await s.newBot('Stuart');
  const routine = await s.newRoutine(bot.id, { name: 'Report' });
  s.mock.failNext(bot.id, new Error('boom'));
  const { data: run } = await s.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`);
  assert.equal((await settled(routine.id, run.id)).status, 'failed');

  const boton = app.auth.mintBotonToken(bot.id).token;
  const refused = await s.call('POST', `/api/runs/${run.id}/retry`, {}, boton);
  assert.equal(refused.status, 403, refused.text);

  assert.equal((await s.call('POST', `/api/bots/${bot.id}/pause`)).status, 200);
  const paused = await s.call<{ error: string }>('POST', `/api/runs/${run.id}/retry`);
  assert.equal(paused.status, 409);
  assert.match(paused.data.error, /Resume to run routines/);
  assert.equal((await s.runsOf(routine.id)).length, 1, 'no run was created');
  await s.call('POST', `/api/bots/${bot.id}/resume`);

  const ok = await s.call<RoutineRun>('POST', `/api/runs/${run.id}/retry`);
  assert.equal(ok.status, 202);
  assert.equal(ok.data.trigger, 'manual');
  assert.equal((await settled(routine.id, ok.data.id)).status, 'succeeded');
});

test('a run cut off by a restart is failed as interrupted and can then be retried', async () => {
  const bot = await s.newBot('Bob');
  const routine = await s.newRoutine(bot.id, { name: 'Nightly' });
  const run = app.store.createRun(app.store.getRoutine(routine.id), 'schedule', null);
  // As a crashed server leaves it: running, with no turn alive.
  app.store.db.prepare("update routine_runs set status = 'running' where id = ?").run(run.id);
  const [interrupted] = app.store.failInterruptedRuns();
  assert.equal(interrupted.error, 'Interrupted by a restart');

  const { status, data: retry } = await s.call<RoutineRun>('POST', `/api/runs/${run.id}/retry`);
  assert.equal(status, 202);
  assert.equal(retry.trigger, 'schedule');
  assert.equal((await settled(routine.id, retry.id)).status, 'succeeded');
  assert.match(s.turnsOf(bot.id).at(-1)!.prompt, /failed \(Interrupted by a restart\)/);
});
