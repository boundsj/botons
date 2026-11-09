import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SpendingInput, SpendingView } from '../../shared/types.ts';
import { log } from './log.ts';
import { type ModelRate, mostOf, outputFor, round } from './rates.ts';
import { zonedToUtc } from './schedule.ts';
import { HttpError } from './store.ts';

/*
 * Spending caps on API-key turns, kept on Botons' own estimate (rates.ts), never the provider's bill: a Boton may
 * have a daily cap (from midnight in its time zone) and each of its routines a cap per run (all the run's attempts).
 *
 * The account is one row per request to a model, in api_requests, never per turn:
 * - A request's period is the moment it was reserved, just before it was sent (the server's clock, as a UTC instant):
 *   it counts on the day that moment falls in, in the Boton's time zone as it is when the day is read. A turn that
 *   runs past midnight counts its later requests on the new day, and a hold made before midnight stays on its own day.
 *   A day counts every request from its midnight on, with no end: after the clock is set back, requests stamped later
 *   still count on today, never dropped.
 * - Before each request, in one transaction: the caps that apply are read as they are now (a cap added, lowered or
 *   removed since the turn began counts from its next request), and what is left under them; the most the request
 *   can cost (every input token at the dearest input rate, its output cap at the output rate) is written as its row.
 *   If that doesn't fit, its output cap is lowered to fit; if not even a small answer fits, it isn't sent. A request
 *   already sent stays counted however the caps change after.
 * - When its answer comes, the row becomes what its reported tokens cost. A request whose tokens are unknown (the
 *   answer broke off, was stopped, or reported no valid usage) stays held at its most: the provider may have billed
 *   it. One refused before anything was generated is released. A row still reserved when the server starts was the
 *   process's that is gone: it is held, never released.
 * - A model with no known rate can't be kept to a cap: with a cap set, its requests are refused, and so are a capped
 *   Boton's requests on a day (or in a run) that already has one with no known price.
 * The provider's bill can still differ (its rounding, rates changed since rates.ts was checked, tokens Botons can't see);
 * a cap bounds Botons' estimate, not the bill.
 */

export const API_BRAINS = ['anthropic-api', 'openai-api'] as const;
export const MAX_CAP_USD = 100_000;
/** Settled rows older than this go (no cap looks back further than a run). */
const KEEP_DAYS = 400;

export const SPEND_RULES =
  'Caps count Botons’ own estimate of API-key requests (the tokens each answer reports times the published rates), not your provider’s bill. Each request counts on the day it was sent. Before each one the most it could cost is set aside, under the caps as they are then; it is sent only if that fits in what is left. A request whose answer was cut off or stopped stays counted at that most. A change to a cap applies from the next request; one already sent stays counted. Requests on a model with no known price don’t run while a cap is set.';

const capKey = (kind: 'bot' | 'routine', id: string) => `spendCap:${kind}:${id}`;

/** What a row counts: its cost once settled, its most while reserved or held, nothing once released. */
const COUNTED = `case state when 'settled' then coalesce(cost_usd, 0) when 'released' then 0 else coalesce(reserved_usd, 0) end`;
/** A row with no known price that may have been billed. */
const UNPRICED = `case when state != 'released' and reserved_usd is null and cost_usd is null then 1 else 0 end`;

export class CapError extends Error {}

export interface SpendScope {
  botId: string;
  turnId: string;
  runId: string | null;
  routineId: string | null;
}

export interface ReserveAsk {
  provider: string;
  model: string;
  /** null: no known price (then nothing can be set aside, and no cap may apply). */
  rate: ModelRate | null;
  /** At most this many input tokens. */
  inputTokens: number;
  maxOutput: number;
  /** Below this output cap a request isn't worth sending. */
  minOutput: number;
}

/** One request's row. Each of settle, hold and release acts once, and only on a row still reserved. */
export interface Reservation {
  /** The output cap it was reserved at (lowered to fit a cap). */
  maxOutput: number;
  /** What was set aside; null with no known price. */
  usd: number | null;
  settle(usd: number | null): void;
  hold(): void;
  release(): void;
}

export class Spending {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, opts: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date());
    // Reserved by a process that is gone: it may have been sent and billed.
    const n = Number(this.#db.prepare("update api_requests set state = 'held' where state = 'reserved'").run().changes);
    if (n) log.warn('API requests a stopped server left reserved are held at their most', { requests: n });
  }

  #cap(kind: 'bot' | 'routine', id: string | null): number | null {
    if (!id) return null;
    const row = this.#db.prepare('select value from settings where key = ?').get(capKey(kind, id)) as { value: string } | undefined;
    const v = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  #setCap(kind: 'bot' | 'routine', id: string, usd: number | null) {
    if (usd === null) this.#db.prepare('delete from settings where key = ?').run(capKey(kind, id));
    else this.#db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(capKey(kind, id), String(usd));
  }

  /** Midnight of `now`'s day in `tz`, as an ISO time (rows' `at` compare as text). */
  dayStart(tz: string, now = this.#now()): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return zonedToUtc(get('year'), get('month'), get('day'), 0, 0, tz).toISOString();
  }

  #today(botId: string): { spent: number; unpriced: number; since: string } {
    const since = this.dayStart(this.#timezone(botId));
    const r = this.#db.prepare(`select coalesce(sum(${COUNTED}), 0) as spent, coalesce(sum(${UNPRICED}), 0) as unpriced from api_requests where bot_id = ? and at >= ?`).get(botId, since) as {
      spent: number;
      unpriced: number;
    };
    return { spent: round(Number(r.spent)), unpriced: Number(r.unpriced), since };
  }

  #run(runId: string): { spent: number; unpriced: number } {
    const r = this.#db.prepare(`select coalesce(sum(${COUNTED}), 0) as spent, coalesce(sum(${UNPRICED}), 0) as unpriced from api_requests where run_id = ?`).get(runId) as { spent: number; unpriced: number };
    return { spent: round(Number(r.spent)), unpriced: Number(r.unpriced) };
  }

  #timezone(botId: string): string {
    const r = this.#db.prepare('select timezone from bots where id = ?').get(botId) as { timezone: string } | undefined;
    return r?.timezone || 'UTC';
  }

  view(botId: string): SpendingView {
    const today = this.#today(botId);
    const routines = this.#db.prepare('select id, name from routines where bot_id = ? order by created_at').all(botId) as { id: string; name: string }[];
    return {
      botId,
      dailyCapUsd: this.#cap('bot', botId),
      spentTodayUsd: today.spent,
      unpricedToday: today.unpriced,
      dayStartedAt: today.since,
      routines: routines.map((x) => ({ id: String(x.id), name: String(x.name), perRunCapUsd: this.#cap('routine', String(x.id)) })),
      rules: SPEND_RULES,
    };
  }

  update(botId: string, input: SpendingInput): SpendingView {
    const usd = (v: unknown, field: string): number | null => {
      if (v === null) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_CAP_USD) throw new HttpError(400, `${field} must be a number of US dollars from 0 to ${MAX_CAP_USD}, or null for no cap`);
      return round(v);
    };
    const changes: [kind: 'bot' | 'routine', id: string, usd: number | null][] = [];
    if (input?.dailyCapUsd !== undefined) changes.push(['bot', botId, usd(input.dailyCapUsd, 'dailyCapUsd')]);
    if (input?.routines !== undefined) {
      if (!input.routines || typeof input.routines !== 'object' || Array.isArray(input.routines)) throw new HttpError(400, 'routines must map routine ids to a cap or null');
      for (const [id, v] of Object.entries(input.routines)) {
        const own = this.#db.prepare('select 1 from routines where id = ? and bot_id = ?').get(id, botId);
        if (!own) throw new HttpError(404, `No routine ${id} on this Boton`);
        changes.push(['routine', id, usd(v, `routines.${id}`)]);
      }
    }
    for (const [kind, id, v] of changes) this.#setCap(kind, id, v);
    log.info('spending caps changed', { botId, caps: changes.map(([kind, id, v]) => ({ kind, id, usd: v })) });
    return this.view(botId);
  }

  /**
   * The caps a configuration import gives a Boton it has just made, inside the import's transaction. Only ever on a
   * Boton with no cap and no account here yet: an import never raises, clears or restarts caps or spending a Boton
   * already has (a Boton made anew starts at $0, as one the owner adds by hand does). Anything else throws, and the
   * import rolls back.
   */
  importCaps(botId: string, daily: number | null, routines: [routineId: string, usd: number][]): void {
    const db = this.#db;
    if (!db.isTransaction) throw new Error('importCaps runs inside the import transaction');
    const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= MAX_CAP_USD;
    if ((daily !== null && !ok(daily)) || routines.some(([, v]) => !ok(v))) throw new Error('an imported spending cap is out of range');
    const routineIds = this.#db.prepare('select id from routines where bot_id = ?').all(botId).map((r) => String((r as { id: string }).id));
    const keys = [capKey('bot', botId), ...routineIds.map((id) => capKey('routine', id))];
    const had = keys.some((k) => db.prepare('select 1 from settings where key = ?').get(k));
    const counted = db.prepare('select 1 from api_requests where bot_id = ? limit 1').get(botId);
    if (had || counted) throw new Error('an import only gives caps to a Boton it has just made');
    for (const [id] of routines) if (!routineIds.includes(id)) throw new Error('an imported routine cap names a routine of another Boton');
    if (daily !== null) this.#setCap('bot', botId, round(daily));
    for (const [id, v] of routines) this.#setCap('routine', id, round(v));
  }

  /** Caps of Botons and routines that no longer exist go, and settled rows past any cap's reach. */
  prune(): void {
    this.#db.exec(
      `delete from settings where (key like 'spendCap:bot:%' and substr(key, 14) not in (select id from bots))
         or (key like 'spendCap:routine:%' and substr(key, 18) not in (select id from routines))`,
    );
    const before = new Date(this.#now().getTime() - KEEP_DAYS * 86_400_000).toISOString();
    this.#db.prepare("delete from api_requests where at < ? and state in ('settled', 'released')").run(before);
  }

  /**
   * Sets aside the most the next request can cost under the caps as they are now, as its own row, or throws CapError
   * (nothing written). One transaction: no other request is counted between the read and the write.
   */
  reserve(scope: SpendScope, ask: ReserveAsk): Reservation {
    const db = this.#db;
    db.exec('begin immediate');
    let row: { id: string; maxOutput: number; usd: number | null };
    try {
      row = this.#reserve(scope, ask);
      db.exec('commit');
    } catch (err) {
      if (db.isTransaction) db.exec('rollback');
      throw err;
    }
    const end = (state: 'settled' | 'held' | 'released', cost: number | null) =>
      db.prepare("update api_requests set state = ?, cost_usd = ?, ended_at = ? where id = ? and state = 'reserved'").run(state, cost === null ? null : round(cost), this.#now().toISOString(), row.id);
    return {
      maxOutput: row.maxOutput,
      usd: row.usd,
      // Tokens unknown: held at its most (or, with no known price, an unpriced request that may have been billed).
      settle: (usd) => (usd === null ? end('held', null) : end('settled', usd)),
      hold: () => end('held', null),
      release: () => end('released', null),
    };
  }

  #reserve(scope: SpendScope, ask: ReserveAsk): { id: string; maxOutput: number; usd: number | null } {
    const daily = this.#cap('bot', scope.botId);
    const perRun = scope.runId ? this.#cap('routine', scope.routineId) : null;
    const capped = daily !== null || perRun !== null;
    if (capped && !ask.rate) throw new CapError('its model has no known price in Botons, so its spending cap can’t be kept. Pick a model with a known price, or remove the cap.');
    let left = Number.POSITIVE_INFINITY;
    let which = '';
    if (daily !== null) {
      const today = this.#today(scope.botId);
      if (today.unpriced > 0) throw new CapError(`today already has ${today.unpriced} API-key request${today.unpriced > 1 ? 's' : ''} with no known price, so the daily cap can’t be kept until tomorrow.`);
      if (daily - today.spent < left) [left, which] = [daily - today.spent, `the Boton’s daily cap of $${daily}`];
    }
    if (perRun !== null && scope.runId) {
      const run = this.#run(scope.runId);
      if (run.unpriced > 0) throw new CapError('this run already has a request with no known price, so the routine’s cap can’t be kept.');
      if (perRun - run.spent < left) [left, which] = [perRun - run.spent, `the routine’s cap of $${perRun} a run`];
    }
    let maxOutput = ask.maxOutput;
    if (ask.rate && capped) {
      const fits = outputFor(ask.rate, ask.inputTokens, round(left));
      if (fits < ask.minOutput) throw new CapError(`the next request could cost more than the $${Math.max(0, left).toFixed(4)} left under ${which}.`);
      maxOutput = Math.min(maxOutput, fits);
    }
    const usd = ask.rate ? mostOf(ask.rate, ask.inputTokens, maxOutput) : null;
    if (usd !== null && usd > left + 1e-9) throw new CapError(`the next request could cost up to $${usd.toFixed(4)}, more than the $${Math.max(0, left).toFixed(4)} left under ${which}.`);
    const id = `req_${randomUUID()}`;
    this.#db
      .prepare("insert into api_requests (id, bot_id, turn_id, run_id, routine_id, provider, model, at, reserved_usd, cost_usd, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'reserved')")
      .run(id, scope.botId, scope.turnId, scope.runId, scope.routineId, ask.provider, ask.model, this.#now().toISOString(), usd);
    return { id, maxOutput, usd };
  }
}
