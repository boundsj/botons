// `npm run check:timestamps`: when each chat message was sent, in the real web app in headless Chrome against a
// throwaway server (temp BOTONS_HOME, 127.0.0.1, a free port, the mock provider, no Tailscale, no real CLI), with the
// browser in a zone of its own (Asia/Kolkata, half an hour off the hour) and a chat spanning several days. It checks that:
// - a centred divider marks each day in the browser's zone (the date, Yesterday, Today), with a `<time>` for the day,
//   once per day, the first message loaded included;
// - a quiet time sits above the first message of each burst (a new day, or after a pause of over 30 minutes) and
//   nowhere else; a routine run's chip (here a webhook's) shows its own time instead;
// - on the desktop, hovering a message shows its exact date and time inline and a click doesn't pin it; the bubble's
//   tooltip stays; each message's time is a `<time datetime>` in the accessibility tree;
// - after Load earlier the days and bursts are worked out again over the window: still one divider a day, and the
//   row in view stays put though the burst time above it goes;
// - typing renders no message row (the perf harness's hook), and a tap re-renders only the row tapped;
// - on an emulated phone (touch): the exact time is out of sight but still read by a screen reader, a tap on a
//   message shows it inline and a second tap hides it, a tap on a button in the row doesn't, and nothing overflows.
// Exits 1 with what failed. `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Bot } from '../shared/types.ts';
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
const home = mkdtempSync(join(tmpdir(), 'botons-timestamps-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[timestamps]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[timestamps] FAIL ${what}`);
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

  const { secret, code } = createPairingRequest(app.store.db, 'timestamps check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'timestamps check' }) })).json()).token;
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
  const ZONE = 'Asia/Kolkata';
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: ZONE }, page);
  const evalIn = <T = any>(expr: string) => browser.eval<T>(expr, page);
  const waitFor = async (expr: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`).catch(() => false)) return true;
      await sleep(40);
    }
    const shown = await evalIn<string>('location.href + "\\n" + document.body.innerText.slice(-600)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  const shot = async (name: string) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    await sleep(250);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
    writeFileSync(join(resolve(opt.out), `${name}.png`), Buffer.from(data, 'base64'));
  };

  // The chat's days, in the browser's zone: three days ago (more than a page of it, so Load earlier has some to read),
  // yesterday (two bursts: 9:00 and, after a 55-minute pause, 10:00), and today (a webhook's routine run, then a chat).
  // Kolkata is 5:30 ahead of UTC all year (Chrome may name it Asia/Calcutta).
  const offset = await evalIn<number>('new Date().getTimezoneOffset()');
  check(offset === -330, `the browser is in ${ZONE} (offset ${offset} minutes)`);
  const at = (days: number, h: number, mi: number) => evalIn<string>(`(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + ${days}, ${h}, ${mi}).toISOString(); })()`);
  const put = (role: 'user' | 'bot' | 'event', text: string, iso: string, meta: any = null) => {
    const m = app.store.addMessage(kevin.id, role, text, meta);
    app.store.db.prepare('update messages set created_at = ? where id = ?').run(iso, m.id);
    return { ...m, createdAt: iso };
  };
  const OLDER = 180;
  const older = [];
  for (let i = 0; i < OLDER; i++) older.push(put(i % 2 ? 'bot' : 'user', `Older message ${i}`, await at(-3, 8, i)));
  const y1 = put('user', 'Morning, Kevin', await at(-1, 9, 0));
  const y2 = put('bot', 'Morning, Sam', await at(-1, 9, 5));
  const y3 = put('user', 'After the pause', await at(-1, 10, 0));
  const y4 = put('bot', 'Still the same burst', await at(-1, 10, 20));
  const now = Date.now();
  const run = put('event', 'Ran routine', new Date(now - 180_000).toISOString(), { kind: 'routine.run', routineId: 'rt_check', routineName: 'Deploy watch', trigger: 'webhook' });
  const t1 = put('user', 'Anything new today?', new Date(now - 120_000).toISOString());
  const t2 = put('bot', 'The deploy went out.', new Date(now - 60_000).toISOString());
  const card = put('event', 'Review details', new Date(now - 30_000).toISOString(), { kind: 'card.posted', card: {
    descriptor: { v: 1, title: 'Review details', blocks: [{ type: 'form', id: 'details', fields: [{ id: 'note', label: 'Note', kind: 'text' }] }] },
    status: 'pending', expiresAt: new Date(now + 3600_000).toISOString(),
    from: { trigger: 'chat', routineId: null, routineName: null, runId: null, sandboxed: false },
  } });
  // Mark it read, so the chat opens at the newest message.
  await call('POST', `/api/bots/${kevin.id}/read`).catch(() => {});

  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => evalIn<string>(`new Date(${q(iso)}).toLocaleString([], ${JSON.stringify(o)})`);
  const clockOf = (iso: string) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
  const exactOf = (iso: string) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dayOf = (iso: string) => evalIn<string>(`(() => { const d = new Date(${q(iso)}); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  const olderLabel = await evalIn<string>(`(() => { const d = new Date(${q(older[0].createdAt)}); return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }); })()`);

  const rowOf = (text: string) => `[...document.querySelectorAll('.messages .msg')].find((r) => r.querySelector('.bubble')?.textContent.trim() === ${q(text)})`;
  /** What sits in the chat in order: day dividers, burst times and rows, as kind:text. */
  const marks = () =>
    evalIn<string[]>(
      `[...document.querySelector('.messages-inner').children].flatMap((el) => el.classList.contains('day-sep') ? ['day:' + el.textContent + '@' + el.querySelector('time')?.getAttribute('datetime')] : el.classList.contains('burst-time') ? ['time:' + el.textContent + '@' + el.getAttribute('datetime')] : el.classList.contains('msg') ? ['msg:' + (el.querySelector('.bubble')?.textContent.trim() ?? '')] : el.querySelector('.event-chip') ? ['chip:' + el.querySelector('.event-chip').textContent.trim()] : [])`,
    );
  const center = (expr: string) => evalIn<{ x: number; y: number }>(`(() => { const el = ${expr}; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const timeOf = (text: string) => `${rowOf(text)}.querySelector('.msg-time')`;
  const opacity = async (text: string) => Number(await evalIn<string>(`getComputedStyle(${timeOf(text)}).opacity`));
  const axHas = async (expr: string, want: string) => {
    const { result } = await browser.send('Runtime.evaluate', { expression: expr }, page);
    const { nodes } = await browser.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: true }, page);
    return (nodes as any[]).some((n) => !n.ignored && String(n.name?.value ?? '').includes(want));
  };
  const rows = () => evalIn<number>(`(window.__perf.renders.MessageView ?? 0) + (window.__perf.renders.BotonMessage ?? 0)`);

  await browser.send('Page.bringToFront', {}, page);
  await browser.send('Page.navigate', { url: `${base}/#/m/${kevin.id}` }, page);
  await waitFor(rowOf(t2.text));
  await sleep(300);

  // 1. Days and bursts over the window loaded (the latest 100: 93 of the older day, yesterday, today).
  const seen = await marks();
  const days = seen.filter((s) => s.startsWith('day:'));
  const expectDays = [`day:${olderLabel}@${await dayOf(older[0].createdAt)}`, `day:Yesterday@${await dayOf(y1.createdAt)}`, `day:Today@${await dayOf(t1.createdAt)}`];
  check(JSON.stringify(days) === JSON.stringify(expectDays), `one divider a day, in order: ${days.join(' | ')}`);
  const firstLoaded = seen.find((s) => s.startsWith('msg:'))!.slice(4);
  const firstOld = older.find((m) => m.text === firstLoaded)!;
  check(!!firstOld && seen.indexOf(`time:${await clockOf(firstOld.createdAt)}@${firstOld.createdAt}`) === seen.indexOf(`msg:${firstLoaded}`) - 1, `the first message loaded (${firstLoaded}) has its time above it`);
  const times = seen.filter((s) => s.startsWith('time:'));
  check(times.length === 3, `three burst times, no more: ${times.join(' | ')}`);
  const before = (text: string) => seen[seen.indexOf(`msg:${text}`) - 1];
  check(before(y1.text) === `time:${await clockOf(y1.createdAt)}@${y1.createdAt}`, `yesterday's first burst starts with its time (${before(y1.text)})`);
  check(before(y2.text) === `msg:${y1.text}`, 'five minutes on: no time');
  check(before(y3.text) === `time:${await clockOf(y3.createdAt)}@${y3.createdAt}`, `after a 55-minute pause a new burst gets its time (${before(y3.text)})`);
  check(before(y4.text) === `msg:${y3.text}`, 'twenty minutes on: no time');
  const chipAt = seen.findIndex((s) => s.startsWith('chip:') && s.includes('Deploy watch'));
  check(chipAt > 0 && seen[chipAt - 1].startsWith('day:Today'), `today's run chip comes right after its day, with no burst time above it (${seen[chipAt - 1]})`);
  const chipTime = await evalIn<{ text: string; dt: string }>(`(() => { const t = [...document.querySelectorAll('.event-chip')].find((c) => c.textContent.includes('Deploy watch')).querySelector('time.chip-time'); return t && { text: t.textContent, dt: t.getAttribute('datetime') }; })()`);
  check(chipTime?.text === (await clockOf(run.createdAt)) && chipTime?.dt === run.createdAt, `the webhook's run chip shows its own time (${chipTime?.text})`);
  check(before(t1.text).startsWith('chip:'), 'today’s first message, a minute after the chip, gets no time of its own');
  const dayStyle = await evalIn<{ lines: boolean; centred: boolean }>(`(() => { const d = document.querySelector('.day-sep'), t = d.querySelector('time').getBoundingClientRect(), p = d.getBoundingClientRect(); return { lines: getComputedStyle(d, '::before').content !== 'none' && getComputedStyle(d, '::after').content !== 'none', centred: Math.abs((t.left + t.width / 2) - (p.left + p.width / 2)) < 2 }; })()`);
  check(dayStyle.lines && dayStyle.centred, 'the day divider is centred between two rules');
  await shot('1-desktop-days');

  // 2. The desktop: hover shows the exact time inline; a click doesn't pin it; the tooltip stays.
  check((await opacity(y3.text)) === 0, 'a message’s exact time is out of sight until wanted');
  const exact = await evalIn<{ text: string; dt: string }>(`(() => { const t = ${timeOf(y3.text)}; return { text: t.textContent, dt: t.getAttribute('datetime') }; })()`);
  check(exact.text === (await exactOf(y3.createdAt)) && exact.dt === y3.createdAt, `it is a <time datetime> with the date and time (${exact.text})`);
  check(await axHas(timeOf(y3.text), exact.text), 'and a screen reader reads it');
  const title = await evalIn<string>(`${rowOf(y3.text)}.querySelector('.bubble').title`);
  check(title.startsWith(await exactOf(y3.createdAt)), `the bubble's tooltip stays (${title})`);
  const p = await center(`${rowOf(y3.text)}.querySelector('.bubble')`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, page);
  await sleep(300);
  check((await opacity(y3.text)) === 1, 'hovering the message shows it');
  await shot('2-desktop-hover');
  await evalIn('window.__perf.reset()');
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, page);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, page);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, page);
  await sleep(300);
  check(!(await evalIn<boolean>(`${rowOf(y3.text)}.classList.contains('show-time')`)) && (await opacity(y3.text)) === 0, 'a mouse click doesn’t keep it shown, and moving away hides it');
  check((await rows()) === 0, `a click renders no row (${await rows()})`);

  // 3. Typing renders no message row.
  await evalIn(`document.querySelector('.composer textarea').focus()`);
  await evalIn('window.__perf.reset()');
  for (const ch of 'what time was that?') {
    await browser.send('Input.insertText', { text: ch }, page);
    await sleep(15);
  }
  await sleep(200);
  check((await rows()) === 0, `typing 19 characters renders no message row (${await rows()})`);
  await evalIn(`(() => { const t = document.querySelector('.composer textarea'); t.select(); document.execCommand('delete'); return 0; })()`);

  // 4. Load earlier: the days and bursts again, over the longer window.
  // Scrolled up to the first message loaded: the chat reads the page before by itself (or the button does).
  const topOf = (text: string) => evalIn<number>(`${rowOf(text)}.getBoundingClientRect().top`);
  // Its burst time at the very top, so it is the first thing in view.
  await evalIn(`(() => { document.querySelector('.messages-inner .burst-time').scrollIntoView({ block: 'start' }); return 0; })()`);
  await sleep(50);
  const held = await topOf(firstLoaded);
  await evalIn(`document.querySelector('.load-earlier:not(:disabled)')?.click()`);
  await waitFor(rowOf(older[0].text));
  await sleep(200);
  // Its burst time went with the page added (a time is never what holds the place): the row stays where it was.
  const drift = Math.abs((await topOf(firstLoaded)) - held);
  check(drift < 2, `the message that was first stays in place as the page is added (moved ${drift.toFixed(1)}px)`);
  const paged = await marks();
  const pagedDays = paged.filter((s) => s.startsWith('day:'));
  check(JSON.stringify(pagedDays) === JSON.stringify(expectDays), `after Load earlier, still one divider a day (${pagedDays.length})`);
  const pagedTimes = paged.filter((s) => s.startsWith('time:'));
  check(pagedTimes.length === 3 && pagedTimes[0] === `time:${await clockOf(older[0].createdAt)}@${older[0].createdAt}`, `the older day's time moves to its first message, and only that (${pagedTimes.join(' | ')})`);
  check(paged.filter((s) => s.startsWith('msg:')).length === OLDER + 6, `every message loaded (${paged.filter((s) => s.startsWith('msg:')).length})`);

  // 5. An emulated phone.
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, page);
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, page);
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] }, page);
  await evalIn(`document.querySelector('.messages').scrollTop = document.querySelector('.messages').scrollHeight`);
  await sleep(400);
  const box = (text: string) => evalIn<{ w: number; h: number; right: number }>(`(() => { const r = ${timeOf(text)}.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; })()`);
  check((await box(t2.text)).w <= 1, 'on a phone the exact time takes no room until a tap');
  check(await axHas(timeOf(t2.text), await exactOf(t2.createdAt)), 'and a screen reader still reads it');
  const touch = (type: string, pt?: { x: number; y: number }) => browser.send('Input.dispatchTouchEvent', { type, touchPoints: pt ? [{ x: pt.x, y: pt.y, id: 1 }] : [] }, page);
  const tap = async (expr: string) => {
    const pt = await center(expr);
    await touch('touchStart', pt);
    await sleep(60);
    await touch('touchEnd');
    await sleep(250);
  };
  await evalIn('window.__perf.reset()');
  await tap(`${rowOf(t2.text)}.querySelector('.bubble')`);
  const shown = await box(t2.text);
  check((await evalIn<boolean>(`${rowOf(t2.text)}.classList.contains('show-time')`)) && shown.w > 40 && (await opacity(t2.text)) === 1, `a tap on the Boton's message shows its exact time inline (${Math.round(shown.w)}px wide)`);
  check(shown.right <= 390, 'inside the screen');
  check((await rows()) === 1, `the tap re-renders only that row (${await rows()})`);
  await tap(`${rowOf(t1.text)}.querySelector('.bubble')`);
  check((await opacity(t1.text)) === 1 && (await box(t1.text)).w > 40, 'a tap on the owner’s message shows its time too');
  await shot('3-phone-tapped');
  await tap(`${rowOf(t2.text)}.querySelector('.bubble')`);
  check((await box(t2.text)).w <= 1, 'a second tap hides it');
  await tap(`${rowOf(t2.text)}.querySelector('.msg-react')`);
  check(!(await evalIn<boolean>(`${rowOf(t2.text)}.classList.contains('show-time')`)), 'a tap on the React button doesn’t show it');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page);
  check((await evalIn<number>(`document.querySelector('.messages').scrollWidth - document.querySelector('.messages').clientWidth`)) <= 0, 'nothing overflows the chat sideways');
  const runRow = "[...document.querySelectorAll('.timed-row')].find(r => r.textContent.includes('Deploy watch'))";
  await tap(runRow + ".querySelector('.event-chip > span')");
  check(await evalIn(runRow + ".classList.contains('show-time')"), 'a tap reveals the webhook chip exact time');
  check(await evalIn(runRow + ".querySelector('.msg-time').textContent") === await exactOf(run.createdAt), 'the chip reveals its full date and time');
  check(await axHas(runRow + ".querySelector('.msg-time')", await exactOf(run.createdAt)), 'the chip exact time is accessible');
  const cardRow = "document.querySelector('.tcard').closest('.timed-row')";
  await tap(cardRow + ".querySelector('h3')");
  check(await evalIn(cardRow + ".classList.contains('show-time')"), 'a tap reveals the card exact time');
  check(await evalIn(cardRow + ".querySelector('.msg-time').getAttribute('datetime')") === card.createdAt, 'the card time has its datetime');
  await tap(cardRow + ".querySelector('h3')");
  await tap(cardRow + ".querySelector('input')");
  await browser.send('Input.insertText', { text: 'Ready' }, page);
  check(await evalIn(cardRow + ".querySelector('input').value") === 'Ready', 'the card field still accepts input');
  check(!await evalIn(cardRow + ".classList.contains('show-time')"), 'using a card field does not toggle its time');
  await shot('4-phone');
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[timestamps]', err);
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[timestamps] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
