import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BackgroundActivity, Bot, Message, MessageMeta, TurnSteps } from '../../shared/types.ts';
import { quietMessageIds, routineLabel } from '../../shared/wake.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer();
for (const kind of ['work.event', 'ask', 'ask.reply', 'approval.decided', 'connector.granted', 'reaction.followup', 'card.answered'] as const) {
  for (const note of ['', 'nothing new']) {
    test(`${kind}: quiet ${note ? 'note' : 'marker'} posts nothing`, async () => {
      const bot = await s.newBot('Quiet');
      const meta = { kind, ...(kind.startsWith('ask') ? { fromBotId: 'bot_missing', fromBotName: 'Helper' } : {}) } as MessageMeta;
      const input = s.app.store.addMessage(bot.id, 'user', `QUIET_PLEASE:${note}`, meta, true);
      s.mock.script = () => `[quiet] ${note}`;
      s.app.engine.queueChat(bot.id);
      await s.untilState(bot.id, 'idle');
      assert.equal((await s.messagesOf(bot.id)).filter(m => m.role === 'bot' || m.role === 'error').length, 0);
      const history = await s.call<TurnSteps>('GET', `/api/messages/${input.id}/steps`);
      assert.equal(history.status, 200);
      assert.equal(history.data.steps.at(-1)?.detail, note);
      assert.equal(s.app.store.pendingChats().filter(p => p.botId === bot.id).length, 0);
    });
  }
}

for (const trigger of ['manual', 'schedule', 'webhook'] as const) {
  test(`${trigger}: quiet note stays in run history`, async () => {
    const bot = await s.newBot('Poller');
    const routine = await s.newRoutine(bot.id);
    const before = await s.messagesOf(bot.id);
    s.mock.script = () => '[quiet] all clear';
    const run = s.app.engine.triggerRoutine(routine.id, trigger);
    await s.untilState(bot.id, 'idle');
    const saved = s.app.store.getRun(run.id);
    assert.equal(saved.quiet, true);
    assert.equal(saved.reply, 'all clear');
    assert.deepEqual(await s.messagesOf(bot.id), before);
  });
}
for (const text of ['[quiet]', '[quiet] note', '[quiet]er']) {
  test(`owner without reaction still posts ${text}`, async () => {
    const bot = await s.newBot('Owner reply');
    s.mock.script = () => text;
    assert.equal((await s.chat(bot.id, 'Hello')).text, text);
  });
}

test('quiet note survives the tool-step limit and is retrievable', async () => {
  const bot = await s.newBot('Busy');
  const input = s.app.store.addMessage(bot.id, 'user', 'update', { kind: 'work.event' }, true);
  s.mock.script = req => {
    for (let i = 0; i < 210; i++) req.onStep?.({ kind: 'tool', label: 'Check', detail: 'checked', at: new Date().toISOString() });
    return '[quiet] nothing new';
  };
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  const history = await s.call<TurnSteps>('GET', `/api/messages/${input.id}/steps`);
  assert.equal(history.status, 200);
  assert.equal(history.data.steps.at(-1)?.detail, 'nothing new');
  assert.equal(history.data.total, 211);
});

// The transcript: a quiet wake-up is marked and left out, every message still in the API; a reply shows with its wake-up.
const WAKE_META: Record<string, MessageMeta> = {
  'work.event': { kind: 'work.event', work: { connectorId: 'oauth:fleet', jobId: 'job_q1', kind: 'finished', state: 'idle', link: 'https://github.com/example/app/pull/7' } },
  ask: { kind: 'ask', fromBotId: 'bot_missing', fromBotName: 'Helper' },
  'ask.reply': { kind: 'ask.reply', fromBotId: 'bot_missing', fromBotName: 'Helper' },
  'approval.decided': { kind: 'approval.decided', decision: 'allowed' },
  'connector.granted': { kind: 'connector.granted', connectorId: 'oauth:fleet' },
  'reaction.followup': { kind: 'reaction.followup' },
};
for (const [kind, meta] of Object.entries(WAKE_META)) {
  for (const quiet of [true, false]) {
    test(`${kind}: ${quiet ? 'quiet: marked, left out of the transcript, kept in the API' : 'not quiet: shown with its reply'}`, async () => {
      const bot = await s.newBot(quiet ? 'Hush' : 'Loud');
      const input = s.app.store.addMessage(bot.id, 'user', 'Work update from fleet: job job_q1 finished its turn', meta, true);
      s.mock.script = () => (quiet ? '[quiet] checked, nothing to do' : 'PR 7 is merged and green.');
      s.app.engine.queueChat(bot.id);
      await s.untilState(bot.id, 'idle');
      const list = await s.messagesOf(bot.id);
      const wake = list.find((m) => m.id === input.id)!;
      assert.ok(wake, 'the API still returns the wake-up');
      assert.equal(!!wake.meta?.quiet, quiet);
      const hidden = quietMessageIds(list);
      assert.equal(hidden.has(input.id), quiet);
      assert.equal(list.filter((m) => m.role === 'bot').length, quiet ? 0 : 1);
      if (quiet) {
        const steps = await s.call<TurnSteps>('GET', `/api/messages/${input.id}/steps`);
        assert.equal(steps.data.steps.at(-1)?.detail, 'checked, nothing to do');
        assert.equal((await s.call<Bot>('GET', `/api/bots/${bot.id}`)).data.lastMessage, null, 'nor is it the chat’s latest line');
      } else {
        assert.equal(hidden.size, 0);
      }
    });
  }
}

test('a quiet wake-up taken with the owner’s message: the owner’s rule, nothing marked', async () => {
  const bot = await s.newBot('Mixed');
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event'], true);
  s.app.store.addMessage(bot.id, 'user', 'And how are you?', null, true);
  s.mock.script = () => '[quiet] fine';
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  const list = await s.messagesOf(bot.id);
  assert.ok(list.every((m) => !m.meta?.quiet));
  assert.equal(quietMessageIds(list).size, 0);
  assert.equal(list.at(-1)?.text, '[quiet] fine');
});

for (const kind of Object.keys(WAKE_META)) {
  test(`${kind}: a failed wake-up turn shows the wake-up and its error`, async () => {
    const bot = await s.newBot('Broken');
    const input = s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META[kind], true);
    s.mock.script = () => {
      throw new Error('the CLI fell over');
    };
    s.app.engine.queueChat(bot.id);
    await s.untilState(bot.id, 'idle');
    const list = await s.messagesOf(bot.id);
    assert.ok(list.some((m) => m.role === 'error'));
    assert.ok(!list.find((m) => m.id === input.id)!.meta?.quiet);
    assert.equal(quietMessageIds(list).size, 0);
  });
}

for (const trigger of ['manual', 'schedule', 'webhook'] as const) {
  test(`${trigger}: a reply shows under its Routine: label, with no run id`, async () => {
    const bot = await s.newBot('Runner');
    const routine = await s.newRoutine(bot.id, { name: 'Deploy watch' });
    s.mock.script = () => 'The deploy went out.';
    const run = s.app.engine.triggerRoutine(routine.id, trigger);
    await s.untilState(bot.id, 'idle');
    const list = await s.messagesOf(bot.id);
    const chip = list.find((m) => m.meta?.kind === 'routine.run')!;
    const label = routineLabel(chip.meta).text;
    assert.equal(label, trigger === 'schedule' ? 'Routine: Deploy watch' : `Routine: Deploy watch · ${trigger}`);
    assert.ok(!label.includes(run.id));
    assert.equal(quietMessageIds(list).size, 0);
  });
}

test('history from before the mark: a quiet turn linked to its wake-up reads as quiet; an old [quiet] reply goes with its wake-up', async () => {
  const bot = await s.newBot('History');
  const db = s.app.store.db;
  const linked = s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META.ask);
  const turnId = s.app.store.startTurn({ botId: bot.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
  s.app.store.saveQuietTurnNote(turnId, 0, 'nothing new');
  s.app.store.linkTurnMessage(turnId, linked.id);
  const old = s.app.store.addMessage(bot.id, 'user', 'Work update from fleet: job job_old finished its turn', WAKE_META['work.event']);
  const oldReply = s.app.store.addMessage(bot.id, 'bot', '[quiet] nothing to report');
  const owner = s.app.store.addMessage(bot.id, 'user', 'Hi');
  const ownerReply = s.app.store.addMessage(bot.id, 'bot', '[quiet]');
  const list = await s.messagesOf(bot.id);
  assert.equal(list.find((m) => m.id === linked.id)!.meta?.quiet, true);
  assert.equal(JSON.parse(String(db.prepare('select meta from messages where id = ?').get(linked.id)!.meta)).quiet, undefined, 'read as quiet, not rewritten');
  assert.deepEqual([...quietMessageIds(list)].sort(), [linked.id, old.id, oldReply.id].sort());
  assert.ok(list.some((m) => m.id === owner.id) && list.some((m) => m.id === ownerReply.id));
  // An older page reads the same.
  const page = (await s.call<Message[]>('GET', `/api/bots/${bot.id}/messages?before=${old.id}`)).data;
  assert.equal(page.find((m) => m.id === linked.id)!.meta?.quiet, true);
});

test('background activity: routine turns and wake-ups in the last hour, the quiet ones, and the latest', async () => {
  const bot = await s.newBot('Busy bee');
  assert.deepEqual((await s.call<BackgroundActivity>('GET', `/api/bots/${bot.id}/background`)).data, { lastHour: 0, quietLastHour: 0, lastAt: null, recent: [] });
  await s.chat(bot.id, 'Hello');
  assert.equal((await s.call<BackgroundActivity>('GET', `/api/bots/${bot.id}/background`)).data.lastAt, null, 'the owner’s own chat is not background');
  const routine = await s.newRoutine(bot.id);
  s.mock.script = () => '[quiet]';
  s.app.engine.triggerRoutine(routine.id, 'schedule');
  await s.untilState(bot.id, 'idle');
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event'], true);
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  s.mock.script = () => 'Something to say';
  s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask, true);
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  const a = (await s.call<BackgroundActivity>('GET', `/api/bots/${bot.id}/background`)).data;
  assert.equal(a.lastHour, 3);
  assert.equal(a.quietLastHour, 2);
  assert.ok(a.lastAt && Date.now() - Date.parse(a.lastAt) < 60_000);
  // What the background line opens: each one, newest first, the quiet ones with their notes and steps, no ids shown.
  assert.deepEqual(
    a.recent.map((i) => [i.label, i.quiet, i.note, i.outcome]),
    [
      ['Helper asked', false, null, 'ok'],
      ['fleet: PR #7 finished', true, '', 'ok'],
      ['Routine: Job', true, '', 'ok'],
    ],
  );
  assert.ok(a.recent[2].runId && a.recent[2].routineId);
  assert.ok(a.recent[1].stepsMessageId && a.recent[1].steps >= 1, 'a quiet wake-up’s note is in its steps');
  assert.ok(a.recent[0].stepsMessageId);
  assert.ok(a.recent.every((i) => !/job_q1|run_|msg_/.test(i.label)));
  const later = s.app.store.backgroundActivity(bot.id, Date.now() + 2 * 3_600_000);
  assert.equal(later.lastHour, 0);
  assert.equal(later.lastAt, a.lastAt);
  assert.equal((await s.call('GET', `/api/bots/${bot.id}/background`, undefined, null)).status, 401);
});

// --- Every message a quiet turn took, across pages, and what it did in the chat.

const page = async (botId: string, q: string) => (await s.call<Message[]>('GET', `/api/bots/${botId}/messages?${q}`)).data;
const hiddenIn = (list: Message[]) => quietMessageIds(list);

test('a quiet turn that took several wake-ups leaves them all out, live and from older history', async () => {
  // Live: two wake-ups in one batch (both for the owner: a colleague's ask gets a turn of its own), both marked.
  const live = await s.newBot('Batch');
  const a = s.app.store.addMessage(live.id, 'user', 'update', WAKE_META['work.event'], true);
  const b = s.app.store.addMessage(live.id, 'user', 'grant', WAKE_META['connector.granted'], true);
  s.mock.script = () => '[quiet] both fine';
  s.app.engine.queueChat(live.id);
  await s.untilState(live.id, 'idle');
  const list = await s.messagesOf(live.id);
  assert.deepEqual([...hiddenIn(list)].sort(), [a.id, b.id].sort());
  assert.ok(list.every((m) => m.meta?.quietTurn === list[0].meta?.quietTurn));

  // History without a next turn cannot prove which additional messages the quiet turn took.
  const old = await s.newBot('Old batch');
  const first = s.app.store.addMessage(old.id, 'user', 'update', WAKE_META['work.event']);
  const second = s.app.store.addMessage(old.id, 'user', 'grant', WAKE_META['connector.granted']);
  const third = s.app.store.addMessage(old.id, 'user', 'decided', WAKE_META['approval.decided']);
  await new Promise((r) => setTimeout(r, 5));
  const turnId = s.app.store.startTurn({ botId: old.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
  s.app.store.saveQuietTurnNote(turnId, 0, 'nothing new');
  s.app.store.linkTurnMessage(turnId, first.id);
  await new Promise((r) => setTimeout(r, 5));
  const later = s.app.store.addMessage(old.id, 'user', 'ask', WAKE_META.ask);
  const reply = s.app.store.addMessage(old.id, 'bot', 'Answered Helper.');
  const all = await s.messagesOf(old.id);
  assert.deepEqual([...hiddenIn(all)].sort(), [first.id]);
  assert.ok(all.some((m) => m.id === later.id) && all.some((m) => m.id === reply.id));
  // Pages of one: each reads the same on its own.
  for (const m of [second, third]) {
    const one = await page(old.id, `before=${all[all.findIndex((x) => x.id === m.id) + 1].id}&limit=1`);
    assert.equal(one[0].id, m.id);
    assert.notEqual(one[0].meta?.quiet, true, 'ambiguous historical batch membership stays visible on each page');
  }
  assert.equal((await page(old.id, `after=${third.id}&limit=1`))[0].meta?.quiet, undefined);
});

test('an older [quiet] reply and its wake-ups read quiet on any page boundary', async () => {
  const bot = await s.newBot('Pages');
  const w1 = s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event']);
  const w2 = s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask);
  const r = s.app.store.addMessage(bot.id, 'bot', '[quiet] all clear');
  const owner = s.app.store.addMessage(bot.id, 'user', 'Thanks');
  const ownerReply = s.app.store.addMessage(bot.id, 'bot', 'Any time.');
  // The reply alone on its page, its wake-ups on the one before.
  const replyPage = await page(bot.id, `before=${owner.id}&limit=1`);
  assert.deepEqual(replyPage.map((m) => [m.id, m.meta?.quiet]), [[r.id, true]]);
  const wakePage = await page(bot.id, `before=${r.id}&limit=2`);
  assert.deepEqual(wakePage.map((m) => [m.id, m.meta?.quiet]), [[w1.id, true], [w2.id, true]]);
  // The trigger without its reply, at the newest page's end.
  const tail = await s.newBot('Tail');
  const t1 = s.app.store.addMessage(tail.id, 'user', 'update', WAKE_META['work.event']);
  s.app.store.addMessage(tail.id, 'bot', '[quiet]');
  assert.equal((await page(tail.id, `before=${(await s.messagesOf(tail.id)).at(-1)!.id}&limit=1`))[0].id, t1.id);
  assert.equal((await page(tail.id, `before=${(await s.messagesOf(tail.id)).at(-1)!.id}&limit=1`))[0].meta?.quiet, true);
  // The owner's own turn shows, quiet text and all.
  const latest = await page(bot.id, 'limit=2');
  assert.deepEqual(latest.map((m) => m.id), [owner.id, ownerReply.id]);
  assert.ok(latest.every((m) => !m.meta?.quiet));
  const mixed = await s.newBot('Mixed history');
  s.app.store.addMessage(mixed.id, 'user', 'update', WAKE_META['work.event']);
  s.app.store.addMessage(mixed.id, 'user', 'And you?');
  s.app.store.addMessage(mixed.id, 'bot', '[quiet] fine');
  assert.equal(hiddenIn(await s.messagesOf(mixed.id)).size, 0);
});

test('an older routine run’s quiet reply goes with its run chip on another page', async () => {
  const bot = await s.newBot('Old runs');
  const routine = await s.newRoutine(bot.id, { name: 'Nightly' });
  const meta = { routineId: routine.id, routineName: 'Nightly', runId: 'run_old1' };
  const chip = s.app.store.addMessage(bot.id, 'event', 'Ran routine', { kind: 'routine.run', ...meta, trigger: 'schedule' });
  const reply = s.app.store.addMessage(bot.id, 'bot', '[quiet] nothing new', meta);
  const loud = s.app.store.addMessage(bot.id, 'event', 'Ran routine', { kind: 'routine.run', ...meta, runId: 'run_old2', trigger: 'schedule' });
  s.app.store.addMessage(bot.id, 'bot', 'Two new things.', { ...meta, runId: 'run_old2' });
  const chipPage = await page(bot.id, `before=${reply.id}&limit=1`);
  assert.deepEqual(chipPage.map((m) => [m.id, m.meta?.quiet]), [[chip.id, true]]);
  assert.equal((await page(bot.id, `before=${loud.id}&limit=1`))[0].meta?.quiet, true);
  assert.equal((await s.messagesOf(bot.id)).find((m) => m.id === loud.id)!.meta?.quiet, undefined);
});

/** A turn that saves a memory as the Boton does (its own token, through the API), then replies `reply`. */
const savesMemory = (botId: string, reply: string) => async (req: { env: Record<string, string | undefined> }) => {
  const res = await fetch(`${req.env.BOTONS_API}/api/bots/${botId}/memories`, {
    method: 'POST',
    headers: { authorization: `Bearer ${req.env.BOTON_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Kevin likes short answers' }),
  });
  assert.equal(res.status, 201);
  return reply;
};

test('what a quiet turn did in the chat goes with it; a loud turn’s and the owner’s show', async () => {
  const bot = await s.newBot('Saver');
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event'], true);
  s.mock.script = savesMemory(bot.id, '[quiet] noted');
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  let list = await s.messagesOf(bot.id);
  const saved = list.find((m) => m.meta?.kind === 'memory.saved')!;
  assert.ok(saved.meta?.byTurn, 'tagged with its turn');
  assert.equal(saved.meta?.quiet, true);
  assert.equal(hiddenIn(list).size, list.length, 'nothing of it in the transcript');
  assert.equal(s.app.store.listMemories(bot.id).length, 1, 'the memory itself is kept');

  // The owner adds one: never a turn's.
  await s.call('POST', `/api/bots/${bot.id}/memories`, { text: 'Stuart is on call' });
  // A turn that replies: its memory chip shows.
  s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask, true);
  s.mock.script = savesMemory(bot.id, 'Saved it.');
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  list = await s.messagesOf(bot.id);
  const shown = list.filter((m) => !hiddenIn(list).has(m.id));
  const chips = shown.filter((m) => m.meta?.kind === 'memory.saved');
  assert.equal(chips.length, 2);
  assert.equal(chips[0].meta?.byTurn, null, 'the owner’s');
  assert.ok(chips[1].meta?.byTurn);

  // A quiet routine run's too.
  const routine = await s.newRoutine(bot.id);
  s.mock.script = savesMemory(bot.id, '[quiet]');
  s.app.engine.triggerRoutine(routine.id, 'manual');
  await s.untilState(bot.id, 'idle');
  list = await s.messagesOf(bot.id);
  assert.equal(list.filter((m) => m.meta?.kind === 'memory.saved' && !hiddenIn(list).has(m.id)).length, 2);
});

test('older history: an untagged chip during a quiet turn shows (it may be the owner’s); a tagged one goes; approvals, cards and errors never', async () => {
  const bot = await s.newBot('Old chips');
  const wake = s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event']);
  const turnId = s.app.store.startTurn({ botId: bot.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
  const meta = (kind: string, extra: MessageMeta = {}) => ({ kind, ...extra }) as MessageMeta;
  const insert = (role: string, text: string, m: MessageMeta) => {
    // As an older server wrote it: no byTurn.
    const msg = s.app.store.addMessage(bot.id, role as 'event', text, m);
    s.app.store.db.prepare("update messages set meta = json_remove(meta, '$.byTurn') where id = ?").run(msg.id);
    return msg;
  };
  // The owner saves a memory in the Memory tab while the quiet turn runs: nothing says whose it is, so it shows.
  const owners = insert('event', 'Saved to memory', meta('memory.saved', { memoryText: 'Sam is away Friday' }));
  const forgot = insert('event', 'Forgot a memory', meta('memory.forgotten', { memoryText: 'old' }));
  const routine = insert('event', 'Updated routine', meta('routine.updated', { routineId: 'rt_1', routineName: 'Deploy watch' }));
  // The quiet turn's own, tagged as the server tags it now.
  const mine = s.app.store.addMessage(bot.id, 'event', 'Saved to memory', meta('memory.saved', { memoryText: 'x', byTurn: turnId }));
  const approval = insert('event', 'Asks for your approval: deploy', meta('approval.requested', { approvalId: 'apr_1', approvalTitle: 'deploy' }));
  const card = insert('event', 'Posted a card: pick', meta('card.posted'));
  const err = s.app.store.addMessage(bot.id, 'error', 'Something broke');
  s.app.store.saveQuietTurnNote(turnId, 0, '');
  s.app.store.linkTurnMessage(turnId, wake.id);
  s.app.store.finishTurn(turnId, { outcome: 'ok', durationMs: 60_000, replayedTranscript: false });
  for (const list of [await s.messagesOf(bot.id), s.app.store.listMessages(bot.id, { before: err.id, limit: 3 }), s.app.store.listMessages(bot.id, { after: wake.id, limit: 4 })]) {
    const hidden = hiddenIn(list);
    if (list.some((m) => m.id === wake.id)) assert.ok(hidden.has(wake.id));
    if (list.some((m) => m.id === mine.id)) assert.ok(hidden.has(mine.id), 'the tagged one goes on any page');
    for (const m of [owners, forgot, routine, approval, card, err]) assert.ok(!list.some((x) => x.id === m.id) || !hidden.has(m.id), m.text);
  }
});

test('background activity lists a connector-only Boton’s wake-ups, with no routines', async () => {
  const bot = await s.newBot('Connector only');
  s.app.store.addMessage(bot.id, 'user', 'update', { kind: 'work.event', work: { connectorId: 'oauth:fleet', jobId: 'job_t1', kind: 'needs_input', state: 'needs_input', link: null, title: 'Fix the login page' } }, true);
  s.mock.script = () => '[quiet] waiting on Sam';
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  const a = (await s.call<BackgroundActivity>('GET', `/api/bots/${bot.id}/background`)).data;
  assert.equal(a.lastHour, 1);
  assert.deepEqual(a.recent.map((i) => [i.label, i.quiet, i.note]), [['fleet: “Fix the login page” needs input', true, 'waiting on Sam']]);
  assert.ok(!a.recent[0].label.includes('job_t1') && a.recent[0].detail.includes('job_t1'));
});

test('background activity counts an older [quiet] reply’s wake-ups as quiet, as the chat reads them', async () => {
  const bot = await s.newBot('Old quiet');
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event']);
  s.app.store.addMessage(bot.id, 'bot', '[quiet] nothing new');
  s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask);
  s.app.store.addMessage(bot.id, 'bot', 'Here you go.');
  const a = s.app.store.backgroundActivity(bot.id);
  assert.deepEqual([a.lastHour, a.quietLastHour], [2, 1]);
  assert.deepEqual(a.recent.map((i) => i.quiet), [false, true]);
});

test('a quiet turn that changes the Boton’s routines leaves nothing; the owner’s change during a quiet turn shows', async () => {
  const bot = await s.newBot('Planner');
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event'], true);
  s.mock.script = async (req) => {
    const res = await fetch(`${req.env.BOTONS_API}/api/bots/${bot.id}/routines`, {
      method: 'POST',
      headers: { authorization: `Bearer ${req.env.BOTON_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Recheck', instruction: 'Look again' }),
    });
    assert.equal(res.status, 201);
    return '[quiet]';
  };
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  let list = await s.messagesOf(bot.id);
  const made = list.find((m) => m.meta?.kind === 'routine.created')!;
  assert.ok(made.meta?.byTurn && made.meta.quiet, 'tagged with its turn and marked');
  assert.deepEqual(list.filter((m) => !quietMessageIds(list).has(m.id)), [], 'nothing in the transcript');
  assert.equal(s.app.store.listRoutines(bot.id).length, 1, 'the routine itself is kept');

  // The owner pauses it and saves a memory while another quiet turn runs: theirs show.
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event'], true);
  s.mock.script = async () => {
    const routine = s.app.store.listRoutines(bot.id)[0];
    assert.equal((await s.call('PATCH', `/api/routines/${routine.id}`, { enabled: false })).status, 200);
    assert.equal((await s.call('POST', `/api/bots/${bot.id}/memories`, { text: 'Sam is away Friday' })).status, 201);
    return '[quiet]';
  };
  s.app.engine.queueChat(bot.id);
  await s.untilState(bot.id, 'idle');
  list = await s.messagesOf(bot.id);
  const shown = list.filter((m) => !quietMessageIds(list).has(m.id));
  assert.deepEqual(shown.map((m) => [m.meta?.kind, m.meta?.byTurn]), [['routine.paused', null], ['memory.saved', null]]);
});

test('a wake-up that comes while a quiet turn resolves its connectors is the next turn’s: its failure shows', async () => {
  const bot = await s.newBot('Slow connectors');
  const first = s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event'], true);
  let second: Message | null = null;
  const resolve = s.app.connectors.resolve.bind(s.app.connectors);
  s.app.connectors.resolve = async (...args) => {
    // Read after the turn took its messages, before it starts: a wake-up comes in between.
    if (!second) {
      second = s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask, true);
      await new Promise((r) => setTimeout(r, 5));
    }
    return resolve(...args);
  };
  let calls = 0;
  s.mock.script = () => {
    if (++calls === 1) return '[quiet] nothing new';
    throw new Error('the CLI fell over');
  };
  try {
    s.app.engine.queueChat(bot.id);
    await s.untilState(bot.id, 'idle');
    // The second waits for its own turn.
    s.app.engine.queueChat(bot.id);
    await until(async () => (await s.messagesOf(bot.id)).some((m) => m.role === 'error'));
    await s.untilState(bot.id, 'idle');
  } finally {
    s.app.connectors.resolve = resolve;
  }
  assert.equal(calls, 2);
  for (const list of [await s.messagesOf(bot.id), s.app.store.listMessages(bot.id, { after: first.id })]) {
    const hidden = hiddenIn(list);
    const s2 = list.find((m) => m.id === second!.id)!;
    assert.ok(!s2.meta?.quiet, 'not the quiet turn’s');
    assert.ok(!hidden.has(s2.id));
    assert.ok(list.some((m) => m.role === 'error' && !hidden.has(m.id)));
  }
  assert.ok(hiddenIn(await s.messagesOf(bot.id)).has(first.id));
});

test('older history: a later wake-up in a quiet turn’s window counts only when the next turn shows it was taken', async () => {
  // The quiet turn, linked to its first; a second came before it started.
  const setup = async (name: string) => {
    const bot = await s.newBot(name);
    const first = s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event']);
    const second = s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask);
    await new Promise((r) => setTimeout(r, 5));
    const turnId = s.app.store.startTurn({ botId: bot.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
    s.app.store.saveQuietTurnNote(turnId, 0, '');
    s.app.store.linkTurnMessage(turnId, first.id);
    s.app.store.finishTurn(turnId, { outcome: 'ok', durationMs: 10, replayedTranscript: false });
    await new Promise((r) => setTimeout(r, 5));
    return { bot, first, second };
  };
  // The next chat turn failed: it may have been the second's, so the second and the error show.
  const failed = await setup('Old failed next');
  const t2 = s.app.store.startTurn({ botId: failed.bot.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
  const err = s.app.store.addMessage(failed.bot.id, 'error', 'Something broke');
  s.app.store.linkTurnMessage(t2, err.id);
  s.app.store.finishTurn(t2, { outcome: 'error', durationMs: 10, replayedTranscript: false });
  let hidden = hiddenIn(await s.messagesOf(failed.bot.id));
  assert.deepEqual([...hidden], [failed.first.id]);
  // Still waiting (no next turn yet): it shows.
  const waiting = await setup('Old waiting');
  s.app.store.db.prepare('update messages set pending = 1 where id = ?').run(waiting.second.id);
  assert.deepEqual([...hiddenIn(await s.messagesOf(waiting.bot.id))], [waiting.first.id]);
  // Preparation can fail without recording a next turn; processed is not quiet evidence.
  const preparation = await setup('Preparation failed');
  s.app.store.markProcessed([preparation.second.id]);
  const preparationError = s.app.store.addMessage(preparation.bot.id, 'error', 'Connector preparation failed');
  const preparationMessages = await s.messagesOf(preparation.bot.id);
  assert.deepEqual([...hiddenIn(preparationMessages)], [preparation.first.id]);
  for (const message of [preparation.second, preparationError]) {
    assert.ok(!hiddenIn([preparationMessages.find((m) => m.id === message.id)!]).has(message.id));
  }
  // The next turn is quiet and starts at a later message: the second was the first turn’s.
  const taken = await setup('Old taken');
  const third = s.app.store.addMessage(taken.bot.id, 'user', 'grant', WAKE_META['connector.granted']);
  const t3 = s.app.store.startTurn({ botId: taken.bot.id, trigger: 'chat', provider: 'mock', requestedModel: '' });
  s.app.store.saveQuietTurnNote(t3, 0, '');
  s.app.store.linkTurnMessage(t3, third.id);
  hidden = hiddenIn(await s.messagesOf(taken.bot.id));
  assert.deepEqual([...hidden].sort(), [taken.first.id, taken.second.id, third.id].sort());
});

test('background activity at the same millisecond: wake-ups newest first, then routine turns, every time', async () => {
  const bot = await s.newBot('Same time');
  const routine = await s.newRoutine(bot.id);
  s.mock.script = () => '[quiet]';
  s.app.engine.triggerRoutine(routine.id, 'schedule');
  await s.untilState(bot.id, 'idle');
  s.app.engine.triggerRoutine(routine.id, 'manual');
  await s.untilState(bot.id, 'idle');
  s.app.store.addMessage(bot.id, 'user', 'update', WAKE_META['work.event']);
  s.app.store.addMessage(bot.id, 'bot', '[quiet] nothing new');
  s.app.store.addMessage(bot.id, 'user', 'ask', WAKE_META.ask);
  s.app.store.addMessage(bot.id, 'bot', 'Here you go.');
  const at = new Date().toISOString();
  s.app.store.db.prepare("update messages set created_at = ? where bot_id = ? and role = 'user'").run(at, bot.id);
  s.app.store.db.prepare('update turns set started_at = ? where bot_id = ?').run(at, bot.id);
  for (let i = 0; i < 3; i++) {
    const a = s.app.store.backgroundActivity(bot.id);
    assert.deepEqual(
      a.recent.map((x) => [x.label, x.quiet]),
      [
        ['Helper asked', false],
        ['fleet: PR #7 finished', true],
        ['Routine: Job · manual', true],
        ['Routine: Job', true],
      ],
    );
  }
});
