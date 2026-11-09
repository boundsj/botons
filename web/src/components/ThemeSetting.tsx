import { useSyncExternalStore } from 'react';

type Preference = 'system' | 'light' | 'dark';
declare global {
  interface Window { botonsTheme: { get: () => Preference; set: (value: Preference) => void } }
}
const subscribe = (notify: () => void) => {
  window.addEventListener('botons-theme', notify);
  return () => window.removeEventListener('botons-theme', notify);
};
const snapshot = () => window.botonsTheme.get();

export function ThemeSetting({ quick = false }: { quick?: boolean }) {
  const preference = useSyncExternalStore(subscribe, snapshot);
  if (quick) return <button type="button" className="theme-quick" aria-label="Toggle light or dark mode" title="Toggle light or dark mode" onClick={() => window.botonsTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>☀ / ☾</button>;
  return <label><span className="field-label">Appearance</span><select aria-label="Appearance" value={preference} onChange={event => window.botonsTheme.set(event.target.value as Preference)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><span className="hint">Saved on this device. System follows your device’s appearance.</span></label>;
}
