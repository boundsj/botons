import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Report only a commit hash, never a source URL that could contain credentials. */
export function installerRevision(root) {
  let commit = null;
  if (existsSync(join(root, '.git'))) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0 && /^[a-f0-9]{40}$/.test(result.stdout.trim())) commit = result.stdout.trim();
  }
  if (!commit) {
    try {
      // npm strips .git while packing Git dependencies, but retains the resolved SHA in its cache lock.
      const cache = resolve(root, '../..');
      if (basename(resolve(root, '..')) === 'node_modules') {
        const lock = JSON.parse(readFileSync(join(cache, 'package-lock.json'), 'utf8'));
        const entry = lock.packages?.[`node_modules/${basename(root)}`];
        commit = /#([a-f0-9]{40})$/.exec(entry?.resolved || '')?.[1] || null;
      }
    } catch { /* Cache metadata is optional; the fingerprint still identifies the running code. */ }
  }
  const hash = createHash('sha256');
  const installer = join(root, 'installer');
  for (const file of readdirSync(installer).filter(name => name.endsWith('.mjs')).sort()) {
    hash.update(file).update('\0').update(readFileSync(join(installer, file))).update('\0');
  }
  return `Botons installer: commit ${commit || 'unavailable'}, fingerprint ${hash.digest('hex')}`;
}
