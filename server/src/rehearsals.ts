import { type ChildProcess, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { RehearsalProblem, RehearsalStatus, RehearsalWorkspaces, RestoreRehearsal } from '../../shared/types.ts';
import { buildSha, versionNumber } from '../../shared/util.ts';
import type { Audit, AuditActor } from './audit.ts';
import type { Principal } from './auth.ts';
import { backupTime, listBackups } from './backup.ts';
import { log } from './log.ts';
import { REHEARSAL_LIMITS, type RehearsalLimits, type RehearsalRequest } from './rehearsal.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { HttpError } from './store.ts';
import { nowIso, parseJson } from './util.ts';

/*
 * Settings → Health and backups → Rehearse a restore. The work runs in a child process (rehearsal.ts) so a large
 * database or archive never blocks the server: one at a time, at most REHEARSAL_LIMIT an hour, under a low priority,
 * a small heap and REHEARSAL_TIMEOUT_MS, with an environment that holds no credentials. Its copy lives in
 * <home>/run/rehearsal/, which nothing else uses and which is emptied at every start. The result is kept in the
 * settings table (fixed words, counts, times, versions) and each finished rehearsal is in the audit log.
 */

/** Rehearsals allowed per hour from the app. */
export const REHEARSAL_LIMIT = 6;
const REHEARSAL_WINDOW_MS = 3_600_000;
export const REHEARSAL_TIMEOUT_MS = 30 * 60_000;
/** The child's heap, in MiB: it streams the archive and lets SQLite read the copy, so it needs little. */
const CHILD_HEAP_MB = 256;
const CHILD = fileURLToPath(new URL('./rehearsal.ts', import.meta.url));
const SETTING = 'restoreRehearsal';

const PROBLEMS: ReadonlySet<string> = new Set<RehearsalProblem>([
  'not-found',
  'not-a-backup',
  'database-too-large',
  'no-space',
  'damaged-database',
  'newer-schema',
  'older-schema',
  'upgrade-failed',
  'damaged-archive',
  'unsafe-archive',
  'archive-too-large',
  'timed-out',
  'interrupted',
  'failed',
]);
const WORKSPACES: ReadonlySet<string> = new Set<RehearsalWorkspaces>(['checked', 'none', 'not-checked']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const schemaOf = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 1_000_000 ? v : null);
const time = (v: unknown): string | null => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null);

/** What the child printed, or what the settings row holds, kept only field by field in its expected shape. */
function outcomeFields(raw: Record<string, unknown>): Pick<RestoreRehearsal, 'problem' | 'fromSchema' | 'toSchema' | 'matchesManifest' | 'workspaces' | 'files' | 'folders' | 'bytes'> {
  return {
    problem: typeof raw.problem === 'string' && PROBLEMS.has(raw.problem) ? (raw.problem as RehearsalProblem) : null,
    fromSchema: schemaOf(raw.fromSchema),
    toSchema: schemaOf(raw.toSchema),
    matchesManifest: typeof raw.matchesManifest === 'boolean' ? raw.matchesManifest : null,
    workspaces: typeof raw.workspaces === 'string' && WORKSPACES.has(raw.workspaces) ? (raw.workspaces as RehearsalWorkspaces) : 'not-checked',
    files: count(raw.files),
    folders: count(raw.folders),
    bytes: count(raw.bytes),
  };
}

function stored(raw: unknown): RestoreRehearsal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const startedAt = time(r.startedAt);
  if (typeof r.backup !== 'string' || !Number.isFinite(backupTime(r.backup)) || !startedAt) return null;
  const outcome = r.outcome === 'running' || r.outcome === 'passed' || r.outcome === 'failed' ? r.outcome : null;
  if (!outcome) return null;
  const by = (r.ranBy && typeof r.ranBy === 'object' ? r.ranBy : {}) as Record<string, unknown>;
  const fields = outcomeFields(r);
  return {
    backup: r.backup,
    startedAt,
    finishedAt: time(r.finishedAt),
    outcome,
    ...fields,
    problem: outcome === 'failed' ? (fields.problem ?? 'failed') : null,
    ranBy: { version: versionNumber(typeof by.version === 'string' ? by.version : null), build: buildSha(typeof by.build === 'string' ? by.build : null), schema: schemaOf(by.schema) ?? 0 },
  };
}

interface Running {
  rehearsal: RestoreRehearsal;
  child: ChildProcess;
  actor: AuditActor;
  workDir: string;
  /** Set when the server is closing or the time ran out, so the end says why. */
  stopReason: RehearsalProblem | null;
  done: Promise<void>;
}

export class RestoreRehearsals {
  #db: DatabaseSync;
  #audit: Audit;
  #backupsDir: string;
  #workRoot: string;
  #ranBy: RestoreRehearsal['ranBy'];
  #limits: RehearsalLimits;
  #timeoutMs: number;
  #running: Running | null = null;
  #starts: number[] = [];
  #closing = false;

  constructor(opts: {
    db: DatabaseSync;
    audit: Audit;
    home: string;
    backupsDir: string;
    version: string;
    build: string | null;
    limits?: Partial<RehearsalLimits>;
    timeoutMs?: number;
  }) {
    this.#db = opts.db;
    this.#audit = opts.audit;
    this.#backupsDir = opts.backupsDir;
    this.#workRoot = join(opts.home, 'run', 'rehearsal');
    this.#ranBy = { version: versionNumber(opts.version), build: buildSha(opts.build), schema: SCHEMA_VERSION };
    this.#limits = { ...REHEARSAL_LIMITS, ...opts.limits };
    this.#timeoutMs = opts.timeoutMs ?? REHEARSAL_TIMEOUT_MS;
    // A copy left by a rehearsal that a crash cut off. Only this server uses the folder: it holds the data folder's lock.
    rmSync(this.#workRoot, { recursive: true, force: true });
    const last = this.#read();
    if (last?.outcome === 'running') this.#write({ ...last, outcome: 'failed', problem: 'interrupted' });
  }

  status(): RehearsalStatus {
    return { last: this.#running?.rehearsal ?? this.#read(), limitPerHour: REHEARSAL_LIMIT };
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** Starts one and returns at once; GET /api/operations shows it running, then its result. */
  start(principal: Principal | null, backup: string): RestoreRehearsal {
    if (this.#closing) throw new HttpError(503, 'The server is shutting down; rehearse after it starts again');
    if (typeof backup !== 'string') throw new HttpError(400, 'backup must be a backup name or "latest"');
    let name: string | undefined = backup;
    if (backup === 'latest') {
      try {
        name = listBackups(this.#backupsDir).filter((n) => this.#isFolder(n)).at(-1);
      } catch {
        // An unreadable backups folder: the Backups check already says so, without its path.
        name = undefined;
      }
    }
    if (name === undefined) throw new HttpError(404, 'There is no backup to rehearse');
    if (!Number.isFinite(backupTime(name))) throw new HttpError(400, 'backup must be a backup name or "latest"');
    if (!this.#isFolder(name)) throw new HttpError(404, 'There is no backup by that name');
    if (this.#running) throw new HttpError(409, 'A restore rehearsal is already running');
    const now = Date.now();
    while (this.#starts.length && now - this.#starts[0] >= REHEARSAL_WINDOW_MS) this.#starts.shift();
    if (this.#starts.length >= REHEARSAL_LIMIT) throw new HttpError(429, `At most ${REHEARSAL_LIMIT} restore rehearsals an hour; try again later`);

    mkdirSync(this.#workRoot, { recursive: true, mode: 0o700 });
    const workDir = mkdtempSync(join(this.#workRoot, 'r-'));
    const rehearsal: RestoreRehearsal = {
      backup: name,
      startedAt: nowIso(),
      finishedAt: null,
      outcome: 'running',
      problem: null,
      fromSchema: null,
      toSchema: null,
      matchesManifest: null,
      workspaces: 'not-checked',
      files: null,
      folders: null,
      bytes: null,
      ranBy: this.#ranBy,
    };
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${CHILD_HEAP_MB}`, CHILD], {
        cwd: workDir,
        // Nothing from the server's environment: no tokens, no CLI logins, no proxies, no PATH (it runs no program).
        env: { LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      rmSync(workDir, { recursive: true, force: true });
      throw new HttpError(500, 'Could not start the rehearsal');
    }
    this.#starts.push(now);
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {}
    const running: Running = { rehearsal, child, actor: this.#audit.actorOf(principal), workDir, stopReason: null, done: Promise.resolve() };
    this.#running = running;
    this.#write(rehearsal);
    running.done = this.#watch(running);
    const request: RehearsalRequest = { backupsDir: this.#backupsDir, name, workDir, limits: this.#limits };
    // stdin stays open: the child stops when it closes, so it never outlives the server.
    child.stdin!.on('error', () => {});
    child.stdin!.write(`${JSON.stringify(request)}\n`);
    return rehearsal;
  }

  /** Stops a running rehearsal, recording it as interrupted, and refuses new ones. */
  async close(): Promise<void> {
    this.#closing = true;
    const r = this.#running;
    if (!r) return;
    r.stopReason = 'interrupted';
    r.child.kill('SIGKILL');
    await r.done;
  }

  #isFolder(name: string): boolean {
    try {
      return lstatSync(join(this.#backupsDir, name)).isDirectory();
    } catch {
      return false;
    }
  }

  #watch(r: Running): Promise<void> {
    return new Promise((resolve) => {
      let out = '';
      r.child.stdout!.setEncoding('utf8');
      r.child.stdout!.on('data', (chunk: string) => {
        // One short line is all it prints.
        if (out.length < 8192) out += chunk;
      });
      const timer = setTimeout(() => {
        r.stopReason = 'timed-out';
        r.child.kill('SIGKILL');
      }, this.#timeoutMs);
      timer.unref();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          r.child.stdin!.destroy();
        } catch {}
        try {
          rmSync(r.workDir, { recursive: true, force: true });
        } catch {}
        const line = out.split('\n')[0];
        const raw = r.stopReason ? null : parseJson<Record<string, unknown> | null>(line, null);
        const fields = raw && typeof raw === 'object' ? outcomeFields(raw) : null;
        const passed = !!raw && raw.ok === true && !!fields && fields.problem === null && fields.toSchema === SCHEMA_VERSION;
        const result: RestoreRehearsal = {
          ...r.rehearsal,
          ...(fields ?? {}),
          finishedAt: nowIso(),
          outcome: passed ? 'passed' : 'failed',
          problem: passed ? null : (r.stopReason ?? fields?.problem ?? 'failed'),
        };
        this.#running = null;
        this.#write(result);
        const durationMs = Date.parse(result.finishedAt!) - Date.parse(result.startedAt);
        if (passed) log.info('restore rehearsal passed', { durationMs });
        else log.warn('restore rehearsal failed', { durationMs });
        this.#audit.record(r.actor, {
          action: 'backup.rehearsed',
          target: { kind: 'backup', id: result.backup },
          details: {
            outcome: result.outcome,
            problem: result.problem,
            fromSchema: result.fromSchema,
            toSchema: result.toSchema,
            workspaces: result.workspaces,
            matchesManifest: result.matchesManifest,
          },
        });
        resolve();
      };
      r.child.once('error', finish);
      r.child.once('close', finish);
    });
  }

  #read(): RestoreRehearsal | null {
    try {
      const raw = this.#db.prepare('select value from settings where key = ?').get(SETTING)?.value;
      return stored(parseJson(typeof raw === 'string' ? raw : null, null));
    } catch {
      return null;
    }
  }

  #write(r: RestoreRehearsal): void {
    try {
      this.#db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(SETTING, JSON.stringify(r));
    } catch (err) {
      log.error('could not record a restore rehearsal', { err });
    }
  }
}
