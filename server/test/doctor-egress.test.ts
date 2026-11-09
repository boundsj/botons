// The doctor's IPv4 and IPv6 check, with the lookup and the sockets stubbed: one deadline for both families, a lookup
// answering after it starts no connection, and at the deadline lookups are cancelled and sockets destroyed.
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { test } from 'node:test';
import { type EgressNet, probeEgress } from '../../scripts/doctor.ts';

function stub(answer: Record<4 | 6, { ms: number; address?: string; socket: 'connect' | 'refuse' | 'stall' }>) {
  const made: Socket[] = [];
  const connected: string[] = [];
  let cancelled = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const net: EgressNet = {
    resolve: (_host, family) =>
      new Promise((resolve) => {
        timers.push(setTimeout(() => resolve(answer[family].address ? [answer[family].address!] : []), answer[family].ms));
      }),
    cancel: () => {
      cancelled++;
    },
    connect: (host) => {
      connected.push(host);
      const s = new Socket();
      made.push(s);
      const how = Object.values(answer).find((a) => a.address === host)!.socket;
      if (how === 'connect') setImmediate(() => s.emit('connect'));
      if (how === 'refuse') setImmediate(() => s.destroy(new Error('refused')));
      return s;
    },
  };
  return { net, made, connected, cancelled: () => cancelled, clear: () => timers.forEach(clearTimeout) };
}

test('both families answer well within the deadline', async () => {
  const t = stub({ 4: { ms: 1, address: '192.0.2.1', socket: 'connect' }, 6: { ms: 1, address: '2001:db8::1', socket: 'refuse' } });
  assert.deepEqual(await probeEgress(t.net, 1000), { v4: true, v6: false });
  assert.ok(t.made.every((s) => s.destroyed), 'every socket destroyed');
  t.clear();
});

test('a stalled socket and a slow lookup end at one shared deadline, and nothing connects after it', async () => {
  const t = stub({ 4: { ms: 1, address: '192.0.2.1', socket: 'stall' }, 6: { ms: 60, address: '2001:db8::1', socket: 'connect' } });
  const started = Date.now();
  assert.deepEqual(await probeEgress(t.net, 20), { v4: false, v6: false });
  assert.ok(Date.now() - started < 50, 'returned at the deadline');
  assert.equal(t.cancelled(), 1, 'lookups still under way cancelled');
  assert.ok(t.made.length === 1 && t.made[0].destroyed, 'the stalled socket destroyed');
  // The IPv6 lookup answers after the deadline: no connection is started for it.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(t.connected, ['192.0.2.1']);
  t.clear();
});


test('doctor recognizes the built-in browser grant without a library row', async () => {
  const { connectorFindings } = await import('../../scripts/doctor.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`create table bots (id, name, connections, created_at);
      insert into bots values ('b', 'Example', '["lib:botons_browser"]', '');`);
    const findings: string[] = [];
    connectorFindings(db, 35, (_check, status) => findings.push(status));
    assert.deepEqual(findings, ['ok']);
  } finally { db.close(); }
});
