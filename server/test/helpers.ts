import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, afterEach } from 'node:test';
import type { Bot, BotStatus, CreateBotInput, Message, PairResult, Routine, RoutineRun, ServerEvent } from '../../shared/types.ts';
import { type App, createApp } from '../src/app.ts';
import { approvePairingRequest, createPairingRequest } from '../src/auth.ts';
import { type Config, loadConfig } from '../src/config.ts';
import type { MockProvider } from '../src/providers/mock.ts';
import type { TurnRequest } from '../src/providers/types.ts';
import { type FakeCli, fakeCli } from './fixtures/fake-cli.ts';

// Servers started and folders made here are closed and removed once the file's tests are done.
const apps = new Set<App>();
const dirs: string[] = [];
// Test-file workers share the runner parent. Atomic claims cover the gap between
// checking a port and binding the fixture, including two fixtures in one file.
const portClaims = join(tmpdir(), `botons-test-ports-${process.getuid?.() ?? 'user'}-${process.ppid}`);
const claimedPorts: string[] = [];
after(async () => {
  for (const app of apps) await app.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const claim of claimedPorts) rmdirSync(claim);
  try { rmdirSync(portClaims); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
});

/** A new temp folder, removed after the file's tests. */
export function tempDir(prefix = 'botons-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// CLI homes created by in-process fixtures must stay off the developer's install.
process.env.BOTONS_HOME = tempDir('botons-cli-test-');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy, and return that; throw after `ms`. */
export async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error('timed out');
}

/** node:test swallows errors that would crash the real server; this fails the test they happen in. Call once per file. */
export function failOnEscapedErrors(): void {
  const escaped: unknown[] = [];
  process.on('uncaughtException', (err) => escaped.push(err));
  process.on('unhandledRejection', (err) => escaped.push(err));
  afterEach(() => assert.deepEqual(escaped.splice(0), [], 'an error escaped the server'));
}

/** Agent CLI paths that don't exist, so a test server never runs the real CLIs. */
export function noRealClis(home: string): Record<string, string> {
  return { BOTONS_CLAUDE_BIN: join(home, 'no-claude'), BOTONS_CODEX_BIN: join(home, 'no-codex') };
}

/** Keeps the codex provider and the fake codex CLI off the real ~/.codex. */
export function useTestCodexHome(dir: string): string {
  process.env.BOTONS_HOME = dir;
  const codexHome = join(dir, 'cli', 'codex');
  process.env.CODEX_HOME = codexHome;
  return codexHome;
}

/** A pairing request the owner has approved (as `npm run pair -- --approve` does): its secret, which pairs once. */
export function approvedPairing(db: DatabaseSync, label = ''): string {
  const { secret, code } = createPairingRequest(db, label);
  if (!approvePairingRequest(db, code)) throw new Error('could not approve a pairing request');
  return secret;
}

/** Pair through an approved request; returns the device token for `Authorization: Bearer`. */
export async function pairDevice(app: App, base: string, label = 'Test client'): Promise<string> {
  const secret = approvedPairing(app.store.db);
  const res = await fetch(`${base}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, label }),
  });
  if (res.status !== 201) throw new Error(`Pairing failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as PairResult).token;
}

/** An address this host does not have (EADDRNOTAVAIL) counts as free. */
function portFreeOn(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRNOTAVAIL'));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** A free port in 17000-19999, claimed until this test file finishes so parallel fixtures cannot select it. */
export async function freePort(hosts: string[] = ['127.0.0.1']): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = 17000 + Math.floor(Math.random() * 3000);
    const claim = join(portClaims, String(port));
    mkdirSync(portClaims, { recursive: true, mode: 0o700 });
    try { mkdirSync(claim, { mode: 0o700 }); } catch (error) {
      if (['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    claimedPorts.push(claim);
    let free = true;
    for (const host of hosts) if (!(free = await portFreeOn(host, port))) break;
    if (free) return port;
  }
  throw new Error('No free port in 17000-19999');
}

/** Run the `botons` CLI as `bot` would during a turn, with a token minted for it. */
export async function botonCli(app: App, base: string, botId: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const turn = app.auth.mintBotonToken(botId);
  const repo = resolve(import.meta.dirname, '../..');
  const child = spawn(join(repo, 'server/bin/botons'), args, {
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      BOTONS_API: base,
      BOTON_BOT_ID: botId,
      BOTON_TOKEN: turn.token,
      BOTON_WORKSPACE: app.store.hasBot(botId) ? app.store.getBot(botId).workspace : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  try {
    return await new Promise((done) => child.on('exit', (code) => done({ code, stdout, stderr })));
  } finally {
    turn.revoke();
  }
}

export interface ServerOptions {
  /** loadConfig env, over the defaults: 127.0.0.1 on a free port, mock provider on, no Tailscale, no real agent CLIs. */
  env?: Record<string, string>;
  /** BOTONS_HOME; default a new temp folder. Pass a stopped server's home to restart it. */
  home?: string;
  /** A device token to keep using (a restart), or null to pair none. Default: pair a new device. */
  token?: string | null;
  deviceLabel?: string;
  /** Fake claude and codex CLIs in the home folder (fixtures/fake-cli.ts), as `claude` and `codex`. */
  fakeClis?: boolean;
  /** Change the config before the app is created. */
  configure?: (cfg: Config) => void;
  /** createApp options, over { tailnet: null }. */
  appOptions?: Parameters<typeof createApp>[2];
}

export interface Reply<T> {
  status: number;
  /** The parsed JSON body, the text if it is not JSON, or null if empty. */
  data: T;
  text: string;
  res: Response;
}

export interface TestServer {
  app: App;
  cfg: Config;
  home: string;
  port: number;
  base: string;
  /** The paired device's token ('' with `token: null`). */
  token: string;
  /** Undefined unless BOTONS_ENABLE_MOCK is 1 (the default here). */
  mock: MockProvider;
  /** A JSON request to the API, as the paired device unless `token` says otherwise (null: no Authorization). */
  call<T = any>(method: string, path: string, body?: unknown, token?: string | null): Promise<Reply<T>>;
  /** POST /api/bots (a mock Boton unless `over` says otherwise); asserts 201. */
  newBot(name: string, over?: Record<string, unknown>): Promise<Bot>;
  /** POST /api/bots/:id/routines with name "Job" and instruction "Do the job" unless `input` says otherwise; asserts 201. */
  newRoutine(botId: string, input?: Record<string, unknown>): Promise<Routine>;
  /** A Boton made in the store, for tests that drive the engine directly. */
  storeBot(name: string, provider?: string, over?: Partial<CreateBotInput>): Bot;
  /** POST /api/bots/:id/messages. */
  send(botId: string, text: string): Promise<Reply<Message>>;
  /** Send through the engine; resolves with the reply or error that follows, once the Boton is idle. */
  chat(botId: string, text: string): Promise<Message>;
  /** GET /api/bots/:id/messages. */
  messagesOf(botId: string): Promise<Message[]>;
  /** GET /api/routines/:id/runs. */
  runsOf(routineId: string): Promise<RoutineRun[]>;
  /** The mock provider's turns for this Boton. */
  turnsOf(botId: string): TurnRequest[];
  /** POST /hooks/routines/:id with the routine's key; `init` adds headers and a body. */
  hook(routine: Routine, query?: string, init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }): Promise<Response>;
  /** Wait for the engine to report this state for the Boton. */
  untilState(botId: string, state: BotStatus['state'], ms?: number): Promise<void>;
  /** GET /api/events as the device, past its hello; `events` fills as they arrive, `ended` resolves when the server ends the stream. */
  events(): Promise<{ events: ServerEvent[]; ended: Promise<void>; close(): void }>;
  /** Close the app (the home folder stays until the file is done). */
  stop(opts?: { drainMs?: number }): Promise<{ interrupted: number }>;
}

/** Start an app on a free loopback port with a test web page, and pair a device. Closed after the file's tests unless stopped first. */
export function startServer(opts: ServerOptions & { fakeClis: true }): Promise<TestServer & { claude: FakeCli; codex: FakeCli }>;
export function startServer(opts?: ServerOptions): Promise<TestServer>;
export async function startServer(opts: ServerOptions = {}): Promise<TestServer & Partial<{ claude: FakeCli; codex: FakeCli }>> {
  const home = opts.home ?? tempDir();
  const port = await freePort();
  const clis = opts.fakeClis ? { claude: fakeCli(home, 'claude'), codex: fakeCli(home, 'codex') } : undefined;
  const cfg = loadConfig({
    BOTONS_HOME: home,
    BOTONS_HOST: '127.0.0.1',
    BOTONS_PORT: String(port),
    BOTONS_ENABLE_MOCK: '1',
    BOTONS_NO_TAILSCALE: '1',
    ...noRealClis(home),
    ...(clis && { BOTONS_CLAUDE_BIN: clis.claude.bin, BOTONS_CODEX_BIN: clis.codex.bin }),
    ...opts.env,
  });
  cfg.webDist = join(home, 'web-dist');
  mkdirSync(cfg.webDist, { recursive: true });
  writeFileSync(join(cfg.webDist, 'index.html'), '<h1>Botons test</h1>');
  opts.configure?.(cfg);
  // Never the test runner's own ANTHROPIC_API_KEY or OPENAI_API_KEY: a test sets the environment it means.
  const app = createApp(cfg, undefined, { tailnet: null, ...opts.appOptions, apiKeys: { env: {}, ...opts.appOptions?.apiKeys } });
  await app.listen();
  apps.add(app);
  const base = `http://127.0.0.1:${port}`;
  const token = opts.token === undefined ? await pairDevice(app, base, opts.deviceLabel) : (opts.token ?? '');
  const mock = app.providers.get('mock') as MockProvider;

  const call = async <T = any>(method: string, path: string, body?: unknown, as: string | null = token): Promise<Reply<T>> => {
    const headers: Record<string, string> = {};
    if (as) headers.authorization = `Bearer ${as}`;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let data: any = text || null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, text, res };
  };
  const created = async <T>(path: string, body: unknown) => {
    const { status, data } = await call<T>('POST', path, body);
    assert.equal(status, 201, JSON.stringify(data));
    return data;
  };
  const untilState = async (botId: string, state: BotStatus['state'], ms?: number) => {
    await until(() => app.engine.statusOf(botId).state === state, ms);
  };

  return {
    ...clis,
    app,
    cfg,
    home,
    port,
    base,
    token,
    mock,
    call,
    // A blank Boton gets no connectors unless the test asks (a new Boton's own default, the browser, is browser-defaults.test.ts); one from a template gets the template's.
    newBot: (name, over = {}) => created<Bot>('/api/bots', { name, provider: 'mock', ...(over.templateId === undefined && { connections: [] }), ...over }),
    newRoutine: (botId, input = {}) => created<Routine>(`/api/bots/${botId}/routines`, { name: 'Job', instruction: 'Do the job', ...input }),
    storeBot: (name, provider = 'mock', over = {}) => app.store.createBot({ name, provider, ...over }, app.providers.ids(), provider),
    send: (botId, text) => call<Message>('POST', `/api/bots/${botId}/messages`, { text }),
    chat: (botId, text) => {
      const sent = app.engine.sendMessage(botId, text);
      // After it in the chat's order: the previous reply can share its millisecond.
      return until(() => {
        const all = app.store.listMessages(botId);
        return app.engine.statusOf(botId).state === 'idle' && all.slice(all.findIndex((m) => m.id === sent.id) + 1).find((m) => m.role === 'bot' || m.role === 'error');
      });
    },
    messagesOf: async (botId) => (await call<Message[]>('GET', `/api/bots/${botId}/messages`)).data,
    runsOf: async (routineId) => (await call<RoutineRun[]>('GET', `/api/routines/${routineId}/runs`)).data,
    turnsOf: (botId) => mock.turns.filter((t) => t.env.BOTON_BOT_ID === botId),
    hook: (routine, query = '', init = {}) =>
      fetch(`${base}/hooks/routines/${routine.id}${query && `?${query}`}`, { method: 'POST', ...init, headers: { authorization: `Bearer ${routine.webhook!.key}`, ...init.headers } }),
    untilState,
    events: async () => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
      assert.equal(res.status, 200);
      const events: ServerEvent[] = [];
      const ended = (async () => {
        const decoder = new TextDecoder();
        let buf = '';
        try {
          for await (const chunk of res.body!) {
            buf += decoder.decode(chunk as Uint8Array, { stream: true });
            for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) throw err;
        }
      })();
      ended.catch(() => {});
      await until(() => events.some((e) => e.type === 'hello'));
      return { events, ended, close: () => ac.abort() };
    },
    stop: (stopOpts) => {
      apps.delete(app);
      return app.close(stopOpts);
    },
  };
}
