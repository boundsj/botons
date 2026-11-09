import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthStatus, Device, PairInput, PairingRequest, UrlKeys } from '../../shared/types.ts';
import { log } from './log.ts';
import { HttpError } from './store.ts';
import { approveCommand, pairCommand, SETTING_CLAIM, SETTING_SETUP } from './setup.ts';
import { isLoopback, plainAddress, type Tailnet } from './tailnet.ts';
import { newId, nowIso, type Row } from './util.ts';

/*
 * Device tokens travel only in `Authorization: Bearer`, never a cookie: a
 * browser sends a host's cookies to every port on it, so any other web server
 * on this machine (say, one a Boton started) would get them. Loopback is not
 * trusted: Botons run on this machine too. Only sha256 hashes are stored.
 */

/*
 * Pairing. A new device asks (POST /api/auth/pair-requests) and gets two things: a secret it keeps and a
 * short code it shows. The owner approves the code on the server's machine (`npm run pair -- --approve`)
 * or on a paired device (Settings → Devices), and only then does the secret turn into a device token. The
 * server cannot tell who sends a request: a Boton on this machine can leave out its token and look like
 * any browser, from the same loopback address, with whatever headers it likes. So nothing here trusts the
 * caller; what pairs a device is the owner's approval of the code read off that device's own screen. A
 * code that leaks (pasted into a chat, say) is useless without the secret, which never leaves the device
 * that asked. The one approval-free path is the owner's own Tailscale device, never loopback or this host.
 *
 * Codes are Crockford's base32, 8 characters (40 bits): the owner types them, and nobody can redeem a
 * guessed one. Requests last 15 minutes. Admission is bounded globally (per-address limits cannot
 * distinguish a Boton on loopback from the owner). At most MAX_PENDING_REQUESTS wait
 * at once; new requests are refused while the queue is full.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const PAIRING_REQUEST_TTL_MS = 15 * 60_000;
const MAX_PENDING_REQUESTS = 50;
/** How often a device's lastUsedAt is written, at most. */
const LAST_USED_EVERY_MS = 60_000;

export type Principal =
  /** deviceId is null only with BOTONS_AUTH=off and no token. */
  | { kind: 'device'; deviceId: string | null }
  /** `sandboxed`: a webhook run with Workspace access; reaches only routes marked `sandboxed`. */
  | { kind: 'boton'; botId: string; tokenId: string; sandboxed: boolean };

/** Who may call a route besides paired devices. */
export interface RouteAccess {
  public?: boolean;
  /** Boton tokens too, for the Boton this returns (null: not found, the handler 404s); another Boton's is 403. */
  boton?: (params: Record<string, string>) => string | null;
  /** A GET a browser makes by URL (no header): a device's URL key for this purpose (`?key=`) works too. */
  urlKey?: UrlKeyPurpose;
  /** Any Boton's token; the handler acts as the calling Boton, never the one in the path. */
  anyBoton?: boolean;
  /** A sandboxed turn's token too. Such a turn must not change what the Boton's later turns do or know. */
  sandboxed?: boolean;
}

const SANDBOXED_REFUSAL =
  'This run was started by a webhook (or tests one) and has Workspace access, so it can only read your routines, memories, skills and team, send notifications, share files and ask your owner for approval: it cannot create, change, run or delete routines, add or forget memories, save or change skills, or ask other Botons. Ask your owner with `botons approval request` (if they allow it, the follow-up turn has your usual access), or say in your reply what you wanted to do, so your owner can do it.';

const BOTON_PAIRING = "A Boton cannot pair a device. Only your owner pairs devices, by approving the code a new device shows, on the server's machine or a paired device.";

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function toDevice(r: Row, currentId: string | null): Device {
  return { id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, current: r.id === currentId };
}

function cleanLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);
}

// ------------------------------------------------- database (also used by `npm run pair`)

export function createDevice(db: DatabaseSync, label: string): { device: Device; token: string } {
  const id = newId('dev');
  const token = newToken('mdt');
  const now = nowIso();
  db.prepare("insert into auth_tokens (id, hash, kind, bot_id, label, created_at, last_used_at) values (?, ?, 'device', null, ?, ?, ?)").run(
    id,
    hashSecret(token),
    cleanLabel(label) || 'Device',
    now,
    now,
  );
  const device = toDevice(db.prepare('select * from auth_tokens where id = ?').get(id)!, id);
  return { device, token };
}

export function listDevices(db: DatabaseSync, currentId: string | null = null): Device[] {
  return db
    .prepare("select * from auth_tokens where kind = 'device' order by created_at, id")
    .all()
    .map((r) => toDevice(r, currentId));
}

export function deleteDevice(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare("delete from auth_tokens where id = ? and kind = 'device'").run(id).changes) > 0;
}

export function deleteAllDevices(db: DatabaseSync): number {
  return Number(db.prepare("delete from auth_tokens where kind = 'device'").run().changes);
}

/** Case, spaces and dashes don't matter, and O, I and L read as 0, 1 and 1. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function purgeRequests(db: DatabaseSync): void {
  db.prepare('delete from pairing_requests where expires_at <= ?').run(nowIso());
}

/** A device asks to pair. Only the asker gets the secret; the code is for the owner to approve. */
export function createPairingRequest(db: DatabaseSync, label = '', ttlMs = PAIRING_REQUEST_TTL_MS): Omit<PairingRequest, 'approveCommand'> {
  purgeRequests(db);
  // Never evict an accepted request: unauthenticated callers must not invalidate
  // the code an owner is already approving. Expiry frees admission capacity.
  if (Number(db.prepare('select count(*) as n from pairing_requests').get()!.n) >= MAX_PENDING_REQUESTS) {
    throw new HttpError(429, 'Pairing requests are full. Try again after pending requests expire (15 minutes).');
  }
  const secret = newToken('mpr');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  for (let tries = 0; ; tries++) {
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const added = db
      .prepare('insert into pairing_requests (secret_hash, code_hash, label, created_at, expires_at) values (?, ?, ?, ?, ?) on conflict(code_hash) do nothing')
      .run(hashSecret(secret), hashSecret(raw), cleanLabel(label), now.toISOString(), expiresAt);
    if (Number(added.changes) > 0) return { secret, code: raw.match(/.{4}/g)!.join('-'), expiresAt };
    if (tries > 5) throw new Error('could not pick a unique pairing code');
  }
}

export interface ApprovedRequest {
  /** The label the device gave, or the one the owner set while approving. */
  label: string;
  createdAt: string;
}

/**
 * The owner approves the request whose device shows `code`; `label` names the device (it beats the device's
 * own guess). Null: no request waiting with that code (wrong, expired, or approved already). Callers must be
 * the owner: the server's machine (`npm run pair`) or a paired device.
 */
export function approvePairingRequest(db: DatabaseSync, code: string, label = ''): ApprovedRequest | null {
  purgeRequests(db);
  const named = cleanLabel(label);
  const row = db
    .prepare('update pairing_requests set approved_at = ?, approved_label = ? where code_hash = ? and approved_at is null and expires_at > ? returning label, created_at')
    .get(nowIso(), named || null, hashSecret(normalizeCode(code)), nowIso()) as Row | undefined;
  return row ? { label: named || String(row.label) || 'Unnamed device', createdAt: String(row.created_at) } : null;
}

/** For `npm run pair`: what is waiting, without codes or secrets. */
export function pendingPairingRequests(db: DatabaseSync): { label: string; createdAt: string; expiresAt: string; approved: boolean }[] {
  purgeRequests(db);
  return db
    .prepare('select label, created_at, expires_at, approved_at from pairing_requests order by created_at, rowid')
    .all()
    .map((r) => ({ label: String(r.label), createdAt: String(r.created_at), expiresAt: String(r.expires_at), approved: r.approved_at != null }));
}

type UrlKeyPurpose = keyof UrlKeys;
const URL_KEY_PURPOSES: UrlKeyPurpose[] = ['events', 'files'];

/** The device id and an HMAC of the purpose keyed with its token's hash: revoking the device ends it. */
function urlKeyOf(deviceId: string, tokenHash: string, purpose: UrlKeyPurpose): string {
  return `${deviceId}.${createHmac('sha256', tokenHash).update(`botons-url-key:${purpose}`).digest('base64url')}`;
}

/** How long a preview page's key lasts: long enough to look at it, short if a page leaks its own URL. */
export const PREVIEW_KEY_TTL_MS = 60 * 60_000;

/** `<device id>.<expiry, base 36 ms>.<HMAC of the Boton, path and expiry keyed with its token's hash>`. */
function previewKeyOf(deviceId: string, tokenHash: string, botId: string, path: string, expiresAt: number): string {
  const exp = expiresAt.toString(36);
  const mac = createHmac('sha256', tokenHash).update(`botons-preview\0${botId}\0${path}\0${exp}`).digest('base64url');
  return `${deviceId}.${exp}.${mac}`;
}

// ------------------------------------------------------------------- server

interface AuthOptions {
  /** False with BOTONS_AUTH=off: a request without a valid token counts as a paired device. */
  enabled: boolean;
  /** Null: the Tailscale login this machine is signed in as. */
  ownerLogin: string | null;
  /** Null: no Tailscale lookups, so pairing needs a code. */
  tailnet: Tailnet | null;
  hostname: string;
  container?: boolean;
}

export interface Paired {
  device: Device;
  token: string;
  method: 'approval' | 'tailscale';
  /** The first device this server ever paired: it claimed the server for its owner. */
  claim: boolean;
}

export class Auth {
  #db: DatabaseSync;
  #opts: AuthOptions;
  /** Open SSE streams per device, so revoking a device ends them. */
  #streams = new Map<string, Set<() => void>>();
  /** Sandboxed turns' token ids. In memory only: turn tokens never outlive the process. */
  #sandboxed = new Set<string>();

  constructor(db: DatabaseSync, opts: AuthOptions) {
    this.#db = db;
    this.#opts = opts;
  }

  /** False with BOTONS_AUTH=off. */
  get required(): boolean {
    return this.#opts.enabled;
  }

  #bearer(req: IncomingMessage): string | null {
    return /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
  }

  /** Null: no token, or one that is unknown, revoked or from a finished turn. */
  authenticate(req: IncomingMessage, opts: { url?: URL; urlKey?: UrlKeyPurpose } = {}): Principal | null {
    const token = this.#bearer(req);
    const row = token ? this.#lookup(token) : null;
    if (row?.kind === 'boton') {
      const tokenId = String(row.id);
      return { kind: 'boton', botId: String(row.bot_id), tokenId, sandboxed: this.#sandboxed.has(tokenId) };
    }
    if (row) return { kind: 'device', deviceId: String(row.id) };
    if (!token && opts.urlKey && opts.url && (req.method === 'GET' || req.method === 'HEAD')) {
      const given = opts.url.searchParams.get('key');
      const deviceId = given ? this.#checkUrlKey(given, opts.urlKey) : null;
      if (deviceId) return { kind: 'device', deviceId };
    }
    return this.#opts.enabled ? null : { kind: 'device', deviceId: null };
  }

  #lookup(token: string): Row | null {
    const row = this.#db.prepare('select id, kind, bot_id, last_used_at from auth_tokens where hash = ?').get(hashSecret(token)) as Row | undefined;
    if (!row) return null;
    this.#touch(row);
    return row;
  }

  #touch(row: Row): void {
    if (row.kind === 'device' && (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS)) {
      this.#db.prepare('update auth_tokens set last_used_at = ? where id = ?').run(nowIso(), row.id);
    }
  }

  #checkUrlKey(given: string, purpose: UrlKeyPurpose): string | null {
    const dot = given.lastIndexOf('.');
    if (dot <= 0) return null;
    const row = this.#db.prepare("select id, kind, hash, last_used_at from auth_tokens where id = ? and kind = 'device'").get(given.slice(0, dot)) as Row | undefined;
    if (!row) return null;
    const want = Buffer.from(urlKeyOf(String(row.id), String(row.hash), purpose));
    const got = Buffer.from(given);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    this.#touch(row);
    return String(row.id);
  }

  #urlKeys(deviceId: string | null): UrlKeys | null {
    if (!deviceId) return null;
    const row = this.#db.prepare("select id, hash from auth_tokens where id = ? and kind = 'device'").get(deviceId) as Row | undefined;
    if (!row) return null;
    return Object.fromEntries(URL_KEY_PURPOSES.map((p) => [p, urlKeyOf(String(row.id), String(row.hash), p)])) as unknown as UrlKeys;
  }

  /**
   * A key for one file's preview page (`GET /api/bots/:id/files/preview`), for a paired device. The page
   * runs a Boton's script, which can read its own URL, so this key opens only that file, and only until
   * `expiresAt`; revoking the device ends it sooner. Null when there is no device (BOTONS_AUTH=off).
   */
  previewKey(deviceId: string | null, botId: string, path: string, now = Date.now()): { key: string; expiresAt: number } | null {
    if (!deviceId) return null;
    const row = this.#db.prepare("select id, hash from auth_tokens where id = ? and kind = 'device'").get(deviceId) as Row | undefined;
    if (!row) return null;
    const expiresAt = now + PREVIEW_KEY_TTL_MS;
    return { key: previewKeyOf(String(row.id), String(row.hash), botId, path, expiresAt), expiresAt };
  }

  /** The `key` of a preview page opens exactly this Boton's file at this path (as signed, before resolving), unexpired. */
  previewAllowed(given: string | null, botId: string, path: string, now = Date.now()): boolean {
    if (!given) return !this.#opts.enabled;
    const m = /^(.+)\.([0-9a-z]{1,12})\.[A-Za-z0-9_-]+$/.exec(given);
    if (!m) return false;
    const expiresAt = Number.parseInt(m[2], 36);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + PREVIEW_KEY_TTL_MS) return false;
    const row = this.#db.prepare("select id, hash, last_used_at from auth_tokens where id = ? and kind = 'device'").get(m[1]) as Row | undefined;
    if (!row) return false;
    const want = Buffer.from(previewKeyOf(String(row.id), String(row.hash), botId, path, expiresAt));
    const got = Buffer.from(given);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    this.#touch(row);
    return true;
  }

  /** Throws 401 (nobody) or 403 (a Boton out of bounds). */
  authorize(principal: Principal | null, access: RouteAccess, params: Record<string, string>, req: IncomingMessage): void {
    if (access.public) return;
    if (!principal) throw new HttpError(401, this.#unauthorized(req, access));
    if (principal.kind === 'device') return;
    if (!access.boton && !access.anyBoton) throw new HttpError(403, 'A Boton token cannot use this endpoint');
    const owner = access.boton ? access.boton(params) : null;
    if (owner !== null && owner !== principal.botId) throw new HttpError(403, 'That belongs to another Boton');
    if (principal.sandboxed && !access.sandboxed) throw new HttpError(403, SANDBOXED_REFUSAL);
  }

  #unauthorized(req: IncomingMessage, access: RouteAccess): string {
    const token = this.#bearer(req);
    if (token?.startsWith('mmt_')) {
      return "This Boton token is no longer valid: each one lasts a single turn. Run `botons` (the one on your PATH, which has this turn's token) during your current turn; don't save or reuse a token.";
    }
    const device = 'This device is not paired with Botons. Open the web app to pair it (see "Pairing devices" in the README).';
    if (!token && (access.boton || access.anyBoton)) {
      return `${device} A Boton: run \`botons\` from your PATH, which sends this turn's token.`;
    }
    return device;
  }

  /** A method so tests can stand in a tailnet address. */
  remoteAddress(req: IncomingMessage): string {
    return plainAddress(req.socket.remoteAddress ?? '');
  }

  /** The owner's Tailscale device this request comes from. Never loopback or this machine itself: Botons run here. */
  async ownerPeer(req: IncomingMessage): Promise<{ login: string; node: string } | null> {
    const tailnet = this.#opts.tailnet;
    const ip = this.remoteAddress(req);
    if (!tailnet || !ip || isLoopback(ip)) return null;
    const self = await tailnet.self();
    if (!self || self.ips.some((a) => plainAddress(a) === ip)) return null;
    const owner = this.#opts.ownerLogin ?? self.login;
    if (!owner) return null;
    const peer = await tailnet.whois(ip);
    if (!peer || peer.tagged || peer.nodeId === self.nodeId) return null;
    return peer.login.toLowerCase() === owner.toLowerCase() ? { login: peer.login, node: peer.node } : null;
  }

  async status(req: IncomingMessage): Promise<AuthStatus> {
    const p = this.authenticate(req);
    return {
      required: this.#opts.enabled,
      caller: p ? p.kind : 'none',
      deviceId: p?.kind === 'device' ? p.deviceId : null,
      botId: p?.kind === 'boton' ? p.botId : null,
      urlKeys: p?.kind === 'device' ? this.#urlKeys(p.deviceId) : null,
      ownerPairing: p ? null : await this.ownerPeer(req),
      hostname: this.#opts.hostname,
      claimed: this.claimed(),
      pairCommand: pairCommand({ container: !!this.#opts.container }),
    };
  }

  /** A device has paired here at some point (a claim recorded), or one is paired now. */
  claimed(): boolean {
    return !!this.#db.prepare('select 1 from settings where key = ?').get(SETTING_CLAIM) || listDevices(this.#db).length > 0;
  }

  /** The first pairing on a server records its claim: when, and which device. Never replaced. */
  #paired(made: { device: Device; token: string }, method: Paired['method']): Paired {
    const first = this.#db.prepare("select count(*) as n from auth_tokens where kind = 'device'").get()!.n === 1;
    const claim =
      first &&
      Number(
        this.#db
          .prepare('insert into settings(key, value) values (?, ?) on conflict(key) do nothing')
          .run(SETTING_CLAIM, JSON.stringify({ at: made.device.createdAt, deviceId: made.device.id, label: made.device.label })).changes,
      ) > 0;
    // A new server walks its owner through setup until they finish or skip it, even once it has a Boton.
    // One that already has Botons (every device revoked, then a new one paired) is set up already.
    if (claim && !this.#db.prepare('select 1 from bots limit 1').get()) this.#db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do nothing').run(SETTING_SETUP, JSON.stringify({ completedAt: null }));
    return { ...made, method, claim };
  }

  /**
   * A device asks to pair. Anyone may ask, a Boton that leaves out its token included: asking grants nothing
   * until the owner approves the code, which the caller can only show, not approve. Refused under a Boton's
   * token all the same, so a Boton that tries is told plainly.
   */
  requestPairing(req: IncomingMessage, label: unknown): PairingRequest {
    if (this.authenticate(req)?.kind === 'boton') throw new HttpError(403, BOTON_PAIRING);
    const made = createPairingRequest(this.#db, cleanLabel(label));
    return { ...made, approveCommand: approveCommand({ container: !!this.#opts.container }, made.code) };
  }

  /** The owner (a paired device, the route's default) approves the request whose device shows `code`. */
  approvePairing(code: unknown, label: unknown): ApprovedRequest {
    if (typeof code !== 'string' || !normalizeCode(code)) throw new HttpError(400, 'Enter the code the new device shows');
    const approved = approvePairingRequest(this.#db, code, cleanLabel(label));
    if (!approved) throw new HttpError(404, 'No device is waiting with that code. Check it against the new device\'s screen; a code lasts 15 minutes, so the device may need a new one.');
    return approved;
  }

  /**
   * With the secret of a request the owner approved, or with none if the request comes from the owner's
   * Tailscale peer. A code alone pairs nothing. Never under a Boton's token.
   */
  async pair(req: IncomingMessage, input: PairInput): Promise<Paired> {
    if (this.authenticate(req)?.kind === 'boton') throw new HttpError(403, BOTON_PAIRING);
    const label = cleanLabel(input.label);
    const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
    if (secret) {
      purgeRequests(this.#db);
      const hash = hashSecret(secret);
      const used = this.#db.prepare('delete from pairing_requests where secret_hash = ? and approved_at is not null returning label, approved_label').get(hash) as Row | undefined;
      if (!used) {
        if (this.#db.prepare('select 1 from pairing_requests where secret_hash = ?').get(hash)) throw new HttpError(409, 'Waiting for the owner to approve this device.');
        throw new HttpError(400, 'This pairing request is unknown or has expired. Start again for a new code.');
      }
      return this.#paired(createDevice(this.#db, String(used.approved_label ?? '') || String(used.label) || label || 'Paired device'), 'approval');
    }
    if (typeof input.code === 'string' && input.code.trim()) {
      throw new HttpError(400, `A code alone doesn't pair a device. Open Botons on the new device: it shows a code, and you approve that code with \`${approveCommand({ container: !!this.#opts.container })}\` on ${this.#opts.hostname} or from a paired device (Settings → Devices).`);
    }
    const owner = await this.ownerPeer(req);
    if (!owner) {
      throw new HttpError(403, `This device needs your approval. Ask to pair (the web app does), then approve its code with \`${approveCommand({ container: !!this.#opts.container })}\` on ${this.#opts.hostname} or from a paired device (Settings → Devices).`);
    }
    return this.#paired(createDevice(this.#db, [owner.node, label].filter(Boolean).join(' · ')), 'tailscale');
  }

  devices(currentId: string | null): Device[] {
    return listDevices(this.#db, currentId);
  }

  /** Its token stops working and its open event streams end. False if there is no such device. */
  revokeDevice(id: string): boolean {
    const found = deleteDevice(this.#db, id);
    for (const close of [...(this.#streams.get(id) ?? [])]) close();
    this.#streams.delete(id);
    return found;
  }

  /** A token for one turn; revoke() when the turn ends. */
  mintBotonToken(botId: string, opts: { sandboxed?: boolean } = {}): { id: string; token: string; revoke: () => void } {
    const id = newId('mtk');
    const token = newToken('mmt');
    this.#db
      .prepare("insert into auth_tokens (id, hash, kind, bot_id, label, created_at) values (?, ?, 'boton', ?, 'turn', ?)")
      .run(id, hashSecret(token), botId, nowIso());
    if (opts.sandboxed) this.#sandboxed.add(id);
    return {
      id,
      token,
      revoke: () => {
        this.#sandboxed.delete(id);
        try {
          this.#db.prepare('delete from auth_tokens where id = ?').run(id);
        } catch (err) {
          // Only when the database is already closed (shutdown); the next start purges it.
          log.warn(`could not revoke a turn token: ${(err as Error).message}`, { botId });
        }
      },
    };
  }

  /** Turn tokens left by a previous process belong to turns that are gone. */
  purgeBotonTokens(): void {
    this.#db.prepare("delete from auth_tokens where kind = 'boton'").run();
    this.#sandboxed.clear();
  }

  /** Revoking the principal's device calls `close`. Returns the unregister function. */
  trackStream(principal: Principal | null, close: () => void): () => void {
    if (principal?.kind !== 'device' || !principal.deviceId) return () => {};
    const id = principal.deviceId;
    let set = this.#streams.get(id);
    if (!set) this.#streams.set(id, (set = new Set()));
    set.add(close);
    return () => {
      set.delete(close);
      if (!set.size && this.#streams.get(id) === set) this.#streams.delete(id);
    };
  }

  /** False once the principal's token is gone (revoked here, by `npm run pair -- --revoke`, or its turn ended). */
  isLive(principal: Principal | null): boolean {
    if (!principal) return !this.#opts.enabled;
    const id = principal.kind === 'device' ? principal.deviceId : principal.tokenId;
    return id === null || !!this.#db.prepare('select 1 from auth_tokens where id = ?').get(id);
  }
}
