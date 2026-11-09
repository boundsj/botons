import { probeCodexWorkspace } from './codex-workspace.ts';
import { spawn, spawnSync } from 'node:child_process';
import type { BrainCheckProblem } from '../../../shared/types.ts';
import { hostname } from 'node:os';
import { log } from '../log.ts';
import { nowIso, truncate } from '../util.ts';
import { agentEnv } from './process.ts';
import { terminalCli, type ManagedProvider } from '../managed-clis.ts';
import type { ProviderStatus } from './types.ts';

const CHECK_TTL_MS = 5 * 60_000;
/** Each of a check's two commands; a check takes at most twice this. */
export const CHECK_TIMEOUT_MS = 10_000;

/** What a check alone can find wrong with a CLI. */
export type CliCheckProblem = Extract<BrainCheckProblem, 'not-found' | 'not-runnable' | 'version-failed' | 'incompatible-version' | 'timed-out' | 'login-unreadable' | 'signed-out'>;

export interface CliCheck {
  installed: boolean;
  workspaceProblem?: string | null;
  version: string | null;
  /** False when the CLI says it is signed out; null when that could not be told. */
  loggedIn: boolean | null;
  reason: string | null;
  checkedAt: string;
  /** Why it is not ready, as a fixed word; null when installed and signed in. Left out by checks that don't say. */
  problem?: CliCheckProblem | null;
  /** Higher for each check the checker finishes (CliChecker sets it). */
  generation?: number;
  /** `--version` of the other copy a terminal here runs, when Botons runs its own; null when there is none. */
  terminal?: string | null;
}

/** The `--version` line of the copy a terminal runs as `codex` or `claude`, when that is another file than `bin`. Runs only `--version`. */
export async function terminalVersion(provider: ManagedProvider, bin: string, timeoutMs = 5_000): Promise<string | null> {
  const other = terminalCli(provider, bin);
  if (!other) return null;
  const v = await capture(other, ['--version'], timeoutMs);
  return v.code === 0 ? v.stdout.trim().split('\n')[0]?.trim().slice(0, 80) || null : null;
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The spawn error code (ENOENT…) when the command could not run at all. */
  error: string | null;
  timedOut: boolean;
}

/** Run a short command in the agents' environment and capture its output. Never rejects. */
function capture(cmd: string, args: string[], timeoutMs = CHECK_TIMEOUT_MS): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: Omit<Captured, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env: agentEnv({ DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, stdout, stderr, error: (err as NodeJS.ErrnoException).code ?? (err as Error).message, timedOut });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(-16_000)));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-16_000)));
    child.on('error', (err: NodeJS.ErrnoException) => done({ code: null, error: err.code ?? err.message }));
    child.on('close', (code) => done({ code, error: null }));
  });
}

function failure(out: Captured, timeoutMs = CHECK_TIMEOUT_MS): string {
  if (out.timedOut) return `it did not answer within ${timeoutMs / 1000}s`;
  if (out.error) return out.error;
  const last = (out.stderr.trim() || out.stdout.trim()).split('\n').at(-1)?.trim() ?? '';
  return truncate(last, 200) || `exit ${out.code}`;
}

type LoginResult = Pick<CliCheck, 'loggedIn' | 'reason'>;

export function parseClaudeLogin(out: Captured, host = hostname()): LoginResult {
  try {
    const status = JSON.parse(out.stdout) as { loggedIn?: unknown };
    if (status.loggedIn === true) return { loggedIn: true, reason: null };
    if (status.loggedIn === false) {
      return { loggedIn: false, reason: `Claude Code is not signed in. Run \`claude auth login\` on ${host}, as the user the server runs as.` };
    }
  } catch {}
  return { loggedIn: null, reason: `Could not check the Claude login (\`claude auth status\`): ${failure(out)}` };
}

export function parseCodexLogin(out: Captured, host = hostname()): LoginResult {
  const said = `${out.stdout}\n${out.stderr}`;
  if (!out.timedOut && /\bnot logged in\b/i.test(said)) {
    return { loggedIn: false, reason: `Codex is not signed in. Run \`codex login\` on ${host}, as the user the server runs as.` };
  }
  if (out.code === 0) return { loggedIn: true, reason: null };
  return { loggedIn: null, reason: `Could not check the Codex login (\`codex login status\`): ${failure(out)}` };
}

/**
 * What a login check's answer can be taken for. A command that didn't answer in time confirms nothing, whatever it
 * printed first; one that failed can say it is signed out, but not that it is signed in.
 */
function confirmedLogin(out: Captured, parsed: LoginResult, cmd: string, timeoutMs: number): LoginResult {
  if (out.timedOut) return { loggedIn: null, reason: `Could not check the sign-in (${cmd}): ${failure(out, timeoutMs)}` };
  if (parsed.loggedIn === true && out.code !== 0) return { loggedIn: null, reason: `Could not check the sign-in (${cmd}): ${failure(out, timeoutMs)}` };
  return parsed;
}

/** Why `--version` failed, as a fixed word. */
function versionProblem(v: Captured): CliCheckProblem {
  if (v.timedOut) return 'timed-out';
  if (v.error === 'ENOENT') return 'not-found';
  return v.error ? 'not-runnable' : 'version-failed';
}

export async function checkCli(bin: string, loginArgs: string[], parseLogin: (out: Captured) => LoginResult, timeoutMs = CHECK_TIMEOUT_MS, checkVersion?: (version: string | null) => string | null): Promise<CliCheck> {
  const checkedAt = nowIso();
  const v = await capture(bin, ['--version'], timeoutMs);
  if (v.code !== 0) {
    const reason = v.error === 'ENOENT' ? `\`${bin}\` was not found on PATH` : `\`${bin} --version\` failed: ${failure(v, timeoutMs)}`;
    return { installed: false, version: null, loggedIn: null, reason, checkedAt, problem: versionProblem(v) };
  }
  const version = v.stdout.trim().split('\n')[0]?.trim().slice(0, 80) || null;
  const incompatible = checkVersion?.(version);
  if (incompatible) return { installed: true, version, loggedIn: null, reason: incompatible, checkedAt, problem: 'incompatible-version' };
  const out = await capture(bin, loginArgs, timeoutMs);
  const login = confirmedLogin(out, parseLogin(out), `\`${[bin, ...loginArgs].join(' ')}\``, timeoutMs);
  const problem: CliCheckProblem | null = login.loggedIn === true ? null : login.loggedIn === false ? 'signed-out' : out.timedOut ? 'timed-out' : 'login-unreadable';
  return { installed: true, version, ...login, checkedAt, problem };
}

/**
 * Codex's bubblewrap helper must give each synthetic missing-path mount its own descriptor.
 * 0.166.0 is the verified baseline; older helpers can close a descriptor another mount still needs.
 */
export async function checkCodexCli(bin: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<CliCheck> {
  const result = await checkCli(bin, ['login', 'status'], parseCodexLogin, timeoutMs, (version) => {
    const match = /^(?:codex-cli )?(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
    if (match) {
      const [, major, minor] = match.map(Number);
      if (major > 0 || minor >= 166) return null;
    }
    return 'Botons requires Codex 0.166.0 or newer (a stable version): older bubblewrap helpers can fail on protected missing paths with Bad file descriptor. For npm installs run `npm install -g @openai/codex@latest` with the permissions used to install it. For Docker set BOTONS_CODEX_VERSION to a compatible stable version and run `docker compose up -d --build`. Upgrade Codex for the user Botons runs as, verify `codex --version` (or run `"$BOTONS_CODEX_BIN" --version` when configured), then open Settings → Brains for the reviewed upgrade action and Check again. Keep Workspace sandboxing enabled.';
  });
  return result.installed && result.problem !== 'incompatible-version'
    ? { ...result, workspaceProblem: await probeCodexWorkspace(bin, timeoutMs) } : result;
}

/** What a CLI's status is before any check has finished: not known, so never ready. */
export const NOT_CHECKED: CliCheck = { installed: false, version: null, loggedIn: null, reason: 'Not checked yet since the server started.', checkedAt: '', problem: null, generation: 0 };

export function cliStatus(c: CliCheck): Pick<ProviderStatus, 'available' | 'reason' | 'installed' | 'version' | 'loggedIn' | 'checkedAt' | 'check' | 'workspaceProblem'> {
  return {
    available: c.installed && c.loggedIn !== false && c.problem !== 'incompatible-version',
    reason: c.reason,
    ...(c.workspaceProblem !== undefined ? { workspaceProblem: c.workspaceProblem } : {}),
    installed: c.installed,
    version: c.version,
    loggedIn: c.loggedIn,
    checkedAt: c.checkedAt,
    check: { problem: c.problem ?? null, generation: c.generation ?? 0 },
  };
}

type QueuedCheck = { at: number; started: boolean; check: Promise<CliCheck>; done?: CliCheck };

/**
 * The checker's clocks: `elapsed` only ever goes forward (how old a cached check is), `now` is the wall clock checks
 * are stamped with, which can be set back.
 */
export interface CheckClock {
  elapsed(): number;
  now(): number;
}
const SYSTEM_CLOCK: CheckClock = { elapsed: () => performance.now(), now: () => Date.now() };

/**
 * Runs a CLI's checks at most every CHECK_TTL_MS, sharing the result. Checks never overlap: one asked for while
 * another runs starts when it ends, and is shared by everyone who asks before it starts.
 */
export class CliChecker {
  #provider: string;
  #run: () => Promise<CliCheck>;
  #cached: QueuedCheck | null = null;
  /** Settles when the latest check has finished. */
  #idle: Promise<unknown> = Promise.resolve();
  #last: CliCheck | null = null;
  /** Counts this checker's checks; it starts again with the server, whose boot (readiness) tells the two runs apart. */
  #generation = 0;
  #clock: CheckClock;

  constructor(provider: string, run: () => Promise<CliCheck>, clock: CheckClock = SYSTEM_CLOCK) {
    this.#provider = provider;
    this.#run = run;
    this.#clock = clock;
  }

  get(): Promise<CliCheck> {
    const cached = this.#cached;
    if (cached && (!cached.started || (this.#clock.elapsed() - cached.at < CHECK_TTL_MS && !this.#fromTheFuture(cached)))) return cached.check;
    const entry: QueuedCheck = {
      at: this.#clock.elapsed(),
      started: false,
      check: this.#idle.then(async () => {
        entry.started = true;
        entry.at = this.#clock.elapsed();
        const c = { ...(await this.#run()), generation: ++this.#generation };
        entry.done = c;
        this.#noteChange(c);
        return c;
      }),
    };
    this.#cached = entry;
    this.#idle = entry.check.catch(() => {});
    return entry.check;
  }

  /** A finished check stamped later than the wall clock now: the clock was set back, so its age can't be told. */
  #fromTheFuture(entry: QueuedCheck): boolean {
    const at = entry.done ? Date.parse(entry.done.checkedAt) : Number.NaN;
    return at > this.#clock.now();
  }

  /**
   * The last finished check, however old, or null before the first: never runs one. For views that must report only
   * what is known (a starter's review and setup check); readiness (brainReadiness) says when it is too old to count.
   */
  peek(): CliCheck | null {
    return this.#last;
  }

  /** A check that has not started yet already counts as "next time". */
  invalidate(): void {
    if (this.#cached?.started) this.#cached = null;
  }

  #noteChange(c: CliCheck) {
    const prev = this.#last;
    this.#last = c;
    if (!prev || (prev.installed === c.installed && prev.loggedIn === c.loggedIn)) return;
    const fields = { provider: this.#provider, installed: c.installed, loggedIn: c.loggedIn, version: c.version };
    if (c.installed && c.loggedIn !== false) log.info(`${this.#provider} can run turns${c.reason ? ` (${c.reason})` : ''}`, fields);
    else log.warn(`${this.#provider} can't run turns: ${c.reason}`, fields);
  }
}

/** Claude needs socat and private network/process namespaces. No model or login is used. */
export function claudeWorkspaceProblem({ bwrap = 'bwrap', socat = 'socat' }: { bwrap?: string; socat?: string } = {}): string | null {
  if (process.platform !== 'linux') return `Not available on this server: the Workspace sandbox needs Linux. On ${process.platform === 'darwin' ? 'macOS' : process.platform}, choose Full computer access for a Boton you trust.`;
  const relay = spawnSync(socat, ['-V'], { timeout: CHECK_TIMEOUT_MS, encoding: 'utf8' });
  if (relay.status !== 0) return 'Not available on this server: the Workspace sandbox needs socat installed and runnable.';
  const probe = spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--', '/bin/true'], { timeout: CHECK_TIMEOUT_MS, encoding: 'utf8' });
  return probe.status === 0 ? null : "Not available on this server: the Workspace sandbox cannot create its private network or process filesystem.";
}
