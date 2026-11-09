// The live view's pure parts: where the owner's pointer lands in the page through any scaling, the stream's chunks
// however the network splits them, and what a key does there.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitViewport, parseOwnerInput, pressed } from '../src/browser-handover.ts';
import { LiveParser, liveFrame, liveNotice, toPagePoint } from '../../shared/live-view.ts';
import { keyAction } from '../../web/src/takeover.ts';

test('a point on screen lands on the same spot of the page, through scaling, letterbox bands and any pixel ratio', () => {
  const page = { width: 1280, height: 800 };
  // Drawn at half size from (100, 50): the box is exactly the page's shape.
  const half = { left: 100, top: 50, width: 640, height: 400 };
  assert.deepEqual(toPagePoint(100, 50, half, page), { x: 0, y: 0 });
  assert.deepEqual(toPagePoint(420, 250, half, page), { x: 640, y: 400 });
  assert.deepEqual(toPagePoint(739.9, 449.9, half, page), { x: 1279, y: 799 });
  assert.equal(toPagePoint(99, 60, half, page), null);
  // A box taller than the page's shape: bands above and below, which land nowhere.
  const tall = { left: 0, top: 0, width: 640, height: 800 };
  assert.equal(toPagePoint(320, 100, tall, page), null);
  assert.deepEqual(toPagePoint(320, 400, tall, page), { x: 640, y: 400 });
  // A wider one: bands left and right.
  const wide = { left: 0, top: 0, width: 2000, height: 800 };
  assert.equal(toPagePoint(300, 400, wide, page), null);
  assert.deepEqual(toPagePoint(360, 0, wide, page), { x: 0, y: 0 });
  // A phone's page (390 CSS px wide) drawn larger than itself: CSS pixels on both sides, so a screen's pixel ratio
  // never enters; the frame's own pixels (twice as many at ratio 2) don't either.
  assert.deepEqual(toPagePoint(195, 422, { left: 0, top: 0, width: 390, height: 844 }, { width: 390, height: 844 }), { x: 195, y: 422 });
  assert.deepEqual(toPagePoint(390, 844, { left: 0, top: 0, width: 780, height: 1688 }, { width: 390, height: 844 }), { x: 195, y: 422 });
  assert.equal(toPagePoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, page), null);
});

test("the page follows the view within bounds, and inputs are fixed actions: editing shortcuts only, Meta read as Control", () => {
  assert.deepEqual(fitViewport(390.6, 700), { width: 391, height: 700 });
  assert.deepEqual(fitViewport(100, 100), { width: 320, height: 320 });
  assert.deepEqual(fitViewport(5000, 5000), { width: 1920, height: 1400 });
  const H = 'ho_abcdefgh12';
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'key', key: 'a', mods: ['Meta'] }), { handover: H, action: 'key', key: 'a', mods: ['Meta'] });
  assert.equal(pressed('a', ['Meta']), 'Control+a');
  assert.equal(pressed('ArrowLeft', ['Control', 'Shift']), 'Shift+Control+ArrowLeft');
  for (const bad of [{ key: 'l', mods: ['Control'] }, { key: 't', mods: ['Meta'] }, { key: 'a' }, { key: 'F12' }, { key: 'Tab', mods: ['Alt'] }]) {
    assert.throws(() => parseOwnerInput({ handover: H, action: 'key', ...bad }), JSON.stringify(bad));
  }
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'down', x: 5, y: 6, count: 2 }), { handover: H, action: 'down', x: 5, y: 6, button: 'left', count: 2 });
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'paste', text: 'two\nlines' }), { handover: H, action: 'paste', text: 'two\nlines' });
  // Back to the Boton's own page: the server holds its address; the device sends none.
  assert.deepEqual(parseOwnerInput({ handover: H, action: 'resume', url: 'https://elsewhere.example.com/' }), { handover: H, action: 'resume' });
});

test("the stream's chunks come out whole whichever way the bytes are split", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const bytes = new Uint8Array([...liveNotice({ type: 'page', url: 'https://example.com/', title: 'Example' }), ...liveFrame(jpeg, 390, 844)]);
  for (const step of [1, 3, 7, bytes.length]) {
    const p = new LiveParser();
    const out = [];
    for (let i = 0; i < bytes.length; i += step) out.push(...p.push(bytes.slice(i, i + step)));
    assert.equal(out.length, 2, `split every ${step}`);
    assert.deepEqual(out[0], { kind: 'notice', notice: { type: 'page', url: 'https://example.com/', title: 'Example' } });
    assert.ok(out[1].kind === 'frame' && out[1].width === 390 && out[1].height === 844);
    assert.deepEqual([...(out[1] as { jpeg: Uint8Array }).jpeg], [...jpeg]);
  }
});

test('a key in the view: named keys and editing shortcuts are sent, copy and paste are their own, text is typed, the rest stays the owner’s', () => {
  const k = (key: string, m: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    keyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...m });
  assert.deepEqual(k('Enter'), { kind: 'key', key: 'Enter', mods: [] });
  assert.deepEqual(k('Tab', { shiftKey: true }), { kind: 'key', key: 'Shift+Tab', mods: [] });
  assert.deepEqual(k('ArrowLeft', { shiftKey: true }), { kind: 'key', key: 'ArrowLeft', mods: ['Shift'] });
  assert.deepEqual(k('a', { metaKey: true }), { kind: 'key', key: 'a', mods: ['Control'] });
  assert.deepEqual(k('C', { ctrlKey: true, shiftKey: true }), { kind: 'copy', cut: false });
  assert.deepEqual(k('x', { metaKey: true }), { kind: 'copy', cut: true });
  assert.deepEqual(k('v', { ctrlKey: true }), { kind: 'paste' });
  assert.deepEqual(k('t', { ctrlKey: true }), { kind: 'own' });
  assert.deepEqual(k('ArrowLeft', { altKey: true }), { kind: 'own' });
  assert.deepEqual(k('é'), { kind: 'text' });
  assert.deepEqual(k(' '), { kind: 'text' });
});
