import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodexConfigRepair, CodexConfigRepairResult } from '../../shared/types.ts';
import { codexConfigSymlinks } from './isolation.ts';

const MAX_BYTES = 1024 * 1024;
const configHome = (env: NodeJS.ProcessEnv) => resolve(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'));

/** Only direct links to bounded regular files: never traverse or copy a directory tree. */
function snapshot(path: string) {
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new Error('The config directory has a symlinked parent; review it on the server.');
  const link = lstatSync(path);
  if (!link.isSymbolicLink()) throw new Error('This path is no longer a symlink. Refresh the repair preview.');
  const text = readlinkSync(path);
  const target = realpathSync(path);
  if (!lstatSync(target).isFile()) throw new Error('Only regular file targets can be copied here.');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Only regular files up to 1 MiB can be copied here. Review directories and other targets on the server.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    const bytes = buffer.subarray(0, size);
    if (bytes.length > MAX_BYTES) throw new Error('The target grew; refresh the repair preview.');
    const token = createHash('sha256').update(JSON.stringify([path, text, target, link.dev, link.ino, link.mtimeMs, stat.dev, stat.ino, stat.mtimeMs, stat.mode])).update(bytes).digest('hex');
    return { text, target, bytes, token };
  } finally { closeSync(fd); }
}

export function previewCodexRepairs(env: NodeJS.ProcessEnv = process.env): CodexConfigRepair[] {
  const home = configHome(env);
  return codexConfigSymlinks(env, env.HOME || homedir()).map((id) => {
    const path = id === 'CODEX_HOME' ? home : join(home, id.slice('CODEX_HOME/'.length));
    try {
      const s = snapshot(path);
      return { id, path, target: s.target, backup: join(home, '.botons-link-backups', `${basename(path)}-${s.token.slice(0, 16)}`), token: s.token, problem: null };
    } catch {
      return { id, path, target: null, backup: null, token: null, problem: 'This link cannot be copied safely here. It may be a directory, dangling, unreadable, larger than 1 MiB, or inside a symlinked config directory. Review it on the server.' };
    }
  });
}

/** Transport supplies explicit consent; token pins the exact preview, including the current target contents. */
export function repairCodexConfig(id: string, token: string, audit: (phase: 'confirmed' | 'completed' | 'failed', repair: CodexConfigRepair) => void, env: NodeJS.ProcessEnv = process.env): CodexConfigRepairResult {
  const preview = previewCodexRepairs(env).find((p) => p.id === id && p.token === token);
  if (!preview?.backup) throw new Error('The link or its target changed, or cannot be repaired safely. Refresh and review the repair again.');
  const s = snapshot(preview.path);
  if (s.token !== token) throw new Error('The link or target changed. Refresh and review the repair again.');
  const staging = join(dirname(preview.path), `.botons-copy-${randomUUID()}`);
  // Required audit before touching the owner’s configuration. Refuse if it cannot be recorded.
  audit('confirmed', preview);
  try {
    writeFileSync(staging, s.bytes, { flag: 'wx', mode: 0o600 });
    // Keep backup links beneath a regular directory: Codex masks top-level entries,
    // so a top-level symlink backup would cause the same mount failure. Preserve raw
    // link text for restoration to the original location (relative links may not resolve here).
    const backups = dirname(preview.backup);
    try { mkdirSync(backups, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(backups).isDirectory() || realpathSync(backups) !== backups) throw new Error('The backup directory must be a regular directory. Review it on the server.');
    symlinkSync(s.text, preview.backup);
    if (snapshot(preview.path).token !== token) throw new Error('The link or target changed. The backup was kept; refresh and review again.');
    renameSync(staging, preview.path);
  } catch (error) {
    audit('failed', preview);
    throw error;
  } finally { rmSync(staging, { force: true }); }
  // Replacement has committed. An audit failure cannot turn that into a failed repair.
  try { audit('completed', preview); } catch {
    return { ...preview, warning: 'The file was replaced and the link backup was kept. Confirmation was audited, but the completion audit could not be written. Check the server audit log and storage before making more changes.' };
  }
  return preview;
}
