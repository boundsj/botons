// The owner's handover of a Boton's browser: the owner signs it in themselves, from one paired device, with fixed
// inputs (open, click, type, a key), while the Boton can't use it; then the Boton reads the site signed in. Real
// Chromium against a loopback fixture site with a fake sign-in and a dummy account (no real accounts, sites or
// credentials); like browser.test.ts these need Chromium and fail without one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { BrowserActionResult, BrowserHandover, BrowserHandoverResult, BrowserStatus } from '../../shared/types.ts';
import { BROWSER_CONNECTOR, BROWSER_SERVER } from '../../shared/util.ts';
import { backup } from '../src/backup.ts';
import { findBrowser } from '../src/browser.ts';
import { MAX_OWNER_TEXT, parseOwnerInput, RateWindow } from '../src/browser-handover.ts';
import { tapLogs } from '../src/log.ts';
import type { FakeCli } from './fixtures/fake-cli.ts';
import { freePort, pairDevice, startServer, type TestServer, tempDir, until, useTestCodexHome } from './helpers.ts';

const found = await findBrowser(process.env.BOTONS_BROWSER_PATH ?? '');
const CHROMIUM = found.executable ?? '';
/** The fake site's one account: dummy values, made up for these tests. */
const USER = 'kevin-test';
const PASSWORD = 'dummy-Pa55word-for-tests-only';
const H = 'ho_abcdefghijkl';
/** What the owner types into a form's ordinary text, one-time-code and password fields: made-up markers. */
const SECRETS = { text: 'dummy-ordinary-text-secret', code: 'dummy-one-time-code-secret', pw: 'dummy-password-field-secret' };

/** A certificate made for this run, for the fake site's HTTPS (127.0.0.1 only). */
function testCert(): { key: string; cert: string; spki: string } {
  const dir = tempDir();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const key = readFileSync(join(dir, 'k.pem'), 'utf8');
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  const spki = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('base64');
  return { key, cert, spki };
}
const TLS = testCert();

// ------------------------------------------------------------------ inputs, without a browser

test('an input is one fixed action with values in range; refusals never repeat what was sent', () => {
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'click', x: 10.4, y: 799 }), { handover: H, action: 'click', x: 10, y: 799 });
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'key', key: 'Shift+Tab' }), { handover: H, action: 'key', key: 'Shift+Tab' });
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'type', text: PASSWORD, extra: 'dropped' }), { handover: H, action: 'type', text: PASSWORD });
  const refused = (v: unknown) => {
    try {
      parseOwnerInput(v);
    } catch (err) {
      return (err as Error).message;
    }
    assert.fail(`accepted ${JSON.stringify(v)}`);
  };
  for (const bad of [
    null,
    [],
    { action: 'click', x: 1, y: 1 },
    { handover: 'not-one', action: 'click', x: 1, y: 1 },
    { handover: H, action: 'eval', script: 'document.cookie' },
    { handover: H, action: 'evaluate' },
    { handover: H, action: 'cookies' },
    { handover: H, action: 'click', x: 1920, y: 1 },
    { handover: H, action: 'click', x: -1, y: 1 },
    { handover: H, action: 'click', x: Number.NaN, y: 1 },
    { handover: H, action: 'key', key: 'Control+L' },
    { handover: H, action: 'key', key: 'F12' },
    { handover: H, action: 'type', text: '' },
    { handover: H, action: 'scroll', dy: 1e9 },
    { handover: H, action: 'open', url: 'x'.repeat(2001) },
  ]) {
    refused(bad);
  }
  for (const text of [`${PASSWORD}\n`, `${PASSWORD}\u0007`, `${PASSWORD}${'x'.repeat(MAX_OWNER_TEXT)}`]) {
    const why = refused({ handover: H, action: 'type', text });
    assert.ok(!why.includes(PASSWORD), why);
  }
  const w = new RateWindow(2, 1000);
  assert.equal(w.take(0), true);
  assert.equal(w.take(10), true);
  assert.equal(w.take(20), false);
  assert.equal(w.take(1001), true);
});

// ------------------------------------------------------------------ a fake site with a sign-in

interface Site {
  server: Server;
  url: string;
  hits: { method: string; url: string; body: string }[];
  logins: { user: string; pw: string }[];
  close: () => Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;
const at = (top: number) => `position:absolute;left:40px;top:${top}px;width:400px;height:40px;font-size:20px`;

async function site(tls = false): Promise<Site> {
  const hits: Site['hits'] = [];
  const logins: Site['logins'] = [];
  const sessions = new Set<string>();
  let n = 0;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
      const path = (req.url ?? '/').split('?')[0];
      const html = (title: string, b: string, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(page(title, b));
      };
      if (path === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        const user = form.get('user') ?? '';
        const pw = form.get('pw') ?? '';
        logins.push({ user, pw });
        if (user !== USER || pw !== PASSWORD) return html('Sign in', '<p>Wrong user name or password</p>');
        const sid = `s-${++n}`;
        sessions.add(sid);
        // A session cookie (no expiry): the kind a profile doesn't keep across a browser's restart.
        res.writeHead(303, { location: '/account', 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
        return res.end();
      }
      // A form of every kind of field: ordinary text, a one-time code and a password. Sent, it signs in for an hour.
      if (path === '/form' && req.method === 'POST') {
        const sid = `s-${++n}`;
        sessions.add(sid);
        logins.push({ user: 'form', pw: '' });
        res.writeHead(303, { location: '/cookies', 'set-cookie': [`sid=${sid}; Path=/; HttpOnly`, `keep=${sid}; Path=/; Max-Age=3600; HttpOnly`] });
        return res.end();
      }
      if (path === '/form') {
        return html(
          'Form',
          `<form method="post" action="/form">
             <input name="note" type="text" aria-label="Note" style="${at(40)}">
             <input name="code" type="text" autocomplete="one-time-code" inputmode="numeric" aria-label="Code" style="${at(120)}">
             <input name="pw" type="password" aria-label="Password" style="${at(200)}">
             <button style="${at(280)}">Send</button>
           </form>`,
        );
      }
      // The names of the cookies the browser sent (never their values).
      if (path === '/cookies') {
        const names = (req.headers.cookie ?? '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).sort();
        return html('Cookies', `<p>cookies: ${names.join(' ') || 'none'}</p>`);
      }
      if (path === '/prior') return html('Prior', '<p>prior</p>', { 'set-cookie': 'prior=1; Path=/; Max-Age=3600' });
      // A page that writes as it unloads, as any page may (a beacon on pagehide).
      if (path === '/unload') return html('Unload', `<p>unload</p><script>addEventListener('pagehide', () => navigator.sendBeacon('/write', 'dummy-write'))</script>`);
      // One that goes elsewhere by itself a moment after it loads, writing as it goes.
      if (path === '/self') {
        return html('Self', `<script>addEventListener('pagehide', () => navigator.sendBeacon('/write', 'dummy-write')); setTimeout(() => (location.href = '/account'), 600)</script>`);
      }
      // One that opens another tab, which writes as it is closed; and one whose worker writes.
      if (path === '/popup') return html('Popup', `<script>setTimeout(() => window.open('/unload'), 200)</script>`);
      if (path === '/worker') return html('Worker', `<script>new Worker('/worker.js')</script>`);
      if (path === '/worker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(`setInterval(() => fetch('/write', { method: 'POST', body: 'dummy-write', keepalive: true }).catch(() => {}), 150)`);
      }
      if (path === '/write') return html('Written', 'ok');
      if (path === '/login') {
        return html(
          'Sign in',
          `<form method="post" action="/login">
             <input name="user" aria-label="User name" style="${at(40)}">
             <input name="pw" type="password" aria-label="Password" style="${at(120)}">
             <button style="${at(200)}">Sign in</button>
           </form>`,
        );
      }
      if (path === '/account') {
        const sid = /(?:^|;\s*)(?:sid|keep)=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
        return html('Account', sessions.has(sid) ? `<p>Signed in as ${USER}</p>` : '<p>Not signed in</p>');
      }
      if (path === '/note' && req.method === 'GET') return html('Note', '<form method="post" action="/note"><input name="note" value="hi"><button>Save note</button></form>');
      // A page that posts on its own, all the time: only what follows the owner's own input may go.
      if (path === '/poll' && req.method === 'POST') return html('Polled', 'ok');
      if (path === '/background') {
        return html('Background', `<p>polling</p><script>setInterval(() => fetch('/poll', { method: 'POST', body: 'bg' }).catch(() => {}), 150);</script>`);
      }
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(page('Not found', 'nothing here'));
    });
  };
  const server: Server = tls ? createHttpsServer({ key: TLS.key, cert: TLS.cert }, handler) : createServer(handler);
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    server,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    hits,
    logins,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const browserEnv = { BOTONS_BROWSER_PATH: CHROMIUM, BOTONS_APPROVAL_WAIT: '20s', BOTONS_LOG_LEVEL: 'info' };

async function setup(opts: { provider?: 'claude-cli' | 'codex-cli'; fakeClis?: boolean; tls?: boolean } = {}) {
  const f = await site(opts.tls);
  const s: TestServer & Partial<{ claude: FakeCli; codex: FakeCli }> = await startServer({ env: browserEnv, fakeClis: !!opts.fakeClis });
  if (opts.fakeClis) useTestCodexHome(s.cfg.home);
  if (opts.tls) s.app.browser.testTrust = { cert: TLS.cert, spki: TLS.spki };
  const kevin = await s.newBot('Kevin', { provider: opts.provider ?? 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
  assert.equal((await s.call('PUT', `/api/bots/${kevin.id}/browser`, { sites: [new URL(f.url).host] })).status, 200);
  return { f, s, kevin, close: async () => (await s.stop(), await f.close()) };
}

/** The owner's handover of `botId`'s browser, from the test's paired device (or `token`'s). */
async function takeOver(s: TestServer, botId: string, token?: string) {
  const r = await s.call<BrowserHandover>('POST', `/api/bots/${botId}/browser/handover`, {}, token);
  assert.equal(r.status, 201, r.text);
  const h = r.data;
  return {
    h,
    input: (body: Record<string, unknown>, as?: string) => s.call<BrowserHandoverResult>('POST', `/api/bots/${botId}/browser/handover/input`, { handover: h.id, ...body }, as ?? token),
    act: async (body: Record<string, unknown>) => {
      const r = await s.call<BrowserHandoverResult>('POST', `/api/bots/${botId}/browser/handover/input`, { handover: h.id, ...body }, token);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.outcome, 'done', r.data.message);
      return r.data;
    },
    frame: (as?: string) => fetch(`${s.base}/api/bots/${botId}/browser/handover/frame`, { headers: { authorization: `Bearer ${as ?? token ?? s.token}` } }),
    finish: async () => {
      const r = await s.call<BrowserStatus>('POST', `/api/bots/${botId}/browser/handover/finish`, { handover: h.id }, token);
      assert.equal(r.status, 200, r.text);
      return r.data;
    },
  };
}

/** Signs in on the fake site: a click on the user name, typing, Tab, typing the password, Enter. */
async function signIn(o: Awaited<ReturnType<typeof takeOver>>, f: Site) {
  await o.act({ action: 'open', url: `${f.url}/login` });
  await o.act({ action: 'click', x: 200, y: 60 });
  await o.act({ action: 'type', text: USER });
  await o.act({ action: 'key', key: 'Tab' });
  await o.act({ action: 'type', text: PASSWORD });
  await o.act({ action: 'key', key: 'Enter' });
  await until(() => f.logins.length > 0, 15_000);
  await until(() => f.hits.some((x) => x.url === '/account'), 15_000);
}

function browserTurn(s: TestServer, botId: string) {
  const t = s.app.auth.mintBotonToken(botId);
  s.app.browser.beginTurn(botId, t.id);
  return {
    token: t.token,
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

/** Every file under `dir` that holds `needle` (as UTF-8 or UTF-16), by its path below `dir`. */
function filesHolding(dir: string, needle: string): string[] {
  const out: string[] = [];
  const forms = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')];
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > 64 * 1024 * 1024) continue;
    const bytes = readFileSync(p);
    if (forms.some((f) => bytes.includes(f))) out.push(name);
  }
  return out;
}

test('a Chromium is here: these tests need one, and fail rather than skip without it', () => {
  assert.ok(found.available, `${found.why}`);
});

test('only paired devices reach a handover: a Boton token is refused everywhere, no token is 401, another device drives nothing', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    const routes: [string, string][] = [
      ['POST', `/api/bots/${kevin.id}/browser/handover`],
      ['GET', `/api/bots/${kevin.id}/browser/handover/frame`],
      ['POST', `/api/bots/${kevin.id}/browser/handover/input`],
      ['POST', `/api/bots/${kevin.id}/browser/handover/finish`],
    ];
    for (const [m, p] of routes) {
      assert.equal((await s.call(m, p, { handover: H, action: 'reload' }, turn.token)).status, 403, `${m} ${p} with a Boton token`);
      assert.equal((await s.call(m, p, { handover: H, action: 'reload' }, null)).status, 401, `${m} ${p} with no token`);
    }
    assert.equal((await s.call<BrowserStatus>('GET', `/api/bots/${kevin.id}/browser`)).data.handover, null);

    const o = await takeOver(s, kevin.id);
    assert.match(o.h.id, /^ho_/);
    assert.equal(o.h.byThisDevice, true);
    // The same device again: the same handover. A Boton token still can't end it.
    assert.equal((await takeOver(s, kevin.id)).h.id, o.h.id);
    assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/handover/finish`, {}, turn.token)).status, 403);

    // Another paired device sees that it is under way, gets no frame and sends no input, and can end it.
    const other = await pairDevice(s.app, s.base, 'Other phone');
    assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/handover`, {}, other)).status, 409);
    const seen = (await s.call<BrowserStatus>('GET', `/api/bots/${kevin.id}/browser`, undefined, other)).data.handover!;
    assert.equal(seen.byThisDevice, false);
    assert.equal(seen.id, o.h.id);
    assert.equal((await o.frame(other)).status, 403);
    assert.equal((await o.input({ action: 'open', url: `${f.url}/login` }, other)).status, 403);
    // An input for another handover id never reaches this one.
    assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/handover/input`, { handover: H, action: 'reload' })).status, 409);
    assert.equal((await s.call<BrowserStatus>('POST', `/api/bots/${kevin.id}/browser/handover/finish`, { handover: o.h.id }, other)).data.handover, null);
    assert.equal((await o.input({ action: 'reload' })).status, 409);
    const audit = s.app.store.db.prepare("select action, details from audit_events where action like 'browser.handover%' order by seq").all() as { action: string; details: string }[];
    assert.deepEqual(audit.map((a) => a.action), ['browser.handover_started', 'browser.handover_ended']);
    assert.equal(JSON.parse(audit[1].details).reason, 'finished');
    await turn.end();
  } finally {
    await close();
  }
});

test('the owner signs in with fixed inputs and a live view; the credentials go only to the site; frames are kept nowhere', async () => {
  const { f, s, kevin, close } = await setup();
  const said: string[] = [];
  const untap = tapLogs((level, msg, fields) => said.push(`${level} ${msg} ${JSON.stringify(fields, (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v))}`));
  try {
    const o = await takeOver(s, kevin.id);
    // Nothing is opened for the owner: the page is blank until they choose an address.
    const first = await o.frame();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/jpeg');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual([...Buffer.from(await first.arrayBuffer()).subarray(0, 2)], [0xff, 0xd8]);
    // At most one frame every so often.
    const [a, b] = await Promise.all([o.frame(), o.frame()]);
    assert.ok([a.status, b.status].includes(429), `${a.status} ${b.status}`);

    // Only the Boton's sites, only http(s).
    const off = await o.input({ action: 'open', url: 'https://example.com/' });
    assert.equal(off.data.outcome, 'refused');
    assert.equal((await o.input({ action: 'open', url: 'file:///etc/passwd' })).data.outcome, 'refused');

    await signIn(o, f);
    assert.deepEqual(f.logins, [{ user: USER, pw: PASSWORD }]);
    // The status says where its page is (origin and path), once the page has committed it.
    await until(async () => /\/account$/.test((await s.call<BrowserStatus>('GET', `/api/bots/${kevin.id}/browser`)).data.handover?.page?.url ?? ''), 10_000);
    const jar = await s.app.browser.testOwnerJar(kevin.id);
    assert.ok((await jar!.cookies(f.url)).some((c) => c.name === 'sid'));

    const ended = await o.finish();
    assert.equal(ended.handover, null);
    assert.equal(ended.running, false);
    assert.equal(await s.app.browser.testOwnerJar(kevin.id), null);

    // The password reached the fake site and nothing of Botons: not its database (audit, events, approvals,
    // messages), the journal, the workspace, the log, or any file it keeps, the browser profile included.
    assert.deepEqual(filesHolding(s.home, PASSWORD), []);
    // Chromium saved no password and no autofill entry for the sign-in (the profile is backed up).
    const profile = join(s.home, 'browser', kevin.id, 'profile', 'Default');
    const logins = new DatabaseSync(join(profile, 'Login Data'), { readOnly: true });
    assert.equal((logins.prepare('select count(*) as n from logins').get() as { n: number }).n, 0);
    logins.close();
    assert.ok(!filesHolding(profile, USER).some((p) => /^(Login Data|Web Data)/.test(p)), JSON.stringify(filesHolding(profile, USER)));
    assert.ok(!said.join('\n').includes(PASSWORD), 'the password is in the log');
    const journal = (await s.call('GET', `/api/bots/${kevin.id}/browser/journal`)).text;
    assert.ok(!journal.includes(PASSWORD) && !journal.includes(USER), journal);
    assert.match(journal, /took the browser over/);
    assert.match(journal, /POST sent by the page, after/);
    // Chromium didn't even try to check the password with its leak service (the proxy would refuse it anyway).
    assert.ok(!/leakcheck/i.test(journal), journal);
    const audit = s.app.store.db.prepare("select details from audit_events where action like 'browser.%'").all();
    assert.ok(!JSON.stringify(audit).includes(PASSWORD));
    // No screenshot was saved anywhere: frames are made on demand only.
    assert.deepEqual(filesHolding(s.home, 'browser-screenshots'), []);
  } finally {
    untap();
    await close();
  }
});

test('while the owner has it the Boton is refused, whatever it asks; after, it reads the site signed in', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    assert.equal((await turn.act({ action: 'open', url: `${f.url}/account` })).outcome, 'done');
    assert.match((await turn.act({ action: 'read' })).content!.text, /Not signed in/);

    const o = await takeOver(s, kevin.id);
    const refused = await turn.act({ action: 'open', url: `${f.url}/account` });
    assert.equal(refused.outcome, 'refused');
    assert.match(refused.message, /has your browser now/);
    const botonHits = f.hits.length;
    await signIn(o, f);
    // Still refused right up to the end, whatever it asks.
    for (const action of ['read', 'screenshot', 'back']) assert.equal((await turn.act({ action })).outcome, 'refused');
    await o.finish();
    assert.ok(f.hits.length > botonHits);

    // Its browser opens again on the same profile, with the owner's session cookie: signed in.
    assert.equal((await turn.act({ action: 'open', url: `${f.url}/account` })).outcome, 'done');
    const read = await turn.act({ action: 'read' });
    assert.match(read.content!.text, new RegExp(`Signed in as ${USER}`));
    assert.ok(!JSON.stringify(read).includes(PASSWORD));
    await turn.end();
  } finally {
    await close();
  }
});

test("taking the browser over while the Boton's step waits on a card withdraws it: the held request never goes", async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const turn = browserTurn(s, kevin.id);
    await turn.act({ action: 'open', url: `${f.url}/note` });
    const controls = (await turn.act({ action: 'read' })).content!.controls;
    const button = controls.find((c) => /Save note/.test(c.label))!;
    const clicking = turn.act({ action: 'click', ref: button.ref });
    const card = await until(() => s.app.approvals.list({ botId: kevin.id, status: 'pending' })[0], 15_000);
    const o = await takeOver(s, kevin.id);
    const result = await clicking;
    assert.equal(result.outcome, 'refused');
    assert.equal(result.approval?.delivery, 'not-sent');
    assert.notEqual(s.app.approvals.get(card.id).status, 'allowed');
    // Allowing it now does nothing: the step that held it is gone with its browser.
    await s.call('POST', `/api/approvals/${card.id}/decide`, { decision: 'allow' });
    await o.finish();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(f.hits.filter((x) => x.method === 'POST'), []);
    await turn.end();
  } finally {
    await close();
  }
});

test("a page's own background writes are refused but right after the owner's input; nothing goes once it ends", async () => {
  const { f, s, kevin, close } = await setup();
  try {
    s.app.browser.testHandover = { intentMs: 1500 };
    const o = await takeOver(s, kevin.id);
    await o.act({ action: 'open', url: `${f.url}/background` });
    const polls = () => f.hits.filter((x) => x.url === '/poll' && x.method === 'POST').length;
    // Opening an address is no consent to send: the page polls, and nothing goes.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(polls(), 0);
    // Right after a click, the page's writes go (the owner is acting on it); a moment later, no more.
    await o.act({ action: 'click', x: 600, y: 400 });
    await until(() => polls() > 0, 5000);
    await new Promise((r) => setTimeout(r, 2000));
    const settled = polls();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(polls(), settled);
    // A click, then the end: nothing more after it ends.
    await o.act({ action: 'click', x: 600, y: 400 });
    await o.finish();
    const after = polls();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(polls(), after);
    const journal = (await s.call('GET', `/api/bots/${kevin.id}/browser/journal`)).text;
    assert.match(journal, /sent it on its own, not within/);
  } finally {
    await close();
  }
});

test('the kill switch, the connector taken away, a site removed, a revoked device, idle time and the server stopping each end or limit a handover', async () => {
  const { f, s, kevin, close } = await setup();
  try {
    const status = async () => (await s.call<BrowserStatus>('GET', `/api/bots/${kevin.id}/browser`)).data;
    const reasons = () => (s.app.store.db.prepare("select details from audit_events where action = 'browser.handover_ended' order by seq").all() as { details: string }[]).map((r) => JSON.parse(r.details).reason);

    // Stop: the connector comes off and the handover ends at once.
    let o = await takeOver(s, kevin.id);
    await o.act({ action: 'open', url: `${f.url}/login` });
    assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/stop`)).status, 200);
    assert.equal((await status()).handover, null);
    assert.equal((await o.input({ action: 'reload' })).status, 409);
    // With the browser off, there's nothing to take over.
    assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/handover`)).status, 409);

    // Unchecking the connector does the same.
    await s.call('PATCH', `/api/bots/${kevin.id}`, { connections: [BROWSER_CONNECTOR] });
    o = await takeOver(s, kevin.id);
    await s.call('PATCH', `/api/bots/${kevin.id}`, { connections: [] });
    await until(async () => (await status()).handover === null, 10_000);

    // A site removed: the handover can't load it any more.
    await s.call('PATCH', `/api/bots/${kevin.id}`, { connections: [BROWSER_CONNECTOR] });
    o = await takeOver(s, kevin.id);
    await s.call('PUT', `/api/bots/${kevin.id}/browser`, { sites: ['example.com'] });
    const gone = await o.input({ action: 'open', url: `${f.url}/login` });
    assert.equal(gone.data.outcome, 'refused');
    await s.call('PUT', `/api/bots/${kevin.id}/browser`, { sites: [new URL(f.url).host] });
    await o.finish();

    // The device that drives it is revoked: it ends.
    const phone = await pairDevice(s.app, s.base, 'Phone');
    o = await takeOver(s, kevin.id, phone);
    const phoneId = (s.app.store.db.prepare("select id from auth_tokens where label = 'Phone'").get() as { id: string }).id;
    assert.equal((await s.call('DELETE', `/api/devices/${phoneId}`)).status, 200);
    await until(async () => (await status()).handover === null, 10_000);

    // Nothing sent for too long: it ends on its own.
    s.app.browser.testHandover = { idleMs: 500 };
    o = await takeOver(s, kevin.id);
    await until(async () => (await status()).handover === null, 10_000);
    s.app.browser.testHandover = null;

    // The server stopping ends it too.
    o = await takeOver(s, kevin.id);
    await s.app.browser.closeAll();
    assert.equal(s.app.browser.handover(kevin.id), null);
    assert.deepEqual(reasons(), ['stopped', 'connector', 'finished', 'revoked', 'idle', 'shutdown']);
  } finally {
    await close();
  }
});

for (const provider of ['claude-cli', 'codex-cli'] as const) {
  test(`a ${provider === 'claude-cli' ? 'Claude' : 'Codex'} turn is refused its browser during a handover, and reads the site signed in after it`, async () => {
    const { f, s, kevin, close } = await setup({ provider, fakeClis: true });
    try {
      const cli = (provider === 'codex-cli' ? s.codex : s.claude)!;
      const fixture = provider === 'codex-cli' ? 'codex/reply' : 'claude/reply';
      const calls = [
        { server: BROWSER_SERVER, tool: 'browser_open', arguments: { url: `${f.url}/account` } },
        { server: BROWSER_SERVER, tool: 'browser_read' },
      ];
      const o = await takeOver(s, kevin.id);
      cli.script({ fixture, mcp: { waitMs: 15_000, calls } });
      const during = await s.chat(kevin.id, 'Check my account.');
      assert.equal(during.role, 'bot', during.text);
      const refused = cli.calls().at(-1)!.mcpResults!;
      assert.match(refused[0].text, /has your browser now/);
      assert.ok(!f.hits.some((x) => x.url === '/account'), 'the Boton reached the site during the handover');

      await signIn(o, f);
      await o.finish();
      cli.script({ fixture, mcp: { waitMs: 15_000, calls } });
      const after = await s.chat(kevin.id, 'Check my account.');
      assert.equal(after.role, 'bot', after.text);
      const results = cli.calls().at(-1)!.mcpResults!;
      assert.deepEqual(results.map((r) => r.isError), [false, false], JSON.stringify(results));
      assert.match(results[1].text, new RegExp(`Signed in as ${USER}`));
      assert.ok(!JSON.stringify(cli.calls()).includes(PASSWORD), 'the password reached the Boton');
    } finally {
      await close();
    }
  });
}

// ------------------------------------------------------------------ writes at the network boundary, over HTTP and HTTPS

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const tls of [false, true]) {
  const scheme = tls ? 'HTTPS' : 'HTTP';
  test(`${scheme}: a page's writes go only within the owner's moment, whatever sends them (an unloading page, a page leaving by itself, a closed tab, a worker), and each that goes is journaled`, async () => {
    const { f, s, kevin, close } = await setup({ tls });
    try {
      s.app.browser.testHandover = { intentMs: 1500 };
      const o = await takeOver(s, kevin.id);
      const writes = () => f.hits.filter((x) => x.url === '/write' && x.method === 'POST').length;
      // Opened, gone back, reloaded, with no click, key or typing: what the page sends as it unloads goes nowhere.
      await o.act({ action: 'open', url: `${f.url}/unload` });
      await o.act({ action: 'open', url: `${f.url}/account` });
      await o.act({ action: 'back' });
      await o.act({ action: 'reload' });
      await o.act({ action: 'open', url: `${f.url}/account` });
      // A click, then the moment passes: opening another page still sends nothing of the old one's.
      await o.act({ action: 'open', url: `${f.url}/unload` });
      await o.act({ action: 'click', x: 600, y: 400 });
      await sleep(1700);
      await o.act({ action: 'open', url: `${f.url}/account` });
      // A click and at once another address: opening ends the moment there and then.
      await o.act({ action: 'open', url: `${f.url}/unload` });
      await o.act({ action: 'click', x: 600, y: 400 });
      await o.act({ action: 'open', url: `${f.url}/account` });
      // A page that leaves by itself, one whose new tab is closed, one whose worker writes.
      for (const path of ['/self', '/popup', '/worker']) {
        await o.act({ action: 'open', url: `${f.url}${path}` });
        await sleep(1500);
      }
      await o.act({ action: 'open', url: `${f.url}/account` });
      await sleep(800);
      assert.equal(writes(), 0, `${writes()} writes reached the site`);
      const journal = s.app.browser.journal(kevin.id, 2000);
      // Refused at the proxy itself, where Playwright's routing never saw it (the unloading page's beacon).
      assert.ok(journal.some((e) => e.action === 'blocked' && e.url.endsWith('/write') && /a POST request to .*only reads pages/.test(e.detail)), JSON.stringify(journal.filter((e) => e.url.endsWith('/write'))));

      // Within the owner's moment the page's writes go, and every one that left is in the journal.
      await o.act({ action: 'open', url: `${f.url}/background` });
      await o.act({ action: 'click', x: 600, y: 400 });
      const polls = () => f.hits.filter((x) => x.url === '/poll' && x.method === 'POST').length;
      await until(() => polls() > 0, 5000);
      await o.finish();
      const sent = s.app.browser.journal(kevin.id, 2000).filter((e) => e.action === 'handover' && e.url.endsWith('/poll') && /^POST sent by the page/.test(e.detail)).length;
      assert.ok(sent >= polls() && polls() > 0, `${polls()} writes reached the site, ${sent} journaled`);
      const after = polls();
      await sleep(800);
      assert.equal(polls(), after);
      assert.equal(writes(), 0);
    } finally {
      await close();
    }
  });

  test(`${scheme}: what the owner types (ordinary text, a one-time code, a password) is in no file once the handover ends, however it ends, nor in a backup or after a restart; the cookies stay`, async () => {
    const { f, s, kevin, close } = await setup({ tls });
    let s2: TestServer | null = null;
    let stopped = false;
    const said: string[] = [];
    const untap = tapLogs((level, msg, fields) => said.push(`${level} ${msg} ${JSON.stringify(fields)}`));
    try {
      const handoverDir = join(s.home, 'browser', kevin.id, 'handover');
      const holding = (dir: string) => Object.values(SECRETS).flatMap((v) => filesHolding(dir, v).map((p) => `${p}: ${v}`));
      const cookieNames = async (srv: TestServer) => {
        const turn = browserTurn(srv, kevin.id);
        // A handover that ended on its own may still be giving the cookies back: until then the Boton is refused.
        await until(async () => (await turn.act({ action: 'open', url: `${f.url}/cookies` })).outcome === 'done', 15_000);
        const text = (await turn.act({ action: 'read' })).content!.text;
        await turn.end();
        return /cookies: ([^\n]*)/.exec(text)?.[1].split(' ') ?? [];
      };
      // The Boton's profile holds a cookie from before, which no handover may lose.
      const turn = browserTurn(s, kevin.id);
      assert.equal((await turn.act({ action: 'open', url: `${f.url}/prior` })).outcome, 'done');
      await turn.end();
      const fill = async (o: Awaited<ReturnType<typeof takeOver>>) => {
        const sent = f.hits.filter((x) => x.url === '/form' && x.method === 'POST').length;
        await o.act({ action: 'open', url: `${f.url}/form` });
        for (const [y, text] of [[60, SECRETS.text], [140, SECRETS.code], [220, SECRETS.pw]] as const) {
          await o.act({ action: 'click', x: 200, y });
          await o.act({ action: 'type', text });
        }
        await o.act({ action: 'key', key: 'Enter' });
        await until(() => f.hits.filter((x) => x.url === '/form' && x.method === 'POST').length > sent, 15_000);
        await until(async () => ((await (await s.app.browser.testOwnerJar(kevin.id))?.cookies(f.url)) ?? []).some((k) => k.name === 'keep'), 10_000);
        // A last input after the page arrived: its jar as of then is what comes back if its Chromium dies.
        await o.act({ action: 'scroll', dy: 10 });
      };
      const status = async () => (await s.call<BrowserStatus>('GET', `/api/bots/${kevin.id}/browser`)).data;
      const ended = async () => {
        await until(async () => (await status()).handover === null, 15_000);
        const names = await cookieNames(s);
        assert.ok(!existsSync(handoverDir), 'the handover profile is still there');
        assert.deepEqual(holding(s.home), []);
        assert.ok(names.includes('prior') && names.includes('keep'), names.join(' '));
      };

      // Finished; with a backup made while it ran, which holds none of it.
      let o = await takeOver(s, kevin.id);
      await fill(o);
      assert.ok(existsSync(handoverDir));
      const during = backup({ home: s.home });
      const out = tempDir();
      execFileSync('tar', ['-xzf', join(during.dir, 'workspaces.tar.gz'), '-C', out]);
      assert.ok(!existsSync(join(out, 'browser', kevin.id, 'handover')));
      assert.deepEqual([...holding(out), ...holding(during.dir)], []);
      await o.finish();
      await ended();

      // Its Chromium killed (by its own process id, which only this test's server started).
      o = await takeOver(s, kevin.id);
      await fill(o);
      const jar = await s.app.browser.testOwnerJar(kevin.id);
      const cdp = await jar!.browser()!.newBrowserCDPSession();
      const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
      process.kill(processInfo.find((p) => p.type === 'browser')!.id, 'SIGKILL');
      await ended();

      // Stopped with the kill switch (then given the browser again).
      o = await takeOver(s, kevin.id);
      await fill(o);
      assert.equal((await s.call('POST', `/api/bots/${kevin.id}/browser/stop`)).status, 200);
      await s.call('PATCH', `/api/bots/${kevin.id}`, { connections: [BROWSER_CONNECTOR] });
      await ended();

      // Idle too long.
      s.app.browser.testHandover = { idleMs: 4000 };
      o = await takeOver(s, kevin.id);
      await fill(o);
      await ended();
      s.app.browser.testHandover = null;

      // The device that drove it revoked.
      const phone = await pairDevice(s.app, s.base, 'Phone');
      o = await takeOver(s, kevin.id, phone);
      await fill(o);
      const phoneId = (s.app.store.db.prepare("select id from auth_tokens where label = 'Phone'").get() as { id: string }).id;
      assert.equal((await s.call('DELETE', `/api/devices/${phoneId}`)).status, 200);
      await ended();

      const reasons = (s.app.store.db.prepare("select details from audit_events where action = 'browser.handover_ended' order by seq").all() as { details: string }[]).map((r) => JSON.parse(r.details).reason);
      assert.deepEqual(reasons, ['finished', 'closed', 'stopped', 'idle', 'revoked']);

      // The server stopping in the middle of one: nothing of it is left, and after a restart the Boton is signed in.
      o = await takeOver(s, kevin.id);
      await fill(o);
      stopped = true;
      await s.stop();
      assert.ok(!existsSync(handoverDir));
      assert.deepEqual(holding(s.home), []);
      s2 = await startServer({ home: s.home, env: browserEnv });
      if (tls) s2.app.browser.testTrust = { cert: TLS.cert, spki: TLS.spki };
      const names = await cookieNames(s2);
      assert.ok(names.includes('prior') && names.includes('keep'), names.join(' '));
      const last = backup({ home: s.home, now: new Date(Date.now() + 60_000) });
      const out2 = tempDir();
      execFileSync('tar', ['-xzf', join(last.dir, 'workspaces.tar.gz'), '-C', out2]);
      assert.deepEqual([...holding(s.home), ...holding(out2), ...holding(last.dir)], []);
      // Nor in the log, the journal or the audit (the database is a file of the home, scanned above).
      for (const v of Object.values(SECRETS)) assert.ok(!said.join('\n').includes(v), `${v} is in the log`);
    } finally {
      untap();
      await s2?.stop();
      if (stopped) await f.close();
      else await close();
    }
  });
}

// A server that stopped without ending a handover (it was killed) leaves its profile: the next start deletes it.
test('a handover profile left by a server that was killed is deleted when the server starts', async () => {
  const s = await startServer({ env: browserEnv });
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
  await s.stop();
  const left = join(s.home, 'browser', kevin.id, 'handover', 'profile', 'Default', 'Sessions');
  mkdirSync(left, { recursive: true });
  const s2 = await startServer({ home: s.home, env: browserEnv });
  try {
    assert.ok(!existsSync(join(s.home, 'browser', kevin.id, 'handover')));
    assert.ok(existsSync(join(s.home, 'browser', kevin.id)));
  } finally {
    await s2.stop();
  }
});
