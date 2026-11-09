import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CallbackDelivery, RoutineRun } from '../../shared/types.ts';
import type { Config } from '../src/config.ts';
import { startServer, tempDir, until } from './helpers.ts';

const ENV = { BOTONS_CALLBACK_ALLOW: '127.0.0.1' };
const configure = (cfg: Config) => {
  cfg.callbacks.timeoutMs = 30_000;
  cfg.callbacks.retryDelaysMs = [20, 20, 20];
};

const receivers: Server[] = [];
after(() => {
  for (const r of receivers) {
    r.closeAllConnections();
    r.close();
  }
});
/** A results receiver on loopback that holds every request open until `answering` is set. */
async function receiver() {
  const got: { headers: IncomingMessage['headers']; body: string }[] = [];
  const state = { answering: false };
  const server = createServer((req, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8').on('data', (d: string) => (body += d));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      if (state.answering) res.writeHead(200).end('ok');
    });
  });
  receivers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/results`, got, state };
}

const callbackIn = (home: string, runId: string): CallbackDelivery | undefined => {
  const db = new DatabaseSync(join(home, 'botons.db'));
  try {
    const row = db.prepare('select meta from routine_runs where id = ?').get(runId) as { meta: string | null } | undefined;
    return row?.meta ? JSON.parse(row.meta).callback : undefined;
  } finally {
    db.close();
  }
};

test('a callback cut off by a crash is sent again at the next start, with the same body and signature', { timeout: 20_000 }, async () => {
  const fake = await receiver();
  const s = await startServer({ env: ENV, configure });
  const bot = await s.newBot('Kevin');
  const routine = await s.newRoutine(bot.id, { name: 'Deploys', webhook: true, callbackUrl: fake.url });
  const { runId } = await (await s.hook(routine, '', { body: '{"deploy":"v2"}' })).json();
  await until(() => fake.got.length === 1);
  const pending = (await s.runsOf(routine.id)).find((r) => r.id === runId)!;
  assert.equal(pending.status, 'succeeded');
  assert.equal(pending.meta?.callback?.pending, true, 'marked pending before the POST');
  assert.equal(pending.meta?.callback?.url, fake.url);

  // What the disk holds at the moment of a crash: the run finished, its callback pending.
  const crashed = tempDir('botons-cb-crash-');
  cpSync(s.home, crashed, { recursive: true, filter: (p) => !/botons\.db/.test(p) });
  s.app.store.db.exec(`vacuum into '${join(crashed, 'botons.db')}'`);
  await s.stop();

  fake.state.answering = true;
  const again = await startServer({ home: crashed, token: s.token, env: ENV, configure });
  const sent = await until(async () => (await again.runsOf(routine.id)).find((r) => r.id === runId && r.meta?.callback && !r.meta.callback.pending)?.meta!.callback);
  assert.deepEqual([sent.ok, sent.status, sent.attempts, sent.url], [true, 200, 1, fake.url]);
  assert.equal(fake.got.length, 2);
  assert.equal(fake.got[1].body, fake.got[0].body, 'the same result');
  assert.equal(fake.got[1].headers['x-boton-signature'], fake.got[0].headers['x-boton-signature']);
  assert.equal(fake.got[1].headers['x-boton-run'], runId, 'the receiver can tell it is the same run');
  await again.stop();
});

test('stopping mid-send leaves the callback pending; the next start sends it, or records why it cannot', { timeout: 20_000 }, async () => {
  const fake = await receiver();
  const home = tempDir('botons-cb-stop-');
  const s = await startServer({ home, env: ENV, configure });
  const bot = await s.newBot('Stuart');
  const kept = await s.newRoutine(bot.id, { name: 'Kept', webhook: true, callbackUrl: fake.url });
  const dropped = await s.newRoutine(bot.id, { name: 'Dropped', webhook: true, callbackUrl: fake.url });
  const run = async (routineId: string) => (await s.call<RoutineRun>('POST', `/api/routines/${routineId}/run`)).data;
  const a = await run(kept.id);
  await until(() => fake.got.length === 1);
  const b = await run(dropped.id);
  await until(() => fake.got.length === 2);
  await s.stop();
  assert.equal(callbackIn(home, a.id)?.pending, true);
  assert.equal(callbackIn(home, b.id)?.pending, true);

  // While the server is down, the owner's routine loses its callback URL.
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.prepare('update routines set callback_url = null where id = ?').run(dropped.id);
  db.close();

  fake.state.answering = true;
  const again = await startServer({ home, token: s.token, env: ENV, configure });
  const done = (routineId: string, runId: string) =>
    until(async () => (await again.runsOf(routineId)).find((r) => r.id === runId && r.meta?.callback && !r.meta.callback.pending)?.meta!.callback);
  const sent = await done(kept.id, a.id);
  assert.deepEqual([sent.ok, sent.status], [true, 200]);
  const notSent = await done(dropped.id, b.id);
  assert.deepEqual([notSent.ok, notSent.attempts], [false, 0]);
  assert.match(notSent.error!, /no longer has a callback URL/);
  assert.equal(fake.got.length, 3, 'only the routine that still has a callback URL is sent again');
  assert.equal(fake.got[2].headers['x-boton-run'], a.id);
  // Not offered for a resend: there is nowhere to send it.
  assert.deepEqual((await again.call('GET', '/api/runs/attention')).data.callbacks, []);
  await again.stop();
});

/** Copies the server's database as it is now, as a crash would leave it on disk. */
function snapshot(s: { home: string; app: { store: { db: DatabaseSync } } }, prefix: string): string {
  const dir = tempDir(prefix);
  cpSync(s.home, dir, { recursive: true, filter: (p) => !/botons\.db/.test(p) });
  s.app.store.db.exec(`vacuum into '${join(dir, 'botons.db')}'`);
  return dir;
}

test('a crash right after a run finishes, before any listener hears of it, still sends its callback at the next start', { timeout: 20_000 }, async () => {
  const fake = await receiver();
  fake.state.answering = true;
  const s = await startServer({ env: ENV, configure });
  const bot = await s.newBot('Bob');
  const routine = await s.newRoutine(bot.id, { name: 'Builds', webhook: true, callbackUrl: fake.url });
  // The first moment the finished run is visible outside the store: its commit is done, no listener has run yet.
  let crashed: string | null = null;
  let seen: RoutineRun | null = null;
  const publish = s.app.hub.publish.bind(s.app.hub);
  s.app.hub.publish = (ev) => {
    if (!crashed && ev.type === 'run.upserted' && ev.run.routineId === routine.id && ev.run.status === 'succeeded') {
      seen = ev.run;
      crashed = snapshot(s, 'botons-cb-boundary-');
    }
    publish(ev);
  };
  const run = (await s.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
  await until(() => crashed !== null && fake.got.length === 1);
  assert.equal(seen!.meta?.callback?.pending, true, 'the finishing write itself carries the pending callback');
  assert.equal(callbackIn(crashed!, run.id)?.pending, true, 'on disk at the crash');
  await s.stop();

  const again = await startServer({ home: crashed!, token: s.token, env: ENV, configure });
  const sent = await until(async () => (await again.runsOf(routine.id)).find((r) => r.id === run.id && r.meta?.callback && !r.meta.callback.pending)?.meta!.callback);
  assert.deepEqual([sent.ok, sent.status], [true, 200]);
  assert.equal(fake.got.length, 2);
  assert.equal(fake.got[1].headers['x-boton-run'], run.id);
  await again.stop();
});

test('a finished run is published once, already pending: no later event shows it without its callback', { timeout: 20_000 }, async () => {
  const fake = await receiver();
  fake.state.answering = true;
  const s = await startServer({ env: ENV, configure });
  const bot = await s.newBot('Dave');
  const routine = await s.newRoutine(bot.id, { name: 'Reports', webhook: true, callbackUrl: fake.url });
  // Subscribed after Callbacks, like the SSE streams the web app listens on.
  const events: RoutineRun[] = [];
  s.app.hub.subscribe((ev) => {
    if (ev.type === 'run.upserted' && ev.run.routineId === routine.id) events.push(ev.run);
  });
  const run = (await s.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
  await until(() => events.some((r) => r.id === run.id && r.meta?.callback?.ok));
  const finished = events.filter((r) => r.id === run.id && r.status === 'succeeded');
  assert.ok(finished.every((r) => r.meta?.callback), 'never finished without its callback');
  assert.deepEqual(
    finished.map((r) => (r.meta!.callback!.pending ? 'pending' : r.meta!.callback!.ok ? 'sent' : 'failed')),
    ['pending', 'sent'],
    'in order, the last one the outcome',
  );
  await s.stop();
});

test('pending callbacks outlive run history pruning, and past the limit a result is recorded as not sent, to resend', { timeout: 60_000 }, async () => {
  const { PENDING_CALLBACK_LIMIT } = await import('../src/store.ts');
  const fake = await receiver(); // never answers: every callback stays pending
  const home = tempDir('botons-cb-backlog-');
  const s = await startServer({ home, env: { ...ENV, BOTONS_ROUTINE_RUNS_PER_HOUR: '1000', BOTONS_RUNS_PER_HOUR: '1000' }, configure });
  const bot = await s.newBot('Kevin');
  const routine = await s.newRoutine(bot.id, { name: 'Busy', webhook: true, callbackUrl: fake.url });
  const total = PENDING_CALLBACK_LIMIT + 5;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    const run = (await s.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
    ids.push(run.id);
    await until(async () => (await s.runsOf(routine.id)).find((r) => r.id === run.id && r.meta?.callback));
  }
  const runs = await s.runsOf(routine.id);
  const byId = new Map(runs.map((r) => [r.id, r]));
  // More finished runs than the run history keeps, yet none still owed to the receiver was pruned.
  const pending = ids.filter((id) => byId.get(id)?.meta?.callback?.pending);
  assert.deepEqual(pending, ids.slice(0, PENDING_CALLBACK_LIMIT), 'the first ones, all still there, all pending');
  const over = ids.slice(PENDING_CALLBACK_LIMIT).map((id) => byId.get(id)!.meta!.callback!);
  for (const d of over) {
    assert.deepEqual([d.ok, d.pending, d.attempts], [false, undefined, 0]);
    assert.match(d.error!, new RegExp(`Not sent: ${PENDING_CALLBACK_LIMIT} earlier results were still waiting`));
  }
  // Not silent: listed to resend, and a resend is refused until the backlog drains.
  const listed = (await s.call<{ callbacks: RoutineRun[] }>('GET', '/api/runs/attention')).data.callbacks.map((r) => r.id);
  assert.deepEqual(listed.sort(), ids.slice(PENDING_CALLBACK_LIMIT).sort());
  const refused = await s.call<{ error: string }>('POST', `/api/runs/${ids.at(-1)}/callback`);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /already waiting for this callback URL/);
  await s.stop();
  // The backlog survives the stop, every pending one at most the limit.
  assert.equal(ids.filter((id) => callbackIn(home, id)?.pending).length, PENDING_CALLBACK_LIMIT);
});
