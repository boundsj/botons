// The deprecated names (shared/legacy-names.mjs) keep working for one release, and say so only as deprecated.
// A migration fixture: it names them on purpose (see the old-names guard).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { applyLegacyEnv, currentEnvName, currentName, currentPortable, earlierEnvNames, earlierName, legacyEnvNoticeText, rewriteEnvText, storedValue, withLegacyTurnNames } from '../../shared/legacy-names.mjs';
import { devEnv } from '../../scripts/dev-env.ts';
import { privatePaths } from '../src/isolation.ts';
import { chooseHome, ConfigError, HomeConflictError, isBotonsSetting, loadConfig } from '../src/config.ts';
import { tempDir } from './helpers.ts';

const NO_TS = () => ({ ip: null, dnsName: null });

test('each deprecated setting name is read as its BOTONS_* or BOTON_* name; the current name wins, then the newest earlier one; notices name variables, never values', () => {
  assert.equal(currentEnvName('MINIONS_PORT'), 'BOTONS_PORT');
  assert.equal(currentEnvName('TOTS_PORT'), 'BOTONS_PORT');
  assert.equal(currentEnvName('MINION_TOKEN'), 'BOTON_TOKEN');
  assert.equal(currentEnvName('TOT_TOKEN'), 'BOTON_TOKEN');
  assert.equal(currentEnvName('BOTONS_PORT'), null);
  assert.equal(currentEnvName('TOTS'), null);
  assert.equal(currentEnvName('TOTAL_X'), null);
  assert.deepEqual(earlierEnvNames('BOTONS_HOME'), ['TOTS_HOME', 'MINIONS_HOME']);
  assert.ok(isBotonsSetting('BOTONS_PORT') && isBotonsSetting('BOTON_TOKEN') && isBotonsSetting('TOTS_PORT') && isBotonsSetting('MINION_TOKEN'));
  assert.ok(!isBotonsSetting('PATH') && !isBotonsSetting('TOTAL'));

  const env: NodeJS.ProcessEnv = {
    MINIONS_PORT: '8001',
    TOTS_LOG_LEVEL: 'warn',
    MINIONS_LOG_LEVEL: 'debug',
    TOTS_PUBLIC_URL: 'http://old.example.com:7777',
    BOTONS_PUBLIC_URL: 'http://new.example.com:7777',
    MINIONS_OWNER_LOGIN: 'sam-secret-value',
    TOTS_EMPTY: ' ',
  };
  const notices = applyLegacyEnv(env);
  assert.equal(env.BOTONS_PORT, '8001');
  assert.equal(env.BOTONS_LOG_LEVEL, 'warn', 'the newer earlier name wins over the older one');
  assert.equal(env.BOTONS_PUBLIC_URL, 'http://new.example.com:7777', 'the current name wins');
  assert.equal(env.MINIONS_PORT, '8001', 'earlier names stay as they are');
  assert.equal(env.BOTONS_EMPTY, undefined, 'empty counts as unset');
  assert.deepEqual(
    notices.map((n) => [n.old, n.conflict]),
    [['TOTS_LOG_LEVEL', false], ['TOTS_PUBLIC_URL', true], ['MINIONS_LOG_LEVEL', true], ['MINIONS_OWNER_LOGIN', false], ['MINIONS_PORT', false]],
  );
  for (const n of notices) {
    const text = legacyEnvNoticeText(n);
    assert.ok(text.includes(n.old) && text.includes(n.name) && /deprecated/.test(text));
    assert.equal(text.split('\n').length, 1, 'one line');
    for (const v of ['8001', 'old.example.com', 'new.example.com', 'sam-secret-value', 'debug']) assert.ok(!text.includes(v), `${text} shows a value`);
  }
  assert.equal(applyLegacyEnv(env).length, notices.length, 'idempotent');

  const home = tempDir();
  const cfg = loadConfig({ TOTS_HOME: home, MINIONS_PORT: '8002', TOTS_NO_TAILSCALE: '1', BOTONS_HOST: '127.0.0.1' }, NO_TS, { create: false });
  assert.equal(cfg.home, home);
  assert.equal(cfg.port, 8002);
  assert.equal(cfg.tailscale.enabled, false);
  assert.equal(cfg.homeSource, 'BOTONS_HOME');
  assert.deepEqual(cfg.envNotices.map((n) => n.old), ['TOTS_HOME', 'TOTS_NO_TAILSCALE', 'MINIONS_PORT']);
  assert.equal(loadConfig({ BOTONS_HOME: home, TOTS_PORT: '8003', BOTONS_PORT: '8004' }, NO_TS, { create: false }).port, 8004);
  // A deprecated name's bad value is reported under the name the server reads it as.
  assert.throws(() => loadConfig({ BOTONS_HOME: home, MINIONS_PORT: 'x' }, NO_TS, { create: false }), (e: ConfigError) => e.errors.some((x) => /BOTONS_PORT/.test(x)));
});

test("a turn's variables are there under their deprecated names too, with the same values", () => {
  assert.deepEqual(withLegacyTurnNames({ BOTONS_API: 'http://127.0.0.1:1', BOTON_TOKEN: 't', PATH: '/bin' }), {
    BOTONS_API: 'http://127.0.0.1:1',
    BOTON_TOKEN: 't',
    PATH: '/bin',
    TOTS_API: 'http://127.0.0.1:1',
    MINIONS_API: 'http://127.0.0.1:1',
    TOT_TOKEN: 't',
    MINION_TOKEN: 't',
  });
});

test('an env file is rewritten with current names and moved paths, keeping the value the server would have used, comments and order', () => {
  const text = [
    '# Botons settings',
    'PATH="/home/you/.local/share/tots/node/bin:/usr/bin"',
    'MINIONS_PORT=7001',
    'TOTS_PORT=7002',
    'export TOTS_HOME="/home/you/.tots"',
    'MINIONS_HOOKS_PORT=7780',
    'BOTONS_LOG_LEVEL=warn',
    'TOTS_LOG_LEVEL=debug',
    'TOTS_HOMEWORK=/home/you/.totsy',
    '',
  ].join('\n');
  const out = rewriteEnvText(text, [['/home/you/.tots', '/home/you/.botons'], ['/home/you/.local/share/tots', '/home/you/.local/share/botons']]);
  assert.equal(
    out,
    [
      '# Botons settings',
      'PATH="/home/you/.local/share/botons/node/bin:/usr/bin"',
      'BOTONS_PORT=7002',
      'export BOTONS_HOME="/home/you/.botons"',
      'BOTONS_HOOKS_PORT=7780',
      'BOTONS_LOG_LEVEL=warn',
      'BOTONS_HOMEWORK=/home/you/.totsy',
      '',
    ].join('\n'),
  );
  assert.equal(rewriteEnvText(out, []), out, 'idempotent');
  // An empty value counts as unset, as at run time: the earlier name's value is the one used, and the one kept.
  assert.equal(rewriteEnvText('BOTONS_PORT=\nMINIONS_PORT=17123\nTOTS_HOME=""\nMINIONS_HOME=/srv/data\nOTHER=1\nOTHER=2\n'), 'BOTONS_PORT=17123\nBOTONS_HOME=/srv/data\nOTHER=1\nOTHER=2\n');
  // A name assigned again means its last value, an empty one too (cleared), as reading the file does.
  assert.equal(rewriteEnvText('MINIONS_PORT=17123\nMINIONS_PORT=""\nBOTONS_X=1\nBOTONS_X=\nTOTS_X=5\n'), 'BOTONS_PORT=""\nBOTONS_X=5\n');
});

/** A user's home folder of its own, with the folders named. */
function userHome(...make: string[]): string {
  const h = tempDir('botons-legacy-home-');
  for (const d of make) mkdirSync(join(h, d), { recursive: true });
  return h;
}

test('the data folder: ~/.botons, else one under a deprecated name until it moves; links count; two folders or two settings that disagree are refused', () => {
  let h = userHome();
  assert.deepEqual(chooseHome({}, h), { home: join(h, '.botons'), source: 'default' });
  h = userHome('.botons');
  assert.deepEqual(chooseHome({}, h), { home: join(h, '.botons'), source: 'default' });
  for (const d of ['.minions', '.tots']) {
    h = userHome(d);
    assert.deepEqual(chooseHome({}, h), { home: join(h, d), source: 'legacy' });
  }
  h = userHome('.minions');
  symlinkSync('.minions', join(h, '.tots'));
  assert.deepEqual(chooseHome({}, h), { home: join(h, '.minions'), source: 'legacy' }, 'the real folder');
  // After the upgrade: the folder is ~/.botons, the earlier names link to it.
  h = userHome('.botons');
  symlinkSync('.botons', join(h, '.minions'));
  symlinkSync('.botons', join(h, '.tots'));
  assert.deepEqual(chooseHome({}, h), { home: join(h, '.botons'), source: 'default' });
  assert.deepEqual(chooseHome({ BOTONS_HOME: join(h, '.tots') }, h), { home: join(h, '.botons'), source: 'BOTONS_HOME' }, 'a moved folder named by its earlier name');
  assert.deepEqual(chooseHome({ TOTS_HOME: join(h, '.tots'), MINIONS_HOME: join(h, '.minions') }, h).home, join(h, '.botons'));
  // A moved folder whose earlier name has no link yet (a stopped upgrade) is still ~/.botons, never a new folder.
  h = userHome('.botons');
  assert.deepEqual(chooseHome({ MINIONS_HOME: join(h, '.minions') }, h), { home: join(h, '.botons'), source: 'BOTONS_HOME' });
  for (const two of [['.botons', '.tots'], ['.tots', '.minions']]) {
    h = userHome(...two);
    assert.throws(() => chooseHome({}, h), HomeConflictError);
    assert.throws(() => loadConfig({ HOME: h }, NO_TS, { create: false }), (e: ConfigError) => e instanceof HomeConflictError && /Set BOTONS_HOME/.test(e.errors[0]));
  }
  // Named: any of its names, the same folder by all of them, never two folders.
  assert.deepEqual(chooseHome({ BOTONS_HOME: '/srv/a' }, h), { home: '/srv/a', source: 'BOTONS_HOME' });
  assert.deepEqual(chooseHome({ MINIONS_HOME: '/srv/a' }, h), { home: '/srv/a', source: 'BOTONS_HOME' });
  assert.equal(chooseHome({ BOTONS_HOME: '/srv/a/', TOTS_HOME: '/srv/a' }, h).home, '/srv/a');
  assert.throws(() => chooseHome({ BOTONS_HOME: '/srv/a', MINIONS_HOME: '/srv/b' }, h), (e: ConfigError) => /\/srv\/a.*\/srv\/b/.test(e.errors[0]));
});

test("a Compose install under its earlier project moves to the botons project: stopped, its volumes copied (never changed), its settings renamed, its Tailscale name kept; rollback starts it again", () => {
  const dir = tempDir('botons-compose-');
  mkdirSync(join(dir, 'docker'));
  copyFileSync(resolve(import.meta.dirname, '../../docker/legacy-names.sh'), join(dir, 'docker', 'legacy-names.sh'));
  writeFileSync(join(dir, 'minions.env'), 'MINIONS_TZ=UTC\nMINIONS_LOG_LEVEL=debug\n');
  writeFileSync(join(dir, 'tots.env'), 'TOTS_LOG_LEVEL=warn\n');
  writeFileSync(join(dir, '.env'), 'TOTS_BIND=127.0.0.1\nMINIONS_PUBLIC_URL=https://minions.example-tailnet.ts.net\nTS_AUTHKEY=tskey-fake\n');
  // A docker that knows the earlier project's volumes and one container, and logs what it is asked.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
echo "$*" >> "${join(dir, 'calls')}"
case "$1 $2" in
  "volume inspect") case " minions_data minions_home minions_tailscale " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac ;;
  "ps -q"|"ps -aq") echo c1 ;;
  "ps -a") echo app:local ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const run = (...args: string[]) => execFileSync('sh', [join(dir, 'docker', 'legacy-names.sh'), ...args], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  const out = run();
  assert.match(out, /Copied minions_data to botons_data\.\nCopied minions_home to botons_home\.\nCopied minions_tailscale to botons_tailscale\./);
  const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n');
  const stop = calls.findIndex((c) => c.startsWith('stop'));
  const copy = calls.findIndex((c) => c.startsWith('run'));
  assert.ok(stop > 0 && stop < copy, 'stopped before anything is copied');
  assert.ok(calls.includes('run --rm --user 0 --entrypoint sh -v minions_data:/from:ro -v botons_data:/to app:local -c cp -a /from/. /to/'), 'the earlier volume only read');
  assert.ok(!calls.some((c) => /volume rm|rm -v|down/.test(c)), 'nothing of the earlier project removed');
  assert.equal(readFileSync(join(dir, 'botons.env'), 'utf8'), 'BOTONS_TZ=UTC\nBOTONS_LOG_LEVEL=debug\nBOTONS_LOG_LEVEL=warn\n', 'the later file last, so its value wins');
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'BOTONS_BIND=127.0.0.1\nBOTONS_PUBLIC_URL=https://minions.example-tailnet.ts.net\nTS_AUTHKEY=tskey-fake\nTS_HOSTNAME=minions\n');
  assert.ok(existsSync(join(dir, '.env.before-botons')));

  const back = run('--rollback');
  assert.match(back, /started minions again/);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TOTS_BIND=/, 'the earlier .env is back');
  assert.ok(readFileSync(join(dir, 'calls'), 'utf8').split('\n').includes('start c1'));
});

test("a service env file's deprecated name beats the shell's, as its current name would", () => {
  const dir = tempDir();
  const file = join(dir, 'env');
  writeFileSync(file, 'MINIONS_PORT=17002\n');
  const program = `import './server/src/env-init.ts'; const {serverEnv}=await import('./scripts/install-service.ts'); console.log(serverEnv(${JSON.stringify(file)}).env.BOTONS_PORT);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: resolve(import.meta.dirname, '../..'), env: { HOME: dir, PATH: process.env.PATH, TOTS_PORT: '17001' }, encoding: 'utf8' });
  assert.equal(out.trim(), '17002');
});

test("npm run dev drops the live server's hooks and data folder under their deprecated names too, and refuses two of them that disagree", () => {
  const repo = tempDir('botons-dev-test-');
  const live = { TOTS_HOOKS_PORT: '7780', MINIONS_HOOKS_PUBLIC_URL: 'https://myhost.example-tailnet.ts.net', TOTS_HOME: '/home/you/.tots', MINIONS_PORT: '7777' };
  const dev = devEnv({ PATH: '/usr/bin', ...live }, repo);
  assert.deepEqual([dev.BOTONS_HOOKS_PORT, dev.BOTONS_HOOKS_HOST, dev.BOTONS_HOOKS_PUBLIC_URL], [undefined, undefined, undefined]);
  assert.equal(dev.BOTONS_HOME, resolve('/home/you/.tots'), 'an explicit data folder is still the shell’s to choose');
  assert.ok(Object.keys(dev).every((k) => !/^(TOTS|MINIONS)_/.test(k)), 'folded into the BOTONS_* names, so they cannot conflict');
  assert.throws(() => devEnv({ BOTONS_HOME: '/srv/a', MINIONS_HOME: '/srv/b' }, '/repo'), /different data folders/);
  assert.throws(() => devEnv({ TOTS_HOME: '/srv/a', MINIONS_HOME: '/srv/b' }, '/repo'), /different data folders/);
});

test('after the upgrade, each private path in the data folder is named through the deprecated names that link to it, and the deprecated settings folders stay private; the own workspace stays open by any name', () => {
  const userHome = tempDir('botons-iso-home-');
  const data = join(userHome, '.botons');
  const own = join(data, 'workspaces', 'kevin-1');
  for (const f of ['botons.db', 'workspaces/kevin-1/notes.md', 'workspaces/stuart-2/notes.md']) {
    mkdirSync(dirname(join(data, f)), { recursive: true });
    writeFileSync(join(data, f), '');
  }
  symlinkSync('.botons', join(userHome, '.minions'));
  symlinkSync('.botons', join(userHome, '.tots'));
  for (const d of ['tots', 'minions']) mkdirSync(join(userHome, '.config', d), { recursive: true });
  const paths = privatePaths({ workspace: own, cli: 'claude', botonsHome: data, workspacesDir: join(data, 'workspaces'), userHome, env: {} });
  for (const via of ['.minions', '.tots']) {
    for (const p of [join(userHome, via, 'botons.db'), join(userHome, via, 'workspaces', 'stuart-2')]) assert.ok(paths.includes(p), `${p} is private`);
  }
  for (const p of [join(data, 'botons.db'), join(userHome, '.config', 'tots'), join(userHome, '.config', 'minions')]) assert.ok(paths.includes(p), `${p} is private`);
  for (const p of paths) for (const via of ['.botons', '.minions', '.tots']) assert.ok(!join(userHome, via, 'workspaces', 'kevin-1').startsWith(p), `${p} would hide the own workspace`);
});

test("the installer's PATH block under its deprecated name counts as there, and goes on uninstall", async () => {
  const { configurePath, removePathBlock } = await import('../../installer/shell-path.mjs');
  const home = tempDir('botons-path-legacy-');
  const old = '\n# >>> tots PATH >>>\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n# <<< tots PATH <<<\n';
  writeFileSync(join(home, '.bashrc'), `# mine${old}`);
  await configurePath({ home, shell: '/bin/bash', path: '/usr/bin', yes: true }, async () => assert.fail('asked to add a second block'), () => {});
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), `# mine${old}`);
  removePathBlock(home, () => {});
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# mine');
});

test('configuration exports made under the earlier names import as they are, with each name as this server reads it', async () => {
  const { readPortable } = await import('../src/portable.ts');
  for (const n of [1, 2, 3]) {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', `portable-config-${n}.json`), 'utf8'));
    assert.equal(raw.format, 'minions-config');
    const { file } = readPortable(raw);
    assert.equal(file.format, 'botons-config');
    assert.equal(file.botons.length, raw.minions.length, `version ${n}`);
    assert.equal(file.settings.primaryBoton !== undefined, true);
  }
  const browsing = { format: 'minions-config', minions: [{ ref: 'kevin', connections: ['lib:minions_browser', 'lib:wiki'] }] };
  assert.deepEqual((currentPortable(browsing) as any).botons[0].connections, ['lib:botons_browser', 'lib:wiki']);
  const authored = currentPortable({ format: 'minions-config', minions: [], skills: [{ name: 'standup', author: { kind: 'minion', ref: 'kevin', name: 'Kevin' } }, { name: 'own', author: { kind: 'owner' } }] }) as any;
  assert.deepEqual(authored.skills.map((k: any) => k.author), [{ kind: 'boton', ref: 'kevin', name: 'Kevin' }, { kind: 'owner' }], "a Boton's skill keeps its author");
  // An owner's own connector named as the browser is now: a free name, its grants with it, the browser's id mapped after.
  const clash = currentPortable({
    format: 'minions-config',
    minions: [{ ref: 'kevin', connections: ['lib:botons_browser', 'lib:minions_browser'] }],
    templates: [{ name: 'T', bot: { connections: ['lib:botons_browser'] } }],
    connectors: [{ id: 'lib:botons_browser', kind: 'library', name: 'botons_browser' }, { id: 'lib:botons_browser_2', kind: 'library', name: 'botons_browser_2' }],
  }) as any;
  assert.deepEqual(clash.botons[0].connections, ['lib:botons_browser_3', 'lib:botons_browser']);
  assert.deepEqual(clash.templates[0].bot.connections, ['lib:botons_browser_3']);
  assert.deepEqual(clash.connectors.map((c: any) => [c.id, c.name]), [['lib:botons_browser_3', 'botons_browser_3'], ['lib:botons_browser_2', 'botons_browser_2']]);
  const now = { format: 'botons-config', botons: [] };
  assert.equal(currentPortable(now), now, 'a current file comes back as it is');
});

test("a device keeps its pairing and choices: the web app's storage under earlier keys is taken over once", () => {
  const store = new Map<string, string>([['minions.deviceToken', 'mdt_x'], ['minions.avatarMotion', 'off'], ['tots.webAccessSuggestion.bot_kevin', 'done']]);
  const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  assert.equal(storedValue(s, 'botons.deviceToken'), 'mdt_x');
  assert.equal(storedValue(s, 'botons.avatarMotion'), 'off');
  assert.equal(storedValue(s, 'botons.webAccessSuggestion.bot_kevin'), 'done');
  assert.deepEqual([...store.keys()].sort(), ['botons.avatarMotion', 'botons.deviceToken', 'botons.webAccessSuggestion.bot_kevin']);
  assert.equal(storedValue(s, 'botons.unknown'), null);
});

test('webhook senders and callback receivers set up under the earlier header names keep working', () => {
  assert.equal(earlierName('x-boton-key'), 'x-minion-key');
  assert.equal(earlierName('x-boton-run'), 'x-minion-run');
  assert.equal(earlierName('x-boton-signature'), 'x-minion-signature');
  assert.equal(currentName('minions-sidebar'), 'botons-sidebar');
  assert.equal(currentName('minion'), 'boton');
  assert.equal(currentName('owner'), 'owner');
});

test("the first paint keeps a theme chosen under the earlier key, and takes it over", async () => {
  const { runInNewContext } = await import('node:vm');
  const { earlierStorageKey } = await import('../../shared/legacy-names.mjs');
  const html = readFileSync(resolve(import.meta.dirname, '../../web/index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
  const source = html.replace('__EARLIER_THEME_KEY__', earlierStorageKey('botons.theme')!);
  const storage = new Map([['tots.theme', 'dark']]);
  const root = { dataset: {} as Record<string, string>, style: {} };
  const meta = { content: '' };
  const env: any = { document: { documentElement: root, querySelector: () => meta }, matchMedia: () => ({ matches: false, addEventListener: () => {} }), localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) }, addEventListener: () => {}, dispatchEvent: () => {}, Event: class {} };
  env.window = env;
  runInNewContext(source, env);
  assert.equal(root.dataset.theme, 'dark', 'the dark choice holds on a light system');
  assert.deepEqual([...storage], [['botons.theme', 'dark']]);
});

test('check:public refuses an earlier name anywhere but the files and the one changelog line allowed it, as a word or a part of one', async () => {
  const { oldNames } = await import('../../scripts/check-public.ts');
  const words = (text: string, file = 'web/src/x.ts') => oldNames(text, file).map((p) => p.match);
  assert.deepEqual(words('<TotBuilder /> uses MINIONS_HOME, a tot, ~/.tots and install-minion'), ['TotBuilder', 'MINIONS', 'tot', 'tots', 'minion']);
  assert.deepEqual(words('total, totals, prototype, totp, speechToText, botons, Boton'), []);
  assert.deepEqual(words('Botons is the name', 'server/bin/legacy/tots'), []);
  assert.deepEqual(words('MINIONS_HOME', 'shared/legacy-names.mjs'), []);
  assert.deepEqual(words('- **Names** (formerly Minions, and then Tots): botons\n- the tots command', 'CHANGELOG.md'), ['tots']);
  assert.deepEqual(words('(formerly Minions, and then Tots), a minion\n(formerly Minions, and then Tots)', 'CHANGELOG.md'), ['minion', 'Minions', 'Tots'], 'once only, and the rest of its line is checked');
  assert.deepEqual(words('mInIoNs ToTs tOt'), ['mInIoNs', 'ToTs', 'tOt'], 'in any case');
  assert.deepEqual(oldNames('docs/minion-notes.md', 'docs/minion-notes.md (name)', 'docs/minion-notes.md').map((p) => p.match), ['minion'], 'a file name too');
  assert.deepEqual(words('Copyright (c) 2026 The Minions authors', 'LICENSE'), ['Minions'], 'the license has no broad exception');
});
