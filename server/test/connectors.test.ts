import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Bot, ConnectorCatalog, McpServer, Routine } from '../../shared/types.ts';
import type { TurnMcpServer } from '../src/providers/types.ts';
import { captureLogs } from '../src/log.ts';
import { contextBlock, sessionKey, systemPrompt } from '../src/prompt.ts';
import { claudeArgs, claudeMcpConfig, claudeMcpRule } from '../src/providers/claude-cli.ts';
import { codexMcp } from '../src/providers/codex-cli.ts';
import { LAUNCH_SCRIPT } from '../src/connector-launch.ts';
import { sandboxBinary } from '../src/sandbox.ts';
import type { FakeCli } from './fixtures/fake-cli.ts';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

const home = tempDir('botons-connectors-');
useTestCodexHome(home);
const s = await startServer({ home, fakeClis: true, env: { BOTONS_TURN_TIMEOUT_MS: '3000' } });
const { app, call, chat: turn, claude, codex } = s;

const SECRET = 'ghp_test_secret_value_123';
/** Every local connector starts in the Workspace sandbox (connector-launch.ts); without bubblewrap it is left out. */
const bwrap = sandboxBinary();
/** A library command as a turn's CLI is given it: `/bin/sh` starting bubblewrap from its launch file. */
const launched = (g: { command: string; args: string[]; env: Record<string, string> }, command: string[]) => {
  assert.equal(g.command, '/bin/sh');
  assert.deepEqual(g.env, {});
  assert.deepEqual(g.args.slice(0, 4), ['-c', LAUNCH_SCRIPT, 'sh', 'bin' in bwrap && bwrap.bin]);
  assert.equal(dirname(g.args[5]!), join(home, 'run', 'connectors'));
  assert.deepEqual(g.args.slice(6), command);
  return g.args[5]!;
};
const HEADER_SECRET = 'Bearer lin_api_secret_456';

const newBot = (provider: string, over: Record<string, unknown> = {}) => s.newBot(`${provider} bot`, { provider, ...over });
const hookedRoutine = (bot: Bot, name = 'Issues') => s.newRoutine(bot.id, { name, instruction: 'Triage the issue.', webhook: true });

async function addServer(body: Record<string, unknown>): Promise<McpServer> {
  const { status, data } = await call<McpServer>('POST', '/api/mcp-servers', body);
  assert.equal(status, 201, JSON.stringify(data));
  return data;
}

/** Run `go` (a turn or a routine run) with the fake CLI replying; resolve with its one call. */
async function callOf(cli: FakeCli, go: () => Promise<unknown>) {
  cli.script(`${basename(cli.bin)}/reply`);
  await go();
  return cli.calls()[0];
}

async function runRoutine(routine: Routine, trigger: 'webhook' | 'manual' | 'test'): Promise<void> {
  const run = app.engine.triggerRoutine(routine.id, trigger, trigger === 'manual' ? null : '{"action":"opened"}');
  await until(() => {
    const r = app.store.findRun(run.id);
    return r && r.status !== 'queued' && r.status !== 'running' && app.engine.statusOf(routine.botId).state === 'idle';
  });
}

test('the library keeps env and header values write-only: never in any response', async () => {
  const github = await addServer({ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET, DEBUG: '1' } });
  assert.deepEqual(github.envKeys, ['DEBUG', 'GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.equal(github.command, 'npx');
  const linear = await addServer({ name: 'linear', transport: 'http', url: 'https://mcp.example.com/mcp?team=1', headers: { Authorization: HEADER_SECRET } });
  assert.deepEqual(linear.headerKeys, ['Authorization']);

  const responses = [
    await call('GET', '/api/mcp-servers'),
    await call('GET', '/api/mcp-servers/github'),
    await call('GET', '/api/connectors'),
    await call('PATCH', '/api/mcp-servers/github', { env: { DEBUG: null } }),
  ];
  for (const r of responses) {
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.data);
    assert.ok(!text.includes(SECRET) && !text.includes(HEADER_SECRET), text);
  }
  // The PATCH removed DEBUG and kept the token it left out.
  assert.deepEqual((responses[3].data as McpServer).envKeys, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  const catalog = (responses[2].data as ConnectorCatalog).connectors;
  const lin = catalog.find((c) => c.id === 'lib:linear')!;
  assert.equal(lin.target, 'https://mcp.example.com/mcp?…');
  assert.deepEqual(lin.providers.sort(), ['anthropic-api', 'claude-cli', 'codex-cli', 'openai-api']);
  assert.equal(catalog.find((c) => c.id === 'lib:github')!.target, 'npx -y @modelcontextprotocol/server-github');
});

test('library input is checked', async () => {
  const bad: [Record<string, unknown>, number, RegExp][] = [
    [{ name: 'Bad Name', transport: 'stdio', command: 'x' }, 400, /name must be/],
    [{ name: 'nocmd', transport: 'stdio' }, 400, /needs a command/],
    [{ name: 'nourl', transport: 'http' }, 400, /needs a URL/],
    [{ name: 'creds', transport: 'http', url: 'https://user:pw@example.com/mcp' }, 400, /not in the URL/],
    [{ name: 'ftp', transport: 'http', url: 'ftp://example.com' }, 400, /http/],
    [{ name: 'reserved', transport: 'stdio', command: 'x', env: { BOTON_TOKEN: 'x' } }, 400, /reserved/],
    [{ name: 'badkey', transport: 'stdio', command: 'x', env: { 'A-B': 'x' } }, 400, /not a valid name/],
    [{ name: 'crlf', transport: 'http', url: 'https://x.test', headers: { 'X-Key': 'a\r\nInjected: 1' } }, 400, /one line/],
    [{ name: 'kind', transport: 'ws', command: 'x' }, 400, /transport/],
    [{ name: 'github', transport: 'stdio', command: 'x' }, 409, /already/],
  ];
  for (const [body, status, message] of bad) {
    const r = await call<{ error: string }>('POST', '/api/mcp-servers', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.data.error, message);
  }
  const rename = await call<{ error: string }>('PATCH', '/api/mcp-servers/github', { name: 'other' });
  assert.equal(rename.status, 400);
  assert.equal((await call('PATCH', '/api/mcp-servers/nope', { command: 'x' })).status, 404);
});

test('only paired devices reach connectors and the library: a Boton token gets 403', async () => {
  const bot = await newBot('mock');
  const boton = app.auth.mintBotonToken(bot.id);
  try {
    for (const [method, path] of [
      ['GET', '/api/connectors'],
      ['GET', `/api/bots/${bot.id}/connector-notices`],
      ['DELETE', `/api/bots/${bot.id}/connector-notices/lib:github`],
      ['GET', '/api/mcp-servers'],
      ['GET', '/api/mcp-servers/github'],
      ['POST', '/api/mcp-servers'],
      ['PATCH', `/api/bots/${bot.id}`],
    ] as const) {
      const r = await call(method, path, method === 'GET' ? undefined : { name: 'x', transport: 'stdio', command: 'x', connections: ['lib:github'] }, boton.token);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  } finally {
    boton.revoke();
  }
});

test('a Boton can only be given known connectors; deleting a library server takes it off every Boton', async () => {
  await addServer({ name: 'scratch', transport: 'stdio', command: 'scratch-mcp' });
  const bot = await newBot('claude-cli', { connections: ['lib:scratch'] });
  assert.deepEqual(bot.connections, ['lib:scratch']);
  const bad = await call<{ error: string }>('PATCH', `/api/bots/${bot.id}`, { connections: ['lib:nope'] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Unknown connector lib:nope/);
  assert.equal((await call('PATCH', `/api/bots/${bot.id}`, { connections: 'lib:scratch' })).status, 400);

  assert.equal((await call('DELETE', '/api/mcp-servers/scratch')).status, 200);
  assert.deepEqual((await call<Bot>('GET', `/api/bots/${bot.id}`)).data.connections, []);
});

test('claude: an opted-in server reaches the CLI in a private file, its tools are allowed in Workspace (Full computer needs no rules), and toggling keeps the session', { skip: 'problem' in bwrap && bwrap.problem }, async () => {
  const bot = await newBot('claude-cli', { connections: ['lib:github', 'lib:linear'] });
  claude.script('claude/reply');
  const reply = await turn(bot.id, 'hello');
  assert.equal(reply.role, 'bot', reply.text);
  const [first] = claude.calls();
  const path = first.argv[first.argv.indexOf('--mcp-config') + 1];
  assert.equal(join(path, '..'), join(home, 'run'));
  assert.ok(!first.argv.join(' ').includes(SECRET) && !first.argv.join(' ').includes(HEADER_SECRET), 'no secret on the command line');
  assert.ok(!JSON.stringify(first.env).includes(SECRET), 'no secret in the agent environment');
  const given = JSON.parse(first.mcpConfigFile!).mcpServers;
  // Its secret is only in its launch file, which bubblewrap reads: not in the CLI's settings, environment or command line.
  assert.ok(!JSON.stringify(given).includes(SECRET));
  const launch = launched(given.github, ['npx', '-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(given.linear, { type: 'http', url: 'https://mcp.example.com/mcp?team=1', headers: { Authorization: HEADER_SECRET } });
  assert.ok(!existsSync(launch), 'its launch file is removed when the turn ends');
  // Gone once the turn ends. (run/agents records running CLIs' process groups; run/connectors keeps the socket filter.)
  assert.ok(!existsSync(path));
  assert.deepEqual(readdirSync(join(home, 'run')).filter((n) => n !== 'agents' && n !== 'connectors'), []);
  assert.deepEqual(readdirSync(join(home, 'run', 'connectors')), ['seccomp.bpf']);
  assert.deepEqual(readdirSync(join(home, 'run', 'agents')), []);
  const allowed = first.argv.slice(first.argv.indexOf('--allowedTools') + 1);
  assert.ok(allowed.includes('mcp__github') && allowed.includes('mcp__linear'), allowed.join(' '));
  assert.match(first.stdin, /Your connectors \(MCP servers [^)]*\):\n- github\n- linear\n\n/);
  assert.ok(!first.stdin.includes(SECRET));
  const sessionBefore = app.store.getBot(bot.id).sessionId;
  assert.ok(sessionBefore);

  // Unchecking one: the next turn resumes the same session without it.
  assert.equal((await call('PATCH', `/api/bots/${bot.id}`, { connections: ['lib:linear'] })).status, 200);
  const second = await callOf(claude, () => turn(bot.id, 'again'));
  assert.ok(second.argv.join(' ').includes(`--resume ${sessionBefore}`), 'same session');
  assert.deepEqual(Object.keys(JSON.parse(second.mcpConfigFile!).mcpServers), ['linear']);
  assert.ok(!second.argv.includes('mcp__github'));
  assert.equal(app.store.getBot(bot.id).sessionId, sessionBefore);

  // None at all: no file, no MCP rules, nothing in the context block.
  await call('PATCH', `/api/bots/${bot.id}`, { connections: [] });
  const third = await callOf(claude, () => turn(bot.id, 'and again'));
  assert.equal(third.argv[third.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(!third.argv.some((a) => a.startsWith('mcp__')));
  assert.ok(!third.stdin.includes('Your connectors'));
  assert.equal(app.store.getBot(bot.id).sessionId, sessionBefore);

  const host = await newBot('claude-cli', { access: 'host', connections: ['lib:github'] });
  const c = await callOf(claude, () => turn(host.id, 'hello'));
  assert.ok(c.argv.includes('--dangerously-skip-permissions'));
  assert.ok(!c.argv.includes('mcp__github'));
  assert.deepEqual(Object.keys(JSON.parse(c.mcpConfigFile!).mcpServers), ['github']);
  // Full computer: in the same sandbox. The Boton's access isn't what its connector's command is trusted with.
  const { type, ...hostGiven } = JSON.parse(c.mcpConfigFile!).mcpServers.github;
  assert.equal(type, 'stdio');
  launched(hostGiven, ['npx', '-y', '@modelcontextprotocol/server-github']);
});

test('codex: opted-in servers become -c overrides, with secrets only in the codex environment (a header) or the launch file (a command), and kept from its shell', { skip: 'problem' in bwrap && bwrap.problem }, async () => {
  const bot = await newBot('codex-cli', { connections: ['lib:github', 'lib:linear'] });
  codex.script('codex/reply');
  const reply = await turn(bot.id, 'hello');
  assert.equal(reply.role, 'bot', reply.text);
  const [c] = codex.calls();
  const argv = c.argv.join('\n');
  assert.ok(!argv.includes(SECRET) && !argv.includes(HEADER_SECRET), 'no secret on the command line');
  // In the Workspace sandbox (connector-launch.ts), its environment in its launch file.
  const jailed = c.argv.find((a) => a.startsWith('mcp_servers.github.args='))!;
  launched({ command: '/bin/sh', env: {}, args: JSON.parse(jailed.slice(jailed.indexOf('=') + 1)) }, ['npx', '-y', '@modelcontextprotocol/server-github']);
  assert.ok(!c.argv.some((a) => a.startsWith('mcp_servers.github.env')), 'no environment of its own for Codex to pass');
  for (const arg of [
    'mcp_servers.github.command="/bin/sh"',
    'mcp_servers.github.default_tools_approval_mode="approve"',
    'mcp_servers.linear.default_tools_approval_mode="approve"',
    'mcp_servers.linear.url="https://mcp.example.com/mcp?team=1"',
    'mcp_servers.linear.env_http_headers={"Authorization"="BOTONS_MCP_1_0"}',
    'shell_environment_policy.exclude=["BOTONS_MCP_1_0"]',
  ]) {
    assert.ok(c.argv.includes(arg), `${arg} in\n${argv}`);
  }
  assert.equal(c.env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(c.env.BOTONS_MCP_1_0, HEADER_SECRET);
  assert.match(c.stdin, /Your connectors[^\n]*\n- github\n- linear\n/);
});

test('codexMcp: agent variables go in env, a clash or an unsupported server is left out', () => {
  const { args, env } = codexMcp([
    { name: 'a', kind: 'stdio', command: 'a', args: [], env: { PATH: '/opt/bin', TOKEN: 'x' } },
    { name: 'b', kind: 'stdio', command: 'b', args: [], env: { TOKEN: 'y' } },
    { name: 'c', kind: 'http', url: 'https://c.test', headers: {}, sse: true },
    { name: 'd', kind: 'stdio', command: 'd', args: ['--x'], env: { TOKEN: 'x' }, cwd: '/srv' },
  ]);
  assert.deepEqual(env, { TOKEN: 'x' });
  assert.ok(args.includes('mcp_servers.a.env={"PATH"="/opt/bin"}'));
  assert.ok(args.includes('mcp_servers.d.cwd="/srv"'));
  for (const left of ['mcp_servers.b.', 'mcp_servers.c.']) assert.ok(!args.some((a) => a.includes(left)), left);
  assert.deepEqual(args.slice(-2), ['-c', 'shell_environment_policy.exclude=["TOKEN"]']);
});

test('a webhook run gets no connectors, and its context block says they are off; other runs and chat keep them', async (t) => {
  const logs = captureLogs();
  t.after(logs.restore);
  for (const access of ['workspace', 'host'] as const) {
    const bot = await newBot('claude-cli', { access, connections: ['lib:github', 'lib:linear'] });
    const routine = await hookedRoutine(bot);

    const hooked = await callOf(claude, () => runRoutine(routine, 'webhook'));
    assert.equal(hooked.argv[hooked.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}', access);
    assert.equal(hooked.mcpConfigFile, undefined);
    assert.ok(!hooked.argv.some((a) => a.startsWith('mcp__')), access);
    assert.ok(!hooked.stdin.includes('- github'), access);
    assert.match(hooked.stdin, /Your connectors \(MCP servers [^)]*\) are off in this run, because a webhook started it\./);
    assert.ok(logs.lines.some((l) => l.msg === 'connectors left out of the turn: a webhook started it' && l.botId === bot.id));

    const manual = await callOf(claude, () => runRoutine(routine, 'manual'));
    assert.deepEqual(Object.keys(JSON.parse(manual.mcpConfigFile!).mcpServers), ['github', 'linear'], access);
    assert.match(manual.stdin, /Your connectors \([^\n]*\n- github\n- linear\n/);
    assert.ok(!manual.stdin.includes('are off in this run'));
  }
  const bot = await newBot('codex-cli', { connections: ['lib:github'] });
  const routine = await hookedRoutine(bot);
  const c = await callOf(codex, () => runRoutine(routine, 'webhook'));
  assert.ok(!c.argv.some((a) => a.startsWith('mcp_servers.')), c.argv.join(' '));
  assert.equal(c.env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
});

test("a test run of a routine with a webhook gets no connectors, like its webhook runs; one of a routine without a webhook keeps them", async () => {
  const bot = await newBot('claude-cli', { access: 'host', connections: ['lib:github'] });
  const hooked = await hookedRoutine(bot, 'Hooked');
  const tested = await callOf(claude, () => runRoutine(hooked, 'test'));
  assert.equal(tested.argv[tested.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(!tested.argv.some((a) => a.startsWith('mcp__')));
  assert.match(tested.stdin, /Your connectors \(MCP servers [^)]*\) are off in this run, because it tests the routine's webhook\./);

  const plain = await s.newRoutine(bot.id, { name: 'Plain', instruction: 'Look around.' });
  const dry = await callOf(claude, () => runRoutine(plain, 'test'));
  assert.deepEqual(Object.keys(JSON.parse(dry.mcpConfigFile!).mcpServers), ['github']);
  assert.ok(!dry.stdin.includes('are off in this run'));
});

test('a local connector its sandbox refuses is left out of the turn, and the context block and the owner are told why', { skip: 'problem' in bwrap && bwrap.problem }, async () => {
  // Two with the same variable no longer clash on Codex: each one's environment is in its own launch file.
  await addServer({ name: 'tok-a', transport: 'stdio', command: 'a-mcp', env: { SHARED_TOKEN: 'one' } });
  await addServer({ name: 'tok-b', transport: 'stdio', command: 'b-mcp', env: { SHARED_TOKEN: 'two' } });
  // Its script is in the shared folder, which a Workspace Boton can rewrite: refused for every Boton.
  await addServer({ name: 'tok-c', transport: 'stdio', command: process.execPath, args: [join(home, 'shared')] });
  const bot = await newBot('codex-cli', { access: 'host', connections: ['lib:tok-a', 'lib:tok-b', 'lib:tok-c'] });
  const c = await callOf(codex, () => turn(bot.id, 'hello'));
  assert.match(c.stdin, /Your connectors[^\n]*\n- tok-a\n- tok-b\n(?!- tok-c)/);
  const why = /^not started: .*shared \(named by its command\) can't be shown to it/;
  // Named only as one this turn goes without, with why; the owner sees the same in its settings.
  assert.match(c.stdin, /this turn goes without[^\n]*\n- lib:tok-c: not started: [^\n]*can't be shown to it/);
  const notices = app.connectors.notices(app.store.getBot(bot.id)).map((n) => [n.connectorId, n.kind, n.reason]);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]!.slice(0, 2), ['lib:tok-c', 'skipped']);
  assert.match(String(notices[0]![2]), why);
  assert.ok(!c.argv.some((a) => a.startsWith('mcp_servers.tok-c.')));
  assert.equal(c.env.SHARED_TOKEN, undefined);
});

test('connectors are in the context block, not the system prompt, so they never change the session key', () => {
  const cfg = app.store.getBot((app.store.listBots()[0] as Bot).id);
  const settings = { ownerName: 'Sam' };
  const sysA = systemPrompt({ ...cfg, connections: [] }, settings, s.cfg);
  const sysB = systemPrompt({ ...cfg, connections: ['lib:github', 'oauth:notes'] }, settings, s.cfg);
  assert.equal(sessionKey('claude-cli', sysA), sessionKey('claude-cli', sysB));
  const ctx = contextBlock(cfg, settings, { kind: 'chat' }, [], [], { connectors: ['github', 'notes'] });
  // Passed to the turn, not promised to work: the CLI may not start one.
  assert.match(ctx, /Your connectors \(MCP servers Sam gave you, passed to this turn; [^)]*If one's tools are missing, it didn't start: say so if the work needs it\):\n- github\n- notes\n<\/boton_context>$/);
  assert.ok(!ctx.includes('are yours'));
  // What it goes without, what its last turn went without, and what an upgrade took off it, are context too.
  const told = contextBlock(cfg, settings, { kind: 'chat' }, [], [], {
    connectorsLeftOut: [{ id: 'oauth:linear', reason: 'needs signing in again' }],
    connectorsLastTurn: [{ id: 'lib:github', reason: 'Claude Code could not start it' }],
    connectorsRemoved: ['notes'],
  });
  assert.match(told, /Connectors your last turn went without, passed to this one again \(Sam sees this in your settings\):\n- lib:github: Claude Code could not start it\n/);
  assert.match(told, /Connectors you have that this turn goes without \(Sam sees this in your settings; say so if the work needs one\):\n- oauth:linear: needs signing in again\n/);
  assert.match(told, /Connectors taken off you because Botons no longer uses the MCP servers in Claude Code's or Codex's own settings \(Sam was told and can give you a Botons connector instead\): notes\n/);
  assert.equal(sessionKey('claude-cli', systemPrompt(cfg, settings, s.cfg)), sessionKey('claude-cli', sysA));
  assert.ok(!contextBlock(cfg, settings, { kind: 'chat' }, [], []).includes('Your connectors'));
});

test('claudeArgs: the MCP rules follow the servers; claudeMcpConfig shapes each kind', () => {
  const servers: TurnMcpServer[] = [
    { name: 'docs', kind: 'http' as const, url: 'https://mcp.docs.example.com/mcp', headers: { Authorization: 'Bearer x' } },
    { name: 'events', kind: 'http' as const, url: 'https://e.test/sse', headers: {}, sse: true },
  ];
  const argv = claudeArgs({ systemPrompt: 'x', model: '', sessionId: null, access: 'workspace', privatePaths: [], cwd: '/ws', mcpServers: servers }, '/data/run/mcp-1.json');
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], '/data/run/mcp-1.json');
  assert.deepEqual(argv.slice(-2), ['mcp__docs', 'mcp__events']);
  assert.equal(claudeMcpRule('plugin:example:mail'), 'mcp__plugin_example_mail');
  assert.deepEqual(JSON.parse(claudeMcpConfig(servers)).mcpServers, {
    docs: { type: 'http', url: 'https://mcp.docs.example.com/mcp', headers: { Authorization: 'Bearer x' } },
    events: { type: 'sse', url: 'https://e.test/sse', headers: {} },
  });
});

test('codexMcp: startup and tool timeouts go with a server; none are added when it has none', () => {
  const { args } = codexMcp([
    { name: 'wiki', kind: 'http', url: 'https://w.test', headers: {}, startupTimeoutSec: 45, toolTimeoutSec: 2.5 },
    { name: 'odd', kind: 'stdio', command: 'odd', args: [], env: {} },
  ]);
  assert.ok(args.includes('mcp_servers.wiki.startup_timeout_sec=45.0') && args.includes('mcp_servers.wiki.tool_timeout_sec=2.5'));
  assert.ok(!args.some((a) => a.startsWith('mcp_servers.odd.') && a.includes('timeout')));
});
