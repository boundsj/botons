const WINDOW_MS = 3_600_000;

/**
 * Sliding one-hour windows on runs (or asks) started: per key and in total.
 * In memory, so a restart starts them afresh.
 */
export class RunLimiter {
  #perKey: number;
  #total: number;
  #byKey = new Map<string, number[]>();
  #all: number[] = [];

  constructor(perKey: number, total: number) {
    this.#perKey = perKey;
    this.#total = total;
  }

  /** Null if `key` may start another now; otherwise which limit it hit and when a slot frees up. */
  check(key: string): { limit: 'routine' | 'total'; max: number; retryAfterMs: number } | null {
    const now = Date.now();
    const mine = this.#prune(this.#byKey.get(key) ?? [], now);
    if (mine.length) this.#byKey.set(key, mine);
    else this.#byKey.delete(key);
    this.#all = this.#prune(this.#all, now);
    if (mine.length >= this.#perKey) return { limit: 'routine', max: this.#perKey, retryAfterMs: mine[mine.length - this.#perKey] + WINDOW_MS - now };
    if (this.#all.length >= this.#total) return { limit: 'total', max: this.#total, retryAfterMs: this.#all[this.#all.length - this.#total] + WINDOW_MS - now };
    return null;
  }

  record(key: string): void {
    const now = Date.now();
    const mine = this.#byKey.get(key) ?? [];
    mine.push(now);
    this.#byKey.set(key, mine);
    this.#all.push(now);
  }

  #prune(times: number[], now: number): number[] {
    const from = now - WINDOW_MS;
    let i = 0;
    while (i < times.length && times[i] <= from) i++;
    return i ? times.slice(i) : times;
  }
}
