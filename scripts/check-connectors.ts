// `npm run check:connectors`: Settings → Connect a service in the real web app in headless Chrome, driven as the owner
// would, against a throwaway server (temp HOME and BOTONS_HOME, 127.0.0.1, free ports, no Tailscale, no real CLI)
// and a fake MCP server on loopback that takes one API key. It checks that the owner can:
// - connect a service step by step (how it connects, its details, a test, its Botons);
// - test it: Botons reaches the fake server and lists its tools, and the key never shows, even where the server
//   echoes it back in a tool name;
// - see exactly which Botons may use it (has it, may ask, its brain can't use connectors), give it to one and see
//   that Boton's turns would get it, and see the change in its history;
// - not save over a change made meanwhile: a stale view is refused and shown again;
// - find the same Botons on the connector in the MCP servers list, and take it off every Boton.
// The CLI brains are registered but not installed: a turn is not run, so this proves the grant reaches what a turn
// resolves, not that a real CLI loads the server. Exits 1 with what failed. `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ConnectorAccess } from '../shared/types.ts';
import { createApp } from '../server/src/app.ts';
import { approvePairingRequest, createPairingRequest } from '../server/src/auth.ts';
import { loadConfig } from '../server/src/config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'google-chrome' },
    out: { type: 'string' },
    'skip-build': { type: 'string' },
  },
});
const tmp = mkdtempSync(join(tmpdir(), 'botons-connectors-'));
const home = join(tmp, 'botons');
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
for (const d of [home, process.env.HOME]) mkdirSync(d, { recursive: true });
const log = (...a: unknown[]) => console.log('[connectors]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[connectors] FAIL ${what}`);
  }
};

const KEY = 'key_private_docs_5t9';

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) return;
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else p?.resolve(msg.result);
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
  async eval<T = any>(expression: string, sessionId?: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
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

/** A fake MCP server on loopback: it answers only with the key, and echoes the key in one tool name. */
async function fakeMcp() {
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.headers['x-api-key'] !== KEY) {
        res.writeHead(401).end();
        return;
      }
      const msg = JSON.parse(raw || '{}');
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
          : { tools: [{ name: 'search_docs', inputSchema: {} }, { name: `whoami_${req.headers['x-api-key']}`, inputSchema: {} }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${port}/mcp`;
}

async function main() {
  const webDist = opt['skip-build'] ? resolve(opt['skip-build']) : join(tmp, 'web-dist');
  if (!opt['skip-build']) {
    log('building web …');
    await new Promise<void>((res, rej) => {
      const p = spawn(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', webDist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(root, 'web'), stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
    });
  }
  const mcpUrl = await fakeMcp();
  const port = await freePort();
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_LOG_LEVEL: 'warn',
    BOTONS_OAUTH_ALLOW: '127.0.0.1',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
    HOME: process.env.HOME!,
  });
  cfg.webDist = webDist;
  const app = createApp(cfg, undefined, { tailnet: null });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const { secret, code } = createPairingRequest(app.store.db, 'connectors check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'connectors check' }) })).json()).token;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  await call('PATCH', '/api/setup', { complete: true });
  await call('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'UTC' });
  // The CLI brains are registered without their CLIs: made in the store, as no turn runs here.
  const providers = new Set(app.providers.ids());
  const kevin = app.store.createBot({ name: 'Kevin', provider: 'claude-cli' }, providers, 'mock');
  const stuart = app.store.createBot({ name: 'Stuart', provider: 'codex-cli' }, providers, 'mock');
  const bob = app.store.createBot({ name: 'Bob', provider: 'mock' }, providers, 'mock');

  const chrome = spawn(
    opt.chrome!,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--window-size=1280,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
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
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: page } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, page);
  await browser.send('Runtime.enable', {}, page);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(base)}) localStorage.setItem('botons.deviceToken', ${JSON.stringify(token)});` }, page);
  const evalIn = <T = any>(expr: string) => browser.eval<T>(expr, page);
  const waitFor = async (expr: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`).catch(() => false)) return;
      await sleep(100);
    }
    const shown = await evalIn<string>('document.body.innerText.slice(-1200)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  let shots = 0;
  const shot = async (name: string) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
    writeFileSync(join(resolve(opt.out), `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
  };
  const click = async (expr: string) => {
    await waitFor(expr);
    const at = await evalIn<{ x: number; y: number }>(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, page);
  };
  const typeInto = async (expr: string, text: string) => {
    await click(expr);
    await evalIn(`(() => { const e = ${expr}; e.focus(); e.select?.(); })()`);
    await browser.send('Input.insertText', { text }, page);
  };
  const button = (scope: string, text: string | RegExp) =>
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => ${text instanceof RegExp ? `${text}.test(b.textContent.trim())` : `b.textContent.trim() === ${JSON.stringify(text)}`})`;
  const DIALOG = 'dialog[open]:has(.service-steps)';
  const field = (label: string) => `[...document.querySelectorAll('${DIALOG} label')].find((l) => l.querySelector('.field-label')?.textContent === ${JSON.stringify(label)})?.querySelector('input, textarea')`;
  const botonBox = (scope: string, name: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} .connector-access-list li`)})].find((l) => l.querySelector('.connector-name')?.textContent.startsWith(${JSON.stringify(name)}))?.querySelector('input')`;
  const text = (selector: string) => evalIn<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('.settings-nav [data-section="connectors"]')`);

  log('— connect a service, step by step');
  await click(button('section.connect-service', /Connect a service/));
  await waitFor(`document.querySelector('${DIALOG} .service-kinds')`);
  check((await text(`${DIALOG} .service-steps [aria-current="step"]`)) === '1. How it connects', 'step 1 of 3: how it connects');
  check(await evalIn(`${button(DIALOG, /^Sign in to it/)}?.disabled === true`), 'sign-in (OAuth) is unavailable without BOTONS_OAUTH_PUBLIC_URL, and says why');
  await shot('kinds');
  await click(button(DIALOG, /^A URL and an API key/));
  await waitFor(field('URL'));
  check(!(await evalIn(`!!document.querySelector('${DIALOG} .segmented-field')`)), 'step 2: the type it was given is not asked again');
  await typeInto(field('Name'), 'docs');
  await typeInto(field('URL'), mcpUrl);
  check(await evalIn(`document.querySelector('${DIALOG} .secret-input input')?.type === 'password'`), 'the key field is masked');
  await click(`document.querySelector('${DIALOG} details.set-more summary')`);
  await click(button(DIALOG, /Add a header/));
  await typeInto(`document.querySelector('${DIALOG} .header-row input[aria-label="Header name"]')`, 'X-Api-Key');
  await typeInto(`document.querySelector('${DIALOG} .header-row input[aria-label="Header value"]')`, KEY);
  check(await evalIn(`document.querySelector('${DIALOG} .header-row input[aria-label="Header value"]').type === 'password'`), 'a header value is masked too');
  await shot('details');
  await click(button(DIALOG, 'Save and test'));
  await waitFor(`document.querySelector('${DIALOG} .service-check .connector-access')`);
  check((await text(`${DIALOG} .service-steps [aria-current="step"]`)) === '3. Test it and choose Botons', 'step 3: test it and choose Botons');

  log('— test it (it runs on its own after the save)');
  await waitFor(`/Reached/.test(document.querySelector('${DIALOG} .connector-test')?.innerText ?? '')`);
  await evalIn(`document.querySelector('${DIALOG} .connector-test details')?.setAttribute('open', '')`);
  const tested = await text(`${DIALOG} .connector-test`);
  check(/2 tools/.test(tested) && tested.includes('search_docs'), `the test reached the fake server and lists its tools: ${tested.replace(/\n/g, ' | ')}`);
  check(!(await evalIn<string>('document.body.innerText')).includes(KEY), 'the key never shows, even echoed back in a tool name');

  log('— exactly which Botons');
  const status = await text(`${DIALOG} .connector-access > p.hint`);
  check(/No Boton has it yet/.test(status) && /none can ask for it/.test(status), `none has it, none may ask: ${status}`);
  check(await evalIn(`${botonBox(DIALOG, 'Bob')}?.disabled === true`), "Bob's brain can't use connectors: not offered");
  check(/its brain can't use connectors/.test(await evalIn<string>(`${botonBox(DIALOG, 'Bob')}?.closest('li').innerText`)), 'and says why');
  await click(botonBox(DIALOG, 'Kevin'));
  await waitFor(`/gives docs to Kevin/.test(document.querySelector('${DIALOG} .connector-access')?.innerText ?? '')`);
  check(/gets it when you save/.test(await evalIn<string>(`${botonBox(DIALOG, 'Kevin')}?.closest('li').innerText`)), 'Kevin is marked as getting it when saved');
  await shot('choose');
  await click(button(DIALOG, 'Save who has it'));
  await waitFor(`/1 Boton has it: Kevin/.test(document.querySelector('${DIALOG} .connector-access > p.hint')?.innerText ?? '')`);
  check(JSON.stringify(app.store.getBot(kevin.id).connections) === '["lib:docs"]', 'Kevin has it on the server');
  const resolved = await app.connectors.resolve(app.store.getBot(kevin.id).connections, app.providers.get('claude-cli'));
  check(resolved.servers.length === 1 && resolved.servers[0].name === 'docs', "Kevin's next turn would be given docs");
  check(app.store.getBot(stuart.id).connections.length === 0 && app.store.getBot(bob.id).connections.length === 0, 'and no one else');
  await click(`document.querySelector('${DIALOG} .connector-history summary')`);
  const history = await text(`${DIALOG} .connector-history`);
  check(/changed a Boton's connectors[^\n]*: Kevin/.test(history) && /connectionsAdded: lib:docs/.test(history) && /added an MCP server: docs/.test(history) && /tested a connector/.test(history), `its history: ${history.replace(/\n/g, ' | ')}`);

  log('— a change made meanwhile is not saved over');
  await call('PUT', '/api/connectors/lib:docs/access', { botIds: [kevin.id, stuart.id], expected: [kevin.id] });
  await click(botonBox(DIALOG, 'Kevin'));
  await click(button(DIALOG, 'Save who has it'));
  await waitFor(`/changed since you looked/.test(document.querySelector('${DIALOG} .connector-access [role=alert]')?.innerText ?? '')`);
  check(app.store.getBot(kevin.id).connections.includes('lib:docs'), 'the stale save changed nothing');
  await shot('stale');
  await click(button(DIALOG, 'Review again'));
  await waitFor(`/2 Botons have it: Kevin, Stuart/.test(document.querySelector('${DIALOG} .connector-access > p.hint')?.innerText ?? '')`);
  check(true, 'Review again shows who has it now');
  await click(button(DIALOG, 'Done'));
  await waitFor(`!document.querySelector('${DIALOG}')`);

  log('— the same Botons on the connector in its list, and taking it off all of them');
  const item = `[...document.querySelectorAll('.mcp-library .mcp-item')].find((l) => l.querySelector('.connector-name')?.textContent === 'docs')`;
  await click(`${item}.querySelector('.connector-botons summary')`);
  await waitFor(`/2 Botons have it/.test(${item}?.innerText ?? '')`);
  const SCOPE = '.mcp-library .connector-botons[open]';
  await click(botonBox(SCOPE, 'Kevin'));
  await click(botonBox(SCOPE, 'Stuart'));
  await click(button(SCOPE, 'Save who has it'));
  await waitFor(`/No Boton has it yet/.test(${item}?.innerText ?? '')`);
  const after = (await call('GET', '/api/connectors/lib:docs/access')) as ConnectorAccess;
  check(after.botons.every((m) => !m.has) && app.store.listBots().every((b) => !b.connections.includes('lib:docs')), 'taken off every Boton');
  check(!(await evalIn<string>('document.body.innerText')).includes(KEY), 'the key never shows anywhere in Settings');
  await shot('list');

  log('— turning it off keeps who has it, refuses a stale view, and on again gives back exactly that');
  await call('PUT', '/api/connectors/lib:docs/access', { botIds: [kevin.id], expected: [] });
  const POWER = 'dialog[open]:has(.confirm-body)';
  await click(`${item}.querySelector('button[aria-label="Turn off docs"]')`);
  await waitFor(`/Kevin keeps it, but its turns go without it/.test(document.querySelector('${POWER}')?.innerText ?? '')`);
  const offText = await text(POWER);
  check(/Nothing is deleted/.test(offText) && /requests waiting on a card can't be allowed/.test(offText), `the dialog says what is kept and what stops: ${offText.replace(/\n/g, ' | ')}`);
  await typeInto(`document.querySelector('${POWER} input[type=text]')`, 'Rotating its key');
  await shot('turn-off');
  // Stuart got it meanwhile: what the dialog shows is stale, so nothing is turned off.
  await call('PUT', '/api/connectors/lib:docs/access', { botIds: [kevin.id, stuart.id], expected: [kevin.id] });
  await click(button(POWER, 'Turn it off'));
  await waitFor(`/changed since you looked/.test(document.querySelector('${POWER} [role=alert]')?.innerText ?? '')`);
  check(!app.connectors.isOff('lib:docs'), 'the stale turn-off changed nothing');
  await click(button(POWER, 'Review again'));
  await waitFor(`/Kevin and Stuart keep it, but their turns go without it/.test(document.querySelector('${POWER}')?.innerText ?? '')`);
  check(true, 'Review again names exactly who has it now');
  // Then a turn of Kevin's starts with it while the dialog is open (stood in for here: these Botons have no CLI; the
  // server tests run a real one). The dialog didn't show that turn, so turning it off is refused, not closed silently.
  const turnsWith = app.engine.turnsWith;
  app.engine.turnsWith = (id) => (id === 'lib:docs' ? [{ botId: kevin.id, turnId: 'turn_check_running' }] : turnsWith(id));
  try {
    await click(button(POWER, 'Turn it off'));
    await waitFor(`/changed since you looked/.test(document.querySelector('${POWER} [role=alert]')?.innerText ?? '')`);
    check(!app.connectors.isOff('lib:docs') && app.store.getBot(kevin.id).connections.includes('lib:docs'), 'a turn started since the owner looked: nothing changed');
    await click(button(POWER, 'Review again'));
    await waitFor(`/Kevin has a turn running with it now/.test(document.querySelector('${POWER}')?.innerText ?? '')`);
    check(/it keeps docs until it ends/.test(await text(POWER)), 'Review again names the running turn and what it keeps');
    await shot('turn-off-running');
    await click(button(POWER, 'Turn it off'));
    await waitFor(`!document.querySelector('${POWER}')`);
  } finally {
    app.engine.turnsWith = turnsWith;
  }
  await waitFor(`/Off since.*Rotating its key/.test(${item}?.innerText ?? '')`);
  check(app.connectors.isOff('lib:docs'), 'off on the server');
  check(app.store.getBot(kevin.id).connections.includes('lib:docs') && app.store.getBot(stuart.id).connections.includes('lib:docs'), 'grants kept');
  const offTurn = await app.connectors.resolve(app.store.getBot(kevin.id).connections, app.providers.get('claude-cli'));
  check(offTurn.servers.length === 0 && offTurn.skipped[0]?.id === 'lib:docs', "Kevin's next turn goes without it");
  await waitFor(`/Turned off: the Botons checked here keep it/.test(${item}?.innerText ?? '')`);
  check(true, 'its Botons list says the grants are kept but unused');
  await shot('off');
  await click(`${item}.querySelector('button[aria-label="Turn on docs"]')`);
  await waitFor(`/Kevin and Stuart get it back/.test(document.querySelector('${POWER}')?.innerText ?? '')`);
  check(/no one else/.test(await text(POWER)), 'turning on names exactly who gets it back, no one else');
  await shot('turn-on');
  await click(button(POWER, 'Turn it on'));
  await waitFor(`/On: Botons that have it/.test(${item}?.innerText ?? '')`);
  check(!app.connectors.isOff('lib:docs') && app.store.listBots().filter((b) => b.connections.includes('lib:docs')).length === 2, 'on again with the same two Botons');
  const events = (await call('GET', '/api/audit')) as { action: string }[];
  check(events.filter((e) => e.action === 'connector.disabled').length === 1 && events.filter((e) => e.action === 'connector.enabled').length === 1, 'audited once each way');
  check(!(await evalIn<string>('document.body.innerText')).includes(KEY), 'the key never shows');
  await shot('on');
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error('[connectors]', err);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[connectors] ${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else if (!code) log('all passed');
process.exit(code);
