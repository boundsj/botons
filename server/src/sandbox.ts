import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { log } from './log.ts';

/*
 * The OS sandbox for what an API-key Boton with Workspace access does itself: every command, file read and file write
 * of its tools runs in bubblewrap (Linux user namespaces), never in the server's own process. What it may affect is its
 * workspace (and the shared folder), and nothing outside them:
 *
 * - Files: its root is an empty tmpfs, read-only. Of the host it sees only an allowlist (SYSTEM_TREES: /usr, /etc,
 *   /opt and the like, then the folders on its PATH and Node's own install), each through a read-only overlay, and its
 *   workspace and the shared folder, which are the only places it can write. No home folder (but the path down to the
 *   workspace), no data folder, no other workspace, no /var, /srv, /mnt, /media, /sys; an empty /tmp, /var/tmp and
 *   /run. The paths isolation.ts lists are hidden too where they fall inside what it sees. The settings folders CLIs
 *   load from the workspace (.claude) and, in a sandboxed turn, the instruction files later turns follow are mounted
 *   read-only on top. A hard link can't cross into a writable folder (each mount is its own).
 * - Named pipes and sockets on the host: an overlay shows a FIFO or a socket file as the overlay's own inode, so
 *   opening, writing, reading or connecting to one through it never reaches the program that made it, wherever it is
 *   in what the sandbox sees (sandboxProblem() proves this on the machine with a pipe of its own before anything runs).
 *   Device files there don't open either: a mount made in a user namespace is nodev.
 * - Unix sockets at all: a seccomp filter (FILTER below) refuses socket() for every family but IPv4, IPv6 and netlink,
 *   all of its own network namespace, so no AF_UNIX socket can be made (an abstract one neither). Only
 *   socketpair(AF_UNIX, SOCK_STREAM) is let through: a connected pair inside the sandbox (as Node and Python use for
 *   their child processes), which can't be pointed at another socket. io_uring (which makes sockets without socket())
 *   and the kernel keyrings (the server's user's own) are refused too. Programs that need a Unix socket of their own
 *   (a database's local socket, a browser) don't run here; Full computer access runs them.
 * - Network: its own network namespace, with only its own loopback: the host's loopback, its private networks and
 *   the internet aren't there at all (the filter only narrows what it may make inside that namespace).
 * - Other programs: no other process to see or signal (its own /proc), no SysV or POSIX IPC, no capabilities, only the
 *   environment it is given (never the server's own: no API key), no file descriptor of the server's but its stdin,
 *   stdout and stderr. Node opens every descriptor of its own close-on-exec, and marks those it was started with only
 *   up to the first one missing after 15; one past that (a CI runner's, a terminal's) would pass through bubblewrap
 *   into the command: a folder there opens the host's files past every mount, a pipe or a socket reaches the program
 *   at its other end. So each one is closed before a sandboxed command starts, and nothing starts while one is left
 *   (closeInherited()); the check proves inside that none arrives.
 * - Its workspace is the owner's folder too: a file, or a named pipe, a program of the owner's watches there reaches
 *   that program, as anything the Boton writes there does. That is the workspace's purpose, not a way out of it.
 *
 * Without bubblewrap (0.11 or newer, for overlays), or where it can't make the namespaces, the overlays or load the
 * filter (not Linux, an architecture FILTER isn't built for, a container that forbids them), or where the check's pipe
 * gets anything, nothing runs for a Workspace Boton: sandboxProblem() says why, and the turn fails with that before
 * its first request. Nothing falls back to a weaker sandbox. Full computer access runs the same tools as the server's
 * user, outside any sandbox, as the owner chose for the Boton.
 */

export interface SandboxPlan {
  /** Absolute: the Boton's workspace, where commands start. */
  cwd: string;
  /** Writable: the workspace and the shared folder (none in a sandboxed turn but the workspace). */
  writable: string[];
  /** Hidden: each one that exists becomes an empty folder or an empty file. */
  hidden: string[];
  /** Read-only on top of a writable folder (created first when a folder that doesn't exist yet). */
  readOnly: { path: string; dir: boolean }[];
  env: Record<string, string>;
  /**
   * This computer's network instead of a namespace of its own (a local connector's, connector-launch.ts), with the
   * resolver's file where /etc/resolv.conf points outside the view. The socket filter stays on.
   */
  network?: boolean;
  /** More host folders to show read-only, as the view shows a folder on PATH (never one it would leave out). */
  trees?: string[];
  /**
   * Folders that must not be seen by any path: a tree the view shows that is one of them, or lies inside one, through
   * another mount of the same filesystem (a bind mount shows a folder at a second path) is left out, and where it holds
   * one that way, that place in it is hidden. Without the mount table, nothing is shown.
   */
  apart?: string[];
}

let BWRAP = 'bwrap';
const CHECK_TIMEOUT_MS = 10_000;
/** How long a passed check stands (while its program stays the same file), and a failed one. */
const PASSED_MS = 10 * 60_000;
const FAILED_MS = 60_000;
const MAX_CHECKS = 8;

/**
 * The bubblewrap a check ran, as the file it resolved to: its real path, and what says it is still that file (device,
 * inode, size, modification and change times, mode, owner). Resolved again, synchronously, just before every sandboxed
 * spawn, which then runs that real path, not a name looked up again: replaced, moved, re-linked or shadowed by
 * another on PATH, and it is checked again before anything runs. What remains is the moment between that last stat and
 * the exec; anyone who can swap the file in it can already change the server's own programs.
 */
interface Exe {
  path: string;
  id: string;
}

/** Each check by what it ran under: the bubblewrap asked for, the PATH it was found on, the filter it loaded. */
const checks = new Map<string, { at: number; problem: string | null; exe: Exe | null }>();

export function resetSandboxChecks(): void { checks.clear(); }

/** Tests only (set in code, never from a setting): another bubblewrap, e.g. one that isn't there. */
export function useSandboxBinary(bin: string): void {
  BWRAP = bin;
  checks.clear();
}

const searchPath = () => process.env.PATH ?? '/usr/bin:/bin';

/** `bin` as the file it runs: a path as given, a name the first executable file of it on PATH; null when there is none. */
function resolveExe(bin: string, path = searchPath()): Exe | null {
  const candidates = bin.includes('/') ? [resolve(bin)] : path.split(':').filter((d) => isAbsolute(d)).map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      const file = realpathSync(c);
      const st = statSync(file);
      if (!st.isFile()) continue;
      return { path: file, id: [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode, st.uid].join(':') };
    } catch {}
  }
  return null;
}

const keyOf = (bin: string, filter: Buffer | null) => `${bin}\0${searchPath()}\0${process.arch}\0${filter ? filter.toString('hex') : ''}`;

/**
 * The bubblewrap to spawn for a sandboxed command: the file the last passed check ran, when it is still that file,
 * found the same way; else null (and sandboxProblem() checks again).
 */
function verifiedExe(bin: string, filter: Buffer): string | null {
  const c = checks.get(keyOf(bin, filter));
  if (!c || c.problem !== null || !c.exe || Date.now() - c.at >= PASSED_MS) return null;
  const now = resolveExe(bin);
  return now && now.path === c.exe.path && now.id === c.exe.id ? now.path : null;
}

/** The descriptor bubblewrap reads the seccomp filter from (`--seccomp 3`): the child's fourth stdio slot. */
const FILTER_FD = 3;

/*
 * The seccomp filter, as classic BPF over struct seccomp_data { int nr; u32 arch; u64 ip; u64 args[6] } (little-endian
 * on both architectures, so an argument's low 32 bits are at 16 + 8 * i, and the kernel reads these int arguments as
 * those bits). Anything not named is allowed: the namespaces and the read-only mounts do the rest.
 */
const ARCHES = {
  x64: { audit: 0xc000003e, x32: true, nr: { socket: 41, socketpair: 53, denied: [425, 426, 427, 248, 249, 250] } },
  arm64: { audit: 0xc00000b7, x32: false, nr: { socket: 198, socketpair: 199, denied: [425, 426, 427, 217, 218, 219] } },
} as const;
// denied: io_uring_setup, io_uring_enter, io_uring_register; add_key, request_key, keyctl (in each table's order).
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const SOCK_STREAM = 1;
const SOCK_TYPE_MASK = 0xf;
const EPERM = 1;
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO = 0x00050000;
const RET_KILL_PROCESS = 0x80000000;

type Insn = { code: number; jt?: string | number; jf?: string | number; k: number } | { label: string };

/** The filter for this machine's architecture, or null when it has none (then Workspace tools don't run). */
export function seccompFilter(arch: string = process.arch): Buffer | null {
  const a = (ARCHES as Record<string, (typeof ARCHES)[keyof typeof ARCHES]>)[arch];
  if (!a) return null;
  const ld = (off: number): Insn => ({ code: 0x20, k: off }); // BPF_LD | BPF_W | BPF_ABS
  const jeq = (k: number, jt: string | number, jf: string | number = 0): Insn => ({ code: 0x15, k, jt, jf }); // BPF_JMP | BPF_JEQ | BPF_K
  const jge = (k: number, jt: string | number, jf: string | number = 0): Insn => ({ code: 0x35, k, jt, jf }); // BPF_JMP | BPF_JGE | BPF_K
  const and = (k: number): Insn => ({ code: 0x54, k }); // BPF_ALU | BPF_AND | BPF_K
  const ret = (k: number): Insn => ({ code: 0x06, k }); // BPF_RET | BPF_K
  const prog: Insn[] = [
    ld(4),
    // Another ABI (32-bit compat) would bypass the numbers below: such a process is killed.
    jeq(a.audit, 0, 'kill'),
    ld(0),
    ...(a.x32 ? [jge(0x40000000, 'deny')] : []),
    jeq(a.nr.socket, 'socket'),
    jeq(a.nr.socketpair, 'socketpair'),
    ...a.nr.denied.map((nr) => jeq(nr, 'deny')),
    ret(RET_ALLOW),
    { label: 'socket' },
    ld(16),
    jeq(AF_INET, 'allow'),
    jeq(AF_INET6, 'allow'),
    jeq(AF_NETLINK, 'allow'),
    ret(RET_ERRNO | EPERM),
    { label: 'socketpair' },
    ld(16),
    jeq(AF_UNIX, 0, 'deny'),
    ld(24),
    and(SOCK_TYPE_MASK),
    jeq(SOCK_STREAM, 'allow', 'deny'),
    { label: 'allow' },
    ret(RET_ALLOW),
    { label: 'deny' },
    ret(RET_ERRNO | EPERM),
    { label: 'kill' },
    ret(RET_KILL_PROCESS),
  ];
  const at = new Map<string, number>();
  const code: Exclude<Insn, { label: string }>[] = [];
  for (const i of prog) {
    if ('label' in i) at.set(i.label, code.length);
    else code.push(i);
  }
  const out = Buffer.alloc(code.length * 8);
  code.forEach((i, n) => {
    // A jump is relative to the next instruction, forward only.
    const off = (t: string | number | undefined) => {
      if (t === undefined || typeof t === 'number') return t ?? 0;
      const d = at.get(t)! - n - 1;
      if (d < 0 || d > 255) throw new Error(`bad jump to ${t}`);
      return d;
    };
    out.writeUInt16LE(i.code, n * 8);
    out.writeUInt8(off(i.jt), n * 8 + 2);
    out.writeUInt8(off(i.jf), n * 8 + 3);
    out.writeUInt32LE(i.k >>> 0, n * 8 + 4);
  });
  return out;
}

/**
 * The check, inside a sandbox with the real view: the filter on (seccomp mode 2) with no new privileges, and the probe's
 * named pipe there, opened (read and write, so it never waits) and written to, and no descriptor of the server's open
 * there. Exit 3 to 6 says which failed.
 */
const PROBE_AT = '/botons-sandbox-probe';
// Of the descriptors open inside, only stdin, stdout, stderr and the one the listing itself opens.
const CHECK_SCRIPT = `f=; n=; while read -r k v; do case "$k" in Seccomp:) f=$v;; NoNewPrivs:) n=$v;; esac; done < /proc/self/status; [ "$f" = 2 ] && [ "$n" = 1 ] || exit 3; d=0; for p in /proc/self/fd/*; do case "\${p##*/}" in 0|1|2) ;; *) d=$((d + 1));; esac; done; [ "$d" -le 1 ] || exit 6; [ -p ${PROBE_AT}/probe.fifo ] || exit 4; exec 3<>${PROBE_AT}/probe.fifo && echo leaked >&3 || exit 5`;
const CHECK_FAILED: Record<number, string> = {
  3: 'its socket filter was not on inside',
  4: 'its read-only view showed nothing',
  5: 'its read-only view could not be opened',
  6: 'a file descriptor of the server’s, besides stdin, stdout and stderr, was open inside',
};

const O_CLOEXEC = 0o2000000;

/**
 * The descriptors a program this process starts would get besides its stdin, stdout and stderr: each one open without
 * close-on-exec. Node and libuv open all of their own close-on-exec (the IPC channel too), and at startup mark those the
 * server was started with up to the first one missing after 15 (uv_disable_stdio_inheritance), so each of these came
 * from whatever started the server, past such a gap, and the server never uses it. One whose flags can't be read counts (one that closed meanwhile,
 * as the listing's own does, doesn't).
 */
function inheritable(): number[] {
  const fds: number[] = [];
  for (const name of readdirSync('/proc/self/fd')) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    let info: string;
    try {
      info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1];
    if (flags === undefined || (parseInt(flags, 8) & O_CLOEXEC) === 0) fds.push(fd);
  }
  return fds;
}

/**
 * Closes every descriptor a sandboxed command would get from this process (see inheritable()), just before one starts:
 * null when none is left, else why nothing may start. Run synchronously right before the spawn, so nothing of the
 * server's opens one in between.
 */
export function closeInherited({ quiet = false }: { quiet?: boolean } = {}): string | null {
  try {
    const fds = inheritable();
    if (!fds.length) return null;
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!quiet) log.warn('closed file descriptors the server was started with, so no sandboxed command gets them', { fds });
    const left = inheritable();
    return left.length ? `Botons could not close ${left.length} file descriptor(s) it was started with, which a sandboxed command would get. Workspace access can't run until the server is started without them.` : null;
  } catch (err) {
    return `Botons could not list the file descriptors it holds (${(err as Error).message}), so it can't keep them from a sandboxed command. Workspace access can't run without that.`;
  }
}

/**
 * Why Workspace tools can't run here, or null when bubblewrap just made a sandbox with the real view and the filter
 * on, and a named pipe of the check's own, outside the sandbox, got nothing when the sandbox wrote to it through that
 * view (then cached). Any of it missing, and Workspace tools don't run: nothing falls back to a weaker sandbox.
 */
export function sandboxProblem(bin = BWRAP, { quiet = false }: { quiet?: boolean } = {}): string | null {
  const filter = seccompFilter();
  const key = keyOf(bin, filter);
  const was = checks.get(key);
  if (was) {
    // A pass stands while the same file is found the same way; a failure for a while, then it is tried again.
    if (was.problem === null && filter && verifiedExe(bin, filter)) return null;
    if (was.problem !== null && Date.now() - was.at < FAILED_MS) return was.problem;
  }
  let problem: string | null = null;
  let exe: Exe | null = null;
  if (process.platform !== 'linux') problem = `The sandbox Workspace access needs is bubblewrap on Linux; this server runs on ${process.platform === 'darwin' ? 'macOS' : process.platform}.`;
  else if (!filter) problem = `The sandbox Workspace access needs has no socket filter for this machine's architecture (${process.arch}); it is built for x64 and arm64. Workspace access can't run without it.`;
  else {
    exe = resolveExe(bin);
    problem = exe ? check(exe.path, filter, quiet) : 'bubblewrap (bwrap) is not installed, so Workspace access has no sandbox to run in. Install it (the bubblewrap package), or give the Boton Full computer access.';
    // The file checked must be the file found now: one that changed while it was checked is checked again next time.
    const after = exe && resolveExe(bin);
    if (!problem && (!after || after.path !== exe!.path || after.id !== exe!.id)) problem = 'bubblewrap changed while Botons checked it. Workspace access can’t run until it checks again.';
  }
  if (!quiet && problem && was?.problem !== problem) log.warn('the Workspace sandbox for API-key Botons is unavailable', { reason: problem });
  checks.delete(key);
  if (checks.size >= MAX_CHECKS) checks.delete(checks.keys().next().value!);
  checks.set(key, { at: Date.now(), problem, exe: problem ? null : exe });
  return problem;
}

/**
 * The bubblewrap whose check passed (sandboxProblem()), by its real path, for something else that starts in it (a
 * Workspace turn's local connectors, connector-launch.ts); or why there is none.
 */
export function sandboxBinary(): { bin: string } | { problem: string } {
  const problem = sandboxProblem();
  if (problem) return { problem };
  const filter = seccompFilter();
  const bin = filter ? verifiedExe(BWRAP, filter) : null;
  return bin ? { bin } : { problem: 'bubblewrap changed while Botons checked it.' };
}

/** `bin` is the real path of the file to run (resolved by the caller), never a name looked up on PATH again. */
function check(bin: string, filter: Buffer, quiet = false): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'botons-sandbox-check-'));
  const fds: number[] = [];
  try {
    const probe = join(dir, 'probe');
    const ws = join(dir, 'ws');
    mkdirSync(probe, { mode: 0o700 });
    mkdirSync(ws, { mode: 0o700 });
    const fifo = join(probe, 'probe.fifo');
    const made = spawnSync('mkfifo', ['-m', '600', fifo], { timeout: CHECK_TIMEOUT_MS, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    if (made.status !== 0) return 'Botons could not make the named pipe the sandbox check needs (mkfifo). Workspace access can’t run without the check.';
    // The host side: a reader that never waits, which sees anything that reaches the pipe.
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    fds.push(reader);
    // The filter goes in as a file: spawnSync takes a descriptor, not data, for a fourth stdio slot.
    const file = join(dir, 'filter');
    writeFileSync(file, filter, { mode: 0o600 });
    const filterFd = openSync(file, 'r');
    fds.push(filterFd);
    const held = closeInherited({ quiet });
    if (held) return held;
    const plan: SandboxPlan = { cwd: ws, writable: [ws], hidden: [], readOnly: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
    const args = bwrapArgs(plan);
    args.splice(BASE.length, 0, '--overlay-src', emptyLayer(), '--overlay-src', probe, '--ro-overlay', PROBE_AT);
    const r = spawnSync(bin, [...args, '--', '/bin/sh', '-c', CHECK_SCRIPT], { timeout: CHECK_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe', filterFd], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return 'bubblewrap (bwrap) is not installed, so Workspace access has no sandbox to run in. Install it (the bubblewrap package), or give the Boton Full computer access.';
    if (r.error || r.status !== 0) {
      const why = CHECK_FAILED[r.status ?? -1] ?? (String(r.stderr ?? '').trim().split('\n').pop()?.slice(0, 200) || (r.error ? r.error.message : `exit ${r.status}`));
      const { unshown } = viewOf(plan);
      const left = unshown.length ? ` It leaves out ${unshown.join(', ')}, which another filesystem is mounted inside.` : '';
      return `bubblewrap could not make the sandbox here, with its read-only view and its socket filter (${why}): user namespaces, overlays or seccomp may be turned off, as in many containers, or this bubblewrap is older than 0.11.${left} Workspace access can't run without it.`;
    }
    let got = 0;
    try {
      got = readSync(reader, Buffer.alloc(64), 0, 64, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
    }
    if (got > 0) return 'The sandbox’s read-only view let a write reach a named pipe outside it, so it can’t keep a Workspace Boton from programs on this machine. Workspace access can’t run here.';
    const { unshown } = viewOf(plan);
    if (!quiet && unshown.length) log.info('the Workspace sandbox leaves out folders another filesystem is mounted inside', { paths: unshown });
    return null;
  } catch (err) {
    return `Botons could not check the sandbox (${(err as Error).message}). Workspace access can't run without it.`;
  } finally {
    for (const fd of fds) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every namespace bubblewrap can make; the root is its own empty tmpfs (made read-only once the view is in place). */
const BASE = ['--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL'];

/**
 * The host trees a sandboxed command sees, each read-only: what programs and their libraries, settings and data need.
 * Nothing else of the host is there: no home folder (but the path down to the workspace), no /var, /srv, /mnt, /media,
 * /sys or the host's /tmp and /run. A link among them (a merged /usr) is the same link inside.
 */
export const SYSTEM_TREES = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/nix', '/nix/store', '/snap', '/gnu/store'];

let empty: string | null = null;
/** An empty folder of this process's: the second lower layer a read-only overlay needs. */
function emptyLayer(): string {
  if (!empty || !existsSync(empty)) empty = mkdtempSync(join(tmpdir(), 'botons-sandbox-empty-'));
  return empty;
}

/**
 * The trees a plan shows: the system ones, then the folders its PATH lists and Node's own install (the toolchains a
 * workspace's commands run), each one only where it isn't inside one already shown or a hidden path.
 *
 * A folder with another filesystem mounted inside it (/snap with each snap's image, /nix with /nix/store) is not
 * shown whole: in bubblewrap's user namespace those mounts are locked, and the kernel refuses an overlay whose lower
 * layer has one beneath it (EINVAL), which would leave the whole sandbox unmade. An overlay never shows what is
 * mounted beneath its lower layer anyway. Such a folder is left out (`unshown`), never bound instead, and what lies
 * inside it that the view lists on its own (/nix/store, a folder on PATH) is still tried as its own tree.
 */
export function viewOf(plan: SandboxPlan): { trees: { path: string; link: string | null }[]; unshown: string[]; masked: string[] } {
  const hidden = plan.hidden.flatMap((p) => [resolve(p), real(p)]);
  const mounts = mountPoints();
  const trees: { path: string; link: string | null }[] = [];
  const unshown: string[] = [];
  const shown = (p: string) => trees.some((t) => !t.link && within(p, t.path));
  const mountedInside = (p: string) => {
    const r = real(p);
    return mounts.some((m) => m !== r && within(m, r));
  };
  const show = (path: string) => {
    if (mountedInside(path)) unshown.push(path);
    else trees.push({ path, link: null });
  };
  for (const path of SYSTEM_TREES) {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) trees.push({ path, link: readlinkSync(path) });
      else if (st.isDirectory() && !shown(path)) show(path);
    } catch {}
  }
  const tools = [dirname(dirname(real(process.execPath))), ...(plan.env.PATH ?? '').split(':').filter((d) => isAbsolute(d)).map(real), ...(plan.trees ?? []).map(real)];
  for (const path of tools) {
    if (path === '/' || shown(path) || unshown.includes(path) || hidden.some((h) => within(path, h) || within(h, path)) || plan.writable.some((w) => within(path, real(w)))) continue;
    try {
      if (statSync(path).isDirectory()) show(path);
    } catch {}
  }
  if (!plan.apart) return { trees, unshown, masked: [] };
  return keepApart(trees, unshown, plan.apart);
}

/** One line of a mountinfo file: the filesystem (major:minor), the folder of it mounted, and where. */
export interface Mount {
  dev: string;
  root: string;
  at: string;
}

const unescape = (m: string) => m.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** Each line of a mountinfo file, in its order (a later mount at the same place is the one on top). */
export function parseMountTable(text: string): Mount[] {
  return text
    .split('\n')
    .map((line) => line.split(' '))
    .filter((f) => f.length > 4 && f[3]!.startsWith('/') && f[4]!.startsWith('/'))
    .map((f) => ({ dev: f[2]!, root: unescape(f[3]!), at: unescape(f[4]!) }));
}

let mountText = (): string => readFileSync('/proc/self/mountinfo', 'utf8');

/** Tests only (set in code, never from a setting): another mount table, or none (null: it can't be read). */
export function useMountTable(text: string | null | undefined): void {
  mountText = text === undefined ? () => readFileSync('/proc/self/mountinfo', 'utf8') : () => {
    if (text === null) throw new Error('no mount table');
    return text;
  };
}

/** This process's mounts, or null when they can't be read. */
export function mountTable(): Mount[] | null {
  try {
    return parseMountTable(mountText());
  } catch {
    return null;
  }
}

/**
 * Where `p` (a real path) really is: its filesystem, and its path in that filesystem from the top mount it lies in. Two
 * paths with the same filesystem, one inside the other there, are the same files, whatever their paths say.
 */
export function placeOf(p: string, mounts: Mount[]): { dev: string; path: string } | null {
  let best: Mount | null = null;
  for (const m of mounts) if (within(p, m.at) && (!best || m.at.length >= best.at.length)) best = m;
  if (!best) return null;
  const rest = p.slice(best.at === '/' ? 0 : best.at.length);
  return { dev: best.dev, path: rest ? join(best.root, rest) : best.root };
}

function keepApart(trees: { path: string; link: string | null }[], unshown: string[], apart: string[]) {
  const mounts = mountTable();
  if (!mounts) return { trees: [], unshown: [...unshown, ...trees.filter((t) => !t.link).map((t) => t.path)], masked: [] };
  const roots = new Set<string>();
  for (const a of apart) {
    for (const p of new Set([resolve(a), real(a)])) {
      roots.add(p);
      // Another filesystem mounted inside one is part of it: its own files, wherever else they show.
      for (const m of mounts) if (within(m.at, p)) roots.add(m.at);
    }
  }
  const places = [...roots].map((r) => placeOf(r, mounts)).filter((x): x is { dev: string; path: string } => !!x);
  const kept: { path: string; link: string | null }[] = [];
  const masked: string[] = [];
  for (const t of trees) {
    if (t.link) {
      kept.push(t);
      continue;
    }
    const at = placeOf(real(t.path), mounts);
    if (!at) {
      unshown.push(t.path);
      continue;
    }
    const same = places.filter((a) => a.dev === at.dev);
    if (same.some((a) => within(at.path, a.path))) {
      unshown.push(t.path);
      continue;
    }
    kept.push(t);
    for (const a of same) if (within(a.path, at.path)) masked.push(join(t.path, a.path.slice(at.path === '/' ? 0 : at.path.length)));
  }
  return { trees: kept, unshown, masked };
}

/** The mount points of this process's mount namespace, as /proc/self/mountinfo lists them (none where it can't be read). */
export function mountPoints(): string[] {
  try {
    return parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'));
  } catch {
    return [];
  }
}

/** The mount point of each line of a mountinfo file: its fifth field, with the kernel's octal escapes (\040) undone. */
export function parseMountinfo(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.split(' ')[4])
    .filter((m): m is string => !!m && m.startsWith('/'))
    .map((m) => m.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The bubblewrap arguments for `plan`, up to the command. Each host tree is a read-only overlay, never a bind: a named
 * pipe or a socket file seen through an overlay is the overlay's own inode, so opening or connecting to it never
 * reaches the program on the host that made it (the check in sandboxProblem() proves that on this machine first).
 */
export function bwrapArgs(plan: SandboxPlan): string[] {
  const args = [...BASE, ...(plan.network ? ['--share-net'] : [])];
  const layer = emptyLayer();
  const { trees, masked } = viewOf(plan);
  for (const t of trees) {
    if (t.link) args.push('--symlink', t.link, t.path);
    else args.push('--overlay-src', layer, '--overlay-src', t.path, '--ro-overlay', t.path);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/run');
  // A hidden path inside a tree it shows, and, when it is a link, what it points to; the outermost only.
  const inView = (p: string) => trees.some((t) => !t.link && within(p, t.path));
  if (plan.network) {
    const conf = resolverFile(plan, inView);
    if (conf) args.push('--ro-bind', conf, conf);
  }
  const hidden = new Map<string, boolean>();
  for (const p of [...plan.hidden, ...masked]) {
    for (const path of new Set([resolve(p), real(p)])) {
      if (!inView(path)) continue;
      try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) continue;
        hidden.set(path, st.isDirectory());
      } catch {}
    }
  }
  const outer = [...hidden.keys()].filter((p) => ![...hidden.keys()].some((o) => o !== p && within(p, o)));
  for (const p of outer.sort()) {
    if (hidden.get(p)) args.push('--tmpfs', p, '--remount-ro', p);
    else args.push('--ro-bind', '/dev/null', p);
  }
  for (const w of plan.writable) args.push('--bind', real(w), real(w));
  for (const ro of plan.readOnly) {
    if (ro.dir) mkdirSync(ro.path, { recursive: true });
    if (!existsSync(ro.path)) continue;
    const p = real(ro.path);
    // Only on top of a folder it could otherwise write: anything else is read-only already.
    if (plan.writable.some((w) => within(p, real(w)))) args.push('--ro-bind', p, p);
  }
  args.push('--remount-ro', '/', '--seccomp', String(FILTER_FD), '--chdir', real(plan.cwd), '--clearenv');
  for (const [k, v] of Object.entries(plan.env)) args.push('--setenv', k, v);
  return args;
}

/**
 * The file /etc/resolv.conf points to when that is outside the view (systemd-resolved's, in /run): a regular file, not
 * in a folder the plan keeps apart. Null when there is none to add.
 */
function resolverFile(plan: SandboxPlan, inView: (p: string) => boolean): string | null {
  try {
    if (!lstatSync('/etc/resolv.conf').isSymbolicLink()) return null;
    const conf = realpathSync('/etc/resolv.conf');
    if (inView(conf) || !statSync(conf).isFile()) return null;
    const mounts = plan.apart ? mountTable() : [];
    if (!mounts) return null;
    const at = placeOf(conf, mounts);
    const near = (plan.apart ?? []).map((a) => placeOf(real(a), mounts));
    if (plan.apart && (!at || near.some((a) => !a || (a.dev === at.dev && (within(at.path, a.path) || within(a.path, at.path)))))) return null;
    return conf;
  } catch {
    return null;
  }
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  /** More output came than `maxBytes`: the middle of it was left out. */
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Its time ran out or it was stopped while running: what it did before that stands, and may be partial. */
  cutShort: boolean;
}

export interface RunOptions {
  argv: string[];
  /** null: run as the server's user, outside any sandbox (Full computer access). */
  sandbox: SandboxPlan | null;
  /** Without a sandbox: where it runs and its whole environment. */
  cwd: string;
  env: Record<string, string>;
  stdin?: Buffer | string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Each of stdout and stderr keeps at most this many bytes: its start and its end. */
  maxBytes: number;
  /** stdout is kept whole up to maxBytes, never its end (a file being read). */
  headOnly?: boolean;
}

/** Runs one process (in its own process group, all of it killed at the end of its time or on a stop). */
export function runProcess(opts: RunOptions): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal.aborted) {
      resolvePromise({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, timedOut: false, aborted: true, cutShort: false });
      return;
    }
    // No sandboxed process runs without its filter.
    const filter = opts.sandbox ? seccompFilter() : null;
    if (opts.sandbox && !filter) {
      reject(new Error(`the sandbox has no socket filter for ${process.arch}`));
      return;
    }
    // The bubblewrap its check passed, still the same file, by its real path: anything else, and nothing runs.
    // Checked again here when it changed or its check is old (synchronously: nothing runs in between).
    let bin = opts.sandbox && filter ? verifiedExe(BWRAP, filter) : null;
    if (opts.sandbox && !bin) {
      const problem = sandboxProblem();
      bin = problem ? null : verifiedExe(BWRAP, filter!);
      if (!bin) {
        reject(new Error(problem ?? 'the sandbox changed while Botons checked it'));
        return;
      }
    }
    const [cmd, args] = opts.sandbox ? [bin!, [...bwrapArgs(opts.sandbox), '--', ...opts.argv]] : [opts.argv[0], opts.argv.slice(1)];
    // Last before the spawn, synchronously: no descriptor the server was started with goes in.
    const held = opts.sandbox ? closeInherited() : null;
    if (held) {
      reject(new Error(held));
      return;
    }
    const child = spawn(cmd, args, {
      cwd: opts.sandbox ? '/' : opts.cwd,
      env: opts.sandbox ? { PATH: process.env.PATH ?? '/usr/bin:/bin' } : opts.env,
      // The filter's pipe: bubblewrap reads it whole and closes it before the command starts.
      stdio: opts.sandbox ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (filter) {
      const pipe = child.stdio[FILTER_FD] as NodeJS.WritableStream & { on: (e: string, f: () => void) => void };
      pipe.on('error', () => {});
      pipe.end(filter);
    }
    const out = new Bounded(opts.maxBytes, !!opts.headOnly);
    const err = new Bounded(Math.min(opts.maxBytes, 16 * 1024), false);
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.add(c));
    child.stderr.on('data', (c: Buffer) => err.add(c));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      // Anything it left running in its group goes too.
      kill();
      const stdout = out.value();
      resolvePromise({ code, signal, stdout, stderr: err.value().toString('utf8'), truncated: out.cut || err.cut, timedOut, aborted, cutShort: timedOut || aborted });
    });
  });
}

/** At most `max` bytes: the first part and (unless headOnly) the last, with how much was left out between. */
class Bounded {
  #max: number;
  #headOnly: boolean;
  #head: Buffer[] = [];
  #headSize = 0;
  #tail = Buffer.alloc(0);
  #dropped = 0;
  cut = false;
  constructor(max: number, headOnly: boolean) {
    this.#max = max;
    this.#headOnly = headOnly;
  }
  add(c: Buffer) {
    const headMax = this.#headOnly ? this.#max : Math.floor(this.#max * 0.6);
    if (this.#headSize < headMax) {
      const take = c.subarray(0, headMax - this.#headSize);
      this.#head.push(take);
      this.#headSize += take.length;
      c = c.subarray(take.length);
    }
    if (!c.length) return;
    this.cut = true;
    if (this.#headOnly) {
      this.#dropped += c.length;
      return;
    }
    const tailMax = this.#max - headMax;
    const joined = Buffer.concat([this.#tail, c]);
    this.#dropped += Math.max(0, joined.length - tailMax);
    this.#tail = joined.subarray(Math.max(0, joined.length - tailMax));
  }
  value(): Buffer {
    const head = Buffer.concat(this.#head);
    if (!this.#dropped) return Buffer.concat([head, this.#tail]);
    if (this.#headOnly) return head;
    return Buffer.concat([head, Buffer.from(`\n[… ${this.#dropped} bytes left out …]\n`), this.#tail]);
  }
}
