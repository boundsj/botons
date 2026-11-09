import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lookFromTater, parseLook } from '../../shared/look.ts';
import { type TaterLook, taterFromCritter } from '../../shared/look-tater.ts';
import { critterFromLook24, type CritterLook } from '../../shared/look-critter.ts';
import type { Bot, BotTemplate, BotonLook } from '../../shared/types.ts';
import { startServer } from './helpers.ts';

const s = await startServer();
const { call, newBot, home } = s;

const BOTON: BotonLook = { shape: 'pill', shell: 'cobalt', glow: 'lime', eyes: 'rings', brows: 'soft', mouth: 'grin', top: 'beacon', ears: 'none', visor: 'none', panel: 'grill', arms: 'nubs', backdrop: 'ice', cheeks: true };
const TATER: TaterLook = { shape: 'chunky', toast: 'toasty', eyes: 'buttons', brows: 'soft', mouth: 'grin', hat: 'beanie', glasses: 'none', extra: 'scarf', arms: 'nubs', wear: 'tomato', backdrop: 'sky', cheeks: true };
const fromCritter = (c: CritterLook) => lookFromTater(taterFromCritter(c));
const CRITTER: CritterLook = { body: 'round', ears: 'floppy', eyes: 'bean', mouth: 'w', marks: 'cap', cheeks: false, color: 'mint', backdrop: 'plum' };
const CAPSULE = { body: '#f4b400', bg: '#ef6c2f', eyes: 2, hair: 'spiky', mouth: 'grin' };

test('a new Boton gets a Boton look: the one it was given, or a random one', async () => {
  assert.deepEqual((await newBot('Juniper', { look: BOTON })).look, BOTON);
  const random = await newBot('Rowan');
  assert.deepEqual(parseLook(random.look), random.look);
});

test('a tater, Critter or capsule look from an older client becomes its closest Boton', async () => {
  assert.deepEqual((await newBot('Wren', { look: CRITTER })).look, fromCritter(CRITTER));
  assert.deepEqual((await newBot('Bob', { look: TATER })).look, lookFromTater(TATER));
  const bot = await newBot('Marlow', { look: CAPSULE });
  assert.deepEqual(bot.look, fromCritter(critterFromLook24(CAPSULE, bot.id)));
  const { data } = await call<Bot>('PATCH', `/api/bots/${bot.id}`, { look: CRITTER });
  assert.deepEqual(data.look, fromCritter(CRITTER));
  assert.deepEqual((await call<Bot>('PATCH', `/api/bots/${bot.id}`, { look: TATER })).data.look, lookFromTater(TATER));
});

test('a look that is none of these is refused and changes nothing', async () => {
  const bot = await newBot('Odile', { look: BOTON });
  const bad: unknown[] = [
    null,
    'golden',
    [],
    { ...BOTON, shell: 'yellow' },
    { ...BOTON, cheeks: 'yes' },
    { ...BOTON, top: undefined },
    { ...BOTON, top: 'bowler' },
    { ...BOTON, panel: 'mustache' },
    { ...BOTON, eyes: '<script>' },
    { ...TATER, toast: 'blue' },
    { ...CRITTER, color: 'yellow' },
    { ...CAPSULE, hair: 'mohawk' },
    { ...CAPSULE, body: 'red' },
  ];
  for (const look of bad) {
    const { status, data } = await call('PATCH', `/api/bots/${bot.id}`, { look });
    assert.equal(status, 400, JSON.stringify(look));
    assert.match((data as { error: string }).error, /look must have shape, shell, glow, eyes, brows, mouth, top/);
    assert.equal((await call('POST', '/api/bots', { name: 'Tamsin', provider: 'mock', look })).status, 400);
  }
  assert.deepEqual((await call<Bot>('GET', `/api/bots/${bot.id}`)).data.look, BOTON);
});

test('extra fields in a look are dropped', async () => {
  const bot = await newBot('Ines', { look: { ...BOTON, nose: 'big' } });
  assert.deepEqual(bot.look, BOTON);
});

test("templates: the starter looks are distinct Botons, a saved file's earlier look becomes its closest Boton, and an unreadable one none", async () => {
  mkdirSync(join(home, 'templates'), { recursive: true });
  const file = (id: string, look: unknown) =>
    writeFileSync(join(home, 'templates', `${id}.json`), JSON.stringify({ name: id, bot: { name: 'Sorrel', look }, routines: [] }));
  file('tpl_capsule1', CAPSULE);
  file('tpl_critter1', CRITTER);
  file('tpl_totlook1', BOTON);
  file('tpl_tater001', TATER);
  file('tpl_garble01', { body: 7 });
  const { data } = await call<BotTemplate[]>('GET', '/api/templates');
  const by = Object.fromEntries(data.map((t) => [t.id, t]));
  assert.deepEqual(by.tpl_capsule1.bot.look, fromCritter(critterFromLook24(CAPSULE, 'template:tpl_capsule1')));
  assert.deepEqual(by.tpl_critter1.bot.look, fromCritter(CRITTER));
  assert.deepEqual(by.tpl_tater001.bot.look, lookFromTater(TATER));
  assert.deepEqual(by.tpl_totlook1.bot.look, BOTON);
  assert.equal(by.tpl_garble01.bot.look, null);
  const starters = data.filter((t) => t.builtin);
  assert.ok(starters.length >= 4);
  for (const t of starters) assert.deepEqual(parseLook(t.bot.look), t.bot.look, t.id);
  assert.equal(new Set(starters.map((t) => JSON.stringify(t.bot.look))).size, starters.length);
});

test('a copy keeps its look', async () => {
  const bot = await newBot('Linden', { look: BOTON });
  const { data } = await call<Bot>('POST', `/api/bots/${bot.id}/duplicate`, {});
  assert.deepEqual(data.look, BOTON);
});
