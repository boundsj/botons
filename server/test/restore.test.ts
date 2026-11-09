import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backup, planRestore, restore } from '../src/backup.ts';
import { lockDataDir } from '../src/lock.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');

/** A home whose database holds `rows` and whose workspace file says `note`. */
function homeWith(rows: string[], note: string, home = tempDir()): string {
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`create table if not exists bots (id text primary key); delete from bots; pragma user_version = ${SCHEMA_VERSION}`);
  for (const r of rows) db.prepare('insert into bots values (?)').run(r);
  db.close();
  mkdirSync(join(home, 'workspaces', 'w1'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'w1', 'notes.md'), note);
  return home;
}

const rowsOf = (home: string) => {
  const db = new DatabaseSync(join(home, 'botons.db'), { readOnly: true });
  try {
    return db.prepare('select id from bots order by id').all().map((r) => r.id);
  } finally {
    db.close();
  }
};
const note = (home: string) => readFileSync(join(home, 'workspaces', 'w1', 'notes.md'), 'utf8');

function script(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(repo, 'scripts/restore.ts'), ...args], {
    env: { PATH: process.env.PATH, HOME: home, BOTONS_HOME: home },
    encoding: 'utf8',
  });
}

test('restore puts the backup back and sets the state it replaces aside, deleting nothing', () => {
  const home = homeWith(['bot_a'], 'then\n');
  const { dir } = backup({ home });
  homeWith(['bot_a', 'bot_b'], 'now\n', home);
  mkdirSync(join(home, 'shared'));
  writeFileSync(join(home, 'shared', 'later.txt'), 'made after the backup');

  const plan = planRestore({ home, backup: 'latest', maxSchema: SCHEMA_VERSION });
  assert.equal(plan.from, dir);
  assert.equal(plan.workspaces, true);
  assert.deepEqual(plan.moves, ['botons.db', 'workspaces', 'shared']);
  restore(home, plan);

  assert.deepEqual(rowsOf(home), ['bot_a']);
  assert.equal(note(home), 'then\n');
  assert.equal(existsSync(join(home, 'shared')), false, 'the backup had no shared folder');
  assert.equal(statSync(join(home, 'botons.db')).mode & 0o777, 0o600);
  // What was there is kept, privately.
  assert.deepEqual(rowsOf(plan.setAside), ['bot_a', 'bot_b']);
  assert.equal(note(plan.setAside), 'now\n');
  assert.equal(readFileSync(join(plan.setAside, 'shared', 'later.txt'), 'utf8'), 'made after the backup');
  assert.equal(statSync(plan.setAside).mode & 0o777, 0o700);
});

test('a restore that fails part-way leaves the data folder as it was', () => {
  const home = homeWith(['bot_a'], 'then\n');
  backup({ home });
  homeWith(['bot_a', 'bot_b'], 'now\n', home);
  const plan = planRestore({ home, backup: 'latest', maxSchema: SCHEMA_VERSION });
  // The archive goes missing after the plan was made: tar fails after the database was copied.
  rmSync(join(plan.from, 'workspaces.tar.gz'));
  assert.throws(() => restore(home, plan), /Unpacking workspaces\.tar\.gz failed/);
  assert.deepEqual(rowsOf(home), ['bot_a', 'bot_b']);
  assert.equal(note(home), 'now\n');
  assert.equal(existsSync(plan.setAside), false);
});

test('restore refuses what is not a Botons backup of this or an older schema', () => {
  const home = homeWith(['bot_a'], 'x');
  assert.throws(() => planRestore({ home, backup: 'latest', maxSchema: SCHEMA_VERSION }), /There is no backup/);
  assert.throws(() => planRestore({ home, backup: tempDir(), maxSchema: SCHEMA_VERSION }), /has no botons\.db/);

  const { dir } = backup({ home });
  assert.throws(() => planRestore({ home, backup: dir, maxSchema: SCHEMA_VERSION - 1 }), /newer than this code/);

  // An archive with anything but the archived folders is never unpacked.
  const stray = tempDir();
  writeFileSync(join(stray, 'evil.sh'), 'x');
  spawnSync('tar', ['-czf', join(dir, 'workspaces.tar.gz'), '-C', stray, 'evil.sh']);
  assert.throws(() => planRestore({ home, backup: dir, maxSchema: SCHEMA_VERSION }), /holds evil\.sh/);
});

test('npm run restore: a dry run by default, refuses while a server holds the data folder, then restores with --yes', () => {
  const home = homeWith(['bot_a'], 'then\n');
  const { dir } = backup({ home });
  homeWith(['bot_b'], 'now\n', home);
  const name = dir.split('/').at(-1)!;

  const list = script(home, '--list');
  assert.equal(list.status, 0);
  assert.match(list.stdout, new RegExp(`^${name}  schema v${SCHEMA_VERSION}, workspaces$`, 'm'));

  const dry = script(home, name);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Nothing was changed/);
  assert.deepEqual(rowsOf(home), ['bot_b']);

  const lock = lockDataDir(home);
  try {
    const busy = script(home, name, '--yes');
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /Stop the server first/);
    assert.deepEqual(rowsOf(home), ['bot_b']);
  } finally {
    lock.release();
  }

  const done = script(home, name, '--yes');
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(rowsOf(home), ['bot_a']);
  assert.equal(note(home), 'then\n');
  assert.equal(readdirSync(home).filter((f) => f.startsWith('before-restore-')).length, 1);
  assert.equal(existsSync(join(home, 'server.pid')), false, 'the lock is released');
});


test('restore rejects hard links and unsupported old schemas without moving originals', () => {
  const home = homeWith(['bot_a'], 'original');
  const { dir } = backup({ home });
  const source = tempDir();
  writeFileSync(join(source, 'botons.db'), 'private database');
  mkdirSync(join(source, 'workspaces'));
  linkSync(join(source, 'botons.db'), join(source, 'workspaces', 'db-link'));
  const tar = spawnSync('tar', ['-czf', join(dir, 'workspaces.tar.gz'), '-C', source, 'botons.db', 'workspaces']);
  assert.equal(tar.status, 0);
  assert.throws(() => planRestore({ home, backup: dir, maxSchema: SCHEMA_VERSION }), /links or special files/);
  rmSync(join(dir, 'workspaces.tar.gz'));
  const db = new DatabaseSync(join(dir, 'botons.db'));
  db.exec(`pragma user_version = ${SCHEMA_VERSION - 2}`);
  db.close();
  assert.throws(() => planRestore({ home, backup: dir, maxSchema: SCHEMA_VERSION }), /cannot be upgraded/);
  assert.deepEqual(rowsOf(home), ['bot_a']);
  assert.equal(note(home), 'original');
});


test('restore reports a space failure while creating a fresh home without a stack trace', () => {
  const source = homeWith(['bot_kevin'], 'notes');
  const { dir } = backup({ home: source });
  const scratch = tempDir();
  const target = join(scratch, 'fresh');
  const hook = join(scratch, 'full-disk.mjs');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const mkdir = fs.mkdirSync;
fs.mkdirSync = function(path, ...args) {
  if (String(path) === process.env.BOTONS_HOME) throw Object.assign(new Error('SIMULATED ENOSPC'), { code: 'ENOSPC' });
  return mkdir.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--import', hook, join(repo, 'scripts/restore.ts'), dir, '--yes'], {
    env: { PATH: process.env.PATH, HOME: scratch, BOTONS_HOME: target }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SIMULATED ENOSPC/);
  assert.match(result.stderr, /Free space on the disk/);
  assert.doesNotMatch(result.stderr, /at .*file:/);
  assert.equal(existsSync(target), false);
});
