export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENTS_MAX = 10;
/** Past this size a file is only downloaded, never shown in the app. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/**
 * How the app shows a file. `svg` and `html` can carry script, so neither is an `image` or text:
 * an SVG is shown only as an <img> (or a sandboxed document with no script), and HTML only in a
 * sandboxed page with an opaque origin (see `servingOf` in server/src/files.ts).
 */
export type FileKind = 'image' | 'svg' | 'html' | 'pdf' | 'markdown' | 'text' | 'other';

const IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd']);

const TEXT = new Set([
  'txt', 'text', 'log', 'out', 'err', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'rst', 'adoc', 'org', 'tex', 'bib', 'srt', 'vtt', 'diff', 'patch', 'sql', 'graphql', 'proto',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'css', 'scss', 'less',
  'vue', 'svelte', 'dockerfile', 'gitignore', 'lock',
]);

const OTHER_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  heic: 'image/heic',
  heif: 'image/heif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(name: string): FileKind {
  const ext = extensionOf(name);
  if (ext in IMAGES) return 'image';
  if (ext === 'svg') return 'svg';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (TEXT.has(ext)) return 'text';
  return 'other';
}

export function mimeType(name: string): string {
  const ext = extensionOf(name);
  if (ext in IMAGES) return IMAGES[ext];
  if (ext === 'pdf') return 'application/pdf';
  if (MARKDOWN.has(ext)) return 'text/markdown';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  if (TEXT.has(ext)) return 'text/plain';
  return OTHER_TYPES[ext] ?? 'application/octet-stream';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} ${units[i]}`;
}

/** Days something stays in the trash before it is deleted for good. */
export const TRASH_KEEP_DAYS = 30;
/** The daily inbox cleanup's choices in Settings → Storage (days untouched), and its default; null turns it off. */
export const INBOX_CLEANUP_CHOICES: readonly number[] = [7, 14, 30, 60, 90];
export const INBOX_CLEANUP_DEFAULT_DAYS = 30;
/** Files kept (Keep) in one Boton's inbox: every one is honoured, and one more past this is refused. */
export const INBOX_PINS_MAX = 1000;
/** Past these, doctor and Settings → Storage suggest Clear inbox or emptying the trash. */
export const INBOX_WARN_BYTES = 1024 ** 3;
export const FILES_WARN_BYTES = 5 * 1024 ** 3;
