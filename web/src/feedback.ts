import { OfflineError } from './api.ts';

interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
  action?: { label: string; run: () => unknown };
}

let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

export const toastStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  get: () => toasts,
};

const emit = () => {
  for (const l of listeners) l();
};

export function showToast(toast: Omit<Toast, 'id'>, ms = 5000): void {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { ...toast, id }];
  timers.set(id, setTimeout(() => dismissToast(id), ms));
  emit();
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/**
 * The open modal dialogs, newest last. A modal makes the rest of the page inert, so the toasts (and their Undo) show
 * inside the newest one while any is open.
 */
let modals: number[] = [];
let nextModal = 1;
const modalListeners = new Set<() => void>();
export const modalStore = {
  open(): number {
    const id = nextModal++;
    modals = [...modals, id];
    for (const l of modalListeners) l();
    return id;
  },
  close(id: number) {
    modals = modals.filter((m) => m !== id);
    for (const l of modalListeners) l();
  },
  subscribe(l: () => void) {
    modalListeners.add(l);
    return () => {
      modalListeners.delete(l);
    };
  },
  top: (): number | null => modals.at(-1) ?? null,
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `offline`: the message never arrived, and the error clears once the app reconnects. */
export function sendError(e: unknown): { text: string; offline: boolean } {
  if (e instanceof OfflineError) return { text: "Couldn't reach the server, so your message wasn't sent. It's still in the box, ready to send again.", offline: true };
  return { text: `Couldn't send: ${errorText(e)}`, offline: false };
}

/** Run a one-off action; on failure show "Couldn't <what>: <reason>" (an error toast by default) and resolve false. */
export async function attempt(
  what: string,
  fn: () => Promise<unknown>,
  show: (message: string) => void = (text) => showToast({ kind: 'error', text }, 8000),
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    show(`Couldn't ${what}: ${errorText(e)}`);
    return false;
  }
}
