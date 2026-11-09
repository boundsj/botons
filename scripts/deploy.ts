// `npm run deploy [-- <ref>]`, `-- --rollback [<sha>]`, `-- --list`. Flags: --no-restart --skip-tests
// --root <dir> --unit <name> --port <n> --env-path <file> --repo <dir> --keep <n>.
// Layout: <root>/releases/<sha> (with .deploy-ok once checked), <root>/current and <root>/previous links.
import '../server/src/env-init.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { serviceManager, runService } from '../shared/service-manager.mjs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { applyLegacyEnv, SHARE_DIRS } from '../shared/legacy-names.mjs';
import { isBotonsSetting } from '../server/src/config.ts';
import { findLegacyService, upgradeService } from '../server/src/legacy-upgrade.ts';
import { defaultEnvPath, defaultUnitName, readEnvFile } from './install-service.ts';

const MARKER = '.deploy-ok';
const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'none');

export interface DeployOptions {
  repo: string;
  platform?: string;
  userHome?: string;
  serviceExec?: (cmd: string, args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;
  root: string;
  unit: string;
  port: number;
  keep: number;
  restart: boolean;
  skipTests: boolean;
  healthTimeoutMs: number;
  /** After the server first answers, how long it must stay up. */
  settleMs: number;
  exec: (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<void>;
  log: (line: string) => void;
  /**
   * The service still runs under a deprecated unit (server/src/legacy-upgrade.ts): instead of restarting it, the
   * new release starts as botons.service, which this sets up; `undo` goes back to the earlier unit.
   */
  upgradeNames?: () => Promise<{ undo: () => Promise<void> }>;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code, signal) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`))));
  });
}

function resolveSha(repo: string, ref: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new Error(`Unknown ref "${ref}" in ${repo}: ${err.trim()}`))));
  });
}

/** `git archive <sha> | tar -x -C <dir>`. */
function extract(repo: string, sha: string, dir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const git = spawn('git', ['-C', repo, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'inherit'] });
    const tar = spawn('tar', ['-x', '-C', dir], { stdio: ['pipe', 'inherit', 'inherit'] });
    git.stdout.pipe(tar.stdin);
    let pending = 2;
    let failed = false;
    const done = (what: string) => (code: number | null) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`${what} failed (exit ${code})`));
      }
      if (--pending === 0 && !failed) resolvePromise();
    };
    git.on('error', reject).on('close', done('git archive'));
    tar.on('error', reject).on('close', done('tar'));
  });
}

export function linked(root: string, name: 'current' | 'previous'): string | null {
  try {
    return basename(readlinkSync(join(root, name)));
  } catch {
    return null;
  }
}

/** Point `name` at releases/<sha> (or remove it), replacing the link atomically. */
function pointAt(root: string, name: 'current' | 'previous', sha: string | null): void {
  const link = join(root, name);
  if (!sha) {
    rmSync(link, { force: true });
    return;
  }
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(join('releases', sha), tmp);
  renameSync(tmp, link);
}

export function listReleases(root: string) {
  const dir = join(root, 'releases');
  if (!existsSync(dir)) return [];
  const current = linked(root, 'current');
  const previous = linked(root, 'previous');
  return readdirSync(dir)
    .filter((sha) => existsSync(join(dir, sha, MARKER)))
    .map((sha) => ({ sha, dir: join(dir, sha), builtAt: statSync(join(dir, sha, MARKER)).mtime, current: sha === current, previous: sha === previous }))
    .sort((a, b) => b.builtAt.getTime() - a.builtAt.getTime());
}

export function prune(root: string, keep: number): string[] {
  const dir = join(root, 'releases');
  if (!existsSync(dir)) return [];
  const keepSet = new Set([linked(root, 'current'), linked(root, 'previous'), ...listReleases(root).slice(0, keep).map((r) => r.sha)]);
  const removed: string[] = [];
  for (const sha of readdirSync(dir)) {
    if (keepSet.has(sha) || sha.startsWith('.')) continue;
    rmSync(join(dir, sha), { recursive: true, force: true });
    removed.push(sha);
  }
  return removed;
}

/** One deploy at a time per root: an fcntl lock (as in server/src/lock.ts), released however the process exits. */
function lockRoot(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, 'deploy.lock'), { timeout: 0 });
  try {
    db.exec('pragma journal_mode = memory; begin exclusive');
  } catch {
    db.close();
    throw new Error(`Another deploy is running in ${root}.`);
  }
  return () => db.close();
}

async function buildRelease(sha: string, ref: string, o: DeployOptions): Promise<string> {
  const dir = join(o.root, 'releases', sha);
  if (existsSync(join(dir, MARKER))) {
    o.log(`releases/${short(sha)} is already built and checked`);
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  o.log(`Building ${ref} (${short(sha)}) in ${dir}`);
  await extract(o.repo, sha, dir);
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify({ sha, ref, repo: o.repo, builtAt: new Date().toISOString() }, null, 2)}\n`);
  const npmNext = join(dirname(process.execPath), 'npm');
  const npm = existsSync(npmNext) ? npmNext : 'npm';
  // This Node first on PATH, and none of the server's settings (the tests make their own).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isBotonsSetting(k) && k !== 'PORT' && k !== 'NODE_ENV' && k !== 'INIT_CWD') env[k] = v;
  }
  env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`;
  const steps = [['ci', '--prefer-offline', '--no-audit', '--no-fund'], ['run', 'typecheck'], ...(o.skipTests ? [] : [['run', 'test:full']]), ['run', 'build']];
  for (const args of steps) {
    o.log(`$ npm ${args.join(' ')}`);
    await o.exec(npm, args, { cwd: dir, env });
  }
  writeFileSync(join(dir, MARKER), `${new Date().toISOString()}\n`);
  return dir;
}

/**
 * Poll /api/health until it reports `sha` as its build and stays up for settleMs.
 * Failing only on `providers` (say, every CLI signed out) counts as up: the previous release would fail the same way.
 */
export async function waitHealthy(o: DeployOptions, sha: string): Promise<string | null> {
  const url = `http://127.0.0.1:${o.port}/api/health`;
  let warned = false;
  const check = async (): Promise<string | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { ok?: boolean; build?: string | null; failing?: string[] };
      if (body.build !== undefined && body.build !== sha) return `${url} reports build ${short(body.build ?? null)}, not ${short(sha)}`;
      if (res.ok && body.ok) return null;
      const failing = Array.isArray(body.failing) ? body.failing : [];
      if (res.status === 503 && failing.length && failing.every((f) => f === 'providers')) {
        if (!warned) o.log('Warning: the server is up, but no agent CLI can run turns (signed out?). Open Settings in the app, or see GET /api/providers.');
        warned = true;
        return null;
      }
      return `${url} answered ${res.status}${failing.length ? ` (failing: ${failing.join(', ')})` : ''}`;
    } catch (err) {
      return `${url}: ${(err as Error).message}`;
    }
  };
  const end = Date.now() + o.healthTimeoutMs;
  let last: string | null = 'no answer';
  while (Date.now() < end) {
    last = await check();
    if (!last) {
      await new Promise((r) => setTimeout(r, o.settleMs));
      last = await check();
      if (!last) return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/** Make `sha` current, restart the service and check it; if it is not healthy, put the links back, restart the old release and resolve false. */
async function activate(sha: string, o: DeployOptions): Promise<boolean> {
  const before = { current: linked(o.root, 'current'), previous: linked(o.root, 'previous') };
  if (before.current !== sha) {
    pointAt(o.root, 'previous', before.current);
    pointAt(o.root, 'current', sha);
  }
  o.log(`current -> releases/${short(sha)}${before.current && before.current !== sha ? ` (previous: ${short(before.current)})` : ''}`);
  if (!o.restart) return true;

  const restartAndCheck = async (target: string): Promise<string | null> => {
    o.log(`Restarting ${o.unit}; running turns get up to BOTONS_DRAIN_MS to finish first`);
    try {
      if ((o.platform ?? process.platform) === 'darwin') {
        runService('restart', { platform: 'darwin', home: o.userHome ?? homedir(), name: o.unit }, 'server', o.serviceExec ?? ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })));
      } else {
        // A release that crash-looped can leave the unit failed at its start limit, which refuses a restart.
        await o.exec('systemctl', ['--user', 'reset-failed', o.unit]).catch(() => {});
        await o.exec('systemctl', ['--user', 'restart', o.unit]);
      }
    } catch (err) {
      return (err as Error).message;
    }
    return waitHealthy(o, target);
  };
  // The first start of this release, as botons.service when the service still has a deprecated name.
  const first = async (): Promise<string | null> => {
    if (!o.upgradeNames) return restartAndCheck(sha);
    const earlier = o.unit;
    let undo: () => Promise<void>;
    try {
      undo = (await o.upgradeNames()).undo;
    } catch (err) {
      // It has put the earlier unit back (running this release) already.
      return `the move to botons.service failed: ${(err as Error).message}`;
    }
    o.unit = 'botons';
    const problem = await waitHealthy(o, sha);
    if (problem) {
      o.log(`botons did not come up healthy on ${short(sha)}: ${problem}; going back to ${earlier}`);
      await o.exec('journalctl', ['--user', '-u', 'botons', '-n', '30', '--no-pager']).catch(() => {});
      await undo().catch((err) => o.log(`Could not start ${earlier} again: ${(err as Error).message}`));
      o.unit = earlier;
    }
    return problem;
  };
  const problem = await first();
  if (!problem) {
    o.log(`${o.unit} is up on ${short(sha)}`);
    return true;
  }
  o.log(`${o.unit} did not come up healthy on ${short(sha)}: ${problem}`);
  if ((o.platform ?? process.platform) === 'darwin') o.log(`Check launchctl print ${serviceManager({ platform: 'darwin', home: o.userHome ?? homedir(), name: o.unit }).target} and the logs beside the service env file.`);
  else await o.exec('journalctl', ['--user', '-u', o.unit, '-n', '30', '--no-pager']).catch(() => {});
  pointAt(o.root, 'current', before.current);
  pointAt(o.root, 'previous', before.previous);
  if (!before.current || before.current === sha) {
    o.log('There is no other release to go back to.');
    return false;
  }
  o.log(`Rolling back to ${short(before.current)}`);
  const again = await restartAndCheck(before.current);
  o.log(again ? `${short(before.current)} did not come up either: ${again}. Check the service logs` : `Back on ${short(before.current)}`);
  return false;
}

/** Build `ref`, switch to it and restart. Resolves false if it was rolled back. */
export async function deploy(ref: string, o: DeployOptions): Promise<boolean> {
  const unlock = lockRoot(o.root);
  try {
    const sha = await resolveSha(o.repo, ref);
    if (linked(o.root, 'current') === sha && existsSync(join(o.root, 'releases', sha, MARKER))) {
      o.log(`${short(sha)} is already the current release; nothing to do.`);
      return true;
    }
    await buildRelease(sha, ref, o);
    const ok = await activate(sha, o);
    const removed = prune(o.root, o.keep);
    if (removed.length) o.log(`Removed old releases: ${removed.map(short).join(', ')}`);
    return ok;
  } finally {
    unlock();
  }
}

export async function rollback(want: string | null, o: DeployOptions): Promise<boolean> {
  const unlock = lockRoot(o.root);
  try {
    const releases = listReleases(o.root);
    const target = want ? releases.filter((r) => r.sha.startsWith(want)) : releases.filter((r) => r.previous);
    if (target.length !== 1) {
      throw new Error(
        want
          ? `${target.length ? 'More than one' : 'No'} finished release matches "${want}". Releases: ${releases.map((r) => short(r.sha)).join(', ') || 'none'}`
          : 'There is no previous release to go back to.',
      );
    }
    if (target[0].current) {
      o.log(`${short(target[0].sha)} is already the current release.`);
      return true;
    }
    return await activate(target[0].sha, o);
  } finally {
    unlock();
  }
}

function arg(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : null;
}

const VALUE_FLAGS = new Set(['--root', '--unit', '--port', '--env-path', '--repo', '--keep']);

function positionals(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) i++;
    else if (!argv[i].startsWith('--')) out.push(argv[i]);
  }
  return out;
}

function whole(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number; got "${raw}"`);
  return n;
}

async function main() {
  const share = join(homedir(), '.local', 'share');
  // ~/.local/share/botons, or a deprecated one until this deploy moves it (server/src/legacy-upgrade.ts).
  const shareRoot = existsSync(join(share, 'botons')) ? join(share, 'botons') : (SHARE_DIRS.map((d) => join(share, d)).find((p) => existsSync(p)) ?? join(share, 'botons'));
  const root = resolve(arg('--root') ?? (process.env.BOTONS_DEPLOY_ROOT || shareRoot));
  const envPath = resolve(arg('--env-path') ?? defaultEnvPath());
  let env: Record<string, string> = {};
  try {
    env = readEnvFile(readFileSync(envPath, 'utf8'));
  } catch {}
  applyLegacyEnv(env);
  const envPort = Number(env.BOTONS_PORT || env.PORT || 7777);
  // A checkout or a worktree has .git (a folder or a file); a release folder does not.
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repo = arg('--repo') ? resolve(arg('--repo')!) : existsSync(join(here, '.git')) ? here : null;
  const o: DeployOptions = {
    repo: repo ?? '',
    root,
    unit: arg('--unit') ?? defaultUnitName(),
    port: arg('--port') ? whole('--port', arg('--port')!) : Number.isInteger(envPort) && envPort > 0 ? envPort : 7777,
    keep: arg('--keep') ? whole('--keep', arg('--keep')!) : 5,
    restart: !process.argv.includes('--no-restart'),
    skipTests: process.argv.includes('--skip-tests'),
    healthTimeoutMs: 30_000,
    settleMs: 5000,
    exec: run,
    log: (line) => console.log(`[deploy] ${line}`),
  };
  if (process.argv.includes('--list')) {
    const releases = listReleases(root);
    if (!releases.length) console.log(`No releases in ${root}`);
    for (const r of releases) {
      let ref = '';
      try {
        ref = JSON.parse(readFileSync(join(r.dir, 'release.json'), 'utf8')).ref ?? '';
      } catch {}
      console.log(`${r.current ? '*' : r.previous ? '-' : ' '} ${short(r.sha)}  ${r.builtAt.toISOString()}  ${ref}${r.current ? '  (current)' : r.previous ? '  (previous)' : ''}`);
    }
    return true;
  }
  if (process.argv.includes('--rollback')) return rollback(positionals()[0] ?? null, o);
  if (!repo) throw new Error('This copy of deploy.ts is not in a git checkout; pass --repo <checkout>.');
  if (process.platform === 'linux' && o.restart && !arg('--unit') && findLegacyService()) o.upgradeNames = () => upgradeService({ exec: (cmd, args) => run(cmd, args), log: o.log });
  return deploy(positionals()[0] ?? 'HEAD', o);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (err) => {
      console.error(`[deploy] ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
