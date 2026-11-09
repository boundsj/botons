import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { AuditEvent, Bot, CreateRoutineInput, Routine, RoutineRun, RunCallback, RunsAttention, WebhookRunStatus } from '../../shared/types.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { allowance, checkCallbackUrl, guardedLookup, refusedAddress, refusedUrl } from '../src/ssrf.ts';
import { failOnEscapedErrors, freePort, botonCli, sleep, startServer, tempDir, until } from './helpers.ts';

const hooksPort = await freePort();
const s = await startServer({
  env: { BOTONS_HOOKS_PORT: String(hooksPort) },
  configure: (cfg) => {
    cfg.callbacks.retryDelaysMs = [20, 20, 20];
  },
});
const { app, base, cfg, call, mock } = s;
const hooksBase = `http://127.0.0.1:${hooksPort}`;
failOnEscapedErrors();
afterEach(() => {
  cfg.callbacks.allow = [];
  cfg.callbacks.timeoutMs = 10_000;
});

/** A Boton with a webhook routine ("Job"). */
async function newRoutine(input: Partial<CreateRoutineInput> = {}, access: Bot['access'] = 'workspace') {
  const bot = await s.newBot(`Cb ${Math.random().toString(36).slice(2, 6)}`, { access });
  return { bot, routine: await s.newRoutine(bot.id, { webhook: true, ...input }) };
}

const finished = (routineId: string, runId: string) => until(async () => (await s.runsOf(routineId)).find((r) => r.id === runId && (r.status === 'succeeded' || r.status === 'failed')));
/** The run once its callback is no longer pending. */
const delivered = (routineId: string, runId: string) => until(async () => (await s.runsOf(routineId)).find((r) => r.id === runId && r.meta?.callback && !r.meta.callback.pending));
const runNow = async (routineId: string, body?: unknown) => (await call<RoutineRun>('POST', `/api/routines/${routineId}/run`, body)).data;

const receivers: Server[] = [];
after(() => {
  for (const r of receivers) {
    r.closeAllConnections();
    r.close();
  }
});
/** A results receiver on loopback; `answer` decides each response, by its index. */
async function receiver(answer: (i: number, res: ServerResponse) => void = (_i, res) => res.writeHead(200).end('ok')) {
  const got: { headers: IncomingMessage['headers']; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (d: string) => (body += d));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      answer(got.length - 1, res);
    });
  });
  receivers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/results`, got };
}

test('SSRF: loopback, private, link-local, CGNAT, reserved and own addresses are refused, as are non-http(s) URLs and credentials; BOTONS_CALLBACK_ALLOW lets some through', () => {
  const none = allowance([]);
  for (const ip of ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '100.100.100.100', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1']) {
    assert.ok(refusedAddress(ip, none), `${ip} should be refused`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(refusedAddress(ip, none), null, `${ip} should be allowed`);
  }
  for (const a of Object.values(networkInterfaces()).flat()) if (a) assert.ok(refusedAddress(a.address, none), a.address);
  // The owner can allow addresses, ranges and names.
  const some = allowance(['127.0.0.1', '100.64.0.0/10', 'receiver.internal']);
  assert.equal(refusedAddress('127.0.0.1', some), null);
  assert.equal(refusedAddress('::ffff:127.0.0.1', some), null);
  assert.equal(refusedAddress('100.101.102.103', some), null);
  assert.ok(refusedAddress('127.0.0.2', some));
  assert.equal(refusedUrl('http://receiver.internal/x', some), null);

  assert.equal(refusedUrl('https://hooks.example.com/botons', none), null);
  assert.equal(refusedUrl('http://8.8.8.8:8080/x', none), null);
  for (const [url, why] of [
    ['http://127.0.0.1:9/x', /can't point at 127\.0\.0\.1: a loopback, private/],
    ['http://localhost:3000/', /can't point at localhost: this machine/],
    ['http://app.localhost/', /this machine/],
    ['http://[::1]/', /can't point at ::1/],
    ['http://169.254.169.254/latest/meta-data', /169\.254\.169\.254/],
    ['http://192.168.1.1/', /192\.168\.1\.1/],
    ['ftp://example.com/', /http:\/\/ or https:\/\//],
    ['not a url', /http:\/\/ or https:\/\//],
    ['https://user:pw@example.com/', /user name or password/],
  ] as const) {
    assert.match(refusedUrl(url, none) ?? 'allowed', why, url);
  }
});

test('names are checked on what they resolve to, when connecting', async () => {
  const lookup = (allow: string[]) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => guardedLookup(allowance(allow))('localhost', {}, (err, address) => resolve({ err, address })));
  const refused = await lookup([]);
  assert.equal(refused.err?.code, 'EREFUSEDADDRESS');
  assert.match(refused.err!.message, /^localhost resolves to (127\.0\.0\.1|::1), a loopback/);
  assert.equal((await lookup(['localhost'])).err, null, 'an allowed name');
  assert.equal((await lookup(['127.0.0.1', '::1'])).err, null, 'allowed addresses');
  assert.match((await checkCallbackUrl('http://localhost:1/', []))!, /this machine/);
  assert.equal(await checkCallbackUrl('http://localhost:1/', ['localhost']), null);
});

test('BOTONS_CALLBACK_ALLOW takes names, addresses and CIDR ranges', () => {
  const env = { BOTONS_HOME: tempDir('botons-cb-cfg-'), BOTONS_NO_TAILSCALE: '1' };
  assert.deepEqual(loadConfig({ ...env, BOTONS_CALLBACK_ALLOW: 'Receiver.Internal, 100.64.0.0/10,::1,fd00::/8' }).callbacks.allow, ['receiver.internal', '100.64.0.0/10', '::1', 'fd00::/8']);
  for (const bad of ['10.0.0.0/33', 'host:8080', 'nonsense/8', '::1/129']) {
    assert.throws(() => loadConfig({ ...env, BOTONS_CALLBACK_ALLOW: bad }), (e: unknown) => e instanceof ConfigError && /BOTONS_CALLBACK_ALLOW/.test(e.message), bad);
  }
});

test('a test run uses the entered payload and the "test" trigger, is told it is a dry run, and leaves the status dot and last run alone', async () => {
  const { bot, routine } = await newRoutine({}, 'host');
  const manual = await runNow(routine.id);
  assert.equal(manual.trigger, 'manual');
  await finished(routine.id, manual.id);
  const before = (await call<Routine>('GET', `/api/routines/${routine.id}`)).data;
  assert.equal(before.lastStatus, 'succeeded');

  // FAIL_PLEASE would turn the dot red if a test run counted.
  const seen = mock.turns.length;
  const { status, data: run } = await call<RoutineRun>('POST', `/api/routines/${routine.id}/run`, { payload: { action: 'opened', note: 'FAIL_PLEASE' } });
  assert.equal(status, 202);
  assert.equal(run.trigger, 'test');
  assert.equal(run.payloadPreview, '{"action":"opened","note":"FAIL_PLEASE"}');
  assert.equal((await finished(routine.id, run.id)).status, 'failed');
  const after = (await call<Routine>('GET', `/api/routines/${routine.id}`)).data;
  assert.equal(after.lastStatus, 'succeeded', 'the status dot is unchanged');
  assert.equal(after.lastRunAt, before.lastRunAt);

  const turn = mock.turns.slice(seen).find((t) => t.prompt.includes(routine.id))!;
  assert.match(turn.prompt, /\(trigger: test\)/);
  assert.match(turn.prompt, /This is a test run .* Treat it as a dry run/);
  assert.match(turn.prompt, /<webhook_payload id="[\w-]{12}">\n\{\n {2}"action": "opened"/);
  assert.equal(turn.access, 'workspace');
  assert.match(turn.prompt, /This run tests the routine's webhook, so like a webhook run it runs with Workspace access/);
  assert.ok((await s.messagesOf(bot.id)).some((m) => m.meta?.kind === 'routine.run' && m.meta.runId === run.id && m.meta.trigger === 'test'));

  // Without a webhook, a test run keeps the Boton's own access.
  const { routine: plain } = await newRoutine({ webhook: false, schedule: 'daily at 8:00' }, 'host');
  const seenPlain = mock.turns.length;
  const plainRun = await runNow(plain.id, { test: true });
  assert.equal(plainRun.trigger, 'test');
  await finished(plain.id, plainRun.id);
  const plainTurn = mock.turns.slice(seenPlain).find((t) => t.prompt.includes(plain.id))!;
  assert.equal(plainTurn.access, 'host');
  assert.match(plainTurn.prompt, /Treat it as a dry run/);
  assert.doesNotMatch(plainTurn.prompt, /tests the routine's webhook|with Workspace access/);

  const text = await runNow(routine.id, { payload: 'plain text' });
  assert.equal(text.payloadPreview, 'plain text');
  await finished(routine.id, text.id);
  assert.equal((await call('POST', `/api/routines/${routine.id}/run`, { payload: 'x', test: false })).status, 400);
});

test('`botons routine test <id> --payload` sends a test run, from text or @file (in the workspace only)', async () => {
  const { bot, routine } = await newRoutine();
  const cli = (...args: string[]) => botonCli(app, base, bot.id, ...args);
  mkdirSync(bot.workspace, { recursive: true });
  const file = join(bot.workspace, 'sample.json');
  writeFileSync(file, '{"ref":"refs/heads/main"}\n');
  // `botons` runs outside the sandbox, so a file outside the workspace is refused.
  const secret = join(s.home, 'private-sample.json');
  writeFileSync(secret, '{"key":"PRIVATE-KEY-MARKER"}');
  const outside = await cli('routine', 'test', routine.id, '--payload', `@${secret}`);
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /--payload @file must be a file in your workspace/);
  assert.ok(!(await s.runsOf(routine.id)).length, 'no run');
  const fromFile = await cli('routine', 'test', routine.id, '--payload', `@${file}`, '--json');
  assert.equal(fromFile.code, 0, fromFile.stderr);
  const run = JSON.parse(fromFile.stdout) as RoutineRun;
  assert.equal(run.trigger, 'test');
  assert.equal(run.payloadPreview, '{"ref":"refs/heads/main"}\n');
  await finished(routine.id, run.id);
  const inline = await cli('routine', 'test', routine.id, '--payload', '{"n":1}');
  assert.equal(inline.code, 0, inline.stderr);
  assert.match(inline.stdout, /Queued test run run_\w+ of "Job" with a 7-byte payload/);
  const missing = await cli('routine', 'test', routine.id, '--payload', `@${join(bot.workspace, 'nonexistent.json')}`);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Can't read .*nonexistent\.json: ENOENT/);
  const manual = await cli('routine', 'run', routine.id, '--json');
  assert.equal((JSON.parse(manual.stdout) as RoutineRun).trigger, 'manual');
});

test('GET /hooks/routines/:id/runs/:runId: the run with the routine key, 401 without it, 404 for another routine\'s run; ?wait=1&timeout=1 on a slow run answers 202 with a Location to poll', { timeout: 15_000 }, async () => {
  const { routine } = await newRoutine();
  const auth = (r: Routine) => ({ authorization: `Bearer ${r.webhook!.key}` });
  const res = await fetch(`${hooksBase}/hooks/routines/${routine.id}`, { method: 'POST', headers: auth(routine), body: '{"a":1}' });
  assert.equal(res.status, 202);
  const { runId } = await res.json();
  assert.equal(res.headers.get('location'), `${routine.webhook!.url}/runs/${runId}`);
  await finished(routine.id, runId);

  const path = `/hooks/routines/${routine.id}/runs/${runId}`;
  for (const at of [base, hooksBase]) {
    const ok = await fetch(at + path, { headers: auth(routine) });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as WebhookRunStatus;
    assert.deepEqual(
      { ...body, startedAt: undefined, finishedAt: undefined },
      { ok: true, runId, status: 'succeeded', trigger: 'webhook', reply: body.reply, error: null, startedAt: undefined, finishedAt: undefined, attempts: 1, retriedAs: null, cancelled: false, timedOut: false },
    );
    assert.match(body.reply!, /"a": 1/);
    assert.equal((await fetch(at + path)).status, 401);
    assert.equal((await fetch(at + path, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${at}${path}?key=${routine.webhook!.key}`)).status, 200);
  }
  const { routine: other } = await newRoutine();
  assert.equal((await fetch(`${hooksBase}/hooks/routines/${other.id}/runs/${runId}`, { headers: auth(other) })).status, 404);
  // A signed routine's runs are polled with its key too.
  await call('PATCH', `/api/routines/${routine.id}`, { webhookSource: 'github' });
  assert.equal((await fetch(hooksBase + path, { headers: auth(routine) })).status, 200);

  const { routine: slow } = await newRoutine({ instruction: 'SLOW_PLEASE:2000' });
  const started = Date.now();
  const waited = await fetch(`${hooksBase}/hooks/routines/${slow.id}?wait=1&timeout=1`, { method: 'POST', headers: auth(slow) });
  assert.equal(waited.status, 202);
  assert.ok(Date.now() - started < 1900, 'answered at the timeout, not when the run ended');
  const out = await waited.json();
  assert.ok(out.status === 'queued' || out.status === 'running', out.status);
  assert.equal(waited.headers.get('location'), `${slow.webhook!.url}/runs/${out.runId}`);
  const poll = async () => (await (await fetch(hooksBase + new URL(waited.headers.get('location')!).pathname, { headers: auth(slow) })).json()) as WebhookRunStatus;
  const pending = await poll();
  assert.ok(pending.status === 'queued' || pending.status === 'running');
  const done = await until(async () => {
    const r = await poll();
    return r.status === 'succeeded' && r;
  });
  assert.match(done.reply!, /SLOW_PLEASE/);
});

test('a callbackUrl at 127.0.0.1 (or this machine, or a private address) is 400; only a device may set one, and only with a webhook', async () => {
  const { bot, routine } = await newRoutine();
  for (const url of ['http://127.0.0.1:9/results', 'http://localhost:9/', 'http://[::1]:9/', 'http://10.0.0.5/', 'http://169.254.169.254/', 'file:///etc/passwd']) {
    assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { callbackUrl: url })).status, 400, url);
  }
  assert.equal((await call('POST', `/api/bots/${bot.id}/routines`, { name: 'x', instruction: 'y', webhook: true, callbackUrl: 'http://127.0.0.1:9/' })).status, 400);
  assert.match((await call('POST', `/api/bots/${bot.id}/routines`, { name: 'x', instruction: 'y', callbackUrl: 'https://example.com/r' })).data.error, /needs a webhook/);
  // A Boton's token can't point its results anywhere, even somewhere public.
  const turn = app.auth.mintBotonToken(bot.id);
  try {
    const res = await call('PATCH', `/api/routines/${routine.id}`, { callbackUrl: 'https://example.com/r' }, turn.token);
    assert.equal(res.status, 403);
    assert.match(res.data.error, /callbackUrl/);
    assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { name: 'Renamed' }, turn.token)).status, 200);
  } finally {
    turn.revoke();
  }
  // Allowed by BOTONS_CALLBACK_ALLOW, it saves; removing the webhook drops it.
  cfg.callbacks.allow = ['127.0.0.1'];
  const { status, data } = await call<Routine>('PATCH', `/api/routines/${routine.id}`, { callbackUrl: 'http://127.0.0.1:9/results' });
  assert.equal(status, 200);
  assert.equal(data.webhook!.callbackUrl, 'http://127.0.0.1:9/results');
  await call('PATCH', `/api/routines/${routine.id}`, { webhook: false });
  assert.equal((await call<Routine>('PATCH', `/api/routines/${routine.id}`, { webhook: true })).data.webhook!.callbackUrl, null);
});

test('a routine with a callbackUrl sends one signed POST per finished run, and records it', async () => {
  cfg.callbacks.allow = ['127.0.0.1'];
  // A delayed answer is still a happy path within the normal delivery deadline.
  const fake = await receiver((i, res) => {
    if (i === 1) setTimeout(() => res.writeHead(200).end('ok'), 750);
    else res.writeHead(200).end('ok');
  });
  const { routine } = await newRoutine({ callbackUrl: fake.url });
  const { runId } = await (await s.hook(routine, '', { body: '{"x":1}' })).json();
  const run = await delivered(routine.id, runId);
  assert.deepEqual({ ...run.meta!.callback, at: undefined }, { url: fake.url, ok: true, status: 200, error: null, attempts: 1, at: undefined });
  await sleep(200);
  assert.equal(fake.got.length, 1, 'no second POST');
  const [{ headers, body }] = fake.got;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-boton-signature'], `sha256=${createHmac('sha256', routine.webhook!.key).update(body).digest('hex')}`);
  assert.equal(headers['x-boton-run'], runId);
  const sent = JSON.parse(body) as RunCallback;
  assert.deepEqual(Object.keys(sent).sort(), ['attempts', 'botId', 'cancelled', 'error', 'finishedAt', 'quiet', 'reply', 'routineId', 'runId', 'startedAt', 'status', 'timedOut', 'trigger']);
  assert.deepEqual([sent.runId, sent.status, sent.trigger, sent.cancelled, sent.timedOut], [runId, 'succeeded', 'webhook', false, false]);
  assert.match(sent.reply!, /"x": 1/);
  assert.ok(sent.finishedAt);

  const failedId = (await (await s.hook(routine, '', { body: 'FAIL_PLEASE' })).json()).runId;
  const failedRun = await delivered(routine.id, failedId);
  assert.equal(failedRun.meta!.callback!.attempts, 1);
  assert.equal(fake.got.length, 2);
  const second = JSON.parse(fake.got[1].body) as RunCallback;
  assert.deepEqual([second.runId, second.status, second.trigger, second.error], [failedId, 'failed', 'webhook', 'Mock failure requested']);

  // A test run is a dry run: no callback, whether it succeeds or fails.
  for (const payload of ['{"sample":true}', 'FAIL_PLEASE']) {
    const done = await finished(routine.id, (await runNow(routine.id, { payload })).id);
    assert.equal(done.trigger, 'test');
    assert.equal(done.meta?.callback, undefined);
  }
  await sleep(200);
  assert.equal(fake.got.length, 2, 'no callback for a test run');
});

test('a run the owner cancels still sends its result, marked cancelled', async () => {
  cfg.callbacks.allow = ['127.0.0.1'];
  const fake = await receiver();
  const { routine } = await newRoutine({ instruction: 'SLOW_PLEASE:30000', callbackUrl: fake.url });
  const { runId } = await (await s.hook(routine, '', { body: '{"x":1}' })).json();
  await until(async () => (await s.runsOf(routine.id)).find((r) => r.id === runId && r.status === 'running'));
  assert.equal((await call('POST', `/api/runs/${runId}/cancel`)).status, 200);
  const run = await delivered(routine.id, runId);
  assert.equal(run.meta!.callback!.ok, true);
  const sent = JSON.parse(fake.got[0].body) as RunCallback;
  assert.deepEqual([sent.runId, sent.status, sent.error, sent.cancelled], [runId, 'failed', 'Cancelled', true]);
});

test('callbacks retry 3 times on errors and timeouts, not on redirects or refused addresses', { timeout: 15_000 }, async () => {
  cfg.callbacks.timeoutMs = 300;
  cfg.callbacks.allow = ['127.0.0.1'];
  // A 503, then no answer (a timeout), then 200.
  const flaky = await receiver((i, res) => {
    if (i === 0) res.writeHead(503).end();
    else if (i > 1) res.writeHead(200).end();
  });
  const down = await receiver((_i, res) => res.writeHead(500).end());
  const moved = await receiver((_i, res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end());
  const callbackOf = async (routine: Routine) => {
    const run = await runNow(routine.id);
    return (await delivered(routine.id, run.id)).meta!.callback!;
  };
  const sendRun = async (url: string) => callbackOf((await newRoutine({ callbackUrl: url })).routine);
  const a = await sendRun(flaky.url);
  assert.deepEqual([a.ok, a.status, a.attempts], [true, 200, 3]);
  assert.equal(flaky.got.length, 3);

  const b = await sendRun(down.url);
  assert.deepEqual([b.ok, b.status, b.error, b.attempts], [false, 500, 'HTTP 500', 4]);
  assert.equal(down.got.length, 4, 'the first try and 3 retries');

  const c = await sendRun(moved.url);
  assert.deepEqual([c.ok, c.status, c.attempts], [false, 302, 1]);
  assert.match(c.error!, /redirects are not followed/);

  // Saved while allowed, refused when sending once it is not: no request, no retry.
  const { routine } = await newRoutine({ callbackUrl: flaky.url });
  cfg.callbacks.allow = [];
  const before = flaky.got.length;
  const d = await callbackOf(routine);
  assert.deepEqual([d.ok, d.status, d.attempts], [false, null, 1]);
  assert.match(d.error!, /can't point at 127\.0\.0\.1/);
  assert.equal(flaky.got.length, before);
});

test('the owner resends a result the callback URL never got: listed in runs to check, audited, refused to a Boton and when there is nothing to resend', { timeout: 15_000 }, async () => {
  cfg.callbacks.allow = ['127.0.0.1'];
  let fixed = false;
  const fake = await receiver((_i, res) => res.writeHead(fixed ? 200 : 500).end());
  const { bot, routine } = await newRoutine({ callbackUrl: fake.url });
  const run = await runNow(routine.id);
  const failed = (await delivered(routine.id, run.id)).meta!.callback!;
  assert.deepEqual([failed.ok, failed.attempts], [false, 4]);
  const attention = async () => (await call<RunsAttention>('GET', '/api/runs/attention')).data.callbacks.filter((r) => r.routineId === routine.id);
  assert.deepEqual((await attention()).map((r) => [r.id, r.meta?.callback?.error]), [[run.id, 'HTTP 500']]);

  const boton = app.auth.mintBotonToken(bot.id);
  try {
    assert.equal((await call('POST', `/api/runs/${run.id}/callback`, {}, boton.token)).status, 403);
  } finally {
    boton.revoke();
  }
  assert.equal(fake.got.length, 4, 'nothing sent for the Boton');

  fixed = true;
  const resent = await call<RoutineRun>('POST', `/api/runs/${run.id}/callback`);
  assert.equal(resent.status, 202, resent.text);
  assert.equal(resent.data.meta?.callback?.pending, true);
  const ok = await until(async () => (await s.runsOf(routine.id)).find((r) => r.id === run.id && r.meta?.callback?.ok)?.meta!.callback);
  assert.deepEqual([ok.status, ok.attempts], [200, 1]);
  assert.equal(fake.got.length, 5);
  assert.equal(fake.got[4].body, fake.got[0].body);
  assert.equal(fake.got[4].headers['x-boton-signature'], `sha256=${createHmac('sha256', routine.webhook!.key).update(fake.got[4].body).digest('hex')}`);
  assert.deepEqual(await attention(), [], 'delivered, off the list');
  const audit = (await call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'run.callback_resent' && e.target?.id === routine.id);
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details, { boton: bot.id, runId: run.id, callback: `${new URL(fake.url).origin}/…` });

  // Nothing to resend: already sent, a test run, or no callback URL any more.
  assert.match((await call('POST', `/api/runs/${run.id}/callback`)).data.error, /already sent/);
  const dry = await finished(routine.id, (await runNow(routine.id, { payload: '{}' })).id);
  assert.equal((await call('POST', `/api/runs/${dry.id}/callback`)).status, 409);
  fixed = false;
  const again = await runNow(routine.id);
  await delivered(routine.id, again.id);
  await call('PATCH', `/api/routines/${routine.id}`, { callbackUrl: null });
  const gone = await call('POST', `/api/runs/${again.id}/callback`);
  assert.equal(gone.status, 409);
  assert.match(gone.data.error, /no longer has a callback URL/);
  assert.deepEqual(await attention(), [], 'nowhere to resend it');
  assert.equal((await call('POST', '/api/runs/run_nonexistent/callback')).status, 404);
});
