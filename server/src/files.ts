import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, type Stats } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, readdir, readlink, realpath, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ATTACHMENTS_MAX, fileKind, mimeType, PREVIEW_MAX_BYTES, UPLOAD_MAX_BYTES } from '../../shared/files.ts';
import type { FileEntry, FileListing, FileRef } from '../../shared/types.ts';
import { heldLookups, heldPath, holdBeneath, holdDir } from './held-dir.ts';
import { HttpError } from './store.ts';
import { inside } from './util.ts';

// A Boton writes these files, so nothing is served in a way that runs in the app's origin.

const INBOX = 'inbox';
const LIST_MAX = 1000;
/** Past this many entries, only the first ones read are sorted. */
const LIST_SCAN_MAX = 5000;

const OUTSIDE = 'That path is outside the workspace';

/** Like GitHub's raw files: no script, no plugins, no resources but inline styles (image and text viewers use them). */
const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * An HTML file's preview page. Its script runs, but `sandbox` without `allow-same-origin` puts it in an
 * opaque origin: it can't read the app's storage (where the device token lives) or cookies, or script the
 * app's pages. Never add `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`.
 * Nothing loads from the network (inline and data: only), `connect-src 'none'` stops fetch, XHR,
 * WebSocket and EventSource (so not even /api), `form-action 'none'` stops posting a form, and only
 * the app may frame it. It is not network isolation: no CSP stops the page loading another address in
 * its own frame or tab, or using WebRTC, so its script can still send out what it holds (the file, and
 * this file's preview key). The viewer closes a frame that navigates (`PreviewFrame` in Files.tsx).
 */
export const PREVIEW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** Powerful features the preview page never gets, even if a browser would ask. */
const PREVIEW_PERMISSIONS = 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=(), publickey-credentials-get=()';

/** Tells the app's viewer that its preview frame didn't get the page: only a status, nothing of the file. */
const PREVIEW_ERROR_SCRIPT = "if (parent !== window) parent.postMessage({ botonsPreview: 'failed', status: Number(document.documentElement.dataset.status) }, '*');";
const PREVIEW_ERROR_STYLE = 'body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:10vh auto;padding:0 1.25rem;color:#1d1d1f}';
const cspHash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
/** The error page's own sandbox: just its one script and style, nothing else. */
export const PREVIEW_ERROR_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src ${cspHash(PREVIEW_ERROR_SCRIPT)}`,
  `style-src ${cspHash(PREVIEW_ERROR_STYLE)}`,
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Instead of a JSON error in the preview frame (a key that expired, a file deleted, swapped or grown past
 * the limit after the link was made): a short page that says why, and posts its status to the app so the
 * viewer shows its no-preview card. It never holds the file, the key or anything of the app.
 */
export function sendPreviewError(res: ServerResponse, err: HttpError): void {
  const body = `<!doctype html><html lang="en" data-status="${err.status}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No preview</title><style>${PREVIEW_ERROR_STYLE}</style></head><body><h1>No preview</h1><p>${escapeHtml(err.message)}</p><script>${PREVIEW_ERROR_SCRIPT}</script></body></html>`;
  res.writeHead(err.status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'content-security-policy': PREVIEW_ERROR_CSP,
    'permissions-policy': PREVIEW_PERMISSIONS,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
  });
  res.end(body);
}

/**
 * How a file is fetched: `raw` (an <img>, a link, the text viewer), `download`, or `preview`, an HTML
 * file's sandboxed page, reached only with a key for that one file (`Auth.previewKey`).
 */
export type Serving = 'raw' | 'download' | 'preview';

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function fsError(err: unknown): never {
  const code = errCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, 'No such file or folder in the workspace');
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') throw new HttpError(403, `Can't read that (${code})`);
  throw err;
}

/** The workspace as the filesystem sees it, created if it is missing, as a turn would. */
async function workspaceRoot(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  return realpath(workspace);
}

interface Resolved {
  root: string;
  abs: string;
  /** `abs` relative to `root`, "/"-separated. */
  rel: string;
  stat: Stats;
}

/**
 * The file or folder a client's path names inside the workspace, symlinks resolved: 403 if it leads
 * outside. One outside on its face is refused before the disk is touched, so nothing out there is revealed.
 */
export async function resolveInWorkspace(workspace: string, input: unknown): Promise<Resolved> {
  if (typeof input !== 'string') throw new HttpError(400, 'path must be a string');
  if (input.includes('\0')) throw new HttpError(400, 'path is not valid');
  const root = await workspaceRoot(workspace);
  const ws = resolve(workspace);
  const requested = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!inside(root, requested) && !inside(ws, requested)) throw new HttpError(403, OUTSIDE);
  let abs: string;
  try {
    abs = await realpath(requested);
  } catch (err) {
    fsError(err);
  }
  if (!inside(root, abs)) throw new HttpError(403, OUTSIDE);
  let st: Stats;
  try {
    st = await stat(abs);
  } catch (err) {
    fsError(err);
  }
  return { root, abs, rel: relative(root, abs).split(sep).join('/'), stat: st };
}

/**
 * Open a resolved file and check that what was opened is still inside: a Boton could swap a folder on
 * the way for a symlink after the check. Non-blocking, so a FIFO swapped in can't hold a server thread.
 */
async function openInside(root: string, abs: string): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    fsError(err);
  }
  try {
    // Linux says where the open file is; elsewhere the path must still lead to the same file.
    const where = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
    if (where !== null) {
      if (!inside(root, where)) throw new HttpError(403, OUTSIDE);
    } else {
      const [opened, again] = await Promise.all([fh.stat(), realpath(abs).then(async (p) => (inside(root, p) ? stat(p) : null))]);
      if (!again || again.dev !== opened.dev || again.ino !== opened.ino) throw new HttpError(403, OUTSIDE);
    }
    return fh;
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

export async function listFolder(workspace: string, path: string): Promise<FileListing> {
  const { root, abs, rel, stat: st } = await resolveInWorkspace(workspace, path || '.');
  if (!st.isDirectory()) throw new HttpError(400, 'That is a file, not a folder');
  let names: string[];
  try {
    names = (await readdir(abs)).slice(0, LIST_SCAN_MAX);
  } catch (err) {
    fsError(err);
  }
  const entries: FileEntry[] = [];
  for (const name of names) {
    const p = join(abs, name);
    let s: Stats;
    try {
      s = await lstat(p);
      if (s.isSymbolicLink()) {
        // Shown only if it leads somewhere inside; then as what it leads to.
        const target = await realpath(p);
        if (!inside(root, target)) continue;
        s = await stat(target);
      }
    } catch {
      continue; // gone meanwhile, a broken link, or unreadable
    }
    if (!s.isFile() && !s.isDirectory()) continue;
    entries.push({ name, path: rel ? `${rel}/${name}` : name, isDir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtime.toISOString() });
  }
  entries.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
  return { path: rel, entries: entries.slice(0, LIST_MAX), truncated: entries.length > LIST_MAX || names.length >= LIST_SCAN_MAX };
}

export function disposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Raster images, SVG, PDFs and text are shown inline with a type fixed by the extension, SVG and text
 * with no script; the rest downloads. HTML too: its only inline form is the preview page, because the
 * raw URL carries the device's files key, which a page's script could read off its own URL.
 */
export function servingOf(name: string, size: number, mode: Serving): { type: string; inline: boolean; csp: string | null } {
  const kind = fileKind(name);
  if (mode === 'preview') {
    if (kind !== 'html') throw new HttpError(400, 'Only HTML files have a preview page; fetch the file itself instead');
    if (size > PREVIEW_MAX_BYTES) throw new HttpError(413, `Too big to preview (over ${Math.round(PREVIEW_MAX_BYTES / 1024 / 1024)} MB); download it instead`);
    return { type: 'text/html; charset=utf-8', inline: true, csp: PREVIEW_CSP };
  }
  const inline = mode === 'raw' && kind !== 'other' && kind !== 'html' && size <= PREVIEW_MAX_BYTES;
  if (!inline) return { type: 'application/octet-stream', inline: false, csp: SANDBOX_CSP };
  if (kind === 'image') return { type: mimeType(name), inline: true, csp: SANDBOX_CSP };
  // As a document, the sandbox stops its script; as an <img>, browsers never run it.
  if (kind === 'svg') return { type: 'image/svg+xml', inline: true, csp: SANDBOX_CSP };
  // Browsers won't render a PDF in a CSP sandbox, and a PDF can't script the page that shows it.
  if (kind === 'pdf') return { type: 'application/pdf', inline: true, csp: null };
  return { type: 'text/plain; charset=utf-8', inline: true, csp: SANDBOX_CSP };
}

export async function sendFile(req: IncomingMessage, res: ServerResponse, workspace: string, path: string, mode: Serving): Promise<void> {
  const { root, abs, stat: st } = await resolveInWorkspace(workspace, path);
  if (st.isDirectory()) throw new HttpError(400, 'That is a folder; list it with GET /api/bots/:id/files');
  // Not a FIFO, socket or device: opening a FIFO would wait for a writer, tying up a server thread.
  if (!st.isFile()) throw new HttpError(400, 'Not a regular file');
  const fh = await openInside(root, abs);
  try {
    const opened = await fh.stat();
    if (!opened.isFile()) throw new HttpError(400, 'Not a regular file');
    const name = abs.slice(abs.lastIndexOf(sep) + 1);
    const how = servingOf(name, opened.size, mode);
    const etag = `W/"${opened.size.toString(16)}-${Math.floor(opened.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'content-type': how.type,
      'content-disposition': disposition(how.inline ? 'inline' : 'attachment', name),
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-cache',
      etag,
      'last-modified': opened.mtime.toUTCString(),
    };
    if (how.csp) headers['content-security-policy'] = how.csp;
    if (mode === 'preview') {
      // The key is in the URL: keep the page out of caches, and frame it nowhere but in the app.
      headers['cache-control'] = 'private, no-store';
      headers['permissions-policy'] = PREVIEW_PERMISSIONS;
      delete headers.etag;
      delete headers['last-modified'];
    }
    if (mode !== 'preview' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': String(opened.size) });
    try {
      await pipeline(fh.createReadStream({ autoClose: false }), res);
    } catch (err) {
      // The caller went away mid-file: nothing to answer.
      if (res.destroyed || errCode(err) === 'ERR_STREAM_PREMATURE_CLOSE') return;
      throw err;
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

export function safeName(input: string): string {
  const last = input.split(/[/\\]/).pop() ?? '';
  let name = last
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!name) name = 'file';
  if (name.length > 100) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 100 - ext.length) + ext;
  }
  return name;
}

async function inboxOf(root: string): Promise<string> {
  const inbox = join(root, INBOX);
  try {
    await mkdir(inbox);
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
  }
  const s = await lstat(inbox);
  if (!s.isDirectory()) throw new HttpError(409, `${INBOX}/ in the workspace is not a folder`);
  return inbox;
}

const PART = /^\.upload-[0-9a-f]{16}\.part$/;
/** A temp file untouched this long was left by a server that died mid-upload (one in progress is written to all along). */
const PART_STALE_MS = 60 * 60 * 1000;

/** Only a held directory path: lstat and unlink never follow the leaf. */
async function sweepParts(inbox: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(inbox);
  } catch {
    return;
  }
  const old = Date.now() - PART_STALE_MS;
  for (const name of names) {
    if (!PART.test(name)) continue;
    const p = join(inbox, name);
    try {
      const s = await lstat(p);
      if (s.isFile() && s.mtimeMs < old) await unlink(p);
    } catch {}
  }
}

function today(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * At `<inbox>/<date>-<name>`, or `-2`, `-3`… if taken. Never replaces a file: link() fails if anything (a symlink
 * included) is already there, and follows nothing at the target. A filesystem without hard links has no such step
 * (Node has no rename that refuses to replace), and a check before a rename is a race a Boton can win: refused there.
 */
async function place(tmp: string, inbox: string, prefix: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; n < 1000; n++) {
    const candidate = `${prefix}-${stem}${n === 1 ? '' : `-${n}`}${ext}`;
    try {
      await placeLink(tmp, join(inbox, candidate));
      await unlink(tmp);
      return candidate;
    } catch (err) {
      const code = errCode(err);
      if (code === 'EEXIST') continue;
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') throw new HttpError(507, NO_LINKS);
      throw err;
    }
  }
  throw new HttpError(409, 'Too many files with that name today');
}

export const NO_LINKS = "This workspace's filesystem has no hard links, so Botons can't put a file there without risking replacing one; nothing was saved";

let placeLink: (from: string, to: string) => Promise<void> = link;

/** Tests only (set in code, never from a setting): the step that puts a finished file in place. */
export function usePlaceLink(fn: ((from: string, to: string) => Promise<void>) | null): void {
  placeLink = fn ?? link;
}

/**
 * `name` (a folder of `root`, checked to be one) held open, as a path that names its entries through the open folder
 * (held-dir.ts): a file created, linked into place or removed through it stays in that folder, even if the Boton swaps
 * the folder for a link meanwhile. Where lookups in an open folder aren't available (not Linux) nothing is written:
 * a folder looked up again by its path is what such a swap redirects.
 */
function holdFolder(root: string, name: string): { path: string; close: () => void } {
  if (!heldLookups) throw new HttpError(501, `Botons writes into a workspace only through a folder it holds open (Linux /proc/self/fd), which this system doesn't have; nothing was saved in ${name}/`);
  const top = holdDir(root);
  try {
    const dir = holdBeneath(top, [name]);
    return { path: heldPath(dir), close: () => closeSync(dir.fd) };
  } catch {
    throw new HttpError(409, `${name}/ in the workspace is not a folder`);
  } finally {
    closeSync(top.fd);
  }
}

/**
 * A new file the server itself writes into a Boton's workspace (a browser screenshot, say), at
 * `<folder>/<prefix>-<name>`, never replacing anything. The Boton owns the workspace and may race the server, so no
 * step follows a link it planted: the folder must be a real folder (lstat, not a link) and is held open (holdFolder),
 * the temp file is created fresh in it with O_EXCL and O_NOFOLLOW, where that folder is now is checked before a byte is
 * written, and the file is linked into place there (place()). Without a held folder or hard links, nothing is saved.
 */
export async function saveNewFile(workspace: string, folder: string, prefix: string, name: string, bytes: Uint8Array): Promise<FileRef> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(folder) || folder.startsWith('.')) throw new Error(`not a folder name: ${folder}`);
  const root = await workspaceRoot(workspace);
  const dir = join(root, folder);
  try {
    await mkdir(dir);
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
  }
  const d = await lstat(dir);
  if (d.isSymbolicLink() || !d.isDirectory()) throw new HttpError(409, `${folder}/ in the workspace is not a folder`);
  const held = holdFolder(root, folder);
  const base = held.path;
  const tmp = join(base, `.save-${randomBytes(8).toString('hex')}.part`);
  let fh: FileHandle;
  try {
    fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  } catch (err) {
    held.close();
    throw err;
  }
  let placed: string | null = null;
  try {
    // Created through the held folder, so it is in that folder; where that folder is now must still be the workspace.
    const where = await readlink(`/proc/self/fd/${fh.fd}`);
    if (!inside(root, where)) throw new HttpError(409, `${folder}/ in the workspace moved while the file was saved`);
    await fh.writeFile(bytes);
    await fh.close();
    const saved = await place(tmp, base, prefix, safeName(name));
    placed = join(base, saved);
    const st = await lstat(placed);
    return { name: saved, path: `${folder}/${saved}`, size: st.size, type: mimeType(saved) };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    if (placed) await unlink(placed).catch(() => {});
    throw err;
  } finally {
    await fh.close().catch(() => {});
    held.close();
  }
}

/** Written to a hidden temp file first, so a file in the inbox is always whole. */
export async function receiveUpload(req: IncomingMessage, workspace: string, rawName: string, tz: string): Promise<FileRef> {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/octet-stream')) throw new HttpError(415, 'Send the file as the body, with Content-Type: application/octet-stream');
  const tooBig = () => new HttpError(413, `That file is too big: uploads are limited to ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB`, { connection: 'close' });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) throw tooBig();
  const name = safeName(rawName);

  const root = await workspaceRoot(workspace);
  await inboxOf(root);
  const held = holdFolder(root, INBOX);
  const base = held.path;
  const tmp = join(base, `.upload-${randomBytes(8).toString('hex')}.part`);
  let fh: FileHandle;
  try {
    await sweepParts(base);
    // `wx`: a fresh file, never one (or a symlink) already there.
    fh = await open(tmp, 'wx');
  } catch (err) {
    held.close();
    throw err;
  }
  let size = 0;
  try {
    const where = await readlink(`/proc/self/fd/${fh.fd}`);
    if (!inside(root, where)) throw new HttpError(403, OUTSIDE);
    await new Promise<void>((done, fail) => {
      const out = fh.createWriteStream();
      let failed = false;
      const stop = (err: Error) => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        out.destroy();
        fail(err);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > UPLOAD_MAX_BYTES) {
          req.pause();
          stop(tooBig());
        }
      });
      req.once('close', () => {
        if (!req.complete) stop(new HttpError(400, 'The upload was cut off'));
      });
      req.once('error', () => stop(new HttpError(400, 'The upload was cut off')));
      out.once('error', stop);
      out.once('close', () => {
        if (!failed) done();
      });
      req.pipe(out);
    });
    // Placed through the held inbox, it is there even if the inbox was swapped for a link meanwhile.
    const saved = await place(tmp, base, today(tz), name);
    return { name: saved, path: `${INBOX}/${saved}`, size, type: mimeType(saved) };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  } finally {
    await fh.close().catch(() => {});
    held.close();
  }
}

export function fileRef(found: Resolved): FileRef {
  const name = found.abs.slice(found.abs.lastIndexOf(sep) + 1);
  return { name, path: found.rel, size: found.stat.size, type: mimeType(name) };
}

export async function attachmentsOf(workspace: string, input: unknown): Promise<FileRef[]> {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'attachments must be a list of { path }');
  if (input.length > ATTACHMENTS_MAX) throw new HttpError(400, `At most ${ATTACHMENTS_MAX} attachments per message`);
  const out: FileRef[] = [];
  for (const a of input) {
    const path = (a as { path?: unknown } | null)?.path;
    if (typeof path !== 'string' || !path) throw new HttpError(400, 'Each attachment needs a path');
    const found = await resolveInWorkspace(workspace, path);
    if (!found.stat.isFile()) throw new HttpError(400, `${path} is not a file`);
    if (!out.some((f) => f.path === found.rel)) out.push(fileRef(found));
  }
  return out;
}
