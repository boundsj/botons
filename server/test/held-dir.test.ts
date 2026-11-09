import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { readWorkspaceFile, WorkspaceFileError } from '../src/cli/workspace-file.ts';
import { heldLookups, holdDir, NoHeldLookups, under, useHeldLookups } from '../src/held-dir.ts';
import { snapshotInstructions } from '../src/instructions.ts';
import { NO_LINKS, receiveUpload, saveNewFile, usePlaceLink } from '../src/files.ts';
import { HttpError } from '../src/store.ts';
import { tempDir } from './helpers.ts';

/**
 * A Workspace Boton's sandboxed shell runs while `botons ... --file` reads outside the sandbox, so the folders on the way
 * to the file can change between any two of the reader's own steps. Here they change at every one: before and after
 * each realpath, open and stat, `sub` flips between the real folder and a link to a private one.
 */
test('readWorkspaceFile reads only through the folders it checked, however they change around each step', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, () => {
  const root = tempDir('botons-wsfile-race-');
  const ws = join(root, 'ws');
  const priv = join(root, 'private');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  mkdirSync(priv);
  writeFileSync(join(ws, 'sub', 'notes.md'), 'inside');
  writeFileSync(join(priv, 'notes.md'), 'PRIVATE-MARKER');
  const real = join(ws, 'sub');
  const parked = join(ws, 'parked');
  let linked = false;
  const flip = () => {
    if (linked) {
      unlinkSync(real);
      renameSync(parked, real);
    } else {
      renameSync(real, parked);
      symlinkSync(priv, real);
    }
    linked = !linked;
  };
  // The path-taking calls (fstat takes the descriptor).
  const names = ['realpathSync', 'openSync', 'statSync', 'lstatSync'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, fs[n]]));
  // Every schedule of flips: before or after each call, for the first few calls.
  for (let schedule = 0; schedule < 1 << 9; schedule++) {
    let step = 0;
    const at = () => {
      if (schedule & (1 << step++)) flip();
    };
    for (const n of names) {
      (fs as unknown as Record<string, unknown>)[n] = (...a: unknown[]) => {
        at();
        try {
          return (saved[n] as (...x: unknown[]) => unknown)(...a);
        } finally {
          at();
        }
      };
    }
    syncBuiltinESMExports();
    let got: string | Error;
    try {
      got = readWorkspaceFile(join(ws, 'sub', 'notes.md'), ws);
    } catch (e) {
      got = e as Error;
    } finally {
      Object.assign(fs, saved);
      syncBuiltinESMExports();
      if (linked) flip();
    }
    assert.notEqual(got, 'PRIVATE-MARKER', `schedule ${schedule.toString(2)} read the private file`);
    if (typeof got === 'string') assert.equal(got, 'inside');
  }
  // Without changes, the file reads as before.
  assert.equal(readWorkspaceFile(join(ws, 'sub', 'notes.md'), ws), 'inside');
});

/**
 * An upload is linked into the inbox, then its temp file removed; if the Boton swaps the inbox for a link to a folder of
 * the owner's right then, a check of the placed file by path would find (and remove) the owner's file of that name.
 */
test('an upload is placed in the inbox it was written to, and nothing outside is touched when the inbox is swapped', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const root = tempDir('botons-upload-swap-');
  const ws = join(root, 'ws');
  const outside = join(root, 'owner-folder');
  mkdirSync(join(ws, 'inbox'), { recursive: true });
  mkdirSync(outside);
  // Its name is the day's date and the file's: one for each day this could run on.
  const days = [-1, 0, 1].map((d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10));
  for (const d of days) writeFileSync(join(outside, `${d}-notes.txt`), 'OWNER-FILE');
  const unlink = fsp.unlink;
  let swapped = false;
  fsp.unlink = async (...a: Parameters<typeof unlink>) => {
    await unlink(...a);
    if (!swapped) {
      swapped = true;
      renameSync(join(ws, 'inbox'), join(ws, 'inbox-moved'));
      symlinkSync(outside, join(ws, 'inbox'));
    }
  };
  syncBuiltinESMExports();
  const req = Object.assign(Readable.from([Buffer.from('uploaded')]), { headers: { 'content-type': 'application/octet-stream' }, complete: true });
  try {
    const ref = await receiveUpload(req as never, ws, 'notes.txt', 'UTC');
    assert.equal(readFileSync(join(ws, 'inbox-moved', ref.name), 'utf8'), 'uploaded');
  } catch (e) {
    // Refusing is fine too; touching the owner's folder is not.
    assert.ok(e instanceof Error);
  } finally {
    fsp.unlink = unlink;
    syncBuiltinESMExports();
  }
  assert.ok(swapped);
  for (const d of days) assert.equal(existsSync(join(outside, `${d}-notes.txt`)) && readFileSync(join(outside, `${d}-notes.txt`), 'utf8'), 'OWNER-FILE');
  assert.deepEqual(readdirSync(outside).length, 3);
});

/**
 * Where a name can't be looked up in an open folder, every step would go by path again, and a swap between two of them
 * (the folder flipped after it is opened, back after the file is, flipped again for a check) redirects it. So nothing
 * reads, writes or puts back through a folder a Boton could swap: it refuses, whatever happens around it.
 */
test('without lookups in an open folder, reading a workspace file, a held lookup and an instruction snapshot all refuse', async () => {
  const root = tempDir('botons-wsfile-nolookups-');
  const ws = join(root, 'ws');
  const priv = join(root, 'private');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  mkdirSync(priv);
  writeFileSync(join(ws, 'sub', 'notes.md'), 'inside');
  writeFileSync(join(priv, 'notes.md'), 'PRIVATE-MARKER');
  const real = join(ws, 'sub');
  const parked = join(ws, 'parked');
  let linked = false;
  const flip = () => {
    if (linked) {
      unlinkSync(real);
      renameSync(parked, real);
    } else {
      renameSync(real, parked);
      symlinkSync(priv, real);
    }
    linked = !linked;
  };
  const names = ['realpathSync', 'openSync', 'statSync', 'lstatSync'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const originalLookups = heldLookups;
  let opened = 0;
  useHeldLookups(false);
  try {
    for (let schedule = 0; schedule < 1 << 9; schedule++) {
      let step = 0;
      const at = () => {
        if (schedule & (1 << step++)) flip();
      };
      for (const n of names) {
        (fs as unknown as Record<string, unknown>)[n] = (...a: unknown[]) => {
          if (n === 'openSync') opened++;
          at();
          try {
            return (saved[n] as (...x: unknown[]) => unknown)(...a);
          } finally {
            at();
          }
        };
      }
      syncBuiltinESMExports();
      let got: string | Error;
      try {
        got = readWorkspaceFile(join(ws, 'sub', 'notes.md'), ws);
      } catch (e) {
        got = e as Error;
      } finally {
        Object.assign(fs, saved);
        syncBuiltinESMExports();
        if (linked) flip();
      }
      assert.ok(got instanceof WorkspaceFileError, `schedule ${schedule.toString(2)} read ${String(got)}`);
      assert.match(got.message, /needs Linux/);
    }
    assert.equal(opened, 0, 'nothing was opened');
    const top = holdDir(ws);
    try {
      assert.throws(() => under(top, 'sub'), NoHeldLookups);
    } finally {
      fs.closeSync(top.fd);
    }
    await assert.rejects(snapshotInstructions(ws), NoHeldLookups);
  } finally {
    useHeldLookups(originalLookups);
  }
  if (originalLookups) assert.equal(readWorkspaceFile(join(ws, 'sub', 'notes.md'), ws), 'inside');
});

const upload = (body: string) => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/octet-stream' }, complete: true });

test('without lookups in an open folder, an upload and a saved file refuse before anything is written', async () => {
  const ws = join(tempDir('botons-upload-nolookups-'), 'ws');
  mkdirSync(join(ws, 'inbox'), { recursive: true });
  mkdirSync(join(ws, 'shots'));
  const originalLookups = heldLookups;
  useHeldLookups(false);
  try {
    await assert.rejects(receiveUpload(upload('uploaded') as never, ws, 'notes.txt', 'UTC'), (e: Error) => e instanceof HttpError && e.status === 501);
    await assert.rejects(saveNewFile(ws, 'shots', 'x', 'page.png', Buffer.from('png')), (e: Error) => e instanceof HttpError && e.status === 501);
  } finally {
    useHeldLookups(originalLookups);
  }
  assert.deepEqual(readdirSync(join(ws, 'inbox')), []);
  assert.deepEqual(readdirSync(join(ws, 'shots')), []);
});

/**
 * Putting the finished file in place must never replace one: the Boton may create (or link) a file at the very name in
 * between any check and the step. A link() there fails, and the next name is taken; on a filesystem without hard
 * links nothing is put in place at all (a check, then rename(), would replace what the racer put there).
 */
test("placing a file never replaces one a racer put at its name, and a filesystem without hard links saves nothing", { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const ws = join(tempDir('botons-place-race-'), 'ws');
  mkdirSync(join(ws, 'shots'), { recursive: true });
  // The racer: a file of the owner's, linked in at the first name just before the server's step.
  try {
    usePlaceLink(async (from, to) => {
      if (!existsSync(join(ws, 'shots', 'x-page.png'))) writeFileSync(join(ws, 'shots', 'x-page.png'), 'RACER');
      await fsp.link(from, to);
    });
    const ref = await saveNewFile(ws, 'shots', 'x', 'page.png', Buffer.from('png'));
    assert.equal(ref.name, 'x-page-2.png');
    assert.equal(readFileSync(join(ws, 'shots', 'x-page.png'), 'utf8'), 'RACER');

    // No hard links: refused, the racer's file untouched, no temp file left.
    usePlaceLink(async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    await assert.rejects(saveNewFile(ws, 'shots', 'x', 'page.png', Buffer.from('png')), (e: Error) => e instanceof HttpError && e.status === 507 && e.message === NO_LINKS);
    await assert.rejects(receiveUpload(upload('uploaded') as never, ws, 'notes.txt', 'UTC'), (e: Error) => e instanceof HttpError && e.status === 507);
  } finally {
    usePlaceLink(null);
  }
  assert.deepEqual(readdirSync(join(ws, 'shots')).sort(), ['x-page-2.png', 'x-page.png']);
  assert.equal(readFileSync(join(ws, 'shots', 'x-page.png'), 'utf8'), 'RACER');
  assert.deepEqual(readdirSync(join(ws, 'inbox')), []);
});

test('upload cleanup stays in the held inbox when its pathname becomes an outside symlink', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const root = tempDir('botons-upload-sweep-');
  const ws = join(root, 'ws');
  const inbox = join(ws, 'inbox');
  const outside = join(root, 'outside');
  const parked = join(ws, 'parked');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outside);
  const name = '.upload-1234567890abcdef.part';
  for (const dir of [inbox, outside]) {
    writeFileSync(join(dir, name), 'stale marker');
    fs.utimesSync(join(dir, name), 0, 0);
  }
  const original = fsp.readdir;
  let swapped = false;
  fsp.readdir = (async (...args: Parameters<typeof fsp.readdir>) => {
    const names = await original(...args);
    if (!swapped && (args[0] === inbox || /^\/proc\/self\/fd\/\d+$/.test(String(args[0])))) {
      swapped = true;
      renameSync(inbox, parked);
      symlinkSync(outside, inbox);
    }
    return names;
  }) as typeof fsp.readdir;
  syncBuiltinESMExports();
  try {
    const req = Readable.from([Buffer.from('hello')]);
    Object.assign(req, { headers: { 'content-type': 'application/octet-stream' }, complete: true });
    await receiveUpload(req as import('node:http').IncomingMessage, ws, 'hello.txt', 'UTC').catch(() => {});
    assert.equal(swapped, true);
    assert.equal(readFileSync(join(outside, name), 'utf8'), 'stale marker');
    assert.equal(existsSync(join(parked, name)), false, 'the stale part in the held inbox is cleaned');
  } finally {
    fsp.readdir = original;
    syncBuiltinESMExports();
  }
});
