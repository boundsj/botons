// The one send of a request a card allowed (browser-send.ts): one deadline covers the proxy's connection, its answer to
// CONNECT, TLS, the request and the whole answer; when it passes or the send is withdrawn every socket it opened is
// destroyed, and delivery is said as known: not sent before a byte of the request left, unknown once it may have,
// sent once answered. Fake proxies and sites on loopback, with a certificate made for this run; no real sites.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBrowserProxy } from '../src/browser-proxy.ts';
import { type Delivery, type SendOptions, sendHeld } from '../src/browser-send.ts';
import { freePort, tempDir, until } from './helpers.ts';

const BUDGET = 150;
/** Well past the budget, well short of the guard below: a send still pending here ignored its deadline. */
const LATE = 1500;
const GUARD = 4000;

/** A loopback TCP server that does `onSocket` with each connection, and knows which are still open. */
async function raw(onSocket: (s: Socket) => void): Promise<{ port: number; seen: () => number; open: () => number; close: () => Promise<void> }> {
  const port = await freePort();
  const sockets = new Set<Socket>();
  let seen = 0;
  const server: Server = createServer((s) => {
    seen++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    // Read (and drop) what comes, so the end of the connection is seen.
    s.resume();
    onSocket(s);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    port,
    seen: () => seen,
    open: () => sockets.size,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Sends with a short budget and a guard that withdraws it much later; resolves with what it said and how long it took. */
async function timed(o: Partial<SendOptions> & Pick<SendOptions, 'proxy' | 'url'>, signal?: AbortSignal): Promise<{ d: Delivery; ms: number }> {
  const guard = new AbortController();
  const timer = setTimeout(() => guard.abort(), GUARD);
  const start = performance.now();
  try {
    const d = await sendHeld({
      method: 'POST',
      headers: [
        ['host', new URL(o.url).host],
        ['content-type', 'application/x-www-form-urlencoded'],
        ['content-length', '6'],
        ['connection', 'close'],
      ],
      body: Buffer.from('item=1'),
      ready: () => null,
      signal: signal ? AbortSignal.any([signal, guard.signal]) : guard.signal,
      timeoutMs: BUDGET,
      maxBody: 1 << 20,
      ...o,
    });
    return { d, ms: performance.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

const anyPass = { username: 'botons-send', password: 'x' };

test('a proxy that takes the connection and never answers CONNECT: not sent, within the budget, its socket closed', async () => {
  const proxy = await raw(() => {});
  try {
    const { d, ms } = await timed({ proxy: { port: proxy.port, ...anyPass }, url: 'http://127.0.0.1:9/notes' });
    assert.equal(d.delivery, 'not-sent', JSON.stringify(d));
    assert.ok(ms < LATE, `${ms}ms`);
    await until(() => proxy.open() === 0, 2000);
  } finally {
    await proxy.close();
  }
});

test('a tunnel whose far end never answers TLS: not sent, within the budget, every socket closed', async () => {
  // Says the tunnel is open, then sends nothing back: the TLS handshake waits forever.
  const proxy = await raw((s) => s.once('data', () => s.write('HTTP/1.1 200 Connection Established\r\n\r\n')));
  try {
    const { d, ms } = await timed({ proxy: { port: proxy.port, ...anyPass }, url: 'https://127.0.0.1:9/notes' });
    assert.equal(d.delivery, 'not-sent', JSON.stringify(d));
    assert.ok(ms < LATE, `${ms}ms`);
    await until(() => proxy.open() === 0, 2000);
  } finally {
    await proxy.close();
  }
});

test('withdrawn while it waits on CONNECT, or before it starts: not sent at once, and before it starts nothing connects', async () => {
  const proxy = await raw(() => {});
  try {
    const early = new AbortController();
    setTimeout(() => early.abort(), 30);
    let r = await timed({ proxy: { port: proxy.port, ...anyPass }, url: 'http://127.0.0.1:9/notes', timeoutMs: 10_000 }, early.signal);
    assert.equal(r.d.delivery, 'not-sent', JSON.stringify(r.d));
    assert.ok(r.ms < LATE, `${r.ms}ms`);
    await until(() => proxy.open() === 0, 2000);
    const before = proxy.seen();
    r = await timed({ proxy: { port: proxy.port, ...anyPass }, url: 'http://127.0.0.1:9/notes' }, AbortSignal.abort());
    assert.equal(r.d.delivery, 'not-sent');
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(proxy.seen(), before);
  } finally {
    await proxy.close();
  }
});

/** A certificate made for this run only (for 127.0.0.1), trusted by nothing but this send. */
function testCert(): { key: string; cert: string } {
  const dir = tempDir();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

/** A site behind the real browser proxy (sealed, as it is for a send), answering per path; and a pass for each send. */
async function site(tls?: { key: string; cert: string }) {
  const port = await freePort();
  const got: { method: string; url: string; headers: [string, string][]; body: string }[] = [];
  const open = new Set<Socket>();
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const headers: [string, string][] = [];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i].toLowerCase(), req.rawHeaders[i + 1]]);
      got.push({ method: req.method ?? '', url: req.url ?? '', headers, body });
      if (req.url === '/stall') return; // got it, never answers
      if (req.url === '/trickle') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
        return void res.write('part');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('saved');
    });
  };
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, handle) : createHttpServer(handle);
  server.on('connection', (s: Socket) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const proxy = await startBrowserProxy(() => ({ enabled: true, sites: [`127.0.0.1:${port}`] }), () => {});
  proxy.seal(true);
  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    got,
    open: () => open.size,
    pass: () => ({ port: proxy.port, ...proxy.passOnce('127.0.0.1', port) }),
    proxy,
    close: async () => {
      await proxy.close();
      for (const s of open) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

for (const scheme of ['http', 'https'] as const) {
  test(`over ${scheme}: sent exactly as given, once; a site that got it and never answers: unknown within the budget; an answer cut short: sent, no body`, async () => {
    const tls = scheme === 'https' ? testCert() : undefined;
    const s = await site(tls);
    try {
      const ca = tls?.cert;
      // Normal: the request goes exactly as given (no cookie, no header added), and its answer comes back.
      let r = await timed({ proxy: s.pass(), url: `${s.url}/notes?draft=1`, ca, timeoutMs: 5000 });
      assert.equal(r.d.delivery, 'sent', JSON.stringify(r.d));
      assert.equal(r.d.delivery === 'sent' && r.d.body?.toString(), 'saved');
      assert.deepEqual(s.got, [
        {
          method: 'POST',
          url: '/notes?draft=1',
          headers: [
            ['host', new URL(s.url).host],
            ['content-type', 'application/x-www-form-urlencoded'],
            ['content-length', '6'],
            ['connection', 'close'],
          ],
          body: 'item=1',
        },
      ]);
      await until(() => s.open() === 0 && s.proxy.inFlight().tunnels === 0 && s.proxy.inFlight().sockets === 0, 2000);

      // The site gets it and never answers: unknown (it may have acted), within the budget, nothing left open.
      s.got.length = 0;
      r = await timed({ proxy: s.pass(), url: `${s.url}/stall`, ca });
      assert.equal(r.d.delivery, 'unknown', JSON.stringify(r.d));
      assert.ok(r.ms < LATE, `${r.ms}ms`);
      assert.equal(s.got.length, 1);
      await until(() => s.open() === 0 && s.proxy.inFlight().sockets === 0, 2000);

      // It answers, then its body stalls: sent (its status is known), no body, within the budget.
      r = await timed({ proxy: s.pass(), url: `${s.url}/trickle`, ca });
      assert.equal(r.d.delivery, 'sent', JSON.stringify(r.d));
      assert.equal(r.d.delivery === 'sent' && r.d.body, null);
      assert.ok(r.ms < LATE, `${r.ms}ms`);
      await until(() => s.open() === 0 && s.proxy.inFlight().sockets === 0, 2000);

      // Not ready by the time it would be written (the turn ended): not sent, and the site gets nothing.
      s.got.length = 0;
      r = await timed({ proxy: s.pass(), url: `${s.url}/notes`, ca, ready: () => 'the turn ended' });
      assert.deepEqual(r.d, { delivery: 'not-sent', why: 'the turn ended' });
      assert.equal(s.got.length, 0);
    } finally {
      await s.close();
    }
  });
}
