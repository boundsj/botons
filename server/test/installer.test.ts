import { test } from 'node:test';
import { serviceManager } from '../../shared/service-manager.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// The bootstrap must remain JavaScript so npm can launch it before Node 24 exists.
const { parse, verified, publicSettings, packageCommands, nodeArchive } = await import('../../installer/botons.mjs');
test('installer rejects incomplete and unknown options', () => {
  for (const args of [['--home'], ['--wat'], ['destroy'], ['--host', 'a\nb']]) assert.throws(() => parse(args));
  assert.deepEqual(parse(['install', '--yes', '--no-service', '--home', '/tmp/botons']), { command: 'install', yes: true, 'no-service': true, home: '/tmp/botons' });
});
test('Node downloads require an exact filename and digest', () => {
  const bytes = Buffer.from('archive');
  const sums = `${createHash('sha256').update(bytes).digest('hex')}  node.tar.xz\n`;
  verified(bytes, sums, 'node.tar.xz');
  assert.throws(() => verified(Buffer.from('bad'), sums, 'node.tar.xz'));
  assert.throws(() => verified(bytes, sums, 'other.tar.xz'));
});

test('public URL persists both OAuth and app origins on install and repair', () => {
  const fresh = publicSettings('PATH=/usr/bin\n', 'https://botons.example.com/');
  assert.match(fresh, /BOTONS_PUBLIC_URL="https:\/\/botons.example.com"/);
  assert.match(fresh, /BOTONS_OAUTH_PUBLIC_URL="https:\/\/botons.example.com"/);
  assert.equal(publicSettings(fresh, 'https://botons.example.com'), fresh);
  const repaired = publicSettings(fresh, 'https://other.example.com/path');
  assert.ok(!repaired.includes('botons.example.com'));
  assert.match(repaired, /PATH=\/usr\/bin/);
  assert.throws(() => publicSettings('', 'http://botons.example.com'));
  assert.throws(() => publicSettings('', 'https://user:password@botons.example.com'));
});

import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installed service and admin scripts execute through a current symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-installer-'));
  try {
    const current = join(home, 'current');
    symlinkSync(resolve('.'), current);
    const env = { ...process.env, ...noRealClis(home), HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
      BOTONS_HOME: join(home, 'data'), BOTONS_PORT: '18973', BOTONS_NO_TAILSCALE: '1' };
    mkdirSync(env.BOTONS_HOME);
    const unitDir = join(home, 'units');
    // This is the same resolved path used by activation.
    const { realpathSync } = requireFs;
    const install = spawnSync(process.execPath, [realpathSync(join(current, 'scripts/install-service.ts')),
      '--app', current, '--dir', unitDir, '--env-path', join(home, 'env')], { env, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const name = process.platform === 'darwin' ? serviceManager({ home }).label + '.plist' : 'botons.service';
    const unit = readFileSync(join(unitDir, name), 'utf8');
    assert.ok(unit.includes(process.platform === 'darwin' ? 'ProgramArguments' : 'ExecStart='));
    assert.ok(unit.includes(current));
    const doctor = spawnSync(process.execPath, [join(current, 'installer/admin.mjs'),
      join(current, 'scripts/doctor.ts'), '--skip-clis', '--skip-network'], { env, encoding: 'utf8' });
    assert.match(doctor.stdout + doctor.stderr, /data|config/);
    assert.notEqual(doctor.stdout.trim(), '');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
import * as requireFs from 'node:fs';

test('dependency remediation lists complete commands and refuses unknown distributions', () => {
  assert.deepEqual(packageCommands('ID=debian\nVERSION_ID=13'), [
    ['apt-get', 'update'],
    ['apt-get', 'install', '-y', 'bubblewrap', 'socat', 'systemd', 'xz-utils', 'tar'],
  ]);
  assert.deepEqual(packageCommands('ID="fedora"'), [
    ['dnf', 'install', '-y', 'bubblewrap', 'socat', 'systemd', 'xz', 'tar'],
  ]);
  assert.throws(() => packageCommands('ID=unsupported'), /Unsupported distribution/);
});

import { writeFileSync, existsSync, realpathSync } from 'node:fs';

function installerFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'botons-installer-behavior-')));
  const root = join(home, '.local/share/botons');
  const bin = join(home, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const runtime = join(home, 'runtime/bin/node');
  mkdirSync(join(home, 'runtime/bin'), { recursive: true });
  writeFileSync(runtime, `#!/bin/sh\ncase "$1" in\n*/npm-cli.js) mkdir -p node_modules/croner; echo repaired > node_modules/croner/package.json; test ! -f "$HOME/fail-build"; exit $?;;\nesac\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  for (const name of ['systemctl', 'loginctl']) writeFileSync(join(bin, name), '#!/bin/sh\necho "$@" >> "$HOME/service-calls"\n', { mode: 0o755 });
  const manager = serviceManager({ home, configHome: join(home, '.config') });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/service-calls"
case "$1:$2" in
  print:gui/*/*) case "$2" in *.backup) file=${quote(manager.backupFile)};; *) file=${quote(manager.serviceFile)};; esac
    if [ -f "$file" ] && [ ! -f "$HOME/stopped-\${2##*/}" ]; then printf 'path = %s\\n' "$file"; else echo 'Could not find service' >&2; exit 113; fi;;
  bootout:*) touch "$HOME/stopped-\${2##*/}";;
  bootstrap:*) name=\${3##*/}; rm -f "$HOME/stopped-\${name%.plist}";;
esac
`, { mode: 0o755 });
  // Lifecycle fixtures probe tools but do not run a Workspace command.
  writeFileSync(join(bin, 'socat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\necho "bubblewrap 0.11.0"\n', { mode: 0o755 });
  mkdirSync(root, { recursive: true });
  const data = join(home, 'data');
  writeFileSync(join(root, 'installer.json'), JSON.stringify({ data, node: runtime }));
  const env = { ...process.env, ...noRealClis(home), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/bash', BOTONS_HOME: data, BOTONS_PORT: '18973', BOTONS_NO_TAILSCALE: '1' };
  const config = join(home, '.config/botons/env');
  function artifact(version: string, built = true) {
    const dir = join(home, `artifact-${version}`);
    mkdirSync(dir);
    for (const item of ['installer', 'scripts', 'server', 'shared']) requireFs.cpSync(resolve(item), join(dir, item), { recursive: true, filter: p => !p.includes('node_modules') && !p.includes('/test') });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version, type: 'module' }));
    if (built) { mkdirSync(join(dir, 'web/dist'), { recursive: true }); writeFileSync(join(dir, 'web/dist/index.html'), 'ok'); }
    return dir;
  }
  function invoke(args: string[], service = false) {
    return spawnSync(process.execPath, [resolve('installer/botons.mjs'), ...args, '--yes', '--no-sudo', ...(service ? [] : ['--no-service'])], { env, encoding: 'utf8', timeout: 90000 });
  }
  return { home, root, config, data, env, artifact, invoke, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('actual install repairs before database creation, upgrades, preserves settings and reinstalls', () => {
  const f = installerFixture();
  try {
    const first = f.artifact('1.2.3');
    let result = f.invoke(['install', '--source', first, '--public-url', 'https://botons.example.com']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.data, 'botons.db')), false);
    requireFs.appendFileSync(f.config, 'BOTONS_PORT="18881"\nBOTONS_BACKUP_DIR="/tmp/backups"\nBOTONS_HOST="127.0.0.1"\n');
    const before = readFileSync(f.config, 'utf8');
    const dependency = join(f.root, 'current/node_modules/croner/package.json');
    assert.ok(existsSync(dependency));
    rmSync(join(f.root, 'current/node_modules'), { recursive: true });
    result = f.invoke(['repair']);
    assert.ok(existsSync(dependency), 'repair reinstalls missing production dependencies');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.config, 'utf8'), before);
    assert.match(before, /BOTONS_OAUTH_PUBLIC_URL=/);
    const next = f.artifact('1.2.4');
    result = f.invoke(['upgrade', '--source', next]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(join(f.root, 'current')), join(f.root, 'releases/1.2.4'));
    assert.equal(readFileSync(f.config, 'utf8'), before);
    assert.equal(f.invoke(['uninstall']).status, 0);
    for (const file of ['.bashrc', '.zshrc', '.profile']) {
      const path = join(f.home, file);
      if (existsSync(path)) assert.doesNotMatch(readFileSync(path, 'utf8'), /# >>> Botons PATH >>>/);
    }
    assert.ok(existsSync(f.config));
    result = f.invoke(['install', '--source', next]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.config, 'utf8'), before);
  } finally { f.cleanup(); }
});

test('failed build leaves no final release and retry succeeds', () => {
  const f = installerFixture();
  try {
    const source = f.artifact('2.0.0', false);
    writeFileSync(join(f.home, 'fail-build'), 'fail');
    assert.notEqual(f.invoke(['install', '--source', source]).status, 0);
    assert.equal(existsSync(join(f.root, 'releases/2.0.0')), false);
    assert.equal(requireFs.readdirSync(f.root).some(n => n.startsWith('.release-')), false);
    rmSync(join(f.home, 'fail-build'));
    const result = f.invoke(['install', '--source', source]);
    assert.equal(result.status, 0, result.stderr);
  } finally { f.cleanup(); }
});

import { createServer } from 'node:http';
import { freePort, noRealClis } from './helpers.ts';

test('health failure restores config, units and link and probes the saved port', async () => {
  const f = installerFixture();
  const port = await freePort();
  let probes = 0;
  const server = createServer((_req, res) => { probes++; res.statusCode = probes <= 30 ? 500 : 200; res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    assert.equal(f.invoke(['install', '--source', f.artifact('3.0.0')]).status, 0);
    requireFs.appendFileSync(f.config, `BOTONS_PORT="${port}"\n`);
    const config = readFileSync(f.config, 'utf8');
    const manager = serviceManager({ home: f.home, configHome: join(f.home, '.config') });
    mkdirSync(manager.dir, { recursive: true });
    for (const path of manager.files) writeFileSync(path, `saved ${path}`);
    const source = f.artifact('3.0.1');
    const child = (await import('node:child_process')).spawn(process.execPath, [resolve('installer/botons.mjs'), 'upgrade', '--source', source, '--yes', '--no-sudo', '--host', 'localhost', '--public-url', 'https://other.example.com'], { env: f.env });
    let output = '';
    child.stderr.on('data', b => output += b);
    child.stdout.resume();
    const status = await new Promise(resolve => child.on('close', resolve));
    assert.equal(status, 1, output);
    assert.match(output, /Health check failed/);
    assert.equal(probes, 31);
    assert.equal(readFileSync(f.config, 'utf8'), config);
    assert.equal(realpathSync(join(f.root, 'current')), join(f.root, 'releases/3.0.0'));
    for (const path of manager.files) assert.equal(readFileSync(path, 'utf8'), `saved ${path}`);
    assert.equal(existsSync(join(f.root, 'releases/3.0.1')), false);
  } finally { server.close(); f.cleanup(); }
});

test('first activation failure removes units, disables services and permits retry', () => {
  const f = installerFixture();
  try {
    const source = f.artifact('4.0.0');
    const index = join(source, 'server/src/index.ts');
    const contents = readFileSync(index);
    rmSync(index);
    const failed = f.invoke(['install', '--source', source], true);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(existsSync(join(f.root, 'current')), false);
    assert.equal(existsSync(f.config), false);
    assert.equal(existsSync(join(f.root, 'releases/4.0.0')), false);
    assert.match(readFileSync(join(f.home, 'service-calls'), 'utf8'), process.platform === 'darwin' ? /print gui\// : /disable --now botons botons-backup.timer/);
    writeFileSync(index, contents);
    const retry = f.invoke(['install', '--source', source]);
    assert.equal(retry.status, 0, retry.stderr);
  } finally { f.cleanup(); }
});

test('Git source identity follows the checked out commit', () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-version-'));
  try {
    writeFileSync(join(home, 'package.json'), '{}');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-qm', 'Package source']]) assert.equal(spawnSync('git', args, { cwd: home }).status, 0);
    const first = sourceVersion(home);
    assert.match(first, /^0\.0\.0\+git\.[a-f0-9]{40}$/);
    writeFileSync(join(home, 'package.json'), '{"version":"1.0.0"}');
    spawnSync('git', ['add', '.'], { cwd: home });
    spawnSync('git', ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-qm', 'Package version'], { cwd: home });
    assert.notEqual(sourceVersion(home), first);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
const { sourceVersion } = await import('../../installer/botons.mjs');

test('npm Git payload keeps an exact source lock under a packable filename', () => {
  assert.deepEqual(JSON.parse(readFileSync('installer/source-lock.json', 'utf8')), JSON.parse(readFileSync('package-lock.json', 'utf8')));
});

import { DatabaseSync } from 'node:sqlite';
import { openSchema } from '../src/schema.ts';

test('upgrade backs up an existing database before selecting new code', () => {
  const f = installerFixture();
  try {
    assert.equal(f.invoke(['install', '--source', f.artifact('5.0.0')]).status, 0);
    mkdirSync(f.data, { mode: 0o700 });
    const db = new DatabaseSync(join(f.data, 'botons.db'));
    openSchema(db);
    db.close();
    const result = f.invoke(['upgrade', '--source', f.artifact('5.0.1')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.root, 'install.log'), 'utf8'), /Backed up/);
    const backups = requireFs.readdirSync(join(f.data, 'backups'));
    assert.equal(backups.length, 1);
    assert.ok(existsSync(join(f.data, 'backups', backups[0], 'manifest.json')));
  } finally { f.cleanup(); }
});

const { dependencyProblems } = await import('../../installer/botons.mjs');
test('requirements detect absent socat and xz even with supported bubblewrap', () => {
  assert.deepEqual(dependencyProblems((cmd) => cmd === 'bwrap'
    ? { status: 0, stdout: 'bubblewrap 0.11.0' }
    : { status: ['socat', 'xz'].includes(cmd) ? 127 : 0 }, 'linux'), ['socat', 'xz']);
});

test('packed source identity changes for web, scripts and dependency manifests', () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-packed-version-'));
  try {
    writeFileSync(join(home, 'package.json'), '{}');
    let previous = sourceVersion(home);
    for (const file of ['web/src/App.tsx', 'scripts/doctor.ts', 'server/package.json', 'package-lock.json']) {
      mkdirSync(join(home, file, '..'), { recursive: true });
      writeFileSync(join(home, file), '{}');
      const next = sourceVersion(home);
      assert.notEqual(next, previous, file);
      previous = next;
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('rollback restart failure preserves activation context and removes release for retry', { skip: process.platform !== 'linux' && 'Exercises Linux systemd and linger failures' }, () => {
  const f = installerFixture();
  try {
    assert.equal(f.invoke(['install', '--source', f.artifact('6.0.0')]).status, 0);
    const next = f.artifact('6.0.1');
    rmSync(join(next, 'server/src/index.ts'));
    writeFileSync(join(f.home, 'fake-bin/systemctl'), '#!/bin/sh\ncase "$*" in *restart*) exit 1;; esac\n', { mode: 0o755 });
    const result = f.invoke(['upgrade', '--source', next], true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Activation failed/);
    assert.match(result.stderr, /Rollback also failed/);
    assert.match(result.stderr, /schema/);
    assert.equal(realpathSync(join(f.root, 'current')), join(f.root, 'releases/6.0.0'));
    assert.equal(existsSync(join(f.root, 'releases/6.0.1')), false);
    assert.equal(f.invoke(['upgrade', '--source', next]).status, 0);
  } finally { f.cleanup(); }
});

test('rollback daemon reload failure preserves activation context and removes release for retry', { skip: process.platform !== 'linux' && 'Exercises Linux systemd and linger failures' }, () => {
  const f = installerFixture();
  try {
    assert.equal(f.invoke(['install', '--source', f.artifact('7.0.0')]).status, 0);
    const next = f.artifact('7.0.1');
    const before = readFileSync(f.config, 'utf8');
    writeFileSync(join(f.home, 'fake-bin/systemctl'), '#!/bin/sh\ncase "$*" in *daemon-reload*) exit 1;; esac\n', { mode: 0o755 });
    const result = f.invoke(['upgrade', '--source', next, '--public-url', 'https://other.example.com'], true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Activation failed/);
    assert.match(result.stderr, /Rollback also failed/);
    assert.match(result.stderr, /schema/);
    assert.equal(readFileSync(f.config, 'utf8'), before);
    assert.equal(realpathSync(join(f.root, 'current')), join(f.root, 'releases/7.0.0'));
    assert.equal(existsSync(join(f.root, 'releases/7.0.1')), false);
    assert.equal(f.invoke(['upgrade', '--source', next]).status, 0);
  } finally { f.cleanup(); }
});

test('linger access denial leaves the installed service enabled and running', { skip: process.platform !== 'linux' && 'Exercises Linux systemd and linger failures' }, async () => {
  const f = installerFixture();
  const port = await freePort();
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    f.env.BOTONS_PORT = String(port);
    f.env.SHELL = '/bin/bash';
    mkdirSync(join(f.home, '.profile'));
    writeFileSync(join(f.home, 'fake-bin/loginctl'), '#!/bin/sh\ncase "$1" in show-user) echo Linger=no; exit 0;; esac\necho "Could not enable linger: Access denied (pkttyagent missing)" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(f.home, 'fake-bin/sudo'), '#!/bin/sh\necho Access denied >&2\nexit 1\n', { mode: 0o755 });
    const child = (await import('node:child_process')).spawn(process.execPath,
      [resolve('installer/botons.mjs'), 'install', '--source', f.artifact('8.0.0'), '--yes'], { env: f.env });
    let output = '';
    child.stdout.on('data', b => output += b);
    child.stderr.on('data', b => output += b);
    const status = await new Promise(resolve => child.on('close', resolve));
    assert.equal(status, 0, output);
    const log = readFileSync(join(f.root, 'install.log'), 'utf8');
    assert.match(log, /PATH setup skipped/);
    assert.match(log, /Linger is not enabled/);
    assert.match(output, /\.local\/bin\/botons pair --approve/);
    assert.doesNotMatch(output, /exec \$SHELL/);
    assert.match(log, /sudo loginctl enable-linger/);
    assert.equal(realpathSync(join(f.root, 'current')), join(f.root, 'releases/8.0.0'));
    assert.ok(existsSync(join(f.root, 'installer.json')));
    assert.ok(existsSync(join(f.home, '.config/systemd/user/botons.service')));
    const calls = readFileSync(join(f.home, 'service-calls'), 'utf8');
    assert.match(calls, /restart botons/);
    assert.match(calls, /enable botons/);
    assert.doesNotMatch(calls, /disable/);
    const removed = f.invoke(['uninstall']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Could not remove.*\.profile/);
    assert.equal(existsSync(join(f.root, 'releases')), false);
    assert.equal(existsSync(join(f.root, 'node')), false);
    assert.ok(existsSync(f.config));
  } finally { server.close(); f.cleanup(); }
});

test('managed install backs up before doctor and prints ordered public next steps without manual service setup', async () => {
  const f = installerFixture();
  const port = await freePort();
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    f.env.BOTONS_PORT = String(port);
    mkdirSync(f.data, { mode: 0o700 });
    const db = new DatabaseSync(join(f.data, 'botons.db'));
    openSchema(db);
    db.close();
    for (const cli of ['claude', 'codex']) writeFileSync(join(f.home, 'fake-bin', cli), '#!/bin/sh\necho called >> "$HOME/unexpected-clis"\nexit 1\n', { mode: 0o755 });
    const child = (await import('node:child_process')).spawn(process.execPath,
      [resolve('installer/botons.mjs'), 'install', '--source', f.artifact('9.0.0'), '--yes', '--public-url', 'https://botons.example.com'], { env: f.env });
    let output = '';
    child.stdout.on('data', b => output += b);
    child.stderr.on('data', b => output += b);
    const status = await new Promise(resolve => child.on('close', resolve));
    assert.equal(status, 0, output);
    assert.match(output, /Open https:\/\/botons.example.com/);
    assert.match(output, /Approve[^\n]+\.local\/bin\/botons pair --approve/);
    assert.match(output, /Pick a brain in the setup screen/);
    assert.doesNotMatch(output, /No backup yet|npm run pair|npm run backup|FAIL|WARN/);
    assert.match(readFileSync(join(f.root, 'install.log'), 'utf8'), /Backed up/);
    assert.ok(requireFs.readdirSync(join(f.data, 'backups')).length > 0);
    assert.equal(existsSync(join(f.home, 'unexpected-clis')), false, 'doctor must not invoke CLIs from PATH in a test');
  } finally { server.close(); f.cleanup(); }
});

test('purge uninstall finishes daemon reload before removing its log directory', () => {
  const f = installerFixture();
  try {
    const logs = join(f.home, '.config/botons/logs');
    if (process.platform === 'darwin') {
      mkdirSync(logs, { recursive: true });
      for (const name of ['server.log', 'server.error.log', 'backup.log', 'backup.error.log', 'keep.txt']) writeFileSync(join(logs, name), 'fixture');
    }
    const result = f.invoke(['uninstall', '--purge'], true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.home, 'service-calls'), 'utf8'), process.platform === 'darwin' ? /print gui\// : /daemon-reload/);
    assert.equal(existsSync(f.root), false);
    if (process.platform === 'darwin') assert.deepEqual(requireFs.readdirSync(logs), ['keep.txt']);
    assert.match(result.stdout, /Botons uninstalled/);
  } finally { f.cleanup(); }
});

test('Node archives match Linux and macOS CPUs without requiring xz on macOS', () => {
  for (const cpu of ['arm64', 'x64']) {
    assert.deepEqual(nodeArchive('v24.0.0', 'darwin', cpu), { filename: `node-v24.0.0-darwin-${cpu}.tar.gz`, extract: '-xzf' });
    assert.deepEqual(nodeArchive('v24.0.0', 'linux', cpu), { filename: `node-v24.0.0-linux-${cpu}.tar.xz`, extract: '-xJf' });
  }
  assert.throws(() => nodeArchive('v24.0.0', 'win32', 'x64'), /Linux or macOS/);
  assert.throws(() => nodeArchive('v24.0.0', 'darwin', 'ia32'), /Linux or macOS/);
  const probes: string[] = [];
  assert.deepEqual(dependencyProblems((cmd) => { probes.push(cmd); return { status: 0 }; }, 'darwin'), []);
  assert.deepEqual(probes, ['tar']);
  for (const command of ['start', 'stop', 'status', 'restart']) assert.equal(parse([command]).command, command);
});
