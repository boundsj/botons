import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { configurePath, removePathBlock, onPath } from '../../installer/shell-path.mjs';

test('PATH already includes local bin: no prompt or profile changes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
  try {
    assert.equal(onPath(home, '/usr/bin:' + join(home, '.local/bin')), true);
    assert.equal(await configurePath({ home, path: join(home, '.local/bin') }, async () => { assert.fail('unexpected prompt'); }), true);
    assert.equal(existsSync(join(home, '.profile')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('Debian login profile already adds local bin: no prompt or rc edit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
  try {
    const text = 'if [ -d "$HOME/.local/bin" ]; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n';
    writeFileSync(join(home, '.profile'), text);
    assert.equal(await configurePath({ home, shell: '/bin/bash', path: '/usr/bin' }, async () => { assert.fail('unexpected prompt'); }), false);
    assert.equal(existsSync(join(home, '.bashrc')), false);
    assert.equal(readFileSync(join(home, '.profile'), 'utf8'), text);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
for (const [shell, file] of [['/bin/bash', '.bashrc'], ['/bin/zsh', '.zshrc'], ['/bin/sh', '.profile']]) {
  test(`consented PATH addition for ${shell} is idempotent and removable`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
    try {
      const original = '# existing configuration\n';
      writeFileSync(join(home, file), original);
      let prompts = 0;
      const ask = async (message: string, yes?: boolean) => { prompts++; assert.ok(message.includes(file)); assert.equal(yes, true); };
      const options = { home, shell, path: '/usr/bin', yes: true };
      await configurePath(options, ask);
      const added = readFileSync(join(home, file), 'utf8');
      assert.match(added, /# >>> botons PATH >>>/);
      await configurePath(options, ask);
      assert.equal(prompts, 1);
      assert.equal(readFileSync(join(home, file), 'utf8'), added);
      const shellCheck = spawnSync('/bin/sh', ['-c', '. "$1"; . "$1"; printf "%s" "$PATH"', 'sh', join(home, file)], { env: { HOME: home, PATH: '/usr/bin' }, encoding: 'utf8' });
      assert.equal(shellCheck.status, 0, shellCheck.stderr);
      assert.equal(shellCheck.stdout, join(home, '.local/bin') + ':/usr/bin');
      removePathBlock(home);
      assert.equal(readFileSync(join(home, file), 'utf8'), original);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
test('declined PATH edit preserves the rc file and still allows installation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
  try {
    writeFileSync(join(home, '.bashrc'), '# keep\n');
    assert.equal(await configurePath({ home, shell: '/bin/bash' }, async () => { throw new Error('Cancelled'); }, () => {}), false);
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# keep\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('PATH consent preserves edits made while waiting and rechecks a newly added marker', async () => {
  for (const addMarker of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
    try {
      const rc = join(home, '.bashrc');
      writeFileSync(rc, '# before\n');
      await configurePath({ home, shell: '/bin/bash' }, async () => {
        appendFileSync(rc, '# owner edit\n' + (addMarker ? '# >>> botons PATH >>>\n# owner setup\n' : ''));
      });
      const text = readFileSync(rc, 'utf8');
      assert.ok(text.startsWith('# before\n# owner edit\n'));
      assert.equal(text.split('# >>> botons PATH >>>').length - 1, 1);
      if (addMarker) assert.equal(text, '# before\n# owner edit\n# >>> botons PATH >>>\n# owner setup\n');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});
test('unreadable login profile or rc file warns without aborting installation', async () => {
  for (const file of ['.profile', '.bashrc']) {
    const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
    try {
      mkdirSync(join(home, file)); // Deterministic read failure even when the tests run as root.
      const output: string[] = [];
      assert.equal(await configurePath({ home, shell: '/bin/bash' }, async () => { assert.fail('unexpected consent'); }, line => output.push(line)), false);
      assert.match(output.join('\n'), /PATH setup skipped/);
      assert.match(output.join('\n'), /~\/\.local\/bin\/botons/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('uninstall shell cleanup warns per unreadable file and continues cleaning others', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botons-path-'));
  try {
    for (const shell of ['/bin/bash', '/bin/zsh']) await configurePath({ home, shell }, async () => {});
    mkdirSync(join(home, '.profile'));
    const output: string[] = [];
    removePathBlock(home, line => output.push(line));
    for (const file of ['.bashrc', '.zshrc']) assert.doesNotMatch(readFileSync(join(home, file), 'utf8'), /# >>> botons PATH >>>/);
    assert.match(output.join('\n'), /Could not remove.*\.profile/);
    assert.match(output.join('\n'), /manually/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
