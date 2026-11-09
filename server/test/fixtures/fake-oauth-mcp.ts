// A stand-in for a remote MCP server behind OAuth (in the shape of a fleet gateway): protected resource metadata,
// an authorization server on a path (/as), dynamic registration, PKCE, refresh rotation, and an MCP endpoint with
// paginated tools/list and an optional work_feed. Plain HTTP on 127.0.0.1, which the tests allow.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** A work_feed event as a fleet gateway returns it (its eventView plus the job's project, title and host). */
export interface FeedEvent {
  cursor: string;
  jobId: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  code: string | null;
  at: string;
  project: string;
  title: string;
  host: string;
  projectId: string | null;
}

/** An event in that shape: the given fields, the rest as a gateway fills them. */
export function feedEvent(cursor: number, jobId: string, type: string, fromState: string | null, toState: string | null, extra: Partial<FeedEvent> = {}): FeedEvent {
  return { cursor: String(cursor), jobId, type, fromState, toState, reason: null, code: null, at: '2026-11-05T10:00:00.000Z', project: 'app', title: `Work [job:${jobId}]`, host: 'myhost', projectId: null, ...extra };
}

export interface FakeOAuthMcp {
  base: string;
  mcpUrl: string;
  issuer: string;
  /** Registrations made, with the body each sent. */
  registrations: Record<string, unknown>[];
  /** Authorization requests the "browser" made, as their query. */
  authorizations: URLSearchParams[];
  /** Token requests, as their form. */
  tokenRequests: URLSearchParams[];
  /** MCP requests with the bearer token each carried. */
  mcpCalls: { method: string; token: string | null }[];
  feedCalls: Record<string, unknown>[];
  /** Options the tests change as they go. */
  opts: {
    feed: boolean;
    expiresIn: number | null;
    /**
     * Next token request answers this way: 'drop' closes the socket after reading it; 'drop-after-rotate' carries a
     * refresh out (the old token is spent) and then closes the socket; 'bare_500' answers 500 with no OAuth error.
     */
    tokenFault: null | 'drop' | 'drop-after-rotate' | 'invalid_grant' | 'server_error' | 'bare_500';
    /** Refresh token reuse detection: a spent refresh token sent again revokes its whole grant. */
    strictReuse: boolean;
    tokenDelayMs: number;
    issueRefresh: boolean;
    /** The PRM well-known answers with a redirect to this URL. */
    prmRedirect: string | null;
    prmResource: string | null;
    asIssuer: string | null;
    s256: boolean;
    iss: 'right' | 'wrong' | 'none';
    issSupported: boolean;
    pageSize: number;
    /** tools/list echoes the bearer token back: in a JSON-RPC error, or as a tool's name. */
    reflectToken: null | 'error' | 'tool';
  };
  events: FeedEvent[];
  attention: Record<string, unknown>[];
  /** Job views work_status answers with, by job id; any other job id is an error answer, as for a job not this grant's. */
  jobs: Record<string, Record<string, unknown>>;
  /** work_status calls, with the job id and the bearer token each carried. */
  statusCalls: { jobId: string; token: string | null }[];
  /** Fails the next work_status calls (as a JSON-RPC error) while above 0. */
  statusFailures: number;
  /** Fails the next work_feed calls (as a JSON-RPC error) while above 0. */
  feedFailures: number;
  /** Grants revoked because a spent refresh token was sent again. */
  familiesRevoked: number;
  /** Token requests from now on (of one grant type, or all) wait, after being recorded, until the returned function is called. */
  holdTokens(grantType?: string): () => void;
  /** tools/list requests from now on wait until the returned function is called; `listed` resolves when one arrives. */
  holdToolsList(): { listed: Promise<void>; release: () => void };
  holdInitialize(): { listed: Promise<void>; release: () => void };
  /** work_feed calls from now on wait, after being recorded, until `release`; `called` resolves when one arrives. */
  holdFeed(): { called: Promise<void>; release: () => void };
  /** Access tokens no longer accepted (revoked at the server). */
  revoked: Set<string>;
  /** The browser's part: GET the authorize URL; returns where it redirects (the callback URL with code, state, iss). */
  approve(authorizeUrl: string, opts?: { deny?: boolean }): Promise<URL>;
  close(): Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

export async function fakeOAuthMcp(port: number): Promise<FakeOAuthMcp> {
  const base = `http://127.0.0.1:${port}`;
  const issuer = `${base}/as`;
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string }>();
  const clients = new Map<string, string[]>();
  // Each token belongs to a grant (a "family"): a sign-in starts one, refreshes continue it.
  const refresh = new Map<string, { clientId: string; family: number }>();
  const spent = new Map<string, number>();
  const access = new Map<string, number>();
  const revokedFamilies = new Set<number>();
  let families = 0;
  let hold: { done: Promise<void>; grantType?: string } | null = null;
  let initializeHold: { done: Promise<void>; arrived: () => void } | null = null;
  let toolsHold: { done: Promise<void>; arrived: () => void } | null = null;
  let feedHold: { done: Promise<void>; arrived: () => void } | null = null;
  const fake: FakeOAuthMcp = {
    base,
    mcpUrl: `${base}/mcp`,
    issuer,
    registrations: [],
    authorizations: [],
    tokenRequests: [],
    mcpCalls: [],
    feedCalls: [],
    opts: {
      feed: true,
      expiresIn: 3600,
      tokenFault: null,
      strictReuse: false,
      tokenDelayMs: 0,
      issueRefresh: true,
      prmRedirect: null,
      prmResource: null,
      asIssuer: null,
      s256: true,
      iss: 'right',
      issSupported: true,
      pageSize: 50,
      reflectToken: null,
    },
    events: [],
    attention: [],
    jobs: {},
    statusCalls: [],
    statusFailures: 0,
    feedFailures: 0,
    familiesRevoked: 0,
    revoked: new Set(),
    holdTokens(grantType) {
      let release!: () => void;
      const held = { done: new Promise<void>((r) => (release = r)), grantType };
      hold = held;
      return () => {
        if (hold === held) hold = null;
        release();
      };
    },
    holdToolsList() {
      let release!: () => void;
      let arrived!: () => void;
      const listed = new Promise<void>((r) => (arrived = r));
      const held = { done: new Promise<void>((r) => (release = r)), arrived };
      toolsHold = held;
      return {
        listed,
        release: () => {
          if (toolsHold === held) toolsHold = null;
          release();
        },
      };
    },
    holdInitialize() {
      let release!: () => void;
      let arrived!: () => void;
      const listed = new Promise<void>((r) => (arrived = r));
      const held = { done: new Promise<void>((r) => (release = r)), arrived };
      initializeHold = held;
      return {
        listed,
        release: () => {
          if (initializeHold === held) initializeHold = null;
          release();
        },
      };
    },
    holdFeed() {
      let release!: () => void;
      let arrived!: () => void;
      const called = new Promise<void>((r) => (arrived = r));
      const held = { done: new Promise<void>((r) => (release = r)), arrived };
      feedHold = held;
      return {
        called,
        release: () => {
          if (feedHold === held) feedHold = null;
          release();
        },
      };
    },
    async approve(authorizeUrl, o = {}) {
      const res = await fetch(authorizeUrl, { redirect: 'manual' });
      if (res.status !== 302) throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
      const to = new URL(res.headers.get('location')!);
      if (o.deny) {
        to.searchParams.delete('code');
        to.searchParams.set('error', 'access_denied');
      }
      return to;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const issue = (clientId: string, family = ++families) => {
    const at = `at_${randomBytes(12).toString('hex')}`;
    access.set(at, family);
    const out: Record<string, unknown> = { access_token: at, token_type: 'Bearer', scope: 'fleet:read fleet:operate' };
    if (fake.opts.expiresIn !== null) out.expires_in = fake.opts.expiresIn;
    if (fake.opts.issueRefresh) {
      const rt = `rt_${randomBytes(12).toString('hex')}`;
      refresh.set(rt, { clientId, family });
      out.refresh_token = rt;
    }
    return out;
  };

  const tools = () => {
    const list: { name: string; inputSchema: Record<string, unknown> }[] = [
      { name: 'fleet_status', inputSchema: { type: 'object', properties: {} } },
      { name: 'work_start', inputSchema: { type: 'object', properties: { task: { type: 'string' }, requestId: { type: 'string' } } } },
      { name: 'work_status', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } } } },
    ];
    if (fake.opts.feed) {
      list.push({
        name: 'work_feed',
        inputSchema: {
          type: 'object',
          properties: { cursor: { anyOf: [{ type: 'string', pattern: '^\\d{1,15}$' }, { type: 'integer', minimum: 0 }] }, limit: { type: 'integer', minimum: 1, maximum: 200 }, mine: { type: 'boolean' } },
        },
      });
    }
    return list;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base);
    const body = req.method === 'POST' ? await readBody(req) : '';
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      if (fake.opts.prmRedirect) {
        res.writeHead(302, { location: fake.opts.prmRedirect });
        return res.end();
      }
      return json(res, 200, { resource: fake.opts.prmResource ?? `${base}/mcp`, authorization_servers: [issuer], scopes_supported: ['fleet:read', 'fleet:operate'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server/as') {
      return json(res, 200, {
        issuer: fake.opts.asIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        code_challenge_methods_supported: fake.opts.s256 ? ['S256'] : ['plain'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(fake.opts.issSupported ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }
    if (url.pathname === '/as/register' && req.method === 'POST') {
      const reg = JSON.parse(body);
      fake.registrations.push(reg);
      const id = `client_${fake.registrations.length}`;
      clients.set(id, reg.redirect_uris);
      return json(res, 201, { client_id: id, client_name: reg.client_name, redirect_uris: reg.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (url.pathname === '/as/authorize') {
      const q = url.searchParams;
      fake.authorizations.push(q);
      const redirect = q.get('redirect_uri') ?? '';
      if (!clients.get(q.get('client_id') ?? '')?.includes(redirect)) return json(res, 400, { error: 'invalid_request' });
      if (q.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = `code_${randomBytes(8).toString('hex')}`;
      codes.set(code, { clientId: q.get('client_id')!, challenge: q.get('code_challenge')!, redirectUri: redirect, resource: q.get('resource') ?? '' });
      const to = new URL(redirect);
      to.searchParams.set('code', code);
      to.searchParams.set('state', q.get('state') ?? '');
      if (fake.opts.iss !== 'none') to.searchParams.set('iss', fake.opts.iss === 'right' ? issuer : 'https://other.example.com');
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (url.pathname === '/as/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      fake.tokenRequests.push(form);
      if (fake.opts.tokenDelayMs) await new Promise((r) => setTimeout(r, fake.opts.tokenDelayMs));
      if (hold && (!hold.grantType || hold.grantType === form.get('grant_type'))) await hold.done;
      const fault = fake.opts.tokenFault;
      fake.opts.tokenFault = null;
      if (fault === 'drop') return req.socket.destroy();
      if (fault === 'server_error') return json(res, 503, { error: 'temporarily_unavailable' });
      if (fault === 'bare_500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('Internal Server Error');
      }
      if (fault === 'invalid_grant') return json(res, 400, { error: 'invalid_grant' });
      if (form.get('resource') !== `${base}/mcp`) return json(res, 400, { error: 'invalid_target' });
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!c || c.clientId !== form.get('client_id') || c.redirectUri !== form.get('redirect_uri') || sha(form.get('code_verifier') ?? '') !== c.challenge || c.resource !== form.get('resource')) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        return json(res, 200, issue(c.clientId));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        const reused = spent.get(rt);
        if (reused !== undefined && fake.opts.strictReuse && !revokedFamilies.has(reused)) {
          revokedFamilies.add(reused);
          fake.familiesRevoked++;
          for (const [t, f] of refresh) if (f.family === reused) refresh.delete(t);
        }
        const r = refresh.get(rt);
        if (!r || r.clientId !== form.get('client_id') || revokedFamilies.has(r.family)) return json(res, 400, { error: 'invalid_grant' });
        // Rotation: the old one is spent.
        refresh.delete(rt);
        spent.set(rt, r.family);
        const out = issue(r.clientId, r.family);
        if (fault === 'drop-after-rotate') return req.socket.destroy();
        return json(res, 200, out);
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
      const msg = JSON.parse(body);
      fake.mcpCalls.push({ method: msg.method, token });
      if (!token || !access.has(token) || fake.revoked.has(token) || revokedFamilies.has(access.get(token)!)) {
        return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="fleet:read fleet:operate"` });
      }
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const reply = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'sess-1' });
      if (msg.method === 'initialize' && initializeHold) {
        const held = initializeHold;
        held.arrived();
        await held.done;
      }
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-fleet', version: '1' } });
      if (msg.method === 'tools/list') {
        if (toolsHold) {
          const held = toolsHold;
          held.arrived();
          await held.done;
        }
        if (fake.opts.reflectToken === 'error') return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `scope missing for Bearer ${token}` } });
        if (fake.opts.reflectToken === 'tool') return reply({ tools: [{ name: `echo_${token}`, inputSchema: {} }] });
        const all = tools();
        // Two pages, so the client must follow nextCursor.
        if (!msg.params?.cursor) return reply({ tools: all.slice(0, 2), nextCursor: 'page-2' });
        return reply({ tools: all.slice(2) });
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'work_feed') {
        const args = msg.params.arguments ?? {};
        fake.feedCalls.push(args);
        if (feedHold) {
          const held = feedHold;
          held.arrived();
          await held.done;
        }
        if (fake.feedFailures > 0) {
          fake.feedFailures--;
          return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
        }
        const after = Number(args.cursor ?? 0);
        const page = fake.events.filter((e) => Number(e.cursor) > after).slice(0, Math.min(Number(args.limit ?? 50), fake.opts.pageSize));
        const nextCursor = page.length ? page.at(-1)!.cursor : String(after);
        const hasMore = fake.events.some((e) => Number(e.cursor) > Number(nextCursor));
        const structuredContent = { events: page, nextCursor, hasMore, attention: fake.attention };
        return reply({ content: [{ type: 'text', text: `${page.length} events` }], structuredContent });
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'work_status') {
        const jobId = String(msg.params.arguments?.jobId ?? '');
        fake.statusCalls.push({ jobId, token });
        if (fake.statusFailures > 0) {
          fake.statusFailures--;
          return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
        }
        const view = Object.hasOwn(fake.jobs, jobId) ? fake.jobs[jobId] : null;
        if (!view) return reply({ content: [{ type: 'text', text: 'not_found: no such job' }], isError: true });
        return reply({ content: [{ type: 'text', text: `job ${jobId}` }], structuredContent: { jobId, ...view } });
      }
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
    json(res, 404, { error: 'not found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return fake;
}
