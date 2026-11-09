import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const packages = Object.freeze({ claude: '@anthropic-ai/claude-code', codex: '@openai/codex' });

/** Fixed publisher packages only; no shell evaluates the displayed command. */
export function cliInstallPlan(root, node, provider, prefix = join(root, 'clis', provider)) {
  if (!Object.hasOwn(packages, provider)) throw new Error('Choose claude or codex');
  const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
  const args = [npm, 'install', '--global', '--prefix', prefix, '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', `--globalconfig=${join(prefix, '.botons-empty-npmrc')}`, packages[provider] + '@latest'];
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return { provider, prefix, bin: join(prefix, 'bin', provider), command: node, args, display: [node, ...args].map(quote).join(' ') };
}

/** Consent precedes every mutation, including when --yes supplies that consent. */
export async function installCli(plan, { consent, yes = false, env = process.env, run = (cmd, args, options) => spawnSync(cmd, args, options) }) {
  await consent(`Install ${plan.provider} for the server user using exactly:\n${plan.display}`, yes);
  const result = run(plan.command, plan.args, {
    stdio: 'inherit', timeout: 5 * 60_000,
    env: { ...env, PATH: `${dirname(plan.command)}:${env.PATH || ''}`, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' },
  });
  if (result.error || result.status !== 0) throw new Error(`${plan.provider} installation failed; sign-in has not been started`);
}

/** Tests and callers pass the same environment the service will use. */
export function cliPresent(bin, env = process.env) {
  return spawnSync(bin, ['--version'], { env, stdio: 'ignore', timeout: 10_000 }).status === 0;
}
