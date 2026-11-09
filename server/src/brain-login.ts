import { cliHomesEnv, prepareCliHomes } from './cli-homes.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { agentEnv } from './providers/process.ts';
import { HttpError } from './store.ts';

export interface BrainLoginState { state: 'idle' | 'waiting' | 'finished' | 'cancelled' | 'timed-out' | 'fallback'; url: string | null; code: string | null }
/** Only the fixed device verification address and code leave this class. Raw CLI output is never logged. */
export class BrainLogin {
  #child: ChildProcess | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #view: BrainLoginState = { state: 'idle', url: null, code: null };
  view(): BrainLoginState { return { ...this.#view }; }
  private bin: string;
  private readonly timeoutMs: number;
  private readonly schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  constructor(bin = 'codex', timeoutMs = 10 * 60_000, schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout) { this.bin = bin; this.timeoutMs = timeoutMs; this.schedule = schedule; }
  setBin(bin: string): void {
    if (this.#child) throw new HttpError(409, 'Cancel sign-in before updating.');
    this.bin = bin;
  }
  start(): BrainLoginState {
    if (this.#child) throw new HttpError(409, 'A sign-in is already running. Cancel it first.');
    this.#view = { state: 'waiting', url: null, code: null };
    prepareCliHomes();
    const child = spawn(this.bin, ['login', '--device-auth'], { env: { ...agentEnv({ NO_COLOR: '1' }), ...cliHomesEnv(process.env, true) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.#child = child;
    let pending = '';
    const read = (chunk: Buffer) => {
      if (this.#child !== child || this.#view.state !== 'waiting') return;
      // Bounded transient parsing buffer, discarded after each line; never returned in errors.
      pending = (pending + chunk.toString()).replace(/\x1b\[[0-9;]*m/g, '').slice(-2048);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (/https:\/\/auth\.openai\.com\/codex\/device(?:\s|$)/.test(line)) this.#view.url = 'https://auth.openai.com/codex/device';
        const code = line.trim().match(/^([A-Z0-9]{4}-[A-Z0-9]{5}|[A-Z0-9]{4}-[A-Z0-9]{4})$/);
        if (code) this.#view.code = code[1];
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.once('error', () => finish('fallback'));
    child.once('close', (code) => finish(code === 0 ? 'finished' : 'fallback'));
    const finish = (state: BrainLoginState['state']) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#killGroup(child);
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      child.stdout?.removeListener('data', read);
      child.stderr?.removeListener('data', read);
      pending = '';
      this.#view = { state, url: null, code: null };
    };
    this.#timer = this.schedule(() => { this.cancel(); this.#view.state = 'timed-out'; }, this.timeoutMs);
    this.#timer.unref();
    return this.view();
  }
  #killGroup(child: ChildProcess): void {
    // A configured launcher may spawn the actual CLI. Neither may finish login after cancellation.
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group may already have exited. */ }
  }
  cancel(): BrainLoginState {
    const child = this.#child;
    this.#child = null;
    child?.stdout?.removeAllListeners('data');
    child?.stderr?.removeAllListeners('data');
    if (child) this.#killGroup(child);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#view = { state: 'cancelled', url: null, code: null };
    return this.view();
  }
}
