// Turning a connector off and on again from Settings → Connectors: nothing it has is deleted (setup, secrets, sign-in,
// grants), no turn gets it while it is off (checked through the fake CLIs and a fake OAuth gateway, whose tool calls are
// counted), Botons can't ask for it or have an earlier card allowed, and on again it is exactly what it was.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Approval, AuditEvent, ConnectorAccess, ConnectorCatalog, ConnectorRequestResult, BotonCapabilities, BotonConnector } from '../../shared/types.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import { OFF_REASON } from '../src/connectors.ts';
import type { Call } from './fixtures/fake-cli.ts';
import { botonCli, startServer, type TestServer, until, useTestCodexHome } from './helpers.ts';
import { feedEvent } from './fixtures/fake-oauth-mcp.ts';
import { addConnector, setup, signIn } from './oauth-helpers.ts';

const SECRET = 'ghp_enabled_test_secret_456';

const access = async (s: TestServer, id: string) => {
  const r = await s.call<ConnectorAccess>('GET', `/api/connectors/${encodeURIComponent(id)}/access`);
  assert.equal(r.status, 200, r.text);
  return r.data;
};
const holders = (a: ConnectorAccess) => a.botons.filter((m) => m.has).map((m) => m.botId);
/** Turns it on or off as the dialog does: with what the owner was shown. */
async function power(s: TestServer, id: string, enabled: boolean, reason?: string, token?: string) {
  const a = await access(s, id);
  return s.call<ConnectorAccess & { error?: string }>(
    'PUT',
    `/api/connectors/${encodeURIComponent(id)}/enabled`,
    { enabled, reason, expected: { enabled: a.enabled, botIds: holders(a), running: a.running.map((t) => t.turnId) } },
    token,
  );
}
const catalogEntry = async (s: TestServer, id: string) => (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((c) => c.id === id)!;
const serversOf = (call: Call) => Object.keys(JSON.parse(call.mcpConfigFile ?? '{"mcpServers":{}}').mcpServers ?? {});
const audited = async (s: TestServer, action: string) => (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === action);

test('off keeps the setup and every grant, leaves it out of turns and requests, and on again restores exactly that', async () => {
  const s = await startServer({ fakeClis: true });
  useTestCodexHome(s.cfg.home);
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } })).status, 201);
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['lib:github'] });
  const dave = await s.newBot('Dave', { provider: 'claude-cli', connections: ['lib:github'] });
  const stuart = await s.newBot('Stuart', { provider: 'claude-cli' });
  await s.call('PATCH', '/api/connectors/lib:github/policy', { onRequest: true, grant: 'approval' });
  // A card Stuart asked for while it was on: it must not be allowed after an off and on.
  const card = await s.call<ConnectorRequestResult>('POST', `/api/bots/${stuart.id}/connector-requests`, { connector: 'lib:github' }, s.app.auth.mintBotonToken(stuart.id).token);
  assert.equal(card.data.outcome, 'pending');

  s.claude.script('claude/reply');
  await s.chat(kevin.id, 'Hi');
  assert.deepEqual(serversOf(s.claude.calls()[0]), ['github']);

  const off = await power(s, 'lib:github', false, 'Rotating its key');
  assert.equal(off.status, 200, off.text);
  assert.equal(off.data.enabled, false);
  assert.equal(off.data.off?.reason, 'Rotating its key');
  assert.deepEqual(off.data.running, []);
  // Every grant kept; nobody may ask for it now.
  assert.deepEqual(holders(off.data).sort(), [kevin.id, dave.id].sort());
  assert.ok(off.data.botons.every((m) => !m.mayAsk));
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['lib:github']);
  // Its setup and secret too, still only as names.
  const server = await s.call<{ headerKeys: string[] }>('GET', '/api/mcp-servers/github');
  assert.deepEqual(server.data.headerKeys, ['Authorization']);
  const entry = await catalogEntry(s, 'lib:github');
  assert.deepEqual([entry.enabled, entry.off?.reason, entry.onRequest], [false, 'Rotating its key', true]);

  // The next turn goes without it, says why, and the owner sees why in the Boton's notices.
  s.claude.script('claude/reply');
  await s.chat(kevin.id, 'Hi again');
  const turn = s.claude.calls()[0];
  assert.deepEqual(serversOf(turn), []);
  assert.ok(!turn.stdin.includes(SECRET) && !JSON.stringify(turn.argv).includes(SECRET));
  assert.ok(turn.stdin.includes(OFF_REASON), 'the turn is told why it went without it');
  const notices = await s.call<{ connectorId: string; reason: string }[]>('GET', `/api/bots/${kevin.id}/connector-notices`);
  assert.deepEqual(
    notices.data.map((n) => [n.connectorId, n.reason]),
    [['lib:github', OFF_REASON]],
  );
  assert.deepEqual((await s.app.connectors.resolve(['lib:github'], s.app.providers.get('codex-cli'))).servers, []);

  // What the Boton and its capabilities say.
  const listed = await botonCli(s.app, s.base, kevin.id, 'connector', 'list', '--json');
  assert.deepEqual(JSON.parse(listed.stdout) as BotonConnector[], [{ id: 'lib:github', name: 'github', state: 'yours', grant: null, usable: false, off: true }]);
  assert.match((await botonCli(s.app, s.base, kevin.id, 'connector', 'list')).stdout, /turned off by your owner/);
  const caps = (await s.call<BotonCapabilities>('GET', `/api/bots/${kevin.id}/capabilities`)).data;
  assert.deepEqual(caps.connectors, [{ id: 'lib:github', name: 'github', usable: false, off: true }]);
  assert.ok(caps.summary.some((l) => /Turned off by .*: github\./.test(l)));
  assert.ok(!caps.summary.some((l) => l.startsWith('Connectors:')));

  // Asking for it is refused, and so is allowing the card asked before.
  const stuartList = JSON.parse((await botonCli(s.app, s.base, stuart.id, 'connector', 'list', '--json')).stdout || '[]') as BotonConnector[];
  assert.deepEqual(stuartList, []);
  const asked = await botonCli(s.app, s.base, stuart.id, 'connector', 'request', 'lib:github');
  assert.equal(asked.code, 1);
  assert.match(asked.stderr, /turned off/);
  const refused = await s.call<{ error: string }>('POST', `/api/approvals/${card.data.approval!.id}/decide`, { decision: 'allow' });
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(s.app.store.getBot(stuart.id).connections, []);

  // A second card can't even be made; once on, an old card (made under the earlier generation) still can't be allowed.
  const on = await power(s, 'lib:github', true);
  assert.equal(on.status, 200, on.text);
  assert.deepEqual([on.data.enabled, on.data.off], [true, null]);
  assert.deepEqual(holders(on.data).sort(), [kevin.id, dave.id].sort(), 'exactly the grants it had, no more');
  assert.deepEqual(s.app.store.getBot(stuart.id).connections, []);
  const old = await s.call<Approval>('GET', `/api/approvals/${card.data.approval!.id}`);
  assert.notEqual(old.data.status, 'allowed');
  assert.equal(on.data.botons.find((m) => m.botId === stuart.id)!.mayAsk, true, 'asking works again as its policy says');

  s.claude.script('claude/reply');
  await s.chat(kevin.id, 'Back on');
  assert.deepEqual(serversOf(s.claude.calls()[0]), ['github']);

  // Audited once each way, with who had it and why; in the connector's own history.
  const offs = await audited(s, 'connector.disabled');
  assert.equal(offs.length, 1);
  assert.equal(offs[0].target?.id, 'lib:github');
  assert.deepEqual([...(offs[0].details.botons as string[])].sort(), ['Dave', 'Kevin']);
  assert.equal(offs[0].details.reason, 'Rotating its key');
  assert.equal((await audited(s, 'connector.enabled')).length, 1);
  assert.ok(on.data.history.some((e) => e.action === 'connector.disabled') && on.data.history.some((e) => e.action === 'connector.enabled'));
  assert.ok(!JSON.stringify(on.data).includes(SECRET));

  // Asking for the state it already has changes nothing and records nothing.
  assert.equal((await power(s, 'lib:github', true)).status, 200);
  assert.equal((await audited(s, 'connector.enabled')).length, 1);
});

test('a stale view, bad input, a Boton and the managed browser change nothing', async () => {
  const s = await startServer({ fakeClis: true });
  await s.call('POST', '/api/mcp-servers', { name: 'linear', transport: 'http', url: 'https://mcp.example.com/linear' });
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['lib:linear'] });
  const bob = await s.newBot('Bob', { provider: 'claude-cli' });
  const put = (body: unknown, token?: string) => s.call<{ error?: string }>('PUT', '/api/connectors/lib:linear/enabled', body, token);

  // Shown as on with Kevin; meanwhile Bob got it, or someone else turned it off: refused, nothing changes.
  await s.call('PUT', '/api/connectors/lib:linear/access', { botIds: [kevin.id, bob.id], expected: [kevin.id] });
  const stale = await put({ enabled: false, expected: { enabled: true, botIds: [kevin.id], running: [] } });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error!, /changed since you looked/);
  assert.equal((await catalogEntry(s, 'lib:linear')).enabled, true);
  assert.equal((await power(s, 'lib:linear', false)).status, 200);
  const twice = await put({ enabled: false, expected: { enabled: true, botIds: [kevin.id, bob.id], running: [] } });
  assert.equal(twice.status, 409);
  assert.equal((await audited(s, 'connector.disabled')).length, 1);

  for (const body of [{}, { enabled: 'no', expected: { enabled: false, botIds: [] } }, { enabled: true }, { enabled: true, expected: { enabled: false, botIds: 'all' } }, { enabled: true, reason: 'x'.repeat(201), expected: { enabled: false, botIds: [], running: [] } }, { enabled: true, expected: { enabled: false, botIds: [] } }, { enabled: true, expected: { enabled: false, botIds: [], running: [7] } }]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await s.call('PUT', '/api/connectors/lib:nothing/enabled', { enabled: false, expected: { enabled: true, botIds: [] } })).status, 404);

  // A Boton can't turn one on (its own or any).
  const t = s.app.auth.mintBotonToken(kevin.id);
  assert.equal((await put({ enabled: true, expected: { enabled: false, botIds: [kevin.id, bob.id], running: [] } }, t.token)).status, 403);
  t.revoke();
  assert.equal((await catalogEntry(s, 'lib:linear')).enabled, false);

  // The browser is given and stopped in each Boton's settings; it is always on here.
  const browser = await s.call<{ error?: string }>('PUT', `/api/connectors/${encodeURIComponent(BROWSER_CONNECTOR)}/enabled`, { enabled: false, expected: { enabled: true, botIds: [] } });
  assert.equal(browser.status, 400);
  assert.match(browser.data.error!, /Boton's settings/);

  // Deleting it takes its off state with it: one added again under the name starts on.
  assert.equal((await s.call('DELETE', '/api/mcp-servers/linear')).status, 200);
  await s.call('POST', '/api/mcp-servers', { name: 'linear', transport: 'http', url: 'https://mcp.example.com/linear' });
  assert.equal((await catalogEntry(s, 'lib:linear')).enabled, true);
});

test('an OAuth connector off: no tool call reaches the gateway, its feed is not read, its sign-in stays; on again it works', async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['oauth:notes'] });
  fake.jobs.job1 = { jobId: 'job1', state: 'running' };
  const calling = { fixture: 'claude/reply', mcp: { call: { server: 'notes', tool: 'work_status', arguments: { jobId: 'job1' } } } };

  s.claude.script(calling);
  await s.chat(kevin.id, 'Check job1');
  assert.equal(fake.statusCalls.length, 1);

  assert.equal((await power(s, 'oauth:notes', false)).status, 200);
  const tokenRequests = fake.tokenRequests.length;
  const mcpCalls = fake.mcpCalls.length;
  s.claude.script(calling);
  await s.chat(kevin.id, 'Check job1 again');
  assert.deepEqual(serversOf(s.claude.calls()[0]), []);
  assert.equal(s.claude.calls()[0].mcp, undefined, 'the CLI was given no server to start');
  assert.equal(fake.statusCalls.length, 1, 'no tool call reached the gateway');
  assert.equal(fake.tokenRequests.length, tokenRequests, 'no token fetched or refreshed for it');

  // Its work feed is not read while off.
  s.app.store.db.prepare('update oauth_connections set feed = 1 where id = ?').run(notes.id);
  assert.deepEqual(await s.app.workFeed.tick(notes.id), { delivered: 0, held: 0 });
  assert.equal(fake.mcpCalls.length, mcpCalls, 'nothing sent to the gateway');

  // The sign-in is kept: still connected, nothing to sign in again.
  const conn = (await s.call<{ connections: { id: string; status: string }[] }>('GET', '/api/oauth-connections')).data.connections.find((c) => c.id === notes.id)!;
  assert.equal(conn.status, 'connected');

  assert.equal((await power(s, 'oauth:notes', true)).status, 200);
  s.claude.script(calling);
  await s.chat(kevin.id, 'Check job1 once more');
  assert.deepEqual(serversOf(s.claude.calls()[0]), ['notes']);
  assert.equal(fake.statusCalls.length, 2);

  // Removing the connector takes its off state with it.
  await power(s, 'oauth:notes', false);
  assert.equal((await s.call('DELETE', `/api/oauth-connections/${notes.id}`)).status, 200);
  assert.equal(s.app.store.db.prepare("select count(*) as n from settings where key like 'connector_off:%'").get()!.n, 0);
});

test('turning it off says which turn running now keeps it; one started since the owner looked is a new review; a turn not yet started when it goes off goes without', async () => {
  const s = await startServer({ fakeClis: true });
  await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['lib:github'] });
  const put = (expected: { enabled: boolean; botIds: string[]; running: string[] }) => s.call<{ error?: string }>('PUT', '/api/connectors/lib:github/enabled', { enabled: !expected.enabled, expected });
  const shown = (a: ConnectorAccess) => ({ enabled: a.enabled, botIds: holders(a), running: a.running.map((t) => t.turnId) });

  // The owner opens the dialog while nothing runs with it; then Kevin's turn starts with it.
  const looked = await access(s, 'lib:github');
  assert.deepEqual(looked.running, []);
  s.claude.script({ fixture: 'claude/reply', delayMs: 1500 });
  const reply = s.send(kevin.id, 'Take your time');
  await until(() => s.claude.calls().length === 1);
  assert.deepEqual(serversOf(s.claude.calls()[0]), ['github']);
  // What they were shown no longer says everything that keeps it: refused, and nothing changes.
  const stale = await put(shown(looked));
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.data.error!, /changed since you looked/);
  assert.equal((await catalogEntry(s, 'lib:github')).enabled, true);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['lib:github']);
  assert.equal((await audited(s, 'connector.disabled')).length, 0);
  // Reviewed again: the dialog now names that very turn, and turning it off with that view works.
  const again = await access(s, 'lib:github');
  const turnId = s.app.engine.turnOrigin(kevin.id)!.turnId;
  assert.deepEqual(again.running, [{ botId: kevin.id, name: 'Kevin', turnId }]);
  const off = await put(shown(again));
  assert.equal(off.status, 200, off.text);
  assert.deepEqual((off.data as ConnectorAccess).running, [{ botId: kevin.id, name: 'Kevin', turnId }]);
  await reply;
  await s.untilState(kevin.id, 'idle');
  assert.deepEqual((await access(s, 'lib:github')).running, []);

  // A turn the owner was shown that has ended since is fine: what they were told still covers all that keeps it.
  s.claude.script({ fixture: 'claude/reply', delayMs: 1500 });
  await power(s, 'lib:github', true);
  const second = s.send(kevin.id, 'Again, slowly');
  await until(() => s.claude.calls().length === 1);
  const during = await access(s, 'lib:github');
  assert.equal(during.running.length, 1);
  assert.notEqual(during.running[0].turnId, turnId, 'a new turn of the same Boton is another turn');
  await second;
  await s.untilState(kevin.id, 'idle');
  assert.equal((await put(shown(during))).status, 200);

  // Off and on again by someone else since the owner looked: what they were shown is still exactly true, so it goes.
  await power(s, 'lib:github', true);
  const before = await access(s, 'lib:github');
  await power(s, 'lib:github', false);
  await power(s, 'lib:github', true);
  assert.equal((await put(shown(before))).status, 200);
  assert.equal((await catalogEntry(s, 'lib:github')).enabled, false);

  // Resolved while on, then turned off before its CLI started: the engine checks again and leaves it out.
  await power(s, 'lib:github', true);
  const resolve = s.app.connectors.resolve.bind(s.app.connectors);
  s.app.connectors.resolve = async (...args) => {
    const out = await resolve(...args);
    s.app.connectors.setEnabled('lib:github', false);
    return out;
  };
  try {
    s.claude.script('claude/reply');
    await s.chat(kevin.id, 'Quick one');
  } finally {
    s.app.connectors.resolve = resolve;
  }
  const quick = s.claude.calls()[0];
  assert.deepEqual(serversOf(quick), []);
  assert.ok(quick.stdin.includes(`- lib:github: ${OFF_REASON}`) && !/Your connectors \(MCP servers[^\n]*\n- github/.test(quick.stdin));
});

test('a feed poll in flight when it is turned off (or off and on) is dropped whole; on again it goes on from the saved cursor', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  fake.events.push(feedEvent(1, 'jobold0001', 'turn_finished', 'idle', 'idle', { reason: 'completed' }), feedEvent(2, 'jobold0001', 'turn_finished', 'idle', 'idle'));
  await signIn(s, fake, c.id);
  await until(() => s.app.oauth.feedState(c.id).ready);
  const feed = s.app.workFeed;
  const kevin = s.storeBot('Kevin', 'claude-cli', { connections: ['oauth:fleet'] });
  s.claude.script('claude/work-start');
  await s.chat(kevin.id, 'Start the work');
  const k = 'jobkevin01';
  assert.equal(feed.ownerOf(c.id, k), kevin.id);
  s.claude.script('claude/reply');
  // A waking event for a job with no link yet, so a full poll would also look the job up with work_status.
  fake.attention = [];
  fake.jobs[k] = { state: 'cancelled', link: 't3-thread://v1/thr-kevin' };
  fake.events.push(feedEvent(3, k, 'state_changed', 'running', 'cancelled', { reason: 'interrupted' }));
  const work = async () => (await s.messagesOf(kevin.id)).filter((m) => m.meta?.kind === 'work.event').map((m) => m.meta!.work!);
  const cursor = () => s.app.oauth.feedState(c.id).cursor;
  assert.equal(cursor(), '"2"');

  /** Holds a poll's work_feed request at the gateway, does `meanwhile`, then lets the gateway answer. */
  const heldPoll = async (meanwhile: () => Promise<void>) => {
    const hold = fake.holdFeed();
    const polling = feed.tick(c.id);
    await hold.called;
    await meanwhile();
    const before = { mcp: fake.mcpCalls.length, status: fake.statusCalls.length };
    hold.release();
    const r = await polling;
    return { r, after: { mcp: fake.mcpCalls.length - before.mcp, status: fake.statusCalls.length - before.status } };
  };

  // Turned off while the gateway is answering: its answer (200) is dropped, nothing after it is asked.
  let held = await heldPoll(async () => assert.equal((await power(s, 'oauth:fleet', false)).status, 200));
  assert.deepEqual(held.r, { delivered: 0, held: 0 });
  assert.deepEqual(held.after, { mcp: 0, status: 0 }, 'no lookups, pages or anything else after it went off');
  assert.equal(cursor(), '"2"', 'the cursor stays');
  assert.deepEqual(await work(), [], 'nothing delivered, no one woken');
  assert.equal(s.app.store.db.prepare('select count(*) as n from work_feed_held').get()!.n, 0);
  assert.equal(s.app.oauth.get(c.id).feedError, null, 'not a failure of the connector');

  // Off and on again while it answers: still a different spell, still dropped.
  assert.equal((await power(s, 'oauth:fleet', true)).status, 200);
  held = await heldPoll(async () => {
    assert.equal((await power(s, 'oauth:fleet', false)).status, 200);
    assert.equal((await power(s, 'oauth:fleet', true)).status, 200);
  });
  assert.deepEqual(held.r, { delivered: 0, held: 0 });
  assert.deepEqual(held.after, { mcp: 0, status: 0 });
  assert.equal(cursor(), '"2"');
  assert.deepEqual(await work(), []);

  // On: the next poll goes on from the saved cursor, and the event arrives exactly once.
  assert.deepEqual(await feed.tick(c.id), { delivered: 1, held: 0 });
  assert.equal(cursor(), '"3"');
  assert.deepEqual(
    (await work()).map((w) => [w.eventId, w.kind, w.link]),
    [['3', 'cancelled', 't3-thread://v1/thr-kevin']],
  );
  assert.deepEqual(await feed.tick(c.id), { delivered: 0, held: 0 });
  assert.equal((await work()).length, 1);
});

test('turned off while a turn waits on its OAuth token: the prompt, the notices and the CLI all go without it', async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['oauth:notes'] });
  // The token runs out before the turn would end, so resolving the turn's connectors refreshes it: held at the server.
  s.app.store.db.prepare('update oauth_connections set access_expires_at = ? where id = ?').run(new Date(Date.now() + 1000).toISOString(), notes.id);
  const refreshes = () => fake.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token').length;
  const release = fake.holdTokens('refresh_token');
  s.claude.script({ fixture: 'claude/reply', mcp: { call: { server: 'notes', tool: 'work_status', arguments: { jobId: 'job1' } } } });
  const reply = s.send(kevin.id, 'Check job1');
  await until(() => refreshes() === 1);
  const off = await power(s, 'oauth:notes', false);
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.data.running, [], 'no turn has it yet');
  release();
  await reply;
  await s.untilState(kevin.id, 'idle');

  const turn = s.claude.calls()[0];
  assert.deepEqual(serversOf(turn), [], 'the CLI got no server');
  assert.equal(fake.statusCalls.length, 0, 'no tool call reached the gateway');
  assert.ok(!/Your connectors \(MCP servers[^\n]*\n- notes/.test(turn.stdin), 'the prompt does not list it as one it has');
  assert.ok(turn.stdin.includes(`- oauth:notes: ${OFF_REASON}`), 'the prompt says why it goes without');
  const notices = await s.call<{ connectorId: string; reason: string }[]>('GET', `/api/bots/${kevin.id}/connector-notices`);
  assert.deepEqual(
    notices.data.map((n) => [n.connectorId, n.reason]),
    [['oauth:notes', OFF_REASON]],
  );
  assert.deepEqual((await access(s, 'oauth:notes')).running, []);
});


test('disable during discovery prevents initialization follow-up and every tools page', async () => {
  for (const phase of ['initialize', 'tools'] as const) {
    const { s, fake } = await setup();
    const c = await addConnector(s, fake);
    await signIn(s, fake, c.id);
    await until(() => s.app.oauth.feedState(c.id).ready);
    const cursor = s.app.oauth.feedState(c.id).cursor;
    const hold = phase === 'initialize' ? fake.holdInitialize() : fake.holdToolsList();
    const polling = s.app.workFeed.tick(c.id);
    try {
      await hold.listed;
      assert.equal((await power(s, 'oauth:fleet', false)).status, 200);
      const count = fake.mcpCalls.length;
      hold.release();
      assert.deepEqual(await polling, { delivered: 0, held: 0 });
      assert.equal(fake.mcpCalls.length, count, `${phase}: no authenticated follow-up after disable`);
      assert.equal(s.app.oauth.feedState(c.id).cursor, cursor);
    } finally {
      hold.release();
    }
  }
});

test('a retry that loses a disabled connector drops its captured recovery claim', async () => {
  const s = await startServer({ fakeClis: true });
  useTestCodexHome(s.cfg.home);
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'notes', transport: 'http', url: 'https://mcp.example.com/mcp' })).status, 201);
  const bot = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['lib:notes'] });
  s.claude.script('claude/reply');
  await s.chat(bot.id, 'Hello');
  s.app.connectors.recordStartup(bot.id, { notes: 'lib:notes' }, [{ name: 'notes', started: false, tools: null, reason: 'did not start' }]);
  const provider = s.app.providers.get('claude-cli')!;
  const run = provider.runTurn;
  let disabled = false;
  provider.runTurn = async function (this: typeof provider, req: Parameters<typeof run>[0]) {
    try {
      return await run.call(this, req);
    } catch (err) {
      if (!disabled) {
        disabled = true;
        assert.equal((await power(s, 'lib:notes', false)).status, 200);
      }
      throw err;
    }
  };
  try {
    s.claude.script('claude/missing-session', 'claude/reply');
    await s.chat(bot.id, 'Try again');
    const calls = s.claude.calls();
    assert.equal(calls.length, 2);
    const retry = calls[1];
    assert.deepEqual(serversOf(retry), []);
    assert.ok(retry.stdin.includes(OFF_REASON));
    assert.ok(!retry.stdin.includes('passed to this one again'), 'no recovery promise for a server this retry does not get');
  } finally {
    provider.runTurn = run;
  }
});
