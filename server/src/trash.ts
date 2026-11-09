import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { INBOX_PINS_MAX, TRASH_KEEP_DAYS } from '../../shared/files.ts';
import type { Bot, BotStorage, RestoreResult, StorageUsage, TrashItem, TrashOrigin, TrashReason, TrashResult } from '../../shared/types.ts';
import { type Audit, type AuditActor, SYSTEM_ACTOR } from './audit.ts';
import { folderBytes } from './disk-usage.ts';
import { log } from './log.ts';
import { HttpError, type Store } from './store.ts';
import { inside } from './util.ts';

/*
 * The server's trash, BOTONS_HOME/trash: what the owner deletes in Files (a Boton's workspace or the shared folder), and
 * what the inbox cleanup and Clear inbox move there. Each item is a folder of its own, `<id>/meta.json` (where it
 * was, whose, when) and `<id>/item` (the file or folder itself, renamed there, never copied), kept TRASH_KEEP_DAYS
 * and then deleted for good.
 *
 * A Boton can write its workspace and the shared folder, and so race the server: it could swap a folder on the way
 * for a link out at any moment. So every change is made through a folder held open (`Dir`): the folder is opened,
 * where it really is is read from the open handle and must be inside, and names in it are reached through the handle
 * (/proc/self/fd/<n>/<name>), so a later swap of any folder on the way changes nothing. The entry itself is never
 * followed (a symlink goes to the trash as the link), and what was moved must be the very file that was checked; if a
 * Boton swapped it meanwhile, what was moved stays in the trash (described as it is) and the delete is refused: putting
 * it back could replace what the Boton put at its name. A restore makes a missing folder only inside a folder held open
 * and checked, and opens and checks each one before going on. Where folders can't be reached by handle (no
 * /proc/self/fd) nothing is moved to or from the trash at all: a path checked and then used is a race a Boton can win.
 *
 * A restore never replaces anything, however a Boton races it. A file is put back by a hard link, which fails if the
 * name is taken; where a link can't be made it stays in the trash. A folder first claims its name with an empty folder
 * of its own (mkdir fails if the name is taken), then is renamed onto it: a rename replaces only an empty folder and
 * fails on anything else, so the most a Boton that swaps the claim can lose is an empty folder.
 *
 * Only a rename moves anything: across two disks (a workspace or shared folder mounted apart from BOTONS_HOME) the
 * delete is refused and nothing changes, since a copy and a remove can't be made both safe and all-or-nothing.
 *
 * An item whose meta.json can't be read or isn't valid (its deletion time not an exact time), or whose deletion time is
 * in the future, is never deleted by the daily cleanup, and is logged: only a folder with nothing in it but (at most)
 * its meta.json, left by a server that stopped mid-move, is.
 */

const META = 'meta.json';
const ITEM = 'item';
const ID = /^[0-9a-f]{16}$/;
const DAY_MS = 86_400_000;
const INBOX = 'inbox';
/** Each item deleted at once: one request, one audit event, one confirmation. */
const DELETE_MAX = 500;
const LAST_CLEANUP = 'storage.lastCleanupAt';
const SHARED_TARGET = { kind: 'shared', id: 'shared', label: 'Shared folder' };
export const CROSS_DISK = "It is on another disk than the server's trash (trash/ in BOTONS_HOME), so it can't be moved there; nothing was changed. Delete it with a Boton's own tools, or keep the folder on the same disk as BOTONS_HOME.";
export const NO_HANDLES = "Trash and Restore need Linux, where Botons can safely move files through folders it holds open. Nothing was changed; manage the file with a Boton's own tools.";
export const NO_LINK = "This file can't be put back without risking a file that took its name meanwhile (the disk doesn't take hard links), so it was left in the trash. Download it from there, or delete it forever.";
const TAKEN = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR']);
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

let handles: boolean | undefined;
/** Whether a folder held open can be reached by its handle here: /proc/self/fd/<n> must be that very folder. */
function canHold(): boolean {
  if (handles !== undefined) return handles;
  let fd: number | undefined;
  try {
    fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
    const a = fstatSync(fd);
    const b = lstatSync(`/proc/self/fd/${fd}/.`);
    handles = a.dev === b.dev && a.ino === b.ino;
  } catch {
    handles = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return handles;
}

interface Meta {
  id: string;
  origin?: TrashOrigin;
  botId: string;
  botName: string;
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  deletedAt: string;
  reason: TrashReason;
}

/** Where a delete or restore happens: a Boton's workspace, or the shared folder. */
type Space = { origin: 'workspace'; bot: Bot; dir: string } | { origin: 'shared'; dir: string };

/** An entry checked for moving: `name` in the folder `folder`, resolved inside `root`; the entry itself not followed. */
interface Entry {
  space: Space;
  root: string;
  folder: string;
  name: string;
  rel: string;
  stat: Stats;
}

/** Test hooks: a Boton's moves interleaved at the points a race would hit. */
export interface TrashHooks {
  beforeOpen?: (folder: string) => void | Promise<void>;
  beforeRename?: (from: string) => void | Promise<void>;
  beforeMkdir?: (parent: string, name: string) => void | Promise<void>;
  /** Just before a restore claims `target` (a link for a file, an empty folder for a folder). */
  beforeClaim?: (target: string, isDir: boolean) => void | Promise<void>;
  /** A folder's restore: after its name is claimed, just before it is renamed onto the claim. */
  beforeMoveIn?: (target: string) => void | Promise<void>;
  /** In place of the hard link a file is restored by. */
  link?: (from: string, to: string) => Promise<void>;
  /** As if folders can't be reached by handle here. */
  noHandles?: boolean;
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code;
const exists = (p: string) => lstat(p).then(
  () => true,
  () => false,
);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const toRel = (root: string, abs: string) => relative(root, abs).split(sep).join('/');
const crossDisk = (err: unknown) => (errCode(err) === 'EXDEV' ? new HttpError(409, CROSS_DISK) : err);

/** A folder held open (only where handles can be, `canHold()`). `real` is where it was when opened; `where()` is where it is now. */
class Dir {
  readonly fh: FileHandle;
  readonly real: string;
  constructor(fh: FileHandle, real: string) {
    this.fh = fh;
    this.real = real;
  }
  /** A name in this very folder, wherever it has moved meanwhile. */
  at(name: string): string {
    return `/proc/self/fd/${this.fh.fd}/${name}`;
  }
  where(): Promise<string | null> {
    return readlink(`/proc/self/fd/${this.fh.fd}`).catch(() => null);
  }
  close(): Promise<void> {
    return this.fh.close().catch(() => {});
  }
}

/** Opens a folder (following links on the way) and reads where it really is; null if it isn't a folder. */
async function openDir(path: string): Promise<Dir | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const dir = new Dir(fh, '');
  const real = await dir.where();
  if (!real) {
    await dir.close();
    return null;
  }
  return new Dir(fh, real);
}

/** Opens `path` and checks it is inside `root` (or is it); null, and closed, if not. */
async function openInside(root: string, path: string): Promise<Dir | null> {
  const dir = await openDir(path);
  if (dir && (dir.real === root || inside(root, dir.real))) return dir;
  await dir?.close();
  return null;
}

export interface TrashOptions {
  home: string;
  store: Store;
  audit: Audit;
  /** The shared folder: the owner deletes from it too. */
  sharedDir: string;
  /** Folders no delete may take, nor any folder holding one: the shared folder, the workspaces folder, BOTONS_HOME. */
  protectedDirs: string[];
  now?: () => number;
  hooks?: TrashHooks;
}

export class Trash {
  readonly dir: string;
  #store: Store;
  #audit: Audit;
  #shared: string;
  #protected: string[];
  #now: () => number;
  #hooks: TrashHooks;
  /** One change at a time, so two restores (or a restore and a purge) of one item never race. */
  #chain: Promise<unknown> = Promise.resolve();
  #housekeeping = false;

  constructor(opts: TrashOptions) {
    this.dir = join(opts.home, 'trash');
    this.#store = opts.store;
    this.#audit = opts.audit;
    this.#shared = opts.sharedDir;
    this.#protected = opts.protectedDirs.map((d) => resolve(d));
    this.#now = opts.now ?? Date.now;
    this.#hooks = opts.hooks ?? {};
  }

  /** Moving anything needs folders held open; refused, before anything is touched, where they can't be. */
  #mustHold(): void {
    if (!this.#canHold()) throw new HttpError(501, NO_HANDLES);
  }

  #canHold(): boolean {
    return !this.#hooks.noHandles && canHold();
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #trashRoot(): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return realpath(this.dir);
  }

  #space(origin: TrashOrigin, botId?: string): Space {
    if (origin === 'shared') return { origin, dir: this.#shared };
    const bot = this.#store.getBot(botId ?? '');
    return { origin, bot, dir: bot.workspace };
  }

  // ------------------------------------------------------------------ paths

  /**
   * The entry a client's path names, for moving: its folder resolved (symlinks and all) and inside, the entry itself
   * not followed. Never the space's own folder, a workspace's inbox folder, or anything holding a protected folder.
   */
  async #entry(space: Space, input: unknown): Promise<Entry> {
    const label = space.origin === 'shared' ? 'the shared folder' : 'the workspace';
    if (typeof input !== 'string' || !input) throw new HttpError(400, `Each path must be a path in ${label}`);
    if (input.includes('\0')) throw new HttpError(400, 'path is not valid');
    await mkdir(space.dir, { recursive: true });
    const root = await realpath(space.dir);
    const ws = resolve(space.dir);
    const requested = isAbsolute(input) ? resolve(input) : resolve(root, input);
    const base = inside(root, requested) ? root : inside(ws, requested) ? ws : null;
    if (base === null) throw new HttpError(403, `That path is outside ${label}`);
    if (requested === base) throw new HttpError(403, space.origin === 'shared' ? "The shared folder itself can't be deleted" : "The workspace itself can't be deleted");
    let folder: string;
    try {
      folder = await realpath(dirname(requested));
    } catch {
      throw new HttpError(404, `No such file or folder in ${label}: ${input}`);
    }
    if (folder !== root && !inside(root, folder)) throw new HttpError(403, `That path is outside ${label}`);
    const name = requested.slice(requested.lastIndexOf(sep) + 1);
    const abs = join(folder, name);
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch {
      throw new HttpError(404, `No such file or folder in ${label}: ${input}`);
    }
    const rel = toRel(root, abs);
    if (!rel || rel === '.' || rel.startsWith('../')) throw new HttpError(403, `That path is outside ${label}`);
    if (space.origin === 'workspace' && rel === INBOX) throw new HttpError(403, "The inbox folder itself can't be deleted; use Clear inbox to empty it");
    if (st.isDirectory()) {
      for (const p of [...this.#protected, this.dir]) {
        if (inside(abs, p) || inside(abs, await realpath(p).catch(() => p))) throw new HttpError(403, `${rel} holds a folder Botons keeps, so it can't be deleted`);
      }
    }
    return { space, root, folder, name, rel, stat: st };
  }

  // ------------------------------------------------------------------ moving

  async #trashOne(entry: Entry, reason: TrashReason): Promise<TrashItem> {
    const trash = await this.#trashRoot();
    await this.#hooks.beforeOpen?.(entry.folder);
    // The folder it is in, held open: a Boton could have swapped it for a link since it was checked.
    const dir = await openInside(entry.root, entry.folder);
    if (!dir) throw new HttpError(409, 'That folder moved while it was being deleted; try again');
    const id = randomBytes(8).toString('hex');
    const home = join(trash, id);
    try {
      const from = dir.at(entry.name);
      const now = await lstat(from).catch(() => null);
      if (!now || !sameFile(now, entry.stat)) throw new HttpError(409, 'That file changed while it was being deleted; try again');
      const size = now.isDirectory() ? (await folderBytes(from)).bytes : now.size;
      const bot = entry.space.origin === 'workspace' ? entry.space.bot : null;
      const meta: Meta = {
        id,
        origin: entry.space.origin,
        botId: bot?.id ?? '',
        botName: bot?.name ?? '',
        path: toRel(entry.root, join(dir.real, entry.name)),
        name: entry.name,
        isDir: now.isDirectory(),
        size,
        deletedAt: new Date(this.#now()).toISOString(),
        reason,
      };
      await mkdir(home, { mode: 0o700 });
      try {
        await writeFile(join(home, META), JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
        await this.#hooks.beforeRename?.(from);
        const where = await dir.where();
        if (!where || !inside(entry.root, where)) throw new HttpError(409, 'That folder moved while it was being deleted; try again');
        await rename(from, join(home, ITEM)).catch((err) => {
          throw crossDisk(err);
        });
        const arrived = await lstat(join(home, ITEM));
        if (!sameFile(arrived, entry.stat)) {
          // Never renamed back (that could replace what a Boton put at the name since): kept in the trash as what it is.
          const kept: Meta = { ...meta, isDir: arrived.isDirectory(), size: arrived.isDirectory() ? (await folderBytes(join(home, ITEM))).bytes : arrived.size };
          await writeFile(join(home, META), JSON.stringify(kept), { mode: 0o600 });
          log.warn('a file changed while it was moved to the trash; what was moved is kept in the trash', { id, path: meta.path });
          throw new HttpError(409, 'That file changed while it was being deleted; what was moved is in the trash. Check the folder and try again');
        }
      } catch (err) {
        if (!(await exists(join(home, ITEM)))) await rm(home, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      if (bot && meta.path.startsWith(`${INBOX}/`) && !meta.path.slice(INBOX.length + 1).includes('/')) this.#store.setInboxPin(bot.id, meta.name, false);
      return this.#item(meta);
    } finally {
      await dir.close();
    }
  }

  #item(m: Meta): TrashItem {
    const origin = m.origin ?? 'workspace';
    return {
      ...m,
      origin,
      purgeAt: new Date(Date.parse(m.deletedAt) + TRASH_KEEP_DAYS * DAY_MS).toISOString(),
      botGone: origin === 'workspace' && !this.#store.hasBot(m.botId),
    };
  }

  // ------------------------------------------------------------------ the owner's actions

  /** A Boton's workspace files: every path is checked before anything moves; then each goes to the trash. */
  delete(botId: string, paths: unknown, actor: AuditActor): Promise<TrashResult> {
    return this.#serial(() => this.#delete(this.#space('workspace', botId), paths, actor));
  }

  /** The shared folder's files, the same way. */
  deleteShared(paths: unknown, actor: AuditActor): Promise<TrashResult> {
    return this.#serial(() => this.#delete(this.#space('shared'), paths, actor));
  }

  async #delete(space: Space, paths: unknown, actor: AuditActor): Promise<TrashResult> {
    this.#mustHold();
    if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'paths must be a list of paths');
    if (paths.length > DELETE_MAX) throw new HttpError(400, `At most ${DELETE_MAX} at once`);
    const entries: Entry[] = [];
    const absOf = (e: Entry) => join(e.folder, e.name);
    for (const p of paths) {
      const e = await this.#entry(space, p);
      // A folder and something in it, or one path twice: the folder (or the first) is enough.
      if (entries.some((x) => inside(absOf(x), absOf(e)))) continue;
      for (let i = entries.length - 1; i >= 0; i--) if (inside(absOf(e), absOf(entries[i]))) entries.splice(i, 1);
      entries.push(e);
    }
    const trashed: TrashItem[] = [];
    try {
      for (const e of entries) trashed.push(await this.#trashOne(e, 'deleted'));
    } finally {
      if (trashed.length) this.#record(actor, 'files.trashed', space, trashed);
    }
    return { trashed };
  }

  /** Everything directly in the inbox but kept (pinned) items and hidden ones (an upload in progress). */
  clearInbox(botId: string, actor: AuditActor): Promise<TrashResult> {
    return this.#serial(async () => {
      const bot = this.#store.getBot(botId);
      this.#mustHold();
      const { trashed, kept } = await this.#sweepInbox(bot, 'inbox_cleared', () => true);
      this.#audit.record(actor, { action: 'inbox.cleared', target: { kind: 'boton', id: bot.id, label: bot.name }, details: { items: trashed.length, bytes: sum(trashed), kept } });
      return { trashed, kept };
    });
  }

  async #sweepInbox(bot: Bot, reason: TrashReason, take: (st: Stats) => boolean): Promise<{ trashed: TrashItem[]; kept: number }> {
    const root = await realpath(bot.workspace).catch(() => null);
    if (!root) return { trashed: [], kept: 0 };
    const inbox = join(root, INBOX);
    const st = await lstat(inbox).catch(() => null);
    // Only a real folder: an inbox a Boton made a link is not swept at all.
    if (!st?.isDirectory()) return { trashed: [], kept: 0 };
    const pins = new Set(this.#store.inboxPins(bot.id));
    const space = this.#space('workspace', bot.id);
    const trashed: TrashItem[] = [];
    let kept = 0;
    for (const name of await readdir(inbox).catch(() => [] as string[])) {
      if (name.startsWith('.')) continue;
      if (pins.has(name)) {
        kept++;
        continue;
      }
      try {
        const e = await this.#entry(space, `${INBOX}/${name}`);
        if (!take(e.stat)) continue;
        trashed.push(await this.#trashOne(e, reason));
      } catch (err) {
        log.warn('could not move an inbox file to the trash', { botId: bot.id, name, err: (err as Error).message });
      }
    }
    return { trashed, kept };
  }

  /** A Boton's items (from its workspace), the shared folder's, or every item. */
  list(filter: { botId?: string; origin?: TrashOrigin } = {}): Promise<TrashItem[]> {
    return this.#readAll().then((all) =>
      all
        .map((m) => this.#item(m))
        .filter((i) => (!filter.origin || i.origin === filter.origin) && (!filter.botId || (i.origin === 'workspace' && i.botId === filter.botId)))
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)),
    );
  }

  async #readAll(): Promise<Meta[]> {
    let ids: string[];
    try {
      ids = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: Meta[] = [];
    for (const id of ids) {
      const m = await this.#meta(id);
      if (m) out.push(m);
    }
    return out;
  }

  async #meta(id: string): Promise<Meta | null> {
    if (!ID.test(id)) return null;
    try {
      const m = JSON.parse(await readFile(join(this.dir, id, META), 'utf8')) as Meta;
      if (m.id !== id || typeof m.path !== 'string' || typeof m.botId !== 'string') return null;
      if (m.origin !== undefined && m.origin !== 'workspace' && m.origin !== 'shared') return null;
      if (typeof m.name !== 'string' || typeof m.size !== 'number' || deletedTime(m.deletedAt) === null) return null;
      if (!(await exists(join(this.dir, id, ITEM)))) return null;
      return m;
    } catch {
      return null;
    }
  }

  async #mustMeta(id: string): Promise<Meta> {
    const m = await this.#meta(id);
    if (!m) throw new HttpError(404, 'Nothing in the trash with that id');
    return m;
  }

  /** Back where it was, or beside it with -2, -3… if that name is taken now; its folders made again if they are gone. */
  restore(id: string, actor: AuditActor): Promise<RestoreResult> {
    return this.#serial(async () => {
      const m = await this.#mustMeta(id);
      const origin = m.origin ?? 'workspace';
      if (origin === 'workspace' && !this.#store.hasBot(m.botId)) throw new HttpError(409, `${m.botName} was deleted, so this can only be deleted forever`);
      const space = this.#space(origin, m.botId);
      this.#mustHold();
      const item = join(this.dir, id, ITEM);
      const st = await lstat(item);
      await mkdir(space.dir, { recursive: true });
      const root = await realpath(space.dir);
      const top = await openInside(root, root);
      if (!top) throw new HttpError(409, 'That folder moved while the file was being restored; try again');
      let into = top;
      try {
        const reached = await this.#restoreFolder(root, top, m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '');
        into = reached.dir;
        const path = await this.#place(item, into, m.name, st, root);
        await rm(join(this.dir, id), { recursive: true, force: true });
        const target = space.origin === 'workspace' ? { kind: 'boton', id: space.bot.id, label: space.bot.name } : SHARED_TARGET;
        const out: RestoreResult = { origin, path, renamed: path !== m.path, folderGone: !reached.complete };
        this.#audit.record(actor, { action: 'files.restored', target, details: { path, from: m.path, renamed: out.renamed, folderGone: out.folderGone } });
        return out;
      } finally {
        if (into !== top) await into.close();
        await top.close();
      }
    });
  }

  /**
   * The folder to restore into, held open, made again if it is gone. Where it can't be (a file is in the way, or it
   * leads outside), the nearest folder on the way that can, and `complete` false. One folder at a time: each is made
   * only inside the last one, held open and checked, and is itself opened and checked before the next, so nothing is
   * ever made outside however folders are swapped.
   */
  async #restoreFolder(root: string, top: Dir, rel: string): Promise<{ dir: Dir; complete: boolean }> {
    let at = top;
    for (const seg of rel ? rel.split('/') : []) {
      if (!seg || seg === '.' || seg === '..') return { dir: at, complete: false };
      await this.#hooks.beforeMkdir?.(at.real, seg);
      try {
        await mkdir(at.at(seg));
      } catch (err) {
        if (errCode(err) !== 'EEXIST') return { dir: at, complete: false };
      }
      const next = await openInside(root, at.at(seg));
      if (!next) return { dir: at, complete: false };
      if (at !== top) await at.close();
      at = next;
    }
    return { dir: at, complete: true };
  }

  /**
   * Into `into` under `name`, or the first of `name-2.ext`, `-3`… nothing is at, never replacing anything: each name is
   * claimed by an operation that fails if it is taken (a hard link for a file; for a folder an empty folder of its
   * own, which it is then renamed onto), so a name a Boton takes meanwhile is simply passed over. Returns where it is
   * now, relative to `root`, read from the folder held open after it landed (a Boton may have moved that folder).
   */
  async #place(item: string, into: Dir, name: string, st: Stats, root: string): Promise<string> {
    const within = (w: string | null): w is string => !!w && (w === root || inside(root, w));
    if (!within(await into.where())) throw new HttpError(409, 'That folder moved while the file was being restored; try again');
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
      const target = into.at(candidate);
      await this.#hooks.beforeClaim?.(target, st.isDirectory());
      if (!(st.isDirectory() ? await this.#claimFolder(item, target) : await this.#claimFile(item, target))) continue;
      const landed = await lstat(target).catch(() => null);
      if (!landed || !sameFile(landed, st)) {
        log.error('a restored file was not where it was put', { name: candidate });
        throw new HttpError(409, 'That file changed while it was being restored; try again');
      }
      const where = await into.where();
      if (within(where)) return toRel(root, join(where, candidate));
      log.warn('a restored file’s folder was moved out of reach as it landed', { name: candidate });
      throw new HttpError(409, `It was restored as ${candidate}, but a Boton moved its folder meanwhile, so where it is now is not known`);
    }
    throw new HttpError(409, 'Too many files with that name there');
  }

  /** A hard link at `target` (false if the name is taken), then the trash's own name for it removed. */
  async #claimFile(item: string, target: string): Promise<boolean> {
    try {
      await (this.#hooks.link ?? link)(item, target);
    } catch (err) {
      const code = errCode(err);
      if (code === 'EEXIST') return false;
      if (code === 'EXDEV') throw new HttpError(409, CROSS_DISK);
      // No atomic way to put it back without risking what may take the name: it stays where it is.
      if (NO_LINKS.has(code ?? '')) throw new HttpError(409, NO_LINK);
      throw err;
    }
    await unlink(item);
    return true;
  }

  /** An empty folder made at `target` (false if the name is taken), then the folder renamed onto it. */
  async #claimFolder(item: string, target: string): Promise<boolean> {
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (err) {
      if (errCode(err) === 'EEXIST') return false;
      throw err;
    }
    try {
      await this.#hooks.beforeMoveIn?.(target);
      // Replaces only the empty folder just made; fails if anything is in it now, or it is no longer a folder.
      await rename(item, target);
      return true;
    } catch (err) {
      // Only an empty folder is removed: a Boton's file or full folder in its place stays.
      await rmdir(target).catch(() => {});
      const code = errCode(err);
      if (TAKEN.has(code ?? '')) return false;
      throw crossDisk(err);
    }
  }

  /** Deleted for good, now. */
  purge(id: string, actor: AuditActor): Promise<void> {
    return this.#serial(async () => {
      const m = await this.#mustMeta(id);
      await rm(join(this.dir, id), { recursive: true });
      this.#audit.record(actor, { action: 'files.purged', target: targetOf(m), details: { items: 1, bytes: m.size, paths: [m.path] } });
    });
  }

  /** Every item of one Boton (from its workspace), or of the shared folder, deleted for good. */
  empty(scope: { botId: string } | { origin: 'shared' }, actor: AuditActor): Promise<{ purged: number }> {
    return this.#serial(async () => {
      const all = (await this.#readAll()).filter((m) => ('botId' in scope ? (m.origin ?? 'workspace') === 'workspace' && m.botId === scope.botId : m.origin === 'shared'));
      const gone: Meta[] = [];
      try {
        for (const m of all) {
          await rm(join(this.dir, m.id), { recursive: true });
          gone.push(m);
        }
      } finally {
        // Only what was deleted is recorded: a failure part way leaves the rest, and says so.
        if (gone.length) this.#audit.record(actor, { action: 'files.purged', target: targetOf(gone[0]), details: { items: gone.length, bytes: gone.reduce((n, m) => n + m.size, 0), paths: gone.map((m) => m.path) } });
      }
      return { purged: gone.length };
    });
  }

  // ------------------------------------------------------------------ daily

  /**
   * Once a day (the scheduler asks every tick; a restart doesn't run it again early): items past TRASH_KEEP_DAYS are
   * deleted for good, and inbox files untouched for the owner's cleanup days go to the trash, kept ones left.
   * Only files directly in an inbox: never a folder, a link, anything else in a workspace, or the shared folder.
   */
  async housekeep(opts: { force?: boolean } = {}): Promise<{ purged: number; cleaned: number } | null> {
    if (this.#housekeeping) return null;
    const now = this.#now();
    const last = Number(this.#store.storageState(LAST_CLEANUP) ?? 0);
    if (!opts.force && now - last < DAY_MS) return null;
    this.#housekeeping = true;
    try {
      this.#store.setStorageState(LAST_CLEANUP, String(now));
      return await this.#serial(async () => {
        const purged = await this.#purgeExpired(now);
        let cleaned = 0;
        const days = this.#store.getSettings().inboxCleanupDays;
        if (days !== null && !this.#canHold()) log.warn('the inbox cleanup was skipped: files are moved to the trash only through folders held open (/proc/self/fd, on Linux)');
        else if (days !== null) {
          const cutoff = now - days * DAY_MS;
          for (const bot of this.#store.listBots()) {
            const { trashed } = await this.#sweepInbox(bot, 'inbox_cleanup', (st) => st.isFile() && st.mtimeMs < cutoff);
            cleaned += trashed.length;
            if (trashed.length) this.#record(SYSTEM_ACTOR, 'inbox.cleaned_up', bot, trashed, { days });
          }
        }
        return { purged, cleaned };
      });
    } catch (err) {
      log.error('the daily storage cleanup failed', { err });
      return null;
    } finally {
      this.#housekeeping = false;
    }
  }

  async #purgeExpired(now: number): Promise<number> {
    let ids: string[];
    try {
      ids = await readdir(this.dir);
    } catch {
      return 0;
    }
    const expired: Meta[] = [];
    for (const id of ids) {
      if (!ID.test(id)) continue;
      const m = await this.#meta(id);
      if (!m) {
        await this.#cleanStaging(id, now);
        continue;
      }
      // #meta takes only an exact time; one after now (a clock set back, or a meta.json written by hand) is kept.
      const at = deletedTime(m.deletedAt) ?? now;
      if (at > now) log.warn('a trash item whose deletion time is in the future was kept as it is', { id });
      if (at + TRASH_KEEP_DAYS * DAY_MS > now) continue;
      try {
        await rm(join(this.dir, id), { recursive: true });
        expired.push(m);
      } catch (err) {
        log.warn('could not delete a trash item', { id, err: (err as Error).message });
      }
    }
    const groups = new Map<string, Meta[]>();
    for (const m of expired) {
      const key = m.origin === 'shared' ? 'shared' : `boton:${m.botId}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    for (const ms of groups.values()) {
      this.#audit.record(SYSTEM_ACTOR, { action: 'files.purged', target: targetOf(ms[0]), details: { items: ms.length, bytes: ms.reduce((n, m) => n + m.size, 0), paths: ms.map((m) => m.path), afterDays: TRASH_KEEP_DAYS } });
    }
    return expired.length;
  }

  /**
   * A trash folder without readable metadata. Only one that is demonstrably empty but for (at most) its meta.json,
   * left by a server that stopped mid-move and an hour old, is removed; anything holding an item, or anything else, or
   * that can't be read, is left as it is (and logged), since it may be the only copy of what was deleted.
   */
  async #cleanStaging(id: string, now: number): Promise<void> {
    const at = join(this.dir, id);
    const st = await lstat(at).catch(() => null);
    if (!st) return;
    const names = st.isDirectory() ? await readdir(at).catch(() => null) : null;
    if (names && names.every((n) => n === META)) {
      if (now - st.mtimeMs < 3_600_000) return;
      // Never its item: a meta.json and nothing else (a file), then the folder only if it is empty by now.
      try {
        if (names.length && (await lstat(join(at, META))).isFile()) await unlink(join(at, META));
        await rmdir(at);
      } catch (err) {
        log.warn('could not remove an unfinished trash item', { id, err: (err as Error).message });
      }
      return;
    }
    log.warn('a trash item whose meta.json is unreadable or not valid was kept as it is', { id });
  }

  #record(actor: AuditActor, action: 'files.trashed' | 'inbox.cleaned_up', space: Space | Bot, items: TrashItem[], extra: Record<string, number> = {}) {
    const target = 'origin' in space ? (space.origin === 'shared' ? SHARED_TARGET : { kind: 'boton', id: space.bot.id, label: space.bot.name }) : { kind: 'boton', id: space.id, label: space.name };
    this.#audit.record(actor, { action, target, details: { items: items.length, bytes: sum(items), paths: items.map((i) => i.path), ...extra } });
  }

  // ------------------------------------------------------------------ pins and sizes

  async setPinned(botId: string, path: unknown, pinned: unknown): Promise<{ path: string; pinned: boolean }> {
    const bot = this.#store.getBot(botId);
    if (typeof pinned !== 'boolean') throw new HttpError(400, 'pinned must be true or false');
    const e = await this.#entry(this.#space('workspace', bot.id), path);
    const name = e.rel.slice(INBOX.length + 1);
    if (!e.rel.startsWith(`${INBOX}/`) || name.includes('/')) throw new HttpError(400, 'Only files and folders directly in the inbox can be kept');
    // At the cap, pins of names no longer in the inbox make room first; past it a new one is refused.
    if (pinned && this.#store.inboxPins(bot.id).length >= INBOX_PINS_MAX) {
      const inbox = await readdir(join(e.root, INBOX)).catch(() => null);
      if (inbox) this.#store.pruneInboxPins(bot.id, new Set(inbox));
    }
    this.#store.setInboxPin(bot.id, name, pinned);
    return { path: e.rel, pinned };
  }

  async botStorage(bot: Bot, items?: Meta[]): Promise<BotStorage & { partial: boolean }> {
    const mine = (items ?? (await this.#readAll())).filter((m) => (m.origin ?? 'workspace') === 'workspace' && m.botId === bot.id);
    const [ws, inbox] = await Promise.all([folderBytes(bot.workspace), lstat(join(bot.workspace, INBOX)).then((s) => (s.isDirectory() ? folderBytes(join(bot.workspace, INBOX)) : { bytes: 0, partial: false }), () => ({ bytes: 0, partial: false }))]);
    return {
      botId: bot.id,
      name: bot.name,
      workspaceBytes: ws.bytes,
      inboxBytes: inbox.bytes,
      trashBytes: mine.reduce((n, m) => n + m.size, 0),
      trashItems: mine.length,
      partial: ws.partial || inbox.partial,
    };
  }

  /** The shared folder's size, and its items in the trash. */
  async sharedStorage(items?: Meta[]): Promise<{ sharedBytes: number; sharedTrashBytes: number; sharedTrashItems: number; partial: boolean }> {
    const mine = (items ?? (await this.#readAll())).filter((m) => m.origin === 'shared');
    const shared = await folderBytes(this.#shared);
    return { sharedBytes: shared.bytes, sharedTrashBytes: mine.reduce((n, m) => n + m.size, 0), sharedTrashItems: mine.length, partial: shared.partial };
  }

  async usage(): Promise<StorageUsage> {
    const items = await this.#readAll();
    const bots = await Promise.all(this.#store.listBots().map((b) => this.botStorage(b, items)));
    const { partial: sharedPartial, ...shared } = await this.sharedStorage(items);
    const settings = this.#store.getSettings();
    return {
      bots: bots.map(({ partial: _, ...b }) => b),
      ...shared,
      trashBytes: items.reduce((n, m) => n + m.size, 0),
      partial: sharedPartial || bots.some((b) => b.partial),
      inboxCleanupDays: settings.inboxCleanupDays,
      trashKeepDays: TRASH_KEEP_DAYS,
    };
  }
}

/** When an item was deleted, from its meta.json: only an exact ISO time (as written), else null. */
function deletedTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v ? t : null;
}

const targetOf = (m: Meta) => (m.origin === 'shared' ? SHARED_TARGET : { kind: 'boton', id: m.botId, label: m.botName });
const sum = (items: TrashItem[]) => items.reduce((n, i) => n + i.size, 0);
