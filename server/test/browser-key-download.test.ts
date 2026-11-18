import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:https';
import { test } from 'node:test';
import type { Download } from 'playwright-core';
import { BrowserKeyDownload } from '../src/browser-key-download.ts';
import { findBrowser } from '../src/browser.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import type { BrowserActionResult } from '../../shared/types.ts';
import { freePort, startServer, tempDir, until } from './helpers.ts';

const KEY_ID = 'AB12CD34EF';
const PAGE = 'https://example.com/keys';
const pem = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
function grant(dir: string, change: Record<string, unknown> = {}) {
  const metadata = join(dir, existsSync(join(dir, 'session-bot_fixture-agent.json')) ? 'session-bot_fixture-agent.json' : 'session-bot_fixture-owner.json');
  const session = change.session ?? JSON.parse(readFileSync(metadata, 'utf8')).session;
  writeFileSync(join(dir, 'allow-once.json'), JSON.stringify({ kind: 'apns', botId: 'bot_fixture', actor: 'agent', session, origin: 'https://example.com', keyId: KEY_ID, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...change }), { mode: 0o600 });
}
function setup(alive = () => true, actor: 'agent' | 'owner' = 'agent') {
  const dir = tempDir('key-private-');
  chmodSync(dir, 0o700);
  const sink = new BrowserKeyDownload(dir, [], 'bot_fixture', actor, alive);
  return { dir, sink, target: join(dir, `AuthKey_${KEY_ID}.p8`) };
}
function download(bytes = pem(), url = 'https://example.com/key', filename = `AuthKey_${KEY_ID}.p8`) {
  const calls = { cancel: 0, delete: 0 };
  const d = { url: () => url, suggestedFilename: () => filename, createReadStream: async () => Readable.from([bytes]), cancel: async () => { calls.cancel++; }, delete: async () => { calls.delete++; } } as unknown as Download;
  return { d, calls };
}

test('only a fresh private operator grant and explicit matching input import a key, with private no-overwrite publication', async () => {
  const { dir, sink, target } = setup();
  try {
    const no = download();
    assert.equal(await sink.capture(no.d, PAGE), 'refused');
    assert.equal(no.calls.cancel, 1);
    assert.ok(!existsSync(target));
    grant(dir);
    assert.equal(sink.intent(PAGE), true);
    const one = download();
    assert.equal(await sink.capture(one.d, PAGE), 'saved');
    assert.equal(await sink.finish(), 'saved');
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.ok(!existsSync(join(dir, 'allow-once.json')));
    assert.equal(sink.intent(PAGE), false, 'spent grant does not replay');
    assert.equal(JSON.parse(readFileSync(join(dir, 'download-receipt.json'), 'utf8')).status, 'saved');
    assert.ok(!readFileSync(join(dir, 'download-receipt.json'), 'utf8').includes('PRIVATE KEY'));
    grant(dir);
    assert.equal(sink.intent(PAGE), false, 'an existing credential cannot be overwritten');
    assert.ok(readdirSync(sink.staging).length === 0);
  } finally { sink.close(); }
});

test('wrong Boton, actor, origin, expiry and private grant permissions do not arm', () => {
  const { dir, sink } = setup();
  try {
    for (const change of [{ botId: 'bot_other' }, { actor: 'owner' }, { session: 'another-session' }, { origin: 'http://example.com' }, { origin: 'https://other.example.com' }, { keyId: '../escape' }, { expiresAt: new Date(0).toISOString() }, { expiresAt: new Date(Date.now() + 11 * 60_000).toISOString() }]) {
      grant(dir, change); assert.equal(sink.intent(PAGE), false);
    }
    grant(dir); chmodSync(join(dir, 'allow-once.json'), 0o644);
    assert.equal(sink.intent(PAGE), false);
  } finally { sink.close(); }
});

test('a grant accepts a same-origin blob, but no other name, origin, format, curve or large import', async () => {
  for (const kind of ['blob', 'name', 'origin', 'format', 'curve', 'size']) {
    const { dir, sink, target } = setup();
    try {
      grant(dir); assert.equal(sink.intent(PAGE), true);
      const body = kind === 'format' ? 'not a key' : kind === 'size' ? 'x'.repeat(8193) : kind === 'curve' ? generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string : pem();
      const { d } = download(body, kind === 'blob' ? 'blob:https://example.com/fixture' : kind === 'origin' ? 'https://other.example.com/key' : 'https://example.com/key', kind === 'name' ? '../../other.p8' : `AuthKey_${KEY_ID}.p8`);
      const expected = kind === 'blob' ? 'saved' : ['name', 'origin'].includes(kind) ? 'refused' : 'failed';
      assert.equal(await sink.capture(d, PAGE), expected, kind);
      assert.equal(await sink.finish(), expected, kind);
      assert.equal(existsSync(target), kind === 'blob', kind);
    } finally { sink.close(); }
  }
});

test('two contexts can claim only once; closing or revoking a session cannot publish', async () => {
  const { dir, sink, target } = setup();
  const other = new BrowserKeyDownload(dir, [], 'bot_fixture', 'agent', () => true);
  try {
    grant(dir, { session: sink.session }); assert.ok(sink.intent(PAGE)); assert.equal(other.intent(PAGE), false);
    const results = await Promise.all([sink.capture(download().d, PAGE), other.capture(download().d, PAGE)]);
    assert.deepEqual(results.sort(), ['refused', 'saved']);
    assert.ok(existsSync(target));
  } finally { sink.close(); other.close(); }
  let alive = true;
  const revoked = setup(() => alive);
  try {
    grant(revoked.dir); assert.ok(revoked.sink.intent(PAGE)); alive = false;
    assert.equal(await revoked.sink.capture(download().d, PAGE), 'refused');
    assert.ok(!existsSync(revoked.target));
  } finally { revoked.sink.close(); }
  const closed = setup(); grant(closed.dir); assert.ok(closed.sink.intent(PAGE)); closed.sink.close();
  assert.equal(await closed.sink.finish(), 'failed');
});

test('linked directories, forbidden destinations and linked credential targets are refused', () => {
  const root = tempDir('key-parent-');
  const dir = join(root, 'private'); mkdirSync(dir, { mode: 0o700 });
  const link = join(root, 'link'); symlinkSync(dir, link);
  assert.throws(() => new BrowserKeyDownload(link, [], 'bot_fixture', 'agent', () => true));
  assert.throws(() => new BrowserKeyDownload(dir, [root], 'bot_fixture', 'agent', () => true));
  const s = setup();
  try { symlinkSync(join(root, 'existing'), s.target); grant(s.dir); assert.equal(s.sink.intent(PAGE), false); }
  finally { s.sink.close(); }
});

test('a private recovery copy survives publication failure without overwriting a credential', async () => {
  const { dir, sink, target } = setup();
  try {
    grant(dir); assert.ok(sink.intent(PAGE));
    writeFileSync(target, 'owner fixture', { mode: 0o600 });
    assert.equal(await sink.capture(download().d, PAGE), 'failed');
    assert.equal(readFileSync(target, 'utf8'), 'owner fixture');
    const pending = readdirSync(dir).filter(n => n.startsWith('.capture-'));
    assert.equal(pending.length, 1);
    assert.equal(statSync(join(dir, pending[0], `AuthKey_${KEY_ID}.p8`)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(dir, 'download-receipt.json'), 'utf8')).status, 'private-recovery-needed');
  } finally { sink.close(); }
});

test('a stalled import is cancelled on its finite timeout without returning bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { dir, sink, target } = setup();
  try {
    grant(dir); assert.ok(sink.intent(PAGE));
    const { d, calls } = download();
    d.createReadStream = () => new Promise(() => {});
    const pending = sink.capture(d, PAGE);
    t.mock.timers.tick(10_001);
    assert.equal(await pending, 'failed');
    assert.equal(await sink.finish(), 'failed');
    assert.ok(calls.cancel > 0);
    assert.ok(!existsSync(target));
  } finally { sink.close(); }
});

test('managed browser click captures an authorized HTTPS attachment and Blob privately; unarmed download stays refused', async () => {
  const tls = tempDir('key-fixture-tls-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = readFileSync(join(tls, 'cert.pem'), 'utf8');
  const key = readFileSync(join(tls, 'key.pem'), 'utf8');
  const keyBody = pem();
  const port = await freePort();
  const url = `https://127.0.0.1:${port}`;
  const site = createServer({ key, cert }, (req, res) => {
    if (req.url === '/key') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="AuthKey_${KEY_ID}.p8"` });
      res.end(keyBody); return;
    }
    if (req.url === '/blob-key') { res.end(keyBody); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<a href="/key">Download attachment</a><button id="blob">Download Blob</button><script>document.querySelector('button').onclick=async()=>{const body=await fetch('/blob-key').then(r=>r.text());const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([body]));a.download='AuthKey_${KEY_ID}.p8';a.click();}</script>`);
  });
  await new Promise<void>(r => site.listen(port, '127.0.0.1', r));
  const root = tempDir('key-capture-private-'); chmodSync(root, 0o700);
  const found = await findBrowser(''); assert.ok(found.executable);
  const s = await startServer({ env: { BOTONS_BROWSER_PATH: found.executable!, BOTONS_BROWSER_APNS_DOWNLOAD_DIR: root } });
  assert.ok(s.cfg.privatePaths.includes(root), 'the capture directory is automatically hidden from Workspace tools');
  const { createPublicKey, createHash } = await import('node:crypto');
  s.app.browser.testTrust = { cert, spki: createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('base64') };
  try {
    for (const variant of ['attachment', 'blob']) {
      const bot = await s.newBot('Kevin', { provider: 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
      await s.call('PUT', `/api/bots/${bot.id}/browser`, { sites: [`127.0.0.1:${port}`] });
      const token = s.app.auth.mintBotonToken(bot.id); s.app.browser.beginTurn(bot.id, token.id);
      const act = async (body: Record<string, unknown>) => {
        const r = await s.call<BrowserActionResult>('POST', `/api/bots/${bot.id}/browser/actions`, body, token.token);
        assert.equal(r.status, 200); return r.data;
      };
      await act({ action: 'open', url });
      const controls = (await act({ action: 'read' })).content!.controls;
      const control = controls.find(c => c.label === (variant === 'attachment' ? 'Download attachment' : 'Download Blob'))!;
      if (variant === 'attachment') {
        await act({ action: 'click', ref: control.ref });
        assert.equal(existsSync(join(root, `AuthKey_${KEY_ID}.p8`)), false);
        await act({ action: 'open', url }); await act({ action: 'read' });
      }
      const session = JSON.parse(readFileSync(join(root, `session-${bot.id}-agent.json`), 'utf8')).session;
      grant(root, { botId: bot.id, session, origin: url });
      const result = await act({ action: 'click', ref: control.ref });
      assert.equal(result.outcome, 'done', result.message);
      assert.match(result.message, /saved privately/);
      await until(() => existsSync(join(root, `AuthKey_${KEY_ID}.p8`)));
      assert.equal(statSync(join(root, `AuthKey_${KEY_ID}.p8`)).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
      assert.ok(!JSON.stringify(s.app.browser.journal(bot.id)).includes('PRIVATE KEY'));
      await s.app.browser.endTurn(bot.id, token.id); token.revoke();
      // Remove only the synthetic fixture key to test another transport; no real key is used here.
      const { unlinkSync } = await import('node:fs'); unlinkSync(join(root, `AuthKey_${KEY_ID}.p8`));
    }
    const ownerBot = await s.newBot('Stuart', { provider: 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
    await s.call('PUT', `/api/bots/${ownerBot.id}/browser`, { sites: [`127.0.0.1:${port}`] });
    const started = await s.call<{ id: string }>('POST', `/api/bots/${ownerBot.id}/browser/handover`, {});
    assert.equal(started.status, 201);
    const handover = started.data.id;
    const input = (body: Record<string, unknown>) => s.call('POST', `/api/bots/${ownerBot.id}/browser/handover/input`, { handover, ...body });
    await input({ action: 'open', url });
    const context = await s.app.browser.testOwnerJar(ownerBot.id);
    const box = await context!.pages()[0]!.locator('a').boundingBox(); assert.ok(box);
    const session = JSON.parse(readFileSync(join(root, `session-${ownerBot.id}-owner.json`), 'utf8')).session;
    grant(root, { botId: ownerBot.id, actor: 'owner', session, origin: url });
    const captured = await input({ action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert.equal(captured.status, 200);
    assert.equal(captured.data.outcome, 'done');
    assert.match(captured.data.message, /saved privately/);
    assert.ok(!JSON.stringify(captured.data).includes('PRIVATE KEY'));
    await s.call('POST', `/api/bots/${ownerBot.id}/browser/handover/finish`, { handover });
    assert.ok(existsSync(join(root, `AuthKey_${KEY_ID}.p8`)), 'saved credential survives private page closure');
  } finally { await s.stop(); site.closeAllConnections(); await new Promise<void>(r => site.close(() => r())); }
});
