import { authorizationValue, TOKEN_AS_NAME, tokenShapedName } from '../../shared/services.ts';

/** A header name the server takes (its HEADER_KEY rule). */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** One header row in the form. `saved`: it was saved before, so an empty value keeps it; `remove` deletes it. */
export interface HeaderRow {
  name: string;
  value: string;
  saved: boolean;
  remove: boolean;
}

/**
 * The headers patch for a save: the API key as Authorization (or its removal, which wins) (a bare token sent as Bearer), then the rows. A name
 * saved before in another case is replaced, not sent twice. Throws a message that names no value, so a token typed
 * into the wrong field never comes back in an error.
 */
export function headerPatch(apiKey: string, removeKey: boolean, rows: HeaderRow[], savedNames: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const set = (name: string, value: string | null) => {
    const same = (k: string) => k.toLowerCase() === name.toLowerCase();
    if (Object.keys(out).some((k) => same(k) && out[k] !== null)) throw new Error('A header is set twice. The key above is sent as Authorization.');
    for (const s of savedNames) if (s !== name && same(s)) out[s] = null;
    out[name] = value;
  };
  for (const r of rows) {
    const name = r.name.trim();
    const value = r.value.trim();
    if (!name && !value) continue;
    if (tokenShapedName(name)) throw new Error(TOKEN_AS_NAME);
    if (!HEADER_NAME.test(name)) throw new Error("A header name can have letters, digits and - only, with no spaces or ':'.");
    if (r.remove) {
      if (r.saved) set(name, null);
      continue;
    }
    if (!value) {
      if (r.saved) continue;
      throw new Error('Each new header needs a value.');
    }
    if (/[\r\n]/.test(r.value.trim())) throw new Error('Header values must be one line.');
    set(name, name.toLowerCase() === 'authorization' ? authorizationValue(value) : value);
  }
  const key = apiKey.trim();
  const savedAuth = savedNames.find((s) => s.toLowerCase() === 'authorization');
  // Removing the saved key wins over a key typed before Remove was chosen.
  if (removeKey) {
    if (savedAuth) set(savedAuth, null);
  } else if (key) set(savedAuth ?? 'Authorization', authorizationValue(key));
  return out;
}
