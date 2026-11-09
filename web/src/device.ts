// The device token lives in this origin's localStorage, never in a cookie: a
// browser sends a host's cookies to every port on it, so any web server on the host would get it.

import { storedValue } from '../../shared/legacy-names.mjs';
import type { UrlKeys } from '../../shared/types.ts';

const STORAGE_KEY = 'botons.deviceToken';

/** Fallback when there is no usable localStorage (Node tests, storage disabled). */
let memory: string | null = null;
let keys: UrlKeys | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function deviceToken(): string | null {
  try {
    // Under its deprecated key too, taken over once, so an upgrade keeps the device paired (shared/legacy-names.mjs).
    const s = storage();
    return (s ? storedValue(s, STORAGE_KEY) : null) ?? memory;
  } catch {
    return memory;
  }
}

export function setDeviceToken(token: string | null): void {
  memory = token;
  try {
    const s = storage();
    if (!s) return;
    if (token) s.setItem(STORAGE_KEY, token);
    else s.removeItem(STORAGE_KEY);
  } catch {}
}

export function urlKeys(): UrlKeys | null {
  return keys;
}

export function setUrlKeys(next: UrlKeys | null): void {
  keys = next;
}

export function withKey(url: string, key: string | null | undefined): string {
  return key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url;
}
