// `npm run check:firstrun`: a fresh install's first run in the real web app in headless Chrome, as its owner meets it:
// the claim screen and its code, approved on the host; setup (owner, access mode, a ready brain, the first Boton); the
// Boton's chat, with a message and the mock brain's reply. On every screen, the page's text, title and labels say Botons,
// never the earlier name. Nothing here reaches a service.
//   npm run check:firstrun [-- --skip-build web/dist]      its own throwaway server (temp BOTONS_HOME, 127.0.0.1, a free
//                                                          port, no Tailscale, no real CLI, the mock brain)
//   npm run check:firstrun -- --url http://127.0.0.1:17777 --approve 'docker compose exec -T botons botons pair --approve {code}'
//                                                          a fresh server already running (scripts/docker-smoke.sh runs
//                                                          it against its throwaway container, with the mock brain on)
// Exits 1 with what failed. `--out <dir>` saves screenshots. Only Node builtins with --url, so it runs without
// node_modules beside a container.
import { OLD_TEXT } from '../shared/legacy-names.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    'public-forwarded': { type: 'boolean', default: false },
    migration: { type: 'boolean', default: false },
    chrome: { type: 'string', default: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'google-chrome' },
    out: { type: 'string' },
    'skip-build': { type: 'string' },
    url: { type: 'string' },
    approve: { type: 'string' },
  },
});
if (opt.url && !opt.approve?.includes('{code}')) {
  console.error('--url needs --approve "<command with {code}>", the command that approves a pairing code on that server');
  process.exit(2);
}
const tmp = mkdtempSync(join(tmpdir(), 'botons-firstrun-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[firstrun]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[firstrun] FAIL ${what}`);
  }
};

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
  async eval<T = any>(expression: string, sessionId: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
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

/** Its own server: returns its address and how to approve a code on it. */
async function ownServer(): Promise<{ base: string; approve: (code: string) => Promise<void> }> {
  const webDist = opt['skip-build'] ? resolve(opt['skip-build']) : join(tmp, 'web-dist');
  if (!opt['skip-build']) {
    log('building web …');
    await new Promise<void>((res, rej) => {
      const p = spawn(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', webDist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(root, 'web'), stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
    });
  }
  const { createApp } = await import('../server/src/app.ts');
  const { approvePairingRequest } = await import('../server/src/auth.ts');
  const { loadConfig } = await import('../server/src/config.ts');
  const port = await freePort();
  Object.assign(process.env, { HOME: tmp, BOTONS_HOME: join(tmp, 'home'), CODEX_HOME: join(tmp, 'personal-codex'), CLAUDE_CONFIG_DIR: join(tmp, 'personal-claude') });
  if (opt.migration) {
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    writeFileSync(join(process.env.CODEX_HOME!, 'auth.json'), '{}');
  }
  const fakeCodex = join(tmp, 'fake-codex');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--device-auth')) {
  console.log('private-output-must-stay-private');
  console.log('https://auth.openai.com/codex/device');
  console.log('ABCD-EFGHJ');
  setInterval(() => {}, 1000);
} else if (process.argv.includes('--version')) console.log('codex-cli 1.0.0');
else if (${!!opt.migration}) console.log('Logged in using ChatGPT');
else { console.log('Not logged in'); process.exitCode = 1; }
`, { mode: 0o700 });
  const cfg = loadConfig({
    BOTONS_HOME: join(tmp, 'home'),
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_LOG_LEVEL: 'warn',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: fakeCodex,
    HOME: tmp,
  });
  cfg.hostname = 'botons'; // An existing host name is owner data, not product branding.
  cfg.webDist = webDist;
  const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: {} } });
  if (opt['public-forwarded']) {
    cfg.publicUrlOverride = cfg.publicUrl = 'https://botons.example.com';
    const { writeAccessMode } = await import('../server/src/setup.ts');
    writeAccessMode(app.store.db, 'local');
  }
  await app.listen();
  cleanups.push(() => app.close());
  return {
    base: `http://127.0.0.1:${port}`,
    approve: async (code) => {
      if (!approvePairingRequest(app.store.db, code)) throw new Error(`no pairing request with code ${code}`);
    },
  };
}

/** A running server's: the owner's approve command with the code in it. */
function theirServer(): { base: string; approve: (code: string) => Promise<void> } {
  return {
    base: opt.url!.replace(/\/$/, ''),
    approve: (code) => {
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error(`unexpected code ${JSON.stringify(code)}`);
      return new Promise<void>((res, rej) => {
        const p = spawn('sh', ['-c', opt.approve!.replaceAll('{code}', code)], { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`the approve command exited ${c}`))));
      });
    },
  };
}

async function main() {
  const server = opt.url ? theirServer() : await ownServer();
  const { base } = server;
  log(`server ${base}`);

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
  const evalIn = <T = any>(expr: string) => browser.eval<T>(expr, page);
  const waitFor = async (expr: string, ms = 30_000) => {
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
    // Aim once the target has stopped moving (two frames in the same place, up to a second): a click aimed while the
    // page is still laying out can land beside it.
    await evalIn(`new Promise((done) => { let last = '', same = 0, left = 60; const tick = () => { const r = (${expr})?.getBoundingClientRect(); const at = r ? r.x + ',' + r.y : ''; same = at === last ? same + 1 : 0; last = at; if (same >= 2 || --left <= 0) done(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`);
    const at = await evalIn<{ x: number; y: number }>(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, page);
  };
  const typeInto = async (expr: string, text: string) => {
    await click(expr);
    await evalIn(`(() => { const e = ${expr}; e.focus(); e.select?.(); })()`);
    await browser.send('Input.insertText', { text }, page);
  };
  const submit = `document.querySelector('.setup-card button[type=submit]:not([disabled])')`;
  const heading = () => evalIn<string>(`document.querySelector('.setup-card h1, .setup-card h2')?.innerText ?? ''`);
  /** What the owner reads on this screen: its text, title, and every label, title, placeholder and alt. */
  const earlierName = async (screen: string) => {
    const said = await evalIn<string[]>(`(() => {
      const copy = document.body.cloneNode(true);
      for (const e of copy.querySelectorAll('[data-server-hostname]')) e.textContent = '';
      const out = [document.title, copy.textContent];
      for (const e of document.querySelectorAll('*')) for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'aria-description']) { const v = e.getAttribute(a); if (v) out.push(v); }
      const old = new RegExp(${JSON.stringify(OLD_TEXT.source)}, 'i');
      return out.filter((t) => old.test(t)).map((t) => t.match(new RegExp('.{0,40}' + old.source + '.{0,40}', 'is'))[0].replace(/\\s+/g, ' '));
    })()`);
    check(said.length === 0, `${screen}: says Botons, never the earlier name${said.length ? ` (found: ${said.join(' | ')})` : ''}`);
  };

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('.big-code')?.textContent.trim()`);
  const code = await evalIn<string>(`document.querySelector('.big-code').textContent.trim()`);
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `the claim screen shows a code (${code})`);
  check((await evalIn<string>('document.title')) === 'Botons', 'the tab is named Botons');
  await shot('claim');
  await earlierName('claim screen');
  await server.approve(code);

  // Setup: owner, access mode, brains, the first Boton, done.
  await waitFor(`document.querySelector('.setup-card')`);
  check(/Welcome to Botons/.test(await heading()), 'setup opens with Welcome to Botons');
  await earlierName('setup: owner');
  await typeInto(`document.querySelector('.setup-card input')`, 'Sam');
  await click(submit);
  await waitFor(`document.querySelector('.access-picker')`);
  await earlierName('setup: access');
  if (opt['public-forwarded']) {
    check(await evalIn<boolean>(`document.querySelector('[role=radio][aria-checked=true]')?.textContent.includes('From anywhere')`), 'unavailable saved local falls back to available public recommendation');
    check(await evalIn<boolean>(`[...document.querySelectorAll('[role=radio]')].filter(b => !b.textContent.includes('From anywhere')).every(b => b.disabled)`), 'forwarded connection cannot choose a narrower mode');
    await shot('access-public-forwarded-desktop');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, page);
    await shot('access-public-forwarded-phone');
    check(await evalIn<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), 'forwarded access fits an emulated phone');
    return;
  }
  check(await evalIn<boolean>(`document.querySelector('.access-picker [role=radio]').textContent.includes('From anywhere') && document.querySelector('.access-picker [role=radio]').disabled`), 'public is primary and explains missing HTTPS');
  check(await evalIn<boolean>(`[...document.querySelectorAll('.access-picker details')].some(d => d.querySelector('summary').textContent === 'Details' && !d.open)`), 'long details start collapsed');
  const previousChoice = await evalIn<string>(`(() => {
    const options = [...document.querySelectorAll('.access-picker [role=radio]')].filter(b => !b.disabled && b.getClientRects().length);
    const selected = options.findIndex(b => b.getAttribute('aria-checked') === 'true');
    options[selected].focus();
    return options[(selected + options.length - 1) % options.length].textContent;
  })()`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp' }, page);
  check(await evalIn<boolean>(`document.activeElement.textContent === ${JSON.stringify(previousChoice)} && document.activeElement.getAttribute('aria-checked') === 'true'`), 'arrow keys select an enabled choice');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' }, page);
  await shot('access-desktop');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, page);
  await shot('access-phone');
  check(await evalIn<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), 'access choices fit an emulated phone');
  await browser.send('Emulation.clearDeviceMetricsOverride', {}, page);
  await click(`[...document.querySelectorAll('.access-picker [role=radio]')].find(b => b.textContent.includes('This computer only'))`);
  await click(submit);
  await waitFor(`/Brains/.test(document.querySelector('.setup-card')?.innerText ?? '') && ${submit}`);
  await earlierName('setup: brains');
  check((await evalIn<string>('document.body.innerText')).includes('You need just one brain'), 'setup explains that one brain is enough');
  await shot('brains-desktop');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, page);
  await shot('brains-phone');
  check(await evalIn<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), 'brain choices fit an emulated phone');
  await browser.send('Emulation.clearDeviceMetricsOverride', {}, page);
  await click(`[...document.querySelectorAll('.brains button')].find(b => b.textContent.includes('Use my Claude'))`);
  if (!opt.migration) check((await evalIn<string>('document.body.innerText')).includes('In a terminal on this server'), 'subscription fallback says where to run the command');
  await shot('brains-subscription');
  if (!opt.url) {
    if (opt.migration) {
      await waitFor(`document.querySelector('.brains')?.innerText.includes('✓ Signed in')`);
      await click(`[...document.querySelectorAll('.brains button')].find(b => b.textContent === 'Sign in separately')`);
    } else await click(`[...document.querySelectorAll('.brains button')].find(b => b.textContent === 'Sign in to ChatGPT')`);
    await waitFor(`document.querySelector('.brains a')?.href === 'https://auth.openai.com/codex/device' && document.querySelector('.brains')?.innerText.includes('ABCD-EFGHJ')`);
    check(!(await evalIn<string>('document.body.innerText')).includes('private-output-must-stay-private'), 'guided sign-in never displays raw CLI output');
    await shot('brains-device-code');
    await click(`[...document.querySelectorAll('.brains button')].find(b => b.textContent === 'Cancel sign-in')`);
    await waitFor(`!document.querySelector('.brains')?.innerText.includes('ABCD-EFGHJ')`);
    check(true, 'guided sign-in cancellation clears the code');
  }

  await click(`[...document.querySelectorAll('.brains button')].find(b => b.textContent.includes('Use an API key'))`);
  check(await evalIn<boolean>("!!document.querySelector('.brains input[type=password]')"), 'API key can be pasted in setup');
  check(await evalIn<boolean>("[...document.querySelectorAll('.brains button')].some(b => b.textContent === 'Test key')"), 'API key can be tested in setup');
  await shot('brains-api-key');
  // The fixture's mock brain is ready; select it on the first-boton step below.

  await click(submit);
  await waitFor(`document.querySelector('.setup-card input[placeholder="e.g. Juniper"]')`);
  check(/Your first Boton/.test(await heading()), 'the step is Your first Boton');
  await earlierName('setup: first Boton');
  await shot('first-boton');
  await evalIn(`(() => { const e = document.querySelector('.setup-card select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(e, 'mock'); e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await typeInto(`document.querySelector('.setup-card input[placeholder="e.g. Juniper"]')`, 'Kevin');
  await click(submit);
  await waitFor(`[...document.querySelectorAll('.setup-card button')].some((b) => b.textContent.trim() === 'Open Kevin')`);
  await waitFor(`document.querySelector('.setup-card')?.innerText.includes('A brain is ready') && !document.querySelector('.setup-card')?.innerText.includes('Checking')`);
  await earlierName('setup: ready');
  await click(`[...document.querySelectorAll('.setup-card button')].find((b) => b.textContent.trim() === 'Open Kevin')`);

  // The chat: a message and the brain's reply.
  await waitFor(`document.querySelector('textarea[aria-label="Message Kevin"]')`);
  await typeInto(`document.querySelector('textarea[aria-label="Message Kevin"]')`, 'hello from the first run');
  await click(`document.querySelector('button[aria-label="Send"]:not([disabled])')`);
  await waitFor(`document.body.innerText.includes('Echo: hello from the first run')`, 60_000);
  check(true, 'the first Boton answers in its chat');
  check(/Kevin · Botons|Botons/.test(await evalIn<string>('document.title')), 'the tab names Botons');
  await shot('chat');
  await earlierName('chat');
  // A status refresh can invalidate the saved mode after the owner adds a public link.
  await evalIn(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith('/api/setup')) {
        const status = await response.clone().json();
        status.accessMode = 'local';
        status.recommendedMode = 'public';
        status.modes = status.modes.map(m => ({ ...m, available: m.mode === 'public', reason: m.mode === 'public' ? null : 'Would disconnect this device.' }));
        return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
      }
      return response;
    };
  })()`);
  await click(`document.querySelector('button[aria-label="Settings"]')`);
  await click(`document.querySelector('.settings-nav [data-section="access"]')`);
  await waitFor(`document.querySelector('.access-settings .access-picker')`);
  await waitFor(`document.querySelector('.access-settings [role=radio][aria-checked=true]')?.textContent.includes('From anywhere') && !document.querySelector('.access-settings [role=radio][aria-checked=true]').disabled`);
  check(true, 'Settings reconciles an unavailable saved mode on refreshed status');
  await evalIn(`document.querySelector('.access-settings').scrollIntoView()`);
  check(await evalIn<boolean>(`document.querySelector('.access-settings [role=radio]').textContent.includes('From anywhere')`), 'Settings shares the primary public choice');
  await shot('access-settings-desktop');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, page);
  // A phone shows the open page alone: wait for the list beside it to go before clicking in the page.
  await waitFor(`!document.querySelector('.settings-nav')`);
  await sleep(200);
  await evalIn(`document.querySelector('.access-settings').scrollIntoView()`);
  await shot('access-settings-phone');
  check(await evalIn<boolean>('document.documentElement.scrollWidth <= window.innerWidth'), 'Settings access fits an emulated phone');
  await click(`[...document.querySelectorAll('.access-settings summary')].find(s => s.textContent === 'Details')`);
  check(await evalIn<boolean>(`[...document.querySelectorAll('.access-settings details')].find(d => d.querySelector('summary').textContent === 'Details').open`), 'Details reveals caveats and server steps');
  await browser.send('Emulation.clearDeviceMetricsOverride', {}, page);
  await click(`document.querySelector('dialog[open] button[aria-label="Close"], [role=dialog] button[aria-label="Close"]')`);
  await click(`document.querySelector('button[aria-label="New Boton"], [aria-label="New Boton"]')`).catch(() => check(false, 'the sidebar has New Boton'));
  await sleep(500);
  await earlierName('new Boton dialog');
}

let code = 0;
try {
  await main();
} catch (err) {
  failures.push((err as Error).message);
  console.error(`[firstrun] FAIL ${(err as Error).message}`);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else log('all good');
process.exit(code);
