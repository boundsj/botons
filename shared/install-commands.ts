export type InstallType = 'managed' | 'docker' | 'service';
/** Arguments are hints for a human, never executed by a shell. */
export function installCommand(type: InstallType, action: 'pair' | 'backup' | 'restore' | 'doctor' | 'repair' | 'serve', args = ''): string {
  if (action === 'repair') return type === 'service' ? 'npm run build' : type === 'docker' ? 'docker compose up -d --build botons' : '~/.local/bin/botons repair';
  const base = type === 'docker' ? `docker compose exec botons botons ${action}` : type === 'managed' ? `~/.local/bin/botons ${action}` : `npm run ${action}`;
  return base + (args ? `${type === 'service' ? ' --' : ''} ${args}` : '');
}
