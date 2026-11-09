import { execFile, execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { parseJson } from './util.ts';

// Node builtins only: scripts/backup.ts imports config.ts, which imports this.

/** This machine's tailnet IPv4 address and MagicDNS name, or nulls when Tailscale is not up. */
export interface TailscaleSelf {
  ip: string | null;
  dnsName: string | null;
}

export type TailscaleProbe = () => Promise<TailscaleSelf>;

const NONE: TailscaleSelf = { ip: null, dnsName: null };
const ARGS = ['status', '--self', '--peers=false', '--json'];

export function parseTailscaleStatus(json: string): TailscaleSelf {
  try {
    const status = JSON.parse(json);
    if (status.BackendState !== undefined && status.BackendState !== 'Running') return NONE;
    const self = status.Self ?? {};
    const ip = (self.TailscaleIPs ?? []).find((a: unknown) => typeof a === 'string' && a.includes('.')) ?? null;
    const dnsName = typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '').toLowerCase() : null;
    return ip ? { ip, dnsName } : NONE;
  } catch {
    return NONE;
  }
}

/** Used once at startup. */
export function tailscaleSelfSync(): TailscaleSelf {
  try {
    return parseTailscaleStatus(execFileSync('tailscale', ARGS, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return NONE;
  }
}

export const tailscaleSelf: TailscaleProbe = () =>
  new Promise((resolve) => {
    execFile('tailscale', ARGS, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => resolve(err ? NONE : parseTailscaleStatus(stdout)));
  });

/** From `tailscale whois --json <ip>`, for one-click owner pairing. */
export interface TailnetPeer {
  login: string;
  /** Short machine name, e.g. "my-phone". */
  node: string;
  nodeId: string;
  /** Tagged nodes act for the tailnet, not a person, so they never count as the owner. */
  tagged: boolean;
}

interface TailnetSelf {
  /** Null for a tagged machine. */
  login: string | null;
  nodeId: string;
  ips: string[];
}

export interface Tailnet {
  whois(ip: string): Promise<TailnetPeer | null>;
  self(): Promise<TailnetSelf | null>;
}

/** Runs `tailscale <args>`: its stdout, or null if it fails. */
export type RunCommand = (args: string[]) => Promise<string | null>;

const run: RunCommand = (args) =>
  new Promise((resolve) => {
    execFile('tailscale', args, { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });

/** Strips the IPv4-mapped prefix of dual-stack sockets ("::ffff:100.1.2.3"). */
export function plainAddress(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(raw: string): boolean {
  const ip = plainAddress(raw);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
}

export function isLoopback(raw: string): boolean {
  const ip = plainAddress(raw);
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}

/** Cached for 30 s, so a page load doesn't spawn a process per request. */
export function tailscaleCli(exec: RunCommand = run): Tailnet {
  const cache = new Map<string, { at: number; value: Promise<any> }>();
  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  return {
    whois(raw) {
      const ip = plainAddress(raw);
      if (!isTailnetAddress(ip)) return Promise.resolve(null);
      return cached(`whois ${ip}`, async () => {
        const data = parseJson<any>(await exec(['whois', '--json', ip]), null);
        const login = data?.UserProfile?.LoginName;
        const node = data?.Node;
        if (typeof login !== 'string' || !login || !node) return null;
        const name = String(node.ComputedName || node.Hostinfo?.Hostname || String(node.Name ?? '').split('.')[0] || ip);
        const tags = Array.isArray(node.Tags) ? node.Tags : [];
        return { login, node: name, nodeId: String(node.StableID ?? node.ID ?? ''), tagged: tags.length > 0 || login === 'tagged-devices' };
      });
    },
    self() {
      return cached('self', async () => {
        const data = parseJson<any>(await exec(['status', '--self', '--json']), null);
        const self = data?.Self;
        if (!self) return null;
        const user = data.User?.[String(self.UserID)];
        const tagged = Array.isArray(self.Tags) && self.Tags.length > 0;
        const login = !tagged && typeof user?.LoginName === 'string' && user.LoginName !== 'tagged-devices' ? user.LoginName : null;
        const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : [];
        return { login, nodeId: String(self.ID ?? ''), ips };
      });
    },
  };
}
