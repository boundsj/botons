// `npm run check:reactions`: emoji reactions in the real web app in headless Chrome, against a throwaway server (temp
// BOTONS_HOME, 127.0.0.1, a free port, the mock provider, no Tailscale, no real CLI). It checks that:
// - a Boton's message has a labelled React button (shown on hover and focus); the owner's messages, an approval card
//   and a card have none, and the picker's code isn't fetched until it is wanted (the full catalog not until More);
// - with the keyboard alone: the picker opens on the quick row, arrow keys move in it, Enter reacts and focus comes
//   back to the button; Escape and a click outside close it with nothing changed; More opens a search that Enter
//   picks from, and a field that takes any emoji (and refuses text, saying why); a reaction chip, a toggle button,
//   takes it off and focus moves on;
// - nothing shows before the server has it, a refused reaction (an 11th) is a toast, and the server has each change;
// - a second tab sees each change live, both ways; the Boton's reaction, made with the real `botons` CLI on a turn
//   token, shows on the owner's message with its avatar, and its unreact takes it away, live;
// - the follow-up setting: 👎 (the default) posts a follow-up chip and runs a short turn; taken off before that turn
//   starts (the Boton paused), the chip says it was withdrawn; off in Settings (by keyboard), 👎 starts nothing;
// - a reaction never touches an approval: it stays waiting;
// - after a reload, and on an older page read back through history, reactions show as they were;
// - render counts (the perf harness's hook): typing renders no message row, opening the picker none, a reaction one;
// - on an emulated phone (touch): the React button shows, a long press on a bubble opens the picker, a swipe doesn't
//   and still scrolls, a tap reacts, and the text stays selectable.
// Exits 1 with what failed. `--out <dir>` saves screenshots.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ApprovalRequestResult, Bot, Message, Settings } from '../shared/types.ts';
import { createApp } from '../server/src/app.ts';
import { approvePairingRequest, createPairingRequest } from '../server/src/auth.ts';
import { loadConfig } from '../server/src/config.ts';
import { PAGE_HOOK } from './perf-chat-budget.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'google-chrome' },
    out: { type: 'string' },
    'skip-build': { type: 'string' },
  },
});
const home = mkdtempSync(join(tmpdir(), 'botons-reactions-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[reactions]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[reactions] FAIL ${what}`);
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
const q = (s: string) => JSON.stringify(s);

async function main() {
  const webDist = opt['skip-build'] ? resolve(opt['skip-build']) : join(home, 'web-dist');
  if (!opt['skip-build']) {
    log('building web (unminified, so the render counters find message rows by name) …');
    await new Promise<void>((res, rej) => {
      const p = spawn(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', webDist, '--emptyOutDir', '--minify', 'false', '--logLevel', 'warn'], { cwd: join(root, 'web'), stdio: 'inherit' });
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

  const { secret, code } = createPairingRequest(app.store.db, 'reactions check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'reactions check' }) })).json()).token;
  const raw = async (method: string, path: string, body?: unknown, as = token) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const call = async <T = any>(method: string, path: string, body?: unknown, as = token): Promise<T> => {
    const r = await raw(method, path, body, as);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data as T;
  };
  await call('PATCH', '/api/setup', { complete: true });
  await call('PATCH', '/api/settings', { ownerName: 'Sam' });
  const kevin = await call<Bot>('POST', '/api/bots', { name: 'Kevin', provider: 'mock', access: 'workspace' });
  const messages = () => call<Message[]>('GET', `/api/bots/${kevin.id}/messages?limit=200`);
  const message = async (id: string) => (await messages()).find((m) => m.id === id) ?? app.store.findMessage(id)!;
  const reactionsOf = async (id: string) => ((await message(id)).reactions ?? []).map((r) => `${r.by}:${r.emoji}`).join(' ');
  const replyCount = () => Number((app.store.db.prepare("select count(*) as n from messages where bot_id = ? and role = 'bot'").get(kevin.id) as { n: number }).n);
  const messageCount = () => Number((app.store.db.prepare('select count(*) as n from messages where bot_id = ?').get(kevin.id) as { n: number }).n);
  const idle = async () => {
    const end = Date.now() + 15_000;
    while (Date.now() < end && (app.store.hasPendingChat(kevin.id) || app.engine.statusOf(kevin.id).state !== 'idle')) await sleep(40);
  };

  // An older history first: 240 messages, the oldest reply already reacted to, so it is on a page read back.
  const old = Date.now() - 3 * 86_400_000;
  let oldReply = '';
  for (let i = 0; i < 240; i++) {
    const m = app.store.addMessage(kevin.id, i % 2 ? 'bot' : 'user', `Older message ${i}`);
    app.store.db.prepare('update messages set created_at = ? where id = ?').run(new Date(old + i * 60_000).toISOString(), m.id);
    if (i === 1) oldReply = m.id;
  }
  await call('POST', `/api/bots/${kevin.id}/messages/${oldReply}/reactions`, { emoji: '🎉' });
  // Then a live chat: two turns, and an approval request and a card from the Boton.
  await call('POST', `/api/bots/${kevin.id}/messages`, { text: 'Draft the release notes.' });
  await idle();
  await call('POST', `/api/bots/${kevin.id}/messages`, { text: 'Now the changelog.' });
  await idle();
  const turnToken = () => app.auth.mintBotonToken(kevin.id, { sandboxed: false }).token;
  const asked = await call<ApprovalRequestResult>('POST', `/api/bots/${kevin.id}/approvals`, { title: 'Push the release branch' }, turnToken());
  const card = await raw('POST', `/api/bots/${kevin.id}/cards`, { card: { v: 1, title: 'Which notes format?', blocks: [{ type: 'choice', id: 'format', prompt: 'Pick one', options: [{ id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }] }] } }, turnToken());
  check(card.status === 201, `the Boton posted a card (${card.status} ${card.status === 201 ? '' : JSON.stringify(card.data)})`);
  const live = await messages();
  const replies = live.filter((m) => m.role === 'bot' && m.text.startsWith('Echo'));
  const owns = live.filter((m) => m.role === 'user' && !m.meta?.kind && m.text.startsWith('Draft'));
  if (replies.length < 2 || !owns.length) throw new Error(`expected two replies and the owner's message: ${live.map((m) => `${m.role}:${m.text}`).join(' | ')}`);
  const [first, last] = [replies.at(-2)!, replies.at(-1)!];
  const own = owns[0];
  const approvalEvent = live.find((m) => m.role === 'event' && m.meta?.approvalId === asked.approval.id)!;
  check((await raw('POST', `/api/bots/${kevin.id}/messages/${approvalEvent.id}/reactions`, { emoji: '👍' })).status === 400, 'the server refuses a reaction on the approval request');

  // Chrome, in its own profile.
  const chrome = spawn(opt.chrome!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(home, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--window-size=1280,900',
    // Headless Chrome has no mouse of its own (hover: none): the desktop is a mouse and a keyboard. The phone is emulated below.
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4', 'about:blank',
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
  const tab = async (hook: boolean) => {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${q(base)}) localStorage.setItem('botons.deviceToken', ${q(token)});` }, sessionId);
    if (hook) await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOK }, sessionId);
    return sessionId as string;
  };
  const page = await tab(true);
  const other = await tab(false);
  const evalIn = <T = any>(expr: string, s = page) => browser.eval<T>(expr, s);
  const waitFor = async (expr: string, ms = 10_000, s = page) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`, s).catch(() => false)) return true;
      await sleep(40);
    }
    const shown = await evalIn<string>('location.href + "\\n" + document.body.innerText.slice(-600)', s).catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  const settled = async (what: string, fn: () => Promise<boolean>, ms = 5000) => {
    const end = Date.now() + ms;
    let ok = await fn();
    while (!ok && Date.now() < end) {
      await sleep(50);
      ok = await fn();
    }
    check(ok, what);
  };
  const shot = async (name: string, s = page) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    await sleep(250);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, s);
    writeFileSync(join(resolve(opt.out), `${name}.png`), Buffer.from(data, 'base64'));
  };
  const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Escape: { code: 'Escape', keyCode: 27 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    Tab: { code: 'Tab', keyCode: 9 },
    End: { code: 'End', keyCode: 35 },
  };
  const press = async (key: string, s = page) => {
    const k = KEYS[key];
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, ...(k.text && { text: k.text }) }, s);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode }, s);
    await sleep(40);
  };
  const type = async (text: string, s = page) => {
    await browser.send('Input.insertText', { text }, s);
    await sleep(40);
  };
  const focus = (selector: string, s = page) => evalIn(`(() => { const el = ${selector}; if (!el) throw new Error('nothing to focus: ' + ${q(selector)}); el.focus(); return true; })()`, s);
  const active = (s = page) => evalIn<string>(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.textContent.trim()) : ''; })()`, s);
  /** The message row whose bubble shows exactly this text. */
  const rowOf = (text: string) => `[...document.querySelectorAll('.messages .msg')].find((r) => r.querySelector('.bubble')?.textContent.trim() === ${q(text)})`;
  const chipsIn = (text: string, s = page) => evalIn<string>(`[...(${rowOf(text)}?.querySelectorAll('.reaction') ?? [])].map((c) => (c.classList.contains('mine') ? 'owner:' : 'Boton:') + c.textContent.trim()).join(' ')`, s);
  const pickerOpen = (s = page) => evalIn<boolean>(`!!document.querySelector('.reaction-picker:popover-open')`, s);
  const loaded = (name: string, s = page) => evalIn<boolean>(`performance.getEntriesByType('resource').some((e) => e.name.includes('/assets/${name}'))`, s);
  const rows = () => evalIn<number>(`(window.__perf.renders.MessageView ?? 0)`);
  const resetPerf = () => evalIn(`window.__perf.reset()`);
  const axName = async (expr: string, s = page): Promise<string> => {
    const { result } = await browser.send('Runtime.evaluate', { expression: expr }, s);
    const { nodes } = await browser.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false }, s);
    return String(nodes[0]?.name?.value ?? '');
  };
  /** Where to point at an element: scrolled into view first (the chat may have opened at its first unread message). */
  const center = async (expr: string, s = page) =>
    evalIn<{ x: number; y: number }>(`(() => { const el = ${expr}; if (!el.closest('.reaction-picker')) el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, s);
  const click = async (expr: string, s = page) => {
    const p = await center(expr, s);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, s);
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s);
    await sleep(60);
  };

  // The first tab in front: a background tab runs no transitions and takes no touches.
  const front = () => browser.send('Page.bringToFront', {}, page);
  const chat = `${base}/#/m/${kevin.id}`;
  for (const s of [page, other]) await browser.send('Page.navigate', { url: chat }, s);
  for (const s of [page, other]) await waitFor(`${rowOf(last.text)}`, 10_000, s);
  await front();

  // 1. Where the React button is, and isn't; nothing of the picker loaded yet.
  const lastRow = rowOf(last.text);
  const reactBtn = `${lastRow}.querySelector('.msg-react')`;
  check(await evalIn(`!!${reactBtn}`), "the Boton's reply has a React button");
  check((await axName(reactBtn)) === "React to Kevin's message" && (await evalIn(`${reactBtn}.getAttribute('aria-haspopup') === 'dialog' && ${reactBtn}.getAttribute('aria-expanded') === 'false'`)), `its name is "${await axName(reactBtn)}", with aria-haspopup=dialog and aria-expanded`);
  check(await evalIn(`!${rowOf(own.text)}.querySelector('.msg-react')`), "the owner's own message has none");
  check(await evalIn(`!document.querySelector('.approval-card .msg-react, .approval-card .reaction, .tcard .msg-react, .tcard .reaction')`), 'the approval card (and any card) has no reaction control at all');
  check(!(await loaded('ReactionPicker')) && !(await loaded('emoji-catalog')), "the picker's code and the catalog aren't fetched with the chat");
  const hidden = await evalIn<string>(`getComputedStyle(${reactBtn}).opacity`);
  check(hidden === '0', `the React button is hidden until hover or focus (opacity ${hidden}; hover: ${await evalIn(`matchMedia('(hover: hover)').matches`)})`);
  await center(`${lastRow}.querySelector('.bubble')`);
  await sleep(200);
  const hoverAt = await center(`${lastRow}.querySelector('.bubble')`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverAt.x, y: hoverAt.y }, page);
  await sleep(250);
  const shown = await evalIn<string>(`getComputedStyle(${reactBtn}).opacity`);
  check(shown === '1', `hovering the message shows it (opacity ${shown}; hovered: ${await evalIn(`[...document.querySelectorAll(':hover')].map((e) => e.className).join(' > ')`)}; at ${JSON.stringify(hoverAt)})`);
  await shot('1-hover');

  // 2. The keyboard: open, arrows, Enter; render counts on the way.
  await focus(reactBtn);
  await sleep(100);
  await resetPerf();
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  check((await rows()) === 0, `opening the picker rendered ${await rows()} message rows (0)`);
  check(await loaded('ReactionPicker'), "the picker's code is fetched when it is wanted");
  check(!(await loaded('emoji-catalog')), 'the full catalog is not');
  check((await axName(`document.querySelector('.reaction-picker')`)) === "React to Kevin's message" && (await evalIn(`document.querySelector('.reaction-picker').getAttribute('role') === 'dialog'`)), 'the picker is a dialog named for the message');
  check((await evalIn(`${reactBtn}.getAttribute('aria-expanded')`)) === 'true', 'the button says it is expanded');
  check((await active()) === '👍' && (await evalIn(`document.activeElement.closest('[role=toolbar]')?.getAttribute('aria-label') === 'Quick reactions'`)), 'focus starts on 👍 in the "Quick reactions" toolbar');
  check(JSON.stringify(await evalIn(`[...document.querySelectorAll('.quick-reactions .emoji-btn')].map((b) => b.textContent)`)) === JSON.stringify(['👍', '❤️', '😂', '🎉', '👀', '🙏']), 'the quick row is 👍 ❤️ 😂 🎉 👀 🙏');
  check((await evalIn(`[...document.querySelectorAll('.quick-reactions .emoji-btn')].filter((b) => b.tabIndex === 0).length`)) === 1, 'the quick row is one tab stop');
  check(/👎 also asks for a short follow-up/.test(await evalIn<string>(`document.querySelector('.reaction-note').textContent`)), 'the picker says which reactions ask for a follow-up');
  await shot('2-picker');
  await press('ArrowRight');
  check((await active()) === '❤️', 'ArrowRight moves to ❤️');
  await resetPerf();
  await press('Enter');
  await settled('Enter reacts ❤️: the server has it', async () => (await reactionsOf(last.id)) === 'owner:❤️');
  await waitFor(`${lastRow}.querySelector('.reaction.mine')`);
  check(!(await pickerOpen()), 'and the picker closes');
  check((await active()) === "React to Kevin's message", 'focus goes back to the React button');
  check((await chipsIn(last.text)) === 'owner:❤️', 'the chip shows under the reply');
  const chip = `${lastRow}.querySelector('.reaction.mine')`;
  check((await evalIn(`${chip}.getAttribute('aria-pressed')`)) === 'true' && (await axName(chip)) === '❤️' && (await evalIn(`${lastRow}.querySelector('.reactions').getAttribute('aria-label')`)) === 'Your reactions', 'the chip is a pressed toggle in a "Your reactions" group');
  check((await rows()) === 1, `a reaction rendered ${await rows()} message row (1: its own)`);
  await waitFor(`${rowOf(last.text)}?.querySelector('.reaction.mine')`, 5000, other);
  check((await chipsIn(last.text, other)) === 'owner:❤️', 'the second tab shows it live');

  // Escape and a click outside close it, with nothing changed.
  await focus(reactBtn);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await press('Escape');
  await sleep(100);
  check(!(await pickerOpen()) && (await active()) === "React to Kevin's message", 'Escape closes it and focus goes back');
  await click(reactBtn);
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await click(`document.querySelector('.day-sep')`);
  await sleep(150);
  check(!(await pickerOpen()), 'a click outside closes it');
  check((await reactionsOf(last.id)) === 'owner:❤️', 'with nothing changed');
  // The button again while open closes it, and doesn't reopen.
  await click(reactBtn);
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await click(reactBtn);
  await sleep(150);
  check(!(await pickerOpen()), 'its button again closes it');

  // 3. More: search, Enter picks the first match; any emoji typed; text refused.
  await focus(reactBtn);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await focus(`document.querySelector('.reaction-more')`);
  await press('Enter');
  await waitFor(`document.querySelector('.emoji-grid')`);
  check(await loaded('emoji-catalog'), 'More fetches the catalog');
  check((await active()) === 'Search emoji', 'and focus goes to its search');
  check((await evalIn<number>(`document.querySelectorAll('.emoji-grid .emoji-btn').length`)) >= 300 && (await evalIn<number>(`document.querySelectorAll('.emoji-grid .emoji-btn[tabindex="0"]').length`)) === 1, 'the grid holds the catalog, one tab stop');
  await shot('3-full-picker');
  await type('party');
  await waitFor(`document.querySelector('.emoji-grid .emoji-btn')?.textContent === '🥳' || document.querySelector('.emoji-grid .emoji-btn')?.textContent === '🎉'`);
  check(/emoji found/.test(await evalIn<string>(`document.querySelector('.full-picker [role=status]').textContent`)), 'the number found is announced');
  const firstFound = await evalIn<string>(`document.querySelector('.emoji-grid .emoji-btn').textContent`);
  await press('Enter');
  await settled(`Enter in the search reacts with the first match (${firstFound})`, async () => (await reactionsOf(last.id)) === `owner:❤️ owner:${firstFound}`);
  // Arrow keys in the grid.
  await focus(reactBtn);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await focus(`document.querySelector('.reaction-more')`);
  await press('Enter');
  await waitFor(`document.querySelector('.emoji-grid .emoji-btn')`);
  await press('ArrowDown');
  const gridFirst = await active();
  await press('ArrowRight');
  const gridSecond = await active();
  await press('ArrowDown');
  const below = await evalIn<boolean>(`(() => { const b = document.activeElement.getBoundingClientRect(); return b.top > 0; })()`);
  check(gridFirst === '😀' && gridSecond === '😃' && below && (await active()) !== gridSecond, `arrow keys move in the grid (${gridFirst} → ${gridSecond} → ${await active()})`);
  // Any emoji: text is refused, an emoji the catalog doesn't have is taken.
  await focus(`document.querySelector('.emoji-own input')`);
  await type('ok');
  await press('Enter');
  await waitFor(`document.querySelector('.emoji-own [role=alert]')`);
  check(/One emoji, with no text/.test(await evalIn<string>(`document.querySelector('.emoji-own [role=alert]').textContent`)) && (await evalIn(`document.querySelector('.emoji-own input').getAttribute('aria-invalid')`)) === 'true', 'text in the any-emoji field is refused, saying why');
  await evalIn(`(() => { const i = document.querySelector('.emoji-own input'); i.select(); return 0; })()`);
  await type('🦖');
  await press('Enter');
  await settled('a typed emoji the catalog lacks (🦖) reacts', async () => (await reactionsOf(last.id)).endsWith('owner:🦖'));

  // 4. A chip takes its reaction off; focus moves on.
  await waitFor(`${lastRow}.querySelectorAll('.reaction.mine').length === 3`);
  await focus(`${lastRow}.querySelector('.reaction.mine')`);
  await press('Enter');
  await settled('a chip takes its reaction off (❤️ gone on the server)', async () => !(await reactionsOf(last.id)).includes('❤️'));
  await waitFor(`${lastRow}.querySelectorAll('.reaction.mine').length === 2`);
  check((await active()) === firstFound, `focus moves on to the chip beside it (${await active()})`);
  await waitFor(`${rowOf(last.text)}.querySelectorAll('.reaction.mine').length === 2`, 5000, other);
  check(true, 'the second tab sees it gone live');
  // From the second tab, the other way: the first tab follows.
  await focus(`${rowOf(last.text)}.querySelector('.reaction.mine')`, other);
  await press('Enter', other);
  await waitFor(`${lastRow}.querySelectorAll('.reaction.mine').length === 1`);
  check(true, 'a reaction taken off in the second tab goes in the first, live');

  // 5. The server refuses an 11th: a toast, and nothing changes.
  for (const e of ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂']) await call('POST', `/api/bots/${kevin.id}/messages/${last.id}/reactions`, { emoji: e });
  await waitFor(`${lastRow}.querySelectorAll('.reaction.mine').length === 10`);
  await focus(reactBtn);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await press('End');
  await press('Enter');
  await waitFor(`[...document.querySelectorAll('.toast')].some((t) => /At most 10 reactions/.test(t.textContent))`);
  check((await evalIn<number>(`${lastRow}.querySelectorAll('.reaction.mine').length`)) === 10, 'an 11th is refused with a toast that says why, and nothing shows that the server lacks');
  for (const r of (await message(last.id)).reactions ?? []) await call('DELETE', `/api/bots/${kevin.id}/messages/${last.id}/reactions/${encodeURIComponent(r.emoji)}`);
  await waitFor(`!${lastRow}.querySelector('.reaction')`);

  // 6. The Boton, with the real CLI on a turn token: shows with its avatar, live, and unreacts.
  // Run as a turn runs it (asynchronously: the server is in this process).
  const boton = (...args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((res) =>
      execFile(process.execPath, [join(root, 'server/src/cli/botons.ts'), ...args], { env: { PATH: process.env.PATH, BOTONS_API: base, BOTON_BOT_ID: kevin.id, BOTON_TOKEN: turnToken() }, encoding: 'utf8' }, (err, stdout, stderr) =>
        res({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      ),
    );
  const reacted = await boton('react', own.id, '👍');
  check(reacted.status === 0 && /Reacted 👍/.test(reacted.stdout), `botons react: ${(reacted.stdout || reacted.stderr).trim()}`);
  for (const s of [page, other]) await waitFor(`${rowOf(own.text)}?.querySelector('.reaction.theirs')`, 5000, s);
  const theirs = `${rowOf(own.text)}.querySelector('.reaction.theirs')`;
  check((await axName(theirs)) === 'Kevin reacted 👍' && (await evalIn(`!!${theirs}.querySelector('svg')`)), `the Boton's reaction shows on the owner's message with its avatar, named "${await axName(theirs)}", in both tabs`);
  check(await evalIn(`${theirs}.tagName !== 'BUTTON'`), 'and the owner can’t take it off');
  const refusedOnOwn = await boton('react', last.id, '👍');
  check(refusedOnOwn.status !== 0, 'the CLI refuses a reaction on the Boton’s own message');
  await shot('4-boton-reaction');
  const unreacted = await boton('unreact', own.id);
  check(unreacted.status === 0, `botons unreact: ${(unreacted.stdout || unreacted.stderr).trim()}`);
  for (const s of [page, other]) await waitFor(`!${rowOf(own.text)}?.querySelector('.reaction')`, 5000, s);
  check(true, 'its unreact takes it away live, in both tabs');

  // 7. Follow-ups. Paused, a 👎 waits: its chip, then taken off, withdrawn.
  check(JSON.stringify((await call<Settings>('GET', '/api/settings')).reactionFollowUps) === '["👎"]', 'follow-ups default to 👎 alone');
  await call('POST', `/api/bots/${kevin.id}/pause`);
  await sleep(200);
  const turnsBefore = replyCount();
  await call('POST', `/api/bots/${kevin.id}/messages/${first.id}/reactions`, { emoji: '👎' });
  await waitFor(`document.querySelector('.reaction-followup')`);
  const chipText = () => evalIn<string>(`[...document.querySelectorAll('.reaction-followup')].at(-1).textContent`);
  check(/You reacted 👎: Kevin follows up/.test(await chipText()) && (await chipText()).includes('Echo'), `the follow-up chip names the reaction and quotes the message: "${await chipText()}"`);
  await waitFor(`${rowOf(first.text)}.querySelector('.reaction.mine')`);
  await focus(`${rowOf(first.text)}.querySelector('.reaction.mine')`);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-followup.withdrawn')`);
  check(/You took off 👎 before Kevin followed up: no follow-up/.test(await chipText()), `taken off before its turn: "${await chipText()}"`);
  await waitFor(`document.querySelector('.reaction-followup.withdrawn')`, 5000, other);
  check(true, 'the second tab shows it withdrawn too');
  await shot('5-follow-up-withdrawn');
  await call('POST', `/api/bots/${kevin.id}/resume`);
  await sleep(400);
  await idle();
  check(replyCount() === turnsBefore, 'a withdrawn follow-up ran no turn, resumed');
  // Not paused: 👎 runs a short turn.
  await focus(`${rowOf(last.text)}.querySelector('.msg-react')`);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  await focus(`document.querySelector('.reaction-more')`);
  await press('Enter');
  await waitFor(`document.querySelector('.emoji-search')`);
  await type('thumbs down');
  await waitFor(`document.querySelector('.emoji-grid .emoji-btn')?.textContent === '👎'`);
  check((await axName(`document.querySelector('.emoji-grid .emoji-btn')`)) === '👎, asks for a follow-up', 'a follow-up emoji says so in its name');
  await press('Enter');
  await settled('👎 runs a follow-up turn: a new reply', async () => replyCount() === turnsBefore + 1, 15_000);
  // Off, in Settings, by keyboard: 👎 starts nothing.
  await focus(`document.querySelector('[aria-label=Settings]')`);
  await press('Enter');
  await waitFor(`document.querySelector('.settings-nav [data-section="appearance"]')`);
  await focus(`document.querySelector('.settings-nav [data-section="appearance"]')`);
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-settings')`);
  check(/never answers an approval or a card/.test(await evalIn<string>(`document.querySelector('.reaction-settings').textContent`)), 'Settings explains reactions: feedback, no turn, no push, never an approval');
  await evalIn(`document.querySelector('.reaction-settings').scrollIntoView({ block: 'center' })`);
  await shot('6-settings');
  await focus(`[...document.querySelectorAll('.reaction-settings button')].find((b) => b.textContent === 'Turn follow-ups off')`);
  await press('Enter');
  await settled('Turn follow-ups off saves []', async () => JSON.stringify((await call<Settings>('GET', '/api/settings')).reactionFollowUps) === '[]');
  await waitFor(`document.querySelector('.reaction-settings').textContent.includes('No reaction asks for a follow-up')`);
  await focus(`document.querySelector('.reaction-settings [aria-label="Add 😕"]')`);
  await press('Enter');
  await settled('+ 😕 adds it', async () => JSON.stringify((await call<Settings>('GET', '/api/settings')).reactionFollowUps) === '["😕"]');
  await focus(`document.querySelector('.follow-up-add input')`);
  await type('nope');
  await press('Enter');
  await waitFor(`document.querySelector('.reaction-settings [role=alert]')`);
  check(JSON.stringify((await call<Settings>('GET', '/api/settings')).reactionFollowUps) === '["😕"]', 'text is refused there too, saying why, and nothing is saved');
  await focus(`document.querySelector('[aria-label="Stop 😕 asking for a follow-up"]')`);
  await press('Enter');
  await settled('its ✕ takes it off', async () => JSON.stringify((await call<Settings>('GET', '/api/settings')).reactionFollowUps) === '[]');
  await press('Escape');
  await waitFor(`!document.querySelector('dialog[open]')`);
  const before = messageCount();
  await call('DELETE', `/api/bots/${kevin.id}/messages/${last.id}/reactions/${encodeURIComponent('👎')}`);
  await call('POST', `/api/bots/${kevin.id}/messages/${first.id}/reactions`, { emoji: '😕' });
  await call('POST', `/api/bots/${kevin.id}/messages/${last.id}/reactions`, { emoji: '👎' });
  await sleep(600);
  await idle();
  check(messageCount() === before && app.engine.statusOf(kevin.id).state === 'idle', 'with follow-ups off, 👎 posts nothing and starts no turn');
  await call('PATCH', '/api/settings', { reactionFollowUps: ['👎'] });

  // 8. The approval is untouched by all of it.
  check((await call('GET', `/api/approvals/${asked.approval.id}`)).status === 'pending', 'the approval request is still waiting after every reaction');

  // 9. Reload, and an older page read back.
  await browser.send('Page.reload', {}, page);
  await waitFor(`${rowOf(last.text)}?.querySelector('.reaction.mine')`);
  check((await chipsIn(last.text)) === 'owner:👎' && (await chipsIn(first.text)) === 'owner:😕', 'after a reload, reactions show as the server has them');
  const scroller = `document.querySelector('.messages')`;
  for (let i = 0; i < 30 && !(await evalIn(`!!${rowOf('Older message 1')}`)); i++) {
    await evalIn(`(() => { const b = document.querySelector('.load-earlier:not(:disabled)'); if (b) b.click(); else ${scroller}.scrollTop = 0; return 0; })()`);
    await sleep(300);
  }
  await waitFor(`${rowOf('Older message 1')}`);
  check((await chipsIn('Older message 1')) === 'owner:🎉', 'an older page read back shows its reaction');

  // 10. Typing renders no message row.
  await evalIn(`${scroller}.scrollTop = ${scroller}.scrollHeight`);
  await focus(`document.querySelector('.composer textarea')`);
  await resetPerf();
  for (const ch of 'typing here') await type(ch);
  check((await rows()) === 0, `typing rendered ${await rows()} message rows (0)`);
  await evalIn(`(() => { const t = document.querySelector('.composer textarea'); t.select(); return 0; })()`);
  await press('Escape');

  // 11. An emulated phone: touch.
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, page);
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, page);
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] }, page);
  await browser.send('Page.reload', {}, page);
  await front();
  await waitFor(`${rowOf(first.text)}`);
  await evalIn(`${scroller}.scrollTop = ${scroller}.scrollHeight`);
  await sleep(300);
  const firstRow = rowOf(first.text);
  check(Number(await evalIn<string>(`getComputedStyle(${firstRow}.querySelector('.msg-react')).opacity`)) > 0.4, 'on a touch screen the React button shows without hover');
  const tapTarget = await evalIn<{ w: number; h: number }>(`(() => { const r = ${firstRow}.querySelector('.msg-react').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
  check(tapTarget.w >= 24 && tapTarget.h >= 24, `its target is ${tapTarget.w}×${tapTarget.h} (at least 24×24)`);
  check((await evalIn<string>(`getComputedStyle(${firstRow}.querySelector('.bubble')).userSelect`)) !== 'none', 'the bubble text stays selectable');
  const touch = (type: string, p?: { x: number; y: number }) =>
    Promise.race([
      browser.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] }, page),
      sleep(5000).then(() => {
        throw new Error(`${type} at ${JSON.stringify(p)} had no answer`);
      }),
    ]);
  const at = await center(`${firstRow}.querySelector('.bubble')`);
  // A swipe: scrolls, and opens nothing.
  const top0 = await evalIn<number>(`${scroller}.scrollTop`);
  await touch('touchStart', at);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', { x: at.x, y: at.y + i * 25 });
    await sleep(30);
  }
  await touch('touchEnd');
  await sleep(700);
  check(!(await pickerOpen()), 'a swipe over a bubble opens no picker');
  check((await evalIn<number>(`${scroller}.scrollTop`)) !== top0, 'and still scrolls the chat');
  await evalIn(`${scroller}.scrollTop = ${scroller}.scrollHeight`);
  await sleep(300);
  // A long press opens it.
  const at2 = await center(`${firstRow}.querySelector('.bubble')`);
  await touch('touchStart', at2);
  await sleep(250);
  check(!(await pickerOpen()), 'before the long press is up, nothing opens');
  await sleep(450);
  check(await pickerOpen(), 'a long press on a bubble opens the picker');
  await touch('touchEnd');
  await sleep(150);
  const fits = await evalIn<boolean>(`(() => { const r = document.querySelector('.reaction-picker').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`);
  check(fits, 'the picker fits on the phone screen');
  await shot('7-phone-picker');
  const heart = await center(`[...document.querySelectorAll('.quick-reactions .emoji-btn')].find((b) => b.textContent === '🙏')`);
  await touch('touchStart', heart);
  await touch('touchEnd');
  await settled('a tap on 🙏 reacts', async () => (await reactionsOf(first.id)).includes('owner:🙏'));
  await waitFor(`${firstRow}.querySelectorAll('.reaction.mine').length === 2`);
  // Full picker on the phone fits too.
  const btnAt = await center(`${firstRow}.querySelector('.msg-react')`);
  await touch('touchStart', btnAt);
  await touch('touchEnd');
  await waitFor(`document.querySelector('.reaction-picker:popover-open')`);
  const moreAt = await center(`document.querySelector('.reaction-more')`);
  await touch('touchStart', moreAt);
  await touch('touchEnd');
  await waitFor(`document.querySelector('.emoji-grid .emoji-btn')`);
  await sleep(200);
  check(await evalIn<boolean>(`(() => { const r = document.querySelector('.reaction-picker').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`), 'the full picker fits on the phone screen');
  check((await evalIn<string>(`document.activeElement?.className`)) !== 'emoji-search', 'on a touch screen More doesn’t focus the search (no keyboard over the grid)');
  check((await evalIn<number>(`parseFloat(getComputedStyle(document.querySelector('.emoji-search')).fontSize)`)) >= 16, 'its fields are 16px, so a phone doesn’t zoom in on them');
  await shot('8-phone-full-picker');
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[reactions]', err);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[reactions] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
