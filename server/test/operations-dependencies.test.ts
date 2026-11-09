// Settings → Health: push delivery and disk space, the dependencies an owner can't see from a chat.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { AuditEvent, NotifyDelivery, OperationsStatus } from '../../shared/types.ts';
import { TEST_PUSH_LIMIT } from '../src/api.ts';
import { httpProblem, thrownProblem } from '../src/notify.ts';
import { STORAGE_LOW_BYTES, storageStatus } from '../src/storage.ts';
import { freePort, startServer, tempDir, until } from './helpers.ts';

/** The next responses of a fake ntfy server: a status, for redirects where to, and `hold` to answer only once it settles. */
const replies: { status: number; location?: string; hold?: Promise<void> }[] = [];
const ntfy = createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    const r = replies.shift() ?? { status: 200 };
    await r.hold;
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.location ? { location: r.location } : {}) });
    res.end(r.status === 200 ? '{"id":"abc"}' : '{"error":"private-detail-from-ntfy for topic sams-secret-topic"}');
  });
});
await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => ntfy.close(r)));
const ntfyUrl = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}`;

const s = await startServer();
const operations = async () => {
  const r = await s.call<OperationsStatus>('GET', '/api/operations');
  assert.equal(r.status, 200, r.text);
  return r.data;
};
const testPush = async () => {
  const r = await s.call<NotifyDelivery>('POST', '/api/notify/test');
  assert.equal(r.status, 200, r.text);
  return r.data;
};

test('push status: unset, then off, then a failing ntfy server is named with where to look, and a test that goes through clears it', async () => {
  let push = (await operations()).push;
  assert.equal(push.state, 'unset');
  assert.equal(push.last, null);

  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { enabled: false, server: ntfyUrl, topic: 'sams-secret-topic', token: 'tk_example' } })).status, 200);
  push = (await operations()).push;
  assert.equal(push.state, 'off');

  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { enabled: true } })).status, 200);
  // A real push about a failed run, refused by ntfy (a wrong token), then a test refused too.
  replies.push({ status: 401 }, { status: 401 });
  const [real] = await s.app.engine.notifier.push({ bot: null, reason: 'failure', detail: 'x', generic: 'A routine failed.', priority: 'high' });
  assert.equal(real.ok, false);
  assert.equal((await testPush()).ok, false);
  push = (await operations()).push;
  assert.equal(push.state, 'on');
  assert.equal(push.failuresInARow, 2);
  assert.equal(push.lastSuccessAt, null);
  assert.deepEqual({ ...push.last, at: undefined }, { at: undefined, ok: false, reason: 'test', status: 401, problem: 'refused' });

  const shown = JSON.stringify(await operations());
  assert.ok(!shown.includes('private-detail-from-ntfy') && !shown.includes('sams-secret-topic') && !shown.includes('tk_example') && !shown.includes(ntfyUrl), 'no error text, topic, token or URL');

  replies.push({ status: 200 });
  assert.equal((await testPush()).ok, true);
  push = (await operations()).push;
  assert.equal(push.failuresInARow, 0);
  assert.equal(push.last?.ok, true);
  assert.equal(push.lastSuccessAt, push.last?.at);
});

test('push status: redirects, server errors and an unreachable server each get their own word', async () => {
  replies.push({ status: 302, location: 'https://example.com/' });
  await testPush();
  assert.equal((await operations()).push.last?.problem, 'redirected');
  replies.push({ status: 503 });
  await testPush();
  assert.equal((await operations()).push.last?.problem, 'server-error');
  replies.push({ status: 404 });
  await testPush();
  assert.equal((await operations()).push.last?.problem, 'rejected');

  const closed = `http://127.0.0.1:${await freePort()}`;
  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { server: closed } })).status, 200);
  await testPush();
  const push = (await operations()).push;
  assert.equal(push.last?.problem, 'unreachable');
  assert.equal(push.last?.status, null);
  assert.equal(push.failuresInARow, 1, 'a new server URL starts the count again');
  assert.equal(push.sinceSettingsChange, true);
});

test('push problems: every status maps to a fixed word', () => {
  assert.equal(httpProblem(301), 'redirected');
  assert.equal(httpProblem(401), 'refused');
  assert.equal(httpProblem(403), 'refused');
  assert.equal(httpProblem(413), 'rejected');
  assert.equal(httpProblem(429), 'rejected');
  assert.equal(httpProblem(500), 'server-error');
  assert.equal(thrownProblem(new DOMException('The operation timed out.', 'TimeoutError')), 'timeout');
  assert.equal(thrownProblem(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), 'timeout');
  assert.equal(thrownProblem(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'unreachable');
});

test('storage: the real disk is read, with the database size and no path', async () => {
  const { storage } = await operations();
  assert.equal(storage.unreadable, false);
  assert.ok(storage.totalBytes > 0 && storage.freeBytes >= 0 && storage.freeBytes <= storage.totalBytes);
  assert.ok(storage.databaseBytes > 0, 'the database has a size');
  assert.equal(storage.lowBelowBytes, STORAGE_LOW_BYTES);
  assert.ok(!JSON.stringify(storage).includes(s.home));
});

test('storage: low below 1 GiB or below 5% of the disk; an unreadable disk is said so, without throwing', () => {
  const home = tempDir();
  const fs = (freeBlocks: number, blocks: number) => () => ({ bavail: BigInt(freeBlocks), blocks: BigInt(blocks), bsize: 4096n });
  const GiB = 1024 ** 3 / 4096;
  assert.equal(storageStatus({ home, dbPath: `${home}/none.db`, statfs: fs(10 * GiB, 100 * GiB) }).low, false);
  assert.equal(storageStatus({ home, dbPath: `${home}/none.db`, statfs: fs(GiB / 2, 4 * GiB) }).low, true, 'under 1 GiB');
  const big = storageStatus({ home, dbPath: `${home}/none.db`, statfs: fs(40 * GiB, 1000 * GiB) });
  assert.equal(big.low, true, 'under 5%');
  assert.equal(big.freeBytes, 40 * 1024 ** 3);
  const gone = storageStatus({
    home,
    dbPath: `${home}/none.db`,
    statfs: () => {
      throw Object.assign(new Error(`ENOENT: ${home}`), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(gone, { unreadable: true, freeBytes: 0, totalBytes: 0, databaseBytes: 0, low: false, lowBelowBytes: STORAGE_LOW_BYTES });
});

/** A reply held until `release()`. */
function held(status: number) {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  return { reply: { status, hold }, release };
}
const failure = () => s.app.engine.notifier.push({ bot: null, reason: 'failure', detail: 'x', generic: 'A routine failed.', priority: 'high' });
/** Once the fake server has taken every queued reply, so a held one is being waited on. */
const settle = () => until(() => replies.length === 0);

test('push status: an attempt to the old settings that finishes late never clears a failure to the new ones', async () => {
  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'topic-a', token: 'tk_a' } })).status, 200);
  const a = held(200);
  replies.push(a.reply);
  const toA = failure();
  await settle();
  // Switch to topic B while A is still being sent: B refuses it.
  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { topic: 'topic-b' } })).status, 200);
  let push = (await operations()).push;
  assert.deepEqual([push.last, push.failuresInARow, push.sinceSettingsChange], [null, 0, true], 'no attempt to B yet: nothing to report about it');
  replies.push({ status: 401 });
  assert.equal((await failure())[0].ok, false);
  a.release();
  assert.equal((await toA)[0].ok, true, 'A went through');
  push = (await operations()).push;
  assert.equal(push.last?.ok, false, "A's success is not B's");
  assert.equal(push.last?.problem, 'refused');
  assert.equal(push.failuresInARow, 1);
  assert.equal(push.lastSuccessAt, null);

  // The token changes too: a new count, though the topic is the same.
  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { token: 'tk_b2' } })).status, 200);
  push = (await operations()).push;
  assert.deepEqual([push.last, push.failuresInARow], [null, 0]);
  // Turning push off and on, or the preview, is not a new destination: the count stays.
  replies.push({ status: 401 });
  await failure();
  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { enabled: false } })).status, 200);
  assert.equal((await s.call('PATCH', '/api/settings', { ntfy: { enabled: true } })).status, 200);
  push = (await operations()).push;
  assert.equal(push.failuresInARow, 1);
  assert.equal(push.state, 'on');
});

test('push status: with the same settings, an older attempt that finishes after a newer one is not counted', async () => {
  const older = held(200);
  replies.push(older.reply);
  const first = failure();
  await settle();
  replies.push({ status: 503 });
  assert.equal((await failure())[0].ok, false);
  older.release();
  assert.equal((await first)[0].ok, true);
  const push = (await operations()).push;
  assert.equal(push.last?.problem, 'server-error', 'the newest attempt is what the status says');
  assert.equal(push.lastSuccessAt, null);
});

test('test push: one at a time, audited without the server, topic or token', async () => {
  const before = (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'notifications.tested').length;
  const h = held(401);
  replies.push(h.reply);
  const first = s.call<NotifyDelivery>('POST', '/api/notify/test');
  await settle();
  const second = await s.call('POST', '/api/notify/test');
  assert.equal(second.status, 409, second.text);
  h.release();
  assert.equal((await first).data.ok, false);
  const audit = (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'notifications.tested');
  assert.equal(audit.length, before + 1, 'the refused second try sent nothing and is not audited');
  assert.equal(audit[0].actor.kind, 'device');
  assert.deepEqual(audit[0].details, { ok: false, status: 401, problem: 'refused' });
  const row = JSON.stringify(audit[0]);
  for (const secret of [ntfyUrl, '127.0.0.1', 'topic-b', 'tk_', 'private-detail']) assert.ok(!row.includes(secret), secret);
});

test(`test push: at most ${TEST_PUSH_LIMIT} a minute`, async () => {
  const t = await startServer();
  assert.equal((await t.call('PATCH', '/api/settings', { ntfy: { enabled: true, server: ntfyUrl, topic: 'kevins-topic' } })).status, 200);
  for (let i = 0; i < TEST_PUSH_LIMIT; i++) assert.equal((await t.call('POST', '/api/notify/test')).status, 200);
  const over = await t.call('POST', '/api/notify/test');
  assert.equal(over.status, 429, over.text);
  const audit = (await t.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'notifications.tested');
  assert.equal(audit.length, TEST_PUSH_LIMIT);
});
