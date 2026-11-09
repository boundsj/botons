import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, BotTemplate, CreatedSidebarGroup, ServerEvent, SidebarImportResult, SidebarLayout, SidebarTransfer } from '../../shared/types.ts';
import { backup, planRestore, restore } from '../src/backup.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer({ env: { BOTONS_TZ: 'UTC' } });
const { app, call, newBot } = s;

const layout = async () => (await call<SidebarLayout>('GET', '/api/sidebar')).data;
const bot = async (id: string) => (await call<Bot>('GET', `/api/bots/${id}`)).data;
async function group(name: string, body: Record<string, unknown> = {}): Promise<string> {
  const r = await call<CreatedSidebarGroup>('POST', '/api/sidebar/groups', { name, ...body });
  assert.equal(r.status, 201, r.text);
  return r.data.groupId;
}
async function ok<T = SidebarLayout>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await call<T>(method, path, body);
  assert.equal(r.status, 200, `${method} ${path}: ${r.text}`);
  return r.data;
}
const move = (id: string, groupId: string | null, index?: number) => ok('POST', `/api/sidebar/bots/${id}/move`, { groupId, ...(index === undefined ? {} : { index }) });
const pin = (id: string, pinned: boolean, index?: number) => ok('POST', `/api/sidebar/bots/${id}/pin`, { pinned, ...(index === undefined ? {} : { index }) });
/** Every group as name: its Botons' names, then ungrouped and pinned the same way. */
async function shape(l?: SidebarLayout) {
  const at = l ?? (await layout());
  const names = new Map(app.store.listBots().map((b) => [b.id, b.name]));
  const n = (ids: string[]) => ids.map((id) => names.get(id) ?? id);
  return {
    groups: at.groups.map((g) => `${g.name}${g.collapsed ? ' (collapsed)' : ''}: ${n(g.botIds).join(', ')}`),
    ungrouped: n(at.ungrouped.botIds),
    pinned: n(at.pinned.botIds),
  };
}
async function clean() {
  for (const b of app.store.listBots()) await call('DELETE', `/api/bots/${b.id}`);
  for (const g of (await layout()).groups) await call('DELETE', `/api/sidebar/groups/${g.id}`);
  await ok('PATCH', '/api/sidebar/sections/pinned', { collapsed: false });
  await ok('PATCH', '/api/sidebar/sections/ungrouped', { collapsed: false });
}

test('new Botons land last among the ungrouped, or last in the group they are made in; every Boton is in exactly one place', async () => {
  await clean();
  assert.deepEqual(await layout(), { pinned: { collapsed: false, botIds: [] }, groups: [], ungrouped: { collapsed: false, botIds: [] } });
  const kevin = await newBot('Kevin');
  const stuart = await newBot('Stuart');
  assert.deepEqual([kevin.groupId, kevin.group], [null, '']);
  const work = await group('Work');
  const bob = await newBot('Bob', { groupId: work });
  assert.deepEqual([bob.groupId, bob.group], [work, 'Work']);
  // By name, in any case: the same group.
  const dave = await newBot('Dave', { group: 'work' });
  assert.equal(dave.groupId, work);
  // A new name makes a group, last.
  const carl = await newBot('Carl', { group: 'Home', pinned: true });
  assert.deepEqual(await shape(), { groups: ['Work: Bob, Dave', 'Home: Carl'], ungrouped: ['Kevin', 'Stuart'], pinned: ['Carl'] });

  assert.equal((await call('POST', '/api/bots', { name: 'Jerry', provider: 'mock', groupId: 'grp_nope' })).status, 404);
  assert.equal((await call('POST', '/api/bots', { name: 'Jerry', provider: 'mock', groupId: work, group: 'Work' })).status, 400);
  assert.ok(!app.store.listBots().some((b) => b.name === 'Jerry'), 'a refused Boton is not made');

  const l = await layout();
  const placed = [...l.groups.flatMap((g) => g.botIds), ...l.ungrouped.botIds].sort();
  assert.deepEqual(placed, app.store.listBots().map((b) => b.id).sort());
  assert.ok(carl.pinned);
});

test('groups: made, renamed (names unique in any case), collapsed and reordered; deleting one moves its Botons to ungrouped and deletes none', async () => {
  await clean();
  const work = await group('Work');
  const home = await group('Home');
  const research = await group('Research', { index: 0 });
  assert.deepEqual((await shape()).groups, ['Research: ', 'Work: ', 'Home: ']);
  assert.equal((await call('POST', '/api/sidebar/groups', { name: ' work ' })).status, 409);
  assert.equal((await call('POST', '/api/sidebar/groups', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/sidebar/groups', { name: 'x'.repeat(41) })).status, 400);
  assert.equal((await call('POST', '/api/sidebar/groups', { name: 'Late', index: -1 })).status, 400);

  const kevin = await newBot('Kevin', { groupId: work });
  const stuart = await newBot('Stuart', { groupId: work, pinned: true });
  const bob = await newBot('Bob');

  // Renaming keeps the id; each member reads the new name.
  assert.equal((await call('PATCH', `/api/sidebar/groups/${home}`, { name: 'WORK' })).status, 409);
  await ok('PATCH', `/api/sidebar/groups/${work}`, { name: 'Day job' });
  assert.equal((await bot(kevin.id)).group, 'Day job');
  // Its own name in another case is fine.
  await ok('PATCH', `/api/sidebar/groups/${work}`, { name: 'Day Job', collapsed: true });
  await ok('POST', `/api/sidebar/groups/${home}/move`, { index: 0 });
  await ok('POST', `/api/sidebar/groups/${research}/move`, { index: 99 });
  assert.deepEqual(await shape(), { groups: ['Home: ', 'Day Job (collapsed): Kevin, Stuart', 'Research: '], ungrouped: ['Bob'], pinned: ['Stuart'] });

  const after = await ok('DELETE', `/api/sidebar/groups/${work}`);
  assert.deepEqual(await shape(after), { groups: ['Home: ', 'Research: '], ungrouped: ['Bob', 'Kevin', 'Stuart'], pinned: ['Stuart'] });
  assert.deepEqual([(await bot(kevin.id)).groupId, (await bot(stuart.id)).group, (await bot(stuart.id)).pinned], [null, '', true]);
  assert.equal(app.store.listBots().length, 3);
  assert.equal(bob.groupId, null);

  for (const [method, path, body] of [
    ['PATCH', '/api/sidebar/groups/grp_nope', { name: 'X' }],
    ['DELETE', '/api/sidebar/groups/grp_nope', undefined],
    ['POST', '/api/sidebar/groups/grp_nope/move', { index: 0 }],
  ] as const) {
    assert.equal((await call(method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await call('PATCH', `/api/sidebar/groups/${home}`, { collapsed: 'yes' })).status, 400);
});

test('Botons move within and between groups at an index, and pin in their own order without leaving their group', async () => {
  await clean();
  const work = await group('Work');
  const [kevin, stuart, bob, dave] = [await newBot('Kevin'), await newBot('Stuart'), await newBot('Bob'), await newBot('Dave')];
  await move(bob.id, null, 0);
  assert.deepEqual((await shape()).ungrouped, ['Bob', 'Kevin', 'Stuart', 'Dave']);
  await move(kevin.id, work);
  await move(dave.id, work, 0);
  // Past the end: last.
  await move(stuart.id, work, 50);
  assert.deepEqual(await shape(), { groups: ['Work: Dave, Kevin, Stuart'], ungrouped: ['Bob'], pinned: [] });
  await move(stuart.id, work, 1);
  assert.deepEqual((await shape()).groups, ['Work: Dave, Stuart, Kevin']);
  assert.equal((await bot(dave.id)).group, 'Work');

  await pin(kevin.id, true);
  await pin(bob.id, true);
  await pin(dave.id, true, 0);
  assert.deepEqual((await shape()).pinned, ['Dave', 'Kevin', 'Bob']);
  // Pinned again: a reorder.
  await pin(dave.id, true, 2);
  assert.deepEqual((await shape()).pinned, ['Kevin', 'Bob', 'Dave']);
  await pin(kevin.id, false);
  assert.deepEqual(await shape(), { groups: ['Work: Dave, Stuart, Kevin'], ungrouped: ['Bob'], pinned: ['Bob', 'Dave'] });
  assert.equal((await bot(kevin.id)).pinned, false);

  // The Boton form's fields still work: a pin or a group by name goes last there; the same values move nothing.
  await ok<Bot>('PATCH', `/api/bots/${stuart.id}`, { pinned: true, group: 'Work' });
  assert.deepEqual(await shape(), { groups: ['Work: Dave, Stuart, Kevin'], ungrouped: ['Bob'], pinned: ['Bob', 'Dave', 'Stuart'] });
  await ok<Bot>('PATCH', `/api/bots/${dave.id}`, { group: '' });
  assert.deepEqual((await shape()).ungrouped, ['Bob', 'Dave']);

  for (const [path, body, status] of [
    [`/api/sidebar/bots/${kevin.id}/move`, { index: 0 }, 400],
    [`/api/sidebar/bots/${kevin.id}/move`, { groupId: work, index: 1.5 }, 400],
    [`/api/sidebar/bots/${kevin.id}/move`, { groupId: 'grp_nope' }, 404],
    ['/api/sidebar/bots/bot_nope/move', { groupId: null }, 404],
    [`/api/sidebar/bots/${kevin.id}/pin`, {}, 400],
    [`/api/sidebar/bots/${kevin.id}/pin`, { pinned: false, index: 0 }, 400],
    ['/api/sidebar/bots/bot_nope/pin', { pinned: true }, 404],
  ] as const) {
    assert.equal((await call('POST', path, body)).status, status, `${path} ${JSON.stringify(body)}`);
  }
});

test('Pinned and Ungrouped collapse too; the layout is the same for every device, and every change reaches them live', async () => {
  await clean();
  const events = await s.events();
  try {
    const kevin = await newBot('Kevin');
    const work = await group('Work');
    await move(kevin.id, work);
    await ok('PATCH', '/api/sidebar/sections/pinned', { collapsed: true });
    const last = await ok('PATCH', '/api/sidebar/sections/ungrouped', { collapsed: true });
    assert.deepEqual([last.pinned.collapsed, last.ungrouped.collapsed], [true, true]);
    assert.equal((await call('PATCH', '/api/sidebar/sections/work', { collapsed: true })).status, 404);
    assert.equal((await call('PATCH', '/api/sidebar/sections/pinned', {})).status, 400);

    const updates = () => events.events.filter((e): e is Extract<ServerEvent, { type: 'sidebar.updated' }> => e.type === 'sidebar.updated');
    // Made, its group made, moved, two sections.
    await until(() => updates().length >= 5);
    assert.deepEqual(updates().at(-1)!.layout, await layout());
    assert.deepEqual(updates()[0].layout.ungrouped.botIds, [kevin.id]);
    const moved = updates().find((u) => u.layout.groups[0]?.botIds.includes(kevin.id));
    assert.ok(moved, 'the move went out');
    // The Boton's own row says where it is now.
    assert.ok(events.events.some((e) => e.type === 'bot.upserted' && e.bot.id === kevin.id && e.bot.groupId === work));

    // Deleting a Boton takes it out of the layout.
    const n = updates().length;
    await call('DELETE', `/api/bots/${kevin.id}`);
    await until(() => updates().length > n);
    assert.deepEqual(updates().at(-1)!.layout.groups[0].botIds, []);
  } finally {
    events.close();
  }
  // A second device sees the same.
  const other = await (await import('./helpers.ts')).pairDevice(app, s.base, 'Phone');
  assert.deepEqual((await call<SidebarLayout>('GET', '/api/sidebar', undefined, other)).data, await layout());
});

test("the layout is the owner's: a Boton's token can't read or change it", async () => {
  await clean();
  const kevin = await newBot('Kevin');
  const turn = app.auth.mintBotonToken(kevin.id);
  try {
    for (const [method, path, body] of [
      ['GET', '/api/sidebar', undefined],
      ['POST', '/api/sidebar/groups', { name: 'Mine' }],
      ['POST', `/api/sidebar/bots/${kevin.id}/pin`, { pinned: true }],
      ['POST', `/api/sidebar/bots/${kevin.id}/move`, { groupId: null }],
      ['PATCH', '/api/sidebar/sections/pinned', { collapsed: true }],
    ] as const) {
      assert.equal((await call(method, path, body, turn.token)).status, 403, `${method} ${path}`);
    }
    assert.equal((await call('GET', '/api/sidebar', undefined, null)).status, 401);
  } finally {
    turn.revoke();
  }
  assert.deepEqual(await shape(), { groups: [], ungrouped: ['Kevin'], pinned: [] });
});

test('a copy goes last in its original\'s group, unpinned; a Boton from a template goes to the template\'s group by name, made again if it was deleted', async () => {
  await clean();
  const ops = await group('Ops');
  const kevin = await newBot('Kevin', { groupId: ops, pinned: true });
  await newBot('Stuart', { groupId: ops });
  const copy = (await call<Bot>('POST', `/api/bots/${kevin.id}/duplicate`, { name: 'Kevin 2' })).data;
  assert.deepEqual([copy.groupId, copy.pinned], [ops, false]);
  assert.deepEqual((await shape()).groups, ['Ops: Kevin, Stuart, Kevin 2']);

  const tpl = (await call<BotTemplate>('POST', '/api/templates', { fromBotId: kevin.id, name: 'Triage' })).data;
  assert.equal(tpl.bot.group, 'Ops');
  const made = (await call<Bot>('POST', '/api/bots', { name: 'Bob', provider: 'mock', templateId: tpl.id, group: tpl.bot.group })).data;
  assert.equal(made.groupId, ops);
  await call('DELETE', `/api/sidebar/groups/${ops}`);
  const again = (await call<Bot>('POST', '/api/bots', { name: 'Dave', provider: 'mock', templateId: tpl.id, group: tpl.bot.group })).data;
  assert.notEqual(again.groupId, ops);
  assert.deepEqual(await shape(), { groups: ['Ops: Dave'], ungrouped: ['Kevin', 'Stuart', 'Kevin 2', 'Bob'], pinned: ['Kevin'] });
  await call('DELETE', `/api/templates/${tpl.id}`);
});

test('group names are one group under Unicode case and composition, the same way everywhere', async () => {
  await clean();
  const equipe = await group('Équipe');
  for (const same of ['équipe', 'ÉQUIPE', 'Équipe', 'éQUIPE']) {
    assert.equal((await call('POST', '/api/sidebar/groups', { name: same })).status, 409, same);
    assert.equal((await newBot(`Kevin ${same}`, { group: same })).groupId, equipe, same);
  }
  const strasse = await group('Straße');
  for (const same of ['STRASSE', 'STRAẞE', 'straße']) {
    assert.equal((await call('POST', '/api/sidebar/groups', { name: same })).status, 409, same);
    assert.equal((await newBot('Bob', { group: same })).groupId, strasse, same);
  }
  assert.equal((await call('PATCH', `/api/sidebar/groups/${strasse}`, { name: 'ÉQUIPE' })).status, 409);
  // Its own name in another case, accented, is fine, and stays the one group.
  await ok('PATCH', `/api/sidebar/groups/${equipe}`, { name: 'équipe' });
  assert.equal((await newBot('Stuart', { group: 'Équipe' })).groupId, equipe);
  assert.deepEqual((await layout()).groups.map((g) => g.name), ['équipe', 'Straße']);
});

test('the layout exports to a file of its own and imports back: empty groups, order, membership, pins and collapse', async () => {
  await clean();
  const work = await group('Work');
  const empty = await group('Empty');
  await group('Home', { index: 0 });
  const [kevin, stuart, bob, dave] = [await newBot('Kevin'), await newBot('Stuart'), await newBot('Bob'), await newBot('Dave')];
  await move(stuart.id, work);
  await move(kevin.id, work, 0);
  await pin(bob.id, true);
  await pin(kevin.id, true, 0);
  await ok('PATCH', `/api/sidebar/groups/${work}`, { collapsed: true });
  await ok('PATCH', '/api/sidebar/sections/pinned', { collapsed: true });
  const saved = await layout();
  const file = await ok<SidebarTransfer>('GET', '/api/sidebar/export');
  assert.equal(file.format, 'botons-sidebar');
  assert.equal(file.version, 1);
  assert.deepEqual(
    file.groups.map((g) => [g.name, g.collapsed, g.botIds]),
    [
      ['Home', false, []],
      ['Work', true, [kevin.id, stuart.id]],
      ['Empty', false, []],
    ],
  );
  assert.ok(!JSON.stringify(file).includes(work), 'groups are by name in the file');

  // Everything changed afterwards; importing the file puts it back, groups of the same name keeping their ids.
  await call('DELETE', `/api/sidebar/groups/${work}`);
  await group('Research');
  await pin(bob.id, false);
  await move(dave.id, empty);
  await ok('PATCH', '/api/sidebar/sections/pinned', { collapsed: false });
  await ok('PATCH', '/api/sidebar/sections/ungrouped', { collapsed: true });
  const r0 = await ok<SidebarImportResult>('POST', '/api/sidebar/import', JSON.parse(JSON.stringify(file)));
  assert.deepEqual(r0.skipped, []);
  const back = await layout();
  assert.deepEqual(r0.layout, back);
  assert.deepEqual(await shape(back), await shape(saved));
  assert.equal(back.groups.find((g) => g.name === 'Empty')!.id, empty);
  assert.deepEqual([back.pinned.collapsed, back.ungrouped.collapsed], [true, false]);
  assert.equal((await bot(kevin.id)).group, 'Work');

  // A Boton the file doesn't know keeps its pin and goes last among the ungrouped; one the server doesn't, is skipped.
  const carl = await newBot('Carl', { pinned: true });
  const other = { ...file, groups: [...file.groups, { name: 'Gone', collapsed: false, botIds: ['bot_elsewhere'] }] };
  const r = await ok<SidebarImportResult>('POST', '/api/sidebar/import', other);
  assert.deepEqual(r.skipped, ['bot_elsewhere']);
  assert.deepEqual(await shape(r.layout), { ...(await shape(saved)), groups: [...(await shape(saved)).groups, 'Gone: '], ungrouped: ['Bob', 'Dave', 'Carl'], pinned: ['Kevin', 'Bob', 'Carl'] });
  assert.ok(carl.pinned);
});

test('a layout file with any problem imports nothing', async () => {
  await clean();
  const work = await group('Work');
  const kevin = await newBot('Kevin', { groupId: work, pinned: true });
  await newBot('Stuart');
  const good = await ok<SidebarTransfer>('GET', '/api/sidebar/export');
  const before = await layout();
  const g = good.groups[0];
  for (const [why, body] of [
    ['not an object', []],
    ['wrong format', { ...good, format: 'something-else' }],
    ['a later version', { ...good, version: 2 }],
    ['groups not a list', { ...good, groups: {} }],
    ['a name too long', { ...good, groups: [{ ...g, name: 'x'.repeat(41) }] }],
    ['an empty name', { ...good, groups: [{ ...g, name: '  ' }] }],
    ['the same name twice', { ...good, groups: [g, { name: 'WORK', collapsed: false, botIds: [] }] }],
    ['the same accented name twice', { ...good, groups: [g, { name: 'Équipe', collapsed: false, botIds: [] }, { name: 'équipe', collapsed: false, botIds: [] }] }],
    ['collapsed not a flag', { ...good, ungrouped: { ...good.ungrouped, collapsed: 'no' } }],
    ['a Boton in two groups', { ...good, ungrouped: { ...good.ungrouped, botIds: [...good.ungrouped.botIds, kevin.id] } }],
    ['pinned twice', { ...good, pinned: { ...good.pinned, botIds: [kevin.id, kevin.id] } }],
    ['an id not a string', { ...good, pinned: { ...good.pinned, botIds: [7] } }],
    ['no pinned section', { ...good, pinned: undefined }],
    ['too many groups', { ...good, groups: Array.from({ length: 101 }, (_, i) => ({ name: `G${i}`, collapsed: false, botIds: [] })) }],
  ] as const) {
    const r = await call('POST', '/api/sidebar/import', body);
    assert.equal(r.status, 400, `${why}: ${r.text}`);
    assert.deepEqual(await layout(), before, why);
  }
});

// Last: it stops the server, restores into its home and starts it again.
test('the layout is in every backup: a restore puts back groups, order, pins and collapsed sections as they were', async () => {
  await clean();
  const work = await group('Work');
  await group('Home', { index: 0 });
  const [kevin, stuart, bob] = [await newBot('Kevin'), await newBot('Stuart'), await newBot('Bob')];
  await move(stuart.id, work);
  await move(kevin.id, work, 0);
  await pin(bob.id, true);
  await pin(kevin.id, true, 0);
  await ok('PATCH', `/api/sidebar/groups/${work}`, { collapsed: true });
  await ok('PATCH', '/api/sidebar/sections/ungrouped', { collapsed: true });
  const saved = await layout();
  backup({ home: s.home });

  // Changed after the backup: the restore undoes it.
  await call('DELETE', `/api/sidebar/groups/${work}`);
  await pin(bob.id, false);
  await s.stop();
  restore(s.home, planRestore({ home: s.home, backup: 'latest', maxSchema: SCHEMA_VERSION }));

  const again = await startServer({ home: s.home, token: s.token, env: { BOTONS_TZ: 'UTC' } });
  try {
    assert.deepEqual((await again.call<SidebarLayout>('GET', '/api/sidebar')).data, saved);
    assert.equal((await again.call<Bot>('GET', `/api/bots/${kevin.id}`)).data.group, 'Work');
  } finally {
    await again.stop();
  }
});
