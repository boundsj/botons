import type { BotonArms, BotonBackdrop, BotonBrows, BotonEars, BotonEyes, BotonGlow, BotonLook, BotonMouth, BotonPanel, BotonShape, BotonShell, BotonTop, BotonVisor } from './types.ts';
import { critterFromLook24, isLook24, parseCritter } from './look-critter.ts';
import { parseTater, type TaterLook, taterFromCritter } from './look-tater.ts';
import { hash32, pick, type Rand, seeded, weighted } from './seeded.ts';

// A Boton's look: a button-bot built from fixed parts. Every field is one of a fixed set of names, so a stored look
// can never carry markup or an arbitrary color into the renderer (shared/boton.ts).
// This file imports only Node-free modules: the schema upgrade (server/src/schema.ts) and the CLI-free scripts load it.

export { hash32, seeded };

export const SHAPES: readonly BotonShape[] = ['round', 'pill', 'key'];
export const EYES: readonly BotonEyes[] = ['dots', 'rings', 'bars', 'happy', 'wink', 'lidded'];
export const BROWS: readonly BotonBrows[] = ['none', 'soft', 'straight', 'arched', 'bold'];
export const MOUTHS: readonly BotonMouth[] = ['smile', 'grin', 'smirk', 'o', 'calm', 'wave'];
export const TOPS: readonly BotonTop[] = ['none', 'antenna', 'twin', 'dish', 'coil', 'fin', 'beacon', 'halo'];
export const EARS: readonly BotonEars[] = ['none', 'bolts', 'pods', 'fins', 'knobs'];
export const VISORS: readonly BotonVisor[] = ['none', 'goggles', 'monocle', 'band'];
export const PANELS: readonly BotonPanel[] = ['none', 'holes', 'grill', 'leds', 'dial', 'switch'];
export const ARMS: readonly BotonArms[] = ['none', 'nubs', 'wave', 'cheer'];

/** Shell colors. The display carries the face, so a shell only has to stand out from its backdrop. */
export const SHELLS: Readonly<Record<BotonShell, string>> = {
  snow: '#eef2f7',
  steel: '#a9b4c6',
  graphite: '#323a4c',
  sun: '#f4c53d',
  signal: '#f0624d',
  cobalt: '#3f63e0',
  violet: '#8457e6',
  teal: '#17a99d',
};
/** The light of the face and the rim. Every one is 7:1 or better on the display glass. */
export const GLOWS: Readonly<Record<BotonGlow, string>> = { cyan: '#3ee6ff', pink: '#ff6ad5', lime: '#a8ff5c', amber: '#ffbe45', violet: '#b49bff', ice: '#e8f6ff' };
/** The disc behind the Boton. Its skirt or its rim light keeps every shell at 3:1 or better against it. */
export const BACKDROPS: Readonly<Record<BotonBackdrop, string>> = {
  mist: '#e7ecf3',
  ice: '#d4f2fa',
  mint: '#d3f4e2',
  lilac: '#e6defa',
  blush: '#fbdde8',
  night: '#121b36',
  plum: '#2a1842',
  grid: '#090d18',
};
/** Backdrops dark enough that sleep marks are drawn light. */
export const DARK_BACKDROPS: readonly BotonBackdrop[] = ['night', 'plum', 'grid'];

export const SHELL_NAMES = Object.keys(SHELLS) as BotonShell[];
export const GLOW_NAMES = Object.keys(GLOWS) as BotonGlow[];
export const BACKDROP_NAMES = Object.keys(BACKDROPS) as BotonBackdrop[];

/** Every part and its choices, in the builder's order. */
export const PARTS = {
  shape: SHAPES,
  shell: SHELL_NAMES,
  glow: GLOW_NAMES,
  eyes: EYES,
  brows: BROWS,
  mouth: MOUTHS,
  top: TOPS,
  ears: EARS,
  visor: VISORS,
  panel: PANELS,
  arms: ARMS,
  backdrop: BACKDROP_NAMES,
} as const;
export type Part = keyof typeof PARTS;

/** The look a new Boton starts from before anything is chosen: the brand Boton. */
export const DEFAULT_LOOK: BotonLook = { shape: 'round', shell: 'snow', glow: 'cyan', eyes: 'dots', brows: 'none', mouth: 'smile', top: 'antenna', ears: 'none', visor: 'none', panel: 'none', arms: 'nubs', backdrop: 'night', cheeks: true };

// Weights for a random look: a friendly face on any shell, and only now and then ears, a visor or a panel, so a
// crowd of Botons reads as a family and each still has something of its own.
const EYES_W = [['dots', 5], ['rings', 3], ['bars', 3], ['happy', 2], ['wink', 1], ['lidded', 1]] as const;
const BROWS_W = [['none', 5], ['soft', 2], ['straight', 1], ['arched', 1], ['bold', 1]] as const;
const MOUTH_W = [['smile', 5], ['grin', 2], ['calm', 2], ['smirk', 1], ['o', 1], ['wave', 1]] as const;
const TOP_W = [['antenna', 4], ['none', 3], ['twin', 1], ['dish', 1], ['coil', 1], ['fin', 1], ['beacon', 1], ['halo', 1]] as const;
const EARS_W = [['none', 6], ['bolts', 1], ['pods', 1], ['fins', 1], ['knobs', 1]] as const;
const VISOR_W = [['none', 8], ['goggles', 1], ['monocle', 1], ['band', 1]] as const;
const PANEL_W = [['none', 6], ['holes', 2], ['grill', 1], ['leds', 1], ['dial', 1], ['switch', 1]] as const;
const ARMS_W = [['nubs', 6], ['none', 2], ['wave', 1], ['cheer', 1]] as const;

/** A random look; `r` may be seeded for a stable one. */
export function randomLook(r: Rand = Math.random): BotonLook {
  return {
    shape: weighted(r, [['round', 3], ['pill', 2], ['key', 2]] as const),
    shell: pick(r, SHELL_NAMES),
    glow: pick(r, GLOW_NAMES),
    eyes: weighted(r, EYES_W),
    brows: weighted(r, BROWS_W),
    mouth: weighted(r, MOUTH_W),
    top: weighted(r, TOP_W),
    ears: weighted(r, EARS_W),
    visor: weighted(r, VISOR_W),
    panel: weighted(r, PANEL_W),
    arms: weighted(r, ARMS_W),
    backdrop: pick(r, BACKDROP_NAMES),
    cheeks: r() < 0.6,
  };
}

const oneOf = <T extends string>(xs: readonly T[], v: unknown): v is T => typeof v === 'string' && (xs as readonly string[]).includes(v);

/** A look as the API and the database hold it; null for anything else. Unknown extra fields are dropped. */
export function parseLook(v: unknown): BotonLook | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const [part, values] of Object.entries(PARTS)) if (!oneOf(values as readonly string[], o[part])) return null;
  if (typeof o.cheeks !== 'boolean') return null;
  const look = Object.fromEntries([...Object.keys(PARTS), 'cheeks'].map((k) => [k, o[k]]));
  return look as unknown as BotonLook;
}

// ------------------------------------------------------------------ tater looks, which a database at 32 holds
// A tater look maps to its closest Boton field by field, with no randomness: its shape becomes a button, its toast a
// shell, its wear color the glow, what it wore on top an antenna or more (headphones become pod ears), its glasses a
// visor and its extras a panel; its face, arms and cheeks carry over, and the backdrop keeps its light or dark.

const SHAPE_T: Record<TaterLook['shape'], BotonShape> = { classic: 'round', tall: 'key', chunky: 'pill' };
const SHELL_T: Record<TaterLook['toast'], BotonShell> = { raw: 'snow', golden: 'sun', toasty: 'steel', crispy: 'graphite', sweet: 'signal', purple: 'violet', veggie: 'teal' };
const GLOW_T: Record<TaterLook['wear'], BotonGlow> = { tomato: 'pink', sage: 'lime', sky: 'cyan', plum: 'violet', ink: 'ice', cream: 'amber' };
const EYES_T: Record<TaterLook['eyes'], BotonEyes> = { dots: 'dots', buttons: 'rings', ovals: 'bars', happy: 'happy', wink: 'wink', lidded: 'lidded' };
const MOUTH_T: Record<TaterLook['mouth'], BotonMouth> = { smile: 'smile', grin: 'grin', smirk: 'smirk', o: 'o', calm: 'calm', w: 'wave' };
const TOP_T: Record<TaterLook['hat'], BotonTop> = { none: 'none', sprout: 'antenna', beanie: 'beacon', cap: 'fin', headphones: 'none', bucket: 'dish', beret: 'halo', party: 'twin' };
const VISOR_T: Record<TaterLook['glasses'], BotonVisor> = { none: 'none', round: 'goggles', square: 'monocle', shades: 'band' };
const PANEL_T: Record<TaterLook['extra'], BotonPanel> = { none: 'none', scarf: 'grill', bowtie: 'switch', pin: 'dial', lanyard: 'leds' };
const BACKDROP_T: Record<TaterLook['backdrop'], BotonBackdrop> = { cream: 'mist', butter: 'mist', sage: 'mint', sky: 'ice', blush: 'blush', lilac: 'lilac', cocoa: 'plum', night: 'night' };

/** The closest Boton to a tater look. */
export function lookFromTater(t: TaterLook): BotonLook {
  return {
    shape: SHAPE_T[t.shape],
    shell: SHELL_T[t.toast],
    glow: GLOW_T[t.wear],
    eyes: EYES_T[t.eyes],
    brows: t.brows,
    mouth: MOUTH_T[t.mouth],
    top: TOP_T[t.hat],
    ears: t.hat === 'headphones' ? 'pods' : 'none',
    visor: VISOR_T[t.glasses],
    panel: PANEL_T[t.extra],
    arms: t.arms,
    backdrop: BACKDROP_T[t.backdrop],
    cheeks: t.cheeks,
  };
}

/** Whether a stored value is a look from before Botons (a tater look, a Critter or a capsule), which lookFor maps. */
export function isEarlierLook(v: unknown): boolean {
  return parseLook(v) === null && (parseTater(v) !== null || parseCritter(v) !== null || isLook24(v));
}

/**
 * Any stored look as a Boton, never failing: a Boton look as it is, a tater look mapped to its closest Boton, a
 * Critter (or a capsule, through its closest Critter) through its closest tater look, and anything else (missing,
 * unreadable) a Boton seeded from `seed`.
 */
export function lookFor(v: unknown, seed: string): BotonLook {
  const look = parseLook(v);
  if (look) return look;
  const tater = parseTater(v);
  if (tater) return lookFromTater(tater);
  const critter = parseCritter(v) ?? (isLook24(v) ? critterFromLook24(v, seed) : null);
  return critter ? lookFromTater(taterFromCritter(critter)) : randomLook(seeded(hash32(`look:${seed}`)));
}

const LABELS = {
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
} as const satisfies { [K in Part]: Record<BotonLook[K], string> };

/** The builder's names for each choice. */
export const LOOK_LABELS: typeof LABELS = LABELS;

/** A short description of a look, for a screen reader: "Snow round Boton with a cyan glow, an antenna and goggles, on night". */
export function describeLook(l: BotonLook): string {
  const lower = (s: string) => s.toLowerCase();
  const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');
  const named = (s: string) => `${article(s)} ${lower(s)}`;
  const wearing = [
    `${named(LABELS.glow[l.glow])} glow`,
    l.top !== 'none' ? named(LABELS.top[l.top] + (l.top === 'twin' ? ' antennas' : '')).replace(/^a twin/, 'twin') : '',
    l.ears !== 'none' ? `${lower(LABELS.ears[l.ears])} for ears` : '',
    l.visor === 'goggles' ? 'goggles' : l.visor !== 'none' ? named(LABELS.visor[l.visor]) : '',
    l.panel !== 'none' ? (l.panel === 'holes' ? 'button holes' : l.panel === 'leds' ? 'a row of lights' : named(LABELS.panel[l.panel])) : '',
  ].filter(Boolean);
  const list = wearing.length > 1 ? `${wearing.slice(0, -1).join(', ')} and ${wearing.at(-1)}` : wearing[0];
  return `${LABELS.shell[l.shell]} ${lower(LABELS.shape[l.shape])} Boton with ${list}, on ${lower(LABELS.backdrop[l.backdrop])}`;
}
