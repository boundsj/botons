import { closeSync, constants, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Folders held open, so a path under one is looked up from the folder itself, not again from the root. Server code
 * that reads or writes a Workspace Boton's files runs outside its sandbox, while the Boton can rename and relink anything
 * in its workspace: checking a path and then using it again would follow a folder swapped for a link in between.
 * Linux names an open folder's entries as /proc/self/fd/<fd>/<name>, so each step opens one name in a folder already
 * open, never through a link. Imports Node builtins only (the `botons` CLI loads it).
 */

/**
 * Whether this system can look up a name in an open folder (Linux's /proc/self/fd). Without it nothing here works:
 * a folder looked up again by its path is what a swap between two steps redirects, so there is no fallback to that.
 */
export let heldLookups: boolean = (() => {
  try {
    return process.platform === 'linux' && statSync('/proc/self/fd').isDirectory();
  } catch {
    return false;
  }
})();

/** Tests only (set in code, never from a setting): as on a system without lookups in an open folder. */
export function useHeldLookups(on: boolean): void {
  heldLookups = on;
}

export class NoHeldLookups extends Error {
  constructor() {
    super('this system cannot look up a name in an open folder (Linux /proc/self/fd), so Botons does not touch files a Boton could swap meanwhile');
  }
}

export interface HeldDir {
  fd: number;
  /** Where it was when opened; only for messages. */
  path: string;
}

/** The path that names the open folder `dir` itself. */
export function heldPath(dir: HeldDir): string {
  if (!heldLookups) throw new NoHeldLookups();
  return `/proc/self/fd/${dir.fd}`;
}

export class LinkInTheWay extends Error {}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** The path that names `name` in the open folder `dir`. */
export function under(dir: HeldDir, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error(`not a single name: ${name}`);
  return `${heldPath(dir)}/${name}`;
}

/** Opens the folder at `path` (links followed: the caller trusts it, as the server's own setting). */
export function holdDir(path: string): HeldDir {
  return { fd: openSync(path, constants.O_RDONLY | constants.O_DIRECTORY), path };
}

/**
 * Opens the folder `parts` beneath `root`, one name at a time, refusing a link anywhere on the way (LinkInTheWay). With
 * `create`, missing folders are made. The caller closes what it returns unless it is `root` itself (no `parts`).
 */
export function holdBeneath(root: HeldDir, parts: string[], create = false): HeldDir {
  let cur = root;
  try {
    for (const name of parts) {
      const at = under(cur, name);
      let fd: number;
      try {
        fd = openSync(at, DIR_FLAGS);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && create) {
          try {
            mkdirSync(at);
          } catch (m) {
            if ((m as NodeJS.ErrnoException).code !== 'EEXIST') throw m;
          }
          fd = openSync(at, DIR_FLAGS);
        } else throw e;
      }
      if (cur !== root) closeSync(cur.fd);
      cur = { fd, path: join(cur.path, name) };
    }
    return cur;
  } catch (e) {
    if (cur !== root) closeSync(cur.fd);
    const code = (e as NodeJS.ErrnoException).code;
    // O_NOFOLLOW on a link: ELOOP; O_DIRECTORY on a link it didn't follow, or on a file: ENOTDIR.
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new LinkInTheWay(`${join(root.path, ...parts)} is not a folder of its own: a link or file is in the way`);
    throw e;
  }
}
