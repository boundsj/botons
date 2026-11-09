// On a server, end to end: approvals bound to one exact call, ask replies kept to their own asker, webhook runs kept
// out of the chat unless the owner shares it, and signed webhooks checked before their bodies are parsed. The fast,
// in-process versions are in security-units.test.ts.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { Approval, Bot, Routine, ToolCallVerdict } from '../../shared/types.ts';
import type { TurnRequest } from '../src/providers/types.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer();

const scriptFor = (botId: string, fn: (t: TurnRequest) => Promise<string | null> | string | null) => {
  s.mock.script = (t) => (t.env.BOTON_BOT_ID === botId ? fn(t) : null);
};
const tokenFor = (botId: string) => s.app.auth.mintBotonToken(botId, { sandboxed: false }).token;
const toolCall = async (botId: string, toolName: string, input: unknown, token: string) =>
  (await s.call<ToolCallVerdict>('POST', `/api/bots/${botId}/approvals/tool-call`, { toolName, input, toolUseId: `toolu_${Math.random()}` }, token)).data;
const verdict = async (v: ToolCallVerdict, token: string, waiter: string | null | undefined = v.waiter) =>
  (await s.call<ToolCallVerdict>('GET', `/api/approvals/${v.approval!.id}/tool-call${waiter ? `?waiter=${encodeURIComponent(waiter)}` : ''}`, undefined, token)).data;
const decide = (id: string) => s.call<Approval>('POST', `/api/approvals/${id}/decide`, { decision: 'allow' });
const settled = (botId: string) => s.app.engine.statusOf(botId).state === 'idle' && !s.app.store.hasPendingChat(botId);

async function askFirstBot(name: string): Promise<Bot> {
  const bot = await s.newBot(name, { access: 'host' });
  await s.call('PATCH', `/api/bots/${bot.id}`, { askFirst: ['mcp__fixture'] });
  return bot;
}

test('Allow once on a card authorizes one waiting call: an identical call made at the same time gets a card of its own', async () => {
  const bot = await askFirstBot('Kevin');
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let token = '';
  scriptFor(bot.id, async (t) => {
    token = t.env.BOTON_TOKEN;
    await hold;
    return 'Done.';
  });
  await s.send(bot.id, 'Make the item');
  await until(() => token);
  try {
    const input = { item_id: 'dummy-1', description: 'A' };
    const [one, two] = await Promise.all([toolCall(bot.id, 'mcp__fixture__create_item', input, token), toolCall(bot.id, 'mcp__fixture__create_item', input, token)]);
    assert.deepEqual([one.behavior, two.behavior], ['wait', 'wait']);
    assert.ok(one.waiter && two.waiter && one.waiter !== two.waiter, 'each call waits as itself');
    assert.notEqual(one.approval!.id, two.approval!.id, 'two calls, two cards');

    assert.equal((await decide(one.approval!.id)).data.tool!.inTurn, true);
    assert.equal((await verdict(one, token)).behavior, 'allow');
    assert.equal((await verdict(one, token)).behavior, 'allow', 'the same call asking again hears the same answer');
    assert.equal((await verdict(two, token)).behavior, 'wait', 'the other call still waits for its own card');
    // Nothing else spends the allow: not the other call's waiter, nor a poll naming none.
    assert.equal((await verdict(one, token, two.waiter)).behavior, 'deny');
    assert.equal((await verdict(one, token, null)).behavior, 'deny');
    assert.ok((await s.call<Approval>('GET', `/api/approvals/${one.approval!.id}`)).data.tool!.usedAt, 'spent when it was handed out');
  } finally {
    release();
    await until(() => settled(bot.id));
  }
});

test('a call joins a waiting card only once nothing waits on it any more, and then the earlier waiter hears no allow', async () => {
  const bot = await askFirstBot('Stuart');
  const token = tokenFor(bot.id);
  const input = { item_id: 'dummy-2', description: 'A' };
  const first = await toolCall(bot.id, 'mcp__fixture__create_item', input, token);
  // No turn runs, so the first call's wait can't be answered in a turn: a later identical call takes the card over.
  const second = await toolCall(bot.id, 'mcp__fixture__create_item', input, token);
  assert.equal(second.approval!.id, first.approval!.id);
  assert.notEqual(second.waiter, first.waiter);
  assert.equal((await verdict(first, token)).behavior, 'deny', 'the first waiter was replaced');
});

test("an MCP call's description is part of what the owner approved: a changed one asks again, and a grant is spent once", async () => {
  const bot = await askFirstBot('Bob');
  const token = tokenFor(bot.id);
  const a = { item_id: 'dummy-3', description: 'A' };
  const b = { item_id: 'dummy-3', description: 'B' };
  const first = await toolCall(bot.id, 'mcp__fixture__create_item', a, token);
  assert.equal(first.behavior, 'wait');
  // While A's card waits, B is another call with a card of its own.
  const other = await toolCall(bot.id, 'mcp__fixture__create_item', b, token);
  assert.notEqual(other.approval!.id, first.approval!.id);
  // Allowed after its wait (no turn was running): A once, never B.
  assert.equal((await decide(first.approval!.id)).data.tool!.inTurn, false);
  await until(() => settled(bot.id));
  const asB = await toolCall(bot.id, 'mcp__fixture__create_item', b, token);
  assert.equal(asB.behavior, 'wait');
  assert.notEqual(asB.approval!.id, first.approval!.id);
  assert.equal((await toolCall(bot.id, 'mcp__fixture__create_item', { ...a, extra: 1 }, token)).behavior, 'wait', 'another field changed asks again too');
  assert.equal((await toolCall(bot.id, 'mcp__fixture__create_item', { description: 'A', item_id: 'dummy-3' }, token)).behavior, 'allow', 'A itself, keys in any order');
  const again = await toolCall(bot.id, 'mcp__fixture__create_item', a, token);
  assert.equal(again.behavior, 'wait', 'once');
});

test("a reply goes to its own asker only: asks first, from two colleagues, then the owner's message, each answered in a turn whose whole input holds nothing waiting for another", async () => {
  const dave = await s.newBot('Dave');
  const kev = await s.newBot('Kev');
  const bob = await s.newBot('Bobby');
  const echo = (t: TurnRequest) => `Seen: ${t.prompt}`;
  s.mock.script = (t) => (t.env.BOTON_BOT_ID === bob.id ? echo(t) : t.env.BOTON_BOT_ID === dave.id || t.env.BOTON_BOT_ID === kev.id ? 'Thanks.' : null);
  await s.call('POST', `/api/bots/${bob.id}/pause`);
  // Bobby has no session yet, so each turn starts a fresh one and its input carries the replay too.
  assert.equal((await s.call('POST', `/api/bots/${bob.id}/asks`, { text: 'ASK_A: please answer pong.' }, tokenFor(dave.id))).status, 202);
  assert.equal((await s.call('POST', `/api/bots/${bob.id}/asks`, { text: 'ASK_B: please answer ping.' }, tokenFor(kev.id))).status, 202);
  await s.send(bob.id, 'OWNER_PRIVATE_PENDING: the locker code');
  await s.call('POST', `/api/bots/${bob.id}/resume`);
  await until(() => settled(bob.id) && settled(dave.id) && settled(kev.id) && s.turnsOf(bob.id).length === 3);
  const [a, b, owner] = s.turnsOf(bob.id);
  // The whole input each turn was given (context, replay and messages), not what a script chose to read of it.
  assert.equal(a.sessionId, null);
  assert.match(a.prompt, /ASK_A/);
  assert.doesNotMatch(a.prompt, /ASK_B|OWNER_PRIVATE_PENDING/);
  assert.match(b.prompt, /ASK_B/);
  assert.doesNotMatch(b.prompt, /OWNER_PRIVATE_PENDING/);
  assert.match(owner.prompt, /OWNER_PRIVATE_PENDING/);
  const replyTo = async (id: string) => (await s.messagesOf(id)).find((m) => m.meta?.kind === 'ask.reply')!.text;
  assert.match(await replyTo(dave.id), /ASK_A/);
  assert.doesNotMatch(await replyTo(dave.id), /ASK_B|OWNER_PRIVATE_PENDING/);
  assert.doesNotMatch(await replyTo(kev.id), /OWNER_PRIVATE_PENDING/);
  for (const t of [...s.turnsOf(dave.id), ...s.turnsOf(kev.id)]) assert.doesNotMatch(t.prompt, /OWNER_PRIVATE_PENDING/);
});

test("a webhook run never resumes the chat's session and sees only as much of the chat as the owner shared, whatever its session or how its webhook was added", async () => {
  const bot = await s.newBot('Stu');
  scriptFor(bot.id, () => 'ok');
  await s.send(bot.id, 'OWNER_HISTORY_OLD: the old secret');
  await until(() => settled(bot.id) && s.app.store.getBot(bot.id).sessionId);
  await s.send(bot.id, 'OWNER_HISTORY_NEW: the latest');
  await until(() => settled(bot.id));
  const chatSession = s.app.store.getBot(bot.id).sessionId;
  // As the Routines editor makes one (session chat), and a chat routine given a webhook later.
  const shared = await s.newRoutine(bot.id, { name: 'Shared', instruction: 'Summarize it', webhook: true, session: 'chat' });
  const daily = await s.newRoutine(bot.id, { name: 'Daily', instruction: 'x' });
  const later = (await s.call<Routine>('PATCH', `/api/routines/${daily.id}`, { webhook: true })).data;
  assert.equal((await s.newRoutine(bot.id, { name: 'Hook', instruction: 'x', webhook: true })).session, 'own');
  const run = async (r: Routine) => {
    const seen = s.turnsOf(bot.id).length;
    assert.equal((await s.hook(r, 'wait=1', { headers: { 'content-type': 'text/plain' }, body: 'event' })).status, 200);
    return s.turnsOf(bot.id)[seen];
  };
  for (const r of [shared, later]) {
    assert.equal(r.webhookHistory, 0);
    const t = await run(r);
    assert.equal(t.sessionId, null, `${r.name}: a fresh session`);
    assert.doesNotMatch(t.prompt, /OWNER_HISTORY/, `${r.name}: none of the chat`);
  }
  assert.equal(s.app.store.getBot(bot.id).sessionId, chatSession, "the chat's session is not the runs'");

  // Only the owner shares the chat with webhook runs; a Boton may only take it back.
  const token = tokenFor(bot.id);
  assert.equal((await s.call('PATCH', `/api/routines/${shared.id}`, { webhookHistory: 1 }, token)).status, 403);
  assert.equal((await s.call('POST', `/api/bots/${bot.id}/routines`, { name: 'Sneaky', instruction: 'x', webhook: true, webhookHistory: 5 }, token)).status, 403);
  assert.equal((await s.call('PATCH', `/api/routines/${shared.id}`, { webhookHistory: 0 }, token)).status, 200);
  // The latest two: the owner's newest message and the reply to it, not the one before.
  const one = (await s.call<Routine>('PATCH', `/api/routines/${shared.id}`, { webhookHistory: 2 })).data;
  assert.equal(one.webhookHistory, 2);
  for (let i = 0; i < 2; i++) {
    const t = await run(one);
    assert.equal(t.sessionId, null, 'every run starts fresh, so none sees more than it was given');
    assert.match(t.prompt, /OWNER_HISTORY_NEW/);
    assert.doesNotMatch(t.prompt, /OWNER_HISTORY_OLD/);
  }
  assert.equal(s.app.store.getBot(bot.id).sessionId, chatSession);
});

const hex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

test('a signed routine refuses a bad signature before it parses the body, and a form is read in one pass with a cap on its fields', async () => {
  const bot = await s.newBot('Hooky');
  const routine: Routine = await s.newRoutine(bot.id, { name: 'GitHub', instruction: 'x', webhook: true, webhookSource: 'github' });
  // 200,000 copies of one field (about 800 KB): refused at once, with no signature to check.
  const body = Array(200_000).fill('a=x').join('&');
  const started = performance.now();
  const res = await fetch(`${s.base}/hooks/routines/${routine.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'push' },
    body,
  });
  assert.equal(res.status, 401);
  assert.ok(performance.now() - started < 2000, `refused in ${Math.round(performance.now() - started)} ms`);

  // The same body, genuinely signed: too many fields is a 400, still quickly.
  const signed = await fetch(`${s.base}/hooks/routines/${routine.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-hub-signature-256': `sha256=${hex(routine.webhook!.key, body)}`, 'x-github-event': 'push' },
    body,
  });
  assert.equal(signed.status, 400);
  assert.match(((await signed.json()) as { error: string }).error, /too many form fields/);
});
