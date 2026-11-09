import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installerRevision } from '../../installer/revision.mjs';

test('cached bootstrap prints only the resolved commit and a code fingerprint', () => {
  const cache = mkdtempSync(join(tmpdir(), 'botons-revision-'));
  try {
    const root = join(cache, 'node_modules/getbotons');
    mkdirSync(join(root, 'installer'), { recursive: true });
    writeFileSync(join(root, 'installer/botons.mjs'), 'console.log("ready");');
    const sha = 'a'.repeat(40);
    writeFileSync(join(cache, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/getbotons': { resolved: `git+https://user:secret@example.com/botons.git#${sha}` } } }));
    const first = installerRevision(root);
    assert.match(first, new RegExp(`commit ${sha}, fingerprint [a-f0-9]{64}$`));
    assert.doesNotMatch(first, /secret|example.com|user/);
    writeFileSync(join(root, 'installer/botons.mjs'), readFileSync(join(root, 'installer/botons.mjs'), 'utf8') + '\n// changed');
    assert.notEqual(installerRevision(root), first);
    writeFileSync(join(cache, 'package-lock.json'), 'invalid');
    assert.match(installerRevision(root), /commit unavailable, fingerprint [a-f0-9]{64}$/);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
