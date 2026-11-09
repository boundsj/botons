import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/*
 * The certificate the owner's handover browser is shown for every HTTPS site: made here, with a new P-256 key, for
 * one handover. That Chromium is told to trust exactly this key (--ignore-certificate-errors-spki-list) and no other
 * certificate changes for it, so its proxy (browser-proxy.ts, `intercept`) can end each HTTPS tunnel itself, see
 * every request inside (its method above all) and decide on it, then send it on to the site over TLS that the proxy
 * verifies against the system's roots. The key never leaves this process; nothing else trusts it.
 */

const der = (tag: number, body: Buffer): Buffer => {
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a * 40 + b];
  for (const v of rest) {
    const bytes = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) bytes.unshift((x & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
};
const utcTime = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`, 'ascii'));
const name = (cn: string) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export interface InterceptCert {
  key: string;
  cert: string;
  /** SHA-256 of the key's SubjectPublicKeyInfo, base64: what Chromium is told to trust. */
  spki: string;
}

/** A new key and a self-signed certificate for it, valid from a day ago for two days. */
export function interceptCert(now = new Date()): InterceptCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const randomSerial = randomBytes(16);
  // DER integers need minimal signed encoding; keep this positive and nonzero.
  let first = 0;
  while (first < randomSerial.length - 1 && randomSerial[first] === 0) first++;
  let serial = randomSerial.subarray(first);
  if (serial.length === 1 && serial[0] === 0) serial = Buffer.from([1]);
  else if (serial[0] & 0x80) serial = Buffer.concat([Buffer.from([0]), serial]);
  const subject = name('Botons handover');
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_SHA256,
    subject,
    seq(utcTime(new Date(now.getTime() - 86_400_000)), utcTime(new Date(now.getTime() + 86_400_000))),
    subject,
    spkiDer,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certDer = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`;
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: pem,
    spki: createHash('sha256').update(spkiDer).digest('base64'),
  };
}
