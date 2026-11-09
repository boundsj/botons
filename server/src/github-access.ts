import { outbound, type OutboundRequest, type OutboundResponse } from './outbound.ts';

/*
 * What a GitHub token can see, for the owner's test of the GitHub preset: one read-only REST request to GitHub's own
 * API host (never the connector's URL or anywhere else), asking for at most one private repository. Listing the MCP
 * server's tools says nothing about which repositories the token was given, and this request reads only their names,
 * so a token that sees one private repository may still lack Contents: Read on it.
 */

export const GITHUB_API = 'https://api.github.com/user/repos?visibility=private&per_page=1';

export const GITHUB_REJECTED = 'GitHub rejected the token (expired or deleted?)';
export const GITHUB_PUBLIC_ONLY = 'This token can only see public repos. Give it Repository access to the repos you want and at least Contents: Read.';

/** rejected: 401; public-only: no private repository, or 404; unknown: anything else (said nothing about access). */
export type GithubAccess = 'private' | 'public-only' | 'rejected' | 'unknown';

export type Request = (url: string, opts: OutboundRequest) => Promise<OutboundResponse>;

/** The Authorization header among saved headers, in any case, or null. */
export function authorizationOf(headers: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'authorization' && v) return v;
  return null;
}

export async function githubAccess(authorization: string, signal?: AbortSignal, request: Request = outbound): Promise<GithubAccess> {
  let res: OutboundResponse;
  try {
    res = await request(GITHUB_API, {
      method: 'GET',
      // Only the token goes to GitHub: none of the connector's other headers.
      headers: { authorization, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Botons' },
      allow: [],
      maxBytes: 256 * 1024,
      timeoutMs: 10_000,
      signal,
    });
  } catch {
    return 'unknown';
  }
  if (res.status === 401) return 'rejected';
  if (res.status === 404) return 'public-only';
  if (res.status !== 200) return 'unknown';
  let list: unknown;
  try {
    list = JSON.parse(res.body);
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(list)) return 'unknown';
  return list.some((r) => r && typeof r === 'object' && (r as { private?: unknown }).private === true) ? 'private' : 'public-only';
}
