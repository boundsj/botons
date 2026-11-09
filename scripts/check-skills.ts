// `npm run check:skills`: Skills → Install from a package in the real web app in headless Chrome, driven as the owner
// would, against a throwaway server (temp HOME and BOTONS_HOME, 127.0.0.1, free ports, no Tailscale, no real CLI)
// and skill packages written into its temp skill-packages folder. It checks that the owner can:
// - see each package with where it stands, and why one can't be installed (an archive);
// - review a new package: its procedure line by line, what it asks for (marked new), the files not installed, and
//   exactly which Botons get it, with what taking it from a Boton with every skill means;
// - install only after confirming what it asks for, to exactly the Botons checked, and that nothing in the package ran;
// - review an update with only what is new marked, and not install over a change made meanwhile;
// - see a package whose details alone changed (a new field) as an update, with that change shown;
// - put the earlier text back from the skill's details, and turn the skill off for every Boton.
// Exits 1 with what failed. `--out <dir>` saves screenshots (wide and phone width).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const tmp = mkdtempSync(join(tmpdir(), 'botons-skills-'));
const home = join(tmp, 'botons');
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
for (const d of [home, process.env.HOME]) mkdirSync(d, { recursive: true });
const log = (...a: unknown[]) => console.log('[skills]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[skills] FAIL ${what}`);
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
  const app = createApp(cfg, undefined, { tailnet: null });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const { secret, code } = createPairingRequest(app.store.db, 'skills check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'skills check' }) })).json()).token;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  await call('PATCH', '/api/setup', { complete: true });
  await call('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'UTC' });
  // Made in the store: no turn runs here.
  const providers = new Set(app.providers.ids());
  const kevin = app.store.createBot({ name: 'Kevin', provider: 'mock', skills: [] }, providers, 'mock');
  const stuart = app.store.createBot({ name: 'Stuart', provider: 'mock' }, providers, 'mock');
  const bob = app.store.createBot({ name: 'Bob', provider: 'mock', skills: [] }, providers, 'mock');

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
  const botonBox = (scope: string, name: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} .connector-access-list li`)})].find((l) => l.querySelector('.connector-name')?.textContent.startsWith(${JSON.stringify(name)}))?.querySelector('input')`;
  const text = (selector: string) => evalIn<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

  const DIALOG = 'dialog[open]:has(.skills-screen)';
  const pkgDir = join(home, 'skill-packages');
  const ran = join(tmp, 'ran');
  const writePkg = (folder: string, version: string, body: string, extra = '') => {
    mkdirSync(join(pkgDir, folder, 'scripts'), { recursive: true });
    writeFileSync(join(pkgDir, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: Write the weekly report for a repository.\nversion: ${version}\nallowed-tools: Bash(git:*)\n${extra}---\n\n${body}\n`);
    writeFileSync(join(pkgDir, folder, 'scripts', 'collect.sh'), `#!/bin/sh\ntouch ${ran}\n`);
    chmodSync(join(pkgDir, folder, 'scripts', 'collect.sh'), 0o755);
  };
  const STEPS = ['1. List the PRs merged in the last 7 days.', '2. Read https://status.example.com/feed for incidents.', '3. Group them by area.', '4. Send the report with `botons ask`.'];
  writePkg('weekly-report', '1.0.0', STEPS.join('\n'));
  writeFileSync(join(pkgDir, 'bundle.zip'), 'PK');
  const PANEL = `${DIALOG} .skill-packages`;
  const REVIEW = `${DIALOG} .skill-review`;
  /** The changed lines of the review's diff with this caption (Description, Procedure, Package details), as shown. */
  const changed = (...labels: string[]) =>
    evalIn<string[]>(
      `[...document.querySelectorAll('${REVIEW} .skill-diff')].filter((f) => ${JSON.stringify(labels)}.some((l) => f.querySelector('figcaption').textContent.startsWith(l))).flatMap((f) => [...f.querySelectorAll('.diff-add, .diff-remove')].map((e) => e.textContent.trim()))`,
    );
  const pkgItem = (folder: string) => `[...document.querySelectorAll('${PANEL} .skill-item')].find((l) => l.querySelector('.skill-name')?.textContent === ${JSON.stringify(folder)})`;
  const narrow = async (on: boolean) => {
    await browser.send('Emulation.setDeviceMetricsOverride', on ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  };

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('button[aria-label="Skills"]')`);
  await click(`document.querySelector('button[aria-label="Skills"]')`);
  await click(button(DIALOG, 'Install from a package'));

  log('— the packages folder');
  await waitFor(pkgItem('weekly-report'));
  check(/not installed/.test(await evalIn<string>(`${pkgItem('weekly-report')}.innerText`)), 'weekly-report: not installed');
  const zip = await evalIn<string>(`${pkgItem('bundle.zip')}.innerText`);
  check(/can't be installed/.test(zip) && /doesn't unpack archives/.test(zip) && !(await evalIn(`!!${pkgItem('bundle.zip')}.querySelector('button')`)), `an archive is listed with why, and no Review: ${zip.replace(/\n/g, ' | ')}`);
  check((await text(PANEL)).includes(pkgDir), 'the folder it reads is shown');
  await shot('packages');

  log('— review a new package');
  await click(`${pkgItem('weekly-report')}.querySelector('button')`);
  await waitFor(`document.querySelector('${REVIEW} .skill-diff')`);
  const added = await changed('Description', 'Procedure');
  check(added.length === STEPS.length + 1 && added.every((l) => l.startsWith('+')), `every line of the description and procedure is shown as added (${added.length})`);
  const details = await changed('Package details');
  check(JSON.stringify(details) === JSON.stringify(['+ version: 1.0.0', '+ allowed-tools: Bash(git:*)', '+ other file: scripts/collect.sh']), `its details are shown as added: ${JSON.stringify(details)}`);
  const asks = await text(`${REVIEW} .skill-asks`);
  check(/asks for allowed-tools: Bash\(git:\*\)/.test(asks) && /links to status\.example\.com/.test(asks) && /runs botons ask/.test(asks) && (asks.match(/new/g) ?? []).length >= 3, `what it asks for, each marked new: ${asks.replace(/\n/g, ' | ')}`);
  check(/Not installed: 1 other file/.test(await text(REVIEW)), 'the script in the folder is listed as not installed');
  const stuartRow = botonBox(REVIEW, 'Stuart');
  check(await evalIn(`${stuartRow}?.checked === true`) && (await evalIn(`${botonBox(REVIEW, 'Kevin')}?.checked === false`)), 'as it stands, Stuart (every skill) would get it, Kevin would not');
  const installBtn = button(REVIEW, /^Install for/);
  check(await evalIn(`${installBtn}?.disabled === true`), 'Install waits for confirming what it asks for');
  await click(botonBox(REVIEW, 'Kevin'));
  await click(stuartRow);
  check(/without weekly-report it gets a list of every other skill/.test(await evalIn<string>(`${stuartRow}.closest('li').innerText`)), 'unchecking Stuart says what that means for a Boton with every skill');
  await click(`[...document.querySelectorAll('${REVIEW} label.check')].find((l) => /I've read/.test(l.innerText)).querySelector('input')`);
  check(/Install for 1 Boton/.test(await evalIn<string>(`${installBtn}?.textContent`)), 'Install names how many Botons get it');
  await shot('review-new');
  await narrow(true);
  await shot('review-new-phone');
  const overflow = await evalIn<number>(`document.querySelector('${REVIEW}').scrollWidth - document.querySelector('${REVIEW}').clientWidth`);
  check(overflow <= 1, `no sideways scroll at phone width (${overflow}px)`);
  await narrow(false);
  await click(installBtn);
  await waitFor(`/Installed \\/weekly-report/.test(document.querySelector('${REVIEW}')?.innerText ?? '')`);
  const sk = app.skills.find('weekly-report');
  check(sk?.source?.label === '1.0.0' && sk.body === STEPS.join('\n'), 'installed on the server from the package, as reviewed');
  check(JSON.stringify(app.store.getBot(kevin.id).skills) === '["weekly-report"]' && JSON.stringify(app.store.getBot(stuart.id).skills) === '[]' && JSON.stringify(app.store.getBot(bob.id).skills) === '[]', 'exactly Kevin has it; Stuart lists every other skill instead');
  check(!existsSync(ran), 'nothing in the package ran');

  log('— an update, and a change made meanwhile');
  writePkg('weekly-report', '1.1.0', [...STEPS.slice(0, 2), '2b. Read https://metrics.example.net/api for the numbers.', ...STEPS.slice(2)].join('\n'));
  await click(button(REVIEW, 'Back to packages'));
  await waitFor(`/update available/.test(${pkgItem('weekly-report')}?.innerText ?? '')`);
  await click(`${pkgItem('weekly-report')}.querySelector('button')`);
  await waitFor(`document.querySelector('${REVIEW} .skill-diff')`);
  const diff = await changed('Description', 'Procedure');
  check(diff.length === 1 && diff[0].includes('metrics.example.net'), `only the new line is marked: ${JSON.stringify(diff)}`);
  const relabeled = await changed('Package details');
  check(JSON.stringify(relabeled) === JSON.stringify(['− version: 1.0.0', '+ version: 1.1.0']), `and the new version label: ${JSON.stringify(relabeled)}`);
  const newOnes = await evalIn<string[]>(`[...document.querySelectorAll('${REVIEW} .skill-asks li')].filter((l) => /new in this version/.test(l.innerText)).map((l) => l.innerText)`);
  check(newOnes.length === 1 && /metrics\.example\.net/.test(newOnes[0]), `only the new site is marked new: ${JSON.stringify(newOnes)}`);
  check(await evalIn(`${botonBox(REVIEW, 'Kevin')}?.checked === true`), 'Kevin keeps it by default');
  await call('PUT', '/api/skills/weekly-report/access', { botIds: [kevin.id, bob.id], expected: [kevin.id] });
  await click(`[...document.querySelectorAll('${REVIEW} label.check')].find((l) => /I've read/.test(l.innerText)).querySelector('input')`);
  await click(button(REVIEW, /^Update for/));
  await waitFor(`/changed since you looked/.test(document.querySelector('${REVIEW} [role=alert]')?.innerText ?? '')`);
  check(app.skills.get('weekly-report').source?.label === '1.0.0', 'the stale update changed nothing');
  await shot('stale');
  await click(button(REVIEW, 'Review again'));
  await waitFor(`${botonBox(REVIEW, 'Bob')}?.checked === true`);
  await click(`[...document.querySelectorAll('${REVIEW} label.check')].find((l) => /I've read/.test(l.innerText)).querySelector('input')`);
  await click(button(REVIEW, /^Update for 2 Botons/));
  await waitFor(`/Updated \\/weekly-report/.test(document.querySelector('${REVIEW}')?.innerText ?? '')`);
  check(app.skills.get('weekly-report').source?.label === '1.1.0', 'updated to 1.1.0 after reviewing again');
  await click(button(REVIEW, 'Back to packages'));

  log('— an update to its details alone');
  const v11 = [...STEPS.slice(0, 2), '2b. Read https://metrics.example.net/api for the numbers.', ...STEPS.slice(2)].join('\n');
  writePkg('weekly-report', '1.1.0', v11, 'license: MIT\n');
  await click(button(PANEL, 'Look again'));
  await waitFor(`/update available/.test(${pkgItem('weekly-report')}?.innerText ?? '')`);
  await click(`${pkgItem('weekly-report')}.querySelector('button')`);
  await waitFor(`document.querySelector('${REVIEW} .skill-diff')`);
  const same = await changed('Description', 'Procedure');
  const licensed = await changed('Package details');
  check(same.length === 0 && JSON.stringify(licensed) === JSON.stringify(['+ license: MIT']), `the text unchanged, the new field shown: ${JSON.stringify([same, licensed])}`);
  await shot('details-update');
  await click(button(REVIEW, /^Update for 2 Botons/));
  await waitFor(`/Updated \\/weekly-report/.test(document.querySelector('${REVIEW}')?.innerText ?? '')`);
  check(JSON.stringify(app.skills.get('weekly-report').source?.fields) === '{"allowed-tools":"Bash(git:*)","license":"MIT"}', 'updated with the new field');
  await click(button(REVIEW, 'Back to packages'));
  await waitFor(`/up to date/.test(${pkgItem('weekly-report')}?.innerText ?? '')`);
  await click(button(PANEL, 'Close'));

  log('— details: put the earlier text back, turn it off');
  const item = `[...document.querySelectorAll('${DIALOG} .skill-list .skill-item')].find((l) => l.querySelector('.skill-name')?.textContent === '/weekly-report')`;
  await waitFor(item);
  check(/package 1\.1\.0/.test(await evalIn<string>(`${item}.innerText`)), 'the skill shows the package version it came from');
  await click(`${item}.querySelector('button[aria-label^="Details of"]')`);
  await waitFor(`${item}.querySelector('.skill-manage')`);
  await click(`${item}.querySelector('.skill-manage .connector-history summary')`);
  await shot('details');
  await click(button(`${DIALOG} .skill-manage`, 'Put this back'));
  await waitFor(`/package 1\.0\.0/.test(${item}?.innerText ?? '')`);
  check(app.skills.get('weekly-report').body === STEPS.join('\n'), 'the earlier text is back on the server');
  await click(`[...${item}.querySelectorAll('.skill-manage label.check')].find((l) => /^On:/.test(l.innerText)).querySelector('input')`);
  await waitFor(`/\\boff\\b/.test(${item}?.querySelector('.skill-head')?.innerText ?? '')`);
  check(app.skills.get('weekly-report').disabled && app.skills.enabledFor(app.store.getBot(kevin.id), 'weekly-report') === null, 'turned off: Kevin no longer gets it');
  const hist = await evalIn<string>(`${item}.querySelectorAll('.skill-manage .connector-history')[1].querySelector('summary').click(), new Promise((r) => setTimeout(() => r(${item}.querySelectorAll('.skill-manage .connector-history')[1].innerText), 300))`);
  check(/installed or updated a skill/.test(hist) && /put back an earlier text/.test(hist) && /skillsAdded: weekly-report/.test(hist), `its history: ${hist.replace(/\n/g, ' | ')}`);
  await shot('off');
  check(!existsSync(ran), 'still nothing in the package ran');
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error('[skills]', err);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[skills] ${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else if (!code) log('all passed');
process.exit(code);
