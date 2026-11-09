// Settings → Server events: GET /api/logs and the allowlisted, bounded, in-memory selection behind it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ConnectorTest, RecentLogEntry, RecentLogs as RecentLogsAnswer } from '../../shared/types.ts';
import { captureLogs, log, tapLogs } from '../src/log.ts';
import { CATALOG_MESSAGES, RECENT_LOG_BYTES, RECENT_LOG_ENTRIES, RECENT_LOG_PAGE, RecentLogs, UNCLASSIFIED } from '../src/recent-logs.ts';
import { addConnector, setup, signIn } from './oauth-helpers.ts';
import { startServer, tempDir, useTestCodexHome } from './helpers.ts';

useTestCodexHome(tempDir());

const buffer = () => new RecentLogs({ threshold: () => 'info' });
const KEVIN = 'bot_kevin001';
const STUART = 'bot_stuart01';
/** Every page of a buffer, newest first. */
function everything(b: RecentLogs): RecentLogEntry[] {
  const all: RecentLogEntry[] = [];
  let page = b.list({ limit: RECENT_LOG_PAGE });
  all.push(...page.entries);
  while (page.more) {
    page = b.list({ limit: RECENT_LOG_PAGE, before: all.at(-1)!.seq });
    all.push(...page.entries);
  }
  return all;
}
/** What the owner could ever see of a buffer: every kept entry, as the API sends it. */
const shown = (b: RecentLogs) => JSON.stringify(everything(b));

// Text a line may carry that must never be shown: each check below looks for these markers in the whole answer.
const MARK = 'zqx';
const ADVERSARIAL: Record<string, unknown> = {
  // JSON nested past any walk's depth or budget, holding an escaped password.
  deepJson: `${'{"a":'.repeat(64)}{"password":"${MARK}-pw\\" still pw"}${'}'.repeat(64)}`,
  budgetJson: JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i === 499 ? `${MARK}-last` : 'x']))),
  escapedJson: JSON.stringify(JSON.stringify({ password: `${MARK} with "quotes" and spaces` })),
  // URL userinfo holding a space, which the URL parser reads as userinfo.
  spaceInPassword: `https://sam:${MARK}123 456@127.0.0.1/x`,
  spaceInUser: `https://sa m:${MARK}tiny@example.com/`,
  quotedUser: `https://sam:${MARK}'pw@127.0.0.1/x`,
  prose: `the password is ${MARK}hunter2`,
  path: `/home/you/.botons/workspaces/${KEVIN}/${MARK}-diary.md`,
  email: `${MARK}@example.com`,
  bearer: `Bearer ${MARK}abcdefghijklmnop`,
  invisible: `pass​word=${MARK}`,
};

test('recent logs: the catalog holds exactly the fixed messages the server logs', () => {
  const src = resolve(import.meta.dirname, '../src');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && f !== 'recent-logs.ts');
  const found = new Set<string>();
  for (const f of files) {
    // Match a complete quoted literal, including escapes; evaluate only that literal to decode its value.
    const calls = /\blog\.(?:info|warn|error)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
    for (const match of readFileSync(join(src, f), 'utf8').matchAll(calls)) {
      found.add(runInNewContext(match[1], Object.create(null), { timeout: 100 }) as string);
    }
  }
  assert.ok(found.size > 50, `${found.size} messages found`);
  const catalog = new Set(CATALOG_MESSAGES);
  assert.equal(catalog.size, CATALOG_MESSAGES.length, 'no message twice');
  assert.deepEqual([...found].filter((m) => !catalog.has(m)).sort(), [], 'a fixed message the catalog lacks');
  assert.deepEqual([...catalog].filter((m) => !found.has(m)).sort(), [], 'a catalog message the server no longer logs');
});

test('recent logs: a known message becomes its fixed event, label and next step; any other message is unclassified', () => {
  const b = buffer();
  b.add('warn', 'OAuth refresh refused: the connector needs signing in again', { connectionId: 'oac_stuart01' });
  b.add('error', 'push failed', {});
  b.add('info', 'webhook', {});
  b.add('error', `could not read /home/you/.botons/${MARK}-secret.txt`, {});
  b.add('warn', 'OAuth refresh refused: the connector needs signing in again ', {});
  b.add('warn', 'oauth refresh refused: the connector needs signing in again', {});
  b.add('warn', `push failed${MARK}`, {});
  const [x6, x5, x4, x3, webhook, push, oauth] = b.list().entries;
  assert.deepEqual(
    { event: oauth.event, label: oauth.label, help: oauth.help, fields: oauth.fields },
    { event: 'oauth.refresh_refused', label: 'OAuth refresh refused: the connector needs signing in again', help: 'reconnect', fields: { connectionId: 'oac_stuart01' } },
  );
  assert.deepEqual([push.event, push.help], ['push.failed', 'push']);
  assert.deepEqual([webhook.event, webhook.label], ['webhook.request', 'webhook request']);
  for (const e of [x3, x4, x5, x6]) assert.deepEqual([e.event, e.label, e.help], [UNCLASSIFIED.event, UNCLASSIFIED.label, null], 'only an exact match is known');
  assert.ok(!shown(b).includes(MARK));
  for (const e of b.list().entries) assert.deepEqual(Object.keys(e).sort(), ['event', 'fields', 'help', 'label', 'level', 'seq', 'ts']);
});

test('recent logs: the managed browser\'s events keep their counts and flags, never its reasons or errors', () => {
  const b = buffer();
  b.add('info', 'browser started', { botId: KEVIN, headless: true, sandbox: true });
  b.add('info', 'browser sites changed', { botId: KEVIN, sites: 2 });
  b.add('info', 'the managed browser is not available', { why: ADVERSARIAL.path });
  b.add('error', 'the browser did not start', { botId: KEVIN, err: Object.assign(new Error(`${MARK} chromium`), { code: 'ENOENT' }) });
  const [failed, unavailable, sites, started] = b.list().entries;
  assert.deepEqual([started.event, started.fields], ['browser.started', { botId: KEVIN, headless: true, sandbox: true }]);
  assert.deepEqual([sites.event, sites.fields], ['browser.sites_changed', { botId: KEVIN, sites: 2 }]);
  assert.deepEqual([unavailable.event, unavailable.fields], ['browser.unavailable', {}]);
  assert.deepEqual([failed.event, failed.fields], ['browser.start_failed', { botId: KEVIN, errorCategory: 'not-found' }]);
  assert.ok(!shown(b).includes(MARK));
});

test('recent logs: only allowlisted fields are kept, each only when its check passes; everything else is left out', () => {
  const b = buffer();
  b.add('error', 'turn ended', {
    botId: KEVIN,
    routineId: 'rt_k3j9x2ab',
    runId: 'run_k3j9x2ab',
    provider: 'claude-cli',
    trigger: 'schedule',
    outcome: 'timeout',
    status: 503,
    exitCode: 137,
    durationMs: 1234,
    timedOut: true,
    signal: 'SIGKILL',
    // Never read: not in the allowlist, whatever they hold.
    token: `mdt_${MARK}`,
    reason: ADVERSARIAL.prose,
    url: ADVERSARIAL.spaceInPassword,
    path: ADVERSARIAL.path,
    stderr: `${MARK} stderr`,
    connector: `oauth:${MARK}`,
    skill: MARK,
    name: MARK,
    ...ADVERSARIAL,
  });
  const [e] = b.list().entries;
  assert.deepEqual(e.fields, {
    botId: KEVIN,
    routineId: 'rt_k3j9x2ab',
    runId: 'run_k3j9x2ab',
    provider: 'claude-cli',
    trigger: 'schedule',
    outcome: 'timeout',
    status: 503,
    exitCode: 137,
    durationMs: 1234,
    timedOut: true,
    signal: 'SIGKILL',
  });
  assert.ok(!shown(b).includes(MARK));
});

test('recent logs: a secret or a payload under an allowlisted name is left out, not shown or masked', () => {
  const b = buffer();
  const values: unknown[] = [
    `mdt_${'a'.repeat(43)}`,
    `bot_${MARK}${'a'.repeat(40)}`,
    `bot_${MARK}a12345`,
    'bot_ABCDEFGH',
    `bot_${MARK}12`,
    'bot_kevin00 ',
    ' bot_kevin001',
    'bot_kevin001\n',
    'run_K3J9X2AB',
    `${KEVIN}${MARK}`,
    `${MARK}`.repeat(10_000),
    Object.assign(new String(KEVIN), { [MARK]: 1 }),
    [KEVIN],
    { id: KEVIN },
    ...Object.values(ADVERSARIAL),
  ];
  for (const v of values) {
    b.add('info', 'turn started', {
      botId: v,
      fromBotId: v,
      runId: v,
      approvalId: v,
      connectionId: v,
      provider: v,
      trigger: v,
      status: v,
      exitCode: v,
      durationMs: v,
      ok: v,
      limit: v,
      error: v,
    });
  }
  for (const n of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 2 ** 60, -0.5]) b.add('info', 'push failed', { status: n, durationMs: n, attempt: n });
  for (const n of [99, 600, 200.5]) b.add('info', 'push failed', { status: n });
  b.add('info', 'push failed', { ok: 'true', timedOut: 1, provider: 'Claude-cli', trigger: 'schedule ', error: 'invalid_grant: ' + MARK });
  for (const e of b.list({ limit: 200 }).entries) assert.deepEqual(e.fields, {}, JSON.stringify(e.fields));
  assert.ok(!shown(b).includes(MARK));
  b.add('warn', 'OAuth refresh refused: the connector needs signing in again', { error: 'invalid_grant', status: 400, limit: 'pair', durationMs: 0 });
  assert.deepEqual(b.list({ limit: 1 }).entries[0].fields, { status: 400, limit: 'pair', durationMs: 0, oauthError: 'invalid_grant' });
});

test('recent logs: a thrown value becomes a fixed error category, never its message, stack or other properties', () => {
  const b = buffer();
  const sys = Object.assign(new Error(`connect ECONNREFUSED ${MARK}`), { code: 'ECONNREFUSED', address: MARK, stack: `${MARK} at /home/you` });
  const fetchErr = new TypeError(`fetch failed ${MARK}`, { cause: Object.assign(new Error(MARK), { code: 'ENOTFOUND', hostname: MARK }) });
  const cases: [unknown, string][] = [
    [sys, 'connection-refused'],
    [fetchErr, 'dns'],
    [Object.assign(new Error(MARK), { code: 'ENOSPC' }), 'disk-full'],
    [{ code: 'ETIMEDOUT', message: MARK }, 'timeout'],
    [new Error(ADVERSARIAL.deepJson as string), 'other'],
    [Object.assign(new Error(MARK), { code: `E${MARK}` }), 'other'],
    [Object.assign(new Error(MARK), { code: 'toString' }), 'other'],
    [Object.assign(new Error(MARK), { code: 'ECONNREFUSED'.padEnd(10_000, 'X') }), 'other'],
    [ADVERSARIAL.spaceInPassword, 'other'],
    [42, 'other'],
  ];
  for (const [err] of cases) b.add('error', 'job failed', { err });
  const got = b.list({ limit: 200 }).entries.reverse().map((e) => e.fields.errorCategory);
  assert.deepEqual(got, cases.map(([, c]) => c));
  b.add('error', 'job failed', { err: null });
  b.add('error', 'job failed', { err: undefined });
  for (const e of b.list({ limit: 2 }).entries) assert.ok(!('errorCategory' in e.fields));
  assert.ok(!shown(b).includes(MARK));
});

test('recent logs: capturing a line runs none of its code: no getter, proxy trap, toJSON, toString or prototype', () => {
  const b = buffer();
  let ran = 0;
  const count = () => {
    ran++;
    return KEVIN;
  };
  const trap = new Proxy({}, { get: () => (ran++, KEVIN), getOwnPropertyDescriptor: () => (ran++, { value: KEVIN, configurable: true, enumerable: true }), ownKeys: () => (ran++, ['botId']), has: () => (ran++, true), getPrototypeOf: () => (ran++, Error.prototype) });
  const accessors = Object.defineProperties({}, Object.fromEntries(['botId', 'runId', 'status', 'err', 'error', 'code', 'cause'].map((k) => [k, { get: count, enumerable: true }])));
  const sneaky = Object.create(
    { botId: KEVIN, code: 'ECONNREFUSED', toJSON: count, toString: count },
    { valueOf: { value: count }, [Symbol.toPrimitive]: { value: count } },
  );
  const errWithTrapCause = Object.assign(new Error('x'), { cause: trap });
  const errWithGetterCode = Object.defineProperty(new Error('x'), 'code', { get: count });
  const lines: unknown[] = [
    trap,
    accessors,
    sneaky,
    { err: trap },
    { err: errWithTrapCause },
    { err: errWithGetterCode },
    { err: sneaky },
    { botId: trap, runId: sneaky, status: { valueOf: count }, provider: { toString: count }, error: { [Symbol.toPrimitive]: count } },
    Object.setPrototypeOf({ botId: KEVIN }, trap),
  ];
  for (const fields of lines) b.add('error', trap as unknown as string, fields);
  b.add('error', sneaky, {});
  assert.equal(ran, 0, 'nothing of the line ran');
  const entries = b.list({ limit: 200 }).entries.reverse();
  assert.deepEqual(entries[0].fields, {}, 'a proxy for the fields is read as no fields');
  assert.deepEqual(entries[2].fields, {}, 'inherited values are not own values');
  assert.deepEqual(entries.slice(3, 7).map((e) => e.fields.errorCategory), ['other', 'other', 'other', 'other']);
  assert.deepEqual(entries[8].fields, { botId: KEVIN }, 'own data values are read, whatever the prototype');
  for (const e of entries) assert.equal(e.event, 'unclassified');
});

test('recent logs: a line costs the same whatever it holds: 10,000 fields and long strings stay cheap and unread', () => {
  const b = buffer();
  let ran = 0;
  const long = `${MARK}${'x'.repeat(4_000_000)}`;
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 10_000; i++) Object.defineProperty(wide, `f${i}`, { get: () => (ran++, long), enumerable: true });
  for (let i = 0; i < 16; i++) wide[`s${i}`] = long;
  Object.assign(wide, { botId: long, reason: long, error: long, err: Object.assign(new Error(long), { code: long }) });
  const start = performance.now();
  for (let i = 0; i < 200; i++) b.add('error', long, wide);
  for (let i = 0; i < 200; i++) b.add('error', 'job failed', wide);
  const ms = performance.now() - start;
  assert.equal(ran, 0, 'no field outside the allowlist was read');
  assert.ok(ms < 500, `400 lines took ${Math.round(ms)} ms`);
  const [e] = b.list().entries;
  assert.deepEqual(e.fields, { errorCategory: 'other' });
  assert.ok(!shown(b).includes(MARK));
});

test('GET /api/logs: paired devices only; Boton, sandboxed and anonymous callers are refused', async () => {
  const s = await startServer();
  const kevin = await s.newBot('Kevin');
  assert.equal((await s.call('GET', '/api/logs')).status, 200);
  assert.equal((await s.call('GET', '/api/logs', undefined, s.app.auth.mintBotonToken(kevin.id, { sandboxed: false }).token)).status, 403);
  assert.equal((await s.call('GET', '/api/logs', undefined, s.app.auth.mintBotonToken(kevin.id, { sandboxed: true }).token)).status, 403);
  assert.equal((await s.call('GET', '/api/logs', undefined, null)).status, 401);
  for (const bad of ['level=debug', 'level=all', 'before=0', 'before=x', 'limit=-1', 'limit=1.5']) {
    const r = await s.call('GET', `/api/logs?${bad}`);
    assert.equal(r.status, 400, bad);
  }
  await s.stop();
});

test('GET /api/logs: what the server logs arrives as events with checked fields; a restart starts the view again', async () => {
  const home = tempDir();
  let s = await startServer({ home });
  const kevin = await s.newBot('Kevin');
  const logs = captureLogs();
  const secret = `dummy_refresh_${MARK}7f3a9c1b2d4e5f60718293`;
  try {
    log.warn('OAuth refresh refused: the connector needs signing in again', { connectionId: 'oac_kevin001', error: `invalid_grant for ${secret}` });
    log.error('job failed', { botId: kevin.id, err: Object.assign(new Error(`could not write ${join(home, 'workspaces', kevin.id, `${MARK}.md`)}`), { code: 'EACCES' }) });
    log.info('file uploaded', { botId: kevin.id, path: `private/${MARK}.md`, size: 12 });
    for (const [k, v] of Object.entries(ADVERSARIAL)) log.warn(String(v), { [k]: v, botId: v, err: new Error(String(v)) });
  } finally {
    logs.restore();
  }
  let r = await s.call<RecentLogsAnswer>('GET', '/api/logs?level=warn&limit=200');
  assert.equal(r.status, 200, r.text);
  const known = r.data.entries.filter((e) => e.event !== 'unclassified' && e.event !== 'trash.no_handles');
  assert.deepEqual(known.map((e) => e.event), ['jobs.failed', 'oauth.refresh_refused']);
  assert.deepEqual(known[0].fields, { botId: kevin.id, errorCategory: 'permission' });
  assert.deepEqual(known[1].fields, { connectionId: 'oac_kevin001' });
  const unknown = r.data.entries.filter((e) => e.event === 'unclassified');
  assert.equal(unknown.length, Object.keys(ADVERSARIAL).length);
  for (const e of unknown) assert.deepEqual([e.label, e.fields], [UNCLASSIFIED.label, { errorCategory: 'other' }]);
  r = await s.call<RecentLogsAnswer>(`GET`, `/api/logs?boton=${kevin.id}&q=uploaded`);
  assert.equal(r.data.entries.length, 1);
  assert.deepEqual(r.data.entries[0].fields, { botId: kevin.id, size: 12 });
  const all = (await s.call('GET', '/api/logs?limit=200')).text;
  for (const leak of [MARK, home, 'sam:', 'password']) assert.ok(!all.includes(leak), leak);
  assert.ok(r.data.since <= new Date().toISOString());
  assert.equal(r.data.threshold, 'info');
  const before = r.data.since;
  await s.stop();

  // A new process starts empty of the old one's events.
  s = await startServer({ home });
  r = await s.call<RecentLogsAnswer>('GET', '/api/logs?level=warn');
  assert.ok(r.data.since > before, 'a new since');
  assert.ok(!r.data.entries.some((e) => e.event === 'jobs.failed'), "the old process's events are gone");
  await s.stop();
});

test('GET /api/logs: a token an OAuth server reflects back in its error never reaches the view', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  await signIn(s, fake, c.id);
  const quiet = captureLogs();
  try {
    fake.opts.reflectToken = 'error';
    const r = await s.call<ConnectorTest>('POST', `/api/connectors/${encodeURIComponent('oauth:fleet')}/test`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.outcome, 'failed');
  } finally {
    fake.opts.reflectToken = null;
    quiet.restore();
  }
  const view = await s.call<RecentLogsAnswer>('GET', '/api/logs?q=connector');
  assert.ok(view.data.entries.some((e) => e.event === 'connector.test_failed' && e.help === 'connector'), view.text);
  const tokens = [...new Set(fake.mcpCalls.map((m) => m.token).filter((t): t is string => !!t))];
  assert.ok(tokens.length > 0);
  const text = (await s.call('GET', '/api/logs?limit=200')).text;
  for (const tok of tokens) assert.ok(!text.includes(tok));
  await s.stop();
});

test('recent logs: bounded by events and by UTF-8 bytes, newest kept, and what was let go is counted', () => {
  const b = buffer();
  for (let i = 0; i < RECENT_LOG_ENTRIES + 25; i++) b.add('info', 'run queued', { attempt: i });
  let r = b.list({ limit: 1 });
  assert.equal(r.kept, RECENT_LOG_ENTRIES);
  assert.equal(r.dropped, 25);
  assert.equal(r.entries[0].fields.attempt, RECENT_LOG_ENTRIES + 24);
  assert.ok(r.more);

  // The longest labels, with typographic quotes (three UTF-8 bytes each), and every field filled.
  const big = buffer();
  const full = {
    botId: KEVIN, fromBotId: STUART, routineId: 'rt_k3j9x2ab', runId: 'run_k3j9x2ab', retryOf: 'run_k3j9x2ac', approvalId: 'apr_k3j9x2ab',
    connectionId: 'oac_k3j9x2ab', threadId: 'thr_k3j9x2ab', deviceId: 'dev_k3j9x2ab', templateId: 'tpl_k3j9x2ab', provider: 'claude-cli',
    trigger: 'schedule', kind: 'routine', outcome: 'interrupted', decision: 'allow', session: 'resume', was: 'running', status: 'succeeded',
    method: 'OPTIONS', channel: 'ntfy', origin: 'unhandledRejection', signal: 'SIGKILL', limit: 'total', ok: true, always: true, inTurn: true,
    duplicate: true, rotated: true, timedOut: true, sessionLost: true, workFeed: true, exitCode: -1_000_000, durationMs: 1e12, timeLimitMs: 1e12,
    retryInMs: 1e12, attempt: 1e9, attempts: 1e9, routines: 1e9, tools: 1e9, messages: 1e9, max: 1e9, hop: 1e9, size: 1e9, interrupted: 1e9,
    skipped: 1e9, error: 'temporarily_unavailable', err: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
  };
  for (let i = 0; i < 2 * RECENT_LOG_ENTRIES; i++) big.add('warn', 'could not read a connector’s work feed; trying again later', full);
  r = big.list();
  const kept = everything(big);
  assert.ok(Object.keys(kept[0].fields).length >= 45, 'every field passed its check');
  const bytes = kept.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0);
  assert.equal(r.bytes, bytes, 'reported bytes are the UTF-8 size of the kept entries');
  assert.ok(bytes > kept.reduce((n, e) => n + JSON.stringify(e).length, 0), 'and not UTF-16 code units');
  assert.ok(r.bytes <= RECENT_LOG_BYTES, `${r.bytes}`);
  assert.ok(r.kept < RECENT_LOG_ENTRIES, 'the byte limit came first');
  assert.equal(r.dropped, 2 * RECENT_LOG_ENTRIES - r.kept);
  assert.equal(r.limits.page, RECENT_LOG_PAGE);
  assert.equal(buffer().list().oldestAt, null, 'nothing kept yet');
  big.add('debug', 'run queued', {});
  assert.equal(big.list().kept, r.kept, 'debug is never kept');
});

test('recent logs: filters by least severity, Boton and text, newest first, and pages with before', () => {
  const b = buffer();
  b.add('info', 'turn started', { botId: KEVIN });
  b.add('warn', 'push failed', { botId: STUART, status: 500 });
  b.add('error', 'job failed', { botId: KEVIN, err: { code: 'ENOSPC' } });
  b.add('info', 'ask answered', { botId: STUART, fromBotId: KEVIN });
  const events = (o: Parameters<RecentLogs['list']>[0]) => b.list(o).entries.map((e) => e.label);
  assert.deepEqual(events({}), ['ask answered', 'job failed', 'push failed', 'turn started']);
  assert.deepEqual(events({ level: 'warn' }), ['job failed', 'push failed']);
  assert.deepEqual(events({ level: 'error' }), ['job failed']);
  assert.deepEqual(events({ level: 'bogus' }), events({}), 'an unknown level is everything (the API refuses it first)');
  assert.deepEqual(events({ boton: KEVIN }), ['ask answered', 'job failed', 'turn started']);
  assert.deepEqual(events({ q: 'DISK-full' }), ['job failed'], 'field values match, ignoring case');
  assert.deepEqual(events({ q: 'push' }), ['push failed']);
  assert.deepEqual(events({ q: 'jobs.failed' }), ['job failed'], 'event codes match');
  const first = b.list({ limit: 2 });
  assert.equal(first.more, true);
  assert.deepEqual(events({ limit: 2, before: first.entries[1].seq }), ['push failed', 'turn started']);
  assert.deepEqual(b.list().counts, { info: 2, warn: 1, error: 1 });
});

test('recent logs: a tap sees lines while started, nothing after stop, and a tap that throws costs the line nothing', () => {
  const b = buffer().start();
  const broken = tapLogs(() => {
    throw new Error('tap broke');
  });
  const logs = captureLogs();
  try {
    log.info('run queued', { attempt: 1 });
    log.debug('run cancelled', {});
    b.stop();
    b.stop();
    log.warn('push failed', {});
  } finally {
    broken();
    logs.restore();
  }
  assert.deepEqual(b.list().entries.map((e) => e.event), ['run.queued']);
  assert.deepEqual(logs.lines.map((l) => l.msg), ['run queued', 'run cancelled', 'push failed'], 'every line is still written');
});

test('recent logs: paging with before stays stable while new events keep arriving and old ones are let go', () => {
  const b = buffer();
  for (let i = 0; i < RECENT_LOG_ENTRIES; i++) b.add('info', 'run queued', { attempt: i });
  const seen: number[] = [];
  let page = b.list({ limit: RECENT_LOG_PAGE });
  seen.push(...page.entries.map((e) => e.seq));
  while (page.more) {
    // Events land between pages, pushing the oldest out.
    for (let i = 0; i < 50; i++) b.add('warn', 'push failed', {});
    page = b.list({ limit: RECENT_LOG_PAGE, before: seen.at(-1) });
    seen.push(...page.entries.map((e) => e.seq));
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] < seen[i - 1], 'newest first, no event twice');
  assert.equal(seen[0], RECENT_LOG_ENTRIES);
  assert.ok(seen.at(-1)! > 1, 'the events let go meanwhile are not returned');
  assert.equal(b.list().kept, RECENT_LOG_ENTRIES);
});
