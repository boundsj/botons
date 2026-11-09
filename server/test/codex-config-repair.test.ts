import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { previewCodexRepairs, repairCodexConfig } from '../src/codex-config-repair.ts';
import { codexConfigSymlinks } from '../src/isolation.ts';
import { startServer, tempDir } from './helpers.ts';

function fixture() {
  const root = tempDir();
  const home = join(root, 'config');
  mkdirSync(home);
  const target = join(root, 'instructions.md');
  writeFileSync(target, 'reviewed instructions');
  const path = join(home, 'AGENTS.md');
  symlinkSync('../instructions.md', path);
  return { root, home, target, path, env: { CODEX_HOME: home } };
}

test('preview changes nothing; confirmed repair keeps original bytes, target and raw backup link', () => {
  const f = fixture();
  const [preview] = previewCodexRepairs(f.env);
  assert.equal(preview.path, f.path);
  assert.equal(preview.target, f.target);
  assert.ok(preview.token && preview.backup);
  assert.ok(lstatSync(f.path).isSymbolicLink());
  assert.equal(existsSync(preview.backup), false);
  const phases: string[] = [];
  repairCodexConfig(preview.id, preview.token, phase => phases.push(phase), f.env);
  assert.deepEqual(phases, ['confirmed', 'completed']);
  assert.ok(lstatSync(f.path).isFile());
  assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.path, 'utf8'), 'reviewed instructions');
  assert.equal(readFileSync(f.target, 'utf8'), 'reviewed instructions');
  assert.equal(readlinkSync(preview.backup), '../instructions.md');
  assert.deepEqual(codexConfigSymlinks(f.env), [], 'backup does not become another top-level mask symlink');
  assert.throws(() => repairCodexConfig(preview.id, preview.token!, () => {}, f.env), /changed|cannot/);
});

test('changed target or link requires a new consent preview and does not overwrite files', () => {
  for (const change of ['target', 'link']) {
    const f = fixture();
    const [preview] = previewCodexRepairs(f.env);
    if (change === 'target') writeFileSync(f.target, 'changed instructions');
    else { rmSync(f.path); writeFileSync(f.path, 'owner replacement'); }
    let audited = false;
    assert.throws(() => repairCodexConfig(preview.id, preview.token!, () => { audited = true; }, f.env), /changed|cannot/);
    assert.equal(audited, false);
    assert.equal(readFileSync(f.path, 'utf8'), change === 'target' ? 'changed instructions' : 'owner replacement');
  }
});

test('audit failure prevents mutation; directory, dangling, oversized and config-home links cannot be repaired', () => {
  const f = fixture();
  const [preview] = previewCodexRepairs(f.env);
  assert.throws(() => repairCodexConfig(preview.id, preview.token!, () => { throw new Error('audit unavailable'); }, f.env), /audit unavailable/);
  assert.ok(lstatSync(f.path).isSymbolicLink());
  assert.equal(existsSync(join(f.home, '.botons-link-backups')), false);
  const dir = join(f.root, 'skills'); mkdirSync(dir);
  symlinkSync(dir, join(f.home, 'skills'));
  symlinkSync(join(f.root, 'missing'), join(f.home, 'missing'));
  const large = join(f.root, 'large'); writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
  symlinkSync(large, join(f.home, 'large'));
  assert.ok(previewCodexRepairs(f.env).filter(p => p.id !== preview.id).every(p => !p.token && p.problem));
  const linkedHome = join(f.root, 'linked-home'); symlinkSync(f.home, linkedHome);
  assert.ok(previewCodexRepairs({ CODEX_HOME: linkedHome }).every(p => !p.token));
});

test('an existing backup is never overwritten and the original link remains', () => {
  const f = fixture();
  const [preview] = previewCodexRepairs(f.env);
  mkdirSync(join(f.home, '.botons-link-backups'));
  writeFileSync(preview.backup!, 'keep backup');
  assert.throws(() => repairCodexConfig(preview.id, preview.token!, () => {}, f.env), /exist/i);
  assert.ok(lstatSync(f.path).isSymbolicLink());
  assert.equal(readFileSync(preview.backup!, 'utf8'), 'keep backup');
});

test('repair API requires a paired owner, exact preview and explicit consent; success is audited', async () => {
  const f = fixture();
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  const s = await startServer();
  try {
    assert.equal((await s.call('GET', '/api/brain-config-repairs', undefined, null)).status, 401);
    const bot = s.storeBot('Kevin');
    const turn = s.app.auth.mintBotonToken(bot.id);
    try {
      assert.equal((await s.call('GET', '/api/brain-config-repairs', undefined, turn.token)).status, 403);
      assert.equal((await s.call('POST', '/api/brain-config-repairs', { consent: true }, turn.token)).status, 403);
    } finally { turn.revoke(); }
    const [preview] = (await s.call('GET', '/api/brain-config-repairs')).data;
    assert.equal((await s.call('POST', '/api/brain-config-repairs', { id: preview.id, token: preview.token })).status, 400);
    assert.ok(lstatSync(f.path).isSymbolicLink());
    assert.equal((await s.call('POST', '/api/brain-config-repairs', { id: '../outside', token: preview.token, consent: true })).status, 409);
    assert.equal((await s.call('POST', '/api/brain-config-repairs', { id: preview.id, token: preview.token, consent: true })).status, 200);
    const audit = JSON.stringify((await s.call('GET', '/api/audit')).data);
    assert.match(audit, /brain.config_repair_confirmed/);
    assert.match(audit, /brain.config_repair_completed/);
    assert.ok(!audit.includes('reviewed instructions'), 'audit never contains file contents');
  } finally {
    await s.stop();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  }
});

test('doctor --fix refuses piped input, including --json, and keeps the link intact', () => {
  const f = fixture();
  for (const extra of [[], ['--json']]) {
    const result = spawnSync(process.execPath, ['scripts/doctor.ts', '--fix', '--skip-clis', '--skip-network', ...extra], {
      env: { ...process.env, CODEX_HOME: f.home, BOTONS_HOME: join(f.root, 'data'), HOME: f.root },
      input: 'REPAIR\n', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /interactive terminal/);
    assert.ok(lstatSync(f.path).isSymbolicLink());
  }
});

test('completion audit failure reports a committed repair, keeps backup, and never records replacement failure', () => {
  const f = fixture();
  const [preview] = previewCodexRepairs(f.env);
  const phases: string[] = [];
  const result = repairCodexConfig(preview.id, preview.token!, phase => {
    phases.push(phase);
    if (phase === 'completed') throw new Error('audit unavailable');
  }, f.env);
  assert.deepEqual(phases, ['confirmed', 'completed']);
  assert.match(result.warning!, /file was replaced.*backup was kept.*completion audit could not be written/);
  assert.equal(result.path, f.path);
  assert.equal(result.backup, preview.backup);
  assert.ok(lstatSync(f.path).isFile());
  assert.equal(readlinkSync(result.backup!), '../instructions.md');
});

test('API reports success with an audit warning when completion recording fails after replacement', async () => {
  const f = fixture();
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  const s = await startServer();
  try {
    s.app.store.db.exec(`create trigger fail_repair_completion before insert on audit_events
      when NEW.action = 'brain.config_repair_completed' begin select raise(ABORT, 'fixture audit failure'); end`);
    const [preview] = (await s.call('GET', '/api/brain-config-repairs')).data;
    const result = await s.call('POST', '/api/brain-config-repairs', { id: preview.id, token: preview.token, consent: true });
    assert.equal(result.status, 200);
    assert.match(result.data.warning, /file was replaced.*completion audit could not be written/);
    assert.equal(result.data.backup, preview.backup);
    assert.ok(lstatSync(f.path).isFile());
    const audit = JSON.stringify((await s.call('GET', '/api/audit')).data);
    assert.match(audit, /brain.config_repair_confirmed/);
    assert.ok(!audit.includes('brain.config_repair_failed'));
  } finally {
    await s.stop();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  }
});
