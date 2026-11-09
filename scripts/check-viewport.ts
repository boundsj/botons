// Real app on a throwaway server. Keyboard geometry is simulated: WebKit cannot open an iOS keyboard.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit, devices } from '@playwright/test';
import { createApp } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { createPairingRequest, approvePairingRequest } from '../server/src/auth.ts';
import { freePort } from '../server/test/helpers.ts';

const home = mkdtempSync(join(tmpdir(), 'botons-viewport-'));
const cfg = loadConfig({ BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_PORT: String(await freePort()), BOTONS_ENABLE_MOCK: '1', BOTONS_NO_TAILSCALE: '1', BOTONS_LOG_LEVEL: 'error', BOTONS_CLAUDE_BIN: join(home, 'no-claude'), BOTONS_CODEX_BIN: join(home, 'no-codex') });
cfg.webDist = resolve('web/dist');
const app = createApp(cfg, undefined, { tailnet: null });
try {
  await app.listen();
  const base = `http://127.0.0.1:${cfg.port}`;
  const { secret, code } = createPairingRequest(app.store.db, 'viewport check');
  approvePairingRequest(app.store.db, code);
  const { token } = await (await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, label: 'viewport check' }) })).json() as any;
  const call = async (method: string, path: string, body: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert(r.ok, `${path}: ${r.status}`);
    return r.json() as Promise<any>;
  };
  await call('PATCH', '/api/setup', { complete: true });
  const kevin = await call('POST', '/api/bots', { name: 'Kevin', provider: 'mock', access: 'workspace' });
  const bob = await call('POST', '/api/bots', { name: 'Bob', provider: 'mock', access: 'workspace' });
  for (const [engine, device] of [[webkit, devices['iPhone 13']], [chromium, devices['Pixel 7']], [chromium, { viewport: { width: 1280, height: 900 } }]] as const) {
    if (process.env.VIEWPORT_CHROMIUM_ONLY && engine === webkit) continue;
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext(device);
      await context.addInitScript(({ token }) => {
        localStorage.setItem('botons.deviceToken', token);
        // Preserve a real EventTarget while controlling keyboard geometry independently of layout height.
        const vv = new EventTarget();
        let height: number | undefined;
        Object.defineProperty(vv, 'height', { get: () => height ?? innerHeight, set: (value) => { height = value; } });
        Object.assign(vv, { scale: 1, offsetTop: 0 });
        Object.defineProperty(window, 'visualViewport', { value: vv });
      }, { token });
      const page = await context.newPage();
      await page.goto(`${base}/#/m/${kevin.id}`);
      const composer = page.locator('.composer textarea');
      await composer.waitFor();
      const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const check = async (height: number) => {
        await settle();
        const box = await page.evaluate(() => {
          const header = document.querySelector('.chat-header')!.getBoundingClientRect();
          const composer = document.querySelector('.composer-wrap')!.getBoundingClientRect();
          return { top: header.top, bottom: composer.bottom, scroll: scrollY };
        });
        assert(Math.abs(box.top) < 1, JSON.stringify(box));
        assert(Math.abs(box.bottom - height) < 2, JSON.stringify({ ...box, height }));
        assert.equal(box.scroll, 0);
      };
      const geometry = async (height: number, event = 'resize') => {
        await page.evaluate(({ height, event }) => {
          Object.assign(visualViewport!, { height });
          visualViewport!.dispatchEvent(new Event(event));
        }, { height, event });
      };
      const full = await page.evaluate(() => innerHeight);
      await check(full);
      for (let i = 0; i < 3; i++) {
        await composer.focus();
        await geometry(full * .45);
        await check(full * .45);
        await composer.blur();
        await geometry(full);
        await check(full);
      }
      // A layout viewport left scrolled by native focus must be restored, even without a size change.
      await page.evaluate(() => { document.documentElement.style.overflow = 'auto'; document.body.style.height = '200vh'; scrollTo(0, 120); });
      await geometry(full, 'scroll');
      await check(full);
      await page.evaluate(() => { document.documentElement.style.overflow = ''; document.body.style.height = ''; });
      await page.setViewportSize({ width: 844, height: 390 });
      await geometry(390);
      await check(390);
      await page.goto(`${base}/#/m/${bob.id}`);
      await composer.waitFor();
      await geometry(390);
      await check(390);
      await geometry(200);
      await page.evaluate(() => { Object.assign(visualViewport!, { height: 390 }); window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange')); });
      await check(390);
      console.log(`${engine.name()} ${'defaultBrowserType' in device ? device.defaultBrowserType : 'desktop'}: focus/close, scroll recovery, rotation, chat switch, resume passed (${browser.version()})`);
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
