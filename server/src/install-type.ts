import { existsSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCommand, type InstallType } from '../../shared/install-commands.ts';
export function installType(container = false, app = resolve(dirname(fileURLToPath(import.meta.url)), '../..')): InstallType {
  if (container) return 'docker';
  return basename(dirname(app)) === 'releases' && existsSync(join(dirname(dirname(app)), 'installer.json')) ? 'managed' : 'service';
}
export function serverCommand(action: Parameters<typeof installCommand>[1], args = '', container = process.env.BOTONS_CONTAINER === '1'): string {
  return installCommand(installType(container), action, args);
}
