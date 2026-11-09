import { type BrowserHandoff, type HandoffEvent, handBackNote, handoffOpen, handoffReason, handoffStep, handoffWaiting, requestHandoff } from '../../shared/handoff.ts';
import type { Message } from '../../shared/types.ts';
import { log } from './log.ts';
import type { PushRequest } from './notify.ts';
import { HttpError, type Store } from './store.ts';
import { nowIso } from './util.ts';

/*
 * The handoff cards (shared/handoff.ts) as the server keeps them: a `browser.handoff` chat event whose meta holds the
 * record, changed only through Store.setHandoff (from one state to the next), so the chat updates live. browser.ts
 * says when the owner takes the browser over and when that ends; this says what the card and the Boton make of it.
 * Nothing here opens or drives a browser, and nothing here sees what the owner does in it.
 */

export interface HandoffDeps {
  store: Store;
  /** A push for the owner (Notifier.push), best effort. */
  push?: (req: PushRequest) => Promise<unknown>;
  /** Starts the Boton's turn on its pending messages. */
  wake: (botId: string) => void;
}

const handoffOf = (m: Message): BrowserHandoff | null => (m.meta?.kind === 'browser.handoff' ? (m.meta.browserHandoff ?? null) : null);

export class BrowserHandoffs {
  #deps: HandoffDeps;

  constructor(deps: HandoffDeps) {
    this.#deps = deps;
  }

  /** The step `e` on card `m`, if it can happen from where it stands now (another change got there first: null). */
  #step(m: Message, e: HandoffEvent): Message | null {
    const h = handoffOf(m);
    if (!h) return null;
    const next = handoffStep(h, e);
    return next ? this.#deps.store.setHandoff(m.id, h.state, next) : null;
  }

  /** The Boton's open handoff (requested and waiting, or taken), if any. Requests past their expiry found on the way are closed. */
  open(botId: string): Message | null {
    const now = nowIso();
    let found: Message | null = null;
    for (const m of this.#deps.store.openHandoffs(botId)) {
      const h = handoffOf(m)!;
      if (!handoffOpen(h, now)) this.#step(m, { type: 'close', at: now, why: 'nobody took it in time' });
      else found ??= m;
    }
    return found;
  }

  /**
   * The Boton asks (browser_handoff, from its running turn). `url` is where its browser is (origin and path only);
   * `takenBy` names the device when the owner already has the browser, so the card starts taken. A second ask while
   * one waits replaces it (the newer reason is the one that counts); one already taken is answered with that one.
   */
  request(botId: string, rawReason: unknown, url: string | null, takenBy: string | null): { message: Message; already: 'taken' | null } {
    const reason = handoffReason(rawReason);
    if (typeof reason !== 'string') throw new HttpError(400, reason.why);
    const now = nowIso();
    const current = this.open(botId);
    if (current && handoffOf(current)!.state === 'taken') return { message: current, already: 'taken' };
    if (current) this.#step(current, { type: 'close', at: now, why: 'the Boton asked again' });
    const store = this.#deps.store;
    const bot = store.getBot(botId);
    let message = store.addMessage(botId, 'event', `Your turn in ${bot.name}'s browser: ${reason}`, { kind: 'browser.handoff', browserHandoff: requestHandoff(reason, url, new Date()) });
    if (takenBy) message = this.#step(message, { type: 'take', at: nowIso(), by: takenBy }) ?? message;
    log.info('browser handoff requested', { botId, handoffId: message.id, taken: !!takenBy || undefined });
    if (!takenBy) {
      void this.#deps
        .push?.({ bot: { id: bot.id, name: bot.name }, reason: 'approval', detail: `Your turn in ${bot.name}'s browser: ${reason}`, generic: `Your turn in ${bot.name}'s browser.`, priority: 'high' })
        ?.catch((err) => log.warn('could not push a browser handoff', { botId, err }));
    }
    return { message, already: null };
  }

  /** The owner took the browser over (from the card, the chat header or Settings): a waiting request is taken. */
  taken(botId: string, by: string): void {
    const m = this.open(botId);
    if (m && handoffWaiting(handoffOf(m)!, nowIso())) this.#step(m, { type: 'take', at: nowIso(), by });
  }

  /**
   * The handover ended (`how`: `finished` when the owner handed it back): a taken handoff is handed back, with where the
   * page is (origin and path only), and the Boton is woken with a note saying so. False if there was none.
   */
  handedBack(botId: string, page: string | null, how: string): boolean {
    const m = this.open(botId);
    if (!m || handoffOf(m)!.state !== 'taken') return false;
    const done = this.#step(m, { type: 'hand-back', at: nowIso(), page, how });
    if (!done) return false;
    const store = this.#deps.store;
    if (!store.hasBot(botId)) return true;
    const note = handBackNote(store.getSettings().ownerName, handoffOf(done)!);
    store.addMessage(botId, 'user', note, { kind: 'browser.handed_back', handoffId: m.id }, true);
    log.info('browser handoff handed back', { botId, handoffId: m.id, how });
    this.#deps.wake(botId);
    return true;
  }

  /** The Boton's browser was turned off (or the Boton is going): a request still waiting can't be taken any more. */
  closeWaiting(botId: string, why: string): void {
    const m = this.open(botId);
    if (m && handoffOf(m)!.state === 'requested') this.#step(m, { type: 'close', at: nowIso(), why });
  }

  /**
   * At start: a handover never outlives the server, so a handoff still taken was handed back by the stop (each Boton is
   * told), and requests past their expiry are closed.
   */
  recover(): void {
    const now = nowIso();
    for (const m of this.#deps.store.openHandoffs(null)) {
      const h = handoffOf(m)!;
      if (h.state === 'taken') this.handedBack(m.botId, null, 'the server restarted');
      else if (!handoffWaiting(h, now)) this.#step(m, { type: 'close', at: now, why: 'nobody took it in time' });
    }
  }
}
