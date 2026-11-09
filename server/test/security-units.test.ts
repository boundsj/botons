// In process, for `npm test`: an approval bound to one exact call (and the `botons mcp` bridge that waits on it), a chat
// turn's input and replay kept to one audience, webhook runs' sessions and the chat they see, and signed webhooks
// checked before their bodies are parsed. The end-to-end versions, on a server, are in security-binding.test.ts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApprovalOrigin, MessageMeta, Routine, ToolCallVerdict } from '../../shared/types.ts';
import { Approvals } from '../src/approvals.ts';
import { callKey } from '../src/ask-rules.ts';
import { loadConfig } from '../src/config.ts';
import { runSession } from '../src/engine.ts';
import { EventHub } from '../src/events.ts';
import { routinePrompt, sessionStart } from '../src/prompt.ts';
import { WEBHOOK_HISTORY_BUDGET, WEBHOOK_HISTORY_MAX } from '../src/replay.ts';
import { HttpError, type RunRecord, Store } from '../src/store.ts';
import * as webhooks from '../src/webhooks.ts';
import { tempDir } from './helpers.ts';

const open = () => {
  const hub = new EventHub();
  const store = new Store(loadConfig({ BOTONS_HOME: tempDir('botons-security-units-'), BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1' }), hub, () => ({ state: 'idle', activity: null, since: null }));
  return { store, hub };
};

const running = (turnId: string): ApprovalOrigin => ({ trigger: 'chat', turnId, routineId: null, routineName: null, runId: null, sandboxed: false, askedBy: [] });

/** A store and its approvals, with a Boton whose Ask first rule covers mcp__fixture, and the turn it is running (or none). */
function approvalsFixture(waitMs = 60_000) {
  const { store, hub } = open();
  const created = store.createBot({ name: 'Kevin', provider: 'mock', access: 'host' }, new Set(['mock']), 'mock');
  const bot = store.updateBot(created.id, { askFirst: ['mcp__fixture'] }, new Set(['mock']));
  assert.deepEqual(bot.askFirst, ['mcp__fixture']);
  const at: { origin: ApprovalOrigin | null } = { origin: running('turn_1') };
  const approvals = new Approvals({ store, hub, notifier: { push: async () => [] } as never, wake: () => {}, origin: () => at.origin, access: () => null, waitMs });
  return { store, approvals, bot, at };
}

test('Allow once answers exactly one waiting call: an identical call at the same moment has a card and a wait of its own', () => {
  const { approvals, bot } = approvalsFixture();
  const input = { item_id: 'dummy-1', description: 'A' };
  const one = approvals.toolCall(bot.id, { toolName: 'mcp__fixture__create_item', input, toolUseId: 'toolu_1' }, { sandboxed: false });
  const two = approvals.toolCall(bot.id, { toolName: 'mcp__fixture__create_item', input, toolUseId: 'toolu_2' }, { sandboxed: false });
  assert.deepEqual([one.behavior, two.behavior], ['wait', 'wait']);
  assert.ok(one.waiter && two.waiter && one.waiter !== two.waiter);
  assert.notEqual(one.approval!.id, two.approval!.id, 'two calls, two cards');

  assert.equal(approvals.decide(one.approval!.id, { decision: 'allow' }, null).tool!.inTurn, true);
  assert.equal(approvals.toolVerdict(one.approval!.id, one.waiter!).behavior, 'allow');
  assert.equal(approvals.toolVerdict(one.approval!.id, one.waiter!).behavior, 'allow', 'the same call asking again hears the same answer');
  assert.ok(approvals.get(one.approval!.id).tool!.usedAt, 'spent as it was handed out');
  assert.equal(approvals.toolVerdict(two.approval!.id, two.waiter!).behavior, 'wait', 'the other call waits for its own card');
  // Nothing else gets that allow: not the other call's waiter, nor a poll that names none.
  assert.equal(approvals.toolVerdict(one.approval!.id, two.waiter!).behavior, 'deny');
  assert.equal(approvals.toolVerdict(one.approval!.id, null).behavior, 'deny');
});

test('a call takes over a card only once nothing waits on it, and the call it replaced then hears no allow', () => {
  const { approvals, bot, at } = approvalsFixture();
  at.origin = null; // No turn runs, so the first call's wait can't be answered in a turn.
  const input = { item_id: 'dummy-2' };
  const first = approvals.toolCall(bot.id, { toolName: 'mcp__fixture__create_item', input }, { sandboxed: false });
  const second = approvals.toolCall(bot.id, { toolName: 'mcp__fixture__create_item', input }, { sandboxed: false });
  assert.equal(second.approval!.id, first.approval!.id);
  assert.notEqual(second.waiter, first.waiter);
  assert.equal(approvals.toolVerdict(first.approval!.id, first.waiter!).behavior, 'deny');
});

test("an allow given after a call stopped waiting is for exactly that call (an MCP description included), and is spent once", () => {
  const { approvals, bot, at } = approvalsFixture();
  at.origin = null;
  const a = { item_id: 'dummy-3', description: 'A' };
  const call = (input: unknown) => approvals.toolCall(bot.id, { toolName: 'mcp__fixture__create_item', input }, { sandboxed: false });
  const first = call(a);
  assert.equal(approvals.decide(first.approval!.id, { decision: 'allow' }, null).tool!.inTurn, false);
  assert.equal(call({ ...a, description: 'B' }).behavior, 'wait', 'another description is another call');
  assert.equal(call({ ...a, extra: 1 }).behavior, 'wait', 'so is another field');
  assert.equal(call({ description: 'A', item_id: 'dummy-3' }).behavior, 'allow', 'the same call, keys in any order');
  assert.equal(call(a).behavior, 'wait', 'once');
  // Bash's description is the model's words about the command, so it is the one argument left out.
  assert.equal(callKey('Bash', { command: 'ls', description: 'x' }), callKey('Bash', { command: 'ls', description: 'y' }));
  assert.notEqual(callKey('mcp__fixture__create_item', { description: 'x' }), callKey('mcp__fixture__create_item', { description: 'y' }));
});

/** The key an approval made before every argument counted was stored under: its input without a description. */
const keyWithoutDescription = (toolName: string, input: Record<string, unknown>) => {
  const { description: _, ...rest } = input;
  return callKey(toolName, rest);
};

test('an allow stored under a key that left the description out is spent only by the exact call it was given for', () => {
  const { store, approvals, bot, at } = approvalsFixture();
  at.origin = null;
  const tool = 'mcp__fixture__create_item';
  const call = (input: unknown) => approvals.toolCall(bot.id, { toolName: tool, input }, { sandboxed: false });
  const a = { item_id: 'dummy-4', description: 'A' };
  const first = call(a);
  approvals.decide(first.approval!.id, { decision: 'allow' }, null);
  store.db.prepare('update approvals set tool_key = ? where id = ?').run(keyWithoutDescription(tool, a), first.approval!.id);

  const other = call({ item_id: 'dummy-4' });
  assert.equal(other.behavior, 'wait', 'a call without the description is another call');
  assert.notEqual(other.approval!.id, first.approval!.id);
  assert.equal(approvals.get(first.approval!.id).tool!.usedAt, null, 'the allow is still unspent');
  assert.equal(call(a).behavior, 'allow', 'the call it was given for');
  assert.equal(call(a).behavior, 'wait', 'once');
});

test('a waiting card stored under a key that left the description out takes only the exact call it shows', () => {
  const { store, approvals, bot, at } = approvalsFixture();
  at.origin = null;
  const tool = 'mcp__fixture__create_item';
  const call = (input: unknown) => approvals.toolCall(bot.id, { toolName: tool, input }, { sandboxed: false });
  const a = { item_id: 'dummy-5', description: 'A' };
  const first = call(a);
  store.db.prepare('update approvals set tool_key = ? where id = ?').run(keyWithoutDescription(tool, a), first.approval!.id);

  const other = call({ item_id: 'dummy-5' });
  assert.notEqual(other.approval!.id, first.approval!.id, 'a card showing description A never waits for a call without it');
  assert.deepEqual(approvals.get(other.approval!.id).tool!.input, { item_id: 'dummy-5' });
  assert.equal(call(a).approval!.id, first.approval!.id, 'the call it shows still waits on it');
});

test('the `botons mcp` bridge: two identical permission prompts at once, one Allow once, one call allowed and the other denied when its wait ends', async () => {
  const { approvals, bot } = approvalsFixture(250);
  // The two routes the bridge uses, on loopback, over the same Approvals the server uses.
  const api = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, 'http://127.0.0.1');
    let out: ToolCallVerdict;
    try {
      const card = url.pathname.match(/^\/api\/approvals\/([^/]+)\/tool-call$/);
      if (req.method === 'POST' && url.pathname === `/api/bots/${bot.id}/approvals/tool-call`) out = approvals.toolCall(bot.id, JSON.parse(body), { sandboxed: false });
      else if (req.method === 'GET' && card) out = approvals.toolVerdict(card[1], url.searchParams.get('waiter'));
      else throw new HttpError(404, 'no route');
    } catch (err) {
      res.writeHead(err instanceof HttpError ? err.status : 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const port = (api.address() as { port: number }).port;
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/cli/botons.ts'), 'mcp'], {
    env: { PATH: process.env.PATH ?? '', BOTONS_API: `http://127.0.0.1:${port}`, BOTON_BOT_ID: bot.id, BOTON_TOKEN: 'fake-turn-token', BOTON_APPROVAL_POLL_MS: '20' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const answers = new Map<number, { behavior: string }>();
  let buffered = '';
  child.stdout.on('data', (d: Buffer) => {
    buffered += d.toString();
    for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
      const msg = JSON.parse(buffered.slice(0, i));
      buffered = buffered.slice(i + 1);
      if (msg.result?.content) answers.set(msg.id, JSON.parse(msg.result.content[0].text));
    }
  });
  try {
    const input = { item_id: 'dummy-4', description: 'A' };
    for (const id of [1, 2]) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'mcp__fixture__create_item', input, tool_use_id: `toolu_${id}` } } })}\n`);
    }
    const cards = async () => {
      for (let i = 0; i < 200; i++) {
        const list = approvals.list({ status: 'pending' }).filter((a) => a.botId === bot.id);
        if (list.length >= 2) return list;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail('the bridge did not ask for both calls');
    };
    const [card] = await cards();
    approvals.decide(card.id, { decision: 'allow' }, null);
    for (let i = 0; i < 300 && answers.size < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([...answers.values()].map((a) => a.behavior).sort(), ['allow', 'deny'], 'one call allowed; the other waited for its own card and was denied');
  } finally {
    child.stdin.end();
    child.kill();
    api.close();
  }
});

const ask = (from: string, name: string): MessageMeta => ({ kind: 'ask', fromBotId: from, fromBotName: name, threadId: `th_${from}`, hop: 1 });

test("a chat turn answers one audience, and its replay holds no message waiting for another (asks first, several askers, the owner's)", () => {
  const { store } = open();
  const bob = store.createBot({ name: 'Bob', provider: 'mock' }, new Set(['mock']), 'mock');
  store.addMessage(bob.id, 'user', 'Earlier, answered: hello', null);
  store.addMessage(bob.id, 'user', 'ASK_A from Dave', ask('bot_dave', 'Dave'), true);
  store.addMessage(bob.id, 'user', 'ASK_A2 from Dave', ask('bot_dave', 'Dave'), true);
  store.addMessage(bob.id, 'user', 'ASK_B from Stuart', ask('bot_stuart', 'Stuart'), true);
  store.addMessage(bob.id, 'user', 'OWNER_PRIVATE_PENDING locker code', null, true);
  const replayText = (ids: string[]) => sessionStart(store.replaySource(bob.id, null, ids), { ownerName: 'Sam' }, 'UTC').text;

  const seen: string[][] = [];
  for (;;) {
    const turn = store.startChatTurn(bob.id);
    if (!turn.messages.length) break;
    const ids = turn.messages.map((m) => m.id);
    seen.push(turn.messages.map((m) => m.text.split(' ')[0]));
    const waiting = store.db.prepare("select text from messages where bot_id = ? and pending in (1, 2)").all(bob.id).map((r) => String(r.text).split(' ')[0]);
    assert.ok(waiting.length);
    const replay = replayText(ids);
    // The replay of this turn's fresh session: the chat answered so far, nothing still waiting (this turn's input or
    // another audience's).
    assert.match(replay, /Earlier, answered/);
    for (const marker of waiting) assert.doesNotMatch(replay, new RegExp(`${marker}\\b`), `${seen.at(-1)}: ${marker}`);
    assert.equal(turn.more, seen.length < 3);
    store.finishChatTurn(ids, bob.id, `Reply ${seen.length}`, null);
  }
  assert.deepEqual(seen, [['ASK_A', 'ASK_A2'], ['ASK_B'], ['OWNER_PRIVATE_PENDING']]);
});

test("the owner's turn first: its replay holds no colleague's ask still waiting", () => {
  const { store } = open();
  const bob = store.createBot({ name: 'Bob', provider: 'mock' }, new Set(['mock']), 'mock');
  store.addMessage(bob.id, 'user', 'OWNER_FIRST', null, true);
  store.addMessage(bob.id, 'user', 'ASK_WAITING', ask('bot_dave', 'Dave'), true);
  const turn = store.startChatTurn(bob.id);
  assert.deepEqual(turn.messages.map((m) => m.text), ['OWNER_FIRST']);
  const replay = sessionStart(store.replaySource(bob.id, null, turn.messages.map((m) => m.id)), { ownerName: 'Sam' }, 'UTC').text;
  assert.doesNotMatch(replay, /ASK_WAITING|OWNER_FIRST/);
});

const routine = (o: Partial<Routine>): Routine =>
  ({ id: 'rt_1', name: 'Hook', instruction: 'Summarize it', webhook: { source: 'generic' }, session: 'chat', webhookHistory: 0, timeLimitMs: null, ...o }) as Routine;

test("a webhook run never carries on the chat's session: a fresh one unless its routine's own session (with no chat shared) will do", () => {
  for (const session of ['chat', 'own'] as const) {
    for (const history of [0, 3]) {
      const r = routine({ session, webhookHistory: history });
      assert.equal(runSession(r, 'webhook'), session === 'own' && history === 0 ? 'own' : 'fresh', `${session}, ${history}`);
      assert.equal(runSession(r, 'test'), runSession(r, 'webhook'), 'a webhook routine\'s test run too');
      assert.equal(runSession(r, 'schedule'), session, 'a scheduled run is on the session it names');
    }
  }
  assert.equal(runSession(routine({ webhook: null }), 'test'), 'chat', 'a test run of a routine with no webhook is not from outside');
});

test('the chat a webhook run is given stays inside its budget, and its prompt says how much it sees', () => {
  const chat = Array.from({ length: WEBHOOK_HISTORY_MAX }, (_, i) => ({
    message: { id: `m${i}`, botId: 'bot_bob', role: 'user', text: `${'word '.repeat(900)}${i}`, createdAt: '2026-11-08T09:00:00.000Z', meta: null, pending: false },
    seq: 100 - i,
  }));
  const start = sessionStart({ chat: chat as never, routines: [], pins: [], budget: WEBHOOK_HISTORY_BUDGET }, { ownerName: 'Sam' }, 'UTC');
  assert.ok(start.plan.used <= WEBHOOK_HISTORY_BUDGET, `${start.plan.used}`);
  assert.equal(start.plan.budget, WEBHOOK_HISTORY_BUDGET);
  assert.ok(start.plan.messages > 0 && start.plan.messages < WEBHOOK_HISTORY_MAX);

  const run = { id: 'run_1', trigger: 'webhook', attempts: 1, payload: 'event', headers: null } as unknown as RunRecord;
  assert.match(routinePrompt(routine({}), run, { owner: 'Sam', session: 'fresh' }), /none of your conversation with Sam/);
  assert.match(routinePrompt(routine({ webhookHistory: 3 }), run, { owner: 'Sam', session: 'fresh' }), /only the latest messages of your conversation with Sam that Sam chose to share/);
});

test("webhookHistory starts at 0 on every path that makes a routine, and holds only 0 to the maximum", () => {
  const { store } = open();
  const bot = store.createBot({ name: 'Stuart', provider: 'mock' }, new Set(['mock']), 'mock');
  const daily = store.createRoutine(bot.id, { name: 'Daily', instruction: 'x', session: 'chat' });
  assert.equal(daily.webhookHistory, 0);
  // A webhook added to a routine on the chat's session later: still none of the chat for its webhook runs.
  const hooked = store.updateRoutine(daily.id, { webhook: true });
  assert.deepEqual([hooked.session, hooked.webhookHistory, runSession(hooked, 'webhook')], ['chat', 0, 'fresh']);
  assert.equal(store.createRoutine(bot.id, { name: 'Hook', instruction: 'x', webhook: true, session: 'chat' }).webhookHistory, 0);
  assert.equal(store.updateRoutine(daily.id, { webhookHistory: WEBHOOK_HISTORY_MAX }).webhookHistory, WEBHOOK_HISTORY_MAX);
  for (const bad of [-1, WEBHOOK_HISTORY_MAX + 1, 1.5, '3', null]) assert.throws(() => store.updateRoutine(daily.id, { webhookHistory: bad as never }), /webhookHistory must be/);
});

const hex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

test('a signature is checked on the exact bytes, before anything parses them; a form is read in one pass with a cap on its fields', () => {
  const body = Buffer.from(Array(200_000).fill('a=x').join('&'));
  const secrets = { key: 'key-for-tests', secret: null };
  // Refused from the bytes alone: no parsed body is needed, so none is made.
  assert.match(webhooks.signatureProblem('github', secrets, { 'x-hub-signature-256': 'sha256=00' }, body)!, /X-Hub-Signature-256/);
  assert.equal(webhooks.signatureProblem('github', secrets, { 'x-hub-signature-256': `sha256=${hex('key-for-tests', body)}` }, body), null);
  assert.throws(() => webhooks.parseDelivery(body, 'application/x-www-form-urlencoded'), /too many form fields/);

  const at = (n: number) => Buffer.from(Array(n).fill('a=x').join('&'));
  const t = performance.now();
  const ok = webhooks.parseDelivery(at(webhooks.FORM_FIELDS_MAX), 'application/x-www-form-urlencoded');
  assert.ok(performance.now() - t < 500, `parsed in ${Math.round(performance.now() - t)} ms`);
  assert.equal((ok.json as Record<string, string[]>).a.length, webhooks.FORM_FIELDS_MAX);
  assert.deepEqual(webhooks.parseDelivery(Buffer.from('a=1&a=2&a=3&b=4'), 'application/x-www-form-urlencoded').json, Object.assign(Object.create(null), { a: ['1', '2', '3'], b: '4' }));
  // Linear's freshness is read from the signed body, after the signature.
  assert.match(webhooks.freshnessProblem('linear', { webhookTimestamp: Date.now() - 120_000 })!, /Stale/);
  assert.equal(webhooks.freshnessProblem('linear', { webhookTimestamp: Date.now() }), null);
});
