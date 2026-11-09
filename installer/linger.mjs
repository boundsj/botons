import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

export function lingerCommand(user = userInfo().username) {
  const quotedUser = /^[a-zA-Z0-9_.-]+$/.test(user) ? user : "'" + user.replaceAll("'", "'\\''") + "'";
  return `sudo loginctl enable-linger ${quotedUser}`;
}

/** Optional boot persistence must never undo a working service installation. */
export async function configureLinger(options, ask, hooks = {}) {
  const execute = hooks.execute ?? ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
  const log = hooks.log ?? console.log;
  const user = hooks.user ?? userInfo().username;
  const fix = lingerCommand(user);
  const warn = reason => {
    log(`WARNING: Linger is not enabled (${reason}). Botons remains enabled and running, but will not survive logout/reboot until linger is on.\nRun: ${fix}`);
    return false;
  };
  try {
    const state = execute('loginctl', ['show-user', user, '-p', 'Linger']);
    if (state.status === 0 && /^Linger=yes\s*$/m.test(state.stdout || '')) {
      log('Linger is already enabled.');
      return true;
    }
    await ask('Enable linger so Botons starts before login', options.yes);
    const result = execute('loginctl', ['enable-linger']);
    if (result.status === 0) return true;
    const detail = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error?.message || ''}`;
    if (!/access denied|permission denied|polkit|pkttyagent|authentication|not authorized/i.test(detail)) return warn(detail.trim() || 'loginctl failed');
    log(fix);
    if (options.noSudo) return warn('--no-sudo');
    await ask(`Run exactly: ${fix}`, options.yes);
    const elevated = execute('sudo', ['loginctl', 'enable-linger', user]);
    if (elevated.status === 0) return true;
    return warn(elevated.stderr?.trim() || elevated.error?.message || 'sudo loginctl failed');
  } catch (error) {
    return warn(error.message || 'linger setup failed');
  }
}
