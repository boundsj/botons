import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AuditEvent, ConnectorCatalog, ConnectorTest } from '../../shared/types.ts';
import { captureLogs } from '../src/log.ts';
import { addConnector, setup, signIn } from './oauth-helpers.ts';
import { freePort, startServer, tempDir, useTestCodexHome } from './helpers.ts';

// A plain MCP server on 127.0.0.1 for library http servers: records each request's headers and method.
const seen: { method: string; headers: IncomingHttpHeaders }[] = [];
let refuse = false;
/** tools/list echoes the request's credentials back: in a JSON-RPC error, or as tool names. */
let reflect: null | 'error' | 'tool' = null;
/** While set, tools/list waits for it; `arrived` is called when one does. */
let listHold: { done: Promise<void>; arrived: () => void } | null = null;
function holdList() {
  let release!: () => void;
  let arrived!: () => void;
  const listed = new Promise<void>((r) => (arrived = r));
  listHold = { done: new Promise<void>((r) => (release = r)), arrived };
  return {
    listed,
    release: () => {
      listHold = null;
      release();
    },
  };
}
const plain = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const msg = JSON.parse(body || '{}');
    seen.push({ method: msg.method, headers: req.headers });
    if (msg.method === 'tools/list' && listHold) {
      const held = listHold;
      held.arrived();
      await held.done;
    }
    const echoed = `key=${req.headers['x-api-key']} auth=${req.headers.authorization}`;
    if (msg.method === 'tools/list' && reflect) {
      const reply = reflect === 'error' ? { error: { code: -32602, message: `bad credentials: ${echoed}` } } : { result: { tools: [{ name: echoed, inputSchema: {} }, { name: `x${req.headers['x-api-key']}`, inputSchema: {} }] } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
      return;
    }
    if (refuse) {
      res.writeHead(401).end();
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      msg.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'search', inputSchema: {} }, { name: 'fetch\u0007page', inputSchema: {} }] }
          : null;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { message: 'no' } })}\n\n`);
  });
});
const plainPort = await freePort();
await new Promise<void>((r) => plain.listen(plainPort, '127.0.0.1', r));
after(() => plain.close());
const plainUrl = `http://127.0.0.1:${plainPort}/mcp`;

const testOf = async (s: { call: (m: string, p: string) => Promise<{ status: number; data: any; text: string }> }, id: string) => {
  const r = await s.call('POST', `/api/connectors/${encodeURIComponent(id)}/test`);
  assert.equal(r.status, 200, r.text);
  return r.data as ConnectorTest;
};

test('an OAuth connector test lists its tools with the token, calls none, and is audited without secrets', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  await signIn(s, fake, c.id);
  const before = (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'oauth:fleet')!;
  assert.equal(before.testable, true);
  assert.equal(before.lastTest, null);

  fake.mcpCalls.length = 0;
  const t = await testOf(s, 'oauth:fleet');
  assert.equal(t.outcome, 'reached', t.problem ?? '');
  assert.ok(t.toolCount >= 3, 'both pages of tools/list');
  assert.equal(t.tools.length, t.toolCount);
  assert.deepEqual([...new Set(fake.mcpCalls.map((m) => m.method))].sort(), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(fake.mcpCalls.every((m) => m.token), 'every MCP request carried the token');
  assert.match(t.scope, /checked only in a turn/);

  const after = (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'oauth:fleet')!;
  assert.deepEqual(after.lastTest, t);

  const audit = (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'connector.tested');
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details, { outcome: 'reached', tools: t.toolCount });
  const tokens = fake.mcpCalls.map((m) => m.token!);
  for (const tok of tokens) assert.ok(!JSON.stringify(audit).includes(tok));

  // A Boton can't test connectors, even its own.
  const bot = await s.newBot('Kevin');
  const boton = s.app.auth.mintBotonToken(bot.id).token;
  assert.equal((await s.call('POST', '/api/connectors/oauth%3Afleet/test', undefined, boton)).status, 403);

  // A token the server refuses is replaced once, as the work feed does.
  fake.revoked.add(tokens[0]);
  const again = await testOf(s, 'oauth:fleet');
  assert.equal(again.outcome, 'reached', again.problem ?? '');

  // Deleting the connector drops its result; one with the same name starts with none.
  assert.equal((await s.call('DELETE', `/api/oauth-connections/${c.id}`)).status, 200);
  await addConnector(s, fake);
  const fresh = (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'oauth:fleet')!;
  assert.equal(fresh.lastTest, null);
  assert.equal(fresh.testable, false, 'not signed in yet');
  const notSignedIn = await testOf(s, 'oauth:fleet');
  assert.equal(notSignedIn.outcome, 'untestable');
});

test('a library http server is tested through the outbound guard, with its saved headers', async () => {
  const s = await startServer({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
  const add = await s.call('POST', '/api/mcp-servers', { name: 'docs', transport: 'http', url: plainUrl, headers: { 'X-Api-Key': 'docs_secret_123', 'Mcp-Session-Id': 'forged' } });
  assert.equal(add.status, 201, add.text);
  seen.length = 0;
  const [t, same] = await Promise.all([testOf(s, 'lib:docs'), testOf(s, 'lib:docs')]);
  assert.deepEqual(same, t, 'one test at a time per connector');
  assert.equal(seen.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(t.outcome, 'reached', t.problem ?? '');
  assert.deepEqual(t.tools, ['search', 'fetchpage'], 'control characters dropped');
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((r) => r.headers['x-api-key'] === 'docs_secret_123'));
  assert.ok(seen.every((r) => r.headers['mcp-session-id'] !== 'forged'));
  assert.ok(!seen.some((r) => r.method === 'tools/call'));
  assert.ok(!JSON.stringify((await s.call('GET', '/api/connectors')).data).includes('docs_secret_123'));

  refuse = true;
  try {
    const refused = await testOf(s, 'lib:docs');
    assert.equal(refused.outcome, 'failed');
    assert.match(refused.problem ?? '', /refused the request \(401\)\. Check its API key or headers\./);
  } finally {
    refuse = false;
  }

  // Changing the server drops its last result: it may not be true of the new settings.
  assert.equal((await s.call('PATCH', '/api/mcp-servers/docs', { headers: { 'X-Api-Key': null } })).status, 200);
  const changed = (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'lib:docs')!;
  assert.equal(changed.lastTest, null);
});

test("the guard's limits are reported as not tested, not as a failure, and nothing is sent", async () => {
  const s = await startServer();
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'local', transport: 'http', url: plainUrl })).status, 201);
  seen.length = 0;
  const t = await testOf(s, 'lib:local');
  assert.equal(t.outcome, 'untestable');
  assert.match(t.problem ?? '', /^Won't connect: not HTTPS/);
  assert.match(t.scope, /BOTONS_OAUTH_ALLOW/);
  assert.equal(seen.length, 0);
});

test('stdio servers are answered with what their status rests on, running nothing', async () => {
  const home = tempDir('botons-connector-test-');
  useTestCodexHome(home);
  const s = await startServer({ home, fakeClis: true });
  const marker = join(home, 'ran');
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'tracker', transport: 'stdio', command: 'touch', args: [marker] })).status, 201);
  // Nothing looks up the CLIs' own servers any more.
  assert.equal((await s.call('POST', '/api/connectors/refresh')).status, 404);
  const catalog = (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data;
  // Besides the built-in browser, which the server runs itself.
  assert.deepEqual(catalog.connectors.filter((c) => !c.managed).map((c) => c.id), ['lib:tracker']);

  const calls = s.claude.calls().length + s.codex.calls().length;
  for (const id of ['lib:tracker']) {
    const t = await testOf(s, id);
    assert.equal(t.outcome, 'untestable', id);
    assert.equal(t.toolCount, 0);
    assert.equal(t.scope, catalog.connectors.find((c) => c.id === id)!.basis);
  }
  assert.equal(s.claude.calls().length + s.codex.calls().length, calls, 'no CLI was started');
  assert.deepEqual([...s.claude.mcpReads(), ...s.codex.mcpReads()], []);
  assert.equal(existsSync(marker), false, "the stdio server's command was not run");
  assert.equal((await s.call('POST', '/api/connectors/lib%3Anope/test')).status, 404);
});

test('a server that echoes the credentials back gets them into no result, log line, catalog or audit', async () => {
  const s = await startServer({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
  const headers = { 'X-Api-Key': 'x7q', Authorization: 'Bearer dummy_bearer_51e2' };
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'echo', transport: 'http', url: plainUrl, headers })).status, 201);
  const logs = captureLogs();
  try {
    reflect = 'error';
    const failed = await testOf(s, 'lib:echo');
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.problem ?? '', /bad credentials: key=\[redacted\] auth=\[redacted\]/);
    reflect = 'tool';
    const listed = await testOf(s, 'lib:echo');
    assert.equal(listed.outcome, 'reached', listed.problem ?? '');
    assert.deepEqual(listed.tools, ['key=[redacted] auth=[redacted]', 'x[redacted]']);
  } finally {
    reflect = null;
    logs.restore();
  }
  const out = JSON.stringify([logs.lines, (await s.call('GET', '/api/connectors')).data, (await s.call('GET', '/api/audit')).data]);
  assert.ok(logs.lines.some((l) => l.msg === 'a connector test failed'), 'the failure was logged');
  for (const secret of ['dummy_key_7f3a9c', 'dummy_bearer_51e2']) assert.ok(!out.includes(secret), secret);

  // The same for an OAuth connector's token.
  const { s: so, fake } = await setup();
  const c = await addConnector(so, fake);
  await signIn(so, fake, c.id);
  const oauthLogs = captureLogs();
  try {
    fake.opts.reflectToken = 'error';
    const failed = await testOf(so, 'oauth:fleet');
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.problem ?? '', /scope missing for \[redacted\]$/);
    fake.opts.reflectToken = 'tool';
    const listed = await testOf(so, 'oauth:fleet');
    assert.deepEqual(listed.tools, ['echo_[redacted]']);
  } finally {
    fake.opts.reflectToken = null;
    oauthLogs.restore();
  }
  const tokens = [...new Set(fake.mcpCalls.map((m) => m.token).filter((t): t is string => !!t))];
  assert.ok(tokens.length > 0);
  const oauthOut = JSON.stringify([oauthLogs.lines, (await so.call('GET', '/api/connectors')).data, (await so.call('GET', '/api/audit')).data]);
  for (const tok of tokens) assert.ok(!oauthOut.includes(tok));
});

test('a test that overlaps an edit of its server is not kept or reported as current', async () => {
  const s = await startServer({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'docs', transport: 'http', url: plainUrl })).status, 201);
  const hold = holdList();
  const running = testOf(s, 'lib:docs');
  await hold.listed;
  assert.equal((await s.call('PATCH', '/api/mcp-servers/docs', { headers: { 'X-Api-Key': 'dummy_new_key' } })).status, 200);
  hold.release();
  const t = await running;
  assert.equal(t.outcome, 'untestable');
  assert.match(t.problem ?? '', /changed, signed in again or removed while this test ran/);
  assert.deepEqual(t.tools, []);
  assert.equal((await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'lib:docs')!.lastTest, null);
  // The next test is of the new settings, and is kept.
  const next = await testOf(s, 'lib:docs');
  assert.equal(next.outcome, 'reached');
  assert.deepEqual((await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'lib:docs')!.lastTest, next);
});

test('signing an OAuth connector in again drops its last test, and a test of the earlier grant still running is not kept', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  await signIn(s, fake, c.id);
  const lastOf = async () => (await s.call<ConnectorCatalog>('GET', '/api/connectors')).data.connectors.find((x) => x.id === 'oauth:fleet')!.lastTest;

  assert.equal((await testOf(s, 'oauth:fleet')).outcome, 'reached');
  assert.ok(await lastOf());
  await signIn(s, fake, c.id);
  assert.equal(await lastOf(), null, 'a completed test of the earlier grant is dropped');

  const hold = fake.holdToolsList();
  const running = testOf(s, 'oauth:fleet');
  await hold.listed;
  await signIn(s, fake, c.id);
  hold.release();
  const t = await running;
  assert.equal(t.outcome, 'untestable');
  assert.match(t.problem ?? '', /signed in again/);
  assert.equal(await lastOf(), null, 'a test that ran under the earlier grant is not kept');
  assert.equal((await testOf(s, 'oauth:fleet')).outcome, 'reached');
  assert.ok(await lastOf());
});

// Expired token → a refresh that rotates both tokens → the MCP server refuses the new access token → the second
// refresh (with the rotated refresh token) is answered with an error that echoes a credential back.
for (const status of [400, 401]) {
  for (const echo of ['rotated', 'short', 'dotted', 'unrelated'] as const) {
    test(`a token endpoint echoing ${echo === 'unrelated' ? 'a token-shaped value' : `the ${echo} refresh token`} in a ${status} gets it into no log, saved error, catalog or API answer`, async () => {
      const { s, fake } = await setup();
      const c = await addConnector(s, fake);
      await signIn(s, fake, c.id);
      const initial = s.app.oauth.record(c.id)!;
      const sent: string[] = [];
      let rotated: { access_token: string; refresh_token: string } | null = null;
      const unrelated = 'dummyEchoedValue0123456789abcdef';
      const endpoint = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        sent.push(form.get('refresh_token') ?? '');
        if (sent.length === 1) {
          const r = await fetch(`${fake.issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
          const out = await r.json();
          if (echo === 'short') out.refresh_token = 'Q7Z';
          // Token-shaped before the dot, a plain word after it: a token-shaped pass alone would leave the word.
          if (echo === 'dotted') out.refresh_token = 'dummyRefresh0123456789.tailsecret';
          rotated = out;
          fake.revoked.add(out.access_token);
          res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
          return;
        }
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: echo === 'unrelated' ? unrelated : form.get('refresh_token'), error_description: `bad ${form.get('refresh_token')}` }));
      });
      const port = await freePort();
      await new Promise<void>((r) => endpoint.listen(port, '127.0.0.1', r));
      try {
        s.app.store.db
          .prepare('update oauth_connections set as_metadata = ?, access_expires_at = ? where id = ?')
          .run(JSON.stringify({ ...initial.metadata, token_endpoint: `http://127.0.0.1:${port}/token` }), new Date(Date.now() - 1000).toISOString(), c.id);
        const logs = captureLogs();
        let t: ConnectorTest;
        let surfaces: unknown[];
        try {
          t = await testOf(s, 'oauth:fleet');
          surfaces = [
            (await s.call('GET', '/api/connectors')).data,
            (await s.call('GET', '/api/oauth-connections')).data,
            (await s.call('GET', '/api/audit')).data,
            s.app.store.db.prepare('select status_reason, refresh_error, feed_error from oauth_connections where id = ?').get(c.id),
          ];
        } finally {
          logs.restore();
        }
        assert.ok(rotated, 'the first refresh rotated the tokens');
        const r = rotated as { access_token: string; refresh_token: string };
        assert.deepEqual(sent, [initial.refreshToken, r.refresh_token], 'the second refresh sent the rotated refresh token');
        assert.ok(fake.mcpCalls.some((m) => m.token === r.access_token), 'the MCP server was sent the new access token');
        assert.equal(t.outcome, 'failed');
        if (status === 401) assert.equal(s.app.oauth.record(c.id)!.refreshToken, null, 'a refused grant is cleared');
        const failure = logs.lines.find((l) => /^OAuth refresh (refused|failed)/.test(String(l.msg)));
        assert.ok(failure, 'the refresh failure was logged');
        const all = JSON.stringify([t, surfaces, logs.lines]);
        for (const secret of [initial.accessToken!, initial.refreshToken!, r.access_token, r.refresh_token, unrelated]) assert.ok(!all.includes(secret), `${secret} leaked`);
        // Every piece of the rotated refresh token, not only the whole of it.
        for (const piece of r.refresh_token.split(/[^A-Za-z0-9]+/).filter((x) => x.length >= 8)) assert.ok(!all.includes(piece), `the piece ${piece} of the refresh token leaked`);
        assert.match(all, /refused the (grant|token request) \(\d+(: \[redacted\])?\)/, 'the error says what happened, without the credential');
      } finally {
        await new Promise((r) => endpoint.close(r));
      }
    });
  }
}

test('a control character in an echoed error cannot carry part of a credential past the cut', async () => {
  // No digit in the first 30 characters, so a cut piece of it doesn't look like a token on its own.
  const secret = 'AbCdEfGhJkLmNpQrStUvWxYzAbCdEfGhJkLmNpQ7';
  const endpoint = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const m = JSON.parse(body);
    if (m.id === undefined) return void res.writeHead(202).end();
    const answer =
      m.method === 'initialize'
        ? { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }
        : { error: { message: `${' '.repeat(170)}${secret.slice(0, 5)}\u0000${secret.slice(5)}` } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...answer }));
  });
  const port = await freePort();
  await new Promise<void>((r) => endpoint.listen(port, '127.0.0.1', r));
  try {
    const s = await startServer({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
    assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'split', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { 'X-Api-Key': secret } })).status, 201);
    const logs = captureLogs();
    let surfaces: unknown[];
    try {
      const t = await testOf(s, 'lib:split');
      assert.equal(t.outcome, 'failed');
      assert.match(t.problem ?? '', /\[redacted\]/);
      surfaces = [t, (await s.call('GET', '/api/connectors')).data, (await s.call('GET', '/api/audit')).data, logs.lines];
    } finally {
      logs.restore();
    }
    const all = JSON.stringify(surfaces);
    for (let n = 8; n <= secret.length; n++) assert.ok(!all.includes(secret.slice(0, n)) && !all.includes(secret.slice(5, 5 + n)), `a ${n}-character piece leaked`);
  } finally {
    await new Promise((r) => endpoint.close(r));
  }
});

test("a saved error is shown without the connection's current tokens, however short", async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  await signIn(s, fake, c.id);
  s.app.store.db
    .prepare('update oauth_connections set access_token = ?, refresh_token = ?, refresh_error = ?, feed_error = ?, status_reason = ? where id = ?')
    .run('k3v', 'Q7Z', 'the issuer refused the token request (400: Q7Z)', 'feed answered k3v', 'was Q7Z', c.id);
  const out = JSON.stringify([(await s.call('GET', '/api/oauth-connections')).data, (await s.call('GET', '/api/connectors')).data]);
  assert.match(out, /refused the token request \(400: \[redacted\]\)/);
  assert.match(out, /feed answered \[redacted\]/);
  for (const tok of ['Q7Z', 'k3v']) assert.ok(!out.includes(tok), tok);
});
