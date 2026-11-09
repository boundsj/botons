import { execFileSync } from 'node:child_process';
import { PAGE_HOOK } from './perf-chat-budget.ts';
// Real app on a throwaway server, with emulated phone geometry and render instrumentation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, devices } from '@playwright/test';
import { createApp } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { createPairingRequest, approvePairingRequest } from '../server/src/auth.ts';
import { freePort } from '../server/test/helpers.ts';

execFileSync('npm', ['run', 'build', '-w', 'web', '--', '--minify', 'false'], { stdio: 'inherit' });
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
  app.store.addMessage(kevin.id, 'bot', 'Ready for today. **Clear text** and `inline code`.\n\n```js\nconst ready = true;\n```\n\n| Task | State |\n| --- | --- |\n| Check in | Ready |');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'light' });
    await context.addInitScript(({ token }) => localStorage.setItem('botons.deviceToken', token), { token });
    await context.addInitScript(PAGE_HOOK);
    const page = await context.newPage();
    await page.goto(`${base}/#/m/${kevin.id}`);
    const composer = page.locator('.composer textarea');
    await composer.waitFor();
    await composer.fill('');
    await page.locator('.msg.bot').first().waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => (window as any).botonsTheme.set(theme), theme);
      const contrast = await page.evaluate(() => {
        const color = (token: string) => {
          const el = document.createElement('span'); el.style.color = `var(${token})`; document.body.append(el);
          const rgb = getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0, 3).map(Number); el.remove();
          return rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
        };
        return ['--bg', '--bg-side', '--surface', '--surface-2', '--surface-3'].flatMap(bg => ['--text', '--muted', '--faint'].map(fg => {
          const a = color(bg), b = color(fg); return { bg, fg, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05) };
        }));
      });
      for (const pair of contrast) assert(pair.ratio >= (pair.fg === '--text' ? 7 : 4.5), JSON.stringify({ theme, ...pair }));
      await page.screenshot({ path: `/tmp/botons-theme-${theme}-phone-chat.png` });
      await page.getByRole('button', { name: 'Back to Botons', exact: true }).click();
      await page.screenshot({ path: `/tmp/botons-theme-${theme}-phone-sidebar.png` });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('.settings-nav [data-section="appearance"]').click();
      const appearance = page.getByLabel('Appearance', { exact: true });
      await appearance.selectOption(theme === 'light' ? 'dark' : 'light');
      await appearance.selectOption(theme);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      if (theme === 'light') {
        await page.locator('.settings-back').click();
        await page.locator('.settings-nav [data-section="you"]').click();
        const ratios = await page.evaluate(() => {
          const input = document.querySelector('.settings-form input') as HTMLInputElement;
          const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((s,v,i) => s+v*[.2126,.7152,.0722][i],0);
          const ratio = () => { const s = getComputedStyle(input); const a=luminance(s.borderTopColor), b=luminance(s.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
          // Disable transitions so computed colors are the final state being checked.
          input.style.transition = 'none'; input.blur(); const normal=ratio();
          input.focus(); const focus=ratio(); input.setAttribute('aria-invalid','true'); const invalid=ratio();
          input.removeAttribute('aria-invalid'); input.blur();
          const svg = document.createElement('img'); svg.className = 'file-image svg'; svg.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><text x="0" y="20">Visible</text></svg>'; document.body.append(svg);
          const canvas=getComputedStyle(svg).backgroundColor; svg.remove();
          return { normal, focus, invalid, canvas };
        });
        assert.equal(ratios.canvas, 'rgb(255, 255, 255)');
        for (const key of ['normal','focus','invalid'] as const) assert(ratios[key] >= 3, JSON.stringify(ratios));
      }
      await page.screenshot({ path: `/tmp/botons-theme-${theme}-phone-settings.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Toggle light or dark mode' }).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme === 'light' ? 'dark' : 'light');
      await page.getByRole('button', { name: 'Toggle light or dark mode' }).click();
      await page.goto(`${base}/#/m/${kevin.id}`); await composer.waitFor();
    }
    assert((await page.evaluate(() => (window as any).__perf.mounted('MessageView'))) > 0, 'render counters must see message rows');
    await page.evaluate(() => (window as any).__perf.reset());
    await page.evaluate(() => (window as any).botonsTheme.set('light'));
    await page.waitForTimeout(100);
    const renders = await page.evaluate(() => (window as any).__perf.renders);
    assert(!Object.entries(renders).some(([key, count]) => /MessageView|MessageList|MessageContent/.test(key) && Number(count) > 0), JSON.stringify(renders));
    await page.evaluate(() => (window as any).botonsTheme.set('system'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.evaluate(() => (window as any).botonsTheme.set('light'));
    await page.reload(); await composer.waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    console.log(`Themes: contrast, phone chat/sidebar/settings, persistence, CSS-only switch passed; Chromium ${browser.version()}`);
  } finally { await browser.close(); }
} finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
