import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Bot, Message, Routine, RoutineRun } from '../../shared/types.ts';
import { captureLogs } from '../src/log.ts';
import { sandboxProblem } from '../src/sandbox.ts';
import { type FakeModelApi, fakeModelApi, type Recorded } from './fixtures/fake-model-api.ts';
import { failOnEscapedErrors, startServer, tempDir, type TestServer, until } from './helpers.ts';

/** A folder in the repository's own node_modules/.cache, removed when the file's tests end. */
function outsideTemp(): string {
  const cache = join(import.meta.dirname, '..', '..', 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'botons-api-brain-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

failOnEscapedErrors();

const ANTHROPIC_KEY = 'sk-ant-fake.bob.test.0123456789.kevin';
const OPENAI_KEY = 'sk-fake.stuart.test.0123456789.dave';
const BRAINS = [
  { provider: 'anthropic-api', model: 'claude-sonnet-5-5', key: ANTHROPIC_KEY },
  { provider: 'openai-api', model: 'gpt-6.1-sol', key: OPENAI_KEY },
] as const;

let fake: FakeModelApi;
const fakes: FakeModelApi[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

async function server(opts: { env?: Record<string, string> } = {}): Promise<TestServer> {
  fake = await fakeModelApi();
  fakes.push(fake);
  return startServer({
    env: opts.env,
    appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY }, testEndpoints: { anthropic: fake.origin, openai: fake.origin } } },
  });
}

/** What the model was sent as the results of its tool calls, in the request's own shape. */
function toolResults(r: Recorded): string[] {
  if (r.path.startsWith('/v1/messages')) {
    return r.body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).flatMap((b: any) => (b.type === 'tool_result' ? [String(b.content)] : []));
  }
  return r.body.input.flatMap((i: any) => (i.type === 'function_call_output' ? [String(i.output)] : []));
}

const lastResult = (r: Recorded) => toolResults(r).at(-1) ?? '';

async function reply(s: TestServer, bot: Bot, text: string): Promise<Message> {
  return (await s.chat(bot.id, text)) as Message;
}

for (const brain of BRAINS) {
  test(`${brain.provider}: a chat turn runs its tool calls in the workspace and answers, the key only in its header`, async () => {
    const s = await server();
    const bot = await s.newBot('Kevin', { provider: brain.provider, model: brain.model, access: 'host' });
    fake.queue({ calls: [{ name: 'write_file', input: { path: 'notes/hello.txt', content: 'hello from the model' } }] }, { calls: [{ name: 'shell', input: { command: 'cat notes/hello.txt && echo done' } }] }, { text: 'Wrote the file.' });
    const logs = captureLogs();
    let m: Message;
    try {
      m = await reply(s, bot, 'Write a note');
    } finally {
      logs.restore();
    }
    assert.equal(m.role, 'bot', m.text);
    assert.equal(m.text, 'Wrote the file.');
    assert.equal(readFileSync(join(bot.workspace, 'notes/hello.txt'), 'utf8'), 'hello from the model');
    assert.equal(fake.requests.length, 3);
    assert.match(lastResult(fake.requests[2]), /^Exit code 0\.\nstdout:\nhello from the modeldone\n$/);
    for (const r of fake.requests) {
      if (brain.provider === 'anthropic-api') {
        assert.equal(r.path, '/v1/messages');
        assert.equal(r.headers['x-api-key'], brain.key);
        assert.equal(r.headers['anthropic-version'], '2026-10-21');
        assert.equal(r.headers.authorization, undefined);
      } else {
        assert.equal(r.path, '/v1/responses');
        assert.equal(r.headers.authorization, `Bearer ${brain.key}`);
        assert.equal(r.body.store, false);
      }
      assert.equal(r.body.model, brain.model);
      assert.equal(r.body.stream, true);
      assert.ok(!JSON.stringify(r.body).includes(brain.key), 'the key is never in a request body');
    }
    // Its tools: the native ones; the system prompt is Botons' own.
    const tools = (fake.requests[0].body.tools as any[]).map((t) => t.name);
    assert.deepEqual(tools.sort(), ['edit_file', 'read_file', 'shell', 'write_file']);
    // Usage and cost: three answers of 100 in and 20 out, at the model's rate.
    const turn = s.app.store.db.prepare('select * from turns where bot_id = ? order by started_at desc limit 1').get(bot.id) as any;
    assert.equal(turn.provider, brain.provider);
    assert.equal(turn.input_tokens, 300);
    assert.equal(turn.output_tokens, 60);
    assert.equal(turn.num_turns, 3);
    const rate = brain.provider === 'anthropic-api' ? { input: 2, output: 10 } : { input: 2, output: 10 };
    assert.equal(Math.round(turn.cost_usd * 1e8), Math.round(((300 * rate.input + 60 * rate.output) / 1e6) * 1e8));
    assert.equal(m.meta?.usage?.costBasis, 'estimate');
    const all = JSON.stringify(logs.lines);
    assert.ok(!all.includes(brain.key), 'no log line holds the key');
    // The evidence a real turn gave: chat and tools work for this model on this key.
    const state = (await s.call('GET', '/api/api-keys')).data.providers.find((p: any) => p.brain.provider === brain.provider);
    const seen = state.observed.find((o: any) => o.model === brain.model);
    assert.ok(seen?.chat && seen?.tools, JSON.stringify(state.observed));
    assert.equal(seen.vision, undefined);
    assert.equal(state.brain.available, true);
  });

  test(`${brain.provider}: the session is the server's, passed back with the model's own reasoning`, async () => {
    const s = await server();
    const bot = await s.newBot('Stuart', { provider: brain.provider, model: brain.model, access: 'host' });
    fake.queue({ text: 'First answer.', thinking: true });
    await reply(s, bot, 'One');
    fake.queue({ text: 'Second answer.' });
    const m = await reply(s, bot, 'Two');
    assert.equal(m.text, 'Second answer.');
    const second = fake.requests[1];
    const sent = JSON.stringify(second.body);
    assert.match(sent, /First answer\./);
    if (brain.provider === 'anthropic-api') assert.match(sent, /"signature":"sig-1"/, 'thinking goes back unchanged');
    else assert.match(sent, /"encrypted_content":"enc-1"/, 'reasoning goes back unchanged');
    const fresh = s.app.store.getBot(bot.id);
    assert.match(String(fresh.sessionId), brain.provider === 'anthropic-api' ? /^anthropic-/ : /^openai-/);
    const file = join(s.home, 'api-sessions', `${fresh.sessionId}.json`);
    assert.ok(existsSync(file));
    assert.ok(!readFileSync(file, 'utf8').includes(brain.key));
  });

  test(`${brain.provider}: asked in chat, it creates a routine with the Boton CLI; the schedule and the webhook run it`, async () => {
    const s = await server();
    const bot = await s.newBot('Bob', { provider: brain.provider, model: brain.model });
    if (sandboxProblem()) {
      // Workspace access with no sandbox: nothing runs, and the turn says why.
      fake.queue({ text: 'unused' });
      const m = await reply(s, bot, 'Make me a routine');
      assert.equal(m.role, 'error');
      assert.match(m.text, /bubblewrap|sandbox/);
      assert.equal(fake.requests.length, 0);
      if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
      return;
    }
    fake.queue(
      { calls: [{ name: 'shell', input: { command: `botons routine create --name "Status check" --schedule "every 30m" --instruction "Write status.txt" --webhook` } }] },
      { text: 'Made the routine.' },
    );
    const m = await reply(s, bot, 'Please make a routine that writes status.txt every 30 minutes, with a webhook');
    assert.equal(m.text, 'Made the routine.', m.text);
    assert.match(lastResult(fake.requests[0 + 1]), /Exit code 0/);
    const routines = (await s.call<Routine[]>('GET', `/api/bots/${bot.id}/routines`)).data;
    assert.equal(routines.length, 1);
    const routine = routines[0];
    assert.equal(routine.name, 'Status check');
    assert.ok(routine.webhook?.key);

    // A scheduled run: its slot comes, it writes the file in its workspace, sandboxed.
    fake.queue({ calls: [{ name: 'write_file', input: { path: 'status.txt', content: 'all good' } }] }, { text: 'Status written.' });
    s.app.store.db.prepare('update routines set next_run_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), routine.id);
    const done = await until(async () => (await s.runsOf(routine.id)).find((r: RoutineRun) => r.status === 'succeeded'), 20_000);
    assert.equal(done.trigger, 'schedule');
    assert.equal(readFileSync(join(bot.workspace, 'status.txt'), 'utf8'), 'all good');

    // A webhook delivery: its payload reaches the model; the run gets no connectors and a sandboxed token.
    fake.queue({ calls: [{ name: 'shell', input: { command: 'echo hooked > hooked.txt' } }] }, { text: 'Hook handled.' });
    const before = fake.requests.length;
    const res = await s.hook(routine, '', { body: JSON.stringify({ event: 'deploy', id: 7 }), headers: { 'content-type': 'application/json' } });
    assert.ok(res.status < 300, String(res.status));
    await until(async () => (await s.runsOf(routine.id)).filter((r: RoutineRun) => r.status === 'succeeded').length >= 2, 20_000);
    assert.match(JSON.stringify(fake.requests[before].body), /deploy/);
    assert.equal(readFileSync(join(bot.workspace, 'hooked.txt'), 'utf8'), 'hooked\n');
  });
}

test('Workspace access: the sandbox keeps the Boton in its workspace, off the network and away from secrets; Full access is the owner’s choice', async (t) => {
  const problem = sandboxProblem();
  if (problem) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${problem}`);
    t.skip(problem);
    return;
  }
  // Under /tmp nothing outside the workspace is even there (its own empty /tmp); the home folder is there, read-only.
  const outside = tempDir('botons-outside-');
  const homeTarget = join(process.env.HOME ?? '/root', `.botons-escape-test-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(homeTarget, { force: true }));
  const secretDir = tempDir('botons-secret-');
  const secret = join(secretDir, 'token.txt');
  writeFileSync(secret, 'TOP-SECRET-CANARY');
  writeFileSync(join(outside, 'keep.txt'), 'untouched');
  process.env.BOTONS_TEST_CANARY = 'ENV-CANARY-VALUE';
  const s = await server({ env: { BOTONS_PRIVATE_PATHS: secretDir } });
  const bot = await s.newBot('Dave', { provider: 'anthropic-api', model: 'claude-sonnet-5-5' });
  const other = await s.newBot('Jerry', { provider: 'mock' });
  writeFileSync(join(other.workspace, 'theirs.txt'), 'OTHER-WORKSPACE');
  const commands = [
    `echo pwned > ${homeTarget}; echo pwned > ${join(outside, 'keep.txt')}; cat ${join(outside, 'keep.txt')}`,
    `cat ${secret}`,
    `cat ${join(other.workspace, 'theirs.txt')}`,
    `cat ${s.cfg.dbPath} | head -c 100 | wc -c`,
    `ls ${join(s.home, 'api-sessions')} | wc -l`,
    `cat /proc/${process.pid}/environ | tr '\\0' '\\n' | head -3; echo pid-done`,
    `env | grep -c CANARY; env | grep -c -E '_TOKEN='; true`,
    `exec 3<>/dev/tcp/127.0.0.1/${s.port} && echo connected || echo no-network`,
    `mkdir -p .claude && echo '{}' > .claude/settings.json; echo mine > mine.txt && cat mine.txt`,
  ];
  fake.queue(
    { calls: commands.map((command) => ({ name: 'shell', input: { command } })) },
    { calls: [{ name: 'write_file', input: { path: join(outside, 'planted.txt'), content: 'x' } }, { name: 'read_file', input: { path: secret } }] },
    { text: 'Tried.' },
  );
  const m = await reply(s, bot, 'Try to get out');
  assert.equal(m.text, 'Tried.', m.text);
  const results = toolResults(fake.requests[1]);
  assert.equal(results.length, commands.length);
  const [write, readSecret, readOther, db, sessions, environ, env, net, own] = results;
  // The home folder is there, read-only, only as the path down to a tree it shows (a PATH folder, Node's install, the
  // workspace) inside it; elsewhere it isn't there at all. Either way the write fails for that reason, and no other.
  const failed = (target: string) => write.split('\n').find((l) => l.includes(target)) ?? '';
  assert.match(failed(homeTarget), /: (Read-only file system|No such file or directory)$/, write);
  assert.match(failed(join(outside, 'keep.txt')), /: (Read-only file system|No such file or directory)$/, write);
  assert.doesNotMatch(write, /pwned/);
  assert.ok(!existsSync(homeTarget), 'nothing written in the home folder');
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched');
  assert.doesNotMatch(readSecret, /TOP-SECRET-CANARY/);
  assert.doesNotMatch(readOther, /OTHER-WORKSPACE/);
  assert.match(db, /^Exit code 0\.\nstdout:\n0\n/, db);
  assert.match(sessions, /stdout:\n0\n/, sessions);
  assert.doesNotMatch(environ, /BOTONS_|BOTONS|PATH=|CANARY/);
  assert.match(env, /stdout:\n0\n0\n/, env);
  assert.match(net, /no-network/);
  assert.match(own, /Read-only file system/, 'its .claude settings folder is read-only');
  assert.match(own, /mine/, 'its workspace is writable');
  const second = toolResults(fake.requests[2]);
  assert.match(second[0], /Read-only file system|No such file|could not write|Permission denied/);
  assert.ok(!existsSync(join(outside, 'planted.txt')));
  assert.doesNotMatch(second[1], /TOP-SECRET-CANARY/);
  assert.ok(!existsSync(join(bot.workspace, '.claude', 'settings.json')));

  // Full computer access: the same tools act as the server's user.
  await s.call('PATCH', `/api/bots/${bot.id}`, { access: 'host' });
  fake.queue({ calls: [{ name: 'shell', input: { command: `echo full > ${join(outside, 'full.txt')} && cat ${secret}` } }] }, { text: 'Done with full.' });
  const full = await reply(s, bot, 'Now with full access');
  assert.equal(full.text, 'Done with full.', full.text);
  assert.equal(readFileSync(join(outside, 'full.txt'), 'utf8'), 'full\n');
  assert.match(lastResult(fake.requests.at(-1)!), /TOP-SECRET-CANARY/);
  delete process.env.BOTONS_TEST_CANARY;
});

test('Workspace access without a sandbox: nothing runs and the turn says why; Full access still runs', async () => {
  const { useSandboxBinary } = await import('../src/sandbox.ts');
  useSandboxBinary(join(tempDir(), 'no-bwrap'));
  try {
    const s = await server();
    const bot = await s.newBot('Tim', { provider: 'openai-api', model: 'gpt-6.1-sol' });
    const m = await reply(s, bot, 'Hello');
    assert.equal(m.role, 'error');
    assert.match(m.text, /bubblewrap \(bwrap\) is not installed/);
    assert.equal(fake.requests.length, 0, 'nothing was sent');
    await s.call('PATCH', `/api/bots/${bot.id}`, { access: 'host' });
    fake.queue({ text: 'Hi with full access.' });
    const ok = await reply(s, bot, 'Hello again');
    assert.equal(ok.text, 'Hi with full access.');
  } finally {
    useSandboxBinary('bwrap');
  }
});

test('the provider’s errors: a refused key, an unknown model, and an overload before and after a tool ran', async () => {
  const s = await server();
  const bot = await s.newBot('Mark', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  fake.queue({ status: 401, error: { type: 'authentication_error', message: `invalid x-api-key ${ANTHROPIC_KEY}` } });
  const refused = await reply(s, bot, 'Hi');
  assert.equal(refused.role, 'error');
  assert.match(refused.text, /refused the key \(401\)/);
  assert.ok(!refused.text.includes(ANTHROPIC_KEY));

  fake.queue({ status: 404, error: { type: 'not_found_error', message: 'model: claude-nope' } });
  const missing = await reply(s, bot, 'Hi');
  assert.match(missing.text, /doesn't know this model/);

  // Overloaded before anything ran: the turn may be tried again (transient).
  fake.queue({ status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } });
  await reply(s, bot, 'Hi');
  let turn = s.app.store.db.prepare('select error_kind from turns where bot_id = ? order by started_at desc limit 1').get(bot.id) as any;
  assert.equal(turn.error_kind, 'transient');

  // After a tool ran: never transient, so nothing runs twice.
  fake.queue({ calls: [{ name: 'shell', input: { command: 'echo once >> ran.txt' } }] }, { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } });
  const after = await reply(s, bot, 'Do it');
  assert.match(after.text, /already run tools/);
  turn = s.app.store.db.prepare('select error_kind from turns where bot_id = ? order by started_at desc limit 1').get(bot.id) as any;
  assert.equal(turn.error_kind, 'other');
  assert.equal(readFileSync(join(bot.workspace, 'ran.txt'), 'utf8'), 'once\n');
});

test('stopping a turn ends the model request and the command it is running', async () => {
  const s = await server();
  const bot = await s.newBot('Phil', { provider: 'openai-api', model: 'gpt-6.1-sol', access: 'host' });
  fake.queue({ calls: [{ name: 'shell', input: { command: 'sleep 30; echo late > late.txt' } }] });
  s.app.engine.sendMessage(bot.id, 'Wait a while');
  await until(() => fake.requests.length === 1 && s.app.engine.statusOf(bot.id).activity?.includes('sleep'));
  const started = Date.now();
  await s.call('POST', `/api/bots/${bot.id}/stop`, {});
  await s.untilState(bot.id, 'idle', 10_000);
  assert.ok(Date.now() - started < 8000);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!existsSync(join(bot.workspace, 'late.txt')));
  // A hanging answer: stopped too.
  fake.queue({ hang: true });
  s.app.engine.sendMessage(bot.id, 'Again');
  await until(() => fake.requests.length === 2);
  await s.call('POST', `/api/bots/${bot.id}/stop`, {});
  await s.untilState(bot.id, 'idle', 10_000);
  const turn = s.app.store.db.prepare('select outcome from turns where bot_id = ? order by started_at desc limit 1').get(bot.id) as any;
  assert.equal(turn.outcome, 'stopped');
});

test('a connector that is a Botons library server is the model’s tool; the CLI’s own setup never is', { skip: sandboxProblem() ?? false }, async () => {
  const s = await server();
  // Outside the temporary folders: a local connector starts in the Workspace sandbox, which never shows them.
  const dir = outsideTemp();
  const script = join(dir, 'echo-mcp.mjs');
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'shout', description: 'Shout text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments.text).toUpperCase() + ' ' + process.env.ECHO_SECRET }], structuredContent: { ok: true } } });
});
`,
  );
  const created = await s.call('POST', '/api/mcp-servers', { name: 'echo', transport: 'stdio', command: process.execPath, args: [script], env: { ECHO_SECRET: 'library-secret-value' } });
  assert.ok(created.status < 300, created.text);
  const bot = await s.newBot('Carl', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host', connections: ['lib:echo'] });
  fake.queue({ calls: [{ name: 'mcp__echo__shout', input: { text: 'hi' } }] }, { text: 'Shouted.' });
  const m = await reply(s, bot, 'Shout hi');
  assert.equal(m.text, 'Shouted.', m.text);
  const names = (fake.requests[0].body.tools as any[]).map((t) => t.name);
  assert.ok(names.includes('mcp__echo__shout'));
  assert.deepEqual(names.filter((n) => n.startsWith('mcp__')), ['mcp__echo__shout'], 'only the Botons connector it was given');
  const result = lastResult(fake.requests[1]);
  assert.match(result, /^HI \[redacted\]$/, 'a connector’s own secret never goes to the model');
});

test('an image in the chat goes to the model once, and the key’s evidence notes vision', async () => {
  const s = await server();
  const bot = await s.newBot('Otto', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  const dir = tempDir();
  const img = join(dir, 'dot.png');
  writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const provider = s.app.providers.get('anthropic-api')!;
  fake.queue({ text: 'A dot.' });
  const result = await provider.runTurn({
    cwd: bot.workspace,
    sessionId: null,
    systemPrompt: 'sys',
    spend: { botId: bot.id, turnId: 'turn_direct', runId: null, routineId: null },
    prompt: 'What is this?',
    model: 'claude-sonnet-5-5',
    access: 'host',
    images: [img],
    privatePaths: [],
    env: {},
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onActivity: () => {},
  });
  assert.equal(result.text, 'A dot.');
  const sent = fake.requests[0].body.messages[0].content;
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].source.media_type, 'image/png');
  const history = JSON.parse(readFileSync(join(s.home, 'api-sessions', `${result.sessionId}.json`), 'utf8'));
  assert.ok(!JSON.stringify(history).includes(sent[0].source.data), 'the history keeps a note, not the image');
  const state = (await s.call('GET', '/api/api-keys')).data.providers[0];
  assert.ok(state.observed.find((o: any) => o.model === 'claude-sonnet-5-5')?.vision);
  mkdirSync(join(dir, 'x'), { recursive: true });
});

test('both API brains can review and install a connector-dependent starter with exact paused grants', async () => {
  const s = await server();
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'code_github', transport: 'http', url: 'https://mcp.example.com/github' })).status, 201);
  for (const brain of BRAINS) {
    assert.equal(s.app.connectors.takesConnectors(brain.provider), true);
    const catalog = s.app.connectors.catalog().connectors.find((c) => c.id === 'lib:code_github')!;
    assert.ok(catalog.providers.includes(brain.provider));
    assert.ok(!s.app.connectors.catalog().connectors.find((c) => c.managed)!.providers.includes(brain.provider), 'managed browser remains CLI-only');
    const reviewed = await s.call<any>('POST', '/api/templates/builtin-repo-monitor/review', { provider: brain.provider, access: 'workspace', connectors: { 'code-host': 'lib:code_github' } });
    assert.equal(reviewed.status, 200, reviewed.text);
    assert.deepEqual(reviewed.data.blocked, []);
    const made = await s.call<Bot>('POST', '/api/bots', { name: brain.provider === 'anthropic-api' ? 'Kevin' : 'Stuart', provider: brain.provider, access: 'workspace', templateId: 'builtin-repo-monitor', starterConnectors: { 'code-host': 'lib:code_github' }, reviewKey: reviewed.data.reviewKey });
    assert.equal(made.status, 201, made.text);
    // No browser: an API key brain can't run it.
    assert.deepEqual(made.data.connections, ['lib:code_github']);
    const routines = (await s.call<Routine[]>('GET', `/api/bots/${made.data.id}/routines`)).data;
    assert.ok(routines.length > 0 && routines.every((r) => !r.enabled));
    assert.match(reviewed.data.grants.join(' '), /No browser/);
    // A blank new Boton on the key, as setup and New Boton make one: no browser either.
    const blank = await s.call<Bot>('POST', '/api/bots', { name: brain.provider === 'anthropic-api' ? 'Bob' : 'Dave', provider: brain.provider, access: 'workspace' });
    assert.equal(blank.status, 201, blank.text);
    assert.deepEqual(blank.data.connections, []);
  }
});
