import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_REACTION_FOLLOW_UPS, reactionEmoji } from '../../shared/reactions.ts';
import type { Approval, ApprovalRequestResult, Message, ReactionImportResult, ReactionTransfer, Settings } from '../../shared/types.ts';
import { backup } from '../src/backup.ts';
import { systemPrompt, transcriptBlock } from '../src/prompt.ts';
import { failOnEscapedErrors, botonCli, startServer, type TestServer, tempDir, until } from './helpers.ts';

failOnEscapedErrors();

const s = await startServer();
const { app, call } = s;
assert.equal((await call('PATCH', '/api/settings', { ownerName: 'Sam' })).status, 200);

const tokenFor = (botId: string, sandboxed = false) => app.auth.mintBotonToken(botId, { sandboxed }).token;
const react = (botId: string, id: string, emoji: unknown, as?: string | null) => call<Message & { error?: string }>('POST', `/api/bots/${botId}/messages/${id}/reactions`, { emoji }, as);
const unreact = (botId: string, id: string, emoji: string | null, as?: string | null) =>
  call<Message & { error?: string }>('DELETE', `/api/bots/${botId}/messages/${id}/reactions${emoji === null ? '' : `/${encodeURIComponent(emoji)}`}`, undefined, as);
const settle = async (botId: string) => {
  await until(() => !app.store.hasPendingChat(botId) && app.engine.statusOf(botId).state === 'idle');
};

test('one emoji is a reaction; text, several emoji and nothing are not', () => {
  for (const ok of ['👍', '👍🏽', '❤️', '🇺🇸', '1️⃣', '✅', '👀', '❓', '😕', '👎']) assert.ok(reactionEmoji(ok), ok);
  assert.equal(reactionEmoji('❤'), '❤️', 'the text form is stored as the emoji');
  for (const bad of ['', ' ', 'ok', 'a', '👍👍', 'a👍', '<', 3, null, '👍 and more']) assert.equal(reactionEmoji(bad), null, String(bad));
  assert.deepEqual(DEFAULT_REACTION_FOLLOW_UPS, ['👎']);
});

test("the owner reacts to the Boton's messages from a paired device: stored, synced live, no turn, no push, and taken off again", async () => {
  const bot = s.storeBot('Kevin');
  const reply = (await s.chat(bot.id, 'Draft the notes.'))!;
  const turns = s.turnsOf(bot.id).length;
  const messages = app.store.listMessages(bot.id).length;

  assert.equal((await react(bot.id, reply.id, '👍', null)).status, 401);
  assert.equal((await react(bot.id, reply.id, 'nice')).status, 400);
  const other = s.storeBot('Stuart');
  assert.equal((await react(other.id, reply.id, '👍')).status, 404);

  const sse = await s.events();
  const ok = await react(bot.id, reply.id, '👍');
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.data.reactions?.map((r) => [r.emoji, r.by]), [['👍', 'owner']]);
  assert.ok(ok.data.reactions![0].at);
  assert.equal(ok.data.text, reply.text);
  await until(() => sse.events.some((e) => e.type === 'message.updated' && e.message.id === reply.id && e.message.reactions?.length === 1));
  // Read back with the chat, and again is no change.
  assert.deepEqual((await s.messagesOf(bot.id)).find((m) => m.id === reply.id)?.reactions?.map((r) => r.emoji), ['👍']);
  assert.equal((await react(bot.id, reply.id, '👍')).data.reactions?.length, 1);
  assert.equal((await react(bot.id, reply.id, '❤')).data.reactions?.map((r) => r.emoji).join(''), '👍❤️');

  // Nothing ran and nothing was posted: no turn, no chip, no push.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.turnsOf(bot.id).length, turns);
  assert.equal(app.store.listMessages(bot.id).length, messages);
  assert.equal(app.engine.statusOf(bot.id).state, 'idle');

  const off = await unreact(bot.id, reply.id, '👍');
  assert.deepEqual(off.data.reactions?.map((r) => r.emoji), ['❤️']);
  assert.equal((await unreact(bot.id, reply.id, '❤️')).data.reactions, undefined);
  await until(() => sse.events.some((e) => e.type === 'message.updated' && e.message.id === reply.id && !e.message.reactions));
  // The owner names what to take off.
  assert.equal((await unreact(bot.id, reply.id, null)).status, 400);
  sse.close();
});

test('a reaction never decides an approval or a card: events take none, and a reaction leaves a waiting request waiting', async () => {
  const bot = s.storeBot('Bob');
  const asked = await call<ApprovalRequestResult>('POST', `/api/bots/${bot.id}/approvals`, { title: 'Push release-1.2 to origin' }, tokenFor(bot.id));
  assert.equal(asked.status, 201, asked.text);
  const card = app.store.listMessages(bot.id).find((m) => m.role === 'event' && m.meta?.approvalId === asked.data.approval.id);
  assert.ok(card, 'the approval has its chat event');
  const refused = await react(bot.id, card.id, '👍');
  assert.equal(refused.status, 400);
  assert.match(refused.data.error!, /decided with its own buttons, never with a reaction/);
  // Not on the owner's own messages either, nor on an error.
  const own = app.store.addMessage(bot.id, 'user', 'Go ahead');
  assert.equal((await react(bot.id, own.id, '👍')).status, 400);

  // A reaction on the Boton's message around it changes nothing about the request.
  const said = app.store.addMessage(bot.id, 'bot', 'I asked before pushing.');
  for (const e of ['👍', '✅', '❤️']) assert.equal((await react(bot.id, said.id, e)).status, 200);
  const now = (await call<Approval>('GET', `/api/approvals/${asked.data.approval.id}`)).data;
  assert.equal(now.status, 'pending');
  assert.equal(now.decidedAt, null);
  assert.ok(!app.store.listMessages(bot.id).some((m) => m.meta?.kind === 'approval.decided'));
  assert.equal(app.store.hasPendingChat(bot.id), false, 'no turn is waiting');
});

test("a Boton reacts only to the owner's own messages in its own chat, with one emoji at most, through the CLI too, and never from a sandboxed turn", async () => {
  const kevin = s.storeBot('Kevin');
  const stuart = s.storeBot('Stuart');
  const mine = app.store.addMessage(kevin.id, 'user', 'Thanks, that is all.');
  const token = tokenFor(kevin.id);

  // Another Boton's chat: its path is refused for this token, and this chat's path has no such message.
  const theirs = app.store.addMessage(stuart.id, 'user', 'Hello Stuart');
  assert.equal((await react(stuart.id, theirs.id, '👍', token)).status, 403);
  assert.equal((await react(kevin.id, theirs.id, '👍', token)).status, 404);
  // Its own messages, another Boton's message, and what the server posts for the owner are not the owner's own.
  const own = app.store.addMessage(kevin.id, 'bot', 'Done.');
  const ask = app.store.addMessage(kevin.id, 'user', 'Can you summarize?', { kind: 'ask', fromBotId: stuart.id, fromBotName: 'Stuart' });
  const decided = app.store.addMessage(kevin.id, 'user', 'Allowed', { kind: 'approval.decided', approvalId: 'apr_x' });
  for (const m of [own, ask, decided]) {
    const r = await react(kevin.id, m.id, '👍', token);
    assert.equal(r.status, 400, m.text);
    assert.match(r.data.error!, /You can react only to Sam's own messages in your chat/);
  }
  // A sandboxed (webhook) turn can't leave anything later turns read.
  assert.equal((await react(kevin.id, mine.id, '👍', tokenFor(kevin.id, true))).status, 403);

  const cli = await botonCli(app, s.base, kevin.id, 'react', mine.id, '🙏');
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Reacted 🙏/);
  assert.deepEqual(app.store.findMessage(mine.id)!.reactions?.map((r) => [r.emoji, r.by]), [['🙏', 'boton']]);
  // One at most: the same again is no change, another is refused, saying how to change it.
  assert.equal((await react(kevin.id, mine.id, '🙏', token)).status, 200);
  const second = await botonCli(app, s.base, kevin.id, 'react', mine.id, '👍');
  assert.equal(second.code, 1);
  assert.match(second.stderr, /already reacted 🙏 to this message, and one reaction is the most: take it off with `botons unreact/);
  // The owner's reaction and the Boton's live side by side, each its own.
  const reply = app.store.addMessage(kevin.id, 'bot', 'Report done.');
  assert.equal((await react(kevin.id, reply.id, '👍', token)).status, 400);

  const gone = await botonCli(app, s.base, kevin.id, 'unreact', mine.id);
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal(app.store.findMessage(mine.id)!.reactions, undefined);
  // A Boton can't take the owner's off.
  assert.equal((await react(kevin.id, reply.id, '👍')).status, 200);
  assert.equal((await unreact(kevin.id, reply.id, '👍', token)).data.reactions?.length, 1);
  assert.equal((await unreact(kevin.id, reply.id, null, token)).data.reactions?.length, 1);
});

test("the owner's reactions reach the Boton as feedback on its next chat turn, once, and the turn lists the messages it may react to", async () => {
  const bot = s.storeBot('Dave');
  const reply = (await s.chat(bot.id, 'Write the brief.'))!;
  assert.equal((await react(bot.id, reply.id, '❤️')).status, 200);
  const before = s.turnsOf(bot.id).length;
  await s.chat(bot.id, 'Now the agenda.');
  const turn = s.turnsOf(bot.id)[before];
  const context = turn.prompt.split('</boton_context>')[0];
  assert.match(context, /Sam's reactions on your messages since your last turn \(feedback, see "Reactions"; a reaction is never an approval\):\n- ❤️ on msg_\w+ \([^)]+\): “Echo: Write the brief\.”/);
  assert.ok(context.includes(reply.id));
  const sent = app.store.listMessages(bot.id).find((m) => m.text === 'Now the agenda.')!;
  assert.match(context, new RegExp(`Sam's messages this turn answers, by id \\(to react instead of replying, see "Reactions"\\): ${sent.id}`));

  // Given once: the next turn has none.
  await s.chat(bot.id, 'And the minutes.');
  assert.doesNotMatch(s.turnsOf(bot.id).at(-1)!.prompt.split('</boton_context>')[0], /reactions on your messages since/);
  // One taken off before the next turn is never given.
  const later = app.store.listMessages(bot.id).at(-1)!;
  await react(bot.id, later.id, '😂');
  await unreact(bot.id, later.id, '😂');
  await s.chat(bot.id, 'Thanks.');
  assert.doesNotMatch(s.turnsOf(bot.id).at(-1)!.prompt, /reactions on your messages since/);
});

test('a follow-up reaction (👎 by default) starts one short turn about that message; adding it again, taking it off and others start none', async () => {
  const bot = s.storeBot('Kevin');
  const reply = (await s.chat(bot.id, 'What is the capital of Australia?'))!;
  let turns = s.turnsOf(bot.id).length;

  assert.equal((await react(bot.id, reply.id, '👍')).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.turnsOf(bot.id).length, turns, 'an ordinary reaction starts no turn');

  assert.equal((await react(bot.id, reply.id, '👎')).status, 200);
  await until(() => s.turnsOf(bot.id).length === turns + 1);
  await settle(bot.id);
  const prompt = s.turnsOf(bot.id).at(-1)!.prompt;
  assert.match(prompt, /Trigger: Sam's reaction to one of your messages/);
  assert.ok(prompt.includes(`(Sam reacted 👎 to your message ${reply.id} (“Echo: What is the capital of Australia?”), from the chat. To Sam it means that was wrong or not what they wanted: reconsider it. Keep this turn short`));
  // The reaction it carries is not also given as feedback.
  assert.doesNotMatch(prompt.split('</boton_context>')[0], /👎 on msg_/);
  const followUp = app.store.listMessages(bot.id).find((m) => m.meta?.kind === 'reaction.followup')!;
  assert.deepEqual([followUp.role, followUp.meta?.reactionTo, followUp.meta?.emoji], ['user', reply.id, '👎']);
  turns = s.turnsOf(bot.id).length;

  // Again (no change), off, and on again: no more turns.
  await react(bot.id, reply.id, '👎');
  await unreact(bot.id, reply.id, '👎');
  await react(bot.id, reply.id, '👎');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.turnsOf(bot.id).length, turns);
  assert.equal(app.store.listMessages(bot.id).filter((m) => m.meta?.kind === 'reaction.followup').length, 1);
});

test('the follow-up reactions are an owner setting: checked, saved, and [] turns 👎 off too', async () => {
  const get = async () => (await call<Settings>('GET', '/api/settings')).data;
  assert.deepEqual((await get()).reactionFollowUps, ['👎']);
  assert.equal((await call('PATCH', '/api/settings', { reactionFollowUps: '👎' })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { reactionFollowUps: ['👎', 'please'] })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { reactionFollowUps: Array.from({ length: 13 }, (_, i) => String.fromCodePoint(0x1f600 + i)) })).status, 400);
  assert.deepEqual((await get()).reactionFollowUps, ['👎'], 'nothing saved from a refused change');
  // A Boton can't change it.
  const bot = s.storeBot('Stuart');
  assert.equal((await call('PATCH', '/api/settings', { reactionFollowUps: [] }, tokenFor(bot.id))).status, 403);

  assert.deepEqual((await call<Settings>('PATCH', '/api/settings', { reactionFollowUps: ['❓', '❓', '😕'] })).data.reactionFollowUps, ['❓', '😕']);
  const reply = (await s.chat(bot.id, 'Explain the plan.'))!;
  const turns = s.turnsOf(bot.id).length;
  await react(bot.id, reply.id, '👎');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.turnsOf(bot.id).length, turns, '👎 is no longer one');
  await react(bot.id, reply.id, '❓');
  await until(() => s.turnsOf(bot.id).length === turns + 1);
  await settle(bot.id);
  assert.match(s.turnsOf(bot.id).at(-1)!.prompt, /To Sam it means they want it explained/);

  assert.deepEqual((await call<Settings>('PATCH', '/api/settings', { reactionFollowUps: [] })).data.reactionFollowUps, []);
  const next = app.store.listMessages(bot.id).filter((m) => m.role === 'bot').at(-1)!;
  await react(bot.id, next.id, '❓');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.turnsOf(bot.id).length, turns + 1);
  await call('PATCH', '/api/settings', { reactionFollowUps: ['👎'] });
});

test('taking a follow-up reaction off before its turn starts withdraws the turn', async () => {
  const bot = s.storeBot('Bob');
  const reply = (await s.chat(bot.id, 'Book the room.'))!;
  assert.equal((await call('POST', `/api/bots/${bot.id}/pause`)).status, 200);
  const turns = s.turnsOf(bot.id).length;
  await react(bot.id, reply.id, '👎');
  const waiting = app.store.listMessages(bot.id).find((m) => m.meta?.kind === 'reaction.followup')!;
  assert.ok(app.store.hasPendingChat(bot.id));
  const sse = await s.events();
  await unreact(bot.id, reply.id, '👎');
  await until(() => sse.events.some((e) => e.type === 'message.updated' && e.message.id === waiting.id && e.message.meta?.withdrawn === true));
  sse.close();
  assert.equal(app.store.hasPendingChat(bot.id), false);
  assert.equal((await call('POST', `/api/bots/${bot.id}/resume`)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.turnsOf(bot.id).length, turns);
});

test('a turn that reacted instead of replying posts nothing; [quiet] without a reaction is posted as usual', async () => {
  const bot = s.storeBot('Dave');
  s.mock.script = async (req) => {
    if (req.env.BOTON_BOT_ID !== bot.id) return null;
    const id = /answers, by id[^:]*: (msg_\w+)/.exec(req.prompt)?.[1];
    if (req.prompt.includes('Thanks!') && id) {
      const r = await fetch(`${req.env.BOTONS_API}/api/bots/${bot.id}/messages/${id}/reactions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${req.env.BOTON_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ emoji: '❤️' }),
      });
      assert.equal(r.status, 200, await r.text());
    }
    return '[quiet]';
  };
  try {
    const sent = (await s.send(bot.id, 'Thanks!')).data;
    await settle(bot.id);
    const chat = app.store.listMessages(bot.id);
    assert.deepEqual(chat.map((m) => m.role), ['user']);
    assert.deepEqual(chat[0].reactions?.map((r) => [r.emoji, r.by]), [['❤️', 'boton']]);
    assert.equal(chat[0].id, sent.id);

    await s.send(bot.id, 'What time is it?');
    await settle(bot.id);
    assert.equal(app.store.listMessages(bot.id).at(-1)!.text, '[quiet]', 'a turn that reacted to nothing still posts');
  } finally {
    s.mock.script = null;
  }
});

/** A mock turn script for `bot`: reacts with ❤️ to the messages `pick` names, then replies `reply`. */
const reactingScript = (botId: string, pick: (prompt: string) => string[], reply: (prompt: string) => string) => async (req: { env: Record<string, string | undefined>; prompt: string }) => {
  if (req.env.BOTON_BOT_ID !== botId) return null;
  for (const id of pick(req.prompt)) {
    const r = await fetch(`${req.env.BOTONS_API}/api/bots/${botId}/messages/${id}/reactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${req.env.BOTON_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ emoji: '❤️' }),
    });
    assert.equal(r.status, 200, await r.text());
  }
  return reply(req.prompt);
};

test('a reply with words after [quiet] is posted, even when the turn reacted', async () => {
  const bot = s.storeBot('Kevin');
  const firstId = (prompt: string) => [/answers, by id[^:]*: (msg_\w+)/.exec(prompt)![1]];
  s.mock.script = reactingScript(bot.id, firstId, () => '[quiet] The report is in reports/q3.md, and two numbers need your check.');
  try {
    await s.send(bot.id, 'Thanks! Where did the report go?');
    await settle(bot.id);
    const chat = app.store.listMessages(bot.id);
    assert.deepEqual(chat.map((m) => m.role), ['user', 'bot']);
    assert.equal(chat[1].text, '[quiet] The report is in reports/q3.md, and two numbers need your check.');
    assert.deepEqual(chat[0].reactions?.map((r) => r.emoji), ['❤️']);
  } finally {
    s.mock.script = null;
  }
});

test("a quiet turn answers only the messages it reacted to in that turn: the others get another turn, which ends", async () => {
  const bot = s.storeBot('Stuart');
  let thanks = '';
  s.mock.script = reactingScript(
    bot.id,
    (prompt) => (prompt.includes('Thanks!') ? [thanks] : []),
    (prompt) => (prompt.includes('Note from the Botons server: your last turn reacted') ? 'The deadline is Friday.' : '[quiet]'),
  );
  try {
    assert.equal((await call('POST', `/api/bots/${bot.id}/pause`)).status, 200);
    thanks = (await s.send(bot.id, 'Thanks!')).data.id;
    const question = (await s.send(bot.id, "What's the deadline?")).data;
    const turns = s.turnsOf(bot.id).length;
    assert.equal((await call('POST', `/api/bots/${bot.id}/resume`)).status, 200);
    await settle(bot.id);
    assert.equal(s.turnsOf(bot.id).length, turns + 2);
    const second = s.turnsOf(bot.id).at(-1)!.prompt.split('</boton_context>').pop()!;
    assert.match(second, /What's the deadline\?/);
    assert.doesNotMatch(second, /Thanks!/, 'the message it reacted to was answered');
    const chat = app.store.listMessages(bot.id).filter((m) => m.role !== 'event');
    assert.deepEqual(chat.map((m) => [m.role, m.text]), [['user', 'Thanks!'], ['user', "What's the deadline?"], ['bot', 'The deadline is Friday.']]);
    assert.equal(chat[1].reactions?.length ?? 0, 0);

    // A reaction on an older message is no answer to this turn's: its [quiet] is posted, and no further turn runs.
    s.mock.script = reactingScript(bot.id, () => [question.id], () => '[quiet]');
    const before = s.turnsOf(bot.id).length;
    await s.send(bot.id, 'And the budget?');
    await settle(bot.id);
    assert.equal(s.turnsOf(bot.id).length, before + 1);
    assert.equal(app.store.listMessages(bot.id).at(-1)!.text, '[quiet]');
  } finally {
    s.mock.script = null;
  }
});

test('an import that replaces an owner reaction withdraws the follow-up it was waiting to start', async () => {
  const bot = s.storeBot('Dave');
  const reply = (await s.chat(bot.id, 'Order lunch.'))!;
  assert.equal((await call('POST', `/api/bots/${bot.id}/pause`)).status, 200);
  const turns = s.turnsOf(bot.id).length;
  await react(bot.id, reply.id, '👎');
  assert.ok(app.store.hasPendingChat(bot.id));
  const file: ReactionTransfer = { format: 'botons-reactions', version: 1, exportedAt: new Date().toISOString(), reactions: [{ messageId: reply.id, botId: bot.id, by: 'owner', emoji: '👍', at: new Date().toISOString() }] };
  const done = await call<ReactionImportResult>('POST', '/api/reactions/import', file);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(app.store.findMessage(reply.id)!.reactions?.map((r) => r.emoji), ['👍']);
  assert.equal(app.store.hasPendingChat(bot.id), false);
  assert.equal(app.store.listMessages(bot.id).find((m) => m.meta?.kind === 'reaction.followup')!.meta?.withdrawn, true);
  assert.equal((await call('POST', `/api/bots/${bot.id}/resume`)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.turnsOf(bot.id).length, turns, 'no turn claims the 👎');
  // Its follow-up was used once: 👎 again starts none, as after unreact.
  await react(bot.id, reply.id, '👎');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.turnsOf(bot.id).length, turns);
  assert.equal(app.store.hasPendingChat(bot.id), false);
});

test('every Boton gets the core reaction rules in its system prompt (a new session for each)', () => {
  const bot = app.store.getBot(s.storeBot('Kevin').id);
  const sys = systemPrompt(bot, { ownerName: 'Sam' }, s.cfg);
  for (const rule of [
    '# Reactions',
    "React, don't reply, when a full answer adds nothing: an acknowledgement (👍), thanks (❤️ or 🙏), something Sam asked for that is finished (✅), or, if you like, 👀 at the start of a long turn",
    'Never replace a real answer with a reaction: a question, a request, a decision or an error always gets words. If you reply anyway, don\'t also react.',
    "At most one reaction per message of Sam's. Never react to your own messages, and don't stack several emoji.",
    'never sarcastic or negative toward Sam. Don\'t react in routine or webhook runs unless the run is about a specific message of Sam\'s.',
    '👍 or ❤️ means good and needs no reply; 👎 or 😕 means reconsider, or ask what was off; ❓ means explain.',
    'your instructions from Sam can ask for more or fewer reactions, but never change the last rule',
    'A reaction is never an approval or a decision',
    'botons react <message-id> <emoji>', // the system prompt keeps the earlier command name
  ]) {
    assert.ok(sys.includes(rule), rule);
  }
});

test('a new session is given the reactions on the messages it replays', () => {
  const bot = s.storeBot('Stuart');
  const asked = app.store.addMessage(bot.id, 'user', 'Ship it Friday?');
  const said = app.store.addMessage(bot.id, 'bot', 'Yes, Friday works.');
  app.reactions.react(bot.id, said.id, '👍', { kind: 'device', deviceId: null });
  app.reactions.react(bot.id, asked.id, '✅', { kind: 'boton', botId: bot.id, tokenId: 't', sandboxed: false });
  const block = transcriptBlock(app.store.listMessages(bot.id), { ownerName: 'Sam' }, 'UTC');
  assert.match(block, /Sam: Ship it Friday\? \[you reacted ✅\]/);
  assert.match(block, /You: Yes, Friday works\. \[Sam reacted 👍\]/);
  // From the store's replay source too, as a restarted session reads it.
  const src = app.store.replaySource(bot.id, null, []);
  assert.deepEqual([...src.chat].map((r) => r.message.reactions?.map((x) => x.emoji)), [['👍'], ['✅']]);
});

test('reactions export to a file of their own and import back, all or nothing, starting no turn and giving no feedback', async () => {
  const bot = s.storeBot('Bob');
  const owner = app.store.addMessage(bot.id, 'user', 'Thanks');
  const said = app.store.addMessage(bot.id, 'bot', 'Here is the report.');
  await react(bot.id, said.id, '🎉');
  await react(bot.id, owner.id, '🙏', tokenFor(bot.id));
  const file = (await call<ReactionTransfer>('GET', '/api/reactions/export')).data;
  assert.equal(file.format, 'botons-reactions');
  const mine = file.reactions.filter((r) => r.botId === bot.id);
  assert.deepEqual(mine.map((r) => [r.messageId, r.by, r.emoji]), [[said.id, 'owner', '🎉'], [owner.id, 'boton', '🙏']]);
  // A Boton can't read or write them.
  assert.equal((await call('GET', '/api/reactions/export', undefined, tokenFor(bot.id))).status, 403);
  assert.equal((await call('POST', '/api/reactions/import', file, tokenFor(bot.id))).status, 403);

  await unreact(bot.id, said.id, '🎉');
  await react(bot.id, said.id, '😂');
  // A wrong entry refuses the whole file and changes nothing.
  const bad = { ...file, reactions: [...file.reactions, { messageId: owner.id, botId: bot.id, by: 'owner', emoji: '👍', at: new Date().toISOString() }] };
  assert.equal((await call('POST', '/api/reactions/import', bad)).status, 400);
  assert.equal((await call('POST', '/api/reactions/import', { ...file, version: 2 })).status, 400);
  assert.deepEqual(app.store.findMessage(said.id)!.reactions?.map((r) => r.emoji), ['😂']);

  const turns = s.turnsOf(bot.id).length;
  const withGone = { ...file, reactions: [...file.reactions, { messageId: 'msg_gone', botId: bot.id, by: 'owner', emoji: '👎', at: new Date().toISOString() }] };
  const done = await call<ReactionImportResult>('POST', '/api/reactions/import', withGone);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.data.skipped, ['msg_gone']);
  assert.deepEqual(app.store.findMessage(said.id)!.reactions?.map((r) => [r.emoji, r.by]), [['🎉', 'owner']]);
  assert.deepEqual(app.store.findMessage(owner.id)!.reactions?.map((r) => [r.emoji, r.by]), [['🙏', 'boton']]);
  assert.equal(app.reactions.feedback(bot.id).length, 0, 'imported reactions are not new feedback');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.turnsOf(bot.id).length, turns);
});

test('a backup keeps every reaction, and a server started from it shows them', async () => {
  const bot = s.storeBot('Dave');
  const said = app.store.addMessage(bot.id, 'bot', 'Backed up.');
  await react(bot.id, said.id, '👀');
  const { dir } = backup({ home: s.home });
  const home = tempDir('botons-reactions-restore-');
  copyFileSync(join(dir, 'botons.db'), join(home, 'botons.db'));
  const restored: TestServer = await startServer({ home });
  try {
    const m = (await restored.messagesOf(bot.id)).find((x) => x.id === said.id)!;
    assert.deepEqual(m.reactions?.map((r) => [r.emoji, r.by]), [['👀', 'owner']]);
  } finally {
    await restored.stop();
  }
});
