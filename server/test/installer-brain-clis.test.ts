import { cliHomesEnv } from '../src/cli-homes.ts';
import { earlierEnvNames } from '../../shared/legacy-names.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cliInstallPlan, installCli } from '../../installer/brain-clis.mjs';
import { parse } from '../../installer/botons.mjs';
import { agentEnv } from '../src/providers/process.ts';

test('CLI install plans use fixed official packages and a distinct user prefix', () => {
  for (const [id, pkg] of [['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex']]) {
    const plan = cliInstallPlan('/tmp/botons', '/tmp/runtime/bin/node', id);
    assert.equal(plan.bin, `/tmp/botons/clis/${id}/bin/${id}`);
    assert.deepEqual(plan.args, ['/tmp/runtime/lib/node_modules/npm/bin/npm-cli.js', 'install', '--global', '--prefix', plan.prefix, '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', `--globalconfig=${plan.prefix}/.botons-empty-npmrc`, pkg + '@latest']);
    assert.ok(!plan.display.includes('sudo'));
  }
  for (const value of ['other', '__proto__', 'codex;echo bad']) assert.throws(() => cliInstallPlan('/tmp/botons', process.execPath, value));
});

test('CLI selection is explicit even with --yes', () => {
  assert.equal(parse(['install', '--yes']).brain, undefined);
  assert.equal(parse(['install', '--brain', 'codex', '--yes']).brain, 'codex');
  for (const args of [['--brain'], ['--brain', 'both'], ['--brain', '--yes']]) assert.throws(() => parse(args));
});

test('consent includes the exact safely quoted executable and args before execution', async () => {
  const plan = cliInstallPlan("/tmp/botons' $(echo bad)", '/tmp/runtime/bin/node', 'claude');
  const seen: string[] = [];
  // POSIX shell parsing confirms the displayed command represents the real argv, without running it.
  const parsed = spawnSync('/bin/sh', ['-c', `set -- ${plan.display}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
  assert.deepEqual(parsed.stdout.trimEnd().split('\n'), [plan.command, ...plan.args]);
  await installCli(plan, { yes: true, env: { PATH: '/usr/bin' }, consent: async (message, yes) => {
    assert.ok(message.includes(plan.display)); assert.equal(yes, true); seen.push('consent');
  }, run: (cmd, args, options) => {
    assert.equal(cmd, plan.command); assert.deepEqual(args, plan.args); seen.push('run');
    assert.equal(options.env.PATH, '/tmp/runtime/bin:/usr/bin');
    assert.equal(options.env.DISABLE_AUTOUPDATER, '1');
    return { status: 0 };
  } });
  assert.deepEqual(seen, ['consent', 'run']);
});

test('refusal never runs npm and failures do not start sign-in', async () => {
  const plan = cliInstallPlan('/tmp/botons', '/tmp/runtime/bin/node', 'codex');
  await assert.rejects(installCli(plan, { consent: async () => { throw new Error('Cancelled'); }, run: () => { assert.fail('must not run'); } }), /Cancelled/);
  await assert.rejects(installCli(plan, { consent: async () => {}, run: () => ({ status: 1 }) }), /installation failed; sign-in has not been started/);
});

test('managed updater policy reaches CLI subprocesses without inheriting credentials', () => {
  assert.deepEqual(agentEnv({}, { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', BOTONS_SECRET: 'hidden' }), { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', ...cliHomesEnv({}) });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('botons serve admin launch preserves saved managed Claude updater policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-cli-admin-'));
  try {
    const config = join(home, '.config/botons');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'env'), 'BOTONS_CLAUDE_BIN="/tmp/managed/claude"\nDISABLE_AUTOUPDATER="1"\nDISABLE_UPDATES="1"\n');
    const script = join(home, 'inspect.ts');
    writeFileSync(script, `import {agentEnv} from ${JSON.stringify(new URL('../src/providers/process.ts', import.meta.url).href)}; console.log(JSON.stringify(agentEnv({})));`);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
    for (const key of ['BOTONS_HOME', ...earlierEnvNames('BOTONS_HOME'), 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES']) delete env[key as keyof typeof env];
    const result = spawnSync(process.execPath, [resolve('installer/admin.mjs'), script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const inherited = JSON.parse(result.stdout);
    assert.equal(inherited.DISABLE_AUTOUPDATER, '1');
    assert.equal(inherited.DISABLE_UPDATES, '1');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
