import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { WebhookFilter, WebhookSource } from '../../shared/types.ts';

export const WEBHOOK_SOURCES: readonly WebhookSource[] = ['generic', 'github', 'linear', 'slack', 'sentry'];

export function isWebhookSource(v: unknown): v is WebhookSource {
  return typeof v === 'string' && (WEBHOOK_SOURCES as readonly string[]).includes(v);
}

export const SOURCE_NAMES: Record<WebhookSource, string> = { generic: 'generic', github: 'GitHub', linear: 'Linear', slack: 'Slack', sentry: 'Sentry' };

export interface HookSecrets {
  key: string;
  secret: string | null;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hmacHex(secret: string, ...parts: (string | Buffer)[]): string {
  const h = createHmac('sha256', secret);
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

function hexEqual(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length || !/^[0-9a-f]+$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Null if a signed delivery is genuine and fresh, else the 401's message. `body` is the exact bytes received. */
export function verifySignature(
  source: Exclude<WebhookSource, 'generic'>,
  secrets: HookSecrets,
  headers: IncomingHttpHeaders,
  body: Buffer,
  json: unknown,
  now = Date.now(),
): string | null {
  return signatureProblem(source, secrets, headers, body, now) ?? freshnessProblem(source, json, now);
}

/**
 * Null if the signature over the exact bytes received is genuine (and, for Slack, its signed timestamp fresh), else
 * the 401's message. It needs only the bytes, so it comes before anything parses them.
 */
export function signatureProblem(source: Exclude<WebhookSource, 'generic'>, secrets: HookSecrets, headers: IncomingHttpHeaders, body: Buffer, now = Date.now()): string | null {
  // GitHub lets you choose the secret, so the key will do; the others make their own.
  const secret = secrets.secret ?? (source === 'github' ? secrets.key : null);
  if (!secret) return `This routine has no ${SOURCE_NAMES[source]} signing secret yet`;
  switch (source) {
    case 'github': {
      const sig = header(headers, 'x-hub-signature-256') ?? '';
      return sig.startsWith('sha256=') && hexEqual(sig.slice(7), hmacHex(secret, body)) ? null : 'Bad or missing X-Hub-Signature-256';
    }
    case 'linear':
      return hexEqual(header(headers, 'linear-signature'), hmacHex(secret, body)) ? null : 'Bad or missing Linear-Signature';
    case 'slack': {
      const ts = header(headers, 'x-slack-request-timestamp') ?? '';
      const sig = header(headers, 'x-slack-signature') ?? '';
      if (!/^\d{1,12}$/.test(ts) || !sig.startsWith('v0=') || !hexEqual(sig.slice(3), hmacHex(secret, `v0:${ts}:`, body))) {
        return 'Bad or missing X-Slack-Signature';
      }
      return Math.abs(now - Number(ts) * 1000) <= 5 * 60_000 ? null : 'Stale X-Slack-Request-Timestamp';
    }
    case 'sentry':
      // Sentry-Hook-Timestamp isn't signed, so checking it would stop no replay; the Request-ID dedupe does.
      return hexEqual(header(headers, 'sentry-hook-signature'), hmacHex(secret, body)) ? null : 'Bad or missing Sentry-Hook-Signature';
  }
}

/** Null if a genuinely signed delivery is fresh by what its signed body says (Linear's webhookTimestamp), else the 401's message. */
export function freshnessProblem(source: Exclude<WebhookSource, 'generic'>, json: unknown, now = Date.now()): string | null {
  if (source !== 'linear') return null;
  const ts = Number((json as { webhookTimestamp?: unknown } | null)?.webhookTimestamp);
  return Number.isFinite(ts) && Math.abs(now - ts) <= 60_000 ? null : 'Stale or missing webhookTimestamp';
}

/** The most fields a form delivery may have (a Slack slash command has about a dozen). */
export const FORM_FIELDS_MAX = 1000;

/** A delivery that can't be read as its Content-Type says: a 400. */
export class DeliveryError extends Error {}

/**
 * The run's payload from a delivery's bytes, and the body as JSON if it is.
 * A form becomes a JSON object; a form of only `payload=<JSON>` becomes that JSON.
 */
export function parseDelivery(body: Buffer, contentType: string | undefined): { payload: string | null; json: unknown } {
  const text = body.toString('utf8');
  if (/^\s*application\/x-www-form-urlencoded\b/i.test(contentType ?? '')) {
    // No prototype, so a field named __proto__ is just a field. A repeated field's values gather in one array, in place.
    const form: Record<string, string | string[]> = Object.create(null);
    let fields = 0;
    for (const [k, v] of new URLSearchParams(text)) {
      if (++fields > FORM_FIELDS_MAX) throw new DeliveryError(`The form has too many form fields (at most ${FORM_FIELDS_MAX})`);
      const prev = form[k];
      if (prev === undefined) form[k] = v;
      else if (Array.isArray(prev)) prev.push(v);
      else form[k] = [prev, v];
    }
    const keys = Object.keys(form);
    if (!keys.length) return { payload: null, json: undefined };
    if (keys.length === 1 && typeof form.payload === 'string') {
      try {
        const inner: unknown = JSON.parse(form.payload);
        if (inner && typeof inner === 'object') return { payload: JSON.stringify(inner), json: inner };
      } catch {}
    }
    return { payload: JSON.stringify(form), json: form };
  }
  if (!text.trim()) return { payload: null, json: undefined };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { payload: text, json };
}

/** The answer to a sender checking the URL (Slack's url_verification and ssl_check, GitHub's ping), or null for a real delivery. */
export function handshake(source: WebhookSource, headers: IncomingHttpHeaders, json: unknown): Record<string, unknown> | null {
  const body = json as Record<string, unknown> | null | undefined;
  if (source === 'slack') {
    if (body?.type === 'url_verification' && typeof body.challenge === 'string') return { challenge: body.challenge };
    if (body?.ssl_check === '1') return { ok: true, skipped: true, reason: 'Slack SSL check' };
  }
  if (source === 'github' && header(headers, 'x-github-event') === 'ping') return { ok: true, skipped: true, reason: 'GitHub ping' };
  return null;
}

/**
 * The sender's own delivery id, or a generic caller's Idempotency-Key. Never
 * Idempotency-Key for a signed source: no signature covers it, so it could make
 * a captured delivery count as new.
 */
export function deliveryId(source: WebhookSource, headers: IncomingHttpHeaders, json: unknown): string | null {
  const id =
    source === 'slack'
      ? (json as { event_id?: unknown } | null | undefined)?.event_id
      : header(headers, { generic: 'idempotency-key', github: 'x-github-delivery', linear: 'linear-delivery', sentry: 'request-id' }[source]);
  return typeof id === 'string' && id.trim() && id.length <= 200 ? id.trim() : null;
}

/** The ids a delivery counts under. A signed one's body hash too, since its delivery id header isn't signed. */
export function deliveryKeys(source: WebhookSource, id: string | null, bytes: Buffer): string[] {
  const keys = id ? [id] : [];
  if (source !== 'generic') keys.push(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  return keys;
}

/** The headers a run keeps and the Boton sees: none that carries a secret or a signature. */
const SHOWN_HEADERS = [
  'Content-Type',
  'User-Agent',
  'Idempotency-Key',
  'X-GitHub-Event',
  'X-GitHub-Delivery',
  'X-GitHub-Hook-ID',
  'X-GitHub-Hook-Installation-Target-Type',
  'X-GitHub-Hook-Installation-Target-ID',
  'Linear-Event',
  'Linear-Delivery',
  'Sentry-Hook-Resource',
  'Request-ID',
] as const;

export function shownHeaders(headers: IncomingHttpHeaders): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of SHOWN_HEADERS) {
    const v = headers[name.toLowerCase()];
    const value = (Array.isArray(v) ? v.join(', ') : (v ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (value) out[name] = value.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

export function matchesFilter(filter: WebhookFilter, headers: IncomingHttpHeaders, json: unknown): boolean {
  let value: unknown;
  if (filter.kind === 'header') {
    const v = headers[filter.name.toLowerCase()];
    value = Array.isArray(v) ? v.join(', ') : v;
  } else {
    value = json;
    for (const key of filter.name.split('.')) {
      value = value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  return typeof value === 'string' && filter.values.includes(value);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A filter as given in CreateRoutineInput / UpdateRoutineInput, checked and tidied. Throws with the reason if it is not one. */
export function parseFilter(v: unknown): WebhookFilter | null {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('webhookFilter must be an object ({ kind, name, values }) or null');
  const { kind, name, values } = v as Record<string, unknown>;
  if (kind !== 'header' && kind !== 'field') throw new Error('webhookFilter.kind must be "header" or "field"');
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 200) throw new Error('webhookFilter.name must be a header name or a JSON field path such as action or pull_request.base.ref');
  if (kind === 'header' && !HEADER_NAME.test(n)) throw new Error(`webhookFilter.name "${n}" is not a header name`);
  if (kind === 'field' && n.split('.').some((k) => !k)) throw new Error(`webhookFilter.name "${n}" is not a field path`);
  const list = Array.isArray(values) ? values.map((x) => (typeof x === 'string' ? x.trim() : '')) : [];
  if (!list.length || list.length > 50 || list.some((x) => !x || x.length > 200)) throw new Error('webhookFilter.values must be 1 to 50 values, each 1 to 200 characters');
  return { kind, name: n, values: [...new Set(list)] };
}
