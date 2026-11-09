import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Botons is MIT. What ships (the server's dependencies and the web bundle's) must be permissive; build and test
// tools may also be weak copyleft, since none of their code is in what Botons publishes. A new license needs a
// look first: add it here only once it is known to fit.
const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', '(MIT OR CC0-1.0)']);
const DEV_ONLY = new Set(['MPL-2.0']);

test('every dependency in the lockfile has a license that fits an MIT project', () => {
  const lock = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package-lock.json'), 'utf8'));
  const problems: string[] = [];
  for (const [path, pkg] of Object.entries<{ license?: string; dev?: boolean; link?: boolean }>(lock.packages)) {
    if (pkg.link) continue; // the workspaces, checked below as packages
    const license = pkg.license ?? 'none';
    if (!PERMISSIVE.has(license) && !(pkg.dev && DEV_ONLY.has(license))) problems.push(`${path || '(root)'}: ${license}${pkg.dev ? ' (dev)' : ''}`);
  }
  assert.deepEqual(problems, []);
  assert.equal(lock.packages[''].license, 'MIT');
});
