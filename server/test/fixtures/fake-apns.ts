import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { createServer, type Http2Server, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { writeFileSync } from 'node:fs';

/*
 * A loopback stand-in for Apple's push service (POST /3/device/<token> over HTTP/2). It speaks HTTP/2 in the clear
 * (h2c), which the sender is given as its test origin in code, so no certificate is needed and nothing leaves the
 * machine. Every request is recorded with its headers and body; each answers 200 unless the token has a scripted answer.
 * `throwawayKey` makes the EC P-256 key a test signs provider tokens with, never a real one.
 */

export interface ApnsCall {
  /** The device token from the path. */
  token: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The JSON body, parsed. */
  body: any;
}

export interface FakeApns {
  /** `http://127.0.0.1:<port>`: for createApp's `apns.testOrigin` or the sender's. */
  origin: string;
  calls: ApnsCall[];
  /**
   * The next requests for this token answer `status` (and `reason`); with no `times`, every one does. A 410 carries
   * Apple's `timestamp` (milliseconds): the time of the answer unless `extra.timestamp` says otherwise (`undefined`
   * leaves it out, anything else is sent as it is). `extra.delayMs` holds back just this answer.
   */
  answer(token: string, status: number, reason?: string, times?: number, extra?: { timestamp?: unknown; delayMs?: number }): void;
  /** Never answer requests for this token. */
  hang(token: string): void;
  /** Answer requests for this token only after `ms`. */
  delay(token: string, ms: number): void;
  /** Connections open now. */
  connections(): number;
  /** Answer everything with this status and reason from now on. */
  answerAll(status: number, reason?: string): void;
  close(): Promise<void>;
}

export async function fakeApns(): Promise<FakeApns> {
  const calls: ApnsCall[] = [];
  const scripted = new Map<string, { status: number; reason?: string; times: number; extra?: { timestamp?: unknown; delayMs?: number } }>();
  const hanging = new Set<string>();
  const delays = new Map<string, number>();
  let all: { status: number; reason?: string } | null = null;
  const sockets = new Set<Socket>();
  const server: Http2Server = createServer();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (d: string) => (text += d));
    stream.on('end', () => {
      const path = String(headers[':path']);
      const token = path.replace(/^\/3\/device\//, '');
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {}
      const { ':path': _p, ':scheme': _s, ':authority': _a, ...rest } = headers;
      calls.push({ token, path, headers: rest, body });
      if (hanging.has(token)) return;
      const step = scripted.get(token);
      const answer = step && step.times > 0 ? step : all;
      if (step && step.times > 0 && Number.isFinite(step.times)) step.times--;
      const status = answer?.status ?? 200;
      const reply = () => {
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ':status': status, 'apns-id': '00000000-0000-0000-0000-000000000000', ...(status === 200 ? {} : { 'content-type': 'application/json' }) });
        const extra = (answer as { extra?: { timestamp?: unknown } } | null)?.extra;
        const timestamp = extra && 'timestamp' in extra ? extra.timestamp : Date.now();
        stream.end(status === 200 ? undefined : JSON.stringify({ reason: answer?.reason ?? 'BadRequest', ...(status === 410 && timestamp !== undefined ? { timestamp } : {}) }));
      };
      const wait = ((answer as { extra?: { delayMs?: number } } | null)?.extra?.delayMs) ?? delays.get(token);
      if (wait) setTimeout(reply, wait);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    calls,
    answer: (token, status, reason, times = Infinity, extra) => void scripted.set(token, { status, reason, times, extra }),
    hang: (token) => void hanging.add(token),
    delay: (token, ms) => void delays.set(token, ms),
    connections: () => sockets.size,
    answerAll: (status, reason) => void (all = { status, reason }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A new EC P-256 key as Apple's .p8 holds it (PKCS#8 PEM), written to `file`; the public half comes back to verify tokens with. */
export function throwawayKey(file: string): { publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { publicKey: createPublicKey(createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }))) };
}

/** The parts of a provider token (header, claims) once its ES256 signature verifies against `publicKey`; throws if it does not. */
export function verifyProviderToken(jwt: string, publicKey: KeyObject): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c, sig] = jwt.split('.');
  if (!h || !c || !sig) throw new Error('not a JWT');
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('the signature does not verify');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(c, 'base64url').toString()) };
}
