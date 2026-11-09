// `npm run service:install [-- --app <dir> --name <name> --dir <unit dir> --env-path <file>]`: writes the
// systemd user unit, and the environment file if there is none. It starts nothing.
import '../server/src/env-init.ts';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIRS, UNITS, applyLegacyEnv } from '../shared/legacy-names.mjs';
import { DEFAULT_DRAIN_MS, isBotonsSetting, parseDuration } from '../server/src/config.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

/** The service's environment file, unless --env-path names another: ~/.config/botons/env, or a deprecated one until the upgrade moves it (server/src/legacy-upgrade.ts). */
export function defaultEnvPath(): string {
  const now = join(configHome(), 'botons', 'env');
  return existsSync(now) ? now : (CONFIG_DIRS.map((d) => join(configHome(), d, 'env')).find((p) => existsSync(p)) ?? now);
}

export const unitDirDefault = () => join(configHome(), 'systemd', 'user');

/** The server's unit: botons, or the deprecated unit an install still runs under until the upgrade moves it (server/src/legacy-upgrade.ts). */
export function defaultUnitName(unitDir = unitDirDefault()): string {
  if (existsSync(join(unitDir, 'botons.service'))) return 'botons';
  return UNITS.find((u) => existsSync(join(unitDir, `${u.service}.service`)))?.service ?? 'botons';
}

/** systemd expands % specifiers in unit settings; a literal % is %%. */
const escapeUnit = (s: string) => s.replaceAll('%', '%%');

const quoteEnv = (v: string) => (/^[\w@%+=:,./-]*$/.test(v) ? v : `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);

/** The first executable `cmd` on `path`, or `cmd` itself when it is a path. */
function which(cmd: string, path: string): string | null {
  const executable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) return executable(resolve(cmd)) ? resolve(cmd) : null;
  for (const dir of path.split(delimiter)) {
    if (dir && isAbsolute(dir) && executable(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

/** KEY=value pairs of an environment file (comments and blank lines skipped, quotes removed). */
export function readEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * The environment a server-side script acts with. BOTONS_HOME set means "this server"; otherwise the BOTONS_* and
 * PORT (and PATH, for finding the CLIs) of the service's env file win, as for deploy and backup. Throws only when a
 * file named by `named` can't be read.
 */
export function serverEnv(named: string | undefined, base: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; from: string | null } {
  if (base.BOTONS_HOME?.trim()) return { env: base, from: null };
  const envPath = resolve(named ?? defaultEnvPath());
  let file: Record<string, string>;
  try {
    file = readEnvFile(readFileSync(envPath, 'utf8'));
  } catch {
    if (named !== undefined) throw new Error(`Cannot read ${envPath}.`);
    return { env: base, from: null };
  }
  applyLegacyEnv(file);
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(file)) if (isBotonsSetting(k) || k === 'PORT' || k === 'PATH' || k === 'DISABLE_AUTOUPDATER' || k === 'DISABLE_UPDATES') env[k] = v;
  applyLegacyEnv(env);
  return { env, from: envPath };
}

function arg(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : null;
}

export interface ServiceUnitOptions {
  /** The unit's name, without .service. */
  name: string;
  /** The Botons folder the unit runs. */
  app: string;
  envPath: string;
  unitDir: string;
  /** The Node binary (default: this one). */
  node?: string;
  /** The user's home, for writing the default env file's path as %h (default: this user's). */
  userHome?: string;
  log?: (line: string) => void;
}

/** Writes the environment file if there is none, then the unit (both starting nothing). Returns the unit file's path. */
export function writeServiceUnit(o: ServiceUnitOptions): string {
  const { name, app, envPath, unitDir } = o;
  const log = o.log ?? ((line: string) => console.log(line));
  if (!/^[\w@.-]+$/.test(name)) throw new Error(`--name ${name}: use letters, digits and - _ . @ only`);
  // %h when it is the default file, which the backup unit reads too.
  const envInUnit = envPath === join(o.userHome ?? homedir(), '.config', 'botons', 'env') ? '%h/.config/botons/env' : escapeUnit(envPath);
  const node = o.node ?? process.execPath;

  if (!existsSync(join(app, 'server', 'src', 'index.ts'))) throw new Error(`${app} has no server/src/index.ts; pass --app <the Botons folder>`);

  if (!existsSync(envPath)) {
    const path = process.env.PATH ?? '';
    const claude = which(process.env.BOTONS_CLAUDE_BIN || 'claude', path);
    const codex = which(process.env.BOTONS_CODEX_BIN || 'codex', path);
    // node's and the CLIs' folders, the shell's PATH without what npm adds for scripts, then the system folders.
    const npmAdded = (d: string) => /[/\\]node_modules[/\\]|[/\\]node_modules$|node-gyp-bin/.test(d);
    const dirs = [dirname(node), ...[claude, codex].flatMap((p) => (p ? [dirname(p)] : [])), ...path.split(delimiter).filter((d) => !npmAdded(d)), '/usr/local/bin', '/usr/bin', '/bin'];
    const servicePath = [...new Set(dirs.filter((d) => d && isAbsolute(d)))].join(delimiter);
    const line = (k: string, v: string | null, what: string) => (v ? `${k}=${quoteEnv(v)}` : `# ${k}=/path/to/${what}   (not found on PATH when this file was written)`);
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      envPath,
      `# Environment for the Botons server (${name}.service) and its nightly backup.
# Written by \`npm run service:install\`; edit freely,
# then: systemctl --user restart ${name}
#
# systemd does not read your shell profile, so PATH must name every folder the
# server and your Botons need: node, the claude and codex CLIs, and the tools
# Botons run (git, gh, ...).
PATH=${quoteEnv(servicePath)}
${line('BOTONS_CLAUDE_BIN', claude, 'claude')}
${line('BOTONS_CODEX_BIN', codex, 'codex')}
#
# Other settings (see "Configuration" in the README), for example:
# BOTONS_HOME=/home/you/.botons
# BOTONS_PORT=7777
# BOTONS_PUBLIC_URL=http://yourhost.your-tailnet.ts.net:7777
`,
      { mode: 0o600 },
    );
    log(`Wrote ${envPath}`);
    if (!claude || !codex) log(`  ${[!claude && 'claude', !codex && 'codex'].filter(Boolean).join(' and ')} not found on PATH: set the path in that file if you use it.`);
  } else {
    const env = readEnvFile(readFileSync(envPath, 'utf8'));
    applyLegacyEnv(env);
    const missing = ['PATH', 'BOTONS_CLAUDE_BIN', 'BOTONS_CODEX_BIN'].filter((k) => !env[k]);
    log(`Kept ${envPath}${missing.length ? ` (it does not set ${missing.join(', ')}; the service needs PATH to find node's tools and the CLIs)` : ''}`);
  }
  // The stop timeout is the drain budget plus 30s to stop the agents and close.
  const fileEnv = readEnvFile(readFileSync(envPath, 'utf8'));
  applyLegacyEnv(fileEnv);
  const drainMs = parseDuration(fileEnv.BOTONS_DRAIN_MS ?? '');
  const stopTimeoutSec = Math.ceil((Number.isNaN(drainMs) ? DEFAULT_DRAIN_MS : drainMs) / 1000) + 30;

  mkdirSync(unitDir, { recursive: true });
  const unitFile = join(unitDir, `${name}.service`);
  const unit = readFileSync(join(repo, 'scripts', 'botons.service'), 'utf8')
    .replaceAll('@DESCRIPTION@', name === 'botons' ? 'Botons server' : `Botons server (${name})`)
    .replaceAll('@APP@', escapeUnit(app))
    .replaceAll('@NODE@', escapeUnit(node))
    .replaceAll('@ENV_FILE@', envInUnit)
    .replaceAll('@STOP_TIMEOUT@', String(stopTimeoutSec))
    .replaceAll('@NAME@', name);
  writeFileSync(unitFile, unit);
  log(`Wrote ${unitFile}`);
  return unitFile;
}

function main() {
  const unitDir = resolve(arg('--dir') ?? unitDirDefault());
  const name = arg('--name') ?? 'botons';
  if (!arg('--name') && defaultUnitName(unitDir) !== 'botons') {
    throw new Error(`This install's service still runs under a deprecated name (${defaultUnitName(unitDir)}.service). Run \`npm run migrate:names\` first: it moves it to botons.service. Nothing was changed.`);
  }
  const app = resolve(arg('--app') ?? repo);
  const envPath = resolve(arg('--env-path') ?? defaultEnvPath());
  writeServiceUnit({ name, app, envPath, unitDir });
  if (process.argv.includes('--quiet')) return;
  console.log(`  runs ${process.execPath} ${join(app, 'server/src/index.ts')}

Start it now and at every boot (stop any other Botons server on the same data
folder first):
  systemctl --user daemon-reload
  systemctl --user enable --now ${name}

Check it:
  systemctl --user status ${name}
  journalctl --user -u ${name} -f

Run this again after moving the app folder, changing the Node version or
changing BOTONS_DRAIN_MS (the unit's stop timeout follows it).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
