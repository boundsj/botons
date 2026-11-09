// `npm run restore -- <backup> [--yes]`: put a backup made by `npm run backup` back into BOTONS_HOME.
// The server must be stopped. Nothing is deleted: the current database and folders move to before-restore-<time>/.
// BOTONS_HOME may not exist yet (a new machine): it is created, private, with --yes.
import '../server/src/env-init.ts';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { listBackups, planRestore, restore } from '../server/src/backup.ts';
import { botonsHome } from '../server/src/config.ts';
import { DataDirInUseError, lockDataDir } from '../server/src/lock.ts';
import { SCHEMA_VERSION } from '../server/src/schema.ts';
import { defaultUnitName, serverEnv } from './install-service.ts';

const USAGE = `Usage:
  npm run restore -- --list              list the backups in BOTONS_HOME/backups, oldest first
  npm run restore -- <backup>            show what restoring <backup> would do (changes nothing)
  npm run restore -- <backup> --yes      restore it (the server must be stopped)

<backup> is a folder name from --list, "latest", or the path of a backup folder.
Uses the data folder in BOTONS_HOME if it is set; otherwise the one the
service's environment file sets (--env-path, default ~/.config/botons/env);
otherwise ~/.botons. In Docker, see docs/DOCKER.md.`;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { yes: { type: 'boolean' }, list: { type: 'boolean' }, 'env-path': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
} catch (err) {
  fail(`${(err as Error).message}\n\n${USAGE}`, 2);
}
const { values: args, positionals } = parsed;
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

let home: string;
try {
  home = botonsHome(serverEnv(args['env-path']).env);
} catch (err) {
  fail((err as Error).message);
}
if (args.list) {
  const names = listBackups(join(home, 'backups'));
  if (!names.length) console.log(`No backups in ${join(home, 'backups')}. \`npm run backup\` makes one.`);
  for (const n of names) {
    let about = '';
    try {
      const m = JSON.parse(readFileSync(join(home, 'backups', n, 'manifest.json'), 'utf8'));
      about = `  schema v${m.schemaVersion}${m.workspaces ? ', workspaces' : ', database only'}`;
    } catch {}
    console.log(`${n}${about}`);
  }
  process.exit(0);
}
if (positionals.length !== 1) fail(USAGE, 2);

let plan;
try {
  plan = planRestore({ home, backup: positionals[0], maxSchema: SCHEMA_VERSION });
} catch (err) {
  fail(`Cannot restore: ${(err as Error).message}`);
}
const fresh = !existsSync(home);
console.log(`Restore ${plan.from}
  into     ${home}${fresh ? ' (it does not exist yet: created, private)' : ''}
  database schema v${plan.schemaVersion}${plan.schemaVersion < SCHEMA_VERSION ? ` (the server upgrades it to v${SCHEMA_VERSION} at its next start)` : ''}
  ${plan.workspaces ? 'workspaces, shared, templates and browser profiles from workspaces.tar.gz' : 'no workspaces.tar.gz: the database only; the folders now in place are set aside too'}
  moves    ${plan.moves.length ? `${plan.moves.join(', ')} to ${plan.setAside}` : 'nothing: the data folder is empty'}`);

// The data folder, or the nearest folder it would be created in, must be writable by this user: say so before anything moves.
let writable = home;
while (!existsSync(writable) && dirname(writable) !== writable) writable = dirname(writable);
try {
  accessSync(writable, constants.W_OK | constants.X_OK);
} catch {
  fail(
    `\nCannot restore: ${writable} is not writable by this user (${userInfo().username}). Nothing was changed. Run the restore as the user that owns the data folder (the one the server runs as), or give that user write access to it (for example chmod u+rwx ${writable}), then run it again.`,
  );
}
if (!args.yes) {
  console.log('\nNothing was changed. Stop the server, then run this again with --yes.');
  process.exit(0);
}

let lock: ReturnType<typeof lockDataDir> | undefined;
try {
  if (fresh) mkdirSync(home, { recursive: true, mode: 0o700 });
  lock = lockDataDir(home);
  restore(home, plan);
} catch (err) {
  lock?.release();
  if (err instanceof DataDirInUseError) fail(`${err.message.replace('Nothing was changed.', '')}Stop the server first (${process.platform === 'darwin' ? 'botons stop' : `systemctl --user stop ${defaultUnitName()}, or docker compose stop botons`}). Nothing was changed.`);
  const message = (err as Error).message;
  const next = /No space left on device|ENOSPC/.test(message)
    ? `\nFree space on the disk that holds ${home} (df -h ${home}), or restore onto a larger disk, then run this again.`
    : /Permission denied|EACCES|EPERM/.test(message)
      ? `\nGive the user running this (${userInfo().username}) write access to everything in ${home}, or run it as the user that owns it, then run this again.`
      : '';
  fail(`${message}${next}`);
}
lock.release();
console.log(`\nRestored.${plan.moves.length ? ` The previous state is in ${plan.setAside} (delete it once you are happy).` : ''} Start the server again.`);
