// `npm run check:sidebar`: the sidebar's groups, pins and collapse in the real web app in headless Chrome, against a
// throwaway server (temp BOTONS_HOME, 127.0.0.1, a free port, the mock provider, no Tailscale, no real CLI). It
// checks that, with the keyboard alone:
// - a group is made, named twice in another case is refused (the reason in the dialog), renamed and deleted (its
//   Botons go to Ungrouped, none is deleted);
// - a row's menu (a labelled menu button, arrow keys, Escape) pins, moves up and down, and moves to another group,
//   and focus comes back to that Boton's menu where it now is; Pinned has its own order;
// - a group and Pinned collapse and expand, stay so after a reload (the layout is the server's), render no Boton
//   rows while collapsed, and still show the unread, approval and busy counts inside, in the toggle's name too;
// - a change from another device shows up live; search finds a Boton in a collapsed group and Enter opens it;
// - "New Boton in <group>" makes it there; the settings form moves a Boton by the group's id;
// - a sidebar change leaves the open chat's DOM alone;
// - on a phone-sized touch screen, the menus are visible and open with a tap.
// And with a real mouse and real touches (Chrome's input pipeline, emulated touch):
// - dragging a row reorders within its group, moves across groups and into Ungrouped, drops onto a collapsed group's
//   head and into an empty group, pins by dropping on Pinned (a zone that moves nothing under the pointer) and
//   reorders the pinned; a group's head reorders groups; a pinned tile can't leave Pinned; Escape puts it back;
// - each drop shows at once, reaches the server and another tab live, survives a reload, and leaves the chat alone;
// - by touch, a swipe scrolls and picks nothing up, a long press picks up and drops, and a tap still opens a chat.
// Exits 1 with what failed. `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Bot, SidebarLayout } from '../shared/types.ts';
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
const home = mkdtempSync(join(tmpdir(), 'botons-sidebar-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[sidebar]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[sidebar] FAIL ${what}`);
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

  const { secret, code } = createPairingRequest(app.store.db, 'sidebar check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'sidebar check' }) })).json()).token;
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  await call('PATCH', '/api/setup', { complete: true });
  await call('PATCH', '/api/settings', { ownerName: 'Sam' });
  const crew: Record<string, Bot> = {};
  for (const name of ['Kevin', 'Stuart', 'Bob', 'Dave', 'Jerry', 'Carl']) crew[name] = await call<Bot>('POST', '/api/bots', { name, provider: 'mock', access: 'workspace' });
  const layout = () => call<SidebarLayout>('GET', '/api/sidebar');
  const nameOf = (id: string) => Object.values(crew).find((b) => b.id === id)?.name ?? id;
  const shape = async () => {
    const l = await layout();
    return {
      pinned: l.pinned.botIds.map(nameOf),
      groups: l.groups.map((g) => `${g.name}${g.collapsed ? ' (collapsed)' : ''}: ${g.botIds.map(nameOf).join(', ')}`),
      ungrouped: l.ungrouped.botIds.map(nameOf),
    };
  };
  // Unread replies for Jerry, a waiting approval for Carl, and Dave kept working.
  await call('POST', `/api/bots/${crew.Jerry.id}/messages`, { text: 'hello' });
  await call('POST', `/api/bots/${crew.Jerry.id}/messages`, { text: 'again' });
  const now = new Date().toISOString();
  app.store.db
    .prepare("insert into approvals (id, bot_id, kind, title, status, trigger, asked_by, created_at, expires_at, action) values ('apr_1', ?, 'action', 'Push the release branch', 'pending', 'chat', '[]', ?, ?, 'git push')")
    .run(crew.Carl.id, now, new Date(Date.now() + 86_400_000).toISOString());
  await call('POST', `/api/bots/${crew.Dave.id}/messages`, { text: 'SLOW_PLEASE:120000' });
  const deadline = Date.now() + 10_000;
  while ((await call<Bot>('GET', `/api/bots/${crew.Jerry.id}`)).unread < 2 && Date.now() < deadline) await sleep(50);

  // Chrome, in its own profile.
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
  const waitFor = async (expr: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`).catch(() => false)) return true;
      await sleep(40);
    }
    const shown = await evalIn<string>('location.href + "\\n" + (document.querySelector(".sidebar")?.innerText ?? document.body.innerText).slice(0, 600)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  const shot = async (name: string) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    await sleep(250);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
    writeFileSync(join(resolve(opt.out), `${name}.png`), Buffer.from(data, 'base64'));
  };
  // Real key presses, so focus, menus and forms behave as they do for a person.
  const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Escape: { code: 'Escape', keyCode: 27 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    End: { code: 'End', keyCode: 35 },
    Home: { code: 'Home', keyCode: 36 },
    Tab: { code: 'Tab', keyCode: 9 },
    ' ': { code: 'Space', keyCode: 32, text: ' ' },
  };
  const press = async (key: string) => {
    const k = KEYS[key];
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, ...(k.text && { text: k.text }) }, page);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode }, page);
    await sleep(30);
  };
  const type = async (text: string) => {
    await browser.send('Input.insertText', { text }, page);
    await sleep(30);
  };
  const focus = (selector: string) => evalIn(`(() => { const el = ${selector}; if (!el) throw new Error('nothing to focus: ' + ${JSON.stringify(selector)}); el.focus(); return true; })()`);
  const active = () => evalIn<string>(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.textContent.trim()) : ''; })()`);
  const q = (s: string) => JSON.stringify(s);
  const section = (name: string) => `[...document.querySelectorAll('.sidebar-scroll section.group')].find((s) => s.getAttribute('aria-label') === ${q(name)})`;
  const rowsIn = (name: string) => evalIn<string[]>(`[...(${section(name)}?.querySelectorAll('.bot-row-name, .pinned-name') ?? [])].map((n) => n.textContent.trim())`);
  const menuButton = (sectionName: string, bot: string) => `${section(sectionName)}?.querySelector('[aria-label=${q(sectionName === 'Pinned' ? `Options for ${bot} in Pinned` : `Options for ${bot}`)}]')`;
  const toggleOf = (name: string) => `${section(name)}?.querySelector('.group-toggle')`;
  const menuOpen = () => evalIn<boolean>(`!!document.querySelector('.menu:popover-open')`);
  const menuItems = () => evalIn<string[]>(`[...document.querySelectorAll('.menu:popover-open [role^=menuitem]')].map((i) => i.textContent.trim())`);
  /** Opens the menu from its button with the keyboard and picks `item` with arrow keys and Enter. */
  const choose = async (button: string, item: string) => {
    await focus(button);
    await press('Enter');
    await waitFor(`document.querySelector('.menu:popover-open')`);
    const items = await menuItems();
    const at = items.indexOf(item);
    if (at < 0) throw new Error(`no "${item}" in the menu: ${items.join(' | ')}`);
    for (let i = 0; i < at; i++) await press('ArrowDown');
    if ((await active()) !== item) throw new Error(`arrow keys reached "${await active()}", not "${item}"`);
    await press('Enter');
  };
  /** The accessible name Chrome computes for an element: what a screen reader announces. */
  const axName = async (expr: string): Promise<string> => {
    const { result } = await browser.send('Runtime.evaluate', { expression: expr }, page);
    const { nodes } = await browser.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false }, page);
    return String(nodes[0]?.name?.value ?? '');
  };
  const dialogOpen = (title: string) => `document.querySelector('dialog[open][aria-label=${q(title)}]')`;

  await browser.send('Page.navigate', { url: `${base}/#/m/${crew.Bob.id}` }, page);
  await waitFor(`document.querySelectorAll('.bot-row').length === 6 && document.querySelector('.messages')`);
  check(await evalIn(`!document.querySelector('.group-toggle') && !!document.querySelector('.new-group-btn')`), 'with no groups and no pins: one plain list, no section headers, and a New group button');
  check(
    await evalIn(`[...document.querySelectorAll('.row-menu button')].every((b) => /^Options for /.test(b.getAttribute('aria-label')) && b.getAttribute('aria-haspopup') === 'menu' && b.getAttribute('aria-expanded') === 'false')`),
    'every row has a labelled menu button (aria-haspopup=menu, aria-expanded)',
  );

  // The chat's DOM, watched from here on: no sidebar change may touch it.
  await evalIn(`window.__chatMutations = 0; new MutationObserver((m) => { window.__chatMutations += m.length; }).observe(document.querySelector('.messages'), { subtree: true, childList: true, attributes: true, characterData: true }); 0`);

  // 1. Make a group, with the keyboard.
  await focus(`document.querySelector('.new-group-btn')`);
  await press('Enter');
  await waitFor(dialogOpen('New group'));
  check((await evalIn(`document.activeElement?.tagName`)) === 'INPUT', 'New group: the dialog opens with the name field focused');
  await type('Work');
  await press('Enter');
  await waitFor(`${section('Work')}`);
  check((await shape()).groups.join() === 'Work: ', 'the group is on the server, empty');
  check(await evalIn(`${section('Work')}.textContent.includes('No Botons here yet')`), 'an empty group says how to fill it');
  // The same name in another case is refused, and the dialog says why.
  await focus(`document.querySelector('.new-group-btn')`);
  await press('Enter');
  await waitFor(dialogOpen('New group'));
  await type('WORK');
  await press('Enter');
  await waitFor(`document.querySelector('dialog[open] [role=alert]')`);
  const refused = await evalIn<string>(`document.querySelector('dialog[open] [role=alert]').textContent`);
  check(/already a group called Work/.test(refused) && (await evalIn(`document.querySelector('dialog[open] input').getAttribute('aria-invalid') === 'true'`)), `a second "work" is refused in the dialog: "${refused}"`);
  await press('Escape');
  await waitFor(`!document.querySelector('dialog[open]')`);
  await shot('1-new-group');

  // 2. Move Kevin into Work from his menu, with arrow keys.
  await focus(menuButton('Ungrouped', 'Kevin'));
  await press('Enter');
  await waitFor(`document.querySelector('.menu:popover-open')`);
  check((await evalIn(`document.activeElement?.getAttribute('role')`)) === 'menuitem' && (await active()) === 'Pin to top', 'the menu opens with focus on its first item');
  check(
    JSON.stringify(await menuItems()) === JSON.stringify(['Pin to top', 'Move up', 'Move down', 'Work', 'Ungrouped', 'Move to a new group…']),
    `Kevin's menu: ${(await menuItems()).join(' | ')}`,
  );
  check(await evalIn(`document.querySelector('.menu:popover-open [role=menuitem]:nth-child(2)')?.getAttribute('aria-disabled') === 'true'`), 'Move up is disabled for the first row');
  check(
    await evalIn(`(() => { const r = [...document.querySelectorAll('.menu:popover-open [role=menuitemradio]')]; return r.length === 2 && r.find((x) => x.textContent === 'Ungrouped').getAttribute('aria-checked') === 'true' && !!document.querySelector('.menu:popover-open [role=group][aria-label="Move to group"]'); })()`),
    'groups are radio items in a labelled "Move to group" group, the current one checked',
  );
  await press('End');
  check((await active()) === 'Move to a new group…', 'End goes to the last item');
  await press('Escape');
  await waitFor(`!document.querySelector('.menu:popover-open')`);
  check((await active()) === 'Options for Kevin', 'Escape closes the menu and focus goes back to its button');
  await shot('2-menu');
  await choose(menuButton('Ungrouped', 'Kevin'), 'Work');
  await waitFor(`${section('Work')}?.textContent.includes('Kevin')`);
  check(JSON.stringify(await rowsIn('Work')) === '["Kevin"]', 'Kevin moved into Work');
  await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Options for Kevin' && ${section('Work')}.contains(document.activeElement)`, 3000).catch(() => {});
  check((await active()) === 'Options for Kevin' && (await evalIn(`${section('Work')}.contains(document.activeElement)`)), 'focus follows Kevin to his row in Work');

  // Stuart too, then up above Kevin.
  await choose(menuButton('Ungrouped', 'Stuart'), 'Work');
  await waitFor(`${section('Work')}?.textContent.includes('Stuart')`);
  await choose(menuButton('Work', 'Stuart'), 'Move up');
  await waitFor(`${section('Work')}.querySelector('.bot-row-name')?.textContent === 'Stuart'`);
  check((await shape()).groups.join() === 'Work: Stuart, Kevin', 'Move up: Stuart is first in Work, on the server too');
  await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Options for Stuart'`, 3000).catch(() => {});
  check((await active()) === 'Options for Stuart', 'focus stays with Stuart after Move up, ready to move again');
  await choose(menuButton('Work', 'Stuart'), 'Move down');
  await waitFor(`${section('Work')}.querySelector('.bot-row-name')?.textContent === 'Kevin'`);
  check((await shape()).groups.join() === 'Work: Kevin, Stuart', 'Move down puts him back');

  // 3. Pins: Kevin and Bob pinned from their menus, then reordered in Pinned.
  await choose(menuButton('Work', 'Kevin'), 'Pin to top');
  await waitFor(`${section('Pinned')}`);
  await choose(menuButton('Ungrouped', 'Bob'), 'Pin to top');
  await waitFor(`${section('Pinned')}?.querySelectorAll('.pinned-item').length === 2`);
  check(JSON.stringify(await rowsIn('Pinned')) === '["Kevin","Bob"]' && (await rowsIn('Work')).includes('Kevin'), 'pinned in order, and Kevin stays in Work too');
  await choose(menuButton('Pinned', 'Bob'), 'Move left');
  await waitFor(`${section('Pinned')}.querySelector('.pinned-name')?.textContent === 'Bob'`);
  check(JSON.stringify((await shape()).pinned) === '["Bob","Kevin"]', 'Move left in Pinned: Bob first, on the server too');
  await focus(menuButton('Pinned', 'Bob'));
  await press('Enter');
  await waitFor(`document.querySelector('.menu:popover-open')`);
  check(JSON.stringify(await menuItems()) === JSON.stringify(['Move left', 'Move right', 'Unpin']), `a pinned tile's menu: ${(await menuItems()).join(' | ')}`);
  await press('Escape');

  // 4. Collapse Work (Carl and Jerry in it first: an approval and unread replies) with the keyboard.
  await choose(menuButton('Ungrouped', 'Carl'), 'Work');
  await waitFor(`${section('Work')}?.textContent.includes('Carl')`);
  await choose(menuButton('Ungrouped', 'Jerry'), 'Work');
  await waitFor(`${section('Work')}?.textContent.includes('Jerry')`);
  await choose(menuButton('Ungrouped', 'Dave'), 'Work');
  await waitFor(`${section('Work')}?.textContent.includes('Dave')`);
  const avatarsBefore = await evalIn<number>(`document.querySelectorAll('.sidebar svg.avatar').length`);
  await focus(toggleOf('Work'));
  await press('Enter');
  await waitFor(`${toggleOf('Work')}?.getAttribute('aria-expanded') === 'false'`);
  check(await evalIn(`${section('Work')}.querySelectorAll('.bot-item, svg.avatar').length === 0`), 'collapsed, Work renders no Boton rows (and no avatars)');
  check((await evalIn<number>(`document.querySelectorAll('.sidebar svg.avatar').length`)) === avatarsBefore - 5, 'the five avatars in Work are gone from the page');
  const toggleName = await axName(toggleOf('Work'));
  check(toggleName === 'Work, 5 Botons, 2 unread, 1 waiting for approval, 1 working', `the toggle's accessible name carries what Work hides: "${toggleName}"`);
  check(
    await evalIn(`(() => { const s = ${section('Work')}; return s.querySelector('.group-summary .unread-badge')?.textContent === '2' && s.querySelector('.group-summary .approval-badge')?.textContent.includes('1') && s.querySelector('.group-summary .busy-count')?.textContent === '1'; })()`),
    'and shows them: 2 unread, 1 approval, 1 working',
  );
  check((await shape()).groups.join() === 'Work (collapsed): Kevin, Stuart, Carl, Jerry, Dave', 'collapsed on the server');
  check(await evalIn(`document.activeElement === ${toggleOf('Work')}`), 'focus stays on the toggle');
  check((await axName(section('Work'))) === 'Work', 'the collapsed section is still a region named Work');
  // Pinned collapses too.
  await focus(toggleOf('Pinned'));
  await press(' ');
  await waitFor(`${toggleOf('Pinned')}?.getAttribute('aria-expanded') === 'false'`);
  check(await evalIn(`!${section('Pinned')}.querySelector('.pinned-item')`), 'Pinned collapses');
  await shot('3-collapsed');
  // After a reload, both are still collapsed.
  await browser.send('Page.reload', {}, page);
  await waitFor(`${toggleOf('Work')}`);
  check(await evalIn(`${toggleOf('Work')}.getAttribute('aria-expanded') === 'false' && ${toggleOf('Pinned')}.getAttribute('aria-expanded') === 'false'`), 'after a reload, Work and Pinned are still collapsed');
  await focus(toggleOf('Pinned'));
  await press('Enter');
  await waitFor(`${section('Pinned')}?.querySelector('.pinned-item')`);
  await waitFor(`document.querySelector('.messages')`);
  await evalIn(`window.__chatMutations = 0; new MutationObserver((m) => { window.__chatMutations += m.length; }).observe(document.querySelector('.messages'), { subtree: true, childList: true, attributes: true, characterData: true }); 0`);

  // 5. Another device renames Work and moves Bob into it: both show up here live.
  await call('PATCH', `/api/sidebar/groups/${(await layout()).groups[0].id}`, { name: 'Day job' });
  await waitFor(`${section('Day job')}`);
  check(true, 'a rename on another device shows up live');

  // 6. Search finds Kevin inside the collapsed group; Enter opens his chat.
  await focus(`document.querySelector('.sidebar-top [aria-label=Search]')`);
  await press('Enter');
  await waitFor(`document.querySelector('.search input') === document.activeElement`);
  await type('stu');
  await waitFor(`document.querySelector('.sidebar-scroll .bot-row-name')?.textContent === 'Stuart'`);
  check(JSON.stringify(await evalIn(`[...document.querySelectorAll('.sidebar-scroll .bot-row-name')].map((n) => n.textContent)`)) === '["Stuart"]', 'search finds Stuart in the collapsed group');
  await press('Enter');
  await waitFor(`location.hash.includes(${q(crew.Stuart.id)})`);
  check(true, 'Enter in search opens the first match (quick switch)');
  await press('Escape');
  await waitFor(`!document.querySelector('.search')`);

  // 7. New Boton in the group, from its menu.
  await choose(`${section('Day job')}.querySelector('.group-menu button')`, 'New Boton in Day job');
  await waitFor(dialogOpen('New Boton'));
  await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('It goes in the group Day job')`);
  check(true, 'New Boton in Day job: the form says where it goes');
  await type('Phil');
  await press('Enter');
  await waitFor(`!document.querySelector('dialog[open]')`, 15_000);
  const phil = (await call<Bot[]>('GET', '/api/bots')).find((b) => b.name === 'Phil');
  if (phil) crew.Phil = phil;
  check((await shape()).groups[0] === 'Day job (collapsed): Kevin, Stuart, Carl, Jerry, Dave, Phil', `Phil is made last in Day job: ${(await shape()).groups[0]}`);

  // 8. The Group row in Boton settings moves Bob into Day job by the group's id, as soon as it is picked.
  await browser.send('Page.navigate', { url: `${base}/#/m/${crew.Bob.id}` }, page);
  await waitFor(`document.querySelector('[aria-label="Boton settings"]')`);
  await evalIn(`document.querySelector('[aria-label="Boton settings"]').click(); 0`);
  const groupSelect = `document.getElementById([...document.querySelectorAll('.panel label.set-label')].find((l) => l.textContent.trim() === 'Group')?.htmlFor ?? '')`;
  await waitFor(`${groupSelect}?.tagName === 'SELECT'`);
  check(JSON.stringify(await evalIn(`[...${groupSelect}.options].map((o) => o.textContent)`)) === '["None","Day job"]', 'the Group row lists the groups by name, None first');
  await evalIn(`(() => { const s = ${groupSelect}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, s.options[1].value); s.dispatchEvent(new Event('change', { bubbles: true })); })(); 0`);
  for (let i = 0; i < 50 && !(await shape()).groups[0]?.endsWith('Phil, Bob'); i++) await sleep(100);
  check((await shape()).groups[0].endsWith('Phil, Bob'), 'picked in the Group row, with no save: Bob is last in Day job');
  // Escape closes a menu, and only the menu: the panel behind it stays.
  await focus(menuButton('Pinned', 'Bob'));
  await press('Enter');
  await waitFor(`document.querySelector('.menu:popover-open')`);
  await press('Escape');
  await waitFor(`!document.querySelector('.menu:popover-open')`);
  check((await evalIn(`!!document.querySelector('.panel')`)) && (await active()) === 'Options for Bob in Pinned', 'Escape in a menu closes the menu, not the settings panel behind it');
  await evalIn(`document.querySelector('.panel [aria-label="Close"], .panel-header [aria-label*="lose"]')?.click(); 0`);
  await waitFor(`document.querySelector('.messages')`);
  await evalIn(`window.__chatMutations = 0; new MutationObserver((m) => { window.__chatMutations += m.length; }).observe(document.querySelector('.messages'), { subtree: true, childList: true, attributes: true, characterData: true }); 0`);

  // 9. Rename, then delete the group: its Botons go to Ungrouped, none is deleted.
  await choose(`${section('Day job')}.querySelector('.group-menu button')`, 'Rename group…');
  await waitFor(dialogOpen('Rename Day job'));
  await evalIn(`document.activeElement.select(); 0`);
  await type('Crew');
  await press('Enter');
  await waitFor(`${section('Crew')}`);
  check(true, 'renamed from the group menu');
  await sleep(300);
  const quietChat = await evalIn<number>(`window.__chatMutations`);
  check(quietChat === 0, `sidebar changes (move, rename) left the open chat's DOM alone (${quietChat} mutations)`);
  const before = (await call<Bot[]>('GET', '/api/bots')).length;
  await choose(`${section('Crew')}.querySelector('.group-menu button')`, 'Delete group…');
  await waitFor(dialogOpen('Delete Crew?'));
  const said = await evalIn<string>(`document.querySelector('dialog[open] .confirm-body').textContent`);
  check(/Its 7 Botons move to Ungrouped/.test(said) && /No Boton is deleted/.test(said), `the delete dialog says what happens: "${said}"`);
  await shot('4-delete');
  await evalIn(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Delete group').click(); 0`);
  await waitFor(`!${section('Crew')} && !document.querySelector('dialog[open]')`);
  const after = await shape();
  check((await call<Bot[]>('GET', '/api/bots')).length === before && after.groups.length === 0 && after.ungrouped.length === before, `deleting the group deleted no Boton: ${after.ungrouped.join(', ')}`);
  check(JSON.stringify(after.pinned) === '["Bob","Kevin"]', 'and kept the pins');

  // 10. Drag to arrange, with a real mouse: within a group, across groups, into Ungrouped, onto a collapsed head and
  // into an empty group, into Pinned (by a drop zone that moves nothing under the pointer), the pinned order, groups;
  // Escape puts it back; a pinned tile can't leave Pinned. Another device sees each drop, and a reload keeps it.
  for (const id of (await layout()).pinned.botIds) await call('POST', `/api/sidebar/bots/${id}/pin`, { pinned: false });
  const mk = async (name: string) => (await call<{ groupId: string }>('POST', '/api/sidebar/groups', { name })).groupId;
  const work = await mk('Work');
  const play = await mk('Play');
  const empty = await mk('Empty');
  for (const n of ['Kevin', 'Stuart']) await call('POST', `/api/sidebar/bots/${crew[n].id}/move`, { groupId: work });
  await call('POST', `/api/sidebar/bots/${crew.Carl.id}/move`, { groupId: play });
  await call('PATCH', `/api/sidebar/groups/${play}`, { collapsed: true });
  for (const [i, n] of ['Bob', 'Dave', 'Jerry', 'Phil'].entries()) await call('POST', `/api/sidebar/bots/${crew[n].id}/move`, { groupId: null, index: i });
  await browser.send('Page.navigate', { url: `${base}/#/m/${crew.Bob.id}` }, page);
  await waitFor(`${section('Empty')} && document.querySelector('.messages')`);
  await evalIn(`window.__chatMutations = 0; new MutationObserver((m) => { window.__chatMutations += m.length; }).observe(document.querySelector('.messages'), { subtree: true, childList: true, attributes: true, characterData: true }); 0`);
  // The other device: a second tab with its own event stream.
  const { targetId: otherId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: other } = await browser.send('Target.attachToTarget', { targetId: otherId, flatten: true });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(base)}) localStorage.setItem('botons.deviceToken', ${JSON.stringify(token)});` }, other);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, other);
  await browser.send('Page.navigate', { url: base }, other);
  const otherShows = () => browser.eval<string>(`[...document.querySelectorAll('.sidebar-scroll section.group')].map((s) => s.getAttribute('aria-label') + ': ' + [...s.querySelectorAll('.bot-row-name, .pinned-name')].map((n) => n.textContent.trim()).join(', ')).join(' | ')`, other).catch(() => '');
  await browser.send('Target.activateTarget', { targetId }).catch(() => {});

  const dragItem = (sec: string, name: string) => `[...(${section(sec)}?.querySelectorAll('[data-drag]') ?? [])].find((el) => el.dataset.name === ${q(name)})`;
  const groupHead = (name: string) => `${section(name)}?.querySelector('[data-drag="group"]')`;
  /** A point in an element: fx and fy are fractions of its width and height. */
  const pointIn = (expr: string, fx = 0.3, fy = 0.5) =>
    evalIn<{ x: number; y: number }>(`(() => { const el = ${expr}; if (!el) throw new Error('nothing at ' + ${q(expr)}); const r = el.getBoundingClientRect(); return { x: r.x + r.width * ${fx}, y: r.y + r.height * ${fy} }; })()`);
  const mouse = (type: string, p: { x: number; y: number }, buttons: number) => browser.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 }, page);
  /** Presses on `from`, moves to `to` in steps (as a hand does), runs `during` while held, and lets go. */
  const dragMouse = async (from: string, to: () => Promise<{ x: number; y: number }>, during?: () => Promise<unknown>, end = true) => {
    const a = await pointIn(from);
    await mouse('mouseMoved', a, 0);
    await mouse('mousePressed', a, 1);
    await mouse('mouseMoved', { x: a.x + 3, y: a.y + 4 }, 1);
    await mouse('mouseMoved', { x: a.x + 6, y: a.y + 8 }, 1);
    await sleep(50);
    const b = await to();
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }, 1);
      await sleep(25);
    }
    await sleep(80);
    if (during) await during();
    if (end) await mouse('mouseReleased', b, 0);
    await sleep(60);
    return b;
  };
  const dragging = () => evalIn<boolean>(`document.documentElement.hasAttribute('data-dragging') || !!document.querySelector('.drag-ghost')`);
  const settled = async (expect: () => Promise<boolean>, what: string) => {
    const end = Date.now() + 5000;
    while (Date.now() < end && !(await expect())) await sleep(50);
    check(await expect(), what);
  };
  const groupRows = async (name: string) => (await shape()).groups.find((g) => g.startsWith(`${name}`)) ?? '';

  // a. Stuart above Kevin in Work. While held: a ghost under the pointer, his row dimmed, a line where he'd go.
  const kevinTop = await evalIn<number>(`${dragItem('Work', 'Kevin')}.getBoundingClientRect().top`);
  await dragMouse(dragItem('Work', 'Stuart'), () => pointIn(dragItem('Work', 'Kevin'), 0.3, 0.2), async () => {
    check(
      await evalIn(`document.querySelectorAll('.drag-ghost').length === 1 && document.documentElement.dataset.dragging === 'bot' && ${dragItem('Work', 'Stuart')}.hasAttribute('data-drag-source') && !document.querySelector('.drop-line').hidden`),
      'a mouse drag shows a ghost of the row, dims the row it came from, and a line where it would go',
    );
    const g = await evalIn<{ top: number; bottom: number; left: number; right: number }>(`document.querySelector('.drag-ghost').getBoundingClientRect().toJSON()`);
    const p = await pointIn(dragItem('Work', 'Kevin'), 0.3, 0.2);
    check(g.top <= p.y && p.y <= g.bottom && g.left <= p.x && p.x <= g.right, `the ghost is under the pointer (${Math.round(g.top)}–${Math.round(g.bottom)} at ${Math.round(p.y)})`);
    check((await evalIn<number>(`${dragItem('Work', 'Kevin')}.getBoundingClientRect().top`)) === kevinTop, 'starting a drag moves nothing under the pointer (the pin zone lies over the list)');
    check(await evalIn(`!!document.querySelector('.pin-zone[data-drop=pinned]')`), 'with nothing pinned, a "Drop here to pin" zone shows while a Boton is dragged');
    await shot('7-drag');
  });
  check(JSON.stringify(await rowsIn('Work')) === '["Stuart","Kevin"]', 'the drop shows at once: Stuart above Kevin in Work');
  check(!(await dragging()) && !(await evalIn(`document.querySelector('.pin-zone, [data-drag-source], .drop-line')`)), 'and the ghost, the line, the dimmed row and the pin zone are gone');
  await settled(async () => (await groupRows('Work')) === 'Work: Stuart, Kevin', 'on the server too: Work is Stuart, Kevin');
  await settled(async () => (await otherShows()).includes('Work: Stuart, Kevin'), 'and the other device shows it live');

  // b. Kevin out of Work, into Ungrouped between Bob and Dave.
  await dragMouse(dragItem('Work', 'Kevin'), () => pointIn(dragItem('Ungrouped', 'Dave'), 0.3, 0.2));
  await settled(async () => JSON.stringify((await shape()).ungrouped) === '["Bob","Kevin","Dave","Jerry","Phil"]', 'dragged across groups: Kevin second in Ungrouped');
  check(JSON.stringify(await rowsIn('Work')) === '["Stuart"]', 'and out of Work');

  // c. Jerry onto collapsed Play's head: last in it, Play stays collapsed and renders no rows.
  await dragMouse(dragItem('Ungrouped', 'Jerry'), () => pointIn(groupHead('Play'), 0.3), async () => {
    check(await evalIn(`${section('Play')}.hasAttribute('data-drop-over')`), 'over a collapsed group, the whole group lights up as the place to drop');
  });
  await settled(async () => (await groupRows('Play')) === 'Play (collapsed): Carl, Jerry', 'dropped on a collapsed group: Jerry last in Play');
  check(await evalIn(`${section('Play')}.querySelectorAll('.bot-item').length === 0 && ${toggleOf('Play')}.getAttribute('aria-expanded') === 'false'`), 'Play stays collapsed, with no rows rendered');

  // d. Dave into the empty group.
  await dragMouse(dragItem('Ungrouped', 'Dave'), () => pointIn(`${section('Empty')}.querySelector('.group-empty')`, 0.5));
  await settled(async () => (await groupRows('Empty')) === 'Empty: Dave', 'dropped into an empty group');

  // e. Stuart onto the pin zone: pinned, and still in Work.
  await dragMouse(dragItem('Work', 'Stuart'), () => pointIn(`document.querySelector('.pin-zone')`, 0.5));
  await settled(async () => JSON.stringify((await shape()).pinned) === '["Stuart"]', 'dropped on the pin zone: Stuart is pinned');
  check(JSON.stringify(await rowsIn('Work')) === '["Stuart"]', 'and stays in Work');
  // f. Phil into the pinned strip, before Stuart; g. then Stuart's tile back before Phil.
  await dragMouse(dragItem('Ungrouped', 'Phil'), () => pointIn(dragItem('Pinned', 'Stuart'), 0.2, 0.5), async () => {
    check(await evalIn(`document.querySelector('.drop-line').classList.contains('vertical')`), 'in the pinned strip the line stands between tiles');
  });
  await settled(async () => JSON.stringify((await shape()).pinned) === '["Phil","Stuart"]', 'dropped into Pinned before Stuart: Phil pinned first');
  await dragMouse(dragItem('Pinned', 'Stuart'), () => pointIn(dragItem('Pinned', 'Phil'), 0.2, 0.5));
  await settled(async () => JSON.stringify((await shape()).pinned) === '["Stuart","Phil"]', 'a pinned tile dragged left: the pinned order changes');
  // h. A pinned tile dropped on a group goes back: Unpin is in its menu.
  const before10h = JSON.stringify(await layout());
  await dragMouse(dragItem('Pinned', 'Phil'), () => pointIn(dragItem('Work', 'Stuart'), 0.3, 0.7));
  await sleep(300);
  check(JSON.stringify(await layout()) === before10h && JSON.stringify(await rowsIn('Pinned')) === '["Stuart","Phil"]', 'a pinned tile dropped outside Pinned changes nothing');

  // i. Escape while dragging puts it back, and the release after it does nothing.
  await dragMouse(dragItem('Ungrouped', 'Bob'), () => pointIn(dragItem('Work', 'Stuart'), 0.3, 0.7), async () => {
    await press('Escape');
    check(!(await dragging()), 'Escape ends the drag at once');
  }, false);
  const pointer = await pointIn(dragItem('Work', 'Stuart'), 0.3, 0.7);
  await mouse('mouseReleased', pointer, 0);
  await sleep(300);
  check(JSON.stringify(await layout()) === before10h, 'nothing moved after Escape');
  check((await evalIn<string>(`document.querySelector('.sidebar [aria-live]').textContent`)) === 'Bob put back.', 'and a screen reader hears "Bob put back."');
  check(await evalIn(`!!document.querySelector('.panel, .messages')`), 'Escape during a drag closes nothing else');

  for (const source of [groupHead('Work'), dragItem('Ungrouped', 'Bob')]) {
    const beforeCancel = JSON.stringify(await layout());
    const hashCancel = await evalIn<string>('location.hash');
    await dragMouse(source, () => pointIn(source), async () => { await press('Escape'); });
    await sleep(200);
    check(JSON.stringify(await layout()) === beforeCancel && await evalIn<string>('location.hash') === hashCancel, 'Escape then release on the source neither toggles nor opens it');
  }

  // A release lost while another app has focus must not consume the next press outside the sidebar.
  await dragMouse(groupHead('Work'), () => pointIn(groupHead('Work')), async () => {
    await evalIn(`window.dispatchEvent(new Event('blur')); 0`);
  }, false);
  const outsideClick = await evalIn<boolean>(`(() => {
    const button = document.createElement('button');
    document.body.append(button);
    button.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    button.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(click);
    button.remove();
    return !click.defaultPrevented;
  })()`);
  await mouse('mouseReleased', { x: 900, y: 100 }, 0);
  check(outsideClick, 'a new press outside the sidebar clears cancellation after a missed release');

  // j. Groups: Play's head dragged above Work.
  await dragMouse(groupHead('Play'), () => pointIn(groupHead('Work'), 0.3, 0.2), async () => {
    check(await evalIn(`document.documentElement.dataset.dragging === 'group' && !document.querySelector('.pin-zone')`), 'dragging a group by its head (and no pin zone for it)');
  });
  await settled(async () => (await shape()).groups.map((g) => g.split(':')[0]).join() === 'Play (collapsed),Work,Empty', 'a group dragged up: Play, Work, Empty');
  await settled(async () => (await otherShows()).startsWith('Pinned: Stuart, Phil | Play:  | Work: Stuart | Empty: Dave'), `the other device shows the whole arrangement: ${await otherShows()}`);

  await sleep(300);
  const dragChat = await evalIn<number>(`window.__chatMutations`);
  check(dragChat === 0, `dragging and dropping left the open chat's DOM alone (${dragChat} mutations)`);
  // A press without a move is still a click: it opens the chat.
  await dragMouse(dragItem('Empty', 'Dave'), () => pointIn(dragItem('Empty', 'Dave')), undefined, false);
  await mouse('mouseReleased', await pointIn(dragItem('Empty', 'Dave')), 0);
  await waitFor(`location.hash.includes(${q(crew.Dave.id)})`).catch(() => {});
  check(!(await evalIn(`location.hash.includes(${q(crew.Dave.id)})`)), 'a press that moved (a drag back to where it started) is not a click');
  const daveAt = await pointIn(dragItem('Empty', 'Dave'));
  await mouse('mousePressed', daveAt, 1);
  await mouse('mouseReleased', daveAt, 0);
  await waitFor(`location.hash.includes(${q(crew.Dave.id)})`);
  check(true, 'a plain click on a row still opens its chat');
  await browser.send('Page.reload', {}, page);
  await waitFor(`${section('Empty')}`);
  check(
    JSON.stringify(await rowsIn('Pinned')) === '["Stuart","Phil"]' && (await evalIn(`[...document.querySelectorAll('.sidebar-scroll section.group')].map((s) => s.getAttribute('aria-label')).join()`)) === 'Pinned,Play,Work,Empty,Ungrouped',
    'after a reload the dragged arrangement is still there',
  );
  for (const n of ['Kevin', 'Bob', 'Dave', 'Jerry']) await call('POST', `/api/sidebar/bots/${crew[n].id}/pin`, { pinned: true });
  await waitFor(`${section('Pinned')}?.querySelectorAll('[data-drag="pinned"]').length === 6`);
  await dragMouse(dragItem('Pinned', 'Stuart'), async () => {
    return pointIn(`${section('Pinned')}.querySelector('.pinned')`, 0.99);
  }, async () => { await sleep(1200); });
  await settled(async () => (await layout()).pinned.botIds.at(-1) === crew.Stuart.id, 'dragging across the overflowing pinned strip scrolls to the last tile');
  await browser.send('Target.closeTarget', { targetId: otherId });
  // Back to no groups and no pins for the phone.
  for (const id of [play, work, empty]) await call('DELETE', `/api/sidebar/groups/${id}`);
  for (const id of (await layout()).pinned.botIds) await call('POST', `/api/sidebar/bots/${id}/pin`, { pinned: false });

  // 11. A phone with a touch screen: menus are visible and open with a tap.
  await call('POST', '/api/sidebar/groups', { name: 'Home' });
  await call('POST', `/api/sidebar/bots/${crew.Dave.id}/move`, { groupId: (await layout()).groups[0].id });
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, page);
  await browser.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }, page);
  await size(390, 844, true);
  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`${section('Home')}`);
  check(await evalIn(`matchMedia('(pointer: coarse)').matches`), 'the emulated phone reports a coarse pointer');
  check(await evalIn(`[...document.querySelectorAll('.row-menu, .group-menu')].every((m) => getComputedStyle(m).opacity === '1')`), 'on touch, every row and group menu button is visible');
  const target = await evalIn<{ w: number; h: number }>(`(() => { const r = ${menuButton('Home', 'Dave')}.getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
  check(target.w >= 36 && target.h >= 36, `row menu buttons are at least 36 px to tap (${target.w}×${target.h})`);
  const toggleH = await evalIn<number>(`${toggleOf('Home')}.getBoundingClientRect().height`);
  check(toggleH >= 44, `group toggles are 44 px tall on touch (${toggleH})`);
  const at = await evalIn<{ x: number; y: number }>(`(() => { const r = ${menuButton('Home', 'Dave')}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] }, page);
  await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page);
  await waitFor(`document.querySelector('.menu:popover-open')`);
  const box = await evalIn<{ l: number; r: number; t: number; b: number }>(`(() => { const r = document.querySelector('.menu:popover-open').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`);
  check(box.l >= 0 && box.r <= 390 && box.t >= 0 && box.b <= 844, `a tap opens the menu, inside the screen (${Math.round(box.l)}–${Math.round(box.r)} × ${Math.round(box.t)}–${Math.round(box.b)})`);
  await shot('5-mobile-menu');
  const item = await evalIn<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll('.menu:popover-open [role^=menuitem]')].find((i) => i.textContent === 'Ungrouped').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [item] }, page);
  await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page);
  await waitFor(`!${section('Home')}?.textContent.includes('Dave')`);
  check((await shape()).groups.join() === 'Home: ', 'a tap on Ungrouped moves Dave out of Home');
  await focus(toggleOf('Home'));
  await shot('6-mobile');

  // 12. Touch: a swipe scrolls as usual and picks nothing up; a long press picks a Boton up, and it drops into an
  // empty group; a long press let go where it started opens nothing and moves nothing.
  for (const n of ['Tim', 'Mark', 'Norbert', 'Jorge', 'Otto', 'Mel', 'Lance', 'Donnie', 'Ken', 'Mike']) await call('POST', '/api/bots', { name: n, provider: 'mock', access: 'workspace' });
  await call('POST', `/api/sidebar/bots/${crew.Dave.id}/move`, { groupId: null, index: 0 });
  await browser.send('Page.navigate', { url: base }, page);
  await waitFor(`${section('Home')} && document.querySelectorAll('.bot-row').length >= 17`);
  await evalIn(`window.__ghosts = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('drag-ghost')) window.__ghosts++; }).observe(document.body, { childList: true }); 0`);
  const touchAt = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) => browser.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] }, page);
  const scroller = `document.querySelector('.sidebar-scroll')`;
  check((await evalIn<number>(`${scroller}.scrollHeight - ${scroller}.clientHeight`)) > 100, 'the phone list is long enough to scroll');
  // A quick swipe up from a row.
  const swipeFrom = await pointIn(dragItem('Ungrouped', 'Bob'), 0.4);
  await touchAt('touchStart', swipeFrom);
  for (let i = 1; i <= 10; i++) {
    await touchAt('touchMove', { x: swipeFrom.x, y: swipeFrom.y - i * 30 });
    await sleep(16);
  }
  await touchAt('touchEnd');
  await sleep(400);
  const scrolled = await evalIn<number>(`${scroller}.scrollTop`);
  check(scrolled > 0, `a swipe that starts on a row scrolls the list (${scrolled} px)`);
  check((await evalIn<number>(`window.__ghosts`)) === 0 && !(await dragging()), 'and picks nothing up');
  await evalIn(`${scroller}.scrollTop = 0; 0`);
  await sleep(100);
  // A long press on Dave, then a drag into the empty Home.
  const hashBefore = await evalIn<string>('location.hash');
  const from = await pointIn(dragItem('Ungrouped', 'Dave'), 0.4);
  await touchAt('touchStart', from);
  await sleep(250);
  check(!(await dragging()), 'before the long press is up, nothing is picked up');
  await sleep(400);
  check(await evalIn(`document.querySelectorAll('.drag-ghost').length === 1 && ${dragItem('Ungrouped', 'Dave')}.hasAttribute('data-drag-source')`), 'a long press picks the Boton up');
  const into = await pointIn(`${section('Home')}.querySelector('.group-empty')`, 0.5);
  for (let i = 1; i <= 10; i++) {
    await touchAt('touchMove', { x: from.x + ((into.x - from.x) * i) / 10, y: from.y + ((into.y - from.y) * i) / 10 });
    await sleep(25);
  }
  await sleep(80);
  check(await evalIn(`${section('Home')}.hasAttribute('data-drop-over') && document.querySelector('.drag-ghost').getBoundingClientRect().top < ${from.y - 40}`), 'the ghost follows the finger, and the empty group lights up under it');
  check((await evalIn<number>(`${scroller}.scrollTop`)) === 0, 'while dragging, the finger moves the Boton, not the list');
  await shot('8-touch-drag');
  await touchAt('touchEnd');
  await settled(async () => (await groupRows('Home')) === 'Home: Dave', 'by touch: Dave dropped into the empty group Home');
  check((await evalIn<string>('location.hash')) === hashBefore, 'and no chat opened');
  // A long press let go where it started.
  const before12 = JSON.stringify(await layout());
  const bobAt = await pointIn(dragItem('Ungrouped', 'Bob'), 0.4);
  await touchAt('touchStart', bobAt);
  await sleep(650);
  check(await dragging(), 'a long press on Bob picks him up');
  await touchAt('touchEnd');
  await sleep(300);
  check(!(await dragging()) && JSON.stringify(await layout()) === before12 && (await evalIn<string>('location.hash')) === hashBefore, 'let go where it started: nothing moves and no chat opens');
  // A tap still opens the chat.
  await touchAt('touchStart', bobAt);
  await touchAt('touchEnd');
  await waitFor(`location.hash.includes(${q(crew.Bob.id)})`);
  check(true, 'a tap on a row still opens its chat');
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[sidebar]', err);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[sidebar] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
