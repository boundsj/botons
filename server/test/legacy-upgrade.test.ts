// An install under deprecated names (shared/legacy-names.mjs) moves to the current ones without losing anything,
// can be moved back, and the earlier release still runs through the links meanwhile. A migration fixture: it names
// the earlier folders, units and files on purpose (see the old-names guard).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backup, planRestore, restore } from '../src/backup.ts';
import { chooseHome, loadConfig } from '../src/config.ts';
import { findLegacyService, legacyLeftovers, NameUpgradeError, RECORD, rollbackNames, undoService, upgradeDataFolder, upgradeService } from '../src/legacy-upgrade.ts';
import { DataDirInUseError, lockDataDir } from '../src/lock.ts';
import { botonArgv } from '../src/providers/api-tools.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { startServer, tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const NO_TS = () => ({ ip: null, dnsName: null });

/** Every row of every table, for comparing two databases. */
function dump(dbFile: string): string {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`select * from "${name}"`).all()]));
  } finally {
    db.close();
  }
}

/** A stopped server whose data is in <user home>/<dir> under the earlier database name: a device, a Boton with a file, a webhook routine, a browser profile. */
async function earlierInstall(dir = '.minions') {
  const h = tempDir('botons-upgrade-home-');
  const data = join(h, dir);
  const s = await startServer({ home: data });
  const bot = await s.newBot('Kevin');
  const routine = await s.newRoutine(bot.id, { webhook: true });
  writeFileSync(join(bot.workspace, 'notes.md'), 'kept\n');
  await s.stop();
  mkdirSync(join(data, 'browser', bot.id, 'Default'), { recursive: true });
  writeFileSync(join(data, 'browser', bot.id, 'Default', 'Preferences'), '{"profile":{"name":"kevin"}}');
  renameSync(join(data, 'botons.db'), join(data, 'minions.db'));
  return { h, data, bot, routine, token: s.token, before: dump(join(data, 'minions.db')) };
}

test('the data folder moves to ~/.botons after a backup, the database is renamed, the earlier names link to the new ones, and the server finds everything', async () => {
  const { h, data, bot, routine, token, before } = await earlierInstall();
  symlinkSync('.minions', join(h, '.tots')); // an earlier link to it
  assert.equal(loadConfig({ HOME: h }, NO_TS, { create: false }).dbPath, join(data, 'minions.db'), 'before the upgrade, the database by its earlier name: never a new empty one');
  assert.match(legacyLeftovers({ env: { HOME: h }, userHome: h }).join('\n'), /still .*\.minions, a deprecated name/);

  const order: string[] = [];
  const r = upgradeDataFolder({
    env: {},
    userHome: h,
    backup: (home) => {
      order.push(`backup ${home} ${existsSync(join(h, '.botons')) ? 'moved' : 'in place'} ${existsSync(join(home, 'minions.db')) ? 'old name' : 'new name'}`);
      return backup({ home });
    },
  });
  assert.deepEqual(order, [`backup ${data} in place old name`], 'the backup comes first');
  const fresh = join(h, '.botons');
  assert.deepEqual([r.home, r.moved, r.db], [fresh, true, true]);
  assert.ok(lstatSync(fresh).isDirectory() && !lstatSync(fresh).isSymbolicLink());
  assert.equal(readlinkSync(join(h, '.minions')), '.botons', 'a relative link, so it survives moving the home folder');
  assert.equal(readlinkSync(join(h, '.tots')), '.botons');
  assert.equal(readlinkSync(join(fresh, 'minions.db')), 'botons.db');
  assert.equal(dump(join(fresh, 'botons.db')), before, 'the database is as it was');
  assert.equal(dump(join(r.backupDir!, 'botons.db')), before, 'and so is its backup');
  assert.ok(r.backupDir!.startsWith(join(fresh, 'backups')));
  assert.ok(!existsSync(join(fresh, 'botons.db-wal')) || lstatSync(join(fresh, 'botons.db-wal')).size === 0);
  assert.ok(!existsSync(join(fresh, 'server.pid')), 'the lock left nothing behind');
  assert.deepEqual(legacyLeftovers({ env: { HOME: h }, userHome: h }), []);

  // The upgraded server: by default, and named by an earlier path.
  for (const env of [{ HOME: h }, { HOME: h, BOTONS_HOME: join(h, '.tots') }]) {
    const s = await startServer({ home: join(h, 'scratch'), env: { BOTONS_HOME: '', ...env }, token });
    assert.equal(s.cfg.home, fresh);
    assert.equal(s.cfg.dbPath, join(fresh, 'botons.db'));
    const bots = (await s.call('GET', '/api/bots')).data as { id: string; workspace: string }[];
    assert.deepEqual(bots.map((b) => b.id), [bot.id], 'the device paired before still works, and the Boton is there');
    assert.equal(readFileSync(join(bots[0].workspace, 'notes.md'), 'utf8'), 'kept\n');
    assert.equal((await s.hook(routine, '', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 202, 'the webhook URL and key still work');
    await s.stop();
  }
  // The earlier release opens it by its earlier path and name: the same database (SQLite follows the link).
  const old = new DatabaseSync(join(h, '.minions', 'minions.db'));
  assert.equal(Number((old.prepare('pragma user_version').get() as any).user_version), SCHEMA_VERSION);
  old.close();
  assert.equal(readFileSync(join(h, '.minions', 'browser', bot.id, 'Default', 'Preferences'), 'utf8'), '{"profile":{"name":"kevin"}}');

  // Again: nothing to do, and no second backup.
  const again = upgradeDataFolder({ env: {}, userHome: h, backup: () => assert.fail('backed up twice') });
  assert.deepEqual([again.moved, again.db, again.home], [false, false, fresh]);
});

test('an explicit data folder keeps its place and only the database is renamed; a folder named by its earlier default path moves', async () => {
  const { h, data, before } = await earlierInstall('custom');
  const r = upgradeDataFolder({ env: { BOTONS_HOME: data }, userHome: h });
  assert.deepEqual([r.home, r.moved, r.db], [data, false, true]);
  assert.equal(dump(join(data, 'botons.db')), before);
  assert.ok(!existsSync(join(h, '.botons')));

  const tots = await earlierInstall('.tots');
  const t = upgradeDataFolder({ env: { TOTS_HOME: tots.data }, userHome: tots.h });
  assert.deepEqual([t.home, t.moved], [join(tots.h, '.botons'), true]);
  assert.equal(chooseHome({ BOTONS_HOME: tots.data }, tots.h).home, join(tots.h, '.botons'));
});

test('nothing moves while a server holds the folder or when the backup fails; an interrupted move is finished by the next', async () => {
  const { h, data } = await earlierInstall();
  const held = lockDataDir(data);
  try {
    assert.throws(() => upgradeDataFolder({ env: {}, userHome: h }), DataDirInUseError);
  } finally {
    held.release();
  }
  assert.throws(() => upgradeDataFolder({ env: {}, userHome: h, backup: () => { throw new Error('disk full'); } }), (e: Error) => e instanceof NameUpgradeError && /disk full/.test(e.message));
  assert.throws(() => upgradeDataFolder({ env: {}, userHome: h, backup: () => ({ dir: 'x', manifest: { tarWarning: 'unreadable file' }, removed: [] }) as any }), NameUpgradeError);
  assert.ok(lstatSync(data).isDirectory() && existsSync(join(data, 'minions.db')) && !existsSync(join(h, '.botons')), 'nothing changed');

  upgradeDataFolder({ env: {}, userHome: h });
  // As if it stopped right after the renames: neither earlier name has its link, and the service names the earlier folder.
  renameSync(join(h, '.minions'), join(h, 'gone'));
  renameSync(join(h, '.botons', 'minions.db'), join(h, 'gone-db'));
  const r = upgradeDataFolder({ env: { MINIONS_HOME: data }, userHome: h, backup: () => assert.fail('backed up again') });
  assert.deepEqual(r.lines, [`Linked ${data} to ${join(h, '.botons')}.`, `Linked ${join(h, '.botons', 'minions.db')} to botons.db.`]);
  assert.equal(r.home, join(h, '.botons'));
  assert.equal(readlinkSync(data), '.botons');
  assert.equal(readlinkSync(join(h, '.botons', 'minions.db')), 'botons.db');
  assert.equal(loadConfig({ HOME: h, MINIONS_HOME: data }, NO_TS, { create: false }).dbPath, join(h, '.botons', 'botons.db'), 'the database it had, never a new one');
});

test('rollback keeps transactions a server left in the WAL when it stopped uncleanly', async () => {
  const x = await earlierService();
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  const fresh = join(x.h, '.botons');
  // A server that wrote and then died: its last transactions are only in botons.db-wal.
  const db = new DatabaseSync(join(fresh, 'botons.db'));
  db.exec('pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table crash_probe (n integer); insert into crash_probe values (1); insert into crash_probe values (2)');
  const { copyFileSync } = await import('node:fs');
  const crashed = tempDir();
  for (const f of ['botons.db', 'botons.db-wal']) copyFileSync(join(fresh, f), join(crashed, f));
  db.close();
  for (const f of ['botons.db', 'botons.db-wal']) copyFileSync(join(crashed, f), join(fresh, f));
  rmSync(join(fresh, 'botons.db-shm'), { force: true });
  assert.ok(lstatSync(join(fresh, 'botons.db-wal')).size > 0);
  await rollbackNames({ env: x.env, userHome: x.h, exec: x.exec });
  assert.ok(!existsSync(join(x.data, 'botons.db-wal')) && !existsSync(join(x.data, 'minions.db-wal')));
  const back = new DatabaseSync(join(x.data, 'minions.db'), { readOnly: true });
  assert.deepEqual(back.prepare('select n from crash_probe order by n').all().map((r: any) => r.n), [1, 2]);
  back.close();
});

test('a service handover that stopped part way is found again and finished; a finished one is left alone', async () => {
  const x = await earlierService();
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  assert.equal(findLegacyService({ env: x.env, userHome: x.h }), null);
  // As if it stopped after disabling the earlier unit and before starting botons.service.
  const record = join(x.h, '.botons', RECORD);
  const r = JSON.parse(readFileSync(record, 'utf8'));
  r.service.done = false;
  writeFileSync(record, JSON.stringify(r));
  assert.equal(findLegacyService({ env: x.env, userHome: x.h })?.unit, 'minions');
  x.calls.length = 0;
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec, backup: () => assert.fail('backed up again') });
  assert.ok(x.calls.includes('systemctl --user enable --now botons.service'), x.calls.join('\n'));
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).service.done, true);
  assert.equal(findLegacyService({ env: x.env, userHome: x.h }), null);
});

test("the service move uses the data folder the service's env file names, not a default one", async () => {
  const x = await earlierService();
  // The data lives elsewhere, named only in the env file; an unrelated default folder sits in ~/.tots.
  const custom = join(x.h, 'srv-data');
  renameSync(x.data, custom);
  mkdirSync(join(x.h, '.tots'));
  writeFileSync(join(x.config, 'minions', 'env'), x.envText.replace(`MINIONS_HOME=${x.data}`, `MINIONS_HOME=${custom}`));
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  assert.ok(existsSync(join(custom, 'botons.db')) && existsSync(join(custom, RECORD)));
  assert.ok(lstatSync(join(x.h, '.tots')).isDirectory() && !existsSync(join(x.h, '.botons')), 'the unrelated folder is left alone');
  assert.match(readFileSync(join(x.config, 'botons', 'env'), 'utf8'), new RegExp(`^BOTONS_HOME=${custom}$`, 'm'));
});

/** A service install under the earlier names: a release root with a current link, a unit, a backup timer and an env file. */
async function earlierService() {
  const install = await earlierInstall();
  const { h, data } = install;
  const config = join(h, '.config');
  const share = join(h, '.local', 'share', 'minions');
  const release = join(share, 'releases', 'abc');
  mkdirSync(join(release, 'server', 'src'), { recursive: true });
  writeFileSync(join(release, 'server', 'src', 'index.ts'), '');
  symlinkSync(join('releases', 'abc'), join(share, 'current'));
  const units = join(config, 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  writeFileSync(
    join(units, 'minions.service'),
    `[Service]\nWorkingDirectory=${share}/current\nEnvironmentFile=%h/.config/minions/env\nExecStart="${process.execPath}" "${share}/current/server/src/index.ts"\n`,
  );
  writeFileSync(join(units, 'minions-backup.service'), '');
  writeFileSync(join(units, 'minions-backup.timer'), '');
  mkdirSync(join(config, 'minions'), { recursive: true });
  const envText = `PATH=${share}/node/bin:/usr/bin\nMINIONS_HOME=${data}\nMINIONS_PORT=17123\nMINIONS_DRAIN_MS=5m\n`;
  writeFileSync(join(config, 'minions', 'env'), envText);
  const env = { HOME: h, XDG_CONFIG_HOME: config };
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    if (fail && calls.at(-1) === fail) throw new Error(`${fail} failed`);
  };
  let fail = '';
  return { ...install, config, share, units, env, envText, calls, exec, failOn: (c: string) => (fail = c) };
}

test('a service under its earlier names moves to botons.service: stopped first, folders moved with links, env file rewritten, new units started, earlier ones disabled; undo goes back', async () => {
  const x = await earlierService();
  assert.equal(findLegacyService({ env: x.env, userHome: x.h })?.unit, 'minions');
  const up = await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  const share = join(x.h, '.local', 'share');
  assert.deepEqual(x.calls, [
    'systemctl --user stop minions.service',
    'systemctl --user stop minions-backup.timer',
    'systemctl --user daemon-reload',
    'systemctl --user disable minions.service',
    'systemctl --user disable minions-backup.timer',
    'systemctl --user enable --now botons.service',
    'systemctl --user enable --now botons-backup.timer',
  ]);
  assert.equal(readlinkSync(join(share, 'minions')), 'botons');
  assert.equal(realpathSync(join(share, 'botons', 'current')), join(share, 'botons', 'releases', 'abc'));
  const fresh = join(x.h, '.botons');
  assert.equal(readlinkSync(x.data), '.botons');
  assert.equal(readFileSync(join(x.config, 'botons', 'env'), 'utf8'), `PATH=${share}/botons/node/bin:/usr/bin\nBOTONS_HOME=${fresh}\nBOTONS_PORT=17123\nBOTONS_DRAIN_MS=5m\n`);
  assert.equal(readFileSync(join(x.config, 'minions', 'env'), 'utf8'), x.envText, 'the earlier env file is as it was, for the earlier unit');
  const unit = readFileSync(join(x.units, 'botons.service'), 'utf8');
  assert.match(unit, new RegExp(`^ExecStart="${process.execPath}" "${join(share, 'botons', 'current')}/server/src/index.ts"$`, 'm'));
  assert.match(unit, /^EnvironmentFile=%h\/\.config\/botons\/env$/m);
  assert.match(unit, /^TimeoutStopSec=330$/m, "the drain setting is read under its current name");
  assert.match(readFileSync(join(x.units, 'botons-backup.service'), 'utf8'), /scripts\/backup\.ts/);
  assert.equal(findLegacyService({ env: x.env, userHome: x.h }), null);
  assert.ok(JSON.parse(readFileSync(join(fresh, RECORD), 'utf8')).service.unit === 'minions');

  x.calls.length = 0;
  await up.undo();
  assert.deepEqual(x.calls, [
    'systemctl --user disable --now botons.service',
    'systemctl --user disable --now botons-backup.timer',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now minions.service',
    'systemctl --user enable --now minions-backup.timer',
  ]);
  assert.ok(!existsSync(join(x.units, 'botons.service')) && !existsSync(join(x.config, 'botons', 'env')));
  // The earlier unit's paths all still lead to the data and the release.
  assert.equal(realpathSync(join(share, 'minions', 'current', 'server', 'src', 'index.ts')), join(share, 'botons', 'releases', 'abc', 'server', 'src', 'index.ts'));
  assert.equal(realpathSync(join(x.data, 'minions.db')), join(fresh, 'botons.db'));
});

test('a service move that fails part way puts the earlier unit back; rollback undoes a finished one and names the backup', async () => {
  const x = await earlierService();
  x.failOn('systemctl --user daemon-reload');
  await assert.rejects(upgradeService({ env: x.env, userHome: x.h, exec: x.exec }), /daemon-reload failed/);
  assert.equal(x.calls.at(-2), 'systemctl --user enable --now minions.service');
  assert.ok(!existsSync(join(x.units, 'botons.service')));

  x.failOn('');
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  x.calls.length = 0;
  const lines = await rollbackNames({ env: x.env, userHome: x.h, exec: x.exec });
  assert.ok(lstatSync(x.data).isDirectory() && !lstatSync(x.data).isSymbolicLink(), 'the data folder is back under its earlier name');
  assert.ok(existsSync(join(x.data, 'minions.db')) && !lstatSync(join(x.data, 'minions.db')).isSymbolicLink());
  assert.ok(!existsSync(join(x.h, '.botons')));
  assert.ok(lstatSync(x.share).isDirectory() && !lstatSync(x.share).isSymbolicLink());
  assert.ok(!existsSync(join(x.units, 'botons.service')));
  assert.deepEqual(x.calls.slice(-2), ['systemctl --user enable --now minions.service', 'systemctl --user enable --now minions-backup.timer']);
  assert.match(lines.join('\n'), /npm run restore -- .*backups/);
  assert.ok(!existsSync(join(x.config, 'botons', 'env')) && existsSync(join(x.config, 'botons', 'env.rolled-back')), 'the env file naming the new folders is set aside');
  // Admin commands read the service's settings as before: the data folder is the earlier one.
  const env = execFileSync(process.execPath, ['--input-type=module', '-e', `import './server/src/env-init.ts'; const { serverEnv } = await import('./scripts/install-service.ts'); const { chooseHome } = await import('./server/src/config.ts'); console.log(chooseHome(serverEnv(undefined).env).home);`], { cwd: repo, env: { PATH: process.env.PATH, HOME: x.h, XDG_CONFIG_HOME: x.config }, encoding: 'utf8' });
  assert.equal(env.trim(), x.data);
  // The earlier unit runs the release it was rolled back from, whose start would move the data again: it doesn't.
  const start = upgradeDataFolder({ env: x.env, userHome: x.h, backup: () => assert.fail('backed up at start') });
  assert.deepEqual([start.moved, start.db, start.home], [false, false, x.data]);
  assert.ok(lstatSync(x.data).isDirectory() && !lstatSync(x.data).isSymbolicLink() && !existsSync(join(x.h, '.botons')), 'left under its earlier names');
  assert.ok(!lstatSync(join(x.data, 'minions.db')).isSymbolicLink());
  assert.match(legacyLeftovers({ env: x.env, userHome: x.h }).join('\n'), /put back under its earlier names.*migrate:names/);
  // Asked for again, it moves.
  const again = upgradeDataFolder({ env: x.env, userHome: x.h, explicit: true });
  assert.deepEqual([again.moved, again.db], [true, true]);
  const named = /npm run restore -- (\S+?)`/.exec(lines.join('\n'))![1];
  assert.ok(existsSync(named) && named.startsWith(`${x.data}/`), `${named} is where the backup is now`);
});

test('a backup made under the earlier database name restores, and the restore sets the earlier file aside', async () => {
  const { h, data, before } = await earlierInstall('custom');
  const made = backup({ home: data });
  assert.equal(dump(join(made.dir, 'botons.db')), before, 'a backup of a not yet renamed database');
  renameSync(join(made.dir, 'botons.db'), join(made.dir, 'minions.db'));
  const plan = planRestore({ home: data, backup: made.dir, maxSchema: SCHEMA_VERSION });
  assert.ok(plan.moves.includes('minions.db'));
  const lock = lockDataDir(data);
  try {
    restore(data, plan);
  } finally {
    lock.release();
  }
  assert.equal(dump(join(data, 'botons.db')), before);
  assert.ok(!existsSync(join(data, 'minions.db')), 'only the restored database is left');
  assert.ok(existsSync(join(plan.setAside, 'minions.db')));
  assert.ok(h);
});

test('the migrate:names command moves an install that has no unit and says what it did', async () => {
  const { h } = await earlierInstall();
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    execFile(process.execPath, ['--no-warnings', join(repo, 'scripts/migrate-names.ts')], { env: { PATH: process.env.PATH, HOME: h, XDG_CONFIG_HOME: join(h, '.config') } }, (err, stdout, stderr) => done({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr })),
  );
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Backed up .*\.minions to .*backups/);
  assert.match(out.stdout, /Moved .*\.minions to .*\.botons/);
  assert.ok(existsSync(join(dirname(join(h, '.botons')), '.botons', 'botons.db')));
});

test('the deprecated command names run `botons`, with the deprecated variable names, quietly', async () => {
  const s = await startServer();
  const bot = await s.newBot('Stuart');
  const run = (bin: string) => {
    const turn = s.app.auth.mintBotonToken(bot.id);
    return new Promise<{ stdout: string; stderr: string }>((done, fail) =>
      execFile(join(repo, 'server/bin', bin), ['memory', 'list'], { env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, MINIONS_API: s.base, MINION_BOT_ID: bot.id, MINION_TOKEN: turn.token } }, (err, stdout, stderr) => (err ? fail(new Error(stderr)) : done({ stdout, stderr }))),
    );
  };
  const a = await run('botons');
  const b = await run('legacy/tots');
  const c = await run('legacy/minion');
  assert.equal(c.stdout, a.stdout);
  assert.equal(c.stderr, '');
  assert.equal(a.stdout, b.stdout, 'the earlier variable names work too');
  assert.equal(b.stderr, '');
});

test('the API brains\' shell runs the CLI by any of its names, as one simple command only', () => {
  assert.deepEqual(botonArgv('botons memory list'), ['memory', 'list']);
  assert.deepEqual(botonArgv('tots memory list'), ['memory', 'list']);
  assert.deepEqual(botonArgv('minion memory list'), ['memory', 'list']);
  assert.equal(botonArgv('tots memory list; id'), null);
  assert.equal(botonArgv('totsx memory list'), null);
  assert.equal(botonArgv('botonsx memory list'), null);
});

test('service:install refuses while the service runs under a deprecated unit, naming the command that moves it; with --name it writes that unit', () => {
  const t = tempDir('botons-service-legacy-');
  const units = join(t, 'units');
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, 'tots.service'), '# the unit an earlier install has\n');
  const install = (args: string[]) => execFileSync(process.execPath, [join(repo, 'scripts/install-service.ts'), '--dir', units, '--app', repo, '--env-path', join(t, 'env'), ...args], { env: { HOME: t, PATH: '/usr/bin' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => install([]), (e: any) => /npm run migrate:names/.test(String(e.stderr)));
  assert.ok(!existsSync(join(units, 'botons.service')), 'no second unit for the same data');
  install(['--name', 'botons', '--quiet']);
  assert.ok(existsSync(join(units, 'botons.service')));
});

for (const mode of ['upgrade', 'interrupted', 'repair', 'failed upgrade'] as const) test(`the installer moves an install it made under the earlier names (${mode}): units, release root, data folder and env file; then it upgrades (and rollback puts its record back), repairs it in place, or puts the earlier unit and commands back when the upgrade fails`, async () => {
  const interrupted = mode === 'interrupted';
  const { createServer } = await import('node:http');
  const { cpSync, rmSync } = await import('node:fs');
  const { freePort, noRealClis } = await import('./helpers.ts');
  const home = tempDir('botons-installer-legacy-');
  const bin = join(home, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const runtime = join(home, 'runtime/bin/node');
  mkdirSync(dirname(runtime), { recursive: true });
  writeFileSync(runtime, `#!/bin/sh\ncase "$1" in\n*/npm-cli.js) mkdir -p node_modules/croner; echo ok > node_modules/croner/package.json; exit 0;;\nesac\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  for (const name of ['systemctl', 'loginctl']) writeFileSync(join(bin, name), '#!/bin/sh\necho "$@" >> "$HOME/service-calls"\n[ "$*" = "--user restart botons" ] && [ -f "$HOME/fail-restart" ] && exit 1\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'socat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\necho "bubblewrap 0.11.0"\n', { mode: 0o755 });
  const artifact = (version: string) => {
    const dir = join(home, `artifact-${version}`);
    for (const item of ['installer', 'scripts', 'server', 'shared']) cpSync(join(repo, item), join(dir, item), { recursive: true, filter: (p) => !p.includes('node_modules') && !p.includes('/test') });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version, type: 'module' }));
    mkdirSync(join(dir, 'web/dist'), { recursive: true });
    writeFileSync(join(dir, 'web/dist/index.html'), 'ok');
    return dir;
  };
  const port = await freePort();
  const health = createServer((_req, res) => res.setHeader('Content-Type', 'application/json').end('{}'));
  await new Promise<void>((done) => health.listen(port, '127.0.0.1', done));
  const env: NodeJS.ProcessEnv = { ...process.env, ...noRealClis(home), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, SHELL: '/bin/bash', BOTONS_PORT: String(port), BOTONS_NO_TAILSCALE: '1' };
  for (const k of Object.keys(env)) if (/^(BOTONS|TOTS|MINIONS)_HOME$/.test(k)) delete env[k];
  const install = (args: string[]) =>
    new Promise<{ status: number | null; out: string }>((done) => {
      execFile(process.execPath, [join(repo, 'installer/botons.mjs'), ...args, '--yes', '--no-sudo'], { env, timeout: 90_000 }, (err, stdout, stderr) => done({ status: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }));
    });
  try {
    // An install made by this installer, then given the earlier names it would have had.
    const share = join(home, '.local/share');
    mkdirSync(join(share, 'botons'), { recursive: true });
    writeFileSync(join(share, 'botons', 'installer.json'), JSON.stringify({ data: join(home, '.botons'), node: runtime }));
    let r = await install(['install', '--source', artifact('1.0.0')]);
    assert.equal(r.status, 0, r.out);
    const units = join(home, '.config/systemd/user');
    renameSync(join(share, 'botons'), join(share, 'tots'));
    writeFileSync(join(share, 'tots', 'installer.json'), readFileSync(join(share, 'tots', 'installer.json'), 'utf8').replaceAll(join(share, 'botons'), join(share, 'tots')).replaceAll(join(home, '.botons'), join(home, '.tots')));
    symlinkSync(join(share, 'tots', 'releases', '1.0.0'), join(share, 'tots', 'current.tmp'));
    renameSync(join(share, 'tots', 'current.tmp'), join(share, 'tots', 'current'));
    mkdirSync(join(home, '.tots'), { recursive: true });
    writeFileSync(join(home, '.tots', 'notes.md'), 'kept\n');
    rmSync(join(home, '.botons'), { recursive: true, force: true });
    mkdirSync(join(home, '.config/tots'), { recursive: true });
    writeFileSync(join(home, '.config/tots/env'), readFileSync(join(home, '.config/botons/env'), 'utf8').replaceAll('BOTONS_', 'TOTS_').replaceAll(join(home, '.botons'), join(home, '.tots')));
    rmSync(join(home, '.config/botons'), { recursive: true });
    for (const [from, to] of [['botons.service', 'tots.service'], ['botons-backup.service', 'tots-backup.service'], ['botons-backup.timer', 'tots-backup.timer']]) {
      writeFileSync(join(units, to), readFileSync(join(units, from), 'utf8').replaceAll(join(share, 'botons'), join(share, 'tots')).replaceAll('.config/botons', '.config/tots'));
      rmSync(join(units, from));
    }
    // And the command it put on PATH under the earlier name.
    rmSync(join(home, '.local', 'bin', 'botons'));
    symlinkSync(join(share, 'tots', 'current', 'installer', 'tots.mjs'), join(home, '.local', 'bin', 'tots'));
    // A release made under the earlier name has its installer as installer/tots.mjs.
    for (const ext of ['mjs', 'd.mts']) renameSync(join(share, 'tots', 'releases', '1.0.0', 'installer', `botons.${ext}`), join(share, 'tots', 'releases', '1.0.0', 'installer', `tots.${ext}`));
    writeFileSync(join(home, 'service-calls'), '');
    if (interrupted) {
      // What a stopped run leaves: the root moved with its record, no link at the earlier path, nothing else done.
      writeFileSync(join(share, 'tots', '.name-upgrade-from'), `${join(share, 'tots')}\n`);
      renameSync(join(share, 'tots'), join(share, 'botons'));
    }

    if (mode === 'repair') {
      // In place, on the release it has: the commands run that release's own installer.
      r = await install(['repair']);
      assert.equal(r.status, 0, r.out);
      assert.equal(realpathSync(join(share, 'botons', 'current')), join(share, 'botons', 'releases', '1.0.0'));
      for (const name of ['botons', 'tots']) assert.equal(realpathSync(join(home, '.local', 'bin', name)), join(share, 'botons', 'releases', '1.0.0', 'installer', 'tots.mjs'), name);
      return;
    }
    if (mode === 'failed upgrade') writeFileSync(join(home, 'fail-restart'), '');
    r = await install(['upgrade', '--source', artifact('1.0.1')]);
    if (mode === 'failed upgrade') {
      assert.notEqual(r.status, 0, r.out);
      assert.equal(realpathSync(join(share, 'botons', 'current')), join(share, 'botons', 'releases', '1.0.0'));
      assert.ok(!existsSync(join(home, '.local', 'bin', 'botons')), 'no new command left behind');
      assert.equal(realpathSync(join(home, '.local', 'bin', 'tots')), join(share, 'botons', 'releases', '1.0.0', 'installer', 'tots.mjs'), 'the earlier command works as before');
      assert.ok(readFileSync(join(home, 'service-calls'), 'utf8').includes('--user enable --now tots.service'), 'the earlier unit is started again');
      return;
    }
    assert.equal(r.status, 0, r.out);
    assert.equal(readlinkSync(join(share, 'tots')), 'botons');
    assert.equal(realpathSync(join(share, 'botons', 'current')), join(share, 'botons', 'releases', '1.0.1'));
    assert.equal(readlinkSync(join(home, '.tots')), '.botons');
    assert.equal(readFileSync(join(home, '.botons', 'notes.md'), 'utf8'), 'kept\n');
    assert.equal(JSON.parse(readFileSync(join(share, 'botons', 'installer.json'), 'utf8')).data, join(home, '.botons'));
    const envText = readFileSync(join(home, '.config/botons/env'), 'utf8');
    assert.match(envText, new RegExp(`^BOTONS_HOME="?${join(home, '.botons')}"?$`, 'm'));
    assert.doesNotMatch(envText, /TOTS_/);
    assert.match(readFileSync(join(units, 'botons.service'), 'utf8'), new RegExp(`WorkingDirectory=${join(share, 'botons', 'current')}`));
    const calls = readFileSync(join(home, 'service-calls'), 'utf8');
    for (const call of ['--user stop tots.service', '--user disable tots.service', '--user disable tots-backup.timer', '--user restart botons', '--user enable botons']) assert.ok(calls.includes(call), `${call}\n${calls}`);
    assert.ok(calls.indexOf('--user stop tots.service') < calls.indexOf('--user restart botons'), 'the earlier unit stops first');
    assert.equal(realpathSync(join(home, '.local', 'bin', 'botons')), join(share, 'botons', 'releases', '1.0.1', 'installer', 'botons.mjs'));
    assert.equal(realpathSync(join(home, '.local', 'bin', 'tots')), realpathSync(join(home, '.local', 'bin', 'botons')), 'the earlier command runs the new one, for one release');

    // Rollback: the installer's record names the paths the earlier install has again.
    await rollbackNames({ env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, userHome: home, exec: async () => {} });
    const marker = JSON.parse(readFileSync(join(share, 'tots', 'installer.json'), 'utf8'));
    assert.equal(marker.data, join(home, '.tots'));
    for (const v of Object.values(marker)) if (typeof v === 'string' && v.startsWith('/')) assert.ok(existsSync(v), `${v} exists`);
    // And the earlier unit's entry point and the command on PATH resolve, so both run again.
    const unitText = readFileSync(join(units, 'tots.service'), 'utf8');
    const entry = /^ExecStart="[^"]+" "([^"]+)"$/m.exec(unitText)![1];
    assert.ok(existsSync(entry), `${entry} exists`);
    assert.ok(existsSync(join(home, '.local', 'bin', 'tots')), 'the command resolves');
    assert.ok(realpathSync(join(home, '.local', 'bin', 'tots')).startsWith(`${join(share, 'tots')}/`));
  } finally {
    health.close();
  }
});

test('a release root move that stopped before its link is finished by the next run, and the service move goes on', async () => {
  const x = await earlierService();
  const share = join(x.h, '.local', 'share');
  // As if it stopped right after the rename: the record inside it, no link at the earlier path.
  writeFileSync(join(share, 'minions', '.name-upgrade-from'), `${join(share, 'minions')}\n`);
  renameSync(join(share, 'minions'), join(share, 'botons'));
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  assert.equal(readlinkSync(join(share, 'minions')), 'botons');
  assert.match(readFileSync(join(x.units, 'botons.service'), 'utf8'), new RegExp(`WorkingDirectory=${join(share, 'botons', 'current')}`));
  await rollbackNames({ env: x.env, userHome: x.h, exec: x.exec });
  assert.ok(lstatSync(join(share, 'minions')).isDirectory() && !lstatSync(join(share, 'minions')).isSymbolicLink(), 'rollback moves it back from its own record');
  assert.ok(!existsSync(join(share, 'minions', '.name-upgrade-from')));
});

test("undo and rollback find a data folder that only the service's env file names", async () => {
  const x = await earlierService();
  const custom = join(x.h, 'srv-data');
  renameSync(x.data, custom);
  writeFileSync(join(x.config, 'minions', 'env'), x.envText.replace(`MINIONS_HOME=${x.data}`, `MINIONS_HOME=${custom}`));
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec, start: false });
  x.calls.length = 0;
  await undoService({ env: x.env, userHome: x.h, exec: x.exec });
  assert.ok(x.calls.includes('systemctl --user enable --now minions.service'), x.calls.join('\n'));
  assert.ok(!existsSync(join(x.units, 'botons.service')));
  await upgradeService({ env: x.env, userHome: x.h, exec: x.exec });
  x.calls.length = 0;
  await rollbackNames({ env: x.env, userHome: x.h, exec: x.exec });
  assert.ok(x.calls.includes('systemctl --user enable --now minions.service'), x.calls.join('\n'));
  assert.ok(existsSync(join(custom, 'minions.db')) && !lstatSync(join(custom, 'minions.db')).isSymbolicLink());
  assert.ok(!existsSync(join(x.units, 'botons.service')));
});

test("a saved template's browser connector under its earlier id reads as the browser's; any other connector keeps its name", async () => {
  const s = await startServer();
  try {
    mkdirSync(s.cfg.templatesDir, { recursive: true });
    writeFileSync(join(s.cfg.templatesDir, 'tpl_old00000.json'), JSON.stringify({ name: 'Researcher', description: '', bot: { name: 'Kevin', connections: ['lib:minions_browser', 'lib:minion', 'lib:wiki'] }, routines: [] }));
    const all = (await s.call('GET', '/api/templates')).data as { id: string; bot: { connections: string[] } }[];
    assert.deepEqual(all.find((t) => t.id === 'tpl_old00000')?.bot.connections, ['lib:botons_browser', 'lib:minion', 'lib:wiki']);
  } finally {
    await s.stop();
  }
});
