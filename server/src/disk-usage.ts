import { lstatSync, readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Loads only Node builtins: doctor (which runs without node_modules) counts with it too.

/** Past this many files and folders a count stops, and says it is partial: sizes are then "at least". */
export const COUNT_MAX_ENTRIES = 200_000;

export interface Bytes {
  bytes: number;
  partial: boolean;
}

/**
 * The bytes the files under `path` take (their sizes, not disk blocks), never following a symlink, so a link a Boton
 * planted counts as the link and nothing it points to is read. A missing folder is 0; one it can't read is skipped.
 */
export async function folderBytes(path: string, max = COUNT_MAX_ENTRIES): Promise<Bytes> {
  let bytes = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop() as string;
    if (++seen > max) return { bytes, partial: true };
    let st;
    try {
      st = await lstat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const name of await readdir(p)) stack.push(join(p, name));
      } catch {}
    } else bytes += st.size;
  }
  return { bytes, partial: false };
}

/** folderBytes for doctor, which runs start to end without awaiting. */
export function folderBytesSync(path: string, max = COUNT_MAX_ENTRIES): Bytes {
  let bytes = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop() as string;
    if (++seen > max) return { bytes, partial: true };
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const name of readdirSync(p)) stack.push(join(p, name));
      } catch {}
    } else bytes += st.size;
  }
  return { bytes, partial: false };
}
