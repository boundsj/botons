// The fake CLIs' MCP client: it reads the servers a turn was given the way each real CLI does (Claude Code from its
// --mcp-config file, Codex from its `-c mcp_servers.…` overrides and its own environment), starts each (initialize,
// tools/list) and can call a tool, so a test sees what the CLI would have had. It only talks to loopback addresses
// and only runs Node (the test's own fixture servers); anything else fails to start, as for a CLI that can't reach it.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

export interface GivenServer {
  name: string;
  kind: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Codex's startup_timeout_sec for it, if the turn set one. */
  startupTimeoutSec?: number;
}

/** What starting one server came to: Claude Code's init statuses (Codex reports none of this; the fake records it). */
export interface Started {
  status: 'connected' | 'failed' | 'needs-auth' | 'pending';
  tools: string[];
  error?: string;
}

export interface Session {
  call(tool: string, args: unknown): Promise<{ isError: boolean; content: unknown[]; structuredContent?: unknown }>;
  close(): void;
}

/** Claude Code: the --mcp-config file, less Botons' own approval server (`botons mcp`), which isn't a connector. */
export function claudeGiven(argv: string[]): GivenServer[] {
  const i = argv.indexOf('--mcp-config');
  if (i < 0) return [];
  let config: { mcpServers?: Record<string, any> };
  try {
    const arg = argv[i + 1];
    config = JSON.parse(arg.trim().startsWith('{') ? arg : readFileSync(arg, 'utf8'));
  } catch {
    return [];
  }
  const out: GivenServer[] = [];
  for (const [name, s] of Object.entries(config.mcpServers ?? {})) {
    if (s.type === 'stdio' && basename(String(s.command)) === 'boton' && s.args?.[0] === 'mcp') continue;
    if (s.type === 'stdio') out.push({ name, kind: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {}, cwd: s.cwd });
    else out.push({ name, kind: 'http', url: s.url, headers: s.headers ?? {} });
  }
  return out;
}

/** The TOML values Botons writes: basic strings, lists of them, inline tables of them, numbers. */
function tomlValue(v: string): unknown {
  if (v.startsWith('{')) {
    const out: Record<string, string> = {};
    for (const m of v.matchAll(/("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")/g)) out[JSON.parse(m[1])] = JSON.parse(m[2]);
    return out;
  }
  if (v.startsWith('"') || v.startsWith('[')) return JSON.parse(v);
  return Number(v);
}

/**
 * Codex: every `-c mcp_servers.<name>.<key>=<value>`. env_vars name variables of Codex's own environment the server
 * gets, env_http_headers headers whose values are in it; both are read from `env`, as Codex reads its environment.
 */
export function codexGiven(argv: string[], env: Record<string, string>): GivenServer[] {
  const raw = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-c') continue;
    const m = /^mcp_servers\.([A-Za-z0-9_-]+)\.([a-z_]+)=(.*)$/s.exec(argv[i + 1]);
    if (!m) continue;
    const entry = raw.get(m[1]) ?? {};
    entry[m[2]] = tomlValue(m[3]);
    raw.set(m[1], entry);
  }
  const out: GivenServer[] = [];
  for (const [name, c] of raw) {
    const timeout = typeof c.startup_timeout_sec === 'number' ? c.startup_timeout_sec : undefined;
    if (typeof c.url === 'string') {
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries((c.env_http_headers ?? {}) as Record<string, string>)) if (env[v] !== undefined) headers[h] = env[v];
      out.push({ name, kind: 'http', url: c.url, headers, startupTimeoutSec: timeout });
    } else {
      const own: Record<string, string> = { ...((c.env ?? {}) as Record<string, string>) };
      for (const v of (c.env_vars ?? []) as string[]) if (env[v] !== undefined) own[v] = env[v];
      out.push({ name, kind: 'stdio', command: String(c.command), args: (c.args ?? []) as string[], env: own, cwd: c.cwd as string | undefined, startupTimeoutSec: timeout });
    }
  }
  return out;
}

class StartError extends Error {
  status: Started['status'];
  constructor(status: Started['status'], message: string) {
    super(message);
    this.status = status;
  }
}

interface Rpc {
  request(method: string, params: unknown): Promise<any>;
  notify(method: string): Promise<void>;
  close(): void;
}

function httpRpc(s: GivenServer): Rpc {
  const url = new URL(String(s.url));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new StartError('failed', `fake CLI: ${url.hostname} is not a loopback address`);
  let session: string | null = null;
  let id = 0;
  const stop = new AbortController();
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...s.headers, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (res.status === 401 || res.status === 403) throw new StartError('needs-auth', `HTTP ${res.status}`);
    const text = await res.text();
    if (!res.ok) throw new StartError('failed', `HTTP ${res.status}`);
    return { text, type: res.headers.get('content-type') ?? '' };
  };
  return {
    async request(method, params) {
      const mine = ++id;
      const { text, type } = await post({ id: mine, method, params });
      const messages = type.includes('text/event-stream')
        ? text
            .split(/\r?\n\r?\n/)
            .map((b) => b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
            .filter(Boolean)
            .map((d) => JSON.parse(d))
        : [JSON.parse(text)];
      const answer = messages.flat().find((m: any) => m?.id === mine);
      if (!answer) throw new StartError('failed', `no answer to ${method}`);
      if (answer.error) throw new StartError('failed', `${method}: ${answer.error.message ?? 'error'}`);
      return answer.result;
    },
    async notify(method) {
      await post({ method });
    },
    close() {
      stop.abort();
    },
  };
}

function stdioRpc(s: GivenServer): Rpc {
  // Never a command from a test's made-up connector (`npx …` would reach the network, `touch` leave a file).
  // A library connector comes in the Workspace sandbox (connector-launch.ts): `/bin/sh -c <script> sh <bwrap> <filter>
  // <launch file> <command> <args…>`, run as given.
  const wrapped = s.command === '/bin/sh' && s.args?.[0] === '-c' && (s.args?.length ?? 0) > 6;
  const command = wrapped ? s.args![6] : s.command;
  if (command !== process.execPath) throw new StartError('failed', `fake CLI: runs only ${process.execPath}, not ${command}`);
  // Only what the turn gave it, on top of a bare PATH and HOME: a server that needs more doesn't start.
  const child: ChildProcess = spawn(String(s.command), s.args ?? [], {
    cwd: s.cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...s.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let gone: Error | null = null;
  const fail = (err: Error) => {
    gone ??= err;
    for (const w of waiting.values()) w.reject(gone);
    waiting.clear();
  };
  child.on('error', (err) => fail(new StartError('failed', err.message)));
  child.on('exit', (code) => fail(new StartError('failed', `exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(msg?.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new StartError('failed', msg.error.message ?? 'error'));
    else w.resolve(msg.result);
  });
  let id = 0;
  return {
    request(method, params) {
      if (gone) return Promise.reject(gone);
      const mine = ++id;
      return new Promise((resolve, reject) => {
        waiting.set(mine, { resolve, reject });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
      });
    },
    async notify(method) {
      if (!gone) child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    close() {
      child.kill();
    },
  };
}

async function startOne(rpc: Rpc): Promise<{ tools: string[]; session: Session }> {
  try {
    await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '0.0.0' } });
    await rpc.notify('notifications/initialized');
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await rpc.request('tools/list', cursor ? { cursor } : {});
      for (const t of r?.tools ?? []) if (typeof t?.name === 'string') tools.push(t.name);
      cursor = typeof r?.nextCursor === 'string' ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return {
      tools,
      session: {
        call: async (tool, args) => {
          try {
            const r = await rpc.request('tools/call', { name: tool, arguments: args });
            return { isError: r?.isError === true, content: Array.isArray(r?.content) ? r.content : [], structuredContent: r?.structuredContent };
          } catch (err) {
            // An error answer is a failed call, as the CLIs pass it on to the model.
            return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
          }
        },
        close: () => rpc.close(),
      },
    };
  } catch (err) {
    rpc.close();
    throw err;
  }
}

/**
 * Starts every server at once and waits up to `waitMs(server)` for each. One still starting then is `onSlow`
 * (Claude Code starts servers without blocking the turn, so it is pending; Codex gives up on it).
 */
export async function startServers(
  given: GivenServer[],
  waitMs: (s: GivenServer) => number,
  onSlow: (s: GivenServer, ms: number) => Started,
): Promise<{ started: Record<string, Started>; sessions: Map<string, Session> }> {
  const started: Record<string, Started> = {};
  const sessions = new Map<string, Session>();
  await Promise.all(
    given.map(async (s) => {
      const ms = waitMs(s);
      let timer: NodeJS.Timeout | undefined;
      const slow = new Promise<'slow'>((resolve) => (timer = setTimeout(() => resolve('slow'), ms)));
      try {
        const rpc = s.kind === 'http' ? httpRpc(s) : stdioRpc(s);
        const attempt = startOne(rpc);
        attempt.catch(() => {});
        const r = await Promise.race([attempt, slow]);
        if (r === 'slow') {
          // A local command is stopped; an HTTP answer that comes later is dropped.
          rpc.close();
          started[s.name] = onSlow(s, ms);
          return;
        }
        started[s.name] = { status: 'connected', tools: r.tools };
        sessions.set(s.name, r.session);
      } catch (err) {
        started[s.name] = { status: err instanceof StartError ? err.status : 'failed', tools: [], error: (err as Error).message };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { started, sessions };
}
