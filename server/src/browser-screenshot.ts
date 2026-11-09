import type { BrowserActionResult, FileRef, Message } from '../../shared/types.ts';
import { saveNewFile } from './files.ts';

const SCREENSHOTS = 'browser-screenshots';

/** Posts a file in the Boton's chat (the same as `botons share`): the message it recorded, and the file as shared. */
export type ShareFile = (botId: string, path: string, title: string) => Promise<{ message: Message | null; file: FileRef }>;

/**
 * A screenshot already saved in the workspace, shared in the chat as `botons share` would. The result says it is shown
 * in the chat only when the chat recorded it; otherwise it names the workspace copy, which stays either way.
 */
export async function deliverScreenshot(
  share: ShareFile,
  botId: string,
  saved: FileRef,
  page: { url: string; title: string },
): Promise<BrowserActionResult> {
  let why: string;
  try {
    const shared = await share(botId, saved.path, `Browser: ${page.title || page.url}`.slice(0, 200));
    if (shared.message?.meta?.kind === 'file.shared' && shared.message.meta.file?.path === shared.file.path) {
      return { outcome: 'done', message: `Saved a screenshot as ${shared.file.path} in your workspace; it is shown in your chat.`, page, file: shared.file, shown: true };
    }
    why = 'the chat did not record it';
  } catch (err) {
    why = (err as Error).message || 'it could not be shared';
  }
  return {
    outcome: 'done',
    message: `Saved a screenshot as ${saved.path} in your workspace, but it is not shown in your chat (${why}). Give its workspace path, ${saved.path}, if your owner should see it.`,
    page,
    file: saved,
    shown: false,
  };
}

/**
 * A screenshot's bytes (in memory) saved as a new file in the Boton's workspace, by a write that follows no link the Boton
 * planted there, then shared in its chat as deliverScreenshot says. Not saved: refused, with nothing shared.
 */
export async function screenshotToChat(
  share: ShareFile,
  bot: { id: string; workspace: string },
  bytes: Uint8Array,
  page: { url: string; title: string },
  now = new Date(),
): Promise<BrowserActionResult> {
  let file: FileRef;
  try {
    file = await saveNewFile(bot.workspace, SCREENSHOTS, now.toISOString().replace(/[:.]/g, '-'), 'page.png', bytes);
  } catch (err) {
    return { outcome: 'refused', message: `Not saved: ${(err as Error).message}.`, page };
  }
  return deliverScreenshot(share, bot.id, file, page);
}
