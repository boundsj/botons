import { setTimeout as wait } from 'node:timers/promises';
import { type Provider, ProviderError, type ProviderStatus, step, type TurnRequest, type TurnResult } from './types.ts';

/**
 * For tests (BOTONS_ENABLE_MOCK=1): replies "Echo: <input>". Triggers in the input: FAIL_PLEASE, SLOW_PLEASE[:ms],
 * QUIET_PLEASE[:note], STEP_PLEASE:[<n>x]<command>, STREAM_PLEASE[:ms].
 */
export class MockProvider implements Provider {
  id = 'mock';
  label = 'Mock (tests)';
  askFirst = true;
  turns: TurnRequest[] = [];
  /** A string is the turn's reply; null leaves the turn to the triggers. */
  script: ((req: TurnRequest) => Promise<string | null> | string | null) | null = null;
  #failures = new Map<string, Error[]>();

  /** The Boton's next turns throw these errors, one per turn. */
  failNext(botId: string, ...errors: Error[]): void {
    this.#failures.set(botId, [...(this.#failures.get(botId) ?? []), ...errors]);
  }

  async info(): Promise<ProviderStatus> {
    return this.snapshot();
  }

  snapshot(): ProviderStatus {
    return {
      id: this.id,
      label: this.label,
      kind: 'api',
      available: true,
      reason: null,
      installed: true,
      version: null,
      loggedIn: true,
      checkedAt: new Date().toISOString(),
      models: [{ id: '', label: 'Echo' }],
      defaultModel: '',
      askFirst: true,
    };
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.turns.push(req);
    const fail = this.#failures.get(req.env.BOTON_BOT_ID ?? '')?.shift();
    if (fail) throw fail;
    req.onActivity('Thinking');
    const started = Date.now();
    const scripted = this.script ? await this.script(req) : null;
    if (scripted !== null) return { sessionId: req.sessionId ?? `mock-${this.turns.length}`, text: scripted };
    // Only this turn's input, not the context block or a replayed transcript.
    const body = req.prompt.split('</boton_context>').pop()!.trim();
    for (const m of body.matchAll(/STEP_PLEASE:(?:(\d+)x)?([^\n]+)/g)) {
      const command = m[2].trim();
      for (let i = 0; i < Number(m[1] ?? 1); i++) {
        req.onActivity(`Running \`${command}\``);
        req.onStep?.(step('command', `Running \`${command.slice(0, 70)}\``, command));
      }
    }
    const slow = /SLOW_PLEASE(?::(\d+))?/.exec(body);
    await work(slow ? Number(slow[1] ?? 30_000) : 50, req, started);
    if (req.prompt.includes('FAIL_PLEASE')) throw new Error('Mock failure requested');
    const quiet = /QUIET_PLEASE(?::([^\n]*))?/.exec(body);
    const text = quiet ? `[quiet]${quiet[1] ? ` ${quiet[1].trim()}` : ''}` : `Echo: ${body.slice(0, 500)}`;
    const stream = /STREAM_PLEASE(?::(\d+))?/.exec(body);
    if (stream) {
      const words = text.split(/(?<=\s)/);
      for (let i = 1; i <= words.length; i++) {
        req.onText?.(words.slice(0, i).join(''));
        await work(Number(stream[1] ?? 40), req, started);
      }
    }
    const usage = { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(text.length / 4), cacheReadTokens: 0, cacheWriteTokens: 0, model: req.model || 'mock-echo' };
    return { sessionId: req.sessionId ?? `mock-${this.turns.length}`, text, usage };
  }
}

/**
 * Waits `ms` as a CLI turn would run, ending it as runJsonl does: stopped by `req.signal`, or timed out at
 * `req.timeoutMs` from `started`, whichever comes first.
 */
async function work(ms: number, req: TurnRequest, started: number): Promise<void> {
  const left = started + req.timeoutMs - Date.now();
  await sleep(Math.min(ms, Math.max(0, left)), req.signal);
  if (req.signal.aborted) throw new Error('Stopped.');
  if (ms >= left) {
    const err = new ProviderError('Mock timed out.', false);
    err.exit = { exitCode: null, signal: 'SIGTERM', timedOut: true, stderrTail: '' };
    throw err;
  }
}

/** Wait `ms`, or less if `signal` aborts first. */
const sleep = (ms: number, signal: AbortSignal) => wait(ms, undefined, { signal }).catch(() => {});
