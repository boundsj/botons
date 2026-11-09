import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function workspaceFailure(stderr: string): string {
  if (/Can't mount proc on \/proc|mount.*proc.*Operation not permitted/i.test(stderr)) {
    return 'Not available on this server: it hides part of /proc, which the sandbox needs.';
  }
  return 'Not available on this server: the Workspace sandbox could not start.';
}

/** Offline real helper probe: no model, login, owner config or owner workspace is used. */
export async function probeCodexWorkspace(bin: string, timeoutMs = 10000): Promise<string | null> {
  if (process.platform !== 'linux') return `Not available on this server: the Workspace sandbox needs Linux. On ${process.platform === 'darwin' ? 'macOS' : process.platform}, choose Full computer access for a Boton you trust.`;
  const root = mkdtempSync(join(tmpdir(), 'botons-codex-workspace-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(home); mkdirSync(cwd);
  const secret = join(root, 'private');
  writeFileSync(secret, 'fixture');
  const filesystem = `{${JSON.stringify(secret)}="none",${JSON.stringify(join(cwd, '.claude'))}="read",${JSON.stringify(join(cwd, 'AGENTS.md'))}="read"}`;
  const args = ['sandbox', '-C', cwd, '-P', 'preflight', '-c', 'permissions.preflight.extends=":workspace"', '-c', 'permissions.preflight.network.enabled=false', '-c', `permissions.preflight.filesystem=${filesystem}`, '--', '/bin/sh', '-c', 'set -e; echo ok > writable; if cat "$1" 2>/dev/null; then exit 31; fi; if touch .claude 2>/dev/null; then exit 32; fi; if touch AGENTS.md 2>/dev/null; then exit 33; fi; echo BOTONS_WORKSPACE_PROBE_OK', 'probe', secret];
  const run = (argv: string[], startup: boolean): Promise<string | null> => new Promise(resolve => {
    const child = spawn(bin, argv, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DISABLE_AUTOUPDATER: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false; let ready = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', d => {
      stdout = (stdout + d).slice(-8192);
      if (startup && stdout.split('\n').some(line => { try { return JSON.parse(line).type === 'thread.started'; } catch { return false; } })) { ready = true; kill(); }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4096); });
    child.on('error', () => { clearTimeout(timer); resolve(workspaceFailure('')); });
    child.on('close', code => {
      clearTimeout(timer); kill();
      resolve(!timedOut && (startup ? ready : code === 0 && stdout.trim() === 'BOTONS_WORKSPACE_PROBE_OK') ? null : workspaceFailure(stderr));
    });
  });
  const endpoint = createServer((_req, res) => { res.writeHead(503, { Connection: 'close' }); res.end(); });
  try {
    const problem = await run(args, false);
    if (problem) return problem;
    // `sandbox` alone can take a different proc fallback from the filesystem helper
    // used to load AGENTS.md. Confirm real session initialization too. The fixed
    // owned loopback stub and no-auth provider cannot reach a model or use a login.
    // Stop the complete process group as soon as session creation is confirmed.
    await new Promise<void>((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve); });
    const port = (endpoint.address() as { port: number }).port;
    return await run(['exec', '--json', '--skip-git-repo-check', '-C', cwd,
      '-c', 'model_provider="preflight"',
      '-c', `model_providers.preflight={name="Preflight",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`,
      '-c', 'default_permissions="preflight"', '-c', 'permissions.preflight.extends=":workspace"',
      '-c', 'permissions.preflight.network.enabled=true', '-c', `permissions.preflight.filesystem=${filesystem}`,
      'Reply OK'], true);
  } catch { return workspaceFailure(''); } finally {
    endpoint.closeAllConnections(); endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
}
