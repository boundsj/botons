import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { CONFIG_DIRS, DATA_DIRS } from '../../shared/legacy-names.mjs';
import { delimiter, join, resolve, sep } from 'node:path';

/** Botons run as the server's user, so file modes don't keep these out of a Workspace Boton; this list does. */
const HOME_SECRETS = [
  '.ssh',
  '.gnupg',
  '.password-store',
  '.local/share/keyrings',
  '.pki',
  '.local/share/pki',
  '.config/op',
  '.config/1Password',
  '.config/Bitwarden',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.netrc',
  '.git-credentials',
  '.config/gh',
  '.config/hub',
  '.config/glab-cli',
  '.config/gcloud',
  '.config/doctl',
  '.config/rclone',
  '.terraform.d/credentials.tfrc.json',
  '.pulumi/credentials.json',
  '.fly',
  '.vault-token',
  '.npmrc',
  '.pypirc',
  '.gem/credentials',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.claude.json',
  '.config/anthropic',
  '.config/github-copilot',
  '.gemini',
  '.pi',
  '.hermes',
  '.config/opencode',
  '.local/share/opencode',
  '.t3/userdata',
  '.config/Slack',
  '.config/discord',
  '.config/Signal',
  '.mozilla',
  '.librewolf',
  '.zen',
  '.floorp',
  '.waterfox',
  '.config/google-chrome',
  '.config/google-chrome-beta',
  '.config/google-chrome-unstable',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/vivaldi',
  '.config/vivaldi-snapshot',
  '.config/microsoft-edge',
  '.config/microsoft-edge-beta',
  '.config/microsoft-edge-dev',
  '.config/opera',
  '.config/opera-beta',
  '.config/thorium',
  '.bash_history',
  '.zsh_history',
  '.histfile',
  '.local/share/fish/fish_history',
  '.local/share/atuin',
  '.python_history',
  '.node_repl_history',
  '.psql_history',
  '.mysql_history',
  '.sqlite_history',
  '.config/botons',
  // Settings folders under deprecated names stay on disk after the upgrade, and may hold secrets.
  ...CONFIG_DIRS.map((d) => `.config/${d}`),
];

/** BOTONS_PRIVATE_PATHS: separated like PATH, each absolute, "~/…", or relative to the home folder. */
export function parsePrivatePaths(value: string | undefined, userHome: string = homedir()): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(userHome, p.replace(/^~(?=\/|$)/, '.')));
}

export type AgentCli = 'claude' | 'codex';

// What the running CLI's sandboxed commands still need in its own folder; the rest of it, and all of the other CLI's, is private.
const CLAUDE_KEEP = new Set(['projects', 'shell-snapshots', 'session-env']);
const CODEX_KEEP = new Set(['tmp', 'shell_snapshots']);

/** Claude Code's folder for a working directory's sessions, under ~/.claude/projects. */
export function claudeProjectDir(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The data folder's private storage that is made only when first needed (the first backup, the first file deleted to
 * the trash, ...). A Workspace turn's CLI takes its private paths once, as it starts, so a folder made later would not
 * be on them: each is made before the list is taken, empty and private, and is on every list from then on.
 */
const RESERVED_HOME_DIRS: readonly string[] = ['backups', 'trash', 'run', 'browser', 'api-sessions', 'templates', 'skill-packages'];

/**
 * Makes each of RESERVED_HOME_DIRS that is missing, and returns where each really is (a folder of the owner's linked
 * there, say, is listed by the link and by its folder). Throws when one can't be made or isn't a folder: the turn
 * then doesn't start, rather than start without it on its list.
 */
function reserveHomeDirs(botonsHome: string): string[] {
  if (!existsSync(botonsHome)) return [];
  const out: string[] = [];
  for (const name of RESERVED_HOME_DIRS) {
    const p = join(botonsHome, name);
    try {
      mkdirSync(p, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`Botons could not make ${p}, which a Workspace turn must have on its private paths before it starts (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
    }
    let real: string;
    try {
      real = realpathSync(p);
      if (!statSync(real).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new Error(`${p} is not a folder, so a Workspace turn can't have it on its private paths; move it aside and Botons makes it again`);
    }
    if (real !== p) out.push(real);
  }
  return out;
}

/**
 * Paths a Workspace Boton must not read: home secrets, BOTONS_PRIVATE_PATHS (`extra`), the CLIs' logins and other
 * sessions, everything in BOTONS_HOME (RESERVED_HOME_DIRS made first) and other workspaces. Only paths that exist, and
 * never one holding the Boton's own workspace or a shared folder.
 */
export function privatePaths(input: {
  workspace: string;
  cli: AgentCli | null;
  botonsHome: string;
  workspacesDir: string;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  extra?: string[];
  shared?: string[];
}): string[] {
  const home = input.userHome ?? homedir();
  const env = input.env ?? process.env;
  const own = resolve(input.workspace);
  const found = new Set<string>();
  const entries = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  for (const rel of HOME_SECRETS) found.add(join(home, rel));
  for (const p of input.extra ?? []) found.add(resolve(p));

  for (const kind of ['codex', 'claude']) {
    const personal = join(home, `.${kind}`);
    if (resolve(env[kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] || personal) !== personal) found.add(personal);
  }
  const claudeDir = resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  if (input.cli === 'claude') {
    for (const e of entries(claudeDir)) if (!CLAUDE_KEEP.has(e)) found.add(join(claudeDir, e));
    const ownProject = claudeProjectDir(own);
    for (const e of entries(join(claudeDir, 'projects'))) if (e !== ownProject) found.add(join(claudeDir, 'projects', e));
  } else found.add(claudeDir);

  const codexDir = resolve(env.CODEX_HOME || join(home, '.codex'));
  if (input.cli === 'codex') {
    for (const e of entries(codexDir)) if (!CODEX_KEEP.has(e)) found.add(join(codexDir, e));
  } else found.add(codexDir);

  const botonsHome = resolve(input.botonsHome);
  const workspacesDir = resolve(input.workspacesDir);
  for (const p of reserveHomeDirs(botonsHome)) found.add(p);
  for (const e of entries(botonsHome)) {
    if (e !== 'cli') found.add(join(botonsHome, e));
    else for (const kind of entries(join(botonsHome, e))) {
      const dir = join(botonsHome, e, kind);
      if (dir !== codexDir && dir !== claudeDir) found.add(dir);
    }
  }
  for (const e of entries(workspacesDir)) found.add(join(workspacesDir, e));

  const open = [own, ...(input.shared ?? []).map((p) => resolve(p))];
  const out = [...found].filter((p) => !open.some((o) => p === o || o.startsWith(p + sep)) && existsSync(p));
  // The data folder by its deprecated default names too (links to it the upgrade leaves), so a path through a
  // link names each private path as well.
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const aliases = DATA_DIRS
    .map((n) => join(home, n))
    .filter((a) => a !== botonsHome && isLink(a) && real(a) !== null && real(a) === real(botonsHome));
  for (const a of aliases) for (const p of [...out]) if (p.startsWith(botonsHome + sep)) out.push(a + p.slice(botonsHome.length));
  return out;
}

/**
 * Codex masks each non-runtime entry in its config directory separately. Bubblewrap cannot mount a
 * file mask onto a symlink. Inspect metadata only: do not read instructions, skills or credentials,
 * resolve their targets into a different policy, or replace anything in the owner's configuration.
 */
export function codexConfigSymlinks(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string[] {
  const dir = resolve(env.CODEX_HOME || join(userHome, '.codex'));
  if (isLink(dir)) return ['CODEX_HOME'];
  try {
    return readdirSync(dir).filter((name) => !CODEX_KEEP.has(name) && isLink(join(dir, name))).map((name) => `CODEX_HOME/${name}`).sort();
  } catch {
    return [];
  }
}
