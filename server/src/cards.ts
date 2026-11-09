import {
  answerText,
  type CardAnswer,
  type CardBlock,
  type CardDescriptor,
  CardError,
  interactiveBlock,
  parseAnswer,
  parseCard,
  type TranscriptCard,
} from '../../shared/cards.ts';
import type { ApprovalOrigin, Message } from '../../shared/types.ts';
import type { Audit } from './audit.ts';
import type { Principal } from './auth.ts';
import { formatDuration, parseDuration } from './config.ts';
import type { Connectors } from './connectors.ts';
import { fileRef, resolveInWorkspace } from './files.ts';
import { RunLimiter } from './limits.ts';
import { log } from './log.ts';
import { HttpError, type Store } from './store.ts';
import { nowIso } from './util.ts';

/*
 * Transcript cards (shared/cards.ts): a Boton posts one with `botons card post`, the owner answers it in the chat.
 * A card is a chat event whose meta holds the checked card and its state (Message.meta.card); the message is its
 * one record, so there is no other table to keep in step. Every answer is checked here against the card as saved:
 * the client sends only which option, which values or which button, never what it means. A connector card's button
 * is the same grant as the connector's own request (on request, at the policy generation the card was posted
 * under, checked again at the click) and is audited as the same permission change Settings records.
 */

const TTL_MS = 24 * 3_600_000;
const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 7 * 24 * 3_600_000;
const PENDING_MAX = 10;
const POSTS_PER_HOUR = 30;

const NO_TURN: ApprovalOrigin = { trigger: 'chat', turnId: null, routineId: null, routineName: null, runId: null, sandboxed: false, askedBy: [] };

const pastTense: Record<TranscriptCard['status'], string> = {
  shown: 'shown (it has nothing to answer)',
  pending: 'waiting',
  answered: 'answered',
  declined: 'declined',
  expired: 'expired',
  refused: 'closed',
};

const bad = (err: unknown): never => {
  if (err instanceof CardError) throw new HttpError(400, err.message);
  throw err;
};

export class Cards {
  #store: Store;
  #connectors: Connectors;
  #audit: Audit;
  #wake: (botId: string) => void;
  #origin: (botId: string) => ApprovalOrigin | null;
  /** In memory: a restart resets it. */
  #limiter = new RunLimiter(POSTS_PER_HOUR, Number.MAX_SAFE_INTEGER);

  constructor(opts: { store: Store; connectors: Connectors; audit: Audit; wake: (botId: string) => void; origin: (botId: string) => ApprovalOrigin | null }) {
    this.#store = opts.store;
    this.#connectors = opts.connectors;
    this.#audit = opts.audit;
    this.#wake = opts.wake;
    this.#origin = opts.origin;
  }

  /** The Boton a card belongs to, or null (for route access: a Boton reads only its own). */
  owner(id: string): string | null {
    const m = this.#store.findMessage(id);
    return m?.meta?.kind === 'card.posted' ? m.botId : null;
  }

  /** The card's message as it stands now; one past its expiry is closed as expired first. */
  get(id: string, botId?: string): Message {
    const m = this.#store.findMessage(id);
    if (!m || m.role !== 'event' || m.meta?.kind !== 'card.posted' || !m.meta.card || (botId && m.botId !== botId)) throw new HttpError(404, `No card ${id}`);
    const card = m.meta.card;
    if (card.status === 'pending' && card.expiresAt <= nowIso()) return this.#store.closeCard(m.id, { ...card, status: 'expired' }) ?? this.get(id, botId);
    return m;
  }

  /** `botons card post`, from Boton `botId`'s turn token. Body: `{ card, expiresIn? }`. */
  async post(botId: string, body: unknown, opts: { sandboxed: boolean }): Promise<{ message: Message; duplicate: boolean }> {
    const bot = this.#store.getBot(botId);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'The body must be {"card": {...}, "expiresIn": "1d"}');
    const extra = Object.keys(body).find((k) => k !== 'card' && k !== 'expiresIn');
    if (extra) throw new HttpError(400, `Unknown field "${extra}" (the body has card and expiresIn)`);
    const { card: raw, expiresIn } = body as { card?: unknown; expiresIn?: unknown };
    let descriptor: CardDescriptor;
    try {
      descriptor = parseCard(raw);
    } catch (err) {
      return bad(err);
    }
    const ttl = expiresIn === undefined || expiresIn === null || expiresIn === '' ? TTL_MS : typeof expiresIn === 'string' ? parseDuration(expiresIn) : Number.NaN;
    if (Number.isNaN(ttl)) throw new HttpError(400, 'expiresIn must be a duration such as "30m", "2h" or "3d"');
    if (ttl < TTL_MIN_MS || ttl > TTL_MAX_MS) throw new HttpError(400, `expiresIn must be between ${formatDuration(TTL_MIN_MS)} and ${formatDuration(TTL_MAX_MS)}`);

    const turn = this.#origin(botId) ?? NO_TURN;
    const from = { trigger: turn.trigger, routineId: turn.routineId, routineName: turn.routineName, runId: turn.runId, sandboxed: opts.sandboxed || turn.sandboxed };

    // Files: only regular files in the Boton's workspace, by the path the server resolved.
    const blocks: CardBlock[] = [];
    for (const b of descriptor.blocks) {
      if (b.type !== 'file') {
        blocks.push(b);
        continue;
      }
      const found = await resolveInWorkspace(bot.workspace, b.path);
      if (!found.stat.isFile()) throw new HttpError(400, `${b.path} is not a file in your workspace`);
      blocks.push({ ...b, path: fileRef(found).path });
    }
    descriptor = { ...descriptor, blocks };

    const ask = interactiveBlock(descriptor);
    let connector: TranscriptCard['connector'];
    if (ask?.type === 'connector') {
      // A payload from outside must not ask to widen what later turns can reach.
      if (from.sandboxed) throw new HttpError(403, "A webhook run can't post a connector card: it would widen what your later turns can reach");
      if (bot.connections.includes(ask.connectorId)) throw new HttpError(400, `${ask.connectorId} is already one of your connectors`);
      const problem = this.#connectors.grantProblem(bot, ask.connectorId, 'now', { usable: true });
      if (problem) throw new HttpError(problem.startsWith('There is no') ? 404 : 403, `${problem}. See \`botons connector list\`: a card asks only for one you may ask for.`);
      const c = this.#connectors.catalog().connectors.find((x) => x.id === ask.connectorId)!;
      connector = { id: c.id, name: c.name, generation: this.#connectors.policyOf(c.id).generation };
    }

    const now = nowIso();
    if (ask) {
      const same = this.#store.samePendingCard(botId, JSON.stringify(descriptor), now);
      if (same) return { message: same, duplicate: true };
      if (this.#store.pendingCards(botId, now) >= PENDING_MAX) {
        throw new HttpError(409, `You already have ${PENDING_MAX} cards waiting for ${this.#store.getSettings().ownerName}'s answer. Wait for their answers, or let them expire.`);
      }
    }
    const hit = this.#limiter.check(botId);
    if (hit) throw new HttpError(429, `At most ${POSTS_PER_HOUR} cards an hour: try again in ${formatDuration(hit.retryAfterMs)}`);
    this.#limiter.record(botId);

    const card: TranscriptCard = {
      descriptor,
      status: ask ? 'pending' : 'shown',
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      from,
      ...(connector ? { connector } : {}),
    };
    const run = from.routineId ? { routineId: from.routineId, ...(from.routineName ? { routineName: from.routineName } : {}), ...(from.runId ? { runId: from.runId } : {}) } : {};
    const message = this.#store.addMessage(botId, 'event', `Posted a card: ${descriptor.title}`, { kind: 'card.posted', card, ...run });
    log.info('card posted', { botId, cardId: message.id, ask: ask?.type ?? 'none', sandboxed: from.sandboxed || undefined, trigger: from.trigger });
    return { message, duplicate: false };
  }

  /** The owner's answer (the route takes only paired devices). Returns the card's message as it is now. */
  answer(botId: string, id: string, input: unknown, principal: Principal | null): Message {
    const m = this.get(id, botId);
    const card = m.meta!.card!;
    if (card.status !== 'pending') throw new HttpError(409, `This card was already ${pastTense[card.status]}`);
    let answer: ReturnType<typeof parseAnswer>;
    try {
      answer = parseAnswer(card.descriptor, input);
    } catch (err) {
      return bad(err);
    }
    const deviceId = principal?.kind === 'device' ? principal.deviceId : null;
    const at = nowIso();
    const record: CardAnswer = { action: answer.action, at, by: deviceId };
    const ask = interactiveBlock(card.descriptor)!;
    if (answer.action === 'choose' && ask.type === 'choice') record.option = ask.options.find((o) => o.id === answer.option)!;
    if (answer.action === 'submit') record.values = answer.values;

    // One transaction: the check of the connector (its policy generation, its sign-in, the Boton's brain and room),
    // the card's one change, the grant with its turn, and both audit rows (required: either one failing undoes all of
    // it, and the card still waits). Chat events go out and the Boton is woken only once it has committed.
    const status = answer.action === 'decline' ? 'declined' : 'answered';
    const done = this.#store.atomically((): { problem: string } | { closed: Message } => {
      let granted = false;
      if (answer.action === 'grant') {
        const c = card.connector!;
        const bot = this.#store.getBot(botId);
        if (bot.connections.includes(c.id)) record.result = 'already';
        else {
          const problem = card.from.sandboxed ? 'A webhook run posted this card' : this.#connectors.grantProblem(bot, c.id, c.generation, { usable: true });
          if (problem) return { problem };
          record.result = 'granted';
          granted = true;
        }
      }
      const closed = this.#store.closeCard(id, { ...card, status, answer: record });
      if (!closed) throw new HttpError(409, 'This card was already answered');
      if (granted) {
        const bot = this.#store.getBot(botId);
        this.#store.setConnections(botId, [...bot.connections, card.connector!.id]);
        // The connector's own follow-up turn (engine.ts grantedPrompt), as a request granted on a card gets.
        this.#store.addMessage(botId, 'user', `Connector ${card.connector!.name} added`, { kind: 'connector.granted', connectorId: card.connector!.id, cardId: id }, true);
        // The same record a change in Settings makes, so the connector's and the Boton's history show it.
        this.#audit.require(principal, {
          action: 'boton.permissions_changed',
          target: { kind: 'boton', id: botId, label: bot.name },
          details: { connectionsAdded: [card.connector!.id], via: 'card', card: id },
        });
      } else {
        // A pending user message: it starts the Boton's turn with the answer, and waits out a pause or a usage limit.
        this.#store.addMessage(botId, 'user', answerText(card.descriptor, record), { kind: 'card.answered', cardId: id }, true);
      }
      this.#audited(principal, m, card, answer.action, record.result ?? status, record);
      return { closed };
    });
    if ('problem' in done) {
      // Closed for good, with the reason, and nothing given: no grant, no turn. Its audit row is required too: if it
      // can't be written the card still waits (and the answer fails), so a refusal is never unrecorded.
      this.#store.atomically(() => {
        if (!this.#store.closeCard(id, { ...card, status: 'refused', reason: done.problem })) throw new HttpError(409, 'This card was already answered');
        this.#audited(principal, m, card, 'grant', 'refused');
      });
      throw new HttpError(409, `${done.problem}, so nothing was given and the card is closed.`);
    }
    log.info('card answered', { botId, cardId: id, action: answer.action, result: record.result, deviceId: deviceId ?? undefined });
    this.#wake(botId);
    return done.closed;
  }

  /**
   * Which card, what was pressed and how it ended: never the values typed (they are in the chat, not the log).
   * Required, inside the answer's transaction: should it fail, the card is not answered, refused or granted.
   */
  #audited(principal: Principal | null, m: Message, card: TranscriptCard, action: string, result: string, answer?: CardAnswer) {
    this.#audit.require(principal, {
      action: 'card.answered',
      target: { kind: 'card', id: m.id, label: card.descriptor.title },
      details: {
        boton: m.botId,
        answer: action,
        result,
        ...(answer?.option ? { option: answer.option.id } : {}),
        ...(answer?.values ? { fields: Object.keys(answer.values) } : {}),
        ...(card.connector ? { connector: card.connector.id, connectorName: card.connector.name } : {}),
      },
    });
  }
}
