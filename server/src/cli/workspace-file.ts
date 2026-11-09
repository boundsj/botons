import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { heldLookups, holdBeneath, holdDir, LinkInTheWay, under, type HeldDir } from '../held-dir.ts';
import { inside } from '../util.ts';

export class WorkspaceFileError extends Error {}

function realpath(path: string, what: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    throw new WorkspaceFileError(`Can't read ${what}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

/**
 * The text of a regular file inside `workspace` ($BOTON_WORKSPACE, not the current folder, which the
 * Boton can change). `botons` runs outside a Workspace Boton's sandbox, so without this check
 * `--file ~/.ssh/id_ed25519` would hand it a private file: every symlink is followed, the file opened
 * must be the one checked (so a symlink swapped in between doesn't help), and hard links are refused.
 * The Boton's sandboxed shell can rename and relink its folders while this runs, so the file is opened from the
 * workspace folder down, one folder at a time, each held open and none through a link (held-dir.ts).
 */
export function readWorkspaceFile(
  path: string,
  workspace: string,
  maxBytes = 256 * 1024,
  { flag, instead } = { flag: '--file', instead: 'pass the text with --body' },
): string {
  if (!workspace) throw new WorkspaceFileError(`${flag} can't be used here: $BOTON_WORKSPACE is not set. ${instead[0].toUpperCase()}${instead.slice(1)} instead.`);
  // Nothing to read it through but its path, which a swap between two steps redirects.
  if (!heldLookups) throw new WorkspaceFileError(`${flag} needs Linux, where Botons opens the file through folders it holds open; ${instead}.`);
  const root = realpath(workspace, `your workspace (${workspace})`);
  const outside = () => new WorkspaceFileError(`${flag} must be a file in your workspace (${workspace}); ${path} is not. Copy it there first, or ${instead}.`);
  const real = realpath(resolve(path), path);
  if (!inside(root, real)) throw outside();
  const parts = relative(root, real).split(sep);
  const leaf = parts.pop()!;
  if (!leaf) throw new WorkspaceFileError(`${path} is not a regular file.`);
  let top: HeldDir;
  let dir: HeldDir;
  let fd: number;
  try {
    top = holdDir(root);
  } catch (e) {
    throw new WorkspaceFileError(`Can't read your workspace (${workspace}): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    dir = holdBeneath(top, parts);
    try {
      // Non-blocking, so a FIFO doesn't hang the open; it is refused below.
      fd = openSync(under(dir, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } finally {
      if (dir !== top) closeSync(dir.fd);
    }
  } catch (e) {
    // A link on the way now, which the check above didn't see: changed meanwhile.
    if (e instanceof LinkInTheWay || (e as NodeJS.ErrnoException).code === 'ELOOP') throw outside();
    throw new WorkspaceFileError(`Can't read ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  } finally {
    closeSync(top.fd);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new WorkspaceFileError(`${path} is not a regular file.`);
    if (st.nlink > 1) throw new WorkspaceFileError(`${path} has other hard links, so it can't be read with ${flag}. Copy it to a new file, or ${instead}.`);
    const tooLarge = (size: number) => new WorkspaceFileError(`${path} is too large (${size} bytes; at most ${maxBytes}).`);
    if (st.size > maxBytes) throw tooLarge(st.size);
    // At most maxBytes, even if it grows meanwhile.
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > maxBytes) throw tooLarge(n);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
