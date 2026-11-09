import assert from 'node:assert/strict';
// The fixtures were exported under the earlier names; legacy-names.test.ts imports them as they are.
import { currentPortable } from '../../shared/legacy-names.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { PortableConfig, PortableExport, PortableImportPreview, PortableImportResult, ServerEvent, SpendingView } from '../../shared/types.ts';
import { PORTABLE_VERSION, readPortable } from '../src/portable.ts';
import { lookFromTater } from '../../shared/look.ts';
import { taterFromCritter } from '../../shared/look-tater.ts';
import { rateFor } from '../src/rates.ts';
import { type FakeModelApi, fakeModelApi } from './fixtures/fake-model-api.ts';
import { failOnEscapedErrors, startServer, type TestServer } from './helpers.ts';

failOnEscapedErrors();

// Spending caps in the configuration file: they go with their Boton and routines, never what was spent; an import
// gives them only to the Botons it makes, and never raises, clears or restarts a cap or account already here.

const ANTHROPIC_KEY = 'sk-ant-fake.bob.test.0123456789.kevin';
const fakes: FakeModelApi[] = [];
const live: TestServer[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});
afterEach(async () => {
  for (const s of live.splice(0).reverse()) await s.stop();
});

async function start(): Promise<TestServer> {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const s = await startServer({ appOptions: { apiKeys: { env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, testEndpoints: { anthropic: fake.origin, openai: fake.origin } } } });
  live.push(s);
  return s;
}

const ok = async <T>(s: TestServer, method: string, path: string, body?: unknown): Promise<T> => {
  const r = await s.call<T>(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`);
  return r.data;
};
const exportOf = (s: TestServer) => ok<PortableExport>(s, 'GET', '/api/config/export');
const preview = (s: TestServer, file: unknown, choices?: unknown) => s.call<PortableImportPreview>('POST', '/api/config/import/preview', { file, ...(choices ? { choices } : {}) });
const importIt = (s: TestServer, file: unknown, p: PortableImportPreview, choices: unknown = p.choices) => s.call<PortableImportResult>('POST', '/api/config/import', { file, choices, fingerprint: p.fingerprint });
const spendingOf = (s: TestServer, botId: string) => ok<SpendingView>(s, 'GET', `/api/bots/${botId}/spending`);
const capRows = (s: TestServer) => (s.app.store.db.prepare("select key, value from settings where key like 'spendCap:%' order by key").all() as { key: string; value: string }[]).map((r) => `${r.key}=${r.value}`);
const requestRows = (s: TestServer) => s.app.store.db.prepare('select id, bot_id, run_id, state, reserved_usd, cost_usd, at from api_requests order by id').all();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A request the account already has: today, settled at `usd`. */
function spent(s: TestServer, botId: string, usd: number, id = `req_test_${botId}`): void {
  s.app.store.db
    .prepare("insert into api_requests (id, bot_id, turn_id, run_id, routine_id, provider, model, at, reserved_usd, cost_usd, state, ended_at) values (?, ?, 'turn_x', null, null, 'anthropic-api', 'claude-sonnet-5-5', ?, ?, ?, 'settled', ?)")
    .run(id, botId, new Date().toISOString(), usd, usd, new Date().toISOString());
}

/** A source server with Kevin on an API key ($5 a day, one routine at $1.5 a run, one with no cap) and Stuart on the mock. */
async function source() {
  const s = await start();
  const kevin = await s.newBot('Kevin', { provider: 'anthropic-api', model: 'claude-sonnet-5-5' });
  const morning = await s.newRoutine(kevin.id, { name: 'Morning', instruction: 'Brief me' });
  const evening = await s.newRoutine(kevin.id, { name: 'Evening', instruction: 'Sum up' });
  await ok(s, 'PUT', `/api/bots/${kevin.id}/spending`, { dailyCapUsd: 5, routines: { [morning.id]: 1.5 } });
  const stuart = await s.newBot('Stuart');
  spent(s, kevin.id, 0.4242);
  return { s, kevin, morning, evening, stuart };
}

test('caps go with their Boton and routines, onto the ids the import makes; what was spent never goes', async () => {
  const { s: src, kevin, morning } = await source();
  const out = await exportOf(src);
  assert.equal(out.file.version, PORTABLE_VERSION);
  const k = out.file.botons.find((m) => m.name === 'Kevin')!;
  assert.deepEqual([k.dailyCapUsd, k.routines.map((r) => [r.name, r.perRunCapUsd])], [5, [['Morning', 1.5], ['Evening', null]]]);
  assert.equal(out.file.botons.find((m) => m.name === 'Stuart')!.dailyCapUsd, null);
  const text = JSON.stringify(out);
  for (const leaked of [kevin.id, morning.id, 'req_test_', '0.4242']) assert.ok(!text.includes(leaked), `the file holds ${leaked}`);
  assert.ok(out.leftOut.some((x) => x.includes('what API-key turns have spent')));

  const dst = await start();
  const p = (await preview(dst, out.file)).data;
  const kp = p.botons.find((m) => m.name === 'Kevin')!;
  assert.deepEqual(kp.caps, { choice: 'file', daily: { file: 5, imported: 5 }, applies: true, unpriced: false });
  assert.deepEqual(kp.routines.map((r) => r.perRunCap), [{ file: 1.5, imported: 1.5 }, { file: null, imported: null }]);
  assert.equal(p.choices.botons[kp.ref].caps, 'file');
  assert.ok(p.spending.notes.some((n) => n.includes('starting at $0')), p.spending.notes.join('\n'));

  const done = await importIt(dst, out.file, p);
  assert.equal(done.status, 200, done.text);
  const made = done.data.botons.find((m) => m.name === 'Kevin')!;
  assert.notEqual(made.botId, kevin.id);
  const view = await spendingOf(dst, made.botId);
  assert.deepEqual([view.dailyCapUsd, view.spentTodayUsd], [5, 0], 'its own account, from $0');
  const routines = dst.app.store.listRoutines(made.botId);
  assert.deepEqual(
    view.routines.map((r) => [r.name, r.perRunCapUsd]),
    [['Morning', 1.5], ['Evening', null]],
  );
  assert.ok(!routines.some((r) => r.id === morning.id), 'routines get new ids, and the caps follow them');
  assert.deepEqual(made.caps, { dailyCapUsd: 5, routines: [{ id: routines.find((r) => r.name === 'Morning')!.id, name: 'Morning', perRunCapUsd: 1.5 }] });
  assert.ok(routines.every((r) => !r.enabled), 'routines still arrive off');
  assert.deepEqual(requestRows(dst), [], 'no account row comes with the file');

  // Recorded with the Boton it was made with.
  const audit = dst.app.store.db.prepare("select details from audit_events where action = 'boton.created' and target_id = ?").get(made.botId) as { details: string };
  const details = JSON.parse(audit.details);
  assert.equal(details.dailyCap, '$5');
  assert.deepEqual(details.routineCaps, [`${made.caps.routines[0].id} Morning: $1.5 a run`]);
  const imported = JSON.parse((dst.app.store.db.prepare("select details from audit_events where action = 'config.imported'").get() as { details: string }).details);
  assert.equal(imported.spendingCaps, 1);

  // Exported again, the same caps.
  const again = (await exportOf(dst)).file.botons.find((m) => m.name === 'Kevin')!;
  assert.deepEqual([again.dailyCapUsd, again.routines.map((r) => r.perRunCapUsd)], [5, [1.5, null]]);
});

test('an older file has no caps to carry: version 2 and 1 fixtures import with none, and say so; a cap field in them is refused', async () => {
  const v2 = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-2.json'), 'utf8')));
  const read = readPortable(v2);
  assert.equal(read.upgradedFrom, 2);
  assert.ok(read.file.botons.length > 0);
  assert.ok(read.file.botons.every((m) => m.dailyCapUsd === null && m.routines.every((r) => r.perRunCapUsd === null)));
  const dst = await start();
  const p = (await preview(dst, v2)).data;
  assert.ok(p.spending.notes.some((n) => n.includes('format version 2, which carries no spending caps')), p.spending.notes.join('\n'));
  const done = await importIt(dst, v2, p);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(capRows(dst), []);

  const v1 = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-1.json'), 'utf8')));
  assert.ok(readPortable(v1).file.botons.every((m) => m.dailyCapUsd === null));
  assert.ok((await preview(dst, v1)).data.spending.notes.some((n) => n.includes('format version 1')));

  // A version-2 file never had these fields: refused, never read as a cap.
  const withCap = clone(v2);
  withCap.botons[0].dailyCapUsd = 1;
  assert.match((await preview(dst, withCap)).text, /dailyCapUsd.*is not a field of version 2/);
  const withRunCap = clone(v2);
  const m = withRunCap.botons.find((x: { routines: unknown[] }) => x.routines.length);
  m.routines[0].perRunCapUsd = 1;
  assert.match((await preview(dst, withRunCap)).text, /perRunCapUsd.*is not a field of version 2/);
});

test('a cap the format can’t hold refuses the whole file, which changes nothing', async () => {
  const { s: src } = await source();
  const { file } = await exportOf(src);
  const dst = await start();
  const kevin = (f: PortableConfig) => f.botons.find((m) => m.name === 'Kevin')! as unknown as Record<string, unknown> & { routines: Record<string, unknown>[] };
  const cases: [string, (f: PortableConfig) => void, RegExp][] = [
    ['negative', (f) => (kevin(f).dailyCapUsd = -1), /dailyCapUsd must be a number/],
    ['a string', (f) => (kevin(f).dailyCapUsd = '5'), /dailyCapUsd must be a number/],
    ['too high', (f) => (kevin(f).dailyCapUsd = 1e9), /dailyCapUsd must be a number/],
    ['finer than the account keeps', (f) => (kevin(f).dailyCapUsd = 0.123456789), /dailyCapUsd must be a number/],
    ['missing in version 3', (f) => delete kevin(f).dailyCapUsd, /dailyCapUsd/],
    ['a routine’s negative', (f) => (kevin(f).routines[0].perRunCapUsd = -0.5), /perRunCapUsd must be a number/],
    ['a routine’s missing', (f) => delete kevin(f).routines[0].perRunCapUsd, /perRunCapUsd/],
    ['a cap on the Boton by another name', (f) => (kevin(f).spendingCap = 5), /spendingCap.*is not a field/],
  ];
  for (const [name, edit, why] of cases) {
    const f = clone(file);
    edit(f);
    const r = await preview(dst, f);
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.match(r.text, why, name);
  }
  // Choices: only "file" or "none", and never a number to set.
  const ref = file.botons.find((m) => m.name === 'Kevin')!.ref;
  assert.match((await preview(dst, file, { botons: { [ref]: { caps: 'higher' } } })).text, /caps must be \\"file\\" or \\"none\\"/);
  assert.match((await preview(dst, file, { botons: { [ref]: { dailyCapUsd: 100 } } })).text, /dailyCapUsd is not a choice/);
  assert.deepEqual([dst.app.store.listBots().length, capRows(dst)], [0, []]);
});

test('arriving without the file’s caps is the owner’s choice; no import raises, clears or restarts a cap or account already here', async () => {
  const { s: src } = await source();
  const { file } = await exportOf(src);
  const ref = file.botons.find((m) => m.name === 'Kevin')!.ref;
  const dst = await start();
  // A Kevin here already, at $1 a day with $0.7 spent, and its own capped routine.
  const here = await dst.newBot('Kevin', { provider: 'anthropic-api', model: 'claude-sonnet-5-5' });
  const hereRoutine = await dst.newRoutine(here.id, { name: 'Morning' });
  await ok(dst, 'PUT', `/api/bots/${here.id}/spending`, { dailyCapUsd: 1, routines: { [hereRoutine.id]: 0.25 } });
  spent(dst, here.id, 0.7);
  const before = { caps: capRows(dst), rows: requestRows(dst) };

  // The name is in use: left out unless the owner makes another; the file's $5 never lands on this one.
  const p0 = (await preview(dst, file)).data;
  assert.deepEqual([p0.botons.find((m) => m.ref === ref)!.action, p0.botons.find((m) => m.ref === ref)!.conflict], ['skip', true]);

  // Made anyway, without its caps: the owner's explicit choice, shown and recorded.
  const p = (await preview(dst, file, { botons: { [ref]: { action: 'create', caps: 'none' } } })).data;
  const kp = p.botons.find((m) => m.ref === ref)!;
  assert.deepEqual(kp.caps.daily, { file: 5, imported: null });
  assert.deepEqual(kp.routines.map((r) => r.perRunCap.imported), [null, null]);
  assert.ok(p.spending.notes.some((n) => n.includes('you chose to leave out the file’s spending caps') || n.includes("you chose to leave out the file's spending caps")), p.spending.notes.join('\n'));
  const done = await importIt(dst, file, p);
  assert.equal(done.status, 200, done.text);
  const made = done.data.botons.find((m) => m.ref === ref)!;
  assert.deepEqual(made.caps, { dailyCapUsd: null, routines: [] });
  assert.equal((await spendingOf(dst, made.botId)).dailyCapUsd, null);
  const details = JSON.parse((dst.app.store.db.prepare("select details from audit_events where action = 'boton.created' and target_id = ?").get(made.botId) as { details: string }).details);
  assert.equal(details.dailyCap, 'none');

  // The Kevin that was here: its caps and its account exactly as they were.
  assert.deepEqual(requestRows(dst), before.rows);
  assert.deepEqual(capRows(dst).filter((r) => r.includes(here.id) || r.includes(hereRoutine.id)), before.caps);
  const hereView = await spendingOf(dst, here.id);
  assert.deepEqual([hereView.dailyCapUsd, hereView.spentTodayUsd, hereView.routines[0].perRunCapUsd], [1, 0.7, 0.25]);

  // And with the file's caps (the default), another new Boton gets them, the one here still keeps its own.
  const p2 = (await preview(dst, file, { botons: { [ref]: { action: 'create' } } })).data;
  const done2 = await importIt(dst, file, p2);
  assert.equal(done2.status, 200, done2.text);
  const second = done2.data.botons.find((m) => m.ref === ref)!;
  assert.deepEqual([(await spendingOf(dst, second.botId)).dailyCapUsd, (await spendingOf(dst, second.botId)).spentTodayUsd], [5, 0]);
  assert.equal((await spendingOf(dst, here.id)).dailyCapUsd, 1);
  assert.deepEqual(requestRows(dst), before.rows);
});

test('importCaps refuses everything but a Boton just made, inside the import', async () => {
  const dst = await start();
  const kevin = await dst.newBot('Kevin', { provider: 'anthropic-api', model: 'claude-sonnet-5-5' });
  const r = await dst.newRoutine(kevin.id, { name: 'Morning' });
  const bob = await dst.newBot('Bob');
  const bobRoutine = await dst.newRoutine(bob.id, { name: 'Other' });
  const sp = dst.app.spending;
  const inTx = (fn: () => void) => dst.app.store.atomically(fn);
  assert.throws(() => sp.importCaps(kevin.id, 1, []), /inside the import/);
  assert.throws(() => inTx(() => sp.importCaps(kevin.id, -1, [])), /out of range/);
  assert.throws(() => inTx(() => sp.importCaps(kevin.id, 1, [[bobRoutine.id, 1]])), /another Boton/);
  assert.deepEqual(capRows(dst), [], 'a refused import writes nothing');
  // A fresh Boton: fine once.
  inTx(() => sp.importCaps(kevin.id, 2, [[r.id, 0.5]]));
  assert.deepEqual(capRows(dst).length, 2);
  // Never over a cap already set (no raise, no clear), nor on a Boton with an account.
  assert.throws(() => inTx(() => sp.importCaps(kevin.id, 50, [])), /just made/);
  assert.throws(() => inTx(() => sp.importCaps(kevin.id, null, [])), /just made/);
  assert.equal((await spendingOf(dst, kevin.id)).dailyCapUsd, 2);
  spent(dst, bob.id, 0.1);
  assert.throws(() => inTx(() => sp.importCaps(bob.id, 9, [])), /just made/);
  assert.equal((await spendingOf(dst, bob.id)).spentTodayUsd, 0.1);
});

test('a preview made before the file, the caps choice or the prices changed is refused', async () => {
  const { s: src } = await source();
  const { file } = await exportOf(src);
  const ref = file.botons.find((m) => m.name === 'Kevin')!.ref;
  const dst = await start();
  const p = (await preview(dst, file)).data;

  const higher = clone(file);
  higher.botons.find((m) => m.ref === ref)!.dailyCapUsd = 500;
  assert.equal((await importIt(dst, higher, p)).status, 409, 'a cap raised in the file after the preview');
  const lowered = clone(file);
  lowered.botons.find((m) => m.ref === ref)!.routines[0].perRunCapUsd = null;
  assert.equal((await importIt(dst, lowered, p)).status, 409, 'a routine cap taken out after the preview');
  const dropped = { ...p.choices, botons: { ...p.choices.botons, [ref]: { ...p.choices.botons[ref], caps: 'none' } } };
  assert.equal((await importIt(dst, file, p, dropped)).status, 409, 'caps left out after a preview that had them');
  assert.deepEqual([dst.app.store.listBots().length, capRows(dst)], [0, []]);

  // A model whose price this server doesn't know: shown, so a preview from when it was known doesn't apply.
  const unknown = clone(file);
  unknown.botons.find((m) => m.ref === ref)!.model = 'claude-sonnet-0-0';
  assert.equal(rateFor('anthropic', 'claude-sonnet-0-0'), null);
  const pu = (await preview(dst, unknown)).data;
  const ku = pu.botons.find((m) => m.ref === ref)!;
  assert.deepEqual([ku.caps.applies, ku.caps.unpriced], [true, true]);
  assert.ok(pu.spending.notes.some((n) => n.includes('no known price here')), pu.spending.notes.join('\n'));
  assert.notEqual(pu.fingerprint, p.fingerprint);

  // On a brain that isn't an API key, its caps are kept but count nothing: said so.
  const mock = clone(file);
  mock.botons.find((m) => m.ref === ref)!.provider = 'mock';
  mock.botons.find((m) => m.ref === ref)!.model = '';
  const pm = (await preview(dst, mock)).data;
  assert.equal(pm.botons.find((m) => m.ref === ref)!.caps.applies, false);
  assert.ok(pm.spending.notes.some((n) => n.includes('count only API-key turns')), pm.spending.notes.join('\n'));

  assert.equal((await importIt(dst, file, p)).status, 200, 'the preview as it was still applies');
});

test('an import that fails part way keeps no cap, publishes nothing and loses no account row, a reservation in flight included', async () => {
  const { s: src } = await source();
  const { file } = await exportOf(src);
  const dst = await start();
  const here = await dst.newBot('Bob', { provider: 'anthropic-api', model: 'claude-sonnet-5-5' });
  await ok(dst, 'PUT', `/api/bots/${here.id}/spending`, { dailyCapUsd: 1 });
  spent(dst, here.id, 0.3);
  // A request of Bob's reserved and not yet answered while the import runs.
  const reservation = dst.app.spending.reserve(
    { botId: here.id, turnId: 'turn_live', runId: null, routineId: null },
    { provider: 'anthropic-api', model: 'claude-sonnet-5-5', rate: rateFor('anthropic', 'claude-sonnet-5-5'), inputTokens: 1000, maxOutput: 1000, minOutput: 100 },
  );
  const before = { caps: capRows(dst), rows: requestRows(dst) };
  const p = (await preview(dst, file)).data;

  const seen: ServerEvent[] = [];
  dst.app.hub.subscribe((e) => seen.push(e));
  const original = dst.app.spending.importCaps.bind(dst.app.spending);
  let calls = 0;
  dst.app.spending.importCaps = (...args: Parameters<typeof original>) => {
    original(...args);
    if (++calls === 2) throw new Error('disk on fire');
  };
  const failed = await importIt(dst, file, p);
  dst.app.spending.importCaps = original;
  assert.equal(failed.status, 500, failed.text);
  assert.equal(calls, 2, 'the first Boton’s caps were written before the failure');
  assert.deepEqual(capRows(dst), before.caps, 'and rolled back with it');
  assert.deepEqual(requestRows(dst), before.rows);
  assert.deepEqual(dst.app.store.listBots().map((b) => b.name), ['Bob']);
  assert.deepEqual(seen.filter((e) => e.type !== 'bot.status').map((e) => e.type), [], 'nothing a rolled-back import did is published');
  assert.equal((dst.app.store.db.prepare("select count(*) as n from audit_events where action = 'config.imported'").get() as { n: number }).n, 0);

  // The reservation still counts, and settles as it would have.
  const mid = await spendingOf(dst, here.id);
  assert.equal(mid.spentTodayUsd, Math.round((0.3 + reservation.usd!) * 1e8) / 1e8);
  reservation.settle(0.01);
  assert.equal((await spendingOf(dst, here.id)).spentTodayUsd, 0.31);

  const done = await importIt(dst, file, p);
  assert.equal(done.status, 200, done.text);
  assert.equal((await spendingOf(dst, here.id)).spentTodayUsd, 0.31);
  assert.equal((await spendingOf(dst, here.id)).dailyCapUsd, 1);
});

test('the version-3 fixture keeps importing with its caps, onto new ids, its Critter looks as their closest Botons', async () => {
  const v3 = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-3.json'), 'utf8')));
  const { file, upgradedFrom } = readPortable(v3);
  assert.equal(upgradedFrom, 3);
  assert.deepEqual(file.botons[0].look, lookFromTater(taterFromCritter(v3.botons[0].look)));
  assert.deepEqual(file.templates[0].bot.look, lookFromTater(taterFromCritter(v3.templates[0].bot.look)));
  // A look that is neither a Critter nor anything else refuses the file, and says where.
  assert.throws(() => readPortable({ ...v3, botons: [{ ...v3.botons[0], look: { ...v3.botons[0].look, color: 'yellow' } }] }), /botons\[0\]\.look/);
  const dst = await start();
  const p = (await preview(dst, v3)).data;
  const dave = p.botons.find((m) => m.name === 'Dave')!;
  assert.deepEqual([dave.caps.daily, dave.routines[0].perRunCap, dave.caps.applies], [{ file: 2.5, imported: 2.5 }, { file: 0.75, imported: 0.75 }, false]);
  const done = await importIt(dst, v3, p);
  assert.equal(done.status, 200, done.text);
  const made = done.data.botons.find((m) => m.name === 'Dave')!;
  assert.deepEqual(dst.app.store.getBot(made.botId).look, file.botons[0].look);
  const view = await spendingOf(dst, made.botId);
  assert.deepEqual([view.dailyCapUsd, view.routines[0].perRunCapUsd, view.spentTodayUsd], [2.5, 0.75, 0]);
});

test('a version-4 file reads its tater looks as their closest Botons; a look that is not a tater look refuses it', () => {
  const v3 = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-3.json'), 'utf8')));
  const tater = (c: unknown) => taterFromCritter(c as Parameters<typeof taterFromCritter>[0]);
  const v4 = { ...v3, version: 4, botons: v3.botons.map((m: { look: unknown }) => ({ ...m, look: tater(m.look) })), templates: v3.templates.map((t: { bot: { look: unknown } }) => ({ ...t, bot: { ...t.bot, look: tater(t.bot.look) } })) };
  const { file, upgradedFrom } = readPortable(v4);
  assert.equal(upgradedFrom, 4);
  assert.deepEqual(file.botons[0].look, lookFromTater(v4.botons[0].look));
  assert.deepEqual(file.templates[0].bot.look, lookFromTater(v4.templates[0].bot.look));
  assert.throws(() => readPortable({ ...v4, botons: [{ ...v4.botons[0], look: file.botons[0].look }] }), /botons\[0\]\.look/);
  assert.throws(() => readPortable({ ...v4, botons: [{ ...v4.botons[0], look: { ...v4.botons[0].look, toast: 'blue' } }] }), /botons\[0\]\.look/);
});

test('cap previews price each routine effective model and name only affected routines', async () => {
  const { s: src } = await source();
  const { file } = await exportOf(src);
  const k = file.botons.find((m) => m.name === 'Kevin')!;
  const dst = await start();
  k.dailyCapUsd = null;
  k.routines[0].model = 'claude-unpriced';
  k.routines[0].perRunCapUsd = 0.75;
  let p = (await preview(dst, file)).data;
  assert.equal(p.botons.find((m) => m.ref === k.ref)!.caps.unpriced, true);
  assert.ok(p.spending.notes.some((n) => n.includes('Morning') && n.includes('no known price')), p.spending.notes.join('\n'));
  k.model = 'claude-unpriced';
  k.routines[0].model = 'claude-sonnet-5-5';
  p = (await preview(dst, file)).data;
  assert.equal(p.botons.find((m) => m.ref === k.ref)!.caps.unpriced, false, 'an uncapped default does not make its priced capped override unpriced');
  assert.ok(!p.spending.notes.some((n) => n.includes('no known price')));
  k.dailyCapUsd = 2;
  p = (await preview(dst, file)).data;
  assert.equal(p.botons.find((m) => m.ref === k.ref)!.caps.unpriced, true);
  assert.ok(p.spending.notes.some((n) => n.includes('Evening') && n.includes('no known price')), p.spending.notes.join('\n'));
  assert.ok(!p.spending.notes.some((n) => n.includes('Morning') && n.includes('no known price')));
  k.routines[0].model = 'claude-unpriced';
  k.model = 'claude-sonnet-5-5';
  k.routines[0].perRunCapUsd = null;
  p = (await preview(dst, file)).data;
  assert.ok(p.spending.notes.some((n) => n.includes('Morning') && n.includes('no known price')), 'the daily cap also covers an unpriced routine override');
});
