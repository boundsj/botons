import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectorJail, type Launch, type LaunchPolicy, launchPlan, namedProblem, release as releaseFiles, TEMP_DIRS } from '../src/connector-launch.ts';
import { Connectors } from '../src/connectors.ts';
import { parseMountTable, placeOf, sandboxBinary, useMountTable, useSandboxBinary, viewOf } from '../src/sandbox.ts';
import { openSchema } from '../src/schema.ts';
import { tempDir } from './helpers.ts';

const bwrap = sandboxBinary();
const noBwrap = 'problem' in bwrap ? `bubblewrap can't run here: ${bwrap.problem}` : false;

/**
 * A data folder outside the temporary folders (which are kept apart whole), so what is checked is the workspace and
 * the shared folder being out of view, not /tmp: in the repository's own node_modules/.cache, removed afterwards.
 */
function outsideTemp(): { home: string; ws: string; shared: string; tools: string; policy: LaunchPolicy; done: () => void } {
  const cache = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const root = realpathSync(mkdtempSync(join(cache, 'botons-connector-jail-')));
  const home = join(root, 'botons');
  const ws = join(home, 'workspaces', 'kevin');
  const shared = join(home, 'shared');
  // The owner's own MCP server, outside the data folder.
  const tools = join(root, 'owner-mcp');
  const dir = join(home, 'run', 'connectors');
  for (const d of [ws, shared, tools]) mkdirSync(d, { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const policy: LaunchPolicy = { apart: [home, join(home, 'workspaces'), shared, ws], hidden: [], dir };
  return { home, ws, shared, tools, policy, done: () => rmSync(root, { recursive: true, force: true }) };
}

const wrap = (policy: LaunchPolicy, command: string, args: string[], env: Record<string, string> = {}): Launch => {
  const jail = connectorJail(policy);
  assert.ok('wrap' in jail, 'problem' in jail ? jail.problem : '');
  const w = jail.wrap({ command, args, env });
  assert.ok(!('problem' in w), 'problem' in w ? w.problem : '');
  return w as Launch;
};

const run = (w: Launch, env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }) => {
  const r = spawnSync(w.command, w.args, { env, encoding: 'utf8', timeout: 20_000 });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status, stdout: r.stdout };
};

/** Each line of this machine's mount table, then `extra` on top. */
const mountsWith = (...extra: string[]) => `${readFileSync('/proc/self/mountinfo', 'utf8').trimEnd()}\n${extra.join('\n')}\n`;

test('a place is its filesystem and its path there: a second mount of a folder is the same place', () => {
  const table = parseMountTable(['22 1 0:29 /@ / rw - btrfs x rw', '23 22 0:29 /@home /home rw - btrfs x rw', '24 22 0:29 /@home/you/botons/workspaces /opt/w\\040s rw - btrfs x rw'].join('\n'));
  assert.deepEqual(table.at(-1), { dev: '0:29', root: '/@home/you/botons/workspaces', at: '/opt/w s' });
  assert.deepEqual(placeOf('/home/you/botons/workspaces/kevin', table), { dev: '0:29', path: '/@home/you/botons/workspaces/kevin' });
  assert.deepEqual(placeOf('/opt/w s/kevin', table), { dev: '0:29', path: '/@home/you/botons/workspaces/kevin' });
  assert.deepEqual(placeOf('/usr/bin', table), { dev: '0:29', path: '/@/usr/bin' });
});

/**
 * A bind mount shows a workspace at a second path no realpath leads back from: by path, the folder looks like any
 * other. Here the mount table says the owner's tools folder is a second mount of the workspace (as `mount --bind`
 * would make it), and the Boton's hook there never becomes something a connector can load.
 */
test('a folder that is a second mount of a workspace is never shown, by its own path or as a named one', { skip: noBwrap }, () => {
  const { ws, tools, policy, done } = outsideTemp();
  try {
    writeFileSync(join(tools, 'hook.mjs'), 'console.log("HOOK-RAN")\n');
    const fsPlace = (p: string) => placeOf(p, parseMountTable(readFileSync('/proc/self/mountinfo', 'utf8')))!;
    const w = fsPlace(ws);
    // The tools folder, mounted again (on top) as the workspace's filesystem at the workspace's place.
    useMountTable(mountsWith(`999 1 ${w.dev} ${w.path} ${tools} rw - fake fake rw`));
    const plan = launchPlan(policy, { command: process.execPath, args: [`--import=file://${tools}/hook.mjs`, join(tools, 'hook.mjs')], env: {} });
    assert.ok(viewOf(plan).unshown.includes(tools), 'left out of the view');
    assert.match(namedProblem(plan) ?? '', /can't be shown to it/);
    const jail = connectorJail(policy);
    assert.ok('wrap' in jail);
    assert.match(String((jail.wrap({ command: process.execPath, args: [join(tools, 'hook.mjs')], env: {} }) as { problem: string }).problem), /owner-mcp \(named by its command\) can't be shown/);
    // Started without naming it, the alias isn't in its view either: what the Boton wrote there never loads.
    const quiet = wrap(policy, process.execPath, [`--import=file://${tools}/hook.mjs`, '-e', 'console.log("MAIN-RAN")']);
    const got = run(quiet);
    assert.doesNotMatch(got.out, /HOOK-RAN/);
    assert.notEqual(got.status, 0, got.out);
  } finally {
    useMountTable(undefined);
    done();
  }
});

test('a folder that holds a second mount of a workspace is shown with that place hidden', () => {
  const { ws, tools, policy, done } = outsideTemp();
  try {
    writeFileSync(join(tools, 'server.mjs'), '');
    const t = placeOf(tools, parseMountTable(readFileSync('/proc/self/mountinfo', 'utf8')))!;
    // The workspace is, by its filesystem, a folder inside the tools folder.
    useMountTable(mountsWith(`998 1 ${t.dev} ${t.path} ${tools} rw - fake fake rw`, `999 1 ${t.dev} ${join(t.path, 'inner')} ${ws} rw - fake fake rw`));
    const plan = launchPlan(policy, { command: process.execPath, args: [join(tools, 'server.mjs')], env: {} });
    assert.deepEqual(viewOf(plan).masked, [join(tools, 'inner')]);
    assert.match(namedProblem(plan) ?? '', /can't be shown to it/, 'a named folder holding one is refused');
    // And without a mount table, nothing is shown: no local connector starts.
    useMountTable(null);
    assert.deepEqual(viewOf(launchPlan(policy, { command: 'x', args: [], env: {} })).trees.filter((x) => !x.link), []);
    const jail = connectorJail(policy);
    assert.ok('problem' in jail && /mount table/.test(jail.problem));
  } finally {
    useMountTable(undefined);
    done();
  }
});

/**
 * A Workspace Boton rewrites the script a connector runs from the shared folder (or its workspace); a Full computer
 * Boton's turn starting that connector would run the rewrite with the server's access. Whichever turn starts it, a
 * named script there is refused, and one reached any other way isn't in its view.
 */
test("a connector's script in the shared folder or a workspace is refused, and found by no other path", { skip: noBwrap }, () => {
  const { ws, shared, policy, done } = outsideTemp();
  try {
    writeFileSync(join(shared, 'server.mjs'), 'console.log("SHARED-RAN")\n');
    writeFileSync(join(ws, 'id'), '#!/bin/sh\necho EVIL-RAN\n');
    chmodSync(join(ws, 'id'), 0o755);
    const jail = connectorJail(policy);
    assert.ok('wrap' in jail);
    for (const p of [join(shared, 'server.mjs'), shared, join(ws, 'id')]) {
      const w = jail.wrap({ command: process.execPath, args: [p], env: {} });
      assert.ok('problem' in w && /can't be shown to it/.test(w.problem), p);
    }
    // By an encoded file URL, a relative PATH entry, its PATH, NODE_OPTIONS: nothing of theirs is there.
    const url = `file://${shared.replace(/\/shared$/, '/%73hared')}/server.mjs`;
    assert.doesNotMatch(run(wrap(policy, process.execPath, [`--import=${url}`, '-e', '1'])).out, /SHARED-RAN/);
    const viaEnv = wrap(policy, process.execPath, ['-e', '1'], { NODE_OPTIONS: `--import=${join(shared, 'server.mjs')}` });
    assert.doesNotMatch(run(viaEnv).out, /SHARED-RAN/);
    const viaPath = wrap(policy, '/bin/sh', ['-c', 'exec id'], { PATH: `${ws}:../workspaces/kevin:/usr/bin:/bin` });
    const got = run(viaPath);
    assert.doesNotMatch(got.out, /EVIL-RAN/);
    assert.match(got.out, /uid=/, 'the system one runs instead');
  } finally {
    done();
  }
});

test("a connector sees the system's programs, the folders it names and its own /tmp, never the data folder or a home folder", { skip: noBwrap }, () => {
  const { home, ws, tools, policy, done } = outsideTemp();
  try {
    writeFileSync(join(tools, 'server.mjs'), `import fs from 'node:fs';
const see = (p) => { try { return fs.readdirSync(p).length; } catch (e) { return e.code; } };
console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, secret: process.env.NOTES_TOKEN, ws: see(${JSON.stringify(ws)}), data: see(${JSON.stringify(home)}), tmp: see('/tmp'), usr: typeof see('/usr/bin'), pids: fs.readdirSync('/proc').filter((n) => /^\\d+$/.test(n)).length, w: (() => { try { fs.writeFileSync(${JSON.stringify(join(tools, 'x'))}, 'x'); return 'wrote'; } catch (e) { return e.code; } })() }));
`);
    writeFileSync(join(ws, 'notes.md'), 'BOT');
    const w = wrap(policy, process.execPath, [join(tools, 'server.mjs')], { NOTES_TOKEN: 'right-secret-value' });
    const got = run(w);
    assert.equal(got.status, 0, got.out);
    const seen = JSON.parse(got.stdout);
    assert.deepEqual(seen, { cwd: '/tmp', home: '/tmp', secret: 'right-secret-value', ws: 'ENOENT', data: 'ENOENT', tmp: 0, usr: 'number', pids: seen.pids, w: 'EROFS' });
    assert.ok(seen.pids < 5, `its own processes only (${seen.pids})`);
    // Its secret is in the launch file only: not on any command line, not in what starts bubblewrap.
    assert.ok(!w.args.join(' ').includes('right-secret-value'));
    assert.deepEqual(w.env, {});
    assert.deepEqual(w.secrets, ['right-secret-value']);
    assert.equal(statSync(w.file).mode & 0o777, 0o600);
    assert.ok(readFileSync(w.file, 'utf8').includes('NOTES_TOKEN\0right-secret-value\0'));
  } finally {
    done();
  }
});

test('a command saved as a link starts by that path: the link’s folder and its target’s are both shown', { skip: noBwrap }, () => {
  const { tools, policy, done } = outsideTemp();
  try {
    const bin = join(dirname(tools), 'owner-bin');
    mkdirSync(bin);
    writeFileSync(join(tools, 'server.sh'), '#!/bin/sh\necho LINKED-RAN\n');
    chmodSync(join(tools, 'server.sh'), 0o755);
    symlinkSync(join(tools, 'server.sh'), join(bin, 'server'));
    assert.match(run(wrap(policy, join(bin, 'server'), [])).out, /LINKED-RAN/);
  } finally {
    done();
  }
});

test("without bubblewrap no local connector starts, and it says why", () => {
  useSandboxBinary('/nonexistent/bwrap');
  try {
    const jail = connectorJail({ apart: [], hidden: [], dir: tmpdir() });
    assert.ok('problem' in jail);
    assert.match(jail.problem, /starts only in the Workspace sandbox, which can't run here/);
    assert.match(jail.problem, /not installed/);
  } finally {
    useSandboxBinary('bwrap');
  }
});

test('the temporary folders are always kept apart, and every connector shares the view, whatever the turn', () => {
  const plan = launchPlan({ apart: ['/srv/botons'], hidden: [], dir: tmpdir() }, { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'x' } });
  for (const t of TEMP_DIRS) assert.ok(plan.apart!.includes(t), t);
  assert.equal(plan.network, true);
  assert.deepEqual(plan.writable, []);
  assert.equal(plan.cwd, '/tmp');
  assert.equal(plan.env.GITHUB_TOKEN, 'x');
  assert.equal(plan.env.HOME, '/tmp');
});

/**
 * Connectors.resolve() is what every turn's servers come from: a library command is wrapped, or left out with why,
 * never passed as saved; Botons' own launch files are removed with release().
 */
test("resolve() never hands out a library command as saved: wrapped in the sandbox, or left out with why", { skip: noBwrap }, async () => {
  const { policy, tools, done } = outsideTemp();
  const home = tempDir('botons-connector-resolve-');
  try {
    const db = new DatabaseSync(':memory:');
    openSchema(db);
    const c = new Connectors(db, { home, providers: { ids: () => [], get: () => undefined } as never, store: { atomically: (fn: () => unknown) => fn(), dropFromBots: () => {} } as never });
    c.createServer({ name: 'notes', transport: 'stdio', command: process.execPath, args: [join(tools, 'server.mjs')], env: { NOTES_TOKEN: 'right-secret-value' } });
    const cli = { cli: 'claude' } as never;
    const none = await c.resolve(['lib:notes'], cli);
    assert.deepEqual(none.servers, []);
    assert.match(none.skipped[0]!.reason, /not started: a local connector starts only in the Workspace sandbox/);
    const got = await c.resolve(['lib:notes'], cli, { launch: { ...policy, dir: c.launchDir } });
    const s = got.servers[0]!;
    assert.ok(s.kind === 'stdio');
    assert.equal(s.command, '/bin/sh');
    assert.deepEqual(s.env, {});
    assert.deepEqual(s.secrets, ['right-secret-value']);
    assert.deepEqual(s.args.slice(-2), [process.execPath, join(tools, 'server.mjs')]);
    assert.equal(got.launchFiles!.length, 1);
    assert.ok(existsSync(got.launchFiles![0]!));
    c.release(got);
    assert.deepEqual(readdirSync(c.launchDir).filter((f) => f.startsWith('launch-')), []);
  } finally {
    done();
  }
});

/**
 * A launch file is removed whatever stops a turn's connectors being set up: one written in part, or those written
 * before another connector or fitting them to the CLI throws. The error that stopped it is the one that goes on.
 */
const launchFiles = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('launch-'));

/** Runs `fn` with node:fs's writeFileSync failing, as a full disk would, whenever `fails(n)` says so for its nth call on a descriptor. */
async function withFailingWrites<T>(fails: (n: number) => boolean, fn: () => Promise<T> | T): Promise<T> {
  const original = fs.writeFileSync;
  let n = 0;
  fs.writeFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'number' && fails(++n)) {
      // Part of it reaches the file first.
      fs.writeSync(file, 'partial\0');
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return (original as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
  }
}

const resolveSetup = () => {
  const { policy, tools, done } = outsideTemp();
  const home = tempDir('botons-connector-release-');
  const db = new DatabaseSync(':memory:');
  openSchema(db);
  const c = new Connectors(db, { home, providers: { ids: () => [], get: () => undefined } as never, store: { atomically: (fn: () => unknown) => fn(), dropFromBots: () => {} } as never });
  for (const name of ['notes', 'tasks']) c.createServer({ name, transport: 'stdio', command: process.execPath, args: [join(tools, `${name}.mjs`)] });
  return { c, launch: { ...policy, dir: c.launchDir }, done };
};

test('a launch file that fails part way is removed, and its error goes on', { skip: noBwrap }, async () => {
  const { policy, tools, done } = outsideTemp();
  try {
    const jail = connectorJail(policy);
    assert.ok('wrap' in jail);
    await withFailingWrites(
      () => true,
      () => assert.throws(() => jail.wrap({ command: process.execPath, args: [join(tools, 'server.mjs')], env: {} }), { code: 'ENOSPC' }),
    );
    assert.deepEqual(launchFiles(policy.dir), []);
  } finally {
    done();
  }
});

test("resolve() that throws after writing launch files removes every one: a later connector's, or fitting them to the CLI", { skip: noBwrap }, async () => {
  const { c, launch, done } = resolveSetup();
  try {
    // The second connector's launch file fails after the first one's was written.
    await withFailingWrites(
      (n) => n === 2,
      () => assert.rejects(c.resolve(['lib:notes', 'lib:tasks'], { cli: 'claude' } as never, { launch }), { code: 'ENOSPC' }),
    );
    assert.deepEqual(launchFiles(c.launchDir), []);
    // Both written, then the CLI's fitting throws.
    const fit = new Error('could not fit them');
    await assert.rejects(c.resolve(['lib:notes', 'lib:tasks'], { cli: 'claude', fitMcpServers: () => { throw fit; } } as never, { launch }), (err) => err === fit);
    assert.deepEqual(launchFiles(c.launchDir), []);
  } finally {
    done();
  }
});

test('releasing tries every launch file and never hides the error it runs after', { skip: noBwrap }, async () => {
  const { c, launch, done } = resolveSetup();
  try {
    const got = await c.resolve(['lib:notes', 'lib:tasks'], { cli: 'claude' } as never, { launch });
    const files = got.launchFiles!;
    assert.equal(files.length, 2);
    // The first can't be removed (a folder in its place): the second still is, and the first error is the one thrown.
    rmSync(files[0]!);
    mkdirSync(join(files[0]!, 'held'), { recursive: true });
    assert.throws(() => releaseFiles(files), (err: NodeJS.ErrnoException) => typeof err.code === 'string');
    assert.ok(!existsSync(files[1]!));
    // Connectors.release() logs one it can't remove rather than throw over the turn's own error.
    const again = { launchFiles: [files[0]!] };
    assert.doesNotThrow(() => c.release(again));
    assert.deepEqual(again.launchFiles, []);
  } finally {
    done();
  }
});
