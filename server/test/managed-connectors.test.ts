// Every connector is Botons' own. A Boton keeps the same one whichever brain it runs on, the turn's CLI gets it
// passed in (never from its own MCP setup, which nothing reads), and one a turn goes without is shown to the owner.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Bot, ConnectorNotice } from '../../shared/types.ts';
import type { Call, FakeCli } from './fixtures/fake-cli.ts';
import { startServer, tempDir, type TestServer, useTestCodexHome } from './helpers.ts';
import { addConnector, setup, signIn } from './oauth-helpers.ts';
import { sameAddress } from '../src/connectors.ts';

const src = join(import.meta.dirname, '../src');

type Clis = TestServer & { claude: FakeCli; codex: FakeCli };

async function turnOf(s: Clis, cli: FakeCli, bot: Bot, text = 'Find the onboarding page.'): Promise<Call> {
  cli.script(`${cli === s.claude ? 'claude' : 'codex'}/reply`);
  const reply = await s.chat(bot.id, text);
  assert.equal(reply.role, 'bot', reply.text);
  const calls = cli.calls();
  assert.equal(calls.length, 1);
  return calls[0];
}

const noticesOf = async (s: TestServer, botId: string) => {
  const r = await s.call<ConnectorNotice[]>('GET', `/api/bots/${botId}/connector-notices`);
  assert.equal(r.status, 200, r.text);
  return r.data;
};

test("no code in the server reads a provider CLI's own MCP setup", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const reads = [
    /['"]mcp['"]\s*,\s*['"](list|get|login)['"]/, // `claude mcp list`, `codex mcp list`
    /\bmcp_status\b/, // Claude Code's control request for its servers
    /--input-format/, // the control protocol that asks it
    /['"]user,project,local['"]|setting-sources['"]\s*,\s*['"]user/, // Claude Code with the user's own settings
    /claudeai-proxy/,
    /\bconfig\.toml\b|\.mcp\.json\b/,
    /discoverConnectors|discovered_connectors/,
  ];
  const found: string[] = [];
  for (const f of files(src)) {
    const text = readFileSync(f, 'utf8');
    // The schema's upgrade drops the table the lookups were kept in: that is its only mention.
    for (const re of reads) if (re.test(f.endsWith('schema.ts') ? text.replace(/discovered_connectors/g, '') : text)) found.push(`${relative(src, f)}: ${re}`);
  }
  assert.deepEqual(found, []);
});

test('a signed-in connector reaches both brains the same way, the CLIs are never asked for their own servers, and switching brains keeps it', async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  assert.equal((await s.call('POST', '/api/connectors/refresh')).status, 404);

  const kevin = await s.newBot('Kevin', { provider: 'codex-cli', connections: ['oauth:notes'] });
  const onCodex = await turnOf(s, s.codex, kevin);
  assert.ok(onCodex.argv.includes(`mcp_servers.notes.url=${JSON.stringify(fake.mcpUrl)}`), onCodex.argv.join(' '));
  assert.ok(onCodex.argv.includes('--ignore-user-config'));
  const header = onCodex.argv.find((a) => a.startsWith('mcp_servers.notes.env_http_headers='))!;
  const envName = /"Authorization"="(BOTONS_MCP_\d+_\d+)"/.exec(header)![1];
  const token = onCodex.env[envName];
  assert.match(token, /^Bearer \S+/);
  assert.match(onCodex.stdin, /Your connectors[^\n]*\n- notes\n/);

  // Its Codex session ends with the move: the owner confirms what the preview shows.
  const { confirmation } = (await s.call('POST', `/api/bots/${kevin.id}/switch-preview`, { provider: 'claude-cli' })).data;
  const moved = await s.call<Bot>('PATCH', `/api/bots/${kevin.id}`, { provider: 'claude-cli', switchConfirmation: confirmation });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual(moved.data.connections, ['oauth:notes']);
  const onClaude = await turnOf(s, s.claude, kevin);
  assert.ok(onClaude.argv.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(onClaude.mcpConfigFile!).mcpServers.notes, { type: 'http', url: fake.mcpUrl, headers: { Authorization: token } });
  assert.match(onClaude.stdin, /Your connectors[^\n]*\n- notes\n/);

  assert.deepEqual([...s.claude.mcpReads(), ...s.codex.mcpReads()], []);
  assert.deepEqual(await noticesOf(s, kevin.id), []);
});

test("a connector a turn goes without is shown to the owner with why, and the Boton's turn says so; it clears once the turn gets it", async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const linear = await addConnector(s, fake, 'linear');
  const dave = await s.newBot('Dave', { provider: 'claude-cli', connections: ['oauth:linear'] });
  // An id that isn't a Botons connector (left by hand, say) is skipped and said so too.
  s.app.store.db.prepare('update bots set connections = ? where id = ?').run(JSON.stringify(['oauth:linear', 'codex:wiki']), dave.id);

  const first = await turnOf(s, s.claude, dave);
  assert.deepEqual(JSON.parse(first.mcpConfigFile ?? '{"mcpServers":{}}').mcpServers, {});
  assert.match(first.stdin, /Connectors you have that this turn goes without \([^)]* sees this in your settings[^\n]*\n- oauth:linear: needs signing in again\n- codex:wiki: not a Botons connector/);
  const notices = await noticesOf(s, dave.id);
  assert.deepEqual(
    notices.map((n) => [n.connectorId, n.kind, n.name, n.reason, n.offer]).sort(),
    [
      ['codex:wiki', 'skipped', 'wiki', 'not a Botons connector (add it in Settings → Connectors)', null],
      ['oauth:linear', 'skipped', 'linear', 'needs signing in again', null],
    ],
  );

  // Signed in, and the stray id taken off: the next turn has it, and nothing is left to show.
  await signIn(s, fake, linear.id);
  assert.equal((await s.call('PATCH', `/api/bots/${dave.id}`, { connections: ['oauth:linear'] })).status, 200);
  const second = await turnOf(s, s.claude, dave);
  assert.deepEqual(Object.keys(JSON.parse(second.mcpConfigFile!).mcpServers), ['linear']);
  assert.ok(!second.stdin.includes('goes without'));
  assert.deepEqual(await noticesOf(s, dave.id), []);

  // Only the owner's devices see or dismiss notices.
  const boton = s.app.auth.mintBotonToken(dave.id);
  try {
    assert.equal((await s.call('GET', `/api/bots/${dave.id}/connector-notices`, undefined, boton.token)).status, 403);
  } finally {
    boton.revoke();
  }
});

test("an upgrade turns a Boton's codex:notes into a notice offering oauth:notes; nothing is granted until the owner chooses", async () => {
  const home = tempDir('botons-managed-upgrade-');
  useTestCodexHome(home);
  const now = '2026-11-06T09:00:00.000Z';
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec(`${readFileSync(join(import.meta.dirname, 'fixtures/schema-22.sql'), 'utf8')}\npragma user_version = 22;`);
  db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
  const bot = db.prepare("insert into bots (id, name, look, provider, timezone, workspace, created_at, updated_at, last_activity_at, connections) values (?, ?, '{}', ?, 'UTC', ?, ?, ?, ?, ?)");
  bot.run('bot_kevin', 'Kevin', 'claude-cli', 'kevin', now, now, now, '["codex:notes"]');
  bot.run('bot_stuart', 'Stuart', 'codex-cli', 'stuart', now, now, now, '["claude:docs","lib:wiki"]');
  bot.run('bot_bob', 'Bob', 'codex-cli', 'bob', now, now, now, '["codex:tracker"]');
  bot.run('bot_dave', 'Dave', 'claude-cli', 'dave', now, now, now, '["claude:team","lib:teama"]');
  db.prepare("insert into discovered_connectors (provider, checked_at, servers) values ('claude-cli', ?, ?)").run(
    now,
    JSON.stringify([
      { name: 'docs', status: 'ok', note: null, config: { type: 'http', url: 'https://docs.example.com/mcp' } },
      { name: 'team', status: 'ok', note: null, config: { type: 'http', url: 'https://mcp.example.com/TeamA?view=1' } },
    ]),
  );
  db.prepare("insert into oauth_connections (id, name, url, status, created_at, updated_at) values ('oac_1', 'notes', 'https://mcp.notes.example.com/mcp', 'connected', ?, ?)").run(now, now);
  db.prepare("insert into mcp_servers (name, transport, url, created_at, updated_at) values ('handbook', 'http', 'https://DOCS.Example.com:443/mcp', ?, ?), ('wiki', 'http', 'https://wiki.example.com/mcp', ?, ?), ('teama', 'http', 'https://mcp.example.com/teama', ?, ?)").run(now, now, now, now, now, now);
  db.close();

  const s = await startServer({ home, fakeClis: true });
  assert.equal(readdirSync(join(home, 'backups')).length, 1, 'backed up before the upgrade');

  // By name, then by address; one with no match says how to get it back. None is granted.
  const kevin = await noticesOf(s, 'bot_kevin');
  assert.deepEqual(
    kevin.map((n) => ({ id: n.connectorId, kind: n.kind, name: n.name, offer: n.offer?.id ?? null })),
    [{ id: 'codex:notes', kind: 'removed', name: 'notes', offer: 'oauth:notes' }],
  );
  assert.match(kevin[0].reason, /no longer uses MCP servers from Codex's own settings/);
  // An address matches whatever the case of its scheme and host and with its default port, but a path in another case is another server.
  assert.equal((await noticesOf(s, 'bot_stuart'))[0].offer?.id, 'lib:handbook');
  // Dave has /teama: it is not what he lost (/TeamA), so it is not offered, and his notice stays.
  const dave = await noticesOf(s, 'bot_dave');
  assert.deepEqual(dave.map((n) => [n.connectorId, n.target, n.offer]), [['claude:team', 'https://mcp.example.com/TeamA', null]]);
  assert.deepEqual((await noticesOf(s, 'bot_dave')).map((n) => n.connectorId), ['claude:team'], 'reading it did not dismiss it');
  assert.deepEqual((await s.call<Bot>('GET', '/api/bots/bot_dave')).data.connections, ['lib:teama']);
  s.app.store.db.prepare("update mcp_servers set url = 'https://mcp.example.com/TeamA/' where name = 'teama'").run();
  const trailing = await noticesOf(s, 'bot_dave');
  assert.equal(trailing[0].offer, null, 'a trailing slash identifies a different endpoint');
  assert.deepEqual((await noticesOf(s, 'bot_dave')).map((n) => n.connectorId), ['claude:team'], 'the distinct endpoint cannot dismiss the loss');
  assert.deepEqual((await noticesOf(s, 'bot_bob')).map((n) => [n.connectorId, n.offer]), [['codex:tracker', null]]);
  for (const id of ['bot_kevin', 'bot_bob']) assert.deepEqual((await s.call<Bot>('GET', `/api/bots/${id}`)).data.connections, []);
  assert.deepEqual((await s.call<Bot>('GET', `/api/bots/${'bot_stuart'}`)).data.connections, ['lib:wiki']);

  // The Boton's turn is told too, and it is never silent.
  if (process.platform !== 'linux') s.app.store.updateBot('bot_kevin', { access: 'host' }, s.app.providers.ids());
  const told = await turnOf(s, s.claude, s.app.store.getBot('bot_kevin'));
  assert.match(told.stdin, /Connectors taken off you because Botons no longer uses[^\n]*: notes\n/);

  // The owner gives Kevin the offer: the notice is done. Bob's is dismissed.
  assert.equal((await s.call('PATCH', '/api/bots/bot_kevin', { connections: ['oauth:notes'] })).status, 200);
  assert.deepEqual(await noticesOf(s, 'bot_kevin'), []);
  assert.equal((await s.call('DELETE', '/api/bots/bot_bob/connector-notices/codex:tracker')).status, 200);
  assert.equal((await s.call('DELETE', '/api/bots/bot_bob/connector-notices/codex:tracker')).status, 404);
  assert.deepEqual(await noticesOf(s, 'bot_bob'), []);
  assert.deepEqual([...s.claude.mcpReads(), ...s.codex.mcpReads()], []);
});

test("a token refresh error a turn goes without is kept and shown without the connector's credentials", async (t) => {
  const { s, fake } = await setup();
  const wiki = await addConnector(s, fake, 'wiki');
  await signIn(s, fake, wiki.id);
  const rec = s.app.oauth.record(wiki.id)!;
  assert.ok(rec.accessToken && rec.refreshToken);
  // A token endpoint that echoes what it was sent, and a short credential no shape check would catch.
  const oauth = s.app.connectors.oauth;
  const real = oauth.accessToken.bind(oauth);
  t.after(() => (oauth.accessToken = real));
  oauth.accessToken = async () => {
    throw new Error(`upstream said: bad refresh_token=${rec.refreshToken} for ${rec.accessToken}`);
  };
  const bob = await s.newBot('Bob', { provider: 'claude-cli', connections: ['oauth:wiki'] });
  const c = await turnOf(s, s.claude, bob);
  const [notice] = await noticesOf(s, bob.id);
  assert.match(notice.reason, /^its token could not be refreshed \(upstream said: bad refresh_token=/);
  for (const text of [notice.reason, c.stdin, JSON.stringify(s.app.store.db.prepare('select * from connector_notices').all())]) {
    assert.ok(!text.includes(rec.refreshToken!) && !text.includes(rec.accessToken!), text);
  }
});

test('an address is the same server when its scheme, host and default port differ only as URLs allow, never when its path differs in case', () => {
  const same: [string, string][] = [
    ['https://MCP.Example.com/TeamA', 'https://mcp.example.com/TeamA'],
    ['HTTPS://mcp.example.com:443/TeamA', 'https://mcp.example.com/TeamA'],
    ['https://mcp.example.com/TeamA?view=1#top', 'https://mcp.example.com/TeamA'],
    ['not a url/Path?x', 'not a url/Path'],
  ];
  const other: [string, string][] = [
    ['https://mcp.example.com/TeamA', 'https://mcp.example.com/TeamA/'],
    ['not a url/Path/', 'not a url/Path'],
    ['https://mcp.example.com/TeamA', 'https://mcp.example.com/teama'],
    ['https://mcp.example.com/TeamA', 'http://mcp.example.com/TeamA'],
    ['https://mcp.example.com:8443/TeamA', 'https://mcp.example.com/TeamA'],
    ['https://mcp.example.com/TeamA', 'https://mcp.example.com/TeamA/sub'],
    ['not a url/Path', 'not a url/path'],
  ];
  for (const [a, b] of same) assert.ok(sameAddress(a, b) && sameAddress(b, a), `${a} = ${b}`);
  for (const [a, b] of other) assert.ok(!sameAddress(a, b) && !sameAddress(b, a), `${a} != ${b}`);
});
