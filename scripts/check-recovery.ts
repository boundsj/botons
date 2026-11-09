// `npm run check:recovery`: a backup restored onto a fresh machine, end to end, with the real commands, against
// throwaway servers (temp HOME and BOTONS_HOME, 127.0.0.1, free ports in 17000-19999, the mock provider, no Tailscale,
// no real CLI). Each server is `node server/src/index.ts` in its own process, stopped by its own PID. It checks:
// - a populated install (groups, Boton looks, skills and grants, a connector with a dummy key, chat with pins and a
//   session, memories, routines with a webhook, workspace, shared, template and browser-profile files, and a turn still
//   running) backed up by `scripts/backup.ts` while it runs, then stopped;
// - the backup, the restore and the doctor run from a copy of this checkout without node_modules, as a fresh machine
//   holding only the release has them (they import Node's builtins only);
// - `scripts/restore.ts --yes` into a BOTONS_HOME that does not exist yet: every folder unpacked onto disk, private;
// - the restored server cold-starts with the same device token and has every Boton, look, group, pin, skill, grant,
//   message, memory, routine, webhook key, session and index; the turn cut off mid-way ends as interrupted, Boton
//   tokens are gone, and chat and the old webhook key work in the new folder;
// - a populated schema 34 backup (the release before) restores, upgrades at the first start after its own backup,
//   keeps its rows and pins, pairs a new device, and ends with the schema a new database gets;
// - both backups rehearse from the app (current, and upgraded in the copy), and no backup changes by a byte;
// - a data folder this user cannot write: the restore and the server refuse up front with what to do (the server with
//   exit 78), and work once the owner gives it back; an unreadable backups folder shows in the app's status;
// - SIMULATED no space left: a `tar` on PATH that fails the unpack with ENOSPC, as a full disk does. Nothing here
//   fills a disk; the restore rolls back, keeps what was there, says what to do, and works once tar does.
// Exits 1 with what failed. The app's screens for these states are `npm run check:operations`.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Bot, ConnectorAccess, Memory, Message, OperationsStatus, PairingRequest, Routine, RoutineRun, SidebarLayout, Skill, SkillAccess } from '../shared/types.ts';
import { randomLook } from '../shared/look.ts';
import { RENAMED } from '../shared/legacy-names.mjs';
import { seeded } from '../shared/seeded.ts';
import { stamp } from '../server/src/backup.ts';
import { openSchema, SCHEMA_VERSION } from '../server/src/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'botons-recovery-'));
const log = (...a: unknown[]) => console.log('[recovery]', ...a);
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[recovery] FAIL ${what}`);
  }
};
/** Equal as JSON; when not, the first place they differ is logged. */
const same = (a: unknown, b: unknown) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x === y) return true;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  log(`     differs at ${i}: …${x.slice(Math.max(0, i - 80), i + 120)}\n     vs …${y.slice(Math.max(0, i - 80), i + 120)}`);
  return false;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRoot = process.getuid?.() === 0;

/** Nothing a server or command here runs may find the real home folder, CLI logins or settings. */
const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: join(tmp, 'home'),
  CODEX_HOME: join(tmp, 'codex-home'),
  CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'),
  BOTONS_NO_TAILSCALE: '1',
  BOTONS_HOST: '127.0.0.1',
  BOTONS_CLAUDE_BIN: join(tmp, 'no-claude'),
  BOTONS_CODEX_BIN: join(tmp, 'no-codex'),
  ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
};
// BOTONS_HOME is always set, so no command reads the service's env file; HOME is the temp one either way.
mkdirSync(baseEnv.HOME, { recursive: true });
/** The only secret here: a stand-in connector key, which must come back with the restore and never be shown. */
const DUMMY_KEY = 'dummy-connector-key-not-a-secret';

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}
async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 17000 + Math.floor(Math.random() * 3000);
    if (await portFree(port)) return port;
  }
  throw new Error('no free port in 17000-19999');
}

/** A command, its output and exit code. */
function run(cmd: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** sha256 of every file under `dir`, by relative path: a backup must not change by a byte. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const servers = new Set<ChildProcess>();

/** `node server/src/index.ts` on `home`, in its own process: the server a service would run. */
async function startServer(home: string, opts: { expectExit?: boolean } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'server/src/index.ts')], {
    env: { ...baseEnv, BOTONS_HOME: home, BOTONS_PORT: String(port), BOTONS_ENABLE_MOCK: '1', BOTONS_LOG_LEVEL: 'info', BOTONS_SCHEDULER_MS: '200', BOTONS_DRAIN_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.add(child);
  let output = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (output += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (output += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => (servers.delete(child), r(code))));
  const base = `http://127.0.0.1:${port}`;
  /** SIGTERM to this server's own PID, as systemd stops it; SIGKILL to the same PID only if it does not exit. */
  async function stop(): Promise<number | null> {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    child.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout' as const)]);
    if (code !== 'timeout') return code;
    child.kill('SIGKILL');
    return exited;
  }
  const output_ = () => output;
  if (opts.expectExit) {
    const code = await Promise.race([exited, sleep(30_000).then(() => 'timeout' as const)]);
    if (code === 'timeout') await stop();
    return { base, stop, pid: child.pid!, output: output_, code };
  }
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`the server on ${home} exited ${child.exitCode}:\n${output}`);
    if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) break;
    await sleep(100);
  }
  if (!(await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`the server on ${home} did not answer:\n${output}`);
  return { base, stop, pid: child.pid!, output: output_, code: null as number | null | 'timeout' };
}

function client(base: string, token: string) {
  const call = async <T = any>(method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data: data as T, text };
  };
  const ok = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await call<T>(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text}`);
    return r.data;
  };
  return { call, ok };
}

const artifact = join(tmp, 'release');
/** A command from the release copy (no node_modules), on `home`. */
const cli = (script: string, home: string, args: string[], env: Record<string, string> = {}) => run(process.execPath, [join(artifact, 'scripts', script), ...args], { ...baseEnv, BOTONS_HOME: home, ...env });

/** Pair a device as the owner does: the device asks, `npm run pair -- --approve` on the server's machine, the device pairs. */
async function pair(base: string, home: string, label: string): Promise<string> {
  const req = (await (await fetch(`${base}/api/auth/pair-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) })).json()) as PairingRequest;
  const approve = run(process.execPath, [join(root, 'scripts/pair.ts'), '--approve', req.code, '--label', label], { ...baseEnv, BOTONS_HOME: home });
  if (approve.code !== 0) throw new Error(`npm run pair -- --approve failed: ${approve.out}`);
  const res = await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: req.secret, label }) });
  if (res.status !== 201) throw new Error(`pairing failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

function readDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const schemaOf = (db: DatabaseSync) => db.prepare("select type, name, sql from sqlite_master where name not like 'sqlite_%' order by name").all();
const freshSchema = (() => {
  const db = new DatabaseSync(':memory:');
  openSchema(db);
  const s = schemaOf(db);
  db.close();
  return s;
})();
const sessionsOf = (db: DatabaseSync) => ({
  bots: db.prepare('select id, session_id, session_key, context_since, look, group_id, pinned, connections, skills from bots order by id').all(),
  routines: db.prepare('select id, session_id, session_key from routines order by id').all(),
});

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The release as a fresh machine has it: this checkout's files, without node_modules or git. */
function copyRelease() {
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  for (const f of files) {
    if (f.startsWith('node_modules/') || f.includes('/node_modules/') || !existsSync(join(root, f))) continue;
    mkdirSync(dirname(join(artifact, f)), { recursive: true });
    cpSync(join(root, f), join(artifact, f));
  }
  check(!existsSync(join(artifact, 'node_modules')) && existsSync(join(artifact, 'scripts/restore.ts')), `the release copy has ${files.length} files and no node_modules`);
}

/** A populated backup from the schema before this one (an install a release back), made as its backup command did. */
function priorBackup(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = '2026-11-01T09:00:00.000Z';
  const at = (m: number) => new Date(Date.parse(now) + m * 60_000).toISOString();
  // A valid look at the restore boundary, preserved byte for byte.
  const look = JSON.stringify(randomLook(seeded(7)));
  const db = new DatabaseSync(join(dir, 'botons.db'));
  db.exec(`${readFileSync(join(root, `server/test/fixtures/schema-${SCHEMA_VERSION - 1}.sql`), 'utf8')}\npragma user_version = ${SCHEMA_VERSION - 1};`);
  db.prepare("insert into settings (key, value) values ('ownerName', 'Sam')").run();
  db.prepare("insert into settings (key, value) values ('setupComplete', '1')").run();
  db.prepare("insert into sidebar_groups (id, name, name_key, position, collapsed, created_at, updated_at) values ('grp_equipe', 'Équipe', 'équipe', 0, 0, ?, ?)").run(now, now);
  const bot = db.prepare(
    "insert into bots (id, name, look, provider, effort, access, timezone, workspace, session_id, session_key, context_since, connections, skills, always_allow, group_id, position, pinned, pin_position, created_at, updated_at, last_activity_at) values (?, ?, ?, 'mock', '', 'workspace', 'UTC', ?, ?, ?, ?, '[]', ?, '[]', ?, ?, ?, 0, ?, ?, ?)",
  );
  bot.run('bot_kevin', 'Kevin', look, 'kevin', 'sess-k', 'key-k', at(10), '["weekly"]', 'grp_equipe', 0, 0, now, now, now);
  bot.run('bot_bob', 'Bob', look, 'bob', null, null, null, null, null, 0, 1, now, now, now);
  db.prepare("insert into routines (id, bot_id, name, instruction, schedule, timezone, enabled, session, session_id, session_key, created_at, updated_at) values ('rt_brief', 'bot_kevin', 'Brief', 'Do it', 'cron 0 8 * * *', 'UTC', 1, 'own', 'sess-r', 'key-r', ?, ?)").run(now, now);
  db.prepare("insert into skills (name, description, body, created_by, updated_by, created_at, updated_at) values ('weekly', 'Write the weekly report.', 'Steps.', '{\"kind\":\"owner\"}', '{\"kind\":\"owner\"}', ?, ?)").run(now, now);
  const msg = db.prepare('insert into messages (id, bot_id, role, text, meta, created_at) values (?, ?, ?, ?, ?, ?)');
  msg.run('msg_old', 'bot_kevin', 'user', 'before the reset', null, at(1));
  msg.run('msg_oldpin', 'bot_kevin', 'bot', 'pinned before the reset', JSON.stringify({ pinned: { at: at(2) } }), at(2));
  msg.run('msg_reset', 'bot_kevin', 'event', 'Started a fresh conversation', JSON.stringify({ kind: 'session.reset' }), at(10));
  msg.run('msg_decide', 'bot_kevin', 'user', 'We ship on Friday.', JSON.stringify({ pinned: { at: at(11) } }), at(11));
  msg.run('msg_brief', 'bot_kevin', 'bot', 'The brief.', JSON.stringify({ routineId: 'rt_brief', routineName: 'Brief' }), at(12));
  db.prepare('update bots set connections = ? where id = ?').run(JSON.stringify([`lib:${RENAMED.botons_browser}`]), 'bot_kevin');
  db.prepare('update skills set created_by = ?, updated_by = ?').run(JSON.stringify({ kind: RENAMED.boton, id: 'bot_kevin' }), JSON.stringify({ kind: RENAMED.boton, id: 'bot_kevin' }));
  const counts: Record<string, number> = {};
  for (const { name } of db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all()) counts[String(name)] = Number(db.prepare(`select count(*) as n from "${name}"`).get()!.n);
  db.close();
  const src = join(tmp, 'prior-folders');
  for (const [f, text] of [['workspaces/kevin/notes.md', '# Kevin\n'], ['workspaces/bob/todo.md', '- ship\n'], ['shared/handoff.md', 'for the team\n'], ['templates/tpl_x.json', '{}\n'], ['browser/bot_kevin/profile/Default/Cookies', 'dummy cookies\n']]) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), text);
  }
  const tar = run('tar', ['-czf', join(dir, 'workspaces.tar.gz'), '-C', src, 'workspaces', 'shared', 'templates', 'browser'], baseEnv);
  if (tar.code !== 0) throw new Error(`tar: ${tar.out}`);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ createdAt: now, schemaVersion: SCHEMA_VERSION - 1, counts, workspaces: true, folders: ['workspaces', 'shared', 'templates', 'browser'] }, null, 2)}\n`, { mode: 0o600 });
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
}

async function main() {
  log(`schema ${SCHEMA_VERSION}; temp folder ${tmp}`);
  copyRelease();

  // 1. A populated install, backed up while it runs.
  log('— a populated install');
  const source = join(tmp, 'old-host', 'botons');
  let srv = await startServer(source);
  const token = await pair(srv.base, source, 'Recovery check');
  let api = client(srv.base, token);
  await api.ok('PATCH', '/api/setup', { complete: true });
  await api.ok('PATCH', '/api/settings', { ownerName: 'Sam', timezone: 'UTC' });
  const kevin = await api.ok<Bot>('POST', '/api/bots', { name: 'Kevin', provider: 'mock' });
  const stuart = await api.ok<Bot>('POST', '/api/bots', { name: 'Stuart', provider: 'mock' });
  const bob = await api.ok<Bot>('POST', '/api/bots', { name: 'Bob', provider: 'mock', look: randomLook() });
  // Connectors need a brain that takes them; this claude CLI does not exist, so Dave never runs a turn here.
  const dave = await api.ok<Bot>('POST', '/api/bots', { name: 'Dave', provider: 'claude-cli' });
  const { groupId } = await api.ok('POST', '/api/sidebar/groups', { name: 'Équipe' });
  await api.ok('POST', `/api/sidebar/bots/${kevin.id}/move`, { groupId });
  await api.ok('POST', `/api/sidebar/bots/${stuart.id}/move`, { groupId });
  await api.ok('POST', `/api/sidebar/bots/${bob.id}/pin`, { pinned: true });
  await api.ok('POST', '/api/skills', { name: 'weekly-report', description: 'Write the weekly report.', body: 'Steps for the weekly report.' });
  const skillAccess = await api.ok<SkillAccess>('GET', '/api/skills/weekly-report/details').then((d: any) => d.access as SkillAccess);
  const hasSkill = skillAccess.botons.filter((m) => m.has).map((m) => m.botId);
  await api.ok('PUT', '/api/skills/weekly-report/access', { botIds: [kevin.id], expected: hasSkill });
  await api.ok('POST', '/api/mcp-servers', { name: 'notes', transport: 'stdio', command: process.execPath, args: [join(root, 'server/test/fixtures/fake-stdio-mcp.ts')], env: { NOTES_TOKEN: DUMMY_KEY } });
  const connector = (await api.ok('GET', '/api/connectors')).connectors.find((c: any) => c.name === 'notes' || c.id.endsWith('notes'));
  const connectorAccess = await api.ok<ConnectorAccess>('GET', `/api/connectors/${encodeURIComponent(connector.id)}/access`);
  await api.ok('PUT', `/api/connectors/${encodeURIComponent(connector.id)}/access`, { botIds: [dave.id], expected: connectorAccess.botons.filter((m) => m.has).map((m) => m.botId) });

  await api.ok('POST', `/api/bots/${kevin.id}/messages`, { text: 'We ship on Friday.' });
  await until(async () => (await api.ok<Message[]>('GET', `/api/bots/${kevin.id}/messages`)).some((m) => m.text === 'Echo: We ship on Friday.'), "Kevin's answer");
  const decision = (await api.ok<Message[]>('GET', `/api/bots/${kevin.id}/messages`)).find((m) => m.role === 'user' && m.text === 'We ship on Friday.')!;
  await api.ok('POST', `/api/bots/${kevin.id}/messages/${decision.id}/pin`, { pinned: true });
  await api.ok('POST', `/api/bots/${kevin.id}/memories`, { text: 'The plan is in plan.md' });
  await api.ok('POST', `/api/bots/${kevin.id}/routines`, { name: 'Daily digest', instruction: 'Digest', schedule: '0 9 * * *' });
  const hook = await api.ok<Routine>('POST', `/api/bots/${kevin.id}/routines`, { name: 'On deploy', instruction: 'Report it', webhook: true });
  const fire = (base: string, key: string) => fetch(`${base}/hooks/routines/${hook.id}?wait=1&timeout=10`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{"v":1}' });
  const firstRun = (await (await fire(srv.base, hook.webhook!.key)).json()) as RoutineRun;
  check(firstRun.status === 'succeeded', `the webhook routine ran (${firstRun.status})`);
  const folder = (b: Bot) => b.workspace.split('/').pop()!;
  writeFileSync(join(kevin.workspace, 'plan.md'), '# The plan\n');
  writeFileSync(join(source, 'shared', 'handoff.md'), 'for the other botons\n');
  mkdirSync(join(source, 'templates'), { recursive: true });
  writeFileSync(join(source, 'templates', 'tpl_check.json'), '{}\n');
  mkdirSync(join(source, 'browser', kevin.id, 'profile', 'Default'), { recursive: true });
  writeFileSync(join(source, 'browser', kevin.id, 'profile', 'Default', 'Cookies'), 'dummy cookies\n');
  // A turn still running when the backup is taken and the server stops.
  await api.ok('POST', `/api/bots/${stuart.id}/messages`, { text: 'SLOW_PLEASE:120000 the long job' });
  await until(async () => (await api.ok<Bot>('GET', `/api/bots/${stuart.id}`)).status?.state === 'working', "Stuart's turn running");

  const want = {
    bots: await api.ok<Bot[]>('GET', '/api/bots'),
    sidebar: await api.ok<SidebarLayout>('GET', '/api/sidebar'),
    skills: await api.ok<Skill[]>('GET', '/api/skills'),
    skillAccess: (await api.ok('GET', '/api/skills/weekly-report/details')).access,
    connectorAccess: (({ running: _r, ...rest }) => rest)(await api.ok('GET', `/api/connectors/${encodeURIComponent(connector.id)}/access`)),
    messages: Object.fromEntries(await Promise.all([kevin, stuart, bob].map(async (b) => [b.id, await api.ok<Message[]>('GET', `/api/bots/${b.id}/messages?limit=500`)]))),
    memories: await api.ok<Memory[]>('GET', `/api/bots/${kevin.id}/memories`),
    routines: await api.ok<Routine[]>('GET', `/api/bots/${kevin.id}/routines`),
  };
  check(want.skillAccess.botons.filter((m: any) => m.has).map((m: any) => m.botId).join() === kevin.id && want.bots.find((b) => b.id === dave.id)?.connections.includes(connector.id), 'Kevin has the skill and Dave the connector before the backup');

  const backedUp = cli('backup.ts', source, []);
  check(backedUp.code === 0 && /workspaces\.tar\.gz/.test(backedUp.stdout), `scripts/backup.ts from the release copy backs up the running server (exit ${backedUp.code})${backedUp.code ? `: ${backedUp.out}` : ''}`);
  const backupDir = join(source, 'backups', readdirSync(join(source, 'backups')).filter((n) => !n.endsWith('.partial')).sort().at(-1)!);
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  check(same(manifest.folders, ['workspaces', 'shared', 'templates', 'browser']) && manifest.schemaVersion === SCHEMA_VERSION, `the backup holds the database (schema ${manifest.schemaVersion}) and ${manifest.folders?.join(', ')}`);
  const sourceDb = readDb(join(backupDir, 'botons.db'), (db) => ({ sessions: sessionsOf(db), running: Number(db.prepare("select count(*) as n from turns where outcome = 'running'").get()!.n), botonTokens: Number(db.prepare("select count(*) as n from auth_tokens where kind = 'boton'").get()!.n) }));
  check(sourceDb.running === 1, `the backup caught Stuart's turn running (${sourceDb.running})`);
  check(sourceDb.sessions.bots.some((b: any) => b.id === kevin.id && b.session_id), "Kevin's session is in the backup");
  const backupHash = hashTree(backupDir);

  const stopped = await srv.stop();
  check(stopped === 0, `the old server stops on SIGTERM to its own PID (exit ${stopped})`);

  // 2. A fresh machine: the release copy restores into a BOTONS_HOME that does not exist yet.
  log('— restore onto a fresh machine');
  const target = join(tmp, 'new-host', 'botons');
  const dry = cli('restore.ts', target, [backupDir]);
  check(dry.code === 0 && /does not exist yet/.test(dry.stdout) && /Nothing was changed/.test(dry.stdout) && !existsSync(target), `the dry run says what it would do and creates nothing (exit ${dry.code})${dry.code ? `: ${dry.out}` : ''}`);
  const restored = cli('restore.ts', target, [backupDir, '--yes']);
  check(restored.code === 0 && /Restored\./.test(restored.stdout), `restore --yes into the new folder (exit ${restored.code})${restored.code ? `: ${restored.out}` : ''}`);
  check(!readdirSync(target).some((f) => f.startsWith('before-restore-') || f.startsWith('.restore-')), 'nothing to set aside on a new machine, and no staging left');
  const on = (f: string) => (existsSync(join(target, f)) ? readFileSync(join(target, f), 'utf8') : null);
  check(on(`workspaces/${folder(kevin)}/plan.md`) === '# The plan\n' && on('shared/handoff.md') === 'for the other botons\n' && on('templates/tpl_check.json') === '{}\n' && on(`browser/${kevin.id}/profile/Default/Cookies`) === 'dummy cookies\n', 'workspace, shared, template and browser-profile files are unpacked onto disk');
  check((statSync(target).mode & 0o777) === 0o700 && (statSync(join(target, 'botons.db')).mode & 0o777) === 0o600, 'the new data folder and its database are private');
  const doctor = cli('doctor.ts', target, ['--json', '--skip-clis'], { BOTONS_PORT: String(await freePort()) });
  const findings: { check: string; status: string; message: string }[] = (() => {
    try {
      return JSON.parse(doctor.stdout).findings;
    } catch {
      return [];
    }
  })();
  if (!findings.length) log(`doctor said: ${doctor.out.slice(0, 2000)}`);
  const finding = (area: string) => findings.find((f) => f.check === area);
  check(finding('database')?.status === 'ok' && new RegExp(`v${SCHEMA_VERSION}`).test(finding('database')!.message) && finding('data')?.status === 'ok', `the doctor from the release copy reads the restored folder: data ${finding('data')?.status}, ${finding('database')?.message}`);
  check(/not running/.test(finding('server')?.message ?? ''), `and says no server runs on it yet: ${finding('server')?.message}`);

  srv = await startServer(target);
  api = client(srv.base, token);
  const got = await api.call<Bot[]>('GET', '/api/bots');
  check(got.status === 200, `the restored server cold-starts and takes the old device token (${got.status})`);
  const strip = (bots: Bot[]) => bots.map(({ workspace: _w, status: _s, lastActivityAt: _l, ...b }: any) => b);
  check(same(strip(got.data), strip(want.bots)), 'every Boton: names, Boton looks, groups, pins, skills, connectors, effort');
  check(got.data.every((b) => b.workspace === join(target, 'workspaces', folder(b))), 'each workspace is in the new folder');
  check(same(await api.ok('GET', '/api/sidebar'), want.sidebar), 'the sidebar: the group, its order and the pinned Boton');
  check(same(await api.ok('GET', '/api/skills'), want.skills) && same((await api.ok('GET', '/api/skills/weekly-report/details')).access, want.skillAccess), 'skills and who has them');
  const connAfter = (({ running: _r, ...rest }) => rest)(await api.ok('GET', `/api/connectors/${encodeURIComponent(connector.id)}/access`));
  check(same(connAfter, want.connectorAccess), 'the connector and its grants');
  const server = await api.ok('GET', '/api/mcp-servers/notes');
  check(!JSON.stringify(server).includes(DUMMY_KEY), "the connector's key is restored but never shown back");
  for (const b of [kevin, bob]) check(same(await api.ok('GET', `/api/bots/${b.id}/messages?limit=500`), want.messages[b.id]), `${b.name}'s chat history, pins included`);
  const kevinPins = (await api.ok<Message[]>('GET', `/api/bots/${kevin.id}/messages?limit=500`)).filter((m: any) => m.meta?.pinned).map((m) => m.id);
  check(same(kevinPins, [decision.id]), 'the pinned decision is still pinned');
  const noUrl = (rs: Routine[]) => rs.map((r) => ({ ...r, webhook: r.webhook && { ...r.webhook, url: new URL(r.webhook.url).pathname } }));
  const routinesAfter = await api.ok<Routine[]>('GET', `/api/bots/${kevin.id}/routines`);
  check(same(await api.ok('GET', `/api/bots/${kevin.id}/memories`), want.memories) && same(noUrl(routinesAfter), noUrl(want.routines)), 'memories, routines and webhook keys');
  check(routinesAfter.find((r) => r.webhook)?.webhook?.url.startsWith(`${srv.base}/hooks/`), 'the webhook URL names the new server');
  // The chat the stop cut off (before any step) is answered again at the cold start, once: not lost, not doubled.
  await until(async () => (await api.ok<Bot>('GET', `/api/bots/${stuart.id}`)).status?.state === 'working', "Stuart's cut-off chat picked up again");
  check(same(await api.ok('GET', `/api/bots/${stuart.id}/messages?limit=500`), want.messages[stuart.id]), "the chat cut off mid-turn is picked up again at the cold start, its history kept as it was");
  await api.ok('POST', `/api/bots/${stuart.id}/stop`);
  await until(async () => (await api.ok<Bot>('GET', `/api/bots/${stuart.id}`)).status?.state === 'idle', 'Stuart stopped');
  check(true, 'and the owner can stop it from the app');
  const hooked = await fire(srv.base, hook.webhook!.key);
  check(hooked.status === 200 && ((await hooked.json()) as RoutineRun).status === 'succeeded', 'the old webhook key still runs its routine');
  check((await fire(srv.base, 'not-the-key')).status === 401, 'and a wrong key is refused');
  await api.ok('POST', `/api/bots/${kevin.id}/messages`, { text: 'Are you back?' });
  await until(async () => (await api.ok<Message[]>('GET', `/api/bots/${kevin.id}/messages`)).some((m) => m.text === 'Echo: Are you back?'), "Kevin's answer after the restore");
  check(true, 'Kevin answers in the restored install');
  const ops = await api.ok<OperationsStatus>('GET', '/api/operations');
  check(ops.health.ok !== false && ops.schema === SCHEMA_VERSION && same(ops.restorableSchemas, [SCHEMA_VERSION - 1, SCHEMA_VERSION]), `Health on the restored server: schema ${ops.schema}, restores ${ops.restorableSchemas.join(' and ')}`);

  // 3. Both backups rehearse from the app on the restored server, and neither changes.
  log('— rehearsals: this schema, and the one before');
  const prior = join(tmp, 'prior-backup', stamp(new Date('2026-11-01T09:00:00.000Z')));
  priorBackup(prior);
  const priorHash = hashTree(prior);
  mkdirSync(join(target, 'backups'), { recursive: true, mode: 0o700 });
  for (const d of [backupDir, prior]) cpSync(d, join(target, 'backups', d.split('/').at(-1)!), { recursive: true });
  for (const d of [backupDir, prior]) {
    const name = d.split('/').at(-1)!;
    const before = hashTree(join(target, 'backups', name));
    const start = await api.call('POST', '/api/backups/rehearse', { backup: name });
    const last = await until(async () => {
      const r = (await api.ok<OperationsStatus>('GET', '/api/operations')).rehearsal.last;
      return r && r.outcome !== 'running' && r;
    }, `the rehearsal of ${name}`);
    check(start.status === 202 && last.outcome === 'passed', `the rehearsal of the schema ${d === prior ? SCHEMA_VERSION - 1 : SCHEMA_VERSION} backup ${last.outcome}${d === prior ? ' (upgraded in the copy)' : ''}`);
    check(same(hashTree(join(target, 'backups', name)), before), 'and the rehearsed backup is unchanged, byte for byte');
  }

  // 4. An unreadable backups folder shows in the app.
  if (!isRoot) {
    chmodSync(join(target, 'backups'), 0o000);
    const blocked = (await api.ok<OperationsStatus>('GET', '/api/operations')).backups;
    chmodSync(join(target, 'backups'), 0o700);
    const back = (await api.ok<OperationsStatus>('GET', '/api/operations')).backups;
    check(blocked.unreadable && blocked.stale && !back.unreadable && back.total === 2, 'a backups folder the server cannot read shows as unreadable in Health, and clears once it can');
  }

  const stoppedNew = await srv.stop();
  check(stoppedNew === 0, `the restored server stops (exit ${stoppedNew})`);
  readDb(join(target, 'botons.db'), (db) => {
    const sessions = sessionsOf(db);
    check(same(sessions.routines, sourceDb.sessions.routines) && same(sessions.bots.map((b: any) => ({ ...b, session_id: b.id === stuart.id ? null : b.session_id, session_key: b.id === stuart.id ? null : b.session_key })), sourceDb.sessions.bots.map((b: any) => ({ ...b, session_id: b.id === stuart.id ? null : b.session_id, session_key: b.id === stuart.id ? null : b.session_key }))), 'sessions, looks, groups, pins, connectors and skills, row by row');
    check(same(schemaOf(db), freshSchema), 'tables and indexes: the schema a new database gets');
    const outcomes = db.prepare("select outcome, count(*) as n from turns where bot_id = ? group by outcome order by outcome").all(stuart.id).map((r) => `${r.outcome} ${r.n}`);
    check(same(outcomes, ['interrupted 1', 'stopped 1']) && Number(db.prepare("select count(*) as n from turns where outcome = 'running'").get()!.n) === 0, `Stuart's turns: the one cut off ended as interrupted, the one after as stopped (${outcomes.join(', ')}); none left running`);
    check(Number(db.prepare("select count(*) as n from auth_tokens where kind = 'boton'").get()!.n) === 0, `the Boton tokens of the old process are gone (${sourceDb.botonTokens} in the backup)`);
    check(Number(db.prepare("select count(*) as n from auth_tokens where kind = 'device'").get()!.n) === 1, 'the paired device is kept');
  });
  check(same(hashTree(backupDir), backupHash), 'the backup restored from is unchanged, byte for byte');

  // 5. The release before: a populated schema 34 backup restored, upgraded at the first start.
  log(`— a schema ${SCHEMA_VERSION - 1} backup onto another new machine`);
  const older = join(tmp, 'older-host', 'botons');
  const restoredOld = cli('restore.ts', older, [prior, '--yes']);
  check(restoredOld.code === 0 && new RegExp(`upgrades it to v${SCHEMA_VERSION} at its next start`).test(restoredOld.stdout), `restore --yes of the schema ${SCHEMA_VERSION - 1} backup says it upgrades at the next start (exit ${restoredOld.code})${restoredOld.code ? `: ${restoredOld.out}` : ''}`);
  const priorRows = readDb(join(prior, 'botons.db'), (db) => db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all().map(({ name }) => [name, db.prepare(`select * from "${name}" order by rowid`).all()]));
  srv = await startServer(older);
  const upgradeBackups = readdirSync(join(older, 'backups'));
  check(upgradeBackups.length === 1 && readDb(join(older, 'backups', upgradeBackups[0], 'botons.db'), (db) => Number(db.prepare('pragma user_version').get()!.user_version)) === SCHEMA_VERSION - 1, 'the first start backed the old schema up before upgrading');
  const oldToken = await pair(srv.base, older, 'New phone');
  api = client(srv.base, oldToken);
  const oldBots = await api.ok<Bot[]>('GET', '/api/bots');
  check(same(oldBots.map((b) => b.name).sort(), ['Bob', 'Kevin']) && oldBots.every((b) => b.workspace === join(older, 'workspaces', folder(b))), 'a new device pairs on the upgraded install and sees its Botons in the new folder');
  const layout = await api.ok<SidebarLayout>('GET', '/api/sidebar');
  check(same(layout.groups.map((g) => [g.name, g.botIds]), [['Équipe', ['bot_kevin']]]) && same(layout.pinned.botIds, ['bot_bob']), 'its group and pinned Boton');
  const oldMsgs = await api.ok<Message[]>('GET', '/api/bots/bot_kevin/messages?limit=500');
  check(same(oldMsgs.map((m) => m.id), ['msg_old', 'msg_oldpin', 'msg_reset', 'msg_decide', 'msg_brief']), 'its chat history');
  check(readFileSync(join(older, 'workspaces/kevin/notes.md'), 'utf8') === '# Kevin\n' && readFileSync(join(older, 'browser/bot_kevin/profile/Default/Cookies'), 'utf8') === 'dummy cookies\n', 'its files');
  check((await api.ok<OperationsStatus>('GET', '/api/operations')).schema === SCHEMA_VERSION, `Health reads schema ${SCHEMA_VERSION}`);
  await srv.stop();
  readDb(join(older, 'botons.db'), (db) => {
    check(Number(db.prepare('pragma user_version').get()!.user_version) === SCHEMA_VERSION && same(schemaOf(db), freshSchema), `upgraded to schema ${SCHEMA_VERSION}: the schema a new database gets, indexes included`);
    const expected = (name: string, rows: unknown) => (rows as Record<string, unknown>[]).map((row) => {
      if (name === 'bots') return { ...row, connections: String(row.connections).replace(JSON.stringify(`lib:${RENAMED.botons_browser}`), JSON.stringify('lib:botons_browser')) };
      if (name === 'skills') return { ...row, created_by: String(row.created_by).replace(JSON.stringify(RENAMED.boton), JSON.stringify('boton')), updated_by: String(row.updated_by).replace(JSON.stringify(RENAMED.boton), JSON.stringify('boton')) };
      return row;
    });
    const kept = priorRows.filter(([name]) => !['auth_tokens', 'audit_events', 'pairing_requests', 'settings'].includes(String(name))).every(([name, before]) => same(db.prepare(`select * from "${name}" order by rowid`).all(), expected(String(name), before)));
    check(kept, 'every row survives with only the author kinds and browser grants renamed (looks, sessions, pins, reset, routine, skill, group)');
    const grants = db.prepare('select connections from bots where id = ?').get('bot_kevin')!;
    const author = db.prepare('select created_by, updated_by from skills where name = ?').get('weekly')!;
    check(same(JSON.parse(String(grants.connections)), ['lib:botons_browser']) && [author.created_by, author.updated_by].every((a) => same(JSON.parse(String(a)), { kind: 'boton', id: 'bot_kevin' })), 'the restored browser grant and skill authors use the current names');
  });
  check(same(hashTree(prior), priorHash), `the schema ${SCHEMA_VERSION - 1} backup is unchanged, byte for byte`);

  // 6. A data folder this user cannot write, then given back.
  if (isRoot) log('skip permissions: root writes any folder');
  else {
    log('— a data folder this user cannot write');
    const locked = join(tmp, 'locked-host', 'botons');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    const refused = cli('restore.ts', locked, [backupDir, '--yes']);
    check(refused.code === 1 && /is not writable by this user/.test(refused.stderr) && /chmod u\+rwx/.test(refused.stderr) && !/at \w+ \(file:/.test(refused.out), `restore refuses up front with what to do, no stack trace: ${refused.stderr.trim().split('\n').at(-1)}`);
    check(readdirSync(locked).length === 0, 'and changes nothing');
    const down = await startServer(locked, { expectExit: true });
    check(down.code === 78 && /not writable by this user/.test(down.output()) && !/unhandledRejection/.test(down.output()), `the server refuses to start on it, exit ${down.code} (systemd does not restart it), and says what to do`);
    chmodSync(locked, 0o700);
    const again = cli('restore.ts', locked, [backupDir, '--yes']);
    check(again.code === 0, `once the owner gives it back, the same restore works (exit ${again.code})`);
    srv = await startServer(locked);
    check((await client(srv.base, token).call('GET', '/api/bots')).status === 200, 'and the server starts on it');
    await srv.stop();
  }

  // 7. SIMULATED no space left: tar on PATH fails the unpack with ENOSPC. No disk is filled.
  log('— SIMULATED: no space left while unpacking (a tar on PATH fails with ENOSPC; nothing fills a disk)');
  const full = join(tmp, 'full-host', 'botons');
  check(cli('restore.ts', full, [backupDir, '--yes']).code === 0, 'a restored install to restore again');
  writeFileSync(join(full, 'workspaces', folder(kevin), 'after.md'), 'written after the backup\n');
  const fullDb = hashTree(full)['botons.db'];
  const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
  const fakeBin = join(tmp, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'tar'), `#!/bin/sh\ncase " $* " in *" -xzf "*) echo "tar: workspaces/${folder(kevin)}/plan.md: Cannot write: No space left on device" >&2; exit 2;; esac\nexec ${realTar} "$@"\n`, { mode: 0o755 });
  const nospace = cli('restore.ts', full, [backupDir, '--yes'], { PATH: `${fakeBin}:${baseEnv.PATH}` });
  check(nospace.code === 1 && /original state preserved/.test(nospace.stderr) && /No space left on device/.test(nospace.stderr) && /Free space on the disk/.test(nospace.stderr), `(simulated) the restore stops, rolls back and says what to do: ${nospace.stderr.trim().split('\n').at(-1)}`);
  check(readFileSync(join(full, 'workspaces', folder(kevin), 'after.md'), 'utf8') === 'written after the backup\n' && hashTree(full)['botons.db'] === fullDb, '(simulated) what was there is as it was');
  check(!readdirSync(full).some((f) => f.startsWith('before-restore-') || f.startsWith('.restore-')), '(simulated) nothing set aside or staged is left behind');
  const retried = cli('restore.ts', full, [backupDir, '--yes']);
  const aside = readdirSync(full).filter((f) => f.startsWith('before-restore-'));
  check(retried.code === 0 && aside.length === 1 && existsSync(join(full, aside[0], 'workspaces', folder(kevin), 'after.md')) && !existsSync(join(full, 'workspaces', folder(kevin), 'after.md')), 'once there is room, the same restore works and sets the newer files aside');
  check(same(hashTree(backupDir), backupHash), 'the backup is still unchanged after every restore');
}

try {
  await main();
} catch (err) {
  failures.push(String((err as Error)?.stack ?? err));
  console.error('[recovery]', err);
} finally {
  for (const child of servers) {
    child.kill('SIGKILL');
  }
  // Folders a check made unwritable or unreadable are given back first, so the temp folder can go.
  spawnSync('chmod', ['-R', 'u+rwx', tmp]);
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`[recovery] ${failures.length} failed`);
  process.exit(1);
}
log('all good');
process.exit(0);
