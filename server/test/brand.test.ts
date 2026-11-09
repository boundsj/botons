import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ICONS, PNG_ICONS } from '../../scripts/icons.ts';
import { appIconInner, logoSvg, MARK_VIEWBOX, markInner } from '../../shared/brand.ts';

const repo = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

test('the icons in web/public are the brand marks (node scripts/icons.ts writes them), and the page and manifest name them', () => {
  for (const [name, svg] of Object.entries(ICONS)) assert.equal(read(`web/public/${name}`), svg, `web/public/${name} is stale: run node scripts/icons.ts`);
  for (const svg of Object.values(ICONS)) assert.doesNotMatch(svg, /class=|<script|href=/);
  for (const [name, px] of Object.entries(PNG_ICONS)) {
    const png = readFileSync(join(repo, 'web/public', name));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', name);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [px, px], `${name} is ${px} px square: run node scripts/icons.ts --png`);
  }
  const manifest = JSON.parse(read('web/public/manifest.webmanifest'));
  assert.deepEqual(manifest.icons.map((i: { src: string; purpose: string }) => `${i.src} ${i.purpose}`), ['/icon.svg any', '/icon-192.png maskable', '/icon-512.png maskable']);
  const html = read('web/index.html');
  assert.match(html, /<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png" \/>/);
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest" \/>/);
});

test('each mark keeps its gradient ids to its own uid, so two on one page never share one', () => {
  for (const draw of [markInner, (uid: string) => appIconInner(uid), (uid: string) => logoSvg({ uid })]) {
    const ids = (uid: string) => [...draw(uid).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids('a').length > 0);
    for (const id of ids('a')) assert.ok(id.startsWith('a'), id);
    assert.equal(ids('a').filter((id) => ids('b').includes(id)).length, 0);
  }
  assert.doesNotMatch(markInner('x"><script>'), /<script/);
});

test('the logo and the mark keep the whole Boton, its antenna light included, inside their view boxes', () => {
  const [, y, , h] = MARK_VIEWBOX.split(' ').map(Number);
  // The antenna light's glow reaches up to y 5 and the button's skirt down to y 89, in the Boton's own frame.
  assert.ok(y <= 5 && y + h >= 89, MARK_VIEWBOX);
  const nested = logoSvg().match(/<svg x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/)!;
  const [x0, y0, , h0] = nested.slice(1).map(Number);
  assert.ok(x0 >= 0 && y0 >= 0 && y0 + h0 <= 60, nested[0]);
});

// WCAG 2.2 relative luminance and contrast; alpha is ignored, so only opaque tokens are checked.
const chan = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function lum(hex: string): number {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => chan(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

/** The theme's tokens as hex: the dark :root, or it with the light block on top, with var(--paint-…) resolved. */
function theme(name: 'dark' | 'light'): Record<string, string> {
  const css = read('web/src/styles.css');
  const block = (start: number) => Object.fromEntries([...css.slice(start, css.indexOf('}', start)).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const vars: Record<string, string> = {};
  for (const m of css.matchAll(/^:root \{/gm)) Object.assign(vars, block(m.index));
  if (name === 'light') Object.assign(vars, block(css.indexOf(':root[data-theme="light"] {')));
  const resolve = (v: string): string => (v.startsWith('var(') ? resolve(vars[v.slice(4, -1)]) : v);
  return Object.fromEntries(Object.entries(vars).filter(([, v]) => /^(#|var\()/.test(v)).map(([k, v]) => [k, resolve(v)]));
}

test('the palette meets its contrast targets in both themes', () => {
  for (const name of ['dark', 'light'] as const) {
    const t = theme(name);
    const check = (fg: string, bg: string, min: number) => {
      assert.match(t[fg], /^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i, `${name} ${fg} is an opaque hex`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= min, `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]} is ${r.toFixed(2)}, below ${min}`);
    };
    for (const bg of ['--bg', '--bg-side', '--surface', '--surface-2', '--surface-3']) {
      check('--text', bg, 7);
      check('--muted', bg, 4.5);
      check('--faint', bg, 4.5);
    }
    for (const bg of ['--bg', '--bg-side', '--surface', '--surface-2']) {
      check('--accent-text', bg, 4.5);
      check('--danger', bg, 4.5);
    }
    for (const bg of ['--bg', '--bg-side']) check('--accent-edge', bg, 3);
    // What needs you (approvals, pending cards) is amber text and edges, apart from the cyan accent.
    for (const bg of ['--bg', '--bg-side', '--surface']) check('--warn', bg, 4.5);
    check('--accent-ink', '--accent', 7);
    check('--user-ink', '--user', 7);
  }
  // Boton cyan is a fill in both themes: the same family, never swapped for a dark text cyan in light.
  assert.equal(theme('dark')['--accent'], '#3ee6ff');
  assert.equal(theme('light')['--accent'], '#17c7e4');
});
