import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENTS_MAX, fileKind, formatSize, UPLOAD_MAX_BYTES } from '../../../shared/files.ts';
import type { Bot, FileRef } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText, showToast } from '../feedback.ts';
import { rawUrl } from '../files.ts';
import { shrinkImage } from '../image.ts';
import { cx } from '../util.ts';
import { AlertIcon, CloseIcon, FileIcon } from './Icons.tsx';

interface PendingFile {
  id: number;
  name: string;
  preview: string | null;
  progress: number;
  ref: FileRef | null;
  error: string | null;
}

let nextId = 1;

export function useAttachments(botId: string) {
  const [items, setItems] = useState<PendingFile[]>([]);
  // The ids in `items` as of now: two adds before the next render must both see the files the first added.
  const ids = useRef(new Set<number>());
  const aborts = useRef(new Map<number, AbortController>());
  const previews = useRef(new Set<string>());

  const update = (id: number, patch: Partial<PendingFile>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const forget = useCallback((item: PendingFile) => {
    aborts.current.get(item.id)?.abort();
    aborts.current.delete(item.id);
    if (item.preview) {
      URL.revokeObjectURL(item.preview);
      previews.current.delete(item.preview);
    }
  }, []);

  // Another Boton (or leaving the chat): stop uploads and free the thumbnails.
  useEffect(
    () => () => {
      for (const a of aborts.current.values()) a.abort();
      aborts.current.clear();
      for (const p of previews.current) URL.revokeObjectURL(p);
      previews.current.clear();
      ids.current.clear();
      setItems([]);
    },
    [botId],
  );

  const add = (files: File[]) => {
    const room = ATTACHMENTS_MAX - ids.current.size;
    if (files.length > room) showToast({ kind: 'error', text: `You can send up to ${ATTACHMENTS_MAX} files with a message.` }, 6000);
    for (const file of files.slice(0, Math.max(0, room))) {
      const id = nextId++;
      ids.current.add(id);
      const abort = new AbortController();
      aborts.current.set(id, abort);
      setItems((xs) => [...xs, { id, name: file.name || 'file', preview: null, progress: 0, ref: null, error: null }]);
      void (async () => {
        const ready = await shrinkImage(file);
        if (abort.signal.aborted) return;
        if (fileKind(ready.name) === 'image') {
          const preview = URL.createObjectURL(ready);
          previews.current.add(preview);
          update(id, { preview, name: ready.name });
        }
        if (ready.size > UPLOAD_MAX_BYTES) {
          update(id, { error: `Too big (${formatSize(ready.size)}; the limit is ${formatSize(UPLOAD_MAX_BYTES)})` });
          return;
        }
        try {
          const ref = await api.upload(botId, ready, ready.name, (p) => update(id, { progress: p }), abort.signal);
          if (!abort.signal.aborted) update(id, { ref, progress: 1 });
        } catch (e) {
          if (!abort.signal.aborted) update(id, { error: errorText(e) });
        } finally {
          aborts.current.delete(id);
        }
      })();
    }
  };

  const remove = (id: number) => {
    const item = items.find((x) => x.id === id);
    if (item) forget(item);
    ids.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  };

  const clear = () => {
    for (const item of items) forget(item);
    ids.current.clear();
    setItems([]);
  };

  return {
    items,
    add,
    remove,
    clear,
    busy: items.some((x) => !x.ref && !x.error),
    ready: items.flatMap((x) => (x.ref ? [x.ref] : [])),
  };
}

export function PendingFiles({ items, onRemove }: { items: PendingFile[]; onRemove: (id: number) => void }) {
  if (!items.length) return null;
  return (
    <ul className="pending-files" aria-label="Files to send">
      {items.map((f) => {
        const state = f.error ? 'failed' : f.ref ? 'ready' : 'uploading';
        return (
          <li key={f.id} className={cx('pending-file', state)} title={f.error ?? f.name}>
            {f.preview ? <img src={f.preview} alt="" /> : <FileIcon size={18} />}
            <span className="pending-name">{f.error ? f.error : f.name}</span>
            {state === 'uploading' && (
              <span className="pending-progress" role="progressbar" aria-label={`Uploading ${f.name}`} aria-valuenow={Math.round(f.progress * 100)}>
                <i style={{ width: `${Math.max(4, f.progress * 100)}%` }} />
              </span>
            )}
            {state === 'failed' && <AlertIcon size={14} className="error-icon" />}
            <button type="button" className="pending-remove" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.id)}>
              <CloseIcon size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SentFiles({ bot, files, onOpen }: { bot: Pick<Bot, 'id'>; files: FileRef[]; onOpen: (path: string) => void }) {
  return (
    <div className="sent-files">
      {files.map((f) => {
        const open = (e: MouseEvent) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onOpen(f.path);
        };
        const kind = fileKind(f.name);
        // An SVG in an <img> never runs its script.
        return kind === 'image' || kind === 'svg' ? (
          <a key={f.path} className="sent-thumb" href={rawUrl(bot.id, f.path)} target="_blank" rel="noreferrer noopener" onClick={open} title={f.name}>
            <img src={rawUrl(bot.id, f.path)} alt={f.name} loading="lazy" />
          </a>
        ) : (
          <a key={f.path} className="sent-file" href={rawUrl(bot.id, f.path)} target="_blank" rel="noreferrer noopener" onClick={open} title={f.name}>
            <FileIcon size={16} />
            <span>{f.name}</span>
            <span className="sent-size">{formatSize(f.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
