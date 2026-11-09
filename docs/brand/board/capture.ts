// Writes the Botons board's images (docs/brand/img/*.png) from index.html in headless Chromium, and fails
// when a palette pair in the board misses its contrast target. Run from the repository root after `npm ci`:
//   node docs/brand/board/capture.ts
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'img');
mkdirSync(out, { recursive: true });
const types: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = join(here, (req.url ?? '/').split('?')[0].replace(/^\/$/, '/index.html'));
  if (!path.startsWith(here) || !existsSync(path)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const { port } = server.address() as { port: number };

const SHOTS = ['cover', 'concept', 'directions', 'parts', 'palette', 'motifs', 'type', 'logos', 'voice', 'm-chat-dark', 'm-chat-light', 'm-setup', 'm-builder', 'm-phone', 'm-more'];
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1424, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page.on('pageerror', (e) => {
    failed = true;
    console.error('page error:', e.message);
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('body[data-ready]');
  for (const id of SHOTS) {
    await page.locator(`#${id}`).screenshot({ path: join(out, `${id}.png`) });
    console.log(`wrote img/${id}.png`);
  }
  const { SHELL, GLOW, BACKDROP, GLASS, OFF_RIM, skirtOf, mix } = await import('./bot.js');
  const ch = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (h: string) => [1, 3, 5].map((i) => ch(parseInt(h.slice(i, i + 2), 16))).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  // Every glow on the display glass: the face reads at 7:1.
  for (const [k, g] of Object.entries(GLOW as Record<string, string>))
    if (ratio(g, GLASS) < 7) {
      failed = true;
      console.error(`glow below 7:1 on the glass: ${k} (${ratio(g, GLASS).toFixed(2)})`);
    }
  // Every shell on every backdrop: the shell, its skirt or the weakest rim light stands out at 3:1.
  const weakestRim = (bd: string) => Math.min(...Object.values(GLOW as Record<string, string>).map((g) => ratio(g, bd)));
  for (const [s, shell] of Object.entries(SHELL as Record<string, string>))
    for (const [b, bd] of Object.entries(BACKDROP as Record<string, string>)) {
      const best = Math.max(ratio(shell, bd), ratio(skirtOf(shell), bd), weakestRim(bd));
      if (best < 3) {
        failed = true;
        console.error(`silhouette below 3:1: ${s} on ${b} (${best.toFixed(2)})`);
      }
      // With no brain: the shell greyer, the rim unlit.
      const off = mix(shell, '#8a92a3', 0.35);
      const asleep = Math.max(ratio(off, bd), ratio(skirtOf(off), bd), ratio(OFF_RIM, bd));
      if (asleep < 3) {
        failed = true;
        console.error(`silhouette below 3:1 with no brain: ${s} on ${b} (${asleep.toFixed(2)})`);
      }
    }
  const misses = await page.$$eval('[data-ratio]', (els) => els.filter((e) => Number((e as HTMLElement).dataset.ratio) < Number((e as HTMLElement).dataset.min)).map((e) => e.parentElement?.textContent));
  if (misses.length) {
    failed = true;
    console.error('contrast below target:', misses);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
