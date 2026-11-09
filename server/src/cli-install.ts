import { cliHomesEnv, prepareCliHomes } from './cli-homes.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliInstallPlan } from '../../installer/brain-clis.mjs';
import { managedRoot, pruneManagedReleases, type ManagedProvider } from './managed-clis.ts';
import { agentEnv } from './providers/process.ts';
import { checkCli, checkCodexCli, parseClaudeLogin } from './providers/cli-check.ts';

export interface InstallReview { provider: ManagedProvider; command: string; bin: string; available: boolean; reason: string | null }
interface Plan { review: InstallReview; command: string; args: string[]; at: number; previous: string }
export interface InstallOptions {
  home: string;
  current(provider: ManagedProvider): string;
  activate(provider: ManagedProvider, bin: string): void;
  maintain<T>(run: () => Promise<T>): Promise<T>;
  root?: string;
  node?: string;
  run?: typeof runInstall;
  verify?: (provider: ManagedProvider, bin: string) => Promise<void>;
}
/** Bounded subprocess with no inherited API credentials or raw output in API errors/logs. */
export function runInstall(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    prepareCliHomes();
    const child = spawn(command, args, { env: { ...agentEnv({ PATH: `${dirname(command)}:${process.env.PATH || ''}`, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' }), ...cliHomesEnv(process.env, true) }, stdio: 'ignore', detached: true });
    let timedOut = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 5 * 60_000);
    const abort = () => kill();
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) kill();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(new Error('Could not start the official CLI installer.')); });
    child.once('close', code => { cleanup(); kill(); code === 0 && !signal.aborted && !timedOut ? resolve() : reject(new Error('CLI installation did not finish. The selected brain has not changed.')); });
  });
}
async function verify(provider: ManagedProvider, bin: string): Promise<void> {
  const check = provider === 'codex-cli' ? await checkCodexCli(bin) : await checkCli(bin, ['auth', 'status'], parseClaudeLogin);
  if (!check.installed || check.problem === 'incompatible-version') throw new Error('The installed CLI did not pass its compatibility check. The selected brain has not changed.');
}

/** One reviewed plan per CLI, serialized mutations; immutable release folders preserve active binaries. */
export class CliInstaller {
  #plans = new Map<ManagedProvider, Plan>();
  #active: Promise<void> | null = null;
  #abort = new AbortController();
  #closed = false;
  readonly #opts: InstallOptions;
  constructor(opts: InstallOptions) { this.#opts = opts; }
  busy(): boolean { return this.#active !== null; }
  review(provider: ManagedProvider): InstallReview {
    const opts = this.#opts, root = opts.root ?? managedRoot();
    const previous = opts.current(provider);
    let node = opts.node;
    try { node ??= JSON.parse(readFileSync(join(root, 'installer.json'), 'utf8')).node; } catch {}
    if (!node || !existsSync(node)) return {provider, command:'', bin:'', available:false, reason:'The managed Node runtime is missing. Run the Botons installer repair first.'};
    const cached = this.#plans.get(provider);
    if (cached && cached.previous === previous && Date.now() - cached.at < 15 * 60_000) return cached.review;
    const stage = join(root, 'clis', provider, 'releases', randomUUID());
    const plan = cliInstallPlan(root, node, provider === 'codex-cli' ? 'codex' : 'claude', stage);
    // Each reviewed command installs into a fresh release; active copies stay untouched.
    const review = {provider, command:plan.display, bin:plan.bin, available:true, reason:null};
    this.#plans.set(provider, {review, command:plan.command, args:plan.args, previous, at:Date.now()});
    return review;
  }
  async install(provider: ManagedProvider, command: string, consent: boolean, audit: (phase: 'started' | 'succeeded' | 'failed', review: InstallReview) => void): Promise<void> {
    if (this.#closed || this.#active) throw new Error('A CLI update is already running or the server is stopping.');
    const review = this.review(provider), plan = this.#plans.get(provider);
    if (!consent || !review.available || review.command !== command || !plan) throw new Error('Review the current command and confirm installation first.');
    const operation = this.#opts.maintain(async () => {
      if (this.#closed) throw new Error('Server is stopping.');
      audit('started', review);
      try {
        const root = this.#opts.root ?? managedRoot();
        // Never traverse a substituted symlink into a system installation.
        let path = root;
        for (const segment of ['', 'clis', provider, 'releases']) {
          if (segment) path = join(path, segment);
          if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Managed CLI folder is a symlink. Nothing was installed.');
        }
        mkdirSync(dirname(review.bin), {recursive:true, mode:0o700});
        await (this.#opts.run ?? runInstall)(plan.command, plan.args, this.#abort.signal);
        if (this.#closed) throw new Error('Server is stopping.');
        await (this.#opts.verify ?? verify)(provider, review.bin);
        if (this.#closed) throw new Error('Server is stopping.');
        const marker = join(this.#opts.home, 'managed-clis.json');
        let saved: Record<string, unknown> = {};
        try { saved = JSON.parse(readFileSync(marker, 'utf8')); } catch {}
        const old = saved[provider] as {previous?: string; bin?: string} | undefined;
        saved[provider] = {bin:review.bin, previous:old?.bin === plan.previous ? old.previous ?? plan.previous : plan.previous};
        writeFileSync(marker + '.tmp', JSON.stringify(saved), {mode:0o600});
        renameSync(marker + '.tmp', marker);
        this.#opts.activate(provider, review.bin);
        audit('succeeded', review);
        pruneManagedReleases(root, provider, review.bin);
      } catch (e) { audit('failed', review); throw e; }
    });
    this.#active = operation;
    try { await operation; } finally { this.#active = null; this.#plans.delete(provider); }
  }
  async close(): Promise<void> { this.#closed = true; this.#abort.abort(); await this.#active?.catch(() => {}); }
}
