// Which home each CLI runs in (cli-homes.ts). Codex runs in the server account's own home and its sign-in is never
// copied; Claude keeps Botons' own home. The fake codex below rotates its refresh token on every turn, as if each found
// its access token expired, so a stale copy of the sign-in fails as the real one does. It shows that Botons gives every
// turn, probe and login one home; it does not prove anything about OpenAI's real refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliHome, cliHomesEnv, codexGlobalInstructions, prepareCliHomes } from '../src/cli-homes.ts';
import { BrainLogin } from '../src/brain-login.ts';
import { agentEnv } from '../src/providers/process.ts';
import { carryRollout, CodexCliProvider, codexArgs } from '../src/providers/codex-cli.ts';
import { cliTurn } from '../src/providers/cli-turn.ts';
import { ProviderError, type TurnRequest } from '../src/providers/types.ts';
import { privatePaths } from '../src/isolation.ts';
import { until } from './helpers.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'botons-homes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, BOTONS_HOME: join(root, 'data'), CODEX_HOME: join(root, '.codex'), CLAUDE_CONFIG_DIR: join(root, '.claude') };
  return { root, env, kept: join(env.BOTONS_HOME, 'cli', 'codex') };
}

/** Runs the test with these variables in process.env (the providers read it), then puts it back. */
function useEnv(t: any, env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/** Every auth.json under `dir`, so a test can tell no copy was made. */
function authFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name === 'auth.json') out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * A stand-in codex: `login status` reads CODEX_HOME/auth.json; `login --device-auth` signs in there; `exec` refreshes the
 * sign-in first (one refresh token is valid at a time, held by `oauth.json`, and each refresh replaces it), under a lock
 * on its home with a reload before it commits, then resumes or starts a thread from CODEX_HOME/sessions. Each call is
 * logged with the home it ran in.
 */
function fakeCodex(root: string) {
  const bin = join(root, 'fake-codex');
  const log = join(root, 'calls.jsonl');
  const oauth = join(root, 'oauth.json');
  writeFileSync(oauth, JSON.stringify({ valid: 'r0', refreshes: 0 }));
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2), home = process.env.CODEX_HOME || '';
const ours = home.startsWith(${JSON.stringify(root)});
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const note = (what, extra = {}) => ours && fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ what, home, ...extra }) + '\\n');
const authPath = path.join(home, 'auth.json');
const read = () => { try { return JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { return null; } };
const write = (auth) => { const tmp = authPath + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(auth), { mode: 0o600 }); fs.renameSync(tmp, authPath); };
const server = () => JSON.parse(fs.readFileSync(${JSON.stringify(oauth)}, 'utf8'));
function withLock(fn) {
  const lock = path.join(home, 'auth.lock');
  for (let i = 0; ; i++) { try { fs.mkdirSync(lock); break; } catch { if (i > 2000) throw new Error('lock'); sleep(2); } }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}
if (argv[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0); }
if (argv[0] === 'sandbox') { console.log('BOTONS_WORKSPACE_PROBE_OK'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') {
  note('status');
  if (read()) { console.log('Logged in using ChatGPT'); process.exit(0); }
  console.log('Not logged in'); process.exit(1);
}
if (argv[0] === 'login') {
  note('login');
  console.log('https://auth.openai.com/codex/device'); console.log('ABCD-EFGHJ');
  sleep(50);
  const s = server(); s.valid = 'login-' + Date.now(); fs.writeFileSync(${JSON.stringify(oauth)}, JSON.stringify(s));
  write({ tokens: { refresh_token: s.valid } });
  process.exit(0);
}
if (argv[0] === 'exec') {
  if (!ours) { console.log(JSON.stringify({ type: 'thread.started', thread_id: 'probe' })); process.exit(0); }
  const failed = withLock(() => {
    const auth = read();
    if (!auth) return 'Not logged in';
    sleep(5);
    // The token server: the old refresh token works once.
    const s = server();
    if (auth.tokens.refresh_token !== s.valid) return 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    s.valid = 'r' + (++s.refreshes); fs.writeFileSync(${JSON.stringify(oauth)}, JSON.stringify(s));
    write({ tokens: { refresh_token: s.valid } });
    return null;
  });
  note('exec', { failed, resume: argv[1] === 'resume' ? argv.at(-2) : null });
  if (failed) { console.log(JSON.stringify({ type: 'error', message: failed })); console.log(JSON.stringify({ type: 'turn.failed', error: { message: failed } })); process.exit(1); }
  const day = path.join(home, 'sessions', '2026', '11', '15');
  let id = argv[1] === 'resume' ? argv.at(-2) : null, file;
  if (id) {
    const find = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) { const f = find(p); if (f) return f; } else if (e.name.endsWith('-' + id + '.jsonl')) return p; } return null; };
    file = find(path.join(home, 'sessions'));
    if (!file) { console.error('Error: thread/resume: thread/resume failed: no rollout found for thread id ' + id); process.exit(1); }
  } else {
    id = '019a0000-0000-7000-8000-' + (process.pid.toString(16) + Date.now().toString(16)).slice(-12).padStart(12, '0');
    fs.mkdirSync(day, { recursive: true });
    file = path.join(day, 'rollout-2026-11-15T00-00-00-' + id + '.jsonl');
  }
  const prompt = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: prompt } }) + '\\n');
  const seen = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean).length;
  console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'remembers ' + seen } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
  process.exit(0);
}
process.exit(2);
`);
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, calls, signIn: (home: string) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'r0' } })); } };
}

function turn(root: string, over: Partial<TurnRequest> = {}): TurnRequest {
  mkdirSync(join(root, 'workspace'), { recursive: true });
  return {
    cwd: join(root, 'workspace'), sessionId: null, systemPrompt: 'You are a test Boton.', prompt: 'hello', model: '', access: 'host', privatePaths: [],
    env: {}, signal: new AbortController().signal, timeoutMs: 20_000, onActivity: () => {}, ...over,
  };
}

test('Codex runs in CODEX_HOME, else the account ~/.codex, for turns, probes, login and updates alike', (t) => {
  const { root, env } = fixture(t);
  for (const login of [false, true]) assert.equal(cliHomesEnv(env, login).CODEX_HOME, env.CODEX_HOME);
  const { CODEX_HOME: _, ...noVar } = env;
  for (const login of [false, true]) assert.equal(cliHomesEnv(noVar, login).CODEX_HOME, join(root, '.codex'));
  // A variable a caller passes can't move a CLI elsewhere.
  assert.equal(agentEnv({ CODEX_HOME: '/unwanted' }, env).CODEX_HOME, env.CODEX_HOME);
});

test('preparing homes creates the Codex account home privately and no Botons copy of it', (t) => {
  const { env, kept } = fixture(t);
  prepareCliHomes(env);
  assert.equal(statSync(env.CODEX_HOME).mode & 0o777, 0o700);
  assert.equal(existsSync(kept), false);
  assert.equal(existsSync(join(env.BOTONS_HOME, 'cli', 'claude')), true);
});

test('both sign-ins: the account one is used and neither file is changed; the kept one stays for recovery', (t) => {
  const { root, env, kept } = fixture(t);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{"tokens":{"refresh_token":"account"}}');
  writeFileSync(join(kept, 'auth.json'), '{"tokens":{"refresh_token":"kept"}}');
  prepareCliHomes(env);
  const home = cliHome('codex', env);
  assert.equal(home.selected, env.CODEX_HOME);
  assert.equal(home.keptOnly, false);
  assert.equal(home.pending, false);
  assert.equal(readFileSync(join(env.CODEX_HOME, 'auth.json'), 'utf8'), '{"tokens":{"refresh_token":"account"}}');
  assert.equal(readFileSync(join(kept, 'auth.json'), 'utf8'), '{"tokens":{"refresh_token":"kept"}}');
  assert.deepEqual(authFiles(root), [join(env.CODEX_HOME, 'auth.json'), join(kept, 'auth.json')]);
});

test('only a kept Botons sign-in: used in place until the account signs in, never copied', (t) => {
  const { root, env, kept } = fixture(t);
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, 'auth.json'), '{}');
  const { CODEX_HOME: accountHome, ...defaultEnv } = env;
  assert.equal(cliHome('codex', defaultEnv).keptOnly, true);
  assert.equal(cliHomesEnv(defaultEnv).CODEX_HOME, kept);
  // Signing in always signs in the account home.
  assert.equal(cliHomesEnv(env, true).CODEX_HOME, env.CODEX_HOME);
  prepareCliHomes(defaultEnv);
  assert.deepEqual(authFiles(root), [join(kept, 'auth.json')]);
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}');
  assert.equal(cliHome('codex', env).keptOnly, false);
  assert.equal(cliHomesEnv(defaultEnv).CODEX_HOME, env.CODEX_HOME);
});

test('no sign-in anywhere: the account home, signed out', (t) => {
  const { env } = fixture(t);
  const home = cliHome('codex', env);
  assert.equal(home.selected, env.CODEX_HOME);
  assert.equal(home.keptOnly, false);
});

test('a CODEX_HOME that is the Botons folder itself is just the account home', (t) => {
  const { env, kept } = fixture(t);
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, 'auth.json'), '{}');
  const same = { ...env, CODEX_HOME: kept };
  assert.equal(cliHome('codex', same).keptOnly, false);
  assert.equal(cliHome('codex', same).selected, kept);
});

test("Claude keeps Botons' own home, with a personal file sign-in in use until the owner signs in for Botons", (t) => {
  const { env } = fixture(t);
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  assert.equal(cliHome('claude', env).pending, true);
  assert.equal(cliHomesEnv(env).CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
  assert.equal(cliHomesEnv(env, true).CLAUDE_CONFIG_DIR, join(env.BOTONS_HOME, 'cli', 'claude'));
  prepareCliHomes(env);
  writeFileSync(join(env.BOTONS_HOME, 'cli', 'claude', '.credentials.json'), '{}');
  assert.equal(cliHome('claude', env).pending, false);
  assert.equal(cliHomesEnv(env).CLAUDE_CONFIG_DIR, join(env.BOTONS_HOME, 'cli', 'claude'));
});

test("Codex turns keep the user's config, rules, plugins, apps, hooks and skills out; the sandbox hides the home Codex doesn't use", (t) => {
  const { root, env, kept } = fixture(t);
  useEnv(t, env);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}');
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), '');
  writeFileSync(join(kept, 'auth.json'), '{}');
  const args = codexArgs({ systemPrompt: 'x', model: '', sessionId: null, access: 'workspace', cwd: join(root, 'workspace'), privatePaths: [] }).join(' ');
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--disable plugins', '--disable remote_plugin', '--disable apps', '--disable tool_suggest', '--disable hooks', 'skills.include_instructions=false', 'skills.bundled.enabled=false']) assert.ok(args.includes(flag), flag);
  const snap = cliTurn(turn(root, { access: 'workspace' }), 'codex');
  assert.equal(snap.env.CODEX_HOME, env.CODEX_HOME);
  assert.ok(snap.req.privatePaths.includes(kept), 'the kept Botons home is hidden');
  assert.ok(snap.req.privatePaths.includes(join(env.CODEX_HOME, 'auth.json')), "the sign-in is hidden from the Boton's commands");
  assert.ok(snap.req.privatePaths.includes(join(env.CODEX_HOME, 'config.toml')));
  rmSync(join(env.CODEX_HOME, 'auth.json'));
  const fallback = cliTurn(turn(root, { access: 'workspace' }), 'codex');
  assert.equal(fallback.env.CODEX_HOME, env.CODEX_HOME);
  assert.ok(fallback.req.privatePaths.includes(kept), 'the unused home stays hidden after logout');
  const hidden = privatePaths({ workspace: join(root, 'workspace'), userHome: root, botonsHome: env.BOTONS_HOME, workspacesDir: join(root, 'workspaces'), cli: 'codex', env: { ...env, ...cliHomesEnv(env) } });
  assert.ok(hidden.includes(kept));
});

test("the account's global AGENTS.md is reported, since Codex adds it to every turn", (t) => {
  const { env } = fixture(t);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  assert.deepEqual(codexGlobalInstructions(env), []);
  writeFileSync(join(env.CODEX_HOME, 'AGENTS.md'), 'x');
  assert.deepEqual(codexGlobalInstructions(env), ['AGENTS.md']);
});

test('concurrent turns and probes, and a restart, share one Codex home and its refreshes; no copy is made', async (t) => {
  const { root, env } = fixture(t);
  useEnv(t, env);
  const codex = fakeCodex(root);
  codex.signIn(env.CODEX_HOME);
  const provider = new CodexCliProvider(codex.bin);
  const work = [
    ...Array.from({ length: 6 }, () => provider.runTurn(turn(root))),
    ...Array.from({ length: 3 }, () => (provider.recheck(), provider.info())),
  ];
  const results = await Promise.all(work);
  for (const r of results.slice(0, 6)) assert.match((r as any).text, /remembers/);
  // A restarted server: a new provider on the same home.
  const restarted = new CodexCliProvider(codex.bin);
  const again = await restarted.runTurn(turn(root));
  assert.ok((await restarted.info()).loggedIn);
  await restarted.runTurn(turn(root, { sessionId: again.sessionId }));
  const calls = codex.calls();
  assert.ok(calls.filter((c) => c.what === 'exec').length >= 8);
  assert.ok(calls.some((c) => c.what === 'status'));
  assert.deepEqual([...new Set(calls.map((c) => c.home))], [env.CODEX_HOME]);
  assert.ok(calls.every((c) => !c.failed), 'every refresh used the current token');
  assert.deepEqual(authFiles(root), [join(env.CODEX_HOME, 'auth.json')]);
});

test('with a stale kept copy, Botons uses the account sign-in and leaves the copy alone (a copy fails once the other refreshes)', async (t) => {
  const { root, env, kept } = fixture(t);
  useEnv(t, env);
  const codex = fakeCodex(root);
  codex.signIn(env.CODEX_HOME);
  codex.signIn(kept); // the same tokens, as a copy has
  const before = readFileSync(join(kept, 'auth.json'), 'utf8');
  const provider = new CodexCliProvider(codex.bin);
  await provider.runTurn(turn(root));
  await provider.runTurn(turn(root));
  assert.equal(readFileSync(join(kept, 'auth.json'), 'utf8'), before);
  // What a second home with a copy runs into: its refresh token was already used.
  const stale = new CodexCliProvider(codex.bin, kept);
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = kept;
  try {
    await assert.rejects(stale.runTurn(turn(root)), /refresh token was already used/);
  } finally {
    process.env.CODEX_HOME = saved;
  }
});

test('a Boton on the kept sign-in keeps working, then moves to the account sign-in with its conversation', async (t) => {
  const { root, env, kept } = fixture(t);
  useEnv(t, env);
  delete process.env.CODEX_HOME;
  const codex = fakeCodex(root);
  codex.signIn(kept);
  const provider = new CodexCliProvider(codex.bin);
  const first = await provider.runTurn(turn(root, { prompt: 'remember the word teal' }));
  const second = await provider.runTurn(turn(root, { sessionId: first.sessionId, prompt: 'and again' }));
  assert.equal(second.text, 'remembers 2');
  assert.deepEqual([...new Set(codex.calls().map((c) => c.home))], [kept]);
  const keptAuth = readFileSync(join(kept, 'auth.json'), 'utf8');

  // The owner signs in once, for the server account.
  const login = new BrainLogin(codex.bin);
  login.start();
  await until(() => login.view().state === 'finished');
  assert.equal(codex.calls().at(-1).what, 'login');
  assert.equal(codex.calls().at(-1).home, env.CODEX_HOME);
  assert.equal(cliHome('codex').keptOnly, false);

  const third = await provider.runTurn(turn(root, { sessionId: first.sessionId, prompt: 'what was the word?' }));
  assert.equal(third.sessionId, first.sessionId);
  assert.equal(third.text, 'remembers 3', 'the resumed thread has the whole conversation');
  assert.equal(codex.calls().at(-1).home, env.CODEX_HOME);
  const copied = join(env.CODEX_HOME, 'sessions', '2026', '11', '15');
  const [name] = readdirSync(copied);
  assert.match(readFileSync(join(copied, name), 'utf8'), /remember the word teal[\s\S]*what was the word/);
  assert.equal(statSync(join(copied, name)).mode & 0o777, 0o600);
  // The kept home is left as it was, for recovery.
  const original = readFileSync(join(kept, 'sessions', '2026', '11', '15', name), 'utf8');
  assert.match(original, /remember the word teal/);
  assert.doesNotMatch(original, /what was the word/);
  assert.equal(readFileSync(join(kept, 'auth.json'), 'utf8'), keptAuth);
  assert.deepEqual(authFiles(root), [join(env.CODEX_HOME, 'auth.json'), join(kept, 'auth.json')]);
});

test("carrying a conversation never overwrites one already there or follows a link, and a thread found nowhere is lost", async (t) => {
  const { root, env, kept } = fixture(t);
  useEnv(t, env);
  const id = '019a0000-0000-7000-8000-00000000abcd';
  const day = (home: string) => join(home, 'sessions', '2026', '11', '01');
  mkdirSync(day(kept), { recursive: true });
  mkdirSync(day(env.CODEX_HOME), { recursive: true });
  writeFileSync(join(day(kept), `rollout-x-${id}.jsonl`), 'kept\n');
  writeFileSync(join(day(env.CODEX_HOME), `rollout-x-${id}.jsonl`), 'account\n');
  assert.equal(carryRollout(id, env.CODEX_HOME, [kept]), 'here');
  assert.equal(readFileSync(join(day(env.CODEX_HOME), `rollout-x-${id}.jsonl`), 'utf8'), 'account\n');
  const linked = '019a0000-0000-7000-8000-00000000beef';
  writeFileSync(join(root, 'elsewhere'), 'secret');
  symlinkSync(join(root, 'elsewhere'), join(day(kept), `rollout-x-${linked}.jsonl`));
  assert.equal(carryRollout(linked, env.CODEX_HOME, [kept]), 'missing');
  assert.equal(existsSync(join(day(env.CODEX_HOME), `rollout-x-${linked}.jsonl`)), false);

  const codex = fakeCodex(root);
  codex.signIn(env.CODEX_HOME);
  const err = await new CodexCliProvider(codex.bin).runTurn(turn(root, { sessionId: '019a0000-0000-7000-8000-00000000dead' })).then(() => null, (e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.sessionLost, true, 'the engine starts a new session for a thread found nowhere');
});


test('explicit Codex home wins without a file login, and account logout never revives a kept login', (t) => {
  const { env, kept } = fixture(t);
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, 'auth.json'), '{}');
  assert.equal(cliHome('codex', env).selected, env.CODEX_HOME);
  const { CODEX_HOME: accountHome, ...defaultEnv } = env;
  assert.equal(cliHome('codex', defaultEnv).selected, kept);
  mkdirSync(accountHome, { recursive: true });
  writeFileSync(join(accountHome, 'auth.json'), '{}');
  prepareCliHomes(defaultEnv);
  rmSync(join(accountHome, 'auth.json'));
  assert.equal(cliHome('codex', defaultEnv).selected, accountHome);
  prepareCliHomes(defaultEnv);
  assert.equal(cliHome('codex', defaultEnv).selected, accountHome);
  assert.equal(readFileSync(join(kept, 'auth.json'), 'utf8'), '{}');
});
