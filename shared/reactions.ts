// Emoji reactions on chat messages: what counts as one, and the defaults. The server checks every reaction with
// reactionEmoji; the web app uses the same lists for its picker.

/** The quick-pick row the app offers on a message. */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

/** The owner's reactions that start a short follow-up turn until they choose others: 👎 alone. */
export const DEFAULT_REACTION_FOLLOW_UPS: readonly string[] = ['👎'];

/** At most this many emoji start a follow-up turn. */
export const REACTION_FOLLOW_UP_MAX = 12;

/** At most this many different emoji of the owner's on one message. */
export const OWNER_REACTION_MAX = 10;

/** What a follow-up turn is asked to do for the reactions whose meaning is set; any other gets a general request. */
export const REACTION_MEANINGS: Readonly<Record<string, string>> = {
  '👎': 'that was wrong or not what they wanted: reconsider it',
  '😕': 'something about it is off or unclear: reconsider it, or ask what was off',
  '❓': 'they want it explained',
};

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;
const PRESENTATION = /^\p{Emoji_Presentation}$/u;

/**
 * The emoji as stored, or null when `input` isn't one: exactly one emoji (a single grapheme that is a pictograph, a
 * flag or a keycap, with no text). A lone symbol that has a text form, such as ❤, is stored with its emoji
 * presentation (❤️), so both spellings are one reaction.
 */
export function reactionEmoji(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const e = input.trim().normalize('NFC');
  if (!e || e.length > 32) return null;
  if ([...graphemes.segment(e)].length !== 1) return null;
  if (KEYCAP.test(e)) return e.replace(/️?⃣$/u, '️⃣');
  if (!PICTOGRAPHIC.test(e) || /[\p{L}\p{N}\p{P}\p{Cc}\p{Zs}<>]/u.test(e)) return null;
  const bare = e.replace(/️$/u, '');
  if ([...bare].length === 1) return PRESENTATION.test(bare) ? bare : `${bare}️`;
  return e;
}
