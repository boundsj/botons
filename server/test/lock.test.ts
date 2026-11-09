import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { type App, createApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { DataDirInUseError, lockDataDir } from '../src/lock.ts';
import { freePort, noRealClis, tempDir } from './helpers.ts';

const here = import.meta.dirname;

async function tmpConfig(env: Record<string, string> = {}): Promise<Config> {
  const home = tempDir('botons-lock-test-');
  const cfg = loadConfig({ BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(await freePort()), BOTONS_ENABLE_MOCK: '1', ...env });
  cfg.webDist = join(home, 'no-web-dist');
  return cfg;
}

/** A queued run and one still marked running, as a server that died mid-turn leaves them. */
function seedRuns(app: App) {
  const bot = app.store.createBot({ name: 'Stuart', provider: 'mock' }, new Set(['mock']), 'mock');
  const routine = app.store.createRoutine(bot.id, { name: 'Report', instruction: 'Report' });
  const queued = app.store.createRun(routine, 'manual', null);
  const running = app.store.createRun(routine, 'manual', null);
  app.store.updateRun(running.id, { status: 'running' });
  return { routine, queued, running };
}

/** Every row of every table. */
function snapshot(cfg: Config): Record<string, Record<string, unknown>[]> {
  const db = new DatabaseSync(cfg.dbPath);
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all();
    return Object.fromEntries(tables.map(({ name }) => [String(name), db.prepare(`select * from "${name}" order by rowid`).all().map((r) => ({ ...r }))]));
  } finally {
    db.close();
  }
}

/** `node server/src/index.ts` on cfg's data dir, until it exits. */
function runServer(cfg: Config): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [join(here, '../src/index.ts')], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT' && !k.startsWith('BOTONS_'))),
      BOTONS_HOME: cfg.home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(cfg.port), BOTONS_NO_TAILSCALE: '1', ...noRealClis(cfg.home),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise((resolve) =>
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    }),
  );
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test('one server per data dir: a second one, here or in another process, refuses before it opens the database', async () => {
  const cfg = await tmpConfig();
  const pidFile = join(cfg.home, 'server.pid');
  const first = createApp(cfg);
  const { running } = seedRuns(first);
  assert.equal(readFileSync(pidFile, 'utf8').trim(), String(process.pid));
  assert.deepEqual(readdirSync(cfg.home).filter((n) => n.startsWith('server.')).sort(), ['server.lock', 'server.pid']);
  assert.throws(
    () => createApp(cfg),
    (err: unknown) => err instanceof DataDirInUseError && err.message.includes(`data dir in use: another Botons server (pid ${process.pid}) is using ${cfg.home}`),
  );
  assert.throws(() => lockDataDir(cfg.home), DataDirInUseError);
  assert.equal(first.store.listBots().length, 1, "the refused app left the first one's database open");

  // createApp purges Boton tokens, so a second server that opened the database would change this.
  first.auth.mintBotonToken(first.store.listBots()[0].id);
  const before = snapshot(cfg);
  assert.equal(before.auth_tokens.length, 1);
  const second = await runServer(cfg);
  assert.equal(second.code, 1, second.stdout);
  assert.match(second.stdout, new RegExp(`data dir in use.*pid ${process.pid}\\b`));
  assert.doesNotMatch(second.stdout, /is running/);
  assert.deepEqual(snapshot(cfg), before);

  await first.close();
  assert.equal(existsSync(pidFile), false);
  // Free again: the next server fails the run the last one left running.
  const app = createApp(cfg);
  try {
    await app.listen();
    const run = app.store.getRun(running.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'Interrupted by a restart');
  } finally {
    await app.close();
  }
});

test('a server killed without cleaning up leaves no stale lock', async () => {
  const cfg = await tmpConfig();
  const lockModule = pathToFileURL(join(here, '../src/lock.ts')).href;
  const holder = spawn(
    process.execPath,
    // It drops the lock's handle and collects garbage: the lock holds until the process dies.
    ['--expose-gc', '--input-type=module', '-e', `const { lockDataDir } = await import(${JSON.stringify(lockModule)}); lockDataDir(${JSON.stringify(cfg.home)}); globalThis.gc(); console.log('locked'); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise<void>((resolve) => holder.on('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.setEncoding('utf8').on('data', (d: string) => d.includes('locked') && resolve());
      holder.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
    });
    assert.throws(() => lockDataDir(cfg.home), (err: unknown) => err instanceof DataDirInUseError && err.message.includes(`(pid ${holder.pid})`));
  } finally {
    holder.kill('SIGKILL');
    await exited;
  }
  // Its server.pid still names the dead process; the lock went with it.
  assert.equal(readFileSync(join(cfg.home, 'server.pid'), 'utf8').trim(), String(holder.pid));
  const lock = lockDataDir(cfg.home);
  assert.equal(readFileSync(join(cfg.home, 'server.pid'), 'utf8').trim(), String(process.pid));
  lock.release();
});

test('a server that cannot bind leaves queued and running runs alone and closes the listeners it opened', async () => {
  const port = await freePort(['127.0.0.1', '127.0.0.2']);
  // Block 127.0.0.2 so the 127.0.0.1 listener binds first; hosts without 127.0.0.2 (macOS) block 127.0.0.1.
  const blocker = createServer();
  let twoHosts = true;
  try {
    await listen(blocker, port, '127.0.0.2');
  } catch {
    twoHosts = false;
    await listen(blocker, port, '127.0.0.1');
  }
  const cfg = await tmpConfig({ BOTONS_PORT: String(port), BOTONS_HOST: twoHosts ? '127.0.0.1,127.0.0.2' : '127.0.0.1' });
  try {
    const seed = createApp(cfg);
    const { routine, queued, running } = seedRuns(seed);
    await seed.close();

    const app = createApp(cfg);
    await assert.rejects(app.listen(), { code: 'EADDRINUSE' });
    assert.equal(app.store.getRun(queued.id).status, 'queued');
    assert.equal(app.store.getRun(running.id).status, 'running');
    assert.equal(app.store.getRoutine(routine.id).lastStatus, 'running');
    if (twoHosts) {
      const probe = createServer();
      await listen(probe, port, '127.0.0.1');
      await close(probe);
    }
    await app.close();
    assert.equal(snapshot(cfg).routine_runs.find((r) => r.id === running.id)!.status, 'running');
  } finally {
    await close(blocker);
  }
});
