import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { Bot, Message, SpendingView } from '../../shared/types.ts';
import { captureLogs } from '../src/log.ts';
import { cleanResult, cleanTools } from '../src/mcp-client.ts';
import { StdioMcp } from '../src/providers/mcp-stdio.ts';
import { REQUEST_MAX_BYTES } from '../src/providers/api-brain.ts';
import { fitRequest, type HistoryItem } from '../src/providers/api-history.ts';
import { anthropicWire, openaiUsage, openaiWire, SecretInAnswer, type Scrub } from '../src/providers/api-wire.ts';
import { rateFor } from '../src/rates.ts';
import { parseMountinfo, runProcess, sandboxProblem, seccompFilter, useSandboxBinary, viewOf } from '../src/sandbox.ts';
import { Spending } from '../src/spend.ts';
import { type FakeModelApi, fakeModelApi, type Recorded } from './fixtures/fake-model-api.ts';
import { failOnEscapedErrors, freePort, startServer, tempDir, type TestServer, until } from './helpers.ts';

/*
 * What an API-key Boton must never do, each found by trying: reach another program through a Unix socket from its
 * sandbox; spend past a cap that changed during its turn, or count a request on the wrong day; send a request with a
 * key that was removed or replaced, or let any key into what it keeps or sends; pass a connector's secret on through
 * its structured result or its tool list; send a request past its byte bound; take a usage report it can't trust.
 */

failOnEscapedErrors();

const ANTHROPIC_KEY = 'sk-ant-fake.bob.test.0123456789.kevin';
const OPENAI_KEY = 'sk-fake.stuart.test.0123456789.dave';
const NEW_KEY = 'sk-ant-fake.otto.rotated.5551234567.tim';
const fakes: FakeModelApi[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

async function server(o: { env?: Record<string, string>; keys?: Record<string, string>; clock?: () => Date } = {}): Promise<{ s: TestServer; fake: FakeModelApi }> {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const s = await startServer({
    env: o.env,
    appOptions: {
      apiKeys: { env: o.keys ?? { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY }, testEndpoints: { anthropic: fake.origin, openai: fake.origin } },
      ...(o.clock ? { spendClock: o.clock } : {}),
    },
  });
  return { s, fake };
}

const reply = async (s: TestServer, bot: Bot, text: string) => (await s.chat(bot.id, text)) as Message;

function toolResults(r: Recorded): string[] {
  if (r.path.startsWith('/v1/messages')) return r.body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).flatMap((b: any) => (b.type === 'tool_result' ? [String(b.content)] : []));
  return r.body.input.flatMap((i: any) => (i.type === 'function_call_output' ? [String(i.output)] : []));
}

/**
 * Everything a Boton's turn left behind: every table but the owner's own settings (the saved key's row) and connector
 * setup (its saved headers), its sessions, its log.
 */
function leftBehind(s: TestServer, logs: string): string {
  const db = s.app.store.db;
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not in ('settings', 'mcp_servers')").all() as { name: string }[]).map((t) => t.name);
  const rows = tables.map((t) => JSON.stringify(db.prepare(`select * from "${t}"`).all()));
  const dir = join(s.home, 'api-sessions');
  const sessions = existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : [];
  return [...rows, ...sessions, logs].join('\n');
}

const BRAINS = [
  { provider: 'anthropic-api', model: 'claude-sonnet-5-5', key: ANTHROPIC_KEY },
  { provider: 'openai-api', model: 'gpt-6.1-sol', key: OPENAI_KEY },
] as const;

// ------------------------------------------------------------------ R1: the sandbox and Unix sockets

test('Workspace sandbox: no named pipe, Unix socket or loopback service of another program is reachable, even where the sandbox sees it; ordinary commands still run', async (t) => {
  const problem = sandboxProblem();
  if (problem) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${problem}`);
    t.skip(problem);
    return;
  }
  // Outside the workspace, and in what the sandbox shows (a folder on its PATH): a pipe, a socket and a file of a
  // program on the host, which must get nothing from it.
  const dir = join(process.env.HOME ?? '/root', `.botons-ipc-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  const protectedFile = join(dir, 'protected.txt');
  writeFileSync(protectedFile, 'original');
  // And a folder of the test's own in the home folder that nothing shows (not on PATH, not the workspace): it must not
  // be there at all, nor readable, nor writable.
  const home = process.env.HOME ?? '/root';
  const canary = join(home, `.botons-home-canary-${process.pid}-${Date.now()}`);
  mkdirSync(canary);
  writeFileSync(join(canary, 'secret.txt'), 'HOME-CANARY');
  t.after(() => rmSync(canary, { recursive: true, force: true }));
  const fifo = join(dir, 'control.fifo');
  assert.equal(spawnSync('mkfifo', ['-m', '666', fifo]).status, 0);
  // A host reader that never waits: anything written to the pipe from anywhere lands here.
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  // And a host writer: anything the sandbox reads from the pipe would be taken from it.
  const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  writeSync(writer, 'host-data\n');
  t.after(() => {
    closeSync(reader);
    closeSync(writer);
  });
  let calls = 0;
  const control = createNetServer((c) => {
    calls++;
    writeFileSync(protectedFile, 'modified');
    c.end('done');
  });
  const sock = join(dir, 'control.sock');
  await new Promise<void>((r) => control.listen(sock, r));
  chmodSync(sock, 0o777);
  const abstractName = `botons-abstract-${process.pid}`;
  const abstract = createNetServer(() => calls++);
  await new Promise<void>((r) => abstract.listen(`\0${abstractName}`, r));
  const tcp = createNetServer((c) => {
    calls++;
    c.end();
  });
  const tcpPort = await freePort();
  await new Promise<void>((r) => tcp.listen(tcpPort, '127.0.0.1', r));
  t.after(() => {
    control.close();
    abstract.close();
    tcp.close();
  });

  const { s, fake } = await server();
  const bot = await s.newBot('Dave', { provider: 'anthropic-api', model: 'claude-sonnet-5-5' });
  const connect = (target: string) => `node -e "require('net').connect(${JSON.stringify(target).replace(/"/g, "'")}).on('connect',()=>console.log('CONNECTED')).on('error',(e)=>console.log('refused',e.code))"`;
  const pipeProbe = (write: boolean) => {
    const child = write
      ? `require('fs').writeFileSync(${JSON.stringify(fifo)}, 'blocking-write')`
      : `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fifo)}, 'utf8'))`;
    const program = `const r = require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}], {timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8'}); process.stdout.write(r.stdout ?? ''); console.log('${write ? 'write' : 'read'}-exit', r.error?.code ?? r.status, r.signal);`;
    return `node -e '${program.replaceAll("'", "'\\''")}'`;
  };
  const commands = [
    `test -p ${fifo} && echo visible; exec 3<>${fifo} && echo sandbox-data >&3 && echo wrote`,
    pipeProbe(false),
    pipeProbe(true),
    connect(sock),
    `ln -s ${sock} via-link.sock && ${connect('via-link.sock')}`,
    `ln ${sock} hard.sock 2>&1 || echo no-hardlink; ln ${fifo} hard.fifo 2>&1 || echo no-hardlink`,
    `node -e "require('net').connect('\\0${abstractName}').on('connect',()=>console.log('CONNECTED')).on('error',(e)=>console.log('refused',e.code))"`,
    `node -e "require('net').connect(${tcpPort},'127.0.0.1').on('connect',()=>console.log('CONNECTED')).on('error',(e)=>console.log('refused',e.code))"`,
    `echo modified > ${protectedFile}; cat ${protectedFile}; echo; echo home:; ls -A ${home}; echo :home; cat ${canary}/secret.txt; echo x > ${canary}/new.txt; test -e ${canary} && echo canary-there || echo canary-absent`,
    `while read -r k v; do case "$k" in Seccomp:|NoNewPrivs:) echo "$k$v";; esac; done < /proc/self/status; ls /proc/self/fd | tr '\\n' ' '`,
    // Ordinary work: a repository, a child process of Node (a socketpair), loopback TCP in its own network, a pipe of its own.
    `export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; git init -q repo && cd repo && git -c user.name=Sam -c user.email=sam@example.com commit -q --allow-empty -m first && git log --oneline | wc -l`,
    `node -e "console.log(require('child_process').execFileSync('/bin/echo',['child ok']).toString().trim())"`,
    `node -e "const n=require('net');const s=n.createServer(c=>c.end('pong')).listen(0,'127.0.0.1',()=>n.connect(s.address().port,'127.0.0.1').on('data',d=>{console.log(String(d));process.exit(0)}))"`,
    `mkfifo own.fifo && (echo through-own > own.fifo &) && cat own.fifo`,
  ];
  fake.queue({ calls: commands.map((command) => ({ name: 'shell', input: { command } })) }, { text: 'Tried.' });
  const m = await reply(s, bot, 'Reach the programs outside');
  assert.equal(m.text, 'Tried.', m.text);
  const [fifoWrite, fifoRead, fifoBlocking, path_, link, hard, abs, loop, file, status, git, child, tcpInside, ownFifo] = toolResults(fake.requests[1]);
  assert.match(fifoWrite, /visible\nwrote/, `the pipe is there, and its write goes only to the overlay's own: ${fifoWrite}`);
  assert.doesNotMatch(fifoRead, /host-data/, fifoRead);
  assert.match(fifoRead, /read-exit ETIMEDOUT SIGKILL/, fifoRead);
  assert.match(fifoBlocking, /write-exit ETIMEDOUT SIGKILL/, fifoBlocking);
  for (const r of [path_, link, abs, loop]) assert.doesNotMatch(r, /CONNECTED/, r);
  assert.match(path_, /refused EPERM/);
  assert.match(abs, /refused EPERM/);
  assert.match(loop, /refused ECONNREFUSED/, `the host's loopback isn't in its network: ${loop}`);
  assert.match(hard, /no-hardlink[\s\S]*no-hardlink/, hard);
  // The folder on its PATH is shown, read-only: the file there is as it was, and can't be changed.
  assert.match(file, new RegExp(`${protectedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Read-only file system`), file);
  assert.match(file, /stdout:\noriginal\n/, file);
  // The home folder holds only the way down to what the sandbox shows: the first folder, under it, of each tree on
  // the sandbox's PATH, Node's install and the workspace (which of them are there depends on the machine). Nothing else
  // of it is there, so the test's own folder that nothing shows isn't.
  const under = (p: string) => {
    let r: string;
    try {
      r = realpathSync(p);
    } catch {
      return [];
    }
    const h = realpathSync(home);
    return r.startsWith(`${h}/`) ? [r.slice(h.length + 1).split('/')[0]] : [];
  };
  const shown = new Set([dir, ...(path ?? '').split(':'), dirname(process.execPath), dirname(dirname(realpathSync(process.execPath))), bot.workspace].filter((d) => d.startsWith('/')).flatMap(under));
  const listed = (/home:\n([\s\S]*?):home/.exec(file)?.[1] ?? '').split('\n').filter(Boolean);
  assert.ok(listed.includes(basename(dir)), `the folder on its PATH is shown: ${file}`);
  for (const name of listed) assert.ok(shown.has(name), `${name} in the home folder is the way down to a tree the sandbox shows (${[...shown].join(', ')}): ${file}`);
  assert.ok(!listed.includes(basename(canary)));
  assert.match(file, /secret\.txt: No such file or directory/, file);
  assert.match(file, /new\.txt: (No such file or directory|Read-only file system)/, file);
  assert.match(file, /canary-absent/, file);
  assert.doesNotMatch(file, /HOME-CANARY/);
  // Nothing reached the host: no byte through the pipe (and the host's own data still there), no connection, no file changed.
  const got = Buffer.alloc(64);
  const n = readSync(reader, got, 0, 64, null);
  assert.equal(got.subarray(0, n).toString(), 'host-data\n', 'the pipe holds only what the host wrote');
  assert.equal(calls, 0, 'no program outside saw a connection');
  assert.equal(readFileSync(protectedFile, 'utf8'), 'original');
  assert.deepEqual(readdirSync(canary), ['secret.txt'], 'nothing written in the folder nothing shows');
  assert.match(status, /stdout:\nNoNewPrivs:1\nSeccomp:2\n0 1 2 3 $/, `only stdin, stdout, stderr (and ls's own): ${status}`);
  assert.match(git, /stdout:\n1\n/, git);
  assert.match(child, /child ok/, child);
  assert.match(tcpInside, /pong/, tcpInside);
  assert.match(ownFifo, /through-own/, ownFifo);
});

test('a file descriptor the server was started with never reaches a sandboxed command: not a folder of the host, not a pipe', async (t) => {
  if (process.platform !== 'linux' || sandboxProblem()) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
    t.skip('no sandbox here');
    return;
  }
  // A server started as a CI runner or a terminal can start it: holding, without close-on-exec, a folder outside what
  // the sandbox shows and the write end of a host program's pipe, numbered past a gap (43 and 44). Node marks what it
  // was started with close-on-exec only up to the first descriptor missing after 15, so these stay open across exec.
  const dir = tempDir();
  const host = join(dir, 'host');
  const ws = join(dir, 'ws');
  mkdirSync(host);
  mkdirSync(ws);
  writeFileSync(join(host, 'secret.txt'), 'HOST-SECRET');
  const fifo = join(dir, 'host.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  const folder = openSync(host, 'r');
  t.after(() => [reader, writer, folder].forEach((fd) => closeSync(fd)));
  const command = 'ls /proc/self/fd | tr "\\n" " "; echo; cat /proc/self/fd/43/secret.txt; echo x > /proc/self/fd/43/written.txt; echo sandbox-data > /proc/self/fd/44; echo end';
  const server = `
    const { readdirSync, readFileSync } = await import('node:fs');
    const { runProcess } = await import(${JSON.stringify(new URL('../src/sandbox.ts', import.meta.url).href)});
    const held = readdirSync('/proc/self/fd').filter((fd) => fd === '43' || fd === '44').filter((fd) => !(parseInt(/flags:\\s*([0-7]+)/.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))[1], 8) & 0o2000000));
    const r = await runProcess({ argv: ['/bin/sh', '-c', ${JSON.stringify(command)}], cwd: ${JSON.stringify(ws)}, env: {}, sandbox: { cwd: ${JSON.stringify(ws)}, writable: [${JSON.stringify(ws)}], hidden: [], readOnly: [], env: { PATH: '/usr/bin:/bin' } }, timeoutMs: 20000, signal: new AbortController().signal, maxBytes: 65536 });
    console.log(JSON.stringify({ held, out: r.stdout.toString(), err: r.stderr }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', server], { stdio: ['ignore', 'pipe', 'pipe', ...Array(40).fill('ignore'), folder, writer], encoding: 'utf8', env: { PATH: process.env.PATH, BOTONS_LOG_LEVEL: 'warn' }, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const { held, out, err } = JSON.parse(lines.at(-1)!);
  assert.deepEqual(held, ['43', '44'], 'the server held both, open across exec');
  assert.match(lines.join('\n'), /closed file descriptors the server was started with[^\n]*"fds":\[43,44\]/);
  assert.match(out, /^0 1 2 3 \n/, `only stdin, stdout, stderr (and ls's own): ${out}`);
  assert.match(out, /end\n$/, out);
  assert.doesNotMatch(out, /HOST-SECRET/);
  // Each of the three fails as a missing path (ENOENT): bash says "No such file or directory", dash, when it can't
  // create a file to redirect to, "Directory nonexistent". Anything else (permission denied, a write) fails here.
  const enoent = (path: string) => new RegExp(`${path.replace(/[./]/g, '\\$&')}: (?:No such file or directory|Directory nonexistent)\n`);
  for (const path of ['/proc/self/fd/43/secret.txt', '/proc/self/fd/43/written.txt', '/proc/self/fd/44']) assert.match(err, enoent(path), err);
  assert.deepEqual(readdirSync(host), ['secret.txt'], 'nothing written in the folder outside');
  assert.throws(() => readSync(reader, Buffer.alloc(64), 0, 64, null), { code: 'EAGAIN' }, 'nothing reached the pipe');
});

test('the sandbox check refuses a bubblewrap that lets a file descriptor of the server’s in', async (t) => {
  if (process.platform !== 'linux' || sandboxProblem()) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
    t.skip('no sandbox here');
    return;
  }
  // A wrapper that opens one (the root folder, without close-on-exec) after the server closed its own, then runs the
  // machine's bubblewrap.
  const leaky = join(tempDir(), 'bwrap-with-fd');
  writeFileSync(leaky, '#!/bin/bash\nexec 7</\nexec bwrap "$@"\n', { mode: 0o755 });
  useSandboxBinary(leaky);
  try {
    assert.match(sandboxProblem() ?? '', /a file descriptor of the server’s, besides stdin, stdout and stderr, was open inside/);
    const { s, fake } = await server();
    const bot = await s.newBot('Tim', { provider: 'openai-api', model: 'gpt-6.1-sol' });
    const m = await reply(s, bot, 'Hello');
    assert.equal(m.role, 'error');
    assert.match(m.text, /file descriptor/);
    assert.equal(fake.requests.length, 0, 'not even the first request');
  } finally {
    useSandboxBinary('bwrap');
  }
});

test('the sandbox check refuses a view that would let a write reach a pipe outside (binds, not overlays)', async (t) => {
  if (process.platform !== 'linux' || sandboxProblem()) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
    t.skip('no sandbox here');
    return;
  }
  const dir = tempDir();
  const weak = join(dir, 'bwrap-with-binds');
  writeFileSync(
    weak,
    '#!/bin/bash\nargs=(); srcs=()\nwhile [ $# -gt 0 ]; do case "$1" in --overlay-src) srcs+=("$2"); shift 2;; --ro-overlay) args+=(--ro-bind "${srcs[-1]}" "$2"); srcs=(); shift 2;; *) args+=("$1"); shift;; esac; done\nexec bwrap "${args[@]}"\n',
    { mode: 0o755 },
  );
  useSandboxBinary(weak);
  try {
    assert.match(sandboxProblem() ?? '', /let a write reach a named pipe outside/);
    const { s, fake } = await server();
    const bot = await s.newBot('Tim', { provider: 'openai-api', model: 'gpt-6.1-sol' });
    const m = await reply(s, bot, 'Hello');
    assert.equal(m.role, 'error');
    assert.match(m.text, /named pipe/);
    assert.equal(fake.requests.length, 0, 'not even the first request');
  } finally {
    useSandboxBinary('bwrap');
  }
});

test('mount points: the fifth field of each mountinfo line, its octal escapes undone', () => {
  const text = '22 1 0:21 / / rw,relatime - ext4 /dev/root rw\n31 22 7:1 / /snap/core22/1234 ro,nodev - squashfs /dev/loop1 ro\n40 22 0:40 / /home/you/with\\040space rw - tmpfs tmpfs rw\n\n';
  assert.deepEqual(parseMountinfo(text), ['/', '/snap/core22/1234', '/home/you/with space']);
});

test('a folder another filesystem is mounted inside (as /snap holds each snap) is left out of the view, never bound; the sandbox still works, and a folder inside it on PATH is shown on its own', async (t) => {
  if (process.platform !== 'linux' || sandboxProblem()) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
    t.skip('no sandbox here');
    return;
  }
  // A mount of the test's own, made in a user namespace of its own (as root there, nothing of the host's changes): a
  // tree with it inside is what the kernel refuses as an overlay's lower layer once bubblewrap's namespace locks it.
  const probe = spawnSync('unshare', ['-Urm', 'true'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    if (process.env.CI) assert.fail(`CI needs unshare to make the mount this test checks: ${probe.stderr || probe.error?.message}`);
    t.skip('no unshare -Urm here');
    return;
  }
  const home = process.env.HOME ?? '/root';
  const tree = join(home, `.sandbox-mounted-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(tree, 'mounted'), { recursive: true });
  mkdirSync(join(tree, 'bin'));
  writeFileSync(join(tree, 'outside.txt'), 'the tree itself');
  writeFileSync(join(tree, 'bin', 'tool.txt'), 'a tool on PATH');
  const ws = tempDir();
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const script = `
    const { runProcess, sandboxProblem, viewOf } = await import(${JSON.stringify(new URL('../src/sandbox.ts', import.meta.url).href)});
    const tree = ${JSON.stringify(tree)};
    const plan = { cwd: ${JSON.stringify(ws)}, writable: [${JSON.stringify(ws)}], hidden: [], readOnly: [], env: { PATH: process.env.PATH } };
    const problem = sandboxProblem();
    const view = viewOf(plan);
    const look = problem ? null : await runProcess({ argv: ['/bin/sh', '-c', 'cat "$1/bin/tool.txt"; echo; if [ -e "$1/outside.txt" ]; then echo seen; else echo unseen; fi', 'sh', tree], cwd: plan.cwd, env: {}, sandbox: plan, timeoutMs: 20000, signal: new AbortController().signal, maxBytes: 65536 });
    console.log('RESULT ' + JSON.stringify({ problem, unshown: view.unshown, trees: view.trees.map((t) => t.path), status: look?.code, out: look?.stdout.toString(), err: look?.stderr }));
  `;
  // On PATH: the tree (which has the mount inside) and a plain folder inside it.
  const env = { ...process.env, PATH: `${tree}:${join(tree, 'bin')}:${process.env.PATH}` };
  const r = spawnSync('unshare', ['-Urm', 'sh', '-c', 'mount -t tmpfs mounted "$1/mounted" && exec "$2" --input-type=module -e "$3"', 'sh', tree, process.execPath, script], { encoding: 'utf8', env });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result: ${r.stdout}${r.stderr}`);
  const got = JSON.parse(line.slice('RESULT '.length));
  assert.equal(got.problem, null, 'the sandbox check passes with the tree left out');
  const real = realpathSync(tree);
  assert.ok(got.unshown.includes(real), 'left out');
  assert.ok(!got.trees.includes(real), 'not overlaid');
  assert.ok(got.trees.includes(join(real, 'bin')), 'the plain folder inside it is its own tree');
  assert.equal(got.status, 0, got.err);
  assert.deepEqual(got.out.trim().split('\n'), ['a tool on PATH', 'unseen']);
  // Without the mount, the same tree is shown whole, as before.
  const plain = viewOf({ cwd: ws, writable: [ws], hidden: [], readOnly: [], env: { PATH: env.PATH } });
  assert.ok(plain.trees.some((t) => t.path === real) && !plain.unshown.includes(real));
});

test('the socket filter: built for x64 and arm64 only, a short forward-only program; without it (a bubblewrap that drops it) Workspace turns don’t run', async (t) => {
  assert.equal(seccompFilter('ia32'), null);
  assert.equal(seccompFilter('riscv64'), null);
  for (const arch of ['x64', 'arm64']) {
    const f = seccompFilter(arch)!;
    assert.ok(f.length % 8 === 0 && f.length / 8 < 64, String(f.length));
  }
  if (process.platform !== 'linux' || sandboxProblem()) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
    t.skip('no sandbox here');
    return;
  }
  // A bubblewrap that leaves the filter out: the check sees it is off inside, and nothing runs.
  const dir = tempDir();
  const fake = join(dir, 'bwrap-without-filter');
  writeFileSync(fake, '#!/bin/bash\nargs=(); skip=0\nfor a in "$@"; do if [ $skip = 1 ]; then skip=0; continue; fi; if [ "$a" = --seccomp ]; then skip=1; continue; fi; args+=("$a"); done\nexec bwrap "${args[@]}"\n', { mode: 0o755 });
  useSandboxBinary(fake);
  try {
    assert.match(sandboxProblem() ?? '', /socket filter/);
    const { s, fake: api } = await server();
    const bot = await s.newBot('Tim', { provider: 'openai-api', model: 'gpt-6.1-sol' });
    const m = await reply(s, bot, 'Hello');
    assert.equal(m.role, 'error');
    assert.match(m.text, /socket filter/);
    assert.equal(api.requests.length, 0, 'not even the first request');
  } finally {
    useSandboxBinary('bwrap');
  }
});

test('a passed sandbox check stands only for the bubblewrap it ran: another one, the same one changed, or another first on PATH is checked again before anything runs', async (t) => {
  if (process.platform !== 'linux' || sandboxProblem()) {
    if (process.env.CI) assert.fail(`the sandbox is required in CI: ${sandboxProblem()}`);
    t.skip('no sandbox here');
    return;
  }
  const real = String(spawnSync('/bin/sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).stdout).trim();
  assert.ok(real.startsWith('/'), real);
  const dir = tempDir();
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  // Wrappers of the test's own around the machine's bubblewrap (never changed): one that passes it everything, one that
  // drops the filter, one that turns the read-only overlays into binds.
  const faithful = `#!/bin/bash\nexec ${real} "$@"\n`;
  const noFilter = `#!/bin/bash\nargs=(); skip=0\nfor a in "$@"; do if [ $skip = 1 ]; then skip=0; continue; fi; if [ "$a" = --seccomp ]; then skip=1; continue; fi; args+=("$a"); done\nexec ${real} "\${args[@]}"\n`;
  const binds = `#!/bin/bash\nargs=(); srcs=()\nwhile [ $# -gt 0 ]; do case "$1" in --overlay-src) srcs+=("$2"); shift 2;; --ro-overlay) args+=(--ro-bind "\${srcs[-1]}" "$2"); srcs=(); shift 2;; *) args+=("$1"); shift;; esac; done\nexec ${real} "\${args[@]}"\n`;
  const run = (marker: string) =>
    runProcess({ argv: ['/bin/sh', '-c', `echo ran > ${join(ws, marker)}`], cwd: ws, env: {}, sandbox: { cwd: ws, writable: [ws], hidden: [], readOnly: [], env: { PATH: '/usr/bin:/bin' } }, timeoutMs: 20_000, signal: new AbortController().signal, maxBytes: 4096 });
  const path = process.env.PATH;
  try {
    // A bubblewrap that isn't there, right after a pass: not the pass of another.
    assert.equal(sandboxProblem(), null);
    assert.match(sandboxProblem(join(dir, 'nonexistent-bwrap')) ?? '', /not installed/);
    assert.equal(sandboxProblem(), null, 'the real one still stands');

    // The same wrapper file, passed, then changed in place: checked again, refused, and nothing runs through it.
    for (const [what, weak, why] of [['drops the filter', noFilter, /socket filter/], ['binds instead of overlays', binds, /named pipe/]] as const) {
      const wrapper = join(dir, `bwrap-${what.split(' ')[0]}`);
      writeFileSync(wrapper, faithful, { mode: 0o755 });
      useSandboxBinary(wrapper);
      assert.equal(sandboxProblem(), null, `${what}: the faithful wrapper passes`);
      assert.equal((await run('first')).code, 0);
      assert.ok(existsSync(join(ws, 'first')));
      rmSync(join(ws, 'first'));
      writeFileSync(wrapper, weak, { mode: 0o755 });
      await assert.rejects(run('second'), why, `${what}: a command after the change doesn't run`);
      assert.ok(!existsSync(join(ws, 'second')));
      assert.match(sandboxProblem() ?? '', why);
    }

    // Another bubblewrap first on PATH, after a pass by name: that one is checked, and refused.
    useSandboxBinary('bwrap');
    const good = join(dir, 'good');
    const bad = join(dir, 'bad');
    mkdirSync(good);
    mkdirSync(bad);
    writeFileSync(join(good, 'bwrap'), faithful, { mode: 0o755 });
    writeFileSync(join(bad, 'bwrap'), noFilter, { mode: 0o755 });
    process.env.PATH = `${good}:${path}`;
    assert.equal(sandboxProblem(), null);
    assert.equal((await run('third')).code, 0);
    process.env.PATH = `${bad}:${good}:${path}`;
    await assert.rejects(run('fourth'), /socket filter/);
    assert.ok(!existsSync(join(ws, 'fourth')));
    assert.match(sandboxProblem() ?? '', /socket filter/);
    // Back as it was: the pass for it stands again, without a stale failure from the other.
    process.env.PATH = `${good}:${path}`;
    assert.equal(sandboxProblem(), null);
  } finally {
    process.env.PATH = path;
    useSandboxBinary('bwrap');
  }
});

// ------------------------------------------------------------------ R2, R3: caps read at every request, and its own day

function capOf(s: TestServer, botId: string, usd: number | null) {
  if (usd === null) s.app.store.db.prepare('delete from settings where key = ?').run(`spendCap:bot:${botId}`);
  else s.app.store.db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(`spendCap:bot:${botId}`, String(usd));
}

test('a cap lowered, added, raised or removed while a turn runs counts from its next request; a request already sent stays counted', async () => {
  const { s, fake } = await server();
  const bot = await s.newBot('Kevin', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 1 });
  // Lowered to nothing during the first answer: the second request isn't sent.
  fake.queue((r) => {
    capOf(s, bot.id, 0);
    return { calls: [{ name: 'shell', input: { command: 'echo one' } }], usage: { input: 1000, output: 100 } };
  });
  const lowered = await reply(s, bot, 'Loop');
  assert.equal(fake.requests.length, 1, 'no request past the lowered cap');
  assert.match(lowered.text, /spending cap/);
  const rows = s.app.store.db.prepare('select state, cost_usd from api_requests where bot_id = ?').all(bot.id) as any[];
  assert.deepEqual(rows.map((r) => [r.state, r.cost_usd]), [['settled', (1000 * 2 + 100 * 10) / 1e6]], 'the sent one stays counted');

  // Raised during a turn whose answer cap was lowered to fit: the next request has its full output cap.
  capOf(s, bot.id, 0.2);
  fake.queue((r) => {
    capOf(s, bot.id, 50);
    return { calls: [{ name: 'shell', input: { command: 'echo two' } }] };
  }, { text: 'Raised.' });
  const n = fake.requests.length;
  assert.equal((await reply(s, bot, 'Again')).text, 'Raised.');
  assert.ok(fake.requests[n].body.max_tokens < 32_000, String(fake.requests[n].body.max_tokens));
  assert.equal(fake.requests[n + 1].body.max_tokens, 32_000);

  // Removed during a turn: the same.
  capOf(s, bot.id, 0.2);
  fake.queue((r) => {
    capOf(s, bot.id, null);
    return { calls: [{ name: 'shell', input: { command: 'echo three' } }] };
  }, { text: 'Removed.' });
  const m = fake.requests.length;
  assert.equal((await reply(s, bot, 'Once more')).text, 'Removed.');
  assert.ok(fake.requests[m].body.max_tokens < 32_000);
  assert.equal(fake.requests[m + 1].body.max_tokens, 32_000);
});

test('a cap added during a turn on a model with no known price stops it before its next request', async () => {
  const { s, fake } = await server();
  const bot = await s.newBot('Stuart', { provider: 'openai-api', model: 'gpt-unpriced-test', access: 'host' });
  fake.queue((r) => {
    capOf(s, bot.id, 5);
    return { calls: [{ name: 'shell', input: { command: 'echo one' } }] };
  });
  const m = await reply(s, bot, 'Go');
  assert.equal(fake.requests.length, 1);
  assert.match(m.text, /no known price/);
  // The request it sent has no price: it is counted as such, so the cap can't be kept today.
  const view = (await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data;
  assert.equal(view.unpricedToday, 1);
});

test('reservations: each one counts the others outstanding, read in one step; settling frees what it didn’t use; a restart holds what was in flight', async () => {
  const { s } = await server();
  const bot = await s.newBot('Bob', { provider: 'anthropic-api', model: 'claude-opus-5-5', access: 'host' });
  capOf(s, bot.id, 1);
  const spending = new Spending(s.app.store.db);
  const rate = rateFor('anthropic', 'claude-opus-5-5')!;
  const scope = (turnId: string) => ({ botId: bot.id, turnId, runId: null, routineId: null });
  const ask = { provider: 'anthropic-api', model: 'claude-opus-5-5', rate, inputTokens: 10_000, maxOutput: 32_000, minOutput: 1024 };
  // 10K in at $5 (cache writes) is $0.05; 32K out at $20 is $0.64.
  const a = spending.reserve(scope('turn_a'), ask);
  assert.equal(a.usd, 0.69);
  const b = spending.reserve(scope('turn_b'), ask);
  assert.ok(b.maxOutput < 32_000 && b.usd! <= 0.31 + 1e-9, `the second fits what the first left: ${b.maxOutput} ${b.usd}`);
  assert.throws(() => spending.reserve(scope('turn_c'), ask), /left under the Boton’s daily cap/);
  a.settle(0.05);
  const c = spending.reserve(scope('turn_c'), ask);
  assert.ok(c.usd! > 0.3, 'what the first didn’t use is free again');
  a.release(); // settled already: nothing changes
  assert.equal((s.app.store.db.prepare("select state from api_requests where turn_id = 'turn_a'").get() as any).state, 'settled');
  const before = spending.view(bot.id).spentTodayUsd;
  // A new process: what was reserved may have been sent, so it is held, never released, and nothing is counted twice.
  const after = new Spending(s.app.store.db);
  assert.deepEqual((s.app.store.db.prepare("select state from api_requests where turn_id in ('turn_b', 'turn_c') order by turn_id").all() as any[]).map((r) => r.state), ['held', 'held']);
  assert.equal(after.view(bot.id).spentTodayUsd, before);
  b.settle(0.01);
  assert.equal((s.app.store.db.prepare("select state from api_requests where turn_id = 'turn_b'").get() as any).state, 'held', 'a held row is never settled again');
});

test('the day of a request: the account by its own moment, a hold before midnight stays there, and the new day starts empty', async () => {
  let now = new Date('2026-11-07T23:58:00.000Z');
  const { s } = await server();
  const bot = await s.newBot('Jerry', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  await s.call('PATCH', `/api/bots/${bot.id}`, { timezone: 'UTC' });
  capOf(s, bot.id, 1);
  const spending = new Spending(s.app.store.db, { now: () => now });
  const rate = rateFor('anthropic', 'claude-sonnet-5-5')!;
  const scope = { botId: bot.id, turnId: 'turn_long', runId: null, routineId: null };
  const ask = { provider: 'anthropic-api', model: 'claude-sonnet-5-5', rate, inputTokens: 100_000, maxOutput: 32_000, minOutput: 1024 };
  // One multi-round turn: $0.80 before midnight, then (one round held, cut off at 23:59) the rest after it.
  spending.reserve(scope, ask).settle(0.8);
  now = new Date('2026-11-07T23:59:30.000Z');
  const held = spending.reserve(scope, { ...ask, inputTokens: 10_000, maxOutput: 1024 });
  held.hold();
  assert.throws(() => spending.reserve(scope, ask), /daily cap/, 'still the old day: no room');
  now = new Date('2026-11-08T00:00:30.000Z');
  assert.equal(spending.view(bot.id).spentTodayUsd, 0, 'a new day: the old day’s requests and its hold stay there');
  spending.reserve(scope, ask).settle(0.8);
  assert.equal(spending.view(bot.id).spentTodayUsd, 0.8);
  assert.throws(() => spending.reserve(scope, ask), /daily cap/, 'the same turn, on the new day: its own $0.80 counts');
  // A clock set back: requests stamped later count on today too (never dropped), so the old day shows its own and its hold, and more.
  now = new Date('2026-11-07T23:59:59.000Z');
  assert.equal(spending.view(bot.id).spentTodayUsd, round6(1.6 + held.usd!), 'the old day keeps its hold');
  // The Boton's own time zone draws the line: in Los Angeles all of it is the 7th.
  await s.call('PATCH', `/api/bots/${bot.id}`, { timezone: 'America/Los_Angeles' });
  now = new Date('2026-11-08T00:00:30.000Z');
  assert.equal(spending.view(bot.id).spentTodayUsd, round6(1.6 + held.usd!));
});

const round6 = (n: number) => Math.round(n * 1e8) / 1e8;

test('a turn whose requests straddle midnight: through the server, each request on its own day', async () => {
  let now = new Date('2026-11-07T23:59:00.000Z');
  const { s, fake } = await server({ clock: () => now });
  const bot = await s.newBot('Phil', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  await s.call('PATCH', `/api/bots/${bot.id}`, { timezone: 'UTC' });
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 1 });
  fake.queue(
    () => {
      // Answered just before midnight; the next request goes after it.
      setTimeout(() => (now = new Date('2026-11-08T00:01:00.000Z')), 0);
      return { calls: [{ name: 'shell', input: { command: 'sleep 0.2; echo late' } }], usage: { input: 1_000, output: 79_800 } };
    },
    { text: 'Done after midnight.', usage: { input: 1_000, output: 79_800 } },
  );
  // Each answer: 1K in at $2 and 79.8K out at $10 = $0.80. Under a $1 cap the second fits only on its own day.
  const m = await reply(s, bot, 'Work through midnight');
  assert.equal(m.text, 'Done after midnight.', m.text);
  const rows = s.app.store.db.prepare('select at, cost_usd from api_requests where bot_id = ? order by at').all(bot.id) as any[];
  assert.deepEqual(rows.map((r) => [r.at.slice(0, 10), r.cost_usd]), [
    ['2026-11-07', 0.8],
    ['2026-11-08', 0.8],
  ]);
  const view = (await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data;
  assert.equal(view.spentTodayUsd, 0.8, 'today’s is the request sent today');
  assert.equal(view.dayStartedAt, '2026-11-08T00:00:00.000Z');
});

// ------------------------------------------------------------------ R4: one key a turn

test('a saved key removed between requests: the turn stops, with no request on the old key or the environment’s', async () => {
  const { s, fake } = await server({ keys: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
  const saved = 'sk-ant-fake.kevin.saved.1112223334.dave';
  const put = await s.call('PUT', '/api/api-keys/anthropic', { key: saved, generation: s.app.apiKeys.state('anthropic').generation });
  assert.ok(put.status < 300, put.text);
  const bot = await s.newBot('Dave', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  fake.queue(() => {
    s.app.apiKeys.remove('anthropic', { generation: s.app.apiKeys.state('anthropic').generation });
    return { calls: [{ name: 'shell', input: { command: 'echo one' } }] };
  });
  const m = await reply(s, bot, 'Go');
  assert.equal(m.role, 'error');
  assert.match(m.text, /key changed while this turn ran/);
  assert.equal(fake.requests.length, 1, 'nothing after the removal');
  assert.equal(fake.requests[0].headers['x-api-key'], saved);
  // The next turn takes the key in use then: the environment's.
  fake.queue({ text: 'On the environment’s key.' });
  assert.equal((await reply(s, bot, 'Again')).text, 'On the environment’s key.');
  assert.equal(fake.requests[1].headers['x-api-key'], ANTHROPIC_KEY);
});

for (const brain of BRAINS) {
  test(`${brain.provider}: a key saved while a turn runs, echoed by a tool and the model, is in no reply, draft, error, session, log or request`, async () => {
    const { s, fake } = await server();
    const provider = brain.provider === 'anthropic-api' ? 'anthropic' : 'openai';
    const fresh = provider === 'anthropic' ? NEW_KEY : 'sk-fake.otto.rotated.5551234567.tim';
    const bot = await s.newBot('Otto', { provider: brain.provider, model: brain.model, access: 'host' });
    const drafts: string[] = [];
    // Every event the chat would show (drafts included), as JSON.
    const off = s.app.hub.subscribe((e) => drafts.push(JSON.stringify(e)));
    fake.queue(() => {
      // A new key is saved mid-turn; this turn keeps its own, and stops before sending on it.
      s.app.apiKeys.save(provider, { key: fresh, generation: s.app.apiKeys.state(provider).generation });
      return { text: `I see ${fresh} and ${brain.key}`, calls: [{ name: 'shell', input: { command: `echo ${fresh}` } }] };
    });
    const logs = captureLogs();
    let m: Message;
    try {
      m = await reply(s, bot, 'Go');
    } finally {
      logs.restore();
    }
    off();
    assert.equal(fake.requests.length, 1);
    assert.match(m.text, /key changed/);
    for (const k of [fresh, brain.key]) {
      assert.ok(!m.text.includes(k));
      assert.ok(!drafts.some((d) => d.includes(k)), 'no draft holds a key');
      assert.ok(!leftBehind(s, JSON.stringify(logs.lines)).includes(k), 'nothing kept holds a key');
      assert.ok(!JSON.stringify(fake.requests.map((r) => r.body)).includes(k));
    }
  });
}

// ------------------------------------------------------------------ R5: answers that hold a key

const scrubOf = (key: string): Scrub => ({ holds: (t) => t.includes(key) || t.includes(key.slice(4, 20)), redact: (t) => t.split(key).join('[redacted]') });

test('sanitize: text and tool input redacted, signed or encrypted reasoning left out whole, an id that holds a key refuses the answer; both protocols', () => {
  const s = scrubOf(ANTHROPIC_KEY);
  const a = anthropicWire.sanitize(
    {
      id: 'msg_1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `the key is ${ANTHROPIC_KEY}`, signature: 'sig' },
        { type: 'thinking', thinking: 'fine', signature: 'sig2' },
        { type: 'text', text: `here: ${ANTHROPIC_KEY}` },
        { type: 'tool_use', id: 'toolu_1', name: 'shell', input: { command: `curl -H ${ANTHROPIC_KEY}` } },
        { type: 'tool_use', id: 'toolu_2', name: 'shell', input: { command: 'ls' } },
      ],
    },
    s,
  );
  assert.equal(a.left, 1);
  assert.ok(!JSON.stringify(a.assistant).includes(ANTHROPIC_KEY));
  assert.deepEqual((a.assistant as any).content.map((b: any) => b.type), ['thinking', 'text', 'tool_use', 'tool_use']);
  assert.equal(a.text, 'here: [redacted]');
  assert.deepEqual(a.calls.map((c) => [c.id, c.secret ?? false]), [['toolu_1', true], ['toolu_2', false]]);
  assert.throws(() => anthropicWire.sanitize({ id: `msg_${ANTHROPIC_KEY}`, content: [] }, s), SecretInAnswer);
  assert.throws(() => anthropicWire.sanitize({ id: 'm', content: [{ type: 'tool_use', id: ANTHROPIC_KEY, name: 'shell', input: {} }] }, s), SecretInAnswer);
  assert.throws(() => anthropicWire.sanitize({ id: 'm', content: [{ type: 'server_tool_use', id: 'x', input: { q: ANTHROPIC_KEY } }] }, s), SecretInAnswer, 'a kind Botons doesn’t know: not guessed at');

  const o = openaiWire.sanitize(
    [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: ANTHROPIC_KEY }], encrypted_content: 'enc' },
      { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'enc2' },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: `key ${ANTHROPIC_KEY}`, annotations: [{ url: `https://example.com/${ANTHROPIC_KEY}` }] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: JSON.stringify({ command: `echo ${ANTHROPIC_KEY}` }) },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'shell', arguments: `not json ${ANTHROPIC_KEY}` },
    ],
    s,
  );
  assert.ok(!JSON.stringify(o.assistant).includes(ANTHROPIC_KEY));
  assert.deepEqual((o.assistant as any[]).map((i) => i.id), ['rs_2', 'msg_1', 'fc_1', 'fc_2']);
  assert.equal(o.text, 'key [redacted]');
  assert.deepEqual(o.calls.map((c) => [c.id, c.secret ?? false, c.input === null]), [['call_1', true, false], ['call_2', true, true]]);
  assert.throws(() => openaiWire.sanitize([{ type: 'function_call', id: 'fc', call_id: ANTHROPIC_KEY, name: 'shell', arguments: '{}' }], s), SecretInAnswer);
});

/** A value `n` objects deep with `leaf` at the bottom: { a: { a: ... leaf } }. */
const nest = (n: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

test('sanitize: a key at any depth of a call’s input, as a string or an object key, in arrays too, never survives it; both protocols', () => {
  const s = scrubOf(ANTHROPIC_KEY);
  const shapes: [string, unknown][] = [];
  for (const n of [1, 62, 63, 64, 65, 66, 200]) {
    shapes.push([`${n} deep, a string`, nest(n, ANTHROPIC_KEY)]);
    shapes.push([`${n} deep, an object key`, nest(n, { [ANTHROPIC_KEY]: 1 })]);
    let arr: unknown = [ANTHROPIC_KEY];
    for (let i = 0; i < n; i++) arr = [arr];
    shapes.push([`${n} deep in arrays`, arr]);
  }
  for (const [what, deep] of shapes) {
    const input = { path: 'leak.txt', content: 'hi', meta: deep };
    const a = anthropicWire.sanitize({ id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input }] }, s);
    assert.ok(!JSON.stringify(a).includes(ANTHROPIC_KEY), `anthropic, ${what}`);
    assert.equal(a.calls[0].secret, true, `anthropic, ${what}: not run`);
    const o = openaiWire.sanitize([{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write_file', arguments: JSON.stringify(input) }], s);
    assert.ok(!JSON.stringify(o).includes(ANTHROPIC_KEY), `openai, ${what}`);
    assert.equal(o.calls[0].secret, true, `openai, ${what}: not run`);
  }
  // Without a key, a deep input is kept as it came, and runs.
  const plain = { path: 'ok.txt', content: 'hi', meta: nest(100, 'fine') };
  const a = anthropicWire.sanitize({ id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: plain }] }, s);
  assert.deepEqual(a.calls[0].input, plain);
  assert.equal(a.calls[0].secret, undefined);
  // Signed reasoning that holds a key deep down goes whole; its signature isn't touched.
  const r = anthropicWire.sanitize({ id: 'm', role: 'assistant', content: [{ type: 'thinking', thinking: 'ok', signature: 'sig', extra: nest(80, ANTHROPIC_KEY) }, { type: 'text', text: 'hi' }] }, s);
  assert.equal(r.left, 1);
  assert.deepEqual((r.assistant as any).content, [{ type: 'text', text: 'hi' }]);
  // A value that isn't JSON (a cycle: no wire answer is one) is never walked forever: past the bound it counts as
  // holding a key, so its call doesn't run, and what is kept is JSON again.
  const cyc: any = { path: 'x' };
  cyc.self = cyc;
  const c = anthropicWire.sanitize({ id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'write_file', input: cyc }] }, s);
  assert.equal(c.calls[0].secret, true);
  assert.doesNotThrow(() => JSON.stringify(c.assistant));
});

for (const brain of BRAINS) {
  test(`${brain.provider}: a key 66 objects deep in a write_file call: the call never runs, and the key is in no request, session, reply or log`, async () => {
    const { s, fake } = await server();
    const bot = await s.newBot('Dave', { provider: brain.provider, model: brain.model, access: 'host' });
    fake.queue({ calls: [{ name: 'write_file', input: { path: 'leak.txt', content: 'hi', meta: nest(66, brain.key) } }] }, { text: 'Done.' });
    const logs = captureLogs();
    let m: Message;
    try {
      m = await reply(s, bot, 'Go');
    } finally {
      logs.restore();
    }
    assert.equal(m.text, 'Done.');
    assert.ok(!existsSync(join(bot.workspace, 'leak.txt')), 'the call was never run');
    assert.match(toolResults(fake.requests[1]).join('\n'), /Not run: its input held an API key/);
    for (const r of fake.requests) assert.ok(!JSON.stringify(r.body).includes(brain.key));
    assert.ok(!leftBehind(s, JSON.stringify(logs.lines)).includes(brain.key));
  });
}

for (const brain of BRAINS) {
  test(`${brain.provider}: an answer echoing the key keeps it out of the reply, the session, the next request, and never runs the call it was in`, async () => {
    const { s, fake } = await server();
    const bot = await s.newBot('Kevin', { provider: brain.provider, model: brain.model, access: 'host' });
    const marker = join(bot.workspace, 'ran.txt');
    fake.queue(
      {
        text: `Your key is ${brain.key}.`,
        thinking: true,
        thinkingText: `remember ${brain.key}`,
        summary: `summary ${brain.key}`,
        calls: [
          { name: 'shell', input: { command: `echo ${brain.key} > ${marker}` } },
          { name: 'shell', input: { command: 'echo fine' } },
        ],
      },
      { text: `Done, ${brain.key}` },
    );
    const logs = captureLogs();
    let m: Message;
    try {
      m = await reply(s, bot, 'Go');
    } finally {
      logs.restore();
    }
    assert.match(m.text, /^Done, \[redacted\]$/);
    assert.ok(!existsSync(marker), 'the call that held the key was never run');
    const [secretCall, fine] = toolResults(fake.requests[1]);
    assert.match(secretCall, /Not run: its input held an API key/);
    assert.match(fine, /fine/);
    assert.ok(!JSON.stringify(fake.requests[1].body).includes(brain.key), 'the next request carries no key');
    assert.ok(!leftBehind(s, JSON.stringify(logs.lines)).includes(brain.key));
  });

  test(`${brain.provider}: an answer whose id holds the key is refused whole: nothing of it kept, the error clean`, async () => {
    const { s, fake } = await server();
    const bot = await s.newBot('Stuart', { provider: brain.provider, model: brain.model, access: 'host' });
    fake.queue({ id: `x-${brain.key}`, calls: [{ name: 'shell', input: { command: 'echo hi > hi.txt' } }] });
    const m = await reply(s, bot, 'Go');
    assert.equal(m.role, 'error');
    assert.match(m.text, /held an API key/);
    assert.ok(!m.text.includes(brain.key));
    assert.ok(!existsSync(join(bot.workspace, 'hi.txt')));
    assert.ok(!leftBehind(s, '').includes(brain.key));
  });

  test(`${brain.provider}: a kept session that holds the key (from before it was known) is cleaned before it is sent again`, async () => {
    const { s, fake } = await server();
    const bot = await s.newBot('Bob', { provider: brain.provider, model: brain.model, access: 'host' });
    fake.queue({ text: 'First.' });
    await reply(s, bot, 'First');
    const sessionId = s.app.store.getBot(bot.id).sessionId!;
    const file = join(s.home, 'api-sessions', `${sessionId}.json`);
    const h = JSON.parse(readFileSync(file, 'utf8'));
    h.items.push({ kind: 'user', data: { text: `old ${brain.key}` } });
    h.items.push({ kind: 'assistant', data: brain.provider === 'anthropic-api' ? { id: 'msg_old', role: 'assistant', content: [{ type: 'text', text: brain.key }] } : [{ type: 'message', id: 'msg_old', role: 'assistant', content: [{ type: 'output_text', text: brain.key, annotations: [] }] }] });
    writeFileSync(file, JSON.stringify(h));
    fake.queue({ text: 'Second.' });
    assert.equal((await reply(s, bot, 'Second')).text, 'Second.');
    assert.ok(!JSON.stringify(fake.requests.at(-1)!.body).includes(brain.key));
    assert.ok(!readFileSync(file, 'utf8').includes(brain.key));
  });
}

// ------------------------------------------------------------------ R6: a connector's secrets in its structured result and tool list

test('a connector’s bearer token in a structured-only result, its tool list and schema reaches no model request, history, step or log', async (t) => {
  const bearer = 'lib_bearer_secret_4567890';
  const seen: any[] = [];
  const mcp = createHttpServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const m = JSON.parse(body || '{}');
    seen.push({ auth: req.headers.authorization, method: m.method });
    if (m.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      m.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vault', version: '1' } }
        : m.method === 'tools/list'
          ? {
              tools: [
                { name: 'lookup', description: `Look things up (auth ${bearer})`, inputSchema: { type: 'object', title: `schema ${bearer}`, properties: { q: { type: 'string', description: bearer } } } },
                { name: `leak_${bearer}`, description: 'a name that holds it', inputSchema: { type: 'object' } },
              ],
            }
          : { structuredContent: { token: `Bearer ${bearer}`, nested: [{ deep: [bearer] }], [bearer]: 'as a key' } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  const port = await freePort();
  await new Promise<void>((r) => mcp.listen(port, '127.0.0.1', r));
  t.after(() => mcp.close());
  const { s, fake } = await server({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
  const add = await s.call('POST', '/api/mcp-servers', { name: 'vault', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(add.status, 201, add.text);
  const bot = await s.newBot('Carl', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host', connections: ['lib:vault'] });
  fake.queue({ calls: [{ name: 'mcp__vault__lookup', input: { q: 'x' } }] }, { text: 'Looked.' });
  const logs = captureLogs();
  try {
    assert.equal((await reply(s, bot, 'Look it up')).text, 'Looked.');
  } finally {
    logs.restore();
  }
  assert.ok(seen.some((x) => x.method === 'tools/call' && x.auth === `Bearer ${bearer}`), 'the call went, with its token');
  const tools = (fake.requests[0].body.tools as any[]).map((x) => x.name);
  assert.ok(tools.includes('mcp__vault__lookup'));
  assert.ok(!tools.some((n) => n.includes('leak')), 'a tool whose name holds the token is left out');
  const result = toolResults(fake.requests[1]).at(-1)!;
  assert.match(result, /\[redacted\]/);
  for (const r of fake.requests) assert.ok(!JSON.stringify(r.body).includes(bearer), 'no request to the model holds it');
  const kept = leftBehind(s, JSON.stringify(logs.lines)).split('\n').filter((x) => x.includes(bearer));
  assert.deepEqual(kept.map((x) => x.slice(0, 300)), [], 'nor anything kept');
});

/** Every run of 16 characters of `secret` (what would let it be pieced back together). */
const fragments = (secret: string) => Array.from({ length: secret.length - 15 }, (_, i) => secret.slice(i, i + 16));
const SECRET_49 = 'conn_secret_0123456789_abcdefghij_KLMNOPQRSTUVWXY';

test('a connector result’s secrets go before its text is cut: across the cut, across the join of its blocks, in structured content and metadata', () => {
  assert.equal(SECRET_49.length, 49);
  const max = 64 * 1024;
  // The secret starts 48 characters before the cut: cut first, 48 of its 49 characters would be left.
  const across = cleanResult({ content: [{ type: 'text', text: `${'x'.repeat(max - 48)}${SECRET_49}${'tail'.repeat(100)}` }] }, [SECRET_49]);
  assert.ok(across.text!.startsWith('x'.repeat(100)));
  assert.match(across.text!, /\[… cut at 65536 characters\]$/);
  for (const f of fragments(SECRET_49)) assert.ok(!across.text!.includes(f), 'no part of it at the cut');
  // The second block starts with it, just before the cut, and the joins count toward the cut.
  const joined = cleanResult({ content: [{ type: 'text', text: 'x'.repeat(max - 30) }, { type: 'image', data: 'x' }, { type: 'text', text: `${SECRET_49} more` }] }, [SECRET_49]);
  for (const f of fragments(SECRET_49)) assert.ok(!joined.text!.includes(f));
  // A caller's own secrets (an API brain's keys) go before the cut too.
  const key = 'sk-ant-fake.bob.test.0123456789.kevin';
  const also = cleanResult({ content: [{ type: 'text', text: `${'x'.repeat(max - 20)}${key}` }] }, [SECRET_49], (t) => t.split(key).join('[redacted]'));
  for (const f of fragments(key)) assert.ok(!also.text!.includes(f));
  // Structured content and its keys, at any depth it is kept to; a short text alongside, unchanged.
  const both = cleanResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { a: [{ [SECRET_49]: SECRET_49 }], b: `Bearer ${SECRET_49}` } }, [SECRET_49]);
  assert.equal(both.text, 'ok');
  assert.ok(!JSON.stringify(both.structured).includes(SECRET_49.slice(0, 16)));
  // Discovery metadata: a description and schema with it, long enough to be cut later, has it out first.
  const [tool] = cleanTools([{ name: 't', description: `${'d'.repeat(5000)}${SECRET_49}`, inputSchema: { type: 'object', title: SECRET_49 } }], [SECRET_49]);
  assert.ok(!JSON.stringify(tool).includes(SECRET_49.slice(0, 16)));
});

test('a stdio connector’s stderr: its secret, split across chunks and at the front of what is kept, is in no error', async () => {
  const dir = tempDir();
  const script = join(dir, 'noisy.js');
  // Writes the secret in two chunks, then enough after it that keeping only the last 2000 characters raw would cut
  // into it, and exits before answering.
  writeFileSync(script, `const s = process.env.CONN_SECRET; process.stderr.write(s.slice(0, 20)); setTimeout(() => { process.stderr.write(s.slice(20) + 'B'.repeat(1960) + '\\n'); setTimeout(() => process.exit(1), 50); }, 50);`);
  const mcp = new StdioMcp({ command: process.execPath, args: [script], env: { CONN_SECRET: SECRET_49 }, cwd: dir }, { PATH: process.env.PATH ?? '' });
  try {
    await assert.rejects(mcp.initialize(10_000), (err: Error) => {
      assert.match(err.message, /exited \(1\)/);
      for (const f of fragments(SECRET_49)) assert.ok(!err.message.includes(f), `no part of it in: ${err.message.slice(0, 120)}`);
      return true;
    });
  } finally {
    mcp.close();
  }
});

test('a connector’s 49-character token across the cut of its text-only result: no part of it reaches the model, the history or the log', async (t) => {
  const mcp = createHttpServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const m = JSON.parse(body || '{}');
    if (m.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      m.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vault', version: '1' } }
        : m.method === 'tools/list'
          ? { tools: [{ name: 'lookup', description: 'Look things up', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: `${'x'.repeat(64 * 1024 - 48)}${SECRET_49}tail` }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  const port = await freePort();
  await new Promise<void>((r) => mcp.listen(port, '127.0.0.1', r));
  t.after(() => mcp.close());
  const { s, fake } = await server({ env: { BOTONS_OAUTH_ALLOW: '127.0.0.1' } });
  const add = await s.call('POST', '/api/mcp-servers', { name: 'vault', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${SECRET_49}` } });
  assert.equal(add.status, 201, add.text);
  const bot = await s.newBot('Jerry', { provider: 'openai-api', model: 'gpt-6.1-sol', access: 'host', connections: ['lib:vault'] });
  fake.queue({ calls: [{ name: 'mcp__vault__lookup', input: { q: 'x' } }] }, { text: 'Looked.' });
  const logs = captureLogs();
  try {
    assert.equal((await reply(s, bot, 'Look it up')).text, 'Looked.');
  } finally {
    logs.restore();
  }
  const result = toolResults(fake.requests[1]).at(-1)!;
  assert.ok(result.length > 30_000, 'the result was passed on');
  const sent = JSON.stringify(fake.requests.map((r) => r.body));
  const kept = leftBehind(s, JSON.stringify(logs.lines));
  for (const f of fragments(SECRET_49)) {
    assert.ok(!sent.includes(f), `no request holds ${f}`);
    assert.ok(!kept.split('\n').some((x) => x.includes(f)), `nothing kept holds ${f}`);
  }
});

// ------------------------------------------------------------------ R7: the request bound

test('the request bound: whole older exchanges go first, then the newest exchange’s tool output (pairs kept); past that, nothing is sent', () => {
  const big = (n: number) => 'x'.repeat(n);
  const items: HistoryItem[] = [
    { kind: 'user', data: { text: big(100_000) } },
    { kind: 'assistant', data: { content: [{ type: 'text', text: 'old' }] } },
    { kind: 'user', data: { text: 'now' } },
    { kind: 'assistant', data: { content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: {} }, { type: 'tool_use', id: 'b', name: 'read_file', input: {} }] } },
    { kind: 'tools', data: { results: [{ id: 'a', name: 'read_file', text: big(250_000), isError: false }, { id: 'b', name: 'read_file', text: big(250_000), isError: false }] } },
    { kind: 'assistant', data: { content: [{ type: 'tool_use', id: 'c', name: 'read_file', input: {} }] } },
    { kind: 'tools', data: { results: [{ id: 'c', name: 'read_file', text: big(250_000), isError: false }] } },
  ];
  const fit = fitRequest(items, 600_000, 20_000);
  assert.ok(fit.ok);
  assert.equal(fit.trimmed, true);
  assert.equal(fit.compacted, 2, 'the two oldest outputs of the newest exchange');
  const total = 20_000 + fit.items.reduce((n, it) => n + Buffer.byteLength(JSON.stringify(it.data)), 0);
  assert.ok(total <= 600_000, String(total));
  const results = fit.items.filter((it) => it.kind === 'tools').flatMap((it) => (it.data as any).results);
  assert.deepEqual(results.map((r: any) => r.id), ['a', 'b', 'c'], 'every call keeps its result');
  assert.match(results[0].text, /was left out/);
  assert.equal(results[2].text.length, 250_000);
  // A new input too big on its own, and a turn whose own answers outgrow the bound: not sent.
  const huge = fitRequest([{ kind: 'user', data: { text: big(700_000) } }], 600_000, 1000);
  assert.deepEqual(huge.ok ? null : huge.why, 'input');
  const answers = fitRequest(
    [{ kind: 'user', data: { text: 'go' } }, ...Array.from({ length: 3 }, (_, i): HistoryItem => ({ kind: 'assistant', data: { content: [{ type: 'text', text: big(250_000) }], i } }))],
    600_000,
    1000,
  );
  assert.deepEqual(answers.ok ? null : answers.why, 'turn');
});

test('the request bound through a turn: a message too big is not sent nor reserved; large tool outputs keep each request within the bound', async () => {
  const { s, fake } = await server();
  const bot = await s.newBot('Tim', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', access: 'host' });
  await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 50 });
  // A chat message is bounded well below it; a webhook's payload or a long context can make an input this big.
  const provider = s.app.providers.get('anthropic-api')!;
  await assert.rejects(
    provider.runTurn({
      cwd: bot.workspace,
      sessionId: null,
      systemPrompt: 'sys',
      spend: { botId: bot.id, turnId: 'turn_big', runId: null, routineId: null },
      prompt: 'y'.repeat(700_000),
      model: 'claude-sonnet-5-5',
      access: 'host',
      privatePaths: [],
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      onActivity: () => {},
    }),
    /Not sent: this message.*Put the long text in a file/,
  );
  assert.equal(fake.requests.length, 0);
  assert.equal((s.app.store.db.prepare('select count(*) as n from api_requests').get() as any).n, 0, 'nothing reserved');

  for (const name of ['a', 'b', 'c']) writeFileSync(join(bot.workspace, `${name}.txt`), name.repeat(250_000));
  fake.queue(
    { calls: [{ name: 'read_file', input: { path: 'a.txt' } }, { name: 'read_file', input: { path: 'b.txt' } }] },
    { calls: [{ name: 'read_file', input: { path: 'c.txt' } }] },
    { text: 'Read them all.' },
  );
  assert.equal((await reply(s, bot, 'Read the three files')).text, 'Read them all.');
  for (const r of fake.requests) assert.ok(Buffer.byteLength(JSON.stringify(r.body)) <= REQUEST_MAX_BYTES, String(Buffer.byteLength(JSON.stringify(r.body))));
  const last = fake.requests.at(-1)!;
  const uses = last.body.messages.flatMap((m: any) => m.content).filter((b: any) => b.type === 'tool_use').map((b: any) => b.id);
  const results = last.body.messages.flatMap((m: any) => m.content).filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id);
  assert.deepEqual(results, uses, 'every call still has its result');
  assert.ok(toolResults(last).some((t) => /was left out/.test(t)));
  // Every reservation was a request that went.
  assert.equal((s.app.store.db.prepare("select count(*) as n from api_requests where state = 'settled'").get() as any).n, fake.requests.length);
});

for (const brain of BRAINS) {
  test(`${brain.provider}: the request bound counts the images a message attaches: past it nothing is sent or reserved; a small one goes, within it`, async () => {
    const { s, fake } = await server();
    const bot = await s.newBot('Mark', { provider: brain.provider, model: brain.model, access: 'host' });
    await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 50 });
    const provider = s.app.providers.get(brain.provider)!;
    const dir = tempDir();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const turn = (images: string[], id: string) =>
      provider.runTurn({
        cwd: bot.workspace,
        sessionId: null,
        systemPrompt: 'sys',
        spend: { botId: bot.id, turnId: id, runId: null, routineId: null },
        prompt: 'What is this?',
        model: brain.model,
        access: 'host',
        images,
        privatePaths: [],
        env: {},
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        onActivity: () => {},
      });
    const reserved = () => (s.app.store.db.prepare('select count(*) as n from api_requests').get() as any).n;

    // 500,000 bytes: about 667 KB as base64, past the bound with nothing else in the request.
    const big = join(dir, 'big.png');
    writeFileSync(big, Buffer.concat([png, Buffer.alloc(500_000 - png.length, 7)]));
    await assert.rejects(turn([big], 'turn_big_image'), (err: Error) => {
      assert.match(err.message, /Not sent: .*image.*586 KB.*images included.*fewer or smaller images/s);
      return true;
    });
    assert.equal(fake.requests.length, 0, 'nothing sent');
    assert.equal(reserved(), 0, 'nothing reserved');

    // Two images that fit each on their own but not together.
    const half = join(dir, 'half.png');
    writeFileSync(half, Buffer.concat([png, Buffer.alloc(240_000, 7)]));
    await assert.rejects(turn([half, half], 'turn_two_images'), /Not sent: .*2 images/s);
    assert.equal(fake.requests.length, 0);
    assert.equal(reserved(), 0);

    // An image whose bytes hold the key (a screenshot of a terminal saved as text, say) never goes.
    const keyed = join(dir, 'keyed.png');
    writeFileSync(keyed, Buffer.concat([png, Buffer.from(` ${brain.key} `)]));
    await assert.rejects(turn([keyed], 'turn_keyed_image'), /Not sent: the request would have held an API key/);
    assert.equal(fake.requests.length, 0);
    assert.equal(reserved(), 0);

    // A small one goes, the whole body within the bound, and is counted.
    const small = join(dir, 'small.png');
    writeFileSync(small, Buffer.concat([png, Buffer.alloc(100_000, 7)]));
    fake.queue({ text: 'A dot.' });
    assert.equal((await turn([small], 'turn_small_image')).text, 'A dot.');
    assert.equal(fake.requests.length, 1);
    const body = JSON.stringify(fake.requests[0].body);
    assert.ok(body.includes(readFileSync(small).toString('base64')), 'the image went whole');
    assert.ok(Buffer.byteLength(body) <= REQUEST_MAX_BYTES, String(Buffer.byteLength(body)));
    assert.equal(reserved(), 1);
  });
}

// ------------------------------------------------------------------ R8: usage Botons can trust

test('usage: only every required counter, whole and from 0 up, consistent; anything else is unknown, never zero', async () => {
  const fake = await fakeModelApi();
  fakes.push(fake);
  const send = async (wire: typeof anthropicWire, step: any) => {
    fake.queue(step);
    const r = await wire.send(wire.body({ model: 'm', effort: '', system: 's', items: [{ kind: 'user', data: { text: 'hi' } }], tools: [], maxOutput: 100 }), {
      origin: fake.origin,
      key: 'k',
      signal: new AbortController().signal,
      onText: () => {},
      onActivity: () => {},
      idleMs: 5000,
    });
    return r.usage;
  };
  const start = (o: Record<string, unknown> = {}) => ({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, ...o });
  assert.deepEqual(await send(anthropicWire, { text: 'a', rawUsage: { start: start(), delta: { output_tokens: 5 } } }), { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
  assert.deepEqual(await send(anthropicWire, { text: 'a', rawUsage: { start: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null }, delta: { output_tokens: 0 } } }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'a real zero, every counter there');
  for (const [why, raw] of [
    ['empty', { start: {}, delta: {} }],
    ['null input', { start: start({ input_tokens: null }), delta: { output_tokens: 5 } }],
    ['negative', { start: start({ input_tokens: -1 }), delta: { output_tokens: 5 } }],
    ['fraction', { start: start({ cache_read_input_tokens: 1.5 }), delta: { output_tokens: 5 } }],
    ['a string', { start: start({ input_tokens: '10' }), delta: { output_tokens: 5 } }],
    ['out of range', { start: start({ input_tokens: 1e12 }), delta: { output_tokens: 5 } }],
    ['no final delta usage', { start: start(), delta: null }],
    ['output going down', { start: start({ output_tokens: 9 }), delta: { output_tokens: 5 } }],
    ['cache split that doesn’t add up', { start: start({ cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 } }), delta: { output_tokens: 5 } }],
    ['a 1-hour cache write (no rate)', { start: start({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3 } }), delta: { output_tokens: 5 } }],
    ['a server tool use (no rate)', { start: start(), delta: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } }],
  ] as const) {
    assert.equal(await send(anthropicWire, { text: 'a', rawUsage: raw }), null, why);
  }

  const good = { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 16 };
  assert.deepEqual(openaiUsage(good), { input: 6, output: 6, cacheRead: 4, cacheWrite: 0 });
  assert.deepEqual(openaiUsage({ ...good, input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  for (const [why, u] of [
    ['empty', {}],
    ['null', null],
    ['no details', { ...good, input_tokens_details: undefined }],
    ['negative', { ...good, output_tokens: -6, total_tokens: 4 }],
    ['fraction', { ...good, input_tokens: 10.5 }],
    ['NaN', { ...good, output_tokens: Number.NaN }],
    ['total not the sum', { ...good, total_tokens: 0 }],
    ['cached past the input', { ...good, input_tokens_details: { cached_tokens: 11 } }],
    ['reasoning past the output', { ...good, output_tokens_details: { reasoning_tokens: 7 } }],
  ] as const) {
    assert.equal(openaiUsage(u), null, why);
  }
  assert.deepEqual(await send(openaiWire, { text: 'a', rawUsage: { response: good } }), { input: 6, output: 6, cacheRead: 4, cacheWrite: 0 });
  assert.equal(await send(openaiWire, { text: 'a', finals: [good, { ...good, output_tokens: 1, total_tokens: 11 }] }), null, 'two final answers: which usage holds is unknown');
});

for (const brain of BRAINS) {
  test(`${brain.provider}: an answer with empty usage is held at its reservation, not settled free`, async () => {
    const { s, fake } = await server();
    const bot = await s.newBot('Dave', { provider: brain.provider, model: brain.model, access: 'host' });
    await s.call('PUT', `/api/bots/${bot.id}/spending`, { dailyCapUsd: 5 });
    fake.queue({ text: 'Free?', rawUsage: brain.provider === 'anthropic-api' ? { start: {}, delta: {} } : { response: {} } });
    const m = await reply(s, bot, 'Hi');
    assert.equal(m.text, 'Free?');
    const row = s.app.store.db.prepare('select state, reserved_usd, cost_usd from api_requests where bot_id = ?').get(bot.id) as any;
    assert.equal(row.state, 'held');
    assert.equal(row.cost_usd, null);
    assert.ok(row.reserved_usd > 0.3, String(row.reserved_usd));
    const view = (await s.call<SpendingView>('GET', `/api/bots/${bot.id}/spending`)).data;
    assert.equal(view.spentTodayUsd, row.reserved_usd);
    const turn = s.app.store.db.prepare('select cost_usd from turns where bot_id = ? order by rowid desc limit 1').get(bot.id) as any;
    assert.equal(turn.cost_usd, row.reserved_usd, 'the turn shows the hold, not zero');
  });
}

test('an adjusted request rechecks attachment bytes against keys saved while the first request waited', async () => {
  const { s, fake } = await server({ keys: { OPENAI_API_KEY: OPENAI_KEY } });
  const bot = await s.newBot('Bob', { provider: 'openai-api', model: 'gpt-6.1-sol', access: 'host' });
  const newlyKnown = 'sk-ant-qqqq.RotatedOnly.9988776655.zzzzz';
  const file = join(tempDir(), 'note.png');
  writeFileSync(file, Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), Buffer.from(newlyKnown)]));
  fake.queue(() => {
    s.app.apiKeys.save('anthropic', { key: newlyKnown, generation: 0 });
    return { status: 400, error: { message: 'include is not supported' } };
  }, { text: 'Should not be sent.' });
  await assert.rejects(s.app.providers.get('openai-api')!.runTurn({ cwd: bot.workspace, sessionId: null, systemPrompt: 'sys', spend: { botId: bot.id, turnId: 'turn_adjusted_image', runId: null, routineId: null }, prompt: 'Read this', model: 'gpt-6.1-sol', access: 'host', images: [file], privatePaths: [], env: {}, signal: new AbortController().signal, timeoutMs: 30_000, onActivity: () => {} }), /request would have held an API key/);
  assert.equal(fake.requests.length, 1, 'no adjusted request');
  const rows = s.app.store.db.prepare('select state from api_requests').all();
  assert.deepEqual(rows.map((r) => r.state), ['released'], 'no second reservation');
});
