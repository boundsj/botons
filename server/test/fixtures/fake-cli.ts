// A stand-in for the claude and codex CLIs: each call replays a fixture recorded from the real CLI (stdout lines,
// stderr, exit code) and records how it was called. Recorded fixtures replace home paths and account details with
// placeholders.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeGiven, codexGiven, type GivenServer, type Session, type Started, startServers } from './fake-cli-mcp.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface Fixture {
  about: string;
  recorded: string;
  argv: string[];
  stdin: string;
  exitCode: number | 'timeout';
  stderr: string;
  stdout: unknown[];
}

/**
 * Replay `fixture` ("claude/reply"), or only its first `lines` stdout lines; `hang`: then wait to be killed. `lateResult`
 * (with `hang` and `lines`): on SIGTERM it writes the fixture's other lines (its successful result) and exits 0, as a CLI
 * that finishes its turn while it shuts down. `linger` (without `lines`): it writes the whole fixture, result and all, then
 * waits to be killed, as a CLI that doesn't exit once its turn is over.
 */
export interface Step {
  fixture: string;
  hang?: boolean;
  /** Wait this long (once the call is recorded) before replaying, as a CLI whose turn takes a while. */
  delayMs?: number;
  lines?: number;
  lateResult?: boolean;
  linger?: boolean;
  /**
   * It starts the MCP servers the turn was given, as the CLI would, before replaying: Claude Code's init event then lists
   * each with its status and tools; Codex's output says nothing of them (its exec --json has no such event). `waitMs`:
   * how long the CLI waits for a server (Codex: its startup_timeout_sec, else 30 s; Claude Code: 5 s, then pending).
   * `call`: the model calls one of its tools, if the server started, and the call is replayed in the CLI's shape.
   * `cached` (Claude Code only): it has these tools cached for every server, so it starts none before the turn (init
   * lists each `pending` with the cached tools) and connects one on its first tool call, which fails when the connect
   * does. `noResult`: the call's result never comes (the turn ends first).
   */
  mcp?: {
    waitMs?: number;
    call?: { server: string; tool: string; arguments?: Record<string, unknown> };
    /** Several calls, one after another in the same turn (each waits for the one before), replayed in order. */
    calls?: { server: string; tool: string; arguments?: Record<string, unknown> }[];
    cached?: string[];
    noResult?: boolean;
  };
}

export interface Call {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  /** The --mcp-config file's contents (it is deleted when the turn ends). */
  mcpConfigFile?: string;
  /** What starting each MCP server it was given came to (none given: left out). */
  mcp?: Record<string, Started>;
  /** What each tool call it made got back, in order: its text and whether it was an error. */
  mcpResults?: { tool: string; isError: boolean; text: string }[];
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(here, `${name}.json`), 'utf8'));
}

export interface FakeCli {
  bin: string;
  /** Call N runs steps[N] (the last step repeats). Clears the recorded calls. */
  script(...steps: Array<Step | string>): void;
  /** What `auth status` / `login status` replays from now on. */
  login(fixture: string): void;
  version(value: string): void;
  /**
   * Every time it was asked for its own MCP setup (`mcp …`, or Claude Code's mcp_status control request) since it was
   * made: Botons never does, so tests expect none. It answers each with an error.
   */
  mcpReads(): string[][];
  /** Calls since the last script(), oldest first (checks are not recorded). */
  calls(): Call[];
  /** Every check run since it was made (`--version`, `auth status`, `login status`), oldest first. */
  checks(): string[];
  /** How many calls since the last script() have written what a `hang` step writes and now only wait for a signal. */
  hanging(): number;
}

export function fakeCli(dir: string, name: string): FakeCli {
  const bin = join(dir, name);
  const configPath = join(dir, `${name}.config.json`);
  const record = join(dir, `${name}.calls.jsonl`);
  const reads = join(dir, `${name}.mcp-reads.jsonl`);
  const hung = join(dir, `${name}.hanging`);
  const checks = join(dir, `${name}.checks.log`);
  writeFileSync(reads, '');
  writeFileSync(checks, '');
  // A node shebang, not a shell script, so the fake sees exactly the environment the provider passed.
  writeFileSync(
    bin,
    `#!${process.execPath} --no-warnings\nimport(${JSON.stringify(import.meta.url)}).then((m) => m.main(${JSON.stringify(configPath)}));\n`,
  );
  chmodSync(bin, 0o755);
  let steps: Step[] = [];
  let login = name === 'codex' ? 'codex/login-status-logged-in' : 'claude/auth-status-logged-in';
  let version = name === 'codex' ? 'codex-cli 0.166.0' : '0.0.0 (fake)';
  const save = () => writeFileSync(configPath, JSON.stringify({ record, reads, hung, checks, steps, login, version }));
  const script = (...next: Array<Step | string>) => {
    steps = next.map((s) => (typeof s === 'string' ? { fixture: s } : s));
    save();
    writeFileSync(record, '');
    writeFileSync(hung, '');
  };
  script('claude/reply');
  return {
    bin,
    script,
    login(fixture: string) {
      login = fixture;
      save();
    },
    version(value: string) { version = value; save(); },
    mcpReads: () =>
      readFileSync(reads, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
    calls: () =>
      readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call),
    hanging: () => readFileSync(hung, 'utf8').length,
    checks: () => readFileSync(checks, 'utf8').split('\n').filter(Boolean),
  };
}

export async function main(configPath: string): Promise<void> {
  const argv = process.argv.slice(2);
  const { record, reads, hung, checks, steps, login, version } = JSON.parse(readFileSync(configPath, 'utf8')) as { record: string; reads: string; hung: string; checks: string; steps: Step[]; login: string; version: string };
  const command = argv.join(' ');
  if (argv[0] === '--version') {
    appendFileSync(checks, `${command}\n`);
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.includes('model_provider="preflight"')) { console.log(JSON.stringify({ type: 'thread.started' })); return; }
  if (argv[0] === 'sandbox') { console.log('BOTONS_WORKSPACE_PROBE_OK'); return; }
  if (command === 'auth status' || command === 'login status') {
    appendFileSync(checks, `${command}\n`);
    replay(loadFixture(login));
    return;
  }
  const prior = existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).length : 0;
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  // Its own MCP setup: `claude mcp …` / `codex mcp …`, or Claude Code's control protocol (which can ask mcp_status).
  if (argv[0] === 'mcp' || argv[argv.indexOf('--input-format') + 1] === 'stream-json') {
    appendFileSync(reads, `${JSON.stringify(argv)}\n`);
    process.stderr.write('fake CLI: Botons must not read the CLI\'s own MCP setup\n');
    process.exitCode = 2;
    return;
  }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;
  const mcpConfig = argv[argv.indexOf('--mcp-config') + 1];
  const mcpConfigFile = argv.includes('--mcp-config') && existsSync(mcpConfig) ? readFileSync(mcpConfig, 'utf8') : undefined;
  const step = steps[Math.min(prior, steps.length - 1)];
  const fx = loadFixture(step.fixture);
  // Like the real CLIs, it starts every server it was given.
  const cli = argv[0] === 'exec' ? 'codex' : 'claude';
  const given = cli === 'codex' ? codexGiven(argv, env) : claudeGiven(argv);
  const mcpResults: NonNullable<Call['mcpResults']> = [];
  const mcp = given.length ? await withMcp(fx, step.mcp ?? {}, cli, given, mcpResults) : undefined;
  appendFileSync(record, `${JSON.stringify({ argv, cwd: process.cwd(), env, stdin, mcpConfigFile, mcp, ...(mcpResults.length ? { mcpResults } : {}) } satisfies Call)}\n`);

  if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  const rest = step.lines !== undefined ? fx.stdout.slice(step.lines) : [];
  if (step.lines !== undefined) fx.stdout = fx.stdout.slice(0, step.lines);
  if (step.hang || step.linger) {
    replay(fx, false);
    if (step.lateResult) {
      process.on('SIGTERM', () => {
        for (const line of rest) process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
        process.stdout.end(() => process.exit(0));
      });
    }
    // Like a busy CLI, it outlives a server that dies (a broken output pipe is no reason to stop): only a signal ends it.
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    setInterval(() => {}, 60_000);
    // Written (stdout to a pipe is synchronous here) and its handlers set: a stop from now on finds all of it.
    appendFileSync(hung, '.');
    return;
  }
  replay(fx);
}

function replay(fx: Fixture, exit = true): void {
  for (const line of fx.stdout) process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  process.stderr.write(fx.stderr);
  if (exit) process.exitCode = typeof fx.exitCode === 'number' ? fx.exitCode : 1;
}

const claudeName = (server: string, tool: string) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__${tool}`;

/** Starts the turn's servers and puts what the CLI would show of them into the fixture's output. */
async function withMcp(fx: Fixture, opts: NonNullable<Step['mcp']>, cli: 'claude' | 'codex', given: GivenServer[], results: NonNullable<Call['mcpResults']> = []): Promise<Record<string, Started>> {
  if (cli === 'claude' && opts.cached) return withCachedMcp(fx, opts, given, opts.cached);
  const { started, sessions } = await startServers(
    given,
    (s) => opts.waitMs ?? (cli === 'codex' ? (s.startupTimeoutSec ?? 30) * 1000 : 5000),
    (s, ms) => (cli === 'codex' ? { status: 'failed', tools: [], error: `timed out after ${ms / 1000} seconds` } : { status: 'pending', tools: [] }),
  );
  try {
    const events: Record<string, any>[] = [];
    const calls = (opts.calls ?? (opts.call ? [opts.call] : [])).filter((c) => sessions.has(c.server));
    const done: { call: (typeof calls)[number]; result: Awaited<ReturnType<Session['call']>> }[] = [];
    for (const call of calls) {
      const result = await sessions.get(call.server)!.call(call.tool, call.arguments ?? {});
      done.push({ call, result });
      const text = (result.content as { type?: string; text?: string }[]).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      results.push({ tool: call.tool, isError: !!result.isError, text });
    }
    const lines = fx.stdout as Record<string, any>[];
    if (cli === 'claude') {
      const at = lines.findIndex((l) => l?.type === 'system' && l.subtype === 'init');
      if (at < 0) return started;
      const init = lines[at];
      lines[at] = {
        ...init,
        tools: [...init.tools, ...given.flatMap((s) => started[s.name].tools.map((t) => claudeName(s.name, t)))],
        mcp_servers: given.map((s) => ({ name: s.name, status: started[s.name].status })),
      };
      done.forEach(({ call, result }, i) => {
        const id = i ? `toolu_01FakeMcpCall${i}` : 'toolu_01FakeMcpCall';
        events.push(
          { type: 'assistant', message: { model: init.model, id: i ? `msg_01FakeMcpCall${i}` : 'msg_01FakeMcpCall', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: claudeName(call.server, call.tool), input: call.arguments ?? {} }] }, parent_tool_use_id: null, session_id: init.session_id },
          {
            type: 'user',
            message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: result.content, ...(result.isError ? { is_error: true } : {}) }] },
            parent_tool_use_id: null,
            session_id: init.session_id,
            tool_use_result: { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) },
          },
        );
      });
      lines.splice(at + 1, 0, ...events);
    } else if (done.length) {
      const at = lines.findIndex((l) => l?.type === 'turn.started');
      done.forEach(({ call, result }, i) => {
        const item = { id: i ? `item_fake_mcp_${i}` : 'item_fake_mcp', type: 'mcp_tool_call', server: call.server, tool: call.tool, arguments: call.arguments ?? {} };
        events.push(
          { type: 'item.started', item: { ...item, status: 'in_progress', result: null, error: null } },
          result.isError
            ? { type: 'item.completed', item: { ...item, status: 'failed', result: null, error: { message: JSON.stringify(result.content) } } }
            : { type: 'item.completed', item: { ...item, status: 'completed', result: { content: result.content, structured_content: result.structuredContent ?? null }, error: null } },
        );
      });
      if (at >= 0) lines.splice(at + 1, 0, ...events);
    }
    return started;
  } finally {
    for (const s of sessions.values()) s.close();
  }
}

/**
 * Claude Code with a cached tool list for each server: no server is started before the turn, and the one the model
 * calls is connected then. A connect that fails is an error result; its text is a stand-in (Botons reads none of it).
 */
async function withCachedMcp(fx: Fixture, opts: NonNullable<Step['mcp']>, given: GivenServer[], cached: string[]): Promise<Record<string, Started>> {
  const started: Record<string, Started> = Object.fromEntries(given.map((s) => [s.name, { status: 'pending', tools: cached } satisfies Started]));
  const lines = fx.stdout as Record<string, any>[];
  const at = lines.findIndex((l) => l?.type === 'system' && l.subtype === 'init');
  if (at < 0) return started;
  const init = lines[at];
  lines[at] = {
    ...init,
    tools: [...init.tools, ...given.flatMap((s) => cached.map((t) => claudeName(s.name, t)))],
    mcp_servers: given.map((s) => ({ name: s.name, status: 'pending' })),
  };
  const call = opts.call && given.some((s) => s.name === opts.call!.server) ? opts.call : null;
  if (!call) return started;
  const id = 'toolu_01FakeMcpCall';
  const events: Record<string, any>[] = [
    { type: 'assistant', message: { model: init.model, id: 'msg_01FakeMcpCall', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: claudeName(call.server, call.tool), input: call.arguments ?? {} }] }, parent_tool_use_id: null, session_id: init.session_id },
  ];
  if (!opts.noResult) {
    const r = await startServers(given.filter((s) => s.name === call.server), () => opts.waitMs ?? 5000, () => ({ status: 'failed', tools: [] }));
    started[call.server] = r.started[call.server];
    const session = r.sessions.get(call.server);
    try {
      const result = session ? await session.call(call.tool, call.arguments ?? {}) : null;
      const text = 'fake CLI: could not connect to the server';
      events.push({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: result ? result.content : text, ...(!result || result.isError ? { is_error: true } : {}) }] },
        parent_tool_use_id: null,
        session_id: init.session_id,
        tool_use_result: result ? { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) } : `Error: ${text}`,
      });
    } finally {
      session?.close();
    }
  }
  lines.splice(at + 1, 0, ...events);
  return started;
}
