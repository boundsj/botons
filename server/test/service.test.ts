import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ServerInfo } from '../../shared/types.ts';
import { CLI_NAMES } from '../../shared/legacy-names.mjs';
import { readEnvFile } from '../../scripts/install-service.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { captureLogs } from '../src/log.ts';
import { agentEnv } from '../src/providers/process.ts';
import type { TailscaleSelf } from '../src/tailnet.ts';
import { freePort, noRealClis, pairDevice, sleep, startServer, tempDir, until } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');

function getWithHost(port: number, host: string, path = '/api/health', address = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, path, headers: { host: `${host}:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** An app (not yet listening) on loopback whose Tailscale address is `self()`, with the log messages since. */
async function tailscaleApp(t: TestContext, env: Record<string, string>, self: () => TailscaleSelf, opts: { hosts?: string[]; retryMs?: number } = {}) {
  const home = tempDir('botons-service-');
  const port = await freePort(opts.hosts);
  const cfg = loadConfig({ BOTONS_HOME: home, BOTONS_PORT: String(port), BOTONS_ENABLE_MOCK: '1', ...noRealClis(home), ...env }, self);
  const captured = captureLogs();
  t.after(captured.restore);
  let probes = 0;
  // tailnet: null keeps auth from asking the real `tailscale whois`.
  const tailscale = async () => {
    probes++;
    return self();
  };
  const app = createApp(cfg, undefined, { tailscale, tailscaleRetryMs: opts.retryMs, tailnet: null });
  return { app, cfg, port, logs: () => captured.lines.map((l) => l.msg), probes: () => probes };
}

function canBind(host: string, port = 0): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

function executable(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\necho 1.0.0\n');
  chmodSync(file, 0o755);
}

function install(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [join(repo, 'scripts/install-service.ts'), ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `systemd-analyze --user verify` needs systemd, and on some hosts a user manager, which CI may lack. */
function canVerifyUnits(): boolean {
  const d = tempDir('botons-verify-');
  writeFileSync(join(d, 'probe.service'), '[Service]\nType=oneshot\nExecStart=/bin/true\n');
  return spawnSync('systemd-analyze', ['--user', 'verify', join(d, 'probe.service')]).status === 0;
}

test('service:install writes a unit that runs node directly, restarts on failure but not on exit 78, and an env file with PATH and the CLIs', { skip: process.platform !== 'linux' ? 'systemd unit installation needs Linux' : false }, () => {
  const t = tempDir('botons-service-');
  const bins = join(t, 'tools');
  executable(join(bins, 'claude'));
  executable(join(bins, 'codex'));
  const npmBin = join(repo, 'node_modules', '.bin');
  const env = { HOME: t, PATH: [npmBin, bins, '/usr/bin', 'relative/dir'].join(delimiter) };
  install(['--dir', join(t, 'units'), '--app', repo], env);

  const unit = readFileSync(join(t, 'units', 'botons.service'), 'utf8');
  const lines = [
    `ExecStart="${process.execPath}" "${repo}/server/src/index.ts"`, `WorkingDirectory=${repo}`, 'Description=Botons server',
    'EnvironmentFile=%h/.config/botons/env', // a file the backup unit reads too
    'Restart=on-failure', 'RestartSec=5', 'RestartPreventExitStatus=78', 'KillMode=mixed',
    'TimeoutStopSec=150', // above the default 2m drain budget
    'StandardOutput=journal', 'StandardError=journal', 'SyslogIdentifier=botons', 'WantedBy=default.target',
  ];
  for (const l of lines) assert.ok(unit.split('\n').includes(l), `${l}\n---\n${unit}`);
  assert.doesNotMatch(unit, /@[A-Z_]+@/);
  assert.doesNotMatch(unit.replace(/^#.*$/gm, ''), /npm/);

  // node's folder first, then the CLIs', then the shell's PATH without npm's additions or relative folders.
  const envFile = join(t, '.config', 'botons', 'env');
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const vars = readEnvFile(readFileSync(envFile, 'utf8'));
  const path = vars.PATH.split(delimiter);
  assert.deepEqual(path.slice(0, 3), [dirname(process.execPath), bins, '/usr/bin']);
  assert.ok(!path.includes(npmBin) && !path.includes('relative/dir'), vars.PATH);
  assert.equal(vars.BOTONS_CLAUDE_BIN, join(bins, 'claude'));
  assert.equal(vars.BOTONS_CODEX_BIN, join(bins, 'codex'));

  // Installing again rewrites the unit and keeps the edited env file, whose drain budget sets the stop timeout.
  writeFileSync(envFile, 'PATH=/custom\nBOTONS_DRAIN_MS=5m\n');
  const out = install(['--dir', join(t, 'units'), '--app', repo], env);
  assert.match(out, /Kept .*env \(it does not set BOTONS_CLAUDE_BIN, BOTONS_CODEX_BIN/);
  assert.equal(readFileSync(envFile, 'utf8'), 'PATH=/custom\nBOTONS_DRAIN_MS=5m\n');
  assert.match(readFileSync(join(t, 'units', 'botons.service'), 'utf8'), /^TimeoutStopSec=330$/m);

  // Its own name and env file (not --env-file: node reads that option even after the script name).
  const otherEnv = join(t, 'env with space');
  install(['--dir', join(t, 'units'), '--name', 'botons-test-1', '--env-path', otherEnv, '--app', repo], { HOME: t, PATH: '/usr/bin' });
  const unitFile = join(t, 'units', 'botons-test-1.service');
  const named = readFileSync(unitFile, 'utf8');
  assert.match(named, /^Description=Botons server \(botons-test-1\)$/m);
  assert.ok(named.includes(`\nEnvironmentFile=${otherEnv}\n`));
  assert.match(readFileSync(otherEnv, 'utf8'), /^# BOTONS_CLAUDE_BIN=/m, 'a CLI not found is left as a comment to fill in');
  if (canVerifyUnits()) {
    const verify = spawnSync('systemd-analyze', ['--user', 'verify', unitFile], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
  }
});

test('a Boton can run `botons routine list`, and its deprecated names, with no node on PATH (as under systemd)', async () => {
  const { app, cfg, home, storeBot } = await startServer();
  // Only what bin/botons needs besides node: dirname.
  const tools = join(home, 'tools');
  mkdirSync(tools);
  symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).trim(), join(tools, 'dirname'));
  // An "agent" that runs the shell command it is given, with the environment the engine hands agents.
  let given: Record<string, string> | undefined;
  app.providers.register({
    id: 'shell',
    label: 'Shell',
    info: async () => ({ id: 'shell', label: 'Shell', kind: 'cli', available: true, reason: null, installed: true, version: null, loggedIn: null, checkedAt: null, models: [], defaultModel: '' }),
    async runTurn(req) {
      given = req.env;
      const env = agentEnv({ ...req.env, PATH: req.env.PATH.replace(process.env.PATH ?? '', tools) });
      const cmd = req.prompt.split('</boton_context>').pop()!.trim();
      // Not spawnSync: the Boton CLI calls back into this process's server.
      const child = spawn('/bin/sh', ['-c', cmd], { cwd: req.cwd, env });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      return { sessionId: null, text: `${code}\n${out}` };
    },
  });
  const bot = storeBot('Bob', 'shell');
  app.store.createRoutine(bot.id, { name: 'Morning brief', instruction: 'Brief me', schedule: 'daily at 8:00' });
  app.engine.sendMessage(bot.id, `command -v node; botons routine list; ${CLI_NAMES.map((n) => `${n} routine list`).join('; ')}`);
  const reply = await until(() => app.store.listMessages(bot.id).find((m) => m.role === 'bot'));
  assert.equal(given?.BOTONS_NODE, process.execPath);
  assert.ok(given?.PATH.startsWith(`${cfg.botonBinDir}:`));
  assert.match(reply.text, /^0\n/); // `command -v node` found nothing, yet botons ran
  assert.equal(reply.text.match(/rt_\w+ {2}Morning brief {2}\(Every day at 8:00 AM, active/g)?.length, 1 + CLI_NAMES.length, 'every name lists it');
});

test('a server started before Tailscale listens on its address once it appears, without a restart', async (t) => {
  if (!(await canBind('127.0.0.2'))) return t.skip('this host has no 127.0.0.2 to stand in for the Tailscale address');
  let tailscale: TailscaleSelf = { ip: null, dnsName: null }; // tailscaled is not up at startup
  const { app, cfg, port, logs } = await tailscaleApp(t, { BOTONS_TAILSCALE_POLL_MS: '100' }, () => tailscale, { hosts: ['127.0.0.1', '127.0.0.2'] });
  assert.equal(cfg.tailscale.mode, 'bind');
  try {
    await app.listen();
    assert.deepEqual(cfg.urls, [`http://127.0.0.1:${port}`]);
    await until(() => logs().some((l) => /Tailscale is not up: Botons is serving on 127\.0\.0\.1 only/.test(l)));
    assert.equal(await getWithHost(port, 'myhost.example-tailnet.ts.net'), 403);

    // Its address shows up but cannot be bound yet (here: one this host does not have): retried, no crash.
    tailscale = { ip: '192.0.2.10', dnsName: 'myhost.example-tailnet.ts.net' };
    await until(() => logs().some((l) => /cannot listen on 192\.0\.2\.10:\d+ yet \(EADDRNOTAVAIL\); retrying every 100ms/.test(l)));
    await sleep(300);
    assert.equal(logs().filter((l) => l.includes('cannot listen on')).length, 1, 'the same failure is logged once');
    assert.deepEqual(cfg.urls, [`http://127.0.0.1:${port}`]);
    assert.equal(await getWithHost(port, '127.0.0.1'), 200);

    // Now it binds: the server answers there, under its MagicDNS name, and webhook links use that name.
    tailscale = { ip: '127.0.0.2', dnsName: 'myhost.example-tailnet.ts.net' };
    await until(() => cfg.publicUrl === `http://myhost.example-tailnet.ts.net:${port}`);
    assert.equal(await getWithHost(port, 'myhost.example-tailnet.ts.net', '/api/health', '127.0.0.2'), 200);
    assert.equal(await getWithHost(port, 'myhost', '/api/health', '127.0.0.1'), 200);
    assert.ok(logs().some((l) => l.includes(`Tailscale is up: listening on 127.0.0.2:${port} too`)));
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${await pairDevice(app, base)}` };
    const info = (await (await fetch(`${base}/api/info`, { headers })).json()) as ServerInfo;
    assert.deepEqual(info.urls, [`http://myhost.example-tailnet.ts.net:${port}`, `http://127.0.0.2:${port}`, `http://127.0.0.1:${port}`]);
    const bot = app.store.createBot({ name: 'Hooky', provider: 'mock' }, app.providers.ids(), 'mock');
    const routine = app.store.createRoutine(bot.id, { name: 'Hook', instruction: 'x', webhook: true });
    assert.equal(routine.webhook?.url, `http://myhost.example-tailnet.ts.net:${port}/hooks/routines/${routine.id}`);

    // tailscaled restarting (no answer for a while) changes nothing.
    tailscale = { ip: null, dnsName: null };
    await sleep(250);
    assert.equal(cfg.publicUrl, `http://myhost.example-tailnet.ts.net:${port}`);
  } finally {
    await app.close();
  }
  assert.equal(await canBind('127.0.0.2', port), true, 'every listener was closed, the Tailscale one too');
});

test('a Tailscale address listed before it can be bound is tried again within seconds, not at the next poll', async (t) => {
  if (!(await canBind('127.0.0.2'))) return t.skip('this host has no 127.0.0.2 to stand in for the Tailscale address');
  // tailscaled is up and lists its address, but the kernel does not have it yet.
  let tailscale: TailscaleSelf = { ip: '192.0.2.10', dnsName: 'myhost.example-tailnet.ts.net' };
  const { app, cfg, port, logs, probes } = await tailscaleApp(t, { BOTONS_TAILSCALE_POLL_MS: '1h' }, () => tailscale, { hosts: ['127.0.0.1', '127.0.0.2'], retryMs: 50 });
  try {
    await app.listen();
    assert.ok(logs().some((l) => /cannot listen on 192\.0\.2\.10:\d+ yet \(EADDRNOTAVAIL\); retrying every 50ms, then every 1h/.test(l)));
    assert.deepEqual(cfg.urls, [`http://127.0.0.1:${port}`]);
    // The address arrives: bound by a retry, long before the hourly poll.
    tailscale = { ip: '127.0.0.2', dnsName: 'myhost.example-tailnet.ts.net' };
    await until(() => cfg.publicUrl === `http://myhost.example-tailnet.ts.net:${port}`, 2000);
    assert.equal(await getWithHost(port, 'myhost.example-tailnet.ts.net', '/api/health', '127.0.0.2'), 200);
    const after = probes();
    await sleep(200);
    assert.equal(probes(), after);
  } finally {
    await app.close();
  }
});

test('quick retries of an address that cannot be bound stop when the next poll is due', async (t) => {
  const { app, probes } = await tailscaleApp(t, { BOTONS_TAILSCALE_POLL_MS: '600ms' }, () => ({ ip: '192.0.2.10', dnsName: null }), { retryMs: 25 });
  try {
    await app.listen();
    await sleep(400);
    assert.ok(probes() >= 5, `retried every 25ms at first (${probes()} probes)`);
    await sleep(400);
    const later = probes();
    await sleep(1300);
    // Only the regular 600ms poll now (two or three), not one every 25ms (over 50).
    assert.ok(probes() - later <= 4, `${probes() - later} probes in 1.3s`);
  } finally {
    await app.close();
  }
});

