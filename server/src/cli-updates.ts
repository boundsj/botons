import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_PACKAGES = { 'claude-cli': '@anthropic-ai/claude-code', 'codex-cli': '@openai/codex', botons: 'getbotons' } as const;
export type UpdateId = keyof typeof UPDATE_PACKAGES;
export interface ReleaseCheck { latest: string | null; checkedAt: number; failed: boolean }
export type ReleaseChecks = Partial<Record<UpdateId, ReleaseCheck>>;

export { stableVersion, newerRelease } from '../../shared/versions.ts';
import { stableVersion } from '../../shared/versions.ts';

/** Fixed registry origin; redirects and arbitrary package URLs are never followed. */
export async function fetchLatest(id: UpdateId, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(UPDATE_PACKAGES[id])}/latest`, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
  if (!response.ok || !response.body) throw new Error('Release check unavailable');
  const reader = response.body.getReader();
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 256_000) throw new Error('Release metadata too large');
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
  const version: unknown = JSON.parse(text + decoder.decode()).version;
  if (typeof version !== 'string' || !stableVersion(version)) throw new Error('Invalid stable release');
  return version;
}

/** Doctor only reads this cache; the running server owns periodic refreshes. */
export function readReleaseChecks(home: string): ReleaseChecks {
  try {
    const input = JSON.parse(readFileSync(join(home, 'release-checks.json'), 'utf8'));
    const result: ReleaseChecks = {};
    for (const id of Object.keys(UPDATE_PACKAGES) as UpdateId[]) {
      const c = input[id];
      if (c && Number.isSafeInteger(c.checkedAt) && c.checkedAt > 0 && typeof c.failed === 'boolean' && (c.latest === null || typeof c.latest === 'string' && stableVersion(c.latest))) result[id] = c;
    }
    return result;
  } catch { return {}; }
}

export class ReleaseChecker {
  #checks: ReleaseChecks;
  #pending: Promise<ReleaseChecks> | null = null;
  #closed = false;
  #started = false;
  #abort = new AbortController();
  #cancelTimer: (() => void) | null = null;
  private readonly home: string;
  private readonly latest: typeof fetchLatest;
  private readonly now: () => number;
  constructor(home: string, latest = fetchLatest, now = Date.now) { this.home = home; this.latest = latest; this.now = now; this.#checks = readReleaseChecks(home); }
  view(): ReleaseChecks { return structuredClone(this.#checks); }
  /** Schedule the next poll from completion; a slow lookup cannot skip an entire day. */
  start(schedule: (task: () => void, delay: number) => () => void = (task, delay) => {
    const timer = setTimeout(task, delay); timer.unref(); return () => clearTimeout(timer);
  }): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    const poll = async () => {
      try { await this.refresh(); } catch { /* A disk error must not become an unhandled rejection. */ }
      if (!this.#closed) this.#cancelTimer = schedule(() => { void poll(); }, UPDATE_INTERVAL_MS);
    };
    void poll();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelTimer?.();
    this.#abort.abort();
    await this.#pending?.catch(() => {});
  }
  refresh(): Promise<ReleaseChecks> {
    if (this.#closed) return Promise.resolve(this.view());
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #refresh(): Promise<ReleaseChecks> {
    for (const id of Object.keys(UPDATE_PACKAGES) as UpdateId[]) {
      if (this.#closed) break;
      const now = this.now(), old = this.#checks[id];
      if (old && now >= old.checkedAt && now - old.checkedAt < UPDATE_INTERVAL_MS) continue;
      try {
        const latest = await this.latest(id, this.#abort.signal);
        if (this.#closed) break;
        if (!stableVersion(latest)) throw new Error('Invalid stable release');
        this.#checks[id] = { latest, checkedAt: this.now(), failed: false };
      } catch {
        if (this.#closed) break;
        this.#checks[id] = { latest: old?.latest ?? null, checkedAt: this.now(), failed: true };
      }
      // Persist failures too, so a restart does not hammer an unavailable registry.
      const path = join(this.home, 'release-checks.json');
      writeFileSync(path + '.tmp', JSON.stringify(this.#checks), { mode: 0o600 });
      renameSync(path + '.tmp', path);
    }
    return this.view();
  }
}

/** A checkout without a release version is not compared with published packages. */
export function botonsReleaseVersion(root: string): string | null {
  try {
    const version: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    return typeof version === 'string' && stableVersion(version) ? version : null;
  } catch { return null; }
}
