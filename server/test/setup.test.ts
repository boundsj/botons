import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AuditEvent, AuthStatus, Bot, Health, Message, BotonCapabilities, PairingRequest, PairResult, ProviderInfo, SetupStatus } from '../../shared/types.ts';
import { AUDIT_KEEP, HOST_ACTOR, recordAudit } from '../src/audit.ts';
import { classifyAddress, connectionClass, modeAllows } from '../src/setup.ts';
import { approvedPairing, failOnEscapedErrors, pairDevice, startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

failOnEscapedErrors();
const repo = resolve(import.meta.dirname, '../..');

test('a fresh install: claimed by approving the browser\'s code on the host, then owner, access mode, a ready brain, a first Boton and a working chat, all audited', async (t) => {
  const s = await startServer({ token: null });
  const { app, base } = s;

  // Unclaimed: the pair screen says so, and nothing else answers without a device.
  const before = await s.call<AuthStatus>('GET', '/api/auth/status', undefined, null);
  assert.equal(before.status, 200);
  assert.deepEqual([before.data.claimed, before.data.caller, before.data.pairCommand], [false, 'none', 'npm run pair']);
  assert.equal((await s.call('GET', '/api/setup', undefined, null)).status, 401);
  // A guess is no claim.
  const guess = await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-BBBB' }) });
  assert.equal(guess.status, 400);
  assert.equal((await s.call<AuthStatus>('GET', '/api/auth/status', undefined, null)).data.claimed, false);

  // The browser asks and shows its code; it waits until the owner approves that code on the host.
  const asked = await s.call<PairingRequest>('POST', '/api/auth/pair-requests', { label: 'Sam laptop' }, null);
  assert.equal(asked.status, 201, asked.text);
  assert.equal(asked.data.approveCommand, `npm run pair -- --approve ${asked.data.code}`);
  const redeem = () => s.call<PairResult>('POST', '/api/auth/pair', { secret: asked.data.secret }, null);
  assert.equal((await redeem()).status, 409, 'waiting');
  const hint = await pairCli({ BOTONS_HOME: s.home });
  assert.equal(hint.code, 0, hint.stderr);
  assert.match(hint.stdout, /Open Botons on that device[\s\S]*npm run pair -- --approve <code>[\s\S]*Waiting now[\s\S]*Sam laptop/);
  assert.ok(!hint.stdout.includes(asked.data.code), 'codes show only on the devices');
  const approved = await pairCli({ BOTONS_HOME: s.home }, '--approve', asked.data.code.toLowerCase());
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /Approved "Sam laptop"/);
  const claimed = await redeem();
  assert.equal(claimed.status, 201, claimed.text);
  const owner = claimed.data.token;
  const as = <T = any>(method: string, path: string, body?: unknown) => s.call<T>(method, path, body, owner);
  assert.equal((await s.call<AuthStatus>('GET', '/api/auth/status', undefined, null)).data.claimed, true);

  let setup = (await as<SetupStatus>('GET', '/api/setup')).data;
  assert.equal(setup.completed, false);
  assert.equal(setup.owner.claimedBy, 'Sam laptop');
  assert.ok(setup.owner.claimedAt);
  assert.equal(setup.accessMode, null, 'nothing refused until the owner chooses');
  assert.equal(setup.recommendedMode, 'local', 'no tailnet here');
  assert.deepEqual(setup.modes.map((m) => [m.mode, m.available]), [['local', true], ['tailscale', true], ['lan', true], ['public', false]]);
  assert.match(setup.modes.find((m) => m.mode === 'public')!.reason!, /HTTPS/);
  assert.deepEqual(setup.exposure.listeners, [`127.0.0.1:${s.port}`]);

  assert.equal((await as('PATCH', '/api/settings', { ownerName: 'Sam' })).status, 200);
  const mode = await as<SetupStatus>('PATCH', '/api/setup', { accessMode: 'local' });
  assert.equal(mode.status, 200, mode.text);
  assert.equal(mode.data.accessMode, 'local');

  const providers = (await as<ProviderInfo[]>('GET', '/api/providers')).data;
  assert.ok(providers.some((p) => p.id === 'mock' && p.available));
  const created = await as<Bot>('POST', '/api/bots', { name: 'Kevin', provider: 'mock' });
  assert.equal(created.status, 201);
  assert.equal(created.data.access, 'workspace', 'a new Boton starts sandboxed');
  assert.equal((await as<SetupStatus>('GET', '/api/setup')).data.completed, false, 'a Boton alone does not finish setup');

  assert.equal((await as('POST', `/api/bots/${created.data.id}/messages`, { text: 'Hello Kevin' })).status, 202);
  const reply = await until(async () => (await as<Message[]>('GET', `/api/bots/${created.data.id}/messages`)).data.find((m) => m.role === 'bot'));
  assert.match(reply.text, /Hello Kevin/);
  const health = await as<Health>('GET', '/api/health');
  assert.equal(health.status, 200, health.text);
  assert.equal(health.data.ok, true);

  setup = (await as<SetupStatus>('PATCH', '/api/setup', { complete: true })).data;
  assert.equal(setup.completed, true);
  assert.ok(setup.completedAt);
  assert.equal(setup.owner.name, 'Sam');

  // A second device pairs, but does not claim.
  const second = await pairDevice(app, base, 'Sam phone');
  const pairings = (await as<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'device.paired');
  assert.deepEqual(pairings.map((e) => [e.target?.label, e.details.claim, e.details.method, e.details.network]), [
    ['Sam phone', false, 'approval', 'loopback'],
    ['Sam laptop', true, 'approval', 'loopback'],
  ]);
  assert.equal((await as<SetupStatus>('GET', '/api/setup')).data.owner.claimedBy, 'Sam laptop', 'the claim is never replaced');

  const log = (await as<AuditEvent[]>('GET', '/api/audit')).data;
  assert.deepEqual(log.map((e) => e.action).reverse(), ['pairing_request.approved', 'device.paired', 'access_mode.changed', 'boton.created', 'setup.completed', 'device.paired']);
  assert.deepEqual(log.find((e) => e.action === 'access_mode.changed')!.details, { from: null, to: 'local' });
  assert.equal(log.find((e) => e.action === 'boton.created')!.actor.label, 'Sam laptop');
  // No device token anywhere in it.
  assert.doesNotMatch(JSON.stringify(log), new RegExp(`${owner}|${second}|mdt_|${asked.data.secret}|${asked.data.code}`));
  t.diagnostic(`audit: ${log.length} events`);
});

test('the access mode refuses other networks before anything else, takes effect at once, and never locks out the device setting it', async (t) => {
  const s = await startServer();
  const from = (ip: string) => t.mock.method(s.app.auth, 'remoteAddress', () => ip);
  const page = () => fetch(`${s.base}/`).then((r) => r.status);

  // Unset: the listeners decide (an existing install keeps working as it did).
  from('203.0.113.9');
  assert.equal(await page(), 200);
  assert.equal((await s.call('GET', '/api/bots')).status, 200);

  // From the public address, choosing tailscale would lock this device out.
  const locked = await s.call('PATCH', '/api/setup', { accessMode: 'tailscale' });
  assert.equal(locked.status, 409);
  assert.match(locked.data.error, /lock you out/);
  assert.equal(s.app.setup.accessMode, null);

  from('100.70.0.2');
  assert.equal((await s.call('PATCH', '/api/setup', { accessMode: 'tailscale' })).status, 200);
  for (const [ip, ok] of [['127.0.0.1', true], ['::ffff:127.0.0.1', true], ['100.70.0.2', true], ['fd7a:115c:a1e0::5', true], ['192.168.1.20', false], ['203.0.113.9', false]] as const) {
    from(ip);
    assert.equal(await page(), ok ? 200 : 403, ip);
    const health = await s.call('GET', '/api/health', undefined, null);
    assert.equal(health.status === 403, !ok, `${ip} /api/health`);
    if (!ok) assert.match(health.data.error, /only accepts only my tailscale devices connections.*npm run pair -- --access-mode/);
  }
  // Refused before pairing too: a public caller can't even redeem an approved request.
  from('203.0.113.9');
  const secret = approvedPairing(s.app.store.db);
  const pair = await fetch(`${s.base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
  assert.equal(pair.status, 403);
  assert.equal((await s.call('POST', '/api/auth/pair-requests', {}, null)).status, 403);

  // `npm run pair -- --access-mode` on the host gets a locked-out owner back in, with the running server.
  const run = await pairCli({ BOTONS_HOME: s.home }, '--access-mode', 'lan');
  assert.equal(run.code, 0, run.stderr);
  from('192.168.1.20');
  assert.equal(await page(), 200);
  const bad = await pairCli({ BOTONS_HOME: s.home }, '--access-mode', 'everyone');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /must be one of local, tailscale, lan, public or none/);
  const pub = await pairCli({ BOTONS_HOME: s.home }, '--access-mode', 'public');
  assert.equal(pub.code, 1);
  assert.match(pub.stderr, /HTTPS/);
  from('127.0.0.1');
  const changes = (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === 'access_mode.changed');
  assert.deepEqual(changes.map((e) => [e.actor.kind, e.details.from, e.details.to]), [
    ['host', 'tailscale', 'lan'],
    ['device', null, 'tailscale'],
  ]);

  // Back to unset from the app.
  assert.equal((await s.call('PATCH', '/api/setup', { accessMode: null })).data.accessMode, null);
  assert.equal((await s.call('PATCH', '/api/setup', { accessMode: 'anyone' })).status, 400);
  assert.equal((await s.call('PATCH', '/api/setup', { complete: false })).status, 400);
});

test('public needs HTTPS and auth; lan needs auth', async () => {
  const pub = await startServer({ env: { BOTONS_PUBLIC_URL: 'https://botons.example.com', BOTONS_ALLOWED_HOSTS: 'botons.example.com' } });
  const ok = await pub.call<SetupStatus>('PATCH', '/api/setup', { accessMode: 'public' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.data.warnings.filter((w) => w.level === 'error'), []);

  const off = await startServer({ env: { BOTONS_AUTH: 'off' }, token: null });
  for (const mode of ['lan', 'public']) {
    const r = await off.call('PATCH', '/api/setup', { accessMode: mode }, null);
    assert.equal(r.status, 400, mode);
    assert.match(r.data.error, /Auth is off/);
  }
  const status = (await off.call<SetupStatus>('GET', '/api/setup', undefined, null)).data;
  assert.ok(status.warnings.some((w) => w.level === 'error' && /BOTONS_AUTH=off/.test(w.text)));
});

test('in a container, local still reaches the published port from the bridge network, never the internet', () => {
  assert.equal(classifyAddress('172.18.0.1'), 'private');
  assert.equal(classifyAddress('::ffff:10.0.0.4'), 'private');
  assert.equal(classifyAddress('fe80::1'), 'private');
  assert.equal(classifyAddress('100.100.100.100'), 'tailnet');
  assert.equal(classifyAddress('100.128.0.1'), 'public', 'outside 100.64.0.0/10');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(modeAllows('local', 'private', true), true);
  assert.equal(modeAllows('local', 'private', false), false);
  assert.equal(modeAllows('local', 'tailnet', false), false);
  assert.equal(modeAllows('tailscale', 'public', true), false);
  assert.equal(modeAllows('lan', 'public', false), false);
  assert.equal(modeAllows('public', 'public', false), true);
  assert.equal(modeAllows(null, 'public', false), true);
});

test('Botons can reach none of it: setup, the audit log, capabilities, pairing; and an existing install is set up already', async () => {
  const s = await startServer();
  const bot = await s.newBot('Stuart');
  const turn = s.app.auth.mintBotonToken(bot.id);
  try {
    for (const [method, path, body] of [
      ['GET', '/api/setup'],
      ['PATCH', '/api/setup', { accessMode: null }],
      ['PATCH', '/api/setup', { complete: true }],
      ['GET', '/api/audit'],
      ['GET', `/api/bots/${bot.id}/capabilities`],
      ['POST', '/api/pairing-requests/approve', { code: 'AAAA-BBBB' }],
      ['POST', '/api/auth/pair-requests', {}],
    ] as const) {
      assert.equal((await s.call(method, path, body, turn.token)).status, 403, `${method} ${path}`);
    }
    // An approved request is no good under its token, and is still good for the device that holds it.
    const secret = approvedPairing(s.app.store.db);
    const refused = await fetch(`${s.base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${turn.token}` },
      body: JSON.stringify({ secret }),
    });
    assert.equal(refused.status, 403);
    const res = await fetch(`${s.base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
    assert.equal(res.status, 201);
    assert.ok(((await res.json()) as PairResult).token);
  } finally {
    turn.revoke();
  }
  // Claimed here, so setup waits for the owner even with a Boton.
  assert.equal((await s.call<SetupStatus>('GET', '/api/setup')).data.completed, false);
  // Botons but no setup record: a server from before setup existed is not walked through it.
  s.app.store.db.prepare("delete from settings where key in ('setup', 'ownerClaim')").run();
  const existing = (await s.call<SetupStatus>('GET', '/api/setup')).data;
  assert.deepEqual([existing.completed, existing.owner.claimedAt, existing.owner.devices], [true, null, 2]);
  // Its owner pairing again after revoking every device doesn't bring setup back.
  for (const d of s.app.auth.devices(null)) s.app.auth.revokeDevice(d.id);
  const again = await pairDevice(s.app, s.base, 'New phone');
  const after = (await s.call<SetupStatus>('GET', '/api/setup', undefined, again)).data;
  assert.deepEqual([after.completed, after.owner.claimedBy], [true, 'New phone']);
});

test('what a Boton may do, and every change to it, are inspectable', async () => {
  const s = await startServer();
  const bot = await s.newBot('Bob');
  let caps = (await s.call<BotonCapabilities>('GET', `/api/bots/${bot.id}/capabilities`)).data;
  assert.equal(caps.access, 'workspace');
  assert.match(caps.summary[0], /^Workspace access/);
  assert.ok(caps.summary.includes('No connectors.'));

  assert.equal((await s.call('PATCH', `/api/bots/${bot.id}`, { access: 'host', askFirst: ['Bash(git push:*)'] })).status, 200);
  await s.newRoutine(bot.id, { name: 'Deploy hook', webhook: true, webhookWorkspace: false });
  caps = (await s.call<BotonCapabilities>('GET', `/api/bots/${bot.id}/capabilities`)).data;
  assert.match(caps.summary[0], /^Full computer access/);
  assert.ok(caps.summary.some((l) => /Webhooks can start "Deploy hook" with Full computer access/.test(l)), caps.summary.join('\n'));
  assert.ok(caps.summary.some((l) => /Asks .* first before: Bash\(git push:\*\)/.test(l)));
  assert.deepEqual(caps.askFirst, { enforced: ['Bash(git push:*)'], alwaysAllowed: [], inactive: [] });
  assert.deepEqual(caps.routines.map((r) => [r.name, r.webhook, r.webhookFullAccess]), [['Deploy hook', true, true]]);

  const log = (await s.call<AuditEvent[]>('GET', '/api/audit')).data;
  const access = log.find((e) => e.action === 'boton.access_changed')!;
  assert.deepEqual([access.target?.label, access.details], ['Bob', { from: 'workspace', to: 'host' }]);
  assert.deepEqual(log.find((e) => e.action === 'boton.permissions_changed')!.details, { askFirstAdded: ['Bash(git push:*)'] });
  assert.deepEqual(log.find((e) => e.action === 'routine.permissions_changed')!.details, { boton: bot.id, webhookFullAccess: true, callback: null, webhookHistory: 0 });

  // Deleting it is recorded under the name it had.
  assert.equal((await s.call('DELETE', `/api/bots/${bot.id}`)).status, 200);
  const deleted = (await s.call<AuditEvent[]>('GET', '/api/audit')).data[0];
  assert.deepEqual([deleted.action, deleted.target?.label], ['boton.deleted', 'Bob']);
});

test('Ask first rules show as the engine applies them: enforced, always allowed, or inactive on a brain that ignores them', async () => {
  useTestCodexHome(tempDir('botons-caps-codex-'));
  const s = await startServer();
  const rules = ['Bash(git push:*)', 'Bash(rm:*)'];
  const caps = async (id: string) => (await s.call<BotonCapabilities>('GET', `/api/bots/${id}/capabilities`)).data;

  // A brain that pauses on them (the mock stands in for Claude), with one rule always allowed.
  const kevin = s.storeBot('Kevin', 'mock');
  assert.equal((await s.call('PATCH', `/api/bots/${kevin.id}`, { askFirst: rules, alwaysAllow: ['bash(rm:*)'] })).status, 200);
  const k = await caps(kevin.id);
  assert.deepEqual(k.askFirst, { enforced: ['Bash(git push:*)'], alwaysAllowed: ['Bash(rm:*)'], inactive: [] });
  assert.ok(k.summary.some((l) => /first before: Bash\(git push:\*\)\.$/.test(l)), k.summary.join('\n'));
  assert.ok(k.summary.some((l) => /always allows, so they pause only webhook runs: Bash\(rm:\*\)/.test(l)));
  assert.ok(!k.summary.some((l) => /Not enforced/.test(l)));

  // Codex never gets them: saved, shown as inactive, and never described as asking first.
  const stuart = s.storeBot('Stuart', 'codex-cli');
  assert.equal((await s.call('PATCH', `/api/bots/${stuart.id}`, { askFirst: rules })).status, 200);
  const st = await caps(stuart.id);
  assert.deepEqual(st.askFirst, { enforced: [], alwaysAllowed: [], inactive: rules });
  assert.ok(!st.summary.some((l) => /first before/.test(l)), st.summary.join('\n'));
  assert.ok(st.summary.some((l) => /^Not enforced: its brain \(Codex[^)]*\)\)? doesn't pause on Ask first rules.*Bash\(git push:\*\), Bash\(rm:\*\)\.$/.test(l)), st.summary.join('\n'));
});

test('every access mode says what it cannot see: forwarders on this machine, a container network, a public URL elsewhere', async () => {
  const plain = await startServer();
  let setup = (await plain.call<SetupStatus>('GET', '/api/setup')).data;
  const mode = (m: string) => setup.modes.find((x) => x.mode === m)!;
  for (const m of ['local', 'tailscale', 'lan']) {
    assert.match(mode(m).limits[0], /checks only the address.*reverse proxy, Tailscale Serve or Funnel, an SSH or other tunnel.*can't detect/, m);
    assert.doesNotMatch(mode(m).summary, /Nothing else can connect|nothing opened to the internet/i, m);
  }
  assert.ok(mode('local').summary.length < 80);
  assert.match(mode('tailscale').limits[1], /Your tailnet decides/);
  assert.match(mode('public').limits[0], /auth and pairing are the only boundary/);
  // No mode chosen: nothing is promised, so no warning; once one is, the limit is on the status too.
  assert.ok(!setup.warnings.some((w) => /checks only the address/.test(w.text)));
  setup = (await plain.call<SetupStatus>('PATCH', '/api/setup', { accessMode: 'local' })).data;
  assert.ok(setup.warnings.some((w) => w.level === 'warn' && w.text === mode('local').limits[0]));
  assert.ok(!setup.warnings.some((w) => /BOTONS_PUBLIC_URL is/.test(w.text)), 'no public URL set: no sign of a proxy');

  // A public URL on another host (HTTPS here) is a sign of a forwarder the mode can't tell from this machine.
  const proxied = await startServer({ env: { BOTONS_PUBLIC_URL: 'https://botons.example.com' } });
  assert.equal((await proxied.call('PATCH', '/api/setup', { accessMode: 'tailscale' })).status, 409);
  setup = (await proxied.call<SetupStatus>('GET', '/api/setup')).data;
  assert.equal(setup.recommendedMode, 'public');
  assert.equal(setup.modes.find(m => m.mode === 'local')!.available, false);

  // Container details explain the published port and the network boundary.
  const docker = await startServer({ env: { BOTONS_CONTAINER: '1' } });
  setup = (await docker.call<SetupStatus>('GET', '/api/setup')).data;
  assert.ok(mode('local').summary.length < 80);
  assert.match(mode('local').limits[0], /In a container every connection comes from the container network/);
  setup = (await docker.call<SetupStatus>('PATCH', '/api/setup', { accessMode: 'local' })).data;
  assert.ok(setup.warnings.some((w) => /In a container every connection/.test(w.text)));
});

test('audit rows drop secret-looking details and keep only the newest', async () => {
  const s = await startServer({ token: null });
  const db = s.app.store.db;
  recordAudit(db, HOST_ACTOR, { action: 'pairing_request.approved', details: { label: 'iPad', code: 'AAAA-BBBB', token: 'mdt_x', apiKey: 'k', secret: 'mpr_x', expiresAt: 'soon' } });
  const row = db.prepare('select details from audit_events order by seq desc limit 1').get()!;
  assert.deepEqual(JSON.parse(String(row.details)), { label: 'iPad', expiresAt: 'soon' });
  db.prepare("insert into audit_events (at, actor_kind, action) select '2026-01-01T00:00:00.000Z', 'system', 'oauth.connected' from (with recursive n(i) as (select 1 union all select i + 1 from n where i < ?) select i from n)").run(AUDIT_KEEP + 5);
  recordAudit(db, HOST_ACTOR, { action: 'devices.revoked_all', details: { count: 0 } });
  assert.equal(Number(db.prepare('select count(*) as n from audit_events').get()!.n), AUDIT_KEEP);
});

test('`npm run pair` records what it does as the server machine', async () => {
  const home = tempDir();
  const s = await startServer({ home, token: null });
  assert.equal((await pairCli({ BOTONS_HOME: home }, '--label', 'Work iPad')).code, 2, '--label only names a device being approved');
  const asked = (await s.call<PairingRequest>('POST', '/api/auth/pair-requests', { label: 'Safari on iPad' }, null)).data;
  const approved = await pairCli({ BOTONS_HOME: home }, '--approve', asked.code, '--label', 'Work iPad');
  assert.equal(approved.code, 0, approved.stderr);
  const paired = await s.call<PairResult>('POST', '/api/auth/pair', { secret: asked.secret }, null);
  assert.equal(paired.data.device.label, 'Work iPad', 'the label given on the host wins');
  const token = paired.data.token;
  const id = (await s.call<{ id: string; current: boolean }[]>('GET', '/api/devices', undefined, token)).data.find((d) => d.current)!.id;
  assert.equal((await pairCli({ BOTONS_HOME: home }, '--revoke', id)).code, 0);
  const db = new DatabaseSync(join(home, 'botons.db'), { readOnly: true });
  try {
    const rows = db.prepare("select actor_kind, action, target_id from audit_events where actor_kind = 'host' order by seq").all();
    assert.deepEqual(rows.map((r) => [r.actor_kind, r.action, r.target_id]), [
      ['host', 'pairing_request.approved', null],
      ['host', 'device.revoked', id],
    ]);
  } finally {
    db.close();
  }
});

/** scripts/pair.ts as the owner runs it on the host, never with the real config or data folder. */
function pairCli(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const noConfig = tempDir('botons-pair-config-');
  return new Promise((done) =>
    execFile(
      process.execPath,
      [join(repo, 'scripts/pair.ts'), ...args],
      {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOTONS_') && k !== 'PORT')),
          HOME: noConfig,
          XDG_CONFIG_HOME: noConfig,
          BOTONS_NO_TAILSCALE: '1',
          ...env,
        },
      },
      (err, stdout, stderr) => done({ code: err ? (err.code as number) : 0, stdout, stderr }),
    ),
  );
}

test('connection hints and recommendations follow this request, without authorizing forwarded headers', async (t) => {
  for (const [remote, url, expected] of [
    ['127.0.0.1', null, 'loopback'],
    ['::ffff:127.0.0.1', 'https://botons.example.com', 'public'],
    ['172.18.0.2', 'https://botons.example.com', 'public'],
    ['100.70.0.2', 'https://botons.example.com', 'tailnet'],
    ['127.0.0.1', 'https://myhost.example-tailnet.ts.net', 'public'],
  ] as const) assert.equal(connectionClass(remote, url, 7777), expected);
  const s = await startServer({ configure: cfg => { cfg.urls.push('http://100.70.0.1:17777'); } });
  for (const [remote, expected] of [['127.0.0.1', 'local'], ['100.70.0.2', 'tailscale'], ['192.168.1.2', 'lan'], ['203.0.113.9', null]] as const) {
    t.mock.method(s.app.auth, 'remoteAddress', () => remote);
    const status = (await s.call<SetupStatus>('GET', '/api/setup')).data;
    assert.equal(status.exposure.tailscale, true, 'Tailscale availability is independent of this request');
    assert.equal(status.recommendedMode, expected);
    assert.ok(status.recommendedMode === null || status.modes.some(m => m.mode === status.recommendedMode && m.available));
    for (const m of status.modes) {
      assert.ok(m.summary.length <= 80);
      assert.ok((m.reason?.length ?? 0) <= 60);
      assert.ok(m.label.length <= 30);
    }
  }
  const proxy = await startServer({ env: { BOTONS_PUBLIC_URL: 'https://botons.example.com' } });
  for (const mode of ['local', 'tailscale', 'lan']) assert.equal((await proxy.call('PATCH', '/api/setup', { accessMode: mode })).status, 409);
  assert.equal(proxy.app.setup.refusal('127.0.0.1'), null, 'connection hint does not widen or replace the request guard');
  const spoofed = await fetch(`${proxy.base}/api/setup`, { headers: { authorization: `Bearer ${proxy.token}`, 'x-forwarded-for': '100.70.0.2', 'x-forwarded-proto': 'http' } });
  assert.equal(spoofed.status, 200);
  assert.equal((await spoofed.json()).recommendedMode, 'public', 'forwarded headers cannot choose a narrower mode');
});

test('request hints prevent narrowing without a configured public URL, but preserve container bridges', async (t) => {
  assert.equal(connectionClass('127.0.0.1', null, 7777, { host: 'botons.example.com' }), 'public');
  const s = await startServer();
  assert.equal(s.app.setup.status('127.0.0.1', { origin: 'https://botons.example.com' }).recommendedMode, null);
  assert.throws(() => s.app.setup.update({ accessMode: 'local' }, '127.0.0.1', { origin: 'https://botons.example.com' }), /lock you out/);
  for (const headers of [
    { 'x-forwarded-proto': 'https' },
    { forwarded: 'for=203.0.113.9;proto=https' },
  ] as Record<string, string>[]) {
    const status = await fetch(`${s.base}/api/setup`, { headers: { authorization: `Bearer ${s.token}`, ...headers } });
    const setup = await status.json() as SetupStatus;
    assert.equal(setup.recommendedMode, null);
    assert.ok(setup.modes.every(m => !m.available));
    const update = await fetch(`${s.base}/api/setup`, { method: 'PATCH', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ accessMode: 'local' }) });
    assert.equal(update.status, 409);
  }
  const docker = await startServer({ configure: cfg => { cfg.container = true; } });
  t.mock.method(docker.app.auth, 'remoteAddress', () => '172.18.0.1');
  const setup = (await docker.call<SetupStatus>('GET', '/api/setup')).data;
  for (const accessMode of ['local', 'tailscale'] as const) {
    assert.ok(setup.modes.find(m => m.mode === accessMode)?.available);
    assert.equal((await docker.call('PATCH', '/api/setup', { accessMode })).status, 200);
  }
  assert.equal(docker.app.setup.status('172.18.0.1', { 'x-forwarded-proto': 'https' }).recommendedMode, null);
  assert.throws(() => docker.app.setup.update({ accessMode: 'local' }, '172.18.0.1', { 'x-forwarded-proto': 'https' }), /lock you out/);
  const tailnet = await startServer({ env: { BOTONS_PUBLIC_URL: 'https://myhost.example-tailnet.ts.net' } });
  const hints = { host: 'myhost.example-tailnet.ts.net' };
  assert.equal(tailnet.app.setup.status('100.70.0.2', hints).recommendedMode, 'tailscale');
  assert.equal(tailnet.app.setup.status('127.0.0.1', hints).recommendedMode, 'public', 'Serve and Funnel cannot be distinguished from the URL alone');
  assert.equal(connectionClass('100.70.0.2', 'https://myhost.example-tailnet.ts.net', 7777, { host: 'myhost.example-tailnet.ts.net' }), 'tailnet');
  assert.equal(connectionClass('127.0.0.1', 'https://myhost.example-tailnet.ts.net', 7777, { host: 'myhost.example-tailnet.ts.net' }), 'public');
  assert.equal(connectionClass('203.0.113.9', null, 7777, { 'x-forwarded-for': '127.0.0.1' }), 'public');
  s.app.setup.update({ accessMode: 'local' }, '127.0.0.1');
  assert.ok(s.app.setup.refusal('203.0.113.9'), 'headers never widen socket authorization');
  assert.equal(modeAllows('local', 'public', true), false);
});
