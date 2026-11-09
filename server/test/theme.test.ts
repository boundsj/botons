import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
function boot(saved: string | null, dark = false, blocked = false) {
  const listeners: Record<string, (event?: any) => void> = {};
  const metas = { 'color-scheme': { content: '' }, 'theme-color': { content: '' } };
  const root = { dataset: {} as Record<string, string>, style: {} };
  const media = { matches: dark, addEventListener: (_: string, fn: () => void) => { listeners.system = fn; } };
  const storage = new Map(saved ? [['botons.theme', saved]] : []);
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
