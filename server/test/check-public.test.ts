import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseTerms, scan } from '../../scripts/check-public.ts';
import { tempDir } from './helpers.ts';

const script = resolve(import.meta.dirname, '../../scripts/check-public.ts');
const rules = (text: string, terms?: RegExp[]) => scan(text, 'f', terms).map((p) => p.rule);
// Real-looking values are built from pieces so this file passes the check itself.
const EMAIL = 'dana' + '@' + 'mail.io';

test('check:public lets placeholders through and flags real emails, tailnets, home folders, links, ids, secrets and private terms', () => {
  const fine = [
    'sam@example.com you@mail.example.org a@b.test noreply@anthropic.com git@github.com icon@2x.png',
    'myhost.example-tailnet.ts.net fd7a:115c:a1e0::1 /home/you /Users/me C:\\Users\\me -home-u-Projects /home/node',
    '"orgId": "00000000-0000-0000-0000-000000000000" https://example.com/home/feed',
  ];
  assert.deepEqual(rules(fine.join('\n')), []);
  const real = [
    EMAIL,
    '1234+dana' + '@users.noreply.github.com',
    'box.tail9f8e7d' + '.ts' + '.net',
    'fd7a:115c:a1e0:' + 'ab12:cd34::1',
    '/home/' + 'dana',
    'C:\\Users\\' + 'dana',
    '-home-' + 'dana-Projects',
    'https://docs.' + 'google.com/document/d/abc',
    '"orgId' + '": "9f1c2d3e-aaaa"',
    'gh' + 'p_' + 'a1'.repeat(18),
    'sk-' + 'proj-' + 'x'.repeat(40),
    't' + 'k_' + 'a1b2c3'.repeat(4) + 'abcde',
  ];
  assert.deepEqual(
    real.map((r) => rules(r)[0]),
    ['email', 'email', 'tailnet', 'tailnet address', 'home folder', 'home folder', 'home folder', 'private link', 'account id', 'secret', 'secret', 'secret'],
  );
  const terms = parseTerms('# a comment\n\nproject\\s+falcon\n');
  assert.deepEqual(scan('ok\nnotes on Project  Falcon', 'f', terms), [{ where: 'f:2', rule: 'private term', match: 'Project  Falcon' }]);
  assert.throws(() => parseTerms('ok\n(unclosed', 'terms.txt'), { message: 'terms.txt line 2 is not a valid regex' });
});

test('check:public walks the repo, a commit range and named text, and exits 1 on a problem and 2 when it cannot check', () => {
  const dir = tempDir('botons-check-public-');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  const run = (args: string[] = [], env: Record<string, string> = {}, path = script) =>
    spawnSync(process.execPath, [path, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PRIVATE_TERMS_FILE: join(dir, 'no-terms'), ...env } });

  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'start');
  assert.equal(run().status, 0);

  // Added in one commit and removed in the next: the tree is clean, the range is not.
  writeFileSync(join(dir, 'a.txt'), `hello ${EMAIL}\n`);
  git('commit', '-qam', `mail ${EMAIL}`);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('commit', '-qam', 'tidy');
  assert.equal(run().status, 0);
  const range = run(['--commits', 'main~2..main']);
  assert.equal(range.status, 1);
  assert.match(range.stderr, /^commit \w+:1: email: …@mail\.io$/m);
  assert.match(range.stderr, /^commit \w+ a\.txt: email: …@mail\.io$/m);
  assert.equal(run(['--commits', 'nope..main']).status, 2);

  // Text passed by name (a pull request's description), and the private terms list.
  assert.equal(run(['--text', 'PR_BODY'], { PR_BODY: `see ${EMAIL}` }).status, 1);
  writeFileSync(join(dir, 'terms'), 'hello\n');
  assert.match(run([], { PRIVATE_TERMS_FILE: join(dir, 'terms') }).stderr, /^a\.txt:1: private term: hello$/m);

  // New files count before they are added, binaries are flagged, and a call through a symlink still checks.
  writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const binary = run();
  assert.equal(binary.status, 1);
  assert.match(binary.stderr, /^shot\.png: binary file/m);
  symlinkSync(dirname(script), join(dir, 'linked'));
  assert.equal(run([], {}, join(dir, 'linked', 'check-public.ts')).status, 1);
});

test('the backup, restore, doctor and migrate:names scripts, the Botons CLI and the restore rehearsal load only Node builtins, so they run without node_modules', () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${file} imports ${spec}`);
      walk(resolve(dirname(file), spec));
    }
  };
  const repo = resolve(import.meta.dirname, '../..');
  walk(join(repo, 'scripts/backup.ts'));
  walk(join(repo, 'scripts/restore.ts'));
  walk(join(repo, 'scripts/doctor.ts'));
  walk(join(repo, 'scripts/migrate-names.ts'));
  walk(join(repo, 'server/src/cli/botons.ts'));
  // The restore rehearsal's child process: what it parses and opens is only Node's own code and these files.
  walk(join(repo, 'server/src/rehearsal.ts'));
  assert.ok(seen.has(join(repo, 'shared/legacy-names.mjs')) && seen.has(join(repo, 'server/src/legacy-upgrade.ts')) && seen.has(join(repo, 'server/src/config.ts')) && seen.has(join(repo, 'server/src/cli/workspace-file.ts')));
});


test('only the exact license copyright line may contain the owner name', () => {
  const line = ['Copyright (c) 2026', 'Jes' + 'se', 'Bounds'].join(' ');
  const terms = [new RegExp(['Jes' + 'se', 'Bounds'].join(' '), 'i')];
  assert.deepEqual(scan(line, 'LICENSE', terms), []);
  assert.deepEqual(scan(line, 'commit abc123 LICENSE', terms), []);
  assert.equal(scan(line, 'README.md', terms).length, 1);
  assert.equal(scan(line + ' extra', 'LICENSE', terms).length, 1);
});


test('public project links are scoped to About and exact README install URLs', () => {
  const owner = 'bounds' + 'j';
  const url = `https://github.com/${owner}/botons`;
  const terms = [new RegExp(owner, 'i')];
  const about = 'web/src/components/SettingsDialog.tsx';
  for (const path of ['', '/blob/main/LICENSE', '/security/advisories']) assert.deepEqual(scan(url + path, about, terms), []);
  for (const text of [url.replace('/botons', '/other'), url + '-x', owner]) assert.equal(scan(text, about, terms).length, 1);
  for (const file of ['README.md', 'commit abc123 README.md']) {
    for (const suffix of ['', '.git']) assert.deepEqual(scan('npx -y git+' + url + suffix + ' install', file, terms), []);
    for (const text of [url + '/issues', url + '.git.evil', url + '-x', owner, url + ' ' + owner]) {
      assert.equal(scan(text, file, terms).length, 1);
    }
  }
  assert.equal(scan(url, 'docs/install.md', terms).length, 1);
});
