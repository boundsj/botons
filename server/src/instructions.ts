import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { heldLookups, heldPath, holdBeneath, holdDir, LinkInTheWay, NoHeldLookups, under, type HeldDir } from './held-dir.ts';
import { log } from './log.ts';

// What agent CLIs load as standing instructions from a workspace: a sandboxed (webhook) turn must not
// leave any behind, or every later turn of the Boton, Full computer ones included, would follow them.
export const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'];

/** The paths a sandboxed turn in `cwd` may not write (files or folders; they need not exist). */
export function instructionPaths(cwd: string): string[] {
  return [...INSTRUCTION_FILES, '.codex', '.agents'].map((name) => join(cwd, name));
}

const WALK_MAX_DEPTH = 8;
const WALK_MAX_ENTRIES = 20_000;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

type Entry = { kind: 'file'; data: Buffer | null; size: number; mtimeMs: number } | { kind: 'link'; target: string };

/** Tests only: called right before each instruction file is read, by its relative path (to change things there). */
export interface SnapshotHooks {
  beforeRead?: (rel: string) => void;
}

/**
 * The entry `name` in the open folder `dir` (held-dir.ts), never through a link: a link is noted as a link, and a
 * file is read from the descriptor opened, at most SNAPSHOT_MAX_BYTES of it. The turn can swap anything in its
 * workspace meanwhile; what is read is still what was there, in the workspace.
 */
function entryIn(dir: HeldDir, name: string): Entry | null {
  const at = under(dir, name);
  let fd: number;
  try {
    // Non-blocking, so a named pipe put there doesn't hang the open; it is not a file, so it is left alone.
    fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ELOOP') return null;
    try {
      return { kind: 'link', target: readlinkSync(at) };
    } catch {
      return null;
    }
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > SNAPSHOT_MAX_BYTES) return { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, data: null };
    const buf = Buffer.alloc(SNAPSHOT_MAX_BYTES + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    // Grown past the limit since its size was read: too big to keep a copy of.
    if (n > SNAPSHOT_MAX_BYTES) return { kind: 'file', size: n, mtimeMs: st.mtimeMs, data: null };
    return { kind: 'file', size: n, mtimeMs: st.mtimeMs, data: Buffer.from(buf.subarray(0, n)) };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function same(a: Entry, b: Entry): boolean {
  if (a.kind === 'link' || b.kind === 'link') return a.kind === 'link' && b.kind === 'link' && a.target === b.target;
  if (a.size !== b.size) return false;
  // Too big to keep a copy of: unchanged if it wasn't written.
  return a.data && b.data ? a.data.equals(b.data) : a.mtimeMs === b.mtimeMs;
}

/**
 * Every instruction file under `root` (by relative path), within the walk's limits. Each folder is opened from the one
 * above it and held open while it is listed and its files read, never through a link (held-dir.ts): the server reads
 * here outside the turn's sandbox, so a folder the turn swapped for a link to one of the owner's is not followed.
 */
async function findInstructionFiles(root: string, hooks: SnapshotHooks): Promise<Map<string, Entry>> {
  const found = new Map<string, Entry>();
  let top: HeldDir;
  try {
    top = holdDir(root);
  } catch {
    return found;
  }
  let seen = 0;
  const walk = async (dir: HeldDir, rel: string[], depth: number) => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(heldPath(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (++seen > WALK_MAX_ENTRIES) return;
      const path = [...rel, d.name];
      if (INSTRUCTION_FILES.includes(d.name) && (d.isFile() || d.isSymbolicLink())) {
        hooks.beforeRead?.(join(...path));
        const e = entryIn(dir, d.name);
        if (e) found.set(join(...path), e);
      } else if (d.isDirectory() && depth < WALK_MAX_DEPTH && !SKIP_DIRS.has(d.name)) {
        let sub: HeldDir;
        try {
          sub = holdBeneath(dir, [d.name]);
        } catch {
          continue;
        }
        try {
          await walk(sub, path, depth + 1);
        } finally {
          closeSync(sub.fd);
        }
      }
    }
  };
  try {
    await walk(top, [], 0);
  } finally {
    closeSync(top.fd);
  }
  return found;
}

/**
 * Puts `e` (or nothing) at `rel`, by folders held open from the workspace down (held-dir.ts): the server does this
 * outside the turn's sandbox, so a folder on the way the turn replaced with a link is not followed but refused.
 */
function putAt(top: HeldDir, rel: string, e: Entry | undefined): void {
  const parts = rel.split(sep);
  const name = parts.pop()!;
  let dir: HeldDir;
  try {
    dir = holdBeneath(top, parts, e?.kind === 'file');
  } catch (err) {
    // Nothing to take away under a folder that isn't there.
    if (!e && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    const at = under(dir, name);
    try {
      unlinkSync(at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (e?.kind === 'link') symlinkSync(e.target, at);
    else if (e?.kind === 'file' && e.data) {
      // A new file of its own: never through a link put there meanwhile.
      const fd = openSync(at, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
      try {
        for (let n = 0; n < e.data.length; ) n += writeSync(fd, e.data, n, e.data.length - n);
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    if (dir !== top) closeSync(dir.fd);
  }
}

/**
 * Note the workspace's instruction files before a sandboxed turn. The function it returns puts back
 * what the turn created, changed or deleted, and returns their relative paths.
 */
export async function snapshotInstructions(root: string, hooks: SnapshotHooks = {}): Promise<() => Promise<string[]>> {
  // Without lookups in an open folder (not Linux) nothing is read or put back by path: a swap would redirect it.
  if (!heldLookups) throw new NoHeldLookups();
  const before = await findInstructionFiles(root, hooks);
  return async () => {
    const after = await findInstructionFiles(root, {});
    const undone: string[] = [];
    let top: HeldDir;
    try {
      top = holdDir(root);
    } catch (err) {
      log.warn('could not put back the instruction files a sandboxed turn changed: its workspace could not be opened', { root, err });
      return undone;
    }
    const put = (rel: string, e: Entry | undefined) => {
      const path = join(root, rel);
      try {
        if (e?.kind === 'file' && !e.data) {
          // What the turn left there still goes.
          putAt(top, rel, undefined);
          log.warn('could not put back an instruction file a sandboxed turn changed: it was too big to keep a copy of', { path });
          return;
        }
        putAt(top, rel, e);
        undone.push(rel);
      } catch (err) {
        if (err instanceof LinkInTheWay) log.warn('did not put back an instruction file a sandboxed turn changed: a folder on its way is now a link, which is not followed', { path });
        else log.warn('could not put back an instruction file a sandboxed turn changed', { path, err });
      }
    };
    try {
      for (const [rel, e] of after) {
        const was = before.get(rel);
        if (!was || !same(was, e)) put(rel, was);
      }
      for (const [rel, was] of before) if (!after.has(rel)) put(rel, was);
    } finally {
      closeSync(top.fd);
    }
    return undone;
  };
}
