import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';

const DENY = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, and Tailscale's addresses
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, and cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
] as const) {
  DENY.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: could lead to any IPv4 address
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local, and Tailscale's IPv6 addresses
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  DENY.addSubnet(net, bits, 'ipv6');
}

/** BOTONS_CALLBACK_ALLOW, parsed. */
interface Allowance {
  addresses: BlockList;
  names: Set<string>;
}

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

export function allowance(entries: string[]): Allowance {
  const addresses = new BlockList();
  const names = new Set<string>();
  for (const entry of entries) {
    const [ip, bits] = entry.split('/');
    if (!isIP(ip)) names.add(entry.toLowerCase());
    else if (bits === undefined) addresses.addAddress(ip, family(ip));
    else addresses.addSubnet(ip, Number(bits), family(ip));
  }
  return { addresses, names };
}

/** Why the server must not connect to `ip`, or null if it may. */
export function refusedAddress(ip: string, allow: Allowance): string | null {
  const plain = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!isIP(plain)) return 'not an IP address';
  if (allow.addresses.check(plain, family(plain))) return null;
  // An IPv4 address written as IPv6 (::ffff:127.0.0.1) is judged as the IPv4 one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain)?.[1];
  if (mapped) return refusedAddress(mapped, allow);
  if (DENY.check(plain, family(plain))) return 'a loopback, private, link-local or reserved address';
  const own = Object.values(networkInterfaces()).flat().some((i) => i?.address.toLowerCase().replace(/%.*$/, '') === plain);
  if (own) return "this machine's own address";
  return null;
}

const ALLOW_HINT = 'BOTONS_CALLBACK_ALLOW can allow it';

const LOCAL_NAME = /(^|\.)localhost\.?$/i;

/** Why a callback URL is refused as written, or null. Names are checked on what they resolve to when connecting. */
export function refusedUrl(raw: string, allow: Allowance): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'callbackUrl must be an http:// or https:// URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'callbackUrl must be an http:// or https:// URL';
  if (u.username || u.password) return 'callbackUrl must not contain a user name or password';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allow.names.has(host)) return null;
  if (isIP(host)) {
    const why = refusedAddress(host, allow);
    return why ? `callbackUrl can't point at ${host}: ${why} (${ALLOW_HINT})` : null;
  }
  if (LOCAL_NAME.test(host)) return `callbackUrl can't point at ${host}: this machine (${ALLOW_HINT})`;
  return null;
}

/** A `lookup` for http.request that refuses a name if any of its addresses is refused, so a later DNS answer can't slip past an earlier check. */
export function guardedLookup(allow: Allowance): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      const allowedName = allow.names.has(hostname.toLowerCase());
      for (const a of allowedName ? [] : addresses) {
        const why = refusedAddress(a.address, allow);
        if (why) return callback(Object.assign(new Error(`${hostname} resolves to ${a.address}, ${why} (${ALLOW_HINT})`), { code: 'EREFUSEDADDRESS' }), '', 0);
      }
      if (options.all) return (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** Check a callback URL before saving it. A name that doesn't resolve now passes: every send checks it again. */
export async function checkCallbackUrl(raw: string, allowEntries: string[]): Promise<string | null> {
  const allow = allowance(allowEntries);
  const refused = refusedUrl(raw, allow);
  if (refused) return refused;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || allow.names.has(host.toLowerCase())) return null;
  const lookup = guardedLookup(allow);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    lookup(host, { all: true }, (err) => {
      clearTimeout(timer);
      resolve((err as NodeJS.ErrnoException | null)?.code === 'EREFUSEDADDRESS' ? `callbackUrl can't point at ${host}: ${err!.message}` : null);
    });
  });
}
