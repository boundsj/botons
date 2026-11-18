import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, constants as h2, type ClientHttp2Session } from 'node:http2';
import type { DatabaseSync } from 'node:sqlite';
import type { ApnsEnvironment, PushProblem } from '../../shared/types.ts';
import type { ApnsConfig } from './config.ts';
import { httpProblem } from './notify.ts';
import { nowIso, type Row } from './util.ts';

/** Apple's two push hosts. Fixed: no setting, request or registration can name another one, so the provider token only ever goes to Apple. */
const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};

/** Apple wants a provider token refreshed at least every hour and at most every 20 minutes. */
export const APNS_TOKEN_REUSE_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A connection nothing used for this long is closed; the next push opens a new one. */
const SESSION_IDLE_MS = 10 * 60_000;
const RESPONSE_MAX = 4096;

/** An APNs device token as the app sends it: hexadecimal (Apple's are 32 bytes today and may grow). */
export const APNS_TOKEN = /^[0-9a-fA-F]{32,200}$/;

/** A registration as a push read it: what a later write about that push must still find. */
export interface PushTarget {
  deviceId: string;
  token: string;
  environment: ApnsEnvironment;
  updatedAt: string;
}

export interface PushRegistration {
  environment: ApnsEnvironment;
  updatedAt: string;
  lastResult: string | null;
}

/** The push registrations of paired devices, one per device. Deleted with the device (a foreign key), so revoking or signing out removes it. */
export class PushDevices {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(deviceId: string): PushRegistration | null {
    const r = this.#db.prepare('select environment, updated_at, last_result from push_devices where device_id = ?').get(deviceId);
    return r ? toRegistration(r) : null;
  }

  /** Saves or replaces this device's registration. A token held by another device is moved here: one token is one phone. */
  register(deviceId: string, token: string, environment: ApnsEnvironment): PushRegistration {
    const clean = token.toLowerCase();
    this.#db.exec('begin immediate');
    try {
      const same = this.#db.prepare('select token, environment, updated_at from push_devices where device_id = ?').get(deviceId);
      this.#db.prepare('delete from push_devices where token = ? and device_id <> ?').run(clean, deviceId);
      // The last result described the old token and environment; it stays only while neither changed.
      const kept = same && same.token === clean && same.environment === environment;
      // Never the time the registration had: a push that read the older one must not match this one (see removeIfUnchanged).
      let at = nowIso();
      if (same && at <= String(same.updated_at)) at = new Date(Date.parse(String(same.updated_at)) + 1).toISOString();
      this.#db
        .prepare(
          `insert into push_devices (device_id, token, environment, updated_at, last_result) values (?, ?, ?, ?, null)
           on conflict(device_id) do update set token = excluded.token, environment = excluded.environment, updated_at = excluded.updated_at${kept ? '' : ', last_result = null'}`,
        )
        .run(deviceId, clean, environment, at);
      this.#db.exec('commit');
    } catch (err) {
      if (this.#db.isTransaction) this.#db.exec('rollback');
      throw err;
    }
    return this.get(deviceId)!;
  }

  remove(deviceId: string): boolean {
    return Number(this.#db.prepare('delete from push_devices where device_id = ?').run(deviceId).changes) > 0;
  }

  /** Every registration, for one push each. */
  all(): PushTarget[] {
    return this.#db
      .prepare('select device_id, token, environment, updated_at from push_devices order by updated_at, device_id')
      .all()
      .map((r) => ({ deviceId: String(r.device_id), token: String(r.token), environment: r.environment as ApnsEnvironment, updatedAt: String(r.updated_at) }));
  }

  count(): number {
    return Number(this.#db.prepare('select count(*) as n from push_devices').get()!.n);
  }

  /**
   * A push finished: `target` is the registration it went to, as it was read. Only that registration is described by the
   * result, so one the device made since (another token, or the same one saved again) is left as it is.
   */
  setResult(target: PushTarget, result: string): void {
    this.#db.prepare('update push_devices set last_result = ? where device_id = ? and token = ? and updated_at = ?').run(result, target.deviceId, target.token, target.updatedAt);
  }

  /**
   * Apple said the token is no longer valid. Only the registration the push went to goes, never a newer one:
   * - `newer`: the device registered again since the push read it (another token, or the same one saved again), so the
   *   answer is about a registration that no longer exists and the new one is left alone;
   * - `kept`: Apple's invalidation time (`invalidatedAtMs`, from a 410) is before this registration was saved, so the
   *   token was registered again after Apple dropped it and may be valid now;
   * - `removed`: otherwise. With no time (a 400 BadDeviceToken says none) there is nothing to compare.
   */
  removeIfUnchanged(target: PushTarget, invalidatedAtMs: number | null = null): 'removed' | 'newer' | 'kept' {
    const current = this.#db.prepare('select 1 from push_devices where device_id = ? and token = ? and updated_at = ?').get(target.deviceId, target.token, target.updatedAt);
    if (!current) return 'newer';
    if (invalidatedAtMs !== null && invalidatedAtMs < Date.parse(target.updatedAt)) return 'kept';
    this.#db.prepare('delete from push_devices where device_id = ? and token = ? and updated_at = ?').run(target.deviceId, target.token, target.updatedAt);
    return 'removed';
  }
}

function toRegistration(r: Row): PushRegistration {
  return { environment: r.environment as ApnsEnvironment, updatedAt: String(r.updated_at), lastResult: r.last_result === null ? null : String(r.last_result) };
}

export interface ApnsResult {
  ok: boolean;
  status: number | null;
  /** Apple's reason word when it gave one (`BadDeviceToken`), else null. */
  reason: string | null;
  /**
   * Apple says the token is no longer valid: a 400 BadDeviceToken, or a 410 with a valid `timestamp`. A 410 without one
   * is not believed (it cannot be told from a registration made after it), and is a failure like any other.
   */
  gone: boolean;
  /** A 410's `timestamp`, when Apple stopped the token being valid, in milliseconds since the epoch; null otherwise. */
  goneAt: number | null;
  problem: PushProblem | null;
}

export interface ApnsSenderOptions {
  config: ApnsConfig;
  /**
   * Tests only: a plain-HTTP/2 loopback origin to send to in place of Apple's hosts. Set in code (createApp's options),
   * never from a setting, the environment or the API; anything else is refused.
   */
  testOrigin?: string;
  now?: () => number;
  timeoutMs?: number;
  /** Tests: how long an unused connection is kept. */
  idleMs?: number;
}

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/** Sends one notification to one device over HTTP/2, with an ES256 provider token made from the .p8 key. */
export class ApnsSender {
  #cfg: ApnsConfig;
  #origins: Record<ApnsEnvironment, string>;
  #now: () => number;
  #timeoutMs: number;
  #sessions = new Map<string, ClientHttp2Session>();
  #jwt: { token: string; at: number } | null = null;
  #closed = false;
  #idleMs: number;

  constructor(opts: ApnsSenderOptions) {
    this.#cfg = opts.config;
    this.#now = opts.now ?? Date.now;
    this.#timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    this.#origins = { ...APNS_ORIGINS };
    if (opts.testOrigin !== undefined) {
      const u = new URL(opts.testOrigin);
      if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.pathname !== '/' || u.search || u.username) {
        throw new Error('The APNs test origin is for tests only: a plain http:// loopback origin');
      }
      this.#origins = { production: u.origin, development: u.origin };
    }
  }

  /** The host a registration in `environment` is pushed to: Apple's, unless a test gave a loopback origin in code. */
  originFor(environment: ApnsEnvironment): string {
    return this.#origins[environment];
  }

  /** The provider token: made again once the one in use is older than APNS_TOKEN_REUSE_MS. Throws if the key cannot be read. */
  providerToken(): string {
    const now = this.#now();
    if (this.#jwt && now - this.#jwt.at < APNS_TOKEN_REUSE_MS) return this.#jwt.token;
    const header = b64u(JSON.stringify({ alg: 'ES256', kid: this.#cfg.keyId }));
    const claims = b64u(JSON.stringify({ iss: this.#cfg.teamId, iat: Math.floor(now / 1000) }));
    const key = createPrivateKey(readFileSync(this.#cfg.keyFile));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    this.#jwt = { token: `${header}.${claims}.${b64u(signature)}`, at: now };
    return this.#jwt.token;
  }

  /** Never throws. */
  async send(device: { token: string; environment: ApnsEnvironment }, payload: unknown): Promise<ApnsResult> {
    let jwt: string;
    try {
      jwt = this.providerToken();
    } catch {
      return { ok: false, status: null, reason: 'KeyUnreadable', gone: false, goneAt: null, problem: 'refused' };
    }
    try {
      const res = await this.#request(this.#origins[device.environment], {
        ':method': 'POST',
        ':path': `/3/device/${device.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': this.#cfg.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      }, JSON.stringify(payload));
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, reason: null, gone: false, goneAt: null, problem: null };
      let reason: string | null = null;
      let timestamp: unknown;
      try {
        const body = JSON.parse(res.body);
        if (typeof body.reason === 'string' && /^[A-Za-z]{1,40}$/.test(body.reason)) reason = body.reason;
        timestamp = body.timestamp;
      } catch {}
      // The provider token is refused: make a new one for the next push.
      if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') this.#jwt = null;
      // A 410 says when the token stopped being valid (milliseconds since the epoch); one without a usable time is kept.
      const goneAt = res.status === 410 && this.#validTime(timestamp) ? (timestamp as number) : null;
      const gone = goneAt !== null || (res.status === 400 && reason === 'BadDeviceToken');
      return { ok: false, status: res.status, reason, gone, goneAt, problem: httpProblem(res.status) };
    } catch (err) {
      const e = err as { name?: string; code?: string };
      return { ok: false, status: null, reason: null, gone: false, goneAt: null, problem: e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable' };
    }
  }

  /** A whole number of milliseconds since the epoch: after 2001 and no later than a day from now (a clock may be a little off). */
  #validTime(v: unknown): boolean {
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 1e12 && v <= this.#now() + 86_400_000;
  }

  #session(origin: string): ClientHttp2Session {
    const have = this.#sessions.get(origin);
    if (have && !have.closed && !have.destroyed) return have;
    const s = connect(origin);
    const drop = () => {
      if (this.#sessions.get(origin) === s) this.#sessions.delete(origin);
    };
    // The next push opens a new connection; this one's streams each fail on their own.
    s.on('error', drop);
    s.on('close', drop);
    s.on('goaway', () => {
      drop();
      s.close();
    });
    s.setTimeout(this.#idleMs, () => {
      drop();
      s.close();
    });
    s.unref();
    this.#sessions.set(origin, s);
    return s;
  }

  #request(origin: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
    if (this.#closed) return Promise.reject(Object.assign(new Error('closed'), { code: 'ECONNABORTED' }));
    return new Promise((resolve, reject) => {
      const req = this.#session(origin).request(headers);
      let status = 0;
      let text = '';
      const timer = setTimeout(() => {
        reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
        req.close(h2.NGHTTP2_CANCEL);
      }, this.#timeoutMs);
      req.setEncoding('utf8');
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (d: string) => {
        if (text.length < RESPONSE_MAX) text += d;
      });
      req.on('end', () => resolve({ status, body: text }));
      req.on('error', reject);
      req.on('close', () => {
        clearTimeout(timer);
        reject(new Error('the connection closed'));
      });
      req.end(body);
    });
  }

  /** Ends the connections; the server's shutdown calls it. */
  close(): void {
    this.#closed = true;
    for (const s of this.#sessions.values()) s.destroy();
    this.#sessions.clear();
  }
}
