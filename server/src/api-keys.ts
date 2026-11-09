import type { DatabaseSync } from 'node:sqlite';
import type {
  ApiKeyProvider,
  ApiKeySource,
  ApiKeyState,
  ApiKeysView,
  ApiKeyTest,
  ApiKeyTestOutcome,
  ApiModel,
  ApiModelCapabilities,
  ApiModelObservation,
  CapabilityEvidence,
  RemoveApiKeyInput,
  SaveApiKeyInput,
} from '../../shared/types.ts';
import type { EventHub } from './events.ts';
import { log } from './log.ts';
import { HttpError } from './store.ts';
import { nowIso, parseJson } from './util.ts';

/*
 * The owner's own Anthropic and OpenAI API keys. A saved key is kept in the database (the settings table, as the
 * ntfy token is, beside the OAuth tokens), so it is in every backup and Workspace Botons can't read it; the server
 * environment's ANTHROPIC_API_KEY or OPENAI_API_KEY is used only when none is saved. No key ever leaves here: the API
 * answers with whether there is one, where it comes from and fixed test results; logs, events and the audit log get
 * the provider and fixed words. Agent CLIs never see either (providers/process.ts passes only its allowlist).
 *
 * Each save or removal bumps the provider's generation, which a removal keeps (the row stays, keyless). A change
 * must name the generation the page saw, so a stale page can't overwrite a newer key, and a test is saved only if
 * the key is still the one it started with: a late answer about an old key never reads as a result for the new one.
 *
 * A test lists the key's models, read-only, from the provider's fixed HTTPS address: no prompt, no generation. Only
 * the models' ids, plain display names, lifecycle and the capability fields the list has are kept, each in its
 * expected shape; a model whose id could hold the key is left out. Nothing else the provider says is kept.
 *
 * Botons runs Botons on these keys (providers/api-brain.ts) with its own tool loop, sandbox and spending caps: the
 * key goes only into the request headers of the providers' fixed addresses, never into a tool's environment, a tool's
 * output, argv, the log or an event. What real turns showed a model doing (a reply, a tool call, an image read) is kept
 * per key as evidence; nothing is ever sent just to find out.
 */

export const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = ['anthropic', 'openai'];

const INFO: Record<ApiKeyProvider, { label: string; envVar: string; origin: string; test: string }> = {
  anthropic: {
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    origin: 'https://api.anthropic.com',
    test: 'Test key asks api.anthropic.com for the list of models this key can use (GET /v1/models). It sends no prompt and generates no text, so it uses no tokens.',
  },
  openai: {
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    origin: 'https://api.openai.com',
    test: 'Test key asks api.openai.com for the list of models this key can use (GET /v1/models). It sends no prompt and generates no text, so it uses no tokens.',
  },
};

export const API_BRAIN: Record<ApiKeyProvider, string> = { anthropic: 'anthropic-api', openai: 'openai-api' };

/** Tests per provider per minute. */
export const API_KEY_TEST_LIMIT = 6;
const TEST_WINDOW_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;
/** The most of a model list's answer read, per page. */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_MODELS = 500;
const ANTHROPIC_PAGES = 3;
const ANTHROPIC_VERSION = '2023-06-01';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 .()_+-]{0,79}$/;
const KEY_TEXT = /^[\x21-\x7e]{20,512}$/;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const UNKNOWN: ApiModelCapabilities = { chat: 'unknown', tools: 'unknown', vision: 'unknown', realtimeVoice: 'unknown', speechToText: 'unknown', textToSpeech: 'unknown' };

/** What one provider's row in the settings table holds. The key is the only secret. */
interface Stored {
  key: string | null;
  generation: number;
  savedAt: string | null;
  /** A test of the saved key at `generation`. */
  test: ApiKeyTest | null;
  /** What this key's turns showed, by model (cleared with the key). */
  observed?: Record<string, Omit<ApiModelObservation, 'model'>>;
}

const rowKey = (p: ApiKeyProvider) => `apiKey:${p}`;

function isProvider(v: string): v is ApiKeyProvider {
  return (API_KEY_PROVIDERS as readonly string[]).includes(v);
}

/** The provider named in a path, or 404. */
export function apiKeyProvider(v: string): ApiKeyProvider {
  if (!isProvider(v)) throw new HttpError(404, 'No such API key provider: use anthropic or openai');
  return v;
}

function generationOf(input: unknown): number {
  const g = (input as { generation?: unknown } | null)?.generation;
  if (typeof g !== 'number' || !Number.isSafeInteger(g) || g < 0) throw new HttpError(400, 'generation must be the whole number the page last saw');
  return g;
}

/** A pasted key, checked for shape only; errors never repeat it. */
function keyOf(p: ApiKeyProvider, input: unknown): string {
  const raw = (input as { key?: unknown } | null)?.key;
  if (typeof raw !== 'string') throw new HttpError(400, 'key must be the API key, as text');
  const key = raw.trim();
  if (!KEY_TEXT.test(key)) throw new HttpError(400, 'That is not an API key: one is 20 to 512 characters with no spaces');
  if (p === 'anthropic') {
    if (key.startsWith('sk-ant-admin')) throw new HttpError(400, "That is an Anthropic Admin API key, which can't use models. Create a regular API key in the Claude Console.");
    if (!key.startsWith('sk-ant-')) throw new HttpError(400, 'An Anthropic API key starts with sk-ant-');
  } else {
    if (key.startsWith('sk-ant-')) throw new HttpError(400, 'That is an Anthropic key: save it as the Anthropic key');
    if (key.startsWith('sk-admin-')) throw new HttpError(400, "That is an OpenAI admin key, which can't use models. Create a project API key.");
    if (!key.startsWith('sk-')) throw new HttpError(400, 'An OpenAI API key starts with sk-');
  }
  return key;
}

function outcomeOf(status: number): ApiKeyTestOutcome {
  if (status === 401) return 'invalid';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'unavailable';
  return 'unexpected';
}

const evidence = (v: unknown): CapabilityEvidence => {
  const s = v && typeof v === 'object' ? (v as { supported?: unknown }).supported : undefined;
  return s === true ? 'yes' : s === false ? 'no' : 'unknown';
};

/**
 * Reject raw, case-folded, hex, base64 and URL-encoded key echoes, including prefixed fragments. Display text is
 * never used to authorize a request. This catches common reflections, not every transformation an adversary could
 * invent; unrecognized provider text is omitted independently by the model-list schema.
 */
function secretFilter(key: string): (text: string) => boolean {
  const variants = [key, Buffer.from(key).toString('hex'), Buffer.from(key).toString('base64'), Buffer.from(key).toString('base64url'), encodeURIComponent(key)];
  const fragments = new Set<string>();
  const short: string[] = [];
  for (const variant of variants) {
    const v = variant.toLowerCase();
    if (v.length < 8) {
      if (v) short.push(v);
      continue;
    }
    for (let i = 0; i <= v.length - 8; i++) fragments.add(v.slice(i, i + 8));
  }
  return (text) => {
    const lower = text.toLowerCase();
    if (short.some((v) => lower.includes(v))) return true;
    for (let i = 0; i <= lower.length - 8; i++) if (fragments.has(lower.slice(i, i + 8))) return true;
    return false;
  };
}

const mayHold = (text: string, key: string) => secretFilter(key)(text);

/** Whether `text` may hold `key` or a fragment of it (what redactKey() takes out). */
export function keyFilter(key: string): (text: string) => boolean {
  return secretFilter(key);
}

/**
 * `text` with the key, and the common encodings of it secretFilter() knows, replaced: for anything a provider or a tool
 * says that goes on to the model, the chat, the log or an error.
 */
export function redactKey(text: string, key: string): string {
  if (!text) return text;
  let out = text;
  for (const v of [key, Buffer.from(key).toString('hex'), Buffer.from(key).toString('base64'), Buffer.from(key).toString('base64url'), encodeURIComponent(key)]) {
    if (v.length >= 8) out = out.split(v).join('[redacted]');
  }
  // A fragment of it (16 characters or more) that survived, case-folded or not.
  const holds = secretFilter(key);
  if (holds(out)) out = out.replace(/[\x21-\x7e]{8,}/g, (word) => (holds(word) ? '[redacted]' : word));
  return out;
}

interface Listing {
  outcome: ApiKeyTestOutcome;
  httpStatus: number | null;
  models: ApiModel[];
  omitted: number;
  truncated: boolean;
}

class Unexpected extends Error {}

/** The answer's JSON, at most MAX_BODY bytes of it; anything else is Unexpected. */
async function readJson(res: Response): Promise<unknown> {
  if (!res.body) throw new Unexpected();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new Unexpected();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Unexpected();
  }
}

/** Models from one page of a list, in their expected shape; the rest are counted, not kept. */
function modelsFrom(p: ApiKeyProvider, data: unknown[], key: string, into: Map<string, ApiModel>): number {
  let omitted = 0;
  const holdsSecret = secretFilter(key);
  for (const item of data) {
    const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const id = m?.id;
    if (typeof id !== 'string' || !MODEL_ID.test(id) || holdsSecret(id) || into.size >= MAX_MODELS) {
      omitted++;
      continue;
    }
    if (into.has(id)) continue;
    if (p === 'openai') {
      into.set(id, { id, displayName: null, lifecycle: null, capabilities: { ...UNKNOWN }, effort: null });
      continue;
    }
    const name = m?.display_name;
    const caps = m?.capabilities && typeof m.capabilities === 'object' ? (m.capabilities as Record<string, unknown>) : null;
    const effortCap = caps?.effort && typeof caps.effort === 'object' ? (caps.effort as Record<string, unknown>) : null;
    const effortSupported = effortCap ? evidence(effortCap) : 'unknown';
    into.set(id, {
      id,
      displayName: typeof name === 'string' && DISPLAY_NAME.test(name) && !holdsSecret(name) ? name : null,
      lifecycle: m?.lifecycle === 'active' || m?.lifecycle === 'deprecated' || m?.lifecycle === 'retired' ? m.lifecycle : null,
      // The list has a field for images; chat, tools, voice and speech have none there, so they stay unknown.
      capabilities: { ...UNKNOWN, vision: caps ? evidence(caps.image_input) : 'unknown' },
      effort: effortSupported === 'yes' ? EFFORT_LEVELS.filter((l) => evidence(effortCap?.[l]) === 'yes') : effortSupported === 'no' ? [] : null,
    });
  }
  return omitted;
}

export interface ApiKeysOptions {
  db: DatabaseSync;
  hub: EventHub;
  /** Where ANTHROPIC_API_KEY and OPENAI_API_KEY are read from, once (the server's environment). */
  env: Record<string, string | undefined>;
  /**
   * Tests only: plain-HTTP loopback servers to send tests to in place of the providers' HTTPS addresses. Set in
   * code (createApp's options), never from a setting, the environment or the API; anything else is refused.
   */
  testEndpoints?: Partial<Record<ApiKeyProvider, string>>;
  timeoutMs?: number;
}

export class ApiKeys {
  #db: DatabaseSync;
  #hub: EventHub;
  #env: Record<ApiKeyProvider, string | null>;
  #origins: Record<ApiKeyProvider, string>;
  #timeoutMs: number;
  /** Tests of the environment's key, which isn't saved: they are about this process's environment only. */
  #envTests = new Map<ApiKeyProvider, ApiKeyTest>();
  /** What the environment's key's turns showed, since this process started. */
  #envObserved = new Map<ApiKeyProvider, Record<string, Omit<ApiModelObservation, 'model'>>>();
  #running = new Map<ApiKeyProvider, AbortController>();
  #recent = new Map<ApiKeyProvider, number[]>();

  constructor(opts: ApiKeysOptions) {
    this.#db = opts.db;
    this.#hub = opts.hub;
    this.#timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS;
    const fromEnv = (name: string) => {
      const v = opts.env[name]?.trim();
      return v ? v : null;
    };
    this.#env = { anthropic: fromEnv(INFO.anthropic.envVar), openai: fromEnv(INFO.openai.envVar) };
    this.#origins = { anthropic: INFO.anthropic.origin, openai: INFO.openai.origin };
    for (const [p, url] of Object.entries(opts.testEndpoints ?? {})) {
      const u = new URL(url as string);
      if (!isProvider(p) || u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.pathname !== '/' || u.search || u.username) {
        throw new Error('API key test endpoints are for tests only: a plain http:// loopback origin');
      }
      this.#origins[p] = u.origin;
    }
  }

  #stored(p: ApiKeyProvider): { raw: string | null; s: Stored } {
    const raw = (this.#db.prepare('select value from settings where key = ?').get(rowKey(p)) as { value: string } | undefined)?.value ?? null;
    const v = parseJson<Partial<Stored>>(raw ?? undefined, {});
    const generation = typeof v.generation === 'number' && Number.isSafeInteger(v.generation) && v.generation >= 0 ? v.generation : 0;
    const key = typeof v.key === 'string' && v.key ? v.key : null;
    const test = key && v.test && typeof v.test === 'object' && v.test.generation === generation ? v.test : null;
    const observed = key && v.observed && typeof v.observed === 'object' && !Array.isArray(v.observed) ? v.observed : undefined;
    return { raw, s: { key, generation, savedAt: key && typeof v.savedAt === 'string' ? v.savedAt : null, test, ...(observed ? { observed } : {}) } };
  }

  #write(p: ApiKeyProvider, s: Stored): void {
    this.#db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(rowKey(p), JSON.stringify(s));
  }

  /** The key Botons would use now, and which one it is. Never leaves this module. */
  #effective(p: ApiKeyProvider): { key: string; source: Exclude<ApiKeySource, 'none'>; generation: number } | null {
    const { s } = this.#stored(p);
    if (s.key) return { key: s.key, source: 'saved', generation: s.generation };
    const env = this.#env[p];
    return env ? { key: env, source: 'environment', generation: s.generation } : null;
  }

  state(p: ApiKeyProvider): ApiKeyState {
    const { s } = this.#stored(p);
    const environment = !!this.#env[p];
    const source: ApiKeySource = s.key ? 'saved' : environment ? 'environment' : 'none';
    const test = source === 'saved' ? s.test : source === 'environment' ? (this.#envTests.get(p) ?? null) : null;
    return {
      provider: p,
      label: INFO[p].label,
      envVar: INFO[p].envVar,
      source,
      saved: !!s.key,
      savedAt: s.savedAt,
      environment,
      generation: s.generation,
      test: test ? { ...test, current: true } : null,
      testing: this.#running.has(p),
      testDescription: INFO[p].test,
      brain: { available: source !== 'none', provider: API_BRAIN[p], reason: source === 'none' ? `Save a key (or set ${INFO[p].envVar}) to run Botons on it.` : null },
      observed: Object.entries((source === 'saved' ? s.observed : source === 'environment' ? this.#envObserved.get(p) : undefined) ?? {})
        .filter(([model]) => MODEL_ID.test(model))
        .map(([model, o]) => ({ model, ...o })),
    };
  }

  /** The key a turn uses now, and which one it is. For providers/api-brain.ts only: never sent anywhere but the provider. */
  keyFor(p: ApiKeyProvider): { key: string; source: Exclude<ApiKeySource, 'none'>; generation: number } | null {
    return this.#effective(p);
  }

  /**
   * Every key Botons holds now, of both providers, saved and from the environment: what an API brain takes out of
   * everything that comes back, so a key saved while a turn runs is redacted from it too.
   */
  knownKeys(): string[] {
    const out = new Set<string>();
    for (const p of API_KEY_PROVIDERS) {
      const { s } = this.#stored(p);
      if (s.key) out.add(s.key);
      if (this.#env[p]) out.add(this.#env[p]!);
    }
    return [...out];
  }

  /** Where requests for `p` go: its fixed HTTPS origin (a loopback one only in tests, set in code). */
  origin(p: ApiKeyProvider): string {
    return this.#origins[p];
  }

  /** The models the newest test of the key in use listed, in their expected shape; empty before a test. */
  models(p: ApiKeyProvider): ApiModel[] {
    const t = this.state(p).test;
    return t && t.outcome === 'ok' ? t.models : [];
  }

  /** The newest test of the key in use, if it listed the models. */
  testedAt(p: ApiKeyProvider): string | null {
    const t = this.state(p).test;
    return t && t.outcome === 'ok' ? t.checkedAt : null;
  }

  /**
   * A turn on `used` showed `model` doing `what`: kept only if that key is still the one in use (a removed or replaced
   * key's evidence says nothing about the new one).
   */
  observe(p: ApiKeyProvider, used: { key: string; source: ApiKeySource; generation: number }, model: string, what: ('chat' | 'tools' | 'vision')[]): void {
    if (!what.length || !MODEL_ID.test(model) || mayHold(model, used.key)) return;
    const now = this.#effective(p);
    if (!now || now.source !== used.source || now.generation !== used.generation || now.key !== used.key) return;
    const at = nowIso();
    // The first time each was seen: written only when something is new.
    const add = (all: Record<string, Omit<ApiModelObservation, 'model'>>): boolean => {
      const was = all[model] ?? {};
      const fresh = what.filter((w) => !was[w]);
      if (!fresh.length) return false;
      const keys = Object.keys(all);
      if (!all[model] && keys.length >= MAX_MODELS) delete all[keys[0]];
      all[model] = { ...was, ...Object.fromEntries(fresh.map((w) => [w, at])) };
      return true;
    };
    if (used.source === 'environment') {
      const all = this.#envObserved.get(p) ?? {};
      if (!add(all)) return;
      this.#envObserved.set(p, all);
    } else {
      const { raw, s } = this.#stored(p);
      if (raw === null) return;
      const all = { ...(s.observed ?? {}) };
      if (!add(all)) return;
      this.#db.prepare('update settings set value = ? where key = ? and value = ?').run(JSON.stringify({ ...s, observed: all }), rowKey(p), raw);
    }
    this.#changed();
  }

  view(): ApiKeysView {
    return { providers: API_KEY_PROVIDERS.map((p) => this.state(p)) };
  }

  #changed(): void {
    this.#hub.publish({ type: 'api_keys.updated', view: this.view() });
  }

  #checkGeneration(p: ApiKeyProvider, given: number, current: number): void {
    if (given !== current) throw new HttpError(409, `The ${INFO[p].label} key changed since this page loaded it. Look again, then try again.`);
  }

  /** A running test is about the key being replaced: stop it (its answer would be discarded anyway). */
  #stopTest(p: ApiKeyProvider): void {
    this.#running.get(p)?.abort();
  }

  save(p: ApiKeyProvider, input: SaveApiKeyInput): { state: ApiKeyState; replaced: boolean } {
    const key = keyOf(p, input);
    const generation = generationOf(input);
    const { s } = this.#stored(p);
    this.#checkGeneration(p, generation, s.generation);
    this.#stopTest(p);
    this.#write(p, { key, generation: s.generation + 1, savedAt: nowIso(), test: null });
    log.info('API key saved', { api: p });
    this.#changed();
    return { state: this.state(p), replaced: !!s.key };
  }

  /** Removes the saved key only; the environment's, if set, is used from then on (and the answer says so). */
  remove(p: ApiKeyProvider, input: RemoveApiKeyInput): ApiKeyState {
    const generation = generationOf(input);
    const { s } = this.#stored(p);
    if (!s.key) {
      const env = this.#env[p] ? ` The key in use comes from ${INFO[p].envVar} in the server's environment: remove it there and restart the server.` : '';
      throw new HttpError(404, `No ${INFO[p].label} key is saved.${env}`);
    }
    this.#checkGeneration(p, generation, s.generation);
    this.#stopTest(p);
    this.#write(p, { key: null, generation: s.generation + 1, savedAt: null, test: null });
    log.info('API key removed', { api: p });
    this.#changed();
    return this.state(p);
  }

  /** Lists the models of the key in use now. One at a time per provider, API_KEY_TEST_LIMIT a minute. */
  async test(p: ApiKeyProvider): Promise<ApiKeyTest> {
    const using = this.#effective(p);
    if (!using) throw new HttpError(400, `There is no ${INFO[p].label} key to test: save one, or set ${INFO[p].envVar} in the server's environment.`);
    if (this.#running.has(p)) throw new HttpError(409, `A test of the ${INFO[p].label} key is already running`);
    const now = Date.now();
    const recent = (this.#recent.get(p) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
    if (recent.length >= API_KEY_TEST_LIMIT) {
      const wait = Math.max(1, Math.ceil((TEST_WINDOW_MS - (now - recent[0])) / 1000));
      throw new HttpError(429, `At most ${API_KEY_TEST_LIMIT} tests of a key a minute: try again in ${wait} s`, { 'retry-after': String(wait) });
    }
    recent.push(now);
    this.#recent.set(p, recent);
    const controller = new AbortController();
    this.#running.set(p, controller);
    this.#changed();
    const started = Date.now();
    let listing: Listing;
    try {
      listing = await this.#list(p, using.key, controller.signal);
    } finally {
      this.#running.delete(p);
    }
    const test: ApiKeyTest = {
      provider: p,
      source: using.source,
      generation: using.generation,
      ...listing,
      checkedAt: nowIso(),
      durationMs: Date.now() - started,
      current: false,
    };
    test.current = this.#keep(p, using, test);
    log.info('API key tested', { api: p, ok: test.outcome === 'ok', status: test.httpStatus ?? undefined, durationMs: test.durationMs, current: test.current });
    this.#changed();
    return test;
  }

  /** Saves a test only if the key in use is still the one it tested; says whether it did. */
  #keep(p: ApiKeyProvider, tested: { key: string; source: ApiKeySource; generation: number }, test: ApiKeyTest): boolean {
    const now = this.#effective(p);
    if (!now || now.source !== tested.source || now.generation !== tested.generation || now.key !== tested.key) return false;
    if (tested.source === 'environment') {
      this.#envTests.set(p, test);
      return true;
    }
    const { raw, s } = this.#stored(p);
    if (raw === null) return false;
    // Only over the very row this test checked as current, in one statement.
    const r = this.#db.prepare('update settings set value = ? where key = ? and value = ?').run(JSON.stringify({ ...s, test }), rowKey(p), raw);
    return Number(r.changes) === 1;
  }

  async #list(p: ApiKeyProvider, key: string, cancel: AbortSignal): Promise<Listing> {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(this.#timeoutMs)]);
    const headers: Record<string, string> =
      p === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' } : { authorization: `Bearer ${key}`, accept: 'application/json' };
    const models = new Map<string, ApiModel>();
    let omitted = 0;
    let after: string | null = null;
    let httpStatus: number | null = null;
    try {
      for (let page = 0; page < (p === 'anthropic' ? ANTHROPIC_PAGES : 1); page++) {
        const url = p === 'anthropic' ? `${this.#origins[p]}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}` : `${this.#origins[p]}/v1/models`;
        // Never follows a redirect: the key header would go with it.
        const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
        httpStatus = res.status;
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          return { outcome: outcomeOf(res.status), httpStatus, models: [], omitted: 0, truncated: false };
        }
        const body = (await readJson(res)) as Record<string, unknown> | null;
        if (!body || typeof body !== 'object' || !Array.isArray(body.data)) throw new Unexpected();
        omitted += modelsFrom(p, body.data, key, models);
        if (p === 'openai') break;
        const last = body.last_id;
        if (body.has_more !== true) {
          after = null;
          break;
        }
        if (typeof last !== 'string' || !MODEL_ID.test(last) || mayHold(last, key)) throw new Unexpected();
        after = last;
      }
      return { outcome: 'ok', httpStatus, models: [...models.values()], omitted, truncated: after !== null };
    } catch (err) {
      if (err instanceof Unexpected) return { outcome: 'unexpected', httpStatus, models: [], omitted: 0, truncated: false };
      return { outcome: 'unreachable', httpStatus: null, models: [], omitted: 0, truncated: false };
    }
  }
}
