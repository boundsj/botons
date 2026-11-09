import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { serviceCommands, serviceManager, runService } from '../../shared/service-manager.mjs';
import { writeServiceUnit } from '../../scripts/install-service.ts';
import { writeBackupUnits } from '../../scripts/install-backup-timer.ts';
import { tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');

test('LaunchAgents use isolated identities, quoted arguments, private logs and the same environment for backups', () => {
  const home = tempDir('botons-launch-agent-');
  const envPath = join(home, 'settings & files', 'env');
  mkdirSync(join(home, 'settings & files'));
  writeFileSync(envPath, 'PATH=/usr/bin\nBOTONS_DRAIN_MS=5m\n');
  const m = serviceManager({ platform: 'darwin', home, uid: 123 });
  assert.notEqual(m.target, serviceManager({ platform: 'darwin', home: `${home}/other`, uid: 123 }).target);
  assert.equal(m.domain, 'gui/123');
  assert.equal(m.files.length, 2);
  const unit = writeServiceUnit({ platform: 'darwin', userHome: home, name: 'botons', app: repo, unitDir: m.dir, envPath, log: () => {} });
  const [backup] = writeBackupUnits({ platform: 'darwin', userHome: home, app: repo, unitDir: m.dir, envPath, log: () => {} });
  assert.equal(unit, m.serviceFile);
  assert.equal(backup, m.backupFile);
  const server = readFileSync(unit, 'utf8');
  assert.match(server, /settings &amp; files/);
  assert.match(server, /<key>ExitTimeOut<\/key><integer>330<\/integer>/);
  assert.match(server, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(server, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.doesNotMatch(server, /<string>.*\/bin\/(?:sh|bash)<\/string>/);
  const timer = readFileSync(backup, 'utf8');
  assert.match(timer, /<key>Hour<\/key><integer>3<\/integer><key>Minute<\/key><integer>30<\/integer>/);
  assert.doesNotMatch(timer, /<key>KeepAlive<\/key>|<key>RunAtLoad<\/key>/);
  assert.equal(statSync(unit).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'settings & files/logs')).mode & 0o777, 0o700);
  if (process.platform === 'darwin') {
    for (const file of [unit, backup]) {
      const check = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
    }
  }
});

test('LaunchAgent lifecycle refuses a job from another install or an inspection error, and handles absence', () => {
  const options = { platform: 'darwin', home: tempDir('botons-service-state-'), uid: 123 };
  const manager = serviceManager(options);
  const calls: [string, string[]][] = [];
  let source = manager.serviceFile;
  let exists = true;
  let denied = false;
  const execute = (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    if (args[0] === 'print') return denied ? { status: 1, stdout: '', stderr: 'Not permitted' } : exists ? { status: 0, stdout: `\tpath = ${source}\n`, stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' };
    if (args[0] === 'bootout') exists = false;
    if (args[0] === 'bootstrap') exists = true;
    return { status: 0, stdout: '', stderr: '' };
  };
  runService('start', options, 'server', execute);
  assert.deepEqual(calls.map(([, a]) => a[0]), ['print', 'kickstart']);
  assert.ok(!calls.at(-1)![1].includes('-k'), 'start leaves an already running server alone');
  calls.length = 0;
  runService('restart', options, 'server', execute);
  assert.deepEqual(calls.map(([, a]) => a[0]), ['print', 'bootout', 'print', 'bootstrap']);
  calls.length = 0;
  source = join(options.home, 'another.plist');
  assert.throws(() => runService('stop', options, 'server', execute), /another installation/);
  assert.equal(calls.length, 1);
  denied = true;
  assert.throws(() => runService('restart', options, 'server', execute), /Cannot inspect/);
  denied = false;
  exists = false;
  calls.length = 0;
  runService('stop', options, 'server', execute);
  assert.deepEqual(calls.map(([, a]) => a[0]), ['print']);
  calls.length = 0;
  runService('start', options, 'server', execute);
  assert.deepEqual(calls.map(([, a]) => a[0]), ['print', 'bootstrap']);
  assert.deepEqual(serviceCommands('start', { platform: 'linux' }, 'backup'), [['systemctl', ['--user', 'enable', '--now', 'botons-backup.timer']]]);
  assert.equal(basename(serviceManager({ platform: 'linux' }).serviceFile), 'botons.service');
});

test('restart waits for a draining LaunchAgent to disappear, and refuses timeout or changed ownership', () => {
  const options = { platform: 'darwin', home: tempDir('botons-service-state-'), uid: 123 };
  const manager = serviceManager(options);
  let clock = 0;
  let stopping = false;
  let stuck = false;
  let swapped = false;
  let started = false;
  const timing = { now: () => clock, pause: (ms: number) => { clock += ms; } };
  const execute = (_cmd: string, args: string[]) => {
    if (args[0] === 'print') {
      if (stopping && clock >= 300 && !stuck && !swapped) return { status: 113, stdout: '', stderr: 'Could not find service' };
      return { status: 0, stdout: `path = ${stopping && swapped ? join(options.home, 'another.plist') : manager.serviceFile}\n`, stderr: '' };
    }
    if (args[0] === 'bootout') stopping = true;
    if (args[0] === 'bootstrap') { assert.ok(clock >= 300); started = true; }
    return { status: 0, stdout: '', stderr: '' };
  };
  runService('restart', options, 'server', execute, timing);
  assert.equal(clock, 300);
  assert.equal(started, true);
  clock = 0; stopping = false; started = false; stuck = true;
  assert.throws(() => runService('restart', options, 'server', execute, timing), /still stopping/);
  assert.equal(clock, 180_000);
  assert.equal(started, false);
  clock = 0; stopping = false; stuck = false; swapped = true;
  assert.throws(() => runService('restart', options, 'server', execute, timing), /another installation/);
  assert.equal(started, false);
  mkdirSync(manager.dir, { recursive: true });
  writeFileSync(manager.serviceFile, `<key>ExitTimeOut</key><integer>${'9'.repeat(400)}</integer>`);
  clock = 0; stopping = false; stuck = true; swapped = false;
  assert.throws(() => runService('stop', options, 'server', execute, timing), /still stopping/);
  assert.equal(clock, 180_000, 'malformed timeout cannot make the wait infinite');
});
