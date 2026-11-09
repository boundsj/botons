import type { RecentLogEntry, RecentLogLevel, RecentLogs } from '../../shared/types.ts';

export interface LogFilters {
  level: RecentLogLevel;
  q: string;
  boton: string;
}

export interface ServerLogState {
  filters: LogFilters;
  /** The last answer for these filters, from the server process the entries came from; null until one arrives. */
  data: RecentLogs | null;
  entries: RecentLogEntry[];
  error: string | null;
  loading: boolean;
  loadedAt: string | null;
  /** Set when an answer came from a newer server process than the one shown before. */
  restartedAt: string | null;
}

export interface ServerLogLoaderDeps {
  fetch: (f: LogFilters, before?: number) => Promise<RecentLogs>;
  errorText: (err: unknown) => string;
  /** How long a search waits for a pause in typing. */
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => Date;
}

/*
 * Settings → Server events' state, outside React so its ordering can be tested. Every load takes a ticket, and only
 * the newest ticket's answer is applied. A filter change takes one at once (before its debounced load starts), so
 * an answer for the old filters that lands meanwhile changes nothing, and what is on screen is cleared: lines for
 * other filters are never shown under these. A server's seq numbers start again when it restarts, so "Show older"
 * whose answer comes from a new process throws the old lines away and loads the newest without the old cursor.
 */
export class ServerLogLoader {
  #deps: Required<ServerLogLoaderDeps>;
  #state: ServerLogState;
  #listeners = new Set<() => void>();
  #ticket = 0;
  #timer: unknown = null;
  /** The server process the entries on screen came from. */
  #since: string | null = null;

  constructor(deps: ServerLogLoaderDeps, filters: LogFilters = { level: 'warn', q: '', boton: '' }) {
    this.#deps = {
      debounceMs: 300,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: () => new Date(),
      ...deps,
    };
    this.#state = { filters, data: null, entries: [], error: null, loading: true, loadedAt: null, restartedAt: null };
  }

  get state(): ServerLogState {
    return this.#state;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  };

  #set(patch: Partial<ServerLogState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  /** The first load; again after stop (React runs effects twice in development). */
  start(): void {
    this.#schedule(0);
  }

  stop(): void {
    this.#ticket++;
    this.#cancelTimer();
  }

  setFilters(filters: LogFilters): void {
    const f = this.#state.filters;
    if (f.level === filters.level && f.q === filters.q && f.boton === filters.boton) return;
    this.#ticket++;
    this.#set({ filters, data: null, entries: [], error: null, loading: true });
    this.#schedule(filters.q ? this.#deps.debounceMs : 0);
  }

  refresh(): void {
    this.#cancelTimer();
    void this.#load();
  }

  older(): void {
    const last = this.#state.entries.at(-1)?.seq;
    if (last === undefined || !this.#state.data?.more) return;
    this.#cancelTimer();
    void this.#load(last);
  }

  #schedule(ms: number): void {
    this.#cancelTimer();
    const ticket = this.#ticket;
    this.#timer = this.#deps.setTimer(() => {
      this.#timer = null;
      if (ticket === this.#ticket) void this.#load();
    }, ms);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) this.#deps.clearTimer(this.#timer);
    this.#timer = null;
  }

  async #load(before?: number): Promise<void> {
    const ticket = ++this.#ticket;
    const filters = this.#state.filters;
    this.#set({ loading: true, error: null });
    let page: RecentLogs;
    try {
      page = await this.#deps.fetch(filters, before);
    } catch (err) {
      if (ticket === this.#ticket) this.#set({ loading: false, error: this.#deps.errorText(err) });
      return;
    }
    if (ticket !== this.#ticket) return;
    const restarted = this.#since !== null && page.since !== this.#since;
    this.#since = page.since;
    if (restarted && before !== undefined) {
      // The cursor was a seq from the old process: what it returned is meaningless next to the lines on screen.
      this.#set({ restartedAt: page.since, data: null, entries: [] });
      return this.#load();
    }
    const entries = before === undefined ? page.entries : [...this.#state.entries, ...page.entries.filter((e) => e.seq < before)];
    this.#set({ data: page, entries, loading: false, loadedAt: this.#deps.now().toISOString(), ...(restarted ? { restartedAt: page.since } : {}) });
  }
}
