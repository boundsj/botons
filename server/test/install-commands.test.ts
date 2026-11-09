import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCommand } from '../../shared/install-commands.ts';
import { installType } from '../src/install-type.ts';
for (const [type, expected] of [
  ['managed', '~/.local/bin/botons pair --approve 6JWB-823H'],
  ['docker', 'docker compose exec botons botons pair --approve 6JWB-823H'],
  ['service', 'npm run pair -- --approve 6JWB-823H'],
] as const) test(`command snapshot: ${type}`, () => {
  assert.equal(installCommand(type, 'pair', '--approve 6JWB-823H'), expected);
  assert.equal(installCommand(type, 'pair', '--access-mode tailscale'), expected.replace('--approve 6JWB-823H', '--access-mode tailscale'));
  assert.equal(installCommand(type, 'backup'), expected.split(' pair')[0] + ' backup');
});
test('release marker selects managed commands, Docker takes precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'botons-install-type-'));
  try {
    const app = join(root, 'releases/1.0.0'); mkdirSync(app, { recursive: true });
    assert.equal(installType(false, app), 'service');
    writeFileSync(join(root, 'installer.json'), '{}');
    assert.equal(installType(false, app), 'managed');
    assert.equal(installType(true, app), 'docker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('build instructions are supported for each install type', () => {
  assert.equal(installCommand('service', 'repair'), 'npm run build');
  assert.equal(installCommand('managed', 'repair'), '~/.local/bin/botons repair');
  assert.equal(installCommand('docker', 'repair'), 'docker compose up -d --build botons');
});
