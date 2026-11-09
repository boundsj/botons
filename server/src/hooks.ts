import type { Routine, RoutineRun, WebhookRunStatus } from '../../shared/types.ts';
import { earlierName } from '../../shared/legacy-names.mjs';
import type { Config } from './config.ts';
import type { Engine } from './engine.ts';
import type { Ctx, Router } from './http.ts';
import { log } from './log.ts';
import { HttpError, type Store } from './store.ts';
import { orNull } from './util.ts';
import { DeliveryError, deliveryId, deliveryKeys, freshnessProblem, handshake, matchesFilter, parseDelivery, safeEqual, shownHeaders, signatureProblem } from './webhooks.ts';

const WAIT_DEFAULT_S = 300;
const WAIT_MAX_S = 1800;
/** `?wait` on the public listener is cut to this: an open request is a held socket on the internet. */
export const PUBLIC_WAIT_MAX_S = 30;

/** `?timeout=<seconds>` for webhook waits, clamped to 1..`max`; junk falls back to the default. */
export function waitSeconds(raw: string | null, max: number): number {
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : Math.min(WAIT_DEFAULT_S, max);
}

function givenKey(c: Ctx): string {
  const auth = c.req.headers.authorization ?? '';
  return (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '') || String(c.req.headers['x-boton-key'] ?? c.req.headers[earlierName('x-boton-key')!] ?? '') || c.url.searchParams.get('key') || '';
}

export function addHookRoutes(r: Router, deps: { cfg: Config; store: Store; engine: Engine }): Router {
  const { cfg, store, engine } = deps;

  /** 202 with the queued run (a redelivery's: 200), or with ?wait=1 its result once it has one. */
  const answerRun = async (c: Ctx, routine: Routine, run: RoutineRun, callerGone: AbortSignal, extra: { duplicate?: true } = {}) => {
    const location = `${routine.webhook!.url}/runs/${encodeURIComponent(run.id)}`;
    const pending = (r: RoutineRun, status: number) => {
      c.res.setHeader('location', location);
      c.json(status, { ok: true, runId: r.id, status: r.status, ...extra });
    };
    const wait = ['1', 'true', 'yes'].includes(c.url.searchParams.get('wait') ?? '');
    if (!wait) return pending(run, extra.duplicate ? 200 : 202);
    c.req.socket.setTimeout(0);
    const viaPublic = cfg.hooks.port !== null && c.req.socket.localPort === cfg.hooks.port;
    const done = await engine.waitForRun(run, waitSeconds(c.url.searchParams.get('timeout'), viaPublic ? PUBLIC_WAIT_MAX_S : WAIT_MAX_S) * 1000, callerGone);
    if (callerGone.aborted) return;
    if (engine.closing.aborted && (done.status === 'queued' || done.status === 'running')) {
      c.res.setHeader('location', location);
      c.res.setHeader('retry-after', '30');
      return c.json(503, {
        ok: false,
        runId: done.id,
        status: done.status,
        error: 'The server is restarting before this run finished. It runs (or is marked interrupted) when the server is back: check the run at the Location.',
        ...extra,
      });
    }
    // Gone: the run was deleted with its routine or Boton while waiting.
    const gone = !store.findRun(done.id);
    if (!gone && (done.status === 'queued' || done.status === 'running')) return pending(done, 202);
    c.json(gone ? 410 : 200, { ok: done.status === 'succeeded', runId: done.id, status: done.status, reply: done.reply, error: done.error, ...extra });
  };

  // A generic routine takes its key; the others take only their sender's signature.
  r.on('POST', '/hooks/routines/:id', async (c) => {
    // On res, not req: req's 'close' fires as soon as its body has been read.
    const callerGone = new AbortController();
    c.res.once('close', () => callerGone.abort());
    const routine = orNull(() => store.getRoutine(c.params.id));
    const secrets = routine?.webhook ? store.webhookSecrets(routine.id) : null;
    if (!routine?.webhook || !secrets) throw new HttpError(401, 'Unknown routine or bad key');
    const { source } = routine.webhook;
    const headers = c.req.headers;
    if (source === 'generic') {
      const given = givenKey(c);
      if (!given || !safeEqual(given, secrets.key)) throw new HttpError(401, 'Unknown routine or bad key');
    }
    const bytes = await c.rawBytes();
    // A signed sender's signature covers the exact bytes, so a forged delivery is refused before anything parses them.
    if (source !== 'generic') {
      const bad = signatureProblem(source, secrets, headers, bytes);
      if (bad) throw new HttpError(401, bad);
    }
    let delivery: ReturnType<typeof parseDelivery>;
    try {
      delivery = parseDelivery(bytes, headers['content-type']);
    } catch (err) {
      if (err instanceof DeliveryError) throw new HttpError(400, err.message);
      throw err;
    }
    if (source !== 'generic') {
      const stale = freshnessProblem(source, delivery.json);
      if (stale) throw new HttpError(401, stale);
    }
    const answer = handshake(source, headers, delivery.json);
    if (answer) return c.json(200, answer);

    // A redelivery within a day gets the run the first one started, unless that run failed or was skipped.
    const id = deliveryId(source, headers, delivery.json);
    const keys = deliveryKeys(source, id, bytes);
    const earlier = keys.map((k) => store.findDelivery(routine.id, k)).find((r) => r !== null) ?? null;
    if (earlier) {
      // A failed run the owner retried: the redelivery gets the retry.
      const first = store.findRun(earlier);
      const run = first && store.latestRetry(first);
      if (!run) return c.json(200, { ok: true, runId: earlier, status: null, duplicate: true });
      if (run.status !== 'failed' && run.status !== 'skipped') return answerRun(c, routine, run, callerGone.signal, { duplicate: true });
      log.info('webhook redelivery of a run that did not succeed: running it again', { routineId: routine.id, runId: run.id, status: run.status });
    }
    // A Slack retry with no event_id can't be matched to its first try, which probably started a run.
    if (source === 'slack' && id === null && headers['x-slack-retry-num'] !== undefined) return c.json(200, { ok: true, skipped: true, reason: 'Slack retry' });
    if (!routine.enabled) throw new HttpError(409, 'Routine is paused');
    if (routine.webhook.filter && !matchesFilter(routine.webhook.filter, headers, delivery.json)) {
      return c.json(200, { ok: true, skipped: true, reason: 'Filtered out' });
    }
    const run = engine.triggerRoutine(routine.id, 'webhook', delivery.payload, shownHeaders(headers));
    for (const k of keys) store.recordDelivery(routine.id, k, run.id);
    return answerRun(c, routine, run, callerGone.signal);
  });

  // Takes the routine's key whatever its sender.
  r.on('GET', '/hooks/routines/:id/runs/:runId', (c) => {
    const secrets = store.webhookSecrets(c.params.id);
    const given = givenKey(c);
    if (!secrets || !given || !safeEqual(given, secrets.key)) throw new HttpError(401, 'Unknown routine or bad key');
    const run = store.findRun(c.params.runId);
    if (!run || run.routineId !== c.params.id) throw new HttpError(404, `No run ${c.params.runId} of this routine`);
    return {
      ok: run.status === 'succeeded',
      runId: run.id,
      status: run.status,
      trigger: run.trigger,
      reply: run.reply,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      attempts: run.attempts,
      retriedAs: run.meta?.retriedAs ?? null,
      cancelled: !!run.meta?.cancelled,
      timedOut: !!run.meta?.timedOut,
    } satisfies WebhookRunStatus;
  });

  return r;
}
