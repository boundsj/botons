import { readFileSync, existsSync, lstatSync, readdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
export type ManagedProvider = 'codex-cli' | 'claude-cli';
export const managedRoot = (userHome = homedir()) => join(userHome, '.local/share/botons');
const cliName = (provider: ManagedProvider) => (provider === 'codex-cli' ? 'codex' : 'claude');

/** The first executable `name` on `path`, as a shell would find it; null when there is none. */
export function onPath(name: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    try { const file = join(dir, name); if (statSync(file).isFile() && (statSync(file).mode & 0o111)) return file; } catch {}
  }
  return null;
}

/** Whether two CLI settings ("codex", "/usr/bin/codex", a symlink to it) run the same file. */
export function sameCli(a: string, b: string, path = process.env.PATH ?? ''): boolean {
  if (a === b) return true;
  const real = (bin: string) => { try { const file = bin.includes('/') ? bin : onPath(bin, path); return file ? realpathSync(file) : null; } catch { return null; } };
  const x = real(a);
  return x !== null && x === real(b);
}

/** Botons' own copy: one Settings → Brains installed, or the installer's, both under the managed root. */
export function isManagedBin(bin: string, provider: ManagedProvider, root = managedRoot()): boolean {
  const path = relative(join(root, 'clis'), bin), name = cliName(provider);
  return isAbsolute(bin) && (path === `${name}/bin/${name}` || new RegExp(`^${provider}/releases/[a-zA-Z0-9-]+/bin/${name}$`).test(path));
}

/** The copy a terminal on this machine runs as `codex` or `claude`, when it is another file than Botons' `bin`. */
export function terminalCli(provider: ManagedProvider, bin: string, path = process.env.PATH ?? ''): string | null {
  const found = onPath(cliName(provider), path);
  return found && !sameCli(found, bin, path) ? found : null;
}

export function managedBin(home: string, provider: ManagedProvider, fallback: string, root = managedRoot(), searchPath = process.env.PATH ?? ''): string {
  try {
    const record = JSON.parse(readFileSync(join(home, 'managed-clis.json'), 'utf8'))[provider];
    if (!record || typeof record.bin !== 'string') return fallback;
    // The same system copy, named another way ("codex" or its full path), keeps Botons' own; another copy wins.
    if (fallback !== record.bin && !(typeof record.previous === 'string' && sameCli(fallback, record.previous, searchPath))) return fallback;
    const path = relative(join(root, 'clis', provider, 'releases'), record.bin);
    if (isAbsolute(path) || path.startsWith('..') || !/^[a-zA-Z0-9-]+\/bin\/(codex|claude)$/.test(path)) return fallback;
    return record.bin;
  } catch { return fallback; }
}

/** Call only after turns drain, or at startup before turns begin. Never clean system paths or links. */
export function pruneManagedReleases(root: string, provider: ManagedProvider, current: string): void {
  const releases = join(root, 'clis', provider, 'releases');
  const selected = relative(releases, current);
  if (!/^[0-9a-f-]{36}\/bin\/(codex|claude)$/.test(selected) || !existsSync(current)) return;
  try {
    for (const path of [root, join(root, 'clis'), join(root, 'clis', provider), releases]) if (lstatSync(path).isSymbolicLink()) return;
    const selectedRelease = join(releases, selected.split('/')[0]);
    if (lstatSync(selectedRelease).isSymbolicLink() || lstatSync(join(selectedRelease, 'bin')).isSymbolicLink()) return;
    const backing = relative(selectedRelease, realpathSync(current));
    if (isAbsolute(backing) || backing === '..' || backing.startsWith('../')) return;
    for (const entry of readdirSync(releases, {withFileTypes:true})) {
      if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name) || selected.startsWith(entry.name + '/')) continue;
      rmSync(join(releases, entry.name), {recursive:true, force:true});
    }
  } catch { /* Retaining an old release must not prevent startup or undo activation. */ }
}
