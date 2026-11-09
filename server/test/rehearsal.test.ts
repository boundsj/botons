// Restore rehearsals: the checks (server/src/rehearsal.ts) on realistic and hostile backups, and the owner's action
// (server/src/rehearsals.ts, POST /api/backups/rehearse) with its limits, audit, shutdown and restart.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AuditEvent, OperationsStatus, RestoreRehearsal } from '../../shared/types.ts';
import { backup, planRestore, stamp } from '../src/backup.ts';
import { memberNameOk, REHEARSAL_LIMITS, type RehearsalLimits, rehearse, TarChecker } from '../src/rehearsal.ts';
import { REHEARSAL_LIMIT } from '../src/rehearsals.ts';
import { openSchema, SCHEMA_VERSION } from '../src/schema.ts';
import { startServer, tempDir, until } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const now = '2026-11-06T08:00:00.000Z';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A data folder like a real one: a database at SCHEMA_VERSION with Botons, messages and a routine, and workspaces. */
function realisticHome(home = tempDir()): string {
  const db = new DatabaseSync(join(home, 'botons.db'));
  openSchema(db);
  db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
  for (const [id, name] of [['bot_kevin', 'Kevin'], ['bot_stuart', 'Stuart']]) {
    db.prepare("insert into bots (id, name, look, provider, timezone, workspace, created_at, updated_at, last_activity_at) values (?, ?, '{}', 'mock', 'UTC', ?, ?, ?, ?)").run(id, name, name.toLowerCase(), now, now, now);
  }
  for (let i = 0; i < 50; i++) db.prepare("insert into messages (id, bot_id, role, text, created_at) values (?, 'bot_kevin', 'user', ?, ?)").run(`msg_${i}`, `hello ${i}`, now);
  db.close();
  mkdirSync(join(home, 'workspaces', 'kevin', 'notes'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'kevin', 'notes', 'today.md'), 'buy bananas\n');
  // Longer than a tar header's 100-byte name field.
  const deep = join(home, 'workspaces', 'stuart', 'a'.repeat(60), 'b'.repeat(60));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'song.txt'), 'la la la\n');
  mkdirSync(join(home, 'shared'));
  writeFileSync(join(home, 'shared', 'team.md'), 'the team\n');
  return home;
}

const PREVIOUS = SCHEMA_VERSION - 1;

/** A database at the schema before this one with data (the fixture the schema tests upgrade). */
function previousSchemaHome(home = tempDir()): string {
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`${readFileSync(join(import.meta.dirname, `fixtures/schema-${PREVIOUS}.sql`), 'utf8')}\npragma user_version = ${PREVIOUS};`);
  db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
  db.prepare("insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values ('grp_lab', 'Équipe', 'équipe', 0, 1, ?, ?)").run(now, now);
  db.prepare(
    "insert into bots (id, name, look, provider, timezone, workspace, session_id, session_key, group_id, position, pinned, pin_position, skills, created_at, updated_at, last_activity_at) values ('bot_dave', 'Dave', ?, 'mock', 'UTC', 'dave', 'sess-1', 'key-1', 'grp_lab', 0, 1, 0, '[\"weekly\"]', ?, ?, ?)",
  ).run(JSON.stringify({ body: '#123456', eyes: 2, hair: 'spiky', mouth: 'grin' }), now, now, now);
  db.prepare("insert into skills (name, description, body, created_by, updated_by, created_at, updated_at) values ('weekly', 'Write the weekly report.', 'Steps.', '{\"kind\":\"owner\"}', '{\"kind\":\"owner\"}', ?, ?)").run(now, now);
  db.prepare("insert into messages (id, bot_id, role, text, created_at) values ('msg_1', 'bot_dave', 'user', 'hi', ?)").run(now);
  // What the upgrade from 28 indexes: a pin, a routine's output, a reset, and a meta that isn't JSON.
  const msg = db.prepare("insert into messages (id, bot_id, role, text, meta, created_at) values (?, 'bot_dave', ?, ?, ?, ?)");
  msg.run('msg_reset', 'event', 'Started a fresh conversation', JSON.stringify({ kind: 'session.reset' }), now);
  msg.run('msg_pin', 'user', 'We ship on Friday.', JSON.stringify({ pinned: { at: now } }), now);
  msg.run('msg_brief', 'bot', 'The brief.', JSON.stringify({ routineId: 'rt_brief', routineName: 'Brief' }), now);
  msg.run('msg_bad', 'bot', 'not JSON', '{"pinned":', now);
  db.close();
  mkdirSync(join(home, 'workspaces', 'dave'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'dave', 'plan.md'), 'plan\n');
  return home;
}

const backupsOf = (home: string) => join(home, 'backups');
const nameOf = (dir: string) => dir.split('/').at(-1)!;

async function run(home: string, name: string, limits: Partial<RehearsalLimits> = {}) {
  const workDir = tempDir('botons-rehearsal-test-');
  const result = await rehearse({ backupsDir: backupsOf(home), name, workDir, limits: { ...REHEARSAL_LIMITS, ...limits } });
  assert.deepEqual(readdirSync(workDir), [], 'the copy and its side files are gone');
  return result;
}

/** A backup folder made by hand: `files` maps names in it to contents. */
function handBackup(home: string, files: Record<string, Buffer | string>, at = new Date('2026-11-01T03:30:00.000Z')): string {
  const name = stamp(at);
  const dir = join(backupsOf(home), name);
  mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content);
  return name;
}

// ------------------------------------------------------------------ a tar writer for hostile archives

interface Entry {
  name: string;
  type?: string;
  body?: Buffer | string;
  link?: string;
  /** Header size field, when it should differ from the body's. */
  size?: number;
  /** Raw header fields, when they should differ from a POSIX ustar header's usual ones. */
  fields?: { mode?: string; uid?: string; gid?: string; mtime?: string; magic?: string; prefix?: string };
}

function header(name: string, type: string, size: number, link = '', fields: Entry['fields'] = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(fields.mode ?? '0000644\0', 100);
  h.write(fields.uid ?? '0001750\0', 108, 'latin1');
  h.write(fields.gid ?? '0001750\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(fields.mtime ?? '15000000000\0', 136, 'latin1');
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link.slice(0, 100), 157);
  h.write(fields.magic ?? 'ustar\x0000', 257, 'latin1');
  if (fields.prefix) h.write(fields.prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function tarOf(entries: Entry[], { end = true }: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    parts.push(header(e.name, e.type ?? '0', e.size ?? body.length, e.link, e.fields));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function pax(records: Record<string, string>): Buffer {
  let out = '';
  for (const [k, v] of Object.entries(records)) {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len++;
    out += `${len}${body}`;
  }
  return Buffer.from(out);
}

/** A backup whose database is realistic and whose archive is `archive`. */
function withArchive(archive: Buffer): { home: string; name: string } {
  const home = realisticHome();
  const name = nameOf(backup({ home }).dir);
  writeFileSync(join(backupsOf(home), name, 'workspaces.tar.gz'), archive);
  return { home, name };
}

// ------------------------------------------------------------------ the checks

test('a realistic backup rehearses: the copy passes, the archive is read through, and the data folder is untouched', async () => {
  const home = realisticHome();
  const { dir } = backup({ home });
  const before = { db: sha(join(home, 'botons.db')), backup: sha(join(dir, 'botons.db')), archive: sha(join(dir, 'workspaces.tar.gz')), entries: readdirSync(home).sort() };
  const r = await run(home, nameOf(dir));
  assert.deepEqual(r, { ok: true, problem: null, fromSchema: SCHEMA_VERSION, toSchema: SCHEMA_VERSION, matchesManifest: true, workspaces: 'checked', files: 3, folders: r.folders, bytes: 30 });
  assert.ok(r.folders! >= 6);
  assert.equal(sha(join(home, 'botons.db')), before.db);
  assert.equal(sha(join(dir, 'botons.db')), before.backup);
  assert.equal(sha(join(dir, 'workspaces.tar.gz')), before.archive);
  assert.deepEqual(readdirSync(home).sort(), before.entries);
});

test('a backup from the schema before is upgraded in the copy, as the next start would, and the backup itself stays as it was', async () => {
  const home = previousSchemaHome();
  const { dir, manifest } = backup({ home });
  assert.equal(manifest.schemaVersion, PREVIOUS);
  const before = sha(join(dir, 'botons.db'));
  const r = await run(home, nameOf(dir));
  assert.equal(r.ok, true, r.problem ?? '');
  assert.equal(r.fromSchema, PREVIOUS);
  assert.equal(r.toSchema, SCHEMA_VERSION);
  assert.equal(r.matchesManifest, true);
  assert.equal(sha(join(dir, 'botons.db')), before);
  const check = new DatabaseSync(join(dir, 'botons.db'), { readOnly: true });
  assert.equal(check.prepare('pragma user_version').get()!.user_version, PREVIOUS);
  check.close();
});

test('a backup without workspaces rehearses its database only', async () => {
  const home = realisticHome();
  const { dir } = backup({ home });
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'workspaces.tar.gz'));
  const r = await run(home, nameOf(dir));
  assert.equal(r.ok, true);
  assert.equal(r.workspaces, 'none');
  assert.equal(r.files, null);
});

test('a manifest that does not match the database is reported, not trusted', async () => {
  const home = realisticHome();
  const { dir } = backup({ home });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.counts.messages = 9999;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const r = await run(home, nameOf(dir));
  assert.equal(r.ok, true);
  assert.equal(r.matchesManifest, false);
});

test('schemas a restore refuses are failed with the schema found, and nothing is upgraded', async () => {
  for (const [version, problem] of [[SCHEMA_VERSION + 1, 'newer-schema'], [SCHEMA_VERSION - 2, 'older-schema']] as const) {
    const home = realisticHome();
    const { dir } = backup({ home });
    const db = new DatabaseSync(join(dir, 'botons.db'));
    db.exec(`pragma user_version = ${version}`);
    db.close();
    const r = await run(home, nameOf(dir));
    assert.equal(r.ok, false);
    assert.equal(r.problem, problem);
    assert.equal(r.fromSchema, version);
    assert.equal(r.toSchema, null);
  }
});

test('an upgrade that fails in the copy is upgrade-failed', async () => {
  const home = previousSchemaHome();
  const { dir } = backup({ home });
  // A table the upgrade from 34 renames one to, already there: the step throws.
  assert.equal(PREVIOUS, 34, 'make this database fail the newest upgrade step');
  const db = new DatabaseSync(join(dir, 'botons.db'));
  db.exec('create table audit_events_34 (x)');
  db.close();
  const r = await run(home, nameOf(dir));
  assert.equal(r.problem, 'upgrade-failed');
  assert.equal(r.fromSchema, PREVIOUS);
});

test('a damaged or foreign database is refused without reading further', async () => {
  const home = realisticHome();
  const { dir } = backup({ home });
  const file = join(dir, 'botons.db');
  const bytes = readFileSync(file);
  // Scribble over pages past the first: the header still says SQLite.
  for (let i = 4096; i < bytes.length; i += 97) bytes[i] = 0xff;
  writeFileSync(file, bytes);
  assert.equal((await run(home, nameOf(dir))).problem, 'damaged-database');

  writeFileSync(file, Buffer.alloc(8192, 'not a database'));
  assert.equal((await run(home, nameOf(dir))).problem, 'not-a-backup');

  // An SQLite file that is not Botons'.
  const other = new DatabaseSync(file + '.other');
  other.exec('create table notes (id integer primary key); pragma user_version = ' + SCHEMA_VERSION);
  other.close();
  renameSync(file + '.other', file);
  assert.equal((await run(home, nameOf(dir))).problem, 'not-a-backup');
});

test('links and odd files in a backup folder are never followed', async () => {
  const home = realisticHome();
  const { dir } = backup({ home });
  const name = nameOf(dir);
  // The live database through a link: not read.
  renameSync(join(dir, 'botons.db'), join(dir, 'kept.db'));
  symlinkSync(join(home, 'botons.db'), join(dir, 'botons.db'));
  assert.equal((await run(home, name)).problem, 'not-a-backup');

  // The backup folder itself a link to elsewhere.
  const elsewhere = realisticHome();
  const other = nameOf(backup({ home: elsewhere }).dir);
  const linked = stamp(new Date('2026-01-01T00:00:00.000Z'));
  symlinkSync(join(backupsOf(elsewhere), other), join(backupsOf(home), linked));
  assert.equal((await run(home, linked)).problem, 'not-found');

  // Names that are not a backup's.
  for (const bad of ['../x', 'latest', '', '2026-99-99T00-00-00-000Z', `${name}/..`]) assert.equal((await run(home, bad)).problem, 'not-found', bad);

  // A FIFO where the archive goes: refused, without blocking.
  const fifo = realisticHome();
  const fdir = backup({ home: fifo }).dir;
  const { rmSync } = await import('node:fs');
  rmSync(join(fdir, 'workspaces.tar.gz'));
  assert.equal(spawnSync('mkfifo', [join(fdir, 'workspaces.tar.gz')]).status, 0);
  assert.equal((await run(fifo, nameOf(fdir))).problem, 'not-a-backup');
});

test('archive members a restore refuses fail the rehearsal as unsafe', async () => {
  const cases: [string, Entry[]][] = [
    ['symlink', [{ name: 'workspaces/', type: '5' }, { name: 'workspaces/key', type: '2', link: '/home/you/.ssh/id_ed25519' }]],
    ['hard link', [{ name: 'workspaces/a', body: 'x' }, { name: 'workspaces/b', type: '1', link: 'workspaces/a' }]],
    ['character device', [{ name: 'workspaces/tty', type: '3' }]],
    ['FIFO', [{ name: 'workspaces/pipe', type: '6' }]],
    ['dot-dot', [{ name: 'workspaces/../botons.db', body: 'x' }]],
    ['absolute', [{ name: '/etc/cron.d/x', body: 'x' }]],
    ['outside the archived folders', [{ name: 'botons.db', body: 'x' }]],
    ['a folder that only starts like one', [{ name: 'workspacesX/a', body: 'x' }]],
    ['a control character', [{ name: 'workspaces/a\nb', body: 'x' }]],
    ['global pax header', [{ name: 'pax_global_header', type: 'g', body: pax({ path: 'workspaces/a' }) }, { name: 'workspaces/a', body: 'x' }]],
    ['pax path outside', [{ name: 'PaxHeaders/a', type: 'x', body: pax({ path: '../../etc/passwd' }) }, { name: 'workspaces/a', body: 'x' }]],
    ['pax linkpath', [{ name: 'PaxHeaders/a', type: 'x', body: pax({ linkpath: '/etc/passwd' }) }, { name: 'workspaces/a', body: 'x' }]],
    ['GNU long name outside', [{ name: '././@LongLink', type: 'L', body: `../${'x'.repeat(120)}\0` }, { name: 'workspaces/a', body: 'x' }]],
    ['GNU sparse', [{ name: 'workspaces/s', type: 'S' }]],
  ];
  for (const [label, entries] of cases) {
    const { home, name } = withArchive(gzipSync(tarOf(entries)));
    const r = await run(home, name);
    assert.equal(r.problem, 'unsafe-archive', label);
    assert.equal(r.workspaces, 'not-checked', label);
    assert.equal(r.fromSchema, SCHEMA_VERSION, `${label}: the database was checked first`);
  }
});

test('pax and GNU long names inside the archived folders are read', async () => {
  const long = `workspaces/kevin/${'n'.repeat(150)}.md`;
  const { home, name } = withArchive(
    gzipSync(
      tarOf([
        { name: 'workspaces/', type: '5' },
        { name: 'PaxHeaders/x', type: 'x', body: pax({ path: long, mtime: '1.5' }) },
        { name: 'workspaces/short', body: 'abc' },
        { name: '././@LongLink', type: 'L', body: `${long}2\0` },
        { name: 'workspaces/short2', body: 'defg' },
      ]),
    ),
  );
  const r = await run(home, name);
  assert.equal(r.ok, true, r.problem ?? '');
  assert.deepEqual([r.files, r.folders, r.bytes], [2, 1, 7]);
});

test('a GNU tar archive in pax format is read', async () => {
  const home = realisticHome();
  const name = nameOf(backup({ home }).dir);
  const archive = join(backupsOf(home), name, 'workspaces.tar.gz');
  assert.equal(spawnSync('tar', ['--format=posix', '-czf', archive, '-C', home, 'workspaces', 'shared']).status, 0);
  const r = await run(home, name);
  assert.equal(r.ok, true, r.problem ?? '');
  assert.equal(r.files, 3);
});

test('a damaged archive fails as damaged: cut short, a bad checksum, a bad gzip, trailing data', async () => {
  const good = tarOf([{ name: 'workspaces/', type: '5' }, { name: 'workspaces/a', body: 'x'.repeat(2000) }]);
  const gz = gzipSync(good);
  const badSum = Buffer.from(good);
  badSum[0] ^= 1;
  const crc = Buffer.from(gz);
  crc[crc.length - 6] ^= 0xff;
  const cases: [string, Buffer][] = [
    ['gzip cut short', gz.subarray(0, gz.length - 20)],
    ['gzip checksum', crc],
    ['not gzip', Buffer.from('plain text, not gzip')],
    ['tar without its end', gzipSync(tarOf([{ name: 'workspaces/a', body: 'x' }], { end: false }))],
    ['member cut short', gzipSync(good.subarray(0, 1024))],
    ['header checksum', gzipSync(badSum)],
    ['data after the end', gzipSync(Buffer.concat([good, Buffer.from('extra')]))],
    ['empty', gzipSync(Buffer.alloc(0))],
  ];
  for (const [label, archive] of cases) {
    const { home, name } = withArchive(archive);
    assert.equal((await run(home, name)).problem, 'damaged-archive', label);
  }
});

test('the limits bound what is read: database size, archive size, what it unpacks to, members', async () => {
  const home = realisticHome();
  const name = nameOf(backup({ home }).dir);
  assert.equal((await run(home, name, { databaseBytes: 1024 })).problem, 'database-too-large');
  assert.equal((await run(home, name, { archiveBytes: 10 })).problem, 'archive-too-large');
  assert.equal((await run(home, name, { unpackedBytes: 10 })).problem, 'archive-too-large');
  assert.equal((await run(home, name, { members: 2 })).problem, 'archive-too-large');
  assert.equal((await run(home, name, { spareBytes: Number.MAX_SAFE_INTEGER / 4 })).problem, 'no-space');
  // A small archive that claims to unpack to more than the limit: refused at its header, before the data is read.
  const bomb = withArchive(gzipSync(tarOf([{ name: 'workspaces/big', body: '', size: 0o77777777777 }], { end: false })));
  assert.equal((await run(bomb.home, bomb.name, { unpackedBytes: 1024 ** 3 })).problem, 'archive-too-large');
});

test('the unpacked limit counts the whole tar stream: padding, pax and long-name blocks, the end and what follows it', async () => {
  const small = tarOf([{ name: 'workspaces/', type: '5' }, { name: 'workspaces/a', body: 'abc' }]);
  // At the limit exactly it passes; the stream's every byte counts, so one byte less is too large.
  const exact = withArchive(gzipSync(small));
  assert.equal((await run(exact.home, exact.name, { unpackedBytes: small.length })).ok, true);
  assert.equal((await run(exact.home, exact.name, { unpackedBytes: small.length - 1 })).problem, 'archive-too-large');

  const cases: [string, Buffer][] = [
    // Holds no file data at all: two zero blocks, then zeros.
    ['zero padding after the end', gzipSync(Buffer.alloc(8192 + 1024))],
    // Every member is empty; the bulk is pax comments, each just under the metadata cap.
    [
      'pax headers',
      gzipSync(tarOf(Array.from({ length: 4 }, (_, i) => [{ name: `P/${i}`, type: 'x', body: pax({ comment: 'c'.repeat(60_000) }) }, { name: `workspaces/${i}` }]).flat())),
    ],
    ['GNU long names', gzipSync(tarOf(Array.from({ length: 40 }, (_, i) => [{ name: '././@LongLink', type: 'L', body: `workspaces/${String(i).padEnd(4000, 'n')}\0` }, { name: `workspaces/${i}` }]).flat()))],
    // Concatenated gzip members are one stream to gunzip: neither half is over the limit alone.
    ['across gzip members', Buffer.concat([gzipSync(small.subarray(0, 1024)), gzipSync(Buffer.alloc(6000)), gzipSync(Buffer.alloc(6000))])],
  ];
  for (const [label, archive] of cases) {
    const unpacked = gunzipSync(archive).length;
    assert.ok(unpacked > 8192, label);
    const { home, name } = withArchive(archive);
    const r = await run(home, name, { unpackedBytes: 8192 });
    assert.equal(r.problem, 'archive-too-large', label);
    assert.equal(r.bytes, null, `${label}: no count is reported for an archive not read through`);
    // Within a limit that covers the stream, the same archive reads through (none of these is damaged).
    assert.equal((await run(home, name, { unpackedBytes: unpacked })).ok, true, `${label} passes with room`);
  }
});

test('a long stream of zeros is refused at the limit: the checker stops at the chunk that crosses it', async () => {
  const archive = gzipSync(Buffer.alloc(64 * 1024 ** 2), { level: 1 });
  const { home, name } = withArchive(archive);
  assert.equal((await run(home, name, { unpackedBytes: 1024 ** 2 })).problem, 'archive-too-large');

  const checker = new TarChecker({ unpackedBytes: 3 * 65536, members: 10 });
  const chunk = Buffer.alloc(65536);
  for (let i = 0; i < 3; i++) checker.write(chunk);
  assert.throws(() => checker.write(chunk), (err: Error) => err.message === 'archive-too-large');
  assert.equal(checker.streamed, 4 * 65536, 'counted before parsing, and no further');
});

/**
 * Archives GNU tar refuses to list, and one it lists that the rehearsal refuses anyway (unknown pax keys, which tar
 * ignores). Each is checked against the restore's own check (planRestore runs tar -t and tar -tv): the rehearsal
 * never passes an archive the restore refuses.
 */
test('pax values and header fields: refused as the restore refuses them, valid ones pass with it', async () => {
  const withPax = (records: Record<string, string>): Entry[] => [
    { name: 'workspaces/', type: '5' },
    { name: 'workspaces/notes.md', body: 'notes' },
    { name: 'PaxHeaders/a', type: 'x', body: pax(records) },
    { name: 'workspaces/a', body: 'x' },
    { name: 'shared/b', body: 'yz' },
  ];
  const withFields = (fields: Entry['fields'], name = 'workspaces/a'): Entry[] => [{ name: 'workspaces/', type: '5' }, { name, body: 'x', fields }];
  const refused: [string, Entry[], string][] = [
    ['mtime=banana', withPax({ mtime: 'banana' }), 'damaged-archive'],
    ['mtime=+1', withPax({ mtime: '+1' }), 'damaged-archive'],
    ['mtime=.5', withPax({ mtime: '.5' }), 'damaged-archive'],
    ['mtime empty', withPax({ mtime: '' }), 'damaged-archive'],
    ['mtime=1e5', withPax({ mtime: '1e5' }), 'damaged-archive'],
    ['mtime=" 1"', withPax({ mtime: ' 1' }), 'damaged-archive'],
    ['mtime past int64', withPax({ mtime: '9223372036854775808' }), 'damaged-archive'],
    ['atime=banana', withPax({ atime: 'banana' }), 'damaged-archive'],
    ['ctime=banana', withPax({ ctime: 'banana' }), 'damaged-archive'],
    ['uid=banana', withPax({ uid: 'banana' }), 'damaged-archive'],
    ['uid=-1', withPax({ uid: '-1' }), 'damaged-archive'],
    ['uid=2^32', withPax({ uid: '4294967296' }), 'damaged-archive'],
    ['gid=banana', withPax({ gid: 'banana' }), 'damaged-archive'],
    ['size=banana', withPax({ size: 'banana' }), 'damaged-archive'],
    ['size=-1', withPax({ size: '-1' }), 'damaged-archive'],
    ['a record length in hex', [{ name: 'workspaces/', type: '5' }, { name: 'PaxHeaders/a', type: 'x', body: '0x13 mtime=1.5\n' }, { name: 'workspaces/a', body: 'x' }], 'damaged-archive'],
    ['header mtime', withFields({ mtime: 'banana\0' }), 'damaged-archive'],
    ['header uid', withFields({ uid: 'banana\0' }), 'damaged-archive'],
    ['header mode', withFields({ mode: 'banana\0' }), 'damaged-archive'],
    ['binary uid overflow', withFields({ uid: '\x80\xff\xff\xff\xff\xff\xff\xff' }), 'damaged-archive'],
    ['binary uid negative', withFields({ uid: '\xff'.repeat(8) }), 'damaged-archive'],
    ['binary gid overflow', withFields({ gid: '\x80\xff\xff\xff\xff\xff\xff\xff' }), 'damaged-archive'],
    ['binary mtime overflow', withFields({ mtime: '\x80' + '\xff'.repeat(11) }), 'damaged-archive'],
    ...(['mtime', 'uid', 'size'] as const).map((key): [string, Entry[], string] => [
      `duplicate ${key} hiding an invalid value`,
      [{ name: 'PaxHeaders/a', type: 'x', body: Buffer.concat([pax({ [key]: 'banana' }), pax({ [key]: key === 'size' ? '1' : '0' })]) }, { name: 'workspaces/a', body: 'x' }],
      'damaged-archive',
    ]),
    // GNU headers have no name prefix: tar lists this as etc/x, outside the archived folders.
    ['a prefix in a GNU header', withFields({ magic: 'ustar  \0', prefix: 'workspaces' }, 'etc/x'), 'unsafe-archive'],
  ];
  for (const [label, entries, problem] of refused) {
    const { home, name } = withArchive(gzipSync(tarOf(entries)));
    const r = await run(home, name);
    assert.equal(r.ok, false, label);
    assert.equal(r.problem, problem, label);
    assert.throws(() => planRestore({ home: tempDir('botons-restore-plan-'), backup: join(backupsOf(home), name), maxSchema: SCHEMA_VERSION }), Error, `${label}: the restore refuses it too`);
  }

  // Stricter than tar on purpose: keys it ignores or applies beyond files and folders are refused.
  for (const key of ['foo.bar', 'hdrcharset', 'SCHILY.xattr.user.a', 'SCHILY.acl.access', 'GNU.sparse.major', 'linkpath']) {
    const { home, name } = withArchive(gzipSync(tarOf(withPax({ [key]: '1' }))));
    assert.equal((await run(home, name)).problem, 'unsafe-archive', key);
  }

  const accepted: [string, Entry[]][] = [
    ['mtime=1.5', withPax({ mtime: '1.5' })],
    ['mtime=-1.5', withPax({ mtime: '-1.5' })],
    ['mtime=1.', withPax({ mtime: '1.' })],
    ['mtime at int64 bounds', withPax({ mtime: '9223372036854775807', atime: '-9223372036854775808' })],
    ['a long fraction', withPax({ ctime: '1794031575.12345678901234567890' })],
    ['uid and gid', withPax({ uid: '4294967295', gid: '0', uname: 'sam', gname: 'sam' })],
    ['size and path', withPax({ size: '1', path: 'workspaces/kevin/a.md' })],
    ['comment and charset', withPax({ comment: 'made by tar', charset: 'ISO-IR 10646 2000 UTF-8' })],
    ['a base-256 mtime before 1970', withFields({ mtime: '\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xfe' })],
    ['a prefix in a POSIX header', withFields({ prefix: 'workspaces' }, 'kevin/a.md')],
  ];
  for (const [label, entries] of accepted) {
    const { home, name } = withArchive(gzipSync(tarOf(entries)));
    const r = await run(home, name);
    assert.equal(r.ok, true, `${label}: ${r.problem}`);
    assert.doesNotThrow(() => planRestore({ home: tempDir('botons-restore-plan-'), backup: join(backupsOf(home), name), maxSchema: SCHEMA_VERSION }), label);
  }
});

test('the archive a backup makes (GNU tar, its default format) and GNU tar in pax format both rehearse', async () => {
  const home = realisticHome();
  mkdirSync(join(home, 'workspaces', 'kevin', 'n'.repeat(120)), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'kevin', 'n'.repeat(120), `${'m'.repeat(120)}.md`), 'long');
  const name = nameOf(backup({ home }).dir);
  const archive = join(backupsOf(home), name, 'workspaces.tar.gz');
  const gnu = await run(home, name);
  assert.equal(gnu.ok, true, gnu.problem ?? '');
  assert.equal(spawnSync('tar', ['--format=posix', '-czf', archive, '-C', home, 'workspaces', 'shared']).status, 0);
  const posix = await run(home, name);
  assert.equal(posix.ok, true, posix.problem ?? '');
  assert.deepEqual([posix.files, posix.bytes], [gnu.files, gnu.bytes]);
});

test('member names: only under the archived folders, without "..", "." or control characters', () => {
  for (const ok of ['workspaces', 'workspaces/', 'workspaces/a/b.md', 'shared/x', 'templates/t/a.json']) assert.ok(memberNameOk(ok), ok);
  for (const bad of ['', '/workspaces/a', 'workspaces/../x', 'workspaces/./x', 'workspaces//x', './workspaces/x', 'other/x', 'workspaces/a\u0000b', 'run/agents', 'backups/x']) {
    assert.ok(!memberNameOk(bad), JSON.stringify(bad));
  }
});

test('the rehearsal child exits when the server goes away before sending a request', async () => {
  const child = spawn(process.execPath, [join(repo, 'server/src/rehearsal.ts')], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.end();
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
});

// ------------------------------------------------------------------ the owner's action

async function finished(t: Awaited<ReturnType<typeof startServer>>): Promise<RestoreRehearsal> {
  return until(async () => {
    const last = (await t.call<OperationsStatus>('GET', '/api/operations')).data.rehearsal.last;
    return last && last.outcome !== 'running' ? last : null;
  }, 30_000);
}

test('the owner rehearses the latest backup from the app: running, then passed, audited, without paths or error text', async () => {
  const home = realisticHome();
  backup({ home, now: new Date(Date.now() - 86_400_000) });
  const newest = nameOf(backup({ home }).dir);
  const t = await startServer({ home });
  const dbBefore = readdirSync(home).sort();

  const ops0 = (await t.call<OperationsStatus>('GET', '/api/operations')).data;
  assert.equal(ops0.rehearsal.last, null);
  assert.equal(ops0.rehearsal.limitPerHour, REHEARSAL_LIMIT);
  assert.deepEqual(ops0.restorableSchemas, [SCHEMA_VERSION - 1, SCHEMA_VERSION]);

  const started = await t.call<RestoreRehearsal>('POST', '/api/backups/rehearse', {});
  assert.equal(started.status, 202);
  assert.equal(started.data.backup, newest);
  assert.equal(started.data.outcome, 'running');

  const last = await finished(t);
  assert.equal(last.outcome, 'passed');
  assert.equal(last.problem, null);
  assert.equal(last.fromSchema, SCHEMA_VERSION);
  assert.equal(last.toSchema, SCHEMA_VERSION);
  assert.equal(last.workspaces, 'checked');
  assert.equal(last.files, 3);
  assert.equal(last.matchesManifest, true);
  assert.equal(last.ranBy.schema, SCHEMA_VERSION);
  assert.equal(last.ranBy.version, '0.1.0');
  assert.ok(Date.parse(last.finishedAt!) >= Date.parse(last.startedAt));

  const text = (await t.call('GET', '/api/operations')).text;
  assert.ok(!text.includes(home), 'no paths');
  assert.ok(!text.includes('/rehearsal'), 'not the work folder either');
  // The work folder is gone and the data folder is as it was (run/ aside, which the server keeps).
  assert.deepEqual(existsSync(join(home, 'run', 'rehearsal')) ? readdirSync(join(home, 'run', 'rehearsal')) : [], []);
  assert.deepEqual(readdirSync(home).sort(), dbBefore);

  const audit = (await t.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'backup.rehearsed');
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].target, { kind: 'backup', id: newest, label: '' });
  assert.equal(audit[0].actor.kind, 'device');
  assert.deepEqual(audit[0].details, { outcome: 'passed', problem: null, fromSchema: SCHEMA_VERSION, toSchema: SCHEMA_VERSION, workspaces: 'checked', matchesManifest: true });

  // An older one by name.
  const older = readdirSync(backupsOf(home)).sort()[0];
  assert.equal((await t.call('POST', '/api/backups/rehearse', { backup: older })).status, 202);
  assert.equal((await finished(t)).backup, older);
  await t.stop();
});

test('a failed rehearsal says why in a fixed word, and the server log line carries no path', async () => {
  const home = realisticHome();
  const { dir } = backup({ home });
  writeFileSync(join(dir, 'workspaces.tar.gz'), gzipSync(tarOf([{ name: 'workspaces/key', type: '2', link: '/home/you/.ssh/id_ed25519' }])));
  const t = await startServer({ home });
  assert.equal((await t.call('POST', '/api/backups/rehearse', { backup: 'latest' })).status, 202);
  const last = await finished(t);
  assert.equal(last.outcome, 'failed');
  assert.equal(last.problem, 'unsafe-archive');
  const logs = (await t.call('GET', '/api/logs?q=rehearsal')).data;
  assert.ok(logs.entries.some((e: { event: string }) => e.event === 'backup.rehearsal_failed'));
  assert.ok(!JSON.stringify(logs).includes('id_ed25519'));
  await t.stop();
});

test('rehearsals: refused bad names, missing backups and Boton tokens; one at a time; at most the hourly limit', async () => {
  const home = realisticHome();
  const t = await startServer({ home });
  assert.equal((await t.call('POST', '/api/backups/rehearse', {})).status, 404, 'no backup yet');
  backup({ home });
  for (const bad of ['../../etc', '/tmp/x', 'latest/..', 42]) assert.equal((await t.call('POST', '/api/backups/rehearse', { backup: bad })).status, 400, String(bad));
  assert.equal((await t.call('POST', '/api/backups/rehearse', { backup: stamp(new Date('2020-01-01T00:00:00.000Z')) })).status, 404);

  const bot = await t.newBot('Kevin');
  const boton = t.app.auth.mintBotonToken(bot.id);
  assert.equal((await t.call('POST', '/api/backups/rehearse', {}, boton.token)).status, 403);
  assert.equal((await t.call('GET', '/api/operations', undefined, boton.token)).status, 403);
  boton.revoke();

  const [a, b] = await Promise.all([t.call('POST', '/api/backups/rehearse', {}), t.call('POST', '/api/backups/rehearse', {})]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  await finished(t);
  for (let i = 1; i < REHEARSAL_LIMIT; i++) {
    assert.equal((await t.call('POST', '/api/backups/rehearse', {})).status, 202);
    await finished(t);
  }
  const limited = await t.call('POST', '/api/backups/rehearse', {});
  assert.equal(limited.status, 429);
  const audit = (await t.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'backup.rehearsed');
  assert.equal(audit.length, REHEARSAL_LIMIT);
  await t.stop();
});

test('a rehearsal past its time limit is stopped as timed out; one past the size limits is refused', async () => {
  const home = realisticHome();
  backup({ home });
  const t = await startServer({ home, appOptions: { tailnet: null, rehearsal: { timeoutMs: 1 } } });
  assert.equal((await t.call('POST', '/api/backups/rehearse', {})).status, 202);
  assert.equal((await finished(t)).problem, 'timed-out');
  await t.stop();
  const t2 = await startServer({ home, token: t.token, appOptions: { tailnet: null, rehearsal: { limits: { databaseBytes: 1024 } } } });
  assert.equal((await t2.call('POST', '/api/backups/rehearse', {})).status, 202);
  assert.equal((await finished(t2)).problem, 'database-too-large');
  await t2.stop();
});

test('a shutdown stops a running rehearsal as interrupted; a crash mid-way reads as interrupted after the restart, and its copy is removed', async () => {
  const home = realisticHome();
  backup({ home });
  const t = await startServer({ home });
  assert.equal((await t.call('POST', '/api/backups/rehearse', {})).status, 202);
  await t.stop();
  const t2 = await startServer({ home, token: t.token });
  const last = (await t2.call<OperationsStatus>('GET', '/api/operations')).data.rehearsal.last!;
  assert.equal(last.outcome, 'failed');
  assert.equal(last.problem, 'interrupted');
  assert.ok((await t2.call<AuditEvent[]>('GET', '/api/audit')).data.some((e) => e.action === 'backup.rehearsed' && e.details.problem === 'interrupted'));
  assert.equal(existsSync(join(home, 'run', 'rehearsal')), false);
  await t2.stop();

  // A crash: the record still says running, and a copy is left in the work folder.
  const db = new DatabaseSync(join(home, 'botons.db'));
  const record = { ...last, outcome: 'running', problem: null, finishedAt: null };
  db.prepare("update settings set value = ? where key = 'restoreRehearsal'").run(JSON.stringify(record));
  db.close();
  mkdirSync(join(home, 'run', 'rehearsal', 'r-left'), { recursive: true });
  writeFileSync(join(home, 'run', 'rehearsal', 'r-left', 'botons.db'), 'copy');
  const t3 = await startServer({ home, token: t.token });
  const after = (await t3.call<OperationsStatus>('GET', '/api/operations')).data.rehearsal.last!;
  assert.equal(after.outcome, 'failed');
  assert.equal(after.problem, 'interrupted');
  assert.equal(existsSync(join(home, 'run', 'rehearsal')), false);
  assert.equal(statSync(join(home, 'botons.db')).isFile(), true);
  // A rehearsal record that is not in its shape is not shown.
  t3.app.store.db.prepare("update settings set value = ? where key = 'restoreRehearsal'").run(JSON.stringify({ backup: '/home/you/x', outcome: 'passed', startedAt: now }));
  assert.equal((await t3.call<OperationsStatus>('GET', '/api/operations')).data.rehearsal.last, null);
  await t3.stop();
});
