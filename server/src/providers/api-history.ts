import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.ts';

/*
 * An API brain's sessions: each one's conversation as the provider's own items (so reasoning is passed back unchanged),
 * kept by the server in BOTONS_HOME/api-sessions, a 0700 folder Workspace Botons can't read (isolation.ts hides
 * everything in BOTONS_HOME). One JSON file per session, written whole and renamed into place. A session whose file is
 * gone is lost, and the engine starts a new one with the chat replayed.
 */

/** user: the owner's (or a run's) input; assistant: one answer of the model; tools: the results of its tool calls. */
export interface HistoryItem {
  kind: 'user' | 'assistant' | 'tools';
  data: unknown;
}

export interface History {
  v: 1;
  provider: string;
  /** The tools the last request was made with (see toolsKey). */
  toolsKey: string | null;
  /** The model of the last answer. */
  model: string | null;
  items: HistoryItem[];
}

const ID = /^[a-z]+-[0-9a-f-]{36}$/;
/** Files not written for this long belong to sessions no Boton keeps. */
const STALE_MS = 120 * 86_400_000;

export class HistoryStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.#prune();
  }

  newId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  #file(id: string): string | null {
    return ID.test(id) ? join(this.dir, `${id}.json`) : null;
  }

  /** The session's history; null when it is gone (or never was). */
  load(id: string, provider: string): History | null {
    const file = this.#file(id);
    if (!file) return null;
    try {
      const h = JSON.parse(readFileSync(file, 'utf8')) as History;
      if (h?.v !== 1 || h.provider !== provider || !Array.isArray(h.items)) return null;
      return h;
    } catch {
      return null;
    }
  }

  save(id: string, h: History): void {
    const file = this.#file(id);
    if (!file) throw new Error('not a session id');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
    renameSync(tmp, file);
  }

  #prune() {
    try {
      const now = Date.now();
      for (const name of readdirSync(this.dir)) {
        const path = join(this.dir, name);
        if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
      }
    } catch (err) {
      log.debug('could not prune old API sessions', { err });
    }
  }
}

/** How big an item is, in bytes of its JSON (what the request carries of it, give or take its framing). */
export const sizeOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** What a tool result becomes when the request can't carry it: the call and its result stay a pair. */
export const leftOut = (bytes: number) => `[This output (${bytes} bytes) was left out so the request stays within what Botons sends at once. Run the tool again for what you still need of it.]`;

export type Fit =
  | { ok: true; items: HistoryItem[]; trimmed: boolean; compacted: number }
  | { ok: false; over: number; why: 'input' | 'turn' };

/**
 * The items a request carries, within `budget` bytes with the request's `fixed` part (instructions, tools, framing):
 * whole older exchanges (each from a user item) go first, oldest first; then, in the newest exchange, the outputs of
 * tool calls, oldest first, each replaced by a note (its call and result stay a valid pair). The newest user item and
 * the model's own answers are never cut. When even that doesn't fit, nothing is sent: `why` says whether the new input
 * alone is too big, or the turn has grown past the bound. `trimmed`: older exchanges went, so reasoning bound to the
 * full history must go too.
 */
export function fitRequest(items: HistoryItem[], budget: number, fixed: number): Fit {
  const starts = items.flatMap((it, i) => (it.kind === 'user' ? [i] : []));
  const sizes = items.map((it) => sizeOf(it.data));
  let total = fixed + sizes.reduce((a, b) => a + b, 0);
  // Before the first exchange: nothing a request can start with.
  let from = starts.length ? starts[0] : items.length;
  for (let i = 0; i < from; i++) total -= sizes[i];
  for (let k = 0; total > budget && k < starts.length - 1; k++) {
    for (let i = starts[k]; i < starts[k + 1]; i++) total -= sizes[i];
    from = starts[k + 1];
  }
  const out = items.slice(from);
  let compacted = 0;
  if (total > budget) {
    const first = out.findIndex((it) => it.kind === 'user');
    if (first >= 0 && fixed + sizeOf(out[first].data) > budget) return { ok: false, over: fixed + sizeOf(out[first].data) - budget, why: 'input' };
    for (let i = 0; i < out.length && total > budget; i++) {
      const it = out[i];
      if (it.kind !== 'tools') continue;
      const data = it.data as { results?: { id: string; name: string; text: string; isError: boolean; leftOut?: boolean }[] };
      if (!Array.isArray(data?.results)) continue;
      const before = sizeOf(data);
      const results = data.results.map((r) => (r.leftOut || Buffer.byteLength(r.text) <= 512 ? r : (compacted++, { ...r, text: leftOut(Buffer.byteLength(r.text)), leftOut: true })));
      out[i] = { ...it, data: { ...data, results } };
      total += sizeOf(out[i].data) - before;
    }
    if (total > budget) return { ok: false, over: total - budget, why: 'turn' };
  }
  return { ok: true, items: out, trimmed: from > 0, compacted };
}
