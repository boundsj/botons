import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditEvent, Bot, BotTemplate, Routine, RoutineRun, SetupCheck, StarterInstall, TemplateReview } from '../../shared/types.ts';
import { botonCli, startServer, until } from './helpers.ts';

/*
 * Who can turn a starter's routine on, and on what evidence: only the owner, through the activation, after a test run
 * of exactly its current settings finished (or by an audited override). Every other way in is refused.
 */

const s = await startServer({ env: { BOTONS_TZ: 'UTC' } });
const { app, call, base } = s;

const review = (id: string, body: Record<string, unknown>) => call<TemplateReview>('POST', `/api/templates/${id}/review`, body);
const routinesOf = async (id: string) => (await call<Routine[]>('GET', `/api/bots/${id}/routines`)).data;
const activate = (id: string, body: Record<string, unknown> = {}, token?: string) => call<Routine>('POST', `/api/routines/${id}/activate`, body, token);

/** The web watcher (one scheduled routine, no connectors) on the mock brain, installed as reviewed. */
async function watcher(name: string): Promise<{ bot: Bot; routine: Routine }> {
  const r = (await review('builtin-web-watcher', { provider: 'mock', access: 'workspace' })).data;
  const made = await call<Bot>('POST', '/api/bots', { name, provider: 'mock', access: 'workspace', templateId: 'builtin-web-watcher', starterConnectors: {}, reviewKey: r.reviewKey });
  assert.equal(made.status, 201, made.text);
  const [routine] = await routinesOf(made.data.id);
  assert.equal(routine.enabled, false);
  return { bot: made.data, routine };
}

async function testRun(routine: Routine, want: RoutineRun['status'] = 'succeeded'): Promise<RoutineRun> {
  const started = await call<RoutineRun>('POST', `/api/routines/${routine.id}/run`, { test: true });
  assert.equal(started.status, 202, started.text);
  return (await until(async () => (await s.runsOf(routine.id)).find((x) => x.id === started.data.id && (x.status === 'succeeded' || x.status === 'failed')), 6000))!;
}

const gateOf = async (botId: string, routineId: string) => (await call<SetupCheck>('POST', `/api/bots/${botId}/setup-check`, {})).data.routines.find((g) => g.routineId === routineId)!;

test('a Boton cannot turn its starter routine on: not by PATCH, not with `botons routine update --resume`, not through the activation', async () => {
  const { bot, routine } = await watcher('Kevin');
  const boton = app.auth.mintBotonToken(bot.id).token;
  const patched = await call('PATCH', `/api/routines/${routine.id}`, { enabled: true }, boton);
  assert.equal(patched.status, 409, patched.text);
  const cli = await botonCli(app, base, bot.id, 'routine', 'update', routine.id, '--resume');
  assert.notEqual(cli.code, 0, cli.stdout);
  assert.match(cli.stderr, /came with a starter and waits on/);
  assert.equal((await activate(routine.id, { override: true }, boton)).status, 403, 'the activation is the owner’s alone');
  // Even after a passing test: the evidence is the owner's to act on.
  await testRun(routine);
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: true }, boton)).status, 409);
  assert.equal((await activate(routine.id, {}, boton)).status, 403);
  assert.equal((await routinesOf(bot.id))[0].enabled, false);
  // Its other edits still work, and leave it paused.
  const edited = await call<Routine>('PATCH', `/api/routines/${routine.id}`, { instruction: 'Check each page in watch-list.md.' }, boton);
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.data.enabled, false);
});

test('the owner turns it on only through the activation: a plain resume is refused, no test refuses, an override is audited, and then it is ordinary', async () => {
  const { bot, routine } = await watcher('Stuart');
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: true })).status, 409, "the owner's own resume");
  const untested = await activate(routine.id);
  assert.equal(untested.status, 409);
  assert.match(untested.text, /Not tested yet.*override/);
  assert.equal((await activate(routine.id, { override: 'yes' })).status, 400, 'override is true or false');
  const on = await activate(routine.id, { override: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.data.enabled, true);
  const audit = (await call<AuditEvent[]>('GET', '/api/audit')).data.find((e) => e.action === 'routine.starter_activated' && e.target?.id === routine.id);
  assert.deepEqual([audit?.details?.override, audit?.details?.testRunId], [true, null]);
  assert.deepEqual((await call<StarterInstall>('GET', `/api/bots/${bot.id}/starter`)).data.pending, []);
  // Ordinary from now on: pausing and resuming are anyone's who could before, the Boton's included.
  const boton = app.auth.mintBotonToken(bot.id).token;
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: false }, boton)).status, 200);
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: true }, boton)).status, 200);
  assert.equal((await activate(routine.id)).status, 400, 'nothing left to activate');
});

test('ordinary routines are not held: a paused one is resumed by the owner or its Boton as before', async () => {
  const bot = await s.newBot('Dave');
  const routine = await s.newRoutine(bot.id, { schedule: 'daily at 9:00', enabled: false });
  assert.equal((await call('GET', `/api/bots/${bot.id}/starter`)).data, null);
  const boton = app.auth.mintBotonToken(bot.id).token;
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: true }, boton)).status, 200);
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: false })).status, 200);
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { enabled: true })).status, 200);
  assert.equal((await call('POST', `/api/bots/${bot.id}/setup-check`, {})).status, 400, 'not installed from a starter');
});

test('a passing test turns it on only on the settings it ran on: each edit since, or a test under way or failing, refuses', async () => {
  const { bot, routine } = await watcher('Bob');
  const refuses = async (why: RegExp) => {
    const r = await activate(routine.id);
    assert.equal(r.status, 409, r.text);
    assert.match(r.text, why);
    assert.equal((await gateOf(bot.id, routine.id)).tested, false, 'the check no longer shows the old pass');
  };
  const run = await testRun(routine);
  const g = await gateOf(bot.id, routine.id);
  assert.deepEqual([g.tested, g.runId], [true, run.id]);
  assert.match(g.text, /finished without an error.*doesn't show its output was right/);

  // The Boton: instructions, model, effort, access, what it may do without asking.
  for (const patch of [{ instructions: 'Report every change, however small.' }, { model: 'echo-1' }, { effort: 'high' }, { access: 'host' }, { askFirst: ['Bash(rm:*)'] }]) {
    const p = await call('PATCH', `/api/bots/${bot.id}`, patch);
    assert.equal(p.status, 200, `${JSON.stringify(patch)}: ${p.text}`);
    await refuses(/Changed since the latest test run.*the Boton's settings/);
    await testRun(routine);
  }
  // The routine itself.
  await call('PATCH', `/api/routines/${routine.id}`, { instruction: 'Check only the first page.' });
  await refuses(/the routine/);
  await testRun(routine);
  await call('PATCH', `/api/routines/${routine.id}`, { model: 'echo-1' });
  await refuses(/the routine/);
  await testRun(routine);

  // A connector given, then its URL, its credentials, deleted and made again under the same name, off and on.
  assert.equal((await call('POST', '/api/mcp-servers', { name: 'pages', transport: 'http', url: 'https://pages.example.com/mcp', headers: { Authorization: 'Bearer one' } })).status, 201);
  assert.equal((await call('PATCH', `/api/bots/${bot.id}`, { connections: ['lib:pages'] })).status, 200);
  await refuses(/its connectors/);
  const edits: Array<() => Promise<unknown>> = [
    () => call('PATCH', '/api/mcp-servers/pages', { url: 'https://pages.example.com/mcp2' }),
    () => call('PATCH', '/api/mcp-servers/pages', { headers: { Authorization: 'Bearer two' } }),
    async () => {
      await call('DELETE', '/api/mcp-servers/pages');
      await call('POST', '/api/mcp-servers', { name: 'pages', transport: 'http', url: 'https://pages.example.com/mcp2', headers: { Authorization: 'Bearer two' } });
      await call('PATCH', `/api/bots/${bot.id}`, { connections: ['lib:pages'] });
    },
    async () => {
      await call('PUT', '/api/connectors/lib:pages/enabled', { enabled: false, expected: { enabled: true, botIds: [bot.id], running: [] } });
      await call('PUT', '/api/connectors/lib:pages/enabled', { enabled: true, expected: { enabled: false, botIds: [bot.id], running: [] } });
    },
  ];
  for (const edit of edits) {
    await testRun(routine);
    await edit();
    await refuses(/its connectors/);
  }

  // Passing, then a new test under way: the old pass doesn't count until it ends, and then only if it passed.
  await testRun(routine);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  s.mock.script = async () => {
    await held;
    throw new Error('the retest failed');
  };
  try {
    const started = await call<RoutineRun>('POST', `/api/routines/${routine.id}/run`, { test: true });
    await until(async () => (await gateOf(bot.id, routine.id)).testing, 6000);
    for (const body of [{}, { override: true }]) {
      const r = await activate(routine.id, body);
      assert.equal(r.status, 409, r.text);
      assert.match(r.text, /test run is (queued|running)/);
    }
    release();
    await until(async () => (await s.runsOf(routine.id)).find((x) => x.id === started.data.id && x.status === 'failed'), 6000);
  } finally {
    s.mock.script = null;
  }
  await refuses(/latest test run failed/);
  assert.equal((await routinesOf(bot.id))[0].enabled, false);

  // Passing again on what it has now: on, with the run it rests on in the audit.
  const pass = await testRun(routine);
  const on = await activate(routine.id);
  assert.equal(on.status, 200, on.text);
  const audit = (await call<AuditEvent[]>('GET', '/api/audit')).data.find((e) => e.action === 'routine.starter_activated' && e.target?.id === routine.id);
  assert.deepEqual([audit?.details?.override, audit?.details?.testRunId], [false, pass.id]);
});

test("the review key binds each chosen connector's setup: a URL, command, args or credential edit, a delete and re-add, an off and on are reviewed again", async () => {
  await call('POST', '/api/mcp-servers', { name: 'gh_code', transport: 'http', url: 'https://mcp.example.com/github', headers: { Authorization: 'Bearer a' } });
  await call('POST', '/api/mcp-servers', { name: 'gl_code', transport: 'stdio', command: 'gitlab-mcp', args: ['--read-only'], env: { TOKEN: 'a' } });
  const keyFor = async (id: string) => {
    const r = await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace', connectors: { 'code-host': id } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data.blocked, []);
    return r.data.reviewKey;
  };
  const cases: Array<[string, string, () => Promise<unknown>]> = [
    ['url', 'lib:gh_code', () => call('PATCH', '/api/mcp-servers/gh_code', { url: 'https://mcp.example.com/github2' })],
    ['header credential', 'lib:gh_code', () => call('PATCH', '/api/mcp-servers/gh_code', { headers: { Authorization: 'Bearer b' } })],
    ['command', 'lib:gl_code', () => call('PATCH', '/api/mcp-servers/gl_code', { command: 'gitlab-mcp-2' })],
    ['args', 'lib:gl_code', () => call('PATCH', '/api/mcp-servers/gl_code', { args: [] })],
    ['env credential', 'lib:gl_code', () => call('PATCH', '/api/mcp-servers/gl_code', { env: { TOKEN: 'b' } })],
    [
      'delete and re-add',
      'lib:gh_code',
      async () => {
        await call('DELETE', '/api/mcp-servers/gh_code');
        await call('POST', '/api/mcp-servers', { name: 'gh_code', transport: 'http', url: 'https://mcp.example.com/github2', headers: { Authorization: 'Bearer b' } });
      },
    ],
    [
      'off and on',
      'lib:gh_code',
      async () => {
        await call('PUT', '/api/connectors/lib:gh_code/enabled', { enabled: false, expected: { enabled: true, botIds: [], running: [] } });
        await call('PUT', '/api/connectors/lib:gh_code/enabled', { enabled: true, expected: { enabled: false, botIds: [], running: [] } });
      },
    ],
  ];
  for (const [what, id, edit] of cases) {
    const before = await keyFor(id);
    assert.equal(await keyFor(id), before, `${what}: the same state gives the same key`);
    await edit();
    const after = await keyFor(id);
    assert.notEqual(after, before, `${what} changes the key`);
    const stale = await call('POST', '/api/bots', { name: `Stale ${what}`, provider: 'claude-cli', access: 'workspace', templateId: 'builtin-repo-monitor', starterConnectors: { 'code-host': id }, reviewKey: before });
    assert.equal(stale.status, 409, `${what}: ${stale.text}`);
  }
  // No secret, nor a plain hash of one, reaches the review.
  const text = (await review('builtin-repo-monitor', { provider: 'claude-cli', access: 'workspace', connectors: { 'code-host': 'lib:gl_code' } })).text;
  const { createHash } = await import('node:crypto');
  for (const secret of ['Bearer b', 'b']) {
    assert.ok(!text.includes(createHash('sha256').update(secret).digest('hex')), 'no plain hash of a secret');
  }
});

test('the server keeps the starter and its slots: the setup check ignores what a request says they were', async () => {
  await call('POST', '/api/mcp-servers', { name: 'cal_one', transport: 'http', url: 'https://cal.example.com/mcp' });
  await call('POST', '/api/mcp-servers', { name: 'cal_two', transport: 'http', url: 'https://cal2.example.com/mcp' });
  const r = (await review('builtin-morning-brief', { provider: 'claude-cli', access: 'workspace', connectors: { calendar: 'lib:cal_one' } })).data;
  const installed = await call<Bot>('POST', '/api/bots', { name: 'Jerry', provider: 'claude-cli', access: 'workspace', templateId: 'builtin-morning-brief', starterConnectors: { calendar: 'lib:cal_one' }, reviewKey: r.reviewKey });
  assert.equal(installed.status, 201, installed.text);
  const made = installed.data;
  const c = (await call<SetupCheck>('POST', `/api/bots/${made.id}/setup-check`, { templateId: 'builtin-web-watcher', connectors: { calendar: 'lib:cal_two' } })).data;
  assert.equal(c.templateId, 'builtin-morning-brief');
  assert.deepEqual(c.slots, { calendar: 'lib:cal_one' });
  const info = (await call<StarterInstall>('GET', `/api/bots/${made.id}/starter`)).data;
  assert.deepEqual([info.templateId, info.slots, info.pending.length], ['builtin-morning-brief', { calendar: 'lib:cal_one' }, 1]);
  const boton = app.auth.mintBotonToken(made.id).token;
  assert.equal((await call('GET', `/api/bots/${made.id}/starter`, undefined, boton)).status, 403);
});

test('a copy of the Boton keeps its routines waiting; a template saved from it and installed again is the owner’s own, paused; a deleted routine leaves the record', async () => {
  const { bot, routine } = await watcher('Mel');
  const copy = await call<Bot>('POST', `/api/bots/${bot.id}/duplicate`, {});
  assert.equal(copy.status, 201, copy.text);
  const [copied] = await routinesOf(copy.data.id);
  assert.equal(copied.enabled, false);
  assert.deepEqual((await call<StarterInstall>('GET', `/api/bots/${copy.data.id}/starter`)).data.pending, [copied.id]);
  const boton = app.auth.mintBotonToken(copy.data.id).token;
  assert.equal((await call('PATCH', `/api/routines/${copied.id}`, { enabled: true }, boton)).status, 409, 'the copy waits too');
  assert.equal((await call('PATCH', `/api/routines/${copied.id}`, { enabled: true })).status, 409);
  // The original's passing test is not the copy's.
  await testRun(routine);
  assert.equal((await activate(copied.id)).status, 409);

  // Saved as a template: a file of the owner's, never a starter (no needs); installed with its routines paused.
  const saved = await call<BotTemplate>('POST', '/api/templates', { fromBotId: bot.id, name: 'My watcher' });
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.data.needs, null);
  const listed = (await call<BotTemplate[]>('GET', '/api/templates')).data.find((t) => t.id === saved.data.id)!;
  assert.equal(listed.needs, null, 'read back from its file, still no needs');
  const again = await call<Bot>('POST', '/api/bots', { name: 'Mel 3', provider: 'mock', templateId: saved.data.id });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual((await routinesOf(again.data.id)).map((x) => x.enabled), [false]);
  assert.equal((await call('GET', `/api/bots/${again.data.id}/starter`)).data, null, "the owner's own template: an ordinary install");

  // Deleting a waiting routine takes it off the record; deleting the Boton, the record.
  assert.equal((await call('DELETE', `/api/routines/${routine.id}`)).status, 200);
  assert.deepEqual((await call<StarterInstall>('GET', `/api/bots/${bot.id}/starter`)).data.pending, []);
  assert.equal((await call('DELETE', `/api/bots/${copy.data.id}`)).status, 200);
  assert.equal(app.store.starterRecord(copy.data.id), null);
});

test('starter activation rolls back its routine and pending gate when the required audit insert fails', async () => {
  const { bot, routine } = await watcher('Kevin');
  const before = app.store.starterRecord(bot.id);
  const db = app.store.db;
  db.exec("create trigger refuse_starter_audit before insert on audit_events when new.action = 'routine.starter_activated' begin select raise(abort, 'audit unavailable'); end");
  let failed;
  try {
    failed = await activate(routine.id, { override: true });
  } finally {
    db.exec('drop trigger refuse_starter_audit');
  }
  assert.equal(failed.status, 500, failed.text);
  assert.equal(app.store.getRoutine(routine.id).enabled, false);
  assert.deepEqual(app.store.starterRecord(bot.id), before);
  const count = () => Number(db.prepare("select count(*) as n from audit_events where action = 'routine.starter_activated' and target_id = ?").get(routine.id)!.n);
  assert.equal(count(), 0);
  assert.equal((await activate(routine.id, { override: true })).status, 200);
  assert.equal(count(), 1);
});

test('enabling a granted skill invalidates a test that ran with the skill disabled', async () => {
  const { bot, routine } = await watcher('Stuart');
  assert.equal((await call('POST', '/api/skills', { name: 'starter-report', description: 'Report rules', body: 'List the sources.' })).status, 201);
  app.skills.setEnabled('starter-report', false);
  await call('PATCH', `/api/bots/${bot.id}`, { skills: ['starter-report'] });
  await testRun(routine);
  assert.equal((await gateOf(bot.id, routine.id)).tested, true);
  app.skills.setEnabled('starter-report', true);
  assert.equal((await gateOf(bot.id, routine.id)).tested, false);
  const rejected = await activate(routine.id);
  assert.equal(rejected.status, 409, rejected.text);
  assert.match(rejected.text, /skills/);
  assert.equal(app.store.getRoutine(routine.id).enabled, false);
  await testRun(routine);
  assert.equal((await activate(routine.id)).status, 200);
});
