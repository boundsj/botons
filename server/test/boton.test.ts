import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKDROPS, DEFAULT_LOOK, describeLook, drawableLook, GLOWS, hash32, isEarlierLook, keepLeftOut, LOOK_LABELS, lookFor, lookFromTater, PARTS, parseLook, PRESETS, randomLook, seeded, SHELLS } from '../../shared/look.ts';
import { BACKDROP_NAMES, BODIES, COLOR_NAMES, type CritterLook, EARS, EYES, MARKS, MOUTHS, parseCritter } from '../../shared/look-critter.ts';
import { parseTater, TATER_PARTS, type TaterLook, taterFromCritter, taterLookFor } from '../../shared/look-tater.ts';
import { FEET_SCALE, GLASS, type Lod, lodFor, mix, OFF_RIM, skirtOf, STATES, botonInner } from '../../shared/boton.ts';
import type { BotonLook } from '../../shared/types.ts';

// WCAG 2.2 relative luminance and contrast.
const chan = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => [1, 3, 5].map((i) => chan(parseInt(h.slice(i, i + 2), 16))).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

const TATER: TaterLook = { shape: 'classic', toast: 'golden', eyes: 'dots', brows: 'none', mouth: 'smile', hat: 'none', glasses: 'none', extra: 'none', arms: 'nubs', wear: 'tomato', backdrop: 'cream', cheeks: true };

/** One look per value of every part, on the default: each choice drawn at least once. */
function* eachChoice(): Generator<BotonLook> {
  for (const [part, values] of Object.entries(PARTS)) for (const v of values) yield { ...DEFAULT_LOOK, [part]: v };
  yield { ...DEFAULT_LOOK, cheeks: false };
}
function* everyCritter(): Generator<CritterLook> {
  for (const body of BODIES)
    for (const ears of EARS)
      for (const eyes of EYES)
        for (const mouth of MOUTHS)
          for (const marks of MARKS) for (const cheeks of [true, false]) for (const color of COLOR_NAMES) for (const backdrop of BACKDROP_NAMES) yield { body, ears, eyes, mouth, marks, cheeks, color, backdrop };
}

test('parts: a look is exactly its fixed names; anything else is refused, and extra fields dropped', () => {
  assert.deepEqual(parseLook(DEFAULT_LOOK), DEFAULT_LOOK);
  assert.deepEqual(parseLook({ ...DEFAULT_LOOK, nose: 'big', toast: 'golden' }), DEFAULT_LOOK);
  for (const part of [...Object.keys(PARTS), 'cheeks']) {
    if (part !== 'feet') assert.equal(parseLook({ ...DEFAULT_LOOK, [part]: undefined }), null, `missing ${part}`);
    assert.equal(parseLook({ ...DEFAULT_LOOK, [part]: '<g onload="x">' }), null, `markup in ${part}`);
    assert.equal(parseLook({ ...DEFAULT_LOOK, [part]: 1 }), null, `a number in ${part}`);
  }
  for (const v of [null, undefined, 'snow', 7, [], [DEFAULT_LOOK], TATER]) assert.equal(parseLook(v), null);
  assert.equal(parseLook({ ...DEFAULT_LOOK, shell: 'constructor' }), null);
  assert.equal(parseLook({ ...DEFAULT_LOOK, cheeks: 'true' }), null);
});

test('parts: feet are optional, so a look stored before them stands on nothing, and a client that leaves them out keeps them', () => {
  const { feet: _, ...stored } = { ...DEFAULT_LOOK, shape: 'stack' as const };
  assert.deepEqual(parseLook(stored), { ...stored, feet: 'none' });
  assert.deepEqual(lookFor(stored, 'bot_a'), { ...stored, feet: 'none' });
  assert.equal(parseLook({ ...DEFAULT_LOOK, feet: 'skates' }), null);
  assert.equal(parseLook({ ...DEFAULT_LOOK, feet: null }), null);
  const current = { ...DEFAULT_LOOK, feet: 'wheel' as const };
  // An older app sends every part it knows and no feet: the Boton keeps its wheel.
  const older = { ...stored, eyes: 'happy' };
  assert.deepEqual(keepLeftOut(older, parseLook(older)!, current), { ...parseLook(older)!, feet: 'wheel' });
  // A client that knows feet changes them, or takes them off.
  for (const feet of ['legs', 'none'] as const) assert.equal(keepLeftOut({ ...DEFAULT_LOOK, feet }, { ...DEFAULT_LOOK, feet }, current).feet, feet);
  assert.deepEqual(keepLeftOut(older, parseLook(older)!, null), parseLook(older));
});

test('parts: button-bot parts only, every one named for the builder, nothing from a potato', () => {
  assert.deepEqual(Object.keys(PARTS).sort(), ['arms', 'backdrop', 'brows', 'ears', 'eyes', 'feet', 'glow', 'mouth', 'panel', 'shape', 'shell', 'top', 'visor']);
  for (const [part, values] of Object.entries(PARTS)) for (const v of values) assert.ok((LOOK_LABELS as Record<string, Record<string, string>>)[part][v], `${part} ${v} has a label`);
  const every = `${Object.values(PARTS).flat().join(' ')} ${Object.values(LOOK_LABELS).flatMap((l) => Object.values(l)).join(' ')}`;
  assert.doesNotMatch(every, /potato|tater|toast|crust|crumb|fry|fries|veggie|golden/i);
});

test('random looks are always valid, and the same seed gives the same look', () => {
  const r = seeded(7);
  for (let i = 0; i < 2000; i++) {
    const look = randomLook(r);
    assert.deepEqual(parseLook(look), look);
  }
  assert.deepEqual(randomLook(seeded(42)), randomLook(seeded(42)));
  // One draw per part, feet last: keep the same look for a seed across clients.
  assert.deepEqual(randomLook(seeded(42)), { shape: 'stack', shell: 'sun', glow: 'ice', eyes: 'happy', brows: 'none', mouth: 'calm', top: 'none', ears: 'pods', visor: 'band', panel: 'holes', arms: 'nubs', backdrop: 'grid', cheeks: false, feet: 'none' });
  assert.deepEqual(randomLook(seeded(hash32('look:Kevin'))), { shape: 'hex', shell: 'teal', glow: 'amber', eyes: 'dots', brows: 'straight', mouth: 'smirk', top: 'propeller', ears: 'bear', visor: 'goggles', panel: 'none', arms: 'wave', backdrop: 'grid', cheeks: false, feet: 'hover' });
});

test('random looks vary the silhouette: every body and every kind of feet turns up, and no one body takes over a crowd', () => {
  const r = seeded(11);
  const shapes = new Map<string, number>();
  const feet = new Set<string>();
  for (let i = 0; i < 4000; i++) {
    const look = randomLook(r);
    shapes.set(look.shape, (shapes.get(look.shape) ?? 0) + 1);
    feet.add(look.feet);
  }
  assert.deepEqual([...shapes.keys()].sort(), [...PARTS.shape].sort());
  assert.deepEqual([...feet].sort(), [...PARTS.feet].sort());
  assert.ok(Math.max(...shapes.values()) < 4000 * 0.3, JSON.stringify(Object.fromEntries(shapes)));
});

test('presets: whole, distinct looks with plain names, every body among them', () => {
  assert.ok(PRESETS.length >= 10);
  for (const p of PRESETS) {
    assert.deepEqual(parseLook(p.look), p.look, p.id);
    assert.match(p.name, /^[A-Z][a-z]+( [a-z]+)?$/, p.name);
    assert.match(p.id, /^[a-z-]+$/);
  }
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  assert.equal(new Set(PRESETS.map((p) => JSON.stringify(p.look))).size, PRESETS.length);
  assert.deepEqual(PRESETS[0].look, DEFAULT_LOOK);
  for (const shape of PARTS.shape) assert.ok(PRESETS.some((p) => p.look.shape === shape), `a preset with the ${shape} body`);
});

test('every tater choice maps to a valid Boton, the same every time, keeping its face, arms and cheeks', () => {
  const seen = new Set<string>();
  for (const [part, values] of Object.entries(TATER_PARTS))
    for (const v of values)
      for (const cheeks of [true, false]) {
        const tater = parseTater({ ...TATER, [part]: v, cheeks })!;
        const look = lookFromTater(tater);
        assert.deepEqual(parseLook(look), look, `${part} ${v}`);
        assert.deepEqual(lookFromTater(tater), look);
        assert.deepEqual(lookFor(tater, 'any seed'), look);
        assert.ok(isEarlierLook(tater));
        assert.deepEqual([look.brows, look.arms, look.cheeks], [tater.brows, tater.arms, tater.cheeks]);
        seen.add(JSON.stringify(look));
      }
  // Every tater choice changes the Boton, so a sidebar of them stays recognizable (cream and butter share mist).
  const choices = Object.values(TATER_PARTS).reduce((n, v) => n + v.length - 1, 1) * 2;
  assert.ok(seen.size >= choices - 2, `${seen.size} of ${choices}`);
  assert.deepEqual(lookFromTater({ ...TATER, shape: 'tall', toast: 'purple', hat: 'headphones', glasses: 'round', extra: 'scarf', wear: 'sky', backdrop: 'cocoa', mouth: 'w', eyes: 'buttons' }), { shape: 'key', shell: 'violet', glow: 'cyan', eyes: 'rings', brows: 'none', mouth: 'wave', top: 'none', ears: 'pods', visor: 'goggles', panel: 'grill', arms: 'nubs', feet: 'none', backdrop: 'plum', cheeks: true });
  // The backdrop keeps its light or dark.
  for (const b of TATER_PARTS.backdrop) assert.equal(['night', 'plum', 'grid'].includes(lookFromTater({ ...TATER, backdrop: b }).backdrop), ['cocoa', 'night'].includes(b), b);
});

test('every Critter maps to a valid Boton through its closest tater look, the same every time', () => {
  let n = 0;
  const seen = new Set<string>();
  for (const raw of everyCritter()) {
    // As a database holds it: through the Critter guardrails.
    const c = parseCritter(raw)!;
    const look = lookFor(c, 'any seed');
    assert.deepEqual(parseLook(look), look);
    assert.deepEqual(look, lookFromTater(taterFromCritter(c)));
    assert.deepEqual(taterLookFor(c, 'any seed'), taterFromCritter(c));
    assert.equal(look.cheeks, c.cheeks);
    assert.ok(isEarlierLook(c));
    seen.add(JSON.stringify(look));
    n++;
  }
  assert.equal(n, 4 * 5 * 4 * 4 * 4 * 2 * 10 * 8);
  assert.ok(seen.size > n / 4, `${seen.size} of ${n}`);
});

test('lookFor never fails: a Boton as it is, a capsule through its Critter and tater look, anything else a Boton seeded by the id', () => {
  assert.deepEqual(lookFor(DEFAULT_LOOK, 'x'), DEFAULT_LOOK);
  assert.equal(isEarlierLook(DEFAULT_LOOK), false);
  const capsule = { body: '#9b5de5', bg: '#2f6fed', eyes: 2, hair: 'sprout', mouth: 'smile' };
  assert.ok(isEarlierLook(capsule));
  assert.deepEqual(lookFor(capsule, 'bot_a'), lookFor(capsule, 'bot_a'));
  assert.deepEqual(lookFor(capsule, 'bot_a'), lookFromTater(taterLookFor(capsule, 'bot_a')));
  assert.equal(lookFor(capsule, 'bot_a').shell, 'violet');
  for (const junk of [null, {}, 'x', { body: 7 }]) {
    assert.deepEqual(parseLook(lookFor(junk, 'bot_b')), lookFor(junk, 'bot_b'));
    assert.deepEqual(lookFor(junk, 'bot_b'), lookFor(junk, 'bot_b'));
    assert.deepEqual(parseTater(taterLookFor(junk, 'bot_b')), taterLookFor(junk, 'bot_b'));
  }
});

test('colors: every glow reads on the display glass, and every shell stands out from every backdrop, lit or not', () => {
  for (const [name, hex] of Object.entries(GLOWS)) assert.ok(contrast(hex, GLASS) >= 7, `${name} on the glass: ${contrast(hex, GLASS).toFixed(2)}`);
  const weakestRim = (bd: string) => Math.min(...Object.values(GLOWS).map((g) => contrast(g, bd)));
  for (const [name, hex] of Object.entries(SHELLS))
    for (const [bd, bhex] of Object.entries(BACKDROPS)) {
      const best = Math.max(contrast(hex, bhex), contrast(skirtOf(hex), bhex), weakestRim(bhex));
      assert.ok(best >= 3, `${name} on ${bd}: ${best.toFixed(2)}`);
      // With no brain the rim is unlit and the shell greyer: its skirt or the unlit rim still makes the edge.
      const off = mix(hex, '#8a92a3', 0.35);
      const asleep = Math.max(contrast(off, bhex), contrast(skirtOf(off), bhex), contrast(OFF_RIM, bhex));
      assert.ok(asleep >= 3, `${name} asleep on ${bd}: ${asleep.toFixed(2)}`);
    }
});

test('the renderer: every choice in every state at every detail level is well-formed, uses only its own ids, and stays small', () => {
  const lods: Lod[] = [0, 1, 2];
  for (const look of eachChoice())
    for (const state of STATES)
      for (const lod of lods) {
        const svg = botonInner(look, { state, lod, uid: 'q', still: true });
        const opened = (svg.match(/<[a-zA-Z][^>]*>/g) ?? []).filter((t) => !t.endsWith('/>')).length;
        const closed = (svg.match(/<\/[a-zA-Z]+>/g) ?? []).length;
        assert.equal(opened, closed, `${JSON.stringify(look)} ${state} ${lod}`);
        for (const [, id] of svg.matchAll(/id="([^"]+)"/g)) assert.ok(id.startsWith('q'), id);
        for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(svg.includes(`id="${ref}"`), `${ref} is defined`);
        assert.doesNotMatch(svg, /class=|NaN|undefined|<script|\son\w+=|filter/);
        const elements = (svg.match(/<(?!\/)/g) ?? []).length;
        assert.ok(elements <= (lod === 0 ? 30 : 60), `${elements} elements at detail ${lod}: ${JSON.stringify(look)} ${state}`);
      }
});

test('the renderer: detail drops by size, and motion classes appear only where they belong', () => {
  assert.deepEqual([16, 24, 28, 32, 48, 72, 96, 128].map(lodFor), [0, 0, 0, 1, 1, 1, 2, 2]);
  // The rim the contrast test counts on is drawn at every size, lit or not.
  for (const lod of [0, 1, 2] as const) {
    assert.match(botonInner(DEFAULT_LOOK, { lod, uid: 'e', still: true }), new RegExp(`stroke="${GLOWS.cyan}" stroke-width="[0-9.]+" stroke-opacity=".9"/>`), `detail ${lod}`);
    assert.match(botonInner(DEFAULT_LOOK, { lod, uid: 'e', still: true, state: 'asleep' }), new RegExp(`stroke="${OFF_RIM}"`), `asleep at detail ${lod}`);
  }
  const look: BotonLook = { ...DEFAULT_LOOK, visor: 'goggles', panel: 'grill', ears: 'pods', top: 'dish' };
  // Small: no ears, visor, panel or halos, but the top and the state stay.
  const small = botonInner(look, { size: 16, uid: 's' });
  assert.doesNotMatch(small, /stroke-opacity=".22"|<rect x="[0-9.]+" y="[0-9.]+" width="9.2"/);
  assert.match(small, /rotate\(-16/);
  assert.ok(botonInner(look, { size: 48, uid: 'm' }).length > small.length);
  const classes = (o: Parameters<typeof botonInner>[1]) => [...new Set([...botonInner(DEFAULT_LOOK, o).matchAll(/class="([^"]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(classes({ state: 'idle' }), ['av-blink']);
  assert.deepEqual(classes({ state: 'working' }), ['av-spin']);
  assert.deepEqual(classes({ state: 'approval' }), ['av-wave']);
  assert.deepEqual(classes({ state: 'error' }), []);
  assert.deepEqual(classes({ state: 'asleep' }), ['av-zzz']);
  for (const state of STATES) assert.deepEqual(classes({ state, still: true }), []);
  // Each state draws differently from idle, even at the smallest size.
  const idle = botonInner(DEFAULT_LOOK, { size: 24, uid: 'x', still: true });
  for (const state of STATES.filter((s) => s !== 'idle')) assert.notEqual(botonInner(DEFAULT_LOOK, { size: 24, uid: 'x', state, still: true }), idle, state);
});

test('the renderer: bodies and feet stay inside the avatar, and a Boton with feet draws the rest smaller above them', () => {
  for (const shape of PARTS.shape)
    for (const feet of PARTS.feet)
      for (const state of STATES) {
        const look: BotonLook = { ...DEFAULT_LOOK, shape, feet, top: 'none', arms: 'none' };
        const svg = botonInner(look, { state, lod: 2, uid: 'f', still: true });
        // Every coordinate the feet use sits inside the round frame (radius 50 about 50, 50).
        if (feet !== 'none') {
          assert.match(svg, new RegExp(`<svg x="7" y="1.68" width="${100 * FEET_SCALE}" height="${100 * FEET_SCALE}" viewBox="0 0 100 100" overflow="visible">`));
          const under = svg.slice(svg.indexOf('<g>') + 3, svg.indexOf('<svg x='));
          for (const [, y] of under.matchAll(/(?:y|cy)="([\d.]+)"/g)) assert.ok(Number(y) < 97, `${shape} ${feet}: ${y}`);
        } else assert.doesNotMatch(svg, /<svg /);
      }
});

test('a look with names unknown to this build (from a newer server) draws and reads as the first choice of each part, never failing', () => {
  const newer = { ...DEFAULT_LOOK, shape: 'blimp', shell: 'chrome', glow: 'uv', eyes: 'lasers', brows: 'unibrow', mouth: 'beak', top: 'mohawk', ears: 'wings', visor: 'mask', panel: 'screen', arms: 'tentacles', feet: 'rockets', backdrop: 'space', cheeks: 'yes' } as unknown as BotonLook;
  const first = Object.fromEntries([...Object.entries(PARTS).map(([part, values]) => [part, values[0]]), ['cheeks', false]]) as unknown as BotonLook;
  assert.deepEqual(drawableLook(newer), first);
  for (const state of STATES) for (const lod of [0, 1, 2] as const) assert.equal(botonInner(newer, { state, lod, uid: 'u' }), botonInner(first, { state, lod, uid: 'u' }));
  assert.equal(describeLook(newer), describeLook(first));
  // A look missing feet (from a server before them) stands on nothing; a known look is returned as it is.
  const { feet: _, ...noFeet } = DEFAULT_LOOK;
  assert.equal(drawableLook(noFeet as BotonLook).feet, 'none');
  assert.equal(drawableLook(DEFAULT_LOOK), DEFAULT_LOOK);
});

test('the renderer: no part is a fin-shaped blade (arms end in hands, the crest is soft, the fins are slats)', () => {
  const svg = (o: Partial<BotonLook>) => botonInner({ ...DEFAULT_LOOK, ...o }, { lod: 2, uid: 'n', still: true });
  // Nubs hang at the sides with a round hand each.
  assert.equal((svg({ arms: 'nubs' }).match(/<circle cx="[\d.]+" cy="[\d.]+" r="3.3"/g) ?? []).length, 2);
  // The crest is curves, the fins three slats a side: no straight-edged triangle.
  assert.doesNotMatch(svg({ top: 'fin' }), /<path d="M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+Z"/);
  assert.equal((svg({ ears: 'fins' }).match(/a1.5 1.5 0 0 1 0 3h/g) ?? []).length, 6);
});

test('describeLook says what a screen reader needs', () => {
  assert.equal(describeLook(DEFAULT_LOOK), 'Snow round Boton with a cyan glow and an antenna, on night');
  assert.equal(describeLook({ ...DEFAULT_LOOK, top: 'twin', ears: 'pods', visor: 'goggles', panel: 'holes', glow: 'amber', shell: 'sun', shape: 'key', backdrop: 'grid' }), 'Sun key Boton with an amber glow, twin antennas, pods for ears, goggles and button holes, on grid');
  assert.equal(describeLook({ ...DEFAULT_LOOK, top: 'none', visor: 'band', panel: 'leds' }), 'Snow round Boton with a cyan glow, a band and a row of lights, on night');
  assert.equal(describeLook({ ...DEFAULT_LOOK, shape: 'tall', feet: 'wheel', top: 'crown', ears: 'cat', visor: 'shades' }), 'Snow tower Boton with a cyan glow, a crown, cat ears, shades and a wheel, on night');
  assert.equal(describeLook({ ...DEFAULT_LOOK, shape: 'saucer', feet: 'hover', top: 'fin', panel: 'heart' }), 'Snow saucer Boton with a cyan glow, a crest, a heart and a hover jet, on night');
});
