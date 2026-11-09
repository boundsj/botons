/*
 * A Boton's handoff of its managed browser to the owner, as data: the Boton asks (browser_handoff, with a short
 * reason) when a step is the owner's (a sign-in, a captcha, a code), the chat shows a card with Take over, and the
 * owner drives the browser in an overlay over the chat until they hand it back. The card is one chat event whose meta
 * holds this record; the server moves it through these states and nothing else does:
 *
 *   requested ──take──▶ taken ──hand back──▶ handed-back
 *       └──────close──▶ closed (the Boton asked again, its browser was turned off, or nobody took it in time)
 *
 * Taking over is the existing handover (browser-handover.ts), with all of its rules: the Boton's browser closes and its
 * tools are refused until the owner finishes, and what the owner types goes into the page and nowhere else. Handing
 * back (or the handover ending any other way) wakes the Boton with a note of where the page is now.
 *
 * This file is shared by the server and the web app, and imports nothing.
 */

export type HandoffState = 'requested' | 'taken' | 'handed-back' | 'closed';

export interface BrowserHandoff {
  state: HandoffState;
  /** The Boton's own words for why, cleaned and short: shown as its words, never as the server's. */
  reason: string;
  /** Where its browser was when it asked (origin and path only), or null. */
  url: string | null;
  requestedAt: string;
  /** A request nobody took by then is closed. */
  expiresAt: string;
  takenAt?: string;
  /** The device that took it over, as the server names it. */
  takenBy?: string;
  handedBackAt?: string;
  /** Where the owner left the page (origin and path only), or null when no page was open. */
  page?: string | null;
  /** How the handover ended: `finished` when the owner handed it back, else why it ended on its own. */
  how?: string;
  /** closed: why, in the server's words. */
  why?: string;
}

export type HandoffEvent =
  | { type: 'take'; at: string; by: string }
  | { type: 'hand-back'; at: string; page: string | null; how: string }
  | { type: 'close'; at: string; why: string };

export const HANDOFF_REASON_MAX = 200;
/** How long a request waits to be taken. */
export const HANDOFF_TTL_MS = 24 * 3_600_000;

/** The reason a Boton gave, cleaned (control and invisible characters out, one line, trimmed), or why it can't be used. */
export function handoffReason(raw: unknown): string | { why: string } {
  if (typeof raw !== 'string') return { why: 'reason must be a short text, such as "Sign in to example.com"' };
  const t = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return { why: 'reason must say what the owner should do, such as "Sign in to example.com"' };
  if (t.length > HANDOFF_REASON_MAX) return { why: `reason is too long (at most ${HANDOFF_REASON_MAX} characters)` };
  return t;
}

/** A new request, as the Boton made it. */
export function requestHandoff(reason: string, url: string | null, at: Date): BrowserHandoff {
  return { state: 'requested', reason, url, requestedAt: at.toISOString(), expiresAt: new Date(at.getTime() + HANDOFF_TTL_MS).toISOString() };
}

/** Still waiting on the owner to take it: requested and not past its expiry. */
export function handoffWaiting(h: BrowserHandoff, now: string): boolean {
  return h.state === 'requested' && h.expiresAt > now;
}

/** Open: waiting to be taken, or taken and not yet handed back. */
export function handoffOpen(h: BrowserHandoff, now: string): boolean {
  return handoffWaiting(h, now) || h.state === 'taken';
}

/**
 * The record after `e`, or null when `e` can't happen from where it stands: only a waiting request is taken (a
 * second take of a taken one changes nothing and is null too), only a taken one is handed back, and only a waiting
 * one is closed. A request past its expiry can only be closed.
 */
export function handoffStep(h: BrowserHandoff, e: HandoffEvent): BrowserHandoff | null {
  switch (e.type) {
    case 'take':
      return handoffWaiting(h, e.at) ? { ...h, state: 'taken', takenAt: e.at, takenBy: e.by } : null;
    case 'hand-back':
      return h.state === 'taken' ? { ...h, state: 'handed-back', handedBackAt: e.at, page: e.page, how: e.how } : null;
    case 'close':
      return h.state === 'requested' ? { ...h, state: 'closed', why: e.why } : null;
  }
}

/** What the Boton reads when it is woken by the hand-back: the server's words, never the owner's. */
export function handBackNote(owner: string, h: BrowserHandoff): string {
  const done = h.how === 'finished' ? `${owner} finished in your browser and handed it back` : `${owner}'s turn in your browser ended (${h.how ?? 'it ended'})`;
  const page = h.page ? ` The page is now ${h.page}: open it to go on.` : ' No page was open.';
  return `(From the Botons server: ${done}. You asked for: “${h.reason}”.${page} Read it before you assume the step worked.)`;
}
