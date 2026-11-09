import { randomBytes } from 'node:crypto';
import { browserSearchPaths } from './browser-paths.ts';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AccessLevel,
  BrowserActionInput,
  BrowserActionName,
  BrowserActionResult,
  BrowserControl,
  BrowserHandover,
  BrowserHandoverInput,
  BrowserHandoverResult,
  BrowserHandoverStart,
  HandoverNotice,
  BrowserJournalEntry,
  BrowserPolicy,
  BrowserPolicyInput,
  BrowserStatus,
} from '../../shared/types.ts';
import { BROWSER_CONNECTOR, BROWSER_SERVER } from '../../shared/util.ts';
import type { Approvals, BrowserHolds } from './approvals.ts';
import { type Audit, SYSTEM_ACTOR } from './audit.ts';
import type { Principal } from './auth.ts';
import { interceptCert } from './browser-cert.ts';
import { fitViewport, FRAME_MIN_MS, IDLE_MS, INPUT_WINDOW_MS, INTENT_MS, MAX_COPY, MAX_HANDOVER_MS, MAX_INPUTS, parseOwnerInput, pressed, RateWindow, VIEWPORT } from './browser-handover.ts';
import type { BrowserHandoffs } from './browser-handoff.ts';
import { applyPolicy, displayUrl, effectiveSites, judgeRequest, parsePolicy, portOf } from './browser-policy.ts';
import { type BrowserProxy, type ProxyPolicy, startBrowserProxy } from './browser-proxy.ts';
import { type Binding, describeRequest, type FieldInfo, fingerprint, type HeldRequest, heldCookies, sameRequest, shown, staleCookies, typingProblem, wireHeaders } from './browser-request.ts';
import { screenshotToChat, type ShareFile } from './browser-screenshot.ts';
import { sendHeld } from './browser-send.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import type { TurnMcpServer } from './providers/types.ts';
import { HttpError, type Store } from './store.ts';

/*
 * The managed browser: one Chromium profile per Boton, run by the server, never by the Boton. It reaches the
 * Boton's turns as a Botons-managed connector (BROWSER_CONNECTOR, `botons browser-mcp`, the same for Claude and
 * Codex): the owner turns it on by giving the Boton that connector, and lists the sites it may load.
 *
 * Opening and reading a page loads what the page loads: GET and HEAD requests to the allowed sites, as any browser
 * would (a site can act on a GET too, so that is all it is: site-bound, not proof that nothing changes). Acting on a
 * page is what the owner's cards are for. The Boton clicks and types into the controls a read listed (never into a
 * password, code or card field), and nothing it does runs its own script in a page or reads cookies or files. A click
 * on a link to an allowed site opens that address, as open would, without running the page's script. Any other click
 * or typing marks the page as acted on, and from then on nothing it sends leaves on its own, whatever the method:
 * while the step runs, the first request it makes (a form before a script's request) waits on a card that shows that
 * exact request (method, full address, every field, its cookies by name) and is bound to its fingerprint, the turn,
 * this browser and the page's document. Its cookies must be ones the browser held for that address while the step ran
 * (a site's own cookies change as it works, and that is fine; one the browser never held means no card), and it goes
 * with exactly those, as held; every other request it makes, then or later (a
 * timer, a poll, a beacon as it unloads), is refused. Allowed, the card's request is sent once by browser-send.ts,
 * exactly as held, with no cookie added, through the proxy, with no redirect that would send it again; denied,
 * withdrawn, or not decided while the step waits, it never leaves. Opening an address or going back from a page
 * acted on ends that whole browser (its Chromium, and its proxy, sealed until it closes) and starts another on the
 * same profile with the same cookies, so nothing the old page had under way (an unload's beacon, a keepalive fetch)
 * can go: not on a timer's guess that it has arrived, but because the process that held it and the proxy it could
 * reach are gone. Labels are the site's text, never a reason.
 *
 * What holds whatever the Boton or a page does:
 * - It runs only inside a turn that was given it, for that turn's token, and closes when the turn ends; taking the
 *   connector away (Stop, or unchecking it) closes it at once. Webhook runs get no connectors, so no browser.
 * - Every request goes through the server's proxy (browser-proxy.ts), which allows only the owner's sites and, for a
 *   name, only public addresses it resolves to; routing refuses anything but GET and HEAD before it leaves Chromium,
 *   and everything from a page acted on (but for the one request a card holds), and WebSockets never connect. Changing the sites cuts tunnels, and plain HTTP responses still arriving, to a site
 *   no longer listed.
 * - Chromium's own sandbox is on (in Docker, compose.yaml's seccomp profile lets it start; BOTONS_BROWSER_SANDBOX=0
 *   is the owner's last resort where a host still can't). Downloads and file pickers are refused, other tabs
 *   closed, dialogs dismissed, service workers blocked.
 * - What a page says comes back marked as the site's text, never as the owner's words.
 * - The owner can take the browser over (takeOver, to sign it in, say): from then until the owner finishes, the
 *   Boton's tools are refused and its browser is closed, and another Chromium runs for the owner alone, driven only
 *   by fixed inputs from the one paired device that took it over (browser-handover.ts says what that browser may
 *   send). It runs on a profile of its own, made for the handover with the Boton's cookies and deleted when it ends
 *   (and at start, if the server stopped without ending it), so nothing Chromium keeps of what the owner typed (a
 *   session's form values, its history) outlives the handover or reaches a backup. Only the cookies come back: into
 *   the Boton's profile, and in memory (#carry, until the server stops) for session ones, so the Boton's next
 *   browser is signed in as the owner left it.
 * - Each step goes to the Boton's browser journal (origin and path only), which the owner can read. A step that
 *   fails says so in Botons' own words (failureOf): Playwright's and Chromium's messages carry the full address, query
 *   included, and whatever else the site put there, so none of their text reaches a result, the journal or the log.
 */

const ACTIONS: BrowserActionName[] = ['open', 'read', 'back', 'screenshot', 'click', 'type', 'handoff'];
const MAX_TEXT = 20_000;
const MAX_LINKS = 100;
const MAX_CONTROLS = 150;
const MAX_TYPED = 2000;
/** After a click or typing, how long a request the page sends because of it is still held for a card. */
const SETTLE_MS = 1500;
/** Once a script's request is held, how much longer a form the same step submits may take its place. */
const FORM_GRACE_MS = 300;
/** What read lists as controls, and click and type find again by their place in this list. */
const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"]';
const ACTION_TIMEOUT_MS = 30_000;
/** Why a handover ended, for the journal, the log and the audit. */
export type HandoverEnd = 'finished' | 'stopped' | 'connector' | 'idle' | 'revoked' | 'closed' | 'failed' | 'shutdown' | 'deleted';
const HANDOVER_ENDS: Record<HandoverEnd, string> = {
  finished: 'finished',
  stopped: 'stopped with the kill switch',
  connector: 'the browser connector was taken away',
  idle: 'nothing was sent for too long, or it reached its time limit',
  revoked: 'the device that drove it was revoked',
  closed: 'its browser closed',
  failed: 'its browser did not start',
  shutdown: 'the server is stopping',
  deleted: 'the Boton was deleted',
};
/** The most of an allowed request's answer that is passed to the page. */
const ANSWER_MAX = 20 * 1024 * 1024;
const JOURNAL_KEEP = 2000;
const DEFAULT_PATHS = browserSearchPaths();
export const CAPABILITY =
  "Opens pages on the listed sites (loading them as any browser does, with GET requests), reads their text, links and controls, goes back, takes screenshots, clicks and types (never into password, code or card fields). Once it clicks or types on a page, nothing that page sends goes without your card: the request it makes (a form, a POST, or a GET) waits on a card that shows exactly that request, sent once only if you allow it while the Boton's step waits, and anything else the page sends is refused. It never signs in itself: when a step is yours (a sign-in, a code, a captcha), it asks in the chat and you tap Take over to do it in its browser (it can't use the browser until you hand it back, and keeps the sign-in after). It does not download or upload.";
const DESKTOP_WHY =
  "Botons doesn't control this computer's screen, mouse or keyboard: Botons work in their own managed browser instead, which needs no display.";

/**
 * Why a step failed, from a fixed set of Botons' own words: never the error's text, which names the full address
 * (with its query) and can carry what a site sent. Chromium's net:: codes are matched only to pick the words.
 */
export function failureOf(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  const text = typeof e?.message === 'string' ? e.message : '';
  if (name === 'TimeoutError' || /\bTimeout \d+ms exceeded\b/.test(text)) return `it took longer than ${ACTION_TIMEOUT_MS / 1000} seconds`;
  const code = /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(text)?.[1] ?? '';
  if (/^[^\n]*\bDownload is starting\b/.test(text)) return 'it is a download, which the browser refuses';
  if (code === 'ERR_BLOCKED_BY_CLIENT') return 'it led to an address the browser may not load (a site not listed, or not a read)';
  if (code === 'ERR_NAME_NOT_RESOLVED') return "the site's name could not be found";
  if (code === 'ERR_ABORTED') return 'loading stopped before the page arrived (a download, or another page opened instead)';
  if (code === 'ERR_TOO_MANY_REDIRECTS') return 'the site redirected too many times';
  if (code.startsWith('ERR_CERT_') || code.startsWith('ERR_SSL_')) return "the site's certificate was not accepted";
  if (/^ERR_(CONNECTION|TUNNEL|PROXY|ADDRESS|NETWORK|INTERNET|EMPTY_RESPONSE|TIMED_OUT)/.test(code)) return 'the site could not be reached';
  if (/Target (page, context or browser )?(has been )?closed|Browser has been closed/i.test(text)) return 'the browser closed';
  return 'the browser could not finish it';
}

const hostOfUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** The page's main navigation as it ended (after any redirect): its last request, and how it ended. */
export interface Navigation {
  url: string;
  /** It failed in Chromium (an error, no response). */
  failed: boolean;
  /** The response's x-botons-proxy header, if it had one. */
  mark: string | null;
  /** That last request: a block by the browser's routing is matched to it exactly. */
  request: object | null;
}

/**
 * What Botons said of the page's own navigation, in the words the Boton is shown: its block ("Blocked by Botons: ..."), or
 * its site not found or not reached (never called a block). Null when it was the site's own answer, or when Botons said
 * nothing of it. Matched to where the navigation ended, so a redirect is judged by its destination. Provenance never
 * rests on what a site can send: a block by the routing is that request's own; the proxy's mark counts on HTTP and
 * HTTPS alike, since every request of this browser is answered by its proxy (its HTTPS ends there too), which takes
 * the mark off every site's response; and a block of another request (a POST the page made) never stands for the
 * navigation.
 */
export function navigationAnswer(nav: Navigation, s: Pick<Session, 'blocked' | 'unreachable'>): string | null {
  const routed = nav.request ? s.blocked.findLast((b) => b.request === nav.request) : undefined;
  if (routed) return `Blocked by Botons: ${routed.why}.`;
  const kind = nav.failed ? 'error' : /^https?:/.test(originOf(nav.url)) ? nav.mark : null;
  if (kind !== 'error' && kind !== 'blocked' && kind !== 'unreachable') return null;
  const origin = originOf(nav.url);
  const failed = kind !== 'blocked' && s.unreachable.findLast((u) => originOf(u.url) === origin);
  if (failed) return failed.message;
  const blocked = kind !== 'unreachable' && s.blocked.findLast((b) => !b.request && originOf(b.url) === origin);
  if (blocked) return `Blocked by Botons: ${blocked.why}.`;
  // The proxy's own answer, its record of it already full: said as what it was.
  if (kind === 'blocked') return 'Blocked by Botons.';
  if (kind === 'unreachable') return `Couldn\u2019t connect to ${hostOfUrl(nav.url)}.`;
  return null;
}

/**
 * The browser's own user agent with only its headless mark taken out (HeadlessChrome/... becomes Chrome/...): the real
 * version and platform stay as the running Chromium reports them. Some sites refuse any agent that says it is headless.
 */
export function withoutHeadless(userAgent: string): string {
  return userAgent.replace(/\bHeadlessChrome\//, 'Chrome/');
}

export type Playwright = typeof import('playwright-core');
type Context = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;
type Cookie = Awaited<ReturnType<Context['cookies']>>[number];

type Route = import('playwright-core').Route;
type Request = import('playwright-core').Request;

/** A control a read listed: what the page said of it (its label is the site's text), found again by `index`. */
interface Control extends FieldInfo {
  index: number;
  kind: BrowserControl['kind'];
  /** A link's address (else empty). */
  href: string;
}

/** A click or typing in progress: while `open`, the first request of the page (to an allowed site) is held here, not refused. */
interface Op {
  open: boolean;
  /** The whole cookie jar as the step began (null if it could not be read): the one every later read must equal. */
  cookies: Cookie[] | null;
  held: { route: Route; request: Request; rank: number } | null;
  onHeld: () => void;
}

/** Which request a card is for when a step makes several: a navigation (a form), then a script's, then anything else. */
const rankOf = (r: Request) => (r.isNavigationRequest() ? 3 : ['fetch', 'xhr', 'eventsource', 'ping'].includes(r.resourceType()) ? 2 : 1);

interface Session {
  context: Context;
  page: Page;
  proxy: BrowserProxy;
  /** What was refused in this step: by the proxy, or by the browser's routing (with that request). */
  blocked: { url: string; why: string; request?: object }[];
  /** Sites the proxy could not reach in this step (not found, no address answered): never Botons refusing them. */
  unreachable: { url: string; host: string; message: string }[];
  /** New each time Chromium starts: a card made for one browser never applies to the next. */
  id: string;
  /** The page's document: one more each time its main frame navigates, so refs and cards from before no longer apply. */
  revision: number;
  /** The controls the last read listed, and for which document. */
  controls: { revision: number; list: Control[] } | null;
  op: Op | null;
  /** The page was clicked or typed on: nothing it sends leaves without a card any more (a new browser ends that). */
  actedOn: boolean;
  /** Some page of this browser was acted on: a request no page can be named for (a worker's) is refused from then on. */
  everActed: boolean;
  /** The main frame's addresses, for back from a page acted on (which opens the one before in a new browser). */
  trail: string[];
  /** Ends the wait of the card holding a request (the browser is closing). */
  endWait: (() => void) | null;
  /** Cuts the send of an allowed request (the browser is closing). */
  sending: AbortController | null;
  closed: boolean;
}

/** The owner's browser in a handover: run for the owner alone, never reached by the Boton. */
interface OwnerSession {
  context: Context;
  page: Page;
  proxy: BrowserProxy;
  /** The server's own DevTools session on that page, for the live view and a copy: never the owner's or the page's. */
  cdp: import('playwright-core').CDPSession | null;
}

const sameHost = (a: string, b: string) => {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
};

/** Where the live view goes: the driving device's open stream. */
export interface HandoverSink {
  /** One frame (JPEG) of the page at `width` × `height` CSS pixels; resolves once it has gone, so frames never pile up. */
  frame(jpeg: Buffer, width: number, height: number): Promise<void>;
  notice(n: HandoverNotice): void;
  end(): void;
}

/** In a world of the server's own (the page's script can't reach it): the owner's selection, never a password field's. */
const COPY_SELECTION = `(() => {
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
    if (a instanceof HTMLInputElement && a.type === 'password') return '';
    try { return a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? 0); } catch { return ''; }
  }
  return String(document.getSelection() ?? '');
})()`;
/** In the same world: whether what has focus takes text. Only true or false. */
const FOCUS_TAKES_TEXT = `(() => {
  const a = document.activeElement;
  if (!a) return false;
  if (a instanceof HTMLIFrameElement) return true;
  if (a instanceof HTMLElement && a.isContentEditable) return true;
  if (a instanceof HTMLTextAreaElement) return !a.readOnly && !a.disabled;
  if (a instanceof HTMLInputElement) return !a.readOnly && !a.disabled && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(a.type);
  return false;
})()`;

/** A handover: from takeOver until giveBack, the Boton's browser is the owner's. */
interface Handover {
  id: string;
  /** The device that took it over: the only one that gets frames and sends input. */
  deviceId: string | null;
  deviceLabel: string;
  startedAt: number;
  /** The owner's last input or frame (for the idle limit). */
  lastActive: number;
  /** The owner's last click, key or typing: what the page sends within INTENT_MS of it may go. */
  lastIntent: number;
  session: Promise<OwnerSession>;
  /** Its page once open, and that page's title as last read. */
  view: Page | null;
  title: string;
  ended: boolean;
  ending: Promise<void> | null;
  timer: NodeJS.Timeout | null;
  /** The owner's inputs, one at a time and in order. */
  queue: Promise<unknown>;
  framing: boolean;
  lastFrame: number;
  inputs: RateWindow;
  /** The page's size (CSS pixels), following the owner's view. */
  viewport: { width: number; height: number };
  /** The live view's stream, while one is open (one at a time, the driving device's). */
  sink: HandoverSink | null;
  /** Stops the screencast to `sink`. */
  stopCast: (() => Promise<void>) | null;
  /** The Boton's page to go back to (in full), if it handed over from one: opened only when the owner asks (resume). */
  resume: string | null;
  /** Run once it has ended (stops watching the device for revocation). */
  onEnd: (() => void)[];
  /** Its browser's cookie jar as of the owner's last input: what comes back if that browser dies before it can be read. */
  jar: Cookie[] | null;
  /** It started with the Boton's whole jar: so its jar at the end is the whole jar, cookies it dropped included. */
  seeded: boolean;
}

export interface BrowserDeps {
  cfg: Config;
  store: Store;
  approvals: Approvals;
  /** Whether a brain can run the browser (drivesBrowser: a CLI provider). */
  usesConnectors: (provider: string) => boolean;
  /** The Boton's access in its running turn, if any. */
  turnAccess: (botId: string) => AccessLevel | null;
  share: ShareFile;
  /** The audit log, for a handover's start and end. */
  audit?: Audit;
  /** Calls `close` when the principal's device is revoked; returns how to stop watching. */
  trackDevice?: (principal: Principal | null, close: () => void) => () => void;
  /** The handoff cards in the chat (browser-handoff.ts): told when the owner takes the browser over and when that ends. */
  handoffs?: BrowserHandoffs;
}

export interface Availability {
  available: boolean;
  why: string | null;
  executable: string | null;
}

export class Browser implements BrowserHolds {
  #deps: BrowserDeps;
  /** Tests only: the certificate of their own HTTPS site, trusted by the browser's proxy and by the send of an allowed request. */
  testTrust: { cert: string; spki: string } | null = null;
  /** Tests only: the Boton's browser's cookies for `url` now (none without a browser). */
  async testCookies(botId: string, url: string): Promise<{ name: string; value: string }[]> {
    const s = await this.#sessions.get(botId)?.catch(() => null);
    return s ? s.context.cookies(url) : [];
  }
  /** Tests only: the Boton's browser's cookie jar, to change between the gates below (nothing outside tests sets this). */
  async testJar(botId: string): Promise<Context | null> {
    return (await this.#sessions.get(botId)?.catch(() => null))?.context ?? null;
  }
  /**
   * Tests only: awaited at fixed points of a click or typing, so a test can change the jar exactly there: `acting` once
   * the step's jar is read and before the page acts (so before Chromium writes any Cookie header), `held` once a held
   * request's headers are read and before the jar is read again, `card` once its card exists and waits.
   */
  testGate: ((at: 'acting' | 'held' | 'card', botId: string) => Promise<void>) | null = null;
  /** Tests only: shorter handover limits than INTENT_MS and IDLE_MS. */
  testHandover: { intentMs?: number; idleMs?: number } | null = null;
  /** Tests only: the owner's handover browser's cookie jar (null without one). */
  async testOwnerJar(botId: string): Promise<Context | null> {
    return (await this.#handovers.get(botId)?.session.catch(() => null))?.context ?? null;
  }
  /** Handovers under way, by Boton: while one is here, the Boton's browser is the owner's. */
  #handovers = new Map<string, Handover>();
  /** Each Boton's cookie jar as its last browser closed, put back when the next one opens (in memory only). */
  #carry = new Map<string, Cookie[]>();
  /**
   * Where a Boton's browser was when it handed over (browser_handoff), in full (its query too): in memory only, never in
   * a card, the journal or a log, so the owner's Open goes back to exactly that page (a sign-in's challenge lives in its
   * address). Gone once a handover ends.
   */
  #handoffPage = new Map<string, string>();
  /** Cards waiting on a request the browser holds, by approval id: how to wake the step that waits. */
  #waits = new Map<string, () => void>();
  readonly dir: string;
  #sessions = new Map<string, Promise<Session>>();
  /** The token of the turn that was given the browser, by Boton: only it may drive it. */
  #turns = new Map<string, string>();
  /** One action at a time per Boton. */
  #queues = new Map<string, Promise<unknown>>();
  #availability: Promise<Availability> | null = null;
  #probe: Promise<Availability> | null = null;
  #known: Availability | null = null;
  #closed = false;

  constructor(deps: BrowserDeps) {
    this.#deps = deps;
    this.dir = join(deps.cfg.home, 'browser');
    // Before any turn: privatePaths() lists the data folder's entries, so a Workspace Boton can't read the profiles.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // A handover's profile is never left behind: one still here is from a server that stopped without ending it.
    for (const name of readdirSync(this.dir)) this.#dropOwnerProfile(name);
  }

  /** Whether a step still waits on this card, holding its request (approvals.ts asks before taking a decision). */
  holds(approvalId: string): boolean {
    return this.#waits.has(approvalId);
  }

  /** The card was decided or withdrawn: the step that waits on it goes on. */
  decided(approvalId: string): void {
    this.#waits.get(approvalId)?.();
  }

  // ------------------------------------------------------------- settings

  #key = (botId: string) => `browser:${botId}`;

  policy(botId: string): BrowserPolicy {
    const row = this.#deps.store.db.prepare('select value from settings where key = ?').get(this.#key(botId)) as { value: string } | undefined;
    return parsePolicy(row?.value);
  }

  #access(botId: string): AccessLevel {
    const bot = this.#deps.store.getBot(botId);
    const turn = this.#deps.turnAccess(botId);
    return turn === 'workspace' || bot.access === 'workspace' ? 'workspace' : 'host';
  }

  /** The owner gave it the browser connector, and its brain can use connectors. */
  enabled(botId: string): boolean {
    if (this.#closed || !this.#deps.store.hasBot(botId)) return false;
    const bot = this.#deps.store.getBot(botId);
    return bot.connections.includes(BROWSER_CONNECTOR) && this.#deps.usesConnectors(bot.provider);
  }

  /** The sites enforced now: the saved ones within the Boton's access. */
  sites(botId: string): string[] {
    if (!this.#deps.store.hasBot(botId)) return [];
    return effectiveSites(this.policy(botId).sites, this.#access(botId), this.#deps.cfg.browser.allowPrivate);
  }

  /** What the proxy lets through: nothing unless it is on and a turn holds it. */
  #proxyPolicy(botId: string): ProxyPolicy {
    if (!this.enabled(botId) || !this.#turns.has(botId)) return { enabled: false, sites: [] };
    return { enabled: true, sites: this.sites(botId) };
  }

  async setPolicy(botId: string, input: BrowserPolicyInput): Promise<BrowserStatus> {
    const bot = this.#deps.store.getBot(botId);
    const next = applyPolicy(this.policy(botId), input, bot.access, this.#deps.cfg.browser.allowPrivate);
    this.#deps.store.db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(this.#key(botId), JSON.stringify(next));
    log.info('browser sites changed', { botId, sites: next.sites.length });
    await this.refresh(botId);
    return this.status(botId);
  }

  /** A new Boton's sites from a configuration file (portable.ts), checked like the owner's, inside the caller's transaction. */
  importSites(botId: string, sites: string[], access: AccessLevel): void {
    if (!sites.length) return;
    const next = applyPolicy({ sites: [], updatedAt: null }, { sites }, access, this.#deps.cfg.browser.allowPrivate);
    this.#deps.store.db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(this.#key(botId), JSON.stringify(next));
  }

  /**
   * After anything that changes what it may do (its connectors, access, brain or sites): closed if it lost the
   * browser, else tunnels to sites it may no longer reach are cut.
   */
  async refresh(botId: string, why = 'The browser connector was taken away: the browser is closed.', end: HandoverEnd = 'connector', by: Principal | null = null): Promise<void> {
    const h = this.#handovers.get(botId);
    if (!this.enabled(botId)) this.#deps.handoffs?.closeWaiting(botId, 'its browser was turned off');
    if (h && !this.enabled(botId)) await this.giveBack(botId, null, end, by);
    else if (h) (await h.session.catch(() => null))?.proxy.recheck();
    if (!this.#sessions.has(botId)) return;
    if (!this.enabled(botId)) {
      await this.#close(botId);
      this.#journal(botId, { action: 'stopped', url: '', outcome: 'done', detail: why });
      return;
    }
    const s = await this.#sessions.get(botId)!.catch(() => null);
    s?.proxy.recheck();
  }

  /** The Boton is gone: its browser, profile, journal and settings too. */
  async forget(botId: string): Promise<void> {
    this.#turns.delete(botId);
    await this.giveBack(botId, null, 'deleted');
    await this.#close(botId);
    this.#carry.delete(botId);
    this.#handoffPage.delete(botId);
    this.#deps.store.db.prepare('delete from settings where key = ?').run(this.#key(botId));
    rmSync(this.#botDir(botId), { recursive: true, force: true });
  }

  /**
   * Whether this server can run the browser: its library and a Chromium (cheap, at start), and with `probe`, that the
   * Chromium really starts the way turns start it (once; a container that can't start its sandbox fails here).
   */
  availability(probe = false): Promise<Availability> {
    if (probe) {
      this.#probe ??= this.availability().then(async (a) => {
        if (!a.available) return a;
        const pw = (await this.#playwright())!;
        try {
          const b = await pw.chromium.launch({ executablePath: a.executable!, headless: true, chromiumSandbox: this.#deps.cfg.browser.sandbox, timeout: ACTION_TIMEOUT_MS });
          await b.close();
          return a;
        } catch (err) {
          const lines = (err as Error).message.split('\n').map((l) => l.trim()).filter(Boolean);
          const first = lines.find((l) => /sandbox|namespace/i.test(l)) ?? lines[0] ?? '';
          const why = `${a.executable} did not start (${first.slice(0, 200)})${/sandbox|namespace/i.test(first) ? ": Chromium's sandbox can't start here (in a container, see Browser in docs/DOCKER.md)" : ''}.`;
          log.warn('the managed browser did not start', { why });
          const out = { available: false, why, executable: a.executable };
          this.#known = out;
          return out;
        }
      });
      return this.#probe;
    }
    this.#availability ??= findBrowser(this.#deps.cfg.browser.path).then((a) => {
      this.#known ??= a;
      return a;
    });
    return this.#availability;
  }

  /** What availability() last found, without waiting (null before it has looked). */
  get known(): Availability | null {
    return this.#known;
  }

  #headed(): boolean {
    return this.#deps.cfg.browser.headed && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }

  async status(botId: string, deviceId: string | null = null): Promise<BrowserStatus> {
    const bot = this.#deps.store.getBot(botId);
    const a = await this.availability(true);
    return {
      botId,
      connectorId: BROWSER_CONNECTOR,
      enabled: this.enabled(botId),
      policy: this.policy(botId),
      available: a.available,
      why: a.why,
      executable: a.executable,
      sandbox: this.#deps.cfg.browser.sandbox,
      headed: this.#headed(),
      running: this.#sessions.has(botId),
      workspace: bot.access === 'workspace',
      capability: CAPABILITY,
      desktop: DESKTOP_WHY,
      handover: this.handover(botId, deviceId),
    };
  }

  /** The connector's MCP server, which the engine gives the turn's API address and token. */
  server(): TurnMcpServer {
    return {
      name: BROWSER_SERVER,
      kind: 'stdio',
      command: process.execPath,
      args: ['--no-warnings', resolve(this.#deps.cfg.botonBinDir, '../src/cli/botons.ts'), 'browser-mcp'],
      env: {},
      // A click may wait for the owner's card: as long as an approval waits, and the send after.
      toolTimeoutSec: Math.ceil(this.#deps.cfg.approvalWaitMs / 1000) + 2 * (ACTION_TIMEOUT_MS / 1000) + 30,
    };
  }

  /** A turn that was given the browser starts: only its token drives it. */
  beginTurn(botId: string, tokenId: string): void {
    this.#turns.set(botId, tokenId);
  }

  /** That turn ended: its browser closes (the profile, with its cookies, stays). */
  async endTurn(botId: string, tokenId: string): Promise<void> {
    if (this.#turns.get(botId) !== tokenId) return;
    this.#turns.delete(botId);
    await this.#close(botId);
  }

  // ------------------------------------------------------------- journal

  #botDir = (botId: string) => join(this.dir, botId.replace(/[^A-Za-z0-9_-]/g, '_'));
  /** The owner's handover profile (and its Chromium's home), beside the Boton's: `browser/<boton>/handover`. */
  #ownerDir = (botId: string) => join(this.#botDir(botId), 'handover');

  /** Deletes a handover's profile, whole (its Chromium has exited). */
  #dropOwnerProfile(dirName: string): void {
    const dir = join(this.dir, dirName, 'handover');
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    if (existsSync(dir)) log.warn('could not delete a handover browser profile', { dir });
  }

  #journal(botId: string, e: Omit<BrowserJournalEntry, 'at'>): void {
    try {
      const dir = this.#botDir(botId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, 'journal.jsonl');
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...e, detail: e.detail.slice(0, 300) })}\n`, { mode: 0o600 });
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > JOURNAL_KEEP) writeFileSync(file, `${lines.slice(-JOURNAL_KEEP / 2).join('\n')}\n`, { mode: 0o600 });
    } catch (err) {
      log.warn('could not write to the browser journal', { botId, err });
    }
  }

  journal(botId: string, limit = 200): BrowserJournalEntry[] {
    this.#deps.store.getBot(botId);
    const file = join(this.#botDir(botId), 'journal.jsonl');
    if (!existsSync(file)) return [];
    const out: BrowserJournalEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  // ------------------------------------------------------------- the browser process

  #playwright(): Promise<Playwright | null> {
    return loadPlaywright();
  }

  #session(botId: string): Promise<Session> {
    return this.#sessions.get(botId) ?? this.#start(botId, this.#launch(botId));
  }

  #start(botId: string, starting: Promise<Session>): Promise<Session> {
    this.#sessions.set(botId, starting);
    const forget = () => {
      if (this.#sessions.get(botId) === starting) this.#sessions.delete(botId);
    };
    // Chromium gone on its own (it crashed, or was killed): the next step starts it again.
    starting.then((s) => s.context.on('close', forget), forget);
    return starting;
  }

  /**
   * In place of a browser whose page was acted on: that one ends (its Chromium exits, its proxy, still sealed, closes)
   * before another starts on the same profile, with the cookies it had, the same address trail and the same list of
   * what was blocked in this step. Whatever the old page still had on its way can go nowhere: the proxy it could
   * reach refuses everything until it is gone, and nothing listens on its port after.
   */
  #replace(botId: string, old: Session): Promise<Session> {
    return this.#start(
      botId,
      (async () => {
        const cookies = await old.context.cookies().catch(() => []);
        old.closed = true;
        old.endWait?.();
        old.sending?.abort();
        old.proxy.seal(true);
        await old.context.close().catch(() => {});
        await old.proxy.close();
        return this.#launch(botId, { blocked: old.blocked, unreachable: old.unreachable, trail: old.trail, cookies });
      })(),
    );
  }

  async #launch(botId: string, carry?: { blocked: Session['blocked']; unreachable: Session['unreachable']; trail: string[]; cookies: Cookie[] }): Promise<Session> {
    const pw = await this.#playwright();
    const a = await this.availability();
    if (!pw || !a.executable) throw new HttpError(503, a.why ?? 'No browser on this server');
    const profile = join(this.#botDir(botId), 'profile');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const blocked: Session['blocked'] = carry?.blocked ?? [];
    const note = (url: string, why: string, request?: Request) => {
      if (blocked.length < 50) blocked.push({ url: displayUrl(url), why, ...(request ? { request } : {}) });
      this.#journal(botId, { action: 'blocked', url: displayUrl(url), outcome: 'refused', detail: why });
    };
    const unreachable: Session['unreachable'] = carry?.unreachable ?? [];
    const noted = (url: string, message: string) => {
      if (unreachable.length < 50) unreachable.push({ url: displayUrl(url), host: hostOfUrl(url), message });
      this.#journal(botId, { action: 'unreachable', url: displayUrl(url), outcome: 'refused', detail: message });
    };
    let started: Session | null = null;
    // The owner has it: no browser of the Boton's opens on the profile until they finish.
    if (this.#handovers.has(botId)) throw new HttpError(409, `${this.#deps.store.getSettings().ownerName} has the browser now.`);
    const { context, page, proxy } = await openGuarded(pw, profile, {
      executable: a.executable,
      sandbox: this.#deps.cfg.browser.sandbox,
      headless: !this.#headed(),
      policy: () => this.#proxyPolicy(botId),
      note,
      onUnreachable: noted,
      // Its HTTPS ends at its proxy (openGuarded), which refuses every write it sees there (this policy never allows
      // one): a request Playwright's routing never sees (a beacon or keepalive fetch as a document unloads) is judged
      // too. Only the send of a card's request, by a pass, gets a tunnel to the site itself.
      trustCa: this.testTrust ? [this.testTrust.cert] : undefined,
      gate: (route, request, write) => {
        const s = started;
        if (!s || s.closed) return 'the browser is closing';
        let page: Page | null = null;
        try {
          page = request.frame().page();
        } catch {}
        if (!page) return s.everActed ? 'no page of this browser made it (a worker), after a page was acted on' : write ? null : 'pass';
        if (page !== s.page) return 'it came from a page the browser has left';
        const op = s.op;
        if (op?.open) {
          // While a click or typing runs: one request for the card (a form before a script's, a script's before the rest).
          const rank = rankOf(request);
          if (op.held) {
            if (rank <= op.held.rank) return 'the step had already made a request, which waits on the card';
            const before = op.held;
            note(before.request.url(), 'the step then made another request, which goes to the card instead', before.request);
            void before.route.abort('blockedbyclient').catch(() => {});
          }
          op.held = { route, request, rank };
          op.onHeld();
          return 'held';
        }
        if (s.actedOn) return 'the page was clicked or typed on, so nothing more it sends leaves without a card (open an address to go on)';
        return write ? null : 'pass';
      },
      onDownload: (url) => this.#journal(botId, { action: 'download', url: displayUrl(url), outcome: 'refused', detail: 'Downloads are refused.' }),
    }).catch((err) => {
      const first = (err as Error).message.split('\n').find((l) => l.trim()) ?? '';
      log.error('the browser did not start', { botId, err });
      throw new HttpError(503, `The browser did not start: ${first.slice(0, 200)}`);
    });
    const s: Session = {
      context,
      page,
      proxy,
      blocked,
      unreachable,
      id: randomBytes(12).toString('base64url'),
      revision: 0,
      controls: null,
      op: null,
      actedOn: false,
      everActed: false,
      trail: carry?.trail ?? [],
      endWait: null,
      sending: null,
      closed: false,
    };
    // The cookies the browser before it had (session ones too, which a profile doesn't keep across a restart): the one
    // it replaces, else the last one to close (the owner's, after a sign-in).
    const cookies = carry?.cookies ?? this.#carry.get(botId) ?? [];
    if (cookies.length) await context.addCookies(cookies).catch(() => {});
    started = s;
    watchPage(s, page);
    context.on('close', () => {
      s.closed = true;
      s.endWait?.();
      s.sending?.abort();
    });
    log.info('browser started', { botId, headless: !this.#headed(), sandbox: this.#deps.cfg.browser.sandbox });
    return s;
  }

  async #close(botId: string): Promise<void> {
    const open = this.#sessions.get(botId);
    if (!open) return;
    this.#sessions.delete(botId);
    try {
      const s = await open;
      // A card waiting on a request of this browser is withdrawn, and the request never sent.
      s.closed = true;
      s.endWait?.();
      s.sending?.abort();
      s.proxy.seal(true);
      await this.#keep(botId, s.context);
      await s.context.close().catch(() => {});
      await s.proxy.close();
      log.info('browser closed', { botId });
    } catch {}
  }

  /** The jar of a browser about to close, for the next one to open with (a profile keeps no session cookies). */
  async #keep(botId: string, context: Context): Promise<void> {
    const cookies = await context.cookies().catch(() => null);
    if (cookies) this.#carry.set(botId, cookies);
  }

  /**
   * The Boton's profile opened by itself, with nothing let out (its proxy is off) and no page loaded, for `fn` to read
   * or set its cookie jar. Only while no browser of the Boton's is open: in a handover, which keeps any from opening.
   */
  async #withProfile<T>(botId: string, fn: (context: Context) => Promise<T>): Promise<T> {
    const pw = await this.#playwright();
    const a = await this.availability();
    if (!pw || !a.executable) throw new Error('no browser');
    const profile = join(this.#botDir(botId), 'profile');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const { context, proxy } = await openGuarded(pw, profile, {
      executable: a.executable,
      sandbox: this.#deps.cfg.browser.sandbox,
      headless: true,
      policy: () => ({ enabled: false, sites: [] }),
      note: () => {},
    });
    try {
      proxy.seal(true);
      return await fn(context);
    } finally {
      await context.close().catch(() => {});
      await proxy.close();
    }
  }

  /** The Boton's whole jar, for a handover to start with: the last browser's, else its profile's (null if unread). */
  async #jarFor(botId: string): Promise<Cookie[] | null> {
    const kept = this.#carry.get(botId);
    if (kept) return kept;
    return this.#withProfile(botId, (c) => c.cookies()).catch((err) => {
      log.warn("could not read the browser profile's cookies", { botId, err });
      return null;
    });
  }

  /**
   * A handover's jar, back to the Boton: in memory for its next browser, and into its profile so a restart keeps the
   * sign-in. `whole` (the handover started with the Boton's whole jar): cookies the site dropped go from the profile
   * too; else they are only added, never removed.
   */
  async #giveJar(botId: string, jar: Cookie[], whole: boolean): Promise<void> {
    this.#carry.set(botId, jar);
    await this.#withProfile(botId, async (c) => {
      if (jar.length) await c.addCookies(jar);
      if (!whole) return;
      // Each by its whole identity, partition included (clearCookies can't name one): expired in place, as it does.
      const stale = staleCookies(await c.cookies(), jar);
      if (stale.length) await c.addCookies(stale.map((k) => ({ ...k, expires: 0 })));
    }).catch((err) => log.warn("could not save the handover's cookies to the browser profile", { botId, err }));
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    this.#turns.clear();
    await Promise.all([...this.#handovers.keys()].map((id) => this.giveBack(id, null, 'shutdown')));
    await Promise.all([...this.#sessions.keys()].map((id) => this.#close(id)));
  }

  // ------------------------------------------------------------- the owner's handover

  /** The handover under way, as `deviceId` sees it (null: none). */
  handover(botId: string, deviceId: string | null = null): BrowserHandover | null {
    const h = this.#handovers.get(botId);
    if (!h || h.ended) return null;
    return {
      id: h.id,
      startedAt: new Date(h.startedAt).toISOString(),
      byThisDevice: h.deviceId === deviceId,
      deviceLabel: h.deviceLabel,
      page: h.view && /^https?:/.test(h.view.url()) ? { url: displayUrl(h.view.url()), title: h.title } : null,
      idleEndsAt: new Date(Math.min(h.lastActive + this.#idleMs(), h.startedAt + MAX_HANDOVER_MS)).toISOString(),
      viewport: { ...h.viewport },
      resume: h.resume ? displayUrl(h.resume) : null,
    };
  }

  #idleMs = () => this.testHandover?.idleMs ?? IDLE_MS;
  #intentMs = () => this.testHandover?.intentMs ?? INTENT_MS;

  /** What the proxy lets the owner's browser reach: nothing once the handover ends, the Boton's sites until then. */
  #ownerPolicy(botId: string, h: Handover): ProxyPolicy {
    if (h.ended || this.#handovers.get(botId) !== h || !this.enabled(botId)) return { enabled: false, sites: [] };
    return { enabled: true, sites: this.sites(botId), writes: Date.now() - h.lastIntent < this.#intentMs() };
  }

  /** The handover `deviceId` drives, or why not (409: none, or not this one; 403: another device's). */
  #driven(botId: string, deviceId: string | null, id: string | null): Handover {
    this.#deps.store.getBot(botId);
    const h = this.#handovers.get(botId);
    if (!h || h.ended || (id !== null && h.id !== id)) throw new HttpError(409, 'That handover has ended: take the browser over again to go on.');
    if (h.deviceId !== deviceId) throw new HttpError(403, `The browser is being driven from ${h.deviceLabel}: only that device sees and drives it (any device can end it).`);
    return h;
  }

  /** The owner did something: the idle limit starts again (never past the handover's time limit). */
  #active(botId: string, h: Handover): void {
    h.lastActive = Date.now();
    if (h.timer) clearTimeout(h.timer);
    const left = Math.min(this.#idleMs(), h.startedAt + MAX_HANDOVER_MS - Date.now());
    h.timer = setTimeout(() => void this.giveBack(botId, h.id, 'idle'), Math.max(0, left));
    h.timer.unref?.();
  }

  /**
   * The owner (`by`, a paired device) takes the Boton's browser over. The Boton's browser closes first (a card it
   * waits on is withdrawn, its request never sent), and while the handover lasts it opens none: its tools are refused.
   * Then a browser of the owner's own opens on the same profile with the same cookies, on a blank page (nothing is
   * opened for the owner: they choose the address). The same device asking again gets the same handover.
   */
  async takeOver(botId: string, by: Principal | null, start?: BrowserHandoverStart | null): Promise<BrowserHandover> {
    const owner = this.#deps.store.getSettings().ownerName;
    const bot = this.#deps.store.getBot(botId);
    if (by?.kind === 'boton') throw new HttpError(403, `Only ${owner}'s paired devices can take a Boton's browser over.`);
    const deviceId = by?.kind === 'device' ? by.deviceId : null;
    if (!this.enabled(botId)) throw new HttpError(409, `${bot.name}'s browser is off: give it the browser connector first.`);
    if (!this.sites(botId).length) throw new HttpError(409, `List the sites ${bot.name}'s browser may use first: the handover reaches only those.`);
    const a = await this.availability(true);
    if (!a.available) throw new HttpError(503, a.why ?? 'No browser on this server');
    const existing = this.#handovers.get(botId);
    if (existing) {
      if (existing.ended) await existing.ending;
      else if (existing.deviceId === deviceId) {
        await existing.session.catch(() => {});
        const view = this.handover(botId, deviceId);
        if (view) return view;
        throw new HttpError(503, 'The browser did not start.');
      } else throw new HttpError(409, `${bot.name}'s browser is already being driven from ${existing.deviceLabel}: finish there, or end that handover first.`);
    }
    // Checked again after every wait above: still on, still no handover.
    if (!this.enabled(botId) || this.#handovers.has(botId)) throw new HttpError(409, `${bot.name}'s browser changed meanwhile: try again.`);
    const deviceLabel = this.#deps.audit?.actorOf(by).label ?? 'a paired device';
    const now = Date.now();
    const h: Handover = {
      id: `ho_${randomBytes(12).toString('base64url')}`,
      deviceId,
      deviceLabel,
      startedAt: now,
      lastActive: now,
      lastIntent: 0,
      session: null as unknown as Promise<OwnerSession>,
      view: null,
      title: '',
      ended: false,
      ending: null,
      timer: null,
      queue: Promise.resolve(),
      framing: false,
      lastFrame: 0,
      viewport: start ? fitViewport(start.width ?? VIEWPORT.width, start.height ?? VIEWPORT.height) : { ...VIEWPORT },
      sink: null,
      stopCast: null,
      resume: null,
      inputs: new RateWindow(MAX_INPUTS, INPUT_WINDOW_MS),
      onEnd: [],
      jar: null,
      seeded: false,
    };
    // From here on (synchronously, before any wait) the Boton's browser opens no more: #act refuses, #launch throws.
    this.#handovers.set(botId, h);
    const untrack = this.#deps.trackDevice?.(by, () => void this.giveBack(botId, h.id, 'revoked'));
    if (untrack) h.onEnd.push(untrack);
    h.session = (async () => {
      // The Boton's page as it stands, or where it was when it asked for the handover.
      const boton = await this.#sessions.get(botId)?.catch(() => null);
      let at = '';
      try {
        at = boton && !boton.closed ? boton.page.url() : '';
      } catch {}
      h.resume = /^https?:/i.test(at) ? at : (this.#handoffPage.get(botId) ?? null);
      await this.#close(botId);
      const jar = await this.#jarFor(botId);
      if (h.ended) throw new HttpError(409, 'The handover ended before its browser opened.');
      h.jar = jar;
      h.seeded = jar !== null;
      return this.#launchOwner(botId, h, jar ?? []);
    })();
    try {
      await h.session;
    } catch (err) {
      await this.giveBack(botId, h.id, 'failed');
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, 'The browser did not start.');
    }
    if (h.ended) throw new HttpError(409, 'The handover ended before its browser opened.');
    // The idle limit counts from when the owner can see it.
    this.#active(botId, h);
    this.#journal(botId, { action: 'handover', url: '', outcome: 'done', detail: `${owner} took the browser over (from ${deviceLabel}).` });
    this.#deps.handoffs?.taken(botId, deviceLabel);
    this.#deps.audit?.record(by, { action: 'browser.handover_started', target: { kind: 'boton', id: botId, label: bot.name } });
    log.info('browser handover started', { botId });
    return this.handover(botId, deviceId)!;
  }

  async #launchOwner(botId: string, h: Handover, cookies: Cookie[]): Promise<OwnerSession> {
    const pw = await this.#playwright();
    const a = await this.availability();
    if (!pw || !a.executable) throw new HttpError(503, a.why ?? 'No browser on this server');
    // A profile of its own, new for this handover (none is left from another: they are deleted as they end).
    this.#dropOwnerProfile(basename(this.#botDir(botId)));
    const profile = join(this.#ownerDir(botId), 'profile');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const owner = this.#deps.store.getSettings().ownerName;
    let ownerPage: Page | null = null;
    const opened = await openGuarded(pw, profile, {
      executable: a.executable,
      sandbox: this.#deps.cfg.browser.sandbox,
      headless: !this.#headed(),
      viewport: h.viewport,
      policy: () => this.#ownerPolicy(botId, h),
      note: (url, why) => {
        this.#journal(botId, { action: 'blocked', url: displayUrl(url), outcome: 'refused', detail: `In ${owner}'s handover: ${why}` });
        // Said in the view as Botons' own, apart from anything the site says: only the page's own site's requests
        // (Chromium's own calls and other sites' are refused as quietly as ever).
        if (sameHost(url, h.view?.url() ?? '')) h.sink?.notice({ type: 'paused', url: displayUrl(url), why });
      },
      onUnreachable: (url, message) => this.#journal(botId, { action: 'unreachable', url: displayUrl(url), outcome: 'refused', detail: `In ${owner}'s handover: ${message}` }),
      // Its HTTPS ends at its proxy, which sees and decides every request (a write only within the owner's moment) and
      // journals each write as it leaves: whatever in Chromium sent it, routing seen or not.
      trustCa: this.testTrust ? [this.testTrust.cert] : undefined,
      onWrite: (url, method) => this.#journal(botId, { action: 'handover', url: displayUrl(url), outcome: 'done', detail: `${method} sent by the page, after ${owner}'s input in the handover` }),
      gate: (_route, request, write) => {
        if (h.ended || this.#handovers.get(botId) !== h) return 'the handover has ended';
        let from: Page | null = null;
        try {
          from = request.frame().page();
        } catch {}
        if (!from) return write ? 'no page made it (a worker), and only the page the owner is on sends' : 'pass';
        if (from !== ownerPage) return 'it came from a page the browser has left';
        if (!write) return 'pass';
        if (Date.now() - h.lastIntent >= this.#intentMs()) {
          return `the page sent it on its own, not within ${Math.round(this.#intentMs() / 1000)} seconds of ${owner}'s click, key or typing, so it was refused`;
        }
        // The proxy decides it again as it leaves, and journals it then.
        return 'send';
      },
      onDownload: (url) => this.#journal(botId, { action: 'download', url: displayUrl(url), outcome: 'refused', detail: 'Downloads are refused.' }),
    }).catch((err) => {
      log.error('the browser did not start', { botId, err });
      throw new HttpError(503, 'The browser did not start.');
    });
    const { context, page, proxy } = opened;
    ownerPage = page;
    if (cookies.length) await context.addCookies(cookies).catch(() => {});
    h.view = page;
    // Where the page is, and the site's own error answers for it, for the live view (never called a block).
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame() || !/^https?:/i.test(f.url())) return;
      h.sink?.notice({ type: 'page', url: displayUrl(f.url()), title: h.title });
    });
    page.on('load', () => {
      void page
        .title()
        .then((t) => {
          h.title = t.slice(0, 200);
          if (/^https?:/i.test(page.url())) h.sink?.notice({ type: 'page', url: displayUrl(page.url()), title: h.title });
        })
        .catch(() => {});
    });
    page.on('response', (r) => {
      try {
        if (r.status() >= 400 && r.request().isNavigationRequest() && r.frame() === page.mainFrame()) h.sink?.notice({ type: 'site-error', url: displayUrl(r.url()), status: r.status() });
      } catch {}
    });
    // Chromium gone on its own (it crashed, or was killed): the handover is over.
    context.on('close', () => void this.giveBack(botId, h.id, 'closed'));
    log.info('browser started', { botId, headless: !this.#headed(), sandbox: this.#deps.cfg.browser.sandbox });
    return { context, page, proxy, cdp: null };
  }

  /** The server's DevTools session on the owner's page (one, made when first needed). */
  async #cdp(s: OwnerSession): Promise<import('playwright-core').CDPSession> {
    s.cdp ??= await s.context.newCDPSession(s.page);
    return s.cdp;
  }

  /** `expression` in a world of the server's own on the page's main frame (the page's script can't reach or change it). */
  async #isolated(s: OwnerSession, expression: string): Promise<unknown> {
    const cdp = await this.#cdp(s);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'botons-owner' });
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
    return r.result.value;
  }

  /**
   * The live view: a screencast of the owner's page to the driving device's stream, each frame acknowledged only once
   * it has gone (so a slow connection gets fewer frames, never a backlog), with notices of where the page is, the
   * site's own errors and what Botons paused. One stream at a time: a new one ends the one before. While it is open
   * the handover counts as in use. Returns how to stop it.
   */
  async stream(botId: string, deviceId: string | null, sink: HandoverSink): Promise<() => void> {
    const h = this.#driven(botId, deviceId, null);
    const s = await h.session;
    if (h.ended) throw new HttpError(409, 'That handover has ended.');
    const before = h.sink;
    if (before) {
      h.sink = null;
      await h.stopCast?.().catch(() => {});
      before.end();
    }
    h.sink = sink;
    this.#active(botId, h);
    const keep = setInterval(() => {
      if (h.sink === sink && !h.ended) this.#active(botId, h);
    }, 30_000);
    keep.unref?.();
    let stopped = false;
    const ended = () => {
      if (h.sink === sink) sink.notice({ type: 'ended' });
      stop();
      sink.end();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(keep);
      // This stream's own hook goes with it: a reconnect leaves nothing of the stream before it behind.
      const at = h.onEnd.indexOf(ended);
      if (at >= 0) h.onEnd.splice(at, 1);
      if (h.sink !== sink) return;
      h.sink = null;
      void h.stopCast?.().catch(() => {});
      h.stopCast = null;
    };
    h.onEnd.push(ended);
    try {
      if (/^https?:/i.test(s.page.url())) sink.notice({ type: 'page', url: displayUrl(s.page.url()), title: h.title });
      await this.#cast(h, s);
    } catch (err) {
      // The screencast didn't start: this stream ends (the device falls back to frames), the handover goes on.
      stop();
      throw err;
    }
    return stop;
  }

  /** (Re)starts the screencast to the open stream at the page's size now. */
  async #cast(h: Handover, s: OwnerSession): Promise<void> {
    await h.stopCast?.().catch(() => {});
    h.stopCast = null;
    const sink = h.sink;
    if (!sink || h.ended) return;
    const cdp = await this.#cdp(s);
    let live = true;
    const onFrame = (f: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
      if (!live) return;
      const width = Math.round(f.metadata.deviceWidth ?? h.viewport.width);
      const height = Math.round(f.metadata.deviceHeight ?? h.viewport.height);
      void sink
        .frame(Buffer.from(f.data, 'base64'), width, height)
        .catch(() => {})
        .then(() => (live ? cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}) : undefined));
    };
    cdp.on('Page.screencastFrame', onFrame);
    h.stopCast = async () => {
      live = false;
      cdp.off('Page.screencastFrame', onFrame);
      await cdp.send('Page.stopScreencast').catch(() => {});
    };
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 75,
      // Headless Chromium casts at the page's CSS size, whatever the screen's pixel ratio.
      maxWidth: h.viewport.width,
      maxHeight: h.viewport.height,
      everyNthFrame: 1,
    });
  }

  /**
   * The handover ends (`id`: only that one; null: whichever is under way): nothing more of the owner's browser goes
   * (its proxy is sealed, then Chromium and the proxy close), its cookies are kept for the Boton's next browser, and
   * the Boton has its browser back. Safe to call any number of times, from anywhere: the first does it, the rest
   * wait for it. False if there was no such handover.
   */
  async giveBack(botId: string, id: string | null, why: HandoverEnd, by: Principal | null = null): Promise<boolean> {
    const h = this.#handovers.get(botId);
    if (!h || (id !== null && h.id !== id)) return false;
    if (!h.ending) {
      h.ended = true;
      if (h.timer) clearTimeout(h.timer);
      h.ending = (async () => {
        const s = await h.session?.catch(() => null);
        let jar: Cookie[] | null = null;
        let page: string | null = null;
        if (s) {
          // Sealed first: nothing more leaves, not even what its pages send as they close.
          s.proxy.seal(true);
          // Where the owner left it, origin and path only (never its query), for the Boton's note.
          const at = (() => {
            try {
              return s.page.url();
            } catch {
              return '';
            }
          })();
          page = /^https?:/i.test(at) ? displayUrl(at) : null;
          jar = await s.context.cookies().catch(() => null);
          await s.context.close().catch(() => {});
          await s.proxy.close();
        }
        // Its Chromium has exited: its profile goes, with whatever it kept of the pages. Only the cookies come back
        // (if it died first, as of the owner's last input).
        this.#dropOwnerProfile(basename(this.#botDir(botId)));
        jar ??= h.jar;
        if (jar && why !== 'deleted' && why !== 'failed') await this.#giveJar(botId, jar, h.seeded);
        for (const f of h.onEnd.splice(0)) f();
        if (this.#handovers.get(botId) === h) this.#handovers.delete(botId);
        this.#journal(botId, { action: 'handover', url: '', outcome: 'done', detail: `The handover ended (${HANDOVER_ENDS[why]}): the browser is the Boton's again.` });
        this.#handoffPage.delete(botId);
        if (why !== 'deleted') this.#deps.handoffs?.handedBack(botId, page, why === 'finished' ? 'finished' : HANDOVER_ENDS[why]);
        log.info('browser handover ended', { botId, why });
        const label = this.#deps.store.hasBot(botId) ? this.#deps.store.getBot(botId).name : botId;
        if (why !== 'failed') {
          this.#deps.audit?.record(by ?? SYSTEM_ACTOR, {
            action: 'browser.handover_ended',
            target: { kind: 'boton', id: botId, label },
            details: { reason: why, minutes: Math.round((Date.now() - h.startedAt) / 60_000) },
          });
        }
      })();
    }
    await h.ending;
    return true;
  }

  /** One of the owner's inputs, from the device that drives the handover, run after the ones before it. */
  ownerInput(botId: string, deviceId: string | null, raw: unknown): Promise<BrowserHandoverResult> {
    const input = parseOwnerInput(raw);
    const h = this.#driven(botId, deviceId, input.handover);
    if (!h.inputs.take()) throw new HttpError(429, `At most ${MAX_INPUTS} inputs in ${INPUT_WINDOW_MS / 1000} seconds: wait a moment.`);
    this.#active(botId, h);
    const next = h.queue.catch(() => {}).then(() => this.#ownerStep(botId, h, input));
    h.queue = next;
    return next;
  }

  async #ownerStep(botId: string, h: Handover, input: BrowserHandoverInput): Promise<BrowserHandoverResult> {
    const s = await h.session;
    try {
      return await this.#ownerDo(botId, h, s, input);
    } finally {
      if (!h.ended) h.jar = (await s.context.cookies().catch(() => null)) ?? h.jar;
    }
  }

  async #ownerDo(botId: string, h: Handover, s: OwnerSession, input: BrowserHandoverInput): Promise<BrowserHandoverResult> {
    const page = s.page;
    const info = async () => {
      const title = (await page.title().catch(() => '')).slice(0, 200);
      h.title = title;
      return { url: displayUrl(page.url()), title };
    };
    if (h.ended) return { outcome: 'refused', message: 'The handover has ended.', page: null };
    const done = async (message: string): Promise<BrowserHandoverResult> => ({ outcome: 'done', message, page: await info() });
    // After a click or key: a moment for what it starts (a form's page) to commit, so the address said is the new one.
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 400));
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    };
    const intent = () => (h.lastIntent = Date.now());
    // Open, back and reload are no consent to send: the moment of the owner's last input ends, and everything the
    // page has open or under way is cut, before the page goes (what it sends as it unloads is then refused).
    const leave = () => {
      h.lastIntent = 0;
      s.proxy.cut();
    };
    // Points inside the page as it is now (the view may be a moment behind a resize).
    const at = (p: { x: number; y: number }) => ({ x: Math.min(p.x, h.viewport.width - 1), y: Math.min(p.y, h.viewport.height - 1) });
    const takesText = async () => (await this.#isolated(s, FOCUS_TAKES_TEXT).catch(() => false)) === true;
    try {
      switch (input.action) {
        case 'open': {
          let u: URL;
          try {
            u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`);
          } catch {
            return { outcome: 'refused', message: 'That is not an address.', page: await info() };
          }
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return { outcome: 'refused', message: 'Only http:// and https:// addresses open here.', page: await info() };
          const v = judgeRequest(u.href, 'GET', this.sites(botId));
          if (!v.ok) return { outcome: 'refused', message: `Not opened: ${v.why}. Add the site to the Boton's browser sites first.`, page: await info() };
          leave();
          this.#journal(botId, { action: 'handover', url: displayUrl(u.href), outcome: 'done', detail: 'Opened in the handover' });
          const res = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }).catch((err: Error) => err);
          if (res instanceof Error) return { outcome: 'refused', message: `${displayUrl(u.href)} didn't load: ${failureOf(res)}.`, page: await info() };
          return done(`Opened (HTTP ${res?.status() ?? '—'}).`);
        }
        case 'resume': {
          // The Boton's page in full, as it handed over: the owner asked for it, so it opens like any address.
          const u = h.resume;
          if (!u) return { outcome: 'refused', message: 'There is no page to go back to: open an address instead.', page: await info() };
          const v = judgeRequest(u, 'GET', this.sites(botId));
          if (!v.ok) return { outcome: 'refused', message: `Not opened: ${v.why}.`, page: await info() };
          leave();
          this.#journal(botId, { action: 'handover', url: displayUrl(u), outcome: 'done', detail: "Opened the Boton's page in the handover" });
          const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }).catch((err: Error) => err);
          if (res instanceof Error) return { outcome: 'refused', message: `${displayUrl(u)} didn't load: ${failureOf(res)}.`, page: await info() };
          return done(`Opened (HTTP ${res?.status() ?? '—'}).`);
        }
        case 'click': {
          intent();
          const p = at(input);
          await page.mouse.click(p.x, p.y, { clickCount: input.count ?? 1 });
          await settle();
          return { ...(await done('Clicked.')), editable: await takesText() };
        }
        case 'down': {
          intent();
          const p = at(input);
          await page.mouse.move(p.x, p.y);
          await page.mouse.down({ button: input.button, clickCount: input.count ?? 1 });
          return done('Pressed.');
        }
        case 'up': {
          intent();
          const p = at(input);
          await page.mouse.move(p.x, p.y);
          await page.mouse.up({ button: input.button, clickCount: input.count ?? 1 });
          return { ...(await done('Released.')), editable: await takesText() };
        }
        case 'move': {
          // Not consent to send: hovering is not a choice.
          const p = at(input);
          await page.mouse.move(p.x, p.y);
          return done('Moved.');
        }
        case 'wheel': {
          const p = at(input);
          await page.mouse.move(p.x, p.y);
          await page.mouse.wheel(input.dx, input.dy);
          return done('Scrolled.');
        }
        case 'type':
          intent();
          await page.keyboard.type(input.text);
          // Never the text: only that some was typed.
          return done('Typed.');
        case 'paste':
          intent();
          await page.keyboard.insertText(input.text);
          // Never the text: only that some was pasted.
          return done('Pasted.');
        case 'copy': {
          const text = await this.#isolated(s, COPY_SELECTION).catch(() => '');
          // For this device's clipboard only: never in the journal, the log or a message.
          return { ...(await done('Copied.')), copied: typeof text === 'string' ? text.slice(0, MAX_COPY) : '' };
        }
        case 'key':
          intent();
          await page.keyboard.press(pressed(input.key, input.mods));
          if (input.key === 'Enter') await settle();
          return done(`Pressed ${pressed(input.key, input.mods)}.`);
        case 'scroll':
          await page.mouse.wheel(0, input.dy);
          return done('Scrolled.');
        case 'resize': {
          const next = fitViewport(input.width, input.height);
          if (next.width !== h.viewport.width || next.height !== h.viewport.height) {
            h.viewport = next;
            await page.setViewportSize(next);
            await this.#cast(h, s);
          }
          return done('Resized.');
        }
        case 'back':
          leave();
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
          return done('Went back.');
        case 'forward':
          leave();
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
          return done('Went forward.');
        case 'reload':
          leave();
          await page.reload({ waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
          return done('Reloaded.');
      }
    } catch (err) {
      // Botons' own words only: Playwright's message can name the address, and for typing, what was typed.
      return { outcome: 'refused', message: `The browser couldn't do that: ${failureOf(err)}.`, page: await info().catch(() => null) };
    }
  }

  /**
   * What the owner's browser shows now, as a JPEG, for the device that drives it: made on demand, kept nowhere (not in
   * the workspace, the chat, the journal or the audit), at most one at a time and one per FRAME_MIN_MS.
   */
  async frame(botId: string, deviceId: string | null): Promise<Buffer> {
    const h = this.#driven(botId, deviceId, null);
    const now = Date.now();
    if (h.framing || now - h.lastFrame < FRAME_MIN_MS) throw new HttpError(429, `At most one frame every ${FRAME_MIN_MS} ms.`);
    h.framing = true;
    h.lastFrame = now;
    this.#active(botId, h);
    try {
      const s = await h.session;
      if (h.ended) throw new HttpError(409, 'That handover has ended.');
      return await s.page.screenshot({ type: 'jpeg', quality: 70, timeout: 10_000, caret: 'initial' });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, `No frame: ${failureOf(err)}.`);
    } finally {
      h.framing = false;
    }
  }

  // ------------------------------------------------------------- actions

  /** One action from the Boton's turn, with that turn's token (`tokenId`). */
  act(botId: string, tokenId: string, input: BrowserActionInput): Promise<BrowserActionResult> {
    if (this.#turns.get(botId) !== tokenId) {
      throw new HttpError(403, "Only a turn that was given the browser drives it (through its browser tools), and only while it runs.");
    }
    const prev = this.#queues.get(botId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#act(botId, tokenId, input));
    this.#queues.set(botId, next);
    void next
      .finally(() => {
        if (this.#queues.get(botId) === next) this.#queues.delete(botId);
      })
      .catch(() => {});
    return next;
  }

  async #act(botId: string, tokenId: string, input: BrowserActionInput): Promise<BrowserActionResult> {
    const action = input?.action;
    if (!action || !ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${ACTIONS.join(', ')}`);
    const owner = this.#deps.store.getSettings().ownerName;
    const refuse = (message: string, page: BrowserActionResult['page'] = null): BrowserActionResult => {
      this.#journal(botId, { action, url: page?.url ?? '', outcome: 'refused', detail: message });
      return { outcome: 'refused', message, page };
    };
    if (!this.enabled(botId) || this.#turns.get(botId) !== tokenId) return refuse(`Your browser is off: ${owner} took the browser connector away.`);
    if (action === 'handoff') return this.#handoff(botId, input, owner);
    if (this.#handovers.has(botId)) {
      return refuse(`${owner} has your browser now (to sign it in, or to look at a page): you can't use it until ${owner} finishes. Go on without it, or say what you need it for.`);
    }
    const sites = this.sites(botId);
    if (!sites.length) return refuse(`No site is allowed yet: ${owner} lists the sites your browser may use in your settings.`);
    const s = await this.#session(botId);
    s.blocked.length = 0;
    s.unreachable.length = 0;
    try {
      const result = await this.#run(botId, tokenId, s, action, input, sites);
      if (s.blocked.length) result.blocked = s.blocked.map((b) => `${b.url}: ${b.why}`);
      if (s.unreachable.length) result.unreachable = [...new Set(s.unreachable.map((u) => u.message))];
      this.#journal(botId, { action, url: result.page?.url ?? '', outcome: result.outcome, detail: result.message });
      return result;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return refuse(`The browser couldn't do that: ${failureOf(err)}.`, await this.#pageInfo(s).catch(() => null));
    }
  }

  /**
   * browser_handoff: the Boton asks the owner to take its browser over (a sign-in, a captcha, a code, or a step only
   * the owner should do). It posts the card in the chat and a push; nothing else changes until the owner takes it over,
   * which is the handover with all its rules. Handing back wakes the Boton with a note of where the page is.
   */
  async #handoff(botId: string, input: BrowserActionInput, owner: string): Promise<BrowserActionResult> {
    const handoffs = this.#deps.handoffs;
    if (!handoffs) return { outcome: 'refused', message: 'Handing the browser over is not available on this server.', page: null };
    if (!this.sites(botId).length) return { outcome: 'refused', message: `No site is allowed yet: ${owner} lists the sites your browser may use in your settings.`, page: null };
    const h = this.#handovers.get(botId);
    const s = h ? null : await this.#sessions.get(botId)?.catch(() => null);
    let url: string | null = null;
    try {
      const at = s && !s.closed ? s.page.url() : '';
      if (/^https?:/i.test(at)) {
        url = displayUrl(at);
        this.#handoffPage.set(botId, at);
      }
    } catch {}
    const { message, already } = handoffs.request(botId, input.reason, url, h && !h.ended ? h.deviceLabel : null);
    const page = url ? { url, title: '' } : null;
    this.#journal(botId, { action: 'handoff', url: url ?? '', outcome: 'done', detail: `Asked ${owner} to take the browser over (card ${message.id})` });
    if (already || (h && !h.ended)) {
      return { outcome: 'done', message: `${owner} has your browser now. End your turn: when ${owner} hands it back, you get a message saying where the page is.`, page, handoff: message.id };
    }
    return {
      outcome: 'done',
      message: `Asked ${owner} to take over: the chat shows a card with Take over, and ${owner} got a notification. Your browser is ${owner}'s until they hand it back, so end your turn now with one short line (no need to explain where to find anything). When ${owner} hands it back, you get a message saying where the page is.`,
      page,
      handoff: message.id,
    };
  }

  /** The control `ref` names, found again on the page as the last read listed it, or why not. */
  async #control(s: Session, ref: unknown): Promise<{ control: Control; locator: import('playwright-core').Locator } | string> {
    if (typeof ref !== 'string' || !/^e\d{1,4}$/.test(ref)) throw new HttpError(400, 'click and type need the ref of a control, from read (such as e3)');
    if (!s.controls || s.controls.revision !== s.revision) return 'The page has changed since you last read it (or you have not read it): read it again, then use a ref from that read.';
    const index = Number(ref.slice(1));
    const control = s.controls.list.find((c) => c.index === index);
    if (!control) return `There is no control ${ref} on this page: read it again.`;
    const locator = s.page.locator(CONTROLS).nth(index);
    const now = await locator.evaluate(describeControl, null).catch(() => null);
    if (!now || s.revision !== s.controls.revision || sameControl(now) !== sameControl(control)) return `The control ${ref} has changed since you read the page: read it again.`;
    return { control, locator };
  }

  /**
   * A click or typing, then the request it made the page send, if any: held for the owner's card. The page is acted on
   * from the moment the step starts: anything else it sends, during the step or after, is refused.
   */
  async #operate(botId: string, tokenId: string, s: Session, what: string, step: () => Promise<void>, doneText: string): Promise<BrowserActionResult> {
    let wake = () => {};
    const heldNow = new Promise<void>((r) => (wake = r));
    const op: Op = { open: true, cookies: await s.context.cookies().catch(() => null), held: null, onHeld: () => wake() };
    // Acted on from here: the routing holds or refuses each request the page makes, and the proxy lets nothing go
    // (not even what Playwright can't name a frame for) but the one send of a card the owner allows.
    s.actedOn = true;
    s.everActed = true;
    s.proxy.seal(true);
    s.op = op;
    try {
      await this.testGate?.('acting', botId);
      await step();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([heldNow, new Promise<void>((r) => (timer = setTimeout(r, SETTLE_MS)))]);
      clearTimeout(timer);
      // A script's request was held first: the form the same step submits, if any, takes its place.
      if (op.held && op.held.rank < 3) await new Promise((r) => setTimeout(r, FORM_GRACE_MS));
    } catch (err) {
      op.open = false;
      s.op = null;
      if (op.held) await op.held.route.abort('blockedbyclient').catch(() => {});
      throw err;
    }
    op.open = false;
    s.op = null;
    if (!op.held) return { outcome: 'done', message: `${doneText} The page sent nothing. Use read to see the page.`, page: await this.#pageInfo(s) };
    return this.#approve(botId, tokenId, s, op.held, op.cookies, what);
  }

  /**
   * What is bound for a held request: the request as Chromium would send it, with its headers read first and the whole
   * jar after, its cookies judged by heldCookies against the jar as the step began (`start`) and now, or why it can't
   * go (it carries a cookie the browser didn't hold for its address).
   */
  async #readHeld(botId: string, s: Session, request: Request, start: Cookie[] | null, seen?: (jar: Cookie[]) => void): Promise<HeldRequest | { why: string }> {
    const headers = await request.allHeaders();
    await this.testGate?.('held', botId);
    const now = await s.context.cookies();
    seen?.(now);
    const cookies = heldCookies(headers.cookie, request.url(), start, now);
    if ('why' in cookies) return cookies;
    return { method: request.method().toUpperCase(), url: request.url(), headers, body: request.postDataBuffer(), changed: cookies.changed };
  }

  /** A held request: its card, the owner's decision, and, if allowed while still bound, the one send. */
  async #approve(botId: string, tokenId: string, s: Session, held: { route: Route; request: Request }, start: Cookie[] | null, what: string): Promise<BrowserActionResult> {
    const owner = this.#deps.store.getSettings().ownerName;
    const { route, request } = held;
    const abort = () => route.abort('blockedbyclient').catch(() => {});
    const info = async () => this.#pageInfo(s).catch(() => null);
    const site = (() => {
      try {
        return new URL(request.url()).host;
      } catch {
        return 'the site';
      }
    })();
    // Botons' own words for a request it didn't send, and the way on: the owner takes over and does that step.
    const paused = (what: string, why: string) =>
      `Botons paused a request ${site} tried to send (${what}): not sent, because ${why}. Nothing reached the site. If ${owner} can do this step in the page, call browser_handoff so they can take over.`;
    const revision = s.revision;
    const binding: Binding = { botId, tokenId, session: s.id, revision };
    let read: HeldRequest | { why: string };
    let heldJar: Cookie[] = [];
    try {
      read = await this.#readHeld(botId, s, request, start, (jar) => (heldJar = jar));
    } catch {
      await abort();
      return { outcome: 'refused', message: "The page's request could not be read, so it was not sent.", page: await info() };
    }
    if ('why' in read) {
      await abort();
      return { outcome: 'refused', message: paused(`${request.method().toUpperCase()} ${displayUrl(request.url())}`, read.why), page: await info() };
    }
    const req = read;
    const where = `${req.method} ${displayUrl(req.url)}`;
    const key = fingerprint(binding, req);
    const card = describeRequest(req, `the ${shown(what)}`, key);
    if ('why' in card) {
      await abort();
      return { outcome: 'refused', message: paused(where, card.why), page: await info() };
    }
    const waitUntil = new Date(Date.now() + this.#deps.cfg.approvalWaitMs).toISOString();
    let approvalId: string;
    try {
      approvalId = this.#deps.approvals.browserRequest(botId, { ...card, input: { method: req.method, url: displayUrl(req.url), request: key.slice(0, 16) }, key, waitUntil }).id;
    } catch (err) {
      await abort();
      return { outcome: 'refused', message: paused(where, `no card could be made (${(err as Error).message})`), page: await info() };
    }
    this.#journal(botId, { action: 'blocked', url: displayUrl(req.url), outcome: 'refused', detail: `${req.method} held for ${owner}'s card ${approvalId}` });

    // The wait: the owner's decision, the card's time running out, or the browser closing (the turn's end, Stop).
    const waiting = new Promise<'decided' | 'time' | 'closed'>((resolve) => {
      const finish = (why: 'decided' | 'time' | 'closed') => {
        clearTimeout(timer);
        this.#waits.delete(approvalId);
        s.endWait = null;
        resolve(why);
      };
      const timer = setTimeout(() => finish('time'), Math.max(0, Date.parse(waitUntil) - Date.now()));
      this.#waits.set(approvalId, () => finish('decided'));
      s.endWait = () => finish('closed');
      if (s.closed) finish('closed');
    });
    await this.testGate?.('card', botId);
    const ended = await waiting;
    const result = (outcome: 'done' | 'refused', message: string, delivery: 'sent' | 'not-sent' | 'unknown', page: BrowserActionResult['page']): BrowserActionResult => {
      const a = this.#deps.approvals.find(approvalId);
      return { outcome, message, page, approval: { id: approvalId, status: a?.status ?? 'cancelled', delivery } };
    };
    if (ended !== 'decided') this.#deps.approvals.endBrowserWait(approvalId, ended);
    const a = this.#deps.approvals.get(approvalId);
    if (a.status !== 'allowed') {
      await abort();
      const note = a.note ? ` ${owner}'s note: ${a.note}` : '';
      const message =
        a.status === 'denied'
          ? `${owner} denied sending ${where} (card ${approvalId}).${note} It was not sent. Don't send it another way.`
          : `Not sent: ${ended === 'time' ? `${owner} didn't decide in time` : ended === 'closed' ? 'the browser closed' : 'the card was withdrawn'} (card ${approvalId}).`;
      this.#journal(botId, { action: 'blocked', url: displayUrl(req.url), outcome: 'refused', detail: `${req.method} not sent: card ${approvalId} ${a.status}` });
      return result('refused', message, 'not-sent', await info());
    }

    // Allowed: checked again right before it goes (this turn, this browser, this document, its site, the request, its
    // cookies still ones the browser held), then spent once. What goes is the card's request, byte for byte.
    const live = () =>
      this.#turns.get(botId) !== tokenId || !this.enabled(botId)
        ? 'the browser was turned off or the turn ended'
        : s.closed || this.#sessions.get(botId) === undefined
          ? 'the browser closed'
          : s.revision !== revision
            ? 'the page changed while the card waited'
            : !judgeRequest(req.url, 'GET', this.sites(botId)).ok
              ? `${displayUrl(req.url)} is no longer one of the allowed sites`
              : null;
    // Read again with the jar as it is now: a site's own cookie churn is fine, a different request is not.
    let again: HeldRequest | { why: string } | null = null;
    try {
      // Against what the browser held as the step began and as the card was made: a later change of the site's own
      // cookies doesn't take back what it held then.
      again = await this.#readHeld(botId, s, request, start && [...start, ...heldJar]);
    } catch {}
    const problem =
      live() ??
      (!again
        ? 'the request could not be read again'
        : 'why' in again
          ? `${again.why} any more (a sign-out, say): click again for a new card`
          : sameRequest(req, again));
    if (problem || !this.#deps.approvals.spendBrowser(approvalId, key)) {
      await abort();
      const why = problem ?? 'its card was already used';
      this.#journal(botId, { action: 'blocked', url: displayUrl(req.url), outcome: 'refused', detail: `${req.method} allowed but not sent: ${why}` });
      return result('refused', `${owner} allowed it, but it was not sent: ${why}.`, 'not-sent', await info());
    }

    // Sent from here, exactly as held (the headers and body it was bound to, no cookie added), through the browser's proxy.
    const sending = new AbortController();
    s.sending = sending;
    const target = new URL(req.url);
    const d = await sendHeld({
      proxy: { port: s.proxy.port, ...s.proxy.passOnce(target.hostname.replace(/^\[|\]$/g, ''), portOf(target)) },
      method: req.method,
      url: req.url,
      headers: wireHeaders(req),
      body: req.body,
      ready: live,
      signal: sending.signal,
      timeoutMs: ACTION_TIMEOUT_MS,
      maxBody: ANSWER_MAX,
      ca: this.testTrust?.cert,
    }).finally(() => {
      if (s.sending === sending) s.sending = null;
    });
    this.#deps.approvals.browserDelivered(approvalId, d.delivery);
    log.info('browser request sent', { botId, approvalId, delivery: d.delivery, status: d.delivery === 'sent' ? d.status : undefined });
    if (d.delivery === 'not-sent') {
      await abort();
      this.#journal(botId, { action: 'sent', url: displayUrl(req.url), outcome: 'refused', detail: `${req.method} allowed on card ${approvalId}; not sent: ${d.why}` });
      return result('refused', `${owner} allowed it, but it was not sent: ${d.why}. Nothing reached the site.`, 'not-sent', await info());
    }
    if (d.delivery === 'unknown') {
      await route.abort('failed').catch(() => {});
      this.#journal(botId, { action: 'sent', url: displayUrl(req.url), outcome: 'refused', detail: `${req.method} allowed on card ${approvalId}; delivery unknown: ${d.why}` });
      return result(
        'refused',
        `${owner} allowed it and it was sent, but ${d.why}: it may have reached ${new URL(req.url).host} and been acted on. Don't send it again or another way: tell ${owner}, who can check on the site.`,
        'unknown',
        await info(),
      );
    }
    const status = d.status;
    const location = d.headers.find(([k]) => k === 'location')?.[1];
    // A redirect is never followed from here: a 307 or 308 would send it again, and anything else would be a request
    // from the page acted on. Its address is said, to open if wanted (in a new browser, as a read).
    let next: string | null = null;
    if (status >= 300 && status < 400 && location) {
      try {
        next = new URL(location, req.url).href;
      } catch {}
    }
    const resends = !!next && (status === 307 || status === 308);
    let answered = false;
    if (!next && d.body) {
      try {
        const answer = answerOf(d.status, d.headers, d.body);
        await route.fulfill(answer);
        answered = true;
      } catch {}
    }
    if (!answered) await abort();
    await s.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    this.#journal(botId, { action: 'sent', url: displayUrl(req.url), outcome: 'done', detail: `${req.method} sent once (HTTP ${status}), allowed on card ${approvalId}` });
    const onward = next && judgeRequest(next, 'GET', this.sites(botId)).ok ? ` It points to ${displayUrl(next)}: open that address to see where it led.` : '';
    const tail = resends
      ? `The site answered with a redirect that would send it again, which the browser did not follow.${onward}`
      : next
        ? `The site answered with a redirect, which the browser did not follow from the page it acted on.${onward}`
        : answered
        ? 'Use read to see the page.'
        : 'Its answer was cut, too large or could not be read, so the page did not get it.';
    return result('done', `${owner} allowed it on a card: sent ${where} once (HTTP ${status}). ${tail}`, 'sent', await info());
  }

  /** Loads an address in the page, or in a new browser if the page was acted on (so that page sends nothing more). */
  async #open(botId: string, s: Session, url: string, doneText: string): Promise<BrowserActionResult> {
    if (s.actedOn) {
      // Closed meanwhile (the turn ended, Stop): no new browser is started for it.
      if (s.closed || !this.#turns.has(botId) || !this.enabled(botId) || this.#handovers.has(botId)) return { outcome: 'refused', message: 'The browser closed.', page: null };
      const starting = this.#replace(botId, s);
      s = await starting;
      if (this.#sessions.get(botId) !== starting || s.closed) return { outcome: 'refused', message: 'The browser closed.', page: null };
    }
    // The main frame's last navigation request: where it ended after any redirect, failed or answered.
    const seen: { nav: Request | null } = { nav: null };
    const onRequest = (r: Request) => {
      try {
        if (r.isNavigationRequest() && r.frame() === s.page.mainFrame()) seen.nav = r;
      } catch {}
    };
    s.page.on('request', onRequest);
    const res = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }).catch((err: Error) => err);
    s.page.off('request', onRequest);
    const last = res instanceof Error ? seen.nav : (res?.request() ?? seen.nav);
    // Botons answered, not the site: say what it said (a block by Botons, or a site it couldn't reach).
    const why = navigationAnswer(
      { url: last?.url() ?? url, failed: res instanceof Error, mark: res instanceof Error ? null : (res?.headers()['x-botons-proxy'] ?? null), request: last },
      s,
    );
    if (why) return { outcome: 'refused', message: `${displayUrl(url)} didn't load: ${why}`, page: await this.#pageInfo(s).catch(() => null) };
    if (res instanceof Error) return { outcome: 'refused', message: `${displayUrl(url)} didn't load: ${failureOf(res)}.`, page: await this.#pageInfo(s).catch(() => null) };
    const status = res?.status();
    // The site's own answer, error pages included: a 403 here is the site's, never a block by Botons.
    if (status && status >= 400) return { outcome: 'done', message: `${doneText}, but the site itself answered HTTP ${status} (its own error page, not a block by Botons). Use read to see the page.`, page: await this.#pageInfo(s) };
    return { outcome: 'done', message: `${doneText} (HTTP ${status ?? '—'}). Use read to see the page.`, page: await this.#pageInfo(s) };
  }

  async #pageInfo(s: Session): Promise<{ url: string; title: string }> {
    return { url: displayUrl(s.page.url()), title: (await s.page.title().catch(() => '')).slice(0, 200) };
  }

  async #run(botId: string, tokenId: string, s: Session, action: BrowserActionName, input: BrowserActionInput, sites: string[]): Promise<BrowserActionResult> {
    const owner = this.#deps.store.getSettings().ownerName;
    const done = async (message: string): Promise<BrowserActionResult> => ({ outcome: 'done', message, page: await this.#pageInfo(s) });
    switch (action) {
      case 'open': {
        if (typeof input.url !== 'string' || !input.url.trim()) throw new HttpError(400, 'open needs a url');
        let u: URL;
        try {
          u = new URL(input.url.trim());
        } catch {
          return { outcome: 'refused', message: 'That is not an address (use https://…).', page: null };
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return { outcome: 'refused', message: 'The browser opens only http:// and https:// addresses.', page: null };
        const v = judgeRequest(u.href, 'GET', sites);
        if (!v.ok) return { outcome: 'refused', message: `Not opened: ${v.why}. ${owner} chooses the sites in your settings.`, page: null };
        return this.#open(botId, s, u.href, 'Opened');
      }
      case 'back': {
        if (!s.actedOn) {
          await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
          return done('Went back. Use read to see the page.');
        }
        // From a page acted on, the address before it, in a new browser: the old page's script never runs again.
        s.trail.pop();
        const before = s.trail.pop();
        if (!before || !judgeRequest(before, 'GET', sites).ok) return { outcome: 'refused', message: 'There is no page to go back to: open an address instead.', page: await this.#pageInfo(s) };
        return this.#open(botId, s, before, 'Went back to the page before, in a new browser');
      }
      case 'read': {
        const text = ((await s.page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')) ?? '').replace(/\n{3,}/g, '\n\n');
        // Links it may open next: only to the listed sites, by their full address (open takes it as it is).
        const all = await s.page
          .locator('a[href]')
          .evaluateAll((els) => els.slice(0, 2000).map((el) => ({ text: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 200), url: (el as HTMLAnchorElement).href })))
          .catch(() => [] as { text: string; url: string }[]);
        const links = all.filter((l) => /^https?:/.test(l.url) && judgeRequest(l.url, 'GET', sites).ok).slice(0, MAX_LINKS);
        const truncated = text.length > MAX_TEXT;
        // Its controls, by ref, for click and type: valid until the page changes (the document they were read on).
        const revision = s.revision;
        const list = await listControls(s.page);
        s.controls = { revision, list };
        const controls: BrowserControl[] = list
          .filter((c) => c.kind !== 'link' || judgeRequest(c.href, 'GET', sites).ok)
          .map((c) => ({ ref: `e${c.index}`, kind: c.kind, label: c.label, noTyping: c.kind === 'field' ? typingProblem(c) : null }));
        return {
          ...(await done(`Read the page: ${links.length} links to allowed sites, ${controls.length} controls.`)),
          content: { text: text.slice(0, MAX_TEXT), links, controls, truncated },
        };
      }
      case 'click':
      case 'type': {
        const found = await this.#control(s, input.ref);
        if (typeof found === 'string') return { outcome: 'refused', message: found, page: await this.#pageInfo(s) };
        const { control, locator } = found;
        const what = `${control.kind} ${JSON.stringify(control.label || control.name || '(no label)')}`;
        // A link to an allowed site: its address is opened, as open would, without the page's script for the click.
        if (action === 'click' && control.tag === 'a' && /^https?:/.test(control.href) && judgeRequest(control.href, 'GET', sites).ok) {
          return this.#open(botId, s, control.href, `Opened the address of the ${what} (the browser opens a link's address; it doesn't run the page's script for the click)`);
        }
        if (action === 'type') {
          const problem = typingProblem(control);
          if (problem) return { outcome: 'refused', message: `Not typed: ${problem}. Botons never types passwords, codes, card numbers or other secrets; ${owner} signs in for you.`, page: await this.#pageInfo(s) };
          const text = input.text;
          if (typeof text !== 'string') throw new HttpError(400, 'type needs text');
          if (text.length > MAX_TYPED) return { outcome: 'refused', message: `Not typed: at most ${MAX_TYPED} characters.`, page: await this.#pageInfo(s) };
          if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text) || (control.tag !== 'textarea' && /[\n\r]/.test(text))) {
            return { outcome: 'refused', message: 'Not typed: the text has control characters (or a new line, in a one-line field).', page: await this.#pageInfo(s) };
          }
          // fill() puts the text in and presses nothing: no Enter, so typing alone never submits a form.
          return this.#operate(botId, tokenId, s, what, () => locator.fill(text, { timeout: ACTION_TIMEOUT_MS }), `Typed into the ${what}.`);
        }
        return this.#operate(botId, tokenId, s, what, () => locator.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true }), `Clicked the ${what}.`);
      }
      case 'screenshot': {
        const bot = this.#deps.store.getBot(botId);
        const bytes = await s.page.screenshot({ type: 'png', timeout: ACTION_TIMEOUT_MS });
        return screenshotToChat(this.#deps.share, bot, bytes, await this.#pageInfo(s));
      }
      case 'handoff':
        // Answered in #act, before any browser opens.
        throw new HttpError(400, 'handoff is not a step of the page');
    }
  }
}

/** In the page: what a control says of itself (all of it the site's own text). */
function describeControl(el: Element): Omit<Control, 'index'> {
  const e = el as HTMLInputElement;
  const tag = e.tagName.toLowerCase();
  const type = (e.getAttribute('type') ?? '').toLowerCase();
  const role = (e.getAttribute('role') ?? '').toLowerCase();
  const labels = e.labels ? Array.from(e.labels).map((l) => (l as HTMLElement).innerText).join(' ') : '';
  const button = tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type);
  const label = (e.getAttribute('aria-label') || labels || e.getAttribute('placeholder') || (tag === 'input' ? '' : (e as unknown as HTMLElement).innerText) || (button ? e.value : '') || e.getAttribute('title') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const kind =
    tag === 'a' || role === 'link'
      ? 'link'
      : tag === 'button' || role === 'button' || button
        ? 'button'
        : (tag === 'input' && (type === 'checkbox' || type === 'radio')) || role === 'checkbox'
          ? 'checkbox'
          : tag === 'textarea' || (tag === 'input' && ['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(type))
            ? 'field'
            : 'other';
  return { tag, type, name: e.getAttribute('name') ?? '', id: e.id ?? '', autocomplete: e.getAttribute('autocomplete') ?? '', label, kind, href: tag === 'a' ? (e as unknown as HTMLAnchorElement).href : '' };
}

/** What must stay the same for a ref to still name its control. */
const sameControl = (c: Omit<Control, 'index'>) => JSON.stringify([c.tag, c.type, c.name, c.id, c.autocomplete, c.label, c.kind, c.href]);

/** Each new document of the page's main frame: refs and cards from before no longer apply, and its address is kept for back. */
function watchPage(s: Session, page: Page): void {
  page.on('framenavigated', (f) => {
    if (s.page !== page || f !== page.mainFrame()) return;
    s.revision++;
    const url = f.url();
    if (/^https?:/.test(url) && s.trail.at(-1) !== url) s.trail.push(url);
    if (s.trail.length > 50) s.trail.shift();
  });
}

/** An allowed request's answer, for the page: decoded (it was asked for as Chromium asked), its framing headers dropped. */
function answerOf(status: number, raw: [string, string][], body: Buffer): { status: number; headers: Record<string, string>; body: Buffer } {
  const headers: Record<string, string> = {};
  for (const [k, v] of raw) headers[k] = k in headers ? `${headers[k]}\n${v}` : v;
  let out = body;
  const enc = (headers['content-encoding'] ?? '').trim().toLowerCase();
  const decode: Record<string, (b: Buffer) => Buffer> = {
    gzip: (b) => gunzipSync(b, { maxOutputLength: ANSWER_MAX }),
    'x-gzip': (b) => gunzipSync(b, { maxOutputLength: ANSWER_MAX }),
    deflate: (b) => inflateSync(b, { maxOutputLength: ANSWER_MAX }),
    br: (b) => brotliDecompressSync(b, { maxOutputLength: ANSWER_MAX }),
    zstd: (b) => zstdDecompressSync(b, { maxOutputLength: ANSWER_MAX }),
  };
  if (enc && enc !== 'identity') {
    const d = decode[enc];
    if (!d) throw new Error(`an answer in ${enc}`);
    out = d(body);
  }
  for (const k of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) delete headers[k];
  return { status, headers, body: out };
}

/** The controls of the page's main document, as read lists them: shown and enabled ones, at most MAX_CONTROLS. */
async function listControls(page: Page): Promise<Control[]> {
  const all = await page
    .locator(CONTROLS)
    .evaluateAll(
      (els, max) =>
        els.slice(0, 2000).flatMap((el, index) => {
          const e = el as HTMLElement & { disabled?: boolean };
          const shown = !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && !e.disabled;
          return shown && index < max ? [index] : [];
        }),
      MAX_CONTROLS * 4,
    )
    .catch(() => [] as number[]);
  const out: Control[] = [];
  for (const index of all.slice(0, MAX_CONTROLS)) {
    const d = await page.locator(CONTROLS).nth(index).evaluate(describeControl, null).catch(() => null);
    if (d) out.push({ ...d, index });
  }
  return out;
}

let playwright: Promise<Playwright | null> | null = null;

export function loadPlaywright(): Promise<Playwright | null> {
  playwright ??= import('playwright-core').then(
    (m) => (m as unknown as { default?: Playwright }).default ?? (m as unknown as Playwright),
    () => null,
  );
  return playwright;
}

/** The library and the Chromium the browser would run: BOTONS_BROWSER_PATH (`path`), else Playwright's, else the system's. */
export async function findBrowser(path: string): Promise<Availability> {
  const pw = await loadPlaywright();
  if (!pw) return { available: false, why: 'The browser library (playwright-core) is not installed with this server: run npm ci.', executable: null };
  let exe: string | null;
  if (path) exe = existsSync(path) ? path : null;
  else {
    let bundled = '';
    try {
      bundled = pw.chromium.executablePath();
    } catch {}
    exe = [bundled, ...DEFAULT_PATHS].find((p) => p && existsSync(p)) ?? null;
  }
  if (!exe) {
    return {
      available: false,
      why: path
        ? `BOTONS_BROWSER_PATH is ${path}, which is not there.`
        : 'No Chromium found on this computer: install one (the chromium package, or npx playwright-core install chromium) or set BOTONS_BROWSER_PATH.',
      executable: null,
    };
  }
  return { available: true, why: null, executable: exe };
}

/**
 * Chromium's own password manager and autofill off in the profile, before it starts: a sign-in the owner types in a
 * handover leaves cookies, never a saved password (which, without a keyring, Chromium keeps under a fixed key) or
 * the fields' values for autofill, and Chromium never checks it against its leak service (which the proxy would
 * refuse anyway). Its other preferences are kept as they are.
 */
export function keepNoCredentials(profile: string): void {
  const file = join(profile, 'Default', 'Preferences');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let prefs: Record<string, any> = {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) prefs = v;
  } catch {}
  const obj = (k: string) => (prefs[k] && typeof prefs[k] === 'object' && !Array.isArray(prefs[k]) ? prefs[k] : (prefs[k] = {}));
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  Object.assign(obj('profile'), { password_manager_enabled: false, password_manager_leak_detection: false });
  Object.assign(obj('autofill'), { enabled: false, profile_enabled: false, credit_card_enabled: false });
  writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
}

/** The user agent each Chromium (by its path and when it was installed) reports, its headless mark taken out. */
const agents = new Map<string, Promise<string | null>>();

/**
 * The running Chromium's own user agent without its headless mark (withoutHeadless), asked of it once per executable
 * (started headless with no profile, opening no page, behind a proxy of its own that lets nothing out), or null if
 * it couldn't be asked. Its version and platform are the browser's own, never written here.
 */
function headfulAgent(pw: Playwright, executable: string, sandbox: boolean): Promise<string | null> {
  let stamp = '';
  try {
    stamp = String(statSync(executable).mtimeMs);
  } catch {}
  const key = `${executable}\0${stamp}\0${sandbox}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = (async () => {
      const shut = await startBrowserProxy(() => ({ enabled: false, sites: [] }), () => {});
      try {
        const proxy = { server: `http://127.0.0.1:${shut.port}`, bypass: '<-loopback>', username: shut.username, password: shut.password };
        const browser = await pw.chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: sandbox, proxy, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-extensions'] });
        try {
          const cdp = await browser.newBrowserCDPSession();
          const v = (await cdp.send('Browser.getVersion')) as { userAgent?: string };
          return typeof v.userAgent === 'string' && v.userAgent ? withoutHeadless(v.userAgent) : null;
        } finally {
          await browser.close().catch(() => {});
        }
      } finally {
        await shut.close();
      }
    })().catch((err) => {
      log.warn('the browser did not say its user agent: it keeps its headless one', { err });
      agents.delete(key);
      return null;
    });
    agents.set(key, agent);
  }
  return agent;
}

/**
 * Starts Chromium on `profile` with every guard the managed browser has: its own proxy (browser-proxy.ts), routing
 * that lets only reads to the policy's sites leave, no WebSockets, one tab, dialogs dismissed, downloads and file
 * pickers refused, service workers blocked, QUIC and direct WebRTC UDP off, and Chromium's sandbox unless the
 * operator turned it off. The server's turns and `npm run check:browser` both start it this way.
 */
export async function openGuarded(
  pw: Playwright,
  profile: string,
  o: {
    executable: string;
    sandbox: boolean;
    headless: boolean;
    policy: () => ProxyPolicy;
    /** A refusal: by the proxy, or by the routing (with the request it refused). */
    note: (url: string, why: string, request?: Request) => void;
    onDownload?: (url: string) => void;
    /**
     * Each request to an allowed site that is a read or a write a card could send (`write`): `pass` loads a read,
     * `held` keeps it for a card (neither sent nor refused yet), `send` lets a write go (only the owner's handover,
     * right after the owner's own input), a reason refuses it, null leaves it to the default (reads load, writes are
     * refused).
     */
    gate?: (route: Route, request: Request, write: boolean) => 'pass' | 'held' | 'send' | string | null;
    /** The page's size (the owner's handover clicks in these coordinates). */
    viewport?: { width: number; height: number };
    /** Tests only: the certificate of their own HTTPS site, which the proxy then accepts (besides the system's roots). */
    trustCa?: string[];
    /** Each write as it leaves the proxy (only the owner's handover lets one go). */
    onWrite?: (url: string, method: string) => void;
    /** A site its proxy could not reach (not found, no address answered): never said as a block. */
    onUnreachable?: (url: string, message: string) => void;
  },
): Promise<{ context: Context; page: Page; proxy: BrowserProxy }> {
  const note = o.note;
  // Its own home beside the profile, and only the environment it needs: none of the server's settings or secrets.
  const home = join(dirname(profile), 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share') };
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', ...(o.headless ? [] : ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'])]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  keepNoCredentials(profile);
  // Its HTTPS always ends at its proxy, with a certificate made for this one browser, which this Chromium alone trusts
  // (and no other certificate error): so the proxy judges every request inside, whatever in Chromium sent it, routing
  // seen or not (browser-proxy.ts). No browser opened here gets a tunnel straight to a site.
  const own = interceptCert();
  const proxy = await startBrowserProxy(o.policy, note, { intercept: { key: own.key, cert: own.cert, ca: o.trustCa }, onWrite: o.onWrite, onUnreachable: o.onUnreachable });
  let context: Context;
  try {
    const proxySetting = { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>', username: proxy.username, password: proxy.password };
    const userAgent = o.headless ? await headfulAgent(pw, o.executable, o.sandbox) : null;
    context = await pw.chromium.launchPersistentContext(profile, {
      ...(userAgent ? { userAgent } : {}),
      executablePath: o.executable,
      headless: o.headless,
      env,
      // Playwright turns Chromium's sandbox off unless asked: a page's exploit would get the server's user.
      chromiumSandbox: o.sandbox,
      // Loopback too: Chromium would otherwise reach this computer's own services without the proxy.
      proxy: proxySetting,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: o.viewport ?? { width: 1280, height: 800 },
      args: [
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--dns-prefetch-disable',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-update',
        '--no-first-run',
        '--no-default-browser-check',
        // Chromium's own calls home (including search preconnects and AI eligibility on startup/cookie changes) fill the journal.
        // No back-forward cache and no fetchLater: a page left behind is gone, and sends nothing after it is.
        '--disable-features=AutofillServerCommunication,OptimizationHints,AimEligibilityServiceIdentityImprovements,AimUrlNavigationFetchEnabled,AimServerRequestOnStartupEnabled,AimServerRequestOnIdentityChangeEnabled,PreconnectToSearch,PreconnectFromKeyedService,Translate,MediaRouter,BackForwardCache,FetchLaterAPI,PasswordLeakDetection',
        '--disable-client-side-phishing-detection',
        `--ignore-certificate-errors-spki-list=${own.spki}`,
      ],
    });
  } catch (err) {
    await proxy.close();
    throw err;
  }
  try {
    await context.route('**/*', (route, request) => {
      const p = o.policy();
      const v = p.enabled ? judgeRequest(request.url(), request.method(), p.sites) : { ok: false as const, why: 'the browser is turned off' };
      const write = !v.ok && 'write' in v && !!v.write;
      const g = (v.ok || write) && o.gate ? o.gate(route, request, write) : null;
      if (g === 'held') return;
      if (write && g === 'send') return route.continue();
      if (v.ok && (g === null || g === 'pass')) return route.continue();
      note(request.url(), g && g !== 'pass' ? g : (v as { why: string }).why, request);
      return route.abort('blockedbyclient');
    });
    // A WebSocket sends whatever a page likes, so none connects: each is closed here, before the server sees it.
    await context.routeWebSocket(
      () => true,
      (ws) => {
        note(ws.url(), 'WebSockets are not for this browser: it only reads pages');
        void ws.close({ code: 1008, reason: 'Blocked by Botons' }).catch(() => {});
      },
    );
    const guard = (page: Page) => {
      page.on('dialog', (d) => void d.dismiss().catch(() => {}));
      page.on('download', (d) => {
        o.onDownload?.(d.url());
        void d.cancel().catch(() => {});
      });
      page.on('filechooser', () => note(page.url(), 'the page asked for a file to upload, which the browser never gives'));
    };
    const current = context.pages()[0] ?? (await context.newPage());
    context.on('page', (p) => {
      if (p === current) return;
      // One tab: another (a popup, target=_blank) is closed, and said so.
      note(p.url() || 'about:blank', 'the page opened another tab, which was closed (open its address instead)');
      void p.close().catch(() => {});
    });
    guard(current);
    context.on('close', () => void proxy.close());
    return { context, page: current, proxy };
  } catch (err) {
    await context.close().catch(() => {});
    await proxy.close();
    throw err;
  }
}
