import { installCommand } from '../../../shared/install-commands.ts';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { formatSize } from '../../../shared/files.ts';
import type { BackupSummary, BrainProblem, DatabaseProblem, OperationsBrain, OperationsStatus, PushProblem, PushStatus, RehearsalProblem, RestoreRehearsal, StorageStatus } from '../../../shared/types.ts';
import { buildSha, versionNumber } from '../../../shared/util.ts';
import { api } from '../api.ts';
import { useStore } from '../state.ts';
import { clip, copy, dateTime, relative } from '../util.ts';
import { LoadError, useLoad } from './Load.tsx';
import { PageActive, useActiveRef } from './PageActive.ts';

/** The steps run on the server, never from the app: a restore needs the server stopped. */
const RECOVERY: Record<OperationsStatus['install'], { backup: string; restore: string; doc: string; log: string }> = {
  service: {
    backup: installCommand('service', 'backup'),
    restore: [
      'systemctl --user stop botons',
      installCommand('service', 'restore', '--list'),
      installCommand('service', 'restore', 'latest'),
      installCommand('service', 'restore', 'latest --yes'),
      'systemctl --user start botons',
    ].join('\n'),
    doc: 'docs/backups.md',
    log: 'journalctl --user -u botons',
  },
  managed: { backup: installCommand('managed', 'backup'), restore: ['systemctl --user stop botons', installCommand('managed', 'restore', '--list'), installCommand('managed', 'restore', 'latest'), installCommand('managed', 'restore', 'latest --yes'), 'systemctl --user start botons'].join('\n'), doc: 'docs/backups.md', log: 'journalctl --user -u botons' },
  docker: {
    backup: installCommand('docker', 'backup'),
    restore: [
      'docker compose stop botons',
      'docker compose run --rm --no-deps botons restore --list',
      'docker compose run --rm --no-deps botons restore latest',
      'docker compose run --rm --no-deps botons restore latest --yes',
      'docker compose start botons',
    ].join('\n'),
    doc: 'docs/DOCKER.md, Backups and restore',
    log: 'docker compose logs botons',
  },
};

function Check({ ok, label, children }: { ok: boolean; label: string; children: ReactNode }) {
  return (
    <li>
      <span className={`status-dot ${ok ? 'succeeded' : 'failed'}`} aria-hidden="true" /> <strong>{label}</strong>
      <span className="sr-only">{ok ? ' (working)' : ' (needs attention)'}</span>: <span className={ok ? undefined : 'operations-problem'}>{children}</span>
    </li>
  );
}

function holds(b: BackupSummary): string {
  if (b.schemaVersion === null) return 'its manifest is missing or unreadable';
  if (b.workspacesFailed) return `database only (schema ${b.schemaVersion}): archiving the workspaces failed`;
  return `database${b.workspaces ? ' and workspaces' : ''} (schema ${b.schemaVersion})`;
}

/** Whether this server's restore takes a backup, going by the schema its manifest names (a rehearsal reads the database itself). */
export function compatibility(b: BackupSummary, data: Pick<OperationsStatus, 'schema' | 'restorableSchemas'>): { ok: boolean; text: string } | null {
  const v = b.schemaVersion;
  if (v === null) return null;
  if (v === data.schema) return { ok: true, text: 'this release restores it' };
  if (data.restorableSchemas.includes(v)) return { ok: true, text: `this release restores it and upgrades it to schema ${data.schema} at the next start` };
  if (v > data.schema) return { ok: false, text: `newer than this release (schema ${data.schema}): restore it with the release that made it` };
  return { ok: false, text: `older than this release restores (schema ${data.restorableSchemas.join(' or ')})` };
}

/** What each way a rehearsal can fail means for a restore, and what to do. */
const REHEARSAL_PROBLEM: Record<RehearsalProblem, string> = {
  'not-found': 'the backup is no longer there, or is not a backup folder: pick another',
  'not-a-backup': 'it holds no Botons database where one belongs, or a link or special file in its place: a restore would refuse it, so rehearse another backup',
  'database-too-large': 'its database is larger than a rehearsal from the app reads: check it on the server with the restore command without --yes, which changes nothing',
  'no-space': 'there is not room for a temporary copy where the data lives: free space on the server (Disk space above), then rehearse again',
  'damaged-database': "its database failed SQLite's integrity check: do not restore it; rehearse an older backup",
  'newer-schema': 'it was made by a newer Botons: restore it with the release that made it, not this one',
  'older-schema': 'it is older than this release restores: restore it with the release that made it first',
  'upgrade-failed': 'this release could not upgrade its database, so the server would not start after restoring it: keep the backup, rehearse an older one, and send the status summary below with a bug report',
  'damaged-archive': 'its workspaces archive is cut short or damaged, so a restore would stop part-way: rehearse an older backup',
  'unsafe-archive': 'its workspaces archive holds links, special files or paths outside the folders a backup archives, which a Botons backup never does: do not restore it',
  'archive-too-large': 'its workspaces archive is larger than a rehearsal from the app reads: check it on the server with the restore command without --yes, which changes nothing',
  'timed-out': 'it ran past its time limit and was stopped: check the backup on the server with the restore command without --yes',
  interrupted: 'the server stopped or restarted while it ran: rehearse again',
  failed: "it stopped on something it did not expect: rehearse again, and if it fails again see the server's raw log",
};

const when = (at: string) => (
  <time dateTime={at} title={dateTime(at)}>
    {relative(at)}
  </time>
);

function rehearsalText(r: RestoreRehearsal, schema: number): ReactNode {
  if (r.outcome === 'running') return <>Rehearsing <code>{r.backup}</code>, started {when(r.startedAt)}…</>;
  const at = r.finishedAt ?? r.startedAt;
  if (r.outcome === 'failed') {
    return (
      <span className="operations-problem">
        <code>{r.backup}</code> failed {when(at)}: {REHEARSAL_PROBLEM[r.problem ?? 'failed'] ?? REHEARSAL_PROBLEM.failed}.
      </span>
    );
  }
  const upgraded = r.fromSchema !== null && r.toSchema !== null && r.fromSchema !== r.toSchema;
  return (
    <>
      <code>{r.backup}</code> passed {when(at)}: its database (schema {r.fromSchema}) passed SQLite's integrity check{upgraded && <>, and upgraded to schema {r.toSchema} as the server's next start would</>};{' '}
      {r.workspaces === 'checked'
        ? `its workspaces archive (${r.files} files in ${r.folders} folders, ${formatSize(r.bytes ?? 0)}) read through, holding only regular files and folders where a backup puts them`
        : 'it holds the database only, no workspaces'}
      .{r.matchesManifest === false && ' Its tables hold a different number of rows than its manifest says, so it changed after it was made.'}
      {r.ranBy.schema !== schema && ` That ran on schema ${r.ranBy.schema}; this server is at ${schema}, so rehearse again.`}
    </>
  );
}

/** Rehearse a restore: from the app, without touching the data folder or stopping the server. */
function Rehearsal({ data, onReload }: { data: OperationsStatus; onReload: () => void }) {
  const names = data.backups.backups.map((b) => b.name);
  const [pick, setPick] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const last = data.rehearsal.last;
  const running = last?.outcome === 'running';
  const chosen = names.includes(pick) ? pick : (names[0] ?? '');
  return (
    <div className="operations-rehearsal">
      <span className="field-label">Restore rehearsal</span>
      <p className="hint" role="status">
        {last ? rehearsalText(last, data.schema) : 'None yet.'}
      </p>
      {names.length > 0 && (
        <p className="operations-rehearse">
          <label>
            <span className="sr-only">Backup to rehearse</span>
            <select value={chosen} disabled={busy || running} onChange={(e) => setPick(e.target.value)}>
              {names.map((n, i) => (
                <option key={n} value={n}>
                  {n}
                  {i === 0 ? ' (newest)' : ''}
                </option>
              ))}
            </select>
          </label>{' '}
          <button
            type="button"
            className="link-btn"
            disabled={busy || running || !chosen}
            onClick={async () => {
              setBusy(true);
              setNote(null);
              try {
                await api.rehearseRestore(chosen);
              } catch (err) {
                setNote(`Couldn't start a rehearsal: ${clip((err as Error).message, 200)}`);
              } finally {
                setBusy(false);
                onReload();
              }
            }}
          >
            {running ? 'Rehearsing…' : 'Rehearse a restore'}
          </button>
          {note && (
            <span className="hint" role="alert">
              {' '}
              {note}
            </span>
          )}
        </p>
      )}
      <p className="hint">
        A rehearsal copies the backup into a private temporary folder on the server, checks its database, upgrades the copy to this server's schema as a restore and the next start would, reads its workspaces archive through and checks every file in it, then deletes the copy. The data folder, the backups and the running server are not changed. One at a time, at most {data.rehearsal.limitPerHour} an hour, each in the audit log.
      </p>
    </div>
  );
}

/** Where to look for each way a push can fail. */
const PUSH_PROBLEM: Record<PushProblem, string> = {
  refused: 'the ntfy server refused it (401 or 403): check the access token, or that the topic allows it',
  rejected: 'the ntfy server rejected it: check the topic name and the server URL',
  redirected: 'the ntfy server answered with a redirect: check the server URL (https, no extra path)',
  'server-error': 'the ntfy server had a problem (5xx): send a test later, or check that server',
  unreachable: "this server could not reach the ntfy server: check the server URL and the server's network",
  timeout: 'the ntfy server did not answer within 10 seconds: send a test later, or check that server',
};

/** What each database failure means and what to do; the error itself is only in the server's raw log. */
const DATABASE_PROBLEM: Record<DatabaseProblem, string> = {
  busy: 'it is locked by another process: check that only one Botons server uses this data folder',
  corrupt: 'the file is damaged: stop the server and restore the newest backup (How to back up and restore below)',
  'read-only': "it can't be written: check the data folder's permissions and that its disk is not mounted read-only",
  'disk-full': 'the disk is full: free space on the server (Disk space below)',
  'cannot-open': "the file can't be opened: check that the data folder exists and the server's user can read it",
  'io-error': 'the disk reported an error: check the disk, then run the doctor on the server',
  other: "it didn't answer: run the doctor on the server, and see Server events below",
};

const BRAIN_PROBLEM: Record<BrainProblem, string> = {
  'not-installed': 'not found, or its --version failed',
  'signed-out': 'not signed in',
  unavailable: 'not ready',
};

function brainLine(p: OperationsBrain): string {
  return `${p.label}: ${p.problem ? BRAIN_PROBLEM[p.problem] : 'ready'}`;
}

/** A provider id in the server's own shape, for the summary; anything else is left out. */
function safeId(id: string): string {
  return /^[a-z0-9-]{1,32}$/.test(id) ? id : 'other';
}

function since(p: PushStatus): string {
  return p.sinceSettingsChange ? 'since the push settings changed' : 'since the server started';
}

export function pushOk(p: PushStatus): boolean {
  return p.state !== 'on' || !p.last || p.last.ok;
}

function pushText(p: PushStatus): ReactNode {
  if (p.state === 'unset') return 'not set up: pushes about failures and approvals need an ntfy server and topic (Push notifications below)';
  const last = p.last;
  const when = (at: string) => (
    <time dateTime={at} title={dateTime(at)}>
      {relative(at)}
    </time>
  );
  const lastLine = last ? (
    last.ok ? (
      <>last {last.reason === 'test' ? 'test ' : ''}push went through {when(last.at)}</>
    ) : (
      <>
        the last {last.reason === 'test' ? 'test ' : ''}push failed {when(last.at)}
        {p.failuresInARow > 1 && ` (${p.failuresInARow} in a row)`}: {last.problem ? PUSH_PROBLEM[last.problem] : 'see Server events below'}
        {p.lastSuccessAt ? <>. The last one that went through was {when(p.lastSuccessAt)}</> : `. None has gone through ${since(p)}`}
      </>
    )
  ) : (
    `none sent ${since(p)}`
  );
  if (p.state === 'off') return <>turned off, so nobody is told about failures or approvals; {lastLine}</>;
  return lastLine;
}

function storageText(st: StorageStatus): ReactNode {
  if (st.unreadable) return `free space could not be read; the database is ${formatSize(st.databaseBytes)}`;
  const pct = Math.round((st.freeBytes / st.totalBytes) * 100);
  const base = `${formatSize(st.freeBytes)} free of ${formatSize(st.totalBytes)} (${pct}%); the database is ${formatSize(st.databaseBytes)}`;
  if (!st.low) return base;
  return `${base}. That is low: when the disk fills, chats, runs and backups stop being saved. Free space on the server's disk, for example by keeping fewer backups or clearing large files from Boton workspaces`;
}

/**
 * A status summary to paste when asking for help: what failed, and versions. No names, paths, addresses or error text:
 * every value is a fixed word, a count, a time, or a version, build or schema checked against its expected shape.
 */
export function diagnostics(data: OperationsStatus, version: string | null): string {
  const { details } = data.health;
  const yes = (ok: boolean) => (ok ? 'ok' : 'NEEDS ATTENTION');
  const b = data.backups;
  const p = data.push;
  const st = data.storage;
  const lines = [
    `Botons ${versionNumber(version) ?? 'unknown version'}, build ${buildSha(data.health.build) ?? 'unknown'}, schema ${Number.isSafeInteger(data.schema) && data.schema > 0 ? data.schema : 'unknown'}, ${data.install === 'docker' ? 'Docker image' : 'service'}`,
    `Health: ${data.health.ok ? 'ok' : `failing: ${data.health.failing.filter((f) => /^[a-z]{1,20}$/.test(f)).join(', ')}`}`,
    `Database: ${yes(details.database.ok)}${details.database.problem && DATABASE_PROBLEM[details.database.problem] ? ` (${details.database.problem})` : ''}`,
    `Scheduler: ${yes(details.scheduler.ok)}${details.scheduler.lastTickAt ? `, last tick ${details.scheduler.lastTickAt}` : ', no tick yet'}`,
    ...details.providers.map(
      (pr) =>
        `Brain ${safeId(pr.id)}: ${pr.available ? 'ready' : `not ready${pr.problem && BRAIN_PROBLEM[pr.problem] ? ` (${pr.problem})` : ''}`}, installed ${pr.installed ? 'yes' : 'no'}, signed in ${pr.loggedIn === null ? 'unknown' : pr.loggedIn ? 'yes' : 'no'}, version ${versionNumber(pr.version) ?? 'unknown'}${pr.usageLimitUntil ? `, usage limit until ${pr.usageLimitUntil}` : ''}${pr.lastErrorAt ? `, last turn failed ${pr.lastErrorAt}` : ''}`,
    ),
    `Accepting work: ${details.draining ? 'no (draining)' : 'yes'}`,
    `Backups: ${b.unreadable ? 'folder unreadable' : `${b.total} kept, newest ${b.backups[0]?.createdAt ?? 'none'}${b.stale ? ' (stale)' : ''}${b.partial ? `, ${b.partial} partial` : ''}`}`,
    `Push: ${p.state}${p.last ? `, last ${p.last.ok ? 'ok' : `failed (${p.last.problem ?? 'unknown'}${p.last.status ? `, HTTP ${p.last.status}` : ''})`} ${p.last.at}` : `, none ${p.sinceSettingsChange ? 'since its settings changed' : 'since start'}`}${p.failuresInARow > 1 ? `, ${p.failuresInARow} failures in a row` : ''}`,
    `Disk: ${st.unreadable ? 'unreadable' : `${formatSize(st.freeBytes)} free of ${formatSize(st.totalBytes)}${st.low ? ' (LOW)' : ''}`}, database ${formatSize(st.databaseBytes)}`,
    `Restores schemas: ${(data.restorableSchemas ?? []).filter((v) => Number.isSafeInteger(v) && v > 0).join(', ') || 'unknown'}`,
    `Restore rehearsal: ${rehearsalLine(data.rehearsal?.last ?? null)}`,
  ];
  return lines.join('\n');
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isoOr = (at: string | null) => (at && ISO_TIME.test(at) ? at : 'unknown time');
const schemaOr = (v: number | null) => (v !== null && Number.isSafeInteger(v) && v > 0 ? String(v) : '?');

/** One line for the summary: fixed words, times and schema numbers only (not the backup's name). */
function rehearsalLine(r: RestoreRehearsal | null): string {
  if (!r) return 'none';
  if (r.outcome === 'running') return `running since ${isoOr(r.startedAt)}`;
  const schemas = `schema ${schemaOr(r.fromSchema)}${r.toSchema !== null && r.toSchema !== r.fromSchema ? ` -> ${schemaOr(r.toSchema)}` : ''}`;
  const workspaces = r.workspaces === 'checked' || r.workspaces === 'none' ? r.workspaces : 'not checked';
  if (r.outcome === 'passed') return `passed ${isoOr(r.finishedAt)} (${schemas}, workspaces ${workspaces}${r.matchesManifest === false ? ', rows differ from manifest' : ''}), ran on schema ${schemaOr(r.ranBy.schema)}`;
  const problem = r.problem && r.problem in REHEARSAL_PROBLEM ? r.problem : 'failed';
  return `FAILED ${isoOr(r.finishedAt ?? r.startedAt)} (${problem}${r.fromSchema !== null ? `, ${schemas}` : ''}), ran on schema ${schemaOr(r.ranBy.schema)}`;
}

/** Sends a test push from here, then reloads the status so the Push check shows how it went. */
function TestPush({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="link-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            const d = await api.testPush();
            setNote(d.ok ? 'Sent. Check your phone.' : 'The test failed too; the check above says where to look.');
          } catch (err) {
            setNote(`Couldn't send a test: ${clip((err as Error).message, 200)}`);
          } finally {
            setBusy(false);
            onDone();
          }
        }}
      >
        {busy ? 'Sending a test…' : 'Send a test push'}
      </button>
      {note && (
        <span className="hint" role="status">
          {' '}
          {note}
        </span>
      )}
    </>
  );
}

function Diagnostics({ text, log }: { text: string; log: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <details>
      <summary>Status summary for asking for help</summary>
      <p className="hint">
        Paste this into a bug report or a message to whoever runs the server. It names no Botons, people, paths, addresses or error text. Those are only in the server's raw log, on its machine (<code>{log}</code>): Server events below leave them out too.
      </p>
      <pre className="code">{text}</pre>
      <button type="button" className="link-btn" onClick={async () => setCopied(await copy(text))}>
        Copy
      </button>
      {copied !== null && (
        <span className="hint" role="status">
          {' '}
          {copied ? 'Copied.' : "Couldn't copy; select the text instead."}
        </span>
      )}
    </details>
  );
}

/** Settings → Health and backups: read-only, but for a test push and a restore rehearsal. Backing up and restoring stay commands on the server. */
export function HealthAndBackups() {
  const [loaded, setLoaded] = useState<{ data: OperationsStatus; at: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const active = useActiveRef();
  useEffect(() => {
    const timer = window.setInterval(() => active.current && setRefresh((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const load = useLoad(async (isCurrent) => {
    const data = await api.operations();
    if (isCurrent()) setLoaded({ data, at: new Date().toISOString() });
  }, `operations:${refresh}`, true);
  const version = useStore((st) => st.info?.version ?? null);
  // Saving Push notifications changes what the Push check says (and whether it offers a test): look again then.
  const ntfy = useStore((st) => st.settings?.ntfy);
  // Each saved settings snapshot has a new identity, even when a replacement token stays hidden behind hasToken.
  const savedPush = useRef(ntfy);
  useEffect(() => {
    if (ntfy === savedPush.current) return;
    savedPush.current = ntfy;
    setRefresh((n) => n + 1);
  }, [ntfy]);
  // While a rehearsal runs, look again every 2 seconds rather than 30.
  const rehearsing = loaded?.data.rehearsal.last?.outcome === 'running';
  const shown = useContext(PageActive);
  useEffect(() => {
    if (!rehearsing || !shown) return;
    const timer = window.setTimeout(() => setRefresh((n) => n + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [rehearsing, loaded, shown]);
  return <OperationsView loaded={loaded} error={load.error} onRetry={load.retry} onReload={() => setRefresh((n) => n + 1)} version={version} />;
}

/**
 * What the section shows. A refresh that fails keeps the last status on screen, with the error, when it was
 * loaded and a retry, so a server that stopped answering never looks healthy.
 */
export function OperationsView({
  loaded,
  error,
  onRetry,
  onReload = onRetry,
  version = null,
}: {
  loaded: { data: OperationsStatus; at: string } | null;
  error: string | null;
  onRetry: () => void;
  onReload?: () => void;
  version?: string | null;
}) {
  return (
    <section className="server-info operations" aria-labelledby="operations-title">
      <h4 id="operations-title">Health and backups</h4>
      {!loaded && (error ? <LoadError what="health and backups" error={error} onRetry={onRetry} /> : <p className="hint">Loading…</p>)}
      {loaded && error && (
        <p className="load-error" role="alert">
          <span>
            Couldn't refresh health and backups: {clip(error, 200)}. This is the status from{' '}
            <time dateTime={loaded.at} title={dateTime(loaded.at)}>
              {relative(loaded.at)}
            </time>
            .
          </span>
          <button type="button" className="link-btn" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
      {loaded && <Status data={loaded.data} onReload={onReload} version={version} />}
      {loaded && <Diagnostics text={diagnostics(loaded.data, version)} log={(RECOVERY[loaded.data.install] ?? RECOVERY.service).log} />}
      {loaded && !error && (
        <p className="hint">
          Updated{' '}
          <time dateTime={loaded.at} title={dateTime(loaded.at)}>
            {relative(loaded.at)}
          </time>
          ; refreshes every 30 seconds.
        </p>
      )}
    </section>
  );
}

function Status({ data, onReload, version }: { data: OperationsStatus; onReload: () => void; version: string | null }) {
  const { details } = data.health;
  const ready = details.providers.filter((p) => p.available).length;
  const { backups } = data;
  const newest = backups.backups[0];
  const steps = RECOVERY[data.install];
  const build = buildSha(data.health.build);
  return (
    <>
      <p className="hint">
        This server runs Botons {versionNumber(version) ?? '(version unknown)'}
        {build ? `, build ${build.slice(0, 12)}` : ''}, database schema {data.schema}. Its restore takes backups at schema {data.restorableSchemas.join(' and ')}
        {data.restorableSchemas.some((v) => v < data.schema) && ` (older ones are upgraded at the next start)`}.
      </p>
      <ul className="operations-checks">
        <Check ok={details.database.ok} label="Database">
          {details.database.ok ? 'opens and answers' : `cannot be read: ${DATABASE_PROBLEM[details.database.problem ?? 'other'] ?? DATABASE_PROBLEM.other}`}
        </Check>
        <Check ok={details.scheduler.ok} label="Scheduler">
          {details.scheduler.lastTickAt
            ? `${details.scheduler.ok ? 'last checked routines' : 'has not checked routines since'} ${relative(details.scheduler.lastTickAt)}`
            : details.scheduler.ok
              ? 'starting'
              : 'has not run since the server started: scheduled routines are not starting'}
        </Check>
        <Check ok={ready > 0} label="Brains">
          {ready > 0
            ? `${ready} ready`
            : `none is ready${details.providers.length ? ` (${details.providers.map(brainLine).join('; ')})` : ''}: install or sign a CLI in on the server (see Brains above)`}
        </Check>
        <Check ok={!details.draining} label="Accepting work">
          {details.draining ? 'no: the server is shutting down and finishing running turns' : 'yes'}
        </Check>
        <Check ok={pushOk(data.push)} label="Push notifications">
          {pushText(data.push)}
          {data.push.state !== 'unset' && (
            <>
              {' '}
              <TestPush onDone={onReload} />
            </>
          )}
        </Check>
        <Check ok={!data.storage.low && !data.storage.unreadable} label="Disk space">
          {storageText(data.storage)}
        </Check>
        <Check ok={!backups.stale && !backups.unreadable} label="Backups">
          {backups.unreadable ? (
            'the backups folder cannot be read on the server: run the doctor there to see why'
          ) : newest ? (
            <>
              newest{' '}
              <time dateTime={newest.createdAt} title={dateTime(newest.createdAt)}>
                {relative(newest.createdAt)}
              </time>
              , {backups.total} kept (the newest {backups.keep} stay)
              {backups.stale && `. That is over ${backups.staleAfterHours / 24} days old: check the backup timer or cron job`}
            </>
          ) : backups.stale ? (
            'none yet'
          ) : (
            'none yet; there is nothing to back up'
          )}
        </Check>
      </ul>
      {backups.partial > 0 && (
        <p className="hint warn">
          {backups.partial === 1 ? 'A backup' : `${backups.partial} backups`} stopped part-way (a <code>.partial</code> folder). The next backup deletes it after a day; run a backup on the server to see why it failed.
        </p>
      )}
      {newest && (
        <details>
          <summary>
            {backups.backups.length < backups.total ? `The newest ${backups.backups.length} of ${backups.total} backups` : `All ${backups.total} backups`}
          </summary>
          <ul className="operations-backups">
            {backups.backups.map((b) => {
              const compat = compatibility(b, data);
              return (
                <li key={b.name}>
                  <code>{b.name}</code>
                  <span className={b.workspacesFailed || b.schemaVersion === null ? 'hint warn' : 'hint'}> {holds(b)}</span>
                  {compat && <span className={compat.ok ? 'hint' : 'hint warn'}>; {compat.text}</span>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <Rehearsal data={data} onReload={onReload} />
      <details>
        <summary>How to back up and restore</summary>
        <p className="hint">Run these on the server's machine, from where Botons is installed. A restore needs the server stopped, so the app cannot do it.</p>
        <span className="field-label">Back up now</span>
        <pre className="code">{steps.backup}</pre>
        <span className="field-label">Restore</span>
        <pre className="code">{steps.restore}</pre>
        <p className="hint">
          <code>--list</code> shows the backups, oldest first. Without <code>--yes</code> a restore only says what it would do; use a name from the list instead of <code>latest</code> for an older backup. A restore deletes nothing: the current database and folders move to <code>before-restore-&lt;time&gt;</code> in the data folder first, and a restore that fails part-way puts them back. If it says recovery is incomplete, keep the folders it names and do not start the server. More in {steps.doc}.
        </p>
      </details>
    </>
  );
}
