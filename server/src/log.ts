import { fstatSync } from 'node:fs';

// Node builtins only: scripts/backup.ts imports config.ts, which imports this, without node_modules.

/*
 * One JSON object per line on stdout. Never log secrets (tokens, webhook keys,
 * Authorization headers, ?key= values), chat text or webhook payloads; known
 * token shapes are masked anyway, as a last line of defense.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** `err` (any thrown value) is written as `error` and `stack`. */
export type LogFields = Record<string, unknown>;

export interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

/** syslog priorities, for the `<N>` prefix journald reads (and strips) when stdout is the journal. */
const PRIORITY: Record<LogLevel, number> = { debug: 7, info: 6, warn: 4, error: 3 };

const envLevel = process.env.BOTONS_LOG_LEVEL?.trim().toLowerCase();
/** BOTONS_LOG_LEVEL until the server applies its config. */
let threshold: LogLevel = LOG_LEVELS.find((l) => l === envLevel) ?? 'info';
/** Set while a test captures lines. */
let sink: ((line: string) => void) | null = null;
/** Called with every line written (never debug), before it is serialized: Settings → Server events. */
const taps = new Set<(level: LogLevel, msg: string, fields: LogFields, at: Date) => void>();

/** Sees each info, warn and error line the threshold lets through; returns the function that stops it. A tap that throws costs nothing. */
export function tapLogs(fn: (level: LogLevel, msg: string, fields: LogFields, at: Date) => void): () => void {
  taps.add(fn);
  return () => void taps.delete(fn);
}

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Whether JOURNAL_STREAM (`<device>:<inode>`) names stdout, so `journalctl -p` works and `-o cat` still shows plain JSON. */
export function isJournalStream(journalStream: string | undefined, stat: () => { dev: bigint; ino: bigint }): boolean {
  const m = /^(\d+):(\d+)$/.exec(journalStream?.trim() ?? '');
  if (!m) return false;
  try {
    const st = stat();
    return st.dev === BigInt(m[1]) && st.ino === BigInt(m[2]);
  } catch {
    return false;
  }
}

let toJournal: boolean | undefined;

function errorFields(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) return err.stack ? { error: err.message, stack: err.stack } : { error: err.message };
  return { error: typeof err === 'string' ? err : safeString(err) };
}

function safeString(v: unknown): string {
  try {
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

/** Runs on the JSON text, and never introduces a quote or backslash. */
export function redact(text: string): string {
  return text
    .replace(/\b(md|mm)t_[A-Za-z0-9_-]{8,}/g, '$1t_[redacted]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/([?&]key=)[^&\s"\\#]+/gi, '$1[redacted]');
}

const replacer = (_key: string, value: unknown) => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return errorFields(value);
  return value;
};

export function formatLine(level: LogLevel, msg: string, fields: LogFields = {}, now = new Date()): string {
  const out: Record<string, unknown> = { ts: now.toISOString(), level, msg };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || k === 'ts' || k === 'level' || k === 'msg') continue;
    if (k === 'err') Object.assign(out, errorFields(v));
    else out[k] = v;
  }
  try {
    return redact(JSON.stringify(out, replacer));
  } catch (err) {
    // A field that can't be serialized (a cycle, say) must not cost the line.
    return redact(JSON.stringify({ ts: out.ts, level, msg, logError: `fields not logged: ${(err as Error).message}` }));
  }
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(threshold)) return;
  const now = new Date();
  if (level !== 'debug') {
    for (const tap of taps) {
      try {
        tap(level, msg, fields ?? {}, now);
      } catch {}
    }
  }
  const line = formatLine(level, msg, fields, now);
  if (sink) return sink(line);
  toJournal ??= isJournalStream(process.env.JOURNAL_STREAM, () => fstatSync(1, { bigint: true }));
  process.stdout.write(`${toJournal ? `<${PRIORITY[level]}>` : ''}${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};

/** For tests: collect every line (all levels) instead of writing it, until restore(). */
export function captureLogs(): { lines: LogLine[]; restore(): void } {
  const lines: LogLine[] = [];
  const prev = { sink, threshold };
  sink = (line) => lines.push(JSON.parse(line) as LogLine);
  threshold = 'debug';
  return {
    lines,
    restore() {
      sink = prev.sink;
      threshold = prev.threshold;
    },
  };
}
