// What a turn's CLI actually had of the connectors Botons gave it. The fake CLIs start every server they are given
// from exactly what the server passed them (Claude Code's --mcp-config file; Codex's -c overrides and environment),
// and report it the way each real CLI does: Claude Code in its init event (each server's status, its tools), Codex
// not at all (`codex exec --json` has no MCP startup event; only a tool call it ran shows a server started).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Bot, ConnectorNotice } from '../../shared/types.ts';
import { captureLogs, type LogLine } from '../src/log.ts';
import { claudeArgs, claudeMcpStartup } from '../src/providers/claude-cli.ts';
import { codexArgs, codexMcp } from '../src/providers/codex-cli.ts';
import type { Call, FakeCli, Step } from './fixtures/fake-cli.ts';
import type { TestServer } from './helpers.ts';
import { useTestCodexHome } from './helpers.ts';
import { addConnector, setup, signIn } from './oauth-helpers.ts';

const STDIO_MCP = join(import.meta.dirname, 'fixtures/fake-stdio-mcp.ts');
const FLEET_TOOLS = ['fleet_status', 'work_start', 'work_status', 'work_feed'];

type Clis = TestServer & { claude: FakeCli; codex: FakeCli };

async function turnOf(s: Clis, bot: Bot, step: Omit<Step, 'fixture'> = {}): Promise<Call> {
  const cli = bot.provider === 'codex-cli' ? s.codex : s.claude;
  cli.script({ fixture: `${bot.provider === 'codex-cli' ? 'codex' : 'claude'}/reply`, ...step });
  const reply = await s.chat(bot.id, 'Check the fleet.');
  assert.equal(reply.role, 'bot', reply.text);
  const calls = cli.calls();
  assert.equal(calls.length, 1);
  return calls[0];
}

const noticesOf = async (s: TestServer, botId: string) => {
  const r = await s.call<ConnectorNotice[]>('GET', `/api/bots/${botId}/connector-notices`);
  assert.equal(r.status, 200, r.text);
  return r.data.map((n) => [n.connectorId, n.kind, n.reason]);
};

/** The engine's account of the bot's latest turn: started (with tool counts, when the CLI lists them), not, unconfirmed. */
function endOf(lines: LogLine[], botId: string) {
  const l = lines.filter((x) => x.msg === 'connectors at the end of the turn' && x.botId === botId).at(-1);
  assert.ok(l, 'no end-of-turn connector line');
  return { level: l.level, started: l.started, tools: l.tools, notStarted: l.notStarted, unconfirmed: l.unconfirmed };
}

const bearerOf = (call: Call) => JSON.parse(call.mcpConfigFile!).mcpServers.notes.headers.Authorization as string;


/** Moves a Boton to another brain, confirming what the move's preview shows (its session there ends). */
async function move(s: { call: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any; text: string }> }, botId: string, provider: string) {
  const preview = await s.call('POST', `/api/bots/${botId}/switch-preview`, { provider });
  assert.equal(preview.status, 200, preview.text);
  const res = await s.call('PATCH', `/api/bots/${botId}`, { provider, switchConfirmation: preview.data.confirmation ?? undefined });
  assert.equal(res.status, 200, res.text);
}

test('both brains start a signed-in connector from what Botons passes them, with the tools its server lists', async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  const logs = captureLogs();
  try {
    const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['oauth:notes'] });
    const onClaude = await turnOf(s, kevin);
    assert.deepEqual(onClaude.mcp, { notes: { status: 'connected', tools: FLEET_TOOLS } });
    // The CLI reached the server with the token Botons put in its config.
    const token = bearerOf(onClaude).replace(/^Bearer /, '');
    assert.ok(fake.mcpCalls.some((c) => c.method === 'tools/list' && c.token === token));
    // Its init event listed the server connected with those tools, so the engine knows the turn had them.
    assert.deepEqual(endOf(logs.lines, kevin.id), { level: 'info', started: ['notes'], tools: { notes: 4 }, notStarted: [], unconfirmed: [] });
    assert.ok(logs.lines.some((l) => l.msg === 'turn started' && l.botId === kevin.id && JSON.stringify(l.connectorsGiven) === '["notes"]'));
    assert.deepEqual(await noticesOf(s, kevin.id), []);

    // Codex starts it too (the token goes through its environment), but its output never says so.
    await move(s, kevin.id, 'codex-cli');
    const moved = { ...kevin, provider: 'codex-cli' };
    const onCodex = await turnOf(s, moved);
    assert.deepEqual(onCodex.mcp, { notes: { status: 'connected', tools: FLEET_TOOLS } });
    assert.deepEqual(endOf(logs.lines, kevin.id), { level: 'info', started: [], tools: undefined, notStarted: [], unconfirmed: ['notes'] });
    // A call Codex reports failed (here the server's own error answer) confirms nothing: its item says only `failed`.
    const failedCall = await turnOf(s, moved, { mcp: { call: { server: 'notes', tool: 'work_status', arguments: { jobId: 'nope' } } } });
    assert.equal(failedCall.mcp?.notes.status, 'connected');
    assert.deepEqual(endOf(logs.lines, kevin.id), { level: 'info', started: [], tools: undefined, notStarted: [], unconfirmed: ['notes'] });
    // A tool call Codex ran on it is the proof it started.
    fake.jobs.job1 = { jobId: 'job1', state: 'running' };
    const called = await turnOf(s, moved, { mcp: { call: { server: 'notes', tool: 'work_status', arguments: { jobId: 'job1' } } } });
    assert.equal(called.mcp?.notes.status, 'connected');
    assert.deepEqual(fake.statusCalls.at(-1), { jobId: 'job1', token });
    assert.deepEqual(endOf(logs.lines, kevin.id), { level: 'info', started: ['notes'], tools: undefined, notStarted: [], unconfirmed: [] });
    assert.deepEqual(await noticesOf(s, kevin.id), []);
  } finally {
    logs.restore();
  }
});

test('a connector whose server refuses the sign-in: Claude Code says so, the owner and the next turn are told; on Codex it is only unconfirmed', async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  const logs = captureLogs();
  try {
    const dave = await s.newBot('Dave', { provider: 'claude-cli', connections: ['oauth:notes'] });
    const ok = await turnOf(s, dave);
    // Revoked at the server: Botons still holds a token it thinks is good, and passes it on.
    fake.revoked.add(bearerOf(ok).replace(/^Bearer /, ''));

    const refused = await turnOf(s, dave);
    assert.equal(refused.mcp?.notes.status, 'needs-auth');
    const why = 'Claude Code could not start it: the server refused its sign-in';
    assert.deepEqual(endOf(logs.lines, dave.id), { level: 'warn', started: [], tools: undefined, notStarted: [{ name: 'notes', reason: why }], unconfirmed: [] });
    assert.deepEqual(await noticesOf(s, dave.id), [['oauth:notes', 'skipped', why]]);
    // `botons connector list` doesn't call it working either.
    const listed = await s.call<{ id: string; usable: boolean }[]>('GET', `/api/bots/${dave.id}/connectors`);
    assert.deepEqual(listed.data.map((c) => [c.id, c.usable]), [['oauth:notes', false]]);

    const next = await turnOf(s, dave);
    assert.match(next.stdin, new RegExp(`Connectors your last turn went without, passed to this one again \\([^)]*\\):\\n- oauth:notes: ${why}\\n`));
    assert.deepEqual(await noticesOf(s, dave.id), [['oauth:notes', 'skipped', why]]);

    // Codex hits the same refusal (the fake records it) but reports nothing, so nothing is claimed either way.
    await move(s, dave.id, 'codex-cli');
    const onCodex = await turnOf(s, { ...dave, provider: 'codex-cli' });
    assert.equal(onCodex.mcp?.notes.status, 'needs-auth');
    assert.deepEqual(endOf(logs.lines, dave.id), { level: 'info', started: [], tools: undefined, notStarted: [], unconfirmed: ['notes'] });
    assert.deepEqual(await noticesOf(s, dave.id), []);
  } finally {
    logs.restore();
  }
});

test('a connector still starting when the turn begins: pending on Claude Code (told as such), timed out on Codex (unconfirmed)', async () => {
  const { s, fake } = await setup();
  useTestCodexHome(s.cfg.home);
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  const logs = captureLogs();
  const hold = fake.holdToolsList();
  try {
    const stuart = await s.newBot('Stuart', { provider: 'claude-cli', connections: ['oauth:notes'] });
    const slow = await turnOf(s, stuart, { mcp: { waitMs: 300 } });
    assert.deepEqual(slow.mcp, { notes: { status: 'pending', tools: [] } });
    const why = 'it was still starting when the turn began, so the turn may not have had its tools';
    assert.deepEqual(await noticesOf(s, stuart.id), [['oauth:notes', 'skipped', why]]);

    await move(s, stuart.id, 'codex-cli');
    const onCodex = await turnOf(s, { ...stuart, provider: 'codex-cli' }, { mcp: { waitMs: 300 } });
    assert.deepEqual(onCodex.mcp, { notes: { status: 'failed', tools: [], error: 'timed out after 0.3 seconds' } });
    assert.deepEqual(endOf(logs.lines, stuart.id).unconfirmed, ['notes']);
  } finally {
    hold.release();
    logs.restore();
  }
});

test('a connector Claude Code has cached tools for starts pending: only a call that ran on it shows it started, not the request', async () => {
  const { s, fake } = await setup();
  const notes = await addConnector(s, fake, 'notes');
  await signIn(s, fake, notes.id);
  const logs = captureLogs();
  try {
    const kevin = await s.newBot('Kevin', { provider: 'claude-cli', connections: ['oauth:notes'] });
    const why = 'it was still starting when the turn began, so the turn may not have had its tools';
    const cached = (jobId: string, more: { noResult?: boolean } = {}) => ({ mcp: { cached: FLEET_TOOLS, call: { server: 'notes', tool: 'work_status', arguments: { jobId } }, ...more } });
    const stillPending = { level: 'warn', started: [], tools: undefined, notStarted: [{ name: 'notes', reason: why }], unconfirmed: [] };

    // The call connected it and ran: started, whatever init said.
    fake.jobs.job1 = { jobId: 'job1', state: 'running' };
    const ran = await turnOf(s, kevin, cached('job1'));
    assert.equal(ran.mcp?.notes.status, 'connected');
    const token = bearerOf(ran).replace(/^Bearer /, '');
    assert.deepEqual(fake.statusCalls.at(-1), { jobId: 'job1', token });
    assert.deepEqual(endOf(logs.lines, kevin.id), { level: 'info', started: ['notes'], tools: { notes: 4 }, notStarted: [], unconfirmed: [] });
    assert.deepEqual(await noticesOf(s, kevin.id), []);

    // The call was asked for but its result never came: init's word stands.
    await turnOf(s, kevin, cached('job1', { noResult: true }));
    assert.deepEqual(endOf(logs.lines, kevin.id), stillPending);
    assert.deepEqual(await noticesOf(s, kevin.id), [['oauth:notes', 'skipped', why]]);

    // The server answered with an error of its own. Claude Code's stream marks it is_error like a failed connect, with
    // no field telling them apart, so it is no proof either: the warning stays rather than a guess from its text.
    const refusedJob = await turnOf(s, kevin, cached('nope'));
    assert.equal(refusedJob.mcp?.notes.status, 'connected');
    assert.deepEqual(endOf(logs.lines, kevin.id), stillPending);

    // Revoked at the server: the deferred connect fails, so the call is an error result and the owner and next turn are told.
    fake.revoked.add(token);
    const refused = await turnOf(s, kevin, cached('job1'));
    assert.equal(refused.mcp?.notes.status, 'needs-auth');
    assert.deepEqual(endOf(logs.lines, kevin.id), stillPending);
    assert.deepEqual(await noticesOf(s, kevin.id), [['oauth:notes', 'skipped', why]]);
    const next = await turnOf(s, kevin);
    assert.match(next.stdin, new RegExp(`Connectors your last turn went without, passed to this one again \\([^)]*\\):\\n- oauth:notes: ${why}\\n`));
  } finally {
    logs.restore();
  }
});

test('a local (stdio) connector gets its secret on both brains; one that fails to start is a notice on Claude Code', { skip: process.platform !== 'linux' && 'Requires the Linux Workspace sandbox and directory handles' }, async () => {
  const { s } = await setup();
  useTestCodexHome(s.cfg.home);
  const created = await s.call('POST', '/api/mcp-servers', {
    name: 'notes',
    transport: 'stdio',
    command: process.execPath,
    args: ['--no-warnings', STDIO_MCP, '--need', `NOTES_TOKEN=${createHash('sha256').update('right-secret').digest('hex')}`, '--tools', 'lookup,save'],
    env: { NOTES_TOKEN: 'right-secret' },
  });
  assert.equal(created.status, 201, created.text);
  const logs = captureLogs();
  try {
    const bob = await s.newBot('Bob', { provider: 'claude-cli', connections: ['lib:notes'] });
    assert.deepEqual((await turnOf(s, bob)).mcp, { notes: { status: 'connected', tools: ['lookup', 'save'] } });
    assert.deepEqual(endOf(logs.lines, bob.id).tools, { notes: 2 });

    // Codex: the secret is in its environment, named by env_vars, never on its command line.
    await move(s, bob.id, 'codex-cli');
    const onCodex = await turnOf(s, { ...bob, provider: 'codex-cli' }, { mcp: { call: { server: 'notes', tool: 'lookup', arguments: { q: 'x' } } } });
    assert.deepEqual(onCodex.mcp, { notes: { status: 'connected', tools: ['lookup', 'save'] } });
    assert.ok(!onCodex.argv.some((a) => a.includes('right-secret')));
    assert.deepEqual(endOf(logs.lines, bob.id).started, ['notes']);

    // The wrong secret: the server exits at once.
    assert.equal((await s.call('PATCH', '/api/mcp-servers/notes', { env: { NOTES_TOKEN: 'wrong' } })).status, 200);
    await move(s, bob.id, 'claude-cli');
    const failed = await turnOf(s, bob);
    assert.equal(failed.mcp?.notes.status, 'failed');
    assert.match(failed.mcp!.notes.error!, /NOTES_TOKEN is not set to what it needs/);
    assert.deepEqual(await noticesOf(s, bob.id), [['lib:notes', 'skipped', 'Claude Code could not start it']]);
  } finally {
    logs.restore();
  }
});

test("claudeMcpStartup: each server as Claude Code's init event shows it; a tool call that ran proves one started", () => {
  const init = {
    tools: ['Bash', 'mcp__notes__find', 'mcp__notes__save', 'mcp__wiki__read', 'mcp__team_wiki__page'],
    mcp_servers: [
      { name: 'notes', status: 'connected' },
      { name: 'wiki', status: 'failed' },
      { name: 'mail', status: 'needs-auth' },
      { name: 'slow', status: 'pending' },
      { name: 'off', status: 'disabled' },
      { name: 'empty', status: 'connected' },
      { name: 'team.wiki', status: 'connected' },
      { name: 'odd', status: 'Weird <b>' },
    ],
  };
  const names = ['notes', 'wiki', 'mail', 'slow', 'off', 'empty', 'team.wiki', 'odd', 'gone'];
  assert.deepEqual(claudeMcpStartup(init, names, new Set()), [
    { name: 'notes', started: true, tools: ['find', 'save'] },
    { name: 'wiki', started: false, tools: ['read'], reason: 'Claude Code could not start it' },
    { name: 'mail', started: false, tools: [], reason: 'Claude Code could not start it: the server refused its sign-in' },
    { name: 'slow', started: false, tools: [], reason: 'it was still starting when the turn began, so the turn may not have had its tools' },
    { name: 'off', started: false, tools: [], reason: 'Claude Code had it turned off' },
    { name: 'empty', started: false, tools: [], reason: 'Claude Code connected to it, but it listed no tools' },
    // Its tools are under the name with the dot made an underscore, as Claude Code names them.
    { name: 'team.wiki', started: true, tools: ['page'] },
    // A status from the CLI is only repeated when it is a plain word.
    { name: 'odd', started: false, tools: [], reason: 'Claude Code did not connect it' },
    { name: 'gone', started: false, tools: [], reason: 'Claude Code did not load it' },
  ]);
  // A server still starting at init that one of the turn's tool calls then ran on did start.
  assert.deepEqual(claudeMcpStartup(init, ['slow'], new Set(['slow'])), [{ name: 'slow', started: true, tools: [] }]);
});

test("neither CLI loads MCP servers from the user's or the workspace's own config, at any access level", () => {
  const base = { systemPrompt: 'S', model: '', sessionId: null, cwd: '/home/you/ws', privatePaths: [] };
  for (const access of ['host', 'workspace'] as const) {
    // Claude Code: only the --mcp-config file's servers (--strict-mcp-config ignores .mcp.json and every settings
    // file's), and no user settings at all.
    const c = claudeArgs({ ...base, access });
    assert.ok(c.includes('--strict-mcp-config'));
    assert.equal(c[c.indexOf('--setting-sources') + 1], 'project,local');
    // Codex: no $CODEX_HOME/config.toml, and nothing that marks the workspace trusted, so a .codex/config.toml in it
    // stays disabled (Codex loads a project's config only for a project the effective config trusts).
    const mcp = codexMcp([{ name: 'notes', kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } }]);
    const x = codexArgs({ ...base, access }, mcp.args);
    assert.ok(x.includes('--ignore-user-config'));
    const overrides = x.flatMap((a, i) => (x[i - 1] === '-c' ? [a] : []));
    assert.deepEqual(overrides.filter((o) => /^(projects|profile|profiles|mcp_servers)\b/.test(o) && !o.startsWith('mcp_servers.notes.')), []);
  }
});
