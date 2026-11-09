import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { redactKey } from '../src/api-keys.ts';
import { fitRequest, type HistoryItem } from '../src/providers/api-history.ts';
import { botonArgv } from '../src/providers/api-tools.ts';
import { anthropicWire, openaiWire } from '../src/providers/api-wire.ts';
import { sseEvents } from '../src/providers/sse.ts';
import { type FakeModelApi, fakeModelApi } from './fixtures/fake-model-api.ts';
import { failOnEscapedErrors, startServer } from './helpers.ts';

failOnEscapedErrors();

const KEY = 'sk-ant-fake.bob.test.0123456789.kevin';
const fakes: FakeModelApi[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

test('server-sent events: split anywhere, CRLF or LF, comments skipped, multi-line data joined; bounded', async () => {
  const text = 'event: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\n: ping\n\nevent: b\ndata: two\n\ndata: last';
  const chunks = [...text].map((c) => c);
  const got = [];
  for await (const ev of sseEvents(stream(...chunks), { maxBytes: 1e6, maxEvent: 1e6, idleMs: 1000, signal: new AbortController().signal })) got.push(ev);
  assert.deepEqual(got, [
    { event: 'a', data: '{"x":\n1}' },
    { event: 'b', data: 'two' },
    { event: 'message', data: 'last' },
  ]);
  await assert.rejects(async () => {
    for await (const _ of sseEvents(stream('data: ', 'x'.repeat(100)), { maxBytes: 50, maxEvent: 1e6, idleMs: 1000, signal: new AbortController().signal }));
  }, /larger than Botons reads/);
});

test('`botons` commands run outside the sandbox only when they are that one command, nothing else', () => {
  assert.deepEqual(botonArgv(`botons routine create --name "Morning brief" --instruction 'Say "hi"' --schedule "daily at 8:00"`), [
    'routine',
    'create',
    '--name',
    'Morning brief',
    '--instruction',
    'Say "hi"',
    '--schedule',
    'daily at 8:00',
  ]);
  assert.deepEqual(botonArgv('botons memory add It\\ works'), ['memory', 'add', 'It works']);
  assert.deepEqual(botonArgv('botons notify "a \\"quoted\\" word"'), ['notify', 'a "quoted" word']);
  for (const c of [
    'botons memory list; cat /etc/passwd',
    'botons memory list && rm -rf x',
    'botons memory list | tee x',
    'botons notify $(cat secret)',
    'botons notify "$HOME"',
    'botons notify `id`',
    'botons share > out',
    'botons memory list\ncat x',
    'botons share *.md',
    'sudo botons memory list',
    'minionx memory list',
    'botons notify "unterminated',
  ]) {
    assert.equal(botonArgv(c), null, c);
  }
});

test('the key is redacted from text, in its encodings and as a fragment', () => {
  const said = `bad key ${KEY}; hex ${Buffer.from(KEY).toString('hex')}; b64 ${Buffer.from(KEY).toString('base64')}; part ${KEY.slice(4, 28)}; fine text stays`;
  const out = redactKey(said, KEY);
  assert.ok(!out.includes(KEY) && !out.includes(KEY.slice(4, 28)) && !out.includes(Buffer.from(KEY).toString('hex')));
  assert.match(out, /fine text stays/);
});

test('history: whole exchanges from the newest back, within its budget; never the newest one dropped', () => {
  const big = 'x'.repeat(400);
  const items: HistoryItem[] = [
    { kind: 'user', data: { text: big } },
    { kind: 'assistant', data: { content: [{ type: 'thinking', signature: 's1' }, { type: 'text', text: big }] } },
    { kind: 'user', data: { text: big } },
    { kind: 'assistant', data: { content: [{ type: 'tool_use', id: 't', name: 'shell', input: {} }] } },
    { kind: 'tools', data: { results: [{ id: 't', name: 'shell', text: big, isError: false }] } },
    { kind: 'user', data: { text: 'newest' } },
  ];
  const all = fitRequest(items, 1e6, 0);
  assert.ok(all.ok && !all.trimmed && all.items.length === 6);
  const some = fitRequest(items, 1500, 0);
  assert.ok(some.ok && some.trimmed);
  assert.equal((some.items[0].data as { text: string }).text, big, 'starts at a user input');
  assert.equal(some.items.length, 4);
  const one = fitRequest(items, 100, 0);
  assert.ok(one.ok);
  assert.deepEqual(one.items, [items[5]]);
  // Reasoning goes once the start changes; text and tool calls stay.
  assert.deepEqual(anthropicWire.stripReasoning(items[1].data), { content: [{ type: 'text', text: big }] });
  assert.equal(anthropicWire.stripReasoning({ content: [{ type: 'thinking' }] }), null);
  assert.deepEqual(openaiWire.stripReasoning([{ type: 'reasoning', encrypted_content: 'e' }, { type: 'message' }]), [{ type: 'message' }]);
});

test('a reasoning block the provider refuses under a changed history: sent again without it, once; a key the model echoes is redacted', async () => {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: KEY }, testEndpoints: { anthropic: fake.origin } } } });
  const bot = await s.newBot('Kevin', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  fake.queue({ text: 'One.', thinking: true });
  await s.chat(bot.id, 'One');
  fake.queue({ status: 400, error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }, { text: `Two, and here is ${KEY}` });
  const m = await s.chat(bot.id, 'Two');
  assert.equal(m.role, 'bot');
  assert.equal(m.text, 'Two, and here is [redacted]');
  assert.equal(fake.requests.length, 3);
  assert.match(JSON.stringify(fake.requests[1].body), /sig-1/);
  assert.doesNotMatch(JSON.stringify(fake.requests[2].body), /"thinking"/, 'sent once more without the refused reasoning');
});

test('a model that won’t be asked for encrypted reasoning: the request goes again without asking, once', async () => {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const s = await startServer({ appOptions: { apiKeys: { env: { OPENAI_API_KEY: 'sk-fake.stuart.test.0123456789.dave' }, testEndpoints: { openai: fake.origin } } } });
  const bot = await s.newBot('Stuart', { provider: 'openai-api', model: 'gpt-4.1', access: 'host' });
  fake.queue({ status: 400, error: { type: 'invalid_request_error', message: 'Encrypted content is not supported with this model.', code: 'unsupported_parameter' } }, { text: 'Fine.' });
  const m = await s.chat(bot.id, 'Hi');
  assert.equal(m.text, 'Fine.');
  assert.deepEqual(fake.requests[0].body.include, ['reasoning.encrypted_content']);
  assert.equal(fake.requests[1].body.include, undefined);
});

test('the toolset’s bounds: an answer’s calls past the limit are refused, not run', async () => {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: KEY }, testEndpoints: { anthropic: fake.origin } } } });
  const bot = await s.newBot('Bob', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  fake.queue({ calls: Array.from({ length: 18 }, (_, i) => ({ name: 'shell', input: { command: `echo ${i} >> calls.txt` } })) }, { text: 'Done.' });
  await s.chat(bot.id, 'Many');
  const results = fake.requests[1].body.messages.at(-1).content.filter((b: any) => b.type === 'tool_result');
  assert.equal(results.length, 18);
  assert.equal(results.filter((r: any) => /at most 16 tool calls/.test(r.content)).length, 2);
});

test('a tool-free turn (the summary a provider move asks for): the tools are only described, and a call is never run', async () => {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: KEY }, testEndpoints: { anthropic: fake.origin } } } });
  const bot = await s.newBot('Dave', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  fake.queue({ calls: [{ name: 'shell', input: { command: 'echo earlier' } }] }, { text: 'Earlier turn.' });
  await s.chat(bot.id, 'Earlier');
  const provider = s.app.providers.get('anthropic-api')!;
  fake.queue({ calls: [{ name: 'shell', input: { command: 'echo nope > nope.txt' } }], text: 'Summary so far.' });
  const r = await provider.runTurn({
    cwd: bot.workspace,
    sessionId: s.app.store.getBot(bot.id).sessionId,
    systemPrompt: 'sys',
    spend: { botId: bot.id, turnId: 'turn_direct', runId: null, routineId: null },
    prompt: 'Summarize',
    model: 'claude-sonnet-5-5',
    access: 'workspace',
    privatePaths: [],
    env: {},
    toolFree: true,
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onActivity: () => {},
  });
  const body = fake.requests.at(-1)!.body;
  assert.deepEqual(body.tool_choice, { type: 'none' });
  assert.equal(r.text, 'Summary so far.');
  assert.equal(fake.requests.length, 3, 'no second request: the call was not run');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  assert.ok(!existsSync(join(bot.workspace, 'nope.txt')));
});
