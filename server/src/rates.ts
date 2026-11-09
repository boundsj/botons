import type { TokenUsage } from '../../shared/types.ts';

/*
 * What API-key turns cost, as Botons estimates it: the tokens each answer reports times these per-model rates. The
 * rates are copied from the providers' own price pages (the sources below, on the date given), standard tier, no
 * batch, regional, data-residency, fast or priority pricing (Botons asks for none of those). A model not listed here,
 * or past a rate's `until`, has no known price: its cost is unknown, never guessed from a similar name, and a Boton
 * or routine with a spending cap won't run on it. The estimate is not the provider's bill: the bill is the provider's.
 */

/** US dollars per million tokens. `cacheRead`/`cacheWrite` null: the page lists none (charged as input, if ever). */
export interface Rate {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface ModelRate {
  provider: 'anthropic' | 'openai';
  model: string;
  rate: Rate;
  /** A prompt (all its input tokens, cached ones included) over `over` tokens is priced at `rate` instead. */
  long?: { over: number; rate: Rate };
  /** The last day these rates hold (a promotion's end); after it the price is unknown. */
  until?: string;
}

export const RATE_SOURCES = {
  anthropic: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: '2026-11-07', cacheWrite: '5-minute cache writes (Botons asks for no longer)' },
  openai: { url: 'https://developers.openai.com/api/docs/pricing', checked: '2026-11-07', cacheWrite: '30-minute cache writes (Botons asks for no longer)' },
} as const;

const r = (input: number, output: number, cacheRead: number | null, cacheWrite: number | null): Rate => ({ input, output, cacheRead, cacheWrite });

const ANTHROPIC: Record<string, Omit<ModelRate, 'provider' | 'model'>> = {
  'claude-fable-5-1': { rate: r(10, 50, 0.25, 12.5) },
  'claude-mythos-5-1': { rate: r(10, 50, 0.25, 12.5) },
  'claude-fable-5': { rate: r(10, 50, 1, 12.5) },
  'claude-opus-5-5': { rate: r(4, 20, 0.2, 5) },
  'claude-opus-5': { rate: r(5, 25, 0.5, 6.25) },
  'claude-opus-4-8': { rate: r(5, 25, 0.5, 6.25) },
  'claude-opus-4-7': { rate: r(5, 25, 0.5, 6.25) },
  'claude-opus-4-6': { rate: r(5, 25, 0.5, 6.25) },
  'claude-sonnet-5-5': { rate: r(2, 10, 0.1, 2.5) },
  'claude-sonnet-5': { rate: r(2, 10, 0.2, 2.5) },
  'claude-sonnet-4-6': { rate: r(3, 15, 0.3, 3.75) },
  'claude-haiku-5-5': { rate: r(0.1, 0.5, 0.01, 0.125), long: { over: 100_000, rate: r(0.5, 2.5, 0.05, 0.625) } },
  'claude-haiku-4-5': { rate: r(1, 5, 0.1, 1.25) },
};

const LONG_OPENAI = 272_000;
const OPENAI: Record<string, Omit<ModelRate, 'provider' | 'model'>> = {
  'gpt-6-astra': { rate: r(10, 50, 1, 12.5), long: { over: LONG_OPENAI, rate: r(20, 75, 2, 25) } },
  'gpt-6.1-sol': { rate: r(2, 10, 0.1, 2.5), long: { over: LONG_OPENAI, rate: r(4, 15, 0.2, 5) } },
  'gpt-6.1-terra': { rate: r(1, 5, 0.05, 1.25), long: { over: LONG_OPENAI, rate: r(2, 7.5, 0.1, 2.5) } },
  'gpt-6-luna': { rate: r(0.1, 0.5, 0.01, 0.125), long: { over: LONG_OPENAI, rate: r(0.2, 0.75, 0.02, 0.25) } },
  'gpt-6-sol': { rate: r(2, 10, 0.2, 2.5), long: { over: LONG_OPENAI, rate: r(4, 15, 0.4, 5) } },
  // A promotional price, until the end of 2026-11-30 as the page says.
  'gpt-5.6-sol': { rate: r(4, 20, 0.4, 5), long: { over: LONG_OPENAI, rate: r(8, 30, 0.8, 10) }, until: '2026-11-30' },
  'gpt-5.6-terra': { rate: r(2, 12, 0.2, 2.5), long: { over: LONG_OPENAI, rate: r(4, 18, 0.4, 5) } },
  'gpt-5.6-luna': { rate: r(0.2, 1.2, 0.02, 0.25), long: { over: LONG_OPENAI, rate: r(0.4, 1.8, 0.04, 0.5) } },
  'gpt-5.5': { rate: r(5, 30, 0.5, null), long: { over: LONG_OPENAI, rate: r(10, 45, 1, null) } },
  'gpt-5.5-pro': { rate: r(30, 180, null, null), long: { over: LONG_OPENAI, rate: r(60, 270, null, null) } },
  'gpt-5.4': { rate: r(2.5, 15, 0.25, null), long: { over: LONG_OPENAI, rate: r(5, 22.5, 0.5, null) } },
  'gpt-5.4-pro': { rate: r(30, 180, null, null), long: { over: LONG_OPENAI, rate: r(60, 270, null, null) } },
  'gpt-5.4-mini': { rate: r(0.75, 4.5, 0.075, null) },
  'gpt-5.4-nano': { rate: r(0.2, 1.25, 0.02, null) },
  'gpt-5.2': { rate: r(1.75, 14, 0.175, null) },
  'gpt-5.2-pro': { rate: r(21, 168, null, null) },
  'gpt-5.1': { rate: r(1.25, 10, 0.125, null) },
  'gpt-5': { rate: r(1.25, 10, 0.125, null) },
  'gpt-5-mini': { rate: r(0.25, 2, 0.025, null) },
  'gpt-5-nano': { rate: r(0.05, 0.4, 0.005, null) },
  'gpt-5-pro': { rate: r(15, 120, null, null) },
  'gpt-4.1': { rate: r(2, 8, 0.5, null) },
  'gpt-4.1-mini': { rate: r(0.4, 1.6, 0.1, null) },
  'gpt-4o': { rate: r(2.5, 10, 1.25, null) },
  'gpt-4o-mini': { rate: r(0.15, 0.6, 0.075, null) },
  'o3-pro': { rate: r(20, 80, null, null) },
  o3: { rate: r(2, 8, 0.5, null) },
};

/** The rates for exactly `model` (no prefix or snapshot matching), or null when its price isn't known. */
export function rateFor(provider: 'anthropic' | 'openai', model: string, now = new Date()): ModelRate | null {
  const table = provider === 'anthropic' ? ANTHROPIC : OPENAI;
  const found = Object.hasOwn(table, model) ? table[model] : undefined;
  if (!found) return null;
  if (found.until && now.toISOString().slice(0, 10) > found.until) return null;
  return { provider, model, ...found };
}

const PER = 1_000_000;

/** The rate a prompt of `promptTokens` input tokens (cached ones included) pays. */
function rateAt(m: ModelRate, promptTokens: number): Rate {
  return m.long && promptTokens > m.long.over ? m.long.rate : m.rate;
}

/** The estimate for one answer's usage; `inputTokens` excludes cache reads and writes (TokenUsage's meaning). */
export function costOf(m: ModelRate, u: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const rate = rateAt(m, prompt);
  const usd = (u.inputTokens * rate.input + u.cacheReadTokens * (rate.cacheRead ?? rate.input) + u.cacheWriteTokens * (rate.cacheWrite ?? rate.input) + u.outputTokens * rate.output) / PER;
  return round(usd);
}

/**
 * The most one request can cost: every one of at most `inputTokens` input tokens at the dearest input rate (a cache
 * write costs more than plain input), and `maxOutputTokens` (the cap the request sets, thinking included) at the
 * output rate, at the long-context rate if the prompt could be long.
 */
export function mostOf(m: ModelRate, inputTokens: number, maxOutputTokens: number): number {
  const rate = rateAt(m, inputTokens);
  const dearest = Math.max(rate.input, rate.cacheWrite ?? 0, rate.cacheRead ?? 0);
  return round((inputTokens * dearest + maxOutputTokens * rate.output) / PER);
}

/** The output tokens `usd` pays for at most, after `inputTokens` at the dearest input rate; 0 when it can't. */
export function outputFor(m: ModelRate, inputTokens: number, usd: number): number {
  const rate = rateAt(m, inputTokens);
  const dearest = Math.max(rate.input, rate.cacheWrite ?? 0, rate.cacheRead ?? 0);
  const left = usd * PER - inputTokens * dearest;
  return left <= 0 ? 0 : Math.floor(left / rate.output);
}

/** Dollars are summed as floats; rounded to a millionth of a cent so sums compare as they read. */
export const round = (usd: number) => Math.round(usd * 1e8) / 1e8;
