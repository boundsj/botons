/*
 * Services the owner can connect in a few clicks: each is data (its name, MCP URL, how its token is sent and where
 * to make one), so adding another is one entry here. The server names a service by its host in its messages, so a
 * refused token says "GitHub", not an address.
 */

export interface ServicePreset {
  id: string;
  /** As the owner reads it. */
  label: string;
  /** The connector name it suggests (the library's NAME rule). */
  name: string;
  url: string;
  /** Hosts that are this service. */
  hosts: string[];
  /** What the token is called there. */
  secretLabel: string;
  secretPlaceholder: string;
  help: { text: string; url: string };
  /** One short line on what to give the token. */
  note: string;
}

export const SERVICE_PRESETS: readonly ServicePreset[] = [
  {
    id: 'github',
    label: 'GitHub',
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    hosts: ['api.githubcopilot.com'],
    secretLabel: 'Personal access token',
    secretPlaceholder: 'github_pat_…',
    help: { text: 'Create a fine-grained token', url: 'https://github.com/settings/personal-access-tokens/new' },
    note: 'Give it only the repositories and permissions Botons needs.',
  },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The preset a URL belongs to, by its host, or null. */
export function presetFor(url: string): ServicePreset | null {
  const host = hostOf(url);
  return (host && SERVICE_PRESETS.find((p) => p.hosts.includes(host))) || null;
}

/** A service's name for messages: its preset's label, else its host. */
export function serviceName(url: string): string {
  return presetFor(url)?.label ?? (hostOf(url) || 'The server');
}

/**
 * An Authorization header value from what the owner pasted: a bare token becomes "Bearer <token>"; a value that
 * already names its scheme ("Bearer …", "token …", "Basic …") or the whole "Authorization: …" line is kept as given.
 */
export function authorizationValue(input: string): string {
  let t = input.trim().replace(/^authorization\s*:\s*/i, '');
  if (/^(bearer|token|basic)\s+\S/i.test(t)) return t.replace(/^(\S+)\s+/, (_, scheme: string) => `${scheme[0].toUpperCase()}${scheme.slice(1).toLowerCase()} `);
  t = t.replace(/\s+/g, '');
  return t ? `Bearer ${t}` : '';
}

/** What to say when a server refuses a request with `status` (401 or 403). Never holds the credential. */
export function refusedText(url: string, status: number, sentToken: boolean): string {
  const who = serviceName(url);
  if (sentToken && status === 401 && presetFor(url)?.id === 'github') return 'GitHub rejected the token (expired or deleted?)';
  return sentToken ? `${who} refused the token (${status}). Check its permissions or expiry.` : `${who} refused the request (${status}). Check its API key or headers.`;
}

/** What the form and the server say when a token is where a header's name goes. Names nothing it was given. */
export const TOKEN_AS_NAME = 'That looks like a token, not a header name. Paste your token into the API key field above, or use Authorization as the header name.';

/**
 * Whether a header or variable name is a token pasted in the wrong place, so it is refused before it is saved and
 * later listed: a scheme ("Bearer …", "Authorization: …"), a known token prefix, a long letters-and-digits run, or
 * longer than any name. Real names are short words joined by - or _ ("X-Api-Key", "GITHUB_TOKEN").
 */
export function tokenShapedName(name: string): boolean {
  const t = name.trim();
  if (t.length > 64) return true;
  if (/^(authorization\s*:|(bearer|token|basic)\s)/i.test(t)) return true;
  if (/^npm_[A-Za-z0-9]{36}$/.test(t)) return true;
  if (t.length >= 16 && /^(gh[pousr]_|github_pat_|glpat-|xox[abposr]-|sk-|(sk|rk|pk)_(live|test)_|AKIA[0-9A-Z]|ASIA[0-9A-Z]|AIza|ya29\.|eyJ|hf_|shpat_|lin_api_|sntrys_)/.test(t)) return true;
  return t.split(/[-_]/).some((run) => run.length >= 24 || (run.length >= 16 && /[A-Za-z]/.test(run) && /\d/.test(run)));
}
