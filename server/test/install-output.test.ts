import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, summary, installOutput } from '../../installer/output.mjs';
import { report, isProblem, type Finding } from '../../scripts/doctor.ts';

test('clean install transcript stays short and uses the immediate command', () => {
  const transcript = plan('install', 'codex', 'linux') + '\nContinue? [Y/n]\n✓ Runtime and brains ready (2s)\n✓ Botons and backups installed (5s)\n✓ Setup ready (6s)\n' + summary({ command: '/tmp/example-user/.local/bin/botons', url: 'http://127.0.0.1:7777' });
  assert.equal(transcript, `• Set up Node 24 for Botons (system Node untouched).
• Install missing sandbox tools, including bubblewrap (sudo).
• Start Botons at boot (linger), configure backups and PATH.
• Install codex if missing; sign in later in setup.
Continue? [Y/n]
✓ Runtime and brains ready (2s)
✓ Botons and backups installed (5s)
✓ Setup ready (6s)
Botons is running! 🐾
  Open http://127.0.0.1:7777
  Approve your browser’s code: /tmp/example-user/.local/bin/botons pair --approve <code>
  Pick a brain in the setup screen — it can update Codex and fix config links for you.`);
});
for (const [name, check, message, status] of [
  ['missing brain', 'agent CLIs', 'No agent CLI can run turns, so no Boton can answer', 'info'],
  ['codex update', 'agent CLIs', 'codex: needs update', 'warn'],
  ['symlink', 'Codex config', 'Symlinked protected config paths: /tmp/example-user/.codex/AGENTS.md', 'warn'],
  ['failure', 'database', 'Cannot read database', 'fail'],
] as const) test(`doctor transcript: ${name}`, () => {
  const finding: Finding = { check, message, status, fix: 'Detailed repair instructions' };
  const expected = name === 'failure';
  assert.equal(isProblem(finding), expected);
  assert.equal(report([finding]), `${expected ? 'Server' : 'Brains'}\n  ${expected ? '✗' : '•'} ${check}: ${name === 'symlink' ? 'Review Codex config links in Settings → Brains' : message}\n${expected ? '1 problem, 0 next steps.' : '0 problems, 1 next step.'} Details: doctor --verbose.`);
  assert.match(report([finding], true), /Detailed repair instructions/);
});
test('non-TTY and NO_COLOR output stays plain; log rotates and failure has only the tail', () => {
  const old = process.env.NO_COLOR;
  process.env.NO_COLOR = '';
  try { assert.doesNotMatch(report([{ check: 'server', status: 'ok', message: 'Running' }]), /\x1b/); }
  finally { if (old === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = old; }
  const dir = mkdtempSync(join(tmpdir(), 'botons-output-'));
  try {
    const path = join(dir, 'install.log');
    const first = installOutput(path); first.detail('old run');
    const next = installOutput(path); for (let i = 0; i < 30; i++) next.detail(`line ${i}`);
    assert.equal(readFileSync(path + '.1', 'utf8'), 'old run\n');
    assert.equal(next.failure().split('\n').length, 21);
    assert.match(next.failure(), /^line 10\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subprocess log writes append without overwriting command details', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botons-log-'));
  try {
    const path = join(dir, 'install.log'); const out = installOutput(path);
    out.detail('EXACT COMMAND AND IMPORTANT DETAIL');
    spawnSync(process.execPath, ['-e', "console.log('child stdout'); console.error('child stderr')"], { stdio: out.stdio });
    out.detail('finished');
    assert.equal(readFileSync(path, 'utf8'), 'EXACT COMMAND AND IMPORTANT DETAIL\nchild stdout\nchild stderr\nfinished\n');
    rmSync(path); assert.match(out.failure(), /Log unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('summary keeps start and boot persistence next steps visible', () => {
  assert.match(summary({ url: 'http://localhost:7777', running: false }), /Start Botons: botons serve/);
  assert.match(summary({ url: 'http://localhost:7777', bootReady: false }), /Start at boot: sudo loginctl enable-linger/);
});

test('macOS plan describes login persistence and unavailable Workspace sandbox', () => {
  const text = plan('install', undefined, 'darwin');
  assert.match(text, /Full computer access/);
  assert.match(text, /at login with a LaunchAgent/);
  assert.doesNotMatch(text, /sudo|linger|at boot/);
});
