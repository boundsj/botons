// Patterns from the CLIs' own messages (claude 2.1.316, codex-cli 0.166.0). Transient ones are narrow on
// purpose: a permanent error taken for a network blip runs the work again.
import { isValidTimezone } from '../../../shared/util.ts';
import { zonedToUtc } from '../schedule.ts';

export type FailureKind = 'usage_limit' | 'auth' | 'transient' | 'other';

/** When a usage limit gives no reset time. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
/** A reset in the past (a skewed clock) would otherwise re-run the turn at once, over and over. */
export const MIN_COOLDOWN_MS = 60_000;

const USAGE_LIMIT = [
  /usage limit reached/i,
  /\bhit your (?:[\w'’-]+ ){0,3}limit\b/i,
  /\breached your (?:[\w'’-]+ ){0,2}limit\b/i,
  /\bspend limit reached\b/i,
  /\bout of usage credits\b/i,
];

const AUTH = [
  /\bnot logged in\b/i,
  /please run \/login/i,
  /\binvalid api key\b/i,
  /\boauth token (?:has )?(?:expired|revoked)\b/i,
  /\bauthentication_error\b/i,
  /\bauthentication failed\b/i,
  /\b401\b[^\n]*unauthori[sz]ed/i,
  /\bcodex login\b/i,
  /\bno codex credentials\b/i,
  /\bsign in again\b/i,
  /\baccess token could not be refreshed\b/i,
  /\brefresh token was rejected\b/i,
];

/** Not overloaded or 429 errors: both CLIs retry those themselves. */
const TRANSIENT = [
  /\bconnection error\b/i,
  /\brequest timed out\b/i,
  /\bfetch failed\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b/,
  /\bsocket hang up\b/i,
  /\bstream disconnected before completion\b/i,
  /\berror sending request\b/i,
  /\bconnection (?:failed|reset|refused)\b/i,
  // Codex's reconnects used up on a network failure, not an HTTP status.
  /^Reconnecting\.\.\. \d+\/\d+ \((?!unexpected status)/m,
];

/** `transientText` is only the failure itself: stderr often carries harmless network noise. */
export function classifyFailure(said: string, transientText: string, opts: { now?: Date; localTz?: string } = {}): { kind: FailureKind; retryAt: Date | null } {
  const now = opts.now ?? new Date();
  if (USAGE_LIMIT.some((re) => re.test(said))) {
    const localTz = opts.localTz ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const reset = parseReset(said, now, localTz)?.getTime() ?? now.getTime() + DEFAULT_COOLDOWN_MS;
    return { kind: 'usage_limit', retryAt: new Date(Math.max(reset, now.getTime() + MIN_COOLDOWN_MS)) };
  }
  if (AUTH.some((re) => re.test(said))) return { kind: 'auth', retryAt: null };
  if (TRANSIENT.some((re) => re.test(transientText))) return { kind: 'transient', retryAt: null };
  return { kind: 'other', retryAt: null };
}

/** Weekly limits reset within 7 days: anything later is a misread. */
const MAX_AHEAD_MS = 8 * 86_400_000;
const CLOCK_SLACK_MS = 60_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Times without a zone are in `localTz` (the CLIs print local time). */
export function parseReset(text: string, now: Date, localTz: string): Date | null {
  const ok = (d: Date | null) => (d && d.getTime() > now.getTime() - 5 * 60_000 && d.getTime() - now.getTime() <= MAX_AHEAD_MS ? d : null);
  // "Claude AI usage limit reached|1762400000" (seconds since the epoch).
  const epoch = /limit reached\|(\d{10,13})\b/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    const d = ok(new Date(n < 1e12 ? n * 1000 : n));
    if (d) return d;
  }
  // "resets in 2h 30m", "try again in 4 days 3 hours".
  const inDur = /\b(?:resets|try again) in ([^.\n·]+)/i.exec(text);
  if (inDur) {
    const ms = parseDurationWords(inDur[1]);
    if (ms !== null) return ok(new Date(now.getTime() + ms));
  }
  // "resets 3pm (Europe/Berlin)", "resets Nov 7, 9am (…)", "resets 2026-08-08 00:00 UTC", "try again at Nov 5th, 2026 3:05 PM."
  const at = /\b(?:resets|try again)(?: at| on)? ([^\n·]+)/i.exec(text);
  if (at) {
    const when = at[1].split(/\. |\.$| — | - /)[0];
    const d = parseWhen(when, now, localTz);
    if (d) return ok(d.getTime() <= now.getTime() ? new Date(now.getTime() + CLOCK_SLACK_MS) : d);
  }
  return null;
}

function parseDurationWords(s: string): number | null {
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  let found = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    found = true;
    total += Number(m[1]) * units[m[2][0].toLowerCase()];
  }
  return found ? Math.round(total) : null;
}

function parseWhen(s: string, now: Date, localTz: string): Date | null {
  const zone = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\)/.exec(s)?.[1] ?? (/\b(?:UTC|GMT)\b/.test(s) ? 'UTC' : localTz);
  const tz = isValidTimezone(zone) ? zone : localTz;
  const iso = /(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (iso) return zonedToUtc(+iso[1], +iso[2], +iso[3], +iso[4], +iso[5], tz);

  const time = /(?:^|[\s,])(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])|(?:^|[\s,])(\d{1,2}):(\d{2})(?![\d:])/i.exec(s);
  if (!time) return null;
  let h = Number(time[1] ?? time[4]);
  const min = Number(time[2] ?? time[5] ?? 0);
  const ap = time[3]?.toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;

  const today = ymdIn(now, tz);
  const md = /\b([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b(?:,? (\d{4}))?/.exec(s);
  const month = md ? MONTHS.indexOf(md[1].toLowerCase()) : -1;
  if (md && month >= 0) {
    let year = md[3] ? Number(md[3]) : today.y;
    let d = zonedToUtc(year, month + 1, Number(md[2]), h, min, tz);
    // "Jan 2" seen on Dec 30 means next year.
    if (!md[3] && d.getTime() < now.getTime() - 86_400_000) d = zonedToUtc(++year, month + 1, Number(md[2]), h, min, tz);
    return new Date(d.getTime() + CLOCK_SLACK_MS);
  }
  // A time of day only: today, or tomorrow if that has passed (a minute ago still counts as now).
  let d = zonedToUtc(today.y, today.m, today.d, h, min, tz);
  if (d.getTime() < now.getTime() - 5 * 60_000) {
    const t = ymdIn(new Date(now.getTime() + 86_400_000), tz);
    d = zonedToUtc(t.y, t.m, t.d, h, min, tz);
  }
  return new Date(d.getTime() + CLOCK_SLACK_MS);
}

function ymdIn(at: Date, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
