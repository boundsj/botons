import { createHash } from 'node:crypto';
import { currentPortable } from '../../shared/legacy-names.mjs';
import type {
  AccessLevel,
  Bot,
  ConnectorGrant,
  PortableConfig,
  PortableConnector,
  PortableCapsChoice,
  PortableConnectorAction,
  PortableExport,
  PortableImportChoices,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  PortableBoton,
  PortableBotonAction,
  PortableBotonPlan,
  PortableReconnect,
  PortableRoutine,
  PortableSettings,
  PortableSidebarMode,
  PortableSkill,
  PortableSkillAction,
  PortableTemplate,
  PortableTemplateAction,
  SidebarTransfer,
  BotonLook,
  TemplateRoutine,
  SkillAuthor,
  SkillSource,
} from '../../shared/types.ts';
import { effortProblem } from '../../shared/effort.ts';
import { lookFromTater, parseLook } from '../../shared/look.ts';
import { parseCritter } from '../../shared/look-critter.ts';
import { parseTater, taterFromCritter } from '../../shared/look-tater.ts';
import { tokenShapedName } from '../../shared/services.ts';
import { BROWSER_CONNECTOR, BROWSER_SERVER, isPastOneOff, isValidTimezone } from '../../shared/util.ts';
import { askFirstList } from './ask-rules.ts';
import type { Browser } from './browser.ts';
import { effectiveSites } from './browser-policy.ts';
import type { Config } from './config.ts';
import { type Connectors, countedConnections, MAX_CONNECTIONS } from './connectors.ts';
import { log } from './log.ts';
import type { OAuthConnections } from './oauth-connections.ts';
import { refusedOutbound } from './outbound.ts';
import type { ProviderRegistry } from './providers/index.ts';
import { describeSchedule, parseSchedule, toSpec } from './schedule.ts';
import { redactTokenShaped } from './secrets.ts';
import { anthropicWire, openaiWire } from './providers/api-wire.ts';
import { rateFor, round } from './rates.ts';
import { asksOf } from './skill-packages.ts';
import { SKILL_HISTORY_KEEP, SKILL_NAME, type Skills, skillVersion } from './skills.ts';
import { MAX_CAP_USD, type Spending } from './spend.ts';
import { alwaysAllowList, followUpsInput, HttpError, ntfyOrigin, inheritedEffortProblem, MAX_ROUTINES_PER_BOT, type Store, sidebarTransfer } from './store.ts';
import { readRoutine, type StoredTemplate, type Templates, templateRoutine } from './templates.ts';
import { nowIso } from './util.ts';

/*
 * The owner's configuration as a file of its own (PortableConfig in shared/types.ts), to move to another server or
 * rebuild one without a backup: Botons with their routines, rules and browser sites, skills with their history,
 * connectors without their secrets, settings and the sidebar. A full backup (npm run backup) is what holds the rest:
 * chats, memories, workspaces, tokens, sign-ins and secrets; this file never does.
 *
 * What is left out is decided by an allowlist: export() builds each part field by field from what is listed below,
 * never by copying a row and deleting secrets from it. Structured places a credential lives (a connector's env and
 * headers, a URL's query, an argument that looks like one) keep only their names, or a placeholder. Text the owner
 * wrote (instructions, skills) is copied as written: it is checked for credential shapes and named in the export's
 * warnings, which is a help, not a guarantee.
 *
 * Importing reads the file as data only: nothing in it is run, fetched or followed, and no file is opened. Every
 * field is checked against what this version of the format has (unknown or missing ones refuse the file), then
 * preview() works out exactly what would be made, and import() makes it only if that is still what preview() showed
 * (its fingerprint), all in one transaction. It widens nothing silently: Full computer access and Always allow
 * rules come only when the owner ticks them, routines arrive off, webhooks get new keys, connectors arrive off (with
 * a fresh request-policy generation) and OAuth ones signed out, and the managed browser stays the server's own.
 * Spending caps go with their Boton and routines (never what was spent): a Boton made by an import is new here, so
 * it gets the file's caps (or none, if the owner chooses) and an account of its own from $0; no Boton already here has
 * its caps or account touched.
 */

export const PORTABLE_FORMAT = 'botons-config';
/** This server writes and reads this version; older ones are upgraded by UPGRADES first. */
export const PORTABLE_VERSION = 5;
/** The import routes' body limit: the file and the choices. */
export const PORTABLE_MAX_BYTES = 16 * 1024 * 1024;
/**
 * How this server turns a file into a plan, in the preview's fingerprint: a preview made by a server that planned
 * differently (another release, mid-upgrade) is refused at import and shown again, never applied as it now reads.
 */
const PLAN_REVISION = 'plan-6';

/**
 * Each entry turns a file of version n into version n + 1, as data (never code from the file). A version this
 * server doesn't know, older or newer, is refused. Each of server/test/fixtures/portable-config-{1,2,3}.json must keep importing.
 * (A file at the current version is what export writes; the tests make one.)
 */
const rec = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

/** A file's Botons and templates with each look (a template's may be null) turned by `to`. */
function eachLook(f: Record<string, unknown>, to: (v: unknown, where: string) => unknown): { botons: unknown; templates: unknown } {
  const botons = Array.isArray(f.botons) ? f.botons.map((m, i) => (rec(m) && 'look' in rec(m)! ? { ...rec(m), look: to(rec(m)!.look, `botons[${i}].look`) } : m)) : f.botons;
  const templates = Array.isArray(f.templates)
    ? f.templates.map((t, i) => {
        const bot = rec(rec(t)?.bot);
        return bot && bot.look !== null && bot.look !== undefined ? { ...rec(t), bot: { ...bot, look: to(bot.look, `templates[${i}].bot.look`) } } : t;
      })
    : f.templates;
  return { botons, templates };
}

const UPGRADES: Record<number, (file: Record<string, unknown>) => Record<string, unknown>> = {
  // Version 2 added saved templates and the reactions that start a follow-up. A version-1 file has neither: no
  // templates, and a reaction setting of null, which keeps the importing server's own (never a default in its place).
  1: (f) => {
    if ('templates' in f) bad('file.templates', 'is not a field of version 1');
    const settings = f.settings && typeof f.settings === 'object' && !Array.isArray(f.settings) ? (f.settings as Record<string, unknown>) : null;
    if (settings && 'reactionFollowUps' in settings) bad('settings.reactionFollowUps', 'is not a field of version 1');
    return { ...f, version: 2, templates: [], settings: settings ? { ...settings, reactionFollowUps: null } : f.settings };
  },
  // Version 3 added spending caps: a Boton's a day and a routine's a run. A version-2 file has none, so its Botons
  // arrive with none, as a Boton the owner adds by hand does (the preview says the file had no caps to carry).
  2: (f) => {
    if (!Array.isArray(f.botons)) return { ...f, version: 3 };
    const botons = f.botons.map((m, i) => {
      const o = rec(m);
      if (!o) return m;
      if ('dailyCapUsd' in o) bad(`botons[${i}].dailyCapUsd`, 'is not a field of version 2');
      const routines = Array.isArray(o.routines)
        ? o.routines.map((r, j) => {
            const ro = rec(r);
            if (!ro) return r;
            if ('perRunCapUsd' in ro) bad(`botons[${i}].routines[${j}].perRunCapUsd`, 'is not a field of version 2');
            return { ...ro, perRunCapUsd: null };
          })
        : o.routines;
      return { ...o, dailyCapUsd: null, routines };
    });
    return { ...f, version: 3, botons };
  },
  // Version 4 holds tater looks. A version-3 look is a Critter, and it becomes its closest tater look
  // (taterFromCritter); one that isn't a Critter refuses the file, as it did at version 3.
  3: (f) => {
    const tater = (v: unknown, where: string) => {
      const critter = parseCritter(obj(v, where, CRITTER_KEYS));
      return critter ? taterFromCritter(critter) : bad(where, 'is not a look this server draws');
    };
    return { ...f, version: 4, ...eachLook(f, tater) };
  },
  // Version 5 draws Botons. A version-4 look is a tater look, and it becomes its closest Boton (lookFromTater); one
  // that isn't a tater look refuses the file, as it did at version 4.
  4: (f) => {
    const Boton = (v: unknown, where: string) => {
      const tater = parseTater(obj(v, where, TATER_KEYS));
      return tater ? lookFromTater(tater) : bad(where, 'is not a look this server draws');
    };
    return { ...f, version: 5, ...eachLook(f, Boton) };
  },
};

const MAX_BOTONS = 500;
const MAX_SKILLS = 1000;
const MAX_LIBRARY = 200;
const MAX_OAUTH = 20;
const MAX_SITES = 200;
const MAX_TEMPLATES = 200;
const MAX_DEPTH = 16;
const MAX_NODES = 500_000;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const CONNECTOR_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const HASH = /^[0-9a-f]{32}$/;
const FIELD_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
/** Keys no object in the file may have, at any depth. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Stands in the file where a credential was. */
export const LEFT_OUT = '<left out by the export>';

/** Never in the file, whatever is in the database. */
const NEVER_EXPORTED = [
  'chats, memories and workspace files',
  "connectors' env and header values, and URL queries",
  'OAuth sign-ins, tokens and client registrations',
  'webhook keys, signing secrets and callback URLs',
  'the ntfy token and API keys',
  'paired devices, pairing requests and Boton tokens',
  'browser profiles, cookies and journals',
  'provider sessions, approvals and the audit log',
  'what API-key turns have spent (the account the spending caps count): it stays in full backups',
];

/** The model an API key brain's turn runs on, and whether Botons knows its price; null for another brain. */
function apiPriceKnown(provider: string, model: string): boolean | null {
  if (provider === 'anthropic-api') return rateFor('anthropic', model || anthropicWire.defaultModel) !== null;
  if (provider === 'openai-api') return rateFor('openai', model || openaiWire.defaultModel) !== null;
  return null;
}
const usd = (v: number | null) => (v === null ? 'none' : `$${v}`);

/** Shapes of credentials in text: token-shaped runs (as secrets.ts sees them) and well-known key prefixes. */
const KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_\w{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|tk_[A-Za-z0-9]{8,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/;
export const credentialShaped = (text: string): boolean => KEY_PREFIX.test(text) || redactTokenShaped(text) !== text;

// ------------------------------------------------------- credentials in structured places
// A connector's command line is structured enough to read: flags and their values, NAME=value assignments, header
// lines, URLs. cleanArgs() reads it that way, so a short or plain credential named as one is left out however it is
// written (`--password -x`, `API_KEY=a`, `--token=a`, `Authorization: Bearer a`, a URL's user, password or query),
// and token-shaped runs are left out wherever they are. It leaves out more than it must rather than less; what it
// left out is named, so the owner can put it back. Prose (instructions, skills) can't be read this way: it is only
// checked, and named in the warnings.

/** Words that make a name (a flag, an env var, a header, a query parameter) the name of a credential, in any case. */
const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'passphrase', 'pass', 'pwd', 'auth', 'authorization', 'credential', 'credentials', 'apikey', 'key', 'cookie', 'session', 'bearer', 'pat', 'jwt', 'signature', 'sig']);
const SECRET_JOINED = /apikey|accesskey|secretkey|privatekey|authtoken|accesstoken|refreshtoken|clientsecret|sessionid/;

/** Whether `name` names a credential: by its words (split at -, _, ., spaces and camelCase), in any case. */
export function secretName(name: string): boolean {
  const words = name
    .replace(/^-+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w)) || SECRET_JOINED.test(words.join(''));
}

/** A word that says the next one is a credential: an HTTP auth scheme. */
const AUTH_SCHEME = /^(?:bearer|basic|token|digest)$/i;
/** Where LEFT_OUT already stands, as one word while text is split into words. */
const HELD = '\u0000left-out\u0000';

/**
 * A URL without its user name and password, query and #fragment (`strict`), or without its user name, password and
 * the query parameters named as credentials; and without its path when that holds something token-shaped. `why`
 * says what went.
 */
function cleanUrl(text: string, strict: boolean): { url: string; why: string | null } {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return /[@?#]/.test(text) ? { url: LEFT_OUT, why: 'it looked like a URL with a credential in it' } : { url: text, why: null };
  }
  const gone: string[] = [];
  if (u.username || u.password) {
    gone.push('its user name and password');
    u.username = '';
    u.password = '';
  }
  const params = [...new Set([...u.searchParams.keys()])];
  const dropped = strict ? params : params.filter(secretName);
  if (dropped.length || (strict && u.search)) {
    gone.push(`its query${dropped.length ? ` (${dropped.join(', ')})` : ''}`);
    if (strict) u.search = '';
    else for (const k of dropped) u.searchParams.delete(k);
  }
  if (strict && u.hash) {
    gone.push('its #fragment');
    u.hash = '';
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray % stays as written.
  }
  if (credentialShaped(path)) {
    gone.push('its path');
    u.pathname = '/';
  }
  return gone.length ? { url: u.toString(), why: gone.join(', ') } : { url: text, why: null };
}

/** One word of a command line (an argument, or a word of one), with what is a credential replaced by LEFT_OUT. */
function cleanWord(w: string, prev: string | undefined): { word: string; why: string | null } {
  if (w === HELD) return { word: w, why: null };
  if (prev !== undefined && prev !== HELD) {
    if (/^-/.test(prev) && !prev.includes('=') && secretName(prev)) return { word: HELD, why: `the value of ${prev}` };
    if (AUTH_SCHEME.test(prev)) return { word: HELD, why: `the credential after ${prev}` };
    if (/^[A-Za-z][\w-]*:$/.test(prev) && secretName(prev.slice(0, -1))) return { word: HELD, why: `the value of ${prev.slice(0, -1)}` };
  }
  // NAME=value, --name=value: the value of a credential's name goes; any other value is read as a word itself.
  const eq = /^(-{0,2}[A-Za-z_][\w.-]*)=([\s\S]*)$/.exec(w);
  if (eq) {
    if (secretName(eq[1])) return { word: `${eq[1]}=${HELD}`, why: `the value of ${eq[1]}` };
    const v = cleanWord(eq[2], undefined);
    return { word: `${eq[1]}=${v.word}`, why: v.why };
  }
  // Name:value, as a header can be written.
  const colon = /^([A-Za-z][\w-]*):(?!\/\/)(.+)$/.exec(w);
  if (colon && secretName(colon[1])) return { word: `${colon[1]}:${HELD}`, why: `the value of ${colon[1]}` };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) {
    const u = cleanUrl(w, true);
    return { word: u.url === LEFT_OUT ? HELD : u.url, why: u.why && `a URL's ${u.why.replace(/its /g, '')}` };
  }
  if (credentialShaped(w)) return { word: HELD, why: 'it looked like a credential' };
  return { word: w, why: null };
}

/** Where a word says the next one is a credential (a credential's flag, `Name:`, an auth scheme): how to name it. */
function namesNext(word: string): string | null {
  if (word === HELD) return null;
  if (/^-/.test(word) && !word.includes('=') && secretName(word)) return `the value of ${word}`;
  if (AUTH_SCHEME.test(word)) return `the credential after ${word}`;
  if (/^[A-Za-z][\w-]*:$/.test(word) && secretName(word.slice(0, -1))) return `the value of ${word.slice(0, -1)}`;
  return null;
}

/** What makes an argument more than one plain word: space, a quote or a backslash. */
const NOT_BARE = /[\s'"`\\]/;

/**
 * `text` split into words as a POSIX shell reads them (single and double quotes, backslashes), or null where that
 * can't be done exactly: an unclosed quote, a trailing backslash, or a substitution (`…`, $(…), ${…}) whose words
 * only running it would tell. Nothing is expanded or run.
 */
export function shellWords(text: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  const substitution = (i: number) => text[i] === '`' || (text[i] === '$' && (text[i + 1] === '(' || text[i + 1] === '{'));
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      for (i++; ; ) {
        if (i >= text.length) return null;
        if (text[i] === '"') {
          i++;
          break;
        }
        if (substitution(i)) return null;
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
          cur += text[i + 1];
          i += 2;
        } else cur += text[i++];
      }
    } else if (ch === '\\') {
      if (i + 1 >= text.length) return null;
      cur += text[i + 1];
      i += 2;
    } else if (substitution(i)) return null;
    else {
      cur += ch;
      i++;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** A name, then : or = and a value, as JSON, YAML, a header or an assignment writes it (quoted or not). */
const KEYED = /([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^\s"',;}\]]+)/g;

/** The first name of a credential that `text` gives a value to in any such form, or null. */
function keyedCredential(text: string): string | null {
  for (const m of text.matchAll(KEYED)) if (secretName(m[1]) && m[2] !== HELD && !m[2].startsWith('//')) return m[1];
  return null;
}

/** Arguments inside arguments (an `sh -c` line quoting another) are read this many levels deep, then left out. */
const MAX_NESTING = 4;

/**
 * One argument (HELD where LEFT_OUT stood) with its credentials replaced. `after` names what it is when the
 * argument before it said it is a credential: then all of it goes. A header line or NAME=value naming a credential
 * loses its whole value, however many words; a plain word is read as cleanWord reads it; anything else is shell text,
 * read word by word with shellWords(), and goes whole if any word of it is a credential or it can't be read exactly
 * (a credential is never cut out of text whose quoting would have to be guessed).
 */
function cleanArg(a: string, after: string | null, depth = 0): { text: string; why: string[] } {
  if (a === HELD) return { text: a, why: [] };
  if (after) return { text: HELD, why: [after] };
  const header = /^([A-Za-z][\w-]*):(?!\/\/)(\s*)([\s\S]+)$/.exec(a);
  if (header && secretName(header[1])) return header[3] === HELD ? { text: a, why: [] } : { text: `${header[1]}:${header[2]}${HELD}`, why: [`the value of ${header[1]}`] };
  const eq = /^(-{0,2}[A-Za-z_][\w.-]*)=([\s\S]*)$/.exec(a);
  if (eq) {
    if (!eq[2] || eq[2] === HELD) return { text: a, why: [] };
    if (secretName(eq[1])) return { text: `${eq[1]}=${HELD}`, why: [`the value of ${eq[1]}`] };
    const v = cleanArg(eq[2], null, depth + 1);
    return { text: `${eq[1]}=${v.text}`, why: v.why };
  }
  if (/^[{[]/.test(a.trim())) {
    try {
      const inspect = (value: unknown, level = 0): string | null => {
        if (level > 64) throw new Error('JSON nesting exceeds the review bound');
        if (typeof value === 'string') {
          const word = cleanWord(value, undefined);
          return word.why ?? keyedCredential(value);
        }
        if (!value || typeof value !== 'object') return null;
        for (const [key, item] of Object.entries(value)) {
          if (secretName(key) && item !== null && item !== '' && item !== HELD && item !== LEFT_OUT) return 'a credential field';
          const found = inspect(item, level + 1);
          if (found) return found;
        }
        return null;
      };
      const parsed = JSON.parse(a);
      // JSON.parse keeps only the last duplicate. Inspect the decoded names in the source too, so no discarded
      // property can hide a credential in the argument that would be exported unchanged.
      const tokens = a.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:]/g) ?? [];
      const objects: (Set<string> | null)[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '{') objects.push(new Set());
        else if (token === '[') objects.push(null);
        else if (token === '}' || token === ']') objects.pop();
        else if (token.startsWith('"') && tokens[i + 1] === ':') {
          const names = objects.at(-1);
          const name = JSON.parse(token) as string;
          if (names?.has(name)) return { text: HELD, why: ['duplicate decoded JSON fields, so all of it'] };
          names?.add(name);
        }
      }
      const found = inspect(parsed);
      return found ? { text: HELD, why: ['a credential in JSON, so all of it'] } : { text: a, why: [] };
    } catch {
      return { text: HELD, why: ["JSON this export can't read safely, so all of it"] };
    }
  }
  if (!NOT_BARE.test(a)) {
    const w = cleanWord(a, undefined);
    if (w.why) return { text: w.word, why: [w.why] };
    const named = keyedCredential(w.word);
    return named ? { text: HELD, why: [`the value of ${named}, in structured text`] } : { text: w.word, why: [] };
  }
  if (depth >= MAX_NESTING) return { text: HELD, why: ['arguments nested too deep to read'] };
  const words = shellWords(a);
  if (!words) return { text: HELD, why: ["shell text this export can't read exactly, so all of it"] };
  const why: string[] = [];
  let next: string | null = null;
  for (const w of words) {
    why.push(...cleanArg(w, next, depth + 1).why);
    next = namesNext(w);
  }
  const named = why.length ? null : keyedCredential(a);
  if (named) why.push(`the value of ${named}, in structured text`);
  if (!why.length) return { text: a, why: [] };
  const each = [...new Set(why.map((x) => x.replace(/, in quoted text: all of it$/, '')))];
  return { text: HELD, why: [`${each.join('; ')}, in quoted text: all of it`] };
}

/** The word an argument ends with, as the next argument's `after` reads it. */
const lastWord = (a: string): string => (NOT_BARE.test(a) ? (shellWords(a)?.at(-1) ?? '') : a);

const held = (text: string) => text.split(LEFT_OUT).join(HELD);
const shown = (text: string) => text.split(HELD).join(LEFT_OUT);

/** A command (one argument) with its credentials replaced, as cleanArgs() reads an argument. */
export function cleanCommand(command: string): { text: string; why: string[] } {
  const c = cleanArg(held(command), null);
  return { text: shown(c.text), why: c.why };
}

/** A connector's arguments with every credential in them replaced by LEFT_OUT, and where each was. Each argument stays one. */
export function cleanArgs(args: string[]): { args: string[]; leftOut: string[] } {
  const leftOut: string[] = [];
  const out = args.map((a, i) => {
    // An argument after a credential's flag is its value, all of it, whatever it looks like (`--password -x` too).
    const c = cleanArg(held(a), i > 0 ? namesNext(lastWord(held(args[i - 1]))) : null);
    if (c.why.length) leftOut.push(`args[${i}] (${[...new Set(c.why)].join('; ')})`);
    return shown(c.text);
  });
  return { args: out, leftOut };
}

/** Whether prose holds something that is a credential as written: token-shaped, NAME=value, a flag's value, a URL's user or secret query. */
export function proseHasCredential(text: string): boolean {
  if (!text) return false;
  if (credentialShaped(text)) return true;
  let prev: string | undefined;
  for (const w of text.split(/\s+/)) {
    if (!w) continue;
    const bare = w.replace(/^[("'`<\[]+|[)"'`>\].,;!?]+$/g, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare)) {
      if (cleanUrl(bare, false).why) return true;
    } else if (/=/.test(bare) || prev !== undefined) {
      const c = cleanWord(bare, prev);
      // In prose, only a NAME=value with a value, or a flag's value, counts.
      if (c.why && c.why !== 'it looked like a credential' && !/=$/.test(bare)) return true;
    }
    prev = /^-{1,2}[A-Za-z]/.test(bare) ? bare : undefined;
  }
  return false;
}

const bad = (where: string, why: string): never => {
  throw new HttpError(400, `Not a configuration this server can import: ${where} ${why}`);
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ------------------------------------------------------------------ reading

type J = Record<string, unknown>;

/** No forbidden key, no deeper than MAX_DEPTH, no more than MAX_NODES values: before anything else reads it. */
function scan(v: unknown): void {
  let nodes = 0;
  const visit = (x: unknown, depth: number, where: string) => {
    if (++nodes > MAX_NODES) bad('the file', `has more than ${MAX_NODES} values`);
    if (depth > MAX_DEPTH) bad(where, `is nested more than ${MAX_DEPTH} deep`);
    // Every text in the file is whole Unicode, keys and list entries too: a lone surrogate would be stored as U+FFFD.
    if (typeof x === 'string' && !x.isWellFormed()) bad(where, 'holds a broken character (a lone surrogate)');
    if (Array.isArray(x)) x.forEach((y, i) => visit(y, depth + 1, `${where}[${i}]`));
    else if (x !== null && typeof x === 'object') {
      if (Object.getPrototypeOf(x) !== Object.prototype) bad(where, 'is not a plain object');
      for (const k of Object.keys(x)) {
        if (FORBIDDEN_KEYS.has(k)) bad(where, `has a key named ${k}`);
        if (!k.isWellFormed()) bad(where, 'has a key with a broken character (a lone surrogate)');
        visit((x as J)[k], depth + 1, `${where}.${k}`);
      }
    }
  };
  visit(v, 0, 'file');
}

/** An object with exactly `keys` (the format's fields at this version): unknown and missing fields refuse the file. */
function obj(v: unknown, where: string, keys: readonly string[]): J {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(where, 'must be an object');
  for (const k of Object.keys(v)) if (!keys.includes(k)) bad(`${where}.${k}`, 'is not a field of this format version (was the file made by a newer Botons?)');
  for (const k of keys) if (!(k in v)) bad(`${where}.${k}`, 'is missing');
  return v as J;
}

function str(v: unknown, where: string, max: number, opts: { min?: number; re?: RegExp; oneLine?: boolean } = {}): string {
  if (typeof v !== 'string') return bad(where, 'must be a string');
  if (v.length > max) bad(where, `is longer than ${max} characters`);
  if (v.length < (opts.min ?? 0)) bad(where, opts.min === 1 ? 'is empty' : `is shorter than ${opts.min} characters`);
  if (v.includes('\0')) bad(where, 'holds a NUL character');
  if (!v.isWellFormed()) bad(where, 'holds a broken character (a lone surrogate)');
  if (opts.oneLine && /[\r\n]/.test(v)) bad(where, 'must be one line');
  if (opts.re && !opts.re.test(v)) bad(where, 'is not of the expected form');
  return v;
}

/** Trimmed as the server keeps it: a value with space around it was not written by an export. */
function text(v: unknown, where: string, max: number, required = false): string {
  const s = str(v, where, max, { min: required ? 1 : 0 });
  if (s !== s.trim()) bad(where, 'has space at its start or end');
  return s;
}

/** A spending cap in US dollars as spend.ts keeps them (0 to MAX_CAP_USD, to its rounding), or null for none. */
function capUsd(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_CAP_USD || round(v) !== v) return bad(where, `must be a number of US dollars from 0 to ${MAX_CAP_USD}, or null for no cap`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') bad(where, 'must be true or false');
  return v as boolean;
}

function list<T>(v: unknown, where: string, max: number, item: (x: unknown, where: string) => T): T[] {
  if (!Array.isArray(v)) return bad(where, 'must be a list');
  if (v.length > max) bad(where, `has more than ${max} entries`);
  return v.map((x, i) => item(x, `${where}[${i}]`));
}

function unique(values: string[], where: string): void {
  if (new Set(values).size !== values.length) bad(where, 'has an entry twice');
}

/** A server's checker, its 400 as the file's. */
function checked<T>(where: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    return bad(where, (err as Error).message);
  }
}

function plainUrl(v: unknown, where: string, opts: { empty?: boolean } = {}): string {
  const s = str(v, where, 2000, { oneLine: true });
  if (!s && opts.empty) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad(where, 'is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(where, 'must be http:// or https://');
  if (u.username || u.password) bad(where, 'holds credentials');
  if (u.hash) bad(where, 'has a #fragment');
  return s;
}

/** A relative path a package listed: never read, never written, only shown. */
function listedPath(v: unknown, where: string): string {
  const s = str(v, where, 500, { min: 1 });
  if (/[\u0000-\u001f\u007f\\]/.test(s) || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((p) => p === '..' || p === '.')) bad(where, 'is not a path inside a package');
  return s;
}

function source(v: unknown, where: string): SkillSource | null {
  if (v === null) return null;
  const o = obj(v, where, ['kind', 'folder', 'label', 'installed', 'installedAt', 'fields', 'files', 'reviewed']);
  if (o.kind !== 'folder') bad(`${where}.kind`, 'must be "folder"');
  const fields = obj(o.fields, `${where}.fields`, Object.keys((o.fields as J) ?? {}));
  if (Object.keys(fields).length > 50) bad(`${where}.fields`, 'has more than 50 fields');
  for (const [k, x] of Object.entries(fields)) {
    if (!FIELD_KEY.test(k)) bad(`${where}.fields`, `has a field named "${k.slice(0, 64)}"`);
    str(x, `${where}.fields.${k}`, 1000);
  }
  return {
    kind: 'folder',
    // A skill package's folder is one name in the packages folder: no path, so it can't point anywhere else.
    folder: str(o.folder, `${where}.folder`, 64, { re: SKILL_NAME }),
    label: o.label === null ? null : str(o.label, `${where}.label`, 1000),
    installed: str(o.installed, `${where}.installed`, 32, { re: HASH }),
    installedAt: str(o.installedAt, `${where}.installedAt`, 40),
    fields: fields as Record<string, string>,
    files: list(o.files, `${where}.files`, 60, listedPath),
    reviewed: str(o.reviewed, `${where}.reviewed`, 32, { re: HASH }),
  };
}

const ROUTINE_KEYS = [
  'name',
  'instruction',
  'schedule',
  'timezone',
  'webhook',
  'notify',
  'webhookWorkspace',
  'webhookSource',
  'webhookFilter',
  'skill',
  'model',
  'effort',
  'session',
  'timeLimitMs',
] as const;

/** Checked by the templates' own reader: a field it would read differently is not one an export wrote. */
type RoutineFields = Omit<TemplateRoutine, 'scheduleText'>;

function routineFields(v: unknown, where: string, zone: string, extra: readonly string[] = []): { r: RoutineFields; o: J } {
  const o = obj(v, where, [...ROUTINE_KEYS, ...extra]);
  const r = readRoutine(o);
  if (!r) return bad(where, 'is not a routine: it needs a name of at most 80 characters and an instruction');
  for (const k of Object.keys(r) as (keyof typeof r)[]) if (JSON.stringify(r[k]) !== JSON.stringify(o[k])) bad(`${where}.${k}`, 'is not a valid value');
  str(r.name, `${where}.name`, 80);
  str(r.instruction, `${where}.instruction`, 20_000);
  if (r.schedule) checked(`${where}.schedule`, () => parseSchedule(r.schedule!, r.timezone ?? zone));
  return { r, o };
}

function routine(v: unknown, where: string, botonZone: string): PortableRoutine {
  const { r, o } = routineFields(v, where, botonZone, ['enabled', 'webhookSecretLeftOut', 'callbackLeftOut', 'perRunCapUsd']);
  return {
    ...r,
    enabled: bool(o.enabled, `${where}.enabled`),
    webhookSecretLeftOut: bool(o.webhookSecretLeftOut, `${where}.webhookSecretLeftOut`),
    callbackLeftOut: bool(o.callbackLeftOut, `${where}.callbackLeftOut`),
    perRunCapUsd: capUsd(o.perRunCapUsd, `${where}.perRunCapUsd`),
  };
}

const LOOK_KEYS = ['shape', 'shell', 'glow', 'eyes', 'brows', 'mouth', 'top', 'ears', 'visor', 'panel', 'arms', 'backdrop', 'cheeks'] as const;
/** A look's fields at version 4 (a tater look), which the upgrade to 5 maps to its closest Boton. */
const TATER_KEYS = ['shape', 'toast', 'eyes', 'brows', 'mouth', 'hat', 'glasses', 'extra', 'arms', 'wear', 'backdrop', 'cheeks'] as const;
/** A look's fields at version 3 and before (a Critter), which the upgrade to 4 maps to its closest tater look. */
const CRITTER_KEYS = ['body', 'ears', 'eyes', 'mouth', 'marks', 'cheeks', 'color', 'backdrop'] as const;

/** A look with exactly its fields, each one this server draws (an unknown field refuses the file, never dropped). */
function look(v: unknown, where: string): BotonLook {
  const l = parseLook(obj(v, where, LOOK_KEYS));
  if (!l) return bad(where, 'is not a look this server draws');
  return l;
}

export function connectionIds(v: unknown, where: string): string[] {
  // The built-in browser is one more beside MAX_CONNECTIONS others (countedConnections).
  const ids = list(v, where, MAX_CONNECTIONS + 1, (x, w) => {
    const id = str(x, w, 50);
    if (id !== BROWSER_CONNECTOR && !/^(lib|oauth):[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) bad(w, 'is not a connector id');
    return id;
  });
  unique(ids, where);
  if (countedConnections(ids) > MAX_CONNECTIONS) bad(where, `has more than ${MAX_CONNECTIONS} connectors`);
  return ids;
}

function skillNames(v: unknown, where: string): string[] | null {
  if (v === null) return null;
  const names = list(v, where, MAX_SKILLS, (x, w) => str(x, w, 64, { re: SKILL_NAME }));
  unique(names, where);
  return names;
}

const TEMPLATE_BOT_KEYS = ['name', 'title', 'instructions', 'look', 'provider', 'model', 'effort', 'access', 'group', 'timezone', 'connections', 'skills'] as const;

function template(v: unknown, where: string): PortableTemplate {
  const o = obj(v, where, ['ref', 'name', 'description', 'bot', 'routines']);
  const b = obj(o.bot, `${where}.bot`, TEMPLATE_BOT_KEYS);
  if (b.access !== 'workspace' && b.access !== 'host') bad(`${where}.bot.access`, 'must be "workspace" or "host"');
  const timezone = b.timezone === null ? null : str(b.timezone, `${where}.bot.timezone`, 80);
  if (timezone !== null && !isValidTimezone(timezone)) bad(`${where}.bot.timezone`, 'is not a timezone this server knows');
  return {
    ref: str(o.ref, `${where}.ref`, 64, { re: REF }),
    name: text(o.name, `${where}.name`, 60, true),
    description: text(o.description, `${where}.description`, 300),
    bot: {
      name: text(b.name, `${where}.bot.name`, 60),
      title: text(b.title, `${where}.bot.title`, 80),
      instructions: text(b.instructions, `${where}.bot.instructions`, 20_000),
      look: b.look === null ? null : look(b.look, `${where}.bot.look`),
      provider: b.provider === null ? null : str(b.provider, `${where}.bot.provider`, 40, { re: PROVIDER }),
      model: text(b.model, `${where}.bot.model`, 120),
      effort: text(b.effort, `${where}.bot.effort`, 24),
      access: b.access as AccessLevel,
      group: text(b.group, `${where}.bot.group`, 40),
      timezone,
      connections: connectionIds(b.connections, `${where}.bot.connections`),
      skills: skillNames(b.skills, `${where}.bot.skills`),
    },
    routines: list(o.routines, `${where}.routines`, MAX_ROUTINES_PER_BOT, (x, w) => routineFields(x, w, timezone ?? 'UTC').r),
  };
}

const BOTON_KEYS = ['ref', 'name', 'title', 'instructions', 'look', 'provider', 'model', 'effort', 'access', 'timezone', 'paused', 'connections', 'skills', 'askFirst', 'alwaysAllow', 'browserSites', 'dailyCapUsd', 'routines'] as const;

function boton(v: unknown, where: string): PortableBoton {
  const o = obj(v, where, BOTON_KEYS);
  const botonLook = look(o.look, `${where}.look`);
  if (o.access !== 'workspace' && o.access !== 'host') bad(`${where}.access`, 'must be "workspace" or "host"');
  const timezone = str(o.timezone, `${where}.timezone`, 80);
  if (!isValidTimezone(timezone)) bad(`${where}.timezone`, 'is not a timezone this server knows');
  const connections = connectionIds(o.connections, `${where}.connections`);
  const skills = skillNames(o.skills, `${where}.skills`);
  return {
    ref: str(o.ref, `${where}.ref`, 64, { re: REF }),
    name: text(o.name, `${where}.name`, 60, true),
    title: text(o.title, `${where}.title`, 80),
    instructions: text(o.instructions, `${where}.instructions`, 20_000),
    look: botonLook,
    provider: str(o.provider, `${where}.provider`, 40, { re: PROVIDER }),
    model: text(o.model, `${where}.model`, 120),
    effort: text(o.effort, `${where}.effort`, 24),
    access: o.access as AccessLevel,
    timezone,
    paused: bool(o.paused, `${where}.paused`),
    connections,
    skills,
    askFirst: checked(`${where}.askFirst`, () => askFirstList(o.askFirst)),
    alwaysAllow: checked(`${where}.alwaysAllow`, () => alwaysAllowList(o.alwaysAllow)),
    browserSites: list(o.browserSites, `${where}.browserSites`, MAX_SITES, (x, w) => str(x, w, 300, { min: 1, oneLine: true })),
    dailyCapUsd: capUsd(o.dailyCapUsd, `${where}.dailyCapUsd`),
    routines: list(o.routines, `${where}.routines`, MAX_ROUTINES_PER_BOT, (x, w) => routine(x, w, timezone)),
  };
}

function author(v: unknown, where: string, refs: Set<string>): PortableSkill['author'] {
  const kind = v && typeof v === 'object' ? (v as J).kind : undefined;
  if (kind === 'owner') return obj(v, where, ['kind']) && { kind: 'owner' };
  if (kind !== 'boton') return bad(`${where}.kind`, 'must be "owner" or "boton"');
  const o = obj(v, where, ['kind', 'ref', 'name']);
  const ref = o.ref === null ? null : str(o.ref, `${where}.ref`, 64, { re: REF });
  if (ref !== null && !refs.has(ref)) bad(`${where}.ref`, 'names no Boton in the file');
  return { kind: 'boton', ref, name: text(o.name, `${where}.name`, 60, true) };
}

function skill(v: unknown, where: string, refs: Set<string>): PortableSkill {
  const o = obj(v, where, ['name', 'description', 'body', 'disabled', 'author', 'source', 'history']);
  return {
    name: str(o.name, `${where}.name`, 64, { re: SKILL_NAME }),
    description: text(o.description, `${where}.description`, 1024, true),
    body: text(o.body, `${where}.body`, 50_000, true),
    disabled: bool(o.disabled, `${where}.disabled`),
    author: author(o.author, `${where}.author`, refs),
    source: source(o.source, `${where}.source`),
    history: list(o.history, `${where}.history`, SKILL_HISTORY_KEEP, (x, w) => {
      const h = obj(x, w, ['description', 'body', 'source', 'replacedAt']);
      return { description: text(h.description, `${w}.description`, 1024, true), body: text(h.body, `${w}.body`, 50_000, true), source: source(h.source, `${w}.source`), replacedAt: str(h.replacedAt, `${w}.replacedAt`, 40, { min: 1 }) };
    }),
  };
}

function connector(v: unknown, where: string): PortableConnector {
  const kind = v && typeof v === 'object' ? (v as J).kind : undefined;
  const base = ['id', 'kind', 'name', 'onRequest', 'grant', 'enabled', 'leftOut'];
  const o = kind === 'library' ? obj(v, where, [...base, 'transport', 'command', 'args', 'url', 'envKeys', 'headerKeys']) : kind === 'oauth' ? obj(v, where, [...base, 'url', 'keepConnected', 'unknownJobs']) : bad(`${where}.kind`, 'must be "library" or "oauth"');
  const name = str(o.name, `${where}.name`, 40, { re: CONNECTOR_NAME });
  if (o.id !== `${kind === 'library' ? 'lib' : 'oauth'}:${name}`) bad(`${where}.id`, 'does not match its kind and name');
  if (o.grant !== 'approval' && o.grant !== 'immediate') bad(`${where}.grant`, 'must be "approval" or "immediate"');
  const common = {
    id: o.id as string,
    name,
    onRequest: bool(o.onRequest, `${where}.onRequest`),
    grant: o.grant as ConnectorGrant,
    enabled: bool(o.enabled, `${where}.enabled`),
    leftOut: list(o.leftOut, `${where}.leftOut`, 60, (x, w) => str(x, w, 200)),
  };
  if (kind === 'oauth') {
    if (o.unknownJobs !== 'nowhere' && o.unknownJobs !== 'primary') bad(`${where}.unknownJobs`, 'must be "nowhere" or "primary"');
    return { ...common, kind: 'oauth', url: plainUrl(o.url, `${where}.url`), keepConnected: bool(o.keepConnected, `${where}.keepConnected`), unknownJobs: o.unknownJobs as 'nowhere' | 'primary' };
  }
  // The browser Botons runs itself is never a library entry: no file can give it a command.
  if (name === BROWSER_SERVER) bad(`${where}.name`, `is the name of the browser Botons runs itself`);
  if (o.transport !== 'stdio' && o.transport !== 'http') bad(`${where}.transport`, 'must be "stdio" or "http"');
  const envKeys = list(o.envKeys, `${where}.envKeys`, 20, (x, w) => {
    const k = str(x, w, 64, { re: ENV_KEY });
    if (/^(BOTONS?|BOTONS?)_|^BOTON/.test(k) || k.startsWith('LC_')) bad(w, 'is reserved');
    return k;
  });
  const headerKeys = list(o.headerKeys, `${where}.headerKeys`, 20, (x, w) => (tokenShapedName(str(x, w, 64, { re: HEADER_KEY })) ? bad(w, 'looks like a token, not a header name') : (x as string)));
  unique(envKeys, `${where}.envKeys`);
  unique(headerKeys, `${where}.headerKeys`);
  const stdio = o.transport === 'stdio';
  const out = {
    ...common,
    kind: 'library' as const,
    transport: o.transport as 'stdio' | 'http',
    command: str(o.command, `${where}.command`, 500, { min: stdio ? 1 : 0, oneLine: true }),
    args: list(o.args, `${where}.args`, 50, (x, w) => str(x, w, 2000)),
    url: plainUrl(o.url, `${where}.url`, { empty: stdio }),
    envKeys,
    headerKeys,
  };
  if (stdio ? out.url || out.headerKeys.length : out.command || out.args.length || out.envKeys.length) bad(where, `mixes a ${out.transport} server's fields with the other kind's`);
  if (!stdio && !out.url) bad(`${where}.url`, 'is missing');
  return out;
}

/** The setting as the server checks it, and exactly as it keeps it: each emoji once, as written. */
function reactionList(v: unknown): string[] {
  const out = checked('settings.reactionFollowUps', () => followUpsInput(v));
  if (JSON.stringify(out) !== JSON.stringify(v)) bad('settings.reactionFollowUps', 'is not the list as this server keeps it (each emoji once)');
  return out;
}

function settings(v: unknown, refs: Set<string>): PortableSettings {
  const o = obj(v, 'settings', ['ownerName', 'timezone', 'primaryBoton', 'ntfy', 'reactionFollowUps']);
  const n = obj(o.ntfy, 'settings.ntfy', ['enabled', 'server', 'topic', 'preview', 'tokenLeftOut']);
  const timezone = str(o.timezone, 'settings.timezone', 80);
  if (!isValidTimezone(timezone)) bad('settings.timezone', 'is not a timezone this server knows');
  const primary = o.primaryBoton === null ? null : str(o.primaryBoton, 'settings.primaryBoton', 64, { re: REF });
  if (primary !== null && !refs.has(primary)) bad('settings.primaryBoton', 'names no Boton in the file');
  const server = plainUrl(n.server, 'settings.ntfy.server', { empty: true });
  if (server && new URL(server).search) bad('settings.ntfy.server', 'has a query');
  const topic = str(n.topic, 'settings.ntfy.topic', 64);
  if (topic && !NTFY_TOPIC.test(topic)) bad('settings.ntfy.topic', 'may use only letters, digits, - and _');
  const enabled = bool(n.enabled, 'settings.ntfy.enabled');
  if (enabled && (!server || !topic)) bad('settings.ntfy', 'is on without a server and topic');
  return {
    ownerName: text(o.ownerName, 'settings.ownerName', 80, true),
    timezone,
    primaryBoton: primary,
    ntfy: { enabled, server, topic, preview: bool(n.preview, 'settings.ntfy.preview'), tokenLeftOut: bool(n.tokenLeftOut, 'settings.ntfy.tokenLeftOut') },
    reactionFollowUps: o.reactionFollowUps === null ? null : reactionList(o.reactionFollowUps),
  };
}

/**
 * The sidebar with exactly its fields at every level (an unknown one refuses the file, never dropped), refs of
 * Botons in the file, group names as the server keeps them (trimmed, unique in any case), and nothing the
 * server's own reader (sidebarTransfer) would repair: what it returns must be what the file says.
 */
function sidebar(v: unknown, refs: Set<string>): SidebarTransfer {
  const o = obj(v, 'sidebar', ['format', 'version', 'pinned', 'groups', 'ungrouped']);
  const section = (x: unknown, where: string, keys: readonly string[] = ['collapsed', 'botIds']) => {
    const s = obj(x, where, keys);
    const botIds = list(s.botIds, `${where}.botIds`, MAX_BOTONS, (id, w) => {
      const ref = str(id, w, 64, { re: REF });
      if (!refs.has(ref)) bad(w, `names ${ref}, which is no Boton in the file`);
      return ref;
    });
    return { collapsed: bool(s.collapsed, `${where}.collapsed`), botIds };
  };
  const read: SidebarTransfer = {
    format: o.format as SidebarTransfer['format'],
    version: o.version as SidebarTransfer['version'],
    pinned: section(o.pinned, 'sidebar.pinned'),
    groups: list(o.groups, 'sidebar.groups', MAX_BOTONS, (g, w) => {
      const x = obj(g, w, ['name', 'collapsed', 'botIds']);
      return { name: text(x.name, `${w}.name`, 200, true), ...section(x, w, ['name', 'collapsed', 'botIds']) };
    }),
    ungrouped: section(o.ungrouped, 'sidebar.ungrouped'),
  };
  const kept = checked('sidebar:', () => sidebarTransfer(read));
  if (JSON.stringify(kept) !== JSON.stringify(read)) bad('sidebar', 'is not a layout as this server keeps it');
  return kept;
}

/** The file whole, at this server's version, or a 400 naming the first thing wrong with it. Reads nothing else. */
export function readPortable(input: unknown): { file: PortableConfig; upgradedFrom: number | null } {
  scan(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('the file', 'must be a JSON object');
  // A file exported under deprecated names reads with this server's names (shared/legacy-names.mjs).
  let raw = currentPortable(input as J);
  if (raw.format !== PORTABLE_FORMAT) bad('format', `must be "${PORTABLE_FORMAT}" (a Botons configuration export)`);
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return bad('version', 'must be a whole number from 1');
  if (version > PORTABLE_VERSION) bad('version', `is ${version}, made by a newer Botons: this server reads up to version ${PORTABLE_VERSION}. Upgrade this server first.`);
  for (let v = version; v < PORTABLE_VERSION; v++) {
    const up = UPGRADES[v];
    if (!up) bad('version', `${v} is not one this server can upgrade`);
    raw = up(raw);
  }
  const o = obj(raw, 'file', ['format', 'version', 'exportedAt', 'source', 'settings', 'botons', 'skills', 'connectors', 'sidebar', 'templates']);
  const src = obj(o.source, 'source', ['app', 'schema']);
  if (typeof src.schema !== 'number' || !Number.isInteger(src.schema) || src.schema < 1) bad('source.schema', 'must be a whole number');
  const botons = list(o.botons, 'botons', MAX_BOTONS, boton);
  const refs = new Set(botons.map((m) => m.ref));
  if (refs.size !== botons.length) bad('botons', 'has two Botons with the same ref');
  const skills = list(o.skills, 'skills', MAX_SKILLS, (x, w) => skill(x, w, refs));
  unique(
    skills.map((s) => s.name),
    'skills (by name)',
  );
  const connectors = list(o.connectors, 'connectors', MAX_LIBRARY + MAX_OAUTH, connector);
  unique(
    connectors.map((c) => c.id),
    'connectors (by id)',
  );
  if (connectors.filter((c) => c.kind === 'oauth').length > MAX_OAUTH) bad('connectors', `has more than ${MAX_OAUTH} OAuth connectors`);
  const layout = sidebar(o.sidebar, refs);
  const templates = list(o.templates, 'templates', MAX_TEMPLATES, template);
  unique(
    templates.map((t) => t.ref),
    'templates (by ref)',
  );
  return {
    file: {
      format: PORTABLE_FORMAT,
      version: PORTABLE_VERSION,
      exportedAt: str(o.exportedAt, 'exportedAt', 40),
      source: { app: str(src.app, 'source.app', 40), schema: src.schema as number },
      settings: settings(o.settings, refs),
      botons,
      skills,
      connectors,
      sidebar: layout,
      templates,
    },
    upgradedFrom: version === PORTABLE_VERSION ? null : version,
  };
}

// ---------------------------------------------------------------- exporting

/** A connector's URL as its endpoint: without its user name and password, query and #fragment. */
function endpointUrl(url: string): { url: string; why: string | null } {
  if (!url) return { url, why: null };
  const c = cleanUrl(url, true);
  return c.url === LEFT_OUT ? { url: '', why: 'its URL (it held a credential)' } : { url: c.url, why: c.why && `its URL's ${c.why.replace(/its /g, '')}` };
}

/**
 * Where text in the file holds something shaped like a credential, by place (never the text itself): every text the
 * file carries as written, each earlier text of a skill by its date, and connector arguments a hand-made file has.
 */
export function textWarningsOf(file: PortableConfig): string[] {
  const out: string[] = [];
  const watch = (where: string, ...texts: (string | null | undefined)[]) => {
    if (texts.some((t) => t && proseHasCredential(t))) out.push(where);
  };
  const sourceTexts = (src: SkillSource | null) => (src ? [src.label, ...Object.values(src.fields)] : []);
  watch('settings: your name', file.settings.ownerName);
  for (const m of file.botons) {
    watch(`Boton ${m.name}: name and title`, m.name, m.title);
    watch(`Boton ${m.name}: instructions`, m.instructions);
    for (const r of m.routines) watch(`Boton ${m.name}: routine ${r.name}`, r.name, r.instruction, r.webhookFilter && JSON.stringify(r.webhookFilter));
  }
  for (const sk of file.skills) {
    watch(`skill ${sk.name}: its current text`, sk.description, sk.body, ...sourceTexts(sk.source));
    sk.history.forEach((h, i) => watch(`skill ${sk.name}: its earlier text ${i + 1} of ${sk.history.length}, replaced ${h.replacedAt}`, h.description, h.body, ...sourceTexts(h.source)));
  }
  for (const c of file.connectors) {
    if (c.kind !== 'library') continue;
    const args = cleanArgs(c.args);
    if (args.args.some((a, i) => a !== c.args[i])) out.push(`connector ${c.id}: ${args.leftOut.map((x) => x.replace(/ \(.*$/, '')).join(', ')} (in the file as written)`);
    if (cleanCommand(c.command).text !== c.command) out.push(`connector ${c.id}: its command (in the file as written)`);
  }
  for (const t of file.templates) {
    watch(`template ${t.name}: its text`, t.name, t.description, t.bot.name, t.bot.title, t.bot.instructions);
    for (const r of t.routines) watch(`template ${t.name}: routine ${r.name}`, r.name, r.instruction, r.webhookFilter && JSON.stringify(r.webhookFilter));
  }
  return out;
}

/** How a schedule reads, in its own zone; it was checked as the file was read. */
function scheduleText(schedule: string, zone: string): string {
  try {
    return describeSchedule(toSpec(parseSchedule(schedule, zone)), zone);
  } catch {
    return schedule;
  }
}

const commandLine = (command: string, args: string[]) => [command, ...args].map((a) => (/^[\w@%+=:,./<>-]+$/.test(a) && !/\s/.test(a) ? a : JSON.stringify(a))).join(' ');

export interface PortableDeps {
  cfg: Config;
  store: Store;
  skills: Skills;
  connectors: Connectors;
  oauth: OAuthConnections;
  browser: Pick<Browser, 'policy' | 'importSites'>;
  templates: Pick<Templates, 'savedTemplates' | 'stage'>;
  spending: Pick<Spending, 'view' | 'importCaps'>;
  providers: ProviderRegistry;
  app: string;
  schema: number;
}

/** What import() acts on: the preview, and per Boton what it makes. */
interface Plan {
  preview: PortableImportPreview;
  file: PortableConfig;
  botons: (PortableBotonPlan & { m: PortableBoton })[];
  /** The templates to make, by ref, as they will be saved (narrowed). */
  templates: { ref: string; entry: Pick<StoredTemplate, 'name' | 'description' | 'bot' | 'routines'> }[];
  ntfy: { on: boolean; dropToken: boolean };
}

export class Portable {
  #d: PortableDeps;

  constructor(deps: PortableDeps) {
    this.#d = deps;
  }

  export(): PortableExport {
    const { store, skills, connectors, oauth, browser } = this.#d;
    const leftOut: string[] = [];
    const layout = store.exportSidebar();
    // Refs in the sidebar's order, so the file reads as the sidebar does; never the Botons' ids.
    const order = [...layout.pinned.botIds, ...layout.groups.flatMap((g) => g.botIds), ...layout.ungrouped.botIds];
    const bots = store.listBots().sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || a.createdAt.localeCompare(b.createdAt);
    });
    const refs = new Map(bots.map((b, i) => [b.id, `m${i + 1}`]));
    const botons: PortableBoton[] = bots.map((b) => {
      const where = `Boton ${b.name}`;
      const routines = store.listRoutines(b.id).filter((r) => !(r.schedule && isPastOneOff(r.schedule) && !r.webhook));
      // Its caps, never its spending: the account of requests stays on this server (and in its backups).
      const caps = this.#d.spending.view(b.id);
      const runCap = new Map(caps.routines.map((x) => [x.id, x.perRunCapUsd]));
      return {
        ref: refs.get(b.id)!,
        name: b.name,
        title: b.title,
        instructions: b.instructions,
        look: b.look,
        provider: b.provider,
        model: b.model,
        effort: b.effort,
        access: b.access,
        timezone: b.timezone,
        paused: b.paused,
        connections: b.connections,
        skills: b.skills,
        askFirst: b.askFirst,
        alwaysAllow: b.alwaysAllow,
        browserSites: browser.policy(b.id).sites,
        dailyCapUsd: caps.dailyCapUsd,
        routines: routines.map((r) => {
          if (r.webhook) leftOut.push(`${where}: routine ${r.name}'s webhook key${r.webhook.hasSecret ? ', signing secret' : ''}${r.webhook.callbackUrl ? ' and callback URL' : ''}`);
          return { ...templateRoutine(r, b), enabled: r.enabled, webhookSecretLeftOut: !!r.webhook?.hasSecret, callbackLeftOut: !!r.webhook?.callbackUrl, perRunCapUsd: runCap.get(r.id) ?? null };
        }),
      };
    });
    const portableSkills: PortableSkill[] = skills.list().map((s) => {
      const by = s.updatedBy;
      return {
        name: s.name,
        description: s.description,
        body: s.body,
        disabled: s.disabled,
        author: by.kind === 'owner' ? { kind: 'owner' } : { kind: 'boton', ref: refs.get(by.botId) ?? null, name: by.name },
        source: s.source,
        history: skills.history(s.name).map((h) => ({ description: h.description, body: h.body, source: h.source, replacedAt: h.replacedAt })),
      };
    });
    const policy = (id: string) => {
      const p = connectors.policyOf(id);
      return { onRequest: p.onRequest, grant: p.grant, enabled: !connectors.isOff(id) };
    };
    const portableConnectors: PortableConnector[] = [];
    for (const s of connectors.listServers()) {
      const id = `lib:${s.name}`;
      const out: string[] = [];
      const url = endpointUrl(s.url);
      if (url.why) out.push(url.why);
      const args = cleanArgs(s.args);
      out.push(...args.leftOut);
      let command = s.command;
      const cmd = cleanCommand(command);
      if (cmd.text !== command) {
        command = LEFT_OUT;
        out.push(`its command (${[...new Set(cmd.why)].join('; ')})`);
      }
      if (s.envKeys.length) out.push(`env values (${s.envKeys.join(', ')})`);
      if (s.headerKeys.length) out.push(`header values (${s.headerKeys.join(', ')})`);
      for (const x of out) leftOut.push(`connector ${id}: ${x}`);
      portableConnectors.push({ id, kind: 'library', name: s.name, ...policy(id), leftOut: out, transport: s.transport, command, args: args.args, url: url.url, envKeys: s.envKeys, headerKeys: s.headerKeys });
    }
    const shown = new Map(oauth.list().map((c) => [c.name, c]));
    for (const rec of oauth.records()) {
      const id = `oauth:${rec.name}`;
      const c = shown.get(rec.name)!;
      const url = endpointUrl(rec.url);
      const out = ['its sign-in and tokens', ...(url.why ? [url.why] : [])];
      for (const x of out) leftOut.push(`connector ${id}: ${x}`);
      portableConnectors.push({ id, kind: 'oauth', name: rec.name, ...policy(id), leftOut: out, url: url.url, keepConnected: c.keepConnected, unknownJobs: c.unknownJobs });
    }
    const s = store.getSettings();
    if (s.ntfy.hasToken) leftOut.push('settings: the ntfy token');
    const ref = (ids: string[]) => ids.map((id) => refs.get(id)!).filter(Boolean);
    const sidebar: SidebarTransfer = {
      format: layout.format,
      version: layout.version,
      pinned: { collapsed: layout.pinned.collapsed, botIds: ref(layout.pinned.botIds) },
      groups: layout.groups.map((g) => ({ name: g.name, collapsed: g.collapsed, botIds: ref(g.botIds) })),
      ungrouped: { collapsed: layout.ungrouped.collapsed, botIds: ref(layout.ungrouped.botIds) },
    };
    const file: PortableConfig = {
      format: PORTABLE_FORMAT,
      version: PORTABLE_VERSION,
      exportedAt: nowIso(),
      source: { app: this.#d.app, schema: this.#d.schema },
      settings: {
        ownerName: s.ownerName,
        timezone: s.timezone,
        primaryBoton: s.primaryBotId ? (refs.get(s.primaryBotId) ?? null) : null,
        ntfy: { enabled: s.ntfy.enabled, server: s.ntfy.server, topic: s.ntfy.topic, preview: s.ntfy.preview, tokenLeftOut: s.ntfy.hasToken },
        reactionFollowUps: s.reactionFollowUps,
      },
      botons,
      skills: portableSkills,
      connectors: portableConnectors,
      sidebar,
      // Saved templates hold no secret (never webhook keys, signing secrets or callback URLs): as saved, by ref.
      templates: [],
    };
    // Each as an import would read it: one this format can't carry exactly is named and left out, not changed.
    for (const t of this.#d.templates.savedTemplates()) {
      const entry = { ref: `t${file.templates.length + 1}`, name: t.name, description: t.description, bot: t.bot, routines: t.routines };
      try {
        file.templates.push(template(JSON.parse(JSON.stringify(entry)), `template ${t.name}`));
      } catch (err) {
        leftOut.push(`template ${t.name}: all of it (${(err as Error).message.replace(/^Not a configuration this server can import: /, '')})`);
      }
    }
    log.info('configuration exported', { botons: botons.length, skills: portableSkills.length, connectors: portableConnectors.length, templates: file.templates.length });
    return { file, leftOut: [...NEVER_EXPORTED.map((x) => `never in the file: ${x}`), ...leftOut], textWarnings: textWarningsOf(file) };
  }

  // ---------------------------------------------------------------- importing

  async preview(input: PortableImportInput): Promise<PortableImportPreview> {
    return (await this.#plan(input)).preview;
  }

  async #plan(input: PortableImportInput): Promise<Plan> {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Send { file, choices }');
    const { file, upgradedFrom } = readPortable(input.file);
    const { store, skills, connectors, oauth, providers, cfg } = this.#d;
    const choices = input.choices ?? {};
    if (typeof choices !== 'object' || choices === null || Array.isArray(choices)) throw new HttpError(400, 'choices must be an object');
    const known = (o: unknown, what: string, names: Set<string>) => {
      if (o === undefined) return {} as Record<string, unknown>;
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, `choices.${what} must be an object`);
      for (const k of Object.keys(o)) if (!names.has(k)) throw new HttpError(400, `choices.${what}: ${k.slice(0, 64)} is not in the file`);
      return o as Record<string, unknown>;
    };
    const botonChoices = known(choices.botons, 'botons', new Set(file.botons.map((m) => m.ref)));
    const skillChoices = known(choices.skills, 'skills', new Set(file.skills.map((s) => s.name)));
    const connectorChoices = known(choices.connectors, 'connectors', new Set(file.connectors.map((c) => c.id)));
    const templateChoices = known(choices.templates, 'templates', new Set(file.templates.map((t) => t.ref)));

    const bots = store.listBots();
    const fresh = bots.length === 0;
    const botNames = new Set(bots.map((b) => b.name.toLowerCase()));
    const catalog = connectors.catalog().connectors;
    const hostConnectors = new Set(catalog.map((c) => c.id));
    const liveHere = new Set(catalog.filter((c) => c.enabled && (c.status === 'ok' || c.managed)).map((c) => c.id));
    const hostSkills = new Map(skills.list().map((s) => [s.name, s]));
    const providerIds = [...providers.ids()].sort();
    const defaultProvider = await providers.defaultProvider();
    const reconnect: PortableReconnect[] = [];

    // Connectors: one here by the same id is kept (the file's is shown, not applied); the rest are made, off.
    const connectorPlans = file.connectors.map((c) => {
      const exists = hostConnectors.has(c.id);
      const chosen = connectorChoices[c.id];
      const action = (chosen ?? (exists ? 'keep' : 'create')) as PortableConnectorAction;
      if (!(exists ? ['keep', 'skip'] : ['create', 'skip']).includes(action)) throw new HttpError(400, `choices.connectors.${c.id} must be ${exists ? '"keep" or "skip" (one is here already)' : '"create" or "skip"'}`);
      if (action === 'create' && c.kind === 'oauth') {
        const refused = refusedOutbound(c.url, cfg.oauth.allow);
        if (refused) throw new HttpError(400, `${c.id} can't be made here: Botons won't connect to its URL (${refused})`);
      }
      const secrets = c.kind === 'library' ? [...c.envKeys.map((k) => `env ${k}`), ...c.headerKeys.map((k) => `header ${k}`)] : ['a sign-in'];
      return {
        id: c.id,
        kind: c.kind,
        name: c.name,
        action,
        exists,
        target: c.kind === 'library' ? (c.transport === 'stdio' ? commandLine(c.command, c.args) : c.url) : c.url,
        runsCommand: c.kind === 'library' && c.transport === 'stdio',
        secrets,
        leftOut: c.leftOut,
        onRequest: c.onRequest,
        grant: c.grant,
      };
    });
    const oauthMade = connectorPlans.filter((c) => c.kind === 'oauth' && c.action === 'create').length;
    if (oauthMade && oauth.list().length + oauthMade > MAX_OAUTH) throw new HttpError(400, `This server can have at most ${MAX_OAUTH} OAuth connectors: skip some of the file's`);
    for (const c of connectorPlans.filter((x) => x.action === 'create')) {
      if (c.kind === 'oauth') reconnect.push({ kind: 'connector-sign-in', target: c.id, text: `Sign ${c.name} in: Connect it in Settings → Connectors.` });
      else if (c.secrets.length) reconnect.push({ kind: 'connector-secret', target: c.id, text: `Enter ${c.name}'s ${c.secrets.join(', ')} in Settings → Connectors.` });
      // Its secrets are named above; anything else the export took out of it is put back by hand too.
      const rest = c.leftOut.filter((x) => !x.startsWith('env values') && !x.startsWith('header values') && x !== 'its sign-in and tokens');
      if (rest.length) reconnect.push({ kind: 'connector-left-out', target: c.id, text: `Put back what the export left out of ${c.name}: ${rest.join('; ')}.` });
      reconnect.push({ kind: 'connector-off', target: c.id, text: `${c.name} was imported turned off: check its setup${c.runsCommand ? ' (its command runs in the turns of Botons that have it)' : ''}, then turn it on in Settings → Connectors.` });
    }
    const usableConnectors = new Set([...hostConnectors, ...connectorPlans.filter((c) => c.action === 'create').map((c) => c.id)]);
    const fileConnector = new Map(connectorPlans.map((c) => [c.id, c]));

    // Skills: made, put in place of the one here, or this server's kept.
    const skillPlans = file.skills.map((s) => {
      const here = hostSkills.get(s.name);
      const sameText = !!here && here.version === skillVersion(s.description, s.body);
      const chosen = skillChoices[s.name];
      const action = (chosen ?? (here ? 'keep' : 'create')) as PortableSkillAction;
      if (!(here ? ['replace', 'keep', 'skip'] : ['create', 'skip']).includes(action)) throw new HttpError(400, `choices.skills.${s.name} must be ${here ? '"replace", "keep" or "skip" (one is here already)' : '"create" or "skip"'}`);
      return {
        name: s.name,
        action,
        exists: !!here,
        sameText,
        disabled: action === 'keep' ? here!.disabled : s.disabled,
        pending: s.author.kind === 'boton',
        source: s.source ? `${s.source.folder}${s.source.label ? ` (${s.source.label})` : ''}` : null,
        history: s.history.length,
        asks: asksOf({ description: s.description, body: s.body, fields: s.source?.fields ?? {} }),
      };
    });
    const library = new Set([...hostSkills.keys(), ...skillPlans.filter((s) => s.action !== 'skip').map((s) => s.name)]);
    const fileSkill = new Map(file.skills.map((s) => [s.name, s]));
    const skillPlan = new Map(skillPlans.map((s) => [s.name, s]));

    // Botons: one with a name in use here is left out unless the owner makes it anyway.
    const botonPlans = file.botons.map((m): PortableBotonPlan & { m: PortableBoton } => {
      const c = (botonChoices[m.ref] ?? {}) as Record<string, unknown>;
      if (typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `choices.botons.${m.ref} must be an object`);
      for (const k of Object.keys(c)) if (!['action', 'provider', 'fullAccess', 'alwaysAllow', 'caps'].includes(k)) throw new HttpError(400, `choices.botons.${m.ref}.${k.slice(0, 40)} is not a choice`);
      const conflict = botNames.has(m.name.toLowerCase());
      const action = (c.action ?? (conflict ? 'skip' : 'create')) as PortableBotonAction;
      if (action !== 'create' && action !== 'skip') throw new HttpError(400, `choices.botons.${m.ref}.action must be "create" or "skip"`);
      const available = providerIds.includes(m.provider);
      const provider = (c.provider ?? (available ? m.provider : defaultProvider)) as string;
      if (typeof provider !== 'string' || !providerIds.includes(provider)) throw new HttpError(400, `choices.botons.${m.ref}.provider must be one of ${providerIds.join(', ')}`);
      if (c.fullAccess !== undefined && typeof c.fullAccess !== 'boolean') throw new HttpError(400, `choices.botons.${m.ref}.fullAccess must be true or false`);
      if (c.alwaysAllow !== undefined && typeof c.alwaysAllow !== 'boolean') throw new HttpError(400, `choices.botons.${m.ref}.alwaysAllow must be true or false`);
      // The file's caps by default; arriving without them is the owner's choice alone. No choice sets a higher one.
      const capsChoice = (c.caps ?? 'file') as PortableCapsChoice;
      if (capsChoice !== 'file' && capsChoice !== 'none') throw new HttpError(400, `choices.botons.${m.ref}.caps must be "file" or "none"`);
      const keepCaps = capsChoice === 'file';
      const same = provider === m.provider;
      const model = same ? m.model : '';
      const effort = m.effort && !effortProblem(provider, m.effort, store.effortCaps(provider, model)) ? m.effort : '';
      // Full computer access and Always allow rules are what the owner ticks, never what the file says alone.
      const access: AccessLevel = m.access === 'host' && c.fullAccess === true ? 'host' : 'workspace';
      const alwaysAllow = c.alwaysAllow === true ? m.alwaysAllow : [];
      const connections = { imported: [] as string[], live: [] as string[], dropped: [] as { id: string; why: string }[] };
      for (const id of m.connections) {
        if (usableConnectors.has(id)) {
          connections.imported.push(id);
          if (liveHere.has(id)) connections.live.push(id);
        }
        else if (id === BROWSER_CONNECTOR) connections.dropped.push({ id, why: 'this server has no managed browser' });
        else connections.dropped.push({ id, why: fileConnector.get(id) ? 'left out of this import' : 'not in the file and not on this server' });
      }
      const skillList = m.skills === null ? null : { imported: m.skills.filter((n) => library.has(n)), dropped: m.skills.filter((n) => !library.has(n)).map((name) => ({ name, why: skillPlan.has(name) ? 'left out of this import' : 'not in the file and not on this server' })) };
      const sites = connections.imported.includes(BROWSER_CONNECTOR) || m.browserSites.length ? effectiveSites(m.browserSites, access, cfg.browser.allowPrivate) : [];
      const has = (name: string) => skillList === null || skillList.imported.includes(name);
      const routines = m.routines.map((r) => {
        const own = r.skill ? fileSkill.get(r.skill) : undefined;
        const plan = r.skill ? skillPlan.get(r.skill) : undefined;
        const here = r.skill ? hostSkills.get(r.skill) : undefined;
        const fromFile = plan && plan.action !== 'skip' && plan.action !== 'keep';
        const disabled = fromFile ? own!.disabled : here?.disabled;
        const pendingFor = fromFile ? (own!.author.kind === 'boton' ? own!.author.ref : undefined) : here?.pending ? null : undefined;
        const skill = r.skill && library.has(r.skill) && has(r.skill) && !disabled && (pendingFor === undefined || pendingFor === m.ref) ? r.skill : null;
        let rModel = same ? r.model : null;
        let rEffort = r.effort && !effortProblem(provider, r.effort, store.effortCaps(provider, rModel || model)) ? r.effort : null;
        if (rModel && !rEffort && inheritedEffortProblem(provider, effort, store.effortCaps(provider, rModel))) {
          rModel = null;
          rEffort = r.effort && !effortProblem(provider, r.effort, store.effortCaps(provider, model)) ? r.effort : null;
        }
        return {
          name: r.name,
          perRunCap: { file: r.perRunCapUsd, imported: keepCaps ? r.perRunCapUsd : null },
          schedule: r.schedule ? scheduleText(r.schedule, r.timezone ?? m.timezone) : null,
          webhook: r.webhook,
          fullAccessWebhook: { file: r.webhook && !r.webhookWorkspace, imported: r.webhook && !r.webhookWorkspace && access === 'host' },
          wasEnabled: r.enabled,
          skill: { file: r.skill, imported: skill },
          model: { file: r.model, imported: rModel },
          effort: { file: r.effort, imported: rEffort },
        };
      });
      const daily = keepCaps ? m.dailyCapUsd : null;
      const priced = apiPriceKnown(provider, model);
      const caps = { choice: capsChoice, daily: { file: m.dailyCapUsd, imported: daily }, applies: priced !== null, unpriced: (daily !== null && priced === false) || routines.some((r) => (daily !== null || r.perRunCap.imported !== null) && apiPriceKnown(provider, r.model.imported ?? model) === false) };
      if (action === 'create') {
        if (!available) reconnect.push({ kind: 'brain', target: m.ref, text: `${m.name}'s brain (${m.provider}) isn't on this server: it was imported with ${provider}. Change it in its settings once that brain is set up.` });
        const on = routines.filter((r) => r.wasEnabled).length;
        if (on) reconnect.push({ kind: 'routine-off', target: m.ref, text: `${m.name}: ${on === 1 ? '1 routine was' : `${on} routines were`} on and arrived off. Turn ${on === 1 ? 'it' : 'them'} on in its Routines when you're ready.` });
        for (const r of m.routines.filter((x) => x.webhook)) {
          const extra = [r.webhookSecretLeftOut && 'its signing secret', r.callbackLeftOut && 'its callback URL'].filter(Boolean).join(' and ');
          reconnect.push({ kind: 'webhook', target: m.ref, text: `${m.name} / ${r.name}: give the sender its new webhook URL and key${extra ? `, and set ${extra} again` : ''}.` });
        }
      }
      return {
        m,
        ref: m.ref,
        name: m.name,
        action,
        conflict,
        provider: { file: m.provider, imported: provider, available, options: providerIds },
        model: { file: m.model, imported: model },
        effort: { file: m.effort, imported: effort },
        access: { file: m.access, imported: access },
        alwaysAllow: { file: m.alwaysAllow, imported: alwaysAllow },
        askFirst: m.askFirst,
        paused: m.paused,
        connections,
        skills: skillList === null ? { imported: null, dropped: [] } : skillList,
        browserSites: { imported: sites, dropped: m.browserSites.filter((x) => !sites.includes(x)) },
        caps,
        routines,
      };
    });
    const spendingNotes: string[] = [];
    const making = botonPlans.filter((m) => m.action === 'create');
    const fileHasCaps = file.botons.some((m) => m.dailyCapUsd !== null || m.routines.some((r) => r.perRunCapUsd !== null));
    if (upgradedFrom !== null && upgradedFrom < 3) spendingNotes.push(`The file is format version ${upgradedFrom}, which carries no spending caps: imported Botons arrive with none. Set them in each Boton's Spending once it is here.`);
    if (making.some((m) => m.caps.applies || m.caps.daily.imported !== null || m.routines.some((r) => r.perRunCap.imported !== null))) {
      spendingNotes.push("What Botons spent where the file was made isn't in it: each Boton made here is new, with its own account starting at $0 today, counted against the caps it arrives with. No Boton already here has its caps or spending changed.");
    }
    for (const m of making) {
      const capText = [m.caps.daily.imported !== null && `${usd(m.caps.daily.imported)} a day`, ...m.routines.filter((r) => r.perRunCap.imported !== null).map((r) => `${usd(r.perRunCap.imported)} a run for ${r.name}`)].filter(Boolean).join(', ');
      const dropped = m.caps.daily.file !== null || m.routines.some((r) => r.perRunCap.file !== null);
      if (m.caps.choice === 'none' && dropped) spendingNotes.push(`${m.name}: you chose to leave out the file's spending caps; it arrives with none.`);
      if (capText && !m.caps.applies) spendingNotes.push(`${m.name}: its caps (${capText}) are kept, but count only API-key turns, and it arrives on ${m.provider.imported}.`);
      if (m.caps.daily.imported !== null && apiPriceKnown(m.provider.imported, m.model.imported) === false) spendingNotes.push(`${m.name}: its model has no known price here, so with a cap set its turns are refused until you pick a model with a known price or remove the cap.`);
      for (const r of m.routines) {
        if ((m.caps.daily.imported !== null || r.perRunCap.imported !== null) && apiPriceKnown(m.provider.imported, r.model.imported ?? m.model.imported) === false) {
          spendingNotes.push(`${m.name} / ${r.name}: its effective model (${r.model.imported || m.model.imported || 'the brain default'}) has no known price here, so this routine's capped turns are refused until you pick a model with a known price or remove its applicable caps.`);
        }
      }
    }
    if (fileHasCaps && !making.length) spendingNotes.push('No Boton is made, so none of the file\'s spending caps are.');
    if (botonPlans.some((m) => m.action === 'create')) {
      reconnect.push({ kind: 'brain', target: '', text: "Brains' sign-ins and API keys are never in the file: sign each brain in on this server, or save its key in Settings → API keys." });
    }

    // Settings and the sidebar: by default only on a server with no Botons yet, which is what moving one is.
    if (choices.settings !== undefined && typeof choices.settings !== 'boolean') throw new HttpError(400, 'choices.settings must be true or false');
    const applySettings = choices.settings ?? fresh;
    const now = store.getSettings();
    const s = file.settings;
    const changes: { field: string; from: string; to: string }[] = [];
    const change = (field: string, from: string, to: string) => from !== to && changes.push({ field, from, to });
    const created = (ref: string | null) => (ref && botonPlans.find((m) => m.ref === ref && m.action === 'create') ? ref : null);
    // This server's push token belongs to its push server: kept only if the file names the same one (scheme, host
    // and port), else removed, never sent to another. Pushes the file had on with a token stay off until one is entered.
    const sameServer = ntfyOrigin(s.ntfy.server) === ntfyOrigin(now.ntfy.server);
    const keepsToken = now.ntfy.hasToken && sameServer;
    const dropsToken = now.ntfy.hasToken && !sameServer;
    const needsToken = s.ntfy.tokenLeftOut && !keepsToken;
    const ntfyOn = s.ntfy.enabled && !needsToken;
    const notes: string[] = [];
    if (applySettings) {
      change('Your name', now.ownerName, s.ownerName);
      change('Default timezone', now.timezone, s.timezone);
      change('Push server', now.ntfy.server, s.ntfy.server);
      change('Push topic', now.ntfy.topic, s.ntfy.topic);
      change('Push notifications', now.ntfy.enabled ? 'on' : 'off', ntfyOn ? 'on' : 'off');
      if (dropsToken) change('Push access token', `saved (for ${ntfyOrigin(now.ntfy.server) || 'no server'})`, 'removed: it is never sent to another server');
      else if (keepsToken && s.ntfy.tokenLeftOut) notes.push("This server's saved push access token is kept: the file names the same push server.");
      change('Message text in pushes', now.ntfy.preview ? 'shown' : 'hidden', s.ntfy.preview ? 'shown' : 'hidden');
      if (s.reactionFollowUps === null) notes.push(`The file doesn't say which reactions start a follow-up (format version ${upgradedFrom ?? PORTABLE_VERSION}): this server's are kept (${now.reactionFollowUps.join(' ') || 'none'}).`);
      else change('Reactions that start a follow-up', now.reactionFollowUps.join(' ') || 'none', s.reactionFollowUps.join(' ') || 'none');
      const primary = created(s.primaryBoton);
      if (primary) change('Primary Boton', now.primaryBotId ? (bots.find((b) => b.id === now.primaryBotId)?.name ?? '') : 'none', file.botons.find((m) => m.ref === primary)!.name);
      if (s.ntfy.enabled && needsToken) reconnect.push({ kind: 'ntfy-token', target: 'ntfy', text: 'Push notifications used an access token, which is never in the file: enter it in Settings → Push notifications, then turn pushes on.' });
    }
    const sidebarMode = (choices.sidebar ?? (fresh && store.sidebarLayout().groups.length === 0 ? 'replace' : 'merge')) as PortableSidebarMode;
    if (!['replace', 'merge', 'skip'].includes(sidebarMode)) throw new HttpError(400, 'choices.sidebar must be "replace", "merge" or "skip"');

    const textWarnings = textWarningsOf(file);

    // Saved templates: each a new one, unless one here has its name and content already. What it would widen when
    // used (Full computer access, Full access webhook runs) or names that this server won't have is left out of it.
    const savedHere = this.#d.templates.savedTemplates();
    const templatePlans = file.templates.map((t) => {
      const narrowed: string[] = [];
      const bot = { ...t.bot };
      if (bot.access === 'host') {
        bot.access = 'workspace';
        narrowed.push('Full computer access (choose it when you make a Boton from it)');
      }
      const lostBrain = bot.provider !== null && !providerIds.includes(bot.provider);
      if (lostBrain) {
        narrowed.push(`its brain ${bot.provider}, which this server doesn't have${bot.model ? `, with its model ${bot.model}` : ''}${bot.effort ? ` and effort ${bot.effort}` : ''}`);
        bot.provider = null;
        bot.model = '';
        bot.effort = '';
      }
      const lostConnections = bot.connections.filter((id) => !usableConnectors.has(id));
      if (lostConnections.length) narrowed.push(`connectors this server won't have: ${lostConnections.join(', ')}`);
      bot.connections = bot.connections.filter((id) => usableConnectors.has(id));
      if (bot.skills) {
        const lost = bot.skills.filter((n) => !library.has(n));
        if (lost.length) narrowed.push(`skills this server won't have: ${lost.join(', ')}`);
        bot.skills = bot.skills.filter((n) => library.has(n));
      }
      const fullHooks = t.routines.filter((r) => r.webhook && !r.webhookWorkspace).length;
      if (fullHooks) narrowed.push(`Full access for ${fullHooks === 1 ? 'a webhook routine' : `${fullHooks} webhook routines`}`);
      // Each routine's own losses, by name: a skill this server won't have, a model for a brain it doesn't have.
      const routines = t.routines.map((r) => {
        const lost: string[] = [];
        if (r.skill && !library.has(r.skill)) lost.push(`its skill ${r.skill}, which this server won't have`);
        if (lostBrain && r.model) lost.push(`its model ${r.model}, for the brain this server doesn't have`);
        if (lost.length) narrowed.push(`routine ${r.name}: ${lost.join('; ')}`);
        return { ...r, webhookWorkspace: true, skill: r.skill && library.has(r.skill) ? r.skill : null, model: lostBrain ? null : r.model };
      });
      const content = JSON.stringify([t.description, bot, routines]);
      const same = savedHere.some((x) => x.name === t.name && JSON.stringify([x.description, x.bot, x.routines]) === content);
      const action = (templateChoices[t.ref] ?? (same ? 'skip' : 'create')) as PortableTemplateAction;
      if (action !== 'create' && action !== 'skip') throw new HttpError(400, `choices.templates.${t.ref} must be "create" or "skip"`);
      return { plan: { ref: t.ref, name: t.name, action, same, routines: t.routines.length, narrowed }, entry: { name: t.name, description: t.description, bot, routines } };
    });

    const body: Omit<PortableImportPreview, 'fingerprint'> = {
      source: { format: PORTABLE_FORMAT, version: upgradedFrom ?? PORTABLE_VERSION, app: file.source.app, schema: file.source.schema, exportedAt: file.exportedAt },
      upgradedFrom,
      choices: {
        botons: Object.fromEntries(
          botonPlans.map((m) => [
            m.ref,
            { action: m.action, provider: m.provider.imported, fullAccess: m.access.imported === 'host', alwaysAllow: m.alwaysAllow.imported.length > 0 || (botonChoices[m.ref] as { alwaysAllow?: boolean } | undefined)?.alwaysAllow === true, caps: m.caps.choice },
          ]),
        ),
        skills: Object.fromEntries(skillPlans.map((x) => [x.name, x.action])),
        connectors: Object.fromEntries(connectorPlans.map((x) => [x.id, x.action])),
        templates: Object.fromEntries(templatePlans.map((x) => [x.plan.ref, x.plan.action])),
        settings: applySettings,
        sidebar: sidebarMode,
      },
      settings: { apply: applySettings, changes, notes },
      botons: botonPlans.map(({ m: _m, ...p }) => p),
      skills: skillPlans,
      connectors: connectorPlans,
      sidebar: { mode: sidebarMode, groups: file.sidebar.groups.map((g) => g.name) },
      spending: { notes: spendingNotes },
      templates: templatePlans.map((x) => x.plan),
      textWarnings,
      reconnect,
    };
    // What was shown, and the file itself: a different file, or a change here that changes the plan, gets another.
    const fingerprint = sha(
      JSON.stringify([PLAN_REVISION, body, sha(JSON.stringify(file)), templatePlans.map((x) => x.entry), now, store.sidebarLayout(), [...hostSkills.values()].map((x) => [x.name, x.version, x.disabled, x.pending]), savedHere.map((x) => [x.id, x.name])]),
    );
    return { preview: { ...body, fingerprint }, file, botons: botonPlans, templates: templatePlans.map((x) => ({ ref: x.plan.ref, entry: x.entry })), ntfy: { on: ntfyOn, dropToken: dropsToken } };
  }

  /**
   * Makes exactly what the preview with `fingerprint` showed, all at once or not at all (409 if it would differ now).
   * `record` writes the audit inside the same transaction, so an import is never kept unrecorded; nothing it does is
   * published (events, approvals, the templates' files) until the transaction commits, and none of it if it rolls back.
   */
  async import(input: PortableImportInput, record: (result: PortableImportResult, made: Bot[]) => void): Promise<PortableImportResult> {
    const plan = await this.#plan(input);
    if (typeof input.fingerprint !== 'string' || input.fingerprint !== plan.preview.fingerprint) {
      throw new HttpError(409, 'The file, your choices or this server changed since the preview: preview it again.');
    }
    const { store, skills, connectors, oauth, browser, providers } = this.#d;
    const { preview, file } = plan;
    const ids = providers.ids();
    const made = new Map<string, Bot>();
    const toMake = plan.templates.filter((t) => preview.choices.templates[t.ref] === 'create');
    // Written aside now, listed in the transaction, put in place once it commits; removed if it doesn't (templates.ts).
    const staged = this.#d.templates.stage(toMake.map((t) => t.entry));
    let result: PortableImportResult;
    try {
      result = store.atomically((): PortableImportResult => this.#make(plan, made, ids, staged, toMake, record));
    } catch (err) {
      staged.discard();
      throw err;
    }
    log.info('configuration imported', { botons: result.botons.length, skills: result.skills.length, connectors: result.connectors.length, templates: result.templates.length });
    return result;
  }

  #make(
    plan: Plan,
    made: Map<string, Bot>,
    ids: Set<string>,
    staged: { record(): void },
    toMake: Plan['templates'],
    record: (result: PortableImportResult, made: Bot[]) => void,
  ): PortableImportResult {
    const { store, skills, connectors, oauth, browser } = this.#d;
    const { preview, file } = plan;
    // Connectors first, so the Botons' lists name them; each made off, at a new request-policy generation.
    const connectorsMade: string[] = [];
    for (const c of file.connectors) {
      if (preview.choices.connectors[c.id] !== 'create') continue;
      if (c.kind === 'library') {
        connectors.createServer({ name: c.name, transport: c.transport, ...(c.transport === 'stdio' ? { command: c.command, args: c.args } : { url: c.url }) });
      } else {
        const conn = oauth.create({ name: c.name, url: c.url }, { quiet: true });
        oauth.update(conn.id, { keepConnected: c.keepConnected, unknownJobs: c.unknownJobs }, { quiet: true });
        oauth.emit(conn.id);
      }
      connectors.setPolicy(c.id, { onRequest: c.onRequest, grant: c.grant });
      connectors.setEnabled(c.id, false, 'Imported from a configuration file: check it, then turn it on');
      connectorsMade.push(c.id);
    }

    const placed = new Map<string, { group: string; pinned: boolean }>();
    if (preview.sidebar.mode !== 'skip') {
      for (const g of file.sidebar.groups) for (const ref of g.botIds) placed.set(ref, { group: g.name, pinned: false });
      for (const ref of file.sidebar.pinned.botIds) placed.set(ref, { group: placed.get(ref)?.group ?? '', pinned: true });
    }
    for (const p of plan.botons) {
      if (p.action !== 'create') continue;
      const m = p.m;
      const where = placed.get(m.ref);
      const bot = store.createBot(
        {
          name: m.name,
          title: m.title,
          instructions: m.instructions,
          look: m.look,
          provider: p.provider.imported,
          model: p.model.imported,
          effort: p.effort.imported,
          access: p.access.imported,
          timezone: m.timezone,
          connections: p.connections.imported,
          skills: p.skills.imported,
          ...(where ? { group: where.group, pinned: where.pinned } : {}),
        },
        ids,
        p.provider.imported,
      );
      if (m.askFirst.length || p.alwaysAllow.imported.length) store.updateBot(bot.id, { askFirst: m.askFirst, alwaysAllow: p.alwaysAllow.imported }, ids);
      if (m.paused) store.setBotPaused(bot.id, true);
      browser.importSites(bot.id, p.browserSites.imported, p.access.imported);
      made.set(m.ref, bot);
    }

    // Skills after the Botons, so a Boton's pending skill stays its own here.
    const skillsMade: string[] = [];
    for (const s of file.skills) {
      const action = preview.choices.skills[s.name];
      if (action !== 'create' && action !== 'replace') continue;
      const by: SkillAuthor = s.author.kind === 'owner' ? { kind: 'owner' } : { kind: 'boton', botId: (s.author.ref && made.get(s.author.ref)?.id) || '', name: s.author.name };
      skills.importSkill({ ...s, author: by }, action === 'replace');
      skillsMade.push(s.name);
    }

    const caps = new Map<string, PortableImportResult['botons'][number]['caps']>();
    for (const p of plan.botons) {
      const bot = made.get(p.ref);
      if (!bot) continue;
      const runCaps: [string, number][] = [];
      const capped: { id: string; name: string; perRunCapUsd: number }[] = [];
      p.m.routines.forEach((r, i) => {
        const rp = p.routines[i];
        const routineMade = store.createRoutine(
          bot.id,
          {
            name: r.name,
            instruction: r.instruction,
            schedule: r.schedule,
            timezone: r.timezone ?? bot.timezone,
            webhook: r.webhook,
            // Off until the owner turns it on: nothing imported runs by itself.
            enabled: false,
            notify: r.notify,
            webhookWorkspace: !rp.fullAccessWebhook.imported,
            ...(r.webhook ? { webhookSource: r.webhookSource, webhookFilter: r.webhookFilter } : {}),
            skill: rp.skill.imported,
            model: rp.model.imported,
            effort: rp.effort.imported,
            session: r.session,
            timeLimitMs: r.timeLimitMs === null ? null : Math.min(r.timeLimitMs, this.#d.cfg.turnTimeoutMs),
          },
          { chip: false },
        );
        if (rp.perRunCap.imported !== null) {
          runCaps.push([routineMade.id, rp.perRunCap.imported]);
          capped.push({ id: routineMade.id, name: routineMade.name, perRunCapUsd: rp.perRunCap.imported });
        }
      });
      // On the ids just made, in this transaction: bound to nothing that was here before (spend.ts refuses that).
      this.#d.spending.importCaps(bot.id, p.caps.daily.imported, runCaps);
      caps.set(p.ref, { dailyCapUsd: p.caps.daily.imported, routines: capped });
      const n = p.m.routines.length;
      store.addMessage(bot.id, 'event', `Imported from a configuration file${n ? `; ${n === 1 ? '1 routine' : `${n} routines`}, off` : ''}`, { kind: 'bot.imported', copiedRoutines: n, sourceName: p.name });
    }

    if (preview.settings.apply) {
      const s = file.settings;
      const primary = s.primaryBoton ? made.get(s.primaryBoton)?.id : undefined;
      store.updateSettings({
        ownerName: s.ownerName,
        timezone: s.timezone,
        ntfy: { enabled: plan.ntfy.on, server: s.ntfy.server, topic: s.ntfy.topic, preview: s.ntfy.preview, ...(plan.ntfy.dropToken ? { token: null } : {}) },
        ...(s.reactionFollowUps !== null ? { reactionFollowUps: s.reactionFollowUps } : {}),
        ...(primary ? { primaryBotId: primary } : {}),
      });
    }

    if (preview.sidebar.mode === 'replace') {
      const id = (refs: string[]) => refs.flatMap((r) => (made.has(r) ? [made.get(r)!.id] : []));
      store.importSidebar({
        ...file.sidebar,
        pinned: { ...file.sidebar.pinned, botIds: id(file.sidebar.pinned.botIds) },
        groups: file.sidebar.groups.map((g) => ({ ...g, botIds: id(g.botIds) })),
        ungrouped: { ...file.sidebar.ungrouped, botIds: id(file.sidebar.ungrouped.botIds) },
      });
    }

    const result: PortableImportResult = {
      botons: [...made].map(([ref, b]) => ({ ref, botId: b.id, name: b.name, caps: caps.get(ref)! })),
      skills: skillsMade,
      connectors: connectorsMade,
      templates: toMake.map((t) => t.entry.name),
      settings: preview.settings.apply,
      sidebar: preview.sidebar.mode,
      reconnect: preview.reconnect,
    };
    record(result, [...made.values()].map((b) => store.publicBot(store.getBot(b.id))));
    // In the same transaction as the audit: shown once it commits, or after a crash once the server starts again.
    staged.record();
    return result;
  }
}
