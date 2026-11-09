// Automatic wake-ups in a Boton's chat: which messages the server wrote to start a turn (not the owner), which of
// them ended [quiet] and so stay out of the transcript, and the short labels the others get above their reply.
// The messages themselves are never changed or dropped: the API returns them all, and turn and run history keep
// what each quiet turn noted.

import type { Message, WorkEvent, WorkEventKind } from './types.ts';

/** A reply that starts with [quiet] (optionally followed by a short note): the note, or null for any other reply. */
export function parseQuiet(reply: string): string | null {
  const m = /^[\s*_`]*\[quiet\][*_`]*(?:[\s:\-–—]+([\s\S]*))?$/i.exec(reply.trim());
  return m ? (m[1] ?? '').trim() : null;
}

/**
 * A message that woke the Boton without the owner writing it: a connector's work update, another Boton's ask or reply,
 * an approval decision's or a connector grant's follow-up, a reaction follow-up. The owner's own messages, their
 * answer to a card (their words, in the chat) and their hand-back of the browser are never wake-ups.
 */
export function isAutomaticWake(m: Pick<Message, 'role' | 'meta'>): boolean {
  if (m.role !== 'user') return false;
  if (m.meta?.fromBotId) return true;
  const kind = m.meta?.kind;
  return !!kind && kind !== 'card.answered' && kind !== 'browser.handed_back';
}

/**
 * What a Boton does in the chat during a turn (a memory saved or forgotten, a file shared, a notification or an ask
 * sent, a routine or skill made, changed, paused, resumed or deleted): the server tags each with the turn it came
 * from (its own token's request while that turn runs), and a quiet turn's are left out with it. The same kinds done by
 * the owner or the server are tagged as no turn's and always show, as do approvals, cards, refusals, stops and errors.
 */
export const TURN_ACTIVITY: ReadonlySet<string> = new Set([
  'memory.saved',
  'memory.forgotten',
  'file.shared',
  'notify.sent',
  'ask.sent',
  'routine.created',
  'routine.updated',
  'routine.paused',
  'routine.resumed',
  'routine.deleted',
  'skill.created',
  'skill.updated',
]);

/** Whether a message may be left out of the transcript as quiet: never the owner's, an error, an approval or a card. */
export function mayBeQuiet(m: Pick<Message, 'role' | 'meta'>): boolean {
  if (m.role === 'user') return isAutomaticWake(m);
  if (m.role === 'bot') return true;
  if (m.role !== 'event') return false;
  const kind = m.meta?.kind ?? '';
  return kind === 'routine.run' || TURN_ACTIVITY.has(kind);
}

/**
 * The ids of the messages the transcript leaves out: those the server marked quiet (a quiet turn's wake-ups and what
 * it did, and from chat history its older quiet replies with their wake-ups or run chip). The server decides from
 * its turn records, so a page reads the same whichever messages are loaded with it.
 */
export function quietMessageIds(messages: readonly Message[]): Set<string> {
  const hidden = new Set<string>();
  for (const m of messages) if (m.meta?.quiet && mayBeQuiet(m)) hidden.add(m.id);
  return hidden;
}

/** A job's title as the owner sees it: one plain line, at most 80 characters, or null. Never given to a Boton. */
export function jobTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chars = [...t];
  return chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : t;
}

const WORK_TEXT: Record<WorkEventKind, string> = {
  finished: 'finished',
  needs_input: 'needs input',
  failed: 'failed',
  cancelled: 'was cancelled',
  delegated_ended: 'delegated work ended',
};

/** A connector's name from its id ("oauth:fleet" is fleet). */
export function connectorName(id: string | undefined): string {
  if (!id) return '';
  return id.slice(id.indexOf(':') + 1);
}

/** "PR #12" for a pull request link, else null. */
export function pullRequestOf(link: string | null | undefined): string | null {
  const m = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/(?:pull|pulls|merge_requests)\/(\d{1,9})(?:[/?#]|$)/.exec(link ?? '');
  return m ? `PR #${m[1]}` : null;
}

export interface WakeLabel {
  /** What shows: never a job, run or message id. */
  text: string;
  /** The tooltip: may name ids. */
  detail: string;
  warn: boolean;
}

/**
 * A connector's work update, as a short label: the connector, the job's title (or the pull request when the link is
 * one), and what happened.
 */
export function workLabel(work: WorkEvent | undefined, fallback = 'Work update'): WakeLabel {
  if (!work) return { text: fallback, detail: fallback, warn: false };
  const name = connectorName(work.connectorId) || 'A connector';
  const pr = pullRequestOf(work.link);
  const title = jobTitle(work.title);
  const what = WORK_TEXT[work.kind] ?? 'changed';
  // Delegated work ending says its own subject.
  const subject = title ? `“${title}”${pr ? ` (${pr})` : ''}` : (pr ?? (work.kind === 'delegated_ended' ? '' : 'work'));
  const detail = [`Job ${work.jobId}`, work.state ? `state ${work.state}` : null, work.unowned ? 'not known to be any Boton’s' : null].filter(Boolean).join(' · ');
  return { text: `${name}: ${subject ? `${subject} ` : ''}${what}`, detail, warn: work.kind === 'failed' };
}

/** A routine run's label: its name, how it was started when not by its schedule, and a retry's attempt. */
export function routineLabel(meta: Message['meta']): WakeLabel {
  const name = meta?.routineName?.trim() || 'a routine';
  const how = meta?.trigger && meta.trigger !== 'schedule' ? ` · ${meta.trigger}` : '';
  const attempt = (meta?.attempt ?? 1) > 1 ? ` · attempt ${meta?.attempt}` : '';
  return { text: `Routine: ${name}${how}${attempt}`, detail: meta?.runId ? `Run ${meta.runId}` : `Routine: ${name}`, warn: false };
}

/**
 * The chat's background line: how many routine turns and wake-ups ran in the last hour (and how many ended quiet),
 * and when the latest was (`when` writes that time). Null when the Boton has never had one.
 */
export function backgroundText(a: { lastHour: number; quietLastHour: number; lastAt: string | null }, when: (iso: string) => string): string | null {
  if (!a.lastAt) return null;
  const n = a.lastHour;
  const count = n === 0 ? 'No background updates in the last hour' : `${n} background ${n === 1 ? 'update' : 'updates'} in the last hour`;
  const quiet = n > 0 && a.quietLastHour > 0 ? (a.quietLastHour === n ? (n === 1 ? ', quiet' : ', all quiet') : `, ${a.quietLastHour} quiet`) : '';
  return `${count}${quiet} · last ${when(a.lastAt)}`;
}

/** An automatic wake-up's label in the Boton's background activity: what woke it, never an id. */
export function wakeLabel(m: Pick<Message, 'text' | 'meta'>): WakeLabel {
  const meta = m.meta;
  const from = meta?.fromBotName?.trim() || 'Another Boton';
  switch (meta?.kind) {
    case 'work.event':
      return workLabel(meta.work);
    case 'ask':
      return { text: `${from} asked`, detail: `${from} asked`, warn: false };
    case 'ask.reply':
      return { text: `${from} replied to an ask`, detail: `${from} replied to an ask`, warn: false };
    case 'approval.decided': {
      const what = meta.decision === 'allowed' ? 'Allowed' : meta.decision === 'denied' ? 'Denied' : 'Decided';
      const title = meta.approvalTitle?.trim();
      return { text: `${what}${title ? `: ${title}` : ' an approval'}`, detail: meta.approvalId ? `Approval ${meta.approvalId}` : 'Approval decided', warn: false };
    }
    case 'connector.granted': {
      const text = /^Connector .{1,80} added$/.test(m.text) ? m.text : 'Got a connector it asked for';
      return { text, detail: meta.connectorId ?? text, warn: false };
    }
    case 'reaction.followup':
      return { text: `Follow-up to your ${meta.emoji ?? ''} reaction`.replace('  ', ' '), detail: 'Reaction follow-up', warn: false };
  }
  return { text: meta?.fromBotId ? `Message from ${from}` : 'Automatic wake-up', detail: 'Automatic wake-up', warn: false };
}
