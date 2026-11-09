import { VERSION } from '../../shared/app-version.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { hostOf, OutboundError, outbound } from './outbound.ts';
import { sanitize } from './secrets.ts';

/*
 * The OAuth 2.1 client side of MCP authorization: protected resource metadata (RFC 9728), authorization server
 * metadata (RFC 8414, OpenID discovery as a fallback, both path-aware), dynamic registration of a public client
 * (RFC 7591), PKCE S256, the resource indicator (RFC 8707) on every authorization and token request, and the
 * authorization response's iss (RFC 9207). Nothing here keeps state; OAuthConnections does.
 */

const META_MAX = 128 * 1024;
const TOKEN_MAX = 8192;

export class OAuthError extends Error {
  /** grant: the grant is gone (sign in again); transient: try later; setup: the server can't be used as it is. */
  readonly kind: 'grant' | 'transient' | 'setup';
  /** The token request may have been handled (a refresh token may have rotated). */
  readonly ambiguous: boolean;
  /**
   * `message` is the raw text, foreign parts and all; `secrets` the credentials known to be at stake (those a
   * request sent). It is sanitized here, once: known secrets first, then token-shaped runs, then the cut. A known
   * secret applied only after the token-shaped pass would no longer match (part of it is already "[redacted]"), and
   * the rest of it would show, so pass the credentials here rather than redacting the message afterwards.
   */
  constructor(kind: OAuthError['kind'], message: string, ambiguous = false, secrets: Iterable<string | null | undefined> = []) {
    super(sanitize(message, secrets, 1000));
    this.kind = kind;
    this.ambiguous = ambiguous;
  }
}

export interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported: string[];
  scopes_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface Discovery {
  resource: string;
  issuer: string;
  metadata: ServerMetadata;
  scope: string;
}

/** A URL as RFC 8707 compares resources: no fragment, lowercase scheme and host, no trailing slash. */
export function canonicalResource(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
}

function parseObject(body: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new OAuthError('setup', `${what} is not JSON`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OAuthError('setup', `${what} is not a JSON object`);
  return v as Record<string, unknown>;
}

const httpsUrl = (v: unknown, field: string, allow: string[]): string => {
  if (typeof v !== 'string') throw new OAuthError('setup', `The authorization server's metadata has no ${field}`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new OAuthError('setup', `The authorization server's ${field} is not a URL`);
  }
  const loopbackAllowed = u.protocol === 'http:' && /^(127\.\d+\.\d+\.\d+|\[::1\]|localhost)$/i.test(u.hostname) && allow.some((a) => a === u.hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (u.protocol !== 'https:' && !loopbackAllowed) throw new OAuthError('setup', `The authorization server's ${field} is not HTTPS`);
  if (u.hash || u.username || u.password) throw new OAuthError('setup', `The authorization server's ${field} is not a plain URL`);
  return v;
};

/** `Bearer resource_metadata="…", scope="…"`: the parameters, lowercase names. */
export function bearerChallenge(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(', ') : (header ?? '');
  const m = /Bearer\s+(.*)$/is.exec(raw);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const p of m[1].matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  return out;
}

async function getJson(url: string, allow: string[], what: string): Promise<Record<string, unknown> | null> {
  const res = await outbound(url, { allow, headers: { accept: 'application/json' }, maxBytes: META_MAX });
  if (res.status === 404 || res.status === 405 || res.status === 400 || res.status === 401 || res.status === 403) return null;
  if (res.status !== 200) throw new OAuthError('transient', `${hostOf(url)} answered ${res.status} for its ${what}`);
  return parseObject(res.body, `The ${what} from ${hostOf(url)}`);
}

/** RFC 9728 well-known URLs for `resource`: with its path inserted, then at the root. */
export function resourceMetadataUrls(resource: string): string[] {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, '');
  const urls = path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : [];
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** RFC 8414 then OpenID discovery, path-aware, in the order MCP authorization asks for. */
export function serverMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`];
}

/**
 * From the MCP server's URL to its authorization server: probe it without a token for the 401's challenge, read
 * the protected resource metadata (which must name this very resource), then the server metadata (which must name
 * the issuer it was fetched for and offer S256).
 */
export async function discover(mcpUrl: string, allow: string[]): Promise<Discovery> {
  const want = canonicalResource(mcpUrl);
  let challenge: Record<string, string> = {};
  try {
    const probe = await outbound(mcpUrl, {
      method: 'POST',
      allow,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Botons', version: VERSION } } }),
      maxBytes: META_MAX,
    });
    if (probe.status !== 401) throw new OAuthError('setup', `${hostOf(mcpUrl)} did not ask for sign-in (it answered ${probe.status}); add it as an MCP server with headers instead`);
    challenge = bearerChallenge(probe.headers['www-authenticate']);
  } catch (err) {
    if (err instanceof OutboundError) throw new OAuthError(err.kind === 'refused' || err.kind === 'redirect' ? 'setup' : 'transient', err.message);
    throw err;
  }
  const candidates = challenge.resource_metadata ? [challenge.resource_metadata] : resourceMetadataUrls(mcpUrl);
  let prm: Record<string, unknown> | null = null;
  for (const url of candidates) {
    prm = await wrap(() => getJson(url, allow, 'protected resource metadata'));
    if (prm) break;
  }
  if (!prm) throw new OAuthError('setup', `${hostOf(mcpUrl)} publishes no OAuth protected resource metadata`);
  if (typeof prm.resource !== 'string' || canonicalResource(prm.resource) !== want) {
    throw new OAuthError('setup', `${hostOf(mcpUrl)}'s protected resource metadata is for another resource, so it can't be trusted for this URL`);
  }
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === 'string') : [];
  if (!servers.length) throw new OAuthError('setup', `${hostOf(mcpUrl)} names no authorization server`);
  const issuer = servers[0];
  httpsUrl(issuer, 'issuer', allow);
  let meta: Record<string, unknown> | null = null;
  for (const url of serverMetadataUrls(issuer)) {
    meta = await wrap(() => getJson(url, allow, 'authorization server metadata'));
    if (meta) break;
  }
  if (!meta) throw new OAuthError('setup', `The authorization server ${hostOf(issuer)} publishes no metadata`);
  if (meta.issuer !== issuer) throw new OAuthError('setup', `The authorization server's metadata names another issuer than ${hostOf(issuer)}, so it can't be trusted`);
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string') : [];
  if (!methods.includes('S256')) throw new OAuthError('setup', `The authorization server ${hostOf(issuer)} does not offer PKCE with S256`);
  const metadata: ServerMetadata = {
    issuer,
    authorization_endpoint: httpsUrl(meta.authorization_endpoint, 'authorization_endpoint', allow),
    token_endpoint: httpsUrl(meta.token_endpoint, 'token_endpoint', allow),
    ...(meta.registration_endpoint !== undefined ? { registration_endpoint: httpsUrl(meta.registration_endpoint, 'registration_endpoint', allow) } : {}),
    code_challenge_methods_supported: methods,
    ...(Array.isArray(meta.scopes_supported) ? { scopes_supported: meta.scopes_supported.filter((s): s is string => typeof s === 'string') } : {}),
    ...(meta.authorization_response_iss_parameter_supported === true ? { authorization_response_iss_parameter_supported: true } : {}),
  };
  // The challenge's scope first, else what the resource says it supports (MCP's scope selection).
  const scopes = Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === 'string') : [];
  const scope = (challenge.scope ?? scopes.join(' ')).trim().slice(0, 1000);
  return { resource: prm.resource, issuer, metadata, scope };
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OutboundError) throw new OAuthError(err.kind === 'refused' || err.kind === 'redirect' ? 'setup' : 'transient', err.message);
    throw err;
  }
}

/** RFC 7591: a public client named Botons, for exactly this redirect URI. */
export async function register(meta: ServerMetadata, redirectUri: string, scope: string, allow: string[]): Promise<string> {
  if (!meta.registration_endpoint) throw new OAuthError('setup', `The authorization server ${hostOf(meta.issuer)} does not let clients register themselves`);
  const res = await wrap(() =>
    outbound(meta.registration_endpoint!, {
      method: 'POST',
      allow,
      maxBytes: META_MAX,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Botons',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        ...(scope ? { scope } : {}),
      }),
    }),
  );
  if (res.status !== 201 && res.status !== 200) throw new OAuthError(res.status >= 500 || res.status === 429 ? 'transient' : 'setup', `Registering with ${hostOf(meta.issuer)} failed (${res.status}${errorCode(res.body)})`);
  const out = parseObject(res.body, 'The registration answer');
  if (typeof out.client_id !== 'string' || !out.client_id || out.client_id.length > 500) throw new OAuthError('setup', 'The registration answer has no client_id');
  if (out.token_endpoint_auth_method !== undefined && out.token_endpoint_auth_method !== 'none') throw new OAuthError('setup', `${hostOf(meta.issuer)} registered a confidential client; Botons only uses public ones`);
  if (Array.isArray(out.redirect_uris) && !out.redirect_uris.includes(redirectUri)) throw new OAuthError('setup', `${hostOf(meta.issuer)} registered other redirect URIs`);
  return out.client_id;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(meta: ServerMetadata, p: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string; resource: string }): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  if (p.scope) u.searchParams.set('scope', p.scope);
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', p.resource);
  return u.toString();
}

export interface Tokens {
  accessToken: string;
  /** Null: the server sent none, so the old one stays. */
  refreshToken: string | null;
  expiresInMs: number | null;
  scope: string | null;
}

function errorCode(body: string): string {
  try {
    const e = JSON.parse(body)?.error;
    return typeof e === 'string' && /^[\w.-]{1,60}$/.test(e) ? `: ${e}` : '';
  } catch {
    return '';
  }
}

/** Header-safe, bounded: it goes into an Authorization header. */
const tokenString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= TOKEN_MAX && /^[\x21-\x7e]+$/.test(v);

/**
 * A token endpoint may echo what it was sent: no error from here holds the code, verifier or refresh token, nor
 * `secrets` (credentials not sent but at stake, such as the access token being replaced). Every error is made from
 * the raw text with them, in OAuthError's constructor.
 */
async function tokenRequest(meta: ServerMetadata, form: Record<string, string>, allow: string[], secrets: (string | null | undefined)[] = []): Promise<Tokens> {
  const sent = [form.code, form.code_verifier, form.refresh_token, ...secrets];
  try {
    return await tokenRequestOnce(meta, form, allow, sent);
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError('transient', String((err as Error)?.message ?? err), true, sent);
  }
}

async function tokenRequestOnce(meta: ServerMetadata, form: Record<string, string>, allow: string[], sent: (string | null | undefined)[]): Promise<Tokens> {
  const fail = (kind: OAuthError['kind'], message: string, ambiguous = false) => new OAuthError(kind, message, ambiguous, sent);
  let res;
  try {
    res = await outbound(meta.token_endpoint, {
      method: 'POST',
      allow,
      maxBytes: META_MAX,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    if (err instanceof OutboundError) throw fail(err.kind === 'refused' ? 'setup' : 'transient', err.message, err.sent);
    throw err;
  }
  if (res.status === 400 || res.status === 401) {
    const code = errorCode(res.body);
    // The grant itself is refused: only signing in again helps.
    if (/^: (invalid_grant|invalid_client|unauthorized_client)$/.test(code) || res.status === 401) throw fail('grant', `${hostOf(meta.issuer)} refused the grant (${res.status}${code})`);
    throw fail('setup', `${hostOf(meta.issuer)} refused the token request (${res.status}${code})`);
  }
  // An OAuth error answer (RFC 6749 §5.2) means nothing was issued; a 5xx without one may have come after it was.
  if (res.status !== 200) throw fail('transient', `${hostOf(meta.issuer)} answered ${res.status} to a token request`, res.status >= 500 && !errorCode(res.body));
  let out: Record<string, unknown>;
  try {
    out = parseObject(res.body, 'The token answer');
  } catch {
    throw fail('transient', 'The token answer is not JSON', true);
  }
  if (!tokenString(out.access_token)) throw fail('transient', 'The token answer has no usable access_token', true);
  if (typeof out.token_type !== 'string' || out.token_type.toLowerCase() !== 'bearer') throw fail('setup', 'The token answer is not a bearer token', true);
  if (out.refresh_token !== undefined && !tokenString(out.refresh_token)) throw fail('transient', 'The token answer has an unusable refresh_token', true);
  const expires = typeof out.expires_in === 'number' && Number.isFinite(out.expires_in) && out.expires_in > 0 ? Math.min(out.expires_in, 10 * 365 * 86_400) * 1000 : null;
  return { accessToken: out.access_token, refreshToken: (out.refresh_token as string | undefined) ?? null, expiresInMs: expires, scope: typeof out.scope === 'string' ? out.scope.slice(0, 1000) : null };
}

export function exchangeCode(meta: ServerMetadata, p: { code: string; verifier: string; clientId: string; redirectUri: string; resource: string }, allow: string[]): Promise<Tokens> {
  return tokenRequest(meta, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource }, allow);
}

/** `accessToken`, the one being replaced, isn't sent, but is kept out of any error too. */
export function refreshGrant(meta: ServerMetadata, p: { refreshToken: string; accessToken?: string | null; clientId: string; resource: string }, allow: string[]): Promise<Tokens> {
  return tokenRequest(meta, { grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource }, allow, [p.accessToken]);
}
