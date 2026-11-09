import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../../shared/types.ts';
import { PIN_LIMIT } from '../src/replay.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer();
const { app, call } = s;
const pin = (botId: string, id: string, pinned: unknown, as?: string | null) => call<Message>('POST', `/api/bots/${botId}/messages/${id}/pin`, { pinned }, as);

test('only a paired device pins: no Boton token, its own included, and nothing without a token', async () => {
  const bot = s.storeBot('Kevin');
  const reply = (await s.chat(bot.id, 'We ship on Friday.'))!;
  const boton = app.auth.mintBotonToken(bot.id).token;
  assert.equal((await pin(bot.id, reply.id, true, boton)).status, 403);
  assert.equal((await pin(bot.id, reply.id, true, null)).status, 401);
  assert.equal(app.store.listMessages(bot.id).find((m) => m.id === reply.id)!.meta?.pinned, undefined);

  // Checked input: a boolean, a message of this Boton, and a message (not an event or error).
  assert.equal((await pin(bot.id, reply.id, 'yes')).status, 400);
  const other = s.storeBot('Stuart');
  assert.equal((await pin(other.id, reply.id, true)).status, 404);
  const event = app.store.addMessage(bot.id, 'event', 'Something happened', { kind: 'routine.created' });
  assert.equal((await pin(bot.id, event.id, true)).status, 400);

  const sse = await s.events();
  const ok = await pin(bot.id, reply.id, true);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.data.meta?.pinned?.at);
  assert.equal(ok.data.text, reply.text);
  await until(() => sse.events.some((e) => e.type === 'message.updated' && e.message.id === reply.id && !!e.message.meta?.pinned));
  // Pinning again changes nothing; unpinning takes the mark off and keeps the rest of the meta.
  assert.equal((await pin(bot.id, reply.id, true)).data.meta?.pinned?.at, ok.data.meta?.pinned?.at);
  const off = await pin(bot.id, reply.id, false);
  assert.equal(off.data.meta?.pinned, undefined);
  assert.equal(off.data.meta?.turnId, reply.meta?.turnId);
  sse.close();
});

test('a chat holds at most PIN_LIMIT pins: one more is refused, saying why, until one is unpinned', async () => {
  const bot = s.storeBot('Bob');
  const sent = Array.from({ length: PIN_LIMIT + 1 }, (_, i) => app.store.addMessage(bot.id, 'user', `Decision ${i}`));
  for (const m of sent.slice(0, PIN_LIMIT)) assert.equal((await pin(bot.id, m.id, true)).status, 200);
  const refused = await pin(bot.id, sent[PIN_LIMIT].id, true);
  assert.equal(refused.status, 409);
  assert.match((refused.data as unknown as { error: string }).error, /10 messages are pinned already, as many as a new session has room for: unpin one first/);
  assert.equal((await pin(bot.id, sent[0].id, false)).status, 200);
  assert.equal((await pin(bot.id, sent[PIN_LIMIT].id, true)).status, 200);
});

test("a new session is given the owner's pins whatever their age, and a reset drops them with the rest", async () => {
  const bot = s.storeBot('Dave');
  const decision = app.store.addMessage(bot.id, 'user', 'Decision: the budget for the trip is 500.');
  // Enough chat that the decision is far older than what fits.
  for (let i = 0; i < 300; i++) app.store.addMessage(bot.id, i % 2 ? 'bot' : 'user', `Chatter ${i}: ${'and so on '.repeat(30)}`);
  assert.equal((await pin(bot.id, decision.id, true)).status, 200);

  const p = await call('POST', `/api/bots/${bot.id}/switch-preview`, { provider: 'mock', model: '' });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.data.replay.pinned, 1);
  assert.deepEqual([p.data.replayNow.pinned, p.data.replayNow.olderLeftOut], [1, true]);

  await s.chat(bot.id, 'What is the budget?');
  const turn = s.turnsOf(bot.id).at(-1)!;
  assert.equal(turn.sessionId, null);
  const replay = turn.prompt.split('</conversation_so_far>')[0];
  const owner = app.store.getSettings().ownerName;
  assert.ok(replay.includes(`(Earlier messages ${owner} pinned, given whatever their age:)`), replay.slice(0, 600));
  assert.ok(replay.includes(`(pinned by ${owner}) ${owner}: Decision: the budget for the trip is 500.`));
  assert.ok(!replay.includes('Chatter 0:'));
  assert.ok(Buffer.byteLength(turn.prompt) < 70_000);

  // Started fresh: the pin comes off with the rest, every device is told, and the old message can't be pinned again
  // (not even confirmed as pinned: nothing was unpinned first).
  const sse = await s.events();
  assert.equal((await call('POST', `/api/bots/${bot.id}/reset`)).status, 200);
  await until(() => sse.events.some((e) => e.type === 'message.updated' && e.message.id === decision.id && !e.message.meta?.pinned));
  sse.close();
  const row = app.store.db.prepare('select meta from messages where id = ?').get(decision.id)!;
  assert.equal(JSON.parse(String(row.meta ?? '{}')).pinned, undefined);
  assert.equal(app.store.pinnedMessages(bot.id).length, 0);
  const refused = await pin(bot.id, decision.id, true);
  assert.equal(refused.status, 400);
  assert.match((refused.data as unknown as { error: string }).error, /from before the chat was started fresh/);
  await call('PATCH', `/api/bots/${bot.id}`, { instructions: 'Plan trips.' });
  await s.chat(bot.id, 'And now?');
  assert.ok(!s.turnsOf(bot.id).at(-1)!.prompt.includes('Decision: the budget'));
});

test('a pin that no session is given is refused, not confirmed: the check comes before "already pinned"', async () => {
  const bot = s.storeBot('Kevin');
  const old = app.store.addMessage(bot.id, 'user', 'Decision: blue folder.');
  assert.equal((await pin(bot.id, old.id, true)).status, 200);
  // A mark left from before the chat was started fresh (the reset takes them off; this one is put back by hand).
  await new Promise((r) => setTimeout(r, 5));
  app.store.db.prepare('update bots set context_since = ? where id = ?').run(new Date().toISOString(), bot.id);
  assert.ok(app.store.listMessages(bot.id).find((m) => m.id === old.id)!.meta?.pinned);
  const refused = await pin(bot.id, old.id, true);
  assert.equal(refused.status, 400);
  assert.match((refused.data as unknown as { error: string }).error, /from before the chat was started fresh/);
  // Unpinning it still works, and it is not counted against the limit meanwhile.
  assert.equal(app.store.pinnedMessages(bot.id).length, 0);
  assert.equal((await pin(bot.id, old.id, false)).data.meta?.pinned, undefined);
});


test('a clock correction cannot pin a message before the replay reset sequence', async () => {
  const bot = s.storeBot('Stuart');
  const old = app.store.addMessage(bot.id, 'user', 'Decision before the clock correction.');
  // The message was written before the reset, under a clock one hour ahead. No host clock is changed.
  app.store.db.prepare('update messages set created_at = ? where id = ?').run(new Date(Date.now() + 3_600_000).toISOString(), old.id);
  assert.equal((await call('POST', `/api/bots/${bot.id}/reset`)).status, 200);
  const refused = await pin(bot.id, old.id, true);
  assert.equal(refused.status, 400, refused.text);
  assert.equal(app.store.pinnedMessages(bot.id).length, 0);
  assert.ok(!app.store.listMessages(bot.id).find((m) => m.id === old.id)!.meta?.pinned);
  // A stale mark must not make the same ineligible request idempotently successful either.
  app.store.db.prepare('update messages set meta = ? where id = ?').run(JSON.stringify({ pinned: { at: new Date().toISOString() } }), old.id);
  assert.equal((await pin(bot.id, old.id, true)).status, 400);
  assert.equal((await pin(bot.id, old.id, false)).status, 200);
});
