// `npm run perf:chat -- --out <dir>`: measure the chat view in headless Chrome against a
// throwaway server seeded with a synthetic 1000-message chat. Nothing here touches a real install:
// a temp BOTONS_HOME, 127.0.0.1, a free port, the mock provider and no Tailscale.
//
// It reports, for the same workload each run:
// - React commits and rendered message rows per keystroke in the composer (a DevTools-style hook
//   counts the components that did work in each commit; no change to the app is needed);
// - input latency per keystroke (keydown to the frame after it), at full speed and at 4x CPU throttling;
// - time to open the chat (first open, which fetches, and cached reopens);
// - JS heap (after a forced GC), DOM nodes and listeners, and the renderer process's RSS/PSS from /proc,
//   with the first page loaded, after reading back to the oldest message, after reading forward to the
//   newest again, and after 50 chat switches (then again after a critical memory-pressure signal); optional heap snapshots (--snapshots);
// - reading through the history: the rows on the page, how far the row being read moves as pages are
//   added or let go (should be 0), a message arriving while reading back, and Jump to latest;
// - live messages into a window at its size, read near the top and near the bottom: the rows held (on the
//   page and in React's tree), how far the row being read moves, which end goes, and Jump to latest after;
// - the renderer's floor: a small chat, and a blank tab in its own renderer;
// - with --soak-minutes N, memory sampled each minute while the chats are switched, read back and
//   forward and a Boton keeps writing, appended to <label>-soak.jsonl as it goes; --soak-mode switch|read|live|idle
//   does only one of those, to tell which one grows.
//
// Every result records where it came from: the commit, the working tree's changes, a hash of the app's
// source and of the built files, Chrome and Node. --app-source <dir> builds the web app from another
// tree (say an export of main) against this server and harness, for a before/after on one fixture.
//
// The web app is built unminified (--minify false) so component names survive; React itself is its production build.
// The render counters find message rows by name, so --skip-build needs such a build too: --budget fails when they found none.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/src/app.ts';
import { approvePairingRequest, createPairingRequest } from '../server/src/auth.ts';
import { loadConfig } from '../server/src/config.ts';
import { history } from '../web/src/state.ts';
import { PAGE_HOOK, overBudget } from './perf-chat-budget.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    out: { type: 'string' },
    label: { type: 'string', default: 'run' },
    chrome: { type: 'string', default: process.env.CHROME_BIN || (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome') },
    keys: { type: 'string', default: '40' },
    messages: { type: 'string', default: '1000' },
    reopens: { type: 'string', default: '5' },
    snapshots: { type: 'boolean', default: false },
    budget: { type: 'boolean', default: false },
    headful: { type: 'boolean', default: false },
    'skip-build': { type: 'string' },
    'app-source': { type: 'string' },
    'soak-minutes': { type: 'string', default: '0' },
    'soak-mode': { type: 'string', default: 'all' },
    'skip-standard': { type: 'boolean', default: false },
  },
});
if (!opt.out) {
  console.error('usage: node scripts/perf-chat.ts --out <dir> [--label name] [--keys 40] [--messages 1000] [--snapshots] [--budget] [--chrome path] [--skip-build <built web dir>] [--soak-minutes N [--soak-mode all|switch|read|live|idle]]');
  process.exit(2);
}
const out = resolve(opt.out);
mkdirSync(out, { recursive: true });
const KEYS = Number(opt.keys);
const SOAK_MINUTES = Number(opt['soak-minutes']);
const SOAK_MODES = ['all', 'switch', 'read', 'live', 'idle'] as const;
const SOAK_MODE = opt['soak-mode'] as (typeof SOAK_MODES)[number];
if (!SOAK_MODES.includes(SOAK_MODE)) {
  console.error(`--soak-mode is one of ${SOAK_MODES.join(', ')}`);
  process.exit(2);
}
const appSource = resolve(opt['app-source'] ?? root);
const MESSAGES = Number(opt.messages);
const home = mkdtempSync(join(tmpdir(), 'botons-perf-'));
process.env.BOTONS_LOG_LEVEL = 'error';
const log = (...a: unknown[]) => console.log('[perf]', ...a);

// ---------- deterministic fixture ----------

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = 'the Boton checked routine report deploy queue branch build test schedule memory workspace file summary review change error log metric latency cache index request server client session token page chart backlog'.split(' ');

function sentence(r: () => number, n: number) {
  const w = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
}

/** `n` counts bot messages only, so every kind comes up in turn. */
function botMarkdown(r: () => number, i: number, n: number) {
  const kind = n % 4;
  const para = () => Array.from({ length: 3 + Math.floor(r() * 4) }, () => sentence(r, 8 + Math.floor(r() * 10))).join(' ');
  if (kind === 0) return `## Summary ${i}\n\n${para()}\n\n- ${sentence(r, 6)}\n- **${sentence(r, 4)}** ${sentence(r, 7)}\n- \`npm run build\` ${sentence(r, 5)}\n\n${para()}`;
  if (kind === 1)
    return `${para()}\n\n\`\`\`ts\n${Array.from({ length: 14 }, (_, k) => `export function step${i}_${k}(input: string): number {\n  return input.length * ${k} + ${Math.floor(r() * 100)};\n}`).join('\n')}\n\`\`\`\n\n${para()}`;
  if (kind === 2)
    return `| Item | Status | Owner | Notes |\n| --- | --- | --- | --- |\n${Array.from({ length: 8 }, (_, k) => `| task-${i}-${k} | ${r() > 0.5 ? 'done' : 'open'} | Kevin | ${sentence(r, 5)} |`).join('\n')}\n\n${para()}\n\n> ${sentence(r, 12)}`;
  return `${para()}\n\n1. ${sentence(r, 6)}\n2. ${sentence(r, 6)}\n3. [A link](https://example.com/${i}) ${sentence(r, 4)}\n\n${para()}\n\n${para()}`;
}

function seed(db: DatabaseSync, store: ReturnType<typeof createApp>['store'], botId: string, count: number, base: number, seedN: number) {
  const r = rng(seedN);
  const ids: string[] = [];
  let bots = 0;
  for (let i = 0; i < count; i++) {
    let m;
    if (i % 10 === 9) {
      m = i % 20 === 9
        ? store.addMessage(botId, 'event', 'Ran routine', { kind: 'routine.run', routineId: 'rt_fixture', routineName: 'Morning briefing', trigger: 'schedule' })
        : store.addMessage(botId, 'event', 'Saved to memory', { kind: 'memory.saved', memoryText: sentence(r, 9) });
    } else if (i % 2 === 0) {
      m = store.addMessage(botId, 'user', `${sentence(r, 6 + Math.floor(r() * 20))} (#${i})`);
    } else {
      m = store.addMessage(botId, 'bot', `${botMarkdown(r, i, bots++)}\n\nmarker-${botId}-${i}`, { durationMs: 4200, model: 'mock-model', ...(i % 3 === 0 && { steps: 3 }) });
    }
    ids.push(m.id);
    // Three minutes apart, so day separators and grouping appear the same every run.
    db.prepare('update messages set created_at = ?, pending = 0 where id = ?').run(new Date(base + i * 180_000).toISOString(), m.id);
  }
  db.prepare('update bots set last_activity_at = ?, read_seq = (select max(seq) from messages where bot_id = ?) where id = ?').run(new Date(base + count * 180_000).toISOString(), botId, botId);
}

// ---------- CDP ----------

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #handlers = new Map<string, ((p: any) => void)[]>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
        else p?.resolve(msg.result);
      } else for (const h of this.#handlers.get(msg.method) ?? []) h(msg.params);
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
  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  on(method: string, h: (p: any) => void) {
    this.#handlers.set(method, [...(this.#handlers.get(method) ?? []), h]);
  }
  off(method: string) {
    this.#handlers.delete(method);
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  close() {
    this.#ws.close();
  }
}

// ---------- run ----------

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, median: r1(q(0.5)), p95: r1(q(0.95)), max: r1(s.at(-1) ?? 0), mean: r1(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
};

const cleanups: (() => void)[] = [];

async function main() {
  // The app, built unminified into the temp home.
  let webDist = opt['skip-build'] ? resolve(opt['skip-build']) : join(home, 'web-dist');
  if (!opt['skip-build']) {
    log('building web (unminified) …');
    await new Promise<void>((res, rej) => {
      const p = spawn(join(root, 'node_modules/.bin/vite'), ['build', '--minify', 'false', '--outDir', webDist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(appSource, 'web'), stdio: 'inherit' });
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
  const base = `http://127.0.0.1:${port}`;
  const { secret, code } = createPairingRequest(app.store.db, 'perf');
  approvePairingRequest(app.store.db, code);
  const paired = await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'perf' }) })).json();
  const token: string = paired.token;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setup = await call('PATCH', '/api/setup', { complete: true });
  // A placeholder owner, so nothing from this machine's account shows up in the page.
  await call('PATCH', '/api/settings', { ownerName: 'Sam' });
  if (!setup.ok) throw new Error(`setup: ${setup.status} ${await setup.text()}`);
  for (const [name, description] of [['standup', 'Write the daily standup'], ['summarize', 'Summarize a thread'], ['ship', 'Ship a change'], ['sweep', 'Sweep the backlog']])
    await call('POST', '/api/skills', { name, description, body: `Do ${name}.` });

  const ids = app.providers.ids();
  const kevin = app.store.createBot({ name: 'Kevin', provider: 'mock' }, ids, 'mock');
  const stuart = app.store.createBot({ name: 'Stuart', provider: 'mock' }, ids, 'mock');
  const t0 = Date.UTC(2026, 0, 5, 9, 0, 0);
  seed(app.store.db, app.store, kevin.id, MESSAGES, t0, 56);
  seed(app.store.db, app.store, stuart.id, 20, t0 + MESSAGES * 180_000 + 60_000, 7);
  log(`server ${base}, Kevin has ${MESSAGES} messages`);

  // Chrome, in its own profile.
  const profile = join(home, 'chrome');
  const chrome = spawn(opt.chrome, [
    ...(opt.headful ? [] : ['--headless=new']),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--window-size=1280,900', '--js-flags=--expose-gc', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  cleanups.push(() => chrome.kill('SIGKILL'));
  const wsUrl = await new Promise<string>((res, rej) => {
    let buf = '';
    chrome.stderr!.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) res(m[1]);
    });
    chrome.on('exit', (c) => rej(new Error(`chrome exited ${c}: ${buf}`)));
  });
  const browser = await Cdp.connect(wsUrl);
  const version = await browser.send('Browser.getVersion');
  const devtools = new URL(wsUrl);
  const targets = await (await fetch(`http://${devtools.host}/json/list`)).json();
  const pageTarget = targets.find((t: any) => t.type === 'page');
  const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Performance.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('botons.deviceToken', ${JSON.stringify(token)});\n${PAGE_HOOK}` });

  const frame = () => page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page.eval(`!!(${expr})`)) return;
      await sleep(25);
    }
    const seen = await page.eval<string>('location.href + "\\n" + document.body.innerText.slice(0, 600)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${seen}`);
  };
  const marker = (botId: string, i: number) => `marker-${botId}-${i}`;
  // The newest bot message (the fixture's bot messages are the odd ones that are not events).
  const lastBotOf = (count: number) => {
    let i = count - 1;
    while (i > 0 && (i % 2 === 0 || i % 10 === 9)) i--;
    return i;
  };
  const lastBotIdx = lastBotOf(MESSAGES);

  await page.send('Page.navigate', { url: `${base}/#/m/${stuart.id}` });
  await waitFor(`document.querySelector('.chat textarea') && document.body.innerText.includes(${JSON.stringify(marker(stuart.id, lastBotOf(20)))})`);
  await frame();

  // Which renderer is this page's: the one whose CPU time grows while the page spins.
  const cpuOf = async () => new Map(((await browser.send('SystemInfo.getProcessInfo')).processInfo as { type: string; id: number; cpuTime: number }[]).filter((p) => p.type === 'renderer').map((p) => [p.id, p.cpuTime]));
  const before = await cpuOf();
  await page.eval('(() => { const end = performance.now() + 400; while (performance.now() < end); return 0; })()');
  const after = await cpuOf();
  const rendererPid = [...after].map(([pid, t]) => [pid, t - (before.get(pid) ?? 0)] as const).sort((a, b) => b[1] - a[1])[0][0];

  const results: any = {
    label: opt.label,
    provenance: await provenance(webDist, version.product),
    chrome: version.product,
    mode: opt.headful ? 'headful' : 'headless=new',
    viewport: '1280x900 @1x',
    fixture: { messages: MESSAGES, seed: 56, pageSize: 100 },
    keysPerCondition: KEYS,
  };

  // Opening the chat: the click to two frames after its last message is on screen.
  const openOnce = async () => {
    await page.eval(`window.__openStart = performance.now(); [...document.querySelectorAll('.bot-row')].find((b) => b.textContent.includes('Kevin')).click(); 0`);
    await page.eval(`new Promise((res) => { const tick = () => { if (document.querySelector('.chat')?.innerText.includes(${JSON.stringify(marker(kevin.id, lastBotIdx))})) requestAnimationFrame(() => requestAnimationFrame(() => res(0))); else requestAnimationFrame(tick); }; tick(); })`);
    return page.eval<number>('performance.now() - window.__openStart');
  };
  const backToStuart = async () => {
    await page.eval(`[...document.querySelectorAll('.bot-row')].find((b) => b.textContent.includes('Stuart')).click(); 0`);
    await waitFor(`document.querySelector('.chat')?.innerText.includes(${JSON.stringify(marker(stuart.id, lastBotOf(20)))})`);
    await frame();
  };
  await page.eval('__perf.reset()');
  const first = await openOnce();
  const firstOpenRenders = await page.eval('({ commits: __perf.commits, rows: __perf.renders.MessageView || 0 })');
  const reopens: number[] = [];
  for (let i = 0; i < Number(opt.reopens); i++) {
    await backToStuart();
    reopens.push(await openOnce());
  }
  results.open = { firstMs: Math.round(first), firstRenders: firstOpenRenders, reopenMs: stats(reopens) };
  log('open', results.open);

  const memory = async (name: string) => {
    await sleep(1500);
    await page.send('HeapProfiler.enable');
    await page.send('HeapProfiler.collectGarbage');
    await page.send('HeapProfiler.collectGarbage');
    const heap = await page.send('Runtime.getHeapUsage');
    const metrics = Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((m: any) => [m.name, m.value]));
    const domNodes = await page.eval<number>("document.getElementsByTagName('*').length");
    const rows = await page.eval<number>("document.querySelectorAll('.messages-inner > .msg, .messages-inner > .event-chip, .messages-inner > .timed-row').length");
    const procs = await processMemory(browser, rendererPid);
    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    const m = {
      rowsInDom: rows,
      domElements: domNodes,
      jsHeapUsedMB: mb(heap.usedSize),
      jsHeapTotalMB: mb(heap.totalSize),
      cdpNodes: metrics.Nodes,
      cdpJsEventListeners: metrics.JSEventListeners,
      processes: procs,
    };
    if (opt.snapshots) {
      const file = join(out, `${opt.label}-${name}.heapsnapshot`);
      const ws = createWriteStream(file);
      page.on('HeapProfiler.addHeapSnapshotChunk', (p) => ws.write(p.chunk));
      await page.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      page.off('HeapProfiler.addHeapSnapshotChunk');
      await new Promise((r) => ws.end(r));
      (m as any).snapshot = file;
    }
    log('memory', name, JSON.stringify(m));
    return m;
  };

  // Typing in the composer: one key, then the frames after it, then the next.
  const typing = async (throttle: number, text: string) => {
    await page.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.eval(`document.querySelector('.chat textarea').focus(); 0`);
    await frame();
    await page.eval('__perf.reset()');
    for (const ch of text) {
      const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === ' ' ? 'Space' : ch === '/' ? 'Slash' : '';
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code });
      await frame();
      await sleep(20);
    }
    await frame();
    const p = await page.eval<any>('({ commits: __perf.commits, renders: __perf.renders, latencies: __perf.latencies, longTasks: __perf.longTasks, longTaskMs: __perf.longTaskMs })');
    const value = await page.eval<string>(`document.querySelector('.chat textarea').value`);
    // Clear the draft for the next condition.
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, commands: ['selectAll'] });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await frame();
    const n = text.length;
    const top = Object.entries(p.renders as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
      cpuThrottle: throttle,
      keys: n,
      typedOk: value === text,
      commitsPerKey: Math.round((p.commits / n) * 100) / 100,
      messageRowsRenderedPerKey: Math.round(((p.renders.MessageView ?? 0) / n) * 100) / 100,
      markdownRenderedPerKey: Math.round(((p.renders.Markdown ?? 0) / n) * 100) / 100,
      componentsRenderedPerKey: Math.round((Object.values(p.renders as Record<string, number>).reduce((a, b) => a + b, 0) / n) * 10) / 10,
      topRenders: Object.fromEntries(top),
      latencyMs: stats(p.latencies),
      longTasks: p.longTasks,
      longTaskMs: Math.round(p.longTaskMs),
    };
  };
  const phrase = (n: number) => 'the quick brown fox jumps over the lazy dog and keeps typing '.repeat(4).slice(0, n);

  // ---------- reading through the history ----------

  const rowSel = `.messages-inner > .msg, .messages-inner > .event-chip, .messages-inner > .timed-row`;
  const scroller = `document.querySelector('.messages')`;
  const rowsInDom = () => page.eval<number>(`document.querySelectorAll(${JSON.stringify(rowSel)}).length`);
  /** Tag the first row in view and return its offset from the top of the chat. */
  const probe = (scrollTo: 'top' | 'bottom') =>
    page.eval<number | null>(`(() => {
      const s = ${scroller};
      s.scrollTop = ${scrollTo === 'top' ? '0' : 's.scrollHeight'};
      const top = s.getBoundingClientRect().top;
      document.querySelectorAll('[data-probe], [data-edge-row]').forEach((e) => { delete e.dataset.probe; delete e.dataset.edgeRow; });
      const rows = s.querySelectorAll(${JSON.stringify(rowSel)});
      const edge = rows[${scrollTo === 'top' ? '0' : 'rows.length - 1'}];
      if (edge) edge.dataset.edgeRow = '1';
      const r = [...rows].find((e) => e.getBoundingClientRect().bottom > top);
      if (!r) return null;
      r.dataset.probe = '1';
      return r.getBoundingClientRect().top - top;
    })()`);
  const probeNow = () => page.eval<number | null>(`(() => { const r = document.querySelector('[data-probe]'); return r ? r.getBoundingClientRect().top - ${scroller}.getBoundingClientRect().top : null; })()`);
  /**
   * One page back (scrolled to the top) or forward (to the bottom, in a window that doesn't reach the newest):
   * scrolling there loads it; the row that was in view must stay where it was.
   */
  const step = async (dir: 'back' | 'forward') => {
    const btn = dir === 'back' ? '.load-earlier' : '.load-later';
    if (!(await page.eval<boolean>(`!!document.querySelector('${btn}')`))) return null;
    const before = await probe(dir === 'back' ? 'top' : 'bottom');
    await frame();
    const edgeIdx = dir === 'back' ? '0' : 'rows.length - 1';
    // Scrolling there may have loaded it already; if not, the button does.
    await page.eval(`(() => { const rows = document.querySelectorAll(${JSON.stringify(rowSel)}); if (rows[${edgeIdx}]?.dataset.edgeRow) document.querySelector('${btn}:not(:disabled)')?.click(); return 0; })()`);
    await waitFor(`(() => { const rows = document.querySelectorAll(${JSON.stringify(rowSel)}); return (!rows[${edgeIdx}]?.dataset.edgeRow || !document.querySelector('${btn}')) && !document.querySelector('${btn}:disabled'); })()`);
    await frame();
    await frame();
    const after = await probeNow();
    // The last page can be empty (the history is a whole number of pages): only the button goes, and at the very top
    // or bottom there is no room to hold the row still.
    const added = await page.eval<boolean>(`(() => { const rows = document.querySelectorAll(${JSON.stringify(rowSel)}); return !rows[${edgeIdx}]?.dataset.edgeRow; })()`);
    return { drift: before === null || after === null ? null : Math.round((after - before) * 10) / 10, added, rows: await rowsInDom() };
  };
  const readThrough = async (dir: 'back' | 'forward') => {
    const start = Date.now();
    const drifts: (number | null)[] = [];
    const emptyPageDrifts: (number | null)[] = [];
    let maxRows = await rowsInDom();
    for (let i = 0; i < 60; i++) {
      const r = await step(dir);
      if (!r) break;
      (r.added ? drifts : emptyPageDrifts).push(r.drift);
      maxRows = Math.max(maxRows, r.rows);
    }
    const moved = drifts.filter((d): d is number => d !== null).map(Math.abs);
    return { drifts, emptyPageDrifts, pages: drifts.length, ms: Date.now() - start, maxRowsInDom: maxRows, rowsInDomAtEnd: await rowsInDom(), maxDriftPx: moved.length ? Math.max(...moved) : 0, rowsLost: drifts.filter((d) => d === null).length };
  };
  const atBottom = () => page.eval<boolean>(`(() => { const s = ${scroller}; return s.scrollHeight - s.scrollTop - s.clientHeight < 2; })()`);
  const latestShown = (botId: string, i: number) => `document.querySelector('.chat')?.innerText.includes(${JSON.stringify(marker(botId, i))})`;

  // The renderer's floor: a small chat, and a blank tab in a renderer of its own.
  await backToStuart();
  results.floor = { smallChat20: await memory('small-chat-20'), smallChatAllocators: await allocators(browser, rendererPid), blankTab: await blankTab(browser) };
  await openOnce();

  if (SOAK_MINUTES > 0) {
    results.soak = await soak();
    return finish();
  }

  results.loaded100 = {
    memory: await memory('idle-100'),
    typing: { desktop: await typing(1, phrase(KEYS)), cpu4x: await typing(4, phrase(KEYS)) },
    skillPicker: await typing(1, '/s' + 'ummarize'.slice(0, Math.max(0, Math.min(8, KEYS - 2)))),
  };
  log('loaded100 typing', JSON.stringify(results.loaded100.typing));

  // Read back to the oldest message, page by page, the way scrolling to the top does; then forward to the newest.
  results.readBack = await readThrough('back');
  results.loadAllMs = results.readBack.ms;
  await waitFor(latestShown(kevin.id, 1));
  results.readBack.oldestShown = true;
  results.readBack.newestStillInDom = await page.eval<boolean>(latestShown(kevin.id, lastBotIdx));
  results.readBack.memory = await memory('top-1000');
  results.readBack.allocators = await allocators(browser, rendererPid);
  log('read back', JSON.stringify({ ...results.readBack, memory: undefined }));
  results.readForward = await readThrough('forward');
  await page.eval(`${scroller}.scrollTop = ${scroller}.scrollHeight; 0`);
  await waitFor(latestShown(kevin.id, lastBotIdx));
  await frame();
  results.readForward.newestShown = true;
  results.readForward.oldestStillInDom = await page.eval<boolean>(latestShown(kevin.id, 1));
  log('read forward', JSON.stringify(results.readForward));

  // At the bottom after reading all 1000, where people type.
  results.loaded1000 = {
    memory: await memory('long-1000'),
    typing: { desktop: await typing(1, phrase(KEYS)), cpu4x: await typing(4, phrase(KEYS)) },
  };
  log('loaded1000 typing', JSON.stringify(results.loaded1000.typing));
  results.loaded1000.memoryAfterTyping = await memory('after-typing-1000');

  // One turn: send from the composer, the Boton queues, works and replies (the mock provider, slowed
  // down so the status changes reach the page). Sending clears the composer.
  await page.eval(`document.querySelector('.chat textarea').focus(); 0`);
  for (const ch of 'hi SLOW_PLEASE:600') {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  await frame();
  await page.eval('__perf.reset()');
  await page.eval(`document.querySelector('.send-btn').click(); 0`);
  await waitFor(`document.querySelector('.chat textarea').value === '' && [...document.querySelectorAll('.msg.user .plain')].some((p) => p.textContent === 'hi SLOW_PLEASE:600')`, 10_000);
  await waitFor(`[...document.querySelectorAll('.msg.bot')].some((p) => p.textContent.includes('Echo: hi SLOW_PLEASE:600')) && !document.querySelector('.msg.typing')`, 15_000);
  await frame();
  results.turn = await page.eval('({ commits: __perf.commits, messageRowsRendered: __perf.renders.MessageView || 0, markdownRendered: __perf.renders.Markdown || 0 })');
  results.sendClearsComposer = true;
  log('turn', JSON.stringify(results.turn));

  // A message arriving while reading back three pages, then Jump to latest (the pill).
  for (let i = 0; i < 3; i++) (await step('back')) ?? (await probe('top'));
  await frame();
  const liveText = `live-while-reading-back`;
  app.store.addMessage(kevin.id, 'bot', liveText);
  await waitFor(`document.querySelector('.new-pill')`, 5000);
  await sleep(300);
  const reading = {
    rowsInDom: await rowsInDom(),
    liveInDomWhileBack: await page.eval<boolean>(`document.querySelector('.chat').innerText.includes(${JSON.stringify(liveText)})`),
    pill: await page.eval<string>(`document.querySelector('.new-pill').textContent`),
    loadNewerShown: await page.eval<boolean>(`!!document.querySelector('.load-later')`),
  };
  const jumpStart = Date.now();
  await page.eval(`document.querySelector('.new-pill').click(); 0`);
  await waitFor(`document.querySelector('.chat').innerText.includes(${JSON.stringify(liveText)})`, 5000);
  const endJump = Date.now() + 3000;
  while (!(await atBottom()) && Date.now() < endJump) await frame();
  results.jumpToLatest = {
    ...reading,
    ms: Date.now() - jumpStart,
    liveShownAfter: true,
    atBottomAfter: await atBottom(),
    pillGoneAfter: await page.eval<boolean>(`!document.querySelector('.new-pill')`),
    rowsInDomAfter: await rowsInDom(),
    focusAfter: await page.eval<string>(`document.activeElement?.tagName.toLowerCase() ?? ''`),
  };
  log('jump to latest', JSON.stringify(results.jumpToLatest));

  results.liveWindow = await liveWindow();
  log('live window', JSON.stringify(results.liveWindow));

  // 50 switches between the two chats, ending on the small one: what the long one keeps while not on screen.
  const switchMs: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t = Date.now();
    await backToStuart();
    await openOnce();
    switchMs.push(Date.now() - t);
  }
  await backToStuart();
  results.switches = { count: 50, pairMs: stats(switchMs), memory: await memory('after-50-switches') };
  // Freed pages stay in the renderer until something asks for them back: what a critical memory-pressure signal returns.
  await page.send('Memory.simulatePressureNotification', { level: 'critical' });
  results.switches.afterPressure = await memory('after-50-switches-pressure');
  results.switches.afterPressureAllocators = await allocators(browser, rendererPid);
  log('switches', JSON.stringify({ pairMs: results.switches.pairMs }));
  await openOnce();

  // What the composer must keep doing: the skill picker picks with the keyboard, another Boton's
  // chat starts with an empty composer, and an idea in an empty chat fills the composer.
  const press = async (key: string, code: string, vk: number) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  const textarea = `document.querySelector('.chat textarea')`;
  await page.eval(`${textarea}.focus(); 0`);
  for (const ch of '/su') await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
  await waitFor(`[...document.querySelectorAll('.skill-picker [role=option]')].map((o) => o.textContent).join() === '/summarizeSummarize a thread'`);
  await press('Enter', 'Enter', 13);
  await waitFor(`${textarea}.value === '/summarize ' && !document.querySelector('.skill-picker')`);
  await backToStuart();
  await waitFor(`${textarea}.value === ''`);
  const bob = app.store.createBot({ name: 'Bob', provider: 'mock' }, ids, 'mock');
  await waitFor(`[...document.querySelectorAll('.bot-row')].some((b) => b.textContent.includes('Bob'))`);
  await page.eval(`[...document.querySelectorAll('.bot-row')].find((b) => b.textContent.includes('Bob')).click(); 0`);
  await waitFor(`location.hash === '#/m/${bob.id}' && document.querySelector('.idea')`);
  const idea = await page.eval<string>(`(() => { const b = document.querySelector('.idea'); b.click(); return b.textContent; })()`);
  await waitFor(`${textarea}.value === ${JSON.stringify(idea)}`);
  results.behaviour = { skillPickerPicks: true, draftClearsOnSwitch: true, ideaFillsComposer: true };
  log('behaviour ok');

  return finish();

  /**
   * Live messages into a window at its size that reaches the newest message, with the owner reading above the
   * bottom: near the top (the newest are let go and the window reads forward again from there, so Jump to latest
   * reads the newest page) and near the bottom (the oldest are let go and the messages show). The row being read
   * must stay where it is and the chat hold no more than its window, on the page and in React's tree.
   */
  async function liveWindow() {
    const textarea = `document.querySelector('.chat textarea')`;
    const mounted = () => page.eval<number>(`__perf.mounted('MessageView')`);
    const has = (sel: string) => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
    const shows = (text: string) => page.eval<boolean>(`document.querySelector('.chat').innerText.includes(${JSON.stringify(text)})`);
    /** Read back from the newest page until the window is at its size, still reaching the newest. */
    const fillWindow = async () => {
      while ((await rowsInDom()) < history.window && (await step('back'))) {}
      return { rows: await rowsInDom(), mounted: await mounted(), reachesNewest: !(await has('.load-later')) };
    };
    /** Scroll the reader to `at`, then tag the first row in view and return its offset from the top of the chat. */
    const readAt = async (at: 'near top' | 'near bottom') => {
      await page.eval(`(() => { const s = ${scroller}; s.scrollTop = ${at === 'near top' ? 'Math.max(400, s.scrollHeight * 0.2)' : 's.scrollHeight - s.clientHeight - 600'}; return 0; })()`);
      await frame();
      await frame();
      return page.eval<number | null>(`(() => {
        const s = ${scroller};
        const top = s.getBoundingClientRect().top;
        document.querySelectorAll('[data-probe]').forEach((e) => delete e.dataset.probe);
        const r = [...s.querySelectorAll(${JSON.stringify(rowSel)})].find((e) => e.getBoundingClientRect().bottom > top);
        if (!r) return null;
        r.dataset.probe = '1';
        return r.getBoundingClientRect().top - top;
      })()`);
    };
    const arrivals = async (at: 'near top' | 'near bottom', n: number) => {
      const start = await readAt(at);
      const firstRowBefore = await page.eval<string>(`document.querySelector(${JSON.stringify(rowSel)}).innerText.slice(0, 80)`);
      const drifts: number[] = [];
      let maxRows = 0;
      let maxMounted = 0;
      let rowLost = 0;
      let shown = 0;
      let detachedAfterFirst = false;
      const texts: string[] = [];
      for (let i = 0; i < n; i++) {
        const text = `live-${at.replace(' ', '-')}-${i}`;
        texts.push(text);
        app.store.addMessage(kevin.id, 'bot', text);
        await waitFor(`[...document.querySelectorAll('.bot-row-preview')].some((p) => p.textContent.includes(${JSON.stringify(text)}))`, 5000);
        await frame();
        await frame();
        const now = await probeNow();
        if (now === null || start === null) rowLost++;
        else drifts.push(Math.abs(now - start));
        maxRows = Math.max(maxRows, await rowsInDom());
        maxMounted = Math.max(maxMounted, await mounted());
        if (await shows(text)) shown++;
        if (i === 0) detachedAfterFirst = await has('.load-later');
      }
      return {
        arrivals: n,
        maxRowsInDom: maxRows,
        maxMessageViews: maxMounted,
        maxDriftPx: Math.round(Math.max(0, ...drifts) * 10) / 10,
        rowLost,
        liveShown: shown,
        detachedAfterFirst,
        loadNewerShown: await has('.load-later'),
        loadEarlierShown: await has('.load-earlier'),
        oldestLetGo: firstRowBefore !== (await page.eval<string>(`document.querySelector(${JSON.stringify(rowSel)}).innerText.slice(0, 80)`)),
        pill: await page.eval<string | null>(`document.querySelector('.new-pill')?.textContent ?? null`),
        lastText: texts.at(-1)!,
      };
    };

    const nearTopWindow = await fillWindow();
    const nearTop = await arrivals('near top', 30);
    // Jump to latest from the window that let its newest go: the newest page, at the bottom, the composer focused.
    await page.eval(`document.querySelector('.new-pill').click(); 0`);
    await waitFor(latestShownText(nearTop.lastText), 5000);
    const endJump = Date.now() + 3000;
    while (!(await atBottom()) && Date.now() < endJump) await frame();
    const jump = {
      lastLiveShown: true,
      atBottom: await atBottom(),
      pillGone: !(await has('.new-pill')),
      loadNewerGone: !(await has('.load-later')),
      rowsInDom: await rowsInDom(),
      messageViews: await mounted(),
      composerFocused: await page.eval<boolean>(`document.activeElement === ${textarea}`),
    };
    const nearBottomWindow = await fillWindow();
    const nearBottom = await arrivals('near bottom', 30);
    await page.eval(`${scroller}.scrollTop = ${scroller}.scrollHeight; 0`);
    await frame();
    return { window: history.window, nearTop: { start: nearTopWindow, ...nearTop }, jump, nearBottom: { start: nearBottomWindow, ...nearBottom } };
  }
  function latestShownText(text: string) {
    return `document.querySelector('.chat')?.innerText.includes(${JSON.stringify(text)})`;
  }

  async function finish() {
    writeFileSync(join(out, `${opt.label}.json`), JSON.stringify(results, null, 2) + '\n');
    log(`wrote ${join(out, `${opt.label}.json`)}`);
    page.close();
    browser.close();
    if (opt.budget && !results.soak) budget(results);
    chrome.kill('SIGTERM');
    await new Promise((r) => chrome.once('exit', r));
    await app.close();
  }

  /**
   * One soak cycle. `all` does everything below in turn; the others do one thing, to find which leaks:
   * `switch` goes to Stuart and back to Kevin, `read` reads back four pages and jumps to the latest,
   * `live` has Kevin write a message while the chat follows the bottom, and `idle` only polls the page
   * the way the others do.
   */
  async function soakCycle(cycle: number, wrote: () => void) {
    const kevinsLast = latestShownText(`marker-${kevin.id}-${lastBotIdx}`);
    if (SOAK_MODE === 'all' || SOAK_MODE === 'live') {
      app.store.addMessage(kevin.id, 'bot', `${botMarkdown(rng(cycle), cycle, cycle)}\n\nsoak-${cycle}`);
      wrote();
    }
    const shown = SOAK_MODE === 'all' || SOAK_MODE === 'live' ? latestShownText(`soak-${cycle}`) : kevinsLast;
    if (SOAK_MODE === 'all' || SOAK_MODE === 'read') {
      for (let i = 0; i < 4; i++) await step('back');
      await page.eval(`document.querySelector('.new-pill')?.click(); ${scroller}.scrollTop = ${scroller}.scrollHeight; 0`);
    }
    await waitFor(shown);
    if (SOAK_MODE === 'all' || SOAK_MODE === 'switch') {
      await backToStuart();
      await page.eval(`[...document.querySelectorAll('.bot-row')].find((b) => b.textContent.includes('Kevin')).click(); 0`);
      await waitFor(shown);
    }
    if (SOAK_MODE === 'idle') {
      await probe('bottom');
      await frame();
      await sleep(25);
    }
  }

  /**
   * Switch chats, read back and jump to the latest, while Kevin keeps writing (a message a cycle), for
   * SOAK_MINUTES; sample memory each minute. Each sample is appended to the .jsonl file as it is taken.
   */
  async function soak() {
    const file = join(out, `${opt.label}-soak.jsonl`);
    writeFileSync(file, JSON.stringify({ provenance: results.provenance, minutes: SOAK_MINUTES, mode: SOAK_MODE }) + '\n');
    const end = Date.now() + SOAK_MINUTES * 60_000;
    let cycles = 0;
    let switches = 0;
    let written = 0;
    const samples: any[] = [];
    let next = Date.now();
    while (Date.now() < end) {
      if (Date.now() >= next) {
        const m = await memory(`soak-${samples.length}`);
        const renderer = m.processes.find((p: any) => p.type === 'page renderer');
        const sample = { minute: samples.length, at: new Date().toISOString(), cycles, switches, kevinMessages: MESSAGES + written, rowsInDom: m.rowsInDom, domElements: m.domElements, jsHeapUsedMB: m.jsHeapUsedMB, listeners: m.cdpJsEventListeners, cdpNodes: m.cdpNodes, ...(await allocators(browser, rendererPid)), rendererRssMB: renderer?.rssMB, rendererPssMB: renderer?.pssMB };
        samples.push(sample);
        appendFileSync(file, JSON.stringify(sample) + '\n');
        next += 60_000;
      }
      await soakCycle(cycles, () => written++);
      if (SOAK_MODE === 'all' || SOAK_MODE === 'switch') switches += 2;
      cycles++;
    }
    const first = samples[1] ?? samples[0];
    const last = samples.at(-1);
    return { file, mode: SOAK_MODE, minutes: SOAK_MINUTES, cycles, switches, samples: samples.length, first, last, rssGrowthMB: last && first ? Math.round((last.rendererRssMB - first.rendererRssMB) * 10) / 10 : null, heapGrowthMB: last && first ? Math.round((last.jsHeapUsedMB - first.jsHeapUsedMB) * 10) / 10 : null };
  }
}

/**
 * Where a renderer's memory is, by Chrome's own accounting (a memory-infra dump): the top-level allocators
 * (V8, Blink's GC heap, PartitionAlloc, malloc, the compositor, Skia, fonts…) in MB; some overlap (shared_memory
 * holds the compositor's tiles, blink_objects is a view of Blink's heaps), so they don't add up to a total.
 * RSS counts shared pages (the binary, fonts) in full; these count what each allocator holds.
 */
async function allocators(browser: Cdp, pid: number) {
  const events: any[] = [];
  browser.on('Tracing.dataCollected', (p) => events.push(...p.value));
  const done = new Promise((r) => browser.on('Tracing.tracingComplete', r));
  await browser.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } });
  const dump = await browser.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  await browser.send('Tracing.end');
  await done;
  browser.off('Tracing.dataCollected');
  browser.off('Tracing.tracingComplete');
  const mine = events.filter((e) => e.ph === 'v' && e.pid === pid && e.args?.dumps);
  const dumps = mine.at(-1)?.args.dumps;
  if (!dump.success || !dumps) return { note: `no memory dump for the renderer (success ${dump.success}, ${mine.length} dumps)` };
  const mb = (hex?: string) => (hex ? Math.round((parseInt(hex, 16) / 1048576) * 10) / 10 : 0);
  const top: Record<string, number> = {};
  for (const [name, d] of Object.entries<any>(dumps.allocators ?? {})) if (!name.includes('/') && d.attrs?.size) top[name] = mb(d.attrs.size.value);
  // Blink's heap holds freed space too: what is live in it, and the objects Blink counts (nodes, layout objects…).
  const blinkLive = dumps.allocators?.['blink_gc/main/allocated_objects']?.attrs?.size?.value;
  const blinkCounts: Record<string, number> = {};
  for (const [name, d] of Object.entries<any>(dumps.allocators ?? {})) {
    const n = name.startsWith('blink_objects/') && d.attrs?.object_count ? parseInt(d.attrs.object_count.value, 16) : 0;
    if (n) blinkCounts[name.slice('blink_objects/'.length)] = n;
  }
  const v8 = dumps.allocators?.['v8'];
  const blink = dumps.allocators?.['blink_gc'];
  return {
    allocatorsMB: Object.fromEntries(Object.entries(top).sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 0.1)),
    v8AllocatedMB: v8?.attrs?.allocated_objects_size ? mb(v8.attrs.allocated_objects_size.value) : undefined,
    blinkGcAllocatedMB: blink?.attrs?.allocated_objects_size ? mb(blink.attrs.allocated_objects_size.value) : undefined,
    blinkGcLiveMB: blinkLive ? mb(blinkLive) : undefined,
    blinkCounts,
  };
}

/** A blank tab, in a renderer of its own: what any page costs before the app does anything. */
async function blankTab(browser: Cdp) {
  const renderers = async () => new Set(((await browser.send('SystemInfo.getProcessInfo')).processInfo as { type: string; id: number }[]).filter((p) => p.type === 'renderer').map((p) => p.id));
  const before = await renderers();
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: false });
  await new Promise((r) => setTimeout(r, 1500));
  const fresh = [...(await renderers())].filter((p) => !before.has(p));
  const procs = fresh.length === 1 ? await processMemory(browser, fresh[0]) : [];
  await browser.send('Target.closeTarget', { targetId });
  return procs.find((p) => p.type === 'page renderer') ?? { note: `no single new renderer (${fresh.length})` };
}

/** --budget: exits 1 with what went over (see overBudget). */
function budget(r: any) {
  const over = overBudget(r, history.window);
  if (over.length) {
    console.error(`[perf] over budget:\n  ${over.join('\n  ')}`);
    process.exitCode = 1;
  } else log('within budget');
}

/** The page's renderer, the GPU and browser processes, with RSS and PSS from /proc (Linux only). */
async function processMemory(browser: Cdp, rendererPid: number) {
  const info = await browser.send('SystemInfo.getProcessInfo');
  const list: { type: string; pid: number; rssMB?: number; pssMB?: number }[] = [];
  for (const p of info.processInfo as { type: string; id: number }[]) {
    if (p.id !== rendererPid && p.type !== 'GPU' && p.type !== 'browser') continue;
    const row: (typeof list)[number] = { type: p.id === rendererPid ? 'page renderer' : p.type, pid: p.id };
    try {
      const rollup = readFileSync(`/proc/${p.id}/smaps_rollup`, 'utf8');
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(rollup)?.[1] ?? NaN);
      row.rssMB = Math.round(kb('Rss') / 102.4) / 10;
      row.pssMB = Math.round(kb('Pss') / 102.4) / 10;
    } catch {}
    list.push(row);
  }
  return list;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => res(''));
    p.on('exit', () => res(out.trimEnd()));
  });
}

/** A hash of every file under `dir` (relative paths and contents, sorted), so two results can say whether they ran the same thing. */
function hashTree(dir: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(f + '\0');
    try {
      h.update(readFileSync(join(dir, f)));
    } catch {
      h.update('(missing)');
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

/** What produced a result: the harness's tree and the app's (they differ with --app-source), the built files, Chrome and Node. */
async function provenance(webDist: string, chrome: string) {
  const tree = async (dir: string) => {
    const head = await run('git', ['rev-parse', 'HEAD'], dir);
    const files = (await run('git', ['ls-files', '-co', '--exclude-standard', '--', 'web', 'shared', 'server/src', 'scripts/perf-chat.ts'], dir)).split('\n').filter(Boolean);
    return {
      dir: dir === root ? '.' : '(app source)',
      head: head || null,
      branch: (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir)) || null,
      changes: head ? (await run('git', ['status', '--porcelain'], dir)).split('\n').filter(Boolean) : null,
      sourceHash: hashTree(dir, files.length ? files : listFiles(dir).filter((f) => /^(web|shared|server\/src)\//.test(f) && !f.includes('node_modules'))),
    };
  };
  return {
    harness: await tree(root),
    app: appSource === root ? 'same as harness' : await tree(appSource),
    builtWebHash: hashTree(webDist, listFiles(webDist)),
    node: process.version,
    chrome,
    cpu: `${cpus()[0]?.model ?? '?'} x${cpus().length}`,
    at: new Date().toISOString(),
  };
}

try {
  await main();
} finally {
  for (const c of cleanups) c();
  rmSync(home, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
