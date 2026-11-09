import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileKind, formatSize, mimeType, PREVIEW_MAX_BYTES } from '../../shared/files.ts';
import { setUrlKeys } from '../../web/src/device.ts';
import { baseName, cleanupText, crumbsOf, joinPath, noPreviewReason, parentOf, PREVIEW_TOO_BIG, previewFailureOf, rawUrl, storageTotals, workspaceLink } from '../../web/src/files.ts';

const WS = '/home/you/.botons/workspaces/scout-ab12';

test('workspace links and paths: relative and workspace paths resolve, outside ones are kept for the server to refuse, web links are not files', () => {
  assert.equal(workspaceLink('reports/weekly.md', WS), 'reports/weekly.md');
  assert.equal(workspaceLink('./reports/weekly.md', WS), 'reports/weekly.md');
  assert.equal(workspaceLink('chart.png', WS, 'reports'), 'reports/chart.png');
  assert.equal(workspaceLink('../data.csv', WS, 'reports/2026'), 'reports/data.csv');
  assert.equal(workspaceLink('weekly%20notes.md#top', WS), 'weekly notes.md');
  assert.equal(workspaceLink(`${WS}/reports/weekly.md`, WS), 'reports/weekly.md');
  assert.equal(workspaceLink(`${WS}/`, WS), '');
  assert.equal(workspaceLink('/etc/passwd', WS), '/etc/passwd');
  assert.equal(workspaceLink('../../x', WS), '../../x');
  assert.equal(workspaceLink(`${WS}-other/x`, WS), `${WS}-other/x`);
  for (const href of ['https://example.com/a.md', 'mailto:you@example.com', '#section', '//cdn.example.com/x.png', 'data:image/png;base64,AA', '']) {
    assert.equal(workspaceLink(href, WS), null, href);
  }

  assert.deepEqual([joinPath('', 'a/./b//c'), joinPath('/a', '../../b'), joinPath('a', '../../b')], ['a/b/c', '/b', '../b']);
  assert.deepEqual([parentOf('reports/weekly.md'), parentOf('weekly.md'), parentOf('/etc')], ['reports', '', '/']);
  assert.equal(baseName('reports/weekly.md'), 'weekly.md');
  assert.deepEqual(crumbsOf('reports/2026'), [{ name: 'Workspace', path: '' }, { name: 'reports', path: 'reports' }, { name: '2026', path: 'reports/2026' }]);

  assert.equal(rawUrl('bot_1', 'inbox/a b.png'), '/api/bots/bot_1/files/raw?path=inbox%2Fa%20b.png');
  setUrlKeys({ events: 'dev_1.e', files: 'dev_1.f+/=' });
  try {
    assert.equal(rawUrl('bot_1', 'x.md', true), '/api/bots/bot_1/files/raw?path=x.md&download=1&key=dev_1.f%2B%2F%3D');
  } finally {
    setUrlKeys(null);
  }
});

test('file kinds: what is previewed; SVG and HTML are kinds of their own, never an image or text', () => {
  assert.equal(fileKind('.md'), 'other', 'a dot file has no extension');
  const kinds = ['reports/Weekly.MD', 'a.jpeg', 'a.pdf', 'server.log', 'a.svg', 'a.html', 'a.HTM', 'a.xhtml', 'a.zip'].map(fileKind);
  assert.deepEqual(kinds, ['markdown', 'image', 'pdf', 'text', 'svg', 'html', 'html', 'other', 'other']);
  assert.deepEqual([mimeType('a.svg'), mimeType('a.unknown')], ['image/svg+xml', 'application/octet-stream']);
  assert.deepEqual([5, 1536, 25 * 1024 * 1024].map(formatSize), ['5 B', '1.5 KB', '25 MB']);
});

test('a file the viewer cannot show says why, instead of a blank page', () => {
  assert.equal(noPreviewReason('design/directions.html', 130_000), null);
  assert.equal(noPreviewReason('logo.svg', null), null);
  assert.equal(noPreviewReason('notes.txt', 1000), null);
  assert.match(noPreviewReason('assets.zip', 2048) ?? '', /doesn't preview this kind of file/);
  assert.match(noPreviewReason('noext', 10) ?? '', /doesn't preview this kind of file/);
  assert.match(noPreviewReason('huge.html', PREVIEW_MAX_BYTES + 1) ?? '', /over 25 MB, too big to preview/);
  assert.match(noPreviewReason('big.log', 2 * 1024 * 1024) ?? '', /over 1 MB of text/);
});

test("the preview frame's failure message: only the error page's shape, by status, never the page's own text", () => {
  assert.match(previewFailureOf({ botonsPreview: 'failed', status: 404 })!, /moved or deleted/);
  assert.match(previewFailureOf({ botonsPreview: 'failed', status: 401 })!, /expired/);
  assert.equal(previewFailureOf({ botonsPreview: 'failed', status: 413 }), PREVIEW_TOO_BIG);
  assert.match(previewFailureOf({ botonsPreview: 'failed', status: 500 })!, /error 500/);
  for (const data of [null, 'failed', { botonsPreview: 'failed' }, { botonsPreview: 'failed', status: '404' }, { botonsPreview: 'failed', status: 200 }, { botonsPreview: 'failed', status: 404.5 }, { botonsPreview: 'ok', status: 404 }, { previewProbe: {} }]) {
    assert.equal(previewFailureOf(data), null, JSON.stringify(data));
  }
});

test('Settings → Storage adds up every file, and says when that or an inbox is a lot', () => {
  const boton = (name: string, workspaceBytes: number, inboxBytes = 0) => ({ botId: name, name, workspaceBytes, inboxBytes, trashBytes: 0, trashItems: 0 });
  const usage = (bots: ReturnType<typeof boton>[], sharedBytes = 0, trashBytes = 0) =>
    ({ bots, sharedBytes, trashBytes, sharedTrashBytes: 0, sharedTrashItems: 0, partial: false, inboxCleanupDays: 30, trashKeepDays: 30 });
  assert.deepEqual(storageTotals(usage([boton('Kevin', 100), boton('Bob', 50)], 10, 5)), { total: 165, big: false, fullInboxes: [] });
  assert.deepEqual(storageTotals(usage([boton('Kevin', 2 * 1024 ** 3, 1024 ** 3 + 1), boton('Bob', 1)])), { total: 2 * 1024 ** 3 + 1, big: true, fullInboxes: ['Kevin'] });
  assert.equal(storageTotals(usage([boton('Kevin', 5 * 1024 ** 3)], 1)).big, true);
  assert.deepEqual(storageTotals(usage([])), { total: 0, big: false, fullInboxes: [] });
  assert.equal(cleanupText(null), 'Cleanup off');
  assert.equal(cleanupText(7), 'Cleanup after 7 days');
  assert.equal(cleanupText(undefined), 'Cleanup after 30 days');
});
