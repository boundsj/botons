import { createHash } from 'node:crypto';
import type { ApnsStatus, Message, NotifyDelivery, NotifyPriority, PushProblem, PushStatus } from '../../shared/types.ts';
import { parseQuiet } from '../../shared/wake.ts';
import type { ApnsSender, PushDevices } from './apns.ts';
import { log } from './log.ts';
import { nowIso } from './util.ts';

export const PUSH_TEXT_MAX = 200;
/** The most bytes of JSON Apple takes in one push. */
export const APNS_PAYLOAD_MAX = 4096;

export interface Push {
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
  /** The chat message or approval this push is about, when there is one: the app opens it. */
  messageId?: string;
  approvalId?: string;
  /** A team's push: the app opens that team (and item), or the card when messageId is set too. */
  teamId?: string;
  itemId?: string;
}

/**
 * Where a push opens the app: a team's push opens the card it is about (an escalation) in the lead's chat, else the
 * team; any other, the Boton's chat.
 */
function clickHash(req: PushRequest): string {
  const e = encodeURIComponent;
  if (req.reason === 'team') {
    if (req.messageId && req.bot) return `#/m/${e(req.bot.id)}/${e(req.messageId)}`;
    if (req.teamId) return `#/teams/${e(req.teamId)}`;
  }
  return req.bot ? `#/m/${e(req.bot.id)}` : '';
}

export function buildPush(req: PushRequest, preview: boolean, publicUrl: string): Push {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    title: req.bot?.name ?? 'Botons',
    body: clip((preview && req.detail.trim()) || req.generic),
    click: `${base}/${clickHash(req)}`,
    priority: req.priority,
  };
}

/** Without a half of a surrogate pair (a cut in the middle of an emoji leaves one), which is not valid text for Apple. */
const wellFormed = (text: string) => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

/**
 * What Apple's push service is sent: the same title and text as ntfy would carry (so the "Show text in pushes"
 * setting rules here too), the Boton's id as the thread, and the ids the app needs to open the chat or approval.
 */
export function buildApnsPayload(push: Push, req: PushRequest): Record<string, unknown> {
  const make = (title: string, body: string) => ({
    aps: { alert: { title, body }, sound: 'default', ...(req.bot ? { 'thread-id': req.bot.id } : {}) },
    ...(req.bot ? { botId: req.bot.id } : {}),
    ...(req.messageId ? { messageId: req.messageId } : {}),
    ...(req.approvalId ? { approvalId: req.approvalId } : {}),
    ...(req.teamId ? { teamId: req.teamId } : {}),
    ...(req.itemId ? { itemId: req.itemId } : {}),
  });
  // Apple refuses a payload over 4096 bytes. Text is already cut to PUSH_TEXT_MAX characters, but those can be several
  // bytes each (and a Boton's name is not cut), so shrink the body, then the title, by whole characters until it fits.
  let title = wellFormed(push.title);
  let body = wellFormed(push.body);
  const size = () => Buffer.byteLength(JSON.stringify(make(title, body)));
  for (const field of ['body', 'title'] as const) {
    while (size() > APNS_PAYLOAD_MAX) {
      const text = field === 'body' ? body : title;
      const chars = [...text];
      if (chars.length <= 1) break;
      // Cut by the excess in bytes at first (a character is at most 4), then one at a time.
      const cut = Math.max(1, Math.floor((size() - APNS_PAYLOAD_MAX) / 4));
      const next = `${chars.slice(0, Math.max(0, chars.length - cut - 1)).join('').trimEnd()}…`;
      if (field === 'body') body = next;
      else title = next;
    }
  }
  return make(title, body);
}

/** Which ntfy server, topic and token an attempt went to: the push status describes one of these at a time. */
function scopeOf(cfg: NtfyConfig | null): string | null {
  return cfg ? createHash('sha256').update(JSON.stringify([cfg.server, cfg.topic, cfg.token ?? ''])).digest('hex') : null;
}

export interface NotifierApns {
  sender: ApnsSender;
  devices: PushDevices;
  /** The owner's "Show text in pushes" setting. */
  preview: () => boolean;
}

export interface NotifierOptions {
  config: () => NtfyConfig | null;
  publicUrl: () => string;
  /** Push to the native app: only when the server has its Apple push settings. */
  apns?: NotifierApns | null;
}

export class Notifier {
  #opts: NotifierOptions;
  /** Push attempts to the app are numbered as they start; the newest sequence applied to the status, and to each device. */
  #apnsStarted = 0;
  #apnsApplied = 0;
  #apnsDeviceSeq = new Map<string, number>();
  #apns = { last: null as PushStatus['last'], lastSuccessAt: null as string | null, failuresInARow: 0, since: nowIso() };
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

  constructor(opts: NotifierOptions) {
    this.#opts = opts;
  }

  /** Pushes can go somewhere: ntfy is on, or a device has registered for the app. */
  get enabled(): boolean {
    return !!this.#opts.config()?.enabled || (!!this.#opts.apns && this.#opts.apns.devices.count() > 0);
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
  async push(req: PushRequest, options: { apns?: boolean } = {}): Promise<NotifyDelivery[]> {
    const [ntfy, apns] = await Promise.all([this.#attempt(req), options.apns === false ? null : this.#attemptApns(req)]);
    return [...(ntfy ? [ntfy.delivery] : []), ...(apns ? [apns] : [])];
  }

  /** A newly committed reply, never a draft or a history/reconnect event. Does not change ntfy's notification policy. */
  async message(bot: NonNullable<PushRequest['bot']>, message: Message): Promise<NotifyDelivery | null> {
    if (message.botId !== bot.id || message.role !== 'bot' || !message.text.trim() || message.meta?.quiet || message.meta?.staleContext || parseQuiet(message.text) !== null) return null;
    return this.#attemptApns({ bot, reason: 'message', detail: message.text, generic: 'New message.', priority: 'default', messageId: message.id });
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

  /** One push to every device registered for the app; null when the server is not set up for it or none is registered. */
  async #attemptApns(req: PushRequest): Promise<NotifyDelivery | null> {
    const apns = this.#opts.apns;
    const devices = apns?.devices.all() ?? [];
    if (!apns || !devices.length) return null;
    const payload = buildApnsPayload(buildPush(req, apns.preview(), this.#opts.publicUrl()), req);
    // Attempts are numbered as they start, and a result is applied only if no later attempt's has been (they can finish out of order).
    const seq = ++this.#apnsStarted;
    const results = await Promise.all(
      devices.map(async (d) => {
        const r = await apns.sender.send(d, payload);
        // d is the registration as read before sending: a device that registered again meanwhile keeps its newer one.
        const current = seq > (this.#apnsDeviceSeq.get(d.deviceId) ?? 0);
        const removal = current && r.gone ? apns.devices.removeIfUnchanged(d, r.goneAt) : null;
        if (current) {
          this.#apnsDeviceSeq.set(d.deviceId, seq);
          if (removal !== 'removed' && removal !== 'newer') apns.devices.setResult(d, r.ok ? 'delivered' : `${r.problem}${r.reason ? ` (${r.reason})` : ''}`);
        }
        // A registration Apple no longer knows (or that was replaced meanwhile) is not a failing channel.
        return { ...r, dropped: removal === 'removed' || removal === 'newer' };
      }),
    );
    for (const id of this.#apnsDeviceSeq.keys()) if (!devices.some((d) => d.deviceId === id) && !apns.devices.get(id)) this.#apnsDeviceSeq.delete(id);
    // With nothing delivered a push whose devices were all dropped still says so.
    const failed = results.filter((r) => !r.ok && !r.dropped);
    const delivered = results.filter((r) => r.ok).length;
    const ok = !failed.length && delivered > 0;
    const worst = failed[0] ?? results.find((r) => !r.ok) ?? null;
    const status = worst ? worst.status : (results[0]?.status ?? null);
    const error = ok || !worst ? null : `${devices.length > 1 ? `${results.filter((r) => !r.ok).length} of ${devices.length} devices: ` : ''}${worst.status ? `HTTP ${worst.status}` : (worst.problem ?? 'failed')}${worst.reason ? `: ${worst.reason}` : ''}`;
    if (!ok) log.warn('push failed', { channel: 'apns', reason: req.reason, botId: req.bot?.id, status, error });
    const at = nowIso();
    const problem = ok ? null : (worst?.problem ?? 'rejected');
    if (seq > this.#apnsApplied) {
      this.#apnsApplied = seq;
      this.#apns.last = { at, ok, reason: req.reason, status, problem };
      if (ok) {
        this.#apns.lastSuccessAt = at;
        this.#apns.failuresInARow = 0;
      } else this.#apns.failuresInARow++;
    }
    return { channel: 'apns', reason: req.reason, ok, status, error, at };
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
      ...(this.#opts.apns ? { apns: this.#apnsStatus(this.#opts.apns) } : {}),
    };
  }

  #apnsStatus(apns: NotifierApns): ApnsStatus {
    return { devices: apns.devices.count(), ...this.#apns };
  }
}
