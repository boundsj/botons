import { homedir } from 'node:os';
import { join } from 'node:path';

/** Installed browsers; the explicitly configured and Playwright copies take precedence. */
export function browserSearchPaths(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'darwin') {
    return ['/Applications', join(home, 'Applications')].flatMap((root) => [
      join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
      join(root, 'Chromium.app/Contents/MacOS/Chromium'),
    ]);
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}
