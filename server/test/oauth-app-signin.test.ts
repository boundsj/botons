import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OAuthConnectStart } from '../../shared/types.ts';
import { failOnEscapedErrors, tempDir, useTestCodexHome } from './helpers.ts';
import { addConnector, OAUTH_HOST, setup, start, viaProxy } from './oauth-helpers.ts';

failOnEscapedErrors();
useTestCodexHome(tempDir('botons-oauth-app-codex-'));

const DONE = 'botons-signin://done';

/** Start a sign-in the way the native app does. */
async function startApp(s: Awaited<ReturnType<typeof setup>>['s'], id: string): Promise<OAuthConnectStart & { attempt: string }> {
  const r = await s.call<OAuthConnectStart>('POST', `/api/oauth-connections/${id}/connect`, { completion: 'app' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.data.attempt, 'an attempt comes back');
  return r.data as OAuthConnectStart & { attempt: string };
}

const flowRows = (s: Awaited<ReturnType<typeof setup>>['s']) => s.app.store.db.prepare('select state_hash, return_to, code_verifier from oauth_flows order by created_at').all() as { state_hash: string; return_to: string; code_verifier: string }[];
const path = (u: URL) => `${u.pathname}${u.search}`;
const escapedHref = (attempt: string, result: string) => `href="${DONE}?attempt=${attempt}&#38;result=${result}"`;

test('app start: an independent attempt that is not the state and never in the authorize URL; the flow stores the fixed address', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const a = await startApp(s, c.id);
  const b = await startApp(s, c.id);
  assert.match(a.attempt, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.attempt, b.attempt);
  const url = new URL(a.authorizeUrl);
  const state = url.searchParams.get('state')!;
  assert.notEqual(a.attempt, state);
  assert.ok(!a.authorizeUrl.includes(a.attempt), 'the attempt is not in the authorize URL');
  assert.ok(!a.attempt.includes(state) && !state.includes(a.attempt));
  assert.ok(!JSON.stringify([...url.searchParams]).includes('botons-signin'));
  assert.deepEqual(Object.keys(a).sort(), ['attempt', 'authorizeUrl', 'expiresAt']);
  assert.deepEqual(
    flowRows(s).map((f) => f.return_to),
    [`${DONE}?attempt=${a.attempt}`, `${DONE}?attempt=${b.attempt}`],
  );
});

test('app sign-in: only after the connection is saved, a 302 to the fixed address with the attempt, uncached and with no referrer', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const { authorizeUrl, attempt } = await startApp(s, c.id);
  const back = await fake.approve(authorizeUrl);
  const done = await fetchNoFollow(s.base, path(back));
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), `${DONE}?attempt=${attempt}&result=connected`);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await done.text(), '');
  assert.equal(s.app.oauth.get(c.id).status, 'connected');
  assert.equal(s.app.oauth.record(c.id)!.generation, 1);
  assert.equal(fake.tokenRequests.length, 1);

  // The same callback again: the state is spent, so the ordinary page, never the native success.
  const again = await viaProxy(s.base, path(back));
  assert.equal(again.status, 400);
  assert.equal(again.headers.location, undefined);
  assert.match(again.body, /already used/);
  assert.ok(!again.body.includes('botons-signin'));
  assert.ok(again.body.includes(`href="${s.cfg.publicUrl}/?`) || again.body.includes(`href="${s.cfg.publicUrl}/"`));
  assert.equal(fake.tokenRequests.length, 1);
});

test('app sign-in: every refused callback is the 400 page whose Back link says failed, and never a success redirect', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const expectFailed = async (page: Awaited<ReturnType<typeof viaProxy>>, attempt: string, message: RegExp) => {
    assert.equal(page.status, 400, page.body);
    assert.equal(page.headers.location, undefined);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(page.body, message);
    assert.ok(page.body.includes(escapedHref(attempt, 'failed')), page.body);
    assert.ok(!page.body.includes('result=connected'));
    assert.ok(!page.body.includes('http-equiv="refresh"'));
  };

  // A code the authorization server doesn't know.
  let { authorizeUrl, attempt } = await startApp(s, c.id);
  let back = await fake.approve(authorizeUrl);
  back.searchParams.set('code', 'not-a-code');
  await expectFailed(await viaProxy(s.base, path(back)), attempt, /failed/);

  // A PKCE verifier that doesn't match the challenge.
  ({ authorizeUrl, attempt } = await startApp(s, c.id));
  back = await fake.approve(authorizeUrl);
  s.app.store.db.prepare('update oauth_flows set code_verifier = ? where return_to = ?').run('x'.repeat(43), `${DONE}?attempt=${attempt}`);
  await expectFailed(await viaProxy(s.base, path(back)), attempt, /failed/);

  // Declined at the authorization server.
  ({ authorizeUrl, attempt } = await startApp(s, c.id));
  back = await fake.approve(authorizeUrl, { deny: true });
  await expectFailed(await viaProxy(s.base, path(back)), attempt, /declined/);

  // An answer from another issuer.
  fake.opts.iss = 'wrong';
  ({ authorizeUrl, attempt } = await startApp(s, c.id));
  back = await fake.approve(authorizeUrl);
  await expectFailed(await viaProxy(s.base, path(back)), attempt, /did not come from the authorization server/);
  fake.opts.iss = 'right';

  // The device that started it is no longer paired.
  ({ authorizeUrl, attempt } = await startApp(s, c.id));
  back = await fake.approve(authorizeUrl);
  s.app.store.db.prepare("delete from auth_tokens where kind = 'device'").run();
  await expectFailed(await viaProxy(s.base, path(back)), attempt, /no longer paired/);
  assert.equal(s.app.oauth.get(c.id).status, 'new');
  assert.equal(fake.tokenRequests.length, 2, 'only the two sign-ins that got as far as redeeming a code');
});

test('app sign-in: a wrong or missing state gets the ordinary page, with nothing of the app in it', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const { authorizeUrl, attempt } = await startApp(s, c.id);
  const back = await fake.approve(authorizeUrl);
  back.searchParams.set('state', 'made-up');
  for (const q of [path(back), '/oauth/callback?code=x']) {
    const page = await viaProxy(s.base, q);
    assert.equal(page.status, 400);
    assert.equal(page.headers.location, undefined);
    assert.ok(!page.body.includes('botons-signin'));
    assert.ok(!page.body.includes(attempt));
    assert.ok(page.body.includes(`href="${s.cfg.publicUrl}/"`));
  }
  assert.equal(s.app.oauth.get(c.id).status, 'new');
  assert.equal(flowRows(s).length, 1, 'the real sign-in is still waiting');
});

test('connect: only "app" is a completion, and not together with returnTo; nothing is started by a refused request', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  for (const body of [{ completion: 'other' }, { completion: '' }, { completion: null }, { completion: true }, { completion: ['app'] }, { completion: 'APP' }, { completion: 'app', returnTo: s.base }, { completion: 'app', returnTo: null }, { completion: 'web', returnTo: s.base }]) {
    const r = await s.call('POST', `/api/oauth-connections/${c.id}/connect`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(flowRows(s).length, 0);
  assert.equal(fake.registrations.length, 0, 'not even discovery or registration happened');
});

test('web sign-in is unchanged: returnTo only, no attempt, the same answer and the same page; an app address in returnTo is not honoured', async () => {
  const { s, fake } = await setup();
  const c = await addConnector(s, fake);
  const started = await start(s, c.id);
  assert.deepEqual(Object.keys(started).sort(), ['authorizeUrl', 'expiresAt']);
  assert.deepEqual(
    flowRows(s).map((f) => f.return_to),
    [s.base],
  );
  const back = await fake.approve(started.authorizeUrl);
  const page = await viaProxy(s.base, path(back));
  assert.equal(page.status, 200);
  assert.equal(page.headers.location, undefined);
  assert.match(page.body, new RegExp(`href="${s.base.replace(/[.]/g, '\\.')}/\\?connector=fleet&#38;signin=connected"`));
  assert.match(page.body, /http-equiv="refresh"/);

  // A request can't make a web sign-in finish in the app by naming the app's address.
  const sneaky = await s.call<OAuthConnectStart>('POST', `/api/oauth-connections/${c.id}/connect`, { returnTo: `${DONE}?attempt=${'a'.repeat(43)}` });
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.data.attempt, undefined);
  assert.deepEqual(
    flowRows(s).map((f) => f.return_to),
    [s.cfg.publicUrl],
  );
  const sneakyBack = await fake.approve(sneaky.data.authorizeUrl);
  const sneakyPage = await viaProxy(s.base, path(sneakyBack));
  assert.equal(sneakyPage.status, 200);
  assert.equal(sneakyPage.headers.location, undefined);
  assert.ok(!sneakyPage.body.includes('botons-signin'));
});

/** A GET that keeps a redirect as the answer: the app's address is not one fetch can follow. */
async function fetchNoFollow(base: string, p: string): Promise<Response> {
  return fetch(`${base}${p}`, { redirect: 'manual', headers: { host: OAUTH_HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.101.102.103' } });
}
