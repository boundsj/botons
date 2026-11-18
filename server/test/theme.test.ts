import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
function boot(saved: string | null, dark = false, blocked = false, style: string | null = null) {
  const listeners: Record<string, (event?: any) => void> = {};
  const metas = { 'color-scheme': { content: '' }, 'theme-color': { content: '' } };
  const root = { dataset: {} as Record<string, string>, style: {} };
  const media = { matches: dark, addEventListener: (_: string, fn: () => void) => { listeners.system = fn; } };
  const storage = new Map([...(saved ? [['botons.theme', saved]] : []), ...(style ? [['botons.darkStyle', style]] : [])] as [string, string][]);
  const env: any = { document: { documentElement: root, querySelector: (s: string) => metas[s.includes('color-scheme') ? 'color-scheme' : 'theme-color'] }, matchMedia: () => media, localStorage: { getItem: (k: string) => { if (blocked) throw Error(); return storage.get(k); }, setItem: (k: string, v: string) => { if (blocked) throw Error(); storage.set(k, v); } }, addEventListener: (k: string, fn: any) => { listeners[k] = fn; }, dispatchEvent: () => {}, Event: class {} };
  env.window = env;
  runInNewContext(source, env);
  return { theme: env.botonsTheme, root, metas, media, listeners, storage };
}
test('system default resolves before paint and follows live system changes', () => {
  const b = boot(null);
  assert.equal(b.theme.get(), 'system'); assert.equal(b.root.dataset.theme, 'light');
  b.media.matches = true; b.listeners.system();
  assert.equal(b.root.dataset.theme, 'dark'); assert.equal(b.metas['theme-color'].content, '#0b0f19');
});
test('explicit preference persists, overrides system and syncs across tabs', () => {
  const b = boot('dark'); b.theme.set('light');
  b.media.matches = true; b.listeners.system();
  assert.equal(b.root.dataset.theme, 'light'); assert.equal(b.storage.get('botons.theme'), 'light');
  assert.equal(b.metas['color-scheme'].content, 'light');
  b.listeners.storage({ key: 'botons.theme', newValue: 'dark' }); assert.equal(b.theme.get(), 'dark');
  b.listeners.storage({ key: null, newValue: null }); assert.equal(b.theme.get(), 'system');
});
test('invalid and unavailable storage safely fall back to system', () => {
  assert.equal(boot('broken', true).root.dataset.theme, 'dark');
  const b = boot(null, false, true); b.theme.set('dark'); assert.equal(b.root.dataset.theme, 'dark');
});
test('ultra black is how dark looks: only while dark (System at night too), under its own key, and true black in the browser bar', () => {
  const b = boot('system', false, false, 'black');
  assert.equal(b.theme.darkStyle(), 'black');
  // Light by day: no ultra black, and the light browser bar.
  assert.equal(b.root.dataset.theme, 'light');
  assert.equal(b.root.dataset.darkStyle, undefined);
  b.media.matches = true; b.listeners.system();
  assert.equal(b.root.dataset.theme, 'dark');
  assert.equal(b.root.dataset.darkStyle, 'black');
  assert.equal(b.metas['theme-color'].content, '#000000');
  // Back to the usual dark: the attribute goes, the bar is blue-black again, and the theme choice is untouched.
  b.theme.setDarkStyle('dark');
  assert.equal(b.root.dataset.darkStyle, undefined);
  assert.equal(b.metas['theme-color'].content, '#0b0f19');
  assert.equal(b.storage.get('botons.darkStyle'), 'dark');
  assert.equal(b.storage.get('botons.theme'), 'system');
  // An explicit Light keeps light whatever the dark style.
  b.theme.setDarkStyle('black'); b.theme.set('light');
  assert.equal(b.root.dataset.darkStyle, undefined);
  b.theme.set('dark');
  assert.equal(b.root.dataset.darkStyle, 'black');
});

test('the dark style syncs across tabs, and unknown, missing or blocked values are the usual dark', () => {
  for (const style of [null, 'oled', 'BLACK']) assert.equal(boot('dark', false, false, style).root.dataset.darkStyle, undefined, String(style));
  const b = boot('dark');
  b.listeners.storage({ key: 'botons.darkStyle', newValue: 'black' });
  assert.equal(b.theme.darkStyle(), 'black');
  assert.equal(b.root.dataset.darkStyle, 'black');
  b.listeners.storage({ key: null, newValue: null });
  assert.deepEqual([b.theme.get(), b.theme.darkStyle(), b.root.dataset.darkStyle], ['system', 'dark', undefined]);
  // Storage blocked: the choice still applies to this page.
  const blocked = boot(null, true, true);
  blocked.theme.setDarkStyle('black');
  assert.equal(blocked.root.dataset.darkStyle, 'black');
});
