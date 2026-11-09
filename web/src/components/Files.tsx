import { useEffect, useRef, useState } from 'react';
import { fileKind, formatSize, mimeType, TRASH_KEEP_DAYS } from '../../../shared/files.ts';
import type { Bot, BotStorage, FileEntry, FileListing, FilePreviewLink, TrashItem } from '../../../shared/types.ts';
import { ApiError, api } from '../api.ts';
import { attempt, errorText, showToast } from '../feedback.ts';
import { useStore } from '../state.ts';
import { ConfirmDialog } from './Dialog.tsx';
import { MenuButton } from './Menu.tsx';
import { baseName, crumbsOf, noPreviewReason, parentOf, PREVIEW_FRAME_LEFT, PREVIEW_TOO_BIG, previewFailureOf, rawUrl, sharedRawUrl } from '../files.ts';
import { cx, dateTime, relative } from '../util.ts';
import { DownloadIcon, ExternalIcon, FileIcon, FolderIcon, MoreIcon, PinIcon, RefreshIcon, TrashIcon } from './Icons.tsx';
import { Markdown } from './Markdown.tsx';

interface Opened {
  path: string;
  name: string;
  size: number | null;
  mtime: string | null;
}

/** What the Files tab browses: the Boton's workspace, or the shared folder every Boton outside the Workspace sandbox can write. */
type Root = 'workspace' | 'shared';

// `focusAt` changes each time `focus` is asked for, so the same file can be opened again.
export function FilesTab({ bot, focus, focusAt }: { bot: Bot; focus: string | null; focusAt: number }) {
  const [root, setRoot] = useState<Root>('workspace');
  const [dir, setDir] = useState('');
  const [loaded, setLoaded] = useState<{ root: Root; dir: string; listing: FileListing } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [want, setWant] = useState<string | null>(null);
  const [file, setFile] = useState<Opened | null>(null);
  const [inTrash, setInTrash] = useState(false);
  // Selecting: a tap on a row picks it instead of opening it. Paths, in the folder shown.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    let live = true;
    setError(null);
    (root === 'shared' ? api.sharedFiles(dir) : api.files(bot.id, dir)).then(
      (listing) => live && setLoaded({ root, dir, listing }),
      (e) => {
        if (!live) return;
        setLoaded(null);
        setError(errorText(e));
        setWant(null);
      },
    );
    return () => {
      live = false;
    };
  }, [bot.id, root, dir, reload]);

  useEffect(() => {
    let live = true;
    api.botStorage(bot.id).then(
      (st) => live && setStorage(st),
      () => live && setStorage(null),
    );
    return () => {
      live = false;
    };
  }, [bot.id, reload]);

  useEffect(() => {
    if (want === null || loaded?.root !== root || loaded.dir !== parentOf(want)) return;
    const name = baseName(want);
    const entry = loaded.listing.entries.find((e) => e.name === name);
    setWant(null);
    if (entry?.isDir) {
      setFile(null);
      setDir(entry.path);
    } else {
      setFile(entry ?? { path: want, name, size: null, mtime: null });
    }
  }, [want, loaded, root]);

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const openPath = (path: string, inRoot: Root = root) => {
    setRoot(inRoot);
    setInTrash(false);
    stopSelecting();
    setFile(null);
    setWant(path);
    setDir(parentOf(path));
  };

  useEffect(() => {
    if (focus !== null) openPath(focus, 'workspace');
  }, [focus, focusAt]);

  const go = (path: string) => {
    setInTrash(false);
    stopSelecting();
    setFile(null);
    setWant(null);
    if (path === dir) setReload((n) => n + 1);
    else setDir(path);
  };
  const refresh = () => setReload((n) => n + 1);
  const switchRoot = (to: Root) => {
    if (to === root) return go('');
    setInTrash(false);
    stopSelecting();
    setFile(null);
    setWant(null);
    setDir('');
    setRoot(to);
  };

  const shared = root === 'shared';
  const listing = loaded?.root === root && loaded.dir === dir ? loaded.listing : null;
  const crumbs = crumbsOf(dir, shared ? 'Shared folder' : 'Workspace');
  const inInbox = !shared && dir === 'inbox';
  const isInboxRoot = (e: { path: string }) => !shared && e.path === 'inbox';
  const trashItems = shared ? storage?.sharedTrashItems : storage?.trashItems;
  const keepDays = settings?.inboxCleanupDays ?? null;

  /** To the trash: one file at once, with Undo; a folder or several after a confirmation. */
  const remove = (entries: { path: string; name: string; isDir: boolean }[]) => {
    if (!entries.length) return;
    const run = async () => {
      const paths = entries.map((e) => e.path);
      const { trashed } = await (shared ? api.deleteShared(paths) : api.deleteFiles(bot.id, paths));
      stopSelecting();
      if (file && entries.some((e) => e.path === file.path)) setFile(null);
      refresh();
      showToast({
        kind: 'info',
        text: trashed.length === 1 ? `Moved ${trashed[0].name} to the trash` : `Moved ${trashed.length} items to the trash`,
        action: { label: 'Undo', run: () => attempt('put them back', () => Promise.all(trashed.map((t) => api.restoreTrash(t.id))).then(refresh)) },
      });
    };
    if (entries.length === 1 && !entries[0].isDir) void attempt(`delete ${entries[0].name}`, run);
    else
      setConfirm({
        title: entries.length === 1 ? `Delete the folder ${entries[0].name}?` : `Delete ${entries.length} items?`,
        body: `${entries.length === 1 ? 'It goes' : 'They go'} to the trash${entries.some((e) => e.isDir) ? ', folders with everything in them' : ''}.${shared ? ' Every Boton that uses the shared folder loses it too.' : ''} You can restore ${entries.length === 1 ? 'it' : 'them'} from Trash for ${TRASH_KEEP_DAYS} days.`,
        label: 'Move to trash',
        what: 'delete them',
        run,
      });
  };

  const clearInbox = () =>
    setConfirm({
      title: 'Clear the inbox?',
      body: `Everything in ${bot.name}'s inbox goes to the trash, except files you keep. You can restore them from Trash for ${TRASH_KEEP_DAYS} days.`,
      label: 'Clear inbox',
      what: 'clear the inbox',
      run: async () => {
        const { trashed, kept } = await api.clearInbox(bot.id);
        refresh();
        const left = kept ? ` (${kept} kept)` : '';
        showToast({
          kind: 'info',
          text: trashed.length ? `Moved ${trashed.length === 1 ? '1 item' : `${trashed.length} items`} to the trash${left}` : `Nothing to clear${left}`,
          ...(trashed.length && { action: { label: 'Undo', run: () => attempt('put them back', () => Promise.all(trashed.map((t) => api.restoreTrash(t.id))).then(refresh)) } }),
        });
      },
    });

  const keep = (e: FileEntry, pinned: boolean) =>
    void attempt(pinned ? `keep ${e.name}` : `stop keeping ${e.name}`, async () => {
      await api.pinInbox(bot.id, e.path, pinned);
      refresh();
    });

  const toggle = (path: string) =>
    setSelected((now) => {
      const next = new Set(now);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const shown = listing?.entries ?? [];
  const picked = shown.filter((e) => selected.has(e.path));
  const pickable = shown.filter((e) => !isInboxRoot(e));

  return (
    <div className="tab-body">
      <div className="segmented files-roots" role="group" aria-label="Folder to browse">
        <button type="button" className={cx(!shared && 'on')} aria-pressed={!shared} onClick={() => switchRoot('workspace')}>
          {bot.name}'s workspace
        </button>
        <button type="button" className={cx(shared && 'on')} aria-pressed={shared} onClick={() => switchRoot('shared')}>
          Shared folder
        </button>
      </div>
      <div className="files-bar">
        {inTrash ? (
          <nav className="crumbs" aria-label="Folder">
            <span className="crumb">
              <button type="button" className="link-btn" onClick={() => go(dir)}>
                {crumbs[crumbs.length - 1].name}
              </button>
            </span>
            <span className="crumb">
              <span className="crumb-sep">/</span>
              <span className="crumb-here" aria-current="page">
                Trash
              </span>
            </span>
          </nav>
        ) : (
          <nav className="crumbs" aria-label="Folder">
            {crumbs.map((c, i) => (
              <span key={c.path} className="crumb">
                {i > 0 && <span className="crumb-sep">/</span>}
                {i === crumbs.length - 1 && !file ? (
                  <span className="crumb-here" aria-current="page">
                    {c.name}
                  </span>
                ) : (
                  <button type="button" className="link-btn" onClick={() => go(c.path)}>
                    {c.name}
                  </button>
                )}
              </span>
            ))}
            {file && (
              <span className="crumb">
                <span className="crumb-sep">/</span>
                <span className="crumb-here" aria-current="page">
                  {file.name}
                </span>
              </span>
            )}
          </nav>
        )}
        <div className="files-bar-actions">
          {!inTrash && !file && shown.length > 0 && (
            <button type="button" className={cx('btn small ghost', selecting && 'on')} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
              {selecting ? 'Done' : 'Select'}
            </button>
          )}
          <button
            type="button"
            className={cx('icon-btn small files-trash-btn', inTrash && 'on')}
            aria-label={trashItems ? `Trash, ${trashItems} item${trashItems === 1 ? '' : 's'}` : 'Trash'}
            title={shared ? "The shared folder's trash" : 'Trash'}
            aria-pressed={inTrash}
            onClick={() => {
              stopSelecting();
              setFile(null);
              setInTrash((t) => !t);
            }}
          >
            <TrashIcon size={15} />
            {!!trashItems && <span className="files-count">{trashItems}</span>}
          </button>
          <button type="button" className="icon-btn small" aria-label="Refresh" title="Refresh" onClick={refresh}>
            <RefreshIcon size={15} />
          </button>
        </div>
      </div>

      {inTrash ? (
        <TrashView key={`${root}:${reload}`} bot={bot} shared={shared} onChanged={refresh} onOpenPath={(p) => openPath(p)} confirm={setConfirm} />
      ) : file && shared ? (
        <SharedFile file={file} onDelete={() => remove([{ path: file.path, name: file.name, isDir: false }])} />
      ) : file ? (
        <FilePreview key={`${file.path}:${reload}`} bot={bot} file={file} onOpenPath={openPath} onDelete={() => remove([{ path: file.path, name: file.name, isDir: false }])} />
      ) : error ? (
        <p className="load-error" role="alert">
          <span>Couldn't open this folder: {error}</span>
          <button type="button" className="link-btn" onClick={() => go('')}>
            Back to {shared ? 'the shared folder' : 'the workspace'}
          </button>
        </p>
      ) : !listing ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {inInbox && (
            <div className="files-tools">
              <span className="hint">
                {keepDays === null ? 'Files you keep are marked with a pin.' : `Files older than ${keepDays} days go to the trash each day, unless you keep them.`}
              </span>
              <button type="button" className="btn small" onClick={clearInbox} disabled={!shown.some((e) => !e.pinned)}>
                Clear inbox
              </button>
            </div>
          )}
          {shown.length === 0 ? (
            <p className="empty-note">
              {dir ? 'This folder is empty.' : shared ? 'Nothing in the shared folder yet. Botons outside the Workspace sandbox can read and write it.' : `Nothing here yet. Files ${bot.name} makes, and files you send it, show up here.`}
            </p>
          ) : (
            <ul className={cx('file-list', selecting && 'selecting')} aria-label="Files" aria-multiselectable={selecting || undefined}>
              {shown.map((e) => {
                const inboxRow = isInboxRoot(e);
                const on = selected.has(e.path);
                return (
                  <li key={e.path} className={cx('file-item', on && 'picked')}>
                    {selecting &&
                      (inboxRow ? (
                        <span className="file-check" aria-hidden="true" />
                      ) : (
                        <input type="checkbox" className="file-check" checked={on} onChange={() => toggle(e.path)} aria-label={`Select ${e.name}`} />
                      ))}
                    <button
                      type="button"
                      className="file-row"
                      aria-pressed={selecting && !inboxRow ? on : undefined}
                      onClick={() => (selecting ? !inboxRow && toggle(e.path) : e.isDir ? go(e.path) : setFile(e))}
                    >
                      {e.isDir ? <FolderIcon size={18} className="file-icon dir" /> : <FileIcon size={18} className="file-icon" />}
                      <span className="file-name-wrap">
                        <span className="file-name">{e.name}</span>
                        {e.pinned && (
                          <span className="file-kept" title="Kept: the inbox cleanup and Clear inbox leave it">
                            <PinIcon size={13} />
                            <span className="sr-only">, kept</span>
                          </span>
                        )}
                      </span>
                      <span className="file-meta" title={dateTime(e.mtime)}>
                        {e.isDir ? '' : `${formatSize(e.size)} · `}
                        {relative(e.mtime)}
                      </span>
                    </button>
                    {!selecting && inboxRow && <span className="file-menu-spacer" aria-hidden="true" />}
                    {!selecting && !inboxRow && (
                      <MenuButton
                        label={`Actions for ${e.name}`}
                        className="icon-btn small file-menu-btn"
                        entries={() => [
                          ...(inInbox ? [{ label: e.pinned ? "Don't keep" : 'Keep in inbox', onSelect: () => keep(e, !e.pinned) }] : []),
                          {
                            label: 'Select',
                            onSelect: () => {
                              setSelecting(true);
                              setSelected(new Set([e.path]));
                            },
                          },
                          'separator' as const,
                          { label: 'Delete', danger: true, onSelect: () => remove([e]) },
                        ]}
                      >
                        <MoreIcon size={16} />
                      </MenuButton>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {listing.truncated && <p className="hint">Showing the newest {listing.entries.length}.</p>}
          {selecting && (
            <div className="files-select-bar" role="toolbar" aria-label="Selected files">
              <span className="files-select-count" aria-live="polite">
                {picked.length ? `${picked.length} selected` : 'Pick files and folders'}
              </span>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => setSelected(picked.length === pickable.length ? new Set() : new Set(pickable.map((e) => e.path)))}
              >
                {picked.length && picked.length === pickable.length ? 'Select none' : 'Select all'}
              </button>
              <button type="button" className="btn small danger-solid" disabled={!picked.length} onClick={() => remove(picked)}>
                <TrashIcon size={14} /> Delete
              </button>
            </div>
          )}
          {dir === '' && storage && <StorageLine storage={storage} shared={shared} />}
        </>
      )}
      {confirm && (
        <ConfirmDialog title={confirm.title} confirmLabel={confirm.label} what={confirm.what} danger onConfirm={confirm.run} onClose={() => setConfirm(null)}>
          <p>{confirm.body}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

type Storage = BotStorage & { sharedBytes: number; sharedTrashItems: number; sharedTrashBytes: number; partial: boolean };

interface Confirm {
  title: string;
  body: string;
  label: string;
  what: string;
  run: () => Promise<unknown>;
}

function StorageLine({ storage, shared }: { storage: Storage; shared: boolean }) {
  const at = storage.partial ? 'at least ' : '';
  if (shared)
    return (
      <p className="hint files-storage">
        Shared folder {at}
        {formatSize(storage.sharedBytes)} · Its trash {formatSize(storage.sharedTrashBytes)}
      </p>
    );
  return (
    <p className="hint files-storage">
      Workspace {at}
      {formatSize(storage.workspaceBytes)} · Inbox {formatSize(storage.inboxBytes)} · Trash {formatSize(storage.trashBytes)} · Shared folder {formatSize(storage.sharedBytes)}
    </p>
  );
}

const REASON: Record<TrashItem['reason'], string> = { deleted: 'deleted', inbox_cleanup: 'cleaned up', inbox_cleared: 'inbox cleared' };

function daysLeft(purgeAt: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(purgeAt) - Date.now()) / 86_400_000));
  return days <= 1 ? 'deleted for good within a day' : `${days} days left`;
}

/** This Boton's trash, or the shared folder's: Restore, Delete forever, Empty trash. */
function TrashView({ bot, shared, onChanged, onOpenPath, confirm }: { bot: Bot; shared: boolean; onChanged: () => void; onOpenPath: (path: string) => void; confirm: (c: Confirm) => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (shared ? api.sharedTrash() : api.trash(bot.id)).then(
      (t) => live && setItems(t),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [bot.id, shared]);

  const restore = (t: TrashItem) =>
    void attempt(`restore ${t.name}`, async () => {
      const r = await api.restoreTrash(t.id);
      onChanged();
      showToast({ kind: 'info', text: r.folderGone ? `The original folder is gone, so it was restored to ${r.path}` : r.renamed ? `Restored to ${r.path}` : `Restored ${r.path}`, action: { label: 'Show', run: () => onOpenPath(r.path) } });
    });
  const purge = (t: TrashItem) =>
    confirm({
      title: `Delete ${t.name} forever?`,
      body: `${t.isDir ? 'The folder and everything in it are' : 'It is'} deleted for good. This can't be undone.`,
      label: 'Delete forever',
      what: `delete ${t.name}`,
      run: async () => {
        await api.purgeTrash(t.id);
        onChanged();
      },
    });
  const empty = () =>
    confirm({
      title: 'Empty the trash?',
      body: `${items?.length === 1 ? 'The item' : `All ${items?.length} items`} in ${shared ? "the shared folder's" : `${bot.name}'s`} trash ${items?.length === 1 ? 'is' : 'are'} deleted for good. This can't be undone.`,
      label: 'Empty trash',
      what: 'empty the trash',
      run: async () => {
        await (shared ? api.emptySharedTrash() : api.emptyTrash(bot.id));
        onChanged();
      },
    });

  if (error)
    return (
      <p className="load-error" role="alert">
        Couldn't open the trash: {error}
      </p>
    );
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="files-tools">
        <span className="hint">Deleted files stay here {TRASH_KEEP_DAYS} days, then are deleted for good.</span>
        {items.length > 0 && (
          <button type="button" className="btn small" onClick={empty}>
            Empty trash
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="empty-note">The trash is empty.</p>
      ) : (
        <ul className="file-list" aria-label="Trash">
          {items.map((t) => (
            <li key={t.id} className="file-item trash-item">
              <div className="file-row static">
                {t.isDir ? <FolderIcon size={18} className="file-icon dir" /> : <FileIcon size={18} className="file-icon" />}
                <span className="trash-text">
                  <span className="file-name">{t.name}</span>
                  <span className="file-meta" title={`Deleted ${dateTime(t.deletedAt)}; deleted for good ${dateTime(t.purgeAt)}`}>
                    {t.path.includes('/') ? `${t.path.slice(0, t.path.lastIndexOf('/'))}/ · ` : ''}
                    {formatSize(t.size)} · {REASON[t.reason]} {relative(t.deletedAt)} · {daysLeft(t.purgeAt)}
                  </span>
                </span>
              </div>
              <button type="button" className="btn small" onClick={() => restore(t)} disabled={t.botGone} title={t.botGone ? 'Its Boton was deleted' : undefined}>
                Restore
              </button>
              <MenuButton label={`More for ${t.name}`} className="icon-btn small file-menu-btn" entries={() => [{ label: 'Delete forever', danger: true, onSelect: () => purge(t) }]}>
                <MoreIcon size={16} />
              </MenuButton>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A shared folder file: downloaded, never shown in the app, since any Boton can write what it holds. */
function SharedFile({ file, onDelete }: { file: Opened; onDelete: () => void }) {
  const type = mimeType(file.name);
  return (
    <div className="file-preview">
      <div className="file-card" role="group" aria-label={`${file.name} in the shared folder`}>
        <FileIcon size={28} className="file-card-icon" />
        <div className="file-card-body">
          <strong className="file-card-name">{file.name}</strong>
          <span className="hint" title={file.mtime ? dateTime(file.mtime) : undefined}>
            {[type === 'application/octet-stream' ? 'Unknown type' : type, file.size !== null ? formatSize(file.size) : null, file.mtime ? `changed ${relative(file.mtime)}` : null].filter(Boolean).join(' · ')}
          </span>
          <span className="file-card-reason">Shared folder files download rather than open here: any Boton can write them.</span>
        </div>
        <div className="file-card-actions">
          <a className="btn small file-card-download" href={sharedRawUrl(file.path)} download={file.name}>
            <DownloadIcon size={14} /> Download
          </a>
          <button type="button" className="btn small" onClick={onDelete}>
            <TrashIcon size={14} /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function FilePreview({ bot, file, onOpenPath, onDelete }: { bot: Bot; file: Opened; onOpenPath: (path: string) => void; onDelete: () => void }) {
  const kind = fileKind(file.name);
  const url = rawUrl(bot.id, file.path);
  const reason = noPreviewReason(file.name, file.size);
  const readable = !reason && (kind === 'markdown' || kind === 'text');
  const [text, setText] = useState<{ ok: true; text: string } | { ok: false; error: string } | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const page = useHtmlPreview(bot.id, file.path, !reason && kind === 'html');
  // Its size when the preview link was made: the listing's can be stale, or unknown (opened from a chip).
  // Refused as too big, the listing's size is wrong and the real one unknown: show none.
  const size = page?.ok ? page.link.size : page?.tooBig ? null : file.size;
  const shown = size === file.size ? file : { ...file, size };

  useEffect(() => {
    if (!readable) return;
    let live = true;
    api.fileText(bot.id, file.path).then(
      (t) => live && setText({ ok: true, text: t }),
      (e) => live && setText({ ok: false, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [bot.id, file.path, readable]);

  const meta = [shown.size !== null ? formatSize(shown.size) : null, file.mtime ? `changed ${relative(file.mtime)}` : null].filter(Boolean).join(' · ');
  // HTML opens in a tab only as its preview page (the same sandbox); other kinds the app can't show would just download.
  const [frameFailed, setFrameFailed] = useState<string | null>(null);
  const tabUrl = kind === 'html' ? (page?.ok && !frameFailed ? page.link.url : null) : reason ? null : url;

  return (
    <div className="file-preview">
      <div className="file-head">
        <div className="file-title">
          <strong>{file.name}</strong>
          {meta && (
            <span className="hint" title={file.mtime ? dateTime(file.mtime) : undefined}>
              {meta}
            </span>
          )}
        </div>
        <div className="file-actions">
          {tabUrl && (
            <a className="icon-btn small" href={tabUrl} target="_blank" rel="noreferrer noopener" aria-label="Open in a new tab" title="Open in a new tab">
              <ExternalIcon size={15} />
            </a>
          )}
          <a className="icon-btn small" href={rawUrl(bot.id, file.path, true)} download={file.name} aria-label="Download" title="Download">
            <DownloadIcon size={15} />
          </a>
          <button type="button" className="icon-btn small" aria-label="Delete" title="Delete (to the trash)" onClick={onDelete}>
            <TrashIcon size={15} />
          </button>
        </div>
      </div>

      {reason ? (
        <NoPreview bot={bot} file={file} reason={reason} />
      ) : kind === 'image' || kind === 'svg' ? (
        imageFailed ? (
          <NoPreview bot={bot} file={file} reason={kind === 'svg' ? "Couldn't draw this SVG: it may be damaged, or not an SVG." : "Couldn't load this image: it may be damaged, or not the kind its name says."} />
        ) : (
          <a href={url} target="_blank" rel="noreferrer noopener" className="file-image-link">
            <img className={cx('file-image', kind === 'svg' && 'svg')} src={url} alt={file.name} onError={() => setImageFailed(true)} />
          </a>
        )
      ) : kind === 'html' ? (
        !page ? (
          <p className="muted">Loading…</p>
        ) : !page.ok ? (
          <NoPreview bot={bot} file={shown} reason={page.error} />
        ) : frameFailed ? (
          <NoPreview bot={bot} file={shown} reason={frameFailed} />
        ) : (
          <>
            <PreviewFrame url={page.link.url} title={`Preview of ${file.name}`} onFail={setFrameFailed} />
            <p className="hint">
              Shown in a sandbox: its scripts run, but can't read Botons' storage or pages, call /api, or fetch anything. It isn't cut off from the
              network: a script can still send what the page holds by loading another address in its frame (Botons then closes it) or over WebRTC.
            </p>
          </>
        )
      ) : kind === 'pdf' ? (
        <a className="btn small file-open" href={url} target="_blank" rel="noreferrer noopener">
          <ExternalIcon size={14} /> Open the PDF
        </a>
      ) : !text ? (
        <p className="muted">Loading…</p>
      ) : !text.ok ? (
        <p className="load-error" role="alert">
          Couldn't open it: {text.error}
        </p>
      ) : kind === 'markdown' ? (
        <div className="file-doc">
          <Markdown text={text.text} botId={bot.id} workspace={bot.workspace} dir={parentOf(file.path)} onOpenFile={onOpenPath} />
        </div>
      ) : (
        <pre className={cx('file-text', !text.text && 'empty')}>{text.text || '(empty file)'}</pre>
      )}
    </div>
  );
}

/**
 * The sandboxed frame (belt and braces with the page's own CSP sandbox: never allow-same-origin). It fails,
 * and the viewer shows the no-preview card instead, when the server sends its error page (a key that
 * expired, a file deleted or grown since the link was made), or when the page loads another one in its
 * frame: the sandbox and CSP can't stop that, so Botons closes it rather than show what it went to.
 */
function PreviewFrame({ url, title, onFail }: { url: string; title: string; onFail: (reason: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this frame's own messages, and only a status: the page itself could send one, but only to close itself.
      if (e.source !== frame.current?.contentWindow) return;
      const reason = previewFailureOf(e.data);
      if (reason) onFail(reason);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onFail]);
  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) onFail(PREVIEW_FRAME_LEFT);
  };
  return <iframe ref={frame} className="file-frame" src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" title={title} onLoad={onLoad} />;
}

type PreviewPage = { ok: true; link: FilePreviewLink } | { ok: false; error: string; tooBig?: boolean };

/** A fresh preview link each time the file is opened: its key lasts an hour. */
function useHtmlPreview(botId: string, path: string, enabled: boolean) {
  const [page, setPage] = useState<PreviewPage | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.filePreview(botId, path).then(
      (link) => live && setPage({ ok: true, link }),
      (e) =>
        live &&
        setPage(e instanceof ApiError && e.status === 413 ? { ok: false, error: PREVIEW_TOO_BIG, tooBig: true } : { ok: false, error: `Couldn't open its preview: ${errorText(e)}` }),
    );
    return () => {
      live = false;
    };
  }, [botId, path, enabled]);
  return page;
}

function NoPreview({ bot, file, reason }: { bot: Bot; file: Opened; reason: string }) {
  const type = mimeType(file.name);
  return (
    <div className="file-card" role="group" aria-label={`${file.name}: no preview`}>
      <FileIcon size={28} className="file-card-icon" />
      <div className="file-card-body">
        <strong className="file-card-name">{file.name}</strong>
        <span className="hint">{[type === 'application/octet-stream' ? 'Unknown type' : type, file.size !== null ? formatSize(file.size) : null].filter(Boolean).join(' · ')}</span>
        <span className="file-card-reason">{reason}</span>
      </div>
      <a className="btn small file-card-download" href={rawUrl(bot.id, file.path, true)} download={file.name}>
        <DownloadIcon size={14} /> Download
      </a>
    </div>
  );
}
