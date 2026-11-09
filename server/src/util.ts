import { randomBytes } from 'node:crypto';
import { sep } from 'node:path';

// Node builtins only: the `botons` CLI loads this.

export type Row = Record<string, any>;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, prefixed, random ids that are easy for a Boton to type: "rt_k3j9x2ab". */
export function newId(prefix: string, length = 8): string {
  let out = '';
  for (const b of randomBytes(length)) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function newSecret(): string {
  return randomBytes(24).toString('base64url');
}

export const nowIso = (): string => new Date().toISOString();

/** "Tue, Nov 5, 9:30 AM" in `tz`. */
export function fmtTime(iso: string | Date, tz: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** At most `max` characters: cut, the last one is "…". */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** On one line, then truncated. */
export function shorten(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** `p` is `root` or in it, not just a path that starts like it ("/x/dist-old" for "/x/dist"). */
export function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `fallback` for null, undefined or anything that isn't JSON. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return raw === null || raw === undefined ? fallback : (JSON.parse(String(raw)) as T);
  } catch {
    return fallback;
  }
}

/** The strings in `v`, if it is a list. */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function orNull<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

/** A timeout in seconds as the agent CLIs take one (a positive number, at most a day), or undefined. */
export function seconds(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 86_400 ? v : undefined;
}

// Line and paragraph separators and bidirectional overrides could make text read as other lines or in another order.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `text` in at most `max` UTF-16 units, cut after its last whole sentence that fits ("…" marks the cut): a word
 * boundary when not even its first sentence fits, a character (never half of one) when not even a word does.
 * Control characters, bidirectional overrides and runs of blank lines are dropped first.
 */
export function clipText(text: string, max: number): { text: string; cut: boolean } {
  // Only what can be kept is segmented: an endless reply costs no more than a long one.
  const sliced = text.length > max * 4;
  const clean = text
    .slice(0, max * 4)
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!sliced && clean.length <= max) return { text: clean, cut: false };
  const room = max - 1;
  const fit = (granularity: 'sentence' | 'word' | 'grapheme') => {
    let end = 0;
    for (const s of new Intl.Segmenter('en', { granularity }).segment(clean)) {
      if (s.index + s.segment.length > room) break;
      end = s.index + s.segment.length;
    }
    return end;
  };
  const end = fit('sentence') || fit('word') || fit('grapheme');
  return { text: `${clean.slice(0, end).trimEnd()}…`, cut: true };
}
