import { serverCommand } from './install-type.ts';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize } from 'node:path';
import type { Principal, RouteAccess } from './auth.ts';
import { log } from './log.ts';
import { HttpError } from './store.ts';
import { inside, orNull } from './util.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Null for a public route called without a token, and on /hooks. */
  principal: Principal | null;
  /** At most 1 MB (or the route's own maxBody), else 413. */
  rawBytes(): Promise<Buffer>;
  /** JSON. With `strictUtf8`, bytes that aren't UTF-8 are a 400 rather than read as U+FFFD. */
  body<T = any>(opts?: { strictUtf8?: boolean }): Promise<T>;
  json(status: number, body: unknown): void;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

const MAX_BODY = 1024 * 1024;

export class Router {
  #routes: { method: string; parts: string[]; handler: Handler; access: RouteAccess; maxBody: number }[] = [];

  /** By default only paired devices may call it, with a body of at most 1 MB. */
  on(method: string, path: string, handler: Handler, access: RouteAccess = {}, opts: { maxBody?: number } = {}): this {
    this.#routes.push({ method, parts: path.split('/').filter(Boolean), handler, access, maxBody: opts.maxBody ?? MAX_BODY });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; access: RouteAccess; maxBody: number } | null | 'method' {
    const segs = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.#routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i].startsWith(':')) {
          const value = safeDecode(segs[i]);
          if (value === null) throw new HttpError(400, 'Malformed URL encoding');
          params[r.parts[i].slice(1)] = value;
        } else if (r.parts[i] !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params, access: r.access, maxBody: r.maxBody };
    }
    return pathMatched ? 'method' : null;
  }
}

export const safeDecode = (s: string): string | null => orNull(() => decodeURIComponent(s));

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.writableEnded || res.destroyed) return;
  // Too late to change the status (say, a stream failed midway): just finish the response.
  if (res.headersSent) return void res.end();
  const data = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

export function makeCtx(req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>, principal: Principal | null, maxBody = MAX_BODY): Ctx {
  let raw: Promise<Buffer> | null = null;
  const rawBytes = () =>
    (raw ??= new Promise<Buffer>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(new HttpError(413, 'Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      // The caller hung up (or a request timeout cut it off): not a server error.
      const incomplete = () => new HttpError(400, 'Request body incomplete');
      req.on('error', (err) => reject(req.complete ? err : incomplete()));
      req.on('close', () => {
        if (!req.complete) reject(incomplete());
      });
    }));
  return {
    req,
    res,
    url,
    params,
    principal,
    rawBytes,
    async body(opts: { strictUtf8?: boolean } = {}) {
      const bytes = await rawBytes();
      let text: string;
      if (!opts.strictUtf8) text = bytes.toString('utf8');
      else {
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
        } catch {
          throw new HttpError(400, 'Body must be UTF-8 text');
        }
      }
      if (!text.trim()) return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Body must be valid JSON');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'Body must be a JSON object');
      return parsed as any;
    },
    json: (status, body) => sendJson(res, status, body),
  };
}

const RAW_UPLOAD = /^\/api\/bots\/[^/]+\/uploads$/;

/**
 * Browser-safety checks, a second line behind auth: the Host check blocks DNS
 * rebinding, the rest drive-by requests from other sites. Mutations need a
 * Content-Type that forces a CORS preflight: exactly application/json
 * (`text/plain; x=application/json` is not it), or octet-stream for an upload.
 */
export function guardRequest(req: IncomingMessage, url: URL, allowedHosts: Set<string>, publicOrigins: ReadonlySet<string> = new Set()): string | null {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || (!isIP(host) && !allowedHosts.has(host))) return `Host "${host}" is not allowed. Set BOTONS_ALLOWED_HOSTS to permit it.`;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const parsed = new URL(origin);
      const configured = parsed.origin !== 'null' && origin.toLowerCase() === parsed.origin.toLowerCase() && publicOrigins.has(parsed.origin.toLowerCase());
      if (!configured && parsed.host.toLowerCase() !== (req.headers.host ?? '').toLowerCase()) return 'Cross-origin requests are not allowed';
    } catch {
      return 'Bad Origin header';
    }
  }
  const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (mutating && url.pathname.startsWith('/api/')) {
    if (origin === 'null') return 'Requests from an opaque origin (Origin: null) are not allowed';
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return 'Cross-site requests are not allowed';
    const type = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    const upload = req.method === 'POST' && RAW_UPLOAD.test(url.pathname) && type === 'application/octet-stream';
    if (!upload && type !== 'application/json') return 'API requests must use Content-Type: application/json';
  }
  return null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * The owner's app is never shown inside another page (CSP frame-ancestors, and X-Frame-Options for browsers without
 * it): no site can lay it under its own and steer the owner's clicks onto an approval. A generated file's preview is
 * served by the API with its own policy (PREVIEW_CSP in files.ts), never from here.
 */
export const APP_FRAMING = { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' } as const;

/** `rel`: the decoded request path. */
export function serveStatic(root: string, rel: string, res: ServerResponse): void {
  if (!existsSync(join(root, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', ...APP_FRAMING });
    res.end(`<h1>Botons</h1><p>The web app is not built yet. Run <code>${serverCommand('repair')}</code>.</p>`);
    return;
  }
  const file = normalize(join(root, rel));
  let target = inside(root, file) && existsSync(file) && statSync(file).isFile() ? file : null;
  if (!target) {
    if (extname(rel)) return void res.writeHead(404, APP_FRAMING).end('Not found');
    target = join(root, 'index.html'); // SPA fallback
    rel = '/index.html';
  }
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...APP_FRAMING,
  });
  createReadStream(target)
    .on('error', (err) => {
      log.error(`could not read ${target}`, { err });
      res.destroy();
    })
    .pipe(res);
}
