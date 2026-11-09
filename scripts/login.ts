import '../server/src/env-init.ts';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../server/src/config.ts';
import { cliHomesEnv, prepareCliHomes } from '../server/src/cli-homes.ts';
import { agentEnv } from '../server/src/providers/process.ts';
const kind = process.argv[2];
if (kind !== 'codex' && kind !== 'claude') {
  console.error('Usage: botons login codex | botons login claude');
  process.exitCode = 2;
} else {
  const cfg = loadConfig();
  prepareCliHomes();
  const result = spawnSync(kind === 'codex' ? cfg.codexBin : cfg.claudeBin,
    kind === 'codex' ? ['login', '--device-auth'] : ['auth', 'login'],
    { env: { ...agentEnv({}), ...cliHomesEnv(process.env, true) }, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
