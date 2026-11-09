import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AuditEvent, ConnectorAccess } from '../../shared/types.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import { sandboxBinary } from '../src/sandbox.ts';
import { startServer, tempDir, useTestCodexHome } from './helpers.ts';

const home = tempDir('botons-connector-access-');
useTestCodexHome(home);
const s = await startServer({ home, fakeClis: true });
const { app, call } = s;

const bwrap = sandboxBinary();
const noBwrap = 'problem' in bwrap ? `bubblewrap can't run here: ${bwrap.problem}` : false;

const SECRET = 'ghp_access_test_secret_789';

await call('POST', '/api/mcp-servers', { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: SECRET } });
await call('POST', '/api/mcp-servers', { name: 'my_docs', transport: 'http', url: 'https://mcp.example.com/mcp' });
const kevin = await s.newBot('Kevin', { provider: 'claude-cli' });
const stuart = await s.newBot('Stuart', { provider: 'codex-cli' });
const bob = await s.newBot('Bob'); // the mock brain: no connectors
const dave = await s.newBot('Dave', { provider: 'claude-cli', connections: ['lib:github'] });

const access = async (id: string) => {
  const r = await call<ConnectorAccess>('GET', `/api/connectors/${encodeURIComponent(id)}/access`);
  assert.equal(r.status, 200, r.text);
  return r.data;
};
const put = (id: string, botIds: string[], expected: string[], token?: string) =>
  call<ConnectorAccess & { error?: string }>('PUT', `/api/connectors/${encodeURIComponent(id)}/access`, { botIds, expected }, token);
const row = (a: ConnectorAccess, botId: string) => a.botons.find((m) => m.botId === botId)!;

test('a connector shows exactly which Botons have it, may ask for it, or cannot use it, and never its secrets', async () => {
  await call('PATCH', '/api/connectors/lib:github/policy', { onRequest: true, grant: 'approval' });
  const a = await access('lib:github');
  assert.equal(a.name, 'github');
  assert.equal(a.managed, false);
  assert.deepEqual(
    a.botons.filter((m) => m.has).map((m) => m.name),
    ['Dave'],
  );
  assert.equal(row(a, kevin.id).mayAsk, true);
  assert.equal(row(a, stuart.id).mayAsk, true);
  assert.deepEqual([row(a, bob.id).brainCanUse, row(a, bob.id).mayAsk], [false, false]);
  assert.ok(!JSON.stringify(a).includes(SECRET));
  assert.equal((await call('GET', '/api/connectors/lib:nothing/access')).status, 404);
});

test('the owner sets who has a connector from the connector: exactly, at once, audited per Boton, and turns get it', async () => {
  const r = await put('lib:github', [kevin.id, stuart.id], [dave.id]);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    r.data.botons.filter((m) => m.has).map((m) => m.name),
    ['Kevin', 'Stuart'],
  );
  assert.deepEqual(app.store.getBot(dave.id).connections, []);
  assert.deepEqual(app.store.getBot(kevin.id).connections, ['lib:github']);

  // The next turn on Kevin's brain gets it, with its secret only there.
  // (A local connector starts in the Workspace sandbox, so where bubblewrap can't run it is left out instead.)
  const resolved = await app.connectors.resolve(app.store.getBot(kevin.id).connections, app.providers.get('claude-cli'), { launch: { apart: [s.cfg.home], hidden: [], dir: app.connectors.launchDir } });
  app.connectors.release(resolved);
  assert.deepEqual(
    [...resolved.servers.map((x) => x.name), ...resolved.skipped.map((x) => (/^not started: a local connector starts only in the Workspace sandbox/.test(x.reason) ? 'github' : x.reason))],
    ['github'],
  );

  // Each change is the Boton's own audited grant change, and the connector's history has them and its setup.
  const audit = (await call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'boton.permissions_changed');
  assert.deepEqual(audit.find((e) => e.target?.id === dave.id)?.details, { connectionsRemoved: ['lib:github'], via: 'connector' });
  assert.deepEqual(audit.find((e) => e.target?.id === kevin.id)?.details, { connectionsAdded: ['lib:github'], via: 'connector' });
  const history = r.data.history.map((e) => `${e.action}:${e.target?.id}`);
  for (const want of [`boton.permissions_changed:${kevin.id}`, `boton.permissions_changed:${dave.id}`, 'connector.policy_changed:lib:github', 'mcp_server.created:github', `boton.created:${dave.id}`]) {
    assert.ok(history.includes(want), `${want} in ${history.join(', ')}`);
  }
  // Another connector's events are not in it, even one whose name is like it.
  assert.ok(!(await access('lib:my_docs')).history.some((e) => e.target?.id === 'github' || e.target?.id === dave.id));
  assert.ok(!JSON.stringify(r.data.history).includes(SECRET));
});

test('a stale view, an unknown Boton, a brain without connectors and the managed browser change nothing', async () => {
  const before = app.store.listBots().map((b) => [b.id, b.connections]);
  const stale = await put('lib:github', [dave.id], [dave.id]);
  assert.equal(stale.status, 409);
  assert.match(stale.data.error!, /changed since you looked/);
  assert.equal((await put('lib:github', [kevin.id, stuart.id, bob.id], [kevin.id, stuart.id])).status, 400);
  assert.equal((await put('lib:github', ['nobody'], [kevin.id, stuart.id])).status, 400);
  assert.equal((await call('PUT', '/api/connectors/lib:github/access', { botIds: 'all', expected: [] })).status, 400);
  const browser = await put(BROWSER_CONNECTOR, [kevin.id], []);
  assert.equal(browser.status, 400);
  assert.match(browser.data.error!, /Boton's settings/);
  assert.equal((await access(BROWSER_CONNECTOR)).managed, true);
  assert.deepEqual(
    app.store.listBots().map((b) => [b.id, b.connections]),
    before,
  );
});

test('only paired devices see or set it: a Boton cannot grant itself a connector', async () => {
  const token = app.auth.mintBotonToken(dave.id).token;
  assert.equal((await put('lib:github', [kevin.id, stuart.id, dave.id], [kevin.id, stuart.id], token)).status, 403);
  assert.equal((await call('GET', '/api/connectors/lib:github/access', undefined, token)).status, 403);
  assert.deepEqual(app.store.getBot(dave.id).connections, []);
});

test('taking it off every Boton revokes it, and a turn that went without it says why', async () => {
  app.connectors.recordTurn(kevin.id, { skipped: [{ id: 'lib:github', reason: 'its CLI could not start it' }], ids: {} });
  assert.equal(row(await access('lib:github'), kevin.id).withoutReason, 'its CLI could not start it');
  const r = await put('lib:github', [], [kevin.id, stuart.id]);
  assert.equal(r.status, 200);
  assert.ok(r.data.botons.every((m) => !m.has));
  assert.ok(app.store.listBots().every((b) => !b.connections.includes('lib:github')));
});

test("an OAuth connector's history follows its sign-in record, and one not signed in can still be given (its turns go without it until then)", async () => {
  const created = await call<{ id: string; error?: string }>('POST', '/api/oauth-connections', { name: 'fleet', url: 'https://mcp.example.com/fleet' });
  assert.equal(created.status, 201, created.text);
  const a = await access('oauth:fleet');
  assert.ok(a.history.some((e) => e.action === 'oauth.created' && e.target?.id === created.data.id));
  const r = await put('oauth:fleet', [stuart.id], []);
  assert.equal(r.status, 200, r.text);
  const resolved = await app.connectors.resolve(app.store.getBot(stuart.id).connections, app.providers.get('codex-cli'));
  assert.deepEqual(resolved.servers, []);
  assert.equal(resolved.skipped[0]?.id, 'oauth:fleet');
});


test('connector history projects combined permission events without changing the global audit', async () => {
  const details = { connectionsAdded: ['lib:github', 'lib:my_docs'], skillsAdded: ['unrelated-skill'], askFirstAdded: ['unrelated-rule'] };
  app.audit.record({ kind: 'host', id: null, label: 'Server machine' }, { action: 'boton.permissions_changed', target: { kind: 'boton', id: kevin.id, label: 'Kevin' }, details });
  const globalEvent: AuditEvent | undefined = (await call<AuditEvent[]>('GET', '/api/audit')).data.find((e) => e.target?.id === kevin.id && Array.isArray(e.details.skillsAdded) && e.details.skillsAdded.includes('unrelated-skill'));
  assert.deepEqual(globalEvent?.details, details);
  for (const id of ['lib:github', 'lib:my_docs']) {
    const projected: AuditEvent | undefined = (await access(id)).history.find((e) => e.seq === globalEvent?.seq);
    assert.deepEqual(projected?.details, { connectionsAdded: [id] });
  }
  app.audit.record({ kind: 'host', id: null, label: 'Server machine' }, { action: 'boton.permissions_changed', target: { kind: 'boton', id: kevin.id }, details: { skillsAdded: ['lib:github'] } });
  const unrelated = (await call<AuditEvent[]>('GET', '/api/audit')).data[0];
  assert.ok(!(await access('lib:github')).history.some((e) => e.seq === unrelated.seq), 'only connector-specific fields establish relevance');
});

test("a turn whose setup fails after its connectors are resolved still removes their launch files", { skip: noBwrap }, async () => {
  const bot = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['lib:github'] });
  // Its workspace can't be made (a file in its place), right after the connectors were resolved.
  const ws = app.store.getBot(bot.id).workspace;
  rmSync(ws, { recursive: true, force: true });
  writeFileSync(ws, 'not a folder');
  const resolve = app.connectors.resolve.bind(app.connectors);
  const handed: string[] = [];
  app.connectors.resolve = async (...a) => {
    const got = await resolve(...a);
    handed.push(...(got.launchFiles ?? []));
    return got;
  };
  try {
    const reply = await s.chat(bot.id, 'hello');
    assert.equal(reply.role, 'error');
  } finally {
    app.connectors.resolve = resolve;
  }
  assert.equal(handed.length, 1, 'the turn had a launch file');
  assert.ok(!existsSync(handed[0]!));
  assert.deepEqual(readdirSync(app.connectors.launchDir).filter((f) => f.startsWith('launch-')), []);
});
