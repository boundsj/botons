import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sharedImage } from '../../web/src/files.ts';
import { screenshotToChat, type ShareFile } from '../src/browser-screenshot.ts';
import { formatResult } from '../src/cli/browser-mcp.ts';
import { startServer, useTestCodexHome } from './helpers.ts';

// A PNG's signature and a little more: the bytes a capture returned, as Chromium's page.screenshot would.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a stub capture')]);
const PAGE = { url: 'https://example.com/', title: 'Example Domain' };

// Chromium is not needed: the capture is stubbed, and everything after it (the save in the workspace, the engine's
// shareFile, the store and the messages API) is the server's own, during a Codex turn with Full computer access.
test("a Codex Full computer turn's screenshot is saved in the workspace, recorded in the chat as that file, and said to be shown", async () => {
  const s = await startServer({ fakeClis: true });
  useTestCodexHome(s.cfg.home);
  try {
    const kevin = await s.newBot('Kevin', { provider: 'codex-cli', access: 'host' });
    const bot = s.app.store.getBot(kevin.id);
    // As app.ts gives the browser its share: the engine's shareFile, the same as `botons share`.
    const share: ShareFile = (botId, path, title) => s.app.engine.shareFile(botId, path, title);
    s.codex.script({ fixture: 'codex/reply', delayMs: 1500 });
    const replying = s.chat(kevin.id, 'Take a screenshot of the page.');
    await s.untilState(kevin.id, 'working');

    const r = await screenshotToChat(share, bot, PNG, PAGE);
    assert.equal(r.outcome, 'done', r.message);
    assert.equal(r.shown, true);
    assert.match(r.file!.path, /^browser-screenshots\/.*-page\.png$/);
    // The PNG stays in the workspace, byte for byte.
    assert.deepEqual(readFileSync(join(bot.workspace, r.file!.path)), PNG);
    const text = formatResult(r);
    assert.match(text, /it is shown in your chat/);
    assert.ok(text.includes(r.file!.path), text);

    const reply = await replying;
    assert.equal(reply.role, 'bot', reply.text);
    // As a reload reads it: the stored file.shared message points at that same workspace PNG, and renders as it.
    const shared = (await s.messagesOf(kevin.id)).filter((m) => m.meta?.kind === 'file.shared');
    assert.equal(shared.length, 1, JSON.stringify(shared));
    assert.deepEqual(shared[0].meta!.file, { ...r.file, title: 'Browser: Example Domain' });
    assert.equal(shared[0].text, `Shared ${r.file!.path}`);
    assert.deepEqual(sharedImage(shared[0]), shared[0].meta!.file);
    const served = await s.call('GET', `/api/bots/${kevin.id}/files/raw?path=${encodeURIComponent(r.file!.path)}`);
    assert.equal(served.status, 200, served.text);
  } finally {
    await s.stop();
  }
});
