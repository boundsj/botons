// `npm run check:starters`: the starter templates in the real web app in headless Chrome, driven as the owner would,
// against a throwaway server (temp HOME and BOTONS_HOME, 127.0.0.1, free ports, no Tailscale, no real CLI, the mock
// brain). Nothing here reaches a service: the connector is a fake address that is never contacted. It checks that the
// owner can:
// - choose the Daily brief, read what it needs, be guided to Connect a service for its optional calendar, review
//   exactly what it grants, install it paused, run the setup check, test it on the mock brain, see an edit made after
//   the test take the pass away until it is tested again, and turn it on;
// - install Research on request, see a failing test run (the mock fails on request) keep it from being turned on
//   (their own Resume included), never see its webhook key, come back to its setup from the Routines panel and turn it
//   on with an override the audit log records;
// - be told a Repository monitor needs a code host connector, pick one after adding it, and have a stale review
//   (the connector turned off meanwhile) refused, with the new review saying why, and no Boton made.
// Exits 1 with what failed. `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const tmp = mkdtempSync(join(tmpdir(), 'botons-starters-'));
const home = join(tmp, 'botons');
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
for (const d of [home, process.env.HOME]) mkdirSync(d, { recursive: true });
const log = (...a: unknown[]) => console.log('[starters]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[starters] FAIL ${what}`);
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
    BOTONS_LOG_LEVEL: 'warn',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
    HOME: process.env.HOME!,
  });
  cfg.webDist = webDist;
  const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: {} } });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const { secret, code } = createPairingRequest(app.store.db, 'starters check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'starters check' }) })).json()).token;
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
  const choose = (selector: string, value: string) =>
    evalIn(`(() => { const s = ${selector}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  const has = (re: RegExp, scope = 'document.body') => evalIn<boolean>(`${re}.test(${scope}?.innerText ?? '')`);
  const DIALOG = `[...document.querySelectorAll('dialog[open]')].at(-1)`;
  const chip = (name: string) => `[...document.querySelectorAll('.template-chip button')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
  const install = (name: string) => `[...${DIALOG}.querySelectorAll('button[type=submit]')].find((b) => /^Install ${name}, paused$/.test(b.textContent.trim()))`;
  const routineSection = (name: string) => `document.querySelector('.starter-routine[data-routine=${JSON.stringify(name)}]')`;
  const checkItem = (prefix: string) => `[...document.querySelectorAll('.starter-check li')].find((li) => li.dataset.key.startsWith(${JSON.stringify(prefix)}))`;
  const openNew = async (template: string, name: string, brain: string) => {
    await click(`document.querySelector('button[aria-label="New Boton"]')`);
    await click(chip(template));
    await waitFor(`document.querySelector('.starter-review')`);
    await choose(`document.querySelector('.brain-picker select')`, brain);
    await typeInto(`document.querySelector('input[data-autofocus]')`, name);
    await waitFor(`${DIALOG}.querySelector('.starter-grants ul')`);
  };

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('button[aria-label="New Boton"]')`);

  log('— Daily brief: choose, review, guided to a connector, install paused, check, test, turn on');
  await openNew('Daily brief', 'Kevin', 'mock');
  const needs = await text('.starter-needs');
  for (const k of ['Brain', 'Access', 'Schedule', 'Output', 'If a run fails']) check(needs.includes(k), `the review says what it needs: ${k}`);
  check(await has(/Calendar \(optional\)/, `document.querySelector('.starter-slots')`), 'its calendar connector is optional');
  check(await has(/no connector yet for calendar\. Add one in Settings → Connect a service/, `document.querySelector('.starter-guidance')`), 'guidance for the missing connector');
  await click(button('.starter-guidance', 'Connect a service'));
  await waitFor(`/How does it connect|Sign in to it/.test(${DIALOG}?.innerText ?? '')`);
  check(true, 'Connect a service opens from the review');
  await shot('connect-from-review');
  await evalIn(`${DIALOG}.querySelector('button[aria-label="Close"]')?.click() ?? ${DIALOG}.close()`);
  await waitFor(`document.querySelectorAll('dialog[open]').length === 1`);
  check(!(await has(/Set up Kevin/)) && ((await call('GET', '/api/bots')) as unknown[]).length === 0, 'closing Connect a service installs nothing');
  const grants = await text('.starter-grants');
  check(/Workspace access/.test(grants) && /No connectors\./.test(grants) && /No skills\./.test(grants), `exactly what it grants: ${grants.replace(/\n/g, ' | ').slice(0, 300)}`);
  check(/Routine “Morning brief”: Weekdays at 8:00 AM \(UTC\)\. Starts paused/.test(grants), 'its routine, its time and timezone, starting paused');
  check(!(await has(/Turn them on now/, DIALOG)), 'no switch to start a starter at install');
  await shot('daily-brief-review');
  await click(install('Kevin'));
  await waitFor(`/Set up Kevin/.test(document.body.innerText) && document.querySelector('.starter-check')`);
  check(await has(/Its routines stay paused until you turn them on here/), 'installed paused, and only turned on here');
  const scope = await text('.starter-setup section .hint');
  check(/Nothing was run, no connector or service was reached/.test(scope), 'the setup check says what it did not do');
  check(/Not verified/.test((await evalIn<string>(`${checkItem('test:')}?.innerText ?? ''`))), 'not yet tested, said so');
  const turnOnKevin = button(`.starter-routine[data-routine="Morning brief"]`, 'Turn on Morning brief');
  check(await evalIn<boolean>(`${turnOnKevin}?.disabled === true`), 'turning it on waits for a passing test');
  await shot('daily-brief-installed');
  await click(button(`.starter-routine[data-routine="Morning brief"]`, 'Run a test'));
  await waitFor(`/Test run finished without an error/.test(${routineSection('Morning brief')}?.innerText ?? '')`, 30_000);
  await waitFor(`/^OK/.test(${checkItem('test:')}?.innerText ?? '')`);
  check(/not that the reply is right/.test(await evalIn<string>(`${routineSection('Morning brief')}.innerText`)), 'a finished test run is not claimed as a right one');
  check(/nothing enforces that/.test(await text('.starter-routine .hint')), 'the dry run is said to be an instruction, not enforced');
  await waitFor(`${turnOnKevin}?.disabled === false`);
  // Edited after its test: the pass no longer counts, on the server and on the page, until it is tested again.
  const kevinId = ((await call('GET', '/api/bots')) as { id: string; name: string }[]).find((b) => b.name === 'Kevin')!.id;
  const [briefRoutine] = (await call('GET', `/api/bots/${kevinId}/routines`)) as { id: string }[];
  await call('PATCH', `/api/routines/${briefRoutine.id}`, { instruction: 'Write my morning briefing, in three lines.' });
  await click(button('.starter-setup', 'Check again'));
  await waitFor(`/Changed since the latest test run/.test(${checkItem('test:')}?.innerText ?? '')`);
  check(await evalIn<boolean>(`${turnOnKevin}?.disabled === true`), 'an edit after the test takes its pass away');
  await click(button(`.starter-routine[data-routine="Morning brief"]`, 'Test again'));
  await waitFor(`/finished without an error on its current settings/.test(${checkItem('test:')}?.innerText ?? '')`, 30_000);
  await waitFor(`${turnOnKevin}?.disabled === false`);
  check(true, 'tested again on what it has now: it can be turned on');
  await click(turnOnKevin);
  await waitFor(`/\\bOn\\b/.test(${routineSection('Morning brief')}?.querySelector('.starter-on')?.innerText ?? '')`);
  const kevin = ((await call('GET', '/api/bots')) as { id: string; name: string; connections: string[] }[]).find((b) => b.name === 'Kevin')!;
  const [brief] = (await call('GET', `/api/bots/${kevin.id}/routines`)) as { enabled: boolean }[];
  check(brief.enabled && kevin.connections.length === 0, 'turned on by the owner, with no connectors');
  await shot('daily-brief-on');
  await click(button('.starter-setup', 'Open Kevin'));
  await waitFor(`!document.querySelector('dialog[open]')`);

  log('— Research on request: a failing test keeps it off until the owner says otherwise');
  await openNew('Research on request', 'Bob', 'mock');
  check(/new URL and key at install, shown only in the routine's settings/.test(await text('.starter-grants')), 'the review says how its webhook key is handled');
  await click(install('Bob'));
  await waitFor(`${routineSection('Research a request')}`);
  const sample = `${routineSection('Research a request')}.querySelector('textarea')`;
  check(/"topic"/.test(await evalIn<string>(`${sample}.value`)), 'the sample request is filled in');
  await typeInto(sample, '{"topic": "FAIL_PLEASE"}');
  await click(button(`.starter-routine[data-routine="Research a request"]`, 'Run a test'));
  await waitFor(`/Test run failed/.test(${routineSection('Research a request')}?.innerText ?? '')`, 30_000);
  await waitFor(`/^Problem/.test(${checkItem('test:')}?.innerText ?? '')`);
  check(/Mock failure requested/.test(await evalIn<string>(`${checkItem('test:')}.innerText`)), 'the check says the test failed, and why');
  const turnOnBob = button(`.starter-routine[data-routine="Research a request"]`, 'Turn on Research a request');
  check(await evalIn<boolean>(`${turnOnBob}?.disabled === true`), 'a failed test keeps it from being turned on');
  const bob = ((await call('GET', '/api/bots')) as { id: string; name: string }[]).find((b) => b.name === 'Bob')!;
  const [research] = (await call('GET', `/api/bots/${bob.id}/routines`)) as { id: string; enabled: boolean; webhook: { key: string } }[];
  check(!research.enabled, 'still paused after the failed test');
  const html = await evalIn<string>(`document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
  check(research.webhook.key && !html.includes(research.webhook.key), 'its webhook key is nowhere in the page or its storage');
  await shot('research-failed');
  // The owner's own plain resume is refused too: only the setup turns it on.
  const resume = (await fetch(`${base}/api/routines/${research.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).status;
  check(resume === 409, `a plain resume of a starter's routine is refused (${resume})`);
  // Left for later, then found again from the Routines panel.
  await click(button('.starter-setup', 'Open Bob'));
  await waitFor(`!document.querySelector('dialog[open]')`);
  await click(`document.querySelector('button[aria-label="Routines"]')`);
  await click(`[...document.querySelectorAll('.routine-head')].find((b) => /Research a request/.test(b.innerText))`);
  await waitFor(`${button('.routine-card', 'Set up to turn on')}`);
  check(!(await evalIn<boolean>(`!!${button('.routine-card', /Resume$/)}`)), 'no Resume for a routine waiting on its setup');
  await click(button('.routine-card', 'Set up to turn on'));
  await waitFor(`/Set up Bob/.test(document.body.innerText) && ${routineSection('Research a request')}`);
  await waitFor(`/latest test run failed/.test(${checkItem('test:')}?.innerText ?? '')`);
  await click(`${routineSection('Research a request')}.querySelector('input[type=checkbox]')`);
  await click(turnOnBob);
  await waitFor(`${routineSection('Research a request')}?.querySelector('.starter-on')`);
  const audit = (await call('GET', '/api/audit')) as { action: string; target?: { id: string }; details?: { override?: boolean } }[];
  check(audit.some((e) => e.action === 'routine.starter_activated' && e.target?.id === research.id && e.details?.override === true), 'turned on by the owner with an override, which the audit records');
  await click(`${DIALOG}.querySelector('button[aria-label="Close"]')`);
  await waitFor(`!document.querySelector('dialog[open]')`);

  log('— Repository monitor: a required connector, then a stale review');
  const botonsBefore = ((await call('GET', '/api/bots')) as unknown[]).length;
  await openNew('Repository monitor', 'Stuart', 'claude-cli');
  await waitFor(`/no connector yet for code host/.test(document.querySelector('.starter-guidance')?.innerText ?? '')`);
  check(await evalIn<boolean>(`${install('Stuart')}?.disabled === true`), "it can't be installed without its code host connector");
  check(await has(/It can't be installed yet/, DIALOG), 'what blocks it is said');
  await shot('repo-monitor-missing');
  // The owner adds their connector (as Settings → Connect a service does; never contacted here), then checks again.
  await call('POST', '/api/mcp-servers', { name: 'code_github', transport: 'http', url: 'https://mcp.example.com/github' });
  await click(button('.starter-guidance', 'Check again'));
  await waitFor(`[...document.querySelectorAll('.starter-slot select option')].some((o) => o.value === 'lib:code_github')`);
  check(/code_github \(suggested\)/.test(await text('.starter-slot select')), 'the matching connector is suggested');
  await choose(`document.querySelector('.starter-slot select')`, 'lib:code_github');
  await waitFor(`/Connectors: code_github \\(code host\\)/.test(document.querySelector('.starter-grants')?.innerText ?? '')`);
  check(/the grant is the whole connector/.test(await text('.starter-slot')), 'says the grant is the whole connector');
  check(/wasn't ready at its last check.*The routines start paused either way/.test(await text('.starter-grants')), 'says the brain is not ready here, without blocking');
  await waitFor(`${install('Stuart')}?.disabled === false`);
  await shot('repo-monitor-reviewed');
  await call('PUT', '/api/connectors/lib:code_github/enabled', { enabled: false, expected: { enabled: true, botIds: [], running: [] } });
  await click(install('Stuart'));
  await waitFor(`/changed since you reviewed it/.test(${DIALOG}?.innerText ?? '')`);
  await waitFor(`/Turned off/.test(${DIALOG}?.querySelector('.starter-grants')?.innerText ?? '')`);
  check(true, 'a stale review is refused, and the new review says the connector is off');
  check(await evalIn<boolean>(`${install('Stuart')}?.disabled === true`), 'and it can no longer be installed');
  check(((await call('GET', '/api/bots')) as unknown[]).length === botonsBefore, 'no Boton was made');
  await shot('repo-monitor-stale');
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error('[starters]', err);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[starters] ${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else if (!code) log('all passed');
process.exit(code);
