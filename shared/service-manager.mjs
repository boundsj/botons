import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Service identities include the user's home so isolated installs cannot stop another home's agent. */
export function serviceManager({ platform = process.platform, home = homedir(), configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'), name = 'botons', uid = process.getuid?.() } = {}) {
  if (!/^[\w@.-]+$/.test(name)) throw new Error('Invalid service name');
  if (platform !== 'linux' && platform !== 'darwin') throw new Error('Services require Linux or macOS');
  let identity = resolve(home);
  try { identity = realpathSync(identity); } catch {}
  const label = `com.botons.${name}.${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
  const backupLabel = `${label}.backup`;
  const domain = `gui/${uid}`;
  const dir = platform === 'darwin' ? join(home, 'Library', 'LaunchAgents') : join(configHome, 'systemd', 'user');
  const serviceFile = join(dir, platform === 'darwin' ? `${label}.plist` : `${name}.service`);
  const backupFile = join(dir, platform === 'darwin' ? `${backupLabel}.plist` : `${name}-backup.service`);
  return { platform, dir, files: platform === 'darwin' ? [serviceFile, backupFile] : [serviceFile, backupFile, join(dir, `${name}-backup.timer`)], serviceFile, backupFile, label, backupLabel, target: `${domain}/${label}`, backupTarget: `${domain}/${backupLabel}`, domain };
}

export function serviceCommands(action, options = {}, kind = 'server') {
  const m = serviceManager(options);
  const backup = kind === 'backup';
  const name = options.name || 'botons';
  const unit = backup ? `${name}-backup.timer` : name;
  if (m.platform === 'linux') {
    const args = { check: ['show-environment'], reload: ['daemon-reload'], start: ['enable', '--now', unit], activate: ['enable', '--now', unit], restart: ['restart', unit], stop: ['stop', unit], uninstall: ['disable', '--now', unit], status: ['status', unit] }[action];
    if (!args) throw new Error(`Unknown service action: ${action}`);
    return [['systemctl', ['--user', ...args]]];
  }
  const file = backup ? m.backupFile : m.serviceFile;
  const target = backup ? m.backupTarget : m.target;
  const commands = { check: [['launchctl', ['print', m.domain]]], reload: [], start: [['launchctl', ['bootstrap', m.domain, file]]], activate: [['launchctl', ['bootstrap', m.domain, file]]], stop: [['launchctl', ['bootout', target]]], uninstall: [['launchctl', ['bootout', target]]], restart: [['launchctl', ['bootout', target]], ['launchctl', ['bootstrap', m.domain, file]]], status: [['launchctl', ['print', target]]] }[action];
  if (!commands) throw new Error(`Unknown service action: ${action}`);
  return commands;
}

/** Execute lifecycle actions; an absent LaunchAgent is harmless, but permission and ownership failures are not. */
export function runService(action, options = {}, kind = 'server', execute = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }), timing = {}) {
  const now = timing.now ?? Date.now;
  const pause = timing.pause ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const m = serviceManager(options);
  const checked = (cmd, args) => {
    const r = execute(cmd, args);
    if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.error?.message || String(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
    return r;
  };
  if (m.platform === 'darwin' && ['start', 'activate', 'restart', 'stop', 'uninstall'].includes(action)) {
    const target = kind === 'backup' ? m.backupTarget : m.target;
    const file = kind === 'backup' ? m.backupFile : m.serviceFile;
    const inspect = () => {
      const result = execute('launchctl', ['print', target]);
      const loaded = !result.error && result.status === 0;
      if (!loaded && (result.error || result.status !== 113 || !String(result.stderr).includes('Could not find service'))) throw new Error(`Cannot inspect LaunchAgent: ${result.error?.message || result.stderr || result.stdout}`);
      if (loaded) {
        const source = String(result.stdout).split('\n').map((line) => line.trim()).find((line) => line.startsWith('path = '))?.slice(7);
        let sameFile = source === file;
        try { sameFile = realpathSync(source) === realpathSync(file); } catch {}
        if (!sameFile) throw new Error('The loaded LaunchAgent belongs to another installation; nothing was changed.');
      }
      return { result, loaded };
    };
    const state = inspect();
    if (state.loaded) {
      if (action === 'start' || action === 'activate') return kind === 'backup' ? state.result : checked('launchctl', ['kickstart', target]);
      checked('launchctl', ['bootout', target]);
      // bootout can return while the server is still draining. Reloading its label or removing its files then races shutdown.
      let stopTimeoutMs = kind === 'backup' ? 30_000 : 180_000;
      try {
        const seconds = /<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/.exec(readFileSync(file, 'utf8'))?.[1];
        const value = Number(seconds);
        // The supported drain budget is at most 30 minutes, with a minute for shutdown and unloading.
        if (seconds && Number.isSafeInteger(value)) stopTimeoutMs = Math.min(value + 30, 31 * 60) * 1000;
      } catch {}
      const deadline = now() + stopTimeoutMs;
      while (inspect().loaded) {
        if (now() >= deadline) throw new Error('The LaunchAgent is still stopping; no replacement was started. Check its logs and retry.');
        pause(Math.min(100, deadline - now()));
      }
    }
    if (['stop', 'uninstall'].includes(action)) return state.result;
    return checked('launchctl', ['bootstrap', m.domain, file]);
  }
  let result;
  for (const [cmd, args] of serviceCommands(action, options, kind)) result = checked(cmd, args);
  return result;
}
