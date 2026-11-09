import assert from 'node:assert/strict';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import { PIN_LIMIT } from '../src/replay.ts';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const open = () =>
  new Store(loadConfig({ BOTONS_HOME: tempDir('botons-replay-index-'), BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1' }), new EventHub(), () => ({ state: 'idle', activity: null, since: null }));

/** Every SQL text the store prepares while `fn` runs, so a test can ask SQLite how it reads exactly those. */
function preparedBy(db: DatabaseSync, fn: () => void): string[] {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as (sql: string) => StatementSync;
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

/** SQLite's plan for `sql`, with every parameter bound to a value of the type it takes there. */
const planOf = (db: DatabaseSync, sql: string, params: (string | number)[]) =>
  db
    .prepare(`explain query plan ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');

test("the replay, the pins and a reset read through their own indexes, as the store writes its queries, with no statistics gathered", () => {
  const store = open();
  const kevin = store.createBot({ name: 'Kevin', provider: 'mock' }, new Set(['mock']), 'mock');
  for (let i = 0; i < 30; i++) store.addMessage(kevin.id, i % 2 ? 'bot' : 'user', `message ${i}`, i % 5 === 0 ? { routineId: 'rt_brief', routineName: 'Brief' } : null);
  const decision = store.addMessage(kevin.id, 'user', 'We ship on Friday.');
  store.setMessagePinned(kevin.id, decision.id, true);
  assert.equal(store.db.prepare("select count(*) as n from sqlite_master where name like 'sqlite_stat%'").get()!.n, 0, 'nothing analyzed: the plans are the ones a real install gets');

  const reads = preparedBy(store.db, () => {
    const src = store.replaySource(kevin.id, store.contextSince(kevin.id), []);
    [...src.chat, ...src.routines];
    store.pinnedMessages(kevin.id);
  });
  const resetReads = preparedBy(store.db, () => store.resetContext(kevin.id));
  const since = store.contextSince(kevin.id)!;
  const floorReads = preparedBy(store.db, () => store.pinnedMessages(kevin.id));

  const pages = reads.filter((q) => /from messages where bot_id = \? and seq < \? and seq > \?/.test(q));
  const plans = pages.map((q) => planOf(store.db, q, [kevin.id, Number.MAX_SAFE_INTEGER, 0, since, 200]));
  for (const index of ['messages_chat', 'messages_routine', 'messages_pinned']) {
    assert.ok(plans.some((p) => p === `SEARCH messages USING INDEX ${index} (bot_id=? AND seq>? AND seq<?)`), `a page reads ${index}: ${plans.join(' / ')}`);
  }
  assert.ok(plans.every((p) => !/SCAN|TEMP B-TREE/.test(p)), `no page scans or sorts: ${plans.join(' / ')}`);

  const floor = floorReads.find((q) => q.includes("'session.reset'"))!;
  assert.equal(planOf(store.db, floor, [kevin.id, since]), 'SEARCH messages USING INDEX messages_reset (bot_id=? AND created_at>?)');
  const unpin = resetReads.find((q) => q.startsWith('select * from messages where bot_id = ? and json_extract'))!;
  assert.equal(planOf(store.db, unpin, [kevin.id]), 'SEARCH messages USING INDEX messages_pinned (bot_id=?)');
  store.db.close();
});

test('a pin, an unpin and a reset change what the pins index holds, and a reset bounds every read to after its event', (t) => {
  // A clock that moves only when told: a message is never in the same millisecond as a reset by chance.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T09:00:00.000Z') });
  const tick = () => t.mock.timers.tick(1000);
  const store = open();
  const kevin = store.createBot({ name: 'Kevin', provider: 'mock' }, new Set(['mock']), 'mock');
  const stuart = store.createBot({ name: 'Stuart', provider: 'mock' }, new Set(['mock']), 'mock');
  const indexed = (botId: string) => store.db.prepare('select id from messages indexed by messages_pinned where bot_id = ? and ' + "json_extract(case when json_valid(meta) then meta end, '$.pinned') is not null and role in ('user', 'bot') order by seq").all(botId).map((r) => r.id);

  tick();
  const before = store.addMessage(kevin.id, 'user', 'Before the reset.');
  const a = store.addMessage(kevin.id, 'user', 'We ship on Friday.');
  const b = store.addMessage(kevin.id, 'bot', 'Noted: Friday.');
  const theirs = store.addMessage(stuart.id, 'user', 'Bananas.');
  store.setMessagePinned(kevin.id, a.id, true);
  store.setMessagePinned(kevin.id, b.id, true);
  store.setMessagePinned(stuart.id, theirs.id, true);
  assert.deepEqual(indexed(kevin.id), [a.id, b.id]);
  store.setMessagePinned(kevin.id, b.id, false);
  assert.deepEqual(indexed(kevin.id), [a.id]);

  // A snapshot of the Boton from before the reset still reads the chat as it was then.
  const then = store.contextSince(kevin.id);
  tick();
  store.resetContext(kevin.id);
  assert.deepEqual(indexed(kevin.id), [], 'the reset took every pin off');
  assert.deepEqual(indexed(stuart.id), [theirs.id], "another Boton's pins stay");
  tick();
  const after = store.addMessage(kevin.id, 'user', 'After the reset.');
  const brief = store.addMessage(kevin.id, 'bot', 'The brief.', { routineId: 'rt_brief', routineName: 'Brief' });
  const now = store.replaySource(kevin.id, store.contextSince(kevin.id), []);
  // The reset's own event, at the reset's time, is not after it.
  const said = (it: Iterable<{ message: { role: string; id: string } }>) => [...it].filter((r) => r.message.role !== 'event').map((r) => r.message.id);
  assert.deepEqual(said(now.chat), [after.id]);
  assert.deepEqual([...now.routines].map((r) => r.message.id), [brief.id]);
  const old = store.replaySource(kevin.id, then, []);
  assert.deepEqual(said(old.chat).reverse(), [before.id, a.id, b.id, after.id]);

  // A second reset: the reads start at the newest one's event, and the older one still reads from its own.
  const first = store.contextSince(kevin.id);
  tick();
  store.resetContext(kevin.id);
  tick();
  const later = store.addMessage(kevin.id, 'user', 'After the second reset.');
  assert.deepEqual(said(store.replaySource(kevin.id, store.contextSince(kevin.id), []).chat), [later.id]);
  assert.deepEqual(said(store.replaySource(kevin.id, first, []).chat), [later.id, after.id]);
  store.db.close();
});

test('a meta that is not JSON reads as none: it fails no write, index, read, pin or reset, and its message still shows', () => {
  const store = open();
  const kevin = store.createBot({ name: 'Kevin', provider: 'mock' }, new Set(['mock']), 'mock');
  const ok = store.addMessage(kevin.id, 'user', 'We ship on Friday.');
  // Written past the store, as damage would: the store itself only writes JSON.
  store.db.prepare("insert into messages (id, bot_id, role, text, meta, created_at) values ('msg_bad', ?, 'bot', 'damaged', '{\"pinned\":', ?)").run(kevin.id, new Date().toISOString());
  store.db.prepare("update messages set meta = '{\"routineId\": ' where id = ?").run(ok.id);
  assert.deepEqual(store.listMessages(kevin.id).map((m) => [m.text, m.meta]), [['We ship on Friday.', null], ['damaged', null]]);
  const src = store.replaySource(kevin.id, null, []);
  assert.deepEqual([...src.chat].map((r) => r.message.text), ['damaged', 'We ship on Friday.']);
  assert.deepEqual([...src.routines, ...src.pins], []);
  assert.equal(store.setMessagePinned(kevin.id, 'msg_bad', true).meta?.pinned !== undefined, true, 'pinning writes JSON over it');
  assert.deepEqual(store.pinnedMessages(kevin.id).map((m) => m.id), ['msg_bad']);
  store.resetContext(kevin.id);
  assert.deepEqual(store.pinnedMessages(kevin.id), []);
  assert.equal(store.db.prepare('pragma integrity_check').get()!.integrity_check, 'ok');
  store.db.close();
});

test('the pins read is bounded: it reads one more than PIN_LIMIT at most, so a count past it shows', () => {
  const store = open();
  const kevin = store.createBot({ name: 'Kevin', provider: 'mock' }, new Set(['mock']), 'mock');
  // More pins than setMessagePinned allows, written past it.
  for (let i = 0; i < PIN_LIMIT + 5; i++) store.addMessage(kevin.id, 'user', `decision ${i}`, { pinned: { at: new Date().toISOString() } });
  const pins = store.pinnedMessages(kevin.id);
  assert.equal(pins.length, PIN_LIMIT + 1);
  assert.deepEqual(pins.map((m) => m.text), Array.from({ length: PIN_LIMIT + 1 }, (_, i) => `decision ${i + 4}`), 'the newest, oldest first');
  assert.equal(store.replaySource(kevin.id, null, []).pins.length, PIN_LIMIT);
  const extra = store.addMessage(kevin.id, 'user', 'one more');
  assert.throws(() => store.setMessagePinned(kevin.id, extra.id, true), /pinned already/);
  store.db.close();
});
