import type { Message } from '../../shared/types.ts';

/**
 * What a new session is given of the chat, sized to one budget. Sizes are estimated tokens, counted as UTF-8
 * bytes: a byte-level tokenizer never makes more tokens than a text has bytes, so the estimate is never below the
 * real count (for English it is about four times it). Budgeting by that bound keeps a chat in any language inside it.
 */

/** One budget for everything a new session starts with ahead of the turn's own input: the handoff note, the summary and the replayed chat. */
export const REPLAY_BUDGET = 64_000;
/** Each replayed message longer than this is given as an excerpt: its start and end, cut between sentences. */
export const MESSAGE_LIMIT = 4_000;
/** The owner's pins: at most this many at once, each replayed whole up to PIN_LIMIT_BYTES (longer: an excerpt). */
export const PIN_LIMIT = 10;
export const PIN_LIMIT_BYTES = 2_400;
/** Routine messages take at most this much, apart from the chat, so a run of busy routines can't push the owner's messages out. */
export const ROUTINE_SHARE = 8_000;
/**
 * A webhook run is given at most this many of the chat's latest messages (the owner's choice for its routine, 0 by
 * default), inside WEBHOOK_HISTORY_BUDGET: its payload comes from outside, so it sees a bounded part of the chat or none.
 */
export const WEBHOOK_HISTORY_MAX = 20;
export const WEBHOOK_HISTORY_BUDGET = 16_000;
/** The store reads the chat for a replay this many messages at a time, newest first, until the budget is full. */
export const REPLAY_PAGE = 200;

/** A message the replay may give, with its place in the chat. */
export interface Replayable {
  message: Message;
  seq: number;
}

export const estimateTokens = (text: string): number => Buffer.byteLength(text, 'utf8');

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const words = new Intl.Segmenter('en', { granularity: 'word' });
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** The marker an excerpt carries where text was left out: it says it is an excerpt, never a summary. */
export const excerptMarker = (left: number) => ` [… excerpt: ${left.toLocaleString('en-US')} characters left out …] `;
const MARKER_MAX = estimateTokens(excerptMarker(10_000_000_000));

/** The longest start of `text` within `max` bytes, ending between segments (sentences, else words, else characters). */
function fitStart(text: string, max: number): number {
  for (const seg of [sentences, words, graphemes]) {
    let end = 0;
    let used = 0;
    for (const s of seg.segment(text)) {
      const n = estimateTokens(s.segment);
      if (used + n > max) break;
      used += n;
      end = s.index + s.segment.length;
    }
    // A sentence boundary only if it keeps at least half of what fits: else words read better than one short sentence.
    if (end > 0 && (seg !== sentences || used * 2 >= max)) return end;
  }
  return 0;
}

/** The latest index of `text` whose end from there fits in `max` bytes, starting between segments. */
function fitEnd(text: string, max: number): number {
  for (const seg of [sentences, words, graphemes]) {
    const parts = [...seg.segment(text)];
    let start = text.length;
    let used = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = estimateTokens(parts[i].segment);
      if (used + n > max) break;
      used += n;
      start = parts[i].index;
    }
    if (start < text.length && (seg !== sentences || used * 2 >= max)) return start;
  }
  return text.length;
}

/**
 * `text` whole if it fits in `max` estimated tokens, else an excerpt that does: its start and its end, each cut
 * between sentences where it can (else between words, else characters, never inside one), and a marker in between
 * that says how much was left out. Only whole code points and graphemes are kept.
 */
export function excerpt(text: string, max: number): { text: string; cut: boolean } {
  if (estimateTokens(text) <= max) return { text, cut: false };
  const room = Math.max(0, max - MARKER_MAX);
  const headRoom = Math.floor((room * 2) / 3);
  // Segmenting only what can fit: no text has fewer bytes than characters (UTF-16 units count at most 3 bytes each, one each at least).
  const head = text.slice(0, Math.min(text.length, headRoom + 1));
  const h = fitStart(head, headRoom);
  const tailRoom = room - estimateTokens(text.slice(0, h));
  const from = Math.max(h, text.length - tailRoom - 1);
  const tail = text.slice(from);
  const t = from + fitEnd(tail, tailRoom);
  // A slice edge can split a surrogate pair; a lone half is never kept (fitStart and fitEnd only take whole segments
  // inside the slice, and the slice's own edge segment fits only when the slice is the whole text).
  const kept = text.slice(0, h).trimEnd();
  const end = text.slice(t).trimStart();
  const left = [...text.slice(h, t)].length;
  return { text: `${kept}${excerptMarker(left)}${end}`.trim(), cut: true };
}

/** One message as the replay would give it: its line, and whether it is an excerpt. */
export interface ReplayLine {
  seq: number;
  at: string;
  /** Another Boton's message, in its own block. */
  boton: boolean;
  line: string;
  cut: boolean;
  pinned: boolean;
  routine: boolean;
}

export interface ReplayPick {
  /** In chat order. */
  lines: ReplayLine[];
  /** Pinned messages older than the oldest recent message kept: given apart, ahead of the rest. */
  earlierPins: ReplayLine[];
  /** Messages newer than the reset that there was no room for (pins apart): the rest was not read. */
  leftOut: boolean;
  pinsLeftOut: number;
  used: number;
}

/**
 * Picks what fits in `room`: the pins first (newest first: the oldest is the one left out if even they don't fit,
 * which the limits make impossible, and is counted if it ever happens), then routine messages up to their share,
 * then the chat, stopping at the first that doesn't fit so no gap opens in the middle. Each line's newline counts.
 * `chat` and `routines` come newest first and are read only as far as they fit: every line costs at least its
 * head, so the budget bounds how many are read, whatever the size of the history.
 */
export function pickReplay(pins: ReplayLine[], chat: Iterable<ReplayLine>, routines: Iterable<ReplayLine>, room: number): ReplayPick {
  const cost = (l: ReplayLine) => estimateTokens(l.line) + 1;
  let used = 0;
  const keptPins: ReplayLine[] = [];
  let pinsLeftOut = 0;
  for (const p of [...pins].sort((a, b) => b.seq - a.seq)) {
    if (used + cost(p) <= room) {
      keptPins.push(p);
      used += cost(p);
    } else pinsLeftOut++;
  }
  const pinSeqs = new Set(pins.map((p) => p.seq));
  const take = (list: Iterable<ReplayLine>, limit: number) => {
    const out: ReplayLine[] = [];
    let spent = 0;
    let rest = false;
    for (const l of list) {
      if (pinSeqs.has(l.seq)) continue;
      if (spent + cost(l) > limit) {
        rest = true;
        break;
      }
      out.push(l);
      spent += cost(l);
    }
    used += spent;
    return { out, rest };
  };
  const r = take(routines, Math.min(ROUTINE_SHARE, room - used));
  const c = take(chat, room - used);
  const oldest = c.out.length ? Math.min(...c.out.map((l) => l.seq)) : Infinity;
  const earlierPins = keptPins.filter((p) => p.seq < oldest).sort((a, b) => a.seq - b.seq);
  const lines = [...c.out, ...r.out, ...keptPins.filter((p) => p.seq >= oldest)].sort((a, b) => a.seq - b.seq);
  return { lines, earlierPins, leftOut: c.rest || r.rest, pinsLeftOut, used };
}
