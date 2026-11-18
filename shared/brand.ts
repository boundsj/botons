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

/** The app icon's own colors: a snow keycap on electric violet. */
const KEY = {
  violetLight: '#8a5cff', violet: '#3a159a', violetDeep: '#140842', sideTop: '#d7dce7', sideMid: '#b2b9ca', sideDeep: '#7e869c',
  edge: '#4d5468', topDeep: '#e6eaf2', dish: '#dfe4ee', dishOut: '#f1f4f9', glassTop: '#151d38', glassDeep: '#070a15',
  shadow: '#07021c', light: '#a8ff5c', cyanCore: '#dcfbff', sideFlat: '#a7afc2', topFlat: '#f4f6fb',
} as const;

/**
 * The app icon in a 100 × 100 square: a Boton as a chunky keycap seen from the front and a little above, tilted a
 * touch, its face the key's legend lit on a glass inset, a status light in the corner, on electric violet. It is drawn
 * in a 1024 grid and scaled down. `rounded` adds the corner radius for the SVG icon; the PNGs for home screens are
 * full-bleed and the system masks them. `safe` draws the key smaller, inside the central circle a maskable icon keeps
 * (radius 40), for the maskable PNGs; the violet still fills the square.
 */
export function appIconInner(uid = 'ai', { rounded = true, safe = false } = {}): string {
  const id = safeId(uid);
  const { cyan, cheek } = BRAND;
  const square = rounded ? '<rect width="100" height="100" rx="22"/>' : '<rect width="100" height="100"/>';
  const blur = (name: string, sd: number) => `<filter id="${id}${name}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
  const side = 'M246 300H778Q848 300 856 370L874 816Q878 892 802 892H222Q146 892 150 816L168 370Q176 300 246 300Z';
  const mouth = 'M470 540Q512 570 554 540';
  const key = `<ellipse cx="530" cy="900" rx="372" ry="58" fill="${KEY.shadow}" opacity=".75" filter="url(#${id}s)"/>`
    + '<g transform="rotate(-5 512 560)">'
    + `<path d="${side}" fill="url(#${id}sd)"/><path d="${side}" fill="none" stroke="${KEY.edge}" stroke-width="6" opacity=".5"/>`
    + '<path d="M196 800Q512 846 828 800" stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none" opacity=".18"/>'
    + `<rect x="228" y="206" width="568" height="566" rx="128" fill="url(#${id}tp)"/><rect x="228" y="206" width="568" height="566" rx="128" fill="url(#${id}ds)"/>`
    + '<path d="M300 222H724" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".9"/>'
    + `<rect x="296" y="290" width="432" height="312" rx="92" fill="url(#${id}gl)"/><rect x="296" y="290" width="432" height="312" rx="92" fill="none" stroke="${cyan}" stroke-width="7" opacity=".5"/>`
    + '<path d="M346 318H452" stroke="#fff" stroke-width="12" stroke-linecap="round" opacity=".15"/>'
    + `<g fill="${cyan}"><rect x="402" y="370" width="60" height="118" rx="30" opacity=".45" filter="url(#${id}g)"/><rect x="562" y="370" width="60" height="118" rx="30" opacity=".45" filter="url(#${id}g)"/>`
    + '<rect x="408" y="376" width="48" height="106" rx="24"/><rect x="568" y="376" width="48" height="106" rx="24"/></g>'
    + `<g fill="none" stroke-linecap="round"><path d="${mouth}" stroke="${cyan}" stroke-width="36" opacity=".5" filter="url(#${id}g)"/><path d="${mouth}" stroke="${cyan}" stroke-width="20"/><path d="${mouth}" stroke="${KEY.cyanCore}" stroke-width="6" opacity=".9"/></g>`
    + `<g fill="${cheek}" opacity=".6"><rect x="332" y="530" width="50" height="20" rx="10"/><rect x="642" y="530" width="50" height="20" rx="10"/></g>`
    + `<circle cx="744" cy="270" r="37.4" fill="${KEY.light}" opacity=".45" filter="url(#${id}g)"/><circle cx="744" cy="270" r="17" fill="${KEY.light}"/><circle cx="739.24" cy="264.9" r="5.78" fill="#fff" opacity=".85"/>`
    + '</g>';
  return `<defs><linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${KEY.violetLight}"/><stop offset=".5" stop-color="${KEY.violet}"/><stop offset="1" stop-color="${KEY.violetDeep}"/></linearGradient>`
    + `<radialGradient id="${id}hl" cx="22%" cy="16%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="${id}sd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${KEY.sideTop}"/><stop offset=".55" stop-color="${KEY.sideMid}"/><stop offset="1" stop-color="${KEY.sideDeep}"/></linearGradient>`
    + `<linearGradient id="${id}tp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${KEY.topDeep}"/></linearGradient>`
    + `<radialGradient id="${id}ds" cx="50%" cy="56%" r="58%"><stop offset="0" stop-color="${KEY.dish}"/><stop offset=".75" stop-color="${KEY.dishOut}" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="${id}gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${KEY.glassTop}"/><stop offset="1" stop-color="${KEY.glassDeep}"/></linearGradient>`
    + `${blur('g', 18)}${blur('s', 28)}<clipPath id="${id}sq">${square}</clipPath></defs>`
    + `<g clip-path="url(#${id}sq)"><g transform="scale(.09765625)"><rect width="1024" height="1024" fill="url(#${id}bg)"/><rect width="1024" height="1024" fill="url(#${id}hl)"/>`
    + (safe ? `<g transform="translate(512 520) scale(.76) translate(-512 -520)">${key}</g>` : key)
    + '</g></g>';
}

/** The favicon in a 32 × 32 square: the keycap on violet, its dark display and two lit eyes, so it holds at 16 px. */
export function faviconInner(): string {
  const { cyan, glass } = BRAND;
  return `<rect width="32" height="32" rx="7" fill="${KEY.violet}"/>`
    + `<rect x="4.4" y="8.4" width="23.2" height="20.4" rx="5.6" fill="${KEY.sideFlat}"/>`
    + `<rect x="6" y="5.4" width="20" height="19.2" rx="5" fill="${KEY.topFlat}"/>`
    + `<rect x="8.4" y="8.2" width="15.2" height="11" rx="3.6" fill="${glass}"/>`
    + `<rect x="11.6" y="10.4" width="2.6" height="5.2" rx="1.3" fill="${cyan}"/><rect x="17.8" y="10.4" width="2.6" height="5.2" rx="1.3" fill="${cyan}"/>`;
}

/** Whole SVG documents for the files in web/public (scripts/icons.ts writes them). */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${faviconInner()}</svg>\n`;
}
export function appIconSvg({ rounded = true, safe = false } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${appIconInner('i', { rounded, safe })}</svg>\n`;
}
