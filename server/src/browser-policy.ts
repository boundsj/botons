import { isIP } from 'node:net';
import type { AccessLevel, BrowserPolicy, BrowserPolicyInput } from '../../shared/types.ts';
import { BROWSER_CONNECTOR, MAX_BROWSER_SITES } from '../../shared/util.ts';
import { allowance, refusedAddress } from './ssrf.ts';
import { HttpError } from './store.ts';

/*
 * The managed browser's rules, as pure functions: which sites a Boton's browser may reach, and that it only reads
 * (GET and HEAD). The browser (browser.ts) enforces them where the Boton can't reach: in the server's own proxy,
 * which every request the browser makes goes through, and in its request routing, before a request leaves Chromium.
 */

export const NO_BROWSER: BrowserPolicy = { sites: [], updatedAt: null };

/**
 * A new Boton's browser (blank, from a template or a starter): on, for any public site. "*" never covers this machine
 * or a private network (covers), and every write still waits on the owner's card.
 */
export const NEW_BOTON_SITES = ['*'];

/** A new Boton's connectors with the built-in browser among them (first, as the catalog lists it). */
export function withBrowser(ids: string[]): string[] {
  return ids.includes(BROWSER_CONNECTOR) ? ids : [BROWSER_CONNECTOR, ...ids];
}

/** Whether a brain can run the managed browser: only an agent CLI's turns drive it (an API key brain's tools can't). */
export const drivesBrowser = (provider: { cli?: unknown } | null | undefined): boolean => !!provider?.cli;

/**
 * A new Boton's connectors: the ones the request names, exactly; otherwise `saved` (a template's, those this server
 * has) with the browser, when its brain can run one (drivesBrowser), and without it when it can't.
 */
export const newBotonConnections = (asked: string[] | undefined, saved: string[], browser: boolean): string[] =>
  asked ?? (browser ? withBrowser(saved) : saved.filter((id) => id !== BROWSER_CONNECTOR));

/** Whether a Boton given the browser has one: not on a server found to have no Chromium (its turns go without it). */
export const browserUsable = (enabled: boolean, known: { available: boolean } | null): boolean => enabled && known?.available !== false;

const MAX_SITES = MAX_BROWSER_SITES;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_NAME = /(^|\.)localhost$/;

/** A site entry: "*", "example.com" (and its subdomains), or "host:port" (exactly that address). */
export interface Site {
  any: boolean;
  host: string;
  port: number | null;
}

function parseHostPort(entry: string): { host: string; port: number | null } | null {
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(entry);
  if (v6) return isIP(v6[1]) === 6 ? { host: v6[1], port: v6[2] ? Number(v6[2]) : null } : null;
  const m = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(entry);
  if (!m) return null;
  const host = m[1].replace(/\.$/, '');
  if (!isIP(host) && !HOST.test(host)) return null;
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host, port };
}

export function parseSite(raw: string): Site | null {
  const entry = raw.trim().toLowerCase();
  if (entry === '*') return { any: true, host: '', port: null };
  const hp = parseHostPort(entry.replace(/^\*\./, ''));
  return hp ? { any: false, ...hp } : null;
}

/** Literal loopback, private or reserved addresses, and localhost names: the host's own services. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_NAME.test(h)) return true;
  if (isIP(h)) return refusedAddress(h, allowance([])) !== null;
  return false;
}

export const siteText = (s: Site): string => (s.any ? '*' : `${s.host.includes(':') ? `[${s.host}]` : s.host}${s.port ? `:${s.port}` : ''}`);

/**
 * Whether `site` covers host:port. A name covers itself and its subdomains on any port; an address only itself;
 * with a port, only that port. "*" covers any public host, never a private one.
 */
export function covers(site: Site, host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (site.any) return !isPrivateHost(h);
  if (site.port !== null && site.port !== port) return false;
  if (h === site.host) return true;
  return !isIP(site.host) && !isIP(h) && h.endsWith(`.${site.host}`);
}

/** The entry that lets the browser reach host:port, or null. A private host needs an entry that names its port. */
export function siteFor(sites: string[], host: string, port: number): Site | null {
  const priv = isPrivateHost(host);
  for (const raw of sites) {
    const s = parseSite(raw);
    if (!s || !covers(s, host, port)) continue;
    if (priv && s.port === null) continue;
    return s;
  }
  return null;
}

/**
 * Whether a site entry may name loopback or private addresses: only with a port, and for a Workspace Boton only one the
 * operator allowed. "*" is any public site at either access: it never covers a private one.
 */
function siteProblem(s: Site, access: AccessLevel, allowPrivate: string[]): string | null {
  if (s.any) return null;
  if (!isPrivateHost(s.host)) return null;
  if (s.port === null) return `${siteText(s)} is this machine or a private network: name it with its port (host:port)`;
  if (access !== 'host' && !allowPrivate.includes(siteText(s))) {
    return `${siteText(s)} is this machine or a private network, which a Workspace Boton's browser can't reach (BOTONS_BROWSER_ALLOW can allow one address)`;
  }
  return null;
}

function cleanSites(v: unknown, field: string, access: AccessLevel, allowPrivate: string[]): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, `${field} must be a list of sites such as example.com`);
  const out: string[] = [];
  for (const raw of v as string[]) {
    if (!raw.trim()) continue;
    const s = parseSite(raw);
    if (!s) throw new HttpError(400, `${field}: "${raw.slice(0, 100)}" is not a site: use a host name such as example.com, or host:port`);
    const problem = siteProblem(s, access, allowPrivate);
    if (problem) throw new HttpError(400, `${field}: ${problem}`);
    const text = siteText(s);
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > MAX_SITES) throw new HttpError(400, `${field}: at most ${MAX_SITES} sites`);
  return out;
}

/** The owner's change, checked against the Boton's access. */
export function applyPolicy(before: BrowserPolicy, input: BrowserPolicyInput, access: AccessLevel, allowPrivate: string[]): BrowserPolicy {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Send the browser settings as an object');
  const sites = input.sites === undefined ? before.sites : cleanSites(input.sites, 'sites', access, allowPrivate);
  return { sites, updatedAt: new Date().toISOString() };
}

/**
 * The sites as they apply under `access` now: a Boton moved to Workspace access loses the private addresses the
 * operator didn't allow, without the owner having to edit its list.
 */
export function effectiveSites(sites: string[], access: AccessLevel, allowPrivate: string[]): string[] {
  return sites.filter((raw) => {
    const s = parseSite(raw);
    return !!s && siteProblem(s, access, allowPrivate) === null;
  });
}

export function parsePolicy(raw: string | undefined): BrowserPolicy {
  if (!raw) return { ...NO_BROWSER };
  try {
    const v = JSON.parse(raw);
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    return { sites: list(v.sites), updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null };
  } catch {
    return { ...NO_BROWSER };
  }
}

/** What the browser may do with one request: load it, or refuse it with why (`write`: a write to an allowed site, which a card may let through once). */
export type RequestVerdict = { ok: true } | { ok: false; why: string; write?: true };

/**
 * The browser reads on its own: anything else (a form, a script's POST, a beacon, a CORS preflight for one) is refused
 * before it leaves Chromium, and again in the proxy for plain HTTP. The one way past is the owner's card: while the
 * Boton clicks or types, the first write to an allowed site is held, shown in full and sent once if allowed
 * (browser.ts, browser-request.ts).
 */
export const READ_METHODS = new Set(['GET', 'HEAD']);

/** Requests that change something, which the browser sends only through a card. Anything else not a read is refused. */
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80;
}

export const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** For the journal and the cards: never a query, fragment or credentials, which may be secrets. */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}…`;
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(not a URL)';
  }
}

/** A request the page makes: only http(s) to allowed sites, and only reads. Where the browser is off, see browser.ts. */
export function judgeRequest(raw: string, method: string, sites: string[]): RequestVerdict {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return { ok: true };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: `${u.protocol} addresses are not for the browser` };
  if (u.username || u.password) return { ok: false, why: 'an address with a user name or password in it' };
  const host = hostOf(u);
  const port = portOf(u);
  if (!siteFor(sites, host, port)) return { ok: false, why: `${u.host} is not one of the allowed sites` };
  const m = method.toUpperCase();
  if (!READ_METHODS.has(m)) return { ok: false, why: `a ${m} request to ${u.host}: the browser only reads pages, unless you allow one on a card`, ...(WRITE_METHODS.has(m) ? { write: true as const } : {}) };
  return { ok: true };
}
