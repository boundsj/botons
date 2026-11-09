import assert from 'node:assert/strict';
import { cpSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OAuthConnection, OAuthConnectStart } from '../../shared/types.ts';
import { loadConfig } from '../src/config.ts';
import { bearerChallenge, canonicalResource, resourceMetadataUrls, serverMetadataUrls } from '../src/oauth.ts';
import { refusedOutbound } from '../src/outbound.ts';
import { claudeMcpTool, claudeToolResult } from '../src/providers/claude-cli.ts';
import { codexToolResult } from '../src/providers/codex-cli.ts';
import { approvedPairing, failOnEscapedErrors, startServer, tempDir, until, useTestCodexHome } from './helpers.ts';
import { addConnector, OAUTH_ENV, OAUTH_HOST, setup, signIn, start, viaProxy } from './oauth-helpers.ts';

failOnEscapedErrors();
useTestCodexHome(tempDir('botons-oauth-codex-'));

test('helpers: canonical resources, path-aware well-known URLs, the bearer challenge, and what may be reached', () => {
  assert.equal(canonicalResource('HTTPS://MCP.Example.com/mcp/#x'), 'https://mcp.example.com/mcp');
  assert.deepEqual(resourceMetadataUrls('https://gw.example.com/mcp'), ['https://gw.example.com/.well-known/oauth-protected-resource/mcp', 'https://gw.example.com/.well-known/oauth-protected-resource']);
  assert.deepEqual(serverMetadataUrls('https://auth.example.com/tenant1'), [
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    'https://auth.example.com/.well-known/openid-configuration/tenant1',
    'https://auth.example.com/tenant1/.well-known/openid-configuration',
  ]);
  assert.deepEqual(serverMetadataUrls('https://auth.example.com'), ['https://auth.example.com/.well-known/oauth-authorization-server', 'https://auth.example.com/.well-known/openid-configuration']);
  assert.deepEqual(bearerChallenge('Bearer resource_metadata="https://gw.example.com/.well-known/oauth-protected-resource/mcp", scope="a b"'), {
    resource_metadata: 'https://gw.example.com/.well-known/oauth-protected-resource/mcp',
    scope: 'a b',
  });
  assert.equal(refusedOutbound('https://mcp.example.com/mcp', []), null);
  assert.match(refusedOutbound('http://mcp.example.com/mcp', []) ?? '', /not HTTPS/);
  assert.match(refusedOutbound('https://10.0.0.5/mcp', []) ?? '', /private/);
  assert.match(refusedOutbound('https://169.254.169.254/latest', []) ?? '', /link-local/);
  assert.match(refusedOutbound('https://localhost/mcp', []) ?? '', /this machine/);
  assert.match(refusedOutbound('http://127.0.0.1:9/mcp', []) ?? '', /not HTTPS/);
  assert.equal(refusedOutbound('http://127.0.0.1:9/mcp', ['127.0.0.1']), null);
  // An allowed private address still needs HTTPS: plain HTTP is for loopback only.
  assert.match(refusedOutbound('http://100.64.0.9/mcp', ['100.64.0.0/10']) ?? '', /not HTTPS/);
  assert.equal(refusedOutbound('https://100.64.0.9/mcp', ['100.64.0.0/10']), null);
  assert.match(refusedOutbound('https://user:pw@mcp.example.com/mcp', []) ?? '', /user name or password/);
});

test('BOTONS_OAUTH_PUBLIC_URL must be a bare https origin; its host joins the allowed Host names', () => {
  const home = tempDir();
  const base = { BOTONS_HOME: home, BOTONS_NO_TAILSCALE: '1', BOTONS_HOST: '127.0.0.1' };
  for (const bad of ['http://myhost.example-tailnet.ts.net', `https://${OAUTH_HOST}/oauth`, `https://${OAUTH_HOST}/?x=1`, 'myhost']) {
    assert.throws(() => loadConfig({ ...base, BOTONS_OAUTH_PUBLIC_URL: bad }), /BOTONS_OAUTH_PUBLIC_URL must be an https:\/\/ origin/, bad);
  }
  const cfg = loadConfig({ ...base, BOTONS_OAUTH_PUBLIC_URL: `https://${OAUTH_HOST}/` });
  assert.equal(cfg.oauth.publicUrl, `https://${OAUTH_HOST}`);
  assert.equal(loadConfig(base).oauth.publicUrl, null);
});

test('connect: discovery, one registration named Botons, PKCE S256 and the resource; the callback stores tokens the API never shows', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  assert.equal(c.status, 'new');
  const { authorizeUrl } = await start(s, c.id);
  const q = new URL(authorizeUrl).searchParams;
  assert.equal(new URL(authorizeUrl).origin + new URL(authorizeUrl).pathname, `${fake.issuer}/authorize`);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge') ?? '', /^[\w-]{43}$/);
  assert.equal(q.get('resource'), fake.mcpUrl);
  assert.equal(q.get('redirect_uri'), `https://${OAUTH_HOST}/oauth/callback`);
  assert.equal(q.get('scope'), 'fleet:read fleet:operate');
  assert.ok((q.get('state') ?? '').length >= 40);
  assert.equal(fake.registrations.length, 1);
  assert.deepEqual(
    { name: fake.registrations[0].client_name, redirect: fake.registrations[0].redirect_uris, auth: fake.registrations[0].token_endpoint_auth_method },
    { name: 'Botons', redirect: [`https://${OAUTH_HOST}/oauth/callback`], auth: 'none' },
  );

  const back = await fake.approve(authorizeUrl);
  const page = await viaProxy(s.base, `${back.pathname}${back.search}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  for (const secret of [back.searchParams.get('code')!, back.searchParams.get('state')!]) assert.ok(!page.body.includes(secret), 'no code or state in the page');
  assert.match(page.body, new RegExp(`href="${s.base.replace(/[.]/g, '\\.')}/\\?connector=fleet&#38;signin=connected"`));

  const exchange = fake.tokenRequests.at(-1)!;
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('resource'), fake.mcpUrl);
  assert.ok(exchange.get('code_verifier'));

  const list = await s.call<{ connections: OAuthConnection[] }>('GET', '/api/oauth-connections');
  assert.equal(list.data.connections[0].status, 'connected');
  const row = s.app.store.db.prepare('select access_token, refresh_token from oauth_connections where id = ?').get(c.id) as { access_token: string; refresh_token: string };
  for (const t of [row.access_token, row.refresh_token]) {
    assert.ok(t);
    assert.ok(!list.text.includes(t), 'tokens never in the API');
    assert.ok(!(await s.call('GET', '/api/connectors')).text.includes(t));
  }
  // The data folder stays private with tokens in it.
  assert.equal(statSync(s.home).mode & 0o777, 0o700);
  assert.equal(statSync(s.cfg.dbPath).mode & 0o777, 0o600);

  // The same callback again: the state is spent.
  const again = await viaProxy(s.base, `${back.pathname}${back.search}`);
  assert.equal(again.status, 400);
  assert.match(again.body, /already used/);
  assert.equal(fake.tokenRequests.length, 1);

  // Signing in again reuses the registration.
  await signIn(s, fake, c.id);
  assert.equal(fake.registrations.length, 1);
  assert.equal(s.app.oauth.record(c.id)!.generation, 2);
});

test('callback: denial, a wrong iss, a stale device, a superseded sign-in and a racing replay change nothing', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);

  const denied = await fake.approve((await start(s, c.id)).authorizeUrl, { deny: true });
  const deniedPage = await viaProxy(s.base, `${denied.pathname}${denied.search}`);
  assert.equal(deniedPage.status, 400);
  assert.match(deniedPage.body, /declined/);
  assert.equal(s.app.oauth.get(c.id).status, 'new');

  fake.opts.iss = 'wrong';
  const wrong = await fake.approve((await start(s, c.id)).authorizeUrl);
  assert.match((await viaProxy(s.base, `${wrong.pathname}${wrong.search}`)).body, /did not come from the authorization server/);
  fake.opts.iss = 'none';
  const none = await fake.approve((await start(s, c.id)).authorizeUrl);
  // It says it sends iss, so an answer without one is refused.
  assert.equal((await viaProxy(s.base, `${none.pathname}${none.search}`)).status, 400);
  fake.opts.iss = 'right';
  assert.equal(fake.tokenRequests.length, 0, 'no code redeemed');

  // A device that is unpaired after starting.
  const other = await s.call<{ device: { id: string }; token: string }>('POST', '/api/auth/pair', { secret: approvedPairing(s.app.store.db) });
  const otherStart = await s.call<OAuthConnectStart>('POST', `/api/oauth-connections/${c.id}/connect`, { returnTo: s.base }, other.data.token);
  const stale = await fake.approve(otherStart.data.authorizeUrl);
  s.app.auth.revokeDevice(other.data.device.id);
  assert.match((await viaProxy(s.base, `${stale.pathname}${stale.search}`)).body, /no longer paired/);

  // Unpaired while its code is being redeemed: the tokens are discarded, nothing is connected.
  const late2 = await s.call<{ device: { id: string }; token: string }>('POST', '/api/auth/pair', { secret: approvedPairing(s.app.store.db) });
  const lateStart = await s.call<OAuthConnectStart>('POST', `/api/oauth-connections/${c.id}/connect`, { returnTo: s.base }, late2.data.token);
  const lateBack = await fake.approve(lateStart.data.authorizeUrl);
  const release = fake.holdTokens();
  const exchanged = fake.tokenRequests.length;
  const lateDone = viaProxy(s.base, `${lateBack.pathname}${lateBack.search}`);
  await until(() => fake.tokenRequests.length > exchanged);
  s.app.auth.revokeDevice(late2.data.device.id);
  release();
  const latePage = await lateDone;
  assert.equal(latePage.status, 400);
  assert.match(latePage.body, /no longer paired/);
  assert.equal(s.app.oauth.get(c.id).status, 'new');
  assert.equal(s.app.oauth.record(c.id)!.accessToken, null);
  assert.equal(s.app.oauth.record(c.id)!.refreshToken, null);

  // Two sign-ins at once: the one that completes second is refused.
  const first = await fake.approve((await start(s, c.id)).authorizeUrl);
  const second = await fake.approve((await start(s, c.id)).authorizeUrl);
  assert.equal((await viaProxy(s.base, `${second.pathname}${second.search}`)).status, 200);
  const late = await viaProxy(s.base, `${first.pathname}${first.search}`);
  assert.equal(late.status, 400);
  assert.equal(s.app.oauth.record(c.id)!.generation, 1);

  // The same state twice at once: exactly one claims it.
  const raced = await fake.approve((await start(s, c.id)).authorizeUrl);
  const both = await Promise.all([viaProxy(s.base, `${raced.pathname}${raced.search}`), viaProxy(s.base, `${raced.pathname}${raced.search}`)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  assert.equal(s.app.oauth.record(c.id)!.generation, 2);

  // No state, or one Botons never made.
  assert.equal((await viaProxy(s.base, '/oauth/callback?code=x')).status, 400);
  assert.equal((await viaProxy(s.base, '/oauth/callback?code=x&state=made-up')).status, 400);
});

test('callback: an unsafe return address falls back to the public URL; only the exact path exists and the rest still needs a device', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const { authorizeUrl } = await start(s, c.id, 'https://evil.example.com/steal');
  const back = await fake.approve(authorizeUrl);
  const page = await viaProxy(s.base, `${back.pathname}${back.search}`);
  assert.ok(!page.body.includes('evil.example.com'));
  assert.ok(page.body.includes(`href="${s.cfg.publicUrl}/?connector=fleet`));

  // Through the proxy's name: the app's API still wants a token, other /oauth paths don't exist, POST isn't served.
  assert.equal((await viaProxy(s.base, '/api/bots')).status, 401);
  assert.equal((await viaProxy(s.base, '/oauth/other')).status, 404);
  const post = await fetch(`${s.base}/oauth/callback?state=x`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(post.status, 405);
  // Pairing is unchanged: a request through the proxy is loopback, never the owner's one-click peer.
  const status = await viaProxy(s.base, '/api/auth/status');
  assert.equal(JSON.parse(status.body).ownerPairing, null);
  // A name the proxy doesn't send is refused by the Host check as before.
  assert.equal((await viaProxy(s.base, '/oauth/callback', { host: 'elsewhere.example.com' })).status, 403);
});

test('connect is for paired devices only, and needs BOTONS_OAUTH_PUBLIC_URL', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const bot = s.storeBot('Kevin', 'claude-cli');
  const turn = s.app.auth.mintBotonToken(bot.id);
  assert.equal((await s.call('POST', `/api/oauth-connections/${c.id}/connect`, {}, turn.token)).status, 403);
  assert.equal((await s.call('POST', '/api/oauth-connections', { name: 'x', url: fake.mcpUrl }, turn.token)).status, 403);
  assert.equal((await s.call('POST', `/api/oauth-connections/${c.id}/connect`, {}, null)).status, 401);
  turn.revoke();

  const plain = await startServer({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
  const c2 = await plain.call<OAuthConnection>('POST', '/api/oauth-connections', { name: 'fleet', url: fake.mcpUrl });
  const r = await plain.call('POST', `/api/oauth-connections/${c2.data.id}/connect`, {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /BOTONS_OAUTH_PUBLIC_URL/);
});

test('SSRF and trust: private targets, redirects, other resources, other issuers and no S256 are all refused', async () => {
  const { s, fake } = await setup();
  for (const url of ['https://10.1.2.3/mcp', 'http://mcp.example.com/mcp', 'https://169.254.169.254/mcp']) {
    const r = await s.call('POST', '/api/oauth-connections', { name: 'bad', url });
    assert.equal(r.status, 400, url);
  }
  // Without the allowance, even the loopback test server is refused.
  const strict = await startServer({ env: { BOTONS_OAUTH_PUBLIC_URL: `https://${OAUTH_HOST}` } });
  assert.equal((await strict.call('POST', '/api/oauth-connections', { name: 'fleet', url: fake.mcpUrl })).status, 400);

  const c = await addConnector(s, fake);
  const tryStart = () => s.call('POST', `/api/oauth-connections/${c.id}/connect`, { returnTo: s.base });
  fake.opts.prmRedirect = 'http://169.254.169.254/latest/meta-data';
  let r = await tryStart();
  assert.equal(r.status, 400);
  assert.match(r.data.error, /redirect/);
  fake.opts.prmRedirect = null;
  fake.opts.prmResource = 'https://other.example.com/mcp';
  assert.match((await tryStart()).data.error, /another resource/);
  fake.opts.prmResource = null;
  fake.opts.asIssuer = 'https://other.example.com';
  assert.match((await tryStart()).data.error, /another issuer/);
  fake.opts.asIssuer = null;
  fake.opts.s256 = false;
  assert.match((await tryStart()).data.error, /S256/);
  fake.opts.s256 = true;
  assert.equal(fake.registrations.length, 0, 'nothing registered with an untrusted server');
  r = await tryStart();
  assert.equal(r.status, 200);
});

test('refresh: one at a time per connection, rotation saved, ambiguous failures not retried at once, a refused grant asks to reconnect once', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const bot = s.storeBot('Kevin', 'claude-cli', { connections: ['oauth:fleet'] });
  // No feed, so nothing else refreshes meanwhile.
  fake.opts.feed = false;
  await signIn(s, fake, c.id);
  const oauth = s.app.oauth;
  const expire = () => s.app.store.db.prepare('update oauth_connections set access_expires_at = ? where id = ?').run(new Date(Date.now() + 1000).toISOString(), c.id);

  expire();
  const before = oauth.record(c.id)!;
  fake.opts.tokenDelayMs = 100;
  const tokens = await Promise.all([oauth.accessToken(c.id, 60_000), oauth.accessToken(c.id, 60_000), oauth.accessToken(c.id, 60_000)]);
  fake.opts.tokenDelayMs = 0;
  const refreshes = fake.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1, 'turns, feed and keep-alive share one refresh');
  assert.equal(refreshes[0].get('resource'), fake.mcpUrl);
  assert.equal(refreshes[0].get('refresh_token'), before.refreshToken);
  assert.equal(new Set(tokens).size, 1);
  const after = oauth.record(c.id)!;
  assert.notEqual(after.refreshToken, before.refreshToken, 'the rotated token is saved');
  assert.notEqual(after.accessToken, before.accessToken);

  // A server error answer: nothing was issued, the grant is kept, and it is not retried at once.
  expire();
  fake.opts.tokenFault = 'server_error';
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string; ambiguous?: boolean }) => e.kind === 'transient' && !e.ambiguous);
  const n = fake.tokenRequests.length;
  await assert.rejects(oauth.accessToken(c.id, 60_000), /trying again shortly/);
  assert.equal(fake.tokenRequests.length, n, 'no immediate retry');
  assert.equal(oauth.get(c.id).status, 'connected');
  assert.ok(oauth.get(c.id).refreshError);
  s.app.store.db.prepare('update oauth_connections set refresh_retry_at = null where id = ?').run(c.id);
  await oauth.accessToken(c.id, 60_000);
  assert.equal(oauth.get(c.id).status, 'connected');

  // invalid_grant: Reconnect, tokens gone, one chip for the Boton that has it.
  expire();
  fake.opts.tokenFault = 'invalid_grant';
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  const lost = oauth.get(c.id);
  assert.equal(lost.status, 'reconnect');
  assert.equal(oauth.record(c.id)!.refreshToken, null);
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  const chips = (await s.messagesOf(bot.id)).filter((m) => m.meta?.kind === 'connector.reconnect');
  assert.equal(chips.length, 1);
  assert.equal((await s.call('GET', '/api/connectors')).data.connectors.find((x: { id: string }) => x.id === 'oauth:fleet').status, 'needs-auth');

  // Reconnecting brings it back.
  await signIn(s, fake, c.id);
  assert.equal(oauth.get(c.id).status, 'connected');
});

test('refresh: an answer lost after the request went out is never repeated, so a strict server keeps the grant family', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const bot = s.storeBot('Kevin', 'claude-cli', { connections: ['oauth:fleet'] });
  fake.opts.feed = false;
  // A strict server: a spent refresh token sent again revokes every token of that grant.
  fake.opts.strictReuse = true;
  await signIn(s, fake, c.id);
  const oauth = s.app.oauth;
  const expire = () => s.app.store.db.prepare('update oauth_connections set access_expires_at = ? where id = ?').run(new Date(Date.now() + 1000).toISOString(), c.id);

  // The server rotates the token and the answer never arrives.
  expire();
  const spent = oauth.record(c.id)!.refreshToken!;
  fake.opts.tokenFault = 'drop-after-rotate';
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  const sent = fake.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].get('refresh_token'), spent);

  // Nothing tries it again, from any caller: Reconnect, tokens dropped, one chip.
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  await oauth.keepAlive(c.id);
  assert.equal(fake.tokenRequests.filter((f) => f.get('refresh_token') === spent).length, 1, 'the possibly spent token is never sent again');
  assert.equal(fake.familiesRevoked, 0, 'no reuse, so the server revoked nothing');
  assert.equal(oauth.get(c.id).status, 'reconnect');
  assert.match(oauth.get(c.id).statusReason ?? '', /no usable answer/);
  assert.equal(oauth.record(c.id)!.refreshToken, null);
  assert.equal((await s.messagesOf(bot.id)).filter((m) => m.meta?.kind === 'connector.reconnect').length, 1);

  // A garbled success answer is just as ambiguous; a 5xx with no OAuth error too.
  await signIn(s, fake, c.id);
  expire();
  fake.opts.tokenFault = 'bare_500';
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  assert.equal(oauth.get(c.id).status, 'reconnect');

  // Signing in again starts a fresh grant that works.
  await signIn(s, fake, c.id);
  expire();
  await oauth.accessToken(c.id, 60_000);
  assert.equal(oauth.get(c.id).status, 'connected');
  assert.equal(fake.familiesRevoked, 0);
});

test('refresh: marked as started before it is sent, so one cut off by a crash is never sent again after a restart', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const bot = s.storeBot('Kevin', 'claude-cli', { connections: ['oauth:fleet'] });
  fake.opts.feed = false;
  fake.opts.strictReuse = true;
  await signIn(s, fake, c.id);
  const oauth = s.app.oauth;
  const db = s.app.store.db;
  const mark = () => (db.prepare('select refresh_started_at as v from oauth_connections where id = ?').get(c.id) as { v: string | null }).v;
  const expire = () => db.prepare('update oauth_connections set access_expires_at = ? where id = ?').run(new Date(Date.now() + 1000).toISOString(), c.id);
  const refreshes = () => fake.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');

  // A rotation that is saved clears the mark with the new tokens; so does an answer that issued nothing.
  expire();
  await oauth.accessToken(c.id, 60_000);
  assert.equal(mark(), null);
  expire();
  fake.opts.tokenFault = 'server_error';
  await assert.rejects(oauth.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'transient');
  assert.equal(mark(), null);
  assert.equal(oauth.recoverInterrupted(), 0);
  assert.equal(oauth.get(c.id).status, 'connected');
  db.prepare('update oauth_connections set refresh_retry_at = null where id = ?').run(c.id);

  // The process stops while the server is answering: the mark is already saved when the request goes out.
  expire();
  const spent = oauth.record(c.id)!.refreshToken!;
  const sentBefore = refreshes().length;
  const release = fake.holdTokens('refresh_token');
  const inFlight = oauth.accessToken(c.id, 60_000);
  await until(() => refreshes().some((f) => f.get('refresh_token') === spent));
  assert.ok(mark(), 'marked before the request was sent');
  // What the disk holds at the moment of the crash: the mark and the refresh token being spent.
  const crashed = tempDir('botons-oauth-crash-');
  cpSync(s.home, crashed, { recursive: true, filter: (p) => !/botons\.db/.test(p) });
  db.exec(`vacuum into '${join(crashed, 'botons.db')}'`);
  // The server carries the rotation out; that answer reaches no process that kept the copy.
  release();
  await inFlight;
  await s.stop();

  const again = await startServer({ home: crashed, token: s.token, env: OAUTH_ENV, fakeClis: true });
  const o2 = again.app.oauth;
  // Recovered at start: Reconnect, every token dropped, the mark cleared, the Boton told once.
  const after = o2.record(c.id)!;
  assert.equal(after.status, 'reconnect');
  assert.equal(after.refreshToken, null);
  assert.equal(after.accessToken, null);
  assert.match(o2.get(c.id).statusReason ?? '', /cut off/);
  assert.equal((again.app.store.db.prepare('select refresh_started_at as v from oauth_connections where id = ?').get(c.id) as { v: string | null }).v, null);
  await assert.rejects(o2.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  await o2.keepAlive(c.id);
  assert.equal(refreshes().slice(sentBefore).filter((f) => f.get('refresh_token') === spent).length, 1, 'the possibly spent token is never sent again');
  assert.equal(fake.familiesRevoked, 0, 'a strict server saw no reuse');
  assert.equal((await again.messagesOf(bot.id)).filter((m) => m.meta?.kind === 'connector.reconnect').length, 1);

  // A mark found by a refresh itself (one at a time here, so it can only be left over) is treated the same.
  await signIn(again, fake, c.id);
  assert.equal(o2.get(c.id).status, 'connected');
  again.app.store.db.prepare('update oauth_connections set refresh_started_at = ?, access_expires_at = ? where id = ?').run(new Date().toISOString(), new Date(Date.now() + 1000).toISOString(), c.id);
  const n = fake.tokenRequests.length;
  await assert.rejects(o2.accessToken(c.id, 60_000), (e: Error & { kind?: string }) => e.kind === 'grant');
  assert.equal(fake.tokenRequests.length, n);
  assert.equal(o2.get(c.id).status, 'reconnect');

  // Signing in again clears it and starts a fresh grant that refreshes.
  await signIn(again, fake, c.id);
  again.app.store.db.prepare('update oauth_connections set access_expires_at = ? where id = ?').run(new Date(Date.now() + 1000).toISOString(), c.id);
  await o2.accessToken(c.id, 60_000);
  assert.equal(o2.get(c.id).status, 'connected');
  assert.equal(fake.familiesRevoked, 0);
});

test('a refresh that finishes after a new sign-in is discarded; keep-alive refreshes weekly and is saved', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  fake.opts.feed = false;
  await signIn(s, fake, c.id);
  const oauth = s.app.oauth;
  assert.ok(oauth.get(c.id).nextKeepAliveAt! > new Date(Date.now() + 6 * 86_400_000).toISOString());

  s.app.store.db.prepare('update oauth_connections set access_expires_at = ? where id = ?').run(new Date(Date.now() + 1000).toISOString(), c.id);
  const release = fake.holdTokens('refresh_token');
  const slow = oauth.accessToken(c.id, 60_000);
  await until(() => fake.tokenRequests.some((f) => f.get('grant_type') === 'refresh_token'));
  const { authorizeUrl } = await start(s, c.id);
  const back = await fake.approve(authorizeUrl);
  // Bypass the queue: a sign-in doesn't wait for a refresh, and is saved before the refresh is answered.
  assert.equal((await viaProxy(s.base, `${back.pathname}${back.search}`)).status, 200);
  release();
  const signedIn = oauth.record(c.id)!;
  const got = await slow;
  assert.equal(got, signedIn.accessToken, "the newer sign-in's token wins");
  assert.equal(oauth.record(c.id)!.refreshToken, signedIn.refreshToken);
  assert.equal((s.app.store.db.prepare('select refresh_started_at as v from oauth_connections where id = ?').get(c.id) as { v: string | null }).v, null, 'the sign-in cleared the mark');

  s.app.store.db.prepare('update oauth_connections set keepalive_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), c.id);
  assert.deepEqual(oauth.keepAliveDue(), [c.id]);
  const n = fake.tokenRequests.length;
  await oauth.keepAlive(c.id);
  assert.equal(fake.tokenRequests.length, n + 1);
  assert.deepEqual(oauth.keepAliveDue(), []);
  await s.call('PATCH', `/api/oauth-connections/${c.id}`, { keepConnected: false });
  assert.equal(oauth.get(c.id).nextKeepAliveAt, null);
});

test('turns: the access token goes in the header (claude: the private file; codex: an env var), never the refresh token', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  await signIn(s, fake, c.id);
  const claude = s.claude!;
  const codex = s.codex!;
  const kevin = s.storeBot('Kevin', 'claude-cli', { connections: ['oauth:fleet'] });
  const stuart = s.storeBot('Stuart', 'codex-cli', { connections: ['oauth:fleet'] });
  const rec = s.app.oauth.record(c.id)!;

  claude.script('claude/reply');
  await s.chat(kevin.id, 'hello');
  const call = claude.calls()[0];
  const cfg = JSON.parse(call.mcpConfigFile!).mcpServers.fleet;
  assert.deepEqual(cfg, { type: 'http', url: fake.mcpUrl, headers: { Authorization: `Bearer ${rec.accessToken}` } });
  for (const where of [call.argv.join(' '), JSON.stringify(call.env), call.stdin, call.mcpConfigFile!]) assert.ok(!where.includes(rec.refreshToken!));
  assert.ok(!call.argv.join(' ').includes(rec.accessToken!));

  codex.script('codex/reply');
  await s.chat(stuart.id, 'hello');
  const cx = codex.calls()[0];
  assert.ok(!cx.argv.join(' ').includes(rec.accessToken!));
  assert.ok(cx.argv.some((a) => a.includes('mcp_servers.fleet.env_http_headers')));
  assert.ok(Object.values(cx.env).includes(`Bearer ${rec.accessToken}`));
  assert.ok(!JSON.stringify(cx.env).includes(rec.refreshToken!));

  // A token that would expire within the turn's time limit is refreshed before the turn starts.
  s.app.store.db.prepare('update oauth_connections set access_expires_at = ?, access_lifetime_ms = null where id = ?').run(new Date(Date.now() + 60_000).toISOString(), c.id);
  claude.script('claude/reply');
  await s.chat(kevin.id, 'again');
  const fresh = s.app.oauth.record(c.id)!.accessToken;
  assert.notEqual(fresh, rec.accessToken);
  assert.equal(JSON.parse(claude.calls()[0].mcpConfigFile!).mcpServers.fleet.headers.Authorization, `Bearer ${fresh}`);

  // A connector that needs signing in again is left out of the turn, with no error.
  s.app.store.db.prepare("update oauth_connections set status = 'reconnect', access_token = null where id = ?").run(c.id);
  claude.script('claude/reply');
  await s.chat(kevin.id, 'and again');
  assert.equal(claude.calls()[0].mcpConfigFile, undefined);
});

test('observing work_start: structured results only, the actual connector, the first owner kept', () => {
  const servers = ['fleet', 'fleet_x'];
  assert.deepEqual(claudeMcpTool('mcp__fleet_x__work_start', servers), { server: 'fleet_x', tool: 'work_start' });
  assert.deepEqual(claudeMcpTool('mcp__fleet__work_start', servers), { server: 'fleet', tool: 'work_start' });
  assert.equal(claudeMcpTool('mcp__other__work_start', servers), null);
  const call = { server: 'fleet', tool: 'work_start' };
  assert.deepEqual(claudeToolResult({ tool_use_id: 't1', content: 'Started job job_1' }, call, undefined).structured, null, 'prose is never read');
  assert.deepEqual(claudeToolResult({ tool_use_id: 't1', content: [{ type: 'text', text: '{"jobId":"job_1"}' }] }, call, undefined).structured, { jobId: 'job_1' });
  assert.equal(claudeToolResult({ tool_use_id: 't1', is_error: true, content: '{"jobId":"job_1"}' }, call, undefined).ok, false);
  assert.equal(codexToolResult({ type: 'mcp_tool_call', server: 'elsewhere', tool: 'work_start', status: 'completed' }, servers), null);
  assert.equal(codexToolResult({ type: 'mcp_tool_call', server: 'fleet', tool: 'work_start', status: 'failed', error: { message: 'x' } }, servers)!.ok, false);
});
