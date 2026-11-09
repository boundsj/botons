import { cliTurn } from './cli-turn.ts';
import { CLI_NAMES } from '../../../shared/legacy-names.mjs';
import { prepareCliHomes } from '../cli-homes.ts';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TurnStep } from '../../../shared/types.ts';
import { totalTokens } from '../../../shared/util.ts';
import { INSTRUCTION_FILES, instructionPaths } from '../instructions.ts';
import { log } from '../log.ts';
import { shorten } from '../util.ts';
import { type CliCheck, CliChecker, terminalVersion, claudeWorkspaceProblem, checkCli, cliStatus, NOT_CHECKED, parseClaudeLogin } from './cli-check.ts';
import { classifyFailure } from './failures.ts';
import { agentEnv, failureMessage, jsonLines, runJsonl, withExit } from './process.ts';
import {
  type McpStartup,
  type Provider,
  ProviderError,
  type ProviderStatus,
  step,
  type TurnMcpServer,
  type ToolObservation,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from './types.ts';

const MODELS = [
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'fable', label: 'Fable (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
];

function describeTool(name: string, input: any): string {
  switch (name) {
    case 'Bash':
      return `Running \`${shorten(String(input?.command ?? ''), 70)}\``;
    case 'Read':
      return `Reading ${basename(String(input?.file_path ?? 'a file'))}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${basename(String(input?.file_path ?? input?.notebook_path ?? 'a file'))}`;
    case 'Glob':
    case 'Grep':
      return 'Searching files';
    case 'WebSearch':
      return `Searching the web for “${shorten(String(input?.query ?? ''), 50)}”`;
    case 'WebFetch':
      try {
        return `Reading ${new URL(String(input?.url)).host}`;
      } catch {
        return 'Reading a web page';
      }
    case 'TodoWrite':
      return 'Planning';
    case 'Task':
    case 'Agent':
      return 'Delegating to a helper';
    default:
      return `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' ')}`;
  }
}

export function toolStep(name: string, input: any): TurnStep | null {
  const label = describeTool(name, input);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash':
      return step('command', label, str(input?.command));
    case 'Read':
      return step('read', label, str(input?.file_path));
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return step('edit', label, str(input?.file_path));
    case 'NotebookEdit':
      return step('edit', label, str(input?.notebook_path));
    case 'Glob':
    case 'Grep':
      return step('search', label, [str(input?.pattern), str(input?.path)].filter(Boolean).join(' in '));
    case 'WebSearch':
      return step('web', label, str(input?.query));
    case 'WebFetch':
      return step('web', label, str(input?.url));
    case 'TodoWrite':
      return null;
    default:
      return step('tool', label, JSON.stringify(input ?? {}));
  }
}

/** Scheduling, messaging and app tools: Botons has its own. */
export const CLAUDE_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
  'SendMessage',
  'ListAgents',
  'SendToProject',
  'SendToProjectContext',
  'Workflow',
  'DesignSync',
  'ReportFindings',
  'EnterWorktree',
  'ExitWorktree',
];

/** The command a turn runs to reach the server, and its deprecated names (shared/legacy-names.mjs). */
const CLI_COMMANDS = ['botons', ...CLI_NAMES];

// `botons mcp`'s permission prompt tool asks the owner. The model can't call it itself (--disallowedTools).
const APPROVAL_SERVER = 'botons';
const APPROVE_TOOL = `mcp__${APPROVAL_SERVER}__approve`;

/** Secrets included. `botons mcp` goes last, so a connector of the same name can't stand in for it. */
export function claudeMcpConfig(servers: TurnMcpServer[], askFirst?: TurnRequest['askFirst']): string {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.kind === 'stdio') out[s.name] = { type: 'stdio', command: s.command, args: s.args, env: s.env };
    else out[s.name] = { type: s.sse ? 'sse' : 'http', url: s.url, headers: s.headers };
  }
  if (askFirst) out[APPROVAL_SERVER] = { type: 'stdio', command: askFirst.command, args: askFirst.args };
  return JSON.stringify({ mcpServers: out });
}

export function claudeMcpRule(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** "//" means from the filesystem root. */
const rulePath = (abs: string) => `/${abs}`;
/** No glob or rule syntax. Every private path still goes in the sandbox's denyRead. */
const plainPath = (abs: string) => !/[()*?[\]{}\\]/.test(abs);

function settings(req: Pick<TurnRequest, 'access' | 'privatePaths' | 'cwd' | 'sharedDirs' | 'askFirst' | 'protectInstructions'>): Record<string, unknown> {
  const base = { autoMemoryEnabled: false, disableAllHooks: true };
  const ask = req.askFirst?.ask.length ? { ask: req.askFirst.ask } : {};
  if (req.access === 'host') return req.askFirst?.ask.length ? { ...base, permissions: ask } : base;
  // Workspace: the .claude folders can't be written, so a Boton can't give itself (or another Boton) settings or
  // hooks; nor, in a sandboxed turn, the instruction files (in subfolders too) every later turn would load.
  const shared = req.sharedDirs ?? [];
  const settingsDirs = [req.cwd, ...shared].map((d) => join(d, '.claude'));
  const instructions = req.protectInstructions ? instructionPaths(req.cwd) : [];
  const nested = req.protectInstructions && plainPath(req.cwd) ? INSTRUCTION_FILES.map((name) => `Edit(${rulePath(req.cwd)}/**/${name})`) : [];
  return {
    ...base,
    permissions: {
      deny: [
        ...req.privatePaths.filter(plainPath).flatMap((p) => [`Read(${rulePath(p)})`, `Read(${rulePath(p)}/**)`]),
        ...settingsDirs.map((d) => `Edit(${rulePath(d)}/**)`),
        ...instructions.filter(plainPath).flatMap((p) => [`Edit(${rulePath(p)})`, `Edit(${rulePath(p)}/**)`]),
        ...nested,
      ],
      ...ask,
      ...(req.askFirst?.allow.length ? { allow: req.askFirst.allow } : {}),
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // The botons CLI (and its deprecated names, for one release) reaches the server on 127.0.0.1 as this turn.
      excludedCommands: CLI_COMMANDS.flatMap((n) => [n, `${n} *`]),
      filesystem: { denyRead: req.privatePaths, ...(shared.length ? { allowWrite: shared } : {}), denyWrite: [...settingsDirs, ...instructions] },
    },
  };
}

/** Workspace: anything not allowed here is denied (or, with Ask first rules, goes to the approve tool). */
function accessArgs(access: TurnRequest['access'], servers: TurnMcpServer[], asks: boolean): string[] {
  if (access === 'host') return ['--dangerously-skip-permissions'];
  return [
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    asks ? 'host' : 'none',
    '--allowedTools',
    ...CLI_COMMANDS.flatMap((n) => [`Bash(${n}:*)`, `Bash(${n} *)`]),
    'WebSearch',
    'WebFetch',
    ...servers.map((s) => claudeMcpRule(s.name)),
  ];
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function messageUsage(u: any): TurnUsage {
  return {
    inputTokens: count(u?.input_tokens),
    outputTokens: count(u?.output_tokens),
    cacheReadTokens: count(u?.cache_read_input_tokens),
    cacheWriteTokens: count(u?.cache_creation_input_tokens),
  };
}

const anyTokens = (u: TurnUsage) => totalTokens(u) > 0;
const noTokens = (): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const combine = (a: TurnUsage, b: TurnUsage, f: (x: number, y: number) => number): TurnUsage => ({
  inputTokens: f(a.inputTokens, b.inputTokens),
  outputTokens: f(a.outputTokens, b.outputTokens),
  cacheReadTokens: f(a.cacheReadTokens, b.cacheReadTokens),
  cacheWriteTokens: f(a.cacheWriteTokens, b.cacheWriteTokens),
});

/** A result's `modelUsage` added up over its models, and the model that wrote the most. */
function modelTotals(result: any): { usage: TurnUsage; top: string | null } {
  const entries = result?.modelUsage && typeof result.modelUsage === 'object' ? Object.entries(result.modelUsage as Record<string, any>) : [];
  const usage = noTokens();
  let top: { model: string; out: number } | null = null;
  for (const [name, m] of entries) {
    usage.inputTokens += count(m?.inputTokens);
    usage.outputTokens += count(m?.outputTokens);
    usage.cacheReadTokens += count(m?.cacheReadInputTokens);
    usage.cacheWriteTokens += count(m?.cacheCreationInputTokens);
    if (!top || count(m?.outputTokens) > top.out) top = { model: name, out: count(m?.outputTokens) };
  }
  return { usage, top: top?.model ?? null };
}

interface SessionTotals {
  tokens: number;
  costUsd: number;
}

export function sessionTotals(result: any): SessionTotals {
  const cost = result?.total_cost_usd;
  return { tokens: totalTokens(modelTotals(result).usage), costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0 };
}

/**
 * The result's `usage` is this process's (all zeros on failure; then `seen` counts). Its `modelUsage` and
 * `total_cost_usd` are the session's running totals, carried over by --resume: so the cost is total_cost_usd when
 * nothing was carried over, else the difference from `before` when exactly that was carried over, else unknown.
 */
export function claudeUsage(result: any, model: string | null, opts: { resumed: boolean; seen?: TurnUsage | null; before?: SessionTotals | null }): TurnUsage | null {
  const { usage: all, top } = modelTotals(result);
  const own = messageUsage(result?.usage);
  let usage: TurnUsage = anyTokens(own) ? own : opts.seen ? { ...opts.seen } : noTokens();
  if (!opts.resumed && anyTokens(all)) usage = all;
  const total = sessionTotals(result);
  if (total.costUsd > 0) {
    const carried = total.tokens - totalTokens(usage);
    if (carried === 0) usage.costUsd = total.costUsd;
    else if (opts.before && carried === opts.before.tokens) {
      // Rounded: a difference of two floats.
      const cost = Math.round((total.costUsd - opts.before.costUsd) * 1e12) / 1e12;
      if (cost > 0) usage.costUsd = cost;
    }
  }
  if (typeof result?.num_turns === 'number') usage.numTurns = result.num_turns;
  const ran = model ?? top;
  if (ran) usage.model = ran;
  return anyTokens(usage) || ran ? usage : null;
}

const MISSING_SESSION = 'No conversation found with session ID';

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A JSON object from a text block (MCP servers repeat structuredContent as JSON text); never prose. */
function jsonText(content: unknown): Record<string, unknown> | null {
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  for (const b of blocks) {
    const text = (b as { type?: unknown; text?: unknown })?.type === 'text' ? (b as { text: unknown }).text : null;
    if (typeof text !== 'string' || !text.trim().startsWith('{') || text.length > 200_000) continue;
    try {
      const v = asObject(JSON.parse(text));
      if (v) return v;
    } catch {}
  }
  return null;
}

/** Which of the turn's servers an `mcp__<server>__<tool>` name is (the longest name that fits), and the tool. */
export function claudeMcpTool(name: string, servers: string[]): { server: string; tool: string } | null {
  let best: { server: string; tool: string } | null = null;
  for (const s of servers) {
    const prefix = `${claudeMcpRule(s)}__`;
    if (name.startsWith(prefix) && name.length > prefix.length && (!best || s.length > best.server.length)) best = { server: s, tool: name.slice(prefix.length) };
  }
  return best;
}

/** A tool_result for one of the turn's MCP calls, as an observation. `raw` is the event's tool_use_result. */
export function claudeToolResult(block: any, call: { server: string; tool: string }, raw: unknown): ToolObservation {
  const r = asObject(raw);
  const structured = asObject(r?.structuredContent) ?? jsonText(Array.isArray(raw) ? raw : r?.content) ?? jsonText(block?.content);
  return { callId: String(block?.tool_use_id ?? ''), server: call.server, tool: call.tool, ok: block?.is_error !== true && r?.isError !== true, structured };
}

/** Claude Code's words for a server it didn't connect, as the owner and the Boton read them. */
function notStarted(status: string): string {
  switch (status) {
    case 'failed':
      return 'Claude Code could not start it';
    case 'needs-auth':
      return 'Claude Code could not start it: the server refused its sign-in';
    case 'pending':
      return 'it was still starting when the turn began, so the turn may not have had its tools';
    case 'disabled':
      return 'Claude Code had it turned off';
    default:
      return /^[a-z-]{1,24}$/.test(status) ? `Claude Code reported it ${status}, not connected` : 'Claude Code did not connect it';
  }
}

/**
 * The turn's servers as its init event shows them (`mcp_servers` with each one's status, and the `mcp__<server>__…`
 * names in `tools`), with a server one of the turn's tool calls ran on (a result that isn't an error) counted as
 * started whatever init said. A call that failed or never got its result leaves init's word on the server.
 */
export function claudeMcpStartup(init: any, servers: string[], called: Set<string>): McpStartup[] {
  const listed: unknown[] = Array.isArray(init?.mcp_servers) ? init.mcp_servers : [];
  const tools: string[] = Array.isArray(init?.tools) ? init.tools.filter((t: unknown): t is string => typeof t === 'string') : [];
  return servers.map((name) => {
    const own = tools.flatMap((t) => {
      const m = claudeMcpTool(t, servers);
      return m?.server === name ? [m.tool] : [];
    });
    const entry = listed.find((e) => (e as { name?: unknown })?.name === name) as { status?: unknown } | undefined;
    const status = typeof entry?.status === 'string' ? entry.status : null;
    if (called.has(name)) return { name, started: true, tools: own };
    if (!entry) return { name, started: false, tools: [], reason: 'Claude Code did not load it' };
    if (status !== 'connected') return { name, started: false, tools: own, reason: notStarted(status ?? '') };
    if (!own.length) return { name, started: false, tools: [], reason: 'Claude Code connected to it, but it listed no tools' };
    return { name, started: true, tools: own };
  });
}

/**
 * None of the user's Claude Code setup at any access level (user settings, MCP servers, skills, slash commands);
 * the login still comes from it (--bare would not use it). `mcpConfig`: a file's path when there are servers.
 */
export function claudeArgs(
  req: Pick<TurnRequest, 'systemPrompt' | 'model' | 'effort' | 'sessionId' | 'access' | 'privatePaths' | 'cwd' | 'mcpServers' | 'sharedDirs' | 'askFirst' | 'protectInstructions' | 'toolFree'>,
  mcpConfig = claudeMcpConfig([], req.askFirst),
): string[] {
  if (req.toolFree) return toolFreeArgs(req);
  const asks = !!req.askFirst;
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    req.systemPrompt,
    '--system-prompt-snapshot',
    'off',
    ...(req.model ? ['--model', req.model] : []),
    // Wins over the settings files; CLAUDE_CODE_EFFORT_LEVEL would win over it, but agentEnv never passes that on.
    ...(req.effort ? ['--effort', req.effort] : []),
    ...(req.sessionId ? ['--resume', req.sessionId] : []),
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--disable-slash-commands',
    '--disallowedTools',
    ...CLAUDE_DISALLOWED_TOOLS,
    ...(asks ? [APPROVE_TOOL] : []),
    '--settings',
    JSON.stringify(settings(req)),
    ...(req.sharedDirs ?? []).flatMap((d) => ['--add-dir', d]),
    ...(asks ? ['--permission-prompt-tool', APPROVE_TOOL] : []),
    ...accessArgs(req.access, req.mcpServers ?? [], asks),
  ];
}

/**
 * A reply with no tools (Claude Code CLI reference): `--tools ""` takes every built-in tool away, `--disallowedTools
 * "*"` removes every tool from the model's context (MCP tools included), no MCP server is given, skills and commands
 * are off, and a prompt for a tool is denied, never asked. These are flags of this process, so they hold on the
 * resumed session too; a CLI that doesn't know one of them fails the turn rather than run it with tools. The same
 * session, system prompt, model and effort as the Boton's turns, so it resumes the session they keep.
 */
function toolFreeArgs(req: Pick<TurnRequest, 'systemPrompt' | 'model' | 'effort' | 'sessionId' | 'access' | 'privatePaths' | 'cwd'>): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    req.systemPrompt,
    '--system-prompt-snapshot',
    'off',
    ...(req.model ? ['--model', req.model] : []),
    ...(req.effort ? ['--effort', req.effort] : []),
    ...(req.sessionId ? ['--resume', req.sessionId] : []),
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--mcp-config',
    claudeMcpConfig([]),
    '--disable-slash-commands',
    '--tools',
    '',
    '--disallowedTools',
    '*',
    '--settings',
    JSON.stringify(settings({ access: 'workspace', privatePaths: req.privatePaths, cwd: req.cwd, sharedDirs: [], protectInstructions: true })),
    '--permission-mode',
    'default',
    '--permission-prompts',
    'none',
  ];
}

/** So a leak of the user's setup into Botons shows in the log. */
function logNewSession(ev: any) {
  const names = (list: unknown) => (Array.isArray(list) ? list.map((x: any) => (typeof x === 'string' ? x : String(x?.name ?? '?'))) : []);
  const skills = names(ev.skills);
  log.info('new claude session', {
    provider: 'claude-cli',
    sessionId: ev.session_id,
    model: ev.model,
    tools: names(ev.tools),
    mcpServers: names(ev.mcp_servers),
    ...(skills.length ? { skills } : {}),
  });
}

export class ClaudeCliProvider implements Provider {
  id = 'claude-cli';
  label = 'Claude (local CLI)';
  cli = 'claude' as const;
  askFirst = true;
  toolFree = true;
  #bin: string;
  #check: CliChecker;
  /** Botons' own copy (managed-clis.ts), not the system's. */
  #managed: boolean;
  /** Each session's running totals after its last turn here, for the next turn's cost. */
  #totals = new Map<string, SessionTotals>();

  constructor(bin: string, managed = false) {
    this.#bin = bin;
    this.#managed = managed;
    this.#check = new CliChecker(this.id, async () => { const c = await checkCli(this.#bin, ['auth', 'status'], parseClaudeLogin); return { ...c, workspaceProblem: c.installed ? claudeWorkspaceProblem() : null, terminal: managed && c.installed ? await terminalVersion('claude-cli', this.#bin) : null }; });
  }

  async info(): Promise<ProviderStatus> {
    return this.#status(await this.#check.get());
  }

  snapshot(): ProviderStatus {
    return this.#status(this.#check.peek());
  }

  #status(c: CliCheck | null): ProviderStatus {
    return { id: this.id, label: this.label, kind: 'cli', ...cliStatus(c ?? NOT_CHECKED), ...(c ? {} : { checkedAt: null }), copy: { managed: this.#managed, terminal: c?.terminal ?? null }, models: MODELS, defaultModel: 'sonnet', askFirst: true };
  }

  recheck(): void {
    this.#check.invalidate();
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    prepareCliHomes();
    if (req.toolFree && (req.mcpServers?.length || req.askFirst)) throw new Error('A tool-free turn takes no MCP servers or Ask first rules');
    let sessionId: string | null = req.sessionId;
    let final: any = null;
    let lastText = '';
    // The model did something, so the session was found even if the run then failed.
    let activity = false;
    // The session's model, and each API response's usage by message id, for a turn that ends without a result.
    let model: string | null = null;
    const responses = new Map<string, TurnUsage>();
    const saw = (id: string, u: any) => {
      const prev = responses.get(id);
      responses.set(id, prev ? combine(prev, messageUsage(u), Math.max) : messageUsage(u));
    };
    // The message each stream (the Boton's, a subagent's) is writing, for its message_delta's usage.
    const writing = new Map<string, string>();
    let streamed: string | null = null;
    let draft = '';
    const tools = new Set<string>();
    // The turn's MCP calls by tool_use id, until their results come.
    const calls = new Map<string, { server: string; tool: string }>();
    // The turn's own init event (a subagent's has a parent tool call), and the servers a tool call ran on: a request
    // alone proves nothing (Claude Code connects a server with cached tools on its first call, which can fail).
    let init: any = null;
    const called = new Set<string>();

    const servers = req.mcpServers ?? [];
    const serverNames = servers.map((s) => s.name);
    let mcpFile: string | undefined;
    if (servers.length) {
      if (!req.privateDir) throw new Error('privateDir is required for a turn with MCP servers');
      // Secrets: a new file only the server's user can read, in a folder Workspace Botons can't, never on argv.
      mcpFile = join(req.privateDir, `mcp-${randomBytes(9).toString('hex')}.json`);
      writeFileSync(mcpFile, claudeMcpConfig(servers, req.askFirst), { mode: 0o600, flag: 'wx' });
    }
    const snapshot = cliTurn(req, 'claude', { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' });
    const run = await runJsonl(this.#bin, claudeArgs(snapshot.req, mcpFile), {
      cwd: req.cwd,
      groupDir: req.groupDir,
      env: snapshot.env,
      stdin: req.prompt,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      onEvent: (ev) => {
        if (typeof ev.session_id === 'string') sessionId = ev.session_id;
        if (ev.type === 'system' && ev.subtype === 'init') {
          if (ev.parent_tool_use_id == null) init ??= ev;
          if (typeof ev.model === 'string' && ev.model) model = ev.model;
          if (!req.sessionId) logNewSession(ev);
        }
        if (ev.type === 'assistant' || ev.type === 'user') activity = true;
        if (ev.type === 'assistant' && ev.message?.usage && typeof ev.message.id === 'string') {
          saw(ev.message.id, ev.message.usage);
          if (!model && typeof ev.message.model === 'string') model = ev.message.model;
        }
        if (ev.type === 'stream_event') {
          const e = ev.event;
          const stream = String(ev.parent_tool_use_id ?? '');
          if (e?.type === 'message_start' && typeof e.message?.id === 'string') {
            writing.set(stream, e.message.id);
            if (e.message.usage) saw(e.message.id, e.message.usage);
          } else if (e?.type === 'message_delta' && e.usage && writing.has(stream)) saw(writing.get(stream)!, e.usage);
        }
        // Subagents' messages have a parent tool call; only the Boton's own text is its reply.
        const top = ev.parent_tool_use_id == null;
        if (ev.type === 'stream_event' && top) {
          const e = ev.event;
          if (e?.type === 'message_start') {
            streamed = typeof e.message?.id === 'string' ? e.message.id : null;
            draft = '';
          } else if (e?.type === 'content_block_start' && e.content_block?.type === 'text') req.onActivity('Writing');
          else if (e?.type === 'content_block_start' && e.content_block?.type === 'thinking') req.onActivity('Thinking');
          else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
            draft += e.delta.text;
            req.onText?.(draft);
          }
        } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              const mcp = typeof block.name === 'string' && typeof block.id === 'string' ? claudeMcpTool(block.name, serverNames) : null;
              if (mcp) calls.set(block.id, mcp);
              req.onActivity(describeTool(block.name, block.input));
              if (typeof block.id === 'string' && tools.has(block.id)) continue;
              tools.add(block.id);
              const s = toolStep(String(block.name ?? ''), block.input);
              if (s) req.onStep?.(s);
            } else if (block.type === 'thinking') req.onActivity('Thinking');
            else if (block.type === 'text' && block.text?.trim() && top) {
              lastText = block.text;
              req.onActivity('Writing');
              // Already streamed as deltas, or a message that came whole.
              if (ev.message.id !== streamed) {
                draft = block.text;
                req.onText?.(draft);
              }
            }
          }
        } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            const call = block?.type === 'tool_result' ? calls.get(String(block.tool_use_id)) : undefined;
            if (!call) continue;
            calls.delete(String(block.tool_use_id));
            const obs = claudeToolResult(block, call, ev.tool_use_result);
            // Claude Code's stream doesn't mark an error result as the server's own or its failure to reach the
            // server, so only a result that isn't an error shows the server ran the call.
            if (obs.ok) called.add(call.server);
            if (!req.onToolResult) continue;
            try {
              req.onToolResult(obs);
            } catch (err) {
              log.warn('could not record a tool result', { provider: 'claude-cli', err });
            }
          }
        } else if (ev.type === 'result') final = ev;
      },
      isDone: (ev) => ev?.type === 'result' && ev.subtype === 'success' && !ev.is_error,
    }).finally(() => {
      if (mcpFile) rmSync(mcpFile, { force: true });
    });

    // Nothing to tell when the CLI never got as far as its init event.
    const mcpStartup = servers.length && init ? claudeMcpStartup(init, serverNames, called) : undefined;
    const seen = [...responses.values()].reduce((sum, u) => combine(sum, u, (x, y) => x + y), noTokens());
    const usage = final
      ? claudeUsage(final, model, { resumed: !!req.sessionId, seen: withModel(seen, null), before: sessionId ? this.#totals.get(sessionId) : null })
      : withModel(seen, model);
    if (final && sessionId) {
      this.#totals.delete(sessionId);
      if (this.#totals.size >= 500) this.#totals.delete(this.#totals.keys().next().value!);
      this.#totals.set(sessionId, sessionTotals(final));
    }
    const text = typeof final?.result === 'string' ? final.result : '';
    const isError = !!final?.is_error;
    const subtype = final?.subtype ?? '';
    // A result it wrote once stopped or past its time limit doesn't count: that ended the turn first.
    if (final && !isError && subtype === 'success' && !run.aborted && !run.timedOut) return { sessionId, text: text || lastText, usage, ...(mcpStartup ? { mcpStartup } : {}) };
    const errors = final && Array.isArray(final.errors) ? final.errors.filter((e: unknown) => typeof e === 'string').join('\n') : '';
    const lost = !!req.sessionId && !activity && !run.aborted && !run.timedOut && `${errors}\n${run.stderr}`.includes(MISSING_SESSION);
    const detail = isError ? text || errors || `Claude returned ${subtype}` : null;
    const message = failureMessage('Claude', run, detail);
    // Claude's stderr is quiet on a normal run, so with no result event it is the failure itself.
    const info = run.aborted || run.timedOut || lost ? {} : classifyFailure(`${message}\n${errors}\n${run.stderr}`, final ? `${detail ?? ''}\n${errors}` : `${message}\n${run.stderr}`);
    const err = withExit(new ProviderError(message, lost, info), run);
    err.usage = usage;
    if (mcpStartup) err.mcpStartup = mcpStartup;
    throw err;
  }
}

/** The usage, or null when it has no tokens and no model. */
function withModel(usage: TurnUsage, model: string | null): TurnUsage | null {
  if (model) usage.model = model;
  return anyTokens(usage) || model ? usage : null;
}
