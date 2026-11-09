import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { BackupStatus, BackupSummary } from '../../shared/types.ts';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../../shared/legacy-names.mjs';

export const KEEP_BACKUPS = 14;

/** The timer backs up daily, so a newest backup older than two days means it stopped. */
export const BACKUP_STALE_MS = 2 * 86_400_000;

/** How many of the newest backups the owner's status lists. */
export const BACKUPS_LISTED = KEEP_BACKUPS;

/** The folders of BOTONS_HOME archived besides the database (not run/, nor backups/). browser/ holds each Boton's browser profile. */
export const ARCHIVED_FOLDERS: readonly string[] = ['workspaces', 'shared', 'templates', 'browser'];

/**
 * Left out of a browser profile: Chromium's lock and version-marker links (a restore refuses links, and they name the old process) and
 * its caches and its own home folder, which it rebuilds. Cookies and site storage stay. An owner's handover profile
 * (browser/<boton>/handover) is never archived: it holds what the owner typed, and is deleted as the handover ends.
 */
const BROWSER_EXCLUDES = ['browser/*/handover', 'browser/*/home', 'browser/*/profile/Singleton*', 'browser/*/profile/RunningChromeVersion', 'browser/*/profile/*Cache*', 'browser/*/profile/Default/*Cache*', 'browser/*/profile/Default/Service Worker', 'browser/*/profile/Crashpad'];

/** A backup folder's name is its UTC time, so names sort oldest first. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** What a backup that died part-way leaves behind; group 1 is when it started. */
const PARTIAL_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.partial$/;

export const stamp = (d: Date = new Date()): string => d.toISOString().replace(/[:.]/g, '-');

/** Backups hold chat history and webhook keys. */
function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

interface BackupManifest {
  createdAt: string;
  schemaVersion: number;
  counts: Record<string, number>;
  workspaces: boolean;
  folders?: string[];
  tarWarning?: string;
  workspacesError?: string;
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
  removed: string[];
}

/** The database file in a data folder or a backup: botons.db, or its deprecated name until the upgrade renames it (shared/legacy-names.mjs). */
export function dbFileIn(dir: string): string {
  const now = join(dir, 'botons.db');
  if (existsSync(now)) return now;
  const old = join(dir, DB_FILE);
  return existsSync(old) ? old : now;
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * Back up `home` into backups/<time>/ (named only once complete), then keep the newest KEEP_BACKUPS.
 * If tar fails the database copy is still kept, and nothing is pruned so older backups with workspaces stay.
 */
export function backup(opts: { home: string; now?: Date }): BackupResult {
  const now = opts.now ?? new Date();
  const dbPath = dbFileIn(opts.home);
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  const backupsDir = privateDir(join(opts.home, 'backups'));
  const dir = join(backupsDir, stamp(now));
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  privateDir(partial);

  let manifest: BackupManifest;
  try {
    const snapshot = join(partial, 'botons.db');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('pragma busy_timeout = 5000');
      // A consistent single-file copy (VACUUM INTO reads one snapshot, WAL included), safe while the server writes.
      db.prepare('vacuum into ?').run(snapshot);
    } finally {
      db.close();
    }
    chmodSync(snapshot, 0o600);
    manifest = { createdAt: now.toISOString(), ...inspectSnapshot(snapshot), workspaces: false };

    const folders = ARCHIVED_FOLDERS.filter((f) => existsSync(join(opts.home, f)));
    if (folders.length) {
      const archive = join(partial, 'workspaces.tar.gz');
      // --ignore-failed-read: skip what this user cannot read (a Boton's chmod 000, a root-owned folder a container left).
      const excludes = folders.includes('browser') ? BROWSER_EXCLUDES.map((e) => `--exclude=${e}`) : [];
      const mac = process.platform === 'darwin' && /bsdtar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
      // BSD tar cannot ignore failed reads. Keep incomplete backups as failures, and omit metadata
      // that the portable restore format deliberately refuses (ACLs, xattrs and AppleDouble files).
      const options = mac ? ['--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags'] : ['--ignore-failed-read'];
      const tar = spawnSync('tar', [...options, ...excludes, '-czf', archive, '-C', opts.home, ...folders], { encoding: 'utf8' });
      const stderr = (tar.stderr ?? '').trim();
      // GNU tar exits 1 when a file changed while it was read; the archive is still good.
      if (!tar.error && (tar.status === 0 || (!mac && tar.status === 1)) && existsSync(archive)) {
        chmodSync(archive, 0o600);
        manifest.workspaces = true;
        manifest.folders = folders;
        if (stderr) manifest.tarWarning = stderr;
      } else {
        rmSync(archive, { force: true });
        manifest.workspacesError = tar.error
          ? `Could not run tar: ${tar.error.message}`
          : `tar failed (${tar.status === null ? `signal ${tar.signal}` : `exit ${tar.status}`})${stderr ? `: ${stderr}` : ''}`;
      }
    }

    writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(partial, dir);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  if (manifest.workspacesError) return { dir, manifest, removed: [] };

  // Only names this code makes are deleted: other files in backups/ always stay.
  const all = listBackups(backupsDir);
  const removed = all.slice(0, Math.max(0, all.length - KEEP_BACKUPS));
  for (const n of removed) rmSync(join(backupsDir, n), { recursive: true, force: true });
  // A younger partial backup may still be running.
  const dayAgo = stamp(new Date(now.getTime() - 86_400_000));
  for (const n of readdirSync(backupsDir)) {
    const started = PARTIAL_NAME.exec(n)?.[1];
    if (started && started < dayAgo) rmSync(join(backupsDir, n), { recursive: true, force: true });
  }
  return { dir, manifest, removed };
}

function inspectSnapshot(file: string): { schemaVersion: number; counts: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const problems = db.prepare('pragma integrity_check').all().map((r) => String(r.integrity_check));
    if (problems.join() !== 'ok') throw new Error(`The snapshot failed integrity_check: ${problems.slice(0, 5).join('; ')}`);
    const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all();
    const counts: Record<string, number> = {};
    for (const { name } of tables) counts[String(name)] = Number(db.prepare(`select count(*) as n from "${name}"`).get()!.n);
    return { schemaVersion: Number(db.prepare('pragma user_version').get()!.user_version), counts };
  } finally {
    db.close();
  }
}

/** When a backup folder's name says it was made, or NaN when the name is not a real UTC time (2026-99-99T…). */
export function backupTime(name: string): number {
  if (!BACKUP_NAME.test(name)) return Number.NaN;
  const at = Date.parse(name.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
  // Date.parse rolls some impossible dates over (02-30 → 03-02); a real stamp prints back to the same name.
  return Number.isFinite(at) && stamp(new Date(at)) === name ? at : Number.NaN;
}

/** The largest manifest.json the owner's view reads; the backup command writes a few KiB. */
export const MANIFEST_MAX_BYTES = 256 * 1024;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A backup folder's manifest, or null when it is missing, not a regular file (a FIFO, a device, a symlink), larger
 * than MANIFEST_MAX_BYTES or not JSON. Opens without following a link and without blocking, then checks the open
 * file itself, so a swap between the check and the read cannot make it block or read something else.
 */
export function readManifest(file: string): Partial<BackupManifest> | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MANIFEST_MAX_BYTES) return null;
    // Read at most one byte past the limit: the file may grow after fstat.
    const buf = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    if (n > MANIFEST_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(buf.subarray(0, n).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<BackupManifest>) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The manifest's createdAt when it is a canonical UTC time, else the folder name's: never the manifest's own text. */
function createdAt(manifest: Partial<BackupManifest>, name: string): string {
  const m = manifest.createdAt;
  if (typeof m === 'string' && ISO_TIME.test(m)) {
    const at = Date.parse(m);
    if (Number.isFinite(at) && new Date(at).toISOString() === m) return m;
  }
  return new Date(backupTime(name)).toISOString();
}

/**
 * What the owner sees of the backups: names, times, schema versions and whether workspaces were archived. Reads
 * only manifests, and never returns a path or a manifest's error text (tar's messages name files). Never throws:
 * when the backups folder cannot be listed (not a folder, no permission, removed while read) it says only that.
 */
export function backupStatus(opts: { backupsDir: string; dbExists: boolean; now?: number }): BackupStatus {
  const now = opts.now ?? Date.now();
  const base = { keep: KEEP_BACKUPS, staleAfterHours: BACKUP_STALE_MS / 3_600_000 };
  let entries: { name: string; dir: boolean }[];
  try {
    entries = readdirSync(opts.backupsDir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ...base, backups: [], total: 0, stale: true, partial: 0, unreadable: true };
    }
    entries = [];
  }
  // Real folders only: a symlink or file named like a backup is not one this code made.
  const names = entries
    .filter((e) => e.dir && Number.isFinite(backupTime(e.name)))
    .map((e) => e.name)
    .sort();
  const backups = names
    .slice(-BACKUPS_LISTED)
    .reverse()
    .map((name): BackupSummary => {
      const manifest = readManifest(join(opts.backupsDir, name, 'manifest.json')) ?? {};
      return {
        name,
        createdAt: createdAt(manifest, name),
        schemaVersion: typeof manifest.schemaVersion === 'number' && Number.isSafeInteger(manifest.schemaVersion) ? manifest.schemaVersion : null,
        workspaces: manifest.workspaces === true,
        workspacesFailed: typeof manifest.workspacesError === 'string',
      };
    });
  const newest = names.at(-1);
  return {
    ...base,
    backups,
    total: names.length,
    stale: newest ? now - backupTime(newest) > BACKUP_STALE_MS : opts.dbExists,
    partial: entries.filter((e) => PARTIAL_NAME.test(e.name)).length,
    unreadable: false,
  };
}

export function listBackups(backupsDir: string): string[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((n) => Number.isFinite(backupTime(n)))
    .sort();
}

/** What a restore puts back besides botons.db: the folders a backup archives, and the database's own side files. */
const RESTORED = ['botons.db', 'botons.db-wal', 'botons.db-shm', ...ARCHIVED_FOLDERS];
/** Set aside too: the database under its deprecated name (shared/legacy-names.mjs), so only the restored one is left. */
const SET_ASIDE = [...RESTORED, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`];

export interface RestorePlan {
  /** The backup folder. */
  from: string;
  schemaVersion: number;
  workspaces: boolean;
  /** The backup's database file (botons.db, or its deprecated name in a backup made before the rename). */
  db: string;
  /** What is in `home` now and gets moved to `setAside`. */
  moves: string[];
  setAside: string;
}

/**
 * Whether a restore by this code takes a backup at `version`: its own schema, or the one before (upgraded at the next
 * start). The restore command, the rehearsal and the owner's view all decide it here.
 */
export function restorable(version: number, maxSchema: number): 'ok' | 'newer' | 'older' {
  if (version > maxSchema) return 'newer';
  return version >= maxSchema - 1 && version > 0 ? 'ok' : 'older';
}

/** The schema versions a restore by this code takes, oldest first. */
export const restorableSchemas = (maxSchema: number): number[] => [maxSchema - 1, maxSchema].filter((v) => v > 0);

/** A backup by folder name (in <home>/backups), "latest", or a path. Throws if it is not a usable backup. */
export function planRestore(opts: { home: string; backup: string; now?: Date; maxSchema: number }): RestorePlan {
  const backupsDir = join(opts.home, 'backups');
  let from: string;
  if (opts.backup === 'latest') {
    const newest = listBackups(backupsDir).at(-1);
    if (!newest) throw new Error(`There is no backup in ${backupsDir}.`);
    from = join(backupsDir, newest);
  } else from = BACKUP_NAME.test(opts.backup) ? join(backupsDir, opts.backup) : resolve(opts.backup);
  const db = dbFileIn(from);
  if (!existsSync(db)) throw new Error(`${from} is not a backup: it has no botons.db.`);
  const { schemaVersion } = inspectSnapshot(db);
  const compat = restorable(schemaVersion, opts.maxSchema);
  if (compat === 'newer') {
    throw new Error(`The backup's database is at schema version ${schemaVersion}, newer than this code's ${opts.maxSchema}. Restore it with the release that made it.`);
  }
  if (compat === 'older') throw new Error(`Schema version ${schemaVersion} cannot be upgraded by this code; use a compatible release first.`);
  const archive = join(from, 'workspaces.tar.gz');
  const workspaces = existsSync(archive);
  if (workspaces) {
    // Read through once before anything moves, and unpack nothing but the folders a backup archives.
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (list.error || list.status !== 0) throw new Error(`${archive} cannot be read: ${list.error?.message ?? (list.stderr || `exit ${list.status}`).trim()}`);
    // Reject links and special files: their targets can cross isolation boundaries even when member names do not.
    const types = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    if (types.error || types.status !== 0 || types.stdout.split('\n').some((line) => line && !['-', 'd'].includes(line[0]))) {
      throw new Error(`${archive} contains links or special files; restore only regular files and directories.`);
    }
    const stray = list.stdout.split('\n').find((m) => m && !ARCHIVED_FOLDERS.some((f) => m === f || m.startsWith(`${f}/`)));
    if (stray !== undefined || /(^|\/)\.\.(\/|$)/m.test(list.stdout)) throw new Error(`${archive} holds ${stray ?? 'a ".." path'}, which a Botons backup never does.`);
  }
  return {
    from,
    schemaVersion,
    workspaces,
    db,
    moves: SET_ASIDE.filter((f) => existsSync(join(opts.home, f))),
    setAside: join(opts.home, `before-restore-${stamp(opts.now)}`),
  };
}

/**
 * Restore a backup into `home`, which no server may be using (the caller holds its lock). Nothing is deleted: what is
 * there now moves to plan.setAside first. If the restore fails part-way, what it unpacked is removed and the set-aside
 * state is moved back.
 */
export function restore(home: string, plan: RestorePlan): void {
  if (existsSync(plan.setAside)) throw new Error(`${plan.setAside} already exists`);
  // Prepare everything before moving originals. Restrictive archive permissions or failed extraction cannot
  // strand the active database, and installed paths can be rolled back with renames rather than recursive removal.
  const staging = mkdtempSync(join(home, '.restore-'));
  const present = SET_ASIDE.filter((f) => lstatOrNull(join(home, f)));
  const moved: string[] = [];
  const installed: string[] = [];
  let recoveryIncomplete = false;
  try {
    copyFileSync(plan.db, join(staging, 'botons.db'));
    chmodSync(join(staging, 'botons.db'), 0o600);
    if (plan.workspaces) {
      const tar = spawnSync('tar', ['-xzf', join(plan.from, 'workspaces.tar.gz'), '-C', staging, '--no-same-owner'], { encoding: 'utf8' });
      if (tar.error || tar.status !== 0) throw new Error(`Unpacking workspaces.tar.gz failed: ${tar.error?.message ?? (tar.stderr || `exit ${tar.status}`).trim()}`);
    }
    // A data folder with nothing in it yet (a new machine) has nothing to set aside.
    if (present.length) privateDir(plan.setAside);
    for (const f of present) {
      renameSync(join(home, f), join(plan.setAside, f));
      moved.push(f);
    }
    for (const f of RESTORED) if (existsSync(join(staging, f))) {
      renameSync(join(staging, f), join(home, f));
      installed.push(f);
    }
  } catch (err) {
    try {
      for (const f of installed) renameSync(join(home, f), join(staging, f));
      for (const f of moved) renameSync(join(plan.setAside, f), join(home, f));
      if (existsSync(plan.setAside)) rmSync(plan.setAside, { recursive: true });
    } catch (rollback) {
      recoveryIncomplete = true;
      throw new Error(`Restore failed: ${(err as Error).message}. Recovery incomplete: ${(rollback as Error).message}. Preserve ${plan.setAside} and ${staging} for manual recovery; do not start the server.`);
    }
    throw new Error(`Restore failed; original state preserved. ${(err as Error).message}`);
  } finally {
    // A hostile mode on an extracted directory can prevent cleanup. Keep the private staging folder for inspection.
    try { if (!recoveryIncomplete) rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}
