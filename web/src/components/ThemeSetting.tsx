import { useId, useSyncExternalStore } from 'react';

type Preference = 'system' | 'light' | 'dark';
/** How dark looks: the usual blue-black, or ultra black (true black). */
type DarkStyle = 'dark' | 'black';
declare global {
  interface Window {
    botonsTheme: { get: () => Preference; set: (value: Preference) => void; darkStyle: () => DarkStyle; setDarkStyle: (value: DarkStyle) => void };
  }
}
const subscribe = (notify: () => void) => {
  window.addEventListener('botons-theme', notify);
  return () => window.removeEventListener('botons-theme', notify);
};
const snapshot = () => window.botonsTheme.get();
const styleSnapshot = () => window.botonsTheme.darkStyle();

export function ThemeSetting({ quick = false }: { quick?: boolean }) {
  const preference = useSyncExternalStore(subscribe, snapshot);
  const style = useSyncExternalStore(subscribe, styleSnapshot);
  const hint = useId();
  if (quick) return <button type="button" className="theme-quick" aria-label="Toggle light or dark mode" title="Toggle light or dark mode" onClick={() => window.botonsTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>☀ / ☾</button>;
  return (
    <div className="theme-setting">
      <label><span className="field-label">Appearance</span><select aria-label="Appearance" value={preference} onChange={event => window.botonsTheme.set(event.target.value as Preference)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label className="check"><input type="checkbox" checked={style === 'black'} aria-describedby={hint} onChange={event => window.botonsTheme.setDarkStyle(event.target.checked ? 'black' : 'dark')} /> Ultra black</label>
      <span className="hint" id={hint}>Saved on this device. System follows your device’s appearance. Ultra black uses true black whenever Botons is dark, System at night included.</span>
    </div>
  );
}
