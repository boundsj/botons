// Helpers the server, the `botons` CLI and the web app share. No imports beyond types: config.ts loads this without node_modules.
import type { HandoverKey, TokenUsage } from './types.ts';

/** How far back the runs-needing-attention overview (and `npm run doctor`) look for failed runs. */
export const ATTENTION_DAYS = 7;

/** The managed browser's connector (server/src/browser.ts): a Boton that has it gets the browser tools in its turns. */
export const BROWSER_SERVER = 'botons_browser';
export const BROWSER_CONNECTOR = `lib:${BROWSER_SERVER}`;
/** The most sites a Boton's browser list holds (browser-policy.ts checks it). */
export const MAX_BROWSER_SITES = 50;
/** The keys the owner can press in a browser handover: only these, never a shortcut with a modifier. */
export const HANDOVER_KEYS: readonly HandoverKey[] = ['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A one-off schedule ("once <iso>") whose time has come. */
export function isPastOneOff(spec: string | null, now = new Date()): boolean {
  return !!spec && spec.startsWith('once ') && new Date(spec.slice(5)).getTime() <= now.getTime();
}

export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** A copy's default name: the next number not `taken` (lowercased names): "Juniper" → "Juniper 2", "Juniper 2" → "Juniper 3". */
export function copyName(name: string, taken: Set<string>): string {
  const m = /^(.*\S) (\d+)$/.exec(name);
  const base = m ? m[1] : name;
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, 60 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The shortest time limit a routine may have: one second (the floor BOTONS_TURN_TIMEOUT_MS has too). */
export const MIN_TIME_LIMIT_MS = 1000;

/** A time limit for people: "20 minutes", "1 hour", "1.5 hours", "45 seconds". */
export function durationText(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const round = (n: number) => Math.round(n * 10) / 10;
  if (ms >= 3_600_000 && ms % 1_800_000 === 0) return unit(round(ms / 3_600_000), 'hour');
  if (ms >= 60_000) return unit(round(ms / 60_000), 'minute');
  return unit(round(ms / 1000), 'second');
}

/**
 * A version number found in a CLI's `--version` output ("2.1.3 (Claude Code)", "codex-cli 0.46.0"), else null. Only
 * that number is kept, so nothing else the output says (a path, an account) reaches what the owner copies.
 */
export function versionNumber(text: string | null | undefined): string | null {
  const m = /(?<![\w.@/-])v?(\d{1,4}\.\d{1,4}(?:\.\d{1,6})?(?:-[0-9A-Za-z]{1,16}(?:\.[0-9A-Za-z]{1,16}){0,3})?)(?![\w.@/-])/.exec(String(text ?? '').slice(0, 200));
  return m ? m[1] : null;
}

/** A build id in its expected shape (a commit sha, 7 to 40 hex digits), else null. */
export function buildSha(text: string | null | undefined): string | null {
  return typeof text === 'string' && /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : null;
}
