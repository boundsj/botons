// What the owner is told about each brain: whether it is ready, why not, what to do on the server, and what happens
// to its Botons' work meanwhile. Only from the server's fixed words (BrainReadiness), never the CLI's own output.
import type { ApiKeyState, Bot, BrainReadiness, ProviderInfo } from '../../shared/types.ts';
import { dateTime, relative } from './util.ts';

export type BrainTone = 'ok' | 'warn' | 'bad' | 'unknown';

export interface BrainView {
  /** A few words: "Ready", "Not signed in"… */
  status: string;
  tone: BrainTone;
  /** Why it isn't ready, in plain words; null when it is. */
  why: string | null;
  /** What the owner does on the server; `command` is run there, as the user Botons runs as. */
  fix: { text: string; command: string | null } | null;
  /** What happens meanwhile to the work of Botons on it. */
  work: string | null;
}

/** The command the CLI of `id` is, for the owner's instructions; null for a brain that isn't a CLI. */
function cliName(id: string): string | null {
  if (id === 'claude-cli') return 'claude';
  if (id === 'codex-cli') return 'codex';
  return null;
}

/** How to sign each CLI in on the server's machine. Botons never does it for you. */
export function loginCommand(id: string, container: boolean): string | null {
  const run = container ? 'docker compose exec -it botons botons' : 'botons';
  if (id === 'claude-cli') return `${run} login claude`;
  if (id === 'codex-cli') return `${run} login codex`;
  return null;
}

/** The CLI's own read-only status command, to see what it says when the check couldn't tell. */
function statusCommand(id: string, container: boolean): string | null {
  const run = container ? 'docker compose exec botons ' : '';
  if (id === 'claude-cli') return `${run}claude auth status`;
  if (id === 'codex-cli') return `${run}codex login status`;
  return null;
}

const binVar = (id: string) => (id === 'claude-cli' ? 'BOTONS_CLAUDE_BIN' : id === 'codex-cli' ? 'BOTONS_CODEX_BIN' : null);

const FAILS = "Its Botons' turns are still tried, and fail until it is ready: a message gets an error, a routine run fails (it isn't held for later).";

/** Its usage limit, while it holds its turns at `now`; null once it has reset (or never hit one). */
function activeHold(r: BrainReadiness, now: number): string | null {
  return r.usageLimitUntil && Date.parse(r.usageLimitUntil) > now ? r.usageLimitUntil : null;
}

/**
 * The work of a brain that is down and also held by a usage limit: held, not failing, until the reset; then tried, and
 * failing until the owner fixes it. Paused Botons wait for their resume either way.
 */
const heldThenFails = (until: string) =>
  `Its turns also hit a usage limit, so its Botons' messages and routine runs wait until it resets ${dateTime(until)}. Then they are tried, and fail until it is ready: the reset doesn't fix this. A paused Boton waits until you resume it.`;

/** What the owner is told about `p`, from its readiness. */
export function brainView(p: ProviderInfo, opts: { container: boolean; now?: number }): BrainView {
  const r = p.readiness;
  const cli = cliName(p.id);
  const cmd = cli ? `\`${cli}\`` : p.label;
  const recheck = { text: 'Check again.', command: null };
  const hold = activeHold(r, opts.now ?? Date.now());
  const downWork = hold ? heldThenFails(hold) : FAILS;
  switch (r.state) {
    case 'ready':
      return { status: 'Ready', tone: 'ok', why: null, fix: null, work: null };
    case 'usage-limited':
      // The answer is from before the reset: what it is now takes a new look.
      if (!hold && r.usageLimitUntil) {
        return {
          status: 'Usage limit reset',
          tone: 'unknown',
          why: `Its usage limit reset ${dateTime(r.usageLimitUntil)}; whether it is ready now isn't shown yet.`,
          fix: recheck,
          work: "Its Botons' held messages and routine runs are tried again, unless paused (resume first).",
        };
      }
      return {
        status: 'Out of usage',
        tone: 'warn',
        why: r.usageLimitUntil ? `Its turns hit a usage limit; it resets ${dateTime(r.usageLimitUntil)}.` : 'Its turns hit a usage limit.',
        fix: null,
        work: "Its Botons' messages and routine runs wait, and carry on by themselves when it resets, unless paused (resume first).",
      };
    case 'signed-out': {
      // An API key brain: "signed out" is no key.
      if (p.kind === 'api' && p.id !== 'mock') return { status: 'No key', tone: 'bad', why: p.reason ?? 'There is no API key for it.', fix: { text: 'Save a key in Settings → API keys.', command: null }, work: downWork };
      const login = loginCommand(p.id, opts.container);
      return {
        status: 'Not signed in',
        tone: 'bad',
        why: `${cmd} is installed but signed out.`,
        fix: login ? { text: 'Sign it in on the server, as the user Botons runs as, then check again. Botons never signs in for you.', command: login } : recheck,
        work: downWork,
      };
    }
    case 'not-installed': {
      const bin = binVar(p.id);
      return {
        status: 'Not installed',
        tone: 'bad',
        why: `The server can't find ${cmd}.`,
        fix: opts.container
          ? { text: 'The image comes with it: rebuild and restart the container, then check again.', command: 'docker compose up -d --build' }
          : {
              text: `Install it for the user Botons runs as, and make sure the server finds it: on its PATH, or with ${bin ? `\`${bin}\`` : 'its path setting'} (the systemd service reads both from its env file, \`~/.config/botons/env\`). Then restart the server and check again.`,
              command: null,
            },
        work: downWork,
      };
    }
    case 'unavailable':
      if (r.problem === 'incompatible-version') return {
        status: 'Upgrade needed', tone: 'bad',
        why: 'Botons requires stable Codex 0.166.0 or newer. Older bubblewrap helpers can fail on protected missing paths with Bad file descriptor.',
        fix: opts.container
          ? { text: 'Set BOTONS_CODEX_VERSION (the image CODEX_VERSION build argument) to a compatible stable version before rebuilding. Keep Workspace sandboxing enabled, then Check again.', command: 'docker compose up -d --build' }
          : { text: 'Open Settings → Brains for the reviewed upgrade action. For npm installs, upgrade with the permissions used to install Codex. Run codex --version as the server user; if BOTONS_CODEX_BIN is set, run that executable with --version instead. Then Check again. Keep Workspace sandboxing enabled.', command: 'npm install -g @openai/codex@latest' },
        work: downWork,
      };
      return {
        status: "Can't run",
        tone: 'bad',
        why:
          r.problem === 'not-runnable'
            ? `${cmd} is there but couldn't be started (permissions, say).`
            : r.problem === 'version-failed'
              ? `${cmd} is there but \`${cli ?? 'its'} --version\` failed.`
              : `${p.label} can't run turns on this server.`,
        fix: { text: 'Check that it runs for the user Botons runs as (the doctor on the server shows more), then check again.', command: null },
        work: downWork,
      };
    case 'unknown':
      // A brain the server never checks (no CLI to ask): check again would change nothing.
      if (r.problem === 'not-checked' && p.kind !== 'cli') return { status: 'Not checked', tone: 'unknown', why: 'The server doesn’t check this brain: its turns show whether it works.', fix: null, work: null };
      // An API key brain is checked only when its key is tested (no CLI to ask again).
      if (p.kind === 'api' && p.id !== 'mock')
        return { status: 'Key not tested lately', tone: 'unknown', why: 'Its key was last tested a while ago: its turns show whether it works.', fix: { text: 'Test key in Settings → API keys.', command: null }, work: null };
      return { status: unknownStatus(r), tone: 'unknown', why: unknownWhy(r, opts.now), fix: unknownFix(p.id, r, opts.container), work: unknownWork(r) };
  }
}

function unknownStatus(r: BrainReadiness): string {
  if (r.problem === 'not-checked') return 'Not checked yet';
  if (r.problem === 'outdated') return 'Not checked lately';
  if (r.problem === 'clock-changed') return 'Check needs redoing';
  return 'Sign-in unconfirmed';
}

function unknownWhy(r: BrainReadiness, now?: number): string {
  switch (r.problem) {
    case 'not-checked':
      return 'The server hasn’t checked it yet.';
    case 'outdated':
      return `Its last check was ${relative(r.checkedAt, now)}, too long ago to go by.`;
    case 'clock-changed':
      return 'The server’s clock was set back since its last check, so how old that check is can’t be told.';
    case 'timed-out':
      return 'It didn’t answer the server’s check in time, so whether it is signed in isn’t known.';
    default:
      return 'It is installed, but the server couldn’t read whether it is signed in.';
  }
}

function unknownFix(id: string, r: BrainReadiness, container: boolean): BrainView['fix'] {
  const status = statusCommand(id, container);
  if (r.problem === 'not-checked' || r.problem === 'outdated' || r.problem === 'clock-changed' || !status) return { text: 'Check again.', command: null };
  return { text: 'Check again. If it stays unconfirmed, see what the CLI itself says on the server:', command: status };
}

function unknownWork(r: BrainReadiness): string | null {
  if (r.problem === 'not-checked' || r.problem === 'outdated' || r.problem === 'clock-changed') return null;
  return "Its Botons' turns are tried as usual: if it can't run them, they fail with its error.";
}

/** "Claude Code" of "Claude Code (local CLI)". */
export const shortLabel = (p: Pick<ProviderInfo, 'label'>) => p.label.replace(/ \(.*\)$/, '');

/**
 * Why a Boton on `p` can't think now, for drawing it asleep and saying so: no working brain (missing, signed out,
 * broken), or a usage limit that resets by itself. null when it can, or may (unknown).
 */
export type BrainRest = { kind: 'none' } | { kind: 'limited'; until: string | null };
export function brainRest(p: ProviderInfo | undefined): BrainRest | null {
  if (!p) return { kind: 'none' };
  if (p.readiness.state === 'usage-limited') return { kind: 'limited', until: p.readiness.usageLimitUntil };
  return brainDown(p) ? { kind: 'none' } : null;
}

/** The words for a resting Boton, short enough for a sidebar row. */
export const restText = (r: BrainRest) => (r.kind === 'limited' ? 'At its usage limit' : 'No working brain');

/** Not ready, in a way its Botons' work can't get past by itself (unknown is not this: it may well work). */
export function brainDown(p: ProviderInfo): boolean {
  return p.readiness.state !== 'ready' && p.readiness.state !== 'unknown';
}

/** The brains a Boton on `p` could move to now: confirmed ready (the mock provider aside). */
export function readyInstead(p: ProviderInfo, all: ProviderInfo[]): ProviderInfo[] {
  return all.filter((o) => o.id !== p.id && o.id !== 'mock' && o.readiness.state === 'ready');
}

/** The Botons on `id`, with the paused ones (or all, when every Boton is paused) said so. */
export function botonsOn(id: string, bots: Bot[], allPaused: boolean): { count: number; text: string } {
  const on = bots.filter((b) => b.provider === id);
  if (!on.length) return { count: 0, text: 'No Boton uses it.' };
  const names = on.slice(0, 5).map((b) => `${b.name}${b.paused && !allPaused ? ' (paused)' : ''}`);
  const more = on.length > names.length ? ` and ${on.length - names.length} more` : '';
  return { count: on.length, text: `Used by ${names.join(', ')}${more}${allPaused ? ' (all Botons are paused)' : ''}.` };
}

/**
 * What to keep of two answers about the brains: per brain, of two from the same run of the server (its boot) the one
 * from the newer check (its generation), and otherwise the later request's (`newer`), so a slow answer can't put back
 * what a later one replaced. Runs aren't ordered by anything but the requests: a restarted server counts from 0.
 */
export function mergeProviders(prev: ProviderInfo[], next: ProviderInfo[], newer: boolean): ProviderInfo[] {
  return next.map((p) => {
    const old = prev.find((o) => o.id === p.id);
    if (!old?.readiness) return p;
    if (old.readiness.boot !== p.readiness.boot) return newer ? p : old;
    const [a, b] = [old.readiness.generation, p.readiness.generation];
    return b > a || (b === a && newer) ? p : old;
  });
}

/** Which check an answer about a brain comes from: the same for two answers only when they are from one check. */
export const checkOf = (p: ProviderInfo) => `${p.readiness.boot}:${p.readiness.generation}`;

/** A browser sign-in that just succeeded (waiting, then finished): the subscription panel folds back to its one ready line. */
export function signInFinished(prev: string | undefined, next: string | undefined): boolean {
  return prev === 'waiting' && next === 'finished';
}

/** The brains Settings → Brains lists, in the owner's words: each CLI subscription and each API key. */
export const BRAIN_ROWS = [
  { id: 'claude-cli', name: 'Claude subscription', blurb: 'Sign in with your Claude plan.', key: null },
  { id: 'codex-cli', name: 'ChatGPT subscription (Codex)', blurb: 'Sign in with your ChatGPT plan.', key: null },
  { id: 'anthropic-api', name: 'Anthropic API key', blurb: 'Pay per use, with an optional daily cap per Boton.', key: 'anthropic' },
  { id: 'openai-api', name: 'OpenAI API key', blurb: 'Pay per use, with an optional daily cap per Boton.', key: 'openai' },
] as const;

/** The Botons whose own settings pick brain `id`, in the sidebar's order. */
export function brainUsers(id: string, bots: Bot[]): Bot[] {
  return bots.filter((b) => b.provider === id);
}

/** "Used by Kevin, Stuart (paused)", or "No Botons yet". */
export function usedByText(users: Pick<Bot, 'name' | 'paused'>[]): string {
  return users.length ? `Used by ${users.map((b) => `${b.name}${b.paused ? ' (paused)' : ''}`).join(', ')}` : 'No Botons yet';
}

/**
 * Whether the owner has set brain `p` up: a CLI that is installed and signed in (whatever it can do right now), an API
 * key saved or in the server's environment. Being set up is not being ready: a signed-in CLI may be out of usage.
 */
export function brainSetUp(p: ProviderInfo | undefined, key: Pick<ApiKeyState, 'source'> | undefined): boolean {
  if (key) return key.source !== 'none';
  if (!p) return false;
  return p.readiness.state !== 'signed-out' && p.readiness.state !== 'not-installed';
}

/** Dollars of Botons' own estimate: cents, or more places under a cent. */
export const usd = (v: number) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
