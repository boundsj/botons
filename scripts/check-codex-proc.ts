// Disposable privileged Debian container only; no credentials, ports or host volumes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCodexWorkspace } from '../server/src/providers/codex-workspace.ts';
import { sandboxProblem, runProcess } from '../server/src/sandbox.ts';

const masked = process.argv[2] === 'masked';
const problem = sandboxProblem();
const codexProblem = await probeCodexWorkspace('/opt/codex/bin/codex');
if (masked) {
  assert.match(problem ?? '', /Can't mount proc/);
  assert.match(codexProblem ?? '', /it hides part of \/proc/);
  console.log('Masked proc: both production sandbox and actual session helper refuse safely.');
} else {
  assert.equal(problem, null);
  assert.equal(codexProblem, null);
  const cwd = mkdtempSync(join(tmpdir(), 'botons-nested-codex-'));
  try {
    const env = { PATH: '/opt/codex/bin:/usr/local/bin:/usr/bin:/bin', HOME: cwd, CODEX_HOME: cwd };
    // The exact production runner, including its seccomp filter, overlays and private network.
    const result = await runProcess({ argv: ['/opt/codex/bin/codex', 'sandbox', '-C', cwd, '-P', 'probe', '-c', 'permissions.probe.extends=":workspace"', '--', '/bin/true'],
      cwd, env, sandbox: { cwd, writable: [cwd], hidden: [], readOnly: [], env }, timeoutMs: 10000, maxBytes: 4096, signal: new AbortController().signal });
    console.log('Nested Codex helper diagnostic:', JSON.stringify({ code: result.code, stderr: result.stderr }));
    // This is diagnostic evidence, not support for a nested CLI boundary: no
    // credentials, model connection or tool relay is provided to this sandbox.
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  console.log('Unmasked proc: production sandbox and actual session helper pass.');
}
