import { VERSION } from '../shared/app-version.mjs';
import { cpSync, existsSync, renameSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export function packageRelease(out, name = 'getbotons', version = VERSION) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version');
  mkdirSync(out, { recursive: true });
  const payload = resolve(out, 'payload');
  mkdirSync(payload);
  const files = JSON.parse(readFileSync('package.json')).files;
  for (const item of files) {
    if (['server/package.json', 'web/package.json', 'scripts/dev-env.ts'].includes(item) || (item.startsWith('web/') && item !== 'web/dist/')) continue;
    cpSync(item, resolve(payload, item), { recursive: true });
  }
  const deps = JSON.parse(readFileSync('server/package.json')).dependencies;
  writeFileSync(resolve(payload, 'package.json'), JSON.stringify({ name, version, type: 'module', license: 'MIT', engines: { node: '>=24' }, dependencies: deps }, null, 2));
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev'], { cwd: payload, stdio: 'inherit' });
  if (existsSync(resolve(payload, 'package-lock.json'))) renameSync(resolve(payload, 'package-lock.json'), resolve(payload, 'npm-shrinkwrap.json'));
  for (const item of files.filter(f => f.startsWith('installer/'))) cpSync(item, resolve(out, item), { recursive: true });
  // The installer reads the deprecated names from here before it has the payload's Node (shared/legacy-names.mjs).
  for (const f of ['legacy-names.mjs', 'legacy-names.d.mts', 'service-manager.mjs', 'service-manager.d.mts']) cpSync(resolve('shared', f), resolve(out, 'shared', f));
  for (const file of ['README.md', 'LICENSE']) cpSync(file, resolve(out, file));
  writeFileSync(resolve(out, 'package.json'), JSON.stringify({
    name, version, type: 'module', license: 'MIT',
    description: 'A self-hosted home for AI agents that runs your own Claude Code or Codex.',
    keywords: ['ai', 'agents', 'self-hosted', 'claude-code', 'codex'],
    homepage: 'https://github.com/boundsj/botons#readme',
    repository: { type: 'git', url: 'git+https://github.com/boundsj/botons.git' },
    bugs: { url: 'https://github.com/boundsj/botons/issues' },
    bin: { botons: 'installer/botons.mjs' }, engines: { node: '>=20' },
  }, null, 2));
}
if (process.argv[1] === new URL(import.meta.url).pathname) packageRelease(resolve(process.argv[2] || 'release-package'), process.env.BOTONS_PACKAGE_NAME || 'getbotons');
