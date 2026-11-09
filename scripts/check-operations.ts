// `npm run check:operations`: Settings → Health and backups, Runs to check and Server events in the real web app in
// headless Chrome, driven as the owner would, against a throwaway server (temp HOME and BOTONS_HOME, 127.0.0.1, free
// ports, the mock provider, no Tailscale, no real CLI, a fake ntfy server on loopback). It checks that the owner can
// see what failed, read the evidence and act on it without a shell:
// - a fresh install: every dependency named and working, no backup yet flagged, the running version and schema;
// - push: a refused ntfy token shows as a failed push with where to look, in Health and in Server events; fixing the
//   token in Push notifications and sending a test from Health turns it green, and neither the topic, the token nor
//   the ntfy server's address reaches the status, the summary or the events;
// - low disk space, from a rewritten /api/operations response (the screen is labelled as a mock);
// - a failed routine run and a held one in Runs to check: Retry and Cancel from the app, owner only;
// - Server events: level, Boton and text filters, a next step, an error while the server is down, the restart notice;
// - Health while the server is down: the last status stays, with the error, its age and Retry, and recovers;
// - the status summary leaves out every private string the install holds;
// - backups made by the real backup code: which this release restores, and rehearsals that pass (current and older
//   schema), fail in fixed words (a cut-short archive, an older schema), refuse a second at once (through the API)
//   and one past the hourly limit (in the app), and land in the audit log;
// - a failed run's error event in Server events points to Runs to check for recovery.
// A rehearsal reads the archive through; it does not extract it onto a fresh host. Exits 1 with what failed.
// `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Bot, OperationsStatus, Routine } from '../shared/types.ts';
import { VERSION } from '../server/src/api.ts';
import { createApp } from '../server/src/app.ts';
import { approvePairingRequest, createPairingRequest } from '../server/src/auth.ts';
import { backup, stamp } from '../server/src/backup.ts';
import { loadConfig } from '../server/src/config.ts';
import { SCHEMA_VERSION } from '../server/src/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'google-chrome' },
    out: { type: 'string' },
    'skip-build': { type: 'string' },
  },
});
const tmp = mkdtempSync(join(tmpdir(), 'botons-operations-'));
const home = join(tmp, 'botons');
// Nothing the server or a provider check runs may find the real home folder or CLI logins.
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
for (const d of [home, process.env.HOME]) mkdirSync(d, { recursive: true });
process.env.BOTONS_LOG_LEVEL = 'info';
const log = (...a: unknown[]) => console.log('[operations]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[operations] FAIL ${what}`);
  }
};

/** Strings this install holds that no status, summary or event may show. */
const PRIVATE = {
  topic: 'sam-private-topic-q7x',
  badToken: 'tk_wrong_private_9k2',
  goodToken: 'tk_good_private_4m8',
  runError: 'secret-error-text at /home/you/private-notes',
  host: 'myhost',
};

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners: ((msg: any) => void)[] = [];
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) {
        for (const l of this.#listeners) l(msg);
        return;
      }
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
  on(fn: (msg: any) => void) {
    this.#listeners.push(fn);
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

/** A fake ntfy server on loopback: it takes only the good token, and records what it was sent. */
async function fakeNtfy() {
  const got: { auth: string | undefined; body: any }[] = [];
  const server = createHttpServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      got.push({ auth: req.headers.authorization, body });
      const ok = req.headers.authorization === `Bearer ${PRIVATE.goodToken}`;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { id: 'm1', event: 'message' } : { code: 40101, http: 401, error: `unauthorized for ${PRIVATE.topic}` }));
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${port}`, port, got };
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

  const port = await freePort();
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_LOG_LEVEL: 'info',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
    HOME: process.env.HOME!,
  });
  cfg.webDist = webDist;
  cfg.hostname = PRIVATE.host;
  let app = createApp(cfg, undefined, { tailnet: null });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const ntfy = await fakeNtfy();

  const { secret, code } = createPairingRequest(app.store.db, 'operations check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'operations check' }) })).json()).token;
  const call = async (method: string, path: string, body?: unknown, as: string = token) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data, text };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text}`);
    return r.data;
  };
  await ok('PATCH', '/api/setup', { complete: true });
  await ok('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'UTC' });
  const kevin: Bot = await ok('POST', '/api/bots', { name: 'Kevin', provider: 'mock' });
  const stuart: Bot = await ok('POST', '/api/bots', { name: 'Stuart', provider: 'mock' });
  writeFileSync(join(kevin.workspace, 'notes.md'), '# Notes\n');

  // Chrome, in its own profile.
  const chrome = spawn(opt.chrome!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(base)}) localStorage.setItem('botons.deviceToken', ${JSON.stringify(token)});` }, page);
  const evalIn = <T = any>(expr: string) => browser.eval<T>(expr, page);
  const waitFor = async (expr: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`).catch(() => false)) return;
      await sleep(100);
    }
    const shown = await evalIn<string>('location.href + "\\n" + document.body.innerText.slice(0, 800)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  let shots = 0;
  /** A screenshot of the viewport, with `selector` scrolled to the top of it. */
  const shot = async (name: string, selector?: string) => {
    if (selector) {
      const wide = await evalIn<boolean>(`[...document.querySelectorAll(${JSON.stringify(`${selector}, ${selector} *`)})].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible' && e.clientWidth > 0)`);
      check(!wide, `${name}: nothing in ${selector} is wider than its box`);
    }
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    if (selector) await evalIn(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
    writeFileSync(join(resolve(opt.out), `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
  };

  // Real input: scroll the element into view and click its middle with the mouse; type with the keyboard.
  const click = async (expr: string) => {
    await waitFor(expr);
    const at = await evalIn<{ x: number; y: number }>(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, page);
    }
  };
  const typeInto = async (expr: string, text: string) => {
    await click(expr);
    await evalIn(`(() => { const e = ${expr}; e.focus(); e.select?.(); })()`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, page);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, page);
    await browser.send('Input.insertText', { text }, page);
  };
  const choose = (expr: string, value: string) =>
    evalIn(`(() => { const s = ${expr}; s.focus(); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const button = (scope: string, text: string | RegExp) =>
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => ${text instanceof RegExp ? `${text}.test(b.textContent.trim())` : `b.textContent.trim() === ${JSON.stringify(text)}`})`;
  const textOf = (selector: string) => evalIn<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  const checkLine = (label: string) => `[...document.querySelectorAll('.operations-checks li')].find((l) => l.querySelector('strong')?.textContent === ${JSON.stringify(label)})`;
  const lineText = (label: string) => evalIn<string>(`${checkLine(label)}?.innerText ?? ''`);
  const lineOk = (label: string) => evalIn<boolean>(`!!${checkLine(label)}?.querySelector('.status-dot.succeeded')`);
  const OPS = 'section.operations';
  const LOG = 'section.server-log';
  const RUNS = 'section.runs-to-check';
  const goTo = (section: string) => click(`document.querySelector('.settings-nav [data-section="${section}"]')`);
  const openSettings = async () => {
    await click(`document.querySelector('button[aria-label="Settings"]')`);
    await goTo('health');
    await waitFor(`document.querySelector('${OPS} .operations-checks')`);
  };
  const closeSettings = async () => {
    await click(`document.querySelector('dialog[open] button[aria-label="Close"], [role=dialog] button[aria-label="Close"]')`);
    await waitFor(`!document.querySelector('${OPS}')`);
  };
  const reopenSettings = async () => {
    await closeSettings();
    await openSettings();
  };
  const summaryText = () => evalIn<string>(`[...document.querySelectorAll('${OPS} details')].find((d) => d.querySelector('summary')?.textContent.startsWith('Status summary')).querySelector('pre').textContent`);
  const leaks = (text: string, what: string, extra: string[] = [], allow: string[] = []) => {
    const found = [PRIVATE.topic, PRIVATE.badToken, PRIVATE.goodToken, PRIVATE.runError, '/home/you', `:${ntfy.port}`, tmp, ...extra].filter((s) => !allow.includes(s) && text.includes(s));
    check(!found.length, `${what} holds none of the install's private strings${found.length ? ` (found ${found.join(', ')})` : ''}`);
  };

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('button[aria-label="Settings"]')`);

  // 1. A fresh install: healthy, no backup yet.
  log('— a fresh install');
  await openSettings();
  const versionLine = await evalIn<string>(`document.querySelector('${OPS} > p.hint')?.innerText ?? ''`);
  check(versionLine.includes(`Botons ${VERSION}`) && versionLine.includes(`database schema ${SCHEMA_VERSION}`) && versionLine.includes(`schema ${SCHEMA_VERSION - 1} and ${SCHEMA_VERSION}`), `the running version, schema and the schemas its restore takes: "${versionLine}"`);
  check(await lineOk('Database'), `Database works: ${await lineText('Database')}`);
  check(await lineOk('Scheduler'), `Scheduler works: ${await lineText('Scheduler')}`);
  check((await lineOk('Brains')) && /1 ready/.test(await lineText('Brains')), `Brains: the mock brain ready, the missing CLIs not counted: ${await lineText('Brains')}`);
  await goTo('brains');
  await waitFor(`document.querySelector('.brain-settings [data-brain="codex-cli"]')`);
  const cliStatus = await evalIn<string>(`['claude-cli', 'codex-cli'].map((id) => document.querySelector('.brain-settings [data-brain="' + id + '"] .brain-status')?.innerText ?? '').join(' | ')`);
  check(cliStatus === 'Not installed | Not installed', `Settings → Brains says each missing CLI brain is not installed: ${cliStatus}`);
  await goTo('health');
  await waitFor(`document.querySelector('${OPS} .operations-checks')`);
  check(await lineOk('Accepting work'), `Accepting work: ${await lineText('Accepting work')}`);
  check((await lineOk('Push notifications')) && /not set up/.test(await lineText('Push notifications')), `Push not set up, and says what it is for: ${await lineText('Push notifications')}`);
  const disk = await lineText('Disk space');
  check(/free of/.test(disk), `Disk space reads this machine's disk: ${disk}`);
  check(!(await lineOk('Backups')) && /none yet/.test(await lineText('Backups')), `no backup yet needs attention: ${await lineText('Backups')}`);
  check(/None yet\./.test(await textOf(`${OPS} .operations-rehearsal`)) && !(await evalIn(`!!document.querySelector('${OPS} .operations-rehearse select')`)), 'no rehearsal yet, and nothing to rehearse');
  const howTo = await textOf(`${OPS}`);
  check(howTo.includes('How to back up and restore'), 'the backup and restore steps are one click away');
  await shot('fresh-install', OPS);

  // 2. Push: a refused token, then fixed in Settings.
  log('— push to a fake ntfy server that refuses the token');
  const PUSH = 'form.push-settings';
  await goTo('notifications');
  await click(`document.querySelector('${PUSH} input[type=checkbox]')`);
  await typeInto(`[...document.querySelectorAll('${PUSH} label')].find((l) => l.textContent.includes('ntfy server')).querySelector('input')`, ntfy.url);
  await typeInto(`[...document.querySelectorAll('${PUSH} label')].find((l) => l.textContent.includes('Topic')).querySelector('input')`, PRIVATE.topic);
  await typeInto(`document.querySelector('${PUSH} input[type=password]')`, PRIVATE.badToken);
  await click(button(PUSH, 'Save'));
  await waitFor(`document.querySelector('${PUSH}').innerText.includes('Saved.')`);
  await goTo('health');
  await click(button(OPS, 'Send a test push'));
  await waitFor(`/push failed/.test(${checkLine('Push notifications')}?.innerText ?? '')`);
  const pushFailed = await lineText('Push notifications');
  check(!(await lineOk('Push notifications')) && /refused it \(401 or 403\): check the access token/.test(pushFailed), `a refused push says where to look: ${pushFailed}`);
  check(/None has gone through since the push settings changed/.test(pushFailed), 'and that none has gone through since the settings changed');
  check(ntfy.got.length === 1 && ntfy.got[0].auth === `Bearer ${PRIVATE.badToken}` && ntfy.got[0].body?.topic === PRIVATE.topic, 'the fake ntfy server got the test, with the saved token and topic');
  leaks(await textOf(OPS), 'Health and backups after the failed push');
  await shot('push-refused', OPS);

  // The same failure in Server events, with the next step.
  await click(button(LOG, /^(Refresh|Loading…)$/));
  await waitFor(`document.querySelector('${LOG}').innerText.includes('push.failed')`);
  const pushEvent = await evalIn<string>(`[...document.querySelectorAll('${LOG} .server-log-line')].find((l) => l.innerText.includes('push.failed'))?.innerText ?? ''`);
  check(/Check Push notifications below and send a test\./.test(pushEvent), `Server events: push.failed with its next step: ${pushEvent.replace(/\n/g, ' | ')}`);
  leaks(pushEvent, 'the push.failed event');

  // Hold an older Health response while the owner replaces an already saved token.
  await evalIn(`(() => {
    const nativeFetch = window.fetch.bind(window);
    const hold = window.__operationsHold = { held: false, release: null, restore: () => { window.fetch = nativeFetch; } };
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === '/api/operations' && !hold.held) {
        hold.held = true;
        return new Promise((resolve) => { hold.release = () => resolve(response); });
      }
      return response;
    };
  })()`);
  await click(button(OPS, 'Send a test push'));
  await waitFor(`typeof window.__operationsHold?.release === 'function'`);
  // Fix the token where the owner set it, then test again from Health.
  log('— fix the token in Push notifications, test again from Health');
  await goTo('notifications');
  await typeInto(`document.querySelector('${PUSH} input[type=password]')`, PRIVATE.goodToken);
  await click(button(PUSH, 'Save'));
  await waitFor(`document.querySelector('${PUSH}').innerText.includes('Saved.')`);
  check((await evalIn<string>(`document.querySelector('${PUSH} input[type=password]').placeholder`)).startsWith('Saved.'), 'the saved token is never shown back, only that one is saved');
  await goTo('health');
  await waitFor(`/none sent since the push settings changed/.test(${checkLine('Push notifications')}?.innerText ?? '')`);
  check((await lineText('Push notifications')).includes('none sent since the push settings changed'), 'replacing a saved token refreshes Health before another push');
  await evalIn(`window.__operationsHold.release(); window.__operationsHold.restore()`);
  await sleep(150);
  check((await lineText('Push notifications')).includes('none sent since the push settings changed'), 'an older Health response cannot replace the refreshed push status');
  await click(button(OPS, 'Send a test push'));
  await waitFor(`/went through/.test(${checkLine('Push notifications')}?.innerText ?? '')`);
  const pushOkText = await lineText('Push notifications');
  check((await lineOk('Push notifications')) && /last test push went through/.test(pushOkText), `the next test went through and the check is green: ${pushOkText}`);
  check(/Sent\. Check your phone\./.test(pushOkText), 'Health says the test was sent');
  check(ntfy.got.at(-1)?.auth === `Bearer ${PRIVATE.goodToken}` && ntfy.got.at(-1)?.body?.title === 'Botons' && !String(ntfy.got.at(-1)?.body?.message).includes(PRIVATE.runError), 'the fake ntfy server got it with the new token, a generic text and no preview');
  leaks(await textOf(OPS), 'Health and backups after the fix');
  await shot('push-fixed', OPS);

  // 3. A failed run and a held one in Runs to check.
  log('— a failed routine run and a held one');
  const report: Routine = await ok('POST', `/api/bots/${kevin.id}/routines`, { name: 'Morning report', instruction: 'Write the morning report' });
  const sync: Routine = await ok('POST', `/api/bots/${stuart.id}/routines`, { name: 'Inbox sync', instruction: 'Sync the inbox' });
  (app.providers.get('mock') as unknown as { failNext(id: string, ...e: Error[]): void }).failNext(kevin.id, new Error(PRIVATE.runError));
  const failedRun = await ok('POST', `/api/routines/${report.id}/run`, {});
  const held = app.store.createRun(app.store.getRoutine(sync.id), 'schedule', null);
  app.store.holdRun(held.id, new Date(Date.now() + 3_600_000), 'connect ECONNREFUSED', 'retry');
  await waitFor(`document.querySelector('${RUNS}').innerText.includes('Morning report') && document.querySelector('${RUNS}').innerText.includes('Inbox sync')`, 20_000);
  const runsText = await textOf(RUNS);
  check(/Kevin · Morning report[\s\S]*manual run, failed/.test(runsText) && runsText.includes(PRIVATE.runError), 'Runs to check: the failed run, with its Boton, routine and error for the owner');
  check(/Stuart · Inbox sync[\s\S]*trying again/.test(runsText), 'Runs to check: the held run and when it tries again');
  await shot('runs-to-check', RUNS);
  // Owner only: a Boton's own token can neither retry nor cancel.
  const botonToken = app.auth.mintBotonToken(kevin.id).token;
  check((await call('POST', `/api/runs/${failedRun.id}/retry`, undefined, botonToken)).status === 403 && (await call('POST', `/api/runs/${held.id}/cancel`, undefined, botonToken)).status === 403, 'a Boton token cannot retry or cancel runs (403)');
  await click(button(RUNS, 'Retry this run'));
  await waitFor(`!document.querySelector('${RUNS}').innerText.includes(${JSON.stringify(PRIVATE.runError)})`, 20_000);
  await click(button(RUNS, 'Cancel this run'));
  await waitFor(`document.querySelector('${RUNS}').innerText.includes('Nothing to check.')`, 20_000);
  const runs = (await ok('GET', `/api/routines/${report.id}/runs`)) as { id: string; status: string; meta?: { retryOf?: { runId: string } } }[];
  check(runs.some((r) => r.meta?.retryOf?.runId === failedRun.id && r.status === 'succeeded'), 'the retry ran and succeeded');
  const cancelled = app.store.getRun(held.id);
  check(cancelled.status === 'failed' && !!cancelled.meta?.cancelled, `the held run is cancelled and will not run (${cancelled.status}, ${JSON.stringify(cancelled.meta?.cancelled)})`);

  // 4. Server events: filters and next steps.
  log('— Server events');
  await click(button(LOG, 'Refresh'));
  await waitFor(`document.querySelector('${LOG}').innerText.includes('turn.ended')`);
  const logSel = (label: string) => `[...document.querySelectorAll('${LOG} label')].find((l) => l.querySelector('.field-label')?.textContent === ${JSON.stringify(label)}).querySelector('select, input')`;
  const lines = () => evalIn<string[]>(`[...document.querySelectorAll('${LOG} .server-log-line')].map((l) => l.innerText)`);
  await choose(logSel('Show'), 'error');
  await sleep(800);
  const errorsOnly = await lines();
  check(errorsOnly.length > 0 && errorsOnly.every((l) => /^error/i.test(l)), `Show: Errors lists errors only (${errorsOnly.length})`);
  const runEvent = errorsOnly.find((l) => l.includes('turn.ended') && l.includes(kevin.id));
  check(runEvent && /\(Kevin\)/.test(runEvent) && runEvent.includes(failedRun.id) && runEvent.includes(report.id), `the failed run's turn.ended event names its Boton, routine and run: ${runEvent?.replace(/\n/g, ' | ')}`);
  check(!!runEvent?.includes('Runs to check') && !runEvent.includes('bug report'), 'failed run event points to Runs to check rather than a bug report');
  await choose(logSel('Show'), 'info');
  await choose(logSel('Boton'), stuart.id);
  await sleep(800);
  const stuartOnly = await lines();
  check(stuartOnly.every((l) => !l.includes(kevin.id)), `Boton: Stuart shows none of Kevin's events (${stuartOnly.length} shown)`);
  await choose(logSel('Boton'), '');
  await typeInto(logSel('Search'), 'push');
  await sleep(800);
  const pushOnly = await lines();
  check(pushOnly.length > 0 && pushOnly.every((l) => /push/i.test(l)), `Search "push" keeps only push events (${pushOnly.length})`);
  await typeInto(logSel('Search'), 'no-such-event-xyz');
  await waitFor(`document.querySelector('${LOG}').innerText.includes('No kept event matches these filters.')`);
  check(true, 'a search that matches nothing says so');
  await typeInto(logSel('Search'), '');
  await sleep(800);
  leaks(await textOf(LOG), 'Server events, everything');
  await shot('server-events', LOG);

  // 5. The status summary, with every private string the install holds by now.
  const summary = await summaryText();
  log(`summary:\n${summary}`);
  leaks(summary, 'the status summary', ['Kevin', 'Stuart', 'Sam', PRIVATE.host, 'Morning report', 'Inbox sync', ntfy.url]);
  check(summary.includes(`schema ${SCHEMA_VERSION}`) && /Push: on, last ok/.test(summary) && /Brain mock: ready/.test(summary) && /Backups: 0 kept, newest none \(stale\)/.test(summary), 'the summary says what works and what does not');

  // 6. Low disk space, from a rewritten response: the screen is a mock.
  log('— low disk space (MOCK: /api/operations rewritten in the browser)');
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: `${base}/api/operations`, requestStage: 'Response' }] }, page);
  const onPaused = async (msg: any) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== page) return;
    const { requestId } = msg.params;
    try {
      const body = await browser.send('Fetch.getResponseBody', { requestId }, page);
      const data = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body) as OperationsStatus;
      data.storage = { ...data.storage, unreadable: false, freeBytes: 400 * 1024 ** 2, totalBytes: 100 * 1024 ** 3, low: true };
      await browser.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }, page);
    } catch {
      await browser.send('Fetch.continueRequest', { requestId }, page).catch(() => {});
    }
  };
  let mocking = true;
  browser.on((m) => void (mocking && onPaused(m)));
  await reopenSettings();
  await evalIn(`(() => { const b = document.createElement('div'); b.id = 'mock-banner'; b.textContent = 'MOCK: /api/operations storage rewritten to 400 MB free of 100 GB by the check'; b.style.cssText = 'position:sticky;top:0;z-index:99;background:#b00020;color:#fff;font:600 14px system-ui;padding:6px 10px'; document.querySelector('${OPS}').prepend(b); })()`);
  const lowDisk = await lineText('Disk space');
  check(!(await lineOk('Disk space')) && /400 MB free of 100 GB/.test(lowDisk) && /That is low/.test(lowDisk) && /keeping fewer backups/.test(lowDisk), `(mock) low disk space needs attention and says what to do: ${lowDisk}`);
  check(/Disk: 400 MB free of 100 GB \(LOW\)/.test(await summaryText()), '(mock) the summary says the disk is low');
  await shot('MOCK-disk-low', OPS);
  mocking = false;
  await browser.send('Fetch.disable', {}, page);

  // 7. The server goes down: Health keeps the last status and says so; Server events too. Then a restart.
  log('— the server stops, then starts again');
  await reopenSettings();
  await app.close();
  await click(button(LOG, 'Refresh'));
  await waitFor(`document.querySelector('${LOG} .load-error')`);
  check(/Couldn't refresh the server events: [\s\S]*These events are from/.test(await textOf(`${LOG} .load-error`)), `Server events keeps its lines while the server is down: ${await textOf(`${LOG} .load-error`)}`);
  // Health refreshes every 30 seconds.
  await waitFor(`document.querySelector('${OPS} .load-error')`, 40_000);
  const stale = await textOf(`${OPS} .load-error`);
  check(/Couldn't refresh health and backups: [\s\S]*This is the status from/.test(stale) && (await evalIn(`!!document.querySelector('${OPS} .operations-checks')`)), `Health keeps the last status, its age and Retry: ${stale.replace(/\n/g, ' ')}`);
  check(!(await evalIn(`/refreshes every 30 seconds/.test(document.querySelector('${OPS}').innerText)`)), 'and stops saying it is up to date');
  await shot('server-down', OPS);
  app = createApp(cfg, undefined, { tailnet: null });
  await app.listen();
  await click(button(`${OPS} .load-error`, 'Retry'));
  await waitFor(`!document.querySelector('${OPS} .load-error')`);
  check(await evalIn(`/refreshes every 30 seconds/.test(document.querySelector('${OPS}').innerText)`), 'Retry after the restart: Health is current again');
  await click(button(`${LOG} .load-error`, 'Retry'));
  await waitFor(`/The server restarted/.test(document.querySelector('${LOG}').innerText)`);
  check(true, 'Server events say the server restarted, and that older events are in its full log');
  await shot('server-restarted', LOG);

  // 8. Backups, made by the real backup code, and rehearsals.
  log('— backups and restore rehearsals');
  const t = Date.now();
  const good = backup({ home, now: new Date(t - 60_000) });
  check(good.manifest.workspaces && good.manifest.schemaVersion === SCHEMA_VERSION, `a real backup of the temp install: database and workspaces, schema ${good.manifest.schemaVersion}`);
  // A copy whose workspaces archive is cut short.
  const cut = join(home, 'backups', stamp(new Date(t - 2 * 60_000)));
  cpSync(good.dir, cut, { recursive: true });
  truncateSync(join(cut, 'workspaces.tar.gz'), Math.floor(statSync(join(cut, 'workspaces.tar.gz')).size / 2));
  // Older schemas, as backups of an install a release or two back hold them.
  const schemaBackup = (version: number, minutes: number) => {
    const dir = join(home, 'backups', stamp(new Date(t - minutes * 60_000)));
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'botons.db'));
    db.exec(`${readFileSync(join(root, `server/test/fixtures/schema-${version}.sql`), 'utf8')}\npragma user_version = ${version};`);
    db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
    const counts: Record<string, number> = {};
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all()) counts[String(name)] = Number(db.prepare(`select count(*) as n from "${name}"`).get()!.n);
    db.close();
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date(t - minutes * 60_000).toISOString(), schemaVersion: version, counts, workspaces: false }));
    return dir;
  };
  const older = schemaBackup(SCHEMA_VERSION - 1, 3);
  const tooOld = schemaBackup(SCHEMA_VERSION - 2, 4);
  const cutSize = statSync(join(cut, 'workspaces.tar.gz')).size;
  const goodSize = statSync(join(good.dir, 'botons.db')).size;
  const names = [good.dir, cut, older, tooOld].map((d) => d.split('/').at(-1)!);
  await reopenSettings();
  check(await lineOk('Backups'), `Backups: the new backup turns the check green: ${await lineText('Backups')}`);
  await click(`[...document.querySelectorAll('${OPS} details > summary')].find((s) => /backups$/.test(s.textContent))`);
  const listed = await textOf(`${OPS} .operations-backups`);
  check(listed.includes(`${names[0]} database and workspaces (schema ${SCHEMA_VERSION}); this release restores it`), 'the backup list: the new one, this release restores it');
  check(listed.includes(`${names[2]} database (schema ${SCHEMA_VERSION - 1}); this release restores it and upgrades it to schema ${SCHEMA_VERSION} at the next start`), 'an older-schema backup: restored and upgraded at the next start');
  check(listed.includes(`${names[3]} database (schema ${SCHEMA_VERSION - 2}); older than this release restores`), 'a backup two schemas back: older than this release restores');
  await shot('backups', OPS);

  const REH = `${OPS} .operations-rehearsal`;
  const rehearse = async (name: string) => {
    await choose(`document.querySelector('${REH} select')`, name);
    await click(button(REH, 'Rehearse a restore'));
    let sawRunning = false;
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const s = await textOf(`${REH} p[role=status]`);
      if (s.startsWith('Rehearsing')) sawRunning = true;
      if (s.includes(name) && / (passed|failed) /.test(s)) return { text: s, sawRunning };
      await sleep(200);
    }
    throw new Error(`rehearsal of ${name} did not finish: ${await textOf(REH)}`);
  };
  let r = await rehearse(names[0]);
  check(new RegExp(`passed .*: its database \\(schema ${SCHEMA_VERSION}\\) passed SQLite's integrity check; its workspaces archive \\(\\d+ files in \\d+ folders, .+\\) read through`).test(r.text), `the newest backup passes: ${r.text}`);
  log(`(the running state was ${r.sawRunning ? '' : 'not '}seen in the page before it finished)`);
  await shot('rehearsal-passed', REH);
  r = await rehearse(names[1]);
  check(/failed .*: its workspaces archive is cut short or damaged, so a restore would stop part-way: rehearse an older backup\./.test(r.text), `a cut-short archive fails in fixed words: ${r.text}`);
  leaks(r.text, 'the failed rehearsal', [home]);
  await shot('rehearsal-damaged', REH);
  r = await rehearse(names[2]);
  check(new RegExp(`passed .*schema ${SCHEMA_VERSION - 1}.*upgraded to schema ${SCHEMA_VERSION} as the server's next start would; it holds the database only`).test(r.text), `an older-schema backup passes, upgraded: ${r.text}`);
  r = await rehearse(names[3]);
  check(/failed .*: it is older than this release restores/.test(r.text), `a backup two schemas back fails as older: ${r.text}`);
  const sum = await summaryText();
  check(/Restore rehearsal: FAILED \S+ \(older-schema/.test(sum) && !names.some((n) => sum.includes(n)), `the summary has the last rehearsal in fixed words, not the backup's name`);

  // One at a time, and at most the hourly limit.
  const first = await call('POST', '/api/backups/rehearse', { backup: names[0] });
  const second = await call('POST', '/api/backups/rehearse', { backup: names[0] });
  check(first.status === 202 && second.status === 409, `a second rehearsal while one runs is refused (${first.status}, ${second.status})`);
  const until = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 60_000;
    while (Date.now() < end && !(await fn())) await sleep(200);
  };
  await until(async () => (await ok('GET', '/api/operations')).rehearsal.last?.outcome !== 'running');
  await ok('POST', '/api/backups/rehearse', { backup: names[0] });
  await until(async () => (await ok('GET', '/api/operations')).rehearsal.last?.outcome !== 'running');
  await choose(`document.querySelector('${REH} select')`, names[0]);
  await click(button(REH, /^(Rehearse a restore|Rehearsing…)$/));
  await waitFor(`document.querySelector('${REH} [role=alert]')`);
  const limited = await textOf(`${REH} [role=alert]`);
  check(/Couldn't start a rehearsal: At most 6 restore rehearsals an hour; try again later/.test(limited), `the seventh in an hour is refused, in the app: ${limited}`);
  await shot('rehearsal-limit', REH);

  // The audit log, reloaded with Settings.
  await reopenSettings();
  await goTo('advanced');
  await waitFor(`!document.querySelector('section.audit-log').innerText.includes('Loading…')`);
  const audit = await textOf('section.audit-log');
  log(`audit log:\n${audit}`);
  const countOf = (re: RegExp) => (audit.match(re) ?? []).length;
  check(countOf(/rehearsed restoring a backup/g) === 6, `the audit log has each finished rehearsal (${countOf(/rehearsed restoring a backup/g)})`);
  check(countOf(/sent a test push/g) === 3 && /retried a failed routine run/.test(audit) && /cancelled a routine run/.test(audit), 'and the test pushes, the retry and the cancel');
  // The audit log names the ntfy server a settings change pointed at (the owner's own record), never its topic or token.
  leaks(audit, 'the audit log', [], [`:${ntfy.port}`]);
  await shot('audit-log', 'section.audit-log');

  // The rehearsals changed no backup, and left no copy behind.
  check(statSync(join(cut, 'workspaces.tar.gz')).size === cutSize && statSync(join(good.dir, 'botons.db')).size === goodSize, 'the rehearsed backups are unchanged');
  const work = join(home, 'run', 'rehearsal');
  check(!existsSync(work) || readdirSync(work).length === 0, 'no rehearsal copy is left in the data folder');
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[operations]', err);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[operations] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
