import { join, resolve } from 'node:path';
import { chooseHome } from '../server/src/config.ts';
import { applyLegacyEnv, earlierEnvNames, isLegacySetting } from '../shared/legacy-names.mjs';

/**
 * `npm run dev`'s environment: every default differs from the live server's so dev never opens its data or port.
 * The shell's BOTONS_HOOKS_* belong to the live server and are dropped; BOTONS_DEV_HOOKS_* become them.
 * A short drain because node --watch waits for the old server to exit before restarting.
 */
export function devEnv(given: NodeJS.ProcessEnv, repoRoot: string): NodeJS.ProcessEnv {
  // Deprecated names count as their BOTONS_* ones here too (the live server's hooks are dropped by either name).
  const env: NodeJS.ProcessEnv = { ...given };
  // Refuses two names for the home setting that disagree.
  if (['BOTONS_HOME', ...earlierEnvNames('BOTONS_HOME')].some((k) => env[k]?.trim())) chooseHome(env);
  applyLegacyEnv(env);
  const devHome = '.botons-dev';
  const port = env.BOTONS_PORT || env.PORT || '7778';
  const host = env.BOTONS_HOST || '127.0.0.1';
  const first = host.split(',')[0].trim();
  const apiHost = first === '0.0.0.0' ? '127.0.0.1' : first === '::' ? '[::1]' : first.includes(':') ? `[${first}]` : first;
  const out: NodeJS.ProcessEnv = {
    ...env,
    BOTONS_HOME: env.BOTONS_HOME ? resolve(env.BOTONS_HOME) : join(repoRoot, devHome),
    BOTONS_PORT: port,
    BOTONS_HOST: host,
    BOTONS_NO_TAILSCALE: env.BOTONS_NO_TAILSCALE ?? '1',
    BOTONS_ENABLE_MOCK: env.BOTONS_ENABLE_MOCK ?? '1',
    BOTONS_DRAIN_MS: env.BOTONS_DRAIN_MS || '5s',
    BOTONS_API: env.BOTONS_API || `http://${apiHost}:${port}`,
  };
  delete out.PORT;
  // Folded into their BOTONS_* names above; left in, the live server's home under a deprecated name would conflict with dev's own.
  for (const k of Object.keys(out)) if (isLegacySetting(k)) delete out[k];
  for (const name of ['PORT', 'HOST', 'PUBLIC_URL']) {
    delete out[`BOTONS_HOOKS_${name}`];
    const dev = env[`BOTONS_DEV_HOOKS_${name}`];
    if (dev) out[`BOTONS_HOOKS_${name}`] = dev;
    delete out[`BOTONS_DEV_HOOKS_${name}`];
  }
  return out;
}

/** Vite's allowedHosts: the BOTONS_ALLOWED_HOSTS names the API server also accepts (undefined: Vite's default). */
export function webAllowedHosts(env: NodeJS.ProcessEnv): string[] | undefined {
  const names = (env.BOTONS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return names.length ? names : undefined;
}
