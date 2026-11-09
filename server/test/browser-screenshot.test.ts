import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileRef, Message, MessageMeta } from '../../shared/types.ts';
import { sharedImage } from '../../web/src/files.ts';
import { deliverScreenshot, type ShareFile } from '../src/browser-screenshot.ts';
import { formatResult } from '../src/cli/browser-mcp.ts';

const SAVED: FileRef = { name: '2026-01-01T00-00-00-000Z-page.png', path: 'browser-screenshots/2026-01-01T00-00-00-000Z-page.png', size: 2048, type: 'image/png' };
const PAGE = { url: 'https://example.com/', title: 'Example Domain' };

const message = (meta: MessageMeta | null): Message =>
  ({ id: 'msg_1', botId: 'bot_1', role: 'event', text: `Shared ${SAVED.path}`, meta, createdAt: '2026-01-01T00:00:00.000Z' }) as Message;

/** As the engine's shareFile records it: a file.shared message holding the file. */
const recording: ShareFile = async (_bot, path, title) => {
  const file = { ...SAVED, path };
  return { message: message({ kind: 'file.shared', file: { ...file, title } }), file };
};

test('a screenshot the chat recorded is said to be shown, and the recorded message renders as its image', async () => {
  const calls: unknown[] = [];
  const r = await deliverScreenshot(async (...a) => (calls.push(a), recording(...a)), 'bot_1', SAVED, PAGE);
  assert.deepEqual(calls, [['bot_1', SAVED.path, 'Browser: Example Domain']]);
  assert.equal(r.outcome, 'done');
  assert.equal(r.shown, true);
  assert.deepEqual(r.file, SAVED);
  assert.match(formatResult(r), /it is shown in your chat/);

  // What the chat shows for that message: the PNG itself, opening the workspace copy by its path.
  const shared = await recording('bot_1', SAVED.path, 'Browser: Example Domain');
  assert.deepEqual(sharedImage(shared.message!), { ...SAVED, title: 'Browser: Example Domain' });
});

test('a screenshot the chat did not record names its workspace copy and never claims to be shown', async () => {
  const failing: ShareFile = async () => {
    throw new Error('the file is not in the workspace');
  };
  const unrecorded: ShareFile = async (_b, path) => ({ message: message({ kind: 'notify.sent' }), file: { ...SAVED, path } });
  for (const share of [failing, unrecorded, async () => ({ message: null, file: SAVED })] as ShareFile[]) {
    const r = await deliverScreenshot(share, 'bot_1', SAVED, PAGE);
    assert.equal(r.outcome, 'done');
    assert.equal(r.shown, false);
    assert.deepEqual(r.file, SAVED);
    const text = formatResult(r);
    assert.doesNotMatch(text, /it is shown in your chat/);
    assert.match(text, /not shown in your chat/);
    assert.ok(text.includes(SAVED.path), text);
  }
});

test('only a shared image renders as an image in the chat', () => {
  const doc: FileRef = { name: 'notes.md', path: 'notes.md', size: 10, type: 'text/markdown' };
  assert.equal(sharedImage(message({ kind: 'file.shared', file: doc })), null);
  assert.equal(sharedImage(message({ kind: 'notify.sent' })), null);
  assert.equal(sharedImage(message(null)), null);
  assert.deepEqual(sharedImage(message({ kind: 'file.shared', file: SAVED })), SAVED);
});
