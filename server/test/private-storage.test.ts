import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privatePaths } from '../src/isolation.ts';
import { tempDir } from './helpers.ts';

/**
 * A Workspace turn's CLI gets its private paths once, as it starts. A folder of the data folder made only later (the
 * first backup, say, by the timer) must already be on that list, or the running turn could read what it then holds.
 */
test("the data folder's private storage is on a Workspace turn's private paths before anything is in it", () => {
  const root = tempDir('botons-private-storage-');
  const home = join(root, 'botons');
  const own = join(home, 'workspaces', 'kevin');
  mkdirSync(own, { recursive: true });
  mkdirSync(join(home, 'shared'));
  writeFileSync(join(home, 'botons.db'), '');
  const listed = privatePaths({ workspace: own, cli: 'claude', botonsHome: home, workspacesDir: join(home, 'workspaces'), userHome: join(root, 'user'), env: {}, shared: [join(home, 'shared')] });
  for (const name of ['backups', 'trash', 'run', 'browser', 'api-sessions', 'templates', 'skill-packages']) {
    assert.ok(listed.includes(join(home, name)), `${name} is private before it holds anything`);
    // Made, so a CLI's sandbox can mask it, and only the server's user may enter it.
    assert.equal(statSync(join(home, name)).mode & 0o777, 0o700, name);
  }
  assert.ok(!listed.includes(own) && !listed.includes(join(home, 'shared')));
});

/**
 * A folder that can't be reserved (no space for it, no permission, a file in its place) must not leave a gap on the
 * list that the folder, made later, falls into: the turn doesn't start instead.
 */
test("a Workspace turn doesn't start when the data folder's private storage can't be reserved", () => {
  const root = tempDir('botons-private-storage-fail-');
  const home = join(root, 'botons');
  const own = join(home, 'workspaces', 'kevin');
  mkdirSync(own, { recursive: true });
  const list = () => privatePaths({ workspace: own, cli: 'claude', botonsHome: home, workspacesDir: join(home, 'workspaces'), userHome: join(root, 'user'), env: {}, shared: [] });

  // Not makeable: the data folder can't be written (as when the disk is full, the mkdir fails).
  if (process.getuid?.() !== 0) {
    chmodSync(home, 0o500);
    try {
      assert.throws(list, /could not make .*backups.*private paths before it starts \(EACCES\)/);
    } finally {
      chmodSync(home, 0o700);
    }
  }

  // A file where a folder should be.
  writeFileSync(join(home, 'trash'), '');
  assert.throws(list, /trash is not a folder/);
  rmSync(join(home, 'trash'));

  // A folder of the owner's linked there is listed by its link and where it really is.
  const elsewhere = join(root, 'big-disk', 'backups');
  mkdirSync(elsewhere, { recursive: true });
  rmSync(join(home, 'backups'), { recursive: true });
  symlinkSync(elsewhere, join(home, 'backups'));
  const listed = list();
  assert.ok(listed.includes(join(home, 'backups')) && listed.includes(realpathSync(elsewhere)), listed.join('\n'));
});

