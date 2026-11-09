#!/usr/bin/env node
import { existsSync, lstatSync, readlinkSync, statSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { homedir, arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { cliInstallPlan, installCli, cliPresent } from './brain-clis.mjs';
import { installerRevision } from './revision.mjs';
import { configureLinger, lingerCommand } from './linger.mjs';
import { configurePath, onPath, removePathBlock } from './shell-path.mjs';
import { plan, summary, installOutput } from './output.mjs';
import { CLI_NAMES, DB_FILE, SHARE_DIRS, UNITS, earlierEnvNames } from '../shared/legacy-names.mjs';
let output;
const envelope = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = existsSync(join(envelope, 'payload/package.json')) ? join(envelope, 'payload') : envelope;
export function parse(args) {
  const o = { command: 'install' };
  if (args[0] && !args[0].startsWith('-')) o.command = args.shift();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--yes', '--dry-run', '--no-sudo', '--no-service', '--purge', '--verbose'].includes(key)) o[key.slice(2)] = true;
    else if (['--home', '--host', '--public-url', '--ref', '--source', '--brain'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) o[key.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  if (!['install', 'upgrade', 'repair', 'uninstall', 'doctor', 'backup', 'restore', 'pair', 'serve'].includes(o.command)) throw new Error('Unknown command');
  for (const key of ['home', 'host', 'public-url']) if (o[key] && /[\r\n\0]/.test(o[key])) throw new Error(`Invalid ${key}`);
  if (o.brain && !['claude', 'codex'].includes(o.brain)) throw new Error('--brain requires claude or codex');
  return o;
}
export function verified(bytes, sums, filename) {
  const line = sums.split('\n').find(l => l.endsWith(`  ${filename}`));
  if (!line || line.split(' ')[0] !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Node archive checksum mismatch');
}
export function publicSettings(text, value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('--public-url requires an HTTPS origin without credentials');
  const kept = text.split('\n').filter(line => !/^\s*(?:export\s+)?BOTONS_(?:OAUTH_)?PUBLIC_URL\s*=/.test(line)).join('\n');
  return kept.trimEnd() + `\nBOTONS_PUBLIC_URL=${JSON.stringify(url.origin)}\nBOTONS_OAUTH_PUBLIC_URL=${JSON.stringify(url.origin)}\n`;
}
async function consent(message, yes = false) {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error(`${message}: use --yes to consent`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { const answer = (await rl.question(`${message} [Y/n] `)).trim().toLowerCase(); if (answer && answer !== 'y' && answer !== 'yes') throw new Error('Cancelled'); } finally { rl.close(); }
}
const run = (cmd, args, env = process.env, cwd) => {
  output?.detail(JSON.stringify([cmd, ...args]));
  try { const result = execFileSync(cmd, args, { stdio: output?.stdio || 'inherit', env, cwd }); output?.replay(); return result; }
  catch { throw new Error('An installation command failed'); }
};
async function download(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`Download failed: ${r.status}`); return Buffer.from(await r.arrayBuffer());
}
export function sourceVersion(input) {
  const base = JSON.parse(readFileSync(join(input, 'package.json'))).version || '0.0.0';
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(base)) throw new Error('Source needs a semantic package version');
  if (!existsSync(join(input, '.git'))) {
    if (JSON.parse(readFileSync(join(input, 'package.json'))).version) return base;
    const hash = createHash('sha256');
    for (const item of ['installer', 'server', 'shared', 'scripts', 'web', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'LICENSE']) {
      const root = join(input, item);
      if (!existsSync(root)) continue;
      const visit = (path, name) => {
        if (['node_modules', '.git'].includes(name.split('/').at(-1))) return;
        if (statSync(path).isDirectory()) {
          for (const child of readdirSync(path).sort()) visit(join(path, child), name + '/' + child);
        } else {
          const bytes = readFileSync(path);
          hash.update(JSON.stringify([name, bytes.length])).update(bytes);
        }
      };
      visit(root, item);
    }
    return `${base}+source.${hash.digest('hex')}`;
  }
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input, encoding: 'utf8' }).trim();
  return `${base.split('+')[0]}+git.${sha}`;
}
async function nodeRuntime(root) {
  const index = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString());
  const version = index.find(v => /^v24\./.test(v.version)).version;
  const dest = join(root, 'node', version);
  if (validRuntime(join(dest, 'bin/node'))) return join(dest, 'bin/node');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const filename = `node-${version}-linux-${arch() === 'arm64' ? 'arm64' : 'x64'}.tar.xz`;
  const base = `https://nodejs.org/dist/${version}/`;
  const bytes = await download(base + filename);
  verified(bytes, (await download(base + 'SHASUMS256.txt')).toString(), filename);
  const staging = join(root, `.runtime-${randomUUID()}`);
  mkdirSync(staging); const archive = join(staging, 'node.tar.xz'); writeFileSync(archive, bytes);
  try { run('tar', ['-xJf', archive, '--strip-components=1', '-C', staging]); rmSync(archive); renameSync(staging, dest); }
  finally { rmSync(staging, { recursive: true, force: true }); }
  return join(dest, 'bin/node');
}
function validRuntime(node) {
  return spawnSync(node, ['-e', 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'], { stdio: 'ignore' }).status === 0;
}
function link(target, path) {
  const tmp = `${path}.${randomUUID()}`; symlinkSync(target, tmp); renameSync(tmp, path);
}
export function packageCommands(osRelease) {
  const id = /^ID=(.*)$/m.exec(osRelease)?.[1].replaceAll('"', '');
  if (['debian', 'ubuntu'].includes(id)) return [
    ['apt-get', 'update'],
    ['apt-get', 'install', '-y', 'bubblewrap', 'socat', 'systemd', 'xz-utils', 'tar'],
  ];
  if (['fedora', 'rhel', 'rocky', 'almalinux'].includes(id)) return [
    ['dnf', 'install', '-y', 'bubblewrap', 'socat', 'systemd', 'xz', 'tar'],
  ];
  throw new Error('Unsupported distribution; install bubblewrap >=0.11, socat, systemd and xz manually.');
}
export function dependencyProblems(probe = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })) {
  const missing = [];
  const bwrap = probe('bwrap', ['--version']);
  if (bwrap.status !== 0 || !/bubblewrap\s+(?:0\.(?:1[1-9]|[2-9]\d)|[1-9]\d*\.\d+)\./.test(bwrap.stdout || '')) missing.push('bubblewrap >=0.11');
  for (const [cmd, args] of [['socat', ['-V']], ['xz', ['--version']], ['tar', ['--version']]]) {
    if (probe(cmd, args).status !== 0) missing.push(cmd);
  }
  return missing;
}
async function waitHealthy(env) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${env.BOTONS_PORT || env.PORT || 7777}/api/health`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (response.ok || (response.status === 503 && body.failing?.length && body.failing.every(item => item === 'providers'))) return;
    } catch {}
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error('Health check failed');
}
async function main() {
  const args = process.argv.slice(2);
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  if (args.length === 1 && args[0] === '--version') { console.log(version); return; }
  // Administrative scripts own their argument parsing.
  const admin = ['login', 'doctor', 'backup', 'restore', 'pair', 'serve'].includes(args[0]) ? args.shift() : null;
  const o = admin ? { command: admin } : parse(args);
  if (!admin && o.verbose) console.log(installerRevision(envelope));
  if (o['public-url']) publicSettings('', o['public-url']);
  const share = join(homedir(), '.local/share');
  const root = join(share, 'botons');
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const config = join(configHome, 'botons/env');
  const units = join(configHome, 'systemd/user');
  // A managed install under a deprecated name (shared/legacy-names.mjs): used as it is until this moves it, after consent.
  const isDir = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
  const earlierRoot = isDir(root) ? null : SHARE_DIRS.map(d => join(share, d)).find(p => isDir(p) && existsSync(join(p, 'installer.json'))) ?? null;
  const readSaved = (at) => existsSync(join(at, 'installer.json')) ? JSON.parse(readFileSync(join(at, 'installer.json'), 'utf8')) : null;
  // A move off the deprecated names that stopped part way: the release root records where it came from, and that
  // path's link comes back first, so the earlier unit's and the saved runtime's paths work again.
  try {
    const from = readFileSync(join(root, '.name-upgrade-from'), 'utf8').trim();
    if (dirname(from) === share && !existsSync(from) && !lstatSync(from, { throwIfNoEntry: false })) symlinkSync('botons', from);
  } catch {}
  const handover = (dataDir) => { try { return JSON.parse(readFileSync(join(dataDir, 'name-upgrade.json'), 'utf8')).service ?? null; } catch { return null; } };
  const earlierUnit = UNITS.some(u => existsSync(join(units, `${u.service}.service`)));
  const rootSaved = readSaved(root);
  const unfinished = !earlierRoot && !!rootSaved && earlierUnit && (!existsSync(join(units, 'botons.service')) || (handover(rootSaved.data)?.unit && !handover(rootSaved.data).done));
  let current = join(earlierRoot ?? root, 'current');
  let saved = readSaved(earlierRoot ?? root);
  let data = resolve(o.home || saved?.data || process.env.BOTONS_HOME || join(homedir(), '.botons'));
  if (saved && data !== saved.data) throw new Error('Managed data path differs; refusing to change it');
  if (admin) {
    const node = saved?.node;
    if (!node) throw new Error('No managed Node runtime; run repair');
    const script = admin === 'serve' ? 'server/src/index.ts' : `scripts/${admin}.ts`;
    const r = spawnSync(node, [realpathSync(join(current, 'installer/admin.mjs')), realpathSync(join(current, script)), ...args], { stdio: 'inherit' }); process.exit(r.status ?? 1);
  }
  if (platform() !== 'linux' || !['x64', 'arm64'].includes(arch())) throw new Error('Installer requires Linux x64 or arm64');
  // An install under a deprecated name that this installer did not make (a checkout's deploy) moves with its own tools.
  if (!earlierRoot && !unfinished && !existsSync(join(units, 'botons.service')) && (SHARE_DIRS.some(d => isDir(join(share, d))) || earlierUnit)) {
    throw new Error('Existing Botons install under a deprecated name that this installer did not make: run `npm run migrate:names` in its checkout first; nothing changed.');
  }
  let marker = join(earlierRoot ?? root, 'installer.json');
  if (existsSync(earlierRoot ?? root) && !existsSync(marker)) throw new Error('Existing unmanaged Botons directory; refusing to overwrite it.');
  if (!existsSync(marker) && (existsSync(config) || existsSync(join(units, 'botons.service')))) throw new Error('Existing unmanaged Botons service/configuration; refusing to overwrite it.');
  const bin = join(homedir(), '.local/bin/botons');
  // The command's deprecated names, where this installer made them (shared/legacy-names.mjs): they run it for one release.
  const legacyBins = () => CLI_NAMES.map(n => join(homedir(), '.local/bin', n)).filter(p => {
    try { return lstatSync(p).isSymbolicLink() && [root, ...SHARE_DIRS.map(d => join(share, d))].some(r => readlinkSync(p).startsWith(r + '/')); } catch { return false; }
  });
  // A release's installer: installer/botons.mjs, or the file a release made under an earlier name has (shared/legacy-names.mjs).
  const entryOf = (dir) => ['botons', ...CLI_NAMES].map(n => join(dir, 'installer', `${n}.mjs`)).find(p => existsSync(p)) ?? join(dir, 'installer', 'botons.mjs');
  if (existsSync(bin) && (!existsSync(current) || realpathSync(bin) !== realpathSync(entryOf(current)))) throw new Error('Existing botons command; refusing to overwrite it.');
  console.log(`Botons ${version}`);
  console.log(plan(o.command, o.brain));
  if (o.purge) console.log(`• Permanently delete data at ${data} and its configuration.`);
  if (o.brain && saved?.node) throw new Error('--brain is for a fresh install; update an existing CLI from Settings or its publisher command');
  if (o['dry-run']) { if (o.brain) console.log(`Selected subscription CLI: ${o.brain}; official npm package, managed prefix, no sign-in`); return; }
  if (process.getuid?.() === 0) throw new Error('Run as an ordinary user, never root');
  if (o.ref && !o.source) throw new Error('--ref requires --source <git URL>');
  await consent('Continue?', o.yes);
  // Off the deprecated names first (server/src/legacy-upgrade.ts, with the install's own Node): the earlier units
  // stop and are disabled, the folders move (each earlier path left as a link), and the env file is written anew.
  // Nothing new starts until the steps below; if they fail, `undoNames` starts the earlier units again.
  let helpers = null;
  let undoNames = null;
  if ((earlierRoot || unfinished) && o.command === 'uninstall') throw new Error('This install still has a deprecated name: run repair first (it moves it to the current names), then uninstall. Nothing changed.');
  if (earlierRoot || unfinished) {
    if (!saved?.node || !validRuntime(saved.node)) throw new Error('The install under a deprecated name has no working Node runtime: repair it with the installer it was made with first; nothing changed.');
    helpers = mkdtempSync(join(tmpdir(), 'botons-helpers-'));
    for (const item of ['scripts', 'server/src', 'shared']) cpSync(join(source, item), join(helpers, item), { recursive: true });
    const names = (args) => run(saved.node, [join(helpers, 'scripts/migrate-names.ts'), ...args]);
    names(['--no-start']);
    undoNames = () => names(['--undo']);
    saved = readSaved(root);
    if (!saved) throw new Error('The move off the deprecated names did not finish; run this again.');
    current = join(root, 'current');
    marker = join(root, 'installer.json');
    data = resolve(o.home || saved.data);
  }
  try {
  mkdirSync(root, { recursive: true });
  if (!saved && o.command !== 'uninstall') writeFileSync(marker, JSON.stringify({ data }));
  output = installOutput(join(root, 'install.log'), o.verbose);
  if (o.command === 'uninstall') {
    if (!existsSync(marker)) throw new Error('No managed install');


    if (!o['no-service']) { run('systemctl', ['--user', 'disable', '--now', 'botons', 'botons-backup.timer']); }
    const units = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
    for (const unit of ['botons.service', 'botons-backup.service', 'botons-backup.timer']) rmSync(join(units, unit), { force: true });
    rmSync(bin, { force: true });
    for (const p of legacyBins()) rmSync(p, { force: true });
    removePathBlock(homedir());
    for (const item of ['current', 'releases', 'node']) rmSync(join(root, item), { recursive: true, force: true });
    if (!o['no-service']) run('systemctl', ['--user', 'daemon-reload']);
    if (o.purge) { rmSync(data, { recursive: true, force: true }); rmSync(config, { force: true }); rmSync(root, { recursive: true, force: true }); }
    console.log('✓ Botons uninstalled.');
    return;
  }
  if (!o['no-service']) {
    const manager = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    if (manager.status !== 0) throw new Error('No systemd user manager/session. Log in with a user session or explicitly use --no-service.');
  }

  const missing = dependencyProblems();
  if (missing.length) {
    output.detail('Missing requirements: ' + missing.join(', '));
    const commands = packageCommands(readFileSync('/etc/os-release', 'utf8'));
    output.detail(commands.map(args => ['sudo', ...args].join(' ')).join('\n'));
    if (o['no-sudo']) throw new Error('Required system tools missing; run the commands above then retry');
    for (const command of commands) { await consent('Run exactly: sudo ' + command.join(' '), o.yes); run('sudo', command); }
    const remaining = dependencyProblems();
    if (remaining.length) throw new Error('System requirements still missing: ' + remaining.join(', '));
  }

  mkdirSync(root, { recursive: true });
  if (!saved) writeFileSync(marker, JSON.stringify({ data }));
  const node = saved?.node && validRuntime(saved.node) ? saved.node : await nodeRuntime(root);
  // Node refuses type stripping beneath npm's node_modules cache.
  const helpers = join(root, '.helpers-' + randomUUID());
  let serviceEnv;
  try {
    for (const item of ['scripts', 'server/src', 'shared']) cpSync(join(source, item), join(helpers, item), { recursive: true });
    const reader = join(helpers, 'scripts/install-service.ts');
    const loaded = execFileSync(node, ['--input-type=module', '-e',
      `import {serverEnv} from ${JSON.stringify('file://' + reader)}; console.log(JSON.stringify(serverEnv(undefined, {...process.env, ${['BOTONS_HOME', ...earlierEnvNames('BOTONS_HOME')].map(k => `${k}:''`).join(', ')}}).env));`], { encoding: 'utf8' });
    serviceEnv = JSON.parse(loaded);
  } finally { rmSync(helpers, { recursive: true, force: true }); }
  const previousEnv = { ...serviceEnv, BOTONS_HOME: data };
  const env = { ...serviceEnv, PATH: `${dirname(node)}:${serviceEnv.PATH}`, BOTONS_HOME: data, BOTONS_HOST: o.host || serviceEnv.BOTONS_HOST || '127.0.0.1', BOTONS_NO_TAILSCALE: serviceEnv.BOTONS_NO_TAILSCALE || '1', ...(o['public-url'] ? { BOTONS_PUBLIC_URL: new URL(o['public-url']).origin, BOTONS_OAUTH_PUBLIC_URL: new URL(o['public-url']).origin } : {}) };
  // A CLI is selected separately from --yes: unattended installs never choose a subscription for the owner.
  let brain = o.brain;
  if (brain) {
    const key = `BOTONS_${brain.toUpperCase()}_BIN`;
    const configured = env[key];
    if (configured || cliPresent(brain, env)) {
      output.detail(`Keeping ${configured || brain}; no CLI installation performed. Sign in during setup.`);
    } else {
      const plan = cliInstallPlan(root, node, brain);
      output.detail(plan.display);
      await installCli(plan, { consent: async () => {}, yes: true, env, run: (cmd, args, options) => spawnSync(cmd, args, { ...options, stdio: output.stdio }) });
      if (!cliPresent(plan.bin, env)) throw new Error('Installed CLI did not pass its version check');
      env[key] = plan.bin;
      // Managed launches must obey Botons' update consent.
      if (brain === 'claude') { env.DISABLE_AUTOUPDATER = '1'; env.DISABLE_UPDATES = '1'; }
      output.detail(`${brain} installed. The owner signs in during setup; no credentials were created.`);
    }
  }
  output.done('Runtime and brains ready');
  const old = existsSync(current) ? realpathSync(current) : null;
  const hasDb = () => ['botons.db', DB_FILE].some(f => existsSync(join(data, f)));
  if (old && hasDb()) run(node, [realpathSync(join(old, 'scripts/backup.ts'))], env);
  const selected = o.source || (o.command === 'upgrade' ? saved?.source : null);
  if (o.command === 'upgrade' && !selected) throw new Error('Upgrade requires --source <tarball, directory or git URL>; no registry release is assumed.');
  let input = old && o.command === 'repair' && !o.source ? old : source;
  let temporary;
  if (selected) {
    temporary = join(root, '.source-' + randomUUID());
    mkdirSync(temporary);
    if (/^(git\+|https?:.*\.git)/.test(selected)) {
      run('git', ['clone', '--', selected.replace(/^git\+/, ''), join(temporary, 'app')]);
      if (o.ref || saved?.ref) run('git', ['checkout', '--detach', o.ref || saved.ref], process.env, join(temporary, 'app'));
      input = join(temporary, 'app');
    } else if (existsSync(resolve(selected)) && !/\.t(?:ar\.gz|gz)$/.test(selected)) {
      input = resolve(selected);
    } else {
      const archive = join(temporary, 'source.tgz');
      writeFileSync(archive, /^https?:/.test(selected) ? await download(selected) : readFileSync(resolve(selected)));
      mkdirSync(join(temporary, 'app'));
      run('tar', ['-xzf', archive, '--strip-components=1', '-C', join(temporary, 'app')]);
      input = join(temporary, 'app');
    }
  }
  if (existsSync(join(input, 'payload/package.json'))) input = join(input, 'payload');
  const version = sourceVersion(input);
  const release = join(root, 'releases', version);
  const reuse = old === release && o.command !== 'upgrade' && !o.source;
  const staging = join(root, '.release-' + randomUUID());
  try {
    if (existsSync(release) && !reuse) throw new Error('Release version already installed; choose a distinct source version');
    if (!reuse) {
      mkdirSync(staging, { recursive: true });
      for (const item of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'server', 'shared', 'scripts', 'installer', 'web', 'LICENSE']) {
        if (existsSync(join(input, item))) cpSync(join(input, item), join(staging, item), { recursive: true, filter: p => !['node_modules', '.git'].includes(p.split('/').at(-1)) });
      }
      if (!existsSync(join(staging, 'package-lock.json')) && existsSync(join(staging, 'installer/source-lock.json'))) cpSync(join(staging, 'installer/source-lock.json'), join(staging, 'package-lock.json'));
      const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
      if (!existsSync(join(staging, 'web/dist/index.html'))) {
        run(node, [npm, 'ci', '--ignore-scripts'], env, staging);
        run(node, [npm, 'run', 'build'], env, staging);
      }
      run(node, [npm, 'ci', '--omit=dev', '--ignore-scripts'], env, staging);
      mkdirSync(dirname(release), { recursive: true });
      renameSync(staging, release);
    } else {
      const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
      run(node, [npm, 'ci', '--omit=dev', '--ignore-scripts'], env, release);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  const unitRoot = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
  const priorUnits = ['botons.service', 'botons-backup.service', 'botons-backup.timer'].map(name => {
    const path = join(unitRoot, name);
    return { path, contents: existsSync(path) ? readFileSync(path) : null };
  });
  const priorConfig = existsSync(config) ? readFileSync(config) : null;
  const priorMarker = existsSync(marker) ? readFileSync(marker) : null;
  // The command links as they are, to put back exactly if activation fails.
  const priorLinks = [bin, ...legacyBins()].map(path => ({ path, target: lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : null }));
  try {
    link(release, current);
    mkdirSync(dirname(bin), { recursive: true }); link(entryOf(current), bin);
    for (const p of legacyBins()) link(entryOf(current), p);
    if (!existsSync(config)) {
      mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
      writeFileSync(config, Object.entries(env).filter(([k]) => ['PATH', 'BOTONS_HOME', 'BOTONS_HOST', 'BOTONS_PORT', 'BOTONS_NO_TAILSCALE', 'BOTONS_PUBLIC_URL', 'BOTONS_OAUTH_PUBLIC_URL', 'BOTONS_BACKUP_DIR', 'BOTONS_CLAUDE_BIN', 'BOTONS_CODEX_BIN', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES'].includes(k)).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n', { mode: 0o600 });
    }
    if (o.host) {
      const text = readFileSync(config, 'utf8').split('\n').filter(line => !/^\s*(?:export\s+)?BOTONS_HOST\s*=/.test(line)).join('\n');
      writeFileSync(config, text.trimEnd() + '\nBOTONS_HOST=' + JSON.stringify(o.host) + '\n', { mode: 0o600 });
    }
    if (o['public-url']) {
      writeFileSync(config, publicSettings(readFileSync(config, 'utf8'), o['public-url']), { mode: 0o600 });
      output.detail('Saved BOTONS_PUBLIC_URL and BOTONS_OAUTH_PUBLIC_URL for the app and OAuth callbacks: ' + new URL(o['public-url']).origin);
    }
    if (!o['no-service']) {
      try {
        run(node, [realpathSync(join(current, 'scripts/install-service.ts')), '--app', current, '--name', 'botons', '--quiet'], env);
        run(node, [realpathSync(join(current, 'scripts/install-backup-timer.ts')), '--app', current, '--quiet'], env);
        run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', '--now', 'botons-backup.timer']); run('systemctl', ['--user', 'restart', 'botons']); run('systemctl', ['--user', 'enable', 'botons']);
        await waitHealthy(env);
      } catch (e) {
        throw new Error(`${e.message}. Activation failed; attempting to restore code and configuration. Schema changes require restoring the fresh backup; data is never restored automatically.`);
      }
    }
    writeFileSync(marker, JSON.stringify({ data, node, source: selected || saved?.source || null, ref: o.ref || saved?.ref || null }));
  } catch (error) {
    try {
      if (!old && !o['no-service']) spawnSync('systemctl', ['--user', 'disable', '--now', 'botons', 'botons-backup.timer'], { stdio: output.stdio });
      for (const unit of priorUnits) {
        if (unit.contents) writeFileSync(unit.path, unit.contents);
        else rmSync(unit.path, { force: true });
      }
      if (priorConfig) writeFileSync(config, priorConfig, { mode: 0o600 });
      else rmSync(config, { force: true });
      if (priorMarker) writeFileSync(marker, priorMarker);
      else rmSync(marker, { force: true });
      if (old) link(old, current);
      else rmSync(current, { force: true });
      for (const { path, target } of priorLinks) {
        if (target) link(target, path);
        else rmSync(path, { force: true });
      }
      if (!o['no-service']) {
        run('systemctl', ['--user', 'daemon-reload']);
        if (undoNames) {
          undoNames();
          undoNames = null;
          await waitHealthy(previousEnv);
        } else if (old) {
          run('systemctl', ['--user', 'restart', 'botons']);
          await waitHealthy(previousEnv);
        }
      }
    } catch (rollbackError) {
      throw new Error(`${error.message} Rollback also failed: ${rollbackError.message}. Restore the fresh backup if the schema changed, then retry.`);
    } finally {
      if (!reuse && (!existsSync(current) || realpathSync(current) !== release)) rmSync(release, { recursive: true, force: true });
    }
    throw error;
  }
  output.done('Botons and backups installed');
  let pathReady = true;
  await configurePath({ home: homedir(), shell: process.env.SHELL, path: process.env.PATH, yes: true }, consent, message => { pathReady = false; output.detail(message); });
  const bootReady = o['no-service'] ? true : await configureLinger({ yes: o.yes, noSudo: o['no-sudo'] }, async (message, yes) => { if (message.startsWith('Run exactly:')) await consent(message, yes); }, { log: message => output.detail(message) });
  const command = onPath(homedir(), process.env.PATH) ? 'botons' : bin;
  if (!o['no-service'] && hasDb()) {
    run(node, [realpathSync(join(current, 'scripts/backup.ts'))], env);
  }
  output.replay();
  output.done('Setup ready');
  if (!pathReady) console.log(`• PATH setup needs attention; use ${command} and see ${join(root, 'install.log')}.`);
  console.log(summary({ command, url: env.BOTONS_PUBLIC_URL || `http://127.0.0.1:${env.BOTONS_PORT || env.PORT || 7777}`, running: !o['no-service'], bootReady, bootFix: lingerCommand() }));
  } catch (error) {
    // Anything that failed before the activation's own rollback: the earlier units come back.
    if (undoNames) { try { undoNames(); } catch {} }
    throw error;
  } finally {
    if (helpers) rmSync(helpers, { recursive: true, force: true });
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`✗ ${e.message}`); if (output) console.error(output.failure()); process.exitCode = 1; });
