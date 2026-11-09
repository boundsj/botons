import { OWNER_REACTION_MAX, reactionEmoji } from '../../shared/reactions.ts';
import { currentName } from '../../shared/legacy-names.mjs';
import type { Message, ReactionActor, ReactionImportResult, ReactionTransfer, ReactionTransferEntry } from '../../shared/types.ts';
import type { Principal } from './auth.ts';
import { RunLimiter } from './limits.ts';
import { log } from './log.ts';
import { HttpError, type Store } from './store.ts';
import { nowIso, type Row } from './util.ts';

/*
 * Emoji reactions on chat messages (the message_reactions table; schema.ts). The owner reacts to the Boton's
 * messages from a paired device, and the Boton to the owner's own messages in its chat, during a turn that may change
 * what its later turns know (not a sandboxed one). A reaction is feedback only: it is never read by approvals or
 * cards, can't be put on an approval or card event, and pushes nothing. An owner's reaction reaches the Boton in the
 * context of its next chat turn; one of the owner's follow-up reactions (Settings.reactionFollowUps) also starts a
 * short follow-up turn, at most once per message and emoji, never when one is taken off.
 */

/** A Boton's reactions added or taken off in an hour, at most; the owner's aren't limited. */
const BOTON_CHANGES_PER_HOUR = 60;
/** The owner's reactions not yet told, given to a turn at most. */
const FEEDBACK_MAX = 20;
const EXCERPT_CHARS = 160;

/** An owner's reaction the Boton hasn't been given yet, with the start of the message it is on. */
export interface Feedback {
  messageId: string;
  emoji: string;
  at: string;
  excerpt: string;
}

export const excerptOf = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
};

/** A message only the owner wrote (not another Boton's, nor one the server posted for them), in the owner's turn. */
export const ownersOwn = (m: Message) => m.role === 'user' && !m.meta?.fromBotId && !m.meta?.kind;

export class Reactions {
  #store: Store;
  #wake: (botId: string) => void;
  #limiter = new RunLimiter(BOTON_CHANGES_PER_HOUR, Number.MAX_SAFE_INTEGER);

  constructor(deps: { store: Store; wake: (botId: string) => void }) {
    this.#store = deps.store;
    this.#wake = deps.wake;
  }

  #all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.#store.db.prepare(sql).all(...params) as Row[];
  }
  #run(sql: string, ...params: (string | number | null)[]) {
    return this.#store.db.prepare(sql).run(...params);
  }

  /** Who reacts for this principal: the owner's devices, or the Boton whose chat it is (the route checked which). */
  #actor(principal: Principal | null): ReactionActor {
    return principal?.kind === 'boton' ? 'boton' : 'owner';
  }

  #message(botId: string, messageId: string): Message {
    this.#store.getBot(botId);
    const m = this.#store.findMessage(messageId);
    if (!m || m.botId !== botId) throw new HttpError(404, `No message ${messageId} in this chat`);
    return m;
  }

  #emoji(v: unknown): string {
    const e = reactionEmoji(v);
    if (!e) throw new HttpError(400, 'emoji must be one emoji, such as 👍');
    return e;
  }

  #limit(principal: Principal | null) {
    if (principal?.kind !== 'boton') return;
    if (this.#limiter.check(principal.botId)) throw new HttpError(429, `At most ${BOTON_CHANGES_PER_HOUR} reactions an hour: react only where a reaction says it all`);
    this.#limiter.record(principal.botId);
  }

  /** Checks who may put a reaction on `m`; throws with why not. */
  #mayReact(m: Message, actor: ReactionActor): void {
    const owner = this.#store.getSettings().ownerName;
    if (actor === 'owner' && m.role !== 'bot') {
      throw new HttpError(400, `Only the Boton's messages take reactions${m.role === 'event' ? ': an approval or a card is decided with its own buttons, never with a reaction' : ''}`);
    }
    if (actor === 'boton' && !ownersOwn(m)) throw new HttpError(400, `You can react only to ${owner}'s own messages in your chat, not to your own, another Boton's or the server's`);
  }

  /** Adds a reaction (again is no change); answers with the message as it is now. */
  react(botId: string, messageId: string, emojiInput: unknown, principal: Principal | null): Message {
    const actor = this.#actor(principal);
    const emoji = this.#emoji(emojiInput);
    let wake = false;
    const out = this.#store.atomically(() => {
      const m = this.#message(botId, messageId);
      this.#mayReact(m, actor);
      const mine = (m.reactions ?? []).filter((r) => r.by === actor);
      if (mine.some((r) => r.emoji === emoji)) return m;
      if (actor === 'boton' && mine.length) {
        throw new HttpError(409, `You already reacted ${mine[0].emoji} to this message, and one reaction is the most: take it off with \`botons unreact ${messageId}\` first to change it`);
      }
      if (actor === 'owner' && mine.length >= OWNER_REACTION_MAX) throw new HttpError(409, `At most ${OWNER_REACTION_MAX} reactions on one message: take one off first`);
      this.#limit(principal);
      const at = nowIso();
      this.#run('insert into message_reactions (message_id, bot_id, actor, emoji, created_at) values (?, ?, ?, ?, ?)', messageId, botId, actor, emoji, at);
      if (actor === 'owner') wake = this.#followUp(m, emoji, at);
      const updated = this.#store.findMessage(messageId)!;
      this.#store.publish({ type: 'message.updated', message: updated });
      return updated;
    });
    log.info('reaction added', { botId, messageId, by: actor, followUp: wake || undefined });
    if (wake) this.#wake(botId);
    return out;
  }

  /**
   * A follow-up turn for one of the owner's follow-up reactions, the first time it is put on this message: a pending
   * message the turn answers (engine.ts gives it as the reaction's request), which carries the reaction, so it is
   * marked told. True if one was added.
   */
  #followUp(m: Message, emoji: string, at: string): boolean {
    if (!this.#store.getSettings().reactionFollowUps.includes(emoji)) return false;
    if (!Number(this.#run('insert or ignore into reaction_followups (message_id, emoji, at) values (?, ?, ?)', m.id, emoji, at).changes)) return false;
    this.#run("update message_reactions set told_at = ? where message_id = ? and actor = 'owner' and emoji = ?", at, m.id, emoji);
    this.#store.addMessage(m.botId, 'user', `Reacted ${emoji} to a message`, { kind: 'reaction.followup', reactionTo: m.id, emoji }, true);
    return true;
  }

  /**
   * Takes a reaction off: the given emoji, or (no emoji) the actor's every one. A follow-up the reaction asked for
   * that hasn't started is withdrawn; one that has runs on. Answers with the message as it is now.
   */
  unreact(botId: string, messageId: string, emojiInput: unknown, principal: Principal | null): Message {
    const actor = this.#actor(principal);
    const emoji = emojiInput === undefined || emojiInput === null || emojiInput === '' ? null : this.#emoji(emojiInput);
    return this.#store.atomically(() => {
      const m = this.#message(botId, messageId);
      const gone = (m.reactions ?? []).filter((r) => r.by === actor && (emoji === null || r.emoji === emoji));
      if (!gone.length) return m;
      this.#limit(principal);
      for (const r of gone) this.#run('delete from message_reactions where message_id = ? and actor = ? and emoji = ?', messageId, actor, r.emoji);
      if (actor === 'owner') for (const r of gone) this.#withdraw(m, r.emoji);
      const updated = this.#store.findMessage(messageId)!;
      this.#store.publish({ type: 'message.updated', message: updated });
      log.info('reaction removed', { botId, messageId, by: actor });
      return updated;
    });
  }

  /** The follow-up for this reaction, if it is still waiting (pending 1: not in flight), answered without a turn. */
  #withdraw(m: Message, emoji: string): void {
    const rows = this.#all(
      `select id from messages where bot_id = ? and role = 'user' and pending = 1 and json_extract(meta, '$.kind') = 'reaction.followup'
         and json_extract(meta, '$.reactionTo') = ? and json_extract(meta, '$.emoji') = ?`,
      m.botId,
      m.id,
      emoji,
    );
    for (const r of rows) {
      this.#run("update messages set pending = 0, meta = json_set(meta, '$.withdrawn', json('true')) where id = ?", r.id);
      this.#store.publish({ type: 'message.updated', message: this.#store.findMessage(String(r.id))! });
    }
  }

  /** The owner's reactions this Boton hasn't been given yet, oldest first (the newest FEEDBACK_MAX). */
  feedback(botId: string): Feedback[] {
    return this.#all(
      `select r.message_id, r.emoji, r.created_at, m.text from message_reactions r join messages m on m.id = r.message_id
         where r.bot_id = ? and r.actor = 'owner' and r.told_at is null order by r.created_at desc, r.rowid desc limit ?`,
      botId,
      FEEDBACK_MAX,
    )
      .reverse()
      .map((r) => ({ messageId: String(r.message_id), emoji: String(r.emoji), at: String(r.created_at), excerpt: excerptOf(String(r.text)) }));
  }

  /** After a turn that was given them ended with its reply: not given again (one taken off since is gone already). */
  markTold(given: Feedback[]): void {
    const at = nowIso();
    for (const f of given) this.#run("update message_reactions set told_at = ? where message_id = ? and actor = 'owner' and emoji = ? and told_at is null", at, f.messageId, f.emoji);
  }

  /** Which of `ids` the Boton put a reaction on since `since` (its turn's start). */
  botonReactedTo(botId: string, ids: string[], since: string): Set<string> {
    if (!ids.length) return new Set();
    const rows = this.#all(
      `select distinct message_id from message_reactions where bot_id = ? and actor = 'boton' and created_at >= ? and message_id in (${ids.map(() => '?').join(', ')})`,
      botId,
      since,
      ...ids,
    );
    return new Set(rows.map((r) => String(r.message_id)));
  }

  // ------------------------------------------------------------------ export and import

  export(): ReactionTransfer {
    const reactions = this.#all('select message_id, bot_id, actor, emoji, created_at from message_reactions order by created_at, rowid').map((r) => ({
      messageId: String(r.message_id),
      botId: String(r.bot_id),
      by: r.actor as ReactionActor,
      emoji: String(r.emoji),
      at: String(r.created_at),
    }));
    return { format: 'botons-reactions', version: 1, exportedAt: nowIso(), reactions };
  }

  /** All of it, or nothing if any entry is wrong: see ReactionTransfer. */
  import(input: unknown): ReactionImportResult {
    const entries = transferEntries(input);
    return this.#store.atomically(() => {
      const byMessage = new Map<string, ReactionTransferEntry[]>();
      for (const e of entries) byMessage.set(e.messageId, [...(byMessage.get(e.messageId) ?? []), e]);
      const skipped: string[] = [];
      const told = nowIso();
      let imported = 0;
      const changed: string[] = [];
      for (const [messageId, list] of byMessage) {
        const m = this.#store.findMessage(messageId);
        if (!m || list.some((e) => e.botId !== m.botId)) {
          skipped.push(messageId);
          continue;
        }
        const seen = new Set<string>();
        const keep = list.filter((e) => !seen.has(`${e.by} ${e.emoji}`) && seen.add(`${e.by} ${e.emoji}`));
        for (const by of ['owner', 'boton'] as const) if (keep.some((e) => e.by === by)) this.#mayReact(m, by);
        if (keep.filter((e) => e.by === 'boton').length > 1) throw new HttpError(400, `Message ${messageId}: the Boton has one reaction at most`);
        if (keep.filter((e) => e.by === 'owner').length > OWNER_REACTION_MAX) throw new HttpError(400, `Message ${messageId}: at most ${OWNER_REACTION_MAX} reactions of the owner's`);
        // An owner's reaction the file doesn't keep is taken off: its waiting follow-up is withdrawn, as by unreact.
        const kept = new Set(keep.filter((e) => e.by === 'owner').map((e) => e.emoji));
        for (const r of m.reactions ?? []) if (r.by === 'owner' && !kept.has(r.emoji)) this.#withdraw(m, r.emoji);
        this.#run('delete from message_reactions where message_id = ?', messageId);
        // Not new feedback: the Boton isn't told of them as if they were just added, and no follow-up starts.
        for (const e of keep) {
          this.#run('insert into message_reactions (message_id, bot_id, actor, emoji, created_at, told_at) values (?, ?, ?, ?, ?, ?)', messageId, m.botId, e.by, e.emoji, e.at, told);
        }
        imported += keep.length;
        changed.push(messageId);
      }
      for (const id of changed) this.#store.publish({ type: 'message.updated', message: this.#store.findMessage(id)! });
      log.info('reactions imported', { imported, messages: changed.length, skipped: skipped.length });
      return { imported, skipped };
    });
  }
}

function transferEntries(v: unknown): ReactionTransferEntry[] {
  const t = v as Partial<ReactionTransfer> | null;
  // A file exported under the deprecated format and actor names reads the same (shared/legacy-names.mjs).
  if (typeof t !== 'object' || t === null || Array.isArray(t) || currentName(String(t.format)) !== 'botons-reactions') throw new HttpError(400, 'Not a reactions file (format must be "botons-reactions")');
  if (t.version !== 1) throw new HttpError(400, `This server reads reactions files of version 1, not ${JSON.stringify(t.version)}`);
  if (!Array.isArray(t.reactions)) throw new HttpError(400, 'reactions must be a list');
  return t.reactions.map((x, i) => {
    const e = x && typeof x === 'object' && typeof (x as ReactionTransferEntry).by === 'string' ? { ...(x as ReactionTransferEntry), by: currentName((x as ReactionTransferEntry).by) as ReactionTransferEntry['by'] } : (x as Partial<ReactionTransferEntry> | null);
    const where = `reactions[${i}]`;
    if (typeof e !== 'object' || e === null) throw new HttpError(400, `${where} must be an object`);
    if (typeof e.messageId !== 'string' || !e.messageId || typeof e.botId !== 'string' || !e.botId) throw new HttpError(400, `${where} needs a messageId and a botId`);
    if (e.by !== 'owner' && e.by !== 'boton') throw new HttpError(400, `${where}.by must be "owner" or "boton"`);
    const emoji = reactionEmoji(e.emoji);
    if (!emoji) throw new HttpError(400, `${where}.emoji must be one emoji`);
    if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) throw new HttpError(400, `${where}.at must be a time`);
    return { messageId: e.messageId, botId: e.botId, by: e.by, emoji, at: new Date(e.at).toISOString() };
  });
}
