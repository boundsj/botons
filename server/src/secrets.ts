/*
 * Text that came back from another server (an error answer, a tool name) may hold the credentials that were sent
 * to it, or other credentials it chose to show. Everything such text reaches (a log line, a saved status, an API
 * answer) gets it through sanitize() first, before any truncation, so no prefix of a secret survives a cut.
 */

/** `text` with every one of `secrets` replaced, longest first, however short it is. */
export function redact(text: string, secrets: Iterable<string | null | undefined>): string {
  let out = text;
  const list = [...new Set([...secrets].filter((x): x is string => typeof x === 'string' && x.length > 0))].sort((a, b) => b.length - a.length);
  for (const v of list) out = out.split(v).join('[redacted]');
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs of 20 or more token characters with both a letter and a digit: the shape of access and refresh tokens,
 * codes, keys and JWT segments. Words, host names (their labels break at dots) and UUIDs are left alone.
 */
export function redactTokenShaped(text: string): string {
  return text.replace(/[A-Za-z0-9_~+/-]{20,}={0,2}/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) && !UUID.test(run) ? '[redacted]' : run));
}

/**
 * For logs, saved errors and API answers. Control characters go first, so none can split a secret apart for the
 * steps after it; then known secrets, then token-shaped runs, and only then the cut.
 */
export function sanitize(text: string, secrets: Iterable<string | null | undefined> = [], max = 300): string {
  return redactTokenShaped(redact(text.replace(/[\u0000-\u001f\u007f]/g, ''), secrets)).slice(0, max);
}

/**
 * A JSON value with `scrub` applied to every string in it, object keys included (for a structured tool result, a
 * tool's input schema): what comes back from another server is redacted whole, not only its text. Deeper than `depth`
 * nesting is cut (no real result nests that far).
 */
export function redactJson(v: unknown, scrub: (text: string) => string, depth = 0): unknown {
  if (typeof v === 'string') return scrub(v);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 64) return '[nested too deep]';
  if (Array.isArray(v)) return v.map((x) => redactJson(x, scrub, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[scrub(k)] = redactJson(x, scrub, depth + 1);
  return out;
}
