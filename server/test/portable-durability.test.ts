import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { BotTemplate, PortableConfig, PortableExport, PortableImportPreview, PortableImportResult, ServerEvent } from '../../shared/types.ts';
import { cleanArgs, LEFT_OUT, readPortable } from '../src/portable.ts';
import { freePort, startServer, tempDir, type TestServer } from './helpers.ts';

// The configuration file's harder edges: credentials inside quoted and structured arguments, a sidebar read as
// strictly as the rest, saved templates that are shown exactly when their import committed (a real process killed
// at each step), and every loss a saved template takes named in the preview.

const live: { stop(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const x of live.splice(0).reverse()) await x.stop();
});
const start = async (opts: Parameters<typeof startServer>[0] = {}) => {
  const s = await startServer(opts);
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
const events = (s: TestServer) => {
  const seen: ServerEvent[] = [];
  s.app.hub.subscribe((e) => seen.push(e));
  return seen;
};
const saved = async (s: TestServer) => (await ok<BotTemplate[]>(s, 'GET', '/api/templates')).filter((t) => !t.builtin);
const audits = (s: TestServer, action: string) => Number((s.app.store.db.prepare('select count(*) as n from audit_events where action = ?').get(action) as { n: number }).n);
const outbox = (s: TestServer) => (s.app.store.db.prepare("select value from settings where key = 'templateOutbox'").get() as { value: string } | undefined)?.value;

test('a credential inside a quoted, multiword or structured argument goes whole; plain arguments stay as written', async () => {
  const s = await start();
  const seen = events(s);
  const secrets = ['smallsecret', 'twoWordA', 'twoWordB', 'qsecret7', 'hdrval8', 'jsonsecret', 'pw9x', 'pwmulti1', 'pwmulti2'];
  const plain = ['-y', '@modelcontextprotocol/server-filesystem', '/home/you/notes', '--port=8080', '--name', 'My Notes', '--header', 'Content-Type: application/json', '--mode=read-only', 'a-b=c-d', `KEY=${LEFT_OUT}`];
  await ok(s, 'POST', '/api/mcp-servers', {
    name: 'shell',
    transport: 'stdio',
    command: 'sh',
    args: [
      '-c',
      "env 'API_KEY=smallsecret' tool",
      'curl -H "Authorization: Bearer twoWordA twoWordB" https://x.example.com',
      "'https://mcp.example.com/?token=qsecret7'",
      '--header',
      'X-Api-Key: hdrval8 more',
      '--config',
      '{"apiKey":"jsonsecret","port":1}',
      '--url="https://sam:pw9x@x.example.com/a"',
      '--password',
      'pwmulti1 pwmulti2',
      'echo $(cat /x)',
      ...plain,
    ],
  });
  const out = await exportOf(s);
  const c = out.file.connectors.find((x) => x.id === 'lib:shell')!;
  assert.ok(c.kind === 'library');
  assert.deepEqual(c.args, [
    '-c',
    LEFT_OUT,
    LEFT_OUT,
    LEFT_OUT,
    '--header',
    `X-Api-Key: ${LEFT_OUT}`,
    '--config',
    LEFT_OUT,
    `--url=${LEFT_OUT}`,
    '--password',
    LEFT_OUT,
    // Shell text that only running it would read is never guessed at.
    LEFT_OUT,
    ...plain,
  ]);
  for (const i of [1, 2, 3, 5, 7, 8, 10, 11]) assert.ok(c.leftOut.some((x) => x.startsWith(`args[${i}] (`)), `args[${i}] named in ${c.leftOut.join(' | ')}`);
  assert.ok(!c.leftOut.some((x) => /^args\[(1[2-9]|2\d)\]/.test(x)), 'plain arguments are not named');

  const dst = await start();
  const p = (await preview(dst, out.file)).data;
  const logs = await ok<unknown>(s, 'GET', '/api/logs');
  for (const where of [JSON.stringify(out), JSON.stringify(p), JSON.stringify(logs), JSON.stringify(seen.filter((e) => e.type !== 'bot.status'))]) {
    for (const v of secrets) assert.ok(!where.includes(v), `${v} reached ${where.slice(0, 80)}`);
  }
  // Exported again, the placeholders stay as they are and nothing more is named.
  const again = cleanArgs(c.args);
  assert.deepEqual(again.args, c.args);
  assert.deepEqual(readPortable(JSON.parse(JSON.stringify(out.file))).file.connectors.find((x) => x.id === 'lib:shell')!, c);

  // A hand-made file with them as written is named in the preview's warnings.
  const raw = structuredClone(out.file);
  const rc = raw.connectors.find((x) => x.id === 'lib:shell')!;
  assert.ok(rc.kind === 'library');
  rc.args = ['-c', "env 'API_KEY=smallsecret' tool", '--header', 'Authorization: Bearer two words'];
  const warned = (await preview(dst, raw)).data;
  assert.ok(warned.textWarnings.some((x) => x.startsWith('connector lib:shell: args[1], args[3]')), warned.textWarnings.join(' | '));
});

/** A file of Kevin in a group, as an export writes it, for the sidebar's edges. */
async function groupedFile(): Promise<PortableConfig> {
  const src = await start();
  const kevin = await src.newBot('Kevin');
  await src.newBot('Stuart');
  const g = (await ok<{ groupId: string }>(src, 'POST', '/api/sidebar/groups', { name: 'Équipe 🚀' })).groupId;
  await ok(src, 'POST', '/api/sidebar/groups', { name: 'Empty' });
  await ok(src, 'POST', `/api/sidebar/bots/${kevin.id}/move`, { groupId: g, index: 0 });
  return (await exportOf(src)).file;
}

test('the sidebar is read as strictly as the rest: unknown fields and broken names refuse the file before anything changes', async () => {
  const file = await groupedFile();
  assert.deepEqual(
    file.sidebar.groups.map((g) => [g.name, g.botIds]),
    [
      ['Équipe 🚀', ['m1']],
      ['Empty', []],
    ],
  );
  const dst = await start();
  const seen = events(dst);
  const shape = async () => JSON.stringify([dst.app.store.listBots().length, dst.app.store.sidebarLayout(), dst.app.store.getSettings(), (await saved(dst)).length]);
  const before = await shape();
  const send = async (body: string) => {
    for (const path of ['/api/config/import/preview', '/api/config/import']) {
      const res = await fetch(`${dst.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${dst.token}`, 'content-type': 'application/json' }, body });
      const text = await res.text();
      assert.equal(res.status, 400, `${path}: ${text}`);
      return text;
    }
    return '';
  };
  const cases: [string, (f: any) => void, RegExp][] = [
    ['a future field in a group', (f) => (f.sidebar.groups[0].icon = 'star'), /sidebar\.groups\[0\]\.icon is not a field/],
    ['a future field in an empty group', (f) => (f.sidebar.groups[1].icon = 'star'), /sidebar\.groups\[1\]\.icon is not a field/],
    ['a future field in pinned', (f) => (f.sidebar.pinned.sort = 'name'), /sidebar\.pinned\.sort is not a field/],
    ['a future field at the top', (f) => (f.sidebar.theme = 'dark'), /sidebar\.theme is not a field/],
    ['a group name with space around it', (f) => (f.sidebar.groups[0].name = ' Équipe 🚀'), /has space/],
    ['two groups alike in any case', (f) => (f.sidebar.groups[1].name = 'ÉQUIPE 🚀'), /two groups/],
    ['a ref that is no Boton', (f) => f.sidebar.ungrouped.botIds.push('m99'), /m99/],
  ];
  for (const [what, edit, why] of cases) {
    const f = structuredClone(file) as any;
    edit(f);
    assert.match(await send(JSON.stringify({ file: f, choices: {}, fingerprint: 'x' })), why, what);
  }
  // A lone surrogate in a populated group's name, an empty group's name, a key and a list entry: as the JSON escape
  // a hand-edited file would hold, never stored as U+FFFD.
  const json = JSON.stringify({ file, choices: {}, fingerprint: 'x' });
  for (const body of [json.replace('Équipe', '\\ud800quipe'), json.replace('"Empty"', '"\\udc00"'), json.replace('"collapsed"', '"coll\\ud800"'), json.replace('"m1"]', '"m1","\\ud800"]')]) {
    assert.notEqual(body, json);
    assert.match(await send(body), /lone surrogate/);
  }
  assert.equal(await shape(), before);
  assert.deepEqual(seen.filter((e) => e.type !== 'bot.status'), []);

  // Real Unicode goes through, each group with its Botons, the empty one too.
  const p = (await preview(dst, file, { sidebar: 'replace' })).data;
  const done = await importIt(dst, file, p);
  assert.equal(done.status, 200, done.text);
  const layout = dst.app.store.sidebarLayout();
  const kevin = done.data.botons.find((m) => m.ref === 'm1')!.botId;
  assert.deepEqual(
    layout.groups.map((g) => [g.name, g.botIds]),
    [
      ['Équipe 🚀', [kevin]],
      ['Empty', []],
    ],
  );
  assert.ok(!JSON.stringify(layout).includes('�'));
});

/** Two saved templates on a source server, and a destination's preview of them, its server then stopped. */
async function stagedImport(): Promise<{ home: string; token: string; request: string; names: string[] }> {
  const src = await start();
  const kevin = await src.newBot('Kevin');
  await src.newRoutine(kevin.id, { name: 'Daily', instruction: 'Check', schedule: 'daily at 9:00' });
  await ok(src, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Alpha' });
  await ok(src, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Beta' });
  const { file } = await exportOf(src);
  const dst = await startServer();
  const p = (await preview(dst, file)).data;
  assert.deepEqual(Object.values(p.choices.templates), ['create', 'create']);
  const request = join(tempDir(), 'request.json');
  writeFileSync(request, JSON.stringify({ file, choices: p.choices, fingerprint: p.fingerprint }));
  await dst.stop();
  return { home: dst.home, token: dst.token, request, names: ['Alpha', 'Beta'] };
}

/** The crash fixture on `home`, killed (SIGKILL, its own pid) once it reports it is at `point`. */
async function crashAt(home: string, request: string, token: string, point: string): Promise<void> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'portable-crash.ts'), home, request, token, point, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes(`AT ${point}\n`)) resolve();
        if (out.includes('DONE')) reject(new Error(`the import finished without reaching ${point}: ${out}`));
      });
      child.once('exit', () => reject(new Error(`the fixture exited before ${point}: ${out}\n${err.slice(-2000)}`)));
    });
    assert.ok(child.pid && process.kill(child.pid, 'SIGKILL'));
    assert.equal(await exited, 'SIGKILL');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test('killed before its commit, an import leaves nothing: no Boton, no audit, no template shown, its staged files removed', async () => {
  const x = await stagedImport();
  await crashAt(x.home, x.request, x.token, 'before-commit');
  const dir = join(x.home, 'templates');
  assert.equal(filesIn(dir).filter((f) => f.endsWith('.json.staged')).length, 2, 'the kill came after the files were staged');
  const s = await start({ home: x.home, token: x.token });
  assert.deepEqual([s.app.store.listBots().length, audits(s, 'config.imported'), (await saved(s)).length, outbox(s)], [0, 0, 0, undefined]);
  assert.deepEqual(filesIn(dir), [], 'the start removed what no committed import lists');
});

for (const point of ['after-commit', 'mid-publish'] as const) {
  test(`killed ${point === 'after-commit' ? 'right after its commit' : 'between putting its templates in place'}, an import is whole once the server starts again`, async () => {
    const x = await stagedImport();
    await crashAt(x.home, x.request, x.token, point);
    const dir = join(x.home, 'templates');
    const before = filesIn(dir);
    assert.equal(before.filter((f) => f.endsWith('.json')).length, point === 'mid-publish' ? 1 : 0);
    assert.equal(before.filter((f) => f.endsWith('.json.staged')).length, point === 'mid-publish' ? 1 : 2);
    // Stopped by hand below to start again; the file's after() closes it if an assertion fails first.
    const s = await startServer({ home: x.home, token: x.token });
    const bots = s.app.store.listBots();
    assert.deepEqual(
      bots.map((b) => b.name),
      ['Kevin'],
    );
    assert.equal(audits(s, 'config.imported'), 1);
    assert.deepEqual(
      (await saved(s))
        .map((t) => t.name)
        .sort(),
      x.names,
    );
    assert.equal(outbox(s), undefined, 'the outbox is empty once each is in place');
    assert.ok(filesIn(dir).every((f) => f.endsWith('.json')));
    // The import's own record of what it made is the chat's event, kept with the commit.
    assert.ok(s.app.store.listMessages(bots[0].id).some((m) => m.meta?.kind === 'bot.imported'));
    // Starting again changes nothing more.
    await s.stop();
    const again = await start({ home: x.home, token: x.token });
    assert.equal((await saved(again)).length, 2);
  });
}

test('a committed template that can not be put in place yet is retried at the next read; a staged file that is not its own is never shown', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root writes any folder');
  const s = await start();
  const kevin = await s.newBot('Kevin');
  await ok(s, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Alpha' });
  const { file } = await exportOf(s);
  const dst = await start();
  const dir = join(dst.home, 'templates');
  const p = (await preview(dst, file)).data;
  // The folder can't be written once the import has staged its file and committed: the rename fails.
  const db = dst.app.store.db;
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    exec(sql);
    if (sql === 'commit') chmodSync(dir, 0o500);
  };
  try {
    const done = await importIt(dst, file, p);
    assert.equal(done.status, 200, done.text);
  } finally {
    db.exec = exec;
  }
  assert.equal((await saved(dst)).length, 0, 'not shown while its file is not in place');
  assert.ok(outbox(dst));
  chmodSync(dir, 0o700);
  assert.deepEqual(
    (await saved(dst)).map((x) => x.name),
    ['Alpha'],
  );
  assert.equal(outbox(dst), undefined);

  // An invalid staged artifact stays hidden, with its recovery record retained.
  const sha = '0'.repeat(64);
  writeFileSync(join(dir, 'tpl_aaaaaaaa.json.staged'), JSON.stringify({ name: 'Changed', bot: {}, routines: [] }));
  symlinkSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))!), join(dir, 'tpl_bbbbbbbb.json.staged'));
  db.prepare("insert into settings(key, value) values ('templateOutbox', ?)").run(JSON.stringify([{ id: 'tpl_aaaaaaaa', sha }, { id: 'tpl_bbbbbbbb', sha }, { id: '../x', sha }]));
  assert.deepEqual(
    (await saved(dst)).map((x) => x.name),
    ['Alpha'],
  );
  assert.ok(outbox(dst));
  assert.ok(!existsSync(join(dir, 'tpl_aaaaaaaa.json')) && existsSync(join(dir, 'tpl_aaaaaaaa.json.staged')));
});

test('a templates folder that can not be written fails the import before anything is made, audited or published', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root writes any folder');
  const s = await start();
  const kevin = await s.newBot('Kevin');
  await ok(s, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Alpha' });
  const { file } = await exportOf(s);
  const dst = await start();
  const dir = join(dst.home, 'templates');
  const p = (await preview(dst, file)).data;
  const seen = events(dst);
  await ok(dst, 'POST', '/api/templates', { fromBotId: (await dst.newBot('Bob')).id, name: 'Mine' });
  const p2 = (await preview(dst, file)).data;
  assert.notEqual(p2.fingerprint, p.fingerprint, 'a template saved here since changes the plan');
  seen.length = 0;
  chmodSync(dir, 0o500);
  try {
    const failed = await importIt(dst, file, p2);
    assert.equal(failed.status, 500, failed.text);
    assert.match(failed.text, /nothing was imported/);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual([dst.app.store.listBots().length, audits(dst, 'config.imported'), outbox(dst)], [1, 0, undefined]);
  assert.deepEqual(seen.filter((e) => e.type !== 'bot.status'), []);
  assert.deepEqual(filesIn(dir).filter((f) => !f.endsWith('.json')), []);
});

test("every loss a saved template takes is named in the preview, routine by routine, and it is saved as shown", async () => {
  const src = await start();
  await ok(src, 'POST', '/api/skills', { name: 'digest', description: 'Digest', body: 'Summarize' });
  const kevin = await src.newBot('Kevin', { title: 'Writer' });
  await src.newRoutine(kevin.id, { name: 'Digest', instruction: 'Digest the day', schedule: 'daily at 9:00', skill: 'digest' });
  await src.newRoutine(kevin.id, { name: 'Plain', instruction: 'Do it' });
  await ok(src, 'POST', '/api/templates', { fromBotId: kevin.id, name: 'Writer' });
  const { file } = await exportOf(src);
  assert.deepEqual([file.templates[0].bot.skills, file.templates[0].routines.map((r) => r.skill)], [null, ['digest', null]]);
  // A brain this server doesn't have, with a model for the template and its routine.
  const edited = structuredClone(file);
  edited.templates[0].bot.provider = 'elsewhere';
  edited.templates[0].bot.model = 'big-model';
  edited.templates[0].routines[0].model = 'small-model';

  const dst = await start();
  const p = (await preview(dst, edited, { skills: { digest: 'skip' } })).data;
  const narrowed = p.templates[0].narrowed;
  assert.ok(narrowed.includes("routine Digest: its skill digest, which this server won't have; its model small-model, for the brain this server doesn't have"), narrowed.join(' | '));
  assert.ok(narrowed.some((x) => x.startsWith("its brain elsewhere, which this server doesn't have, with its model big-model")));
  assert.ok(!narrowed.some((x) => x.startsWith('routine Plain')));
  // Keeping the skill instead is another plan, so another fingerprint: the preview binds what is saved.
  const keep = (await preview(dst, edited)).data;
  assert.notEqual(keep.fingerprint, p.fingerprint);
  assert.ok(!keep.templates[0].narrowed.some((x) => x.includes('skill digest')));

  const done = await importIt(dst, edited, p);
  assert.equal(done.status, 200, done.text);
  const t = (await saved(dst))[0];
  assert.deepEqual(
    [t.bot.provider, t.bot.model, t.routines.map((r) => [r.name, r.skill, r.model])],
    [
      null,
      '',
      [
        ['Digest', null, null],
        ['Plain', null, null],
      ],
    ],
  );
  const raw = JSON.parse(readFileSync(join(dst.home, 'templates', `${t.id}.json`), 'utf8'));
  assert.equal(raw.routines[0].skill, null);
});

test("a starter-installed Boton goes with the file as a plain Boton: its gate's secret and records never do, and its routine arrives off", async () => {
  const src = await start();
  const r = (await ok<{ reviewKey: string }>(src, 'POST', '/api/templates/builtin-web-watcher/review', { provider: 'mock', access: 'workspace' })).reviewKey;
  const made = await ok<{ id: string }>(src, 'POST', '/api/bots', { name: 'Kevin', provider: 'mock', access: 'workspace', templateId: 'builtin-web-watcher', starterConnectors: {}, reviewKey: r });
  const secret = src.app.store.starterSecret();
  const starterRows = (src.app.store.db.prepare("select key, value from settings where key like 'starter%'").all() as { key: string; value: string }[]).filter((x) => x.value.length >= 8);
  assert.ok(starterRows.length >= 1);
  const out = await exportOf(src);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(secret), 'never the starter secret');
  for (const row of starterRows) assert.ok(!text.includes(row.value), `never ${row.key}`);
  assert.ok(!/starter/i.test(JSON.stringify(out.file)), 'no starter record in the file');
  assert.equal(out.file.botons.find((m) => m.name === 'Kevin')?.routines.length, 1);
  assert.ok(made.id);

  const dst = await start();
  const p = (await preview(dst, out.file)).data;
  const done = await importIt(dst, out.file, p);
  assert.equal(done.status, 200, done.text);
  const bot = done.data.botons[0].botId;
  assert.deepEqual(
    dst.app.store.listRoutines(bot).map((x) => x.enabled),
    [false],
  );
  assert.notEqual(dst.app.store.starterSecret(), secret);
});


test('JSON-escaped credential property names are decoded before export and preview', async () => {
  const src = await start();
  const raw = '{"api\\u004bey":"smallsecret"}';
  await ok(src, 'POST', '/api/mcp-servers', { name: 'json-secret', transport: 'stdio', command: 'tool', args: ['--config', raw] });
  const exported = await exportOf(src);
  assert.ok(!JSON.stringify(exported).includes('smallsecret'));
  const c = exported.file.connectors.find((x) => x.id === 'lib:json-secret')!;
  assert.ok(c.kind === 'library' && c.leftOut.length > 0);
  const dst = await start();
  const p = await preview(dst, exported.file);
  assert.equal(p.status, 200, p.text);
  assert.ok(!JSON.stringify(p.data).includes('smallsecret'));
  assert.equal((await importIt(dst, exported.file, p.data)).status, 200);
  assert.ok(!JSON.stringify(await exportOf(dst)).includes('smallsecret'));
});

for (const kind of ['different', 'symlink', 'missing'] as const) {
  test(`template recovery retains and hides an unverified ${kind} final artifact`, async () => {
    const x = await stagedImport();
    await crashAt(x.home, x.request, x.token, 'after-commit');
    const dir = join(x.home, 'templates');
    const staged = filesIn(dir).find((f) => f.endsWith('.json.staged'))!;
    const final = staged.slice(0, -'.staged'.length);
    const correct = readFileSync(join(dir, staged), 'utf8');
    if (kind === 'different') writeFileSync(join(dir, final), correct.replace('Alpha', 'Unreviewed').replace('Beta', 'Unreviewed'));
    if (kind === 'symlink') {
      const outside = join(tempDir(), 'unreviewed.json');
      writeFileSync(outside, correct.replace('Alpha', 'Unreviewed').replace('Beta', 'Unreviewed'));
      symlinkSync(outside, join(dir, final));
    }
    if (kind === 'missing') rmSync(join(dir, staged));
    const s = await start({ home: x.home, token: x.token });
    assert.ok(!(await saved(s)).some((t) => t.name === 'Unreviewed'));
    assert.ok(outbox(s), 'keep the record until the reviewed artifact can be recovered');
    if (kind !== 'missing') assert.equal(readFileSync(join(dir, staged), 'utf8'), correct, 'keep the reviewed staged file');
    rmSync(join(dir, final), { force: true });
    if (kind === 'missing') writeFileSync(join(dir, staged), correct);
    assert.deepEqual((await saved(s)).map((t) => t.name).sort(), x.names);
    assert.equal(outbox(s), undefined);
  });
}

test('duplicate decoded JSON property names cannot hide credentials in exported command arguments', async () => {
  const cases = [
    '{"apiKey":"smallsecret","apiKey":null}',
    String.raw`{"api\u004bey":"smallsecret","apiKey":null}`,
    '{"outer":{"apiKey":"smallsecret"},"outer":{"port":8080}}',
    '{"items":[{"token":"smallsecret","token":null}]}',
  ];
  for (const [i, raw] of cases.entries()) {
    const src = await start();
    await ok(src, 'POST', '/api/mcp-servers', { name: `json-duplicate-${i}`, transport: 'stdio', command: 'tool', args: ['--config', raw] });
    const exported = await exportOf(src);
    assert.ok(!JSON.stringify(exported).includes('smallsecret'), raw);
    const connector = exported.file.connectors[0];
    assert.ok(connector.kind === 'library' && connector.leftOut.length > 0);
    const dst = await start();
    const p = await preview(dst, exported.file);
    assert.equal(p.status, 200, p.text);
    assert.ok(!JSON.stringify(p.data).includes('smallsecret'));
    assert.equal((await importIt(dst, exported.file, p.data)).status, 200);
    assert.ok(!JSON.stringify(await exportOf(dst)).includes('smallsecret'));
  }
});
