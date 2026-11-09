import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { test } from 'node:test';
import type { CreateRoutineInput, Routine, RunPayload, RunStatus, ServerEvent, ServerInfo } from '../../shared/types.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { PUBLIC_WAIT_MAX_S, waitSeconds } from '../src/hooks.ts';
import { captureLogs } from '../src/log.ts';
import { deliveryId, deliveryKeys, handshake, matchesFilter, parseDelivery, parseFilter, shownHeaders, verifySignature } from '../src/webhooks.ts';
import { failOnEscapedErrors, freePort, botonCli, startServer, tempDir, until } from './helpers.ts';

const hex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

// The webhook listener on a port of its own, as when it is public.
const PUBLIC_URL = 'https://myhost.example-tailnet.ts.net:8443';
const hooksPort = await freePort();
const s = await startServer({
  env: { BOTONS_HOOKS_PORT: String(hooksPort), BOTONS_HOOKS_PUBLIC_URL: PUBLIC_URL },
  configure: (cfg) => {
    cfg.hooks.timeoutMs = 400;
  },
});
const { app, base, call, mock, token: device } = s;
const hooksBase = `http://127.0.0.1:${hooksPort}`;
failOnEscapedErrors();

/** A Boton with a webhook routine ("On delivery"). */
async function newRoutine(input: Partial<CreateRoutineInput> = {}) {
  const bot = await s.newBot(`Hook ${Math.random().toString(36).slice(2, 6)}`);
  return { bot, routine: await s.newRoutine(bot.id, { name: 'On delivery', instruction: 'Summarize it', webhook: true, ...input }) };
}

const runEnded = (routineId: string, runId: string, status: RunStatus = 'succeeded') => until(async () => (await s.runsOf(routineId)).find((r) => r.id === runId && r.status === status));

/** Assert the response's status; returns its JSON body. */
async function answer(res: Response | Promise<Response>, status: number, label?: string): Promise<any> {
  const r = await res;
  if (label) assert.equal(r.status, status, label);
  else assert.equal(r.status, status);
  return r.json();
}

/** POST to the public listener. */
const deliver = (routine: Routine, body: string, headers: Record<string, string>, query = '') => fetch(`${hooksBase}/hooks/routines/${routine.id}${query}`, { method: 'POST', headers, body });

function github(routine: Routine, event: string, payload: unknown, opts: { delivery?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  return deliver(routine, body, {
    'content-type': 'application/json',
    'user-agent': 'GitHub-Hookshot/abc123',
    'x-github-event': event,
    'x-github-delivery': opts.delivery ?? crypto.randomUUID(),
    'x-hub-signature-256': `sha256=${hex(opts.secret ?? routine.webhook!.key, body)}`,
  });
}

function slack(routine: Routine, secret: string, payload: unknown, opts: { at?: number; headers?: Record<string, string> } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  return deliver(routine, body, {
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${hex(secret, `v0:${ts}:${body}`)}`,
    ...opts.headers,
  });
}

test("signatures: GitHub's and Slack's published vectors, Linear's timestamp, Sentry's; a changed body, secret or timestamp fails", () => {
  // GitHub: without a signing secret the routine's key is the secret.
  const secrets = { key: 'unused', secret: "It's a Secret to Everybody" };
  const headers = { 'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17' };
  assert.equal(verifySignature('github', secrets, headers, Buffer.from('Hello, World!'), undefined), null);
  assert.match(verifySignature('github', secrets, headers, Buffer.from('Hello, World?'), undefined)!, /X-Hub-Signature-256/);
  assert.match(verifySignature('github', { ...secrets, secret: 'other' }, headers, Buffer.from('Hello, World!'), undefined)!, /X-Hub-Signature-256/);
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  assert.equal(verifySignature('github', { key: 'the-key', secret: null }, { 'x-hub-signature-256': `sha256=${hex('the-key', body)}` }, body, undefined), null);
  assert.match(verifySignature('github', secrets, { 'x-hub-signature': 'sha1=abc' }, Buffer.from('Hello, World!'), undefined)!, /missing/);

  const slackSecrets = { key: 'unused', secret: '8f742231b10e8888abcd99yyyzzz85a5' };
  const slackBody = Buffer.from(
    'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
  );
  const slackHeaders = { 'x-slack-request-timestamp': '1531420618', 'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503' };
  const then = 1531420618 * 1000;
  assert.equal(verifySignature('slack', slackSecrets, slackHeaders, slackBody, undefined, then + 30_000), null);
  assert.equal(verifySignature('slack', slackSecrets, slackHeaders, slackBody, undefined, then + 6 * 60_000), 'Stale X-Slack-Request-Timestamp');
  assert.equal(verifySignature('slack', slackSecrets, slackHeaders, slackBody, undefined, then - 6 * 60_000), 'Stale X-Slack-Request-Timestamp');
  assert.match(verifySignature('slack', slackSecrets, slackHeaders, Buffer.concat([slackBody, Buffer.from('x')]), undefined, then)!, /X-Slack-Signature/);
  assert.match(verifySignature('slack', slackSecrets, { ...slackHeaders, 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)) }, slackBody, undefined)!, /X-Slack-Signature/);
  assert.equal(verifySignature('slack', { key: 'k', secret: null }, slackHeaders, slackBody, undefined, then), 'This routine has no Slack signing secret yet');

  const secret = 'lin_wh_secret';
  const now = Date.now();
  const linear = (ts: number) => {
    const body = Buffer.from(JSON.stringify({ action: 'create', type: 'Issue', data: { id: 'x' }, webhookTimestamp: ts }));
    return { body, json: JSON.parse(body.toString()), headers: { 'linear-signature': hex(secret, body) } };
  };
  const fresh = linear(now - 5000);
  assert.equal(verifySignature('linear', { key: 'k', secret }, fresh.headers, fresh.body, fresh.json, now), null);
  const stale = linear(now - 90_000);
  assert.equal(verifySignature('linear', { key: 'k', secret }, stale.headers, stale.body, stale.json, now), 'Stale or missing webhookTimestamp');
  assert.match(verifySignature('linear', { key: 'k', secret: 'wrong' }, fresh.headers, fresh.body, fresh.json, now)!, /Linear-Signature/);
  assert.match(verifySignature('linear', { key: 'k', secret: null }, fresh.headers, fresh.body, fresh.json, now)!, /no Linear signing secret/);

  const sentry = Buffer.from('{"action":"created","data":{"issue":{"id":"1"}}}');
  assert.equal(verifySignature('sentry', { key: 'k', secret: 's' }, { 'sentry-hook-signature': hex('s', sentry) }, sentry, undefined), null);
  assert.match(verifySignature('sentry', { key: 'k', secret: 's' }, { 'sentry-hook-signature': hex('t', sentry) }, sentry, undefined)!, /Sentry-Hook-Signature/);
});

test('bodies: JSON and text stay as sent, forms become JSON (a lone payload= field its JSON), empty is none', () => {
  assert.deepEqual(parseDelivery(Buffer.from('{"a":1}'), 'application/json'), { payload: '{"a":1}', json: { a: 1 } });
  assert.deepEqual(parseDelivery(Buffer.from('plain words'), 'text/plain'), { payload: 'plain words', json: undefined });
  assert.deepEqual(parseDelivery(Buffer.from('  \n'), undefined), { payload: null, json: undefined });
  const form = parseDelivery(Buffer.from('command=%2Fdeploy&text=prod+now&tag=a&tag=b&__proto__=x'), 'application/x-www-form-urlencoded; charset=utf-8');
  assert.deepEqual(JSON.parse(form.payload!), JSON.parse('{"command":"/deploy","text":"prod now","tag":["a","b"],"__proto__":"x"}'));
  assert.equal(Object.getPrototypeOf(form.json), null);
  assert.equal((form.json as Record<string, unknown>).text, 'prod now');
  const github = parseDelivery(Buffer.from(`payload=${encodeURIComponent('{"action":"opened","number":7}')}`), 'application/x-www-form-urlencoded');
  assert.deepEqual(github, { payload: '{"action":"opened","number":7}', json: { action: 'opened', number: 7 } });
});

test('handshakes, delivery ids, shown headers and filters', () => {
  assert.deepEqual(handshake('slack', {}, { type: 'url_verification', challenge: 'c-123' }), { challenge: 'c-123' });
  assert.equal(handshake('generic', {}, { type: 'url_verification', challenge: 'c-123' }), null, 'only for Slack routines');
  assert.deepEqual(handshake('slack', {}, { ssl_check: '1' }), { ok: true, skipped: true, reason: 'Slack SSL check' });
  assert.deepEqual(handshake('github', { 'x-github-event': 'ping' }, {}), { ok: true, skipped: true, reason: 'GitHub ping' });
  assert.equal(handshake('github', { 'x-github-event': 'push' }, {}), null);

  // A signed source goes by its own id, never the unsigned Idempotency-Key.
  assert.equal(deliveryId('github', { 'x-github-delivery': 'd-1', 'idempotency-key': 'i-1' }, {}), 'd-1');
  assert.equal(deliveryId('slack', { 'idempotency-key': 'i-1' }, { event_id: 'Ev1' }), 'Ev1');
  assert.equal(deliveryId('slack', { 'idempotency-key': 'i-1' }, {}), null);
  assert.equal(deliveryId('generic', { 'idempotency-key': ' i-1 ' }, {}), 'i-1');
  const bytes = Buffer.from('{"a":1}');
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.deepEqual(deliveryKeys('github', 'd-1', bytes), ['d-1', hash]);
  assert.deepEqual(deliveryKeys('sentry', null, bytes), [hash]);
  assert.deepEqual(deliveryKeys('generic', 'i-1', bytes), ['i-1']);
  assert.deepEqual(deliveryKeys('generic', null, bytes), []);
  assert.equal(deliveryId('linear', { 'linear-delivery': 'l-1' }, {}), 'l-1');
  assert.equal(deliveryId('sentry', { 'request-id': 'r-1' }, {}), 'r-1');
  assert.equal(deliveryId('generic', { 'x-github-delivery': 'd-1' }, {}), null, 'a generic routine goes by Idempotency-Key only');
  assert.equal(deliveryId('generic', { 'idempotency-key': 'x'.repeat(201) }, {}), null);

  assert.deepEqual(shownHeaders({ 'content-type': 'application/json', 'x-github-event': 'push', authorization: 'Bearer k', 'x-hub-signature-256': 'sha256=ab', cookie: 'c' }), {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'push',
  });
  assert.equal(shownHeaders({ authorization: 'Bearer k' }), null);

  const byHeader = parseFilter({ kind: 'header', name: ' X-GitHub-Event ', values: ['push', ' pull_request', 'push'] })!;
  assert.deepEqual(byHeader, { kind: 'header', name: 'X-GitHub-Event', values: ['push', 'pull_request'] });
  assert.ok(matchesFilter(byHeader, { 'x-github-event': 'pull_request' }, {}));
  assert.ok(!matchesFilter(byHeader, { 'x-github-event': 'issues' }, {}));
  const byField = parseFilter({ kind: 'field', name: 'pull_request.base.ref', values: ['main'] })!;
  assert.ok(matchesFilter(byField, {}, { pull_request: { base: { ref: 'main' } } }));
  assert.ok(!matchesFilter(byField, {}, { pull_request: { base: { ref: 'dev' } } }));
  assert.ok(!matchesFilter(byField, {}, undefined));
  assert.ok(matchesFilter(parseFilter({ kind: 'field', name: 'number', values: ['7'] })!, {}, { number: 7 }));
  assert.ok(!matchesFilter(parseFilter({ kind: 'field', name: 'toString', values: ['x'] })!, {}, {}), 'only own fields');
  assert.equal(parseFilter(null), null);
  for (const bad of [{ kind: 'body', name: 'a', values: ['x'] }, { kind: 'header', name: 'Bad Header', values: ['x'] }, { kind: 'field', name: 'a..b', values: ['x'] }, { kind: 'field', name: 'a', values: [] }, 'x']) {
    assert.throws(() => parseFilter(bad));
  }
});

test('?wait on the public listener is capped at 30 s; on the main one at 30 minutes', () => {
  assert.equal(PUBLIC_WAIT_MAX_S, 30);
  assert.equal(waitSeconds('600', PUBLIC_WAIT_MAX_S), 30);
  assert.equal(waitSeconds(null, PUBLIC_WAIT_MAX_S), 30);
  assert.equal(waitSeconds('5', PUBLIC_WAIT_MAX_S), 5);
  assert.equal(waitSeconds(null, 1800), 300);
  assert.equal(waitSeconds('abc', 1800), 300);
  assert.equal(waitSeconds('99999', 1800), 1800);
  assert.equal(waitSeconds('0', 1800), 1);
});

test('BOTONS_HOOKS_PORT must differ from the main port, BOTONS_HOOKS_PUBLIC_URL must be a URL, and without it startup warns', async () => {
  const env = { BOTONS_HOME: tempDir('botons-hooks-cfg-'), BOTONS_NO_TAILSCALE: '1', BOTONS_PORT: '17001' };
  assert.throws(() => loadConfig({ ...env, BOTONS_HOOKS_PORT: '17001' }), (e: unknown) => e instanceof ConfigError && /must differ/.test(e.message));
  assert.throws(() => loadConfig({ ...env, BOTONS_HOOKS_PUBLIC_URL: 'ftp://x' }), (e: unknown) => e instanceof ConfigError && /BOTONS_HOOKS_PUBLIC_URL/.test(e.message));
  const cfg = loadConfig({ ...env, BOTONS_HOOKS_PORT: '17002', BOTONS_HOOKS_PUBLIC_URL: 'https://myhost.example-tailnet.ts.net:8443/' });
  assert.deepEqual(cfg.hooks, { port: 17002, hosts: ['127.0.0.1'], publicUrl: 'https://myhost.example-tailnet.ts.net:8443', timeoutMs: 30_000 });
  assert.equal(loadConfig(env).hooks.port, null);

  const warnings = async (publicUrl?: string) => {
    const logged = captureLogs();
    try {
      const srv = await startServer({ token: null, env: { BOTONS_HOOKS_PORT: String(await freePort()), ...(publicUrl ? { BOTONS_HOOKS_PUBLIC_URL: publicUrl } : {}) } });
      await srv.stop();
      return logged.lines.filter((l) => l.level === 'warn' && /BOTONS_HOOKS_PUBLIC_URL/.test(l.msg)).map((l) => l.msg);
    } finally {
      logged.restore();
    }
  };
  const [warning, ...rest] = await warnings();
  assert.equal(rest.length, 0);
  assert.match(warning, /BOTONS_HOOKS_PORT is set but BOTONS_HOOKS_PUBLIC_URL is not, so webhook URLs point at the main listener's URL \(http:\/\/127\.0\.0\.1:\d+\)/);
  assert.deepEqual(await warnings('https://myhost.example-tailnet.ts.net:8443'), []);
});

test('the public listener serves only /hooks (the API, the app and the event stream are 404 there); webhook URLs use BOTONS_HOOKS_PUBLIC_URL', async () => {
  const { routine } = await newRoutine();
  assert.equal(routine.webhook!.url, `${PUBLIC_URL}/hooks/routines/${routine.id}`);
  assert.equal((await call<ServerInfo>('GET', '/api/info')).data.hooksUrl, PUBLIC_URL);
  for (const path of ['/', '/index.html', '/api/bots', '/api/health', '/api/info', '/api/events', '/assets/x.js', `/api/routines/${routine.id}`]) {
    const res = await fetch(hooksBase + path, { headers: { authorization: `Bearer ${device}` } });
    assert.equal(res.status, 404, path);
  }
  const post = await fetch(`${hooksBase}/api/bots`, { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(post.status, 404);
  assert.equal((await fetch(`${hooksBase}/hooks/routines/${routine.id}`)).status, 405, 'GET of a hook route');
  const { runId } = await answer(deliver(routine, '{"hello":"world"}', { authorization: `Bearer ${routine.webhook!.key}`, 'content-type': 'application/json' }), 202);
  await runEnded(routine.id, runId);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await s.hook(routine)).status, 202);
});

test('a sender that stalls while sending its body is cut off after the timeout', { timeout: 10_000 }, async () => {
  const { routine } = await newRoutine();
  const u = new URL(hooksBase);
  const started = Date.now();
  const answer = await new Promise<string>((resolve, reject) => {
    const sock = connect(Number(u.port), u.hostname, () => {
      sock.write(
        `POST /hooks/routines/${routine.id} HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${routine.webhook!.key}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"partial":`,
      );
    });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => (data += d));
    sock.on('close', () => resolve(data));
    sock.on('error', reject);
  });
  const took = Date.now() - started;
  assert.ok(took >= 300 && took < 5000, `closed after ${took} ms`);
  assert.match(answer, /^HTTP\/1\.1 408/);
  assert.equal((await s.runsOf(routine.id)).length, 0, 'no run from a half-sent body');
});

test('GitHub through the public listener: signed deliveries run for the filtered events only, and the prompt shows X-GitHub-Event', async () => {
  const { routine } = await newRoutine({ webhookSource: 'github', webhookFilter: { kind: 'header', name: 'X-GitHub-Event', values: ['push'] } });
  assert.equal(routine.webhook!.source, 'github');
  assert.equal(routine.webhook!.hasSecret, false);
  assert.deepEqual(await answer(github(routine, 'ping', { zen: 'Design for failure.', hook_id: 1 }), 200), { ok: true, skipped: true, reason: 'GitHub ping' });
  assert.deepEqual(await answer(github(routine, 'issues', { action: 'opened' }), 200), { ok: true, skipped: true, reason: 'Filtered out' });
  // A bad signature, or the routine key on its own: 401.
  const forged = deliver(routine, '{"ref":"refs/heads/main"}', { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${hex('guess', '{"ref":"refs/heads/main"}')}` });
  assert.match((await answer(forged, 401)).error, /X-Hub-Signature-256/);
  const keyOnly = await deliver(routine, '{}', { authorization: `Bearer ${routine.webhook!.key}`, 'x-github-event': 'push' });
  assert.equal(keyOnly.status, 401);
  assert.equal((await s.runsOf(routine.id)).length, 0);

  const seen = mock.turns.length;
  const { runId } = await answer(github(routine, 'push', { ref: 'refs/heads/main', commits: [{ message: 'Fix it' }] }, { delivery: 'delivery-1' }), 202);
  const run = await runEnded(routine.id, runId);
  assert.deepEqual(run.headers, { 'Content-Type': 'application/json', 'User-Agent': 'GitHub-Hookshot/abc123', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'delivery-1' });
  const turn = mock.turns.slice(seen).find((t) => t.prompt.includes(routine.id))!;
  assert.match(turn.prompt, /trigger: webhook from GitHub, signature verified/);
  const block = /\nWebhook headers \(sent with the payload by the same outside system\):\n<webhook_headers id="([\w-]{12})">\n([\s\S]*?)\n<\/webhook_headers>\nWebhook payload/.exec(turn.prompt);
  assert.ok(block, turn.prompt);
  assert.equal(JSON.parse(block[2])['X-GitHub-Event'], 'push');
  assert.match(turn.prompt, new RegExp(`<webhook_payload id="${block[1]}">`), 'the same nonce on both blocks');
  assert.ok(!turn.prompt.includes('sha256='), 'no signature in the prompt');
  // GitHub's Redeliver: the same run.
  const again = github(routine, 'push', { ref: 'refs/heads/main', commits: [{ message: 'Fix it' }] }, { delivery: 'delivery-1' });
  assert.deepEqual(await answer(again, 200), { ok: true, runId, status: 'succeeded', duplicate: true });
  assert.equal((await s.runsOf(routine.id)).length, 1);

  // A signing secret of its own replaces the key.
  const { data: withSecret } = await call<Routine>('PATCH', `/api/routines/${routine.id}`, { webhookSecret: 'my-github-secret' });
  assert.equal(withSecret.webhook!.hasSecret, true);
  assert.ok(!JSON.stringify(withSecret).includes('my-github-secret'), 'the secret is write-only');
  assert.equal((await github(withSecret, 'push', { ref: 'x' })).status, 401);
  assert.equal((await github(withSecret, 'push', { ref: 'x' }, { secret: 'my-github-secret' })).status, 202);
});

test('Slack: url_verification gets its challenge back and creates no run; stale or unsigned requests are 401; a retry gets the first try\'s run, or runs if the first was refused', async () => {
  const secret = 'slack-signing-secret';
  const { routine } = await newRoutine({ webhookSource: 'slack', webhookSecret: secret });
  const challenge = slack(routine, secret, { token: 'unused', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P', type: 'url_verification' });
  assert.deepEqual(await answer(challenge, 200), { challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
  assert.equal((await s.runsOf(routine.id)).length, 0);
  assert.equal((await slack(routine, 'wrong', { type: 'url_verification', challenge: 'x' })).status, 401);
  const old = slack(routine, secret, { type: 'event_callback', event_id: 'Ev0', event: { type: 'app_mention' } }, { at: Date.now() - 10 * 60_000 });
  assert.equal((await answer(old, 401)).error, 'Stale X-Slack-Request-Timestamp');

  const event = { type: 'event_callback', event_id: 'Ev1', event: { type: 'app_mention', text: 'hi' } };
  const { runId } = await answer(slack(routine, secret, event), 202);
  const retry = await answer(slack(routine, secret, event, { headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' } }), 200);
  assert.deepEqual({ ...retry, status: undefined }, { ok: true, runId, status: undefined, duplicate: true });
  assert.equal((await s.runsOf(routine.id)).length, 1);

  // A first try that was refused started nothing, so Slack's retry runs.
  await call('PATCH', `/api/routines/${routine.id}`, { enabled: false });
  const missed = { type: 'event_callback', event_id: 'Ev2', event: { type: 'app_mention', text: 'while paused' } };
  assert.equal((await slack(routine, secret, missed)).status, 409);
  await call('PATCH', `/api/routines/${routine.id}`, { enabled: true });
  const secondId = (await answer(slack(routine, secret, missed, { headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_error' } }), 202)).runId;
  assert.notEqual(secondId, runId);
  const third = await slack(routine, secret, missed, { headers: { 'x-slack-retry-num': '2', 'x-slack-retry-reason': 'http_timeout' } });
  assert.equal((await third.json()).runId, secondId);
  assert.equal((await s.runsOf(routine.id)).length, 2);

  // A retry with no event_id can't be matched to its first try: dropped. Not a retry: it runs.
  const bare = await slack(routine, secret, { type: 'event_callback', event: { type: 'app_mention' } }, { headers: { 'x-slack-retry-num': '1' } });
  assert.deepEqual(await bare.json(), { ok: true, skipped: true, reason: 'Slack retry' });
  assert.equal((await s.runsOf(routine.id)).length, 2);
  assert.equal((await slack(routine, secret, { type: 'event_callback', event: { type: 'app_mention' } })).status, 202);
});

test('Linear: a signed delivery runs; a stale one is refused; a form body reaches the Boton as JSON', async () => {
  const secret = 'lin_wh_abc';
  const { routine } = await newRoutine({ webhookSource: 'linear', webhookSecret: secret, webhookFilter: { kind: 'field', name: 'type', values: ['Issue'] } });
  const send = (payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    return deliver(routine, body, { 'content-type': 'application/json', 'linear-event': String(payload.type), 'linear-delivery': crypto.randomUUID(), 'linear-signature': hex(secret, body) });
  };
  assert.equal((await send({ action: 'create', type: 'Issue', data: { title: 'Bug' }, webhookTimestamp: Date.now() })).status, 202);
  assert.equal((await send({ action: 'create', type: 'Comment', data: {}, webhookTimestamp: Date.now() })).status, 200, 'filtered');
  assert.equal((await send({ action: 'create', type: 'Issue', data: {}, webhookTimestamp: Date.now() - 5 * 60_000 })).status, 401);
  assert.equal((await s.runsOf(routine.id)).length, 1);

  const { routine: formRoutine } = await newRoutine();
  const form = { authorization: `Bearer ${formRoutine.webhook!.key}`, 'content-type': 'application/x-www-form-urlencoded' };
  const out = await (await deliver(formRoutine, 'command=%2Fdeploy&text=prod', form, '?wait=1&timeout=5')).json();
  assert.equal(out.status, 'succeeded');
  assert.match(out.reply, /"command": "\/deploy"/);
});

test('redeliveries: a captured signed delivery counts once whatever unsigned headers it changes; one whose run failed runs again; Idempotency-Key for a day', async () => {
  // Slack: the signed event_id wins over an unsigned Idempotency-Key.
  const secret = 'slack-replay-secret';
  const { routine: slackRoutine } = await newRoutine({ webhookSource: 'slack', webhookSecret: secret });
  const event = { type: 'event_callback', event_id: 'EvReplay', event: { type: 'app_mention', text: 'hi' } };
  const { runId } = await answer(slack(slackRoutine, secret, event), 202);
  for (const key of ['attacker-1', 'attacker-2']) {
    assert.equal((await answer(slack(slackRoutine, secret, event, { headers: { 'idempotency-key': key } }), 200, key)).runId, runId, key);
  }
  assert.equal((await s.runsOf(slackRoutine.id)).length, 1);

  // GitHub: X-GitHub-Delivery isn't signed, so the signed body counts too.
  const { routine } = await newRoutine({ webhookSource: 'github', instruction: 'Look at the push.' });
  const payload = { ref: 'refs/heads/replay', after: 'abc' };
  const ghRun = (await answer(github(routine, 'push', payload, { delivery: 'gh-1' }), 202)).runId;
  await runEnded(routine.id, ghRun);
  assert.deepEqual(await answer(github(routine, 'push', payload, { delivery: 'gh-forged' }), 200), { ok: true, runId: ghRun, status: 'succeeded', duplicate: true });
  assert.equal((await s.runsOf(routine.id)).length, 1);

  const { bot, routine: flaky } = await newRoutine({ webhookSource: 'github' });
  mock.failNext(bot.id, new Error('The CLI crashed'));
  const redeliver = () => github(flaky, 'push', { ref: 'refs/heads/flaky' }, { delivery: 'gh-flaky' });
  const failedRun = (await answer(redeliver(), 202)).runId;
  await runEnded(flaky.id, failedRun, 'failed');
  const retryRun = (await answer(redeliver(), 202)).runId;
  assert.notEqual(retryRun, failedRun);
  await runEnded(flaky.id, retryRun);
  const again = await (await redeliver()).json();
  assert.deepEqual([again.runId, again.duplicate], [retryRun, true]);
  assert.equal((await s.runsOf(flaky.id)).length, 2);

  const { routine: generic } = await newRoutine();
  const send = () => deliver(generic, '{"n":1}', { authorization: `Bearer ${generic.webhook!.key}`, 'content-type': 'application/json', 'idempotency-key': 'order-42' });
  const one = await (await send()).json();
  const two = await (await send()).json();
  assert.deepEqual([two.runId, two.duplicate], [one.runId, true]);
  app.store.db.prepare('update webhook_deliveries set created_at = ? where delivery_id = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), 'order-42');
  assert.notEqual((await (await send()).json()).runId, one.runId);
  // Only a Slack routine drops a retry it can't match.
  const fresh = await answer(deliver(generic, '{"n":2}', { authorization: `Bearer ${generic.webhook!.key}`, 'x-slack-retry-num': '1' }), 202);
  assert.ok(fresh.runId && fresh.runId !== one.runId && !fresh.skipped, JSON.stringify(fresh));
});

test('a 500 KB payload: run events and run lists carry a 2 KB preview; GET /api/runs/:id/payload has all of it', async () => {
  const { routine } = await newRoutine({ instruction: 'QUIET_PLEASE' });
  const events: ServerEvent[] = [];
  const unsubscribe = app.hub.subscribe((ev) => events.push(ev));
  // Multi-byte, so a cut inside a character would show.
  const big = JSON.stringify({ items: Array.from({ length: 25_000 }, (_, i) => `é${i}`.padEnd(16, 'x')) });
  assert.ok(Buffer.byteLength(big) > 500_000);
  const res = await deliver(routine, big, { authorization: `Bearer ${routine.webhook!.key}`, 'content-type': 'application/json' });
  const { runId } = await res.json();
  await runEnded(routine.id, runId);
  unsubscribe();

  const runEvents = events.filter((e): e is Extract<ServerEvent, { type: 'run.upserted' }> => e.type === 'run.upserted' && e.run.id === runId);
  assert.ok(runEvents.length >= 3);
  for (const e of runEvents) {
    assert.ok(JSON.stringify(e).length < 4096, `a run event is ${JSON.stringify(e).length} characters`);
    assert.ok(Buffer.byteLength(e.run.payloadPreview!) <= 2048);
    assert.equal(e.run.payloadBytes, Buffer.byteLength(big));
    assert.ok(big.startsWith(e.run.payloadPreview!));
    assert.ok(!('payload' in e.run));
  }
  const listed = (await s.runsOf(routine.id)).find((r) => r.id === runId)!;
  assert.ok(JSON.stringify(listed).length < 4096);
  const { status, data } = await call<RunPayload>('GET', `/api/runs/${runId}/payload`);
  assert.equal(status, 200);
  assert.equal(data.payload, big);
  assert.equal(data.bytes, Buffer.byteLength(big));
  assert.equal((await call('GET', '/api/runs/run_nope/payload')).status, 404);
  assert.equal((await fetch(`${base}/api/runs/${runId}/payload`)).status, 401, 'needs a token');
  const asBoton = async (botId: string, sandboxed: boolean) => {
    const t = app.auth.mintBotonToken(botId, { sandboxed });
    try {
      return (await call('GET', `/api/runs/${runId}/payload`, undefined, t.token)).status;
    } finally {
      t.revoke();
    }
  };
  assert.equal(await asBoton(routine.botId, false), 200);
  assert.equal(await asBoton(routine.botId, true), 403, 'a sandboxed turn of another run');
  const { bot: other } = await newRoutine();
  assert.equal(await asBoton(other.id, false), 403);
});

test('webhook settings: checked, write-only secrets, and dropped with the webhook', async () => {
  const { bot, routine } = await newRoutine({ webhookSource: 'sentry', webhookSecret: '  s3cret  ' });
  assert.deepEqual({ ...routine.webhook, url: undefined, key: undefined }, { url: undefined, key: undefined, source: 'sentry', hasSecret: true, filter: null, callbackUrl: null });
  assert.equal(app.store.webhookSecrets(routine.id)!.secret, 's3cret');
  for (const bad of [{ webhookSource: 'gitlab' }, { webhookFilter: { kind: 'header', name: 'X', values: [] } }, { webhookSecret: 42 }]) {
    assert.equal((await call('PATCH', `/api/routines/${routine.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', `/api/bots/${bot.id}/routines`, { name: 'x', instruction: 'y', webhook: true, webhookSource: 'gitlab' })).status, 400);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${routine.id}`, { webhookSecret: '' })).data.webhook!.hasSecret, false);
  await call('PATCH', `/api/routines/${routine.id}`, { webhookSecret: 'again', webhookFilter: { kind: 'field', name: 'action', values: ['created'] } });
  await call('PATCH', `/api/routines/${routine.id}`, { webhook: false });
  const { data: readded } = await call<Routine>('PATCH', `/api/routines/${routine.id}`, { webhook: true });
  assert.deepEqual([readded.webhook!.source, readded.webhook!.hasSecret, readded.webhook!.filter], ['generic', false, null]);
});

test('webhook logs name the routine, listener and status, never a signature or the payload', async () => {
  const { routine } = await newRoutine({ webhookSource: 'github' });
  const logged = captureLogs();
  try {
    const body = '{"secret_words":"walrus-carousel"}';
    const sig = hex(routine.webhook!.key, body);
    await deliver(routine, body, { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${sig}` });
    await deliver(routine, body, { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` });
    await until(() => logged.lines.filter((l) => l.msg === 'webhook').length >= 2);
    const text = JSON.stringify(logged.lines);
    assert.ok(!text.includes(sig) && !text.includes('walrus-carousel') && !text.includes(routine.webhook!.key), text);
    const hooks = logged.lines.filter((l) => l.msg === 'webhook');
    assert.deepEqual(
      hooks.map((l) => [l.routineId, l.listener, l.status]),
      [
        [routine.id, 'public', 202],
        [routine.id, 'public', 401],
      ],
    );
  } finally {
    logged.restore();
  }
});

test('`botons routine create/update` take --source and --filter, and `show` explains them with the public URL', async () => {
  const bot = await s.newBot('Cli hooks');
  const cli = (...args: string[]) => botonCli(app, base, bot.id, ...args);
  const created = await cli('routine', 'create', '--name', 'PRs', '--instruction', 'Review it', '--webhook', '--source', 'github', '--filter', 'header:X-GitHub-Event=pull_request, push', '--json');
  assert.equal(created.code, 0, created.stderr);
  const routine = JSON.parse(created.stdout) as Routine;
  assert.deepEqual(routine.webhook!.filter, { kind: 'header', name: 'X-GitHub-Event', values: ['pull_request', 'push'] });
  const shown = await cli('routine', 'show', routine.id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`POST ${PUBLIC_URL}/hooks/routines/${routine.id}`));
  assert.match(shown.stdout, /sent by github; only deliveries with a valid github signature run/);
  assert.match(shown.stdout, /paste it into the webhook's Secret field/);
  assert.match(shown.stdout, /Runs only when header X-GitHub-Event is pull_request or push/);
  const cleared = await cli('routine', 'update', routine.id, '--no-filter', '--source', 'linear', '--json');
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.equal((JSON.parse(cleared.stdout) as Routine).webhook!.filter, null);
  assert.match((await cli('routine', 'show', routine.id)).stdout, /No linear signing secret is saved yet/);
  const bad = await cli('routine', 'update', routine.id, '--filter', 'X-GitHub-Event');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--filter must look like/);
});
