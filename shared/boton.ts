import type { AvatarState, BotonLook } from './types.ts';
import { BACKDROPS, DARK_BACKDROPS, GLOWS, SHELLS } from './look.ts';

// The Boton renderer: a pure function from (look, state, size) to SVG markup in a 100 × 100 frame. The web avatar,
// the builder and the snapshot tests all draw through it. Every value it writes comes from the look's fixed names
// or from numbers computed here, never from free text. A Boton is a button seen from the front with a little depth
// (a cap over a darker skirt), a rim of light, a dark glass display with its face lit on it, and layered parts:
// arms, top, ears, the button, the display and face, visor, panel, then the state's cues. Glow is drawn with a soft
// wide stroke under the crisp one, never an SVG filter, so a sidebar of Botons stays cheap.

/** Detail by size, like optical sizes in type: 0 up to 28 px (silhouette, rim, face, top, state), 1 up to 72 px, 2 above. */
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

type Cap = { kind: 'c'; cx: number; cy: number; r: number } | { kind: 'r' | 'k'; x: number; y: number; w: number; h: number; rx: number };
interface Shape {
  cap: Cap;
  /** The top of the cap, where the top part sits. */
  top: number;
  /** The cap's outer edge at eye height, where the ears sit. */
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
}
const SHAPES: Record<BotonLook['shape'], Shape> = {
  round: { cap: { kind: 'c', cx: 50, cy: 55, r: 29 }, top: 26, side: 21, ey: 53, d: { x: 31, y: 40, w: 38, h: 25, rx: 11 }, p: 74, ax: 25, ay: 68, dx: 8.36 },
  pill: { cap: { kind: 'r', x: 12, y: 38, w: 76, h: 42, rx: 21 }, top: 38, side: 12, ey: 59, d: { x: 27, y: 45, w: 46, h: 24, rx: 11 }, p: 74.5, ax: 16, ay: 70, dx: 10 },
  key: { cap: { kind: 'k', x: 20, y: 27, w: 60, h: 54, rx: 12 }, top: 27, side: 17, ey: 49, d: { x: 29, y: 35, w: 42, h: 26, rx: 8 }, p: 71, ax: 19, ay: 72, dx: 9.24 },
};
const my = (s: Shape) => n(s.d.y + s.d.h * 0.74);

/** The cap, or (dy, grow) the skirt under it. */
function capEl(c: Cap, attrs: string, dy = 0, grow = 0): string {
  if (c.kind === 'c') return `<circle cx="${c.cx}" cy="${n(c.cy + dy)}" r="${n(c.r + grow)}" ${attrs}/>`;
  const g = c.kind === 'k' && grow ? grow + 2 : grow;
  return `<rect x="${n(c.x - g)}" y="${n(c.y + dy)}" width="${n(c.w + g * 2)}" height="${n(c.h + (c.kind === 'k' ? grow * 2 : 0))}" rx="${n(c.rx + g / 2)}" ${attrs}/>`;
}

/** A lit stroke: a soft wide halo under the crisp line. */
function lit(d: string, col: string, w: number, halo: boolean): string {
  const base = `stroke="${col}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  return `${halo ? `<path d="${d}" ${base} stroke-width="${n(w + 3.4)}" stroke-opacity=".22"/>` : ''}<path d="${d}" ${base} stroke-width="${w}"/>`;
}
const dot = (x: number, y: number, r: number, col: string, halo: boolean) => `${halo ? `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r + 2)}" fill="${col}" opacity=".22"/>` : ''}<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${col}"/>`;

type EyeKind = BotonLook['eyes'] | 'closed' | 'wide' | 'down' | 'worried';
function eyes(kind: EyeKind, s: Shape, c: Ctx, col: string): string {
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
      default: return dot(x, ey, 3.6, col, h);
    }
  };
  if (kind === 'wink') return one(50 - dx, 'dots') + lit(`M${n(50 + dx - 4)} ${ey}Q${n(50 + dx)} ${n(ey + 2.4)} ${n(50 + dx + 4)} ${ey}`, col, 2.6, h);
  return `<g${cls(c, c.state === 'idle' ? 'av-blink' : '')}>${one(50 - dx, kind)}${one(50 + dx, kind)}</g>`;
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
    case 'fin': return `<path d="M40 ${t + 3}Q42 ${t - 14} 58 ${t - 15}Q55 ${t - 6} 60 ${t + 3}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/>${on && c.lod ? lit(`M44 ${t - 1}Q46 ${t - 10} 55 ${n(t - 11.4)}`, glow, 1.6, halo) : ''}`;
    case 'beacon': return `<rect x="42" y="${t - 3}" width="16" height="5" rx="2" fill="${sk}"/><path d="M43.5 ${t - 3}a6.5 6.5 0 0 1 13 0Z" fill="${on ? glow : mix(sk, '#ffffff', 0.3)}" stroke="${sk}" stroke-width="1.2"/>`;
    case 'halo': return on ? lit(`M33 ${t - 9}a17 5 0 1 0 34 0a17 5 0 1 0 -34 0`, glow, 2.2, halo) : `<ellipse cx="50" cy="${t - 9}" rx="17" ry="5" fill="none" stroke="${sk}" stroke-width="2.2"/>`;
    default: return '';
  }
}

function ears(kind: BotonLook['ears'], s: Shape, c: Ctx): string {
  const { ey } = s;
  const { shell, skirt: sk, glow, lit: on } = c;
  const L = s.side + 1;
  const R = 100 - s.side - 1;
  switch (kind) {
    case 'bolts': return [L, R].map((x) => `<rect x="${x - 4}" y="${ey - 4}" width="8" height="8" rx="2" fill="${sk}"/><circle cx="${x + (x < 50 ? -1 : 1)}" cy="${ey}" r="1.6" fill="${shell}"/>`).join('');
    case 'pods': return [L - 2, R + 2].map((x) => `<rect x="${n(x - 4.6)}" y="${ey - 9}" width="9.2" height="18" rx="4.6" fill="${shell}" stroke="${sk}" stroke-width="1.8"/>${on ? `<rect x="${x - 1}" y="${ey - 5}" width="2" height="10" rx="1" fill="${glow}"/>` : ''}`).join('');
    case 'fins': return `<path d="M${L + 2} ${ey - 7}L${L - 9} ${ey - 13}L${L - 5} ${ey + 5}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/><path d="M${R - 2} ${ey - 7}L${R + 9} ${ey - 13}L${R + 5} ${ey + 5}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/>`;
    case 'knobs': return ([[L, -1], [R, 1]] as const).map(([x, side]) => `<rect x="${side < 0 ? x - 5 : x}" y="${ey - 2}" width="5" height="4" fill="${sk}"/><circle cx="${x + side * 7}" cy="${ey}" r="3.8" fill="${on ? glow : shell}" stroke="${sk}" stroke-width="1.6"/>`).join('');
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
    default: return '';
  }
}

/** Arms behind the body. Needs you raises the right one; the left keeps its pose. */
function arms(kind: BotonLook['arms'], s: Shape, c: Ctx): string {
  const k = c.state === 'approval' ? 'raise' : kind;
  if (k === 'none') return '';
  const { ax, ay } = s;
  const L = ax;
  const R = 100 - ax;
  const arm = (d: string) => `<path d="${d}" stroke="${c.skirt}" stroke-width="5.4" fill="none" stroke-linecap="round"/>`;
  const down = (x: number, side: number) => arm(`M${x} ${ay}l${side * 6} 7`);
  const up = (x: number, side: number) => arm(`M${x + side * 2} ${ay - 3}l${side * 9} -13`) + `<circle cx="${x + side * 11}" cy="${ay - 17}" r="3.6" fill="${c.skirt}"/>`;
  switch (k) {
    case 'wave': return down(L, -1) + up(R, 1);
    case 'raise': return (kind === 'none' ? '' : down(L, -1)) + `<g${cls(c, 'av-wave')} style="transform-origin:${R + 2}px ${ay - 3}px">${up(R, 1)}</g>`;
    case 'cheer': return up(L, -1) + up(R, 1);
    default: return down(L, -1) + down(R, 1);
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

/** What goes inside <svg viewBox="0 0 100 100">. */
export function botonInner(look: BotonLook, o: BotonOptions = {}): string {
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
  const { cap, d } = s;

  let fig = arms(look.arms, s, c);
  fig += top(look.top, s, c);
  if (lod >= 1) fig += ears(look.ears, s, c);
  // The button: its skirt a little lower, then the cap, then a rim of light (off without a brain).
  let defs = '';
  if (lod >= 1) defs += `<linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(shell, '#ffffff', 0.22)}"/><stop offset=".55" stop-color="${shell}"/><stop offset="1" stop-color="${mix(shell, '#05070d', 0.12)}"/></linearGradient>`;
  fig += capEl(cap, `fill="${c.skirt}"`, 4.5, cap.kind === 'k' ? 1 : 0.5);
  fig += capEl(cap, `fill="${lod >= 1 ? `url(#${uid}g)` : shell}"`);
  fig += capEl(cap, `fill="none" stroke="${off ? OFF_RIM : glow}" stroke-width="${lod ? 1.3 : 1.8}" stroke-opacity=".9"`);
  if (lod >= 1) {
    // A soft highlight on the cap's upper left: it reads as a physical button.
    const hl = cap.kind === 'c' ? `M${n(cap.cx - cap.r * 0.62)} ${n(cap.cy - cap.r * 0.5)}Q${n(cap.cx - cap.r * 0.25)} ${n(cap.cy - cap.r * 0.86)} ${n(cap.cx + cap.r * 0.1)} ${n(cap.cy - cap.r * 0.9)}` : `M${n(cap.x + cap.rx * 0.6)} ${cap.y + 4}H${n(cap.x + cap.w * 0.45)}`;
    fig += `<path d="${hl}" stroke="#fff" stroke-opacity=".45" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  }
  // The display: dark glass, the face lit on it.
  fig += `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="${d.rx}" fill="${off ? '#141927' : GLASS}" stroke="${off ? OFF : glow}" stroke-opacity=".5" stroke-width="1.1"/>`;
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
  if (look.cheeks && lod >= 1 && state === 'idle') fig += `<g fill="#ff7eb6" opacity=".55"><rect x="${n(50 - s.dx - 8)}" y="${s.ey + 5}" width="4.6" height="2.2" rx="1.1"/><rect x="${n(50 + s.dx + 3.4)}" y="${s.ey + 5}" width="4.6" height="2.2" rx="1.1"/></g>`;
  fig += brows(b, s, c, face) + eyes(e, s, c, face) + mouth(m, s, c, face);
  if (lod >= 1 && state === 'idle') fig += visor(look.visor, s, c);
  if (lod >= 1) fig += panel(look.panel, s, c);

  // State cues beyond the face. Each one also has words wherever it's shown.
  if (state === 'working') {
    // A lit arc around the button, like a button that's busy.
    const arc = cap.kind === 'c'
      ? `M50 ${n(cap.cy - cap.r - 6.5)}a${n(cap.r + 6.5)} ${n(cap.r + 6.5)} 0 0 1 ${n((cap.r + 6.5) * 0.87)} ${n((cap.r + 6.5) * 1.5)}`
      : `M${cap.x + cap.w / 2} ${cap.y - 5}H${cap.x + cap.w - cap.rx}q${cap.rx + 5} 0 ${cap.rx + 5} ${cap.rx + 5}V${n(cap.y + cap.h * 0.55)}`;
    const cy = cap.kind === 'c' ? cap.cy : cap.y + cap.h / 2;
    fig += `<g${cls(c, 'av-spin')} style="transform-origin:50px ${cy}px">${lit(arc, glow, lod ? 2.4 : 2.8, c.halo)}</g>`;
  }
  if (state === 'approval' || state === 'error') {
    const x = cap.kind === 'c' ? 72 : cap.x + cap.w - 2;
    const y = cap.kind === 'c' ? 32 : cap.y + 1;
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
