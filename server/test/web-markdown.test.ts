// Markdown in the chat (web/src/components/Markdown.tsx), rendered in Node: Vite bundles the component for SSR into a
// temp folder and react-dom/server renders it.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';

const repo = resolve(import.meta.dirname, '../..');
const out = tempDir();
// A virtual entry, resolved as if it sat in web/src so its imports find the web app's packages.
const ENTRY = join(repo, 'web/src/markdown-render-entry.tsx');
const { build } = await import('vite');
await build({
  configFile: false,
  root: join(repo, 'web'),
  logLevel: 'silent',
  plugins: [
    {
      name: 'markdown-entry',
      resolveId: (id) => (id === ENTRY ? id : null),
      load: (id) =>
        id === ENTRY
          ? `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './components/Markdown.tsx';
export const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));
`
          : null,
    },
  ],
  // Bundle React too: the output sits in a temp folder with no node_modules.
  ssr: { noExternal: true },
  build: { ssr: ENTRY, outDir: join(out, 'dist'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'entry.mjs' } } },
});
const { render } = (await import(pathToFileURL(join(out, 'dist/entry.mjs')).href)) as { render: (text: string) => string };

test('a table keeps its header cells as column headers, without a <thead>', () => {
  const html = render('| Item | Status |\n| :--- | ---: |\n| build | done |\n| deploy | open |\n');
  // Chrome holds an object for every <thead> inserted until the page closes; a chat remounts its tables on every switch.
  assert.doesNotMatch(html, /<thead|<tfoot/);
  assert.equal(
    html,
    '<div class="md"><table><tbody><tr><th scope="col" style="text-align:left">Item</th><th scope="col" style="text-align:right">Status</th></tr></tbody>' +
      '<tbody><tr><td style="text-align:left">build</td><td style="text-align:right">done</td></tr><tr><td style="text-align:left">deploy</td><td style="text-align:right">open</td></tr></tbody></table></div>',
  );
});

test('GitHub-flavored Markdown renders: strikethrough, task lists, autolinks and footnotes', () => {
  assert.equal(render('~~gone~~ and ~also~'), '<div class="md"><p><del>gone</del> and <del>also</del></p></div>');
  assert.equal(
    render('- [ ] todo\n- [x] done'),
    '<div class="md"><ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled=""/> todo</li>\n<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>\n</ul></div>',
  );
  assert.match(render('see www.example.com'), /<a href="http:\/\/www.example.com" target="_blank" rel="noreferrer noopener">www.example.com<\/a>/);
  const note = render('Note[^1]\n\n[^1]: The footnote.');
  assert.match(note, /<sup><a id="user-content-fnref-1" data-footnote-ref="true"[^>]* href="#user-content-fn-1"/);
  assert.match(note, /<section data-footnotes="true" class="footnotes">[\s\S]*<li id="user-content-fn-1">/);
});
