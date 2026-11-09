import { createHash } from 'node:crypto';
import { READ_METHODS, WRITE_METHODS } from './browser-policy.ts';

/*
 * What the managed browser's approval cards are made of, as pure functions. What a page sends because the Boton
 * clicked or typed (a form, a script's POST, or a GET: a site can act on an address too) leaves only as one request
 * that Chromium's routing holds at the network boundary while the owner reads it: the card shows that request in full
 * (method, full address with its query, what it carries, the names of its cookies) and is bound to a fingerprint of
 * all of it, so allowing it sends exactly those bytes once (wireHeaders, browser-send.ts), never a request the page
 * made since, and never with a cookie other than the ones it was held with. Those may only be cookies the browser
 * itself held for the request's address while the step ran (heldCookies): a site's own cookies change as it works (a
 * session refreshed, a sign-in step, a script's cookie), and that churn is fine; a cookie from nowhere is not.
 *
 * Where a request can't be shown in full (too long, binary, a file in it), there is no card: it is refused.
 */


/** What a card may show at most: a request whose description is longer is refused, never cut. */
export const SHOWN_MAX = 3500;

/** Headers every request carries, which say nothing the page chose: left off the card (cookies are named, never shown). */
const ORDINARY_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'origin',
  'pragma',
  'priority',
  'referer',
  'upgrade-insecure-requests',
  'user-agent',
]);

export interface HeldRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  /** The cookies it carries that the page set or changed while the step ran (see heldCookies): named on its card. */
  changed?: string[];
}

/** Headers that carry a credential: on a card by name only, never their value (the fingerprint still binds it). */
const CREDENTIAL = /^(authorization|proxy-authorization|cookie|x-csrf-token|x-xsrf-token)$|token|secret|auth|session|api-?key|password|credential/i;

/** Headers that belong to one connection, not to the request: never sent as held, the sender sets its own. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length']);

/**
 * The headers that go on the wire for a held request, in order: exactly the ones it was held with, but for HTTP/2's
 * pseudo-headers (the method and address, sent as such) and those of one connection; `host` from its address when
 * Chromium spoke HTTP/2, and the body's length. Nothing else: no cookie it didn't carry, none from the browser's jar.
 */
export function wireHeaders(r: HeldRequest): [string, string][] {
  const out: [string, string][] = [];
  let host = false;
  for (const [k, v] of Object.entries(r.headers)) {
    const name = k.toLowerCase();
    if (name.startsWith(':') || HOP.has(name)) continue;
    if (name === 'host') host = true;
    out.push([name, v]);
  }
  if (!host) out.unshift(['host', new URL(r.url).host]);
  if (r.body?.length || !READ_METHODS.has(r.method.toUpperCase())) out.push(['content-length', String(r.body?.length ?? 0)]);
  out.push(['connection', 'close']);
  return out;
}

/** A cookie as the browser holds it. */
export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  partitionKey?: string;
  /** Chromium's half of a partition: whether the frame that set it had a cross-site ancestor (Playwright's name; true when unsaid). */
  _crHasCrossSiteAncestor?: boolean;
}

/** Whether the browser keeps `c` for `url` (domain, path, Secure), as Playwright's cookies(url) decides it. */
function appliesTo(c: JarCookie, url: URL): boolean {
  const host = url.hostname;
  if (host !== c.domain && !(c.domain.startsWith('.') && `.${host}`.endsWith(c.domain))) return false;
  const path = url.pathname;
  if (path !== c.path && !(path.startsWith(c.path) && (c.path.endsWith('/') || path[c.path.length] === '/'))) return false;
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  return !c.secure || url.protocol === 'https:' || local;
}

/** A Cookie header as the pairs it carries, in order (a pair without "=" is a cookie with no name, as Chromium writes it). */
function carriedPairs(header: string): [string, string][] {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.includes('=') ? [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()] : ['', p]));
}

/**
 * One place a cookie lives in the jar: a second cookie of one name is another place (another path, domain or
 * partition). Chromium keys a partition by its top-level site and whether the frame had a cross-site ancestor, so
 * that bit is part of the place; Playwright takes it as true when a partitioned cookie leaves it out.
 */
const slotOf = (c: JarCookie) => JSON.stringify([c.domain, c.path, c.name, c.partitionKey ?? null, c.partitionKey ? (c._crHasCrossSiteAncestor ?? true) : null]);

/**
 * The cookies of `jar` in no place `kept` has a cookie in (its partition counted, as Chromium keeps it): the ones a
 * site dropped, to go when `kept` is the whole jar. Same name, domain and path in another partition is another cookie.
 */
export function staleCookies<C extends JarCookie>(jar: C[], kept: JarCookie[]): C[] {
  const keep = new Set(kept.map(slotOf));
  return jar.filter((c) => !keep.has(slotOf(c)));
}

/**
 * The cookies a held request goes with, or why it gets no card. `start` is the whole jar as the step began, `now` the
 * whole jar read after the request was held. Chromium wrote the request's Cookie header from its jar at some moment
 * between the two, and a site changes its own cookies as it works (a session refreshed, the next step of a sign-in,
 * a script's cookie), so the jar may change in between. What may not happen is a cookie the browser never held:
 * each pair the header carries must be a cookie the browser held for the request's address (its domain, path and
 * Secure) at the step's start or after the hold, each cookie counted once. Carrying fewer than the jar holds is fine
 * (a request made without credentials, or without the ones SameSite or a partition keeps back). The ones it carries
 * that are new or changed since the step began are returned by name, for its card. The header is sent exactly as
 * held, so a change to the jar after this changes nothing that goes.
 */
export function heldCookies(header: string | undefined, url: string, start: JarCookie[] | null, now: JarCookie[]): { changed: string[] } | { why: string } {
  if (!start) return { why: "the browser's cookies could not be read as the step began" };
  if (!header) return { changed: [] };
  const u = new URL(url);
  // Every place a cookie for this address was, with each value it had: as the step began, and as the request was held.
  const slots = new Map<string, { name: string; before: string | null; values: Set<string> }>();
  for (const [c, at] of [...start.map((c) => [c, 'start'] as const), ...now.map((c) => [c, 'now'] as const)]) {
    if (!appliesTo(c, u)) continue;
    const key = slotOf(c);
    const slot = slots.get(key) ?? { name: c.name, before: null, values: new Set<string>() };
    if (at === 'start') slot.before = c.value;
    slot.values.add(c.value);
    slots.set(key, slot);
  }
  const used = new Set<string>();
  const changed = new Set<string>();
  for (const [name, value] of carriedPairs(header)) {
    const found = [...slots].find(([key, s]) => !used.has(key) && s.name === name && s.values.has(value));
    if (!found) return { why: `it carries a cookie the browser does not hold for ${u.host}` };
    used.add(found[0]);
    if (found[1].before !== value) changed.add(name || '(no name)');
  }
  return { changed: [...changed].sort() };
}

/** Headers that differ between two reads of one request without changing what it asks: its cookies (judged by heldCookies) and the browser's client hints. */
const churns = (name: string) => name === 'cookie' || name.startsWith('sec-ch-');

/**
 * Why `now` is not the request on a card (`card`), or null when it is: the same method, full address and body, and the
 * same headers but for cookie churn and client hints. What goes is always the card's request, never `now`.
 */
export function sameRequest(card: HeldRequest, now: HeldRequest): string | null {
  if (card.method.toUpperCase() !== now.method.toUpperCase()) return 'its method is not the one on the card';
  if (card.url !== now.url) return 'its address is not the one on the card';
  const body = (r: HeldRequest) => r.body ?? Buffer.alloc(0);
  if (!body(card).equals(body(now))) return 'what it carries is not what the card shows';
  const rest = (r: HeldRequest) =>
    JSON.stringify(
      Object.entries(r.headers)
        .map(([k, v]) => [k.toLowerCase(), v])
        .filter(([k]) => !churns(k))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  if (rest(card) !== rest(now)) return 'its headers are not the ones on the card';
  return null;
}

/** What binds a card: the Boton, the turn, the browser session and page document, and every byte of the request (its Cookie header included). */
export interface Binding {
  botId: string;
  tokenId: string;
  session: string;
  revision: number;
}

export function fingerprint(b: Binding, r: HeldRequest): string {
  const headers = Object.entries(r.headers)
    .map(([k, v]) => [k.toLowerCase(), v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  h.update(JSON.stringify([b.botId, b.tokenId, b.session, b.revision, r.method.toUpperCase(), r.url, headers]));
  h.update('\n');
  if (r.body) h.update(r.body);
  return h.digest('hex');
}

/**
 * Text from a page or a request, safe to show: control characters, invisible ones and those that reorder text (bidi
 * overrides) are written out as \u{…}, so a card can't hide or reorder what it says.
 */
export function shown(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** One line of a field: its value on the card, newlines written out too. */
const oneLine = (text: string) => shown(text).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decode(body: Buffer): string | null {
  try {
    const t = utf8.decode(body);
    // Text, not bytes: anything below a space other than tab and newlines means it isn't.
    return /[\u0000-\u0008\u000e-\u001f]/.test(t) ? null : t;
  } catch {
    return null;
  }
}

function formFields(text: string): string[] {
  if (!text) return ['(no fields)'];
  return text.split('&').map((pair) => {
    const at = pair.indexOf('=');
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    return at < 0 ? `${oneLine(dec(pair))} = ` : `${oneLine(dec(pair.slice(0, at)))} = ${oneLine(dec(pair.slice(at + 1)))}`;
  });
}

/** A multipart body's fields, or why it can't be shown (a file in it, or not a body we can read). */
function multipartFields(contentType: string, text: string): string[] | { why: string } {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundary) return { why: 'it is a multipart body without a boundary' };
  const sep = `--${boundary[1] ?? boundary[2]}`;
  const parts = text.split(sep);
  if (parts.length < 3 || !/^--\s*$/.test(parts.at(-1)!)) return { why: 'its multipart body could not be read' };
  const out: string[] = [];
  for (const raw of parts.slice(1, -1)) {
    const part = raw.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) return { why: 'its multipart body could not be read' };
    const head = part.slice(0, split);
    if (/filename\*?=/i.test(head)) return { why: 'it sends a file, and the browser never uploads' };
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '(no name)';
    out.push(`${oneLine(name)} = ${oneLine(part.slice(split + 4))}`);
  }
  return out.length ? out : ['(no fields)'];
}

export interface Described {
  title: string;
  details: string;
}

/**
 * The card for one held request, or why there is none (it is then refused). `control` is the page's own label for
 * what was clicked or typed into, shown as the site's text: never a reason to allow it.
 */
export function describeRequest(r: HeldRequest, control: string | null, key: string): Described | { why: string } {
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return { why: 'its address could not be read' };
  }
  const method = r.method.toUpperCase();
  if (!WRITE_METHODS.has(method) && !READ_METHODS.has(method)) return { why: `${method} requests are not sent` };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v;
  const type = headers['content-type'] ?? '';
  const lines = [`${method} ${oneLine(u.href)}`];
  lines.push(control ? `After: ${control} (that label is the site's own text, not proof of what this does)` : 'Made by the page itself while the browser acted (no control of its own)');
  lines.push('');
  const body = r.body && r.body.length ? r.body : null;
  if (READ_METHODS.has(method)) lines.push(`A ${method} sends what its address says (the query above): a site can act on that too, so it waits on you like a form.`);
  if (!body) lines.push('It carries nothing (no body).');
  else {
    const text = decode(body);
    if (text === null) return { why: 'it carries bytes that are not text, which a card cannot show' };
    const mime = type.split(';')[0].trim().toLowerCase();
    if (mime === 'application/x-www-form-urlencoded') lines.push('Fields (a form):', ...formFields(text).map((f) => `  ${f}`));
    else if (mime === 'multipart/form-data') {
      const fields = multipartFields(type, text);
      if (!Array.isArray(fields)) return fields;
      lines.push('Fields (a multipart form):', ...fields.map((f) => `  ${f}`));
    } else lines.push(`Body (${oneLine(type || 'no type given')}), as sent:`, shown(text));
  }
  const extra = Object.entries(headers).filter(([k]) => !ORDINARY_HEADERS.has(k) && !k.startsWith('sec-'));
  if (extra.length) lines.push('', 'Headers the page set:', ...extra.map(([k, v]) => `  ${oneLine(k)}: ${CREDENTIAL.test(k) ? '(a credential, not shown)' : oneLine(v)}`));
  const names = headers.cookie ? [...new Set(carriedPairs(headers.cookie).map(([n]) => oneLine(n || '(no name)')))] : [];
  lines.push('', names.length ? `It goes with the browser's own cookies for ${u.host} (values not shown): ${names.join(', ')}.` : 'It goes without cookies.');
  if (r.changed?.length) lines.push(`The site set or changed ${r.changed.map(oneLine).join(', ')} while the browser acted: still its own cookies, sent as they were when the page made it.`);
  lines.push('', `If you allow it, exactly this request is sent once, now. Nothing else the page sends is allowed by it. (Request ${key.slice(0, 16)})`);
  const details = lines.join('\n');
  if (details.length > SHOWN_MAX) return { why: `it is too long to show you in full on a card (${details.length.toLocaleString('en-US')} characters)` };
  const path = u.pathname.length > 80 ? `${u.pathname.slice(0, 79)}…` : u.pathname;
  return { title: oneLine(`Let the browser send ${method} ${u.host}${path}${u.search ? '?…' : ''}`).slice(0, 200), details };
}

/** Kinds of field the browser never types into: passwords, codes, card numbers and other secrets. */
const SENSITIVE = /pass(word|wd|code|phrase)?\b|\bpwd\b|\bpin\b|\botp\b|otp.?code|one.?time|totp|2fa|mfa|verif(y|ication).?code|security.?code|\bcvv|\bcvc|\bcsc\b|card.?(number|num|no)|\bcc.?(num|number|exp|csc)|credit.?card|\biban\b|routing.?number|account.?number|\bssn\b|social.?security|secret|api.?key|token|private.?key/i;

export interface FieldInfo {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  label: string;
}

/** Why the browser won't type into this field, or null. Judged from what the page says of it, so when in doubt, it won't. */
export function typingProblem(f: FieldInfo): string | null {
  const tag = f.tag.toLowerCase();
  const type = f.type.toLowerCase() || 'text';
  if (tag !== 'input' && tag !== 'textarea') return 'it is not a text field';
  if (tag === 'input' && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(type)) {
    return type === 'password' ? 'it is a password field' : `it is not a text field (type ${type})`;
  }
  const auto = f.autocomplete.toLowerCase();
  if (/(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+|transaction-amount)(\s|$)/.test(auto)) return 'the page marks it as a password, code or card field';
  for (const v of [f.name, f.id, f.label]) if (SENSITIVE.test(v)) return 'it looks like a field for a password, a code, a card number or another secret';
  return null;
}
