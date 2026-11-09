import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, BotStatus, SidebarLayout } from '../../shared/types.ts';
import { applyDrop, arrange, changesNothing, dropIndex, search, stepIndex, summarize, summaryText } from '../../web/src/sidebar.ts';

const idle: BotStatus = { state: 'idle' } as BotStatus;
function bot(id: string, name: string, more: Partial<Bot> = {}): Bot {
  return { id, name, title: '', group: '', groupId: null, pinned: false, unread: 0, status: idle, ...more } as Bot;
}
const names = (bots: Bot[]) => bots.map((b) => b.name);

const kevin = bot('b1', 'Kevin', { groupId: 'g1', group: 'Work', pinned: true });
const stuart = bot('b2', 'Stuart', { groupId: 'g1', group: 'Work', title: 'Release captain' });
const bob = bot('b3', 'Bob');
const dave = bot('b4', 'Dave', { groupId: 'g2', group: 'Home' });
const layout: SidebarLayout = {
  pinned: { collapsed: false, botIds: ['b1'] },
  groups: [
    { id: 'g2', name: 'Home', collapsed: true, botIds: ['b4'] },
    { id: 'g1', name: 'Work', collapsed: false, botIds: ['b2', 'b1'] },
    { id: 'g3', name: 'Empty', collapsed: false, botIds: [] },
  ],
  ungrouped: { collapsed: false, botIds: ['b3'] },
};

test('the sidebar follows the layout: groups and Botons in its order, collapsed or not, empty groups too', () => {
  const a = arrange(layout, [kevin, stuart, bob, dave]);
  assert.deepEqual(names(a.pinned.bots), ['Kevin']);
  assert.deepEqual(
    a.groups.map((g) => [g.key, g.name, g.collapsed, names(g.bots)]),
    [
      ['g2', 'Home', true, ['Dave']],
      ['g1', 'Work', false, ['Stuart', 'Kevin']],
      ['g3', 'Empty', false, []],
    ],
  );
  assert.deepEqual([a.ungrouped.key, names(a.ungrouped.bots)], ['ungrouped', ['Bob']]);
});

test('a layout and the Botons can each be a step ahead: nothing is shown twice, and no Boton goes missing', () => {
  // A new Boton the layout doesn't list yet, pinned, in Work; one in a group the layout doesn't have yet; an id
  // in the layout whose Boton was just deleted.
  const kate = bot('b5', 'Kate', { groupId: 'g1', group: 'Work', pinned: true });
  const otto = bot('b6', 'Otto', { groupId: 'g9', group: 'Later' });
  const a = arrange({ ...layout, ungrouped: { collapsed: false, botIds: ['b3', 'gone'] } }, [kevin, stuart, bob, dave, kate, otto]);
  assert.deepEqual(names(a.pinned.bots), ['Kevin', 'Kate']);
  assert.deepEqual(names(a.groups[1].bots), ['Stuart', 'Kevin', 'Kate']);
  assert.deepEqual(names(a.ungrouped.bots), ['Bob', 'Otto']);
  const shown = [...a.groups, a.ungrouped].flatMap((s) => s.bots.map((b) => b.id));
  assert.equal(new Set(shown).size, shown.length);
  assert.equal(shown.length, 6);
});

test('before the layout loads, groups come from the Botons by name', () => {
  const a = arrange(null, [kevin, stuart, bob, dave]);
  assert.deepEqual(a.groups.map((g) => [g.name, names(g.bots)]), [['Home', ['Dave']], ['Work', ['Kevin', 'Stuart']]]);
  assert.deepEqual(names(a.pinned.bots), ['Kevin']);
  assert.deepEqual(names(a.ungrouped.bots), ['Bob']);
});

test('a collapsed section sums what it hides: unread, approvals and busy Botons', () => {
  const busy = { ...dave, unread: 3, status: { state: 'working' } as BotStatus };
  const queued = bot('b7', 'Mel', { status: { state: 'queued' } as BotStatus, unread: 1 });
  const s = summarize([busy, queued, bob], new Map([['b4', 2], ['b3', 1]]));
  assert.deepEqual(s, { unread: 4, approvals: 3, busy: 2 });
  assert.equal(summaryText(s), '4 unread, 3 waiting for approval, 2 working');
  assert.equal(summaryText(summarize([bob], new Map())), '');
});

test('search finds Botons in collapsed groups, by name, role or group, each once', () => {
  const a = arrange(layout, [kevin, stuart, bob, dave]);
  assert.deepEqual(names(search(a, 'dave')), ['Dave']); // Home is collapsed
  assert.deepEqual(names(search(a, 'HOME')), ['Dave']);
  assert.deepEqual(names(search(a, 'captain')), ['Stuart']);
  assert.deepEqual(names(search(a, 'work')), ['Kevin', 'Stuart']); // Kevin is pinned and in Work: once
  assert.deepEqual(search(a, '  '), []);
});

test('moving one place up or down gives the index to send, and none at either end', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepIndex(ids, 'b', -1), 0);
  assert.equal(stepIndex(ids, 'b', 1), 2);
  assert.equal(stepIndex(ids, 'a', -1), null);
  assert.equal(stepIndex(ids, 'c', 1), null);
  assert.equal(stepIndex(ids, 'x', 1), null);
});

test('a drop shows as the server will answer it: within a group, across groups, to Ungrouped, into Pinned, groups', () => {
  // Stuart below Kevin in Work: the index is among the others.
  let l = applyDrop(layout, { kind: 'bot', botId: 'b2', groupId: 'g1', index: 1 });
  assert.deepEqual(l.groups[1].botIds, ['b1', 'b2']);
  // Bob into the collapsed Home (no index: last), out of Ungrouped.
  l = applyDrop(layout, { kind: 'bot', botId: 'b3', groupId: 'g2' });
  assert.deepEqual([l.groups[0].botIds, l.ungrouped.botIds], [['b4', 'b3'], []]);
  // Dave into the empty group, then to the top of Ungrouped.
  l = applyDrop(layout, { kind: 'bot', botId: 'b4', groupId: 'g3', index: 0 });
  assert.deepEqual([l.groups[0].botIds, l.groups[2].botIds], [[], ['b4']]);
  l = applyDrop(l, { kind: 'bot', botId: 'b4', groupId: null, index: 0 });
  assert.deepEqual([l.groups[2].botIds, l.ungrouped.botIds], [[], ['b4', 'b3']]);
  // Pinning keeps the group; pinned again, it reorders.
  l = applyDrop(layout, { kind: 'pin', botId: 'b2', index: 0 });
  assert.deepEqual([l.pinned.botIds, l.groups[1].botIds], [['b2', 'b1'], ['b2', 'b1']]);
  assert.deepEqual(applyDrop(l, { kind: 'pin', botId: 'b2', index: 1 }).pinned.botIds, ['b1', 'b2']);
  // Groups: Empty first.
  assert.deepEqual(applyDrop(layout, { kind: 'group', groupId: 'g3', index: 0 }).groups.map((g) => g.id), ['g3', 'g2', 'g1']);
  // An index past the end is the end, as on the server.
  assert.deepEqual(applyDrop(layout, { kind: 'group', groupId: 'g2', index: 9 }).groups.map((g) => g.id), ['g1', 'g3', 'g2']);
});

test('a drop that changes nothing sends nothing', () => {
  assert.ok(changesNothing(layout, { kind: 'bot', botId: 'b2', groupId: 'g1', index: 0 }));
  // On the collapsed head of the section it is already in, it stays where it is.
  assert.ok(changesNothing(layout, { kind: 'bot', botId: 'b1', groupId: 'g1' }));
  assert.ok(changesNothing(layout, { kind: 'pin', botId: 'b1' }));
  assert.ok(changesNothing(layout, { kind: 'group', groupId: 'g2', index: 0 }));
  assert.ok(!changesNothing(layout, { kind: 'pin', botId: 'b3' }));
  assert.ok(changesNothing(layout, { kind: 'bot', botId: 'b1', groupId: 'nope', index: 0 }), 'a group that is gone takes nothing');
});

test('the drop index is before the first item whose middle is past the pointer', () => {
  const spans = [{ start: 0, end: 40 }, { start: 40, end: 80 }, { start: 80, end: 120 }];
  assert.equal(dropIndex(spans, -10), 0);
  assert.equal(dropIndex(spans, 19), 0);
  assert.equal(dropIndex(spans, 21), 1);
  assert.equal(dropIndex(spans, 99), 2);
  assert.equal(dropIndex(spans, 101), 3);
  assert.equal(dropIndex([], 5), 0);
});
