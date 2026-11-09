// Settings → Health and backups (web/src/components/Operations.tsx), rendered in Node: Vite bundles the component
// for SSR into a temp folder and react-dom/server renders it.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { OperationsStatus, RestoreRehearsal } from '../../shared/types.ts';
import { tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const out = tempDir();
// A virtual entry, resolved as if it sat in web/src so its imports find the web app's packages.
const ENTRY = join(repo, 'web/src/operations-render-entry.tsx');
const { build } = await import('vite');
await build({
  configFile: false,
  root: join(repo, 'web'),
  logLevel: 'silent',
  plugins: [
    {
      name: 'operations-entry',
      resolveId: (id) => (id === ENTRY ? id : null),
      load: (id) =>
        id === ENTRY
          ? `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationsView, diagnostics } from './components/Operations.tsx';
export const render = (props) => renderToStaticMarkup(createElement(OperationsView, props));
export { diagnostics };
`
          : null,
    },
  ],
  // Bundle React too: the output sits in a temp folder with no node_modules.
  ssr: { noExternal: true },
  build: { ssr: ENTRY, outDir: join(out, 'dist'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'entry.mjs' } } },
});
const { render, diagnostics } = (await import(pathToFileURL(join(out, 'dist/entry.mjs')).href)) as {
  diagnostics: (data: OperationsStatus, version: string | null) => string;
  render: (p: { loaded: { data: OperationsStatus; at: string } | null; error: string | null; onRetry: () => void; version?: string | null }) => string;
};

const data: OperationsStatus = {
  health: {
    ok: true,
    build: null,
    failing: [],
    details: { database: { ok: true, problem: null }, scheduler: { ok: true, lastTickAt: new Date().toISOString(), intervalMs: 10_000 }, providers: [], draining: false },
  },
  schema: 25,
  backups: { backups: [], total: 0, keep: 14, staleAfterHours: 48, stale: false, partial: 0, unreadable: false },
  push: { state: 'unset', last: null, lastSuccessAt: null, failuresInARow: 0, since: new Date().toISOString(), sinceSettingsChange: false },
  storage: { unreadable: false, freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, databaseBytes: 3 * 1024 ** 2, low: false, lowBelowBytes: 1024 ** 3 },
  install: 'service',
  restorableSchemas: [24, 25],
  rehearsal: { last: null, limitPerHour: 6 },
};
const noop = () => {};

test('health and backups: a failed refresh shows the error, when the shown status is from, and Retry, with the status', () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const html = render({ loaded: { data, at }, error: 'Server unreachable', onRetry: noop });
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn&#x27;t refresh health and backups: Server unreachable/);
  assert.match(html, new RegExp(`<time dateTime="${at}"[^>]*>5 min[^<]* ago</time>`));
  assert.match(html, />Retry</);
  assert.match(html, /opens and answers/, 'the last status stays on screen');
  assert.doesNotMatch(html, /refreshes every 30 seconds/);
});

test('health and backups: a good refresh says when it was updated; a first load that fails shows only the error', () => {
  const html = render({ loaded: { data, at: new Date(Date.now() - 10_000).toISOString() }, error: null, onRetry: noop });
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /Updated <time[^>]*>just now<\/time>; refreshes every 30 seconds/);
  const first = render({ loaded: null, error: 'Server unreachable', onRetry: noop });
  assert.match(first, /Couldn&#x27;t load health and backups: Server unreachable/);
  assert.doesNotMatch(first, /opens and answers/);
});

test('health and backups: an unreadable backups folder needs attention', () => {
  const html = render({ loaded: { data: { ...data, backups: { ...data.backups, unreadable: true, stale: true } }, at: new Date().toISOString() }, error: null, onRetry: noop });
  assert.match(html, /the backups folder cannot be read on the server/);
  assert.match(html, /Backups<\/strong><span class="sr-only"> \(needs attention\)/);
});

const now = () => new Date().toISOString();
const failingPush: OperationsStatus['push'] = {
  state: 'on',
  last: { at: now(), ok: false, reason: 'failure', status: 401, problem: 'refused' },
  lastSuccessAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  failuresInARow: 3,
  since: now(),
  sinceSettingsChange: false,
};

test('health: push not set up is fine and points at Push notifications, with no test button', () => {
  const html = render({ loaded: { data, at: now() }, error: null, onRetry: noop });
  assert.match(html, /Push notifications<\/strong><span class="sr-only"> \(working\)/);
  assert.match(html, /not set up: pushes about failures and approvals need an ntfy server and topic/);
  assert.doesNotMatch(html, /Send a test push/);
});

test('health: a failing push says what failed, how often, where to look, and offers a test from here', () => {
  const html = render({ loaded: { data: { ...data, push: failingPush }, at: now() }, error: null, onRetry: noop });
  assert.match(html, /Push notifications<\/strong><span class="sr-only"> \(needs attention\)/);
  assert.match(html, /the last push failed <time[^>]*>just now<\/time> \(3 in a row\): the ntfy server refused it \(401 or 403\): check the access token/);
  assert.match(html, /The last one that went through was <time[^>]*>3 h[^<]* ago<\/time>/);
  assert.match(html, />Send a test push</);
});

test('health: push turned off is said plainly, and a test can still be sent', () => {
  const html = render({ loaded: { data: { ...data, push: { ...failingPush, state: 'off', last: null, failuresInARow: 0 } }, at: now() }, error: null, onRetry: noop });
  assert.match(html, /turned off, so nobody is told about failures or approvals; none sent since the server started/);
  assert.match(html, />Send a test push</);
  const changed = render({ loaded: { data: { ...data, push: { ...failingPush, last: null, lastSuccessAt: null, failuresInARow: 0, sinceSettingsChange: true } }, at: now() }, error: null, onRetry: noop });
  assert.match(changed, /Push notifications<\/strong><span class="sr-only"> \(working\)<\/span>: <span>none sent since the push settings changed/);
});

test('health: low disk space needs attention and says what stops and what to free', () => {
  const ok = render({ loaded: { data, at: now() }, error: null, onRetry: noop });
  assert.match(ok, /Disk space<\/strong><span class="sr-only"> \(working\)<\/span>: <span>50 GB free of 100 GB \(50%\); the database is 3 MB/);
  const low = render({ loaded: { data: { ...data, storage: { ...data.storage, freeBytes: 512 * 1024 ** 2, low: true } }, at: now() }, error: null, onRetry: noop });
  assert.match(low, /Disk space<\/strong><span class="sr-only"> \(needs attention\)/);
  assert.match(low, /512 MB free of 100 GB \(1%\).*That is low: when the disk fills, chats, runs and backups stop being saved/);
  const unreadable = render({ loaded: { data: { ...data, storage: { ...data.storage, unreadable: true } }, at: now() }, error: null, onRetry: noop });
  assert.match(unreadable, /Disk space<\/strong><span class="sr-only"> \(needs attention\)<\/span>: <span class="operations-problem">free space could not be read/);
});

test('health: the status summary names what failed and versions, never error text, hosts or paths', () => {
  const failing: OperationsStatus = {
    ...data,
    health: {
      ok: false,
      build: 'abc1234',
      failing: ['database', 'providers'],
      details: {
        database: { ok: false, problem: 'cannot-open' },
        scheduler: { ok: true, lastTickAt: '2026-11-06T10:00:00.000Z', intervalMs: 10_000 },
        providers: [
          {
            id: 'claude', label: 'Claude Code', available: false, installed: true, version: '9.9.9', loggedIn: false, problem: 'signed-out',
            lastSuccessAt: null, lastErrorAt: '2026-11-06T09:00:00.000Z', usageLimitUntil: null,
            readiness: { state: 'signed-out', problem: 'signed-out', checkedAt: '2026-11-06T09:00:00.000Z', usageLimitUntil: null, boot: 'b1', generation: 2 },
          },
        ],
        draining: false,
      },
    },
    push: failingPush,
    storage: { ...data.storage, low: true },
  };
  const text = diagnostics(failing, '1.2.3');
  assert.match(text, /^Botons 1\.2\.3, build abc1234, schema 25, service$/m);
  assert.match(text, /^Health: failing: database, providers$/m);
  assert.match(text, /^Database: NEEDS ATTENTION \(cannot-open\)$/m);
  assert.match(text, /^Brain claude: not ready \(signed-out\), installed yes, signed in no, version 9\.9\.9, last turn failed 2026-11-06T09:00:00\.000Z$/m);
  assert.match(text, /^Push: on, last failed \(refused, HTTP 401\) .*, 3 failures in a row$/m);
  assert.match(text, /^Disk: 50 GB free of 100 GB \(LOW\), database 3 MB$/m);
  for (const secret of ['SQLITE_CANTOPEN', '/home/you', 'myhost', 'sam@example.com', 'auth failed']) assert.ok(!text.includes(secret), secret);
  const html = render({ loaded: { data: failing, at: now() }, error: null, onRetry: noop, version: '1.2.3' });
  assert.match(html, /Status summary for asking for help/);
  assert.match(html, /<pre class="code">Botons 1\.2\.3, build abc1234/);
  assert.match(html, /Database<\/strong><span class="sr-only"> \(needs attention\)<\/span>: <span class="operations-problem">cannot be read: the file can&#x27;t be opened: check that the data folder exists/);
  assert.match(html, /none is ready \(Claude Code: not signed in\): install or sign a CLI in on the server/);
});

test('health: the status summary keeps a version, build or schema only in its expected shape, else says unknown', () => {
  const odd = 'sam@example.com at /home/you/private';
  const shaped: OperationsStatus = {
    ...data,
    health: {
      ...data.health,
      build: `${odd} myhost`,
      details: {
        ...data.health.details,
        providers: [{ id: 'claude', label: 'Claude Code', available: true, installed: true, version: odd, loggedIn: true, problem: null, lastSuccessAt: null, lastErrorAt: null, usageLimitUntil: null, readiness: { state: 'ready', problem: null, checkedAt: null, usageLimitUntil: null, boot: 'b1', generation: 1 } }],
      },
    },
    schema: odd as unknown as number,
  };
  const text = diagnostics(shaped, odd);
  assert.match(text, /^Botons unknown version, build unknown, schema unknown, service$/m);
  assert.match(text, /^Brain claude: ready, installed yes, signed in yes, version unknown$/m);
  for (const secret of ['sam@example.com', '/home/you', 'private', 'myhost']) assert.ok(!text.includes(secret), secret);
  // Known shapes are kept, and only the number of a CLI's own wording.
  const known = diagnostics({ ...shaped, health: { ...shaped.health, build: 'ABCDEF0123456', details: { ...shaped.health.details, providers: [{ ...shaped.health.details.providers[0], version: '2.1.3 (Claude Code)' }] } }, schema: 25 }, 'v0.1.0');
  assert.match(known, /^Botons 0\.1\.0, build abcdef0123456, schema 25, service$/m);
  assert.match(known, /^Brain claude: ready, .*version 2\.1\.3$/m);
});

const rehearsal = (over: Partial<RestoreRehearsal>): RestoreRehearsal => ({
  backup: '2026-11-06T03-30-00-000Z',
  startedAt: '2026-11-06T09:00:00.000Z',
  finishedAt: '2026-11-06T09:00:05.000Z',
  outcome: 'passed',
  problem: null,
  fromSchema: 24,
  toSchema: 25,
  matchesManifest: true,
  workspaces: 'checked',
  files: 12,
  folders: 4,
  bytes: 2048,
  ranBy: { version: '0.1.0', build: null, schema: 25 },
  ...over,
});
const withBackups: OperationsStatus = {
  ...data,
  backups: {
    ...data.backups,
    total: 4,
    backups: [
      { name: '2026-11-06T03-30-00-000Z', createdAt: '2026-11-06T03:30:00.000Z', schemaVersion: 25, workspaces: true, workspacesFailed: false },
      { name: '2026-11-05T03-30-00-000Z', createdAt: '2026-11-05T03:30:00.000Z', schemaVersion: 24, workspaces: true, workspacesFailed: false },
      { name: '2026-11-04T03-30-00-000Z', createdAt: '2026-11-04T03:30:00.000Z', schemaVersion: 26, workspaces: true, workspacesFailed: false },
      { name: '2026-11-03T03-30-00-000Z', createdAt: '2026-11-03T03:30:00.000Z', schemaVersion: 22, workspaces: true, workspacesFailed: false },
    ],
  },
};

test('upgrades: the running release, build and schema, and which backups its restore takes, going by their schema', () => {
  const html = render({ loaded: { data: { ...withBackups, health: { ...data.health, build: 'abcdef0123456789' } }, at: now() }, error: null, onRetry: noop, version: '0.1.0' });
  assert.match(html, /This server runs Botons 0\.1\.0, build abcdef012345, database schema 25\. Its restore takes backups at schema 24 and 25 \(older ones are upgraded at the next start\)/);
  assert.match(html, /2026-11-06T03-30-00-000Z<\/code><span class="hint"> database and workspaces \(schema 25\)<\/span><span class="hint">; this release restores it<\/span>/);
  assert.match(html, /schema 24\)<\/span><span class="hint">; this release restores it and upgrades it to schema 25 at the next start/);
  assert.match(html, /<span class="hint warn">; newer than this release \(schema 25\): restore it with the release that made it/);
  assert.match(html, /<span class="hint warn">; older than this release restores \(schema 24 or 25\)/);
  // No claim about other releases: nothing says one is available or a restart is pending.
  assert.doesNotMatch(html, /update available|new version|restart (is )?pending/i);
  const odd = render({ loaded: { data: { ...data, health: { ...data.health, build: 'myhost /home/you' } }, at: now() }, error: null, onRetry: noop, version: 'sam@example.com' });
  assert.match(odd, /This server runs Botons \(version unknown\), database schema 25/);
  assert.doesNotMatch(odd, /myhost|\/home\/you|sam@example\.com/);
});

test('restore rehearsal: none yet, running, passed with what it checked, failed with what to do', () => {
  const none = render({ loaded: { data: withBackups, at: now() }, error: null, onRetry: noop });
  assert.match(none, /Restore rehearsal<\/span><p class="hint" role="status">None yet\./);
  assert.match(none, /<option value="2026-11-06T03-30-00-000Z" selected="">2026-11-06T03-30-00-000Z \(newest\)<\/option>/);
  assert.match(none, />Rehearse a restore</);
  assert.match(none, /private temporary folder on the server.*The data folder, the backups and the running server are not changed\. One at a time, at most 6 an hour, each in the audit log/);
  assert.doesNotMatch(render({ loaded: { data, at: now() }, error: null, onRetry: noop }), />Rehearse a restore</, 'no backups, nothing to rehearse');

  const running = render({ loaded: { data: { ...withBackups, rehearsal: { last: rehearsal({ outcome: 'running', finishedAt: null, fromSchema: null, toSchema: null }), limitPerHour: 6 } }, at: now() }, error: null, onRetry: noop });
  assert.match(running, /Rehearsing <code>2026-11-06T03-30-00-000Z<\/code>, started/);
  assert.match(running, /<button type="button" class="link-btn" disabled="">Rehearsing…<\/button>/);

  const passed = render({ loaded: { data: { ...withBackups, rehearsal: { last: rehearsal({}), limitPerHour: 6 } }, at: now() }, error: null, onRetry: noop });
  assert.match(passed, /passed <time[^>]*>[^<]*<\/time>: its database \(schema 24\) passed SQLite&#x27;s integrity check, and upgraded to schema 25 as the server&#x27;s next start would; its workspaces archive \(12 files in 4 folders, 2 KB\) read through/);
  assert.doesNotMatch(passed, /rows than its manifest|rehearse again/);
  const stale = render({ loaded: { data: { ...withBackups, rehearsal: { last: rehearsal({ matchesManifest: false, workspaces: 'none', files: null, ranBy: { version: '0.1.0', build: null, schema: 24 } }), limitPerHour: 6 } }, at: now() }, error: null, onRetry: noop });
  assert.match(stale, /it holds the database only, no workspaces\. Its tables hold a different number of rows than its manifest says/);
  assert.match(stale, /That ran on schema 24; this server is at 25, so rehearse again\./);

  for (const [problem, advice] of [
    ['unsafe-archive', /holds links, special files or paths outside the folders a backup archives.*do not restore it/],
    ['upgrade-failed', /could not upgrade its database, so the server would not start after restoring it/],
    ['newer-schema', /restore it with the release that made it/],
    ['no-space', /free space on the server \(Disk space above\)/],
    ['interrupted', /stopped or restarted while it ran: rehearse again/],
    ['bogus', /something it did not expect.*server&#x27;s raw log/],
  ] as const) {
    const html = render({ loaded: { data: { ...withBackups, rehearsal: { last: rehearsal({ outcome: 'failed', problem: problem as RestoreRehearsal['problem'] }), limitPerHour: 6 } }, at: now() }, error: null, onRetry: noop });
    assert.match(html, /<span class="operations-problem"><code>2026-11-06T03-30-00-000Z<\/code> failed/, problem);
    assert.match(html, advice, problem);
  }
});

test('the status summary: restore schemas and the rehearsal in fixed words; its hint points at the raw server log, not Server events', () => {
  const base = { ...withBackups, rehearsal: { last: rehearsal({}), limitPerHour: 6 } };
  assert.match(diagnostics(base, '0.1.0'), /^Restores schemas: 24, 25$/m);
  assert.match(diagnostics(base, '0.1.0'), /^Restore rehearsal: passed 2026-11-06T09:00:05\.000Z \(schema 24 -> 25, workspaces checked\), ran on schema 25$/m);
  assert.match(diagnostics({ ...base, rehearsal: { last: null, limitPerHour: 6 } }, null), /^Restore rehearsal: none$/m);
  const odd = rehearsal({ outcome: 'failed', problem: '/home/you/x' as RestoreRehearsal['problem'], finishedAt: 'myhost', fromSchema: null, toSchema: null });
  const text = diagnostics({ ...base, rehearsal: { last: odd, limitPerHour: 6 } }, null);
  assert.match(text, /^Restore rehearsal: FAILED unknown time \(failed\), ran on schema 25$/m);
  assert.doesNotMatch(text, /home\/you|myhost|2026-11-06T03-30/);
  const html = render({ loaded: { data: base, at: now() }, error: null, onRetry: noop });
  assert.match(html, /Those are only in the server&#x27;s raw log, on its machine \(<code>journalctl --user -u botons<\/code>\): Server events below leave them out too\./);
  assert.doesNotMatch(html, /read the Server events below for those/);
  const docker = render({ loaded: { data: { ...base, install: 'docker' }, at: now() }, error: null, onRetry: noop });
  assert.match(docker, /<code>docker compose logs botons<\/code>/);
});
