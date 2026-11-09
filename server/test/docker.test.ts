import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { allowedHostNames, DEFAULT_DRAIN_MS, loadConfig, parseDuration } from '../src/config.ts';
import { guardRequest } from '../src/http.ts';
import { tempDir } from './helpers.ts';

// The image can't be built here (CI's Docker job builds and runs it: scripts/docker-smoke.sh). These check that the
// settings the image and compose.yaml give the server work, and that the files keep their safety defaults.
const repo = resolve(import.meta.dirname, '../..');
const read = (f: string) => readFileSync(join(repo, f), 'utf8');

/** The server settings the image gives: the Dockerfile's ENV, and docker/botons's defaults for what the owner didn't set. */
function imageEnv(): Record<string, string> {
  const dockerfile = read('Dockerfile').replace(/\\\n/g, ' ');
  const env: Record<string, string> = {};
  for (const line of dockerfile.split('\n').filter((l) => l.startsWith('ENV '))) {
    for (const m of line.slice(4).matchAll(/(\w+)=(\S+)/g)) env[m[1]] = m[2];
  }
  // : "${BOTONS_X:=value}": the value unless the owner set it.
  for (const m of read('docker/botons').matchAll(/^: "\$\{(BOTONS_\w+):=([^}]*)\}"$/gm)) env[m[1]] = m[2];
  return env;
}

const NO_TS = () => ({ ip: null, dnsName: null });
const req = (headers: Record<string, string>, method = 'GET') => ({ headers, method }) as unknown as IncomingMessage;

test('the image and compose.yaml give the server a valid config: every interface, no Tailscale, the public URL from .env', () => {
  const env = imageEnv();
  assert.deepEqual(
    { home: env.BOTONS_HOME, host: env.BOTONS_HOST, ts: env.BOTONS_NO_TAILSCALE, container: env.BOTONS_CONTAINER },
    { home: '/data', host: '0.0.0.0', ts: '1', container: '1' },
  );
  const home = tempDir();
  const cfg = loadConfig({ ...env, BOTONS_HOME: home, BOTONS_PORT: '7777', BOTONS_PUBLIC_URL: 'http://localhost:7777' }, NO_TS, { create: false });
  assert.deepEqual(cfg.hosts, ['0.0.0.0']);
  assert.equal(cfg.tailscale.mode, 'off');
  assert.equal(cfg.publicUrl, 'http://localhost:7777');
  assert.equal(cfg.authEnabled, true);
});

test("the image installs Chromium for the managed browser and keeps Chromium's sandbox on: nothing in the image or Compose turns it off", () => {
  const env = imageEnv();
  assert.equal(env.BOTONS_BROWSER_PATH, '/usr/bin/chromium');
  assert.equal(env.BOTONS_BROWSER_SANDBOX, undefined);
  assert.match(read('Dockerfile').replace(/\\\n/g, ' '), /apt-get install[^\n]* chromium /);
  for (const f of ['compose.yaml', 'docker/compose.tailscale.yaml', 'docker/compose.caddy.yaml', '.env.example', 'botons.env.example', 'docker/botons'].filter((x) => existsSync(join(repo, x)))) {
    assert.doesNotMatch(read(f), /BOTONS_BROWSER_SANDBOX|unconfined|privileged|cap_add|apparmor/, f);
  }
  const cfg = loadConfig({ ...env, BOTONS_HOME: tempDir(), BOTONS_PORT: '7777' }, NO_TS, { create: false });
  assert.deepEqual({ path: cfg.browser.path, sandbox: cfg.browser.sandbox }, { path: '/usr/bin/chromium', sandbox: true });
});

test("Compose runs the server with Docker's seccomp profile plus only the user, PID and network namespaces Chromium's sandbox needs, and no-new-privileges", () => {
  const compose = read('compose.yaml');
  const opts = /\n    security_opt:\n((?: {6}(?:#.*|- .*)\n)+)/.exec(compose)?.[1].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2));
  assert.deepEqual(opts, ['seccomp=docker/seccomp-browser.json', 'no-new-privileges:true']);
  for (const f of ['docker/compose.tailscale.yaml', 'docker/compose.caddy.yaml']) assert.doesNotMatch(read(f), /security_opt|seccomp/, f);

  type Rule = { names: string[]; action: string; args?: { index: number; value: number; valueTwo?: number; op: string }[]; includes?: { caps?: string[]; arches?: string[] }; excludes?: { caps?: string[]; arches?: string[] } };
  const profile = JSON.parse(read('docker/seccomp-browser.json')) as { defaultAction: string; syscalls: Rule[] };
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  const NEWTIME = 0x80, NEWNS = 0x20000, NEWCGROUP = 0x2000000, NEWUTS = 0x4000000, NEWIPC = 0x8000000, NEWUSER = 0x10000000, NEWPID = 0x20000000, NEWNET = 0x40000000;
  const others = NEWNS | NEWCGROUP | NEWUTS | NEWIPC;
  const allows = profile.syscalls.filter((r) => r.action === 'SCMP_ACT_ALLOW');
  // What only a container with CAP_SYS_ADMIN (which this one doesn't have) or another added capability may call.
  const gated = (r: Rule) => !!r.includes?.caps?.length;
  for (const name of ['mount', 'umount2', 'setns', 'pivot_root', 'keyctl', 'add_key', 'request_key', 'bpf', 'open_by_handle_at', 'init_module', 'kexec_load', 'clone3', 'fsopen', 'fsmount', 'move_mount', 'open_tree']) {
    assert.ok(allows.filter((r) => r.names.includes(name)).every(gated), `${name} is allowed without a capability`);
  }
  // clone and unshare: allowed ungated only with an argument check that refuses mount, UTS, IPC and cgroup namespaces.
  const ns = allows.filter((r) => !gated(r) && (r.names.includes('clone') || r.names.includes('unshare')));
  assert.ok(ns.length >= 3);
  const permits = (flags: number, name: string) =>
    ns.some((r) => r.names.includes(name) && !r.includes?.arches?.some((a) => a.startsWith('s390')) && (r.args ?? []).every((a) => a.op === 'SCMP_CMP_MASKED_EQ' && (flags & a.value) === (a.valueTwo ?? 0)));
  for (const r of ns) {
    assert.deepEqual(r.names.length, 1, JSON.stringify(r));
    assert.ok(r.args?.length === 1 && r.args[0].op === 'SCMP_CMP_MASKED_EQ' && (r.args[0].value & others) === others && !r.args[0].valueTwo, JSON.stringify(r));
  }
  // CLONE_NEWTIME shares clone's signal bits, so forbid it only for unshare.
  assert.ok(!permits(NEWUSER | NEWTIME, 'unshare'), 'unshare: time namespace');
  assert.ok(permits(NEWUSER | 0x80, 'clone'), 'clone: low signal bits are not namespace flags');
  for (const name of ['clone', 'unshare']) {
    assert.ok(permits(NEWUSER | NEWPID | NEWNET, name), `${name}: user, PID and network namespaces`);
    for (const flag of [NEWNS, NEWUTS, NEWIPC, NEWCGROUP]) assert.ok(!permits(NEWUSER | flag, name), `${name}: ${flag.toString(16)}`);
  }
});

test('behind Caddy or Tailscale Serve, the proxied name is accepted (Host and Origin kept) and other names are not', () => {
  for (const publicUrl of ['https://botons.example.com', 'https://botons.example-tailnet.ts.net']) {
    const cfg = loadConfig({ ...imageEnv(), BOTONS_HOME: tempDir(), BOTONS_PUBLIC_URL: publicUrl }, NO_TS, { create: false });
    const host = new URL(publicUrl).host;
    const allowed = allowedHostNames(cfg);
    const url = new URL('http://local/api/bots');
    assert.equal(guardRequest(req({ host, origin: publicUrl, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, 'POST'), url, allowed), null);
    assert.match(guardRequest(req({ host: 'attacker.example.com' }), url, allowed)!, /not allowed/);
    // A proxy that rewrote Host would break every change the web app makes: Caddy and Tailscale Serve keep it.
    assert.match(guardRequest(req({ host: 'botons:7777', origin: publicUrl, 'content-type': 'application/json' }, 'POST'), url, allowed)!, /not allowed|Cross-origin/);
  }
});

test('compose.yaml publishes on 127.0.0.1 by default, keeps the data and logins in volumes, and gives turns time to drain', () => {
  const compose = read('compose.yaml');
  assert.match(compose, /- "\$\{BOTONS_BIND:-127\.0\.0\.1\}:\$\{BOTONS_PUBLISH_PORT:-7777\}:7777"/);
  assert.match(compose, /^name: botons$/m);
  assert.match(compose, /^services:\n {2}botons:$/m);
  assert.match(compose, /BOTONS_PORT: "7777"/);
  assert.match(read('Dockerfile'), /^EXPOSE 7777$/m);
  assert.match(compose, /- data:\/data\n/);
  assert.match(compose, /- home:\/home\/node\n/);
  // .env (which may hold TS_AUTHKEY) is never handed to the server whole.
  assert.doesNotMatch(compose, /path: \.env\b/);
  assert.match(compose, /env_file:\n\s+- path: botons\.env\n\s+required: false\n/);
  const grace = parseDuration(/stop_grace_period: (\S+)/.exec(compose)![1]);
  assert.ok(grace >= DEFAULT_DRAIN_MS + 15_000, `stop_grace_period ${grace}ms leaves running turns too little of their ${DEFAULT_DRAIN_MS}ms`);
});

test('the overlays publish nothing of the app themselves and proxy to it', () => {
  for (const f of ['docker/compose.tailscale.yaml', 'docker/compose.caddy.yaml']) {
    const text = read(f);
    assert.match(text, /botons:\n(?:.*\n)*?\s+ports: !reset \[\]/, `${f} must drop the app's own published port`);
    assert.match(text, /BOTONS_PUBLIC_URL: \$\{BOTONS_PUBLIC_URL:\?/, `${f} must require an https public URL`);
  }
  const serve = JSON.parse(read('docker/tailscale-serve.json'));
  assert.deepEqual(serve.Web['${TS_CERT_DOMAIN}:443'].Handlers['/'], { Proxy: 'http://127.0.0.1:7777' });
  assert.match(read('docker/Caddyfile'), /reverse_proxy botons:7777/);
  assert.match(read('docker/compose.tailscale.yaml'), /TS_AUTHKEY: \$\{TS_AUTHKEY:\?/);
});

test('the image entry point runs only scripts that exist, and the build context leaves out local data and secrets', () => {
  const wrapper = read('docker/botons');
  assert.match(read('Dockerfile'), /^ENTRYPOINT \["tini", "--", "botons"\]$/m);
  const scripts = [...wrapper.matchAll(/exec node (\S+)/g)].map((m) => m[1]).filter((arg) => !arg.startsWith('-'));
  assert.deepEqual(scripts, ['server/src/index.ts', 'scripts/login.ts', 'scripts/doctor.ts', 'scripts/pair.ts', 'scripts/backup.ts', 'scripts/restore.ts', 'scripts/check-browser.ts']);
  for (const s of scripts) assert.ok(existsSync(join(repo, s)), s);
  const ignored = read('.dockerignore').split('\n');
  for (const p of ['.git', '.env', '.env.*', '*.env', '*.db', '.botons-dev', '**/node_modules']) assert.ok(ignored.includes(p), `.dockerignore must list ${p}`);
});
