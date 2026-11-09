import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newerRelease, stableVersion, ReleaseChecker, UPDATE_INTERVAL_MS } from '../src/cli-updates.ts';

test('stable release comparison handles numeric boundaries and refuses prerelease or unknown output', () => {
  assert.equal(newerRelease('codex-cli 0.99.0', '0.166.0'), true);
  assert.equal(newerRelease('2.1.288 (Claude Code)', '2.2.0'), true);
  assert.equal(newerRelease('1.0.0', '1.0.0'), false);
  assert.equal(newerRelease('2.0.0', '1.99.99'), false);
  for (const text of ['0.166.0-beta', 'unknown', '1.2', '1.2.3\ncommand', '99999999999999999999.1.1']) assert.equal(stableVersion(text), null);
  assert.equal(newerRelease('1.0.0-beta', '1.0.0'), false);
});

test('daily checks are shared, persist success and failure cooldown across restarts, and recover', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-releases-'));
  let now = 1000, calls = 0, fail = false;
  const latest = async () => { calls++; if (fail) throw new Error('offline'); return '1.2.3'; };
  try {
    let checker = new ReleaseChecker(home, latest, () => now);
    const [a, b] = await Promise.all([checker.refresh(), checker.refresh()]);
    assert.deepEqual(a, b); assert.equal(calls, 3);
    await checker.refresh(); assert.equal(calls, 3);
    checker = new ReleaseChecker(home, latest, () => now);
    await checker.refresh(); assert.equal(calls, 3);
    now += UPDATE_INTERVAL_MS; fail = true;
    await checker.refresh(); assert.equal(calls, 6);
    assert.deepEqual(checker.view()['codex-cli'], {latest:'1.2.3', checkedAt:now, failed:true});
    checker = new ReleaseChecker(home, latest, () => now);
    await checker.refresh(); assert.equal(calls, 6);
    now += UPDATE_INTERVAL_MS; fail = false;
    await checker.refresh(); assert.equal(calls, 9); assert.equal(checker.view().botons?.failed, false);
    now -= UPDATE_INTERVAL_MS * 2;
    await checker.refresh(); assert.equal(calls, 12, 'clock rollback cannot keep a future result fresh forever');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

import { startServer } from './helpers.ts';
test('release cache status is paired-owner only and GET never performs a registry lookup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-release-api-'));
  try {
    const checker = new ReleaseChecker(home, async () => '0.167.0');
    await checker.refresh();
    const s = await startServer({ home });
    try {
      assert.equal((await s.call('GET', '/api/brain-clis', undefined, null)).status, 401);
      const reply = await s.call('GET', '/api/brain-clis');
      assert.equal(reply.status, 200);
      assert.equal(reply.data.checks['codex-cli'].latest, '0.167.0');
    } finally { await s.stop(); }
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('polls schedule from completion so slow lookups still refresh the next day', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-release-timer-'));
  let now = 1000, calls = 0;
  let scheduled: (() => void) | null = null;
  const checker = new ReleaseChecker(home, async () => { now += 100; calls++; return '1.2.3'; }, () => now);
  try {
    checker.start((task, delay) => { assert.equal(delay, UPDATE_INTERVAL_MS); scheduled = task; return () => { scheduled = null; }; });
    const settle = async () => { for (let i = 0; i < 10 && !scheduled; i++) await new Promise(r => setImmediate(r)); assert.ok(scheduled); };
    await settle(); assert.equal(calls, 3);
    for (const count of [6, 9]) {
      now += UPDATE_INTERVAL_MS;
      const task = scheduled!; scheduled = null; task();
      await settle(); assert.equal(calls, count);
    }
    await checker.close(); assert.equal(scheduled, null);
  } finally { await checker.close(); rmSync(home, {recursive:true, force:true}); }
});

test('shutdown aborts and settles an active lookup, with no later requests or cache writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-release-close-'));
  let calls = 0;
  const checker = new ReleaseChecker(home, async (_id, signal) => {
    calls++;
    return await new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('stopped')), {once:true}));
  });
  try {
    const pending = checker.refresh();
    await checker.close(); await pending;
    assert.equal(calls, 1);
    assert.deepEqual(checker.view(), {});
    assert.deepEqual(await checker.refresh(), {});
    assert.equal(calls, 1);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(home, 'release-checks.json')), false);
  } finally { await checker.close(); rmSync(home, {recursive:true, force:true}); }
});
