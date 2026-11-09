import assert from 'node:assert/strict';
// The fixtures were exported under the earlier names; legacy-names.test.ts imports them as they are.
import { currentPortable } from '../../shared/legacy-names.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  AuditEvent,
  Bot,
  ConnectorCatalog,
  PortableConfig,
  PortableExport,
  PortableImportPreview,
  PortableImportResult,
  Routine,
  Skill,
} from '../../shared/types.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import { cleanArgs, credentialShaped, LEFT_OUT, PORTABLE_VERSION, readPortable } from '../src/portable.ts';
import { startServer, type TestServer } from './helpers.ts';

// Every value here is a secret the file must never hold, wherever it is in the database.
const SECRETS = {
  env: 'envsecret-Ab12Cd34Ef56Gh78',
  header: 'headersecret-Zz99Yy88Xx77Ww66',
  query: 'querysecret-Qq11Rr22Ss33Tt44',
  arg: 'sk-argsecretAb12Cd34Ef56',
  ntfy: 'tk_ntfysecretAb12Cd34Ef56',
  hookSecret: 'hooksecret-Mm55Nn66Oo77Pp88',
  callback: 'https://callback.example.com/receive/capability-Uu11Vv22Ww33',
};

const ok = async <T>(s: TestServer, method: string, path: string, body?: unknown): Promise<T> => {
  const r = await s.call<T>(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`);
  return r.data;
};
const exportOf = (s: TestServer) => ok<PortableExport>(s, 'GET', '/api/config/export');
const preview = (s: TestServer, file: unknown, choices?: unknown) => s.call<PortableImportPreview>('POST', '/api/config/import/preview', { file, ...(choices ? { choices } : {}) });
/** Everything a server has that the file is about, by name: to compare two servers. */
function shapeOf(s: TestServer) {
  const st = s.app.store;
  return {
    bots: st.listBots().length,
    routines: st.listBots().flatMap((b) => st.listRoutines(b.id)).length,
    skills: s.app.skills.list().map((x) => x.name),
    servers: s.app.connectors.listServers().map((x) => x.name),
    oauth: s.app.oauth.list().map((x) => x.name),
    groups: st.sidebarLayout().groups.map((g) => g.name),
    settings: st.getSettings(),
    workspaces: existsSync(s.cfg.workspacesDir) ? readdirSync(s.cfg.workspacesDir).sort() : [],
  };
}

/** A server with one of everything the file holds, and secrets in every place one can be. */
async function populated(): Promise<TestServer & { ids: Record<string, string> }> {
  const s = await startServer({ env: { BOTONS_TZ: 'UTC' } });
  await ok(s, 'PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'Europe/Paris', ntfy: { server: 'https://ntfy.example.com', topic: 'botons-sam', token: SECRETS.ntfy, enabled: true, preview: true } });
  await ok(s, 'POST', '/api/mcp-servers', { name: 'notes', transport: 'stdio', command: 'notes-mcp', args: ['--api-key', SECRETS.arg, '--verbose'], env: { NOTES_TOKEN: SECRETS.env } });
  await ok(s, 'POST', '/api/mcp-servers', { name: 'tracker', transport: 'http', url: `https://mcp.example.com/mcp?key=${SECRETS.query}`, headers: { Authorization: `Bearer ${SECRETS.header}` } });
  await ok(s, 'POST', '/api/oauth-connections', { name: 'fleet', url: 'https://fleet.example.com/mcp' });
  await ok(s, 'PATCH', '/api/connectors/lib:tracker/policy', { onRequest: true, grant: 'immediate' });
  s.app.connectors.setEnabled('lib:notes', false, 'testing');

  const work = (await ok<{ groupId: string }>(s, 'POST', '/api/sidebar/groups', { name: 'Work' })).groupId;
  await ok(s, 'POST', '/api/sidebar/groups', { name: 'Home' });
  const kevin = await s.newBot('Kevin', { groupId: work, pinned: true, access: 'host', title: 'Chief of staff', instructions: 'Brief me daily. Old note: ghp_abcdefghijklmnop1234' });
  const stuart = await s.newBot('Stuart', { group: 'Home', connections: ['lib:tracker', 'oauth:fleet', 'lib:notes', BROWSER_CONNECTOR] });
  const bob = await s.newBot('Bob');
  await ok(s, 'PATCH', `/api/bots/${kevin.id}`, { askFirst: ['Bash(git push:*)'], alwaysAllow: ['Bash(git push:*)'] });
  await ok(s, 'PUT', `/api/bots/${stuart.id}/browser`, { sites: ['docs.example.com', 'news.example.com'] });
  await ok(s, 'POST', `/api/bots/${bob.id}/pause`);
  await ok(s, 'PATCH', '/api/settings', { primaryBotId: kevin.id });

  await ok(s, 'POST', '/api/skills', { name: 'weekly-report', description: 'Write the weekly report', body: 'First text' });
  await ok(s, 'PATCH', '/api/skills/weekly-report', { body: 'Second text' });
  await ok(s, 'POST', '/api/skills', { name: 'old-habit', description: 'Something retired', body: 'Do the old thing' });
  await ok(s, 'PUT', '/api/skills/old-habit/enabled', { enabled: false });
  s.app.store.atomically(() =>
    s.app.skills.importSkill(
      {
        name: 'from-package',
        description: 'Installed from a package',
        body: 'Follow the package',
        disabled: false,
        author: { kind: 'owner' },
        source: { kind: 'folder', folder: 'from-package', label: '1.2', installed: 'a'.repeat(32), installedAt: '2026-01-01T00:00:00.000Z', fields: { 'allowed-tools': 'Bash' }, files: ['scripts/run.sh'], reviewed: 'b'.repeat(32) },
        history: [],
      },
      false,
    ),
  );
  s.app.skills.createByBoton(stuart.id, { name: 'stuart-notes', description: 'How Stuart keeps notes', body: 'Keep notes' });

  await s.newRoutine(kevin.id, { name: 'Morning brief', schedule: 'weekdays at 8:00', instruction: 'Brief me', skill: 'weekly-report' });
  const hook = s.app.store.createRoutine(stuart.id, { name: 'On push', instruction: 'Review the push', webhook: true, webhookSource: 'github', webhookSecret: SECRETS.hookSecret, callbackUrl: SECRETS.callback });
  await s.newRoutine(kevin.id, { name: 'Full access hook', instruction: 'Deploy', webhook: true, webhookWorkspace: false });
  await s.newRoutine(stuart.id, { name: 'Own notes', instruction: 'Tidy', skill: 'stuart-notes', schedule: 'daily at 7:00' });
  await ok(s, 'POST', `/api/bots/${kevin.id}/memories`, { text: 'A private memory' }).catch(() => {});
  await s.send(kevin.id, 'a private chat message');
  return Object.assign(s, { ids: { kevin: kevin.id, stuart: stuart.id, bob: bob.id, hookKey: hook.webhook!.key } });
}

test('the export holds every non-secret setting and none of the secrets, tokens, chats or ids', async () => {
  const s = await populated();
  const out = await exportOf(s);
  const text = JSON.stringify(out);
  for (const [what, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `the export holds the ${what} secret`);
  assert.ok(!text.includes(s.ids.hookKey), 'the export holds a webhook key');
  assert.ok(!text.includes(s.token), 'the export holds a device token');
  for (const id of Object.values(s.ids)) assert.ok(!text.includes(id), `the export holds the id ${id}`);
  assert.ok(!text.includes('a private chat message') && !text.includes('A private memory'));

  const f = out.file;
  assert.equal(f.format, 'botons-config');
  assert.equal(f.version, PORTABLE_VERSION);
  assert.deepEqual(
    f.botons.map((m) => m.name),
    ['Kevin', 'Stuart', 'Bob'],
    'in the sidebar order',
  );
  const kevin = f.botons[0];
  assert.deepEqual([kevin.access, kevin.alwaysAllow, kevin.askFirst, kevin.title], ['host', ['bash(git push:*)'], ['Bash(git push:*)'], 'Chief of staff']);
  const stuart = f.botons[1];
  assert.deepEqual(stuart.browserSites, ['docs.example.com', 'news.example.com']);
  assert.ok(stuart.connections.includes(BROWSER_CONNECTOR));
  assert.equal(f.botons[2].paused, true);
  const hook = stuart.routines.find((r) => r.name === 'On push')!;
  assert.deepEqual([hook.webhook, hook.webhookSource, hook.webhookSecretLeftOut, hook.callbackLeftOut], [true, 'github', true, true]);
  assert.deepEqual(f.settings, { ownerName: 'Sam', timezone: 'Europe/Paris', primaryBoton: kevin.ref, ntfy: { enabled: true, server: 'https://ntfy.example.com', topic: 'botons-sam', preview: true, tokenLeftOut: true }, reactionFollowUps: ['👎'] });

  const notes = f.connectors.find((c) => c.id === 'lib:notes')!;
  assert.ok(notes.kind === 'library');
  assert.deepEqual([notes.args, notes.envKeys, notes.enabled], [['--api-key', LEFT_OUT, '--verbose'], ['NOTES_TOKEN'], false]);
  const tracker = f.connectors.find((c) => c.id === 'lib:tracker')!;
  assert.ok(tracker.kind === 'library');
  assert.deepEqual([tracker.url, tracker.headerKeys, tracker.onRequest, tracker.grant], ['https://mcp.example.com/mcp', ['Authorization'], true, 'immediate']);
  assert.ok(tracker.leftOut.includes("its URL's query (key)"), tracker.leftOut.join());
  assert.ok(f.connectors.some((c) => c.id === 'oauth:fleet' && c.kind === 'oauth'));
  assert.ok(!f.connectors.some((c) => c.id === BROWSER_CONNECTOR), "the managed browser is the server's own, never a library entry");

  const weekly = f.skills.find((x) => x.name === 'weekly-report')!;
  assert.deepEqual([weekly.body, weekly.history.map((h) => h.body)], ['Second text', ['First text']]);
  assert.equal(f.skills.find((x) => x.name === 'old-habit')!.disabled, true);
  assert.deepEqual(f.skills.find((x) => x.name === 'stuart-notes')!.author, { kind: 'boton', ref: stuart.ref, name: 'Stuart' });
  assert.equal(f.skills.find((x) => x.name === 'from-package')!.source?.folder, 'from-package');
  assert.deepEqual(
    f.sidebar.groups.map((g) => [g.name, g.botIds]),
    [
      ['Work', [kevin.ref]],
      ['Home', [stuart.ref]],
    ],
  );

  assert.ok(out.textWarnings.some((w) => w.startsWith('Boton Kevin: instructions')), 'a credential-shaped run in text is named');
  assert.ok(out.leftOut.some((x) => x.includes('lib:notes') && x.includes('NOTES_TOKEN')));
  const audit = (await ok<AuditEvent[]>(s, 'GET', '/api/audit')).find((e) => e.action === 'config.exported');
  assert.equal(audit?.details.botons, 3);
  await s.stop();
});

test('a fresh server takes the file whole: preview first, nothing widened unasked, then exactly what was shown', async () => {
  const src = await populated();
  const { file } = await exportOf(src);
  const dst = await startServer({ env: { BOTONS_TZ: 'UTC' } });
  const before = shapeOf(dst);

  const p = await preview(dst, file);
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(shapeOf(dst), before, 'a preview changes nothing');
  const kevin = p.data.botons.find((m) => m.name === 'Kevin')!;
  assert.deepEqual([kevin.action, kevin.access, kevin.alwaysAllow.imported], ['create', { file: 'host', imported: 'workspace' }, []], 'Full access and Always allow only when ticked');
  assert.ok(kevin.routines.every((r) => r.wasEnabled), 'they were on');
  assert.deepEqual(kevin.routines.find((r) => r.name === 'Full access hook')!.fullAccessWebhook, { file: true, imported: false });
  assert.equal(p.data.settings.apply, true);
  assert.equal(p.data.sidebar.mode, 'replace');
  const kinds = p.data.reconnect.map((r) => `${r.kind}:${r.target}`);
  for (const k of ['connector-secret:lib:notes', 'connector-secret:lib:tracker', 'connector-sign-in:oauth:fleet', 'connector-off:lib:tracker', 'ntfy-token:ntfy', `routine-off:${kevin.ref}`, `webhook:${p.data.botons[1].ref}`]) {
    assert.ok(kinds.includes(k), `${k} in ${kinds.join(', ')}`);
  }
  assert.ok(p.data.connectors.find((c) => c.id === 'lib:notes')!.runsCommand);
  assert.ok(!JSON.stringify(p.data).includes(SECRETS.arg));

  // A stale preview is refused and changes nothing.
  const stale = await dst.call('POST', '/api/config/import', { file, fingerprint: 'nope' });
  assert.equal(stale.status, 409, stale.text);

  // The owner ticks Full access and Always allow for Kevin.
  const choices = { ...p.data.choices, botons: { ...p.data.choices.botons, [kevin.ref]: { action: 'create', fullAccess: true, alwaysAllow: true } } };
  const p2 = (await preview(dst, file, choices)).data;
  assert.deepEqual(p2.botons.find((m) => m.ref === kevin.ref)!.access.imported, 'host');
  const done = await dst.call<PortableImportResult>('POST', '/api/config/import', { file, choices: p2.choices, fingerprint: p2.fingerprint });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.data.botons.map((m) => m.name), ['Kevin', 'Stuart', 'Bob']);

  const st = dst.app.store;
  const byName = (n: string) => st.getBot(done.data.botons.find((m) => m.name === n)!.botId);
  const k = byName('Kevin');
  const stuart = byName('Stuart');
  assert.deepEqual([k.access, k.alwaysAllow, k.askFirst, k.pinned, k.group, k.sessionId], ['host', ['bash(git push:*)'], ['Bash(git push:*)'], true, 'Work', null]);
  assert.equal(byName('Bob').paused, true);
  assert.deepEqual(stuart.connections.sort(), ['lib:notes', 'lib:tracker', BROWSER_CONNECTOR, 'oauth:fleet'].sort());
  assert.deepEqual(dst.app.browser.policy(stuart.id).sites, ['docs.example.com', 'news.example.com']);
  assert.deepEqual(st.listMemories(k.id), []);

  // Routines: all off, webhooks with keys of their own, no secret or callback; Full access only where ticked.
  const routines = [k, stuart].flatMap((b) => st.listRoutines(b.id));
  assert.equal(routines.length, 4);
  assert.ok(routines.every((r) => !r.enabled && r.nextRunAt === null));
  const hook = routines.find((r) => r.name === 'On push')!;
  assert.ok(hook.webhook && hook.webhook.key !== src.ids.hookKey && !hook.webhook.hasSecret && hook.webhook.callbackUrl === null);
  assert.equal(routines.find((r) => r.name === 'Full access hook')!.webhookWorkspace, false);
  assert.equal(routines.find((r) => r.name === 'Morning brief')!.skill, 'weekly-report');
  assert.equal(routines.find((r) => r.name === 'Own notes')!.skill, 'stuart-notes', "Stuart's own pending skill is still his");

  // Skills, with their history, author, state and source; a skill grants nothing.
  const skills = new Map(dst.app.skills.list().map((x) => [x.name, x]));
  assert.deepEqual(dst.app.skills.history('weekly-report').map((h) => h.body), ['First text']);
  assert.equal(skills.get('old-habit')!.disabled, true);
  const notes = skills.get('stuart-notes') as Skill;
  assert.deepEqual([notes.pending, notes.updatedBy], [true, { kind: 'boton', botId: stuart.id, name: 'Stuart' }]);
  assert.deepEqual(skills.get('from-package')!.source?.fields, { 'allowed-tools': 'Bash' });

  // Connectors: made off, at a fresh request-policy generation, without a secret; OAuth signed out.
  const catalog = (await ok<ConnectorCatalog>(dst, 'GET', '/api/connectors')).connectors;
  for (const id of ['lib:notes', 'lib:tracker', 'oauth:fleet']) assert.equal(catalog.find((c) => c.id === id)!.enabled, false, id);
  assert.deepEqual([catalog.find((c) => c.id === 'lib:tracker')!.onRequest, catalog.find((c) => c.id === 'lib:tracker')!.grant], [true, 'immediate']);
  assert.ok(dst.app.connectors.policyOf('lib:tracker').generation < 0);
  const rows = dst.app.store.db.prepare('select env, headers, url from mcp_servers order by name').all() as { env: string; headers: string; url: string }[];
  assert.deepEqual(rows.map((r) => [r.env, r.headers]), [
    ['{}', '{}'],
    ['{}', '{}'],
  ]);
  assert.equal(dst.app.oauth.list()[0].status, 'new');
  assert.equal(dst.app.oauth.records()[0].accessToken, null);

  // Settings: the push token is never there, so pushes wait for it.
  const settings = st.getSettings();
  assert.deepEqual([settings.ownerName, settings.timezone, settings.primaryBotId, settings.ntfy.enabled, settings.ntfy.hasToken, settings.ntfy.topic], ['Sam', 'Europe/Paris', k.id, false, false, 'botons-sam']);
  assert.deepEqual(st.sidebarLayout().groups.map((g) => [g.name, g.botIds]), [
    ['Work', [k.id]],
    ['Home', [stuart.id]],
  ]);

  // The whole database holds none of the secrets.
  const dump = (dst.app.store.db.prepare("select group_concat(value, ' ') as v from settings").get() as { v: string }).v + JSON.stringify(dst.app.store.db.prepare('select * from routines').all());
  for (const v of Object.values(SECRETS)) assert.ok(!dump.includes(v));

  // The audit: the import, and each Boton made with what it was given.
  const audit = await ok<AuditEvent[]>(dst, 'GET', '/api/audit');
  assert.ok(audit.some((e) => e.action === 'config.imported' && e.details.botons === 3));
  assert.equal(audit.filter((e) => e.action === 'boton.created' && e.details.via === 'config import').length, 3);

  // Exported again, it is the same configuration, less what an import never brings over by itself.
  const again = (await exportOf(dst)).file;
  const comparable = (f: PortableConfig) => ({
    settings: { ...f.settings, ntfy: { ...f.settings.ntfy, enabled: false, tokenLeftOut: false } },
    botons: f.botons.map((m) => ({ ...m, routines: m.routines.map((r) => ({ ...r, enabled: false, webhookSecretLeftOut: false, callbackLeftOut: false })) })),
    skills: f.skills.map((x) => ({ ...x, history: x.history.map((h) => ({ ...h, replacedAt: '' })) })),
    connectors: f.connectors.map((c) => ({ ...c, enabled: false, leftOut: [] as string[], ...(c.kind === 'library' ? { envKeys: [], headerKeys: [] } : {}) })),
    sidebar: f.sidebar,
  });
  const want = comparable(file);
  // What the file left out stays out: Notes' redacted argument, Tracker's query.
  assert.deepEqual(comparable(again), want);

  // The same file again changes nothing by default: same-named Botons are left out, the rest kept.
  const p3 = (await preview(dst, file)).data;
  assert.ok(p3.botons.every((m) => m.action === 'skip' && m.conflict));
  assert.ok(p3.skills.every((x) => x.action === 'keep') && p3.connectors.every((c) => c.action === 'keep'));
  assert.equal(p3.settings.apply, false);
  const shape = shapeOf(dst);
  assert.equal((await dst.call('POST', '/api/config/import', { file, fingerprint: p3.fingerprint })).status, 200);
  assert.deepEqual(shapeOf(dst), shape);
  await src.stop();
  await dst.stop();
});

test('an import whose plan changed since its preview, or that fails part-way, changes nothing', async () => {
  const src = await populated();
  const { file } = await exportOf(src);
  const dst = await startServer();
  const p = (await preview(dst, file)).data;
  await ok(dst, 'POST', '/api/skills', { name: 'weekly-report', description: 'Here first', body: 'Mine' });
  const before = shapeOf(dst);
  const r = await dst.call('POST', '/api/config/import', { file, fingerprint: p.fingerprint });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(shapeOf(dst), before);

  // Fails on the last routine: every Boton, workspace, skill and connector it made goes with it.
  const p2 = (await preview(dst, file)).data;
  const original = dst.app.store.createRoutine.bind(dst.app.store);
  let n = 0;
  dst.app.store.createRoutine = (...args: Parameters<typeof original>): Routine => {
    if (++n === 4) throw new Error('disk on fire');
    return original(...args);
  };
  const failed = await dst.call('POST', '/api/config/import', { file, fingerprint: p2.fingerprint });
  dst.app.store.createRoutine = original;
  assert.equal(failed.status, 500, failed.text);
  assert.deepEqual(shapeOf(dst), before);
  assert.ok(!dst.app.store.listBots().length);
  await src.stop();
  await dst.stop();
});

test('a file that is malformed, from a newer Botons or trying to reach outside its fields is refused whole', async () => {
  const src = await populated();
  const { file } = await exportOf(src);
  const dst = await startServer();
  const before = shapeOf(dst);
  const clone = () => JSON.parse(JSON.stringify(file)) as any;
  const cases: [string, (f: any) => unknown, RegExp][] = [
    ['newer', (f) => ({ ...f, version: PORTABLE_VERSION + 1 }), /newer Botons/],
    ['older than any', (f) => ({ ...f, version: 0 }), /version/],
    ['other format', (f) => ({ ...f, format: 'botons-sidebar' }), /format/],
    ['unknown field', (f) => ({ ...f, extra: 1 }), /file\.extra is not a field/],
    ['nested unknown field', (f) => (f.botons[0].sessionId = 'x', f), /botons\[0\]\.sessionId is not a field/],
    ['missing field', (f) => (delete f.botons[0].askFirst, f), /askFirst is missing/],
    ['skill source escaping', (f) => ((f.skills.find((x: any) => x.source).source.folder = '../../etc'), f), /folder/],
    ['listed file escaping', (f) => ((f.skills.find((x: any) => x.source).source.files = ['../outside']), f), /files\[0\]/],
    ['absolute listed file', (f) => ((f.skills.find((x: any) => x.source).source.files = ['/etc/passwd']), f), /files\[0\]/],
    ['the browser as a library entry', (f) => (f.connectors.push({ ...f.connectors.find((c: any) => c.id === 'lib:notes'), id: 'lib:botons_browser', name: 'botons_browser' }), f), /browser Botons runs itself/],
    ['bad schedule', (f) => ((f.botons[0].routines[0].schedule = 'whenever you like'), f), /schedule/],
    ['webhook source on a plain routine', (f) => ((f.botons[0].routines[0].webhookSource = 'github'), f), /webhookSource/],
    ['unknown sidebar ref', (f) => (f.sidebar.ungrouped.botIds.push('m99'), f), /m99/],
    ['author not in file', (f) => ((f.skills.find((x: any) => x.author.kind === 'boton').author.ref = 'm99'), f), /author\.ref/],
    ['too long', (f) => ((f.botons[0].instructions = 'x'.repeat(20_001)), f), /instructions/],
    ['credential in a URL', (f) => ((f.connectors.find((c: any) => c.id === 'lib:tracker').url = 'https://user:pw@mcp.example.com/'), f), /credentials/],
    ['an array for an object', (f) => ((f.settings = []), f), /settings must be an object/],
  ];
  for (const [what, change, error] of cases) {
    const r = await preview(dst, change(clone()));
    assert.equal(r.status, 400, `${what}: ${r.text}`);
    assert.match((r.data as unknown as { error: string }).error, error, what);
    const i = await dst.call('POST', '/api/config/import', { file: change(clone()), fingerprint: 'x' });
    assert.equal(i.status, 400, what);
  }
  // A __proto__ key, as JSON.parse keeps it (an own property), anywhere in the file.
  const raw = JSON.stringify({ file: clone() }).replace('"look":{', '"look":{"__proto__":{"admin":true},');
  const res = await fetch(`${dst.base}/api/config/import/preview`, { method: 'POST', headers: { authorization: `Bearer ${dst.token}`, 'content-type': 'application/json' }, body: raw });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /__proto__/);
  // Choices naming what the file doesn't have, or widening a kept skill into one it can't be.
  assert.equal((await preview(dst, file, { botons: { nobody: { action: 'create' } } })).status, 400);
  assert.equal((await preview(dst, file, { skills: { 'weekly-report': 'replace' } })).status, 400);
  assert.equal((await preview(dst, file, { botons: { m1: { provider: 'not-a-brain' } } })).status, 400);
  assert.deepEqual(shapeOf(dst), before);
  await src.stop();
  await dst.stop();
});

test('only paired devices export or import: a Boton token is refused', async () => {
  const s = await startServer();
  const bot = await s.newBot('Kevin');
  const { file } = await exportOf(s);
  const boton = s.app.auth.mintBotonToken(bot.id).token;
  assert.equal((await s.call('GET', '/api/config/export', undefined, boton)).status, 403);
  assert.equal((await s.call('POST', '/api/config/import/preview', { file }, boton)).status, 403);
  assert.equal((await s.call('POST', '/api/config/import', { file }, boton)).status, 403);
  assert.equal((await s.call('GET', '/api/config/export', undefined, null)).status, 401);
  await s.stop();
});

test('a brain this server lacks is swapped for one it has, with its model and levels left out', async () => {
  const src = await populated();
  const { file } = await exportOf(src);
  file.botons[2].provider = 'some-other-brain';
  file.botons[2].model = 'their-model';
  const dst = await startServer();
  const p = (await preview(dst, file)).data;
  const bob = p.botons[2];
  assert.deepEqual([bob.provider.available, bob.model.imported], [false, '']);
  assert.ok(bob.provider.options.includes(bob.provider.imported) && bob.provider.imported !== 'some-other-brain');
  assert.ok(p.reconnect.some((r) => r.kind === 'brain' && r.target === bob.ref));
  await src.stop();
  await dst.stop();
});

test('the version-1 fixture keeps importing, and helpers redact what looks like a credential', async () => {
  const fixture = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-1.json'), 'utf8')));
  const { file, upgradedFrom } = readPortable(fixture);
  assert.equal(upgradedFrom, 1);
  assert.deepEqual([file.version, file.templates, file.settings.reactionFollowUps], [PORTABLE_VERSION, [], null], 'version 1 is read as the current version with no templates and no reaction setting');
  assert.deepEqual([file.botons[0].dailyCapUsd, file.botons[0].routines.map((r) => r.perRunCapUsd)], [null, [null]], 'and with no spending caps');
  assert.equal(file.botons[0].name, 'Dave');
  const dst = await startServer();
  const p = (await preview(dst, fixture)).data;
  const done = await dst.call<PortableImportResult>('POST', '/api/config/import', { file: fixture, fingerprint: p.fingerprint });
  assert.equal(done.status, 200, done.text);
  const dave = dst.app.store.getBot(done.data.botons[0].botId) as Bot;
  assert.equal(dave.name, 'Dave');
  assert.equal(dst.app.store.listRoutines(dave.id)[0].enabled, false);
  await dst.stop();

  assert.deepEqual(cleanArgs(['--token=abc', '--password', 'hunter2', '-v', 'ghp_abcdefghijklmnop1234']).args, [`--token=${LEFT_OUT}`, '--password', LEFT_OUT, '-v', LEFT_OUT]);
  assert.ok(credentialShaped('use sk-ant-abcdefgh12345678'));
  assert.ok(!credentialShaped('Brief me every morning at 8.'));
});
