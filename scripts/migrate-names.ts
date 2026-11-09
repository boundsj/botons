// `npm run migrate:names [-- --rollback | --no-start | --undo]`: moves an install off deprecated names (see
// server/src/legacy-upgrade.ts and shared/legacy-names.mjs). Part of the legacy-names module: it goes with it.
import '../server/src/env-init.ts';
import { spawnSync } from 'node:child_process';
import { ConfigError } from '../server/src/config.ts';
import { NameUpgradeError, rollbackNames, undoService, upgradeDataFolder, upgradeService } from '../server/src/legacy-upgrade.ts';
import { DataDirInUseError } from '../server/src/lock.ts';

const USAGE = `Usage: npm run migrate:names [-- --rollback]

Moves an install whose data folder, settings file, service or database still
have a deprecated name to the current ones: it stops the service, backs the
data up, moves the folders (leaving a link at each earlier path), writes
~/.config/botons/env with each setting under its current name, and starts
botons.service in place of the earlier unit, which it disables. Running it
again finishes what is missing and changes nothing else. The server and
\`npm run deploy\` do the same by themselves; this is for doing it now.

--rollback undoes it: the earlier unit, folders and database name come back,
and it names the backup taken first.`;

const exec = async (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
};
const log = (line: string) => console.log(line);

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return console.log(USAGE);
  if (args.includes('--rollback')) return void (await rollbackNames({ exec, log }));
  // The installer's own: --no-start leaves starting botons.service to it, and --undo puts the earlier unit back if that fails.
  if (args.includes('--undo')) return undoService({ exec, log });
  const done = await upgradeService({ exec, log, start: !args.includes('--no-start') });
  if (done.nothing) {
    const data = upgradeDataFolder({ log, explicit: true });
    if (!data.moved && !data.db) log('Nothing has a deprecated name: nothing to do.');
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.errors.join('\n'));
  else if (err instanceof NameUpgradeError || err instanceof DataDirInUseError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
