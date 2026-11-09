import { sandboxProblem, resetSandboxChecks } from '../sandbox.ts';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ModelEfforts } from '../../../shared/effort.ts';
import type { ApiKeyProvider } from '../../../shared/types.ts';
import { type ApiKeys, keyFilter, redactKey } from '../api-keys.ts';
import { log } from '../log.ts';
import { costOf, type ModelRate, RATE_SOURCES, rateFor, round } from '../rates.ts';
import { CapError, type Reservation, type Spending } from '../spend.ts';
import { shorten } from '../util.ts';
import { fitRequest, type History, type HistoryItem, type HistoryStore } from './api-history.ts';
import { type ToolCall, type ToolOutcome, Toolset, toolsKey } from './api-tools.ts';
import { type Scrub, SecretInAnswer, type ToolResults, type UserInput, type Wire, WireError, type WireItem, type WireRound } from './api-wire.ts';
import type { FailureKind } from './failures.ts';
import { type Provider, ProviderError, type ProviderStatus, type TurnRequest, type TurnResult, type TurnUsage } from './types.ts';

/*
 * A Boton's brain on the owner's own Anthropic or OpenAI API key: Botons runs the agent loop itself. Each turn sends
 * the conversation (kept by the server, bounded to fit) with the turn's tools; runs the tool calls the answer asks for
 * (api-tools.ts: in the OS sandbox for Workspace access); sends their results back; and stops when the model answers
 * without one, or at a bound: MAX_ROUNDS requests, MAX_CALLS calls an answer, PARALLEL at a time, REQUEST_MAX_BYTES a
 * request, the turn's time limit, a stop, or a spending cap.
 *
 * Nothing is sent to the provider twice by Botons, and no turn is run again after a tool did something: a failure after
 * that is not "transient", so the engine doesn't retry the turn (its tools would run twice). Every request is reserved
 * under the caps as they are just before it goes (spend.ts).
 *
 * The key: a turn uses the one in use when it starts (saved, or the environment's), and only that one. Before each
 * request, in the same synchronous step as its reservation and send, the key in use is compared with it (the key, where
 * it came from, and its generation); if it was removed or replaced, or the saved one went and the environment's took its
 * place, the turn stops there with nothing more sent. A request already on its way finishes. Every text that comes back
 * (the model's, a tool's, the provider's errors, the drafts) has every key Botons holds at that moment taken out (the
 * turn's own and any saved since), and so does everything the history keeps (api-wire.ts's sanitize() for the model's
 * answers); a request body is checked last of all and is never sent while it holds one.
 */

export const MAX_ROUNDS = 40;
export const MAX_CALLS = 16;
export const PARALLEL = 4;
/**
 * The most a request's JSON body may be, in bytes, exactly as it is sent: its instructions, tool definitions,
 * conversation and the images this turn attached (as base64). A bound on what Botons sends, not a model's context
 * window: a model may take less, and then the provider refuses the request.
 */
export const REQUEST_MAX_BYTES = 600_000;
/** What a request's framing adds to an item, at most, over its own JSON. */
const ITEM_FRAMING = 128;
/** No silence from the provider longer than this, mid-answer. */
const IDLE_MS = 180_000;
/** The least output a request is worth sending with, when a cap lowers it. */
const MIN_OUTPUT = 1024;
/** The tokens a request carries that its JSON doesn't show (the provider's tool-use prompt and message framing). */
const HIDDEN_TOKENS = 4096;
const MAX_IMAGE = 5 * 1024 * 1024;
/** What the wire adds around an image's base64 in a request (its type, media type and the JSON around them). */
const IMAGE_FRAMING = 256;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export interface ApiBrainDeps {
  keys: ApiKeys;
  history: HistoryStore;
  spending: Spending;
  /** BOTONS_OAUTH_ALLOW: what connector requests may reach. */
  allow: string[];
}

class Stopped extends Error {}
class TimedOut extends Error {}
class KeyChanged extends Error {}
/** Not sent: the request couldn't be made to fit, or would have carried a key. */
class NotSent extends Error {}

type Credential = { key: string; source: 'saved' | 'environment'; generation: number };

export class ApiBrainProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly askFirst = false;
  readonly toolFree = true;
  readonly serverTools = true;
  #wire: Wire;
  #deps: ApiBrainDeps;
  #filters = new Map<string, (t: string) => boolean>();

  constructor(wire: Wire, deps: ApiBrainDeps) {
    this.#wire = wire;
    this.#deps = deps;
    this.id = wire.id;
    this.label = wire.label;
  }

  get #p(): ApiKeyProvider {
    return this.#wire.provider;
  }

  recheck(): void { resetSandboxChecks(); }

  async info(): Promise<ProviderStatus> {
    return this.snapshot();
  }

  snapshot(): ProviderStatus {
    try {
      return this.#info();
    } catch (err) {
      // The keys live in the database: when it can't be read, that is the database's failure, said once there.
      log.debug('could not read the API key state', { provider: this.id, err });
      const reason = 'Botons could not read its API keys from the database.';
      return { id: this.id, label: this.label, kind: 'api', available: false, reason, installed: true, version: null, loggedIn: null, checkedAt: null, models: [], defaultModel: this.#wire.defaultModel, askFirst: false };
    }
  }

  #info(): ProviderStatus {
    const keys = this.#deps.keys;
    const state = keys.state(this.#p);
    const has = state.source !== 'none';
    const listed = keys.models(this.#p);
    const testedOk = keys.testedAt(this.#p);
    const models = listed.length
      ? listed.filter((m) => m.lifecycle !== 'retired').map((m) => ({ id: m.id, label: m.displayName ?? m.id, ...(m.effort ? { efforts: m.effort } : {}) }))
      : [{ id: this.#wire.defaultModel, label: this.#wire.defaultModel }];
    return {
      id: this.id,
      label: this.label,
      kind: 'api',
      workspaceProblem: sandboxProblem(undefined, { quiet: true }) ? (process.platform === 'linux' ? 'Not available on this server: the API tools sandbox could not start.' : 'Not available on this server: the API tools sandbox needs Linux. Choose Full computer access for a Boton you trust.') : null,
      available: has,
      reason: has ? null : `No ${state.label} API key: save one in Settings → API keys (or set ${state.envVar} in the server's environment).`,
      installed: true,
      version: null,
      loggedIn: has ? (testedOk ? true : null) : false,
      checkedAt: testedOk,
      models,
      defaultModel: this.#wire.defaultModel,
      askFirst: false,
    };
  }

  modelEfforts(model: string): ModelEfforts | null {
    const m = this.#deps.keys.models(this.#p).find((x) => x.id === (model || this.#wire.defaultModel));
    return m?.effort ? { model: m.id, label: m.displayName ?? m.id, levels: m.effort } : null;
  }

  /** Only Botons' own connectors reach here (connectors.resolve); each must speak MCP over HTTP or stdio. */
  fitMcpServers(servers: Parameters<NonNullable<Provider['fitMcpServers']>>[0]) {
    return { servers, skipped: [] };
  }

  /** Every key Botons holds now, and the turn's own: what is taken out of all that comes back. */
  #scrub(own: string): Scrub {
    const filter = (k: string) => {
      let f = this.#filters.get(k);
      if (!f) {
        if (this.#filters.size > 16) this.#filters.clear();
        f = keyFilter(k);
        this.#filters.set(k, f);
      }
      return f;
    };
    const keys = () => {
      try {
        return [...new Set([own, ...this.#deps.keys.knownKeys()])];
      } catch {
        return [own];
      }
    };
    return {
      holds: (t) => !!t && keys().some((k) => filter(k)(t)),
      redact: (t) => keys().reduce((out, k) => (filter(k)(out) ? redactKey(out, k) : out), t),
    };
  }

  /** The history's items with every key known now out of them, in place (so the turn's own input stays the same item). */
  #clean(history: History, scrub: Scrub) {
    const kept: HistoryItem[] = [];
    for (const it of history.items) {
      if (it.kind === 'user') {
        const d = it.data as { text?: unknown };
        if (typeof d?.text === 'string' && scrub.holds(d.text)) it.data = { ...d, text: scrub.redact(d.text) };
      } else if (it.kind === 'tools') {
        const d = it.data as ToolResults;
        if (Array.isArray(d?.results) && d.results.some((r) => scrub.holds(r.text))) it.data = { ...d, results: d.results.map((r) => ({ ...r, text: scrub.redact(r.text) })) };
      } else if (scrub.holds(JSON.stringify(it.data))) {
        try {
          const clean = this.#wire.sanitize(it.data, scrub);
          it.data = clean.assistant;
        } catch {
          // A kept answer that can't be cleaned goes, and the tool results that answered it with it.
          const i = history.items.indexOf(it);
          const next = history.items[i + 1];
          if (next?.kind === 'tools') next.data = { results: [] };
          continue;
        }
      }
      kept.push(it);
    }
    history.items = kept.filter((it) => !(it.kind === 'tools' && !(it.data as ToolResults).results?.length));
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const keys = this.#deps.keys;
    const cred: Credential | null = keys.keyFor(this.#p);
    if (!cred) throw new ProviderError(`There is no ${keys.state(this.#p).label} API key: save one in Settings → API keys.`, false, { kind: 'auth' });
    // Spending is counted for every request; a turn with nothing to count it against isn't run.
    if (!req.spend) throw new ProviderError(`${this.label} can't run a turn without its spending account.`, false, { kind: 'other' });
    const scope = req.spend;
    const sameKey = () => {
      const now = keys.keyFor(this.#p);
      return !!now && now.key === cred.key && now.source === cred.source && now.generation === cred.generation;
    };
    const scrub = this.#scrub(cred.key);
    const redact = scrub.redact;
    const model = req.model || this.#wire.defaultModel;
    const effort = req.effort ?? '';
    const started = Date.now();
    const deadline = started + req.timeoutMs;
    const rate = rateFor(this.#p, model);

    let history: History;
    let sessionId = req.sessionId;
    if (sessionId) {
      const loaded = this.#deps.history.load(sessionId, this.id);
      if (!loaded) throw new ProviderError(`${this.label}: the session ${sessionId} is gone`, true);
      history = loaded;
      this.#clean(history, scrub);
    } else {
      sessionId = this.#deps.history.newId(this.#wire.prefix);
      history = { v: 1, provider: this.id, toolsKey: null, model: null, items: [] };
    }

    const images = this.#images(req.images ?? []);
    const prompt = redact(req.prompt);
    const user: UserInput = { text: prompt, ...(images.length ? { images } : {}) };
    // The new input, and what the history keeps of it (a note in place of each image).
    const inHistory: HistoryItem = { kind: 'user', data: { text: images.length ? `${prompt}\n\n[${images.length} image${images.length > 1 ? 's' : ''} were attached here]` : prompt } };
    history.items.push(inHistory);

    let tools: Toolset;
    try {
      tools = await Toolset.open({ req, botonCli: req.botonCli ?? null, allow: this.#deps.allow, redact });
    } catch (err) {
      throw new ProviderError(`${this.label} can't run this Boton's tools: ${redact((err as Error).message)}`, false, { kind: 'other' });
    }

    const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model };
    const cost = { committed: 0, held: 0 };
    let rounds = 0;
    let sent = 0;
    let acted = false;
    let usedTools = false;
    let lastText = '';
    let strippedOnce = false;
    const warnings: string[] = [];
    const usageNow = (): TurnUsage => {
      const out: TurnUsage = { ...usage, numTurns: rounds };
      if (rate) {
        out.costUsd = round(cost.committed + cost.held);
        out.costBasis = 'estimate';
        if (cost.held > 0) out.costHeldUsd = round(cost.held);
      }
      return out;
    };
    const save = () => {
      try {
        this.#clean(history, scrub);
        this.#deps.history.save(sessionId!, history);
      } catch (err) {
        log.warn('could not save an API session', { provider: this.id, err });
      }
    };
    const fail = (message: string, kind: FailureKind, o: { retryAt?: Date | null; timedOut?: boolean } = {}): ProviderError => {
      // A provider error after a tool did something is never "transient": running the turn again would run it twice.
      const safeKind = acted && kind === 'transient' ? 'other' : kind;
      const err = new ProviderError(redact(message) + (acted && kind === 'transient' ? ' The turn had already run tools, so it is not tried again.' : ''), false, { kind: safeKind, retryAt: o.retryAt ?? null });
      if (o.timedOut) err.exit = { exitCode: null, signal: null, timedOut: true, stderrTail: '' };
      err.usage = usageNow();
      err.mcpStartup = tools.startup;
      return err;
    };
    const account = (r: Reservation, round: WireRound | null) => {
      // Billed by what it reported; with no valid report, held at its most.
      if (round?.usage && rate) {
        const usd = costOf(rate, { inputTokens: round.usage.input, outputTokens: round.usage.output, cacheReadTokens: round.usage.cacheRead, cacheWriteTokens: round.usage.cacheWrite });
        r.settle(usd);
        cost.committed = round_(cost.committed + usd);
      } else {
        r.settle(null);
        if (r.usd !== null) cost.held = round_(cost.held + r.usd);
      }
      if (round?.usage) {
        usage.inputTokens += round.usage.input;
        usage.outputTokens += round.usage.output;
        usage.cacheReadTokens += round.usage.cacheRead;
        usage.cacheWriteTokens += round.usage.cacheWrite;
      }
      if (round?.model) usage.model = round.model;
    };

    try {
      for (;;) {
        if (req.signal.aborted) throw new Stopped('Stopped.');
        if (Date.now() >= deadline) throw fail(`${this.label} timed out.`, 'other', { timedOut: true });
        if (rounds >= MAX_ROUNDS) {
          warnings.push(`stopped after ${MAX_ROUNDS} requests to the model`);
          lastText = `${lastText ? `${lastText}\n\n` : ''}(Botons stopped this turn after ${MAX_ROUNDS} requests to the model: what was done so far stands.)`;
          break;
        }
        rounds++;
        const specs = tools.specs;
        const key = toolsKey(specs);
        // Reasoning is bound to the conversation and tools it was made under: when those change, it goes.
        if (history.toolsKey && history.toolsKey !== key) this.#strip(history);
        history.toolsKey = key;
        let round: WireRound;
        try {
          round = await this.#round({ req, model, effort, history, inHistory, user, specs, rate, scope, cred, sameKey, scrub, deadline, account, onSent: () => sent++ });
        } catch (err) {
          // Reasoning the provider won't take under this history (it changed since): without it, once.
          if (err instanceof WireError && !strippedOnce && this.#wire.reasoningRefused(err)) {
            strippedOnce = true;
            this.#strip(history);
            rounds--;
            continue;
          }
          throw err;
        }
        if (round.assistant) history.items.push({ kind: 'assistant', data: round.assistant });
        history.model = round.model ?? model;
        lastText = redact(round.text);
        // A reply only: a call it asks for anyway is never run.
        if (round.stop === 'tools' && round.calls.length && req.toolFree) {
          history.items.pop();
          warnings.push('it asked for a tool in a turn that has none');
          break;
        }
        if (round.stop === 'tools' && round.calls.length) {
          usedTools = true;
          const results = await this.#runCalls(round.calls, tools, req, deadline, () => (acted = true));
          history.items.push({ kind: 'tools', data: { results: results.map((r) => ({ ...r, text: redact(r.text) })) } });
          continue;
        }
        if (round.stop === 'max_tokens') warnings.push('the answer was cut at its length limit');
        if (round.stop === 'refusal') lastText = lastText || `(${this.label} declined to answer${round.stopDetail ? `: ${redact(round.stopDetail)}` : ''}.)`;
        else if (round.stop === 'paused') {
          // The provider paused a long answer of its own; it carries on when sent back as it is.
          continue;
        } else if (round.stop === 'other' && round.stopDetail) warnings.push(`the answer ended: ${redact(round.stopDetail)}`);
        if (round.stop === 'max_tokens' && !lastText) lastText = '(The answer was cut short: at its length limit, or to stay within a spending cap.)';
        break;
      }
    } catch (err) {
      save();
      tools.close();
      if (err instanceof ProviderError) throw err;
      if (err instanceof Stopped || req.signal.aborted) throw Object.assign(new ProviderError('Stopped.', false), { usage: usageNow(), mcpStartup: tools.startup });
      if (err instanceof TimedOut) throw fail(`${this.label} timed out.`, 'other', { timedOut: true });
      const stands = acted ? ' What it did before that stands.' : '';
      if (err instanceof CapError) throw fail(sent ? `Stopped by the spending cap: ${err.message}${stands}` : `Not run (spending cap): ${err.message}`, 'other');
      if (err instanceof KeyChanged)
        throw fail(`The ${keys.state(this.#p).label} API key changed while this turn ran (removed or replaced in Settings → API keys), so it stopped before its next request.${stands} The next turn uses the key in use then.`, 'auth');
      if (err instanceof NotSent) throw fail(`${err.message}${stands}`, 'other');
      if (err instanceof SecretInAnswer) throw fail(`${this.label}'s answer held an API key in ${err.message}, which Botons can't take out without breaking it, so none of that answer was kept and the turn stopped.${stands}`, 'other');
      if (err instanceof WireError) throw fail(this.#describe(err), this.#kind(err), { retryAt: err.kind === 'quota' ? new Date(Date.now() + (err.retryAfterMs ?? 30 * 60_000)) : null });
      throw fail(`${this.label} failed: ${shorten((err as Error).message, 300)}`, 'other');
    }
    save();
    tools.close();
    const what: ('chat' | 'tools' | 'vision')[] = ['chat', ...(usedTools ? (['tools'] as const) : []), ...(images.length ? (['vision'] as const) : [])];
    try {
      keys.observe(this.#p, cred, usage.model ?? model, what);
    } catch (err) {
      log.debug('could not note what a turn showed of its model', { provider: this.id, err });
    }
    log.info('api turn', { provider: this.id, model: usage.model ?? model, rounds, toolsUsed: usedTools, priced: !!rate, rates: rate ? RATE_SOURCES[this.#p].checked : undefined });
    return { sessionId, text: lastText, usage: usageNow(), mcpStartup: tools.startup, ...(warnings.length ? { warnings } : {}) };
  }

  /** The history as sent, with this turn's images in its own input (the history keeps notes in their place). */
  #withImages(items: HistoryItem[], inHistory: HistoryItem, user: UserInput): WireItem[] {
    return items.map((it) => (it === inHistory ? { kind: 'user', data: user } : (it as WireItem)));
  }

  #strip(history: History) {
    history.items = history.items.flatMap((it) => {
      if (it.kind !== 'assistant') return [it];
      const kept = this.#wire.stripReasoning(it.data);
      return kept ? [{ ...it, data: kept }] : [];
    });
  }

  /**
   * One request: fitted to REQUEST_MAX_BYTES (or not sent), checked for keys (or not sent), reserved under the caps
   * as they are now and sent with the turn's key, in one synchronous step after the key is checked; sent once (or
   * once more, reserved again, when the provider refused it before generating anything and says what it takes).
   */
  async #round(o: {
    req: TurnRequest;
    model: string;
    effort: string;
    history: History;
    inHistory: HistoryItem;
    user: UserInput;
    specs: Toolset['specs'];
    rate: ModelRate | null;
    scope: NonNullable<TurnRequest['spend']>;
    cred: Credential;
    sameKey: () => boolean;
    scrub: Scrub;
    deadline: number;
    account: (r: Reservation, round: WireRound | null) => void;
    onSent: () => void;
  }): Promise<WireRound> {
    const { req, history, scrub } = o;
    const noCalls = !!req.toolFree;
    const system = scrub.redact(req.systemPrompt);
    const build = (items: WireItem[], maxOutput: number) => this.#wire.body({ model: o.model, effort: o.effort, system, items, tools: o.specs, maxOutput, noCalls });
    const maxOutput = this.#wire.maxOutput(o.effort);
    const bytes = (b: unknown) => Buffer.byteLength(JSON.stringify(b));

    // The bound: the whole request, this turn's images included (they go in every request of the turn), and the
    // conversation fitted to what is left of it.
    const images = o.history.items.includes(o.inHistory) ? (o.user.images ?? []) : [];
    const imageBytes = images.reduce((n, img) => n + img.base64.length + IMAGE_FRAMING, 0);
    const fixed = bytes(build([], maxOutput)) + imageBytes;
    const fit = fitRequest(
      history.items.map((it) => it),
      REQUEST_MAX_BYTES - ITEM_FRAMING * history.items.length,
      fixed,
    );
    if (!fit.ok) {
      const kb = (n: number) => `${Math.ceil(n / 1024)} KB`;
      throw new NotSent(
        fit.why === 'input' && imageBytes
          ? `Not sent: this message, with its ${images.length > 1 ? `${images.length} images` : 'image'} (${kb(imageBytes)} as sent) and the Boton's instructions and tools, is ${kb(fit.over)} more than the ${kb(REQUEST_MAX_BYTES)} Botons sends to the model at once, images included. Attach fewer or smaller images, or put them in the workspace and ask about the files instead.`
          : fit.why === 'input'
          ? `Not sent: this message, with the Boton's instructions and tools, is ${kb(fit.over)} more than the ${kb(REQUEST_MAX_BYTES)} Botons sends to the model at once. Put the long text in a file in the workspace and ask about the file instead.`
          : `Stopped before its next request: this turn's conversation has grown past the ${kb(REQUEST_MAX_BYTES)} Botons sends to the model at once, even with older messages and earlier tool output left out.`,
      );
    }
    if (fit.trimmed || fit.compacted) {
      history.items = fit.items;
      if (fit.trimmed) this.#strip(history);
    }
    // Last: no request goes with a key in it (one saved since the history was cleaned, too).
    let plain = build(history.items as WireItem[], maxOutput);
    if (scrub.holds(JSON.stringify(plain))) {
      this.#clean(history, scrub);
      plain = build(history.items as WireItem[], maxOutput);
      if (scrub.holds(JSON.stringify(plain))) throw new NotSent('Not sent: the request would have held an API key (in the Boton’s instructions, or in the conversation where Botons can’t take it out). Take the key out of what the Boton keeps, then try again.');
    }
    if (bytes(plain) > REQUEST_MAX_BYTES) throw new NotSent(`Stopped before its next request: this turn's conversation has grown past the ${Math.ceil(REQUEST_MAX_BYTES / 1024)} KB Botons sends to the model at once.`);

    // Its text with every key known now out of it, as the history's.
    const items = this.#withImages(history.items, o.inHistory, { ...o.user, text: scrub.redact(o.user.text) });
    const timeout = AbortSignal.timeout(Math.max(1, o.deadline - Date.now()));
    const signal = AbortSignal.any([req.signal, timeout]);

    // What is checked of the body that goes: all of it but the images' base64, which is checked as the bytes it holds.
    const data = new Set(images.map((img) => img.base64));
    const withoutImages = (body: Record<string, unknown>) => JSON.stringify(body, (_k, v) => (typeof v === 'string' && data.has(v) ? '' : v));
    /** The body exactly as it would go, within the bound and holding no key known now; else nothing is reserved or sent. */
    const check = (body: Record<string, unknown>) => {
      const imagesHold = images.some((img) => scrub.holds(Buffer.from(img.base64, 'base64').toString('latin1')));
      const size = bytes(body);
      if (size > REQUEST_MAX_BYTES)
        throw new NotSent(
          `Not sent: the request${imageBytes ? `, with this message's ${images.length > 1 ? 'images' : 'image'},` : ''} is ${Math.ceil(size / 1024)} KB, more than the ${Math.ceil(REQUEST_MAX_BYTES / 1024)} KB Botons sends to the model at once${imageBytes ? ', images included. Attach fewer or smaller images' : ''}.`,
        );
      if (scrub.holds(withoutImages(body)) || imagesHold) throw new NotSent('Not sent: the request would have held an API key (in the Boton’s instructions, the conversation or an attached image). Take the key out, then try again.');
    };

    /** Check, reserve, then send at once: nothing in between can change the key, the body or the account. */
    const go = (body: Record<string, unknown>): { r: Reservation; answer: Promise<WireRound> } => {
      check(body);
      if (!o.sameKey()) throw new KeyChanged();
      // At most one token per byte of what is sent, plus what the provider adds.
      const inputTokens = bytes(body) + HIDDEN_TOKENS;
      const field = 'max_tokens' in body ? 'max_tokens' : 'max_output_tokens';
      const r = this.#deps.spending.reserve(o.scope, { provider: this.id, model: o.model, rate: o.rate, inputTokens, maxOutput: Number(body[field]), minOutput: MIN_OUTPUT });
      let send = body;
      try {
        // Lowered to fit a cap: the same body with the smaller output cap (no longer, so the reservation still holds).
        if (r.maxOutput < Number(body[field])) send = { ...body, [field]: r.maxOutput };
        if (bytes(send) > bytes(body)) throw new NotSent('Not sent: the request grew when its output cap was lowered.');
        const answer = this.#wire.send(send, {
          origin: this.#deps.keys.origin(this.#p),
          key: o.cred.key,
          signal,
          onText: (t) => req.onText?.(scrub.redact(t)),
          onActivity: req.onActivity,
          idleMs: IDLE_MS,
        });
        o.onSent();
        return { r, answer };
      } catch (err) {
        r.release();
        throw err;
      }
    };
    const answered = async (body: Record<string, unknown>): Promise<WireRound> => {
      const { r, answer } = go(body);
      let round: WireRound;
      try {
        round = await answer;
      } catch (err) {
        // Refused with an error status before anything was generated: nothing billed. Anything else may have been.
        if (err instanceof WireError && !err.sent) r.release();
        else o.account(r, null);
        throw err;
      }
      o.account(r, round);
      return round;
    };
    try {
      const body = build(items, maxOutput);
      let round: WireRound;
      try {
        round = await answered(body);
      } catch (err) {
        // Refused before anything was generated: a body the provider takes instead, sent once.
        const again = err instanceof WireError && !err.sent ? this.#wire.adjust(body, err) : null;
        if (!again) throw err;
        round = await answered(again);
      }
      // Nothing of the answer is kept or shown with a key in it (SecretInAnswer when it can't be taken out).
      const clean = this.#wire.sanitize(round.assistant, scrub, round.calls);
      return { ...round, assistant: clean.assistant, text: clean.text, calls: clean.calls, stopDetail: round.stopDetail ? scrub.redact(round.stopDetail) : null };
    } catch (err) {
      if (timeout.aborted && !req.signal.aborted) throw new TimedOut();
      if (req.signal.aborted) throw new Stopped('Stopped.');
      throw err;
    }
  }

  async #runCalls(calls: ToolCall[], tools: Toolset, req: TurnRequest, deadline: number, onActed: () => void): Promise<{ id: string; name: string; text: string; isError: boolean }[]> {
    const results: { id: string; name: string; text: string; isError: boolean }[] = new Array(calls.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= calls.length) return;
        const call = calls[i];
        if (i >= MAX_CALLS) {
          results[i] = { id: call.id, name: call.name, text: `Not run: at most ${MAX_CALLS} tool calls an answer.`, isError: true };
          continue;
        }
        if (req.signal.aborted) {
          results[i] = { id: call.id, name: call.name, text: 'Not run: the turn was stopped.', isError: true };
          continue;
        }
        const d = tools.describe(call);
        req.onActivity(d.activity);
        try {
          req.onStep?.(d.step);
        } catch {}
        let out: ToolOutcome;
        if (call.secret) out = { text: 'Not run: its input held an API key, which Botons keeps out of every tool.', isError: true, acted: false };
        else if (call.input === null) out = { text: 'The tool input was not valid JSON.', isError: true, acted: false };
        else out = await tools.run(call, req.signal, deadline, req.onToolResult);
        if (out.acted) onActed();
        results[i] = { id: call.id, name: call.name, text: out.text, isError: out.isError };
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, calls.length) }, worker));
    return results;
  }

  #images(paths: string[]): { mediaType: string; base64: string }[] {
    const out: { mediaType: string; base64: string }[] = [];
    for (const p of paths) {
      const type = IMAGE_TYPES[extname(p).toLowerCase()];
      try {
        if (!type || statSync(p).size > MAX_IMAGE) continue;
        out.push({ mediaType: type, base64: readFileSync(p).toString('base64') });
      } catch {}
    }
    return out;
  }

  #describe(err: WireError): string {
    switch (err.kind) {
      case 'auth':
        return `The ${this.#deps.keys.state(this.#p).label} API refused the key (401): check it in Settings → API keys.`;
      case 'forbidden':
        return `The ${this.#deps.keys.state(this.#p).label} API refused this request (403): the key may not use this model. ${err.message}`;
      case 'not_found':
        return `The ${this.#deps.keys.state(this.#p).label} API doesn't know this model for the key (404). ${err.message}`;
      default:
        return err.message;
    }
  }

  /** Transient only when trying the turn again can't repeat anything (fail() makes sure of that). */
  #kind(err: WireError): FailureKind {
    switch (err.kind) {
      case 'auth':
        return 'auth';
      case 'quota':
        return 'usage_limit';
      case 'network':
      case 'stream':
      case 'overloaded':
      case 'server':
      case 'rate_limited':
        return 'transient';
      default:
        return 'other';
    }
  }
}

const round_ = round;
