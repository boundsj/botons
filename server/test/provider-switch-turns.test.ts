import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderSwitchPreview } from '../../shared/types.ts';
import type { TurnRequest } from '../src/providers/types.ts';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

// One turn at a time, so a second Boton's turn waits for the slot; the mock's turns wait for the test to let them go.
useTestCodexHome(tempDir('botons-provider-switch-turns-'));
const server = await startServer({ fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h', BOTONS_MAX_CONCURRENT: '1' } });

const switches = (botId: string) => server.app.store.listMessages(botId).filter((m) => m.meta?.kind === 'provider.switched');
const preview = async (botId: string, body: Record<string, unknown>) => {
  const res = await server.call<ProviderSwitchPreview>('POST', `/api/bots/${botId}/switch-preview`, body);
  assert.equal(res.status, 200, res.text);
  return res.data;
};
const patch = (botId: string, body: Record<string, unknown>) => server.call('PATCH', `/api/bots/${botId}`, body);

/** The Boton's mock turns wait until `release()`, replying `reply`; `started` resolves when one has begun. */
function hold(botId: string, reply = 'Done on the mock') {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let begun!: (t: TurnRequest) => void;
  const started = new Promise<TurnRequest>((r) => (begun = r));
  server.mock.script = async (t) => {
    if (t.env.BOTON_BOT_ID !== botId) return null;
    begun(t);
    await gate;
    return reply;
  };
  return { release, started };
}

test("the first turn, before any session is saved, is one the move ends: refused unconfirmed, and the old turn can't keep its session", async () => {
  const bot = server.storeBot('Kevin', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const { release, started } = hold(bot.id, 'Kevin replies from the mock');
  server.app.engine.sendMessage(bot.id, 'start on the mock');
  await started;
  assert.equal(server.app.store.getBot(bot.id).sessionId, null);

  const move = { provider: 'codex-cli', model: '' };
  const p = await preview(bot.id, move);
  assert.deepEqual([p.required, p.working, p.sessions.chat], [true, true, true]);
  const refused = await patch(bot.id, move);
  assert.equal(refused.status, 409, refused.text);
  assert.equal(server.app.store.getBot(bot.id).provider, 'mock');
  assert.equal(switches(bot.id).length, 0);

  const ok = await patch(bot.id, { ...move, switchConfirmation: p.confirmation });
  assert.equal(ok.status, 200, ok.text);
  const h = switches(bot.id)[0].meta!.handoff!;
  assert.deepEqual([h.sessionEnded, h.working], [true, true]);

  // The old turn finishes on the mock and its reply stands; its session is not kept for the Boton now on Codex.
  release();
  await until(() => server.app.engine.statusOf(bot.id).state === 'idle' && server.app.store.listMessages(bot.id).some((m) => m.role === 'bot'));
  server.mock.script = null;
  assert.ok(server.app.store.listMessages(bot.id).some((m) => m.role === 'bot' && m.text === 'Kevin replies from the mock'));
  const after = server.app.store.getBot(bot.id);
  assert.deepEqual([after.provider, after.sessionId], ['codex-cli', null]);

  // The new session starts with the note, which says the session ended, and the old turn's reply in the replay.
  server.codex.script('codex/reply');
  await server.chat(bot.id, 'and now?');
  const [call] = server.codex.calls();
  assert.ok(!call.argv.includes('resume'), call.argv.join(' '));
  const note = call.stdin.slice(call.stdin.indexOf('<provider_switch>'), call.stdin.indexOf('</provider_switch>'));
  assert.match(note, /Your session on Mock ended with the move/);
  assert.match(note, /A turn was still underway on Mock at the move: it finished there/);
  assert.ok(call.stdin.slice(call.stdin.indexOf('<conversation_so_far>')).includes('Kevin replies from the mock'));
  assert.equal(switches(bot.id)[0].meta?.handoffDone, true);
});

test('a turn setting up (its connectors, before the CLI starts) is underway; one still waiting for a slot runs on the new provider', async () => {
  // Stuart's turn holds the only slot.
  const stuart = server.storeBot('Stuart', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const { release, started } = hold(stuart.id);
  server.app.engine.sendMessage(stuart.id, 'busy');
  await started;

  // Bob's turn waits for the slot: it hasn't read Bob yet, so a move now loses nothing.
  const bob = server.storeBot('Bob', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  server.app.engine.sendMessage(bob.id, 'waiting');
  await new Promise((r) => setImmediate(r));
  const waiting = await preview(bob.id, { provider: 'codex-cli' });
  assert.deepEqual([waiting.required, waiting.working], [false, false]);

  // Bob moves while waiting (no confirmation): his turn then runs on Codex.
  assert.equal((await patch(bob.id, { provider: 'codex-cli' })).status, 200);
  server.codex.script('codex/reply');
  release();
  await until(() => server.app.store.listMessages(bob.id).some((m) => m.role === 'bot') && server.app.engine.statusOf(bob.id).state === 'idle');
  assert.equal(server.codex.calls().length, 1);
  assert.equal(server.app.store.getBot(bob.id).provider, 'codex-cli');
  server.mock.script = null;

  // Dave's turn has read Dave and is setting up its connectors: no agent process yet, and not "working" in its status.
  const dave = server.storeBot('Dave', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const connectors = server.app.connectors;
  const resolve = connectors.resolve.bind(connectors);
  let setUp!: () => void;
  const settingUp = new Promise<void>((r) => (setUp = r));
  let reached!: () => void;
  const atSetup = new Promise<void>((r) => (reached = r));
  connectors.resolve = (async (...args: Parameters<typeof resolve>) => {
    reached();
    await settingUp;
    return resolve(...args);
  }) as typeof connectors.resolve;
  try {
    server.app.engine.sendMessage(dave.id, 'set up first');
    await atSetup;
    assert.notEqual(server.app.engine.statusOf(dave.id).state, 'working');
    assert.equal(server.mock.turns.filter((t) => t.env.BOTON_BOT_ID === dave.id).length, 0);
    const p = await preview(dave.id, { provider: 'codex-cli' });
    assert.deepEqual([p.required, p.working, p.sessions.chat], [true, true, true]);
    assert.equal((await patch(dave.id, { provider: 'codex-cli' })).status, 409);
    assert.equal(server.app.store.getBot(dave.id).provider, 'mock');
  } finally {
    connectors.resolve = resolve;
    setUp();
  }
  await until(() => server.app.engine.statusOf(dave.id).state === 'idle');
});

test('a preview made while idle is stale once a turn starts, or a run is queued', async () => {
  const bot = server.storeBot('Jerry', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  await server.chat(bot.id, 'hello');
  assert.ok(server.app.store.getBot(bot.id).sessionId);
  const move = { provider: 'codex-cli' };
  const idle = await preview(bot.id, move);
  assert.deepEqual([idle.required, idle.working, idle.queuedRuns], [true, false, 0]);

  const { release, started } = hold(bot.id);
  server.app.engine.sendMessage(bot.id, 'busy now');
  await started;
  assert.equal((await patch(bot.id, { ...move, switchConfirmation: idle.confirmation })).status, 409);
  const busy = await preview(bot.id, move);
  assert.deepEqual([busy.working, busy.queuedRuns], [true, 0]);

  const routine = server.app.store.createRoutine(bot.id, { name: 'Tidy up', instruction: 'Tidy' });
  const atReview = await preview(bot.id, move);
  server.app.engine.triggerRoutine(routine.id, 'manual', null);
  assert.equal((await patch(bot.id, { ...move, switchConfirmation: atReview.confirmation })).status, 409);
  const queued = await preview(bot.id, move);
  assert.equal(queued.queuedRuns, 1);
  assert.equal(server.app.store.getBot(bot.id).provider, 'mock');

  release();
  server.mock.script = null;
  await until(() => server.app.engine.statusOf(bot.id).state === 'idle');
});

test("a routine run on its own session, underway at the move, is the routine's session ending", async () => {
  const bot = server.storeBot('Phil', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const own = server.app.store.createRoutine(bot.id, { name: 'Night check', instruction: 'Check', session: 'own' });
  const { release, started } = hold(bot.id);
  const run = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await started;
  const p = await preview(bot.id, { provider: 'codex-cli' });
  assert.deepEqual([p.required, p.working, p.sessions.chat, p.sessions.routines], [true, true, false, [{ id: own.id, name: 'Night check' }]]);
  assert.equal((await patch(bot.id, { provider: 'codex-cli', switchConfirmation: p.confirmation })).status, 200);
  release();
  await until(() => server.app.store.findRun(run.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  server.mock.script = null;
  assert.equal(server.app.store.routineSession(own.id).sessionId, null, 'the run finished on the mock, its session not kept');
});

/** Moves the Boton to Codex (confirming what the preview shows) and straight back to the mock, with no turn on Codex. */
async function awayAndBack(botId: string) {
  const away = await preview(botId, { provider: 'codex-cli' });
  assert.equal((await patch(botId, { provider: 'codex-cli', switchConfirmation: away.confirmation })).status, 200);
  const back = await preview(botId, { provider: 'mock' });
  assert.equal((await patch(botId, { provider: 'mock', switchConfirmation: back.confirmation })).status, 200);
  assert.equal(server.app.store.getBot(botId).provider, 'mock');
  return away;
}
const turnsOf = (botId: string) => server.mock.turns.filter((t) => t.env.BOTON_BOT_ID === botId);
const noteOf = (t: TurnRequest) => t.prompt.includes('<provider_switch>');

test("moved away and back while the first turn runs: the old turn's session is not kept, and the next turn starts fresh with the note", async () => {
  const bot = server.storeBot('Carl', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const { release, started } = hold(bot.id, 'Carl replies');
  server.app.engine.sendMessage(bot.id, 'start');
  await started;
  const away = await awayAndBack(bot.id);
  assert.deepEqual([away.required, away.working], [true, true]);

  release();
  await until(() => server.app.engine.statusOf(bot.id).state === 'idle' && server.app.store.listMessages(bot.id).some((m) => m.role === 'bot'));
  server.mock.script = null;
  assert.equal(server.app.store.getBot(bot.id).sessionId, null, 'the move ended the session the old turn started');
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, undefined);

  await server.chat(bot.id, 'still there?');
  const next = turnsOf(bot.id).at(-1)!;
  assert.equal(next.sessionId, null);
  assert.ok(noteOf(next), 'the new session starts with the note');
  assert.ok(server.app.store.getBot(bot.id).sessionId);
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, true);
});

test("moved away and back while a routine runs on its own session: the run's session is not kept, and the next run starts fresh", async () => {
  const bot = server.storeBot('Jorge', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const own = server.app.store.createRoutine(bot.id, { name: 'Sweep', instruction: 'Sweep', session: 'own' });
  const { release, started } = hold(bot.id);
  const run = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await started;
  const away = await awayAndBack(bot.id);
  assert.deepEqual(away.sessions.routines, [{ id: own.id, name: 'Sweep' }]);

  release();
  await until(() => server.app.store.findRun(run.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  server.mock.script = null;
  assert.equal(server.app.store.routineSession(own.id).sessionId, null);

  const again = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await until(() => server.app.store.findRun(again.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  assert.equal(turnsOf(bot.id).at(-1)!.sessionId, null, 'a new session for the routine');
  assert.ok(server.app.store.routineSession(own.id).sessionId, 'and that one is kept');
});

test("moved away and back while a turn sets up its connectors: it neither picks up the later note nor marks it done", async () => {
  const bot = server.storeBot('Tom', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const connectors = server.app.connectors;
  const resolve = connectors.resolve.bind(connectors);
  let setUp!: () => void;
  const settingUp = new Promise<void>((r) => (setUp = r));
  let reached!: () => void;
  const atSetup = new Promise<void>((r) => (reached = r));
  connectors.resolve = (async (...args: Parameters<typeof resolve>) => {
    reached();
    await settingUp;
    return resolve(...args);
  }) as typeof connectors.resolve;
  try {
    server.app.engine.sendMessage(bot.id, 'set up first');
    await atSetup;
    await awayAndBack(bot.id);
  } finally {
    connectors.resolve = resolve;
    setUp();
  }
  await until(() => server.app.engine.statusOf(bot.id).state === 'idle' && server.app.store.listMessages(bot.id).some((m) => m.role === 'bot'));
  const old = turnsOf(bot.id);
  assert.equal(old.length, 1);
  assert.ok(!noteOf(old[0]), 'the note is for turns that read the Boton after the move');
  assert.equal(server.app.store.getBot(bot.id).sessionId, null);
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, undefined);

  await server.chat(bot.id, 'and now?');
  const next = turnsOf(bot.id).at(-1)!;
  assert.deepEqual([next.sessionId, noteOf(next)], [null, true]);
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, true);
});

test("moved away and back while a turn carries on the saved session: that session ends, and the next turn starts fresh with the note", async () => {
  const bot = server.storeBot('Mel', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  await server.chat(bot.id, 'hello');
  const saved = server.app.store.getBot(bot.id).sessionId;
  assert.ok(saved);
  const { release, started } = hold(bot.id, 'Mel replies');
  server.app.engine.sendMessage(bot.id, 'carry on');
  try {
    assert.equal((await started).sessionId, saved, 'the second turn resumes the saved session');
    const away = await preview(bot.id, { provider: 'codex-cli' });
    assert.deepEqual([away.required, away.working, away.sessions.chat], [true, true, true]);
    assert.equal((await patch(bot.id, { provider: 'codex-cli', switchConfirmation: away.confirmation })).status, 200);
    assert.equal(server.app.store.getBot(bot.id).sessionId, null, 'the move ends the session the turn underway is carrying on');
    const back = await preview(bot.id, { provider: 'mock' });
    assert.deepEqual([back.required, back.working, back.sessions.chat], [false, false, false], 'nothing left to lose on the way back');
    assert.equal((await patch(bot.id, { provider: 'mock' })).status, 200);
  } finally {
    release();
  }
  await until(() => server.app.engine.statusOf(bot.id).state === 'idle' && server.app.store.listMessages(bot.id).some((m) => m.text === 'Mel replies'));
  server.mock.script = null;
  assert.equal(server.app.store.getBot(bot.id).sessionId, null);

  await server.chat(bot.id, 'still there?');
  const next = turnsOf(bot.id).at(-1)!;
  assert.equal(next.sessionId, null, 'not the session the move ended');
  assert.ok(noteOf(next), 'the new session starts with the note');
  assert.match(next.prompt, /Your session on Mock ended with the move/);
  assert.match(next.prompt, /A turn was still underway on Mock at the move/);
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, true);
});

test("moved away and back while a routine run carries on its own saved session: that session ends, and the next run starts fresh", async () => {
  const bot = server.storeBot('Otto', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const own = server.app.store.createRoutine(bot.id, { name: 'Tally', instruction: 'Tally', session: 'own' });
  const first = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await until(() => server.app.store.findRun(first.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  const saved = server.app.store.routineSession(own.id).sessionId;
  assert.ok(saved);
  const chatBefore = server.app.store.getBot(bot.id).sessionId;
  const { release, started } = hold(bot.id);
  const run = server.app.engine.triggerRoutine(own.id, 'manual', null);
  try {
    assert.equal((await started).sessionId, saved, 'the second run resumes its saved session');
    const away = await awayAndBack(bot.id);
    assert.deepEqual(away.sessions.routines, [{ id: own.id, name: 'Tally' }]);
    assert.equal(server.app.store.routineSession(own.id).sessionId, null, 'the move ends the session the run underway is carrying on');
    assert.equal(server.app.store.getBot(bot.id).sessionId, chatBefore, "the chat's session is not the run's");
  } finally {
    release();
  }
  await until(() => server.app.store.findRun(run.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  server.mock.script = null;
  const again = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await until(() => server.app.store.findRun(again.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  assert.equal(turnsOf(bot.id).at(-1)!.sessionId, null, 'not the session the move ended');
  assert.ok(server.app.store.routineSession(own.id).sessionId, 'the new one is kept');
});

test('moved away and back while idle: the saved session resumes, without the note', async () => {
  const bot = server.storeBot('Ken', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  await server.chat(bot.id, 'hello');
  const saved = server.app.store.getBot(bot.id).sessionId;
  assert.ok(saved);
  await awayAndBack(bot.id);
  await server.chat(bot.id, 'back again');
  const next = turnsOf(bot.id).at(-1)!;
  assert.deepEqual([next.sessionId, noteOf(next)], [saved, false]);
  assert.equal(server.app.store.getBot(bot.id).sessionId, saved);
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, true);
});

test("moved away and back while idle: a routine's own saved session resumes", async () => {
  const bot = server.storeBot('Norbert', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const own = server.app.store.createRoutine(bot.id, { name: 'Count', instruction: 'Count', session: 'own' });
  const first = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await until(() => server.app.store.findRun(first.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  const saved = server.app.store.routineSession(own.id).sessionId;
  assert.ok(saved);
  await awayAndBack(bot.id);
  assert.equal(server.app.store.routineSession(own.id).sessionId, saved);
  const again = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await until(() => server.app.store.findRun(again.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  assert.equal(turnsOf(bot.id).at(-1)!.sessionId, saved);
});

test("each switch is a new generation: a turn's stamp from before it can neither keep a session nor mark its note done", async () => {
  const bot = server.storeBot('Herb', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  const store = server.app.store;
  const before = { contextSince: store.getBot(bot.id).contextSince, provider: 'mock', generation: store.switchGeneration(bot.id) };
  assert.equal(before.generation, 0);
  assert.equal((await patch(bot.id, { provider: 'codex-cli' })).status, 200);
  const g1 = store.switchGeneration(bot.id);
  assert.equal((await patch(bot.id, { provider: 'mock' })).status, 200);
  const g2 = store.switchGeneration(bot.id);
  assert.ok(g1 > 0 && g2 > g1);
  const [first, second] = switches(bot.id);
  assert.equal(store.setSession(bot.id, 'old-session', null, before), false, 'the provider matches again, the generation does not');
  assert.equal(store.endHandoff(second.id, g1), false, 'an earlier generation');
  assert.equal(store.endHandoff(first.id, g2), false, 'another switch than the latest');
  assert.equal(switches(bot.id).at(-1)!.meta?.handoffDone, undefined);
  assert.equal(store.setSession(bot.id, 'new-session', null, { ...before, generation: g2 }), true);
  assert.equal(store.endHandoff(second.id, g2), true);
});

// Last: Codex's usage limit stays for the rest of this server.
test('a usage limit that starts after the review refuses the confirmation', async () => {
  const bot = server.storeBot('Mark', 'mock', process.platform === 'linux' ? {} : { access: 'host' });
  await server.chat(bot.id, 'hello');
  const p = await preview(bot.id, { provider: 'codex-cli' });
  assert.equal(p.readiness.usageLimitUntil, null);

  const other = server.storeBot('Otto', 'codex-cli');
  server.codex.script('codex/usage-limit');
  server.app.engine.sendMessage(other.id, 'hello');
  await until(() => server.app.engine.usageLimit('codex-cli'));

  const res = await patch(bot.id, { provider: 'codex-cli', switchConfirmation: p.confirmation });
  assert.equal(res.status, 409, res.text);
  assert.equal(server.app.store.getBot(bot.id).provider, 'mock');
  const now = await preview(bot.id, { provider: 'codex-cli' });
  assert.ok(now.readiness.usageLimitUntil);
  assert.equal((await patch(bot.id, { provider: 'codex-cli', switchConfirmation: now.confirmation })).status, 200);
});
