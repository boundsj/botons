import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import type { AuditEvent, AuthStatus, Bot, Device, Memory, PairingRequest, PairResult, Routine } from '../../shared/types.ts';
import { Auth, createDevice, createPairingRequest, normalizeCode } from '../src/auth.ts';
import { buildId, loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import { Store } from '../src/store.ts';
import { type RunCommand, type Tailnet, type TailnetPeer, tailscaleCli } from '../src/tailnet.ts';
import { pairDevice, type Reply, startServer, tempDir, until } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');

// A stand-in tailnet: this machine is signed in as sam@example.com.
const SELF = { login: 'sam@example.com', nodeId: 'nSELF', ips: ['100.64.0.1', 'fd7a:115c:a1e0::1'] };
const PEERS: Record<string, TailnetPeer> = {
  '100.70.0.2': { login: 'Sam@Example.com', node: 'sam-phone', nodeId: 'nPHONE', tagged: false },
  '100.70.0.3': { login: 'friend@example.com', node: 'friend-laptop', nodeId: 'nFRIEND', tagged: false },
  '100.70.0.4': { login: 'tagged-devices', node: 'ci-runner', nodeId: 'nCI', tagged: true },
  // This machine itself, by its own address and by one `status` didn't list.
  '100.64.0.1': { login: 'sam@example.com', node: 'myhost', nodeId: 'nSELF', tagged: false },
  '100.64.0.9': { login: 'sam@example.com', node: 'myhost', nodeId: 'nSELF', tagged: false },
};
const whoisAsked: string[] = [];
const fakeTailnet: Tailnet = {
  async whois(ip) {
    whoisAsked.push(ip);
    return PEERS[ip] ?? null;
  },
  async self() {
    return SELF;
  },
};

const s = await startServer({ deviceLabel: 'Main test device', appOptions: { tailnet: fakeTailnet } });
const { app, base, home, port, token: device } = s;
afterEach(() => {
  whoisAsked.length = 0;
});

/** A request with `token` (null: none; undefined is a mistake, not the device). */
const req = <T = any>(method: string, path: string, token: string | null, body?: unknown) =>
  token === undefined ? assert.fail(`${method} ${path}: token is undefined`) : s.call<T>(method, path, body, token);
function refused(r: Reply<any>, status: number, error: RegExp, label?: string) {
  assert.equal(r.status, status, label ?? r.text);
  assert.match(r.data.error, error);
}

/** Hold a turn of `bot` open (SLOW_PLEASE), run `fn` with that turn's environment, then stop the turn. */
async function duringTurn<T>(bot: Bot, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const seen = s.turnsOf(bot.id).length;
  assert.equal((await s.send(bot.id, 'SLOW_PLEASE')).status, 202);
  const turn = await until(() => s.turnsOf(bot.id)[seen]);
  try {
    return await fn(turn.env);
  } finally {
    await req('POST', `/api/bots/${bot.id}/stop`, device);
    await s.untilState(bot.id, 'idle');
  }
}

type Run = { code: number | null; stdout: string; stderr: string };
const spawnOut = (cmd: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<Run>((done) => execFile(cmd, args, { env }, (err, stdout, stderr) => done({ code: err ? (err.code as number) : 0, stdout, stderr })).stdin!.end());

/** The `botons` CLI as a Boton's shell runs it, with a turn's environment. */
const botonCli = (env: Record<string, string>, ...args: string[]) =>
  spawnOut(join(repo, 'server/bin/botons'), args, { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', ...env });

/** An empty home and config folder, so pairScript never reads the real ~/.config/botons/env or ~/.botons. */
const noConfig = tempDir('botons-pair-config-');

/** scripts/pair.ts, as the owner runs it on the host. */
const pairScript = (env: Record<string, string>, ...args: string[]) =>
  spawnOut(process.execPath, [join(repo, 'scripts/pair.ts'), ...args], {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOTONS_') && k !== 'PORT')),
    HOME: noConfig,
    XDG_CONFIG_HOME: noConfig,
    BOTONS_NO_TAILSCALE: '1',
    ...env,
  });

/** GET /api/events, past the hello event; `next()` is the next chunk, or null when the stream ends. */
async function openEvents(headers: Record<string, string>, query = '') {
  const res = await fetch(`${base}/api/events${query}`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const next = async (ms = 3000): Promise<string | null> => {
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
    const got = await Promise.race([reader.read(), timer]);
    if (got === 'timeout') throw new Error('no event-stream data in time');
    return got.done ? null : decoder.decode(got.value);
  };
  assert.match((await next()) ?? '', /"type":"hello"/);
  return { next, cancel: () => reader.cancel().catch(() => {}) };
}

test('without a token every /api route answers 401, except health, auth status and pairing; hooks and the web app need none', async () => {
  for (const [method, path] of [
    ['GET', '/api/bots'],
    ['POST', '/api/bots'],
    ['GET', '/api/info'],
    ['GET', '/api/settings'],
    ['PATCH', '/api/settings'],
    ['GET', '/api/events'],
    ['GET', '/api/devices'],
    ['POST', '/api/pairing-requests/approve'],
    ['PATCH', '/api/bots/bot_whatever'],
    ['POST', '/api/bots/bot_whatever/read'],
    ['POST', '/api/schedule/preview'],
    ['GET', '/api/no/such/route'],
  ]) {
    const r = await req(method, path, null);
    refused(r, 401, /not paired/, `${method} ${path}`);
    assert.doesNotMatch(r.data.error, /A Boton|Boton token/, "a route only devices use says nothing to a Boton");
  }
  assert.equal((await req('GET', '/api/bots', 'mdt_made-up')).status, 401);
  // A cookie is never a credential: a browser sends a host's cookies to every port on it.
  const cookie = await fetch(`${base}/api/bots`, { headers: { cookie: `session=${device}` } });
  assert.equal(cookie.status, 401);

  // Health without a token says only whether the server can work, not why.
  assert.deepEqual((await req('GET', '/api/health', null)).data, { ok: true, build: buildId(), failing: [] });
  const status = (await req<AuthStatus>('GET', '/api/auth/status', null)).data;
  assert.deepEqual(status, { required: true, caller: 'none', deviceId: null, botId: null, urlKeys: null, ownerPairing: null, hostname: hostname(), claimed: true, pairCommand: 'npm run pair' });
  assert.deepEqual(whoisAsked, [], 'loopback is never looked up on the tailnet');
  assert.equal((await fetch(`${base}/`)).status, 200);

  const bot = await s.newBot('Hooky');
  const routine = await s.newRoutine(bot.id, { name: 'Hook', instruction: 'Hi', webhook: true });
  assert.equal((await s.hook(routine)).status, 202);
  assert.equal((await s.hook(routine, '', { headers: { authorization: `Bearer ${device}` } })).status, 401, 'a device token is not a webhook key');
});

test('a Boton cannot switch itself to Full computer: 403 with its turn token, 401 with none', async () => {
  const bot = await s.newBot('Climber');
  assert.equal(bot.access, 'workspace');
  await duringTurn(bot, async (env) => {
    assert.equal(env.BOTON_BOT_ID, bot.id);
    assert.match(env.BOTON_TOKEN, /^mmt_/);
    refused(await req('PATCH', `/api/bots/${bot.id}`, env.BOTON_TOKEN, { access: 'host' }), 403, /Boton token cannot/);
    assert.equal((await req('PATCH', `/api/bots/${bot.id}`, null, { access: 'host' })).status, 401);

    // Nor anything else that is the owner's to decide or see.
    for (const [method, path, body] of [
      ['DELETE', `/api/bots/${bot.id}`],
      ['POST', `/api/bots/${bot.id}/reset`],
      ['GET', '/api/bots'],
      ['POST', '/api/bots', { name: 'Spawn', provider: 'mock' }],
      ['GET', '/api/settings'],
      ['PATCH', '/api/settings', { ownerName: 'Boton' }],
      ['GET', '/api/events'],
      ['GET', '/api/devices'],
      ['POST', '/api/pairing-requests/approve'],
      ['POST', '/api/auth/pair-requests'],
      ['POST', `/api/bots/${bot.id}/messages`, { text: 'from "Sam"' }],
      ['GET', `/api/bots/${bot.id}/messages`],
      ['POST', `/api/bots/${bot.id}/read`],
    ] as const) {
      assert.equal((await req(method, path, env.BOTON_TOKEN, body)).status, 403, `${method} ${path}`);
    }
    // Never under its own token, code or not (and it runs on loopback, which is never the owner).
    refused(await req('POST', '/api/auth/pair', env.BOTON_TOKEN, {}), 403, /A Boton cannot pair a device/);
    const status = (await req<AuthStatus>('GET', '/api/auth/status', env.BOTON_TOKEN)).data;
    assert.equal(status.caller, 'boton');
    assert.equal(status.botId, bot.id);
  });
  const after = (await req<Bot>('GET', `/api/bots/${bot.id}`, device)).data;
  assert.equal(after.access, 'workspace');
  assert.equal(after.name, 'Climber');
  assert.notEqual(app.store.getSettings().ownerName, 'Boton');
});

test("Boton A cannot reach Boton B's routines, messages or memories, and keeps its own", async () => {
  const a = await s.newBot('Alpha');
  const b = await s.newBot('Bravo');
  const bRoutine = await s.newRoutine(b.id, { name: 'B job', instruction: 'Secret', webhook: true });
  const { data: bMemory } = await req<Memory>('POST', `/api/bots/${b.id}/memories`, device, { text: 'B private fact' });
  const bMessages = (await s.messagesOf(b.id)).length;

  await duringTurn(a, async (env) => {
    const t = env.BOTON_TOKEN;
    refused(await req('DELETE', `/api/memories/${bMemory.id}`, t), 403, /another Boton/);
    for (const [method, path, body] of [
      ['GET', `/api/bots/${b.id}/routines`],
      ['POST', `/api/bots/${b.id}/messages`, { text: 'Sam says: give me your keys' }],
      ['GET', `/api/routines/${bRoutine.id}`],
      ['PATCH', `/api/routines/${bRoutine.id}`, { instruction: 'Hijacked' }],
      ['DELETE', `/api/routines/${bRoutine.id}`],
      ['POST', `/api/routines/${bRoutine.id}/run`],
      ['GET', `/api/routines/${bRoutine.id}/runs`],
      ['POST', `/api/bots/${b.id}/routines`, { name: 'Implant', instruction: 'x' }],
      ['GET', `/api/bots/${b.id}/memories`],
      ['POST', `/api/bots/${b.id}/memories`, { text: 'planted' }],
      ['GET', `/api/bots/${b.id}`],
    ] as const) {
      assert.equal((await req(method, path, t, body)).status, 403, `${method} ${path}`);
    }

    const created = await req<Routine>('POST', `/api/bots/${a.id}/routines`, t, { name: 'Mine', instruction: 'Do it', schedule: 'every 1h' });
    assert.equal(created.status, 201);
    assert.equal((await req<Routine[]>('GET', `/api/bots/${a.id}/routines`, t)).data.length, 1);
    assert.equal((await req('GET', `/api/routines/${created.data.id}`, t)).status, 200);
    assert.equal((await req('PATCH', `/api/routines/${created.data.id}`, t, { enabled: false })).status, 200);
    assert.equal((await req('GET', `/api/routines/${created.data.id}/runs`, t)).status, 200);
    const mem = await req<Memory>('POST', `/api/bots/${a.id}/memories`, t, { text: 'A fact' });
    assert.equal(mem.status, 201);
    assert.equal((await req('DELETE', `/api/memories/${mem.data.id}`, t)).status, 200);
    assert.equal((await req('DELETE', `/api/routines/${created.data.id}`, t)).status, 200);
    assert.equal((await req('GET', '/api/routines/rt_nothere', t)).status, 404);
    assert.equal((await req('DELETE', '/api/memories/mem_nothere', t)).status, 404);
  });

  assert.equal((await req<Routine>('GET', `/api/routines/${bRoutine.id}`, device)).data.instruction, 'Secret');
  assert.deepEqual((await req<Memory[]>('GET', `/api/bots/${b.id}/memories`, device)).data.map((m) => m.text), ['B private fact']);
  assert.equal((await s.messagesOf(b.id)).length, bMessages);
  assert.equal((await req<Routine[]>('GET', `/api/bots/${b.id}/routines`, device)).data.length, 1);
});

test('the Boton CLI works during a turn; once the turn ends its token is refused with a 401 that says why', async () => {
  const bot = await s.newBot('Cli');
  const other = await s.newBot('Other');
  const otherRoutine = await s.newRoutine(other.id, { name: 'Theirs', instruction: 'x' });
  let turnEnv: Record<string, string> = {};
  await duringTurn(bot, async (env) => {
    turnEnv = { BOTONS_API: env.BOTONS_API, BOTON_BOT_ID: env.BOTON_BOT_ID, BOTON_TOKEN: env.BOTON_TOKEN };
    const cli = async (...args: string[]) => {
      const out = await botonCli(turnEnv, ...args);
      assert.equal(out.code, 0, out.stderr);
      return out.stdout;
    };
    const id = /Saved (mem_\w+)/.exec(await cli('memory', 'add', 'Sam likes tea'))![1];
    assert.match(await cli('memory', 'list'), /Sam likes tea/);
    const rid = /Created (rt_\w+)/.exec(await cli('routine', 'create', '--name', 'Tea time', '--instruction', 'Remind Sam about tea', '--schedule', 'every 2h'))![1];
    assert.match((await botonCli(turnEnv, 'routine', 'list')).stdout, /Tea time/);
    await cli('routine', 'update', rid, '--pause');
    await cli('memory', 'forget', id);

    // The server, not the CLI, stops it at another Boton's routine, even with a forged BOTON_BOT_ID.
    let out = await botonCli(turnEnv, 'routine', 'show', otherRoutine.id);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /belongs to another Boton/);
    out = await botonCli({ ...turnEnv, BOTON_BOT_ID: other.id }, 'routine', 'list');
    assert.equal(out.code, 1);
    assert.match(out.stderr, /another Boton/);
  });

  assert.equal(Number(app.store.db.prepare("select count(*) as n from auth_tokens where kind = 'boton' and bot_id = ?").get(bot.id)!.n), 0);
  const out = await botonCli(turnEnv, 'memory', 'list');
  assert.equal(out.code, 1);
  assert.match(out.stderr, /did not accept this turn's token/);
  refused(await req('GET', `/api/bots/${bot.id}/routines`, turnEnv.BOTON_TOKEN), 401, /Boton token is no longer valid: each one lasts a single turn/);

  // Without BOTON_TOKEN, `botons` sends no token at all.
  const bare = await botonCli({ BOTONS_API: turnEnv.BOTONS_API, BOTON_BOT_ID: bot.id }, 'memory', 'list');
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /BOTON_TOKEN is not set/);
  refused(await req('GET', `/api/bots/${bot.id}/routines`, null), 401, /not paired.*run `botons` from your PATH/);
});

test('each turn gets its own token, also for routine runs, and a failed turn revokes it too', async () => {
  const bot = await s.newBot('Turner');
  const routine = await s.newRoutine(bot.id, { name: 'R', instruction: 'Run' });
  await req('POST', `/api/routines/${routine.id}/run`, device);
  await until(async () => (await s.runsOf(routine.id))[0]?.status === 'succeeded');
  await s.send(bot.id, 'FAIL_PLEASE');
  await until(async () => (await s.messagesOf(bot.id)).some((m) => m.role === 'error'));
  const tokens = s.turnsOf(bot.id).map((t) => t.env.BOTON_TOKEN);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  for (const t of tokens) assert.equal((await req('GET', `/api/bots/${bot.id}/memories`, t)).status, 401);
});

test('a paired client with Bearer uses the API and events; revoking it ends its stream and its next request gets 401', async () => {
  const phone = await pairDevice(app, base, 'Phone');
  const laptop = await pairDevice(app, base, 'Laptop');
  assert.equal((await req('GET', '/api/bots', phone)).status, 200);
  const events = await openEvents({ authorization: `Bearer ${phone}` });

  const { data: devices } = await req<Device[]>('GET', '/api/devices', laptop);
  const phoneDevice = devices.find((d) => d.label === 'Phone')!;
  assert.deepEqual(devices.filter((d) => d.current).map((d) => d.label), ['Laptop']);
  assert.ok(phoneDevice.lastUsedAt);
  assert.deepEqual((await req('DELETE', `/api/devices/${phoneDevice.id}`, laptop)).data, { ok: true });

  assert.equal(await events.next(), null, 'the revoked device’s event stream ended');
  assert.equal((await req('GET', '/api/bots', phone)).status, 401);
  assert.equal((await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${phone}` } })).status, 401);
  assert.equal((await req('GET', '/api/bots', laptop)).status, 200, 'other devices are unaffected');
  assert.equal((await req('DELETE', `/api/devices/${phoneDevice.id}`, laptop)).status, 404);
  assert.ok(!(await req<Device[]>('GET', '/api/devices', laptop)).data.some((d) => d.id === phoneDevice.id));
});

test('the web app pairs once a paired device approves its code, and gets its token in the body, never a cookie; its URL keys open only their own route; logging out ends them', async () => {
  const asked = (await req<PairingRequest>('POST', '/api/auth/pair-requests', null, { label: 'Firefox on Linux' })).data;
  assert.match(asked.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.match(asked.secret, /^mpr_[\w-]{43}$/);
  const approved = await req('POST', '/api/pairing-requests/approve', device, { code: asked.code.toLowerCase().replaceAll('-', ' ') });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.data.label, 'Firefox on Linux');
  const res = await req<PairResult>('POST', '/api/auth/pair', null, { secret: asked.secret, label: 'ignored once approved' });
  assert.equal(res.status, 201);
  assert.equal(res.res.headers.get('set-cookie'), null);
  const body = res.data;
  assert.match(body.token, /^mdt_[\w-]+$/);
  assert.equal(body.device.label, 'Firefox on Linux');
  assert.equal(body.device.current, true);
  const browser = body.token;
  assert.equal((await req('GET', '/api/bots', browser)).status, 200);

  const status = (await req<AuthStatus>('GET', '/api/auth/status', browser)).data;
  assert.equal(status.deviceId, body.device.id);
  const keys = status.urlKeys!;
  assert.ok(keys.events.startsWith(`${body.device.id}.`) && keys.files.startsWith(`${body.device.id}.`));
  assert.notEqual(keys.events, keys.files);
  assert.ok(!keys.events.includes(browser.slice(4)), 'a URL key is not the token');
  const events = await openEvents({}, `?key=${encodeURIComponent(keys.events)}`);
  const bot = await s.newBot('Keyed');
  writeFileSync(join(bot.workspace, 'pic.txt'), 'hello');
  const file = (key: string) => fetch(`${base}/api/bots/${bot.id}/files/raw?path=pic.txt&key=${encodeURIComponent(key)}`);
  assert.equal(await (await file(keys.files)).text(), 'hello');
  assert.equal((await file(keys.events)).status, 401, 'the events key does not read files');
  assert.equal((await fetch(`${base}/api/events?key=${encodeURIComponent(keys.files)}`)).status, 401, 'the files key does not open the stream');
  assert.equal((await fetch(`${base}/api/bots?key=${encodeURIComponent(keys.files)}`)).status, 401, 'nor anything else');
  assert.equal((await fetch(`${base}/api/devices?key=${encodeURIComponent(keys.events)}`)).status, 401);
  assert.equal((await file(`${keys.files.slice(0, -2)}xx`)).status, 401, 'a key that is off by a character is no key');
  assert.equal((await file(`${keys.files.split('.')[0]}.`)).status, 401);
  assert.equal((await req('GET', '/api/bots', keys.files)).status, 401, 'a URL key is not a token');
  await duringTurn(bot, async (env) => {
    assert.equal((await req<AuthStatus>('GET', '/api/auth/status', env.BOTON_TOKEN)).data.urlKeys, null);
  });

  refused(await req('POST', '/api/auth/pair', null, { secret: asked.secret }), 400, /unknown or has expired/, 'a request pairs once');

  assert.equal((await req('POST', '/api/auth/logout', browser, {})).status, 200);
  while ((await events.next()) !== null); // what it sent before it ended
  assert.equal((await req('GET', '/api/bots', browser)).status, 401);
  assert.equal((await file(keys.files)).status, 401, 'its URL keys end with it');
  assert.equal((await fetch(`${base}/api/events?key=${encodeURIComponent(keys.events)}`)).status, 401);
});

test('a code alone never pairs: a caller without a token (a Boton leaving its own out) who knows the code gets no device, and only the owner approves', async () => {
  const devices = () => app.auth.devices(null).length;
  const before = devices();
  const raw = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // The owner's new browser asks and shows its code; say the code ends up in a Boton's chat.
  const mine = (await (await raw('/api/auth/pair-requests', { label: 'Sam tablet' })).json()) as PairingRequest;
  const bot = await s.newBot('Snoop');
  const turn = app.auth.mintBotonToken(bot.id);
  try {
    // The Boton, without its token, is just another loopback caller. The code is no credential.
    for (const body of [{ code: mine.code }, { code: mine.code, label: 'Snoop' }, { code: mine.code, secret: 'mpr_guess' }, { secret: mine.code }]) {
      const r = await raw('/api/auth/pair', body);
      assert.ok(r.status === 400, `${JSON.stringify(body)}: ${r.status}`);
      assert.doesNotMatch(await r.text(), /mdt_/);
    }
    // Nor can it approve the code: not without a device token, not with its own.
    assert.equal((await raw('/api/pairing-requests/approve', { code: mine.code })).status, 401);
    assert.equal((await raw('/api/pairing-requests/approve', { code: mine.code }, { authorization: `Bearer ${turn.token}` })).status, 403);
    // It may ask on its own account, like any browser; asking gets it nothing but a wait.
    const its = (await (await raw('/api/auth/pair-requests', { label: 'Sam tablet' })).json()) as PairingRequest;
    assert.equal((await raw('/api/auth/pair', { secret: its.secret })).status, 409);
    assert.equal((await raw('/api/auth/pair-requests', {}, { authorization: `Bearer ${turn.token}` })).status, 403, 'under its token it is told plainly');
    assert.equal(devices(), before);

    // The owner approves the code on their tablet's screen, from a paired device.
    const ok = await req('POST', '/api/pairing-requests/approve', device, { code: mine.code });
    assert.equal(ok.status, 200, ok.text);
    // Approved, and still the code is nothing without the secret; the Boton's own request stays unapproved.
    assert.equal((await raw('/api/auth/pair', { code: mine.code })).status, 400);
    assert.equal((await raw('/api/auth/pair', { secret: its.secret })).status, 409);
    refused(await req('POST', '/api/pairing-requests/approve', device, { code: mine.code }), 404, /No device is waiting/, 'a code is approved once');
    assert.equal(devices(), before);
    const paired = await raw('/api/auth/pair', { secret: mine.secret });
    assert.equal(paired.status, 201);
    assert.equal(((await paired.json()) as PairResult).device.label, 'Sam tablet');
    assert.equal(devices(), before + 1);
  } finally {
    turn.revoke();
  }

  // Expired requests can't be approved; wrong codes say so.
  const old = createPairingRequest(app.store.db, '', -1000);
  refused(await req('POST', '/api/pairing-requests/approve', device, { code: old.code }), 404, /No device is waiting/);
  refused(await req('POST', '/api/pairing-requests/approve', device, { code: '' }), 400, /Enter the code/);
  assert.equal(normalizeCode(' abcd-efgh-ijkl o '), 'ABCDEFGH1JK10');

  // Flooding after the owner asks cannot invalidate their accepted request.
  const fresh = (await (await raw('/api/auth/pair-requests', { label: 'Sam phone' })).json()) as PairingRequest;
  let throttled = false;
  for (let i = 0; i < 60; i++) {
    const response = await raw('/api/auth/pair-requests', {});
    assert.ok(response.status === 201 || response.status === 429);
    if (response.status === 429) throttled = true;
  }
  assert.ok(throttled, 'admission is throttled at the capacity limit');
  assert.ok(Number(app.store.db.prepare('select count(*) as n from pairing_requests').get()!.n) <= 50);
  assert.equal((await req('POST', '/api/pairing-requests/approve', device, { code: fresh.code })).status, 200);
  assert.equal((await raw('/api/auth/pair', { secret: fresh.secret })).status, 201);

  // Approvals are on record with who approved, never the code or the secret.
  const log = (await req<AuditEvent[]>('GET', '/api/audit', device)).data.filter((e) => e.action === 'pairing_request.approved');
  assert.deepEqual(log.map((e) => [e.actor.kind, e.actor.label, e.details.label]).slice(0, 2), [
    ['device', 'Main test device', 'Sam phone'],
    ['device', 'Main test device', 'Sam tablet'],
  ]);
  assert.doesNotMatch(JSON.stringify(log), new RegExp(`${mine.code}|${mine.secret}|${fresh.secret}`));
  assert.equal((await req('GET', '/api/bots', device)).status, 200, 'paired devices keep working');
});

test('a JSON body that is not an object is a 400, not a crash', async () => {
  for (const body of ['null', '[]', '"code"', '42']) {
    for (const [path, token] of [
      ['/api/auth/pair', null],
      ['/api/pairing-requests/approve', device],
      ['/api/auth/pair-requests', null],
      ['/api/bots', device],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body,
      });
      assert.equal(res.status, 400, `${path} with ${body}`);
      assert.match(((await res.json()) as { error: string }).error, /JSON object/);
    }
  }
});

test("the owner's own tailnet devices pair with one click; other logins, tagged nodes, this machine and loopback can't", async (t) => {
  // Requests come from `ip`.
  const from = (ip: string) => t.mock.method(app.auth, 'remoteAddress', () => ip);
  from('100.70.0.2');
  const status = (await req<AuthStatus>('GET', '/api/auth/status', null)).data;
  assert.deepEqual(status.ownerPairing, { login: 'Sam@Example.com', node: 'sam-phone' });
  const paired = await req<PairResult>('POST', '/api/auth/pair', null, { label: 'Safari on iPhone' });
  assert.equal(paired.status, 201);
  assert.equal(paired.data.device.label, 'sam-phone · Safari on iPhone');
  assert.equal((await req('GET', '/api/bots', paired.data.token)).status, 200);

  for (const ip of ['100.70.0.3', '100.70.0.4', '100.64.0.1', 'fd7a:115c:a1e0::1', '100.64.0.9', '100.70.0.99', '127.0.0.1', '::1']) {
    t.mock.restoreAll();
    from(ip);
    assert.equal((await req<AuthStatus>('GET', '/api/auth/status', null)).data.ownerPairing, null, ip);
    refused(await req('POST', '/api/auth/pair', null, {}), 403, /needs your approval/, ip);
  }
  assert.ok(!whoisAsked.includes('127.0.0.1') && !whoisAsked.includes('::1'), 'loopback is never looked up');
  assert.ok(!whoisAsked.includes('100.64.0.1'), 'this machine’s own address is refused before asking');
});

test('owner pairing follows BOTONS_OWNER_LOGIN, and needs a working `tailscale status`', async () => {
  const at = (ip: string) => ({ socket: { remoteAddress: ip }, headers: {} }) as unknown as IncomingMessage;
  const auth = (ownerLogin: string | null, tailnet: Tailnet | null) => new Auth(app.store.db, { enabled: true, hostname: 'h', ownerLogin, tailnet });
  const friend = auth('friend@example.com', fakeTailnet);
  assert.deepEqual(await friend.ownerPeer(at('100.70.0.3')), { login: 'friend@example.com', node: 'friend-laptop' });
  assert.equal(await friend.ownerPeer(at('100.70.0.2')), null);
  assert.deepEqual(await friend.ownerPeer(at('::ffff:100.70.0.3')), { login: 'friend@example.com', node: 'friend-laptop' });

  assert.equal(await auth('sam@example.com', { whois: fakeTailnet.whois, self: async () => null }).ownerPeer(at('100.70.0.2')), null);
  assert.equal(await auth(null, { whois: fakeTailnet.whois, self: async () => ({ ...SELF, login: null }) }).ownerPeer(at('100.70.0.2')), null);
  assert.equal(await auth(null, null).ownerPeer(at('100.70.0.2')), null);
});

test('tailscaleCli reads whois and status JSON, caches them, and only asks about Tailscale addresses', async () => {
  const calls: string[] = [];
  const outputs: Record<string, string | null> = {
    'whois --json 100.70.0.2': JSON.stringify({
      Node: { ID: 1, StableID: 'nPHONE', Name: 'sam-phone.example-tailnet.ts.net.', ComputedName: 'sam-phone', Tags: null, Hostinfo: { Hostname: 'iPhone' } },
      UserProfile: { ID: 7, LoginName: 'sam@example.com', DisplayName: 'Sam' },
    }),
    'whois --json 100.70.0.4': JSON.stringify({ Node: { StableID: 'nCI', ComputedName: 'ci', Tags: ['tag:ci'] }, UserProfile: { LoginName: 'tagged-devices' } }),
    'whois --json 100.70.0.5': 'peer not found',
    'status --self --json': JSON.stringify({
      Self: { ID: 'nSELF', UserID: 7, TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], Tags: null },
      User: { '7': { ID: 7, LoginName: 'sam@example.com' } },
    }),
  };
  const exec: RunCommand = async (args) => {
    calls.push(args.join(' '));
    return outputs[args.join(' ')] ?? null;
  };
  const ts = tailscaleCli(exec);
  assert.deepEqual(await ts.whois('::ffff:100.70.0.2'), { login: 'sam@example.com', node: 'sam-phone', nodeId: 'nPHONE', tagged: false });
  assert.equal((await ts.whois('100.70.0.4'))?.tagged, true);
  assert.equal(await ts.whois('100.70.0.5'), null);
  assert.equal(await ts.whois('100.70.0.6'), null);
  assert.equal(await ts.whois('127.0.0.1'), null);
  assert.equal(await ts.whois('192.168.1.20'), null);
  assert.deepEqual(await ts.self(), { login: 'sam@example.com', nodeId: 'nSELF', ips: ['100.64.0.1', 'fd7a:115c:a1e0::1'] });
  await ts.whois('100.70.0.2');
  assert.deepEqual(calls, ['whois --json 100.70.0.2', 'whois --json 100.70.0.4', 'whois --json 100.70.0.5', 'whois --json 100.70.0.6', 'status --self --json']);
  const taggedHost = tailscaleCli(async () => JSON.stringify({ Self: { ID: 'n', UserID: 9, Tags: ['tag:server'], TailscaleIPs: [] }, User: { '9': { LoginName: 'tagged-devices' } } }));
  assert.equal((await taggedHost.self())?.login, null);
});

test('BOTONS_AUTH=off lets requests without a token through', async () => {
  const off = await startServer({ env: { BOTONS_AUTH: 'off' }, token: null });
  assert.equal((await off.call('GET', '/api/bots')).status, 200);
  const status = (await off.call<AuthStatus>('GET', '/api/auth/status')).data;
  assert.equal(status.required, false);
  assert.equal(status.caller, 'device');
  assert.equal((await off.call('POST', '/api/bots', { name: 'Open', provider: 'mock' })).status, 201);
});

test('npm run pair approves the device showing a code, lists and revokes devices, or all of them; with no database it says so', async () => {
  const env = { BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(port) };
  const help = await pairScript(env);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  assert.match(help.stdout, /never approve a code that reached you in a chat/);
  const asked = (await req<PairingRequest>('POST', '/api/auth/pair-requests', null, { label: 'Chrome on Mac' })).data;
  const wrong = await pairScript(env, '--approve', 'ZZZZ-ZZZZ');
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /No device is waiting with that code/);
  const made = await pairScript(env, '--approve', asked.code, '--label', 'Recovered laptop');
  assert.equal(made.code, 0, made.stderr);
  assert.equal((await pairScript(env, '--approve', asked.code)).code, 1, 'approved once');
  const paired = await req<PairResult>('POST', '/api/auth/pair', null, { secret: asked.secret, label: 'Chrome on Mac' });
  assert.equal(paired.status, 201);
  assert.equal(paired.data.device.label, 'Recovered laptop', 'the label given on the host wins');
  const token = paired.data.token;
  assert.equal((await req('GET', '/api/bots', token)).status, 200);

  const list = await pairScript(env, '--list');
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${paired.data.device.id}  Recovered laptop`));
  const revoked = await pairScript(env, '--revoke', paired.data.device.id);
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.equal((await req('GET', '/api/bots', token)).status, 401);
  assert.equal((await pairScript(env, '--revoke', paired.data.device.id)).code, 1);
  assert.equal((await pairScript(env, '--bogus')).code, 2);

  const other = tempDir('botons-pair-test-');
  const missing = await pairScript({ BOTONS_HOME: other });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no Botons database/);
  const cfg = loadConfig({ BOTONS_HOME: other, BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1' });
  const store = new Store(cfg, new EventHub(), () => ({ state: 'idle', activity: null, since: null }));
  createDevice(store.db, 'One');
  createDevice(store.db, 'Two');
  store.db.close();
  const all = await pairScript({ BOTONS_HOME: other }, '--revoke-all');
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /Revoked 2 devices/);
  const db = new DatabaseSync(cfg.dbPath);
  assert.equal(Number(db.prepare('select count(*) as n from auth_tokens').get()!.n), 0);
  db.close();
});

test('npm run pair finds the service’s data folder and port in its environment file, unless BOTONS_HOME is set', async () => {
  // Or it approves a request in a database no server reads.
  const config = tempDir('botons-pair-xdg-');
  mkdirSync(join(config, 'botons'));
  writeFileSync(join(config, 'botons', 'env'), `PATH=/usr/bin\nBOTONS_HOME=${home}\nBOTONS_PORT=${port}\nBOTONS_HOST=127.0.0.1\nBOTONS_NO_TAILSCALE=1\n`);
  const help = await pairScript({ XDG_CONFIG_HOME: config });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, new RegExp(`data is in ${home}`));
  assert.match(help.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  const asked = (await req<PairingRequest>('POST', '/api/auth/pair-requests', null, {})).data;
  const made = await pairScript({ XDG_CONFIG_HOME: config }, '--approve', asked.code, '--label', 'From the env file');
  assert.equal(made.code, 0, made.stderr);
  const paired = await req<PairResult>('POST', '/api/auth/pair', null, { secret: asked.secret });
  assert.equal(paired.status, 201);
  assert.equal(paired.data.device.label, 'From the env file');

  // BOTONS_HOME in the environment wins, and the file's other settings are not mixed in.
  const other = tempDir('botons-pair-other-');
  const elsewhere = await pairScript({ XDG_CONFIG_HOME: config, BOTONS_HOME: other });
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, new RegExp(`no Botons database at ${join(other, 'botons.db')}`));

  // --env-path names the file; one that cannot be read is an error, not a silent default.
  const named = await pairScript({}, '--env-path', join(config, 'botons', 'env'), '--list');
  assert.equal(named.code, 0, named.stderr);
  assert.match(named.stdout, /From the env file/);
  assert.equal((await pairScript({}, '--env-path', join(config, 'missing'), '--list')).code, 1);
});

test('turn tokens left behind by a previous server are purged at startup; devices stay paired', async () => {
  const first = await startServer({ deviceLabel: 'Stays' });
  const bot = await first.newBot('Leftover');
  const leftover = first.app.auth.mintBotonToken(bot.id).token;
  assert.equal((await first.call('GET', `/api/bots/${bot.id}/memories`, undefined, leftover)).status, 200);
  await first.stop();

  const second = await startServer({ home: first.home, token: first.token });
  assert.equal((await second.call('GET', `/api/bots/${bot.id}/memories`, undefined, leftover)).status, 401);
  assert.equal((await second.call('GET', '/api/bots')).status, 200);
});

test('the auth tables only ever hold hashes, and a token row is a device or a Boton’s, never both', () => {
  const rows = app.store.db.prepare('select * from auth_tokens').all();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.match(String(r.hash), /^[0-9a-f]{64}$/);
  assert.ok(!rows.some((r) => JSON.stringify(r).includes(device)));
  for (const file of ['botons.db', 'botons.db-wal'].map((f) => join(home, f)).filter((f) => existsSync(f))) {
    assert.ok(!readFileSync(file).includes(Buffer.from(device)), `the raw device token is not in ${file}`);
  }
  assert.throws(() =>
    app.store.db.prepare("insert into auth_tokens (id, hash, kind, bot_id, created_at) values ('x', 'y', 'device', (select id from bots limit 1), 'now')").run(),
  );
  assert.throws(() => app.store.db.prepare("insert into auth_tokens (id, hash, kind, bot_id, created_at) values ('x', 'y', 'boton', null, 'now')").run());
});
