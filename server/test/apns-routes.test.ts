// Push to the native app through the real server: registering the calling device (paired devices only, never a Boton
// token), what revoking or signing out does to it, what a push sends and what Apple's answers do, Settings → Health, and
// that nothing about the settings is ever in an answer. Apple is a loopback HTTP/2 server given to the app in code
// (fixtures/fake-apns.ts); ntfy is a loopback HTTP server. Nothing reaches the network.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DevicePushStatus, Message, NotifyDelivery, NotifyResult, OperationsStatus } from '../../shared/types.ts';
import { fakeApns, throwawayKey } from './fixtures/fake-apns.ts';
import { failOnEscapedErrors, pairDevice, startServer, tempDir, until } from './helpers.ts';

const apple = await fakeApns();
const keyDir = tempDir('botons-apns-key-');
const keyFile = join(keyDir, 'AuthKey_TESTKEY123.p8');
throwawayKey(keyFile);
const SETTINGS = { BOTONS_APNS_KEY_FILE: keyFile, BOTONS_APNS_KEY_ID: 'TESTKEY123', BOTONS_APNS_TEAM_ID: 'TEAM123456', BOTONS_APNS_TOPIC: 'com.example.botons' };

// A fake ntfy server, to see both channels at one moment.
const ntfyBodies: unknown[] = [];
const ntfy = createServer((req, res) => {
  let data = '';
  req.setEncoding('utf8').on('data', (d: string) => (data += d));
  req.on('end', () => {
    ntfyBodies.push(JSON.parse(data));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"abc"}');
  });
});
await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => ntfy.close(r)));
const ntfyUrl = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}`;
after(() => apple.close());

const configured = await startServer({ env: SETTINGS, appOptions: { apns: { testOrigin: apple.origin } } });
const plain = await startServer({ appOptions: { apns: { testOrigin: apple.origin } } });
failOnEscapedErrors();

const TOKEN_A = 'a1'.repeat(32);
const TOKEN_B = 'b2'.repeat(32);
const NOT_REGISTERED: DevicePushStatus = { configured: true, registered: false, environment: null, updatedAt: null, lastResult: null };
const put = (s: typeof configured, body: unknown, token?: string | null) => s.call<DevicePushStatus>('PUT', '/api/devices/current/push', body, token);

test('a streamed chat reply sends one native alert after completion; history and event replays send nothing', async () => {
  const s = await startServer({ env: SETTINGS, appOptions: { apns: { testOrigin: apple.origin } } });
  const bot = await s.newBot('Kevin');
  await put(s, { token: TOKEN_A, environment: 'development' });
  await s.call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'botons-test', preview: false } });
  apple.calls.length = 0;
  ntfyBodies.length = 0;
  let release!: (text: string) => void;
  const completed = new Promise<string>((resolve) => { release = resolve; });
  s.mock.script = async (req) => {
    req.onText?.('The first part');
    req.onStep?.({ kind: 'tool', label: 'Check', detail: 'checking', at: new Date().toISOString() });
    return completed;
  };
  const reply = s.chat(bot.id, 'Hello');
  await until(() => s.turnsOf(bot.id).length === 1);
  assert.equal(apple.calls.length, 0, 'drafts and tool steps do not notify');
  release('The completed reply');
  const posted = await reply;
  await until(() => apple.calls.length === 1);
  assert.equal(apple.calls[0].headers['apns-push-type'], 'alert');
  assert.deepEqual(apple.calls[0].body, {
    aps: { alert: { title: 'Kevin', body: 'New message.' }, sound: 'default', 'thread-id': bot.id },
    botId: bot.id, messageId: posted.id,
  });
  assert.equal(ntfyBodies.length, 0, 'ordinary messages do not change ntfy policy');
  await s.messagesOf(bot.id);
  s.app.hub.publish({ type: 'message.created', message: posted });
  s.app.hub.publish({ type: 'message.created', message: posted });
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  // Drain the local sender through its status, so a delayed duplicate request would be observed.
  await until(() => s.app.engine.notifier.status().apns?.last?.ok);
  assert.equal(apple.calls.length, 1);
  await s.call('PATCH', '/api/settings', { ntfy: { preview: true } });
  s.mock.script = () => 'Another completed reply';
  const next = await s.chat(bot.id, 'Again');
  await until(() => apple.calls.length === 2);
  assert.equal(apple.calls[1].body.aps.alert.body, next.text);
  assert.equal(apple.calls[1].body.messageId, next.id);
});

test('quiet markers, internal events, errors and replies to reset conversations do not send message pushes', async () => {
  const s = await startServer({ env: SETTINGS, appOptions: { apns: { testOrigin: apple.origin } } });
  const bot = await s.newBot('Stuart');
  await put(s, { token: TOKEN_A, environment: 'development' });
  apple.calls.length = 0;
  s.mock.script = () => '[quiet] nothing new';
  await s.chat(bot.id, 'Hello');
  s.app.store.addMessage(bot.id, 'user', 'Automatic update', { kind: 'work.event' }, true);
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  s.mock.script = () => { throw new Error('Fake provider failure'); };
  await s.chat(bot.id, 'Again');
  s.mock.script = () => { s.app.store.resetContext(bot.id); return 'Reply to the reset conversation'; };
  const stale = await s.chat(bot.id, 'Reset during this turn');
  assert.equal(stale.meta?.staleContext, true);
  const message = s.app.store.addMessage(bot.id, 'bot', 'Historical reply');
  for (const override of [{ role: 'event' }, { role: 'user' }, { role: 'error' }, { text: '' }, { meta: { quiet: true } }, { text: '**[quiet]** all clear' }]) {
    assert.equal(await s.app.engine.notifier.message(bot, { ...message, ...override } as Message), null);
  }
  assert.equal(apple.calls.length, 0);
});

test('visible routine results send one native message alert independently of ntfy policy; test and quiet runs send none', async () => {
  const s = await startServer({ env: SETTINGS, appOptions: { apns: { testOrigin: apple.origin } } });
  const bot = await s.newBot('Bob');
  await put(s, { token: TOKEN_B, environment: 'development' });
  await s.call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'botons-test', preview: true } });
  for (const policy of ['always', 'never'] as const) {
    const routine = await s.newRoutine(bot.id, { notify: policy });
    apple.calls.length = 0;
    ntfyBodies.length = 0;
    s.mock.script = () => 'A visible result';
    const run = s.app.engine.triggerRoutine(routine.id, 'manual');
    await s.untilState(bot.id, 'idle');
    await until(() => s.app.store.getRun(run.id).meta?.notifications?.some((d) => d.channel === 'apns'));
    if (policy === 'always') await until(() => s.app.store.getRun(run.id).meta?.notifications?.some((d) => d.channel === 'ntfy'));
    const posted = (await s.messagesOf(bot.id)).find((m) => m.role === 'bot' && m.meta?.runId === run.id)!;
    assert.equal(apple.calls.length, 1, 'no duplicate result alert');
    assert.equal(apple.calls[0].body.messageId, posted.id);
    assert.equal(ntfyBodies.length, policy === 'always' ? 1 : 0);
    apple.calls.length = 0;
    s.app.engine.triggerRoutine(routine.id, 'test');
    await s.untilState(bot.id, 'idle');
    s.mock.script = () => '[quiet] nothing new';
    s.app.engine.triggerRoutine(routine.id, 'manual');
    await s.untilState(bot.id, 'idle');
    assert.equal(apple.calls.length, 0);
  }
});

test('without the Apple settings the route says the server is not configured, a registration is kept, and nothing is sent', async () => {
  apple.calls.length = 0;
  const get = await plain.call<DevicePushStatus>('GET', '/api/devices/current/push');
  assert.equal(get.status, 200);
  assert.deepEqual(get.data, { configured: false, registered: false, environment: null, updatedAt: null, lastResult: null });
  const reg = await put(plain, { token: TOKEN_A, environment: 'development' });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.configured, false);
  assert.equal(reg.data.registered, true);
  assert.equal(reg.data.environment, 'development');

  const bot = await plain.newBot('Kevin');
  const sent = await plain.app.engine.notify(bot.id, 'Hello', 'default');
  assert.equal(sent.skipped, 'push notifications are not set up');
  assert.deepEqual(sent.deliveries, []);
  assert.equal(apple.calls.length, 0, 'nothing went to Apple');
  const ops = (await plain.call<OperationsStatus>('GET', '/api/operations')).data;
  assert.equal('apns' in ops.push, false, 'Health says nothing of a channel that is not set up');
  assert.equal(ops.push.state, 'unset');
});

test('register, read and remove the calling device; the answer has the documented shape and never the token', async () => {
  assert.deepEqual((await configured.call('GET', '/api/devices/current/push')).data, NOT_REGISTERED);

  const reg = await put(configured, { token: TOKEN_A.toUpperCase(), environment: 'production' });
  assert.equal(reg.status, 200);
  assert.deepEqual(Object.keys(reg.data), ['configured', 'registered', 'environment', 'updatedAt', 'lastResult']);
  assert.equal(reg.data.configured, true);
  assert.equal(reg.data.registered, true);
  assert.equal(reg.data.environment, 'production');
  assert.match(reg.data.updatedAt ?? '', /^\d{4}-\d\d-\d\dT/);
  assert.equal(reg.data.lastResult, null);
  assert.ok(!reg.text.toLowerCase().includes(TOKEN_A), 'the token is never answered back');
  assert.deepEqual((await configured.call('GET', '/api/devices/current/push')).data, reg.data);

  // Sent again with another environment: replaced, still one.
  const again = await put(configured, { token: TOKEN_B, environment: 'development', host: 'evil.example.com' });
  assert.equal(again.data.environment, 'development');
  assert.equal(configured.app.pushDevices.count(), 1);
  assert.equal(configured.app.pushDevices.all()[0].token, TOKEN_B);

  const gone = await configured.call<DevicePushStatus>('DELETE', '/api/devices/current/push');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.data, NOT_REGISTERED);
  assert.deepEqual((await configured.call('DELETE', '/api/devices/current/push')).data, NOT_REGISTERED, 'removing nothing is fine');
});

test('a registration is checked: a hexadecimal token of bounded length, a known environment, a JSON object', async () => {
  const bad = (body: unknown) => configured.call<{ error: string }>('PUT', '/api/devices/current/push', body);
  for (const token of ['', 'xyz', 'a1'.repeat(15), 'a1'.repeat(101), `${'a1'.repeat(32)} `, 'g1'.repeat(32), 12345, null, ['a1'], { x: 1 }]) {
    const r = await bad({ token, environment: 'production' });
    assert.equal(r.status, 400, JSON.stringify(token));
    assert.match(r.data.error, /token must be the hexadecimal device token/);
  }
  assert.equal((await bad({ environment: 'production' })).status, 400);
  for (const environment of ['', 'sandbox', 'PRODUCTION', undefined, null, 1]) {
    const r = await bad({ token: TOKEN_A, environment });
    assert.equal(r.status, 400, String(environment));
    assert.match(r.data.error, /environment must be "development" or "production"/);
  }
  const res = await fetch(`${configured.base}/api/devices/current/push`, { method: 'PUT', headers: { authorization: `Bearer ${configured.token}`, 'content-type': 'application/json' }, body: '[1]' });
  assert.equal(res.status, 400);
  const notJson = await fetch(`${configured.base}/api/devices/current/push`, { method: 'PUT', headers: { authorization: `Bearer ${configured.token}`, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(notJson.status, 400);
  assert.equal(configured.app.pushDevices.count(), 0, 'none of these registered anything');
});

test('only a paired device: no token is refused, and a Boton token (a turn, or a sandboxed one) is refused on every method', async () => {
  const bot = await configured.newBot('Stuart');
  for (const [method, body] of [['GET', undefined], ['PUT', { token: TOKEN_A, environment: 'production' }], ['DELETE', undefined]] as const) {
    assert.equal((await configured.call(method, '/api/devices/current/push', body, null)).status, 401, `${method} without a token`);
    for (const sandboxed of [false, true]) {
      const turn = configured.app.auth.mintBotonToken(bot.id, { sandboxed });
      try {
        const r = await configured.call(method, '/api/devices/current/push', body, turn.token);
        assert.equal(r.status, 403, `${method} with a ${sandboxed ? 'sandboxed ' : ''}Boton token`);
      } finally {
        turn.revoke();
      }
    }
  }
  assert.equal(configured.app.pushDevices.count(), 0);
});

test('revoking a device, or signing it out, removes its registration and it is sent nothing', async () => {
  const phone = await pairDevice(configured.app, configured.base, 'Phone');
  const tablet = await pairDevice(configured.app, configured.base, 'Tablet');
  assert.equal((await put(configured, { token: TOKEN_A, environment: 'production' }, phone)).status, 200);
  assert.equal((await put(configured, { token: TOKEN_B, environment: 'development' }, tablet)).status, 200);
  assert.equal(configured.app.pushDevices.count(), 2);
  // Each device sees and removes only its own.
  assert.equal((await configured.call<DevicePushStatus>('GET', '/api/devices/current/push', undefined, phone)).data.environment, 'production');
  assert.equal((await configured.call<DevicePushStatus>('GET', '/api/devices/current/push', undefined, tablet)).data.environment, 'development');

  const bot = await configured.newBot('Bob');
  apple.calls.length = 0;
  await configured.app.engine.notify(bot.id, 'First', 'default');
  assert.deepEqual(apple.calls.map((c) => c.token).sort(), [TOKEN_A, TOKEN_B]);

  const id = (await configured.call<{ id: string; label: string }[]>('GET', '/api/devices')).data.find((d) => d.label === 'Tablet')!.id;
  assert.equal((await configured.call('DELETE', `/api/devices/${id}`)).status, 200);
  assert.deepEqual(configured.app.pushDevices.all().map((d) => d.token), [TOKEN_A], 'the revoked device has no registration');
  apple.calls.length = 0;
  await configured.app.engine.notify(bot.id, 'Second', 'default');
  assert.deepEqual(apple.calls.map((c) => c.token), [TOKEN_A], 'and is sent nothing');
  assert.equal((await put(configured, { token: TOKEN_B, environment: 'development' }, tablet)).status, 401, 'its token no longer works');
  assert.equal(configured.app.pushDevices.count(), 1);

  assert.equal((await configured.call('POST', '/api/auth/logout', {}, phone)).status, 200);
  assert.equal(configured.app.pushDevices.count(), 0, 'signing out removes it');
  apple.calls.length = 0;
  const after = await configured.app.engine.notify(bot.id, 'Third', 'default');
  assert.equal(apple.calls.length, 0);
  assert.equal(after.skipped, 'push notifications are not set up', 'with no device and no ntfy there is nowhere to push');
});

test('a push goes to every registered device at the moments ntfy pushes, with the preview setting deciding the words, and ntfy is unchanged beside it', async () => {
  const bot = await configured.newBot('Dave');
  assert.equal((await put(configured, { token: TOKEN_A, environment: 'production' })).status, 200);
  assert.equal((await configured.call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'botons-test', preview: false } })).status, 200);
  apple.calls.length = 0;
  ntfyBodies.length = 0;

  const off: NotifyResult = await configured.app.engine.notify(bot.id, 'Secret quarterly numbers', 'high');
  assert.deepEqual(off.deliveries.map((d: NotifyDelivery) => [d.channel, d.reason, d.ok]), [['ntfy', 'notify', true], ['apns', 'notify', true]]);
  assert.equal(apple.calls.length, 1);
  assert.deepEqual(apple.calls[0].body, {
    aps: { alert: { title: 'Dave', body: 'New notification.' }, sound: 'default', 'thread-id': bot.id },
    botId: bot.id,
    messageId: off.message.id,
  });
  assert.equal(JSON.stringify(apple.calls[0]).includes('Secret quarterly'), false, 'generic wording with previews off');
  assert.equal((ntfyBodies[0] as { message: string }).message, 'New notification.', 'the same wording as ntfy');

  assert.equal((await configured.call('PATCH', '/api/settings', { ntfy: { preview: true } })).status, 200);
  await configured.app.engine.notify(bot.id, 'Secret quarterly numbers', 'default');
  assert.equal(apple.calls[1].body.aps.alert.body, 'Secret quarterly numbers');
  assert.equal((ntfyBodies[1] as { message: string }).message, 'Secret quarterly numbers');

  // An approval request: the approval's id, and the generic wording again once previews are off.
  assert.equal((await configured.call('PATCH', '/api/settings', { ntfy: { preview: false } })).status, 200);
  const { approval } = configured.app.approvals.request(bot.id, { title: 'Deploy to staging' }, { sandboxed: false });
  await until(() => apple.calls.length >= 3);
  assert.deepEqual(apple.calls[2].body.approvalId, approval.id);
  assert.ok(approval.messageId, 'the approval has its card in the chat');
  assert.equal(apple.calls[2].body.messageId, approval.messageId, 'the push opens the card');
  assert.equal(apple.calls[2].body.botId, bot.id);
  assert.match(apple.calls[2].body.aps.alert.body, /^Needs your approval \(from /);
  assert.equal(JSON.stringify(apple.calls[2]).includes('Deploy to staging'), false);
  await until(() => configured.app.approvals.get(approval.id).notifications.some((n) => n.channel === 'apns'));
  assert.deepEqual(configured.app.approvals.get(approval.id).notifications.map((n) => n.channel).sort(), ['apns', 'ntfy']);

  // Turned off in Settings: ntfy stops, and the registered device is still pushed to (registering is its own choice).
  assert.equal((await configured.call('PATCH', '/api/settings', { ntfy: { enabled: false } })).status, 200);
  ntfyBodies.length = 0;
  const only = await configured.app.engine.notify(bot.id, 'Again', 'default');
  assert.deepEqual(only.deliveries.map((d) => d.channel), ['apns']);
  assert.equal(ntfyBodies.length, 0);
});

test("Apple's 410 removes the registration through the app, and Settings → Health shows how pushes went without any setting or token", async () => {
  const bot = await configured.newBot('Kevin');
  await configured.call('DELETE', '/api/devices/current/push');
  assert.equal((await put(configured, { token: TOKEN_A, environment: 'production' })).status, 200);

  apple.answer(TOKEN_A, 410, 'Unregistered', 1);
  const sent = await configured.app.engine.notify(bot.id, 'Hello', 'default');
  assert.equal(sent.deliveries[0].ok, false);
  assert.equal(sent.deliveries[0].status, 410);
  assert.deepEqual((await configured.call('GET', '/api/devices/current/push')).data, NOT_REGISTERED, 'the app can see it must register again');

  // A failure that keeps the registration is on the device's status and in Health.
  assert.equal((await put(configured, { token: TOKEN_B, environment: 'production' })).status, 200);
  apple.answer(TOKEN_B, 503, 'ServiceUnavailable', 1);
  await configured.app.engine.notify(bot.id, 'Hello again', 'default');
  assert.equal((await configured.call<DevicePushStatus>('GET', '/api/devices/current/push')).data.lastResult, 'server-error (ServiceUnavailable)');
  let ops = (await configured.call<OperationsStatus>('GET', '/api/operations')).data;
  assert.equal(ops.push.apns!.devices, 1);
  assert.equal(ops.push.apns!.last!.ok, false);
  assert.equal(ops.push.apns!.last!.problem, 'server-error');
  assert.equal(ops.push.apns!.last!.status, 503);
  assert.equal(ops.push.apns!.failuresInARow, 2, 'the push whose only device Apple had dropped counts too: nothing reached anyone');

  await configured.app.engine.notify(bot.id, 'And now', 'default');
  ops = (await configured.call<OperationsStatus>('GET', '/api/operations')).data;
  assert.equal(ops.push.apns!.last!.ok, true);
  assert.equal(ops.push.apns!.failuresInARow, 0);
  assert.equal((await configured.call<DevicePushStatus>('GET', '/api/devices/current/push')).data.lastResult, 'delivered');

  // Nothing set in the environment, and no token, is in anything the owner's views answer.
  const everything = JSON.stringify([
    ops,
    (await configured.call('GET', '/api/settings')).data,
    (await configured.call('GET', '/api/info')).data,
    (await configured.call('GET', '/api/health')).data,
    (await configured.call('GET', '/api/devices')).data,
    (await configured.call('GET', '/api/devices/current/push')).data,
  ]);
  for (const secret of [...Object.values(SETTINGS), TOKEN_A, TOKEN_B, keyDir, 'BEGIN']) assert.equal(everything.includes(secret), false, `not in an answer: ${secret}`);
  // And not in the database.
  const stored = JSON.stringify(configured.app.store.db.prepare('select key, value from settings').all());
  for (const secret of [...Object.values(SETTINGS), keyDir]) assert.equal(stored.includes(secret), false, `not stored: ${secret}`);
});

test('an install with APNs and no ntfy still pushes, and "Show text in pushes" is read on its own', async () => {
  const only = await startServer({ env: SETTINGS, appOptions: { apns: { testOrigin: apple.origin } } });
  const bot = await only.newBot('Stuart');
  assert.equal(only.app.store.ntfyConfig(), null, 'no ntfy server or topic');
  assert.equal(only.app.engine.notifier.enabled, false, 'nothing registered yet');
  assert.equal((await put(only, { token: TOKEN_B, environment: 'development' })).status, 200);
  assert.equal(only.app.engine.notifier.enabled, true, 'a registered device is enough');
  apple.calls.length = 0;

  const off = await only.app.engine.notify(bot.id, 'Quarterly numbers', 'default');
  assert.equal(off.skipped, null);
  assert.deepEqual(off.deliveries.map((d) => [d.channel, d.ok]), [['apns', true]]);
  assert.equal(apple.calls[0].body.aps.alert.body, 'New notification.');

  // The preview setting lives with the ntfy settings but needs no server or topic there.
  assert.equal((await only.call('PATCH', '/api/settings', { ntfy: { preview: true } })).status, 200);
  assert.equal(only.app.store.ntfyConfig(), null);
  await only.app.engine.notify(bot.id, 'Quarterly numbers', 'default');
  assert.equal(apple.calls[1].body.aps.alert.body, 'Quarterly numbers');

  const ops = (await only.call<OperationsStatus>('GET', '/api/operations')).data;
  assert.equal(ops.push.state, 'unset', "ntfy's own status is as it was");
  assert.equal(ops.push.apns!.devices, 1);
  assert.equal((await only.call('POST', '/api/notify/test', {})).status, 400, "the test push is still ntfy's: it needs a server and topic");
});
