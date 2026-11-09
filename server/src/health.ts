import type { BrainProblem, DatabaseProblem, Health, HealthCheck, HealthDetails, OperationsBrain, OperationsHealth, ProviderInfo } from '../../shared/types.ts';
import { buildSha, versionNumber } from '../../shared/util.ts';
import type { Config } from './config.ts';
import type { Engine } from './engine.ts';
import type { ProviderRegistry } from './providers/index.ts';
import type { Store } from './store.ts';

export const SCHEDULER_STALE_INTERVALS = 3;

/** SQLite's primary result codes (node:sqlite's `errcode`, extended codes included), as the owner's fixed words. */
const SQLITE_PROBLEMS: Record<number, DatabaseProblem> = { 5: 'busy', 6: 'busy', 8: 'read-only', 10: 'io-error', 11: 'corrupt', 13: 'disk-full', 14: 'cannot-open', 26: 'corrupt' };

/** What a failed database check says about where to look, as a fixed word. */
export function databaseProblem(err: unknown): DatabaseProblem {
  const code = (err as { errcode?: unknown })?.errcode;
  return (typeof code === 'number' && SQLITE_PROBLEMS[code & 0xff]) || 'other';
}

function brainProblem(p: ProviderInfo): BrainProblem | null {
  if (p.available) return null;
  if (!p.installed) return 'not-installed';
  if (p.loggedIn === false) return 'signed-out';
  return 'unavailable';
}

/** A brain for the owner's view: its states and times, a version number only if one is found, and none of the CLI's text. */
export function ownerBrain(p: ProviderInfo, usageLimitUntil: string | null = null): OperationsBrain {
  return {
    id: p.id,
    label: p.label,
    available: p.available,
    installed: p.installed,
    loggedIn: p.loggedIn,
    version: versionNumber(p.version),
    problem: brainProblem(p),
    lastSuccessAt: p.lastSuccessAt,
    lastErrorAt: p.lastError?.at ?? null,
    usageLimitUntil,
    readiness: p.readiness,
  };
}

/** Whether this server can do its job, not just answer. */
export class HealthMonitor {
  #cfg: Config;
  #store: Store;
  #engine: Engine;
  #providers: ProviderRegistry;
  #startedAt = Date.now();
  #lastTickAt: number | null = null;

  constructor(deps: { cfg: Config; store: Store; engine: Engine; providers: ProviderRegistry }) {
    this.#cfg = deps.cfg;
    this.#store = deps.store;
    this.#engine = deps.engine;
    this.#providers = deps.providers;
  }

  schedulerTicked(at = Date.now()): void {
    this.#lastTickAt = at;
  }

  async check(): Promise<Required<Health>> {
    return (await this.#check()).health;
  }

  /** The same checks for Settings → Health: fixed words for what failed, never error text, paths or CLI output. */
  async owner(usageLimitUntil: (providerId: string) => string | null = () => null): Promise<OperationsHealth> {
    const { health, databaseProblem: problem } = await this.#check();
    const { details } = health;
    return {
      ok: health.ok,
      build: buildSha(health.build),
      failing: health.failing,
      details: {
        database: { ok: details.database.ok, problem: details.database.ok ? null : problem },
        scheduler: details.scheduler,
        providers: details.providers.map((p) => ownerBrain(p, usageLimitUntil(p.id))),
        draining: details.draining,
      },
    };
  }

  async #check(): Promise<{ health: Required<Health>; databaseProblem: DatabaseProblem | null }> {
    const now = Date.now();
    const { problem, ...database } = this.#database();
    const intervalMs = this.#cfg.schedulerIntervalMs;
    const scheduler = {
      ok: now - (this.#lastTickAt ?? this.#startedAt) <= SCHEDULER_STALE_INTERVALS * intervalMs,
      lastTickAt: this.#lastTickAt === null ? null : new Date(this.#lastTickAt).toISOString(),
      intervalMs,
    };
    let providers: ProviderInfo[] = [];
    let providersOk = false;
    try {
      providers = await this.#providers.infos();
      providersOk = providers.some((p) => p.available);
    } catch {}
    const draining = this.#engine.draining;
    const failing: HealthCheck[] = [];
    if (!database.ok) failing.push('database');
    if (!scheduler.ok) failing.push('scheduler');
    if (!providersOk) failing.push('providers');
    if (draining) failing.push('draining');
    const details: HealthDetails = { database, scheduler, providers, draining };
    return { health: { ok: failing.length === 0, build: this.#cfg.build, failing, details }, databaseProblem: problem };
  }

  #database(): HealthDetails['database'] & { problem: DatabaseProblem | null } {
    try {
      this.#store.db.prepare('select count(*) as n from bots').get();
      return { ok: true, error: null, problem: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message, problem: databaseProblem(err) };
    }
  }
}
