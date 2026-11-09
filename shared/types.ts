// API contract shared by the server and the web app.

import type { TranscriptCard } from './cards.ts';
import type { BrowserHandoff } from './handoff.ts';
import type { CliCopy } from './versions.ts';

export type AccessLevel = 'workspace' | 'host';

export type BotonShape = 'round' | 'pill' | 'key';
export type BotonShell = 'snow' | 'steel' | 'graphite' | 'sun' | 'signal' | 'cobalt' | 'violet' | 'teal';
export type BotonGlow = 'cyan' | 'pink' | 'lime' | 'amber' | 'violet' | 'ice';
export type BotonEyes = 'dots' | 'rings' | 'bars' | 'happy' | 'wink' | 'lidded';
export type BotonBrows = 'none' | 'soft' | 'straight' | 'arched' | 'bold';
export type BotonMouth = 'smile' | 'grin' | 'smirk' | 'o' | 'calm' | 'wave';
export type BotonTop = 'none' | 'antenna' | 'twin' | 'dish' | 'coil' | 'fin' | 'beacon' | 'halo';
export type BotonEars = 'none' | 'bolts' | 'pods' | 'fins' | 'knobs';
export type BotonVisor = 'none' | 'goggles' | 'monocle' | 'band';
export type BotonPanel = 'none' | 'holes' | 'grill' | 'leds' | 'dial' | 'switch';
export type BotonArms = 'none' | 'nubs' | 'wave' | 'cheer';
export type BotonBackdrop = 'mist' | 'ice' | 'mint' | 'lilac' | 'blush' | 'night' | 'plum' | 'grid';

/** A Boton's look: a button-bot built from fixed parts (see shared/look.ts for the values, shared/boton.ts for the drawing). */
export interface BotonLook {
  /** The button: round, a wide pill, or a keycap. */
  shape: BotonShape;
  /** Body color. */
  shell: BotonShell;
  /** The light of its face and rim. */
  glow: BotonGlow;
  eyes: BotonEyes;
  brows: BotonBrows;
  mouth: BotonMouth;
  /** On top: antennas and more. */
  top: BotonTop;
  ears: BotonEars;
  /** Over the display. */
  visor: BotonVisor;
  /** Under the display. */
  panel: BotonPanel;
  arms: BotonArms;
  backdrop: BotonBackdrop;
  cheeks: boolean;
}

/** What an avatar shows through its face and parts. `asleep`: no working brain yet. */
export type AvatarState = 'idle' | 'working' | 'approval' | 'error' | 'asleep';

export interface BotStatus {
  state: 'idle' | 'queued' | 'working';
  activity: string | null;
  since: string | null;
  draft?: TurnDraft | null;
}

export interface TurnDraft {
  turnId: string;
  text: string;
  at: string;
}

export type StepKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'tool';

export interface TurnStep {
  kind: StepKind;
  label: string;
  detail: string;
  at: string;
}

export interface TurnSteps {
  turnId: string;
  startedAt: string;
  outcome: TurnOutcome;
  /** Only the first 200 steps are kept, so `steps` can be shorter. */
  total: number;
  steps: TurnStep[];
}

export interface Bot {
  id: string;
  name: string;
  title: string;
  instructions: string;
  look: BotonLook;
  provider: string;
  /** "": the provider's default. */
  model: string;
  /** How hard it thinks (a level of shared/effort.ts for its provider); "": the provider's default. */
  effort: string;
  access: AccessLevel;
  /** Its sidebar group's id; null: ungrouped. */
  groupId: string | null;
  /** That group's name; "": ungrouped. */
  group: string;
  pinned: boolean;
  timezone: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: { role: MessageRole; text: string; createdAt: string; from?: string } | null;
  unread: number;
  status: BotStatus;
  paused: boolean;
  connections: string[];
  /** null: every skill in the library. */
  skills: string[] | null;
  alwaysAllow: string[];
  askFirst: string[];
}

export type MessageRole = 'user' | 'bot' | 'event' | 'error';

export type MessageKind =
  | 'routine.created'
  | 'routine.updated'
  | 'routine.paused'
  | 'routine.resumed'
  | 'routine.deleted'
  | 'routine.run'
  | 'routine.rate_limited'
  | 'routine.model_reset'
  | 'effort.reset'
  | 'provider.switched'
  | 'provider.summary'
  | 'memory.saved'
  | 'memory.forgotten'
  | 'session.reset'
  | 'notify.sent'
  | 'turn.stopped'
  | 'turn.interrupted'
  | 'bot.paused'
  | 'bot.resumed'
  | 'usage.limit'
  | 'file.shared'
  | 'instructions.restored'
  | 'ask'
  | 'ask.reply'
  | 'ask.sent'
  | 'ask.refused'
  | 'bot.duplicated'
  | 'bot.from_template'
  | 'bot.imported'
  | 'skill.created'
  | 'skill.updated'
  | 'approval.requested'
  | 'approval.decided'
  | 'approval.auto'
  | 'approval.expired'
  | 'approval.cancelled'
  | 'connector.granted'
  | 'connector.reconnect'
  | 'work.event'
  | 'card.posted'
  | 'card.answered'
  | 'reaction.followup'
  | 'browser.handoff'
  | 'browser.handed_back';

export interface MessageMeta {
  kind?: MessageKind;
  routineId?: string;
  routineName?: string;
  runId?: string;
  trigger?: RunTrigger;
  memoryText?: string;
  notifyText?: string;
  priority?: NotifyPriority;
  skillName?: string;
  attempt?: number;
  retryAt?: string;
  durationMs?: number;
  provider?: string;
  /** provider.summary: the name of the provider whose session wrote it, as the server had it then. */
  providerLabel?: string;
  model?: string;
  /** The effort level the turn asked its CLI for (not necessarily the one that ran: no CLI reports that); absent: none, the CLI's default. */
  effort?: string;
  usage?: TokenUsage;
  turnId?: string;
  steps?: number;
  staleContext?: boolean;
  attachments?: FileRef[];
  file?: FileRef & { title?: string };
  /** Taken from the asking Boton's turn token, never from what it says. */
  fromBotId?: string;
  fromBotName?: string;
  toBotId?: string;
  toBotName?: string;
  askText?: string;
  threadId?: string;
  hop?: number;
  askId?: string;
  sourceBotId?: string;
  sourceName?: string;
  templateId?: string;
  copiedRoutines?: number;
  copiedMemories?: number;
  approvalId?: string;
  approvalTitle?: string;
  approvalAction?: string;
  decision?: 'allowed' | 'denied';
  note?: string;
  connectorId?: string;
  /** A work update from a connector's feed: only values the server checked. */
  work?: WorkEvent;
  /** provider.switched: what the server noted at the switch, for the first turn of the new provider's session. */
  handoff?: ProviderHandoff;
  /** provider.switched: a turn on the new provider has run since, so the note is not given again. */
  handoffDone?: boolean;
  /**
   * The owner pinned this message (POST /api/bots/:id/messages/:messageId/pin): every new session is given it,
   * whatever its age (a long one as an excerpt: its start and end). Only that route sets it, and starting the chat
   * fresh takes it off.
   */
  pinned?: { at: string };
  /** card.posted: the card a Boton posted, checked by the server, and how it stands. */
  card?: TranscriptCard;
  /** card.answered: the card (its message id) this answers. */
  cardId?: string;
  /** browser.handoff: the Boton's request for the owner to take its browser over, and how it stands (shared/handoff.ts). */
  browserHandoff?: BrowserHandoff;
  /** browser.handed_back: the handoff (its message id) the owner handed back. */
  handoffId?: string;
  /**
   * Left out of the transcript: an automatic wake-up (see shared/wake.ts) whose turn ended [quiet], or what that turn
   * did in the chat (a memory saved, a file shared...). The server sets it when the turn ends, and reads it from the
   * turn records for chat history from before that (without writing it). The message is still returned here, and the
   * turn's history keeps the note.
   */
  quiet?: boolean;
  /** The quiet turn a marked message belongs to: its steps hold the note. */
  quietTurn?: string;
  /**
   * An event of what a Boton does (TURN_ACTIVITY in shared/wake.ts: memory, a shared file, a notification, an ask, its
   * routines and skills): the turn it did it in, or null when it wasn't a turn (the owner, the server). Missing on older
   * messages, which then always show: nothing else says whether a turn or the owner did it.
   */
  byTurn?: string | null;
  /** reaction.followup: the Boton's message the owner reacted to, and with which emoji. */
  reactionTo?: string;
  emoji?: string;
  /** reaction.followup: the owner took the reaction off before the follow-up turn started, so none ran. */
  withdrawn?: boolean;
}

/** A provider and the model a Boton asks it for ("": its default). */
export interface BrainRef {
  provider: string;
  /** The provider's name, as the server had it at the time. */
  label: string;
  model: string;
}

/**
 * What the server noted when a Boton moved to another provider: taken once, at the switch, from what Botons
 * stores (never from the old provider's session), and bounded. The first turn of the new session starts with it.
 */
export interface ProviderHandoff {
  from: BrainRef;
  to: BrainRef;
  at: string;
  /** Whether a session on the old provider was there to lose. */
  sessionEnded: boolean;
  /** A turn was underway on the old provider at the move: it finished there, and its session was not kept. */
  working?: boolean;
  kept: { memories: number; routines: number };
  /** Its approval requests still waiting for the owner. */
  waiting: { id: string; title: string }[];
  /** Runs queued or running at the switch. */
  runs: { routineId: string; routineName: string; status: 'queued' | 'running' }[];
  /** Scheduled runs due within a day. */
  dueSoon: { routineId: string; routineName: string; at: string }[];
  /** The owner's latest decisions on its requests. */
  decisions: { title: string; decision: 'allowed' | 'denied'; at: string }[];
  /**
   * The provider.summary message the old session wrote at the owner's request just before the move: the old agent's
   * own words, which the server bounds but doesn't check. Absent when none was asked for.
   */
  summary?: { messageId: string };
}

/**
 * Whether the move can first ask the old session for a short summary of its open work: one more turn there, with no
 * tools, at the owner's choice. Never offered when there is no session to ask, or it can't run now.
 */
export interface SwitchSummaryOffer {
  available: boolean;
  /** Why it isn't (null when it is). */
  reason: string | null;
  /** Sent back as `switchConfirmation`, with `switchSummary: true`, to move with the summary. */
  confirmation: string | null;
  /** What the extra turn may take: its time limit, and the summary kept at most (longer is cut at a sentence). */
  timeoutMs: number;
  maxChars: number;
}

export interface ProviderSwitchInput {
  provider: string;
  /** As the update will send it: absent, the Boton's current model. */
  model?: string;
  /** As the update will send it: absent, the Boton's level, kept if the new provider and model have it. */
  effort?: string;
}

/** What moving a Boton to another provider keeps and loses, before it happens. */
export interface ProviderSwitchPreview {
  from: BrainRef & { effort: string };
  to: BrainRef & { effort: string };
  /**
   * Whether the update must carry `confirmation`: a session on the old provider would end (the chat's, or a
   * routine's own). Without one there is nothing to lose, and the switch needs no confirming.
   */
  required: boolean;
  /**
   * Sent back as `switchConfirmation` with the update. It stands for everything else in this preview, for this
   * Boton: if any of it differs when the update comes (a session, a turn starting or ending, a memory, routine or pin,
   * queued runs, the new provider's readiness or a usage limit), the update is refused and the owner reviews again.
   */
  confirmation: string | null;
  /** The sessions the move ends: saved ones, and the one a turn underway on the old provider is starting or carrying on. */
  sessions: { chat: boolean; routines: { id: string; name: string }[] };
  /**
   * A turn is underway on the old provider (setting up, or running). It finishes there: what it does still happens
   * and its reply is kept, but its session isn't. Queued runs run on the new one.
   */
  working: boolean;
  queuedRuns: number;
  /**
   * What the new session is given of the chat, sized to one budget it shares with the handoff note and the summary.
   * The budget bounds the replayed text only, not the instructions and context every session starts with. Sizes are
   * estimated tokens, counted as UTF-8 bytes: never fewer than the real count. Pinned messages always fit
   * (at most pinLimit of them, each bounded); then the latest messages, newest first, until the budget is spent.
   * Messages over messageLimit are given as excerpts (their start and end), not summarized.
   */
  replay: { budget: number; messageLimit: number; pinned: number; pinLimit: number };
  /**
   * What the replay would give now, without a summary (which takes some of the budget when there is one). An estimate
   * for the owner, not bound by the confirmation: the chat moves on before the turn.
   */
  replayNow: ReplayEstimate;
  kept: { memories: number; routines: number };
  /** The Boton's level goes back to the default because the new provider or model lacks it (not the update's own pick). */
  effortReset: boolean;
  /** Routines whose own model is the old provider's: they go back to the Boton's model. */
  routineModels: { id: string; name: string; model: string }[];
  /** Routines whose own effort the new provider or model lacks: they go back to the Boton's. */
  routineEfforts: { id: string; name: string; effort: string }[];
  /** Its connectors the new provider can't run. */
  connectors: { id: string; name: string }[];
  /**
   * What the server knows of the new provider: ready only when its last check found it usable; unknown before any
   * check. Never a promise that a turn will work.
   */
  readiness: { state: 'ready' | 'unavailable' | 'unknown'; reason: string | null; usageLimitUntil: string | null };
  /** The old provider is out of usage until then: the server noted it, and switching is the owner's choice. */
  oldUsageLimitUntil: string | null;
  summary: SwitchSummaryOffer;
}

/** What a replay would give of the chat, as counts: see ProviderSwitchPreview.replay. */
export interface ReplayEstimate {
  /** Estimated tokens used of the budget. */
  used: number;
  messages: number;
  routines: number;
  pinned: number;
  excerpts: number;
  /** Older messages since the reset are left out. */
  olderLeftOut: boolean;
  /** The oldest message given, pins apart (null: none). */
  since: string | null;
}

/** POST /api/bots/:id/messages/:messageId/pin. */
export interface PinInput {
  pinned: boolean;
}

export type WorkEventKind = 'finished' | 'needs_input' | 'failed' | 'cancelled' | 'delegated_ended';

export interface WorkEvent {
  connectorId: string;
  jobId: string;
  kind: WorkEventKind;
  state: string | null;
  /** t3-thread: or https: only, from the connector's own job data. */
  link: string | null;
  /** The feed's id for the event it came from (its cursor). */
  eventId?: string;
  /**
   * The job's title from the connector's own job data, cleaned to one short line: shown to the owner only, never in
   * anything a Boton reads.
   */
  title?: string;
  /** Not known to be any Boton's: delivered to the primary Boton by the connector's setting. */
  unowned?: boolean;
}

export interface FileRef {
  name: string;
  /** Relative to the Boton's workspace, "/"-separated. */
  path: string;
  size: number;
  type: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
  /** In the inbox only: kept by the owner, so neither the daily cleanup nor Clear inbox moves it to the trash. */
  pinned?: boolean;
}

/** Why something is in the trash: the owner deleted it, the daily inbox cleanup moved it, or Clear inbox did. */
export type TrashReason = 'deleted' | 'inbox_cleanup' | 'inbox_cleared';

/** Where a trash item came from, and so where Restore puts it: a Boton's workspace, or the shared folder. */
export type TrashOrigin = 'workspace' | 'shared';

/** Something moved to the server's trash (BOTONS_HOME/trash), kept for TRASH_KEEP_DAYS, then deleted for good. */
export interface TrashItem {
  id: string;
  origin: TrashOrigin;
  /** The Boton whose workspace it was in; empty for the shared folder. */
  botId: string;
  /** The Boton's name when it was deleted; empty for the shared folder. */
  botName: string;
  /** Where it was, relative to the Boton's workspace (or the shared folder), "/"-separated. */
  path: string;
  name: string;
  isDir: boolean;
  /** Bytes, files in a folder added up. */
  size: number;
  deletedAt: string;
  /** When it is deleted for good. */
  purgeAt: string;
  reason: TrashReason;
  /** The Boton itself was deleted since: it can only be deleted forever. */
  botGone: boolean;
}

export interface DeleteFilesInput {
  /** Workspace (or shared folder) paths, as the listing gives them. */
  paths: string[];
}

export interface TrashResult {
  trashed: TrashItem[];
  /** Clear inbox: how many items it left because they are kept (pinned). */
  kept?: number;
}

export interface RestoreResult {
  origin: TrashOrigin;
  /** Where it is now, relative to the workspace (or the shared folder): its old path, with -2, -3… when that was taken, or in the nearest folder on the way when its own can't be made again. */
  path: string;
  renamed: boolean;
  /** Its own folder couldn't be made again (a file in the way, or a link out), so it is in the nearest one that could. */
  folderGone: boolean;
}

export interface InboxPinInput {
  /** inbox/<name>: a file or folder directly in the inbox. */
  path: string;
  pinned: boolean;
}

/** Bytes a Boton's files take: the workspace (inbox included), its inbox, and its items in the trash. */
export interface BotStorage {
  botId: string;
  name: string;
  workspaceBytes: number;
  inboxBytes: number;
  trashBytes: number;
  trashItems: number;
}

export interface StorageUsage {
  bots: BotStorage[];
  sharedBytes: number;
  /** The shared folder's items in the trash. */
  sharedTrashBytes: number;
  sharedTrashItems: number;
  /** Every item in the trash, of every Boton (deleted ones too) and the shared folder. */
  trashBytes: number;
  /** A folder was too big to count in full: the sizes are at least these. */
  partial: boolean;
  /** Inbox files older than this many days go to the trash each day; null: never. */
  inboxCleanupDays: number | null;
  trashKeepDays: number;
}

export interface FilePreviewInput {
  path: string;
}

/** An HTML file's sandboxed preview page. `url` holds a key for that one file; null `expiresAt`: no key (auth off). `size`: the file's, when the link was made. */
export interface FilePreviewLink {
  url: string;
  expiresAt: string | null;
  size: number;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface SendMessageInput {
  text?: string;
  attachments?: { path: string }[];
}

export interface ShareInput {
  path: string;
  title?: string;
}

export interface ShareResult {
  message: Message;
  file: FileRef;
}

/** GET /api/bots/:id/background: what the Boton did on its own lately (routine turns and automatic wake-ups). */
export interface BackgroundActivity {
  /** Routine turns and wake-ups in the last hour. */
  lastHour: number;
  /** How many of those ended [quiet]: nothing in the chat. */
  quietLastHour: number;
  /** The latest one, whenever it was; null if it never had one. */
  lastAt: string | null;
  /** The last day's, newest first (at most 100): what the chat's background line opens. */
  recent: BackgroundItem[];
}

/** One routine turn or automatic wake-up, for the Boton's background activity list. */
export interface BackgroundItem {
  at: string;
  /** What woke it, as the chat labels it: never an id. */
  label: string;
  /** May name ids. */
  detail: string;
  quiet: boolean;
  /** A quiet turn's note ('' for none), or null when not quiet. */
  note: string | null;
  /** The turn's outcome (ok, error, running, interrupted...), or null when no turn ran yet. */
  outcome: string | null;
  /** The message whose steps show the turn (the wake-up when quiet, else the reply), or null. */
  stepsMessageId: string | null;
  /** How many steps the turn kept (a quiet one's note is one). */
  steps: number;
  /** A routine run's id, for its run steps. */
  runId: string | null;
  routineId: string | null;
  warn: boolean;
}

export interface Message {
  id: string;
  botId: string;
  role: MessageRole;
  text: string;
  meta: MessageMeta | null;
  createdAt: string;
  /** Emoji reactions on it, oldest first; absent when it has none. */
  reactions?: MessageReaction[];
}

/** Who reacted: the owner (from a paired device) or the Boton whose chat it is. */
export type ReactionActor = 'owner' | 'boton';

/**
 * One emoji on a message. The owner reacts to the Boton's messages, the Boton to the owner's (one emoji at most
 * per message). A reaction is feedback only: it never decides an approval or a card.
 */
export interface MessageReaction {
  emoji: string;
  by: ReactionActor;
  at: string;
}

/** POST /api/bots/:id/messages/:messageId/reactions. */
export interface ReactInput {
  emoji: string;
}

/**
 * GET /api/reactions/export: every reaction, as a file of its own (apart from any backup). POST /api/reactions/import
 * puts one back: all of it or nothing if any entry is wrong. Each message the file names that is here gets exactly
 * the file's reactions; a message that isn't here is skipped. Importing never starts a turn, and the Boton isn't
 * told of imported reactions as new feedback.
 */
export interface ReactionTransfer {
  format: 'botons-reactions';
  version: 1;
  /** When it was exported; not read on import. */
  exportedAt?: string;
  reactions: ReactionTransferEntry[];
}

export interface ReactionTransferEntry {
  messageId: string;
  botId: string;
  by: ReactionActor;
  emoji: string;
  at: string;
}

export interface ReactionImportResult {
  /** Reactions now on the messages the file named. */
  imported: number;
  /** Message ids in the file that are no message here (or not in the chat the file says). */
  skipped: string[];
}

export interface Routine {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  /** Normalized ("cron 0 8 * * 1-5", "every 30m", "once <iso>"), or null for webhook/manual only. */
  schedule: string | null;
  scheduleText: string | null;
  timezone: string;
  webhook: RoutineWebhook | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  notify: NotifyPolicy;
  /** Webhook runs get Workspace access (sandboxed): their payload comes from outside. */
  webhookWorkspace: boolean;
  skill: string | null;
  /** null: the Boton's own model. */
  model: string | null;
  /** null: the Boton's own effort. */
  effort: string | null;
  session: RoutineSession;
  /**
   * How many of the chat's latest messages each webhook run is given (0: none, at most WEBHOOK_HISTORY_MAX), in a
   * session that ends with the run: a webhook run never carries on the chat's session, whatever `session` says. Only
   * the owner sets it above 0.
   */
  webhookHistory: number;
  /**
   * How long one attempt at a run may take, in ms, from the moment its agent process starts (time queued or setting up
   * connectors doesn't count), before it is stopped and the run fails as timed out. null: the server's limit
   * (ServerInfo.turnTimeoutMs), which also caps this one.
   */
  timeLimitMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export type WebhookSource = 'generic' | 'github' | 'linear' | 'slack' | 'sentry';

export interface WebhookFilter {
  kind: 'header' | 'field';
  name: string;
  values: string[];
}

export interface RoutineWebhook {
  url: string;
  /** "" when read with the token of a sandboxed webhook run. */
  key: string;
  source: WebhookSource;
  /** The secret itself is write-only. */
  hasSecret: boolean;
  filter: WebhookFilter | null;
  callbackUrl: string | null;
}

export type RoutineSession = 'chat' | 'own';

export type NotifyPolicy = 'auto' | 'always' | 'failures' | 'never';
export type NotifyPriority = 'default' | 'high';

export type RunTrigger = 'schedule' | 'webhook' | 'manual' | 'test';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface RoutineRun {
  id: string;
  routineId: string;
  botId: string;
  trigger: RunTrigger;
  status: RunStatus;
  error: string | null;
  payloadPreview: string | null;
  payloadBytes: number;
  headers: Record<string, string> | null;
  reply: string | null;
  quiet: boolean;
  meta: RunMeta | null;
  startedAt: string;
  finishedAt: string | null;
  attempts: number;
  lastError: string | null;
  retryAt: string | null;
  usage: TokenUsage | null;
  model: string | null;
  steps: number;
}

/** A run the owner may want to act on, across every Boton and routine. */
export interface AttentionRun extends RoutineRun {
  botName: string;
  routineName: string;
}

/** GET /api/runs/attention: failed runs nobody retried yet, and runs waiting to try again by themselves. */
export interface RunsAttention {
  /** Failed runs that finished since then are listed; older ones are left to each routine's run history. */
  since: string;
  /** Newest first. Not test runs (the owner watched those), runs already retried, nor runs the owner cancelled. */
  failed: AttentionRun[];
  /** Queued runs held after a network error or for a usage limit, soonest first. */
  held: AttentionRun[];
  /** Finished since then, their result not delivered to the routine's callback URL after every retry; newest first. */
  callbacks: AttentionRun[];
}

export interface TokenUsage {
  /** Excludes cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  /**
   * An API brain's turns: how `costUsd` was found. `estimate`: Botons' own sum of the tokens the API reported times
   * the rates in server/src/rates.ts, which is not the provider's bill. Absent for a CLI's own figure.
   */
  costBasis?: 'estimate';
  /**
   * Part of `costUsd` that is a hold, not a count: a request whose answer never fully came (the connection dropped
   * after it was sent) is counted at the most it could have cost, since the provider may have billed it.
   */
  costHeldUsd?: number;
}

export type TurnOutcome = 'running' | 'ok' | 'error' | 'timeout' | 'stopped' | 'interrupted';

export type TurnTrigger = 'chat' | RunTrigger;

export interface UsageReport {
  since: string;
  until: string;
  group: 'bot' | 'routine';
  rows: UsageRow[];
}

export interface UsageRow extends TokenUsage {
  botId: string;
  botName: string;
  routineId?: string | null;
  routineName?: string | null;
  turns: number;
}

export interface RunPayload {
  runId: string;
  payload: string | null;
  headers: Record<string, string> | null;
  bytes: number;
}

export interface RunMeta {
  notifications?: NotifyDelivery[];
  callback?: CallbackDelivery;
  /** This run retries a failed one, with its trigger, payload and headers. */
  retryOf?: { runId: string; error: string | null };
  /** The run the owner started to retry this failed one. */
  retriedAs?: string;
  /**
   * The owner ended this run (Cancel, Stop or a pause), so it is failed but needs nothing more: it is not retried by
   * itself, pushes nothing and is not listed to check. `started`: an attempt at it ran (this one, or an earlier one that
   * failed and was held to try again), so it may have partly run.
   */
  cancelled?: { at: string; started: boolean };
  /**
   * Stopped because it ran past its time limit (`limitMs`) before anything else ended it: failed, not retried by itself,
   * and (unlike a cancelled run) listed for the owner to check, since it may have partly run.
   */
  timedOut?: { at: string; limitMs: number };
}

export interface CallbackDelivery {
  url: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  attempts: number;
  at: string;
  /** Being sent (ok is false until it is). One still pending at a start was cut off, and is sent again. */
  pending?: boolean;
}

export interface RunCallback {
  runId: string;
  routineId: string;
  botId: string;
  trigger: RunTrigger;
  status: RunStatus;
  quiet: boolean;
  reply: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  attempts: number;
  /** Failed because the owner ended it (see RunMeta.cancelled). */
  cancelled: boolean;
  /** Failed because it ran past its time limit (see RunMeta.timedOut). */
  timedOut: boolean;
}

export interface WebhookRunStatus {
  ok: boolean;
  runId: string;
  status: RunStatus;
  trigger: RunTrigger;
  reply: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  attempts: number;
  /** The run that retries this one, once it failed and the owner retried it. */
  retriedAs: string | null;
  /** Failed because the owner ended it (see RunMeta.cancelled). */
  cancelled: boolean;
  /** Failed because it ran past its time limit (see RunMeta.timedOut). */
  timedOut: boolean;
}

export interface RunRoutineInput {
  payload?: unknown;
  test?: boolean;
}

export interface NotifyDelivery {
  channel: 'ntfy';
  reason: 'failure' | 'result' | 'notify' | 'approval' | 'test';
  ok: boolean;
  status: number | null;
  error: string | null;
  at: string;
}

export interface Memory {
  id: string;
  botId: string;
  text: string;
  createdAt: string;
}

export interface ProviderModel {
  id: string;
  label: string;
  /** The effort levels the provider lists for this model; absent when it doesn't say. */
  efforts?: string[];
  /** The level it runs at when none is set, when the provider says. */
  defaultEffort?: string;
}

/** Whether a provider can be told how hard to think, and how. */
export interface ProviderEffortInfo {
  /** Weakest first; empty when the provider has no effort setting. */
  levels: ProviderModel[];
  /** Why the control is off, when `levels` is empty. */
  reason: string | null;
  /** How it reaches the CLI, e.g. "Claude Code’s --effort". */
  via: string | null;
  /** What runs when no level is set. */
  defaultText: string;
}

/**
 * How ready a brain is to run turns, from the server's own check of its CLI and the usage limits its turns hit.
 * `ready` only when a recent check found it installed and confirmed it signed in; anything the check could not tell
 * (not run yet, too old, no answer, a sign-in status it could not read) is `unknown`.
 */
export type BrainState = 'ready' | 'unknown' | 'not-installed' | 'signed-out' | 'unavailable' | 'usage-limited';

/**
 * Why a brain is not ready, as a fixed word (server/src/providers/readiness.ts): never the CLI's output, a path or a
 * token. `not-found`: no such command for the server. `not-runnable`: there, but it could not be started.
 * `incompatible-version`: the installed CLI cannot safely run Botons turns.
 * `version-failed`: `--version` exited with an error. `login-unreadable`: installed, but its sign-in status could not be
 * read. `outdated`: the last check is too old to go by. `clock-changed`: the last check is stamped later than the
 * server's clock now (it was set back), so how old it is can't be told.
 */
export type BrainCheckProblem =
  | 'not-checked'
  | 'outdated'
  | 'clock-changed'
  | 'timed-out'
  | 'not-found'
  | 'not-runnable'
  | 'incompatible-version'
  | 'version-failed'
  | 'login-unreadable'
  | 'signed-out'
  | 'usage-limit'
  | 'unavailable';

export interface BrainReadiness {
  state: BrainState;
  problem: BrainCheckProblem | null;
  /** When the check this comes from ran; null before any. */
  checkedAt: string | null;
  /** Its turns hit a usage limit: held until then. */
  usageLimitUntil: string | null;
  /**
   * Which run of the server answered: a new random id each time it starts, never a clock. Two answers with different
   * boots can't be ordered by `generation`; the later request's is the newer.
   */
  boot: string;
  /**
   * Higher for each check of this brain the server finishes in this boot: of two answers from the same boot, the
   * higher one is from the newer check. 0 for a brain the server doesn't check.
   */
  generation: number;
}

export interface ProviderInfo {
  /** Offline Workspace helper preflight; independent of sign-in and Full computer access. */
  workspaceProblem?: string | null;
  id: string;
  label: string;
  kind: 'cli' | 'api';
  available: boolean;
  reason: string | null;
  installed: boolean;
  version: string | null;
  /** A CLI brain's copy: Botons' own or the system's, and the version of another copy a terminal here runs. */
  copy?: CliCopy;
  loggedIn: boolean | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  lastError: { at: string; message: string } | null;
  models: ProviderModel[];
  defaultModel: string;
  effort: ProviderEffortInfo;
  askFirst?: boolean;
  usageLimit?: { until: string; reason: string } | null;
  readiness: BrainReadiness;
}

// ------------------------------------------------------------------ API keys

/** The model APIs whose keys the owner can give Botons. */
export type ApiKeyProvider = 'anthropic' | 'openai';

/**
 * Where the key Botons would use comes from: one saved in Settings (kept in the database, like OAuth tokens), else
 * the variable in the server's environment, else none. A saved key always wins over the environment.
 */
export type ApiKeySource = 'saved' | 'environment' | 'none';

/**
 * How a test went, in fixed words; never the provider's own error text. `invalid`: the provider refused the key
 * (401). `forbidden`: the key is known but may not list models (403). `rate_limited`: 429. `unavailable`: the
 * provider answered 5xx or said it was overloaded. `unreachable`: no answer (network, DNS, TLS, time limit).
 * `unexpected`: another status, a redirect, or an answer Botons couldn't read.
 */
export type ApiKeyTestOutcome = 'ok' | 'invalid' | 'forbidden' | 'rate_limited' | 'unavailable' | 'unreachable' | 'unexpected';

/**
 * What the provider's model list says about one capability: `yes` or `no` only when the list itself has a field for
 * it; otherwise `unknown`. Botons never infers a capability from a model's or provider's name.
 */
export type CapabilityEvidence = 'yes' | 'no' | 'unknown';

export interface ApiModelCapabilities {
  chat: CapabilityEvidence;
  tools: CapabilityEvidence;
  vision: CapabilityEvidence;
  realtimeVoice: CapabilityEvidence;
  speechToText: CapabilityEvidence;
  textToSpeech: CapabilityEvidence;
}

/** One model a key can use, as the provider's model list gave it, kept only in its expected shape. */
export interface ApiModel {
  id: string;
  /** Only when it is plain text of the expected shape; else null. */
  displayName: string | null;
  /** Anthropic: active, deprecated or retired; null when the list doesn't say. */
  lifecycle: 'active' | 'deprecated' | 'retired' | null;
  capabilities: ApiModelCapabilities;
  /** The effort levels the list says it takes; null when the list doesn't say. */
  effort: string[] | null;
}

/** One test of a key: listing its models, read-only, with no prompt sent and nothing generated. */
export interface ApiKeyTest {
  provider: ApiKeyProvider;
  /** The key this test was of: the saved one at `generation`, or the environment's. */
  source: Exclude<ApiKeySource, 'none'>;
  generation: number;
  outcome: ApiKeyTestOutcome;
  /** The provider's HTTP status, when it answered. */
  httpStatus: number | null;
  checkedAt: string;
  durationMs: number;
  /** With `ok`: the models in their expected shape, newest first as the provider lists them. */
  models: ApiModel[];
  /** Models the list held that were left out: an id not of the expected shape, or past the limit. */
  omitted: number;
  /** The list had more pages than Botons reads. */
  truncated: boolean;
  /** False when the key changed while the test ran: its result says nothing about the key there is now. */
  current: boolean;
}

export interface ApiKeyState {
  provider: ApiKeyProvider;
  label: string;
  /** The server environment variable used when no key is saved. */
  envVar: string;
  source: ApiKeySource;
  saved: boolean;
  savedAt: string | null;
  /** The variable is set in the server's environment (read at start). */
  environment: boolean;
  /** Bumped by every save and removal of the saved key; send it back with the next change. */
  generation: number;
  /** The newest test of the key there is now; null if it hasn't been tested. */
  test: ApiKeyTest | null;
  testing: boolean;
  /** What a test sends, in the owner's words. */
  testDescription: string;
  /** Whether Botons can run on this key now (the provider id they pick), or why not. */
  brain: { available: boolean; provider: string; reason: string | null };
  /**
   * What this key's own turns showed, per model, since the key was saved (or the server started, for the
   * environment's): evidence from real use, never from a model's name. Paid probes are never sent to find out.
   */
  observed: ApiModelObservation[];
}

/** When a turn on this key first showed a model doing each thing; absent means never seen, which is not "no". */
export interface ApiModelObservation {
  model: string;
  /** A turn finished with a reply. */
  chat?: string;
  /** A turn's tool call was answered and the model carried on. */
  tools?: string;
  /** A turn with an image in it finished. */
  vision?: string;
}

/** Spending caps on a Boton's API-key turns, in US dollars of Botons' own estimate (see TokenUsage.costBasis). */
export interface SpendingView {
  botId: string;
  /** At most this much a day (from midnight in the Boton's time zone); null for no cap. */
  dailyCapUsd: number | null;
  /** Today's estimate so far, holds and running requests' reservations included. */
  spentTodayUsd: number;
  /** Today's API-key turns with no known price (a model without a rate): with a cap set, turns are refused. */
  unpricedToday: number;
  dayStartedAt: string;
  routines: { id: string; name: string; perRunCapUsd: number | null }[];
  /** How the caps are kept, in the owner's words. */
  rules: string;
}

export interface SpendingInput {
  dailyCapUsd?: number | null;
  /** By routine id; null removes its cap. */
  routines?: Record<string, number | null>;
}

export interface ApiKeysView {
  providers: ApiKeyState[];
}

/** Save (or replace) a provider's key. `generation` is the one the page last saw: a key changed since is not overwritten. */
export interface SaveApiKeyInput {
  key: string;
  generation: number;
}

export interface RemoveApiKeyInput {
  generation: number;
}

export type HealthCheck = 'database' | 'scheduler' | 'providers' | 'draining';

export interface Health {
  ok: boolean;
  build: string | null;
  failing: HealthCheck[];
  /** Only for paired devices. */
  details?: HealthDetails;
}

export interface HealthDetails {
  database: { ok: boolean; error: string | null };
  scheduler: { ok: boolean; lastTickAt: string | null; intervalMs: number };
  providers: ProviderInfo[];
  draining: boolean;
}

/** One backup folder in BOTONS_HOME/backups, as its manifest describes it. */
export interface BackupSummary {
  /** The folder's name: when the backup was made, in UTC. */
  name: string;
  createdAt: string;
  /** Null when the manifest is missing or unreadable. */
  schemaVersion: number | null;
  /** workspaces/, shared/ and templates/ were archived with the database. */
  workspaces: boolean;
  /** The archive could not be made, so only the database was kept (npm run backup prints why). */
  workspacesFailed: boolean;
}

/** What the paired owner sees of backups. No paths, file contents or error text. */
export interface BackupStatus {
  /** Newest first, at most BACKUPS_LISTED (server/src/backup.ts). */
  backups: BackupSummary[];
  /** All complete backups in the folder. */
  total: number;
  /** Backups the timer keeps; older ones are deleted. */
  keep: number;
  /** The newest is older than this, or there is none while the database exists. */
  staleAfterHours: number;
  stale: boolean;
  /** Backups that stopped part-way (`<time>.partial`), deleted after a day. */
  partial: number;
  /** The backups folder could not be listed (not a folder, or no permission); the doctor on the server says more. */
  unreadable: boolean;
}

/** Why a push did not go through, as a fixed word (server/src/notify.ts): never the error text. */
export type PushProblem = 'refused' | 'rejected' | 'redirected' | 'server-error' | 'unreachable' | 'timeout';

/** How pushes have gone since the server started. */
export interface PushStatus {
  /** `unset`: no ntfy server or topic is saved. `off`: saved, but push is turned off. */
  state: 'unset' | 'off' | 'on';
  /** The newest attempt, a test or a real push; null when none since `since`. */
  last: { at: string; ok: boolean; reason: NotifyDelivery['reason']; status: number | null; problem: PushProblem | null } | null;
  lastSuccessAt: string | null;
  /** Attempts that failed since the last one that went through. */
  failuresInARow: number;
  /** When counting started: the server's start, or the last change to the ntfy server, topic or token. */
  since: string;
  /** Counting restarted because the ntfy server, topic or token changed: older attempts said nothing about these. */
  sinceSettingsChange: boolean;
}

/** Room left where the data lives (BOTONS_HOME). Sizes in bytes; no paths. */
export interface StorageStatus {
  /** The free space could not be read; the other fields are then 0. */
  unreadable: boolean;
  freeBytes: number;
  totalBytes: number;
  /** The database with its write-ahead log. */
  databaseBytes: number;
  /** Free space is below `lowBelowBytes`, or below 5% of the disk. */
  low: boolean;
  lowBelowBytes: number;
}

/** Why the database check failed, as a fixed word (server/src/health.ts): never the error text. */
export type DatabaseProblem = 'busy' | 'corrupt' | 'read-only' | 'disk-full' | 'cannot-open' | 'io-error' | 'other';
/** Why a brain is not ready, as a fixed word: never the CLI's output. */
export type BrainProblem = 'not-installed' | 'signed-out' | 'unavailable';

/** One brain as Settings → Health shows it: states and times, a version only in a known shape, no CLI output. */
export interface OperationsBrain {
  id: string;
  label: string;
  available: boolean;
  installed: boolean;
  loggedIn: boolean | null;
  /** Only a version number found in `--version`'s output ("2.1.3"), else null. */
  version: string | null;
  problem: BrainProblem | null;
  lastSuccessAt: string | null;
  /** When its last turn failed, without the error. */
  lastErrorAt: string | null;
  /** It hit a usage limit and waits until then. */
  usageLimitUntil: string | null;
  readiness: BrainReadiness;
}

/** The health check as the owner's view carries it: GET /api/health's checks with fixed words in place of error text. */
export interface OperationsHealth {
  ok: boolean;
  /** Only a commit sha (hex), else null. */
  build: string | null;
  failing: HealthCheck[];
  details: {
    database: { ok: boolean; problem: DatabaseProblem | null };
    scheduler: HealthDetails['scheduler'];
    providers: OperationsBrain[];
    draining: boolean;
  };
}

/**
 * Why a restore rehearsal failed, as a fixed word (server/src/rehearsal.ts): never the error text.
 * `interrupted`: the server stopped or restarted while it ran. `failed`: something the rehearsal did not expect.
 */
export type RehearsalProblem =
  | 'not-found'
  | 'not-a-backup'
  | 'database-too-large'
  | 'no-space'
  | 'damaged-database'
  | 'newer-schema'
  | 'older-schema'
  | 'upgrade-failed'
  | 'damaged-archive'
  | 'unsafe-archive'
  | 'archive-too-large'
  | 'timed-out'
  | 'interrupted'
  | 'failed';

/** `checked`: read through and every member checked. `none`: the backup holds the database only. `not-checked`: it stopped first. */
export type RehearsalWorkspaces = 'checked' | 'none' | 'not-checked';

/**
 * The last restore rehearsal: a backup copied to a private temporary folder, checked, upgraded there to this server's
 * schema, its workspaces archive read through, then deleted. Nothing in the data folder changes. Only times, fixed
 * words, counts and versions: no paths, file names or error text.
 */
export interface RestoreRehearsal {
  /** The backup folder's name (its UTC time). */
  backup: string;
  startedAt: string;
  /** Null while it runs. */
  finishedAt: string | null;
  outcome: 'running' | 'passed' | 'failed';
  problem: RehearsalProblem | null;
  /** The schema the backup's database is at, read from the copy; null when it could not be read. */
  fromSchema: number | null;
  /** The schema the copy was upgraded to (or already at): this server's when it passed. */
  toSchema: number | null;
  /** Whether each table holds as many rows as the backup's manifest says; null when it says nothing. */
  matchesManifest: boolean | null;
  workspaces: RehearsalWorkspaces;
  /** What the workspaces archive holds; null unless it was read through. */
  files: number | null;
  folders: number | null;
  bytes: number | null;
  /** The server that ran it: a release version and build only in their expected shapes, else null. */
  ranBy: { version: string | null; build: string | null; schema: number };
}

/** POST /api/backups/rehearse: a backup folder's name, or "latest" (the default). */
export interface RehearseRestoreInput {
  backup?: string;
}

export interface RehearsalStatus {
  /** The newest rehearsal, running or finished; null when none has run on this data folder. */
  last: RestoreRehearsal | null;
  /** Rehearsals allowed per hour. */
  limitPerHour: number;
}

/** GET /api/operations: the owner's read-only view of whether the server works and is backed up. No error text, paths or addresses. */
export interface OperationsStatus {
  health: OperationsHealth;
  /** The database schema this server runs (SCHEMA_VERSION). */
  schema: number;
  backups: BackupStatus;
  push: PushStatus;
  storage: StorageStatus;
  /** Which commands the recovery steps show: the Docker image's, or a checkout's. */
  install: import('./install-commands.ts').InstallType;
  /** The backup schemas this server's restore takes, oldest first: its own, and the one before (upgraded at the next start). */
  restorableSchemas: number[];
  rehearsal: RehearsalStatus;
}

export type RecentLogLevel = 'info' | 'warn' | 'error';
/** Only ids of the server's own shape, enum words, booleans and bounded whole numbers: never text from a log line. */
export type RecentLogField = string | number | boolean;
/** What the owner can do about an event, for events with a known next step. */
export type RecentLogHelp = 'reconnect' | 'connector' | 'push' | 'tailscale' | 'usage-limit' | 'brain' | 'run' | 'bug' | 'auth-off';

/** One server event as Settings keeps it (server/src/recent-logs.ts): selected from a log line, never copied from it. */
export interface RecentLogEntry {
  /** Counts up from the server's start; a restart starts again at 1. */
  seq: number;
  ts: string;
  level: RecentLogLevel;
  /** A fixed code for a known log message, or `unclassified` for any other. */
  event: string;
  /** Written in the server's source for the event, never taken from the line. */
  label: string;
  help: RecentLogHelp | null;
  /** The allowlisted fields whose values passed their checks; `errorCategory` stands for any thrown error. */
  fields: Record<string, RecentLogField>;
}

export interface RecentLogs {
  entries: RecentLogEntry[];
  /** Older lines match the filters too: ask again with `before` the last entry's seq. */
  more: boolean;
  /** When this server process started keeping lines: a restart empties the view. */
  since: string;
  /** The oldest line still kept, or null when none is. */
  oldestAt: string | null;
  /** Lines let go since `since` to stay within the limits. */
  dropped: number;
  kept: number;
  /** Of the kept lines, whatever the filters. */
  counts: Record<RecentLogLevel, number>;
  bytes: number;
  limits: { entries: number; bytes: number; page: number };
  /** BOTONS_LOG_LEVEL: less severe lines are neither written nor kept. */
  threshold: RecentLogLevel;
}

export interface Settings {
  ownerName: string;
  timezone: string;
  primaryBotId: string | null;
  ntfy: NtfySettings;
  paused: boolean;
  /**
   * Reactions of the owner's on a Boton's message that start a short follow-up turn (each at most once per message);
   * any other reaction only reaches the Boton as feedback on its next turn. Default: 👎 alone.
   */
  reactionFollowUps: string[];
  /** Each day, inbox files untouched this many days go to the trash (kept ones stay); null: off. Default 30. */
  inboxCleanupDays: number | null;
}

export interface NtfySettings {
  enabled: boolean;
  server: string;
  topic: string;
  /** The token itself is write-only. */
  hasToken: boolean;
  preview: boolean;
}

export interface UpdateSettingsInput {
  ownerName?: string;
  timezone?: string;
  primaryBotId?: string | null;
  ntfy?: {
    enabled?: boolean;
    server?: string;
    topic?: string;
    /** "" or null removes the saved one. */
    token?: string | null;
    preview?: boolean;
  };
  /** Emoji, at most REACTION_FOLLOW_UP_MAX; [] for none. */
  reactionFollowUps?: string[];
  /** One of INBOX_CLEANUP_CHOICES, or null for off. */
  inboxCleanupDays?: number | null;
}

export interface NotifyInput {
  text: string;
  priority?: NotifyPriority;
}

export interface NotifyResult {
  message: Message;
  deliveries: NotifyDelivery[];
  skipped: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  title: string;
  state: BotStatus['state'];
  paused: boolean;
  primary: boolean;
  self: boolean;
}

export interface AskInput {
  text: string;
}

export interface AskResult {
  message: Message;
  threadId: string;
  hop: number;
}

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';

export type ApprovalKind = 'action' | 'skill' | 'connector';

/** The turn that asked, as the server knew it (never from what the Boton says). */
export interface ApprovalOrigin {
  trigger: TurnTrigger;
  turnId: string | null;
  routineId: string | null;
  routineName: string | null;
  runId: string | null;
  sandboxed: boolean;
  askedBy: string[];
}

export interface Approval {
  id: string;
  botId: string;
  kind: ApprovalKind;
  title: string;
  details: string;
  followUp: string;
  action: string | null;
  skillName: string | null;
  /** A connector request: which connector (its id), as the Boton asked for it. */
  connectorId: string | null;
  status: ApprovalStatus;
  always: boolean;
  auto: boolean;
  note: string | null;
  from: ApprovalOrigin;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  messageId: string | null;
  notifications: NotifyDelivery[];
  tool: ApprovalToolCall | null;
}

export interface ApprovalToolCall {
  name: string;
  /** The card's title and details are made from this, never from what the Boton says. */
  input: unknown;
  rule: string | null;
  waitUntil: string;
  inTurn: boolean;
  usedAt: string | null;
  /**
   * A request the Boton's managed browser holds at the network boundary (not a CLI's tool call): allowing it sends
   * exactly the request on the card once, while the browser still holds it; `usedAt` is when it was sent. Never
   * always-allowed, and never carried over to another turn.
   */
  browser: boolean;
  /**
   * A browser request's send, once allowed and spent: `sending` until it is known (a server stopped mid-send leaves it
   * so, which means unknown), `sent` (the site answered), `not-sent` (it failed before it left) or `unknown` (written,
   * then the connection broke before an answer: the site may have acted on it, so it is never retried). Else null.
   */
  delivery: 'sending' | 'sent' | 'not-sent' | 'unknown' | null;
}

export interface ToolCallInput {
  toolName: string;
  input: unknown;
  /** The CLI's id for the call, for the log. */
  toolUseId?: string;
}

export interface ToolCallVerdict {
  behavior: 'allow' | 'deny' | 'wait';
  message: string | null;
  approval: Approval | null;
  /** With 'wait': this call's own id on the card, for GET /api/approvals/:id/tool-call?waiter=. Only it gets the allow. */
  waiter?: string;
}

export interface ApprovalRequestInput {
  title: string;
  details?: string;
  followUp?: string;
  action?: string;
  expiresIn?: string;
}

export interface ApprovalRequestResult {
  approval: Approval;
  duplicate: boolean;
}

export interface ApprovalDecisionInput {
  decision: 'allow' | 'deny';
  always?: boolean;
  note?: string;
}

export interface CancelRunsResult {
  cancelledRuns: number;
}

export interface StopInput {
  clearQueue?: boolean;
}

export interface StopResult {
  stopped: boolean;
  cancelledRuns: number;
  queuedRuns: number;
}

export interface ServerInfo {
  install?: import('./install-commands.ts').InstallType;
  version: string;
  /** A different value in a later `hello` event means the server was upgraded. */
  build: string | null;
  hostname: string;
  urls: string[];
  publicUrl: string;
  hooksUrl: string | null;
  /** The longest one agent turn may run, in ms (BOTONS_TURN_TIMEOUT_MS): a routine's time limit defaults to it and can't exceed it. */
  turnTimeoutMs: number;
}

export interface AuthStatus {
  /** False only with BOTONS_AUTH=off. */
  required: boolean;
  caller: 'device' | 'boton' | 'none';
  deviceId: string | null;
  botId: string | null;
  urlKeys: UrlKeys | null;
  ownerPairing: { login: string; node: string } | null;
  hostname: string;
  /** False until the first device pairs: that device claims the server for its owner. */
  claimed: boolean;
  /** What to run on the server's machine to manage pairing (`npm run pair`, or its Docker form). */
  pairCommand: string;
}

/**
 * Which networks may reach the app's port. A second line behind the listeners (BOTONS_HOST, the
 * published port) and auth: requests from other networks are refused before anything else runs.
 * It narrows, never widens: reaching the server from further away also needs host changes.
 */
export type AccessMode = 'local' | 'tailscale' | 'lan' | 'public';

export interface AccessModeOption {
  mode: AccessMode;
  label: string;
  /** Which connections this mode accepts, as the server is set up now. */
  summary: string;
  /** What the mode can't see (forwarders, a container's network): available in Details. */
  limits: string[];
  /** False: it can't be chosen as the server is set up now; `reason` says why. */
  available: boolean;
  reason: string | null;
  /** What the owner does on the host first (none for local); Botons never does these itself. */
  steps: string[];
}

export interface SetupWarning {
  level: 'error' | 'warn' | 'info';
  text: string;
}

export interface SetupStatus {
  owner: {
    name: string;
    /** When the first device paired, and its label; null on a server paired before claims were recorded. */
    claimedAt: string | null;
    claimedBy: string | null;
    devices: number;
  };
  /** The first-run setup was finished or skipped (or the server already had Botons). */
  completed: boolean;
  completedAt: string | null;
  /** null: never chosen, so no network is refused beyond what the listeners allow. */
  accessMode: AccessMode | null;
  recommendedMode: AccessMode | null;
  modes: AccessModeOption[];
  exposure: {
    /** Where the app listens (host:port). */
    listeners: string[];
    /** The webhooks-only listener, if any (BOTONS_HOOKS_PORT). */
    hooksListeners: string[];
    publicUrl: string;
    https: boolean;
    authRequired: boolean;
    tailscale: boolean;
    container: boolean;
  };
  warnings: SetupWarning[];
  botons: number;
}

export interface UpdateSetupInput {
  /** null forgets the choice (no network refused beyond the listeners). */
  accessMode?: AccessMode | null;
  /** true: the first-run setup is done (or skipped); it is not shown again. */
  complete?: boolean;
}

export type AuditActorKind = 'device' | 'boton' | 'host' | 'system';

export type AuditAction =
  | 'device.paired'
  | 'device.revoked'
  | 'devices.revoked_all'
  | 'pairing_request.approved'
  | 'access_mode.changed'
  | 'setup.completed'
  | 'settings.notifications_changed'
  | 'notifications.tested'
  | 'backup.rehearsed'
  | 'boton.created'
  | 'boton.deleted'
  | 'boton.access_changed'
  | 'boton.spending_changed'
  | 'boton.permissions_changed'
  | 'routine.permissions_changed'
  | 'routine.starter_activated'
  | 'run.retried'
  | 'run.cancelled'
  | 'run.callback_resent'
  | 'approval.decided'
  | 'card.answered'
  | 'skill.approved'
  | 'skill.installed'
  | 'skill.restored'
  | 'skill.enabled'
  | 'skill.disabled'
  | 'connector.policy_changed'
  | 'connector.granted'
  | 'connector.tested'
  | 'connector.disabled'
  | 'connector.enabled'
  | 'mcp_server.created'
  | 'mcp_server.changed'
  | 'mcp_server.deleted'
  | 'oauth.created'
  | 'oauth.deleted'
  | 'oauth.signin_started'
  | 'oauth.connected'
  | 'brain.cli_install_started'
  | 'brain.cli_install_succeeded'
  | 'brain.cli_install_failed'
  | 'brain.signin_started'
  | 'brain.signin_cancelled'
  | 'brain.signin_import_confirmed'
  | 'brain.signin_import_completed'
  | 'brain.config_repair_confirmed'
  | 'brain.config_repair_completed'
  | 'brain.config_repair_failed'
  | 'api_key.saved'
  | 'api_key.removed'
  | 'api_key.tested'
  | 'browser.sites_changed'
  | 'browser.stopped'
  | 'browser.handover_started'
  | 'browser.handover_ended'
  | 'config.exported'
  | 'config.imported'
  | 'files.trashed'
  | 'files.restored'
  | 'files.purged'
  | 'inbox.cleared'
  | 'inbox.cleaned_up';

/** One consequential action. Never holds a token, code, secret, URL query or message text. */
export interface AuditEvent {
  seq: number;
  at: string;
  actor: { kind: AuditActorKind; id: string | null; label: string };
  action: AuditAction;
  target: { kind: string; id: string; label: string } | null;
  details: Record<string, string | number | boolean | null | string[]>;
}

/** What one Boton may do, in the owner's words: for Settings and for review, not enforcement. */
export interface BotonCapabilities {
  botId: string;
  access: AccessLevel;
  paused: boolean;
  /** One sentence each, most consequential first. */
  summary: string[];
  connectors: { id: string; name: string; usable: boolean; off: boolean }[];
  /** Connectors it may ask for, and how a request is granted. */
  requestable: { id: string; name: string; grant: ConnectorGrant }[];
  /** null: every skill in the library. */
  skills: string[] | null;
  /**
   * The saved Ask first rules as the engine applies them: `enforced` pause a tool call, `alwaysAllowed` pause
   * only webhook runs ("Always allow" covers them), `inactive` do nothing because the brain doesn't support them.
   */
  askFirst: { enforced: string[]; alwaysAllowed: string[]; inactive: string[] };
  alwaysAllow: string[];
  routines: { id: string; name: string; enabled: boolean; schedule: boolean; webhook: boolean; webhookFullAccess: boolean; callback: boolean }[];
}

/** `?key=` values for what a browser loads by URL and can't send a header with, each good for its GET routes only. */
export interface UrlKeys {
  events: string;
  files: string;
}

export interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
}

/** With `secret`: the request the owner approved. With neither: the owner's own Tailscale device. A `code` alone is refused. */
export interface PairInput {
  secret?: string;
  code?: string;
  label?: string;
}

export interface PairResult {
  device: Device;
  token: string;
}

/**
 * A device's request to pair. The device keeps `secret` (it alone redeems the approval) and shows `code`,
 * which the owner approves on the server's machine (`approveCommand`) or on a paired device.
 */
export interface PairingRequest {
  secret: string;
  code: string;
  expiresAt: string;
  approveCommand: string;
}

export interface ApprovePairingInput {
  code: string;
  /** Names the device; beats the device's own guess. */
  label?: string;
}

export interface ApprovedPairing {
  label: string;
  createdAt: string;
}

/** Every connector is Botons' own: a server in its library, or one signed in to with OAuth. */
export type ConnectorSource = 'library' | 'oauth';

export type ConnectorStatus = 'ok' | 'needs-auth';

/** Never carries secrets. */
export interface Connector {
  id: string;
  name: string;
  source: ConnectorSource;
  providers: string[];
  transport: 'stdio' | 'http';
  target: string;
  status: ConnectorStatus;
  note: string | null;
  /** Botons that don't have it may ask for it (`botons connector request`). */
  onRequest: boolean;
  /** How such a request is granted: at once, or on an approval card. */
  grant: ConnectorGrant;
  /** What `status` rests on, in the owner's words: being listed or set up is not the same as its tools loading in a turn. */
  basis: string;
  /** The owner can test it from the server (POST /api/connectors/:id/test): Botons reaches it itself and lists its tools. */
  testable: boolean;
  /** The last test since the server started, if any. */
  lastTest: ConnectorTest | null;
  /** Built into Botons (the managed browser): run by the server itself, not edited, tested or asked for. */
  managed?: boolean;
  /**
   * False: the owner turned it off. Its setup, sign-in and grants are kept, but no turn gets it, no Boton may ask for
   * it and its work feed isn't read, until it is turned on again. The managed browser is always on here (it is given
   * and stopped in each Boton's settings).
   */
  enabled: boolean;
  /** When and why it was turned off; null while it is on. */
  off: ConnectorOff | null;
}

export interface ConnectorOff {
  at: string;
  /** The owner's own words, if any (at most 200 characters). */
  reason: string;
}

/**
 * An owner's test of one connector. reached: Botons' server started an MCP session and listed its tools; failed:
 * it tried and couldn't; untestable: the server can't check this one itself (`scope` says what would).
 */
export interface ConnectorTest {
  connectorId: string;
  at: string;
  outcome: 'reached' | 'failed' | 'untestable';
  /** What the test covered and what it doesn't prove. */
  scope: string;
  /** Why it failed or wasn't tested; when reached, a warning about what the token can see (GitHub's private repos). */
  problem: string | null;
  toolCount: number;
  /** Tool names, as the server listed them (at most 100). */
  tools: string[];
  durationMs: number;
}

export type ConnectorGrant = 'approval' | 'immediate';

export interface ConnectorPolicyInput {
  onRequest?: boolean;
  grant?: ConnectorGrant;
}

/**
 * One Boton as one connector sees it. has: it is in the Boton's connectors, so its turns get it; mayAsk: it doesn't
 * have it but may ask for it (`botons connector request`, granted as the connector's policy says); brainCanUse: the
 * Boton's brain takes connectors at all. withoutReason: why its last turn went without it, if it did.
 */
export interface ConnectorBotonAccess {
  botId: string;
  name: string;
  provider: string;
  has: boolean;
  mayAsk: boolean;
  brainCanUse: boolean;
  withoutReason: string | null;
}

/** Which Botons may use one connector, exactly, and what was done to it and its grants (newest first). */
export interface ConnectorAccess {
  connectorId: string;
  name: string;
  /** The managed browser: given only in each Boton's settings, so this view is read-only for it. */
  managed: boolean;
  onRequest: boolean;
  grant: ConnectorGrant;
  enabled: boolean;
  off: ConnectorOff | null;
  botons: ConnectorBotonAccess[];
  /**
   * Botons with a turn running now that was given it. Turning it off doesn't reach into that turn (its CLI already
   * has the server, and an OAuth token can't be taken back from it), so each keeps it until that turn ends. `turnId`
   * names that one turn: a later turn of the same Boton is another one.
   */
  running: { botId: string; name: string; turnId: string }[];
  history: AuditEvent[];
}

/**
 * Turn a connector off or on. `expected` is what the owner was shown: whether it was on, which Botons had it, and the
 * turns running with it (their `turnId`s). If it is on or off otherwise now, other Botons have it, or a turn they
 * weren't shown runs with it now, nothing is changed and the server answers 409.
 */
export interface ConnectorEnabledInput {
  enabled: boolean;
  reason?: string;
  expected: { enabled: boolean; botIds: string[]; running: string[] };
}

/**
 * The Botons that should have the connector, exactly. `expected` is the list the owner was shown (the Botons that
 * had it): if that changed meanwhile, nothing is changed and the server answers 409.
 */
export interface ConnectorAccessInput {
  botIds: string[];
  expected: string[];
}

/** What a Boton sees of a connector: never its URL, headers or tokens. */
export interface BotonConnector {
  id: string;
  name: string;
  /** yours: in this Boton's connectors; available: it may ask for it. */
  state: 'yours' | 'available';
  grant: ConnectorGrant | null;
  usable: boolean;
  /** The owner turned it off: it stays this Boton's, but its turns go without it until it is on again. */
  off: boolean;
}

export interface ConnectorRequestResult {
  connector: BotonConnector;
  /** granted: it is the Boton's from its next turn; pending: on an approval card; already: it had it. */
  outcome: 'granted' | 'pending' | 'already';
  approval: Approval | null;
}

export type OAuthStatus = 'new' | 'connected' | 'reconnect';

/** A remote MCP server signed in to with OAuth. Tokens never leave the server. */
export interface OAuthConnection {
  id: string;
  /** Its connector id is "oauth:<name>". */
  name: string;
  url: string;
  status: OAuthStatus;
  statusReason: string | null;
  issuer: string | null;
  scope: string | null;
  connectedAt: string | null;
  refreshedAt: string | null;
  /** The last refresh failed but the grant may still work (network, server error); it is tried again. */
  refreshError: string | null;
  keepConnected: boolean;
  nextKeepAliveAt: string | null;
  /** The server has a compatible work_feed tool, which Botons polls. */
  feed: boolean;
  feedCheckedAt: string | null;
  feedError: string | null;
  /** Where updates on work no Boton is known to have started go. */
  unknownJobs: 'nowhere' | 'primary';
  createdAt: string;
}

export interface OAuthConnectionInput {
  name?: string;
  url?: string;
  keepConnected?: boolean;
  unknownJobs?: 'nowhere' | 'primary';
}

export interface OAuthConnectStart {
  /** Open it in the browser: the authorization server's sign-in page. */
  authorizeUrl: string;
  expiresAt: string;
}

export interface ConnectorCatalog {
  connectors: Connector[];
}

/**
 * Something the owner should know about one of a Boton's connectors. removed: it was a connector from the owner's
 * own Claude Code or Codex setup, which Botons no longer uses, and was taken off the Boton; it stays until the
 * owner dismisses it or gives the Boton `offer`. skipped: the Boton's last turn went without it, for `reason`.
 */
export interface ConnectorNotice {
  botId: string;
  connectorId: string;
  kind: 'removed' | 'skipped';
  name: string;
  /** Where it pointed (no query or credentials), if known. */
  target: string;
  reason: string;
  at: string;
  /** A Botons connector with the same name or address, which the owner may give the Boton instead. */
  offer: { id: string; name: string; target: string } | null;
}

/** Environment and header values are write-only: only their names come back. */
export interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  envKeys: string[];
  headerKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  name?: string;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** null removes a value; names left out keep theirs. */
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
}

export interface SchedulePreview {
  ok: boolean;
  error: string | null;
  schedule: string | null;
  text: string | null;
  nextRuns: string[];
}

export interface CreateBotInput {
  name: string;
  title?: string;
  instructions?: string;
  look?: BotonLook;
  provider?: string;
  model?: string;
  /** "": the provider's default. */
  effort?: string;
  access?: AccessLevel;
  /** A sidebar group by id; null or "": ungrouped. Not with `group`. */
  groupId?: string | null;
  /** A sidebar group by name (any case), made if there is none; "": ungrouped. Not with `groupId`. */
  group?: string;
  /** Pinning puts it last among the pinned; to place it, POST /api/sidebar/bots/:id/pin. */
  pinned?: boolean;
  timezone?: string;
  connections?: string[];
  skills?: string[] | null;
}

export interface NewBotInput extends CreateBotInput {
  /** Applied atomically with creation; null means no daily cap. */
  dailyCapUsd?: number | null;
  templateId?: string;
  startRoutines?: boolean;
  /**
   * A starter template (one with `needs`) is installed only as the owner reviewed it: `reviewKey` from
   * POST /api/templates/:id/review for the same brain, access, timezone and `starterConnectors`. Its connectors are
   * the owner's choices here (slot to connector id, or null to go without an optional one), never the template's,
   * and its routines start paused.
   */
  reviewKey?: string;
  starterConnectors?: Record<string, string | null>;
}

export type UpdateBotInput = Partial<CreateBotInput> & {
  alwaysAllow?: string[];
  askFirst?: string[];
};

/** A Boton update as sent: moving it to another provider that would end a session needs the preview's confirmation. */
/**
 * `switchSummary`: ask the old session for a summary before the move (its preview's `summary.confirmation` then goes in
 * `switchConfirmation`); the move waits for it, and is refused, changing nothing, if it can't be written.
 */
export type UpdateBotRequest = UpdateBotInput & { switchConfirmation?: string; switchSummary?: boolean };

export interface DuplicateBotInput {
  name?: string;
  withRoutines?: boolean;
  withMemories?: boolean;
}

export interface TemplateRoutine {
  name: string;
  instruction: string;
  schedule: string | null;
  scheduleText: string | null;
  timezone: string | null;
  webhook: boolean;
  notify: NotifyPolicy;
  webhookWorkspace: boolean;
  webhookSource: WebhookSource;
  webhookFilter: WebhookFilter | null;
  skill: string | null;
  model: string | null;
  effort: string | null;
  session: RoutineSession;
  /** null: the server's limit. */
  timeLimitMs: number | null;
}

/** Nulls leave the New Boton form's own value. */
export interface TemplateBot {
  name: string;
  title: string;
  instructions: string;
  look: BotonLook | null;
  provider: string | null;
  model: string;
  effort: string;
  access: AccessLevel;
  group: string;
  timezone: string | null;
  connections: string[];
  skills: string[] | null;
}

export interface BotTemplate {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  bot: TemplateBot;
  routines: TemplateRoutine[];
  createdAt: string | null;
  /** A starter's declared needs, reviewed by the owner before it is installed; null for a saved template. */
  needs: StarterNeeds | null;
}

/**
 * What a starter says it needs, in the owner's words. A declaration only: nothing here is granted. The owner picks
 * the brain, the access and which of their own connectors (if any) fills each slot, and reviews exactly that.
 */
export interface StarterNeeds {
  /** Part of the review key: a starter whose declaration changes must be reviewed again. */
  version: number;
  brain: {
    /** Its work needs connectors, so the brain must take them. */
    connectors: boolean;
    text: string;
  };
  /** The access it asks for; the owner may choose another, which the review says. */
  access: AccessLevel;
  accessWhy: string;
  connectors: StarterConnectorNeed[];
  /** When it runs, in words; the routines' own schedules are in `routines`. */
  schedule: string;
  output: { where: 'chat' | 'workspace'; folder: string | null; text: string };
  /** What happens when a run fails. */
  failure: string;
  /** A webhook routine's sample payload for its test run. */
  samplePayload: string | null;
  /** What no check here can verify (the services themselves). */
  notChecked: string[];
}

/** A connector the starter's work uses, filled by one of the owner's connectors they choose (or none, if optional). */
export interface StarterConnectorNeed {
  slot: string;
  label: string;
  purpose: string;
  required: boolean;
  /** Words matched against the owner's connector names and addresses to suggest one; never a connector id. */
  hints: string[];
  /** How the starter's instructions use it. The grant itself is the whole connector, which the review says. */
  uses: 'read' | 'read-write';
}

export interface TemplateReviewInput {
  provider: string;
  access: AccessLevel;
  timezone?: string;
  /** Slot to connector id, or null for none. */
  connectors?: Record<string, string | null>;
}

export type ReviewItemState = 'ok' | 'warning' | 'blocked';

/** One connector the owner could put in a slot. */
export interface StarterConnectorCandidate {
  id: string;
  name: string;
  /** Its name or address matches one of the slot's hints. */
  suggested: boolean;
  /** Why it can't be used for this Boton now, if it can't. */
  problem: string | null;
}

export interface TemplateReviewSlot {
  slot: string;
  label: string;
  purpose: string;
  required: boolean;
  uses: 'read' | 'read-write';
  chosen: { id: string; name: string } | null;
  state: ReviewItemState;
  text: string;
  candidates: StarterConnectorCandidate[];
  /** What to do when nothing fits (no connector, or none this brain can use). */
  guidance: string | null;
}

/**
 * Exactly what installing a starter grants, for the owner to confirm. `reviewKey` binds the confirmation to it: an
 * install sent with a key for anything else (another brain, access, connector, or the connector's state, or the
 * starter itself, changed since) is refused with 409.
 */
export interface TemplateReview {
  templateId: string;
  brain: { id: string; label: string; ready: boolean; takesConnectors: boolean; text: string; state: ReviewItemState };
  access: { level: AccessLevel; asked: AccessLevel; text: string; state: ReviewItemState };
  slots: TemplateReviewSlot[];
  skills: string[];
  routines: { name: string; scheduleText: string | null; timezone: string; webhook: boolean; notify: NotifyPolicy; text: string }[];
  output: string;
  failure: string;
  /** Problems that stop the install, in words. */
  blocked: string[];
  /** Everything it grants, one line each: the summary the owner confirms. */
  grants: string[];
  reviewKey: string;
}

/** One line of a starter's setup check. `unverified`: nothing here can tell; the test run or the service says. */
export interface SetupCheckItem {
  key: string;
  label: string;
  state: 'ok' | 'problem' | 'unverified';
  text: string;
}

/**
 * A starter's setup check on a Boton installed from it: computed on the server from what it saved at the install
 * (the starter, the owner's slot choices), the Boton's settings, the connectors' last known state and the brain's
 * last check. It runs nothing and reaches nothing outside this server.
 */
export interface SetupCheck {
  botId: string;
  templateId: string;
  at: string;
  /** The owner's slot choices at the install, as the server saved them. */
  slots: Record<string, string | null>;
  items: SetupCheckItem[];
  ready: boolean;
  /** Each routine's turning on, as the server decides it (POST /api/routines/:id/activate). */
  routines: StarterRoutineGate[];
  /** What it did and didn't cover, in words. */
  scope: string;
  notChecked: string[];
}

/**
 * A Boton installed from a starter, as the server keeps it. Each of its routines waits on the owner's decision until
 * the owner turns it on with POST /api/routines/:id/activate: no other path (a PATCH, the `botons` CLI, the Routines
 * panel, a copy of the Boton) can turn it on before that.
 */
export interface StarterInstall {
  botId: string;
  templateId: string;
  templateName: string;
  slots: Record<string, string | null>;
  installedAt: string;
  /** Its routines still waiting on the owner's decision. */
  pending: string[];
}

/** Whether a starter's routine can be turned on now, and why. */
export interface StarterRoutineGate {
  routineId: string;
  /** Still waiting on the owner's decision; false once the owner turned it on (from then on an ordinary routine). */
  pending: boolean;
  /** A test run of its current settings finished without an error, and none is running: turning it on needs no override. */
  tested: boolean;
  /** A test run of it is queued or running: nothing turns it on until that ends. */
  testing: boolean;
  /** The latest test run, if any. */
  runId: string | null;
  text: string;
}

/**
 * The owner turns a starter's routine on. Without `override` only when its latest test run finished without an error
 * on exactly its current settings (the Boton's, the routine's, its connectors' and skills') and no test run is under
 * way. `override: true` turns it on without that, and is audited as such; it still waits for a test run under way.
 */
export interface StarterActivationInput {
  override?: boolean;
}

export interface SaveTemplateInput {
  fromBotId: string;
  name?: string;
  description?: string;
}

export interface CreateRoutineInput {
  name: string;
  instruction: string;
  schedule?: string | null;
  timezone?: string;
  webhook?: boolean;
  enabled?: boolean;
  notify?: NotifyPolicy;
  webhookWorkspace?: boolean;
  webhookSource?: WebhookSource;
  webhookSecret?: string | null;
  webhookFilter?: WebhookFilter | null;
  callbackUrl?: string | null;
  skill?: string | null;
  model?: string | null;
  /** null or absent: the Boton's effort. */
  effort?: string | null;
  session?: RoutineSession;
  /** 0 to WEBHOOK_HISTORY_MAX; above 0 only from the owner (see Routine.webhookHistory). */
  webhookHistory?: number;
  /** In ms, at least 1 second and at most the server's limit; null or absent: the server's limit. */
  timeLimitMs?: number | null;
}

export interface UpdateRoutineInput {
  name?: string;
  instruction?: string;
  schedule?: string | null;
  timezone?: string;
  webhook?: boolean;
  rotateKey?: boolean;
  enabled?: boolean;
  notify?: NotifyPolicy;
  webhookWorkspace?: boolean;
  webhookSource?: WebhookSource;
  /** "" or null removes the saved one. */
  webhookSecret?: string | null;
  webhookFilter?: WebhookFilter | null;
  callbackUrl?: string | null;
  skill?: string | null;
  /** null or "": the Boton's model. */
  model?: string | null;
  /** null or "": the Boton's effort. */
  effort?: string | null;
  session?: RoutineSession;
  /** 0 to WEBHOOK_HISTORY_MAX; above 0 only from the owner (see Routine.webhookHistory). */
  webhookHistory?: number;
  /** null: back to the server's limit. */
  timeLimitMs?: number | null;
}

export type SkillAuthor = { kind: 'owner' } | { kind: 'boton'; botId: string; name: string };

export interface Skill {
  name: string;
  description: string;
  body: string;
  createdBy: SkillAuthor;
  updatedBy: SkillAuthor;
  createdAt: string;
  updatedAt: string;
  /** A hash of description and body: approving names it, so a Boton can't swap the body between the owner reading and approving. */
  version: string;
  /** Not approved yet: only the Boton that wrote it (updatedBy) sees and uses it. */
  pending: boolean;
  /** Turned off by the owner: no Boton sees or follows it, and routines that follow it run without it. */
  disabled: boolean;
  /** The package it was installed from, or null for one written here. */
  source: SkillSource | null;
}

/**
 * Where an installed skill came from: a folder in the skill packages folder (BOTONS_HOME/skill-packages). Only its
 * SKILL.md's text is installed, as it was when the owner reviewed it; nothing in the folder is ever run.
 */
export interface SkillSource {
  kind: 'folder';
  folder: string;
  /** The package's own `version:` from SKILL.md, as written there: a label, not checked. */
  label: string | null;
  /** Skill.version of the text installed from it. The skill was changed here since when this isn't Skill.version. */
  installed: string;
  installedAt: string;
  /** SKILL.md fields Botons doesn't use (like allowed-tools), as read: listed for the owner, never granted. */
  fields: Record<string, string>;
  /** The other files its folder held (SkillPackage.otherFiles), as reviewed: never installed. */
  files: string[];
  /** SkillPackage.fingerprint of the package as reviewed and installed: the package is current only while it matches. */
  reviewed: string;
}

/** A package in the skill packages folder, read and checked; nothing installs from one with problems. */
export interface SkillPackage {
  folder: string;
  /**
   * new: no skill has its name. current: the installed skill is what it holds, and the package is as it was reviewed.
   * update: it holds a text that wasn't installed, or its details (version label, fields, other files) changed since
   * it was. changed: it is as it was installed, but the skill was changed here since. conflict: a skill with its name
   * was not installed from it. invalid: it has problems.
   */
  state: 'new' | 'current' | 'update' | 'changed' | 'conflict' | 'invalid';
  problems: string[];
  name: string | null;
  description: string | null;
  body: string | null;
  label: string | null;
  /** The same hash as Skill.version, of its description and body; null when it can't be read. */
  version: string | null;
  /** A hash of all of it the owner reviews: description, procedure, version label, fields and other files; null when it can't be read. */
  fingerprint: string | null;
  fields: Record<string, string>;
  /** Files in the folder besides SKILL.md: never installed, read or run. */
  otherFiles: string[];
  /** What it asks for or points at (fields Botons doesn't grant, sites, Boton commands), one line each. */
  asks: string[];
  /** Of `asks`, the ones the installed skill doesn't have: all of them for a new skill. */
  newAsks: string[];
}

/** A package with what installing it changes: the lines of its description, procedure and details against the skill's. */
export interface SkillPackageReview extends SkillPackage {
  installed: Skill | null;
  /** `details`: its version label, fields and other files, one line each, against those the skill was installed with. */
  diff: { description: DiffLine[]; body: DiffLine[]; details: DiffLine[] };
  /** Who would use it: every Boton, as for SkillAccess. */
  botons: SkillBotonAccess[];
}

export interface DiffLine {
  op: 'same' | 'add' | 'remove';
  text: string;
}

export interface SkillPackagesList {
  /** The folder on the server it reads, for the owner to put package folders in. */
  dir: string;
  exists: boolean;
  packages: SkillPackage[];
}

/**
 * Install or update a skill from its package, exactly as reviewed: `version` and `fingerprint` are the package's,
 * `current` the installed skill's (null for a new one), `accept` the package's newAsks, and `botIds`/`expected` who
 * gets it, as for SkillAccessInput. Anything that changed since is refused with 409 and nothing changes.
 */
export interface InstallSkillInput {
  version: string;
  fingerprint: string;
  current: string | null;
  accept: string[];
  botIds: string[];
  expected: string[];
}

export interface SkillBotonAccess {
  botId: string;
  name: string;
  has: boolean;
  /** Its skills are "every skill, including new ones": taking one away lists every other skill for it instead. */
  every: boolean;
}

export interface SkillAccess {
  name: string;
  botons: SkillBotonAccess[];
}

/** The Botons that should have the skill, exactly; `expected` is who had it as shown (409 if that changed). */
export interface SkillAccessInput {
  botIds: string[];
  expected: string[];
}

/** An earlier text of a skill, kept when it was replaced (newest first, a few per skill). */
export interface SkillHistoryEntry {
  id: number;
  version: string;
  description: string;
  body: string;
  source: SkillSource | null;
  replacedAt: string;
  replacedBy: SkillAuthor;
}

export interface SkillDetails {
  skill: Skill;
  access: SkillAccess;
  history: SkillHistoryEntry[];
  audit: AuditEvent[];
}

export interface CreateSkillInput {
  name: string;
  description: string;
  body: string;
}

export interface UpdateSkillInput {
  description?: string;
  body?: string;
}

// ------------------------------------------------------------------ the sidebar

/**
 * How the owner arranges Botons in the sidebar, the same on every device: GET /api/sidebar, and `sidebar.updated`
 * with the whole layout after every change. Every Boton is in exactly one of `groups[].botIds` and
 * `ungrouped.botIds`, in order; pinning is apart from that: `pinned.botIds` lists the pinned ones in their own order,
 * and each stays in its group too, where unpinning leaves it.
 */
export interface SidebarLayout {
  pinned: SidebarSection;
  groups: SidebarGroup[];
  ungrouped: SidebarSection;
}

export interface SidebarSection {
  collapsed: boolean;
  botIds: string[];
}

export interface SidebarGroup extends SidebarSection {
  id: string;
  name: string;
}

/** The sections that aren't groups. */
export type SidebarSectionKey = 'pinned' | 'ungrouped';

/**
 * `index`, everywhere: the place in the list it moves within or into, counted once it is there (0: first). Missing
 * or past the end: last.
 */
export interface CreateSidebarGroupInput {
  name: string;
  index?: number;
}

/** POST /api/sidebar/groups answers with the new group's id and the layout. */
export interface CreatedSidebarGroup {
  groupId: string;
  layout: SidebarLayout;
}

export interface UpdateSidebarGroupInput {
  name?: string;
  collapsed?: boolean;
}

export interface MoveSidebarGroupInput {
  index?: number;
}

/** groupId null: ungrouped. */
export interface MoveSidebarBotInput {
  groupId: string | null;
  index?: number;
}

export interface PinSidebarBotInput {
  pinned: boolean;
  index?: number;
}

export interface UpdateSidebarSectionInput {
  collapsed: boolean;
}

/**
 * The layout as a file of its own, apart from backups: GET /api/sidebar/export gives it, and POST
 * /api/sidebar/import puts it back, all of it or (on any problem in the file) none of it. Botons are by id: an id
 * with no Boton here is skipped and listed in the answer; a Boton the file doesn't mention keeps its pin and goes
 * last among the ungrouped. Groups are by name (matched as group names are, in any case): a group of the same name
 * keeps its id, the others are made, and a group the file doesn't have is deleted (its Botons are placed as above).
 */
export interface SidebarTransfer {
  format: 'botons-sidebar';
  version: 1;
  /** When it was exported; not read on import. */
  exportedAt?: string;
  pinned: SidebarSection;
  groups: SidebarTransferGroup[];
  ungrouped: SidebarSection;
}

export interface SidebarTransferGroup extends SidebarSection {
  name: string;
}

/** POST /api/sidebar/import answers with the layout and the ids in the file that are no Boton here. */
export interface SidebarImportResult {
  layout: SidebarLayout;
  skipped: string[];
}

/*
 * A portable configuration (format "botons-config"): the owner's deliberate setup, to move to another server or
 * rebuild one: Botons and their routines, skills, connectors, settings and the sidebar. Never a secret, chat,
 * memory, workspace, token, session or sign-in: a full backup (npm run backup) holds those. Its version is its own,
 * apart from the database's schema. Botons are named in it by `ref`, which only the file's other parts use.
 */
export interface PortableConfig {
  format: 'botons-config';
  /** This format's own version, apart from the database schema. Older files are upgraded as they are read: a version-1 file gets no templates and no reaction setting, a version-2 file no spending caps. */
  version: 5;
  exportedAt: string;
  /** The Botons that made it; read for the preview only. */
  source: { app: string; schema: number };
  settings: PortableSettings;
  botons: PortableBoton[];
  skills: PortableSkill[];
  connectors: PortableConnector[];
  /** As GET /api/sidebar/export has it, with Boton refs in place of Boton ids. */
  sidebar: SidebarTransfer;
  /** The owner's saved templates (never the built-in ones). */
  templates: PortableTemplate[];
}

/** A saved template: a New Boton form filled in, with its routines. Nothing in it runs or grants anything until the owner makes a Boton from it. */
export interface PortableTemplate {
  ref: string;
  name: string;
  description: string;
  bot: TemplateBot;
  routines: Omit<TemplateRoutine, 'scheduleText'>[];
}

export interface PortableSettings {
  ownerName: string;
  timezone: string;
  /** A Boton's ref, or null. */
  primaryBoton: string | null;
  ntfy: { enabled: boolean; server: string; topic: string; preview: boolean; tokenLeftOut: boolean };
  /** Settings.reactionFollowUps; null when the file doesn't say (a version-1 file), which keeps this server's. */
  reactionFollowUps: string[] | null;
}

export interface PortableBoton {
  ref: string;
  name: string;
  title: string;
  instructions: string;
  look: BotonLook;
  provider: string;
  model: string;
  effort: string;
  access: AccessLevel;
  timezone: string;
  paused: boolean;
  /** Connector ids ("lib:<name>", "oauth:<name>", the managed browser's). */
  connections: string[];
  /** Skill names, or null for every skill. */
  skills: string[] | null;
  askFirst: string[];
  alwaysAllow: string[];
  /** The managed browser's sites. */
  browserSites: string[];
  /** Its spending cap a day on API-key turns (SpendingView.dailyCapUsd); null for none (and in files before version 3). */
  dailyCapUsd: number | null;
  routines: PortableRoutine[];
}

export interface PortableRoutine extends Omit<TemplateRoutine, 'scheduleText'> {
  /** Whether it was on where it was exported: an imported routine is always off until the owner turns it on. */
  enabled: boolean;
  /** It had a signing secret (webhookSecret) or a callback URL, which the file never holds. */
  webhookSecretLeftOut: boolean;
  callbackLeftOut: boolean;
  /** Its spending cap a run (SpendingView.routines); null for none (and in files before version 3). */
  perRunCapUsd: number | null;
}

export interface PortableSkill {
  name: string;
  description: string;
  body: string;
  disabled: boolean;
  /** Who changed it last: the owner, or a Boton (by ref, null if that Boton isn't in the file), whose skill waits for approval. */
  author: { kind: 'owner' } | { kind: 'boton'; ref: string | null; name: string };
  source: SkillSource | null;
  /** Earlier texts, newest first. */
  history: { description: string; body: string; source: SkillSource | null; replacedAt: string }[];
}

interface PortableConnectorBase {
  id: string;
  name: string;
  onRequest: boolean;
  grant: ConnectorGrant;
  enabled: boolean;
  /** What the export left out of it (a URL's query, an argument that looked like a credential). */
  leftOut: string[];
}

export type PortableConnector =
  | (PortableConnectorBase & {
      kind: 'library';
      transport: 'stdio' | 'http';
      command: string;
      args: string[];
      url: string;
      /** The names its secrets had; never their values. */
      envKeys: string[];
      headerKeys: string[];
    })
  | (PortableConnectorBase & { kind: 'oauth'; url: string; keepConnected: boolean; unknownJobs: 'nowhere' | 'primary' });

/** GET /api/config/export: the file, and what to check before keeping or sharing it. */
export interface PortableExport {
  file: PortableConfig;
  /** Where something left out of the file was (a connector's secrets, a URL query): placeholders stand there. */
  leftOut: string[];
  /** Text the owner wrote that holds something shaped like a credential: the file has it as written. */
  textWarnings: string[];
}

export type PortableBotonAction = 'create' | 'skip';
export type PortableSkillAction = 'create' | 'replace' | 'keep' | 'skip';
export type PortableConnectorAction = 'create' | 'keep' | 'skip';
export type PortableSidebarMode = 'replace' | 'merge' | 'skip';
export type PortableTemplateAction = 'create' | 'skip';
export type PortableCapsChoice = 'file' | 'none';

/** What the owner chose in the preview; anything left out takes the preview's default. */
export interface PortableImportChoices {
  /**
   * `caps`: "file" (the default) gives the new Boton and its routines the file's spending caps; "none" leaves them
   * all out, which only the owner chooses. No choice raises a cap or touches one a Boton here already has.
   */
  botons?: Record<string, { action?: PortableBotonAction; provider?: string; fullAccess?: boolean; alwaysAllow?: boolean; caps?: PortableCapsChoice }>;
  skills?: Record<string, PortableSkillAction>;
  connectors?: Record<string, PortableConnectorAction>;
  /** By template ref. */
  templates?: Record<string, PortableTemplateAction>;
  settings?: boolean;
  sidebar?: PortableSidebarMode;
}

export interface PortableImportInput {
  file: unknown;
  choices?: PortableImportChoices;
  /** PortableImportPreview.fingerprint of the preview the owner confirmed (import only). */
  fingerprint?: string;
}

/** Something to do by hand after an import: a secret to enter, a sign-in, a routine to turn on. */
export interface PortableReconnect {
  kind: 'connector-secret' | 'connector-sign-in' | 'connector-off' | 'connector-left-out' | 'webhook' | 'routine-off' | 'ntfy-token' | 'brain';
  target: string;
  text: string;
}

export interface PortableBotonPlan {
  ref: string;
  name: string;
  action: PortableBotonAction;
  /** An existing Boton has this name. */
  conflict: boolean;
  provider: { file: string; imported: string; available: boolean; options: string[] };
  model: { file: string; imported: string };
  effort: { file: string; imported: string };
  access: { file: AccessLevel; imported: AccessLevel };
  alwaysAllow: { file: string[]; imported: string[] };
  askFirst: string[];
  paused: boolean;
  /** `live`: the imported ones already set up and on here, which the Boton can use at once with this server's secrets or sign-in. */
  connections: { imported: string[]; live: string[]; dropped: { id: string; why: string }[] };
  skills: { imported: string[] | null; dropped: { name: string; why: string }[] };
  browserSites: { imported: string[]; dropped: string[] };
  /**
   * Its spending caps as the file has them and as they will be here (null: no cap). `applies`: its brain here is an
   * API key, the only turns caps count. `unpriced`: a capped chat or routine model has no known price here, so those turns
   * are refused until it is changed. Spending counted where it was exported is never in the file: here it starts at $0.
   */
  caps: { choice: PortableCapsChoice; daily: { file: number | null; imported: number | null }; applies: boolean; unpriced: boolean };
  routines: {
    name: string;
    perRunCap: { file: number | null; imported: number | null };
    /** How its schedule reads, or null for none. */
    schedule: string | null;
    webhook: boolean;
    fullAccessWebhook: { file: boolean; imported: boolean };
    wasEnabled: boolean;
    skill: { file: string | null; imported: string | null };
    model: { file: string | null; imported: string | null };
    effort: { file: string | null; imported: string | null };
  }[];
}

export interface PortableImportPreview {
  source: { format: 'botons-config'; version: number; app: string; schema: number; exportedAt: string };
  /** The file's version when it was older than this server's and was upgraded to read it; null otherwise. */
  upgradedFrom: number | null;
  /** The choices in effect, defaults filled in. */
  choices: Required<PortableImportChoices>;
  /** `notes`: what is kept as this server has it, and why. */
  settings: { apply: boolean; changes: { field: string; from: string; to: string }[]; notes: string[] };
  botons: PortableBotonPlan[];
  skills: { name: string; action: PortableSkillAction; exists: boolean; sameText: boolean; disabled: boolean; pending: boolean; source: string | null; history: number; asks: string[] }[];
  connectors: {
    id: string;
    kind: 'library' | 'oauth';
    name: string;
    action: PortableConnectorAction;
    exists: boolean;
    target: string;
    /** A command that would run in the turns of Botons that have it. */
    runsCommand: boolean;
    secrets: string[];
    leftOut: string[];
    onRequest: boolean;
    grant: ConnectorGrant;
  }[];
  sidebar: { mode: PortableSidebarMode; groups: string[] };
  /** How the file's spending caps arrive, in the owner's words. */
  spending: { notes: string[] };
  templates: {
    ref: string;
    name: string;
    action: PortableTemplateAction;
    /** A saved template here has this name and the same content. */
    same: boolean;
    routines: number;
    /** What the file had that the template here won't: Full computer access, Full access webhook runs, connectors or skills this server won't have, a brain it lacks. */
    narrowed: string[];
  }[];
  textWarnings: string[];
  reconnect: PortableReconnect[];
  /** Send it back with the import: it is refused if anything shown here changed since. */
  fingerprint: string;
}

export interface PortableImportResult {
  /** `caps`: the spending caps it was made with (routines by their new ids). */
  botons: { ref: string; botId: string; name: string; caps: { dailyCapUsd: number | null; routines: { id: string; name: string; perRunCapUsd: number }[] } }[];
  skills: string[];
  connectors: string[];
  /** Names of the templates made. */
  templates: string[];
  settings: boolean;
  sidebar: PortableSidebarMode;
  reconnect: PortableReconnect[];
}

/** GET /api/events: one JSON object per `data:` line; `hello` comes first on every connection. */
export type ServerEvent =
  | { type: 'hello'; serverTime: string; build: string | null }
  | { type: 'ping'; serverTime: string }
  | { type: 'bot.upserted'; bot: Bot }
  | { type: 'bot.deleted'; botId: string }
  | { type: 'bot.status'; botId: string; status: BotStatus }
  | { type: 'message.created'; message: Message }
  /** A message's meta or reactions changed (pinned or unpinned, a card's state, a reaction added or taken off): its text never does. */
  | { type: 'message.updated'; message: Message }
  | { type: 'message.draft'; botId: string; draft: TurnDraft }
  | { type: 'routine.upserted'; routine: Routine }
  | { type: 'routine.deleted'; routineId: string; botId: string }
  | { type: 'run.upserted'; run: RoutineRun }
  | { type: 'memory.upserted'; memory: Memory }
  | { type: 'memory.deleted'; memoryId: string; botId: string }
  | { type: 'settings.updated'; settings: Settings }
  | { type: 'skill.upserted'; skill: Skill }
  | { type: 'skill.deleted'; name: string }
  | { type: 'approval.upserted'; approval: Approval }
  | { type: 'oauth.upserted'; connection: OAuthConnection }
  | { type: 'oauth.deleted'; id: string }
  | { type: 'sidebar.updated'; layout: SidebarLayout }
  | { type: 'api_keys.updated'; view: ApiKeysView };

// ------------------------------------------------------------------ the managed browser

/**
 * The sites one Boton's managed browser may load, set by the owner. Nothing is reachable until a site is listed.
 * "example.com" also covers its subdomains; "host:port" names one address, and is the only way to name a loopback
 * or private one; "*" is any public site, Full computer Botons only. The browser itself is on for a Boton when the
 * owner gives it the Botons browser connector (BROWSER_CONNECTOR in its connectors).
 */
export interface BrowserPolicy {
  sites: string[];
  updatedAt: string | null;
}

export interface BrowserPolicyInput {
  sites?: string[];
}

export interface BrowserStatus {
  botId: string;
  /** The connector that turns it on: in the Boton's connectors, its turns get the browser tools. */
  connectorId: string;
  /** It has the connector, and a brain that can use connectors. */
  enabled: boolean;
  policy: BrowserPolicy;
  /** Whether this server can run a browser at all; `why` says what is missing when it can't. */
  available: boolean;
  why: string | null;
  /** The Chromium it runs, when available. */
  executable: string | null;
  /** Chromium's own sandbox is on (BOTONS_BROWSER_SANDBOX=0 turns it off, where a host can't start it). */
  sandbox: boolean;
  headed: boolean;
  /** Its browser is open now: only during one of its turns. */
  running: boolean;
  /** Whether a Workspace Boton's limits apply to its sites. */
  workspace: boolean;
  /** What the browser can do, in the owner's words: it reads, and sends nothing without the owner's card. */
  capability: string;
  /** Desktop control (screen, mouse and keyboard of the host) is not offered; why. */
  desktop: string;
  /** The owner has the browser now (to sign it in, say): the Boton can't use it until they finish. */
  handover: BrowserHandover | null;
}

/**
 * The owner driving a Boton's browser themselves, from one paired device: started and finished only by the owner,
 * never by a Boton. While it lasts the Boton's browser tools are refused; the profile (and any sign-in) stays theirs.
 */
export interface BrowserHandover {
  /** Sent with each of the owner's inputs, so one meant for a handover that has ended never reaches the next. */
  id: string;
  startedAt: string;
  /** The device that drives it: the only one that gets its view and sends it input (any paired device can end it). */
  byThisDevice: boolean;
  deviceLabel: string;
  /** Where its page is now (origin and path only), once one is open. */
  page: { url: string; title: string } | null;
  /** When it ends on its own if the owner sends nothing more. */
  idleEndsAt: string;
  /** The page's size now (CSS pixels): points are sent in these. */
  viewport: { width: number; height: number };
  /** The Boton's page to go back to (origin and path only; the server opens it in full), or null. */
  resume: string | null;
}

/** What the owner's device asks for as it takes the browser over: its view's size (CSS pixels), for the page to fit. */
export interface BrowserHandoverStart {
  width?: number;
  height?: number;
}

/** The keys the owner can press in a handover (HANDOVER_KEYS in shared/util.ts): never a shortcut with a modifier. */
export type HandoverKey = 'Enter' | 'Tab' | 'Shift+Tab' | 'Backspace' | 'Delete' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Space';

/** One of the owner's inputs in a handover: fixed actions only (no script, no page DOM, no cookies). */
/** Held with a key in a handover: Control only for editing shortcuts, and Meta is Control (a Mac's shortcuts). */
export type HandoverMod = 'Shift' | 'Control' | 'Meta';

/** One of the owner's inputs in a handover. Points are in the page's CSS pixels. */
export type BrowserHandoverInput = { handover: string } & (
  | { action: 'open'; url: string }
  /** The Boton's own page as it handed over (the server keeps its full address; the owner asks for it). */
  | { action: 'resume' }
  | { action: 'click'; x: number; y: number; count?: number }
  | { action: 'down' | 'up'; x: number; y: number; button: 'left' | 'right' | 'middle'; count?: number }
  | { action: 'move'; x: number; y: number }
  | { action: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** Typed into whatever has focus. Never kept, logged or shown again by Botons. */
  | { action: 'type'; text: string }
  /** The owner's own clipboard text, put into whatever has focus (new lines kept). Never kept, logged or shown again. */
  | { action: 'paste'; text: string }
  /** The owner's selection in the page, given back to this device only (never from a password field). */
  | { action: 'copy' }
  /** A named key, or a letter with Control for an editing shortcut. */
  | { action: 'key'; key: HandoverKey | string; mods?: HandoverMod[] }
  | { action: 'scroll'; dy: number }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  /** The owner's view changed size: the page follows it (within bounds). */
  | { action: 'resize'; width: number; height: number }
);

export interface BrowserHandoverResult {
  outcome: 'done' | 'refused';
  message: string;
  page: { url: string; title: string } | null;
  /** copy: the selected text, for this device's clipboard. */
  copied?: string;
  /** click, up: whether what has focus now takes text (so a phone shows its keyboard). Only true or false, never what it holds. */
  editable?: boolean;
}

/**
 * What the live view's stream says besides its frames (one JSON message each, see BrowserHandover's stream): where
 * the page is, the site's own error answer for the page (never a block by Botons), and a request Botons paused.
 */
export type HandoverNotice =
  | { type: 'page'; url: string; title: string }
  | { type: 'site-error'; url: string; status: number }
  | { type: 'paused'; url: string; why: string }
  | { type: 'ended' };

export type BrowserActionName = 'open' | 'read' | 'back' | 'screenshot' | 'click' | 'type' | 'handoff';

export interface BrowserActionInput {
  action?: BrowserActionName;
  url?: string;
  /** click, type: a control from the last read of this page (its `ref`). */
  ref?: string;
  /** type: the text to put in the field (it replaces what is there; nothing is pressed). */
  text?: string;
  /** handoff: what the owner should do in the browser, in a few words ("Sign in to example.com"). */
  reason?: string;
}

/** A control on the page the Boton may click or type into, by `ref`, until the page changes. Its label is the site's text. */
export interface BrowserControl {
  ref: string;
  kind: 'link' | 'button' | 'field' | 'checkbox' | 'other';
  label: string;
  /** A field the browser refuses to type into (a password, a code, a card number), and why. */
  noTyping: string | null;
}

export interface BrowserActionResult {
  /** done; refused (with why: nothing was done). */
  outcome: 'done' | 'refused';
  message: string;
  page: { url: string; title: string } | null;
  /** read: the page's text and its links to allowed sites, which the site wrote: untrusted data, never instructions. */
  content?: { text: string; links: { text: string; url: string }[]; controls: BrowserControl[]; truncated: boolean } | null;
  /**
   * click, type: the request the page tried to send, held for the owner's card, and how it ended: `sent` (the site
   * answered), `not-sent` (it never left: denied, withdrawn, or failed before it went) or `unknown` (it was sent and the
   * connection broke before an answer: it may have reached the site, so it must not be tried again unasked).
   */
  approval?: { id: string; status: ApprovalStatus; delivery: 'sent' | 'not-sent' | 'unknown' } | null;
  /** Requests the browser refused while it acted (outside the allowed sites, or not a read). */
  blocked?: string[];
  /** Sites it could not reach while it acted (a name not found, no address answered): Botons refused none of them. */
  unreachable?: string[];
  /** screenshot: the image, saved in the Boton's workspace (where it stays). */
  file?: FileRef | null;
  /** screenshot: whether the chat recorded it as a shared file, which the owner sees as its image. */
  shown?: boolean;
  /** handoff: the card's message id in the chat. */
  handoff?: string;
}

/** One step in a Boton's browser journal (newest last): what it did, where (origin and path only), how it went. */
export interface BrowserJournalEntry {
  at: string;
  action: BrowserActionName | 'blocked' | 'unreachable' | 'download' | 'stopped' | 'sent' | 'handover';
  url: string;
  outcome: 'done' | 'refused';
  detail: string;
}

/** Metadata only: neither the linked file nor its contents are sent to the browser. */
export interface CodexConfigRepair {
  id: string;
  path: string;
  target: string | null;
  backup: string | null;
  token: string | null;
  problem: string | null;
}

export interface CodexConfigRepairResult extends CodexConfigRepair {
  /** Replacement succeeded, but recording its completion failed. */
  warning?: string;
}

export interface BrainCliInstallReview { provider: 'codex-cli' | 'claude-cli'; command: string; bin: string; available: boolean; reason: string | null }

export interface BrainReleaseStatus {
  installs?: BrainCliInstallReview[];
  installing?: boolean;
  checks: Partial<Record<'claude-cli' | 'codex-cli' | 'botons', { latest: string | null; checkedAt: number; failed: boolean }>>;
  botonsVersion: string | null;
}
