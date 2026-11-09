// A prototype of the Boton renderer for the brand board: a pure function from (look, state, options) to SVG markup
// in a 100 × 100 frame. Three directions share one set of parts so the board can compare them fairly:
//   'lit'   a colored button shell with a dark glass display, a neon face and a rim of light (recommended)
//   'line'  outline only: dark bodies drawn in glowing lines, like a light-cycle grid
//   'toy'   matte vinyl shells and a pale LCD face drawn in ink, no glow
// Nothing here is used by the app; the app's renderer is drawn from the chosen direction.

export const STATES = ['idle', 'working', 'approval', 'error', 'asleep'];

export const PARTS = {
  shape: { round: 'Round', pill: 'Pill', key: 'Key' },
  shell: { snow: 'Snow', steel: 'Steel', graphite: 'Graphite', sun: 'Sun', signal: 'Signal', cobalt: 'Cobalt', violet: 'Violet', teal: 'Teal' },
  glow: { cyan: 'Cyan', pink: 'Pink', lime: 'Lime', amber: 'Amber', violet: 'Violet', ice: 'Ice' },
  eyes: { dots: 'Dots', rings: 'Rings', bars: 'Bars', happy: 'Happy', wink: 'Wink', lidded: 'Lidded' },
  brows: { none: 'None', soft: 'Soft', straight: 'Straight', arched: 'Arched', bold: 'Bold' },
  mouth: { smile: 'Smile', grin: 'Grin', smirk: 'Smirk', o: 'Oh', calm: 'Calm', wave: 'Wave' },
  top: { none: 'None', antenna: 'Antenna', twin: 'Twin', dish: 'Dish', coil: 'Coil', fin: 'Fin', beacon: 'Beacon', halo: 'Halo' },
  ears: { none: 'None', bolts: 'Bolts', pods: 'Pods', fins: 'Fins', knobs: 'Knobs' },
  visor: { none: 'None', goggles: 'Goggles', monocle: 'Monocle', band: 'Band' },
  panel: { none: 'None', holes: 'Button holes', grill: 'Grill', leds: 'Lights', dial: 'Dial', switch: 'Switch' },
  arms: { none: 'None', nubs: 'Nubs', wave: 'Wave', cheer: 'Cheer' },
  backdrop: { mist: 'Mist', ice: 'Ice', mint: 'Mint', lilac: 'Lilac', blush: 'Blush', night: 'Night', plum: 'Plum', grid: 'Grid' },
};

/** Shell colors. The display carries the face, so a shell only has to stand out from its backdrop. */
export const SHELL = {
  snow: '#eef2f7',
  steel: '#a9b4c6',
  graphite: '#323a4c',
  sun: '#f4c53d',
  signal: '#f0624d',
  cobalt: '#3f63e0',
  violet: '#8457e6',
  teal: '#17a99d',
};
/** The light of the display and the rim. Every one is 7:1 or better on the display glass. */
export const GLOW = { cyan: '#3ee6ff', pink: '#ff6ad5', lime: '#a8ff5c', amber: '#ffbe45', violet: '#b49bff', ice: '#e8f6ff' };
export const BACKDROP = {
  mist: '#e7ecf3',
  ice: '#d4f2fa',
  mint: '#d3f4e2',
  lilac: '#e6defa',
  blush: '#fbdde8',
  night: '#121b36',
  plum: '#2a1842',
  grid: '#090d18',
};
export const DARK_BACKDROPS = new Set(['night', 'plum', 'grid']);
export const GLASS = '#0a0f1c';
export const INK = '#141a2a';
/** How far the skirt (the button's side) darkens the shell. */
export const SKIRT = 0.5;
const ERR = '#ff6b6b';
const WARN = '#ffbe45';
const OFF = '#56607a';
export const OFF_RIM = '#8e98ab';

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a, b, t) => {
  const A = rgb(a);
  const B = rgb(b);
  return hex(A.map((v, i) => v + (B[i] - v) * t));
};
export const skirtOf = (shell) => mix(shell, '#05070d', SKIRT);

/**
 * Body geometry. Every body is a button seen from the front with a little depth: a cap, and under it the skirt,
 * a darker copy a few units lower. `d` is the display (the face), `p` the panel's center, `ax` the arm anchors.
 */
const SHAPES = {
  round: { cap: { kind: 'c', cx: 50, cy: 55, r: 29 }, top: 26, side: 21, ey: 53, d: { x: 31, y: 40, w: 38, h: 25, rx: 11 }, p: 74, ay: 68, ax: 25 },
  pill: { cap: { kind: 'r', x: 12, y: 38, w: 76, h: 42, rx: 21 }, top: 38, side: 12, ey: 59, d: { x: 27, y: 45, w: 46, h: 24, rx: 11 }, p: 74.5, ay: 70, ax: 16 },
  key: { cap: { kind: 'k', x: 20, y: 27, w: 60, h: 54, rx: 12 }, top: 27, side: 17, ey: 49, d: { x: 29, y: 35, w: 42, h: 26, rx: 8 }, p: 71, ay: 72, ax: 19 },
};

const capPath = (c, dy = 0, grow = 0) => {
  if (c.kind === 'c') return { tag: 'circle', a: `cx="${c.cx}" cy="${c.cy + dy}" r="${c.r + grow}"` };
  const g = c.kind === 'k' && grow ? grow + 2 : grow;
  return { tag: 'rect', a: `x="${c.x - g}" y="${c.y + dy}" width="${c.w + g * 2}" height="${c.h + (c.kind === 'k' ? grow * 2 : 0)}" rx="${c.rx + g / 2}"` };
};
const el = (s, extra) => `<${s.tag} ${s.a} ${extra}/>`;

/** A neon stroke: a soft wide halo under the crisp line, so it glows without an SVG filter. */
function neon(d, col, w, { halo = true, cap = 'round', fill = 'none' } = {}) {
  const h = halo ? `<path d="${d}" stroke="${col}" stroke-width="${w + 3.4}" stroke-opacity=".22" fill="none" stroke-linecap="${cap}" stroke-linejoin="round"/>` : '';
  return `${h}<path d="${d}" stroke="${col}" stroke-width="${w}" fill="${fill}" stroke-linecap="${cap}" stroke-linejoin="round"/>`;
}
const dot = (x, y, r, col, halo) => `${halo ? `<circle cx="${x}" cy="${y}" r="${r + 2}" fill="${col}" opacity=".22"/>` : ''}<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`;

function eyes(kind, g, col, o) {
  const { ey, dx, h } = g;
  const L = 50 - dx;
  const R = 50 + dx;
  const one = (x, k) => {
    switch (k) {
      case 'rings': return neon(`M${x - 3.6} ${ey}a3.6 3.6 0 1 0 7.2 0a3.6 3.6 0 1 0 -7.2 0`, col, 2.2, { halo: h });
      case 'bars': return neon(`M${x} ${ey - 3.4}V${ey + 3.4}`, col, 4.2, { halo: h });
      case 'happy': return neon(`M${x - 4} ${ey + 1.6}Q${x} ${ey - 4.4} ${x + 4} ${ey + 1.6}`, col, 2.6, { halo: h });
      case 'lidded': return `${h ? `<path d="M${x - 5.6} ${ey - 1}H${x + 5.6}a5.6 5.6 0 0 1 -11.2 0Z" fill="${col}" opacity=".22"/>` : ''}<path d="M${x - 4} ${ey - .6}H${x + 4}a4 4 0 0 1 -8 0Z" fill="${col}"/>`;
      case 'closed': return neon(`M${x - 3.6} ${ey + .6}Q${x} ${ey + 3} ${x + 3.6} ${ey + .6}`, col, 2, { halo: h });
      case 'wide': return `${dot(x, ey, 4.4, col, h)}<circle cx="${x + 1.2}" cy="${ey - 1.4}" r="1.4" fill="${GLASS}"/>`;
      case 'down': return dot(x, ey + 1.6, 3.2, col, h);
      case 'worried': return dot(x, ey + .6, 3.2, col, h);
      default: return dot(x, ey, 3.6, col, h);
    }
  };
  if (kind === 'wink') return `${one(L, 'dots')}${neon(`M${R - 4} ${ey}Q${R} ${ey + 2.4} ${R + 4} ${ey}`, col, 2.6, { halo: h })}`;
  return `<g class="${o.still ? '' : 'bot-blink'}">${one(L, kind)}${one(R, kind)}</g>`;
}

function brows(kind, g, col) {
  const { ey, dx, h } = g;
  const y = ey - 7.4;
  const L = 50 - dx;
  const R = 50 + dx;
  const p = {
    soft: [`M${L - 3.6} ${y + .6}Q${L} ${y - 1.4} ${L + 3.6} ${y + .6}`, `M${R - 3.6} ${y + .6}Q${R} ${y - 1.4} ${R + 3.6} ${y + .6}`, 1.8],
    straight: [`M${L - 3.6} ${y}H${L + 3.6}`, `M${R - 3.6} ${y}H${R + 3.6}`, 2],
    arched: [`M${L - 4} ${y + 1.4}Q${L} ${y - 3} ${L + 4} ${y + 1.4}`, `M${R - 4} ${y + 1.4}Q${R} ${y - 3} ${R + 4} ${y + 1.4}`, 1.9],
    bold: [`M${L - 4} ${y - .4}L${L + 4} ${y + 1}`, `M${R - 4} ${y + 1}L${R + 4} ${y - .4}`, 3],
    worried: [`M${L - 4} ${y + 1.6}L${L + 3.4} ${y - .8}`, `M${R - 3.4} ${y - .8}L${R + 4} ${y + 1.6}`, 2],
    focused: [`M${L - 4} ${y - .2}L${L + 4} ${y + 1.4}`, `M${R - 4} ${y + 1.4}L${R + 4} ${y - .2}`, 2],
  }[kind];
  return p ? neon(p[0], col, p[2], { halo: h }) + neon(p[1], col, p[2], { halo: h }) : '';
}

function mouth(kind, g, col) {
  const { my: y, h } = g;
  switch (kind) {
    case 'grin': return `${h ? `<path d="M43 ${y - 1.8}H57a7 6 0 0 1 -14 0Z" fill="${col}" opacity=".22" transform="translate(0 0)"/>` : ''}<path d="M44.4 ${y - 1.2}H55.6a5.6 5 0 0 1 -11.2 0Z" fill="${col}"/>`;
    case 'smirk': return neon(`M45 ${y + .4}Q51 ${y + 2.6} 55.6 ${y - 1.6}`, col, 2.4, { halo: h });
    case 'o': return neon(`M47.4 ${y}a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0`, col, 2.2, { halo: h });
    case 'calm': return neon(`M46 ${y}H54`, col, 2.4, { halo: h });
    case 'wave': return neon(`M43.4 ${y}q1.65 -3 3.3 0t3.3 0t3.3 0t3.3 0`, col, 2, { halo: h });
    case 'dots': return `${dot(45.6, y, 1.6, col, h)}${dot(50, y, 1.6, col, h)}${dot(54.4, y, 1.6, col, h)}`;
    case 'wobbly': return neon(`M44.6 ${y + 1.2}q2.7 -2.6 5.4 0t5.4 0`, col, 2.2, { halo: h });
    case 'flat': return neon(`M46.6 ${y + .6}H53.4`, col, 2, { halo: false });
    default: return neon(`M44.6 ${y - 1}Q50 ${y + 4} 55.4 ${y - 1}`, col, 2.6, { halo: h });
  }
}

function topPart(kind, g, c) {
  const t = g.top;
  const { shell, sk, glow, lit, h } = c;
  const ball = (x, y, r = 3.4) => `${lit && h ? `<circle cx="${x}" cy="${y}" r="${r + 2.6}" fill="${glow}" opacity=".25"/>` : ''}<circle cx="${x}" cy="${y}" r="${r}" fill="${lit ? glow : sk}" stroke="${sk}" stroke-width="1.2"/>`;
  const stem = (d, w = 2.6) => `<path d="${d}" stroke="${sk}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  switch (kind) {
    case 'antenna': return stem(`M50 ${t + 1}V${t - 13}`) + ball(50, t - 15);
    case 'twin': return stem(`M44 ${t + 2}L38 ${t - 11}`) + stem(`M56 ${t + 2}L62 ${t - 11}`) + ball(37, t - 13, 3) + ball(63, t - 13, 3);
    case 'dish': return stem(`M50 ${t + 1}V${t - 7}`) + `<path d="M39 ${t - 15}Q50 ${t - 2} 61 ${t - 15}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round" transform="rotate(-16 50 ${t - 9})"/>` + ball(50, t - 12, 1.8);
    case 'coil': return stem(`M50 ${t + 1}V${t - 2}l-4 -2.2 8 -2.6 -8 -2.6 8 -2.6 -4 -2.2`, 2.2) + ball(50, t - 16, 3.2);
    case 'fin': return `<path d="M40 ${t + 3}Q42 ${t - 14} 58 ${t - 15}Q55 ${t - 6} 60 ${t + 3}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/>${lit ? neon(`M44 ${t - 1}Q46 ${t - 10} 55 ${t - 11.4}`, glow, 1.6, { halo: h }) : ''}`;
    case 'beacon': return `<rect x="42" y="${t - 3}" width="16" height="5" rx="2" fill="${sk}"/>${lit && h ? `<path d="M41 ${t - 2}a9 9 0 0 1 18 0Z" fill="${glow}" opacity=".25" transform="translate(0 -2) scale(1)"/>` : ''}<path d="M43.5 ${t - 3}a6.5 6.5 0 0 1 13 0Z" fill="${lit ? glow : mix(sk, '#ffffff', .3)}" stroke="${sk}" stroke-width="1.2"/>`;
    case 'halo': return lit ? neon(`M33 ${t - 9}a17 5 0 1 0 34 0a17 5 0 1 0 -34 0`, glow, 2.2, { halo: h }) : `<ellipse cx="50" cy="${t - 9}" rx="17" ry="5" fill="none" stroke="${sk}" stroke-width="2.2"/>`;
    default: return '';
  }
}

function earPart(kind, g, c) {
  const { side, ey } = g;
  const { shell, sk, glow, lit } = c;
  const L = side + 1;
  const R = 100 - side - 1;
  switch (kind) {
    case 'bolts': return [L, R].map((x) => `<rect x="${x - 4}" y="${ey - 4}" width="8" height="8" rx="2" fill="${sk}"/><circle cx="${x + (x < 50 ? -1 : 1)}" cy="${ey}" r="1.6" fill="${shell}"/>`).join('');
    case 'pods': return [L - 2, R + 2].map((x) => `<rect x="${x - 4.6}" y="${ey - 9}" width="9.2" height="18" rx="4.6" fill="${shell}" stroke="${sk}" stroke-width="1.8"/>${lit ? `<rect x="${x - 1}" y="${ey - 5}" width="2" height="10" rx="1" fill="${glow}"/>` : ''}`).join('');
    case 'fins': return `<path d="M${L + 2} ${ey - 7}L${L - 9} ${ey - 13}L${L - 5} ${ey + 5}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/><path d="M${R - 2} ${ey - 7}L${R + 9} ${ey - 13}L${R + 5} ${ey + 5}Z" fill="${shell}" stroke="${sk}" stroke-width="1.6" stroke-linejoin="round"/>`;
    case 'knobs': return [[L, -1], [R, 1]].map(([x, s]) => `<rect x="${s < 0 ? x - 5 : x}" y="${ey - 2}" width="5" height="4" fill="${sk}"/><circle cx="${x + s * 7}" cy="${ey}" r="3.8" fill="${lit ? glow : shell}" stroke="${sk}" stroke-width="1.6"/>`).join('');
    default: return '';
  }
}

function visorPart(kind, g, c, col) {
  const { ey, dx, d } = g;
  const { sk } = c;
  const L = 50 - dx;
  const R = 50 + dx;
  switch (kind) {
    case 'goggles': return `<g fill="none" stroke="${sk}" stroke-width="2.4"><circle cx="${L}" cy="${ey}" r="6.6"/><circle cx="${R}" cy="${ey}" r="6.6"/><path d="M${L + 6.6} ${ey}H${R - 6.6}M${d.x - 1} ${ey}H${L - 6.6}M${R + 6.6} ${ey}H${d.x + d.w + 1}"/></g><g fill="${col}" opacity=".12"><circle cx="${L}" cy="${ey}" r="5.4"/><circle cx="${R}" cy="${ey}" r="5.4"/></g>`;
    case 'monocle': return `<circle cx="${R}" cy="${ey}" r="7" fill="${col}" fill-opacity=".1" stroke="${sk}" stroke-width="2.4"/><path d="M${R + 5} ${ey + 5}Q${R + 9} ${ey + 12} ${R + 6} ${d.y + d.h + 3}" stroke="${sk}" stroke-width="1.2" fill="none"/>`;
    case 'band': return `<rect x="${d.x - 2}" y="${ey - 5.6}" width="${d.w + 4}" height="11.2" rx="5.6" fill="${col}" fill-opacity=".16" stroke="${col}" stroke-opacity=".7" stroke-width="1.4"/>`;
    default: return '';
  }
}

function panelPart(kind, g, c) {
  const y = g.p;
  const { sk, glow, lit, shell } = c;
  switch (kind) {
    case 'holes': return [[46.6, -2.2], [53.4, -2.2], [46.6, 2.2], [53.4, 2.2]].map(([x, dy]) => `<circle cx="${x}" cy="${y + dy}" r="1.5" fill="${sk}"/>`).join('');
    case 'grill': return `<g stroke="${sk}" stroke-width="1.8" stroke-linecap="round"><path d="M44 ${y - 2.6}H56M43 ${y}H57M44 ${y + 2.6}H56"/></g>`;
    case 'leds': return [44, 50, 56].map((x, i) => `<circle cx="${x}" cy="${y}" r="2" fill="${lit ? (i === 1 ? glow : mix(glow, sk, .55)) : sk}"/>`).join('');
    case 'dial': return `<circle cx="50" cy="${y}" r="4.2" fill="${mix(shell, '#ffffff', .25)}" stroke="${sk}" stroke-width="1.6"/><path d="M50 ${y}L52.4 ${y - 2.4}" stroke="${sk}" stroke-width="1.6" stroke-linecap="round"/>`;
    case 'switch': return `<rect x="44" y="${y - 2.6}" width="12" height="5.2" rx="2.6" fill="${sk}"/><circle cx="${lit ? 53.4 : 46.6}" cy="${y}" r="2.1" fill="${lit ? glow : shell}"/>`;
    default: return '';
  }
}

function armsPart(kind, g, c, state) {
  const k = state === 'approval' ? 'raise' : kind;
  if (k === 'none') return '';
  const { ax, ay } = g;
  const { sk } = c;
  const L = ax;
  const R = 100 - ax;
  const arm = (d, cls = '') => `<path class="${cls}" d="${d}" stroke="${sk}" stroke-width="5.4" fill="none" stroke-linecap="round"/>`;
  const down = (x, s) => arm(`M${x} ${ay}l${s * 6} 7`);
  const up = (x, s, cls = '') => arm(`M${x + s * 2} ${ay - 3}l${s * 9} -13`, cls) + `<circle cx="${x + s * 11}" cy="${ay - 17}" r="3.6" fill="${sk}"/>`;
  switch (k) {
    case 'wave': return down(L, -1) + `<g class="${c.still ? '' : 'bot-wave'}" style="transform-origin:${R}px ${ay - 4}px">${up(R, 1)}</g>`;
    case 'raise': return (kind === 'none' ? '' : down(L, -1)) + up(R, 1);
    case 'cheer': return up(L, -1) + up(R, 1);
    default: return down(L, -1) + down(R, 1);
  }
}

/** The inner markup of a Boton in a 100 × 100 frame. */
export function botInner(look, o = {}) {
  const style = o.style ?? 'lit';
  const state = o.state ?? 'idle';
  const size = o.size ?? 48;
  const uid = o.uid ?? 'b';
  const sh = SHAPES[look.shape] ?? SHAPES.round;
  const small = size <= 28;
  const tiny = size <= 20;
  const off = state === 'asleep';
  const line = style === 'line';
  const toy = style === 'toy';
  const lit = !off && !toy;
  const shellRaw = SHELL[look.shell] ?? SHELL.snow;
  const glowRaw = GLOW[look.glow] ?? GLOW.cyan;
  const shell = line ? '#0e1424' : off ? mix(shellRaw, '#8a92a3', .35) : shellRaw;
  const sk = line ? (off ? OFF : glowRaw) : skirtOf(shell);
  const glow = state === 'error' ? ERR : glowRaw;
  const faceCol = toy ? INK : off ? OFF : glow;
  const halo = !small && lit;
  const c = { shell, sk, glow, lit, h: halo, still: o.still };
  const d = sh.d;
  const g = { ...sh, dx: sh.d.w * 0.22, my: d.y + d.h * 0.74, h: halo };
  if (look.shape === 'pill') g.dx = 10;
  const bd = BACKDROP[look.backdrop] ?? BACKDROP.night;
  const dark = DARK_BACKDROPS.has(look.backdrop);
  const frame = o.frame ?? 'circle';
  const out = [];

  if (frame === 'circle') {
    out.push(`<circle cx="50" cy="50" r="50" fill="${bd}"/>`);
    if (look.backdrop === 'grid' && !small) {
      // A light-cycle floor: a few lines toward a horizon, faint enough to stay behind the Boton.
      const v = [10, 26, 42, 58, 74, 90].map((x) => `M${50 + (x - 50) * .25} 62L${x * 1.6 - 30} 100`).join('');
      out.push(`<g stroke="${glowRaw}" stroke-opacity=".28" stroke-width=".8" fill="none"><path d="M0 62H100M0 70H100M0 81H100M0 96H100${v}"/></g>`);
    }
  }

  // Arms sit behind the body, the top and ears beside it.
  out.push(armsPart(look.arms, g, c, state));
  if (!tiny || look.top !== 'none') out.push(topPart(tiny && look.top !== 'none' ? 'antenna' : look.top, g, c));
  if (!small) out.push(earPart(look.ears, g, c));

  // Body: the skirt a little lower, then the cap.
  const cap = sh.cap;
  const gid = `${uid}s`;
  if (!line && !toy) out.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(shell, '#ffffff', .22)}"/><stop offset=".55" stop-color="${shell}"/><stop offset="1" stop-color="${mix(shell, '#05070d', .12)}"/></linearGradient></defs>`);
  out.push(el(capPath(cap, 4.5, cap.kind === 'k' ? 1 : .5), `fill="${line ? '#0e1424' : sk}"${line ? ` stroke="${sk}" stroke-width="1.4" stroke-opacity=".5"` : ''}`));
  out.push(el(capPath(cap), `fill="${line || toy ? shell : `url(#${gid})`}"${line ? ` stroke="${sk}" stroke-width="2.2"` : ''}`));
  // Rim light: the glowing edge of a lit button.
  // With no brain the rim is unlit, but still an edge that keeps the silhouette at 3:1 on the dark backdrops.
  if (!line && !toy) out.push(el(capPath(cap), `fill="none" stroke="${lit ? glow : OFF_RIM}" stroke-width="${small ? 1.6 : 1.3}" stroke-opacity=".9"`));
  if (line && halo) out.push(el(capPath(cap), `fill="none" stroke="${glow}" stroke-width="5.6" stroke-opacity=".18"`));
  if (!small && !line && !toy) {
    // A soft highlight on the cap's upper left: it reads as a physical button.
    const hl = cap.kind === 'c' ? `M${cap.cx - cap.r * .62} ${cap.cy - cap.r * .5}Q${cap.cx - cap.r * .25} ${cap.cy - cap.r * .86} ${cap.cx + cap.r * .1} ${cap.cy - cap.r * .9}` : `M${cap.x + cap.rx * .6} ${cap.y + 4}H${cap.x + cap.w * .45}`;
    out.push(`<path d="${hl}" stroke="#ffffff" stroke-opacity=".45" stroke-width="2.2" fill="none" stroke-linecap="round"/>`);
  }

  // The display: dark glass with the face lit on it (pale LCD for the toy direction).
  const dispFill = toy ? (off ? '#b9c0b4' : '#d9e8cf') : off ? '#141927' : GLASS;
  out.push(`<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="${d.rx}" fill="${dispFill}" ${toy ? `stroke="${mix(shell, '#05070d', .3)}" stroke-width="1.6"` : `stroke="${lit ? glow : OFF}" stroke-opacity="${lit ? .5 : .5}" stroke-width="1.1"`}/>`);
  if (!small && !toy && !off) out.push(`<path d="M${d.x + 4} ${d.y + 3.5}H${d.x + d.w * .42}" stroke="#ffffff" stroke-opacity=".14" stroke-width="1.6" stroke-linecap="round"/>`);
  if (state === 'error' && !small) out.push(`<path d="M${d.x + 3} ${d.y + 6}h9M${d.x + d.w - 14} ${d.y + d.h - 5}h10" stroke="${ERR}" stroke-opacity=".45" stroke-width="1.2"/>`);

  // Face, by state. A state replaces the resting eyes, brows and mouth, so the mood always shows.
  const face = {
    idle: [look.eyes, look.brows, look.mouth],
    working: ['down', 'focused', 'dots'],
    approval: ['wide', 'arched', 'o'],
    error: ['worried', 'worried', 'wobbly'],
    asleep: ['closed', 'none', 'flat'],
  }[state];
  if (look.cheeks && !small && !off && state === 'idle') {
    const cy = g.ey + 5;
    out.push(`<g fill="${toy ? '#e2667f' : '#ff7eb6'}" opacity="${toy ? .5 : .55}"><rect x="${50 - g.dx - 8}" y="${cy}" width="4.6" height="2.2" rx="1.1"/><rect x="${50 + g.dx + 3.4}" y="${cy}" width="4.6" height="2.2" rx="1.1"/></g>`);
  }
  if (!tiny) out.push(brows(face[1], g, faceCol));
  out.push(eyes(face[0], g, faceCol, { still: o.still || state !== 'idle' }));
  out.push(mouth(face[2], g, faceCol));
  if (!small && state === 'idle') out.push(visorPart(look.visor, g, c, glow));
  if (!small) out.push(panelPart(look.panel, g, c));

  // State cues beyond the face. Each one also has words wherever it's shown.
  if (state === 'working' && !toy) {
    // A lit progress arc around the button, like a button that's busy.
    const r = cap.kind === 'c' ? cap.r + 6.5 : null;
    const arc = r ? `M50 ${cap.cy - r}a${r} ${r} 0 0 1 ${r * .87} ${r * 1.5}` : `M${cap.x + cap.w * .5} ${cap.y - 5}H${cap.x + cap.w - cap.rx}q${cap.rx + 5} 0 ${cap.rx + 5} ${cap.rx + 5}V${cap.y + cap.h * .55}`;
    out.push(`<g class="${o.still ? '' : 'bot-spin'}" style="transform-origin:50px ${cap.kind === 'c' ? cap.cy : cap.y + cap.h / 2}px">${neon(arc, glow, small ? 2.6 : 2.4, { halo })}</g>`);
  }
  if (state === 'approval') {
    const x = cap.kind === 'c' ? 72 : cap.x + cap.w - 2;
    const y = cap.kind === 'c' ? 32 : cap.y + 1;
    out.push(`<circle cx="${x}" cy="${y}" r="${small ? 7 : 6.4}" fill="${WARN}" stroke="${dark ? '#0a0f1c' : '#ffffff'}" stroke-width="1.6"/><path d="M${x} ${y - 3.2}V${y + .6}" stroke="${GLASS}" stroke-width="2" stroke-linecap="round"/><circle cx="${x}" cy="${y + 3}" r="1.1" fill="${GLASS}"/>`);
  }
  if (state === 'error') {
    const x = cap.kind === 'c' ? 73 : cap.x + cap.w - 2;
    const y = cap.kind === 'c' ? 33 : cap.y + 1;
    out.push(`<circle cx="${x}" cy="${y}" r="${small ? 7 : 6.4}" fill="#e5484d" stroke="${dark ? '#0a0f1c' : '#ffffff'}" stroke-width="1.6"/><path d="M${x - 2.4} ${y - 2.4}l4.8 4.8m0 -4.8l-4.8 4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`);
  }
  if (state === 'asleep') {
    const zc = dark ? '#c7cfdd' : '#56607a';
    out.push(`<g class="${o.still ? '' : 'bot-z'}" fill="none" stroke="${zc}" stroke-width="${small ? 2.2 : 1.8}" stroke-linecap="round" stroke-linejoin="round"><path d="M70 ${sh.top - 4}h6l-6 7h6"/>${small ? '' : `<path d="M80 ${sh.top - 12}h4.4l-4.4 5h4.4"/>`}</g>`);
    // A standby light: the body is powered, but nothing is thinking.
    if (!small) out.push(`<circle cx="${d.x + d.w - 5}" cy="${d.y + d.h - 4.5}" r="1.5" fill="#ff8a5c"/>`);
  }
  return out.join('');
}

/** A complete Boton SVG. The label is what a screen reader says. */
export function botSvg(look, o = {}) {
  const size = o.size ?? 48;
  const label = o.label ? ` role="img" aria-label="${o.label}"` : ' aria-hidden="true"';
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"${label} style="display:block;flex:none">${botInner(look, o)}</svg>`;
}

export const DEFAULT_LOOK = { shape: 'round', shell: 'snow', glow: 'cyan', eyes: 'dots', brows: 'none', mouth: 'smile', top: 'antenna', ears: 'none', visor: 'none', panel: 'none', arms: 'nubs', backdrop: 'night', cheeks: true };

/** The board's cast: the same eight Botons in every direction and mockup. */
export const CAST = [
  { name: 'Juniper', look: { ...DEFAULT_LOOK, shell: 'snow', glow: 'cyan', top: 'antenna', backdrop: 'night' } },
  { name: 'Volt', look: { ...DEFAULT_LOOK, shape: 'key', shell: 'signal', glow: 'amber', eyes: 'bars', mouth: 'grin', top: 'none', ears: 'bolts', panel: 'holes', backdrop: 'mist', cheeks: false } },
  { name: 'Scout', look: { ...DEFAULT_LOOK, shape: 'pill', shell: 'cobalt', glow: 'ice', eyes: 'rings', brows: 'soft', top: 'dish', visor: 'none', ears: 'pods', backdrop: 'ice' } },
  { name: 'Clover', look: { ...DEFAULT_LOOK, shell: 'teal', glow: 'lime', eyes: 'happy', top: 'coil', panel: 'leds', backdrop: 'mint' } },
  { name: 'Ledger', look: { ...DEFAULT_LOOK, shape: 'key', shell: 'graphite', glow: 'cyan', eyes: 'dots', brows: 'straight', mouth: 'calm', top: 'beacon', visor: 'goggles', panel: 'dial', backdrop: 'grid', cheeks: false } },
  { name: 'Pip', look: { ...DEFAULT_LOOK, shell: 'violet', glow: 'pink', eyes: 'wink', mouth: 'smirk', top: 'halo', backdrop: 'lilac' } },
  { name: 'Ziggy', look: { ...DEFAULT_LOOK, shape: 'pill', shell: 'sun', glow: 'violet', eyes: 'lidded', mouth: 'wave', top: 'twin', ears: 'knobs', panel: 'switch', backdrop: 'plum', cheeks: false } },
  { name: 'Nova', look: { ...DEFAULT_LOOK, shape: 'round', shell: 'steel', glow: 'pink', eyes: 'dots', brows: 'arched', top: 'fin', ears: 'fins', visor: 'band', backdrop: 'blush' } },
];
