import { randomUUID } from 'node:crypto';
import { type ModelEfforts, providerEffort } from '../../../shared/effort.ts';
import type { ProviderEffortInfo, ProviderInfo } from '../../../shared/types.ts';
import { nowIso, truncate } from '../util.ts';
import { ClaudeCliProvider } from './claude-cli.ts';
import { CodexCliProvider } from './codex-cli.ts';
import { MockProvider } from './mock.ts';
import { brainReadiness } from './readiness.ts';
import type { Provider } from './types.ts';

/** Rechecks the owner can ask for, per provider, in OWNER_RECHECK_WINDOW_MS; past that they get the last check. */
export const OWNER_RECHECKS = 6;
export const OWNER_RECHECK_WINDOW_MS = 60_000;

export class ProviderRegistry {
  #providers = new Map<string, Provider>();
  /** Replacing a CLI replaces its checker, so its counters need a fresh identity. */
  #incarnations = new Map<string, string>();
  /** How each provider's real turns went, since the server started. */
  #turns = new Map<string, Pick<ProviderInfo, 'lastSuccessAt' | 'lastError'>>();
  /** When the owner's rechecks of each provider started, within the window. */
  #rechecks = new Map<string, number[]>();
  /** Until when each provider's turns are held by a usage limit (the engine's). */
  #usageLimitUntil: (id: string) => string | null = () => null;
  /** This run of the server, for its answers' readiness: checks are counted per run, and runs aren't ordered by clock. */
  readonly boot = randomUUID();

  /** `managed`: which CLIs are Botons' own copies (managed-clis.ts). */
  constructor(opts: { enableMock: boolean; claudeBin?: string; codexBin?: string; managed?: { claude?: boolean; codex?: boolean } }) {
    this.register(new ClaudeCliProvider(opts.claudeBin ?? process.env.BOTONS_CLAUDE_BIN ?? 'claude', opts.managed?.claude));
    this.register(new CodexCliProvider(opts.codexBin ?? process.env.BOTONS_CODEX_BIN ?? 'codex', undefined, opts.managed?.codex));
    if (opts.enableMock) this.register(new MockProvider());
  }

  register(p: Provider) {
    if (this.#providers.has(p.id)) { this.#incarnations.set(p.id, randomUUID()); this.#rechecks.delete(p.id); }
    this.#providers.set(p.id, p);
  }

  get(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  ids(): Set<string> {
    return new Set(this.#providers.keys());
  }

  /** What `provider`'s own model list says `model` takes, or null when nothing is known about it. */
  modelEfforts(provider: string, model: string): ModelEfforts | null {
    return this.#providers.get(provider)?.modelEfforts?.(model.trim()) ?? null;
  }

  /** Where the usage limits come from, so each provider's readiness shows its own. */
  setUsageLimits(until: (id: string) => string | null): void {
    this.#usageLimitUntil = until;
  }

  async infos(opts: { recheck?: boolean } = {}): Promise<ProviderInfo[]> {
    const providers = [...this.#providers.values()];
    if (opts.recheck) for (const p of providers) p.recheck?.();
    return Promise.all(
      providers.map(async (p) => {
        const boot = this.#incarnations.get(p.id) ?? this.boot;
        const turns = this.#turns.get(p.id);
        const { check, ...info } = await p.info();
        const readiness = brainReadiness({ ...info, check }, this.#usageLimitUntil(p.id), Date.now(), boot);
        return { ...info, effort: info.effort ?? effortInfo(p.id, p.label), lastSuccessAt: turns?.lastSuccessAt ?? null, lastError: turns?.lastError ?? null, readiness };
      }),
    );
  }

  /**
   * The providers as infos() would show them, from the checks already done: runs no check, whatever their age. A
   * provider never checked is 'unknown' ('not-checked'), one checked too long ago 'unknown' ('outdated').
   */
  snapshots(now = Date.now()): ProviderInfo[] {
    return [...this.#providers.values()].map((p) => {
      const turns = this.#turns.get(p.id);
      const status = p.snapshot ? p.snapshot() : { id: p.id, label: p.label, kind: 'cli' as const, available: false, reason: 'Not checked yet since the server started.', installed: false, version: null, loggedIn: null, checkedAt: null, models: [], defaultModel: '' };
      const { check, ...info } = status;
      const readiness = brainReadiness({ ...info, check }, this.#usageLimitUntil(p.id), now, this.#incarnations.get(p.id) ?? this.boot);
      return { ...info, effort: info.effort ?? effortInfo(p.id, p.label), lastSuccessAt: turns?.lastSuccessAt ?? null, lastError: turns?.lastError ?? null, readiness };
    });
  }

  /**
   * The owner's "check again": each provider's checks run anew, unless it was asked OWNER_RECHECKS times in the last
   * OWNER_RECHECK_WINDOW_MS, so a held-down button can't keep the CLIs busy. A check already running is waited for and
   * a new one runs after it (CliChecker): never two at once. Returns the providers whose checks run anew.
   */
  ownerRecheck(now = Date.now()): string[] {
    const rechecked: string[] = [];
    for (const p of this.#providers.values()) {
      if (!p.recheck) continue;
      const recent = (this.#rechecks.get(p.id) ?? []).filter((t) => now - t < OWNER_RECHECK_WINDOW_MS);
      if (recent.length < OWNER_RECHECKS) {
        recent.push(now);
        p.recheck();
        rechecked.push(p.id);
      }
      this.#rechecks.set(p.id, recent);
    }
    return rechecked;
  }

  /** After a failure the checks run again at once (in the background), so a signed-out CLI gets logged. */
  recordTurn(id: string, outcome: { ok: true } | { ok: false; error: string }): void {
    const rec = this.#turns.get(id) ?? { lastSuccessAt: null, lastError: null };
    const at = nowIso();
    if (outcome.ok) rec.lastSuccessAt = at;
    else rec.lastError = { at, message: truncate(outcome.error, 500) };
    this.#turns.set(id, rec);
    const p = this.#providers.get(id);
    if (!outcome.ok && p?.recheck) {
      p.recheck();
      p.info().catch(() => {});
    }
  }

  async defaultProvider(): Promise<string> {
    const infos = await this.infos();
    return (infos.find((i) => i.available && i.id !== 'mock') ?? infos[0]).id;
  }
}

/** What the owner's effort control offers for a provider: its levels, or why it has none. */
export function effortInfo(id: string, label: string): ProviderEffortInfo {
  const p = providerEffort(id);
  if (!p) return { levels: [], reason: `${label} has no effort setting Botons can pass on, so it runs at its own default.`, via: null, defaultText: 'the provider’s default' };
  return { levels: p.levels.map((l) => ({ id: l.id, label: l.label })), reason: null, via: p.via, defaultText: p.defaultText };
}
