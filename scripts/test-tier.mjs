import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// `npm test` runs these: in-process files, each under about a second, with no browser, Botons server, outside
// network, agent CLI or real deadline, and none reading the docs (CI skips them on docs-only changes).
// Short local child processes (`sh`, `node -e`), a loopback socket and timers of milliseconds are fine. Every other file runs only in `npm run test:full`,
// which `npm run deploy` runs before the web build. New files default to the full tier.
const unit = new Set([
  'ask-rules', 'brand', 'cli-copy', 'browser-defaults', 'browser-dial', 'browser-screenshot', 'ci-scope', 'cli-homes',
  'docker', 'doctor-egress', 'install-output', 'installer-brain-clis', 'installer-linger', 'installer-path', 'installer-revision',
  'instructions', 'legacy-names', 'licenses', 'perf-chat-budget', 'prompt', 'replay', 'replay-indexes', 'schedule', 'security-routes', 'security-units',
  'server-log-loader', 'theme', 'wake', 'boton', 'web-brains', 'web-browser-access', 'web-copy', 'web-deferred', 'web-files',
  'browser-handoff', 'browser-request', 'service-presets', 'web-live-view',
  'web-live-settings', 'web-reactions', 'web-sidebar', 'web-skills', 'web-util',
  'held-dir', 'private-storage', 'connector-launch',
].map(name => `${name}.test.ts`));
const tier = process.argv[2] || 'all';
if (!['unit', 'integration', 'all'].includes(tier)) throw new Error(`Unknown test tier: ${tier}`);
const files = readdirSync('server/test').filter(name => name.endsWith('.test.ts')).sort();
for (const name of unit) if (!files.includes(name)) throw new Error(`Missing unit test: ${name}`);
const selected = files.filter(name => (tier === 'all' || unit.has(name) === (tier === 'unit'))
  && !(process.argv.includes('--quarantine-handover') && name === 'browser-handover.test.ts'));
if (process.argv.includes('--list')) {
  console.log(selected.join('\n'));
} else {
  const args = ['--test', '--test-concurrency=4', '--test-timeout=120000',
    '--test-reporter=./scripts/test-timing.mjs', ...selected.map(name => `server/test/${name}`)];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, BOTONS_LOG_LEVEL: 'warn' } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
