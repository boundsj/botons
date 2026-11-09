import { isAbsolute, join, resolve } from 'node:path';
import { actionKey, HttpError } from './store.ts';
import { orNull, truncate } from './util.ts';

// Ask first rules are Claude Code permission rules (`Bash(git push:*)`, `mcp__slack__send_message`).
// Claude Code decides when a call matches; matchRule only finds which rule it was, so it errs towards matching.

const ASK_FIRST_MAX = 50;
const RULE_MAX = 200;

/** `Tool` or `Tool(specifier)`: a tool name (an MCP one may end in `*`), and anything but a line break inside the parentheses. */
const RULE = /^([A-Za-z][\w-]*\*?)(?:\((.+)\))?$/;

function askRule(v: unknown): string {
  const field = 'each askFirst rule';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const rule = v.trim();
  if (!rule) throw new HttpError(400, `${field} is empty`);
  if (rule.length > RULE_MAX) throw new HttpError(400, `${field} is too long (max ${RULE_MAX} characters)`);
  if (/[\r\n]/.test(rule) || !RULE.test(rule)) {
    throw new HttpError(400, `${field} must be a Claude Code permission rule, such as Bash(git push:*), WebFetch(domain:example.com) or mcp__slack__send_message (got "${rule}")`);
  }
  return rule;
}

/** Bot.askFirst as given: valid rules, without repeats. */
export function askFirstList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'askFirst must be a list of permission rules');
  const list = [...new Set(v.map(askRule))];
  if (list.length > ASK_FIRST_MAX) throw new HttpError(400, `askFirst can hold at most ${ASK_FIRST_MAX} rules`);
  return list;
}

/** What "Always allow" adds to Bot.alwaysAllow for a rule, or null if no action kind can hold it. */
export function ruleKey(rule: string): string | null {
  return orNull(() => actionKey(rule));
}

/** The rules a turn asks about, and the always-allowed ones (never in a sandboxed turn). */
export function splitRules(askFirst: string[], alwaysAllow: string[], sandboxed: boolean): { ask: string[]; allow: string[] } {
  const always = new Set(alwaysAllow);
  const allow = sandboxed ? [] : askFirst.filter((r) => always.has(ruleKey(r) ?? ''));
  return { ask: askFirst.filter((r) => !allow.includes(r)), allow };
}

/** A glob as a regex: `**` any path, `*` any part of one, `?` one character. */
function globRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The line itself and each command in it (split on && || ; | & and line breaks), without leading VAR=value assignments. */
function commandsOf(line: string): string[] {
  const parts = [line, ...line.split(/&&|\|\||[;|&\n]/)].map((p) => p.trim().replace(/^(?:\w+=\S*\s+)+/, '').trim());
  return [...new Set(parts.filter(Boolean))];
}

function bashMatches(spec: string, command: string): boolean {
  const commands = commandsOf(command);
  // Prefix rules, Claude Code's `:*` form: `git push:*`.
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return commands.some((c) => c.startsWith(prefix));
  }
  if (spec.includes('*')) {
    // `*` is anything (slashes too), and `git push *` also matches a bare `git push`.
    const body = spec
      .trim()
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const re = new RegExp(`^${body.endsWith(' .*') ? `${body.slice(0, -3)}(?: .*)?` : body}$`, 's');
    return commands.some((c) => re.test(c));
  }
  return commands.some((c) => c === spec.trim());
}

/** A path rule as an absolute glob: `//abs`, `~/home`, else relative to the working folder. */
function pathGlob(spec: string, ctx: { cwd: string; home: string }): string {
  if (spec.startsWith('//')) return spec.slice(1);
  if (spec.startsWith('~/')) return join(ctx.home, spec.slice(2));
  if (spec.startsWith('/')) return join(ctx.cwd, spec.slice(1));
  return join(ctx.cwd, spec.replace(/^\.\//, ''));
}

function pathMatches(spec: string, file: string, ctx: { cwd: string; home: string }): boolean {
  const abs = isAbsolute(file) ? resolve(file) : resolve(ctx.cwd, file);
  const glob = pathGlob(spec, ctx);
  // `dir` alone covers what is in it too.
  return globRegex(glob).test(abs) || (!/[*?]/.test(glob) && abs.startsWith(`${glob.replace(/\/$/, '')}/`));
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function covers(rule: string, toolName: string, input: Record<string, unknown>, ctx: { cwd: string; home: string }): boolean {
  const m = RULE.exec(rule);
  if (!m) return false;
  const [, name, spec] = m;
  if (name.startsWith('mcp__')) {
    // `mcp__server`, `mcp__server__*` and `mcp__server__tool` (an MCP rule has no specifier).
    const base = name.replace(/(?:__)?\*$/, '');
    return toolName === base || toolName.startsWith(`${base}__`);
  }
  if (spec === undefined || spec === '*') return name === toolName || (name === 'Edit' && EDIT_TOOLS.has(toolName)) || (name === 'Read' && READ_TOOLS.has(toolName));
  if (name === 'Bash') return toolName === 'Bash' && bashMatches(spec, str(input.command));
  if (name === 'Edit' || name === 'Read') {
    const tools = name === 'Edit' ? EDIT_TOOLS : READ_TOOLS;
    if (!tools.has(toolName)) return false;
    const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
    // No path (a search of the working folder): ask rather than miss it.
    return !file || pathMatches(spec, file, ctx);
  }
  if (name === 'WebFetch' && spec.startsWith('domain:')) {
    if (toolName !== 'WebFetch') return false;
    const domain = spec.slice(7).toLowerCase();
    try {
      const host = new URL(str(input.url)).hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return true;
    }
  }
  // A specifier this doesn't know: any call of the tool.
  return name === toolName;
}

/** The first of `rules` that covers a tool call, or null. `ctx` resolves path rules. */
export function matchRule(rules: string[], toolName: string, input: unknown, ctx: { cwd: string; home: string }): string | null {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return rules.find((r) => covers(r, toolName, args, ctx)) ?? null;
}

/**
 * Identifies exactly the call the owner approves, so only that same call is allowed: every argument, in any key
 * order. Only Bash's description is left out, since Claude Code defines it as the model's words about the command;
 * any other tool's description (an MCP tool's, say) may be what the call does.
 */
export function callKey(toolName: string, input: unknown): string {
  const args: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : { value: input };
  if (toolName === 'Bash') delete args.description;
  return JSON.stringify([toolName, sortKeys(args)]);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** A tool call's card, made from the call itself, never from what the Boton says about it. */
export function describeCall(toolName: string, input: unknown): { title: string; details: string } {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  let title = mcp ? `Use ${mcp[2]} (${mcp[1]})` : `Use ${toolName}`;
  let details = JSON.stringify(input ?? {}, null, 2);
  if (toolName === 'Bash') {
    title = `Run \`${str(args.command).replace(/\s+/g, ' ').trim()}\``;
    details = str(args.command);
  } else if (EDIT_TOOLS.has(toolName)) title = `${toolName === 'Write' ? 'Write' : 'Edit'} ${str(args.file_path) || str(args.notebook_path) || 'a file'}`;
  else if (toolName === 'Read') title = `Read ${str(args.file_path) || 'a file'}`;
  else if (toolName === 'WebFetch') title = `Fetch ${str(args.url) || 'a web page'}`;
  return { title: truncate(title, 200), details };
}
