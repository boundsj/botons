import { useSyncExternalStore } from 'react';
import type {
  ApiKeyState,
  ApiKeysView,
  Approval,
  ApprovalDecisionInput,
  AuthStatus,
  Bot,
  ConnectorCatalog,
  DuplicateBotInput,
  FileRef,
  McpServer,
  McpServerInput,
  OAuthConnection,
  OAuthConnectionInput,
  ConnectorPolicyInput,
  Memory,
  Message,
  NewBotInput,
  ProviderInfo,
  Routine,
  RoutineRun,
  ServerEvent,
  ServerInfo,
  Settings,
  SidebarLayout,
  SidebarSectionKey,
  SetupStatus,
  UpdateSetupInput,
  Skill,
  UpdateBotRequest,
  UpdateSettingsInput,
} from '../../shared/types.ts';
import type { CardAnswerInput } from '../../shared/cards.ts';
import { ApiError, api, whenUnauthorized } from './api.ts';
import { mergeProviders } from './brains.ts';
import { errorText } from './feedback.ts';
import { appendNewer, arrivedAfter, keepUnchanged, mergeLatest, prependOlder, upsert } from './lists.ts';

/**
 * A window onto a chat's history, oldest first, never more than `history.window` messages (`history.kept` for a
 * chat not on screen): reading further back lets the newest pages go (`hasNewer`), and reading forward again lets
 * the oldest go. Live messages are added only while the window reaches the newest one.
 */
interface MessageList {
  items: Message[];
  /** Older messages than the first exist on the server. */
  hasMore: boolean;
  /** Newer messages than the last exist on the server: the window doesn't reach the newest. */
  hasNewer: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  loadingLater: boolean;
  error: { message: string; retry: 'latest' | 'earlier' | 'later' } | null;
}

interface State {
  ready: boolean;
  loadError: string | null;
  /** Set while this device is not paired. */
  pairing: AuthStatus | null;
  /** The event stream is open and what's on screen has caught up with it. */
  connected: boolean;
  /** The server runs a different build than this page loaded with. */
  updated: boolean;
  info: ServerInfo | null;
  settings: Settings | null;
  /** First-run setup and the access mode. */
  setup: SetupStatus | null;
  providers: ProviderInfo[];
  bots: Bot[];
  /**
   * How the owner arranges the sidebar, the same on every device (null until it loads). Kept apart from the
   * Botons and their chats: a change here re-renders the sidebar and the settings form, never a chat.
   */
  sidebar: SidebarLayout | null;
  messages: Record<string, MessageList>;
  routines: Record<string, Routine[]>;
  runs: Record<string, RoutineRun[]>;
  memories: Record<string, Memory[]>;
  connectors: ConnectorCatalog | null;
  mcpServers: McpServer[] | null;
  /** OAuth connectors, and the redirect URI sign-ins use (null: BOTONS_OAUTH_PUBLIC_URL is not set). */
  oauth: { connections: OAuthConnection[]; redirectUri: string | null } | null;
  skills: Skill[] | null;
  /** The owner's API keys (never a key itself): loaded when Settings shows them. */
  apiKeys: ApiKeysView | null;
  /** By id: every pending one, and every one of each chat opened. */
  approvals: Record<string, Approval>;
}

let state: State = {
  ready: false,
  loadError: null,
  pairing: null,
  connected: false,
  updated: false,
  info: null,
  settings: null,
  setup: null,
  providers: [],
  bots: [],
  sidebar: null,
  messages: {},
  routines: {},
  runs: {},
  memories: {},
  connectors: null,
  mcpServers: null,
  oauth: null,
  skills: null,
  apiKeys: null,
  approvals: {},
};

const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

export const getState = () => state;

const PAGE = 100;

/** How much of a chat's history the page holds. Tests and the perf harness read these. */
export const history = {
  page: PAGE,
  /** Messages a chat on screen holds at most, while reading back and forth. */
  window: 3 * PAGE,
  /** Messages kept for a chat not on screen, so reopening it shows its latest at once. */
  kept: PAGE,
  /** Chats not on screen whose messages are kept; the least recently left beyond this are dropped. */
  chats: 10,
};

/** Chats on screen, counted: a remount (StrictMode) opens one before the first copy has left. */
const onScreen = new Map<string, number>();
/** Chats not on screen with messages kept, least recently left first. */
const leftChats: string[] = [];

/** The newest `max` of a list, which then has older messages on the server. */
function keepNewest(list: MessageList, max: number): MessageList {
  return list.items.length > max ? { ...list, items: list.items.slice(-max), hasMore: true } : list;
}
/** Tests shorten these. */
export const live = {
  /** Reconnect when nothing, not even a ping, has arrived for this long. */
  staleMs: 60_000,
  watchdogMs: 15_000,
  /** Doubles after each failed catch-up, up to maxRetryMs. */
  retryMs: 1_000,
  maxRetryMs: 30_000,
  /** Refetch providers this often while the page is in view: no event says a CLI was signed out. */
  providersMs: 60_000,
};

const lastActivity = (b: Bot) => b.lastMessage?.createdAt ?? b.createdAt;
const sortBots = (bots: Bot[]) => [...bots].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));

/** Turns whose message has arrived: a Boton list fetched just before can still carry their drafts. */
const endedTurns: string[] = [];

function endTurn(turnId: string) {
  if (endedTurns.includes(turnId)) return;
  endedTurns.push(turnId);
  if (endedTurns.length > 200) endedTurns.shift();
}

function freshDraft(b: Bot): Bot {
  const d = b.status.draft;
  return d && endedTurns.includes(d.turnId) ? { ...b, status: { ...b.status, draft: null } } : b;
}

const fetchedBots = (bots: Bot[]) => sortBots(bots.map(freshDraft));

function endTurnsOf(botId: string, messages: Message[]) {
  const turns = messages.flatMap((m) => m.meta?.turnId || []);
  for (const t of turns) endTurn(t);
  if (turns.length) set((s) => ({ bots: s.bots.map((b) => (b.id === botId ? freshDraft(b) : b)) }));
}

function apply(ev: ServerEvent) {
  switch (ev.type) {
    case 'hello':
      if (state.info && ev.build !== undefined && ev.build !== state.info.build) set({ updated: true });
      break;
    case 'bot.upserted':
      set((s) => ({ bots: sortBots(upsert(s.bots, freshDraft(ev.bot))) }));
      break;
    case 'bot.deleted':
      set((s) => ({
        bots: s.bots.filter((b) => b.id !== ev.botId),
        approvals: Object.fromEntries(Object.entries(s.approvals).filter(([, a]) => a.botId !== ev.botId)),
      }));
      break;
    case 'bot.status':
      set((s) => ({ bots: s.bots.map((b) => (b.id === ev.botId ? freshDraft({ ...b, status: ev.status }) : b)) }));
      break;
    case 'message.draft':
      if (endedTurns.includes(ev.draft.turnId)) break;
      set((s) => ({
        bots: s.bots.map((b) => (b.id === ev.botId && b.status.state === 'working' ? { ...b, status: { ...b.status, draft: ev.draft } } : b)),
      }));
      break;
    case 'message.created': {
      const m = ev.message;
      const turnId = m.meta?.turnId;
      if (turnId) endTurn(turnId);
      set((s) => {
        const bots = turnId
          ? s.bots.map((b) => (b.id === m.botId && b.status.draft?.turnId === turnId ? { ...b, status: { ...b.status, draft: null } } : b))
          : s.bots;
        const list = s.messages[m.botId];
        // A window that doesn't reach the newest message reads this one when it gets there.
        if (!list || list.hasNewer) return { bots };
        if (list.items.some((x) => x.id === m.id)) return { bots };
        const added = { ...list, items: [...list.items, m] };
        return { bots, messages: { ...s.messages, [m.botId]: onScreen.has(m.botId) ? added : keepNewest(added, history.kept) } };
      });
      break;
    }
    case 'message.updated':
      for (const w of watching.get(ev.message.id) ?? []) w.overtaken = true;
      updateMessage(ev.message);
      break;
    case 'routine.upserted':
      set((s) => {
        const list = s.routines[ev.routine.botId];
        return list ? { routines: { ...s.routines, [ev.routine.botId]: upsert(list, ev.routine) } } : {};
      });
      break;
    case 'routine.deleted':
      set((s) => {
        const list = s.routines[ev.botId];
        return list ? { routines: { ...s.routines, [ev.botId]: list.filter((r) => r.id !== ev.routineId) } } : {};
      });
      break;
    case 'run.upserted':
      set((s) => {
        const list = s.runs[ev.run.routineId];
        // Room for what the server keeps: active runs, 20 finished and 10 skipped.
        return list ? { runs: { ...s.runs, [ev.run.routineId]: upsert(list, ev.run, 'start').slice(0, 40) } } : {};
      });
      break;
    case 'memory.upserted':
      set((s) => {
        const list = s.memories[ev.memory.botId];
        return list ? { memories: { ...s.memories, [ev.memory.botId]: upsert(list, ev.memory) } } : {};
      });
      break;
    case 'memory.deleted':
      set((s) => {
        const list = s.memories[ev.botId];
        return list ? { memories: { ...s.memories, [ev.botId]: list.filter((m) => m.id !== ev.memoryId) } } : {};
      });
      break;
    case 'settings.updated':
      set({ settings: ev.settings });
      break;
    case 'skill.upserted':
      set((s) => (s.skills ? { skills: sortSkills([...s.skills.filter((x) => x.name !== ev.skill.name), ev.skill]) } : {}));
      break;
    case 'skill.deleted':
      set((s) => (s.skills ? { skills: s.skills.filter((x) => x.name !== ev.name) } : {}));
      break;
    case 'approval.upserted':
      set((s) => {
        if (keepsApproval(ev.approval)) return { approvals: { ...s.approvals, [ev.approval.id]: ev.approval } };
        if (!s.approvals[ev.approval.id]) return {};
        const { [ev.approval.id]: _gone, ...approvals } = s.approvals;
        return { approvals };
      });
      break;
    case 'oauth.upserted':
      set((s) => (s.oauth ? { oauth: { ...s.oauth, connections: [...s.oauth.connections.filter((c) => c.id !== ev.connection.id), ev.connection].sort((a, b) => a.name.localeCompare(b.name)) } } : {}));
      break;
    case 'sidebar.updated':
      sidebarEvents++;
      set({ sidebar: ev.layout });
      break;
    case 'api_keys.updated':
      set({ apiKeys: ev.view });
      break;
    case 'oauth.deleted':
      set((s) => (s.oauth ? { oauth: { ...s.oauth, connections: s.oauth.connections.filter((c) => c.id !== ev.id) } } : {}));
      break;
  }
}

/**
 * Layouts arrive in the order the server made them over the event stream, but an answer can land after a newer
 * event (another device's change). Once an event has come in since a change was sent, that change's own event comes
 * too, in order, so the answer is left alone.
 */
let sidebarEvents = 0;
async function changeSidebar<T>(run: () => Promise<T>, layoutOf: (r: T) => SidebarLayout): Promise<T> {
  const seen = sidebarEvents;
  const r = await run();
  if (sidebarEvents === seen) set({ sidebar: layoutOf(r) });
  return r;
}
const whole = (l: SidebarLayout) => l;

const byId = (list: Approval[]) => Object.fromEntries(list.map((a) => [a.id, a]));

/**
 * The page holds the approvals waiting for an answer, and the decided ones of chats it holds messages for (their
 * cards show them); a chat let go takes its decided ones with it, and opening it again loads them again.
 */
const keepsApproval = (a: Approval) => a.status === 'pending' || onScreen.has(a.botId) || !!state.messages[a.botId];
const keptApprovals = (map: Record<string, Approval>) => Object.fromEntries(Object.entries(map).filter(([, a]) => keepsApproval(a)));

/** Oldest first. */
export function pendingApprovals(map: Record<string, Approval>): Approval[] {
  return Object.values(map)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Reactions being changed from here, by message: a message.updated that reaches the store while one is in flight
 * overtakes its answer. The server publishes every change after making it, in order, so the stream brings this change
 * (or a later one) too; the answer of a request that was overtaken is older than what is on screen and is not applied.
 */
const watching = new Map<string, Set<{ overtaken: boolean }>>();

async function changeReaction(m: Message, request: () => Promise<Message>) {
  const w = { overtaken: false };
  const inFlight = watching.get(m.id) ?? new Set();
  watching.set(m.id, inFlight.add(w));
  try {
    const now = await request();
    if (!w.overtaken) updateMessage(now);
  } finally {
    inFlight.delete(w);
    if (!inFlight.size) watching.delete(m.id);
  }
}

/** Preserve live updates to held rows when a history response was read before those events. */
async function messagePage(botId: string, request: () => Promise<Message[]>): Promise<Message[]> {
  const guards = (state.messages[botId]?.items ?? []).map((m) => {
    const w = { overtaken: false };
    const inFlight = watching.get(m.id) ?? new Set();
    watching.set(m.id, inFlight.add(w));
    return { id: m.id, w, inFlight };
  });
  try {
    const page = await request();
    const newer = new Map((state.messages[botId]?.items ?? []).map((m) => [m.id, m]));
    const overtaken = new Set(guards.filter((g) => g.w.overtaken).map((g) => g.id));
    return page.map((m) => overtaken.has(m.id) ? newer.get(m.id) ?? m : m);
  } finally {
    for (const { id, w, inFlight } of guards) {
      inFlight.delete(w);
      if (!inFlight.size) watching.delete(id);
    }
  }
}

/** A message whose meta changed, where it is on screen or kept: a window without it reads it when it gets there. */
function updateMessage(m: Message) {
  set((s) => {
    const list = s.messages[m.botId];
    if (!list?.items.some((x) => x.id === m.id)) return {};
    return { messages: { ...s.messages, [m.botId]: { ...list, items: list.items.map((x) => (x.id === m.id ? m : x)) } } };
  });
}

const sortSkills = (list: Skill[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

function patchList(botId: string, fn: (l: MessageList) => Partial<MessageList>) {
  set((s) => {
    const cur: MessageList = s.messages[botId] ?? { items: [], hasMore: false, hasNewer: false, loading: false, loadingEarlier: false, loadingLater: false, error: null };
    const next = { ...cur, ...fn(cur) };
    return { messages: { ...s.messages, [botId]: onScreen.has(botId) ? next : keepNewest(next, history.kept) } };
  });
}

const latestInFlight = new Map<string, Promise<void>>();
/**
 * Bumped when a chat's window is let go (dropped, or replaced by Jump to latest): a page or newest page
 * still loading for it is for a window that is gone, and changes nothing when it lands.
 */
const generations = new Map<string, number>();
const generation = (botId: string) => generations.get(botId) ?? 0;

function discard(botId: string) {
  generations.set(botId, generation(botId) + 1);
  latestInFlight.delete(botId);
}

/**
 * A fetch in flight is shared, unless `fresh`: catching up after a reconnect can't use a page
 * that may have been read before the stream dropped, so it waits for that one and makes its own.
 */
function syncLatest(botId: string, fresh = false): Promise<void> {
  const running = latestInFlight.get(botId);
  if (running && !fresh) return running;
  if (running) {
    const queuedGeneration = generation(botId);
    const again = () => generation(botId) === queuedGeneration ? syncLatest(botId) : Promise.resolve();
    return running.then(again, again);
  }
  let p: Promise<void> | null = null;
  p = (async () => {
    const gen = generation(botId);
    // What a page read from here on can be compared with: anything added after this arrived live.
    const known = new Set(state.messages[botId]?.items.map((m) => m.id));
    patchList(botId, () => ({ loading: true }));
    try {
      const latest = await messagePage(botId, () => api.messages(botId, {}, PAGE));
      endTurnsOf(botId, latest);
      if (gen !== generation(botId)) return;
      patchList(botId, (cur) => {
        // Reading back through history: the newest page isn't on screen, and the window stays where it is.
        if (cur.hasNewer) return { loading: false };
        const error = cur.error?.retry === 'latest' ? null : cur.error;
        const merged = mergeLatest(cur.items, latest);
        const next = merged
          ? { items: keepUnchanged(cur.items, merged.items), hasMore: merged.keptOlder ? cur.hasMore : latest.length === PAGE }
          : { items: keepUnchanged(cur.items, [...latest, ...arrivedAfter(cur.items, latest, known)]), hasMore: latest.length === PAGE };
        return { ...next, loading: false, error };
      });
    } catch (e) {
      if (gen !== generation(botId)) return;
      patchList(botId, () => ({ loading: false, error: { message: errorText(e), retry: 'latest' } }));
      throw e;
    } finally {
      if (latestInFlight.get(botId) === p) latestInFlight.delete(botId);
    }
  })();
  latestInFlight.set(botId, p);
  return p;
}

const sentReads = new Map<string, string>();
const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

const READ_DEBOUNCE_MS = 300;

type Keyed = 'routines' | 'runs' | 'memories';

function put<K extends Keyed>(key: K, id: string, list: State[K][string]) {
  set((s) => ({ [key]: { ...s[key], [id]: list } }));
}

/** Refetch one loaded list in place; drop it if it is gone (404). */
async function reload<K extends Keyed>(key: K, id: string, fetch: (id: string) => Promise<State[K][string]>) {
  try {
    put(key, id, await fetch(id));
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    set((s) => {
      const { [id]: _gone, ...rest } = s[key];
      return { [key]: rest };
    });
  }
}

const only = <T>(map: Record<string, T>, ids: Set<string>) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));

/** After a reconnect: events sent meanwhile are lost, so refetch everything on screen. */
async function refresh() {
  const sidebarAt = sidebarEvents;
  providersAt = Date.now();
  const [bots, settings, providers, waiting, sidebar] = await Promise.all([api.bots(), api.settings(), fetchProviders(), api.approvals(), api.sidebar()]);
  const ids = new Set(bots.map((b) => b.id));
  const chats = Object.keys(state.messages).filter((id) => ids.has(id));
  const perChat = await Promise.all(chats.map((id) => api.botApprovals(id).catch(() => [] as Approval[])));
  for (const id of Object.keys(state.messages)) if (!ids.has(id)) discard(id);
  set((s) => ({
    bots: fetchedBots(bots),
    sidebar: sidebarEvents === sidebarAt ? sidebar : s.sidebar,
    settings,
    providers: providers(s.providers),
    messages: only(s.messages, ids),
    routines: only(s.routines, ids),
    memories: only(s.memories, ids),
    approvals: keptApprovals({ ...byId(perChat.flat()), ...byId(waiting) }),
  }));
  const s = state;
  await Promise.all([
    ...(s.skills ? [actions.loadSkills()] : []),
    ...Object.keys(s.messages).map((id) => syncLatest(id, true)),
    ...Object.keys(s.routines).map((id) => reload('routines', id, api.routines)),
    ...Object.keys(s.runs).map((id) => reload('runs', id, api.runs)),
    ...Object.keys(s.memories).map((id) => reload('memories', id, api.memories)),
  ]);
}

// EventSource.readyState
const OPEN = 1;
const CLOSED = 2;

let source: EventSource | null = null;
let lastEventAt = 0;
/** Events may have been missed since what's on screen was fetched. */
let behind = false;
let catchingUp = false;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let providersAt = 0;
/** Counts the requests for the brains, so of two answers from the same check the later request's is kept. */
let providersAsked = 0;
let providersApplied = 0;

/** The brains, then how to apply them to what is shown: never putting back an older check (mergeProviders). */
async function fetchProviders(recheck = false): Promise<(shown: ProviderInfo[]) => ProviderInfo[]> {
  const asked = ++providersAsked;
  const next = await api.providers(recheck);
  return (shown) => {
    const newer = asked > providersApplied;
    providersApplied = Math.max(providersApplied, asked);
    return mergeProviders(shown, next, newer);
  };
}

function connect() {
  source?.close();
  const es = api.events();
  source = es;
  lastEventAt = Date.now();
  es.onmessage = (e) => {
    if (es !== source) return;
    lastEventAt = Date.now();
    let ev: ServerEvent;
    try {
      ev = JSON.parse(e.data) as ServerEvent;
    } catch {
      return;
    }
    if (ev.type === 'hello') {
      if (behind) void catchUp();
      else set({ connected: true });
    }
    apply(ev);
    // A failed turn can mean its CLI was signed out.
    if (ev.type === 'message.created' && ev.message.role === 'error') actions.loadProviders().catch(() => {});
  };
  // The browser reconnects by itself after a network error; once it gives up (CLOSED, say on a 401
  // for a revoked device), checkAuth may show the pairing screen, else the watchdog starts over.
  es.onerror = () => {
    if (es !== source) return;
    behind = true;
    set({ connected: false });
    if (es.readyState === CLOSED) actions.checkAuth().catch(() => {});
  };
}

/** `connected` stays false (banner up) until catching up worked. */
async function catchUp() {
  clearTimeout(retryTimer);
  if (catchingUp) return;
  catchingUp = true;
  try {
    while (behind && source?.readyState === OPEN) {
      behind = false;
      await refresh();
      failures = 0;
    }
    if (!behind && source?.readyState === OPEN) set({ connected: true });
  } catch (err) {
    behind = true;
    const wait = Math.min(live.retryMs * 2 ** failures++, live.maxRetryMs);
    console.warn(`[Botons] catching up after a reconnect failed; retrying in ${wait} ms`, err);
    retryTimer = setTimeout(() => void catchUp(), wait);
  } finally {
    catchingUp = false;
  }
}

function reconnect() {
  behind = true;
  set({ connected: false });
  connect();
}

/** A sleeping phone or a network change can leave the stream dead without an error. */
function checkConnection() {
  if (!source) return;
  if (source.readyState === CLOSED || Date.now() - lastEventAt > live.staleMs) reconnect();
  else if (Date.now() - providersAt >= live.providersMs && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
    actions.loadProviders().catch(() => {});
  }
}

const onVisible = () => {
  if (document.visibilityState === 'visible') checkConnection();
};
const onOnline = () => {
  if (source) reconnect();
};

function startLive() {
  connect();
  clearInterval(watchdog);
  watchdog = setInterval(checkConnection, live.watchdogMs);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
}

export function disconnect() {
  source?.close();
  source = null;
  clearInterval(watchdog);
  clearTimeout(retryTimer);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  set({ connected: false });
}

function upsertBot(bot: Bot): Bot {
  apply({ type: 'bot.upserted', bot });
  return bot;
}

export const actions = {
  /** The owner's reaction on a Boton's message: nothing shows until the server has it (it may refuse, saying why). */
  react(m: Message, emoji: string) {
    return changeReaction(m, () => api.react(m.botId, m.id, emoji));
  },
  unreact(m: Message, emoji: string) {
    return changeReaction(m, () => api.unreact(m.botId, m.id, emoji));
  },
  async pinMessage(m: Message, pinned: boolean) {
    await changeReaction(m, () => api.pinMessage(m.botId, m.id, pinned));
  },
  async init() {
    try {
      if (!(await actions.checkAuth())) return;
      providersAt = Date.now();
      const [info, settings, providers, bots, waiting, setup, sidebar] = await Promise.all([api.info(), api.settings(), api.providers(), api.bots(), api.approvals(), api.setup(), api.sidebar()]);
      set({ info, settings, setup, providers, bots: fetchedBots(bots), sidebar, approvals: byId(waiting), ready: true, loadError: null });
      behind = false;
      startLive();
    } catch (e) {
      set({ loadError: errorText(e) });
    }
  },

  /** False (and the pairing screen) if this device is not paired. */
  async checkAuth(): Promise<boolean> {
    const auth = await api.authStatus();
    if (auth.caller === 'device') {
      if (state.pairing) set({ pairing: null });
      return true;
    }
    disconnect();
    set({ pairing: auth, ready: false, connected: false, loadError: null });
    return false;
  },

  async loadSetup() {
    set({ setup: await api.setup() });
  },

  async updateSetup(input: UpdateSetupInput) {
    const setup = await api.updateSetup(input);
    set({ setup });
    return setup;
  },

  async loadProviders(recheck = false) {
    providersAt = Date.now();
    const apply = await fetchProviders(recheck);
    set((s) => ({ providers: apply(s.providers) }));
  },

  async signOut() {
    await api.logout();
    await actions.checkAuth();
  },

  async loadMessages(botId: string) {
    // A failure is recorded on the list, with Retry.
    await syncLatest(botId).catch(() => {});
  },

  /** True if a page was added. */
  async loadEarlier(botId: string): Promise<boolean> {
    const list = state.messages[botId];
    if (!list || list.loadingEarlier || !list.hasMore || !list.items.length) return false;
    const before = list.items[0].id;
    const gen = generation(botId);
    patchList(botId, () => ({ loadingEarlier: true }));
    try {
      const older = await messagePage(botId, () => api.messages(botId, { before }, PAGE));
      if (gen !== generation(botId)) return false;
      let added = false;
      patchList(botId, (cur) => {
        const items = prependOlder(cur.items, before, older);
        if (!items) return { loadingEarlier: false };
        added = items.length !== cur.items.length;
        // The newest pages go: the owner is reading at the top.
        const over = items.length > history.window;
        return {
          items: over ? items.slice(0, history.window) : items,
          hasMore: older.length === PAGE,
          hasNewer: cur.hasNewer || over,
          loadingEarlier: false,
          error: cur.error?.retry === 'earlier' ? null : cur.error,
        };
      });
      return added;
    } catch (e) {
      if (gen !== generation(botId)) return false;
      patchList(botId, () => ({ loadingEarlier: false, error: { message: errorText(e), retry: 'earlier' } }));
      return false;
    }
  },

  /** The page after the window's last message, for a window that doesn't reach the newest. True if a page was added. */
  async loadLater(botId: string): Promise<boolean> {
    const list = state.messages[botId];
    if (!list || list.loadingLater || !list.hasNewer || !list.items.length) return false;
    const after = list.items.at(-1)!.id;
    const gen = generation(botId);
    patchList(botId, () => ({ loadingLater: true }));
    let added = false;
    let caughtUp = false;
    try {
      const newer = await messagePage(botId, () => api.messages(botId, { after }, PAGE));
      endTurnsOf(botId, newer);
      if (gen !== generation(botId)) return false;
      patchList(botId, (cur) => {
        const items = appendNewer(cur.items, after, newer);
        if (!items) return { loadingLater: false };
        added = items.length !== cur.items.length;
        caughtUp = newer.length < PAGE;
        // The oldest pages go: the owner is reading at the bottom.
        const over = Math.max(0, items.length - history.window);
        return {
          items: over ? items.slice(over) : items,
          hasNewer: !caughtUp,
          hasMore: cur.hasMore || over > 0,
          loadingLater: false,
          error: cur.error?.retry === 'later' ? null : cur.error,
        };
      });
    } catch (e) {
      if (gen !== generation(botId)) return false;
      patchList(botId, () => ({ loadingLater: false }));
      // The message the window ends at is gone (the chat was cleared): start again from the newest.
      if (e instanceof ApiError && e.status === 404) {
        await actions.jumpToLatest(botId);
        return true;
      }
      patchList(botId, () => ({ error: { message: errorText(e), retry: 'later' } }));
      return false;
    }
    // Messages sent while the page loaded were not added live (the window didn't reach them yet).
    if (caughtUp) await syncLatest(botId, true).catch(() => {});
    return added;
  },

  /** Show the newest page, letting go of the window read back to. */
  async jumpToLatest(botId: string) {
    const list = state.messages[botId];
    if (list && !list.hasNewer) return;
    // A newest page already loading may have been read before messages that arrived since: read it again.
    discard(botId);
    patchList(botId, () => ({ items: [], hasMore: false, hasNewer: false, loading: true, loadingEarlier: false, loadingLater: false, error: null }));
    await actions.loadMessages(botId);
  },

  /**
   * A chat on screen at its newest message that live messages took past `history.window` lets go of the end
   * farther from what is being read: its oldest, or (read near the top) its newest, which is then read again
   * from there like a window read back.
   */
  keepWindow(botId: string, drop: 'oldest' | 'newest' = 'oldest') {
    const list = state.messages[botId];
    if (!list || list.hasNewer || list.items.length <= history.window) return;
    const next = drop === 'oldest' ? keepNewest(list, history.window) : { ...list, items: list.items.slice(0, history.window), hasNewer: true };
    set((s) => ({ messages: { ...s.messages, [botId]: next } }));
  },

  /** The chat is on screen until the matching `leaveChat`. */
  openChat(botId: string) {
    onScreen.set(botId, (onScreen.get(botId) ?? 0) + 1);
    const i = leftChats.indexOf(botId);
    if (i >= 0) leftChats.splice(i, 1);
  },

  /**
   * Off screen, a chat keeps only its newest `history.kept` messages, and nothing if it was read back from the
   * newest; beyond `history.chats` chats left, the least recently left is dropped and loads again when opened.
   */
  leaveChat(botId: string) {
    const n = (onScreen.get(botId) ?? 0) - 1;
    if (n > 0) {
      onScreen.set(botId, n);
      return;
    }
    onScreen.delete(botId);
    leftChats.push(botId);
    const drop = new Set(leftChats.splice(0, Math.max(0, leftChats.length - history.chats)));
    if (state.messages[botId]?.hasNewer) drop.add(botId);
    for (const id of drop) discard(id);
    set((s) => {
      const list = s.messages[botId];
      const messages = Object.fromEntries(Object.entries(s.messages).filter(([id]) => !drop.has(id)));
      if (list && !drop.has(botId)) messages[botId] = keepNewest({ ...list, loadingEarlier: false, error: list.error?.retry === 'latest' ? list.error : null }, history.kept);
      return { messages };
    });
    set((s) => {
      const approvals = keptApprovals(s.approvals);
      return Object.keys(approvals).length === Object.keys(s.approvals).length ? {} : { approvals };
    });
    const i = leftChats.indexOf(botId);
    if (drop.has(botId) && i >= 0) leftChats.splice(i, 1);
  },

  retryMessages(botId: string): Promise<unknown> {
    const failed = state.messages[botId]?.error;
    if (failed?.retry === 'earlier') return actions.loadEarlier(botId);
    if (failed?.retry === 'later') return actions.loadLater(botId);
    return actions.loadMessages(botId);
  },

  async send(botId: string, text: string, attachments: FileRef[] = []) {
    apply({ type: 'message.created', message: await api.send(botId, text, attachments) });
  },

  async createBot(input: NewBotInput) {
    return upsertBot(await api.createBot(input));
  },

  async duplicateBot(id: string, input: DuplicateBotInput) {
    return upsertBot(await api.duplicateBot(id, input));
  },

  async updateBot(id: string, patch: UpdateBotRequest) {
    return upsertBot(await api.updateBot(id, patch));
  },

  /** Each answers with the whole layout, which every device also gets as sidebar.updated. */
  sidebar: {
    async createGroup(name: string): Promise<string> {
      return (await changeSidebar(() => api.createSidebarGroup(name), (r) => r.layout)).groupId;
    },
    renameGroup: (id: string, name: string) => changeSidebar(() => api.updateSidebarGroup(id, { name }), whole),
    deleteGroup: (id: string) => changeSidebar(() => api.deleteSidebarGroup(id), whole),
    moveGroup: (id: string, index: number) => changeSidebar(() => api.moveSidebarGroup(id, index), whole),
    /** groupId null: ungrouped; index missing: last there. */
    moveBot: (id: string, groupId: string | null, index?: number) => changeSidebar(() => api.moveSidebarBot(id, groupId, index), whole),
    pin: (id: string, pinned: boolean, index?: number) => changeSidebar(() => api.pinSidebarBot(id, pinned, index), whole),
    collapse: (section: SidebarSectionKey | { groupId: string }, collapsed: boolean) =>
      changeSidebar(() => (typeof section === 'string' ? api.setSidebarSection(section, collapsed) : api.updateSidebarGroup(section.groupId, { collapsed })), whole),
  },

  async deleteBot(id: string) {
    await api.deleteBot(id);
    apply({ type: 'bot.deleted', botId: id });
  },

  async loadRoutines(botId: string) {
    put('routines', botId, await api.routines(botId));
  },

  async loadRuns(routineId: string) {
    put('runs', routineId, await api.runs(routineId));
  },

  async loadApprovals(botId: string) {
    const list = await api.botApprovals(botId);
    set((s) => ({ approvals: keptApprovals({ ...s.approvals, ...byId(list) }) }));
  },

  async loadApproval(id: string) {
    apply({ type: 'approval.upserted', approval: await api.approval(id) });
  },

  async decideApproval(id: string, input: ApprovalDecisionInput) {
    const a = await api.decideApproval(id, input);
    apply({ type: 'approval.upserted', approval: a });
    return a;
  },

  /** The owner's answer to a transcript card; the card's message comes back as it is now. */
  async answerCard(botId: string, id: string, input: CardAnswerInput) {
    const m = await api.answerCard(botId, id, input);
    apply({ type: 'message.updated', message: m });
    return m;
  },

  /** A card as the server has it now (after a refused answer, say). */
  async reloadCard(id: string) {
    apply({ type: 'message.updated', message: await api.card(id) });
  },

  async loadMemories(botId: string) {
    put('memories', botId, await api.memories(botId));
  },

  /** The response isn't applied: it can arrive after newer events (a reply) and would undo them; bot.upserted brings the change. */
  markRead(botId: string, upTo: string) {
    if (sentReads.get(botId) === upTo) return;
    sentReads.set(botId, upTo);
    set((s) => ({ bots: s.bots.map((b) => (b.id === botId && b.unread ? { ...b, unread: 0 } : b)) }));
    clearTimeout(readTimers.get(botId));
    readTimers.set(
      botId,
      setTimeout(() => {
        readTimers.delete(botId);
        api.markRead(botId, upTo).catch((e) => {
          if (sentReads.get(botId) === upTo) sentReads.delete(botId);
          console.warn(`[Botons] could not mark ${botId} read`, e);
        });
      }, READ_DEBOUNCE_MS),
    );
  },

  /** Optimistic: if the server refuses, the memory comes back and the error is rethrown. */
  async forgetMemory(m: Memory) {
    apply({ type: 'memory.deleted', memoryId: m.id, botId: m.botId });
    try {
      await api.deleteMemory(m.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return;
      set((s) => {
        const list = s.memories[m.botId];
        if (!list || list.some((x) => x.id === m.id)) return {};
        return { memories: { ...s.memories, [m.botId]: [...list, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) } };
      });
      throw e;
    }
  },

  async updateSettings(patch: UpdateSettingsInput) {
    set({ settings: await api.updateSettings(patch) });
  },

  async pauseBot(id: string, paused: boolean) {
    upsertBot(await api.pauseBot(id, paused));
  },

  async pauseAll(paused: boolean) {
    set({ settings: await api.pauseAll(paused) });
  },

  async loadConnectors() {
    set({ connectors: await api.connectors() });
  },

  async loadMcpServers() {
    set({ mcpServers: await api.mcpServers() });
  },

  /** No `name`: add one. */
  async saveMcpServer(name: string | null, input: McpServerInput) {
    if (name) await api.updateMcpServer(name, input);
    else await api.createMcpServer(input);
    await Promise.all([actions.loadMcpServers(), actions.loadConnectors()]);
  },

  async loadSkills() {
    set({ skills: sortSkills(await api.skills()) });
  },

  /** No `name`: add one. */
  async saveSkill(name: string | null, input: { name?: string; description: string; body: string }) {
    const skill = name ? await api.updateSkill(name, { description: input.description, body: input.body }) : await api.createSkill({ ...input, name: input.name ?? '' });
    apply({ type: 'skill.upserted', skill });
    return skill;
  },

  async approveSkill(name: string, version: string) {
    apply({ type: 'skill.upserted', skill: await api.approveSkill(name, version) });
  },

  /** A skill the server answered with (installed, restored, turned on or off): shown at once, before its event. */
  skillChanged(skill: Skill) {
    apply({ type: 'skill.upserted', skill });
  },

  async deleteSkill(name: string) {
    await api.deleteSkill(name);
    apply({ type: 'skill.deleted', name });
  },

  async loadApiKeys() {
    set({ apiKeys: await api.apiKeys() });
  },

  /** One provider's state from an answer, in place. */
  apiKeyChanged(next: ApiKeyState) {
    set((s) => (s.apiKeys ? { apiKeys: { providers: s.apiKeys.providers.map((p) => (p.provider === next.provider ? next : p)) } } : {}));
  },

  async loadOAuth() {
    set({ oauth: await api.oauthConnections() });
  },

  async addOAuth(input: OAuthConnectionInput) {
    const c = await api.createOAuthConnection(input);
    apply({ type: 'oauth.upserted', connection: c });
    await actions.loadConnectors();
    return c;
  },

  async updateOAuth(id: string, patch: OAuthConnectionInput) {
    apply({ type: 'oauth.upserted', connection: await api.updateOAuthConnection(id, patch) });
  },

  async deleteOAuth(id: string) {
    await api.deleteOAuthConnection(id);
    apply({ type: 'oauth.deleted', id });
    await actions.loadConnectors();
  },

  /** Off to the authorization server; the callback brings the browser back here. */
  async connectOAuth(id: string) {
    const { authorizeUrl } = await api.connectOAuth(id, location.origin);
    location.assign(authorizeUrl);
  },

  async checkOAuth(id: string) {
    apply({ type: 'oauth.upserted', connection: await api.checkOAuth(id) });
  },

  /**
   * The catalog is loaded again rather than patched with the answer: if the connector was edited, signed in again or
   * removed while the test ran, the server keeps no result for it, and the old answer must not show as current.
   */
  async testConnector(id: string) {
    const test = await api.testConnector(id);
    await actions.loadConnectors();
    return test;
  },

  async setConnectorPolicy(id: string, input: ConnectorPolicyInput) {
    await api.setConnectorPolicy(id, input);
    await actions.loadConnectors();
  },

  async deleteMcpServer(name: string) {
    await api.deleteMcpServer(name);
    await Promise.all([actions.loadMcpServers(), actions.loadConnectors()]);
  },
};

whenUnauthorized(() => {
  actions.checkAuth().catch(() => {});
});
