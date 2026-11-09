// `npm run check:avatars`: the boton avatars in the real web app in headless Chrome, against a throwaway server
// (temp BOTONS_HOME, 127.0.0.1, a free port, the mock provider, no Tailscale, no real CLI), starting from a
// version-24 database whose Botons have capsule looks. It checks that:
// - the server backs the database up and upgrades it, and every Boton comes back a Boton with its name, id
//   and session, the same Boton the shared migration gives;
// - the sidebar shows each Boton's state in its avatar: working (a lit ring), waiting for approval (a raised,
//   waving arm), stuck (a red marker), idle (a blink), next to the busy dot and badges it already had;
// - avatars are decorative (aria-hidden), and the logo, favicon, app icon and manifest are served;
// - Settings → "Animate Botons" pauses every avatar animation, and so does the system's reduced motion;
// - the builder works by keyboard: tabs and choices are arrow-key radio groups whose focus follows the pick, the
//   preview is named for its look and state, and Cancel keeps the saved look and gives focus back to the avatar;
// - a new Boton's suggested name comes from the generic pool.
// Exits 1 with what failed. `--out <dir>` saves screenshots (desktop, mobile, the editor).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { lookFor, parseLook } from '../shared/look.ts';
import type { Bot, BotonLook } from '../shared/types.ts';
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
const home = mkdtempSync(join(tmpdir(), 'botons-avatars-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[avatars]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[avatars] FAIL ${what}`);
  }
};

/** Botons as a version-24 install holds them: capsule looks (yellow, one eye, a custom color), and one unreadable. */
const CREW: { id: string; name: string; look: string }[] = [
  { id: 'bot_juniper1', name: 'Juniper', look: JSON.stringify({ body: '#f6c90e', bg: '#2f6fed', eyes: 2, hair: 'sprout', mouth: 'smile' }) },
  { id: 'bot_rowan001', name: 'Rowan', look: JSON.stringify({ body: '#7bd389', bg: '#14b8c4', eyes: 1, hair: 'antenna', mouth: 'o' }) },
  { id: 'bot_wren0001', name: 'Wren', look: JSON.stringify({ body: '#5fb3f9', bg: '#8b5cf6', eyes: 2, hair: 'combed', mouth: 'flat' }) },
  { id: 'bot_marlow01', name: 'Marlow', look: JSON.stringify({ body: '#f4b400', bg: '#ef6c2f', eyes: 2, hair: 'spiky', mouth: 'grin' }) },
  { id: 'bot_hazel001', name: 'Hazel', look: JSON.stringify({ body: '#ffd84d', bg: '#e0457b', eyes: 2, hair: 'none', mouth: 'grin' }) },
  { id: 'bot_odile001', name: 'Odile', look: JSON.stringify({ body: '#9b5de5', bg: '#1fb57a', eyes: 2, hair: 'spiky', mouth: 'smile' }) },
  { id: 'bot_tamsin01', name: 'Tamsin', look: JSON.stringify({ body: '#e05a5a', bg: '#5b6170', eyes: 1, hair: 'combed', mouth: 'o' }) },
  { id: 'bot_quarter1', name: 'Quartermaster of Quarterly Reports', look: 'not json' },
];

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
  const webDist = opt['skip-build'] ? resolve(opt['skip-build']) : join(home, 'web-dist');
  if (!opt['skip-build']) {
    log('building web …');
    await new Promise<void>((res, rej) => {
      const p = spawn(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', webDist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(root, 'web'), stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
    });
  }

  // A version-24 database, as an install that ran the capsule avatars has it.
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`${readFileSync(join(root, 'server/test/fixtures/schema-24.sql'), 'utf8')}\npragma user_version = 24;`);
  db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
  const add = db.prepare("insert into bots (id, name, look, provider, timezone, workspace, session_id, session_key, pinned, created_at, updated_at, last_activity_at) values (?, ?, ?, 'mock', 'UTC', ?, ?, ?, ?, ?, ?, ?)");
  for (const [i, b] of CREW.entries()) {
    mkdirSync(join(home, 'workspaces', b.id), { recursive: true });
    add.run(b.id, b.name, b.look, b.id, `sess-${i}`, `key-${i}`, b.name === 'Wren' ? 1 : 0, now, now, now);
  }
  db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_hazel001', 'error', 'The brain stopped answering.', ?)").run(now);
  db.prepare("insert into approvals (id, bot_id, kind, title, status, trigger, asked_by, created_at, expires_at, action) values ('apr_1', 'bot_marlow01', 'action', 'Push the release branch', 'pending', 'chat', '[]', ?, ?, 'git push')").run(now, later);
  db.close();

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

  // 1. The upgrade.
  check(readdirSync(join(home, 'backups')).length === 1, 'the version-24 database was backed up before the upgrade');
  const { secret, code } = createPairingRequest(app.store.db, 'avatar check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'avatar check' }) })).json()).token;
  const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setup = await call('PATCH', '/api/setup', { complete: true });
  if (!setup.ok) throw new Error(`setup: ${setup.status} ${await setup.text()}`);
  const bots = (await (await call('GET', '/api/bots')).json()) as Bot[];
  const byName = Object.fromEntries(bots.map((b) => [b.name, b]));
  check(
    CREW.every((c, i) => byName[c.name]?.id === c.id && app.store.getBot(c.id).sessionId === `sess-${i}` && app.store.getBot(c.id).sessionKey === `key-${i}` && parseLook(byName[c.name].look)),
    'every Boton kept its id, name and session, and has a Boton look',
  );
  check(
    CREW.filter((c) => c.look.startsWith('{')).every((c) => JSON.stringify(byName[c.name].look) === JSON.stringify(lookFor(JSON.parse(c.look), c.id))),
    'each capsule look became the Boton the shared migration gives for that Boton',
  );
  for (const p of ['/favicon.svg', '/icon.svg', '/manifest.webmanifest']) {
    const r = await fetch(base + p);
    check(r.ok && /svg|manifest/.test(r.headers.get('content-type') ?? ''), `${p} is served (${r.status} ${r.headers.get('content-type')})`);
  }

  // A turn that keeps Rowan working while the page is looked at.
  await call('POST', `/api/bots/${byName.Rowan.id}/messages`, { text: 'SLOW_PLEASE:120000' });

  // 2. Chrome, in its own profile.
  const chrome = spawn(opt.chrome!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(home, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
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
  const size = (width: number, height: number, mobile = false) => browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile }, page);
  await size(1280, 900);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(base)}) localStorage.setItem('botons.deviceToken', ${JSON.stringify(token)});` }, page);
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
  const shot = async (name: string) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
    writeFileSync(join(resolve(opt.out), `${name}.png`), Buffer.from(data, 'base64'));
  };
  const row = (name: string) => `[...document.querySelectorAll('.bot-row, .pinned-item')].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;
  const avatarOf = (name: string) => `${row(name)}?.querySelector('svg.avatar')`;

  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelectorAll('.bot-row svg.avatar').length + document.querySelectorAll('.pinned-item svg.avatar').length === ${CREW.length + 1}`);
  await waitFor(`${avatarOf('Rowan')}?.querySelector('.av-spin')`);
  await waitFor(`${avatarOf('Marlow')}?.querySelector('.av-wave')`);
  check(await evalIn(`!!${avatarOf('Rowan')}.querySelector('.av-spin') && ${row('Rowan')}.querySelector('.avatar-wrap.busy') !== null`), 'Rowan, working: a lit ring around the button, and the busy dot still there');
  check(await evalIn(`!!${row('Marlow')}.querySelector('.approval-badge, [class*="approval"]')`), 'Marlow, waiting for approval: a raised, waving arm, and the approval badge still there');
  check(await evalIn(`${avatarOf('Hazel')}.innerHTML.includes('#e5484d') && !${avatarOf('Hazel')}.querySelector('.av-blink')`), 'Hazel, whose last turn failed: a red marker and a worried face');
  check(await evalIn(`!!${avatarOf('Juniper')}.querySelector('.av-blink')`), 'Juniper, idle: blinks');
  check(await evalIn(`[...document.querySelectorAll('svg.avatar')].every((s) => s.getAttribute('aria-hidden') === 'true')`), 'every avatar in the sidebar is decorative (the name is next to it)');
  check(await evalIn(`new Set([...document.querySelectorAll('.bot-row svg.avatar')].map((s) => s.style.getPropertyValue('--ph'))).size > 3`), 'blinks are out of step: each Boton has its own phase');
  check(await evalIn(`document.querySelector('.brand svg[role=img]')?.getAttribute('aria-label') === 'Botons' && !document.querySelector('.brand svg [class]')`), 'the logo is the brand Boton and wordmark, named Botons, still');
  check(await evalIn(`document.querySelector('link[rel=icon]').getAttribute('href') === '/favicon.svg' && document.querySelector('link[rel=manifest]') !== null`), 'the page links the favicon and the manifest');
  const anim = (name: string) => evalIn<string>(`getComputedStyle(${avatarOf(name)}.querySelector('.av-blink, .av-spin')).animationName`);
  check((await anim('Juniper')) === 'av-blink', `the blink runs (animation ${await anim('Juniper')})`);
  await shot('sidebar-desktop');

  // 3. The pause control, then the system's reduced motion.
  await evalIn(`document.querySelector('.sidebar-foot button[aria-label*="ettings"], .sidebar-foot [title*="ettings"]')?.click(); 0`);
  await waitFor(`document.querySelector('.settings-nav [data-section="appearance"]')`).catch(async () => {
    // The settings button's label differs by build; open it by its text instead.
    await evalIn(`[...document.querySelectorAll('button')].find((b) => /settings/i.test(b.getAttribute('aria-label') ?? b.title ?? b.textContent))?.click(); 0`);
    await waitFor(`document.querySelector('.settings-nav [data-section="appearance"]')`);
  });
  await evalIn(`document.querySelector('.settings-nav [data-section="appearance"]').click(); 0`);
  await waitFor(`[...document.querySelectorAll('label.check')].some((l) => l.textContent.includes('Animate Botons'))`);
  await evalIn(`[...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('Animate Botons')).querySelector('input').click(); 0`);
  check((await anim('Juniper')) === 'none' && (await anim('Rowan')) === 'none', 'Settings → Animate Botons off: every avatar keeps still');
  check(await evalIn(`!!${avatarOf('Marlow')}.querySelector('.av-wave')`), 'still, the waiting Boton keeps its raised hand: the pose carries the state');
  check(await evalIn(`localStorage.getItem('botons.avatarMotion') === 'off'`), 'the choice is kept on this device');
  await evalIn(`[...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('Animate Botons')).querySelector('input').click(); 0`);
  check((await anim('Juniper')) === 'av-blink', 'on again: the blink runs');
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, page);
  check((await anim('Juniper')) === 'none', 'reduced motion: every avatar keeps still');
  await browser.send('Emulation.setEmulatedMedia', { features: [] }, page);
  await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('dialog [aria-label="Close"], .dialog [aria-label="Close"]')?.click(); 0`);

  // 4. The look editor, in Wren's settings.
  await browser.send('Page.navigate', { url: `${base}/#/m/${byName.Wren.id}` }, page);
  await waitFor(`document.querySelector('.title-chip')`);
  // The welcome renders once the chat's (empty) history has loaded, a moment after the title.
  await waitFor(`document.querySelector('.welcome svg.avatar')`);
  check(await evalIn(`document.querySelector('.welcome svg.avatar')?.getAttribute('width') === '112' && document.querySelector('.welcome svg.avatar').querySelectorAll('[stroke-opacity=".22"], [opacity=".22"]').length > 2`), 'the 112 px welcome avatar gets the full detail (glow halos)');
  await evalIn(`document.querySelector('.title-chip').click(); 0`);
  await waitFor(`document.querySelector('.boton-settings .set-avatar')`);
  await evalIn(`document.querySelector('.boton-settings .set-avatar').focus(); document.querySelector('.boton-settings .set-avatar').click(); 0`);
  await waitFor(`document.querySelector('.boton-builder')`);
  const wren = byName.Wren.look as BotonLook;
  check(wren.shell === 'sun' && wren.top === 'beacon' && wren.backdrop === 'lilac', `Wren's sky capsule with combed hair became a sun Boton with a beacon (${wren.shell}, ${wren.top}, ${wren.backdrop})`);
  const preview = `document.querySelector('.boton-stage svg.avatar[role=img]')`;
  check(await evalIn(`${preview}?.getAttribute('aria-label').startsWith('Preview, idle: Sun')`), 'the preview is named for its state and look');
  check(await evalIn(`document.querySelectorAll('.boton-builder [role=tab]').length === 4 && document.querySelectorAll('.boton-builder [role=tab][tabindex="0"]').length === 1`), 'four part tabs, one tab stop');
  // A part by keyboard: the checked choice is the group's tab stop; an arrow picks the next and focus follows.
  const shape = `document.querySelector('.boton-builder [role=radiogroup][aria-label=Shape]')`;
  await evalIn(`${shape}.querySelector('[aria-checked=true]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); 0`);
  await waitFor(`${shape}.querySelector('[aria-checked=true]') === document.activeElement && document.activeElement.textContent !== ${JSON.stringify(wren.shape === 'round' ? 'Round' : '')}`);
  check(await evalIn(`${shape}.querySelectorAll('[tabindex="0"]').length === 1 && !${preview}.getAttribute('aria-label').includes(${JSON.stringify(wren.shape)} + ' Boton')`), 'an arrow key picks the next shape, focus follows, and the preview says the new look');
  // The tabs too.
  await evalIn(`document.querySelector('.boton-builder [role=tab][aria-selected=true]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); 0`);
  await waitFor(`document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.textContent === 'Face' && document.activeElement.getAttribute('aria-selected') === 'true'`);
  check(await evalIn(`!!document.querySelector('.boton-builder [role=tabpanel] [role=radiogroup][aria-label=Eyes]')`), 'an arrow key moves to the Face tab, and its panel shows the eyes');
  // The preview's states.
  await evalIn(`[...document.querySelectorAll('.stage-states [role=radio]')].find((b) => b.textContent === 'No brain').click(); 0`);
  await waitFor(`${preview}.getAttribute('aria-label').startsWith('Preview, no brain:')`);
  check(await evalIn(`document.querySelectorAll('.stage-states [role=radio]').length === 5 && !!${preview}.querySelector('.av-zzz')`), 'the preview shows each of the five states, asleep with no brain');
  await shot('editor');
  // Cancel: nothing is saved, and focus goes back to the avatar that opened the builder.
  await evalIn(`[...document.querySelectorAll('dialog[open] .form-actions button')].find((x) => x.textContent.trim() === 'Cancel').click(); 0`);
  await waitFor(`!document.querySelector('.boton-builder')`);
  check(await evalIn(`document.activeElement?.getAttribute('aria-label') === 'Change look'`), 'Cancel closes the builder and focus goes back to the avatar');
  await evalIn(`document.querySelector('.boton-settings .set-avatar').click(); 0`);
  await waitFor(`${shape}?.querySelector('[aria-checked=true]')`);
  check(await evalIn(`${shape}.querySelector('[aria-checked=true]').textContent === ${JSON.stringify({ round: 'Round', pill: 'Pill', key: 'Key' }[wren.shape])}`), 'Cancel kept the saved look');
  await evalIn(`[...document.querySelectorAll('dialog[open] .form-actions button')].find((x) => x.textContent.trim() === 'Cancel').click(); 0`);

  // 5. A new Boton's placeholder name, and the phone layout.
  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`document.querySelector('.sidebar')`);
  await evalIn(`[...document.querySelectorAll('button')].find((b) => /new boton/i.test(b.textContent ?? '') || /new boton/i.test(b.getAttribute('aria-label') ?? ''))?.click(); 0`);
  await waitFor(`document.querySelector('.boton-builder')`);
  const placeholder = await evalIn<string>(`[...document.querySelectorAll('input')].find((i) => i.placeholder && !i.value && i.closest('label')?.textContent.includes('Name'))?.placeholder ?? ''`);
  const POOL = ['Juniper', 'Rowan', 'Wren', 'Marlow', 'Hazel', 'Odile', 'Tamsin', 'Ines', 'Sorrel', 'Linden', 'Indigo', 'Fennel', 'Kestrel', 'Juno', 'Pax', 'Teo'];
  check(POOL.some((n) => placeholder.includes(n)), `a new Boton's suggested name is from the generic pool ("${placeholder}")`);
  await shot('new-boton');
  await browser.send('Page.navigate', { url: base }, page);
  await size(390, 844, true);
  await waitFor(`document.querySelectorAll('.bot-row svg.avatar').length > 0`);
  await shot('sidebar-mobile');
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[avatars]', err);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[avatars] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
