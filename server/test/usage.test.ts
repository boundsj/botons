import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { ProviderInfo, Routine, RunStatus } from '../../shared/types.ts';
import { INTERRUPTED_NOTE } from '../src/engine.ts';
import { MIN_COOLDOWN_MS } from '../src/providers/failures.ts';
import { ProviderError } from '../src/providers/types.ts';
import { startScheduler } from '../src/scheduler.ts';
import type { FakeCli } from './fixtures/fake-cli.ts';
import { type ServerOptions, sleep, startServer, type TestServer, tempDir, until, useTestCodexHome } from './helpers.ts';

useTestCodexHome(tempDir('botons-usage-test-'));

async function start(opts: ServerOptions = {}) {
  const s: TestServer & Partial<Record<'claude' | 'codex', FakeCli>> = await startServer({ ...opts, env: { BOTONS_SCHEDULER_MS: '1h', BOTONS_RUN_RETRY_DELAY: '50ms', ...opts.env } });
  const { app } = s;
  const messages = (botId: string) => app.store.listMessages(botId);
  return {
    ...s,
    messages,
    notices: (botId: string) => messages(botId).filter((m) => m.meta?.kind === 'usage.limit'),
    errors: (botId: string) => messages(botId).filter((m) => m.role === 'error'),
    pending: () => (app.store.db.prepare("select count(*) as n from messages where role = 'user' and pending != 0").get() as { n: number }).n,
    /** Wait for the run to have `status` (with none: to have ended), and return it. */
    untilRun: (runId: string, status?: RunStatus, ms?: number) =>
      until(() => {
        const r = app.store.findRun(runId);
        return r && (status ? r.status === status : r.status !== 'queued' && r.status !== 'running') && r;
      }, ms),
    fireSlot: (routine: Routine) => app.engine.fireScheduled(app.store.getRoutine(routine.id)),
    /** Bring a one-off's time to now and let the scheduler fire it (which retires the routine). */
    fireOneOff: (routine: Routine) => {
      const past = new Date(Date.now() - 1000).toISOString();
      app.store.db.prepare('update routines set schedule = ?, next_run_at = ? where id = ?').run(`once ${past}`, past, routine.id);
      startScheduler(app.store, app.engine, 3_600_000)();
    },
  };
}

const usageLimit = (ms: number) => new ProviderError("You've hit your limit", false, { kind: 'usage_limit', retryAt: new Date(Date.now() + ms) });
const transient = () => new ProviderError('API Error: Connection error.', false, { kind: 'transient' });
const authError = () => new ProviderError('Not logged in · Please run /login', false, { kind: 'auth' });

test('a usage limit holds the boton\'s work with one notice and shows on GET /api/providers; after the reset everything runs without resending', async () => {
  const s = await start();
  const { app, mock } = s;
  const bot = s.storeBot('Kevin');
  const routine = app.store.createRoutine(bot.id, { name: 'Hook', instruction: 'Handle it', webhook: true });
  const retryAt = new Date(Date.now() + 1500);
  mock.failNext(bot.id, new ProviderError("You've hit your limit · resets 3pm", false, { kind: 'usage_limit', retryAt }));

  app.engine.sendMessage(bot.id, 'hello');
  await until(() => s.notices(bot.id).length === 1);
  const notice = s.notices(bot.id)[0];
  assert.equal(notice.role, 'event');
  assert.equal(notice.meta?.retryAt, retryAt.toISOString());
  assert.match(notice.text, /usage limit reached; continuing/);
  assert.equal(s.pending(), 1);
  assert.deepEqual(s.errors(bot.id), []);
  const limit = { until: retryAt.toISOString(), reason: "You've hit your limit · resets 3pm" };
  assert.deepEqual(app.engine.usageLimit('mock'), limit);
  assert.equal(app.engine.usageLimit('claude-cli'), null);
  const infos = async () => (await s.call<ProviderInfo[]>('GET', '/api/providers')).data;
  const during = await infos();
  assert.deepEqual(during.find((p) => p.id === 'mock')!.usageLimit, limit);
  assert.equal(during.find((p) => p.id === 'claude-cli')!.usageLimit, null);

  // More messages and runs during the wait: no provider call, no second notice.
  app.engine.sendMessage(bot.id, 'and this one');
  const run = app.engine.triggerRoutine(routine.id, 'webhook');
  const held = await until(() => {
    const r = app.store.findRun(run.id);
    return r?.retryAt ? r : null;
  });
  assert.deepEqual([held.status, held.attempts], ['queued', 0]);
  assert.match(held.lastError ?? '', /^Mock usage limit until/);
  await sleep(200);
  assert.equal(s.turnsOf(bot.id).length, 1);
  assert.equal(s.notices(bot.id).length, 1);

  const reply = await until(() => s.messages(bot.id).find((m) => m.role === 'bot' && !m.meta?.runId), 4000);
  assert.ok(Date.parse(reply.createdAt) >= retryAt.getTime(), `${reply.createdAt} is before the reset`);
  // Both messages, answered in one turn, with the note that the earlier attempt was cut off.
  assert.ok(reply.text.includes(INTERRUPTED_NOTE) && reply.text.includes('hello') && reply.text.includes('and this one'), reply.text);
  await s.untilRun(run.id, 'succeeded', 4000);
  assert.equal(s.turnsOf(bot.id).length, 3);
  assert.equal(s.pending(), 0);
  assert.equal(s.notices(bot.id).length, 1);
  assert.equal((await infos()).find((p) => p.id === 'mock')!.usageLimit, null, 'gone once it reset');
});

test("during a cooldown a due routine makes no provider call and says why; another provider's Boton keeps working", async () => {
  const s = await start({ fakeClis: true });
  const [app, claude, codex] = [s.app, s.claude!, s.codex!];
  claude.script('claude/usage-limit');
  codex.script('codex/reply');
  const claudeBot = s.storeBot('Claudia', 'claude-cli');
  const codexBot = s.storeBot('Cody', 'codex-cli');
  const routine = app.store.createRoutine(claudeBot.id, { name: 'Morning brief', instruction: 'Brief me', schedule: 'every 1h' });

  app.engine.sendMessage(claudeBot.id, 'hello');
  await until(() => s.notices(claudeBot.id).length === 1);
  assert.match(s.notices(claudeBot.id)[0].text, /^Claude usage limit reached; continuing/);
  assert.equal(claude.calls().length, 1);

  assert.equal(s.fireSlot(routine), null);
  const runs = app.store.listRuns(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'skipped');
  assert.match(runs[0].error ?? '', /^Claude usage limit until \w{3} \d{1,2}:\d{2} [AP]M$/);
  await sleep(200);
  assert.equal(claude.calls().length, 1);
  assert.deepEqual(s.errors(claudeBot.id), []);

  app.engine.sendMessage(codexBot.id, 'ping');
  const reply = await until(() => s.messages(codexBot.id).find((m) => m.role === 'bot'));
  assert.equal(reply.text, 'pong');
  assert.equal(codex.calls().length, 1);
});

test('a scheduled run that fails twice on a network error succeeds on attempt 3, with no error in the chat', async () => {
  const s = await start();
  const bot = s.storeBot('Stuart');
  const routine = s.app.store.createRoutine(bot.id, { name: 'Nightly', instruction: 'Do the nightly job', schedule: 'every 1h' });
  s.mock.failNext(bot.id, transient(), transient());

  const done = await s.untilRun(s.fireSlot(routine)!.id, 'succeeded');
  assert.equal(done.attempts, 3);
  assert.equal(done.lastError, 'API Error: Connection error.');
  assert.equal(s.turnsOf(bot.id).length, 3);
  assert.deepEqual(s.errors(bot.id), []);
  // One chip, when the run ends, naming the attempt it ended on.
  const chips = s.messages(bot.id).filter((m) => m.meta?.kind === 'routine.run');
  assert.deepEqual(chips.map((m) => [m.text, m.meta?.attempt]), [['Retried routine (attempt 3)', 3]]);
  assert.match(s.turnsOf(bot.id)[2].prompt, /This is attempt 3\. The previous attempt failed \(API Error: Connection error\.\)/);
});

test('when every attempt fails one error is posted; auth errors and manual runs are not retried; nor is a run whose next slot comes first', async () => {
  const s = await start({ env: { BOTONS_RUN_RETRIES: '2' } });
  const { app, mock } = s;
  const bot = s.storeBot('Dave');
  const routine = app.store.createRoutine(bot.id, { name: 'Sync', instruction: 'Sync it', schedule: 'every 1h', webhook: true });

  // Webhook runs are retried too: 1 + 2 retries, then one error.
  mock.failNext(bot.id, transient(), transient(), transient());
  const failed = await s.untilRun(app.engine.triggerRoutine(routine.id, 'webhook', '{"x":1}').id, 'failed');
  assert.equal(failed.attempts, 3);
  assert.equal(failed.error, 'API Error: Connection error.');
  assert.equal(s.errors(bot.id).length, 1);
  assert.match(s.errors(bot.id)[0].text, /^Routine “Sync” failed after 3 attempts: API Error: Connection error\.$/);

  // Not retried: a login error, a manual run (whoever started it is there), a run whose next slot would come first.
  mock.failNext(bot.id, authError());
  assert.equal((await s.untilRun(s.fireSlot(routine)!.id, 'failed')).attempts, 1);
  assert.equal(s.errors(bot.id).length, 2);

  mock.failNext(bot.id, transient());
  assert.equal((await s.untilRun(app.engine.triggerRoutine(routine.id, 'manual').id, 'failed')).attempts, 1);
  assert.equal(s.errors(bot.id).length, 3);

  mock.failNext(bot.id, transient());
  const scheduled = s.fireSlot(routine)!;
  app.store.db.prepare('update routines set next_run_at = ? where id = ?').run(new Date(Date.now() + 20).toISOString(), routine.id);
  assert.equal((await s.untilRun(scheduled.id, 'failed')).attempts, 1);
  assert.equal(s.turnsOf(bot.id).length, 3 + 1 + 1 + 1);
});

test('a run that hits the usage limit is not retried on the network schedule: it waits for the reset, across a restart too', async () => {
  const first = await start();
  const bot = first.storeBot('Phil');
  const routine = first.app.store.createRoutine(bot.id, { name: 'Report', instruction: 'Write the report', webhook: true });
  const reset = Date.now() + 1500;
  first.mock.failNext(bot.id, new ProviderError("You've hit your limit", false, { kind: 'usage_limit', retryAt: new Date(reset) }));
  const run = first.app.engine.triggerRoutine(routine.id, 'webhook');
  const held = await until(() => {
    const r = first.app.store.findRun(run.id);
    return r?.status === 'queued' && r.retryAt ? r : null;
  });
  assert.equal(held.retryAt, new Date(reset).toISOString());
  assert.equal(held.lastError, "You've hit your limit");
  assert.equal(held.attempts, 1);
  // A message for the same provider waits too.
  first.app.engine.sendMessage(bot.id, 'status?');
  await sleep(100);
  assert.equal(first.turnsOf(bot.id).length, 1);
  assert.equal(first.notices(bot.id).length, 1);
  assert.deepEqual(first.errors(bot.id), []);
  await first.stop();

  // The next server keeps waiting, then does both.
  const second = await start({ home: first.home });
  await sleep(200);
  assert.ok(Date.now() < reset, 'the test took too long to check the wait');
  assert.equal(second.mock.turns.length, 0);
  assert.equal(second.app.store.findRun(run.id)!.status, 'queued');
  const done = await second.untilRun(run.id, 'succeeded', 5000);
  assert.ok(Date.parse(done.finishedAt!) >= reset);
  assert.equal(done.attempts, 2);
  await until(() => second.messages(bot.id).some((m) => m.role === 'bot' && m.text.includes('status?')));
  assert.deepEqual(second.errors(bot.id), []);
  assert.equal(second.app.store.cooldowns().length, 0);
});

test('a full queue waiting out a usage limit says to come back after the reset', async () => {
  const s = await start();
  const { app } = s;
  const bot = s.storeBot('Mel');
  const routine = app.store.createRoutine(bot.id, { name: 'Hook', instruction: 'Handle it', webhook: true });
  s.mock.failNext(bot.id, usageLimit(10 * 60_000));
  app.engine.sendMessage(bot.id, 'hi');
  await until(() => s.notices(bot.id).length === 1);
  for (let i = 0; i < 3; i++) app.engine.triggerRoutine(routine.id, 'webhook');
  await until(() => app.store.queuedRuns(bot.id).every((r) => r.retryAt));
  assert.throws(
    () => app.engine.triggerRoutine(routine.id, 'webhook'),
    (err: { status?: number; headers?: Record<string, string> }) => err.status === 429 && Number(err.headers?.['retry-after']) > 500,
  );
});

test('a one-off that fails on a network error is tried again, though firing it retired the routine', async () => {
  const s = await start();
  const bot = s.storeBot('Otto');
  const routine = s.app.store.createRoutine(bot.id, { name: 'Remind', instruction: 'Remind me', schedule: 'in 1h' });
  s.mock.failNext(bot.id, transient());
  s.fireOneOff(routine);
  assert.equal(s.app.store.getRoutine(routine.id).enabled, false);
  const done = await s.untilRun(s.app.store.listRuns(routine.id)[0].id);
  assert.equal(done.status, 'succeeded', done.error ?? '');
  assert.equal(done.attempts, 2);
  assert.deepEqual(s.errors(bot.id), []);
});

test('a run whose own turn hits the usage limit runs after the reset, though firing the one-off retired it, or its routine is paused (Run now)', async () => {
  const s = await start();
  const { app } = s;
  const bot = s.storeBot('Bob');
  const remind = app.store.createRoutine(bot.id, { name: 'Remind', instruction: 'Remind me', schedule: 'in 1h' });
  const report = app.store.createRoutine(bot.id, { name: 'Report', instruction: 'Write the report', schedule: 'every 1h' });
  app.store.updateRoutine(report.id, { enabled: false });
  const runs = [
    () => (s.fireOneOff(remind), app.store.listRuns(remind.id)[0]),
    () => app.engine.triggerRoutine(report.id, 'manual'),
  ];
  for (const runOne of runs) {
    const reset = Date.now() + 600;
    s.mock.failNext(bot.id, usageLimit(600));
    const done = await s.untilRun(runOne().id);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.ok(Date.parse(done.finishedAt!) >= reset);
    assert.equal(done.attempts, 2);
  }
  assert.deepEqual(s.errors(bot.id), []);
});

test('a network retry is dropped once the owner pauses the routine', async () => {
  const s = await start({ env: { BOTONS_RUN_RETRY_DELAY: '1s' } });
  const bot = s.storeBot('Norbert');
  const routine = s.app.store.createRoutine(bot.id, { name: 'Nightly', instruction: 'Do the nightly job', schedule: 'every 1h' });
  s.mock.failNext(bot.id, transient());
  const run = s.fireSlot(routine)!;
  await until(() => s.app.store.findRun(run.id)?.retryAt);
  s.app.store.updateRoutine(routine.id, { enabled: false });
  assert.equal((await s.untilRun(run.id, 'failed', 4000)).attempts, 1);
  assert.equal(s.turnsOf(bot.id).length, 1);
  assert.match(s.errors(bot.id)[0]?.text ?? '', /^Routine “Nightly” failed: API Error: Connection error\. \(not tried again: the routine was paused\)$/);
});

test('a usage limit whose reset has already passed waits a minute instead of running the turn again at once', async () => {
  const s = await start();
  const bot = s.storeBot('Gru');
  const before = Date.now();
  s.mock.failNext(bot.id, usageLimit(-120_000));
  s.app.engine.sendMessage(bot.id, 'hello');
  await until(() => s.notices(bot.id).length === 1);
  const retryAt = Date.parse(String(s.notices(bot.id)[0].meta?.retryAt));
  assert.ok(retryAt >= before + MIN_COOLDOWN_MS, new Date(retryAt).toISOString());
  await sleep(300);
  assert.equal(s.turnsOf(bot.id).length, 1);
  assert.equal(s.pending(), 1);
});

test('a one-off that comes due during a usage limit or while its routine is still running waits instead of being skipped', async () => {
  const s = await start();
  const { app } = s;
  const bot = s.storeBot('Lucy');
  const reset = Date.now() + 800;
  s.mock.failNext(bot.id, usageLimit(800));
  app.engine.sendMessage(bot.id, 'hi');
  await until(() => s.notices(bot.id).length === 1);
  const remind = app.store.createRoutine(bot.id, { name: 'Remind', instruction: 'Remind me', schedule: 'in 1h' });
  s.fireOneOff(remind);
  const [held] = app.store.listRuns(remind.id);
  assert.equal(held.status, 'queued');
  assert.ok(Date.parse((await s.untilRun(held.id, 'succeeded', 4000)).finishedAt!) >= reset);

  // A Run now of the same routine is still running: the one-off runs after it.
  const other = app.store.createRoutine(bot.id, { name: 'Later', instruction: 'SLOW_PLEASE:400', schedule: 'in 1h' });
  const manual = app.engine.triggerRoutine(other.id, 'manual');
  await s.untilRun(manual.id, 'running');
  s.fireOneOff(other);
  const runs = app.store.listRuns(other.id);
  assert.deepEqual(runs.map((r) => [r.trigger, r.status]), [['schedule', 'queued'], ['manual', 'running']]);
  await s.untilRun(runs[0].id, 'succeeded', 4000);
  assert.deepEqual(s.errors(bot.id), []);
});

test('a Boton moved to another provider during a usage limit carries on with what it held, on the new one', async () => {
  const s = await start({ fakeClis: true });
  const [app, claude] = [s.app, s.claude!];
  claude.script('claude/usage-limit');
  const bot = s.storeBot('Kevin', 'claude-cli');
  const routine = app.store.createRoutine(bot.id, { name: 'Hook', instruction: 'Handle it', webhook: true });
  app.engine.sendMessage(bot.id, 'hello');
  await until(() => s.notices(bot.id).length === 1);
  const run = app.engine.triggerRoutine(routine.id, 'webhook');
  await until(() => app.store.findRun(run.id)?.retryAt);
  assert.equal(claude.calls().length, 1);

  await app.engine.updateBot(bot.id, { provider: 'mock' }, app.providers.ids());
  assert.ok(await until(() => s.messages(bot.id).find((m) => m.role === 'bot' && m.text.includes('hello'))));
  await s.untilRun(run.id, 'succeeded');
  assert.equal(s.turnsOf(bot.id).length, 2);
  assert.equal(claude.calls().length, 1);
  assert.deepEqual(s.errors(bot.id), []);
});

test('a retried run pushes only when it fails for good: once, after its last attempt; a run that succeeds on a retry pushes nothing', async (t) => {
  const pushes: { message: string; priority: number }[] = [];
  const ntfy = createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8').on('data', (d: string) => (data += d));
    req.on('end', () => {
      pushes.push(JSON.parse(data));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => ntfy.close(r)));
  const s = await start({ env: { BOTONS_RUN_RETRIES: '2' } });
  const { app, mock } = s;
  app.store.updateSettings({ ntfy: { enabled: true, server: `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}`, topic: 'usage-test', preview: true } });
  const bot = s.storeBot('Otto');
  const routine = app.store.createRoutine(bot.id, { name: 'Sync', instruction: 'Sync it', webhook: true });

  // Fails once, then succeeds: no push.
  mock.failNext(bot.id, transient());
  const recovered = app.engine.triggerRoutine(routine.id, 'webhook');
  await s.untilRun(recovered.id, 'succeeded');
  await sleep(200);
  assert.equal(pushes.length, 0);

  // Fails on every attempt: one high-priority push, after the last one.
  mock.failNext(bot.id, transient(), transient(), transient());
  const failed = app.engine.triggerRoutine(routine.id, 'webhook');
  const done = await until(() => {
    const r = app.store.findRun(failed.id);
    return r?.status === 'failed' && r.meta?.notifications?.length ? r : null;
  });
  await sleep(200);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].priority, 4);
  assert.match(pushes[0].message, /^“Sync” failed after 3 attempts: API Error: Connection error\./);
  assert.deepEqual(
    done.meta!.notifications!.map((d) => [d.reason, d.ok]),
    [['failure', true]],
  );
  const chat = s.messages(bot.id).filter((m) => m.meta?.runId === recovered.id || m.meta?.runId === failed.id);
  assert.deepEqual(
    chat.map((m) => [m.role, m.text.split(':')[0]]),
    [
      ['event', 'Retried routine (attempt 2)'],
      ['bot', 'Echo'],
      ['event', 'Retried routine (attempt 3)'],
      ['error', 'Routine “Sync” failed after 3 attempts'],
    ],
  );
});
