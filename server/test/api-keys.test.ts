import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ApiKeyState, ApiKeysView, ApiKeyTest, ServerEvent } from '../../shared/types.ts';
import { ApiKeys } from '../src/api-keys.ts';
import { backup } from '../src/backup.ts';
import { EventHub } from '../src/events.ts';
import { type LogLevel, setLogLevel } from '../src/log.ts';
import { failOnEscapedErrors, freePort, startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

failOnEscapedErrors();

// Fake keys only, in a shape no real key has (the dots), so nothing here is ever a real credential.
const SAVED = 'sk-ant-fake.kevin.saved.0001';
const SAVED_2 = 'sk-ant-fake.kevin.saved.0002';
const ENV = 'sk-ant-fake.stuart.env.0001';
const OPENAI = 'sk-fake.bob.openai.0001';

interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
}

/** A plain-HTTP loopback stand-in for a provider's model list: what it answers is up to the test. */
async function fakeProvider(answer: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<{ origin: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    await answer(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Two pages of an Anthropic-shaped list; the first echoes the key back in places a careless parser would keep. */
function anthropicPages(key: () => string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.searchParams.get('after_id')) {
      return json(res, 200, {
        data: [
          {
            type: 'model',
            id: 'claude-kevin-1',
            display_name: 'Claude Kevin 1',
            lifecycle: 'active',
            capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } } },
          },
          { type: 'model', id: 'claude-stuart-0', display_name: `ignore ${key()} <script>`, lifecycle: 'deprecated', capabilities: { image_input: { supported: false }, effort: { supported: false } } },
          { type: 'model', id: `echo-${key()}`, display_name: 'Echo' },
          { type: 'model', id: 'has spaces and <html>', display_name: 'Bad' },
          { type: 'model', id: 'claude-bob-2' },
        ],
        has_more: true,
        first_id: 'claude-kevin-1',
        last_id: 'claude-bob-2',
        note: `free text with the key ${key()}`,
      });
    }
    json(res, 200, { data: [{ type: 'model', id: 'claude-dave-3', capabilities: null }], has_more: false, last_id: 'claude-dave-3' });
  };
}

const anyKey = (text: string, ...keys: string[]) => keys.some((k) => text.includes(k));

test('owner key CRUD: masked state, generations, stale saves refused, removal falls back to the environment and says so', async () => {
  // npm test runs at warn; the info lines Server events would show are what this checks.
  setLogLevel('info');
  const provider = await fakeProvider(anthropicPages(() => SAVED));
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ENV }, testEndpoints: { anthropic: provider.origin } } } });
  const stream = await s.events();
  try {
    let view = (await s.call<ApiKeysView>('GET', '/api/api-keys')).data;
    const anth = () => view.providers.find((p) => p.provider === 'anthropic')!;
    assert.deepEqual(
      view.providers.map((p) => [p.provider, p.source, p.saved, p.environment, p.brain.available]),
      [
        ['anthropic', 'environment', false, true, true],
        ['openai', 'none', false, false, false],
      ],
    );
    assert.equal(anth().envVar, 'ANTHROPIC_API_KEY');
    assert.ok(!anyKey(JSON.stringify(view), ENV), 'the environment key is never in an answer');

    // Nothing saved: a removal is refused and names where the key in use comes from, instead of pretending.
    const none = await s.call('DELETE', '/api/api-keys/anthropic', { generation: 0 });
    assert.equal(none.status, 404);
    assert.match(none.data.error, /ANTHROPIC_API_KEY in the server's environment/);

    // Shape checks never repeat the value.
    for (const [key, why] of [
      ['short', /not an API key/],
      ['sk-fake.not.anthropic.0001', /starts with sk-ant-/],
      ['sk-ant-admin.fake.0001.x', /Admin API key/],
    ] as const) {
      const r = await s.call('PUT', '/api/api-keys/anthropic', { key, generation: 0 });
      assert.equal(r.status, 400);
      assert.match(r.data.error, why);
      assert.ok(!r.text.includes(key), 'an error never echoes the key');
    }
    const crossed = await s.call('PUT', '/api/api-keys/openai', { key: SAVED, generation: 0 });
    assert.equal(crossed.status, 400);
    assert.ok(!crossed.text.includes(SAVED));
    assert.equal((await s.call('PUT', '/api/api-keys/gemini', { key: SAVED, generation: 0 })).status, 404);

    const saved = await s.call<ApiKeyState>('PUT', '/api/api-keys/anthropic', { key: `  ${SAVED}\n`, generation: 0 });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.data.source, saved.data.saved, saved.data.generation, saved.data.test], ['saved', true, 1, null]);
    assert.ok(!anyKey(saved.text, SAVED, ENV));

    // The page that loaded generation 0 can't overwrite the key saved since.
    const stale = await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED_2, generation: 0 });
    assert.equal(stale.status, 409);
    assert.equal((await s.call('DELETE', '/api/api-keys/anthropic', { generation: 0 })).status, 409);
    assert.equal((await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED_2 })).status, 400, 'a change must name the generation it saw');

    // Stored as typed, in the database only.
    const row = s.app.store.db.prepare("select value from settings where key = 'apiKey:anthropic'").get() as { value: string };
    assert.equal(JSON.parse(row.value).key, SAVED);

    const replaced = await s.call<ApiKeyState>('PUT', '/api/api-keys/anthropic', { key: SAVED_2, generation: 1 });
    assert.equal(replaced.data.generation, 2);

    const removed = await s.call<ApiKeyState>('DELETE', '/api/api-keys/anthropic', { generation: 2 });
    assert.equal(removed.status, 200);
    assert.deepEqual([removed.data.source, removed.data.saved, removed.data.generation], ['environment', false, 3]);
    // The row stays as a keyless tombstone, so the generation never goes back.
    assert.deepEqual(JSON.parse((s.app.store.db.prepare("select value from settings where key = 'apiKey:anthropic'").get() as { value: string }).value), {
      key: null,
      generation: 3,
      savedAt: null,
      test: null,
    });
    view = (await s.call<ApiKeysView>('GET', '/api/api-keys')).data;
    assert.equal(anth().generation, 3);

    // The audit log names what happened, never a key.
    const audit = await s.call<{ action: string; details: Record<string, unknown> }[]>('GET', '/api/audit?limit=50');
    const mine = audit.data.filter((e) => e.action.startsWith('api_key.'));
    assert.deepEqual(
      mine.map((e) => e.action),
      ['api_key.removed', 'api_key.saved', 'api_key.saved'],
    );
    assert.deepEqual(mine[0].details, { nowUses: 'environment' });
    assert.deepEqual(mine[1].details, { replaced: true });
    assert.ok(!anyKey(audit.text, SAVED, SAVED_2, ENV));

    // Events carry the same masked state.
    await until(() => stream.events.filter((e) => e.type === 'api_keys.updated').length >= 3);
    assert.ok(!anyKey(JSON.stringify(stream.events), SAVED, SAVED_2, ENV));
    const last = stream.events.filter((e): e is Extract<ServerEvent, { type: 'api_keys.updated' }> => e.type === 'api_keys.updated').at(-1)!;
    assert.equal(last.view.providers[0].source, 'environment');

    // Server events (the recent log) say a key was saved, never which.
    const logs = await s.call('GET', '/api/logs?limit=200');
    assert.ok(!anyKey(logs.text, SAVED, SAVED_2, ENV));
    assert.ok(logs.text.includes('api_key.saved'));
  } finally {
    setLogLevel((process.env.BOTONS_LOG_LEVEL as LogLevel | undefined) ?? 'info');
    stream.close();
    provider.server.close();
  }
});

test('Boton tokens get 403 from every API key route, sandboxed or not', async () => {
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ENV } } } });
  const bot = s.storeBot('Kevin');
  for (const sandboxed of [false, true]) {
    const boton = s.app.auth.mintBotonToken(bot.id, { sandboxed });
    try {
      for (const [method, path, body] of [
        ['GET', '/api/api-keys', undefined],
        ['PUT', '/api/api-keys/anthropic', { key: SAVED, generation: 0 }],
        ['DELETE', '/api/api-keys/anthropic', { generation: 0 }],
        ['POST', '/api/api-keys/anthropic/test', {}],
      ] as const) {
        const r = await s.call(method, path, body, boton.token);
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.ok(!anyKey(r.text, ENV));
      }
    } finally {
      boton.revoke();
    }
  }
  assert.equal((await s.call('GET', '/api/api-keys', undefined, null)).status, 401);
  const row = s.app.store.db.prepare("select value from settings where key = 'apiKey:anthropic'").get();
  assert.equal(row, undefined, 'nothing was saved');
});

test('Test key lists models read-only and keeps only expected shapes, with capability evidence from the list itself', async () => {
  const anthropic = await fakeProvider(anthropicPages(() => SAVED));
  const openai = await fakeProvider((_req, res) =>
    json(res, 200, { object: 'list', data: [{ id: 'gpt-kevin', object: 'model', created: 1, owned_by: 'system' }, { id: 'whisper-stuart', object: 'model' }, { id: `x-${OPENAI}` }] }),
  );
  const s = await startServer({ appOptions: { apiKeys: { env: {}, testEndpoints: { anthropic: anthropic.origin, openai: openai.origin } } } });
  try {
    assert.equal((await s.call('POST', '/api/api-keys/anthropic/test')).status, 400, 'no key, nothing to test');
    assert.equal(anthropic.seen.length, 0);

    await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED, generation: 0 });
    const r = await s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test');
    assert.equal(r.status, 200);
    const t = r.data;
    assert.deepEqual([t.outcome, t.httpStatus, t.source, t.generation, t.current, t.truncated], ['ok', 200, 'saved', 1, true, false]);
    assert.deepEqual(
      t.models.map((m) => m.id),
      ['claude-kevin-1', 'claude-stuart-0', 'claude-bob-2', 'claude-dave-3'],
    );
    assert.equal(t.omitted, 2, 'the id holding the key and the id of the wrong shape');
    const [kevin, stuart, bob] = t.models;
    assert.deepEqual(kevin, {
      id: 'claude-kevin-1',
      displayName: 'Claude Kevin 1',
      lifecycle: 'active',
      capabilities: { chat: 'unknown', tools: 'unknown', vision: 'yes', realtimeVoice: 'unknown', speechToText: 'unknown', textToSpeech: 'unknown' },
      effort: ['low', 'medium', 'high', 'max'],
    });
    assert.deepEqual([stuart.displayName, stuart.lifecycle, stuart.capabilities.vision, stuart.effort], [null, 'deprecated', 'no', []]);
    assert.deepEqual([bob.capabilities.vision, bob.effort], ['unknown', null], 'no capability field: unknown, never guessed');
    assert.ok(!anyKey(r.text, SAVED), 'nothing the provider echoed reaches the answer');
    assert.ok(!r.text.includes('free text'));

    // Exactly the documented read-only requests, with the key only in its header.
    assert.deepEqual(
      anthropic.seen.map((x) => x.path),
      ['/v1/models?limit=1000', '/v1/models?limit=1000&after_id=claude-bob-2'],
    );
    for (const x of anthropic.seen) {
      assert.equal(x.headers['x-api-key'], SAVED);
      assert.equal(x.headers['anthropic-version'], '2023-06-01');
      assert.equal(x.headers.authorization, undefined);
    }

    // Kept with the key it is about: the state shows it, a restart keeps it.
    const state = (await s.call<ApiKeysView>('GET', '/api/api-keys')).data.providers[0];
    assert.equal(state.test?.outcome, 'ok');
    assert.equal(state.test?.models.length, 4);
    assert.ok(!anyKey(JSON.stringify(state), SAVED));

    await s.call('PUT', '/api/api-keys/openai', { key: OPENAI, generation: 0 });
    const o = (await s.call<ApiKeyTest>('POST', '/api/api-keys/openai/test')).data;
    assert.equal(o.outcome, 'ok');
    assert.deepEqual(
      o.models.map((m) => m.id),
      ['gpt-kevin', 'whisper-stuart'],
    );
    assert.equal(o.omitted, 1);
    // OpenAI's list has no capability fields: everything is unknown, whatever the name suggests.
    for (const m of o.models) {
      assert.ok(Object.values(m.capabilities).every((v) => v === 'unknown'), m.id);
      assert.equal(m.effort, null);
    }
    assert.deepEqual([openai.seen[0].path, openai.seen[0].headers.authorization, openai.seen[0].headers['x-api-key']], ['/v1/models', `Bearer ${OPENAI}`, undefined]);

    const audit = await s.call('GET', '/api/audit?limit=50');
    assert.ok(audit.text.includes('api_key.tested'));
    assert.ok(!anyKey(audit.text, SAVED, OPENAI));
  } finally {
    anthropic.server.close();
    openai.server.close();
  }
});

test('model metadata cannot echo key fragments, case changes or common encodings into responses or events', async () => {
  for (const providerName of ['anthropic', 'openai'] as const) {
    const prefix = providerName === 'anthropic' ? 'sk-ant-fake.' : 'sk-fake.';
    const key = prefix + 'AbCd1234.KeyMaterial.XyZ9876.'.repeat(5);
    const fragments = Array.from({ length: Math.ceil(key.length / 50) }, (_, i) => key.slice(i * 50, (i + 1) * 50));
    const variants = [
      ...fragments.filter((f) => f.length >= 8),
      key.slice(15, 40).toUpperCase(),
      Buffer.from(key).toString('hex').slice(12, 72),
      Buffer.from(key).toString('base64url').slice(8, 68),
    ].map((v) => `echo-${v}`);
    let cursor = false;
    const fake = await fakeProvider((_req, res) => json(res, 200, {
      data: [...variants.map((id) => ({ id })), { id: 'model-kevin', display_name: variants[0] }],
      has_more: cursor,
      last_id: variants[0],
    }));
    const s = await startServer({ appOptions: { apiKeys: { env: {}, testEndpoints: { [providerName]: fake.origin } } } });
    const stream = await s.events();
    try {
      assert.equal((await s.call('PUT', `/api/api-keys/${providerName}`, { key, generation: 0 })).status, 200);
      const answer = await s.call<ApiKeyTest>('POST', `/api/api-keys/${providerName}/test`);
      assert.deepEqual(answer.data.models.map((m) => [m.id, m.displayName]), [['model-kevin', null]]);
      const state = await s.call<ApiKeysView>('GET', '/api/api-keys');
      await until(() => stream.events.some((e) => e.type === 'api_keys.updated'));
      const serialized = answer.text + state.text + JSON.stringify(stream.events);
      for (const v of variants) assert.ok(!serialized.includes(v), 'provider echo is omitted from every serialized view');
      if (providerName === 'anthropic') {
        cursor = true;
        const badCursor = await s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test');
        assert.equal(badCursor.data.outcome, 'unexpected');
        assert.equal(fake.seen.length, 2, 'a cursor containing a key fragment is never sent back');
      }
    } finally {
      stream.close();
      fake.server.close();
    }
  }
});

test('Test key reports fixed outcomes, never the provider text, and never follows a redirect', async () => {
  let mode = 'ok';
  const elsewhere = await fakeProvider((_req, res) => json(res, 200, { data: [{ id: 'stolen' }] }));
  const provider = await fakeProvider((_req, res) => {
    const echo = { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${SAVED}` } };
    if (mode === '401') return json(res, 401, echo);
    if (mode === '403') return json(res, 403, echo);
    if (mode === '429') return json(res, 429, echo);
    if (mode === '529') return json(res, 529, echo);
    if (mode === '302') {
      res.writeHead(302, { location: `${elsewhere.origin}/v1/models` });
      return res.end();
    }
    if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`not json ${SAVED}`);
    }
    json(res, 200, { data: [] });
  });
  const s = await startServer({ appOptions: { apiKeys: { env: {}, testEndpoints: { anthropic: provider.origin } } } });
  try {
    await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED, generation: 0 });
    const expected: [string, string, number | null][] = [
      ['401', 'invalid', 401],
      ['403', 'forbidden', 403],
      ['429', 'rate_limited', 429],
      ['529', 'unavailable', 529],
      ['302', 'unexpected', 302],
      ['garbage', 'unexpected', 200],
    ];
    for (const [m, outcome, status] of expected) {
      mode = m;
      const r = await s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test');
      assert.equal(r.status, 200, m);
      assert.deepEqual([r.data.outcome, r.data.httpStatus, r.data.models], [outcome, status, []], m);
      assert.ok(!anyKey(r.text, SAVED), m);
      assert.ok(!/authentication_error|invalid x-api-key|not json/.test(r.text), m);
    }
    assert.equal(elsewhere.seen.length, 0, 'the redirect was not followed, so the key went nowhere else');
  } finally {
    provider.server.close();
    elsewhere.server.close();
  }

  // Past the rate limit (6 a minute), on a fresh server.
  const p2 = await fakeProvider((_req, res) => {
    if (mode === 'no-data') return json(res, 200, { models: [] });
    if (mode === 'bad-cursor') return json(res, 200, { data: [{ id: 'claude-kevin-1' }], has_more: true, last_id: ENV });
    json(res, 200, { data: [] });
  });
  const s2 = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ENV }, testEndpoints: { anthropic: p2.origin } } } });
  try {
    mode = 'no-data';
    assert.equal((await s2.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test')).data.outcome, 'unexpected');
    mode = 'bad-cursor';
    const bad = await s2.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test');
    assert.equal(bad.data.outcome, 'unexpected', 'a cursor holding the key is never sent back');
    assert.equal(p2.seen.length, 2);
    mode = 'ok';
    for (let i = 0; i < 4; i++) assert.equal((await s2.call('POST', '/api/api-keys/anthropic/test')).status, 200);
    const limited = await s2.call('POST', '/api/api-keys/anthropic/test');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.res.headers.get('retry-after')) >= 1);
    assert.equal(p2.seen.length, 6);
  } finally {
    p2.server.close();
  }
});

test('an unreachable provider and a time limit are "unreachable"', async () => {
  const closed = `http://127.0.0.1:${await freePort()}`;
  const hang = await fakeProvider(() => {});
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ENV, OPENAI_API_KEY: OPENAI }, testEndpoints: { anthropic: closed, openai: hang.origin }, timeoutMs: 300 } } });
  try {
    const a = (await s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test')).data;
    assert.deepEqual([a.outcome, a.httpStatus, a.source], ['unreachable', null, 'environment']);
    const o = (await s.call<ApiKeyTest>('POST', '/api/api-keys/openai/test')).data;
    assert.deepEqual([o.outcome, o.httpStatus], ['unreachable', null]);
  } finally {
    hang.server.closeAllConnections();
    hang.server.close();
  }
});

test('one test at a time; a key changed mid-test stops it, and its late result never marks the new key', async () => {
  let release: (() => void) | null = null;
  const provider = await fakeProvider(async (_req, res) => {
    await new Promise<void>((r) => (release = r));
    json(res, 200, { data: [{ id: 'claude-kevin-1' }], has_more: false });
  });
  const s = await startServer({ appOptions: { apiKeys: { env: {}, testEndpoints: { anthropic: provider.origin } } } });
  try {
    await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED, generation: 0 });
    const first = s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test');
    await until(() => provider.seen.length === 1);
    assert.equal((await s.call<ApiKeysView>('GET', '/api/api-keys')).data.providers[0].testing, true);
    const second = await s.call('POST', '/api/api-keys/anthropic/test');
    assert.equal(second.status, 409, 'single flight');

    // Rotate while the first is in flight.
    const rotated = await s.call<ApiKeyState>('PUT', '/api/api-keys/anthropic', { key: SAVED_2, generation: 1 });
    assert.equal(rotated.data.generation, 2);
    (release as (() => void) | null)?.();
    const late = (await first).data;
    assert.equal(late.current, false);
    assert.equal(late.generation, 1);
    const now = (await s.call<ApiKeysView>('GET', '/api/api-keys')).data.providers[0];
    assert.deepEqual([now.generation, now.test, now.testing], [2, null, false], 'the new key is untested');

    // A removal mid-test stops it the same way.
    const third = s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test');
    await until(() => provider.seen.length === 2);
    await s.call('DELETE', '/api/api-keys/anthropic', { generation: 2 });
    (release as (() => void) | null)?.();
    assert.equal((await third).data.current, false);
    const gone = (await s.call<ApiKeysView>('GET', '/api/api-keys')).data.providers[0];
    assert.deepEqual([gone.source, gone.test], ['none', null]);
    const row = JSON.parse((s.app.store.db.prepare("select value from settings where key = 'apiKey:anthropic'").get() as { value: string }).value);
    assert.deepEqual(row, { key: null, generation: 3, savedAt: null, test: null }, 'the tombstone keeps no test');
  } finally {
    provider.server.closeAllConnections();
    provider.server.close();
  }
});

test('a saved test outlives a restart; a test of the environment key does not, and a saved key stays in backups', async () => {
  const provider = await fakeProvider((_req, res) => json(res, 200, { data: [{ id: 'claude-kevin-1' }], has_more: false }));
  const home = tempDir();
  const opts = { home, appOptions: { apiKeys: { env: { OPENAI_API_KEY: OPENAI }, testEndpoints: { anthropic: provider.origin, openai: provider.origin } } } };
  const s = await startServer(opts);
  await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED, generation: 0 });
  assert.equal((await s.call<ApiKeyTest>('POST', '/api/api-keys/anthropic/test')).data.outcome, 'ok');
  assert.equal((await s.call<ApiKeyTest>('POST', '/api/api-keys/openai/test')).data.outcome, 'ok');
  await s.stop();

  const again = await startServer({ ...opts, token: s.token });
  try {
    const [anthropic, openai] = (await again.call<ApiKeysView>('GET', '/api/api-keys')).data.providers;
    assert.deepEqual([anthropic.source, anthropic.test?.outcome, anthropic.test?.current], ['saved', 'ok', true]);
    assert.deepEqual([openai.source, openai.test], ['environment', null]);
  } finally {
    await again.stop();
    provider.server.close();
  }

  // The backup is the database: the saved key is in it (backups are private folders), and comes back with a restore.
  const made = backup({ home });
  const copy = new DatabaseSync(join(made.dir, 'botons.db'), { readOnly: true });
  try {
    const row = copy.prepare("select value from settings where key = 'apiKey:anthropic'").get() as { value: string };
    assert.equal(JSON.parse(row.value).key, SAVED);
  } finally {
    copy.close();
  }
});

test('test endpoints are loopback plain HTTP only, set in code', () => {
  const db = new DatabaseSync(':memory:');
  const hub = new EventHub();
  for (const url of ['https://api.anthropic.com', 'http://example.com', 'http://10.0.0.1:80', 'http://127.0.0.1:9/v1', 'http://user@127.0.0.1:9']) {
    assert.throws(() => new ApiKeys({ db, hub, env: {}, testEndpoints: { anthropic: url } }), /tests only/, url);
  }
  assert.doesNotThrow(() => new ApiKeys({ db, hub, env: {}, testEndpoints: { openai: 'http://127.0.0.1:9' } }));
  db.close();
});

test('agent CLIs never get a saved or environment API key: not in argv, env, stdin or their MCP files', async () => {
  const home = tempDir('botons-api-keys-');
  useTestCodexHome(home);
  process.env.ANTHROPIC_API_KEY = ENV;
  process.env.OPENAI_API_KEY = OPENAI;
  try {
    // The real default: the server reads its own environment.
    const s = await startServer({ home, fakeClis: true, appOptions: { apiKeys: { env: process.env } } });
    const state = (await s.call<ApiKeysView>('GET', '/api/api-keys')).data;
    assert.deepEqual(
      state.providers.map((p) => p.source),
      ['environment', 'environment'],
    );
    await s.call('PUT', '/api/api-keys/anthropic', { key: SAVED, generation: 0 });
    for (const [cli, provider, fixture] of [
      [s.claude, 'claude-cli', 'claude/reply'],
      [s.codex, 'codex-cli', 'codex/reply'],
    ] as const) {
      const bot = s.storeBot(`${provider} Dave`, provider);
      cli.script(fixture);
      await s.chat(bot.id, 'hello');
      const calls = cli.calls();
      assert.ok(calls.length >= 1, provider);
      for (const c of calls) {
        const seen = JSON.stringify([c.argv, c.env, c.stdin, c.mcpConfigFile ?? '']);
        assert.ok(!anyKey(seen, SAVED, ENV, OPENAI), `${provider} got an API key`);
        assert.equal(c.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(c.env.OPENAI_API_KEY, undefined);
      }
    }
    // Nothing a turn left in the server's private run folder holds one either.
    const run = join(home, 'run');
    for (const f of readdirSync(run, { recursive: true, encoding: 'utf8' })) {
      try {
        assert.ok(!anyKey(readFileSync(join(run, f), 'utf8'), SAVED, ENV, OPENAI), f);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err;
      }
    }
    await s.stop();
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }
});

test('API snapshots agree with read-only provider state through key save, testing and removal', async () => {
  const provider = await fakeProvider((_req, res) => json(res, 200, { data: [{ id: 'model-kevin' }], has_more: false }));
  const s = await startServer({ appOptions: { apiKeys: { env: {}, testEndpoints: { anthropic: provider.origin, openai: provider.origin } } } });
  try {
    for (const [name, key] of [['anthropic', SAVED], ['openai', OPENAI]] as const) {
      const check = async () => {
        const info = await s.app.providers.get(`${name}-api`)!.info();
        const before = provider.seen.length;
        const snapshot = s.app.providers.snapshots().find((p) => p.id === `${name}-api`)!;
        for (const [field, value] of Object.entries(info)) assert.deepEqual((snapshot as any)[field], value, `${name}: ${field}`);
        assert.equal(provider.seen.length, before, 'snapshot starts no request');
      };
      await check();
      assert.equal((await s.call('PUT', `/api/api-keys/${name}`, { key, generation: 0 })).status, 200);
      await check();
      assert.equal((await s.call('POST', `/api/api-keys/${name}/test`, {})).status, 200);
      await check();
      assert.equal((await s.call('DELETE', `/api/api-keys/${name}`, { generation: 1 })).status, 200);
      await check();
    }
  } finally {
    provider.server.closeAllConnections();
    provider.server.close();
  }
});
