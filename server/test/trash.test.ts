import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { AuditEvent, Bot, FileListing, RestoreResult, StorageUsage, TrashItem, TrashResult } from '../../shared/types.ts';
import type { TrashHooks } from '../src/trash.ts';
import { failOnEscapedErrors, startServer, tempDir } from './helpers.ts';

const DAY = 86_400_000;
let clock = Date.now();
// Each test sets the moves a racing Boton makes, and clears them.
const hooks: TrashHooks = {};
const s = await startServer({ appOptions: { storageClock: () => clock, trashHooks: hooks } });
const { app, call, newBot } = s;
failOnEscapedErrors();
const outside = tempDir('botons-trash-outside-');
writeFileSync(join(outside, 'keep.txt'), 'not the workspace');

function put(bot: Bot, rel: string, content = 'x', daysAgo = 0) {
  const p = join(bot.workspace, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  const t = new Date(clock - daysAgo * DAY);
  utimesSync(p, t, t);
}
const del = (bot: Bot, paths: unknown, token?: string | null) => call<TrashResult>('POST', `/api/bots/${bot.id}/files/delete`, { paths }, token);
const trashOf = async (bot: Bot) => (await call<TrashItem[]>('GET', `/api/bots/${bot.id}/trash`)).data;
const auditOf = async (action: string): Promise<AuditEvent[]> => (await call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === action);

test('deleting moves files and folders to the trash, kept with where they were and whose; restore puts them back', async () => {
  const bot = await newBot('Kevin');
  put(bot, 'notes.md', 'hello');
  put(bot, 'reports/a.txt', 'aaaa');
  put(bot, 'reports/b.txt', 'bb');
  const r = await del(bot, ['notes.md', 'reports', 'reports/a.txt']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // The folder and something in it: the folder is enough.
  assert.deepEqual(r.data.trashed.map((t) => [t.path, t.isDir, t.size, t.reason]).sort(), [
    ['notes.md', false, 5, 'deleted'],
    ['reports', true, 6, 'deleted'],
  ]);
  assert.equal(existsSync(join(bot.workspace, 'notes.md')), false);
  assert.equal(existsSync(join(bot.workspace, 'reports')), false);
  const items = await trashOf(bot);
  assert.equal(items.length, 2);
  for (const i of items) {
    assert.equal(i.botId, bot.id);
    assert.equal(i.botName, 'Kevin');
    assert.equal(Date.parse(i.purgeAt) - Date.parse(i.deletedAt), 30 * DAY);
    assert.ok(existsSync(join(s.home, 'trash', i.id, 'item')));
  }
  const ev = (await auditOf('files.trashed'))[0];
  assert.equal(ev.target?.id, bot.id);
  assert.equal(ev.details.items, 2);

  const folder = items.find((i) => i.isDir)!;
  const back = await call<RestoreResult>('POST', `/api/trash/${folder.id}/restore`);
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.deepEqual(back.data, { origin: 'workspace', path: 'reports', renamed: false, folderGone: false });
  assert.equal(readFileSync(join(bot.workspace, 'reports/a.txt'), 'utf8'), 'aaaa');
  assert.equal(existsSync(join(s.home, 'trash', folder.id)), false);
  assert.equal((await auditOf('files.restored'))[0].details.path, 'reports');
  assert.equal((await call('POST', `/api/trash/${folder.id}/restore`)).status, 404);
});

test('a restore never replaces anything: a taken name gets -2, -3; a folder that is gone is made again', async () => {
  const bot = await newBot('Stuart');
  put(bot, 'docs/plan.txt', 'first');
  const [first] = (await del(bot, ['docs/plan.txt'])).data.trashed;
  put(bot, 'docs/plan.txt', 'second');
  const [second] = (await del(bot, ['docs/plan.txt'])).data.trashed;
  put(bot, 'docs/plan.txt', 'third');
  assert.deepEqual((await call('POST', `/api/trash/${first.id}/restore`)).data, { origin: 'workspace', path: 'docs/plan-2.txt', renamed: true, folderGone: false });
  assert.deepEqual((await call('POST', `/api/trash/${second.id}/restore`)).data, { origin: 'workspace', path: 'docs/plan-3.txt', renamed: true, folderGone: false });
  assert.equal(readFileSync(join(bot.workspace, 'docs/plan.txt'), 'utf8'), 'third');
  assert.equal(readFileSync(join(bot.workspace, 'docs/plan-2.txt'), 'utf8'), 'first');
  assert.equal(readFileSync(join(bot.workspace, 'docs/plan-3.txt'), 'utf8'), 'second');

  assert.equal((await del(bot, [])).status, 400);
  put(bot, 'gone/y.txt', 'y');
  const [y] = (await del(bot, ['gone/y.txt'])).data.trashed;
  await del(bot, ['gone']);
  assert.deepEqual((await call('POST', `/api/trash/${y.id}/restore`)).data, { origin: 'workspace', path: 'gone/y.txt', renamed: false, folderGone: false });
  // A file now where its folder was: back in the workspace's top folder instead.
  put(bot, 'blocked/z.txt', 'z');
  const [z] = (await del(bot, ['blocked/z.txt'])).data.trashed;
  await del(bot, ['blocked']);
  put(bot, 'blocked', 'a file');
  assert.deepEqual((await call('POST', `/api/trash/${z.id}/restore`)).data, { origin: 'workspace', path: 'z.txt', renamed: true, folderGone: true });
});

test('paths stay inside the workspace: .., absolute paths, symlinked folders; roots and kept folders are refused', async () => {
  const bot = await newBot('Bob');
  put(bot, 'inbox/a.txt');
  put(bot, 'ok.txt');
  symlinkSync(outside, join(bot.workspace, 'out'));
  symlinkSync(join(outside, 'keep.txt'), join(bot.workspace, 'out-file'));
  for (const p of ['', '.', './', 'inbox', 'inbox/', './inbox', 'x/../inbox', bot.workspace, `${bot.workspace}/`]) {
    const r = await del(bot, [p]);
    assert.ok(r.status === 403 || r.status === 400, `${JSON.stringify(p)}: ${r.status}`);
  }
  for (const p of ['../x', '../../etc/passwd', join(outside, 'keep.txt'), 'out/keep.txt', '/etc/hosts']) {
    const r = await del(bot, [p]);
    assert.equal(r.status, 403, `${p}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  assert.equal((await del(bot, ['missing.txt'])).status, 404);
  assert.equal((await del(bot, 'ok.txt')).status, 400);
  assert.equal((await del(bot, ['ok\0.txt'])).status, 400);
  // One bad path, and nothing moves.
  assert.equal((await del(bot, ['ok.txt', '../x'])).status, 403);
  assert.ok(existsSync(join(bot.workspace, 'ok.txt')));
  // A symlink goes to the trash as the link: what it points to is never touched.
  const r = await del(bot, ['out', 'out-file']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'not the workspace');
  const items = await trashOf(bot);
  for (const i of items) assert.ok(readlinkSync(join(s.home, 'trash', i.id, 'item')).startsWith(outside));
  assert.deepEqual(readdirSync(outside), ['keep.txt']);

  // A workspace that holds the shared folder or others' workspaces (an absolute one, say): those can't go.
  const wide = await newBot('Dave');
  app.store.db.prepare('update bots set workspace = ? where id = ?').run(s.home, wide.id);
  for (const p of ['shared', 'workspaces', 'trash']) assert.equal((await del(wide, [p])).status, 403, p);
});

test('only a paired device: no Boton token, its own included, reaches delete, restore, purge, pins or Clear inbox', async () => {
  const bot = await newBot('Jerry');
  put(bot, 'inbox/a.txt');
  put(bot, 'b.txt');
  const [item] = (await del(bot, ['b.txt'])).data.trashed;
  const boton = app.auth.mintBotonToken(bot.id).token;
  const routes: [string, string, unknown?][] = [
    ['POST', `/api/bots/${bot.id}/files/delete`, { paths: ['inbox/a.txt'] }],
    ['POST', `/api/bots/${bot.id}/inbox/clear`],
    ['POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/a.txt', pinned: true }],
    ['GET', `/api/bots/${bot.id}/trash`],
    ['POST', `/api/bots/${bot.id}/trash/empty`],
    ['GET', '/api/trash'],
    ['POST', `/api/trash/${item.id}/restore`],
    ['DELETE', `/api/trash/${item.id}`],
    ['GET', `/api/bots/${bot.id}/storage`],
    ['GET', '/api/storage'],
    ['GET', '/api/shared/files'],
    ['GET', '/api/shared/files/raw?path=a.txt'],
    ['POST', '/api/shared/files/delete', { paths: ['a.txt'] }],
    ['GET', '/api/shared/trash'],
    ['POST', '/api/shared/trash/empty'],
  ];
  put(bot, 'b.txt');
  writeFileSync(join(s.home, 'shared', 'a.txt'), 'shared');
  for (const [method, path, body] of routes) {
    assert.equal((await call(method, path, body, boton)).status, 403, `${method} ${path} with the Boton's token`);
    assert.equal((await call(method, path, body, null)).status, 401, `${method} ${path} with no token`);
  }
  assert.ok(existsSync(join(bot.workspace, 'inbox/a.txt')));
  assert.ok(existsSync(join(s.home, 'shared', 'a.txt')));
  assert.equal((await trashOf(bot)).length, 1);
  rmSync(join(s.home, 'shared', 'a.txt'));
});

test('delete forever and empty: gone from disk, recorded; a deleted Boton’s items can only be deleted forever', async () => {
  const bot = await newBot('Mel');
  put(bot, 'a.txt');
  put(bot, 'b.txt');
  put(bot, 'c.txt');
  const [a, b, c] = (await del(bot, ['a.txt', 'b.txt', 'c.txt'])).data.trashed;
  assert.equal((await call('DELETE', `/api/trash/${a.id}`)).status, 204);
  assert.equal(existsSync(join(s.home, 'trash', a.id)), false);
  assert.equal((await call('DELETE', `/api/trash/${a.id}`)).status, 404);
  assert.equal((await call('DELETE', '/api/trash/..%2F..')).status, 404);
  assert.deepEqual((await call('POST', `/api/bots/${bot.id}/trash/empty`)).data, { purged: 2 });
  assert.equal(existsSync(join(s.home, 'trash', b.id)) || existsSync(join(s.home, 'trash', c.id)), false);
  assert.ok((await auditOf('files.purged')).some((e) => e.details.items === 2));

  const gone = await newBot('Tim');
  put(gone, 'd.txt');
  const [d] = (await del(gone, ['d.txt'])).data.trashed;
  assert.equal((await call('DELETE', `/api/bots/${gone.id}`)).status < 300, true);
  const all = (await call<TrashItem[]>('GET', '/api/trash')).data;
  assert.equal(all.find((i) => i.id === d.id)?.botGone, true);
  assert.equal((await call('POST', `/api/trash/${d.id}/restore`)).status, 409);
  assert.equal((await call('DELETE', `/api/trash/${d.id}`)).status, 204);
});

test('inbox: Keep pins a file; Clear inbox and the daily cleanup skip kept ones; nothing outside the inbox is touched', async () => {
  const bot = await newBot('Phil');
  put(bot, 'inbox/old.pdf', 'old', 40);
  put(bot, 'inbox/kept.pdf', 'kept', 40);
  put(bot, 'inbox/new.pdf', 'new', 2);
  put(bot, 'inbox/folder/old-inside.txt', 'f', 40);
  utimesSync(join(bot.workspace, 'inbox/folder'), new Date(clock - 40 * DAY), new Date(clock - 40 * DAY));
  put(bot, 'inbox/.upload-0123456789abcdef.part', 'p', 40);
  put(bot, 'moved-out.pdf', 'moved', 400);
  put(bot, 'notes/old.txt', 'old', 400);
  writeFileSync(join(s.cfg.sharedDir, 'shared-old.txt'), 'shared');
  utimesSync(join(s.cfg.sharedDir, 'shared-old.txt'), new Date(clock - 400 * DAY), new Date(clock - 400 * DAY));

  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/kept.pdf', pinned: true })).status, 200);
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'notes/old.txt', pinned: true })).status, 400);
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/folder/old-inside.txt', pinned: true })).status, 400);
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/kept.pdf', pinned: 'yes' })).status, 400);
  const listing = (await call<FileListing>('GET', `/api/bots/${bot.id}/files?path=inbox`)).data;
  assert.equal(listing.entries.find((e) => e.name === 'kept.pdf')?.pinned, true);
  assert.equal(listing.entries.find((e) => e.name === 'old.pdf')?.pinned, false);

  // The daily cleanup: once a day, files directly in the inbox untouched for 30 days (the default).
  assert.equal(app.store.getSettings().inboxCleanupDays, 30);
  const done = await app.trash.housekeep({ force: true });
  assert.deepEqual(done, { purged: 0, cleaned: 1 });
  assert.equal(await app.trash.housekeep(), null, 'not again the same day');
  const inbox = readdirSync(join(bot.workspace, 'inbox')).sort();
  assert.deepEqual(inbox, ['.upload-0123456789abcdef.part', 'folder', 'kept.pdf', 'new.pdf']);
  assert.ok(existsSync(join(bot.workspace, 'moved-out.pdf')) && existsSync(join(bot.workspace, 'notes/old.txt')) && existsSync(join(s.cfg.sharedDir, 'shared-old.txt')));
  const cleaned = (await trashOf(bot)).filter((i) => i.reason === 'inbox_cleanup');
  assert.deepEqual(cleaned.map((i) => i.path), ['inbox/old.pdf']);
  const ev = (await auditOf('inbox.cleaned_up'))[0];
  assert.equal(ev.actor.kind, 'system');
  assert.equal(ev.details.days, 30);

  // Off: nothing moves, however old.
  assert.equal((await call('PATCH', '/api/settings', { inboxCleanupDays: null })).data.inboxCleanupDays, null);
  assert.equal((await call('PATCH', '/api/settings', { inboxCleanupDays: 3 })).status, 400);
  put(bot, 'inbox/older.pdf', 'o', 100);
  clock += DAY + 1;
  assert.deepEqual(await app.trash.housekeep(), { purged: 0, cleaned: 0 });
  assert.ok(existsSync(join(bot.workspace, 'inbox/older.pdf')));
  assert.equal((await call('PATCH', '/api/settings', { inboxCleanupDays: 7 })).data.inboxCleanupDays, 7);
  assert.equal(app.store.getSettings().inboxCleanupDays, 7);

  // Clear inbox: everything directly in it, folders too, but kept and hidden ones.
  const cleared = await call<TrashResult>('POST', `/api/bots/${bot.id}/inbox/clear`);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.trashed.map((i) => i.path).sort(), ['inbox/folder', 'inbox/new.pdf', 'inbox/older.pdf']);
  assert.equal(cleared.data.kept, 1);
  assert.deepEqual(readdirSync(join(bot.workspace, 'inbox')).sort(), ['.upload-0123456789abcdef.part', 'kept.pdf']);
  assert.equal((await auditOf('inbox.cleared'))[0].details.kept, 1);

  // Unpinned, the next cleanup takes it.
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/kept.pdf', pinned: false })).status, 200);
  clock += DAY + 1;
  assert.equal((await app.trash.housekeep())?.cleaned, 1);
  assert.equal(existsSync(join(bot.workspace, 'inbox/kept.pdf')), false);
  await call('PATCH', '/api/settings', { inboxCleanupDays: 30 });
});

test('an inbox that is a symlink is never swept; the trash past 30 days is deleted for good, recorded by Botons', async () => {
  const bot = await newBot('Otto');
  mkdirSync(bot.workspace, { recursive: true });
  const elsewhere = tempDir('botons-trash-inbox-');
  writeFileSync(join(elsewhere, 'old.txt'), 'x');
  utimesSync(join(elsewhere, 'old.txt'), new Date(clock - 100 * DAY), new Date(clock - 100 * DAY));
  symlinkSync(elsewhere, join(bot.workspace, 'inbox'));
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/clear`)).data.trashed.length, 0);
  clock += DAY + 1;
  await app.trash.housekeep();
  assert.deepEqual(readdirSync(elsewhere), ['old.txt']);

  put(bot, 'later.txt');
  const [item] = (await del(bot, ['later.txt'])).data.trashed;
  clock += 29 * DAY;
  await app.trash.housekeep({ force: true });
  assert.ok(existsSync(join(s.home, 'trash', item.id)), 'kept for 30 days');
  clock += DAY + 1;
  const done = await app.trash.housekeep({ force: true });
  assert.ok(done && done.purged >= 1);
  assert.equal(existsSync(join(s.home, 'trash', item.id)), false);
  const ev = (await auditOf('files.purged')).find((e) => e.target?.id === bot.id);
  assert.equal(ev?.actor.kind, 'system');
  assert.equal(ev?.details.afterDays, 30);
});

test('sizes: each Boton’s workspace, inbox and trash, and the shared folder', async () => {
  const bot = await newBot('Norbert');
  put(bot, 'inbox/a.bin', 'a'.repeat(1000));
  put(bot, 'work/b.bin', 'b'.repeat(500));
  put(bot, 'c.bin', 'c'.repeat(200));
  await del(bot, ['c.bin']);
  writeFileSync(join(s.cfg.sharedDir, 'size.bin'), 's'.repeat(300));
  const mine = (await call('GET', `/api/bots/${bot.id}/storage`)).data;
  assert.equal(mine.workspaceBytes, 1500);
  assert.equal(mine.inboxBytes, 1000);
  assert.equal(mine.trashBytes, 200);
  assert.equal(mine.trashItems, 1);
  assert.ok(mine.sharedBytes >= 300);
  const all = (await call<StorageUsage>('GET', '/api/storage')).data;
  assert.equal(all.bots.find((b) => b.botId === bot.id)?.inboxBytes, 1000);
  assert.ok(all.trashBytes >= 200);
  assert.equal(all.trashKeepDays, 30);
});

test('a restore whose folder a Boton turned into a link out of the workspace makes nothing out there', async () => {
  const bot = await newBot('Carl');
  put(bot, 'out/sub/x.txt', 'x');
  const [x] = (await del(bot, ['out/sub/x.txt'])).data.trashed;
  await del(bot, ['out']);
  const elsewhere = tempDir('botons-trash-restore-');
  symlinkSync(elsewhere, join(bot.workspace, 'out'));
  const r = await call<RestoreResult>('POST', `/api/trash/${x.id}/restore`);
  assert.deepEqual(r.data, { origin: 'workspace', path: 'x.txt', renamed: true, folderGone: true });
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(readFileSync(join(bot.workspace, 'x.txt'), 'utf8'), 'x');
});

/** A folder swapped for a link out, as a racing Boton would: the real one moved aside, a link left in its place. */
function swapForLink(folder: string, to: string) {
  renameSync(folder, `${folder}-moved`);
  symlinkSync(to, folder);
}

test('a folder swapped for a link out just before the move: the checked file goes, nothing outside is touched', async () => {
  const bot = await newBot('Gru');
  put(bot, 'a/b.txt', 'inside');
  const elsewhere = tempDir('botons-trash-swap-');
  writeFileSync(join(elsewhere, 'b.txt'), 'outside');
  hooks.beforeRename = () => {
    hooks.beforeRename = undefined;
    swapForLink(join(bot.workspace, 'a'), elsewhere);
  };
  const r = await del(bot, ['a/b.txt']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(readFileSync(join(elsewhere, 'b.txt'), 'utf8'), 'outside');
  assert.equal(readFileSync(join(s.home, 'trash', r.data.trashed[0].id, 'item'), 'utf8'), 'inside');
  assert.equal(existsSync(join(bot.workspace, 'a-moved/b.txt')), false);

  // Swapped before the folder is opened: refused, and nothing moves anywhere.
  put(bot, 'c/d.txt', 'inside');
  writeFileSync(join(elsewhere, 'd.txt'), 'outside');
  hooks.beforeOpen = () => {
    hooks.beforeOpen = undefined;
    swapForLink(join(bot.workspace, 'c'), elsewhere);
  };
  const before = (await trashOf(bot)).length;
  assert.equal((await del(bot, ['c/d.txt'])).status, 409);
  assert.equal(readFileSync(join(elsewhere, 'd.txt'), 'utf8'), 'outside');
  assert.equal(readFileSync(join(bot.workspace, 'c-moved/d.txt'), 'utf8'), 'inside');
  assert.equal((await trashOf(bot)).length, before);
});

test('a restore whose folder is swapped for a link out just before a folder is made: nothing is made out there', async () => {
  const bot = await newBot('Lucy');
  put(bot, 'a/sub/x.txt', 'x');
  const [x] = (await del(bot, ['a/sub/x.txt'])).data.trashed;
  await del(bot, ['a/sub']);
  const elsewhere = tempDir('botons-trash-mkdir-');
  hooks.beforeMkdir = (_parent, name) => {
    if (name !== 'sub') return;
    hooks.beforeMkdir = undefined;
    swapForLink(join(bot.workspace, 'a'), elsewhere);
  };
  const r = await call<RestoreResult>('POST', `/api/trash/${x.id}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(readdirSync(elsewhere), []);
  // Made in the folder that was checked, wherever the Boton moved it.
  assert.deepEqual(r.data, { origin: 'workspace', path: 'a-moved/sub/x.txt', renamed: true, folderGone: false });
  assert.equal(readFileSync(join(bot.workspace, 'a-moved/sub/x.txt'), 'utf8'), 'x');
});

// A workspace on another disk than BOTONS_HOME (here a tmpfs at /dev/shm, when it is another device than the temp folder).
const shm = existsSync('/dev/shm') && statSync('/dev/shm').dev !== statSync(s.home).dev ? mkdtempSync('/dev/shm/botons-trash-') : null;
after(() => {
  if (!shm) return;
  for (const d of readdirSync(shm, { recursive: true }) as string[]) {
    const p = join(shm, d);
    if (lstatSync(p).isDirectory()) chmodSync(p, 0o700);
  }
  rmSync(shm, { recursive: true, force: true });
});

test('across two disks a delete is refused and nothing changes, a race or an unwritable folder notwithstanding', { skip: !shm && 'no second disk at /dev/shm' }, async () => {
  const bot = await newBot('Margo');
  const ws = join(shm!, 'margo');
  mkdirSync(ws);
  app.store.db.prepare('update bots set workspace = ? where id = ?').run(ws, bot.id);
  const moved = { ...bot, workspace: ws };

  // A folder with a writable file and a folder that can't be emptied.
  put(moved, 'dir/a.txt', 'a');
  put(moved, 'dir/locked/b.txt', 'b');
  chmodSync(join(ws, 'dir/locked'), 0o555);
  const r = await del(moved, ['dir']);
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match((r.data as unknown as { error: string }).error, /another disk/);
  assert.equal(readFileSync(join(ws, 'dir/a.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(join(ws, 'dir/locked/b.txt'), 'utf8'), 'b');
  assert.deepEqual(await trashOf(bot), []);
  const leftovers = readdirSync(join(s.home, 'trash')).filter((id) => !existsSync(join(s.home, 'trash', id, 'item')));
  assert.deepEqual(leftovers, []);

  // The folder swapped for a link to a file on the trash's own disk, just before the move: that file stays.
  put(moved, 'f/note.txt', 'inside');
  const elsewhere = tempDir('botons-trash-xdev-');
  writeFileSync(join(elsewhere, 'note.txt'), 'outside');
  hooks.beforeRename = () => {
    hooks.beforeRename = undefined;
    swapForLink(join(ws, 'f'), elsewhere);
  };
  assert.equal((await del(moved, ['f/note.txt'])).status, 409);
  assert.equal(readFileSync(join(elsewhere, 'note.txt'), 'utf8'), 'outside');
  assert.equal(readFileSync(join(ws, 'f-moved/note.txt'), 'utf8'), 'inside');
  assert.deepEqual(await trashOf(bot), []);
});

test('the shared folder: listed, downloaded, deleted to the trash and restored there; its own folder is kept', async () => {
  const shared = join(s.home, 'shared');
  for (const n of readdirSync(shared)) rmSync(join(shared, n), { recursive: true });
  mkdirSync(join(shared, 'notes'), { recursive: true });
  writeFileSync(join(shared, 'notes/a.md'), '# shared');
  writeFileSync(join(shared, 'b.txt'), 'bb');
  symlinkSync(outside, join(shared, 'out'));
  const listed = await call<FileListing>('GET', '/api/shared/files');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.entries.map((e) => e.name).sort(), ['b.txt', 'notes']);
  const raw = await fetch(`${s.base}/api/shared/files/raw?path=b.txt`, { headers: { authorization: `Bearer ${s.token}` } });
  assert.equal(await raw.text(), 'bb');
  assert.match(raw.headers.get('content-disposition') ?? '', /^attachment/);

  const delShared = (paths: unknown) => call<TrashResult>('POST', '/api/shared/files/delete', { paths });
  for (const p of ['', '.', shared, '../workspaces', '../trash', '..', join(outside, 'keep.txt'), 'out/keep.txt']) {
    const r = await delShared([p]);
    assert.ok(r.status === 403 || r.status === 400, `${JSON.stringify(p)}: ${r.status}`);
  }
  const r = await delShared(['notes', 'b.txt', 'out']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const t of r.data.trashed) {
    assert.equal(t.origin, 'shared');
    assert.equal(t.botId, '');
  }
  assert.deepEqual(readdirSync(shared), []);
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
  const items = (await call<TrashItem[]>('GET', '/api/shared/trash')).data;
  assert.deepEqual(items.map((i) => i.path).sort(), ['b.txt', 'notes', 'out']);
  const ev = (await auditOf('files.trashed')).find((e) => e.target?.kind === 'shared');
  assert.equal(ev?.details.items, 3);

  // Not any Boton's: no Boton's trash or sizes count them.
  const bot = await newBot('Norbert');
  assert.deepEqual(await trashOf(bot), []);
  const mine = (await call<{ trashItems: number; sharedTrashItems: number }>('GET', `/api/bots/${bot.id}/storage`)).data;
  assert.equal(mine.trashItems, 0);
  assert.equal(mine.sharedTrashItems, 3);
  assert.equal((await call<StorageUsage>('GET', '/api/storage')).data.sharedTrashItems, 3);

  // Restore: back in the shared folder, beside a file that took its name meanwhile.
  writeFileSync(join(shared, 'b.txt'), 'new');
  const b = items.find((i) => i.path === 'b.txt')!;
  assert.deepEqual((await call<RestoreResult>('POST', `/api/trash/${b.id}/restore`)).data, { origin: 'shared', path: 'b-2.txt', renamed: true, folderGone: false });
  assert.equal(readFileSync(join(shared, 'b-2.txt'), 'utf8'), 'bb');
  const notes = items.find((i) => i.path === 'notes')!;
  assert.deepEqual((await call<RestoreResult>('POST', `/api/trash/${notes.id}/restore`)).data, { origin: 'shared', path: 'notes', renamed: false, folderGone: false });
  assert.equal(readFileSync(join(shared, 'notes/a.md'), 'utf8'), '# shared');
  assert.equal((await auditOf('files.restored')).find((e) => e.target?.kind === 'shared')?.details.path !== undefined, true);

  assert.deepEqual((await call('POST', '/api/shared/trash/empty')).data, { purged: 1 });
  assert.deepEqual((await call<TrashItem[]>('GET', '/api/shared/trash')).data, []);
  rmSync(join(shared, 'b.txt'));
  rmSync(join(shared, 'b-2.txt'));
  rmSync(join(shared, 'notes'), { recursive: true });
});

test('where folders can’t be held open, nothing moves to or from the trash, however a Boton races it', async () => {
  const bot = await newBot('Jerry');
  put(bot, 'out/keep.txt', 'k');
  put(bot, 'inbox/old.txt', 'o', 400);
  const [item] = (await del(bot, ['out/keep.txt'])).data.trashed;
  const elsewhere = tempDir('botons-trash-nohandles-');
  let raced = 0;
  // A Boton swapping the folder for a link out at every point a move could be made: none is reached.
  hooks.beforeOpen = hooks.beforeRename = hooks.beforeMkdir = hooks.beforeClaim = () => {
    raced++;
    swapForLink(join(bot.workspace, 'out'), elsewhere);
  };
  hooks.noHandles = true;
  try {
    put(bot, 'out/other.txt', 'other');
    const d = await del(bot, ['out/other.txt']);
    assert.equal(d.status, 501, JSON.stringify(d.data));
    assert.match((d.data as unknown as { error: string }).error, /folders it holds open/);
    const r = await call('POST', `/api/trash/${item.id}/restore`);
    assert.equal(r.status, 501);
    assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/clear`)).status, 501);
    clock += DAY + 1;
    assert.equal((await app.trash.housekeep({ force: true }))?.cleaned, 0);
    assert.equal(raced, 0);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal(readFileSync(join(bot.workspace, 'out/other.txt'), 'utf8'), 'other');
    assert.ok(existsSync(join(bot.workspace, 'inbox/old.txt')));
    assert.ok(existsSync(join(s.home, 'trash', item.id, 'item')), 'still in the trash');
  } finally {
    hooks.noHandles = undefined;
    hooks.beforeOpen = hooks.beforeRename = hooks.beforeMkdir = hooks.beforeClaim = undefined;
  }
  assert.equal((await call('POST', `/api/trash/${item.id}/restore`)).status, 200);
});

test('a restore never replaces what a Boton puts at its name meanwhile: a file passes over it; without hard links it stays in the trash', async () => {
  const bot = await newBot('Tim');
  put(bot, 'd/report.txt', 'restored');
  const [a] = (await del(bot, ['d/report.txt'])).data.trashed;
  hooks.beforeClaim = (target) => {
    hooks.beforeClaim = undefined;
    writeFileSync(target, 'NEW VALUABLE CONTENT');
  };
  assert.deepEqual((await call('POST', `/api/trash/${a.id}/restore`)).data, { origin: 'workspace', path: 'd/report-2.txt', renamed: true, folderGone: false });
  assert.equal(readFileSync(join(bot.workspace, 'd/report.txt'), 'utf8'), 'NEW VALUABLE CONTENT');
  assert.equal(readFileSync(join(bot.workspace, 'd/report-2.txt'), 'utf8'), 'restored');

  // A disk without hard links: the name taken just then, and the restore refused with the item kept.
  put(bot, 'd/notes.txt', 'restored');
  const [b] = (await del(bot, ['d/notes.txt'])).data.trashed;
  hooks.link = async (_from, to) => {
    writeFileSync(to, 'NEW VALUABLE CONTENT');
    throw Object.assign(new Error('not supported'), { code: 'EOPNOTSUPP' });
  };
  try {
    const r = await call('POST', `/api/trash/${b.id}/restore`);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match((r.data as unknown as { error: string }).error, /left in the trash/);
  } finally {
    hooks.link = undefined;
  }
  assert.equal(readFileSync(join(bot.workspace, 'd/notes.txt'), 'utf8'), 'NEW VALUABLE CONTENT');
  assert.ok((await trashOf(bot)).some((i) => i.id === b.id));
  assert.equal(readFileSync(join(s.home, 'trash', b.id, 'item'), 'utf8'), 'restored');
});

test('a folder’s restore claims its name with an empty folder: what a Boton puts in or over the claim is never replaced', async () => {
  const bot = await newBot('Mel');
  for (const [i, race] of [
    ['in', (target: string) => writeFileSync(join(target, 'mine.txt'), 'NEW VALUABLE CONTENT')],
    ['over', (target: string) => (rmSync(target, { recursive: true }), writeFileSync(target, 'NEW VALUABLE CONTENT'))],
  ] as const) {
    put(bot, `box-${i}/a.txt`, 'restored');
    const [item] = (await del(bot, [`box-${i}`])).data.trashed;
    let target = '';
    hooks.beforeMoveIn = (t) => {
      hooks.beforeMoveIn = undefined;
      target = t;
      race(t);
    };
    const r = await call<RestoreResult>('POST', `/api/trash/${item.id}/restore`);
    assert.ok(target, 'the claim was raced');
    assert.deepEqual(r.data, { origin: 'workspace', path: `box-${i}-2`, renamed: true, folderGone: false });
    assert.equal(readFileSync(join(bot.workspace, `box-${i}-2/a.txt`), 'utf8'), 'restored');
    const theirs = i === 'in' ? join(bot.workspace, 'box-in/mine.txt') : join(bot.workspace, 'box-over');
    assert.equal(readFileSync(theirs, 'utf8'), 'NEW VALUABLE CONTENT');
  }
  // A name taken before the claim is passed over the same way.
  put(bot, 'box/a.txt', 'restored');
  const [c] = (await del(bot, ['box'])).data.trashed;
  hooks.beforeClaim = (target, isDir) => {
    hooks.beforeClaim = undefined;
    assert.equal(isDir, true);
    mkdirSync(target);
    writeFileSync(join(target, 'mine.txt'), 'NEW VALUABLE CONTENT');
  };
  assert.deepEqual((await call('POST', `/api/trash/${c.id}/restore`)).data, { origin: 'workspace', path: 'box-2', renamed: true, folderGone: false });
  assert.equal(readFileSync(join(bot.workspace, 'box/mine.txt'), 'utf8'), 'NEW VALUABLE CONTENT');
  assert.deepEqual(readdirSync(join(bot.workspace, 'box')), ['mine.txt']);
});

test('every kept inbox file stays kept: one past the limit is refused, Clear inbox and the daily cleanup skip them all', async () => {
  const bot = await newBot('Norbert');
  const names = Array.from({ length: 1000 }, (_, i) => `k${i}.txt`);
  for (const n of names) put(bot, `inbox/${n}`, n, 40);
  for (const n of names) app.store.setInboxPin(bot.id, n, true);
  put(bot, 'inbox/extra.txt', 'e', 40);
  const refused = await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/extra.txt', pinned: true });
  assert.equal(refused.status, 409);
  assert.match((refused.data as unknown as { error: string }).error, /At most 1000/);
  assert.equal(app.store.inboxPins(bot.id).length, 1000);
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/k0.txt', pinned: true })).status, 200, 'keeping a kept one again is fine');

  const cleared = (await call<TrashResult>('POST', `/api/bots/${bot.id}/inbox/clear`)).data;
  assert.deepEqual(cleared.trashed.map((i) => i.path), ['inbox/extra.txt']);
  assert.equal(cleared.kept, 1000);
  put(bot, 'inbox/extra.txt', 'e', 40);
  clock += DAY + 1;
  await app.trash.housekeep({ force: true });
  assert.equal(existsSync(join(bot.workspace, 'inbox/extra.txt')), false);
  assert.deepEqual(readdirSync(join(bot.workspace, 'inbox')).sort(), [...names].sort());

  // A kept file a Boton deleted makes room: its pin goes, every other stays.
  rmSync(join(bot.workspace, 'inbox/k7.txt'));
  put(bot, 'inbox/extra.txt', 'e', 40);
  assert.equal((await call('POST', `/api/bots/${bot.id}/inbox/pins`, { path: 'inbox/extra.txt', pinned: true })).status, 200);
  const pins = new Set(app.store.inboxPins(bot.id));
  assert.equal(pins.size, 1000);
  assert.ok(pins.has('k0.txt') && pins.has('extra.txt') && !pins.has('k7.txt'));
  assert.equal((await call<TrashResult>('POST', `/api/bots/${bot.id}/inbox/clear`)).data.trashed.length, 0);
});

test('the daily cleanup never deletes an item whose meta.json is unreadable; only an empty unfinished one, and records only what it deletes', async () => {
  const bot = await newBot('Herb');
  const trash = join(s.home, 'trash');
  put(bot, 'truncated.txt', 'payload');
  put(bot, 'unreadable.txt', 'payload');
  const [t, u] = (await del(bot, ['truncated.txt', 'unreadable.txt'])).data.trashed;
  writeFileSync(join(trash, t.id, 'meta.json'), '{"id":');
  chmodSync(join(trash, u.id, 'meta.json'), 0o000);
  // Unfinished: a meta.json alone, an empty folder, and one with something unknown in it.
  const staged = ['aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaa3'];
  for (const id of staged) mkdirSync(join(trash, id));
  writeFileSync(join(trash, staged[0], 'meta.json'), JSON.stringify({ ...t, id: staged[0] }));
  writeFileSync(join(trash, staged[2], 'stray'), 'x');
  const old = new Date(clock - 2 * 3_600_000);
  for (const id of [t.id, u.id, ...staged]) utimesSync(join(trash, id), old, old);
  try {
    clock += 31 * DAY;
    await app.trash.housekeep({ force: true });
    assert.equal(readFileSync(join(trash, t.id, 'item'), 'utf8'), 'payload');
    assert.equal(readFileSync(join(trash, u.id, 'item'), 'utf8'), 'payload');
    assert.equal(existsSync(join(trash, staged[0])), false);
    assert.equal(existsSync(join(trash, staged[1])), false);
    assert.equal(readFileSync(join(trash, staged[2], 'stray'), 'utf8'), 'x');
    assert.equal((await auditOf('files.purged')).filter((e) => e.target?.id === bot.id).length, 0);
  } finally {
    chmodSync(join(trash, u.id, 'meta.json'), 0o600);
  }
  // Readable again, it is an item as before: expired, deleted for good and recorded.
  await app.trash.housekeep({ force: true });
  assert.equal(existsSync(join(trash, u.id)), false);
  assert.deepEqual((await auditOf('files.purged')).find((e) => e.target?.id === bot.id)?.details.paths, ['unreadable.txt']);
  assert.ok(existsSync(join(trash, t.id, 'item')), 'still kept: its meta.json is still not readable');
  rmSync(join(trash, t.id), { recursive: true });
  rmSync(join(trash, staged[2]), { recursive: true });
});

test('a file a Boton swaps in just before the move stays in the trash as what it is; nothing is renamed back over its name', async () => {
  const bot = await newBot('Phil');
  put(bot, 'f.txt', 'checked');
  hooks.beforeRename = () => {
    hooks.beforeRename = undefined;
    renameSync(join(bot.workspace, 'f.txt'), join(bot.workspace, 'f-old.txt'));
    writeFileSync(join(bot.workspace, 'f.txt'), 'NEW VALUABLE CONTENT!');
  };
  const r = await del(bot, ['f.txt']);
  assert.equal(r.status, 409);
  assert.equal(readFileSync(join(bot.workspace, 'f-old.txt'), 'utf8'), 'checked');
  assert.equal(existsSync(join(bot.workspace, 'f.txt')), false, 'never renamed back');
  const [kept] = (await trashOf(bot)).filter((i) => i.path === 'f.txt');
  assert.equal(kept.size, 'NEW VALUABLE CONTENT!'.length);
  // A Boton writes the name again: the restore passes over it.
  writeFileSync(join(bot.workspace, 'f.txt'), 'newer');
  assert.equal((await call<RestoreResult>('POST', `/api/trash/${kept.id}/restore`)).data.path, 'f-2.txt');
  assert.equal(readFileSync(join(bot.workspace, 'f.txt'), 'utf8'), 'newer');
  assert.equal(readFileSync(join(bot.workspace, 'f-2.txt'), 'utf8'), 'NEW VALUABLE CONTENT!');
});

test('the daily cleanup keeps, and logs, an item whose deletion time is missing, not an exact time, or in the future', async () => {
  const bot = await newBot('Jerry');
  const trash = join(s.home, 'trash');
  const values: Record<string, unknown> = { missing: undefined, invalid: 'yesterday', inexact: '2020-01-01', number: 0, future: new Date(clock + 365 * DAY).toISOString() };
  const ids: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    put(bot, `${name}.txt`, 'payload');
    const [item] = (await del(bot, [`${name}.txt`])).data.trashed;
    const meta = JSON.parse(readFileSync(join(trash, item.id, 'meta.json'), 'utf8'));
    writeFileSync(join(trash, item.id, 'meta.json'), JSON.stringify({ ...meta, deletedAt: value }));
    ids[name] = item.id;
  }
  clock += 31 * DAY;
  await app.trash.housekeep({ force: true });
  for (const id of Object.values(ids)) assert.equal(readFileSync(join(trash, id, 'item'), 'utf8'), 'payload');
  assert.equal((await auditOf('files.purged')).filter((e) => e.target?.id === bot.id).length, 0);
  // The one with a future time is still listed and can be restored; the others wait for a readable meta.json.
  assert.deepEqual((await trashOf(bot)).map((i) => i.id), [ids.future]);
  for (const name of ['missing', 'invalid', 'inexact', 'number']) rmSync(join(trash, ids[name]), { recursive: true });
});

test('a restore reports where it really landed when a Boton moves the folder held open, and makes nothing out of the workspace', async () => {
  const bot = await newBot('Tim');
  const elsewhere = tempDir('botons-trash-landed-');
  for (const [kind, rel] of [['file', 'p/x.txt'], ['folder', 'q/box']] as const) {
    put(bot, kind === 'file' ? rel : `${rel}/a.txt`, 'restored');
    const [item] = (await del(bot, [rel])).data.trashed;
    const parent = join(bot.workspace, rel.split('/')[0]);
    const race = () => swapForLink(parent, elsewhere);
    if (kind === 'file') {
      hooks.beforeClaim = () => {
        hooks.beforeClaim = undefined;
        race();
      };
    } else {
      hooks.beforeMoveIn = () => {
        hooks.beforeMoveIn = undefined;
        race();
      };
    }
    const r = await call<RestoreResult>('POST', `/api/trash/${item.id}/restore`);
    const moved = `${rel.split('/')[0]}-moved/${rel.split('/')[1]}`;
    assert.deepEqual(r.data, { origin: 'workspace', path: moved, renamed: true, folderGone: false });
    assert.ok(existsSync(join(bot.workspace, moved)));
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal((await auditOf('files.restored')).find((e) => e.details.from === rel)?.details.path, moved);
  }
});
