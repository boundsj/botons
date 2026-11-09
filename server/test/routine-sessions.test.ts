import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Routine, ServerEvent } from '../../shared/types.ts';
import type { App } from '../src/app.ts';
import { sessionStart } from '../src/prompt.ts';
import { ProviderError } from '../src/providers/types.ts';
import { REPLAY_BUDGET, REPLAY_PAGE, ROUTINE_SHARE } from '../src/replay.ts';
import { botonCli, startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

useTestCodexHome(tempDir('botons-routine-sessions-'));
const start = (home?: string) => startServer({ home, fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h', BOTONS_RUN_RETRY_DELAY: '50ms' } });
const { app, base, claude, codex, mock, chat, storeBot, turnsOf } = await start();

const argOf = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const modelAndResume = (argv: string[]) => [argOf(argv, '--model'), argOf(argv, '--resume')];
const resultsIn = (prompt: string) => prompt.split('Recent results')[1].split('\n\n')[0].trim().split('\n').slice(1);
const lastPrompt = (botId: string) => turnsOf(botId).at(-1)!.prompt;

async function runNow(app: App, routine: Routine, trigger: 'manual' | 'webhook' = 'manual', payload: string | null = null) {
  const run = app.engine.triggerRoutine(routine.id, trigger, payload);
  return until(() => {
    const r = app.store.findRun(run.id);
    return r && (r.status === 'succeeded' || r.status === 'failed') && app.engine.statusOf(routine.botId).state === 'idle' && r;
  });
}

const CHAT_SESSION = 'e65ce95f-f0a9-4921-bf85-004911bc3c05';

test('a routine set to haiku on a sonnet Boton runs with --model haiku; chat turns keep sonnet and the chat session', async () => {
  claude.script('claude/reply');
  const bot = storeBot('Claudia', 'claude-cli', { model: 'sonnet' });
  await chat(bot.id, 'hello');
  assert.equal(app.store.getBot(bot.id).sessionId, CHAT_SESSION);

  // In the chat's session (the default): it resumes the chat with its own model.
  const inChat = app.store.createRoutine(bot.id, { name: 'Shared check', instruction: 'Check', model: 'haiku' });
  claude.script('claude/reply');
  const run = await runNow(app, inChat);
  assert.deepEqual(modelAndResume(claude.calls()[0].argv), ['haiku', CHAT_SESSION]);
  assert.equal(run.model, 'claude-haiku-5-5');
  const reply = app.store.listMessages(bot.id).filter((m) => m.meta?.runId === run.id && m.role === 'bot')[0];
  assert.match(reply.meta?.model ?? '', /haiku/);
  const rows = app.store.db.prepare('select requested_model, model from turns where run_id = ?').all(run.id);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ requested_model: 'haiku', model: 'claude-haiku-5-5' }]);

  // In its own session: a new session of its own, never the chat's, with no replay of the chat.
  const own = app.store.createRoutine(bot.id, { name: 'Own check', instruction: 'Check', model: 'haiku', session: 'own' });
  claude.script('claude/tool-use');
  await runNow(app, own);
  const [first] = claude.calls();
  assert.deepEqual(modelAndResume(first.argv), ['haiku', null]);
  assert.ok(!first.stdin.includes('<conversation_so_far>'));
  assert.equal(app.store.routineSession(own.id).sessionId, '3877e94e-b431-45fb-9674-e80bbeb87722');
  claude.script('claude/tool-use');
  await runNow(app, own);
  assert.equal(argOf(claude.calls()[0].argv, '--resume'), '3877e94e-b431-45fb-9674-e80bbeb87722');

  // Chat: still sonnet, still the same session.
  claude.script('claude/reply');
  await chat(bot.id, 'and you?');
  assert.deepEqual(modelAndResume(claude.calls()[0].argv), ['sonnet', CHAT_SESSION]);
  assert.equal(app.store.getBot(bot.id).sessionId, CHAT_SESSION);
});

test("an own-session routine never touches the chat session; the next chat prompt lacks its payload but has its result", async () => {
  const bot = storeBot('Kevin');
  await chat(bot.id, 'hello');
  const chatSession = app.store.getBot(bot.id).sessionId!;
  // A long instruction, so the mock's echo of the run's prompt stops before the payload.
  const instruction = `Summarize the event in one line. ${'Mind the details. '.repeat(30)}`;
  const routine = app.store.createRoutine(bot.id, { name: 'Hook check', instruction, webhook: true, session: 'own' });
  const run = await runNow(app, routine, 'webhook', JSON.stringify({ secret: 'PAYLOAD-XYZ-123' }));
  assert.equal(run.status, 'succeeded');
  const runTurn = turnsOf(bot.id).at(-1)!;
  assert.equal(runTurn.sessionId, null);
  assert.ok(runTurn.prompt.includes('PAYLOAD-XYZ-123'));
  assert.ok(runTurn.prompt.includes('This routine runs in its own session'));
  assert.ok(!runTurn.prompt.includes('<conversation_so_far>'));
  assert.equal(app.store.getBot(bot.id).sessionId, chatSession);
  const ownSession = app.store.routineSession(routine.id).sessionId;
  assert.ok(ownSession && ownSession !== chatSession);
  // Its result is still posted in the chat.
  assert.ok(app.store.listMessages(bot.id).some((m) => m.role === 'bot' && m.meta?.runId === run.id));

  await chat(bot.id, 'what did the hook say?');
  const chatTurn = turnsOf(bot.id).at(-1)!;
  assert.equal(chatTurn.sessionId, chatSession);
  assert.ok(!chatTurn.prompt.includes('PAYLOAD-XYZ-123'));
  assert.match(chatTurn.prompt, /Recent results of your routines that run in their own session[^\n]*:\n- [^\n]+, "Hook check" \(rt_\w+\): Echo: Routine "Hook check"/);
  const line = chatTurn.prompt.split('\n').find((l) => l.includes('"Hook check" (rt_'))!;
  assert.ok(line.length < 300 + 80, line);

  // The next run resumes its own session, not the chat's.
  await runNow(app, routine, 'webhook', '{}');
  assert.equal(turnsOf(bot.id).at(-1)!.sessionId, ownSession);
});

test("at most 3 own-session results are in the context, quiet and failed ones saying so, and a routine that runs often can't push the others' out", async () => {
  const bot = storeBot('Stuart');
  const inChat = app.store.createRoutine(bot.id, { name: 'Shared', instruction: 'Shared job' });
  await runNow(app, inChat);
  await chat(bot.id, 'hi');
  assert.ok(!lastPrompt(bot.id).includes('Recent results'), 'no own-session routines: the context is as before');

  const poll = app.store.createRoutine(bot.id, { name: 'Poll', instruction: 'QUIET_PLEASE:nothing new', session: 'own' });
  const fails = app.store.createRoutine(bot.id, { name: 'Flaky', instruction: 'FAIL_PLEASE', session: 'own' });
  const report = app.store.createRoutine(bot.id, { name: 'Report', instruction: 'Report', session: 'own' });
  for (const r of [report, poll, fails, report]) await runNow(app, r);
  await chat(bot.id, 'status?');
  const results = resultsIn(lastPrompt(bot.id));
  assert.equal(results.length, 3);
  assert.match(results[0], /"Report" .*: Echo: Routine "Report"/);
  assert.match(results[1], /"Flaky" .*: failed: Mock failure requested/);
  assert.match(results[2], /"Poll" .*: quiet: nothing new/);
  // A routine's own-session turn isn't told about them; a chat-session run is.
  await runNow(app, report);
  assert.ok(!lastPrompt(bot.id).includes('Recent results'));
  await runNow(app, inChat);
  assert.ok(lastPrompt(bot.id).includes('Recent results'));
  // The routine list in the context says which run apart, and on what model.
  app.store.updateRoutine(report.id, { model: 'small' });
  await chat(bot.id, 'again');
  assert.match(lastPrompt(bot.id), /"Report": no schedule, active, model small, own session/);

  const busy = storeBot('Kevin');
  const weekly = app.store.createRoutine(busy.id, { name: 'Weekly', instruction: 'Weekly report', session: 'own' });
  const check = app.store.createRoutine(busy.id, { name: 'Check', instruction: 'QUIET_PLEASE:all fine', session: 'own' });
  await runNow(app, weekly);
  for (let i = 0; i < 4; i++) await runNow(app, check);
  await chat(busy.id, 'status?');
  // Newest first: the check's latest, the slot left over, and the weekly report.
  const often = resultsIn(lastPrompt(busy.id));
  assert.equal(often.length, 3);
  assert.match(often[0], /"Check" .*: quiet: all fine/);
  assert.match(often[1], /"Check" .*: quiet: all fine/);
  assert.match(often[2], /"Weekly" .*: Echo: Routine "Weekly"/);
});

test('own sessions survive a restart, keep retries and quiet runs, and Start fresh or moving back to chat drops them', async () => {
  const first = await start();
  const bot = first.storeBot('Bob');
  const routine = first.app.store.createRoutine(bot.id, { name: 'Nightly', instruction: 'Do it', schedule: 'every 1h', session: 'own', model: 'tiny' });
  // A network error is tried again, in the same own session, on the same model.
  first.mock.failNext(bot.id, new ProviderError('API Error: Connection error.', false, { kind: 'transient' }));
  const run = first.app.engine.fireScheduled(first.app.store.getRoutine(routine.id))!;
  await until(() => first.app.store.findRun(run.id)?.status === 'succeeded');
  assert.deepEqual(first.turnsOf(bot.id).map((t) => [t.sessionId, t.model]), [[null, 'tiny'], [null, 'tiny']]);
  const own = first.app.store.routineSession(routine.id).sessionId!;
  assert.ok(own);
  assert.equal(first.app.store.getBot(bot.id).sessionId, null, 'the chat session was never written');
  await first.stop();

  // After a restart the next run resumes it.
  const second = await start(first.home);
  await runNow(second.app, routine);
  assert.equal(second.turnsOf(bot.id).at(-1)!.sessionId, own);

  // A quiet run posts nothing in the chat, in its own session too.
  second.app.store.updateRoutine(routine.id, { instruction: 'QUIET_PLEASE' });
  const before = second.app.store.listMessages(bot.id).length;
  const quiet = await runNow(second.app, routine);
  assert.equal(quiet.quiet, true);
  assert.equal(second.app.store.listMessages(bot.id).length, before);

  // Start fresh drops the routines' own sessions too.
  second.app.store.resetContext(bot.id);
  assert.equal(second.app.store.routineSession(routine.id).sessionId, null);
  await runNow(second.app, routine);
  const fresh = second.app.store.routineSession(routine.id).sessionId;
  assert.ok(fresh && fresh !== own);
  // Back to the chat's session: its own is dropped, and runs resume the chat's.
  second.app.store.updateRoutine(routine.id, { session: 'chat' });
  assert.equal(second.app.store.routineSession(routine.id).sessionId, null);
  await second.chat(bot.id, 'hello');
  const chatSession = second.app.store.getBot(bot.id).sessionId;
  await runNow(second.app, routine);
  assert.equal(second.turnsOf(bot.id).at(-1)!.sessionId, chatSession);
});

test("a fresh session's transcript after 30 routine runs still has the owner's last messages", async () => {
  const bot = storeBot('Busy');
  await chat(bot.id, 'Remember the blue folder');
  await chat(bot.id, 'And the red one');
  const routine = app.store.createRoutine(bot.id, { name: 'Every minute', instruction: 'Tick' });
  for (let i = 0; i < 30; i++) {
    const meta = { routineId: routine.id, routineName: routine.name, runId: `run_${i}` };
    app.store.addMessage(bot.id, 'event', 'Ran routine', { ...meta, kind: 'routine.run', trigger: 'schedule' });
    app.store.addMessage(bot.id, 'bot', `Tick ${i}: all good. ${'Checked the feeds again. '.repeat(40)}`, meta);
  }
  // Routine messages have a share of the budget apart from the chat: the latest of them fit it, older ones don't.
  const src = app.store.replaySource(bot.id, null, []);
  const { text, plan } = sessionStart({ ...src }, app.store.getSettings(), 'UTC');
  assert.ok(text.includes('Remember the blue folder') && text.includes('And the red one'), text);
  assert.ok(text.includes('Tick 29: all good'), 'the latest routine results stay');
  assert.ok(!text.includes('Tick 0: all good'));
  assert.ok(plan.routines > 2 && plan.routines < 30, JSON.stringify(plan));
  assert.equal(plan.olderLeftOut, true);
  const routineLines = text.split('\n').filter((l) => l.includes('Tick ') || l.includes('Ran routine'));
  assert.ok(routineLines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) <= ROUTINE_SHARE);
  assert.ok(text.indexOf('And the red one') < text.indexOf('Tick 29: all good'));

  // A turn that has to start a new session replays it.
  const bot0 = app.store.getBot(bot.id);
  app.store.setSession(bot.id, null, null, { contextSince: bot0.contextSince, provider: bot0.provider, generation: app.store.switchGeneration(bot.id) });
  await chat(bot.id, 'What were the folders?');
  const replay = turnsOf(bot.id).at(-1)!;
  assert.equal(replay.sessionId, null);
  assert.match(replay.prompt, /<conversation_so_far>[\s\S]*Remember the blue folder[\s\S]*And the red one[\s\S]*Tick 29: all good[\s\S]*<\/conversation_so_far>/);
  const row = app.store.db.prepare('select replayed_transcript from turns where bot_id = ? order by started_at desc, rowid desc limit 1').get(bot.id) as { replayed_transcript: number };
  assert.equal(row.replayed_transcript, 1);
});

test('the API checks a routine\'s model and session; a boton\'s `botons` CLI can set and clear them', async () => {
  const bot = storeBot('Clia');
  assert.throws(() => app.store.createRoutine(bot.id, { name: 'x', instruction: 'y', session: 'shared' as never }), /session must be "chat" or "own"/);
  assert.throws(() => app.store.createRoutine(bot.id, { name: 'x', instruction: 'y', model: 'm'.repeat(121) }), /model is too long/);
  assert.throws(() => app.store.createRoutine(bot.id, { name: 'x', instruction: 'y', model: 5 as never }), /model must be a string/);
  const plain = app.store.createRoutine(bot.id, { name: 'Plain', instruction: 'y', model: '  ' });
  assert.deepEqual([plain.model, plain.session], [null, 'chat']);

  const cli = (...args: string[]) => botonCli(app, base, bot.id, ...args);
  const created = await cli('routine', 'create', '--name', 'Quick check', '--instruction', 'Look', '--schedule', 'every 15m', '--model', 'haiku', '--session', 'own', '--json');
  assert.equal(created.code, 0, created.stderr);
  const r = JSON.parse(created.stdout) as Routine;
  assert.deepEqual([r.model, r.session], ['haiku', 'own']);
  const listed = await cli('routine', 'list');
  assert.match(listed.stdout, /Quick check {2}\(Every 15 minutes, active, next [^)]*, model haiku, own session\)/);

  assert.equal((await cli('routine', 'update', r.id, '--no-model')).code, 0);
  assert.equal(app.store.getRoutine(r.id).model, null);
  assert.equal((await cli('routine', 'update', r.id, '--model', 'opus', '--session', 'chat')).code, 0);
  assert.deepEqual([app.store.getRoutine(r.id).model, app.store.getRoutine(r.id).session], ['opus', 'chat']);
  assert.equal((await cli('routine', 'update', r.id, '--model', '')).code, 0);
  assert.equal(app.store.getRoutine(r.id).model, null);
  const bad = await cli('routine', 'update', r.id, '--session', 'mine');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /session must be "chat" or "own"/);
  assert.match((await cli('help')).stdout, /--model <id> \| --no-model\]\n\s+\[--effort <level> \| --no-effort\] \[--session chat\|own\]/);
});

test("a routine's own model: moving the Boton to another provider resets it, with a chip; a run that fails on it says where to look", async () => {
  const bot = storeBot('Mover', 'claude-cli', { model: 'sonnet' });
  const quick = app.store.createRoutine(bot.id, { name: 'Quick check', instruction: 'Check', model: 'haiku' });
  const plain = app.store.createRoutine(bot.id, { name: 'Plain', instruction: 'Check' });
  const events: ServerEvent[] = [];
  const unsubscribe = app.hub.subscribe((e) => events.push(e));
  try {
    await app.engine.updateBot(bot.id, { provider: 'codex-cli', model: '' }, app.providers.ids());
  } finally {
    unsubscribe();
  }
  assert.equal(app.store.getRoutine(quick.id).model, null);
  assert.equal(app.store.getRoutine(plain.id).model, null);
  assert.ok(events.some((e) => e.type === 'routine.upserted' && e.routine.id === quick.id && e.routine.model === null));
  const chip = app.store.listMessages(bot.id).find((m) => m.meta?.kind === 'routine.model_reset')!;
  assert.match(chip.text, /^Moved to .+, so routine “Quick check” \(was haiku\) now uses the Boton's model$/);
  assert.deepEqual([chip.meta?.routineId, chip.meta?.routineName], [quick.id, 'Quick check']);

  codex.script('codex/reply');
  await runNow(app, app.store.getRoutine(quick.id));
  const [call] = codex.calls();
  assert.ok(!call.argv.includes('haiku'), call.argv.join(' '));
  // Moving again with no routine models changes nothing and says nothing (the run left a Codex session, so it's confirmed).
  const back = await app.engine.switchPreview(bot.id, { provider: 'claude-cli' });
  await app.engine.updateBot(bot.id, { provider: 'claude-cli' }, app.providers.ids(), back.confirmation);
  assert.equal(app.store.listMessages(bot.id).filter((m) => m.meta?.kind === 'routine.model_reset').length, 1);

  const picky = storeBot('Picky');
  const odd = app.store.createRoutine(picky.id, { name: 'Odd model', instruction: 'Check', model: 'no-such-model' });
  mock.failNext(picky.id, new ProviderError('model "no-such-model" does not exist', false, { kind: 'other', retryAt: null }));
  const run = await runNow(app, odd);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /This routine asks for the model “no-such-model”, not the Boton's/);
});

test('the replay reads as far back as its budget goes, past any page, and says older chat is left out only when it is', async () => {
  const bot = storeBot('Stuart');
  const routine = app.store.createRoutine(bot.id, { name: 'Tick', instruction: 'Tick' });
  // More short messages than a page, of the chat and of routines, all of which fit: every one is given.
  const chatCount = REPLAY_PAGE * 2 + 50;
  const routineCount = REPLAY_PAGE + 10;
  for (let i = 0; i < chatCount; i++) app.store.addMessage(bot.id, i % 2 ? 'bot' : 'user', `c${i}`);
  for (let i = 0; i < routineCount; i++) app.store.addMessage(bot.id, 'bot', `r${i}`, { routineId: routine.id, routineName: routine.name });
  const count = (sql: string) => Number(app.store.db.prepare(`select count(*) as n from messages where bot_id = ? and ${sql}`).get(bot.id)!.n);
  const routineRows = count("json_extract(meta, '$.routineId') is not null");
  assert.ok(routineRows > routineCount - 1 && count("json_extract(meta, '$.routineId') is null") === chatCount);
  const all = sessionStart(app.store.replaySource(bot.id, null, []), app.store.getSettings(), 'UTC');
  assert.deepEqual([all.plan.messages, all.plan.routines, all.plan.olderLeftOut], [chatCount, routineRows, false], JSON.stringify(all.plan));
  assert.ok(all.plan.used < REPLAY_BUDGET / 2, JSON.stringify(all.plan));
  assert.ok(!all.text.includes('Older messages are left out'));

  // A history longer than the budget holds: the budget is filled, and the rest is said to be left out.
  for (let i = 0; i < 2500; i++) app.store.addMessage(bot.id, i % 2 ? 'bot' : 'user', `later ${i}`);
  const full = sessionStart(app.store.replaySource(bot.id, null, []), app.store.getSettings(), 'UTC');
  assert.equal(full.plan.olderLeftOut, true);
  assert.ok(full.plan.messages > REPLAY_PAGE * 5, JSON.stringify(full.plan));
  assert.ok(full.plan.used <= REPLAY_BUDGET && full.plan.used > REPLAY_BUDGET - 1000, JSON.stringify(full.plan));
  assert.ok(full.text.includes('later 2499') && !full.text.includes('] Sam: c0\n'));
  assert.ok(full.text.includes('Older messages are left out'));
});
