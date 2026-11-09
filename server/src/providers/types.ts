import type { AccessLevel, ProviderInfo, StepKind, TokenUsage, TurnStep } from '../../../shared/types.ts';
import type { ModelEfforts } from '../../../shared/effort.ts';
import type { AgentCli } from '../isolation.ts';
import { nowIso } from '../util.ts';
import type { SpendScope } from '../spend.ts';
import type { CliCheckProblem } from './cli-check.ts';
import type { FailureKind } from './failures.ts';

export interface TurnRequest {
  cwd: string;
  sessionId: string | null;
  systemPrompt: string;
  prompt: string;
  /** "" means the provider's default. */
  model: string;
  /** A level of shared/effort.ts for this provider; "" (or absent) means the provider's default, set by nothing. */
  effort?: string;
  access: AccessLevel;
  images?: string[];
  /** Paths a Workspace Boton must not read; empty for Full computer access. */
  privatePaths: string[];
  sharedDirs?: string[];
  /** A sandboxed turn (webhook run, Workspace access) must not write the instruction files later turns load. */
  protectInstructions?: boolean;
  groupDir?: string;
  env: Record<string, string>;
  /** Their secrets go to the agent CLI only: never to argv, the log or the prompt. */
  mcpServers?: TurnMcpServer[];
  /** A 0700 folder for files holding those secrets; required with mcpServers. */
  privateDir?: string;
  askFirst?: { ask: string[]; allow: string[]; command: string; args: string[] };
  /**
   * A reply only (the summary a provider move asks the old session for): the model is given no tools at all, whatever
   * the Boton's access. Only for a provider whose `toolFree` says it can; never with mcpServers or askFirst.
   */
  toolFree?: boolean;
  /**
   * For a provider that bills by the token (an API key): the turn whose spending caps apply (spend.ts). The CLIs
   * ignore it: their cost isn't Botons' to bound.
   */
  spend?: SpendScope;
  /** The `botons` CLI, for a provider whose tools Botons runs itself (`serverTools`). */
  botonCli?: string;
  signal: AbortSignal;
  timeoutMs: number;
  onActivity: (activity: string) => void;
  /** All of the message being written so far; a new message starts over. */
  onText?: (textSoFar: string) => void;
  onStep?: (step: TurnStep) => void;
  /** Each MCP tool call on one of `mcpServers` that finished, with its structured result (never display text). */
  onToolResult?: (obs: ToolObservation) => void;
}

export interface ToolObservation {
  /** The CLI's id for the call. */
  callId: string;
  /** The server's name in this turn (a key of mcpServers). */
  server: string;
  tool: string;
  /** False for an error result, or one the CLI marks failed. */
  ok: boolean;
  /** The result's structuredContent, or its JSON text block when that is all the CLI passes on; else null. */
  structured: Record<string, unknown> | null;
}

export function step(kind: StepKind, label: string, detail: string): TurnStep {
  return { kind, label, detail, at: nowIso() };
}

export interface TurnUsage extends TokenUsage {
  numTurns?: number;
  model?: string;
}

/** How long the CLI gives a server to start and to run one tool, in seconds; the CLI's defaults when left out. */
export interface McpTimeouts {
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export type TurnMcpServer =
  | ({
      name: string;
      kind: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      /** What must not come back out in text, when not `env`'s values (a local connector's, in its launch file). */
      secrets?: string[];
    } & McpTimeouts)
  | ({ name: string; kind: 'http'; url: string; headers: Record<string, string>; sse?: boolean } & McpTimeouts);

/**
 * What the CLI showed of one of the turn's MCP servers. Only servers it said something about are listed: Claude Code
 * reports each one's status and tools when the turn starts; Codex reports nothing, so only a tool call it ran shows
 * a server started.
 */
export interface McpStartup {
  name: string;
  started: boolean;
  /** The tools the CLI listed for it; null when the CLI doesn't list them. */
  tools: string[] | null;
  /** Why it didn't start (or may not have), as the owner and the Boton are told. */
  reason?: string;
}

export interface TurnResult {
  sessionId: string | null;
  text: string;
  /** Errors the CLI reported during a turn that still completed. */
  warnings?: string[];
  usage?: TurnUsage | null;
  mcpStartup?: McpStartup[];
}

export class ProviderError extends Error {
  /**
   * Only when the provider no longer has the session and the run did nothing
   * else: the engine retries in a new session, so a false positive runs the work twice.
   */
  sessionLost: boolean;
  kind: FailureKind;
  retryAt: Date | null;
  exit?: { exitCode: number | null; signal: string | null; timedOut: boolean; stderrTail: string };
  usage?: TurnUsage | null;
  mcpStartup?: McpStartup[];
  constructor(message: string, sessionLost = false, info: { kind?: FailureKind; retryAt?: Date | null } = {}) {
    super(message);
    this.sessionLost = sessionLost;
    this.kind = info.kind ?? 'other';
    this.retryAt = info.retryAt ?? null;
  }
}

export interface Provider {
  id: string;
  label: string;
  cli?: AgentCli;
  info(): Promise<ProviderStatus>;
  /**
   * What info() would say from the checks already done, without running one (CliChecker.peek): null checkedAt before
   * the first. Absent: info() itself runs nothing.
   */
  snapshot?(): ProviderStatus;
  /** Drop cached checks, so the next info() runs them again. */
  recheck?(): void;
  runTurn(req: TurnRequest): Promise<TurnResult>;
  /** Which of a turn's MCP servers this CLI can be given, and why the others can't. */
  fitMcpServers?(servers: TurnMcpServer[]): { servers: TurnMcpServer[]; skipped: { name: string; reason: string }[] };
  askFirst?: boolean;
  /**
   * Its CLI can run a turn with no tools at all (TurnRequest.toolFree): every built-in tool, MCP tool, skill and
   * command taken away, not only fenced in by a sandbox. Absent: it can't, and a toolFree turn is refused.
   */
  toolFree?: boolean;
  /** What the CLI's own model list says `model` takes; null when it doesn't list levels for it (see shared/effort.ts). */
  modelEfforts?(model: string): ModelEfforts | null;
  /**
   * No CLI: Botons runs the agent loop and every tool itself (an API key brain, providers/api-brain.ts), the turn's
   * Botons connectors included, which the server calls on the Boton's behalf.
   */
  serverTools?: boolean;
}

/**
 * `effort` left out: the registry fills it in from shared/effort.ts. `readiness` is the registry's too, from `check`:
 * what the provider's own check found, if it runs one.
 */
export type ProviderStatus = Omit<ProviderInfo, 'lastSuccessAt' | 'lastError' | 'effort' | 'readiness'> & {
  effort?: ProviderInfo['effort'];
  check?: { problem: CliCheckProblem | null; generation: number };
};
