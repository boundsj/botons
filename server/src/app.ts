import { isManagedBin, managedRoot, pruneManagedReleases } from './managed-clis.ts';
import { CliInstaller, type InstallOptions } from './cli-install.ts';
import { ClaudeCliProvider } from './providers/claude-cli.ts';
import { CodexCliProvider } from './providers/codex-cli.ts';
import { ReleaseChecker } from './cli-updates.ts';
import { BrainLogin } from './brain-login.ts';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildRouter, VERSION } from './api.ts';
import { ApiKeys, type ApiKeysOptions } from './api-keys.ts';
import { Approvals } from './approvals.ts';
import { Cards } from './cards.ts';
import { Reactions } from './reactions.ts';
import { Audit, SYSTEM_ACTOR } from './audit.ts';
import { Auth, type Principal } from './auth.ts';
import { Browser } from './browser.ts';
import { BrowserHandoffs } from './browser-handoff.ts';
import { drivesBrowser } from './browser-policy.ts';
import { Callbacks } from './callback.ts';
import { allowedHostNames, applyTailnet, type Config, formatDuration } from './config.ts';
import { Connectors } from './connectors.ts';
import { asTurn } from './acting.ts';
import { Engine } from './engine.ts';
import { EventHub } from './events.ts';
import { HealthMonitor } from './health.ts';
import { guardRequest, makeCtx, type Router, safeDecode, sendJson, serveStatic } from './http.ts';
import { type DataDirLock, lockDataDir } from './lock.ts';
import { log } from './log.ts';
import { Notifier } from './notify.ts';
import { CALLBACK_PATH, callbackPage, OAuthConnections } from './oauth-connections.ts';
import { ApiBrainProvider } from './providers/api-brain.ts';
import { HistoryStore } from './providers/api-history.ts';
import { anthropicWire, openaiWire } from './providers/api-wire.ts';
import { ProviderRegistry } from './providers/index.ts';
import { Spending } from './spend.ts';
import { RecentLogs } from './recent-logs.ts';
import { RestoreRehearsals } from './rehearsals.ts';
import { reapOrphanGroups } from './providers/process.ts';
import { startScheduler } from './scheduler.ts';
import { Setup } from './setup.ts';
import { Skills } from './skills.ts';
import { StarterGate } from './starter-gate.ts';
import { HttpError, Store } from './store.ts';
import { WorkFeed } from './work-feed.ts';
import { Trash, type TrashHooks } from './trash.ts';
import { plainAddress, type Tailnet, type TailscaleProbe, type TailscaleSelf, tailscaleCli, tailscaleSelf } from './tailnet.ts';

export interface App {
  store: Store;
  engine: Engine;
  connectors: Connectors;
  skills: Skills;
  approvals: Approvals;
  cards: Cards;
  reactions: Reactions;
  browser: Browser;
  oauth: OAuthConnections;
  workFeed: WorkFeed;
  providers: ProviderRegistry;
  hub: EventHub;
  auth: Auth;
  audit: Audit;
  setup: Setup;
  health: HealthMonitor;
  recentLogs: RecentLogs;
  rehearsals: RestoreRehearsals;
  apiKeys: ApiKeys;
  spending: Spending;
  trash: Trash;
  listen(): Promise<Server[]>;
  /** Running turns get `drainMs` (default 0) to finish; the rest are stopped and left for the next process. */
  close(opts?: { drainMs?: number }): Promise<{ interrupted: number }>;
}

/** Never logs the key, query, headers (signatures) or payload. */
function logHook(req: IncomingMessage, res: ServerResponse, url: URL, listener: 'main' | 'public'): void {
  const started = Date.now();
  const remote = plainAddress(req.socket.remoteAddress ?? '');
  const id = /^\/hooks\/routines\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1];
  const routineId = id === undefined ? undefined : (safeDecode(id) ?? undefined);
  res.once('close', () => {
    const status = res.headersSent ? res.statusCode : null;
    const fields = { routineId, method: req.method, path: url.pathname, listener, remote, status, durationMs: Date.now() - started };
    if (status === null) log.info('webhook caller hung up before the answer', fields);
    else if (status >= 500) log.error('webhook', fields);
    else if (status >= 400) log.warn('webhook', fields);
    else log.info('webhook', fields);
  });
}

async function settle(open: Set<ServerResponse>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  // At least one turn of the event loop: a write just made goes out with the next tick.
  await new Promise((r) => setImmediate(r));
  while (open.size && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

function closeServers(servers: Server[]): Promise<void[]> {
  return Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
}

interface AppOptions {
  tailscale?: TailscaleProbe;
  tailscaleRetryMs?: number;
  /** Default: the `tailscale` CLI, or none with BOTONS_NO_TAILSCALE=1. */
  tailnet?: Tailnet | null;
  /** Restore rehearsals' limits and time limit (tests make them small). */
  rehearsal?: Pick<ConstructorParameters<typeof RestoreRehearsals>[0], 'limits' | 'timeoutMs'>;
  /** API keys: the environment to read ANTHROPIC_API_KEY and OPENAI_API_KEY from (default: the server's), and tests' loopback endpoints. */
  apiKeys?: Partial<Pick<ApiKeysOptions, 'env' | 'testEndpoints' | 'timeoutMs'>>;
  /** Tests only: the clock API-key requests are counted by (their day). */
  spendClock?: () => Date;
  /** The trash and inbox cleanup's clock (tests move it on by days). */
  storageClock?: () => number;
  /** Tests: a Boton's moves interleaved where a race with a delete or restore would hit (trash.ts). */
  trashHooks?: TrashHooks;
  /** Production entrypoint enables external release checks; fixtures stay offline. */
  releaseChecks?: boolean;
  /** In-code fixture runners only; never configured through HTTP or environment. */
  cliInstaller?: Pick<InstallOptions, 'root' | 'node' | 'run' | 'verify'>;
}

/** Throws DataDirInUseError before opening the database if another server holds cfg.home. */
export function createApp(cfg: Config, lock: DataDirLock = lockDataDir(cfg.home), opts: AppOptions = {}): App {
  // First, so the owner's view has what starting up logged.
  const recentLogs = new RecentLogs({ threshold: () => cfg.logLevel }).start();
  const hub = new EventHub();
  pruneManagedReleases(managedRoot(), 'codex-cli', cfg.codexBin);
  pruneManagedReleases(managedRoot(), 'claude-cli', cfg.claudeBin);
  const providers = new ProviderRegistry({ enableMock: cfg.enableMock, claudeBin: cfg.claudeBin, codexBin: cfg.codexBin, managed: { claude: isManagedBin(cfg.claudeBin, 'claude-cli'), codex: isManagedBin(cfg.codexBin, 'codex-cli') } });
  const engine = new Engine(cfg, hub, providers);
  providers.setUsageLimits((id) => engine.usageLimit(id)?.until ?? null);
  let store: Store;
  try {
    store = new Store(cfg, hub, engine.statusOf);
  } catch (err) {
    recentLogs.stop();
    lock.release();
    throw err;
  }
  engine.store = store;
  store.effortCaps = (provider, model) => providers.modelEfforts(provider, model);
  const connectors = new Connectors(store.db, { home: cfg.home, providers, store, allow: cfg.oauth.allow });
  engine.connectors = connectors;
  const skills = new Skills(store.db, { hub, store, packagesDir: cfg.skillPackagesDir });
  engine.skills = skills;
  const auth = new Auth(store.db, {
    enabled: cfg.authEnabled,
    ownerLogin: cfg.ownerLogin,
    tailnet: opts.tailnet !== undefined ? opts.tailnet : cfg.tailscale.enabled ? tailscaleCli() : null,
    hostname: cfg.hostname,
    container: cfg.container,
  });
  auth.purgeBotonTokens();
  const audit = new Audit(store.db);
  const setup = new Setup(store.db, cfg, () => store.getSettings().ownerName);
  engine.auth = auth;
  // Read per push: the public URL follows the tailnet.
  const notifier = new Notifier({ config: () => store.ntfyConfig(), publicUrl: () => cfg.publicUrl });
  engine.notifier = notifier;
  const approvals = new Approvals({
    store,
    hub,
    notifier,
    wake: (botId) => engine.queueChat(botId),
    origin: (botId) => engine.turnOrigin(botId),
    access: (botId) => engine.turnAccess(botId),
    waitMs: cfg.approvalWaitMs,
  });
  approvals.skills = skills;
  approvals.connectors = connectors;
  skills.approvals = approvals;
  engine.approvals = approvals;
  const handoffs = new BrowserHandoffs({ store, push: (req) => notifier.push(req), wake: (botId) => engine.queueChat(botId) });
  const browser = new Browser({
    cfg,
    store,
    approvals,
    usesConnectors: (provider) => drivesBrowser(providers.get(provider)),
    turnAccess: (botId) => engine.turnAccess(botId),
    share: (botId, path, title) => engine.shareFile(botId, path, title),
    audit,
    trackDevice: (principal, close) => auth.trackStream(principal, close),
    handoffs,
  });
  engine.browser = browser;
  // A handover never outlives the server: a handoff taken when it stopped was handed back by the stop.
  handoffs.recover();
  approvals.browser = browser;
  // The built-in browser connector; whether this server has a Chromium is found once, at start.
  connectors.browser = { server: () => browser.server(), unavailable: () => browser.known?.why ?? null };
  void browser.availability().then((a) => {
    if (!a.available) log.info('the managed browser is not available', { why: a.why });
  });
  const oauth = new OAuthConnections({ db: store.db, cfg, store, hub, notifier });
  const connected = (id: string) => {
    const c = oauth.list().find((x) => x.id === id);
    audit.record(SYSTEM_ACTOR, { action: 'oauth.connected', target: { kind: 'oauth', id, label: c?.name ?? id } });
  };
  connectors.oauth = oauth;
  // Before anything can refresh: a refresh cut off by the last stop is never sent again.
  oauth.recoverInterrupted();
  const workFeed = new WorkFeed({ db: store.db, cfg, store, oauth, wake: (botId) => engine.queueChat(botId), authority: (id) => connectors.authority(id) });
  engine.workFeed = workFeed;
  oauth.onConnected = (id) => {
    // A new sign-in is a new grant: a test of the earlier one, done or still running, isn't about it.
    const name = oauth.record(id)?.name;
    if (name) connectors.forgetTest(`oauth:${name}`);
    connected(id);
    void workFeed.detect(id);
  };
  const starterGate = new StarterGate({ store, connectors, skills, browser });
  engine.starterGate = starterGate;
  const health = new HealthMonitor({ cfg, store, engine, providers });
  const callbacks = new Callbacks(cfg.callbacks, store, hub);
  const rehearsals = new RestoreRehearsals({ db: store.db, audit, home: cfg.home, backupsDir: cfg.backupsDir, version: VERSION, build: cfg.build, ...opts.rehearsal });
  const cards = new Cards({ store, connectors, audit, wake: (botId) => engine.queueChat(botId), origin: (botId) => engine.turnOrigin(botId) });
  const apiKeys = new ApiKeys({ db: store.db, hub, env: opts.apiKeys?.env ?? process.env, testEndpoints: opts.apiKeys?.testEndpoints, timeoutMs: opts.apiKeys?.timeoutMs });
  const reactions = new Reactions({ store, wake: (botId) => engine.queueChat(botId) });
  engine.reactions = reactions;
  // Botons on the owner's API keys: the loop, tools and caps are the server's own (providers/api-brain.ts).
  const spending = new Spending(store.db, { now: opts.spendClock });
  spending.prune();
  const apiHistory = new HistoryStore(join(cfg.home, 'api-sessions'));
  for (const wire of [anthropicWire, openaiWire]) providers.register(new ApiBrainProvider(wire, { keys: apiKeys, history: apiHistory, spending, allow: cfg.oauth.allow }));
  const releases = new ReleaseChecker(cfg.home);
  if (!cfg.enableMock && opts.releaseChecks === true) releases.start();
  const brainLogin = new BrainLogin(cfg.codexBin);
  const cliInstaller = new CliInstaller({
    home: cfg.home, ...(cfg.enableMock ? {root:join(cfg.home, 'fixture-managed-clis')} : {}), ...opts.cliInstaller,
    current: id => id === 'codex-cli' ? cfg.codexBin : cfg.claudeBin,
    maintain: run => engine.maintain(run),
    activate: (id, bin) => {
      if (id === 'codex-cli') { brainLogin.setBin(bin); cfg.codexBin = bin; providers.register(new CodexCliProvider(bin, undefined, true)); }
      else { cfg.claudeBin = bin; providers.register(new ClaudeCliProvider(bin, true)); }
    },
  });
  // The server's trash; nothing a delete takes may hold these folders.
  const trash = new Trash({ home: cfg.home, store, audit, sharedDir: cfg.sharedDir, hooks: opts.trashHooks, protectedDirs: [cfg.home, cfg.workspacesDir, cfg.sharedDir, cfg.templatesDir, cfg.skillPackagesDir, cfg.backupsDir], now: opts.storageClock });
  const router = buildRouter({ cfg, store, engine, hub, providers, auth, health, connectors, skills, approvals, cards, reactions, browser, oauth, audit, setup, callbacks, recentLogs, rehearsals, apiKeys, brainLogin, starterGate, spending, releases, cliInstaller, trash });

  // Recomputed when the server starts listening on its Tailscale address.
  let allowedHosts = allowedHostNames(cfg);
  const publicOrigins = new Set([cfg.publicUrlOverride, cfg.oauth.publicUrl]
    .filter((value): value is string => !!value).map((value) => new URL(value).origin.toLowerCase()));

  const parseUrl = (req: IncomingMessage) => {
    try {
      return new URL(req.url ?? '/', 'http://local');
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
  };

  const dispatch = async (req: IncomingMessage, res: ServerResponse, url: URL, match: ReturnType<Router['match']>, principal: Principal | null) => {
    if (match === null) return sendJson(res, 404, { error: 'Not found' });
    if (match === 'method') return sendJson(res, 405, { error: 'Method not allowed' });
    const ctx = makeCtx(req, res, url, match.params, principal, match.maxBody);
    // A Boton's request: what it posts in the chat belongs to the turn it is running.
    const out = await (principal?.kind === 'boton' ? asTurn(principal.botId, engine.turnOrigin(principal.botId)?.turnId, () => match.handler(ctx)) : match.handler(ctx));
    if (res.headersSent) return;
    if (out === undefined) sendJson(res, 204, {});
    else sendJson(res, 200, out);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = parseUrl(req);
    if (url.pathname.startsWith('/hooks/')) logHook(req, res, url, 'main');
    // The owner's access mode: requests from networks it doesn't name are refused before anything else.
    const refused = setup.refusal(auth.remoteAddress(req));
    if (refused) return sendJson(res, 403, { error: refused });
    const blocked = guardRequest(req, url, allowedHosts, publicOrigins);
    if (blocked) return sendJson(res, 403, { error: blocked });
    const path = safeDecode(url.pathname);
    if (path === null) throw new HttpError(400, 'Malformed URL encoding');
    // The OAuth redirect: exactly this path, before the app's fallback. No device token: the browser comes back
    // from the authorization server, and the one-time state it carries is what is checked.
    if (url.pathname === CALLBACK_PATH || url.pathname.startsWith('/oauth/')) {
      if (url.pathname !== CALLBACK_PATH) return sendJson(res, 404, { error: 'Not found' });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const page = callbackPage(await oauth.callback(url.searchParams));
      res.writeHead(page.status, page.headers);
      return void res.end(page.body);
    }
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/hooks/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      return serveStatic(cfg.webDist, path, res);
    }
    const match = router.match(req.method ?? 'GET', url.pathname);
    // /hooks routes check their routine keys themselves.
    let principal: Principal | null = null;
    if (url.pathname.startsWith('/api/')) {
      const route = match && match !== 'method' ? match : null;
      principal = auth.authenticate(req, { url, urlKey: route?.access.urlKey });
      auth.authorize(principal, route?.access ?? {}, route?.params ?? {}, req);
    }
    return dispatch(req, res, url, match, principal);
  };

  // BOTONS_HOOKS_PORT, meant for the internet: webhook routes only. No Host
  // check: callers use the proxy's name, and no browser session rides on these routes.
  const handleHooks = async (req: IncomingMessage, res: ServerResponse) => {
    const url = parseUrl(req);
    if (!url.pathname.startsWith('/hooks/')) return sendJson(res, 404, { error: 'Not found' });
    logHook(req, res, url, 'public');
    if (safeDecode(url.pathname) === null) throw new HttpError(400, 'Malformed URL encoding');
    return dispatch(req, res, url, router.match(req.method ?? 'GET', url.pathname), null);
  };

  // Node ignores the promise a request listener returns, so every request goes
  // through this one catch. `open`: responses close() lets finish before it cuts connections.
  const open = new Set<ServerResponse>();
  const guarded = (handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>) => async (req: IncomingMessage, res: ServerResponse) => {
    open.add(res);
    res.once('close', () => open.delete(res));
    try {
      await handle(req, res);
    } catch (err) {
      try {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, err.headers);
        // Path only: the query can carry a webhook's ?key= secret.
        log.error('request failed', { method: req.method, path: (req.url ?? '/').split(/[?#]/, 1)[0], err });
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
      } catch (sendErr) {
        log.error('could not send the error response', { err: sendErr });
        res.destroy();
      }
    }
  };

  const handler = guarded(handle);
  const listenOn = (host: string) =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer(handler);
      s.requestTimeout = 0; // webhooks with ?wait=1 and SSE stay open
      s.once('error', reject);
      s.listen(cfg.port, host, () => resolve(s));
    });

  // A caller that stalls sending its request is answered 408 and cut off, so slow senders can't pile up sockets.
  const listenHooksOn = (host: string, port: number) =>
    new Promise<Server>((resolve, reject) => {
      const { timeoutMs } = cfg.hooks;
      const s = createServer({ requestTimeout: timeoutMs, headersTimeout: timeoutMs, connectionsCheckingInterval: Math.min(1000, timeoutMs) }, guarded(handleHooks));
      s.once('error', reject);
      s.listen(port, host, () => resolve(s));
    });

  let servers: Server[] = [];
  let hookServers: Server[] = [];
  let stopScheduler: (() => void) | null = null;
  let stopTailnet: (() => void) | null = null;

  /**
   * Poll `tailscale status`; once an address appears, listen on it (bind mode)
   * and use its names. `tailscale status` can list the address a moment before
   * the kernel has it, so a failed bind is retried soon until the next poll is due.
   */
  const followTailnet = async () => {
    const { mode, pollMs, initial } = cfg.tailscale;
    if (mode === 'off') return;
    const probe = opts.tailscale ?? tailscaleSelf;
    const retryMs = Math.min(opts.tailscaleRetryMs ?? 2000, pollMs);
    const every = formatDuration(pollMs);
    const retrying = retryMs < pollMs ? `retrying every ${formatDuration(retryMs)}, then every ${every}` : `retrying every ${every}`;
    let live: TailscaleSelf = { ip: null, dnsName: null };
    let bindError = '';
    let failing: { ip: string; since: number } | null = null;
    let retry: NodeJS.Timeout | null = null;
    let warnedAt = 0;
    let started = false;
    let busy = false;
    let stopped = false;
    const use = (ts: TailscaleSelf) => {
      if (ts.ip === live.ip && ts.dnsName === live.dnsName) return;
      const first = !live.ip;
      live = ts;
      applyTailnet(cfg, live);
      allowedHosts = allowedHostNames(cfg);
      if (first && started) log.info(`Tailscale is up: ${mode === 'bind' ? `listening on ${ts.ip}:${cfg.port} too` : 'using its names'} (${cfg.publicUrl})`);
      else if (!first) log.info(`the Tailscale address is now ${ts.ip} (${ts.dnsName ?? 'no MagicDNS name'})`);
    };
    const retrySoon = () => {
      if (retry || stopped) return;
      retry = setTimeout(() => {
        retry = null;
        void tick();
      }, retryMs);
      retry.unref();
    };
    const check = async (ts: TailscaleSelf) => {
      // A failed lookup (say, tailscaled restarting) changes nothing: a listener outlives its address going away.
      if (!ts.ip) return;
      if (mode === 'bind' && !servers.some((s) => (s.address() as { address?: string } | null)?.address === ts.ip)) {
        try {
          const s = await listenOn(ts.ip);
          if (stopped) return void s.close();
          servers.push(s);
          bindError = '';
          failing = null;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
          if (code !== bindError) log.warn(`cannot listen on ${ts.ip}:${cfg.port} yet (${code}); ${retrying}`);
          bindError = code;
          if (failing?.ip !== ts.ip) failing = { ip: ts.ip, since: Date.now() };
          if (Date.now() - failing.since < pollMs) retrySoon();
          return;
        }
      }
      use(ts);
    };
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        await check(await probe());
      } catch (err) {
        log.error('Tailscale check failed', { err });
      } finally {
        busy = false;
      }
      if (mode === 'bind' && !live.ip && !stopped && Date.now() - warnedAt >= 5 * 60_000) {
        warnedAt = Date.now();
        log.warn(`Tailscale is not up: Botons is serving on ${cfg.hosts.join(', ')} only, so other devices cannot reach it. Checking again every ${every}.`);
      }
    };
    // Loopback only until a Tailscale address is bound (or, in names mode, known).
    applyTailnet(cfg, live);
    allowedHosts = allowedHostNames(cfg);
    busy = true;
    try {
      await check(initial);
    } finally {
      busy = false;
      started = true;
    }
    const timer = setInterval(tick, pollMs);
    timer.unref();
    stopTailnet = () => {
      stopped = true;
      clearInterval(timer);
      if (retry) clearTimeout(retry);
    };
    if (mode === 'bind' && !live.ip) void tick(); // warn now, and maybe it just came up
  };

  return {
    store,
    engine,
    connectors,
    skills,
    approvals,
    cards,
    reactions,
    browser,
    oauth,
    workFeed,
    providers,
    hub,
    auth,
    audit,
    setup,
    health,
    recentLogs,
    rehearsals,
    apiKeys,
    spending,
    trash,
    async listen() {
      const { port: hooksPort, hosts: hooksHosts } = cfg.hooks;
      const results = await Promise.allSettled([
        ...cfg.hosts.map(listenOn),
        ...(hooksPort === null ? [] : hooksHosts.map((h) => listenHooksOn(h, hooksPort))),
      ]);
      const bound = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        await closeServers(bound);
        throw failed.reason;
      }
      servers = bound.slice(0, cfg.hosts.length);
      hookServers = bound.slice(cfg.hosts.length);
      if (hooksPort !== null) {
        log.info(`webhooks only (no API, no app) on ${hooksHosts.map((h) => `${h}:${hooksPort}`).join(', ')}`, { webhookUrl: cfg.hooks.publicUrl ?? undefined });
        if (!cfg.hooks.publicUrl) log.warn(`BOTONS_HOOKS_PORT is set but BOTONS_HOOKS_PUBLIC_URL is not, so webhook URLs point at the main listener's URL (${cfg.publicUrl}), not this port. Set BOTONS_HOOKS_PUBLIC_URL to the public URL that reaches port ${hooksPort} (e.g. its Tailscale Funnel URL).`);
      }
      await followTailnet();
      // Only once every listener is bound, so a server that cannot bind leaves
      // the runs alone. The data-dir lock makes what is left running ours to
      // recover; first stop agent CLIs a crashed server left at that work.
      await reapOrphanGroups(cfg.agentsDir);
      engine.pushInterrupted(store.failInterruptedRuns());
      engine.noteCutOffTurns(store.endInterruptedTurns());
      engine.giveUpCutOffChats();
      engine.resume();
      callbacks.resumePending();
      stopScheduler = startScheduler(store, engine, cfg.schedulerIntervalMs, () => {
        health.schedulerTicked();
        try {
          approvals.expireDue();
        } catch (err) {
          log.error('could not expire approval requests', { err });
        }
        // Once a day: the trash past its days, and old inbox files to the trash.
        void trash.housekeep();
        try {
          for (const id of oauth.keepAliveDue()) void oauth.keepAlive(id);
        } catch (err) {
          log.error('could not check OAuth keep-alive', { err });
        }
      });
      workFeed.start();
      return servers;
    },
    async close(opts = {}) {
      // First, so a rehearsal cut off now is recorded as interrupted while the database is open.
      await cliInstaller.close();
      await releases.close();
      brainLogin.cancel();
      await rehearsals.close();
      stopTailnet?.();
      stopScheduler?.();
      const { interrupted } = await engine.drain(opts.drainMs ?? 0);
      await browser.closeAll();
      callbacks.stop();
      await workFeed.stop();
      // Answer ?wait=1 callers and end event streams before the connections go, so what was written last arrives.
      engine.endWaits();
      hub.endStreams();
      await settle(open, 2000);
      await closeServers([...servers, ...hookServers]);
      store.db.close();
      recentLogs.stop();
      lock.release();
      return { interrupted };
    },
  };
}
