import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizationValue, presetFor, refusedText, SERVICE_PRESETS, serviceName, TOKEN_AS_NAME, tokenShapedName } from '../../shared/services.ts';
import { headerPatch, type HeaderRow } from '../../web/src/service-form.ts';
import { patchSecrets } from '../src/connectors.ts';
import { authorizationOf, GITHUB_API, GITHUB_PUBLIC_ONLY, GITHUB_REJECTED, githubAccess, type Request } from '../src/github-access.ts';

const TOKEN = 'fake-token-0123456789-secretpart';
const row = (name: string, value: string, saved = false, remove = false): HeaderRow => ({ name, value, saved, remove });

test('presets are data with an MCP URL, a token help link and a name the library takes', () => {
  const github = SERVICE_PRESETS.find((p) => p.id === 'github');
  assert.ok(github);
  assert.equal(github.label, 'GitHub');
  assert.equal(github.url, 'https://api.githubcopilot.com/mcp/');
  assert.match(github.help.url, /^https:\/\/github\.com\/settings\/personal-access-tokens/);
  for (const p of SERVICE_PRESETS) {
    assert.match(p.name, /^[a-z0-9][a-z0-9_-]{0,39}$/);
    assert.equal(presetFor(p.url), p);
  }
  assert.equal(presetFor('https://API.githubcopilot.com/mcp/x'), github, 'by host, any case or path');
  assert.equal(presetFor('https://api.githubcopilot.com.example.com/mcp/'), null);
  assert.equal(presetFor('not a url'), null);
  assert.equal(serviceName('https://mcp.example.com/mcp'), 'mcp.example.com');
});

test('a bare token is sent as Bearer; one that names its scheme is kept', () => {
  assert.equal(authorizationValue(`  ${TOKEN}\n`), `Bearer ${TOKEN}`);
  assert.equal(authorizationValue(`Bearer ${TOKEN}`), `Bearer ${TOKEN}`);
  assert.equal(authorizationValue(`bearer ${TOKEN}`), `Bearer ${TOKEN}`);
  assert.equal(authorizationValue(`Authorization: Bearer ${TOKEN}`), `Bearer ${TOKEN}`);
  assert.equal(authorizationValue(`token ${TOKEN}`), `Token ${TOKEN}`);
  assert.equal(authorizationValue('   '), '');
});

test('a refusal names the service in plain words, never the token', () => {
  assert.equal(refusedText('https://api.githubcopilot.com/mcp/', 401, true), 'GitHub rejected the token (expired or deleted?)');
  assert.equal(refusedText('https://api.githubcopilot.com/mcp/', 403, true), 'GitHub refused the token (403). Check its permissions or expiry.');
  assert.match(refusedText('https://mcp.example.com/mcp', 403, false), /^mcp\.example\.com refused the request \(403\)/);
});

test('the form sends the key as Authorization, replaces saved headers in any case, and keeps the rest', () => {
  assert.deepEqual(headerPatch(TOKEN, false, [], []), { Authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(headerPatch(TOKEN, false, [], ['authorization']), { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(headerPatch('', true, [], ['Authorization']), { Authorization: null });
  assert.deepEqual(headerPatch('replacement', true, [], ['Authorization']), { Authorization: null }, 'removing the saved key wins');
  assert.deepEqual(headerPatch('', false, [row('X-Api-Key', '', true)], ['X-Api-Key']), {}, 'a saved header left empty keeps its value');
  assert.deepEqual(headerPatch('', false, [row('X-Api-Key', '', true, true)], ['X-Api-Key']), { 'X-Api-Key': null });
  assert.deepEqual(headerPatch('', false, [row('x-api-key', 'k2')], ['X-Api-Key']), { 'X-Api-Key': null, 'x-api-key': 'k2' });
  assert.deepEqual(headerPatch('', false, [row('Authorization', TOKEN)], []), { Authorization: `Bearer ${TOKEN}` });
  assert.throws(() => headerPatch(TOKEN, false, [row('Authorization', 'other')], []), /set twice/);
});

test('a token in the wrong field never comes back in an error', () => {
  for (const r of [row(`Bearer ${TOKEN}`, ''), row(`Authorization: ${TOKEN}`, 'v'), row(TOKEN, '')]) {
    assert.throws(
      () => headerPatch('', false, [r], []),
      (e: Error) => !e.message.includes(TOKEN) && !e.message.includes('secretpart'),
    );
  }
  for (const [field, key] of [['headers', `Bearer ${TOKEN}`], ['env', `A ${TOKEN}`]] as const) {
    assert.throws(
      () => patchSecrets({}, { [key]: 'v' }, field, field === 'env' ? /^[A-Za-z_]\w*$/ : /^[A-Za-z0-9-]+$/),
      (e: Error) => !e.message.includes(TOKEN) && /not a valid name|looks like a token/.test(e.message),
    );
  }
  assert.throws(
    () => patchSecrets({}, { [TOKEN]: 'line\nbreak' }, 'headers', /^[\w-]+$/),
    (e: Error) => !e.message.includes(TOKEN),
  );
});

test('a token pasted as a header name is refused with the fix, in the form and on the server', () => {
  const short = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`; // a GitHub token's length: a valid header name by its characters
  const long = `github_pat_${'11ABCDEFG0'.repeat(8)}`;
  for (const name of [short, long, 'abc123def456ghi789', `Bearer ${TOKEN}`, `Authorization: ${TOKEN}`]) {
    assert.ok(tokenShapedName(name), name.slice(0, 12));
    assert.throws(() => headerPatch('', false, [row(name, 'v')], []), (e: Error) => e.message === TOKEN_AS_NAME);
    assert.throws(() => patchSecrets({}, { [name]: 'v' }, 'headers', /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/), (e: Error) => e.message === TOKEN_AS_NAME);
  }
  assert.match(TOKEN_AS_NAME, /Paste your token into the API key field above, or use Authorization as the header name/);
  assert.throws(() => patchSecrets({}, { [short]: 'v' }, 'env', /^[A-Za-z_]\w*$/), (e: Error) => !e.message.includes(short) && /looks like a token/.test(e.message));
  for (const name of ['Authorization', 'X-Api-Key', 'X-GitHub-Api-Version', 'Ocp-Apim-Subscription-Key', 'X-Goog-User-Project', 'CF-Access-Client-Id', 'X-Request-Id', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'npm_config_registry', 'HF_HOME']) {
    assert.equal(tokenShapedName(name), false, name);
  }
  assert.deepEqual(headerPatch('', false, [row('X-Api-Key', 'k')], []), { 'X-Api-Key': 'k' });
});

test("GitHub's access check asks GitHub's API alone, with the token alone, for one private repo", async () => {
  assert.equal(GITHUB_REJECTED, 'GitHub rejected the token (expired or deleted?)');
  assert.equal(GITHUB_PUBLIC_ONLY, 'This token can only see public repos. Give it Repository access to the repos you want and at least Contents: Read.');
  assert.equal(authorizationOf({ 'X-Other': 'x', authorization: `Bearer ${TOKEN}` }), `Bearer ${TOKEN}`);
  assert.equal(authorizationOf({ 'X-Api-Key': TOKEN }), null);
  const sent: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] = [];
  const answer = (status: number, body: unknown): Request => async (url, opts) => {
    sent.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
    return { status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
  };
  assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, answer(200, [{ name: 'r', private: true }])), 'private');
  assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, answer(200, [])), 'public-only');
  assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, answer(200, [{ name: 'r', private: false }])), 'public-only');
  assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, answer(404, { message: 'Not Found' })), 'public-only');
  assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, answer(401, { message: 'Bad credentials' })), 'rejected');
  for (const [status, body] of [[403, { message: 'rate limited' }], [500, ''], [200, 'not json'], [200, { message: 'x' }]] as const) {
    assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, answer(status, body)), 'unknown');
  }
  assert.equal(await githubAccess(`Bearer ${TOKEN}`, undefined, async () => { throw new Error(`echo ${TOKEN}`); }), 'unknown');
  for (const r of sent) {
    assert.equal(r.url, GITHUB_API);
    assert.equal(new URL(r.url).host, 'api.github.com');
    assert.equal(r.method, 'GET');
    assert.equal(r.body, undefined);
    assert.deepEqual(Object.keys(r.headers ?? {}).sort(), ['accept', 'authorization', 'user-agent', 'x-github-api-version']);
    assert.equal(r.headers?.authorization, `Bearer ${TOKEN}`);
  }
  assert.match(GITHUB_API, /visibility=private&per_page=1$/);
});
