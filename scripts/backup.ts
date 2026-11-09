// `npm run backup` (and the nightly botons-backup.timer); BOTONS_BACKUP_RSYNC_TO also copies the new backup there.
import '../server/src/env-init.ts';
import { spawnSync } from 'node:child_process';
import { type BackupResult, backup } from '../server/src/backup.ts';
import { botonsHome } from '../server/src/config.ts';

let home: string;
try {
  home = botonsHome();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
let result: BackupResult;
try {
  result = backup({ home });
} catch (err) {
  console.error(`Backup of ${home} failed: ${(err as Error).message}`);
  process.exit(1);
}

const { manifest } = result;
const counts = Object.entries(manifest.counts)
  .map(([table, n]) => `${n} ${table}`)
  .join(', ');
console.log(`Backed up ${home} to ${result.dir}`);
console.log(`  schema v${manifest.schemaVersion}: ${counts}${manifest.workspaces ? '; workspaces.tar.gz' : ''}`);
if (manifest.tarWarning) console.warn(`  tar warnings (these files are not in the backup):\n${manifest.tarWarning.replace(/^/gm, '    ')}`);
if (result.removed.length) console.log(`  removed old backups: ${result.removed.join(', ')}`);
// Fail the run (and the unit) only after the database backup is in place and copied.
let failed = false;
if (manifest.workspacesError) {
  console.error(`The workspaces were NOT backed up; the database was. Older backups were kept. ${manifest.workspacesError}`);
  failed = true;
}

const target = process.env.BOTONS_BACKUP_RSYNC_TO;
if (target) {
  const rsync = spawnSync('rsync', ['-a', result.dir, `${target.replace(/\/+$/, '')}/`], { stdio: 'inherit' });
  if (rsync.status !== 0) {
    console.error(`Copying the backup to ${target} failed (${rsync.error?.message ?? `rsync exit ${rsync.status}`}). The local backup is kept.`);
    failed = true;
  } else {
    console.log(`  copied to ${target}`);
  }
}
if (failed) process.exit(1);
