import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import type { AuditEvent, Bot, BotTemplate, Routine, SetupCheck, TemplateReview } from '../../shared/types.ts';
import { startServer, until } from './helpers.ts';

const s = await startServer({ env: { BOTONS_TZ: 'UTC' } });
const { app, home, call } = s;

const review = (id: string, body: Record<string, unknown>) => call<TemplateReview>('POST', `/api/templates/${id}/review`, body);
const install = (body: Record<string, unknown>) => call<Bot>('POST', '/api/bots', body);
const check = (botId: string, body: Record<string, unknown>) => call<SetupCheck>('POST', `/api/bots/${botId}/setup-check`, body);
const routinesOf = async (id: string) => (await call<Routine[]>('GET', `/api/bots/${id}/routines`)).data;
const item = (c: SetupCheck, key: string) => c.items.find((i) => i.key === key || i.key.startsWith(key));

const TICKET = ['builtin-morning-brief', 'builtin-repo-monitor', 'builtin-webhook-research', 'builtin-inbox-triage', 'builtin-file-report'];

test('every built-in starter declares its brain, access, connectors, schedule, output and failure behavior, and names no connector of anyone', async () => {
  const list = (await call<BotTemplate[]>('GET', '/api/templates')).data;
  for (const id of TICKET) assert.ok(list.some((t) => t.id === id), id);
  for (const t of list.filter((x) => x.builtin)) {
    const n = t.needs!;
    assert.ok(n, `${t.id} declares needs`);
    assert.ok(n.brain.text && n.accessWhy && n.schedule && n.output.text && n.failure && n.notChecked.length, t.id);
    assert.equal(n.access, 'workspace', `${t.id} asks for no more than Workspace access`);
    assert.deepEqual(t.bot.connections, [], `${t.id}: connectors are slots the owner fills, never ids`);
    assert.deepEqual(t.bot.skills, [], `${t.id}: no skills unless given`);
    assert.equal(n.brain.connectors, n.connectors.some((c) => c.required), `${t.id}: a required connector needs a brain that takes them`);
    for (const r of t.routines) assert.ok(r.scheduleText || r.webhook || t.routines.length === 0, `${t.id}/${r.name} has a trigger`);
  }
  const research = list.find((t) => t.id === 'builtin-webhook-research')!;
  assert.deepEqual(research.routines.map((r) => [r.webhook, r.webhookWorkspace, r.schedule]), [[true, true, null]]);
  assert.ok(research.needs!.samplePayload);
});

test('a saved template file cannot make itself a starter', async () => {
  mkdirSync(join(home, 'templates'), { recursive: true });
  writeFileSync(join(home, 'templates', 'tpl_selfdecl.json'), JSON.stringify({ name: 'Sneaky', bot: { title: 'x' }, routines: [], needs: { access: 'host' } }));
  const t = (await call<BotTemplate[]>('GET', '/api/templates')).data.find((x) => x.id === 'tpl_selfdecl')!;
  assert.equal(t.needs, null);
  assert.equal((await review('tpl_selfdecl', { provider: 'mock', access: 'workspace' })).status, 400);
});

test('the daily brief installs only exactly as reviewed, paused, with no connectors or skills', async () => {
  const r = await review('builtin-morning-brief', { provider: 'mock', access: 'workspace', connectors: { calendar: null } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.blocked, []);
  assert.equal(r.data.access.state, 'ok');
  assert.equal(r.data.slots[0].state, 'ok');
  assert.match(r.data.slots[0].text, /goes without calendar \(optional\)/);
  assert.match(r.data.slots[0].guidance ?? '', /no connector yet for calendar.*Settings → Connect a service/);
  assert.deepEqual(r.data.routines.map((x) => [x.name, x.scheduleText, x.timezone]), [['Morning brief', 'Weekdays at 8:00 AM', 'UTC']]);
  assert.match(r.data.routines[0].text, /Starts paused/);
  assert.ok(r.data.grants.includes('No connectors.') && r.data.grants.includes('No skills.'));
  // The same choices give the same key; another access level another one, said as more than it asks for.
  assert.equal((await review('builtin-morning-brief', { provider: 'mock', access: 'workspace' })).data.reviewKey, r.data.reviewKey);
  const host = (await review('builtin-morning-brief', { provider: 'mock', access: 'host' })).data;
  assert.notEqual(host.reviewKey, r.data.reviewKey);
  assert.equal(host.access.state, 'warning');
  assert.match(host.access.text, /More than Daily brief asks for/);

  const base = { name: 'Kevin', provider: 'mock', access: 'workspace', templateId: 'builtin-morning-brief', starterConnectors: { calendar: null } };
  const before = app.store.listBots().length;
  assert.equal((await install(base)).status, 400, 'no review key');
  assert.equal((await install({ ...base, reviewKey: r.data.reviewKey, startRoutines: true })).status, 400, 'never started by installing');
  assert.equal((await install({ ...base, reviewKey: r.data.reviewKey, connections: ['lib:anything'] })).status, 400, 'no connectors beside the slots');
  assert.equal((await install({ ...base, reviewKey: r.data.reviewKey, skills: ['standup'] })).status, 400, 'no skills beside its own');
  assert.equal((await install({ ...base, reviewKey: host.reviewKey })).status, 409, 'a key for other access is stale');
  assert.equal((await install({ ...base, access: 'host', reviewKey: r.data.reviewKey })).status, 409, 'other access than reviewed');
  assert.equal(app.store.listBots().length, before, 'nothing made by a refused install');

  const made = await install({ ...base, reviewKey: r.data.reviewKey });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.data.access, made.data.connections, made.data.skills], ['workspace', [], []]);
  assert.deepEqual((await routinesOf(made.data.id)).map((x) => [x.name, x.enabled]), [['Morning brief', false]]);
  const audit = (await call<AuditEvent[]>('GET', '/api/audit')).data.find((e) => e.action === 'boton.created' && e.target?.id === made.data.id);
  assert.ok(audit, 'the install is audited with its grants');
});

test('a starter that needs a connector guides the owner to one, takes only the one they choose, and refuses a stale review', async () => {
  const empty = (await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace' })).data;
  assert.equal(empty.slots[0].state, 'blocked');
  assert.deepEqual(empty.slots[0].candidates, []);
  assert.match(empty.slots[0].guidance ?? '', /no connector yet for code host\. Add one in Settings → Connect a service \(for example github or gitlab\)/);
  assert.ok(empty.blocked.length);

  // Two of the owner's own connectors: the matching one is suggested first, and neither is granted until chosen.
  await call('POST', '/api/mcp-servers', { name: 'bob_notes', transport: 'http', url: 'https://notes.example.com/mcp' });
  await call('POST', '/api/mcp-servers', { name: 'code_github', transport: 'http', url: 'https://mcp.example.com/github' });
  const mock = (await review('builtin-repo-monitor', { provider: 'mock', access: 'workspace', connectors: { 'code-host': 'lib:code_github' } })).data;
  assert.equal(mock.brain.state, 'blocked', "a brain that can't take connectors is refused for it");
  assert.match(mock.brain.text, /can't use connectors.*Pick one that can/);
  const unchosen = (await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace' })).data;
  assert.deepEqual(unchosen.slots[0].candidates.map((c) => [c.id, c.suggested, c.problem]), [['lib:code_github', true, null], ['lib:bob_notes', false, null]]);
  assert.match(unchosen.slots[0].text, /Choose which of yours it uses/);
  const r = (await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace', connectors: { 'code-host': 'lib:code_github' } })).data;
  assert.deepEqual(r.blocked, []);
  assert.equal(r.brain.state, 'warning', 'the brain not being ready here is said, not hidden');
  assert.match(r.slots[0].text, /the grant is the whole connector/);
  assert.ok(r.grants.includes('Connectors: code_github (code host).'));
  assert.equal((await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace', connectors: { other: 'lib:code_github' } })).status, 400);

  const body = { name: 'Stuart', provider: 'claude-cli', access: 'workspace', templateId: 'builtin-repo-monitor', starterConnectors: { 'code-host': 'lib:code_github' }, reviewKey: r.reviewKey };
  // Turned off after the review: the install is refused as stale, and the new review says why.
  const off = await call('PUT', '/api/connectors/lib:code_github/enabled', { enabled: false, expected: { enabled: true, botIds: [], running: [] } });
  assert.equal(off.status, 200, off.text);
  const stale = await install(body);
  assert.equal(stale.status, 409);
  assert.match(stale.text, /changed since you reviewed it/);
  const again = (await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace', connectors: { 'code-host': 'lib:code_github' } })).data;
  assert.equal(again.slots[0].state, 'blocked');
  assert.match(again.blocked[0], /Turned off/);
  assert.equal((await install({ ...body, reviewKey: again.reviewKey })).status, 400, 'a blocked review installs nothing');
  // On again: an off and on is a new generation of the connector, so the first review is still stale; a new one installs.
  await call('PUT', '/api/connectors/lib:code_github/enabled', { enabled: true, expected: { enabled: false, botIds: [], running: [] } });
  assert.equal((await install(body)).status, 409, 'reviewed before an off and on: reviewed again');
  const onAgain = (await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace', connectors: { 'code-host': 'lib:code_github' } })).data;
  assert.deepEqual(onAgain.blocked, []);
  const made = await install({ ...body, reviewKey: onAgain.reviewKey });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(made.data.connections, [BROWSER_CONNECTOR, 'lib:code_github'], 'only the chosen connector (and the browser every new Boton gets), not the other one');
  assert.deepEqual((await routinesOf(made.data.id)).map((x) => x.enabled), [false]);

  const c = (await check(made.data.id, { templateId: 'builtin-repo-monitor', connectors: { 'code-host': 'lib:code_github' } })).data;
  assert.equal(item(c, 'connector:code-host')!.state, 'unverified', 'not tested, so not claimed to work');
  assert.match(item(c, 'connector:code-host')!.text, /not tested since the server started: Test it in Settings → Connectors/);
  assert.equal(item(c, 'brain')!.state, 'problem');
  assert.equal(c.ready, false);
  assert.match(c.scope, /Nothing was run, no connector or service was reached/);
  // Taken off the Boton afterwards: the check says so.
  await call('PATCH', `/api/bots/${made.data.id}`, { connections: [] });
  const gone = (await check(made.data.id, { templateId: 'builtin-repo-monitor', connectors: { 'code-host': 'lib:code_github' } })).data;
  assert.match(item(gone, 'connector:code-host')!.text, /no longer one of Stuart's connectors/);
});

test('the setup check runs nothing; a test run is a dry run whose result it reports; a failed one keeps the routine paused', async () => {
  const r = (await review('builtin-webhook-research', { provider: 'mock', access: 'workspace' })).data;
  const made = (await install({ name: 'Bob', provider: 'mock', access: 'workspace', templateId: 'builtin-webhook-research', starterConnectors: {}, reviewKey: r.reviewKey })).data;
  const [routine] = await routinesOf(made.id);
  assert.equal(routine.enabled, false);
  const turns = s.mock.turns.length;
  const first = await check(made.id, { templateId: 'builtin-webhook-research' });
  assert.equal(first.status, 200, first.text);
  assert.equal(s.mock.turns.length, turns, 'the check started no turn');
  assert.equal(item(first.data, 'test:')!.state, 'unverified');
  assert.match(item(first.data, 'routine:')!.text, /Paused until you turn it on\. Its webhook URL and key are in the routine's settings \(not shown here\)/);
  // The webhook key is in neither the review nor the check.
  assert.ok(routine.webhook?.key);
  for (const text of [JSON.stringify(r), first.text]) assert.ok(!text.includes(routine.webhook!.key), 'no webhook key');

  // A failing test run (the mock fails on request): the check says it failed and why; nothing is turned on.
  const fail = await call('POST', `/api/routines/${routine.id}/run`, { test: true, payload: JSON.stringify({ topic: 'FAIL_PLEASE' }) });
  assert.equal(fail.status, 202, fail.text);
  await until(async () => (await s.runsOf(routine.id)).find((x) => x.id === fail.data.id && x.status === 'failed'), 6000);
  const failed = (await check(made.id, { templateId: 'builtin-webhook-research' })).data;
  assert.equal(item(failed, 'test:')!.state, 'problem');
  assert.match(item(failed, 'test:')!.text, /latest test run failed at .*It said: Mock failure requested/);
  assert.equal(failed.ready, false);
  assert.equal((await routinesOf(made.id))[0].enabled, false);
  // The test run was told it is a dry run, with the sample payload, and sandboxed like a webhook run.
  const turn = s.mock.turns.at(-1)!;
  assert.match(turn.prompt, /Treat it as a dry run/);

  const ok = await call('POST', `/api/routines/${routine.id}/run`, { test: true, payload: r && JSON.stringify({ topic: 'Node.js' }) });
  await until(async () => (await s.runsOf(routine.id)).find((x) => x.id === ok.data.id && x.status === 'succeeded'), 6000);
  const passed = (await check(made.id, { templateId: 'builtin-webhook-research' })).data;
  assert.equal(item(passed, 'test:')!.state, 'ok');
  assert.equal(passed.ready, true, JSON.stringify(passed.items));
  assert.equal((await routinesOf(made.id))[0].enabled, false, 'passing a test turns nothing on');

  // Not with an ordinary resume, even the owner's: only with the activation, which checks the test run.
  const patched = await call('PATCH', `/api/routines/${routine.id}`, { enabled: true });
  assert.equal(patched.status, 409, patched.text);
  assert.match(patched.text, /came with a starter and waits on/);
  const on = await call<Routine>('POST', `/api/routines/${routine.id}/activate`, {});
  assert.equal(on.status, 200, on.text);
  assert.equal(on.data.enabled, true);
  assert.match(item((await check(made.id, { templateId: 'builtin-webhook-research' })).data, 'routine:')!.text, /^On\./);
});

test('review and check are the owner’s: a Boton token gets neither', async () => {
  const bot = await s.newBot('Dave');
  const boton = app.auth.mintBotonToken(bot.id).token;
  assert.equal((await call('POST', '/api/templates/builtin-morning-brief/review', { provider: 'mock', access: 'workspace' }, boton)).status, 403);
  assert.equal((await call('POST', `/api/bots/${bot.id}/setup-check`, { templateId: 'builtin-morning-brief' }, boton)).status, 403);
  assert.equal((await call('POST', `/api/bots/${bot.id}/setup-check`, {})).status, 400);
  assert.equal((await call('POST', '/api/templates/builtin-nothere/review', { provider: 'mock', access: 'workspace' })).status, 404);
});
