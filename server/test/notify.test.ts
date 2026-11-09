import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { Bot, NotifyDelivery, NotifyResult, Routine, RoutineRun, ServerEvent, Settings } from '../../shared/types.ts';
import { captureLogs } from '../src/log.ts';
import { buildPush, clip, Notifier, PUSH_TEXT_MAX } from '../src/notify.ts';
import { parseQuiet } from '../src/prompt.ts';
import { failOnEscapedErrors, freePort, sleep, startServer, until } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const PUBLIC_URL = 'http://myhost.example-tailnet.ts.net:7777';
const TOKEN = 'tk_s3cr3t-ntfy-token';

// A fake ntfy server on loopback.
const received: { url: string; headers: IncomingHttpHeaders; body: { topic: string; title: string; message: string; priority: number; click: string } }[] = [];
/** Statuses for the next requests; 200 once they run out. */
const statuses: number[] = [];
const ntfy = createServer((req, res) => {
  let data = '';
  req.setEncoding('utf8').on('data', (d: string) => (data += d));
  req.on('end', () => {
    received.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(data) });
    const status = statuses.shift() ?? 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? '{"id":"abc","event":"message"}' : '{"code":50001,"http":500,"error":"something broke"}');
  });
});
await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => ntfy.close(r)));
const ntfyUrl = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}`;

const serverEnv = { BOTONS_PUBLIC_URL: PUBLIC_URL };
const s = await startServer({ env: serverEnv });
const { app, call } = s;
failOnEscapedErrors();
beforeEach(async () => {
  received.length = 0;
  statuses.length = 0;
  assert.equal((await call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'botons-test', token: TOKEN, preview: false } })).status, 200);
});

const idle = (botId: string) => s.untilState(botId, 'idle');
const startRun = async (routine: Routine, body?: unknown) => (await call<RoutineRun>('POST', `/api/routines/${routine.id}/run`, body)).data;
async function runNow(routine: Routine): Promise<RoutineRun> {
  const run = await startRun(routine);
  return until(async () => (await s.runsOf(routine.id)).find((r) => r.id === run.id && (r.status === 'succeeded' || r.status === 'failed')));
}

/** Run the `botons` CLI the way a Boton's shell does, with a turn's environment. */
const botonCli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    execFile(join(repo, 'server/bin/botons'), args, { env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', ...env } }, (err, stdout, stderr) =>
      done({ code: err ? (err.code as number) : 0, stdout, stderr }),
    ).stdin!.end(),
  );

/** Start a turn of `bot` with `start`; while it runs, `check` gets its `botons` environment; then stop the Boton. */
async function during<T>(bot: Bot, start: () => Promise<T>, check: (env: Record<string, string>, started: T) => Promise<void>) {
  const seen = s.turnsOf(bot.id).length;
  const started = await start();
  const { env } = await until(() => s.turnsOf(bot.id)[seen]);
  assert.match(env.BOTON_TOKEN, /^mmt_/, 'a turn token, so requests with it never fall back to the device');
  try {
    await check({ BOTONS_API: env.BOTONS_API, BOTON_BOT_ID: env.BOTON_BOT_ID, BOTON_TOKEN: env.BOTON_TOKEN }, started);
  } finally {
    await call('POST', `/api/bots/${bot.id}/stop`);
    await idle(bot.id);
  }
}
const slowChat = (bot: Bot) => () => s.send(bot.id, 'SLOW_PLEASE');

test('a [quiet] run adds nothing to the chat, does not move the Boton, pushes nothing, and shows Quiet with its note', async () => {
  const quietBot = await s.newBot('Watcher');
  const busy = await s.newBot('Chatty');
  const routine = await s.newRoutine(quietBot.id, { name: 'Inbox check', instruction: 'QUIET_PLEASE:nothing new', notify: 'always' });
  await s.send(busy.id, 'hello');
  await idle(busy.id);
  const order = (await call<Bot[]>('GET', '/api/bots')).data.map((b) => b.id);
  assert.ok(order.indexOf(busy.id) < order.indexOf(quietBot.id));
  const before = await s.messagesOf(quietBot.id);
  const lastBefore = (await call<Bot>('GET', `/api/bots/${quietBot.id}`)).data.lastMessage;

  const events: ServerEvent[] = [];
  const unsubscribe = app.hub.subscribe((e) => events.push(e));
  let run: RoutineRun;
  try {
    run = await runNow(routine);
    await idle(quietBot.id);
    await sleep(300);
  } finally {
    unsubscribe();
  }

  assert.equal(run.status, 'succeeded');
  assert.equal(run.quiet, true);
  assert.equal(run.reply, 'nothing new');
  assert.equal(run.meta, null, 'no push was sent or attempted');
  assert.equal(received.length, 0);

  assert.deepEqual(await s.messagesOf(quietBot.id), before, 'no chip, reply or error');
  assert.ok(!events.some((e) => e.type === 'message.created' && e.message.botId === quietBot.id));
  assert.ok(!events.some((e) => e.type === 'bot.upserted' && e.bot.id === quietBot.id), 'nothing re-sorts or badges the Boton');
  const now = (await call<Bot[]>('GET', '/api/bots')).data;
  assert.deepEqual(now.map((b) => b.id), order, 'the sidebar order is unchanged');
  assert.deepEqual(now.find((b) => b.id === quietBot.id)!.lastMessage, lastBefore);
  assert.equal(now.find((b) => b.id === quietBot.id)!.unread, 0);
  const activities = events.flatMap((e) => (e.type === 'bot.status' && e.botId === quietBot.id && e.status.activity ? [e.status.activity] : []));
  assert.equal(activities[0], 'Running routine “Inbox check”');
  assert.ok(activities.every((a) => a.startsWith('Running routine “Inbox check”')), activities.join(' | '));
  assert.equal((await s.runsOf(routine.id))[0].quiet, true);
  assert.equal((await call<Routine>('GET', `/api/routines/${routine.id}`)).data.lastStatus, 'succeeded');
});

test('Start fresh: a quiet run leaves nothing in the replayed conversation', async () => {
  const bot = await s.newBot('Replayer');
  const routine = await s.newRoutine(bot.id, { name: 'Feed check', instruction: 'QUIET_PLEASE:feeds unchanged' });
  await call('POST', `/api/bots/${bot.id}/reset`);
  await s.send(bot.id, 'remember the plums');
  await idle(bot.id);
  assert.equal((await runNow(routine)).quiet, true);
  // Changed instructions start a new provider session, which replays the conversation since the reset.
  await call('PATCH', `/api/bots/${bot.id}`, { instructions: 'Watch the feeds.' });
  const seen = s.turnsOf(bot.id).length;
  await s.send(bot.id, 'what fruit?');
  await idle(bot.id);
  const turn = s.turnsOf(bot.id)[seen];
  assert.equal(turn.sessionId, null);
  const replay = turn.prompt.split('</conversation_so_far>')[0];
  assert.ok(replay.includes('remember the plums'), turn.prompt);
  assert.ok(!replay.includes('Feed check') && !replay.includes('feeds unchanged') && !replay.includes('quiet'), replay);
});

test('a run that is not quiet posts its "Ran routine" chip when it ends, then its reply', async () => {
  const bot = await s.newBot('Reporter');
  const routine = await s.newRoutine(bot.id, { name: 'Slow report', instruction: 'SLOW_PLEASE:400 report' });
  const run = await startRun(routine);
  await s.untilState(bot.id, 'working');
  assert.equal(app.engine.statusOf(bot.id).activity?.startsWith('Running routine “Slow report”'), true);
  assert.ok(!(await s.messagesOf(bot.id)).some((m) => m.meta?.kind === 'routine.run'), 'no chip while it runs');
  await until(async () => (await s.runsOf(routine.id))[0]?.status === 'succeeded');
  const msgs = (await s.messagesOf(bot.id)).filter((m) => m.meta?.runId === run.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.meta?.kind ?? null]), [['event', 'routine.run'], ['bot', null]]);
  assert.equal((await s.runsOf(routine.id))[0].quiet, false);
  assert.equal(received.length, 0, 'auto: a result is not pushed');
});

test('parseQuiet: the sentinel, with or without a note or markdown; anything else is not quiet', () => {
  assert.equal(parseQuiet('[quiet]'), '');
  assert.equal(parseQuiet('  [quiet] nothing new  '), 'nothing new');
  assert.equal(parseQuiet('[QUIET]: no changes'), 'no changes');
  assert.equal(parseQuiet('`[quiet]` no changes'), 'no changes');
  assert.equal(parseQuiet('**[quiet]** — all green'), 'all green');
  assert.equal(parseQuiet('[quiet]\nline one\nline two'), 'line one\nline two');
  assert.equal(parseQuiet('Nothing new [quiet]'), null);
  assert.equal(parseQuiet('Found 3 issues'), null);
  assert.equal(parseQuiet('[quiet]er than usual'), null);
  assert.equal(parseQuiet(''), null);
});

test('a failed run sends exactly one push: the Boton as title, a tap opens its chat, high priority, no payload, token on the wire only', async () => {
  const bot = await s.newBot('Kevin');
  const routine = await s.newRoutine(bot.id, { name: 'Deploy check', instruction: 'FAIL_PLEASE', webhook: true });
  const hook = await s.hook(routine, 'wait=1', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'PAYLOAD-DO-NOT-PUSH' }) });
  assert.equal(((await hook.json()) as { status: string }).status, 'failed');
  await until(() => received.length === 1);
  await sleep(300);
  assert.equal(received.length, 1, 'exactly one push');
  const [push] = received;
  assert.equal(push.url, '/');
  assert.equal(push.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(push.body.topic, 'botons-test');
  assert.equal(push.body.title, 'Kevin');
  assert.equal(push.body.priority, 4);
  assert.equal(push.body.message, 'A routine failed.', 'previews are off by default');
  assert.equal(push.body.click, `${PUBLIC_URL}/#/m/${bot.id}`);
  const run = await until(async () => (await s.runsOf(routine.id)).find((r) => r.meta?.notifications?.length));
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.meta!.notifications!.map((d) => [d.channel, d.reason, d.ok, d.status, d.error]), [['ntfy', 'failure', true, 200, null]]);
  const kinds = (await s.messagesOf(bot.id)).map((m) => [m.role, m.meta?.kind ?? null]);
  assert.deepEqual(kinds.slice(-2), [['event', 'routine.run'], ['error', null]]);

  // With previews on, the text goes too, cut to 200 characters; still no payload.
  await call('PATCH', '/api/settings', { ntfy: { preview: true } });
  await s.hook(routine, 'wait=1', { body: `PAYLOAD-DO-NOT-PUSH ${'x'.repeat(500)}` });
  await until(() => received.length === 2);
  const detailed = received[1].body.message;
  assert.match(detailed, /^“Deploy check” failed: Mock failure requested/);
  assert.ok(detailed.length <= PUSH_TEXT_MAX);
  for (const r of received) assert.ok(!JSON.stringify(r.body).includes('PAYLOAD-DO-NOT-PUSH'));
});

test('notify policies: always pushes results, failures and never do not; never also skips failures', async () => {
  const bot = await s.newBot('Policy');
  const always = await s.newRoutine(bot.id, { name: 'Always', instruction: 'Say hi', notify: 'always' });
  await runNow(always);
  await until(() => received.length === 1);
  assert.equal(received[0].body.priority, 3);
  assert.equal(received[0].body.message, 'A routine has a new result.');
  assert.equal((await until(async () => (await s.runsOf(always.id))[0].meta?.notifications))[0].reason, 'result');

  const failures = await s.newRoutine(bot.id, { name: 'Failures', instruction: 'Say hi', notify: 'failures' });
  assert.equal((await runNow(failures)).status, 'succeeded');
  const never = await s.newRoutine(bot.id, { name: 'Never', instruction: 'FAIL_PLEASE', notify: 'never' });
  assert.equal((await runNow(never)).status, 'failed');
  const auto = await s.newRoutine(bot.id, { name: 'Auto', instruction: 'Say hi' });
  assert.equal(auto.notify, 'auto');
  await runNow(auto);
  await sleep(300);
  assert.equal(received.length, 1);

  // A run the owner stops fails, but they know.
  const slow = await s.newRoutine(bot.id, { name: 'Slow', instruction: 'SLOW_PLEASE' });
  await startRun(slow);
  await s.untilState(bot.id, 'working');
  await call('POST', `/api/bots/${bot.id}/stop`);
  await until(async () => (await s.runsOf(slow.id))[0]?.status === 'failed');
  await sleep(300);
  assert.equal(received.length, 1);

  // Push off: nothing at all, even for a failure.
  await call('PATCH', '/api/settings', { ntfy: { enabled: false } });
  const failing = await s.newRoutine(bot.id, { name: 'Failing', instruction: 'FAIL_PLEASE' });
  await runNow(failing);
  await sleep(300);
  assert.equal(received.length, 1);
  assert.equal((await s.runsOf(failing.id))[0].meta, null);

  assert.equal((await call('PATCH', `/api/routines/${auto.id}`, { notify: 'sometimes' })).status, 400);
  assert.equal((await call('POST', `/api/bots/${bot.id}/routines`, { name: 'x', instruction: 'y', notify: 42 })).status, 400);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${auto.id}`, { notify: 'never' })).data.notify, 'never');
});

test('a push that fails is logged and recorded, and the run still ends succeeded', async (t) => {
  const logged = captureLogs();
  t.after(logged.restore);
  const bot = await s.newBot('Unlucky');
  const routine = await s.newRoutine(bot.id, { name: 'Report', instruction: 'Say hi', notify: 'always' });
  statuses.push(500);
  assert.equal((await runNow(routine)).status, 'succeeded');
  const after = await until(async () => (await s.runsOf(routine.id))[0].meta?.notifications?.[0]);
  assert.deepEqual([after.ok, after.status], [false, 500]);
  assert.match(after.error ?? '', /^HTTP 500: something broke/);
  assert.equal((await s.runsOf(routine.id))[0].status, 'succeeded');
  const failed = logged.lines.find((l) => l.msg === 'push failed');
  assert.ok(failed, JSON.stringify(logged.lines));
  assert.equal(failed.level, 'warn');
  assert.deepEqual([failed.channel, failed.reason, failed.botId, failed.status], ['ntfy', 'result', bot.id, 500]);
  assert.match(String(failed.error), /^HTTP 500: something broke/);

  // A server that isn't there at all.
  await call('PATCH', '/api/settings', { ntfy: { server: `http://127.0.0.1:${await freePort()}` } });
  const second = await runNow(routine);
  assert.equal(second.status, 'succeeded');
  const unreachable = await until(async () => (await s.runsOf(routine.id)).find((r) => r.id === second.id)?.meta?.notifications?.[0]);
  assert.deepEqual([unreachable.ok, unreachable.status], [false, null]);
  assert.match(unreachable.error ?? '', /ECONNREFUSED/);
  assert.ok((await s.messagesOf(bot.id)).some((m) => m.role === 'bot' && m.meta?.runId === second.id));
});

test('a run a restart cut off pushes once when the server starts again; a routine set to never stays silent', async () => {
  const s1 = await startServer({ env: serverEnv });
  await s1.call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'botons-test', preview: true } });
  const owl = await s1.newBot('Night owl');
  const mole = await s1.newBot('Mole');
  const crunch = await s1.newRoutine(owl.id, { name: 'Crunch', instruction: 'SLOW_PLEASE:20000 crunch' });
  const dig = await s1.newRoutine(mole.id, { name: 'Dig', instruction: 'SLOW_PLEASE:20000 dig', notify: 'never' });
  const r1 = (await s1.call<RoutineRun>('POST', `/api/routines/${crunch.id}/run`)).data;
  const r2 = (await s1.call<RoutineRun>('POST', `/api/routines/${dig.id}/run`)).data;
  await until(() => s1.app.store.findRun(r1.id)?.status === 'running' && s1.app.store.findRun(r2.id)?.status === 'running');
  received.length = 0;
  // Both turns are cut off and left "running" for the next process.
  await s1.stop();
  assert.equal(received.length, 0, 'nothing pushed while shutting down');

  const s2 = await startServer({ env: serverEnv, home: s1.home, token: null });
  await until(() => received.length === 1);
  await sleep(300);
  assert.equal(received.length, 1, 'exactly one push, for the routine that notifies');
  const { title, priority, message, click } = received[0].body;
  assert.deepEqual([title, priority, message, click], ['Night owl', 4, '“Crunch” was interrupted by a restart', `${PUBLIC_URL}/#/m/${owl.id}`]);
  const failed = await until(() => (s2.app.store.findRun(r1.id)?.meta?.notifications?.length ? s2.app.store.findRun(r1.id) : null));
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.meta!.notifications!.map((d) => [d.reason, d.ok]), [['failure', true]]);
  assert.equal(s2.app.store.findRun(r2.id)?.status, 'failed');
  assert.equal(s2.app.store.findRun(r2.id)?.meta, null);
  await s2.stop();
});

test('`botons notify "x"` posts a chip and sends one push; --priority high; a routine set to never only posts the chip', async () => {
  const bot = await s.newBot('Notifier');
  const other = await s.newBot('Bystander');
  await during(bot, slowChat(bot), async (env) => {
    let out = await botonCli(env, 'notify', 'Deploy finished');
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^Sent\./);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].body, { topic: 'botons-test', title: 'Notifier', message: 'New notification.', priority: 3, click: `${PUBLIC_URL}/#/m/${bot.id}` });
    const chip = (await s.messagesOf(bot.id)).at(-1)!;
    assert.deepEqual([chip.role, chip.text, chip.meta?.kind, chip.meta?.notifyText], ['event', 'Sent a notification', 'notify.sent', 'Deploy finished']);

    await call('PATCH', '/api/settings', { ntfy: { preview: true } });
    out = await botonCli(env, 'notify', 'Disk', 'almost', 'full', '--priority', 'high');
    assert.equal(out.code, 0, out.stderr);
    assert.equal(received.length, 2);
    assert.equal(received[1].body.priority, 4);
    assert.equal(received[1].body.message, 'Disk almost full');

    out = await botonCli(env, 'notify', 'x', '--priority', 'urgent');
    assert.equal(out.code, 1);
    assert.match(out.stderr, /--priority must be "high"/);
    assert.equal((await call('POST', `/api/bots/${other.id}/notify`, { text: 'hi' }, env.BOTON_TOKEN)).status, 403);
    assert.equal((await call('POST', `/api/bots/${bot.id}/notify`, { text: '' }, env.BOTON_TOKEN)).status, 400);
    assert.equal((await call('POST', `/api/bots/${bot.id}/notify`, { text: 'y'.repeat(1001) }, env.BOTON_TOKEN)).status, 400);
    assert.equal((await call('POST', '/api/notify/test', undefined, env.BOTON_TOKEN)).status, 403);
    assert.equal((await call('GET', '/api/settings', undefined, env.BOTON_TOKEN)).status, 403);
  });
  assert.equal(received.length, 2);

  // During a run of a routine set to never: the chip, linked to the run, and no push.
  const routine = await s.newRoutine(bot.id, { name: 'Night watch', instruction: 'SLOW_PLEASE', notify: 'never' });
  await during(bot, () => startRun(routine), async (env, run) => {
    const out = await botonCli(env, 'notify', 'Saw something');
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /no push sent: routine “Night watch” is set to never notify/);
    const chip = (await s.messagesOf(bot.id)).at(-1)!;
    assert.deepEqual([chip.meta?.kind, chip.meta?.runId, chip.meta?.routineName], ['notify.sent', run.id, 'Night watch']);
  });
  await sleep(300);
  assert.equal(received.length, 2);
});

test('a `botons notify` chip from a turn that started before Start fresh is marked stale, like the rest of that turn', async () => {
  const bot = await s.newBot('Forgetful');
  await during(bot, slowChat(bot), async (env) => {
    let out = await botonCli(env, 'notify', 'Before the reset');
    assert.equal(out.code, 0, out.stderr);
    assert.equal((await s.messagesOf(bot.id)).at(-1)!.meta?.staleContext, undefined);
    assert.equal((await call('POST', `/api/bots/${bot.id}/reset`)).status, 200);
    out = await botonCli(env, 'notify', 'After the reset');
    assert.equal(out.code, 0, out.stderr);
    const chip = (await s.messagesOf(bot.id)).at(-1)!;
    assert.equal(chip.meta?.notifyText, 'After the reset');
    assert.equal(chip.meta?.staleContext, true);
    const fresh = app.store.getBot(bot.id);
    const src = app.store.replaySource(bot.id, fresh.contextSince, []);
    assert.ok(![...src.chat, ...src.routines].some((r) => r.message.id === chip.id));
  });
});

test('a push from `botons notify` during a routine run is recorded in that run; during a test run, or without push set up, it only posts the chip', async () => {
  const bot = await s.newBot('Recorder');
  const routine = await s.newRoutine(bot.id, { name: 'Watch', instruction: 'SLOW_PLEASE' });
  const notify = (env: Record<string, string>, text: string) => call<NotifyResult>('POST', `/api/bots/${bot.id}/notify`, { text }, env.BOTON_TOKEN);
  await during(bot, () => startRun(routine), async (env, run) => {
    const { status, data } = await notify(env, 'Heads up');
    assert.equal(status, 201);
    assert.equal(data.skipped, null);
    assert.deepEqual(data.deliveries.map((d: NotifyDelivery) => [d.reason, d.ok]), [['notify', true]]);
    const recorded = await until(async () => (await s.runsOf(routine.id)).find((r) => r.id === run.id)?.meta?.notifications);
    assert.deepEqual(recorded.map((d) => d.reason), ['notify']);

    await call('PATCH', '/api/settings', { ntfy: { server: '', topic: '', enabled: false } });
    const off = await notify(env, 'Anyone?');
    assert.equal(off.status, 201);
    assert.equal(off.data.skipped, 'push notifications are not set up');
    assert.equal(off.data.message.meta?.notifyText, 'Anyone?');
  });
  assert.equal(received.length, 1);

  // A test run is a dry run; one of a routine with a webhook is sandboxed, and notify is open to it.
  await call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'botons-test' } });
  const hooked = await s.newRoutine(bot.id, { name: 'Hook', instruction: 'SLOW_PLEASE', webhook: true, notify: 'always' });
  const testRun = async () => {
    const { status, data } = await call<RoutineRun>('POST', `/api/routines/${hooked.id}/run`, { payload: { hello: 'world' } });
    assert.equal(status, 202);
    assert.equal(data.trigger, 'test');
    return data;
  };
  await during(bot, testRun, async (env, run) => {
    const { status, data } = await notify(env, 'Would page Sam');
    assert.equal(status, 201);
    assert.equal(data.skipped, 'this is a test run of routine “Hook”, which pushes nothing');
    assert.deepEqual(data.deliveries, []);
    assert.equal(data.message.meta?.runId, run.id);
  });
  await sleep(300);
  assert.equal(received.length, 1);
});

test('GET /api/settings and settings events never carry the ntfy token; the settings are validated', async () => {
  const events: ServerEvent[] = [];
  const unsubscribe = app.hub.subscribe((e) => events.push(e));
  try {
    const patched = await call<Settings>('PATCH', '/api/settings', { ntfy: { token: 'tk_another-secret', preview: true } });
    assert.equal(patched.status, 200);
    assert.ok(!patched.text.includes('tk_another-secret'));
    const got = await call<Settings>('GET', '/api/settings');
    assert.deepEqual(got.data.ntfy, { enabled: true, server: ntfyUrl, topic: 'botons-test', hasToken: true, preview: true });
    assert.ok(!got.text.includes('tk_') && !got.text.includes('token"'), got.text);
    assert.ok(events.some((e) => e.type === 'settings.updated'));
    assert.ok(!JSON.stringify(events).includes('tk_'));
  } finally {
    unsubscribe();
  }
  // The token is still what pushes use.
  assert.equal((await call<NotifyDelivery>('POST', '/api/notify/test')).data.ok, true);
  assert.equal(received.at(-1)!.headers.authorization, 'Bearer tk_another-secret');
  assert.equal(received.at(-1)!.body.title, 'Botons');
  assert.equal(received.at(-1)!.body.click, `${PUBLIC_URL}/`);

  assert.equal((await call<Settings>('PATCH', '/api/settings', { ntfy: { token: null } })).data.ntfy.hasToken, false);
  await call('POST', '/api/notify/test');
  assert.equal(received.at(-1)!.headers.authorization, undefined);

  for (const [ntfyPatch, error] of [
    [{ topic: 'has spaces' }, /topic/],
    [{ topic: 'x'.repeat(65) }, /topic/],
    [{ server: 'ftp://example.com' }, /http/],
    [{ server: 'not a url' }, /URL/],
    [{ server: 'https://user:pw@ntfy.example.com' }, /plain URL/],
    [{ token: 'has spaces in it' }, /token/],
    [{ enabled: 'yes' }, /enabled/],
    [{ topic: '' }, /server and topic/],
  ] as const) {
    const res = await call('PATCH', '/api/settings', { ntfy: ntfyPatch });
    assert.equal(res.status, 400, JSON.stringify(ntfyPatch));
    assert.match(res.data.error, error);
  }
  assert.equal((await call('PATCH', '/api/settings', { ntfy: 'on' })).status, 400);
  // Nothing half-saved.
  const name = (await call<Settings>('GET', '/api/settings')).data.ownerName;
  assert.equal((await call('PATCH', '/api/settings', { ownerName: 'Someone else', ntfy: { topic: 'bad topic' } })).status, 400);
  assert.equal((await call<Settings>('GET', '/api/settings')).data.ownerName, name);
  // A trailing slash is dropped; a server and topic can be cleared once push is off.
  assert.equal((await call<Settings>('PATCH', '/api/settings', { ntfy: { server: `${ntfyUrl}/` } })).data.ntfy.server, ntfyUrl);
  const cleared = await call<Settings>('PATCH', '/api/settings', { ntfy: { enabled: false, server: '', topic: '' } });
  assert.deepEqual(cleared.data.ntfy, { enabled: false, server: '', topic: '', hasToken: false, preview: true });
  assert.equal((await call('POST', '/api/notify/test')).status, 400);
});

test('a push is at most 200 characters, generic unless previews are on, and opens the Boton’s chat', async () => {
  const long = 'word '.repeat(100);
  assert.equal(clip(long).length, PUSH_TEXT_MAX);
  assert.ok(clip(long).endsWith('…'));
  assert.equal(clip('  short  '), 'short');
  const req = { bot: { id: 'bot_abc', name: 'Kevin' }, reason: 'notify' as const, detail: long, generic: 'New notification.', priority: 'high' as const };
  assert.deepEqual(buildPush(req, false, 'http://host:7777/'), { title: 'Kevin', body: 'New notification.', click: 'http://host:7777/#/m/bot_abc', priority: 'high' });
  assert.equal(buildPush(req, true, 'http://host:7777').body.length, PUSH_TEXT_MAX);
  assert.equal(buildPush({ ...req, detail: '   ' }, true, 'http://host:7777').body, 'New notification.');

  // Off, or not set up: nothing is sent and nothing is returned.
  const cfg = { enabled: false, server: ntfyUrl, topic: 't', token: null, preview: false };
  const off = new Notifier({ config: () => cfg, publicUrl: () => 'http://h' });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.push(req), []);
  assert.equal((await off.push({ ...req, reason: 'test' })).length, 1, 'a test only needs a server and topic');
  assert.deepEqual(await new Notifier({ config: () => null, publicUrl: () => 'http://h' }).push(req), []);
  assert.equal(received.length, 1);
});
