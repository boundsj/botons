import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Message, UsageReport } from '../../shared/types.ts';
import { usageSince } from '../src/api.ts';
import type { App } from '../src/app.ts';
import { ProviderError } from '../src/providers/types.ts';
import { TURN_RETENTION_MS } from '../src/store.ts';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

const codexHome = useTestCodexHome(tempDir('botons-turns-test-'));
const CODEX_THREAD = '01a1aa57-822e-77b2-b248-455af0f06ea8';
/** Codex reads the model and a resumed turn's tokens from the thread's rollout: [input, cached, output] totals per turn. */
function writeRollout(...turns: Array<[number, number, number] | null>) {
  const folder = join(codexHome, 'sessions', '2026', '11', '05');
  mkdirSync(folder, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id: CODEX_THREAD, cli_version: '0.166.0', originator: 'codex_exec' } },
    ...turns.flatMap((total, i) => [
      { type: 'turn_context', payload: { turn_id: `t${i + 1}`, model: 'gpt-5.6-terra' } },
      ...(total ? [{ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2] } } } }] : []),
    ]),
  ];
  writeFileSync(join(folder, `rollout-2026-11-05T06-13-01-${CODEX_THREAD}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}
writeRollout(null);

const start = () => startServer({ fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h', BOTONS_RUN_RETRY_DELAY: '50ms' } });
const turnRows = (app: App, botId: string) => app.store.db.prepare('select * from turns where bot_id = ? order by started_at, rowid').all(botId) as Record<string, any>[];
const lastOf = (app: App, botId: string, role: Message['role']) => app.store.listMessages(botId).filter((m) => m.role === role).at(-1);

test('a completed claude or codex turn writes one row with its tokens and the model that ran, and the reply carries them', async () => {
  const { app, claude, codex, storeBot } = await start();
  claude.script('claude/reply');
  codex.script('codex/reply');
  const claudia = storeBot('Claudia', 'claude-cli', { model: 'haiku' });
  const cody = storeBot('Cody', 'codex-cli');

  app.engine.sendMessage(claudia.id, 'ping');
  app.engine.sendMessage(cody.id, 'ping');
  const replies = await until(() => {
    const a = lastOf(app, claudia.id, 'bot');
    const b = lastOf(app, cody.id, 'bot');
    return a && b && [a, b];
  });

  const [claudeRow, ...moreClaude] = turnRows(app, claudia.id);
  assert.equal(moreClaude.length, 0);
  assert.deepEqual(
    [claudeRow.trigger, claudeRow.provider, claudeRow.requested_model, claudeRow.model, claudeRow.outcome, claudeRow.num_turns, claudeRow.replayed_transcript, claudeRow.message_id],
    ['chat', 'claude-cli', 'haiku', 'claude-haiku-5-5', 'ok', 1, 0, replies[0].id],
  );
  assert.deepEqual([claudeRow.input_tokens, claudeRow.output_tokens, claudeRow.cache_read_tokens, claudeRow.cache_write_tokens, claudeRow.cost_usd], [2, 4, 8406, 3472, 0.00078066]);
  assert.equal(typeof claudeRow.duration_ms, 'number');

  const [codexRow, ...moreCodex] = turnRows(app, cody.id);
  assert.equal(moreCodex.length, 0);
  assert.deepEqual([codexRow.model, codexRow.input_tokens, codexRow.output_tokens, codexRow.cache_read_tokens, codexRow.message_id], ['gpt-5.6-terra', 1359, 5, 12032, replies[1].id]);

  assert.equal(replies[0].meta?.model, 'claude-haiku-5-5');
  assert.deepEqual(replies[0].meta?.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 8406, cacheWriteTokens: 3472, costUsd: 0.00078066 });
  assert.equal(replies[0].meta?.turnId, claudeRow.id);
  assert.equal(replies[1].meta?.model, 'gpt-5.6-terra');
  assert.equal(replies[1].meta?.usage?.outputTokens, 5);
});

test("a resumed chat turn's row has only its own tokens, not the session's running totals", async () => {
  const { app, claude, codex, storeBot, chat } = await start();
  // The second turn resumes the first's session, and its CLI reports the session's totals.
  claude.script('claude/reply', 'claude/resume');
  codex.script('codex/reply', 'codex/resume');
  const claudia = storeBot('Claudia', 'claude-cli', { model: 'haiku' });
  const cody = storeBot('Cody', 'codex-cli');
  await chat(claudia.id, 'ping');
  await chat(cody.id, 'ping');
  writeRollout([13391, 12032, 5], [26811, 25344, 12]);
  const claudeReply = await chat(claudia.id, 'again');
  const codexReply = await chat(cody.id, 'again');

  const tokens = (r: Record<string, any>) => [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens];
  const [, claudeRow] = turnRows(app, claudia.id);
  assert.deepEqual(tokens(claudeRow), [3, 6, 11878, 41]);
  assert.equal(claudeRow.cost_usd, 0.00013028);
  assert.deepEqual(claudeReply.meta?.usage, { inputTokens: 3, outputTokens: 6, cacheReadTokens: 11878, cacheWriteTokens: 41, costUsd: 0.00013028 });
  const [, codexRow] = turnRows(app, cody.id);
  assert.deepEqual(tokens(codexRow), [108, 7, 13312, 0]);
  assert.equal(codexReply.meta?.usage?.inputTokens, 108);
  writeRollout(null);
});

test("a turn whose session was lost counts what the lost attempt used with the retry's", async () => {
  const { app, mock, storeBot } = await start();
  const bot = storeBot('Kevin');
  app.engine.sendMessage(bot.id, 'hello');
  await until(() => lastOf(app, bot.id, 'bot'));
  const lost = new ProviderError('No conversation found with session ID mock-1', true);
  lost.usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, model: 'mock-echo' };
  mock.failNext(bot.id, lost);
  app.engine.sendMessage(bot.id, 'again');
  const reply = await until(() => turnRows(app, bot.id).length === 2 && turnRows(app, bot.id)[1].outcome === 'ok' && lastOf(app, bot.id, 'bot'));
  const [retry] = mock.turns.slice(-1);
  assert.equal(retry.sessionId, null);
  const row = turnRows(app, bot.id)[1];
  assert.deepEqual(
    [row.input_tokens, row.output_tokens, row.cache_read_tokens],
    [Math.ceil(retry.prompt.length / 4) + 10, Math.ceil(reply.text.length / 4) + 2, 5],
  );
});

test('failed, stopped and interrupted turns write a row with their outcome', async () => {
  const { app, claude, mock, storeBot } = await start();
  // What a failed turn used still counts.
  claude.script('claude/error');
  const claudia = storeBot('Claudia', 'claude-cli');
  app.engine.sendMessage(claudia.id, 'ping');
  const error = await until(() => lastOf(app, claudia.id, 'error'));
  const [failed] = turnRows(app, claudia.id);
  assert.deepEqual([failed.outcome, failed.error_kind, failed.model, failed.output_tokens, failed.message_id], ['error', 'other', 'claude-haiku-5-5', 4, error.id]);
  assert.equal(error.meta?.turnId, failed.id);

  const kevin = storeBot('Kevin');
  app.engine.sendMessage(kevin.id, 'SLOW_PLEASE');
  await until(() => app.engine.statusOf(kevin.id).state === 'working' && turnRows(app, kevin.id).length === 1);
  app.engine.stop(kevin.id);
  const chip = await until(() => app.store.listMessages(kevin.id).find((m) => m.meta?.kind === 'turn.stopped'));
  await until(() => turnRows(app, kevin.id)[0].outcome !== 'running');
  const [stopped] = turnRows(app, kevin.id);
  assert.deepEqual([stopped.outcome, stopped.message_id], ['stopped', chip.id]);
  assert.equal(chip.meta?.turnId, stopped.id);

  // An error with no usage still gets its row.
  mock.failNext(kevin.id, new ProviderError('API Error: Connection error.', false, { kind: 'transient' }));
  app.engine.sendMessage(kevin.id, 'hello');
  await until(() => turnRows(app, kevin.id).length === 2 && turnRows(app, kevin.id)[1].outcome !== 'running');
  assert.deepEqual([turnRows(app, kevin.id)[1].outcome, turnRows(app, kevin.id)[1].error_kind], ['error', 'transient']);

  // Cut off by a restart (restart.test.ts covers a crash).
  const stuart = storeBot('Stuart');
  app.engine.sendMessage(stuart.id, 'SLOW_PLEASE:60000');
  await until(() => turnRows(app, stuart.id).length === 1);
  app.engine.interruptAll();
  await until(() => turnRows(app, stuart.id)[0].outcome !== 'running');
  assert.deepEqual([turnRows(app, stuart.id)[0].outcome, turnRows(app, stuart.id)[0].message_id], ['interrupted', null]);
});

test('run history shows the tokens of each run (every attempt) and the model it ran on', async () => {
  const { app, mock, storeBot } = await start();
  const bot = storeBot('Stuart', 'mock', { model: 'small-model' });
  const routine = app.store.createRoutine(bot.id, { name: 'Nightly', instruction: 'Do the nightly job', schedule: 'every 1h' });
  mock.failNext(bot.id, new ProviderError('API Error: Connection error.', false, { kind: 'transient' }));
  const run = app.engine.fireScheduled(app.store.getRoutine(routine.id))!;
  const done = await until(() => {
    const r = app.store.findRun(run.id);
    return r?.status === 'succeeded' && r;
  });
  const rows = turnRows(app, bot.id);
  assert.deepEqual(
    rows.map((r) => [r.trigger, r.routine_id, r.run_id, r.outcome]),
    [
      ['schedule', routine.id, run.id, 'error'],
      ['schedule', routine.id, run.id, 'ok'],
    ],
  );
  assert.equal(done.model, 'small-model');
  assert.ok(done.usage && done.usage.inputTokens > 0 && done.usage.outputTokens > 0, JSON.stringify(done.usage));
  assert.equal(done.usage.inputTokens, rows[1].input_tokens);
  assert.deepEqual(app.store.listRuns(routine.id)[0].usage, done.usage);
  const reply = lastOf(app, bot.id, 'bot')!;
  assert.deepEqual([reply.meta?.model, reply.meta?.turnId], ['small-model', rows[1].id]);
});

test('GET /api/usage adds up tokens per Boton and per routine over a window, heaviest first; turns older than 90 days are dropped', async () => {
  const { app, call, storeBot } = await start();
  const get = (q: string) => call<UsageReport>('GET', `/api/usage${q}`);
  const kevin = storeBot('Kevin');
  const bob = storeBot('Bob');
  const brief = app.store.createRoutine(kevin.id, { name: 'Brief', instruction: 'x' });
  const check = app.store.createRoutine(kevin.id, { name: 'Check', instruction: 'x' });
  const turn = (botId: string, routineId: string | null, tokens: number, daysAgo = 0) => {
    const id = app.store.startTurn({ botId, trigger: routineId ? 'schedule' : 'chat', routineId, provider: 'mock', requestedModel: '' });
    app.store.finishTurn(id, {
      outcome: 'ok',
      durationMs: 10,
      usage: { inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
      replayedTranscript: false,
    });
    if (daysAgo) app.store.db.prepare('update turns set started_at = ? where id = ?').run(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), id);
  };
  turn(kevin.id, null, 100);
  turn(kevin.id, brief.id, 50);
  turn(kevin.id, check.id, 500, 3);
  turn(bob.id, null, 400);
  turn(bob.id, null, 1000, 10);

  const day = await get('?since=24h&group=bot');
  assert.equal(day.status, 200);
  assert.deepEqual(
    day.data.rows.map((r) => [r.botName, r.inputTokens, r.outputTokens, r.turns]),
    [
      ['Bob', 400, 400, 1],
      ['Kevin', 150, 150, 2],
    ],
  );
  assert.equal(day.data.group, 'bot');
  const week = await get('?since=7d');
  assert.deepEqual(
    week.data.rows.map((r) => [r.botName, r.inputTokens, r.turns, Number(r.costUsd?.toFixed(2))]),
    [
      ['Kevin', 650, 3, 0.03],
      ['Bob', 400, 1, 0.01],
    ],
  );
  const routines = await get(`?since=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}&group=routine&bot=${kevin.id}`);
  assert.deepEqual(
    routines.data.rows.map((r) => [r.routineName, r.routineId, r.inputTokens]),
    [
      ['Check', check.id, 500],
      [null, null, 100],
      ['Brief', brief.id, 50],
    ],
  );
  // A deleted routine's turns still count, without a name.
  app.store.deleteRoutine(check.id);
  assert.deepEqual((await get(`?since=7d&group=routine&bot=${kevin.id}`)).data.rows[0], {
    botId: kevin.id,
    botName: 'Kevin',
    routineId: check.id,
    routineName: null,
    turns: 1,
    inputTokens: 500,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  });
  assert.equal((await get('?group=everything')).status, 400);
  assert.equal((await get('?since=yesterday')).status, 400);
  assert.equal((await get('?bot=bot_nope')).status, 404);

  const old = app.store.startTurn({ botId: bob.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
  app.store.db.prepare('update turns set started_at = ? where id = ?').run(new Date(Date.now() - TURN_RETENTION_MS - 60_000).toISOString(), old);
  assert.equal(app.store.pruneTurns(), 1);
  assert.equal(app.store.turnRow(old), undefined);

  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(usageSince('24h', now).toISOString(), '2026-11-04T12:00:00.000Z');
  assert.equal(usageSince('7d', now).toISOString(), '2026-10-29T12:00:00.000Z');
  assert.equal(usageSince('90m', now).toISOString(), '2026-11-05T10:30:00.000Z');
  assert.equal(usageSince(null, now).toISOString(), '2026-10-29T12:00:00.000Z');
  assert.equal(usageSince('2026-11-01T00:00:00Z', now).toISOString(), '2026-11-01T00:00:00.000Z');
});
