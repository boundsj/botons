import { hash32, pick, seeded, weighted } from './seeded.ts';

export type CritterBody = 'bun' | 'loaf' | 'round' | 'pebble';
export type CritterEars = 'point' | 'round' | 'long' | 'floppy' | 'feelers';
export type CritterEyes = 'dot' | 'bean' | 'arc' | 'sleepy';
export type CritterMouth = 'smile' | 'open' | 'o' | 'w';
export type CritterMarks = 'none' | 'belly' | 'spots' | 'cap';
export type CritterColor = 'coral' | 'sage' | 'sky' | 'lilac' | 'peach' | 'mint' | 'rose' | 'periwinkle' | 'sand' | 'seafoam';
export type CritterBackdrop = 'navy' | 'plum' | 'forest' | 'wine' | 'slate' | 'cocoa' | 'indigo' | 'teal';
export interface CritterLook {
  body: CritterBody;
  ears: CritterEars;
  eyes: CritterEyes;
  mouth: CritterMouth;
  marks: CritterMarks;
  cheeks: boolean;
  color: CritterColor;
  backdrop: CritterBackdrop;
}

// The looks a database before schema version 32 holds: a Critter (version 25 on) and the capsule before it (24).
// They are read, never drawn: shared/look-tater.ts maps each one to its closest tater look, and shared/look.ts that to
// its closest Boton, in the schema upgrades and on import.
// This file imports only Node-free modules: the schema upgrade (server/src/schema.ts) and the CLI-free scripts load it.

export const BODIES: readonly CritterBody[] = ['bun', 'loaf', 'round', 'pebble'];
export const EARS: readonly CritterEars[] = ['point', 'round', 'long', 'floppy', 'feelers'];
export const EYES: readonly CritterEyes[] = ['dot', 'bean', 'arc', 'sleepy'];
export const MOUTHS: readonly CritterMouth[] = ['smile', 'open', 'o', 'w'];
export const MARKS: readonly CritterMarks[] = ['none', 'belly', 'spots', 'cap'];

/** Mid-light body colors, none in the saturated yellow band; each keeps 3:1 against every backdrop and 4.5:1 under the face ink. */
export const COLORS: Readonly<Record<CritterColor, string>> = {
  coral: '#ff8c6e',
  sage: '#a9d39f',
  sky: '#8ec6ff',
  lilac: '#c5a9ff',
  peach: '#ffb48d',
  mint: '#8fe0bf',
  rose: '#ff9dbd',
  periwinkle: '#a1aefc',
  sand: '#e6c7a1',
  seafoam: '#94dcd8',
};

/** Deep night backdrops behind the body. */
export const BACKDROPS: Readonly<Record<CritterBackdrop, string>> = {
  navy: '#1d2b52',
  plum: '#35214b',
  forest: '#1b3b31',
  wine: '#4b1f30',
  slate: '#253241',
  cocoa: '#3b2a20',
  indigo: '#272a68',
  teal: '#123a40',
};

export const COLOR_NAMES = Object.keys(COLORS) as CritterColor[];
export const BACKDROP_NAMES = Object.keys(BACKDROPS) as CritterBackdrop[];

/**
 * Body colors that never get spots: a blue spotted creature reads as a well-known character. The guard turns
 * spots on them into a belly patch, and every look goes through it: random, migrated, edited and sent to the API.
 */
export const NO_SPOTS: readonly CritterColor[] = ['sky', 'periwinkle'];

/** The look with the guardrails applied (a new object; the input is left alone). */
export function guardCritter(look: CritterLook): CritterLook {
  return NO_SPOTS.includes(look.color) && look.marks === 'spots' ? { ...look, marks: 'belly' } : { ...look };
}

const EYE_WEIGHTS = [['dot', 4], ['bean', 3], ['arc', 2], ['sleepy', 1]] as const;
const MARK_WEIGHTS = [['none', 3], ['belly', 2], ['spots', 2], ['cap', 2]] as const;

const oneOf = <T extends string>(xs: readonly T[], v: unknown): v is T => typeof v === 'string' && (xs as readonly string[]).includes(v);

/** A stored Critter, guarded; null for anything else. Unknown extra fields are dropped. */
export function parseCritter(v: unknown): CritterLook | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (
    !oneOf(BODIES, o.body) ||
    !oneOf(EARS, o.ears) ||
    !oneOf(EYES, o.eyes) ||
    !oneOf(MOUTHS, o.mouth) ||
    !oneOf(MARKS, o.marks) ||
    typeof o.cheeks !== 'boolean' ||
    !oneOf(COLOR_NAMES, o.color) ||
    !oneOf(BACKDROP_NAMES, o.backdrop)
  ) {
    return null;
  }
  return guardCritter({ body: o.body, ears: o.ears, eyes: o.eyes, mouth: o.mouth, marks: o.marks, cheeks: o.cheeks, color: o.color, backdrop: o.backdrop });
}

// ------------------------------------------------------------------ the look a version-24 database holds
// { body: '#rrggbb', bg: '#rrggbb', eyes: 1 | 2, hair, mouth }: a colored capsule on a colored disc. It maps to
// the closest Critter, field by field, so a Boton keeps what made it recognizable: its color family, its
// backdrop's hue, what it wore on top (as ears) and its mouth. What has no counterpart (body shape, markings,
// cheeks) is seeded from the Boton's id, so the result is the same every time and on every machine.

/** Whether `v` has the version-24 shape: a capsule look. Fields need not be valid; each falls back on its own. */
export function isLook24(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'hair' in o || 'bg' in o || (typeof o.body === 'string' && o.body.startsWith('#'));
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** [hue in degrees, saturation 0–1, lightness 0–1]. */
export function hsl(h: string): [number, number, number] {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const l = (mx + mn) / 2;
  let hue = 0;
  if (d) {
    hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l];
}

/** The saturated yellow band no body color may sit in. */
export function isYellow(h: string): boolean {
  const [H, S, L] = hsl(h);
  return H >= 40 && H <= 66 && S >= 0.45 && L >= 0.3 && L <= 0.92;
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** The palette entry closest to `hex`: hue distance weighted by saturation, plus lightness. Ties go to the first. */
function nearest<K extends string>(hex: string, palette: Readonly<Record<K, string>>): K {
  const [H, S, L] = hsl(hex);
  let best = Object.keys(palette)[0] as K;
  let score = Infinity;
  for (const [k, v] of Object.entries(palette) as [K, string][]) {
    const [h2, s2, l2] = hsl(v);
    const sc = hueDist(H, h2) * Math.min(S, s2) + Math.abs(L - l2) * 90;
    if (sc < score) {
      score = sc;
      best = k;
    }
  }
  return best;
}

// The swatches the capsule editor offered, mapped by hand; any other color goes to the nearest one.
const BODY_24: Record<string, CritterColor> = { '#9b5de5': 'lilac', '#7bd389': 'sage', '#5fb3f9': 'sky', '#ff8fab': 'rose', '#ff9f43': 'peach' };
/** Yellow has no Critter counterpart: a seeded pick of warm colors instead. */
const FOR_YELLOW: readonly CritterColor[] = ['coral', 'peach', 'sand', 'mint'];
const BG_24: Record<string, CritterBackdrop> = {
  '#2f6fed': 'navy',
  '#1fb57a': 'forest',
  '#ef6c2f': 'cocoa',
  '#e0457b': 'wine',
  '#8b5cf6': 'indigo',
  '#14b8c4': 'teal',
  '#f2b21b': 'cocoa',
  '#5b6170': 'slate',
};
const HAIR_24: Record<string, CritterEars> = { none: 'round', sprout: 'feelers', spiky: 'point', combed: 'floppy', antenna: 'long' };
const MOUTH_24: Record<string, CritterMouth> = { smile: 'smile', grin: 'open', o: 'o', flat: 'w' };

/**
 * The closest Critter to a version-24 look, seeded by `seed` (the Boton's id, or a template's). The draws are
 * those of the approved design preview, in its order, so a look migrates to what that preview showed for it.
 */
export function critterFromLook24(old: Record<string, unknown>, seed: string): CritterLook {
  const r = seeded(hash32(seed));
  const body = pick(r, BODIES);
  const ears = (typeof old.hair === 'string' && Object.hasOwn(HAIR_24, old.hair) && HAIR_24[old.hair]) || 'round';
  const eyes: CritterEyes = old.eyes === 1 ? 'arc' : pick(r, ['dot', 'bean'] as const);
  const mouth = (typeof old.mouth === 'string' && Object.hasOwn(MOUTH_24, old.mouth) && MOUTH_24[old.mouth]) || 'smile';
  const marks = weighted(r, MARK_WEIGHTS);
  const cheeks = r() < 0.5;
  const hexBody = typeof old.body === 'string' && HEX.test(old.body) ? old.body.toLowerCase() : null;
  const color = hexBody ? BODY_24[hexBody] || (isYellow(hexBody) ? pick(r, FOR_YELLOW) : nearest(hexBody, COLORS)) : pick(r, COLOR_NAMES);
  const hexBg = typeof old.bg === 'string' && HEX.test(old.bg) ? old.bg.toLowerCase() : null;
  const backdrop = hexBg ? BG_24[hexBg] || nearest(hexBg, BACKDROPS) : pick(r, BACKDROP_NAMES);
  return guardCritter({ body, ears, eyes, mouth, marks, cheeks, color, backdrop });
}
