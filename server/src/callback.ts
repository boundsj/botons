import { createHmac } from 'node:crypto';
import { earlierName } from '../../shared/legacy-names.mjs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CallbackDelivery, RoutineRun, RunCallback } from '../../shared/types.ts';
import type { CallbacksConfig } from './config.ts';
import type { EventHub } from './events.ts';
import { log } from './log.ts';
import { allowance, guardedLookup, refusedUrl } from './ssrf.ts';
import { HttpError, PENDING_CALLBACK_LIMIT, type Store } from './store.ts';
import { nowIso } from './util.ts';

type Attempt = { ok: boolean; status: number | null; error: string | null; retry: boolean };

/**
 * POSTs each finished run's result to its routine's callbackUrl, signed with the webhook key.
 *
 * The store records a run's callback as pending in the same transaction that finishes the run, so what a stop or a
 * crash cuts off is still pending at the next start, and resumePending sends it again. This only sends: a run.upserted
 * carrying a pending callback starts a send, and the outcome replaces pending after the last attempt. Delivery is
 * at-least-once, so a receiver may get a result twice: X-Boton-Run tells them apart.
 */
export class Callbacks {
  #cfg: CallbacksConfig;
  #store: Store;
  /** Runs whose callback is being sent, so a run.upserted meanwhile doesn't send it again. */
  #sending = new Set<string>();
  #stopped = false;
  #inflight = new Set<AbortController>();
  #waits = new Map<NodeJS.Timeout, () => void>();
  #unsubscribe: () => void;

  constructor(cfg: CallbacksConfig, store: Store, hub: EventHub) {
    this.#cfg = cfg;
    this.#store = store;
    this.#unsubscribe = hub.subscribe((ev) => {
      if (ev.type === 'run.upserted' && ev.run.meta?.callback?.pending) this.#take(ev.run);
    });
  }

  /** On shutdown, before the database closes. */
  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
    for (const [t, wake] of this.#waits) {
      clearTimeout(t);
      wake();
    }
    this.#waits.clear();
    for (const c of this.#inflight) c.abort();
  }

  /** At start: send the callbacks the last stop or crash cut off, to the routine's callback URL now. */
  resumePending(): number {
    const runs = this.#store.pendingCallbackRuns();
    for (const run of runs) {
      if (this.#sending.has(run.id)) continue;
      log.info('callback resumed after a restart', { runId: run.id, routineId: run.routineId });
      this.#take(run);
    }
    return runs.length;
  }

  /** A run whose callback the store has recorded as pending. */
  #take(run: RoutineRun) {
    // A test run is a dry run: its result is not for the receiver, which may act on it.
    if (this.#stopped || run.trigger === 'test' || this.#sending.has(run.id)) return;
    // Read now: a run failed because its routine is being deleted still has its routine at this point.
    const target = this.#store.callbackTarget(run.routineId);
    if (!target) {
      this.#record(run, { url: run.meta!.callback!.url, ok: false, status: null, error: 'Not sent: the routine no longer has a callback URL', attempts: 0, at: nowIso() });
      return;
    }
    this.#send(run, target);
  }

  /** The owner sends a run's result again after its callback failed. */
  resend(runId: string): RoutineRun {
    if (this.#stopped) throw new HttpError(503, 'The server is stopping');
    const run = this.#store.getRun(runId);
    const last = run.meta?.callback;
    if (run.trigger === 'test') throw new HttpError(409, 'A test run sends no callback');
    if (!last) throw new HttpError(409, 'This run sent no callback');
    if (last.pending || this.#sending.has(run.id)) throw new HttpError(409, 'This run\'s result is being sent now');
    if (last.ok) throw new HttpError(409, 'This run\'s result was already sent');
    const target = this.#store.callbackTarget(run.routineId);
    if (!target) throw new HttpError(409, 'The routine no longer has a callback URL');
    if (this.#store.pendingCallbackCount(run.routineId) >= PENDING_CALLBACK_LIMIT) {
      throw new HttpError(409, `${PENDING_CALLBACK_LIMIT} results are already waiting for this callback URL; send it again once they are done`);
    }
    // Claimed in memory first, so the run.upserted this write publishes doesn't start a second send.
    this.#sending.add(run.id);
    let marked: RoutineRun | null;
    try {
      // Recorded before the first POST: what is still pending at the next start was cut off.
      marked = this.#store.setRunCallback(run.id, { url: target.url, ok: false, status: null, error: null, attempts: 0, at: nowIso(), pending: true });
    } catch (err) {
      this.#sending.delete(run.id);
      throw err;
    }
    if (!marked) {
      this.#sending.delete(run.id);
      throw new HttpError(404, `No run with id ${run.id}`);
    }
    void this.#deliver(marked, target).finally(() => this.#sending.delete(run.id));
    return marked;
  }

  #send(run: RoutineRun, target: { url: string; key: string }) {
    this.#sending.add(run.id);
    void this.#deliver(run, target).finally(() => this.#sending.delete(run.id));
  }

  #record(run: RoutineRun, delivery: CallbackDelivery): RoutineRun | null {
    try {
      return this.#store.setRunCallback(run.id, delivery);
    } catch (err) {
      log.warn('could not record a callback for a run', { runId: run.id, err });
      return null;
    }
  }

  async #deliver(run: RoutineRun, target: { url: string; key: string }) {
    const body = JSON.stringify({
      runId: run.id,
      routineId: run.routineId,
      botId: run.botId,
      trigger: run.trigger,
      status: run.status,
      quiet: run.quiet,
      reply: run.reply,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      attempts: run.attempts,
      cancelled: !!run.meta?.cancelled,
      timedOut: !!run.meta?.timedOut,
    } satisfies RunCallback);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Botons-Callback/1',
      'x-boton-signature': `sha256=${createHmac('sha256', target.key).update(body).digest('hex')}`,
      'x-boton-run': run.id,
    };
    // And under their deprecated names, for one release, so receivers set up for them keep working (shared/legacy-names.mjs).
    for (const k of ['x-boton-signature', 'x-boton-run'] as const) (headers as Record<string, string>)[earlierName(k)!] = headers[k];
    let attempts = 0;
    let last: Attempt;
    for (;;) {
      attempts++;
      last = await this.#attempt(target.url, headers, body);
      // Stopping, a callback not yet sent stays pending, for the next start.
      if (this.#stopped && !last.ok) return;
      if (last.ok || !last.retry || attempts > this.#cfg.retryDelaysMs.length) break;
      await this.#sleep(this.#cfg.retryDelaysMs[attempts - 1]);
      if (this.#stopped) return;
    }
    const fields = { runId: run.id, routineId: run.routineId, attempts, status: last.status ?? undefined };
    if (last.ok) log.info('callback sent', fields);
    else log.warn('callback failed', { ...fields, error: last.error });
    this.#record(run, { url: target.url, ok: last.ok, status: last.status, error: last.error, attempts, at: nowIso() });
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#waits.delete(t);
        resolve();
      }, ms);
      t.unref();
      this.#waits.set(t, resolve);
    });
  }

  /** One POST. Never throws. */
  #attempt(url: string, headers: Record<string, string>, body: string): Promise<Attempt> {
    const allow = allowance(this.#cfg.allow);
    const refused = refusedUrl(url, allow);
    if (refused) return Promise.resolve({ ok: false, status: null, error: refused, retry: false });
    const u = new URL(url);
    const controller = new AbortController();
    this.#inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error(`no answer within ${this.#cfg.timeoutMs} ms`)), this.#cfg.timeoutMs);
    return new Promise<Attempt>((resolve) => {
      const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
      // guardedLookup checks the addresses the name resolves to as it connects.
      const req = request(u, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, lookup: guardedLookup(allow), signal: controller.signal }, (res: IncomingMessage) => {
        res.resume();
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          const redirect = status >= 300 && status < 400;
          resolve({
            ok,
            status,
            error: ok ? null : redirect ? `HTTP ${status}: redirects are not followed` : `HTTP ${status}`,
            retry: status === 408 || status === 429 || status >= 500,
          });
        });
        res.on('error', (err) => resolve({ ok: false, status: res.statusCode ?? null, error: describe(err), retry: true }));
        res.on('close', () => resolve({ ok: false, status: res.statusCode ?? null, error: 'The connection closed before the answer ended', retry: true }));
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        const reason = controller.signal.aborted ? controller.signal.reason : err;
        resolve({ ok: false, status: null, error: describe(reason), retry: err.code !== 'EREFUSEDADDRESS' });
      });
      req.end(body);
    }).finally(() => {
      clearTimeout(timer);
      this.#inflight.delete(controller);
    });
  }
}

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e?.message ?? e?.code ?? String(err);
}
