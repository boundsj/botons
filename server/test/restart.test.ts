import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { Bot, Health, Message, PairResult, Routine, RoutineRun } from '../../shared/types.ts';
import { buildId, loadConfig } from '../src/config.ts';
import { INTERRUPTED_NOTE } from '../src/engine.ts';
import { sessionKey, systemPrompt } from '../src/prompt.ts';
import type { BotRecord } from '../src/store.ts';
import { approvedPairing, freePort, noRealClis, sleep, startServer, tempDir, until } from './helpers.ts';

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

interface Server {
  child: ChildProcess;
  home: string;
  port: number;
  base: string;
  /** Paired once per data folder, so devices stay paired across restarts. */
  token: string;
  out: () => string;
  exited: Promise<number | null>;
  call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }>;
}

/** The server as its own process: on a new data folder and port, or `prev`'s (a restart, with its device). */
async function start(env: Record<string, string> = {}, prev?: Server): Promise<Server> {
  const home = prev?.home ?? tempDir('botons-restart-test-');
  const port = prev?.port ?? (await freePort());
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/index.ts')], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT' && !k.startsWith('BOTONS_'))),
      BOTONS_HOME: home,
      BOTONS_HOST: '127.0.0.1',
      BOTONS_PORT: String(port),
      BOTONS_NO_TAILSCALE: '1',
      BOTONS_ENABLE_MOCK: '1',
      BOTONS_SCHEDULER_MS: '200',
      ...noRealClis(home),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await until(() => out.includes('is running') || child.exitCode !== null);
  assert.ok(out.includes('is running'), out);
  const base = `http://127.0.0.1:${port}`;
  const token = prev?.token ?? (await pair(home, base));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  return { child, home, port, base, token, out: () => out, exited, call };
}

/** Pair as `npm run pair -- --approve` would: a request approved in the database, traded for a device token. */
async function pair(home: string, base: string): Promise<string> {
  const db = new DatabaseSync(join(home, 'botons.db'));
  let secret: string;
  try {
    db.exec('pragma busy_timeout = 5000');
    secret = approvedPairing(db, 'Restart test');
  } finally {
    db.close();
  }
  const res = await fetch(`${base}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as PairResult).token!;
}

function query<T>(home: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(join(home, 'botons.db'));
  try {
    return db.prepare(sql).all(...params).map((r) => ({ ...r })) as T[];
  } finally {
    db.close();
  }
}

async function botWithRoutine(s: Server, name: string, instruction: string): Promise<{ bot: Bot; routine: Routine }> {
  const { data: bot } = await s.call<Bot>('POST', '/api/bots', { name, provider: 'mock' });
  const { data: routine } = await s.call<Routine>('POST', `/api/bots/${bot.id}/routines`, { name: `${name}'s job`, instruction, webhook: true });
  return { bot, routine };
}

const runOf = async (s: Server, routineId: string, runId: string) => (await s.call<RoutineRun[]>('GET', `/api/routines/${routineId}/runs`)).data.find((r) => r.id === runId);
const botMessages = async (s: Server, botId: string) => (await s.call<Message[]>('GET', `/api/bots/${botId}/messages`)).data;
const working = async (s: Server, botId: string) => (await s.call<Bot>('GET', `/api/bots/${botId}`)).data.status.state === 'working';
const stepsSaved = (home: string, n: number) => query(home, `select 1 from turns where outcome = 'running' and step_count = ${n}`).length > 0;

test('a restart lets running turns finish, refuses new work meanwhile, and runs what was queued afterwards with its trigger and payload', { timeout: 60_000 }, async () => {
  const s1 = await start({ BOTONS_DRAIN_MS: '20s' });
  const { home } = s1;
  const { bot, routine: slow } = await botWithRoutine(s1, 'Kevin', 'SLOW_PLEASE:3000 the weekly report');
  const { data: hooked } = await s1.call<Routine>('POST', `/api/bots/${bot.id}/routines`, { name: 'On push', instruction: 'Summarize the push', webhook: true });
  const { data: chatter } = await s1.call<Bot>('POST', '/api/bots', { name: 'Stuart', provider: 'mock' });

  const { data: running } = await s1.call<RoutineRun>('POST', `/api/routines/${slow.id}/run`);
  await until(async () => (await runOf(s1, slow.id, running.id))?.status === 'running');
  // Queued behind it, with a payload.
  const hook = await fetch(`${s1.base}/hooks/routines/${hooked.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hooked.webhook!.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ commit: 'abc123', branch: 'main' }),
  });
  const { runId: queuedId } = (await hook.json()) as { runId: string };
  await s1.call('POST', `/api/bots/${chatter.id}/messages`, { text: 'SLOW_PLEASE:800 hello' });
  await until(() => working(s1, chatter.id));

  s1.child.kill('SIGTERM');
  await until(() => s1.out().includes('shutdown: SIGTERM'));
  // Draining: new chat messages, manual runs and webhooks are refused; reads and health still work.
  const refused = await s1.call<{ error: string }>('POST', `/api/bots/${chatter.id}/messages`, { text: 'are you there?' });
  assert.equal(refused.status, 503);
  assert.match(refused.data.error, /restarting/);
  assert.equal((await s1.call('POST', `/api/routines/${slow.id}/run`)).status, 503);
  assert.equal((await fetch(`${s1.base}/hooks/routines/${hooked.id}`, { method: 'POST', headers: { authorization: `Bearer ${hooked.webhook!.key}` } })).status, 503);
  assert.equal((await s1.call('GET', `/api/bots/${chatter.id}`)).status, 200);
  const health = await s1.call<Health>('GET', '/api/health');
  assert.equal(health.status, 503);
  assert.ok(health.data.failing.includes('draining'), JSON.stringify(health.data));
  assert.equal(await s1.exited, 0);
  assert.match(s1.out(), /shutdown: done/);

  const runs = query<{ id: string; status: string; reply: string | null }>(home, 'select id, status, reply from routine_runs order by seq');
  assert.deepEqual(runs.map((r) => [r.id, r.status]), [[running.id, 'succeeded'], [queuedId, 'queued']]);
  assert.match(runs[0].reply ?? '', /Echo: .*SLOW_PLEASE:3000 the weekly report/s);
  assert.equal(query(home, "select 1 from messages where role = 'bot' and bot_id = ?", chatter.id).length, 1);
  assert.equal(query(home, "select 1 from messages where pending != 0").length, 0);

  // The queued run executes as the webhook run it was, with its payload; nothing runs twice.
  const s2 = await start({}, s1);
  const done = await until(async () => {
    const r = await runOf(s2, hooked.id, queuedId);
    return r?.status === 'succeeded' ? r : null;
  });
  assert.equal(done.trigger, 'webhook');
  assert.equal(done.payloadPreview, JSON.stringify({ commit: 'abc123', branch: 'main' }));
  assert.match(done.reply ?? '', /"commit": "abc123"/);
  await sleep(300);
  const kevin = await botMessages(s2, bot.id);
  assert.equal(kevin.filter((m) => m.meta?.kind === 'routine.run' && m.meta.runId === running.id).length, 1);
  assert.equal((await botMessages(s2, chatter.id)).filter((m) => m.role === 'bot').length, 1);
  assert.equal((await runOf(s2, slow.id, running.id))?.status, 'succeeded');
  s2.child.kill('SIGTERM');
  assert.equal(await s2.exited, 0);
});

test('turns the drain budget cuts off: the chat turn runs again once with a note (a chip keeps its steps), the routine run is marked interrupted', { timeout: 60_000 }, async () => {
  const s1 = await start({ BOTONS_DRAIN_MS: '100ms' });
  const { home } = s1;
  const { data: chatter } = await s1.call<Bot>('POST', '/api/bots', { name: 'Dave', provider: 'mock' });
  const { routine } = await botWithRoutine(s1, 'Jerry', 'SLOW_PLEASE:20000 crunch numbers');
  const text = 'STEP_PLEASE:mv *.jpg photos/\nSLOW_PLEASE:1500 rename the photos';
  await s1.call('POST', `/api/bots/${chatter.id}/messages`, { text });
  const { data: run } = await s1.call<RoutineRun>('POST', `/api/routines/${routine.id}/run`);
  await until(async () => stepsSaved(home, 1) && (await runOf(s1, routine.id, run.id))?.status === 'running');

  const t0 = Date.now();
  s1.child.kill('SIGTERM');
  assert.equal(await s1.exited, 0);
  assert.ok(Date.now() - t0 < 8000, 'cut off after the 100ms budget, not after the turns');
  assert.match(s1.out(), /stopped 2 turns that had not finished/);
  // Left as they were: the message in flight, the run running, no reply and no "Stopped." error.
  assert.deepEqual(query(home, "select pending from messages where role = 'user'"), [{ pending: 2 }]);
  assert.equal(query(home, "select 1 from messages where role in ('bot', 'error')").length, 0);
  assert.deepEqual(query(home, 'select status from routine_runs'), [{ status: 'running' }]);
  const chips = query<{ id: string; text: string; meta: string }>(home, "select id, text, meta from messages where role = 'event' and bot_id = ?", chatter.id);
  assert.deepEqual(chips.map((c) => [c.text, JSON.parse(c.meta).kind, JSON.parse(c.meta).steps]), [['Cut off by a restart', 'turn.interrupted', 1]]);
  assert.deepEqual(query(home, 'select message_id from turns where id = ?', JSON.parse(chips[0].meta).turnId), [{ message_id: chips[0].id }]);

  const s2 = await start({}, s1);
  const reply = await until(async () => (await botMessages(s2, chatter.id)).find((m) => m.role === 'bot'));
  assert.ok(reply.text.startsWith(`Echo: ${INTERRUPTED_NOTE}\n\n${text}`), reply.text);
  const after = await runOf(s2, routine.id, run.id);
  assert.equal(after?.status, 'failed');
  assert.equal(after?.error, 'Interrupted by a restart');
  const jerry = await botMessages(s2, routine.botId);
  assert.ok(jerry.some((m) => m.role === 'error' && m.text === `Routine “Jerry's job” was interrupted by a restart` && m.meta?.runId === run.id));
  // Its "Ran routine" chip comes just before the error.
  const chipAt = jerry.findIndex((m) => m.meta?.kind === 'routine.run' && m.meta.runId === run.id);
  assert.ok(chipAt >= 0, JSON.stringify(jerry.map((m) => m.text)));
  assert.deepEqual([jerry[chipAt].text, jerry[chipAt].meta?.trigger, jerry[chipAt + 1].role], ['Ran routine', 'manual', 'error']);
  await sleep(300);
  assert.equal((await botMessages(s2, chatter.id)).filter((m) => m.role === 'bot').length, 1);
  s2.child.kill('SIGTERM');
  assert.equal(await s2.exited, 0);
  assert.deepEqual(query(home, "select pending from messages where role = 'user'"), [{ pending: 0 }]);
});

test("a crash (kill -9) mid-turn: the next server posts a 'Cut off by a restart' chip with its steps, and answers the message exactly once, with the note", { timeout: 60_000 }, async () => {
  const s1 = await start();
  const { home } = s1;
  const { data: bot } = await s1.call<Bot>('POST', '/api/bots', { name: 'Phil', provider: 'mock' });
  await s1.call('POST', `/api/bots/${bot.id}/messages`, { text: 'STEP_PLEASE:rm -rf build/\nSLOW_PLEASE:1000 water the plants' });
  await until(() => stepsSaved(home, 1));
  s1.child.kill('SIGKILL');
  await s1.exited;

  const s2 = await start({}, s1);
  const chip = await until(async () => (await botMessages(s2, bot.id)).find((m) => m.meta?.kind === 'turn.interrupted'));
  assert.deepEqual([chip.text, chip.meta?.steps], ['Cut off by a restart', 1]);
  const { status, data: steps } = await s2.call<{ outcome: string; steps: { detail: string }[] }>('GET', `/api/messages/${chip.id}/steps`);
  assert.equal(status, 200);
  assert.equal(steps.outcome, 'interrupted');
  assert.deepEqual(steps.steps.map((x) => x.detail), ['rm -rf build/']);
  const reply = await until(async () => (await botMessages(s2, bot.id)).find((m) => m.role === 'bot'));
  assert.ok(reply.text.startsWith(`Echo: ${INTERRUPTED_NOTE}`), reply.text);
  await sleep(300);
  assert.equal((await botMessages(s2, bot.id)).filter((m) => m.role === 'bot' || m.role === 'error').length, 1);
  s2.child.kill('SIGTERM');
  await s2.exited;
  assert.equal(query(home, 'select 1 from turns where message_id is null and step_count > 0').length, 0, 'every cut-off turn with steps has its chip');
});

test('a chat message that every start finds cut off is given up on after 3 tries, with an error, instead of running forever', { timeout: 90_000 }, async () => {
  let s = await start();
  const { home } = s;
  const { data: bot } = await s.call<Bot>('POST', `/api/bots`, { name: 'Crasher', provider: 'mock' });
  await s.call('POST', `/api/bots/${bot.id}/messages`, { text: 'SLOW_PLEASE:30000 the turn that never finishes' });
  for (let i = 0; i < 3; i++) {
    await until(() => working(s, bot.id));
    s.child.kill('SIGKILL');
    await s.exited;
    s = await start({}, s);
  }
  const error = await until(async () => (await botMessages(s, bot.id)).find((m) => m.role === 'error'));
  assert.match(error.text, /The last 3 attempts to answer this were cut off by a restart or crash, so it was not tried again/);
  await sleep(300);
  assert.equal(await working(s, bot.id), false, 'not run a fourth time');
  assert.equal(query(home, "select 1 from messages where pending != 0").length, 0);
  s.child.kill('SIGTERM');
  await s.exited;
});

test('the session key does not depend on where the code or the data folder is', () => {
  const settings = { ownerName: 'Sam', timezone: 'America/Los_Angeles', paused: false };
  const cfgA = loadConfig({ BOTONS_HOME: tempDir(), BOTONS_HOST: '127.0.0.1' });
  const cfgB = { ...loadConfig({ BOTONS_HOME: tempDir(), BOTONS_HOST: '127.0.0.1' }), botonBinDir: '/home/me/.local/share/botons/releases/abc/server/bin' };
  const bot = (home: string) =>
    ({ id: 'bot_1', name: 'Kevin', title: 'Inbox', instructions: 'Triage my inbox', provider: 'claude-cli', model: '', access: 'workspace', timezone: 'America/Los_Angeles', workspace: join(home, 'workspaces', 'kevin-1') }) as BotRecord;
  const a = systemPrompt(bot(cfgA.home), settings, cfgA);
  const b = systemPrompt(bot(cfgB.home), settings, cfgB);
  assert.equal(sessionKey('claude-cli', a), sessionKey('claude-cli', b));
  for (const path of [cfgA.botonBinDir, cfgB.botonBinDir, cfgA.home, cfgB.home]) assert.ok(!a.includes(path) && !b.includes(path), path);
});

test('the build (release sha or git HEAD) is in /api/health, /api/info and the hello event', async () => {
  const build = 'f00dfeed'.repeat(5);
  const release = tempDir();
  writeFileSync(join(release, 'release.json'), JSON.stringify({ sha: build }));
  assert.equal(buildId(release), build);
  assert.equal(buildId(join(release, 'nothing-here')), null);

  const s = await startServer({ configure: (cfg) => void (cfg.build = build) });
  // No token: `npm run deploy` reads the build there.
  assert.deepEqual((await s.call('GET', '/api/health', undefined, null)).data, { ok: true, build, failing: [] });
  assert.equal((await s.call('GET', '/api/info')).data.build, build);
  const sse = await s.events();
  const [hello] = sse.events;
  assert.deepEqual(hello.type === 'hello' && hello.build, build);
  sse.close();
});
