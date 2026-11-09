import { createHash } from 'node:crypto';
import { isLegacySetting } from '../../shared/legacy-names.mjs';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Connector, ConnectorCatalog, ConnectorGrant, ConnectorNotice, ConnectorOff, ConnectorPolicyInput, ConnectorTest, McpServer, McpServerInput, BotonConnector } from '../../shared/types.ts';
import { connectorJail, type Jail, type LaunchPolicy, release, releaseAll } from './connector-launch.ts';
import { log } from './log.ts';
import { McpError, McpSession, secretsOf } from './mcp-client.ts';
import { sanitize } from './secrets.ts';
import { OAuthError } from './oauth.ts';
import type { OAuthConnections } from './oauth-connections.ts';
import { refusedOutbound } from './outbound.ts';
import type { ProviderRegistry } from './providers/index.ts';
import type { McpStartup, Provider, TurnMcpServer } from './providers/types.ts';
import { HttpError, type Store } from './store.ts';
import { BROWSER_CONNECTOR, BROWSER_SERVER } from '../../shared/util.ts';
import { presetFor, TOKEN_AS_NAME, tokenShapedName } from '../../shared/services.ts';
import { authorizationOf, GITHUB_PUBLIC_ONLY, GITHUB_REJECTED, githubAccess } from './github-access.ts';
import { drivesBrowser } from './browser-policy.ts';
import { nowIso, parseJson, type Row, strings } from './util.ts';

/*
 * The MCP servers a Boton can opt in to, all managed here: the library ("lib:<name>") and OAuth connectors
 * ("oauth:<name>"). Nothing reads a provider CLI's own MCP setup: each turn's CLI gets only the servers passed to
 * it, so a connector works the same whichever brain a Boton has. Secrets stay in the database and are only read
 * back to start a turn; the API returns names and targets only. A Boton's own list (bots.connections) is what it
 * has; a connector the owner makes available on request can be added to it by `botons connector request`.
 *
 * The owner can turn a connector off without deleting anything (setEnabled): its setup, secrets, OAuth sign-in and
 * grants stay, but resolve() leaves it out of every turn, no Boton may ask for it, cards asked before can't be
 * allowed, and the work feed isn't read. Turning it on again restores exactly the grants it had, and nothing more.
 * Off is a row in `settings` (offKey), so it needs no table of its own.
 *
 * One library connector is built in rather than added: the managed browser (BROWSER_CONNECTOR, browser.ts). Its
 * server is fixed by Botons (no command, args or env to edit), it can't be asked for, and the library's own entries
 * can't take its name.
 */

/** The built-in browser connector, as browser.ts provides it. */
export interface ManagedBrowser {
  server(): TurnMcpServer;
  /** Why turns can't use it now (no Chromium, say), or null; null too before the server has looked. */
  unavailable(): string | null;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const MAX_ENTRIES = 20;
const MAX_VALUE = 4000;
export const MAX_CONNECTIONS = 50;
/** The connectors that count toward MAX_CONNECTIONS: every new Boton has the built-in browser, so it never takes a place. */
export const countedConnections = (ids: readonly string[]): number => ids.filter((id) => id !== BROWSER_CONNECTOR).length;
const TEST_TIMEOUT_MS = 30_000;
const TEST_TOOLS = 100;

/*
 * What each kind of connector's status rests on. Only the library's http servers and OAuth connectors can be tested
 * from the server: a stdio command starts only in a Boton's turn (as the server's user, not sandboxed).
 */
const BASIS = {
  stdio:
    "Saved here. Its command starts only inside a Boton's turn, so Botons doesn't run it to test it. Whichever Boton has it, it starts in the Workspace sandbox's view of this computer (its programs, read-only), with this computer's network, the folders its command and arguments name, and no workspace, shared folder or home folder. Which Botons have it and the environment you give it are what it is handed, not what confines it.",
  http: 'Saved here, not checked until you test it: Botons connects to it and lists its tools.',
  oauth: 'Signed in from this computer. Test it to list its tools with the current token.',
  oauthOff: 'Not usable until it is signed in.',
};

const TRIED =
  "Botons' server tried to connect to it from this computer and list its tools. A Boton's turn connects separately, through its own Claude Code or Codex, so this usually means the Boton can't use it either.";

const REACHED =
  "Botons' server connected to it from this computer and listed its tools. A Boton's turn connects again through its own Claude Code or Codex, which can still leave it out (see the server log); that part is checked only in a turn.";

const GITHUB_CHECKED = `${REACHED} It also asked GitHub whether the token can see a private repository.`;
const GITHUB_PRIVATE = `${GITHUB_CHECKED} The token sees a private repository; this does not prove it may read its contents.`;

/** Secrets included: never sent to clients. */
interface LibraryRow {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

/** For display, without a query or credentials, which might be secrets. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return url ? '(invalid URL)' : '(no URL)';
  }
}

export interface ResolvedConnectors {
  servers: TurnMcpServer[];
  skipped: { id: string; reason: string }[];
  /** Each server's connector id, by the name the CLI sees it under. */
  ids: Record<string, string>;
  /** The local connectors' launch files (connector-launch.ts), removed with release() when the turn ends. */
  launchFiles?: string[];
}

export interface ConnectorPolicy {
  onRequest: boolean;
  grant: ConnectorGrant;
  generation: number;
}

/** The settings row that says a connector is off (`ConnectorOff` as JSON); none while it is on. */
export const offKey = (id: string) => `connector_off:${id}`;

/** Why a turn goes without a connector the owner turned off: in the owner's notices and the Boton's own turn. */
export const OFF_REASON = 'turned off by the owner in Settings → Connectors';

const NO_POLICY: ConnectorPolicy = { onRequest: false, grant: 'approval', generation: 0 };

/*
 * A request policy's generation is its authority: a card or a connector request records the one it was asked under,
 * and is allowed only while the connector's policy still has it. Every generation is issued here, negative and below
 * every one issued before on this install, so none is ever issued twice: rows are never deleted (a deleted
 * connector's stays, off request, see retirePolicy), so the lowest only falls, whatever is deleted, added again or
 * switched. Nothing issues 0 or a positive generation, and one of those can't be told from the generation another
 * setup under the same name had: a record holding one (or none) is never allowed, and the Boton asks again.
 */
const NEXT_GENERATION = '(select min(0, coalesce(min(generation), 0)) - 1 from connector_policies)';

/** A recorded generation that can still be allowed: one issued as above. */
export const issuedGeneration = (g: unknown): g is number => typeof g === 'number' && Number.isSafeInteger(g) && g < 0;

/** Inside the caller's transaction: connector `id`'s policy gets a new generation, and `set` if given. */
function issuePolicy(db: DatabaseSync, id: string, set: { onRequest: boolean; grant: ConnectorGrant } | null): void {
  db.prepare(
    `insert into connector_policies (connector_id, on_request, grant_mode, generation, updated_at) values (?, ?, ?, ${NEXT_GENERATION}, ?)
       on conflict(connector_id) do update set ${set ? 'on_request = excluded.on_request, grant_mode = excluded.grant_mode, ' : ''}generation = excluded.generation, updated_at = excluded.updated_at`,
  ).run(id, set?.onRequest ? 1 : 0, set?.grant ?? 'approval', nowIso());
}

/**
 * A connector is deleted: its request policy goes back to off at a new generation, in the same transaction. The row
 * stays, so a connector added again under the same id starts off request, and no card or request asked for the
 * deleted one matches it, even with the very same setup.
 */
export function retirePolicy(db: DatabaseSync, id: string): void {
  issuePolicy(db, id, { onRequest: false, grant: 'approval' });
}

/** At start: a policy whose generation was not issued as above gets one, so what is asked from now on can be allowed. */
export function issueGenerations(db: DatabaseSync): void {
  for (const r of db.prepare('select connector_id from connector_policies where generation >= 0').all() as Row[]) issuePolicy(db, String(r.connector_id), null);
}

export class Connectors {
  #db: DatabaseSync;
  #providers: ProviderRegistry;
  #store: Pick<Store, 'dropFromBots' | 'atomically'>;
  /** For turn files with secrets. Files a crashed turn left are deleted at start. */
  readonly privateDir: string;
  /** The local connectors' launch files and socket filter (connector-launch.ts): private, no Boton can write it. */
  readonly launchDir: string;
  /** BOTONS_OAUTH_ALLOW: private hosts the server's own MCP requests may go to. */
  #allow: string[];
  /** Tests since the server started, by connector id; one at a time per connector. */
  #tests = new Map<string, ConnectorTest>();
  #testing = new Map<string, Promise<ConnectorTest>>();
  /** Bumped by forgetTest(): a test that started under an earlier one is about something that changed. */
  #testVersions = new Map<string, number>();
  oauth!: OAuthConnections;
  browser: ManagedBrowser | null = null;

  constructor(db: DatabaseSync, opts: { home: string; providers: ProviderRegistry; store: Pick<Store, 'dropFromBots' | 'atomically'>; allow?: string[] }) {
    this.#db = db;
    this.#allow = opts.allow ?? [];
    this.#providers = opts.providers;
    this.#store = opts.store;
    this.privateDir = join(opts.home, 'run');
    mkdirSync(this.privateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.privateDir, 0o700);
    for (const f of readdirSync(this.privateDir)) if (/^mcp-.*\.json$/.test(f)) rmSync(join(this.privateDir, f), { force: true });
    this.launchDir = join(this.privateDir, 'connectors');
    mkdirSync(this.launchDir, { recursive: true, mode: 0o700 });
    chmodSync(this.launchDir, 0o700);
    releaseAll(this.launchDir);
    this.#store.atomically(() => issueGenerations(db));
  }

  #toLibrary(r: Row): LibraryRow {
    return {
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: strings(parseJson(r.args, [])),
      url: r.url,
      env: stringMap(parseJson(r.env, {})),
      headers: stringMap(parseJson(r.headers, {})),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  #publicServer(s: LibraryRow): McpServer {
    return {
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      url: s.url,
      envKeys: Object.keys(s.env).sort(),
      headerKeys: Object.keys(s.headers).sort(),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  #library(): LibraryRow[] {
    return this.#db
      .prepare('select * from mcp_servers where name != ? order by name')
      .all(BROWSER_SERVER)
      .map((r) => this.#toLibrary(r as Row));
  }

  #findServer(name: string): LibraryRow | null {
    if (name === BROWSER_SERVER) return null;
    const r = this.#db.prepare('select * from mcp_servers where name = ?').get(name) as Row | undefined;
    return r ? this.#toLibrary(r) : null;
  }

  listServers(): McpServer[] {
    return this.#library().map((s) => this.#publicServer(s));
  }

  getServer(name: string): McpServer {
    const s = this.#findServer(name);
    if (!s) throw new HttpError(404, `No MCP server named ${name}`);
    return this.#publicServer(s);
  }

  createServer(input: McpServerInput): McpServer {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME.test(name)) throw new HttpError(400, 'name must be 1-40 lowercase letters, digits, - or _, starting with a letter or digit');
    if (name === BROWSER_SERVER) throw new HttpError(400, `${BROWSER_SERVER} is the name of the browser Botons runs itself`);
    if (this.#findServer(name)) throw new HttpError(409, `There is already an MCP server named ${name}`);
    if (input.transport !== 'stdio' && input.transport !== 'http') throw new HttpError(400, 'transport must be "stdio" or "http"');
    const now = nowIso();
    const next = this.#apply({ name, transport: input.transport, command: '', args: [], url: '', env: {}, headers: {}, createdAt: now, updatedAt: now }, input);
    this.#db
      .prepare('insert into mcp_servers (name, transport, command, args, url, env, headers, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, next.transport, next.command, JSON.stringify(next.args), next.url, JSON.stringify(next.env), JSON.stringify(next.headers), now, now);
    log.info('MCP server added to the library', { server: name, transport: next.transport });
    return this.getServer(name);
  }

  updateServer(name: string, input: McpServerInput): McpServer {
    const before = this.#findServer(name);
    if (!before) throw new HttpError(404, `No MCP server named ${name}`);
    if (input.name !== undefined && input.name !== name) throw new HttpError(400, "An MCP server's name can't change; add a new one instead");
    if (input.transport !== undefined && input.transport !== 'stdio' && input.transport !== 'http') throw new HttpError(400, 'transport must be "stdio" or "http"');
    const next = this.#apply({ ...before, transport: input.transport ?? before.transport }, input);
    this.#db
      .prepare('update mcp_servers set transport = ?, command = ?, args = ?, url = ?, env = ?, headers = ?, updated_at = ? where name = ?')
      .run(next.transport, next.command, JSON.stringify(next.args), next.url, JSON.stringify(next.env), JSON.stringify(next.headers), nowIso(), name);
    this.forgetTest(`lib:${name}`);
    log.info('MCP server in the library changed', { server: name, transport: next.transport });
    return this.getServer(name);
  }

  /** Also takes it off every Boton that had it. */
  deleteServer(name: string): void {
    if (!this.#findServer(name)) throw new HttpError(404, `No MCP server named ${name}`);
    this.#store.atomically(() => {
      this.#db.prepare('delete from mcp_servers where name = ?').run(name);
      retirePolicy(this.#db, `lib:${name}`);
      this.#db.prepare('delete from settings where key = ?').run(offKey(`lib:${name}`));
      this.#store.dropFromBots('connections', `lib:${name}`);
    });
    this.forgetTest(`lib:${name}`);
    log.info('MCP server removed from the library', { server: name });
  }

  #apply(s: LibraryRow, input: McpServerInput): LibraryRow {
    const next: LibraryRow = { ...s, args: [...s.args], env: { ...s.env }, headers: { ...s.headers } };
    if (input.command !== undefined) {
      if (typeof input.command !== 'string' || input.command.length > 500 || /[\r\n\0]/.test(input.command)) throw new HttpError(400, 'command must be one line, at most 500 characters');
      next.command = input.command.trim();
    }
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.length > 50 || !input.args.every((a) => typeof a === 'string' && a.length <= 2000 && !a.includes('\0'))) {
        throw new HttpError(400, 'args must be a list of at most 50 strings');
      }
      next.args = [...input.args];
    }
    if (input.url !== undefined) {
      if (typeof input.url !== 'string') throw new HttpError(400, 'url must be a string');
      next.url = input.url.trim();
    }
    next.env = patchSecrets(next.env, input.env, 'env', ENV_KEY);
    next.headers = patchSecrets(next.headers, input.headers, 'headers', HEADER_KEY);
    if (next.transport === 'stdio') {
      if (!next.command) throw new HttpError(400, 'A stdio server needs a command');
      next.url = '';
      next.headers = {};
    } else {
      let u: URL;
      try {
        u = new URL(next.url);
      } catch {
        throw new HttpError(400, 'An http server needs a URL such as https://example.com/mcp');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'url must be http:// or https://');
      if (u.username || u.password) throw new HttpError(400, 'Put credentials in a header (headers), not in the URL');
      next.command = '';
      next.args = [];
      next.env = {};
    }
    return next;
  }

  #connectorProviders(): Provider[] {
    return [...this.#providers.ids()].flatMap((id) => {
      const p = this.#providers.get(id);
      return p && (p.cli || p.serverTools) ? [p] : [];
    });
  }

  /** Whether this brain receives Botons-managed connectors, through its CLI or server-side tool loop. */
  takesConnectors(providerId: string): boolean {
    return this.#connectorProviders().some((p) => p.id === providerId);
  }

  /**
   * What connector `id` is now, for telling whether it is still the one something was checked against: its setup
   * (secrets only as their SHA-256, never the values), when it was made and changed, its request-policy generation
   * (new on every off, on, policy change and delete) and whether it is off. Null when there is no such connector. Never
   * sent to a client as it is: callers fold it into a keyed hash (starter-gate.ts).
   */
  revision(id: string): Record<string, unknown> | null {
    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    const secrets = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, sha(m[k])]));
    const common = { generation: this.policyOf(id).generation, off: this.isOff(id) };
    if (id === BROWSER_CONNECTOR) return this.browser ? { kind: 'browser' } : null;
    if (id.startsWith('lib:')) {
      const s = this.#findServer(id.slice(4));
      if (!s) return null;
      return { kind: 'lib', name: s.name, transport: s.transport, command: s.command, args: s.args, url: sha(s.url), env: secrets(s.env), headers: secrets(s.headers), createdAt: s.createdAt, updatedAt: s.updatedAt, ...common };
    }
    if (id.startsWith('oauth:')) {
      const c = this.oauth?.byName(id.slice(6));
      if (!c) return null;
      // Not the tokens: a refresh renews them without changing what the connector is. A new sign-in bumps the generation.
      return { kind: 'oauth', row: c.id, url: sha(c.url), status: c.status, signIn: c.generation, issuer: c.issuer, resource: c.resource, client: c.clientId, ...common };
    }
    return null;
  }

  /** Every connector a Boton could be given, without secrets. */
  catalog(): ConnectorCatalog {
    const providers = this.#connectorProviders();
    const policies = this.#policies();
    const policy = (id: string) => {
      const p = policies.get(id) ?? NO_POLICY;
      return { onRequest: p.onRequest, grant: p.grant };
    };
    const connectors: Connector[] = this.#library().map((s) => ({
      id: `lib:${s.name}`,
      name: s.name,
      source: 'library',
      providers: providers.map((p) => p.id),
      transport: s.transport,
      target: s.transport === 'stdio' ? commandLine(s.command, s.args) : displayUrl(s.url),
      status: 'ok',
      note: null,
      ...policy(`lib:${s.name}`),
      basis: s.transport === 'stdio' ? BASIS.stdio : BASIS.http,
      testable: s.transport === 'http',
      lastTest: this.#tests.get(`lib:${s.name}`) ?? null,
      ...this.#onOff(`lib:${s.name}`),
    }));
    if (this.browser) {
      const why = this.browser.unavailable();
      connectors.unshift({
        id: BROWSER_CONNECTOR,
        name: BROWSER_SERVER,
        source: 'library',
        providers: providers.filter(drivesBrowser).map((p) => p.id),
        transport: 'stdio',
        target: "Built into Botons: the Boton's own managed browser, which only reads the sites you list in its settings",
        status: 'ok',
        note: why,
        onRequest: false,
        grant: 'approval',
        basis: 'Run by the Botons server itself in each turn that has it; its sites are in the Boton\'s settings, under Browser.',
        testable: false,
        lastTest: null,
        managed: true,
        enabled: true,
        off: null,
      });
    }
    for (const c of this.oauth?.list() ?? []) {
      connectors.push({
        id: `oauth:${c.name}`,
        name: c.name,
        source: 'oauth',
        providers: providers.map((p) => p.id),
        transport: 'http',
        target: c.url,
        status: c.status === 'connected' ? 'ok' : 'needs-auth',
        note: c.status === 'connected' ? c.refreshError : c.status === 'new' ? 'Not signed in yet: Connect it in Settings → Connectors.' : 'Needs signing in again: Reconnect it in Settings → Connectors.',
        ...policy(`oauth:${c.name}`),
        basis: c.status === 'connected' ? BASIS.oauth : BASIS.oauthOff,
        testable: c.status === 'connected',
        lastTest: this.#tests.get(`oauth:${c.name}`) ?? null,
        ...this.#onOff(`oauth:${c.name}`),
      });
    }
    return { connectors };
  }

  // ------------------------------------------------- on and off

  /** When and why the owner turned connector `id` off, or null while it is on. */
  offState(id: string): ConnectorOff | null {
    if (id === BROWSER_CONNECTOR) return null;
    const raw = (this.#db.prepare('select value from settings where key = ?').get(offKey(id)) as Row | undefined)?.value;
    if (raw === undefined) return null;
    const v = parseJson<Partial<ConnectorOff>>(raw, {});
    // A row it can't read still means off: never on by accident.
    return { at: typeof v.at === 'string' ? v.at : '', reason: typeof v.reason === 'string' ? v.reason : '' };
  }

  isOff(id: string): boolean {
    return this.offState(id) !== null;
  }

  /** Switches made since the server started, by connector: each off or on adds one (see authority). */
  #switches = new Map<string, number>();

  /**
   * What work done for connector `id` stands on: null while it is off, else a number that changes whenever it is turned
   * off or on. Work that began under one value and finds another (even after an off and on again) must not carry on.
   * Counted in memory: nothing that began before a restart is still under way after it.
   */
  authority(id: string): number | null {
    return this.isOff(id) ? null : (this.#switches.get(id) ?? 0);
  }

  #onOff(id: string): { enabled: boolean; off: ConnectorOff | null } {
    const off = this.offState(id);
    return { enabled: !off, off };
  }

  /**
   * Turns connector `id` off or on, inside the caller's transaction. Nothing it has is deleted. Each change starts a new
   * request-policy generation, so a card a Boton asked for before can't be allowed after (even once it is on again).
   * Returns whether anything changed. The managed browser is not switched here: it is given and stopped per Boton.
   */
  setEnabled(id: string, enabled: boolean, reason = ''): boolean {
    const c = this.catalog().connectors.find((x) => x.id === id);
    if (!c) throw new HttpError(404, `No connector ${id}`);
    if (c.managed) throw new HttpError(400, `${c.name} is turned on and off in each Boton's settings, under Browser`);
    if (c.enabled === enabled) return false;
    // Counted first: should the caller's transaction roll back, a poll under way is only dropped and read again.
    this.#switches.set(id, (this.#switches.get(id) ?? 0) + 1);
    if (enabled) this.#db.prepare('delete from settings where key = ?').run(offKey(id));
    else {
      const off: ConnectorOff = { at: nowIso(), reason: reason.trim().slice(0, 200) };
      this.#db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(offKey(id), JSON.stringify(off));
    }
    issuePolicy(this.#db, id, null);
    // A test that started before is about a connector in the other state.
    this.forgetTest(id);
    log.info(enabled ? 'connector turned on' : 'connector turned off', { connector: id });
    return true;
  }

  /** Drops a connector's last test, and makes one still running not count: what it tested changed or is gone. */
  forgetTest(id: string): void {
    this.#tests.delete(id);
    this.#testing.delete(id);
    this.#testVersions.set(id, (this.#testVersions.get(id) ?? 0) + 1);
  }

  /**
   * The owner's test of one connector: for the library's http servers and signed-in OAuth connectors, an MCP session
   * from this server (through outbound(), so only HTTPS or allowed loopback addresses, no redirects) that lists its
   * tools and calls none. Anything else is answered as untestable, saying what its status rests on.
   */
  test(id: string): Promise<ConnectorTest> {
    const c = this.catalog().connectors.find((x) => x.id === id);
    if (!c) throw new HttpError(404, `No connector ${id}`);
    const running = this.#testing.get(id);
    if (running) return running;
    const version = this.#testVersions.get(id) ?? 0;
    const p = this.#runTest(c).then((t) => {
      // Edited, signed in again or removed meanwhile: the result is about what it was, so it isn't kept or shown as current.
      if ((this.#testVersions.get(id) ?? 0) !== version) return this.#changedMeanwhile(c, t);
      if (this.#testing.get(id) === p) {
        this.#tests.set(id, t);
        this.#testing.delete(id);
      }
      return t;
    });
    this.#testing.set(id, p);
    return p;
  }

  #changedMeanwhile(c: Connector, t: ConnectorTest): ConnectorTest {
    return {
      ...t,
      outcome: 'untestable',
      scope: c.basis,
      problem: 'It was changed, signed in again or removed while this test ran, so the result is not about it now. Test it again.',
      toolCount: 0,
      tools: [],
    };
  }

  async #runTest(c: Connector): Promise<ConnectorTest> {
    const started = Date.now();
    /*
     * The credentials this test sends (saved headers, OAuth tokens). A server may echo them back in an error or a tool
     * name, and what it says goes to the owner, the log and this cache, so each is replaced first, before any cut.
     */
    const secrets = new Set<string>();
    const clean = (text: string, max: number) => sanitize(text, secrets, max);
    const result = (outcome: ConnectorTest['outcome'], scope: string, problem: string | null = null, tools: string[] = []): ConnectorTest => ({
      connectorId: c.id,
      at: nowIso(),
      outcome,
      scope,
      problem: problem === null ? null : clean(problem, 300),
      toolCount: tools.length,
      tools: tools.slice(0, TEST_TOOLS).map((t) => clean(t, 100)),
      durationMs: Date.now() - started,
    });
    if (!c.testable) return result('untestable', c.basis);
    const name = c.id.slice(c.id.indexOf(':') + 1);
    const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
    const list = async (url: string, auth: string | Record<string, string>) => {
      const s = new McpSession(url, auth, this.#allow, signal);
      for (const v of s.secrets) secrets.add(v);
      await s.initialize();
      return (await s.listTools()).map((t) => t.name);
    };
    try {
      let tools: string[];
      if (c.source === 'library') {
        const s = this.#findServer(name);
        if (!s) return result('failed', TRIED, 'It is not in the library any more.');
        const refused = refusedOutbound(s.url, this.#allow);
        if (refused) {
          return result(
            'untestable',
            "Botons' server connects only to HTTPS addresses, or to private and loopback ones listed in BOTONS_OAUTH_ALLOW, so it didn't test this one. A Boton's brain connects to it itself in a turn.",
            `Won't connect: ${refused}.`,
          );
        }
        for (const v of secretsOf(s.headers)) secrets.add(v);
        tools = await list(s.url, s.headers);
        const auth = presetFor(s.url)?.id === 'github' ? authorizationOf(s.headers) : null;
        if (auth) {
          const access = await githubAccess(auth, signal);
          if (access === 'rejected') return result('failed', GITHUB_CHECKED, GITHUB_REJECTED, tools);
          if (access === 'public-only') return result('reached', GITHUB_CHECKED, GITHUB_PUBLIC_ONLY, tools);
          if (access === 'private') return result('reached', GITHUB_PRIVATE, null, tools);
        }
      } else {
        const rec = this.oauth?.byName(name);
        if (!rec) return result('failed', TRIED, 'It is not a connector any more.');
        const rememberCredentials = () => {
          const current = this.oauth?.record(rec.id);
          for (const v of [current?.accessToken, current?.refreshToken]) if (v) secrets.add(v);
        };
        rememberCredentials();
        let token = await this.oauth.accessToken(rec.id, 60_000);
        rememberCredentials();
        try {
          tools = await list(rec.url, token);
        } catch (err) {
          if (!(err instanceof McpError && err.kind === 'auth')) throw err;
          rememberCredentials();
          token = await this.oauth.replaceToken(rec.id, token);
          rememberCredentials();
          tools = await list(rec.url, token);
        }
        // Signed in again while it ran: the test used the earlier grant, so it says nothing about the current one.
        if (this.oauth.record(rec.id)?.generation !== rec.generation) return this.#changedMeanwhile(c, result('untestable', c.basis));
      }
      return result('reached', REACHED, null, tools);
    } catch (err) {
      const why =
        err instanceof OAuthError && err.kind === 'grant'
          ? 'It needs signing in again.'
          : signal.aborted
            ? `It didn't finish within ${TEST_TIMEOUT_MS / 1000} seconds.`
            : clean((err as Error).message, 300);
      log.warn('a connector test failed', { connector: c.id, error: why });
      return result('failed', TRIED, why);
    }
  }

  /** Known connector ids, without repeats; an id the Boton already has may stay even if its connector is gone. */
  check(ids: unknown, current: string[] = []): string[] {
    if (!Array.isArray(ids) || !ids.every((c) => typeof c === 'string')) throw new HttpError(400, 'connections must be a list of connector ids');
    const list = [...new Set(ids as string[])];
    if (countedConnections(list) > MAX_CONNECTIONS) throw new HttpError(400, `A Boton can have at most ${MAX_CONNECTIONS} connectors`);
    const known = new Set(this.catalog().connectors.map((c) => c.id));
    const unknown = list.filter((id) => !known.has(id) && !current.includes(id));
    if (unknown.length) throw new HttpError(400, `Unknown connector ${unknown[0]}. See GET /api/connectors.`);
    return list;
  }

  /**
   * The servers a turn on `provider` gets, secrets included (for the agent CLI only), and the ids it skips with
   * why. An OAuth connector's access token is fetched (refreshed first if it would expire within `forMs`). Each library
   * command starts in the Workspace sandbox under `launch` (connector-launch.ts); one that can't is left out with why,
   * and without `launch` every one is. The caller removes the launch files with release() when the turn ends.
   */
  async resolve(ids: string[], provider: Pick<Provider, 'cli' | 'fitMcpServers' | 'serverTools'> | undefined, opts: { forMs?: number; launch?: LaunchPolicy } = {}): Promise<ResolvedConnectors> {
    const out: ResolvedConnectors = { servers: [], skipped: [], ids: {} };
    if (!ids.length) return out;
    if (!provider?.cli && !provider?.serverTools) {
      for (const id of ids) out.skipped.push({ id, reason: "this Boton's brain can't use connectors" });
      return out;
    }
    // Whatever throws once a launch file is written (another connector's, a token store, fitting them to the CLI):
    // those written so far are removed before the error goes on, since no caller gets them to release.
    try {
      return await this.#resolve(ids, provider, opts, out);
    } catch (err) {
      this.release(out);
      throw err;
    }
  }

  async #resolve(ids: string[], provider: Pick<Provider, 'cli' | 'fitMcpServers' | 'serverTools'>, opts: { forMs?: number; launch?: LaunchPolicy }, out: ResolvedConnectors): Promise<ResolvedConnectors> {
    const names = new Map<string, string>();
    let jail: Jail | undefined;
    for (const id of ids) {
      const colon = id.indexOf(':');
      const source = id.slice(0, colon);
      const name = id.slice(colon + 1);
      let server: TurnMcpServer | null = null;
      // Off: left out before anything is read for it (no secret, no token fetched or refreshed).
      if (this.isOff(id)) {
        out.skipped.push({ id, reason: OFF_REASON });
        continue;
      }
      if (id === BROWSER_CONNECTOR) {
        // Only an agent CLI's turns drive it (drivesBrowser); an API key brain is never handed tools it can't use. Not a
        // turn that went without it either: a Boton moved to such a brain keeps it for a move back, and its Browser
        // settings say why it is off.
        if (!drivesBrowser(provider)) continue;
        const why = this.browser ? this.browser.unavailable() : 'this server has no managed browser';
        if (!this.browser || why) {
          out.skipped.push({ id, reason: why ?? 'this server has no managed browser' });
          continue;
        }
        server = this.browser.server();
      } else if (source === 'lib') {
        const s = this.#findServer(name);
        if (!s) {
          out.skipped.push({ id, reason: 'not in the library' });
          continue;
        }
        if (s.transport === 'stdio') {
          jail ??= opts.launch ? connectorJail(opts.launch) : { problem: 'a local connector starts only in the Workspace sandbox, and this turn has none for it' };
          const launch = 'problem' in jail ? jail : jail.wrap(s);
          if ('problem' in launch) {
            out.skipped.push({ id, reason: `not started: ${launch.problem}` });
            continue;
          }
          (out.launchFiles ??= []).push(launch.file);
          server = { name: s.name, kind: 'stdio', command: launch.command, args: launch.args, env: launch.env, secrets: launch.secrets };
        } else server = { name: s.name, kind: 'http', url: s.url, headers: { ...s.headers } };
      } else if (source === 'oauth') {
        const c = this.oauth?.byName(name);
        if (!c) {
          out.skipped.push({ id, reason: 'no such OAuth connector' });
          continue;
        }
        if (names.has(c.name)) {
          out.skipped.push({ id, reason: `another connector is already named ${c.name}` });
          continue;
        }
        try {
          const token = await this.oauth.accessToken(c.id, opts.forMs ?? 0);
          server = { name: c.name, kind: 'http', url: c.url, headers: { Authorization: `Bearer ${token}` } };
        } catch (err) {
          // Shown to the owner and in the Boton's own turn: no credential of this connector, before the cut.
          const rec = this.oauth.record(c.id);
          const why = sanitize((err as Error).message, [rec?.accessToken, rec?.refreshToken], 120);
          out.skipped.push({ id, reason: err instanceof OAuthError && err.kind === 'grant' ? 'needs signing in again' : `its token could not be refreshed (${why})` });
          continue;
        }
      } else {
        // Never looked up in the CLI's own setup: an id that isn't a Botons connector is left out, and said so.
        out.skipped.push({ id, reason: 'not a Botons connector (add it in Settings → Connectors)' });
        continue;
      }
      if (names.has(server.name)) {
        out.skipped.push({ id, reason: `another connector is already named ${server.name}` });
        continue;
      }
      names.set(server.name, id);
      out.servers.push(server);
    }
    const fit = out.servers.length ? provider?.fitMcpServers?.(out.servers) : undefined;
    if (fit) {
      for (const s of fit.skipped) out.skipped.push({ id: names.get(s.name) ?? s.name, reason: s.reason });
      out.servers = fit.servers;
    }
    for (const s of out.servers) out.ids[s.name] = names.get(s.name)!;
    return out;
  }

  /**
   * Removes a turn's launch files (resolve()); the files are gone from then on, so the CLI can't start them again.
   * Never throws, so an error it runs after goes on as it was: one that can't be removed is logged, and the next start
   * removes it (releaseAll).
   */
  release(r: Pick<ResolvedConnectors, 'launchFiles'>): void {
    const files = r.launchFiles ?? [];
    r.launchFiles = [];
    try {
      release(files);
    } catch (err) {
      log.warn('could not remove a local connector’s launch file', { err });
    }
  }

  // ------------------------------------------------- asking for connectors

  #policies(): Map<string, ConnectorPolicy> {
    const rows = this.#db.prepare('select * from connector_policies').all() as Row[];
    return new Map(rows.map((r) => [String(r.connector_id), { onRequest: !!r.on_request, grant: r.grant_mode, generation: Number(r.generation) }]));
  }

  policyOf(id: string): ConnectorPolicy {
    return this.#policies().get(id) ?? NO_POLICY;
  }

  /** The owner's choice for one connector; every change starts a new generation, so a card asked under the old one can't be allowed. */
  setPolicy(id: string, input: ConnectorPolicyInput): Connector {
    const c = this.catalog().connectors.find((x) => x.id === id);
    if (!c) throw new HttpError(404, `No connector ${id}`);
    if (c.managed) throw new HttpError(400, `${c.name} can't be asked for: only you give a Boton its browser, in its settings`);
    if (input.onRequest !== undefined && typeof input.onRequest !== 'boolean') throw new HttpError(400, 'onRequest must be true or false');
    if (input.grant !== undefined && input.grant !== 'approval' && input.grant !== 'immediate') throw new HttpError(400, 'grant must be "approval" or "immediate"');
    const before = this.policyOf(id);
    const next = { onRequest: input.onRequest ?? before.onRequest, grant: input.grant ?? before.grant };
    issuePolicy(this.#db, id, next);
    log.info('connector request policy changed', { connector: id, onRequest: next.onRequest, grant: next.grant });
    return this.catalog().connectors.find((x) => x.id === id)!;
  }

  /**
   * What `botons connector list` shows a Boton: its own and the ones it may ask for, by id and name only. One of its
   * own its last turn went without (left out, or its CLI couldn't start it) is not usable either.
   */
  forBoton(bot: { id?: string; connections: string[]; provider: string }): BotonConnector[] {
    const all = this.catalog().connectors;
    const out: BotonConnector[] = [];
    const without = new Set(
      bot.id ? (this.#db.prepare("select connector_id from connector_notices where bot_id = ? and kind = 'skipped'").all(bot.id) as Row[]).map((r) => String(r.connector_id)) : [],
    );
    for (const id of bot.connections) {
      const c = all.find((x) => x.id === id);
      const off = !!c && !c.enabled;
      out.push({
        id,
        name: c?.name ?? id.slice(id.indexOf(':') + 1),
        state: 'yours',
        grant: null,
        usable: !!c && !off && c.status === 'ok' && c.providers.includes(bot.provider) && !without.has(id),
        off,
      });
    }
    for (const c of all) {
      if (!c.onRequest || !c.enabled || bot.connections.includes(c.id) || !c.providers.includes(bot.provider)) continue;
      out.push({ id: c.id, name: c.name, state: 'available', grant: c.grant, usable: c.status === 'ok', off: false });
    }
    return out;
  }

  /**
   * Why `id` can't be given to this Boton now, or null. `asked` is the policy generation a card or request recorded
   * (`'now'`: none, the request is being made): only that one, issued as above, can still be allowed. With `usable`,
   * one known not to work now (an OAuth connector not signed in) can't be either: what `botons connector list` shows
   * as not usable.
   */
  grantProblem(bot: { connections: string[]; provider: string }, id: string, asked: unknown = 'now', opts: { usable?: boolean } = {}): string | null {
    const c = this.catalog().connectors.find((x) => x.id === id);
    if (!c) return `There is no connector ${id} any more`;
    if (c.managed) return `${c.name} can't be asked for`;
    if (!c.enabled) return `${c.name} is turned off`;
    if (!c.providers.includes(bot.provider)) return `${c.name} can't be used by this Boton's brain`;
    const p = this.policyOf(id);
    if (!p.onRequest) return `${c.name} is not available on request any more`;
    if (asked !== 'now') {
      if (!issuedGeneration(asked)) return `This was asked in a way that can't be matched to ${c.name} as it is set up now (it may have been asked for one deleted since): the Boton has to ask for it again`;
      if (p.generation !== asked) return `How ${c.name} is granted changed since the request was made`;
    }
    if (opts.usable && c.status !== 'ok') return `${c.name} is not signed in: it can be given once it is signed in, in Settings → Connectors`;
    if (countedConnections(bot.connections) >= MAX_CONNECTIONS) return `A Boton can have at most ${MAX_CONNECTIONS} connectors`;
    return null;
  }

  // ------------------------------------------------- notices for the owner

  /**
   * What the owner should know about this Boton's connectors, newest first: ones taken off it because Botons no
   * longer uses the CLIs' own servers, and ones its last turn went without. Each offers a Botons connector with the
   * same name or address, if there is one it doesn't have. Notices that no longer apply (a skipped connector it
   * doesn't have any more, a removed one whose offer it has now) are cleared as they are read.
   */
  notices(bot: { id: string; connections: string[] }): ConnectorNotice[] {
    const rows = this.#db.prepare('select * from connector_notices where bot_id = ? order by at desc, connector_id').all(bot.id) as Row[];
    const all = this.catalog().connectors;
    const out: ConnectorNotice[] = [];
    for (const r of rows) {
      const offer = r.kind === 'removed' ? matching(all, String(r.name), String(r.target)) : null;
      const stale = r.kind === 'skipped' ? !bot.connections.includes(r.connector_id) : !!offer && bot.connections.includes(offer.id);
      if (stale) {
        this.dismissNotice(bot.id, r.connector_id);
        continue;
      }
      out.push({
        botId: bot.id,
        connectorId: r.connector_id,
        kind: r.kind,
        name: r.name,
        target: r.target,
        reason: r.reason,
        at: r.at,
        offer: offer && !bot.connections.includes(offer.id) ? { id: offer.id, name: offer.name, target: offer.target } : null,
      });
    }
    return out;
  }

  /** Why this Boton's last turn went without connector `id` (left out, or its CLI couldn't start it), or null. */
  withoutReason(botId: string, id: string): string | null {
    const r = this.#db.prepare("select reason from connector_notices where bot_id = ? and connector_id = ? and kind = 'skipped'").get(botId, id) as Row | undefined;
    return r ? String(r.reason) : null;
  }

  /** The owner dismissed it (or it no longer applies). Returns whether there was one. */
  dismissNotice(botId: string, connectorId: string): boolean {
    return Number(this.#db.prepare('delete from connector_notices where bot_id = ? and connector_id = ?').run(botId, connectorId).changes) > 0;
  }

  /**
   * After a turn's connectors were resolved: each it went without is noted with why (the owner sees it in the
   * Boton's settings), and the ones it got clear theirs. Removed notices stay until the owner deals with them.
   */
  recordTurn(botId: string, resolved: Pick<ResolvedConnectors, 'skipped' | 'ids'>): void {
    const clear = this.#db.prepare("delete from connector_notices where bot_id = ? and connector_id = ? and kind = 'skipped'");
    for (const id of Object.values(resolved.ids)) clear.run(botId, id);
    this.#noteSkipped(botId, resolved.skipped);
  }

  /**
   * After the turn ran: each connector it was given that the CLI showed didn't start is noted like one resolve left
   * out, with the CLI's reason. One the CLI said nothing about stays as it is: given, not known to have started.
   */
  recordStartup(botId: string, ids: Record<string, string>, startup: McpStartup[]): void {
    this.#noteSkipped(
      botId,
      startup.flatMap((s) => (!s.started && ids[s.name] ? [{ id: ids[s.name], reason: s.reason ?? 'it did not start' }] : [])),
    );
  }

  #noteSkipped(botId: string, skipped: { id: string; reason: string }[]): void {
    if (!skipped.length) return;
    const all = this.catalog().connectors;
    const now = nowIso();
    const note = this.#db.prepare(
      "insert into connector_notices (bot_id, connector_id, kind, name, target, reason, at) values (?, ?, 'skipped', ?, ?, ?, ?) on conflict(bot_id, connector_id) do update set name = excluded.name, target = excluded.target, reason = excluded.reason, at = excluded.at where kind = 'skipped'",
    );
    for (const s of skipped) {
      const c = all.find((x) => x.id === s.id);
      note.run(botId, s.id, c?.name ?? s.id.slice(s.id.indexOf(':') + 1), c?.target ?? '', s.reason, now);
    }
  }
}

/** A Botons connector with this name (OAuth first), else one at this address: what to offer for a removed one. */
function matching(all: Connector[], name: string, target: string): Connector | null {
  const byName = all.filter((c) => c.name === name);
  if (byName.length) return byName.find((c) => c.source === 'oauth') ?? byName[0];
  if (!target) return null;
  const at = all.filter((c) => c.transport === 'http' && sameAddress(c.target, target));
  return at.find((c) => c.source === 'oauth') ?? at[0] ?? null;
}

/**
 * Whether two MCP addresses name the same server: the scheme and host compare as the URL parser normalizes them
 * (case, default port), the path exactly (including case and trailing slashes), and the query
 * and fragment not at all (a notice keeps the address without them).
 */
export function sameAddress(a: string, b: string): boolean {
  const key = (t: string) => {
    try {
      const u = new URL(t);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return t.split(/[?#]/)[0];
    }
  };
  return key(a) === key(b);
}

/** A write-only patch of env vars or headers: a string sets, null removes, left out stays. */
export function patchSecrets(current: Record<string, string>, patch: unknown, field: string, key: RegExp): Record<string, string> {
  if (patch === undefined) return current;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, `${field} must be an object of names to values`);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    // Not echoed: a token pasted where its name goes would come back in the error, and never kept as a name.
    if (tokenShapedName(k)) throw new HttpError(400, field === 'env' ? 'env: that looks like a token, not a variable name. Put the token in its value.' : TOKEN_AS_NAME);
    if (!key.test(k)) throw new HttpError(400, field === 'env' ? 'env: not a valid name (letters, digits and _, not starting with a digit)' : "headers: not a valid name (letters, digits and -, no spaces or ':')");
    if (field === 'env' && (/^BOTONS?_/.test(k) || isLegacySetting(k) || k.startsWith('LC_'))) throw new HttpError(400, `env: ${k} is reserved`);
    if (v === null) delete next[k];
    else if (typeof v !== 'string' || v.length > MAX_VALUE || v.includes('\0') || (field === 'headers' && /[\r\n]/.test(v))) {
      throw new HttpError(400, `${field === 'env' ? 'An environment variable' : 'A header'}'s value must be text of at most ${MAX_VALUE} characters${field === 'headers' ? ' on one line' : ''}`);
    } else next[k] = v;
  }
  if (Object.keys(next).length > MAX_ENTRIES) throw new HttpError(400, `At most ${MAX_ENTRIES} ${field}`);
  return next;
}
