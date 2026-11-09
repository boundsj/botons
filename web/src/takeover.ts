import { useSyncExternalStore } from 'react';
import type { HandoverKey, HandoverMod } from '../../shared/types.ts';
import { HANDOVER_KEYS } from '../../shared/util.ts';

/*
 * Which Boton's browser the owner has open in the live view over the chat, if any: one at a time, opened from a
 * handoff card, the chat header's browser button or Settings, and drawn by TakeoverHost (BrowserTakeover.tsx).
 */

let open: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const takeover = {
  open(botId: string) {
    open = botId;
    emit();
  },
  close() {
    open = null;
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  current: () => open,
};

export function useTakeover(): string | null {
  return useSyncExternalStore(takeover.subscribe, takeover.current, () => null);
}

/** What a key the owner presses in the live view does there. */
export type KeyAction = { kind: 'key'; key: HandoverKey | string; mods: HandoverMod[] } | { kind: 'copy'; cut: boolean } | { kind: 'paste' } | { kind: 'text' } | { kind: 'own' };

const EDIT_LETTERS = new Set(['a', 'z', 'y']);

/**
 * A keydown in the live view, as what to send: a named key (with Shift, or with Control or ⌘ for editing), a copy or a
 * cut, a paste (left to the paste event, which brings the clipboard's text), plain text (left to the text box, so
 * phones and input methods work), or `own`: a shortcut the owner's own browser keeps (a new tab, the address bar).
 */
export function keyAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): KeyAction {
  const control = e.ctrlKey || e.metaKey;
  const mods: HandoverMod[] = [...(e.shiftKey ? (['Shift'] as const) : []), ...(control ? (['Control'] as const) : [])];
  if (e.altKey) return { kind: 'own' };
  if (control) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'c') return { kind: 'copy', cut: false };
    if (k === 'x') return { kind: 'copy', cut: true };
    if (k === 'v') return { kind: 'paste' };
    if (EDIT_LETTERS.has(k) || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End'].includes(k)) return { kind: 'key', key: k, mods };
    return { kind: 'own' };
  }
  if (e.key === ' ') return { kind: 'text' };
  if (e.key === 'Tab' && e.shiftKey) return { kind: 'key', key: 'Shift+Tab', mods: [] };
  if ((HANDOVER_KEYS as readonly string[]).includes(e.key)) return { kind: 'key', key: e.key, mods: e.shiftKey ? ['Shift'] : [] };
  return { kind: 'text' };
}
