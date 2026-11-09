// Logo, wordmark and icon options for the Botons brand board. Lettering is drawn with strokes (no font file), so
// the wordmark is a few hundred bytes of SVG and looks the same everywhere.
import { botInner, DEFAULT_LOOK, GLOW, GLASS } from './bot.js';

const CYAN = GLOW.cyan;
export const WORD_W = 246;

/** The letters of "botons" as stroke paths, one entry per letter, on a 52-unit line (baseline 46, x-height 18.5). */
export const LETTERS = {
  b: '<path d="M8 6V46"/><circle cx="21.5" cy="32" r="13.5"/>',
  o: '<circle cx="64.5" cy="32" r="13.5"/>',
  t: '<path d="M102 6V36Q102 46 112 46"/><path d="M94 19H112"/>',
  o2: '<circle cx="141.5" cy="32" r="13.5"/>',
  n: '<path d="M171 46V18.5"/><path d="M171 32A13.5 13.5 0 0 1 198 32V46"/>',
  s: '<path d="M236.5 21Q231.5 17.5 224.5 18Q216.5 19 217 25Q217.5 30 225.5 31.5Q235.5 33 235.5 39Q235 46 224.5 46Q217.5 46 214 42"/>',
};
const stroke = (color, weight) => `stroke="${color}" stroke-width="${weight}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

/** "botons" in a rounded monoline: round caps, a geometric b, o and n, a single-stroke s. */
export function letters(color, weight = 9, skip = '') {
  return `<g ${stroke(color, weight)}>${Object.entries(LETTERS).filter(([k]) => !skip.includes(k)).map(([, v]) => v).join('')}</g>`;
}

/** The brand Boton: round, snow white, a cyan face and a lit antenna. */
export const BRAND_LOOK = { ...DEFAULT_LOOK, arms: 'none' };

/** Option A: the brand Boton beside the wordmark. */
export function logoA({ ink = '#0d1322', uid = 'la' } = {}) {
  return `<svg viewBox="0 0 318 60" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Botons">
    <svg x="0" y="0" width="62" height="60" viewBox="20 4 60 86">${botInner(BRAND_LOOK, { uid, size: 120, frame: 'none', still: true })}</svg>
    <g transform="translate(70 6)">${letters(ink)}</g>
  </svg>`;
}

/** Option B: the o is a Boton's face, a lit display. The face alone is the icon. */
export function logoB({ ink = '#0d1322' } = {}) {
  return `<svg viewBox="0 0 252 60" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Botons">
    <g transform="translate(3 4)">${letters(ink, 9, 'o')}
      <circle cx="64.5" cy="32" r="16.5" fill="${GLASS}" stroke="${CYAN}" stroke-width="3"/>
      <circle cx="64.5" cy="32" r="19" fill="none" stroke="${CYAN}" stroke-opacity=".25" stroke-width="2.5"/>
      <circle cx="58.5" cy="29" r="2.8" fill="${CYAN}"/><circle cx="70.5" cy="29" r="2.8" fill="${CYAN}"/>
      <path d="M59.5 36Q64.5 40 69.5 36" ${stroke(CYAN, 2.4)}/>
      <path d="M64.5 13V6" ${stroke(ink, 4)}/><circle cx="64.5" cy="4" r="3.2" fill="${CYAN}"/>
    </g>
  </svg>`;
}

/** Option C: the word on a pill button with a lit edge. A literal button, and a name you can press. */
export function logoC({ ink = '#0d1322', fill = '#ffffff' } = {}) {
  return `<svg viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Botons">
    <rect x="3" y="8" width="294" height="62" rx="31" fill="${ink}" opacity=".9"/>
    <rect x="3" y="3" width="294" height="62" rx="31" fill="${fill}" stroke="${CYAN}" stroke-width="3"/>
    <g transform="translate(28 9) scale(.96)">${letters(ink, 9)}</g>
  </svg>`;
}

/** The mark alone at icon sizes, for the favicon: a round button, a dark display and two lit eyes. */
export function favicon(size = 32, { bg = '#0a0f1c' } = {}) {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Botons">
    <rect width="32" height="32" rx="8" fill="${bg}"/>
    <circle cx="16" cy="18.4" r="11.2" fill="#9aa6b8"/>
    <circle cx="16" cy="17" r="11.2" fill="#eef2f7" stroke="${CYAN}" stroke-width="1"/>
    <rect x="8.4" y="11.6" width="15.2" height="10" rx="5" fill="${GLASS}"/>
    <circle cx="12.6" cy="16.2" r="1.9" fill="${CYAN}"/><circle cx="19.4" cy="16.2" r="1.9" fill="${CYAN}"/>
    <circle cx="16" cy="3.4" r="2" fill="${CYAN}"/>
  </svg>`;
}

/** The app icon: the brand Boton lit up over a light-cycle floor, for the PWA and home screens. */
export function appIcon(uid = 'ai', { size = 180 } = {}) {
  const v = [-30, -6, 18, 42, 66, 90, 114, 138].map((x) => `M${50 + (x - 50) * .18} 64L${x} 100`).join('');
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Botons app icon">
    <defs><linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16214a"/><stop offset=".62" stop-color="#0a0f1f"/><stop offset="1" stop-color="#05070d"/></linearGradient>
    <radialGradient id="${uid}gl" cx=".5" cy=".64" r=".5"><stop offset="0" stop-color="${CYAN}" stop-opacity=".35"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient>
    <clipPath id="${uid}sq"><rect width="100" height="100" rx="22"/></clipPath></defs>
    <g clip-path="url(#${uid}sq)"><rect width="100" height="100" fill="url(#${uid}bg)"/>
    <g stroke="${CYAN}" stroke-opacity=".32" stroke-width=".7" fill="none"><path d="M0 64H100M0 69H100M0 76H100M0 86H100M0 99H100${v}"/></g>
    <ellipse cx="50" cy="86" rx="36" ry="9" fill="url(#${uid}gl)"/>
    <g transform="translate(10 10) scale(.8)">${botInner(BRAND_LOOK, { uid: uid + 'b', size: 180, frame: 'none', still: true })}</g></g>
  </svg>`;
}
