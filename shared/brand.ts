// The Botons marks, drawn as SVG strings: the brand Boton, the "botons" wordmark, the app icon and the favicon. They
// are fixed art (no user data reaches them), shared by the web app and scripts/icons.ts, and match the brand board in
// docs/brand. The wordmark is drawn with strokes, so it needs no font and looks the same everywhere.

/** The brand scale (docs/brand/board/tokens.css). */
export const BRAND = {
  cyan: '#3ee6ff',
  glass: '#0a0f1c',
  shell: '#eef2f7',
  shellLight: '#f2f5f9',
  shellDeep: '#d2d6db',
  skirt: '#7a7d82',
  cheek: '#ff7eb6',
  nightTop: '#16214a',
  nightMid: '#0a0f1f',
  void: '#05070d',
} as const;

const safeId = (uid: string) => uid.replace(/[^A-Za-z0-9_-]/g, '');

/** The view box of the brand Boton: a round button with a lit antenna (its glow included), a little taller than wide. */
export const MARK_VIEWBOX = '20 4 60 86';

/**
 * The brand Boton's body, in a 100 × 100 frame: a snow-white round button with a little depth, a rim of light, a
 * dark glass display with a lit face, and a lit antenna. `uid` keeps its gradient id unique on a page.
 */
function botonBody(id: string): string {
  const { cyan, glass, skirt } = BRAND;
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND.shellLight}"/><stop offset=".55" stop-color="${BRAND.shell}"/><stop offset="1" stop-color="${BRAND.shellDeep}"/></linearGradient></defs>`
    + `<path d="M50 27V13" stroke="${skirt}" stroke-width="2.6" stroke-linecap="round"/>`
    + `<circle cx="50" cy="11" r="6" fill="${cyan}" opacity=".25"/><circle cx="50" cy="11" r="3.4" fill="${cyan}" stroke="${skirt}" stroke-width="1.2"/>`
    + `<circle cx="50" cy="59.5" r="29.5" fill="${skirt}"/>`
    + `<circle cx="50" cy="55" r="29" fill="url(#${id})"/>`
    + `<circle cx="50" cy="55" r="29" fill="none" stroke="${cyan}" stroke-width="1.3" stroke-opacity=".75"/>`
    + '<path d="M32 40.5Q42.8 30.1 52.9 28.9" stroke="#fff" stroke-opacity=".45" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
    + `<rect x="31" y="40" width="38" height="25" rx="11" fill="${glass}" stroke="${cyan}" stroke-opacity=".5" stroke-width="1.1"/>`
    + '<path d="M35 43.5H47" stroke="#fff" stroke-opacity=".14" stroke-width="1.6" stroke-linecap="round"/>'
    + `<g fill="${BRAND.cheek}" opacity=".55"><rect x="33.6" y="58" width="4.6" height="2.2" rx="1.1"/><rect x="61.8" y="58" width="4.6" height="2.2" rx="1.1"/></g>`
    + `<g fill="${cyan}"><circle cx="41.6" cy="53" r="5.6" opacity=".22"/><circle cx="41.6" cy="53" r="3.6"/><circle cx="58.4" cy="53" r="5.6" opacity=".22"/><circle cx="58.4" cy="53" r="3.6"/></g>`
    + `<g stroke="${cyan}" fill="none" stroke-linecap="round"><path d="M44.6 57.5Q50 62.5 55.4 57.5" stroke-width="6" stroke-opacity=".22"/><path d="M44.6 57.5Q50 62.5 55.4 57.5" stroke-width="2.6"/></g>`;
}

/** The brand Boton's inner markup, in MARK_VIEWBOX. */
export function markInner(uid = 'bm'): string {
  return botonBody(`${safeId(uid)}g`);
}

/** The view box of the wordmark's letters. */
export const WORDMARK_VIEWBOX = '0 0 246 52';

/** "botons" in a rounded monoline: round caps, a geometric b, o and n, a hooked t, a single-stroke s. */
export function wordmarkInner(color = 'currentColor', weight = 9): string {
  return `<g stroke="${color}" stroke-width="${weight}" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M8 6V46"/><circle cx="21.5" cy="32" r="13.5"/>'
    + '<circle cx="64.5" cy="32" r="13.5"/>'
    + '<path d="M102 6V36Q102 46 112 46"/><path d="M94 19H112"/>'
    + '<circle cx="141.5" cy="32" r="13.5"/>'
    + '<path d="M171 46V18.5"/><path d="M171 32A13.5 13.5 0 0 1 198 32V46"/>'
    + '<path d="M236.5 21Q231.5 17.5 224.5 18Q216.5 19 217 25Q217.5 30 225.5 31.5Q235.5 33 235.5 39Q235 46 224.5 46Q217.5 46 214 42"/>'
    + '</g>';
}

/** The logo: the brand Boton beside the wordmark. The wordmark takes `ink` (currentColor follows the theme). */
export function logoSvg({ ink = 'currentColor', uid = 'logo', height }: { ink?: string; uid?: string; height?: number } = {}): string {
  const size = height ? ` height="${height}" width="${Math.round((height * 318) / 60)}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 318 60"${size} role="img" aria-label="Botons">`
    + `<svg x="0" y="0" width="62" height="60" viewBox="${MARK_VIEWBOX}">${markInner(uid)}</svg>`
    + `<g transform="translate(70 6)">${wordmarkInner(ink)}</g></svg>`;
}

/**
 * The app icon in a 100 × 100 square: the brand Boton lit up over a light-cycle floor. The Boton stays inside the
 * central circle a maskable icon keeps (radius 40), so any mask crops it well. `rounded` adds the corner radius for
 * the SVG icon; the PNGs for home screens are full-bleed and the system masks them.
 */
export function appIconInner(uid = 'ai', { rounded = true } = {}): string {
  const id = safeId(uid);
  const square = rounded ? '<rect width="100" height="100" rx="22"/>' : '<rect width="100" height="100"/>';
  const rays = [-30, -6, 18, 42, 66, 90, 114, 138].map((x) => `M${Math.round((50 + (x - 50) * 0.18) * 100) / 100} 64L${x} 100`).join('');
  return `<defs><linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND.nightTop}"/><stop offset=".62" stop-color="${BRAND.nightMid}"/><stop offset="1" stop-color="${BRAND.void}"/></linearGradient>`
    + `<radialGradient id="${id}gl" cx=".5" cy=".64" r=".5"><stop offset="0" stop-color="${BRAND.cyan}" stop-opacity=".35"/><stop offset="1" stop-color="${BRAND.cyan}" stop-opacity="0"/></radialGradient>`
    + `<clipPath id="${id}sq">${square}</clipPath></defs>`
    + `<g clip-path="url(#${id}sq)"><rect width="100" height="100" fill="url(#${id}bg)"/>`
    + `<path d="M0 64H100M0 69H100M0 76H100M0 86H100M0 99H100${rays}" stroke="${BRAND.cyan}" stroke-opacity=".32" stroke-width=".7" fill="none"/>`
    + `<ellipse cx="50" cy="86" rx="36" ry="9" fill="url(#${id}gl)"/>`
    + `<g transform="translate(14 13) scale(.72)">${botonBody(`${id}b`)}</g></g>`;
}

/** The favicon in a 32 × 32 square: a button, a dark display, two lit eyes and the antenna's light, so it holds at 16 px. */
export function faviconInner(): string {
  const { cyan, glass } = BRAND;
  return `<rect width="32" height="32" rx="8" fill="${glass}"/>`
    + '<circle cx="16" cy="18.4" r="11.2" fill="#9aa6b8"/>'
    + `<circle cx="16" cy="17" r="11.2" fill="${BRAND.shell}" stroke="${cyan}" stroke-width="1"/>`
    + `<rect x="8.4" y="11.6" width="15.2" height="10" rx="5" fill="${glass}"/>`
    + `<circle cx="12.6" cy="16.2" r="1.9" fill="${cyan}"/><circle cx="19.4" cy="16.2" r="1.9" fill="${cyan}"/>`
    + `<circle cx="16" cy="3.4" r="2" fill="${cyan}"/>`;
}

/** Whole SVG documents for the files in web/public (scripts/icons.ts writes them). */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${faviconInner()}</svg>\n`;
}
export function appIconSvg({ rounded = true } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${appIconInner('i', { rounded })}</svg>\n`;
}
