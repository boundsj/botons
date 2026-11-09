// How the browser's proxy connects to a site's addresses, with the name lookup and the connections stubbed: every
// address is checked before any is dialled, IPv4 goes first and a dead address falls through to the next, and a
// name not found or a site not reached is said in plain words, never as "Blocked by Botons". The one real socket is a
// loopback site standing in for a public address. No Chromium, no real names.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect, createServer, Socket, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { navigationAnswer, withoutHeadless } from '../src/browser.ts';
import { dialOrder, startBrowserProxy } from '../src/browser-proxy.ts';

const V4 = '93.184.215.14';
const V4B = '93.184.215.15';
const V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';

async function setup(addresses: string[] | Error, answers: Record<string, 'site' | 'refuse' | 'hang'>, status = 200) {
  const site = createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', () => sock.end(`HTTP/1.1 ${status} X\r\nx-botons-proxy: blocked\r\ncontent-length: 4\r\nconnection: close\r\n\r\nsent`));
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const sitePort = (site.address() as AddressInfo).port;
  const dialled: string[] = [];
  const blocked: string[] = [];
  const unreachable: string[] = [];
  const proxy = await startBrowserProxy(
    () => ({ enabled: true, sites: ['example.com'] }),
    (_url, why) => blocked.push(why),
    {
      lookup: async () => {
        if (addresses instanceof Error) throw addresses;
        return addresses;
      },
      connect: (address) => {
        dialled.push(address);
        const how = answers[address] ?? 'refuse';
        if (how === 'site') return connect({ host: '127.0.0.1', port: sitePort });
        if (how === 'hang') return new Socket();
        const s = new Socket();
        setImmediate(() => s.destroy(Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' })));
        return s;
      },
      attemptMs: 50,
      onUnreachable: (_url, message) => unreachable.push(message),
    },
  );
  const get = () =>
    new Promise<{ status: number; body: string; proxy: string | undefined }>((resolve, reject) => {
      const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, path: 'http://example.com/', headers: { host: 'example.com', 'proxy-authorization': auth }, agent: false }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, proxy: res.headers['x-botons-proxy'] as string | undefined }));
      });
      req.on('error', reject);
      req.end();
    });
  return {
    get,
    dialled,
    blocked,
    unreachable,
    close: async () => {
      await proxy.close();
      await new Promise((r) => site.close(r));
    },
  };
}

test('IPv4 is dialled first, and a dead address falls through to the next', async () => {
  assert.deepEqual(dialOrder([V6, V4, V4, V4B]), [V4, V4B, V6]);
  // The resolver lists IPv6 first and this server has no IPv6 route: IPv4 answers.
  let t = await setup([V6, V4], { [V6]: 'refuse', [V4]: 'site' });
  try {
    assert.equal((await t.get()).body, 'sent');
    assert.deepEqual(t.dialled, [V4]);
  } finally {
    await t.close();
  }
  // The first address never answers (cut after its attempt's time), the second refuses, IPv6 answers.
  t = await setup([V6, V4, V4B], { [V4]: 'hang', [V4B]: 'refuse', [V6]: 'site' });
  try {
    assert.equal((await t.get()).body, 'sent');
    assert.deepEqual(t.dialled, [V4, V4B, V6]);
    assert.deepEqual([t.blocked, t.unreachable], [[], []]);
  } finally {
    await t.close();
  }
});

test('a private address anywhere in the answer refuses them all, before any is dialled', async () => {
  for (const addresses of [[V4, '10.0.0.1'], ['fd00::1', V4], [V6, '127.0.0.1']]) {
    const t = await setup(addresses, { [V4]: 'site', [V6]: 'site' });
    try {
      const r = await t.get();
      assert.equal(r.status, 403);
      assert.match(r.body, /^Blocked by Botons: example\.com resolves to /);
      assert.deepEqual(t.dialled, [], 'nothing dialled');
      assert.equal(t.blocked.length, 1);
      assert.deepEqual(t.unreachable, []);
    } finally {
      await t.close();
    }
  }
});

test('not found, not reached and a site’s own 403 are each said as they are, never as a block by Botons', async () => {
  let t = await setup(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), {});
  try {
    const r = await t.get();
    assert.deepEqual([r.status, r.body.trim(), r.proxy], [502, 'Couldn’t find example.com — check the address.', 'unreachable']);
    assert.deepEqual([t.blocked, t.unreachable, t.dialled], [[], ['Couldn’t find example.com — check the address.'], []]);
  } finally {
    await t.close();
  }
  t = await setup([V6, V4], {});
  try {
    const r = await t.get();
    assert.deepEqual([r.status, r.body.trim()], [502, 'Couldn’t connect to example.com (tried 2 addresses).']);
    assert.deepEqual([t.blocked, t.unreachable, t.dialled], [[], ['Couldn’t connect to example.com (tried 2 addresses).'], [V4, V6]]);
  } finally {
    await t.close();
  }
  t = await setup([V4], { [V4]: 'site' }, 403);
  try {
    const r = await t.get();
    assert.deepEqual([r.status, r.body, r.proxy], [403, 'sent', undefined], "the site's answer, without the proxy's mark it tried to give itself");
    assert.deepEqual([t.blocked, t.unreachable], [[], []]);
  } finally {
    await t.close();
  }
});

test('the user agent loses only its headless mark', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.80 Safari/537.36';
  assert.equal(withoutHeadless(ua), 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36');
  assert.equal(withoutHeadless(withoutHeadless(ua)), withoutHeadless(ua));
});

test('a navigation is judged where it ended, by what Botons itself said of it, never by what a site sent', () => {
  const none = { blocked: [], unreachable: [] };
  const nav = (url: string, o: { failed?: boolean; mark?: string | null; request?: object | null } = {}) => ({ url, failed: !!o.failed, mark: o.mark ?? null, request: o.request ?? null });
  const away = { url: 'http://b.example.com/', host: 'b.example.com', message: 'Couldn’t connect to b.example.com (tried 2 addresses).' };
  const lost = { url: 'https://c.example.com/', host: 'c.example.com', message: 'Couldn’t find c.example.com — check the address.' };
  // An allowed site redirects to an allowed one the proxy couldn't reach: said of the destination, over HTTP (its 502) or HTTPS (the tunnel failed).
  assert.equal(navigationAnswer(nav('http://b.example.com/', { mark: 'unreachable' }), { blocked: [], unreachable: [away] }), away.message);
  assert.equal(navigationAnswer(nav('https://c.example.com/', { failed: true }), { blocked: [], unreachable: [lost] }), lost.message);
  // ...and never of the address first opened, whose site answered.
  assert.equal(navigationAnswer(nav('http://a.example.com/', { mark: null }), { blocked: [], unreachable: [away] }), null);
  // A redirect the routing refused: that very request's block.
  const hop = {};
  assert.equal(navigationAnswer(nav('http://elsewhere.example.net/', { failed: true, request: hop }), { blocked: [{ url: 'http://elsewhere.example.net/', why: 'elsewhere.example.net is not one of the sites', request: hop }], unreachable: [] }), 'Blocked by Botons: elsewhere.example.net is not one of the sites.');
  // The proxy's own block of a plain HTTP redirect's destination (its mark, which it strips from every site's answer).
  assert.equal(navigationAnswer(nav('http://b.example.com/x', { mark: 'blocked' }), { blocked: [{ url: 'http://b.example.com/x', why: 'b.example.com resolves to a private address' }], unreachable: [] }), 'Blocked by Botons: b.example.com resolves to a private address.');
  // HTTPS ends at the proxy too, which strips the mark from every site's answer: there it is the proxy's own as well.
  assert.equal(navigationAnswer(nav('https://a.example.com/', { mark: 'unreachable' }), { blocked: [], unreachable: [{ ...away, url: 'https://a.example.com/' }] }), away.message);
  assert.equal(navigationAnswer(nav('https://a.example.com/x', { mark: 'blocked' }), { blocked: [{ url: 'https://a.example.com/x', why: 'a.example.com resolves to a private address' }], unreachable: [] }), 'Blocked by Botons: a.example.com resolves to a private address.');
  // A page the site answered (no mark) whose script makes a POST the routing refuses: the page is the site's own answer.
  const post = { url: 'https://a.example.com/form', why: 'POST is not a read', request: {} };
  assert.equal(navigationAnswer(nav('https://a.example.com/', { request: {} }), { blocked: [post], unreachable: [] }), null);
  // Not a web address at all: a mark there is nobody's.
  assert.equal(navigationAnswer(nav('data:text/html,x', { mark: 'blocked' }), none), null);
  // Over plain HTTP too, another request's block by the routing never stands for the page.
  assert.equal(navigationAnswer(nav('http://a.example.com/', { failed: true, request: {} }), { blocked: [{ ...post, url: 'http://a.example.com/form' }], unreachable: [] }), null);
  // The proxy's mark on plain HTTP with its record already full: still not the site's answer.
  assert.equal(navigationAnswer(nav('http://a.example.com/', { mark: 'blocked' }), none), 'Blocked by Botons.');
  assert.equal(navigationAnswer(nav('http://a.example.com/', { mark: 'unreachable' }), none), 'Couldn’t connect to a.example.com.');
  assert.equal(navigationAnswer(nav('http://a.example.com/', { failed: true }), none), null);
});
