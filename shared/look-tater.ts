import { type CritterLook, critterFromLook24, isLook24, parseCritter } from './look-critter.ts';
import { hash32, pick, type Rand, seeded, weighted } from './seeded.ts';

// Tater looks: the looks a database at schema version 32 holds, a tater Boton built from fixed parts. They are read,
// never drawn: shared/look.ts maps each one to its closest Boton, in the schema upgrade and on import. The 31-to-32
// upgrade turns Critters and capsules into tater looks with taterLookFor, exactly as it always has, and the next
// upgrade takes them on to Botons. This file imports only Node-free modules: the schema upgrade
// (server/src/schema.ts) and the CLI-free scripts load it.

export type TaterShape = 'classic' | 'tall' | 'chunky';
export type TaterToast = 'raw' | 'golden' | 'toasty' | 'crispy' | 'sweet' | 'purple' | 'veggie';
export type TaterEyes = 'dots' | 'buttons' | 'ovals' | 'happy' | 'wink' | 'lidded';
export type TaterBrows = 'none' | 'soft' | 'straight' | 'arched' | 'bold';
export type TaterMouth = 'smile' | 'grin' | 'smirk' | 'o' | 'calm' | 'w';
export type TaterHat = 'none' | 'sprout' | 'beanie' | 'cap' | 'headphones' | 'bucket' | 'beret' | 'party';
export type TaterGlasses = 'none' | 'round' | 'square' | 'shades';
export type TaterExtra = 'none' | 'scarf' | 'bowtie' | 'pin' | 'lanyard';
export type TaterArms = 'none' | 'nubs' | 'wave' | 'cheer';
export type TaterWear = 'tomato' | 'sage' | 'sky' | 'plum' | 'ink' | 'cream';
export type TaterBackdrop = 'cream' | 'butter' | 'sage' | 'sky' | 'blush' | 'lilac' | 'cocoa' | 'night';

export interface TaterLook {
  shape: TaterShape;
  toast: TaterToast;
  eyes: TaterEyes;
  brows: TaterBrows;
  mouth: TaterMouth;
  hat: TaterHat;
  glasses: TaterGlasses;
  extra: TaterExtra;
  arms: TaterArms;
  wear: TaterWear;
  backdrop: TaterBackdrop;
  cheeks: boolean;
}

export const TATER_PARTS = {
  shape: ['classic', 'tall', 'chunky'],
  toast: ['raw', 'golden', 'toasty', 'crispy', 'sweet', 'purple', 'veggie'],
  eyes: ['dots', 'buttons', 'ovals', 'happy', 'wink', 'lidded'],
  brows: ['none', 'soft', 'straight', 'arched', 'bold'],
  mouth: ['smile', 'grin', 'smirk', 'o', 'calm', 'w'],
  hat: ['none', 'sprout', 'beanie', 'cap', 'headphones', 'bucket', 'beret', 'party'],
  glasses: ['none', 'round', 'square', 'shades'],
  extra: ['none', 'scarf', 'bowtie', 'pin', 'lanyard'],
  arms: ['none', 'nubs', 'wave', 'cheer'],
  wear: ['tomato', 'sage', 'sky', 'plum', 'ink', 'cream'],
  backdrop: ['cream', 'butter', 'sage', 'sky', 'blush', 'lilac', 'cocoa', 'night'],
} as const satisfies { [K in keyof Omit<TaterLook, 'cheeks'>]: readonly TaterLook[K][] };

const oneOf = (xs: readonly string[], v: unknown): boolean => typeof v === 'string' && xs.includes(v);

/** A tater look as a database or a file holds it; null for anything else. Unknown extra fields are dropped. */
export function parseTater(v: unknown): TaterLook | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const [part, values] of Object.entries(TATER_PARTS)) if (!oneOf(values, o[part])) return null;
  if (typeof o.cheeks !== 'boolean') return null;
  return Object.fromEntries([...Object.keys(TATER_PARTS), 'cheeks'].map((k) => [k, o[k]])) as unknown as TaterLook;
}

// A random tater look, for a stored look that couldn't be read: the 31-to-32 upgrade seeds one from the id.
const TOAST_W = [['golden', 5], ['toasty', 3], ['raw', 2], ['crispy', 2], ['sweet', 2], ['purple', 1], ['veggie', 1]] as const;
const EYES_W = [['dots', 5], ['buttons', 3], ['ovals', 3], ['happy', 2], ['wink', 1], ['lidded', 1]] as const;
const BROWS_W = [['none', 5], ['soft', 2], ['straight', 1], ['arched', 1], ['bold', 1]] as const;
const MOUTH_W = [['smile', 5], ['grin', 2], ['calm', 2], ['smirk', 1], ['o', 1], ['w', 1]] as const;
const HAT_W = [['none', 6], ['sprout', 1], ['beanie', 1], ['cap', 1], ['headphones', 1], ['bucket', 1], ['beret', 1], ['party', 1]] as const;
const GLASSES_W = [['none', 8], ['round', 1], ['square', 1], ['shades', 1]] as const;
const EXTRA_W = [['none', 7], ['scarf', 1], ['bowtie', 1], ['pin', 1], ['lanyard', 1]] as const;
const ARMS_W = [['nubs', 6], ['none', 2], ['wave', 1], ['cheer', 1]] as const;

export function randomTater(r: Rand): TaterLook {
  return {
    shape: weighted(r, [['classic', 3], ['tall', 2], ['chunky', 2]] as const),
    toast: weighted(r, TOAST_W),
    eyes: weighted(r, EYES_W),
    brows: weighted(r, BROWS_W),
    mouth: weighted(r, MOUTH_W),
    hat: weighted(r, HAT_W),
    glasses: weighted(r, GLASSES_W),
    extra: weighted(r, EXTRA_W),
    arms: weighted(r, ARMS_W),
    wear: pick(r, TATER_PARTS.wear),
    backdrop: pick(r, TATER_PARTS.backdrop),
    cheeks: r() < 0.6,
  };
}

// A Critter maps to its closest tater look field by field, with no randomness.
const SHAPE_C: Record<CritterLook['body'], TaterShape> = { bun: 'classic', loaf: 'tall', round: 'chunky', pebble: 'classic' };
const TOAST_C: Record<CritterLook['color'], TaterToast> = { coral: 'sweet', peach: 'toasty', rose: 'crispy', sand: 'raw', sage: 'veggie', mint: 'veggie', seafoam: 'golden', sky: 'golden', lilac: 'purple', periwinkle: 'purple' };
const WEAR_C: Record<CritterLook['color'], TaterWear> = { coral: 'tomato', peach: 'tomato', rose: 'plum', sand: 'cream', sage: 'sage', mint: 'sage', seafoam: 'sky', sky: 'sky', lilac: 'plum', periwinkle: 'sky' };
const BACKDROP_C: Record<CritterLook['backdrop'], TaterBackdrop> = { navy: 'sky', plum: 'lilac', forest: 'sage', wine: 'blush', slate: 'night', cocoa: 'cocoa', indigo: 'lilac', teal: 'sage' };
const HAT_C: Record<CritterLook['ears'], TaterHat> = { point: 'cap', round: 'none', long: 'headphones', floppy: 'beanie', feelers: 'sprout' };
const EYES_C: Record<CritterLook['eyes'], TaterEyes> = { dot: 'dots', bean: 'ovals', arc: 'happy', sleepy: 'lidded' };
const MOUTH_C: Record<CritterLook['mouth'], TaterMouth> = { smile: 'smile', open: 'grin', o: 'o', w: 'w' };
const EXTRA_C: Record<CritterLook['marks'], TaterExtra> = { none: 'none', belly: 'scarf', spots: 'none', cap: 'pin' };

/** The closest tater look to a Critter. */
export function taterFromCritter(c: CritterLook): TaterLook {
  const hat = HAT_C[c.ears] === 'none' && c.marks === 'cap' ? 'beret' : HAT_C[c.ears];
  return {
    shape: SHAPE_C[c.body],
    toast: TOAST_C[c.color],
    eyes: EYES_C[c.eyes],
    brows: c.marks === 'spots' ? 'soft' : 'none',
    mouth: MOUTH_C[c.mouth],
    hat,
    glasses: 'none',
    extra: EXTRA_C[c.marks],
    arms: 'nubs',
    wear: WEAR_C[c.color],
    backdrop: BACKDROP_C[c.backdrop],
    cheeks: c.cheeks,
  };
}

/**
 * Any look a database at version 31 holds, as a tater look, never failing: a tater look as it is, a Critter mapped to
 * its closest, a capsule through its closest Critter, and anything else one seeded from `seed`.
 */
export function taterLookFor(v: unknown, seed: string): TaterLook {
  const tater = parseTater(v);
  if (tater) return tater;
  const critter = parseCritter(v) ?? (isLook24(v) ? critterFromLook24(v, seed) : null);
  return critter ? taterFromCritter(critter) : randomTater(seeded(hash32(`look:${seed}`)));
}
