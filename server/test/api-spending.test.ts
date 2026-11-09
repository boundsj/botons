import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Message, SpendingView } from '../../shared/types.ts';
import { costOf, mostOf, outputFor, rateFor } from '../src/rates.ts';
import { type FakeModelApi, fakeModelApi } from './fixtures/fake-model-api.ts';
import { failOnEscapedErrors, startServer, type TestServer, until } from './helpers.ts';

failOnEscapedErrors();

const ANTHROPIC_KEY = 'sk-ant-fake.bob.test.0123456789.kevin';
const OPENAI_KEY = 'sk-fake.stuart.test.0123456789.dave';
let fake: FakeModelApi;
const fakes: FakeModelApi[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

async function server(): Promise<TestServer> {
  fake = await fakeModelApi();
  fakes.push(fake);
  return startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY }, testEndpoints: { anthropic: fake.origin, openai: fake.origin } } } });
}

const lastTurn = (s: TestServer, botId: string) => s.app.store.db.prepare('select * from turns where bot_id = ? order by started_at desc, rowid desc limit 1').get(botId) as any;

test('rates: exact model ids only, long prompts at their own rate, a promotion past its end unknown', () => {
  const opus = rateFor('anthropic', 'claude-opus-5-5')!;
  assert.equal(costOf(opus, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }), 4 + 20 + 0.2 + 5);
  assert.equal(rateFor('anthropic', 'claude-opus-5-5-20260401'), null, 'never a snapshot matched by its prefix');
  assert.equal(rateFor('openai', 'gpt-6-astra-mini'), null);
  const haiku = rateFor('anthropic', 'claude-haiku-5-5')!;
  assert.equal(costOf(haiku, { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0.01);
  assert.equal(costOf(haiku, { inputTokens: 100_001, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0.0500005);
  const astra = rateFor('openai', 'gpt-6-astra')!;
  assert.equal(costOf(astra, { inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 6, 'over 272K: the long-context rate');
  assert.ok(rateFor('openai', 'gpt-5.6-sol', new Date('2026-11-30T12:00:00Z')));
  assert.equal(rateFor('openai', 'gpt-5.6-sol', new Date('2026-12-01T00:00:00Z')), null);
  // The most a request costs bounds what it can cost; what fits under a budget, at most.
  assert.equal(mostOf(opus, 10_000, 1000), (10_000 * 5 + 1000 * 20) / 1e6);
  assert.equal(outputFor(opus, 10_000, 0.07), 1000);
  assert.equal(outputFor(opus, 10_000, 0.04), 0);
});

test('a daily cap: the owner sets it (a Boton can’t), requests are reserved before they go, and a turn that can’t fit is not sent', async () => {
  const s = await server();
  const bot = await s.newBot('Kevin', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  const routine = await s.newRoutine(bot.id, { name: 'Check' });
  let view = (await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data;
  assert.deepEqual([view.dailyCapUsd, view.spentTodayUsd, view.routines.map((r) => [r.id, r.perRunCapUsd])], [null, 0, [[routine.id, null]]]);
  assert.equal((await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: -1 })).status, 400);
  assert.equal((await s.call('PUT', `/api/bots/${bot.id}/spending`, { routines: { nope: 1 } })).status, 404);
  const boton = s.app.auth.mintBotonToken(bot.id);
  assert.equal((await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 1000 }, boton.token)).status, 403, 'a Boton can’t raise its own cap');
  assert.equal((await s.call('GET', `/api/bots/${bot.id}/spending`, undefined, boton.token)).status, 403);
  boton.revoke();

  // $1 a day: a 32K-token answer on Sonnet 5.5 ($10 per million out) fits.
  view = (await s.call<SpendingView>('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 1 })).data;
  assert.equal(view.dailyCapUsd, 1);
  const audit = s.app.store.db.prepare("select details from audit_events where action = 'boton.spending_changed'").all() as any[];
  assert.match(String(audit.at(-1)?.details), /none → \$1/);
  fake.queue({ text: 'Fine.', usage: { input: 1000, output: 100 } });
  const ok = (await s.chat(bot.id, 'Hello')) as Message;
  assert.equal(ok.text, 'Fine.');
  const turn = lastTurn(s, bot.id);
  assert.equal(turn.cost_usd, (1000 * 2 + 100 * 10) / 1e6, 'once answered, the reservation becomes what it cost');
  assert.equal(fake.requests[0].body.max_tokens, 32_000);
  view = (await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data;
  assert.equal(view.spentTodayUsd, turn.cost_usd);

  // Little left: the answer's cap is lowered to what fits.
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 0.06 });
  fake.queue({ text: 'Short.', usage: { input: 1000, output: 100 } });
  await s.chat(bot.id, 'Hello again');
  const lowered = fake.requests[1].body.max_tokens;
  assert.ok(lowered >= 1024 && lowered < 32_000, String(lowered));

  // Nothing fits: not sent at all.
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 0.01 });
  const refused = (await s.chat(bot.id, 'And again')) as Message;
  assert.equal(refused.role, 'error');
  assert.match(refused.text, /spending cap/);
  assert.equal(fake.requests.length, 2);
});

test('a request whose answer broke off stays counted at its most (a hold); an unpriced model won’t run under a cap', async () => {
  const s = await server();
  const bot = await s.newBot('Stuart', { provider: 'openai-api', model: 'gpt-6.1-sol', access: 'host' });
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 5 });
  fake.queue({ cut: true });
  const broke = (await s.chat(bot.id, 'Hello')) as Message;
  assert.equal(broke.role, 'error');
  assert.match(broke.text, /broke off|ended before|may or may not have reached/);
  const turn = lastTurn(s, bot.id);
  assert.ok(turn.cost_usd > 0.3, `held at its most: ${turn.cost_usd}`);
  assert.equal(turn.error_kind, 'transient', 'nothing ran: it may be tried again');
  const view = (await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data;
  assert.equal(view.spentTodayUsd, turn.cost_usd);

  // A model Botons has no rate for: with a cap, refused before anything is sent.
  await s.call('PATCH', `/api/bots/${bot.id}`, { model: 'gpt-unpriced-test' });
  const before = fake.requests.length;
  const refused = (await s.chat(bot.id, 'Hello')) as Message;
  assert.match(refused.text, /no known price/);
  assert.equal(fake.requests.length, before);
  // Without a cap it runs, and its cost is unknown, not guessed.
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: null });
  fake.queue({ text: 'Unpriced answer.' });
  const ran = (await s.chat(bot.id, 'Hello')) as Message;
  assert.equal(ran.text, 'Unpriced answer.');
  assert.equal(lastTurn(s, bot.id).cost_usd, null);
  assert.equal(ran.meta?.usage?.costUsd, undefined);
  // And with a cap again, the day already has a turn with no known price.
  await s.call('PATCH', `/api/bots/${bot.id}`, { model: 'gpt-6.1-sol' });
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 5 });
  const blocked = (await s.chat(bot.id, 'Hello')) as Message;
  assert.match(blocked.text, /no known price/);
  assert.equal((await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data.unpricedToday, 1);
});

test('a routine’s cap a run counts every round of the run, and stops it between rounds', async () => {
  const s = await server();
  const bot = await s.newBot('Bob', { provider: 'anthropic-api', model: 'claude-opus-5-5', access: 'host' });
  const routine = await s.newRoutine(bot.id, { name: 'Loop' });
  // Opus 5.5 ($4 in, $20 out): each round reserves its most, its answer cap lowered to what is left, until nothing fits.
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { routines: { [routine.id]: 0.3 } });
  fake.queue(
    { calls: [{ name: 'shell', input: { command: 'echo one' } }], usage: { input: 20_000, output: 2000 } },
    { calls: [{ name: 'shell', input: { command: 'echo two' } }], usage: { input: 20_000, output: 2000 } },
    { calls: [{ name: 'shell', input: { command: 'echo three' } }], usage: { input: 20_000, output: 2000 } },
    { text: 'All done.' },
  );
  await s.call('POST', `/api/routines/${routine.id}/run`, {});
  const run = await until(async () => (await s.runsOf(routine.id)).find((r: any) => r.status === 'failed' || r.status === 'succeeded'), 20_000);
  assert.equal(run.status, 'failed');
  assert.match(String(run.error ?? ''), /spending cap/);
  const spent = (s.app.store.db.prepare('select sum(cost_usd) as usd from turns where run_id = ?').get(run.id) as any).usd;
  assert.ok(spent <= 0.3, `kept under the cap: ${spent}`);
  assert.ok(fake.requests.length >= 2 && fake.requests.length < 4, String(fake.requests.length));
});

test('a request in flight is counted in its row (so a crash or another turn can’t spend it twice), and held if it is stopped', async () => {
  const s = await server();
  const a = await s.newBot('Dave', { provider: 'anthropic-api', model: 'claude-opus-5-5', access: 'host' });
  await s.call('PUT', `/api/bots/${a.id}/spending`, { dailyCapUsd: 0.7 });
  fake.queue({ hang: true });
  s.app.engine.sendMessage(a.id, 'First');
  await until(() => fake.requests.length === 1);
  const row = s.app.store.db.prepare('select * from api_requests where bot_id = ?').get(a.id) as any;
  assert.equal(row.state, 'reserved');
  assert.ok(row.reserved_usd > 0.6, `the running request is reserved in its row: ${row.reserved_usd}`);
  const during = (await s.call<SpendingView>('GET', `/api/bots/${a.id}/spending`)).data;
  assert.equal(during.spentTodayUsd, row.reserved_usd);
  await s.call('POST', `/api/bots/${a.id}/stop`, {});
  await s.untilState(a.id, 'idle', 10_000);
  const stopped = lastTurn(s, a.id);
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(stopped.cost_usd, row.reserved_usd, 'sent and stopped: it may have been billed, so it stays counted');
  assert.deepEqual(
    Object.values(s.app.store.db.prepare('select state, reserved_usd, cost_usd from api_requests where id = ?').get(row.id) as any),
    ['held', row.reserved_usd, null],
  );
  // The day's cap now has no room for another request.
  const next = (await s.chat(a.id, 'Second')) as Message;
  assert.match(next.text, /spending cap/);
  assert.equal(fake.requests.length, 1);
});
