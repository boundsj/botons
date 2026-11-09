// LEGACY NAMES: the one place that knows what Botons was called before (Minions, then Tots).
//
// Everything that still reads, accepts or moves an earlier name gets it from this file, for one release after the
// rename. To drop them: delete this file and legacy-names.d.mts, delete server/src/legacy-upgrade.ts,
// scripts/migrate-names.ts, docker/legacy-names.sh and server/test/legacy-names.test.ts, then fix what the type
// checker lists. None of these names may appear in docs, help text or the app; doctor names them once, as
// deprecated. Plain JavaScript with no imports, so the server, its scripts, the web app and the installer (which
// may run on an older Node) can all load it.

/** The earlier names as words in text, in any case (check:firstrun looks for them on every screen). */
export const OLD_TEXT = /\b(minions?|tots?)\b/i;

/** Earlier setting prefixes and their current ones, newest first: where two are set, the newer one wins. */
export const ENV_PREFIXES = Object.freeze([
  ['TOTS_', 'BOTONS_'],
  ['TOT_', 'BOTON_'],
  ['MINIONS_', 'BOTONS_'],
  ['MINION_', 'BOTON_'],
]);

/** The current name of an earlier setting name, or null when `name` is not one. */
export function currentEnvName(name) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
  for (const [old, now] of ENV_PREFIXES) if (name.startsWith(old) && name.length > old.length) return now + name.slice(old.length);
  return null;
}

/** The earlier names of a current setting name, newest first (none when it has no earlier names). */
export function earlierEnvNames(name) {
  const out = [];
  for (const [old, now] of ENV_PREFIXES) if (name.startsWith(now) && name.length > now.length) out.push(old + name.slice(now.length));
  return out;
}

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const rank = (name) => ENV_PREFIXES.findIndex(([old]) => name.startsWith(old));

/**
 * Reads each earlier setting name as its current one, in place: where the current name is unset, it gets the
 * newest earlier name's value. Earlier names are left as they are. Idempotent. One notice per earlier name that is
 * set: `conflict` when its value differs from the one used. Notices name variables, never values.
 */
export function applyLegacyEnv(env) {
  const notices = [];
  const olds = Object.keys(env)
    .filter((k) => currentEnvName(k) && isSet(env[k]))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  for (const old of olds) {
    const name = currentEnvName(old);
    if (!isSet(env[name])) {
      env[name] = env[old];
      notices.push({ old, name, conflict: false });
    } else notices.push({ old, name, conflict: String(env[name]).trim() !== String(env[old]).trim() });
  }
  return notices;
}

/** Doctor's one line about a notice: names only. */
export function legacyEnvNoticeText(n) {
  return n.conflict
    ? `${n.old} (deprecated) and ${n.name} are both set, to different values: ${n.name} is used. Remove ${n.old}.`
    : `${n.old} is deprecated and works for this release only: rename it to ${n.name}.`;
}

/** True for an earlier setting name. */
export const isLegacySetting = (name) => currentEnvName(name) !== null;

/**
 * A turn's variables under their earlier names too (BOTON_TOKEN also as the two earlier names), for one release,
 * so an agent's own scripts and saved procedures keep working. The values are the same, so nothing more is exposed.
 */
export function withLegacyTurnNames(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) for (const old of earlierEnvNames(k)) if (out[old] === undefined) out[old] = v;
  return out;
}

/**
 * An env file's text with each earlier setting name written as its current one, and each path in `moves`
 * ([from, to]) as its new path. Where a setting is set under more than one name, only the line the server would use
 * stays (the current name, else the newest earlier one), so the file means what it meant.
 */
export function rewriteEnvText(text, moves = []) {
  const lines = text.split('\n');
  const parse = (line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  const valueOf = (raw) => (/^"(.*)"$/.test(raw) || /^'(.*)'$/.test(raw) ? raw.slice(1, -1) : raw);
  // The line whose value the server uses for each setting: the current name's, else the newest earlier name's, and
  // an empty value counts as unset (as applyLegacyEnv reads them). The last of the same name wins, as in a shell.
  // A name assigned twice means its last assignment (an empty one too): only that line counts.
  const last = new Map();
  lines.forEach((line, i) => {
    const m = parse(line);
    if (m) last.set(m[1], i);
  });
  const winner = new Map();
  lines.forEach((line, i) => {
    const m = parse(line);
    if (!m || last.get(m[1]) !== i) return;
    const now = currentEnvName(m[1]) ?? m[1];
    const r = currentEnvName(m[1]) ? rank(m[1]) : -1;
    const set = isSet(valueOf(m[2]));
    const best = winner.get(now);
    const better = !best || (set && !best.set) || (set === best.set && (r < best.r || (r === best.r && i > best.i)));
    if (better) winner.set(now, { i, r, set, legacy: (best?.legacy ?? false) || r >= 0 });
    else best.legacy ||= r >= 0;
  });
  for (const [name] of last) if (currentEnvName(name)) winner.get(currentEnvName(name)).legacy = true;
  const out = [];
  lines.forEach((line, i) => {
    const m = parse(line);
    let next = line;
    if (m) {
      const now = currentEnvName(m[1]) ?? m[1];
      // Only settings with an earlier name lose lines; anything else stays as it was written.
      if (winner.get(now).legacy && winner.get(now).i !== i) return;
      if (now !== m[1]) next = line.replace(m[1], now);
      for (const [from, to] of moves) next = replacePathPrefix(next, from, to);
    }
    out.push(next);
  });
  return out.join('\n');
}

/** `text` with each whole-path occurrence of `from` (followed by /, a quote, a separator or the end) as `to`. */
function replacePathPrefix(text, from, to) {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${esc}(?=$|[/"':;\\s])`, 'g'), to);
}

/** Earlier data folders under the user's home, newest first. The current one is ~/.botons. */
export const DATA_DIRS = Object.freeze(['.tots', '.minions']);
/** Earlier settings folders under XDG_CONFIG_HOME (~/.config), each with an `env` file. */
export const CONFIG_DIRS = Object.freeze(['tots', 'minions']);
/** Earlier release roots under ~/.local/share (deploy's and the installer's). */
export const SHARE_DIRS = Object.freeze(['tots', 'minions']);
/** The database's earlier file name. */
export const DB_FILE = 'minions.db';
/** Earlier systemd user units: the server's, and its nightly backup's (a .service and a .timer). */
export const UNITS = Object.freeze([
  { service: 'tots', backup: 'tots-backup' },
  { service: 'minions', backup: 'minions-backup' },
]);
/** Earlier names of the Botons command (the agents' CLI and the installer's admin command). */
export const CLI_NAMES = Object.freeze(['tots', 'minion']);
/** Earlier names in the marked PATH block the installer adds to a shell's rc file. */
export const PATH_BLOCK_NAMES = Object.freeze(['tots']);
/** Earlier names of check:public's private terms list in ~/.config/private-terms (outside the repo). */
export const PRIVATE_TERMS_FILES = Object.freeze(['minions.txt']);
/** Earlier names of the image's admin command (docker/botons); the Dockerfile links each to it. */
export const IMAGE_CLI_NAMES = Object.freeze(['tots', 'minions']);

/**
 * Earlier names of what the server stores, sends and reads back, by their current name: an actor's kind (audit
 * events, reactions, turn tokens), the managed browser's connector, export file formats, webhook and callback
 * headers. Data under them is moved by the schema upgrade, read on import, accepted or sent beside the current one.
 */
export const RENAMED = Object.freeze({
  boton: 'minion',
  botons_browser: 'minions_browser',
  'botons-config': 'minions-config',
  'botons-sidebar': 'minions-sidebar',
  'botons-reactions': 'minions-reactions',
  'x-boton-key': 'x-minion-key',
  'x-boton-signature': 'x-minion-signature',
  'x-boton-run': 'x-minion-run',
});
/** The earlier name of a renamed value, or null. */
export const earlierName = (now) => (Object.hasOwn(RENAMED, now) ? RENAMED[now] : null);
/** The current name of a value, if it is an earlier one; otherwise the value itself. */
export function currentName(value) {
  for (const [now, old] of Object.entries(RENAMED)) if (value === old) return now;
  return value;
}

/** Earlier keys of the web app's own storage on a device, by current key (or key prefix, ending in "."). */
const STORAGE = Object.freeze({
  'botons.deviceToken': 'minions.deviceToken',
  'botons.avatarMotion': 'minions.avatarMotion',
  'botons.webAccessSuggestion.': 'tots.webAccessSuggestion.',
  'botons.theme': 'tots.theme',
});
/** A storage key's earlier name, or null (for web/index.html's first paint, which runs before any module loads). */
export const earlierStorageKey = (key) => (Object.hasOwn(STORAGE, key) ? STORAGE[key] : null);
/**
 * `key`'s value in `storage`, taken over from its earlier key the first time (written under `key`, the earlier one
 * removed), so a device stays paired and keeps its choices. Null when neither is set.
 */
export function storedValue(storage, key) {
  const now = storage.getItem(key);
  if (now !== null) return now;
  const entry = Object.entries(STORAGE).find(([k]) => k === key || (k.endsWith('.') && key.startsWith(k)));
  if (!entry) return null;
  const old = entry[0] === key ? entry[1] : entry[1] + key.slice(entry[0].length);
  const value = storage.getItem(old);
  if (value === null) return null;
  try {
    storage.setItem(key, value);
    storage.removeItem(old);
  } catch {}
  return value;
}

/**
 * A configuration export made under an earlier name, with the names this server reads: its format, its Botons'
 * list and the primary Boton's setting, its sidebar's format, a skill's author kind and the managed browser's
 * connector id. Anything
 * else is left as it is; a file under the current names comes back unchanged.
 */
export function currentPortable(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file) || file.format !== RENAMED['botons-config']) return file;
  const browser = `lib:${RENAMED.botons_browser}`;
  const out = { ...file, format: 'botons-config' };
  // An owner's own connector already named as the browser is now takes a free name first, with every grant of it.
  const map = new Map([[browser, 'lib:botons_browser']]);
  const connectors = Array.isArray(out.connectors) ? out.connectors : [];
  if (connectors.some((c) => c && (c.id === 'lib:botons_browser' || c.name === 'botons_browser'))) {
    const used = new Set(connectors.map((c) => c && c.name));
    let n = 2;
    while (used.has(`botons_browser_${n}`)) n++;
    map.set('lib:botons_browser', `lib:botons_browser_${n}`);
    out.connectors = connectors.map((c) => (c && (c.id === 'lib:botons_browser' || c.name === 'botons_browser') ? { ...c, id: `lib:botons_browser_${n}`, name: `botons_browser_${n}` } : c));
  }
  const ids = (v) => (Array.isArray(v) ? v.map((x) => map.get(x) ?? x) : v);
  if (Array.isArray(out.connectors)) out.connectors = out.connectors.map((c) => (c && c.id === browser ? { ...c, id: 'lib:botons_browser', name: 'botons_browser' } : c));
  if ('minions' in out) {
    out.botons = Array.isArray(out.minions) ? out.minions.map((m) => (m && typeof m === 'object' && !Array.isArray(m) ? { ...m, connections: ids(m.connections) } : m)) : out.minions;
    delete out.minions;
  }
  if (out.settings && typeof out.settings === 'object' && !Array.isArray(out.settings) && 'primaryMinion' in out.settings) {
    const { primaryMinion, ...settings } = out.settings;
    out.settings = { ...settings, primaryBoton: primaryMinion };
  }
  if (out.sidebar && typeof out.sidebar === 'object' && out.sidebar.format === RENAMED['botons-sidebar']) out.sidebar = { ...out.sidebar, format: 'botons-sidebar' };
  if (Array.isArray(out.skills)) {
    out.skills = out.skills.map((k) => (k && typeof k === 'object' && k.author && typeof k.author === 'object' && k.author.kind === RENAMED.boton ? { ...k, author: { ...k.author, kind: 'boton' } } : k));
  }
  if (Array.isArray(out.templates)) out.templates = out.templates.map((t) => (t && typeof t === 'object' && t.bot && typeof t.bot === 'object' ? { ...t, bot: { ...t.bot, connections: ids(t.bot.connections) } } : t));
  return out;
}

/** The earlier names themselves, as words: check:public refuses them anywhere this module doesn't allow (oldNames). */
export const OLD_WORD = /^(minions?|tots?)$/i;
/** The changelog's one line that says what the product was called before. */
export const FORMERLY = /\(formerly Minions, and then Tots\)/;
