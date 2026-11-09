// Which copy of a CLI Botons runs, and the one-line notes about it: path logic and text only, no CLI is run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isManagedBin, managedBin } from '../src/managed-clis.ts';
import { copyLine, terminalNote, updatedLine } from '../../shared/versions.ts';

test("Botons' own copy stays selected when the same system copy is named another way; another copy wins", () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-cli-copy-'));
  try {
    const root = join(home, 'managed'), sys = join(home, 'usr/bin'), other = join(home, 'opt/bin');
    const own = join(root, 'clis/codex-cli/releases/11111111-1111-1111-1111-111111111111/bin/codex');
    for (const dir of [sys, other]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o755 }); }
    symlinkSync(join(sys, 'codex'), join(other, 'codex-link'));
    writeFileSync(join(home, 'managed-clis.json'), JSON.stringify({ 'codex-cli': { bin: own, previous: 'codex' } }));
    assert.equal(managedBin(home, 'codex-cli', 'codex', root, sys), own);
    assert.equal(managedBin(home, 'codex-cli', join(sys, 'codex'), root, sys), own, 'the full path of the copy it replaced');
    assert.equal(managedBin(home, 'codex-cli', join(other, 'codex-link'), root, sys), own, 'a link to that copy');
    assert.equal(managedBin(home, 'codex-cli', join(other, 'codex'), root, sys), join(other, 'codex'), 'a different copy is an explicit choice');
    assert.equal(isManagedBin(own, 'codex-cli', root), true);
    assert.equal(isManagedBin(join(root, 'clis/claude/bin/claude'), 'claude-cli', root), true, "the installer's copy");
    assert.equal(isManagedBin(join(sys, 'codex'), 'codex-cli', root), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('copy, update and terminal lines', () => {
  const own = { managed: true, terminal: 'codex-cli 0.160.0' };
  assert.equal(updatedLine('codex-cli', 'codex-cli 0.167.0'), 'Botons now uses its own Codex 0.167.0.');
  assert.equal(updatedLine('claude-cli', '2.1.3 (Claude Code)'), 'Botons now uses its own Claude Code 2.1.3.');
  assert.equal(copyLine('codex-cli 0.167.0', own), "Botons' own copy 0.167.0");
  assert.equal(copyLine('2.1.3 (Claude Code)', { managed: false, terminal: null }), 'System copy 2.1.3');
  assert.equal(copyLine(null, { managed: false, terminal: null }), null, 'not installed');
  assert.equal(terminalNote('codex-cli', 'codex-cli 0.167.0', own), 'Your terminal’s codex is still 0.160.0. Run codex update there if you want it updated too.');
  assert.equal(terminalNote('claude-cli', '2.1.3 (Claude Code)', { managed: true, terminal: '2.0.9 (Claude Code)' }), 'Your terminal’s claude is still 2.0.9. Run claude update there if you want it updated too.');
  assert.equal(terminalNote('codex-cli', 'codex-cli 0.160.0', own), null, 'the same version');
  assert.equal(terminalNote('codex-cli', 'codex-cli 0.150.0', own), null, 'a newer terminal copy');
  assert.equal(terminalNote('codex-cli', 'codex-cli 0.167.0', { ...own, managed: false }), null, 'Botons runs the system copy');
});
