import { cliTurn } from './cli-turn.ts';
import { earlierEnvNames } from '../../../shared/legacy-names.mjs';
import { cliHome, prepareCliHomes } from '../cli-homes.ts';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelEfforts } from '../../../shared/effort.ts';
import type { ProviderModel, TurnStep } from '../../../shared/types.ts';
import { instructionPaths } from '../instructions.ts';
import { log } from '../log.ts';
import { parseJson, seconds, shorten } from '../util.ts';
import { type CliCheck, CliChecker, terminalVersion, checkCodexCli, cliStatus, NOT_CHECKED } from './cli-check.ts';
import { classifyFailure } from './failures.ts';
import { agentEnv, failureMessage, INHERITED_ENV, runJsonl, withExit } from './process.ts';
import {
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

const codexHome = () => cliHome('codex').selected;

const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,23}$/;

/** A model's reasoning levels as Codex's model list gives them (supported_reasoning_levels[].effort), when it does. */
export function codexModel(m: any): ProviderModel {
  const out: ProviderModel = { id: m.slug, label: m.display_name || m.slug };
  const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => l?.effort).filter((e: unknown): e is string => typeof e === 'string' && EFFORT_NAME.test(e)) : [];
  if (levels.length) out.efforts = [...new Set<string>(levels)];
  if (typeof m.default_reasoning_level === 'string' && EFFORT_NAME.test(m.default_reasoning_level)) out.defaultEffort = m.default_reasoning_level;
  return out;
}

function cachedModels(): ProviderModel[] {
  try {
    const data = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8'));
    return (data.models ?? []).filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string').map(codexModel);
  } catch {
    return [];
  }
}

const toml = (s: string) => JSON.stringify(s); // JSON strings are valid TOML basic strings
const tomlList = (list: string[]) => `[${list.map(toml).join(',')}]`;
/** Codex reads both timeouts as floats. */
const tomlFloat = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const tomlTable = (entries: [string, string][]) => `{${entries.map(([k, v]) => `${toml(k)}=${toml(v)}`).join(',')}}`;

/** Set by the agent environment already, so a server's own value for one can't go through it. */
const AGENT_VARS = new Set([...INHERITED_ENV, ...['BOTONS_API', 'BOTON_BOT_ID', 'BOTON_TOKEN', 'BOTON_WORKSPACE', 'BOTONS_NODE'].flatMap((k) => [k, ...earlierEnvNames(k)])]);
const isAgentVar = (k: string) => AGENT_VARS.has(k) || k.startsWith('LC_') || k.startsWith('BOTONS_MCP_');

/** Why codexMcp can't pass `s`, given the variables the servers before it took, or null. */
function codexMcpProblem(s: TurnMcpServer, vars: Record<string, string>): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.name)) return 'Codex server names may only use letters, digits, - and _';
  if (s.kind === 'http' && s.sse) return 'Codex does not support SSE servers';
  if (s.kind === 'stdio') {
    for (const [k, v] of Object.entries(s.env)) if (!isAgentVar(k) && vars[k] !== undefined && vars[k] !== v) return `another server needs a different ${k}`;
  }
  return null;
}

function fitCodexMcp(servers: TurnMcpServer[]): { servers: TurnMcpServer[]; skipped: { name: string; reason: string }[] } {
  const out: TurnMcpServer[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const vars: Record<string, string> = {};
  for (const s of servers) {
    const why = codexMcpProblem(s, vars);
    if (why) {
      skipped.push({ name: s.name, reason: why });
      continue;
    }
    if (s.kind === 'stdio') for (const [k, v] of Object.entries(s.env)) if (!isAgentVar(k)) vars[k] = v;
    out.push(s);
  }
  return { servers: out, skipped };
}

/**
 * `-c mcp_servers.<name>.…` overrides with the secrets off the command line: they go through the codex process's
 * environment (env_vars, env_http_headers), and the agent's shell commands don't inherit them.
 */
export function codexMcp(servers: TurnMcpServer[]): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const fit = fitCodexMcp(servers);
  for (const s of fit.skipped) log.warn('MCP server left out of a codex turn', { server: s.name, reason: s.reason });
  fit.servers.forEach((s, i) => {
    const key = `mcp_servers.${s.name}`;
    const mine: Record<string, string> = {};
    const own: [string, string][] = [];
    if (s.kind === 'stdio') {
      // The turn's token is a secret, so never on the command line: the server reads it from Codex's own environment.
      const forward: string[] = [];
      for (const [k, v] of Object.entries(s.env)) {
        if (k === 'BOTON_TOKEN' || earlierEnvNames('BOTON_TOKEN').includes(k)) forward.push(k);
        else if (isAgentVar(k)) own.push([k, v]);
        else mine[k] = v;
      }
      args.push('-c', `${key}.command=${toml(s.command)}`, '-c', `${key}.args=${tomlList(s.args)}`);
      if (s.cwd) args.push('-c', `${key}.cwd=${toml(s.cwd)}`);
      if (own.length) args.push('-c', `${key}.env=${tomlTable(own)}`);
      if (Object.keys(mine).length || forward.length) args.push('-c', `${key}.env_vars=${tomlList([...Object.keys(mine), ...forward])}`);
    } else {
      const headers: [string, string][] = [];
      Object.entries(s.headers).forEach(([h, v], j) => {
        const name = `BOTONS_MCP_${i}_${j}`;
        mine[name] = v;
        headers.push([h, name]);
      });
      args.push('-c', `${key}.url=${toml(s.url)}`);
      if (headers.length) args.push('-c', `${key}.env_http_headers=${tomlTable(headers)}`);
    }
    if (s.startupTimeoutSec !== undefined) args.push('-c', `${key}.startup_timeout_sec=${tomlFloat(s.startupTimeoutSec)}`);
    if (s.toolTimeoutSec !== undefined) args.push('-c', `${key}.tool_timeout_sec=${tomlFloat(s.toolTimeoutSec)}`);
    args.push('-c', `${key}.default_tools_approval_mode="approve"`);
    Object.assign(env, mine);
  });
  if (Object.keys(env).length) args.push('-c', `shell_environment_policy.exclude=${tomlList(Object.keys(env))}`);
  return { args, env };
}

/** None of the user's Codex setup at any access level; the login in CODEX_HOME still works. */
const CODEX_ISOLATION = [
  '--ignore-user-config',
  '--ignore-rules',
  '--disable',
  'plugins',
  '--disable',
  'remote_plugin',
  '--disable',
  'apps',
  '--disable',
  'tool_suggest',
  '--disable',
  'hooks',
  '-c',
  'skills.include_instructions=false',
  '-c',
  'skills.bundled.enabled=false',
];

function accessArgs(req: Pick<TurnRequest, 'access' | 'privatePaths' | 'sharedDirs' | 'cwd' | 'protectInstructions'>): string[] {
  if (req.access === 'host') return ['--dangerously-bypass-approvals-and-sandbox'];
  // Workspace: a permission profile (sandbox_workspace_write.writable_roots is ignored under one). The network stays
  // on for the `botons` CLI. The .claude folders are read-only, so a Codex Boton can't plant settings or hooks for
  // a Claude Boton; so are the instruction files in a sandboxed turn (a missing file given "read" can't be created).
  const shared = req.sharedDirs ?? [];
  const settingsDirs = [req.cwd, ...shared].map((d) => join(d, '.claude'));
  const instructions = req.protectInstructions ? instructionPaths(req.cwd) : [];
  const filesystem = [
    ...req.privatePaths.map((p) => `${toml(p)}="none"`),
    ...shared.map((p) => `${toml(p)}="write"`),
    ...[...settingsDirs, ...instructions].map((p) => `${toml(p)}="read"`),
  ].join(',');
  return [
    '-c',
    'default_permissions="boton"',
    '-c',
    'permissions.boton.extends=":workspace"',
    '-c',
    'permissions.boton.network.enabled=true',
    '-c',
    `permissions.boton.filesystem={${filesystem}}`,
    '-c',
    'approval_policy="never"',
  ];
}

/** Codex runs each command as `<shell> -lc '<command>'`: take the shell and its quoting off. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh -lc ('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*")$/s.exec(command);
  if (!m) return command;
  const quoted = m[1];
  return quoted.startsWith("'") ? quoted.slice(1, -1).replaceAll("'\\''", "'") : quoted.slice(1, -1).replace(/\\(.)/gs, '$1');
}

export function itemStep(item: any): TurnStep | null {
  const label = describeItem(item) ?? '';
  switch (item?.type) {
    case 'command_execution':
      return step('command', label, unwrapShell(String(item.command ?? '')));
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return step('edit', label, changes.map((c: any) => `${c?.kind ?? 'update'} ${c?.path ?? '?'}`).join('\n'));
    }
    case 'web_search':
      return step('web', label, String(item.query ?? ''));
    case 'mcp_tool_call':
      return step('tool', label, `${item.server ? `${item.server}.` : ''}${item.tool ?? '?'} ${JSON.stringify(item.arguments ?? {})}`);
    default:
      return null;
  }
}

function describeItem(item: any): string | null {
  switch (item?.type) {
    case 'command_execution':
      return `Running \`${shorten(String(item.command ?? '').replace(/^\/usr\/bin\/bash -lc /, ''), 70)}\``;
    case 'reasoning':
      return 'Thinking';
    case 'file_change':
      return 'Editing files';
    case 'web_search':
      return item.query ? `Searching the web for “${shorten(String(item.query), 50)}”` : 'Searching the web';
    case 'mcp_tool_call':
      return `Using ${item.tool ?? 'a tool'}`;
    case 'todo_list':
      return 'Planning';
    case 'agent_message':
      return 'Writing';
    default:
      return null;
  }
}

/** A completed mcp_tool_call item on one of the turn's servers, as an observation; null for anything else. */
export function codexToolResult(item: any, servers: string[]): ToolObservation | null {
  if (item?.type !== 'mcp_tool_call' || typeof item.server !== 'string' || !servers.includes(item.server) || typeof item.tool !== 'string') return null;
  const result = item.result && typeof item.result === 'object' ? item.result : null;
  const sc = result?.structured_content ?? result?.structuredContent;
  let structured = sc && typeof sc === 'object' && !Array.isArray(sc) ? (sc as Record<string, unknown>) : null;
  if (!structured && Array.isArray(result?.content)) {
    for (const b of result.content) {
      if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim().startsWith('{') || b.text.length > 200_000) continue;
      try {
        const v = JSON.parse(b.text);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          structured = v;
          break;
        }
      } catch {}
    }
  }
  const ok = item.status === 'completed' && !item.error && result?.is_error !== true && result?.isError !== true;
  return { callId: String(item.id ?? ''), server: item.server, tool: item.tool, ok, structured };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Codex's own counts: input includes cached input. */
interface CodexTokens {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function codexTokens(u: any): CodexTokens {
  return { input: count(u?.input_tokens), cached: count(u?.cached_input_tokens), cacheWrite: count(u?.cache_write_input_tokens), output: count(u?.output_tokens) };
}

function asUsage(t: CodexTokens): TurnUsage {
  return { inputTokens: Math.max(0, t.input - t.cached), outputTokens: t.output, cacheReadTokens: t.cached, cacheWriteTokens: t.cacheWrite };
}

/** A thread's latest turn (after the last turn_context line) as its rollout file records it. */
interface RolloutTurn {
  model: string | null;
  /** From its token_usage_record. */
  own: CodexTokens | null;
  /** The thread's running totals at its end. */
  after: CodexTokens | null;
  /** The thread's running totals when it started; null if the part of the file read doesn't reach back to them. */
  before: CodexTokens | null;
}

const ZERO: CodexTokens = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

/** `text` is the end of a rollout file, all of it when `whole` (else its first line may be cut off). */
export function parseRolloutTurn(text: string, whole: boolean): RolloutTurn | null {
  const lines = text.split('\n');
  const parse = (line: string): any => parseJson(line, null);
  const totals = (ev: any): CodexTokens | null => {
    const t = ev?.type === 'event_msg' && ev.payload?.type === 'token_count' ? ev.payload.info?.total_token_usage : null;
    return t && typeof t === 'object' ? codexTokens(t) : null;
  };
  let i = lines.length - 1;
  let context: any = null;
  let after: CodexTokens | null = null;
  const records: any[] = [];
  for (; i >= 0 && !context; i--) {
    const line = lines[i];
    if (line.includes('"turn_context"')) {
      const ev = parse(line);
      if (ev?.type === 'turn_context') context = ev.payload ?? {};
    } else if (line.includes('"token_count"')) {
      after ??= totals(parse(line));
    } else if (line.includes('"token_usage_record"')) {
      const ev = parse(line);
      if (ev?.type === 'token_usage_record') records.push(ev.payload);
    }
  }
  if (!context) return null;
  const model = typeof context.model === 'string' && context.model ? context.model : null;
  // The turn's last record (records are newest first); its turn_token_usage counts every request of the turn.
  const record = records.find((r) => r?.turn_id && r.turn_id === context.turn_id && r.turn_token_usage);
  let before: CodexTokens | null = null;
  for (; i >= 0 && !before; i--) if (lines[i].includes('"token_count"')) before = totals(parse(lines[i]));
  return { model, own: record ? codexTokens(record.turn_token_usage) : null, after, before: before ?? (whole ? ZERO : null) };
}

/** By Codex home and thread id (a resumed thread keeps the file it started in). */
const rollouts = new Map<string, string>();

/** <home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, newest folders first. */
function findRollout(home: string, threadId: string): string | null {
  const key = `${home}\0${threadId}`;
  const known = rollouts.get(key);
  if (known) return known;
  const suffix = `-${threadId}.jsonl`;
  const desc = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const root = join(home, 'sessions');
  for (const y of desc(root)) {
    for (const m of desc(join(root, y))) {
      for (const d of desc(join(root, y, m))) {
        const name = desc(join(root, y, m, d)).find((f) => f.startsWith('rollout-') && f.endsWith(suffix));
        if (!name) continue;
        const path = join(root, y, m, d, name);
        if (rollouts.size >= 200) rollouts.delete(rollouts.keys().next().value!);
        rollouts.set(key, path);
        return path;
      }
    }
  }
  return null;
}

const ROLLOUT_TAILS = [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];

/** The model a turn ran on (`codex exec --json` doesn't say) and its tokens. `needStart`: read back to the turn's start. */
function rolloutTurn(threadId: string, home: string, needStart: boolean): RolloutTurn | null {
  const path = findRollout(home, threadId);
  if (!path) return null;
  let found: RolloutTurn | null = null;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      for (const tail of ROLLOUT_TAILS) {
        const length = Math.min(size, tail);
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, size - length);
        found = parseRolloutTurn(buf.toString('utf8'), length === size) ?? found;
        if ((found && (!needStart || found.own || found.before)) || length === size) break;
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return found;
}

/**
 * `turn.completed` reports the thread's running totals, so in a resumed thread the turn's own usage is its rollout
 * record, else the totals less those it started from (when the rollout agrees with Codex). Null when neither is known.
 */
function completedUsage(reported: any, resumed: boolean, rollout: RolloutTurn | null): TurnUsage | null {
  const total = codexTokens(reported);
  if (!resumed) return asUsage(total);
  if (rollout?.own) return asUsage(rollout.own);
  const { after, before } = rollout ?? {};
  if (!after || !before || after.input !== total.input || after.output !== total.output) return null;
  const own: CodexTokens = { input: total.input - before.input, cached: total.cached - before.cached, cacheWrite: total.cacheWrite - before.cacheWrite, output: total.output - before.output };
  return Object.values(own).every((n) => n >= 0) ? asUsage(own) : null;
}

const MISSING_THREAD = ['no rollout found for thread id', 'thread not found:'];

export function codexArgs(
  req: Pick<TurnRequest, 'systemPrompt' | 'model' | 'effort' | 'sessionId' | 'access' | 'cwd' | 'privatePaths' | 'images' | 'sharedDirs' | 'protectInstructions'>,
  mcpArgs: string[] = [],
): string[] {
  const common = [
    // First: --image takes several values, up to the next option.
    ...(req.images ?? []).flatMap((path) => ['--image', path]),
    '--json',
    '--skip-git-repo-check',
    ...CODEX_ISOLATION,
    ...(req.model ? ['-m', req.model] : []),
    // Over --ignore-user-config, so only this turn's level (or Codex's default for the model) applies.
    ...(req.effort ? ['-c', `model_reasoning_effort=${toml(req.effort)}`] : []),
    ...accessArgs(req),
    ...mcpArgs,
    '-c',
    `developer_instructions=${toml(req.systemPrompt)}`,
  ];
  return req.sessionId ? ['exec', 'resume', ...common, req.sessionId, '-'] : ['exec', ...common, '-C', req.cwd, '-'];
}

export class CodexCliProvider implements Provider {
  id = 'codex-cli';
  label = 'Codex (local CLI)';
  cli = 'codex' as const;
  #bin: string;
  #home: string | undefined;
  #check: CliChecker;
  /** Botons' own copy (managed-clis.ts), not the system's. */
  #managed: boolean;

  /** `home`: where Codex keeps its rollouts; CODEX_HOME, else ~/.codex. */
  constructor(bin: string, home?: string, managed = false) {
    this.#bin = bin;
    this.#home = home;
    this.#managed = managed;
    this.#check = new CliChecker(this.id, async () => { const c = await checkCodexCli(this.#bin); return { ...c, terminal: managed && c.installed ? await terminalVersion('codex-cli', this.#bin) : null }; });
  }

  async info(): Promise<ProviderStatus> {
    return this.#status(await this.#check.get());
  }

  snapshot(): ProviderStatus {
    return this.#status(this.#check.peek());
  }

  #status(c: CliCheck | null): ProviderStatus {
    return {
      id: this.id,
      label: this.label,
      kind: 'cli',
      ...cliStatus(c ?? NOT_CHECKED),
      ...(c ? {} : { checkedAt: null }),
      copy: { managed: this.#managed, terminal: c?.terminal ?? null },
      models: [{ id: '', label: 'Codex default' }, ...cachedModels()],
      defaultModel: '',
    };
  }

  recheck(): void {
    this.#check.invalidate();
  }

  /** The levels models_cache.json lists for the model; null when it isn't there or lists none (Codex's default model: ""). */
  modelEfforts(model: string): ModelEfforts | null {
    const m = model ? cachedModels().find((x) => x.id === model) : undefined;
    return m?.efforts?.length ? { model, label: m.label, levels: m.efforts, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}) } : null;
  }

  fitMcpServers = fitCodexMcp;

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    prepareCliHomes();
    // No toolFree here (Provider.toolFree): a Codex turn can't be given no tools, so it is refused, never run with them.
    if (req.toolFree) throw new Error("Codex can't run a turn with no tools");
    if (req.signal.aborted) throw new ProviderError('Stopped.');
    const compatibility = await this.#check.get();
    if (req.signal.aborted) throw new ProviderError('Stopped.');
    if (!compatibility.installed || !compatibility.version || compatibility.problem === 'incompatible-version') throw new ProviderError(compatibility.reason ?? 'Could not verify the Codex version; check the server executable and retry.');
    if (req.access === 'workspace' && compatibility.workspaceProblem) throw new ProviderError(compatibility.workspaceProblem);
    let sessionId: string | null = req.sessionId;
    let lastMessage = '';
    let completed = false;
    let reported: unknown = null;
    let turnFailure: string | null = null;
    // Codex also sends errors it recovers from (a dropped stream), so they only fail a turn that never completes.
    const errors: string[] = [];
    // The thread was found and the turn got going.
    let activity = false;
    // An item starts, then completes: one step.
    const stepped = new Set<string>();
    // `codex exec --json` says nothing of MCP startup: a tool call it ran on a server is the only sign it started.
    const servers = (req.mcpServers ?? []).map((s) => s.name);
    const called = new Set<string>();

    const mcp = codexMcp(req.mcpServers ?? []);
    const snapshot = cliTurn(req, 'codex', mcp.env);
    const run = await runJsonl(this.#bin, codexArgs(snapshot.req, mcp.args), {
      cwd: req.cwd,
      groupDir: req.groupDir,
      env: snapshot.env,
      stdin: req.prompt,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
      onEvent: (ev) => {
        if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
        else if (ev.type === 'turn.started') activity = true;
        else if (ev.type === 'item.started' || ev.type === 'item.completed') {
          activity = true;
          if (ev.type === 'item.completed' && ev.item?.type === 'mcp_tool_call' && ev.item.status === 'completed' && servers.includes(ev.item.server)) called.add(ev.item.server);
          if (ev.type === 'item.completed' && req.onToolResult) {
            const obs = codexToolResult(ev.item, servers);
            if (obs) {
              try {
                req.onToolResult(obs);
              } catch (err) {
                log.warn('could not record a tool result', { provider: 'codex-cli', err });
              }
            }
          }
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
            lastMessage = ev.item.text;
            if (lastMessage.trim()) req.onText?.(lastMessage);
          }
          const a = describeItem(ev.item);
          if (a) req.onActivity(a);
          const id = String(ev.item?.id ?? '');
          if (!stepped.has(id)) {
            const s = itemStep(ev.item);
            if (s) {
              if (id) stepped.add(id);
              req.onStep?.(s);
            }
          }
        } else if (ev.type === 'turn.completed') {
          completed = true;
          if (ev.usage) reported = ev.usage;
        } else if (ev.type === 'turn.failed') turnFailure = ev.error?.message ?? 'Codex turn failed';
        else if (ev.type === 'error') errors.push(String(ev.message ?? 'Codex error'));
      },
      isDone: (ev) => ev?.type === 'turn.completed' && turnFailure === null,
    });

    const failed = turnFailure as string | null;
    const resumed = !!req.sessionId;
    const rollout = sessionId ? rolloutTurn(sessionId, this.#home ?? snapshot.env.CODEX_HOME!, resumed && !!reported) : null;
    const model = rollout?.model ?? (req.model || null);
    const used = reported ? completedUsage(reported, resumed, rollout) : null;
    if (reported && !used) {
      log.warn("codex turn's own tokens are unknown: turn.completed has the thread's running totals, and its rollout doesn't say where this turn started", {
        provider: this.id,
        sessionId: sessionId ?? undefined,
      });
    }
    const mcpStartup = called.size ? [...called].map((name) => ({ name, started: true, tools: null })) : undefined;
    const turnUsage = used || model ? { ...(used ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), ...(model ? { model } : {}) } : null;
    // A turn it completed once stopped or past its time limit doesn't count: that ended the turn first.
    if (completed && !failed && !run.aborted && !run.timedOut) return { sessionId, text: lastMessage, usage: turnUsage, ...(errors.length ? { warnings: errors } : {}), ...(mcpStartup ? { mcpStartup } : {}) };
    const failure = failed ?? errors.at(-1) ?? null;
    const said = `${failure ?? ''}\n${run.stderr}`;
    const lost = !!req.sessionId && !activity && !run.aborted && !run.timedOut && MISSING_THREAD.some((m) => said.includes(m));
    const message = failureMessage('Codex', run, failure);
    // Not stderr for transient failures: Codex logs network noise there on runs that work.
    const info = run.aborted || run.timedOut || lost ? {} : classifyFailure(`${message}\n${said}`, `${failure ?? ''}\n${errors.join('\n')}`);
    const err = withExit(new ProviderError(message, lost, info), run);
    err.usage = turnUsage;
    if (mcpStartup) err.mcpStartup = mcpStartup;
    throw err;
  }
}
