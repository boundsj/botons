// Node builtins only: the server's start, scripts/deploy.ts, scripts/migrate-names.ts and the installer load this.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyLegacyEnv, CLI_NAMES, CONFIG_DIRS, DATA_DIRS, DB_FILE, earlierEnvNames, rewriteEnvText, SHARE_DIRS, UNITS } from '../../shared/legacy-names.mjs';
import { writeBackupUnits } from '../../scripts/install-backup-timer.ts';
import { readEnvFile, writeServiceUnit } from '../../scripts/install-service.ts';
import { type BackupResult, backup as makeBackup } from './backup.ts';
import { chooseHome, DEFAULT_HOME, isBotonsSetting } from './config.ts';
import { lockDataDir } from './lock.ts';

/*
 * Moves an install off the names Botons had before (shared/legacy-names.mjs, which this takes every such name
 * from). Part of that module: it goes when they go.
 *
 * - The data folder and the database file (upgradeDataFolder): on the server's first start, and in the upgrades
 *   below. Under the data folder's lock (a running server stops it), after a backup: the database is checkpointed
 *   and renamed, then the folder is renamed to ~/.botons (one rename(2), so it is there whole or not at all). Each
 *   earlier name is left as a link to the new one, so the earlier release, absolute paths in workspaces (git
 *   worktrees, virtualenvs, scripts) and anything else that names the old path keep working. Running it again
 *   finishes what an interruption left and changes nothing that is done.
 * - The service (upgradeService): from outside the server, which it stops and starts: `npm run deploy`, the
 *   installer and `npm run migrate:names`. The release root is renamed the same way; the env file is written anew
 *   under ~/.config/botons with each setting under its current name (the earlier file stays as it was, for the
 *   earlier unit); botons.service (and botons-backup.*) are written and started and the earlier units disabled.
 *   `undo` puts the earlier units back, which still work through the links.
 * - rollbackNames (`npm run migrate:names -- --rollback`) undoes all of it from the record the upgrade keeps in
 *   the data folder, and names the backup taken first.
 */

/** What the upgrade did, kept in the data folder for --rollback. */
export const RECORD = 'name-upgrade.json';

export interface NameRecord {
  at: string;
  /** The data folder's earlier path (now a link), when it was moved. */
  dataFrom?: string;
  /** Other earlier names that linked to it and now link to the new folder. */
  dataLinks?: string[];
  /** The database was renamed (and its earlier name left as a link). */
  db?: boolean;
  backupDir?: string | null;
  /** The release root's earlier path (now a link), when it was moved. */
  rootFrom?: string;
  rootTo?: string;
  /** The earlier units, now disabled, and whether this wrote the env file. */
  service?: { unit: string; backup: string | null; envFrom: string | null; envTo: string; wroteEnv: boolean; wrote: string[]; done?: boolean };
  /** When rollbackNames put it back under its earlier names: the server's own start leaves it so (see `explicit`). */
  rolledBack?: string;
}

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** `at` → `target` (a name in the same folder), replacing whatever link is at `at`, atomically. */
function linkAt(at: string, target: string): void {
  const tmp = `${at}.link-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, at);
}

export class NameUpgradeError extends Error {
  name = 'NameUpgradeError';
}

function readRecord(home: string): NameRecord | null {
  try {
    return JSON.parse(readFileSync(join(home, RECORD), 'utf8')) as NameRecord;
  } catch {
    return null;
  }
}

function writeRecord(home: string, patch: Partial<NameRecord>): void {
  const record: Record<string, unknown> = { ...(readRecord(home) ?? {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) record[k] = v;
  record.at = new Date().toISOString();
  writeFileSync(join(home, RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export interface DataUpgradeOptions {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  backup?: (home: string) => BackupResult;
  log?: (line: string) => void;
  /**
   * Asked for (migrate:names, deploy, the installer), not the server's own start: it moves a folder the owner
   * rolled back too. The server's start leaves one alone, since the release it runs is the one rolled back from.
   */
  explicit?: boolean;
}

export interface DataUpgradeResult {
  /** The data folder to use from now on. */
  home: string;
  moved: boolean;
  db: boolean;
  backupDir: string | null;
  lines: string[];
}

/** The earlier default data folder (its path under the user's home, a real folder) that `home` is, or null. */
function legacyDefault(home: string, userHome: string): string | null {
  const r = real(home);
  return DATA_DIRS.map((d) => join(userHome, d)).find((p) => lstat(p)?.isDirectory() && real(p) === r) ?? null;
}

/**
 * Folds everything in the WAL into the file itself and removes the empty side files, so the file alone is the whole
 * database and can be renamed. The caller holds the data folder's lock, so no other connection is open.
 */
function settleDb(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('pragma wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const wal = lstat(`${path}-wal`);
  if (wal && wal.size > 0) throw new NameUpgradeError(`${path}-wal still holds transactions after a checkpoint, so the database was not renamed. Nothing was changed.`);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

/**
 * Moves the data folder from an earlier default name to ~/.botons, and the database file from its earlier name,
 * as described above. Nothing to do: returns at once. Throws DataDirInUseError while a server holds the folder,
 * HomeConflictError when which folder is meant is unclear, NameUpgradeError when the backup fails (nothing changed).
 *
 * Each rename is preceded by a record of what it is about to do (in the folder, which moves with it), and every
 * start first finishes what such a record says an interrupted run left: the links at the earlier names.
 */
export function upgradeDataFolder(o: DataUpgradeOptions = {}): DataUpgradeResult {
  const env = o.env ?? process.env;
  const userHome = o.userHome ?? (env.HOME?.trim() || homedir());
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    o.log?.(line);
  };
  const target = join(userHome, DEFAULT_HOME);
  // Before anything chooses a folder, so an earlier name a stopped run left without its link isn't made anew.
  finishLinks(target, userHome, say);
  const choice = chooseHome(env, userHome);
  const from = !lstat(target) ? legacyDefault(choice.home, userHome) : null;
  const home = from ?? choice.home;
  const rolledBack = readRecord(home)?.rolledBack;
  if (rolledBack && !o.explicit) {
    say(`${home} was put back under its earlier names (${rolledBack}): left so until \`npm run migrate:names\` moves it again.`);
    return { home, moved: false, db: false, backupDir: null, lines };
  }
  if (rolledBack) {
    const record = readRecord(home) as unknown as Record<string, unknown>;
    delete record.rolledBack;
    writeFileSync(join(home, RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }
  finishDbLink(home, say);
  const oldDb = join(home, DB_FILE);
  const newDb = join(home, 'botons.db');
  const dbToMove = !!lstat(oldDb) && !lstat(oldDb)!.isSymbolicLink();
  if (!from && !dbToMove) return { home, moved: false, db: false, backupDir: null, lines };
  if (dbToMove && lstat(newDb)) throw new NameUpgradeError(`${home} has both ${DB_FILE} and botons.db, so which is this server's database is not clear. Move the one not in use away. Nothing was changed.`);

  const lock = lockDataDir(home);
  try {
    let backupDir: string | null = readRecord(home)?.backupDir ?? null;
    const dbNow = dbToMove ? oldDb : newDb;
    if (existsSync(dbNow) && !(backupDir && existsSync(backupDir))) {
      let made: BackupResult;
      try {
        made = (o.backup ?? ((h) => makeBackup({ home: h })))(home);
      } catch (err) {
        throw new NameUpgradeError(`The backup failed, so nothing was moved: ${(err as Error).message}`);
      }
      if (made.manifest.workspacesError) throw new NameUpgradeError(`The backup left the workspaces out, so nothing was moved: ${made.manifest.workspacesError}`);
      if (made.manifest.tarWarning) throw new NameUpgradeError(`The backup has an archive warning, so nothing was moved: ${made.manifest.tarWarning}`);
      backupDir = made.dir;
      say(`Backed up ${home} to ${backupDir}.`);
    }
    writeRecord(home, { backupDir });
    if (dbToMove) {
      settleDb(oldDb);
      writeRecord(home, { db: true });
      renameSync(oldDb, newDb);
      linkAt(oldDb, 'botons.db');
      say(`Renamed ${oldDb} to botons.db (the earlier name links to it).`);
    }
    let moved = false;
    if (from) {
      const links = DATA_DIRS.map((d) => join(userHome, d)).filter((p) => p !== from && lstat(p)?.isSymbolicLink() && real(p) === from);
      writeRecord(from, { dataFrom: from, dataLinks: links });
      try {
        renameSync(from, target);
        moved = true;
      } catch (err) {
        // Another file system (a mount of its own, say): the data stays where it is and ~/.botons links to it.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV' && (err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
        const record = (readRecord(from) ?? {}) as unknown as Record<string, unknown>;
        delete record.dataFrom;
        delete record.dataLinks;
        writeFileSync(join(from, RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        symlinkSync(from, target);
        say(`${from} is a mount of its own, so it stays where it is: ${target} links to it.`);
      }
      if (moved) {
        if (backupDir?.startsWith(`${from}/`)) {
          backupDir = target + backupDir.slice(from.length);
          writeRecord(target, { backupDir });
        }
        finishLinks(target, userHome, say);
        say(`Moved ${from} to ${target} (the earlier name links to it).`);
      }
    }
    return { home: moved ? target : home, moved, db: dbToMove, backupDir, lines };
  } finally {
    lock.release();
  }
}

/** The links a move leaves at the earlier names, made if an interruption left them out. A real folder that appeared at one is left alone (chooseHome refuses two). */
function finishLinks(target: string, userHome: string, say: (line: string) => void): void {
  if (!lstat(target)?.isDirectory() || lstat(target)!.isSymbolicLink()) return;
  const record = readRecord(target);
  if (!record?.dataFrom) return;
  for (const p of [record.dataFrom, ...(record.dataLinks ?? [])]) {
    const st = lstat(p);
    if (dirname(p) !== dirname(target) || (st && !st.isSymbolicLink()) || (st && readlinkSync(p) === basename(target))) continue;
    linkAt(p, basename(target));
    say(`Linked ${p} to ${target}.`);
  }
  finishDbLink(target, say);
}

/** The database's earlier name as a link to it, made if an interruption left it out. */
function finishDbLink(home: string, say: (line: string) => void): void {
  const oldDb = join(home, DB_FILE);
  if (!readRecord(home)?.db || lstat(oldDb) || !lstat(join(home, 'botons.db'))) return;
  linkAt(oldDb, 'botons.db');
  say(`Linked ${oldDb} to botons.db.`);
}

export interface ServiceUpgradeOptions {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  configHome?: string;
  unitDir?: string;
  /** systemctl and the like. */
  exec: (cmd: string, args: string[]) => Promise<void>;
  /** Start botons.service (else only write it and disable the earlier units: the caller starts it). */
  start?: boolean;
  backup?: DataUpgradeOptions['backup'];
  log?: (line: string) => void;
}

export interface LegacyService {
  /** The earlier server unit, and its backup unit's name if it has one. */
  unit: string;
  backup: string | null;
  unitFile: string;
  /** From the unit file: the app folder, the Node binary and the env file it runs with. */
  app: string | null;
  node: string | null;
  envFile: string | null;
}

/** The systemd user units folder. */
export const unitDirOf = (env: NodeJS.ProcessEnv, userHome: string) => join(env.XDG_CONFIG_HOME || join(userHome, '.config'), 'systemd', 'user');

/**
 * The environment the service runs with: the caller's when it names a data folder, else the service env file's
 * settings over it (as serverEnv does), each under its current name.
 */
function serviceEnv(env: NodeJS.ProcessEnv, envFile: string | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (!envFile || ['BOTONS_HOME', ...earlierEnvNames('BOTONS_HOME')].some((k) => env[k]?.trim())) return out;
  let file: Record<string, string>;
  try {
    file = readEnvFile(readFileSync(envFile, 'utf8'));
  } catch {
    return out;
  }
  applyLegacyEnv(file);
  for (const [k, v] of Object.entries(file)) if (isBotonsSetting(k)) out[k] = v;
  applyLegacyEnv(out);
  return out;
}

/**
 * The data folder the service uses, after an upgrade too: its env file can name one (the new env file first, then
 * the one an earlier unit reads, then one at an earlier default path), else the default.
 */
function serviceHome(env: NodeJS.ProcessEnv, userHome: string): string {
  const configHome = env.XDG_CONFIG_HOME || join(userHome, '.config');
  const unitDir = unitDirOf(env, userHome);
  const unitEnv = UNITS.map((u) => join(unitDir, `${u.service}.service`)).filter((f) => existsSync(f)).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^EnvironmentFile=-?(.*)$/gm)].map((m) => m[1].trim().replaceAll('%%', '%').replace(/^%h(?=\/)/, userHome)));
  const envFile = [join(configHome, 'botons', 'env'), ...unitEnv, ...CONFIG_DIRS.map((d) => join(configHome, d, 'env'))].find((p) => existsSync(p)) ?? null;
  return chooseHome(serviceEnv(env, envFile), userHome).home;
}

/** The record of a service handover in the data folder `env` names, if there is one. */
function handoverOf(env: NodeJS.ProcessEnv, userHome: string): NameRecord['service'] | null {
  try {
    return readRecord(chooseHome(env, userHome).home)?.service ?? null;
  } catch {
    return null;
  }
}

/**
 * An earlier server unit, read from its file, that hasn't been handed over to botons.service: none beside it, or a
 * handover its record says stopped part way. Null when there is none.
 */
export function findLegacyService(o: { env?: NodeJS.ProcessEnv; userHome?: string; unitDir?: string } = {}): LegacyService | null {
  const env = o.env ?? process.env;
  const userHome = o.userHome ?? (env.HOME?.trim() || homedir());
  const unitDir = o.unitDir ?? unitDirOf(env, userHome);
  const u = UNITS.find((x) => existsSync(join(unitDir, `${x.service}.service`)));
  if (!u) return null;
  const unitFile = join(unitDir, `${u.service}.service`);
  const text = readFileSync(unitFile, 'utf8');
  const value = (key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((m) => m[1].trim());
  const unescape = (s: string) => s.replaceAll('%%', '%').replace(/^%h(?=\/)/, userHome);
  const m = /^(?:"([^"]+)"|(\S+))\s+(?:"(.+)\/server\/src\/index\.ts"|(\S+)\/server\/src\/index\.ts)\s*$/.exec(value('ExecStart')[0] ?? '');
  const exec = m ? [m[0], m[1] ?? m[2], m[3] ?? m[4]] : null;
  const envFile = value('EnvironmentFile').map((v) => unescape(v.replace(/^-/, ''))).find((p) => existsSync(p)) ?? null;
  if (existsSync(join(unitDir, 'botons.service'))) {
    const handover = handoverOf(serviceEnv(env, envFile), userHome);
    if (!handover || handover.done || handover.unit !== u.service) return null;
  }
  return {
    unit: u.service,
    backup: existsSync(join(unitDir, `${u.backup}.timer`)) ? u.backup : null,
    unitFile,
    app: exec ? unescape(exec[2]) : (value('WorkingDirectory')[0] ? unescape(value('WorkingDirectory')[0]) : null),
    node: exec ? unescape(exec[1]) : null,
    envFile,
  };
}

/** The earlier env file: the one the earlier unit reads, else one at an earlier default path. */
function legacyEnvFile(found: LegacyService | null, configHome: string): string | null {
  if (found?.envFile) return found.envFile;
  return CONFIG_DIRS.map((d) => join(configHome, d, 'env')).find((p) => existsSync(p)) ?? null;
}

/** In a release root this moved: the earlier path it was moved from, written before the move. */
const ROOT_RECORD = '.name-upgrade-from';

/** A moved release root's earlier path, with its link made if an interruption left it out; null when it wasn't moved. */
function finishRoot(userHome: string, say: (line: string) => void): [string, string] | null {
  const to = join(userHome, '.local', 'share', 'botons');
  if (!lstat(to)?.isDirectory() || lstat(to)!.isSymbolicLink()) return null;
  let from: string;
  try {
    from = readFileSync(join(to, ROOT_RECORD), 'utf8').trim();
  } catch {
    return null;
  }
  if (dirname(from) !== dirname(to)) return null;
  const st = lstat(from);
  if (!st || (st.isSymbolicLink() && readlinkSync(from) !== basename(to))) {
    linkAt(from, basename(to));
    say(`Linked ${from} to ${to}.`);
  }
  return st && !st.isSymbolicLink() ? null : [from, to];
}

/** Renames the earlier release root to ~/.local/share/botons, leaving a link; returns [from, to] (also when an earlier run moved it), or null. */
function moveRoot(userHome: string, say: (line: string) => void): [string, string] | null {
  const share = join(userHome, '.local', 'share');
  const to = join(share, 'botons');
  if (lstat(to)) return finishRoot(userHome, say);
  const from = SHARE_DIRS.map((d) => join(share, d)).find((p) => lstat(p)?.isDirectory() && !lstat(p)!.isSymbolicLink());
  if (!from) return null;
  // Recorded inside it first (it moves with it), so a stop between the rename and the link is finished by the next run.
  writeFileSync(join(from, ROOT_RECORD), `${from}\n`);
  renameSync(from, to);
  linkAt(from, 'botons');
  say(`Moved ${from} to ${to} (the earlier name links to it).`);
  return [from, to];
}

/** `p` under `from` as the same path under `to`. */
const mapPath = (p: string, moves: [string, string][]) => {
  for (const [from, to] of moves) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
};

export interface ServiceUpgrade {
  lines: string[];
  /** Nothing was there to upgrade. */
  nothing: boolean;
  /** Stops and disables botons.service, removes what this wrote and starts the earlier unit again (the links keep its paths working). */
  undo: () => Promise<void>;
}

/**
 * Moves a service install off its earlier names, as described above. The earlier unit is stopped first and the
 * data folder moved while nothing holds it. On a failure part way, what was done is undone before it throws.
 */
export async function upgradeService(o: ServiceUpgradeOptions): Promise<ServiceUpgrade> {
  const env = o.env ?? process.env;
  const userHome = o.userHome ?? (env.HOME?.trim() || homedir());
  const configHome = o.configHome ?? (env.XDG_CONFIG_HOME || join(userHome, '.config'));
  const unitDir = o.unitDir ?? unitDirOf(env, userHome);
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    o.log?.(line);
  };
  // Before anything reads the earlier unit's paths: the release root's link, if a stopped run left it out.
  finishRoot(userHome, say);
  const found = findLegacyService({ env, userHome, unitDir });
  const envFrom = legacyEnvFile(found, configHome);
  const envTo = join(configHome, 'botons', 'env');
  // The data folder is the one the service uses, which its env file may name.
  const runEnv = serviceEnv(env, envFrom);
  const nothing = { lines, nothing: true, undo: async () => {} };
  if (!found) {
    // No unit (a checkout run by hand, or an install made with --no-service): the release root, the data folder and
    // the env file still move. The caller makes sure no server is running (the data folder's lock refuses one).
    const share = join(userHome, '.local', 'share');
    const rootToMove = !lstat(join(share, 'botons')) && SHARE_DIRS.some((d) => lstat(join(share, d))?.isDirectory() && !lstat(join(share, d))!.isSymbolicLink());
    if (!rootToMove && !(envFrom && !existsSync(envTo))) return nothing;
    const root = moveRoot(userHome, say);
    const data = upgradeDataFolder({ env: runEnv, userHome, backup: o.backup, log: say, explicit: true });
    if (root) rewriteMarker(root[1], [root, ...dataMoves(data)]);
    let wroteEnv = false;
    if (envFrom && !existsSync(envTo)) {
      writeEnv(envFrom, envTo, data, root);
      wroteEnv = true;
      say(`Wrote ${envTo} from ${envFrom}, each setting under its current name.`);
    }
    writeRecord(data.home, { rootFrom: root?.[0], rootTo: root?.[1], service: { unit: '', backup: null, envFrom, envTo, wroteEnv, wrote: [] } });
    return { lines, nothing: false, undo: async () => void (wroteEnv && rmSync(envTo, { force: true })) };
  }

  const wrote: string[] = [];
  let stopped = false;
  // Resuming a handover that stopped part way: what it had done already.
  const homeNow = chooseHome(runEnv, userHome).home;
  const prior = readRecord(homeNow)?.service;
  let wroteEnv = prior?.unit === found.unit ? prior.wroteEnv : false;
  const note = (home: string, patch: Partial<NonNullable<NameRecord['service']>>) =>
    writeRecord(home, { service: { unit: found.unit, backup: found.backup, envFrom, envTo, wroteEnv, wrote, done: false, ...patch } });
  const undo = async () => {
    for (const args of [['disable', '--now', 'botons.service'], ['disable', '--now', 'botons-backup.timer']]) await o.exec('systemctl', ['--user', ...args]).catch(() => {});
    for (const f of wrote) rmSync(f, { force: true });
    if (wroteEnv) rmSync(envTo, { force: true });
    await o.exec('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    if (stopped) {
      await o.exec('systemctl', ['--user', 'enable', '--now', `${found.unit}.service`]);
      if (found.backup) await o.exec('systemctl', ['--user', 'enable', '--now', `${found.backup}.timer`]);
      say(`Started ${found.unit}.service again.`);
    }
  };
  try {
    // Recorded before any unit changes, so a run that stops part way is found and finished by the next.
    if (existsSync(homeNow)) note(homeNow, {});
    say(`Stopping ${found.unit}.service to move it to botons.service`);
    await o.exec('systemctl', ['--user', 'stop', `${found.unit}.service`]);
    if (found.backup) await o.exec('systemctl', ['--user', 'stop', `${found.backup}.timer`]);
    stopped = true;
    const root = moveRoot(userHome, say);
    const data = upgradeDataFolder({ env: runEnv, userHome, backup: o.backup, log: say, explicit: true });
    const moves: [string, string][] = root ? [root] : [];
    if (root) rewriteMarker(root[1], [root, ...dataMoves(data)]);
    if (!existsSync(envTo)) {
      writeEnv(envFrom, envTo, data, root);
      wroteEnv = true;
      note(data.home, {});
      say(`Wrote ${envTo}${envFrom ? ` from ${envFrom}, each setting under its current name` : ''}.`);
    } else say(`Kept ${envTo}.`);
    const app = found.app ? mapPath(found.app, moves) : null;
    if (!app || !existsSync(join(app, 'server', 'src', 'index.ts'))) throw new NameUpgradeError(`${found.unitFile} does not name a Botons folder this can move to botons.service. Nothing more was changed.`);
    const node = found.node ? mapPath(found.node, moves) : undefined;
    writeRecord(data.home, { rootFrom: root?.[0], rootTo: root?.[1] });
    wrote.push(writeServiceUnit({ platform: 'linux', name: 'botons', app, envPath: envTo, unitDir, node, userHome, log: say }));
    if (found.backup) wrote.push(...writeBackupUnits({ platform: 'linux', app, unitDir, node, log: say }));
    note(data.home, {});
    await o.exec('systemctl', ['--user', 'daemon-reload']);
    await o.exec('systemctl', ['--user', 'disable', `${found.unit}.service`]);
    if (found.backup) await o.exec('systemctl', ['--user', 'disable', `${found.backup}.timer`]);
    if (o.start !== false) {
      await o.exec('systemctl', ['--user', 'enable', '--now', 'botons.service']);
      if (found.backup) await o.exec('systemctl', ['--user', 'enable', '--now', 'botons-backup.timer']);
      say(`Started botons.service; ${found.unit}.service is disabled (its file stays until the next release).`);
    }
    // Done (with start: false, the caller starts botons.service and can still undo).
    note(data.home, { done: true });
  } catch (err) {
    say(`The move to botons.service stopped part way: ${(err as Error).message}`);
    await undo();
    throw err;
  }
  return { lines, nothing: false, undo };
}

/** The data folder's earlier default paths that now link to it, as [earlier, current]. */
function dataMoves(data: DataUpgradeResult): [string, string][] {
  if (basename(data.home) !== DEFAULT_HOME) return [];
  return DATA_DIRS.map((d) => join(dirname(data.home), d)).filter((p) => lstat(p)?.isSymbolicLink() && real(p) === real(data.home)).map((p) => [p, data.home]);
}

/** The installer's own record of where things are (installer.json in its root), with moved paths as their new ones. */
function rewriteMarker(root: string, moves: [string, string][]): void {
  const marker = join(root, 'installer.json');
  if (!existsSync(marker)) return;
  const saved = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) if (typeof v === 'string') saved[k] = mapPath(v, moves);
  writeFileSync(marker, JSON.stringify(saved));
}

/** Writes the new env file from the earlier one (or an empty one), each setting under its current name and each moved path as its new one. */
function writeEnv(envFrom: string | null, envTo: string, data: DataUpgradeResult, root: [string, string] | null): void {
  const text = envFrom ? readFileSync(envFrom, 'utf8') : '';
  const moves: [string, string][] = [...(root ? [root] : []), ...dataMoves(data)];
  mkdirSync(dirname(envTo), { recursive: true, mode: 0o700 });
  writeFileSync(envTo, rewriteEnvText(text, moves), { mode: 0o600 });
}

/**
 * Undoes the service part of an upgrade made with `start: false` (the installer's, when what follows fails): the
 * earlier units are enabled and started again, and what it wrote is removed. Folders stay moved (their links work).
 */
export async function undoService(o: { env?: NodeJS.ProcessEnv; userHome?: string; exec: (cmd: string, args: string[]) => Promise<void>; log?: (line: string) => void }): Promise<void> {
  const env = o.env ?? process.env;
  const userHome = o.userHome ?? (env.HOME?.trim() || homedir());
  const home = serviceHome(env, userHome);
  const s = readRecord(home)?.service;
  if (!s?.unit) return;
  for (const args of [['disable', '--now', 'botons.service'], ['disable', '--now', 'botons-backup.timer']]) await o.exec('systemctl', ['--user', ...args]).catch(() => {});
  for (const f of s.wrote) rmSync(f, { force: true });
  if (s.wroteEnv) rmSync(s.envTo, { force: true });
  await o.exec('systemctl', ['--user', 'daemon-reload']);
  await o.exec('systemctl', ['--user', 'enable', '--now', `${s.unit}.service`]);
  if (s.backup) await o.exec('systemctl', ['--user', 'enable', '--now', `${s.backup}.timer`]);
  const record = readRecord(home)!;
  delete record.service;
  writeFileSync(join(home, RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  o.log?.(`Started ${s.unit}.service again.`);
}

export interface RollbackOptions {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  exec: (cmd: string, args: string[]) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Undoes the upgrade from its record: the earlier units started again (botons.service disabled and removed), the
 * release root, data folder and database back under their earlier names. The env file it wrote stays (the earlier
 * one was never changed). Says which backup was taken first, for a database a newer release has upgraded.
 */
export async function rollbackNames(o: RollbackOptions): Promise<string[]> {
  const env = o.env ?? process.env;
  const userHome = o.userHome ?? (env.HOME?.trim() || homedir());
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    o.log?.(line);
  };
  finishRoot(userHome, say);
  const home = serviceHome(env, userHome);
  const record = readRecord(home);
  if (!record) {
    say(`${home} has no record of a name upgrade: nothing to undo.`);
    return lines;
  }
  const s = record.service;
  if (s?.unit) {
    for (const args of [['disable', '--now', 'botons.service'], ['disable', '--now', 'botons-backup.timer']]) await o.exec('systemctl', ['--user', ...args]).catch(() => {});
    for (const f of s.wrote) rmSync(f, { force: true });
    await o.exec('systemctl', ['--user', 'daemon-reload']);
    say(`Removed botons.service${s.backup ? ' and botons-backup.*' : ''}.`);
  }
  // The env file the upgrade wrote names the new folders: set aside (edits kept), so the earlier one is what the
  // earlier unit and every admin command read again.
  if (s?.wroteEnv && existsSync(s.envTo)) {
    renameSync(s.envTo, `${s.envTo}.rolled-back`);
    say(`Set ${s.envTo} aside as ${s.envTo}.rolled-back; ${s.envFrom ?? 'the earlier settings'} is used again.`);
  }
  let backupDir = record.backupDir ?? null;
  const root: [string, string] | null = record.rootFrom && record.rootTo ? [record.rootFrom, record.rootTo] : finishRoot(userHome, say);
  const dataBack = record.dataFrom && lstat(record.dataFrom)?.isSymbolicLink() && real(record.dataFrom) === real(home) ? record.dataFrom : null;
  // The installer's record of where things are goes back first, while its folder is still where it says.
  const rootBack = root && lstat(root[0])?.isSymbolicLink() && lstat(root[1])?.isDirectory() ? root : null;
  const lock = lockDataDir(home);
  try {
    if (rootBack) rewriteMarker(rootBack[1], [[rootBack[1], rootBack[0]], ...(dataBack ? [[home, dataBack] as [string, string]] : [])]);
    if (record.db) {
      const oldDb = join(home, DB_FILE);
      if (lstat(oldDb)?.isSymbolicLink()) rmSync(oldDb);
      if (!lstat(oldDb)) {
        // A server that stopped uncleanly can leave transactions in botons.db-wal: into the file first.
        settleDb(join(home, 'botons.db'));
        renameSync(join(home, 'botons.db'), oldDb);
        say(`Renamed botons.db back to ${DB_FILE}.`);
      }
    }
    if (dataBack) {
      rmSync(dataBack);
      renameSync(home, dataBack);
      for (const p of record.dataLinks ?? []) if (lstat(p)?.isSymbolicLink()) linkAt(p, basename(dataBack));
      // What the server's start reads, so the release it runs doesn't move it straight back.
      writeFileSync(join(dataBack, RECORD), `${JSON.stringify({ rolledBack: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      if (backupDir) backupDir = mapPath(backupDir, [[home, dataBack]]);
      say(`Moved ${home} back to ${dataBack}.`);
    } else writeFileSync(join(home, RECORD), `${JSON.stringify({ rolledBack: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } finally {
    lock.release();
  }
  if (rootBack) {
    // Links that name the root by its new path (the installer's are absolute: current, previous, the command on
    // PATH) are pointed at the earlier one first, so the earlier unit and command run once it is back.
    const links = [join(rootBack[1], 'current'), join(rootBack[1], 'previous'), ...['botons', ...CLI_NAMES].map((n) => join(userHome, '.local', 'bin', n))];
    for (const l of links) {
      if (!lstat(l)?.isSymbolicLink()) continue;
      const target = readlinkSync(l);
      if (target.startsWith(`${rootBack[1]}/`)) linkAt(l, rootBack[0] + target.slice(rootBack[1].length));
    }
    rmSync(rootBack[0]);
    rmSync(join(rootBack[1], ROOT_RECORD), { force: true });
    renameSync(rootBack[1], rootBack[0]);
    say(`Moved ${rootBack[1]} back to ${rootBack[0]}.`);
  }

  if (s?.unit) {
    await o.exec('systemctl', ['--user', 'enable', '--now', `${s.unit}.service`]);
    if (s.backup) await o.exec('systemctl', ['--user', 'enable', '--now', `${s.backup}.timer`]);
    say(`Started ${s.unit}.service again.`);
  }
  if (backupDir && existsSync(backupDir)) say(`The backup taken before the upgrade is ${backupDir}: if a newer release has upgraded the database since, restore it with \`npm run restore -- ${backupDir}\`.`);
  return lines;
}

/** For doctor: what is still under an earlier name, as one line each (empty when nothing is). */
export function legacyLeftovers(o: { env?: NodeJS.ProcessEnv; userHome?: string } = {}): string[] {
  const env = o.env ?? process.env;
  const userHome = o.userHome ?? (env.HOME?.trim() || homedir());
  const out: string[] = [];
  const found = findLegacyService({ env, userHome });
  if (found) out.push(`The service still runs as ${found.unit}.service, a deprecated name: \`npm run migrate:names\` moves it to botons.service.`);
  let choice: ReturnType<typeof chooseHome> | null = null;
  try {
    choice = chooseHome(env, userHome);
  } catch {}
  const rolledBack = choice ? readRecord(choice.home)?.rolledBack : undefined;
  if (rolledBack) out.push(`The data folder was put back under its earlier names (${rolledBack}): \`npm run migrate:names\` moves it again.`);
  else if (choice?.source === 'legacy') out.push(`The data folder is still ${choice.home}, a deprecated name: the server's next start moves it to ~/${DEFAULT_HOME}.`);
  if (!rolledBack && choice && lstat(join(choice.home, DB_FILE)) && !lstat(join(choice.home, DB_FILE))!.isSymbolicLink()) out.push(`The database is still ${DB_FILE}, a deprecated name: the server's next start renames it botons.db.`);
  return out;
}
