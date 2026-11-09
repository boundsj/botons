import { join } from 'node:path';
import { cliHome, prepareCliHomes, type CliKind } from '../cli-homes.ts';
import { botonsHome } from '../config.ts';
import { privatePaths } from '../isolation.ts';
import { agentEnv } from './process.ts';
import type { TurnRequest } from './types.ts';

/** One synchronous snapshot after startup checks: sandbox paths and child environment must agree. */
export function cliTurn(req: TurnRequest, kind: CliKind, extra: Record<string, string> = {}) {
  prepareCliHomes();
  const env = agentEnv({ ...extra, ...req.env });
  const personal = (['codex', 'claude'] as const).map(k => cliHome(k).personal);
  const hidden = req.access === 'workspace' ? privatePaths({
    workspace: req.cwd, cli: kind, botonsHome: botonsHome(), workspacesDir: join(botonsHome(), 'workspaces'),
    userHome: process.env.HOME, env,
    extra: [...req.privatePaths, ...personal.filter(p => p !== env.CODEX_HOME && p !== env.CLAUDE_CONFIG_DIR)],
    shared: req.sharedDirs,
  }) : req.privatePaths;
  return { env, req: { ...req, privatePaths: hidden } };
}
