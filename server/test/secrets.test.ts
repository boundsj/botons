import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { exchangeCode, OAuthError, refreshGrant, type ServerMetadata } from '../src/oauth.ts';
import { redact, redactTokenShaped, sanitize } from '../src/secrets.ts';
import { freePort } from './helpers.ts';

test('known secrets are taken out however short, longest first, before the cut', () => {
  assert.equal(redact('key=x7 and x7q', ['x7', 'x7q']), 'key=[redacted] and [redacted]');
  assert.equal(redact('a', [null, undefined, '']), 'a');
  const long = `failed: ${'d'.repeat(10)}secret`;
  assert.equal(sanitize(long, [`${'d'.repeat(10)}secret`], 12), 'failed: [red');
  assert.ok(!sanitize(long, [`${'d'.repeat(10)}secret`], 14).includes('ddd'), 'no prefix of a secret survives a cut');
});

test('a control character cannot split a known secret apart', () => {
  assert.equal(sanitize('echo Q7\u0000Z', ['Q7Z']), 'echo [redacted]');
  assert.equal(sanitize('line\none'), 'lineone');
});

test('token-shaped runs go; words, hosts, ids and UUIDs stay', () => {
  for (const t of ['rt_a1f6ccc63a1364d49d6576c4', 'eyJhbGciOiJIUzI1NiJ9', 'ghp_0123456789abcdefABCDEF', 'dummyEchoedValue0123456789abcdef', 'abc123def456ghi789jk==']) {
    assert.equal(redactTokenShaped(`x ${t} y`), 'x [redacted] y', t);
  }
  assert.equal(redactTokenShaped('a.b.c' .replace(/[abc]/g, 'eyJhbGciOiJIUzI1NiJ9')), '[redacted].[redacted].[redacted]', 'each JWT segment');
  const kept = 'mcp.example.com refused the token request (400: invalid_grant) for oac_iw44bfgp 123e4567-e89b-12d3-a456-426614174000 at 2026-11-06T22:43:53.565Z';
  assert.equal(sanitize(kept, [], 1000), kept);
  assert.equal(redactTokenShaped('authorization_server_metadata_unavailable'), 'authorization_server_metadata_unavailable', 'no digit: a word');
});

test('an OAuthError never holds a token-shaped run', () => {
  assert.equal(new OAuthError('setup', 'got rt_a1f6ccc63a1364d49d6576c4').message, 'got [redacted]');
});

test('an OAuthError takes out the known secrets before token-shaped runs, so no piece of one is left', () => {
  const dotted = 'dummyRefresh0123456789.tailsecret';
  const e = new OAuthError('grant', `refused the grant (400: ${dotted})`, false, [dotted]);
  assert.equal(e.message, 'refused the grant (400: [redacted])');
  // The order matters: a known secret applied after the token-shaped pass no longer matches, and its tail shows.
  assert.equal(sanitize(sanitize(`(400: ${dotted})`), [dotted]), '(400: [redacted].tailsecret)');
});

test('a token endpoint echoing what it was sent gets none of it into the error', async () => {
  let answer: (form: URLSearchParams) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const a = answer(new URLSearchParams(body));
    res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
  });
  const port = await freePort();
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
  try {
    const meta = { issuer: `http://127.0.0.1:${port}`, token_endpoint: `http://127.0.0.1:${port}/token` } as ServerMetadata;
    const allow = ['127.0.0.1'];
    const fails = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        assert.ok(err instanceof OAuthError);
        return err;
      }
      assert.fail('expected an OAuthError');
    };
    for (const status of [400, 401]) {
      for (const [refreshToken, accessToken] of [['dummyRefresh0123456789.tailsecret', 'dummyAccess0123456789.othersecret'], ['dummyRefresh0123456789.tailsecret', null]] as const) {
        answer = (f) => ({ status, body: { error: f.get('refresh_token') } });
        const dotted = await fails(refreshGrant(meta, { refreshToken, accessToken, clientId: 'c', resource: 'https://mcp.example.com' }, allow));
        assert.match(dotted.message, new RegExp(`\\(${status}: \\[redacted\\]\\)$`));
        for (const piece of ['dummyRefresh', '0123456789', 'tailsecret']) assert.ok(!dotted.message.includes(piece), piece);
        if (accessToken) {
          answer = () => ({ status, body: { error: accessToken } });
          const echoed = await fails(refreshGrant(meta, { refreshToken, accessToken, clientId: 'c', resource: 'https://mcp.example.com' }, allow));
          for (const piece of ['dummyAccess', 'othersecret']) assert.ok(!echoed.message.includes(piece), piece);
        }
      }
      answer = (f) => ({ status, body: { error: f.get('refresh_token') } });
      const e = await fails(refreshGrant(meta, { refreshToken: 'Q7Z', clientId: 'c', resource: 'https://mcp.example.com' }, allow));
      assert.match(e.message, new RegExp(`\\(${status}: \\[redacted\\]\\)$`));
      assert.equal(e.kind, status === 401 ? 'grant' : 'setup');
      answer = (f) => ({ status, body: { error: f.get('code') } });
      assert.ok(!(await fails(exchangeCode(meta, { code: 'k9', verifier: 'v', clientId: 'c', redirectUri: 'https://myhost.example.com/cb', resource: 'https://mcp.example.com' }, allow))).message.includes('k9'));
      answer = (f) => ({ status, body: { error: f.get('code_verifier') } });
      assert.ok(!(await fails(exchangeCode(meta, { code: 'k', verifier: 'v9', clientId: 'c', redirectUri: 'https://myhost.example.com/cb', resource: 'https://mcp.example.com' }, allow))).message.includes('v9'));
    }
    // The refresh semantics stay: a grant error clears the grant, an error answer is not ambiguous, a 5xx without one is.
    answer = () => ({ status: 400, body: { error: 'invalid_grant' } });
    assert.equal((await fails(refreshGrant(meta, { refreshToken: 'r', clientId: 'c', resource: 'x' }, allow))).kind, 'grant');
    answer = () => ({ status: 503, body: {} });
    const lost = await fails(refreshGrant(meta, { refreshToken: 'r', clientId: 'c', resource: 'x' }, allow));
    assert.equal(lost.kind, 'transient');
    assert.equal(lost.ambiguous, true);
    answer = () => ({ status: 429, body: { error: 'slow_down' } });
    assert.equal((await fails(refreshGrant(meta, { refreshToken: 'r', clientId: 'c', resource: 'x' }, allow))).ambiguous, false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
