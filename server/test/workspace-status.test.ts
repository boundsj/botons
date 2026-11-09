import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './helpers.ts';
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
