import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import type { Bot, Routine, RoutineRun, RunStatus, ServerEvent } from '../../shared/types.ts';
import { captureLogs } from '../src/log.ts';
import { failOnEscapedErrors, startServer, until } from './helpers.ts';

const s = await startServer({ env: { BOTONS_SCHEDULER_MS: '200' } });
const { app, base, token, call } = s;
failOnEscapedErrors();
const crashSafe = { timeout: 20_000 };

const runWith = (routineId: string, status: RunStatus) => until(async () => (await s.runsOf(routineId)).find((r) => r.status === status));

async function slowWebhookRoutine(botName: string, instruction = 'SLOW_PLEASE'): Promise<{ bot: Bot; routine: Routine }> {
  const bot = await s.newBot(botName);
  return { bot, routine: await s.newRoutine(bot.id, { name: 'Slow job', instruction, webhook: true }) };
}

/** For request targets fetch() would refuse or normalize. */
function rawStatus(requestLine: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(s.port, '127.0.0.1', () => sock.write(`${requestLine}\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => (data += d));
    sock.on('end', () => resolve(Number(data.split(' ')[1])));
    sock.on('error', reject);
  });
}

function noRunErrorsAnywhere(): number {
  return (app.store.db.prepare("select count(*) as n from messages where text like '%No run with id%'").get() as { n: number }).n;
}

test('create a Boton, chat, routine via schedule and webhook; a failed turn posts an error', async () => {
  const bot = await s.newBot('Kevin');
  assert.equal(bot.provider, 'mock');

  await s.send(bot.id, 'hello');
  const reply = await until(async () => (await s.messagesOf(bot.id)).find((m) => m.role === 'bot'));
  assert.match(reply.text, /Echo: hello/);

  const routine = await s.newRoutine(bot.id, { name: 'Ping', instruction: 'Say pong', schedule: 'every 1m', webhook: true });
  assert.equal(routine.scheduleText, 'Every minute');
  assert.ok(routine.webhook?.key);

  assert.equal((await s.hook(routine, '', { headers: { authorization: 'Bearer nope' } })).status, 401);
  const res = await s.hook(routine, 'wait=1', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ issue: 42 }) });
  const out = await res.json();
  assert.equal(out.status, 'succeeded');
  assert.match(out.reply, /"issue": 42/);

  app.store.db.prepare('update routines set next_run_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), routine.id);
  const runs = await until(async () => {
    const data = await s.runsOf(routine.id);
    return data.some((r) => r.trigger === 'schedule' && r.status === 'succeeded') && data;
  });
  assert.ok(runs.length >= 2);

  await call('PATCH', `/api/routines/${routine.id}`, { enabled: false });
  assert.equal((await s.hook(routine)).status, 409);

  const kinds = (await s.messagesOf(bot.id)).filter((m) => m.role === 'event').map((m) => m.meta?.kind);
  for (const kind of ['routine.created', 'routine.run', 'routine.paused'] as const) assert.ok(kinds.includes(kind), kind);

  await s.send(bot.id, 'FAIL_PLEASE');
  const err = await until(async () => (await s.messagesOf(bot.id)).find((m) => m.role === 'error'));
  assert.match(err.text, /Mock failure/);
});

test('starting fresh while a turn runs stays fresh', async () => {
  const bot = await s.newBot('Dave');
  await s.send(bot.id, 'hello');
  await until(async () => (await s.messagesOf(bot.id)).some((m) => m.role === 'bot'));
  const session = app.store.getBot(bot.id).sessionId;
  assert.ok(session);

  await s.send(bot.id, 'remember the apples SLOW_PLEASE:600');
  await s.untilState(bot.id, 'working');
  assert.equal(s.mock.turns.at(-1)!.sessionId, session);
  assert.equal((await call('POST', `/api/bots/${bot.id}/reset`)).status, 200);
  await s.untilState(bot.id, 'idle');
  // The old turn's reply is posted, but its session is not kept.
  assert.ok((await s.messagesOf(bot.id)).some((m) => m.role === 'bot' && m.text.includes('apples')));
  assert.equal(app.store.getBot(bot.id).sessionId, null);

  await s.send(bot.id, 'what fruit?');
  await until(async () => (await s.messagesOf(bot.id)).filter((m) => m.role === 'bot').length === 3);
  const next = s.mock.turns.at(-1)!;
  assert.equal(next.sessionId, null);
  assert.ok(next.prompt.includes('what fruit?'));
  // Nothing from before the reset is replayed, not even the reply that came after it.
  assert.ok(!next.prompt.includes('hello'), next.prompt);
  assert.ok(!next.prompt.includes('apples'), next.prompt);
});

test('a message sent after starting fresh, before the old turn replies, stays in the fresh conversation', async () => {
  const bot = await s.newBot('Carl');
  await s.send(bot.id, 'remember the apples SLOW_PLEASE:1500');
  await s.untilState(bot.id, 'working');
  assert.equal((await call('POST', `/api/bots/${bot.id}/reset`)).status, 200);
  const { data: pears } = await s.send(bot.id, 'note the pears');
  await until(async () => (await s.messagesOf(bot.id)).filter((m) => m.role === 'bot').length === 2);
  await s.untilState(bot.id, 'idle');

  const msgs = await s.messagesOf(bot.id);
  const old = msgs.find((m) => m.role === 'bot' && m.text.includes('apples'))!;
  const fresh = msgs.find((m) => m.role === 'bot' && m.text.includes('pears'))!;
  assert.ok(pears.createdAt < old.createdAt, `${pears.createdAt} should be before ${old.createdAt}`);
  assert.equal(old.meta?.staleContext, true);
  assert.equal(fresh.meta?.staleContext, undefined);

  // A new session (the instructions changed) replays only the fresh conversation.
  await call('PATCH', `/api/bots/${bot.id}`, { instructions: 'Grow fruit.' });
  await s.send(bot.id, 'what fruit?');
  await until(async () => (await s.messagesOf(bot.id)).filter((m) => m.role === 'bot').length === 3);
  const next = s.mock.turns.at(-1)!;
  assert.equal(next.sessionId, null);
  const replay = next.prompt.split('</conversation_so_far>')[0];
  assert.ok(replay.includes(`${app.store.getSettings().ownerName}: note the pears`), next.prompt);
  assert.ok(replay.includes('You: Echo: note the pears'), next.prompt);
  assert.ok(!replay.includes('apples'), next.prompt);
});

test('rejects cross-site and non-JSON mutations, even with a device token, and foreign Host names', async () => {
  const authorization = `Bearer ${token}`;
  const post = async (headers: Record<string, string>) => {
    const res = await fetch(`${base}/api/bots`, { method: 'POST', headers: { authorization, ...headers }, body: '{"name":"Csrf","provider":"mock"}' });
    return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? '' };
  };
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  // A page may send these with no CORS preflight.
  for (const ct of ['text/plain; x=application/json', 'text/plain;application/json', 'application/jsonx', 'application/json-patch+json', 'multipart/form-data; boundary=application/json']) {
    const r = await post({ 'content-type': ct });
    assert.equal(r.status, 403, ct);
    assert.match(r.error, /Content-Type: application\/json/, ct);
  }
  const opaque = await post({ 'content-type': 'application/json', origin: 'null' });
  assert.equal(opaque.status, 403);
  assert.match(opaque.error, /opaque origin/);
  for (const site of ['same-site', 'cross-site', 'none']) {
    const r = await post({ 'content-type': 'application/json', 'sec-fetch-site': site });
    assert.equal(r.status, 403, site);
    assert.match(r.error, /Cross-site/, site);
  }
  // What the web app and a native client (no Sec-Fetch-Site) send.
  assert.equal((await post({ 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin', origin: base })).status, 201);
  assert.equal((await post({ 'content-type': 'Application/JSON' })).status, 201);
  // Reads aren't held to it (an <img> of a workspace file).
  assert.equal((await fetch(`${base}/api/bots`, { headers: { authorization, 'sec-fetch-site': 'same-site' } })).status, 200);
  // DNS rebinding; fetch() drops custom Host headers.
  const status = await new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port: s.port, path: '/api/bots', headers: { host: 'rebind.evil.example', authorization } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
  assert.equal(status, 403);
});

test('validates input; schedule preview: an unknown or empty timezone is an error, a missing one means the default', async () => {
  assert.equal((await call('POST', '/api/bots', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/bots', { name: 'x', provider: 'nope' })).status, 400);
  const bot = await s.newBot('Bob');
  const bad = await call<{ error: string }>('POST', `/api/bots/${bot.id}/routines`, { name: 'x', instruction: 'y', schedule: 'sometimes' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Couldn't understand/);

  type Preview = { ok: boolean; error: string | null; text: string | null; nextRuns: string[] };
  const preview = (body: unknown) => call<Preview>('POST', '/api/schedule/preview', body);

  let res = await preview({ schedule: 'weekdays at 8am', timezone: 'America/New_Yrok' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: false, error: 'Unknown timezone America/New_Yrok', schedule: null, text: null, nextRuns: [] });
  assert.equal((await preview({ schedule: 'weekdays at 8am', timezone: '' })).data.error, 'Timezone is empty');
  assert.equal((await preview({ schedule: 'weekdays at 8am', timezone: 42 })).data.ok, false);

  res = await preview({ schedule: 'weekdays at 8am', timezone: 'Asia/Tokyo' });
  assert.equal(res.data.ok, true);
  assert.equal(res.data.nextRuns.length, 3);
  // 8:00 in Tokyo is 23:00 UTC the day before.
  assert.ok(res.data.nextRuns.every((iso) => new Date(iso).getUTCHours() === 23));

  const fallback = await preview({ schedule: 'weekdays at 8am' });
  assert.equal(fallback.data.ok, true);
  assert.equal(fallback.data.nextRuns.length, 3);
});

test('unread counts replies and errors after the read marker; POST /read clears it and tells every client', crashSafe, async () => {
  const events: ServerEvent[] = [];
  const unsubscribe = app.hub.subscribe((e) => events.push(e));
  try {
    const a = await s.newBot('Reader A');
    const b = await s.newBot('Reader B');
    assert.equal(b.unread, 0);
    const unreadOf = async (id: string) => (await call<Bot>('GET', `/api/bots/${id}`)).data.unread;
    const lastPublished = (id: string) => events.findLast((e): e is Extract<ServerEvent, { type: 'bot.upserted' }> => e.type === 'bot.upserted' && e.bot.id === id)?.bot;

    // A routine result for B is one unread, and the bot.upserted with it says so; its chips don't count.
    await s.send(a.id, 'hello A');
    await s.untilState(a.id, 'idle');
    const routine = await s.newRoutine(b.id, { name: 'Ping', instruction: 'Say hi' });
    await call('POST', `/api/routines/${routine.id}/run`);
    await runWith(routine.id, 'succeeded');
    assert.equal(await unreadOf(b.id), 1);
    assert.equal(lastPublished(b.id)?.unread, 1);
    assert.ok((await s.messagesOf(b.id)).filter((m) => m.role === 'event').length >= 2);
    assert.equal(await unreadOf(a.id), 1, "A's own reply is unread on A, and B's result doesn't touch it");

    // Owner messages don't count; an error does.
    await s.send(b.id, 'FAIL_PLEASE');
    await s.untilState(b.id, 'idle');
    assert.equal(await unreadOf(b.id), 2);

    const firstReply = (await s.messagesOf(b.id)).find((m) => m.role === 'bot')!;
    let res = await call<Bot>('POST', `/api/bots/${b.id}/read`, { upTo: firstReply.id });
    assert.equal(res.status, 200);
    assert.equal(res.data.unread, 1);
    res = await call<Bot>('POST', `/api/bots/${b.id}/read`);
    assert.equal(res.data.unread, 0);
    assert.equal(lastPublished(b.id)?.unread, 0, 'other devices hear about it');
    assert.equal(await unreadOf(a.id), 1);

    // The marker never moves back, and reading again publishes nothing new.
    const published = events.length;
    res = await call<Bot>('POST', `/api/bots/${b.id}/read`, { upTo: firstReply.id });
    assert.equal(res.data.unread, 0);
    assert.equal(events.length, published);

    const aMessage = (await s.messagesOf(a.id))[0];
    assert.equal((await call('POST', `/api/bots/${b.id}/read`, { upTo: aMessage.id })).status, 400);
    assert.equal((await call('POST', `/api/bots/${b.id}/read`, { upTo: 7 })).status, 400);
    assert.equal((await call('POST', '/api/bots/bot_nope/read')).status, 404);
  } finally {
    unsubscribe();
  }
});

test('malformed URLs get 400 and the server keeps serving', crashSafe, async () => {
  for (const [method, path] of [
    ['GET', '/%E0'],
    ['GET', '/assets/%E0.js'],
    ['GET', '/api/bots/%E0'],
    ['GET', '/api/%E0'],
    ['POST', '/hooks/routines/%E0'],
  ]) {
    const res = await fetch(base + path, { method });
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.match((await res.json()).error, /Malformed/);
  }
  // A request target new URL() itself rejects.
  assert.equal(await rawStatus('GET //[ HTTP/1.1'), 400);
  assert.equal((await call('GET', '/api/health')).status, 200);
  const page = await fetch(`${base}/some/client/route`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Botons test/);
});

test('deleting a routine or its Boton ends a webhook wait on its running run', crashSafe, async () => {
  for (const [what, path] of [
    ['Routine', (_: Bot, r: Routine) => `/api/routines/${r.id}`],
    ['Boton', (b: Bot) => `/api/bots/${b.id}`],
  ] as const) {
    // The turn outlives the 2 s wait.
    const { bot, routine } = await slowWebhookRoutine(what, 'SLOW_PLEASE:2500');
    const started = Date.now();
    const pending = s.hook(routine, 'wait=1&timeout=2');
    const run = await runWith(routine.id, 'running');
    assert.equal((await call('DELETE', path(bot, routine))).status, 200);

    const res = await pending;
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { ok: false, runId: run.id, status: 'failed', reply: null, error: `${what} was deleted` });
    assert.ok(Date.now() - started < 2000, 'the delete ended the wait, not the timeout');
    assert.equal((await call('GET', '/api/health')).status, 200);
    if (what === 'Routine') {
      // Its turn still finishes, with its reply and no false "No run with id" error.
      const reply = await until(async () => (await s.messagesOf(bot.id)).find((m) => m.role === 'bot'), 6000);
      assert.match(reply.text, /SLOW_PLEASE/);
      await s.untilState(bot.id, 'idle');
      assert.deepEqual((await s.messagesOf(bot.id)).filter((m) => m.role === 'error'), []);
    }
    await s.untilState(bot.id, 'idle');
    assert.equal(noRunErrorsAnywhere(), 0);
  }
});

test('a queued run fails visibly when its routine is deleted', crashSafe, async () => {
  const { bot, routine } = await slowWebhookRoutine('Mel', 'Quick job');
  // A slow chat turn holds the queue.
  await s.send(bot.id, 'SLOW_PLEASE');
  await s.untilState(bot.id, 'working');
  const pending = s.hook(routine, 'wait=1&timeout=5');
  const run = await runWith(routine.id, 'queued');
  const seen: RoutineRun[] = [];
  const unsubscribe = app.hub.subscribe((ev) => {
    if (ev.type === 'run.upserted' && ev.run.id === run.id) seen.push(ev.run);
  });
  await call('DELETE', `/api/routines/${routine.id}`);
  unsubscribe();
  assert.deepEqual(
    seen.map((r) => [r.status, r.error]),
    [['failed', 'Routine was deleted']],
  );
  const res = await pending;
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, 'Routine was deleted');
  await call('POST', `/api/bots/${bot.id}/stop`);
  await s.untilState(bot.id, 'idle');
  assert.equal(noRunErrorsAnywhere(), 0);
});

test('a webhook wait survives its run row vanishing without any event', crashSafe, async () => {
  const { bot, routine } = await slowWebhookRoutine('Phil');
  const pending = s.hook(routine, 'wait=1&timeout=1');
  const run = await runWith(routine.id, 'running');
  app.store.db.prepare('delete from routine_runs where id = ?').run(run.id);

  const res = await pending;
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), { ok: false, runId: run.id, status: 'failed', reply: null, error: 'Run was deleted' });
  assert.equal((await call('GET', '/api/health')).status, 200);

  assert.deepEqual((await call('POST', `/api/bots/${bot.id}/stop`)).data, { stopped: true, cancelledRuns: 0, queuedRuns: 0 });
  await s.untilState(bot.id, 'idle');
  assert.deepEqual((await s.messagesOf(bot.id)).filter((m) => m.role === 'error'), []);
});

test('a webhook wait is cancelled when the caller disconnects', crashSafe, async () => {
  const { bot, routine } = await slowWebhookRoutine('Tim');
  const listeners = app.hub.listenerCount;
  const caller = new AbortController();
  const pending = s.hook(routine, 'wait=1&timeout=30', { signal: caller.signal }).catch(() => 'disconnected');
  await runWith(routine.id, 'running');
  await until(async () => app.hub.listenerCount === listeners + 1);
  caller.abort();
  assert.equal(await pending, 'disconnected');
  await until(async () => app.hub.listenerCount === listeners, 2000);
  assert.equal((await call('GET', '/api/health')).status, 200);
  await call('POST', `/api/bots/${bot.id}/stop`);
  await s.untilState(bot.id, 'idle');
});

test('a webhook timeout that is not a number falls back to the default wait', crashSafe, async () => {
  const { routine } = await slowWebhookRoutine('Carl', 'SLOW_PLEASE:400');
  const res = await s.hook(routine, 'wait=1&timeout=abc');
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.status, 'succeeded');
  assert.match(out.reply, /SLOW_PLEASE:400/);
});

test('a 500 on a webhook logs the path but not the ?key= secret', async (t) => {
  const bot = await s.newBot('Kay');
  const routine = await s.newRoutine(bot.id, { name: 'Keyed', instruction: 'Hi', webhook: true });
  const key = routine.webhook!.key;
  t.mock.method(app.engine, 'triggerRoutine', () => {
    throw new Error('disk I/O error');
  });
  const logged = captureLogs();
  t.after(logged.restore);
  const res = await fetch(`${base}/hooks/routines/${routine.id}?key=${key}&wait=1`, { method: 'POST' });
  assert.equal(res.status, 500);
  await until(async () => logged.lines.some((l) => l.msg === 'webhook'));
  const failed = logged.lines.find((l) => l.msg === 'request failed');
  assert.equal(failed?.path, `/hooks/routines/${routine.id}`);
  assert.equal(failed?.error, 'disk I/O error');
  assert.ok(logged.lines.some((l) => l.msg === 'webhook' && l.status === 500 && l.routineId === routine.id && l.level === 'error'));
  assert.ok(!JSON.stringify(logged.lines).includes(key), 'the webhook key was logged');
});

test('25 back-to-back runs all execute and only finished runs are pruned', crashSafe, async () => {
  const bot = await s.newBot('Otto');
  const routine = await s.newRoutine(bot.id, { name: 'Count', instruction: 'Count sheep' });
  const status = new Map<string, RunStatus>();
  const vanished: string[] = [];
  const unsubscribe = app.hub.subscribe((ev) => {
    if (ev.type !== 'run.upserted' || ev.run.routineId !== routine.id) return;
    status.set(ev.run.id, ev.run.status);
    for (const [id, st] of status) if ((st === 'queued' || st === 'running') && !app.store.findRun(id)) vanished.push(id);
  });
  try {
    // Scheduled runs: webhook and manual ones stop at ROUTINE_QUEUE_MAX waiting.
    const ids = Array.from({ length: 25 }, () => app.engine.triggerRoutine(routine.id, 'schedule').id);
    await until(async () => ids.every((id) => status.get(id) === 'succeeded'), 15_000);
    assert.deepEqual(vanished, []);

    const runs = await s.runsOf(routine.id);
    assert.equal(runs.length, 20);
    assert.ok(runs.every((r) => r.status === 'succeeded'));
    assert.deepEqual(
      runs.map((r) => r.id),
      ids.slice(5).reverse(),
    );
    const messages = await s.messagesOf(bot.id);
    assert.equal(messages.filter((m) => m.role === 'bot').length, 25);
    assert.deepEqual(messages.filter((m) => m.role === 'error'), []);
  } finally {
    unsubscribe();
  }
});
