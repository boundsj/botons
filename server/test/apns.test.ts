// In process, for `npm test`: the APNs channel's parts with no Botons server: the provider token, the requests, what a
// registration does with each answer, the payload, and the settings. Apple is stood in for by a loopback HTTP/2
// server (fixtures/fake-apns.ts) given to the sender in code; nothing here reaches the network.
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { ApnsSender, APNS_TOKEN_REUSE_MS, PushDevices } from '../src/apns.ts';
import { type ApnsConfig, ConfigError, loadConfig } from '../src/config.ts';
import { captureLogs } from '../src/log.ts';
import { Notifier, type PushRequest } from '../src/notify.ts';
import { openSchema } from '../src/schema.ts';
import { fakeApns, throwawayKey, verifyProviderToken } from './fixtures/fake-apns.ts';
import { tempDir, until } from './helpers.ts';

const dir = tempDir('botons-apns-');
const keyFile = join(dir, 'AuthKey_TESTKEY123.p8');
const { publicKey } = throwawayKey(keyFile);
const config: ApnsConfig = { keyFile, keyId: 'TESTKEY123', teamId: 'TEAM123456', topic: 'com.example.botons' };
const apple = await fakeApns();
after(() => apple.close());

const TOKEN_A = 'a1'.repeat(32);
const TOKEN_B = 'b2'.repeat(32);
const TOKEN_C = 'c3'.repeat(32);
const TOKEN_D = 'd4'.repeat(32);
const TOKEN_E = 'e5'.repeat(32);
const TOKEN_F = 'f6'.repeat(32);

/** A database with the schema and two paired devices, and the registrations table over it. */
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('pragma foreign_keys = on');
  openSchema(db);
  const add = db.prepare("insert into auth_tokens (id, hash, kind, label, created_at) values (?, ?, 'device', ?, '2026-11-08T09:00:00.000Z')");
  add.run('dev_phone', 'h1', 'Phone');
  add.run('dev_tablet', 'h2', 'Tablet');
  return { db, devices: new PushDevices(db) };
}

const request = (over: Partial<PushRequest> = {}): PushRequest => ({
  bot: { id: 'bot_kevin', name: 'Kevin' },
  reason: 'notify',
  detail: 'The staging deploy finished with 2 warnings.',
  generic: 'New notification.',
  priority: 'default',
  ...over,
});

function notifier(devices: PushDevices, opts: { preview?: boolean; sender?: ApnsSender } = {}) {
  const sender = opts.sender ?? new ApnsSender({ config, testOrigin: apple.origin });
  return new Notifier({ config: () => null, publicUrl: () => 'http://myhost.example-tailnet.ts.net:7777', apns: { sender, devices, preview: () => opts.preview ?? false } });
}

test("a request carries Apple's headers and a provider token whose header and claims verify against the key's public half", async () => {
  apple.calls.length = 0;
  const sender = new ApnsSender({ config, testOrigin: apple.origin });
  const r = await sender.send({ token: TOKEN_A, environment: 'development' }, { aps: { alert: { title: 'Kevin', body: 'hi' } } });
  assert.deepEqual(r, { ok: true, status: 200, reason: null, gone: false, goneAt: null, problem: null });
  assert.equal(apple.calls.length, 1);
  const call = apple.calls[0];
  assert.equal(call.path, `/3/device/${TOKEN_A}`);
  assert.equal(call.headers[':method'], 'POST');
  assert.equal(call.headers['apns-push-type'], 'alert');
  assert.equal(call.headers['apns-topic'], 'com.example.botons');
  assert.equal(call.headers['content-type'], 'application/json');
  const auth = String(call.headers.authorization);
  assert.match(auth, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const { header, claims } = verifyProviderToken(auth.slice('bearer '.length), publicKey);
  assert.deepEqual(header, { alg: 'ES256', kid: 'TESTKEY123' });
  assert.deepEqual(Object.keys(claims).sort(), ['iat', 'iss']);
  assert.equal(claims.iss, 'TEAM123456');
  assert.ok(Math.abs(Number(claims.iat) - Date.now() / 1000) < 30);
  // A signature made with another key does not verify.
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  assert.throws(() => verifyProviderToken(auth.slice('bearer '.length), other), /does not verify/);
});

test('the provider token is reused for under an hour (the same one, one signature) and made again after', async () => {
  let now = Date.parse('2026-11-09T10:00:00.000Z');
  const sender = new ApnsSender({ config, testOrigin: apple.origin, now: () => now });
  const first = sender.providerToken();
  now += APNS_TOKEN_REUSE_MS - 1000;
  assert.equal(sender.providerToken(), first, 'inside the window');
  assert.ok(APNS_TOKEN_REUSE_MS < 60 * 60_000, 'Apple wants a new token at least hourly');
  assert.ok(APNS_TOKEN_REUSE_MS >= 20 * 60_000, 'and no more than every 20 minutes');
  now += 2000;
  const next = sender.providerToken();
  assert.notEqual(next, first);
  assert.equal(verifyProviderToken(next, publicKey).claims.iat, Math.floor(now / 1000));
});

test("Apple's hosts are fixed: the test origin is refused unless it is a plain loopback address, and the key file is read when a token is made", () => {
  for (const bad of ['https://api.push.apple.com', 'http://api.push.apple.com', 'http://example.com:8080', 'https://127.0.0.1:8443', 'http://127.0.0.1:8080/path', 'http://user@127.0.0.1:8080']) {
    assert.throws(() => new ApnsSender({ config, testOrigin: bad }), /tests only/, bad);
  }
  assert.doesNotThrow(() => new ApnsSender({ config, testOrigin: 'http://127.0.0.1:9' }));
  const missing = new ApnsSender({ config: { ...config, keyFile: join(dir, 'missing.p8') }, testOrigin: 'http://127.0.0.1:9' });
  assert.throws(() => missing.providerToken());
});

test('with previews off the alert is generic; with them on it is the text ntfy would carry; the Boton is the thread, and the ids are the ones the app opens', async () => {
  const { devices } = setup();
  devices.register('dev_phone', TOKEN_A, 'production');
  apple.calls.length = 0;

  const off = await notifier(devices, { preview: false }).push(request({ messageId: 'msg_7' }));
  assert.equal(off.length, 1);
  assert.equal(off[0].channel, 'apns');
  assert.equal(off[0].ok, true);
  assert.deepEqual(apple.calls[0].body, {
    aps: { alert: { title: 'Kevin', body: 'New notification.' }, sound: 'default', 'thread-id': 'bot_kevin' },
    botId: 'bot_kevin',
    messageId: 'msg_7',
  });
  assert.ok(!JSON.stringify(apple.calls[0].body).includes('staging deploy'), 'no text beyond what ntfy would carry');

  const on = await notifier(devices, { preview: true }).push(request({ approvalId: 'apr_9', reason: 'approval' }));
  assert.equal(on[0].reason, 'approval');
  assert.deepEqual(apple.calls[1].body, {
    aps: { alert: { title: 'Kevin', body: 'The staging deploy finished with 2 warnings.' }, sound: 'default', 'thread-id': 'bot_kevin' },
    botId: 'bot_kevin',
    approvalId: 'apr_9',
  });

  // A push about no Boton (a connector that needs signing in) has no thread and no Boton id.
  await notifier(devices).push(request({ bot: null, reason: 'failure', detail: 'The connector Notes needs signing in again.', generic: 'A connector needs signing in again.' }));
  assert.deepEqual(apple.calls[2].body, { aps: { alert: { title: 'Botons', body: 'A connector needs signing in again.' }, sound: 'default' } });

  // The text is cut as ntfy cuts it.
  await notifier(devices, { preview: true }).push(request({ detail: 'x'.repeat(500) }));
  assert.equal(apple.calls[3].body.aps.alert.body.length, 200);
  // A team's escalation opens the card (botId and messageId, which any build routes) and names the team and item.
  await notifier(devices).push(request({ reason: 'team', messageId: 'msg_card', teamId: 'team_atlas', itemId: 'item_schema', detail: 'Atlas: Schema review needs you', generic: 'A team needs you.' }));
  assert.deepEqual(apple.calls[4].body, {
    aps: { alert: { title: 'Kevin', body: 'A team needs you.' }, sound: 'default', 'thread-id': 'bot_kevin' },
    botId: 'bot_kevin',
    messageId: 'msg_card',
    teamId: 'team_atlas',
    itemId: 'item_schema',
  });
});

test('a 410, or a 400 BadDeviceToken, removes that registration only; other failures keep it and say why', async () => {
  const { devices } = setup();
  devices.register('dev_phone', TOKEN_A, 'production');
  devices.register('dev_tablet', TOKEN_B, 'development');
  const n = notifier(devices);

  apple.answer(TOKEN_A, 410, 'Unregistered', 1);
  const gone = await n.push(request());
  assert.deepEqual(devices.all().map((d) => d.deviceId), ['dev_tablet'], 'the registration Apple refused is gone, the other stays');
  assert.equal(gone[0].ok, true, 'and one delivered, so the push went through');
  assert.equal(devices.get('dev_tablet')!.lastResult, 'delivered');

  apple.answer(TOKEN_B, 400, 'BadDeviceToken', 1);
  const last = await n.push(request());
  assert.deepEqual(devices.all(), [], 'BadDeviceToken too');
  assert.equal(last[0].ok, false, 'nothing delivered');
  assert.equal(last[0].status, 400);
  assert.equal(last[0].error, 'HTTP 400: BadDeviceToken');
  assert.deepEqual(await n.push(request()), [], 'nothing is sent with no registration');

  // Anything else keeps the registration, with how it went.
  devices.register('dev_phone', TOKEN_C, 'production');
  const logs = captureLogs();
  apple.answer(TOKEN_C, 403, 'InvalidProviderToken', 1);
  const refused = await n.push(request());
  logs.restore();
  assert.equal(refused[0].ok, false);
  assert.equal(refused[0].status, 403);
  assert.equal(devices.get('dev_phone')!.lastResult, 'refused (InvalidProviderToken)');
  assert.ok(logs.lines.some((l) => l.msg === 'push failed') && !JSON.stringify(logs.lines).includes(TOKEN_C), 'logged, without the device token');

  apple.answer(TOKEN_C, 500, 'InternalServerError', 1);
  await n.push(request());
  assert.equal(devices.get('dev_phone')!.lastResult, 'server-error (InternalServerError)');
  const ok = await n.push(request());
  assert.equal(ok[0].ok, true);
  assert.equal(devices.get('dev_phone')!.lastResult, 'delivered');
});

test('a refused provider token is made again for the next push', async () => {
  const { devices } = setup();
  devices.register('dev_phone', TOKEN_A, 'production');
  const sender = new ApnsSender({ config, testOrigin: apple.origin });
  const first = sender.providerToken();
  apple.answer(TOKEN_A, 403, 'ExpiredProviderToken', 1);
  assert.equal((await notifier(devices, { sender }).push(request()))[0].ok, false);
  assert.equal(sender.providerToken() === first, false, 'it was dropped, so the next request signs again');
});

test('failures are fixed words (timeout, unreachable) and Health counts them; a push that goes through clears the streak', async () => {
  const { devices } = setup();
  devices.register('dev_phone', TOKEN_A, 'production');
  const quick = new ApnsSender({ config, testOrigin: apple.origin, timeoutMs: 60 });
  const n = notifier(devices, { sender: quick });
  assert.deepEqual(n.status().apns, { devices: 1, last: null, lastSuccessAt: null, failuresInARow: 0, since: n.status().apns!.since });

  apple.hang(TOKEN_A);
  const slow = await n.push(request());
  assert.equal(slow[0].ok, false);
  assert.equal(slow[0].status, null);
  assert.equal(slow[0].error, 'timeout');
  assert.equal(n.status().apns!.last!.problem, 'timeout');
  assert.equal(n.status().apns!.failuresInARow, 1);

  const closed = await fakeApns();
  const dead = new ApnsSender({ config, testOrigin: closed.origin });
  await closed.close();
  const m = notifier(devices, { sender: dead });
  const down = await m.push(request());
  assert.equal(down[0].error, 'unreachable');
  await m.push(request());
  const status = m.status().apns!;
  assert.equal(status.last!.problem, 'unreachable');
  assert.equal(status.failuresInARow, 2);
  assert.equal(status.lastSuccessAt, null);
  assert.equal(devices.all().length, 1, 'a failure to reach Apple keeps the registration');
  assert.equal(JSON.stringify(status).includes(TOKEN_A), false, 'Health never holds a device token');

  const okSender = new ApnsSender({ config, testOrigin: apple.origin });
  const fixed = notifier(devices, { sender: okSender });
  apple.calls.length = 0;
  // A new token: the hanging one is the old one.
  devices.register('dev_phone', TOKEN_B, 'production');
  assert.equal((await fixed.push(request()))[0].ok, true);
  assert.equal(fixed.status().apns!.failuresInARow, 0);
  assert.ok(fixed.status().apns!.lastSuccessAt);
});

test('without the Apple settings there is no APNs status, and nothing sends; a registered device makes pushes possible, none does not', async () => {
  const { devices } = setup();
  const plain = new Notifier({ config: () => null, publicUrl: () => 'http://127.0.0.1:7777' });
  assert.equal('apns' in plain.status(), false);
  assert.equal(plain.enabled, false);
  assert.deepEqual(await plain.push(request()), []);

  const n = notifier(devices);
  assert.equal(n.enabled, false, 'set up, but no device has registered');
  assert.deepEqual(await n.push(request()), []);
  devices.register('dev_phone', TOKEN_A, 'production');
  assert.equal(n.enabled, true);
  devices.remove('dev_phone');
  assert.equal(n.enabled, false);
});

test('a registration is one per device, one phone is one token, and it goes with the device', () => {
  const { db, devices } = setup();
  const first = devices.register('dev_phone', TOKEN_A.toUpperCase(), 'development');
  assert.equal(first.environment, 'development');
  assert.equal(devices.all()[0].token, TOKEN_A, 'stored in lower case');
  devices.setResult(devices.all()[0], 'delivered');
  // The same token and environment again keeps what is known about it; a change starts over.
  assert.equal(devices.register('dev_phone', TOKEN_A, 'development').lastResult, 'delivered');
  assert.equal(devices.register('dev_phone', TOKEN_A, 'production').lastResult, null);
  // Another device registering the same token takes it over.
  devices.register('dev_tablet', TOKEN_A, 'production');
  assert.deepEqual(devices.all().map((d) => d.deviceId), ['dev_tablet']);
  // A result for a token the device no longer has is not recorded, and neither is a removal of it.
  const read = devices.all()[0];
  devices.register('dev_tablet', TOKEN_B, 'production');
  devices.setResult(read, 'refused');
  devices.removeIfUnchanged(read);
  assert.equal(devices.get('dev_tablet')!.lastResult, null);
  assert.equal(devices.count(), 1);
  // The same token saved again is a newer registration too: what a push read before it does not touch it.
  const again = devices.all()[0];
  devices.register('dev_tablet', TOKEN_B, 'production');
  devices.setResult(again, 'refused');
  devices.removeIfUnchanged(again);
  assert.equal(devices.count(), 1);
  assert.equal(devices.get('dev_tablet')!.lastResult, null);
  // The one it read, unchanged, is removed.
  devices.removeIfUnchanged(devices.all()[0]);
  assert.equal(devices.count(), 0);
  devices.register('dev_tablet', TOKEN_B, 'production');
  // Revoking the device (its token row) deletes the registration.
  db.prepare("delete from auth_tokens where id = 'dev_tablet'").run();
  assert.equal(devices.count(), 0);
  assert.throws(() => devices.register('dev_nobody', TOKEN_C, 'production'), /FOREIGN KEY/);
});

test('the settings are all four or none; a partial set fails with the names that are missing, and a bad key says what is wrong without its content', () => {
  const env = (extra: Record<string, string>) => ({ BOTONS_HOME: tempDir('botons-apns-config-'), BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1', ...extra });
  const all = { BOTONS_APNS_KEY_FILE: keyFile, BOTONS_APNS_KEY_ID: 'TESTKEY123', BOTONS_APNS_TEAM_ID: 'TEAM123456', BOTONS_APNS_TOPIC: 'com.example.botons' };
  const errors = (extra: Record<string, string>): string[] => {
    try {
      loadConfig(env(extra));
    } catch (err) {
      if (err instanceof ConfigError) return err.errors;
      throw err;
    }
    return [];
  };

  assert.equal(loadConfig(env({})).apns, null, 'none: off');
  assert.deepEqual(loadConfig(env(all)).apns, config);
  assert.equal(loadConfig(env({ BOTONS_APNS_KEY_FILE: '', BOTONS_APNS_KEY_ID: ' ', BOTONS_APNS_TEAM_ID: '', BOTONS_APNS_TOPIC: '  ' })).apns, null, 'empty counts as unset');
  assert.equal(errors({ ...all, BOTONS_APNS_TOPIC: '  ' }).length, 1, 'one empty of the four is a partial set');

  for (const name of Object.keys(all) as (keyof typeof all)[]) {
    const { [name]: _left, ...partial } = all;
    const found = errors(partial);
    assert.equal(found.length, 1, name);
    assert.match(found[0], new RegExp(`^${name} is not set: push to the app needs all of BOTONS_APNS_KEY_FILE, BOTONS_APNS_KEY_ID, BOTONS_APNS_TEAM_ID, BOTONS_APNS_TOPIC, or none of them`));
  }
  assert.match(errors({ BOTONS_APNS_KEY_ID: 'TESTKEY123' })[0], /^BOTONS_APNS_KEY_FILE, BOTONS_APNS_TEAM_ID, BOTONS_APNS_TOPIC are not set/);

  assert.match(errors({ ...all, BOTONS_APNS_KEY_ID: 'short' })[0], /BOTONS_APNS_KEY_ID must be/);
  assert.match(errors({ ...all, BOTONS_APNS_TEAM_ID: 'lower12345' })[0], /BOTONS_APNS_TEAM_ID must be/);
  assert.match(errors({ ...all, BOTONS_APNS_TOPIC: 'bad topic!' })[0], /BOTONS_APNS_TOPIC must be/);
  assert.match(errors({ ...all, BOTONS_APNS_KEY_FILE: join(dir, 'nope.p8') })[0], /BOTONS_APNS_KEY_FILE cannot be read \(ENOENT\)/);

  const junk = join(dir, 'junk.p8');
  writeFileSync(junk, 'this is not a key SECRETCONTENT\n');
  const notAKey = errors({ ...all, BOTONS_APNS_KEY_FILE: junk });
  assert.match(notAKey[0], /does not hold a private key in PEM form/);
  const rsa = join(dir, 'rsa.p8');
  writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const wrongType = errors({ ...all, BOTONS_APNS_KEY_FILE: rsa });
  assert.match(wrongType[0], /must hold an EC P-256 private key/);
  const p384 = join(dir, 'p384.p8');
  writeFileSync(p384, generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.match(errors({ ...all, BOTONS_APNS_KEY_FILE: p384 })[0], /must hold an EC P-256 private key/);
  for (const message of [...notAKey, ...wrongType]) assert.ok(!/SECRETCONTENT|BEGIN/.test(message), 'never what the file holds');
});

test('a push that finishes after the device registered a new token neither removes nor marks the newer registration', async () => {
  const { devices } = setup();
  devices.register('dev_phone', TOKEN_E, 'production');
  const n = notifier(devices);

  // Apple answers 410 for the old token, slowly; meanwhile the app registers a new one.
  apple.answer(TOKEN_E, 410, 'Unregistered', 1);
  apple.delay(TOKEN_E, 60);
  const pending = n.push(request());
  await new Promise((r) => setTimeout(r, 15));
  devices.register('dev_phone', TOKEN_F, 'production');
  await pending;
  assert.deepEqual(devices.all().map((d) => [d.deviceId, d.token]), [['dev_phone', TOKEN_F]], 'the newer registration stays');
  assert.equal(devices.get('dev_phone')!.lastResult, null, 'and is not marked with the old one\'s result');

  // The same for a failure that is not a removal, and for one that registered the same token again.
  apple.answer(TOKEN_F, 503, 'ServiceUnavailable', 1);
  apple.delay(TOKEN_F, 60);
  const second = n.push(request());
  await new Promise((r) => setTimeout(r, 15));
  devices.register('dev_phone', TOKEN_F, 'production');
  await second;
  assert.equal(devices.get('dev_phone')!.lastResult, null);
  apple.delay(TOKEN_F, 0);
});

test('a payload is at most 4096 UTF-8 bytes: the body is cut on whole characters, then the title, and the ids stay', async () => {
  const { devices } = setup();
  devices.register('dev_phone', TOKEN_D, 'production');
  apple.calls.length = 0;
  const n = notifier(devices, { preview: true });
  // 200 four-byte characters is 800 bytes: it fits as it is.
  await n.push(request({ detail: '😀'.repeat(300) }));
  const fits = apple.calls[0].body;
  assert.ok(fits.aps.alert.body.isWellFormed(), 'cut by ntfy\'s 200-unit rule in the middle of an emoji, the half is dropped');
  assert.ok(fits.aps.alert.body.endsWith('…'));
  // A Boton's name is not cut by the push: a long one with a long text does not fit.
  await n.push(request({ bot: { id: 'bot_kevin', name: 'é'.repeat(1500) + '😀'.repeat(900) }, detail: '😀'.repeat(300), messageId: 'msg_1' }));
  const body = apple.calls[1].body;
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 4096, `${Buffer.byteLength(JSON.stringify(body))} bytes`);
  assert.ok(body.aps.alert.title.endsWith('…'));
  assert.ok(body.aps.alert.title.isWellFormed() && body.aps.alert.body.isWellFormed(), 'no character was split');
  assert.equal(body.botId, 'bot_kevin');
  assert.equal(body.messageId, 'msg_1');
  assert.equal(body.aps['thread-id'], 'bot_kevin');
  assert.ok(body.aps.alert.body.length > 0);
});

test("the provider token's signature is raw r and s (IEEE P1363, 64 bytes), which a DER check does not accept", () => {
  const jwt = new ApnsSender({ config, testOrigin: apple.origin }).providerToken();
  const [h, c, sig] = jwt.split('.');
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'der' }, Buffer.from(sig, 'base64url')), false);
});

test("Apple's hosts are the defaults, an unused connection is closed, and closing the sender ends them all", async () => {
  const sender = new ApnsSender({ config });
  assert.equal(sender.originFor('production'), 'https://api.push.apple.com');
  assert.equal(sender.originFor('development'), 'https://api.sandbox.push.apple.com');
  assert.equal(new ApnsSender({ config, testOrigin: apple.origin }).originFor('production'), apple.origin);

  const own = await fakeApns();
  const idle = new ApnsSender({ config, testOrigin: own.origin, idleMs: 60 });
  assert.equal((await idle.send({ token: TOKEN_D, environment: 'production' }, { aps: {} })).ok, true);
  assert.equal(own.connections(), 1);
  await until(() => own.connections() === 0);
  assert.equal((await idle.send({ token: TOKEN_D, environment: 'production' }, { aps: {} })).ok, true, 'the next push opens a new connection');
  idle.close();
  await until(() => own.connections() === 0);
  const after = await idle.send({ token: TOKEN_D, environment: 'production' }, { aps: {} });
  assert.equal(after.ok, false);
  assert.equal(after.problem, 'unreachable');
  assert.equal(own.connections(), 0);
  await own.close();
});

test("a 410 removes the registration only when Apple's time is at or after the one it was saved: earlier, or no usable time, keeps it and records the failure", async () => {
  const { devices } = setup();
  const n = notifier(devices);
  const saved = (token: string) => {
    devices.register('dev_phone', token, 'production');
    return Date.parse(devices.get('dev_phone')!.updatedAt);
  };
  const T = 'a7'.repeat(32);

  // Before the registration: the token was dropped, then registered again; kept.
  let at = saved(T);
  apple.answer(T, 410, 'Unregistered', 1, { timestamp: at - 1000 });
  const earlier = await n.push(request());
  assert.equal(devices.count(), 1, 'kept');
  assert.equal(devices.get('dev_phone')!.lastResult, 'rejected (Unregistered)');
  assert.equal(earlier[0].ok, false, 'and it is a failure, not a removal');
  assert.equal(earlier[0].status, 410);
  assert.equal(n.status().apns!.failuresInARow, 1);

  // Exactly at it, and after it: removed.
  for (const offset of [0, 5000]) {
    at = saved(T);
    apple.answer(T, 410, 'Unregistered', 1, { timestamp: at + offset });
    await n.push(request());
    assert.equal(devices.count(), 0, `removed with a time ${offset} ms after`);
  }

  // Not a usable time: kept, whatever else the answer says.
  const bad: [string, unknown][] = [['missing', undefined], ['a string', String(Date.now())], ['null', null], ['negative', -5], ['zero', 0], ['fractional', Date.now() + 0.5], ['seconds, not milliseconds', Math.floor(Date.now() / 1000)], ['absurdly far ahead', Date.now() + 1e12], ['an object', { ms: 1 }]];
  for (const [what, timestamp] of bad) {
    saved(T);
    apple.answer(T, 410, 'Unregistered', 1, { timestamp });
    const r = await n.push(request());
    assert.equal(devices.count(), 1, `kept: ${what}`);
    assert.equal(devices.get('dev_phone')!.lastResult, 'rejected (Unregistered)', what);
    assert.equal(r[0].ok, false, what);
  }

  // A 400 BadDeviceToken has no time to compare, and is handled as before.
  apple.answer(T, 400, 'BadDeviceToken', 1);
  await n.push(request());
  assert.equal(devices.count(), 0);
  // A 410 whose registration was replaced while it was in flight is still left alone (the newer one has its own time).
  const U = 'b8'.repeat(32);
  const V = 'c9'.repeat(32);
  saved(U);
  apple.answer(U, 410, 'Unregistered', 1, { delayMs: 40 });
  const inFlight = n.push(request());
  await new Promise((r) => setTimeout(r, 15));
  devices.register('dev_phone', V, 'production');
  await inFlight;
  assert.deepEqual(devices.all().map((d) => d.token), [V]);
});

test('pushes that finish out of order leave the newest outcome: the aggregate status and a device\'s last result are not overwritten by an older attempt', async () => {
  const { devices } = setup();
  const T = 'd0'.repeat(32);
  devices.register('dev_phone', T, 'production');
  const n = notifier(devices);

  // A starts first and fails late; B starts second and succeeds at once.
  apple.answer(T, 503, 'ServiceUnavailable', 1, { delayMs: 40 });
  const a = n.push(request());
  await new Promise((r) => setTimeout(r, 15));
  const b = n.push(request());
  const [da, db] = [await a, await b];
  assert.equal(da[0].ok, false, 'each attempt still reports its own outcome');
  assert.equal(db[0].ok, true);
  const status = n.status().apns!;
  assert.equal(status.last!.ok, true, 'but the status is the newer one');
  assert.equal(status.failuresInARow, 0);
  assert.ok(status.lastSuccessAt);
  assert.equal(devices.get('dev_phone')!.lastResult, 'delivered');

  // The other way round: the newer attempt fails first, the older one succeeds late; the failure stays.
  apple.answer(T, 200, undefined, 1, { delayMs: 40 });
  const c = n.push(request());
  await new Promise((r) => setTimeout(r, 15));
  apple.answer(T, 503, 'ServiceUnavailable', 1);
  const d = n.push(request());
  await Promise.all([c, d]);
  assert.equal(n.status().apns!.last!.ok, false);
  assert.equal(n.status().apns!.failuresInARow, 1);
  assert.equal(devices.get('dev_phone')!.lastResult, 'server-error (ServiceUnavailable)');
});

for (const status of [400, 410]) {
  test(`an older ${status} cannot remove a registration after a newer delivery succeeded`, async () => {
    const { devices } = setup();
    devices.register('dev_phone', TOKEN_A, 'production');
    const first = Promise.withResolvers<Awaited<ReturnType<ApnsSender['send']>>>();
    const started = Promise.withResolvers<void>();
    const sender = new ApnsSender({ config, testOrigin: apple.origin });
    let calls = 0;
    sender.send = async () => {
      if (++calls === 1) { started.resolve(); return first.promise; }
      return { ok: true, status: 200, reason: null, gone: false, goneAt: null, problem: null };
    };
    const n = notifier(devices, { sender });
    const older = n.push(request());
    await started.promise;
    await n.push(request());
    first.resolve({ ok: false, status, reason: status === 410 ? 'Unregistered' : 'BadDeviceToken',
      gone: true, goneAt: status === 410 ? Date.now() : null, problem: 'rejected' });
    await older;
    assert.equal(devices.get('dev_phone')?.lastResult, 'delivered');
    assert.equal(n.status().apns?.last?.ok, true);
    assert.equal(n.status().apns?.failuresInARow, 0);
    assert.equal((await n.push(request()))[0]?.ok, true, 'later pushes still reach the registered device');
    assert.equal(calls, 3);
    sender.close();
  });
}
