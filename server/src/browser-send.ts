import { type ClientRequest, type IncomingMessage, request as httpRequest } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { portOf } from './browser-policy.ts';

/*
 * The one send of a request the owner allowed on a card (browser.ts): from here, not from Chromium or Playwright's
 * request context, so what goes is exactly what the card was bound to. Chromium would add the cookies it holds when it
 * sends, and Playwright's route.fetch adds its context's cookies to a request that had none: either could send a
 * session the card never saw. Here there is no cookie jar at all, only the headers given (wireHeaders), no redirect
 * followed and no retry.
 *
 * It goes through the browser's own proxy (a CONNECT tunnel, for http:// too, on a one-time pass: the proxy is sealed
 * for Chromium by then), which checks the sites and every address the name resolves to as it does for Chromium, and
 * cuts the tunnel when the sites change. Over https the
 * certificate is checked against Node's roots (or `ca`, which only tests give, for a certificate of their own).
 *
 * What it reports is what is known about delivery, which is what decides whether trying again could send it twice:
 * - `not-sent`: it failed before a byte of the request left for the site (the proxy refused, the site couldn't be
 *   reached, TLS failed, connecting took too long, or it was withdrawn first);
 * - `unknown`: the request was written and then the connection broke, timed out or was cut before an answer: the site
 *   may have acted on it;
 * - `sent`: the site answered (its status is known).
 */

export interface Sent {
  delivery: 'sent';
  status: number;
  headers: [string, string][];
  /** The answer's body, or null if it was cut or larger than `maxBody` (it was still sent). */
  body: Buffer | null;
}

export type Delivery = Sent | { delivery: 'not-sent'; why: string } | { delivery: 'unknown'; why: string };

export interface SendOptions {
  proxy: { port: number; username: string; password: string };
  method: string;
  url: string;
  headers: [string, string][];
  body: Buffer | null;
  /** Checked last, right before the request is written: why it must not go now (the turn ended, the sites changed), or null. */
  ready: () => string | null;
  signal: AbortSignal;
  /** The whole send, from the call: connecting through the proxy, TLS, writing and the whole answer. */
  timeoutMs: number;
  maxBody: number;
  /** Tests only: the certificate their own HTTPS site uses, trusted for this one connection. */
  ca?: string;
}

const why = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0].slice(0, 200);

/**
 * One deadline, `timeoutMs` from the call, covers all of it: the connection to the proxy, its answer to CONNECT, TLS,
 * writing the request and the whole answer. When it passes, or the send is withdrawn, every socket it opened is
 * destroyed at once, whichever step it was waiting on, and what is known of delivery is said.
 */
export function sendHeld(o: SendOptions): Promise<Delivery> {
  return new Promise<Delivery>((resolve) => {
    const u = new URL(o.url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = portOf(u);
    /** Everything opened for this send, destroyed when it ends however it ends. */
    const open = new Set<{ destroy(): unknown }>();
    const hold = <T extends { destroy(): unknown; on(e: 'error', f: () => void): unknown }>(x: T): T => {
      open.add(x);
      x.on('error', () => {});
      return x;
    };
    let written = false;
    let settled = false;
    let answered: { status: number; headers: [string, string][] } | null = null;
    const finish = (d: Delivery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', withdrawn);
      // Newest first: the answer and request, then TLS, then the tunnel beneath it.
      for (const x of [...open].reverse()) x.destroy();
      open.clear();
      resolve(d);
    };
    /** It ended before an answer came in full: what is known depends on how far it got. */
    const broke = (before: string, after: string) =>
      finish(
        answered
          ? { delivery: 'sent', ...answered, body: null }
          : written
            ? { delivery: 'unknown', why: `${after} after it was sent, before the site answered` }
            : { delivery: 'not-sent', why: before },
      );
    const withdrawn = () => broke('it was withdrawn before it was sent', 'it was withdrawn (the browser closed, the turn ended, or the sites changed)');
    const timer = setTimeout(() => broke('the proxy or the site took too long to connect', 'the site took too long'), o.timeoutMs);
    o.signal.addEventListener('abort', withdrawn, { once: true });
    if (o.signal.aborted) return withdrawn();

    const write = (socket: Socket) => {
      if (settled) return;
      // Checked last, right before the request is written.
      const late = o.ready();
      if (late) return finish({ delivery: 'not-sent', why: late });
      // createConnection with no agent: this one socket, this one request.
      const req: ClientRequest = hold(
        httpRequest({ method: o.method, path: `${u.pathname}${u.search}`, headers: o.headers.flat(), setHost: false, createConnection: () => socket }),
      );
      req.on('error', (err) => broke(`the connection broke (${why(err)})`, `the connection broke (${why(err)})`));
      req.on('response', (res) => {
        hold(res);
        const headers: [string, string][] = [];
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
        answered = { status: res.statusCode ?? 0, headers };
        const chunks: Buffer[] = [];
        let size = 0;
        let whole = true;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > o.maxBody) {
            whole = false;
            res.destroy();
          } else chunks.push(c);
        });
        const end = () => finish({ delivery: 'sent', status: res.statusCode ?? 0, headers, body: whole && res.complete ? Buffer.concat(chunks) : null });
        res.on('end', end);
        res.on('close', end);
        res.on('error', end);
      });
      written = true;
      req.end(o.body ?? undefined);
    };

    // A tunnel through the proxy to host:port (for http:// too), on the pass the proxy was given for this send.
    const auth = `Basic ${Buffer.from(`${o.proxy.username}:${o.proxy.password}`).toString('base64')}`;
    const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    const connectReq = hold(httpRequest({ host: '127.0.0.1', port: o.proxy.port, method: 'CONNECT', path: target, headers: { host: target, 'proxy-authorization': auth }, agent: false }));
    connectReq.on('connect', (res: IncomingMessage, raw: Socket, head: Buffer) => {
      hold(raw);
      if (settled) return void raw.destroy();
      if (res.statusCode !== 200) return finish({ delivery: 'not-sent', why: `the proxy refused it (HTTP ${res.statusCode})` });
      if (head.length) raw.unshift(head);
      if (u.protocol !== 'https:') return write(raw);
      const tls: TLSSocket = hold(tlsConnect({ socket: raw, host, servername: isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], ...(o.ca ? { ca: o.ca } : {}) }));
      tls.once('secureConnect', () => write(tls));
      tls.on('error', (err) => {
        if (!written) finish({ delivery: 'not-sent', why: `TLS with ${u.host} failed: ${why(err)}` });
      });
    });
    connectReq.on('response', (res) => {
      res.resume();
      finish({ delivery: 'not-sent', why: `the proxy refused it (HTTP ${res.statusCode})` });
    });
    connectReq.on('error', (err) => broke(why(err), why(err)));
    connectReq.end();
  });
}
