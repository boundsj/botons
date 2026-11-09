import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedHostNames, applyTailnet, ConfigError, loadConfig, parseDuration } from '../src/config.ts';
import { parseTailscaleStatus } from '../src/tailnet.ts';
import { noRealClis, tempDir } from './helpers.ts';

const home = () => tempDir('botons-config-test-');
const noTailscale = () => {
  throw new Error('tailscale must not be asked');
};

/** loadConfig on a temp home, loopback only, plus `env`. */
function load(env: Record<string, string>) {
  return loadConfig({ BOTONS_HOME: home(), BOTONS_HOST: '127.0.0.1', ...env }, noTailscale);
}

function errorsFor(env: Record<string, string>): string[] {
  try {
    load(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.errors;
    throw err;
  }
  assert.fail(`expected a ConfigError for ${JSON.stringify(env)}`);
}

test('durations are read as 20m, 90s, 1.5h, 250ms or bare milliseconds', () => {
  const durations: [string, number][] = [['20m', 20 * 60_000], ['90s', 90_000], ['1.5h', 5_400_000], ['250ms', 250], ['1200000', 1_200_000], [' 2 M ', 120_000]];
  for (const [text, ms] of durations) assert.equal(parseDuration(text), ms, text);
  for (const bad of ['twenty minutes', '-5m']) assert.ok(Number.isNaN(parseDuration(bad)), bad);
  assert.equal(load({ BOTONS_TURN_TIMEOUT_MS: '90s' }).turnTimeoutMs, 90_000);
  assert.equal(load({ BOTONS_SCHEDULER_MS: '200' }).schedulerIntervalMs, 200);
  assert.equal(load({ BOTONS_SSE_PING_MS: '1000' }).ssePingMs, 1000);
});

test('empty values count as unset and get the defaults; BOTONS_PORT wins over PORT; the CLI paths are settable', () => {
  const empty = ['BOTONS_PORT', 'BOTONS_MAX_CONCURRENT', 'BOTONS_TURN_TIMEOUT_MS', 'BOTONS_SCHEDULER_MS', 'BOTONS_SSE_PING_MS', 'BOTONS_TZ', 'BOTONS_PUBLIC_URL', 'BOTONS_CLAUDE_BIN', 'BOTONS_CODEX_BIN'];
  const cfg = load({ ...Object.fromEntries(empty.map((k) => [k, ''])), PORT: ' ' });
  assert.deepEqual(
    [cfg.port, cfg.maxConcurrentTurns, cfg.turnTimeoutMs, cfg.schedulerIntervalMs, cfg.ssePingMs, cfg.defaultTimezone, cfg.publicUrl, cfg.claudeBin, cfg.codexBin],
    [7777, 3, 20 * 60_000, 10_000, 25_000, Intl.DateTimeFormat().resolvedOptions().timeZone, 'http://127.0.0.1:7777', 'claude', 'codex'],
  );

  assert.equal(load({ PORT: '3000', BOTONS_PORT: '18111' }).port, 18111);
  assert.equal(load({ PORT: '3000' }).port, 3000);
  assert.equal(load({ BOTONS_TZ: 'America/Los_Angeles' }).defaultTimezone, 'America/Los_Angeles');
  const clis = load({ BOTONS_CLAUDE_BIN: '/opt/claude/bin/claude', BOTONS_CODEX_BIN: '/opt/codex' });
  assert.deepEqual([clis.claudeBin, clis.codexBin], ['/opt/claude/bin/claude', '/opt/codex']);
});

test('bad settings are rejected with the variable named, all at once, before anything is created', () => {
  assert.deepEqual(errorsFor({ BOTONS_MAX_CONCURRENT: '0' }), ['BOTONS_MAX_CONCURRENT must be between 1 and 64; got 0']);
  assert.match(errorsFor({ BOTONS_MAX_CONCURRENT: 'three' })[0], /^BOTONS_MAX_CONCURRENT must be a whole number; got "three"$/);
  assert.match(errorsFor({ BOTONS_TURN_TIMEOUT_MS: 'twenty minutes' })[0], /^BOTONS_TURN_TIMEOUT_MS must be a duration such as 20m/);
  assert.match(errorsFor({ BOTONS_TURN_TIMEOUT_MS: '0' })[0], /^BOTONS_TURN_TIMEOUT_MS must be between 1s and 1d; got "0"$/);
  assert.match(errorsFor({ BOTONS_SCHEDULER_MS: '1ms' })[0], /^BOTONS_SCHEDULER_MS must be between/);
  assert.match(errorsFor({ BOTONS_TZ: 'Mars/Olympus_Mons' })[0], /^BOTONS_TZ is not a timezone .*got "Mars\/Olympus_Mons"$/);
  assert.match(errorsFor({ BOTONS_PORT: '70000' })[0], /^BOTONS_PORT must be between 1 and 65535; got 70000$/);
  // 0 (any free port) would leave Botons calling http://127.0.0.1:0.
  assert.deepEqual(errorsFor({ BOTONS_PORT: '0' }), ['BOTONS_PORT must be between 1 and 65535; got 0']);
  assert.deepEqual(errorsFor({ PORT: '0' }), ['PORT must be between 1 and 65535; got 0']);
  assert.match(errorsFor({ PORT: 'http' })[0], /^PORT must be a whole number/);
  assert.match(errorsFor({ BOTONS_PUBLIC_URL: 'myhost:7777' })[0], /^BOTONS_PUBLIC_URL must be an http:\/\/ or https:\/\/ URL/);
  // A ping every millisecond on every open event stream.
  for (const value of ['0', '-5', '999', 'abc', 'Infinity']) assert.match(errorsFor({ BOTONS_SSE_PING_MS: value }).join('\n'), /^BOTONS_SSE_PING_MS [^\n]*$/, value);

  const h = join(home(), 'not-yet');
  assert.throws(
    () => loadConfig({ BOTONS_HOME: h, BOTONS_HOST: '127.0.0.1', BOTONS_MAX_CONCURRENT: '0', BOTONS_TZ: 'Nowhere', BOTONS_TURN_TIMEOUT_MS: 'soon' }, noTailscale),
    (err: ConfigError) => err.errors.map((e) => e.split(' ')[0]).join() === 'BOTONS_TZ,BOTONS_MAX_CONCURRENT,BOTONS_TURN_TIMEOUT_MS',
  );
  assert.equal(existsSync(h), false);
});

test('BOTONS_AUTH is on unless set to off (or false, 0, no); anything else is an error, never a silent guess', () => {
  assert.equal(load({}).authEnabled, true);
  for (const on of ['on', 'ON', 'true', '1', 'yes']) assert.equal(load({ BOTONS_AUTH: on }).authEnabled, true, on);
  for (const off of ['off', 'Off', 'false', '0', 'no']) assert.equal(load({ BOTONS_AUTH: off }).authEnabled, false, off);
  for (const typo of ['of', 'disabled', 'offf', 'none']) {
    assert.ok(errorsFor({ BOTONS_AUTH: typo }).some((e) => e.startsWith('BOTONS_AUTH must be one of on, off')), typo);
  }
});

test('BOTONS_HOST must include loopback, because Botons call the server on 127.0.0.1', () => {
  assert.match(errorsFor({ BOTONS_HOST: '100.64.1.2' })[0], /^BOTONS_HOST must include 127\.0\.0\.1 \(or 0\.0\.0\.0 or ::\).*got "100\.64\.1\.2"$/);
  assert.deepEqual(load({ BOTONS_HOST: '127.0.0.1, 100.64.1.2', BOTONS_NO_TAILSCALE: '1' }).hosts, ['127.0.0.1', '100.64.1.2']);
  assert.deepEqual(load({ BOTONS_HOST: '0.0.0.0', BOTONS_NO_TAILSCALE: '1' }).hosts, ['0.0.0.0']);
});

test('Tailscale: bound when BOTONS_HOST is unset, names only when the tailnet can already reach a host, else off', () => {
  const ts = () => ({ ip: '100.64.1.2', dnsName: 'myhost.example-tailnet.ts.net' });
  const bind = loadConfig({ BOTONS_HOME: home(), BOTONS_PORT: '7777' }, ts);
  assert.equal(bind.tailscale.mode, 'bind');
  assert.deepEqual(bind.hosts, ['127.0.0.1']); // the app binds the Tailscale address itself
  assert.deepEqual(bind.urls, ['http://myhost.example-tailnet.ts.net:7777', 'http://100.64.1.2:7777', 'http://127.0.0.1:7777']);
  assert.equal(bind.publicUrl, 'http://myhost.example-tailnet.ts.net:7777');

  const names = loadConfig({ BOTONS_HOME: home(), BOTONS_HOST: '0.0.0.0', BOTONS_PORT: '7777' }, ts);
  assert.equal(names.tailscale.mode, 'names');
  assert.equal(names.publicUrl, 'http://myhost.example-tailnet.ts.net:7777');
  assert.ok(allowedHostNames(names).has('myhost.example-tailnet.ts.net'));

  assert.equal(load({}).tailscale.mode, 'off');
  const off = loadConfig({ BOTONS_HOME: home(), BOTONS_NO_TAILSCALE: '1' }, noTailscale);
  assert.equal(off.tailscale.mode, 'off');
  assert.equal(off.publicUrl, 'http://127.0.0.1:7777');

  // `tailscale status --json`: an IPv4 address and the MagicDNS name, only while the backend runs.
  const status = (state: string, ips: string[]) => JSON.stringify({ BackendState: state, Self: { TailscaleIPs: ips, DNSName: 'MyHost.example-tailnet.ts.net.' } });
  assert.deepEqual(parseTailscaleStatus(status('Running', ['fd7a:115c:a1e0::1', '100.64.0.13'])), { ip: '100.64.0.13', dnsName: 'myhost.example-tailnet.ts.net' });
  for (const down of [status('Stopped', ['100.64.0.13']), status('Running', []), 'not json']) assert.deepEqual(parseTailscaleStatus(down), { ip: null, dnsName: null });
});

test('allowed Host names: localhost, this host, the URLs, BOTONS_PUBLIC_URL and BOTONS_ALLOWED_HOSTS', () => {
  const cfg = load({ BOTONS_PORT: '7777', BOTONS_PUBLIC_URL: 'https://botons.example.com/', BOTONS_ALLOWED_HOSTS: 'Extra.Example, other' });
  assert.equal(cfg.publicUrl, 'https://botons.example.com');
  let names = allowedHostNames(cfg);
  for (const n of ['localhost', cfg.hostname.toLowerCase(), 'botons.example.com', 'extra.example', 'other']) assert.ok(names.has(n), n);
  assert.ok(!names.has('myhost.example-tailnet.ts.net'));

  // The tailnet appears later: its names join, and BOTONS_PUBLIC_URL still wins for links.
  applyTailnet(cfg, { ip: '100.64.1.2', dnsName: 'myhost.example-tailnet.ts.net' });
  names = allowedHostNames(cfg);
  assert.ok(names.has('myhost.example-tailnet.ts.net') && names.has('myhost'));
  assert.equal(cfg.publicUrl, 'https://botons.example.com');
  assert.equal(cfg.urls[0], 'http://myhost.example-tailnet.ts.net:7777');
});

test('the server exits 78 and names the variable when a setting is bad', async () => {
  for (const [name, value] of [['BOTONS_TZ', 'Not/AZone'], ['BOTONS_MAX_CONCURRENT', '0'], ['BOTONS_AUTH', 'of']]) {
    const h = home();
    const child = spawn(process.execPath, [join(import.meta.dirname, '../src/index.ts')], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT' && !k.startsWith('BOTONS_'))),
        BOTONS_HOME: h, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(17000 + Math.floor(Math.random() * 3000)), BOTONS_NO_TAILSCALE: '1', ...noRealClis(h),
        [name]: value,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 78, stdout);
    const line = JSON.parse(stdout.trim());
    assert.equal(line.level, 'error');
    assert.match(line.msg, /^Botons cannot start: fix these settings/);
    assert.ok(line.errors.some((e: string) => e.startsWith(`${name} `)), stdout);
    assert.equal(existsSync(join(h, 'botons.db')), false);
  }
});


test('an existing home with its folders but no write access exits 78 with guidance', { skip: process.getuid?.() === 0 }, () => {
  const h = home();
  mkdirSync(join(h, 'workspaces'));
  mkdirSync(join(h, 'shared'));
  chmodSync(h, 0o500);
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '../src/index.ts')], {
      env: { PATH: process.env.PATH, HOME: h, BOTONS_HOME: h, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: '18111', BOTONS_NO_TAILSCALE: '1', ...noRealClis(h) },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 78, result.stdout + result.stderr);
    assert.match(result.stdout, /not writable by this user/);
    assert.doesNotMatch(result.stderr, /at .*file:/);
    assert.equal(existsSync(join(h, 'server.lock')), false);
  } finally {
    chmodSync(h, 0o700);
  }
});
