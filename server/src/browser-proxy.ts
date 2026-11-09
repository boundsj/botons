import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { type ClientRequest, createServer, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { connect as tlsConnect, createSecureContext, rootCertificates, TLSSocket } from 'node:tls';
import { hostOf, isPrivateHost, judgeRequest, portOf, siteFor } from './browser-policy.ts';
import { allowance, refusedAddress } from './ssrf.ts';

/*
 * The one way out of a Boton's browser: Chromium is started with this as its proxy for every address, loopback
 * included, and with UDP that bypasses proxies (WebRTC) and QUIC off. Each connection is checked against the
 * Boton's sites as they stand at that moment, then the name is resolved here and every address checked, so a
 * redirect, a script or a name that resolves to a private address can't reach what the owner didn't list. Plain HTTP
 * is forwarded here, and only reads (GET, HEAD), but in the owner's handover (ProxyPolicy.writes). A tunnel, or a
 * plain HTTP response still streaming, lasts only while its host stays allowed: recheck() cuts the ones a change of
 * sites, or the browser being turned off, no longer allows, so nothing more of them reaches the page.
 *
 * A browser that loads pages (a Boton's, and the owner's handover: ProxyOptions.intercept) gets no tunnel to a site at
 * all: its HTTPS ends here, with a certificate made for that one browser (browser-cert.ts), and every request inside
 * is judged and forwarded as plain HTTP is, then sent on over TLS this proxy verifies. So its writes are decided where
 * every byte leaves, whatever in Chromium sent them: a page, a worker, or a document as it unloads (which Playwright's
 * routing never sees). Without intercept (a browser that loads nothing) HTTPS goes as a tunnel to an allowed host:port.
 *
 * Sealed (seal(true): the Boton clicked or typed on the page), nothing from Chromium goes at all: every open tunnel
 * and exchange is cut and every new one refused, whatever made it. That holds where Chromium's routing can't: a
 * request Playwright can name no frame for (a keepalive fetch or beacon as a document or frame unloads) is let go by
 * Playwright without asking the routing. The one way through then is a pass (passOnce), made for the send of a
 * request the owner allowed on a card: one tunnel, to one host:port, by credentials Chromium never has. A pass's
 * tunnel is never ended here (intercept or not): its sender verifies the site's own certificate through it.
 *
 * Every request and tunnel is owned from the moment it arrives until it is cut or done, by the generation it arrived
 * in. Sealing, unsealing and closing each start a new generation and cut everything of the old one, including what
 * is still waiting on its name or its connection; and after every wait (the name resolved, the site connected) work
 * goes on only if its generation is still the current one, the proxy unsealed (or it holds a pass of this
 * generation) and its site still allowed. So nothing that arrived before a seal goes once it is sealed, and nothing
 * from before a seal goes on the authority of a later unseal.
 */

/** What the proxy enforces now: off (the Boton lost its browser, or the server is stopping), or these sites. */
export interface ProxyPolicy {
  enabled: boolean;
  sites: string[];
  /**
   * Writes (POST, PUT, PATCH, DELETE; plain HTTP, or HTTPS ended here) to these sites go too: only in the owner's
   * handover, right after the owner's own click, key or typing (browser-handover.ts). Never for a Boton's browser.
   */
  writes?: boolean;
}

export interface BrowserProxy {
  port: number;
  /** Cuts every open tunnel, plain HTTP exchange and request still being resolved that the current policy no longer allows. */
  recheck(): void;
  /** A new generation either way: everything open or under way is cut. Sealed, nothing new goes but through a pass. */
  seal(on: boolean): void;
  /** A new generation, sealed or not as it was: everything open or under way is cut (the owner opened another address). */
  cut(): void;
  readonly sealed: boolean;
  /** Credentials for one tunnel to host:port, valid for a minute and only in the generation they were made in: the send of an allowed request. */
  passOnce(host: string, port: number): { username: string; password: string };
  /** Credentials made for this proxy, given only to its Chromium: anything else on this computer (a Boton's shell) gets 407. */
  username: string;
  password: string;
  /** What it holds now: requests and tunnels still being resolved or connected, open tunnels and exchanges, sockets. */
  inFlight(): { pending: number; tunnels: number; exchanges: number; sockets: number };
  close(): Promise<void>;
}

export interface ProxyOptions {
  /** Tests only: resolves a name in place of the system resolver (to hold a lookup while the proxy changes). */
  lookup?: (host: string) => Promise<string[]>;
  /**
   * HTTPS ends here with this certificate (the one its Chromium trusts), and each request inside is judged on its own
   * and sent on over TLS verified against the system's roots (and `ca`, tests only). Every browser that loads pages.
   * A pass's tunnel is the one exception: it goes through as is.
   */
  intercept?: { key: string; cert: string; ca?: string[] };
  /** A write about to leave for its site (only ever while policy().writes): the journal's record of it. */
  onWrite?: (url: string, method: string) => void;
  /**
   * A site that could not be reached: its name not found, or none of its addresses answered, or its certificate not
   * accepted. Botons refused nothing, so this is never said as a block (onBlocked is Botons' policy alone).
   */
  onUnreachable?: (url: string, message: string) => void;
  /** Tests only: opens a TCP connection to an address that was checked (in place of net.connect). */
  connect?: (address: string, port: number) => Socket;
  /** Tests only: how long one address may take to answer (default ATTEMPT_MS). */
  attemptMs?: number;
}

const systemLookup = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** How long one address may take to accept a connection before the next one is tried. */
const ATTEMPT_MS = 3000;
/** The most addresses tried for one connection: a name with many still answers (or fails) within a step's time. */
const MAX_ATTEMPTS = 6;

/** The words for a name that resolves to nothing, or a site none of whose addresses answered: Botons refused neither. */
export const notFound = (host: string) => `Couldn’t find ${host} — check the address.`;
export const noAnswer = (host: string) => `Couldn’t look up ${host}: the name server didn’t answer.`;
export const unreachable = (host: string, tried: number) => `Couldn’t connect to ${host} (tried ${tried} ${tried === 1 ? 'address' : 'addresses'}).`;

/**
 * The order addresses are dialled in: IPv4 first (a server may have no IPv6 route at all, and a dual-stack name would
 * otherwise wait on it), then IPv6, each in the resolver's order, once each.
 */
export function dialOrder(addresses: string[]): string[] {
  const unique = [...new Set(addresses)];
  return [...unique.filter((a) => isIP(a) === 4), ...unique.filter((a) => isIP(a) !== 4)];
}

type Target = { addresses: string[] } | { why: string } | { failed: string };

/**
 * Where host:port may be connected: every address it resolves to, each one checked before any is dialled (a private
 * one anywhere refuses them all), or why not: `why` is Botons' policy, `failed` a name that could not be resolved.
 * A private address goes only through an entry that names it with its port.
 */
async function resolveAllowed(sites: string[], host: string, port: number, resolve: (host: string) => Promise<string[]>): Promise<Target> {
  const site = siteFor(sites, host, port);
  if (!site) return { why: `${host}:${port} is not one of the allowed sites` };
  const named = site.port !== null && isPrivateHost(site.host);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return { failed: code && !['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA'].includes(code) ? noAnswer(host) : notFound(host) };
    }
  }
  if (!addresses.length) return { failed: notFound(host) };
  if (!named) {
    for (const a of addresses) {
      const why = refusedAddress(a, allowance([]));
      if (why) return { why: `${host} resolves to ${a}, ${why}` };
    }
  }
  return { addresses: dialOrder(addresses).slice(0, MAX_ATTEMPTS) };
}

/**
 * Connects to the first of `addresses` (already checked, IPs only: nothing is resolved again here) that answers within
 * `ms`, one at a time. `ok` is asked before each attempt: once it says no, nothing more is dialled.
 */
async function dial(addresses: string[], port: number, open: (address: string, port: number) => Socket, ms: number, ok: () => boolean, track: (s: Socket) => void): Promise<Socket | 'stale' | 'failed'> {
  for (const address of addresses) {
    if (!ok()) return 'stale';
    const sock = open(address, port);
    track(sock);
    const up = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), ms);
      timer.unref?.();
      const settle = (v: boolean) => {
        clearTimeout(timer);
        sock.off('connect', yes);
        sock.off('error', no);
        sock.off('close', no);
        done(v);
      };
      const yes = () => settle(true);
      const no = () => settle(false);
      sock.once('connect', yes);
      sock.once('error', no);
      sock.once('close', no);
    });
    if (up) return sock;
    sock.on('error', () => {});
    sock.destroy();
  }
  return ok() ? 'failed' : 'stale';
}

const SEALED = 'the page was clicked or typed on, so nothing more from the browser goes without a card (open an address to go on)';
const STALE = 'the browser was sealed, reopened, turned off or the site removed while it waited';
const STALE_WRITE = 'it is a write, and while it waited the moment for writes passed, or the browser was sealed, reopened, turned off or the site removed';

/** A request or tunnel from its arrival until it is cut or done: what it may still do is decided against `gen`. */
interface Work {
  gen: number;
  host: string;
  port: number;
  /** It came with a pass (a card's send): it may go while sealed, but only in the generation the pass was made in. */
  pass: boolean;
  /** A write not sent yet: it may still go only while the policy allows writes (checked after every wait, as the rest). */
  write: boolean;
  /** Cut: no connection is made for it, and whatever it has open is destroyed. */
  dead: boolean;
  /** Destroys what it has open (the page's connection, and upstream once there is one). */
  cut: () => void;
}

export function startBrowserProxy(policy: () => ProxyPolicy, onBlocked: (url: string, why: string) => void, options: ProxyOptions = {}): Promise<BrowserProxy> {
  const resolveName = options.lookup ?? systemLookup;
  const open = options.connect ?? ((host: string, port: number) => connect({ host, port }));
  const attemptMs = options.attemptMs ?? ATTEMPT_MS;
  const onUnreachable = options.onUnreachable ?? (() => {});
  const sockets = new Set<Socket>();
  /** Every request and tunnel not yet cut or done, from the moment it arrived. */
  const work = new Set<Work>();
  /** Open tunnels, by the host:port they reach. */
  const tunnels = new Map<Socket, Work>();
  /** Plain HTTP requests forwarded and not yet answered in full, by the host:port they reach. */
  const exchanges = new Map<ServerResponse, Work>();
  let generation = 0;
  let sealed = false;
  let closed = false;
  /** Inside the owner's browser's HTTPS, ended here: the tunnel each decrypted connection came through. */
  const inner = new WeakMap<Socket, { host: string; port: number; tunnel: Work }>();
  const secure = options.intercept ? createSecureContext({ key: options.intercept.key, cert: options.intercept.cert }) : null;
  const ca = options.intercept?.ca?.length ? [...rootCertificates, ...options.intercept.ca] : undefined;
  const allowedNow = (w: Work) => {
    const p = policy();
    return p.enabled && !!siteFor(p.sites, w.host, w.port) && (!w.write || p.writes === true);
  };
  /** Whether `w` may still go on, checked after every wait and right before anything leaves for the site. */
  const current = (w: Work) => !closed && !w.dead && w.gen === generation && (w.pass || !sealed) && allowedNow(w);
  const own = (w: Work) => {
    work.add(w);
    return w;
  };
  const drop = (w: Work) => {
    w.dead = true;
    work.delete(w);
    w.cut();
  };
  const username = 'botons';
  const password = randomBytes(24).toString('base64url');
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers['proxy-authorization'] ?? ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  /** Passes not yet used, by their whole Proxy-Authorization value. */
  const passes = new Map<string, { target: string; until: number; gen: number }>();
  /** Whether this CONNECT carries a pass for exactly its host:port, made in this generation; spent here either way. */
  const takePass = (req: IncomingMessage, target: string): boolean => {
    const got = String(req.headers['proxy-authorization'] ?? '');
    const p = passes.get(got);
    if (!p) return false;
    passes.delete(got);
    return p.target === target && p.until > Date.now() && p.gen === generation;
  };
  /** A new generation: every pass and everything of the old one is cut, under way or open. */
  const nextGeneration = () => {
    generation++;
    passes.clear();
    for (const w of [...work]) drop(w);
  };
  const challenge = 'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="botons"\r\ncontent-length: 0\r\n\r\n';
  const refuse = (res: ServerResponse, status: number, why: string) => {
    if (res.headersSent || res.destroyed) return void res.destroy();
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close', 'x-botons-proxy': 'blocked' });
    res.end(`Blocked by Botons: ${why}\n`);
  };
  /** The proxy's own answer for a site it could not reach: plain words, never said as a block. */
  const unreached = (res: ServerResponse, message: string) => {
    if (res.headersSent || res.destroyed) return void res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close', 'x-botons-proxy': 'unreachable' });
    res.end(`${message}\n`);
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const via = inner.get(req.socket);
    let u: URL;
    if (via) {
      // Inside the owner's HTTPS: the address is the tunnel's, and the request must name that same site.
      const authority = `${via.host.includes(':') ? `[${via.host}]` : via.host}:${via.port}`;
      let named: URL | null = null;
      try {
        named = new URL(`https://${req.headers.host ?? ''}`);
      } catch {}
      if (!req.url?.startsWith('/') || !named || hostOf(named) !== via.host || portOf(named) !== via.port) return refuse(res, 421, 'a request for another site than its connection');
      if (via.tunnel.dead || via.tunnel.gen !== generation) return void res.destroy();
      u = new URL(`https://${authority}${req.url}`);
    } else {
      try {
        u = new URL(req.url ?? '');
      } catch {
        return refuse(res, 400, 'not a proxy request');
      }
      if (!authorized(req)) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="botons"', connection: 'close' });
        return res.end();
      }
      if (u.protocol !== 'http:') return refuse(res, 400, 'only http:// goes through as a request');
    }
    if (closed) return refuse(res, 403, 'the browser is closing');
    if (sealed) {
      onBlocked(u.href, SEALED);
      return refuse(res, 403, SEALED);
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const p = policy();
    const verdict = judgeRequest(u.href, method, p.sites);
    const write = !verdict.ok && !!verdict.write;
    if (!p.enabled || (!verdict.ok && !(write && p.writes === true))) {
      const why = p.enabled ? (verdict as { why: string }).why : 'the browser is turned off';
      onBlocked(u.href, why);
      return refuse(res, 403, why);
    }
    const host = hostOf(u);
    const port = portOf(u);
    let upstream: Socket | null = null;
    let out: ClientRequest | null = null;
    const w = own({
      gen: generation,
      host,
      port,
      pass: false,
      write,
      dead: false,
      cut: () => {
        out?.destroy();
        upstream?.destroy();
        // The page's connection goes too: a response cut midway must not look complete.
        res.destroy();
      },
    });
    const done = () => {
      work.delete(w);
      exchanges.delete(res);
    };
    res.on('close', () => {
      // Answered, or the page gave up: nothing more is connected or forwarded for it.
      w.dead = true;
      out?.destroy();
      upstream?.destroy();
      done();
    });
    const stale = () => {
      onBlocked(u.href, write ? STALE_WRITE : STALE);
      if (!w.dead) refuse(res, 403, write ? STALE_WRITE : STALE);
      done();
    };
    const target = await resolveAllowed(p.sites, host, port, resolveName);
    if (!current(w)) return stale();
    if ('why' in target) {
      onBlocked(u.href, target.why);
      refuse(res, 403, target.why);
      return done();
    }
    const fail = (message: string) => {
      onUnreachable(u.href, message);
      unreached(res, message);
      done();
    };
    if ('failed' in target) return fail(target.failed);
    const track = (s: Socket) => {
      upstream = s;
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    };
    // Every address was checked above; each is dialled by its IP, so nothing is resolved again on the way.
    const tcp = await dial(target.addresses, port, open, attemptMs, () => current(w), track);
    if (tcp === 'stale') return stale();
    if (tcp === 'failed') return fail(unreachable(host, target.addresses.length));
    if (!current(w)) {
      tcp.destroy();
      return stale();
    }
    const sock: Socket = via ? tlsConnect({ socket: tcp, host, servername: isIP(host) ? undefined : host, ca, ALPNProtocols: ['http/1.1'] }) : tcp;
    if (via) {
      // Its errors reach the TLS socket on it as a close; that one says what happened.
      tcp.on('error', () => {});
      track(sock);
    }
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (exchanges.has(res) || w.dead) return;
      const cert = via && (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO/.test(err.code ?? '') || /certificate/i.test(err.message));
      fail(cert ? `Couldn\u2019t connect securely to ${host}: its certificate was not accepted.` : unreachable(host, target.addresses.length));
    });
    const go = () => {
      // And again once connected, before a byte of the request is written.
      if (!current(w)) {
        sock.destroy();
        return stale();
      }
      if (w.write) {
        // From here it has gone: said so before its first byte, and no longer a write that waits.
        options.onWrite?.(u.href, method);
        w.write = false;
      }
      const headers = { ...req.headers };
      for (const h of ['proxy-connection', 'proxy-authorization', 'keep-alive']) delete headers[h];
      const fwd = httpRequest(
        { method: req.method, path: `${u.pathname}${u.search}`, headers: { ...headers, host: u.host }, setHost: false, createConnection: () => sock },
        (up) => {
          // Cut while the site waited to answer: already destroyed.
          if (!exchanges.has(res)) return void up.destroy();
          // Only the proxy's own answers carry its mark: a site can't make its page pass for one.
          const { 'x-botons-proxy': _mark, ...headers } = up.headers;
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
        },
      );
      out = fwd;
      exchanges.set(res, w);
      fwd.on('error', () => {
        if (!exchanges.has(res)) return;
        exchanges.delete(res);
        if (res.headersSent) res.destroy();
        else {
          const message = `Couldn\u2019t get an answer from ${host}: the connection broke.`;
          onUnreachable(u.href, message);
          unreached(res, message);
        }
        work.delete(w);
      });
      req.pipe(fwd);
    };
    if (via) sock.once('secureConnect', go);
    else go();
  });

  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    // No tunnel inside a tunnel.
    if (inner.has(req.socket)) return void client.destroy();
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(req.url ?? '');
    const fail = (why: string) => {
      onBlocked(`https://${req.url ?? ''}/`, why);
      if (!client.destroyed) client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by Botons: ${why}\r\n`);
    };
    if (!m) return fail('not a host:port');
    const host = m[1].replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(m[2]);
    const pass = takePass(req, `${host}:${port}`);
    if (!pass && !authorized(req)) return void client.end(challenge);
    if (closed) return fail('the browser is closing');
    if (sealed && !pass) return fail(SEALED);
    const p = policy();
    if (!p.enabled) return fail('the browser is turned off');
    if (secure && !pass) {
      // Chromium's HTTPS ends here, and each request inside is judged and sent on by itself.
      if (!siteFor(p.sites, host, port)) return fail(`${host}:${port} is not one of the allowed sites`);
      let tls: TLSSocket | null = null;
      const t = own({
        gen: generation,
        host,
        port,
        pass: false,
        write: false,
        dead: false,
        cut: () => {
          tls?.destroy();
          client.destroy();
        },
      });
      client.on('close', () => {
        t.dead = true;
        tls?.destroy();
        work.delete(t);
        tunnels.delete(client);
      });
      tunnels.set(client, t);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) client.unshift(head);
      tls = new TLSSocket(client, { isServer: true, secureContext: secure });
      sockets.add(tls);
      tls.on('close', () => sockets.delete(tls!));
      tls.on('error', () => client.destroy());
      inner.set(tls, { host, port, tunnel: t });
      server.emit('connection', tls);
      return;
    }
    let upstream: Socket | null = null;
    const w = own({
      gen: generation,
      host,
      port,
      pass,
      write: false,
      dead: false,
      cut: () => {
        upstream?.destroy();
        client.destroy();
      },
    });
    const done = () => {
      work.delete(w);
      tunnels.delete(client);
    };
    client.on('close', () => {
      w.dead = true;
      upstream?.destroy();
      done();
    });
    const stale = () => {
      if (!w.dead) fail(STALE);
      else onBlocked(`https://${req.url ?? ''}/`, STALE);
      done();
    };
    const target = await resolveAllowed(p.sites, host, port, resolveName);
    if (!current(w)) return stale();
    if ('why' in target) {
      fail(target.why);
      return done();
    }
    const unreachableNow = (message: string) => {
      onUnreachable(`https://${req.url ?? ''}/`, message);
      if (!client.destroyed) client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\nx-botons-proxy: unreachable\r\n\r\n${message}\r\n`);
      done();
    };
    if ('failed' in target) return unreachableNow(target.failed);
    // Every address was checked above; each is dialled by its IP, so nothing is resolved again on the way. Checked
    // again before each attempt: no packet for it leaves unless it may go now.
    const sock = await dial(target.addresses, port, open, attemptMs, () => current(w), (s) => {
      upstream = s;
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    if (sock === 'stale') return stale();
    if (sock === 'failed') return unreachableNow(unreachable(host, target.addresses.length));
    sock.on('close', () => {
      if (tunnels.has(client)) client.destroy();
      done();
    });
    sock.on('error', () => client.destroy());
    // And again once connected, before the page's first byte goes through.
    if (!current(w)) {
      sock.destroy();
      return stale();
    }
    tunnels.set(client, w);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) sock.write(head);
    sock.pipe(client);
    client.pipe(sock);
  });
  // Upgrades come as CONNECT tunnels from Chromium; anything else asking for one is refused.
  server.on('upgrade', (_req, socket: Socket) => socket.destroy());

  const shown = (w: Work, scheme: string) => `${scheme}://${w.host.includes(':') ? `[${w.host}]` : w.host}:${w.port}/`;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        recheck: () => {
          for (const w of [...work]) {
            if (allowedNow(w)) continue;
            const open = [...tunnels.values()].includes(w) ? 'https' : [...exchanges.values()].includes(w) ? 'http' : null;
            drop(w);
            if (open) onBlocked(shown(w, open), 'cut: the browser was turned off or the site removed');
          }
        },
        username,
        password,
        get sealed() {
          return sealed;
        },
        seal: (on) => {
          sealed = on;
          nextGeneration();
        },
        cut: () => nextGeneration(),
        passOnce: (host, port) => {
          const user = 'botons-send';
          const pw = randomBytes(24).toString('base64url');
          passes.set(`Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`, { target: `${host.toLowerCase()}:${port}`, until: Date.now() + 60_000, gen: generation });
          return { username: user, password: pw };
        },
        inFlight: () => ({ pending: work.size - tunnels.size - exchanges.size, tunnels: tunnels.size, exchanges: exchanges.size, sockets: sockets.size }),
        close: () =>
          new Promise<void>((done) => {
            closed = true;
            nextGeneration();
            for (const s of sockets) s.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
