import type { BrowserStatus } from '../../shared/types.ts';
import { storedValue } from '../../shared/legacy-names.mjs';
import { MAX_BROWSER_SITES } from '../../shared/util.ts';

/** The one-time suggestion on a Boton whose browser doesn't yet reach every public site. */
export const WEB_ACCESS_QUESTION = 'Turn on web access for all public sites?';

const key = (botId: string) => `botons.webAccessSuggestion.${botId}`;

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** Whether this device already answered the suggestion for `botId` (dismissed it, or took it). */
export function webAccessAnswered(botId: string, store: Pick<Storage, 'getItem'> | null = storage()): boolean {
  try {
    // Under its deprecated key too, where `store` can take it over (shared/legacy-names.mjs).
    return (store && 'setItem' in store && 'removeItem' in store ? storedValue(store as Storage, key(botId)) : (store?.getItem(key(botId)) ?? null)) === 'done';
  } catch {
    return false;
  }
}

export function answerWebAccess(botId: string, store: Pick<Storage, 'setItem'> | null = storage()): void {
  try {
    store?.setItem(key(botId), 'done');
  } catch {}
}

/**
 * Whether to ask: the server can run the browser, the Boton's brain takes connectors, and its browser isn't already on
 * for every public site. Never while a handover holds it, and once per Boton on this device.
 */
export function suggestsWebAccess(s: Pick<BrowserStatus, 'available' | 'enabled' | 'policy' | 'handover'>, takesConnectors: boolean, answered: boolean): boolean {
  if (answered || !s.available || !takesConnectors || s.handover || withAnySite(s.policy.sites) === null) return false;
  return !(s.enabled && s.policy.sites.includes('*'));
}

/**
 * The sites after the owner says yes: "*" and every entry it doesn't cover. "*" covers any public host on any port, and
 * an entry without a port is always public (the server refuses a private one without its port), so those go; every
 * host:port entry stays, so an address on this machine or a private network the owner named is still reachable. Null
 * when even that is more than a list holds.
 */
export function withAnySite(sites: string[]): string[] | null {
  if (sites.includes('*')) return sites;
  const kept = [...sites.filter((s) => /:\d+$/.test(s)), '*'];
  return kept.length > MAX_BROWSER_SITES ? null : kept;
}

/** One line for a server that can't run the browser: off, whatever the Boton's settings say, and why. */
export const unavailableLine = (why: string | null): string => `Off: ${(why ?? 'this server has no managed browser').replace(/\s+/g, ' ').trim()}`;
