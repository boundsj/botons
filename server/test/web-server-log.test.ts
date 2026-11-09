// Settings → Server events (web/src/components/ServerLog.tsx), rendered in Node: Vite bundles the view for SSR into
// a temp folder and react-dom/server renders it.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { RecentLogEntry, RecentLogs } from '../../shared/types.ts';
import { tempDir } from './helpers.ts';

/** ServerLogViewProps in web/src/components/ServerLog.tsx (the server's tsconfig doesn't compile JSX). */
interface ServerLogViewProps {
  data: RecentLogs | null;
  entries: RecentLogEntry[];
  error: string | null;
  loading: boolean;
  loadedAt: string | null;
  restartedAt: string | null;
  filters: { level: 'info' | 'warn' | 'error'; q: string; boton: string };
  botons: { id: string; name: string }[];
  onFilters: (f: ServerLogViewProps['filters']) => void;
  onRefresh: () => void;
  onOlder: () => void;
}

const repo = resolve(import.meta.dirname, '../..');
const out = tempDir();
const ENTRY = join(repo, 'web/src/server-log-render-entry.tsx');
const { build } = await import('vite');
await build({
  configFile: false,
  root: join(repo, 'web'),
  logLevel: 'silent',
  plugins: [
    {
      name: 'server-log-entry',
      resolveId: (id) => (id === ENTRY ? id : null),
      load: (id) =>
        id === ENTRY
          ? `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerLogView, nextStep } from './components/ServerLog.tsx';
export const render = (props) => renderToStaticMarkup(createElement(ServerLogView, props));
export { nextStep };
`
          : null,
    },
  ],
  ssr: { noExternal: true },
  build: { ssr: ENTRY, outDir: join(out, 'dist'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'entry.mjs' } } },
});
const { render, nextStep } = (await import(pathToFileURL(join(out, 'dist/entry.mjs')).href)) as {
  render: (p: ServerLogViewProps) => string;
  nextStep: (e: RecentLogEntry) => string | null;
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const entry = (over: Partial<RecentLogEntry>): RecentLogEntry => ({ seq: 1, ts: ago(60_000), level: 'info', event: 'turn.started', label: 'turn started', help: null, fields: {}, ...over });
const page = (over: Partial<RecentLogs> = {}): RecentLogs => ({
  entries: [],
  more: false,
  since: ago(3_600_000),
  oldestAt: null,
  dropped: 0,
  kept: 0,
  counts: { info: 0, warn: 0, error: 0 },
  bytes: 0,
  limits: { entries: 1000, bytes: 512 * 1024, page: 200 },
  threshold: 'info',
  ...over,
});
const noop = () => {};
const props = (over: Partial<ServerLogViewProps>): ServerLogViewProps => ({
  data: null,
  entries: [],
  error: null,
  loading: false,
  loadedAt: null,
  restartedAt: null,
  filters: { level: 'warn', q: '', boton: '' },
  botons: [{ id: 'bot_kevin001', name: 'Kevin' }],
  onFilters: noop,
  onRefresh: noop,
  onOlder: noop,
  ...over,
});

test('server events: show severity, time, the fixed label and code, checked fields by name, the Boton by name, a next step and Copy', () => {
  const lines = [
    entry({ seq: 3, level: 'error', event: 'jobs.failed', label: 'job failed', help: 'bug', fields: { botId: 'bot_kevin001', errorCategory: 'disk-full', durationMs: 2500 } }),
    entry({ seq: 2, level: 'warn', event: 'oauth.refresh_refused', label: 'OAuth refresh refused: the connector needs signing in again', help: 'reconnect', fields: { connectionId: 'oac_stuart01', oauthError: 'invalid_grant', ok: false } }),
  ];
  const html = render(props({ data: page({ entries: lines, kept: 5, counts: { info: 3, warn: 1, error: 1 }, more: true }), entries: lines, loadedAt: ago(0) }));
  assert.match(html, /<h4 id="server-log-title">Server events<\/h4>/);
  assert.match(html, /server-log-level error">Error</);
  assert.match(html, /server-log-level warn">Warning</);
  assert.match(html, /server-log-msg">job failed<\/span><code class="server-log-event">jobs\.failed<\/code>/);
  assert.match(html, /<dt>Boton<\/dt><dd>bot_kevin001<span class="hint"> \(Kevin\)<\/span>/);
  assert.match(html, /<dt>Error kind<\/dt><dd>disk-full<\/dd>/);
  assert.match(html, /<dt>Took<\/dt><dd>2\.5 s<\/dd>/);
  assert.match(html, /<dt>OAuth error<\/dt><dd>invalid_grant<\/dd>/);
  assert.match(html, /<dt>ok<\/dt><dd>no<\/dd>/);
  assert.match(html, /a problem in Botons itself/);
  assert.match(html, /sign the connector in again/);
  assert.match(html, />Copy event</);
  assert.match(html, />Show older</);
  assert.match(html, /1 error, 1 warning and 3 info events kept/);
  assert.match(html, /This is a selection, not the log/);
  assert.match(html, /Error text and anything else a line holds are left out/);
  assert.match(html, /full log, with more detail, is in the server’s journal or container log/);
  assert.match(html, /Kept in memory only, so a restart starts it again/);
  assert.doesNotMatch(html, /no secrets|scrubbed/i, 'the view promises no more than it does');
});

test('server events: an unclassified event reads as one, without a code, and points at the full log', () => {
  const lines = [entry({ level: 'error', event: 'unclassified', label: 'Unclassified server event' })];
  const html = render(props({ data: page({ entries: lines, kept: 1 }), entries: lines }));
  assert.match(html, /server-log-msg">Unclassified server event<\/span><\/div>/);
  assert.doesNotMatch(html, /server-log-event/);
  assert.match(nextStep(lines[0]) ?? '', /only in the server’s full log/);
  assert.equal(nextStep(entry({ level: 'info', event: 'unclassified', label: 'Unclassified server event' })), null);
});

test('server events: empty, filtered-empty, trimmed, quiet-level and restarted states say so', () => {
  let html = render(props({ data: page(), filters: { level: 'info', q: '', boton: '' } }));
  assert.match(html, /Nothing logged yet since the server started/);
  html = render(props({ data: page({ kept: 4 }), filters: { level: 'warn', q: 'push', boton: '' } }));
  assert.match(html, /No kept event matches these filters\. Choose Everything to see the rest\./);
  html = render(props({ data: page({ kept: 1000, dropped: 12, oldestAt: ago(600_000), threshold: 'warn' }) }));
  assert.match(html, /12 older events were let go to keep within 1000 events and 512 KB, so the oldest kept is from <time/);
  assert.match(html, /BOTONS_LOG_LEVEL is warn/);
  html = render(props({ data: page(), restartedAt: ago(30_000) }));
  assert.match(html, /The server restarted <time[^>]*>just now<\/time>: events from before then are only in its full log/);
});

test('server events: a failed refresh keeps the events with the error and Retry; a first load that fails shows only the error', () => {
  const lines = [entry({ level: 'warn', event: 'push.failed', label: 'push failed', help: 'push', fields: { status: 500 } })];
  let html = render(props({ data: page({ entries: lines, kept: 1 }), entries: lines, error: 'Server unreachable', loadedAt: ago(5 * 60_000) }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn&#x27;t refresh the server events: Server unreachable\. These events are from <time[^>]*>5 min/);
  assert.match(html, /push failed/);
  assert.match(html, /Push notifications below/);
  html = render(props({ error: 'Server unreachable' }));
  assert.match(html, /Couldn&#x27;t load the server events: Server unreachable/);
  assert.doesNotMatch(html, /Loading…<\/p>/);
});

test('server events: next steps come from the event, and none for an ordinary info event', () => {
  assert.equal(nextStep(entry({})), null);
  assert.match(nextStep(entry({ level: 'warn', help: 'usage-limit' })) ?? '', /another brain/);
  assert.match(nextStep(entry({ level: 'error', help: 'brain' })) ?? '', /Brains above/);
  assert.match(nextStep(entry({ level: 'warn', help: 'run' })) ?? '', /run history/);
  assert.match(nextStep(entry({ level: 'warn', help: 'tailscale' })) ?? '', /Tailscale/);
  assert.match(nextStep(entry({ level: 'warn', help: 'auth-off' })) ?? '', /BOTONS_AUTH/);
  assert.match(nextStep(entry({ level: 'error', event: 'turn.ended', label: 'turn ended' })) ?? '', /bug report/);
  for (const outcome of ['error', 'timeout', 'interrupted']) {
    assert.match(nextStep(entry({ level: 'error', event: 'turn.ended', fields: { runId: 'run_kevin001', outcome } })) ?? '', /Runs to check/);
  }
  assert.equal(nextStep(entry({ event: 'turn.ended', fields: { runId: 'run_kevin001', outcome: 'ok' } })), null);
});
