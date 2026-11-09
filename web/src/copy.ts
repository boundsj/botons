import type { Message } from '../../shared/types.ts';

/** Messages the server writes as a user turn to start work: shown as chips, never as something to copy. */
const SERVER_TURNS = new Set(['work.event', 'connector.granted', 'reaction.followup', 'approval.decided', 'browser.handed_back']);

/**
 * What a message's Copy button copies: the text exactly as written (a Boton's Markdown source, the owner's plain text),
 * without its attachments or anything the chat draws around it. Null for a message with nothing to copy: chips,
 * errors, events, cards, approvals, and a message that is only attachments.
 */
export function messageCopyText(m: Pick<Message, 'role' | 'text' | 'meta'>): string | null {
  if (m.role !== 'user' && m.role !== 'bot') return null;
  if (m.meta?.kind && SERVER_TURNS.has(m.meta.kind)) return null;
  return m.text.trim() ? m.text : null;
}

interface ClipboardEnv {
  clipboard?: { writeText(text: string): Promise<void> } | undefined;
  document: Document;
}

const pageEnv = (): ClipboardEnv => ({ clipboard: globalThis.navigator?.clipboard, document });

/**
 * Puts `text` on the clipboard. The Clipboard API needs a secure context (plain http on a tailnet isn't one) and may
 * refuse; then a hidden, read-only textarea is copied from instead. Read-only so a phone opens no keyboard, 16 px so
 * iOS doesn't zoom, fixed and focused without scrolling so the chat and composer stay where they are; the focus and any
 * selection go back afterwards.
 */
export async function copyText(text: string, env: ClipboardEnv = pageEnv()): Promise<boolean> {
  if (env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no permission, the page not focused): the textarea below.
    }
  }
  return copyWithTextarea(text, env.document);
}

export function copyWithTextarea(text: string, doc: Document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  const sel = doc.getSelection?.() ?? null;
  const ranges: Range[] = [];
  for (let i = 0; sel && i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i));
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', padding: '0', border: '0', margin: '0', opacity: '0', fontSize: '16px', pointerEvents: 'none' });
  doc.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    if (active && active !== doc.body && typeof active.focus === 'function') active.focus({ preventScroll: true });
    if (sel && ranges.length) {
      sel.removeAllRanges();
      for (const r of ranges) sel.addRange(r);
    }
  }
  return ok;
}
