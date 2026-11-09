import type { ApiKeyProvider } from '../../../shared/types.ts';
import type { ToolCall, ToolSpec } from './api-tools.ts';
import { StreamError, sseEvents } from './sse.ts';

/*
 * The two model APIs an API brain speaks, each as its documented wire protocol over fetch: Anthropic's Messages API
 * (POST /v1/messages) and OpenAI's Responses API (POST /v1/responses), both streamed as server-sent events. The
 * conversation is kept by Botons (OpenAI's `store` is off); the model's own answers are kept as the provider sent them,
 * reasoning included, and passed back unchanged, except as sanitize() decides for a known secret (an API key):
 *
 * - Text Botons may change without breaking the protocol (an answer's text, a tool call's arguments, a refusal) has the
 *   secret replaced; a tool call whose arguments held one is marked, and the brain doesn't run it.
 * - Signed or encrypted reasoning (Anthropic's thinking and redacted_thinking blocks, OpenAI's reasoning items) can't
 *   be changed and stay valid: one that holds a secret is left out (citations and annotations likewise).
 * - Anything else that holds one (an id, a tool's name, a block of a kind Botons doesn't know) can be neither changed
 *   nor left out safely: the whole answer is refused (SecretInAnswer) and nothing of it is kept.
 *
 * Usage is taken only when the provider reported every counter its docs require, each a whole number from 0 up, and
 * consistent with the others; anything else is unknown (null), never zero, and the request's reservation is held.
 */

export interface UserInput {
  text: string;
  /** Only in the turn they came with; history keeps a note in their place. */
  images?: { mediaType: string; base64: string }[];
}

export interface ToolResults {
  results: { id: string; name: string; text: string; isError: boolean }[];
}

export type WireItem = { kind: 'user'; data: UserInput } | { kind: 'assistant'; data: unknown } | { kind: 'tools'; data: ToolResults };

export interface WireUsage {
  /** Excluding cache reads and writes. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface WireRound {
  text: string;
  calls: ToolCall[];
  stop: 'end' | 'tools' | 'max_tokens' | 'refusal' | 'paused' | 'other';
  /** The provider's word for why it stopped, when it isn't a plain end. */
  stopDetail: string | null;
  /** The answer, as the provider sent it, to keep in the history. */
  assistant: unknown;
  usage: WireUsage | null;
  model: string | null;
}

export type WireErrorKind = 'auth' | 'forbidden' | 'quota' | 'rate_limited' | 'overloaded' | 'server' | 'bad_request' | 'not_found' | 'network' | 'stream';

export class WireError extends Error {
  readonly kind: WireErrorKind;
  readonly status: number | null;
  /** The request reached the provider and may have been billed (the answer broke off, or never came). */
  readonly sent: boolean;
  /** What the provider said the answer used before it broke off, if it said. */
  readonly usage: WireUsage | null;
  readonly retryAfterMs: number | null;
  constructor(kind: WireErrorKind, message: string, o: { status?: number | null; sent?: boolean; usage?: WireUsage | null; retryAfterMs?: number | null } = {}) {
    super(message);
    this.kind = kind;
    this.status = o.status ?? null;
    this.sent = o.sent ?? false;
    this.usage = o.usage ?? null;
    this.retryAfterMs = o.retryAfterMs ?? null;
  }
}

export interface SendOptions {
  origin: string;
  key: string;
  signal: AbortSignal;
  onText: (textSoFar: string) => void;
  onActivity: (a: string) => void;
  /** No gap between chunks longer than this. */
  idleMs: number;
}

export interface Wire {
  provider: ApiKeyProvider;
  /** The provider id Botons pick, and the session id prefix. */
  id: string;
  label: string;
  /** "anthropic" or "openai": session ids start with it. */
  prefix: string;
  defaultModel: string;
  maxOutput(effort: string): number;
  /** `noCalls`: the tools are only described (the history has calls to them); the model may call none. */
  body(o: { model: string; effort: string; system: string; items: WireItem[]; tools: ToolSpec[]; maxOutput: number; noCalls?: boolean }): Record<string, unknown>;
  send(body: Record<string, unknown>, o: SendOptions): Promise<WireRound>;
  /** The answer without its reasoning (for a history whose start or tools changed); null when nothing is left. */
  stripReasoning(assistant: unknown): unknown | null;
  /**
   * The answer with every known secret out of it (see the top of this file), its text and calls read again from what
   * is left; throws SecretInAnswer when it can't be. A kept answer from the history goes through it too (`round` with
   * only `assistant` set), so nothing kept or sent again holds a secret known now.
   */
  sanitize(assistant: unknown, s: Scrub, calls?: ToolCall[]): { assistant: unknown; text: string; calls: ToolCall[]; left: number };
  /** A refusal of reasoning made under another history: send again without it, once. */
  reasoningRefused(err: WireError): boolean;
  /** A body the provider may take after it refused `body` this way (once; nothing was generated), or null. */
  adjust(body: Record<string, unknown>, err: WireError): Record<string, unknown> | null;
}

const MAX_STREAM = 64 * 1024 * 1024;
const MAX_EVENT = 16 * 1024 * 1024;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** No request reports more tokens of a kind than this; more is not a count. */
const MAX_TOKENS = 100_000_000;
const BAD = Symbol('bad');
/** A token counter: a whole number from 0 up; `nullable` lets null or absence read as 0 (documented as optional). */
function count(v: unknown, nullable: boolean): number | typeof BAD {
  if (v === undefined || v === null) return nullable ? 0 : BAD;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKENS ? v : BAD;
}

/** A secret Botons knows of (an API key), and how to take it out of text. */
export interface Scrub {
  holds(text: string): boolean;
  redact(text: string): string;
}

/** The provider's answer held a secret where Botons can neither change nor leave it out. */
export class SecretInAnswer extends Error {}

/** Deeper than this, a value isn't walked: one that holds a secret is replaced whole (and a call with it isn't run). */
const MAX_DEPTH = 64;

/**
 * Every string (and key) of a JSON value redacted; `changed` says whether any held a secret. Past MAX_DEPTH a value
 * that holds one is replaced whole by its redacted text, never kept as it was.
 */
function redactDeep(v: unknown, s: Scrub, depth = 0): { value: unknown; changed: boolean } {
  if (typeof v === 'string') {
    if (!s.holds(v)) return { value: v, changed: false };
    return { value: s.redact(v), changed: true };
  }
  if (v === null || typeof v !== 'object') return { value: v, changed: false };
  if (depth >= MAX_DEPTH) return holdsAny(v, s) ? { value: '[too deep to keep: it held an API key]', changed: true } : { value: v, changed: false };
  let changed = false;
  if (Array.isArray(v)) {
    const out = v.map((x) => {
      const r = redactDeep(x, s, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value: changed ? out : v, changed };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const key = s.holds(k) ? s.redact(k) : k;
    const r = redactDeep(x, s, depth + 1);
    changed ||= r.changed || key !== k;
    out[key] = r.value;
  }
  return { value: changed ? out : v, changed };
}

/** Whether a value holds a secret anywhere; one that can't be read as JSON (a cycle) counts as holding one. */
function holdsAny(v: unknown, s: Scrub): boolean {
  if (v === undefined) return false;
  try {
    return s.holds(JSON.stringify(v));
  } catch {
    return true;
  }
}

/**
 * The last word on a sanitized answer: nothing in what is kept, nor in a call that may run, holds a secret. A call
 * marked `secret` isn't run, but its input is checked too, so nothing of the key reaches the history through it.
 */
function checked(r: { assistant: unknown; text: string; calls: ToolCall[]; left: number }, s: Scrub) {
  if (holdsAny(r.assistant, s) || s.holds(r.text)) throw new SecretInAnswer('the answer');
  if (r.calls.some((c) => holdsAny(c, s))) throw new SecretInAnswer('a tool call');
  return r;
}

/** A refused request's fixed kind, and the provider's own words (bounded; the caller redacts the key). */
async function refused(res: Response, provider: string): Promise<WireError> {
  let message = '';
  try {
    const text = (await res.text()).slice(0, 4000);
    const body = obj(JSON.parse(text));
    const e = obj(body?.error);
    message = typeof e?.message === 'string' ? e.message : '';
    const code = typeof e?.code === 'string' ? e.code : typeof e?.type === 'string' ? e.type : '';
    if (code) message = `${code}: ${message}`;
  } catch {}
  const s = res.status;
  const words = message.slice(0, 300) || `HTTP ${s}`;
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) * 1000 : null;
  const quota = /insufficient_quota|credit balance|billing|spend limit|quota/i.test(message);
  const kind: WireErrorKind =
    s === 401 ? 'auth' : s === 403 ? 'forbidden' : s === 404 ? 'not_found' : s === 429 ? (quota ? 'quota' : 'rate_limited') : s === 529 || /overloaded/i.test(message) ? 'overloaded' : s >= 500 ? 'server' : quota ? 'quota' : 'bad_request';
  return new WireError(kind, `${provider} answered ${s}: ${words}`, { status: s, retryAfterMs });
}

async function post(url: string, headers: Record<string, string>, body: Record<string, unknown>, provider: string, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    // Never follows a redirect: the key header would go with it.
    res = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), redirect: 'manual', signal });
  } catch (err) {
    if (signal.aborted) throw err;
    // No answer at all: the request may or may not have reached it, and been billed.
    const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    // Never connected (refused, no such host): it didn't reach the provider, so nothing was billed.
    if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(code)) throw new WireError('network', `could not reach ${provider} (${code})`, { sent: false });
    throw new WireError('network', `no answer from ${provider} (${code}); the request may or may not have reached it`, { sent: true });
  }
  if (res.status !== 200) {
    const e = res.status >= 300 && res.status < 400 ? new WireError('bad_request', `${provider} answered with a redirect (${res.status}), which is not followed`, { status: res.status }) : await refused(res, provider);
    await res.body?.cancel().catch(() => {});
    throw e;
  }
  if (!res.body) throw new WireError('stream', `${provider} sent an empty answer`, { sent: true });
  return res;
}

// ------------------------------------------------------------------ Anthropic

const ANTHROPIC_VERSION = '2026-10-21';

/** Reasoning blocks the Messages API binds to the conversation that made them. */
const THINKING = new Set(['thinking', 'redacted_thinking']);

function anthropicContent(items: WireItem[]): { role: 'user' | 'assistant'; content: unknown[] }[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', content: unknown[]) => {
    if (!content.length) return;
    const last = out.at(-1);
    // Consecutive messages of a role are one turn: kept as one, tool results first as the API wants.
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content: [...content] });
  };
  for (const it of items) {
    if (it.kind === 'user') {
      push('user', [
        ...(it.data.images ?? []).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
        { type: 'text', text: it.data.text || '(empty)' },
      ]);
    } else if (it.kind === 'tools') {
      push(
        'user',
        it.data.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text || '(no output)', ...(r.isError ? { is_error: true } : {}) })),
      );
    } else {
      const m = obj(it.data);
      if (Array.isArray(m?.content)) push('assistant', m.content as unknown[]);
    }
  }
  return out;
}


/**
 * Anthropic's usage, as its stream reports it: message_start carries input_tokens and output_tokens (required) and the
 * cache counts (documented as nullable); each message_delta carries output_tokens (required, cumulative) and may carry
 * the others again (cumulative too, so never lower). cache_creation splits the writes by lifetime and must add up to
 * cache_creation_input_tokens; a 1-hour write (Botons asks for none) or a server tool use has no rate here. Any of
 * that wrong, or no final delta: unknown.
 */
class AnthropicUsage {
  #u: WireUsage | null = null;
  #final = false;
  #bad = false;

  #cache(x: Record<string, unknown>, u: WireUsage) {
    const breakdown = obj(x.cache_creation);
    if (x.cache_creation !== undefined && x.cache_creation !== null && !breakdown) this.#bad = true;
    if (breakdown) {
      const m5 = count(breakdown.ephemeral_5m_input_tokens, true);
      const h1 = count(breakdown.ephemeral_1h_input_tokens, true);
      if (m5 === BAD || h1 === BAD || h1 > 0 || m5 + h1 !== u.cacheWrite) this.#bad = true;
    }
    const tools = obj(x.server_tool_use);
    if (tools && Object.values(tools).some((v) => v !== 0 && v !== null)) this.#bad = true;
  }

  start(raw: unknown) {
    const x = obj(raw);
    if (!x || this.#u) {
      this.#bad = true;
      return;
    }
    const input = count(x.input_tokens, false);
    const output = count(x.output_tokens, false);
    const cacheRead = count(x.cache_read_input_tokens, true);
    const cacheWrite = count(x.cache_creation_input_tokens, true);
    if (input === BAD || output === BAD || cacheRead === BAD || cacheWrite === BAD) {
      this.#bad = true;
      return;
    }
    this.#u = { input, output, cacheRead, cacheWrite };
    this.#cache(x, this.#u);
  }

  delta(raw: unknown) {
    const x = obj(raw);
    if (!x || !this.#u) {
      this.#bad = true;
      return;
    }
    const u = this.#u;
    const output = count(x.output_tokens, false);
    if (output === BAD || output < u.output) this.#bad = true;
    else u.output = output;
    for (const [field, k] of [
      ['input_tokens', 'input'],
      ['cache_read_input_tokens', 'cacheRead'],
      ['cache_creation_input_tokens', 'cacheWrite'],
    ] as const) {
      if (x[field] === undefined || x[field] === null) continue;
      const v = count(x[field], false);
      if (v === BAD || v < u[k]) this.#bad = true;
      else u[k] = v;
    }
    this.#cache(x, u);
    this.#final = true;
  }

  value(): WireUsage | null {
    return this.#bad || !this.#final || !this.#u ? null : { ...this.#u };
  }
}

export const anthropicWire: Wire = {
  provider: 'anthropic',
  id: 'anthropic-api',
  label: 'Claude (Anthropic API key)',
  prefix: 'anthropic',
  defaultModel: 'claude-opus-5-5',
  // Thinking counts in max_tokens; xhigh and max need room for it.
  maxOutput: (effort) => (effort === 'xhigh' || effort === 'max' ? 64_000 : 32_000),
  body({ model, effort, system, items, tools, maxOutput, noCalls }) {
    return {
      model,
      max_tokens: maxOutput,
      system,
      messages: anthropicContent(items),
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })), tool_choice: { type: noCalls ? 'none' : 'auto' } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // Caches the conversation so far for the next request (the provider's automatic placement).
      cache_control: { type: 'ephemeral' },
      stream: true,
    };
  },
  async send(body, o) {
    const res = await post(`${o.origin}/v1/messages`, { 'x-api-key': o.key, 'anthropic-version': ANTHROPIC_VERSION }, body, 'Anthropic', o.signal);
    const blocks: Record<string, unknown>[] = [];
    const json = new Map<number, string>();
    let id: string | null = null;
    let model: string | null = null;
    const usage = new AnthropicUsage();
    let stop: string | null = null;
    let stopDetail: string | null = null;
    let done = false;
    let text = '';
    try {
      for await (const ev of sseEvents(res.body!, { maxBytes: MAX_STREAM, maxEvent: MAX_EVENT, idleMs: o.idleMs, signal: o.signal })) {
        let d: Record<string, unknown> | null;
        try {
          d = obj(JSON.parse(ev.data));
        } catch {
          continue;
        }
        if (!d) continue;
        const type = d.type;
        if (type === 'message_start') {
          const m = obj(d.message);
          id = typeof m?.id === 'string' ? m.id : null;
          model = typeof m?.model === 'string' ? m.model : null;
          usage.start(m?.usage);
        } else if (type === 'content_block_start') {
          const i = num(d.index) || 0;
          const block = { ...(obj(d.content_block) ?? { type: 'unknown' }) };
          if (block.type === 'tool_use') json.set(i, '');
          if (block.type === 'text') o.onActivity('Writing');
          if (block.type === 'thinking') o.onActivity('Thinking');
          blocks[i] = block;
        } else if (type === 'content_block_delta') {
          const i = num(d.index) || 0;
          const delta = obj(d.delta);
          const block = blocks[i];
          if (!block || !delta) continue;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = String(block.text ?? '') + delta.text;
            text += delta.text;
            o.onText(text);
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking = String(block.thinking ?? '') + delta.thinking;
          else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = String(block.signature ?? '') + delta.signature;
          else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') json.set(i, (json.get(i) ?? '') + delta.partial_json);
          else if (delta.type === 'citations_delta' && delta.citation) block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
        } else if (type === 'message_delta') {
          const delta = obj(d.delta);
          if (typeof delta?.stop_reason === 'string') stop = delta.stop_reason;
          const details = obj(delta?.stop_details);
          if (details) stopDetail = [details.category, details.explanation].filter((x) => typeof x === 'string').join(': ') || null;
          usage.delta(d.usage);
        } else if (type === 'message_stop') done = true;
        else if (type === 'error') {
          const e = obj(d.error);
          const words = typeof e?.message === 'string' ? e.message.slice(0, 300) : 'error';
          const kind: WireErrorKind = e?.type === 'overloaded_error' ? 'overloaded' : e?.type === 'rate_limit_error' ? 'rate_limited' : 'server';
          throw new WireError(kind, `Anthropic stopped its answer: ${words}`, { sent: true });
        }
      }
    } catch (err) {
      if (err instanceof WireError) throw err;
      if (o.signal.aborted) throw err;
      throw new WireError('stream', `Anthropic's answer broke off (${err instanceof StreamError ? err.message : (err as Error).message})`, { sent: true });
    }
    if (!done) throw new WireError('stream', 'Anthropic’s answer ended before it was complete', { sent: true });
    const calls: ToolCall[] = [];
    for (const [i, raw] of json) {
      const block = blocks[i];
      if (!block) continue;
      let input: unknown = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        input = null;
      }
      block.input = input && typeof input === 'object' ? input : {};
      calls.push({ id: String(block.id ?? ''), name: String(block.name ?? ''), input });
    }
    // An empty text block can't be sent back.
    const content = blocks.filter((b) => b && !(b.type === 'text' && !b.text));
    const finalText = content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
    return {
      text: finalText,
      calls,
      stop: stop === 'end_turn' || stop === 'stop_sequence' ? 'end' : stop === 'tool_use' ? 'tools' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : stop === 'pause_turn' ? 'paused' : 'other',
      stopDetail: stop === 'end_turn' || stop === 'tool_use' ? null : [stop, stopDetail].filter(Boolean).join(': ') || null,
      assistant: { id, role: 'assistant', content },
      usage: usage.value(),
      model,
    };
  },
  stripReasoning(assistant) {
    const m = obj(assistant);
    const content = Array.isArray(m?.content) ? (m.content as Record<string, unknown>[]).filter((b) => !THINKING.has(String(b?.type))) : [];
    return content.length ? { ...m, content } : null;
  },
  sanitize(assistant, s, sent) {
    const m = obj(assistant) ?? {};
    const rest = { ...m, content: undefined };
    if (holdsAny(rest, s)) throw new SecretInAnswer('the answer’s own fields');
    const calls: ToolCall[] = [];
    const content: Record<string, unknown>[] = [];
    let left = 0;
    for (const raw of Array.isArray(m.content) ? (m.content as unknown[]) : []) {
      const b = obj(raw);
      if (!b) continue;
      if (THINKING.has(String(b.type))) {
        // Signed: changed, it would be refused; it goes whole instead.
        if (holdsAny(b, s)) left++;
        else content.push(b);
      } else if (b.type === 'text') {
        const out: Record<string, unknown> = { ...b, text: typeof b.text === 'string' ? s.redact(b.text) : b.text };
        if (holdsAny(out.citations, s)) {
          delete out.citations;
          left++;
        }
        if (holdsAny({ ...out, text: undefined }, s)) throw new SecretInAnswer('a text block');
        content.push(out);
      } else if (b.type === 'tool_use') {
        if (holdsAny(b.id, s) || holdsAny(b.name, s) || holdsAny({ ...b, input: undefined, id: undefined, name: undefined }, s)) throw new SecretInAnswer('a tool call’s id or name');
        const r = redactDeep(b.input, s);
        content.push(r.changed ? { ...b, input: r.value } : b);
        // Input that wasn't JSON stays so (the block keeps {} in its place): such a call isn't run.
        const invalid = sent?.some((c) => c.id === b.id && c.input === null);
        calls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: invalid ? null : (r.value ?? null), ...(r.changed ? { secret: true } : {}) });
      } else if (holdsAny(b, s)) throw new SecretInAnswer(`a ${String(b.type).slice(0, 40)} block`);
      else content.push(b);
    }
    const text = content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
    return checked({ assistant: { ...m, content }, text, calls, left }, s);
  },
  reasoningRefused: (err) => err.kind === 'bad_request' && /thinking/i.test(err.message) && /signature|bound|block/i.test(err.message),
  adjust: () => null,
};

// ------------------------------------------------------------------ OpenAI

function openaiInput(items: WireItem[]): unknown[] {
  const out: unknown[] = [];
  for (const it of items) {
    if (it.kind === 'user') {
      out.push({
        role: 'user',
        content: [...(it.data.images ?? []).map((img) => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}` })), { type: 'input_text', text: it.data.text || '(empty)' }],
      });
    } else if (it.kind === 'tools') {
      for (const r of it.data.results) out.push({ type: 'function_call_output', call_id: r.id, output: r.text || '(no output)' });
    } else if (Array.isArray(it.data)) out.push(...it.data);
  }
  return out;
}


/**
 * OpenAI's usage, as the Responses API documents it: input_tokens (cached ones included), input_tokens_details.
 * cached_tokens, output_tokens, output_tokens_details.reasoning_tokens and total_tokens, all required; cache writes
 * (input_tokens_details.cache_write_tokens) only where reported. Every counter a whole number from 0 up, the total
 * their sum, the cached within the input and the reasoning within the output; anything else: unknown.
 */
export function openaiUsage(raw: unknown): WireUsage | null {
  const x = obj(raw);
  const din = obj(x?.input_tokens_details);
  const dout = obj(x?.output_tokens_details);
  if (!x || !din || !dout) return null;
  const input = count(x.input_tokens, false);
  const output = count(x.output_tokens, false);
  const total = count(x.total_tokens, false);
  const cached = count(din.cached_tokens, false);
  const written = count(din.cache_write_tokens, true);
  const reasoning = count(dout.reasoning_tokens, false);
  if (input === BAD || output === BAD || total === BAD || cached === BAD || written === BAD || reasoning === BAD) return null;
  if (total !== input + output || cached + written > input || reasoning > output) return null;
  return { input: input - cached - written, output, cacheRead: cached, cacheWrite: written };
}

export const openaiWire: Wire = {
  provider: 'openai',
  id: 'openai-api',
  label: 'OpenAI (API key)',
  prefix: 'openai',
  defaultModel: 'gpt-6-astra',
  maxOutput: () => 32_000,
  body({ model, effort, system, items, tools, maxOutput, noCalls }) {
    return {
      model,
      instructions: system,
      input: openaiInput(items),
      ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false })), tool_choice: noCalls ? 'none' : 'auto', ...(noCalls ? {} : { parallel_tool_calls: true }) } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: maxOutput,
      // The conversation is Botons'; reasoning comes back encrypted so it can be passed back.
      store: false,
      include: ['reasoning.encrypted_content'],
      stream: true,
    };
  },
  async send(body, o) {
    const res = await post(`${o.origin}/v1/responses`, { authorization: `Bearer ${o.key}` }, body, 'OpenAI', o.signal);
    let text = '';
    let final: Record<string, unknown> | null = null;
    const done: unknown[] = [];
    let finals = 0;
    try {
      for await (const ev of sseEvents(res.body!, { maxBytes: MAX_STREAM, maxEvent: MAX_EVENT, idleMs: o.idleMs, signal: o.signal })) {
        let d: Record<string, unknown> | null;
        try {
          d = obj(JSON.parse(ev.data));
        } catch {
          continue;
        }
        if (!d) continue;
        const type = String(d.type ?? ev.event);
        if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
          text += d.delta;
          o.onActivity('Writing');
          o.onText(text);
        } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.output_item.added') {
          if (obj(d.item)?.type === 'reasoning' || type.startsWith('response.reasoning')) o.onActivity('Thinking');
        } else if (type === 'response.output_item.done' && d.item) done.push(d.item);
        else if (type === 'response.completed' || type === 'response.incomplete') {
          // A second final answer: which one holds is unknown, so its usage is too.
          finals++;
          final ??= obj(d.response);
        }
        else if (type === 'response.failed') {
          const r = obj(d.response);
          const e = obj(r?.error);
          throw new WireError('server', `OpenAI could not answer: ${[e?.code, e?.message].filter((x) => typeof x === 'string').join(': ').slice(0, 300) || 'failed'}`, { sent: true });
        } else if (type === 'error') {
          const words = [d.code, d.message].filter((x) => typeof x === 'string').join(': ').slice(0, 300) || 'error';
          throw new WireError(/rate/i.test(words) ? 'rate_limited' : 'server', `OpenAI stopped its answer: ${words}`, { sent: true });
        }
      }
    } catch (err) {
      if (err instanceof WireError) throw err;
      if (o.signal.aborted) throw err;
      throw new WireError('stream', `OpenAI's answer broke off (${err instanceof StreamError ? err.message : (err as Error).message})`, { sent: true });
    }
    if (!final) throw new WireError('stream', 'OpenAI’s answer ended before it was complete', { sent: true });
    const output = Array.isArray(final.output) ? (final.output as unknown[]) : done;
    const calls: ToolCall[] = [];
    let finalText = '';
    for (const raw of output) {
      const item = obj(raw);
      if (item?.type === 'function_call') {
        let input: unknown = null;
        try {
          input = JSON.parse(String(item.arguments ?? '{}'));
        } catch {}
        calls.push({ id: String(item.call_id ?? ''), name: String(item.name ?? ''), input });
      } else if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content as Record<string, unknown>[]) if (c?.type === 'output_text' && typeof c.text === 'string') finalText += c.text;
      }
    }
    const incomplete = obj(final.incomplete_details);
    const reason = typeof incomplete?.reason === 'string' ? incomplete.reason : null;
    const status = final.status;
    const stop: WireRound['stop'] = calls.length ? 'tools' : status === 'completed' ? 'end' : reason === 'max_output_tokens' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : 'other';
    return {
      text: finalText,
      calls,
      stop,
      stopDetail: status === 'completed' ? null : [status, reason].filter((x) => typeof x === 'string').join(': ') || null,
      assistant: output,
      usage: finals === 1 ? openaiUsage(final.usage) : null,
      model: typeof final.model === 'string' ? final.model : null,
    };
  },
  stripReasoning(assistant) {
    const items = Array.isArray(assistant) ? assistant.filter((i) => obj(i)?.type !== 'reasoning') : [];
    return items.length ? items : null;
  },
  sanitize(assistant, s) {
    const calls: ToolCall[] = [];
    const out: unknown[] = [];
    let left = 0;
    let text = '';
    for (const raw of Array.isArray(assistant) ? assistant : []) {
      const item = obj(raw);
      if (!item) continue;
      if (item.type === 'reasoning') {
        // Encrypted, its summary with it: changed, it would be refused; it goes whole instead.
        if (holdsAny(item, s)) left++;
        else out.push(item);
      } else if (item.type === 'message') {
        if (holdsAny({ ...item, content: undefined }, s)) throw new SecretInAnswer('a message’s own fields');
        const content: unknown[] = [];
        for (const rc of Array.isArray(item.content) ? (item.content as unknown[]) : []) {
          const c = obj(rc);
          if (!c) continue;
          const field = c.type === 'output_text' ? 'text' : c.type === 'refusal' ? 'refusal' : null;
          if (!field) {
            if (holdsAny(c, s)) throw new SecretInAnswer(`${String(c.type).slice(0, 40)} content`);
            content.push(c);
            continue;
          }
          const next: Record<string, unknown> = { ...c, [field]: typeof c[field] === 'string' ? s.redact(c[field] as string) : c[field] };
          if (holdsAny(next.annotations, s)) {
            next.annotations = [];
            left++;
          }
          if (holdsAny({ ...next, [field]: undefined }, s)) throw new SecretInAnswer('message content');
          if (c.type === 'output_text' && typeof next.text === 'string') text += next.text;
          content.push(next);
        }
        out.push({ ...item, content });
      } else if (item.type === 'function_call') {
        if (holdsAny({ ...item, arguments: undefined }, s)) throw new SecretInAnswer('a tool call’s id or name');
        let input: unknown = null;
        try {
          input = JSON.parse(String(item.arguments ?? '{}'));
        } catch {}
        const r = redactDeep(input, s);
        let args = item.arguments;
        let secret = r.changed;
        if (r.changed) args = JSON.stringify(r.value);
        else if (input === null && typeof args === 'string' && s.holds(args)) {
          // Not JSON, so not run anyway: what it held goes.
          args = '{}';
          secret = true;
        }
        out.push(args === item.arguments ? item : { ...item, arguments: args });
        calls.push({ id: String(item.call_id ?? ''), name: String(item.name ?? ''), input: r.value ?? null, ...(secret ? { secret: true } : {}) });
      } else if (holdsAny(item, s)) throw new SecretInAnswer(`a ${String(item.type).slice(0, 40)} item`);
      else out.push(item);
    }
    return checked({ assistant: out, text, calls, left }, s);
  },
  reasoningRefused: (err) => err.kind === 'bad_request' && /reasoning/i.test(err.message) && /item/i.test(err.message) && !/include/i.test(err.message),
  // A model without reasoning may refuse to be asked for its encrypted reasoning.
  adjust: (body, err) => (err.kind === 'bad_request' && body.include && /include|encrypted[ _]content/i.test(err.message) ? { ...body, include: undefined } : null),
};
