// The real composer against a temp server and mock brain, with send responses held while the owner keeps editing.
// Run with `node scripts/check-composer.ts`; BOTONS_PROOF_DIR optionally keeps screenshots outside the checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../server/test/helpers.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'botons-composer-'));
const out = process.env.BOTONS_PROOF_DIR;
if (out) mkdirSync(out, { recursive: true });
const build = spawnSync(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', join(work, 'web'), '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(root, 'web'), stdio: 'inherit' });
if (build.error || build.status !== 0) {
  rmSync(work, { recursive: true, force: true });
  throw build.error ?? new Error(`Web build exited ${build.status}`);
}

const s = await startServer({ env: { BOTONS_LOG_LEVEL: 'warn' }, configure: (cfg) => { cfg.webDist = join(work, 'web'); cfg.hostname = 'myhost'; } });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync),
  args: ['--no-sandbox'],
});
try {
  assert.equal((await s.call('PATCH', '/api/setup', { complete: true })).status, 200);
  s.app.store.updateSettings({ ownerName: 'Sam' });
  const kevin = await s.newBot('Kevin');
  const stuart = await s.newBot('Stuart');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await page.addInitScript((token) => localStorage.setItem('botons.deviceToken', token), s.token);
  let requests = 0;
  type Held = { failure: boolean; captured: boolean; body: { text: string; attachments?: { path: string }[] } | null; release: () => void; wait: Promise<void>; done: Promise<void>; finish: () => void };
  let next: Held | null = null;
  const held = new Set<Held>();
  const hold = (failure = false): Held => {
    const wait = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const h: Held = { failure, captured: false, body: null, release: () => wait.resolve(), wait: wait.promise, done: done.promise, finish: () => done.resolve() };
    next = h;
    held.add(h);
    return h;
  };
  await page.route('**/api/bots/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests++;
    const h = next;
    next = null;
    if (!h) return route.continue();
    h.body = route.request().postDataJSON();
    const response = h.failure ? null : await route.fetch();
    h.captured = true;
    await h.wait;
    if (response) await route.fulfill({ response });
    else await route.fulfill({ status: 503, json: { error: 'The test server refused this message' } });
    h.finish();
    held.delete(h);
  });
  const composer = page.locator('.composer textarea');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const attach = async (name: string) => {
    await page.locator('.composer input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
    await expect(page.locator('.pending-file.ready').filter({ hasText: name })).toHaveCount(1);
  };
  const sent = async (h: Held) => {
    const received = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/messages'));
    h.release();
    await h.done;
    await (await received).finished();
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  };
  const capture = (h: Held) => expect.poll(() => h.captured).toBe(true);
  const open = async (id: string, name: string) => {
    await page.evaluate((id) => { location.hash = `/m/${id}`; }, id);
    await expect(composer).toHaveAttribute('aria-label', `Message ${name}`);
  };
  try {
    await page.goto(`${s.base}/#/m/${kevin.id}`);
    await expect(composer).toBeVisible();
    await composer.fill('First message');
    await attach('first.txt');
    const first = hold();
    const before = requests;
    // Two submits before React renders again exercise the synchronous duplicate guard.
    await page.locator('form.composer').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await capture(first);
    await expect(send).toBeDisabled();
    assert.equal(requests, before + 1);
    await sent(first);
    await expect(composer).toHaveValue('');
    await expect(page.locator('.pending-file')).toHaveCount(0);
    assert.equal(first.body?.text, 'First message');
    assert.equal(first.body?.attachments?.length, 1);
    assert.ok(first.body?.attachments?.[0]?.path.endsWith('-first.txt'));

    await composer.fill('Submitted message');
    await attach('submitted.txt');
    const edited = hold();
    await send.click();
    await capture(edited);
    await composer.fill('Next message');
    await attach('next.txt');
    await sent(edited);
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('Next message');
    await expect(page.locator('.pending-file')).toHaveCount(1);
    await expect(page.locator('.pending-file')).toContainText('next.txt');
    assert.equal(edited.body?.text, 'Submitted message');
    assert.equal(edited.body?.attachments?.length, 1);
    assert.ok(edited.body?.attachments?.[0]?.path.endsWith('-submitted.txt'));
    if (out) await page.screenshot({ path: join(out, 'composer-next-draft.png') });

    // Replacing a draft with the same text is still a new edit, so equality alone is insufficient.
    const repeated = hold();
    await send.click();
    await capture(repeated);
    await composer.fill('A different draft');
    await composer.fill('Next message');
    await sent(repeated);
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('Next message');
    await expect(page.locator('.pending-file')).toHaveCount(0);

    await attach('retry.txt');
    const refused = hold(true);
    await send.click();
    await capture(refused);
    await sent(refused);
    await expect(page.locator('.composer-error')).toContainText('The test server refused this message');
    await expect(composer).toHaveValue('Next message');
    await expect(page.locator('.pending-file')).toContainText('retry.txt');
    await expect(send).toBeEnabled();
    if (out) await page.screenshot({ path: join(out, 'composer-refusal.png') });

    const leaving = hold();
    await send.click();
    await capture(leaving);
    await open(stuart.id, 'Stuart');
    await composer.fill('Stuart draft');
    await attach('stuart.txt');
    const attachButton = page.getByRole('button', { name: 'Attach files', exact: true });
    await attachButton.focus();
    await sent(leaving);
    await expect(composer).toHaveValue('Stuart draft');
    await expect(page.locator('.pending-file')).toContainText('stuart.txt');
    await expect(attachButton).toBeFocused();
    await expect(send).toBeEnabled();
    await expect(page.locator('.composer-error')).toHaveCount(0);

    // Leaving and returning creates a new composer even for the same Boton.
    const returned = hold(true);
    await send.click();
    await capture(returned);
    await open(kevin.id, 'Kevin');
    await open(stuart.id, 'Stuart');
    await composer.fill('Draft after returning');
    await attach('returned.txt');
    await sent(returned);
    await expect(composer).toHaveValue('Draft after returning');
    await expect(page.locator('.pending-file')).toContainText('returned.txt');
    await expect(page.locator('.composer-error')).toHaveCount(0);
    await expect(send).toBeEnabled();
    console.log(`Composer checks passed: Chromium ${browser.version()}, 1280×900, light theme, default zoom; delayed success/refusal, newer drafts/files, duplicate submit, chat changes.`);
  } finally {
    for (const h of held) h.release();
    await page.close();
  }
} finally {
  await browser.close();
  await s.stop();
  rmSync(work, { recursive: true, force: true });
}
