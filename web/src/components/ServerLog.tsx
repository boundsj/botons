import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RecentLogEntry, RecentLogHelp, RecentLogLevel, RecentLogs } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText } from '../feedback.ts';
import { type LogFilters, ServerLogLoader } from '../server-log-loader.ts';
import { useStore } from '../state.ts';
import { clip, copy, dateTime, relative } from '../util.ts';

export type { LogFilters };

const LEVEL_LABEL: Record<RecentLogLevel, string> = { info: 'Info', warn: 'Warning', error: 'Error' };

/** What the owner can do about an event the server knows a next step for. */
const NEXT_STEPS: Record<RecentLogHelp, string> = {
  reconnect: 'Open Sign-in connectors below and sign the connector in again.',
  connector: 'Open its connector below and test it; sign it in again if it asks.',
  push: 'Check Push notifications below and send a test.',
  tailscale: 'Other devices cannot reach the server until Tailscale is up on its machine; it keeps checking by itself.',
  'usage-limit': 'Its Botons wait for the reset by themselves. To carry on sooner, move a Boton to another brain in its settings.',
  brain: 'Sign that CLI in on the server’s machine (see Brains above).',
  run: 'Open the routine’s run history (or Runs to check, above, when it lists the run) to retry it or send its result again.',
  bug: 'This looks like a problem in Botons itself. If it repeats, copy the event into a bug report, with the matching lines from the server’s full log.',
  'auth-off': 'Set BOTONS_AUTH back on in the server’s settings and restart it, unless you mean to run without pairing.',
};

export function nextStep(e: RecentLogEntry): string | null {
  if (e.help) return NEXT_STEPS[e.help];
  if (e.event === 'turn.ended' && e.fields.runId && ['error', 'timeout', 'interrupted'].includes(String(e.fields.outcome))) return NEXT_STEPS.run;
  if (e.event === 'unclassified') return e.level === 'error' ? 'The details are only in the server’s full log (its journal or container log), from around this time.' : null;
  return e.level === 'error' ? 'If it repeats, copy the event into a bug report, with what you were doing at the time.' : null;
}

/** How each field the server may keep is named on screen. */
const FIELD_LABEL: Record<string, string> = {
  botId: 'Boton',
  fromBotId: 'From Boton',
  routineId: 'Routine',
  runId: 'Run',
  retryOf: 'Retry of',
  approvalId: 'Approval',
  connectionId: 'Connector',
  threadId: 'Thread',
  deviceId: 'Device',
  templateId: 'Template',
  provider: 'Brain',
  errorCategory: 'Error kind',
  oauthError: 'OAuth error',
  durationMs: 'Took',
  timeLimitMs: 'Time limit',
  retryInMs: 'Retry in',
  exitCode: 'Exit code',
  status: 'Status',
};

function fieldText(k: string, v: RecentLogEntry['fields'][string]): string {
  if (typeof v === 'number' && k.endsWith('Ms')) return v < 1000 ? `${v} ms` : `${Math.round(v / 100) / 10} s`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/** Settings → Server events: known events the server selected from its recent log lines. Loads on open, on a filter change and on Refresh. */
export function ServerLog() {
  const bots = useStore((s) => s.bots);
  const [loader] = useState(() => new ServerLogLoader({ fetch: (f, before) => api.logs({ ...f, before }), errorText }));
  const state = useSyncExternalStore(loader.subscribe, () => loader.state);

  useEffect(() => {
    loader.start();
    return () => loader.stop();
  }, [loader]);

  return (
    <ServerLogView
      {...state}
      botons={bots.map((b) => ({ id: b.id, name: b.name }))}
      onFilters={(f) => loader.setFilters(f)}
      onRefresh={() => loader.refresh()}
      onOlder={() => loader.older()}
    />
  );
}

export interface ServerLogViewProps {
  data: RecentLogs | null;
  entries: RecentLogEntry[];
  error: string | null;
  loading: boolean;
  loadedAt: string | null;
  /** Set when a refresh found a newer server process than the one shown before. */
  restartedAt: string | null;
  filters: LogFilters;
  botons: { id: string; name: string }[];
  onFilters: (f: LogFilters) => void;
  onRefresh: () => void;
  onOlder: () => void;
}

/** What the section shows. A refresh that fails keeps the lines on screen, with the error and a retry. */
export function ServerLogView(p: ServerLogViewProps) {
  const { data, entries, error, filters } = p;
  const filtered = filters.level !== 'info' || !!filters.q.trim() || !!filters.boton;
  const names = new Map(p.botons.map((m) => [m.id, m.name]));
  return (
    <section className="server-info server-log" aria-labelledby="server-log-title">
      <h4 id="server-log-title">Server events</h4>
      <p className="hint">
        Known events from what the server logged recently, for spotting what failed and what to do about it. This is a selection, not the log: each event shows a fixed name and only checked details (ids, kinds, counts, times, an error kind). Error text and anything else a line holds are left out, and events the server doesn’t know read as unclassified. The full log, with more detail, is in the server’s journal or container log. Kept in memory only, so a restart starts it again.
      </p>
      <div className="server-log-filters" role="search">
        <label>
          <span className="field-label">Show</span>
          <select value={filters.level} onChange={(e) => p.onFilters({ ...filters, level: e.target.value as RecentLogLevel })}>
            <option value="error">Errors</option>
            <option value="warn">Warnings and errors</option>
            <option value="info">Everything</option>
          </select>
        </label>
        <label>
          <span className="field-label">Boton</span>
          <select value={filters.boton} onChange={(e) => p.onFilters({ ...filters, boton: e.target.value })}>
            <option value="">Any or none</option>
            {p.botons.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="server-log-search">
          <span className="field-label">Search</span>
          <input type="search" value={filters.q} maxLength={100} placeholder="e.g. OAuth, push, run_…" onChange={(e) => p.onFilters({ ...filters, q: e.target.value })} />
        </label>
        <button type="button" className="btn small ghost" onClick={p.onRefresh} disabled={p.loading}>
          {p.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && (
        <p className="load-error" role="alert">
          <span>
            Couldn't {data ? 'refresh' : 'load'} the server events: {clip(error, 200)}
            {data && p.loadedAt && (
              <>
                . These events are from{' '}
                <time dateTime={p.loadedAt} title={dateTime(p.loadedAt)}>
                  {relative(p.loadedAt)}
                </time>
              </>
            )}
            .
          </span>
          <button type="button" className="link-btn" onClick={p.onRefresh}>
            Retry
          </button>
        </p>
      )}
      {!data && !error && <p className="hint">Loading…</p>}
      {p.restartedAt && (
        <p className="hint warn">
          The server restarted{' '}
          <time dateTime={p.restartedAt} title={dateTime(p.restartedAt)}>
            {relative(p.restartedAt)}
          </time>
          : events from before then are only in its full log on the server.
        </p>
      )}
      {data && <Retention data={data} />}
      {data && !entries.length && (
        <p className="hint">
          {filtered ? 'No kept event matches these filters.' : 'Nothing logged yet since the server started.'}
          {filters.level !== 'info' && data.kept > 0 && ' Choose Everything to see the rest.'}
        </p>
      )}
      {entries.length > 0 && (
        <ol className="server-log-list">
          {entries.map((e) => (
            <LogLine key={e.seq} entry={e} names={names} />
          ))}
        </ol>
      )}
      {data?.more && entries.length > 0 && (
        <div>
          <button type="button" className="btn small ghost" onClick={p.onOlder} disabled={p.loading}>
            Show older
          </button>
        </div>
      )}
    </section>
  );
}

function Retention({ data }: { data: RecentLogs }) {
  const { counts } = data;
  return (
    <p className="hint">
      Since the server started{' '}
      <time dateTime={data.since} title={dateTime(data.since)}>
        {relative(data.since)}
      </time>
      : {counts.error} {counts.error === 1 ? 'error' : 'errors'}, {counts.warn} {counts.warn === 1 ? 'warning' : 'warnings'} and {counts.info} info {counts.info === 1 ? 'event' : 'events'} kept
      {data.dropped > 0 && (
        <>
          ; {data.dropped} older {data.dropped === 1 ? 'event was' : 'events were'} let go to keep within {data.limits.entries} events and {Math.round(data.limits.bytes / 1024)} KB
          {data.oldestAt && (
            <>
              , so the oldest kept is from{' '}
              <time dateTime={data.oldestAt} title={dateTime(data.oldestAt)}>
                {relative(data.oldestAt)}
              </time>
            </>
          )}
        </>
      )}
      .{data.threshold !== 'info' && ` BOTONS_LOG_LEVEL is ${data.threshold}, so less severe lines are not logged at all.`}
    </p>
  );
}

function LogLine({ entry: e, names }: { entry: RecentLogEntry; names: Map<string, string> }) {
  const [copied, setCopied] = useState(false);
  const step = nextStep(e);
  const fields = Object.entries(e.fields);
  return (
    <li className={`server-log-line ${e.level}`}>
      <div className="server-log-head">
        <span className={`server-log-level ${e.level}`}>{LEVEL_LABEL[e.level]}</span>
        <time dateTime={e.ts} title={dateTime(e.ts)}>
          {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span className="server-log-msg">{e.label}</span>
        {e.event !== 'unclassified' && <code className="server-log-event">{e.event}</code>}
      </div>
      {fields.length > 0 && (
        <dl className="server-log-fields">
          {fields.map(([k, v]) => (
            <div key={k}>
              <dt>{FIELD_LABEL[k] ?? k}</dt>
              <dd>
                {fieldText(k, v)}
                {(k === 'botId' || k === 'fromBotId') && typeof v === 'string' && names.has(v) && <span className="hint"> ({names.get(v)})</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {step && <p className="server-log-step">{step}</p>}
      <button
        type="button"
        className="link-btn"
        onClick={() => void copy(JSON.stringify({ ts: e.ts, level: e.level, event: e.event, label: e.label, ...e.fields })).then(setCopied)}
      >
        {copied ? 'Copied' : 'Copy event'}
      </button>
    </li>
  );
}
