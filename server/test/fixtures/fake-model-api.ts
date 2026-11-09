import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { freePort } from '../helpers.ts';

/*
 * A loopback stand-in for the Anthropic Messages API (POST /v1/messages) and the OpenAI Responses API
 * (POST /v1/responses), streaming the event shapes their docs give. Each request takes the next scripted step (or, with
 * none left, answers "Done."); a step may also be a function of the request. Every request is recorded with its headers.
 */

export interface FakeCall {
  name: string;
  input: unknown;
}

export interface FakeStep {
  text?: string;
  calls?: FakeCall[];
  /** An HTTP error instead of an answer. */
  status?: number;
  error?: { type?: string; code?: string; message: string };
  /** Start the answer, then drop the connection. */
  cut?: boolean;
  /** Never answer (until the client goes away). */
  hang?: boolean;
  /** Stop reason (Anthropic's words; mapped for OpenAI). */
  stop?: 'end_turn' | 'max_tokens' | 'refusal';
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** Anthropic: a thinking block (with a signature) before the rest. */
  thinking?: boolean;
  /** Anthropic: the thinking block's text (signed, so it can't be changed). */
  thinkingText?: string;
  /** OpenAI: the reasoning item's summary text. */
  summary?: string;
  model?: string;
  /** The usage objects exactly as sent (Anthropic: message_start's and message_delta's; OpenAI: the response's). */
  rawUsage?: { start?: unknown; delta?: unknown; response?: unknown };
  /** OpenAI: send the final event this many times (each with the usage given). */
  finals?: unknown[];
  /** Anthropic: the message id; OpenAI: the function calls' call_id (for an id that holds a secret). */
  id?: string;
}

export interface Recorded {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

export interface FakeModelApi {
  origin: string;
  requests: Recorded[];
  queue(...steps: (FakeStep | ((req: Recorded) => FakeStep))[]): void;
  close(): Promise<void>;
}

const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function fakeModelApi(): Promise<FakeModelApi> {
  const steps: (FakeStep | ((req: Recorded) => FakeStep))[] = [];
  const requests: Recorded[] = [];
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {}
    const rec: Recorded = { path: req.url ?? '', headers: req.headers, body };
    requests.push(rec);
    const next = steps.shift() ?? { text: 'Done.' };
    const step = typeof next === 'function' ? next(rec) : next;
    n++;
    if (step.hang) {
      req.on('close', () => res.destroy());
      return;
    }
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rec.path.startsWith('/v1/messages') ? { type: 'error', error: { type: step.error?.type ?? 'api_error', message: step.error?.message ?? 'error' } } : { error: { message: step.error?.message ?? 'error', type: step.error?.type ?? 'server_error', code: step.error?.code ?? null } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    if (rec.path.startsWith('/v1/messages')) anthropic(res, step, body, n);
    else if (rec.path.startsWith('/v1/responses')) openai(res, step, body, n);
    else res.end();
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    queue: (...s) => steps.push(...s),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function anthropic(res: ServerResponse, step: FakeStep, body: Record<string, any>, n: number) {
  const u = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, ...step.usage };
  const model = step.model ?? body.model;
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: step.id ?? `msg_${n}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: step.rawUsage && 'start' in step.rawUsage ? step.rawUsage.start : { input_tokens: u.input, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite, output_tokens: 1 },
    },
  });
  if (step.cut) {
    res.destroy();
    return;
  }
  let i = 0;
  if (step.thinking) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: step.thinkingText ?? '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: `sig-${n}` } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    i++;
  }
  if (step.text) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    for (const part of step.text.match(/.{1,12}/gs) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: part } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    i++;
  }
  for (const [k, c] of (step.calls ?? []).entries()) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${n}_${k}`, name: c.name, input: {} } });
    const json = JSON.stringify(c.input);
    for (const part of json.match(/.{1,20}/gs) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: part } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    i++;
  }
  res.write(': ping\n\n');
  const stop = step.calls?.length ? 'tool_use' : (step.stop ?? 'end_turn');
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: step.rawUsage && 'delta' in step.rawUsage ? step.rawUsage.delta : { output_tokens: u.output } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function openai(res: ServerResponse, step: FakeStep, body: Record<string, any>, n: number) {
  const u = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, ...step.usage };
  const model = step.model ?? body.model;
  sse(res, 'response.created', { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress', model, output: [] } });
  if (step.cut) {
    res.destroy();
    return;
  }
  const output: Record<string, unknown>[] = [];
  output.push({ type: 'reasoning', id: `rs_${n}`, summary: step.summary ? [{ type: 'summary_text', text: step.summary }] : [], encrypted_content: `enc-${n}` });
  sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: output[0] });
  if (step.text) {
    const item = { type: 'message', id: `msg_${n}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: output.length, item: { ...item, content: [] } });
    for (const part of step.text.match(/.{1,12}/gs) ?? []) sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: output.length, content_index: 0, delta: part });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: output.length, item });
    output.push(item);
  }
  for (const [k, c] of (step.calls ?? []).entries()) {
    const item = { type: 'function_call', id: `fc_${n}_${k}`, call_id: step.id ?? `call_${n}_${k}`, name: c.name, arguments: JSON.stringify(c.input), status: 'completed' };
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: output.length, item: { ...item, arguments: '' } });
    sse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: output.length, delta: item.arguments });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: output.length, item });
    output.push(item);
  }
  const incomplete = !step.calls?.length && step.stop === 'max_tokens';
  const refusal = !step.calls?.length && step.stop === 'refusal';
  const input = u.input + u.cacheRead + u.cacheWrite;
  const usage =
    step.rawUsage && 'response' in step.rawUsage
      ? step.rawUsage.response
      : { input_tokens: input, input_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite }, output_tokens: u.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + u.output };
  const done = incomplete || refusal ? 'response.incomplete' : 'response.completed';
  for (const each of step.finals ?? [usage]) {
    sse(res, done, {
      type: done,
      response: { id: `resp_${n}`, status: incomplete || refusal ? 'incomplete' : 'completed', model, output, usage: each, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : refusal ? { reason: 'content_filter' } : null },
    });
  }
  res.end();
}
