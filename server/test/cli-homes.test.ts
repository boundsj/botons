import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliHome, cliHomesEnv, importCodexSignIn, prepareCliHomes } from '../src/cli-homes.ts';
import { agentEnv } from '../src/providers/process.ts';
import { privatePaths } from '../src/isolation.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'botons-homes-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const env = { HOME: root, BOTONS_HOME: join(root, 'data'), CODEX_HOME: join(root, '.codex'), CLAUDE_CONFIG_DIR: join(root, '.claude') };
  mkdirSync(env.CODEX_HOME); mkdirSync(env.CLAUDE_CONFIG_DIR);
  return {root, env};
}
test('fresh homes exclude personal instructions, skills and symlinks; sandbox keeps personal homes private', t => {
  const {root, env} = fixture(t);
  writeFileSync(join(root, 'instructions'), 'personal instructions');
  symlinkSync(join(root, 'instructions'), join(env.CODEX_HOME, 'AGENTS.md'));
  mkdirSync(join(env.CODEX_HOME, 'skills'));
  prepareCliHomes(env);
  const selected = cliHomesEnv(env);
  assert.equal(selected.CODEX_HOME, join(env.BOTONS_HOME, 'cli/codex'));
  assert.equal(selected.CLAUDE_CONFIG_DIR, join(env.BOTONS_HOME, 'cli/claude'));
  assert.equal(existsSync(join(selected.CODEX_HOME!, 'AGENTS.md')), false);
  assert.equal(existsSync(join(selected.CODEX_HOME!, 'skills')), false);
  assert.equal(agentEnv({ CODEX_HOME: '/unwanted' }, env).CODEX_HOME, selected.CODEX_HOME);
  const hidden = privatePaths({workspace: join(root, 'workspace'), userHome: root, botonsHome: env.BOTONS_HOME, workspacesDir: join(root, 'workspaces'), cli:'codex', env: {...env, ...selected}});
  assert.ok(hidden.includes(env.CODEX_HOME));
  assert.ok(!hidden.includes(join(env.BOTONS_HOME, 'cli')));
});
test('unattended upgrade retains personal credentials until explicit audited import, copies auth only', t => {
  const { env } = fixture(t);
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{"tokens":{"access_token":"test-only"}}');
  writeFileSync(join(env.CODEX_HOME, 'AGENTS.md'), 'personal');
  assert.equal(cliHome('codex', env).selected, env.CODEX_HOME);
  const destination = cliHome('codex', env, true).isolated;
  assert.equal(cliHomesEnv(env, true).CODEX_HOME, destination);
  assert.equal(existsSync(join(destination, 'auth.json')), false);
  assert.throws(() => importCodexSignIn(() => { throw new Error('audit unavailable'); }, env));
  assert.equal(existsSync(join(destination, 'auth.json')), false);
  const phases: string[] = [];
  importCodexSignIn(phase => phases.push(phase), env);
  assert.deepEqual(phases, ['confirmed', 'completed']);
  assert.equal(cliHome('codex', env).selected, destination);
  assert.equal(statSync(join(destination, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(destination, 'auth.json'), 'utf8'), readFileSync(join(env.CODEX_HOME, 'auth.json'), 'utf8'));
  assert.equal(existsSync(join(destination, 'AGENTS.md')), false);
  assert.throws(() => importCodexSignIn(() => {}, env));
});
test('separate login switches homes, and Claude retains its personal file login until then', t => {
  const { env } = fixture(t);
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  assert.equal(cliHome('claude', env).selected, env.CLAUDE_CONFIG_DIR);
  prepareCliHomes(env);
  writeFileSync(join(cliHome('claude', env, true).isolated, '.credentials.json'), '{}');
  assert.equal(cliHome('claude', env).pending, false);
});
test('credential import refuses source and destination symlinks', t => {
  const {root, env} = fixture(t);
  writeFileSync(join(root, 'auth'), '{}');
  symlinkSync(join(root, 'auth'), join(env.CODEX_HOME, 'auth.json'));
  assert.throws(() => importCodexSignIn(() => {}, env));
  rmSync(join(env.CODEX_HOME, 'auth.json'));
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}');
  mkdirSync(env.BOTONS_HOME);
  symlinkSync(root, join(env.BOTONS_HOME, 'cli'));
  assert.throws(() => importCodexSignIn(() => {}, env));
});

test('turn snapshot protects custom personal homes and pins selection across import', async t => {
  const {env} = fixture(t);
  const { cliTurn } = await import('../src/providers/cli-turn.ts');
  const saved = {...process.env};
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}');
  const req: any = { cwd: join(env.HOME, 'workspace'), access: 'workspace', privatePaths: [], env: {}, sharedDirs: [] };
  const before = cliTurn(req, 'codex');
  assert.equal(before.env.CODEX_HOME, env.CODEX_HOME);
  importCodexSignIn(() => {});
  assert.equal(before.env.CODEX_HOME, env.CODEX_HOME);
  const after = cliTurn(req, 'codex');
  assert.equal(after.env.CODEX_HOME, cliHome('codex').isolated);
  assert.ok(after.req.privatePaths.includes(env.CODEX_HOME));
  assert.ok(after.req.privatePaths.includes(join(after.env.CODEX_HOME!, 'auth.json')));
});
