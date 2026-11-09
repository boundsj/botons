// Seeded randomness for looks. This file imports nothing: the schema upgrade and the CLI-free scripts load it.

// FNV-1a for strings, mulberry32 for a stream. The same seed gives the same look on every
// machine, so a migrated Boton looks the same wherever it is drawn.
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;
export const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(r() * xs.length))];
export function weighted<T>(r: Rand, entries: readonly (readonly [T, number])[]): T {
  let x = r() * entries.reduce((s, e) => s + e[1], 0);
  for (const [v, w] of entries) {
    x -= w;
    if (x < 0) return v;
  }
  return entries[entries.length - 1][0];
}

