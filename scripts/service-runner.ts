// launchd has no EnvironmentFile. Read it on every start, without evaluating shell text.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnvFile } from './install-service.ts';

const [app, envPath, kind] = process.argv.slice(2);
if (!app || !envPath || !['server', 'backup'].includes(kind)) throw new Error('Invalid service arguments');
const env = { ...process.env, ...readEnvFile(readFileSync(envPath, 'utf8')) };
const target = join(resolve(app), kind === 'backup' ? 'scripts/backup.ts' : 'server/src/index.ts');
const child = spawn(process.execPath, [target], { cwd: resolve(app), env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
child.on('error', (err) => { console.error(err.message); process.exitCode = 1; });
// Bad configuration needs owner intervention, not a restart loop.
child.on('exit', (code, signal) => { process.exitCode = code === 78 ? 0 : code ?? (signal ? 1 : 0); });
