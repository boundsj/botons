import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Bot, BotTemplate, Memory, Routine } from '../../shared/types.ts';
import { startServer, until } from './helpers.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';

const s = await startServer({ env: { BOTONS_TZ: 'UTC' } });
const { app, home, call, newBot, newRoutine, messagesOf } = s;
afterEach(() => {
  s.mock.script = null;
});

const LOOK = { shape: 'key', shell: 'violet', glow: 'pink', eyes: 'happy', brows: 'soft', mouth: 'grin', top: 'none', ears: 'pods', visor: 'none', panel: 'dial', arms: 'nubs', backdrop: 'mint', cheeks: true } as const;
const routinesOf = async (id: string) => (await call<Routine[]>('GET', `/api/bots/${id}/routines`)).data;
const memoriesOf = async (id: string) => (await call<Memory[]>('GET', `/api/bots/${id}/memories`)).data;
const duplicate = (id: string, body = {}) => call<Bot>('POST', `/api/bots/${id}/duplicate`, body);
const template = (body: Record<string, unknown>) => call<BotTemplate>('POST', '/api/templates', body);

/** Every field set, two routines (one with a webhook), two memories, a chat and a provider session. */
async function kevin(name = 'Kevin'): Promise<{ bot: Bot; routines: Routine[] }> {
  const bot = await newBot(name, {
    title: 'Inbox triage',
    instructions: 'Sort the inbox.',
    look: LOOK,
    model: 'echo-1',
    effort: 'high',
    access: 'host',
    group: 'Ops',
    pinned: true,
    timezone: 'Europe/Paris',
  });
  const a = await newRoutine(bot.id, { name: 'Morning sort', instruction: 'Sort it', schedule: 'weekdays at 7:30', webhook: true, notify: 'always', webhookWorkspace: false });
  const b = await newRoutine(bot.id, { name: 'Weekly cleanup', instruction: 'Clean up', schedule: 'every 2h', timezone: 'America/New_York', effort: 'low' });
  await call('POST', `/api/bots/${bot.id}/memories`, { text: 'Sam likes short replies' });
  await call('POST', `/api/bots/${bot.id}/memories`, { text: 'VIP: Stuart' });
  await s.send(bot.id, 'hello');
  await until(async () => (await messagesOf(bot.id)).some((m) => m.role === 'bot'));
  assert.ok(app.store.getBot(bot.id).sessionId, 'the source has a session');
  return { bot, routines: [a, b] };
}

test('duplicating copies the profile and brain into a new workspace, with paused routines on new webhook keys, one chip, and no chat, memories or session', async () => {
  const { bot: src, routines: [a, b] } = await kevin();
  const { status, data: copy } = await duplicate(src.id);
  assert.equal(status, 201);
  assert.notEqual(copy.id, src.id);
  assert.equal(copy.name, 'Kevin 2');
  for (const k of ['title', 'instructions', 'look', 'provider', 'model', 'effort', 'access', 'group', 'timezone', 'connections', 'skills'] as const) assert.deepEqual(copy[k], src[k], k);
  assert.deepEqual([copy.pinned, copy.paused], [false, false]);
  assert.notEqual(copy.workspace, src.workspace);
  assert.ok(existsSync(copy.workspace), 'a fresh workspace folder');
  assert.equal(app.store.getBot(copy.id).sessionId, null, 'no provider session');

  const chat = await messagesOf(copy.id);
  assert.deepEqual(
    chat.map((m) => [m.role, m.text, m.meta?.kind, m.meta?.sourceBotId, m.meta?.sourceName, m.meta?.copiedRoutines, m.meta?.copiedMemories]),
    [['event', 'Duplicated from Kevin', 'bot.duplicated', src.id, 'Kevin', 2, 0]],
  );
  assert.deepEqual(await memoriesOf(copy.id), [], 'memories only with withMemories');

  const copies = await routinesOf(copy.id);
  assert.deepEqual(
    copies.map((r) => [r.name, r.instruction, r.schedule, r.timezone, r.notify, r.webhookWorkspace, r.enabled, r.nextRunAt, r.lastStatus, r.lastRunAt, r.effort]),
    [
      [a.name, a.instruction, a.schedule, a.timezone, 'always', false, false, null, null, null, null],
      [b.name, b.instruction, b.schedule, 'America/New_York', 'auto', true, false, null, null, null, 'low'],
    ],
  );
  const [ca, cb] = copies;
  assert.ok(ca.webhook && cb.webhook === null);
  assert.notEqual(ca.id, a.id);
  assert.notEqual(ca.webhook!.key, a.webhook!.key);
  assert.notEqual(ca.webhook!.url, a.webhook!.url);
  assert.match(ca.webhook!.url, new RegExp(`/hooks/routines/${ca.id}$`));
  assert.equal((await s.hook(ca, '', { headers: { authorization: `Bearer ${a.webhook!.key}` } })).status, 401);
  assert.equal((await s.hook(ca)).status, 409);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${ca.id}`, { enabled: true })).data.nextRunAt !== null, true);
  assert.equal((await s.hook(ca)).status, 202);
  assert.equal((await routinesOf(src.id)).every((r) => r.enabled), true);
  assert.equal((await memoriesOf(src.id)).length, 2);
  assert.equal((await call<Bot>('GET', `/api/bots/${src.id}`)).data.pinned, true);
});

test("a duplicate keeps connectors, skills and routines' model, session setting, webhook sender and filter, but not their session, signing secret or callback", async () => {
  assert.equal((await call('POST', '/api/mcp-servers', { name: 'notes', transport: 'stdio', command: 'notes-mcp' })).status, 201);
  assert.equal((await call('POST', '/api/skills', { name: 'triage', description: 'Sort the inbox', body: 'Sort it.' })).status, 201);
  const src = await newBot('Connie', { connections: ['lib:notes'], skills: ['triage'] });
  const solo = await newRoutine(src.id, { name: 'Check', instruction: 'Check it', model: 'echo-2', session: 'own' });
  const filter = { kind: 'header', name: 'X-GitHub-Event', values: ['push'] };
  const gh = await newRoutine(src.id, {
    name: 'Pushes',
    instruction: 'Look',
    webhook: true,
    webhookSource: 'github',
    webhookSecret: 'gh-signing-secret',
    webhookFilter: filter,
  });
  assert.equal((await call('PATCH', `/api/routines/${gh.id}`, { callbackUrl: 'https://1.1.1.1/hooks/catch/1/SECRET/' })).status, 200);
  assert.equal((await call('POST', `/api/routines/${solo.id}/run`)).status, 202);
  await until(() => app.store.routineSession(solo.id).sessionId);

  const { status, data: copy } = await duplicate(src.id);
  assert.equal(status, 201);
  assert.deepEqual([copy.connections, copy.skills], [['lib:notes'], ['triage']]);
  const [check, pushes] = await routinesOf(copy.id);
  assert.deepEqual([check.model, check.session], ['echo-2', 'own']);
  assert.deepEqual(app.store.routineSession(check.id), { sessionId: null, sessionKey: null });
  assert.ok(app.store.routineSession(solo.id).sessionId, "the source's session is kept");
  assert.deepEqual([pushes.webhook!.source, pushes.webhook!.filter, pushes.webhook!.hasSecret, pushes.webhook!.callbackUrl], ['github', filter, false, null]);
  assert.equal(app.store.webhookSecrets(pushes.id)!.secret, null);
  const orig = (await routinesOf(src.id))[1];
  assert.deepEqual([orig.webhook!.hasSecret, orig.webhook!.callbackUrl], [true, 'https://1.1.1.1/hooks/catch/1/SECRET/']);
});

test('withMemories copies the memories (still one chip); withRoutines false leaves the routines; names count up', async () => {
  const { bot: src } = await kevin('Stuart');
  const withMem = (await duplicate(src.id, { withMemories: true })).data;
  assert.equal(withMem.name, 'Stuart 2');
  assert.deepEqual((await memoriesOf(withMem.id)).map((m) => m.text), ['Sam likes short replies', 'VIP: Stuart']);
  assert.equal((await routinesOf(withMem.id)).length, 2);
  const chat = await messagesOf(withMem.id);
  assert.equal(chat.length, 1, 'one chip, not one per routine and memory');
  assert.deepEqual([chat[0].meta?.copiedRoutines, chat[0].meta?.copiedMemories], [2, 2]);

  const bare = (await duplicate(withMem.id, { withRoutines: false })).data;
  assert.equal(bare.name, 'Stuart 3', 'a copy of "Stuart 2" is "Stuart 3"');
  assert.deepEqual(await routinesOf(bare.id), []);
  assert.equal((await duplicate(src.id, { name: '  Stuart the Second ' })).data.name, 'Stuart the Second');
  assert.equal((await duplicate(src.id, { name: '' })).data.name, 'Stuart 4');
});

test('duplicate checks its input, and is for devices only', async () => {
  const src = await newBot('Guarded');
  assert.equal((await duplicate('bot_nothere')).status, 404);
  for (const bad of [{ withRoutines: 'yes' }, { withMemories: 1 }, { name: 'x'.repeat(61) }]) assert.equal((await duplicate(src.id, bad)).status, 400, JSON.stringify(bad));
  // A Boton can't copy itself: it would get a second, unpaused self.
  let status = 0;
  s.mock.script = async (t) => {
    if (t.env.BOTON_BOT_ID !== src.id) return null;
    status = (await call('POST', `/api/bots/${src.id}/duplicate`, {}, t.env.BOTON_TOKEN)).status;
    const tpl = (await call('POST', '/api/templates', { fromBotId: src.id }, t.env.BOTON_TOKEN)).status;
    const list = (await call('GET', '/api/templates', undefined, t.env.BOTON_TOKEN)).status;
    return `${tpl} ${list}`;
  };
  await s.send(src.id, 'copy yourself');
  const reply = await until(async () => (await messagesOf(src.id)).find((m) => m.role === 'bot'));
  assert.equal(status, 403);
  assert.equal(reply.text, '403 403');
});

test('save as template: fields and routines as a private JSON file, without memories, webhook keys or one-offs', async () => {
  const { bot: src, routines } = await kevin('Bob');
  await newRoutine(src.id, { name: 'Once', instruction: 'Just once', schedule: 'in 2h' });
  const { status, data: tpl } = await template({ fromBotId: src.id, name: 'Inbox sorter' });
  assert.equal(status, 201);
  assert.match(tpl.id, /^tpl_[a-z0-9]{8}$/);
  assert.equal(tpl.builtin, false);
  assert.equal(tpl.name, 'Inbox sorter');
  assert.equal(tpl.description, 'Inbox triage, saved from Bob.');
  assert.deepEqual(tpl.bot, {
    name: 'Bob',
    title: 'Inbox triage',
    instructions: 'Sort the inbox.',
    look: LOOK,
    provider: 'mock',
    model: 'echo-1',
    effort: 'high',
    access: 'host',
    group: 'Ops',
    timezone: 'Europe/Paris',
    connections: [],
    skills: null,
  });
  assert.deepEqual(
    tpl.routines.map((r) => [r.name, r.schedule, r.scheduleText, r.timezone, r.webhook, r.notify, r.webhookWorkspace, r.effort]),
    [
      ['Morning sort', routines[0].schedule, 'Weekdays at 7:30 AM', null, true, 'always', false, null],
      ['Weekly cleanup', 'every 120m', 'Every 2 hours', 'America/New_York', false, 'auto', true, 'low'],
    ],
  );
  const file = join(home, 'templates', `${tpl.id}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'templates')).mode & 0o777, 0o700);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(routines[0].webhook!.key), 'no webhook key');
  assert.ok(!raw.includes('Sam likes short replies'), 'no memories');
  assert.ok(!raw.includes('hello'), 'no chat');
  assert.ok((await call<BotTemplate[]>('GET', '/api/templates')).data.some((t) => t.id === tpl.id));
  assert.equal((await template({ fromBotId: 'bot_nothere' })).status, 404);
  assert.equal((await template({})).status, 400);
});

test('creating a Boton from a template also creates its routines (paused unless startRoutines), with new webhook keys and one chip', async () => {
  const { bot: src, routines } = await kevin('Dave');
  const { data: tpl } = await template({ fromBotId: src.id });
  const bot = await newBot('Dave Jr', { ...tpl.bot, name: 'Dave Jr', templateId: tpl.id });
  assert.deepEqual([bot.name, bot.title, bot.access, bot.timezone, bot.effort], ['Dave Jr', 'Inbox triage', 'host', 'Europe/Paris', 'high']);
  const made = await routinesOf(bot.id);
  assert.deepEqual(
    made.map((r) => [r.name, r.schedule, r.timezone, r.enabled, r.notify, r.webhookWorkspace, !!r.webhook, r.effort]),
    [
      ['Morning sort', routines[0].schedule, 'Europe/Paris', false, 'always', false, true, null],
      ['Weekly cleanup', 'every 120m', 'America/New_York', false, 'auto', true, false, 'low'],
    ],
  );
  assert.notEqual(made[0].webhook!.key, routines[0].webhook!.key);
  const chat = await messagesOf(bot.id);
  assert.deepEqual(
    chat.map((m) => [m.text, m.meta?.kind, m.meta?.templateId, m.meta?.copiedRoutines]),
    [[`Started from template “Dave”; 2 routines, paused`, 'bot.from_template', tpl.id, 2]],
  );

  // The owner's own saved template may start its routines at once (a starter's always start paused: starters.test.ts).
  const started = await newBot('Briefy', { templateId: tpl.id, startRoutines: true });
  const [sort] = await routinesOf(started.id);
  assert.deepEqual([sort.name, sort.enabled, sort.timezone], ['Morning sort', true, 'UTC']);
  assert.ok(sort.nextRunAt);
  assert.match((await messagesOf(started.id))[0].text, /^Started from template “Dave”; 2 routines$/);

  const before = (await call<Bot[]>('GET', '/api/bots')).data.length;
  for (const bad of [{ templateId: 'tpl_nothere0' }, { templateId: 'builtin-morning-brief', startRoutines: 'yes' }, { templateId: 42 }]) {
    assert.equal((await call('POST', '/api/bots', { name: 'X', provider: 'mock', ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call<Bot[]>('GET', '/api/bots')).data.length, before);
});

test("a template keeps the routines' webhook sender and filter, skill, model and session, and the Boton's connectors and skills (not secrets or callbacks)", async () => {
  assert.equal((await call('POST', '/api/mcp-servers', { name: 'tickets', transport: 'stdio', command: 'tickets-mcp' })).status, 201);
  assert.equal((await call('POST', '/api/skills', { name: 'triage-issue', description: 'Triage an issue', body: 'Label it.' })).status, 201);
  assert.equal((await call('POST', '/api/skills', { name: 'standup', description: 'Write the standup', body: 'Write it.' })).status, 201);
  const src = await newBot('Hooky', { connections: ['lib:tickets'], skills: ['triage-issue', 'standup'] });
  const filter = { kind: 'header', name: 'X-GitHub-Event', values: ['issues'] };
  const gh = await newRoutine(src.id, {
    name: 'Issues',
    instruction: 'Triage the issue',
    webhook: true,
    webhookSource: 'github',
    webhookSecret: 'gh-signing-secret',
    webhookFilter: filter,
    skill: 'triage-issue',
    model: 'echo-2',
    session: 'own',
  });
  assert.equal(gh.webhook!.hasSecret, true);
  const { status, data: tpl } = await template({ fromBotId: src.id });
  assert.equal(status, 201);
  assert.deepEqual([tpl.bot.connections, tpl.bot.skills], [['lib:tickets'], ['triage-issue', 'standup']]);
  const [saved] = tpl.routines;
  assert.deepEqual([saved.webhookSource, saved.webhookFilter, saved.skill, saved.model, saved.session], ['github', filter, 'triage-issue', 'echo-2', 'own']);
  const raw = readFileSync(join(home, 'templates', `${tpl.id}.json`), 'utf8');
  assert.ok(!raw.includes('gh-signing-secret'), 'no signing secret');
  assert.ok(!raw.includes(gh.webhook!.key), 'no webhook key');

  // No connections or skills given: the template's apply (no browser on the mock brain, which can't run one).
  const made = await newBot('Hooky Jr', { templateId: tpl.id });
  assert.deepEqual([made.connections, made.skills], [['lib:tickets'], ['triage-issue', 'standup']]);
  const [copy] = await routinesOf(made.id);
  assert.deepEqual(
    [copy.webhook!.source, copy.webhook!.filter, copy.webhook!.hasSecret, copy.webhook!.callbackUrl, copy.skill, copy.model, copy.session],
    ['github', filter, false, null, 'triage-issue', 'echo-2', 'own'],
  );
  assert.notEqual(copy.webhook!.key, gh.webhook!.key);

  // A Boton on another provider that may not use the skill: the routine loses both.
  const other = await newBot('Hooky Codex', { provider: 'codex-cli', skills: ['standup'], templateId: tpl.id });
  assert.deepEqual([other.connections, other.skills], [[BROWSER_CONNECTOR, 'lib:tickets'], ['standup']]);
  const [narrow] = await routinesOf(other.id);
  assert.deepEqual([narrow.webhook!.source, narrow.skill, narrow.model, narrow.session], ['github', null, null, 'own']);

  assert.equal((await call('DELETE', '/api/mcp-servers/tickets')).status, 200);
  assert.deepEqual((await newBot('Hooky 3', { templateId: tpl.id })).connections, []);

  // A file without these fields reads with their defaults.
  writeFileSync(
    join(home, 'templates', 'tpl_defaults.json'),
    JSON.stringify({ name: 'Minimal', bot: { name: 'Minimal', title: '', instructions: '', provider: 'mock', model: '', access: 'workspace', group: '' }, routines: [{ name: 'Hook', instruction: 'Do it', webhook: true }] }),
  );
  const minimal = (await call<BotTemplate[]>('GET', '/api/templates')).data.find((t) => t.id === 'tpl_defaults')!;
  assert.deepEqual([minimal.bot.connections, minimal.bot.skills], [[], null]);
  assert.deepEqual(
    [minimal.routines[0].webhookSource, minimal.routines[0].webhookFilter, minimal.routines[0].skill, minimal.routines[0].model, minimal.routines[0].session],
    ['generic', null, null, null, 'chat'],
  );
  rmSync(join(home, 'templates', 'tpl_defaults.json'));
});

test('a Boton from a template, or a duplicate, that fails part-way leaves no Boton, routine, workspace folder or event; a retry works', async () => {
  const { bot: src } = await kevin('Gus');
  const { data: tpl } = await template({ fromBotId: src.id });
  const bots = app.store.listBots().length;
  const folders = readdirSync(join(home, 'workspaces')).length;
  const events: string[] = [];
  const unsubscribe = app.hub.subscribe((e) => events.push(e.type));
  // As if the disk filled up after the new Boton and its first routine were inserted.
  app.store.db.exec(
    "create temp trigger full before insert on routines when (select count(*) from routines where bot_id = new.bot_id) = 1 begin select raise(abort, 'database or disk is full'); end",
  );
  try {
    assert.equal((await call('POST', '/api/bots', { name: 'Gus Jr', provider: 'mock', templateId: tpl.id })).status, 500);
    assert.equal((await duplicate(src.id)).status, 500);
  } finally {
    app.store.db.exec('drop trigger temp.full');
    unsubscribe();
  }
  assert.equal(app.store.listBots().length, bots);
  assert.equal(app.store.db.prepare('select count(*) as n from routines where bot_id not in (select id from bots)').get()!.n, 0);
  assert.equal(readdirSync(join(home, 'workspaces')).length, folders);
  assert.deepEqual(events, []);

  assert.equal((await routinesOf((await newBot('Gus Jr', { templateId: tpl.id })).id)).length, 2);
  assert.equal((await duplicate(src.id)).status, 201);
});

test('the built-in starters are listed first; saved templates can be deleted, built-ins cannot, and a broken file is skipped', async () => {
  const { data: tpl } = await template({ fromBotId: (await newBot('Temp')).id });
  writeFileSync(join(home, 'templates', 'tpl_broken01.json'), '{ not json');
  writeFileSync(join(home, 'templates', 'tpl_broken02.json'), JSON.stringify({ name: 'No bot' }));
  const { status, data: list } = await call<BotTemplate[]>('GET', '/api/templates');
  assert.equal(status, 200);
  assert.deepEqual(
    list.slice(0, 8).map((t) => [t.id, t.builtin]),
    [
      ['builtin-morning-brief', true],
      ['builtin-repo-monitor', true],
      ['builtin-webhook-research', true],
      ['builtin-inbox-triage', true],
      ['builtin-file-report', true],
      ['builtin-web-watcher', true],
      ['builtin-researcher', true],
      ['builtin-chief-of-staff', true],
    ],
  );
  const brief = list[0];
  assert.deepEqual([brief.bot.title, brief.bot.name], ['Daily brief', '']);
  assert.deepEqual(
    brief.routines.map((r) => [r.name, r.scheduleText, r.webhook, r.timezone]),
    [['Morning brief', 'Weekdays at 8:00 AM', false, null]],
  );
  const ids = list.map((t) => t.id);
  assert.ok(ids.includes(tpl.id));
  assert.ok(!ids.includes('tpl_broken01') && !ids.includes('tpl_broken02'));
  assert.equal((await call('DELETE', `/api/templates/${tpl.id}`)).status, 200);
  assert.ok(!existsSync(join(home, 'templates', `${tpl.id}.json`)));
  assert.equal((await call('DELETE', `/api/templates/${tpl.id}`)).status, 404);
  assert.equal((await call('DELETE', '/api/templates/builtin-researcher')).status, 400);
  assert.equal((await call('DELETE', '/api/templates/..%2Fbotons.db')).status, 404);
  assert.ok(existsSync(join(home, 'botons.db')));
});
