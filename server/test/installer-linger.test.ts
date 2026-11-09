import { test } from 'node:test';
import assert from 'node:assert/strict';
// JavaScript bootstrap modules must also run before managed Node is available.
import { configureLinger } from '../../installer/linger.mjs';

function fixture(replies: { status: number; stdout?: string; stderr?: string }[], declinedAt = 0) {
  const calls: [string, string[]][] = [];
  const prompts: string[] = [];
  const output: string[] = [];
  return { calls, prompts, output, hooks: {
    user: 'sam', log: (message: string) => output.push(message),
    execute: (cmd: string, args: string[]) => { calls.push([cmd, args]); assert.ok(replies.length, 'unexpected command'); return replies.shift()!; },
  }, ask: async (message: string) => { prompts.push(message); if (prompts.length === declinedAt) throw new Error('Cancelled'); } };
}
const off = { status: 0, stdout: 'Linger=no\n' };
const denied = { status: 1, stderr: 'Failed to execute /usr/bin/pkttyagent: No such file or directory\nCould not enable linger: Access denied' };

test('linger already enabled skips both consent and enable commands', async () => {
  const f = fixture([{ status: 0, stdout: 'Linger=yes\n' }]);
  assert.equal(await configureLinger({}, f.ask, f.hooks), true);
  assert.deepEqual(f.calls, [['loginctl', ['show-user', 'sam', '-p', 'Linger']]]);
  assert.equal(f.prompts.length, 0);
});
test('linger succeeds without sudo after consent', async () => {
  const f = fixture([off, { status: 0 }]);
  assert.equal(await configureLinger({}, f.ask, f.hooks), true);
  assert.deepEqual(f.calls[1], ['loginctl', ['enable-linger']]);
  assert.equal(f.prompts.length, 1);
});
test('polkit failure offers exact sudo command with explicit user', async () => {
  const f = fixture([off, denied, { status: 0 }]);
  assert.equal(await configureLinger({}, f.ask, f.hooks), true);
  assert.deepEqual(f.calls[2], ['sudo', ['loginctl', 'enable-linger', 'sam']]);
  assert.equal(f.prompts[1], 'Run exactly: sudo loginctl enable-linger sam');
  assert.ok(f.output.includes('sudo loginctl enable-linger sam'));
});
test('declined linger leaves service alone and prints fix', async () => {
  const f = fixture([off], 1);
  assert.equal(await configureLinger({}, f.ask, f.hooks), false);
  assert.equal(f.calls.length, 1);
  assert.match(f.output.join('\n'), /remains enabled and running/);
  assert.match(f.output.join('\n'), /sudo loginctl enable-linger sam/);
});
test('no-sudo prints fallback without invoking sudo', async () => {
  const f = fixture([off, denied]);
  assert.equal(await configureLinger({ noSudo: true }, f.ask, f.hooks), false);
  assert.equal(f.calls.length, 2);
  assert.match(f.output.join('\n'), /--no-sudo/);
});
test('sudo failure and declined sudo consent are nonfatal with recovery guidance', async () => {
  for (const declinedAt of [0, 2]) {
    const f = fixture([off, denied, { status: 1, stderr: 'Access denied' }], declinedAt);
    assert.equal(await configureLinger({}, f.ask, f.hooks), false);
    assert.match(f.output.join('\n'), /will not survive logout\/reboot/);
  }
});
