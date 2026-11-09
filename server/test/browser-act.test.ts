// The managed browser acting on pages: it clicks and types, and whatever that makes a page send (a form, a script's
// POST) is held where it leaves Chromium for the owner's card, which shows that exact request and, if allowed while
// the step waits, sends it once. Real Chromium against a loopback fixture site that records every request (no real
// accounts or sites); like browser.test.ts these need Chromium and fail without one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Approval, BrowserActionResult, BrowserControl } from '../../shared/types.ts';
import { BROWSER_CONNECTOR, BROWSER_SERVER } from '../../shared/util.ts';
import { findBrowser } from '../src/browser.ts';
import { describeRequest, fingerprint, shown, SHOWN_MAX, typingProblem, wireHeaders } from '../src/browser-request.ts';
import { formatResult } from '../src/cli/browser-mcp.ts';
import { freePort, startServer, tempDir, type TestServer, until, useTestCodexHome } from './helpers.ts';

const found = await findBrowser(process.env.BOTONS_BROWSER_PATH ?? '');
const CHROMIUM = found.executable ?? '';

// ------------------------------------------------------------------ the cards, without a browser

const binding = { botId: 'bot_1', tokenId: 'tok_1', session: 's1', revision: 3 };
const form = (body: string, extra: Record<string, string> = {}) => ({
  method: 'POST',
  url: 'https://shop.example.com/cart/checkout?step=2&coupon=SPRING',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'sid=dummy-session', 'user-agent': 'x', ...extra },
  body: Buffer.from(body),
});

test('a card shows the whole request: method, full address with its query, every field decoded, headers the page set; cookies only named', () => {
  const r = form('item=42&qty=1&note=gift+wrap%21&_csrf=dummy-csrf', { 'x-action': 'purchase' });
  const d = describeRequest(r, 'the button "Continue"', 'f'.repeat(64));
  assert.ok(!('why' in d));
  assert.match(d.title, /^Let the browser send POST shop\.example\.com\/cart\/checkout\?…$/);
  assert.match(d.details, /^POST https:\/\/shop\.example\.com\/cart\/checkout\?step=2&coupon=SPRING$/m);
  for (const line of ['  item = 42', '  qty = 1', '  note = gift wrap!', '  _csrf = dummy-csrf', '  x-action: purchase']) assert.ok(d.details.includes(line), line);
  // The label is the site's text, said so: a "Continue" button can be a purchase.
  assert.match(d.details, /"Continue" \(that label is the site's own text, not proof of what this does\)/);
  assert.match(d.details, /own cookies for shop\.example\.com \(values not shown\): sid\./);
  assert.ok(!d.details.includes('dummy-session'));
  // Invisible and reordering characters are written out, so a card can't hide or reorder what it says.
  const tricky = describeRequest(form('to=alice%E2%80%AEcom.evil&x=a%00b'), null, 'k'.repeat(64));
  assert.ok(!('why' in tricky));
  assert.ok(tricky.details.includes('to = alice\\u{202e}com.evil'), tricky.details);
  assert.ok(!/[\u202e\u0000]/.test(tricky.details));
  assert.equal(shown('a\u200bb\u2066c'), 'a\\u{200b}b\\u{2066}c');
});

test('no card for what a card cannot show in full: files, bytes, a body too long; nor for a method a page cannot send', () => {
  const file = {
    method: 'POST',
    url: 'https://example.com/upload',
    headers: { 'content-type': 'multipart/form-data; boundary=XyZ' },
    body: Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="doc"; filename="a.txt"\r\n\r\nhello\r\n--XyZ--\r\n'),
  };
  assert.match((describeRequest(file, null, 'k') as { why: string }).why, /sends a file/);
  const fields = { ...file, body: Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="q"\r\n\r\nhello\r\n--XyZ--\r\n') };
  assert.match((describeRequest(fields, null, 'k') as { details: string }).details, /q = hello/);
  assert.match((describeRequest({ ...form(''), body: Buffer.from([0xff, 0x00, 0x01]) }, null, 'k') as { why: string }).why, /not text/);
  assert.match((describeRequest(form(`a=${'x'.repeat(SHOWN_MAX)}`), null, 'k') as { why: string }).why, /too long/);
  assert.ok('why' in describeRequest({ ...form(''), method: 'OPTIONS' }, null, 'k'));
});

test("a card's fingerprint covers the turn, the browser, the page's document and every byte of the request", () => {
  const r = form('item=42');
  const k = fingerprint(binding, r);
  assert.equal(fingerprint(binding, form('item=42')), k);
  for (const other of [
    fingerprint({ ...binding, tokenId: 'tok_2' }, r),
    fingerprint({ ...binding, session: 's2' }, r),
    fingerprint({ ...binding, revision: 4 }, r),
    fingerprint({ ...binding, botId: 'bot_2' }, r),
    fingerprint(binding, form('item=43')),
    fingerprint(binding, { ...r, url: `${r.url}&x=1` }),
    fingerprint(binding, { ...r, method: 'PUT' }),
    fingerprint(binding, form('item=42', { 'x-extra': '1' })),
  ]) {
    assert.notEqual(other, k);
  }
});

test('what goes on the wire is the held request: its own headers (no cookie it lacked), HTTP/2 names dropped, its length', () => {
  const r = { method: 'POST', url: 'https://shop.example.com/a?b=1', headers: { ':authority': 'shop.example.com', ':method': 'POST', 'x-a': '1', connection: 'keep-alive', 'content-length': '99' }, body: Buffer.from('q=1') };
  assert.deepEqual(wireHeaders(r), [
    ['host', 'shop.example.com'],
    ['x-a', '1'],
    ['content-length', '3'],
    ['connection', 'close'],
  ]);
  assert.deepEqual(wireHeaders({ ...r, headers: { host: 'shop.example.com', cookie: 'sid=dummy-old' } }), [
    ['host', 'shop.example.com'],
    ['cookie', 'sid=dummy-old'],
    ['content-length', '3'],
    ['connection', 'close'],
  ]);
  // The Cookie header is part of the card's fingerprint like every other byte.
  assert.notEqual(fingerprint(binding, { ...r, headers: { cookie: 'sid=OLD' } }), fingerprint(binding, { ...r, headers: { cookie: 'sid=NEW' } }));
});

// What a held request's cookies may be, and how a card's request is matched, are in browser-request.test.ts.

test('what a card says of cookies, and of a credential a script put in a header', () => {
  const r = { method: 'POST', url: 'https://shop.example.com/a?b=1', headers: {}, body: Buffer.from('q=1') };
  // A credential a script put in a header is bound, and named on the card, never shown.
  const d = describeRequest({ ...r, headers: { authorization: 'Bearer dummy-token-1', 'x-session-id': 'dummy-sess', 'x-note': 'shown' } }, null, 'k'.repeat(64));
  assert.ok(!('why' in d));
  assert.ok(!d.details.includes('dummy-token-1') && !d.details.includes('dummy-sess'), d.details);
  assert.match(d.details, /authorization: \(a credential, not shown\)/);
  assert.match(d.details, /x-note: shown/);
  assert.match(d.details, /It goes without cookies\./);
  // A GET gets a card too: its address can be the action.
  const get = describeRequest({ method: 'GET', url: 'https://shop.example.com/send-message?to=kevin', headers: {}, body: null }, null, 'k'.repeat(64));
  assert.ok(!('why' in get));
  assert.match(get.details, /^GET https:\/\/shop\.example\.com\/send-message\?to=kevin$/m);
});

test("the Boton is told what is known of delivery: sent, never sent, or unknown (and then never to send it again)", () => {
  const r = (delivery: 'sent' | 'not-sent' | 'unknown') => formatResult({ outcome: 'refused', message: 'm', page: null, approval: { id: 'apr_1', status: 'allowed', delivery } });
  assert.match(r('sent'), /\(allowed, sent once\)/);
  assert.match(r('not-sent'), /\(allowed, nothing sent\)/);
  assert.match(r('unknown'), /whether it arrived is unknown: never send it again/);
  assert.doesNotMatch(r('unknown'), /nothing sent/);
});

test('typing is refused into passwords, codes, card numbers and other secrets, judged from what the page says', () => {
  const field = (f: Partial<Parameters<typeof typingProblem>[0]>) => typingProblem({ tag: 'input', type: 'text', name: '', id: '', autocomplete: '', label: '', ...f });
  assert.equal(field({ name: 'q', label: 'Search' }), null);
  assert.equal(field({ tag: 'textarea', name: 'note' }), null);
  assert.equal(field({ name: 'footprint' }), null);
  for (const f of [
    { type: 'password' },
    { autocomplete: 'one-time-code' },
    { autocomplete: 'cc-number' },
    { autocomplete: 'section-pay cc-csc' },
    { autocomplete: 'current-password' },
    { name: 'passwd' },
    { name: 'otp' },
    { label: 'Verification code' },
    { id: 'card-number' },
    { name: 'cvv' },
    { label: 'Your PIN' },
    { name: 'api_key' },
    { type: 'file' },
    { type: 'hidden' },
    { tag: 'select' },
  ]) {
    assert.ok(field(f), JSON.stringify(f));
  }
});

// ------------------------------------------------------------------ a fixture site

interface Shop {
  server: Server;
  url: string;
  hits: { method: string; url: string; body: string; cookie: string | null }[];
  /** Whether the site saw a request whose path and query start with `prefix`. */
  saw: (prefix: string) => boolean;
  writes: () => { method: string; url: string; body: string }[];
  close: () => Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const FORM = `<form method="post" action="/notes?draft=1">
  <label>Note <input name="note"></label>
  <input type="hidden" name="csrf" value="dummy-csrf-1">
  <label>Password <input type="password" name="pw"></label>
  <label>Card <input name="cardnumber" autocomplete="cc-number"></label>
  <button type="submit">Save note</button>
</form>`;

/** A certificate made for this run only (for 127.0.0.1), trusted by nothing but the test's own browser and send. */
function testCert(): { key: string; cert: string; spki: string } {
  const dir = tempDir();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const key = readFileSync(join(dir, 'k.pem'), 'utf8');
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  const spki = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('base64');
  return { key, cert, spki };
}

async function shop(tls?: { key: string; cert: string }): Promise<Shop> {
  const port = await freePort();
  const hits: Shop['hits'] = [];
  const handler = (req: IncomingMessage, body: string, res: ServerResponse): { status?: number; headers?: Record<string, string>; body: string } | null => {
    const path = (req.url ?? '/').split('?')[0];
    // The site records the request, then drops the connection before it answers.
    if (path === '/drop') return void res.socket?.destroy(), null;
    if (path === '/dropform') return { body: page('Drop', '<form method="post" action="/drop"><input name="pay" value="7"><button>Pay</button></form>') };
    // Effects a GET can have: a GET form, a script's GET, typing that makes one, and some later on their own.
    if (path === '/getform') return { body: page('Get form', '<form method="get" action="/send-message"><input name="to" value="kevin"><button>Send it</button></form>') };
    if (path === '/scriptget') {
      return { body: page('Script GET', `<button id="b">Send</button><script>document.getElementById('b').onclick = () => fetch('/send-message?via=script').catch(() => {});</script>`) };
    }
    if (path === '/typeget') {
      return { body: page('Type GET', `<label>Search <input id="q" name="q"></label><script>document.getElementById('q').oninput = (e) => fetch('/send-message?typed=' + encodeURIComponent(e.target.value)).catch(() => {});</script>`) };
    }
    if (path === '/later') {
      return {
        body: page(
          'Later',
          `<button id="b">Toggle</button><script>document.getElementById('b').onclick = () => {
             setTimeout(() => { fetch('/send-message?later=fetch').catch(() => {}); new Image().src = '/send-message?later=image'; }, 2500);
             addEventListener('pagehide', () => { navigator.sendBeacon('/send-message?later=beacon'); fetch('/send-message?later=keepalive', { keepalive: true }).catch(() => {}); });
           };</script>`,
        ),
      };
    }
    if (path === '/links') {
      return { body: page('Links', `<a id="l" href="/other?from=link">Other page</a><script>document.getElementById('l').onclick = () => { fetch('/send-message?via=onclick').catch(() => {}); };</script>`) };
    }
    if (path === '/send-message') return { body: page('Sent', '<p>Message sent</p>') };
    if (path === '/pixel') return { headers: { 'content-type': 'image/gif' }, body: '' };
    // Cookies: a page that signs the browser in (sid=OLD) or, with mode=none, sets none; mode=omit adds a script's
    // request made without credentials. Their jar is changed by the tests, at fixed points (gate), never by a timer.
    if (path === '/cookieform') {
      const mode = new URL(req.url ?? '/', 'http://x').searchParams.get('mode') ?? '';
      const omit = mode === 'omit' ? `<button id="o" type="button">Omit</button><script>document.getElementById('o').onclick = () => fetch('/notes', { method: 'POST', credentials: 'omit', body: 'x=1' }).catch(() => {});</script>` : '';
      return {
        headers: mode === 'none' ? {} : { 'set-cookie': 'sid=OLD; Path=/' },
        body: page('Cookies', `<form id="f" method="post" action="/notes"><input name="item" value="42"><button>Buy</button></form>${omit}`),
      };
    }
    if (path === '/form') return { body: page('Form', FORM) };
    if (path === '/notes') return { body: page('Saved', `<p>Saved: ${body.replace(/</g, '')}</p>`) };
    if (path === '/r307') return { status: 307, headers: { location: '/notes-again' }, body: '' };
    if (path === '/r303') return { status: 303, headers: { location: '/notes-done' }, body: '' };
    if (path === '/r303form') return { body: page('Form 303', '<form method="post" action="/r303"><input name="q" value="prg"><button>Send</button></form>') };
    if (path === '/r307form') return { body: page('Form 307', '<form method="post" action="/r307"><input name="q" value="once"><button>Send</button></form>') };
    if (path === '/mutate') {
      // On submit, and again a moment later, the page rewrites the form: what goes is what was held.
      return {
        body: page(
          'Mutate',
          `<form id="m" method="post" action="/notes"><input name="amount" value="1"><button>Pay</button></form>
           <script>document.getElementById('m').addEventListener('submit', () => setTimeout(() => {
             document.querySelector('[name=amount]').value = '9999'; document.getElementById('m').action = '/elsewhere';
           }, 50));</script>`,
        ),
      };
    }
    if (path === '/extra') {
      // A click that makes the page send a beacon and a scripted POST before its form goes.
      return {
        body: page(
          'Extra',
          `<form id="x" method="post" action="/notes"><input name="real" value="yes"><button id="b">Go</button></form>
           <script>document.getElementById('b').addEventListener('click', () => {
             navigator.sendBeacon('/beacon', 'tracked');
             fetch('/scripted', { method: 'POST', body: 'sneaky' }).catch(() => {});
           });</script>`,
        ),
      };
    }
    if (path === '/background') {
      return { body: page('Background', `<p>polling</p><button>Nothing</button><script>setInterval(() => fetch('/poll', { method: 'POST', body: 'bg' }).catch(() => {}), 150);</script>`) };
    }
    if (path === '/other') return { body: page('Other', '<button>Other</button><img src="/pixel">') };
    return { status: 404, body: page('Not found', 'nothing here') };
  };
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body, cookie: req.headers.cookie ?? null });
      const out = handler(req, body, res);
      if (!out) return;
      res.writeHead(out.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...out.headers });
      res.end(out.body);
    });
  };
  const server: Server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, serve) : createServer(serve);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    server,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    hits,
    saw: (prefix) => hits.some((h) => h.url.startsWith(prefix)),
    writes: () => hits.filter((h) => h.method !== 'GET' && h.method !== 'HEAD').map(({ method, url, body }) => ({ method, url, body })),
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const browserEnv = (wait = '20s') => ({ BOTONS_BROWSER_PATH: CHROMIUM, BOTONS_APPROVAL_WAIT: wait });

function browserTurn(s: TestServer, botId: string) {
  const t = s.app.auth.mintBotonToken(botId);
  s.app.browser.beginTurn(botId, t.id);
  return {
    raw: (body: Record<string, unknown>) => s.call('POST', `/api/bots/${botId}/browser/actions`, body, t.token),
    act: async (body: Record<string, unknown>) => {
      const r = await s.call<BrowserActionResult>('POST', `/api/bots/${botId}/browser/actions`, body, t.token);
      assert.equal(r.status, 200, r.text);
      return r.data;
    },
    end: async () => {
      await s.app.browser.endTurn(botId, t.id);
      t.revoke();
    },
  };
}

/** Waits until the Boton's browser holds sid=`value` for `url`. */
const jarHas = (s: TestServer, botId: string, url: string, value: string) =>
  until(async () => (await s.app.browser.testCookies(botId, url)).some((c) => c.name === 'sid' && c.value === value), 15_000);

/** Sets cookies (host-only, on the fixture's host) in the Boton's browser, as a page or a sign-in would. */
async function setCookies(s: TestServer, botId: string, url: string, cookies: { name: string; value: string; path: string }[]) {
  const jar = await s.app.browser.testJar(botId);
  assert.ok(jar, 'no browser');
  await jar.addCookies(cookies.map((c) => ({ ...c, domain: new URL(url).hostname })));
}

/** Runs `change` once, at the gate `at` of `botId`'s next click or typing (see Browser.testGate), then no more. */
function atGate(s: TestServer, botId: string, at: 'acting' | 'held' | 'card', change: () => Promise<void>) {
  let fired = false;
  s.app.browser.testGate = async (where, who) => {
    if (fired || where !== at || who !== botId) return;
    fired = true;
    await change();
  };
  return () => {
    s.app.browser.testGate = null;
    assert.ok(fired, `the ${at} gate never came`);
  };
}
const pending = (s: TestServer, botId: string) => until(() => s.app.approvals.list({ botId, status: 'pending' })[0], 15_000);
const decide = (s: TestServer, id: string, decision: 'allow' | 'deny', extra: Record<string, unknown> = {}) => s.call<Approval>('POST', `/api/approvals/${id}/decide`, { decision, ...extra });
const ref = (controls: BrowserControl[], label: RegExp) => {
  const c = controls.find((x) => label.test(x.label));
  assert.ok(c, `no control ${label}: ${JSON.stringify(controls)}`);
  return c.ref;
};

async function setup(wait?: string, tls?: ReturnType<typeof testCert>) {
  const f = await shop(tls);
  const s = await startServer({ env: browserEnv(wait) });
  if (tls) s.app.browser.testTrust = { cert: tls.cert, spki: tls.spki };
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
  assert.equal((await s.call('PUT', `/api/bots/${kevin.id}/browser`, { sites: [new URL(f.url).host] })).status, 200);
  return { f, s, kevin, close: async () => (await s.stop(), await f.close()) };
}

test('a Chromium is here: these tests need one, and fail rather than skip without it', () => {
  assert.ok(found.available, `${found.why}`);
});

test('typing and a click send a form only through the card: it shows the exact request, allowing sends it once, nothing more can spend it', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    await turn.act({ action: 'open', url: `${f.url}/form` });
    const read = await turn.act({ action: 'read' });
    const controls = read.content!.controls;
    assert.deepEqual(
      controls.map((c) => [c.kind, c.label, !!c.noTyping]),
      [
        ['field', 'Note', false],
        ['field', 'Password', true],
        ['field', 'Card', true],
        ['button', 'Save note', false],
      ],
    );
    // Secrets are never typed, whatever the Boton asks.
    for (const label of [/^Password$/, /^Card$/]) {
      const r = await turn.act({ action: 'type', ref: ref(controls, label), text: 'dummy-secret-1' });
      assert.equal(r.outcome, 'refused');
      assert.match(r.message, /never types passwords/);
    }
    const typed = await turn.act({ action: 'type', ref: ref(controls, /^Note$/), text: 'Revenue 4,242' });
    assert.equal(typed.outcome, 'done', typed.message);
    assert.match(typed.message, /The page sent nothing/);
    assert.deepEqual(f.writes(), []);

    const clicking = turn.act({ action: 'click', ref: ref(controls, /Save note/) });
    const card = await pending(s, kevin.id);
    // Until the owner decides, nothing has left the browser.
    assert.deepEqual(f.writes(), []);
    assert.equal(card.tool?.browser, true);
    assert.equal(card.action, null);
    assert.match(card.title, /^Let the browser send POST 127\.0\.0\.1:\d+\/notes\?…$/);
    assert.ok(card.details.startsWith(`POST ${f.url}/notes?draft=1\n`), card.details);
    for (const line of ['  note = Revenue 4,242', '  csrf = dummy-csrf-1', '  pw = ', '  cardnumber = ']) assert.ok(card.details.includes(line), `${line}\n${card.details}`);
    assert.match(card.details, /"Save note" \(that label is the site's own text/);
    // It is never always-allowed.
    assert.equal((await decide(s, card.id, 'allow', { always: true })).status, 400);
    const allowed = await decide(s, card.id, 'allow');
    assert.equal(allowed.status, 200, allowed.text);
    const r = await clicking;
    assert.equal(r.outcome, 'done', r.message);
    assert.deepEqual(r.approval, { id: card.id, status: 'allowed', delivery: 'sent' });
    assert.match(r.message, /sent POST .*\/notes\?… once \(HTTP 200\)/);
    assert.deepEqual(f.writes(), [{ method: 'POST', url: '/notes?draft=1', body: 'note=Revenue+4%2C242&csrf=dummy-csrf-1&pw=&cardnumber=' }]);
    assert.match((await turn.act({ action: 'read' })).content!.text, /Saved: note=Revenue/);
    // Spent: no second decision, no second send, and the Boton has no way to replay it.
    assert.equal((await decide(s, card.id, 'allow')).status, 409);
    const spent = s.app.approvals.get(card.id);
    assert.ok(spent.tool?.usedAt && spent.tool.inTurn);
    const key = String((s.app.store.db.prepare('select tool_key from approvals where id = ?').get(card.id) as { tool_key: string }).tool_key).slice('browser-op:'.length);
    assert.equal(s.app.approvals.spendBrowser(card.id, key), false);
    await turn.end();
    assert.equal(f.writes().length, 1);
    const journal = (await s.call('GET', `/api/bots/${kevin.id}/browser/journal`)).data as { action: string; url: string; detail: string }[];
    assert.ok(journal.some((e) => e.action === 'sent' && e.url === `${f.url}/notes?…` && e.detail.includes(card.id)), JSON.stringify(journal));
    assert.ok(!JSON.stringify(journal).includes('draft=1'));
    const audit = (await s.call('GET', '/api/audit')).data as { action: string; target: { id: string } | null }[];
    assert.ok(audit.some((e) => e.action === 'approval.decided' && e.target?.id === card.id));
  } finally {
    await close();
  }
});

test('denied, not decided while the step waits, the turn ending, Stop: nothing is sent, and a late decision is refused', async () => {
  const { f, s, kevin, close } = await setup('2s');
  try {
    let turn = browserTurn(s, kevin.id);
    const openForm = async () => {
      await turn.act({ action: 'open', url: `${f.url}/form` });
      return ref((await turn.act({ action: 'read' })).content!.controls, /Save note/);
    };

    // Denied, with a note.
    let clicking = turn.act({ action: 'click', ref: await openForm() });
    let card = await pending(s, kevin.id);
    assert.equal((await decide(s, card.id, 'deny', { note: 'not now' })).status, 200);
    let r = await clicking;
    assert.equal(r.outcome, 'refused');
    assert.match(r.message, /denied .* not now/);
    assert.deepEqual(r.approval, { id: card.id, status: 'denied', delivery: 'not-sent' });

    // Nobody decides within the wait: withdrawn, and allowing it afterwards sends nothing.
    r = await turn.act({ action: 'click', ref: await openForm() });
    assert.equal(r.outcome, 'refused');
    assert.match(r.message, /didn't decide in time/);
    assert.equal(s.app.approvals.get(r.approval!.id).status, 'cancelled');
    assert.equal((await decide(s, r.approval!.id, 'allow')).status, 409);

    // The turn ends while the card waits: withdrawn, never carried into another turn.
    clicking = turn.act({ action: 'click', ref: await openForm() });
    card = await pending(s, kevin.id);
    await turn.end();
    r = await clicking;
    assert.equal(r.outcome, 'refused');
    assert.equal(s.app.approvals.get(card.id).status, 'cancelled');
    turn = browserTurn(s, kevin.id);
    assert.equal((await decide(s, card.id, 'allow')).status, 409);

    // Stop while the card waits.
    clicking = turn.act({ action: 'click', ref: await openForm() });
    card = await pending(s, kevin.id);
    assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/stop`)).status, 200);
    r = await clicking;
    assert.equal(r.outcome, 'refused');
    assert.equal((await decide(s, card.id, 'allow')).status, 409);
    await turn.end();

    assert.deepEqual(f.writes(), []);
    // No decision here starts a turn: none is a message to the Boton, and it stays idle.
    assert.ok(!(await s.messagesOf(kevin.id)).some((m) => m.role === 'user'), JSON.stringify(await s.messagesOf(kevin.id)));
    assert.equal(s.app.engine.statusOf(kevin.id).state, 'idle');
  } finally {
    await close();
  }
});

test('allowing sends what was held: not the form the page rewrote after, not its other writes, not a 307 resend; two decisions at once send it once', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    const clickOn = async (path: string, label: RegExp) => {
      await turn.act({ action: 'open', url: `${f.url}${path}` });
      return turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, label) });
    };

    // The page rewrites its form (amount, action) once the request is held: the card and the send are the held one.
    let clicking = clickOn('/mutate', /Pay/);
    let card = await pending(s, kevin.id);
    assert.match(card.details, /amount = 1$/m);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    assert.equal((await clicking).outcome, 'done');
    assert.deepEqual(f.writes(), [{ method: 'POST', url: '/notes', body: 'amount=1' }]);

    // A click that makes the page send a beacon and a script's POST too: one card for the first, the rest refused.
    f.hits.length = 0;
    clicking = clickOn('/extra', /Go/);
    card = await pending(s, kevin.id);
    assert.equal(s.app.approvals.list({ botId: kevin.id, status: 'pending' }).length, 1);
    // The form the click submitted, not the beacon the page sent before it.
    assert.ok(card.details.startsWith(`POST ${f.url}/notes\n`) && /real = yes/.test(card.details), card.details);
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    const extra = await clicking;
    assert.equal(extra.outcome, 'done', extra.message);
    assert.ok((extra.blocked ?? []).some((b) => /already made a request/.test(b)), JSON.stringify(extra));
    assert.deepEqual(f.writes(), [{ method: 'POST', url: '/notes', body: 'real=yes' }]);

    // Allowed, the site answers 307: the browser does not send it again to the new address.
    f.hits.length = 0;
    clicking = clickOn('/r307form', /Send/);
    card = await pending(s, kevin.id);
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    const r307 = await clicking;
    assert.equal(r307.outcome, 'done', r307.message);
    assert.match(r307.message, /redirect that would send it again/);
    assert.deepEqual(f.writes(), [{ method: 'POST', url: '/r307', body: 'q=once' }]);
    assert.ok(!f.hits.some((h) => h.url === '/notes-again'));

    // A 303 after a form: not followed from the page acted on (that would be a request of its own); its address is said.
    f.hits.length = 0;
    clicking = clickOn('/r303form', /Send/);
    card = await pending(s, kevin.id);
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    const r303 = await clicking;
    assert.equal(r303.outcome, 'done', r303.message);
    assert.match(r303.message, new RegExp(`points to ${f.url.replace(/[.]/g, '\\.')}/notes-done: open that address`));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(f.writes(), [{ method: 'POST', url: '/r303', body: 'q=prg' }]);
    assert.equal(f.saw('/notes-done'), false);

    // Two devices allow at the same moment: one decision, one send.
    f.hits.length = 0;
    clicking = clickOn('/form', /Save note/);
    card = await pending(s, kevin.id);
    const both = await Promise.all([decide(s, card.id, 'allow'), decide(s, card.id, 'allow')]);
    assert.deepEqual(both.map((b) => b.status).sort(), [200, 409]);
    assert.equal((await clicking).outcome, 'done');
    assert.equal(f.writes().length, 1);

    // Writes a page makes on its own, outside a click or typing, are refused as always: no card.
    f.hits.length = 0;
    await turn.act({ action: 'open', url: `${f.url}/background` });
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(f.writes(), []);
    assert.equal(s.app.approvals.list({ botId: kevin.id, status: 'pending' }).length, 0);

    // A ref from before the page changed names nothing.
    await turn.act({ action: 'open', url: `${f.url}/form` });
    const old = ref((await turn.act({ action: 'read' })).content!.controls, /Save note/);
    await turn.act({ action: 'open', url: `${f.url}/other` });
    const stale = await turn.act({ action: 'click', ref: old });
    assert.equal(stale.outcome, 'refused');
    assert.match(stale.message, /changed since you last read it/);
    // Nor do actions it doesn't have.
    for (const action of ['evaluate', 'submit', 'press', 'upload']) {
      const r = await turn.raw({ action });
      assert.equal(r.status, 400, action);
      assert.match(r.data.error, /action must be one of/);
    }
    assert.equal((await turn.raw({ action: 'click', ref: '#b' })).status, 400);
    await turn.end();
    assert.deepEqual(f.writes(), []);
  } finally {
    await close();
  }
});

test('a page removed from the sites while its card waits: allowed, it is still not sent', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    await turn.act({ action: 'open', url: `${f.url}/form` });
    const clicking = turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, /Save note/) });
    const card = await pending(s, kevin.id);
    await s.call('PUT', `/api/bots/${kevin.id}/browser`, { sites: ['example.com'] });
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    const r = await clicking;
    assert.equal(r.outcome, 'refused');
    assert.match(r.message, /allowed it, but it was not sent: .*no longer one of the allowed sites/);
    assert.equal(s.app.approvals.get(card.id).tool?.usedAt, null);
    await turn.end();
    assert.deepEqual(f.writes(), []);
  } finally {
    await close();
  }
});

for (const provider of ['claude-cli', 'codex-cli'] as const) {
  test(`a ${provider === 'claude-cli' ? 'Claude' : 'Codex'} turn types and clicks through the browser connector; the form goes only once the owner allows its card`, async () => {
    const f = await shop();
    const s = await startServer({ fakeClis: true, env: browserEnv() });
    useTestCodexHome(s.cfg.home);
    try {
      const kevin = await s.newBot('Kevin', { provider, access: 'host', connections: [BROWSER_CONNECTOR] });
      await s.call('PUT', `/api/bots/${kevin.id}/browser`, { sites: [new URL(f.url).host] });
      const cli = provider === 'codex-cli' ? s.codex : s.claude;
      // The form's controls in order: the note (e0), the password (e1), the card number (e2), the button (e3).
      cli.script({
        fixture: provider === 'codex-cli' ? 'codex/reply' : 'claude/reply',
        mcp: {
          waitMs: 15_000,
          calls: [
            { server: BROWSER_SERVER, tool: 'browser_open', arguments: { url: `${f.url}/form` } },
            { server: BROWSER_SERVER, tool: 'browser_read' },
            { server: BROWSER_SERVER, tool: 'browser_type', arguments: { ref: 'e1', text: 'dummy-secret-2' } },
            { server: BROWSER_SERVER, tool: 'browser_type', arguments: { ref: 'e0', text: 'From the Boton' } },
            { server: BROWSER_SERVER, tool: 'browser_click', arguments: { ref: 'e3' } },
          ],
        },
      });
      const replying = s.chat(kevin.id, 'Save a note on the form.');
      const card = await pending(s, kevin.id);
      assert.deepEqual(f.writes(), []);
      assert.match(card.details, /note = From the Boton/);
      assert.equal((await decide(s, card.id, 'allow')).status, 200);
      const reply = await replying;
      assert.equal(reply.role, 'bot', reply.text);
      const call = cli.calls()[0];
      if (provider === 'codex-cli') assert.ok(call.argv.some((a) => a.startsWith(`mcp_servers.${BROWSER_SERVER}.tool_timeout_sec=`)), call.argv.join(' '));
      assert.match(call.stdin, /Your browser: [^\n]*waits on [^\n]*card/);
      const results = call.mcpResults!;
      assert.deepEqual(
        results.map((r) => [r.tool, r.isError]),
        [
          ['browser_open', false],
          ['browser_read', false],
          ['browser_type', true],
          ['browser_type', false],
          ['browser_click', false],
        ],
        JSON.stringify(results, null, 1),
      );
      assert.match(results[1].text, /e3 button: "Save note"/);
      assert.match(results[1].text, /e1 field: "Password" \(no typing/);
      assert.match(results[2].text, /never types passwords/);
      assert.match(results[4].text, new RegExp(`Owner's card: ${card.id} \\(allowed, sent once\\)`));
      assert.deepEqual(f.writes(), [{ method: 'POST', url: '/notes?draft=1', body: 'note=From+the+Boton&csrf=dummy-csrf-1&pw=&cardnumber=' }]);
      // The card's decision shows in the chat as it was made, inside the turn: no follow-up turn.
      assert.ok((await s.messagesOf(kevin.id)).some((m) => m.meta?.kind === 'approval.decided' && m.meta.approvalId === card.id && m.role === 'event'));
    } finally {
      await s.stop();
      await f.close();
    }
  });
}

test('a GET a click or typing makes waits on a card like a form: a GET form, a script GET, typing; none reaches the site before the owner decides', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    const start = async (path: string, label: RegExp, typed?: string) => {
      await turn.act({ action: 'open', url: `${f.url}${path}` });
      const r = ref((await turn.act({ action: 'read' })).content!.controls, label);
      return turn.act(typed === undefined ? { action: 'click', ref: r } : { action: 'type', ref: r, text: typed });
    };

    // A GET form: held, shown with its full query, and denied it never reaches the site.
    let acting = start('/getform', /Send it/);
    let card = await pending(s, kevin.id);
    assert.ok(card.details.startsWith(`GET ${f.url}/send-message?to=kevin\n`), card.details);
    assert.equal(f.saw('/send-message'), false);
    assert.equal((await decide(s, card.id, 'deny')).status, 200);
    let r = await acting;
    assert.equal(r.outcome, 'refused');
    assert.deepEqual(r.approval, { id: card.id, status: 'denied', delivery: 'not-sent' });
    assert.equal(f.saw('/send-message'), false);

    // A script's GET on a click: held; allowed, it reaches the site once.
    acting = start('/scriptget', /Send/);
    card = await pending(s, kevin.id);
    assert.ok(card.details.startsWith(`GET ${f.url}/send-message?via=script\n`), card.details);
    assert.equal(f.saw('/send-message'), false);
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    r = await acting;
    assert.equal(r.outcome, 'done', r.message);
    assert.deepEqual(r.approval, { id: card.id, status: 'allowed', delivery: 'sent' });
    assert.equal(f.hits.filter((h) => h.url === '/send-message?via=script').length, 1);
    assert.equal(s.app.approvals.get(card.id).tool?.delivery, 'sent');

    // Typing that makes the page send a GET (a search as you type).
    acting = start('/typeget', /Search/, 'hello');
    card = await pending(s, kevin.id);
    assert.ok(card.details.startsWith(`GET ${f.url}/send-message?typed=hello\n`), card.details);
    assert.equal((await decide(s, card.id, 'deny')).status, 200);
    assert.equal((await acting).outcome, 'refused');
    assert.equal(f.saw('/send-message?typed'), false);
    await turn.end();
  } finally {
    await close();
  }
});

test('a page acted on sends nothing more on its own: not a timer\'s GET, an image, a beacon or keepalive as it unloads; a link opens its address; a fresh page loads as before', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    // Signed in with a session cookie (sid=OLD, no expiry), which the browser that replaces this one keeps.
    await turn.act({ action: 'open', url: `${f.url}/cookieform` });
    await jarHas(s, kevin.id, f.url, 'OLD');
    await turn.act({ action: 'open', url: `${f.url}/later` });
    const clicked = await turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, /Toggle/) });
    assert.equal(clicked.outcome, 'done', clicked.message);
    assert.match(clicked.message, /The page sent nothing/);
    // Its timer fires after the step: refused, no card.
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(f.saw('/send-message'), false, JSON.stringify(f.hits));
    assert.equal(s.app.approvals.list({ botId: kevin.id, status: 'pending' }).length, 0);
    // Leaving it (its pagehide sends a beacon and a keepalive fetch): that whole browser ends, so the old page's
    // requests go nowhere, and a new one opens the address with the same cookies, not restoring the page left.
    f.hits.length = 0;
    const opened = await turn.act({ action: 'open', url: `${f.url}/other` });
    assert.equal(opened.outcome, 'done', opened.message);
    await until(() => f.saw('/pixel'), 5000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(f.saw('/send-message'), false, JSON.stringify(f.hits));
    assert.equal(f.saw('/later'), false, JSON.stringify(f.hits));
    assert.equal(f.hits.find((h) => h.url === '/other')?.cookie, 'sid=OLD');
    const journal = (await s.call('GET', `/api/bots/${kevin.id}/browser/journal`)).data as { action: string; url: string; detail: string }[];
    assert.ok(journal.some((e) => e.action === 'blocked' && e.url.includes('/send-message') && /clicked or typed on|page the browser has left/.test(e.detail)), JSON.stringify(journal));

    // A link to an allowed site: its address opens (no card), and the page's script for the click never runs.
    f.hits.length = 0;
    await turn.act({ action: 'open', url: `${f.url}/links` });
    const link = await turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, /Other page/) });
    assert.equal(link.outcome, 'done', link.message);
    assert.match(link.message, /Opened the address of the link/);
    assert.equal(link.page?.url, `${f.url}/other?…`);
    assert.ok(f.saw('/other?from=link'));
    assert.equal(f.saw('/send-message'), false);
    assert.equal(s.app.approvals.list({ botId: kevin.id }).filter((a) => a.status === 'pending').length, 0);

    // Back from a page acted on: the page before, in a fresh tab.
    await turn.act({ action: 'open', url: `${f.url}/form` });
    await turn.act({ action: 'open', url: `${f.url}/later` });
    await turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, /Toggle/) });
    const back = await turn.act({ action: 'back' });
    assert.equal(back.outcome, 'done', back.message);
    assert.equal(back.page?.url, `${f.url}/form`);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(f.saw('/send-message'), false, JSON.stringify(f.hits));
    await turn.end();
  } finally {
    await close();
  }
});

for (const scheme of ['http', 'https'] as const) {
  test(`over ${scheme}: allowed, the request goes with exactly the cookies it was held with, or none; the site's cookies changing as it acts, after the hold or while the card waits still gets a card, which names them`, async () => {
    const { f, s, kevin, close } = await setup(undefined, scheme === 'https' ? testCert() : undefined);
    try {
      const turn = browserTurn(s, kevin.id);
      const read = async (path: string) => {
        await turn.act({ action: 'open', url: `${f.url}${path}` });
        return (await turn.act({ action: 'read' })).content!.controls;
      };
      const posts = () => f.hits.filter((h) => h.method === 'POST').map((h) => [h.url, h.body, h.cookie]);
      // A click whose request gets a card, allowed: what the site got, and the card.
      const allowed = async (controls: BrowserControl[], label: RegExp) => {
        f.hits.length = 0;
        const clicking = turn.act({ action: 'click', ref: ref(controls, label) });
        const card = await pending(s, kevin.id);
        assert.equal((await decide(s, card.id, 'allow')).status, 200);
        const r = await clicking;
        assert.equal(r.outcome, 'done', r.message);
        return { card, sent: posts() };
      };

      // Signed in (sid=OLD): the card names the cookie, never its value; allowed, the site gets exactly sid=OLD, once.
      let { card, sent } = await allowed(await read('/cookieform'), /Buy/);
      assert.match(card.details, /goes with the browser's own cookies for 127\.0\.0\.1:\d+ \(values not shown\): sid\./);
      assert.ok(!card.details.includes('OLD'), card.details);
      assert.doesNotMatch(card.details, /set or changed/);
      assert.deepEqual(sent, [['/notes', 'item=42', 'sid=OLD']]);

      // Two cookies of one name (sid=CHK for /notes, sid=OLD for /): sent in the order Chromium wrote them.
      await setCookies(s, kevin.id, f.url, [{ name: 'sid', value: 'CHK', path: '/notes' }]);
      ({ sent } = await allowed(await read('/cookieform'), /Buy/));
      assert.deepEqual(sent, [['/notes', 'item=42', 'sid=CHK; sid=OLD']]);

      // The two swapped before Chromium writes the request's headers (the site's own cookies changing as it acts): a
      // card that says so, and the request goes with them as written.
      const swap = () => setCookies(s, kevin.id, f.url, [{ name: 'sid', value: 'OLD', path: '/notes' }, { name: 'sid', value: 'CHK', path: '/' }]);
      const unswap = () => setCookies(s, kevin.id, f.url, [{ name: 'sid', value: 'CHK', path: '/notes' }, { name: 'sid', value: 'OLD', path: '/' }]);
      let controls = await read('/cookieform');
      let gate = atGate(s, kevin.id, 'acting', swap);
      ({ card, sent } = await allowed(controls, /Buy/));
      gate();
      assert.match(card.details, /The site set or changed sid while the browser acted/);
      assert.deepEqual(sent, [['/notes', 'item=42', 'sid=OLD; sid=CHK']]);

      // Swapped after its headers were read: it carries what the browser held as the step began, and goes as held.
      await unswap();
      controls = await read('/cookieform');
      gate = atGate(s, kevin.id, 'held', swap);
      ({ sent } = await allowed(controls, /Buy/));
      gate();
      assert.deepEqual(sent, [['/notes', 'item=42', 'sid=CHK; sid=OLD']]);

      // Swapped once its card exists: allowed, it goes exactly as the card showed it, once.
      await unswap();
      controls = await read('/cookieform');
      gate = atGate(s, kevin.id, 'card', swap);
      ({ card, sent } = await allowed(controls, /Buy/));
      gate();
      assert.deepEqual(sent, [['/notes', 'item=42', 'sid=CHK; sid=OLD']]);
      assert.ok(s.app.approvals.get(card.id).tool?.usedAt);

      // A script's request made without cookies (credentials: 'omit'): sent without any, though the browser has sid.
      await unswap();
      ({ card, sent } = await allowed(await read('/cookieform?mode=omit'), /Omit/));
      assert.match(card.details, /It goes without cookies\./);
      assert.deepEqual(sent, [['/notes', 'x=1', null]]);
      await turn.end();

      // Another Boton's browser, never signed in here: without cookies it goes without any; a cookie the site sets as
      // it acts rides along, named on the card, and the owner can deny it.
      const stuart = await s.newBot('Stuart', { provider: 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
      assert.equal((await s.call('PUT', `/api/bots/${stuart.id}/browser`, { sites: [new URL(f.url).host] })).status, 200);
      const fresh = browserTurn(s, stuart.id);
      f.hits.length = 0;
      await fresh.act({ action: 'open', url: `${f.url}/cookieform?mode=none` });
      gate = atGate(s, stuart.id, 'acting', () => setCookies(s, stuart.id, f.url, [{ name: 'sid', value: 'NEW', path: '/' }]));
      const clicking = fresh.act({ action: 'click', ref: ref((await fresh.act({ action: 'read' })).content!.controls, /Buy/) });
      card = await pending(s, stuart.id);
      gate();
      assert.match(card.details, /The site set or changed sid while the browser acted/);
      assert.equal((await decide(s, card.id, 'deny')).status, 200);
      const r = await clicking;
      assert.equal(r.outcome, 'refused', r.message);
      assert.deepEqual(f.writes(), []);
      await fresh.end();
    } finally {
      s.app.browser.testGate = null;
      await close();
    }
  });
}

test('the site gets the request and drops the connection before answering: delivery unknown everywhere (result, card, journal), never "nothing sent"; a site gone before it is sent: not sent', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    await turn.act({ action: 'open', url: `${f.url}/dropform` });
    let clicking = turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, /Pay/) });
    let card = await pending(s, kevin.id);
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    let r = await clicking;
    assert.equal(r.outcome, 'refused', r.message);
    assert.deepEqual(r.approval, { id: card.id, status: 'allowed', delivery: 'unknown' });
    assert.match(r.message, /it may have reached 127\.0\.0\.1:\d+ and been acted on\. Don't send it again/);
    assert.doesNotMatch(r.message, /not sent|Nothing reached/);
    assert.match(formatResult(r), /whether it arrived is unknown: never send it again/);
    assert.deepEqual(f.writes(), [{ method: 'POST', url: '/drop', body: 'pay=7' }]);
    const spent = s.app.approvals.get(card.id);
    assert.equal(spent.tool?.delivery, 'unknown');
    assert.ok(spent.tool?.usedAt);
    const journal = (await s.call('GET', `/api/bots/${kevin.id}/browser/journal`)).data as { action: string; detail: string }[];
    assert.ok(journal.some((e) => e.action === 'sent' && /delivery unknown/.test(e.detail) && e.detail.includes(card.id)), JSON.stringify(journal));
    // Spent: allowing again does nothing.
    assert.equal((await decide(s, card.id, 'allow')).status, 409);
    assert.equal(f.writes().length, 1);

    // The site is gone by the time it is allowed: not sent, and said so (nothing reached it).
    await turn.act({ action: 'open', url: `${f.url}/form` });
    clicking = turn.act({ action: 'click', ref: ref((await turn.act({ action: 'read' })).content!.controls, /Save note/) });
    card = await pending(s, kevin.id);
    await f.close();
    assert.equal((await decide(s, card.id, 'allow')).status, 200);
    r = await clicking;
    assert.equal(r.outcome, 'refused', r.message);
    assert.deepEqual(r.approval, { id: card.id, status: 'allowed', delivery: 'not-sent' });
    assert.match(r.message, /Nothing reached the site/);
    assert.equal(s.app.approvals.get(card.id).tool?.delivery, 'not-sent');
    await turn.end();
  } finally {
    await s.stop();
    await f.close();
  }
});
