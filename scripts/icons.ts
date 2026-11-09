// `node scripts/icons.ts`: write the app's SVG icons from the brand marks (shared/brand.ts). A test fails when a
// committed SVG differs from what this writes. `node scripts/icons.ts --png` also draws the PNGs that home screens
// need (iOS takes no SVG touch icon) in headless Chromium; run it after changing the app icon and commit the files.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appIconSvg, faviconSvg } from '../shared/brand.ts';

/** File in web/public → its SVG: the tab icon, and the rounded app icon. */
export const ICONS: Record<string, string> = {
  'favicon.svg': faviconSvg(),
  'icon.svg': appIconSvg(),
};

/** File in web/public → its size in pixels. Full-bleed squares: the home screen masks them. */
export const PNG_ICONS: Record<string, number> = {
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
};

if (import.meta.main) {
  const dir = join(import.meta.dirname, '../web/public');
  for (const [name, svg] of Object.entries(ICONS)) writeFileSync(join(dir, name), svg);
  console.log(`wrote ${Object.keys(ICONS).join(', ')} in web/public`);
  if (process.argv.includes('--png')) {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      const svg = appIconSvg({ rounded: false });
      for (const [name, px] of Object.entries(PNG_ICONS)) {
        await page.setViewportSize({ width: px, height: px });
        await page.setContent(`<style>html,body{margin:0}svg{display:block}</style>${svg.replace('<svg ', `<svg width="${px}" height="${px}" `)}`);
        await page.screenshot({ path: join(dir, name), clip: { x: 0, y: 0, width: px, height: px } });
      }
      console.log(`wrote ${Object.keys(PNG_ICONS).join(', ')} in web/public`);
    } finally {
      await browser.close();
    }
  }
}
