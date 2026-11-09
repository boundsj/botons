import { VERSION } from '../../shared/app-version.mjs';
import { hostOf, OutboundError, outbound } from './outbound.ts';
import { redact, redactJson, sanitize } from './secrets.ts';
import { refusedText } from '../../shared/services.ts';

/*
 * Just enough of an MCP client (Streamable HTTP) for the server's own calls with a connector's token: initialize,
 * list tools, call one. Each answer may be JSON or a short event stream; both are bounded by outbound().
 */

const PROTOCOL = '2025-06-18';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_PAGES = 20;

export class McpError extends Error {
  /** auth: the token was refused (401/403); rpc: the server answered with an error; transport: anything else. */
  readonly kind: 'auth' | 'rpc' | 'transport';
  constructor(kind: McpError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The secrets in a set of request headers: each value, and the credential after an auth scheme ("Bearer x" → x), so
 * a server that echoes them back in an error or a tool name can't get them into a result, a log line or the audit.
 */
export function secretsOf(headers: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(headers)) {
    out.add(v);
    const m = /^\S+\s+(\S.*)$/.exec(v);
    if (m) out.add(m[1]);
  }
  return [...out].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}

export { redact };

/** Every secret of the session taken out of a result's text, whatever its length. */
function sanitizeText(text: string, secrets: string[]): string {
  let out = text;
  for (const v of secrets) if (v.length >= 4) out = out.split(v).join('[redacted]');
  return out;
}

/**
 * What a server said about its tools or a call, with the session's secrets out of all of it (structured content, a
 * tool's description and input schema, not only text) before anything else reads it. Names stay as they are, for the
 * caller to judge (an API brain leaves out a tool whose name holds one: it can't be redacted and still be called).
 */
export function cleanTools(tools: McpTool[], secrets: string[]): McpTool[] {
  const scrub = (t: string) => sanitizeText(t, secrets);
  return tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema ? (redactJson(t.inputSchema, scrub) as Record<string, unknown>) : null, description: typeof t.description === 'string' ? scrub(t.description) : null }));
}

/** Whether `text` holds one of `secrets` (as cleanTools and cleanResult take them out). */
export function holdsSecret(text: string, secrets: string[]): boolean {
  return secrets.some((v) => v.length >= 4 && text.includes(v));
}

/**
 * A tools/call result with the session's secrets out of it, and `also` (the caller's own, such as an API brain's
 * keys) applied too: both to the whole text, before it is cut, so no part of a secret is left at the cut.
 */
export function cleanResult(r: Record<string, unknown>, secrets: string[], also: (text: string) => string = (t) => t): ToolResult {
  const scrub = (t: string) => also(sanitizeText(t, secrets));
  const sc = r.structuredContent;
  return {
    isError: r.isError === true,
    structured: sc && typeof sc === 'object' && !Array.isArray(sc) ? (redactJson(sc, scrub) as Record<string, unknown>) : null,
    text: resultText(r.content, scrub),
  };
}

export interface McpTool {
  name: string;
  inputSchema: Record<string, unknown> | null;
  /** The server's own words for it, when a string (for a model to read; never trusted). */
  description?: string | null;
}

export interface ToolResult {
  isError: boolean;
  structured: Record<string, unknown> | null;
  /** Its text content blocks, joined, bounded (other kinds of content are named, not passed on). */
  text?: string;
}

const MAX_RESULT_TEXT = 64 * 1024;

/**
 * A tools/call result's content as text: text blocks as they are, anything else by its kind, joined; `scrub` goes
 * over the whole of it (across the blocks' joins too) before it is cut at MAX_RESULT_TEXT.
 */
export function resultText(content: unknown, scrub: (text: string) => string = (t) => t): string {
  const parts: string[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    const block = b as { type?: unknown; text?: unknown };
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (typeof block?.type === 'string') parts.push(`[${block.type.slice(0, 40)} content not shown]`);
  }
  const text = scrub(parts.join('\n'));
  return text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}\n[… cut at ${MAX_RESULT_TEXT} characters]` : text;
}

/** The JSON-RPC answer with `id`, from a JSON body or an SSE stream. */
function answerOf(body: string, contentType: string, id: number): Record<string, unknown> | null {
  const pick = (v: unknown) => {
    const list = Array.isArray(v) ? v : [v];
    return (list.find((m) => m && typeof m === 'object' && (m as Record<string, unknown>).id === id) as Record<string, unknown> | undefined) ?? null;
  };
  if (contentType.includes('text/event-stream')) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const found = pick(JSON.parse(data));
        if (found) return found;
      } catch {}
    }
    return null;
  }
  try {
    return pick(JSON.parse(body));
  } catch {
    return null;
  }
}

export class McpSession {
  #url: string;
  #headers: Record<string, string>;
  #allow: string[];
  #signal?: AbortSignal;
  #session: string | null = null;
  #version = PROTOCOL;
  #id = 0;
  #authority?: () => void;
  /** How long one request may take; tools/call of an API brain's connector may take longer than a test's. */
  timeoutMs = 20_000;

  /** `auth`: a bearer token, or the headers a library server was saved with (the protocol's own headers win). */
  constructor(url: string, auth: string | Record<string, string>, allow: string[], signal?: AbortSignal, authority?: () => void) {
    this.#url = url;
    this.#headers = {};
    if (typeof auth === 'string') this.#headers.authorization = `Bearer ${auth}`;
    else for (const [k, v] of Object.entries(auth)) this.#headers[k.toLowerCase()] = v;
    this.#allow = allow;
    this.#signal = signal;
    this.#authority = authority;
  }

  /** What this session sends that must not come back out in text: see secretsOf(). */
  get secrets(): string[] {
    return secretsOf(this.#headers);
  }

  async #post(body: Record<string, unknown>, expectAnswer: boolean): Promise<Record<string, unknown> | null> {
    // Includes initialization notifications and each discovery page, not only top-level tool calls.
    this.#authority?.();
    const headers: Record<string, string> = {
      ...this.#headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.#version,
    };
    delete headers['mcp-session-id'];
    if (this.#session) headers['mcp-session-id'] = this.#session;
    let res;
    try {
      res = await outbound(this.#url, { method: 'POST', allow: this.#allow, headers, body: JSON.stringify(body), maxBytes: MAX_BYTES, timeoutMs: this.timeoutMs, signal: this.#signal });
    } catch (err) {
      throw new McpError('transport', sanitize(err instanceof OutboundError ? err.message : String(err), this.secrets, 300));
    }
    this.#authority?.();
    if (res.status === 401 || res.status === 403) throw new McpError('auth', refusedText(this.#url, res.status, 'authorization' in this.#headers));
    const sid = res.headers['mcp-session-id'];
    if (typeof sid === 'string' && /^[\x21-\x7e]{1,200}$/.test(sid)) this.#session = sid;
    if (!expectAnswer) {
      if (res.status >= 300) throw new McpError('transport', `${hostOf(this.#url)} answered ${res.status}`);
      return null;
    }
    if (res.status !== 200) throw new McpError('transport', `${hostOf(this.#url)} answered ${res.status}`);
    const answer = answerOf(res.body, String(res.headers['content-type'] ?? ''), body.id as number);
    if (!answer) throw new McpError('transport', `${hostOf(this.#url)} sent no answer to ${String(body.method)}`);
    if (answer.error) {
      const e = answer.error as { message?: unknown };
      throw new McpError('rpc', `${hostOf(this.#url)}: ${typeof e?.message === 'string' ? sanitize(e.message, this.secrets, 200) : 'error'}`);
    }
    const result = answer.result;
    return result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  }

  #request(method: string, params: Record<string, unknown>) {
    return this.#post({ jsonrpc: '2.0', id: ++this.#id, method, params }, true) as Promise<Record<string, unknown>>;
  }

  async initialize(): Promise<void> {
    const r = await this.#request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Botons', version: VERSION } });
    if (typeof r.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.protocolVersion)) this.#version = r.protocolVersion;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  }

  /** Every tool, following nextCursor (bounded). */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: unknown;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await this.#request('tools/list', cursor === undefined ? {} : { cursor });
      for (const t of Array.isArray(r.tools) ? r.tools : []) {
        if (t && typeof t.name === 'string')
          tools.push({ name: t.name, inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : null, description: typeof t.description === 'string' ? t.description : null });
      }
      if (typeof r.nextCursor !== 'string' || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return cleanTools(tools, this.secrets);
  }

  /** `also`: more to take out of the result before it is cut (see cleanResult). */
  async callTool(name: string, args: Record<string, unknown>, also?: (text: string) => string): Promise<ToolResult> {
    return cleanResult(await this.#request('tools/call', { name, arguments: args }), this.secrets, also);
  }
}
