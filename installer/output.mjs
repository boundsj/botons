import { mkdirSync, existsSync, renameSync, openSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function plan(command, brain) {
  return command === 'uninstall' ? '• Stop Botons and remove its managed program, units and PATH block; keep data unless --purge.' : [
    '• Set up Node 24 for Botons (system Node untouched).',
    '• Install missing sandbox tools, including bubblewrap (sudo).',
    '• Start Botons at boot (linger), configure backups and PATH.',
    `• ${brain ? `Install ${brain} if missing; sign in later in setup.` : 'Keep existing brains; choose or install a CLI in setup.'}`,
  ].join('\n');
}
export function summary({ command = 'botons', url, running = true, bootReady = true, bootFix = 'sudo loginctl enable-linger <server-user>' }) {
  return `${running ? 'Botons is running! 🐾' : 'Botons is installed! 🐾'}${running ? '' : `\n  Start Botons: ${command} serve`}\n  Open ${url}\n  Approve your browser’s code: ${command} pair --approve <code>\n  Pick a brain in the setup screen — it can update Codex and fix config links for you.${bootReady ? '' : `\n  • Start at boot: ${bootFix}`}`;
}
export function installOutput(path, verbose = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) renameSync(path, path + '.1');
  const fd = openSync(path, 'a', 0o600);
  const start = Date.now();
  let offset = 0;
  return {
    replay() { const text = readFileSync(path, 'utf8'); if (verbose) process.stdout.write(text.slice(offset)); offset = text.length; },
    fd, stdio: ['inherit', fd, fd],
    detail(message) { appendFileSync(path, message + '\n');  },
    done(message) { console.log(`✓ ${message} (${Math.round((Date.now() - start) / 1000)}s)`); },
    failure() { try { return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-20).join('\n') + `\nLog: ${path}`; } catch { return `Log unavailable: ${path}`; } },
  };
}
