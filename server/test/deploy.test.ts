import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { type DeployOptions, deploy, linked, listReleases, prune, rollback, waitHealthy } from '../../scripts/deploy.ts';
import { tempDir } from './helpers.ts';

const tmp = () => tempDir('botons-deploy-test-');
const repo = tmp();
const config = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...config, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git('add', '-A');
  git('commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}
git('init', '-q');
const A = commit('README.md', 'release A\n');
const B = commit('README.md', 'release B\n');
const C = commit('BROKEN', 'this release does not start\n');

// The fake unit: a restart serves <root>/current, whose /api/health reports its sha (500 with BROKEN), unless `answer` is set.
let serving: string | null = null;
let answer: { status: number; body: unknown } | null = null;
const fakeService = createServer((_req, res) => {
  if (answer) return res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  if (serving === 'broken' || serving === null) return res.writeHead(500).end('{}');
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, build: serving }));
});
await new Promise<void>((resolve) => fakeService.listen(0, '127.0.0.1', resolve));
const port = (fakeService.address() as AddressInfo).port;
after(() => new Promise<void>((resolve) => fakeService.close(() => resolve())));

type Call = { cmd: string; args: string[]; cwd?: string };

function options(root: string, calls: Call[] = [], logs: string[] = [], extra: Partial<DeployOptions> = {}): DeployOptions {
  return {
    platform: 'linux', repo, root, unit: 'botons-test', port, keep: 5, restart: true, skipTests: false, healthTimeoutMs: 1500, settleMs: 50,
    log: (l) => logs.push(l),
    async exec(cmd, args, opts) {
      calls.push({ cmd: basename(cmd), args, cwd: opts?.cwd });
      if (cmd === 'systemctl' && args[1] === 'restart') {
        const current = join(root, 'current');
        serving = existsSync(join(current, 'BROKEN')) ? 'broken' : JSON.parse(readFileSync(join(current, 'release.json'), 'utf8')).sha;
      }
    },
    ...extra,
  };
}

const npmSteps = (calls: Call[]) => calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' '));
const restarts = (calls: Call[]) => calls.filter((c) => c.cmd === 'systemctl' && c.args[1] === 'restart').length;

test('deploy builds a release, switches `current`, restarts and checks it, rolls back a bad one, and prunes', { timeout: 60_000 }, async () => {
  const root = tmp();
  let calls: Call[] = [];
  const logs: string[] = [];

  assert.equal(await deploy(A, options(root, calls, logs)), true);
  const dirA = join(root, 'releases', A);
  assert.equal(readFileSync(join(dirA, 'README.md'), 'utf8'), 'release A\n');
  assert.equal(existsSync(join(dirA, '.git')), false);
  assert.equal(JSON.parse(readFileSync(join(dirA, 'release.json'), 'utf8')).sha, A);
  assert.deepEqual(npmSteps(calls), ['ci --prefer-offline --no-audit --no-fund', 'run typecheck', 'run test:full', 'run build']);
  assert.ok(calls.filter((c) => c.cmd === 'npm').every((c) => c.cwd === dirA));
  assert.equal(readlinkSync(join(root, 'current')), join('releases', A));
  assert.equal(linked(root, 'previous'), null);
  assert.equal(serving, A);

  calls = [];
  assert.equal(await deploy('HEAD~1', options(root, calls, logs, { skipTests: true })), true);
  assert.deepEqual(npmSteps(calls), ['ci --prefer-offline --no-audit --no-fund', 'run typecheck', 'run build']);
  assert.deepEqual([linked(root, 'current'), linked(root, 'previous'), serving], [B, A, B]);

  calls = [];
  assert.equal(await deploy(B, options(root, calls, logs)), true);
  assert.equal(calls.length, 0, 'the current sha again: nothing to do');

  calls = [];
  assert.equal(await deploy(C, options(root, calls, logs)), false);
  assert.deepEqual([linked(root, 'current'), linked(root, 'previous'), serving], [B, A, B]);
  // A crash-looping release hits the unit's start limit, so each restart clears it first.
  assert.deepEqual(calls.filter((c) => c.cmd === 'systemctl').map((c) => c.args[1]), ['reset-failed', 'restart', 'reset-failed', 'restart']);
  assert.ok(calls.some((c) => c.cmd === 'journalctl'));
  assert.ok(logs.some((l) => l.includes(`did not come up healthy on ${C.slice(0, 12)}`)));
  assert.ok(logs.includes(`Back on ${B.slice(0, 12)}`));

  calls = [];
  assert.equal(await rollback(null, options(root, calls, logs)), true);
  assert.deepEqual([linked(root, 'current'), linked(root, 'previous'), serving], [A, B, A]);
  assert.equal(npmSteps(calls).length, 0);
  assert.equal(await rollback(B.slice(0, 8), options(root, calls, logs)), true);
  assert.deepEqual([linked(root, 'current'), serving], [B, B]);
  await assert.rejects(rollback('0000000', options(root)), /No finished release matches "0000000"/);

  calls = [];
  assert.equal(await deploy(A, options(root, calls, logs)), true);
  assert.equal(npmSteps(calls).length, 0, 'a release still on disk is reused');
  assert.equal(linked(root, 'current'), A);

  const listed = listReleases(root);
  assert.deepEqual(listed.map((r) => r.sha).sort(), [A, B, C].sort());
  assert.deepEqual(listed.filter((r) => r.current || r.previous).map((r) => [r.sha, r.current]).sort(), [[A, true], [B, false]].sort());

  rmSync(join(root, 'releases', C, '.deploy-ok')); // as if its build had failed halfway
  assert.deepEqual(prune(root, 0), [C]);
  assert.deepEqual(readdirSync(join(root, 'releases')).sort(), [A, B].sort());
});

test('--no-restart only switches the links; one deploy at a time; an unknown ref builds nothing', async () => {
  const root = tmp();
  const held = new DatabaseSync(join(root, 'deploy.lock'));
  held.exec('pragma journal_mode = memory; begin exclusive');
  try {
    await assert.rejects(deploy(A, options(root, [], [], { restart: false })), /Another deploy is running/);
  } finally {
    held.close();
  }
  const calls: Call[] = [];
  assert.equal(await deploy(A, options(root, calls, [], { restart: false })), true);
  assert.equal(linked(root, 'current'), A);
  assert.equal(restarts(calls), 0);

  const other = tmp();
  await assert.rejects(deploy('no-such-branch', options(other)), /Unknown ref "no-such-branch"/);
  assert.equal(existsSync(join(other, 'releases')), false);
});

test('the health check counts a server failing only on its agent CLIs as up, with a warning; any other failure is not', async () => {
  const logs: string[] = [];
  const o = { ...options(tmp(), [], logs), healthTimeoutMs: 300, settleMs: 20 };
  try {
    answer = { status: 503, body: { ok: false, build: A, failing: ['providers'] } };
    assert.equal(await waitHealthy(o, A), null);
    assert.equal(logs.filter((l) => /server is up, but no agent CLI can run turns/.test(l)).length, 1);
    answer = { status: 503, body: { ok: false, build: A, failing: ['database', 'providers'] } };
    assert.match((await waitHealthy(o, A)) ?? '', /answered 503 \(failing: database, providers\)$/);
    answer = { status: 503, body: { ok: false, build: B, failing: ['providers'] } };
    assert.match((await waitHealthy(o, A)) ?? '', new RegExp(`reports build ${B.slice(0, 12)}, not ${A.slice(0, 12)}`));
    answer = { status: 200, body: { ok: true, build: A, failing: [] } };
    assert.equal(await waitHealthy(o, A), null);
  } finally {
    answer = null;
  }
});

test('a macOS deploy reloads its own LaunchAgent and restores the working release when health fails', async () => {
  const { serviceManager } = await import('../../shared/service-manager.mjs');
  const root = tmp();
  const userHome = tmp();
  const m = serviceManager({ platform: 'darwin', home: userHome, name: 'botons-test' });
  const actions: string[] = [];
  let loaded = true;
  const opts = options(root, [], [], {
    platform: 'darwin', userHome,
    serviceExec: (_cmd, args) => {
      actions.push(args[0]);
      if (args[0] === 'print') return loaded ? { status: 0, stdout: `path = ${m.serviceFile}\n`, stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' };
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'bootstrap') {
        loaded = true;
        assert.equal(args[2], m.serviceFile);
        const current = join(root, 'current');
        serving = existsSync(join(current, 'BROKEN')) ? 'broken' : JSON.parse(readFileSync(join(current, 'release.json'), 'utf8')).sha;
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(await deploy(A, opts), true);
  assert.equal(await deploy(C, opts), false);
  assert.equal(linked(root, 'current'), A);
  assert.equal(serving, A);
  assert.deepEqual(actions, ['print', 'bootout', 'print', 'bootstrap', 'print', 'bootout', 'print', 'bootstrap', 'print', 'bootout', 'print', 'bootstrap']);
});
