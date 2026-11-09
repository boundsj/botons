import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freePort } from './helpers.ts';

test('fixture ports stay distinct before either listener binds', async (t) => {
  let candidate = 0;
  t.mock.method(Math, 'random', () => (candidate++ % 100) / 100);
  const first = await freePort();
  // Repeat the same candidates: an unbound first fixture must still own its port.
  candidate = 0;
  const second = await freePort();
  assert.notEqual(second, first);
});
