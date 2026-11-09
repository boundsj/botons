// The web app's store (web/src/state.ts) run in Node against a real server.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Approval, ApprovalRequestResult, Bot, Memory, Message, PairResult, RoutineRun } from '../../shared/types.ts';
import { setDeviceToken } from '../../web/src/device.ts';
import { appendNewer, arrivedAfter, firstUnreadId, keepUnchanged, mergeLatest, prependOlder } from '../../web/src/lists.ts';
import { actions, disconnect, getState, history, live, pendingApprovals } from '../../web/src/state.ts';
import { type App, createApp } from '../src/app.ts';
import { TestEventSource } from './fixtures/event-source.ts';
import { approvedPairing, sleep, startServer, until } from './helpers.ts';

// Its own home, removed after the server restarted by a test below is closed.
const home = mkdtempSync(join(tmpdir(), 'botons-web-test-'));
// BOTONS_OAUTH_ALLOW: the connector test below reaches a stand-in MCP server on 127.0.0.1.
const s = await startServer({ home, env: { BOTONS_SCHEDULER_MS: '200', BOTONS_OAUTH_ALLOW: '127.0.0.1' }, configure: (cfg) => (cfg.ssePingMs = 100) });
let app: App = s.app;
setDeviceToken(s.token);
const paired = await s.call<PairResult>('POST', '/api/auth/pair', { secret: approvedPairing(app.store.db), label: 'Web state test' }, null);
assert.equal(paired.status, 201, paired.text);
assert.equal(paired.res.headers.get('set-cookie'), null, 'no cookie: a browser would send it to every port on the host');

/** A TCP proxy whose open connections can be made to go silent without closing. */
function freezableProxy(target: number) {
  const open = new Set<[Socket, Socket]>();
  const frozen: Socket[] = [];
  const server = createServer((client) => {
    const upstream = connect(target, '127.0.0.1');
    const pair: [Socket, Socket] = [client, upstream];
    open.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      open.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const sock of pair) sock.on('error', end).on('close', end);
  });
  return {
    server,
    freeze() {
      for (const [client, upstream] of open) {
        upstream.unpipe(client);
        client.unpipe(upstream);
        upstream.pause();
        client.pause();
        frozen.push(client, upstream);
      }
      open.clear();
    },
    close() {
      for (const sock of frozen) sock.destroy();
      for (const pair of open) for (const sock of pair) sock.destroy();
      server.close();
    },
  };
}

// The event stream goes through a proxy that can go silent like a dead network.
const proxy = freezableProxy(s.port);
await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r));
TestEventSource.base = `http://127.0.0.1:${(proxy.server.address() as { port: number }).port}`;
globalThis.EventSource = TestEventSource as unknown as typeof EventSource;
/** Requests whose path matches get a 500. */
const failing = new Set<RegExp>();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input), s.base);
  if ([...failing].some((re) => re.test(url.pathname))) return Promise.resolve(Response.json({ error: 'Injected failure' }, { status: 500 }));
  return realFetch(url, init);
};
Object.assign(live, { staleMs: 600, watchdogMs: 100, retryMs: 100, maxRetryMs: 400 });
await actions.init();
await until(() => getState().connected);

after(async () => {
  disconnect();
  globalThis.fetch = realFetch;
  proxy.close();
  if (app !== s.app) await app.close();
  rmSync(home, { recursive: true, force: true });
});

/** A request as the test's device that must succeed. */
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await s.call<T>(method, path, body);
  assert.ok(r.res.ok, `${method} ${path}: ${r.status} ${r.text}`);
  return r.data;
}
const remember = (botId: string, text: string) => api<Memory>('POST', `/api/bots/${botId}/memories`, { text });
const runNow = (routineId: string) => api<RoutineRun>('POST', `/api/routines/${routineId}/run`);

/** Resolves once `connected` has gone false and then true again. */
async function reconnected(trigger: () => unknown) {
  let dropped = false;
  const watch = setInterval(() => {
    if (!getState().connected) dropped = true;
  }, 1);
  try {
    await trigger();
    await until(() => dropped || !getState().connected);
    await until(() => getState().connected);
  } finally {
    clearInterval(watch);
  }
}

const ids = (list: { id: string }[] | undefined) => (list ?? []).map((x) => x.id);
const botHere = (id: string) => getState().bots.find((b) => b.id === id)!;

/** Route fetches through `wrap` (after the server answered, before the client sees it) for the length of `fn`. */
async function intercepting<T>(wrap: (url: URL, init: RequestInit | undefined) => Promise<unknown> | void, fn: () => Promise<T>): Promise<T> {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await fetchBefore(input, init);
    await wrap(new URL(String(input), s.base), init);
    return res;
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = fetchBefore;
  }
}

/** A Boton with `count` messages, once the client has heard about all of them (the stream is in order). */
async function botWithHistory(name: string, count: number): Promise<Bot> {
  const bot = await s.newBot(name);
  for (let i = 0; i < count; i++) app.store.addMessage(bot.id, i % 2 ? 'bot' : 'user', `${name} message ${i}`);
  await until(() => botHere(bot.id)?.lastMessage?.text === `${name} message ${count - 1}`);
  return bot;
}

test('list helpers: merging the newest page keeps older pages and newer arrivals; the New divider skips chips and own messages', () => {
  const m = (n: number) => ({ id: `m${n}` });
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => m(a + i));
  assert.deepEqual(mergeLatest(range(1, 200), range(106, 205)), { items: range(1, 205), keptOlder: true });
  assert.deepEqual(mergeLatest([...range(1, 10), m(12)], range(1, 11)), { items: [...range(1, 11), m(12)], keptOlder: false });
  assert.equal(mergeLatest(range(1, 100), range(150, 249)), null, 'more than a page arrived meanwhile');
  assert.equal(mergeLatest([], range(1, 3)), null);
  assert.deepEqual(prependOlder(range(101, 200), 'm101', range(1, 100)), range(1, 200));
  assert.equal(prependOlder(range(150, 249), 'm101', range(1, 100)), null, 'the list was replaced while the page loaded');
  assert.deepEqual(appendNewer(range(1, 100), 'm100', range(100, 150)), range(1, 150));
  assert.equal(appendNewer(range(1, 100), 'm99', range(100, 150)), null, 'the list was replaced while the page loaded');
  const at = (id: string, t: number) => ({ id, createdAt: new Date(t * 1000).toISOString() });
  assert.deepEqual(arrivedAfter([at('a', 1), at('z', 9)], [at('b', 2), at('c', 3)], new Set(['a', 'z'])), [at('z', 9)], 'kept when a page replaces the list: what arrived after it');
  assert.deepEqual(arrivedAfter([at('a', 1)], [], new Set(['a'])), [], 'an empty chat keeps nothing it held before');
  assert.deepEqual(arrivedAfter([at('a', 1), at('z', 9)], [], new Set(['a'])), [at('z', 9)], 'an empty page keeps what arrived while it loaded');

  // A refetch keeps the objects on screen for what it only repeats, so memoized chat rows don't re-render.
  const shown = [{ id: 'a', text: 'hi' }, { id: 'b', text: 'there' }];
  assert.equal(keepUnchanged(shown, structuredClone(shown)), shown, 'nothing changed: the same list');
  const edited = keepUnchanged(shown, [{ id: 'a', text: 'hi' }, { id: 'b', text: 'edited' }, { id: 'c', text: 'new' }]);
  assert.equal(edited[0], shown[0]);
  assert.deepEqual(edited.slice(1), [{ id: 'b', text: 'edited' }, { id: 'c', text: 'new' }]);
  assert.notEqual(edited[1], shown[1], 'a changed message is the new one');
  assert.deepEqual(keepUnchanged(shown, [shown[1]]), [shown[1]], 'a shorter list is a new list');

  const msgs = [
    { id: 'a', role: 'bot' }, { id: 'b', role: 'user' }, { id: 'c', role: 'bot' }, { id: 'd', role: 'event' },
    { id: 'e', role: 'error' }, { id: 'f', role: 'user' }, { id: 'g', role: 'bot' },
  ];
  assert.deepEqual([0, 1, 2, 3].map((n) => firstUnreadId(msgs, n)), [null, 'g', 'e', 'c']);
  assert.equal(firstUnreadId(msgs, 9), 'a', 'more unread than loaded: the oldest loaded reply');
});

test('the event stream sends hello, then a ping data event as its heartbeat', async () => {
  const sse = await s.events();
  const ping = await until(() => sse.events.find((e) => e.type === 'ping'));
  sse.close();
  assert.equal(sse.events[0].type, 'hello');
  assert.ok(ping.type === 'ping' && !Number.isNaN(Date.parse(ping.serverTime)));
});

test('after a server restart the panels, run history and earlier messages stay, and later changes still arrive', async () => {
  const bot = await botWithHistory('Stuart', 230);
  const routine = await s.newRoutine(bot.id, { name: 'Report', instruction: 'Say hi' });
  await runNow(routine.id);
  await until(() => app.store.listRuns(routine.id)[0]?.status === 'succeeded');
  await remember(bot.id, 'Likes tea');

  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  assert.equal(await actions.loadEarlier(bot.id), true);
  await actions.loadRoutines(bot.id);
  await actions.loadRuns(routine.id);
  await actions.loadMemories(bot.id);
  const shown = getState();
  const messages = ids(shown.messages[bot.id].items);
  assert.equal(messages.length, 200);
  assert.equal(shown.messages[bot.id].hasMore, true);

  let missed: Message;
  await reconnected(async () => {
    await s.stop();
    app = createApp(s.cfg, undefined, { tailnet: null });
    missed = app.store.addMessage(bot.id, 'bot', 'Sent while you were away');
    await app.listen();
  });

  const now = getState();
  assert.deepEqual(ids(now.messages[bot.id].items), [...messages, missed!.id], 'earlier pages kept, the missed message added, nothing reordered');
  assert.ok(
    shown.messages[bot.id].items.every((m, i) => now.messages[bot.id].items[i] === m),
    'messages the catch-up only fetched again are the same objects, so the chat does not re-render them',
  );
  assert.equal(now.messages[bot.id].hasMore, true);
  assert.equal(now.messages[bot.id].error, null);
  assert.deepEqual(ids(now.routines[bot.id]), [routine.id]);
  assert.deepEqual(ids(now.runs[routine.id]), ids(shown.runs[routine.id]));
  assert.deepEqual(ids(now.memories[bot.id]), ids(shown.memories[bot.id]));

  const later = await s.newRoutine(bot.id, { name: 'Later', instruction: 'Later' });
  await until(() => ids(getState().routines[bot.id]).includes(later.id));
  const memory = await remember(bot.id, 'Prefers mornings');
  await until(() => ids(getState().memories[bot.id]).includes(memory.id));
  const run = await runNow(routine.id);
  await until(() => ids(getState().runs[routine.id]).includes(run.id));
  actions.leaveChat(bot.id);
});

test('the watchdog replaces a stream that went silent or that the browser gave up on, and the client catches up (a routine deleted meanwhile drops out)', async () => {
  const bot = await botWithHistory('Kevin', 3);
  const routine = await s.newRoutine(bot.id, { name: 'Doomed', instruction: 'x' });
  await actions.loadMessages(bot.id);
  await actions.loadMemories(bot.id);
  await actions.loadRoutines(bot.id);
  await actions.loadRuns(routine.id);
  let before = TestEventSource.made.length;

  let missed: Message;
  let memory: Memory;
  await reconnected(async () => {
    proxy.freeze(); // like a phone going to sleep: no error, just nothing
    missed = app.store.addMessage(bot.id, 'bot', 'Nobody heard this');
    memory = app.store.addMemory(bot.id, 'Said while asleep');
    app.store.deleteRoutine(routine.id);
  });
  assert.ok(TestEventSource.made.length > before, 'a new EventSource was opened');
  assert.equal(TestEventSource.made.at(-2)!.readyState, TestEventSource.CLOSED, 'the silent one was closed');
  assert.ok(ids(getState().messages[bot.id].items).includes(missed!.id));
  assert.ok(ids(getState().memories[bot.id]).includes(memory!.id));
  assert.equal(getState().runs[routine.id], undefined);
  assert.deepEqual(ids(getState().routines[bot.id]), []);

  before = TestEventSource.made.length;
  await reconnected(() => TestEventSource.made.at(-1)!.close());
  assert.ok(TestEventSource.made.length > before);
});

test('catching up retries until it works, and the reconnect banner stays up meanwhile', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const bot = await botWithHistory('Bob', 2);
  await actions.loadMessages(bot.id);
  failing.add(/^\/api\/bots$/);
  let missed: Message;
  try {
    proxy.freeze();
    missed = app.store.addMessage(bot.id, 'bot', 'Arrived during the outage');
    await until(() => !getState().connected);
    await sleep(1200);
    assert.equal(getState().connected, false);
  } finally {
    failing.clear();
  }
  await until(() => getState().connected);
  assert.ok(ids(getState().messages[bot.id].items).includes(missed!.id));
  assert.ok(warn.mock.callCount() >= 2, 'each failed attempt is logged');
});

test('a failed message load shows an error with a working Retry, and never stays loading', async () => {
  const bot = await botWithHistory('Dave', 130);
  const path = new RegExp(`^/api/bots/${bot.id}/messages$`);

  const list = () => getState().messages[bot.id];
  actions.openChat(bot.id);
  failing.add(path);
  await actions.loadMessages(bot.id);
  assert.deepEqual([list().loading, list().error, list().items], [false, { message: 'Injected failure', retry: 'latest' }, []]);

  failing.delete(path);
  await actions.retryMessages(bot.id);
  assert.deepEqual([list().error, list().items.length], [null, 100]);

  failing.add(path);
  assert.equal(await actions.loadEarlier(bot.id), false);
  assert.deepEqual([list().loadingEarlier, list().error?.retry, list().items.length], [false, 'earlier', 100]);

  failing.delete(path);
  await actions.retryMessages(bot.id);
  assert.deepEqual([list().error, list().items.length, list().hasMore], [null, 130, false]);
  actions.leaveChat(bot.id);
});

test('a chat holds a bounded window of its history: reading back lets the newest pages go, reading forward or jumping to the latest brings them back, and live messages join only a window at the newest', async () => {
  const { page, window: size, kept } = history;
  const total = 650;
  const bot = await botWithHistory('Bob', total);
  const all = app.store.listMessages(bot.id, { limit: 500 });
  const allIds = [...app.store.listMessages(bot.id, { before: all[0].id, limit: 500 }), ...all].map((m) => m.id);
  assert.equal(allIds.length, total);
  const list = () => getState().messages[bot.id];
  const window = (from: number, to: number) => allIds.slice(from, to);

  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  assert.deepEqual([ids(list().items), list().hasMore, list().hasNewer], [window(total - page, total), true, false]);
  for (let i = 0; i < 2; i++) assert.equal(await actions.loadEarlier(bot.id), true);
  assert.deepEqual([list().items.length, list().hasNewer], [size, false], 'up to the window, nothing goes');

  // Reading back past the window: the newest page goes, and the list says newer ones exist.
  assert.equal(await actions.loadEarlier(bot.id), true);
  assert.deepEqual([ids(list().items), list().hasMore, list().hasNewer], [window(total - 4 * page, total - page), true, true]);
  for (let i = 0; i < 5; i++) await actions.loadEarlier(bot.id);
  assert.deepEqual([ids(list().items), list().hasMore, list().hasNewer], [window(0, size), false, true], 'the oldest window');
  assert.equal(await actions.loadEarlier(bot.id), false);

  // A live message doesn't join a window that doesn't reach the newest, and the catch-up after a
  // reconnect leaves the window where it is.
  const live1 = app.store.addMessage(bot.id, 'bot', 'Bob while you read back');
  await until(() => botHere(bot.id).lastMessage?.text === live1.text);
  assert.deepEqual(ids(list().items), window(0, size));
  await actions.loadMessages(bot.id);
  assert.deepEqual([ids(list().items), list().hasNewer, list().loading], [window(0, size), true, false]);

  // Reading forward: the oldest go, and reaching the newest brings in what arrived meanwhile.
  assert.equal(await actions.loadLater(bot.id), true);
  assert.deepEqual([ids(list().items), list().hasMore, list().hasNewer], [window(page, size + page), true, true]);
  while (list().hasNewer) await actions.loadLater(bot.id);
  assert.deepEqual(ids(list().items), [...window(total - size + 1, total), live1.id], 'at the newest: the last window, with the live message');
  assert.equal(list().items.length, size);
  const live2 = app.store.addMessage(bot.id, 'bot', 'Bob at the newest');
  await until(() => ids(list().items).at(-1) === live2.id);
  assert.equal(list().items.length, size + 1, 'live messages join a window at the newest');
  actions.keepWindow(bot.id);
  assert.deepEqual([list().items.length, ids(list().items).at(-1), list().hasMore], [size, live2.id, true], 'the chat at its bottom lets the oldest go');

  // Jumping to the latest from far back: one page, the newest.
  for (let i = 0; i < 6; i++) await actions.loadEarlier(bot.id);
  assert.equal(list().hasNewer, true);
  await actions.jumpToLatest(bot.id);
  assert.deepEqual([ids(list().items), list().hasMore, list().hasNewer], [[...window(total - page + 2, total), live1.id, live2.id], true, false]);

  // Left: the newest `kept`, and a live message keeps it at that.
  await actions.loadEarlier(bot.id);
  actions.leaveChat(bot.id);
  assert.deepEqual([list().items.length, ids(list().items).at(-1)], [kept, live2.id]);
  const live3 = app.store.addMessage(bot.id, 'bot', 'Bob while away');
  await until(() => ids(list().items).at(-1) === live3.id);
  assert.equal(list().items.length, kept);

  // Left while reading back: nothing is kept, and reopening loads the newest.
  actions.openChat(bot.id);
  for (let i = 0; i < 3; i++) await actions.loadEarlier(bot.id);
  assert.equal(list().hasNewer, true);
  actions.leaveChat(bot.id);
  assert.equal(list(), undefined);
  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  assert.deepEqual([ids(list().items).at(-1), list().hasNewer], [live3.id, false]);
  actions.leaveChat(bot.id);

  // Reading forward from a message that is gone starts again from the newest.
  actions.openChat(bot.id);
  for (let i = 0; i < 3; i++) await actions.loadEarlier(bot.id);
  const last = list().items.at(-1)!.id;
  app.store.db.prepare('delete from messages where id = ?').run(last);
  assert.equal(await actions.loadLater(bot.id), true);
  assert.deepEqual([ids(list().items).at(-1), list().hasNewer, list().error], [live3.id, false, null]);
  actions.leaveChat(bot.id);
});

test('live messages keep a chat at its newest within the window: the end farther from the row being read goes, and read near the top the newest go', async () => {
  const { window: size } = history;
  const bot = await botWithHistory('Stuart Live', 250);
  const list = () => getState().messages[bot.id];
  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  while (list().hasMore) await actions.loadEarlier(bot.id);
  assert.equal(list().items.length, 250);
  const first = list().items[0].id;
  // What the chat does after each render: reading near the top, so the newest are let go.
  const arrive = async (text: string, drop: 'oldest' | 'newest') => {
    const m = app.store.addMessage(bot.id, 'bot', text);
    await until(() => botHere(bot.id).lastMessage?.text === m.text);
    actions.keepWindow(bot.id, drop);
    assert.ok(list().items.length <= size, `${list().items.length} messages held`);
    return m;
  };
  const arrived = [];
  for (let i = 0; i < 80; i++) arrived.push(await arrive(`Stuart live ${i}`, 'newest'));
  assert.deepEqual([list().items.length, list().items[0].id, list().hasNewer], [size, first, true], 'the row read near the top stays, the newest go');
  assert.equal(ids(list().items).at(-1), arrived[size - 250 - 1].id);
  // Reading forward again gets to the newest, still within the window.
  while (list().hasNewer) await actions.loadLater(bot.id);
  assert.deepEqual([list().items.length, ids(list().items).at(-1), list().hasNewer], [size, arrived.at(-1)!.id, false]);
  // Reading near the bottom: the oldest go.
  const before = list().items[0].id;
  const last = await arrive('Stuart live at the bottom', 'oldest');
  assert.deepEqual([list().items.length, ids(list().items).at(-1), list().hasNewer, list().hasMore], [size, last.id, false, true]);
  assert.notEqual(list().items[0].id, before);
  actions.leaveChat(bot.id);
});

/**
 * For the length of `fn`, the client's view of the first request `match` picks (the server has already
 * answered it) is held until `release`, or until `fn` ends.
 */
async function holdingFirst<T>(match: (url: URL) => boolean, fn: (h: { held: () => boolean; seen: () => number; release: () => void }) => Promise<T>): Promise<T> {
  let seen = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const wrap = async (url: URL) => {
    if (match(url) && seen++ === 0) await gate;
  };
  try {
    return await intercepting(wrap, () => fn({ held: () => seen > 0, seen: () => seen, release }));
  } finally {
    release();
  }
}
const messagesOf = (botId: string, kind: 'latest' | 'before') => (url: URL) =>
  url.pathname === `/api/bots/${botId}/messages` && (kind === 'before' ? url.searchParams.has('before') : !url.searchParams.has('before') && !url.searchParams.has('after'));

test('a page that lands after its chat was let go changes nothing, and the chat opened again loads afresh', async () => {
  // Left while reading back: an earlier page landing after doesn't bring back an empty list.
  const bob = await botWithHistory('Bob Late', 450);
  const list = () => getState().messages[bob.id];
  actions.openChat(bob.id);
  await actions.loadMessages(bob.id);
  for (let i = 0; i < 3; i++) await actions.loadEarlier(bob.id);
  assert.equal(list().hasNewer, true);
  await holdingFirst(messagesOf(bob.id, 'before'), async (earlier) => {
    const loading = actions.loadEarlier(bob.id);
    await until(earlier.held);
    actions.leaveChat(bob.id);
    assert.equal(list(), undefined);
    earlier.release();
    assert.equal(await loading, false);
  });
  assert.equal(list(), undefined, 'the late page did not bring the chat back');
  actions.openChat(bob.id);
  await actions.loadMessages(bob.id);
  assert.deepEqual([list().items.at(-1)!.text, list().items.length, list().hasNewer], ['Bob Late message 449', history.page, false]);
  actions.leaveChat(bob.id);

  // The newest page landing after its chat was dropped from the ones kept: not kept again, and the chat opened
  // again before it lands makes its own request.
  const dave = await botWithHistory('Dave Late', 3);
  const others: Bot[] = [];
  for (let i = 0; i < history.chats; i++) others.push(await botWithHistory(`Kevin Late ${i}`, 1));
  await holdingFirst(messagesOf(dave.id, 'latest'), async (latest) => {
    actions.openChat(dave.id);
    const stale = actions.loadMessages(dave.id);
    await until(latest.held);
    actions.leaveChat(dave.id);
    for (const b of others) {
      actions.openChat(b.id);
      await actions.loadMessages(b.id);
      actions.leaveChat(b.id);
    }
    assert.equal(getState().messages[dave.id], undefined, 'dropped');
    // Opened again: a new request, not the one still held.
    const newer = app.store.addMessage(dave.id, 'bot', 'Dave after the first read');
    actions.openChat(dave.id);
    const fresh = actions.loadMessages(dave.id);
    await until(() => latest.seen() === 2);
    await fresh;
    assert.deepEqual(ids(getState().messages[dave.id].items).at(-1), newer.id);
    const before = getState().messages;
    latest.release();
    await stale;
    assert.equal(getState().messages, before, 'the late page changed nothing');
    actions.leaveChat(dave.id);
  });
});

test('a queued catch-up does not recreate a chat evicted while its newest page was loading', async () => {
  const bob = await botWithHistory('Bob Queued', 350);
  actions.openChat(bob.id);
  await actions.loadMessages(bob.id);
  for (let i = 0; i < 3; i++) await actions.loadEarlier(bob.id);
  const others: Bot[] = [];
  for (let i = 0; i < history.chats; i++) others.push(await botWithHistory(`Kevin Queued ${i}`, 1));
  await holdingFirst(messagesOf(bob.id, 'latest'), async (latest) => {
    const stale = actions.loadMessages(bob.id);
    await until(latest.held);
    const forward = actions.loadLater(bob.id);
    await until(() => !getState().messages[bob.id].hasNewer);
    actions.leaveChat(bob.id);
    for (const b of others) {
      actions.openChat(b.id);
      await actions.loadMessages(b.id);
      actions.leaveChat(b.id);
    }
    assert.equal(getState().messages[bob.id], undefined);
    const before = getState().messages;
    latest.release();
    await stale;
    await forward;
    assert.equal(latest.seen(), 1, 'no queued request starts for the discarded window');
    assert.equal(getState().messages, before, 'the evicted chat stays absent');
  });
});

test('an empty newest page that lands after a live message keeps that message', async () => {
  const kevin = await s.newBot('Kevin Empty');
  const list = () => getState().messages[kevin.id];
  actions.openChat(kevin.id);
  await holdingFirst(messagesOf(kevin.id, 'latest'), async (latest) => {
    const loading = actions.loadMessages(kevin.id);
    await until(latest.held);
    // The server read the empty chat; the owner's first message arrives before the client sees that.
    await actions.send(kevin.id, 'Kevin says hello');
    const sent = list().items.at(-1)!;
    assert.equal(sent.text, 'Kevin says hello');
    latest.release();
    await loading;
    // (The mock Boton's reply may have arrived live too, after it.)
    assert.deepEqual([ids(list().items)[0], list().loading, list().hasMore, list().hasNewer], [sent.id, false, false, false]);
  });
  // Read again with everything on the server: the same one message, no copy.
  await actions.loadMessages(kevin.id);
  assert.equal(list().items.filter((m) => m.text === 'Kevin says hello').length, 1);
  actions.leaveChat(kevin.id);
});

test('Jump to latest while a newest page read before a live message is loading reads again, and shows that message', async () => {
  const stuart = await botWithHistory('Stuart Jump', 450);
  const list = () => getState().messages[stuart.id];
  actions.openChat(stuart.id);
  await actions.loadMessages(stuart.id);
  for (let i = 0; i < 3; i++) await actions.loadEarlier(stuart.id);
  assert.equal(list().hasNewer, true);
  await holdingFirst(messagesOf(stuart.id, 'latest'), async (latest) => {
    const refreshing = actions.loadMessages(stuart.id);
    await until(latest.held);
    // Arrives live while reading back: not added to the window.
    const m = app.store.addMessage(stuart.id, 'bot', 'Stuart while the page loads');
    await until(() => botHere(stuart.id).lastMessage?.text === m.text);
    assert.ok(!ids(list().items).includes(m.id));
    const jumping = actions.jumpToLatest(stuart.id);
    await until(() => ids(list().items).at(-1) === m.id);
    await jumping;
    latest.release();
    await refreshing;
    assert.deepEqual([ids(list().items).at(-1), list().hasNewer, list().loading, list().items.length], [m.id, false, false, history.page]);
  });
  actions.leaveChat(stuart.id);
});

test('chats left keep messages for the most recently left only, and a remounted chat stays on screen', async () => {
  const bots = [];
  for (let i = 0; i < history.chats + 2; i++) bots.push(await botWithHistory(`Kevin ${i}`, 3));
  for (const b of bots) {
    actions.openChat(b.id);
    await actions.loadMessages(b.id);
    actions.leaveChat(b.id);
  }
  const kept = bots.filter((b) => getState().messages[b.id]);
  assert.deepEqual(ids(kept), ids(bots.slice(-history.chats)), 'the two left longest ago are dropped');

  // StrictMode mounts, unmounts and mounts again: the chat is still on screen.
  const dave = await botWithHistory('Dave Window', 250);
  actions.openChat(dave.id);
  actions.openChat(dave.id);
  actions.leaveChat(dave.id);
  await actions.loadMessages(dave.id);
  await actions.loadEarlier(dave.id);
  assert.equal(getState().messages[dave.id].items.length, 200);
  actions.leaveChat(dave.id);
  assert.equal(getState().messages[dave.id].items.length, history.kept);
});

test('messages are read before or after a message of the chat, oldest first', async () => {
  const bot = await botWithHistory('Stuart Pages', 12);
  const other = await botWithHistory('Kevin Pages', 1);
  const all = app.store.listMessages(bot.id);
  const page = (q: string) => s.call<Message[]>('GET', `/api/bots/${bot.id}/messages?${q}`);
  assert.deepEqual(ids((await page(`limit=4&after=${all[2].id}`)).data), ids(all.slice(3, 7)));
  assert.deepEqual(ids((await page(`limit=4&after=${all.at(-1)!.id}`)).data), []);
  assert.deepEqual(ids((await page(`limit=4&before=${all[6].id}`)).data), ids(all.slice(2, 6)));
  assert.equal((await page(`after=${app.store.listMessages(other.id)[0].id}`)).status, 404, "another chat's message");
  assert.equal((await page('after=msg_nope')).status, 404);
  assert.equal((await page(`before=${all[6].id}&after=${all[2].id}`)).status, 400);
});

test('Forget removes a memory at once; if the server refuses, it comes back and the error is thrown', async () => {
  const bot = await botWithHistory('Mel', 1);
  const keep = await remember(bot.id, 'Keep me');
  const doomed = await remember(bot.id, 'Forget me');
  await actions.loadMemories(bot.id);

  failing.add(new RegExp(`^/api/memories/${doomed.id}$`));
  const refused = actions.forgetMemory(doomed);
  assert.deepEqual(ids(getState().memories[bot.id]), [keep.id], 'gone from the list before the server answers');
  await assert.rejects(refused, /Injected failure/);
  assert.deepEqual(ids(getState().memories[bot.id]), [keep.id, doomed.id], 'back in its place');
  assert.ok(app.store.listMemories(bot.id).some((m) => m.id === doomed.id));

  failing.clear();
  await actions.forgetMemory(doomed);
  assert.deepEqual(ids(getState().memories[bot.id]), [keep.id]);
  assert.ok(!app.store.listMemories(bot.id).some((m) => m.id === doomed.id));
  // Already gone (another device): not an error.
  await actions.forgetMemory(doomed);
  assert.deepEqual(ids(getState().memories[bot.id]), [keep.id]);
});

test('unread: a result for another Boton shows up here; reading clears it at once and once on the server; a late answer does not undo a newer reply; reading elsewhere clears it here', async () => {
  const a = await botWithHistory('Tim', 1);
  const b = await botWithHistory('Otto', 1);
  const unreadHere = (id: string) => botHere(id).unread;
  await runNow((await s.newRoutine(b.id, { name: 'Digest', instruction: 'Summarize' })).id);
  await until(() => unreadHere(b.id) === 1);
  assert.equal(unreadHere(a.id), 0);

  const reads: string[] = [];
  let answered = 0;
  let gate: Promise<void> | undefined;
  let release!: () => void;
  await intercepting(
    async (url, init) => {
      if (!url.pathname.endsWith('/read')) return;
      reads.push(String(init?.body));
      await gate;
      answered++;
    },
    async () => {
      await actions.loadMessages(b.id);
      const lastId = getState().messages[b.id].items.at(-1)!.id;
      actions.markRead(b.id, lastId);
      actions.markRead(b.id, lastId);
      assert.equal(unreadHere(b.id), 0, 'cleared before the server answers');
      await until(() => answered === 1);
      assert.deepEqual(reads, [JSON.stringify({ upTo: lastId })]);
      assert.equal(app.store.getBot(b.id).unread, 0);

      // The server handles the next read at once, but its answer is held until a newer reply has arrived.
      app.store.addMessage(b.id, 'bot', 'First reply');
      await until(() => unreadHere(b.id) === 1);
      await actions.loadMessages(b.id);
      gate = new Promise<void>((r) => (release = r));
      actions.markRead(b.id, getState().messages[b.id].items.at(-1)!.id);
      await until(() => reads.length === 2);
      app.store.addMessage(b.id, 'bot', 'Second reply');
      await until(() => unreadHere(b.id) === 1 && botHere(b.id).lastMessage?.text === 'Second reply');
      release();
      await until(() => answered === 2);
      await sleep(100);
    },
  );
  assert.equal(unreadHere(b.id), 1, 'the second reply is still unread here');
  assert.equal(app.store.getBot(b.id).unread, 1);

  await api('POST', `/api/bots/${b.id}/read`, {});
  await until(() => unreadHere(b.id) === 0, 1000);
});

test('catching up does not reuse a chat load that was sent before the stream dropped', async () => {
  const bot = await botWithHistory('Phil', 2);
  const messagesPath = `/api/bots/${bot.id}/messages`;
  let held = 0;
  let caughtUpSettings = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let missed: Message;
  await intercepting(
    async (url) => {
      // The chat's first page is read now but only lands after the reconnect.
      if (url.pathname === messagesPath && held++ === 0) await gate;
      if (url.pathname === '/api/settings') caughtUpSettings = true;
    },
    async () => {
      const opening = actions.loadMessages(bot.id);
      await until(() => held === 1);
      await reconnected(async () => {
        proxy.freeze();
        missed = app.store.addMessage(bot.id, 'bot', 'Sent during the outage');
        await until(() => caughtUpSettings);
        await sleep(50);
        release();
      });
      await opening;
    },
  );
  assert.ok(ids(getState().messages[bot.id].items).includes(missed!.id), 'the message sent during the outage is on screen');
  assert.equal(getState().messages[bot.id].loading, false);
});

test('the brains are fetched again after a failed turn, and while the page is in view (not while hidden), so a signed-out CLI warns before a message fails', async (t) => {
  const bot = await s.newBot('Brainy');
  const since = new Date().toISOString();
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'FAIL_PLEASE' });
  const failed = await until(() => {
    const e = getState().providers.find((p) => p.id === 'mock')?.lastError;
    return e && e.at >= since && e;
  });
  assert.equal(failed.message, 'Mock failure requested');

  // A CLI the test signs in and out; nothing on the stream says so.
  let signedIn = true;
  app.providers.register({
    id: 'flaky',
    label: 'Flaky CLI',
    info: async () => {
      const [available, reason] = signedIn ? [true, null] : [false, 'Flaky is not signed in.'];
      return { id: 'flaky', label: 'Flaky CLI', kind: 'cli', available, reason, installed: true, version: '1.0', loggedIn: available, checkedAt: new Date().toISOString(), models: [], defaultModel: '' };
    },
    runTurn: () => Promise.reject(new Error('not used')),
  });
  const shown = () => getState().providers.find((p) => p.id === 'flaky');
  const fakeDocument = { visibilityState: 'visible' as DocumentVisibilityState };
  const globals = globalThis as { document?: unknown };
  globals.document = fakeDocument;
  live.providersMs = 300;
  t.after(() => {
    delete globals.document;
    live.providersMs = 60_000;
  });

  const fetched: string[] = [];
  await intercepting(
    (url) => void fetched.push(url.pathname),
    async () => {
      await until(() => shown()?.available === true);
      signedIn = false;
      await until(() => shown()?.available === false);
      assert.equal(shown()!.reason, 'Flaky is not signed in.');
      assert.ok(getState().connected);
      assert.ok(!fetched.includes('/api/bots'), 'asked on its own, not as part of catching up after a reconnect');

      fakeDocument.visibilityState = 'hidden';
      await sleep(100); // a request already on its way lands first
      fetched.length = 0;
      signedIn = true;
      await sleep(3 * live.providersMs);
      assert.deepEqual(fetched, [], 'nothing fetched while hidden');
      assert.equal(shown()!.available, false);
      fakeDocument.visibilityState = 'visible';
      await until(() => shown()?.available === true);
    },
  );
});

test('a reply being written shows as a draft, also after reconnecting mid-turn, and its message replaces it once', async () => {
  const bot = await s.newBot('Scribe');
  await actions.loadMessages(bot.id);
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  await api('POST', `/api/bots/${bot.id}/messages`, { text: `STREAM_PLEASE:50 ${words}` });

  const first = await until(() => botHere(bot.id)?.status.draft);
  await until(() => (botHere(bot.id).status.draft?.text.length ?? 0) > first.text.length);
  assert.equal(botHere(bot.id).status.state, 'working');

  await reconnected(() => proxy.freeze());
  const caughtUp = botHere(bot.id).status.draft;
  assert.ok(caughtUp && caughtUp.turnId === first.turnId && caughtUp.text.startsWith('Echo: STREAM_PLEASE'), JSON.stringify(caughtUp));

  const reply = await until(() => getState().messages[bot.id].items.find((m) => m.role === 'bot'));
  assert.equal(reply.meta?.turnId, first.turnId);
  assert.equal(botHere(bot.id).status.draft ?? null, null);
  await until(() => botHere(bot.id).status.state === 'idle');
  await sleep(200);
  assert.equal(getState().messages[bot.id].items.filter((m) => m.role === 'bot').length, 1);
  assert.equal(botHere(bot.id).status.draft ?? null, null);
});

test('approval requests: waiting ones load at start and arrive live, a decision shows at once, one decided while disconnected is caught up, and a deleted Boton takes its own away', async () => {
  const bot = await s.newBot('Asker');
  const askAs = async (title: string): Promise<Approval> => {
    const boton = app.auth.mintBotonToken(bot.id);
    const { status, data } = await s.call<ApprovalRequestResult>('POST', `/api/bots/${bot.id}/approvals`, { title }, boton.token).finally(boton.revoke);
    assert.equal(status, 201);
    return data.approval;
  };
  const waiting = () => pendingApprovals(getState().approvals).filter((a) => a.botId === bot.id);

  const early = await askAs('Asked before the app opened');
  disconnect();
  await actions.init();
  await until(() => getState().connected);
  assert.deepEqual(waiting().map((a) => a.id), [early.id]);

  await actions.loadMessages(bot.id);
  const fresh = await askAs('Asked while the app is open');
  await until(() => waiting().length === 2);
  await until(() => getState().messages[bot.id].items.some((m) => m.meta?.kind === 'approval.requested' && m.meta.approvalId === fresh.id));

  const decided = await actions.decideApproval(fresh.id, { decision: 'deny', note: 'Not today' });
  assert.equal(decided.status, 'denied');
  assert.equal(getState().approvals[fresh.id].status, 'denied');
  assert.deepEqual(waiting().map((a) => a.id), [early.id]);

  // Decided on another device while this one was disconnected.
  await reconnected(async () => {
    proxy.freeze();
    await api('POST', `/api/approvals/${early.id}/decide`, { decision: 'allow' });
  });
  assert.equal(getState().approvals[early.id].status, 'allowed');
  assert.deepEqual(waiting(), []);

  const other = await askAs('One more');
  await api('POST', `/api/approvals/${other.id}/decide`, { decision: 'allow' });
  await actions.loadApprovals(bot.id);
  assert.deepEqual([early.id, fresh.id, other.id].map((id) => getState().approvals[id]?.status), ['allowed', 'denied', 'allowed']);

  await actions.deleteBot(bot.id);
  assert.deepEqual(Object.values(getState().approvals).filter((a) => a.botId === bot.id), []);
});

test('a chat let go takes its decided approvals with it, keeps the waiting ones, and loads them again when opened', async () => {
  const bot = await s.newBot('Stuart Asks');
  const askAs = async (title: string): Promise<Approval> => {
    const boton = app.auth.mintBotonToken(bot.id);
    const { data } = await s.call<ApprovalRequestResult>('POST', `/api/bots/${bot.id}/approvals`, { title }, boton.token).finally(boton.revoke);
    return data.approval;
  };
  const decided = await askAs('Decided');
  await api('POST', `/api/approvals/${decided.id}/decide`, { decision: 'allow' });
  const waiting = await askAs('Still waiting');
  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  await actions.loadApprovals(bot.id);
  assert.deepEqual([decided.id, waiting.id].map((id) => getState().approvals[id]?.status), ['allowed', 'pending']);

  await holdingFirst((url) => url.pathname === `/api/bots/${bot.id}/approvals`, async (held) => {
    const loading = actions.loadApprovals(bot.id);
    await until(held.held);
    // Kept while the page holds the chat off screen; once enough chats are left after it, it is let go, and its decided approvals with it.
    actions.leaveChat(bot.id);
    assert.equal(getState().approvals[decided.id]?.status, 'allowed');
    for (let i = 0; i < history.chats; i++) {
      const other = await botWithHistory(`Bob ${i}`, 1);
      actions.openChat(other.id);
      await actions.loadMessages(other.id);
      actions.leaveChat(other.id);
    }
    assert.equal(getState().messages[bot.id], undefined);
    assert.deepEqual([decided.id, waiting.id].map((id) => getState().approvals[id]?.status), [undefined, 'pending']);
  
    held.release();
    await loading;
    assert.deepEqual([decided.id, waiting.id].map((id) => getState().approvals[id]?.status), [undefined, 'pending'], 'late loads respect current retention');
  });

  // A decision for a chat the page doesn't hold isn't kept either, but one still waiting is.
  await api('POST', `/api/approvals/${waiting.id}/decide`, { decision: 'deny' });
  await until(() => !getState().approvals[waiting.id]);
  const later = await askAs('Asked later');
  await until(() => getState().approvals[later.id]?.status === 'pending');

  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  await actions.loadApprovals(bot.id);
  assert.deepEqual([decided.id, waiting.id, later.id].map((id) => getState().approvals[id]?.status), ['allowed', 'denied', 'pending']);
  actions.leaveChat(bot.id);
});

test("a connector test that overlaps an edit doesn't show its answer as the connector's last test", async () => {
  // A stand-in MCP server whose tools/list waits until released.
  let release!: () => void;
  let arrived!: () => void;
  const listed = new Promise<void>((r) => (arrived = r));
  const held = new Promise<void>((r) => (release = r));
  const mcp = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const msg = JSON.parse(body || '{}');
      if (msg.id === undefined) return void res.writeHead(202).end();
      if (msg.method === 'tools/list') {
        arrived();
        await held;
      }
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [{ name: 'search', inputSchema: {} }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
  after(() => mcp.close());
  const url = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp`;
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'stuart-docs', transport: 'http', url })).status, 201);
  await actions.loadConnectors();
  const lastTest = () => getState().connectors?.connectors.find((c) => c.id === 'lib:stuart-docs')?.lastTest;

  const running = actions.testConnector('lib:stuart-docs');
  await listed;
  assert.equal((await s.call('PATCH', '/api/mcp-servers/stuart-docs', { headers: { 'X-Api-Key': 'dummy_key' } })).status, 200);
  await actions.loadConnectors();
  release();
  const answer = await running;
  assert.equal(answer.outcome, 'untestable');
  assert.equal(lastTest(), null, 'the catalog the server holds, with no result for the edited server');

  const next = await actions.testConnector('lib:stuart-docs');
  assert.equal(next.outcome, 'reached');
  assert.deepEqual(lastTest(), next);
});


test('a newer sidebar event survives a delayed reconnect refresh', async () => {
  const fetchBefore = globalThis.fetch;
  let release!: () => void;
  let captured = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async (input, init) => {
    const response = await fetchBefore(input, init);
    if (new URL(String(input), s.base).pathname === '/api/sidebar') {
      captured = true;
      await held;
    }
    return response;
  };
  try {
    await api('PATCH', '/api/sidebar/sections/ungrouped', { collapsed: false });
    await until(() => getState().sidebar?.ungrouped.collapsed === false);
    const reconnect = reconnected(() => proxy.freeze());
    await until(() => captured);
    await api('PATCH', '/api/sidebar/sections/ungrouped', { collapsed: true });
    await until(() => getState().sidebar?.ungrouped.collapsed === true);
    release();
    await reconnect;
    assert.equal(getState().sidebar?.ungrouped.collapsed, true);
  } finally {
    release();
    globalThis.fetch = fetchBefore;
  }
});

test("reactions: the owner's shows once the server has it, a refused one changes nothing, a late answer doesn't undo a newer event, and another device's and the Boton's arrive live", async () => {
  const bot = await botWithHistory('Phil', 2);
  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  const shown = (id: string) => getState().messages[bot.id]?.items.find((m) => m.id === id);
  const emoji = (id: string) => (shown(id)?.reactions ?? []).map((r) => `${r.by}:${r.emoji}`).join(' ');
  const reply = getState().messages[bot.id]!.items.find((m) => m.role === 'bot')!;
  const own = getState().messages[bot.id]!.items.find((m) => m.role === 'user')!;

  // Nothing on screen before the server answers: no optimistic reaction to take back.
  const asked = actions.react(reply, '👍');
  assert.equal(emoji(reply.id), '');
  await asked;
  assert.equal(emoji(reply.id), 'owner:👍');

  // Refused (the owner's own message takes none): thrown, and nothing changes.
  await assert.rejects(actions.react(own, '👍'), /Only the Boton's messages take reactions/);
  assert.equal(emoji(own.id), '');

  // The answer to ❤️ is held back while another device adds 🎉: the stream brings both, and the late answer, which
  // has only ❤️, doesn't take 🎉 away.
  let held = false;
  await intercepting(
    async (url, init) => {
      if (held || init?.method !== 'POST' || !url.pathname.endsWith('/reactions')) return;
      held = true;
      await api('POST', `/api/bots/${bot.id}/messages/${reply.id}/reactions`, { emoji: '🎉' });
      await until(() => emoji(reply.id) === 'owner:👍 owner:❤️ owner:🎉');
    },
    () => actions.react(shown(reply.id)!, '❤️'),
  );
  assert.ok(held);
  assert.equal(emoji(reply.id), 'owner:👍 owner:❤️ owner:🎉');

  await actions.unreact(shown(reply.id)!, '👍');
  assert.equal(emoji(reply.id), 'owner:❤️ owner:🎉');

  // The Boton's reaction on the owner's message, from its own token, shows live.
  const token = app.auth.mintBotonToken(bot.id, { sandboxed: false }).token;
  assert.equal((await s.call('POST', `/api/bots/${bot.id}/messages/${own.id}/reactions`, { emoji: '👀' }, token)).status, 200);
  await until(() => emoji(own.id) === 'boton:👀');
  actions.leaveChat(bot.id);
});


test('late pin and history responses preserve newer live reactions', async () => {
  const bot = await botWithHistory('Kevin', 2);
  actions.openChat(bot.id);
  await actions.loadMessages(bot.id);
  const reply = getState().messages[bot.id]!.items.find((m) => m.role === 'bot')!;
  const emoji = () => getState().messages[bot.id]!.items.find((m) => m.id === reply.id)?.reactions?.map((r) => r.emoji) ?? [];
  for (const kind of ['pin', 'history']) {
    let held = false;
    const reaction = kind === 'pin' ? '🎉' : '❤️';
    await intercepting(async (url) => {
      const matches = kind === 'pin' ? url.pathname.endsWith('/pin') : url.pathname === `/api/bots/${bot.id}/messages`;
      if (held || !matches) return;
      held = true;
      await api('POST', `/api/bots/${bot.id}/messages/${reply.id}/reactions`, { emoji: reaction });
      await until(() => emoji().includes(reaction));
    }, () => kind === 'pin' ? actions.pinMessage(reply, true) : actions.loadMessages(bot.id));
    assert.ok(held, kind);
    assert.ok(emoji().includes(reaction), kind);
  }
});
