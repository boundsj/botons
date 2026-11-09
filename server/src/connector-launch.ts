import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { agentEnv } from './providers/process.ts';
import { bwrapArgs, mountTable, type SandboxPlan, sandboxBinary, seccompFilter, viewOf } from './sandbox.ts';

/*
 * A library connector's command (a local, stdio MCP server) is started by the agent CLI, or by Botons for an API key
 * brain, as the server's own user. The owner chose that command, not code a Workspace Boton wrote, and a Workspace
 * Boton can write its workspace, the shared folder and (on some CLIs) the temporary folders. No look at the command's
 * text can tell what it will load from there (an interpreter's options, a module loader, a PATH entry, a setting the
 * program reads), and which Boton's turn starts it doesn't change what it runs: a Full computer Boton's connector
 * running a script another Boton can rewrite runs that Boton's code with the server's access.
 *
 * So every one, in every turn, on every brain, starts in the Workspace sandbox's own view of this computer (sandbox.ts):
 * an empty read-only root with only the system's programs and libraries (SYSTEM_TREES), the folders on its PATH and
 * Node's own install shown, each read-only, plus the folder of its command and of each argument that is an absolute
 * path. No workspace, no shared folder, no data folder, no home folder but what those name, the private paths hidden
 * where they fall inside what it sees, an empty /tmp of its own (its HOME and where it starts). What a Boton can write
 * is never shown by any path: a folder it would see that is, or lies in, a workspace, the shared folder, the data folder
 * or a temporary folder through another mount of the same filesystem (a bind mount) is left out, and where one holds
 * them that way, that place is hidden (SandboxPlan.apart). A command or argument folder that would be left out or
 * hidden is refused, with why, rather than started without it.
 *
 * Unlike a Workspace command it keeps this computer's network (a connector talks to its service; the sandbox's socket
 * filter still refuses Unix sockets, so no program's local socket is reachable), and the environment it gets is the
 * agent CLIs' inherited variables (HOME and TMPDIR are its /tmp) and the connector's own. Its process list, IPC and
 * capabilities are the sandbox's. Descriptors the CLI that starts it leaves open are the CLI's to close.
 *
 * Its sandbox, environment included, goes to bubblewrap in a private file (--args), never on a command line or in the
 * environment of what starts bubblewrap (a loader variable there would act outside the sandbox): the CLI is given
 * `/bin/sh` opening that file and the socket filter, then running the bubblewrap whose check passed with the command
 * and arguments as saved. The file is removed when the turn ends (release()), and at start.
 * Where bubblewrap can't run (sandboxProblem()), a turn goes without its local connectors and says why: nothing starts
 * one outside the sandbox. Botons' own connectors (the managed browser, the approval server) are the server's own code
 * and start as they are.
 */

/** What a turn's local connectors never see, and where their launch files go. */
export interface LaunchPolicy {
  /** Folders a Boton can write, and the data folder: never shown by any path. The temporary folders are added. */
  apart: string[];
  /** Hidden where they fall inside what it sees (isolation.ts privatePaths). */
  hidden: string[];
  /** Private (BOTONS_HOME/run/connectors): the launch files and the socket filter. */
  dir: string;
}

export const TEMP_DIRS = ['/tmp', '/var/tmp', '/dev/shm'];

/** Each one starts as `sh -c SCRIPT sh <bubblewrap> <filter> <launch file> <command> <args...>`. */
export const LAUNCH_SCRIPT = 'exec 3<"$2" 4<"$3" || exit 126; b=$1; shift 3; exec "$b" --args 4 -- "$@"';
const SHELL = '/bin/sh';
const LAUNCH_FILE = /^launch-[0-9a-f]{18}\.args$/;

export interface Launch {
  command: string;
  args: string[];
  /** Nothing of the connector's: its environment is in the launch file. */
  env: Record<string, string>;
  /** The launch file, removed with release(). */
  file: string;
  /** The values of the environment it was saved with: never to come back out in text. */
  secrets: string[];
}

export type Jail = { wrap: (s: { command: string; args: string[]; env: Record<string, string> }) => Launch | { problem: string } } | { problem: string };

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The folders its command and arguments name: each absolute path that exists, a folder as itself, a file by its folder,
 * by its real path: a file's real folder and, for a link, the folder the link is in, so the path as saved is there inside.
 */
export function namedFolders(command: string, args: string[]): string[] {
  const out = new Set<string>();
  for (const a of [command, ...args]) {
    if (!isAbsolute(a)) continue;
    try {
      if (statSync(a).isDirectory()) out.add(real(a));
      else for (const p of [dirname(real(a)), real(dirname(resolve(a)))]) out.add(p);
    } catch {}
  }
  return [...out];
}

/** The environment inside: the agent CLIs' inherited variables (not their homes), its /tmp, then the connector's own. */
export function launchEnv(own: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentEnv({}))) if (typeof v === 'string' && k !== 'CLAUDE_CONFIG_DIR' && k !== 'CODEX_HOME') out[k] = v;
  out.HOME = '/tmp';
  out.TMPDIR = '/tmp';
  // The server's own Node first: a version manager's shims need files the sandbox doesn't show.
  out.PATH = [dirname(process.execPath), ...(out.PATH ?? '/usr/bin:/bin').split(':').filter((d) => d && d !== dirname(process.execPath))].join(':');
  return { ...out, ...own };
}

/** The sandbox plan for one connector under `policy`. */
export function launchPlan(policy: LaunchPolicy, s: { command: string; args: string[]; env: Record<string, string> }): SandboxPlan {
  const apart = [...new Set([...policy.apart, ...TEMP_DIRS, tmpdir()].map((p) => resolve(p)))];
  return { cwd: '/tmp', writable: [], hidden: [...policy.hidden, ...apart], readOnly: [], env: launchEnv(s.env), network: true, trees: namedFolders(s.command, s.args), apart };
}

/** Why `plan` can't show each folder its command and arguments name, or null when it shows them all. */
export function namedProblem(plan: SandboxPlan): string | null {
  const { trees, masked } = viewOf(plan);
  const shown = trees.filter((t) => !t.link).map((t) => t.path);
  const covered = [...plan.hidden.map((p) => resolve(p)), ...masked];
  for (const n of plan.trees ?? []) {
    if (shown.some((t) => within(n, t)) && !covered.some((h) => within(n, h) || within(h, n))) continue;
    return `${n} (named by its command) can't be shown to it: it is, holds or lies in a workspace, the shared folder, the data folder, a temporary folder or a private folder (by its path or another mount of it), or another filesystem is mounted inside it. Keep its program outside those`;
  }
  return null;
}

/** How a turn starts its local connectors under `policy`, or why it can't. */
export function connectorJail(policy: LaunchPolicy): Jail {
  const b = sandboxBinary();
  if ('problem' in b) return { problem: `a local connector starts only in the Workspace sandbox, which can't run here: ${b.problem}` };
  const filter = seccompFilter();
  if (!filter) return { problem: `a local connector starts only in the Workspace sandbox, which has no socket filter for ${process.arch}` };
  if (!mountTable()) return { problem: "a local connector starts only in the Workspace sandbox, and Botons can't read this computer's mount table to keep every workspace out of its view" };
  if (!existsSync(SHELL)) return { problem: `a local connector starts through ${SHELL}, which isn't on this computer` };
  let filterFile: string;
  try {
    filterFile = writeFilter(policy.dir, filter);
  } catch (err) {
    return { problem: `Botons could not write the sandbox's socket filter for a local connector (${(err as Error).message})` };
  }
  return {
    wrap: (s) => {
      const plan = launchPlan(policy, s);
      const named = namedProblem(plan);
      if (named) return { problem: named };
      const argv = bwrapArgs(plan);
      if ([...argv, s.command, ...s.args].some((a) => a.includes('\0'))) return { problem: 'its command, arguments or environment hold a NUL character' };
      const file = join(policy.dir, `launch-${randomBytes(9).toString('hex')}.args`);
      writeLaunchFile(file, argv.map((a) => `${a}\0`).join(''));
      return { command: SHELL, args: ['-c', LAUNCH_SCRIPT, 'sh', b.bin, filterFile, file, s.command, ...s.args], env: {}, file, secrets: Object.values(s.env).filter((v) => v.length >= 8) };
    },
  };
}

/** The socket filter, in `dir`, rewritten whole (a new file renamed over it) only when it differs. */
function writeFilter(dir: string, filter: Buffer): string {
  const file = join(dir, 'seccomp.bpf');
  try {
    if (readFileSync(file).equals(filter)) return file;
  } catch {}
  const tmp = join(dir, `.seccomp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, filter, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  return file;
}

/**
 * A new launch file (never one already there), private from the start. One that can't be written whole is removed
 * before the error goes on: a part of one is never left behind, nor listed for a turn.
 */
function writeLaunchFile(file: string, text: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, text);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {}
    try {
      rmSync(file, { force: true });
    } catch {}
    throw err;
  }
  closeSync(fd);
}

/** Removes the launch files given (a turn's, as it ends): tries every one, then throws the first that failed. */
export function release(files: string[]): void {
  let first: unknown;
  let failed = false;
  for (const f of files) {
    try {
      rmSync(f, { force: true });
    } catch (err) {
      if (!failed) first = err;
      failed = true;
    }
  }
  if (failed) throw first;
}

/** Removes every launch file in `dir` (at start: those a crashed turn left). */
export function releaseAll(dir: string): void {
  for (const f of readdirSync(dir)) if (LAUNCH_FILE.test(f)) rmSync(join(dir, f), { force: true });
}
