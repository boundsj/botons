import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after } from 'node:test';
import type { OAuthConnection, OAuthConnectStart } from '../../shared/types.ts';
import { type FakeOAuthMcp, fakeOAuthMcp } from './fixtures/fake-oauth-mcp.ts';
import { freePort, startServer, type TestServer } from './helpers.ts';

export const OAUTH_HOST = 'myhost.example-tailnet.ts.net';
export const OAUTH_ENV = { BOTONS_OAUTH_PUBLIC_URL: `https://${OAUTH_HOST}`, BOTONS_OAUTH_ALLOW: '127.0.0.1' };

/** A GET as the reverse proxy in front of /oauth sends it: the public name in Host, forwarded headers. */
export function viaProxy(base: string, path: string, extra: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers: { host: OAUTH_HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.101.102.103', ...extra } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const fakes: FakeOAuthMcp[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

export async function setup(env: Record<string, string> = OAUTH_ENV) {
  const fake = await fakeOAuthMcp(await freePort());
  fakes.push(fake);
  const s = await startServer({ env, fakeClis: true });
  s.app.workFeed.pollMs = 3_600_000;
  return { s, fake };
}

export async function addConnector(s: TestServer, fake: FakeOAuthMcp, name = 'fleet'): Promise<OAuthConnection> {
  const r = await s.call<OAuthConnection>('POST', '/api/oauth-connections', { name, url: fake.mcpUrl });
  assert.equal(r.status, 201, r.text);
  return r.data;
}

export async function start(s: TestServer, id: string, returnTo = s.base): Promise<OAuthConnectStart> {
  const r = await s.call<OAuthConnectStart>('POST', `/api/oauth-connections/${id}/connect`, { returnTo });
  assert.equal(r.status, 200, r.text);
  return r.data;
}

/** Sign in all the way: start, the server's page, back through the proxy. */
export async function signIn(s: TestServer, fake: FakeOAuthMcp, id: string) {
  const { authorizeUrl } = await start(s, id);
  const back = await fake.approve(authorizeUrl);
  const page = await viaProxy(s.base, `${back.pathname}${back.search}`);
  assert.equal(page.status, 200, page.body);
  return { back, page };
}

