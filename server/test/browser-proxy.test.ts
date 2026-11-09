// The browser's proxy owns every request and tunnel from the moment it arrives: one still waiting on its name when
// the proxy is sealed, sealed and reopened, its site removed or the proxy closed never reaches the site, and leaves
// nothing open. The name lookup is held here (the proxy's test-only lookup) so each change lands while it waits;
// the site is a loopback server that counts every connection made to it. No Chromium, no real names or sites.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect as tlsConnect } from 'node:tls';
import { interceptCert } from '../src/browser-cert.ts';
import { type BrowserProxy, type ProxyPolicy, startBrowserProxy } from '../src/browser-proxy.ts';
import { freePort, tempDir } from './helpers.ts';

/** A site on loopback that answers every request and counts the connections it gets (any packet from the proxy). */
async function upstream(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  const port = await freePort();
  let connections = 0;
  const open = new Set<Socket>();
  const server: Server = createServer((sock) => {
    connections++;
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    sock.on('error', () => {});
    sock.on('data', () => sock.end('HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nsent'));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    port,
    connections: () => connections,
    close: () =>
      new Promise((r) => {
        for (const s of open) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Name lookups that wait until released, each then answering 127.0.0.1. */
function heldLookup() {
  const waiting: (() => void)[] = [];
  return {
    lookup: (_host: string) => new Promise<string[]>((r) => waiting.push(() => r(['127.0.0.1']))),
    waiting: () => waiting.length,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const settle = async () => {
  // The lookup's continuation runs in microtasks, a connection's first events within a few turns: let them all run.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 100));
};

/** A plain HTTP GET through the proxy: its status, or 'cut' if the connection was destroyed. */
function get(proxy: BrowserProxy, url: string): Promise<number | 'cut'> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host, 'proxy-authorization': basic(proxy.username, proxy.password) }, agent: false });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', () => resolve('cut'));
    });
    req.on('error', () => resolve('cut'));
    req.end();
  });
}

/** A CONNECT through the proxy: its status line, or 'cut'. With the tunnel open, a GET is written through it. */
function tunnel(proxy: BrowserProxy, target: string, auth = basic(proxy.username, proxy.password)): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(proxy.port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\nproxy-authorization: ${auth}\r\n\r\n`));
    let first = true;
    socket.on('data', (d) => {
      if (!first) return;
      first = false;
      const line = d.toString().split('\r\n')[0];
      if (/ 200 /.test(line)) socket.write('GET /send-message HTTP/1.1\r\nhost: x\r\n\r\n');
      else socket.destroy();
      resolve(line);
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve('cut'));
  });
}

async function setup() {
  const site = await upstream();
  const dns = heldLookup();
  let policy: ProxyPolicy = { enabled: true, sites: [`localhost:${site.port}`] };
  const blocked: string[] = [];
  const proxy = await startBrowserProxy(() => policy, (_url, why) => blocked.push(why), { lookup: dns.lookup });
  return {
    site,
    dns,
    proxy,
    blocked,
    url: `http://localhost:${site.port}/send-message`,
    target: `localhost:${site.port}`,
    setPolicy: (p: ProxyPolicy) => (policy = p),
    /** Nothing of the proxy's still open or under way. */
    idle: () => assert.deepEqual(proxy.inFlight(), { pending: 0, tunnels: 0, exchanges: 0, sockets: 0 }),
    close: async () => {
      await proxy.close().catch(() => {});
      await site.close();
    },
  };
}

/** Starts `go` with its lookup held, applies `change` while it waits, then lets the lookup answer. */
async function across<T>(t: Awaited<ReturnType<typeof setup>>, go: () => Promise<T>, change: () => unknown | Promise<unknown>): Promise<T> {
  let over = false;
  const outcome = go().finally(() => (over = true));
  while (!t.dns.waiting()) {
    assert.ok(!over, 'it never reached its name lookup');
    await new Promise((r) => setImmediate(r));
  }
  await change();
  t.dns.release();
  const r = await outcome;
  await settle();
  return r;
}

test('held only by its name lookup, an unsealed GET and tunnel go through: the hold itself changes nothing', async () => {
  const t = await setup();
  try {
    assert.equal(await across(t, () => get(t.proxy, t.url), () => {}), 200);
    assert.equal(t.site.connections(), 1);
    assert.match(await across(t, () => tunnel(t.proxy, t.target), () => {}), / 200 /);
    assert.equal(t.site.connections(), 2);
  } finally {
    await t.close();
  }
});

for (const [name, change] of [
  ['the proxy is sealed', (t: Awaited<ReturnType<typeof setup>>) => t.proxy.seal(true)],
  ['the proxy is sealed then reopened', (t: Awaited<ReturnType<typeof setup>>) => (t.proxy.seal(true), t.proxy.seal(false))],
  ['its site is removed', (t: Awaited<ReturnType<typeof setup>>) => (t.setPolicy({ enabled: true, sites: [] }), t.proxy.recheck())],
  ['its site is removed (no recheck yet)', (t: Awaited<ReturnType<typeof setup>>) => t.setPolicy({ enabled: true, sites: [] })],
  ['the browser is turned off', (t: Awaited<ReturnType<typeof setup>>) => t.setPolicy({ enabled: false, sites: [] })],
  ['the proxy is closed', (t: Awaited<ReturnType<typeof setup>>) => t.proxy.close()],
] as const) {
  test(`a GET waiting on its name when ${name}: nothing reaches the site, nothing is left open`, async () => {
    const t = await setup();
    try {
      assert.notEqual(await across(t, () => get(t.proxy, t.url), () => change(t)), 200);
      assert.equal(t.site.connections(), 0, 'the GET reached the site');
      t.idle();
    } finally {
      await t.close();
    }
  });
  test(`a tunnel waiting on its name when ${name}: nothing reaches the site, nothing is left open`, async () => {
    const t = await setup();
    try {
      assert.doesNotMatch(await across(t, () => tunnel(t.proxy, t.target), () => change(t)), / 200 /);
      assert.equal(t.site.connections(), 0, 'the tunnel reached the site');
      t.idle();
    } finally {
      await t.close();
    }
  });
}

test("a card's pass is for the generation it was made in: a seal or a reopen while it waits on its name ends it, and a later page's authority never carries it", async () => {
  const t = await setup();
  try {
    t.proxy.seal(true);
    // Sealed, Chromium's own credentials get nothing.
    assert.match(await tunnel(t.proxy, t.target), / 403 /);
    // A pass made now, kept waiting on its name while the Boton acts again (a new seal): refused once it resolves.
    let pass = t.proxy.passOnce('localhost', t.site.port);
    assert.doesNotMatch(await across(t, () => tunnel(t.proxy, t.target, basic(pass.username, pass.password)), () => t.proxy.seal(true)), / 200 /);
    // Made, then the page reopened (unsealed) while it waits: refused too.
    pass = t.proxy.passOnce('localhost', t.site.port);
    assert.doesNotMatch(
      await across(t, () => tunnel(t.proxy, t.target, basic(pass.username, pass.password)), () => t.proxy.seal(false)),
      / 200 /,
    );
    assert.equal(t.site.connections(), 0);
    // Made while sealed, used only after a reopen: it was for the old generation.
    t.proxy.seal(true);
    pass = t.proxy.passOnce('localhost', t.site.port);
    t.proxy.seal(false);
    assert.match(await tunnel(t.proxy, t.target, basic(pass.username, pass.password)), / 407 /);
    assert.equal(t.site.connections(), 0);
    await settle();
    t.idle();
    // A pass in its own generation, nothing changing while it waits: its one tunnel goes, and it can't be used twice.
    t.proxy.seal(true);
    pass = t.proxy.passOnce('localhost', t.site.port);
    assert.match(await across(t, () => tunnel(t.proxy, t.target, basic(pass.username, pass.password)), () => {}), / 200 /);
    assert.equal(t.site.connections(), 1);
    assert.match(await tunnel(t.proxy, t.target, basic(pass.username, pass.password)), / 407 /);
  } finally {
    await t.close();
  }
});

test('a seal cuts what is open, and what was cut leaves nothing behind', async () => {
  const t = await setup();
  try {
    const socket = connect(t.proxy.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.write(`CONNECT ${t.target} HTTP/1.1\r\nhost: ${t.target}\r\nproxy-authorization: ${basic(t.proxy.username, t.proxy.password)}\r\n\r\n`);
    while (!t.dns.waiting()) await new Promise((r) => setImmediate(r));
    t.dns.release();
    await new Promise<void>((r) => socket.once('data', () => r()));
    assert.equal(t.proxy.inFlight().tunnels, 1);
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    t.proxy.seal(true);
    await closed;
    await settle();
    t.idle();
  } finally {
    await t.close();
  }
});

test("plain HTTP writes go only when the policy says so (the owner's handover, right after the owner's input), and never sealed", async () => {
  const site = await upstream();
  let p: ProxyPolicy = { enabled: true, sites: [`127.0.0.1:${site.port}`] };
  const proxy = await startBrowserProxy(() => p, () => {});
  const post = () =>
    new Promise<number | 'cut'>((resolve) => {
      const url = `http://127.0.0.1:${site.port}/login`;
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: url, headers: { host: new URL(url).host, 'proxy-authorization': basic(proxy.username, proxy.password), 'content-length': '3' }, agent: false });
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', () => resolve('cut'));
      req.end('a=1');
    });
  try {
    assert.equal(await post(), 403);
    assert.equal(site.connections(), 0);
    p = { ...p, writes: true };
    assert.equal(await post(), 200);
    assert.equal(site.connections(), 1);
    // To a site not listed, still refused; sealed, nothing goes; off, nothing goes.
    p = { enabled: true, sites: ['example.com'], writes: true };
    assert.equal(await post(), 403);
    p = { enabled: true, sites: [`127.0.0.1:${site.port}`], writes: true };
    proxy.seal(true);
    assert.equal(await post(), 403);
    proxy.seal(false);
    p = { enabled: false, sites: [`127.0.0.1:${site.port}`], writes: true };
    assert.equal(await post(), 403);
    assert.equal(site.connections(), 1);
  } finally {
    await proxy.close();
    await site.close();
  }
});

/** A plain HTTP POST through the proxy: its status, or 'cut'. */
function post(proxy: BrowserProxy, url: string): Promise<number | 'cut'> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: url, headers: { host: new URL(url).host, 'proxy-authorization': basic(proxy.username, proxy.password), 'content-length': '11' }, agent: false });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', () => resolve('cut'));
    });
    req.on('error', () => resolve('cut'));
    req.end('dummy-write');
  });
}

for (const [name, change] of [
  ['the moment for writes passes', (t: Awaited<ReturnType<typeof setup>>) => t.setPolicy({ enabled: true, sites: [t.target], writes: false })],
  ['the proxy is cut (the owner opens another address)', (t: Awaited<ReturnType<typeof setup>>) => t.proxy.cut()],
] as const) {
  test(`a write let in while writes were allowed, still waiting on its name when ${name}: nothing reaches the site`, async () => {
    const t = await setup();
    try {
      t.setPolicy({ enabled: true, sites: [t.target], writes: true });
      // Refused when the moment passed; cut with everything else of its generation when the proxy is cut.
      assert.equal(await across(t, () => post(t.proxy, t.url), () => change(t)), name.startsWith('the moment') ? 403 : 'cut');
      assert.equal(t.site.connections(), 0);
      t.idle();
      // A read waiting the same way when the moment passes still goes: only writes wait on it.
      if (name.startsWith('the moment')) {
        t.setPolicy({ enabled: true, sites: [t.target], writes: true });
        assert.equal(await across(t, () => get(t.proxy, t.url), () => change(t)), 200);
      }
    } finally {
      await t.close();
    }
  });
}

// ------------------------------------------------------------------ the owner's HTTPS, ended at the proxy

function siteCert(): { key: string; cert: string } {
  const dir = tempDir();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

async function intercepting(opts: { trustSite?: boolean } = {}) {
  const sc = siteCert();
  const ic = interceptCert();
  let connections = 0;
  const hits: string[] = [];
  const site = createHttpsServer({ key: sc.key, cert: sc.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} ${body}`);
      // A site may send the proxy's mark itself: it never reaches the page as one.
      res.setHeader('x-botons-proxy', 'blocked');
      res.end('ok');
    });
  });
  site.on('connection', () => connections++);
  const port = await freePort();
  await new Promise<void>((r) => site.listen(port, '127.0.0.1', () => r()));
  const dns = heldLookup();
  const target = `127.0.0.1:${port}`;
  let policy: ProxyPolicy = { enabled: true, sites: [target] };
  const blocked: string[] = [];
  const wrote: string[] = [];
  /** The x-botons-proxy mark on each answer through `send` ('' for none). */
  const marks: string[] = [];
  const proxy = await startBrowserProxy(() => policy, (_u, why) => blocked.push(why), {
    intercept: { key: ic.key, cert: ic.cert, ca: opts.trustSite === false ? undefined : [sc.cert] },
    onWrite: (url, method) => wrote.push(`${method} ${new URL(url).pathname}`),
  });
  /** One request through a CONNECT tunnel, over TLS to the proxy (which shows its own certificate): its status, or 'cut'. */
  const send = (method: string, path: string, host = target, connectTo = target): Promise<number | 'cut'> =>
    new Promise((resolve) => {
      const raw = connect(proxy.port, '127.0.0.1', () => raw.write(`CONNECT ${connectTo} HTTP/1.1\r\nhost: ${connectTo}\r\nproxy-authorization: ${basic(proxy.username, proxy.password)}\r\n\r\n`));
      raw.on('error', () => resolve('cut'));
      raw.once('data', (d) => {
        if (!/ 200 /.test(d.toString())) return resolve(Number(/ (\d{3}) /.exec(d.toString())?.[1] ?? 0) || 'cut');
        const secure = tlsConnect({ socket: raw, ca: ic.cert, checkServerIdentity: () => undefined, servername: 'localhost' });
        secure.on('error', () => resolve('cut'));
        secure.on('secureConnect', () => {
          const body = method === 'GET' ? '' : 'dummy-write';
          const req = httpRequest({ method, path, headers: { host, 'content-length': String(body.length) }, createConnection: () => secure });
          req.on('response', (res) => {
            marks.push(String(res.headers['x-botons-proxy'] ?? ''));
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
            res.on('error', () => resolve('cut'));
          });
          req.on('error', () => resolve('cut'));
          req.end(body);
        });
      });
    });
  /** One request through a pass's tunnel, as a card's send makes it: TLS to the site itself, verified against its own certificate. */
  const sendByPass = (method: string, path: string): Promise<number | 'cut'> =>
    new Promise((resolve) => {
      const pass = proxy.passOnce('127.0.0.1', port);
      const raw = connect(proxy.port, '127.0.0.1', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\nproxy-authorization: ${basic(pass.username, pass.password)}\r\n\r\n`));
      raw.on('error', () => resolve('cut'));
      raw.once('data', (d) => {
        if (!/ 200 /.test(d.toString())) return resolve(Number(/ (\d{3}) /.exec(d.toString())?.[1] ?? 0) || 'cut');
        const secure = tlsConnect({ socket: raw, ca: sc.cert, host: '127.0.0.1' });
        secure.on('error', () => resolve('cut'));
        secure.on('secureConnect', () => {
          const req = httpRequest({ method, path, headers: { host: target, 'content-length': '11' }, createConnection: () => secure });
          req.on('response', (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', () => resolve('cut'));
          req.end('dummy-write');
        });
      });
    });
  return {
    proxy,
    dns,
    send,
    sendByPass,
    target,
    hits,
    marks,
    blocked,
    wrote,
    connections: () => connections,
    setPolicy: (p: ProxyPolicy) => (policy = p),
    close: async () => {
      await proxy.close();
      await new Promise<void>((r) => {
        site.close(() => r());
        site.closeAllConnections();
      });
    },
  };
}

test("the owner's HTTPS ends at the proxy: reads go, a write goes only while writes are allowed and is told as it leaves, a request must name its tunnel's site", async () => {
  const t = await intercepting();
  try {
    assert.equal(await t.send('GET', '/page'), 200);
    assert.equal(await t.send('POST', '/write'), 403);
    assert.ok(t.blocked.some((w) => /a POST request to .*only reads pages/.test(w)), t.blocked.join('\n'));
    t.setPolicy({ enabled: true, sites: [t.target], writes: true });
    assert.equal(await t.send('POST', '/write'), 200);
    assert.deepEqual(t.wrote, ['POST /write']);
    // Inside a tunnel to one site, a request for another is refused, writes allowed or not.
    assert.equal(await t.send('POST', '/write', 'example.com'), 421);
    // Sealed, nothing goes; a tunnel to a site not listed never opens.
    t.proxy.seal(true);
    assert.equal(await t.send('GET', '/page'), 403);
    t.proxy.seal(false);
    assert.equal(await t.send('GET', '/page', 'example.com:443', 'example.com:443'), 403);
    assert.deepEqual(t.hits.filter((h) => !h.startsWith('GET')), ['POST /write dummy-write']);
  } finally {
    await t.close();
  }
});

test("a Boton's HTTPS ends at the proxy too: no write goes, whatever in Chromium sent it; a card's pass alone gets a tunnel to the site", async () => {
  const t = await intercepting();
  try {
    // A Boton's policy never allows writes: a beacon or keepalive fetch as a page unloads (which Playwright's routing
    // never sees) is refused here, as every write is, before a byte of it reaches the site.
    assert.equal(await t.send('GET', '/page'), 200);
    // The site's own answer, its forged mark taken off; so a marked answer inside HTTPS is the proxy's own.
    assert.deepEqual(t.marks, ['']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(await t.send(method, '/count'), 403, method);
    assert.deepEqual(t.marks, ['', 'blocked', 'blocked', 'blocked', 'blocked']);
    assert.equal(t.blocked.filter((w) => /only reads pages/.test(w)).length, 4, t.blocked.join('\n'));
    assert.deepEqual(t.wrote, []);
    // The send of a card's request: its pass goes as a tunnel to the site (its sender verifies the site's own
    // certificate), sealed or not.
    t.proxy.seal(true);
    assert.equal(await t.send('GET', '/page'), 403);
    assert.equal(await t.sendByPass('POST', '/count'), 200);
    assert.deepEqual(t.hits, ['GET /page ', 'POST /count dummy-write']);
    assert.deepEqual(t.wrote, []);
  } finally {
    await t.close();
  }
});

test("the owner's HTTPS goes on only to a site whose certificate the proxy accepts", async () => {
  const t = await intercepting({ trustSite: false });
  try {
    assert.equal(await t.send('GET', '/page'), 502);
    assert.deepEqual(t.hits, []);
  } finally {
    await t.close();
  }
});
