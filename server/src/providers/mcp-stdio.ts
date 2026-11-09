import { VERSION } from '../../../shared/app-version.mjs';
import { type ChildProcess, spawn } from 'node:child_process';
import { cleanResult, cleanTools, type McpTool, type ToolResult } from '../mcp-client.ts';
import { redact } from '../secrets.ts';

/*
 * Just enough of an MCP client over stdio (newline-delimited JSON-RPC) for an API brain's library and browser
 * connectors: initialize, list tools, call one. The server runs as the CLIs run their MCP servers: as the server's user,
 * in its own process group, with only the environment it is given; it is killed when the turn ends. A library
 * connector comes here already wrapped in the Workspace sandbox (connector-launch.ts).
 */

const PROTOCOL = '2025-06-18';
const MAX_LINE = 4 * 1024 * 1024;
const MAX_TOOL_PAGES = 20;

export class StdioMcp {
  #child: ChildProcess;
  #id = 0;
  #pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #buf = '';
  #closed: Error | null = null;
  #stderr = '';
  #secrets: string[];

  constructor(server: { command: string; args: string[]; env: Record<string, string>; cwd: string; secrets?: string[] }, baseEnv: NodeJS.ProcessEnv) {
    // The connector's own secrets: the values of the environment it was saved with.
    this.#secrets = [...(server.secrets ?? []), ...Object.values(server.env)].filter((v) => v.length >= 8);
    this.#child = spawn(server.command, server.args, { cwd: server.cwd, env: { ...baseEnv, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.#child.stdout!.setEncoding('utf8');
    this.#child.stdout!.on('data', (chunk: string) => this.#read(chunk));
    this.#child.stderr!.setEncoding('utf8');
    // Redacted as it comes, and only then cut from the front: a secret split across chunks is whole again before
    // the cut, and the cut only ever drops text that was already redacted.
    const keep = Math.max(2000, 2 * Math.max(0, ...this.#secrets.map((v) => v.length)));
    this.#child.stderr!.on('data', (chunk: string) => {
      this.#stderr = redact(this.#stderr + chunk, this.#secrets).slice(-keep);
    });
    this.#child.stdin!.on('error', () => {});
    this.#child.on('error', (err) => this.#fail(new Error(`could not start: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
    this.#child.on('close', (code) => this.#fail(new Error(`it exited (${code ?? 'killed'})${this.#tail()}`)));
  }

  /** The connector's own secrets (see the constructor). */
  get secrets(): string[] {
    return [...this.#secrets];
  }

  #tail(): string {
    const t = redact(this.#stderr, this.#secrets).trim().split('\n').pop()?.slice(0, 200) ?? '';
    return t ? `: ${t}` : '';
  }

  #fail(err: Error) {
    this.#closed ??= err;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(this.#closed);
    }
    this.#pending.clear();
  }

  #read(chunk: string) {
    this.#buf += chunk;
    if (this.#buf.length > MAX_LINE && !this.#buf.includes('\n')) {
      this.#fail(new Error('it sent a message larger than Botons reads'));
      this.close();
      return;
    }
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = typeof msg.id === 'number' ? msg.id : null;
      const p = id === null ? undefined : this.#pending.get(id);
      if (!p) continue;
      this.#pending.delete(id!);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { message?: unknown };
        p.reject(new Error(typeof e?.message === 'string' ? redact(e.message, this.#secrets).slice(0, 200) : 'error'));
      } else p.resolve(msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result) ? (msg.result as Record<string, unknown>) : {});
    }
  }

  #send(msg: Record<string, unknown>) {
    this.#child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Botons', version: VERSION } }, timeoutMs);
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(timeoutMs: number): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: unknown;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await this.request('tools/list', cursor === undefined ? {} : { cursor }, timeoutMs);
      for (const t of Array.isArray(r.tools) ? r.tools : []) {
        if (t && typeof t.name === 'string')
          tools.push({ name: t.name, inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : null, description: typeof t.description === 'string' ? t.description : null });
      }
      if (typeof r.nextCursor !== 'string' || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return cleanTools(tools, this.#secrets);
  }

  /** `also`: more to take out of the result before it is cut (see cleanResult). */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number, also?: (text: string) => string): Promise<ToolResult> {
    return cleanResult(await this.request('tools/call', { name, arguments: args }, timeoutMs), this.#secrets, also);
  }

  close(): void {
    this.#fail(new Error('closed'));
    try {
      if (this.#child.pid) process.kill(-this.#child.pid, 'SIGTERM');
    } catch {}
    const pid = this.#child.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {}
    }, 2000).unref();
  }
}
