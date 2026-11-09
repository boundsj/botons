// `npm run check:api-keys`: Settings → API keys in the real web app in headless Chrome, driven as the owner would,
// against a throwaway server (temp HOME and BOTONS_HOME, 127.0.0.1, free ports, no Tailscale, no real CLI) whose
// tests go to a fake model list on loopback, never to a provider. Fake keys only. It checks that the owner can:
// - see which key is in use: the environment's (ANTHROPIC_API_KEY here, fake) until one is saved;
// - save a key: the field clears, the key never shows in the page or its storage, and the state says it is saved;
// - test it: the fake list's models show with what the list says about them, unknown where it says nothing, and a
//   model whose id echoes the key is left out;
// - remove it after being told what is used from then on (the environment's key), and see that it is.
// Exits 1 with what failed. `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
const tmp = mkdtempSync(join(tmpdir(), 'botons-api-keys-'));
const home = join(tmp, 'botons');
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
for (const d of [home, process.env.HOME]) mkdirSync(d, { recursive: true });
const log = (...a: unknown[]) => console.log('[api-keys]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[api-keys] FAIL ${what}`);
  }
};

// Fake keys, in a shape no real key has (the dots).
const SAVED = 'sk-ant-fake.kevin.check.0001';
const ENV = 'sk-ant-fake.stuart.check.0001';

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

/** A fake Anthropic-shaped model list on loopback: it answers only the saved key, and echoes it in one model id. */
async function fakeModels() {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    const key = String(req.headers['x-api-key'] ?? '');
    seen.push(key);
    if (key !== SAVED && key !== ENV) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `bad key ${key}` } }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { type: 'model', id: 'claude-kevin-1', display_name: 'Claude Kevin 1', lifecycle: 'active', capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, high: { supported: true } } } },
          { type: 'model', id: 'claude-stuart-0', display_name: 'Claude Stuart 0', lifecycle: 'deprecated', capabilities: { image_input: { supported: false }, effort: { supported: false } } },
          { type: 'model', id: `echo-${key}` },
        ],
        has_more: false,
      }),
    );
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { origin: `http://127.0.0.1:${port}`, seen };
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
  const models = await fakeModels();
  const port = await freePort();
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_LOG_LEVEL: 'warn',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
    HOME: process.env.HOME!,
  });
  cfg.webDist = webDist;
  // The environment's key is fake, and tests go to the fake list: nothing here reaches a provider.
  const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: { ANTHROPIC_API_KEY: ENV }, testEndpoints: { anthropic: models.origin, openai: models.origin } } });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const { secret, code } = createPairingRequest(app.store.db, 'api keys check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'api keys check' }) })).json()).token;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  await call('PATCH', '/api/setup', { complete: true });
  await call('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'UTC' });

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
  const text = (selector: string) => evalIn<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  const ITEM = `document.querySelector('.api-key-item[data-provider="anthropic"]')`;
  const itemText = () => evalIn<string>(`${ITEM}?.innerText ?? ''`);
  const input = `${ITEM}?.querySelector('input[type=password]')`;
  const nowhere = async (what: string) => {
    const page = await evalIn<string>(`document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
    check(!page.includes(SAVED) && !page.includes(ENV), `${what}: no key in the page, its inputs' values or its storage`);
  };

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('.settings-nav [data-section="api-keys"]')`);
  await waitFor(`${ITEM}`);
  await evalIn(`${ITEM}.scrollIntoView({ block: 'start' })`);

  log('— the environment key, until one is saved');
  check(/Using ANTHROPIC_API_KEY from the server's environment/.test(await itemText()), 'says the key in use comes from the environment');
  check(/Botons can run on this key: pick “Claude \(Anthropic API key\)”/.test(await itemText()), 'says Botons can run on the key in use, and as which brain');
  check(/OpenAI: No key/.test(await text('section.api-keys')), 'OpenAI has no key');
  check(await evalIn(`[...document.querySelectorAll('.api-key-item[data-provider="openai"] button')].find((b) => b.textContent.trim() === 'Test key')?.disabled === true`), 'nothing to test without a key');
  await nowhere('at first');
  await shot('environment');

  log('— save a key');
  await typeInto(input, SAVED);
  check((await evalIn<string>(`${input}.type`)) === 'password', 'the field is masked');
  await click(button('.api-key-item[data-provider="anthropic"]', 'Save'));
  await waitFor(`/Saved key in use/.test(${ITEM}?.innerText ?? '')`);
  check((await evalIn<string>(`${input}.value`)) === '', 'the field clears once saved');
  check(/takes the place of ANTHROPIC_API_KEY/.test(await itemText()), 'says the saved key takes the place of the environment one');
  await nowhere('after saving');
  await shot('saved');

  log('— test it');
  await click(button('.api-key-item[data-provider="anthropic"]', 'Test key'));
  await waitFor(`/The key works/.test(${ITEM}?.innerText ?? '')`);
  await evalIn(`${ITEM}.querySelector('details.api-key-models')?.setAttribute('open', '')`);
  const tested = await itemText();
  check(/can list 2 models/.test(tested) && tested.includes('claude-kevin-1') && tested.includes('claude-stuart-0'), `lists the fake list's models: ${tested.replace(/\n/g, ' | ')}`);
  check(/1 left out/.test(tested), 'the model id echoing the key is left out, and counted');
  const kevinRow = await evalIn<string>(`[...${ITEM}.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('claude-kevin-1'))?.innerText ?? ''`);
  check(/yes/.test(kevinRow) && /unknown/.test(kevinRow) && /low, high/.test(kevinRow), `vision and effort from the list, tools unknown: ${kevinRow.replace(/\s+/g, ' ')}`);
  check(/deprecated/.test(tested), 'a deprecated model says so');
  check(models.seen.length === 1 && models.seen[0] === SAVED, 'the test sent the saved key, once, to the fake list only');
  await nowhere('after testing');
  await shot('tested');

  log('— remove it, told first what is used then');
  await click(button('.api-key-item[data-provider="anthropic"]', 'Remove the saved key'));
  await waitFor(`${ITEM}?.querySelector('.api-key-confirm')`);
  check(/From then on Botons uses ANTHROPIC_API_KEY from the server's environment/.test(await text('.api-key-item[data-provider="anthropic"] .api-key-confirm')), 'the confirmation names the fallback');
  await shot('confirm-remove');
  await click(button('.api-key-item[data-provider="anthropic"] .api-key-confirm', 'Remove'));
  await waitFor(`/Now using ANTHROPIC_API_KEY/.test(${ITEM}?.innerText ?? '')`);
  check(/Using ANTHROPIC_API_KEY from the server's environment/.test(await itemText()), 'the environment key is in use again');
  check(!/The key works/.test(await itemText()), "the saved key's test is not shown as the environment key's");
  const audit = (await call('GET', '/api/audit')) as { action: string }[];
  check(['api_key.saved', 'api_key.tested', 'api_key.removed'].every((a) => audit.some((e) => e.action === a)), 'saved, tested and removed are in the audit log');
  await nowhere('at the end');
  await shot('removed');
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error('[api-keys]', err);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[api-keys] ${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else if (!code) log('all passed');
process.exit(code);
