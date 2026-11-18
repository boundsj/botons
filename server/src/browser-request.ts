/** Browser field safety and cookie identity for private hand-back. */

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

const slotOf = (c: JarCookie) => JSON.stringify([c.domain, c.path, c.name, c.partitionKey ?? null, c.partitionKey ? (c._crHasCrossSiteAncestor ?? true) : null]);

/**
 * The cookies of `jar` in no place `kept` has a cookie in (its partition counted, as Chromium keeps it): the ones a
 * site dropped, to go when `kept` is the whole jar. Same name, domain and path in another partition is another cookie.
 */
export function staleCookies<C extends JarCookie>(jar: C[], kept: JarCookie[]): C[] {
  const keep = new Set(kept.map(slotOf));
  return jar.filter((c) => !keep.has(slotOf(c)));
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
