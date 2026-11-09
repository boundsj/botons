import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OperationsStatus } from '../../shared/types.ts';
import { BACKUPS_LISTED, backup, backupTime, backupStatus, KEEP_BACKUPS, listBackups, MANIFEST_MAX_BYTES, stamp } from '../src/backup.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { startServer, tempDir } from './helpers.ts';

const s = await startServer();

const operations = async () => {
  const r = await s.call<OperationsStatus>('GET', '/api/operations');
  assert.equal(r.status, 200, r.text);
  return r;
};

test('operations: paired devices only; Boton tokens and callers without a token are refused', async () => {
  const kevin = await s.newBot('Kevin');
  const boton = s.app.auth.mintBotonToken(kevin.id, { sandboxed: false }).token;
  assert.equal((await s.call('GET', '/api/operations', undefined, boton)).status, 403);
  assert.equal((await s.call('GET', '/api/operations', undefined, null)).status, 401);
});

test('operations: health with details, and no backup yet is stale', async () => {
  const { data } = await operations();
  assert.equal(data.health.ok, true);
  assert.deepEqual(data.health.failing, []);
  assert.equal(data.health.details.database.ok, true);
  assert.ok(data.health.details.providers.some((p) => p.id === 'mock' && p.available));
  assert.equal(data.install, 'service');
  assert.deepEqual(data.backups, { backups: [], total: 0, keep: KEEP_BACKUPS, staleAfterHours: 48, stale: true, partial: 0, unreadable: false });
});

test('operations: backups newest first, with what each holds, and no paths or error text', async () => {
  const dir = s.cfg.backupsDir;
  const old = backup({ home: s.home, now: new Date(Date.now() - 5 * 86_400_000) });
  // A backup whose workspaces archive failed: the manifest's error names files, which the owner's view leaves out.
  const failedName = stamp(new Date(Date.now() - 3 * 86_400_000));
  mkdirSync(join(dir, failedName));
  writeFileSync(join(dir, failedName, 'manifest.json'), JSON.stringify({ createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), schemaVersion: SCHEMA_VERSION, counts: {}, workspaces: false, workspacesError: `tar failed (exit 2): ${s.home}/workspaces/secret-plans.txt` }));
  const broken = stamp(new Date(Date.now() - 2 * 86_400_000 - 60_000));
  mkdirSync(join(dir, broken));
  writeFileSync(join(dir, broken, 'manifest.json'), '{not json');
  mkdirSync(join(dir, `${stamp()}.partial`));
  mkdirSync(join(dir, 'kept-by-hand'));

  let { data } = await operations();
  const text = JSON.stringify(data.backups);
  assert.equal(data.backups.total, 3);
  assert.equal(data.backups.partial, 1);
  assert.equal(data.backups.stale, true, 'the newest is over two days old');
  assert.deepEqual(
    data.backups.backups.map((b) => [b.name, b.schemaVersion, b.workspaces, b.workspacesFailed]),
    [
      [broken, null, false, false],
      [failedName, SCHEMA_VERSION, false, true],
      [old.dir.split('/').at(-1), SCHEMA_VERSION, old.manifest.workspaces, false],
    ],
  );
  assert.equal(data.backups.backups[0].createdAt, new Date(backupTime(broken)).toISOString(), 'an unreadable manifest falls back to the folder name');
  assert.ok(!text.includes(s.home), 'no backup path reaches the client');
  assert.ok(!text.includes('secret-plans'), 'no manifest error text reaches the client');

  const fresh = backup({ home: s.home });
  ({ data } = await operations());
  assert.equal(data.backups.stale, false);
  assert.equal(data.backups.backups[0].name, fresh.dir.split('/').at(-1));
  assert.equal(data.backups.backups[0].schemaVersion, SCHEMA_VERSION);
});

test('backup status: lists at most the newest BACKUPS_LISTED, counts them all, and an empty install is not stale', () => {
  const dir = tempDir();
  assert.equal(backupStatus({ backupsDir: join(dir, 'missing'), dbExists: false }).stale, false, 'nothing to back up yet');
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < BACKUPS_LISTED + 3; i++) mkdirSync(join(dir, stamp(new Date(start + i * 86_400_000))));
  const status = backupStatus({ backupsDir: dir, dbExists: true, now: start + (BACKUPS_LISTED + 2) * 86_400_000 + 3_600_000 });
  assert.equal(status.total, BACKUPS_LISTED + 3);
  assert.equal(status.backups.length, BACKUPS_LISTED);
  assert.equal(status.backups[0].name, stamp(new Date(start + (BACKUPS_LISTED + 2) * 86_400_000)));
  assert.equal(status.backups[0].createdAt, new Date(start + (BACKUPS_LISTED + 2) * 86_400_000).toISOString());
  assert.equal(status.stale, false);
});

test('operations: in the Docker image the recovery steps are the container commands', async () => {
  const docker = await startServer({ env: { BOTONS_CONTAINER: '1' } });
  const r = await docker.call<OperationsStatus>('GET', '/api/operations');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.install, 'docker');
});

const manifestFor = (dir: string, name: string, body: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'manifest.json'), body);
};

test('backup status: a FIFO, symlink or oversized manifest is not read, and the status returns promptly', () => {
  const dir = tempDir();
  const outside = tempDir();
  const start = Date.parse('2026-03-01T00:00:00.000Z');
  const [fifo, link, big, ok] = [0, 1, 2, 3].map((i) => stamp(new Date(start + i * 3_600_000)));
  mkdirSync(join(dir, fifo));
  assert.equal(spawnSync('mkfifo', [join(dir, fifo, 'manifest.json')]).status, 0, 'mkfifo');
  writeFileSync(join(outside, 'private.json'), JSON.stringify({ createdAt: '2026-03-01T01:00:00.000Z', schemaVersion: 4242, workspaces: true }));
  mkdirSync(join(dir, link));
  symlinkSync(join(outside, 'private.json'), join(dir, link, 'manifest.json'));
  manifestFor(dir, big, JSON.stringify({ schemaVersion: 4343, pad: 'x'.repeat(MANIFEST_MAX_BYTES) }));
  manifestFor(dir, ok, JSON.stringify({ createdAt: new Date(start + 3 * 3_600_000).toISOString(), schemaVersion: SCHEMA_VERSION, workspaces: true }));
  // A symlinked backup folder is not one the backup command made.
  symlinkSync(outside, join(dir, stamp(new Date(start + 4 * 3_600_000))));

  const began = Date.now();
  const status = backupStatus({ backupsDir: dir, dbExists: true, now: start + 5 * 3_600_000 });
  assert.ok(Date.now() - began < 2_000, 'opening the FIFO does not wait for a writer');
  assert.deepEqual(
    status.backups.map((b) => [b.name, b.schemaVersion, b.workspaces]),
    [
      [ok, SCHEMA_VERSION, true],
      [big, null, false],
      [link, null, false],
      [fifo, null, false],
    ],
  );
  assert.equal(status.total, 4);
  assert.equal(status.unreadable, false);
});

test('backup status: createdAt is a canonical UTC time or the folder name, never manifest text', () => {
  const dir = tempDir();
  const name = stamp(new Date('2026-04-02T03:04:05.006Z'));
  for (const createdAt of [
    'Fri, 06 Nov 2026 00:00:00 GMT (private /home/you/token-example)',
    `2026-04-02T03:04:05.006Z (${'c'.repeat(1024 * 1024)})`,
    '2026-04-02T03:04:05Z',
    '2026-02-30T00:00:00.000Z',
    12345,
  ]) {
    manifestFor(dir, name, JSON.stringify({ createdAt, schemaVersion: SCHEMA_VERSION }));
    const [b] = backupStatus({ backupsDir: dir, dbExists: true }).backups;
    assert.equal(b.createdAt, '2026-04-02T03:04:05.006Z', String(createdAt).slice(0, 60));
  }
  manifestFor(dir, name, JSON.stringify({ createdAt: '2026-04-02T03:04:06.000Z', schemaVersion: SCHEMA_VERSION }));
  assert.equal(backupStatus({ backupsDir: dir, dbExists: true }).backups[0].createdAt, '2026-04-02T03:04:06.000Z');
});

test('backup status: names that are not real times are ignored, by the status and by listBackups', () => {
  const dir = tempDir();
  const good = stamp(new Date('2026-05-01T00:00:00.000Z'));
  for (const n of ['2026-99-99T99-99-99-999Z', '2026-02-30T00-00-00-000Z', '2026-01-01T24-00-00-000Z', good]) mkdirSync(join(dir, n));
  assert.ok(Number.isNaN(backupTime('2026-99-99T99-99-99-999Z')));
  assert.ok(Number.isNaN(backupTime('2026-02-30T00-00-00-000Z')));
  assert.deepEqual(listBackups(dir), [good]);
  const status = backupStatus({ backupsDir: dir, dbExists: true, now: Date.parse('2026-05-01T01:00:00.000Z') });
  assert.deepEqual(status.backups.map((b) => b.name), [good]);
  assert.equal(status.stale, false);
});

test('operations: a backups path that is a file, or unreadable, still returns health, with no path or error text', async () => {
  const t = await startServer();
  rmSync(t.cfg.backupsDir, { recursive: true, force: true });
  writeFileSync(t.cfg.backupsDir, 'not a folder');
  let r = await t.call<OperationsStatus>('GET', '/api/operations');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.health.details.database.ok, true, 'health is still there');
  assert.equal(r.data.backups.unreadable, true);
  assert.equal(r.data.backups.stale, true);
  assert.deepEqual(r.data.backups.backups, []);
  const shown = JSON.stringify(r.data.backups);
  assert.ok(!shown.includes(t.home) && !shown.includes('ENOTDIR'), 'no path or system error reaches the client');

  if (process.getuid?.() !== 0) {
    rmSync(t.cfg.backupsDir);
    mkdirSync(t.cfg.backupsDir, { mode: 0o000 });
    try {
      r = await t.call<OperationsStatus>('GET', '/api/operations');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.backups.unreadable, true);
      assert.ok(!JSON.stringify(r.data.backups).includes('EACCES'));
    } finally {
      chmodSync(t.cfg.backupsDir, 0o700);
    }
  }
});

test('backup status treats an inaccessible ancestor as unreadable even if database existence is unknown', { skip: process.getuid?.() === 0 }, () => {
  const parent = join(tempDir(), 'private');
  const backupsDir = join(parent, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  chmodSync(parent, 0o600);
  try {
    const status = backupStatus({ backupsDir, dbExists: false });
    assert.equal(status.unreadable, true);
    assert.equal(status.stale, true);
    assert.deepEqual(status.backups, []);
    assert.ok(!JSON.stringify(status).includes(parent));
  } finally {
    chmodSync(parent, 0o700);
  }
});
