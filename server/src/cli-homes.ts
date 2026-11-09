import { constants, existsSync, lstatSync, mkdirSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { botonsHome } from './config.ts';

export type CliKind = 'codex' | 'claude';
export function cliHome(kind: CliKind, env: NodeJS.ProcessEnv = process.env, login = false) {
  const personal = resolve(env[kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] || join(env.HOME || homedir(), `.${kind}`));
  const isolated = join(botonsHome(env), 'cli', kind);
  const auth = kind === 'codex' ? 'auth.json' : '.credentials.json';
  const pending = !existsSync(join(isolated, auth)) && existsSync(join(personal, auth));
  return { personal, isolated, auth, pending, selected: !login && pending ? personal : isolated };
}
/** Apply last, so caller variables cannot redirect a CLI into personal configuration. */
export function cliHomesEnv(env: NodeJS.ProcessEnv = process.env, login = false): NodeJS.ProcessEnv {
  return { CODEX_HOME: cliHome('codex', env, login).selected, CLAUDE_CONFIG_DIR: cliHome('claude', env, login).selected };
}
export function prepareCliHomes(env: NodeJS.ProcessEnv = process.env): void {
  const root = botonsHome(env);
  for (const dir of [root, join(root, 'cli'), ...(['codex', 'claude'] as const).map(kind => cliHome(kind, env, true).isolated)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error('Botons CLI homes must be regular directories.');
  }
}
/** Fixed source and destination only; no caller-controlled paths or credential bytes in audit. */
export function importCodexSignIn(audit: (phase: 'confirmed' | 'completed') => void, env: NodeJS.ProcessEnv = process.env): void {
  const home = cliHome('codex', env);
  if (!home.pending) throw new Error('No existing sign-in needs to be copied.');
  const source = join(home.personal, home.auth);
  if (!lstatSync(source).isFile()) throw new Error('Sign in separately: the sign-in file must be a regular file.');
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { if (!fstatSync(fd).isFile() || fstatSync(fd).size > 1024 * 1024) throw new Error('Invalid sign-in file.'); bytes = readFileSync(fd); JSON.parse(bytes.toString()); } finally { closeSync(fd); }
  audit('confirmed');
  prepareCliHomes(env);
  writeFileSync(join(home.isolated, home.auth), bytes, { flag: 'wx', mode: 0o600 });
  audit('completed');
}
