// Teams on a temp database, with no server and no agent: the engine is stood in by a small host, and a "turn" is the
// store's own startChatTurn with the scope and origin the engine would give it. Every clock is the test's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, Message, MessageMeta, ServerEvent, TeamItem } from '../../shared/types.ts';
import { TEAM_CONTEXT, TEAM_LIFETIME, TEAM_LIMITS } from '../../shared/teams.ts';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import type { PushRequest } from '../src/notify.ts';
import { chatInput } from '../src/prompt.ts';
import { HttpError, Store } from '../src/store.ts';
import { type ReplyOutcome, type TeamTurn, Teams } from '../src/teams.ts';
import { tempDir } from './helpers.ts';

const MIN = 60_000;

interface World {
  store: Store;
  teams: Teams;
  home: string;
  pushes: PushRequest[];
  woken: string[];
  turns: Map<string, TeamTurn>;
  clock: { now: number };
  /** What was published to clients. */
  events: ServerEvent[];
}

function open(home = tempDir('botons-teams-store-'), clock = { now: Date.parse('2026-11-16T09:00:00.000Z') }, limits = { perPair: 20, total: 100 }): World {
  const cfg = loadConfig({ BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1' });
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.subscribe((e) => void events.push(e));
  const store = new Store(cfg, hub, () => ({ state: 'idle', activity: null, since: null }));
  const teams = new Teams({ store, asksPerPairPerHour: limits.perPair, asksPerHour: limits.total, clock: () => clock.now });
  const pushes: PushRequest[] = [];
  const woken: string[] = [];
  const turns = new Map<string, TeamTurn>();
  teams.host = {
    wake: (id) => woken.push(id),
    turn: (id) => turns.get(id) ?? null,
    chip: (id, text, meta) => store.addMessage(id, 'event', text, meta),
    statusOf: () => ({ state: 'idle', activity: null, since: null }),
    usageLimitUntil: () => null,
    push: (r) => pushes.push(r),
    stopTeamTurns: () => {},
    postCard: (botId, card) =>
      store.addMessage(botId, 'event', 'Posted a card', {
        kind: 'card.posted',
        card: { descriptor: card as never, status: 'pending', expiresAt: new Date(clock.now + 7 * 86_400_000).toISOString(), from: { trigger: 'chat', routineId: null, routineName: null, runId: null, sandboxed: false } },
      }),
  };
  store.botTeams = (id) => teams.botTeams(id);
  store.beforeBotDeleted = (id) => teams.botDeleted(id);
  return { store, teams, home, pushes, woken, turns, clock, events };
}

const bot = (w: World, name: string): Bot => w.store.createBot({ name, provider: 'mock' }, new Set(['mock']), 'mock');

/** A turn of `b`, as the engine starts one: what it answers, its scope, its origin and its chain. */
function startTurn(w: World, b: Bot) {
  const { messages } = w.store.startChatTurn(b.id);
  // The engine builds a check-in's text as its turn starts.
  for (const m of messages) if (m.meta?.kind === 'team.checkin') w.teams.checkinPrompt(m, 'Sam');
  let chain: TeamTurn['chain'] = null;
  for (const m of messages) if (m.meta?.fromBotId && m.meta.threadId && (!chain || (m.meta.hop ?? 1) > chain.hop)) chain = { threadId: m.meta.threadId, hop: m.meta.hop ?? 1 };
  const turn: TeamTurn = { bot: w.store.getBot(b.id), turnId: `turn_${messages[0]?.id ?? 'none'}`, origin: messages.length ? `chat:${messages[0]!.id}` : null, chain, scope: w.teams.turnScope(b.id, messages) };
  w.turns.set(b.id, turn);
  return {
    messages,
    turn,
    /** The turn's end, as the engine writes it: one transaction with its replies. */
    end(outcome: ReplyOutcome, text = 'done') {
      w.store.atomically(() => {
        const ids = messages.map((m) => m.id);
        if (outcome === 'replied') w.store.finishChatTurn(ids, b.id, text, null);
        else w.store.markProcessed(ids);
        w.teams.replied(b, messages, text, outcome, turn.turnId);
      });
      w.turns.delete(b.id);
    },
  };
}

const ownerSays = (w: World, b: Bot, text = 'go') => w.store.addMessage(b.id, 'user', text, null, true);

function team(w: World, lead: Bot, ...members: Bot[]) {
  return w.teams.create({ name: `Atlas ${lead.name}`, goal: 'Ship the importer', members: [{ botId: lead.id, role: 'lead', roleTitle: 'Lead' }, ...members.map((m) => ({ botId: m.id, role: 'member' as const, roleTitle: 'Backend', responsibilities: 'The importer' }))] });
}

/** What waits in a chat (pending 1 or 2), oldest first. */
const pendingOf = (w: World, b: Bot): Message[] =>
  (w.store.db.prepare("select id from messages where bot_id = ? and role = 'user' and pending in (1, 2) order by seq").all(b.id) as { id: string }[]).map((r) => w.store.findMessage(r.id)!);
const pendingFlag = (w: World, id: string): number => Number((w.store.db.prepare('select pending from messages where id = ?').get(id) as { pending: number }).pending);
const refusal = (fn: () => unknown): { status: number; code?: string; message: string } => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
    throw err;
  }
  assert.fail('expected a refusal');
};
const itemOf = (w: World, id: string): TeamItem => w.teams.item(id).item;
const act = (w: World, b: Bot, id: string, input: Record<string, unknown>) => w.teams.act(id, input, { owner: false, botId: b.id });
const ownerAct = (w: World, id: string, input: Record<string, unknown>) => w.teams.act(id, input, { owner: true, by: null });
const asLead = (b: Bot) => ({ owner: false as const, botId: b.id });
const HOUR = 60 * MIN;
const chatInputOf = (m: Message) => chatInput([m], 'Sam', 'N');
const live = (i: TeamItem) => i.status !== 'done' && i.status !== 'cancelled';

/** The lead adds an item for `to` in a turn of its own; returns the item. */
function assigned(w: World, lead: Bot, teamId: string, to: Bot, title = 'Schema review'): TeamItem {
  ownerSays(w, lead, `plan ${title}`);
  const t = startTurn(w, lead);
  const { item } = w.teams.addItem(teamId, { title, assigneeBotId: to.id }, { owner: false, botId: lead.id });
  t.end('replied', 'planned');
  return item;
}

test('the same send from the same work, re-run after a restart, finds the first one even with a new implicit thread', () => {
  const w = open();
  const kevin = bot(w, 'Kevin');
  const stuart = bot(w, 'Stuart');
  ownerSays(w, kevin, 'ask Stuart for a summary');
  let t = startTurn(w, kevin);
  const first = w.teams.send(kevin.id, stuart.id, { text: 'Summarize X' });
  assert.equal(first.duplicate, false);
  assert.equal(first.state, 'dispatched');
  // The process dies before the turn ends: a new process, the same chat message re-run.
  w.turns.clear();
  const w2 = { ...open(w.home, w.clock), home: w.home };
  t = startTurn(w2, kevin);
  assert.equal(t.messages[0]!.id, first.message ? pendingOf(w2, kevin)[0]!.id : '', 'the same work');
  const again = w2.teams.send(kevin.id, stuart.id, { text: 'Summarize X' });
  assert.deepEqual([again.duplicate, again.teamMessageId, again.threadId], [true, first.teamMessageId, first.threadId]);
  assert.equal(w2.store.listMessages(stuart.id).filter((m) => m.meta?.kind === 'ask').length, 1, 'nothing new sent');
  assert.equal(w2.store.listMessages(kevin.id).filter((m) => m.meta?.kind === 'ask.sent').length, 1, 'no second chip');
  // Another text, or the same with another key, is a new send.
  assert.equal(w2.teams.send(kevin.id, stuart.id, { text: 'Summarize Y' }).duplicate, false);
  assert.equal(w2.teams.send(kevin.id, stuart.id, { text: 'Summarize X', key: 'second' }).duplicate, false);
});

test('two attempts with the same words are two assignment requests', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const s1 = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'block', reason: 'No access to the export', need: 'lead' });
  s1.end('replied', 'blocked');
  ownerSays(w, kevin, 'retry it');
  const k = startTurn(w, kevin);
  const retried = act(w, kevin, item.id, { action: 'retry' }).item;
  k.end('quiet');
  assert.deepEqual([retried.gen, retried.attempts, retried.status], [2, 2, 'open']);
  const requests = w.teams.messagesOf(retried.threadId!).filter((m) => m.kind === 'request');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.text, requests[1]!.text);
  assert.notEqual(requests[0]!.id, requests[1]!.id);
  assert.deepEqual(requests.map((m) => m.itemGen), [1, 2]);
});

test('fencing: an old turn of an assignment replaced A to B to A, or retried, or cancelled, changes nothing', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);

  // Reassigned to Bob and back to Stuart while Stuart's first turn is still running.
  const item = assigned(w, kevin, atlas.id, stuart);
  const old = startTurn(w, stuart);
  assert.equal(old.turn.scope!.get(item.id), 1);
  ownerAct(w, item.id, { action: 'assign', assigneeBotId: bob.id });
  ownerAct(w, item.id, { action: 'assign', assigneeBotId: stuart.id });
  assert.equal(itemOf(w, item.id).gen, 3);
  const r = refusal(() => act(w, stuart, item.id, { action: 'done', result: 'old work' }));
  assert.equal(r.code, 'replaced');
  assert.match(r.message, /Assignment 1 of item_\w+ was replaced \(now assignment 3, open, Stuart\)/);
  old.end('replied', 'did the old thing');
  assert.deepEqual([itemOf(w, item.id).status, itemOf(w, item.id).gen], ['open', 3], 'the stale reply moved nothing');
  const reply = w.store.listMessages(kevin.id).find((m) => m.meta?.kind === 'ask.reply' && m.text === 'did the old thing')!;
  assert.equal(reply.meta?.stale, true);
  assert.ok(w.teams.messagesOf(itemOf(w, item.id).threadId!).some((m) => m.kind === 'reply' && m.stale));
  // An item given to it after the turn started is not this turn's.
  const later = assigned(w, kevin, atlas.id, bob, 'Later');
  const bobTurn = startTurn(w, bob);
  bobTurn.end('quiet');
  ownerSays(w, stuart, 'busy');
  const s2 = startTurn(w, stuart);
  ownerAct(w, later.id, { action: 'assign', assigneeBotId: stuart.id });
  assert.equal(refusal(() => act(w, stuart, later.id, { action: 'start' })).code, 'not_in_turn');
  s2.end('quiet');

  // Retried (same assignee) while the old turn runs: the old turn's done is refused.
  const retry = assigned(w, kevin, atlas.id, stuart, 'Retry me');
  const r1 = startTurn(w, stuart);
  act(w, stuart, retry.id, { action: 'block', reason: 'stuck', need: 'lead' });
  ownerAct(w, retry.id, { action: 'retry' });
  assert.equal(refusal(() => act(w, stuart, retry.id, { action: 'done', result: 'x' })).code, 'replaced');
  r1.end('replied', 'old');
  assert.equal(itemOf(w, retry.id).status, 'open');

  // Cancelled while the assignee works: its late done is refused and the item stays cancelled.
  const cancel = assigned(w, kevin, atlas.id, stuart, 'Cancel me');
  const c1 = startTurn(w, stuart);
  ownerAct(w, cancel.id, { action: 'cancel', reason: 'not needed' });
  assert.equal(refusal(() => act(w, stuart, cancel.id, { action: 'done', result: 'x' })).code, 'replaced');
  c1.end('replied', 'finished it anyway');
  assert.equal(itemOf(w, cancel.id).status, 'cancelled');
});

test("fencing: a removed member, a lead's stale cancel against a replacement, and a stale request replayed after a restart", () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const item = assigned(w, kevin, atlas.id, stuart);

  // Removed mid-turn: its seat is checked now, not when the turn started.
  const s = startTurn(w, stuart);
  w.teams.setMembers(atlas.id, { members: [{ botId: kevin.id, role: 'lead' }, { botId: bob.id, role: 'member' }] });
  assert.equal(refusal(() => act(w, stuart, item.id, { action: 'start' })).status, 403);
  s.end('replied', 'late');
  const freed = itemOf(w, item.id);
  assert.deepEqual([freed.status, freed.assigneeBotId, freed.gen], ['open', null, 2]);

  // The lead's turn started on gen 2; the owner gives it to Bob meanwhile; the lead's cancel would hit Bob's work.
  ownerSays(w, kevin, 'tidy up');
  const k = startTurn(w, kevin);
  ownerAct(w, item.id, { action: 'assign', assigneeBotId: bob.id });
  const stale = refusal(() => act(w, kevin, item.id, { action: 'cancel', reason: 'tidy' }));
  assert.equal(stale.code, 'changed');
  assert.match(stale.message, /changed during this turn .*A check-in will bring it/);
  k.end('quiet');
  assert.equal(itemOf(w, item.id).status, 'open');

  // Bob's request is in flight when the owner gives it back to the lead's plan (reassigned to Stuart's replacement:
  // Kevin itself); the server restarts and Bob's turn re-runs its old request.
  w.teams.setMembers(atlas.id, { members: [{ botId: kevin.id, role: 'lead' }, { botId: bob.id, role: 'member' }, { botId: stuart.id, role: 'member' }], version: w.teams.get(atlas.id).version });
  startTurn(w, bob);
  w.turns.clear();
  ownerAct(w, item.id, { action: 'assign', assigneeBotId: stuart.id });
  const w2 = open(w.home, w.clock);
  w2.teams.resume();
  const replay = startTurn(w2, bob);
  assert.equal(replay.turn.scope!.get(item.id), 3, 'the gen its request names');
  assert.equal(refusal(() => act(w2, bob, item.id, { action: 'start' })).code, 'replaced');
  replay.end('replied', 'old answer');
  assert.deepEqual([itemOf(w2, item.id).assigneeBotId, itemOf(w2, item.id).gen], [stuart.id, 4]);
});

test('replies close their deliveries in the turn’s own transaction on every path; an ask from before Teams is answered as it was', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const send = (text: string) => {
    ownerSays(w, kevin, `ask: ${text}`);
    const k = startTurn(w, kevin);
    const r = w.teams.send(kevin.id, stuart.id, { text });
    k.end('replied', 'asked');
    return r;
  };
  const delivery = (id: string) => w.teams.messagesOf(w.teams.threads({ bot: stuart.id }).find((t) => w.teams.messagesOf(t.id).some((m) => m.id === id))!.id).find((m) => m.id === id)!.delivery!;
  for (const outcome of ['replied', 'quiet', 'failed', 'stopped', 'dropped'] as const) {
    const sent = send(`about ${outcome}`);
    const s = startTurn(w, stuart);
    s.end(outcome, outcome === 'failed' ? '(Stuart could not answer: boom)' : 'an answer');
    assert.deepEqual([delivery(sent.teamMessageId).state, delivery(sent.teamMessageId).outcome], ['handled', outcome], outcome);
    const replies = w.store.listMessages(kevin.id).filter((m) => m.meta?.kind === 'ask.reply' && m.meta.threadId === sent.threadId);
    assert.equal(replies.length, outcome === 'stopped' || outcome === 'dropped' ? 0 : 1, outcome);
    while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  }
  // A crash inside the turn's transaction leaves both undone: the asker is never told of a turn that didn't end.
  const sent = send('crash');
  const s = startTurn(w, stuart);
  assert.throws(() =>
    w.store.atomically(() => {
      w.store.finishChatTurn(s.messages.map((m) => m.id), stuart.id, 'half', null);
      w.teams.replied(stuart, s.messages, 'half', 'replied');
      throw new Error('crash');
    }),
  );
  assert.equal(delivery(sent.teamMessageId).state, 'dispatched');
  assert.ok(!w.store.listMessages(kevin.id).some((m) => m.text === 'half'));
  s.end('replied', 'whole');
  assert.ok(w.store.listMessages(kevin.id).some((m) => m.meta?.kind === 'ask.reply' && m.text === 'whole'));

  // Pending before the upgrade: no thread, message or delivery row. Still answered, as before, and nothing recorded.
  const legacy = w.store.addMessage(stuart.id, 'user', 'an old ask', { kind: 'ask', fromBotId: kevin.id, fromBotName: 'Kevin', threadId: 'thr_before', hop: 1 } as MessageMeta, true);
  const lt = startTurn(w, stuart);
  assert.deepEqual(lt.messages.map((m) => m.id), [legacy.id]);
  lt.end('replied', 'old answer');
  const back = w.store.listMessages(kevin.id).find((m) => m.text === 'old answer')!;
  assert.deepEqual([back.meta?.kind, back.meta?.threadId, back.meta?.askId, back.meta?.teamMessageId], ['ask.reply', 'thr_before', legacy.id, undefined]);
  assert.equal(w.teams.threadOf('thr_before'), null);
});

test('dispatch: three in a chat at once, in order; recall takes back what has not started', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  ownerSays(w, kevin);
  const k = startTurn(w, kevin);
  const sent = ['one', 'two', 'three', 'four'].map((text) => w.teams.send(kevin.id, stuart.id, { text }));
  k.end('replied', 'asked');
  assert.deepEqual(sent.map((r) => r.state), ['dispatched', 'dispatched', 'dispatched', 'queued']);
  assert.equal(sent[3]!.ahead, 0);
  assert.equal(sent[3]!.message, null);
  assert.deepEqual(pendingOf(w, stuart).map((m) => m.text), ['one', 'two', 'three']);
  // Stuart answers them all in one turn (one audience); the fourth enters then.
  startTurn(w, stuart).end('replied', 'answered');
  assert.deepEqual(pendingOf(w, stuart).map((m) => m.text), ['four']);

  // Recall: a queued one is cancelled, one in flight is left to finish, one waiting in the chat leaves it (quiet).
  ownerSays(w, kevin);
  const k2 = startTurn(w, kevin);
  const more = ['five', 'six', 'seven'].map((text) => w.teams.send(kevin.id, stuart.id, { text }));
  k2.end('replied', 'asked');
  assert.deepEqual(more.map((r) => r.state), ['dispatched', 'dispatched', 'queued']);
  const busy = startTurn(w, stuart); // four, five and six in flight
  assert.equal(w.teams.recall({ messageIds: [more[0]!.teamMessageId, more[2]!.teamMessageId] }), 1, 'only the queued one');
  assert.equal(pendingFlag(w, more[0]!.message!.id), 2, 'five is left to finish');
  busy.end('replied', 'answered');
  ownerSays(w, kevin);
  const k3 = startTurn(w, kevin);
  const eight = w.teams.send(kevin.id, stuart.id, { text: 'eight' });
  k3.end('replied', 'asked');
  assert.equal(eight.state, 'dispatched');
  assert.equal(w.teams.recall({ messageIds: [eight.teamMessageId] }), 1);
  const gone = w.store.findMessage(eight.message!.id)!;
  assert.deepEqual([pendingFlag(w, gone.id), gone.meta?.quiet], [0, true]);
});

test('pause, resume and stop: nothing dispatches while paused, resuming re-delivers in order and restarts the clocks', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const request = pendingOf(w, stuart)[0]!;
  w.teams.setState(atlas.id, { state: 'paused' });
  assert.deepEqual([pendingFlag(w, request.id), w.store.findMessage(request.id)!.meta?.quiet], [0, true], 'not started: taken back');
  assert.equal(pendingOf(w, stuart).length, 0);
  // The assignee's own record still goes on while paused; the lead's sends don't.
  ownerSays(w, kevin);
  const k = startTurn(w, kevin);
  assert.equal(refusal(() => act(w, kevin, item.id, { action: 'assign', assigneeBotId: stuart.id })).code, 'team_not_active');
  k.end('quiet');
  assert.equal(w.teams.supervise().checkins, 0);
  w.clock.now += 3 * 3_600_000;
  w.teams.setState(atlas.id, { state: 'active' });
  assert.equal(pendingOf(w, stuart)[0]!.text, 'Schema review', 'delivered again');
  assert.equal(itemOf(w, item.id).nextCheckAt, new Date(w.clock.now + 30 * MIN).toISOString(), 'a pause never reads as a stall');
  assert.equal(w.teams.supervise().checkins, 0);

  // Stop work: in flight closes as stopped and working items wait for the owner.
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  w.teams.setState(atlas.id, { state: 'paused', stop: true });
  const stopped = itemOf(w, item.id);
  assert.deepEqual([stopped.status, stopped.blockedNeed, stopped.blockedReason], ['blocked', 'owner', 'Stopped by Sam'.replace('Sam', w.store.getSettings().ownerName)]);
  assert.equal(w.teams.get(atlas.id).pausedReason, 'stopped');
  s.end('stopped', '');
});

test('a queued request expires after a day, and its item says so', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  // Three asks fill Stuart's chat first, so the assignment waits in the outbox.
  ownerSays(w, kevin);
  const k = startTurn(w, kevin);
  for (const text of ['a', 'b', 'c']) w.teams.send(kevin.id, stuart.id, { text });
  k.end('replied', 'asked');
  const item = assigned(w, kevin, atlas.id, stuart);
  w.clock.now += 25 * 3_600_000;
  assert.equal(w.teams.expireDue(), 1);
  const after = w.teams.item(item.id);
  assert.ok(after.events.some((e) => e.kind === 'expired'));
  assert.ok(after.item.evidence.some((e) => e.kind === 'expired'));
  assert.equal(w.teams.messagesOf(after.item.threadId!)[0]!.delivery!.state, 'expired');
});

test('after reopening the database: hourly counts hold, a lost request is closed, queued ones dispatch', () => {
  const home = tempDir('botons-teams-reopen-');
  const clock = { now: Date.parse('2026-11-16T09:00:00.000Z') };
  const w = open(home, clock, { perPair: 2, total: 100 });
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  ownerSays(w, kevin);
  const k = startTurn(w, kevin);
  w.teams.send(kevin.id, stuart.id, { text: 'one' });
  const two = w.teams.send(kevin.id, stuart.id, { text: 'two' });
  w.turns.clear();
  // Stuart's chat message for "two" was lost (answered with nothing, say by hand): it is closed at the restart.
  w.store.markProcessed([two.message!.id]);
  w.store.db.close();
  const w2 = open(home, clock, { perPair: 2, total: 100 });
  w2.teams.resume();
  const lost = w2.teams.messagesOf(two.threadId).find((m) => m.id === two.teamMessageId)!;
  assert.deepEqual([lost.delivery?.state, lost.delivery?.outcome], ['handled', 'lost']);
  const k2 = startTurn(w2, kevin);
  // Kevin's turn re-runs, and hears that Stuart could not answer the lost one.
  assert.deepEqual(k2.messages.map((m) => m.meta?.kind ?? m.text), ['go', 'ask.reply']);
  assert.equal(k2.messages[1]!.text, '(Stuart could not answer: it was lost at a restart)');
  const r = refusal(() => w2.teams.send(kevin.id, stuart.id, { text: 'three' }));
  assert.equal(r.status, 429, 'the pair has sent 2 this hour, before the restart too');
  assert.match(r.message, /Kevin and Stuart have sent 2 asks in the last hour/);
  assert.equal(k.messages.length, 1);
});

test('threads are read by seats now; search takes wildcards literally; the read marker only moves forward', () => {
  const w = open();
  const [kevin, stuart, bob, dave] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob'), bot(w, 'Dave')];
  const atlas = team(w, kevin, stuart, bob);
  ownerSays(w, stuart);
  const s = startTurn(w, stuart);
  const inTeam = w.teams.send(stuart.id, bob.id, { text: 'Is 100% of the a_b table loaded?', team: atlas.id });
  const direct = w.teams.send(stuart.id, dave.id, { text: 'Lunch at noon?' });
  s.end('replied', 'asked');
  assert.ok(w.teams.threadFor(bob.id, inTeam.threadId), 'a participant with a seat');
  assert.ok(w.teams.threadFor(kevin.id, inTeam.threadId), "the team's lead");
  assert.equal(refusal(() => w.teams.threadFor(dave.id, inTeam.threadId)).status, 403, 'no seat');
  assert.equal(refusal(() => w.teams.threadFor(kevin.id, direct.threadId)).status, 403, 'Direct: participants only');
  w.teams.setMembers(atlas.id, { members: [{ botId: kevin.id, role: 'lead' }, { botId: stuart.id, role: 'member' }] });
  assert.equal(refusal(() => w.teams.threadFor(bob.id, inTeam.threadId)).status, 403, 'removed: no longer');
  assert.equal(refusal(() => w.teams.send(stuart.id, bob.id, { text: 'again', thread: inTeam.threadId })).status, 403, 'nor sent to');

  assert.deepEqual(w.teams.search('100%').map((h) => h.messageId), [inTeam.teamMessageId]);
  assert.deepEqual(w.teams.search('%'), w.teams.search('100%'), '% is a percent sign');
  assert.equal(w.teams.search('a_b').length, 1);
  assert.equal(w.teams.search('a%b').length, 0);
  assert.equal(w.teams.search('LUNCH', { team: 'direct' }).length, 1);
  assert.equal(w.teams.search('lunch', { team: atlas.id }).length, 0);
  assert.match(w.teams.search('table')[0]!.snippet, /a_b table loaded/);

  assert.equal(w.teams.threadOf(inTeam.threadId)!.unread, true);
  const seq = w.teams.messagesOf(inTeam.threadId)[0]!.seq;
  assert.equal(w.teams.markThreadRead(inTeam.threadId, seq).unread, false);
  assert.equal(w.teams.attention().unreadThreads, 1, 'only the Direct one');
  w.teams.markThreadRead(inTeam.threadId, 0);
  assert.equal(w.teams.threadOf(inTeam.threadId)!.unread, false, 'never back');
});

test('a thread opens at its newest page, pages back with before and forward with after; a row carries its newest request\'s delivery', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  ownerSays(w, stuart);
  const s = startTurn(w, stuart);
  const first = w.teams.send(stuart.id, bob.id, { text: 'one', team: atlas.id });
  for (const text of ['two', 'three', 'four']) w.teams.send(stuart.id, bob.id, { text, thread: first.threadId });
  s.end('replied', 'asked');
  const texts = (list: { text: string }[]) => list.map((m) => m.text);
  assert.deepEqual(texts(w.teams.messagesOf(first.threadId, { limit: 2 })), ['three', 'four'], 'the newest page, oldest first');
  const newest = w.teams.messagesOf(first.threadId, { limit: 2 });
  assert.deepEqual(texts(w.teams.messagesOf(first.threadId, { before: newest[0]!.seq, limit: 2 })), ['one', 'two']);
  assert.deepEqual(texts(w.teams.messagesOf(first.threadId, { after: newest[0]!.seq })), ['four']);
  const row = w.teams.threadOf(first.threadId)!;
  assert.equal(row.lastDelivery?.botId, bob.id);
  assert.equal(row.lastDelivery?.queuedAt, newest[1]!.delivery?.queuedAt, "the newest request's");
  assert.ok(row.lastDelivery?.queuedAt);
});

test('every live item has its next look and one reason it stands; nothing told is stale', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const a = assigned(w, kevin, atlas.id, stuart, 'A');
  const b = assigned(w, kevin, atlas.id, bob, 'B');
  const c = assigned(w, kevin, atlas.id, stuart, 'C');
  const st = startTurn(w, stuart);
  act(w, stuart, a.id, { action: 'start' });
  act(w, stuart, a.id, { action: 'done', result: 'A is done' });
  act(w, stuart, c.id, { action: 'start' });
  st.end('replied', 'did A, started C');
  // Bob's turn ends without a word on B: silent, on record.
  startTurn(w, bob).end('replied', 'hm');
  assert.ok(w.teams.item(b.id).events.some((e) => e.kind === 'silent_end'));
  const reply = w.store.listMessages(kevin.id).find((m) => m.meta?.kind === 'ask.reply' && m.meta.fromBotId === bob.id)!;
  assert.equal(reply.meta?.silent, true);

  // The lead reopens A before its check-in runs: the check-in leaves out the done that is no longer true.
  ownerSays(w, kevin, 'reopen A');
  const k = startTurn(w, kevin);
  act(w, kevin, a.id, { action: 'reopen' });
  k.end('quiet');
  assert.equal(w.teams.supervise().checkins, 1);
  const checkin = pendingOf(w, kevin).find((m) => m.meta?.kind === 'team.checkin')!;
  const text = w.teams.checkinPrompt(checkin, 'Sam', 'N');
  assert.doesNotMatch(text, /done by Stuart/);
  assert.match(text, /Nothing needs you now|What needs you now/);

  for (const i of w.teams.detail(atlas.id).items) {
    if (i.status === 'done' || i.status === 'cancelled') assert.equal(i.nextCheckAt, null, i.title);
    else assert.ok(i.nextCheckAt, `${i.title} has its next look`);
  }
  const live = w.teams.detail(atlas.id).items.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
  for (const i of live) {
    const events = w.teams.item(i.id).events.filter((e) => e.gen === i.gen).map((e) => e.kind);
    const stands = i.status === 'blocked' || i.waiting !== null || events.some((k) => ['silent_end', 'turn_failed', 'not_started', 'stalled', 'started', 'assigned', 'reopened', 'created'].includes(k));
    assert.ok(stands, `${i.title}: ${events.join(', ')}`);
  }
});

test('kickoff and wrap-up each come once, also with every item finished', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  assert.equal(w.teams.supervise().checkins, 1, 'kickoff');
  const kickoff = pendingOf(w, kevin).find((m) => m.meta?.kind === 'team.checkin')!;
  assert.match(w.teams.checkinPrompt(kickoff, 'Sam', 'N'), /no items yet/);
  startTurn(w, kevin).end('quiet');
  assert.equal(w.teams.supervise().checkins, 0, 'once');
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'done', result: 'Done and tested' });
  s.end('replied', 'done');
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  assert.equal(itemOf(w, item.id).nextCheckAt, null, 'nothing left to look at on the item');
  assert.equal(w.teams.supervise().checkins, 1, 'the done and the wrap-up, together');
  const wrap = pendingOf(w, kevin).find((m) => m.meta?.kind === 'team.checkin')!;
  const text = w.teams.checkinPrompt(wrap, 'Sam', 'N');
  assert.match(text, /Every item is finished/);
  assert.match(text, /done by Stuart/);
  assert.match(text, /<boton_message from="Stuart" id="N">\nResult of item_\w+: Done and tested\n<\/boton_message>/);
  startTurn(w, kevin).end('quiet');
  w.clock.now += 3_600_000;
  assert.equal(w.teams.supervise().checkins, 0, 'once');
  // The lead finishes it: a record for the owner, one push.
  ownerSays(w, kevin, 'wrap up');
  const k = startTurn(w, kevin);
  assert.equal(refusal(() => w.teams.finish(atlas.id, {}, kevin.id)).code, 'gate');
  const done = w.teams.finish(atlas.id, { summary: 'Shipped' }, kevin.id);
  k.end('replied', 'report');
  assert.equal(done.state, 'done');
  assert.deepEqual(done.completion!.done.map((d) => d.result), ['Done and tested']);
  assert.equal(w.teams.attention().count, 1, 'to review');
  assert.equal(w.pushes.filter((p) => p.reason === 'team').length, 1);
  w.teams.review(atlas.id);
  assert.equal(w.teams.attention().count, 0);
});

test('a silent lead: check-ins at 0:30, 1:30 and 3:30, then the server escalates once at 7:30 with one push, then nothing', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const start = w.clock.now;
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  s.end('replied', 'on it');
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  const at: string[] = [];
  for (let m = 5; m <= 12 * 60; m += 5) {
    w.clock.now = start + m * MIN;
    const r = w.teams.supervise();
    if (r.checkins) at.push(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} checkin`);
    if (r.escalations) at.push(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} escalation`);
    // The lead's every check-in turn ends quiet without doing anything.
    while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  }
  assert.deepEqual(at, ['0:30 checkin', '1:30 checkin', '3:30 checkin', '7:30 escalation']);
  const pushes = w.pushes.filter((p) => p.reason === 'team');
  assert.equal(pushes.length, 1);
  assert.deepEqual([pushes[0]!.teamId, pushes[0]!.itemId, pushes[0]!.bot?.id, !!pushes[0]!.messageId], [atlas.id, item.id, kevin.id, true]);
  const after = itemOf(w, item.id);
  assert.equal(after.escalation?.by, 'server');
  assert.ok(after.evidence.some((e) => e.kind === 'checkin'), 'on what the server recorded');
  assert.equal(after.attempts, 1, 'no attempt invented');
  assert.equal(w.teams.attention().count, 1);
  // The owner's answer: attempts and check-ins start again, the lifetime counts don't.
  w.teams.ownerAnswered(kevin.id, after.escalation!.cardMessageId, null);
  const answered = itemOf(w, item.id);
  assert.deepEqual([answered.escalation, answered.nudges, answered.attempts, answered.lifetime.checkins, answered.lifetime.escalations], [null, 0, 0, 3, 1]);
});

test("the lead's escalation: refused without evidence, texts or a try; accepted after a retry; one open at a time", () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const inLead = <T>(fn: () => T): T => {
    ownerSays(w, kevin, 'escalate?');
    const k = startTurn(w, kevin);
    try {
      return fn();
    } finally {
      k.end('quiet');
    }
  };
  const texts = { summary: 'The export needs a key', tried: 'Retried once', need: 'Put the key in the shared folder' };
  assert.match(inLead(() => refusal(() => w.teams.escalate(item.id, texts, kevin.id))).message, /not blocked/);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'block', reason: 'No key', need: 'lead' });
  s.end('replied', 'blocked');
  assert.match(inLead(() => refusal(() => w.teams.escalate(item.id, texts, kevin.id))).message, /Try something first/);
  assert.equal(refusal(() => w.teams.escalate(item.id, texts, stuart.id)).status, 403, 'a member never escalates');
  inLead(() => act(w, kevin, item.id, { action: 'retry' }));
  const s2 = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'block', reason: 'Still no key', need: 'lead' });
  s2.end('replied', 'blocked');
  assert.match(inLead(() => refusal(() => w.teams.escalate(item.id, { summary: 'x' }, kevin.id))).message, /--tried, --need/);
  const ok = inLead(() => w.teams.escalate(item.id, texts, kevin.id));
  assert.equal(ok.duplicate, false);
  assert.equal(inLead(() => w.teams.escalate(item.id, texts, kevin.id)).duplicate, true);
  assert.equal(w.pushes.filter((p) => p.reason === 'team').length, 1);
  const card = w.store.findMessage(ok.item.escalation!.cardMessageId)!;
  assert.equal(card.meta?.card?.descriptor.title, 'Blocked: Schema review');
});

test('deleting a Boton frees its items, answers its open requests as gone, and pauses a team it led', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const item = assigned(w, kevin, atlas.id, stuart);
  w.store.deleteBot(stuart.id);
  const freed = itemOf(w, item.id);
  assert.deepEqual([freed.status, freed.assigneeBotId], ['open', null]);
  assert.match(w.store.listMessages(kevin.id).find((m) => m.meta?.kind === 'ask.reply')!.text, /could not answer: it was deleted/);
  w.store.deleteBot(kevin.id);
  const t = w.teams.get(atlas.id);
  assert.deepEqual([t.state, t.pausedReason, t.lead], ['paused', 'no_lead', null]);
  assert.equal(w.pushes.filter((p) => p.reason === 'team').length, 1);
  assert.equal(refusal(() => w.teams.setState(atlas.id, { state: 'active' })).code, 'not_allowed');
});

test('roster rules: one lead, sizes, names unique while not archived, versions', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  assert.match(refusal(() => w.teams.create({ name: 'Atlas', members: [{ botId: kevin.id, role: 'member' }] })).message, /exactly one lead/);
  assert.match(refusal(() => w.teams.create({ name: 'A'.repeat(61), members: [{ botId: kevin.id, role: 'lead' }] })).message, /too long/);
  const atlas = w.teams.create({ name: 'Atlas', members: [{ botId: kevin.id, role: 'lead' }, { botId: stuart.id, role: 'member' }] });
  assert.equal(refusal(() => w.teams.create({ name: 'atlas', members: [{ botId: kevin.id, role: 'lead' }] })).status, 409);
  assert.equal(refusal(() => w.teams.update(atlas.id, { goal: 'x', version: 99 })).code, 'stale_version');
  w.teams.setState(atlas.id, { state: 'archived' });
  assert.ok(w.teams.create({ name: 'Atlas', members: [{ botId: kevin.id, role: 'lead' }] }), 'free again once archived');
  assert.deepEqual(w.store.publicBot(w.store.getBot(kevin.id)).teams!.map((t) => t.role), ['lead']);
  for (let i = 0; i < TEAM_LIMITS.teamsPerBot - 1; i++) w.teams.create({ name: `T${i}`, members: [{ botId: kevin.id, role: 'lead' }] });
  assert.match(refusal(() => w.teams.create({ name: 'One more', members: [{ botId: kevin.id, role: 'lead' }] })).message, /already in 5 teams/);
});

test('the context block: every seat in full, the rest as space allows, and what is left out named', () => {
  const w = open();
  const kevin = bot(w, 'Kevin');
  const mates = ['Stuart', 'Bob', 'Dave', 'Otto', 'Mel', 'Phil', 'Tim'].map((n) => bot(w, n));
  for (let i = 0; i < 5; i++) {
    w.teams.create({
      name: `Team ${i}`,
      goal: `Goal <b>${i}</b> `.repeat(80),
      members: [{ botId: kevin.id, role: i === 0 ? 'lead' : 'member', roleTitle: 'Role <x>', responsibilities: 'R'.repeat(600) }, ...mates.map((m) => ({ botId: m.id, role: (i === 0 ? 'member' : m === mates[0] ? 'lead' : 'member') as 'lead' | 'member', responsibilities: 'S'.repeat(600) }))],
    });
  }
  const lines = w.teams.contextFor(kevin.id)!;
  const text = lines.join('\n');
  assert.ok(text.length <= 4500, `${text.length}`);
  for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`^- Team ${i} \\(team_\\w+\\): you are (the lead|a member)`, 'm'));
  assert.ok(!/<b>|<x>|<\/b>/.test(text), 'no angle brackets from what anyone wrote');
  assert.match(text, /Not shown here: .*Run `botons team show Team \d`/);
  assert.match(text, /Lead: Stuart \(bot_\w+\)\./);
});

/** An object's shape: its keys, each with the shape of its value (an array by its first element's), types not values. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? 'null-or-any' : 'value';
}
/** Shapes compared where both have a value: null on either side matches anything (the fixtures show one case of each). */
function sameShape(real: unknown, fixture: unknown, at = '$'): void {
  if (real === 'null-or-any' || fixture === 'null-or-any') return;
  if (Array.isArray(real) || Array.isArray(fixture)) {
    assert.ok(Array.isArray(real) && Array.isArray(fixture), `${at}: an array on one side only`);
    if (real.length && fixture.length) sameShape(real[0], fixture[0], `${at}[0]`);
    return;
  }
  if (real && typeof real === 'object' && fixture && typeof fixture === 'object') {
    assert.deepEqual(Object.keys(real), Object.keys(fixture), `${at}: the server's keys are the fixture's`);
    for (const k of Object.keys(real)) sameShape((real as Record<string, unknown>)[k], (fixture as Record<string, unknown>)[k], `${at}.${k}`);
    return;
  }
  assert.equal(typeof real, typeof fixture, at);
}

test("the server's answers have the shapes of the contract fixtures both apps decode", async () => {
  const { FILES } = await import('./fixtures/teams/contract.ts');
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  const started = act(w, stuart, item.id, { action: 'start' });
  const asked = w.teams.send(stuart.id, bob.id, { text: 'Which table holds the export?', team: atlas.id, item: item.id });
  s.end('replied', 'on it');
  const thread = w.teams.threads({ team: atlas.id })[0]!;
  const real: Record<string, unknown> = {
    'teams.json': w.teams.list(),
    'team-detail.json': w.teams.detail(atlas.id),
    'team-item.json': w.teams.item(item.id),
    'team-threads.json': w.teams.threads(),
    'team-thread.json': w.teams.threadDetail(thread.id),
    'team-messages.json': w.teams.messagesOf(thread.id),
    'teams-attention.json': w.teams.attention(),
    'teams-search.json': w.teams.search('export'),
    'team-item-action.json': started,
    'bot-teams.json': w.teams.botView(stuart.id),
    'ask-queued.json': asked,
  };
  for (const [name, value] of Object.entries(real)) sameShape(shape(value), shape(FILES[name]), name);
});

test('an assignment is bounded like an ask: the recipient backlog refuses it, the owner is not refused, and asks keep their own counts', () => {
  const w = open(undefined, undefined, { perPair: 2, total: 100 });
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  ownerSays(w, kevin, 'plan the work');
  const k = startTurn(w, kevin);
  for (let i = 0; i < TEAM_LIMITS.recipientBacklog; i++) w.teams.addItem(atlas.id, { title: `Part ${i}`, assigneeBotId: stuart.id }, asLead(kevin));
  const added = refusal(() => w.teams.addItem(atlas.id, { title: 'One more', assigneeBotId: stuart.id }, asLead(kevin)));
  assert.deepEqual([added.status, added.code], [429, 'limit']);
  assert.match(added.message, /^“One more” was not added: Stuart has 10 messages waiting, the limit\./);
  const spare = w.teams.addItem(atlas.id, { title: 'Spare' }, asLead(kevin)).item;
  const assign = refusal(() => act(w, kevin, spare.id, { action: 'assign', assigneeBotId: stuart.id }));
  assert.deepEqual([assign.status, assign.code], [429, 'limit']);
  assert.match(assign.message, /was not assigned to Stuart: Stuart has 10 messages waiting, the limit/);
  assert.equal(itemOf(w, spare.id).assigneeBotId, null, 'nothing changed');
  assert.equal(w.teams.detail(atlas.id).items.length, 11, 'the refused one was not added');
  // Two assignments to Bob are not asks: Kevin may still ask Bob twice this hour, its pair's limit, and no more.
  act(w, kevin, spare.id, { action: 'assign', assigneeBotId: bob.id });
  w.teams.addItem(atlas.id, { title: 'For Bob', assigneeBotId: bob.id }, asLead(kevin));
  for (const text of ['one', 'two']) assert.equal(w.teams.send(kevin.id, bob.id, { text }).duplicate, false);
  const third = refusal(() => w.teams.send(kevin.id, bob.id, { text: 'three' }));
  assert.equal(third.status, 429);
  assert.match(third.message, /Kevin and Bob have sent 2 asks in the last hour/);
  k.end('replied', 'planned');
  // The owner's own assignment is not refused.
  assert.equal(w.teams.addItem(atlas.id, { title: 'Owner', assigneeBotId: stuart.id }, { owner: true, by: null }).item.assigneeBotId, stuart.id);
});

test("a lead and an assignee answering each other are bounded by the team's budgets, also after reopening the database", () => {
  const home = tempDir('botons-teams-pingpong-');
  const clock = { now: Date.parse('2026-11-16T09:00:00.000Z') };
  // Hundreds of turns: the temp database need not wait for the disk on each.
  const fast = (x: World) => (x.store.db.exec('pragma synchronous = off'), x);
  let w = fast(open(home, clock));
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  w.teams.update(atlas.id, { limits: { messagesPerDay: 150, maxAttempts: 6 } });
  // Stuart does what it is given and replies; the reply wakes Kevin, whose turn gives it the next one.
  const stuartWorks = () => {
    const s = startTurn(w, stuart);
    for (const m of s.messages) {
      if (m.meta?.itemId && m.meta.itemGen !== undefined) {
        act(w, stuart, m.meta.itemId, { action: 'start' });
        act(w, stuart, m.meta.itemId, { action: 'done', result: 'ok' });
      }
    }
    s.end('replied', 'done');
  };
  const leadTurn = <T>(fn: () => T): { ok: T } | { refused: { status: number; code?: string; message: string } } => {
    const k = startTurn(w, kevin);
    try {
      return { ok: fn() };
    } catch (err) {
      if (err instanceof HttpError) return { refused: { status: err.status, code: err.code, message: err.message } };
      throw err;
    } finally {
      k.end('replied', 'next');
    }
  };
  const requests = () => Number((w.store.db.prepare("select count(*) as n from team_messages where team_id = ? and kind = 'request'").get(atlas.id) as { n: number }).n);
  // New items, until a budget refuses one: the items a day.
  ownerSays(w, kevin, 'start');
  let n = 0;
  let last: ReturnType<typeof leadTurn>;
  for (;;) {
    last = leadTurn(() => w.teams.addItem(atlas.id, { title: `Part ${n}`, assigneeBotId: stuart.id }, asLead(kevin)));
    if ('refused' in last) break;
    n++;
    stuartWorks();
  }
  assert.equal(n, TEAM_LIMITS.itemsPerTeamPerDay);
  assert.deepEqual([last.refused.status, last.refused.code], [429, 'limit']);
  assert.match(last.refused.message, /has had 60 items added today, the limit for its Botons/);
  // A new process: the counts are the database's.
  w.store.db.close();
  w = fast(open(home, clock));
  ownerSays(w, kevin, 'again');
  const again = leadTurn(() => w.teams.addItem(atlas.id, { title: 'After the restart', assigneeBotId: stuart.id }, asLead(kevin)));
  assert.ok('refused' in again && again.refused.code === 'limit', JSON.stringify(again));

  // Two hours on: the same items reopened and given again, until the hour's messages are spent.
  clock.now += 2 * HOUR;
  const done = w.teams.detail(atlas.id).items.map((i) => i.id);
  let m = 0;
  ownerSays(w, kevin, 'redo them');
  for (;;) {
    const id = done[m % done.length]!;
    last = leadTurn(() => {
      act(w, kevin, id, { action: 'reopen' });
      return act(w, kevin, id, { action: 'assign', assigneeBotId: stuart.id });
    });
    if ('refused' in last) break;
    m++;
    stuartWorks();
  }
  assert.equal(m, TEAM_LIMITS.messagesPerTeamPerHour);
  assert.deepEqual([last.refused.status, last.refused.code], [429, 'limit']);
  assert.match(last.refused.message, /was not assigned to Stuart: team Atlas Kevin has sent 60 messages in the last hour, the limit/);
  w.store.db.close();
  w = fast(open(home, clock));
  ownerSays(w, kevin, 'and again');
  const hour = leadTurn(() => act(w, kevin, done[m % done.length]!, { action: 'assign', assigneeBotId: stuart.id }));
  assert.ok('refused' in hour && /in the last hour/.test(hour.refused.message), JSON.stringify(hour));

  // Another two hours: the day's budget (150) runs out, and the team pauses with one push.
  clock.now += 2 * HOUR;
  for (;;) {
    const id = done[m % done.length]!;
    last = leadTurn(() => {
      if (itemOf(w, id).status === 'done') act(w, kevin, id, { action: 'reopen' });
      return act(w, kevin, id, { action: 'assign', assigneeBotId: stuart.id });
    });
    if ('refused' in last) break;
    m++;
    stuartWorks();
  }
  assert.equal(requests(), 150);
  assert.match(last.refused.message, /has sent 150 messages today, its budget, so it is paused/);
  assert.deepEqual([w.teams.get(atlas.id).state, w.teams.get(atlas.id).pausedReason], ['paused', 'budget']);
  assert.equal(w.pushes.filter((p) => p.reason === 'team').length, 1);
  // Paused, nothing more is sent, and there is no second notice.
  ownerSays(w, kevin, 'once more');
  const paused = leadTurn(() => act(w, kevin, done[0]!, { action: 'assign', assigneeBotId: stuart.id }));
  assert.ok('refused' in paused && paused.refused.code === 'team_not_active', JSON.stringify(paused));
  assert.equal(w.pushes.filter((p) => p.reason === 'team').length, 1);
  assert.equal(requests(), 150);
});

test('past a lifetime bound, or with nothing on record to escalate on, an item is held for the owner; every live item always has its next look', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const start = w.clock.now;
  const capped = assigned(w, kevin, atlas.id, stuart, 'At the check-in bound');
  const bare = assigned(w, kevin, atlas.id, bob, 'Nothing on record');
  const plain = assigned(w, kevin, atlas.id, stuart, 'Plain stall');
  for (const b of [stuart, bob]) {
    const t = startTurn(w, b);
    for (const m of t.messages) if (m.meta?.itemId) act(w, b, m.meta.itemId, { action: 'start' });
    t.end('replied', 'on it');
  }
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  // One whose earlier assignments used up its check-ins (this one has nothing on record yet); one at the nudge cap
  // with nothing on record for its assignment.
  w.store.db.prepare('update team_items set total_checkins = ? where id = ?').run(TEAM_LIFETIME.checkins, capped.id);
  w.store.db.prepare("update team_items set nudges = ?, evidence = '[]' where id = ?").run(TEAM_LIMITS.maxNudges, bare.id);
  for (let m = 5; m <= 48 * 60; m += 5) {
    w.clock.now = start + m * MIN;
    w.teams.supervise();
    while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
    assert.equal(w.teams.get(atlas.id).state, 'active');
    for (const i of w.teams.detail(atlas.id).items.filter(live)) {
      assert.ok(i.nextCheckAt && Date.parse(i.nextCheckAt) > w.clock.now, `${i.title} at ${m}m: next look ${i.nextCheckAt}`);
    }
  }
  for (const id of [capped.id, bare.id]) {
    const d = w.teams.item(id);
    assert.equal(d.item.held, 'owner', d.item.title);
    assert.equal(d.events.filter((e) => e.kind === 'held').length, 1, 'one record');
    assert.equal(d.item.escalation, null, 'never escalated');
  }
  assert.ok(itemOf(w, plain.id).escalation, 'the plain stall went to the owner as before');
  assert.equal(w.teams.attention().count, 3);
});

test('the lead acts on an item it added with an assignee in the same turn', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  ownerSays(w, kevin, 'plan');
  const k = startTurn(w, kevin);
  const { item } = w.teams.addItem(atlas.id, { title: 'By mistake', assigneeBotId: stuart.id }, asLead(kevin));
  assert.deepEqual([item.gen, k.turn.scope!.get(item.id)], [1, 1]);
  assert.equal(act(w, kevin, item.id, { action: 'cancel', reason: 'added by mistake' }).item.status, 'cancelled');
  const second = w.teams.addItem(atlas.id, { title: 'Wrong person', assigneeBotId: stuart.id }, asLead(kevin)).item;
  assert.equal(act(w, kevin, second.id, { action: 'assign', assigneeBotId: kevin.id }).item.assigneeBotId, kevin.id);
  k.end('replied', 'fixed');
});

test("the owner's Stop work, and an assignment's turn stopped, start a new assignment: a turn that started before can't act on the item", () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  // The lead's turn for the owner started before the Stop, with the item in its scope.
  ownerSays(w, kevin, 'how is it going?');
  const k = startTurn(w, kevin);
  w.teams.setState(atlas.id, { state: 'paused', stop: true });
  const stopped = itemOf(w, item.id);
  assert.deepEqual([stopped.status, stopped.blockedNeed, stopped.gen], ['blocked', 'owner', 2]);
  assert.equal(refusal(() => act(w, kevin, item.id, { action: 'cancel', reason: 'x' })).code, 'changed');
  assert.equal(refusal(() => act(w, stuart, item.id, { action: 'progress', note: 'still going' })).code, 'replaced');
  k.end('quiet');
  s.end('stopped', '');
  assert.deepEqual([itemOf(w, item.id).status, itemOf(w, item.id).gen], ['blocked', 2]);

  // The owner stops the assignee's turn itself (or clears its chat): the same.
  w.teams.setState(atlas.id, { state: 'active' });
  ownerAct(w, item.id, { action: 'retry' });
  const s2 = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  ownerSays(w, kevin, 'and now?');
  const k2 = startTurn(w, kevin);
  s2.end('stopped', '');
  assert.deepEqual([itemOf(w, item.id).status, itemOf(w, item.id).gen], ['blocked', 4]);
  assert.equal(refusal(() => act(w, kevin, item.id, { action: 'cancel', reason: 'x' })).code, 'changed');
  k2.end('quiet');
});

test('a paused lead, or every Boton paused, holds its team for the tick: no state change, no push, and the work goes on after', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  s.end('replied', 'on it');
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  for (const pause of [() => w.store.setPausedAll(true), () => w.store.setBotPaused(kevin.id, true)]) {
    pause();
    w.clock.now += 2 * HOUR;
    const before = itemOf(w, item.id);
    assert.deepEqual(w.teams.supervise(), { checkins: 0, escalations: 0 });
    const t = w.teams.get(atlas.id);
    assert.deepEqual([t.state, t.pausedReason], ['active', null]);
    assert.equal(w.pushes.length, 0);
    assert.deepEqual([itemOf(w, item.id).nudges, itemOf(w, item.id).nextCheckAt], [before.nudges, before.nextCheckAt], 'still due');
    w.store.setPausedAll(false);
    w.store.setBotPaused(kevin.id, false);
    assert.equal(w.teams.supervise().checkins, 1, 'picked up at the next tick');
    while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  }
});

test('a request that is never delivered is answered: expired after a day, or taken back when its team finishes or is archived', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  // Expired: three asks fill Stuart's chat, so the assignment waits in the outbox for a day.
  ownerSays(w, kevin);
  const k = startTurn(w, kevin);
  for (const text of ['a', 'b', 'c']) w.teams.send(kevin.id, stuart.id, { text });
  k.end('replied', 'asked');
  const item = assigned(w, kevin, atlas.id, stuart);
  w.clock.now += 25 * HOUR;
  assert.equal(w.teams.expireDue(), 1);
  const told = w.store.listMessages(kevin.id).filter((m) => m.meta?.kind === 'ask.reply');
  assert.deepEqual(told.map((m) => m.text), ['(Stuart could not answer: the request waited a day without being delivered)']);
  assert.equal(told[0]!.meta?.itemId, item.id);
  const events = w.teams.item(item.id).events.map((e) => e.kind);
  assert.ok(events.includes('expired') && !events.includes('turn_failed'), events.join(', '));
  assert.deepEqual(itemOf(w, item.id).evidence.map((e) => e.kind), ['expired']);
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');

  // Taken back when the team finishes: Stuart's question to Bob had not started.
  const st = startTurn(w, stuart);
  w.teams.send(stuart.id, bob.id, { text: 'Which table?', team: atlas.id });
  st.end('quiet');
  ownerAct(w, item.id, { action: 'done', result: 'Done by hand' });
  ownerSays(w, kevin, 'wrap up');
  const k2 = startTurn(w, kevin);
  w.teams.finish(atlas.id, { summary: 'Shipped' }, kevin.id);
  k2.end('replied', 'finished');
  assert.equal(w.store.hasPendingChat(bob.id), false, 'not delivered');
  const toStuart = () => w.store.listMessages(stuart.id).filter((m) => m.meta?.kind === 'ask.reply').map((m) => m.text);
  assert.deepEqual(toStuart(), ['(Bob could not answer: team Atlas Kevin was finished before it was delivered)']);

  // Archived: the same.
  while (w.store.hasPendingChat(stuart.id)) startTurn(w, stuart).end('quiet');
  w.teams.setState(atlas.id, { state: 'active' });
  const st2 = startTurn(w, stuart);
  ownerSays(w, stuart, 'ask Bob again');
  const st3 = startTurn(w, stuart);
  w.teams.send(stuart.id, bob.id, { text: 'Which table, again?', team: atlas.id });
  st3.end('quiet');
  st2.end('quiet');
  w.teams.setState(atlas.id, { state: 'archived' });
  assert.equal(w.store.hasPendingChat(bob.id), false);
  assert.equal(toStuart().at(-1), '(Bob could not answer: team Atlas Kevin was archived before it was delivered)');
});

test('pruning never takes an event of the last day, which the daily budgets count', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const insert = w.store.db.prepare("insert into team_events (team_id, item_id, gen, kind, actor_kind, actor_name, detail, at) values (?, ?, ?, ?, 'server', 'Botons', '', ?)");
  const iso = (ms: number) => new Date(ms).toISOString();
  // The lead's check-ins of the last hours, past the team's retention; an older assignment's escalations too.
  w.store.atomically(() => {
    for (let i = 0; i < TEAM_LIMITS.eventsPerTeam + 100; i++) insert.run(atlas.id, null, null, 'checkin', iso(w.clock.now - 1000 * i));
    for (let i = 0; i < TEAM_LIMITS.eventsPerItem + 50; i++) insert.run(atlas.id, item.id, 0, 'escalated', iso(w.clock.now - 1000 * i));
  });
  const count = (kind: string) => Number((w.store.db.prepare('select count(*) as n from team_events where team_id = ? and kind = ? and at > ?').get(atlas.id, kind, iso(w.clock.now - 24 * HOUR)) as { n: number }).n);
  assert.equal(w.teams.pruneEvents(), 0);
  assert.deepEqual([count('checkin'), count('escalated')], [TEAM_LIMITS.eventsPerTeam + 100, TEAM_LIMITS.eventsPerItem + 50]);
  // A day later they may go, down to the retention.
  w.clock.now += 25 * HOUR;
  assert.ok(w.teams.pruneEvents() > 0);
  const kept = Number((w.store.db.prepare('select count(*) as n from team_events where team_id = ?').get(atlas.id) as { n: number }).n);
  assert.ok(kept <= TEAM_LIMITS.eventsPerTeam + 5, `${kept}`);
});

test("what holds an item is this assignment's: an older approval or card, or a question to a paused teammate, holds nothing", () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  s.end('replied', 'on it');
  const genStart = Date.parse(w.teams.item(item.id).events.find((e) => e.kind === 'assigned')!.at);
  const iso = (ms: number) => new Date(ms).toISOString();
  const db = w.store.db;
  const turn = (id: string, at: number) =>
    db.prepare("insert into turns (id, bot_id, trigger, provider, started_at, outcome) values (?, ?, 'chat', 'mock', ?, 'ok')").run(id, stuart.id, iso(at));
  const approval = (id: string, turnId: string) =>
    db.prepare("insert into approvals (id, bot_id, kind, title, status, trigger, turn_id, created_at) values (?, ?, 'action', 'Push', 'pending', 'chat', ?, ?)").run(id, stuart.id, turnId, iso(genStart));
  const card = (at: number) => {
    const m = w.store.addMessage(stuart.id, 'event', 'Posted a card', {
      kind: 'card.posted',
      card: { descriptor: { v: 1, title: 'Pick one', blocks: [] } as never, status: 'pending', expiresAt: iso(w.clock.now + 7 * 24 * HOUR), from: { trigger: 'chat', routineId: null, routineName: null, runId: null, sandboxed: false } },
    });
    db.prepare('update messages set created_at = ? where id = ?').run(iso(at), m.id);
    return m.id;
  };
  const waiting = () => itemOf(w, item.id).waiting;
  turn('turn_old', genStart - HOUR);
  approval('apr_old', 'turn_old');
  card(genStart - HOUR);
  assert.equal(waiting(), null, 'from before this assignment');
  turn('turn_new', genStart + MIN);
  approval('apr_new', 'turn_new');
  assert.equal(waiting(), 'approval');
  db.prepare("update approvals set status = 'allowed' where id = 'apr_new'").run();
  assert.equal(waiting(), null);
  const cardId = card(genStart + 2 * MIN);
  assert.equal(waiting(), 'approval');
  db.prepare("update messages set meta = json_set(meta, '$.card.status', 'answered') where id = ?").run(cardId);
  assert.equal(waiting(), null);

  // Its browser handed to the owner: asked and not expired, or taken; not one from before, expired, handed back or closed.
  const handoff = (at: number, state: string, expiresAt: number) => {
    const m = w.store.addMessage(stuart.id, 'event', 'Asked you to take over the browser', {
      kind: 'browser.handoff',
      browserHandoff: { state, reason: 'Sign in', url: 'https://example.com/login', requestedAt: iso(at), expiresAt: iso(expiresAt) },
    } as MessageMeta);
    db.prepare('update messages set created_at = ? where id = ?').run(iso(at), m.id);
    return m.id;
  };
  const setState = (id: string, state: string) => db.prepare("update messages set meta = json_set(meta, '$.browserHandoff.state', ?) where id = ?").run(state, id);
  handoff(genStart - HOUR, 'requested', w.clock.now + 6 * HOUR);
  assert.equal(waiting(), null, 'a handoff from before this assignment');
  const expired = handoff(genStart + 3 * MIN, 'requested', w.clock.now - MIN);
  assert.equal(waiting(), null, 'an expired request');
  const asked = handoff(genStart + 4 * MIN, 'requested', w.clock.now + 6 * HOUR);
  assert.equal(waiting(), 'approval', 'asked and waiting');
  setState(asked, 'taken');
  assert.equal(waiting(), 'approval', 'taken over by the owner');
  setState(asked, 'handed-back');
  assert.equal(waiting(), null, 'handed back');
  setState(expired, 'closed');
  assert.equal(waiting(), null, 'closed');

  // A question to Bob about it holds it, until Bob is paused.
  ownerSays(w, stuart, 'ask Bob');
  const s2 = startTurn(w, stuart);
  w.teams.send(stuart.id, bob.id, { text: 'Which table?', team: atlas.id, item: item.id });
  s2.end('quiet');
  assert.equal(waiting(), 'teammate');
  w.store.setBotPaused(bob.id, true);
  assert.equal(waiting(), null);
});

test('the context block: a seat at its longest keeps its team, state, role and lead whole, and clips only what was written', () => {
  const w = open();
  const lead = w.store.createBot({ name: `L${'e'.repeat(59)}`, provider: 'mock' }, new Set(['mock']), 'mock');
  const kevin = bot(w, 'Kevin');
  const atlas = w.teams.create({
    name: `A${'t'.repeat(59)}`,
    goal: 'g',
    members: [
      { botId: lead.id, role: 'lead' },
      { botId: kevin.id, role: 'member', roleTitle: `R${'o'.repeat(59)}`, responsibilities: 'x'.repeat(600) },
    ],
  });
  w.teams.setState(atlas.id, { state: 'paused' });
  const head = w.teams.contextFor(kevin.id, 'NONCE')![0]!;
  assert.ok(head.length <= TEAM_CONTEXT.critical, `${head.length}`);
  assert.ok(head.startsWith(`- A${'t'.repeat(59)} (${atlas.id}, paused (nothing is sent in it until it resumes)): you are a member. Lead: L${'e'.repeat(59)} (${lead.id}). Your role: <team_text id="NONCE">“R${'o'.repeat(59)}”: xxx`), head);
  assert.ok(head.endsWith('x…</team_text>.'), head);
});

test("the reply of the attempt that finished its item is current; an older attempt's, or other work's, stays stale and moves nothing", () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const replyOf = (text: string) => w.store.listMessages(kevin.id).find((m) => m.meta?.kind === 'ask.reply' && m.text === text)!;
  const threadReply = (itemId: string, text: string) => w.teams.messagesOf(itemOf(w, itemId).threadId!).find((m) => m.kind === 'reply' && m.text === text)!;

  // Start, done, reply: the current assignment's answer, and the lead hears the item is done.
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  act(w, stuart, item.id, { action: 'done', result: 'Mapped and tested' });
  s.end('replied', 'Done: mapped and tested.');
  const reply = replyOf('Done: mapped and tested.');
  assert.deepEqual([reply.meta?.stale, reply.meta?.silent, reply.meta?.itemStatus, reply.meta?.itemGen], [undefined, undefined, 'done', 1]);
  assert.equal(threadReply(item.id, 'Done: mapped and tested.').stale, false);
  assert.ok(!w.teams.item(item.id).events.some((e) => e.kind === 'silent_end'));
  assert.match(chatInputOf(reply), /item_\w+ is done now\./);

  // A to B and back to A while A's first attempt runs: its late reply is stale and moves nothing.
  const back = assigned(w, kevin, atlas.id, stuart, 'There and back');
  const first = startTurn(w, stuart);
  ownerAct(w, back.id, { action: 'assign', assigneeBotId: bob.id });
  ownerAct(w, back.id, { action: 'assign', assigneeBotId: stuart.id });
  first.end('replied', 'first attempt, late');
  assert.equal(replyOf('first attempt, late').meta?.stale, true);
  assert.deepEqual([itemOf(w, back.id).status, itemOf(w, back.id).gen], ['open', 3]);
  // Given to Bob, who finishes it, while A's attempt runs: A's late reply did not finish it.
  const away = assigned(w, kevin, atlas.id, stuart, 'Away');
  const slow = startTurn(w, stuart);
  ownerAct(w, away.id, { action: 'assign', assigneeBotId: bob.id });
  const b1 = startTurn(w, bob);
  act(w, bob, away.id, { action: 'done', result: 'Bob did it' });
  b1.end('replied', 'bob finished');
  slow.end('replied', 'stuart, late');
  assert.equal(replyOf('stuart, late').meta?.stale, true);
  assert.equal(replyOf('bob finished').meta?.stale, undefined);
  // Marked done by the owner (the gen just after the attempt's): not this attempt's doing either.
  const byOwner = assigned(w, kevin, atlas.id, stuart, 'By the owner');
  const working = startTurn(w, stuart);
  act(w, stuart, byOwner.id, { action: 'start' });
  ownerAct(w, byOwner.id, { action: 'done', result: 'Done by Sam' });
  working.end('replied', 'still working on it');
  assert.equal(replyOf('still working on it').meta?.stale, true);
  assert.deepEqual([itemOf(w, byOwner.id).result, itemOf(w, byOwner.id).gen], ['Done by Sam', 2]);

  // Cancelled and reopened while the first attempt runs: stale, and nothing moves.
  const again = assigned(w, kevin, atlas.id, stuart, 'Cancel and reopen');
  const late = startTurn(w, stuart);
  ownerAct(w, again.id, { action: 'cancel', reason: 'later' });
  ownerAct(w, again.id, { action: 'reopen' });
  late.end('replied', 'late after reopen');
  assert.equal(replyOf('late after reopen').meta?.stale, true);
  assert.deepEqual([itemOf(w, again.id).status, itemOf(w, again.id).gen, itemOf(w, again.id).assigneeBotId], ['open', 3, null]);

});

test('a re-run after a restart that repeats its done is the same work: its reply is current once; another process is not', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  act(w, stuart, item.id, { action: 'done', result: 'Mapped' });
  // The process dies before the turn ends: a new one re-runs the same chat message.
  w.turns.clear();
  const w2 = open(w.home, w.clock);
  const rerun = startTurn(w2, stuart);
  assert.deepEqual(rerun.messages.map((m) => m.id), s.messages.map((m) => m.id), 'the same work');
  assert.equal(act(w2, stuart, item.id, { action: 'done', result: 'Mapped' }).duplicate, true);
  rerun.end('replied', 'Done after the restart');
  const replies = w2.store.listMessages(kevin.id).filter((m) => m.meta?.kind === 'ask.reply');
  assert.deepEqual(replies.map((m) => [m.text, m.meta?.stale]), [['Done after the restart', undefined]]);
  assert.equal(w2.teams.messagesOf(itemOf(w2, item.id).threadId!).filter((m) => m.kind === 'reply').length, 1);
  assert.equal(w2.teams.item(item.id).events.filter((e) => e.kind === 'done').length, 1, 'done once');

  // The done came from other work (a routine run of Stuart's, say) while this request was in flight: the reply that
  // answers the request did not finish the item, so it is not taken as the assignment's answer.
  const other = assigned(w2, kevin, atlas.id, stuart, 'Done elsewhere');
  const t = startTurn(w2, stuart);
  w2.turns.set(stuart.id, { ...t.turn, origin: 'run:run_other' });
  act(w2, stuart, other.id, { action: 'done', result: 'Done in a run' });
  w2.turns.set(stuart.id, t.turn);
  t.end('replied', 'answering the assignment');
  const late = w2.store.listMessages(kevin.id).find((m) => m.meta?.kind === 'ask.reply' && m.text === 'answering the assignment')!;
  assert.equal(late.meta?.stale, true);
  assert.deepEqual([itemOf(w2, other.id).status, itemOf(w2, other.id).result], ['done', 'Done in a run']);
});

test("a conversation's row follows its newest delivery live: delivered, the team paused and resumed, its recipient paused and resumed", () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  ownerSays(w, kevin, 'ask Stuart four things');
  const k = startTurn(w, kevin);
  const asks = ['a', 'b', 'c', 'd'].map((text) => w.teams.send(kevin.id, stuart.id, { text, team: atlas.id }));
  k.end('replied', 'asked');
  const last = asks[3]!.threadId;
  /** The rows of thread `id` published since the last look. */
  const rows = (id: string) => {
    const out = w.events.flatMap((e) => (e.type === 'team.thread.upserted' && e.thread.id === id ? [e.thread.lastDelivery] : []));
    w.events.length = 0;
    return out.map((d) => (d ? `${d.state}:${d.waitingOn ?? ''}` : 'none'));
  };
  rows(last);
  w.teams.setState(atlas.id, { state: 'paused' });
  assert.ok(rows(last).includes('queued:team_paused'));
  w.teams.setState(atlas.id, { state: 'active' });
  assert.ok(rows(last).includes('queued:backlog'));
  // Its recipient paused and resumed (the engine's pause republishes them so).
  w.store.setBotPaused(stuart.id, true);
  w.teams.publishOpen({ botId: stuart.id });
  assert.ok(rows(last).includes('queued:paused'));
  w.store.setBotPaused(stuart.id, false);
  w.teams.publishOpen({ botId: stuart.id });
  assert.ok(rows(last).includes('queued:backlog'));
  // Only its delivery changes when a slot in Stuart's chat frees: the row says delivered.
  startTurn(w, stuart).end('replied', 'answers');
  assert.ok(rows(last).includes('dispatched:'), 'delivered');
});

test('the owner adds, assigns, retries and reopens only in a team that can deliver: an archived one is restored first, a finished one reopened', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  const spare = w.teams.addItem(atlas.id, { title: 'Spare' }, { owner: true, by: null }).item;
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'done', result: 'ok' });
  s.end('replied', 'done');
  ownerAct(w, spare.id, { action: 'cancel', reason: 'not needed' });
  ownerSays(w, kevin, 'wrap up');
  const k = startTurn(w, kevin);
  w.teams.finish(atlas.id, { summary: 'Shipped', scope: 'n/a' }, kevin.id);
  k.end('replied', 'done');
  const owner = { owner: true as const, by: null };
  for (const [state, words] of [['done', /is finished: reopen the team first/], ['archived', /is archived: restore the team first/]] as const) {
    if (state === 'archived') w.teams.setState(atlas.id, { state: 'archived' });
    for (const r of [
      refusal(() => w.teams.addItem(atlas.id, { title: 'More', assigneeBotId: stuart.id }, owner)),
      refusal(() => ownerAct(w, item.id, { action: 'reopen' })),
      refusal(() => ownerAct(w, spare.id, { action: 'reopen' })),
    ]) {
      assert.deepEqual([r.status, r.code], [409, 'team_not_active'], state);
      assert.match(r.message, words);
    }
  }
  assert.equal(w.teams.messagesOf(itemOf(w, item.id).threadId!).filter((m) => m.kind === 'request').length, 1, 'nothing sent');
  w.teams.setState(atlas.id, { state: 'active' });
  assert.equal(ownerAct(w, item.id, { action: 'reopen' }).item.status, 'open');
  assert.equal(ownerAct(w, item.id, { action: 'assign', assigneeBotId: stuart.id }).item.gen, 4);
});

test('a new lead gets the check-ins and the escalations: nothing stays with the old one, and a lead at its usage limit counts no nudge', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const roster = (lead: Bot, ...others: Bot[]) =>
    w.teams.setMembers(atlas.id, { members: [{ botId: lead.id, role: 'lead' }, ...others.map((b) => ({ botId: b.id, role: 'member' }))] });
  assert.equal(w.teams.supervise().checkins, 1, 'the kickoff, in Kevin’s chat');
  const kickoff = pendingOf(w, kevin)[0]!;
  // Stuart leads now and Kevin leaves: the check-in that had not started leaves Kevin's chat.
  roster(stuart, bob);
  assert.deepEqual([pendingFlag(w, kickoff.id), w.store.findMessage(kickoff.id)!.meta?.quiet], [0, true]);
  assert.match(w.teams.checkinPrompt(kickoff, 'Sam', 'N'), /which you no longer lead\. Nothing needs you now: answer \[quiet\]/);

  // Bob's item stalls: Stuart hears of it each time, and the server's escalation is Stuart's.
  const item = w.teams.addItem(atlas.id, { title: 'Stalls', assigneeBotId: bob.id }, { owner: true, by: null }).item;
  const b = startTurn(w, bob);
  act(w, bob, item.id, { action: 'start' });
  b.end('replied', 'on it');
  const start = w.clock.now;
  const told: string[] = [];
  for (let m = 5; m <= 8 * 60; m += 5) {
    w.clock.now = start + m * MIN;
    w.teams.supervise();
    while (w.store.hasPendingChat(stuart.id)) {
      const t = startTurn(w, stuart);
      for (const c of t.messages) if (c.meta?.kind === 'team.checkin' && /Stalls|No movement/.test(w.teams.checkinPrompt(c, 'Sam', 'N'))) told.push(c.id);
      t.end('quiet');
    }
  }
  assert.equal(new Set(told).size, TEAM_LIMITS.maxNudges, 'each check-in about it went to Stuart');
  assert.equal(pendingOf(w, kevin).length, 0, 'Kevin, with no seat, got nothing');
  const escalated = itemOf(w, item.id);
  assert.equal(escalated.escalation?.botId, stuart.id);
  assert.match(escalated.escalation!.summary, /after 3 check-ins with Stuart/);
  const first = escalated.escalation!.cardMessageId;
  assert.equal(w.store.findMessage(first)!.botId, stuart.id);

  // Kevin leads again: the open escalation's card moves to Kevin, and the owner's answer there is the one that counts.
  roster(kevin, stuart, bob);
  const moved = itemOf(w, item.id).escalation!;
  assert.equal(moved.botId, kevin.id);
  assert.equal(w.store.findMessage(first)!.meta?.card?.status, 'expired');
  const card = w.store.findMessage(moved.cardMessageId)!;
  assert.deepEqual([card.botId, card.meta?.card?.status, card.meta?.card?.descriptor.title], [kevin.id, 'pending', 'Blocked: Stalls']);
  assert.equal(itemOf(w, item.id).lifetime.escalations, 1, 'the same escalation, not a new one');
  w.teams.ownerAnswered(stuart.id, first, null);
  assert.ok(itemOf(w, item.id).escalation, 'the old card answers nothing');
  w.teams.ownerAnswered(kevin.id, moved.cardMessageId, null);
  assert.equal(itemOf(w, item.id).escalation, null);

  // Kevin's provider is at its usage limit: the team waits, and no check-in it can't run is counted.
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  w.teams.host.usageLimitUntil = () => new Date(w.clock.now + 10 * HOUR).toISOString();
  w.clock.now += 2 * HOUR;
  assert.deepEqual(w.teams.supervise(), { checkins: 0, escalations: 0 });
  assert.deepEqual([itemOf(w, item.id).nudges, pendingOf(w, kevin).length], [0, 0]);
  w.teams.host.usageLimitUntil = () => null;
  assert.equal(w.teams.supervise().checkins, 1);
  assert.equal(itemOf(w, item.id).nudges, 1);
});

test("Stop work fences every live item and answers whoever asked what had not started", () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  const blocked = assigned(w, kevin, atlas.id, bob, 'Blocked one');
  const b = startTurn(w, bob);
  act(w, bob, blocked.id, { action: 'block', reason: 'needs a key', need: 'lead' });
  b.end('replied', 'blocked');
  const loose = w.teams.addItem(atlas.id, { title: 'Not assigned' }, { owner: true, by: null }).item;
  // Four asks to Stuart: three in its chat (not started), one queued.
  ownerSays(w, kevin, 'ask Stuart');
  const k = startTurn(w, kevin);
  for (const text of ['a', 'b', 'c', 'd']) w.teams.send(kevin.id, stuart.id, { text, team: atlas.id });
  k.end('replied', 'asked');
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  // The lead's turn for the owner started before the Stop.
  ownerSays(w, kevin, 'what now?');
  const lead = startTurn(w, kevin);
  const wokenBefore = w.woken.length;
  w.teams.setState(atlas.id, { state: 'paused', stop: true });
  for (const [it, status] of [[blocked, 'blocked'], [loose, 'open']] as const) {
    const now = itemOf(w, it.id);
    assert.deepEqual([now.status, now.gen], [status, it.gen + 1], it.title);
  }
  assert.equal(refusal(() => act(w, kevin, blocked.id, { action: 'cancel', reason: 'x' })).code, 'changed');
  assert.equal(refusal(() => act(w, kevin, loose.id, { action: 'cancel', reason: 'x' })).code, 'changed');
  lead.end('quiet');
  assert.equal(w.store.hasPendingChat(stuart.id), false, 'taken back');
  const answers = w.store.listMessages(kevin.id).filter((m) => m.meta?.kind === 'ask.reply').map((m) => m.text);
  assert.equal(answers.filter((t) => t === '(Stuart could not answer: team Atlas Kevin was stopped before it was delivered)').length, 4, answers.join(' | '));
  // On record, but a stopped team wakes no one: none of them is waiting for a turn of the lead's.
  assert.equal(w.store.hasPendingChat(kevin.id), false, 'no new lead turn after Stop work');
  w.teams.supervise();
  assert.ok(!w.woken.slice(wokenBefore).includes(kevin.id), 'Stop work (and the next look) wakes no lead turn');
});

test('a held item still takes its assignee’s own result, and the lead’s cancel', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  const item = assigned(w, kevin, atlas.id, stuart);
  w.store.db.prepare("update team_items set held = 'owner' where id = ?").run(item.id);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  assert.equal(act(w, stuart, item.id, { action: 'done', result: 'Finished anyway' }).item.result, 'Finished anyway');
  s.end('replied', 'done');
  ownerSays(w, kevin, 'reopen it');
  const k = startTurn(w, kevin);
  w.store.db.prepare("update team_items set held = 'owner' where id = ?").run(item.id);
  assert.equal(refusal(() => act(w, kevin, item.id, { action: 'reopen' })).code, 'limit');
  k.end('quiet');
});

test('when the escalation budget pauses the team, the same tick sends no check-in', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const stuck = assigned(w, kevin, atlas.id, stuart, 'Stuck');
  const other = assigned(w, kevin, atlas.id, stuart, 'Other');
  const s = startTurn(w, stuart);
  act(w, stuart, stuck.id, { action: 'start' });
  act(w, stuart, other.id, { action: 'block', reason: 'needs a key', need: 'lead' });
  s.end('replied', 'one going, one blocked');
  while (w.store.hasPendingChat(kevin.id)) startTurn(w, kevin).end('quiet');
  // Five escalations today already; the stuck one is due for the server's own; the block is new for the lead.
  const insert = w.store.db.prepare("insert into team_events (team_id, item_id, gen, kind, actor_kind, actor_name, detail, at) values (?, null, null, 'escalated', 'server', 'Botons', '', ?)");
  for (let i = 0; i < TEAM_LIMITS.escalationsPerTeamPerDay; i++) insert.run(atlas.id, new Date(w.clock.now - i * MIN).toISOString());
  w.store.db
    .prepare("update team_items set nudges = ?, next_check_at = ?, last_activity_at = ?, evidence = json_array(json_object('kind', 'checkin', 'gen', gen, 'detail', 'ended quiet', 'at', ?)) where id = ?")
    .run(TEAM_LIMITS.maxNudges, new Date(w.clock.now).toISOString(), new Date(w.clock.now - 2 * HOUR).toISOString(), new Date(w.clock.now).toISOString(), stuck.id);
  w.store.db.prepare("update team_events set told_at = null, origin_key = null where item_id = ? and kind = 'blocked'").run(other.id);
  w.clock.now += MIN;
  const before = pendingOf(w, kevin).length;
  assert.deepEqual(w.teams.supervise(), { checkins: 0, escalations: 0 });
  assert.deepEqual([w.teams.get(atlas.id).state, w.teams.get(atlas.id).pausedReason], ['paused', 'budget']);
  assert.equal(pendingOf(w, kevin).filter((m) => m.meta?.kind === 'team.checkin').length, 0, 'no check-in after the pause');
  assert.equal(pendingOf(w, kevin).length, before);
});

test('resuming after a daily budget ran out starts a fresh day, and paused time counts toward no item’s age', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  w.teams.update(atlas.id, { limits: { messagesPerDay: 20 } });
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  s.end('replied', 'on it');
  const genStart = () => String((w.store.db.prepare('select gen_started_at from team_items where id = ?').get(item.id) as { gen_started_at: string }).gen_started_at);
  const startedAt = Date.parse(genStart());
  ownerSays(w, kevin, 'ask a lot');
  const k = startTurn(w, kevin);
  for (let i = 0; i < 19; i++) {
    w.clock.now += 4 * MIN;
    w.teams.send(kevin.id, stuart.id, { text: `q${i}`, team: atlas.id, key: `q${i}` });
    while (w.store.hasPendingChat(stuart.id)) startTurn(w, stuart).end('quiet');
  }
  assert.equal(refusal(() => w.teams.send(kevin.id, stuart.id, { text: 'one more', team: atlas.id })).code, 'limit');
  k.end('replied', 'asked');
  assert.equal(w.teams.get(atlas.id).pausedReason, 'budget');
  w.clock.now += 5 * HOUR;
  w.teams.setState(atlas.id, { state: 'active' });
  // The day starts at the resume: the next ask goes, and the team stays active.
  ownerSays(w, kevin, 'one more');
  const k2 = startTurn(w, kevin);
  assert.equal(w.teams.send(kevin.id, stuart.id, { text: 'after the resume', team: atlas.id }).duplicate, false);
  k2.end('replied', 'asked');
  assert.equal(w.teams.get(atlas.id).state, 'active');
  // Stuart's working item: its assignment's age moved on by the 5 hours the team was paused.
  assert.equal(Date.parse(genStart()), startedAt + 5 * HOUR);
});

test('two requests from one asker answered in one turn each get their reply in their thread; the asker one message', () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  ownerSays(w, kevin, 'ask twice');
  const k = startTurn(w, kevin);
  const one = w.teams.send(kevin.id, stuart.id, { text: 'first question' });
  const two = w.teams.send(kevin.id, stuart.id, { text: 'second question' });
  k.end('replied', 'asked');
  assert.notEqual(one.threadId, two.threadId);
  const s = startTurn(w, stuart);
  assert.equal(s.messages.length, 2);
  s.end('replied', 'both answered');
  for (const a of [one, two]) {
    const replies = w.teams.messagesOf(a.threadId).filter((m) => m.kind === 'reply');
    assert.deepEqual(replies.map((m) => [m.text, m.inReplyTo]), [['both answered', a.teamMessageId]]);
  }
  assert.equal(w.store.listMessages(kevin.id).filter((m) => m.meta?.kind === 'ask.reply').length, 1);
});

test("a lead change during the old lead's check-in turn hands what it was told to the new lead", () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const item = w.teams.addItem(atlas.id, { title: 'Needs a key', assigneeBotId: bob.id }, { owner: true, by: null }).item;
  const b = startTurn(w, bob);
  act(w, bob, item.id, { action: 'block', reason: 'No key', need: 'lead' });
  b.end('replied', 'blocked');
  w.teams.supervise();
  // Kevin's check-in about the block is under way when the owner makes Stuart the lead.
  const k = startTurn(w, kevin);
  assert.ok(k.messages.some((m) => m.meta?.kind === 'team.checkin'));
  w.teams.setMembers(atlas.id, { members: [{ botId: stuart.id, role: 'lead' }, { botId: kevin.id, role: 'member' }, { botId: bob.id, role: 'member' }] });
  k.end('quiet');
  w.teams.supervise();
  const next = pendingOf(w, stuart).find((m) => m.meta?.kind === 'team.checkin');
  assert.ok(next, 'Stuart gets a check-in');
  assert.match(w.teams.checkinPrompt(next!, 'Sam', 'N'), new RegExp(item.id), 'about the block Kevin was told of');
});

test("what comes in during a lead's check-in turn is the next check-in's: its end neither tells it nor counts it", () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const one = w.teams.addItem(atlas.id, { title: 'One', assigneeBotId: stuart.id }, { owner: true, by: null }).item;
  const s = startTurn(w, stuart);
  act(w, stuart, one.id, { action: 'block', reason: 'No access', need: 'lead' });
  s.end('replied', 'blocked');
  w.teams.supervise();
  const k = startTurn(w, kevin);
  // During Kevin's check-in about One, Bob blocks Two.
  const two = w.teams.addItem(atlas.id, { title: 'Two', assigneeBotId: bob.id }, { owner: true, by: null }).item;
  const b = startTurn(w, bob);
  act(w, bob, two.id, { action: 'block', reason: 'No key', need: 'lead' });
  b.end('replied', 'blocked');
  w.teams.supervise();
  k.end('quiet');
  assert.ok(!itemOf(w, two.id).evidence.some((e) => /check-in turn ended quiet/.test(e.detail)), 'no false evidence against Two');
  const next = pendingOf(w, kevin).find((m) => m.meta?.kind === 'team.checkin');
  assert.ok(next, 'a check-in waits for Two');
  assert.match(w.teams.checkinPrompt(next!, 'Sam', 'N'), new RegExp(two.id));
});

test('a check-in given up on after restarts is known as built: what came in during it still waits for the next one', () => {
  const w = open();
  const [kevin, stuart, bob] = [bot(w, 'Kevin'), bot(w, 'Stuart'), bot(w, 'Bob')];
  const atlas = team(w, kevin, stuart, bob);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const one = w.teams.addItem(atlas.id, { title: 'One', assigneeBotId: stuart.id }, { owner: true, by: null }).item;
  const s = startTurn(w, stuart);
  act(w, stuart, one.id, { action: 'block', reason: 'No access', need: 'lead' });
  s.end('replied', 'blocked');
  w.teams.supervise();
  const k = startTurn(w, kevin);
  const two = w.teams.addItem(atlas.id, { title: 'Two', assigneeBotId: bob.id }, { owner: true, by: null }).item;
  const b = startTurn(w, bob);
  act(w, bob, two.id, { action: 'block', reason: 'No key', need: 'lead' });
  b.end('replied', 'blocked');
  // The server dies during Kevin's check-in turn; it was cut off at every start, and the next one gives up on it.
  const checkin = k.messages.find((m) => m.meta?.kind === 'team.checkin')!;
  w.store.db.prepare('update messages set cut_off = 3 where id = ?').run(checkin.id);
  const after = open(w.home, w.clock);
  const kevinNow = after.store.getBot(kevin.id);
  after.store.atomically(() => {
    after.store.markProcessed(k.messages.map((m) => m.id));
    after.teams.replied(kevinNow, k.messages, '(Kevin could not answer)', 'failed', null);
  });
  assert.ok(!itemOf(after, two.id).evidence.some((e) => /check-in turn failed/.test(e.detail)), 'no false evidence against Two');
  after.teams.supervise();
  const next = pendingOf(after, kevin).find((m) => m.meta?.kind === 'team.checkin');
  assert.ok(next, 'a check-in waits for Two');
  assert.match(after.teams.checkinPrompt(next!, 'Sam', 'N'), new RegExp(two.id));
});

test("an assignee whose browser waits on the owner is held, not stalled; handed back, the stall clock counts again", () => {
  const w = open();
  const [kevin, stuart] = [bot(w, 'Kevin'), bot(w, 'Stuart')];
  const atlas = team(w, kevin, stuart);
  w.teams.supervise();
  startTurn(w, kevin).end('quiet');
  const item = assigned(w, kevin, atlas.id, stuart);
  const s = startTurn(w, stuart);
  act(w, stuart, item.id, { action: 'start' });
  // Stuart asks the owner to take its browser over (to sign in), then ends its turn.
  const handoff = w.store.addMessage(stuart.id, 'event', 'Asked you to take over the browser', {
    kind: 'browser.handoff',
    browserHandoff: { state: 'requested', reason: 'Sign in', url: 'https://example.com/login', requestedAt: new Date(w.clock.now).toISOString(), expiresAt: new Date(w.clock.now + 6 * 60 * MIN).toISOString() },
  } as MessageMeta);
  // On the test's clock, not the machine's.
  w.store.db.prepare('update messages set created_at = ? where id = ?').run(new Date(w.clock.now).toISOString(), handoff.id);
  s.end('replied', 'waiting for Sam to sign in');
  w.clock.now += 3 * 60 * MIN;
  assert.equal(w.teams.supervise().checkins, 0, 'waiting on the owner holds');
  w.store.db.prepare("update messages set meta = json_set(meta, '$.browserHandoff.state', 'handed-back') where id = ?").run(handoff.id);
  w.clock.now += 40 * MIN;
  assert.equal(w.teams.supervise().checkins, 1, 'handed back: a stall is a stall again');
});
