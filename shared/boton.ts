import type { AvatarState, BotonLook } from './types.ts';
import { BACKDROPS, DARK_BACKDROPS, drawableLook, GLOWS, SHELLS } from './look.ts';

// The Boton renderer: a pure function from (look, state, size) to SVG markup in a 100 × 100 frame. The web avatar,
// the builder and the snapshot tests all draw through it. Every value it writes comes from the look's fixed names
// or from numbers computed here, never from free text. A Boton is a body seen from the front with a little depth
// (each part of it a cap over a darker skirt), a rim of light, a dark glass display with its face lit on it, and
// layered parts: arms, top, ears, the body, the display and face, visor, panel, then the state's cues. Feet go under
// it all, and make room by drawing the rest a little smaller. Glow is drawn with a soft wide stroke under the crisp
// one, never an SVG filter, so a sidebar of Botons stays cheap.

/** Detail by size, like optical sizes in type: 0 up to 28 px (silhouette, rim, face, top, feet, state), 1 up to 72 px, 2 above. */
export type Lod = 0 | 1 | 2;
export const lodFor = (px: number): Lod => (px <= 28 ? 0 : px <= 72 ? 1 : 2);

export const STATES: readonly AvatarState[] = ['idle', 'working', 'approval', 'error', 'asleep'];

/** The display glass: every glow keeps 7:1 on it, in both themes. */
export const GLASS = '#0a0f1c';
/** How far the skirt (the button's side) darkens the shell: with the rim light, it keeps every shell at 3:1 on every backdrop. */
export const SKIRT = 0.5;
const ERR = '#ff6b6b';
const WARN = '#ffbe45';
export const OFF = '#56607a';
/** The rim with no brain: unlit, but still an edge at 3:1 on the dark backdrops. */
export const OFF_RIM = '#8e98ab';
const CHEEK = '#ff7eb6';
/** Fixed colors for parts that keep their own color on any shell: a gold crown and a green sprout. */
const GOLD = '#f4c53d';
const GOLD_EDGE = '#9a7410';
const LEAF = '#62cf7d';
const LEAF_EDGE = '#3f9e5a';
/** With feet, the rest of the Boton is drawn this much smaller, about a point near its top, to make room below. */
export const FEET_SCALE = 0.86;
const FEET_PIVOT = 12;
const n = (v: number) => Math.round(v * 100) / 100;
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a: string, b: string, t: number) => {
  const A = rgb(a);
  const B = rgb(b);
  return hex(A.map((v, i) => v + (B[i] - v) * t));
};
export const skirtOf = (shell: string) => mix(shell, '#05070d', SKIRT);

interface Ctx {
  state: AvatarState;
  lod: Lod;
  /** A prefix for ids, unique in the page. */
  uid: string;
  /** Animation classes (off for still images). */
  motion: boolean;
  shell: string;
  skirt: string;
  glow: string;
  /** Lit: its light is on (it has a brain). */
  lit: boolean;
  /** Soft halos under lit strokes (from detail 1). */
  halo: boolean;
}
const cls = (c: Ctx, name: string) => (c.motion && name ? ` class="${name}"` : '');

/**
 * One part of a body: a circle, a rounded rect (`k` a keycap, whose skirt flares), or a drawn outline with the circle
 * (cy, r) its busy ring follows. `tone: 'deep'` fills it a little darker than the shell (the arcade button's base).
 */
type Cap = ({ kind: 'c'; cx: number; cy: number; r: number } | { kind: 'r' | 'k'; x: number; y: number; w: number; h: number; rx: number } | { kind: 'p'; d: string; cy: number; r: number }) & { tone?: 'deep' };
interface Shape {
  /** The body's parts, back to front. The last one carries the face: the busy ring and the highlight follow it. */
  caps: readonly Cap[];
  /** The top of the body, where the top part sits. */
  top: number;
  /** The body's outer edge at eye height, where side ears sit. */
  side: number;
  /** Eye line. */
  ey: number;
  /** The display. */
  d: { x: number; y: number; w: number; h: number; rx: number };
  /** The panel's center line. */
  p: number;
  /** Arm anchors. */
  ax: number;
  ay: number;
  /** Half the distance between the eyes. */
  dx: number;
  /** Ears that sit on top (cat, bear): their spread from the middle, and their height. */
  ear: readonly [number, number];
  /** The lowest point of the body with its skirt, where feet attach. */
  bottom: number;
  /** A glass canopy drawn as the display, under the body's parts (the saucer). */
  glass?: string;
  /** The highlight, where the last cap's own doesn't fit. */
  hl?: string;
  /** Where the needs-you and error markers sit, where the last cap's own place doesn't fit. */
  mark?: readonly [number, number];
  /** The circle (cy, r) the busy ring follows, where the last cap's own doesn't fit (the arcade button's dome, not its base). */
  ring?: readonly [number, number];
}

const HEX = 'M78.9 51.36Q81 55 78.9 58.64L67.6 78.21Q65.5 81.85 61.3 81.85L38.7 81.85Q34.5 81.85 32.4 78.21L21.1 58.64Q19 55 21.1 51.36L32.4 31.79Q34.5 28.15 38.7 28.15L61.3 28.15Q65.5 28.15 67.6 31.79Z';
const COG = 'M75.64 59.29L80.08 62.5A31 31 0 0 1 76.57 70.97L71.17 70.1A26 26 0 0 1 65.1 76.17L65.97 81.57A31 31 0 0 1 57.5 85.08L54.29 80.64A26 26 0 0 1 45.71 80.64L42.5 85.08A31 31 0 0 1 34.03 81.57L34.9 76.17A26 26 0 0 1 28.83 70.1L23.43 70.97A31 31 0 0 1 19.92 62.5L24.36 59.29A26 26 0 0 1 24.36 50.71L19.92 47.5A31 31 0 0 1 23.43 39.03L28.83 39.9A26 26 0 0 1 34.9 33.83L34.03 28.43A31 31 0 0 1 42.5 24.92L45.71 29.36A26 26 0 0 1 54.29 29.36L57.5 24.92A31 31 0 0 1 65.97 28.43L65.1 33.83A26 26 0 0 1 71.17 39.9L76.57 39.03A31 31 0 0 1 80.08 47.5L75.64 50.71A26 26 0 0 1 75.64 59.29Z';
const PUFF = 'M30 82H70A12 12 0 0 0 78 61A13 13 0 0 0 64 44A15 15 0 0 0 36 44A13 13 0 0 0 22 61A12 12 0 0 0 30 82Z';

const SHAPES: Record<BotonLook['shape'], Shape> = {
  round: { caps: [{ kind: 'c', cx: 50, cy: 55, r: 29 }], top: 26, side: 21, ey: 53, d: { x: 31, y: 40, w: 38, h: 25, rx: 11 }, p: 74, ax: 25, ay: 68, dx: 8.36, ear: [18, 33], bottom: 89 },
  pill: { caps: [{ kind: 'r', x: 12, y: 38, w: 76, h: 42, rx: 21 }], top: 38, side: 12, ey: 59, d: { x: 27, y: 45, w: 46, h: 24, rx: 11 }, p: 74.5, ax: 16, ay: 70, dx: 10, ear: [22, 40], bottom: 85 },
  key: { caps: [{ kind: 'k', x: 20, y: 27, w: 60, h: 54, rx: 12 }], top: 27, side: 17, ey: 49, d: { x: 29, y: 35, w: 42, h: 26, rx: 8 }, p: 71, ax: 19, ay: 72, dx: 9.24, ear: [20, 29], bottom: 87.5 },
  // A tower: a tall capsule standing up, its face high and room for a chest below.
  tall: { caps: [{ kind: 'r', x: 30, y: 20, w: 40, h: 66, rx: 20 }], top: 20, side: 30, ey: 42.5, d: { x: 34, y: 31, w: 32, h: 24, rx: 10 }, p: 68, ax: 31, ay: 64, dx: 7, ear: [12, 24], bottom: 91, hl: 'M36.4 30.6Q39.6 24.4 46 23.4', mark: [67, 24] },
  // Two buttons stacked: the face on the head, the panel and arms on the body below.
  stack: { caps: [{ kind: 'c', cx: 50, cy: 69, r: 16 }, { kind: 'c', cx: 50, cy: 38, r: 19 }], top: 19, side: 31, ey: 37.5, d: { x: 36.5, y: 28.5, w: 27, h: 19, rx: 9 }, p: 71, ax: 35, ay: 70, dx: 6.2, ear: [12, 25], bottom: 90, mark: [66, 22] },
  // An arcade button: a tall dome set into a darker base.
  dome: { caps: [{ kind: 'p', d: 'M22 72A28 36 0 0 1 78 72Z', cy: 58, r: 30 }, { kind: 'r', x: 14, y: 68, w: 72, h: 15, rx: 6, tone: 'deep' }], top: 36, side: 25, ey: 56, d: { x: 33, y: 45, w: 34, h: 21, rx: 10.5 }, p: 75.5, ax: 15, ay: 75, dx: 7.4, ear: [16, 44], bottom: 88, hl: 'M30.6 56Q31.6 44.2 42.4 39', mark: [71, 40], ring: [58, 30] },
  // A hex nut, flat on top and bottom.
  hex: { caps: [{ kind: 'p', d: HEX, cy: 55, r: 31 }], top: 28, side: 21, ey: 53.5, d: { x: 31, y: 41, w: 38, h: 24, rx: 9 }, p: 73, ax: 27, ay: 68, dx: 8.4, ear: [13, 30], bottom: 87, hl: 'M24.6 51Q27.4 43.4 33 35.4', mark: [71, 33] },
  // A cog with eight teeth, a gap at the top for whatever it wears.
  gear: { caps: [{ kind: 'p', d: COG, cy: 55, r: 31 }], top: 29, side: 24, ey: 54.5, d: { x: 31, y: 42, w: 38, h: 24, rx: 11 }, p: 73, ax: 26, ay: 68, dx: 8.4, ear: [15, 32], bottom: 90, hl: 'M29.4 47.6Q32.4 38.4 41.6 33.6', mark: [72, 32] },
  // A puff of cloud: three soft bumps on a flat base.
  cloud: { caps: [{ kind: 'p', d: PUFF, cy: 58, r: 29 }], top: 34, side: 22, ey: 59.5, d: { x: 30, y: 47, w: 40, h: 24, rx: 11 }, p: 76.5, ax: 23, ay: 72, dx: 8.4, ear: [16, 43], bottom: 87, hl: 'M25.4 57Q26.6 49.6 33 46.6', mark: [71, 40] },
  // A saucer: a wide disc with the face under a glass canopy.
  saucer: { caps: [{ kind: 'p', d: 'M12 70a38 10 0 1 0 76 0a38 10 0 1 0 -76 0Z', cy: 58, r: 30 }], top: 40, side: 34, ey: 50.5, d: { x: 35, y: 41, w: 30, h: 20, rx: 10 }, p: 70, ax: 13, ay: 72, dx: 6.4, ear: [13, 47], bottom: 85, glass: 'M30 64A20 24 0 0 1 70 64Z', hl: 'M17.6 66.6Q24 62.6 34 61.4', mark: [70, 44] },
};
const faceCap = (s: Shape) => s.caps[s.caps.length - 1];
const my = (s: Shape) => n(s.d.y + s.d.h * 0.74);

/** A cap, or (dy, grow) the skirt under it. A drawn outline's skirt grows by a stroke of `grow`'s color. */
function capEl(c: Cap, attrs: string, dy = 0, grow = 0, growColor = ''): string {
  if (c.kind === 'c') return `<circle cx="${c.cx}" cy="${n(c.cy + dy)}" r="${n(c.r + grow)}" ${attrs}/>`;
  if (c.kind === 'p') return `<path d="${c.d}"${dy ? ` transform="translate(0 ${dy})"` : ''} ${attrs}${grow ? ` stroke="${growColor}" stroke-width="${n(grow * 2)}"` : ''}/>`;
  const g = c.kind === 'k' && grow ? grow + 2 : grow;
  return `<rect x="${n(c.x - g)}" y="${n(c.y + dy)}" width="${n(c.w + g * 2)}" height="${n(c.h + (c.kind === 'k' ? grow * 2 : 0))}" rx="${n(c.rx + g / 2)}" ${attrs}/>`;
}

/** A lit stroke: a soft wide halo under the crisp line. */
function lit(d: string, col: string, w: number, halo: boolean): string {
  const base = `stroke="${col}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  return `${halo ? `<path d="${d}" ${base} stroke-width="${n(w + 3.4)}" stroke-opacity=".22"/>` : ''}<path d="${d}" ${base} stroke-width="${w}"/>`;
}
const dot = (x: number, y: number, r: number, col: string, halo: boolean) => `${halo ? `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r + 2)}" fill="${col}" opacity=".22"/>` : ''}<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${col}"/>`;
/** A heart about 2w wide, its middle at (x, y). */
const heart = (x: number, y: number, w: number) =>
  `M${n(x)} ${n(y + w * 0.78)}C${n(x - w * 0.24)} ${n(y + w * 0.6)} ${n(x - w)} ${n(y + w * 0.1)} ${n(x - w)} ${n(y - w * 0.36)}C${n(x - w)} ${n(y - w * 0.78)} ${n(x - w * 0.66)} ${n(y - w)} ${n(x - w * 0.4)} ${n(y - w)}C${n(x - w * 0.18)} ${n(y - w)} ${n(x)} ${n(y - w * 0.82)} ${n(x)} ${n(y - w * 0.58)}C${n(x)} ${n(y - w * 0.82)} ${n(x + w * 0.18)} ${n(y - w)} ${n(x + w * 0.4)} ${n(y - w)}C${n(x + w * 0.66)} ${n(y - w)} ${n(x + w)} ${n(y - w * 0.78)} ${n(x + w)} ${n(y - w * 0.36)}C${n(x + w)} ${n(y + w * 0.1)} ${n(x + w * 0.24)} ${n(y + w * 0.6)} ${n(x)} ${n(y + w * 0.78)}Z`;

type EyeKind = BotonLook['eyes'] | 'closed' | 'wide' | 'down' | 'worried';
function eyes(kind: EyeKind, s: Shape, c: Ctx, col: string, single: boolean): string {
  const { ey, dx } = s;
  const h = c.halo;
  const one = (x: number, k: EyeKind): string => {
    switch (k) {
      case 'rings': return lit(`M${n(x - 3.6)} ${ey}a3.6 3.6 0 1 0 7.2 0a3.6 3.6 0 1 0 -7.2 0`, col, 2.2, h);
      case 'bars': return lit(`M${n(x)} ${n(ey - 3.4)}V${n(ey + 3.4)}`, col, 4.2, h);
      case 'happy': return lit(`M${n(x - 4)} ${n(ey + 1.6)}Q${n(x)} ${n(ey - 4.4)} ${n(x + 4)} ${n(ey + 1.6)}`, col, 2.6, h);
      case 'lidded': return `<path d="M${n(x - 4)} ${n(ey - 0.6)}H${n(x + 4)}a4 4 0 0 1 -8 0Z" fill="${col}"/>`;
      case 'closed': return lit(`M${n(x - 3.6)} ${n(ey + 0.6)}Q${n(x)} ${n(ey + 3)} ${n(x + 3.6)} ${n(ey + 0.6)}`, col, 2, false);
      case 'wide': return `${dot(x, ey, 4.4, col, h)}<circle cx="${n(x + 1.2)}" cy="${n(ey - 1.4)}" r="1.4" fill="${GLASS}"/>`;
      case 'down': return dot(x, ey + 1.6, 3.2, col, h);
      case 'worried': return dot(x, ey + 0.6, 3.2, col, h);
      case 'cyclops': return `${dot(x, ey, 5.4, col, h)}<circle cx="${n(x + 0.9)}" cy="${n(ey - 0.4)}" r="2.3" fill="${GLASS}"/>`;
      case 'stars': {
        const d = `M${n(x)} ${n(ey - 4.6)}Q${n(x + 0.8)} ${n(ey - 0.8)} ${n(x + 4.6)} ${n(ey)}Q${n(x + 0.8)} ${n(ey + 0.8)} ${n(x)} ${n(ey + 4.6)}Q${n(x - 0.8)} ${n(ey + 0.8)} ${n(x - 4.6)} ${n(ey)}Q${n(x - 0.8)} ${n(ey - 0.8)} ${n(x)} ${n(ey - 4.6)}Z`;
        return `${h ? `<circle cx="${n(x)}" cy="${n(ey)}" r="4" fill="${col}" opacity=".22"/>` : ''}<path d="${d}" fill="${col}"/>`;
      }
      case 'hearts': return `${h ? `<circle cx="${n(x)}" cy="${n(ey)}" r="5.2" fill="${col}" opacity=".22"/>` : ''}<path d="${heart(x, ey, 4)}" fill="${col}"/>`;
      case 'pixels': return `${h ? `<rect x="${n(x - 4.8)}" y="${n(ey - 4.8)}" width="9.6" height="9.6" rx="1.6" fill="${col}" opacity=".22"/>` : ''}<rect x="${n(x - 3.2)}" y="${n(ey - 3.2)}" width="6.4" height="6.4" rx=".6" fill="${col}"/>`;
      default: return dot(x, ey, 3.6, col, h);
    }
  };
  if (kind === 'wink') return one(50 - dx, 'dots') + lit(`M${n(50 + dx - 4)} ${ey}Q${n(50 + dx)} ${n(ey + 2.4)} ${n(50 + dx + 4)} ${ey}`, col, 2.6, h);
  // One eye looks out from the middle, whatever the state.
  const inner = single ? one(50, kind) : one(50 - dx, kind) + one(50 + dx, kind);
  return `<g${cls(c, c.state === 'idle' ? 'av-blink' : '')}>${inner}</g>`;
}

type BrowKind = BotonLook['brows'] | 'worried' | 'focused';
function brows(kind: BrowKind, s: Shape, c: Ctx, col: string): string {
  const y = s.ey - 7.4;
  const L = 50 - s.dx;
  const R = 50 + s.dx;
  const p: Record<Exclude<BrowKind, 'none'>, [string, string, number]> = {
    soft: [`M${n(L - 3.6)} ${n(y + 0.6)}Q${n(L)} ${n(y - 1.4)} ${n(L + 3.6)} ${n(y + 0.6)}`, `M${n(R - 3.6)} ${n(y + 0.6)}Q${n(R)} ${n(y - 1.4)} ${n(R + 3.6)} ${n(y + 0.6)}`, 1.8],
    straight: [`M${n(L - 3.6)} ${n(y)}H${n(L + 3.6)}`, `M${n(R - 3.6)} ${n(y)}H${n(R + 3.6)}`, 2],
    arched: [`M${n(L - 4)} ${n(y + 1.4)}Q${n(L)} ${n(y - 3)} ${n(L + 4)} ${n(y + 1.4)}`, `M${n(R - 4)} ${n(y + 1.4)}Q${n(R)} ${n(y - 3)} ${n(R + 4)} ${n(y + 1.4)}`, 1.9],
    bold: [`M${n(L - 4)} ${n(y - 0.4)}L${n(L + 4)} ${n(y + 1)}`, `M${n(R - 4)} ${n(y + 1)}L${n(R + 4)} ${n(y - 0.4)}`, 3],
    worried: [`M${n(L - 4)} ${n(y + 1.6)}L${n(L + 3.4)} ${n(y - 0.8)}`, `M${n(R - 3.4)} ${n(y - 0.8)}L${n(R + 4)} ${n(y + 1.6)}`, 2],
    focused: [`M${n(L - 4)} ${n(y - 0.2)}L${n(L + 4)} ${n(y + 1.4)}`, `M${n(R - 4)} ${n(y + 1.4)}L${n(R + 4)} ${n(y - 0.2)}`, 2],
  };
  if (kind === 'none') return '';
  const [a, b, w] = p[kind];
  return lit(`${a}${b}`, col, w, c.halo);
}

type MouthKind = BotonLook['mouth'] | 'dots' | 'wobbly' | 'flat';
function mouth(kind: MouthKind, s: Shape, c: Ctx, col: string): string {
  const y = my(s);
  const h = c.halo;
  switch (kind) {
    case 'grin': return `<path d="M44.4 ${n(y - 1.2)}H55.6a5.6 5 0 0 1 -11.2 0Z" fill="${col}"/>`;
    case 'smirk': return lit(`M45 ${n(y + 0.4)}Q51 ${n(y + 2.6)} 55.6 ${n(y - 1.6)}`, col, 2.4, h);
    case 'o': return lit(`M47.4 ${y}a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0`, col, 2.2, h);
    case 'calm': return lit(`M46 ${y}H54`, col, 2.4, h);
    case 'wave': return lit(`M43.4 ${y}q1.65 -3 3.3 0t3.3 0t3.3 0t3.3 0`, col, 2, h);
    case 'dots': return `<g fill="${col}"><circle cx="45.6" cy="${y}" r="1.6"/><circle cx="50" cy="${y}" r="1.6"/><circle cx="54.4" cy="${y}" r="1.6"/></g>`;
    case 'wobbly': return lit(`M44.6 ${n(y + 1.2)}q2.7 -2.6 5.4 0t5.4 0`, col, 2.2, h);
    case 'flat': return lit(`M46.6 ${n(y + 0.6)}H53.4`, col, 2, false);
    case 'tongue': return `<path d="M47.8 ${n(y + 1.1)}h4.4v1.2a2.2 2.2 0 0 1 -4.4 0Z" fill="${CHEEK}"/>${lit(`M44.6 ${n(y - 1)}Q50 ${n(y + 4)} 55.4 ${n(y - 1)}`, col, 2.6, h)}`;
    case 'teeth': return `<rect x="44.2" y="${n(y - 2.6)}" width="11.6" height="5.4" rx="1.6" fill="${col}"/><path d="M44.2 ${n(y + 0.1)}H55.8M48.1 ${n(y - 2.6)}V${n(y + 2.8)}M51.9 ${n(y - 2.6)}V${n(y + 2.8)}" stroke="${GLASS}" stroke-width=".9"/>`;
    default: return lit(`M44.6 ${n(y - 1)}Q50 ${n(y + 4)} 55.4 ${n(y - 1)}`, col, 2.6, h);
  }
}

function top(kind: BotonLook['top'], s: Shape, c: Ctx): string {
  const t = s.top;
  const { shell, skirt: sk, glow, lit: on, halo } = c;
  const ball = (x: number, y: number, r = 3.4) => `${on && halo ? `<circle cx="${x}" cy="${n(y)}" r="${n(r + 2.6)}" fill="${glow}" opacity=".25"/>` : ''}<circle cx="${x}" cy="${n(y)}" r="${r}" fill="${on ? glow : sk}" stroke="${sk}" stroke-width="1.2"/>`;
  const stem = (d: string, w = 2.6) => `<path d="${d}" stroke="${sk}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  switch (kind) {
    case 'antenna': return stem(`M50 ${t + 1}V${t - 13}`) + ball(50, t - 15);
    case 'twin': return stem(`M44 ${t + 2}L38 ${t - 11}M56 ${t + 2}L62 ${t - 11}`) + ball(37, t - 13, 3) + ball(63, t - 13, 3);
    case 'dish': return stem(`M50 ${t + 1}V${t - 7}`) + `<path d="M39 ${t - 15}Q50 ${t - 2} 61 ${t - 15}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round" transform="rotate(-16 50 ${t - 9})"/>` + ball(50, t - 12, 1.8);
    case 'coil': return stem(`M50 ${t + 1}V${t - 2}l-4 -2.2 8 -2.6 -8 -2.6 8 -2.6 -4 -2.2`, 2.2) + ball(50, t - 16, 3.2);
    // A crest of three soft bumps (stored as 'fin').
    case 'fin': return `<path d="M39 ${t + 3}C38 ${t - 4} 43 ${t - 6} 45 ${t - 3}C45 ${t - 11} 55 ${t - 11} 55 ${t - 3}C57 ${t - 6} 62 ${t - 4} 61 ${t + 3}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/>${on && c.lod ? lit(`M46.6 ${t - 5}Q50 ${n(t - 9.4)} 53.4 ${t - 5}`, glow, 1.6, halo) : ''}`;
    case 'beacon': return `<rect x="42" y="${t - 3}" width="16" height="5" rx="2" fill="${sk}"/><path d="M43.5 ${t - 3}a6.5 6.5 0 0 1 13 0Z" fill="${on ? glow : mix(sk, '#ffffff', 0.3)}" stroke="${sk}" stroke-width="1.2"/>`;
    case 'halo': return on ? lit(`M33 ${t - 9}a17 5 0 1 0 34 0a17 5 0 1 0 -34 0`, glow, 2.2, halo) : `<ellipse cx="50" cy="${t - 9}" rx="17" ry="5" fill="none" stroke="${sk}" stroke-width="2.2"/>`;
    case 'propeller': return stem(`M50 ${t + 1}V${t - 6}`, 2.2) + `<path d="M36.8 ${t - 7}a6.6 2.2 0 1 0 13.2 0a6.6 2.2 0 1 0 -13.2 0ZM50 ${t - 7}a6.6 2.2 0 1 0 13.2 0a6.6 2.2 0 1 0 -13.2 0Z" fill="${shell}" stroke="${sk}" stroke-width="1.2"/>` + ball(50, t - 7, 2);
    case 'crown': return `<path d="M40 ${t + 2}V${t - 7}l5 4 5 -7 5 7 5 -4V${t + 2}Z" fill="${GOLD}" stroke="${GOLD_EDGE}" stroke-width="1.4" stroke-linejoin="round"/>${c.lod ? `<circle cx="50" cy="${t - 1.6}" r="1.7" fill="${on ? glow : GOLD_EDGE}"/>` : ''}`;
    case 'sprout': return `<path d="M50 ${t + 1}Q49 ${t - 4} 50 ${t - 8}" stroke="${LEAF_EDGE}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M50 ${t - 6}Q42 ${t - 6} 40 ${t - 12}Q47 ${t - 13} 50 ${t - 6}ZM50 ${t - 8}Q57 ${t - 9} 61 ${t - 15}Q53 ${t - 16} 50 ${t - 8}Z" fill="${LEAF}" stroke="${LEAF_EDGE}" stroke-width="1.2" stroke-linejoin="round"/>`;
    default: return '';
  }
}

function ears(kind: BotonLook['ears'], s: Shape, c: Ctx): string {
  const { ey } = s;
  const { shell, skirt: sk, glow, lit: on } = c;
  const L = s.side + 1;
  const R = 100 - s.side - 1;
  const [spread, ty] = s.ear;
  switch (kind) {
    case 'bolts': return [L, R].map((x) => `<rect x="${x - 4}" y="${ey - 4}" width="8" height="8" rx="2" fill="${sk}"/><circle cx="${x + (x < 50 ? -1 : 1)}" cy="${ey}" r="1.6" fill="${shell}"/>`).join('');
    case 'pods': return [L - 2, R + 2].map((x) => `<rect x="${n(x - 4.6)}" y="${ey - 9}" width="9.2" height="18" rx="4.6" fill="${shell}" stroke="${sk}" stroke-width="1.8"/>${on ? `<rect x="${x - 1}" y="${ey - 5}" width="2" height="10" rx="1" fill="${glow}"/>` : ''}`).join('');
    // Cooling fins: three rounded slats out of each side, in one path.
    case 'fins': return `<path d="${([[L, -1], [R, 1]] as const).map(([x, side]) => [[-6.5, 9], [-1.5, 10.5], [3.5, 9]].map(([dy, w]) => `M${n(side < 0 ? x - w + 2.5 : x + 0.5)} ${n(ey + dy)}h${n(w - 3)}a1.5 1.5 0 0 1 0 3h${n(3 - w)}a1.5 1.5 0 0 1 0 -3Z`).join('')).join('')}" fill="${sk}"/>`;
    case 'knobs': return ([[L, -1], [R, 1]] as const).map(([x, side]) => `<rect x="${side < 0 ? x - 5 : x}" y="${ey - 2}" width="5" height="4" fill="${sk}"/><circle cx="${x + side * 7}" cy="${ey}" r="3.8" fill="${on ? glow : shell}" stroke="${sk}" stroke-width="1.6"/>`).join('');
    case 'cat': return ([-1, 1] as const).map((side) => {
      const x = 50 + side * spread;
      const ear = `M${n(x - side * 6.5)} ${n(ty + 3)}L${n(x + side * 3.6)} ${n(ty - 12)}L${n(x + side * 6)} ${n(ty + 1.5)}Z`;
      const inner = `M${n(x - side * 2.8)} ${n(ty + 1.2)}L${n(x + side * 3)} ${n(ty - 7.5)}L${n(x + side * 3.8)} ${n(ty + 0.6)}Z`;
      return `<path d="${ear}" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/><path d="${inner}" fill="${CHEEK}" opacity=".7"/>`;
    }).join('');
    case 'bear': return ([-1, 1] as const).map((side) => {
      const x = n(50 + side * (spread + 1));
      return `<circle cx="${x}" cy="${n(ty - 2)}" r="6.2" fill="${shell}" stroke="${sk}" stroke-width="1.6"/><circle cx="${x}" cy="${n(ty - 2)}" r="3.1" fill="${CHEEK}" opacity=".6"/>`;
    }).join('');
    default: return '';
  }
}

function visor(kind: BotonLook['visor'], s: Shape, c: Ctx): string {
  const { ey, dx, d } = s;
  const L = n(50 - dx);
  const R = n(50 + dx);
  const { skirt: sk, glow } = c;
  switch (kind) {
    case 'goggles': return `<g fill="${glow}" fill-opacity=".12" stroke="${sk}" stroke-width="2.4"><circle cx="${L}" cy="${ey}" r="6.6"/><circle cx="${R}" cy="${ey}" r="6.6"/></g><path d="M${n(L + 6.6)} ${ey}H${n(R - 6.6)}M${d.x - 1} ${ey}H${n(L - 6.6)}M${n(R + 6.6)} ${ey}H${d.x + d.w + 1}" stroke="${sk}" stroke-width="2.4"/>`;
    case 'monocle': return `<circle cx="${R}" cy="${ey}" r="7" fill="${glow}" fill-opacity=".1" stroke="${sk}" stroke-width="2.4"/><path d="M${n(R + 5)} ${ey + 5}Q${n(R + 9)} ${ey + 12} ${n(R + 6)} ${d.y + d.h + 3}" stroke="${sk}" stroke-width="1.2" fill="none"/>`;
    case 'band': return `<rect x="${d.x - 2}" y="${n(ey - 5.6)}" width="${d.w + 4}" height="11.2" rx="5.6" fill="${glow}" fill-opacity=".16" stroke="${glow}" stroke-opacity=".7" stroke-width="1.4"/>`;
    case 'shades': return `<g fill="${GLASS}" fill-opacity=".94" stroke="${sk}" stroke-width="1.4"><rect x="${n(L - 6)}" y="${n(ey - 3.8)}" width="12" height="7.6" rx="3"/><rect x="${n(R - 6)}" y="${n(ey - 3.8)}" width="12" height="7.6" rx="3"/></g><path d="M${n(L + 6)} ${n(ey - 1.6)}H${n(R - 6)}M${d.x - 1} ${n(ey - 1.6)}H${n(L - 6)}M${n(R + 6)} ${n(ey - 1.6)}H${d.x + d.w + 1}" stroke="${sk}" stroke-width="1.6"/><path d="M${n(L - 3.6)} ${n(ey - 1.2)}l2.4 -1.4M${n(R - 3.6)} ${n(ey - 1.2)}l2.4 -1.4" stroke="#ffffff" stroke-opacity=".55" stroke-width="1.1" stroke-linecap="round"/>`;
    default: return '';
  }
}

function panel(kind: BotonLook['panel'], s: Shape, c: Ctx): string {
  const y = s.p;
  const { skirt: sk, glow, lit: on, shell } = c;
  switch (kind) {
    case 'holes': return `<g fill="${sk}"><circle cx="46.6" cy="${n(y - 2.2)}" r="1.5"/><circle cx="53.4" cy="${n(y - 2.2)}" r="1.5"/><circle cx="46.6" cy="${n(y + 2.2)}" r="1.5"/><circle cx="53.4" cy="${n(y + 2.2)}" r="1.5"/></g>`;
    case 'grill': return `<path d="M44 ${n(y - 2.6)}H56M43 ${y}H57M44 ${n(y + 2.6)}H56" stroke="${sk}" stroke-width="1.8" stroke-linecap="round"/>`;
    case 'leds': return [44, 50, 56].map((x, i) => `<circle cx="${x}" cy="${y}" r="2" fill="${on ? (i === 1 ? glow : mix(glow, sk, 0.55)) : sk}"/>`).join('');
    case 'dial': return `<circle cx="50" cy="${y}" r="4.2" fill="${mix(shell, '#ffffff', 0.25)}" stroke="${sk}" stroke-width="1.6"/><path d="M50 ${y}L52.4 ${n(y - 2.4)}" stroke="${sk}" stroke-width="1.6" stroke-linecap="round"/>`;
    case 'switch': return `<rect x="44" y="${n(y - 2.6)}" width="12" height="5.2" rx="2.6" fill="${sk}"/><circle cx="${on ? 53.4 : 46.6}" cy="${y}" r="2.1" fill="${on ? glow : shell}"/>`;
    case 'heart': return `<path d="${heart(50, y, 3.6)}" fill="${on ? glow : sk}" stroke="${sk}" stroke-width=".8"/>`;
    case 'bolt': return `<path d="M51.2 ${n(y - 4.4)}L46.6 ${n(y + 0.6)}H49.8L48.6 ${n(y + 4.4)}L53.4 ${n(y - 0.8)}H50.2Z" fill="${on ? glow : sk}" stroke="${sk}" stroke-width=".8" stroke-linejoin="round"/>`;
    default: return '';
  }
}

/** Arms behind the body. Needs you raises the right one; the left keeps its pose. Every arm ends in a hand or a claw. */
function arms(kind: BotonLook['arms'], s: Shape, c: Ctx): string {
  const k = c.state === 'approval' ? 'raise' : kind;
  if (k === 'none') return '';
  const { ax, ay } = s;
  const L = ax;
  const R = 100 - ax;
  const sk = c.skirt;
  const arm = (d: string, w = 5.4) => `<path d="${d}" stroke="${sk}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
  const hand = (x: number, y: number, r = 3.3) => `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${sk}"/>`;
  // Hanging down at its side, a hand at the end: an arm, not a fin.
  const down = (x: number, side: number) => arm(`M${x} ${ay}q${side * 4.5} 1.5 ${side * 5} 7.5`, 4.2) + hand(x + side * 5, ay + 8.6);
  const up = (x: number, side: number) => arm(`M${x + side * 2} ${ay - 3}l${side * 9} -13`) + `<circle cx="${x + side * 11}" cy="${ay - 17}" r="3.6" fill="${sk}"/>`;
  const claw = (x: number, side: number) => arm(`M${x} ${ay}l${side * 6} 4`, 4.2) + `<path d="M${x + side * 6} ${ay + 4}l${side * 3.6} -2.8M${x + side * 6} ${ay + 4}l${side * 3.6} 2.8" stroke="${sk}" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
  const noodle = (x: number, side: number) => arm(`M${x} ${ay}c${side * 5} 0 ${side * 3} 8 ${side * 8} 9`, 3.4) + hand(x + side * 8, ay + 9, 3);
  switch (k) {
    case 'wave': return down(L, -1) + up(R, 1);
    case 'raise': return (kind === 'none' ? '' : down(L, -1)) + `<g${cls(c, 'av-wave')} style="transform-origin:${R + 2}px ${ay - 3}px">${up(R, 1)}</g>`;
    case 'cheer': return up(L, -1) + up(R, 1);
    case 'claws': return claw(L, -1) + claw(R, 1);
    case 'noodle': return noodle(L, -1) + noodle(R, 1);
    default: return down(L, -1) + down(R, 1);
  }
}

/** What it stands on, under the (smaller) body, whose skirt reaches `yb`. Drawn behind the body. */
function feet(kind: BotonLook['feet'], yb: number, c: Ctx): string {
  const { shell, skirt: sk, glow, lit: on, lod } = c;
  const dark = mix(sk, '#05070d', 0.4);
  switch (kind) {
    // Two legs, and both shoes in one path.
    case 'legs': return `<path d="M42 ${n(yb - 4)}V92.6M58 ${n(yb - 4)}V92.6" stroke="${sk}" stroke-width="4.4" stroke-linecap="round"/><path d="M37.5 90.6h5.6a2.5 2.5 0 0 1 0 5h-5.6a2.5 2.5 0 0 1 0 -5ZM56.9 90.6h5.6a2.5 2.5 0 0 1 0 5h-5.6a2.5 2.5 0 0 1 0 -5Z" fill="${lod ? shell : sk}"${lod ? ` stroke="${sk}" stroke-width="1.2"` : ''}/>`;
    case 'wheel': return `<path d="M50 ${n(yb - 4)}V88" stroke="${sk}" stroke-width="5" stroke-linecap="round"/><circle cx="50" cy="88.6" r="7.2" fill="${dark}" stroke="${sk}" stroke-width="1.2"/>${lod ? `<circle cx="50" cy="88.6" r="3.6" fill="${shell}"/><circle cx="50" cy="88.6" r="1.4" fill="${on ? glow : sk}"/>` : ''}`;
    case 'treads': {
      const y = n(yb - 2);
      const mid = n((yb - 2 + 94.6) / 2);
      return `<rect x="31" y="${y}" width="38" height="${n(94.6 - y)}" rx="6.5" fill="${dark}" stroke="${sk}" stroke-width="1.2"/>${lod ? [39, 50, 61].map((x) => `<circle cx="${x}" cy="${mid}" r="3" fill="${shell}" stroke="${sk}" stroke-width="1"/>`).join('') : ''}`;
    }
    case 'hover': return `<path d="M44 ${n(yb - 3)}h12l-2.4 6.4h-7.2Z" fill="${sk}"/>${on ? `${lod ? `<ellipse cx="50" cy="${n(yb + 7)}" rx="8" ry="7" fill="${glow}" opacity=".2"/><ellipse cx="50" cy="95" rx="14" ry="2.4" fill="${glow}" opacity=".3"/>` : ''}<path d="M45.8 ${n(yb + 3.4)}Q50 ${n(yb + 15)} 54.2 ${n(yb + 3.4)}Z" fill="${glow}" fill-opacity=".9"/>` : ''}`;
    case 'spring': return `<path d="M50 ${n(yb - 3)}l-5.5 3 11 3 -11 3 11 3 -11 3 5.5 1.5" stroke="${sk}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="50" cy="${n(yb + 15)}" rx="8.5" ry="2.6" fill="${sk}"/>`;
    default: return '';
  }
}

export interface BotonOptions {
  state?: AvatarState;
  /** Pixel size it's drawn at, which picks the detail level. */
  size?: number;
  lod?: Lod;
  uid?: string;
  /** No animation classes. */
  still?: boolean;
  /** The frame: a circle on the backdrop (avatars), a square on it, or none (the figure alone). */
  frame?: 'circle' | 'square' | 'none';
}

/** What goes inside <svg viewBox="0 0 100 100">. A part this build doesn't know draws as that part's first choice. */
export function botonInner(given: BotonLook, o: BotonOptions = {}): string {
  const look = drawableLook(given);
  const state = o.state ?? 'idle';
  const lod = o.lod ?? lodFor(o.size ?? 48);
  const uid = (o.uid ?? 'tt').replace(/[^A-Za-z0-9_-]/g, '');
  const s = SHAPES[look.shape];
  const off = state === 'asleep';
  // No brain: the shell a little greyer and the display dark, as if the lights are off.
  const shell = off ? mix(SHELLS[look.shell], '#8a92a3', 0.35) : SHELLS[look.shell];
  const glow = state === 'error' ? ERR : GLOWS[look.glow];
  const c: Ctx = { state, lod, uid, motion: !o.still, shell, skirt: skirtOf(shell), glow, lit: !off, halo: lod >= 1 && !off };
  const face = off ? OFF : glow;
  const onDark = DARK_BACKDROPS.includes(look.backdrop);
  const { d } = s;
  const main = faceCap(s);

  let fig = arms(look.arms, s, c);
  fig += top(look.top, s, c);
  if (lod >= 1) fig += ears(look.ears, s, c);
  let defs = '';
  if (lod >= 1) defs += `<linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(shell, '#ffffff', 0.22)}"/><stop offset=".55" stop-color="${shell}"/><stop offset="1" stop-color="${mix(shell, '#05070d', 0.12)}"/></linearGradient>`;
  // The display: dark glass, the face lit on it. A canopy goes under the body; a screen goes on it.
  const glassFill = off ? '#141927' : GLASS;
  const glassEdge = `stroke="${off ? OFF : glow}" stroke-opacity=".5" stroke-width="1.1"`;
  if (s.glass) fig += `<path d="${s.glass}" fill="${glassFill}" ${glassEdge}/>`;
  // Each part of the body: its skirt a little lower, then the cap, then a rim of light (off without a brain).
  for (const cap of s.caps) {
    const base = cap.tone === 'deep' ? mix(shell, '#05070d', 0.22) : shell;
    const skirt = cap.tone === 'deep' ? skirtOf(base) : c.skirt;
    fig += capEl(cap, `fill="${skirt}"`, 4.5, cap.kind === 'k' ? 1 : 0.5, skirt);
    fig += capEl(cap, `fill="${lod >= 1 && cap.tone !== 'deep' ? `url(#${uid}g)` : base}"`);
    fig += capEl(cap, `fill="none" stroke="${off ? OFF_RIM : glow}" stroke-width="${lod ? 1.3 : 1.8}" stroke-opacity=".9"`);
  }
  if (lod >= 1) {
    // A soft highlight on the body's upper left: it reads as a physical button.
    const hl = s.hl
      ?? (main.kind === 'c' ? `M${n(main.cx - main.r * 0.62)} ${n(main.cy - main.r * 0.5)}Q${n(main.cx - main.r * 0.25)} ${n(main.cy - main.r * 0.86)} ${n(main.cx + main.r * 0.1)} ${n(main.cy - main.r * 0.9)}`
        : main.kind === 'p' ? '' : `M${n(main.x + main.rx * 0.6)} ${main.y + 4}H${n(main.x + main.w * 0.45)}`);
    if (hl) fig += `<path d="${hl}" stroke="#fff" stroke-opacity=".45" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    // The saucer's running lights, along its disc either side of the panel.
    if (look.shape === 'saucer') fig += [21, 29, 71, 79].map((x) => `<circle cx="${x}" cy="70" r="1.6" fill="${off ? c.skirt : glow}"/>`).join('');
  }
  if (!s.glass) fig += `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="${d.rx}" fill="${glassFill}" ${glassEdge}/>`;
  if (lod >= 1 && !off) fig += `<path d="M${d.x + 4} ${n(d.y + 3.5)}H${n(d.x + d.w * 0.42)}" stroke="#fff" stroke-opacity=".14" stroke-width="1.6" stroke-linecap="round"/>`;
  if (state === 'error' && lod >= 1) fig += `<path d="M${d.x + 3} ${d.y + 6}h9M${d.x + d.w - 14} ${d.y + d.h - 5}h10" stroke="${ERR}" stroke-opacity=".45" stroke-width="1.2"/>`;
  // The face, by state. A state replaces the resting eyes, brows and mouth, so the mood always shows, visor or not.
  const [e, b, m]: [EyeKind, BrowKind, MouthKind] = {
    idle: [look.eyes, look.brows, look.mouth] as [EyeKind, BrowKind, MouthKind],
    working: ['down', 'focused', 'dots'] as [EyeKind, BrowKind, MouthKind],
    approval: ['wide', 'arched', 'o'] as [EyeKind, BrowKind, MouthKind],
    error: ['worried', 'worried', 'wobbly'] as [EyeKind, BrowKind, MouthKind],
    asleep: ['closed', 'none', 'flat'] as [EyeKind, BrowKind, MouthKind],
  }[state];
  if (look.cheeks && lod >= 1 && state === 'idle') fig += `<g fill="${CHEEK}" opacity=".55"><rect x="${n(50 - s.dx - 8)}" y="${s.ey + 5}" width="4.6" height="2.2" rx="1.1"/><rect x="${n(50 + s.dx + 3.4)}" y="${s.ey + 5}" width="4.6" height="2.2" rx="1.1"/></g>`;
  fig += brows(b, s, c, face) + eyes(e, s, c, face, look.eyes === 'cyclops') + mouth(m, s, c, face);
  if (lod >= 1 && state === 'idle') fig += visor(look.visor, s, c);
  if (lod >= 1) fig += panel(look.panel, s, c);

  // State cues beyond the face. Each one also has words wherever it's shown.
  if (state === 'working') {
    // A lit arc around the body, like a button that's busy: round about a round part or an outline's circle.
    let arc: string;
    let cy: number;
    const circle = s.ring ?? (main.kind === 'c' || main.kind === 'p' ? ([main.cy, main.r] as const) : null);
    if (circle) {
      const r = circle[1] + 6.5;
      arc = `M50 ${n(circle[0] - r)}a${n(r)} ${n(r)} 0 0 1 ${n(r * 0.87)} ${n(r * 1.5)}`;
      cy = circle[0];
    } else if (main.kind === 'r' || main.kind === 'k') {
      arc = `M${main.x + main.w / 2} ${main.y - 5}H${main.x + main.w - main.rx}q${main.rx + 5} 0 ${main.rx + 5} ${main.rx + 5}V${n(main.y + main.h * 0.55)}`;
      cy = main.y + main.h / 2;
    } else {
      arc = '';
      cy = 50;
    }
    fig += `<g${cls(c, 'av-spin')} style="transform-origin:50px ${cy}px">${lit(arc, glow, lod ? 2.4 : 2.8, c.halo)}</g>`;
  }
  if (state === 'approval' || state === 'error') {
    const [x, y] = s.mark ?? (main.kind === 'r' || main.kind === 'k' ? [main.x + main.w - 2, main.y + 1] : [72, 32]);
    const r = lod ? 6.4 : 8;
    const ring = `stroke="${onDark ? GLASS : '#ffffff'}" stroke-width="1.6"`;
    fig += state === 'approval'
      ? `<circle cx="${x}" cy="${y}" r="${r}" fill="${WARN}" ${ring}/><path d="M${x} ${n(y - 3.2)}V${n(y + 0.6)}" stroke="${GLASS}" stroke-width="2" stroke-linecap="round"/><circle cx="${x}" cy="${y + 3}" r="1.1" fill="${GLASS}"/>`
      : `<circle cx="${x}" cy="${y}" r="${r}" fill="#e5484d" ${ring}/><path d="M${n(x - 2.4)} ${n(y - 2.4)}l4.8 4.8m0 -4.8l-4.8 4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`;
  }
  if (off) {
    const zc = onDark ? '#c7cfdd' : OFF;
    fig += `<g${cls(c, 'av-zzz')} fill="none" stroke="${zc}" stroke-width="${lod ? 1.8 : 2.4}" stroke-linecap="round" stroke-linejoin="round"><path d="M70 ${s.top - 4}h6l-6 7h6"/>${lod ? `<path d="M80 ${s.top - 12}h4.4l-4.4 5h4.4"/>` : ''}</g>`;
    // A standby light: the body has power, but nothing is thinking.
    if (lod >= 1) fig += `<circle cx="${d.x + d.w - 5}" cy="${n(d.y + d.h - 4.5)}" r="1.5" fill="#ff8a5c"/>`;
  }

  // Feet: the rest a little smaller in its own viewport (so the cues' origins stay its own), the feet under it.
  if (look.feet && look.feet !== 'none') {
    const k = FEET_SCALE;
    const o = (v: number) => n(v * (1 - k));
    const yb = n(FEET_PIVOT * (1 - k) + s.bottom * k);
    fig = `${feet(look.feet, yb, c)}<svg x="${o(50)}" y="${o(FEET_PIVOT)}" width="${n(100 * k)}" height="${n(100 * k)}" viewBox="0 0 100 100" overflow="visible">${fig}</svg>`;
  }

  const frame = o.frame ?? 'circle';
  const body = `<g>${fig}</g>`;
  if (frame === 'none') return `${defs ? `<defs>${defs}</defs>` : ''}${body}`;
  const bd = BACKDROPS[look.backdrop];
  const shape = frame === 'square' ? '<rect width="100" height="100"/>' : '<circle cx="50" cy="50" r="50"/>';
  const fill = frame === 'square' ? `<rect width="100" height="100" fill="${bd}"/>` : `<circle cx="50" cy="50" r="50" fill="${bd}"/>`;
  // A light-cycle floor on the grid backdrop, faint enough to stay behind the Boton.
  const floor = look.backdrop === 'grid' && lod >= 1
    ? `<path d="M0 62H100M0 70H100M0 81H100M0 96H100${[10, 26, 42, 58, 74, 90].map((x) => `M${n(50 + (x - 50) * 0.25)} 62L${n(x * 1.6 - 30)} 100`).join('')}" stroke="${GLOWS[look.glow]}" stroke-opacity=".28" stroke-width=".8" fill="none"/>`
    : '';
  return `<defs><clipPath id="${uid}c">${shape}</clipPath>${defs}</defs><g clip-path="url(#${uid}c)">${fill}${floor}${body}</g>`;
}

/** A whole, still SVG document, for snapshots and files. */
export function botonSvg(look: BotonLook, o: BotonOptions = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${botonInner(look, { still: true, ...o })}</svg>`;
}
