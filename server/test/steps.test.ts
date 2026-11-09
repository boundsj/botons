import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, Message, RoutineRun, TurnSteps } from '../../shared/types.ts';
import { DRAFT_EVERY_MS } from '../src/engine.ts';
import { MAX_STEP_DETAIL, MAX_STEPS } from '../src/store.ts';
import { sleep, startServer, type TestServer, until } from './helpers.ts';

const env = { BOTONS_SCHEDULER_MS: '1h' };
const s = await startServer({ env });

const messages = (srv: TestServer, botId: string) => srv.app.store.listMessages(botId);
const lastOf = (srv: TestServer, botId: string, pick: (m: Message) => boolean) => messages(srv, botId).filter(pick).at(-1);
const untimed = (t: TurnSteps) => t.steps.map(({ at: _at, ...rest }) => rest);

test('a turn keeps the steps it ran under its reply: full commands, the first 200 and each cut at 2000 characters; devices only', async () => {
  const bot = await s.newBot('Kevin');
  const long = `echo ${'x'.repeat(3000)}`;
  await s.send(bot.id, `How much disk is free?\nSTEP_PLEASE:df -h\nSTEP_PLEASE:${long}\nSTEP_PLEASE:249xls`);
  const reply = await until(() => lastOf(s, bot.id, (m) => m.role === 'bot'));
  assert.equal(reply.meta?.steps, 251);
  const { status, data } = await s.call<TurnSteps>('GET', `/api/messages/${reply.id}/steps`);
  assert.equal(status, 200);
  assert.deepEqual([data.turnId, data.outcome, data.total, data.steps.length], [reply.meta?.turnId, 'ok', 251, MAX_STEPS]);
  assert.deepEqual(untimed(data)[0], { kind: 'command', label: 'Running `df -h`', detail: 'df -h' });
  assert.equal(data.steps[1].detail.length, MAX_STEP_DETAIL);
  assert.ok(data.steps[1].detail.endsWith('…'));
  assert.equal(data.steps[2].detail, 'ls');
  const mine = messages(s, bot.id).find((m) => m.role === 'user')!;
  assert.equal((await s.call('GET', `/api/messages/${mine.id}/steps`)).status, 404);
  assert.equal((await s.call('GET', '/api/messages/msg_nope/steps')).status, 404);
  // Steps can hold secrets: devices only, not a Boton's own token.
  const boton = s.app.auth.mintBotonToken(bot.id);
  assert.equal((await s.call('GET', `/api/messages/${reply.id}/steps`, undefined, boton.token)).status, 403);
  boton.revoke();
});

test('a stopped or failed turn keeps its steps, on its Stopped chip or its error', async () => {
  const bot = await s.newBot('Stuart');
  await s.send(bot.id, 'STEP_PLEASE:df -h\nSLOW_PLEASE');
  await until(() => s.app.engine.statusOf(bot.id).activity === 'Running `df -h`');
  await s.call('POST', `/api/bots/${bot.id}/stop`, {});
  const chip = await until(() => lastOf(s, bot.id, (m) => m.meta?.kind === 'turn.stopped'));
  assert.equal(chip.meta?.steps, 1);
  const stopped = (await s.call<TurnSteps>('GET', `/api/messages/${chip.id}/steps`)).data;
  assert.equal(stopped.outcome, 'stopped');
  assert.deepEqual(untimed(stopped), [{ kind: 'command', label: 'Running `df -h`', detail: 'df -h' }]);
  await s.untilState(bot.id, 'idle');

  await s.send(bot.id, 'STEP_PLEASE:rm -rf build\nFAIL_PLEASE');
  const error = await until(() => lastOf(s, bot.id, (m) => m.role === 'error'));
  assert.equal(error.meta?.steps, 1);
  const failed = (await s.call<TurnSteps>('GET', `/api/messages/${error.id}/steps`)).data;
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.steps[0].detail, 'rm -rf build');
});

test("a routine run's steps show in its history, after a restart too", async () => {
  const first = await startServer({ env });
  const bot = await first.newBot('Bob');
  const routine = await first.newRoutine(bot.id, { name: 'Disk check', instruction: 'Check the disk.\nSTEP_PLEASE:df -h' });
  const { data: queued } = await first.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`);
  const run = await until(async () => (await first.runsOf(routine.id)).find((r) => r.id === queued.id && r.status === 'succeeded'));
  assert.equal(run.steps, 1);
  const before = (await first.call<TurnSteps[]>('GET', `/api/runs/${run.id}/steps`)).data;
  assert.equal(before.length, 1);
  assert.deepEqual(untimed(before[0]), [{ kind: 'command', label: 'Running `df -h`', detail: 'df -h' }]);
  const reply = lastOf(first, bot.id, (m) => m.role === 'bot')!;
  assert.deepEqual([reply.meta?.runId, reply.meta?.steps], [run.id, 1]);
  assert.equal((await first.call('GET', '/api/runs/run_nope/steps')).status, 404);

  await first.stop();
  const again = await startServer({ env, home: first.home });
  assert.equal((await again.runsOf(routine.id))[0].steps, 1);
  assert.deepEqual((await again.call<TurnSteps[]>('GET', `/api/runs/${run.id}/steps`)).data, before);
  assert.deepEqual((await again.call<TurnSteps>('GET', `/api/messages/${reply.id}/steps`)).data, before[0]);
});

test("the reply streams as throttled message.draft events, mid-turn clients see the draft, the reply replaces it; a routine's quiet reply never shows", async () => {
  const bot = await s.newBot('Writer');
  const sse = await s.events();
  const words = 'one two three four five six seven eight nine ten eleven twelve';
  await s.send(bot.id, `STREAM_PLEASE:60 ${words}`);

  const mid = await until(async () => {
    const { data } = await s.call<Bot>('GET', `/api/bots/${bot.id}`);
    return data.status.draft?.text.includes('three') && data;
  });
  assert.equal(mid.status.state, 'working');
  assert.match(mid.status.draft!.text, /^Echo: STREAM_PLEASE:60 one two three/);

  const reply = await until(() => lastOf(s, bot.id, (m) => m.role === 'bot'));
  await s.untilState(bot.id, 'idle');
  await sleep(DRAFT_EVERY_MS * 2);

  const mine = sse.events.filter((ev) => ('botId' in ev && ev.botId === bot.id) || (ev.type === 'message.created' && ev.message.botId === bot.id));
  const drafts = mine.flatMap((ev) => (ev.type === 'message.draft' ? [ev.draft] : []));
  assert.ok(drafts.length >= 3, `${drafts.length} drafts`);
  for (const [i, d] of drafts.entries()) {
    assert.equal(d.turnId, reply.meta?.turnId);
    assert.ok(reply.text.startsWith(d.text), d.text);
    if (i > 0) {
      assert.ok(d.text.length > drafts[i - 1].text.length);
      assert.ok(Date.parse(d.at) - Date.parse(drafts[i - 1].at) >= DRAFT_EVERY_MS - 5, `${d.at} after ${drafts[i - 1].at}`);
    }
  }
  assert.ok(drafts.length < reply.text.split(' ').length, `${drafts.length} drafts`);
  // Nothing about the draft comes after the reply.
  const created = mine.findIndex((ev) => ev.type === 'message.created' && ev.message.id === reply.id);
  assert.ok(created > 0);
  assert.equal(mine.filter((ev) => ev.type === 'message.created' && ev.message.role === 'bot').length, 1);
  const afterReply = mine.slice(created + 1);
  assert.ok(!afterReply.some((ev) => ev.type === 'message.draft'));
  for (const ev of afterReply) {
    if (ev.type === 'bot.status') assert.ok(!ev.status.draft, JSON.stringify(ev));
    if (ev.type === 'bot.upserted') assert.ok(!ev.bot.status.draft, JSON.stringify(ev));
  }
  assert.ok(afterReply.some((ev) => ev.type === 'bot.status' && ev.status.state === 'idle'));
  assert.equal((await s.call<Bot>('GET', `/api/bots/${bot.id}`)).data.status.draft, undefined);

  const seen = sse.events.length;
  const quiet = await s.newRoutine(bot.id, { name: 'Poll', instruction: 'QUIET_PLEASE:nothing new\nSTREAM_PLEASE:5' });
  const { data: queued } = await s.call<RoutineRun>('POST', `/api/routines/${quiet.id}/run`);
  await until(() => s.app.store.findRun(queued.id)?.status === 'succeeded');
  assert.equal(s.app.store.findRun(queued.id)?.quiet, true);
  assert.ok(!sse.events.slice(seen).some((ev) => ev.type === 'message.draft'));

  const loud = await s.newRoutine(bot.id, { name: 'Report', instruction: 'Report.\nSTREAM_PLEASE:5' });
  const { data: run } = await s.call<RoutineRun>('POST', `/api/routines/${loud.id}/run`);
  await until(() => s.app.store.findRun(run.id)?.status === 'succeeded');
  await until(() => sse.events.some((ev) => ev.type === 'message.created' && ev.message.meta?.runId === run.id && ev.message.role === 'bot'));
  assert.ok(sse.events.slice(seen).some((ev) => ev.type === 'message.draft'));
  sse.close();
});
