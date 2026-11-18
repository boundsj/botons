import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';

// The native app under ios/ is private-only: no publication path may carry it.
const repo = resolve(import.meta.dirname, '../..');
const snapshot = join(repo, 'scripts/public-snapshot.sh');
// No global or system git config, so the owner's identity, hooks and signing never reach the fixture.
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const NATIVE = ['ios/App/AppMain.swift', 'ios/App.xcodeproj/project.pbxproj', 'ios/Config/Release.xcconfig'];

function fixture(extra: Record<string, string> = {}) {
  const dir = tempDir('botons-snapshot-repo-');
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  // The export runs the real privacy check, so the fixture carries it and the module it imports.
  for (const file of ['scripts/check-public.ts', 'shared/legacy-names.mjs']) cpSync(join(repo, file), join(dir, file));
  write('package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { 'check:public': 'node scripts/check-public.ts' } }));
  write('server/src/index.ts', 'export const server = true;\n');
  write('web/src/main.tsx', 'export const web = true;\n');
  write('.claude/settings.local.json', '{}\n');
  for (const path of NATIVE) write(path, 'native sentinel\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', ...args], { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  // Through the index, so a path such as iOS/ stays its own path on a case-insensitive disk too.
  for (const [path, text] of Object.entries(extra)) {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: text, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
  }
  git('commit', '-qm', 'Fixture');
  // A local ref stands in for the fetched remote; there is no remote to contact.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // Local work past origin/main never reaches the export.
  write('server/src/local-only.ts', 'export {};\n');
  git('add', 'server/src/local-only.ts');
  git('commit', '-qm', 'Local only');
  const terms = join(tempDir('botons-snapshot-terms-'), 'terms.txt');
  writeFileSync(terms, 'falcon\\s+project\n');
  return { dir, terms };
}

const run = (dir: string, terms: string, out: string) =>
  spawnSync('bash', [snapshot, out], { cwd: dir, encoding: 'utf8', env: { ...env, PRIVATE_TERMS_FILE: terms } });

const walk = (root: string, dir = root): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === '.git' ? [] : walk(root, join(dir, e.name))) : [relative(root, join(dir, e.name))]);

test('the public snapshot exports origin/main without the native app or local agent settings', () => {
  const { dir, terms } = fixture();
  const out = join(tempDir('botons-snapshot-out-'), 'export');
  const result = run(dir, terms, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(walk(out).sort(), ['package.json', 'scripts/check-public.ts', 'server/src/index.ts', 'shared/legacy-names.mjs', 'web/src/main.tsx']);
  assert.equal(existsSync(join(out, 'ios')), false);
  // The committed snapshot holds the same tree, in one commit, under the project identity.
  const git = (...args: string[]) => execFileSync('git', ['-C', out, ...args], { env, encoding: 'utf8' }).trim();
  assert.deepEqual(git('ls-files').split('\n').sort(), walk(out).sort());
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'Botons <hello@getbotons.com>');
});

test('the public snapshot refuses native sources outside ios/ instead of exporting them', () => {
  for (const path of ['iOS/Widget/Widget.swift', 'web/native/ios/README.md', 'server/src/Bridge.swift', 'web/App.entitlements']) {
    const { dir, terms } = fixture({ [path]: 'native sentinel\n' });
    const out = join(tempDir('botons-snapshot-out-'), 'export');
    const result = run(dir, terms, out);
    assert.equal(result.status, 1, `${path} was exported`);
    assert.match(result.stderr, /Native app sources must stay private/);
    assert.equal(existsSync(join(out, '.git')), false, `${path}: no snapshot commit is made`);
  }
});

test('release artifacts take only allowlists that leave ios/ out', () => {
  const files: string[] = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).files;
  for (const entry of files) assert.ok(!/^\.?\/?ios(\/|$)/i.test(entry) && !entry.includes('*'), `package.json files: ${entry}`);
  const dockerignore = readFileSync(join(repo, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.equal(dockerignore.find((l) => l && !l.startsWith('#')), '**', '.dockerignore starts by excluding everything');
  for (const line of dockerignore.filter((l) => l.startsWith('!'))) assert.ok(!/^!(\.?\/?ios(\/|$)|\*)/i.test(line), `.dockerignore: ${line}`);
});
