import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot } from '../../shared/types.ts';
import { addPending, changed, changeText, cleanSite, overlay, type Pending, serial, settle, sitesSummary, toggled, undoPatch } from '../../web/src/live-settings.ts';

const kevin = { id: 'b1', name: 'Kevin', title: 'Inbox', pinned: false, access: 'workspace', connections: ['lib:a'], skills: null, timezone: 'UTC' } as unknown as Bot;

test('a change shows at once, and the saved Boton shows again once it is answered', () => {
  let p: Pending = addPending({}, { pinned: true }, 1);
  assert.equal(overlay(kevin, p).pinned, true);
  assert.equal(overlay(kevin, p).name, 'Kevin');
  p = settle(p, { pinned: true }, 1);
  assert.deepEqual(p, {});
  assert.equal(overlay(kevin, p).pinned, false);
});

test('an earlier answer never hides a later change to the same field', () => {
  let p: Pending = addPending({}, { connections: ['lib:a', 'lib:b'] }, 1);
  p = addPending(p, { connections: ['lib:a', 'lib:b', 'lib:c'] }, 2);
  p = settle(p, { connections: ['lib:a', 'lib:b'] }, 1);
  assert.deepEqual(overlay(kevin, p).connections, ['lib:a', 'lib:b', 'lib:c']);
  p = settle(p, { connections: [] }, 2);
  assert.deepEqual(p, {});
});

test('undo puts back what the page showed, field by field', () => {
  const shown = overlay(kevin, addPending({}, { title: 'Triage' }, 1));
  assert.deepEqual(undoPatch(shown, { title: 'Release', pinned: true }), { title: 'Triage', pinned: false });
  assert.deepEqual(undoPatch(kevin, { skills: ['x'] }), { skills: null });
  // The server resets an effort the new brain lacks, so a brain change's Undo puts the effort back too.
  const ultra = { ...kevin, provider: 'codex-cli', model: '', effort: 'ultra' } as Bot;
  assert.deepEqual(undoPatch(ultra, { provider: 'claude-cli', model: 'sonnet' }), { provider: 'codex-cli', model: '', effort: 'ultra' });
  assert.deepEqual(undoPatch(ultra, { model: 'o' }), { model: '', effort: 'ultra' });
});

test('only real changes are sent', () => {
  assert.deepEqual(changed(kevin, { name: 'Kevin', pinned: true }), { pinned: true });
  assert.deepEqual(changed(kevin, { connections: ['lib:a'] }), {});
  assert.deepEqual(changed(kevin, { skills: [] }), { skills: [] });
});

test('changes run one at a time in order, and a failure does not stop the next', async () => {
  const run = serial();
  const order: string[] = [];
  let release!: () => void;
  const first = run(() => new Promise<void>((r) => (release = () => (order.push('first'), r()))));
  const second = run(async () => {
    order.push('second');
    throw new Error('refused');
  });
  const third = run(async () => order.push('third'));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, []);
  release();
  await first;
  await assert.rejects(second, /refused/);
  await third;
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('toggling a list keeps the others and their order', () => {
  assert.deepEqual(toggled(['a', 'b'], 'c', true), ['a', 'b', 'c']);
  assert.deepEqual(toggled(['a', 'b'], 'a', true), ['a', 'b']);
  assert.deepEqual(toggled(['a', 'b', 'c'], 'b', false), ['a', 'c']);
});

test('toasts say what changed in a few words', () => {
  assert.equal(changeText(kevin, { name: 'Bob' }), 'Name saved');
  assert.equal(changeText(kevin, { pinned: true }), 'Pinned to the top');
  assert.equal(changeText(kevin, { access: 'host' }), 'Kevin has full computer access');
  assert.equal(changeText(kevin, { provider: 'codex-cli', model: '' }), 'Brain changed');
  const names = (id: string) => ({ 'lib:a': 'Docs', 'lib:b': 'Slack' })[id] ?? id;
  assert.equal(changeText(kevin, { connections: ['lib:a', 'lib:b'] }, names), 'Slack on');
  assert.equal(changeText(kevin, { connections: [] }, names), 'Docs off');
  assert.equal(changeText(kevin, { connections: ['lib:b'] }, names), 'Connectors updated');
});

test('sites read as a short summary, and pasted addresses become hosts', () => {
  assert.equal(sitesSummary(['*']), 'All public sites');
  assert.equal(sitesSummary(['*', 'localhost:3000']), 'All public sites + 1 more');
  assert.equal(sitesSummary([]), 'No sites yet');
  assert.equal(sitesSummary(['example.com']), 'example.com');
  assert.equal(sitesSummary(['a.example.com', 'b.example.com', 'c.example.com']), '3 sites');
  assert.equal(cleanSite(' https://Docs.Example.com/guide?x=1 '), 'docs.example.com');
  assert.equal(cleanSite('http://localhost:3000/'), 'localhost:3000');
  assert.equal(cleanSite('www.example.com'), 'www.example.com');
  assert.equal(cleanSite('example.com.'), 'example.com');
  assert.equal(cleanSite('   '), '');
});
