import assert from 'node:assert/strict';
// The fixtures were exported under the earlier names; legacy-names.test.ts imports them as they are.
import { currentPortable } from '../../shared/legacy-names.mjs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { AuditEvent, PortableConfig, PortableExport, PortableImportPreview, PortableImportResult, Routine, ServerEvent } from '../../shared/types.ts';
import { cleanArgs, LEFT_OUT, PORTABLE_VERSION, readPortable } from '../src/portable.ts';
import { startServer, type TestServer } from './helpers.ts';

// The edges of the configuration file: credentials in a connector's command line, the push token's server, what a
// rolled-back import may show, earlier skill texts, the reaction setting, strict reading, and saved templates.

/** Everything a test started, stopped after it whether it passed or not. */
const live: { stop(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const x of live.splice(0).reverse()) await x.stop();
});
const start = async () => {
  const s = await startServer();
  live.push(s);
  return s;
};

const ok = async <T>(s: TestServer, method: string, path: string, body?: unknown): Promise<T> => {
  const r = await s.call<T>(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`);
  return r.data;
};
const exportOf = (s: TestServer) => ok<PortableExport>(s, 'GET', '/api/config/export');
const preview = (s: TestServer, file: unknown, choices?: unknown) => s.call<PortableImportPreview>('POST', '/api/config/import/preview', { file, ...(choices ? { choices } : {}) });
const importIt = (s: TestServer, file: unknown, p: PortableImportPreview) => s.call<PortableImportResult>('POST', '/api/config/import', { file, choices: p.choices, fingerprint: p.fingerprint });
/** Every event the server publishes from now on (what SSE clients are sent). */
const events = (s: TestServer) => {
  const seen: ServerEvent[] = [];
  s.app.hub.subscribe((e) => seen.push(e));
  return seen;
};

test('credentials in a connector command line are left out by structure, short ones too, and named', async () => {
  const s = await start();
  const seen = events(s);
  const secrets = ['shrtA1', 'querysecret9', 'shrtB2', 'shrtC3', 'shrtD4', 'pw5x', 'shrtE6'];
  await ok(s, 'POST', '/api/mcp-servers', {
    name: 'notes',
    transport: 'stdio',
    command: 'notes-mcp',
    args: [
      'API_KEY=shrtA1',
      'https://mcp.example.com/?token=querysecret9&page=2',
      '--password',
      '-shrtB2',
      '--header',
      'Authorization: Bearer shrtC3',
      '--Client-Secret=shrtD4',
      '--url=https://sam:pw5x@mcp.example.com/mcp',
      'env DB_PASSWORD=shrtE6 serve',
      '--verbose',
      'plain',
    ],
  });
  const out = await exportOf(s);
  const notes = out.file.connectors.find((c) => c.id === 'lib:notes')!;
  assert.ok(notes.kind === 'library');
  assert.deepEqual(notes.args, [
    `API_KEY=${LEFT_OUT}`,
    'https://mcp.example.com/',
    '--password',
    LEFT_OUT,
    '--header',
    `Authorization: ${LEFT_OUT}`,
    `--Client-Secret=${LEFT_OUT}`,
    '--url=https://mcp.example.com/mcp',
    // Shell text holding a credential goes whole: its quoting is never guessed at.
    LEFT_OUT,
    '--verbose',
    'plain',
  ]);
  // Every one is named for the owner to put back, with the names (never the values) it had.
  for (const i of [0, 1, 3, 5, 6, 7, 8]) assert.ok(notes.leftOut.some((x) => x.startsWith(`args[${i}]`)), `args[${i}] in ${notes.leftOut.join(' | ')}`);
  assert.ok(notes.leftOut.some((x) => x.includes('query (token, page)')));
  const dst = await start();
  const p = (await preview(dst, out.file)).data;
  const logs = await ok<unknown>(s, 'GET', '/api/logs');
  for (const where of [JSON.stringify(out), JSON.stringify(p), JSON.stringify(logs), JSON.stringify(seen.filter((e) => e.type !== 'bot.status'))]) {
    for (const v of secrets) assert.ok(!where.includes(v), `${v} reached ${where.slice(0, 80)}`);
  }
  // Odd input is read, never thrown on: a stray %, a bare flag at the end, LEFT_OUT itself.
  assert.deepEqual(cleanArgs(['https://x.example.com/a%zz', '--token']).args, ['https://x.example.com/a%zz', '--token']);
  assert.deepEqual(cleanArgs([`KEY=${LEFT_OUT}`, LEFT_OUT]).args, [`KEY=${LEFT_OUT}`, LEFT_OUT]);
  // What it left out stays left out, and is still named, when the file goes round again.
  const again = readPortable(JSON.parse(JSON.stringify(out.file))).file.connectors.find((c) => c.id === 'lib:notes')!;
  assert.deepEqual(again.kind === 'library' && again.args, notes.args);
});

/** A loopback ntfy server that keeps the Authorization header of each publish. */
async function fakeNtfy(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"x"}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  live.push({ stop: () => new Promise<void>((r) => srv.close(() => r())) });
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

test("the saved push token stays with its server: an import or an edit naming another server removes it, so it is never sent there", async () => {
  const mine = await fakeNtfy();
  const theirs = await fakeNtfy();
  const token = 'tk_destinationOwnToken42';
  const src = await start();
  await ok(src, 'PATCH', '/api/settings', { ntfy: { server: theirs.url, topic: 'from-file', enabled: true } });
  const { file } = await exportOf(src);
  assert.equal(file.settings.ntfy.tokenLeftOut, false);

  const dst = await start();
  await ok(dst, 'PATCH', '/api/settings', { ntfy: { server: mine.url, topic: 'mine', token, enabled: false } });
  const p = (await preview(dst, file, { settings: true })).data;
  const tokenChange = p.settings.changes.find((c) => c.field === 'Push access token');
  assert.ok(tokenChange && tokenChange.to.startsWith('removed'), JSON.stringify(p.settings));
  assert.ok(!JSON.stringify(p).includes(token));
  assert.equal((await importIt(dst, file, p)).status, 200);
  const after = dst.app.store.getSettings().ntfy;
  assert.deepEqual([after.server, after.enabled, after.hasToken], [theirs.url, true, false]);
  assert.equal((await dst.call('POST', '/api/notify/test', {})).status, 200);
  assert.equal(theirs.seen.length, 1);
  assert.equal(theirs.seen[0].authorization, undefined, 'the other server never gets the token');

  // The same server keeps the owner's own token: it is still where it was meant to go.
  await ok(dst, 'PATCH', '/api/settings', { ntfy: { server: mine.url, topic: 'mine', token, enabled: true } });
  const same = structuredClone(file) as PortableConfig;
  same.settings.ntfy = { ...same.settings.ntfy, server: mine.url, tokenLeftOut: true };
  const p2 = (await preview(dst, same, { settings: true })).data;
  assert.ok(!p2.settings.changes.some((c) => c.field === 'Push access token'));
  assert.ok(!p2.reconnect.some((r) => r.kind === 'ntfy-token'));
  assert.equal((await importIt(dst, same, p2)).status, 200);
  assert.equal(dst.app.store.getSettings().ntfy.hasToken, true);

  // An edit in Settings is held to the same: another server without a new token drops the saved one.
  await ok(dst, 'PATCH', '/api/settings', { ntfy: { server: theirs.url } });
  assert.equal(dst.app.store.getSettings().ntfy.hasToken, false);
  const last = dst.app.store.db.prepare("select details from audit_events where action = 'settings.notifications_changed' order by seq desc limit 1").get() as { details: string };
  assert.equal(JSON.parse(last.details).credentialChanged, true, 'the audit says the token went');
  await ok(dst, 'POST', '/api/notify/test', {});
  assert.ok(theirs.seen.every((h) => h.authorization === undefined));
});

test('an import that fails late publishes nothing, keeps every approval and audits nothing; its retry publishes each once', async () => {
  const src = await start();
  const kevin = await src.newBot('Kevin');
  await ok(src, 'POST', '/api/skills', { name: 'weekly-report', description: 'Owner text', body: 'From the file' });
  await ok(src, 'POST', '/api/oauth-connections', { name: 'fleet', url: 'https://fleet.example.com/mcp' });
  await src.newRoutine(kevin.id, { name: 'One', instruction: 'Do one' });
  await src.newRoutine(kevin.id, { name: 'Two', instruction: 'Do two' });
  await ok(src, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Kevin template' });
  const { file } = await exportOf(src);

  const dst = await start();
  const bob = await dst.newBot('Bob');
  dst.app.skills.createByBoton(bob.id, { name: 'weekly-report', description: "Bob's text", body: 'Pending' });
  const pending = () => (dst.app.store.db.prepare("select status from approvals where kind = 'skill'").all() as { status: string }[]).map((r) => ({ status: r.status }));
  assert.deepEqual(pending(), [{ status: 'pending' }]);
  const p = (await preview(dst, file, { skills: { 'weekly-report': 'replace' } })).data;
  const templatesDir = join(dst.cfg.home, 'templates');
  const files = () => (existsSync(templatesDir) ? readdirSync(templatesDir) : []);

  const seen = events(dst);
  const original = dst.app.store.createRoutine.bind(dst.app.store);
  dst.app.store.createRoutine = (...args: Parameters<typeof original>): Routine => {
    if (args[1].name === 'Two') throw new Error('disk on fire');
    return original(...args);
  };
  const failed = await importIt(dst, file, p);
  dst.app.store.createRoutine = original;
  assert.equal(failed.status, 500, failed.text);
  assert.deepEqual(seen.filter((e) => e.type !== 'bot.status').map((e) => e.type), [], 'nothing a rolled-back import did is published');
  assert.deepEqual(pending(), [{ status: 'pending' }]);
  assert.equal(dst.app.skills.get('weekly-report').body, 'Pending');
  assert.deepEqual(dst.app.oauth.list(), []);
  assert.deepEqual(files(), [], 'no template file is left');
  const audit = () => (dst.app.store.db.prepare("select action from audit_events where action = 'config.imported' or (action = 'boton.created' and details like '%config import%')").all() as { action: string }[]).map((r) => r.action);
  assert.deepEqual(audit(), []);

  const done = await importIt(dst, file, p);
  assert.equal(done.status, 200, done.text);
  const count = (type: string) => seen.filter((e) => e.type === type).length;
  assert.deepEqual([count('oauth.upserted'), count('approval.upserted'), count('skill.upserted')], [1, 1, 1]);
  assert.deepEqual(pending(), [{ status: 'allowed' }]);
  assert.equal(dst.app.skills.get('weekly-report').body, 'From the file');
  assert.equal(files().filter((f) => f.endsWith('.json')).length, 1);
  assert.ok(!files().some((f) => f.endsWith('.tmp')));
  assert.deepEqual(audit().sort(), ['boton.created', 'config.imported']);
});

test('every earlier skill text is checked for credentials, named by version, and kept as written', async () => {
  const s = await start();
  await ok(s, 'POST', '/api/skills', { name: 'deploy', description: 'Deploy', body: 'Use ghp_abcdefghijklmnop1234 to push' });
  await ok(s, 'PATCH', '/api/skills/deploy', { body: 'Use the saved token' });
  const out = await exportOf(s);
  const w = out.textWarnings.find((x) => x.startsWith('skill deploy: its earlier text 1 of 1, replaced '));
  assert.ok(w, out.textWarnings.join(' | '));
  assert.ok(!out.textWarnings.some((x) => x.startsWith('skill deploy: its current text')));
  assert.ok(!out.textWarnings.join().includes('ghp_'), 'a warning never holds what it found');
  assert.equal(out.file.skills[0].history[0].body, 'Use ghp_abcdefghijklmnop1234 to push', 'kept as written');
  const dst = await start();
  const p = (await preview(dst, out.file)).data;
  assert.ok(p.textWarnings.includes(w));
});

test('the reactions that start a follow-up go with the file; a version-1 file says nothing, so the server keeps its own', async () => {
  const src = await start();
  await ok(src, 'PATCH', '/api/settings', { reactionFollowUps: [] });
  const { file } = await exportOf(src);
  assert.deepEqual(file.settings.reactionFollowUps, []);
  const dst = await start();
  assert.deepEqual(dst.app.store.getSettings().reactionFollowUps, ['👎']);
  const p = (await preview(dst, file)).data;
  assert.ok(p.settings.changes.some((c) => c.field === 'Reactions that start a follow-up' && c.from === '👎' && c.to === 'none'));
  assert.equal((await importIt(dst, file, p)).status, 200);
  assert.deepEqual(dst.app.store.getSettings().reactionFollowUps, []);
  assert.deepEqual((await exportOf(dst)).file.settings.reactionFollowUps, []);

  const v1 = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-1.json'), 'utf8')));
  const fresh = await start();
  await ok(fresh, 'PATCH', '/api/settings', { reactionFollowUps: ['❤️', '👎'] });
  const p1 = (await preview(fresh, v1, { settings: true })).data;
  assert.deepEqual([p1.upgradedFrom, p1.source.version], [1, 1]);
  assert.ok(p1.settings.notes.some((n) => n.includes("this server's are kept")));
  assert.ok(!p1.settings.changes.some((c) => c.field.startsWith('Reactions')));
  assert.equal((await importIt(fresh, v1, p1)).status, 200);
  assert.deepEqual(fresh.app.store.getSettings().reactionFollowUps, ['❤️', '👎']);
  // A field version 1 never had is refused in a version-1 file, not upgraded over.
  assert.equal((await preview(fresh, { ...v1, templates: [] })).status, 400);
  // A file from a newer Botons is refused.
  assert.match((await preview(fresh, { ...file, version: PORTABLE_VERSION + 1 })).text, /newer Botons/);
});

test('reading is strict: an unknown look field, bytes that are not UTF-8 or a lone surrogate refuse the file and change nothing; real Unicode goes through', async () => {
  const src = await start();
  await src.newBot('Zoë 🍌', { title: 'Chef d’équipe', instructions: '日本語で答えて' });
  const { file } = await exportOf(src);
  const dst = await start();
  const shape = () => JSON.stringify([dst.app.store.listBots().length, dst.app.store.getSettings(), dst.app.skills.list().length]);
  const before = shape();
  const seen = events(dst);

  const extra = structuredClone(file) as any;
  extra.botons[0].look.nose = true;
  const r1 = await preview(dst, extra);
  assert.equal(r1.status, 400);
  assert.match(r1.text, /botons\[0\]\.look\.nose is not a field/);

  // The raw bytes as a hand-edited file might hold them: an é broken into a lone 0xE9 byte.
  const json = Buffer.from(JSON.stringify({ file }), 'utf8');
  const at = json.indexOf(Buffer.from('Zo', 'utf8')) + 2;
  const broken = Buffer.concat([json.subarray(0, at), Buffer.from([0xe9]), json.subarray(at + 2)]);
  for (const path of ['/api/config/import/preview', '/api/config/import']) {
    const res = await fetch(`${dst.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${dst.token}`, 'content-type': 'application/json' }, body: broken });
    assert.equal(res.status, 400, path);
    assert.match((await res.json()).error, /UTF-8/);
  }
  const lone = JSON.stringify({ file }).replace('Zoë', 'Zo\\ud800');
  const res = await fetch(`${dst.base}/api/config/import/preview`, { method: 'POST', headers: { authorization: `Bearer ${dst.token}`, 'content-type': 'application/json' }, body: lone });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /lone surrogate/);
  assert.equal(shape(), before);
  assert.deepEqual(seen.filter((e) => e.type !== 'bot.status'), []);

  const p = (await preview(dst, file)).data;
  const done = await importIt(dst, file, p);
  assert.equal(done.status, 200, done.text);
  const bot = dst.app.store.getBot(done.data.botons[0].botId);
  assert.deepEqual([bot.name, bot.title, bot.instructions], ['Zoë 🍌', 'Chef d’équipe', '日本語で答えて']);
});

test('saved templates go with the file without widening anything, and arrive whole or not at all', async () => {
  const src = await start();
  const kevin = await src.newBot('Kevin', { access: 'host', title: 'Deployer' });
  await src.newRoutine(kevin.id, { name: 'Hook', instruction: 'Deploy', webhook: true, webhookWorkspace: false });
  await src.newRoutine(kevin.id, { name: 'Daily', instruction: 'Check', schedule: 'daily at 9:00' });
  await ok(src, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Deployer', description: 'Deploys things' });
  const { file } = await exportOf(src);
  assert.equal(file.templates.length, 1, 'never the built-in ones');
  const t = file.templates[0];
  assert.deepEqual([t.ref, t.name, t.bot.access, t.routines.length], ['t1', 'Deployer', 'host', 2]);
  assert.ok(!JSON.stringify({ ...t, bot: { ...t.bot, look: null } }).includes('key'), 'no webhook key (a look may be a keycap)');

  const dst = await start();
  const p = (await preview(dst, file)).data;
  const plan = p.templates[0];
  assert.deepEqual([plan.action, plan.same, plan.routines], ['create', false, 2]);
  assert.ok(plan.narrowed.some((x) => x.startsWith('Full computer access')) && plan.narrowed.some((x) => x.includes('webhook routine')));
  const done = await importIt(dst, file, p);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.data.templates, ['Deployer']);
  const saved = (await ok<{ id: string; builtin: boolean; bot: { access: string }; routines: { webhookWorkspace: boolean; name: string }[] }[]>(dst, 'GET', '/api/templates')).filter((x) => !x.builtin);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].bot.access, 'workspace');
  assert.ok(saved[0].routines.every((r) => r.webhookWorkspace));
  assert.ok(dst.app.store.listBots().every((b) => b.name !== 'Deployer'), 'a template makes no Boton');
  const audit = (await ok<AuditEvent[]>(dst, 'GET', '/api/audit')).find((e) => e.action === 'config.imported');
  assert.equal(audit?.details.templates, 1);

  // The same file again leaves the template alone by default.
  const again = (await preview(dst, file)).data;
  assert.deepEqual([again.templates[0].action, again.templates[0].same], ['skip', true]);
  const choose = (await preview(dst, file, { templates: { nope: 'create' } })).status;
  assert.equal(choose, 400);
});

test('the version-2 fixture keeps importing: its template and reaction setting arrive', async () => {
  const fixture = currentPortable(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'portable-config-2.json'), 'utf8')));
  assert.equal(readPortable(fixture).upgradedFrom, 2);
  const dst = await start();
  const p = (await preview(dst, fixture)).data;
  const done = await importIt(dst, fixture, p);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.data.templates, ['Researcher']);
  assert.deepEqual(dst.app.store.getSettings().reactionFollowUps, ['👎', '❤️']);
});
