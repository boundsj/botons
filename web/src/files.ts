import { FILES_WARN_BYTES, fileKind, formatSize, INBOX_WARN_BYTES, PREVIEW_MAX_BYTES } from '../../shared/files.ts';
import type { FileRef, Message, StorageUsage } from '../../shared/types.ts';
import { urlKeys, withKey } from './device.ts';

/** Text past this size isn't read into the page. */
export const TEXT_PREVIEW_MAX = 1024 * 1024;

const enc = encodeURIComponent;

/** With this device's files URL key: an <img> or a link can't send the token. */
export function rawUrl(botId: string, path: string, download = false): string {
  return withKey(`/api/bots/${enc(botId)}/files/raw?path=${enc(path)}${download ? '&download=1' : ''}`, urlKeys()?.files);
}

/** A shared folder file, always as a download: any Boton can write it. */
export function sharedRawUrl(path: string): string {
  return withKey(`/api/shared/files/raw?path=${enc(path)}`, urlKeys()?.files);
}

/** Why a file gets the no-preview card (type, size, Download) instead of a preview, or null if it is shown. */
export function noPreviewReason(name: string, size: number | null): string | null {
  const kind = fileKind(name);
  if (kind === 'other') return "Botons doesn't preview this kind of file.";
  if (size !== null && size > PREVIEW_MAX_BYTES) return `It's over ${formatSize(PREVIEW_MAX_BYTES)}, too big to preview here.`;
  if ((kind === 'markdown' || kind === 'text') && size !== null && size > TEXT_PREVIEW_MAX) return `It's over ${formatSize(TEXT_PREVIEW_MAX)} of text, too big to show here.`;
  return null;
}

export const PREVIEW_TOO_BIG = `It's over ${formatSize(PREVIEW_MAX_BYTES)}, too big to preview here.`;
export const PREVIEW_FRAME_LEFT = 'It loaded another page in its frame, so Botons closed it. Open it again to start over, or download it.';

/** Why an HTML preview page didn't load, by the status the server answered with (never text from the frame). */
export function previewFailure(status: number): string {
  if (status === 401) return 'Its preview link expired or is no longer valid. Refresh to open it again.';
  if (status === 404) return 'It was moved or deleted after it was opened. Refresh the folder to see what is there now.';
  if (status === 413) return PREVIEW_TOO_BIG;
  if (status === 400) return "It's no longer a file the viewer can show as a page.";
  return `Couldn't load its preview (error ${status}).`;
}

/** The reason for the server's preview error page message (`sendPreviewError`), or null for any other message. */
export function previewFailureOf(data: unknown): string | null {
  const m = data as { botonsPreview?: unknown; status?: unknown } | null;
  if (m?.botonsPreview !== 'failed' || typeof m.status !== 'number' || !Number.isInteger(m.status) || m.status < 400 || m.status > 599) return null;
  return previewFailure(m.status);
}

/** A leading ".." that has nothing to take off stays, so the server can refuse the path. */
export function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/');
  const absolute = joined.startsWith('/');
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (seg === '..' && absolute) continue;
    else out.push(seg);
  }
  return (absolute ? '/' : '') + out.join('/');
}

export function parentOf(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i) || '/';
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * The workspace path a Markdown link or image points to (relative ones from `dir`), or null if it is
 * not a file. An absolute path outside the workspace is kept as is, for the server to refuse.
 */
export function workspaceLink(href: string, workspace: string, dir = ''): string | null {
  if (!href || href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  let path = href.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (!path) return null;
  if (path.startsWith('/')) {
    const ws = workspace.replace(/\/+$/, '');
    if (path === ws) return '';
    if (path.startsWith(`${ws}/`)) return joinPath(path.slice(ws.length + 1));
    return joinPath(path);
  }
  return joinPath(dir, path);
}

export function crumbsOf(path: string, root = 'Workspace'): { name: string; path: string }[] {
  const out = [{ name: root, path: '' }];
  let at = '';
  for (const seg of path.split('/').filter(Boolean)) {
    at = at ? `${at}/${seg}` : seg;
    out.push({ name: seg, path: at });
  }
  return out;
}

/** The image a Boton shared in its chat (`botons share`, a browser screenshot), shown as itself under its chip; else null. */
export function sharedImage(m: Message): FileRef | null {
  const f = m.meta?.kind === 'file.shared' ? m.meta.file : undefined;
  if (!f) return null;
  const kind = fileKind(f.name);
  return kind === 'image' || kind === 'svg' ? f : null;
}

/**
 * Settings → Storage at a glance: what every file takes (each workspace, the shared folder and the trash), whether
 * that is a lot, and the Botons whose inbox is.
 */
export function storageTotals(u: StorageUsage): { total: number; big: boolean; fullInboxes: string[] } {
  const total = u.bots.reduce((n, b) => n + b.workspaceBytes, 0) + u.trashBytes + u.sharedBytes;
  const fullInboxes = u.bots.filter((b) => b.inboxBytes > INBOX_WARN_BYTES).map((b) => b.name);
  return { total, big: total > FILES_WARN_BYTES || fullInboxes.length > 0, fullInboxes };
}

/** The inbox cleanup in a few words, for the list of Settings pages. Unknown (not loaded) is the default, 30 days. */
export const cleanupText = (days: number | null | undefined): string => (days === null ? 'Cleanup off' : `Cleanup after ${days ?? 30} days`);
