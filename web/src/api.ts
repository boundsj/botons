import type {
  BackgroundActivity,
  BotStorage,
  RestoreResult,
  StorageUsage,
  TrashItem,
  TrashResult,
  CodexConfigRepair,
  CodexConfigRepairResult,
  ApiKeyProvider,
  ApiKeyState,
  ApiKeysView,
  SpendingInput,
  SpendingView,
  ApiKeyTest,
  ProviderSwitchInput,
  ProviderSwitchPreview,
  UpdateBotRequest,
  AuditEvent,
  Health,
  BotonCapabilities,
  SetupStatus,
  UpdateSetupInput,
  Approval,
  ApprovalDecisionInput,
  AuthStatus,
  Bot,
  BotTemplate,
  CancelRunsResult,
  ConnectorAccess,
  ConnectorAccessInput,
  ConnectorEnabledInput,
  ConnectorCatalog,
  ConnectorNotice,
  ConnectorPolicyInput,
  ConnectorTest,
  Connector,
  OAuthConnection,
  OAuthConnectionInput,
  OAuthConnectStart,
  DuplicateBotInput,
  CreateRoutineInput,
  CreateSkillInput,
  Device,
  FileListing,
  FilePreviewLink,
  FileRef,
  McpServer,
  McpServerInput,
  Memory,
  Message,
  NewBotInput,
  NotifyDelivery,
  PairInput,
  PairingRequest,
  ApprovePairingInput,
  ApprovedPairing,
  PairResult,
  ProviderInfo,
  Routine,
  RoutineRun,
  RunsAttention,
  OperationsStatus,
  RehearseRestoreInput,
  RestoreRehearsal,
  RecentLogLevel,
  RecentLogs,
  RunPayload,
  RunRoutineInput,
  SaveTemplateInput,
  SetupCheck,
  StarterActivationInput,
  StarterInstall,
  TemplateReview,
  TemplateReviewInput,
  SchedulePreview,
  ServerInfo,
  Settings,
  InstallSkillInput,
  Skill,
  SkillAccess,
  SkillAccessInput,
  SkillDetails,
  SkillPackageReview,
  SkillPackagesList,
  StopResult,
  TurnSteps,
  UpdateBotInput,
  UpdateRoutineInput,
  UpdateSettingsInput,
  UpdateSkillInput,
  UsageReport,
  BrowserHandover,
  BrowserHandoverInput,
  BrowserHandoverResult,
  BrowserHandoverStart,
  BrowserJournalEntry,
  BrowserPolicyInput,
  BrowserStatus,
  CreatedSidebarGroup,
  SidebarLayout,
  SidebarSectionKey,
  PortableExport,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
} from '../../shared/types.ts';
import type { CardAnswerInput } from '../../shared/cards.ts';
import { deviceToken, setDeviceToken, setUrlKeys, urlKeys, withKey } from './device.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The request got no answer: the network or the server is down. */
export class OfflineError extends Error {
  constructor(message = "Can't reach the server") {
    super(message);
    this.name = 'OfflineError';
  }
}

async function reach(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new OfflineError();
  }
}

let onUnauthorized: (() => void) | null = null;

export function whenUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

function authHeaders(): Record<string, string> {
  const token = deviceToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const get = method === 'GET';
  const res = await reach(path, {
    method,
    headers: get ? authHeaders() : { ...authHeaders(), 'content-type': 'application/json' },
    body: get ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  events: () => new EventSource(withKey('/api/events', urlKeys()?.events)),
  async authStatus(): Promise<AuthStatus> {
    const status = await call<AuthStatus>('GET', '/api/auth/status');
    setUrlKeys(status.urlKeys);
    if (status.required && status.caller === 'none') setDeviceToken(null);
    return status;
  },
  async pair(input: PairInput): Promise<PairResult> {
    const result = await call<PairResult>('POST', '/api/auth/pair', input);
    setDeviceToken(result.token);
    return result;
  },
  async logout(): Promise<{ ok: true }> {
    try {
      return await call<{ ok: true }>('POST', '/api/auth/logout');
    } finally {
      setDeviceToken(null);
      setUrlKeys(null);
    }
  },
  devices: () => call<Device[]>('GET', '/api/devices'),
  revokeDevice: (id: string) => call<{ ok: true }>('DELETE', `/api/devices/${enc(id)}`),
  /** This device asks to pair: keep `secret`, show `code` for the owner to approve. */
  pairRequest: (label: string) => call<PairingRequest>('POST', '/api/auth/pair-requests', { label }),
  /** The owner approves the device showing `code` (from a paired device). */
  approvePairing: (input: ApprovePairingInput) => call<ApprovedPairing>('POST', '/api/pairing-requests/approve', input),

  info: () => call<ServerInfo>('GET', '/api/info'),
  health: () => call<Health>('GET', '/api/health'),
  setup: () => call<SetupStatus>('GET', '/api/setup'),
  updateSetup: (input: UpdateSetupInput) => call<SetupStatus>('PATCH', '/api/setup', input),
  audit: (before?: number) => call<AuditEvent[]>('GET', `/api/audit?limit=50${before ? `&before=${before}` : ''}`),
  capabilities: (botId: string) => call<BotonCapabilities>('GET', `/api/bots/${enc(botId)}/capabilities`),
  browser: (botId: string) => call<BrowserStatus>('GET', `/api/bots/${enc(botId)}/browser`),
  setBrowser: (botId: string, input: BrowserPolicyInput) => call<BrowserStatus>('PUT', `/api/bots/${enc(botId)}/browser`, input),
  stopBrowser: (botId: string) => call<BrowserStatus>('POST', `/api/bots/${enc(botId)}/browser/stop`),
  browserJournal: (botId: string) => call<BrowserJournalEntry[]>('GET', `/api/bots/${enc(botId)}/browser/journal`),
  takeOverBrowser: (botId: string, start: BrowserHandoverStart = {}) => call<BrowserHandover>('POST', `/api/bots/${enc(botId)}/browser/handover`, start),
  /** The live view of this device's handover: a long response of chunks (shared/live-view.ts), read as they come. */
  async handoverStream(botId: string, signal: AbortSignal): Promise<Response> {
    const res = await reach(`/api/bots/${enc(botId)}/browser/handover/stream`, { headers: authHeaders(), signal, cache: 'no-store' });
    if (res.status === 401) onUnauthorized?.();
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.ok ? 503 : res.status, data?.error ?? `Request failed (${res.status})`);
    }
    return res;
  },
  handoverInput: (botId: string, input: BrowserHandoverInput) => call<BrowserHandoverResult>('POST', `/api/bots/${enc(botId)}/browser/handover/input`, input),
  finishHandover: (botId: string, handover: string | null) => call<BrowserStatus>('POST', `/api/bots/${enc(botId)}/browser/handover/finish`, { handover }),
  /** What the owner's browser shows now (a JPEG, made on demand and kept nowhere). */
  async handoverFrame(botId: string, signal?: AbortSignal): Promise<Blob> {
    const res = await reach(`/api/bots/${enc(botId)}/browser/handover/frame`, { headers: authHeaders(), signal, cache: 'no-store' });
    if (res.status === 401) onUnauthorized?.();
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
    }
    return res.blob();
  },
  settings: () => call<Settings>('GET', '/api/settings'),
  updateSettings: (patch: UpdateSettingsInput) => call<Settings>('PATCH', '/api/settings', patch),
  testPush: () => call<NotifyDelivery>('POST', '/api/notify/test'),
  apiKeys: () => call<ApiKeysView>('GET', '/api/api-keys'),
  spending: (botId: string) => call<SpendingView>('GET', `/api/bots/${enc(botId)}/spending`),
  setSpending: (botId: string, input: SpendingInput) => call<SpendingView>('PUT', `/api/bots/${enc(botId)}/spending`, input),
  saveApiKey: (provider: ApiKeyProvider, key: string, generation: number) => call<ApiKeyState>('PUT', `/api/api-keys/${provider}`, { key, generation }),
  removeApiKey: (provider: ApiKeyProvider, generation: number) => call<ApiKeyState>('DELETE', `/api/api-keys/${provider}`, { generation }),
  testApiKey: (provider: ApiKeyProvider) => call<ApiKeyTest>('POST', `/api/api-keys/${provider}/test`),
  rehearseRestore: (backup: string) => call<RestoreRehearsal>('POST', '/api/backups/rehearse', { backup } satisfies RehearseRestoreInput),
  pauseAll: (paused: boolean) => call<Settings>('POST', paused ? '/api/pause' : '/api/resume'),
  usage: (since: string, group: 'bot' | 'routine', botId?: string) =>
    call<UsageReport>('GET', `/api/usage?since=${enc(since)}&group=${group}${botId ? `&bot=${enc(botId)}` : ''}`),
  brainHomes: () => call<{codex: boolean; claude: boolean}>('GET', '/api/brain-homes'),
  importCodexSignIn: () => call('POST', '/api/brain-homes/codex/import', { consent: true }),
  brainConfigRepairs: () => call<CodexConfigRepair[]>('GET', '/api/brain-config-repairs'),
  repairBrainConfig: (id: string, token: string) => call<CodexConfigRepairResult>('POST', '/api/brain-config-repairs', { id, token, consent: true }),
  installBrainCli: (provider: string, command: string) => call<{installed: boolean}>('POST', `/api/brain-clis/${provider}/install`, {consent:true, command}),
  brainClis: () => call<import('../../shared/types.ts').BrainReleaseStatus>('GET', '/api/brain-clis'),
  brainLogin: () => call<{state: string; url: string | null; code: string | null}>('GET', '/api/brain-login'),
  startBrainLogin: () => call<{state: string; url: string | null; code: string | null}>('POST', '/api/brain-login'),
  cancelBrainLogin: () => call<{state: string; url: string | null; code: string | null}>('DELETE', '/api/brain-login'),
  providers: (recheck = false) => call<ProviderInfo[]>('GET', `/api/providers${recheck ? '?recheck=1' : ''}`),

  bots: () => call<Bot[]>('GET', '/api/bots'),
  sidebar: () => call<SidebarLayout>('GET', '/api/sidebar'),
  createSidebarGroup: (name: string, index?: number) => call<CreatedSidebarGroup>('POST', '/api/sidebar/groups', index === undefined ? { name } : { name, index }),
  updateSidebarGroup: (id: string, patch: { name?: string; collapsed?: boolean }) => call<SidebarLayout>('PATCH', `/api/sidebar/groups/${enc(id)}`, patch),
  deleteSidebarGroup: (id: string) => call<SidebarLayout>('DELETE', `/api/sidebar/groups/${enc(id)}`),
  moveSidebarGroup: (id: string, index: number) => call<SidebarLayout>('POST', `/api/sidebar/groups/${enc(id)}/move`, { index }),
  /** groupId null: ungrouped; index missing: last there. */
  moveSidebarBot: (id: string, groupId: string | null, index?: number) => call<SidebarLayout>('POST', `/api/sidebar/bots/${enc(id)}/move`, index === undefined ? { groupId } : { groupId, index }),
  pinSidebarBot: (id: string, pinned: boolean, index?: number) => call<SidebarLayout>('POST', `/api/sidebar/bots/${enc(id)}/pin`, index === undefined ? { pinned } : { pinned, index }),
  setSidebarSection: (key: SidebarSectionKey, collapsed: boolean) => call<SidebarLayout>('PATCH', `/api/sidebar/sections/${key}`, { collapsed }),
  createBot: (input: NewBotInput) => call<Bot>('POST', '/api/bots', input),
  duplicateBot: (id: string, input: DuplicateBotInput) => call<Bot>('POST', `/api/bots/${enc(id)}/duplicate`, input),
  exportConfig: () => call<PortableExport>('GET', '/api/config/export'),
  previewConfigImport: (input: PortableImportInput) => call<PortableImportPreview>('POST', '/api/config/import/preview', input),
  importConfig: (input: PortableImportInput) => call<PortableImportResult>('POST', '/api/config/import', input),
  templates: () => call<BotTemplate[]>('GET', '/api/templates'),
  saveTemplate: (input: SaveTemplateInput) => call<BotTemplate>('POST', '/api/templates', input),
  deleteTemplate: (id: string) => call<{ ok: true }>('DELETE', `/api/templates/${enc(id)}`),
  reviewTemplate: (id: string, input: TemplateReviewInput) => call<TemplateReview>('POST', `/api/templates/${enc(id)}/review`, input),
  setupCheck: (botId: string) => call<SetupCheck>('POST', `/api/bots/${enc(botId)}/setup-check`, {}),
  starterInstall: (botId: string) => call<StarterInstall | null>('GET', `/api/bots/${enc(botId)}/starter`),
  activateRoutine: (id: string, input: StarterActivationInput) => call<Routine>('POST', `/api/routines/${enc(id)}/activate`, input),
  updateBot: (id: string, patch: UpdateBotRequest) => call<Bot>('PATCH', `/api/bots/${enc(id)}`, patch),
  switchPreview: (id: string, input: ProviderSwitchInput & { connections?: string[] }) => call<ProviderSwitchPreview>('POST', `/api/bots/${enc(id)}/switch-preview`, input),
  deleteBot: (id: string) => call<{ ok: true }>('DELETE', `/api/bots/${enc(id)}`),
  resetBot: (id: string) => call<{ ok: true }>('POST', `/api/bots/${enc(id)}/reset`),
  stopBot: (id: string, clearQueue = false) => call<StopResult>('POST', `/api/bots/${enc(id)}/stop`, clearQueue ? { clearQueue } : {}),
  cancelRuns: (id: string) => call<CancelRunsResult>('POST', `/api/bots/${enc(id)}/cancel-runs`),
  pauseBot: (id: string, paused: boolean) => call<Bot>('POST', `/api/bots/${enc(id)}/${paused ? 'pause' : 'resume'}`),
  markRead: (id: string, upTo: string) => call<Bot>('POST', `/api/bots/${enc(id)}/read`, { upTo }),

  /** Oldest first: the newest `limit`, or the `limit` before or after a message. */
  messages: (id: string, from: { before?: string; after?: string } = {}, limit = 100) =>
    call<Message[]>('GET', `/api/bots/${enc(id)}/messages?limit=${limit}${from.before ? `&before=${enc(from.before)}` : ''}${from.after ? `&after=${enc(from.after)}` : ''}`),
  send: (id: string, text: string, attachments: FileRef[] = []) =>
    call<Message>('POST', `/api/bots/${enc(id)}/messages`, attachments.length ? { text, attachments: attachments.map((a) => ({ path: a.path })) } : { text }),
  /** Devices only: pinned, every new session of the Boton is given it (see PIN_LIMIT on the server). */
  pinMessage: (botId: string, id: string, pinned: boolean) => call<Message>('POST', `/api/bots/${enc(botId)}/messages/${enc(id)}/pin`, { pinned }),
  /** Devices only: the owner's reaction on one of the Boton's messages; the message comes back as it is now. */
  react: (botId: string, id: string, emoji: string) => call<Message>('POST', `/api/bots/${enc(botId)}/messages/${enc(id)}/reactions`, { emoji }),
  unreact: (botId: string, id: string, emoji: string) => call<Message>('DELETE', `/api/bots/${enc(botId)}/messages/${enc(id)}/reactions/${enc(emoji)}`),
  messageSteps: (id: string) => call<TurnSteps>('GET', `/api/messages/${enc(id)}/steps`),
  background: (botId: string) => call<BackgroundActivity>('GET', `/api/bots/${enc(botId)}/background`),
  runSteps: (id: string) => call<TurnSteps[]>('GET', `/api/runs/${enc(id)}/steps`),

  files: (botId: string, path = '') => call<FileListing>('GET', `/api/bots/${enc(botId)}/files?path=${enc(path)}`),
  /** Devices only: to the server's trash, kept TRASH_KEEP_DAYS. */
  deleteFiles: (botId: string, paths: string[]) => call<TrashResult>('POST', `/api/bots/${enc(botId)}/files/delete`, { paths }),
  clearInbox: (botId: string) => call<TrashResult>('POST', `/api/bots/${enc(botId)}/inbox/clear`),
  pinInbox: (botId: string, path: string, pinned: boolean) => call<{ path: string; pinned: boolean }>('POST', `/api/bots/${enc(botId)}/inbox/pins`, { path, pinned }),
  trash: (botId: string) => call<TrashItem[]>('GET', `/api/bots/${enc(botId)}/trash`),
  emptyTrash: (botId: string) => call<{ purged: number }>('POST', `/api/bots/${enc(botId)}/trash/empty`),
  restoreTrash: (id: string) => call<RestoreResult>('POST', `/api/trash/${enc(id)}/restore`),
  purgeTrash: (id: string) => call<void>('DELETE', `/api/trash/${enc(id)}`),
  botStorage: (botId: string) => call<BotStorage & { sharedBytes: number; sharedTrashItems: number; sharedTrashBytes: number; partial: boolean }>('GET', `/api/bots/${enc(botId)}/storage`),
  /** Devices only: the shared folder, listed, deleted to the trash, and its trash. */
  sharedFiles: (path = '') => call<FileListing>('GET', `/api/shared/files?path=${enc(path)}`),
  deleteShared: (paths: string[]) => call<TrashResult>('POST', '/api/shared/files/delete', { paths }),
  sharedTrash: () => call<TrashItem[]>('GET', '/api/shared/trash'),
  emptySharedTrash: () => call<{ purged: number }>('POST', '/api/shared/trash/empty'),
  storage: () => call<StorageUsage>('GET', '/api/storage'),
  filePreview: (botId: string, path: string) => call<FilePreviewLink>('POST', `/api/bots/${enc(botId)}/files/preview`, { path }),
  async fileText(botId: string, path: string): Promise<string> {
    const res = await reach(`/api/bots/${enc(botId)}/files/raw?path=${enc(path)}`, { headers: authHeaders() });
    if (res.status === 401) onUnauthorized?.();
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
    }
    return res.text();
  },
  /** XMLHttpRequest rather than fetch, for upload progress. */
  upload(botId: string, file: Blob, name: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileRef> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/bots/${enc(botId)}/uploads?name=${enc(name)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data: any = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {}
        if (xhr.status === 401) onUnauthorized?.();
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as FileRef);
        else reject(new ApiError(xhr.status, data?.error ?? `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new OfflineError('Upload failed: the server could not be reached'));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  },

  routines: (botId: string) => call<Routine[]>('GET', `/api/bots/${enc(botId)}/routines`),
  createRoutine: (botId: string, input: CreateRoutineInput) => call<Routine>('POST', `/api/bots/${enc(botId)}/routines`, input),
  updateRoutine: (id: string, patch: UpdateRoutineInput) => call<Routine>('PATCH', `/api/routines/${enc(id)}`, patch),
  deleteRoutine: (id: string) => call<{ ok: true }>('DELETE', `/api/routines/${enc(id)}`),
  runRoutine: (id: string, input: RunRoutineInput = {}) => call<RoutineRun>('POST', `/api/routines/${enc(id)}/run`, input),
  runs: (id: string) => call<RoutineRun[]>('GET', `/api/routines/${enc(id)}/runs`),
  runsAttention: () => call<RunsAttention>('GET', '/api/runs/attention'),
  operations: () => call<OperationsStatus>('GET', '/api/operations'),
  logs: (f: { level: RecentLogLevel; q: string; boton: string; before?: number }) => {
    const p = new URLSearchParams({ level: f.level, limit: '100' });
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.boton) p.set('boton', f.boton);
    if (f.before) p.set('before', String(f.before));
    return call<RecentLogs>('GET', `/api/logs?${p}`);
  },
  retryRun: (runId: string) => call<RoutineRun>('POST', `/api/runs/${enc(runId)}/retry`),
  cancelRun: (runId: string) => call<RoutineRun>('POST', `/api/runs/${enc(runId)}/cancel`),
  resendCallback: (runId: string) => call<RoutineRun>('POST', `/api/runs/${enc(runId)}/callback`),
  runPayload: (runId: string) => call<RunPayload>('GET', `/api/runs/${enc(runId)}/payload`),
  previewSchedule: (schedule: string, timezone: string) => call<SchedulePreview>('POST', '/api/schedule/preview', { schedule, timezone }),

  connectors: () => call<ConnectorCatalog>('GET', '/api/connectors'),
  connectorNotices: (botId: string) => call<ConnectorNotice[]>('GET', `/api/bots/${enc(botId)}/connector-notices`),
  dismissConnectorNotice: (botId: string, connectorId: string) => call<{ ok: true }>('DELETE', `/api/bots/${enc(botId)}/connector-notices/${enc(connectorId)}`),
  mcpServers: () => call<McpServer[]>('GET', '/api/mcp-servers'),
  createMcpServer: (input: McpServerInput) => call<McpServer>('POST', '/api/mcp-servers', input),
  updateMcpServer: (name: string, patch: McpServerInput) => call<McpServer>('PATCH', `/api/mcp-servers/${enc(name)}`, patch),
  deleteMcpServer: (name: string) => call<{ ok: true }>('DELETE', `/api/mcp-servers/${enc(name)}`),
  setConnectorPolicy: (id: string, input: ConnectorPolicyInput) => call<Connector>('PATCH', `/api/connectors/${enc(id)}/policy`, input),
  connectorAccess: (id: string) => call<ConnectorAccess>('GET', `/api/connectors/${enc(id)}/access`),
  setConnectorAccess: (id: string, input: ConnectorAccessInput) => call<ConnectorAccess>('PUT', `/api/connectors/${enc(id)}/access`, input),
  setConnectorEnabled: (id: string, input: ConnectorEnabledInput) => call<ConnectorAccess>('PUT', `/api/connectors/${enc(id)}/enabled`, input),
  testConnector: (id: string) => call<ConnectorTest>('POST', `/api/connectors/${enc(id)}/test`),
  oauthConnections: () => call<{ connections: OAuthConnection[]; redirectUri: string | null }>('GET', '/api/oauth-connections'),
  createOAuthConnection: (input: OAuthConnectionInput) => call<OAuthConnection>('POST', '/api/oauth-connections', input),
  updateOAuthConnection: (id: string, patch: OAuthConnectionInput) => call<OAuthConnection>('PATCH', `/api/oauth-connections/${enc(id)}`, patch),
  deleteOAuthConnection: (id: string) => call<{ ok: true }>('DELETE', `/api/oauth-connections/${enc(id)}`),
  connectOAuth: (id: string, returnTo: string) => call<OAuthConnectStart>('POST', `/api/oauth-connections/${enc(id)}/connect`, { returnTo }),
  checkOAuth: (id: string) => call<OAuthConnection>('POST', `/api/oauth-connections/${enc(id)}/check`),

  skills: () => call<Skill[]>('GET', '/api/skills'),
  createSkill: (input: CreateSkillInput) => call<Skill>('POST', '/api/skills', input),
  updateSkill: (name: string, patch: UpdateSkillInput) => call<Skill>('PATCH', `/api/skills/${enc(name)}`, patch),
  deleteSkill: (name: string) => call<{ ok: true }>('DELETE', `/api/skills/${enc(name)}`),
  approveSkill: (name: string, version: string) => call<Skill>('POST', `/api/skills/${enc(name)}/approve`, { version }),
  skillDetails: (name: string) => call<SkillDetails>('GET', `/api/skills/${enc(name)}/details`),
  setSkillAccess: (name: string, input: SkillAccessInput) => call<SkillAccess>('PUT', `/api/skills/${enc(name)}/access`, input),
  setSkillEnabled: (name: string, enabled: boolean) => call<Skill>('PUT', `/api/skills/${enc(name)}/enabled`, { enabled }),
  restoreSkill: (name: string, id: number, current: string) => call<Skill>('POST', `/api/skills/${enc(name)}/restore`, { id, current }),
  skillPackages: () => call<SkillPackagesList>('GET', '/api/skill-packages'),
  reviewSkillPackage: (folder: string) => call<SkillPackageReview>('GET', `/api/skill-packages/${enc(folder)}`),
  installSkillPackage: (folder: string, input: InstallSkillInput) => call<Skill>('POST', `/api/skill-packages/${enc(folder)}/install`, input),

  approvals: (status: 'pending' | 'all' = 'pending') => call<Approval[]>('GET', `/api/approvals?status=${status}`),
  botApprovals: (botId: string) => call<Approval[]>('GET', `/api/bots/${enc(botId)}/approvals?status=all`),
  approval: (id: string) => call<Approval>('GET', `/api/approvals/${enc(id)}`),
  decideApproval: (id: string, input: ApprovalDecisionInput) => call<Approval>('POST', `/api/approvals/${enc(id)}/decide`, input),

  answerCard: (botId: string, id: string, input: CardAnswerInput) => call<Message>('POST', `/api/bots/${enc(botId)}/cards/${enc(id)}/answer`, input),
  card: (id: string) => call<Message>('GET', `/api/cards/${enc(id)}`),

  memories: (botId: string) => call<Memory[]>('GET', `/api/bots/${enc(botId)}/memories`),
  addMemory: (botId: string, text: string) => call<Memory>('POST', `/api/bots/${enc(botId)}/memories`, { text }),
  deleteMemory: (id: string) => call<{ ok: true }>('DELETE', `/api/memories/${enc(id)}`),
};
