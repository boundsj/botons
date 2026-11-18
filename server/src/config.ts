import { serverCommand } from './install-type.ts';
import { managedBin, managedRoot } from './managed-clis.ts';
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimezone } from '../../shared/util.ts';
import { applyLegacyEnv, DATA_DIRS, earlierEnvNames, isLegacySetting, type LegacyEnvNotice } from '../../shared/legacy-names.mjs';
import { dbFileIn } from './backup.ts';
import { parsePrivatePaths } from './isolation.ts';
import { LOG_LEVELS, type LogLevel } from './log.ts';
import { type TailscaleSelf, tailscaleSelfSync } from './tailnet.ts';

// Node builtins only: scripts/backup.ts imports this module and must run without node_modules.

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../..');

let buildCache: string | null | undefined;
/** The sha scripts/deploy.ts wrote to release.json, else the checkout's HEAD. */
export function buildId(root = appRoot): string | null {
  if (root === appRoot && buildCache !== undefined) return buildCache;
  let id: string | null = null;
  try {
    const sha = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).sha;
    if (typeof sha === 'string' && sha) id = sha;
  } catch {
    try {
      id = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {}
  }
  if (root === appRoot) buildCache = id;
  return id;
}

export interface CallbacksConfig {
  /** Hosts, addresses and CIDR ranges callbacks may reach although they are private or this machine's own. */
  allow: string[];
  timeoutMs: number;
  /** The waits before each retry. */
  retryDelaysMs: number[];
}

/** The Apple Push Notification service settings (BOTONS_APNS_*): all four, or none. The key itself is read from `keyFile` when a token is made, never kept here. */
export interface ApnsConfig {
  /** Absolute path of the .p8 key. */
  keyFile: string;
  /** Apple's 10-character key id and team id. */
  keyId: string;
  teamId: string;
  /** The app's bundle identifier. */
  topic: string;
}

export interface Config {
  home: string;
  /** Why `home` is that folder (see chooseHome). */
  homeSource: HomeSource;
  /** Settings given under a deprecated name (see shared/legacy-names.mjs). */
  envNotices: LegacyEnvNotice[];
  dbPath: string;
  workspacesDir: string;
  sharedDir: string;
  templatesDir: string;
  /** Skill packages the owner puts here (a folder each, with a SKILL.md) can be reviewed and installed. Nothing in it is run. */
  skillPackagesDir: string;
  agentsDir: string;
  backupsDir: string;
  port: number;
  /** Always includes loopback. */
  hosts: string[];
  tailscale: {
    /** False with BOTONS_NO_TAILSCALE=1: no `tailscale` calls at all. */
    enabled: boolean;
    /** bind: listen on the Tailscale address too; names: only use its names (BOTONS_HOST already reaches the tailnet). */
    mode: 'bind' | 'names' | 'off';
    pollMs: number;
    initial: TailscaleSelf;
  };
  /** These two follow the tailnet (see applyTailnet). */
  publicUrl: string;
  urls: string[];
  publicUrlOverride: string | null;
  allowedHosts: string[];
  hostname: string;
  defaultTimezone: string;
  maxConcurrentTurns: number;
  turnTimeoutMs: number;
  approvalWaitMs: number;
  webDist: string;
  botonBinDir: string;
  enableMock: boolean;
  schedulerIntervalMs: number;
  /** How often the team supervisor looks at teams' work (BOTONS_TEAM_SUPERVISOR_MS). */
  teamSupervisorMs: number;
  claudeBin: string;
  codexBin: string;
  drainMs: number;
  build: string | null;
  privatePaths: string[];
  ssePingMs: number;
  authEnabled: boolean;
  ownerLogin: string | null;
  routineRunsPerHour: number;
  runsPerHour: number;
  runRetries: number;
  runRetryDelayMs: number;
  logLevel: LogLevel;
  /** The hooks-only listener, for the internet (Tailscale Funnel). */
  hooks: { port: number | null; hosts: string[]; publicUrl: string | null; timeoutMs: number };
  callbacks: CallbacksConfig;
  /** OAuth connectors: the HTTPS base that reaches /oauth/callback (a Tailscale Serve path, say), and private hosts their servers may be on. */
  oauth: { publicUrl: string | null; allow: string[] };
  asksPerPairPerHour: number;
  asksPerHour: number;
  /** BOTONS_CONTAINER=1 (the Docker image): callers arrive through the bridge network or a sidecar. */
  container: boolean;
  /** Push to the native app (BOTONS_APNS_*); null when none of the four is set. */
  apns: ApnsConfig | null;
  /**
   * The managed browser: the Chromium to run (BOTONS_BROWSER_PATH; empty: look for one), whether it shows a window
   * (BOTONS_BROWSER_HEADED=1, on a desktop host), whether Chromium's own sandbox is on (BOTONS_BROWSER_SANDBOX=0
   * turns it off, where a host can't start it), and loopback or private host:port addresses a Workspace
   * Boton's allowed sites may name (BOTONS_BROWSER_ALLOW; a Full computer Boton may name any).
   */
  browser: { path: string; headed: boolean; sandbox: boolean; allowPrivate: string[]; apnsDownloadDir?: string };
}

/** The server reports every bad setting at once and exits 78 (EX_CONFIG). */
/** BOTONS_HOME cannot be created or written by this user: a restart cannot fix it, its owner or mode must change. */
export class DataDirError extends Error {
  constructor(home: string, err: NodeJS.ErrnoException) {
    super(
      `The data folder ${home} is not writable by this user (${err.code}: ${err.message}). Nothing was changed. Run the server as the user that owns it, or give that user write access to it (for example chmod u+rwx on the folder), then start it again; \`${serverCommand('doctor')}\` checks it.`,
    );
    this.name = 'DataDirError';
  }
}

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid configuration:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/** The default data folder, under the user's home. */
export const DEFAULT_HOME = '.botons';

/** BOTONS_HOME, the default ~/.botons, or a data folder still under an earlier name (shared/legacy-names.mjs) before its first start here moves it. */
export type HomeSource = 'BOTONS_HOME' | 'default' | 'legacy';

export interface HomeChoice {
  home: string;
  source: HomeSource;
}

/** Neither folder can be chosen without risking the wrong data: two data folders exist, or two settings disagree. */
export class HomeConflictError extends ConfigError {
  constructor(text: string) {
    super([text]);
    this.name = 'HomeConflictError';
  }
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const realOrNull = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The data folder, and why it is that one. Nothing here creates, moves or links anything.
 * - BOTONS_HOME (or a deprecated name for it); two of them naming different folders is refused. A deprecated
 *   default folder named there that now links to ~/.botons counts as ~/.botons.
 * - Otherwise ~/.botons. Before an install's first start under this name moves it there (server/src/legacy-upgrade.ts),
 *   its folder may still be under an earlier default name: that one, then. Two unrelated folders are refused.
 */
export function chooseHome(env: NodeJS.ProcessEnv = process.env, home = env.HOME?.trim() || homedir()): HomeChoice {
  const fresh = join(home, DEFAULT_HOME);
  const same = (p: string) => realOrNull(p) ?? resolve(p);
  const named = ['BOTONS_HOME', ...earlierEnvNames('BOTONS_HOME')].flatMap((k) => (env[k]?.trim() ? [[k, resolve(env[k]!.trim())] as const] : []));
  const other = named.find(([, p]) => same(p) !== same(named[0][1]));
  if (other) {
    throw new HomeConflictError(`${named[0][0]} (${named[0][1]}) and ${other[0]} (${other[1]}) name different data folders. Set only BOTONS_HOME, to the folder that holds this server's data. Nothing was changed.`);
  }
  const earlier = DATA_DIRS.map((d) => join(home, d));
  if (named.length) {
    const p = named[0][1];
    // A deprecated default folder that the upgrade moved (and left a link at) is ~/.botons by its own name.
    if (earlier.includes(p) && lstatOrNull(p)?.isSymbolicLink() && lstatOrNull(fresh) && realOrNull(p) === realOrNull(fresh)) return { home: fresh, source: 'BOTONS_HOME' };
    // Or one a stopped upgrade moved before it could leave the link: never a new, empty folder in its place.
    if (earlier.includes(p) && !lstatOrNull(p) && lstatOrNull(fresh)?.isDirectory()) return { home: fresh, source: 'BOTONS_HOME' };
    return { home: p, source: 'BOTONS_HOME' };
  }
  const freshReal = lstatOrNull(fresh) ? realOrNull(fresh) : null;
  const legacy = [...new Set(earlier.filter((p) => lstatOrNull(p)).map((p) => realOrNull(p)).filter((p): p is string => p !== null && p !== freshReal))];
  if (legacy.length > 1 || (legacy.length === 1 && lstatOrNull(fresh))) {
    const both = lstatOrNull(fresh) ? [fresh, legacy[0]] : legacy;
    throw new HomeConflictError(
      `Both ${both[0]} and ${both[1]} exist, and neither links to the other, so which holds this server's data is not clear. Set BOTONS_HOME to the one to use (and move the other away). Nothing was changed.`,
    );
  }
  if (legacy.length === 1) return { home: legacy[0], source: 'legacy' };
  return { home: fresh, source: 'default' };
}

export function botonsHome(env: NodeJS.ProcessEnv = process.env): string {
  return chooseHome(env).home;
}

/** A server or turn setting (BOTONS_*, BOTON_*), under its name or a deprecated one: env files and copies of the environment keep these. */
export const isBotonsSetting = (name: string) => /^BOTONS?_[A-Z0-9_]+$/.test(name) || isLegacySetting(name);

/** Empty counts as unset. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

const APNS_NAMES = ['BOTONS_APNS_KEY_FILE', 'BOTONS_APNS_KEY_ID', 'BOTONS_APNS_TEAM_ID', 'BOTONS_APNS_TOPIC'] as const;

/**
 * Push to the native app: all four settings or none. The key file must hold an EC P-256 private key (Apple's .p8);
 * what is wrong is named, never what the file holds.
 */
function apnsSettings(env: NodeJS.ProcessEnv, errors: string[]): ApnsConfig | null {
  const [keyFile, keyId, teamId, topic] = APNS_NAMES.map((n) => read(env, n));
  const missing = APNS_NAMES.filter((n) => read(env, n) === undefined);
  if (missing.length === APNS_NAMES.length) return null;
  if (missing.length) {
    errors.push(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set: push to the app needs all of ${APNS_NAMES.join(', ')}, or none of them`);
    return null;
  }
  let ok = true;
  const bad = (msg: string) => {
    errors.push(msg);
    ok = false;
  };
  if (!/^[A-Z0-9]{10}$/.test(keyId!)) bad('BOTONS_APNS_KEY_ID must be the key\'s 10-character id from Apple (capital letters and digits)');
  if (!/^[A-Z0-9]{10}$/.test(teamId!)) bad('BOTONS_APNS_TEAM_ID must be the 10-character team id from Apple (capital letters and digits)');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/.test(topic!)) bad('BOTONS_APNS_TOPIC must be the app\'s bundle identifier, such as com.example.botons');
  const file = resolve(keyFile!);
  let pem: Buffer | null = null;
  try {
    pem = readFileSync(file);
  } catch (err) {
    bad(`BOTONS_APNS_KEY_FILE cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}): it must be the .p8 file Apple gives for the key`);
  }
  if (pem) {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') bad('BOTONS_APNS_KEY_FILE must hold an EC P-256 private key (the .p8 file Apple gives for the key)');
    } catch {
      bad('BOTONS_APNS_KEY_FILE does not hold a private key in PEM form (the .p8 file Apple gives for the key)');
    }
  }
  return ok ? { keyFile: file, keyId: keyId!, teamId: teamId!, topic: topic! } : null;
}

/** scripts/install-service.ts sets the unit's TimeoutStopSec above it. */
export const DEFAULT_DRAIN_MS = 2 * 60_000;

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "20m", "90s", "1.5h", "250ms", or bare milliseconds; else NaN. */
export function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(raw.trim());
  return m ? Math.round(Number(m[1]) * UNITS[(m[2] ?? 'ms').toLowerCase()]) : NaN;
}

export function formatDuration(ms: number): string {
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

// Anything else is an error: a typo must not silently leave auth on or off.
const AUTH_VALUES = ['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'] as const;
const AUTH_OFF = new Set<string>(['off', 'false', '0', 'no']);

/** Addresses that let Botons reach the server at http://127.0.0.1:<port>. */
const LOOPBACK_OK = new Set(['127.0.0.1', '0.0.0.0', '::']);
const isLoopback = (h: string) => h === 'localhost' || h === '::1' || h.startsWith('127.');

/** Throws ConfigError before creating any folder. `create: false` (for `${serverCommand('doctor')}`) creates none at all. */
export function loadConfig(given: NodeJS.ProcessEnv = process.env, probe: () => TailscaleSelf = tailscaleSelfSync, opts: { create?: boolean } = {}): Config {
  const errors: string[] = [];
  const env: NodeJS.ProcessEnv = { ...given };
  const envNotices = applyLegacyEnv(env);
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = read(env, name);
    if (raw === undefined) return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n)) errors.push(`${name} must be a whole number; got "${raw}"`);
    else if (n < min || n > max) errors.push(`${name} must be between ${min} and ${max}; got ${n}`);
    else return n;
    return fallback;
  };
  const duration = (name: string, fallback: number, min: number, max: number): number => {
    const raw = read(env, name);
    if (raw === undefined) return fallback;
    const ms = parseDuration(raw);
    if (Number.isNaN(ms)) errors.push(`${name} must be a duration such as 20m, 90s or 1200000 (milliseconds); got "${raw}"`);
    else if (ms < min || ms > max) errors.push(`${name} must be between ${formatDuration(min)} and ${formatDuration(max)}; got "${raw}"`);
    else return ms;
    return fallback;
  };
  const choice = <T extends string>(name: string, options: readonly T[], fallback: T): T => {
    const raw = read(env, name);
    if (raw === undefined) return fallback;
    const v = raw.toLowerCase();
    if ((options as readonly string[]).includes(v)) return v as T;
    errors.push(`${name} must be one of ${options.join(', ')}; got "${raw}"`);
    return fallback;
  };
  const { home, source: homeSource } = chooseHome(env);

  // BOTONS_PORT wins over PORT, which other tools set. Not 0: every listener and Boton uses cfg.port.
  const portVar = read(env, 'BOTONS_PORT') !== undefined ? 'BOTONS_PORT' : 'PORT';
  const port = int(portVar, 7777, 1, 65535);

  // Default: loopback plus the Tailscale address (bound by the app), so the tailnet reaches it but not the LAN.
  const hostVar = read(env, 'BOTONS_HOST');
  const hosts = hostVar ? hostVar.split(',').map((h) => h.trim()).filter(Boolean) : ['127.0.0.1'];
  if (hostVar && !hosts.some((h) => LOOPBACK_OK.has(h))) {
    errors.push(`BOTONS_HOST must include 127.0.0.1 (or 0.0.0.0 or ::), because Botons reach the server at http://127.0.0.1:<port>; got "${hostVar}"`);
  }
  const noTailscale = env.BOTONS_NO_TAILSCALE === '1';
  const mode: Config['tailscale']['mode'] = noTailscale ? 'off' : !hostVar ? 'bind' : hosts.some((h) => !isLoopback(h)) ? 'names' : 'off';
  const pollMs = duration('BOTONS_TAILSCALE_POLL_MS', 20_000, 100, 3_600_000);

  const tzVar = read(env, 'BOTONS_TZ');
  if (tzVar && !isValidTimezone(tzVar)) errors.push(`BOTONS_TZ is not a timezone this system knows (an IANA name such as America/New_York); got "${tzVar}"`);
  const defaultTimezone = tzVar && isValidTimezone(tzVar) ? tzVar : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');

  const baseUrl = (name: string): string | null => {
    const raw = read(env, name);
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http');
      return raw.replace(/\/+$/, '');
    } catch {
      errors.push(`${name} must be an http:// or https:// URL; got "${raw}"`);
      return null;
    }
  };
  const publicUrlOverride = baseUrl('BOTONS_PUBLIC_URL');

  const hooksPort = read(env, 'BOTONS_HOOKS_PORT') === undefined ? null : int('BOTONS_HOOKS_PORT', 0, 1, 65535) || null;
  if (hooksPort !== null && hooksPort === port) errors.push(`BOTONS_HOOKS_PORT must differ from the main port (${port}); got ${hooksPort}`);
  const hooksHostVar = read(env, 'BOTONS_HOOKS_HOST');
  const hooksHosts = hooksHostVar ? hooksHostVar.split(',').map((h) => h.trim()).filter(Boolean) : ['127.0.0.1'];
  const hooksPublicUrl = baseUrl('BOTONS_HOOKS_PUBLIC_URL');
  const allowList = (name: string): string[] => {
    const list = (read(env, name) ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    for (const entry of list) {
      const [ip, bits, ...extra] = entry.split('/');
      const family = isIP(ip);
      const max = family === 6 ? 128 : 32;
      if (bits === undefined ? /[/:\s]/.test(entry) && !family : !family || extra.length || !/^\d{1,3}$/.test(bits) || Number(bits) > max) {
        errors.push(`${name} entries must be host names, IP addresses or CIDR ranges such as 100.64.0.0/10; got "${entry}"`);
      }
    }
    return list;
  };
  const callbackAllow = allowList('BOTONS_CALLBACK_ALLOW');
  const oauthAllow = allowList('BOTONS_OAUTH_ALLOW');
  const browserAllow = (read(env, 'BOTONS_BROWSER_ALLOW') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of browserAllow) {
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/.test(entry)) errors.push(`BOTONS_BROWSER_ALLOW entries must be host:port, such as 127.0.0.1:8080; got "${entry}"`);
  }
  // Only a bare HTTPS origin: the redirect URI is exactly <it>/oauth/callback, and the app itself stays on HTTP.
  const oauthRaw = read(env, 'BOTONS_OAUTH_PUBLIC_URL');
  let oauthPublicUrl: string | null = null;
  if (oauthRaw) {
    let u: URL | null = null;
    try {
      u = new URL(oauthRaw);
    } catch {}
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      errors.push(`BOTONS_OAUTH_PUBLIC_URL must be an https:// origin with no path, such as https://myhost.example-tailnet.ts.net; got "${oauthRaw}"`);
    } else oauthPublicUrl = u.origin;
  }

  const apns = apnsSettings(env, errors);
  const maxConcurrentTurns = int('BOTONS_MAX_CONCURRENT', 3, 1, 64);
  const turnTimeoutMs = duration('BOTONS_TURN_TIMEOUT_MS', 20 * 60_000, 1000, 24 * 3_600_000);
  const approvalWaitMs = Math.min(duration('BOTONS_APPROVAL_WAIT', 5 * 60_000, 1000, 3_600_000), Math.floor(turnTimeoutMs / 2));
  const schedulerIntervalMs = duration('BOTONS_SCHEDULER_MS', 10_000, 50, 3_600_000);
  const teamSupervisorMs = duration('BOTONS_TEAM_SUPERVISOR_MS', 30_000, 50, 3_600_000);
  const drainMs = duration('BOTONS_DRAIN_MS', DEFAULT_DRAIN_MS, 0, 30 * 60_000);
  const ssePingMs = duration('BOTONS_SSE_PING_MS', 25_000, 1000, 3_600_000);
  const routineRunsPerHour = int('BOTONS_ROUTINE_RUNS_PER_HOUR', 30, 1, 100_000);
  const runsPerHour = int('BOTONS_RUNS_PER_HOUR', 100, 1, 100_000);
  const runRetries = int('BOTONS_RUN_RETRIES', 3, 0, 10);
  const runRetryDelayMs = duration('BOTONS_RUN_RETRY_DELAY', 60_000, 10, 3_600_000);
  const logLevel = choice('BOTONS_LOG_LEVEL', LOG_LEVELS, 'info');
  const auth = choice('BOTONS_AUTH', AUTH_VALUES, 'on');
  const asksPerPairPerHour = int('BOTONS_ASKS_PER_PAIR_PER_HOUR', 20, 1, 100_000);
  const asksPerHour = int('BOTONS_ASKS_PER_HOUR', 100, 1, 100_000);

  if (errors.length) throw new ConfigError(errors);

  const workspacesDir = join(home, 'workspaces');
  const apnsDownloadDir = read(env, 'BOTONS_BROWSER_APNS_DOWNLOAD_DIR');
  const sharedDir = join(home, 'shared');
  if (opts.create !== false) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      accessSync(home, constants.W_OK | constants.X_OK);
      mkdirSync(workspacesDir, { recursive: true });
      mkdirSync(sharedDir, { recursive: true });
    } catch (err) {
      if (['EACCES', 'EPERM', 'EROFS'].includes((err as NodeJS.ErrnoException).code ?? '')) throw new DataDirError(home, err as NodeJS.ErrnoException);
      throw err;
    }
  }

  const cfg: Config = {
    home,
    homeSource,
    envNotices,
    dbPath: dbFileIn(home),
    workspacesDir,
    sharedDir,
    templatesDir: join(home, 'templates'),
    skillPackagesDir: join(home, 'skill-packages'),
    agentsDir: join(home, 'run', 'agents'),
    backupsDir: join(home, 'backups'),
    port,
    hosts,
    tailscale: { enabled: !noTailscale, mode, pollMs, initial: mode === 'off' ? { ip: null, dnsName: null } : probe() },
    publicUrl: '',
    urls: [],
    publicUrlOverride,
    allowedHosts: (read(env, 'BOTONS_ALLOWED_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    hostname: hostname(),
    defaultTimezone,
    maxConcurrentTurns,
    turnTimeoutMs,
    approvalWaitMs,
    webDist: resolve(here, '../../web/dist'),
    botonBinDir: resolve(here, '../bin'),
    enableMock: env.BOTONS_ENABLE_MOCK === '1',
    schedulerIntervalMs,
    teamSupervisorMs,
    claudeBin: managedBin(home, 'claude-cli', read(env, 'BOTONS_CLAUDE_BIN') ?? 'claude', managedRoot(env.HOME), env.PATH),
    codexBin: managedBin(home, 'codex-cli', read(env, 'BOTONS_CODEX_BIN') ?? 'codex', managedRoot(env.HOME), env.PATH),
    drainMs,
    build: buildId(),
    privatePaths: [...parsePrivatePaths(env.BOTONS_PRIVATE_PATHS), ...(apnsDownloadDir ? [resolve(apnsDownloadDir)] : [])],
    ssePingMs,
    authEnabled: !AUTH_OFF.has(auth),
    ownerLogin: read(env, 'BOTONS_OWNER_LOGIN') ?? null,
    routineRunsPerHour,
    runsPerHour,
    runRetries,
    runRetryDelayMs,
    logLevel,
    hooks: { port: hooksPort, hosts: hooksHosts, publicUrl: hooksPublicUrl, timeoutMs: 30_000 },
    callbacks: {
      allow: callbackAllow,
      timeoutMs: 10_000,
      retryDelaysMs: [5_000, 30_000, 120_000],
    },
    oauth: { publicUrl: oauthPublicUrl, allow: oauthAllow },
    browser: { path: read(env, 'BOTONS_BROWSER_PATH') ?? '', headed: env.BOTONS_BROWSER_HEADED === '1', sandbox: env.BOTONS_BROWSER_SANDBOX !== '0', allowPrivate: browserAllow, ...(apnsDownloadDir ? { apnsDownloadDir: resolve(apnsDownloadDir) } : {}) },
    asksPerPairPerHour,
    asksPerHour,
    container: env.BOTONS_CONTAINER === '1',
    apns,
  };
  // Only a candidate until the server has bound it, but at startup it nearly always binds.
  applyTailnet(cfg, cfg.tailscale.initial);
  return cfg;
}

/** Recompute `urls` and `publicUrl` when the Tailscale address appears or changes; everything reads cfg live. */
export function applyTailnet(cfg: Config, ts: TailscaleSelf): void {
  const urls: string[] = [];
  if (ts.dnsName) urls.push(`http://${ts.dnsName}:${cfg.port}`);
  if (ts.ip) urls.push(`http://${ts.ip}:${cfg.port}`);
  for (const h of cfg.hosts) {
    if (h === '0.0.0.0' || h === '::') urls.push(`http://${cfg.hostname}:${cfg.port}`);
    else if (!urls.some((u) => u.includes(`//${h}:`))) urls.push(`http://${h.includes(':') ? `[${h}]` : h}:${cfg.port}`);
  }
  cfg.urls = [...new Set(urls)];
  cfg.publicUrl = cfg.publicUrlOverride ?? cfg.urls[0] ?? `http://127.0.0.1:${cfg.port}`;
}

/** Besides IP literals, which are always accepted. */
export function allowedHostNames(cfg: Config): Set<string> {
  const host = (u: string) => new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return new Set(
    [
      'localhost',
      cfg.hostname.toLowerCase(),
      // And the short MagicDNS name, e.g. "myhost".
      ...cfg.urls.flatMap((u) => [host(u), host(u).split('.')[0]]),
      host(cfg.publicUrl),
      // A proxy may send the public webhook name to the main port too.
      ...(cfg.hooks.publicUrl ? [host(cfg.hooks.publicUrl)] : []),
      // The proxy in front of /oauth/callback sends its own name.
      ...(cfg.oauth.publicUrl ? [host(cfg.oauth.publicUrl)] : []),
      ...cfg.allowedHosts,
    ].filter(Boolean),
  );
}
