import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer, tempDir, until, useTestCodexHome } from './helpers.ts';
import { useSandboxBinary } from '../src/sandbox.ts';

test('API sandbox status stays independent of CLI preflight and sign-in', async () => {
  useSandboxBinary('/nonexistent/bwrap');
  const s = await startServer();
  try {
    const infos = await s.app.providers.infos();
    for (const id of ['anthropic-api', 'openai-api']) {
      const p = infos.find(p => p.id === id)!;
      assert.match(p.workspaceProblem!, /API tools sandbox/);
      assert.equal(p.kind, 'api');
    }
    assert.equal(infos.find(p => p.id === 'mock')?.workspaceProblem, undefined);
    assert.ok(s.app.providers.ownerRecheck().includes('anthropic-api'));
  } finally { useSandboxBinary('bwrap'); await s.stop(); }
});

test('Claude preflight requires socat and private network/process namespaces', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux sandbox');
  const { claudeWorkspaceProblem } = await import('../src/providers/cli-check.ts');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./helpers.ts');
  const root = tempDir();
  const bwrap = join(root, 'bwrap'); const socat = join(root, 'socat');
  writeFileSync(socat, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  // Fail unless both namespace flags and the production proc mount are requested.
  writeFileSync(bwrap, '#!/bin/sh\ncase " $* " in *" --unshare-net --unshare-pid --proc /proc "*) exit 0;; *) exit 1;; esac\n', { mode: 0o700 });
  assert.equal(claudeWorkspaceProblem({bwrap, socat}), null);
  assert.match(claudeWorkspaceProblem({bwrap, socat: join(root, 'missing')})!, /socat/);
  writeFileSync(bwrap, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.match(claudeWorkspaceProblem({bwrap, socat})!, /network or process/);
});

test('non-Linux hosts refuse CLI Workspace turns before any CLI starts', { skip: process.platform === 'linux' && 'Covers hosts without the Linux Workspace sandbox' }, async () => {
  const { claudeWorkspaceProblem } = await import('../src/providers/cli-check.ts');
  const { probeCodexWorkspace } = await import('../src/providers/codex-workspace.ts');
  const { ClaudeCliProvider } = await import('../src/providers/claude-cli.ts');
  assert.match(claudeWorkspaceProblem()!, /needs Linux.*Full computer access/);
  assert.match((await probeCodexWorkspace('/nonexistent/codex'))!, /needs Linux.*Full computer access/);
  const provider = new ClaudeCliProvider('/nonexistent/claude');
  for (const sessionId of [null, 'fixture-session']) await assert.rejects(provider.runTurn({
    cwd: '/nonexistent', sessionId, access: 'workspace', privatePaths: [], env: {}, signal: new AbortController().signal,
    prompt: 'hello', systemPrompt: 'fixture', model: '', timeoutMs: 1000, onActivity: () => {},
  }), /needs Linux.*Full computer access/);
});


test('a Full computer CLI Boton still refuses sandboxed webhook runs on non-Linux hosts', { skip: process.platform === 'linux' && 'Covers hosts without the Linux Workspace sandbox' }, async () => {
  useTestCodexHome(tempDir('botons-webhook-refusal-'));
  const s = await startServer({ fakeClis: true });
  try {
    for (const [provider, cli] of [['claude-cli', s.claude], ['codex-cli', s.codex]] as const) {
      const bot = await s.newBot('Kevin', { provider, access: 'host' });
      const routine = await s.newRoutine(bot.id, { name: 'Hook', instruction: 'Reply OK', webhook: true });
      const response = await s.hook(routine, '', { body: 'hello' });
      assert.equal(response.status, 202);
      const { runId } = await response.json();
      const ended = await until(async () => (await s.runsOf(routine.id)).find(r => r.id === runId && r.status === 'failed'));
      assert.match(ended.error!, /Workspace sandbox needs Linux/);
      assert.equal(cli.calls().length, 0, 'the forced Workspace run never starts its CLI');
      assert.equal(s.app.store.getBot(bot.id).access, 'host', 'the saved access is unchanged');
    }
  } finally { await s.stop(); }
});
