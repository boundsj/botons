import { VERSION } from '../../shared/app-version.mjs';
import { cliHome, importCodexSignIn } from './cli-homes.ts';
import { installType } from './install-type.ts';
import { createHash } from 'node:crypto';
import { CliInstaller } from './cli-install.ts';
import { fileURLToPath } from 'node:url';
import { ReleaseChecker, botonsReleaseVersion } from './cli-updates.ts';
import { previewCodexRepairs, repairCodexConfig } from './codex-config-repair.ts';
import { BrainLogin } from './brain-login.ts';
import { existsSync } from 'node:fs';
import type {
  RecentLogs,
  RehearseRestoreInput,
  ApiKeysView,
  ApiKeyState,
  ApiKeyTest,
  RemoveApiKeyInput,
  SaveApiKeyInput,
  SpendingInput,
  SpendingView,
  ApprovalDecisionInput,
  Bot,
  ApprovalRequestInput,
  ToolCallInput,
  AskInput,
  BrowserActionInput,
  BrowserPolicyInput,
  BrowserHandoverStart,
  HandoverNotice,
  ConnectorAccess,
  ConnectorAccessInput,
  ConnectorEnabledInput,
  ConnectorCatalog,
  ConnectorNotice,
  ConnectorPolicyInput,
  ConnectorTest,
  DuplicateBotInput,
  FilePreviewInput,
  FilePreviewLink,
  OAuthConnectionInput,
  NewBotInput,
  CreateRoutineInput,
  CreateSkillInput,
  InstallSkillInput,
  SkillAccessInput,
  SkillDetails,
  Health,
  OperationsStatus,
  McpServerInput,
  NotifyDelivery,
  NotifyInput,
  PairInput,
  PairingRequest,
  ApprovePairingInput,
  ApprovedPairing,
  PairResult,
  Routine,
  RoutineRun,
  RunsAttention,
  RunRoutineInput,
  SaveTemplateInput,
  SetupCheck,
  StarterActivationInput,
  StarterInstall,
  TemplateReview,
  TemplateReviewInput,
  CreatedSidebarGroup,
  CreateSidebarGroupInput,
  MoveSidebarBotInput,
  MoveSidebarGroupInput,
  PinSidebarBotInput,
  SidebarImportResult,
  SidebarLayout,
  SidebarTransfer,
  UpdateSidebarGroupInput,
  UpdateSidebarSectionInput,
  SchedulePreview,
  PinInput,
  ReactInput,
  ReactionImportResult,
  ReactionTransfer,
  SendMessageInput,
  ServerEvent,
  ServerInfo,
  ShareInput,
  StopInput,
  StopResult,
  ProviderSwitchInput,
  ProviderSwitchPreview,
  UpdateBotRequest,
  UpdateRoutineInput,
  UpdateSettingsInput,
  UpdateSkillInput,
  UpdateSetupInput,
  PortableExport,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  DeleteFilesInput,
  InboxPinInput,
  RestoreResult,
  StorageUsage,
  TrashItem,
  TrashResult,
} from '../../shared/types.ts';
import { folderBytes } from './disk-usage.ts';
import { fileKind, formatSize, PREVIEW_MAX_BYTES } from '../../shared/files.ts';
import { ATTENTION_DAYS, BROWSER_CONNECTOR, isValidTimezone } from '../../shared/util.ts';
import { type ApiKeys, apiKeyProvider } from './api-keys.ts';
import type { Spending } from './spend.ts';
import type { Approvals } from './approvals.ts';
import type { Cards } from './cards.ts';
import type { Reactions } from './reactions.ts';
import type { Audit } from './audit.ts';
import type { Browser } from './browser.ts';
import { liveFrame, liveNotice } from '../../shared/live-view.ts';
import { browserUsable, drivesBrowser, NEW_BOTON_SITES, newBotonConnections } from './browser-policy.ts';
import { backupStatus, restorableSchemas } from './backup.ts';
import { botonCapabilities } from './capabilities.ts';
import type { Auth, Principal, RouteAccess } from './auth.ts';
import type { Config } from './config.ts';
import { connectorAccess, setConnectorAccess, setConnectorEnabled } from './connector-access.ts';
import type { Connectors } from './connectors.ts';
import type { Engine } from './engine.ts';
import type { EventHub } from './events.ts';
import type { Trash } from './trash.ts';
import { attachmentsOf, listFolder, receiveUpload, resolveInWorkspace, sendFile, sendPreviewError } from './files.ts';
import type { Callbacks } from './callback.ts';
import type { HealthMonitor } from './health.ts';
import { addHookRoutes } from './hooks.ts';
import { type Ctx, Router } from './http.ts';
import { log } from './log.ts';
import type { OAuthConnections } from './oauth-connections.ts';
import type { ProviderRegistry } from './providers/index.ts';
import type { RecentLogs as RecentLogBuffer } from './recent-logs.ts';
import type { RestoreRehearsals } from './rehearsals.ts';
import { classifyAddress, type Setup } from './setup.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { storageStatus } from './storage.ts';
import { describeSchedule, nextRuns, parseSchedule, toSpec } from './schedule.ts';
import { checkCallbackUrl } from './ssrf.ts';
import type { SkillGrantChange, Skills } from './skills.ts';
import { flag, HttpError, type Store } from './store.ts';
import type { StarterGate } from './starter-gate.ts';
import { reviewStarter, setupCheck, starterConnections } from './starters.ts';
import { Templates } from './templates.ts';
import { Portable, PORTABLE_MAX_BYTES } from './portable.ts';
import { nowIso } from './util.ts';

export { VERSION };
/** Test pushes allowed per minute from the app. */
export const TEST_PUSH_LIMIT = 10;
const TEST_PUSH_WINDOW_MS = 60_000;

/** An ISO time, or a duration back from now ("24h", "7d", "90m"). Default 7 days. */
export function usageSince(raw: string | null, now = Date.now()): Date {
  if (raw === null || raw.trim() === '') return new Date(now - 7 * 86_400_000);
  const d = /^(\d+)\s*(m|h|d)$/i.exec(raw.trim());
  if (d) return new Date(now - Number(d[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2].toLowerCase() as 'm' | 'h' | 'd']);
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) throw new HttpError(400, 'since must be an ISO time or a duration such as 24h or 7d');
  return t;
}

/** What a Boton was given, for the audit log. */
/** Each Boton a skill was given to or taken off, as its own grant change. */
function skillGrantsRecorder(audit: Audit) {
  return (by: Principal | null, skill: string, changed: SkillGrantChange[]) => {
    for (const m of changed) {
      audit.record(by, {
        action: 'boton.permissions_changed',
        target: { kind: 'boton', id: m.botId, label: m.name },
        details: { [m.added ? 'skillsAdded' : 'skillsRemoved']: [skill], via: 'skill', ...(m.wasEvery && { everySkill: true }) },
      });
    }
    if (changed.length) log.info("skill's Botons changed", { skill, added: changed.filter((m) => m.added).map((m) => m.botId), removed: changed.filter((m) => !m.added).map((m) => m.botId) });
  };
}

function grantsOf(bot: Bot): Record<string, string | string[] | null> {
  return { access: bot.access, provider: bot.provider, connections: bot.connections, skills: bot.skills, askFirst: bot.askFirst, alwaysAllow: bot.alwaysAllow };
}

/** What was added to and removed from a Boton's connectors, skills and rules. */
function grantChanges(before: Bot, after: Bot): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const diff = (name: string, a: string[] | null, b: string[] | null) => {
    if (a === null || b === null) {
      if (a !== b) out[name] = [b === null ? 'every skill' : `only: ${b.join(', ') || 'none'}`];
      return;
    }
    const added = b.filter((x) => !a.includes(x));
    const removed = a.filter((x) => !b.includes(x));
    if (added.length) out[`${name}Added`] = added;
    if (removed.length) out[`${name}Removed`] = removed;
  };
  diff('connections', before.connections, after.connections);
  diff('skills', before.skills, after.skills);
  diff('askFirst', before.askFirst, after.askFirst);
  diff('alwaysAllow', before.alwaysAllow, after.alwaysAllow);
  if (before.provider !== after.provider) out.provider = [before.provider, after.provider];
  return out;
}

/** "" if it isn't a URL. */
function urlOrigin(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '';
  }
}

export function buildRouter(deps: {
  cfg: Config;
  store: Store;
  engine: Engine;
  hub: EventHub;
  providers: ProviderRegistry;
  auth: Auth;
  health: HealthMonitor;
  connectors: Connectors;
  skills: Skills;
  approvals: Approvals;
  cards: Cards;
  reactions: Reactions;
  browser: Browser;
  oauth: OAuthConnections;
  audit: Audit;
  setup: Setup;
  callbacks: Callbacks;
  recentLogs: RecentLogBuffer;
  rehearsals: RestoreRehearsals;
  brainLogin: BrainLogin;
  releases: ReleaseChecker;
  cliInstaller: CliInstaller;
  apiKeys: ApiKeys;
  starterGate: StarterGate;
  spending: Spending;
  trash: Trash;
}): Router {
  const { trash } = deps;
  const { cfg, store, engine, hub, providers, auth, health, connectors, skills, approvals, cards, reactions, browser, oauth, audit, setup, callbacks, recentLogs, rehearsals, apiKeys, starterGate, spending } = deps;
  const r = new Router();
  const recordSkillGrants = skillGrantsRecorder(audit);
  const templates = new Templates(cfg.templatesDir, store, skills, cfg.turnTimeoutMs);
  /**
   * What a starter's review reads, all from saved state: the brains as their last checks left them (snapshots, which
   * run no check, however old), the connectors as they are now, and their revisions. Synchronous, so a review and an
   * install's check of it see the same state as the grant that follows.
   */
  const reviewDeps = () => ({
    providers: providers.snapshots(),
    takesConnectors: (id: string) => connectors.takesConnectors(id),
    drivesBrowser: (id: string) => drivesBrowser(providers.get(id)),
    catalog: connectors.catalog().connectors,
    timezone: store.getSettings().timezone,
    revision: (id: string) => starterGate.connectorRevision(id),
    mac: (v: unknown) => starterGate.mac(v),
  });
  const portable = new Portable({ cfg, store, skills, connectors, oauth, browser, providers, templates, spending, app: VERSION, schema: SCHEMA_VERSION });

  // A sandboxed turn's token reaches only the *Read routes, notify, share and
  // approvals: otherwise it could leave routines or memories for the Boton's
  // later turns, which may have Full computer access or ask other Botons.
  const open: RouteAccess = { public: true };
  const ownBot: RouteAccess = { boton: (p) => p.id };
  const ownRoutine: RouteAccess = { boton: (p) => store.routineOwner(p.id) };
  const ownMemory: RouteAccess = { boton: (p) => store.memoryOwner(p.id) };
  const ownRunRead: RouteAccess = { boton: (p) => store.runOwner(p.id), sandboxed: true };
  const ownBotRead: RouteAccess = { ...ownBot, sandboxed: true };
  const ownRoutineRead: RouteAccess = { ...ownRoutine, sandboxed: true };
  const ownApproval: RouteAccess = { boton: (p) => approvals.owner(p.id), sandboxed: true };

  /**
   * A Boton sees a callback URL (often a secret capability) only as its
   * origin. A sandboxed turn also gets webhook keys blanked: with one it could
   * start that routine's runs, which may have Full computer access, with a payload of its choosing.
   */
  const visible = (c: Ctx, routine: Routine): Routine => {
    if (c.principal?.kind !== 'boton' || !routine.webhook) return routine;
    const webhook = { ...routine.webhook, callbackUrl: routine.webhook.callbackUrl === null ? null : urlOrigin(routine.webhook.callbackUrl) };
    if (c.principal.sandboxed) webhook.key = '';
    return { ...routine, webhook };
  };

  // A sandboxed turn sees only its own run's payload and headers: another's may be another sender's data.
  const visibleRun = (c: Ctx, run: RoutineRun): RoutineRun => {
    if (c.principal?.kind !== 'boton') return run;
    let out = run;
    if (run.meta?.callback) out = { ...out, meta: { ...run.meta, callback: { ...run.meta.callback, url: urlOrigin(run.meta.callback.url) } } };
    if (c.principal.sandboxed && run.id !== engine.turnOrigin(c.principal.botId)?.runId) out = { ...out, payloadPreview: null, headers: null };
    return out;
  };

  // A callback URL would let a Boton have the server post its replies anywhere.
  const ownerOnly = async (c: Ctx, input: { webhookWorkspace?: unknown; callbackUrl?: unknown; webhookHistory?: unknown }) => {
    if (c.principal?.kind === 'boton' && input.webhookWorkspace === false) {
      throw new HttpError(403, `Only ${store.getSettings().ownerName} can let webhook runs use Full computer access`);
    }
    // Sharing the chat with a payload from outside is the owner's decision alone; a Boton may only take it back (0).
    if (c.principal?.kind === 'boton' && input.webhookHistory !== undefined && input.webhookHistory !== 0) {
      throw new HttpError(403, `Only ${store.getSettings().ownerName} can share the chat with webhook runs (webhookHistory)`);
    }
    if (input.callbackUrl === undefined) return;
    if (c.principal?.kind === 'boton') throw new HttpError(403, `Only ${store.getSettings().ownerName} can set where run results are sent (callbackUrl)`);
    if (typeof input.callbackUrl === 'string' && input.callbackUrl.trim()) {
      const refused = await checkCallbackUrl(input.callbackUrl.trim(), cfg.callbacks.allow);
      if (refused) throw new HttpError(400, refused);
    }
  };

  // Who may start a routine's runs with Full computer access, and where its results go.
  const auditRoutine = (c: Ctx, before: Routine | null, after: Routine) => {
    const full = (r: Routine | null) => !!r?.webhook && !r.webhookWorkspace;
    const callback = (r: Routine | null) => !!r?.webhook?.callbackUrl;
    const history = (r: Routine | null) => r?.webhookHistory ?? 0;
    if (
      full(before) === full(after) &&
      callback(before) === callback(after) &&
      (before?.webhook?.callbackUrl ?? null) === (after.webhook?.callbackUrl ?? null) &&
      history(before) === history(after)
    ) {
      return;
    }
    audit.record(c.principal, {
      action: 'routine.permissions_changed',
      target: { kind: 'routine', id: after.id, label: after.name },
      details: { boton: after.botId, webhookFullAccess: full(after), callback: after.webhook?.callbackUrl ? urlOrigin(after.webhook.callbackUrl) : null, webhookHistory: history(after) },
    });
  };

  // Open, for the deploy's check: without a device token, no details.
  r.on(
    'GET',
    '/api/health',
    async (c) => {
      const { details, ...summary } = await health.check();
      c.json(summary.ok ? 200 : 503, (c.principal?.kind === 'device' ? { ...summary, details } : summary) satisfies Health);
    },
    open,
  );
  // Paired devices only (the default access): what failed, and the backups, for Settings. Always 200, unlike /api/health.
  r.on('GET', '/api/operations', async (): Promise<OperationsStatus> => ({
    health: await health.owner((id) => engine.usageLimit(id)?.until ?? null),
    schema: SCHEMA_VERSION,
    backups: backupStatus({ backupsDir: cfg.backupsDir, dbExists: existsSync(cfg.dbPath) }),
    push: engine.notifier.status(),
    storage: storageStatus({ home: cfg.home, dbPath: cfg.dbPath }),
    install: installType(cfg.container),
    restorableSchemas: restorableSchemas(SCHEMA_VERSION),
    rehearsal: rehearsals.status(),
  }));
  // Paired devices only (the default access): rehearse restoring a backup into a private temporary folder, never the
  // data folder. Starts it and answers 202; GET /api/operations shows it running, then how it went. One at a time,
  // REHEARSAL_LIMIT an hour, each in the audit log (server/src/rehearsals.ts).
  r.on('POST', '/api/backups/rehearse', async (c) => {
    const input = await c.body<RehearseRestoreInput>();
    c.json(202, rehearsals.start(c.principal, input?.backup ?? 'latest'));
  });
  // Paired devices only (the default access): known events selected from the recent log lines. Read-only, so not audited.
  r.on('GET', '/api/logs', (c): RecentLogs => {
    const q = c.url.searchParams;
    const level = q.get('level');
    if (level !== null && level !== 'info' && level !== 'warn' && level !== 'error') throw new HttpError(400, 'level must be "info", "warn" or "error"');
    const num = (name: string) => {
      const v = q.get(name);
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, `${name} must be a positive whole number`);
      return n;
    };
    return recentLogs.list({ level, q: q.get('q'), boton: q.get('boton'), before: num('before'), limit: num('limit') });
  });
  r.on(
    'GET',
    '/api/info',
    (): ServerInfo => ({ version: VERSION, install: installType(cfg.container), build: cfg.build, hostname: cfg.hostname, urls: cfg.urls, publicUrl: cfg.publicUrl, hooksUrl: cfg.hooks.publicUrl, turnTimeoutMs: cfg.turnTimeoutMs }),
  );
  r.on('GET', '/api/settings', () => store.getSettings());
  r.on('PATCH', '/api/settings', async (c) => {
    const input = await c.body<UpdateSettingsInput>();
    const hadToken = store.getSettings().ntfy.hasToken;
    const settings = store.updateSettings(input);
    engine.notifier.syncConfig();
    // Where pushes go (and with what token) decides who reads them.
    if (input.ntfy && (input.ntfy.server !== undefined || input.ntfy.topic !== undefined || input.ntfy.token !== undefined || input.ntfy.enabled !== undefined)) {
      audit.record(c.principal, {
        action: 'settings.notifications_changed',
        details: { enabled: settings.ntfy.enabled, server: settings.ntfy.server, credentialChanged: input.ntfy.token !== undefined || hadToken !== settings.ntfy.hasToken },
      });
    }
    return settings;
  });

  // First-run setup and the access mode: paired devices only (the default), never a Boton.
  r.on('GET', '/api/setup', (c) => setup.status(auth.remoteAddress(c.req), c.req.headers));
  r.on('PATCH', '/api/setup', async (c) => {
    const { changed } = setup.update(await c.body<UpdateSetupInput>(), auth.remoteAddress(c.req), c.req.headers);
    if (changed.accessMode) audit.record(c.principal, { action: 'access_mode.changed', details: { from: changed.accessMode.from, to: changed.accessMode.to } });
    if (changed.completed) audit.record(c.principal, { action: 'setup.completed', details: { accessMode: setup.accessMode, botons: setup.status().botons } });
    return setup.status(auth.remoteAddress(c.req), c.req.headers);
  });
  r.on('GET', '/api/audit', (c) => {
    const before = Number(c.url.searchParams.get('before') ?? 0) || undefined;
    return audit.list({ before, limit: Number(c.url.searchParams.get('limit') ?? 100) });
  });
  // A test push reaches a phone, so one at a time and at most TEST_PUSH_LIMIT a minute, and each is audited (never the server, topic or token).
  let testInFlight = false;
  const testStarts: number[] = [];
  r.on('POST', '/api/notify/test', async (c): Promise<NotifyDelivery> => {
    if (!store.ntfyConfig()) throw new HttpError(400, 'Set the ntfy server and topic first');
    if (testInFlight) throw new HttpError(409, 'A test push is already being sent');
    const now = Date.now();
    while (testStarts.length && now - testStarts[0] >= TEST_PUSH_WINDOW_MS) testStarts.shift();
    if (testStarts.length >= TEST_PUSH_LIMIT) throw new HttpError(429, `At most ${TEST_PUSH_LIMIT} test pushes a minute; try again shortly`);
    testStarts.push(now);
    testInFlight = true;
    try {
      const sent = await engine.notifier.test();
      if (!sent) throw new HttpError(400, 'Set the ntfy server and topic first');
      const { delivery, problem } = sent;
      audit.record(c.principal, { action: 'notifications.tested', details: { ok: delivery.ok, status: delivery.status, problem } });
      return delivery;
    } finally {
      testInFlight = false;
    }
  });
  r.on('POST', '/api/pause', () => engine.pauseAll(true));
  r.on('POST', '/api/resume', () => engine.pauseAll(false));
  r.on('GET', '/api/usage', (c) => {
    const q = c.url.searchParams;
    const group = q.get('group') ?? 'bot';
    if (group !== 'bot' && group !== 'routine') throw new HttpError(400, 'group must be "bot" or "routine"');
    const botId = q.get('bot') || undefined;
    if (botId) store.getBot(botId);
    return store.usage({ since: usageSince(q.get('since')), group, botId });
  });
  // `recheck`: the owner's "check again", limited per provider (ProviderRegistry.ownerRecheck).
  const brainLogin = deps.brainLogin;
  const pairedOwner = (c: Ctx) => {
    if (c.principal?.kind !== 'device' || !c.principal.deviceId) throw new HttpError(403, 'Pair this device before signing in.');
  };
  r.on('GET', '/api/brain-clis', (c) => { pairedOwner(c); return { checks: deps.releases.view(), installs: ['codex-cli', 'claude-cli'].map(id => deps.cliInstaller.review(id as 'codex-cli' | 'claude-cli')), installing: deps.cliInstaller.busy(), botonsVersion: botonsReleaseVersion(fileURLToPath(new URL('../../', import.meta.url))) }; });
  r.on('POST', '/api/brain-clis/:provider/install', async (c) => {
    pairedOwner(c);
    const id = c.params.provider;
    if (id !== 'codex-cli' && id !== 'claude-cli') throw new HttpError(400, 'Choose a supported CLI.');
    const input = await c.body<{ consent?: unknown; command?: unknown }>();
    if (input?.consent !== true || typeof input.command !== 'string') throw new HttpError(400, 'Review the exact command and explicitly confirm it first.');
    if (brainLogin.view().state === 'waiting') throw new HttpError(409, 'Cancel sign-in before updating a CLI.');
    try {
      await deps.cliInstaller.install(id, input.command, true, (phase, review) => (phase === 'started' ? audit.require.bind(audit) : audit.record.bind(audit))(c.principal, {
        action: `brain.cli_install_${phase}`, details: {provider:id, commandHash:createHash('sha256').update(review.command).digest('hex'), package:id === 'codex-cli' ? '@openai/codex@latest' : '@anthropic-ai/claude-code@latest', command:review.command, bin:review.bin},
      }));
    } catch (e) { throw new HttpError(409, (e as Error).message); }
    return { installed: true };
  });
  r.on('GET', '/api/brain-homes', (c) => { pairedOwner(c); return { codex: cliHome('codex').pending, claude: cliHome('claude').pending }; });
  r.on('POST', '/api/brain-homes/codex/import', async (c) => {
    pairedOwner(c);
    const input = await c.body<{ consent?: unknown }>();
    if (input?.consent !== true) throw new HttpError(400, 'Confirm using your existing sign-in first.');
    if (brainLogin.view().state === 'waiting') throw new HttpError(409, 'Cancel sign-in before copying an existing sign-in.');
    try {
      importCodexSignIn(phase => audit.require(c.principal, { action: `brain.signin_import_${phase}`, details: { provider: 'codex-cli' } }));
    } catch { throw new HttpError(409, 'Could not copy the sign-in. Sign in separately or check again.'); }
    providers.ownerRecheck();
    return { imported: true };
  });
  r.on('GET', '/api/brain-config-repairs', (c) => { pairedOwner(c); return previewCodexRepairs(); });
  r.on('POST', '/api/brain-config-repairs', async (c) => {
    pairedOwner(c);
    const input = await c.body<{ consent?: unknown; id?: unknown; token?: unknown }>();
    if (!input || input.consent !== true || typeof input.id !== 'string' || typeof input.token !== 'string') throw new HttpError(400, 'Review the repair and explicitly confirm it first.');
    try {
      return repairCodexConfig(input.id, input.token, (phase, repair) => audit.require(c.principal, {
        action: `brain.config_repair_${phase}`,
        details: { path: repair.path, target: repair.target, backup: repair.backup },
      }));
    } catch (error) { throw new HttpError(409, (error as Error).message); }
  });
  let loginRechecked = false;
  r.on('GET', '/api/brain-login', (c) => {
    pairedOwner(c);
    const view = brainLogin.view();
    if (view.state === 'finished' && !loginRechecked) { providers.get('codex-cli')?.recheck?.(); loginRechecked = true; }
    else if (view.state !== 'finished') loginRechecked = false;
    return view;
  });
  r.on('POST', '/api/brain-login', (c) => {
    pairedOwner(c);
    if (deps.cliInstaller.busy()) throw new HttpError(409, 'Wait for the CLI update to finish before signing in.');
    loginRechecked = false;
    const result = brainLogin.start();
    audit.record(c.principal, { action: 'brain.signin_started', details: {} });
    return result;
  });
  r.on('DELETE', '/api/brain-login', (c) => {
    pairedOwner(c);
    const result = brainLogin.cancel();
    audit.record(c.principal, { action: 'brain.signin_cancelled', details: {} });
    return result;
  });
  r.on('GET', '/api/providers', async (c) => {
    if (['1', 'true'].includes(c.url.searchParams.get('recheck') ?? '')) providers.ownerRecheck();
    return (await providers.infos()).map((p) => ({ ...p, usageLimit: engine.usageLimit(p.id) }));
  });

  // Paired devices only (the default access; Boton tokens get 403): the owner's API keys. No answer, event, log
  // line or audit row holds a key: only whether there is one, where it comes from and fixed test results.
  r.on('GET', '/api/api-keys', (): ApiKeysView => apiKeys.view());
  r.on('PUT', '/api/api-keys/:provider', async (c): Promise<ApiKeyState> => {
    const provider = apiKeyProvider(c.params.provider);
    const { state, replaced } = apiKeys.save(provider, await c.body<SaveApiKeyInput>());
    audit.record(c.principal, { action: 'api_key.saved', target: { kind: 'api_key', id: provider, label: state.label }, details: { replaced } });
    return state;
  });
  // Removes the saved key only. The answer's `source` says what is used from then on: the environment's, or none.
  r.on('DELETE', '/api/api-keys/:provider', async (c): Promise<ApiKeyState> => {
    const provider = apiKeyProvider(c.params.provider);
    const state = apiKeys.remove(provider, await c.body<RemoveApiKeyInput>());
    audit.record(c.principal, { action: 'api_key.removed', target: { kind: 'api_key', id: provider, label: state.label }, details: { nowUses: state.source } });
    return state;
  });
  // Lists the key's models, read-only, from the provider's fixed address: no prompt, nothing generated.
  r.on('POST', '/api/api-keys/:provider/test', async (c): Promise<ApiKeyTest> => {
    const provider = apiKeyProvider(c.params.provider);
    const test = await apiKeys.test(provider);
    audit.record(c.principal, {
      action: 'api_key.tested',
      target: { kind: 'api_key', id: provider, label: apiKeys.state(provider).label },
      details: { source: test.source, outcome: test.outcome, models: test.models.length, current: test.current },
    });
    return test;
  });

  r.on('POST', '/api/schedule/preview', async (c): Promise<SchedulePreview> => {
    const { schedule, timezone } = await c.body<{ schedule?: string; timezone?: string | null }>();
    if (timezone !== undefined && timezone !== null && (typeof timezone !== 'string' || !isValidTimezone(timezone))) {
      const error = typeof timezone === 'string' && !timezone.trim() ? 'Timezone is empty' : `Unknown timezone ${timezone}`;
      return { ok: false, error, schedule: null, text: null, nextRuns: [] };
    }
    const tz = timezone ?? store.getSettings().timezone;
    try {
      const spec = toSpec(parseSchedule(String(schedule ?? ''), tz));
      return {
        ok: true,
        error: null,
        schedule: spec,
        text: describeSchedule(spec, tz),
        nextRuns: nextRuns(spec, tz, 3).map((d) => d.toISOString()),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, schedule: null, text: null, nextRuns: [] };
    }
  });

  r.on('GET', '/api/connectors', (): ConnectorCatalog => connectors.catalog());
  // The owner's test: lists the connector's tools from this server, calling none. Botons can't (no route access).
  r.on('POST', '/api/connectors/:id/test', async (c): Promise<ConnectorTest> => {
    const test = await connectors.test(c.params.id);
    audit.record(c.principal, {
      action: 'connector.tested',
      target: { kind: 'connector', id: c.params.id, label: c.params.id },
      details: { outcome: test.outcome, tools: test.toolCount },
    });
    return test;
  });
  r.on('GET', '/api/mcp-servers', () => connectors.listServers());
  r.on('POST', '/api/mcp-servers', async (c) => {
    const server = connectors.createServer(await c.body<McpServerInput>());
    audit.record(c.principal, { action: 'mcp_server.created', target: { kind: 'mcp_server', id: server.name, label: server.name }, details: { transport: server.transport } });
    c.json(201, server);
  });
  r.on('GET', '/api/mcp-servers/:name', (c) => connectors.getServer(c.params.name));
  r.on('PATCH', '/api/mcp-servers/:name', async (c) => {
    const server = connectors.updateServer(c.params.name, await c.body<McpServerInput>());
    audit.record(c.principal, { action: 'mcp_server.changed', target: { kind: 'mcp_server', id: c.params.name, label: c.params.name } });
    return server;
  });
  r.on('DELETE', '/api/mcp-servers/:name', (c) => {
    connectors.deleteServer(c.params.name);
    audit.record(c.principal, { action: 'mcp_server.deleted', target: { kind: 'mcp_server', id: c.params.name, label: c.params.name } });
    return { ok: true };
  });

  // Exactly which Botons have one connector, may ask for it or can't use it, and its history; set from the connector.
  const accessDeps = { connectors, store, audit, running: (id: string) => engine.turnsWith(id) };
  r.on('GET', '/api/connectors/:id/access', (c): ConnectorAccess => connectorAccess(accessDeps, c.params.id));
  r.on('PUT', '/api/connectors/:id/access', async (c): Promise<ConnectorAccess> =>
    setConnectorAccess(accessDeps, c.params.id, await c.body<ConnectorAccessInput>(), c.principal),
  );
  // Off or on for every Boton at once; setup, sign-in and grants are kept either way. Owner only, like the rest here.
  r.on('PUT', '/api/connectors/:id/enabled', async (c): Promise<ConnectorAccess> =>
    setConnectorEnabled(accessDeps, c.params.id, await c.body<ConnectorEnabledInput>(), c.principal),
  );
  r.on('PATCH', '/api/connectors/:id/policy', async (c) => {
    const policy = await c.body<ConnectorPolicyInput>();
    const out = connectors.setPolicy(c.params.id, policy);
    audit.record(c.principal, { action: 'connector.policy_changed', target: { kind: 'connector', id: c.params.id, label: c.params.id }, details: { onRequest: policy.onRequest, grant: policy.grant } });
    return out;
  });
  r.on('GET', '/api/oauth-connections', () => ({ connections: oauth.list(), redirectUri: oauth.redirectUri }));
  r.on('POST', '/api/oauth-connections', async (c) => {
    const conn = oauth.create(await c.body<OAuthConnectionInput>());
    audit.record(c.principal, { action: 'oauth.created', target: { kind: 'oauth', id: conn.id, label: conn.name }, details: { server: urlOrigin(conn.url) } });
    c.json(201, conn);
  });
  r.on('GET', '/api/oauth-connections/:id', (c) => oauth.get(c.params.id));
  r.on('PATCH', '/api/oauth-connections/:id', async (c) => oauth.update(c.params.id, await c.body<OAuthConnectionInput>()));
  r.on('DELETE', '/api/oauth-connections/:id', (c) => {
    const name = oauth.get(c.params.id).name;
    oauth.delete(c.params.id);
    connectors.forgetTest(`oauth:${name}`);
    audit.record(c.principal, { action: 'oauth.deleted', target: { kind: 'oauth', id: c.params.id, label: name } });
    return { ok: true };
  });
  // Devices only (the default): the sign-in is bound to the device that starts it.
  r.on('POST', '/api/oauth-connections/:id/connect', async (c) => {
    const { returnTo } = await c.body<{ returnTo?: unknown }>();
    const started = await oauth.startConnect(c.params.id, c.principal?.kind === 'device' ? c.principal.deviceId : null, returnTo);
    audit.record(c.principal, { action: 'oauth.signin_started', target: { kind: 'oauth', id: c.params.id, label: oauth.get(c.params.id).name } });
    return started;
  });
  r.on('POST', '/api/oauth-connections/:id/check', async (c) => {
    oauth.get(c.params.id);
    await engine.workFeed.detect(c.params.id);
    return oauth.get(c.params.id);
  });

  r.on('GET', '/api/auth/status', (c) => auth.status(c.req), open);
  r.on(
    'POST',
    '/api/auth/pair',
    async (c) => {
      const input = await c.body<PairInput>();
      const { device, token, method, claim } = await auth.pair(c.req, input);
      // The new device is the one acting: the one whose request the owner approved, or the owner's own tailnet device.
      audit.record(
        { kind: 'device', id: device.id, label: device.label },
        { action: 'device.paired', target: { kind: 'device', id: device.id, label: device.label }, details: { method, claim, network: classifyAddress(auth.remoteAddress(c.req)) } },
      );
      c.json(201, { device, token } satisfies PairResult);
    },
    open,
  );
  // Asking grants nothing: the request pairs only once the owner approves its code (below, or `npm run pair -- --approve`).
  r.on(
    'POST',
    '/api/auth/pair-requests',
    async (c) => {
      const { label } = await c.body<{ label?: unknown }>();
      c.json(201, auth.requestPairing(c.req, label) satisfies PairingRequest);
    },
    open,
  );  r.on('POST', '/api/auth/logout', (c) => {
    const id = c.principal?.kind === 'device' ? c.principal.deviceId : null;
    if (id) {
      const actor = audit.actorOf(c.principal);
      if (auth.revokeDevice(id)) audit.record(actor, { action: 'device.revoked', target: { kind: 'device', id, label: actor.label }, details: { signedOut: true } });
    }
    return { ok: true };
  });
  r.on('GET', '/api/devices', (c) => auth.devices(c.principal?.kind === 'device' ? c.principal.deviceId : null));
  r.on('DELETE', '/api/devices/:id', (c) => {
    const label = auth.devices(null).find((d) => d.id === c.params.id)?.label ?? c.params.id;
    const actor = audit.actorOf(c.principal);
    if (!auth.revokeDevice(c.params.id)) throw new HttpError(404, `No device with id ${c.params.id}`);
    audit.record(actor, { action: 'device.revoked', target: { kind: 'device', id: c.params.id, label } });
    return { ok: true };
  });
  // Paired devices only (the default): never a Boton, and never a caller without a device token.
  r.on('POST', '/api/pairing-requests/approve', async (c) => {
    const input = await c.body<ApprovePairingInput>();
    const approved = auth.approvePairing(input.code, input.label);
    audit.record(c.principal, { action: 'pairing_request.approved', details: { label: approved.label, requestedAt: approved.createdAt } });
    return approved satisfies ApprovedPairing;
  });

  r.on('GET', '/api/bots', () => store.listBots());
  r.on('POST', '/api/bots', async (c) => {
    const input = await c.body<NewBotInput>();
    // A template brings its connectors and skills unless the request has its own, less the ones this server no longer has.
    const template = input.templateId !== undefined ? templates.find(input.templateId) : null;
    if (template?.needs) {
      // A starter is installed only exactly as reviewed: its connectors are the owner's slot choices, its skills its own.
      if (input.connections !== undefined || input.skills !== undefined) throw new HttpError(400, `${template.name}'s connectors are chosen per slot (starterConnectors) and its skills are its own`);
      if (typeof input.reviewKey !== 'string') throw new HttpError(400, `Review what ${template.name} grants first (POST /api/templates/${template.id}/review)`);
      const provider = input.provider ?? (await providers.defaultProvider());
      // From here to the install nothing awaits, so the connectors can't change between this check and the grant.
      const review = reviewStarter(template, { provider, access: input.access ?? 'workspace', timezone: input.timezone, connectors: input.starterConnectors }, reviewDeps());
      // Stale first: a connector turned off or removed since the review changes the key, and the owner reviews again.
      if (input.reviewKey !== review.reviewKey) throw new HttpError(409, `What installing ${template.name} grants changed since you reviewed it: review it again`);
      if (review.blocked.length) throw new HttpError(400, review.blocked[0]);
      input.provider = provider;
      input.connections = starterConnections(template, input.starterConnectors, drivesBrowser(providers.get(provider)));
      input.skills = template.bot.skills;
    } else {
      // A new Boton gets its own browser for any public site unless the request names its connectors (NEW_BOTON_SITES), or
      // its brain can't run one (an API key brain): then a template's browser is left off too.
      const known = new Set(template && input.connections === undefined ? connectors.catalog().connectors.map((x) => x.id) : []);
      const brain = providers.get(input.provider ?? (await providers.defaultProvider()));
      input.connections = newBotonConnections(input.connections, (template?.bot.connections ?? []).filter((id) => known.has(id)), drivesBrowser(brain));
    }
    if (template && input.skills === undefined) input.skills = template.bot.skills && template.bot.skills.filter((name) => skills.find(name));
    if (input.connections !== undefined) input.connections = connectors.check(input.connections);
    if (input.skills !== undefined) input.skills = skills.checkAllowlist(input.skills, null);
    const defaultProvider = await providers.defaultProvider();
    const bot = store.atomically(() => {
      const created = input.templateId !== undefined
        ? templates.createBot(input, providers.ids(), defaultProvider)
        : store.createBot(input, providers.ids(), defaultProvider);
      if (input.dailyCapUsd !== undefined) spending.update(created.id, { dailyCapUsd: input.dailyCapUsd });
      if (created.connections.includes(BROWSER_CONNECTOR)) browser.importSites(created.id, NEW_BOTON_SITES, created.access);
      audit.record(c.principal, { action: 'boton.created', target: { kind: 'boton', id: created.id, label: created.name }, details: grantsOf(created) });
      return created;
    });
    c.json(201, bot);
  });
  r.on('POST', '/api/bots/:id/duplicate', async (c) => {
    const bot = store.duplicateBot(c.params.id, await c.body<DuplicateBotInput>());
    audit.record(c.principal, { action: 'boton.created', target: { kind: 'boton', id: bot.id, label: bot.name }, details: { ...grantsOf(bot), copyOf: c.params.id } });
    c.json(201, bot);
  });
  r.on('GET', '/api/bots/:id', (c) => store.publicBot(store.getBot(c.params.id)));
  r.on('GET', '/api/bots/:id/capabilities', (c) => {
    const bot = store.getBot(c.params.id);
    const provider = providers.get(bot.provider);
    const brain = { label: provider?.label ?? bot.provider, askFirst: !!provider?.askFirst, serverTools: !!provider?.serverTools };
    return botonCapabilities(store.publicBot(bot), connectors.forBoton(bot), store.listRoutines(bot.id), store.getSettings().ownerName, brain, {
      // A Boton given the browser on a server that can't run one has none: its turns go without it (connectors.ts).
      enabled: browserUsable(browser.enabled(bot.id), browser.known),
      sites: browser.sites(bot.id),
    });
  });
  // Only the owner: what the server saved when a Boton was installed from a starter (null when it wasn't).
  r.on('GET', '/api/bots/:id/starter', (c): StarterInstall | null => {
    const bot = store.getBot(c.params.id);
    const rec = store.starterRecord(bot.id);
    return rec && { botId: bot.id, templateId: rec.templateId, templateName: rec.templateName, slots: rec.slots, installedAt: rec.installedAt, pending: rec.pending };
  });
  // Only the owner: a starter's setup check on a Boton installed from it, from saved state only (it runs nothing).
  // The starter and the slots are the ones the server saved at the install, never the request's.
  r.on('POST', '/api/bots/:id/setup-check', (c): SetupCheck => {
    const bot = store.publicBot(store.getBot(c.params.id));
    const rec = store.starterRecord(bot.id);
    if (!rec) throw new HttpError(400, `${bot.name} was not installed from a starter`);
    const template = templates.find(rec.templateId);
    if (!template?.needs) throw new HttpError(400, `${bot.name}'s starter (${rec.templateName}) is not on this server any more`);
    return setupCheck(template, bot, rec.slots, {
      catalog: connectors.catalog().connectors,
      providers: providers.snapshots(),
      routines: store.listRoutines(bot.id),
      runs: (id) => store.listRuns(id),
      gate: (id) => starterGate.verdict(id, rec),
    });
  });
  // The owner's notices about a Boton's connectors: removed ones (with a Botons connector to offer) and what its last turn went without.
  r.on('GET', '/api/bots/:id/connector-notices', (c): ConnectorNotice[] => connectors.notices(store.getBot(c.params.id)));
  r.on('DELETE', '/api/bots/:id/connector-notices/:connectorId', (c) => {
    const bot = store.getBot(c.params.id);
    if (!connectors.dismissNotice(bot.id, c.params.connectorId)) throw new HttpError(404, `No notice about ${c.params.connectorId} for ${bot.name}`);
    return { ok: true };
  });
  r.on('PATCH', '/api/bots/:id', async (c) => {
    const before = store.getBot(c.params.id);
    const { switchConfirmation, switchSummary, ...input } = (await c.body<UpdateBotRequest>()) ?? {};
    const bot = await engine.updateBot(c.params.id, input, providers.ids(), switchConfirmation, switchSummary);
    const target = { kind: 'boton', id: bot.id, label: bot.name };
    if (before.access !== bot.access) audit.record(c.principal, { action: 'boton.access_changed', target, details: { from: before.access, to: bot.access } });
    const changes = grantChanges(before, bot);
    if (Object.keys(changes).length) audit.record(c.principal, { action: 'boton.permissions_changed', target, details: changes });
    // Its browser connector taken away, its access or brain changed: an open browser closes, or loses what it may no longer reach.
    await browser.refresh(bot.id);
    return bot;
  });
  // What moving a Boton to another provider keeps and loses, and the confirmation the update then needs. Only for
  // paired devices: a Boton can't move itself, nor see this.
  r.on('POST', '/api/bots/:id/switch-preview', async (c): Promise<ProviderSwitchPreview> => {
    const input = (await c.body<ProviderSwitchInput & { connections?: unknown }>()) ?? ({} as ProviderSwitchInput);
    const bot = store.getBot(c.params.id);
    const connections = input.connections === undefined ? undefined : connectors.check(input.connections, bot.connections);
    return engine.switchPreview(bot.id, input, connections);
  });
  // Paired devices only: a Boton can't see or raise its own caps.
  r.on('GET', '/api/bots/:id/spending', (c): SpendingView => spending.view(store.getBot(c.params.id).id));
  r.on('PUT', '/api/bots/:id/spending', async (c): Promise<SpendingView> => {
    const bot = store.getBot(c.params.id);
    const input = (await c.body<SpendingInput>()) ?? {};
    const before = spending.view(bot.id);
    const after = spending.update(bot.id, input);
    // Each cap that changed, as "from → to" in dollars ("none" for no cap).
    const cap = (v: number | null) => (v === null ? 'none' : `$${v}`);
    const details: Record<string, string> = {};
    if (before.dailyCapUsd !== after.dailyCapUsd) details.daily = `${cap(before.dailyCapUsd)} → ${cap(after.dailyCapUsd)}`;
    for (const x of after.routines) {
      const was = before.routines.find((b) => b.id === x.id)?.perRunCapUsd ?? null;
      if (was !== x.perRunCapUsd) details[`routine:${x.id}`] = `${cap(was)} → ${cap(x.perRunCapUsd)}`;
    }
    if (Object.keys(details).length) audit.record(c.principal, { action: 'boton.spending_changed', target: { kind: 'boton', id: bot.id, label: bot.name }, details });
    return after;
  });
  r.on('DELETE', '/api/bots/:id', async (c) => {
    const bot = store.getBot(c.params.id);
    engine.stop(c.params.id);
    await browser.forget(c.params.id);
    store.deleteBot(c.params.id);
    spending.prune();
    audit.record(c.principal, { action: 'boton.deleted', target: { kind: 'boton', id: bot.id, label: bot.name } });
    return { ok: true };
  });
  r.on('POST', '/api/bots/:id/reset', (c) => {
    store.resetContext(c.params.id);
    return { ok: true };
  });
  r.on('POST', '/api/bots/:id/read', async (c) => {
    const { upTo } = await c.body<{ upTo?: unknown }>();
    if (upTo !== undefined && typeof upTo !== 'string') throw new HttpError(400, 'upTo must be a message id');
    return store.markRead(c.params.id, upTo);
  });
  r.on('POST', '/api/bots/:id/stop', async (c): Promise<StopResult> => {
    const clearQueue = flag((await c.body<StopInput>()).clearQueue, 'clearQueue', false);
    store.getBot(c.params.id);
    return engine.stop(c.params.id, { clearQueue });
  });
  r.on('POST', '/api/bots/:id/cancel-runs', (c) => engine.cancelQueuedRuns(c.params.id));
  r.on('POST', '/api/bots/:id/pause', (c) => engine.pauseBot(c.params.id, true));
  r.on('POST', '/api/bots/:id/resume', (c) => engine.pauseBot(c.params.id, false));
  r.on(
    'POST',
    '/api/bots/:id/notify',
    async (c) => {
      const { text, priority } = await c.body<NotifyInput>();
      c.json(201, await engine.notify(c.params.id, text, priority ?? 'default'));
    },
    ownBotRead,
  );

  // The owner's sidebar layout (paired devices only): every change answers with the whole layout and publishes it
  // as sidebar.updated, so every device shows the same.
  r.on('GET', '/api/sidebar', (): SidebarLayout => store.sidebarLayout());
  r.on('POST', '/api/sidebar/groups', async (c) => {
    const { id, layout } = store.createSidebarGroup((await c.body<CreateSidebarGroupInput>()) ?? {});
    c.json(201, { groupId: id, layout } satisfies CreatedSidebarGroup);
  });
  r.on('PATCH', '/api/sidebar/groups/:id', async (c): Promise<SidebarLayout> => store.updateSidebarGroup(c.params.id, (await c.body<UpdateSidebarGroupInput>()) ?? {}));
  r.on('DELETE', '/api/sidebar/groups/:id', (c): SidebarLayout => store.deleteSidebarGroup(c.params.id));
  r.on('POST', '/api/sidebar/groups/:id/move', async (c): Promise<SidebarLayout> => store.moveSidebarGroup(c.params.id, (await c.body<MoveSidebarGroupInput>()) ?? {}));
  r.on('POST', '/api/sidebar/bots/:id/move', async (c): Promise<SidebarLayout> => store.moveSidebarBot(c.params.id, (await c.body<MoveSidebarBotInput>()) ?? ({} as MoveSidebarBotInput)));
  r.on('POST', '/api/sidebar/bots/:id/pin', async (c): Promise<SidebarLayout> => store.pinSidebarBot(c.params.id, (await c.body<PinSidebarBotInput>()) ?? ({} as PinSidebarBotInput)));
  r.on('GET', '/api/sidebar/export', (): SidebarTransfer => store.exportSidebar());
  r.on('POST', '/api/sidebar/import', async (c): Promise<SidebarImportResult> => store.importSidebar(await c.body<unknown>()));
  r.on('PATCH', '/api/sidebar/sections/:key', async (c): Promise<SidebarLayout> => store.setSidebarSection(c.params.key, (await c.body<UpdateSidebarSectionInput>()) ?? ({} as UpdateSidebarSectionInput)));

  r.on('GET', '/api/templates', () => templates.list());
  // Only the owner: what installing a starter would grant, with which of their connectors could fill each slot.
  r.on('POST', '/api/templates/:id/review', async (c): Promise<TemplateReview> => {
    const template = templates.get(c.params.id);
    const input = await c.body<TemplateReviewInput>();
    return reviewStarter(template, input, reviewDeps());
  });
  r.on('POST', '/api/templates', async (c) => c.json(201, templates.save(await c.body<SaveTemplateInput>())));
  r.on('DELETE', '/api/templates/:id', (c) => {
    templates.delete(c.params.id);
    return { ok: true };
  });

  // The owner's configuration as a file of its own, without secrets, and back (portable.ts). Paired devices only.
  r.on('GET', '/api/config/export', (c): PortableExport => {
    const out = portable.export();
    audit.record(c.principal, { action: 'config.exported', details: { botons: out.file.botons.length, skills: out.file.skills.length, connectors: out.file.connectors.length } });
    return out;
  });
  r.on('POST', '/api/config/import/preview', async (c): Promise<PortableImportPreview> => portable.preview(await c.body<PortableImportInput>({ strictUtf8: true })), {}, { maxBody: PORTABLE_MAX_BYTES });
  r.on(
    'POST',
    '/api/config/import',
    async (c): Promise<PortableImportResult> => {
      // Recorded in the import's own transaction: no import is kept without its audit.
      const result = await portable.import(await c.body<PortableImportInput>({ strictUtf8: true }), (result, made) => {
        // Each Boton's spending caps are part of what it was made with, so they are in its own record.
        const cap = (v: number | null) => (v === null ? 'none' : `$${v}`);
        const capsOf = new Map(result.botons.map((m) => [m.botId, m.caps]));
        for (const bot of made) {
          const caps = capsOf.get(bot.id);
          const spending = caps ? { dailyCap: cap(caps.dailyCapUsd), routineCaps: caps.routines.map((r) => `${r.id} ${r.name}: ${cap(r.perRunCapUsd)} a run`) } : {};
          audit.require(c.principal, { action: 'boton.created', target: { kind: 'boton', id: bot.id, label: bot.name }, details: { ...grantsOf(bot), ...spending, via: 'config import' } });
        }
        audit.require(c.principal, {
          action: 'config.imported',
          details: {
            botons: result.botons.length,
            skills: result.skills,
            connectors: result.connectors,
            templates: result.templates.length,
            settings: result.settings,
            sidebar: result.sidebar,
            spendingCaps: result.botons.filter((m) => m.caps.dailyCapUsd !== null || m.caps.routines.length).length,
          },
        });
      });
      if (result.settings) engine.notifier.syncConfig();
      return result;
    },
    {},
    { maxBody: PORTABLE_MAX_BYTES },
  );

  r.on('GET', '/api/bots/:id/team', (c) => store.team(c.params.id), ownBotRead);
  // The token says who asks; :id is who is asked. Not for a sandboxed turn: it would carry a webhook's payload to another Boton.
  r.on(
    'POST',
    '/api/bots/:id/asks',
    async (c) => {
      if (c.principal?.kind !== 'boton') {
        throw new HttpError(400, 'Only a Boton asks another Boton (with `botons ask`, during its turn). To message a Boton yourself, use POST /api/bots/:id/messages.');
      }
      const { text } = await c.body<AskInput>();
      c.json(202, engine.ask(c.principal.botId, c.params.id, text));
    },
    { anyBoton: true },
  );

  // A sandboxed turn may ask too: only the owner's Allow lets its follow-up run outside the sandbox.
  r.on(
    'POST',
    '/api/bots/:id/approvals',
    async (c) => {
      if (c.principal?.kind !== 'boton') {
        throw new HttpError(400, 'Only a Boton asks for approval (with `botons approval request`, during its turn). Decide on requests with POST /api/approvals/:id/decide.');
      }
      const input = await c.body<ApprovalRequestInput>();
      c.json(201, approvals.request(c.params.id, input, { sandboxed: c.principal.sandboxed }));
    },
    { ...ownBot, sandboxed: true },
  );
  r.on(
    'POST',
    '/api/bots/:id/approvals/tool-call',
    async (c) => {
      if (c.principal?.kind !== 'boton') throw new HttpError(400, "Only a Boton's CLI reports a tool call its Ask first rules paused (through `botons mcp`, during its turn).");
      return approvals.toolCall(c.params.id, await c.body<ToolCallInput>(), { sandboxed: c.principal.sandboxed });
    },
    { ...ownBot, sandboxed: true },
  );
  // A Boton's view of connectors (ids and names only), and its requests for one; a sandboxed turn's always need a card.
  r.on('GET', '/api/bots/:id/connectors', (c) => connectors.forBoton(store.getBot(c.params.id)), ownBotRead);
  r.on(
    'POST',
    '/api/bots/:id/connector-requests',
    async (c) => {
      if (c.principal?.kind !== 'boton') throw new HttpError(400, 'Only a Boton asks for a connector (with `botons connector request`). Give one to a Boton in its settings.');
      const { connector } = await c.body<{ connector?: unknown }>();
      const result = approvals.requestConnector(c.params.id, connector, { sandboxed: c.principal.sandboxed });
      // No card and no owner decision: the policy granted it, so the Boton that asked is the actor on record.
      if (result.outcome === 'granted') {
        audit.record(c.principal, {
          action: 'connector.granted',
          target: { kind: 'boton', id: c.params.id, label: store.getBot(c.params.id).name },
          details: { connector: result.connector.id, connectorName: result.connector.name, grant: 'immediate' },
        });
      }
      c.json(201, result);
    },
    { ...ownBot, sandboxed: true },
  );
  r.on('GET', '/api/approvals/:id/tool-call', (c) => approvals.toolVerdict(c.params.id, c.url.searchParams.get('waiter')), ownApproval);
  // Transcript cards (cards.ts): a Boton posts them (a webhook run's too, marked so, never a connector card); only
  // the owner's paired devices answer them, and what an answer does is the server's, from the card as saved.
  r.on(
    'POST',
    '/api/bots/:id/cards',
    async (c) => {
      if (c.principal?.kind !== 'boton') throw new HttpError(400, 'Only a Boton posts cards (with `botons card post`, during its turn). Answer one with POST /api/bots/:id/cards/:card/answer.');
      c.json(201, await cards.post(c.params.id, await c.body<unknown>(), { sandboxed: c.principal.sandboxed }));
    },
    { ...ownBot, sandboxed: true },
  );
  r.on('GET', '/api/cards/:id', (c) => cards.get(c.params.id), { boton: (p) => cards.owner(p.id), sandboxed: true });
  r.on('POST', '/api/bots/:id/cards/:card/answer', async (c) => {
    if (c.principal?.kind !== 'device') throw new HttpError(403, `Only ${store.getSettings().ownerName}'s paired devices can answer cards`);
    return cards.answer(c.params.id, c.params.card, await c.body<unknown>(), c.principal);
  });


  // The managed browser (browser.ts), which a Boton has as the built-in browser connector. Its sites, journal and
  // kill switch are the owner's; a Boton only acts, from the running turn that was given the browser (a webhook
  // run gets no connectors, and its token 403 here), and its own browser only.
  const browserTarget = (id: string) => ({ kind: 'boton', id, label: store.getBot(id).name });
  const deviceOf = (c: Ctx) => (c.principal?.kind === 'device' ? c.principal.deviceId : null);
  r.on('GET', '/api/bots/:id/browser', (c) => browser.status(c.params.id, deviceOf(c)));
  r.on('PUT', '/api/bots/:id/browser', async (c) => {
    const before = browser.policy(c.params.id);
    const status = await browser.setPolicy(c.params.id, await c.body<BrowserPolicyInput>());
    const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
    const details = { sitesAdded: added(before.sites, status.policy.sites), sitesRemoved: added(status.policy.sites, before.sites) };
    if (details.sitesAdded.length || details.sitesRemoved.length) audit.record(c.principal, { action: 'browser.sites_changed', target: browserTarget(c.params.id), details });
    return status;
  });
  // The kill switch: the browser connector comes off the Boton and its browser closes at once, mid-step if need be.
  r.on('POST', '/api/bots/:id/browser/stop', async (c) => {
    const before = store.getBot(c.params.id);
    if (before.connections.includes(BROWSER_CONNECTOR)) {
      const bot = await engine.updateBot(c.params.id, { connections: before.connections.filter((x) => x !== BROWSER_CONNECTOR) }, providers.ids());
      const changes = grantChanges(before, bot);
      if (Object.keys(changes).length) audit.record(c.principal, { action: 'boton.permissions_changed', target: browserTarget(bot.id), details: changes });
    }
    await browser.refresh(c.params.id, 'Stopped by the owner: the browser connector is off and the browser closed.', 'stopped', c.principal);
    audit.record(c.principal, { action: 'browser.stopped', target: browserTarget(c.params.id) });
    return browser.status(c.params.id, deviceOf(c));
  });
  // The owner's handover (browser-handover.ts): paired devices only, never a Boton's token (the default access). One
  // device takes the browser over and alone gets its frames and sends it input; any device can end it.
  r.on('POST', '/api/bots/:id/browser/handover', async (c) => {
    // Optional: the view's size, so the page fits it from the first frame.
    const start = (await c.body().catch(() => ({}))) as BrowserHandoverStart | null;
    c.json(201, await browser.takeOver(c.params.id, c.principal, start && typeof start === 'object' ? start : null));
  });
  r.on('GET', '/api/bots/:id/browser/handover/frame', async (c) => {
    const jpeg = await browser.frame(c.params.id, deviceOf(c));
    c.res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    c.res.end(jpeg);
  });
  // The live view (browser.ts stream): length-prefixed chunks over one long response, for the driving device only (the
  // device token in its Authorization header, as every call). Each chunk: a kind byte (LIVE_FRAME, LIVE_NOTICE), its
  // length, then a frame (its CSS size and the JPEG) or a notice (JSON). Kept nowhere.
  r.on('GET', '/api/bots/:id/browser/handover/stream', async (c) => {
    const { req, res } = c;
    let open = true;
    // Resolves once the chunk has gone, or the response is gone: a frame never waits on a closed connection.
    const write = (chunk: Uint8Array) =>
      new Promise<void>((resolve) => {
        if (!open || res.writableEnded || res.destroyed) return resolve();
        if (res.write(chunk)) return resolve();
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          res.off('error', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
        res.on('error', done);
      });
    const sink = {
      frame: (jpeg: Buffer, width: number, height: number) => write(liveFrame(jpeg, width, height)),
      notice: (n: HandoverNotice) => void write(liveNotice(n)),
      end: () => {
        open = false;
        if (!res.writableEnded) res.end();
      },
    };
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    let stop: (() => void) | null = null;
    const closed = () => {
      open = false;
      stop?.();
    };
    req.on('close', closed);
    res.on('close', closed);
    try {
      stop = await browser.stream(c.params.id, deviceOf(c), sink);
      if (!open) stop();
    } catch (err) {
      // Only a handover that has ended (or isn't this device's) is said to have ended; any other failure just ends
      // this stream, and the device falls back to frames.
      if (err instanceof HttpError && (err.status === 409 || err.status === 403)) await write(liveNotice({ type: 'ended' }));
      sink.end();
    }
  });
  r.on('POST', '/api/bots/:id/browser/handover/input', async (c) => browser.ownerInput(c.params.id, deviceOf(c), await c.body()));
  r.on('POST', '/api/bots/:id/browser/handover/finish', async (c) => {
    const { handover } = await c.body<{ handover?: unknown }>();
    await browser.giveBack(c.params.id, typeof handover === 'string' ? handover : null, 'finished', c.principal);
    return browser.status(c.params.id, deviceOf(c));
  });
  r.on('GET', '/api/bots/:id/browser/journal', (c) => browser.journal(c.params.id));
  r.on(
    'POST',
    '/api/bots/:id/browser/actions',
    async (c) => {
      if (c.principal?.kind !== 'boton') throw new HttpError(400, "Only a Boton's turn drives its browser (through its browser tools).");
      return browser.act(c.params.id, c.principal.tokenId, await c.body<BrowserActionInput>());
    },
    ownBot,
  );
  r.on('GET', '/api/bots/:id/approvals', (c) => approvals.list({ botId: c.params.id, status: c.url.searchParams.get('status') ?? 'all' }), ownBotRead);
  r.on('GET', '/api/approvals', (c) => approvals.list({ status: c.url.searchParams.get('status'), botId: c.url.searchParams.get('bot') || undefined }));
  r.on('GET', '/api/approvals/:id', (c) => approvals.get(c.params.id), ownApproval);
  // Devices only, so no Boton can approve its own request or another's.
  r.on('POST', '/api/approvals/:id/decide', async (c) => {
    if (c.principal?.kind !== 'device') throw new HttpError(403, `Only ${store.getSettings().ownerName}'s paired devices can decide on approval requests`);
    const input = await c.body<ApprovalDecisionInput>();
    const decided = approvals.decide(c.params.id, input, c.principal.deviceId);
    audit.record(c.principal, {
      action: 'approval.decided',
      target: { kind: 'approval', id: decided.id },
      details: { boton: decided.botId, kind: decided.kind, status: decided.status, always: decided.always, connector: decided.connectorId ?? undefined },
    });
    return decided;
  });
  r.on('POST', '/api/approvals/:id/cancel', (c) => approvals.cancel(c.params.id, { sandboxed: c.principal?.kind === 'boton' && c.principal.sandboxed }), ownApproval);

  r.on('GET', '/api/bots/:id/messages', (c) =>
    store.listMessages(c.params.id, {
      before: c.url.searchParams.get('before') ?? undefined,
      after: c.url.searchParams.get('after') ?? undefined,
      limit: Number(c.url.searchParams.get('limit') ?? 100),
    }),
  );
  r.on('GET', '/api/bots/:id/background', (c) => store.backgroundActivity(c.params.id));
  // Devices only: steps can hold secrets.
  r.on('GET', '/api/messages/:id/steps', (c) => {
    const steps = store.messageSteps(c.params.id);
    if (!steps) throw new HttpError(404, `No turn ended with message ${c.params.id}`);
    return steps;
  });
  r.on('POST', '/api/bots/:id/messages', async (c) => {
    const { text, attachments } = await c.body<SendMessageInput>();
    if (text !== undefined && typeof text !== 'string') throw new HttpError(400, 'text must be a string');
    const files = await attachmentsOf(store.getBot(c.params.id).workspace, attachments);
    c.json(202, engine.sendMessage(c.params.id, text ?? '', files));
  });
  // Paired devices only (the default access): a pin decides what every new session of the Boton is given, so no
  // Boton token, its own included, can set one, and no message text can claim one.
  r.on('POST', '/api/bots/:id/messages/:messageId/pin', async (c) => {
    const input = await c.body<PinInput>();
    if (typeof input?.pinned !== 'boolean') throw new HttpError(400, 'pinned must be true or false');
    store.getBot(c.params.id);
    return store.setMessagePinned(c.params.id, c.params.messageId, input.pinned);
  });

  // Reactions (reactions.ts): a paired device reacts as the owner, to the Boton's messages; the Boton's own token as
  // the Boton, to the owner's own messages in its chat, never in a sandboxed turn (which must not change what its
  // later turns know). Feedback only: no approval, card or permission reads them.
  const ownReaction: RouteAccess = { boton: (p) => p.id };
  r.on('POST', '/api/bots/:id/messages/:messageId/reactions', async (c) => reactions.react(c.params.id, c.params.messageId, (await c.body<ReactInput>())?.emoji, c.principal), ownReaction);
  r.on('DELETE', '/api/bots/:id/messages/:messageId/reactions/:emoji', (c) => reactions.unreact(c.params.id, c.params.messageId, c.params.emoji, c.principal), ownReaction);
  // A Boton's only: it has one at most. The owner names the emoji to take off.
  r.on(
    'DELETE',
    '/api/bots/:id/messages/:messageId/reactions',
    (c) => {
      if (c.principal?.kind !== 'boton') throw new HttpError(400, 'Name the reaction to take off: DELETE /api/bots/:id/messages/:messageId/reactions/:emoji');
      return reactions.unreact(c.params.id, c.params.messageId, null, c.principal);
    },
    ownReaction,
  );
  // Paired devices only (the default access).
  r.on('GET', '/api/reactions/export', (): ReactionTransfer => reactions.export());
  r.on('POST', '/api/reactions/import', async (c): Promise<ReactionImportResult> => reactions.import(await c.body<unknown>()));

  // Devices only: a Boton reaches only `share`, which never returns a file.
  r.on('GET', '/api/bots/:id/files', async (c) => {
    const listing = await listFolder(store.getBot(c.params.id).workspace, c.url.searchParams.get('path') ?? '');
    if (listing.path !== 'inbox') return listing;
    const pins = new Set(store.inboxPins(c.params.id));
    return { ...listing, entries: listing.entries.map((e) => ({ ...e, pinned: pins.has(e.name) })) };
  });

  // Deleting, the trash and the inbox (trash.ts). Paired devices only (the default access): no Boton token, its own
  // included, reaches these; a Boton deletes its own files with its own tools, in its workspace, as before.
  r.on('POST', '/api/bots/:id/files/delete', async (c): Promise<TrashResult> => trash.delete(c.params.id, (await c.body<DeleteFilesInput>())?.paths, audit.actorOf(c.principal)));
  r.on('POST', '/api/bots/:id/inbox/clear', (c): Promise<TrashResult> => trash.clearInbox(c.params.id, audit.actorOf(c.principal)));
  r.on('POST', '/api/bots/:id/inbox/pins', async (c) => {
    const input = await c.body<InboxPinInput>();
    return trash.setPinned(c.params.id, input?.path, input?.pinned);
  });
  r.on('GET', '/api/bots/:id/trash', (c): Promise<TrashItem[]> => {
    store.getBot(c.params.id);
    return trash.list({ botId: c.params.id });
  });
  r.on('POST', '/api/bots/:id/trash/empty', (c) => {
    store.getBot(c.params.id);
    return trash.empty({ botId: c.params.id }, audit.actorOf(c.principal));
  });
  r.on('GET', '/api/trash', (): Promise<TrashItem[]> => trash.list());
  r.on('POST', '/api/trash/:itemId/restore', (c): Promise<RestoreResult> => trash.restore(c.params.itemId, audit.actorOf(c.principal)));
  r.on('DELETE', '/api/trash/:itemId', (c) => trash.purge(c.params.itemId, audit.actorOf(c.principal)));
  r.on('GET', '/api/bots/:id/storage', async (c) => {
    const { partial, ...mine } = await trash.botStorage(store.getBot(c.params.id));
    const shared = await trash.sharedStorage();
    return { ...mine, sharedBytes: shared.sharedBytes, sharedTrashItems: shared.sharedTrashItems, sharedTrashBytes: shared.sharedTrashBytes, partial: partial || shared.partial };
  });
  r.on('GET', '/api/storage', (): Promise<StorageUsage> => trash.usage());

  // The shared folder, for the owner: listed, downloaded (never shown inline: any Boton can write it), deleted to the
  // trash and restored. Paired devices only (the default access); its own folder can't be deleted.
  r.on('GET', '/api/shared/files', (c) => listFolder(cfg.sharedDir, c.url.searchParams.get('path') ?? ''));
  r.on('GET', '/api/shared/files/raw', (c) => sendFile(c.req, c.res, cfg.sharedDir, c.url.searchParams.get('path') ?? '', 'download'), { urlKey: 'files' });
  r.on('POST', '/api/shared/files/delete', async (c): Promise<TrashResult> => trash.deleteShared((await c.body<DeleteFilesInput>())?.paths, audit.actorOf(c.principal)));
  r.on('GET', '/api/shared/trash', (): Promise<TrashItem[]> => trash.list({ origin: 'shared' }));
  r.on('POST', '/api/shared/trash/empty', (c) => trash.empty({ origin: 'shared' }, audit.actorOf(c.principal)));
  r.on(
    'GET',
    '/api/bots/:id/files/raw',
    async (c) => {
      const download = ['1', 'true'].includes(c.url.searchParams.get('download') ?? '');
      await sendFile(c.req, c.res, store.getBot(c.params.id).workspace, c.url.searchParams.get('path') ?? '', download ? 'download' : 'raw');
    },
    { urlKey: 'files' },
  );
  // An HTML file's sandboxed preview page (see PREVIEW_CSP). Its script can read the page's URL, so the
  // URL holds a key for this one file, never the device's files key.
  r.on('POST', '/api/bots/:id/files/preview', async (c) => {
    const { path } = await c.body<FilePreviewInput>();
    const bot = store.getBot(c.params.id);
    const found = await resolveInWorkspace(bot.workspace, path);
    if (!found.stat.isFile()) throw new HttpError(400, 'That is not a file');
    if (fileKind(found.rel) !== 'html') throw new HttpError(400, 'Only HTML files have a preview page');
    // Its size now, not the listing's: the page itself refuses one this big.
    if (found.stat.size > PREVIEW_MAX_BYTES) throw new HttpError(413, `Too big to preview (over ${formatSize(PREVIEW_MAX_BYTES)}); download it instead`);
    const deviceId = c.principal?.kind === 'device' ? c.principal.deviceId : null;
    const signed = auth.previewKey(deviceId, bot.id, found.rel);
    if (!signed && auth.required) throw new HttpError(403, 'Only a paired device can open a preview');
    const url = `/api/bots/${encodeURIComponent(bot.id)}/files/preview?path=${encodeURIComponent(found.rel)}${signed ? `&key=${encodeURIComponent(signed.key)}` : ''}`;
    return { url, expiresAt: signed ? new Date(signed.expiresAt).toISOString() : null, size: found.stat.size } satisfies FilePreviewLink;
  });
  r.on(
    'GET',
    '/api/bots/:id/files/preview',
    async (c) => {
      const path = c.url.searchParams.get('path') ?? '';
      try {
        // The key before anything else, so nobody without one learns which Botons or files exist.
        if (!auth.previewAllowed(c.url.searchParams.get('key'), c.params.id, path)) {
          throw new HttpError(401, 'This preview link is not valid, or has expired. Open the file again in the app.');
        }
        await sendFile(c.req, c.res, store.getBot(c.params.id).workspace, path, 'preview');
      } catch (err) {
        // The frame (or tab) shows a page that says why, and tells the viewer, rather than raw JSON.
        if (err instanceof HttpError && !c.res.headersSent) return sendPreviewError(c.res, err);
        throw err;
      }
    },
    open,
  );
  r.on('POST', '/api/bots/:id/uploads', async (c) => {
    const bot = store.getBot(c.params.id);
    const file = await receiveUpload(c.req, bot.workspace, c.url.searchParams.get('name') ?? '', bot.timezone);
    log.info('file uploaded', { botId: bot.id, path: file.path, size: file.size });
    c.json(201, file);
  });
  r.on(
    'POST',
    '/api/bots/:id/share',
    async (c) => {
      const { path, title } = await c.body<ShareInput>();
      c.json(201, await engine.shareFile(c.params.id, path, title));
    },
    ownBotRead,
  );

  r.on('GET', '/api/bots/:id/routines', (c) => store.listRoutines(c.params.id).map((r) => visible(c, r)), ownBotRead);
  r.on(
    'POST',
    '/api/bots/:id/routines',
    async (c) => {
      const input = await c.body<CreateRoutineInput>();
      await ownerOnly(c, input);
      if (input.skill !== undefined) input.skill = skills.checkRoutineSkill(c.params.id, input.skill);
      const routine = store.createRoutine(c.params.id, input);
      auditRoutine(c, null, routine);
      c.json(201, routine);
    },
    ownBot,
  );
  r.on('GET', '/api/routines/:id', (c) => visible(c, store.getRoutine(c.params.id)), ownRoutineRead);
  r.on(
    'PATCH',
    '/api/routines/:id',
    async (c) => {
      const input = await c.body<UpdateRoutineInput>();
      await ownerOnly(c, input);
      // Only a new skill is checked: the editor sends the current one back with
      // every save, and one the Boton can no longer use must not block other changes.
      const current = store.getRoutine(c.params.id);
      if (input.skill !== undefined && input.skill !== current.skill) input.skill = skills.checkRoutineSkill(current.botId, input.skill);
      const routine = store.updateRoutine(c.params.id, input);
      auditRoutine(c, current, routine);
      return routine;
    },
    ownRoutine,
  );
  // Only the owner, never a Boton: turning on a starter's routine, after its test run or by overriding that (starter-gate.ts).
  r.on('POST', '/api/routines/:id/activate', async (c) => {
    const input = (await c.body<StarterActivationInput>()) ?? {};
    const override = flag(input.override, 'override', false);
    return store.atomically(() => {
      const { routine, gate } = starterGate.activate(c.params.id, override);
      audit.require(c.principal, {
        action: 'routine.starter_activated',
        target: { kind: 'routine', id: routine.id, label: routine.name },
        details: { boton: routine.botId, override: !gate.tested, testRunId: gate.runId },
      });
      return routine;
    });
  });
  r.on(
    'DELETE',
    '/api/routines/:id',
    (c) => {
      store.deleteRoutine(c.params.id);
      spending.prune();
      return { ok: true };
    },
    ownRoutine,
  );
  r.on(
    'POST',
    '/api/routines/:id/run',
    async (c) => {
      const input = await c.body<RunRoutineInput>();
      const test = flag(input.test, 'test', input.payload !== undefined);
      if (!test && input.payload !== undefined) throw new HttpError(400, 'A payload makes a test run; leave test out or set it to true');
      const payload = input.payload === undefined || input.payload === null ? null : typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
      c.json(202, engine.triggerRoutine(c.params.id, test ? 'test' : 'manual', payload?.trim() ? payload : null));
    },
    ownRoutine,
  );
  // Only the owner (the default): it spans every Boton, payload previews included.
  r.on('GET', '/api/runs/attention', (): RunsAttention => store.attentionRuns(new Date(Date.now() - ATTENTION_DAYS * 86_400_000).toISOString()));
  // Only the owner: a retry re-runs a payload from outside, maybe with Full computer access.
  r.on('POST', '/api/runs/:id/retry', (c) => {
    const run = engine.retryRun(c.params.id);
    const routine = store.getRoutine(run.routineId);
    audit.record(c.principal, {
      action: 'run.retried',
      target: { kind: 'routine', id: routine.id, label: routine.name },
      details: { boton: run.botId, runId: run.meta!.retryOf!.runId, retryRunId: run.id, trigger: run.trigger },
    });
    c.json(202, run);
  });
  // Only the owner: it ends a run a webhook sender or a schedule started, maybe part-way through.
  r.on('POST', '/api/runs/:id/cancel', async (c) => {
    const before = store.getRun(c.params.id);
    const run = await engine.cancelRun(before.id);
    audit.record(c.principal, {
      action: 'run.cancelled',
      target: { kind: 'routine', id: run.routineId, label: store.findRoutineName(run.routineId) ?? run.routineId },
      details: { boton: run.botId, runId: run.id, trigger: run.trigger, was: before.status, status: run.status, cancelled: !!run.meta?.cancelled },
    });
    return run;
  });
  // Only the owner: it sends a run's result again, to the URL only the owner sets.
  r.on('POST', '/api/runs/:id/callback', (c) => {
    const run = callbacks.resend(c.params.id);
    const routine = store.getRoutine(run.routineId);
    audit.record(c.principal, {
      action: 'run.callback_resent',
      target: { kind: 'routine', id: routine.id, label: routine.name },
      details: { boton: run.botId, runId: run.id, callback: urlOrigin(run.meta!.callback!.url) },
    });
    c.json(202, run);
  });
  r.on('GET', '/api/routines/:id/runs', (c) => store.listRuns(c.params.id).map((run) => visibleRun(c, run)), ownRoutineRead);
  r.on(
    'GET',
    '/api/runs/:id/payload',
    (c) => {
      if (c.principal?.kind === 'boton' && c.principal.sandboxed && c.params.id !== engine.turnOrigin(c.principal.botId)?.runId) {
        throw new HttpError(403, "This run was started by a webhook, so it can only read its own run's payload, not another run's.");
      }
      return store.runPayload(c.params.id);
    },
    ownRunRead,
  );

  r.on('GET', '/api/skills', () => skills.list());
  r.on('POST', '/api/skills', async (c) => c.json(201, skills.create(await c.body<CreateSkillInput>())));
  r.on('GET', '/api/skills/:name', (c) => skills.get(c.params.name));
  r.on('PATCH', '/api/skills/:name', async (c) => skills.update(c.params.name, await c.body<UpdateSkillInput>()));
  r.on('POST', '/api/skills/:name/approve', async (c) => {
    const out = skills.approve(c.params.name, (await c.body<{ version?: unknown }>()).version);
    audit.record(c.principal, { action: 'skill.approved', target: { kind: 'skill', id: c.params.name, label: c.params.name } });
    return out;
  });
  r.on('DELETE', '/api/skills/:name', (c) => {
    skills.delete(c.params.name);
    return { ok: true };
  });
  // A skill's Botons, earlier texts and history; the owner only (paired devices), never a Boton.
  r.on('GET', '/api/skills/:name/details', (c): SkillDetails => ({
    skill: skills.get(c.params.name),
    access: skills.access(c.params.name),
    history: skills.history(c.params.name),
    audit: audit.about([{ kind: 'skill', id: c.params.name }], c.params.name, 50, 'skill'),
  }));
  r.on('PUT', '/api/skills/:name/access', async (c) => {
    recordSkillGrants(c.principal, c.params.name, skills.setAccess(c.params.name, await c.body<SkillAccessInput>()));
    return skills.access(c.params.name);
  });
  r.on('PUT', '/api/skills/:name/enabled', async (c) => {
    const before = skills.get(c.params.name);
    const out = skills.setEnabled(c.params.name, (await c.body<{ enabled?: unknown }>()).enabled);
    if (before.disabled !== out.disabled) audit.record(c.principal, { action: out.disabled ? 'skill.disabled' : 'skill.enabled', target: { kind: 'skill', id: out.name, label: out.name } });
    return out;
  });
  r.on('POST', '/api/skills/:name/restore', async (c) => {
    const out = skills.restore(c.params.name, await c.body<{ id?: unknown; current?: unknown }>());
    audit.record(c.principal, { action: 'skill.restored', target: { kind: 'skill', id: out.skill.name, label: out.skill.name }, details: { from: out.from, to: out.to } });
    return out.skill;
  });
  // Skill packages: folders in BOTONS_HOME/skill-packages, read as text and never run. Installing takes exactly what was reviewed.
  r.on('GET', '/api/skill-packages', () => skills.packages());
  r.on('GET', '/api/skill-packages/:folder', (c) => skills.review(c.params.folder));
  r.on('POST', '/api/skill-packages/:folder/install', async (c) => {
    const out = skills.install(c.params.folder, await c.body<InstallSkillInput>());
    audit.record(c.principal, {
      action: 'skill.installed',
      target: { kind: 'skill', id: out.skill.name, label: out.skill.name },
      // A field's value is the package's text: only its name is kept.
      details: { package: c.params.folder, label: out.label, version: out.skill.version, from: out.from, accepted: out.accepted.map((a) => a.replace(/^(asks for [^:]+):.*$/s, '$1')) },
    });
    recordSkillGrants(c.principal, out.skill.name, out.grants);
    return out.skill;
  });
  r.on('GET', '/api/bots/:id/skills', (c) => skills.forBot(store.getBot(c.params.id)), ownBotRead);
  r.on('GET', '/api/bots/:id/skills/:name', (c) => skills.getFor(c.params.id, c.params.name), ownBotRead);
  r.on('POST', '/api/bots/:id/skills', async (c) => c.json(201, skills.createByBoton(c.params.id, await c.body<CreateSkillInput>())), ownBot);
  r.on('PATCH', '/api/bots/:id/skills/:name', async (c) => skills.updateByBoton(c.params.id, c.params.name, await c.body<UpdateSkillInput>()), ownBot);
  // Kept with the turns, after the run itself drops out of the history.
  r.on('GET', '/api/runs/:id/steps', (c) => {
    const steps = store.runSteps(c.params.id);
    if (!steps.length && !store.findRun(c.params.id)) throw new HttpError(404, `No run with id ${c.params.id}`);
    return steps;
  });

  r.on('GET', '/api/bots/:id/memories', (c) => store.listMemories(c.params.id), ownBotRead);
  r.on(
    'POST',
    '/api/bots/:id/memories',
    async (c) => {
      const { text } = await c.body<{ text?: string }>();
      c.json(201, store.addMemory(c.params.id, String(text ?? '')));
    },
    ownBot,
  );
  r.on(
    'DELETE',
    '/api/memories/:id',
    (c) => {
      store.deleteMemory(c.params.id);
      return { ok: true };
    },
    ownMemory,
  );

  r.on('GET', '/api/events', (c) => {
    const { req, res } = c;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (ev: ServerEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    send({ type: 'hello', serverTime: nowIso(), build: cfg.build });
    // Closing: the client reconnects to the next server.
    if (engine.closing.aborted) return void res.end();
    const unsubscribe = hub.subscribe(send);
    // A revoke made with `npm run pair -- --revoke` is noticed at the next ping.
    const untrack = auth.trackStream(c.principal, () => res.end());
    const unstream = hub.addStream(() => res.end());
    // A data event, not an SSE comment: EventSource hides comments, and the web app uses pings to spot a dead connection.
    const ping = setInterval(
      () => (auth.isLive(c.principal) ? send({ type: 'ping', serverTime: nowIso() }) : res.end()),
      cfg.ssePingMs,
    );
    const stop = () => {
      clearInterval(ping);
      unsubscribe();
      untrack();
      unstream();
    };
    req.on('close', stop);
    res.on('close', stop);
  }, { urlKey: 'events' });

  addHookRoutes(r, { cfg, store, engine });

  return r;
}
