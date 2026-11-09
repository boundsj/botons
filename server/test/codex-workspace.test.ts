import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeCodexWorkspace } from '../src/providers/codex-workspace.ts';
import { CodexCliProvider } from '../src/providers/codex-cli.ts';
import { diagnose } from '../../scripts/doctor.ts';
import { fakeCli } from './fixtures/fake-cli.ts';
import { tempDir, useTestCodexHome } from './helpers.ts';

const testHome = tempDir('botons-proc-test-');
process.env.HOME = testHome;
process.env.CLAUDE_CONFIG_DIR = join(testHome, 'claude');
useTestCodexHome(testHome);

function refused() {
  const root = tempDir();
  const cli = fakeCli(root, 'codex');
  const executed = join(root, 'executed');
  const probe = join(root, 'probe.json');
  writeFileSync(cli.bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) console.log('codex-cli 0.167.0');
else if (process.argv.includes('login')) console.log('Logged in using ChatGPT');
else if (process.argv.includes('sandbox')) console.log('BOTONS_WORKSPACE_PROBE_OK');
else if (process.argv.includes('model_provider="preflight"')) {
  fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({home:process.env.HOME, codexHome:process.env.CODEX_HOME, key:process.env.OPENAI_API_KEY, argv:process.argv}));
  console.error("bwrap: Can't mount proc on /proc: Operation not permitted"); process.exitCode = 1;
} else fs.writeFileSync(${JSON.stringify(executed)}, 'started');
`);
  return { root, cli, executed, probe };
}

test('session initialization probe catches proc failure even when standalone sandbox succeeds', async () => {
  const f = refused();
  assert.match((await probeCodexWorkspace(f.cli.bin))!, /it hides part of \/proc/);
  const probe = JSON.parse(readFileSync(f.probe, 'utf8'));
  assert.equal(probe.home, probe.codexHome);
  assert.match(probe.home, /botons-codex-workspace-/);
  assert.notEqual(probe.codexHome, process.env.CODEX_HOME, 'the probe never uses the selected Botons or personal home');
  assert.equal(existsSync(probe.home), false, 'the disposable config home is removed');
  assert.equal(probe.key, '');
  assert.ok(probe.argv.some((arg: string) => /http:\/\/127\.0\.0\.1:\d+\/v1/.test(arg)));
  assert.equal(existsSync(f.executed), false);
});

test('signed-in status shows Workspace failure and fresh/resumed turns refuse before exec without bypass', async () => {
  const f = refused();
  const provider = new CodexCliProvider(f.cli.bin, f.root);
  const status = await provider.info();
  assert.equal(status.loggedIn, true);
  assert.equal(status.available, true, 'Workspace failure is separate from sign-in and explicit Full computer access');
  assert.match(status.workspaceProblem!, /sandbox needs/);
  for (const sessionId of [null, 'fixture-thread']) await assert.rejects(provider.runTurn({
    cwd: f.root, sessionId, access: 'workspace', privatePaths: [], env: {}, signal: new AbortController().signal,
    prompt: 'hello', systemPrompt: 'fixture', model: '', timeoutMs: 1000, onActivity: () => {},
  }), /Not available on this server/);
  assert.equal(existsSync(f.executed), false);
});

test('doctor reports the preflight problem before a first turn', async () => {
  const f = refused();
  const findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), env: { HOME: f.root, BOTONS_HOME: join(f.root, 'data'), BOTONS_PORT: '19872', BOTONS_NO_TAILSCALE: '1', BOTONS_CODEX_BIN: f.cli.bin, BOTONS_CLAUDE_BIN: '/nonexistent/claude', PATH: '/usr/bin:/bin' }, probe: () => ({ available: false } as any), health: async () => null });
  assert.ok(findings.some(f => f.check === 'Workspace' && f.status === 'info' && f.message.includes('Codex')));
  assert.ok(!findings.some(f => f.message === 'bubblewrap works'), 'a toy namespace check cannot claim the production sandbox passed');
});
