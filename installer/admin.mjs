import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { serverEnv } from '../scripts/install-service.ts';
const [script, ...args] = process.argv.slice(2);
const result = spawnSync(process.execPath, [realpathSync(script), ...args], { env: serverEnv(undefined).env, stdio: 'inherit' });
process.exit(result.status ?? 1);
