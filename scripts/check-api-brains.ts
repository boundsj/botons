// `npm run check:api-brains`: a boton on an API key, in the real web app in headless Chrome, driven as the owner
// would, against a throwaway server (temp HOME and BOTONS_HOME, 127.0.0.1, free ports, no Tailscale, no real CLI) whose
// model requests go to a fake Anthropic API on loopback, never to a provider. A fake key only. It checks that the owner
// can:
// - save a key and see that Botons can run on it, as "Claude (Anthropic API key)";
// - create a Boton on that brain (Workspace access, so its tools run in the OS sandbox) and chat with it: the reply
//   shows its tokens and estimated cost, and the routine it was asked for exists (made with the `botons` CLI);
// - set a daily spending cap and a cap a run in the Boton's settings, saved and audited;
// - see on the API keys page that the key's turns showed chat and tool use for the model.
// Exits 1 with what failed. `--out <dir>` saves screenshots. Needs bubblewrap for the Workspace sandbox.
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
import { sandboxProblem } from '../server/src/sandbox.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'google-chrome' },
    out: { type: 'string' },
    'skip-build': { type: 'string' },
  },
});
const tmp = mkdtempSync(join(tmpdir(), 'botons-api-brains-'));
const home = join(tmp, 'botons');
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
for (const d of [home, process.env.HOME]) mkdirSync(d, { recursive: true });
const log = (...a: unknown[]) => console.log('[api-brains]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[api-brains] FAIL ${what}`);
  }
};

// A fake key, in a shape no real key has (the dots).
const KEY = 'sk-ant-fake.bob.brain.0001';

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

const sse = (res: import('node:http').ServerResponse, data: Record<string, unknown>) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A fake Anthropic API on loopback: its model list, and Messages answers in the documented event stream. The first
 * answer asks for a `botons routine create` command; the next one reads its result and says so.
 */
async function fakeModel() {
  const seen: { key: string; body: any }[] = [];
  const server = createHttpServer(async (req, res) => {
    const key = String(req.headers['x-api-key'] ?? '');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (key !== KEY) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', lifecycle: 'active', capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } } }], has_more: false }));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ key, body });
    const n = seen.length;
    const results = (body.messages as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1200, output_tokens: 1 } } });
    if (!results.length) {
      const input = JSON.stringify({ command: 'botons routine create --name "Morning brief" --schedule "daily at 8:00" --instruction "Summarize the inbox"' });
      sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'shell', input: {} } });
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } });
      sse(res, { type: 'content_block_stop', index: 0 });
      sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 80 } });
    } else {
      const ok = /Exit code 0/.test(String(results.at(-1).content));
      sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ok ? 'I made the routine “Morning brief”: it runs daily at 8:00.' : `The command failed: ${results.at(-1).content}` } });
      sse(res, { type: 'content_block_stop', index: 0 });
      sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } });
    }
    sse(res, { type: 'message_stop' });
    res.end();
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
  const problem = sandboxProblem();
  if (problem) throw new Error(`the Workspace sandbox is needed: ${problem}`);
  const model = await fakeModel();
  const port = await freePort();
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_LOG_LEVEL: 'warn',
    BOTONS_PRIVATE_PATHS: '',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
    HOME: process.env.HOME!,
  });
  cfg.webDist = webDist;
  // Every model request goes to the fake API on loopback: nothing here reaches a provider.
  const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: {}, testEndpoints: { anthropic: model.origin, openai: model.origin } } });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const { secret, code } = createPairingRequest(app.store.db, 'api brains check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'api brains check' }) })).json()).token;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  await call('PATCH', '/api/setup', { complete: true });
  await call('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'UTC' });
  await call('POST', '/api/mcp-servers', { name: 'fixture-docs', transport: 'http', url: 'https://mcp.example.com/docs' });

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
  const setSelect = (expr: string, value: string) =>
    evalIn(`(() => { const e = ${expr}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const text = (selector: string) => evalIn<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  const button = (scope: string, label: string | RegExp) =>
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => ${label instanceof RegExp ? `${label}.test(b.textContent.trim())` : `b.textContent.trim() === ${JSON.stringify(label)}`})`;

  log('— save a key: Botons can run on it');
  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('.settings-nav [data-section="api-keys"]')`);
  const ITEM = `document.querySelector('.api-key-item[data-provider="anthropic"]')`;
  await waitFor(ITEM);
  await typeInto(`${ITEM}?.querySelector('input[type=password]')`, KEY);
  await click(button('.api-key-item[data-provider="anthropic"]', 'Save'));
  await waitFor(`/Saved key in use/.test(${ITEM}?.innerText ?? '')`);
  await click(button('.api-key-item[data-provider="anthropic"]', 'Test key'));
  await waitFor(`/The key works/.test(${ITEM}?.innerText ?? '')`);
  check(/Botons can run on this key: pick “Claude \(Anthropic API key\)”/.test(await text('.api-key-item[data-provider="anthropic"]')), 'the key page says Botons can run on it, and as which brain');
  check(/No turns on this key yet/.test(await text('.api-key-item[data-provider="anthropic"]')), 'no evidence before any turn: only the model list');
  await shot('key-saved');
  await evalIn(`document.querySelector('.dialog button[aria-label="Close"], button[aria-label="Close"]')?.click()`);

  log('— a new Boton on the key');
  await click(`document.querySelector('button[aria-label="New Boton"]')`);
  await waitFor(`document.querySelector('.brain-picker select')`);
  await typeInto(`document.querySelector('input[data-autofocus]')`, 'Bob');
  await setSelect(`document.querySelector('.brain-picker select')`, 'anthropic-api');
  await waitFor(`document.querySelector('.brain-picker select[aria-label="Model"]')?.value === 'claude-sonnet-5-5' || [...document.querySelectorAll('.brain-picker select[aria-label="Model"] option')].some((o) => o.value === 'claude-sonnet-5-5')`);
  await setSelect(`document.querySelector('.brain-picker select[aria-label="Model"]')`, 'claude-sonnet-5-5');
  await shot('new-boton');
  await click(button('form', /^Create Bob$/));
  await waitFor(`document.querySelector('textarea[aria-label="Message Bob"]')`);
  const bot = ((await call('GET', '/api/bots')) as any[]).find((b) => b.name === 'Bob');
  check(bot?.provider === 'anthropic-api' && bot?.model === 'claude-sonnet-5-5' && bot?.access === 'workspace', `Bob runs on the Anthropic key, Workspace access: ${JSON.stringify([bot?.provider, bot?.model, bot?.access])}`);

  log('— ask it for a routine in the chat');
  await typeInto(`document.querySelector('textarea[aria-label="Message Bob"]')`, 'Make me a routine that summarizes my inbox every morning at 8');
  await click(`document.querySelector('button[aria-label="Send"]')`);
  await waitFor(`/I made the routine “Morning brief”/.test(document.body.innerText)`, 30_000);
  const routines = (await call('GET', `/api/bots/${bot.id}/routines`)) as any[];
  check(routines.length === 1 && routines[0].name === 'Morning brief', `the routine exists: ${JSON.stringify(routines.map((r) => r.name))}`);
  check(model.seen.length === 2 && model.seen.every((r) => r.key === KEY && !JSON.stringify(r.body).includes(KEY)), 'two requests, the key only in their header');
  const meta = await evalIn<string>(`[...document.querySelectorAll('.msg.bot .bubble')].at(-1)?.title ?? ''`);
  check(/2\.4k in · 120 out · est\. \$0\.0060/.test(meta), `the reply carries its tokens and estimated cost: ${meta}`);
  await shot('chat');

  log('— spending caps in its settings');
  await click(`document.querySelector('button[aria-label="Boton settings"]')`);
  await waitFor(`document.querySelector('.boton-settings input[name="spending-daily"]')`);
  const rowOf = (label: string) => `[...document.querySelectorAll('.boton-settings .set-row')].find((r) => r.querySelector('.set-label')?.textContent === ${JSON.stringify(label)})`;
  await waitFor(rowOf('fixture-docs'));
  await evalIn(`${rowOf('fixture-docs')}.scrollIntoView({block: 'center'})`);
  check(await evalIn<boolean>(`!!${rowOf('fixture-docs')}?.querySelector('[role=switch]')`), 'the API brain shows its compatible connector choices, each with a switch');
  check(!(await text('.boton-settings')).includes('botons_browser'), 'no internal connector name is shown');
  check(await evalIn<boolean>(`${rowOf('Web browsing')}?.querySelector('[role=switch]')?.disabled === true`), 'the API brain is not offered the CLI-only managed browser');
  await shot('api-connectors');
  check(/Today: about \$/.test(await text('.boton-settings .spending')), 'it shows today’s estimate');
  // Each cap saves when the owner leaves its field.
  await typeInto(`document.querySelector('input[name="spending-daily"]')`, '2.50');
  await evalIn(`document.querySelector('input[name="spending-daily"]').blur()`);
  await click(`[...document.querySelectorAll('.boton-settings .spending summary')].find((s) => s.textContent === 'Caps per routine run')`);
  await typeInto(`document.querySelector('input[name="spending-routine-${routines[0].id}"]')`, '0.25');
  await evalIn(`document.querySelector('input[name="spending-routine-${routines[0].id}"]').blur()`);
  const end = Date.now() + 10_000;
  let caps = await call('GET', `/api/bots/${bot.id}/spending`);
  while (!(caps.dailyCapUsd === 2.5 && caps.routines[0].perRunCapUsd === 0.25) && Date.now() < end) {
    await sleep(100);
    caps = await call('GET', `/api/bots/${bot.id}/spending`);
  }
  check(caps.dailyCapUsd === 2.5 && caps.routines[0].perRunCapUsd === 0.25, `saved: ${JSON.stringify([caps.dailyCapUsd, caps.routines[0].perRunCapUsd])}`);
  await waitFor(`/Cap saved/.test(document.querySelector('.toasts')?.innerText ?? '')`);
  check(/not the provider’s bill|not your provider’s bill/.test(await text('.boton-settings .spending')), 'it says caps count Botons’ estimate, not the bill');
  const audit = (await call('GET', '/api/audit')) as { action: string }[];
  check(audit.some((e) => e.action === 'boton.spending_changed'), 'the change is in the audit log');
  await shot('spending');

  log('— the key’s evidence from its turns');
  await click(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('.settings-nav [data-section="api-keys"]')`);
  await waitFor(`/Seen working in this key's own turns/.test(${ITEM}?.innerText ?? '')`);
  const seen = await text('.api-key-item[data-provider="anthropic"] .api-key-observed');
  check(/claude-sonnet-5-5: chat .*tool use/.test(seen.replace(/\n/g, ' ')), `chat and tool use seen for the model: ${seen.replace(/\n/g, ' | ')}`);
  const page2 = await evalIn<string>(`document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
  check(!page2.includes(KEY), 'the key is nowhere in the page or its storage');
  await shot('evidence');
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error('[api-brains]', err);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[api-brains] ${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else if (!code) log('all passed');
process.exit(code);
