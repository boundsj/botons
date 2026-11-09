import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync, statfsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip } from 'node:zlib';
import type { RehearsalProblem, RehearsalWorkspaces } from '../../shared/types.ts';
import { ARCHIVED_FOLDERS, backupTime, dbFileIn, readManifest, restorable } from './backup.ts';
import { openSchema, SCHEMA_VERSION } from './schema.ts';

/*
 * A restore rehearsal: does this backup restore with this release? It copies the backup's database into a private
 * work folder (never BOTONS_HOME's own files), checks it, upgrades the copy to SCHEMA_VERSION as the server's next
 * start would, checks it again, and reads the whole workspaces archive through (gzip's checksum included), checking
 * every member as the restore does: only regular files and folders, only under the folders a backup archives,
 * no ".." and no absolute paths. It unpacks nothing and runs no other program: the archive is parsed here.
 *
 * It runs in a child process (rehearsals.ts starts it) with a small heap and a low priority, and prints one JSON
 * line: fixed words and counts only, never a path or an error's text. The backup is untrusted data: each file is
 * opened once without following links, checked through its open descriptor, and read only up to the limits.
 */

export interface RehearsalLimits {
  /** The backup's botons.db, at most. */
  databaseBytes: number;
  /** workspaces.tar.gz as stored, at most. */
  archiveBytes: number;
  /** The tar stream gunzip produces, every byte of it (headers, padding, what follows the end), at most: bounds the time spent reading it through. */
  unpackedBytes: number;
  /** Files and folders in the archive, at most. */
  members: number;
  /** Free space the work folder keeps beyond the copy and its journal. */
  spareBytes: number;
}

export const REHEARSAL_LIMITS: RehearsalLimits = {
  databaseBytes: 8 * 1024 ** 3,
  archiveBytes: 64 * 1024 ** 3,
  unpackedBytes: 256 * 1024 ** 3,
  members: 5_000_000,
  spareBytes: 256 * 1024 ** 2,
};

export interface RehearsalRequest {
  backupsDir: string;
  /** A backup folder's name: its UTC time. */
  name: string;
  /** An empty private folder for the copy; removed by whoever made it. */
  workDir: string;
  limits: RehearsalLimits;
}

export interface RehearsalResult {
  ok: boolean;
  problem: RehearsalProblem | null;
  fromSchema: number | null;
  toSchema: number | null;
  /** Whether the database's tables hold as many rows as its manifest says; null when the manifest has no counts. */
  matchesManifest: boolean | null;
  workspaces: RehearsalWorkspaces;
  files: number | null;
  folders: number | null;
  bytes: number | null;
}

class Refused extends Error {
  problem: RehearsalProblem;
  constructor(problem: RehearsalProblem) {
    super(problem);
    this.problem = problem;
  }
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const CHUNK = 1024 * 1024;

/** Opens a member of the backup folder: a regular file, not a link, not a FIFO or device; null when it is not there. */
function openMember(path: string): { fd: number; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // ELOOP: a symlink. A Botons backup holds none.
    throw new Refused(code === 'ELOOP' ? 'not-a-backup' : 'not-found');
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new Refused('not-a-backup');
  }
  return { fd, size: st.size };
}

/** The backup's folder: a real folder (not a link) directly in backupsDir, named as the backup command names it. */
function backupFolder(backupsDir: string, name: string): string {
  if (!Number.isFinite(backupTime(name))) throw new Refused('not-found');
  const dir = join(backupsDir, name);
  try {
    if (!lstatSync(dir).isDirectory()) throw new Refused('not-found');
    // Where it really is, so a parent swapped for a link after the check is noticed when the files are opened.
    if (realpathSync(dir) !== join(realpathSync(backupsDir), name)) throw new Refused('not-found');
  } catch (err) {
    if (err instanceof Refused) throw err;
    throw new Refused('not-found');
  }
  return dir;
}

function copyDatabase(src: { fd: number; size: number }, dest: string, limits: RehearsalLimits): void {
  if (src.size > limits.databaseBytes) throw new Refused('database-too-large');
  if (src.size < 512) throw new Refused('not-a-backup');
  try {
    const fs = statfsSync(join(dest, '..'));
    // The copy, then as much again for the upgrade's journal at worst.
    if (fs.bavail * fs.bsize < src.size * 2 + limits.spareBytes) throw new Refused('no-space');
  } catch (err) {
    if (err instanceof Refused) throw err;
  }
  const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    // No further than fstat said, even if the file grows meanwhile.
    while (pos < src.size) {
      const got = readSync(src.fd, buf, 0, Math.min(CHUNK, src.size - pos), pos);
      if (got === 0) break;
      if (pos === 0 && !buf.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw new Refused('not-a-backup');
      writeSync(out, buf, 0, got);
      pos += got;
    }
    if (pos !== src.size) throw new Refused('damaged-database');
  } catch (err) {
    if (err instanceof Refused) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new Refused(code === 'ENOSPC' || code === 'EDQUOT' ? 'no-space' : 'failed');
  } finally {
    closeSync(out);
  }
}

const integrityOk = (db: DatabaseSync): boolean => {
  const rows = db.prepare('pragma integrity_check(1)').all();
  return rows.length === 1 && rows[0].integrity_check === 'ok';
};

function countRows(db: DatabaseSync): Map<string, number> {
  const counts = new Map<string, number>();
  const tables = db.prepare("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'").all();
  for (const { name } of tables) counts.set(String(name), Number(db.prepare(`select count(*) as n from "${String(name).replaceAll('"', '""')}"`).get()!.n));
  return counts;
}

/** The tables every Botons database has had in each version restore takes. */
const CORE_TABLES = ['settings', 'bots', 'messages', 'routines', 'audit_events'];

function rehearseDatabase(copy: string, manifestCounts: Record<string, unknown> | null): Pick<RehearsalResult, 'fromSchema' | 'toSchema' | 'matchesManifest'> {
  let db: DatabaseSync;
  try {
    // defensive: the file is untrusted, so no writes to the schema table, no shadow tables and no double-quoted strings.
    db = new DatabaseSync(copy, { defensive: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });
  } catch {
    throw new Refused('damaged-database');
  }
  try {
    try {
      // Functions with side effects never run from the file's own views or triggers.
      db.exec('pragma trusted_schema = off; pragma cell_size_check = on;');
      if (!integrityOk(db)) throw new Refused('damaged-database');
    } catch (err) {
      if (err instanceof Refused) throw err;
      throw new Refused('damaged-database');
    }
    const fromSchema = Number(db.prepare('pragma user_version').get()!.user_version);
    const counts = countRows(db);
    if (!CORE_TABLES.every((t) => counts.has(t))) throw new Refused('not-a-backup');
    let matchesManifest: boolean | null = null;
    if (manifestCounts) {
      const entries = Object.entries(manifestCounts);
      matchesManifest = entries.length === counts.size && entries.every(([t, n]) => counts.get(t) === n);
    }
    const compat = restorable(fromSchema, SCHEMA_VERSION);
    if (compat !== 'ok') return failWith(compat === 'newer' ? 'newer-schema' : 'older-schema', { fromSchema, toSchema: null, matchesManifest });
    try {
      openSchema(db);
      if (!integrityOk(db)) throw new Error('integrity');
    } catch {
      return failWith('upgrade-failed', { fromSchema, toSchema: null, matchesManifest });
    }
    const toSchema = Number(db.prepare('pragma user_version').get()!.user_version);
    if (toSchema !== SCHEMA_VERSION) return failWith('upgrade-failed', { fromSchema, toSchema, matchesManifest });
    return { fromSchema, toSchema, matchesManifest };
  } finally {
    db.close();
  }
}

/** Carries what was learned before the refusal out with it. */
class RefusedWith extends Refused {
  partial: Partial<RehearsalResult>;
  constructor(problem: RehearsalProblem, partial: Partial<RehearsalResult>) {
    super(problem);
    this.partial = partial;
  }
}
function failWith(problem: RehearsalProblem, partial: Partial<RehearsalResult>): never {
  throw new RefusedWith(problem, partial);
}

// ------------------------------------------------------------------ the archive

/** A member name in the archive as the restore accepts it: under an archived folder, no "..", no control characters. */
export function memberNameOk(name: string): boolean {
  if (!name || name.startsWith('/') || /[\u0000-\u001f\u007f]/.test(name)) return false;
  const parts = name.replace(/\/+$/, '').split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return false;
  return ARCHIVED_FOLDERS.includes(parts[0]);
}

const BLOCK = 512;

function octal(field: Buffer): number {
  // GNU base-256 for sizes of 8 GiB and more: the first byte's top bit is set.
  if (field[0] & 0x80) {
    if (field[0] !== 0x80) return Number.NaN;
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return Number.isSafeInteger(n) ? n : Number.NaN;
  }
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : text === '' ? 0 : Number.NaN;
}

/**
 * A numeric header field GNU tar reads without complaint: octal text, or base-256 (0x80 positive, 0xff negative, as
 * GNU tar writes times before 1970). Mode, uid, gid and mtime are checked so; tar -t refuses a member whose are not.
 */
function numericFieldOk(field: Buffer, min: bigint, max: bigint): boolean {
  let value: bigint;
  if (field[0] & 0x80) {
    // The top bit marks binary encoding; the remaining bits are a signed two's-complement value.
    value = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i++) value = value * 256n + BigInt(field[i]);
    if (field[0] & 0x40) value -= 1n << BigInt(field.length * 8 - 1);
  } else {
    const n = octal(field);
    if (!Number.isSafeInteger(n)) return false;
    value = BigInt(n);
  }
  return value >= min && value <= max;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UID_MAX = 2n ** 32n - 1n;

/** An unsigned decimal pax value in 0..max, as GNU tar reads it: digits only, no sign, no spaces. */
function paxUnsigned(value: string, max: bigint): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  const n = BigInt(value);
  return n <= max ? n : null;
}

/** A pax time as GNU tar reads it: an optional "-", digits, then optionally "." and digits; whole seconds in int64. */
function paxTimeOk(value: string): boolean {
  const m = /^(-?\d+)(?:\.\d*)?$/.exec(value);
  if (!m) return false;
  const n = BigInt(m[1]);
  return n >= INT64_MIN && n <= INT64_MAX;
}

/**
 * The pax keys a member may carry, and how each value must read. This is stricter than GNU tar on purpose: tar
 * ignores keys it does not know (with a warning) and applies some (xattrs, ACLs, sparse maps, link targets) that a
 * Botons backup never needs, so any key not listed here is refused rather than guessed at. GNU tar's own pax format
 * writes only path, size, mtime, atime, ctime, uid, gid, uname and gname for regular files and folders; its default
 * format, which the backup uses, writes no pax headers at all.
 */
const PAX_KEYS: Record<string, (value: string) => boolean> = {
  path: () => true,
  size: (v) => paxUnsigned(v, INT64_MAX) !== null,
  mtime: paxTimeOk,
  atime: paxTimeOk,
  ctime: paxTimeOk,
  uid: (v) => paxUnsigned(v, UID_MAX) !== null,
  gid: (v) => paxUnsigned(v, UID_MAX) !== null,
  uname: () => true,
  gname: () => true,
  comment: () => true,
  charset: () => true,
};

function checksumOk(h: Buffer): boolean {
  const stored = octal(h.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === stored;
}

const cString = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString('utf8');
};

/** A pax extended header's records ("<len> key=value\n"), or null when one is malformed. */
function paxRecords(data: Buffer): Map<string, string> | null {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    if (data[i] === 0) break;
    const space = data.indexOf(0x20, i);
    if (space === -1) return null;
    const digits = data.subarray(i, space).toString('latin1');
    // Decimal digits only, as tar reads them ("0x1e", " 30" and "3e1" are not lengths).
    const len = /^\d{1,8}$/.test(digits) ? Number(digits) : Number.NaN;
    if (!Number.isSafeInteger(len) || len <= space - i + 1 || i + len > data.length || data[i + len - 1] !== 0x0a) return null;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq < 1) return null;
    const key = record.slice(0, eq);
    // Duplicate attributes can hide an earlier error that GNU tar still refuses.
    if (out.has(key)) return null;
    out.set(key, record.slice(eq + 1));
    i += len;
  }
  return out;
}

/** The largest pax or GNU long-name block kept in memory. */
const META_MAX = 64 * 1024;

/**
 * Reads a tar stream through and checks each member. Regular files ('0', or NUL in old archives) and folders ('5')
 * only; GNU long names ('L') and pax headers ('x') only as they describe the next member, with only the pax keys in
 * PAX_KEYS. Any other type (links, devices, FIFOs, sparse files, global pax headers) is refused, as the restore
 * refuses it, and so is anything tar -t would fail on: a malformed pax value or numeric header field.
 */
export class TarChecker {
  #limits: Pick<RehearsalLimits, 'unpackedBytes' | 'members'>;
  #header = Buffer.alloc(BLOCK);
  #headerFill = 0;
  /** Data bytes of the current entry still to come, then the padding to the next block. */
  #skip = 0;
  #meta: { kind: 'L' | 'x'; buf: Buffer; fill: number } | null = null;
  #longName: string | null = null;
  #pax: Map<string, string> | null = null;
  #zeroBlocks = 0;
  ended = false;
  files = 0;
  folders = 0;
  /** What the regular files hold: the count reported. */
  bytes = 0;
  /** Everything gunzip produced: headers, pax and long-name data, padding, the end marker and what follows it. */
  streamed = 0;

  constructor(limits: Pick<RehearsalLimits, 'unpackedBytes' | 'members'>) {
    this.#limits = limits;
  }

  write(chunk: Buffer): void {
    // The budget is the whole tar stream, counted before any of it is parsed: zero padding, pax and long-name
    // blocks and the space after the end marker cost reading time as file data does, so none of them is free.
    this.streamed += chunk.length;
    if (this.streamed > this.#limits.unpackedBytes) throw new Refused('archive-too-large');
    let i = 0;
    while (i < chunk.length) {
      if (this.ended) {
        // After the end marker only zero padding may follow (tar pads to its record size).
        for (; i < chunk.length; i++) if (chunk[i] !== 0) throw new Refused('damaged-archive');
        return;
      }
      if (this.#skip > 0) {
        const n = Math.min(this.#skip, chunk.length - i);
        if (this.#meta) {
          const room = this.#meta.buf.length - this.#meta.fill;
          chunk.copy(this.#meta.buf, this.#meta.fill, i, i + Math.min(n, room));
          this.#meta.fill += Math.min(n, room);
        }
        this.#skip -= n;
        i += n;
        if (this.#skip === 0 && this.#meta) this.#endMeta();
        continue;
      }
      const n = Math.min(BLOCK - this.#headerFill, chunk.length - i);
      chunk.copy(this.#header, this.#headerFill, i, i + n);
      this.#headerFill += n;
      i += n;
      if (this.#headerFill === BLOCK) {
        this.#headerFill = 0;
        this.#onHeader(this.#header);
      }
    }
  }

  /** The stream ended: it must have ended at the archive's end marker, with no pax or long name left over. */
  end(): void {
    if (!this.ended || this.#skip > 0 || this.#headerFill > 0 || this.#meta || this.#longName !== null || this.#pax !== null) throw new Refused('damaged-archive');
  }

  #onHeader(h: Buffer): void {
    if (h.every((b) => b === 0)) {
      // Two zero blocks end the archive; GNU tar writes both.
      if (++this.#zeroBlocks === 2) this.ended = true;
      return;
    }
    if (this.#zeroBlocks) throw new Refused('damaged-archive');
    if (!checksumOk(h)) throw new Refused('damaged-archive');
    // mode, uid, gid, mtime: tar -t fails on a member whose fields are not numbers, so the rehearsal does too.
    if (!numericFieldOk(h.subarray(100, 108), 0n, UID_MAX) || !numericFieldOk(h.subarray(108, 116), 0n, UID_MAX) ||
        !numericFieldOk(h.subarray(116, 124), 0n, UID_MAX) || !numericFieldOk(h.subarray(136, 148), INT64_MIN, INT64_MAX)) throw new Refused('damaged-archive');
    const type = String.fromCharCode(h[156]);
    let size = octal(h.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0) throw new Refused('damaged-archive');
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L' || type === 'x') {
      if (this.#meta || size > META_MAX || (type === 'L' && this.#longName !== null) || (type === 'x' && this.#pax !== null)) throw new Refused('unsafe-archive');
      this.#meta = { kind: type, buf: Buffer.alloc(size), fill: 0 };
      this.#skip = padded;
      if (padded === 0) this.#endMeta();
      return;
    }
    if (type !== '0' && type !== '\0' && type !== '5') throw new Refused('unsafe-archive');

    // Only POSIX ustar headers ("ustar\0") have a name prefix; in GNU headers ("ustar  \0") those bytes are other
    // fields, and tar names the member without them.
    const posix = h.subarray(257, 263).equals(Buffer.from('ustar\0', 'latin1'));
    const prefix = posix ? cString(h.subarray(345, 500)) : '';
    let name = this.#longName ?? (prefix ? `${prefix}/${cString(h.subarray(0, 100))}` : cString(h.subarray(0, 100)));
    if (this.#pax) {
      for (const [key, value] of this.#pax) {
        const check = Object.hasOwn(PAX_KEYS, key) ? PAX_KEYS[key] : null;
        if (!check) throw new Refused('unsafe-archive');
        if (!check(value)) throw new Refused('damaged-archive');
      }
      const path = this.#pax.get('path');
      if (path !== undefined) name = path;
      const paxSize = this.#pax.get('size');
      if (paxSize !== undefined) {
        // In int64 (checked above); past what a number holds exactly is past any limit too.
        const n = BigInt(paxSize);
        if (n > BigInt(this.#limits.unpackedBytes)) throw new Refused('archive-too-large');
        size = Number(n);
      }
    }
    this.#longName = null;
    this.#pax = null;
    if (!memberNameOk(name)) throw new Refused('unsafe-archive');
    if (type === '5') {
      this.folders++;
    } else {
      this.files++;
      this.bytes += size;
    }
    if (this.files + this.folders > this.#limits.members || this.bytes > this.#limits.unpackedBytes) throw new Refused('archive-too-large');
    this.#skip = type === '5' ? 0 : Math.ceil(size / BLOCK) * BLOCK;
  }

  #endMeta(): void {
    const meta = this.#meta!;
    this.#meta = null;
    if (meta.fill !== meta.buf.length) throw new Refused('damaged-archive');
    if (meta.kind === 'L') this.#longName = cString(meta.buf);
    else {
      const records = paxRecords(meta.buf);
      if (!records) throw new Refused('damaged-archive');
      this.#pax = records;
    }
  }
}

/**
 * Takes `src.fd` over: the read stream closes it (destroying a stream closes its fd whatever autoClose says), and
 * this returns or throws only once it is closed, so the number is never closed twice after something reuses it.
 */
async function rehearseArchive(src: { fd: number; size: number }, limits: RehearsalLimits): Promise<Pick<RehearsalResult, 'files' | 'folders' | 'bytes'>> {
  // end is inclusive; reading stops where fstat said the file ended.
  const input = createReadStream('', { fd: src.fd, autoClose: true, start: 0, end: Math.max(0, src.size - 1), highWaterMark: CHUNK });
  const closed = new Promise<void>((resolve) => input.once('close', () => resolve()));
  if (src.size > limits.archiveBytes) {
    input.destroy();
    await closed;
    throw new Refused('archive-too-large');
  }
  const checker = new TarChecker(limits);
  await new Promise<void>((resolve, reject) => {
    const gunzip = createGunzip({ chunkSize: 64 * 1024 });
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      input.destroy();
      gunzip.destroy();
      void closed.then(() => reject(err instanceof Refused ? err : new Refused('damaged-archive')));
    };
    input.on('error', fail);
    gunzip.on('error', fail);
    gunzip.on('data', (chunk: Buffer) => {
      // Nothing more is parsed once the checker has refused (or the limit is reached).
      if (failed) return;
      try {
        checker.write(chunk);
      } catch (err) {
        fail(err);
      }
    });
    gunzip.on('end', () => {
      if (failed) return;
      try {
        checker.end();
        input.destroy();
        void closed.then(() => resolve());
      } catch (err) {
        fail(err);
      }
    });
    input.pipe(gunzip);
  });
  return { files: checker.files, folders: checker.folders, bytes: checker.bytes };
}

/** The rehearsal itself. Never throws: every outcome is a result with a fixed problem word. */
export async function rehearse(req: RehearsalRequest): Promise<RehearsalResult> {
  const result: RehearsalResult = { ok: false, problem: null, fromSchema: null, toSchema: null, matchesManifest: null, workspaces: 'not-checked', files: null, folders: null, bytes: null };
  const open: number[] = [];
  const copy = join(req.workDir, 'botons.db');
  try {
    const dir = backupFolder(req.backupsDir, req.name);
    // Open both before reading either, so the backup's own pruning can't take one away between the steps.
    const db = openMember(dbFileIn(dir));
    if (!db) throw new Refused('not-a-backup');
    open.push(db.fd);
    const archive = openMember(join(dir, 'workspaces.tar.gz'));
    if (archive) open.push(archive.fd);
    const manifest = readManifest(join(dir, 'manifest.json'));
    const counts = manifest?.counts && typeof manifest.counts === 'object' && !Array.isArray(manifest.counts) ? (manifest.counts as Record<string, unknown>) : null;

    copyDatabase(db, copy, req.limits);
    Object.assign(result, rehearseDatabase(copy, counts));
    rmSync(copy, { force: true });
    for (const side of ['-journal', '-wal', '-shm']) rmSync(`${copy}${side}`, { force: true });

    if (archive) {
      open.splice(open.indexOf(archive.fd), 1);
      Object.assign(result, await rehearseArchive(archive, req.limits));
      result.workspaces = 'checked';
    } else {
      result.workspaces = 'none';
    }
    result.ok = true;
  } catch (err) {
    if (err instanceof RefusedWith) Object.assign(result, err.partial);
    result.problem = err instanceof Refused ? err.problem : 'failed';
  } finally {
    for (const fd of open) {
      try {
        closeSync(fd);
      } catch {}
    }
    for (const side of ['', '-journal', '-wal', '-shm']) rmSync(`${copy}${side}`, { force: true });
  }
  return result;
}

// ------------------------------------------------------------------ as a child process

/** Reads one JSON request line from stdin, rehearses, prints one JSON line. Exits as soon as stdin closes: the server went away. */
async function main(): Promise<void> {
  let input = '';
  let started = false;
  let workDir: string | null = null;
  const cleanUp = () => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  };
  process.on('exit', cleanUp);
  process.stdin.setEncoding('utf8');
  process.stdin.on('end', () => process.exit(started ? 3 : 2));
  process.stdin.on('data', (chunk: string) => {
    if (started) return;
    input += chunk;
    if (input.length > 64 * 1024) process.exit(2);
    const nl = input.indexOf('\n');
    if (nl === -1) return;
    started = true;
    const req = JSON.parse(input.slice(0, nl)) as RehearsalRequest;
    workDir = req.workDir;
    void rehearse(req).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void main();
