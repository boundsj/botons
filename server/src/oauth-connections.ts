import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { OAuthConnection, OAuthConnectionInput, OAuthConnectStart } from '../../shared/types.ts';
import { allowedHostNames, type Config } from './config.ts';
import type { EventHub } from './events.ts';
import { log } from './log.ts';
import type { Notifier } from './notify.ts';
import { authorizeUrl, canonicalResource, discover, exchangeCode, OAuthError, pkce, refreshGrant, register, type ServerMetadata, type Tokens } from './oauth.ts';
import { hostOf, refusedOutbound } from './outbound.ts';
import { sanitize } from './secrets.ts';
import { HttpError, type Store } from './store.ts';
import { newId, nowIso, parseJson, type Row } from './util.ts';
import { offKey, retirePolicy } from './connectors.ts';

/*
 * Remote MCP servers signed in to with OAuth ("oauth:<name>" connectors). Tokens stay in the database and are only
 * read back for the server's own calls and as a turn's Authorization header; the refresh token never leaves here.
 * Each connection has one refresh at a time (turns, the feed and keep-alive share it), and a refresh is saved only
 * if the connection is still the one it started from (same generation and refresh token), in one statement. A refresh
 * is marked as started before it is sent and the mark goes with its outcome, so one whose answer was never saved is
 * never sent again: the connector asks to be signed in again instead.
 */

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_CONNECTIONS = 20;
const FLOW_TTL_MS = 10 * 60_000;
const FLOWS_PER_CONNECTION = 5;
export const KEEPALIVE_MS = 7 * 86_400_000;
const TRANSIENT_WAIT_MS = 5_000;
export const CALLBACK_PATH = '/oauth/callback';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ConnectionRecord {
  id: string;
  name: string;
  url: string;
  status: OAuthConnection['status'];
  generation: number;
  resource: string;
  issuer: string;
  metadata: ServerMetadata | null;
  clientId: string;
  accessToken: string | null;
  accessExpiresAt: string | null;
  accessLifetimeMs: number | null;
  refreshToken: string | null;
  feed: boolean;
  unknownJobs: 'nowhere' | 'primary';
}

export class OAuthConnections {
  #db: DatabaseSync;
  #cfg: Config;
  #store: Store;
  #notifier: Notifier;
  /** One refresh at a time per connection: what is running, if anything. */
  #serial = new Map<string, Promise<unknown>>();
  /** Called after a sign-in completes (the feed detection). */
  onConnected: (id: string) => void = () => {};

  constructor(opts: { db: DatabaseSync; cfg: Config; store: Store; hub: EventHub; notifier: Notifier }) {
    this.#db = opts.db;
    this.#cfg = opts.cfg;
    this.#store = opts.store;
    this.#notifier = opts.notifier;
  }

  get redirectUri(): string | null {
    return this.#cfg.oauth.publicUrl ? `${this.#cfg.oauth.publicUrl}${CALLBACK_PATH}` : null;
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare('select * from oauth_connections where id = ?').get(id) as Row | undefined;
  }

  #toPublic(r: Row): OAuthConnection {
    // Saved already sanitized; sanitized again on the way out, with the tokens the row holds now, so neither a
    // token-shaped run nor a credential too short to look like one (an earlier answer may have echoed it) is shown.
    const clean = (text: string) => sanitize(text, [r.access_token, r.refresh_token]);
    return {
      id: r.id,
      name: r.name,
      url: displayUrl(r.url),
      status: r.status,
      statusReason: r.status_reason ? clean(r.status_reason) : null,
      issuer: r.issuer ? hostOf(r.issuer) : null,
      scope: r.scope || null,
      connectedAt: r.status === 'connected' ? (r.refreshed_at ?? null) : null,
      refreshedAt: r.refreshed_at ?? null,
      refreshError: r.status === 'connected' && r.refresh_error ? clean(r.refresh_error) : null,
      keepConnected: !!r.keep_connected,
      nextKeepAliveAt: r.status === 'connected' && r.keep_connected ? (r.keepalive_at ?? null) : null,
      feed: !!r.feed,
      feedCheckedAt: r.feed_checked_at ?? null,
      feedError: r.feed_error ? clean(r.feed_error) : null,
      unknownJobs: r.unknown_jobs,
      createdAt: r.created_at,
    };
  }

  record(id: string): ConnectionRecord | null {
    const r = this.#row(id);
    return r ? toRecord(r) : null;
  }

  byName(name: string): ConnectionRecord | null {
    const r = this.#db.prepare('select * from oauth_connections where name = ?').get(name) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  records(): ConnectionRecord[] {
    return (this.#db.prepare('select * from oauth_connections order by name').all() as Row[]).map(toRecord);
  }

  list(): OAuthConnection[] {
    return (this.#db.prepare('select * from oauth_connections order by name').all() as Row[]).map((r) => this.#toPublic(r));
  }

  get(id: string): OAuthConnection {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `No OAuth connector with id ${id}`);
    return this.#toPublic(r);
  }

  emit(id: string): OAuthConnection | null {
    const r = this.#row(id);
    if (!r) return null;
    const connection = this.#toPublic(r);
    this.#store.publish({ type: 'oauth.upserted', connection });
    return connection;
  }

  /** `quiet`: published by the caller once it is set up (an import's create and settings are one change). */
  create(input: OAuthConnectionInput, opts: { quiet?: boolean } = {}): OAuthConnection {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME.test(name)) throw new HttpError(400, 'name must be 1-40 lowercase letters, digits, - or _, starting with a letter or digit');
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, "url must be the MCP server's URL, such as https://mcp.example.com/mcp");
    }
    if (parsed.hash) throw new HttpError(400, 'url must not have a #fragment');
    const refused = refusedOutbound(url, this.#cfg.oauth.allow);
    if (refused) throw new HttpError(400, `Botons won't connect to ${hostOf(url)}: ${refused}`);
    if (this.#db.prepare('select 1 from oauth_connections where name = ?').get(name)) throw new HttpError(409, `There is already an OAuth connector named ${name}`);
    if (Number((this.#db.prepare('select count(*) as n from oauth_connections').get() as Row).n) >= MAX_CONNECTIONS) throw new HttpError(409, `At most ${MAX_CONNECTIONS} OAuth connectors`);
    const id = newId('oac');
    const now = nowIso();
    this.#db.prepare("insert into oauth_connections (id, name, url, status, created_at, updated_at) values (?, ?, ?, 'new', ?, ?)").run(id, name, url, now, now);
    log.info('OAuth connector added', { connectionId: id, connector: `oauth:${name}`, host: hostOf(url) });
    return opts.quiet ? this.get(id) : this.emit(id)!;
  }

  update(id: string, input: OAuthConnectionInput, opts: { quiet?: boolean } = {}): OAuthConnection {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `No OAuth connector with id ${id}`);
    if (input.name !== undefined && input.name !== r.name) throw new HttpError(400, "An OAuth connector's name can't change; add a new one instead");
    if (input.url !== undefined && input.url !== r.url) throw new HttpError(400, "An OAuth connector's URL can't change; add a new one instead");
    if (input.keepConnected !== undefined) {
      if (typeof input.keepConnected !== 'boolean') throw new HttpError(400, 'keepConnected must be true or false');
      const at = input.keepConnected ? new Date(Date.now() + KEEPALIVE_MS).toISOString() : null;
      this.#db.prepare('update oauth_connections set keep_connected = ?, keepalive_at = coalesce(?, keepalive_at), updated_at = ? where id = ?').run(input.keepConnected ? 1 : 0, r.keepalive_at ? null : at, nowIso(), id);
    }
    if (input.unknownJobs !== undefined) {
      if (input.unknownJobs !== 'nowhere' && input.unknownJobs !== 'primary') throw new HttpError(400, 'unknownJobs must be "nowhere" or "primary"');
      this.#db.prepare('update oauth_connections set unknown_jobs = ?, updated_at = ? where id = ?').run(input.unknownJobs, nowIso(), id);
    }
    return opts.quiet ? this.get(id) : this.emit(id)!;
  }

  /** Its tokens, flows and work records go with it, and every Boton loses it. */
  delete(id: string): void {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `No OAuth connector with id ${id}`);
    this.#store.atomically(() => {
      this.#db.prepare('delete from oauth_connections where id = ?').run(id);
      retirePolicy(this.#db, `oauth:${r.name}`);
      this.#db.prepare('delete from settings where key = ?').run(offKey(`oauth:${r.name}`));
      this.#store.dropFromBots('connections', `oauth:${r.name}`);
    });
    this.#store.publish({ type: 'oauth.deleted', id });
    log.info('OAuth connector removed', { connectionId: id, connector: `oauth:${r.name}` });
  }

  // ------------------------------------------------------------- sign-in

  /** Where the callback may send the browser back to: an origin the app is served at, else its public URL. */
  #returnTo(raw: unknown): string {
    const fallback = this.#cfg.publicUrl;
    if (typeof raw !== 'string' || raw.length > 300) return fallback;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return fallback;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return fallback;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const ok = allowedHostNames(this.#cfg).has(host) || (isIP(host) > 0 && (host.startsWith('127.') || host === '::1' || this.#cfg.urls.some((x) => new URL(x).hostname.replace(/^\[|\]$/g, '') === host)));
    return ok ? u.origin : fallback;
  }

  /** A paired device starts a sign-in: discovery, a registered client (reused when it fits), a fresh state and PKCE verifier. */
  async startConnect(id: string, deviceId: string | null, returnTo: unknown): Promise<OAuthConnectStart> {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `No OAuth connector with id ${id}`);
    if (!deviceId) throw new HttpError(403, 'Connect from a paired device');
    const redirectUri = this.redirectUri;
    if (!redirectUri) {
      throw new HttpError(
        409,
        'Set BOTONS_OAUTH_PUBLIC_URL to an HTTPS address that reaches this server\'s /oauth/callback (see "OAuth connectors" in the README), then restart Botons.',
      );
    }
    const allow = this.#cfg.oauth.allow;
    let found;
    try {
      found = await discover(r.url, allow);
    } catch (err) {
      throw new HttpError(err instanceof OAuthError && err.kind === 'transient' ? 502 : 400, `Can't sign in to ${r.name}: ${sanitize((err as Error).message)}`);
    }
    const clientFor = `${found.issuer} ${redirectUri}`;
    let clientId = r.client_for === clientFor && r.client_id ? String(r.client_id) : '';
    if (!clientId) {
      const pending = this.#db.prepare('select client_id from oauth_flows where connection_id = ? and issuer = ? and redirect_uri = ? order by created_at desc limit 1').get(id, found.issuer, redirectUri) as Row | undefined;
      clientId = pending?.client_id ?? '';
    }
    if (!clientId) {
      try {
        clientId = await register(found.metadata, redirectUri, found.scope, allow);
      } catch (err) {
        throw new HttpError(err instanceof OAuthError && err.kind === 'transient' ? 502 : 400, `Can't sign in to ${r.name}: ${sanitize((err as Error).message)}`);
      }
      log.info('registered Botons with an authorization server', { connectionId: id, issuer: hostOf(found.issuer) });
    }
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkce();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + FLOW_TTL_MS).toISOString();
    this.#store.atomically(() => {
      this.#db.prepare('delete from oauth_flows where expires_at <= ?').run(now.toISOString());
      const old = this.#db.prepare('select state_hash from oauth_flows where connection_id = ? order by created_at desc').all(id) as Row[];
      for (const f of old.slice(FLOWS_PER_CONNECTION - 1)) this.#db.prepare('delete from oauth_flows where state_hash = ?').run(f.state_hash);
      this.#db
        .prepare(
          'insert into oauth_flows (state_hash, connection_id, device_id, generation, issuer, resource, metadata, scope, client_id, redirect_uri, code_verifier, return_to, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(sha(state), id, deviceId, r.generation, found.issuer, found.resource, JSON.stringify(found.metadata), found.scope, clientId, redirectUri, verifier, this.#returnTo(returnTo), now.toISOString(), expiresAt);
    });
    log.info('OAuth sign-in started', { connectionId: id, deviceId, issuer: hostOf(found.issuer) });
    return { authorizeUrl: authorizeUrl(found.metadata, { clientId, redirectUri, scope: found.scope, state, challenge, resource: found.resource }), expiresAt };
  }

  /**
   * GET /oauth/callback, with no device token (the browser comes back from the authorization server). The state is
   * claimed once, atomically; then everything it was bound to must still hold before the code is redeemed.
   */
  async callback(query: URLSearchParams): Promise<{ ok: boolean; message: string; returnTo: string; name: string | null }> {
    const fallback = this.#cfg.publicUrl;
    const state = query.get('state') ?? '';
    const fail = (message: string, returnTo = fallback, name: string | null = null) => ({ ok: false, message, returnTo, name });
    if (!state || state.length > 200) return fail('This sign-in link is not valid. Start again from Settings → Connectors.');
    const flow = this.#db.prepare('delete from oauth_flows where state_hash = ? returning *').get(sha(state)) as Row | undefined;
    if (!flow) return fail('This sign-in was already used, or it is not one Botons started. Start again from Settings → Connectors.');
    const returnTo = String(flow.return_to);
    const conn = this.#row(flow.connection_id);
    const name = conn ? String(conn.name) : null;
    const fields = { connectionId: flow.connection_id, deviceId: flow.device_id };
    if (flow.expires_at <= nowIso()) return fail('This sign-in took too long and expired. Start again from Settings → Connectors.', returnTo, name);
    if (!conn) return fail('That connector was deleted.', returnTo);
    if (!this.#db.prepare("select 1 from auth_tokens where id = ? and kind = 'device'").get(flow.device_id)) {
      log.warn('OAuth callback refused: the device that started it is no longer paired', fields);
      return fail('The device that started this sign-in is no longer paired.', returnTo, name);
    }
    if (Number(conn.generation) !== Number(flow.generation)) return fail(`${name} was signed in again since this sign-in started. Nothing changed.`, returnTo, name);
    const metadata = parseJson<ServerMetadata | null>(flow.metadata, null);
    if (!metadata || metadata.issuer !== flow.issuer) return fail('This sign-in is not valid.', returnTo, name);
    const iss = query.get('iss');
    if (iss !== null ? iss !== flow.issuer : metadata.authorization_response_iss_parameter_supported === true) {
      log.warn('OAuth callback refused: the authorization response came from another issuer', fields);
      return fail('The answer did not come from the authorization server this sign-in was for, so it was not used.', returnTo, name);
    }
    if (canonicalResource(flow.resource) !== canonicalResource(conn.url)) return fail('This sign-in is for another resource.', returnTo, name);
    const error = query.get('error');
    if (error) {
      const code = /^[\w.-]{1,60}$/.test(error) ? error : 'error';
      log.info('OAuth sign-in declined at the authorization server', { ...fields, error: code });
      return fail(code === 'access_denied' ? `Signing in to ${name} was declined.` : `Signing in to ${name} failed (${code}).`, returnTo, name);
    }
    const code = query.get('code') ?? '';
    if (!code || code.length > 2000) return fail('The authorization server sent no code.', returnTo, name);
    let tokens: Tokens;
    try {
      tokens = await exchangeCode(metadata, { code, verifier: flow.code_verifier, clientId: flow.client_id, redirectUri: flow.redirect_uri, resource: flow.resource }, this.#cfg.oauth.allow);
    } catch (err) {
      const why = sanitize((err as Error).message, [code, flow.code_verifier]);
      log.warn('OAuth code exchange failed', { ...fields, error: why });
      return fail(`Signing in to ${name} failed: ${why}`, returnTo, name);
    }
    if (!tokens.refreshToken) log.info('the authorization server issued no refresh token: the connector needs signing in again when the access token expires', fields);
    const now = Date.now();
    // Checked again with the save: the device may have been unpaired while the code was being redeemed.
    const saved = this.#store.atomically((): 'saved' | 'unpaired' | 'changed' => {
      if (!this.#db.prepare("select 1 from auth_tokens where id = ? and kind = 'device'").get(flow.device_id)) return 'unpaired';
      const changed = this.#db
        .prepare(
          `update oauth_connections set status = 'connected', status_reason = null, generation = generation + 1, resource = ?, issuer = ?, as_metadata = ?, client_id = ?, client_for = ?, scope = ?,
             access_token = ?, access_expires_at = ?, access_lifetime_ms = ?, refresh_token = ?, refreshed_at = ?, refresh_error = null, refresh_error_kind = null, refresh_retry_at = null, refresh_started_at = null,
             keepalive_at = case when keep_connected = 1 then ? else keepalive_at end, notified_generation = null, updated_at = ?
           where id = ? and generation = ?`,
        )
        .run(
          flow.resource,
          flow.issuer,
          JSON.stringify(metadata),
          flow.client_id,
          `${flow.issuer} ${flow.redirect_uri}`,
          tokens.scope ?? flow.scope,
          tokens.accessToken,
          tokens.expiresInMs ? new Date(now + tokens.expiresInMs).toISOString() : null,
          tokens.expiresInMs,
          tokens.refreshToken,
          new Date(now).toISOString(),
          new Date(now + KEEPALIVE_MS).toISOString(),
          nowIso(),
          flow.connection_id,
          flow.generation,
        ).changes;
      // Older sign-ins for it can't complete any more.
      if (!Number(changed)) return 'changed';
      this.#db.prepare('delete from oauth_flows where connection_id = ?').run(flow.connection_id);
      return 'saved';
    });
    if (saved === 'unpaired') {
      log.warn('OAuth sign-in discarded: the device that started it was unpaired while it finished', fields);
      return fail('The device that started this sign-in is no longer paired.', returnTo, name);
    }
    if (saved === 'changed') return fail(`${name} was signed in again since this sign-in started. Nothing changed.`, returnTo, name);
    log.info('OAuth connector signed in', { ...fields, issuer: hostOf(flow.issuer) });
    this.emit(flow.connection_id);
    try {
      this.onConnected(flow.connection_id);
    } catch (err) {
      log.warn('could not start looking at a signed-in connector', { ...fields, err });
    }
    return { ok: true, message: `${name} is connected.`, returnTo, name };
  }

  // ------------------------------------------------------------- tokens

  /** Run `fn` after whatever this connection is already running: one refresh at a time. */
  #one<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#serial.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.#serial.set(id, next);
    void next.catch(() => {}).then(() => {
      if (this.#serial.get(id) === next) this.#serial.delete(id);
    });
    return next;
  }

  /**
   * An access token good for at least `forMs` (capped at half its lifetime), refreshing first if needed. Throws an
   * OAuthError: grant when the connector must be signed in to again.
   */
  accessToken(id: string, forMs: number): Promise<string> {
    return this.#one(id, async () => {
      const c = this.record(id);
      if (!c) throw new OAuthError('setup', 'The connector was deleted');
      if (c.status !== 'connected' || !c.accessToken) throw new OAuthError('grant', `${c.name} is not connected: sign in again in Settings → Connectors`);
      if (fresh(c, forMs)) return c.accessToken;
      return this.#refresh(c, 'expiring');
    });
  }

  /** The token `stale` was refused: refresh, unless another caller already did. */
  replaceToken(id: string, stale: string): Promise<string> {
    return this.#one(id, async () => {
      const c = this.record(id);
      if (!c) throw new OAuthError('setup', 'The connector was deleted');
      if (c.status !== 'connected' || !c.accessToken) throw new OAuthError('grant', `${c.name} is not connected`);
      if (c.accessToken !== stale) return c.accessToken;
      return this.#refresh(c, 'refused');
    });
  }

  #keeping = new Set<string>();

  /** Keep-alive: refresh now, so the grant doesn't lapse while unused. A failure tries again in an hour. */
  keepAlive(id: string): Promise<void> {
    if (this.#keeping.has(id)) return Promise.resolve();
    this.#keeping.add(id);
    return this.#one(id, async () => {
      const c = this.record(id);
      if (!c || c.status !== 'connected') return;
      await this.#refresh(c, 'keep-alive');
    })
      .catch((err) => {
        log.info('keep-alive refresh failed', { connectionId: id, error: this.safeError(id, err) });
        this.#db.prepare('update oauth_connections set keepalive_at = ? where id = ? and keepalive_at <= ?').run(new Date(Date.now() + 3_600_000).toISOString(), id, nowIso());
      })
      .finally(() => this.#keeping.delete(id));
  }

  /** Connections whose weekly refresh is due. */
  keepAliveDue(now = new Date()): string[] {
    return (this.#db.prepare("select id from oauth_connections where status = 'connected' and keep_connected = 1 and keepalive_at is not null and keepalive_at <= ?").all(now.toISOString()) as Row[]).map((r) => r.id);
  }

  /** Inside #one. */
  async #refresh(c: ConnectionRecord, why: string): Promise<string> {
    const fields = { connectionId: c.id, reason: why };
    if (!c.refreshToken || !c.metadata) {
      this.#grantLost(c, 'The access token expired and the server gave no refresh token');
      throw new OAuthError('grant', `${c.name} needs signing in again`);
    }
    const state = this.#db.prepare('select refresh_retry_at, refresh_started_at from oauth_connections where id = ?').get(c.id) as Row | undefined;
    // #one runs one refresh at a time here, so a refresh still marked as started was cut off by a stop or crash.
    if (state?.refresh_started_at) throw this.#interrupted(c);
    if (state?.refresh_retry_at && state.refresh_retry_at > nowIso()) throw new OAuthError('transient', `${c.name}: the last refresh failed; trying again shortly`);
    // Saved before the request goes out: if this process stops before the answer is saved, the server may have
    // rotated the refresh token already, and a server that detects reuse revokes the whole grant when the old one
    // is sent again. The next start finds the mark and asks for a new sign-in instead of sending it.
    const marked = this.#db
      .prepare("update oauth_connections set refresh_started_at = ?, updated_at = ? where id = ? and generation = ? and refresh_token = ? and status = 'connected' and refresh_started_at is null")
      .run(nowIso(), nowIso(), c.id, c.generation, c.refreshToken).changes;
    if (!Number(marked)) {
      const now2 = this.record(c.id);
      if (now2?.status === 'connected' && now2.accessToken) return now2.accessToken;
      throw new OAuthError('grant', `${c.name} is not connected`);
    }
    let tokens: Tokens;
    try {
      tokens = await refreshGrant(c.metadata, { refreshToken: c.refreshToken, accessToken: c.accessToken, clientId: c.clientId, resource: c.resource }, this.#cfg.oauth.allow);
    } catch (err) {
      // Anything but a classified answer may have come after the request was carried out. refreshGrant's errors are
      // already sanitized from the raw answer with both tokens; anything else is, here, the same way.
      const e = err instanceof OAuthError ? err : new OAuthError('transient', String((err as Error)?.message ?? err), true, [c.accessToken, c.refreshToken]);
      if (e.kind === 'grant') {
        this.#grantLost(c, e.message);
        log.warn('OAuth refresh refused: the connector needs signing in again', { ...fields, error: e.message });
      } else if (e.ambiguous) {
        // The request may have been carried out and its answer lost: the server may have rotated the refresh token,
        // and a server that detects reuse revokes the whole grant when the old one is sent again. So it never is.
        this.#grantLost(c, `A token refresh got no usable answer (${e.message}), so it can't safely be repeated`);
        log.warn('OAuth refresh answer lost: the refresh token is not used again; the connector needs signing in again', { ...fields, error: e.message });
        throw new OAuthError('grant', `${c.name} needs signing in again: a token refresh got no usable answer`);
      } else {
        // The server answered with an error, or was never reached: the refresh token is unchanged.
        this.#db
          .prepare('update oauth_connections set refresh_error = ?, refresh_error_kind = ?, refresh_retry_at = ?, refresh_started_at = null, updated_at = ? where id = ? and generation = ?')
          .run(e.message, 'transient', new Date(Date.now() + TRANSIENT_WAIT_MS).toISOString(), nowIso(), c.id, c.generation);
        this.emit(c.id);
        log.warn('OAuth refresh failed; the grant is kept', { ...fields, error: e.message });
      }
      throw e;
    }
    const now = Date.now();
    const changed = this.#db
      .prepare(
        `update oauth_connections set access_token = ?, access_expires_at = ?, access_lifetime_ms = ?, refresh_token = ?, scope = coalesce(?, scope), refreshed_at = ?,
           refresh_error = null, refresh_error_kind = null, refresh_retry_at = null, refresh_started_at = null, keepalive_at = case when keep_connected = 1 then ? else keepalive_at end, updated_at = ?
         where id = ? and generation = ? and refresh_token = ? and status = 'connected'`,
      )
      .run(
        tokens.accessToken,
        tokens.expiresInMs ? new Date(now + tokens.expiresInMs).toISOString() : null,
        tokens.expiresInMs,
        tokens.refreshToken ?? c.refreshToken,
        tokens.scope,
        new Date(now).toISOString(),
        new Date(now + KEEPALIVE_MS).toISOString(),
        nowIso(),
        c.id,
        c.generation,
        c.refreshToken,
      ).changes;
    if (!Number(changed)) {
      // Signed in again (or deleted) meanwhile: the newer grant wins; this pair is dropped.
      log.info('OAuth refresh discarded: the connector changed while it ran', fields);
      const now2 = this.record(c.id);
      if (now2?.status === 'connected' && now2.accessToken) return now2.accessToken;
      throw new OAuthError('grant', `${c.name} is not connected`);
    }
    log.info('OAuth token refreshed', { ...fields, rotated: !!tokens.refreshToken });
    this.emit(c.id);
    return tokens.accessToken;
  }

  /** A refresh that was sent but whose answer was never saved: its refresh token is never sent again. */
  #interrupted(c: ConnectionRecord): OAuthError {
    this.#grantLost(c, 'A token refresh was cut off before its answer was saved, so it can’t safely be repeated');
    log.warn('OAuth refresh interrupted: the refresh token is not used again; the connector needs signing in again', { connectionId: c.id });
    return new OAuthError('grant', `${c.name} needs signing in again: a token refresh was cut off`);
  }

  /** At start: connectors whose refresh was cut off by a stop or crash need signing in again. */
  recoverInterrupted(): number {
    let n = 0;
    for (const r of this.#db.prepare("select * from oauth_connections where refresh_started_at is not null and status = 'connected'").all() as Row[]) {
      this.#interrupted(toRecord(r));
      n++;
    }
    // A connection that isn't connected keeps no tokens; the mark means nothing there.
    this.#db.prepare("update oauth_connections set refresh_started_at = null where refresh_started_at is not null and status <> 'connected'").run();
    return n;
  }

  /** The grant is gone: Reconnect, and the Botons that have it hear once per sign-in. */
  #grantLost(c: ConnectionRecord, why: string): void {
    const reason = sanitize(why, [c.accessToken, c.refreshToken]);
    const notify = this.#store.atomically(() => {
      const changed = this.#db
        .prepare(
          "update oauth_connections set status = 'reconnect', status_reason = ?, access_token = null, access_expires_at = null, refresh_token = null, refresh_error = null, refresh_error_kind = null, refresh_retry_at = null, refresh_started_at = null, updated_at = ? where id = ? and generation = ? and status = 'connected'",
        )
        .run(reason, nowIso(), c.id, c.generation).changes;
      if (!Number(changed)) return false;
      const claimed = this.#db.prepare('update oauth_connections set notified_generation = generation where id = ? and (notified_generation is null or notified_generation <> generation)').run(c.id).changes;
      if (!Number(claimed)) return false;
      const id = `oauth:${c.name}`;
      for (const b of this.#store.listBots()) {
        if (!b.connections.includes(id)) continue;
        this.#store.addMessage(b.id, 'event', `${c.name} needs signing in again: its connector is off until ${this.#store.getSettings().ownerName} reconnects it in Settings → Connectors`, {
          kind: 'connector.reconnect',
          connectorId: id,
        });
      }
      return true;
    });
    this.emit(c.id);
    if (notify) {
      void this.#notifier
        .push({ bot: null, reason: 'failure', detail: `The connector ${c.name} needs signing in again (Settings → Connectors).`, generic: 'A connector needs signing in again.', priority: 'default' })
        .catch((err) => log.warn('could not push about a connector that needs signing in', { connectionId: c.id, err }));
    }
  }

  /** An error's text for a log line or a saved status: without this connector's tokens or anything token-shaped. */
  safeError(id: string, err: unknown): string {
    const c = this.record(id);
    return sanitize(typeof err === 'string' ? err : ((err as Error)?.message ?? String(err)), [c?.accessToken, c?.refreshToken]);
  }

  /** The feed's findings. */
  setFeed(id: string, patch: { feed?: boolean; cursor?: string | null; ready?: boolean; error?: string | null }): void {
    const sets: string[] = ['feed_checked_at = ?'];
    const vals: (string | number | null)[] = [nowIso()];
    if (patch.feed !== undefined) {
      sets.push('feed = ?');
      vals.push(patch.feed ? 1 : 0);
    }
    if (patch.cursor !== undefined) {
      sets.push('feed_cursor = ?');
      vals.push(patch.cursor);
    }
    if (patch.ready !== undefined) {
      sets.push('feed_ready = ?');
      vals.push(patch.ready ? 1 : 0);
    }
    if (patch.error !== undefined) {
      sets.push('feed_error = ?');
      vals.push(patch.error === null ? null : this.safeError(id, patch.error));
    }
    this.#db.prepare(`update oauth_connections set ${sets.join(', ')} where id = ?`).run(...vals, id);
    this.emit(id);
  }

  /** A cursor and whether its first catch-up is done. */
  feedState(id: string): { cursor: string | null; ready: boolean } {
    const r = this.#row(id);
    return { cursor: r?.feed_cursor ?? null, ready: !!r?.feed_ready };
  }
}

function toRecord(r: Row): ConnectionRecord {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    status: r.status,
    generation: Number(r.generation),
    resource: r.resource || r.url,
    issuer: r.issuer,
    metadata: metadataOf(r.as_metadata),
    clientId: r.client_id,
    accessToken: r.access_token ?? null,
    accessExpiresAt: r.access_expires_at ?? null,
    accessLifetimeMs: r.access_lifetime_ms ?? null,
    refreshToken: r.refresh_token ?? null,
    feed: !!r.feed,
    unknownJobs: r.unknown_jobs,
  };
}

function metadataOf(raw: string): ServerMetadata | null {
  const m = parseJson<ServerMetadata | null>(raw, null);
  return m?.token_endpoint && m.issuer ? m : null;
}

/** Good for `forMs` more, or half its lifetime when that is shorter. Unknown expiry: good until it is refused. */
function fresh(c: ConnectionRecord, forMs: number): boolean {
  if (!c.accessExpiresAt) return true;
  const need = c.accessLifetimeMs ? Math.min(forMs, c.accessLifetimeMs / 2) : forMs;
  return new Date(c.accessExpiresAt).getTime() - Date.now() > need;
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(invalid URL)';
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page the browser lands on after the authorization server: no code, state or token in it, nothing cached, no
 * referrer sent on (its own URL holds the code), and a link back to the app.
 */
export function callbackPage(r: { ok: boolean; message: string; returnTo: string; name: string | null }): { status: number; headers: Record<string, string>; body: string } {
  const back = new URL(r.returnTo);
  back.pathname = '/';
  back.search = '';
  if (r.name && NAME.test(r.name)) {
    back.searchParams.set('connector', r.name);
    back.searchParams.set('signin', r.ok ? 'connected' : 'failed');
  }
  const href = escapeHtml(back.toString());
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Botons</title>${r.ok ? `<meta http-equiv="refresh" content="1; url=${href}">` : ''}<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#1d1d1f}a{color:#0b63ce}</style></head><body><h1>${r.ok ? 'Connected' : 'Not connected'}</h1><p>${escapeHtml(r.message)}</p><p><a href="${href}">Back to Botons</a></p></body></html>`;
  return {
    status: r.ok ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    body,
  };
}
