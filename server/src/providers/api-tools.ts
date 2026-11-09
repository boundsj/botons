import { createHash } from 'node:crypto';
import { CLI_NAMES, withLegacyTurnNames } from '../../../shared/legacy-names.mjs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { TurnStep } from '../../../shared/types.ts';
import { instructionPaths } from '../instructions.ts';
import { holdsSecret, McpError, McpSession } from '../mcp-client.ts';
import { type RunOptions, runProcess, type SandboxPlan, sandboxProblem } from '../sandbox.ts';
import { redactJson } from '../secrets.ts';
import { shorten } from '../util.ts';
import { StdioMcp } from './mcp-stdio.ts';
import { agentEnv } from './process.ts';
import { type McpStartup, step, type ToolObservation, type TurnMcpServer, type TurnRequest } from './types.ts';

/*
 * The tools an API brain's model can call, all run by the server: a shell, reading, writing and editing files (each one
 * a process, in the OS sandbox for Workspace access: see sandbox.ts), `botons` commands (the Boton's own API, run as
 * the CLIs run them: outside the sandbox, as this turn's token), and the tools of the Botons connectors the turn was
 * given (OAuth and library ones only: connectors.resolve never hands over anything else). What a tool returns to the
 * model is bounded, and never holds the API key (the caller redacts it from every result).
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of an object. */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Its input held a known secret (taken out of it): it is never run. */
  secret?: boolean;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** It may have changed something: a provider error after it can't safely run the turn again. */
  acted: boolean;
}

export const SHELL_TIMEOUT_MS = 120_000;
export const SHELL_MAX_TIMEOUT_MS = 600_000;
const OUTPUT_MAX = 32 * 1024;
const READ_MAX = 256 * 1024;
const WRITE_MAX = 1024 * 1024;
const MCP_START_MS = 20_000;
const MCP_CALL_MS = 120_000;
/** Tool names: what both APIs take. */
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CONNECTOR_TOOLS = 128;
const MAX_DESCRIPTION = 1024;
/** A connector tool's input schema, as JSON; a bigger one leaves the tool out. */
const MAX_SCHEMA = 16 * 1024;
/** Every connector tool's definition together, as JSON: the rest are left out (a request carries them all). */
const MAX_CONNECTOR_SPECS = 200 * 1024;

// The models' tool descriptions are part of toolsKey: changing them drops the reasoning each session kept.
const NATIVE: ToolSpec[] = [
  {
    name: 'shell',
    description:
      'Run a bash command in your workspace (the current folder). Output is cut to its start and end past 32 KB. A command that is only a `botons …` command (no pipes, redirects, ;, &&, $ or backticks) runs as your Botons CLI, which reaches the Botons server; with Workspace access everything else runs in a sandbox with no network, where only your workspace (and the shared folder) can be written.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command.' },
        timeout_seconds: { type: 'integer', description: `At most ${SHELL_MAX_TIMEOUT_MS / 1000}; ${SHELL_TIMEOUT_MS / 1000} when left out.` },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: `Read a text file (a path relative to your workspace, or absolute). At most ${READ_MAX / 1024} KB is returned.`,
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'write_file',
    description: `Write a text file (created with its folders, or replaced), at most ${WRITE_MAX / 1024} KB.`,
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  },
  {
    name: 'edit_file',
    description: 'Replace text in a file: old_text must appear exactly once, unless replace_all is true.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
];

/** A tool-free turn's tools: described only (calls to them may be in the history), never called. */
export const DESCRIBED_ONLY = NATIVE;

/** `botons` (or a deprecated name of it) and its arguments, when `command` is that one simple command and nothing else; else null. */
export function botonArgv(command: string): string[] | null {
  const words: string[] = [];
  let cur: string | null = null;
  let i = 0;
  const s = command.trim();
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      if (cur !== null) words.push(cur);
      cur = null;
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      cur = (cur ?? '') + s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let out = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '$' || s[j] === '`') return null;
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) out += s[++j];
        else out += s[j];
      }
      if (j >= s.length) return null;
      cur = (cur ?? '') + out;
      i = j + 1;
    } else if (c === '\\') {
      if (i + 1 >= s.length || s[i + 1] === '\n') return null;
      cur = (cur ?? '') + s[i + 1];
      i += 2;
    } else if (';&|<>()$`\n\r*?[]{}~#!'.includes(c)) return null;
    else {
      cur = (cur ?? '') + c;
      i++;
    }
  }
  if (cur !== null) words.push(cur);
  // The command or one of its deprecated names (shared/legacy-names.mjs).
  return words[0] !== undefined && (words[0] === 'botons' || CLI_NAMES.includes(words[0])) ? words.slice(1) : null;
}

interface Connector {
  name: string;
  /** What it sends that must not come back out (its headers' values, its environment's). */
  secrets: string[];
  tools: Map<string, { tool: string; spec: ToolSpec }>;
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | null }>;
  close(): void;
}

export interface ToolsetOptions {
  req: TurnRequest;
  /** Where `botons` is (the server's own CLI). */
  botonCli: string | null;
  /** BOTONS_OAUTH_ALLOW: what connector requests may reach. */
  allow: string[];
  /** Takes the API key (and any other secret) out of text. */
  redact: (text: string) => string;
}

/** A connector tool's name as the model sees it: mcp__<server>__<tool>, cut and hashed to fit when long. */
function connectorToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (raw.length <= 64) return raw;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}

function objectSchema(s: Record<string, unknown> | null): Record<string, unknown> {
  if (s && s.type === 'object') return s;
  return { type: 'object', properties: {} };
}

/** The turn's tools: what the model is told about them, and how each call runs. */
export class Toolset {
  readonly specs: ToolSpec[];
  readonly startup: McpStartup[] = [];
  #opts: ToolsetOptions;
  #plan: SandboxPlan | null;
  #connectors: Connector[] = [];
  #byName = new Map<string, { connector: Connector; tool: string }>();

  private constructor(opts: ToolsetOptions, plan: SandboxPlan | null, specs: ToolSpec[]) {
    this.#opts = opts;
    this.#plan = plan;
    this.specs = specs;
  }

  /**
   * The tools for `req`; for Workspace access only when the sandbox is there (else throws with why). Connectors that
   * don't start are left out, and said so in `startup`.
   */
  static async open(opts: ToolsetOptions): Promise<Toolset> {
    const { req } = opts;
    if (req.toolFree) return new Toolset(opts, null, [...DESCRIBED_ONLY]);
    let plan: SandboxPlan | null = null;
    if (req.access === 'workspace') {
      const problem = sandboxProblem();
      if (problem) throw new Error(problem);
      const shared = req.sharedDirs ?? [];
      plan = {
        cwd: req.cwd,
        writable: [req.cwd, ...shared],
        hidden: req.privatePaths,
        readOnly: [
          ...[req.cwd, ...shared].map((d) => ({ path: join(d, '.claude'), dir: true })),
          ...(req.protectInstructions ? instructionPaths(req.cwd).map((p) => ({ path: p, dir: false })) : []),
        ],
        env: sandboxEnv(req),
      };
    }
    const set = new Toolset(opts, plan, [...NATIVE]);
    await set.#openConnectors(req.mcpServers ?? []);
    return set;
  }

  async #openConnectors(servers: TurnMcpServer[]) {
    const { req } = this.#opts;
    const opened = await Promise.all(
      servers.map(async (s): Promise<{ s: TurnMcpServer; c?: Connector; tools?: { name: string; description?: string | null; inputSchema: Record<string, unknown> | null }[]; err?: string }> => {
        try {
          if (s.kind === 'http') {
            const session = new McpSession(s.url, s.headers, this.#opts.allow, req.signal);
            session.timeoutMs = MCP_START_MS;
            await session.initialize();
            const tools = await session.listTools();
            const c: Connector = {
              name: s.name,
              secrets: session.secrets,
              tools: new Map(),
              call: async (tool, args, _signal, timeoutMs) => {
                session.timeoutMs = timeoutMs;
                const r = await session.callTool(tool, args, this.#opts.redact);
                return { isError: r.isError, text: r.text ?? '', structured: r.structured };
              },
              close: () => {},
            };
            return { s, c, tools };
          }
          const mcp = new StdioMcp({ command: s.command, args: s.args, env: s.env, cwd: s.cwd ?? req.cwd, secrets: s.secrets }, agentEnv({}));
          try {
            await mcp.initialize(MCP_START_MS);
            const tools = await mcp.listTools(MCP_START_MS);
            const c: Connector = { name: s.name, secrets: mcp.secrets, tools: new Map(), call: async (tool, args, _signal, timeoutMs) => {
                const r = await mcp.callTool(tool, args, timeoutMs, this.#opts.redact);
                return { isError: r.isError, text: r.text ?? '', structured: r.structured };
              },
              close: () => mcp.close() };
            return { s, c, tools };
          } catch (err) {
            mcp.close();
            throw err;
          }
        } catch (err) {
          const why = err instanceof McpError && err.kind === 'auth' ? 'the server refused its sign-in' : shorten(this.#opts.redact((err as Error).message), 160);
          return { s, err: `Botons could not start it (${why})` };
        }
      }),
    );
    let count = 0;
    let bytes = 0;
    const redact = this.#opts.redact;
    for (const o of opened) {
      if (!o.c || !o.tools) {
        this.startup.push({ name: o.s.name, started: false, tools: [], reason: o.err });
        continue;
      }
      const names: string[] = [];
      let tooBig = 0;
      for (const t of o.tools) {
        if (count >= MAX_CONNECTOR_TOOLS) break;
        // The connector's own secrets went at its client (cleanTools); the API keys go here. A name holding one can't be called.
        if (redact(t.name) !== t.name || holdsSecret(t.name, o.c.secrets)) continue;
        const name = connectorToolName(o.s.name, t.name);
        if (!NAME.test(name) || this.#byName.has(name)) continue;
        const spec: ToolSpec = {
          name,
          description: `${o.s.name} connector: ${shorten(redact(t.description ?? t.name).replace(/\s+/g, ' '), MAX_DESCRIPTION)}`,
          schema: objectSchema(redactJson(t.inputSchema, redact) as Record<string, unknown> | null),
        };
        const size = Buffer.byteLength(JSON.stringify(spec));
        if (size - Buffer.byteLength(JSON.stringify(spec.description)) > MAX_SCHEMA || bytes + size > MAX_CONNECTOR_SPECS) {
          tooBig++;
          continue;
        }
        bytes += size;
        o.c.tools.set(name, { tool: t.name, spec });
        this.#byName.set(name, { connector: o.c, tool: t.name });
        this.specs.push(spec);
        names.push(t.name);
        count++;
      }
      this.#connectors.push(o.c);
      const reason = tooBig ? `${tooBig} of its tools were left out: their definitions are bigger than a request to the model carries` : undefined;
      this.startup.push(
        names.length
          ? { name: o.s.name, started: true, tools: names, ...(reason ? { reason } : {}) }
          : { name: o.s.name, started: false, tools: [], reason: reason ?? 'Botons connected to it, but it listed no tools' },
      );
    }
  }

  close(): void {
    for (const c of this.#connectors) c.close();
  }

  /** What a call is, for the turn's steps and status. */
  describe(call: ToolCall): { activity: string; step: TurnStep } {
    const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    switch (call.name) {
      case 'shell': {
        const label = `Running \`${shorten(str(input.command), 70)}\``;
        return { activity: label, step: step('command', label, str(input.command)) };
      }
      case 'read_file':
        return { activity: `Reading ${basename(str(input.path) || 'a file')}`, step: step('read', `Reading ${basename(str(input.path) || 'a file')}`, str(input.path)) };
      case 'write_file':
      case 'edit_file':
        return { activity: `Editing ${basename(str(input.path) || 'a file')}`, step: step('edit', `Editing ${basename(str(input.path) || 'a file')}`, str(input.path)) };
      default: {
        const c = this.#byName.get(call.name);
        const label = c ? `Using ${c.connector.name} ${c.tool}` : `Using ${call.name}`;
        return { activity: label, step: step('tool', label, shorten(JSON.stringify(input), 2000)) };
      }
    }
  }

  /** Runs one call; never throws (a failure is the result the model gets). `observe` gets a connector call's result. */
  async run(call: ToolCall, signal: AbortSignal, deadline: number, observe?: (obs: ToolObservation) => void): Promise<ToolOutcome> {
    const input = (call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : null) as Record<string, unknown> | null;
    if (!input) return { text: 'The tool input must be a JSON object.', isError: true, acted: false };
    const left = deadline - Date.now();
    if (left <= 1000) return { text: 'The turn has no time left to run this.', isError: true, acted: false };
    try {
      switch (call.name) {
        case 'shell':
          return await this.#shell(input, signal, left);
        case 'read_file':
          return await this.#read(input, signal, left);
        case 'write_file':
          return await this.#write(input, signal, left);
        case 'edit_file':
          return await this.#edit(input, signal, left);
        default:
          return await this.#connector(call, input, signal, left, observe);
      }
    } catch (err) {
      return { text: `The tool failed: ${shorten(this.#opts.redact((err as Error).message), 300)}`, isError: true, acted: true };
    }
  }

  #process(argv: string[], o: { signal: AbortSignal; timeoutMs: number; stdin?: string | Buffer; headOnly?: boolean; maxBytes?: number; outside?: boolean }) {
    const { req } = this.#opts;
    const run: RunOptions = {
      argv,
      sandbox: o.outside ? null : this.#plan,
      cwd: req.cwd,
      env: agentEnv(req.env) as Record<string, string>,
      stdin: o.stdin,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      maxBytes: o.maxBytes ?? OUTPUT_MAX,
      headOnly: o.headOnly,
    };
    return runProcess(run);
  }

  async #shell(input: Record<string, unknown>, signal: AbortSignal, left: number): Promise<ToolOutcome> {
    const command = input.command;
    if (typeof command !== 'string' || !command.trim()) return { text: 'command must be a non-empty string.', isError: true, acted: false };
    const asked = typeof input.timeout_seconds === 'number' && input.timeout_seconds > 0 ? input.timeout_seconds * 1000 : SHELL_TIMEOUT_MS;
    const timeoutMs = Math.min(asked, SHELL_MAX_TIMEOUT_MS, left - 500);
    const boton = botonArgv(command);
    let r;
    if (boton && this.#opts.botonCli) r = await this.#process([this.#opts.botonCli, ...boton], { signal, timeoutMs, outside: true });
    else r = await this.#process(['/bin/bash', '-c', command], { signal, timeoutMs });
    const out = r.stdout.toString('utf8');
    const lines = [
      r.timedOut ? `Stopped after ${Math.round(timeoutMs / 1000)} s (its time ran out): what it did until then stands, and may be partial.` : r.aborted ? 'Stopped: the turn was stopped.' : `Exit code ${r.code ?? `none (killed by ${r.signal})`}.`,
      out ? `stdout:\n${out}` : '',
      r.stderr ? `stderr:\n${r.stderr}` : '',
    ].filter(Boolean);
    return { text: this.#opts.redact(lines.join('\n')), isError: r.code !== 0, acted: true };
  }

  #path(input: Record<string, unknown>): string | null {
    const p = input.path;
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
    return isAbsolute(p) ? resolve(p) : resolve(this.#opts.req.cwd, p);
  }

  async #readBytes(path: string, max: number, signal: AbortSignal, timeoutMs: number): Promise<{ ok: true; data: Buffer; more: boolean } | { ok: false; why: string }> {
    const r = await this.#process(['/bin/sh', '-c', 'exec head -c "$1" -- "$2"', 'sh', String(max + 1), path], { signal, timeoutMs, headOnly: true, maxBytes: max + 1 });
    if (r.code !== 0) return { ok: false, why: r.stderr.trim().split('\n').pop()?.replace(/^head: /, '') || `could not read ${path}` };
    return { ok: true, data: r.stdout.subarray(0, max), more: r.stdout.length > max };
  }

  async #read(input: Record<string, unknown>, signal: AbortSignal, left: number): Promise<ToolOutcome> {
    const path = this.#path(input);
    if (!path) return { text: 'path must be a file path.', isError: true, acted: false };
    const r = await this.#readBytes(path, READ_MAX, signal, Math.min(30_000, left));
    if (!r.ok) return { text: this.#opts.redact(r.why), isError: true, acted: false };
    if (r.data.includes(0)) return { text: `${path} is not a text file.`, isError: true, acted: false };
    const text = r.data.toString('utf8');
    return { text: this.#opts.redact(r.more ? `${text}\n[… the file goes on past ${READ_MAX / 1024} KB]` : text), isError: false, acted: false };
  }

  async #writeBytes(path: string, content: string, signal: AbortSignal, left: number): Promise<string | null> {
    const r = await this.#process(['/bin/sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path], { signal, timeoutMs: Math.min(30_000, left), stdin: content });
    return r.code === 0 ? null : r.stderr.trim().split('\n').pop()?.replace(/^sh: \d+: /, '') || `could not write ${path}`;
  }

  async #write(input: Record<string, unknown>, signal: AbortSignal, left: number): Promise<ToolOutcome> {
    const path = this.#path(input);
    if (!path) return { text: 'path must be a file path.', isError: true, acted: false };
    if (typeof input.content !== 'string') return { text: 'content must be text.', isError: true, acted: false };
    if (Buffer.byteLength(input.content) > WRITE_MAX) return { text: `content is over ${WRITE_MAX / 1024} KB: write it in parts with the shell.`, isError: true, acted: false };
    const why = await this.#writeBytes(path, input.content, signal, left);
    return why ? { text: this.#opts.redact(why), isError: true, acted: true } : { text: `Wrote ${path} (${Buffer.byteLength(input.content)} bytes).`, isError: false, acted: true };
  }

  async #edit(input: Record<string, unknown>, signal: AbortSignal, left: number): Promise<ToolOutcome> {
    const path = this.#path(input);
    if (!path) return { text: 'path must be a file path.', isError: true, acted: false };
    const { old_text: from, new_text: to } = input;
    if (typeof from !== 'string' || !from || typeof to !== 'string') return { text: 'old_text (not empty) and new_text must be text.', isError: true, acted: false };
    const r = await this.#readBytes(path, WRITE_MAX, signal, Math.min(30_000, left));
    if (!r.ok) return { text: this.#opts.redact(r.why), isError: true, acted: false };
    if (r.more) return { text: `${path} is over ${WRITE_MAX / 1024} KB: edit it with the shell.`, isError: true, acted: false };
    const text = r.data.toString('utf8');
    const count = text.split(from).length - 1;
    if (count === 0) return { text: 'old_text is not in the file.', isError: true, acted: false };
    if (count > 1 && input.replace_all !== true) return { text: `old_text is in the file ${count} times: give more of it, or set replace_all.`, isError: true, acted: false };
    const next = input.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to);
    const why = await this.#writeBytes(path, next, signal, left);
    return why ? { text: this.#opts.redact(why), isError: true, acted: true } : { text: `Edited ${path} (${count} replacement${count > 1 ? 's' : ''}).`, isError: false, acted: true };
  }

  async #connector(call: ToolCall, input: Record<string, unknown>, signal: AbortSignal, left: number, observe?: (obs: ToolObservation) => void): Promise<ToolOutcome> {
    const found = this.#byName.get(call.name);
    if (!found) return { text: `There is no tool named ${call.name}.`, isError: true, acted: false };
    const timeoutMs = Math.min(MCP_CALL_MS, left - 500);
    let r;
    try {
      r = await found.connector.call(found.tool, input, signal, timeoutMs);
    } catch (err) {
      // Sent and not answered: it may have run.
      return { text: this.#opts.redact(`${found.connector.name} did not answer (${shorten(this.#opts.redact((err as Error).message), 200)}): the call may or may not have run.`), isError: true, acted: true };
    }
    // The connector's secrets and the API keys are out of its text already, before it was cut (cleanResult); the
    // structured part has the keys taken out here, before it is serialized and cut.
    const structured = r.structured ? (redactJson(r.structured, this.#opts.redact) as Record<string, unknown>) : null;
    try {
      observe?.({ callId: call.id, server: found.connector.name, tool: found.tool, ok: !r.isError, structured });
    } catch {}
    const json = structured ? JSON.stringify(structured) : '';
    const text = r.text || (structured ? (json.length > OUTPUT_MAX ? `${json.slice(0, OUTPUT_MAX)}\n[… cut at ${OUTPUT_MAX / 1024} KB]` : json) : r.isError ? 'The tool reported an error.' : '(no output)');
    return { text: this.#opts.redact(text), isError: r.isError, acted: true };
  }
}

/** What a sandboxed command's environment holds: the agent CLIs' inherited variables, a /tmp and nothing of the server. */
function sandboxEnv(req: TurnRequest): Record<string, string> {
  const env = agentEnv({}) as Record<string, string>;
  // No token or API address: nothing in the sandbox can reach the Botons API (it has no network anyway).
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && k !== 'CLAUDE_CONFIG_DIR' && k !== 'CODEX_HOME') out[k] = v;
  out.TMPDIR = '/tmp';
  Object.assign(out, withLegacyTurnNames({ BOTON_WORKSPACE: req.cwd }));
  // The server's own Node first: a version manager's shims need files the sandbox doesn't show.
  out.PATH = [dirname(process.execPath), ...(out.PATH ?? '/usr/bin:/bin').split(':').filter((d) => d && d !== dirname(process.execPath))].join(':');
  return out;
}

/** The tools' names and schemas, hashed: when they change, a provider may refuse reasoning made under the old ones. */
export function toolsKey(specs: ToolSpec[]): string {
  return createHash('sha256').update(JSON.stringify(specs.map((s) => [s.name, s.description, s.schema]))).digest('hex').slice(0, 16);
}
