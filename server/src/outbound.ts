import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { allowance, guardedLookup, refusedAddress } from './ssrf.ts';

/*
 * Every request the server makes for an OAuth connector (metadata, registration, tokens, MCP) goes through here:
 * HTTPS only (plain HTTP just to an allowed loopback address, for a server on this machine), every address checked
 * as it is connected to, an absolute deadline, a bounded body, and no redirects followed, so a token or code is
 * never sent anywhere but where it was addressed.
 */

export const OUTBOUND_TIMEOUT_MS = 10_000;
export const OUTBOUND_MAX_BYTES = 256 * 1024;

export type OutboundFailure = 'refused' | 'network' | 'timeout' | 'too_large' | 'redirect';

export class OutboundError extends Error {
  readonly kind: OutboundFailure;
  /** The request may have reached the server (it was sent in full): a token refresh may have happened. */
  readonly sent: boolean;
  constructor(kind: OutboundFailure, message: string, sent: boolean) {
    super(message);
    this.kind = kind;
    this.sent = sent;
  }
}

export interface OutboundResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface OutboundRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** BOTONS_OAUTH_ALLOW: private hosts, addresses and CIDRs these servers may be on. */
  allow: string[];
  signal?: AbortSignal;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

/** Why the server must not send a request to `raw`, or null. Names are checked again on what they resolve to. */
export function refusedOutbound(raw: string, allowEntries: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.username || u.password) return 'a URL with a user name or password';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allow = allowance(allowEntries);
  const allowed = allow.names.has(host) || (isIP(host) > 0 && refusedAddress(host, allow) === null && allowedIp(host, allowEntries));
  if (u.protocol === 'http:') {
    if (!(LOOPBACK.test(host) && allowed)) return 'not HTTPS (plain HTTP is only for a loopback address listed in BOTONS_OAUTH_ALLOW)';
  } else if (u.protocol !== 'https:') return 'not HTTPS';
  if (isIP(host)) {
    const why = refusedAddress(host, allow);
    return why ? `${host} is ${why} (BOTONS_OAUTH_ALLOW can allow it)` : null;
  }
  if (/(^|\.)localhost\.?$/i.test(host) && !allow.names.has(host)) return `${host} is this machine (BOTONS_OAUTH_ALLOW can allow it)`;
  return null;
}

/** Whether an IP literal is listed itself (or in a listed range), not just public. */
function allowedIp(ip: string, entries: string[]): boolean {
  const a = allowance(entries);
  return a.addresses.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

/** For messages and logs: never the path's secrets or a query. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '(invalid URL)';
  }
}

export function outbound(raw: string, opts: OutboundRequest): Promise<OutboundResponse> {
  const refused = refusedOutbound(raw, opts.allow);
  if (refused) return Promise.reject(new OutboundError('refused', `Won't connect to ${hostOf(raw)}: ${refused}`, false));
  const u = new URL(raw);
  const max = opts.maxBytes ?? OUTBOUND_MAX_BYTES;
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let sent = false;
    let done = false;
    const fail = (err: OutboundError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      req.destroy();
      reject(err);
    };
    const req = send(u, {
      method: opts.method ?? 'GET',
      headers: { ...opts.headers, ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}) },
      lookup: guardedLookup(allowance(opts.allow)),
      agent: false,
    });
    const timer = setTimeout(() => fail(new OutboundError('timeout', `${u.host} did not answer within ${Math.round((opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS) / 1000)} seconds`, sent)), opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS);
    const onAbort = () => fail(new OutboundError('network', 'Stopped', sent));
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('finish', () => (sent = true));
    req.on('error', (err: NodeJS.ErrnoException) => {
      const refusedAddr = err.code === 'EREFUSEDADDRESS';
      fail(new OutboundError(refusedAddr ? 'refused' : 'network', refusedAddr ? `Won't connect: ${err.message.replace(/ \(BOTONS_CALLBACK_ALLOW can allow it\)/, ' (BOTONS_OAUTH_ALLOW can allow it)')}` : `Could not reach ${u.host}: ${err.code ?? err.message}`, sent));
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return fail(new OutboundError('redirect', `${u.host} answered with a redirect (${status}), which is not followed`, true));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) return fail(new OutboundError('too_large', `${u.host} sent more than ${Math.round(max / 1024)} KiB`, true));
        chunks.push(c);
      });
      res.on('error', () => fail(new OutboundError('network', `${u.host} cut the answer short`, true)));
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.end(opts.body);
  });
}
