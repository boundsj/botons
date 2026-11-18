import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { botonsHome } from './config.ts';

export type CliKind = 'codex' | 'claude';

/**
 * Where each CLI keeps its sign-in, settings and conversations for Botons' turns, probes, login and updates.
 *
 * Codex: the server account's own Codex home (CODEX_HOME, else ~/.codex), shared with every other Codex client the
 * server's user runs. Codex rotates its refresh token on every refresh, so a second copy of auth.json goes stale as
 * soon as either copy refreshes; one home, refreshed by Codex itself, is the only arrangement that stays signed in.
 * Botons' own `BOTONS_HOME/cli/codex` is read only for what an install kept there: its sign-in is used in place (never
 * copied) while the account home has none, and its conversations are copied over when a Boton resumes one.
 *
 * Claude: Botons' own `BOTONS_HOME/cli/claude`, except that a personal file sign-in is kept in use until the owner
 * signs in for Botons (`pending`).
 */
export interface CliHome {
  /** The server account's home for this CLI: its variable, else ~/.<kind>. */
  personal: string;
  /** Botons' own folder for this CLI under BOTONS_HOME/cli. */
  isolated: string;
  auth: string;
  /** Claude only: the personal sign-in is in use until the owner signs in for Botons. */
  pending: boolean;
  /** Codex only: the account home has no sign-in, so the one kept in `isolated` is used where it is. */
  keptOnly: boolean;
  selected: string;
}

export function cliHome(kind: CliKind, env: NodeJS.ProcessEnv = process.env, login = false): CliHome {
  const personal = resolve(env[kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] || join(env.HOME || homedir(), `.${kind}`));
  const isolated = join(botonsHome(env), 'cli', kind);
  const auth = kind === 'codex' ? 'auth.json' : '.credentials.json';
  if (kind === 'codex') {
    // Login always signs in the account home; once it has a sign-in, every turn and probe uses it.
    const keptOnly = !env.CODEX_HOME && isolated !== personal && !existsSync(join(botonsHome(env), 'cli', 'codex-account-selected')) && !existsSync(join(personal, auth)) && existsSync(join(isolated, auth));
    return { personal, isolated, auth, pending: false, keptOnly, selected: keptOnly && !login ? isolated : personal };
  }
  const pending = !existsSync(join(isolated, auth)) && existsSync(join(personal, auth));
  return { personal, isolated, auth, pending, keptOnly: false, selected: !login && pending ? personal : isolated };
}

/** Apply last, so caller variables cannot redirect a CLI elsewhere. */
export function cliHomesEnv(env: NodeJS.ProcessEnv = process.env, login = false): NodeJS.ProcessEnv {
  return { CODEX_HOME: cliHome('codex', env, login).selected, CLAUDE_CONFIG_DIR: cliHome('claude', env, login).selected };
}

/** Codex's global instruction files in the home it runs in: Codex adds them to every turn, whatever the flags. */
export function codexGlobalInstructions(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = cliHome('codex', env).selected;
  return ['AGENTS.override.md', 'AGENTS.md'].filter((name) => existsSync(join(home, name)));
}

/**
 * Creates the homes Botons sets: Claude's own home under BOTONS_HOME/cli, and the Codex account home when it doesn't
 * exist yet (Codex refuses a CODEX_HOME that doesn't). New directories are private (0700). Nothing is copied.
 */
export function prepareCliHomes(env: NodeJS.ProcessEnv = process.env): void {
  const root = botonsHome(env);
  for (const dir of [root, join(root, 'cli'), cliHome('claude', env, true).isolated]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error('Botons CLI homes must be regular directories.');
  }
  // Once the account home is selected, logout must not revive the unused Botons sign-in.
  // This marker contains no credentials; explicit CODEX_HOME also always wins (including keyring-only homes).
  if (!cliHome('codex', env).keptOnly) writeFileSync(join(root, 'cli', 'codex-account-selected'), '', { mode: 0o600 });
  const codex = cliHome('codex', env, true).personal;
  if (!existsSync(codex)) {
    try {
      mkdirSync(codex, { recursive: true, mode: 0o700 });
    } catch {} // a dangling link, say: Codex itself reports the home it can't use
  }
}
