import { cliHomesEnv } from '../cli-homes.ts';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { log } from '../log.ts';
import { nowIso } from '../util.ts';
import type { ProviderError } from './types.ts';

/** All an agent CLI inherits from the server: no API keys, server settings, or another agent session's variables. */
export const INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES'];
const INHERITED = new Set(INHERITED_ENV);

export function agentEnv(extra: Record<string, string>, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    if (v !== undefined && (INHERITED.has(k) || k.startsWith('LC_'))) env[k] = v;
  }
  return { ...env, ...extra, ...cliHomesEnv(from) };
}

/** Feed each JSON line of `stream` to `onEvent`, skipping other lines. Returns a function that feeds an unterminated last line. */
export function jsonLines(stream: Readable, onEvent: (event: any) => void): () => void {
  let buf = '';
  const feed = (line: string) => {
    if (!line) return;
    try {
      onEvent(JSON.parse(line));
    } catch {}
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      feed(line);
    }
  });
  return () => feed(buf.trim());
}

interface JsonlRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Stopped by `signal` before the CLI said its turn was over or ran past its time. */
  aborted: boolean;
  /** Ran past `timeoutMs` before the CLI said its turn was over or a stop came. */
  timedOut: boolean;
}

export function runJsonl(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    signal: AbortSignal;
    timeoutMs: number;
    onEvent: (event: any) => void;
    /**
     * The event that ends the CLI's turn as a success (its result): a stop or the time limit after it only stops a process
     * that is exiting. A failure it writes and then hangs is still timed out or stopped.
     */
    isDone?: (event: any) => boolean;
    groupDir?: string;
  },
): Promise<JsonlRun> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a stop kills the commands it started too.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    // The CLI said its turn succeeded: what comes after is only it exiting.
    let ended = false;
    const record = opts.groupDir && child.pid ? recordGroup(opts.groupDir, child.pid, cmd) : null;
    const forget = () => {
      if (record) unlinkQuietly(record);
    };

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 3000).unref();
    };
    // Whichever ends the turn first is why it ended: its result, a stop, or the time limit. A stop that comes while a
    // timed-out process is exiting doesn't make it stopped, and a result it writes once killed doesn't make it succeed.
    const onAbort = () => {
      if (!timedOut && !ended) aborted = true;
      kill();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (!aborted && !ended) timedOut = true;
      kill();
    }, opts.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      forget();
      reject(err);
    });
    const flush = jsonLines(child.stdout, (ev) => {
      if (!aborted && !timedOut && opts.isDone?.(ev)) ended = true;
      opts.onEvent(ev);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      forget();
      flush();
      resolve({ code, signal, stderr, aborted, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin);
  });
}

// A server that dies without draining leaves its agents' process groups running, and the next start
// would answer the same messages again. So each group is recorded while it runs, and the next start stops what is left.

interface GroupRecord {
  pid: number;
  /** The leader's start time, to tell it from a later process with its pid. */
  startTime: string | null;
  bootId: string | null;
  cmd: string;
  at: string;
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function processStartTime(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 (starttime); the fields after the command's closing paren start at field 3.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function recordGroup(dir: string, pid: number, cmd: string): string | null {
  const path = join(dir, `${pid}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const rec: GroupRecord = { pid, startTime: processStartTime(pid), bootId: bootId(), cmd, at: nowIso() };
    writeFileSync(path, JSON.stringify(rec));
    return path;
  } catch (err) {
    log.warn('could not record an agent process group', { pid, err });
    return null;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the recorded groups a previous server left running, and wait for them. A group is only signalled if it is
 * still the same one: same boot, and its leader started when recorded (or the leader is gone but the group lives).
 */
export async function reapOrphanGroups(dir: string): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  const boot = bootId();
  const groups: GroupRecord[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let rec: GroupRecord;
    try {
      rec = JSON.parse(readFileSync(path, 'utf8')) as GroupRecord;
    } catch {
      unlinkQuietly(path);
      continue;
    }
    unlinkQuietly(path);
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !groupAlive(pid)) continue;
    if (rec.bootId && boot && rec.bootId !== boot) continue; // rebooted since
    const started = processStartTime(pid);
    if (started !== null ? started !== rec.startTime : !(rec.bootId && boot)) continue; // another process now, or can't tell
    groups.push(rec);
  }
  if (!groups.length) return 0;
  for (const g of groups) {
    log.warn('stopping an agent CLI that a previous server process left running (it died without draining), before its work runs again', {
      pid: g.pid,
      cmd: g.cmd,
      since: g.at,
    });
    try {
      process.kill(-g.pid, 'SIGTERM');
    } catch {}
  }
  const waitFor = async (ms: number) => {
    const end = Date.now() + ms;
    while (groups.some((g) => groupAlive(g.pid)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  await waitFor(5000);
  for (const g of groups) {
    if (!groupAlive(g.pid)) continue;
    try {
      process.kill(-g.pid, 'SIGKILL');
    } catch {}
  }
  await waitFor(2000);
  const left = groups.filter((g) => groupAlive(g.pid));
  if (left.length) log.error('agent CLIs left by a previous server process would not stop', { pids: left.map((g) => g.pid) });
  return groups.length;
}

export function failureMessage(label: string, run: JsonlRun, fallback: string | null): string {
  if (run.aborted) return 'Stopped.';
  if (run.timedOut) return `${label} timed out.`;
  const tail = run.stderr.trim().split('\n').slice(-6).join('\n');
  return fallback || tail || `${label} exited with code ${run.code}`;
}

/** `err` with how the CLI process ended (its last 20 stderr lines, at most 2000 characters), for the turn's log line. */
export function withExit(err: ProviderError, run: JsonlRun): ProviderError {
  const tail = run.stderr.trimEnd().split('\n').slice(-20).join('\n');
  err.exit = { exitCode: run.code, signal: run.signal, timedOut: run.timedOut, stderrTail: tail.length > 2000 ? tail.slice(-2000) : tail };
  return err;
}
