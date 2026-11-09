// `npm run check:config`: Settings → Move to another server in the real web app in headless Chrome, driven as the
// owner would, from one throwaway server to another (temp HOME and BOTONS_HOME each, 127.0.0.1, free ports, no
// Tailscale, no real CLI, the mock brain). Fake secrets only. It checks that the owner can:
// - export the configuration of a server with Botons, routines, skills, connectors (with secrets) and settings, and
//   see what was left out, with no secret in the page, its storage, the file or the server's log;
// - import it on a fresh server: the preview lists each Boton's brain, access, rules, connectors and routines and
//   what to do by hand, Full computer access only once ticked, and nothing changes before Import;
// - see each Boton's spending caps in the preview (never what it spent), keep or leave them out by a tick, and find
//   them on the new Boton and its routine after importing, its account starting at $0;
// - import it, see what is still to do, put the connector's secret back and turn it on, and find the same
//   configuration exported from the new server (less the secrets, with its routines off).
// Exits 1 with what failed. `--out <dir>` saves screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { PortableConfig, PortableExport } from '../shared/types.ts';
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
const tmp = mkdtempSync(join(tmpdir(), 'botons-config-'));
process.env.HOME = join(tmp, 'home');
process.env.CODEX_HOME = join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-home');
mkdirSync(process.env.HOME, { recursive: true });
const log = (...a: unknown[]) => console.log('[config]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[config] FAIL ${what}`);
  }
};

// Fake secrets, in shapes no real one has (the dots).
const SECRETS = ['envsecret.kevin.check.0001', 'headersecret.stuart.check.0001', 'querysecret.bob.check.0001', 'tk_fake.ntfy.check.0001', 'hooksecret.dave.check.0001'];
const [ENV_SECRET, HEADER_SECRET, QUERY_SECRET, NTFY_SECRET, HOOK_SECRET] = SECRETS;

// Everything the servers write to stdout and stderr while the check runs, to look for the secrets in.
const written: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return write(chunk, ...rest);
  };
}

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

async function server(name: string, webDist: string) {
  const home = join(tmp, name);
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    BOTONS_TZ: 'UTC',
    BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
    BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
    HOME: process.env.HOME!,
  });
  cfg.webDist = webDist;
  const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: {} } });
  await app.listen();
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const { secret, code } = createPairingRequest(app.store.db, 'config check');
  approvePairingRequest(app.store.db, code);
  const token: string = (await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'config check' }) })).json()).token;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  await call('PATCH', '/api/setup', { complete: true });
  return { app, base, token, call };
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
  const src = await server('source', webDist);
  const dst = await server('target', webDist);

  // The source: one of most things, with a secret wherever one can be.
  await src.call('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'Europe/Paris', ntfy: { server: 'https://ntfy.example.com', topic: 'botons-sam', token: NTFY_SECRET, enabled: true } });
  await src.call('POST', '/api/mcp-servers', { name: 'notes', transport: 'stdio', command: 'notes-mcp', args: ['--verbose'], env: { NOTES_TOKEN: ENV_SECRET } });
  await src.call('POST', '/api/mcp-servers', { name: 'tracker', transport: 'http', url: `https://mcp.example.com/mcp?key=${QUERY_SECRET}`, headers: { Authorization: `Bearer ${HEADER_SECRET}` } });
  const work = (await src.call('POST', '/api/sidebar/groups', { name: 'Work' })).groupId;
  const kevin = await src.call('POST', '/api/bots', { name: 'Kevin', provider: 'mock', groupId: work, pinned: true, access: 'host', instructions: 'Brief me every morning.' });
  const stuart = await src.call('POST', '/api/bots', { name: 'Stuart', provider: 'mock', connections: ['lib:tracker', 'lib:notes'] });
  await src.call('PATCH', `/api/bots/${kevin.id}`, { askFirst: ['Bash(git push:*)'] });
  await src.call('POST', '/api/skills', { name: 'weekly-report', description: 'Write the weekly report', body: 'One line per change.' });
  const brief = await src.call('POST', `/api/bots/${kevin.id}/routines`, { name: 'Morning brief', instruction: 'Brief me', schedule: 'weekdays at 8:00', skill: 'weekly-report' });
  await src.call('PUT', `/api/bots/${kevin.id}/spending`, { dailyCapUsd: 3, routines: { [brief.id]: 0.5 } });
  // Something Kevin already spent here: the account stays on this server, never in the file.
  src.app.store.db
    .prepare("insert into api_requests (id, bot_id, turn_id, provider, model, at, reserved_usd, cost_usd, state, ended_at) values ('req_check_spent', ?, 'turn_check', 'anthropic-api', 'claude-sonnet-5-5', ?, 0.987654, 0.987654, 'settled', ?)")
    .run(kevin.id, new Date().toISOString(), new Date().toISOString());
  await src.call('POST', '/api/templates', { fromBotId: kevin.id, name: 'Briefer', description: 'A morning briefer' });
  await src.call('POST', `/api/bots/${stuart.id}/routines`, { name: 'On push', instruction: 'Review it', webhook: true, webhookSource: 'github', webhookSecret: HOOK_SECRET });

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
  await browser.send('DOM.enable', {}, page);
  // Each server's own device token, on its own origin.
  for (const s of [src, dst]) {
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(s.base)}) localStorage.setItem('botons.deviceToken', ${JSON.stringify(s.token)});` }, page);
  }
  // A download is a click on a blob link: keep what it holds rather than saving it.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__downloads = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__downloads.push(this.download); fetch(this.href).then((r) => r.text()).then((t) => window.__downloads.push(t)); return; } return click.call(this); };` }, page);
  const evalIn = <T = any>(expr: string) => browser.eval<T>(expr, page);
  const waitFor = async (expr: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`).catch(() => false)) return;
      await sleep(100);
    }
    const shown = await evalIn<string>('document.body.innerText.slice(-1500)').catch(() => '?');
    throw new Error(`timed out waiting for ${expr}; page shows: ${shown}`);
  };
  let shots = 0;
  const shot = async (name: string) => {
    if (!opt.out) return;
    mkdirSync(resolve(opt.out), { recursive: true });
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page);
    writeFileSync(join(resolve(opt.out), `${String(++shots).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
  };
  const click = async (expr: string) => {
    await waitFor(expr);
    const at = await evalIn<{ x: number; y: number }>(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, page);
  };
  const SECTION = `document.querySelector('section.config-transfer')`;
  const button = (label: string) => `[...${SECTION}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const sectionText = () => evalIn<string>(`${SECTION}?.innerText ?? ''`);
  /** `shown`: secrets the page shows the owner on purpose elsewhere (the MCP library lists a server's URL as saved). */
  const nowhere = async (what: string, shown: string[] = []) => {
    const all = await evalIn<string>(`document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
    const found = SECRETS.filter((v) => all.includes(v) && !shown.includes(v));
    check(!found.length, `${what}: no secret in the page or its storage${found.length ? ` (found ${found.length})` : ''}`);
    return all;
  };
  const openSettings = async (base: string) => {
    await browser.send('Page.navigate', { url: base }, page);
    await waitFor(`document.querySelector('button[aria-label="Settings"]')`);
    await click(`document.querySelector('button[aria-label="Settings"]')`);
    await click(`document.querySelector('.settings-nav [data-section="advanced"]')`);
    await waitFor(SECTION);
    await evalIn(`${SECTION}.scrollIntoView({ block: 'start' })`);
  };

  log('— export from the source');
  await openSettings(src.base);
  await click(button('Export configuration'));
  await waitFor(`window.__downloads.length === 2`);
  const [fileName, fileText] = await evalIn<[string, string]>('window.__downloads');
  check(/^botons-config-\d{4}-\d{2}-\d{2}\.json$/.test(fileName), `downloads a dated file: ${fileName}`);
  const file = JSON.parse(fileText) as PortableConfig;
  check(file.format === 'botons-config' && file.botons.length === 2 && file.skills.length === 1 && file.connectors.length === 2, 'the file holds the Botons, skill and connectors');
  check(!SECRETS.some((v) => fileText.includes(v)) && !fileText.includes(src.token), 'the file holds no secret and no device token');
  const kevinFile = file.botons.find((m) => m.name === 'Kevin');
  check(kevinFile?.dailyCapUsd === 3 && kevinFile.routines[0]?.perRunCapUsd === 0.5, "the file has Kevin's caps, a day and a run");
  check(!fileText.includes('req_check_spent') && !fileText.includes('0.987654'), 'the file holds nothing Kevin spent');
  const exported = await sectionText();
  check(/never in the file: connectors' env and header values/.test(exported) && /lib:notes: env values \(NOTES_TOKEN\)/.test(exported) && /lib:tracker: its URL's query/.test(exported), 'says what was left out, by name');
  await nowhere('after exporting', [QUERY_SECRET]);
  check(!(await evalIn<string>(`${SECTION}.innerHTML`)).includes(QUERY_SECRET), "the export's own summary doesn't show the URL's query");
  await shot('exported');

  log('— preview on a fresh server');
  await openSettings(dst.base);
  const path = join(tmp, fileName);
  writeFileSync(path, fileText);
  const { root: doc } = await browser.send('DOM.getDocument', { depth: -1, pierce: true }, page);
  const { nodeId } = await browser.send('DOM.querySelector', { nodeId: doc.nodeId, selector: 'section.config-transfer input[type=file]' }, page);
  await browser.send('DOM.setFileInputFiles', { nodeId, files: [path] }, page);
  await waitFor(`${SECTION}.querySelector('.config-preview')`);
  const shown = await sectionText();
  check(/Botons \(2 of 2\)/.test(shown) && /Kevin/.test(shown) && /Stuart/.test(shown), 'the preview lists the Botons to make');
  check(/Computer access: Workspace/.test(shown) && /give it Full computer access/.test(shown), "Kevin's Full computer access is offered, not given");
  check(/Ask first: Bash\(git push:\*\)/.test(shown), 'rules are shown');
  check(/runs a command in the turns of Botons that have it/.test(shown) && /needs header Authorization/.test(shown), 'the connectors say what they run and need');
  check(/Enter notes's env NOTES_TOKEN/.test(shown) && /give the sender its new webhook URL and key, and set its signing secret again/.test(shown) && /enter it in Settings → Push notifications/.test(shown), 'lists what to do by hand');
  check(/Saved templates/.test(shown) && /Briefer/.test(shown) && /without Full computer access/.test(shown), 'the saved template is shown, without Full computer access');
  check(dst.app.store.listBots().length === 0, 'nothing is made by a preview');
  check(/Spending caps: \$3 a day, starting at \$0 here/.test(shown) && /the file has \$3 a day, \$0\.5 a run for “Morning brief”/.test(shown) && /keep the file's caps/.test(shown) && /at most \$0\.5 a run/.test(shown), "Kevin's caps are shown, from $0 here");
  check(/What Botons spent where the file was made isn't in it/.test(shown), 'says spending never comes with the file');
  await nowhere('in the preview');
  await shot('preview');

  log("— leave Kevin's caps out, then keep them again");
  const kevinItem = `[...${SECTION}.querySelectorAll('.config-item')].find((li) => li.innerText.startsWith('Kevin'))`;
  const capsBox = `${kevinItem}?.querySelector('.config-caps input[type=checkbox]')`;
  await click(capsBox);
  await waitFor(`/Spending caps: none a day/.test(${kevinItem}?.innerText) && !${capsBox}.checked`);
  check(/Kevin: you chose to leave out the file's spending caps; it arrives with none/.test(await sectionText()), "leaving them out is shown as the owner's choice");
  await click(capsBox);
  await waitFor(`/Spending caps: \\\$3 a day/.test(${kevinItem}?.innerText) && ${capsBox}.checked`);
  check(!/you chose to leave out/.test(await sectionText()), 'and kept again');

  log('— tick Full computer access for Kevin, then import');
  const kevinBox = `[...${SECTION}.querySelectorAll('.config-item')].find((li) => li.innerText.startsWith('Kevin'))?.querySelectorAll('input[type=checkbox]')[1]`;
  await click(kevinBox);
  await waitFor(`/Computer access: Full computer/.test(${SECTION}.innerText)`);
  check(true, 'the preview follows the tick');
  await click(button('Import'));
  await waitFor(`${SECTION}.querySelector('.config-result')`);
  const result = await sectionText();
  check(/Imported 2 Botons \(Kevin, Stuart\), 1 skill, 1 saved template and 2 connectors, and the settings/.test(result) && /Still to do/.test(result), `says what was made and what is still to do: ${result.slice(0, 200).replace(/\n/g, ' | ')}`);
  await waitFor(`[...document.querySelectorAll('nav, aside, body')].some((e) => /Kevin/.test(e.innerText) && /Stuart/.test(e.innerText))`);
  check(true, 'the sidebar shows the new Botons');
  await nowhere('after importing');
  await shot('imported');

  log('— put the secrets back and check the configuration');
  await dst.call('PATCH', '/api/mcp-servers/notes', { env: { NOTES_TOKEN: ENV_SECRET } });
  await dst.call('PATCH', '/api/mcp-servers/tracker', { url: `https://mcp.example.com/mcp?key=${QUERY_SECRET}`, headers: { Authorization: `Bearer ${HEADER_SECRET}` } });
  for (const id of ['lib:notes', 'lib:tracker']) {
    const access = await dst.call('GET', `/api/connectors/${id}/access`);
    await dst.call('PUT', `/api/connectors/${id}/enabled`, { enabled: true, expected: { enabled: false, botIds: access.botons.filter((m: { has: boolean }) => m.has).map((m: { botId: string }) => m.botId), running: [] } });
  }
  const bots = dst.app.store.listBots();
  const k = bots.find((b) => b.name === 'Kevin')!;
  const s = bots.find((b) => b.name === 'Stuart')!;
  check(k.access === 'host' && k.pinned && k.group === 'Work' && k.askFirst.includes('Bash(git push:*)'), "Kevin's access, pin, group and rules");
  check(s.connections.includes('lib:tracker') && s.connections.includes('lib:notes'), "Stuart's connectors");
  const routines = [k, s].flatMap((b) => dst.app.store.listRoutines(b.id));
  check(routines.length === 2 && routines.every((r) => !r.enabled), 'both routines arrived, off');
  const caps = await dst.call('GET', `/api/bots/${k.id}/spending`);
  check(caps.dailyCapUsd === 3 && caps.spentTodayUsd === 0 && caps.routines[0]?.perRunCapUsd === 0.5 && caps.routines[0]?.id !== brief.id, "Kevin's caps are on the new Boton and its new routine, from $0");
  const again = (await dst.call('GET', '/api/config/export')) as PortableExport;
  const same = (f: PortableConfig) =>
    JSON.stringify({ m: f.botons.map((m) => ({ ...m, routines: m.routines.map((r) => ({ ...r, enabled: false, webhookSecretLeftOut: false })) })), s: f.skills, c: f.connectors.map((c) => c.id), t: f.templates.map((t) => [t.name, t.routines.length]), set: { ...f.settings, ntfy: { ...f.settings.ntfy, enabled: false, tokenLeftOut: false } }, side: f.sidebar });
  check(same(again.file) === same(file), 'exported again, the new server has the same configuration');
  const catalog = await dst.call('GET', '/api/connectors');
  check(['lib:notes', 'lib:tracker'].every((id) => catalog.connectors.find((c: { id: string; enabled: boolean }) => c.id === id)?.enabled), 'the connectors are on once their secrets are back');
  const audit = (await dst.call('GET', '/api/audit')) as { action: string }[];
  check(audit.some((e) => e.action === 'config.imported'), 'the import is in the audit log');
  check((audit as { action: string; target?: { id: string }; details: Record<string, unknown> }[]).some((e) => e.action === 'boton.created' && e.target?.id === k.id && e.details.dailyCap === '$3'), "Kevin's caps are in its audit record");
  await nowhere('at the end');
  check(!SECRETS.slice(0, 4).some((v) => written.join('').includes(v)), "no secret in either server's log");
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error('[config]', err);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[config] ${failures.length} failed:\n- ${failures.join('\n- ')}`);
  code = 1;
} else if (!code) log('all passed');
process.exit(code);
