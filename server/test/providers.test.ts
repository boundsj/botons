import { cliTurn } from '../src/providers/cli-turn.ts';
// The claude and codex providers against recorded CLI output (fixtures/fake-cli.ts).
import { CLI_NAMES } from '../../shared/legacy-names.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TurnStep } from '../../shared/types.ts';
import { CLAUDE_DISALLOWED_TOOLS, ClaudeCliProvider, claudeArgs, claudeMcpConfig, claudeUsage, sessionTotals, toolStep } from '../src/providers/claude-cli.ts';
import { CodexCliProvider, codexArgs, itemStep, parseRolloutTurn, unwrapShell } from '../src/providers/codex-cli.ts';
import { classifyFailure, DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS, parseReset } from '../src/providers/failures.ts';
import { ProviderError, type TurnRequest } from '../src/providers/types.ts';
import { type FakeCli, fakeCli, loadFixture } from './fixtures/fake-cli.ts';
import { tempDir, until } from './helpers.ts';

// Sandbox argument snapshots must not depend on browser tests changing the runner's home.
process.env.HOME = tempDir('botons-provider-home-');
const dir = tempDir('botons-providers-');
const claudeBin = fakeCli(dir, 'claude');
const codexBin = fakeCli(dir, 'codex');
/** A stand-in for ~/.codex, where the codex provider reads rollouts. */
const codexHome = join(dir, 'codex-home');
const claude = new ClaudeCliProvider(claudeBin.bin);
const codex = new CodexCliProvider(codexBin.bin, codexHome);

/** Codex's token counts: input (cached input included), cached input, output. */
type Tokens = [input: number, cached: number, output: number];
const tokens = ([input, cached, output]: Tokens) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 });

/** A turn of a rollout: its model, the thread's running totals at its end (token_count), and its own usage (token_usage_record). */
type RolloutSpec = { model: string; total?: Tokens; own?: Tokens };

/** A rollout file as codex-cli 0.166.0 writes it, trimmed to what the provider reads, with `pad` characters of other events per turn. */
function writeRollout(threadId: string, turns: Array<string | RolloutSpec>, pad = 0) {
  const folder = join(codexHome, 'sessions', '2026', '11', '05');
  mkdirSync(folder, { recursive: true });
  const lines = [
    { timestamp: '2026-11-05T06:13:01.000Z', type: 'session_meta', payload: { id: threadId, cli_version: '0.166.0', originator: 'codex_exec', model_provider: 'openai' } },
    ...turns.flatMap((t, i) => {
      const { model, total, own } = typeof t === 'string' ? { model: t } : t;
      const turn_id = `turn-${i}`;
      return [
        { timestamp: '2026-11-05T06:13:01.050Z', type: 'event_msg', payload: { type: 'task_started', turn_id } },
        { timestamp: '2026-11-05T06:13:01.100Z', type: 'turn_context', payload: { turn_id, cwd: '/tmp/boton-workspace', model, effort: null } },
        { timestamp: '2026-11-05T06:13:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(pad) } },
        ...(own ? [{ timestamp: '2026-11-05T06:13:02.100Z', type: 'token_usage_record', payload: { thread_id: threadId, turn_id, turn_token_usage: tokens(own), thread_token_usage: total ? tokens(total) : null } }] : []),
        ...(total ? [{ timestamp: '2026-11-05T06:13:02.200Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tokens(total), last_token_usage: tokens(own ?? total) } } }] : []),
        { timestamp: '2026-11-05T06:13:02.300Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } },
        { timestamp: '2026-11-05T06:13:02.400Z', type: 'event_msg', payload: { type: 'task_complete', turn_id } },
      ];
    }),
  ];
  writeFileSync(join(folder, `rollout-2026-11-05T06-13-01-${threadId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const CLAUDE_SESSION = 'e65ce95f-f0a9-4921-bf85-004911bc3c05';
const CODEX_THREAD = '01a1aa57-822e-77b2-b248-455af0f06ea8';
const UNKNOWN_SESSION = '3f0c2a8e-5b7d-4c1e-9a6f-2d8b4e1c7a90';

type Request = TurnRequest & { activities: string[]; texts: string[]; steps: TurnStep[] };
function request(over: Partial<TurnRequest> = {}): Request {
  const [activities, texts, steps]: [string[], string[], TurnStep[]] = [[], [], []];
  return {
    cwd: dir, sessionId: null, systemPrompt: 'You are a test Boton.', prompt: 'Reply with the single word: pong', model: '', access: process.platform === 'linux' ? 'workspace' : 'host', privatePaths: [],
    env: { BOTON_BOT_ID: 'bot_test' }, signal: new AbortController().signal, timeoutMs: 10_000,
    onActivity: (a) => activities.push(a), onText: (t) => texts.push(t), onStep: (st) => steps.push(st),
    activities, texts, steps, ...over,
  };
}

/** Steps without their times. */
const untimed = (steps: TurnStep[]) =>
  steps.map(({ at, ...rest }) => {
    assert.ok(!Number.isNaN(Date.parse(at)), at);
    return rest;
  });

async function failure(turn: Promise<unknown>): Promise<ProviderError> {
  const err = await turn.then(() => assert.fail('expected the turn to fail'), (e: unknown) => e);
  assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${err}`);
  return err;
}

/** A turn stopped once its fake CLI (scripted to hang) has written what it writes and only waits for a signal. */
async function stopped(provider: ClaudeCliProvider | CodexCliProvider, bin: FakeCli, over: Partial<TurnRequest> = {}): Promise<ProviderError> {
  const stop = new AbortController();
  const turn = failure(provider.runTurn(request({ ...over, signal: stop.signal })));
  await until(() => bin.hanging() > 0, 10_000);
  stop.abort();
  return turn;
}

// ------------------------------------------------------------------ claude

test("claude: a reply has its text, session, tokens, cost and model; the prompt goes on stdin; none of the user's setup is loaded", async () => {
  claudeBin.script('claude/reply');
  const req = request({ model: 'haiku' });
  const result = await claude.runTurn(req);
  assert.deepEqual([result.text, result.sessionId], ['pong', CLAUDE_SESSION]);
  // From the result's modelUsage; the model from the init event.
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 8406, cacheWriteTokens: 3472, costUsd: 0.00078066, numTurns: 1, model: 'claude-haiku-5-5' });
  const [call] = claudeBin.calls();
  assert.deepEqual([call.argv, call.stdin, call.cwd], [claudeArgs(cliTurn(req, 'claude').req), req.prompt, dir]);

  // Recorded with these flags: no MCP servers, skills, plugins or scheduling tools.
  const init = loadFixture('claude/reply').stdout.find((e: any) => e.type === 'system' && e.subtype === 'init') as any;
  assert.deepEqual([init.mcp_servers, init.skills, init.slash_commands], [[], [], []]);
  assert.ok(init.plugins.every((p: any) => p.path === 'builtin'), JSON.stringify(init.plugins));
  for (const tool of CLAUDE_DISALLOWED_TOOLS) assert.ok(!init.tools.includes(tool), tool);
  assert.ok(!init.tools.some((t: string) => t.startsWith('mcp__')));
});

test('claude: without partial messages each text block is the reply so far, and tool calls are activity and steps with their input in full', async () => {
  claudeBin.script('claude/tool-use');
  const req = request();
  const result = await claude.runTurn(req);
  assert.equal(result.text, 'hello from bash');
  assert.deepEqual(req.texts, ['hello from bash']);
  assert.ok(req.activities.includes('Running `echo hello from bash`'), req.activities.join(', '));
  assert.deepEqual(untimed(req.steps), [{ kind: 'command', label: 'Running `echo hello from bash`', detail: 'echo hello from bash' }]);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 88, cacheReadTokens: 19840, cacheWriteTokens: 4069, costUsd: 0.0010566, numTurns: 2, model: 'claude-haiku-5-5' });

  const long = `echo ${'x'.repeat(200)}`;
  const steps: [string, Record<string, unknown>, string[] | null][] = [
    ['Bash', { command: long }, ['command', `Running \`${long.slice(0, 69)}…\``, long]],
    ['Read', { file_path: '/home/u/notes/today.md' }, ['read', 'Reading today.md', '/home/u/notes/today.md']],
    ['Write', { file_path: '/ws/out.txt', content: 'hi' }, ['edit', 'Editing out.txt', '/ws/out.txt']],
    ['Grep', { pattern: 'TODO', path: '/ws' }, ['search', 'Searching files', 'TODO in /ws']],
    ['WebFetch', { url: 'https://example.com/a?b=c' }, ['web', 'Reading example.com', 'https://example.com/a?b=c']],
    ['WebSearch', { query: 'botons' }, ['web', 'Searching the web for “botons”', 'botons']],
    ['mcp__github__create_issue', { title: 'x' }, ['tool', 'Using github create_issue', '{"title":"x"}']],
    ['TodoWrite', { todos: [] }, null],
  ];
  for (const [tool, input, want] of steps) {
    const st = toolStep(tool, input);
    assert.deepEqual(st && [st.kind, st.label, st.detail], want, tool);
  }
});

test('claude: with partial messages, the reply streams as it is written, and the command it ran is a step', async () => {
  claudeBin.script('claude/stream');
  const req = request();
  const result = await claude.runTurn(req);
  assert.match(result.text, /^The Bash command printed "streamed from bash\."/);
  // The first message grows, then the reply (a new message) starts over and grows to the result.
  assert.equal(req.texts[0], 'I');
  assert.equal(req.texts[4], "I'll run the requested echo command through Bash.");
  assert.equal(req.texts[5], 'The Bash command printed "');
  assert.equal(req.texts.at(-1), result.text);
  for (let i = 6; i < req.texts.length; i++) assert.ok(req.texts[i].startsWith(req.texts[i - 1]), `${i}: ${req.texts[i]}`);
  assert.equal(req.texts.length, 16);
  assert.deepEqual(untimed(req.steps), [{ kind: 'command', label: 'Running `echo streamed from bash`', detail: 'echo streamed from bash' }]);
  assert.ok(req.activities.includes('Writing'));
  assert.equal(result.usage!.model, 'claude-haiku-5-5');
  assert.ok(result.usage!.outputTokens > 0);
});

test('claude: a failed turn fails with its message and still reports what it used', async () => {
  claudeBin.script('claude/error');
  const err = await failure(claude.runTurn(request()));
  assert.deepEqual([err.message, err.sessionLost], ['Reached maximum budget ($0.00001)', false]);
  // From modelUsage, since the result's usage is all zeros.
  assert.deepEqual(err.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 8406, cacheWriteTokens: 3496, costUsd: 0.0007854600000000001, numTurns: 1, model: 'claude-haiku-5-5' });
  // A usage limit ran nothing: no tokens, but the model is known.
  claudeBin.script('claude/usage-limit');
  const limit = await failure(claude.runTurn(request()));
  assert.deepEqual([limit.usage!.model, limit.usage!.inputTokens + limit.usage!.outputTokens], ['claude-haiku-5-5', 0]);
  // A stopped turn has no result: what its API responses said so far.
  claudeBin.script({ fixture: 'claude/tool-use', hang: true, lines: 5 });
  const stop = await stopped(claude, claudeBin);
  assert.equal(stop.message, 'Stopped.');
  assert.deepEqual(stop.usage, { inputTokens: 4, outputTokens: 23, cacheReadTokens: 19840, cacheWriteTokens: 4069, model: 'claude-haiku-5-5' });
  // Streamed, a response's final output count comes at its message_delta.
  claudeBin.script({ fixture: 'claude/stream', hang: true, lines: 42 });
  assert.deepEqual((await stopped(claude, claudeBin)).usage, { inputTokens: 4, outputTokens: 134, cacheReadTokens: 18158, cacheWriteTokens: 6028, model: 'claude-haiku-5-5' });
});

test('claude: only a resume of a session Claude does not have is a lost session, not other failures, timeouts or stops', async () => {
  claudeBin.script('claude/missing-session');
  const lost = await failure(claude.runTurn(request({ sessionId: UNKNOWN_SESSION })));
  assert.equal(lost.sessionLost, true);
  assert.match(lost.message, /No conversation found with session ID/);

  const others = [['claude/model-not-found', /issue with the selected model/], ['claude/command-not-found', /frobnicate-botons-test: command not found/]] as const;
  for (const [fixture, message] of others) {
    claudeBin.script(fixture);
    const err = await failure(claude.runTurn(request({ sessionId: CLAUDE_SESSION })));
    assert.equal(err.sessionLost, false, fixture);
    assert.match(err.message, message);
  }

  claudeBin.script({ fixture: 'claude/missing-session', hang: true });
  const timedOut = await failure(claude.runTurn(request({ sessionId: CLAUDE_SESSION, timeoutMs: 300 })));
  assert.deepEqual([timedOut.message, timedOut.sessionLost], ['Claude timed out.', false]);
  const stop = await stopped(claude, claudeBin, { sessionId: CLAUDE_SESSION });
  assert.deepEqual([stop.message, stop.sessionLost], ['Stopped.', false]);
});

test("claude: a resumed turn reports its own tokens and cost, not the session's running totals", async () => {
  // resume.json is reply.json's next turn; its modelUsage and total_cost_usd still count reply.json's.
  const provider = new ClaudeCliProvider(claudeBin.bin);
  claudeBin.script('claude/reply', 'claude/resume');
  assert.equal((await provider.runTurn(request())).usage!.costUsd, 0.00078066);
  const own = { inputTokens: 3, outputTokens: 6, cacheReadTokens: 11878, cacheWriteTokens: 41, numTurns: 1, model: 'claude-haiku-5-5' };
  assert.deepEqual((await provider.runTurn(request({ sessionId: CLAUDE_SESSION }))).usage, { ...own, costUsd: 0.00013028 });

  // After a restart the session's earlier totals aren't known: the cost is left out.
  claudeBin.script('claude/resume');
  assert.deepEqual((await new ClaudeCliProvider(claudeBin.bin).runTurn(request({ sessionId: CLAUDE_SESSION }))).usage, own);

  // A resume that never ran the model used nothing, though its modelUsage and cost repeat reply.json's.
  const carried = (loadFixture('claude/model-not-found').stdout as any[]).find((e) => e.type === 'result');
  assert.deepEqual([carried.modelUsage['claude-haiku-5-5'].costUSD, carried.total_cost_usd], [0.00078066, 0.00078066]);
  for (const p of [provider, new ClaudeCliProvider(claudeBin.bin)]) {
    claudeBin.script('claude/model-not-found');
    const { usage } = await failure(p.runTurn(request({ sessionId: CLAUDE_SESSION })));
    assert.deepEqual([usage!.inputTokens, usage!.outputTokens, usage!.cacheReadTokens, usage!.cacheWriteTokens, usage!.costUsd], [0, 0, 0, 0, undefined]);
  }

  // Resumed where nothing was carried over: the whole cost is this turn's.
  const result = { usage: { input_tokens: 3, output_tokens: 6 }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 3, outputTokens: 6 } }, total_cost_usd: 0.000003 };
  assert.equal(claudeUsage(result, null, { resumed: true })!.costUsd, 0.000003);
  // Carried over, but not what this provider saw last: unknown.
  const later = { ...result, modelUsage: { 'claude-haiku-5-5': { inputTokens: 10, outputTokens: 6 } }, total_cost_usd: 0.00001 };
  assert.equal(claudeUsage(later, null, { resumed: true, before: { tokens: 5, costUsd: 0.000005 } })!.costUsd, undefined);
  assert.equal(claudeUsage(later, null, { resumed: true, before: { tokens: 7, costUsd: 0.000007 } })!.costUsd, 0.000003);
  assert.deepEqual(sessionTotals(later), { tokens: 16, costUsd: 0.00001 });
});

// ------------------------------------------------------------------- codex

test("codex: a reply has its text, thread id and tokens (cached input apart), the model from the thread's rollout, and the prompt on stdin", async () => {
  codexBin.script('codex/reply');
  const req = request();
  const result = await codex.runTurn(req);
  assert.deepEqual([result.text, result.sessionId, result.warnings], ['pong', CODEX_THREAD, undefined]);
  // No rollout: the model the turn asked for, or none.
  assert.deepEqual(result.usage, { inputTokens: 1359, outputTokens: 5, cacheReadTokens: 12032, cacheWriteTokens: 0 });
  const [call] = codexBin.calls();
  assert.deepEqual([call.argv, call.stdin], [codexArgs(cliTurn(req, 'codex').req), req.prompt]);
  codexBin.script('codex/reply');
  assert.equal((await codex.runTurn(request({ model: 'gpt-5.6-mini' }))).usage!.model, 'gpt-5.6-mini');

  // The rollout's last turn_context names the model that ran, even past a long tail of other events.
  writeRollout(CODEX_THREAD, ['gpt-5.6-terra', 'gpt-5.6-terra-2'], 600_000);
  codexBin.script('codex/reply');
  assert.deepEqual((await codex.runTurn(request())).usage, { inputTokens: 1359, outputTokens: 5, cacheReadTokens: 12032, cacheWriteTokens: 0, model: 'gpt-5.6-terra-2' });
});

test('codex: each agent message is the reply so far, and each command is activity and one step, unwrapped from its shell', async () => {
  codexBin.script('codex/tool-use');
  const req = request();
  const result = await codex.runTurn(req);
  assert.equal(result.text, 'hello from shell');
  assert.deepEqual(req.texts, ['I’ll run the command now.\n', 'hello from shell']);
  assert.ok(req.activities.includes("Running `'echo hello from shell'`"), req.activities.join(', '));
  assert.deepEqual(untimed(req.steps), [{ kind: 'command', label: "Running `'echo hello from shell'`", detail: 'echo hello from shell' }]);

  assert.equal(unwrapShell("/usr/bin/bash -lc 'df -h'"), 'df -h');
  assert.equal(unwrapShell("bash -lc 'echo '\\''hi'\\'' there'"), "echo 'hi' there");
  assert.equal(unwrapShell("/usr/bin/bash -lc 'a' && b"), "/usr/bin/bash -lc 'a' && b");
  const edit = itemStep({ id: 'i', type: 'file_change', changes: [{ path: '/ws/a.txt', kind: 'add' }, { path: '/ws/b.txt', kind: 'update' }] });
  assert.deepEqual([edit?.kind, edit?.detail], ['edit', 'add /ws/a.txt\nupdate /ws/b.txt']);
  assert.equal(itemStep({ id: 'r', type: 'reasoning' }), null);
  assert.equal(itemStep({ id: 'm', type: 'agent_message', text: 'hi' }), null);
});

test("codex: a resumed thread's turn reports only its own tokens, not the thread's running total", async () => {
  // resume.json's turn.completed has the thread's total: turn 1's 13391/12032/5 plus this turn's 13420/13312/7.
  const resumed = () => {
    codexBin.script('codex/resume');
    return codex.runTurn(request({ sessionId: CODEX_THREAD }));
  };
  const own = { inputTokens: 108, outputTokens: 7, cacheReadTokens: 13312, cacheWriteTokens: 0, model: 'gpt-5.6-terra' };
  const totals: RolloutSpec[] = [{ model: 'gpt-5.6-terra', total: [13391, 12032, 5] }, { model: 'gpt-5.6-terra', total: [26811, 25344, 12] }];
  // The rollout's totals at the turn's end less those it started from.
  writeRollout(CODEX_THREAD, totals);
  assert.deepEqual((await resumed()).usage, own);
  // The turn's own token_usage_record, even without token_count lines.
  writeRollout(CODEX_THREAD, [{ model: 'gpt-5.6-terra', own: [13391, 12032, 5] }, { model: 'gpt-5.6-terra', own: [13420, 13312, 7] }]);
  assert.deepEqual((await resumed()).usage, own);
  // The turn starts far back: the rollout is read further until its start is found.
  writeRollout(CODEX_THREAD, totals, 600_000);
  assert.deepEqual((await resumed()).usage, own);

  // The rollout doesn't say where the turn started, or disagrees with turn.completed: no token counts.
  for (const turns of [['gpt-5.6-terra', 'gpt-5.6-terra'], [totals[0], { model: 'gpt-5.6-terra', total: [99999, 0, 1] }]] as Array<Array<string | RolloutSpec>>) {
    writeRollout(CODEX_THREAD, turns);
    assert.deepEqual((await resumed()).usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'gpt-5.6-terra' });
  }

  // A thread's first turn started from zero, if the whole file was read; a cut-off tail doesn't know.
  const first = [
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't', model: 'm' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tokens([10, 4, 2]) } } }),
  ].join('\n');
  assert.deepEqual(parseRolloutTurn(first, true), { model: 'm', own: null, after: { input: 10, cached: 4, cacheWrite: 0, output: 2 }, before: { input: 0, cached: 0, cacheWrite: 0, output: 0 } });
  assert.equal(parseRolloutTurn(first, false)!.before, null);
  assert.equal(parseRolloutTurn('{"type":"session_meta"}', true), null);
});

test('codex: errors followed by turn.completed are warnings, and the reply and thread id are kept', async () => {
  codexBin.script('codex/stream-error-then-complete');
  const result = await codex.runTurn(request());
  assert.deepEqual([result.text, result.sessionId], ['pong', '01a1aa58-a87b-7df0-8128-37416a055672']);
  const errors = loadFixture('codex/stream-error-then-complete').stdout.filter((e: any) => e.type === 'error').map((e: any) => e.message);
  assert.ok(errors.length > 0);
  assert.deepEqual(result.warnings, errors);
  assert.match(result.warnings![0], /^Reconnecting\.\.\. 2\/5/);
});

test('codex: turn.failed fails the turn; only a resume of a thread Codex does not have is a lost session', async () => {
  codexBin.script('codex/error');
  const err = await failure(codex.runTurn(request()));
  assert.deepEqual([err.message, err.sessionLost], ['workspace routing discovery failed', false]);

  codexBin.script('codex/missing-session');
  const req = request({ sessionId: UNKNOWN_SESSION });
  const lost = await failure(codex.runTurn(req));
  assert.equal(lost.sessionLost, true);
  assert.match(lost.message, /no rollout found for thread id/);
  assert.deepEqual(codexBin.calls()[0].argv, codexArgs(cliTurn(req, 'codex').req));

  for (const [fixture, message] of [['codex/model-not-found', /model is not supported/], ['codex/command-not-found', /command not found/]] as const) {
    codexBin.script(fixture);
    const e = await failure(codex.runTurn(request({ sessionId: CODEX_THREAD })));
    assert.equal(e.sessionLost, false, fixture);
    assert.match(e.message, message);
  }

  codexBin.script({ fixture: 'codex/missing-session', hang: true });
  const timedOut = await failure(codex.runTurn(request({ sessionId: CODEX_THREAD, timeoutMs: 300 })));
  assert.deepEqual([timedOut.message, timedOut.sessionLost], ['Codex timed out.', false]);
});

// ------------------------------------------------------- how a turn ended

test('a result a CLI writes once stopped or past its time limit fails the turn as that; one written first is the reply', async () => {
  const cases = [
    [claude, claudeBin, 'claude/reply', 'Claude', 'pong'],
    [codex, codexBin, 'codex/reply', 'Codex', 'pong'],
  ] as const;
  for (const [provider, bin, fixture, label, reply] of cases) {
    // Killed at its limit, it writes a successful result as it shuts down: timed out, all the same.
    bin.script({ fixture, hang: true, lines: 2, lateResult: true });
    const late = await failure(provider.runTurn(request({ timeoutMs: 300 })));
    assert.deepEqual([late.message, late.exit?.timedOut, late.sessionLost, late.kind], [`${label} timed out.`, true, false, 'other'], fixture);
    // Stopped, the same: stopped.
    bin.script({ fixture, hang: true, lines: 2, lateResult: true });
    const stop = await stopped(provider, bin);
    assert.deepEqual([stop.message, stop.exit?.timedOut], ['Stopped.', false], fixture);
    // Its result came before the limit, and it didn't exit until killed there: the turn was over, so it is the reply.
    bin.script({ fixture, linger: true });
    const result = await provider.runTurn(request({ timeoutMs: 600 }));
    assert.equal(result.text, reply, fixture);
  }
});

// ------------------------------------------------------- failure kinds

test('every recorded failure gets the right kind, and a usage limit the reset time the CLI printed', async () => {
  const before = Date.now();
  const cases: [ClaudeCliProvider | CodexCliProvider, string, string][] = [
    [claude, 'claude/error', 'other'], [claude, 'claude/model-not-found', 'other'], [claude, 'claude/command-not-found', 'other'],
    [claude, 'claude/not-logged-in', 'auth'], [claude, 'claude/usage-limit', 'usage_limit'],
    [codex, 'codex/error', 'transient'], [codex, 'codex/model-not-found', 'other'], [codex, 'codex/command-not-found', 'other'],
    // Codex retries the 401 five times ("Reconnecting... 5/5 (unexpected status 401 …)"): still a login problem.
    [codex, 'codex/not-logged-in', 'auth'], [codex, 'codex/usage-limit', 'usage_limit'],
  ];
  const errs: Record<string, ProviderError> = {};
  for (const [provider, fixture, kind] of cases) {
    (provider === claude ? claudeBin : codexBin).script(fixture);
    const err = (errs[fixture] = await failure(provider.runTurn(request())));
    assert.equal(err.kind, kind, fixture);
    assert.equal(err.retryAt !== null, kind === 'usage_limit', fixture);
  }
  // A lost session and a timeout are none of these.
  claudeBin.script('claude/missing-session');
  assert.equal((await failure(claude.runTurn(request({ sessionId: CLAUDE_SESSION })))).kind, 'other');
  codexBin.script({ fixture: 'codex/error', hang: true });
  assert.equal((await failure(codex.runTurn(request({ timeoutMs: 300 })))).kind, 'other');

  // "resets 3pm (Europe/London)": the next 3:00 PM there, plus a minute (or, just after 3:00 PM, a minute from now).
  const c = errs['claude/usage-limit'];
  assert.match(c.message, /hit your 5-hour limit/);
  const there = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(c.retryAt!);
  const justAfter = (d: Date) => d.getTime() - before < 5 * 60_000;
  assert.ok(there === '15:01' || justAfter(c.retryAt!), there);
  assert.ok(c.retryAt!.getTime() > before && c.retryAt!.getTime() - before <= 86_400_000 + 120_000, c.retryAt!.toISOString());
  // Codex prints a local time ("try again at 3:05 PM").
  const x = errs['codex/usage-limit'];
  assert.ok(`${x.retryAt!.getHours()}:${x.retryAt!.getMinutes()}` === '15:6' || justAfter(x.retryAt!), x.retryAt!.toString());
  assert.ok(x.retryAt!.getTime() > before);
});

test('reset times: epochs, clock times with or without a zone, dates, durations, and a default', () => {
  const now = new Date('2026-11-04T20:00:00Z'); // 12:00 PST
  const tz = 'America/Los_Angeles';
  const reset = (text: string) => parseReset(text, now, tz)?.toISOString() ?? null;
  assert.equal(reset('Claude AI usage limit reached|1793840400'), '2026-11-05T01:00:00.000Z');
  assert.equal(reset("You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)"), '2026-11-04T23:01:00.000Z');
  assert.equal(reset("You've hit your 5-hour limit · resets 3:30pm (Europe/London) · progress saved"), '2026-11-05T15:31:00.000Z');
  // A time already past today means tomorrow.
  assert.equal(reset("You've hit your 5-hour limit · resets 9am (America/Los_Angeles)"), '2026-11-05T17:01:00.000Z');
  assert.equal(reset("You've hit your weekly limit · resets Nov 7, 9am (America/Los_Angeles)"), '2026-11-07T17:01:00.000Z');
  assert.equal(reset('spend limit reached (daily; resets 2026-11-05 00:00 UTC) — ask for more'), '2026-11-05T00:00:00.000Z');
  // Codex: local time today, or a full date.
  assert.equal(reset("You've hit your usage limit. Upgrade to Plus (https://chatgpt.com/explore/plus), or try again at 3:05 PM."), '2026-11-04T23:06:00.000Z');
  assert.equal(reset("You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 6th, 2026 1:15 AM."), '2026-11-06T09:16:00.000Z');
  assert.equal(reset("You've hit your usage limit, try again in 2 hours 5 minutes."), '2026-11-04T22:05:00.000Z');
  // Nothing to go on, or nonsense: no time (the classifier then waits DEFAULT_COOLDOWN_MS).
  assert.equal(reset("You've hit your limit"), null);
  assert.equal(reset('usage limit reached; resets in 40 days'), null);
  const c = classifyFailure("You've hit your limit", '', { now, localTz: tz });
  assert.deepEqual(c, { kind: 'usage_limit', retryAt: new Date(now.getTime() + DEFAULT_COOLDOWN_MS) });
  // A reset already past, or now, still waits a minute (else the turn would run again at once, over and over).
  const epoch = Math.floor((now.getTime() - 120_000) / 1000);
  assert.equal(reset(`Claude AI usage limit reached|${epoch}`), new Date(epoch * 1000).toISOString());
  for (const said of [`Claude AI usage limit reached|${epoch}`, "You've hit your usage limit, try again in 0 minutes."]) {
    assert.deepEqual(classifyFailure(said, '', { now, localTz: tz }), { kind: 'usage_limit', retryAt: new Date(now.getTime() + MIN_COOLDOWN_MS) }, said);
  }
});

test('only narrow network patterns count as transient, and only in the failure itself', () => {
  const kind = (said: string, failure = said) => classifyFailure(said, failure).kind;
  assert.equal(kind('API Error: Connection error.'), 'transient');
  assert.equal(kind('Request timed out.'), 'transient');
  assert.equal(kind('stream disconnected before completion: error sending request for url'), 'transient');
  assert.equal(kind('getaddrinfo EAI_AGAIN api.anthropic.com'), 'transient');
  // Overloaded and rate-limited: the CLIs retry these themselves.
  assert.equal(kind('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 'other');
  assert.equal(kind('API Error: 429 rate_limit_error'), 'other');
  assert.equal(kind('Reconnecting... 5/5 (unexpected status 500 Internal Server Error)\nboom'), 'other');
  assert.equal(kind('Reconnecting... 5/5 (workspace routing discovery failed)\nworkspace routing discovery failed'), 'transient');
  // Network noise on stderr does not make another failure transient.
  assert.equal(kind("The model is not supported\nERROR failed to refresh available models: Connection failed: error sending request", 'The model is not supported'), 'other');
  assert.equal(kind('API Error: 401 Invalid API key · Please run /login'), 'auth');
});

// -------------------------------------------------------------------- argv

const SYS = 'You are a test Boton.';
const turn = { systemPrompt: SYS, cwd: '/ws', privatePaths: ['/home/u/.ssh', '/data/botons.db'] };
const ws = { ...turn, model: '', sessionId: null, access: 'workspace' as const };
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const settingsOf = (argv: string[]) => JSON.parse(flag(argv, '--settings'));
const DENY = ['Read(//home/u/.ssh)', 'Read(//home/u/.ssh/**)', 'Read(//data/botons.db)', 'Read(//data/botons.db/**)', 'Edit(//ws/.claude/**)'];

const CLAUDE_HEAD = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', SYS, '--system-prompt-snapshot', 'off'];
/** The flags that keep the user's Claude Code setup out, at every access level. */
const CLAUDE_ISOLATION = [
  '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--disallowedTools',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'ListAgents', 'SendToProject', 'SendToProjectContext',
  'Workflow', 'DesignSync', 'ReportFindings', 'EnterWorktree', 'ExitWorktree',
];

test('claude argv for Workspace and Full computer access', () => {
  const argv = claudeArgs({ ...ws, model: 'haiku' });
  const settings = flag(argv, '--settings');
  assert.deepEqual(argv, [
    ...CLAUDE_HEAD,
    '--model', 'haiku', ...CLAUDE_ISOLATION, '--settings', settings, '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    // The command and its deprecated names (shared/legacy-names.mjs).
    '--allowedTools', ...['botons', ...CLI_NAMES].flatMap((n) => [`Bash(${n}:*)`, `Bash(${n} *)`]), 'WebSearch', 'WebFetch',
  ]);
  assert.deepEqual(JSON.parse(settings), {
    autoMemoryEnabled: false,
    disableAllHooks: true,
    permissions: { deny: DENY },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ['botons', ...CLI_NAMES].flatMap((n) => [n, `${n} *`]),
      filesystem: { denyRead: ['/home/u/.ssh', '/data/botons.db'], denyWrite: ['/ws/.claude'] },
    },
  });

  // A private path with rule syntax in its name is left to the sandbox, not written as a rule.
  const odd = settingsOf(claudeArgs({ ...ws, privatePaths: ['/data/odd (1)', '/data/ok'] }));
  assert.deepEqual(odd.permissions.deny, ['Read(//data/ok)', 'Read(//data/ok/**)', 'Edit(//ws/.claude/**)']);
  assert.deepEqual(odd.sandbox.filesystem.denyRead, ['/data/odd (1)', '/data/ok']);

  assert.deepEqual(claudeArgs({ ...turn, privatePaths: [], model: '', sessionId: 'sess-1', access: 'host' }), [
    ...CLAUDE_HEAD,
    '--resume', 'sess-1', ...CLAUDE_ISOLATION, '--settings', '{"autoMemoryEnabled":false,"disableAllHooks":true}', '--dangerously-skip-permissions',
  ]);
});

test('a sandboxed turn (protectInstructions) cannot write the instruction files later turns load: claude deny rules and sandbox, codex read-only entries', () => {
  const settings = settingsOf(claudeArgs({ ...ws, protectInstructions: true }));
  const files = ['/ws/CLAUDE.md', '/ws/CLAUDE.local.md', '/ws/AGENTS.md', '/ws/AGENTS.override.md', '/ws/.codex', '/ws/.agents'];
  assert.deepEqual(settings.permissions.deny, [
    ...DENY,
    ...files.flatMap((f) => [`Edit(/${f})`, `Edit(/${f}/**)`]),
    // Claude Code loads CLAUDE.md from subfolders too, as it reads there.
    'Edit(//ws/**/CLAUDE.md)', 'Edit(//ws/**/CLAUDE.local.md)', 'Edit(//ws/**/AGENTS.md)', 'Edit(//ws/**/AGENTS.override.md)',
  ]);
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, ['/ws/.claude', ...files]);
  // A turn that isn't sandboxed keeps them writable.
  assert.deepEqual(settingsOf(claudeArgs(ws)).sandbox.filesystem.denyWrite, ['/ws/.claude']);

  const fs = codexArgs({ ...ws, protectInstructions: true }).find((a) => a.startsWith('permissions.boton.filesystem='));
  assert.equal(fs, `permissions.boton.filesystem={"/home/u/.ssh"="none","/data/botons.db"="none","/ws/.claude"="read",${files.map((f) => `"${f}"="read"`).join(',')}}`);
});

test('claude argv with Ask first rules: the rules go in permissions.ask (always-allowed ones in allow), and `botons mcp` answers the prompts', () => {
  const askFirst = { ask: ['Bash(git push:*)'], allow: ['mcp__slack__send_message'], command: '/srv/botons/server/bin/botons', args: ['mcp'] };
  const server = { mcpServers: { botons: { type: 'stdio', command: '/srv/botons/server/bin/botons', args: ['mcp'] } } };
  const tail = (argv: string[], from: string) => argv.slice(argv.indexOf(from));

  // Full computer: ask rules still prompt (checked with Claude Code 2.1.316).
  const host = claudeArgs({ ...turn, privatePaths: [], model: '', sessionId: null, access: 'host', askFirst });
  assert.deepEqual(settingsOf(host), { autoMemoryEnabled: false, disableAllHooks: true, permissions: { ask: ['Bash(git push:*)'] } });
  assert.deepEqual(JSON.parse(flag(host, '--mcp-config')), server, 'no secret in it: the token comes from the environment');
  assert.deepEqual(tail(host, '--permission-prompt-tool'), ['--permission-prompt-tool', 'mcp__botons__approve', '--dangerously-skip-permissions']);
  const disallowed = host.slice(host.indexOf('--disallowedTools') + 1, host.indexOf('--settings'));
  assert.deepEqual(disallowed, [...CLAUDE_DISALLOWED_TOOLS, 'mcp__botons__approve'], 'the model itself cannot call it');

  // Workspace: prompts go to the tool rather than being denied outright.
  const wsArgv = claudeArgs({ ...ws, askFirst });
  assert.deepEqual(settingsOf(wsArgv).permissions, { deny: DENY, ask: ['Bash(git push:*)'], allow: ['mcp__slack__send_message'] });
  assert.deepEqual(tail(wsArgv, '--permission-prompt-tool').slice(0, 6), ['--permission-prompt-tool', 'mcp__botons__approve', '--permission-mode', 'acceptEdits', '--permission-prompts', 'host']);

  // With connectors, `botons mcp` comes after them, so none stands in for it.
  const servers = [{ kind: 'stdio' as const, name: 'botons', command: 'impostor', args: [], env: {} }];
  assert.deepEqual(JSON.parse(claudeMcpConfig(servers, askFirst)), server);
  // Without rules nothing changes.
  assert.equal(flag(claudeArgs(ws), '--permission-prompts'), 'none');
  assert.ok(!claudeArgs({ ...ws, access: 'host' }).includes('--permission-prompt-tool'));
});

/** The flags that keep the user's Codex setup out, at every access level. */
const CODEX_ISOLATION = [
  '--ignore-user-config', '--ignore-rules', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps', '--disable', 'tool_suggest', '--disable', 'hooks',
  '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false',
];
const DEV = `developer_instructions=${JSON.stringify(SYS)}`;

test('codex argv for Workspace and Full computer access', () => {
  assert.deepEqual(codexArgs({ ...ws, model: 'gpt-x' }), [
    'exec', '--json', '--skip-git-repo-check', ...CODEX_ISOLATION, '-m', 'gpt-x',
    '-c', 'default_permissions="boton"', '-c', 'permissions.boton.extends=":workspace"', '-c', 'permissions.boton.network.enabled=true',
    // The workspace's .claude is read-only, as for Claude.
    '-c', 'permissions.boton.filesystem={"/home/u/.ssh"="none","/data/botons.db"="none","/ws/.claude"="read"}',
    '-c', 'approval_policy="never"', '-c', DEV, '-C', '/ws', '-',
  ]);
  const host = codexArgs({ ...turn, privatePaths: [], model: '', sessionId: 'thread-1', access: 'host' });
  assert.deepEqual(host, ['exec', 'resume', '--json', '--skip-git-repo-check', ...CODEX_ISOLATION, '--dangerously-bypass-approvals-and-sandbox', '-c', DEV, 'thread-1', '-']);
});

test('codex refuses incompatible helpers before fresh or resumed turns and runs after upgrade and recheck', async () => {
  const root = tempDir();
  const cli = fakeCli(root, 'codex');
  cli.version('codex-cli 0.160.0');
  cli.script('codex/reply');
  const provider = new CodexCliProvider(cli.bin, root);
  assert.equal((await provider.info()).available, false);
  for (const sessionId of [null, CODEX_THREAD]) {
    await assert.rejects(provider.runTurn(request({ cwd: root, sessionId })), /requires Codex 0\.166\.0/);
  }
  assert.equal(cli.calls().length, 0, 'never launch exec with the incompatible helper');
  cli.version('codex-cli 0.166.0');
  provider.recheck();
  assert.equal((await provider.info()).available, true);
  assert.equal((await provider.runTurn(request({ cwd: root }))).text, 'pong');
  assert.equal(cli.calls().length, 1);
});

 test('codex never launches fresh or resumed turns when version detection fails', async () => {
  const root = tempDir();
  const cli = fakeCli(root, 'codex');
  cli.script('codex/reply');
  writeFileSync(cli.bin, `#!${process.execPath}
if (process.argv.includes('--version')) process.exit(1);
process.exit(99);
`);
  const provider = new CodexCliProvider(cli.bin, root);
  for (const sessionId of [null, CODEX_THREAD]) {
    await assert.rejects(provider.runTurn(request({ cwd: root, sessionId })), /version/);
  }
  assert.equal(cli.calls().length, 0);
});

test('stopping during the Codex version check never launches a fresh or resumed turn', async () => {
  for (const sessionId of [null, CODEX_THREAD]) {
    const root = tempDir();
    const cli = fakeCli(root, 'codex');
    const checking = join(root, 'checking');
    const release = join(root, 'release');
    const executed = join(root, 'executed');
    writeFileSync(cli.bin, `#!${process.execPath}
const {existsSync, writeFileSync} = require('node:fs');
if (process.argv.includes('--version')) {
  writeFileSync(${JSON.stringify(checking)}, '');
  const timer = setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) {
      clearInterval(timer);
      console.log('codex-cli 0.166.0');
    }
  }, 10);
} else if (process.argv.includes('model_provider="preflight"')) {
  console.log(JSON.stringify({ type: 'thread.started' }));
} else if (process.argv.includes('sandbox')) {
  console.log('BOTONS_WORKSPACE_PROBE_OK');
} else if (process.argv.includes('login')) {
  console.log('Logged in using ChatGPT');
} else {
  writeFileSync(${JSON.stringify(executed)}, '');
}
`);
    const controller = new AbortController();
    const provider = new CodexCliProvider(cli.bin, root);
    const outcome = failure(provider.runTurn(request({ cwd: root, sessionId, signal: controller.signal })));
    await until(() => existsSync(checking));
    controller.abort();
    writeFileSync(release, '');
    assert.equal((await outcome).message, 'Stopped.');
    assert.equal(existsSync(executed), false, 'stopped turns cannot execute tools');
  }
});
