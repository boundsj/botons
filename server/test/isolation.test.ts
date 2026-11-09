import { cliHomesEnv } from '../src/cli-homes.ts';
// What a Boton can reach: private paths, the agent environment, and the modes of the data folder.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { claudeProjectDir, codexConfigSymlinks, parsePrivatePaths, privatePaths } from '../src/isolation.ts';
import { agentEnv, INHERITED_ENV } from '../src/providers/process.ts';
import { startServer, tempDir, until } from './helpers.ts';

const root = tempDir('botons-isolation-');

function touch(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
}

test('private paths: home secrets, the CLI logins and other sessions, Botons data, other workspaces and host extras', () => {
  const home = join(root, 'home');
  const botons = join(home, '.botons');
  const own = join(botons, 'workspaces', 'kevin-1');
  const secret = [
    '.ssh/id_ed25519', '.config/gh/hosts.yml', '.claude.json', '.config/opencode/auth.json', '.config/google-chrome/Default/Cookies',
    '.config/chromium/Default/Cookies', '.mozilla/firefox/x/cookies.sqlite', '.config/BraveSoftware/Brave-Browser/Default/Cookies',
    '.bash_history', '.zsh_history', '.npmrc', '.pypirc', '.cargo/credentials.toml', '.vault-token', '.pi/agent/auth.json', '.config/anthropic/x',
  ];
  const cli = ['.claude/.credentials.json', '.claude/history.jsonl', '.claude/shell-snapshots/s.sh', '.codex/auth.json', '.codex/sessions/r.jsonl', '.codex/tmp/arg0/x', '.codex/shell_snapshots/t.sh'];
  const ordinary = ['.config/editor/settings.json', '.bashrc', 'Projects/app/README.md', '.cargo/bin/rg', '.local/share/mise/installs/node/bin/node', '.config/terminal/config.toml', '.other-agent/state.json'];
  for (const f of [...secret, ...cli, ...ordinary]) touch(join(home, f));
  touch(join(home, '.claude/projects', claudeProjectDir(own), 's.jsonl'));
  touch(join(home, '.claude/projects/-home-u-Projects-secret-app/s.jsonl'));
  for (const f of ['botons.db', 'botons.db-wal', 'backups/2026/botons.db', 'workspaces/stuart-2/notes.md']) touch(join(botons, f));
  touch(join(own, 'notes.md'));

  const paths = (cli: 'claude' | 'codex' | null, extra?: string[]) =>
    privatePaths({ workspace: own, cli, botonsHome: botons, workspacesDir: join(botons, 'workspaces'), userHome: home, env: {}, extra }).map((p) => p.slice(home.length + 1));
  const listed = (list: string[], expected: string[]) => {
    for (const p of expected) assert.ok(list.includes(p), `${p} should be private: ${list.join(', ')}`);
  };
  const readable = (list: string[], expected: string[]) => {
    for (const p of expected) assert.ok(!list.some((q) => q === p || p.startsWith(`${q}/`)), `${p} should stay readable`);
  };

  const claude = paths('claude');
  listed(claude, ['.ssh', '.config/gh', '.claude.json', '.claude/.credentials.json', '.claude/history.jsonl', '.claude/projects/-home-u-Projects-secret-app', '.codex']);
  listed(claude, ['.botons/botons.db', '.botons/botons.db-wal', '.botons/backups', '.botons/workspaces/stuart-2']);
  listed(claude, ['.config/opencode', '.config/google-chrome', '.config/chromium', '.mozilla', '.config/BraveSoftware', '.bash_history', '.zsh_history']);
  listed(claude, ['.npmrc', '.pypirc', '.cargo/credentials.toml', '.vault-token', '.pi', '.config/anthropic']);
  // Its own workspace and session files, the snapshots its sandboxed shell sources, and ordinary files stay readable.
  readable(claude, ['.botons/workspaces/kevin-1/notes.md', `.claude/projects/${claudeProjectDir(own)}/s.jsonl`, '.claude/shell-snapshots/s.sh', ...ordinary]);
  // Missing secrets are skipped.
  assert.ok(!claude.includes('.gnupg') && !claude.includes('.aws'));

  const codex = paths('codex');
  listed(codex, ['.ssh', '.claude', '.codex/auth.json', '.codex/sessions', '.botons/botons.db', '.botons/workspaces/stuart-2']);
  readable(codex, ['.codex/tmp/arg0/x', '.codex/shell_snapshots/t.sh', '.botons/workspaces/kevin-1/notes.md']);

  // Host extras (BOTONS_PRIVATE_PATHS): listed when they exist, never one that holds the Boton's own workspace.
  const extra = paths('claude', [join(home, '.other-agent'), join(home, 'not-there'), join(botons, 'workspaces')]);
  assert.ok(extra.includes('.other-agent'), extra.join(', '));
  assert.ok(!extra.includes('not-there'));
  readable(extra, ['.botons/workspaces/kevin-1/notes.md']);

  // Nor a secret folder holding the Botons home (~/.config/botons).
  const inner = join(home, '.config/botons/workspaces/kevin-1');
  mkdirSync(inner, { recursive: true });
  const nested = privatePaths({ workspace: inner, cli: 'claude', botonsHome: join(home, '.config/botons'), workspacesDir: join(home, '.config/botons/workspaces'), userHome: home, env: {} });
  assert.ok(!nested.some((p) => inner === p || inner.startsWith(`${p}/`)), nested.join(', '));
});

test('BOTONS_PRIVATE_PATHS: like PATH, absolute, ~/ or relative to home; a Workspace turn gets the ones that exist, a Full computer turn none', async () => {
  assert.deepEqual(parsePrivatePaths('~/.other-agent: /srv/keys ::.some-tool/.env:~', '/home/u'), ['/home/u/.other-agent', '/srv/keys', '/home/u/.some-tool/.env', '/home/u']);
  assert.deepEqual(parsePrivatePaths(undefined, '/home/u'), []);
  assert.deepEqual(parsePrivatePaths('', '/home/u'), []);

  const keys = join(root, 'host-keys');
  touch(join(keys, 'api.env'));
  const { app, cfg, mock, storeBot } = await startServer({ env: { BOTONS_PRIVATE_PATHS: `${keys}:${join(root, 'missing')}` } });
  assert.deepEqual(cfg.privatePaths, [keys, join(root, 'missing')]);
  const ws = storeBot('Jerry');
  const host = storeBot('Phil', 'mock', { access: 'host' });
  for (const bot of [ws, host]) app.engine.sendMessage(bot.id, 'hi');
  await until(() => mock.turns.length >= 2 && [ws, host].every((b) => app.engine.statusOf(b.id).state === 'idle'));
  const turn = (cwd: string) => mock.turns.find((t) => t.cwd === cwd)!;
  assert.ok(turn(ws.workspace).privatePaths.includes(keys));
  assert.ok(!turn(ws.workspace).privatePaths.includes(join(root, 'missing')));
  assert.deepEqual(turn(host.workspace).privatePaths, []);
});

test('agents inherit only allowlisted variables, plus what the engine passes', () => {
  const env = agentEnv(
    { BOTONS_API: 'http://127.0.0.1:7777', BOTON_BOT_ID: 'bot_1', PATH: '/boton/bin:/usr/bin' },
    {
      HOME: '/home/u', PATH: '/usr/bin', USER: 'u', LANG: 'en_US.UTF-8', LC_TIME: 'en_GB.UTF-8', TERM: 'xterm',
      ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'secret',
      BOTONS_HOME: '/home/u/.botons', BOTONS_OWNER_LOGIN: 'u@example.com', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CODEX_THREAD_ID: 'def',
      DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    },
  );
  assert.deepEqual(env, {
    ...cliHomesEnv({HOME: '/home/u', BOTONS_HOME: '/home/u/.botons'}),
    HOME: '/home/u', PATH: '/boton/bin:/usr/bin', USER: 'u', LANG: 'en_US.UTF-8', LC_TIME: 'en_GB.UTF-8', TERM: 'xterm',
    BOTONS_API: 'http://127.0.0.1:7777', BOTON_BOT_ID: 'bot_1', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1',
  });
  assert.deepEqual(INHERITED_ENV, ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES']);
});

test('the data folder is 0700 and the database 0600 after startup, even after they were loosened', async () => {
  const home = join(root, 'data');
  const cfg = loadConfig({ BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: '1' });
  await createApp(cfg).close();
  const modes = (...files: string[]) => [home, ...files.map((f) => join(home, f))].map((p) => statSync(p).mode & 0o777);
  assert.deepEqual(modes('botons.db'), [0o700, 0o600]);

  chmodSync(home, 0o755);
  chmodSync(join(home, 'botons.db'), 0o644);
  const again = createApp(cfg);
  try {
    assert.deepEqual(modes('botons.db', 'botons.db-wal'), [0o700, 0o600, 0o600]);
  } finally {
    await again.close();
  }
});

test('Codex config diagnostics find file, directory and dangling links, keep runtime links alone, and leave masks intact', () => {
  const home = tempDir();
  const dir = join(home, '.codex');
  mkdirSync(dir);
  const target = join(home, 'instructions.md');
  touch(target);
  symlinkSync(target, join(dir, 'AGENTS.md'));
  symlinkSync(join(home, 'missing-skills'), join(dir, 'skills'));
  symlinkSync(join(home, 'runtime'), join(dir, 'tmp'));
  assert.deepEqual(codexConfigSymlinks({}, home), ['CODEX_HOME/AGENTS.md', 'CODEX_HOME/skills']);
  const masks = privatePaths({ workspace: join(home, 'workspace'), cli: 'codex', botonsHome: join(home, 'botons'), workspacesDir: join(home, 'botons/workspaces'), userHome: home, env: {} });
  assert.ok(masks.includes(join(dir, 'AGENTS.md')), 'the protected instruction link is still denied');
  const alias = join(home, 'alias');
  symlinkSync(dir, alias);
  assert.deepEqual(codexConfigSymlinks({ CODEX_HOME: alias }, home), ['CODEX_HOME']);
});
