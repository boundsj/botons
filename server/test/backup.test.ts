import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Bot, Memory, Message, Routine, RoutineRun } from '../../shared/types.ts';
import { KEEP_BACKUPS, backup, listBackups, planRestore, stamp } from '../src/backup.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { startServer, type TestServer, tempDir, until } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const COUNTED = ['bots', 'messages', 'routines', 'routine_runs', 'memories'];
const env = { BOTONS_SCHEDULER_MS: '200' };

/** GET as the device; it must succeed. */
async function get<T>(s: TestServer, path: string): Promise<T> {
  const { status, data, text } = await s.call<T>('GET', path);
  assert.equal(status, 200, `${path}: ${text}`);
  return data;
}

function counts(db: DatabaseSync, tables = COUNTED): Record<string, number> {
  return Object.fromEntries(tables.map((t) => [t, Number(db.prepare(`select count(*) as n from ${t}`).get()!.n)]));
}

function inspect(file: string, tables = COUNTED): { integrity: string; counts: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('pragma integrity_check').all().map((r) => r.integrity_check).join();
    return { integrity, counts: counts(db, tables) };
  } finally {
    db.close();
  }
}

/** scripts/backup.ts in its own process, as the systemd timer runs it. */
function runBackupScript(home: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [join(repo, 'scripts/backup.ts')], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOTONS_'))), BOTONS_HOME: home, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

/** A home with a one-row database and one workspace file. */
function smallHome(prefix: string): string {
  const h = tempDir(prefix);
  const db = new DatabaseSync(join(h, 'botons.db'));
  db.exec("create table bots (id text primary key); insert into bots values ('bot_1')");
  db.close();
  mkdirSync(join(h, 'workspaces', 'w1'), { recursive: true });
  writeFileSync(join(h, 'workspaces', 'w1', 'notes.md'), 'kept\n');
  return h;
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

// A live server with a Boton that has chat, routines (one with a webhook), a run, memories, and files to archive.
// Paired devices live in the database, so a restored server accepts its token too.
const live = await startServer({ env });
const { home } = live;
const bot = await live.newBot('Archivist');
assert.equal((await live.send(bot.id, 'Remember the plan')).status, 202);
await until(async () => (await get<Message[]>(live, `/api/bots/${bot.id}/messages`)).some((m) => m.role === 'bot'));
await live.newRoutine(bot.id, { name: 'Daily digest', instruction: 'Digest', schedule: '0 9 * * *' });
const hookRoutine = await live.newRoutine(bot.id, { name: 'On deploy', instruction: 'Report it', webhook: true });
const firstRun = await live.hook(hookRoutine, 'wait=1&timeout=5', { body: '{"v":1}' });
assert.equal(((await firstRun.json()) as RoutineRun).status, 'succeeded');
assert.equal((await live.call('POST', `/api/bots/${bot.id}/memories`, { text: 'The plan is in plan.md' })).status, 201);
writeFileSync(join(bot.workspace, 'plan.md'), '# The plan\n');
writeFileSync(join(home, 'shared', 'handoff.md'), 'for the other botons\n');
mkdirSync(join(home, 'templates'), { recursive: true });
writeFileSync(join(home, 'templates', 'tpl_test.json'), '{}\n');
// A Boton's browser profile as Chromium leaves it while it runs: its cookies, a cache, and its lock links.
const profile = join(home, 'browser', bot.id, 'profile');
mkdirSync(join(profile, 'Default', 'Cache'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Cookies'), 'cookies\n');
writeFileSync(join(profile, 'Default', 'Cache', 'data_0'), 'cache\n');
symlinkSync('myhost-1234', join(profile, 'SingletonLock'));
symlinkSync('123.0.0.0:1', join(profile, 'RunningChromeVersion'));

test('a backup of a running server is private, passes integrity_check, has the live rows and the archived folders, and is rsynced', async () => {
  const dbPath = join(home, 'botons.db');
  assert.ok(statSync(`${dbPath}-wal`).size > 0, 'rows still in the WAL must be in the copy too');
  const liveCounts = counts(live.app.store.db);
  assert.ok(COUNTED.every((t) => liveCounts[t] > 0), JSON.stringify(liveCounts));
  const rsyncTarget = spawnSync('rsync', ['--version']).status === 0 ? tempDir('botons-rsync-') : null;

  const out = await runBackupScript(home, rsyncTarget ? { BOTONS_BACKUP_RSYNC_TO: rsyncTarget } : {});
  assert.equal(out.code, 0, out.stderr);
  const [name] = listBackups(join(home, 'backups'));
  const dir = join(home, 'backups', name);
  assert.match(out.stdout, new RegExp(`Backed up .* to ${dir}`));

  assert.deepEqual(inspect(join(dir, 'botons.db')), { integrity: 'ok', counts: liveCounts });
  const manifest = manifestOf(dir);
  assert.equal(manifest.schemaVersion, Number(live.app.store.db.prepare('pragma user_version').get()!.user_version));
  for (const t of COUNTED) assert.equal(manifest.counts[t], liveCounts[t]);

  const archived = execFileSync('tar', ['-tzf', join(dir, 'workspaces.tar.gz')], { encoding: 'utf8' });
  for (const f of [`workspaces/${bot.workspace.split('/').pop()}/plan.md`, 'shared/handoff.md', 'templates/tpl_test.json']) assert.ok(archived.includes(f), archived);
  assert.deepEqual(manifest.folders, ['workspaces', 'shared', 'templates', 'browser']);
  // Browser profiles keep their cookies, without Chromium's lock links (a restore refuses links) or caches.
  assert.ok(archived.includes(`browser/${bot.id}/profile/Default/Cookies`), archived);
  assert.ok(!archived.includes('SingletonLock') && !archived.includes('RunningChromeVersion') && !archived.includes('Cache/data_0'), archived);
  assert.doesNotThrow(() => planRestore({ home: tempDir('botons-restore-plan-'), backup: dir, maxSchema: SCHEMA_VERSION }));

  assert.equal(statSync(join(home, 'backups')).mode & 0o777, 0o700);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.equal((await live.call('GET', '/api/health', undefined, null)).status, 200);

  if (rsyncTarget) {
    assert.deepEqual(readdirSync(rsyncTarget), [name]);
    assert.equal(inspect(join(rsyncTarget, name, 'botons.db')).integrity, 'ok');
  }
});

test('a backup taken while the server is writing is a consistent snapshot', async () => {
  const backupsDir = join(home, 'backups');
  const already = new Set(listBackups(backupsDir));
  const startCount = counts(live.app.store.db).messages;
  let writing = true;
  const writer = (async () => {
    let i = 0;
    while (writing) {
      live.app.store.addMessage(bot.id, 'event', `tick ${i++}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
  const out = await runBackupScript(home);
  writing = false;
  await writer;
  assert.equal(out.code, 0, out.stderr);
  const endCount = counts(live.app.store.db).messages;
  // Timer throughput depends on runner load; snapshot correctness does not require a minimum write rate.
  assert.ok(endCount > startCount, 'messages were written while the backup process ran');

  const name = listBackups(backupsDir).find((n) => !already.has(n))!;
  const snap = inspect(join(backupsDir, name, 'botons.db'));
  assert.equal(snap.integrity, 'ok');
  assert.ok(snap.counts.messages >= startCount && snap.counts.messages <= endCount, `${startCount} <= ${snap.counts.messages} <= ${endCount}`);
});

test(`backups keep the newest ${KEEP_BACKUPS} and delete nothing they did not make; when tar fails the database is kept, nothing is pruned, and the run fails`, async () => {
  const h = smallHome('botons-backup-keep-');
  const backupsDir = join(h, 'backups');
  mkdirSync(backupsDir);
  // Files and folders the backups did not make (copies by hand, notes) must survive pruning.
  const others = ['copy-2025-01-01T00-00-00-000Z.db', 'copy-2024-01-01T00-00-00-000Z.db.partial', 'notes.txt', 'by-hand'];
  for (const f of others.slice(0, 3)) writeFileSync(join(backupsDir, f), '');
  mkdirSync(join(backupsDir, 'by-hand'));
  const nights = Array.from({ length: KEEP_BACKUPS + 3 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i, 11, 30)));
  // A partial backup is cleaned up once it is a day old; a younger one may still be running.
  const stale = `${stamp(new Date('2024-12-01T00:00:00Z'))}.partial`;
  const young = `${stamp(new Date(nights.at(-1)!.getTime() - 3_600_000))}.partial`;
  mkdirSync(join(backupsDir, stale));
  mkdirSync(join(backupsDir, young));

  const removed = nights.flatMap((now) => backup({ home: h, now }).removed);
  const kept = nights.slice(-KEEP_BACKUPS).map((d) => stamp(d));
  assert.deepEqual(listBackups(backupsDir), kept);
  assert.deepEqual(removed, nights.slice(0, 3).map((d) => stamp(d)));
  assert.deepEqual(readdirSync(backupsDir).filter((n) => !kept.includes(n)).sort(), [...others, young].sort());
  for (const name of kept) assert.deepEqual(readdirSync(join(backupsDir, name)).sort(), ['botons.db', 'manifest.json', 'workspaces.tar.gz']);

  const bin = tempDir('botons-fake-tar-');
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\necho "tar: workspaces.tar.gz: Cannot write: No space left on device" >&2\nexit 2\n', { mode: 0o755 });
  const out = await runBackupScript(h, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(out.code, 1, 'the systemd unit is marked failed');
  assert.match(out.stderr, /The workspaces were NOT backed up; the database was\. Older backups were kept\. tar failed \(exit 2\): .*No space left on device/);
  const all = listBackups(backupsDir);
  assert.deepEqual(all.slice(0, -1), kept);
  const dir = join(backupsDir, all.at(-1)!);
  assert.match(out.stdout, new RegExp(`Backed up .* to ${dir}`));
  assert.deepEqual(readdirSync(dir).sort(), ['botons.db', 'manifest.json']);
  assert.equal(inspect(join(dir, 'botons.db'), ['bots']).integrity, 'ok');
  const manifest = manifestOf(dir);
  assert.deepEqual([manifest.workspaces, manifest.counts.bots], [false, 1]);
  assert.match(manifest.workspacesError, /^tar failed \(exit 2\): .*No space left on device/);
});

test(
  'files the backup cannot read are skipped with a warning; the rest is backed up',
  { skip: process.getuid?.() === 0 && 'root can read every file' },
  async () => {
    const h = smallHome('botons-backup-unreadable-');
    const w1 = join(h, 'workspaces', 'w1');
    writeFileSync(join(w1, 'secret'), 'x');
    mkdirSync(join(w1, 'root-owned'));
    writeFileSync(join(w1, 'root-owned', 'inside'), 'x');
    chmodSync(join(w1, 'secret'), 0o000);
    chmodSync(join(w1, 'root-owned'), 0o000);
    try {
      const out = await runBackupScript(h);
      if (process.platform === 'darwin') {
        assert.equal(out.code, 1, 'BSD tar must refuse an incomplete archive');
        const dir = join(h, 'backups', listBackups(join(h, 'backups'))[0]);
        assert.equal(inspect(join(dir, 'botons.db'), ['bots']).integrity, 'ok');
        assert.equal(manifestOf(dir).workspaces, false);
        assert.match(manifestOf(dir).workspacesError, /Permission denied/);
        return;
      }
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stderr, /tar warnings \(these files are not in the backup\):/);
      assert.match(out.stderr, /w1\/secret: Warning: Cannot open: Permission denied/);
      assert.match(out.stderr, /w1\/root-owned: Warning: Cannot open: Permission denied/);
      const dir = join(h, 'backups', listBackups(join(h, 'backups'))[0]);
      assert.equal(inspect(join(dir, 'botons.db'), ['bots']).integrity, 'ok');
      const manifest = manifestOf(dir);
      assert.deepEqual([manifest.workspaces, manifest.workspacesError], [true, undefined]);
      assert.match(manifest.tarWarning, /w1\/secret: Warning: Cannot open: Permission denied/);
      const archived = execFileSync('tar', ['-tzf', join(dir, 'workspaces.tar.gz')], { encoding: 'utf8' }).split('\n');
      assert.ok(archived.includes('workspaces/w1/notes.md'), archived.join());
      assert.ok(!archived.includes('workspaces/w1/secret'));
    } finally {
      chmodSync(join(w1, 'secret'), 0o600);
      chmodSync(join(w1, 'root-owned'), 0o700);
    }
  },
);

test('restoring a backup into a different BOTONS_HOME brings back chats, routines, webhook keys, memories and workspaces', async () => {
  const { dir } = backup({ home });
  const want = {
    bots: await get<Bot[]>(live, '/api/bots'),
    messages: await get<Message[]>(live, `/api/bots/${bot.id}/messages?limit=500`),
    routines: await get<Routine[]>(live, `/api/bots/${bot.id}/routines`),
    memories: await get<Memory[]>(live, `/api/bots/${bot.id}/memories`),
  };

  // The README's restore steps, into a new home.
  const other = tempDir('botons-restore-test-');
  copyFileSync(join(dir, 'botons.db'), join(other, 'botons.db'));
  execFileSync('tar', ['-xzf', join(dir, 'workspaces.tar.gz'), '-C', other]);
  const restored = await startServer({ home: other, token: live.token, env });

  const folder = bot.workspace.split('/').pop()!;
  const bots = await get<Bot[]>(restored, '/api/bots');
  assert.deepEqual(
    bots.map(({ workspace, status: _s, ...rest }) => ({ ...rest, workspace })),
    want.bots.map(({ workspace: _w, status: _s, ...rest }) => ({ ...rest, workspace: join(other, 'workspaces', folder) })),
  );
  assert.equal(readFileSync(join(other, 'workspaces', folder, 'plan.md'), 'utf8'), '# The plan\n');
  assert.deepEqual(await get<Message[]>(restored, `/api/bots/${bot.id}/messages?limit=500`), want.messages);
  const keysOnly = (routines: Routine[]) => routines.map((r) => ({ ...r, webhook: r.webhook && { key: r.webhook.key } }));
  assert.deepEqual(keysOnly(await get<Routine[]>(restored, `/api/bots/${bot.id}/routines`)), keysOnly(want.routines));
  assert.deepEqual(await get<Memory[]>(restored, `/api/bots/${bot.id}/memories`), want.memories);

  // The old webhook key still authorizes, and turns run in the restored workspace.
  const hooked = await restored.hook(hookRoutine, 'wait=1&timeout=5', { body: '{"after":"restore"}' });
  assert.equal(hooked.status, 200);
  assert.equal(((await hooked.json()) as RoutineRun).status, 'succeeded');
  assert.equal(restored.mock.turns.at(-1)!.cwd, join(other, 'workspaces', folder));
  assert.equal((await restored.hook(hookRoutine, '', { headers: { authorization: 'Bearer nope' } })).status, 401);

  assert.equal((await restored.send(bot.id, 'Are you back?')).status, 202);
  await until(async () => (await get<Message[]>(restored, `/api/bots/${bot.id}/messages`)).some((m) => m.text === 'Echo: Are you back?'));
  assert.equal(restored.mock.turns.at(-1)!.cwd, join(other, 'workspaces', folder));
});

test('the install script renders a daily, persistent timer that runs the backup script', { skip: process.platform !== 'linux' ? 'systemd timer installation needs Linux' : false }, () => {
  const dir = tempDir('botons-units-');
  execFileSync(process.execPath, [join(repo, 'scripts/install-backup-timer.ts'), '--dir', dir], { encoding: 'utf8' });
  const timer = readFileSync(join(dir, 'botons-backup.timer'), 'utf8');
  const service = readFileSync(join(dir, 'botons-backup.service'), 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.ok(service.includes(`\nExecStart="${process.execPath}" "${repo}/scripts/backup.ts"\n`), service);
  assert.ok(!/@[A-Z]+@/.test(service + timer), 'every placeholder is filled in');
});
