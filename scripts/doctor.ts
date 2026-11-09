import { BROWSER_CONNECTOR } from '../shared/util.ts';
import { cliHome, cliHomesEnv } from '../server/src/cli-homes.ts';
import { sandboxProblem } from '../server/src/sandbox.ts';
import { readReleaseChecks, newerRelease, botonsReleaseVersion } from '../server/src/cli-updates.ts';
// `npm run doctor [-- --json] [-- --env-path <file>]` (in Docker: `botons doctor`): checks an install and says
// what to fix. Unless --fix is explicitly confirmed it only reads: it creates no folder, opens the database read-only, starts and changes nothing, and
// prints no secret. Exit 0 when nothing failed (warnings allowed), 1 when something did, 2 when it could not run.
// Node builtins only, so it also runs before `npm ci`.
import '../server/src/env-init.ts';
import { createInterface } from 'node:readline/promises';
import { Resolver } from 'node:dns/promises';
import { connect, type Socket } from 'node:net';
import { previewCodexRepairs, repairCodexConfig } from '../server/src/codex-config-repair.ts';
import { HOST_ACTOR, recordAudit } from '../server/src/audit.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, copyFileSync, mkdtempSync, readdirSync, rmSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKUP_STALE_MS, backupTime, listBackups } from '../server/src/backup.ts';
import { type Config, ConfigError, loadConfig, botonsHome } from '../server/src/config.ts';
import { codexConfigSymlinks } from '../server/src/isolation.ts';
import { legacyEnvNoticeText } from '../shared/legacy-names.mjs';
import { legacyLeftovers } from '../server/src/legacy-upgrade.ts';
import { checkCli, checkCodexCli, cliStatus, parseClaudeLogin, terminalVersion } from '../server/src/providers/cli-check.ts';
import { isManagedBin, managedRoot } from '../server/src/managed-clis.ts';
import { cliVersion, terminalNote } from '../shared/versions.ts';
import { effortProblem } from '../shared/effort.ts';
import { SCHEMA_VERSION, UPGRADABLE_VERSIONS } from '../server/src/schema.ts';
import { ATTENTION_DAYS } from '../shared/util.ts';
import { FILES_WARN_BYTES, formatSize, INBOX_WARN_BYTES } from '../shared/files.ts';
import { folderBytesSync } from '../server/src/disk-usage.ts';
import type { TailscaleSelf } from '../server/src/tailnet.ts';
import { tailscaleSelfSync } from '../server/src/tailnet.ts';
import { defaultUnitName, serverEnv } from './install-service.ts';

export type Status = 'ok' | 'info' | 'warn' | 'fail';
export interface Finding {
  check: string;
  status: Status;
  message: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = 24;
/** The error a run cut off by a restart ends with (server/src/store.ts, failInterruptedRuns). */
const INTERRUPTED = 'Interrupted by a restart';

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  /** The service env file `env` came from, if any. */
  envFile?: string | null;
  app?: string;
  /** Default: whether this looks like a container. */
  container?: boolean;
  nodeVersion?: string;
  probe?: () => TailscaleSelf;
  /** Default: GET /api/health over loopback. */
  health?: (port: number) => Promise<{ status: number; body: any } | null>;
  /** Default: the CLIs' own checks (`--version`, then `auth status` / `login status`). */
  skipClis?: boolean;
  now?: number;
  /** Default: a quick lookup and connection to a well-known site over IPv4 and over IPv6 (only when a Chromium is found). */
  egress?: () => Promise<Egress | null>;
}

/** Whether this server reaches the internet over each family: what the browser can connect over. */
export interface Egress {
  v4: boolean;
  v6: boolean;
}

/** A well-known site with both IPv4 and IPv6 addresses. */
const EGRESS_HOST = 'example.com';
const EGRESS_MS = 2000;

/** How the egress probe looks a name up and connects: the system's own by default, stubbed in tests. */
export interface EgressNet {
  /** Addresses of `host` in one family; cancel() ends every lookup still under way. */
  resolve(host: string, family: 4 | 6): Promise<string[]>;
  cancel(): void;
  connect(host: string, port: number): Socket;
}

function systemNet(): EgressNet {
  // c-ares, not getaddrinfo: a lookup that outlives the deadline is cancelled, so it can't hold the doctor open.
  const resolver = new Resolver({ timeout: EGRESS_MS, tries: 1 });
  return {
    resolve: (host, family) => (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host)),
    cancel: () => resolver.cancel(),
    connect: (host, port) => connect({ host, port }),
  };
}

/**
 * Resolves EGRESS_HOST in each family and connects to its port 443, both families within one deadline of `ms`. At the
 * deadline every lookup still under way is cancelled and every socket destroyed, and nothing starts after it.
 */
export function probeEgress(net: EgressNet = systemNet(), ms = EGRESS_MS): Promise<Egress> {
  const sockets = new Set<Socket>();
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
    timer.unref();
  });
  const seen: Egress = { v4: false, v6: false };
  const one = async (family: 4 | 6) => {
    const [address] = await net.resolve(EGRESS_HOST, family);
    if (over || !address) return;
    const ok = await new Promise<boolean>((done) => {
      const sock = net.connect(address, 443);
      sockets.add(sock);
      const end = (v: boolean) => {
        sockets.delete(sock);
        sock.destroy();
        done(v);
      };
      sock.once('connect', () => end(true));
      sock.once('error', () => end(false));
      sock.once('close', () => end(false));
    });
    if (!over) seen[family === 4 ? 'v4' : 'v6'] = ok;
  };
  const both = Promise.all([one(4).catch(() => {}), one(6).catch(() => {})]);
  return Promise.race([both, deadline]).then(() => {
    over = true;
    clearTimeout(timer);
    net.cancel();
    for (const s of sockets) s.destroy();
    sockets.clear();
    return { ...seen };
  });
}

/** What the browser's network is, from `e`: informational unless it reaches nothing at all. */
export function egressFinding(e: Egress): { status: Status; message: string; fix?: string } {
  if (e.v4 && e.v6) return { status: 'ok', message: 'The browser reaches sites over IPv4 and IPv6' };
  if (e.v4) return { status: 'info', message: 'IPv6 isn\u2019t available on this server; the browser uses IPv4' };
  if (e.v6) return { status: 'info', message: 'IPv4 isn\u2019t available on this server; the browser uses IPv6' };
  return { status: 'warn', message: `Couldn\u2019t reach ${EGRESS_HOST} over IPv4 or IPv6: the browser may not load any site`, fix: 'Check this server\u2019s internet connection and DNS.' };
}

function inContainer(env: NodeJS.ProcessEnv): boolean {
  if (env.BOTONS_CONTAINER === '1' || existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    return /\b(docker|containerd|kubepods|libpod)\b/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/** Whether `path` is a mount point (a volume, in a container). Null when that can't be told. */
function isMountPoint(path: string): boolean | null {
  try {
    const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .map((l) => l.split(' ')[4]?.replace(/\\040/g, ' '));
    const target = resolve(path);
    return mounts.some((m) => m === target);
  } catch {
    return null;
  }
}

function onPath(cmd: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return join(dir, cmd);
    } catch {}
  }
  return null;
}

async function defaultHealth(port: number): Promise<{ status: number; body: any } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

const isLoopbackHost = (h: string) => h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
const isTailnetHost = (h: string) => h.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);

/**
 * Each Boton's saved provider, model and configured effort ("none": the CLI's default), and routine overrides.
 * The engine can omit a configured level when the model list changes. CLIs can also use a different level and
 * do not report which ran. This read-only check describes saved configuration, not a turn's request. Effort is saved since schema 26; before that no turn asks for one.
 */
function brainFindings(db: DatabaseSync, version: number, add: (check: string, status: Status, message: string, fix?: string) => void) {
  const effort = version >= 26;
  let bots: Record<string, unknown>[];
  let routines: Record<string, unknown>[];
  try {
    bots = db.prepare(`select id, name, provider, model${effort ? ', effort' : ''} from bots order by created_at, rowid`).all();
    routines = db.prepare(`select bot_id, name, model${effort ? ', effort' : ''} from routines where model is not null${effort ? ' or effort is not null' : ''} order by created_at, rowid`).all();
  } catch {
    return;
  }
  for (const b of bots) {
    const provider = String(b.provider);
    const level = (v: unknown) => {
      const e = typeof v === 'string' ? v : '';
      if (!e) return 'none (the CLI\'s default)';
      return effortProblem(provider, e) ? `${e} (not one of ${provider}'s levels: not asked for)` : e;
    };
    const own = routines
      .filter((r) => r.bot_id === b.id)
      .map((r) => {
        const bits = [r.model ? `model ${String(r.model)}` : '', r.effort ? `configured effort ${level(r.effort)}` : ''].filter(Boolean);
        return `“${String(r.name)}” ${bits.join(', ')}`;
      });
    const model = String(b.model ?? '') || 'default';
    add('brain', 'info', `${String(b.name)}: ${provider}, model ${model}, configured effort ${level(b.effort)}${own.length ? `; routines with their own: ${own.join('; ')}` : ''}`);
  }
}

export async function diagnose(o: DoctorOptions): Promise<Finding[]> {
  const out: Finding[] = [];
  const orNull = <T>(get: () => T): T | null => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  const workspaceUnavailable: string[] = [];
  const add = (check: string, status: Status, message: string, fix?: string) => out.push({ check, status, message, ...(fix ? { fix } : {}) });
  const app = o.app ?? repo;
  const env = o.env;
  const container = o.container ?? inContainer(env);
  const managed = basename(dirname(app)) === 'releases' && existsSync(join(dirname(dirname(app)), 'installer.json'));
  const pairCommand = managed ? 'botons pair' : container ? 'docker compose exec botons botons pair' : 'npm run pair --';
  const now = o.now ?? Date.now();
  const where = container ? 'in the container' : 'on this machine';

  // Node and the install.
  const nodeVersion = o.nodeVersion ?? process.versions.node;
  if (Number(nodeVersion.split('.')[0]) >= MIN_NODE) add('node', 'ok', `Node ${nodeVersion}`);
  else add('node', 'fail', `Node ${nodeVersion} is too old`, `Install Node ${MIN_NODE} or newer.`);
  if (!existsSync(join(app, 'node_modules', 'croner'))) add('install', 'fail', `${app} has no node_modules`, managed ? 'Run `botons repair`.' : 'Run `npm ci` there.');
  else if (!existsSync(join(app, 'web', 'dist', 'index.html'))) add('install', 'warn', 'The web app is not built: the server answers with a "not built yet" page', managed ? 'Run `botons repair`.' : 'Run `npm run build`.');
  else add('install', 'ok', `${app} is installed and its web app built`);
  if (o.envFile) add('env file', 'info', `Settings from ${o.envFile} (BOTONS_HOME is not set in this shell)`);

  // Settings, exactly as the server reads them, without creating anything.
  let cfg: Config;
  try {
    cfg = loadConfig(env, o.probe ?? tailscaleSelfSync, { create: false });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const e of err.errors) add('config', 'fail', e, 'Fix it in the environment (the service env file, or .env for Docker); the server refuses to start (exit 78) until then.');
    return out;
  }
  // Deprecated names (shared/legacy-names.mjs): one line each.
  for (const n of cfg.envNotices) add('config', 'warn', legacyEnvNoticeText(n));
  for (const line of legacyLeftovers({ env })) add('deprecated', 'info', line);
  add('config', 'ok', `Settings are valid: port ${cfg.port}, listening on ${cfg.hosts.join(', ')}${cfg.tailscale.mode === 'bind' ? ' and the Tailscale address' : ''}`);

  // Who can reach it.
  if (!cfg.authEnabled) add('auth', 'fail', 'BOTONS_AUTH=off: anyone who can reach the server can use it, Botons included', 'Remove BOTONS_AUTH as soon as a device is paired.');
  const everywhere = cfg.hosts.some((h) => h === '0.0.0.0' || h === '::');
  if (container) {
    if (!everywhere) add('exposure', 'fail', 'In a container the server must listen on 0.0.0.0 for the published port to reach it', 'Set BOTONS_HOST=0.0.0.0 (the image does by default).');
    else add('exposure', 'info', 'Listens on every interface of the container; the published port (compose.yaml: 127.0.0.1 unless BOTONS_BIND says otherwise) decides who reaches it');
  } else if (everywhere) {
    add('exposure', 'warn', 'BOTONS_HOST listens on every interface: the LAN (or the internet, on a VPS) reaches it unless a firewall stops it', 'Prefer the default (loopback plus Tailscale), or confirm the firewall before keeping it.');
  } else add('exposure', 'ok', `Listens on ${cfg.hosts.join(', ')}${cfg.tailscale.mode === 'bind' ? ' and the Tailscale address' : ''} only`);
  const publicHost = new URL(cfg.publicUrl).hostname.toLowerCase();
  if (cfg.publicUrl.startsWith('http://') && !isLoopbackHost(publicHost) && !isTailnetHost(publicHost)) {
    add('exposure', 'warn', `The public URL ${cfg.publicUrl} is plain HTTP on a non-tailnet address: device tokens would cross the network unencrypted`, 'Put HTTPS in front (Tailscale Serve or a reverse proxy, see docs/DOCKER.md) and set BOTONS_PUBLIC_URL to it.');
  }
  if (cfg.hooks.port !== null) add('exposure', 'info', `Webhooks-only listener on ${cfg.hooks.hosts.join(', ')}:${cfg.hooks.port}${cfg.hooks.publicUrl ? ` (public at ${cfg.hooks.publicUrl})` : ''}`);

  if (cfg.tailscale.mode === 'off') add('tailscale', 'info', container ? 'Not used inside the container (BOTONS_NO_TAILSCALE=1): devices pair with a code' : 'Not used: devices pair with a code');
  else if (cfg.tailscale.initial.ip) add('tailscale', 'ok', `Up as ${cfg.tailscale.initial.dnsName ?? cfg.tailscale.initial.ip}; your own devices pair with one click`);
  else add('tailscale', 'info', 'Not up: only this machine reaches the server until it is (the server notices within BOTONS_TAILSCALE_POLL_MS)');

  // The data folder and the database.
  const home = cfg.home;
  if (!existsSync(home)) add('data', 'info', `${home} does not exist yet; the server creates it at its first start`);
  else {
    const st = statSync(home);
    if (!st.isDirectory()) add('data', 'fail', `${home} is not a folder`);
    else {
      try {
        accessSync(home, constants.W_OK);
        if (st.mode & 0o077) add('data', 'warn', `${home} can be read by other users (mode ${(st.mode & 0o777).toString(8)})`, `chmod 700 ${home}`);
        else add('data', 'ok', `${home} is private to its owner`);
      } catch {
        add('data', 'fail', `${home} is not writable by this user`, 'Run the server (and this) as the user that owns the data folder.');
      }
    }
    if (container) {
      const mounted = isMountPoint(home);
      if (mounted === false) add('data', 'fail', `${home} is not a volume: everything in it is lost with the container`, 'Mount a volume there (compose.yaml does).');
      const userHome = homedir();
      if (isMountPoint(userHome) === false) add('data', 'warn', `${userHome} is not a volume: the CLI logins in it are lost with the container`, 'Mount a volume there (compose.yaml does).');
    }
  }
  const dbPath = cfg.dbPath;
  /** The names of the Botons on each brain (by provider id: claude-cli, codex-cli), oldest first. */
  const botonsOn = new Map<string, string[]>();
  if (existsSync(dbPath)) {
    const snapshot = mkdtempSync(join(tmpdir(), 'botons-doctor-'));
    try {
      // SQLite read-only opens can still create WAL sidecars. Inspect a disposable copy including committed WAL.
      // This diagnostic snapshot is best effort if the server is writing concurrently.
      const copy = join(snapshot, 'botons.db');
      copyFileSync(dbPath, copy);
      for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        db.exec('pragma busy_timeout = 2000');
        const version = Number(db.prepare('pragma user_version').get()!.user_version);
        if (version === SCHEMA_VERSION) add('database', 'ok', `Schema v${version}`);
        else if (UPGRADABLE_VERSIONS.includes(version)) add('database', 'info', `Schema v${version}; this code upgrades it to v${SCHEMA_VERSION} at its next start (back it up first)`);
        else if (version > SCHEMA_VERSION) add('database', 'fail', `Schema v${version} is newer than this code's v${SCHEMA_VERSION}`, 'Run the release that wrote it, or restore an older backup.');
        else add('database', 'fail', `Schema v${version} can't be opened by this code (v${SCHEMA_VERSION})`, 'Restore a backup made by this release.');
        const devices = orZero(() => Number(db.prepare("select count(*) as n from auth_tokens where kind = 'device'").get()!.n));
        if (devices === 0 && cfg.authEnabled) add('devices', 'warn', 'No device is paired yet', `Open the web app, which shows a code, and approve it: ${pairCommand} --approve <code>`);
        else if (devices > 0) add('devices', 'ok', `${devices} paired device${devices === 1 ? '' : 's'}`);
        // The owner's access mode (Settings → Access): which networks the server accepts requests from.
        const mode = orNull(() => String(db.prepare("select value from settings where key = 'accessMode'").get()?.value ?? '')) || null;
        const modeCmd = `${pairCommand} --access-mode <mode>`;
        if (!mode) add('access', 'info', 'No access mode chosen: only the listeners decide which networks connect', `Choose one in Settings → Access, or ${modeCmd}`);
        else if (mode === 'public' && !(cfg.publicUrlOverride ?? '').startsWith('https://')) add('access', 'fail', 'The access mode is public, but BOTONS_PUBLIC_URL is not https://', `Put an HTTPS proxy in front and set BOTONS_PUBLIC_URL, or ${modeCmd}`);
        else add('access', 'ok', `Access mode: ${mode}`);
        for (const b of orNull(() => db.prepare('select provider, name from bots order by created_at, rowid').all()) ?? []) {
          const id = String(b.provider);
          botonsOn.set(id, [...(botonsOn.get(id) ?? []), String(b.name)]);
        }
        brainFindings(db, version, add);
        // A brain at its usage limit: its Botons' chats and runs wait for the reset, then carry on by themselves.
        const limits = orNull(() => db.prepare('select provider, until from provider_cooldowns where until > ? order by provider').all(new Date(now).toISOString())) ?? [];
        for (const l of limits) {
          if (!Number.isFinite(Date.parse(String(l.until)))) {
            add('limits', 'warn', 'A stored provider usage-limit reset time is invalid', 'Check the provider usage-limit state before relying on automatic recovery.');
            continue;
          }
          const on = botonsOn.get(String(l.provider)) ?? [];
          const who = on.length === 1 ? `${on[0]} waits` : on.length ? `${botonList(on)} wait` : 'its Botons wait';
          const carry = on.length === 1 ? 'carries' : 'carry';
          add(
            'limits',
            'info',
            `${String(l.provider).replace(/-cli$/, '')} reached its usage limit: ${who} until ${utc(String(l.until))}, then ${carry} on by ${on.length === 1 ? 'itself' : 'themselves'}, unless paused (resume first)`,
            'To carry on sooner, move a Boton to another signed-in brain in its settings: what it was waiting to do runs there, in a new session, unless paused (resume first).',
          );
        }
        connectorFindings(db, version, add);
        // Routine runs that need the owner: failed and not retried (test runs, and runs the owner cancelled, aside), or waiting to try again.
        // Since 23, the runs table and its meta are as this code reads them.
        if (version >= 23 && version <= SCHEMA_VERSION) {
          const since = new Date(now - ATTENTION_DAYS * 86_400_000).toISOString();
          const failed = orNull(() =>
            db
              .prepare(
                `select count(*) as n, coalesce(sum(error = ?), 0) as cut from routine_runs where status = 'failed' and trigger != 'test' and finished_at >= ?
                   and json_extract(coalesce(meta, '{}'), '$.retriedAs') is null and json_extract(coalesce(meta, '{}'), '$.cancelled') is null`,
              )
              .get(INTERRUPTED, since),
          );
          const held = orZero(() => Number(db.prepare("select count(*) as n from routine_runs where status = 'queued' and trigger != 'test' and retry_at is not null").get()!.n));
          const n = Number(failed?.n ?? 0);
          const cut = Number(failed?.cut ?? 0);
          const days = `the last ${ATTENTION_DAYS} days`;
          if (failed && n === 0) add('runs', 'ok', `No routine run failed in ${days}${held ? '' : ' or is waiting to try again'}`);
          else if (failed) {
            add(
              'runs',
              'info',
              `${n} routine run${n === 1 ? '' : 's'} failed in ${days} and ${n === 1 ? 'was' : 'were'} not retried${cut ? ` (${cut} interrupted by a restart)` : ''}`,
              'Settings → Runs to check lists them; retry one there if it still matters (it may have partly run).',
            );
          }
          if (held) add('runs', 'info', `${held} routine run${held === 1 ? ' is' : 's are'} waiting to try again by ${held === 1 ? 'itself' : 'themselves'} (a network error or a usage limit)`);
          // Results the routine's callback URL never got, every retry spent (the server sends pending ones again at its start).
          const undelivered = orZero(() =>
            Number(
              db
                .prepare(
                  `select count(*) as n from routine_runs r where trigger != 'test' and finished_at >= ?
                     and json_extract(meta, '$.callback.ok') = 0 and coalesce(json_extract(meta, '$.callback.pending'), 0) = 0
                     and (select callback_url from routines t where t.id = r.routine_id) is not null`,
                )
                .get(since)!.n,
            ),
          );
          if (undelivered) {
            add(
              'runs',
              'info',
              `${undelivered} routine run${undelivered === 1 ? '' : 's'} in ${days} could not send ${undelivered === 1 ? 'its result' : 'their results'} to the callback URL`,
              'Settings → Runs to check lists them; fix the receiver, then resend from there.',
            );
          }
        }
        storageFinding(db, cfg, add);
      } finally {
        db.close();
      }
    } catch (err) {
      add('database', 'fail', `Cannot read ${dbPath}: ${(err as Error).message}`);
    } finally { rmSync(snapshot, { recursive: true, force: true }); }
  } else add('database', 'info', `No database at ${dbPath} yet; the server creates it at its first start`);

  const backups = listBackups(cfg.backupsDir);
  const newest = backups.at(-1);
  if (!existsSync(dbPath)) {
    // Nothing to back up yet.
  } else if (!newest) add('backups', 'warn', 'No backup yet', managed ? 'Run `botons backup`; check the nightly timer with `systemctl --user status botons-backup.timer`.' : container ? 'docker compose exec botons botons backup, and schedule it (docs/DOCKER.md)' : 'npm run backup, and npm run backup:install for the nightly timer');
  else {
    const age = now - backupTime(newest);
    if (age > BACKUP_STALE_MS) add('backups', 'warn', `The newest backup (${newest}) is ${Math.floor(age / 86_400_000)} days old`, 'Check the backup timer or cron job.');
    else add('backups', 'ok', `Newest backup ${newest} (${backups.length} kept)`);
  }

  // The running server.
  const health = await (o.health ?? defaultHealth)(cfg.port);
  const holder = serverPid(home);
  if (!health) add('server', 'info', `Nothing answers on 127.0.0.1:${cfg.port} ${where}: the server is not running here${holder ? ` (yet ${join(home, 'server.pid')} names live pid ${holder})` : ''}`);
  else if (!holder && !container) add('server', 'warn', `A Botons server answers on port ${cfg.port}, but none is using ${home}: another install (or data folder) is on that port`, 'Check BOTONS_HOME and BOTONS_PORT.');
  else if (health.status === 200) add('server', 'ok', `Running and healthy${health.body?.build ? ` (build ${String(health.body.build).slice(0, 12)})` : ''}`);
  else {
    const failing = Array.isArray(health.body?.failing) ? health.body.failing.join(', ') : `HTTP ${health.status}`;
    add('server', 'warn', `Running but unhealthy: ${failing}`, failing.includes('providers') ? 'Sign in to a CLI (see "agent CLIs" below).' : undefined);
  }

  // The agent CLIs, as the server runs them.
  if (!o.skipClis) {
    const signIn = container ? (c: string) => `docker compose exec -it botons ${c}` : (c: string) => c;
    const results = await Promise.all([
      checkCli(cfg.claudeBin, ['auth', 'status'], parseClaudeLogin).then((c) => ({ name: 'claude', login: 'claude auth login', c })),
      checkCodexCli(cfg.codexBin).then((c) => ({ name: 'codex', login: 'codex login', c })),
    ]);
    const moveThem = (n: number) => `or move ${n === 1 ? 'that Boton' : 'those Botons'} to another brain in ${n === 1 ? 'its' : 'their'} settings`;
    for (const { name, login, c } of results) {
      const updateFix = `Update ${name === 'claude' ? 'Claude Code' : 'Codex'} in Settings → Brains.`;
      const release = readReleaseChecks(cfg.home)[`${name}-cli` as 'claude-cli' | 'codex-cli'];
      if (release && newerRelease(c.version, release.latest)) add('CLI updates', 'warn', `${name}: update available (${release.latest})${release.failed ? '; latest check failed, showing saved release' : ''} — ${updateFix}`, updateFix);
      if (c.workspaceProblem) workspaceUnavailable.push('Codex');
      else if (name === 'codex' && c.installed && c.problem !== 'incompatible-version') add('Codex Workspace', 'ok', 'Offline filesystem helper probe passed (no login or model request).');
      const id = `${name}-cli` as 'claude-cli' | 'codex-cli';
      const bin = name === 'claude' ? cfg.claudeBin : cfg.codexBin;
      const managed = isManagedBin(bin, id, managedRoot(env.HOME || homedir()));
      const copy = { managed, terminal: managed && c.installed ? await terminalVersion(id, bin) : null };
      const version = cliVersion(c.version) ?? c.version;
      const label = `${name}${version ? ` ${version}` : ''} (${managed ? "Botons' own copy" : 'system copy'})`;
      const note = terminalNote(id, c.version, copy);
      if (note) add('CLI copies', 'info', note);
      const on = botonsOn.get(`${name}-cli`) ?? [];
      const uses = on.length ? `${botonList(on)} ${on.length === 1 ? 'uses' : 'use'} it` : '';
      if (!c.installed) {
        if (!on.length) add('agent CLIs', 'info', `${name}: not installed (${c.reason})`);
        else add('agent CLIs', 'fail', `${name}: not installed (${c.reason}); ${uses} and can't answer`, `Install it where the server finds it (its PATH, or BOTONS_${name.toUpperCase()}_BIN), ${moveThem(on.length)}.`);
      } else if (c.problem === 'incompatible-version') {
        add('agent CLIs', on.length ? 'fail' : 'warn', `${label}: needs update${on.length ? `; ${uses} and can't answer` : ''}`, `${c.reason} ${updateFix}`);
      } else if (c.loggedIn === false) {
        add('agent CLIs', on.length ? 'fail' : 'warn', `${label}: not signed in${on.length ? `; ${uses} and can't answer until it is` : ''}`, `${signIn(login)} (the owner signs in; it creates a credential)${on.length ? `, ${moveThem(on.length)}` : ''}`);
      } else if (c.loggedIn === null) add('agent CLIs', on.length ? 'fail' : 'warn', `${label}: ${c.reason}${on.length ? ` (${uses})` : ''}`);
      else add('agent CLIs', 'ok', `${label}: signed in${on.length ? `; ${uses}` : ''}`);
    }
    if (!results.some((r) => cliStatus(r.c).available)) {
      add('agent CLIs', [...botonsOn.keys()].some(id => id === 'claude-cli' || id === 'codex-cli') ? 'fail' : 'info', 'No agent CLI can run turns, so no Boton can answer', 'Install claude or codex and sign in to it, as the user the server runs as.');
    }
  }

  const botonsRelease = readReleaseChecks(cfg.home).botons;
  if (botonsRelease && newerRelease(botonsReleaseVersion(o.app ?? repo), botonsRelease.latest)) add('Botons updates', 'info', `Botons ${botonsRelease.latest} is available`, 'For installer installs run botons upgrade with the release source. Botons never upgrades itself automatically.');
  for (const kind of ['codex', 'claude'] as const) {
    if (cliHome(kind, env).pending) add(`${kind} sign-in`, 'warn', 'Botons is using your personal sign-in to keep your Botons working.', 'Open Settings → Brains to give Botons its own sign-in. Your Botons keep working until you choose.');
  }
  const linkedConfig = codexConfigSymlinks({ ...env, ...cliHomesEnv(env) }, env.HOME || homedir());
  if (linkedConfig.length) add('Codex config', 'warn',
    `Symlinked protected config paths: ${linkedConfig.join(', ')}. Workspace Codex can fail loading AGENTS.md with "Can't mount on symlink destination".`,
    'Keep Workspace sandboxing enabled. The owner can replace the named config links with regular files or directories containing reviewed copies, then retry. Run `botons doctor --fix` in an interactive terminal to review and confirm a regular-file copy, or sign in separately for Botons in Settings → Brains. Directory links need review on the server. Upgrading Codex alone may not fix this; check the server user’s CODEX_HOME, including AGENTS.md and skills.');

  // The Claude sandbox that Workspace-access Botons run commands in (Linux: bubblewrap and socat).
  if (process.platform === 'linux') {
    const path = env.PATH ?? '';
    const missing = ['bwrap', 'socat'].filter((c) => !onPath(c, path));
    if (missing.length) workspaceUnavailable.push('Claude');
    else {
      const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--unshare-pid', 'true'], { encoding: 'utf8', timeout: 5000, env: { PATH: path } });
      if (r.status === 0) add('sandbox', 'info', 'Claude namespace probe passed; the production Workspace tools and Codex helpers are checked separately.');
      else {
        workspaceUnavailable.push('Claude');
      }
    }
  }

  if (process.platform === 'linux') {
    const bin = onPath('bwrap', env.PATH ?? '');
    const problem = sandboxProblem(bin ?? '/nonexistent/bwrap', { quiet: true });
    if (problem) workspaceUnavailable.push('API tools');
    else add('Workspace tools', 'ok', 'The production overlay, private /proc and seccomp sandbox probe passed.');
  }

  if (workspaceUnavailable.length) add('Workspace', 'info', `Workspace is unavailable for ${workspaceUnavailable.join(', ')} on this server. Use Full computer access.`);

  // The managed browser: its library, a Chromium, and that Chromium starting the way the server starts it (in a temp
  // profile, removed after). Optional, so a warning at worst: Botons without the browser connector don't need it.
  {
    const docker = 'see "Browser" in docs/DOCKER.md';
    if (!existsSync(join(app, 'node_modules', 'playwright-core', 'package.json'))) {
      add('browser', 'warn', 'playwright-core is not installed: Botons get no browser', managed ? 'Run `botons repair`.' : 'Run `npm ci` in the app folder.');
    } else {
      const exe = findChromium(cfg.browser.path, env);
      if (!exe) {
        add(
          'browser',
          'warn',
          cfg.browser.path ? `BOTONS_BROWSER_PATH is ${cfg.browser.path}, which is not there` : 'No Chromium found: Botons get no browser',
          container ? 'The image installs one; rebuild it.' : 'Install the chromium package (needs the owner), or `npx playwright-core install chromium`, or set BOTONS_BROWSER_PATH.',
        );
      } else {
        // Before Chromium's start, which holds this process: its timers would fire late and miss an answer.
        const seen = await (o.egress ?? probeEgress)();
        const net = seen ? egressFinding(seen) : null;
        const r = startChromium(exe, cfg.browser.sandbox);
        if (r.ok) add('browser', 'ok', `${exe} starts${cfg.browser.sandbox ? ', with its sandbox' : ' without its sandbox (BOTONS_BROWSER_SANDBOX=0)'}`);
        else {
          const sandbox = cfg.browser.sandbox && /sandbox|namespace|clone|setuid/i.test(r.why);
          add(
            'browser',
            'warn',
            `${exe} did not start (${r.why}): Botons get no browser`,
            sandbox ? (container ? `Chromium's sandbox can't start in this container: ${docker}.` : "Chromium's sandbox needs unprivileged user namespaces (needs the owner).") : container ? `Rebuild the image, or ${docker}.` : 'Check that Chromium runs for this user.',
          );
        }
        if (net) add('browser', net.status, net.message, net.fix);
      }
    }
  }

  // The systemd service, outside containers.
  if (!container && process.platform === 'linux') {
    const unitDir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
    // botons.service, or the deprecated unit an install runs under until `npm run migrate:names` (legacy-upgrade.ts).
    const unit = defaultUnitName(unitDir);
    if (!existsSync(join(unitDir, `${unit}.service`))) add('service', 'info', 'No botons.service user unit (fine if you run it another way)');
    else {
      let state = 'unknown';
      try {
        state = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch (err) {
        state = String((err as { stdout?: string }).stdout ?? '').trim() || 'unknown';
      }
      add('service', state === 'active' ? 'ok' : 'warn', `${unit}.service is ${state}`, state === 'active' ? undefined : `journalctl --user -u ${unit} -n 50`);
    }
  }
  return out;
}

/**
 * One line on what the Botons' files take: workspaces (their inboxes too), the trash and the shared folder. A warning
 * past INBOX_WARN_BYTES in one inbox or FILES_WARN_BYTES in all, pointing at Clear inbox and the trash in Files.
 */
function storageFinding(db: DatabaseSync, cfg: Config, add: (check: string, status: Status, message: string, fix?: string) => void) {
  let bots: { name: string; workspace: string }[];
  try {
    bots = db.prepare('select name, workspace from bots order by created_at, rowid').all() as typeof bots;
  } catch {
    return;
  }
  let workspaces = 0;
  let inboxes = 0;
  let partial = false;
  const bigInboxes: string[] = [];
  for (const b of bots) {
    const ws = resolve(cfg.workspacesDir, String(b.workspace));
    const w = folderBytesSync(ws);
    const i = folderBytesSync(join(ws, 'inbox'));
    workspaces += w.bytes;
    inboxes += i.bytes;
    partial ||= w.partial || i.partial;
    if (i.bytes > INBOX_WARN_BYTES) bigInboxes.push(`${String(b.name)} ${formatSize(i.bytes)}`);
  }
  const trash = folderBytesSync(join(cfg.home, 'trash'));
  const shared = folderBytesSync(cfg.sharedDir);
  const total = workspaces + trash.bytes + shared.bytes;
  const at = partial || trash.partial || shared.partial ? 'at least ' : '';
  const line = `Files take ${at}${formatSize(total)}: workspaces ${formatSize(workspaces)} (inboxes ${formatSize(inboxes)}), trash ${formatSize(trash.bytes)}, shared ${formatSize(shared.bytes)}`;
  if (bigInboxes.length || total > FILES_WARN_BYTES) {
    add('storage', 'warn', `${line}${bigInboxes.length ? `; big inbox: ${bigInboxes.join(', ')}` : ''}`, 'In a Boton\'s Files: Clear inbox moves its inbox to the trash (kept files stay), and Trash → Empty trash frees the space.');
  } else add('storage', 'info', line);
}

/** The Chromium the server would run: BOTONS_BROWSER_PATH, else one Playwright downloaded, else the system's (browser.ts). */
export function findChromium(path: string, env: NodeJS.ProcessEnv): string | null {
  if (path) return existsSync(path) ? path : null;
  const cache = env.PLAYWRIGHT_BROWSERS_PATH || join(env.HOME || homedir(), '.cache', 'ms-playwright');
  let bundled: string[] = [];
  try {
    bundled = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()
      .flatMap((d) => ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'].map((f) => join(cache, d, f)));
  } catch {}
  const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return [...bundled, ...system].find((p) => existsSync(p)) ?? null;
}

/** Starts it headless on a blank page in a temp profile and checks it rendered, then removes the profile. */
function startChromium(exe: string, sandbox: boolean): { ok: true } | { ok: false; why: string } {
  const profile = mkdtempSync(join(tmpdir(), 'botons-doctor-browser-'));
  try {
    const args = ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-extensions', '--disable-background-networking', `--user-data-dir=${profile}`, ...(sandbox ? [] : ['--no-sandbox']), '--dump-dom', 'data:text/html,<p>botons-browser-ok</p>'];
    // Its home is the temp folder too, so nothing (a key store, a crash report) lands in this user's own.
    const env = { PATH: process.env.PATH ?? '', HOME: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile, XDG_DATA_HOME: profile };
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 30_000, env });
    if (r.stdout?.includes('botons-browser-ok')) return { ok: true };
    const lines = `${r.stderr ?? ''}\n${r.error?.message ?? ''}`.split('\n').map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean);
    const why = lines.find((l) => /sandbox|namespace|error|cannot|fail/i.test(l)) ?? lines[0] ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
    return { ok: false, why: why.slice(0, 200) };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/** The pid in <home>/server.pid if that process is alive (the lock's holder; see server/src/lock.ts). */
const listOf = (v: unknown): string[] => {
  try {
    const x = JSON.parse(String(v));
    return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Botons whose connectors can't be used: from 23 on, ones an upgrade took off (connectors from a CLI's own
 * settings, which Botons no longer uses), ones the last turn went without, and grants of connectors that are gone
 * or need signing in again; at 22, the ones the upgrade to 23 will take off.
 */
export function connectorFindings(db: DatabaseSync, version: number, add: (check: string, status: Status, message: string, fix?: string) => void): void {
  const rows = (sql: string) => {
    try {
      return db.prepare(sql).all();
    } catch {
      return [];
    }
  };
  const bots = rows('select id, name, connections from bots order by created_at, rowid');
  const where = 'Open the Boton\'s settings: Connectors lists each with what to do (give it a Botons connector, sign in again, or uncheck it).';
  if (version === 22) {
    const losing = bots.map((b) => ({ name: String(b.name), ids: listOf(b.connections).filter((id) => /^(claude|codex):/.test(id)) })).filter((b) => b.ids.length);
    for (const b of losing) add('connectors', 'info', `The upgrade takes ${b.name}'s connectors from the CLIs' own settings off it: ${b.ids.join(', ')}`, 'Each becomes a notice in its settings, offering a Botons connector with the same name or address if there is one.');
    return;
  }
  // Every version since 23 has Botons' own connectors and their notices.
  if (version < 23 || version > SCHEMA_VERSION) return;
  const library = new Set([BROWSER_CONNECTOR, ...rows('select name from mcp_servers').map((r) => `lib:${r.name}`)]);
  const oauth = new Map(rows('select name, status from oauth_connections').map((r) => [`oauth:${r.name}`, String(r.status)]));
  const notices = rows('select bot_id, connector_id, kind, reason from connector_notices order by at');
  let problems = 0;
  for (const b of bots) {
    const removed = notices.filter((n) => n.bot_id === b.id && n.kind === 'removed').map((n) => String(n.connector_id));
    const skipped = new Map(notices.filter((n) => n.bot_id === b.id && n.kind === 'skipped').map((n) => [String(n.connector_id), String(n.reason)]));
    const unusable = listOf(b.connections).flatMap((id) => {
      const why = library.has(id) ? null : oauth.has(id) ? (oauth.get(id) === 'connected' ? null : 'needs signing in') : 'not a Botons connector any more';
      return why ? [`${id} (${why})`] : skipped.has(id) ? [`${id} (its last turn went without it: ${skipped.get(id)})`] : [];
    });
    if (removed.length) add('connectors', 'warn', `${b.name} lost connectors from the CLIs' own settings in the upgrade: ${removed.join(', ')}`, where);
    if (unusable.length) add('connectors', 'warn', `${b.name} has connectors it can't use: ${unusable.join(', ')}`, where);
    problems += removed.length + unusable.length;
  }
  if (!problems && bots.some((b) => listOf(b.connections).length)) add('connectors', 'ok', "Every Boton's connectors can be used");
}

function serverPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(join(home, 'server.pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/** "Juniper", "Juniper and Rowan", "3 Botons (Juniper, Rowan and Wren)", "5 Botons (Juniper, Rowan, Wren and 2 more)". */
function botonList(names: string[]): string {
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  return names.length > 2 ? `${names.length} Botons (${list})` : list;
}

const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function orZero(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

/** Setup tasks do not make a healthy fresh install fail. */
export function isProblem(f: Finding): boolean { return f.status === 'fail'; }
export function report(findings: Finding[], verbose = false): string {
  const groups: Record<string, string> = { access: 'Access', devices: 'Access', exposure: 'Access', tailscale: 'Access', 'agent CLIs': 'Brains', 'CLI updates': 'Brains', 'Codex config': 'Brains', sandbox: 'Sandbox', browser: 'Sandbox', backups: 'Backups' };
  const lines: string[] = [];
  const color = process.stdout.isTTY && !('NO_COLOR' in process.env) && !process.env.CI;
  for (const section of ['Server', 'Access', 'Brains', 'Sandbox', 'Backups']) {
    const items = findings.filter(f => (groups[f.check] || 'Server') === section);
    if (!items.length) continue;
    lines.push(section);
    for (const f of items) {
      const problem = isProblem(f);
      const mark = problem ? '✗' : f.status === 'ok' ? '✓' : '•';
      const message = f.check === 'Codex config' ? 'Review Codex config links in Settings → Brains' : f.message.split(/\r?\n/)[0].split('. Workspace Codex')[0];
      lines.push(`  ${color ? `\x1b[${problem ? 31 : f.status === 'ok' ? 32 : 36}m${mark}\x1b[0m` : mark} ${f.check}: ${message}`);
      if (verbose) lines.push(`    ${f.message}${f.fix ? `\n    → ${f.fix}` : ''}`);
    }
  }
  const problems = findings.filter(isProblem).length;
  const steps = findings.filter(f => f.status !== 'ok' && !isProblem(f)).length;
  lines.push(`${problems} problem${problems === 1 ? '' : 's'}, ${steps} next step${steps === 1 ? '' : 's'}.${verbose ? '' : ' Details: doctor --verbose.'}`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { verbose: { type: 'boolean' }, json: { type: 'boolean' }, 'env-path': { type: 'string' }, 'skip-clis': { type: 'boolean' }, 'skip-network': { type: 'boolean' }, fix: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(`Usage: npm run doctor [-- --json] [-- --env-path <file>] [-- --skip-clis] [-- --skip-network] [-- --fix]

Checks Node, the install, the settings, exposure, the data folder and database,
routine runs to check, usage limits, backups, the running server, the agent CLIs
(and the Botons each one leaves without answers), the sandbox and the service,
and says what to fix. Read-only unless --fix is given. --skip-network leaves out
the browser's quick IPv4 and IPv6 check against example.com.
--fix previews Codex config link repairs and asks for each confirmation on a terminal. Uses BOTONS_HOME if set, else the service's env
file (--env-path, default ~/.config/botons/env), else the defaults.`);
    return 0;
  }
  const { env, from } = serverEnv(values['env-path']);
  // The CLIs' checks run with the agents' environment, which takes PATH from this process.
  if (from && env.PATH) process.env.PATH = env.PATH;
  if (values.fix) {
    if (values.json || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--fix requires an interactive terminal and cannot be combined with --json. Run doctor without --fix for read-only checks.');
    const repairs = previewCodexRepairs(env);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const repair of repairs) {
        if (!repair.token) { console.log(`${repair.path}: ${repair.problem}`); continue; }
        console.log(`Replace symlink ${JSON.stringify(repair.path)} with a regular copy of ${JSON.stringify(repair.target)}.
Keep the original symlink at ${JSON.stringify(repair.backup)}. The target stays unchanged. Relative backup links may not resolve until restored to the original path. The copy is private to the server user and stops following target changes. This repair is audited.`);
        if ((await terminal.question('Type REPAIR to confirm this exact copy (anything else cancels): ')) !== 'REPAIR') { console.log('Cancelled; no files changed.'); continue; }
        const cfg = loadConfig(env);
        if (!existsSync(cfg.dbPath)) throw new Error('Start Botons once before repairing: the repair requires its audit database.');
        const db = new DatabaseSync(cfg.dbPath);
        try {
          const result = repairCodexConfig(repair.id, repair.token, (phase, item) => recordAudit(db, HOST_ACTOR, {
            action: `brain.config_repair_${phase}`, details: { path: item.path, target: item.target, backup: item.backup },
          }, { required: true }), env);
          console.log(`Repaired ${repair.path}; backup: ${repair.backup}`);
          if (result.warning) console.warn(result.warning);
        } finally { db.close(); }
      }
    } finally { terminal.close(); }
  }
  const findings = await diagnose({ env, envFile: from, skipClis: values['skip-clis'], egress: values['skip-network'] ? async () => null : undefined });
  console.log(values.json ? JSON.stringify({ home: (() => { try { return botonsHome(env); } catch { return null; } })(), findings }, null, 2) : report(findings, values.verbose));
  return findings.some(isProblem) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`doctor: could not run: ${(err as Error).message}`);
      process.exitCode = 2;
    },
  );
}
