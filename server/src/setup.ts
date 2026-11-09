import { serverCommand } from './install-type.ts';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { AccessMode, AccessModeOption, SetupStatus, SetupWarning, UpdateSetupInput } from '../../shared/types.ts';
import type { Config } from './config.ts';
import { HttpError } from './store.ts';
import { isLoopback, isTailnetAddress, plainAddress } from './tailnet.ts';
import { nowIso, parseJson } from './util.ts';

/*
 * First-run setup and the access mode.
 *
 * The access mode is the owner's statement of which networks may reach the
 * app's port, checked against every request's source address before anything
 * else. It only narrows what the listeners already expose: reaching the server
 * from further away (BOTONS_HOST, a published port, a proxy, DNS, the
 * firewall) stays a change the owner makes on the host. Behind a proxy on the
 * same machine (Tailscale Serve, Caddy) requests come from loopback or the
 * proxy's container, so the mode can't tell those callers apart: there, the
 * listener and the proxy are the boundary, and auth is the one after it. Every
 * description of a mode says so (modeLimits), since a forwarder Botons didn't
 * set up is invisible to it.
 */

export const ACCESS_MODES: readonly AccessMode[] = ['local', 'tailscale', 'lan', 'public'];

export type AddressClass = 'loopback' | 'tailnet' | 'private' | 'public';

const SETTING_MODE = 'accessMode';
export const SETTING_SETUP = 'setup';
export const SETTING_CLAIM = 'ownerClaim';

/** RFC 1918, link-local, unique-local and link-local IPv6. */
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return isIP(ip) === 6 && /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(ip);
}

export function classifyAddress(raw: string): AddressClass {
  const ip = plainAddress(raw);
  if (!ip || isLoopback(ip)) return 'loopback';
  if (isTailnetAddress(ip)) return 'tailnet';
  if (isPrivate(ip)) return 'private';
  return 'public';
}

/**
 * In a container every caller arrives from the bridge network or a sidecar
 * (a private address), so there local and tailscale also accept private
 * addresses: the published port (127.0.0.1 by default) or the sidecar decides.
 */
export function modeAllows(mode: AccessMode | null, cls: AddressClass, container: boolean): boolean {
  if (mode === null || mode === 'public' || cls === 'loopback') return true;
  if (cls === 'public') return false;
  if (mode === 'lan') return true;
  if (cls === 'private') return container;
  return mode === 'tailscale';
}

const NETWORK: Record<AddressClass, string> = {
  loopback: 'this machine',
  tailnet: 'a Tailscale',
  private: 'a local network',
  public: 'a public internet',
};

export function isAccessMode(v: unknown): v is AccessMode {
  return typeof v === 'string' && (ACCESS_MODES as readonly string[]).includes(v);
}

export function readAccessMode(db: DatabaseSync): AccessMode | null {
  const v = db.prepare('select value from settings where key = ?').get(SETTING_MODE)?.value;
  return isAccessMode(v) ? v : null;
}

/** Also used by `npm run pair -- --access-mode`. */
export function writeAccessMode(db: DatabaseSync, mode: AccessMode | null): void {
  if (mode === null) db.prepare('delete from settings where key = ?').run(SETTING_MODE);
  else db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(SETTING_MODE, mode);
}

const https = (url: string | null) => !!url && url.startsWith('https://');

/** Why `mode` can't be chosen with this configuration, or null. Shared with `npm run pair`. */
export function accessModeProblem(mode: AccessMode, cfg: Pick<Config, 'authEnabled' | 'publicUrlOverride'>): string | null {
  if ((mode === 'lan' || mode === 'public') && !cfg.authEnabled) {
    return 'Auth is off. Turn it on first.';
  }
  if (mode === 'public' && !https(cfg.publicUrlOverride)) {
    return 'Needs an HTTPS link set in BOTONS_PUBLIC_URL.';
  }
  return null;
}

/*
 * What no mode can see. The mode checks the address a connection comes from, and anything that forwards
 * connections (a reverse proxy, Tailscale Serve or Funnel, an SSH or other tunnel, a container's network)
 * replaces that address with its own. Botons can't detect forwarders it didn't set up, so these are said
 * wherever a mode is described, whether or not one is in sight.
 */
const FORWARDER_LIMIT =
  'The access mode checks only the address each connection comes from. Anything on this machine that forwards connections to Botons (a reverse proxy, Tailscale Serve or Funnel, an SSH or other tunnel) makes them come from this machine, so they are let through from wherever they started. Botons can\'t detect such forwarders: whoever can reach one gets the sign-in page, and pairing is all that stands in the way.';
const CONTAINER_LIMIT =
  'In a container every connection comes from the container network (the published port, a Tailscale sidecar, a proxy container), so the access mode can\'t tell them apart: the published port and the overlays you start decide who reaches Botons, and a proxy or tunnel in front lets through whoever can reach it.';

/** Shown with each mode, so no summary promises more than the check does. */
export function modeLimits(mode: AccessMode, container: boolean): string[] {
  if (mode === 'public') return ['Nothing is refused by address: auth and pairing are the only boundary.'];
  const out = [container ? CONTAINER_LIMIT : FORWARDER_LIMIT];
  if (mode === 'tailscale') out.push('Your tailnet decides which Tailscale devices reach this machine (its access controls, shared nodes); Botons accepts every Tailscale address that gets here.');
  return out;
}

/** The public URL, when it looks like a forwarder's (HTTPS, or another port than the app's) on another host. */
function forwardedFrom(publicUrl: string | null, port: number): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || isLoopback(host)) return null;
    const at = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return url.protocol === 'https:' || at !== port ? publicUrl : null;
  } catch {
    return null;
  }
}

/** Conservative connection hint for choosing a mode, never an authorization input. */
export function connectionClass(remote: string, publicUrl: string | null, port: number, hints: IncomingHttpHeaders = {}): AddressClass {
  // Untrusted headers may only make selection more conservative, never authorize a request.
  if (Object.keys(hints).some(k => k === 'forwarded' || k.startsWith('x-forwarded-') || k.startsWith('tailscale-'))) return 'public';
  for (const raw of [hints.host, hints.origin]) {
    if (typeof raw !== 'string') continue;
    try {
      const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // A direct tailnet socket and matching configured tailnet hostname are evidence
      // of a tailnet connection; the hostname alone cannot distinguish Serve from Funnel.
      const directTailnet = classifyAddress(remote) === 'tailnet' && publicUrl
        && new URL(publicUrl).hostname === host && host.endsWith('.ts.net');
      if (!directTailnet && host !== 'localhost' && classifyAddress(host) === 'public') return 'public';
    } catch { return 'public'; }
  }
  const cls = classifyAddress(remote);
  if ((cls === 'loopback' || cls === 'private') && forwardedFrom(publicUrl, port)) {
    return 'public';
  }
  return cls;
}

const LABELS: Record<AccessMode, string> = {
  local: 'This computer only',
  tailscale: 'Only my Tailscale devices',
  lan: 'Home network (plain HTTP)',
  public: 'From anywhere',
};

export class Setup {
  #db: DatabaseSync;
  #cfg: Config;
  #ownerName: () => string;

  constructor(db: DatabaseSync, cfg: Config, ownerName: () => string) {
    this.#db = db;
    this.#cfg = cfg;
    this.#ownerName = ownerName;
  }

  get accessMode(): AccessMode | null {
    return readAccessMode(this.#db);
  }

  /** Why a request from `remote` is refused, or null. Read per request, so `npm run pair -- --access-mode` takes effect at once. */
  refusal(remote: string): string | null {
    const mode = this.accessMode;
    const cls = classifyAddress(remote);
    if (modeAllows(mode, cls, this.#cfg.container)) return null;
    return `This Botons server only accepts ${LABELS[mode!].toLowerCase()} connections, and this request came from ${NETWORK[cls]} address. Change the access mode in Settings from a device it accepts, or on the server's machine with \`${accessModeCommand(this.#cfg)}\`.`;
  }

  #setupRecord(): { completedAt: string | null } {
    const raw = this.#db.prepare('select value from settings where key = ?').get(SETTING_SETUP)?.value;
    return parseJson(raw, { completedAt: null });
  }

  status(remote = '127.0.0.1', hints: IncomingHttpHeaders = {}): SetupStatus {
    const cfg = this.#cfg;
    const mode = this.accessMode;
    const claim = parseJson<{ at?: string; label?: string } | null>(this.#db.prepare('select value from settings where key = ?').get(SETTING_CLAIM)?.value, null);
    const devices = Number(this.#db.prepare("select count(*) as n from auth_tokens where kind = 'device'").get()!.n);
    const botons = Number(this.#db.prepare('select count(*) as n from bots').get()!.n);
    const record = this.#setupRecord();
    // A server that had Botons before setup existed is set up already.
    const completed = !!record.completedAt || (!this.#db.prepare('select 1 from settings where key = ?').get(SETTING_SETUP) && botons > 0);
    const tailnetHosts = cfg.urls.map((u) => new URL(u)).filter((u) => isTailnetAddress(u.hostname.replace(/^\[|\]$/g, ''))).map((u) => u.host);
    const tailnetUp = tailnetHosts.length > 0;
    return {
      owner: { name: this.#ownerName(), claimedAt: claim?.at ?? null, claimedBy: claim?.label ?? null, devices },
      completed,
      completedAt: record.completedAt,
      accessMode: mode,
      recommendedMode: this.#recommend(remote, hints),
      modes: ACCESS_MODES.map((m) => this.#option(m, remote, hints)),
      exposure: {
        listeners: cfg.hosts.map((h) => `${h.includes(':') ? `[${h}]` : h}:${cfg.port}`).concat(cfg.tailscale.mode === 'bind' ? tailnetHosts : []),
        hooksListeners: cfg.hooks.port === null ? [] : cfg.hooks.hosts.map((h) => `${h}:${cfg.hooks.port}`),
        publicUrl: cfg.publicUrl,
        https: https(cfg.publicUrl),
        authRequired: cfg.authEnabled,
        tailscale: tailnetUp,
        container: cfg.container,
      },
      warnings: this.#warnings(mode, tailnetUp, completed),
      botons,
    };
  }

  #recommend(remote: string, hints: IncomingHttpHeaders): AccessMode | null {
    const cls = connectionClass(remote, this.#cfg.publicUrlOverride, this.#cfg.port, hints);
    const preferred: AccessMode = cls === 'public' ? 'public' : cls === 'tailnet' ? 'tailscale' : cls === 'private' ? 'lan' : 'local';
    return [preferred, ...ACCESS_MODES].find(m => this.#option(m, remote, hints).available) ?? null;
  }

  #option(mode: AccessMode, remote: string, hints: IncomingHttpHeaders): AccessModeOption {
    const cfg = this.#cfg;
    const port = cfg.port;
    const problem = accessModeProblem(mode, cfg) ?? (!modeAllows(mode, connectionClass(remote, cfg.publicUrlOverride, cfg.port, hints), cfg.container) ? 'Choose this from another device.' : null);
    const docker = cfg.container;
    const steps: Record<AccessMode, string[]> = {
      local: [
        `Open http://localhost:${port} on this machine.`,
        `From another computer without opening anything: an SSH tunnel, \`ssh -L ${port}:127.0.0.1:${port} you@myhost\`, then http://localhost:${port} there.`,
      ],
      tailscale: docker
        ? [
            'Create an auth key in the Tailscale admin console (you do this; Botons never signs in for you) and put it in .env as TS_AUTHKEY.',
            'Start with the Tailscale overlay: `docker compose -f compose.yaml -f docker/compose.tailscale.yaml up -d`, and set BOTONS_PUBLIC_URL to its https:// tailnet address (docs/DOCKER.md).',
          ]
        : [
            'Install Tailscale on this machine and sign in with `tailscale up` (you do this; Botons never signs in for you).',
            'Botons notices the Tailscale address by itself and listens on it too. Your own devices on the tailnet then pair with one click.',
          ],
      lan: docker
        ? [
            'Publish the port on the LAN: set BOTONS_BIND=0.0.0.0 in .env and run `docker compose up -d`. This changes a safety default: traffic is plain HTTP.',
            `Allow port ${port} from your LAN only in the host firewall, e.g. \`sudo ufw allow from 192.168.1.0/24 to any port ${port} proto tcp\`.`,
          ]
        : [
            `Set BOTONS_HOST=0.0.0.0 in the service's env file (~/.config/botons/env, or ~/.config/botons/env on an install made before the rename) and restart the service (${serverCommand('doctor', '', cfg.container)} names it). This listens on every interface, over plain HTTP.`,
            `Allow port ${port} from your LAN only in the firewall, e.g. \`sudo ufw allow from 192.168.1.0/24 to any port ${port} proto tcp\`.`,
          ],
      public: [
        'Point a DNS name you own (say botons.example.com) at this machine.',
        docker
          ? 'Start with the Caddy overlay, which gets the HTTPS certificate: set BOTONS_DOMAIN and BOTONS_PUBLIC_URL=https://botons.example.com in .env, then `docker compose -f compose.yaml -f docker/compose.caddy.yaml up -d`.'
          : `Run an HTTPS reverse proxy (Caddy, say) for that name that forwards to 127.0.0.1:${port}, and set BOTONS_PUBLIC_URL=https://botons.example.com in the service's env file; restart.`,
        `Open ports 80 and 443 in the firewall; keep ${port} closed.`,
        'Every device still pairs with a code, and anyone can reach the sign-in page: keep your devices few and revoke ones you no longer use.',
      ],
    };
    const summary: Record<AccessMode, string> = {
      public: 'HTTPS access with device pairing.',
      tailscale: 'For devices connected through Tailscale.',
      lan: 'Unencrypted access on your home network.',
      local: 'For a browser on the server computer.',
    };
    return { mode, label: LABELS[mode], summary: summary[mode], limits: modeLimits(mode, docker), available: problem === null, reason: problem, steps: steps[mode] };
  }

  #warnings(mode: AccessMode | null, tailnetUp: boolean, completed: boolean): SetupWarning[] {
    const cfg = this.#cfg;
    const out: SetupWarning[] = [];
    const wildcard = cfg.hosts.some((h) => h === '0.0.0.0' || h === '::');
    const network = cfg.hosts.some((h) => !isLoopback(h) && h !== 'localhost');
    if (!cfg.authEnabled) out.push({ level: 'error', text: 'Auth is off (BOTONS_AUTH=off): anyone who can reach the server is its owner, Botons included. Remove it from the server\'s environment and restart.' });
    if (mode === 'public' && !https(cfg.publicUrlOverride)) out.push({ level: 'error', text: 'The access mode is public, but BOTONS_PUBLIC_URL is not an https:// address. Put an HTTPS proxy in front, or choose another mode.' });
    if (mode === null && completed) out.push({ level: 'info', text: 'No access mode is chosen, so only the listeners decide who connects. Choose one so requests from other networks are refused.' });
    if ((mode === 'local' || mode === 'tailscale') && network && !cfg.container) {
      out.push({ level: 'warn', text: `Botons listens on ${cfg.hosts.join(', ')} (BOTONS_HOST), wider than this access mode. Requests from other networks are refused, but narrowing BOTONS_HOST closes the port to them altogether.` });
    }
    if (mode === 'tailscale' && !tailnetUp && !cfg.container) {
      out.push({ level: 'warn', text: cfg.tailscale.enabled ? 'Tailscale is not up on this machine yet, so only this machine can connect.' : 'Tailscale is turned off (BOTONS_NO_TAILSCALE=1), so tailnet devices can only connect through a proxy such as Tailscale Serve.' });
    }
    if (mode === 'lan' && !wildcard && !network && !cfg.container) {
      out.push({ level: 'info', text: 'Botons listens on this machine (and Tailscale) only, so the local network can\'t connect until you change BOTONS_HOST (see the steps).' });
    }
    if ((mode === 'lan' || (wildcard && !cfg.container)) && !https(cfg.publicUrl)) {
      out.push({ level: 'warn', text: 'Devices on the network reach Botons over plain HTTP. Use Tailscale or an HTTPS proxy for anything beyond a network you control.' });
    }
    if (mode !== null && mode !== 'public') {
      out.push({ level: 'warn', text: cfg.container ? CONTAINER_LIMIT : FORWARDER_LIMIT });
      const via = forwardedFrom(cfg.publicUrlOverride, cfg.port);
      if (via) {
        out.push({
          level: 'warn',
          text: `BOTONS_PUBLIC_URL is ${via}, so something probably forwards connections to Botons from there. Through it they come from ${cfg.container ? 'the container network' : 'this machine'}, so ${LABELS[mode]} lets every one through: whoever can open ${via} gets the sign-in page.`,
        });
      }
    }
    if (cfg.hooks.port !== null) {
      out.push({ level: 'info', text: `A webhooks-only listener runs on port ${cfg.hooks.port} (BOTONS_HOOKS_PORT). It serves routine webhooks and nothing else, and the access mode does not apply to it.` });
    }
    return out;
  }

  /** Devices only (the route's default). `remote`: the caller's address, which the new mode must still accept. */
  update(input: UpdateSetupInput, remote: string, hints: IncomingHttpHeaders = {}): { changed: { accessMode?: { from: AccessMode | null; to: AccessMode | null }; completed?: boolean } } {
    const changed: { accessMode?: { from: AccessMode | null; to: AccessMode | null }; completed?: boolean } = {};
    if (input.accessMode !== undefined) {
      const to = input.accessMode;
      if (to !== null && !isAccessMode(to)) throw new HttpError(400, `accessMode must be one of ${ACCESS_MODES.join(', ')}, or null`);
      if (to !== null) {
        const problem = accessModeProblem(to, this.#cfg);
        if (problem) throw new HttpError(400, problem);
        const cls = connectionClass(remote, this.#cfg.publicUrlOverride, this.#cfg.port, hints);
        if (!modeAllows(to, cls, this.#cfg.container)) {
          throw new HttpError(409, `${LABELS[to]} would refuse this device, which connects from ${NETWORK[cls]} address, and lock you out. Choose a wider mode, or change it from another device that mode accepts.`);
        }
      }
      const from = this.accessMode;
      if (from !== to) {
        writeAccessMode(this.#db, to);
        changed.accessMode = { from, to };
      }
    }
    if (input.complete !== undefined) {
      if (input.complete !== true) throw new HttpError(400, 'complete can only be true');
      if (!this.#setupRecord().completedAt) {
        this.#db
          .prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
          .run(SETTING_SETUP, JSON.stringify({ completedAt: nowIso() }));
        changed.completed = true;
      }
    }
    return { changed };
  }
}

/** What the owner runs on the server's machine to manage pairing (`--list`, `--revoke`, `--approve`). */
export function pairCommand(cfg: Pick<Config, 'container'>): string {
  return serverCommand('pair', '', cfg.container);
}

/** The same, to approve the device that shows `code`. */
export function approveCommand(cfg: Pick<Config, 'container'>, code = '<code>'): string {
  return serverCommand('pair', `--approve ${code}`, cfg.container);
}

/** The same, to change the access mode. */
export function accessModeCommand(cfg: Pick<Config, 'container'>, mode = '<mode>'): string {
  return serverCommand('pair', `--access-mode ${mode}`, cfg.container);
}
