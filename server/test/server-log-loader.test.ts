// Settings → Server events' loading and ordering (web/src/server-log-loader.ts), with a fake fetch and manual timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecentLogEntry, RecentLogs } from '../../shared/types.ts';
import { type LogFilters, ServerLogLoader } from '../../web/src/server-log-loader.ts';

interface Call {
  filters: LogFilters;
  before?: number;
  resolve: (r: RecentLogs) => void;
  reject: (e: Error) => void;
}

function harness() {
  const calls: Call[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const loader = new ServerLogLoader({
    fetch: (filters, before) => new Promise((resolve, reject) => calls.push({ filters, before, resolve, reject })),
    errorText: (e) => (e as Error).message,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { live: boolean }).live = false),
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn();
  };
  return { loader, calls, timers, fire };
}

const flush = () => new Promise((r) => setImmediate(r));
const line = (seq: number, label = `line ${seq}`): RecentLogEntry => ({ seq, ts: new Date().toISOString(), level: 'warn', event: 'unclassified', label, help: null, fields: {} });
const answer = (since: string, seqs: number[], more: boolean): RecentLogs => ({
  entries: seqs.map((n) => line(n)),
  more,
  since,
  oldestAt: null,
  dropped: 0,
  kept: seqs.length,
  counts: { info: 0, warn: seqs.length, error: 0 },
  bytes: 0,
  limits: { entries: 1000, bytes: 512 * 1024, page: 200 },
  threshold: 'info',
});
const A = '2026-11-05T10:00:00.000Z';
const B = '2026-11-05T11:00:00.000Z';

test('server log: Show older answered by a restarted server drops the old lines and loads the newest without the old cursor', async () => {
  const { loader, calls, fire } = harness();
  loader.start();
  fire();
  calls[0].resolve(answer(A, [30, 29, 28], true));
  await flush();
  assert.deepEqual(loader.state.entries.map((e) => e.seq), [30, 29, 28]);

  loader.older();
  assert.equal(calls[1].before, 28);
  // The new process has its own seq numbers: 1 and 2 would sit under the old lines, out of order, and 2 repeat later.
  calls[1].resolve(answer(B, [2, 1], false));
  await flush();
  assert.equal(calls.length, 3, 'the newest is loaded again');
  assert.equal(calls[2].before, undefined, 'without the old cursor');
  assert.equal(loader.state.entries.length, 0, 'the old lines are gone meanwhile');
  assert.equal(loader.state.restartedAt, B);
  calls[2].resolve(answer(B, [3, 2, 1], false));
  await flush();
  const seqs = loader.state.entries.map((e) => e.seq);
  assert.deepEqual(seqs, [3, 2, 1]);
  assert.equal(new Set(seqs).size, seqs.length, 'no repeated keys');
  assert.equal(loader.state.data?.since, B);
  assert.equal(loader.state.loading, false);
});

test('server log: a filter change clears the old lines at once; an old answer landing before the timer and a failed replacement leave nothing stale', async () => {
  const { loader, calls, timers, fire } = harness();
  loader.start();
  fire();
  calls[0].resolve(answer(A, [10, 9], true));
  await flush();
  loader.refresh();
  const old = calls[1];

  loader.setFilters({ level: 'error', q: 'push', boton: '' });
  assert.equal(timers.at(-1)!.ms, 300, 'a search waits for a pause in typing');
  assert.equal(loader.state.entries.length, 0, 'the lines for the old filters go at once');
  assert.ok(loader.state.data === null);
  assert.equal(loader.state.loading, true);

  old.resolve(answer(A, [12, 11, 10, 9], true));
  await flush();
  assert.equal(loader.state.entries.length, 0, 'an answer for the old filters changes nothing');
  assert.ok(loader.state.data === null);

  fire();
  const next = calls[2];
  assert.deepEqual(next.filters, { level: 'error', q: 'push', boton: '' });
  next.reject(new Error('offline'));
  await flush();
  assert.equal(loader.state.error, 'offline');
  assert.equal(loader.state.loading, false);
  assert.equal(loader.state.entries.length, 0, 'no lines from other filters under the new ones');
  assert.ok(loader.state.data === null, 'so the view says it could not load, not refresh');
});

test('server log: typing replaces the pending search; a failed refresh keeps its own lines; stop cancels the pending load', async () => {
  const { loader, calls, fire } = harness();
  loader.start();
  fire();
  calls[0].resolve(answer(A, [5], false));
  await flush();
  loader.setFilters({ level: 'warn', q: 'p', boton: '' });
  loader.setFilters({ level: 'warn', q: 'pu', boton: '' });
  fire();
  assert.equal(calls.length, 2, 'one load for the pause, not one per key');
  assert.equal(calls[1].filters.q, 'pu');
  calls[1].resolve(answer(A, [5], false));
  await flush();
  loader.refresh();
  calls[2].reject(new Error('offline'));
  await flush();
  assert.equal(loader.state.error, 'offline');
  assert.deepEqual(loader.state.entries.map((e) => e.seq), [5], 'a refresh of the same filters keeps its lines');

  loader.setFilters({ level: 'info', q: '', boton: '' });
  loader.stop();
  fire();
  assert.equal(calls.length, 3, 'nothing loads after stop');
});
