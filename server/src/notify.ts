import { createHash } from 'node:crypto';
import type { NotifyDelivery, NotifyPriority, PushProblem, PushStatus } from '../../shared/types.ts';
import { log } from './log.ts';
import { nowIso } from './util.ts';

export const PUSH_TEXT_MAX = 200;

interface Push {
  title: string;
  body: string;
  click: string;
  priority: NotifyPriority;
}

type SendResult = Pick<NotifyDelivery, 'ok' | 'status' | 'error'> & { problem: PushProblem | null };

export interface NtfyConfig {
  enabled: boolean;
  server: string;
  topic: string;
  token: string | null;
  preview: boolean;
}

function describe(err: unknown): string {
  const e = err as { cause?: { code?: string; message?: string }; message?: string };
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

/** What a failed push says about where to look, as a fixed word: the owner's view never carries the error text. */
export function httpProblem(status: number): PushProblem {
  if (status >= 300 && status < 400) return 'redirected';
  if (status === 401 || status === 403) return 'refused';
  if (status >= 500) return 'server-error';
  return 'rejected';
}

export function thrownProblem(err: unknown): PushProblem {
  const e = err as { name?: string; cause?: { name?: string; code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || e?.cause?.code === 'ETIMEDOUT') return 'timeout';
  return 'unreachable';
}

/** Publishes with ntfy's JSON API. Redirects are not followed, so the token only ever goes to the configured server. */
async function sendNtfy(cfg: NtfyConfig, push: Push): Promise<SendResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const body = {
    topic: cfg.topic,
    title: push.title,
    message: push.body,
    // ntfy's 1 (min) to 5 (max); 3 is its default.
    priority: push.priority === 'high' ? 4 : 3,
    click: push.click,
  };
  try {
    const res = await fetch(`${cfg.server.replace(/\/+$/, '')}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null, problem: null };
    let detail = text.trim().slice(0, 300);
    try {
      detail = String(JSON.parse(text).error ?? detail);
    } catch {}
    if (res.status >= 300 && res.status < 400) detail = `redirected to ${res.headers.get('location') ?? 'another address'}; check the server URL`;
    return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}`, problem: httpProblem(res.status) };
  } catch (err) {
    return { ok: false, status: null, error: describe(err), problem: thrownProblem(err) };
  }
}

/** Trimmed, and cut to `max` characters with an ellipsis. */
export function clip(text: string, max = PUSH_TEXT_MAX): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export interface PushRequest {
  /** Null for the test from Settings. */
  bot: { id: string; name: string } | null;
  reason: NotifyDelivery['reason'];
  /** Sent only with previews on. Never a webhook payload. */
  detail: string;
  /** Sent with previews off: anyone who knows a topic's name on a public ntfy server can read it. */
  generic: string;
  priority: NotifyPriority;
}

export function buildPush(req: PushRequest, preview: boolean, publicUrl: string): Push {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    title: req.bot?.name ?? 'Botons',
    body: clip((preview && req.detail.trim()) || req.generic),
    click: req.bot ? `${base}/#/m/${encodeURIComponent(req.bot.id)}` : `${base}/`,
    priority: req.priority,
  };
}

/** Which ntfy server, topic and token an attempt went to: the push status describes one of these at a time. */
function scopeOf(cfg: NtfyConfig | null): string | null {
  return cfg ? createHash('sha256').update(JSON.stringify([cfg.server, cfg.topic, cfg.token ?? ''])).digest('hex') : null;
}

export class Notifier {
  #opts: { config: () => NtfyConfig | null; publicUrl: () => string };
  /** The server, topic and token the status below is about; undefined until first seen. */
  #scope: string | null | undefined = undefined;
  #since = nowIso();
  #sinceSettingsChange = false;
  #last: PushStatus['last'] = null;
  #lastSuccessAt: string | null = null;
  #failuresInARow = 0;
  /** Attempts are numbered as they start; one that finishes after a newer one, or after a settings change, is not counted. */
  #started = 0;
  #counted = 0;

  constructor(opts: { config: () => NtfyConfig | null; publicUrl: () => string }) {
    this.#opts = opts;
  }

  get enabled(): boolean {
    return !!this.#opts.config()?.enabled;
  }

  /**
   * Starts the status again when the ntfy server, topic or token is not the one it describes, so a failure to one is
   * never cleared by a success to another. Settings calls it on every change; push() and status() check it too.
   */
  syncConfig(cfg: NtfyConfig | null = this.#opts.config()): string | null {
    const scope = scopeOf(cfg);
    if (this.#scope !== undefined && scope !== this.#scope) {
      this.#since = nowIso();
      this.#sinceSettingsChange = true;
      this.#last = null;
      this.#lastSuccessAt = null;
      this.#failuresInARow = 0;
      this.#counted = this.#started;
    }
    this.#scope = scope;
    return scope;
  }

  /** Nothing if push is off (except a test, which only needs a server and topic). Never throws. */
  async push(req: PushRequest): Promise<NotifyDelivery[]> {
    const sent = await this.#attempt(req);
    return sent ? [sent.delivery] : [];
  }

  /** The owner's test push, with its fixed word for a failure; null without a server and topic. Never throws. */
  async test(): Promise<{ delivery: NotifyDelivery; problem: PushProblem | null } | null> {
    const text = 'Test notification from Botons.';
    return this.#attempt({ bot: null, reason: 'test', detail: text, generic: text, priority: 'default' });
  }

  async #attempt(req: PushRequest): Promise<{ delivery: NotifyDelivery; problem: PushProblem | null } | null> {
    const cfg = this.#opts.config();
    if (!cfg || (!cfg.enabled && req.reason !== 'test')) return null;
    const scope = this.syncConfig(cfg);
    const attempt = ++this.#started;
    const r = await sendNtfy(cfg, buildPush(req, cfg.preview, this.#opts.publicUrl()));
    if (!r.ok) log.warn('push failed', { channel: 'ntfy', reason: req.reason, botId: req.bot?.id, status: r.status, error: r.error });
    const at = nowIso();
    // Count it only if it is still about the current settings and no newer attempt has been counted.
    if (this.syncConfig() === scope && attempt > this.#counted) {
      this.#counted = attempt;
      this.#last = { at, ok: r.ok, reason: req.reason, status: r.status, problem: r.problem };
      if (r.ok) {
        this.#lastSuccessAt = at;
        this.#failuresInARow = 0;
      } else this.#failuresInARow++;
    }
    return { delivery: { channel: 'ntfy', reason: req.reason, ok: r.ok, status: r.status, error: r.error, at }, problem: r.problem };
  }

  /** How pushes to the current ntfy settings have gone, for Settings → Health. Kept in memory: a restart starts again. */
  status(): PushStatus {
    const cfg = this.#opts.config();
    this.syncConfig(cfg);
    return {
      state: !cfg ? 'unset' : cfg.enabled ? 'on' : 'off',
      last: this.#last,
      lastSuccessAt: this.#lastSuccessAt,
      failuresInARow: this.#failuresInARow,
      since: this.#since,
      sinceSettingsChange: this.#sinceSettingsChange,
    };
  }
}
