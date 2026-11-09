// `npm run backup:install [-- --app <dir> --dir <unit dir>]`: writes the nightly backup units. It enables nothing.
import '../server/src/env-init.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultEnvPath, launchAgentPlist, unitDirDefault } from './install-service.ts';
import { serviceManager } from '../shared/service-manager.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Writes botons-backup.service and botons-backup.timer (or `name`.*) into `unitDir`, running `app`'s backup with `node`. Returns their paths. */
export function writeBackupUnits(o: { app: string; unitDir: string; name?: string; node?: string; log?: (line: string) => void; platform?: string; envPath?: string; userHome?: string }): string[] {
  const name = o.name ?? 'botons-backup';
  if (!/^[\w@.-]+$/.test(name)) throw new Error(`--name ${name}: use letters, digits and - _ . @ only`);
  mkdirSync(o.unitDir, { recursive: true });
  if ((o.platform ?? process.platform) === 'darwin') {
    const home = o.userHome ?? homedir();
    const manager = serviceManager({ platform: 'darwin', home, name: name.replace(/-backup$/, '') });
    const file = join(o.unitDir, `${manager.backupLabel}.plist`);
    writeFileSync(file, launchAgentPlist({ label: manager.backupLabel, app: o.app, node: o.node ?? process.execPath, envPath: o.envPath ?? defaultEnvPath(), home, kind: 'backup' }), { mode: 0o600 });
    (o.log ?? console.log)(`Wrote ${file}`);
    return [file];
  }
  const out: string[] = [];
  for (const [template, unit] of [['botons-backup.service', `${name}.service`], ['botons-backup.timer', `${name}.timer`]]) {
    const text = readFileSync(join(repo, 'scripts', template), 'utf8')
      .replaceAll('@NODE@', o.node ?? process.execPath)
      .replaceAll('@REPO@', o.app)
      .replaceAll('@TIMER@', `${name}.timer`)
      .replaceAll('@SERVICE@', `${name}.service`);
    writeFileSync(join(o.unitDir, unit), text);
    (o.log ?? console.log)(`Wrote ${join(o.unitDir, unit)}`);
    out.push(join(o.unitDir, unit));
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => {
    const at = process.argv.indexOf(name);
    return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : null;
  };
  const dir = resolve(arg('--dir') ?? unitDirDefault());
  const name = arg('--name') ?? 'botons-backup';
  try {
    writeBackupUnits({ app: resolve(arg('--app') ?? repo), unitDir: dir, name, envPath: arg('--env-path') ?? undefined });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (!process.argv.includes('--quiet') && process.platform === 'darwin') {
    const manager = serviceManager({ name: name.replace(/-backup$/, '') });
    console.log(`Turn on the daily backup (03:30 while logged in; runs after waking if asleep):\n  launchctl bootstrap ${manager.domain} ${join(dir, `${manager.backupLabel}.plist`)}\nCheck it:\n  launchctl print ${manager.backupTarget}`);
  } else if (!process.argv.includes('--quiet')) console.log(`
Turn on the nightly backup (03:30, or at the next boot if that was missed):
  systemctl --user daemon-reload
  systemctl --user enable --now ${name}.timer

Check it:
  systemctl --user list-timers ${name}.timer
  systemctl --user start ${name}.service && journalctl --user -u ${name}.service -n 20

Run this again after moving the app folder or changing the Node version.`);
}
