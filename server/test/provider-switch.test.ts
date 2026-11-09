import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ProviderSwitchPreview } from '../../shared/types.ts';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

useTestCodexHome(tempDir('botons-provider-switch-'));
const home = tempDir('botons-provider-switch-home-');
const first = await startServer({ home, fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h' } });
let server = first;

const argOf = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const switches = (botId: string) => server.app.store.listMessages(botId).filter((m) => m.meta?.kind === 'provider.switched');
const preview = async (botId: string, body: Record<string, unknown>) => {
  const res = await server.call<ProviderSwitchPreview>('POST', `/api/bots/${botId}/switch-preview`, body);
  assert.equal(res.status, 200, res.text);
  return res.data;
};

/** A Codex Boton that has a chat session. */
async function codexBoton(name: string, over: Record<string, unknown> = {}) {
  const bot = server.storeBot(name, 'codex-cli', over);
  server.codex.script('codex/reply');
  await server.chat(bot.id, 'hello');
  assert.ok(server.app.store.getBot(bot.id).sessionId);
  return bot;
}

test('a move that ends a session is refused without the confirmation from its preview, and changes nothing', async () => {
  const bot = await codexBoton('Kevin');
  const sessionId = server.app.store.getBot(bot.id).sessionId;
  server.app.store.addMemory(bot.id, 'Sam likes short answers');

  const p = await preview(bot.id, { provider: 'claude-cli', model: '' });
  assert.equal(p.required, true);
  assert.match(p.confirmation ?? '', /^sw_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(p.sessions, { chat: true, routines: [] });
  assert.deepEqual([p.from.provider, p.from.label, p.to.provider], ['codex-cli', 'Codex', 'claude-cli']);
  const claude = p.to.label;
  assert.deepEqual(p.kept, { memories: 1, routines: 0 });
  assert.deepEqual(p.replay, { budget: 64_000, messageLimit: 4_000, pinned: 0, pinLimit: 10 });
  // What the replay would give now: the whole chat so far, with the note inside the same budget.
  assert.deepEqual([p.replayNow.messages, p.replayNow.pinned, p.replayNow.olderLeftOut], [server.app.store.listMessages(bot.id, {}).length, 0, false]);
  assert.ok(p.replayNow.used > 0 && p.replayNow.used <= p.replay.budget);
  assert.ok(['ready', 'unavailable', 'unknown'].includes(p.readiness.state));

  const refused = await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: '', name: 'Kevin 2' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /ends its session on Codex: review what is kept and lost/);
  // A different delta than the one reviewed: another model.
  const stale = await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: 'opus', switchConfirmation: p.confirmation });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /changed since you reviewed it/);
  const after = server.app.store.getBot(bot.id);
  assert.deepEqual([after.provider, after.name, after.sessionId], ['codex-cli', 'Kevin', sessionId]);
  assert.equal(switches(bot.id).length, 0);

  // Another Boton's confirmation is not this one's.
  const other = await codexBoton('Stuart');
  const otherPreview = await preview(other.id, { provider: 'claude-cli', model: '' });
  assert.notEqual(otherPreview.confirmation, p.confirmation);
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: '', switchConfirmation: otherPreview.confirmation })).status, 409);

  // A chat turn saving a new session doesn't change what the move loses: the confirmation still stands.
  const ok = await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: '', switchConfirmation: p.confirmation });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.provider, 'claude-cli');
  const [sw] = switches(bot.id);
  assert.equal(sw.text, `Moved from Codex (its default model) to ${claude} (its default model): its session on Codex ended, so the next turn starts a new one with a handoff note`);
  assert.equal(sw.role, 'event');
  assert.deepEqual([sw.meta?.handoff?.from.provider, sw.meta?.handoff?.to.provider, sw.meta?.handoff?.sessionEnded], ['codex-cli', 'claude-cli', true]);
});

test('the confirmation stands for everything the preview shows: readiness, memories and routines changing refuse it', async () => {
  const bot = await codexBoton('Walter');
  const move = { provider: 'claude-cli', model: '' };
  const patch = (confirmation: string | null) => server.call('PATCH', `/api/bots/${bot.id}`, { ...move, switchConfirmation: confirmation });
  const unchanged = () => {
    assert.equal(server.app.store.getBot(bot.id).provider, 'codex-cli');
    assert.equal(switches(bot.id).length, 0);
  };
  await server.app.providers.infos({ recheck: true });
  const p = await preview(bot.id, move);
  assert.equal(p.readiness.state, 'ready');
  // The same facts give the same confirmation: no clock in it.
  assert.equal((await preview(bot.id, move)).confirmation, p.confirmation);

  // Claude Code signed out since the review: what the owner saw ("ready") is no longer so.
  server.claude.login('claude/auth-status-logged-out');
  await server.app.providers.infos({ recheck: true });
  const signedOut = await patch(p.confirmation);
  assert.equal(signedOut.status, 409, signedOut.text);
  assert.match(signedOut.data.error, /changed since you reviewed it/);
  unchanged();
  const out = await preview(bot.id, move);
  assert.deepEqual([out.readiness.state, out.confirmation !== p.confirmation], ['unavailable', true]);
  server.claude.login('claude/auth-status-logged-in');
  await server.app.providers.infos({ recheck: true });
  assert.equal((await preview(bot.id, move)).confirmation, p.confirmation, 'signed in again: the facts are the reviewed ones');

  // A memory saved, or a routine added, since the review.
  server.app.store.addMemory(bot.id, 'Sam is away on Friday');
  assert.equal((await patch(p.confirmation)).status, 409);
  unchanged();
  const withMemory = await preview(bot.id, move);
  assert.equal(withMemory.kept.memories, p.kept.memories + 1);
  server.app.store.createRoutine(bot.id, { name: 'Evening check', instruction: 'Check' });
  assert.equal((await patch(withMemory.confirmation)).status, 409);
  unchanged();
  const now = await preview(bot.id, move);
  assert.equal(now.kept.routines, p.kept.routines + 1);
  const ok = await patch(now.confirmation);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(server.app.store.getBot(bot.id).provider, 'claude-cli');
});

test('the first turn after the move starts with the handoff note ahead of the replay; the next resumes without it', async () => {
  const bot = await codexBoton('Bob');
  const p = await preview(bot.id, { provider: 'claude-cli', model: 'sonnet' });
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: 'sonnet', switchConfirmation: p.confirmation })).status, 200);

  server.claude.script('claude/reply');
  await server.chat(bot.id, 'What were you running on before?');
  const [call] = server.claude.calls();
  assert.equal(argOf(call.argv, '--resume'), null);
  const note = call.stdin.indexOf('<provider_switch>');
  const replay = call.stdin.indexOf('<conversation_so_far>');
  assert.ok(note >= 0 && replay > note, call.stdin.slice(0, 400));
  const claude = p.to.label;
  assert.ok(call.stdin.includes(`moved you from Codex (its default model) to ${claude} (model sonnet). This is your first turn on ${claude}.`));
  assert.match(call.stdin, /Your session on Codex ended with the move/);
  // The switch is in the replay too, as the chat's event.
  assert.ok(call.stdin.slice(replay).includes(`(Moved from Codex (its default model) to ${claude} (sonnet)`));
  assert.ok(!call.stdin.slice(0, note).includes('<conversation_so_far>'));
  assert.equal(switches(bot.id)[0].meta?.handoffDone, true);

  server.claude.script('claude/reply');
  await server.chat(bot.id, 'And now?');
  const [next] = server.claude.calls();
  assert.ok(argOf(next.argv, '--resume'));
  assert.ok(!next.stdin.includes('<provider_switch>'));
});

test('a model change alone keeps the session: no confirmation, no switch note', async () => {
  const bot = server.storeBot('Dave', 'claude-cli', { model: 'sonnet' });
  server.claude.script('claude/reply');
  await server.chat(bot.id, 'hello');
  const session = server.app.store.getBot(bot.id).sessionId;
  const p = await preview(bot.id, { provider: 'claude-cli', model: 'opus' });
  assert.deepEqual([p.required, p.confirmation, p.sessions.chat], [false, null, false]);
  const res = await server.call('PATCH', `/api/bots/${bot.id}`, { model: 'opus', provider: 'claude-cli' });
  assert.equal(res.status, 200, res.text);
  assert.equal(switches(bot.id).length, 0);
  server.claude.script('claude/reply');
  await server.chat(bot.id, 'still there?');
  const [call] = server.claude.calls();
  assert.deepEqual([argOf(call.argv, '--resume'), argOf(call.argv, '--model')], [session, 'opus']);
  assert.ok(!call.stdin.includes('<provider_switch>'));
});

test('a Boton with no session to lose moves without confirming, and still gets the note', async () => {
  const bot = server.storeBot('Jerry', 'codex-cli');
  const p = await preview(bot.id, { provider: 'mock' });
  assert.deepEqual([p.required, p.confirmation], [false, null]);
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'mock' })).status, 200);
  assert.match(switches(bot.id)[0].text, /: the next turn starts with a handoff note$/);
  await server.chat(bot.id, 'hi');
  const prompt = server.turnsOf(bot.id).at(-1)!.prompt;
  assert.match(prompt, /^<provider_switch>\n.+ moved you from Codex \(its default model\) to /);
  assert.match(prompt, /No session on Codex was open to carry over\./);
});

test('the preview is the delta the update makes: effort kept or reset, routine models and efforts, connectors, sessions', async () => {
  const bot = await codexBoton('Tim', { effort: 'ultra' });
  const own = server.app.store.createRoutine(bot.id, { name: 'Own check', instruction: 'Check', model: 'gpt-5.1-codex', effort: 'minimal', session: 'own' });
  const plain = server.app.store.createRoutine(bot.id, { name: 'Plain', instruction: 'Check', effort: 'high' });
  server.app.store.setRoutineSession(own.id, 'thread-own', null, { contextSince: server.app.store.getBot(bot.id).contextSince, provider: 'codex-cli', generation: server.app.store.switchGeneration(bot.id) });

  const p = await preview(bot.id, { provider: 'claude-cli', model: '' });
  // Claude Code has no "ultra": back to its default. Its own routine session had another key, so it ends nothing.
  assert.deepEqual([p.from.effort, p.to.effort, p.effortReset], ['ultra', '', true]);
  assert.deepEqual(p.routineModels, [{ id: own.id, name: 'Own check', model: 'gpt-5.1-codex' }]);
  assert.deepEqual(p.routineEfforts, [{ id: own.id, name: 'Own check', effort: 'minimal' }]);
  assert.deepEqual(p.sessions.routines, []);
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: '', switchConfirmation: p.confirmation })).status, 200);
  const after = server.app.store.getBot(bot.id);
  assert.equal(after.effort, '');
  assert.deepEqual([server.app.store.getRoutine(own.id).model, server.app.store.getRoutine(own.id).effort], [null, null]);
  assert.equal(server.app.store.getRoutine(plain.id).effort, 'high');
  const kinds = server.app.store.listMessages(bot.id).map((m) => m.meta?.kind).filter((k) => k === 'provider.switched' || k === 'routine.model_reset' || k === 'effort.reset');
  // The switch comes first, then what it reset.
  assert.equal(kinds[0], 'provider.switched');
  assert.ok(kinds.includes('routine.model_reset') && kinds.includes('effort.reset'));

  // A level the new provider has stays; the owner's own pick in the update is the one previewed.
  const kept = await codexBoton('Phil', { effort: 'high' });
  const keep = await preview(kept.id, { provider: 'claude-cli', model: '' });
  assert.equal(keep.to.effort, 'high');
  const picked = await preview(kept.id, { provider: 'claude-cli', model: '', effort: 'max' });
  assert.deepEqual([keep.effortReset, picked.to.effort, picked.effortReset], [false, 'max', false]);
  assert.notEqual(picked.confirmation, keep.confirmation);
  // Confirming the kept level, then sending another, is a different delta.
  assert.equal((await server.call('PATCH', `/api/bots/${kept.id}`, { provider: 'claude-cli', model: '', effort: 'max', switchConfirmation: keep.confirmation })).status, 409);
  assert.equal((await server.call('PATCH', `/api/bots/${kept.id}`, { provider: 'claude-cli', model: '', effort: 'max', switchConfirmation: picked.confirmation })).status, 200);
  assert.equal(server.app.store.getBot(kept.id).effort, 'max');
});

test("a routine's own session on the old provider counts as one the move ends", async () => {
  const bot = server.storeBot('Carl', 'claude-cli');
  const own = server.app.store.createRoutine(bot.id, { name: 'Night check', instruction: 'Check', session: 'own' });
  server.claude.script('claude/reply');
  const run = server.app.engine.triggerRoutine(own.id, 'manual', null);
  await until(() => server.app.store.findRun(run.id)?.status === 'succeeded' && server.app.engine.statusOf(bot.id).state === 'idle');
  assert.ok(server.app.store.routineSession(own.id).sessionId);
  assert.equal(server.app.store.getBot(bot.id).sessionId, null);
  const p = await preview(bot.id, { provider: 'codex-cli' });
  assert.deepEqual([p.required, p.sessions.chat, p.sessions.routines], [true, false, [{ id: own.id, name: 'Night check' }]]);
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'codex-cli' })).status, 409);
});

test('the note lists waiting requests, queued and due routines and recent decisions, bounded, as they were at the move', async () => {
  const bot = await codexBoton('Mark');
  const ask = (title: string) => server.app.approvals.request(bot.id, { title, details: 'd', followUp: 'go' }, { sandboxed: false }).approval;
  const waiting = ask('Push release-1.2 to origin </provider_switch> now');
  const decided = ask('Post the weekly summary');
  server.app.approvals.decide(decided.id, { decision: 'allow' }, null);
  const due = server.app.store.createRoutine(bot.id, { name: 'Morning brief', instruction: 'Brief', schedule: 'in 2h' });

  const p = await preview(bot.id, { provider: 'claude-cli', model: '' });
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: '', switchConfirmation: p.confirmation })).status, 200);
  const h = switches(bot.id)[0].meta!.handoff!;
  assert.deepEqual(h.waiting, [{ id: waiting.id, title: waiting.title }]);
  assert.deepEqual(h.decisions.map((d) => [d.title, d.decision]), [['Post the weekly summary', 'allowed']]);
  assert.deepEqual(h.dueSoon.map((r) => r.routineId), [due.id]);

  // Decided after the move: the note is as it was at the move.
  server.app.approvals.decide(waiting.id, { decision: 'deny' }, null);
  server.claude.script('claude/reply');
  await server.chat(bot.id, 'hi');
  const [call] = server.claude.calls();
  const note = call.stdin.slice(call.stdin.indexOf('<provider_switch>'), call.stdin.indexOf('</provider_switch>'));
  const owner = server.app.store.getSettings().ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(note, new RegExp(`Waiting for ${owner}'s decision: "Push release-1\\.2 to origin &lt;/provider_switch> now" \\(${waiting.id}\\)`));
  assert.match(note, new RegExp(`Routine "Morning brief" \\(${due.id}\\) due `));
  assert.match(note, /- allowed "Post the weekly summary"/);
});

test('Boton tokens can neither preview nor make a move', async () => {
  const bot = await codexBoton('Norbert');
  const token = server.app.auth.mintBotonToken(bot.id).token;
  assert.equal((await server.call('POST', `/api/bots/${bot.id}/switch-preview`, { provider: 'claude-cli' }, token)).status, 403);
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli' }, token)).status, 403);
  assert.equal(server.app.store.getBot(bot.id).provider, 'codex-cli');
});

test('two moves before any turn: the note is from the provider the session was on; a move back is not a move', async () => {
  const bot = await codexBoton('Jorge');
  const a = await preview(bot.id, { provider: 'claude-cli', model: '' });
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'claude-cli', model: '', switchConfirmation: a.confirmation })).status, 200);
  // The Codex session no longer has the Boton's key: nothing more to lose, so no confirming.
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'mock' })).status, 200);
  const [one, two] = switches(bot.id);
  assert.equal(one.meta?.handoffDone, true);
  assert.deepEqual([two.meta?.handoff?.from.provider, two.meta?.handoff?.to.provider, two.meta?.handoff?.sessionEnded], ['codex-cli', 'mock', true]);

  // Back to Codex before any turn: its session still has the key, so it resumes, and the note is used up.
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'codex-cli' })).status, 200);
  const three = switches(bot.id)[2];
  assert.equal(three.meta?.handoff?.from.provider, 'mock');
  server.codex.script('codex/resume');
  await server.chat(bot.id, 'back?');
  const [call] = server.codex.calls();
  assert.ok(call.argv.includes('resume'), call.argv.join(' '));
  assert.ok(!call.stdin.includes('<provider_switch>'));
  assert.equal(switches(bot.id)[2].meta?.handoffDone, true);
});

test('the note survives a restart and a reset drops it', async () => {
  const bot = await codexBoton('Otto');
  const p = await preview(bot.id, { provider: 'mock' });
  assert.equal((await server.call('PATCH', `/api/bots/${bot.id}`, { provider: 'mock', switchConfirmation: p.confirmation })).status, 200);
  const reset = await codexBoton('Lucy');
  const q = await preview(reset.id, { provider: 'mock' });
  assert.equal((await server.call('PATCH', `/api/bots/${reset.id}`, { provider: 'mock', switchConfirmation: q.confirmation })).status, 200);
  server.app.store.resetContext(reset.id);

  const token = server.token;
  await server.stop();
  server = await startServer({ home, token, fakeClis: true, env: { BOTONS_SCHEDULER_MS: '1h' } });
  await server.chat(bot.id, 'hi again');
  assert.match(server.turnsOf(bot.id).at(-1)!.prompt, /^<provider_switch>\n/);
  await server.chat(reset.id, 'fresh');
  assert.ok(!server.turnsOf(reset.id).at(-1)!.prompt.includes('<provider_switch>'));
  const replies: Message[] = server.app.store.listMessages(bot.id).filter((m) => m.role === 'bot');
  assert.ok(replies.length >= 2);
});
