// In process, for `npm test`: the real routes (auth, the API router, the hook route) and the real engine on the mock
// brain, with no Botons server listening. A loopback socket stands in for one, so the real `botons mcp` bridge a turn
// runs asks the real routes with the token the engine minted for that turn. Covered here: a Workspace Boton's paused
// tool calls from its own turn (an allow's updatedInput is what runs, each identical call has its own card, a grant
// given after the wait is spent once); a resumed session's input and a lost session's replay holding only one
// audience; webhookHistory set by the owner alone, within bounds; and a signed hook refused before its body is parsed.
import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Approval, Bot, Routine } from '../../shared/types.ts';
import { buildRouter } from '../src/api.ts';
import { createApp } from '../src/app.ts';
import { createDevice } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { makeCtx, sendJson } from '../src/http.ts';
import type { MockProvider } from '../src/providers/mock.ts';
import { ProviderError, type TurnRequest } from '../src/providers/types.ts';
import { WEBHOOK_HISTORY_MAX } from '../src/replay.ts';
import { HttpError } from '../src/store.ts';
import { freePort, noRealClis, tempDir, until } from './helpers.ts';

const home = tempDir('botons-security-routes-');
const port = await freePort();
const cfg = loadConfig({ BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(port), BOTONS_ENABLE_MOCK: '1', BOTONS_NO_TAILSCALE: '1', BOTONS_APPROVAL_WAIT: '60s', ...noRealClis(home) });
cfg.webDist = join(home, 'web-dist');
mkdirSync(cfg.webDist, { recursive: true });
// Never app.listen(): no scheduler, tailnet or recovery; the engine runs turns as they are queued.
const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: {} } });
const unused = new Proxy({}, { get: () => assert.fail('not used by these routes') }) as never;
const router = buildRouter({ ...app, cfg, callbacks: unused, brainLogin: unused, releases: unused, cliInstaller: unused, starterGate: app.engine.starterGate! });
const mock = app.providers.get('mock') as MockProvider;
const owner = createDevice(app.store.db, 'Test client').token;

// What app.ts's request handler does for /api and /hooks: match, authenticate and authorize /api, then the handler.
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (match === null || match === 'method') return sendJson(res, 404, { error: 'Not found' });
    let principal = null;
    if (url.pathname.startsWith('/api/')) {
      principal = app.auth.authenticate(req, { url, urlKey: match.access.urlKey });
      app.auth.authorize(principal, match.access, match.params, req);
    }
    const out = await match.handler(makeCtx(req, res, url, match.params, principal, match.maxBody));
    if (!res.headersSent) sendJson(res, out === undefined ? 204 : 200, out ?? {});
  } catch (err) {
    if (!res.headersSent) sendJson(res, err instanceof HttpError ? err.status : 500, { error: (err as Error).message });
  }
});
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
after(async () => {
  server.closeAllConnections();
  server.close();
  await app.close();
});

const base = `http://127.0.0.1:${port}`;
async function call<T = any>(method: string, path: string, body?: unknown, token: string | null = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}
async function newBot(name: string, extra: Record<string, unknown> = {}): Promise<Bot> {
  const { status, data } = await call<Bot>('POST', '/api/bots', { name, provider: 'mock', connections: [], ...extra });
  assert.equal(status, 201, JSON.stringify(data));
  return data;
}
const turnsOf = (botId: string) => mock.turns.filter((t) => t.env.BOTON_BOT_ID === botId);
const idle = (botId: string) => app.engine.statusOf(botId).state === 'idle' && !app.store.hasPendingChat(botId);
const scripts = new Map<string, (t: TurnRequest) => Promise<string | null> | string | null>();
/** What a scripted turn threw (an assertion inside it), for the test to fail on rather than the turn quietly erring. */
const thrown: unknown[] = [];
mock.script = async (t) => {
  try {
    return (await scripts.get(t.env.BOTON_BOT_ID ?? '')?.(t)) ?? null;
  } catch (err) {
    thrown.push(err);
    throw err;
  }
};
const noThrow = () => {
  if (thrown.length) throw thrown.splice(0)[0];
};

/** The real `botons mcp` bridge, run as a turn runs it: with that turn's API, Boton id and token. */
function bridge(t: TurnRequest) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [join(import.meta.dirname, '../src/cli/botons.ts'), 'mcp'], {
    env: { PATH: process.env.PATH ?? '', BOTONS_API: t.env.BOTONS_API, BOTON_BOT_ID: t.env.BOTON_BOT_ID, BOTON_TOKEN: t.env.BOTON_TOKEN, BOTON_APPROVAL_POLL_MS: '20' },
  });
  type Answer = { behavior: string; updatedInput?: unknown; message?: string };
  const waiting = new Map<number, (a: Answer) => void>();
  let buffered = '';
  child.stdout.on('data', (d: Buffer) => {
    buffered += d.toString();
    for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
      const msg = JSON.parse(buffered.slice(0, i));
      buffered = buffered.slice(i + 1);
      if (msg.result?.content) waiting.get(msg.id)?.(JSON.parse(msg.result.content[0].text));
    }
  });
  // A call still waiting when the bridge goes (its turn ended) hears nothing more.
  child.once('exit', () => {
    for (const done of waiting.values()) done({ behavior: 'gone' });
  });
  let next = 1;
  return {
    /** Claude Code's permission prompt for one tool call: the bridge's answer. */
    ask(toolName: string, input: unknown): Promise<Answer> {
      const id = next++;
      const answer = new Promise<Answer>((r) => waiting.set(id, r));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: toolName, input, tool_use_id: `toolu_${id}` } } })}\n`);
      return answer;
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

const pending = async (botId: string, n: number) => until(async () => {
  const list = (await call<Approval[]>('GET', `/api/bots/${botId}/approvals?status=pending`)).data;
  return list.length >= n && list;
}, 8000);
const decide = (id: string, decision: 'allow' | 'deny') => call<Approval>('POST', `/api/approvals/${id}/decide`, { decision });

test("a Workspace Boton's own turn, through `botons mcp` and the real routes: what the owner allowed is what runs, once; identical calls each get a card; a changed description asks again", async () => {
  const kev = await newBot('Kevin', { access: 'workspace' });
  assert.equal(kev.access, 'workspace');
  assert.equal((await call('PATCH', `/api/bots/${kev.id}`, { askFirst: ['mcp__fixture'] })).status, 200);
  // The dummy MCP operation, dispatched as Claude Code does: with the allow's updatedInput, never on a deny.
  const ran: unknown[] = [];
  const dispatch = (answer: { behavior: string; updatedInput?: unknown }) => {
    if (answer.behavior === 'allow') ran.push(answer.updatedInput);
  };
  const A = { item_id: 'dummy-1', description: 'A' };
  const outcome: Record<string, unknown> = {};

  scripts.set(kev.id, async (t) => {
    // A chat turn of a Workspace Boton: not from outside, so its token is not a sandboxed one, but its access is.
    assert.equal(t.access, 'workspace');
    const b = bridge(t);
    try {
      const [one, two] = [b.ask('mcp__fixture__create_item', A), b.ask('mcp__fixture__create_item', A)];
      const cards = await pending(kev.id, 2);
      assert.equal(new Set(cards.map((c) => c.id)).size, 2, 'two identical calls at once, two cards');
      assert.ok(cards.every((c) => !c.from.sandboxed && c.from.turnId));
      assert.equal((await decide(cards[0].id, 'allow')).data.tool!.inTurn, true);
      const first = await Promise.race([one, two]);
      assert.equal(first.behavior, 'allow');
      dispatch(first);
      // The other call still waits on its own card: the one allow went to one call.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(ran.length, 1);
      assert.equal((await decide(cards[1].id, 'deny')).status, 200);
      const second = await (first === (await one) ? two : one);
      assert.equal(second.behavior, 'deny');
      dispatch(second);

      // The same item with another description is another call: a card of its own, which the owner denies.
      const asB = b.ask('mcp__fixture__create_item', { ...A, description: 'B' });
      const [cardB] = (await pending(kev.id, 1)).filter((c) => !cards.some((x) => x.id === c.id));
      assert.ok(cardB);
      assert.deepEqual(cardB.tool!.input, { ...A, description: 'B' }, 'the card shows the call as it is');
      await decide(cardB.id, 'deny');
      dispatch(await asB);

      // Still waiting when the turn ends (its bridge goes with it): allowed after its wait, below.
      const late = b.ask('mcp__fixture__create_item', { item_id: 'dummy-2', description: 'C' });
      outcome.late = (await pending(kev.id, 1))[0].id;
      b.close();
      outcome.lateAnswer = (await late).behavior;
    } finally {
      b.close();
    }
    return 'Done.';
  });
  await call('POST', `/api/bots/${kev.id}/messages`, { text: 'Make the items' });
  await until(() => turnsOf(kev.id).length === 1 && idle(kev.id), 15_000);
  noThrow();
  assert.deepEqual(ran, [A], 'exactly the approved input ran, once');
  assert.equal(outcome.lateAnswer, 'gone', 'nobody decided in its turn');

  // Allowed after its wait: the server wakes the Boton, and in that turn two identical calls race for the one grant.
  const C = { item_id: 'dummy-2', description: 'C' };
  const results: string[] = [];
  scripts.set(kev.id, async (t) => {
    const b = bridge(t);
    try {
      const both = [b.ask('mcp__fixture__create_item', C), b.ask('mcp__fixture__create_item', C)];
      // One spends the grant; the other gets a card of its own and waits for it.
      const card = (await pending(kev.id, 1))[0];
      assert.notEqual(card.id, outcome.late);
      await decide(card.id, 'deny');
      for (const a of await Promise.all(both)) {
        dispatch(a);
        results.push(a.behavior);
      }
    } finally {
      b.close();
    }
    return 'Done again.';
  });
  const decided = (await decide(String(outcome.late), 'allow')).data;
  assert.equal(decided.tool!.inTurn, false);
  await until(() => turnsOf(kev.id).length === 2 && idle(kev.id), 15_000);
  noThrow();
  assert.deepEqual(results.sort(), ['allow', 'deny']);
  assert.deepEqual(ran, [A, C]);
});

test('a grant given after the wait is spent by one call only, however many identical calls arrive at once', async () => {
  const stu = await newBot('Stuart', { access: 'workspace' });
  await call('PATCH', `/api/bots/${stu.id}`, { askFirst: ['mcp__fixture'] });
  const input = { item_id: 'dummy-3', description: 'D' };
  // No turn runs: the call stops waiting at once, and the owner allows it afterwards.
  const token = app.auth.mintBotonToken(stu.id).token;
  const first = (await call('POST', `/api/bots/${stu.id}/approvals/tool-call`, { toolName: 'mcp__fixture__create_item', input }, token)).data;
  assert.equal(first.behavior, 'wait');
  scripts.set(stu.id, () => 'Noted.');
  assert.equal((await decide(first.approval.id, 'allow')).data.tool!.inTurn, false);
  await until(() => idle(stu.id), 15_000);
  const all = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/bots/${stu.id}/approvals/tool-call`, { toolName: 'mcp__fixture__create_item', input }, token)));
  assert.deepEqual(all.map((r) => r.data.behavior).sort(), ['allow', ...Array(7).fill('wait')]);
  assert.equal((await call<Approval>('GET', `/api/approvals/${first.approval.id}`)).data.tool!.usedAt !== null, true);
  // A sandboxed turn's token never spends a grant made for the Boton's usual turns.
  const grant = (await call('POST', `/api/bots/${stu.id}/approvals/tool-call`, { toolName: 'mcp__fixture__create_item', input: { item_id: 'dummy-4' } }, token)).data;
  await decide(grant.approval.id, 'allow');
  await until(() => idle(stu.id), 15_000);
  const sandboxed = app.auth.mintBotonToken(stu.id, { sandboxed: true }).token;
  const fromOutside = (await call('POST', `/api/bots/${stu.id}/approvals/tool-call`, { toolName: 'mcp__fixture__create_item', input: { item_id: 'dummy-4' } }, sandboxed)).data;
  assert.equal(fromOutside.behavior, 'wait');
  assert.equal((await call<Approval>('GET', `/api/approvals/${grant.approval.id}`)).data.tool!.usedAt, null);
});

/** A Boton with a chat session, paused, with asks from two colleagues and then the owner's message waiting. */
async function waitingForThree(name: string) {
  const bob = await newBot(name);
  const dave = await newBot(`${name}-Dave`);
  const stuart = await newBot(`${name}-Stuart`);
  for (const b of [dave, stuart]) scripts.set(b.id, () => 'Thanks.');
  scripts.set(bob.id, () => 'Hi.');
  await call('POST', `/api/bots/${bob.id}/messages`, { text: 'Earlier, answered: hello' });
  await until(() => idle(bob.id) && app.store.getBot(bob.id).sessionId, 15_000);
  const session = app.store.getBot(bob.id).sessionId;
  assert.equal((await call('POST', `/api/bots/${bob.id}/pause`)).status, 200);
  const turns = turnsOf(bob.id).length;
  app.engine.ask(dave.id, bob.id, 'ASK_A from Dave');
  app.engine.ask(stuart.id, bob.id, 'ASK_B from Stuart');
  await call('POST', `/api/bots/${bob.id}/messages`, { text: 'OWNER_PRIVATE_PENDING: the locker code' });
  return { bob, dave, stuart, session, turns };
}

test("resumed turns: each one's whole input holds its own audience's messages only (asks first, two askers, the owner's)", async () => {
  const { bob, dave, stuart, session, turns } = await waitingForThree('Bob');
  scripts.set(bob.id, (t) => `Seen ${turnsOf(bob.id).length - turns}`);
  await call('POST', `/api/bots/${bob.id}/resume`);
  await until(() => turnsOf(bob.id).length === turns + 3 && idle(bob.id) && idle(dave.id) && idle(stuart.id), 15_000);
  const [a, b, own] = turnsOf(bob.id).slice(turns);
  for (const t of [a, b, own]) assert.equal(t.sessionId, session, 'each resumes the chat session');
  assert.match(a.prompt, /ASK_A/);
  assert.doesNotMatch(a.prompt, /ASK_B|OWNER_PRIVATE_PENDING/);
  assert.match(b.prompt, /ASK_B/);
  assert.doesNotMatch(b.prompt, /ASK_A|OWNER_PRIVATE_PENDING/);
  assert.match(own.prompt, /OWNER_PRIVATE_PENDING/);
  assert.doesNotMatch(own.prompt, /ASK_A|ASK_B/);
  for (const t of [...turnsOf(dave.id), ...turnsOf(stuart.id)]) assert.doesNotMatch(t.prompt, /OWNER_PRIVATE_PENDING/);
});

test("a lost session's replay, for a colleague's ask: the chat answered so far, nothing waiting for another audience", async () => {
  const { bob, dave, stuart, session, turns } = await waitingForThree('Bobby');
  mock.failNext(bob.id, new ProviderError('No conversation found with that session', true));
  scripts.set(bob.id, () => 'Answered.');
  await call('POST', `/api/bots/${bob.id}/resume`);
  await until(() => turnsOf(bob.id).length === turns + 4 && idle(bob.id) && idle(dave.id) && idle(stuart.id), 15_000);
  const [lost, retry] = turnsOf(bob.id).slice(turns);
  assert.equal(lost.sessionId, session);
  assert.equal(retry.sessionId, null, 'a new session, with the replay');
  assert.match(retry.prompt, /Earlier, answered/);
  assert.match(retry.prompt, /ASK_A/);
  assert.doesNotMatch(retry.prompt, /ASK_B|OWNER_PRIVATE_PENDING/);
});

test('webhookHistory: only the owner shares the chat with webhook runs, within bounds, on record; a run sees only that much', async () => {
  const stu = await newBot('Stu');
  scripts.set(stu.id, () => 'ok');
  for (const text of ['OWNER_HISTORY_OLD', 'OWNER_HISTORY_NEW']) {
    await call('POST', `/api/bots/${stu.id}/messages`, { text });
    await until(() => idle(stu.id), 15_000);
  }
  const made = await call<Routine>('POST', `/api/bots/${stu.id}/routines`, { name: 'Hook', instruction: 'Summarize it', webhook: true, session: 'chat' });
  assert.equal(made.status, 201);
  assert.equal(made.data.webhookHistory, 0);
  const token = app.auth.mintBotonToken(stu.id).token;
  assert.equal((await call('PATCH', `/api/routines/${made.data.id}`, { webhookHistory: 1 }, token)).status, 403);
  assert.equal((await call('POST', `/api/bots/${stu.id}/routines`, { name: 'Sneaky', instruction: 'x', webhook: true, webhookHistory: 5 }, token)).status, 403);
  assert.equal((await call('PATCH', `/api/routines/${made.data.id}`, { webhookHistory: 0 }, token)).status, 200, 'a Boton may take it back');
  for (const bad of [WEBHOOK_HISTORY_MAX + 1, -1, 1.5, '2']) assert.equal((await call('PATCH', `/api/routines/${made.data.id}`, { webhookHistory: bad })).status, 400, `${bad}`);
  const shared = await call<Routine>('PATCH', `/api/routines/${made.data.id}`, { webhookHistory: 2 });
  assert.deepEqual([shared.status, shared.data.webhookHistory], [200, 2]);
  const entry = app.store.db.prepare("select details from audit_events where action = 'routine.permissions_changed' and target_id = ? order by seq desc limit 1").get(made.data.id) as { details: string } | undefined;
  assert.equal(JSON.parse(entry!.details).webhookHistory, 2);

  const seen = turnsOf(stu.id).length;
  app.engine.triggerRoutine(made.data.id, 'webhook', 'event');
  await until(() => turnsOf(stu.id).length > seen && idle(stu.id), 15_000);
  const t = turnsOf(stu.id)[seen];
  assert.equal(t.sessionId, null);
  assert.match(t.prompt, /OWNER_HISTORY_NEW/);
  assert.doesNotMatch(t.prompt, /OWNER_HISTORY_OLD/);
});

const hex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const hook = (r: Routine, headers: Record<string, string>, body: string) => fetch(`${base}/hooks/routines/${r.id}`, { method: 'POST', headers, body });

test('the hook route checks a key or signature before it parses the body', async () => {
  const bot = await newBot('Hooky');
  scripts.set(bot.id, () => 'ok');
  const make = async (webhookSource: string) => (await call<Routine>('POST', `/api/bots/${bot.id}/routines`, { name: webhookSource, instruction: 'x', webhook: true, webhookSource })).data;
  // A body that parsing refuses (400): an unauthenticated one is refused for that (401) before it is parsed.
  const tooMany = Array(5000).fill('a=x').join('&');
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const generic = await make('generic');
  assert.equal((await hook(generic, { ...form, authorization: 'Bearer wrong' }, tooMany)).status, 401);
  assert.equal((await hook(generic, { ...form, authorization: `Bearer ${generic.webhook!.key}` }, tooMany)).status, 400);

  const github = await make('github');
  assert.equal((await hook(github, { ...form, 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'push' }, tooMany)).status, 401);
  const signed = await hook(github, { ...form, 'x-hub-signature-256': `sha256=${hex(github.webhook!.key, tooMany)}`, 'x-github-event': 'push' }, tooMany);
  assert.equal(signed.status, 400);
  assert.match(((await signed.json()) as { error: string }).error, /too many form fields/);

  // Linear: the signature first, then the freshness its signed body states.
  const linear = await make('linear');
  const secret = 'linear-secret-for-tests';
  assert.equal((await call('PATCH', `/api/routines/${linear.id}`, { webhookSecret: secret })).status, 200);
  const json = { 'content-type': 'application/json' };
  const stale = JSON.stringify({ webhookTimestamp: Date.now() - 600_000, type: 'Issue' });
  const forged = await hook(linear, { ...json, 'linear-signature': '00' }, stale);
  assert.equal(forged.status, 401);
  assert.match(((await forged.json()) as { error: string }).error, /Linear-Signature/);
  const old = await hook(linear, { ...json, 'linear-signature': hex(secret, stale) }, stale);
  assert.equal(old.status, 401);
  assert.match(((await old.json()) as { error: string }).error, /Stale/);
  assert.equal((await hook(linear, { ...json, 'linear-signature': '00' }, '{not json')).status, 401, 'not parsed, so not a 400');
});
