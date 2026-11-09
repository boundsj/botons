// The parts of the web app that load when first opened (web/src/components/Deferred.tsx): the loader keeps a module
// once loaded and fetches again after a failure; while loading, the dialog, panel and screen stand-ins say so.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const out = tempDir();
const ENTRY = join(repo, 'web/src/deferred-entry.tsx');
const { build } = await import('vite');
await build({
  configFile: false,
  root: join(repo, 'web'),
  logLevel: 'silent',
  plugins: [
    {
      name: 'deferred-entry',
      resolveId: (id) => (id === ENTRY ? id : null),
      load: (id) =>
        id === ENTRY
          ? `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deferred, DeferredDialog, DeferredPanel, DeferredScreen } from './components/Deferred.tsx';
export { deferred };
const child = () => createElement('p', null, 'the part');
export const render = (kind, part) => renderToStaticMarkup(createElement(kind === 'dialog' ? DeferredDialog : kind === 'panel' ? DeferredPanel : DeferredScreen, { part, title: 'Settings', label: 'Kevin details', what: 'setup', onClose() {} }, child));
`
          : null,
    },
  ],
  ssr: { noExternal: true },
  build: { ssr: ENTRY, outDir: join(out, 'dist'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'entry.mjs' } } },
});
type Part = { load(): Promise<unknown>; loaded(): unknown };
const { deferred, render } = (await import(pathToFileURL(join(out, 'dist/entry.mjs')).href)) as {
  deferred: (load: () => Promise<unknown>) => Part;
  render: (kind: 'dialog' | 'panel' | 'screen', part: Part) => string;
};

test('a deferred part loads once, and fetches again after a failure', async () => {
  let calls = 0;
  let fail = true;
  const part = deferred(async () => {
    calls++;
    if (fail) throw new Error('Failed to fetch dynamically imported module');
    return { ok: true };
  });
  assert.equal(part.loaded(), undefined);
  await assert.rejects(part.load(), /Failed to fetch/);
  assert.equal(part.loaded(), undefined);
  fail = false;
  const [a, b] = await Promise.all([part.load(), part.load()]);
  assert.deepEqual(a, { ok: true });
  assert.equal(a, b);
  assert.equal(calls, 2);
  assert.equal(part.loaded(), a);
  await part.load();
  assert.equal(calls, 2);
});

test('while a part loads, its dialog, panel or screen says so; once loaded, the part itself renders', async () => {
  const pending = deferred(() => new Promise(() => {}));
  assert.match(render('dialog', pending), /<dialog class="dialog" aria-label="Settings">[\s\S]*<h2>Settings<\/h2>[\s\S]*role="status">Loading…<\/p>/);
  assert.match(render('panel', pending), /<aside class="panel" aria-label="Kevin details">[\s\S]*aria-label="Close panel"[\s\S]*role="status">Loading…/);
  assert.equal(render('screen', pending), '<div class="boot muted">Loading…</div>');
  const done = deferred(async () => ({}));
  await done.load();
  for (const kind of ['dialog', 'panel', 'screen'] as const) assert.equal(render(kind, done), '<p>the part</p>');
});
