// Local image generation; the Pages build copies the resulting PNG and needs no dependencies.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { logoSvg } from '../shared/brand.ts';
import { COPY } from './content.ts';
import { renderCrew } from './page.ts';

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, 'styles.css'), 'utf8');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}
body { width: 1200px; height: 630px; overflow: hidden; }
.og-logo { position: absolute; top: 48px; left: 60px; color: var(--text); }
.og-logo svg { width: 175px; height: 34px; }
.og-heading { position: relative; z-index: 1; padding-top: 116px; text-align: center; font-size: 64px; }
.stage { height: 330px; margin-top: 35px; }
.crew { bottom: 48px; }
</style></head><body><div class="og-logo">${logoSvg({ uid: 'oglogo', ink: 'currentColor' })}</div><h1 class="og-heading">${COPY.hero.heading}</h1>${renderCrew()}</body></html>`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await page.setContent(html);
  await page.screenshot({ path: join(dir, 'og.png') });
} finally {
  await browser.close();
}
console.log('Wrote site/og.png');
