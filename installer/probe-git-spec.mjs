// Run in the disposable Debian/Node 22 smoke container, using its bundled npm.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const source = process.argv[2];
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
const home = mkdtempSync(join(tmpdir(), 'botons-git-spec-'));
try {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), npm_config_cache: join(home, 'cache') };
  // Share the cache to include the owner's plain-URL-then-pinned-URL sequence.
  for (const fragment of ['', '#' + sha]) {
    const result = spawnSync('npx', ['-y', `git+file://${source}${fragment}`, 'install', '--dry-run', '--verbose'], { env, encoding: 'utf8', timeout: 120000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const known = fragment && /GitFetcher requires an Arborist constructor to pack a tarball/.test(output);
    console.log(JSON.stringify({ node: process.version, npm, spec: fragment ? 'commit-qualified' : 'plain', result: result.status === 0 ? 'passed' : known ? 'Arborist failure reproduced' : 'unexpected failure' }));
    if (result.status === 0 && !output.includes(`Botons installer: commit ${sha}, fingerprint `)) throw new Error('Launched bootstrap did not identify the fetched commit');
    if (known) console.log('Use the plain npx URL with a fresh cache; select the application ref through --source and --ref.');
    else if (result.status !== 0) throw new Error(output || result.error?.message || 'Git spec probe failed');
  }
} finally { rmSync(home, { recursive: true, force: true }); }
