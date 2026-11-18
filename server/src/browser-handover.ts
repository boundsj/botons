import type { BrowserHandoverInput, HandoverKey, HandoverMod } from '../../shared/types.ts';
import { HANDOVER_KEYS } from '../../shared/util.ts';
import { HttpError } from './store.ts';

/*
 * Owner takeover inputs are fixed UI actions from the paired device that owns the session. The Boton cannot
 * drive it, inspect its private page or access its input. Normal page requests follow the allowed-site policy.
 * Hand-back closes the private browser and deletes its profile; only cookies continue in the Boton's browser.
 */

/** The page's size until the owner's view says otherwise: clicks are in these coordinates, and frames are this size. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
/** The sizes the page may take to fit the owner's view (a phone's narrow sheet up to a large screen). */
export const VIEWPORT_MIN = { width: 320, height: 320 } as const;
export const VIEWPORT_MAX = { width: 1920, height: 1400 } as const;
/** The most text one input types, and one paste puts in. */
export const MAX_OWNER_TEXT = 1000;
export const MAX_PASTE = 5000;
/** The most of a selection one copy gives back to the owner's device. */
export const MAX_COPY = 20_000;
/** A handover with no input and no view open for this long ends on its own, and the Boton has its browser back. */
export const IDLE_MS = 10 * 60_000;
/** And it ends after this long, whatever happens: a forgotten tab doesn't keep the Boton's browser. */
export const MAX_HANDOVER_MS = 30 * 60_000;
/** At most one polled frame in this long (and one at a time): the fallback when the live view can't stream. */
export const FRAME_MIN_MS = 200;
/** At most this many inputs in INPUT_WINDOW_MS: enough to type and move the pointer as a person does. */
export const MAX_INPUTS = 600;
export const INPUT_WINDOW_MS = 10_000;

const ACTIONS = ['open', 'resume', 'click', 'down', 'up', 'move', 'wheel', 'type', 'paste', 'copy', 'key', 'scroll', 'back', 'forward', 'reload', 'resize'] as const;
const MODS: readonly HandoverMod[] = ['Shift', 'Control', 'Meta'];
/**
 * With Control (or Meta, which is Control here): only editing inside the page, never a browser shortcut (address bar,
 * tabs, print, save, find, devtools). Copy and paste are inputs of their own: a copy reads only the owner's selection,
 * a paste types the owner's text.
 */
const EDIT_COMBOS = new Set(['a', 'z', 'y', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End']);

/** The page's size for a view of `width` × `height` CSS pixels: whole pixels within the bounds. */
export function fitViewport(width: number, height: number): { width: number; height: number } {
  const fit = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
  return { width: fit(width, VIEWPORT_MIN.width, VIEWPORT_MAX.width), height: fit(height, VIEWPORT_MIN.height, VIEWPORT_MAX.height) };
}

/**
 * An input as the API received it, checked: a fixed action with values in range, or 400. The messages are fixed
 * words: they never repeat what was sent (it may be a password). Points are in the page's CSS pixels (browser.ts keeps
 * them inside the page's current size).
 */
export function parseOwnerInput(raw: unknown): BrowserHandoverInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Send an input as an object');
  const v = raw as Record<string, unknown>;
  if (typeof v.handover !== 'string' || !/^ho_[A-Za-z0-9_-]{8,40}$/.test(v.handover)) throw new HttpError(400, 'handover must be the id of the handover');
  const handover = v.handover;
  const action = v.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw new HttpError(400, `action must be one of ${ACTIONS.join(', ')}`);
  const int = (x: unknown, min: number, max: number, what: string) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw new HttpError(400, `${what} must be a number from ${min} to ${max}`);
    return Math.round(x);
  };
  const point = () => ({ x: int(v.x, 0, VIEWPORT_MAX.width - 1, 'x'), y: int(v.y, 0, VIEWPORT_MAX.height - 1, 'y') });
  const button = () => {
    if (v.button === undefined) return 'left' as const;
    if (v.button !== 'left' && v.button !== 'right' && v.button !== 'middle') throw new HttpError(400, 'button must be left, right or middle');
    return v.button;
  };
  const text = (max: number, lines: boolean) => {
    const t = v.text;
    if (typeof t !== 'string' || !t.length) throw new HttpError(400, `${action} needs text`);
    if (t.length > max) throw new HttpError(400, `${action} takes at most ${max} characters at a time`);
    // Keys are pressed with `key`: control characters are refused, not typed (a paste may hold new lines and tabs).
    if ((lines ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(t)) {
      throw new HttpError(400, lines ? 'paste takes text without control characters' : 'type takes text without new lines or control characters (press Enter or Tab with key)');
    }
    return t;
  };
  switch (action as (typeof ACTIONS)[number]) {
    case 'open': {
      if (typeof v.url !== 'string' || !v.url.trim() || v.url.length > 2000) throw new HttpError(400, 'open needs an address (at most 2000 characters)');
      return { handover, action: 'open', url: v.url.trim() };
    }
    case 'click': {
      const count = v.count === undefined ? 1 : int(v.count, 1, 3, 'count');
      return { handover, action: 'click', ...point(), ...(count > 1 ? { count } : {}) };
    }
    case 'down':
    case 'up': {
      // The press's count (a double or triple click is the second or third press in a row).
      const count = v.count === undefined ? 1 : int(v.count, 1, 3, 'count');
      return { handover, action: action as 'down' | 'up', ...point(), button: button(), ...(count > 1 ? { count } : {}) };
    }
    case 'move':
      return { handover, action: 'move', ...point() };
    case 'wheel':
      return { handover, action: 'wheel', ...point(), dx: int(v.dx ?? 0, -4000, 4000, 'dx'), dy: int(v.dy ?? 0, -4000, 4000, 'dy') };
    case 'type':
      return { handover, action: 'type', text: text(MAX_OWNER_TEXT, false) };
    case 'paste':
      return { handover, action: 'paste', text: text(MAX_PASTE, true) };
    case 'copy':
      return { handover, action: 'copy' };
    case 'resume':
      return { handover, action: 'resume' };
    case 'key': {
      const key = v.key;
      const named = typeof key === 'string' && HANDOVER_KEYS.includes(key as HandoverKey);
      if (!named && !(typeof key === 'string' && /^[a-z]$/.test(key))) throw new HttpError(400, `key must be one of ${HANDOVER_KEYS.join(', ')}, or a letter with Control`);
      const raw = v.mods === undefined ? [] : v.mods;
      if (!Array.isArray(raw) || raw.length > MODS.length || raw.some((m) => !MODS.includes(m as HandoverMod)) || new Set(raw).size !== raw.length) {
        throw new HttpError(400, `mods must be some of ${MODS.join(', ')}`);
      }
      const mods = raw as HandoverMod[];
      const control = mods.includes('Control') || mods.includes('Meta');
      if (control && !EDIT_COMBOS.has(key as string)) throw new HttpError(400, 'That shortcut is not sent to the page: only editing ones (select all, undo, redo, word and line moves)');
      if (!named && !control) throw new HttpError(400, 'Letters are typed with type, not pressed with key');
      if (key === 'Shift+Tab' && mods.length) throw new HttpError(400, 'Shift+Tab takes no other keys');
      return { handover, action: 'key', key: key as HandoverKey | string, ...(mods.length ? { mods } : {}) } as BrowserHandoverInput;
    }
    case 'scroll':
      return { handover, action: 'scroll', dy: int(v.dy, -4000, 4000, 'dy') };
    case 'back':
      return { handover, action: 'back' };
    case 'forward':
      return { handover, action: 'forward' };
    case 'reload':
      return { handover, action: 'reload' };
    case 'resize':
      return { handover, action: 'resize', width: int(v.width, 1, 10_000, 'width'), height: int(v.height, 1, 10_000, 'height') };
  }
}

/** The key as Playwright presses it, its modifiers first (Meta is Control here: the owner's Mac shortcut on Chromium for Linux). */
export const pressed = (k: string, mods: readonly HandoverMod[] = []): string => {
  const key = k === 'Space' ? ' ' : k;
  const held = [...new Set(mods.map((m) => (m === 'Meta' ? 'Control' : m)))].sort((a, b) => MODS.indexOf(a) - MODS.indexOf(b));
  return [...held, key].join('+');
};

/** At most `limit` takes in any `ms`. */
export class RateWindow {
  #times: number[] = [];
  #limit: number;
  #ms: number;
  constructor(limit: number, ms: number) {
    this.#limit = limit;
    this.#ms = ms;
  }
  take(now = Date.now()): boolean {
    this.#times = this.#times.filter((t) => now - t < this.#ms);
    if (this.#times.length >= this.#limit) return false;
    this.#times.push(now);
    return true;
  }
}
