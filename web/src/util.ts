import type { TokenUsage } from '../../shared/types.ts';
import { durationText, isValidTimezone, MIN_TIME_LIMIT_MS, totalTokens } from '../../shared/util.ts';

export { isValidTimezone, totalTokens };

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?';
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });

/** The first `max` characters, then "…" if there were more. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff >= 0 ? 'in a moment' : 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

// One formatter per kind and zone, made on first use: toLocaleString with options builds a new ICU formatter on every
// call, and the chat formats two times for every message it renders. A formatter fixes the browser's locale and zone
// when it is made, so the cache empties when the language changes or the page comes back into view (a laptop that
// slept across zones), and when it grows past a handful of zones.
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 32;
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => formatters.clear());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') formatters.clear();
  });
}
function formatter(kind: string, options: Intl.DateTimeFormatOptions, tz?: string): Intl.DateTimeFormat {
  const key = `${kind} ${tz ?? ''}`;
  let f = formatters.get(key);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat([], { ...options, timeZone: tz || undefined });
  } catch {
    // A half-typed zone must not throw during render (nor be kept): fall back to the browser's own.
    return formatter(kind, options);
  }
  if (formatters.size >= MAX_FORMATTERS) formatters.clear();
  formatters.set(key, f);
  return f;
}

/** How many formatters are cached (for tests). */
export function cachedFormatters(): number {
  return formatters.size;
}
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const DATE_TIME: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const DAY_YEAR: Intl.DateTimeFormatOptions = { ...DAY, year: 'numeric' };

let zones: string[] | null = null;

export function timezones(): string[] {
  if (!zones) {
    let list: string[] = [];
    try {
      list = Intl.supportedValuesOf('timeZone');
    } catch {}
    zones = list.includes('UTC') ? list : ['UTC', ...list];
  }
  return zones;
}

export function clock(iso: string, tz?: string): string {
  return formatter('clock', CLOCK, tz).format(new Date(iso));
}

export function dateTime(iso: string, tz?: string): string {
  return formatter('dateTime', DATE_TIME, tz).format(new Date(iso));
}

/** The calendar day in the browser's zone, as YYYY-MM-DD (a `<time datetime>` for a day). */
export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today, Yesterday, or the day ("Fri, Nov 6"; with the year when it is not this one), in the browser's zone. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = localDay(d);
  if (day === localDay(now)) return 'Today';
  // The calendar day before, not 24 hours before: a day across a clock change is 23 or 25 hours long.
  if (day === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return d.getFullYear() === now.getFullYear() ? formatter('day', DAY).format(d) : formatter('dayYear', DAY_YEAR).format(d);
}

/** A pause longer than this starts a new burst in the chat, and the burst's first message gets a time above it. */
export const BURST_GAP_MS = 30 * 60_000;

/**
 * What goes above a message in the chat, from the one before it in the loaded window: a day divider when the day
 * changes (or at the window's start), and a time when a burst starts (a new day, or after a pause of BURST_GAP_MS).
 */
export function timeMarks(prev: string | undefined, iso: string): { day: boolean; time: boolean } {
  if (!prev) return { day: true, time: true };
  const day = localDay(prev) !== localDay(iso);
  return { day, time: day || new Date(iso).getTime() - new Date(prev).getTime() > BURST_GAP_MS };
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

export function usageText(u: TokenUsage): string {
  const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${tokens(input)} in${u.cacheReadTokens ? ` (${tokens(u.cacheReadTokens)} cached)` : ''} · ${tokens(u.outputTokens)} out`;
}

export function costText(usd: number): string {
  return `est. $${usd < 0.01 ? usd.toPrecision(2) : usd.toFixed(2)}`;
}

/** The clipboard, with a fallback for plain http (see `copyText`). */
export { copyText as copy } from './copy.ts';

/** The unit a routine's time limit is typed in. */
export type LimitUnit = 'minutes' | 'seconds';
const UNIT_MS: Record<LimitUnit, number> = { minutes: 60_000, seconds: 1000 };

/** A time limit as its field shows it: whole minutes in minutes, anything else in seconds (exact to the millisecond). */
export function limitInput(ms: number): { amount: string; unit: LimitUnit } {
  return ms % 60_000 === 0 ? { amount: String(ms / 60_000), unit: 'minutes' } : { amount: String(ms / 1000), unit: 'seconds' };
}

/**
 * The field's native bounds in `unit`: 1 second up to the server's limit, unrounded, so every amount within them is a
 * limit the server takes (rounded to the millisecond, it stays within them).
 */
export function limitBounds(unit: LimitUnit, serverMs: number | null): { min: number; max: number | undefined } {
  return { min: MIN_TIME_LIMIT_MS / UNIT_MS[unit], max: serverMs === null ? undefined : serverMs / UNIT_MS[unit] };
}

/** The limit, in whole ms, an amount typed in `unit` means, or what is wrong with it. */
export function limitFrom(amount: string, unit: LimitUnit, serverMs: number | null): { ms: number } | { error: string } {
  const n = Number(amount);
  if (!amount.trim() || !Number.isFinite(n)) return { error: 'Enter how long a run may take.' };
  const ms = Math.round(n * UNIT_MS[unit]);
  if (ms < MIN_TIME_LIMIT_MS || (serverMs !== null && ms > serverMs)) {
    if (serverMs === null) return { error: 'At least 1 second.' };
    return { error: serverMs <= MIN_TIME_LIMIT_MS ? "1 second: the server's limit." : `Between 1 second and ${durationText(serverMs)} (the server's limit).` };
  }
  return { ms };
}
