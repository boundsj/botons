import { type ClipboardEvent, type DragEvent, Fragment, memo, type MouseEvent, type Ref, type ReactNode, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundActivity, Bot, Message, ProviderInfo } from '../../../shared/types.ts';
import { backgroundText, quietMessageIds, routineLabel, workLabel } from '../../../shared/wake.ts';
import { BROWSER_CONNECTOR } from '../../../shared/util.ts';
import { api } from '../api.ts';
import { copyText, messageCopyText } from '../copy.ts';
import { attempt, errorText, sendError, showToast } from '../feedback.ts';
import { sharedImage } from '../files.ts';
import { firstUnreadId } from '../lists.ts';
import { brainRest } from '../brains.ts';
import { actions, history, useStore } from '../state.ts';
import { clip, clock, costText, cx, dateTime, dayLabel, duration, localDay, timeMarks, usageText } from '../util.ts';
import { ApprovalCard, DecisionChip, type RowBot, WaitingBar } from './Approvals.tsx';
import { PendingFiles, SentFiles, useAttachments } from './Attachments.tsx';
import { BotonAvatar } from './Avatar.tsx';
import { BrowserButton, HandoffCard } from './BrowserTakeover.tsx';
import { BrainWarning } from './BrainWarning.tsx';
import { useModalOpen } from './Dialog.tsx';
import { AlertIcon, BackIcon, BrainIcon, CheckIcon, ClockIcon, CopyIcon, FileIcon, FolderIcon, PanelIcon, PaperclipIcon, PauseIcon, PinIcon, PlayIcon, SendIcon, StopIcon } from './Icons.tsx';
import { Markdown } from './Markdown.tsx';
import { FollowUpChip, onBubblePress, ReactButton, ReactionBar, ReactionPickerHost } from './Reactions.tsx';
import { useSkillPicker } from './SkillPicker.tsx';
import { messageSteps, StepsToggle } from './Steps.tsx';
import { TranscriptCard } from './TranscriptCard.tsx';

export type PanelTab = 'routines' | 'activity' | 'memory' | 'files' | 'usage' | 'settings';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

const CHIP_LABEL: Record<string, string> = {
  'routine.created': 'Created routine',
  'routine.updated': 'Updated routine',
  'routine.paused': 'Paused routine',
  'routine.resumed': 'Resumed routine',
  'routine.deleted': 'Deleted routine',
  'memory.saved': 'Saved to memory',
  'memory.forgotten': 'Forgot a memory',
  'session.reset': 'Started a fresh conversation',
  'notify.sent': 'Sent a notification',
  'bot.paused': 'Paused',
  'bot.resumed': 'Resumed',
  'file.shared': 'Shared a file',
  'ask.sent': 'Asked',
  'skill.created': 'Saved a skill',
  'skill.updated': 'Updated a skill',
  'approval.auto': 'Allowed without asking',
  'approval.expired': 'Approval request expired',
  'approval.cancelled': 'Withdrew an approval request',
  'connector.granted': 'Got a connector it asked for',
};

function chipQuote(m: Message): string | undefined {
  const meta = m.meta;
  if (!meta) return undefined;
  if (meta.kind === 'connector.reconnect') return meta.connectorId;
  if (meta.kind === 'approval.decided') return meta.note;
  if (meta.kind?.startsWith('approval.')) return meta.approvalTitle;
  return meta.memoryText ?? meta.notifyText ?? meta.askText ?? (meta.skillName ? `/${meta.skillName}` : undefined);
}

async function stopTurn(bot: Bot) {
  let r;
  try {
    r = await api.stopBot(bot.id);
  } catch (e) {
    showToast({ kind: 'error', text: `Couldn't stop ${bot.name}: ${errorText(e)}` }, 8000);
    return;
  }
  if (!r.stopped) {
    showToast({ kind: 'info', text: `${bot.name} had nothing running to stop.` });
    return;
  }
  if (!r.queuedRuns) {
    showToast({ kind: 'info', text: `Stopped ${bot.name}.` });
    return;
  }
  const runs = r.queuedRuns === 1 ? '1 queued routine run' : `${r.queuedRuns} queued routine runs`;
  showToast(
    {
      kind: 'info',
      text: `Stopped ${bot.name}. ${runs} will still run.`,
      action: { label: 'Cancel them', run: () => void cancelQueuedRuns(bot) },
    },
    10_000,
  );
}

async function cancelQueuedRuns(bot: Bot) {
  try {
    const { cancelledRuns } = await api.cancelRuns(bot.id);
    const runs = cancelledRuns === 1 ? '1 queued run' : `${cancelledRuns} queued runs`;
    showToast({ kind: 'info', text: cancelledRuns ? `Cancelled ${runs} of ${bot.name}.` : `${bot.name} had no queued runs left to cancel.` });
  } catch (e) {
    showToast({ kind: 'error', text: `Couldn't cancel the queued runs: ${errorText(e)}` }, 8000);
  }
}

const EMPTY: Message[] = [];

const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;

/** What the view holds steady on: a message row (not a separator or the edge of the history) and where it sits. */
interface Anchor {
  el: Element;
  top: number;
  /** The scroll position the last hold left: the browser scrolls by whole pixels, so the row can sit up to half one off `top`. */
  heldAt?: number;
}

// Day dividers and burst times are worked out from the window, so they come and go as pages are added: never an anchor.
const isRow = (el: Element) => !el.hasAttribute('data-edge') && !el.classList.contains('day-sep') && !el.classList.contains('burst-time') && !el.classList.contains('new-divider');

/** The first row at least partly in view; the rows are a column, so their order is their position. */
function firstVisibleRow(scroller: HTMLElement): Anchor | null {
  const rows = scroller.firstElementChild?.children;
  if (!rows) return null;
  const top = scroller.getBoundingClientRect().top;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < rows.length; i++) if (isRow(rows[i])) return { el: rows[i], top: rows[i].getBoundingClientRect().top - top };
  return null;
}

/** Scroll so the anchor row sits where it was; nothing if it has gone. */
function holdAnchor(scroller: HTMLElement, a: Anchor | null) {
  if (!a?.el.isConnected) return;
  const moved = a.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - a.top;
  if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
  a.heldAt = scroller.scrollTop;
}

/**
 * The row to hold next. While the view is where the last hold left it, the same row keeps the place it was held to,
 * not where whole pixels put it: else each hold's rounding becomes the next one's starting point, and rows of the
 * same fractional height (live messages letting the oldest go, one after another) walk the row away a pixel at a time.
 */
function nextAnchor(scroller: HTMLElement, prev: Anchor | null): Anchor | null {
  const next = firstVisibleRow(scroller);
  if (next && prev && next.el === prev.el && prev.heldAt === scroller.scrollTop) return { ...next, top: prev.top, heldAt: prev.heldAt };
  return next;
}

export function Chat(props: { bot: Bot; covered?: boolean; onOpenPanel: (tab: PanelTab, focus?: string) => void; onOpenBot: (botId: string) => void; onBack: () => void }) {
  const { bot } = props;
  // Behind the panel or a dialog, new replies reach the screen but not the owner.
  const modalOpen = useModalOpen();
  const hidden = !!props.covered || modalOpen;
  const list = useStore((s) => s.messages[bot.id]);
  const messages = list?.items ?? EMPTY;
  // What the server marked quiet (a quiet turn's wake-ups and what it did, read the same way from older history)
  // stays out of the transcript; the window, paging and reading still go by every message loaded.
  const shown = useMemo(() => {
    const quiet = quietMessageIds(messages);
    return quiet.size ? messages.filter((m) => !quiet.has(m.id)) : messages;
  }, [messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  // Rows added or let go above it, and images loading above it, don't move the row being read.
  const anchor = useRef<Anchor | null>(null);
  const dividerEl = useRef<HTMLDivElement>(null);
  // The draft lives in the composer: a keystroke re-renders the composer, not the chat.
  const composer = useRef<ComposerHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const files = useAttachments(bot.id);
  const [dropping, setDropping] = useState(false);

  // The message rows are memoized: they get callbacks that never change and only the parts of the
  // Boton they show, so a status update, a streamed draft or a scroll doesn't re-render them.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const openFile = useCallback((path: string) => latest.current.onOpenPanel('files', path), []);
  const openRoutine = useCallback((id: string) => latest.current.onOpenPanel('routines', id), []);
  const openBot = useCallback((id: string) => latest.current.onOpenBot(id), []);
  const rowBot = useMemo<RowBot>(() => ({ id: bot.id, name: bot.name, workspace: bot.workspace }), [bot.id, bot.name, bot.workspace]);

  // Where the unread messages started when this chat was opened: the "New" divider stays there.
  const [opened, setOpened] = useState<{ botId: string; firstUnread: string | null } | null>(null);
  if (opened?.botId !== bot.id && list && (messages.length > 0 || (!list.loading && !list.error))) {
    setOpened({ botId: bot.id, firstUnread: firstUnreadId(messages, bot.unread) });
  }
  const current = opened?.botId === bot.id ? opened : null;
  // The "New" divider goes above the first message shown from where the unread ones start.
  const dividerId = useMemo(() => {
    const first = current?.firstUnread;
    if (!first || shown === messages || shown.some((m) => m.id === first)) return first ?? null;
    const at = messages.findIndex((m) => m.id === first);
    return at < 0 ? null : (messages.slice(at).find((m) => shown.includes(m))?.id ?? null);
  }, [current?.firstUnread, messages, shown]);
  const positioned = useRef<typeof opened>(null);

  // Before loading: a chat on screen keeps its window, one left keeps only its newest page.
  useEffect(() => {
    actions.openChat(bot.id);
    return () => actions.leaveChat(bot.id);
  }, [bot.id]);
  useEffect(() => {
    if (!list) void actions.loadMessages(bot.id);
  }, [bot.id, list]);
  // Reading back through history: the newest message isn't on screen, so the view doesn't follow it.
  const detached = !!list?.hasNewer;
  useEffect(() => {
    actions.loadApprovals(bot.id).catch(() => {});
  }, [bot.id]);

  const lastId = messages.at(-1)?.id;
  const markIfReading = () => {
    const el = scroller.current;
    if (!el || hidden || detached || !bot.unread || !lastId || !isAtBottom(el)) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    actions.markRead(bot.id, lastId);
  };
  const markRef = useRef(markIfReading);
  useLayoutEffect(() => {
    markRef.current = markIfReading;
  });
  useEffect(() => {
    const check = () => markRef.current();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  useEffect(() => {
    if (!hidden) markRef.current();
  }, [hidden]);

  const rememberAnchor = () => {
    if (scroller.current) anchor.current = nextAnchor(scroller.current, anchor.current);
  };

  // Open a chat at its first unread message, follow new messages at the bottom, and otherwise hold
  // the row being read where it is while pages are added or let go above and below it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (current && positioned.current !== current) {
      positioned.current = current;
      el.scrollTop = el.scrollHeight;
      const divider = dividerEl.current;
      if (divider) {
        const above = divider.getBoundingClientRect().top - el.getBoundingClientRect().top - 72;
        if (above < 0) el.scrollTop += above;
      }
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      holdAnchor(el, anchor.current);
    }
    rememberAnchor();
    const bottom = isAtBottom(el);
    stick.current = bottom && !detached;
    setAtBottom(bottom);
    markIfReading();
    // Live messages took the window past its size: the end farther from the row being read goes (the oldest when
    // following the newest), and holding the anchor above keeps that row in place.
    if (messages.length > history.window) {
      const nearTop = el.scrollTop < el.scrollHeight - el.scrollTop - el.clientHeight;
      actions.keepWindow(bot.id, stick.current || !nearTop ? 'oldest' : 'newest');
    }
  }, [messages, detached, bot.status.state, bot.status.activity, bot.status.draft?.text, current, bot.unread]);

  // The chat resizing without new messages (a bar above the composer, a card or image loading): stay at the
  // bottom, or keep the row being read in place.
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!stick.current) {
        holdAnchor(el, anchor.current);
        anchor.current = nextAnchor(el, anchor.current);
        return;
      }
      el.scrollTop = el.scrollHeight;
      markRef.current();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const loadEarlier = () => {
    rememberAnchor();
    void actions.loadEarlier(bot.id);
  };
  const loadLater = () => {
    rememberAnchor();
    void actions.loadLater(bot.id);
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    // Only scrolling up leaves the bottom: a scroll event can also come from the content growing,
    // and the resize observer puts the view back at the bottom.
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    stick.current = !detached && (bottom || (stick.current && !movedUp));
    rememberAnchor();
    setAtBottom(bottom);
    if (bottom) markIfReading();
    if (!list || list.error) return;
    if (el.scrollTop < 80 && list.hasMore && !list.loadingEarlier) loadEarlier();
    else if (detached && el.scrollHeight - el.scrollTop - el.clientHeight < 80 && !list.loadingLater) loadLater();
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    // The pill goes away with the view at the newest message: the composer is where to carry on.
    if (detached) {
      composer.current?.focus();
      void actions.jumpToLatest(bot.id);
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  const busy = bot.status.state !== 'idle';
  const writing = bot.status.state === 'working' && bot.status.draft?.text ? bot.status.draft : null;
  const allPaused = useStore((s) => s.settings?.paused ?? false);

  return (
    <section
      className="chat"
      aria-label={`Chat with ${bot.name}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        files.add(Array.from(e.dataTransfer.files));
      }}
    >
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <PaperclipIcon size={28} />
          <span>Drop to send to {bot.name}</span>
        </div>
      )}
      <header className="chat-header">
        <button className="icon-btn round mobile-only" aria-label="Back to Botons" onClick={props.onBack}>
          <BackIcon />
        </button>
        <BackgroundLine bot={bot} onOpen={() => props.onOpenPanel('activity')} />
        <button className="title-chip" onClick={() => props.onOpenPanel('settings')} title="Boton settings">
          <BotonAvatar look={bot.look} size={26} seed={bot.id} />
          <span className="title-chip-name">{bot.name}</span>
          {bot.title && <span className="title-chip-role">{bot.title}</span>}
        </button>
        <div className="chat-header-actions">
          <button
            className={cx('icon-btn round', bot.paused && 'on')}
            aria-label={bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`}
            title={bot.paused ? 'Resume' : 'Pause'}
            onClick={() => void attempt(bot.paused ? `resume ${bot.name}` : `pause ${bot.name}`, () => actions.pauseBot(bot.id, !bot.paused))}
          >
            {bot.paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          {bot.connections.includes(BROWSER_CONNECTOR) && <BrowserButton bot={bot} />}
          <button className="icon-btn round" aria-label="Routines" title="Routines" onClick={() => props.onOpenPanel('routines')}>
            <ClockIcon />
          </button>
          <button className="icon-btn round" aria-label="Memory" title="Memory" onClick={() => props.onOpenPanel('memory')}>
            <BrainIcon />
          </button>
          <button className="icon-btn round" aria-label="Files" title="Files" onClick={() => props.onOpenPanel('files')}>
            <FolderIcon />
          </button>
          <button className="icon-btn round" aria-label="Boton settings" title="Settings" onClick={() => props.onOpenPanel('settings')}>
            <PanelIcon />
          </button>
        </div>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner">
          {list?.loading && !messages.length && (
            <p className="muted center" data-edge="">
              Loading…
            </p>
          )}
          {list?.error?.retry === 'earlier' && <ChatLoadError bot={bot} error={list.error.message} />}
          {list?.hasMore && !list.error && (
            <div className="history-edge" data-edge="">
              <button className="load-earlier" disabled={list.loadingEarlier} onClick={loadEarlier}>
                {list.loadingEarlier ? 'Loading…' : 'Load earlier messages'}
              </button>
              {/* The page holds a window of the history, so the browser's find sees only what is loaded. */}
              <p className="history-note">Find in page searches only the messages loaded here.</p>
            </div>
          )}
          {list && !list.loading && !list.error && messages.length === 0 && <Welcome bot={bot} onPick={(t) => composer.current?.setDraft(t)} />}
          {shown.map((m, i) => {
            const prev = shown[i - 1];
            // From the window loaded: the first message loaded gets its day and time, whatever came before it.
            const marks = timeMarks(prev?.createdAt, m.createdAt);
            return (
              <Fragment key={m.id}>
                {marks.day && (
                  <div className="day-sep">
                    <time dateTime={localDay(m.createdAt)}>{dayLabel(m.createdAt)}</time>
                  </div>
                )}
                {m.id === dividerId && (
                  <div className="new-divider" ref={dividerEl} role="separator" aria-label="New messages">
                    <span>New</span>
                  </div>
                )}
                {marks.time && !showsOwnTime(m) && (
                  <time className="burst-time" dateTime={m.createdAt} title={dateTime(m.createdAt)}>
                    {clock(m.createdAt)}
                  </time>
                )}
                <MessageView bot={rowBot} m={m} grouped={grouped(prev, m)} onOpenRoutine={openRoutine} onOpenFile={openFile} onOpenBot={openBot} />
              </Fragment>
            );
          })}
          {detached && !list?.error && (
            <div className="history-edge" data-edge="">
              <button className="load-later" disabled={list?.loadingLater} onClick={loadLater}>
                {list?.loadingLater ? 'Loading…' : 'Load newer messages'}
              </button>
            </div>
          )}
          {(list?.error?.retry === 'latest' || list?.error?.retry === 'later') && <ChatLoadError bot={bot} error={list.error.message} />}
          {writing && (
            <div className="msg bot draft">
              <div className="bubble" aria-busy="true">
                <Markdown text={writing.text} />
              </div>
              <span className="draft-status" aria-live="polite">
                <Thinking bot={bot} />
                <span className="typing-text">{bot.status.activity ?? 'Writing'}…</span>
              </span>
            </div>
          )}
          {busy && !writing && (
            <div className="msg bot typing" aria-live="polite">
              <div className="bubble">
                <Thinking bot={bot} />
                <span className="typing-text">{bot.status.state === 'queued' ? 'Up next' : (bot.status.activity ?? 'Thinking')}…</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="pill-anchor">
        {(detached || (!atBottom && bot.unread > 0)) && (
          <button className="new-pill" onClick={jumpToLatest}>
            {bot.unread > 0 ? `${bot.unread} new` : 'Jump to latest'} <span aria-hidden="true">↓</span>
          </button>
        )}
      </div>
      <ReactionPickerHost bot={rowBot} />
      <WaitingBar bot={bot} />
      {(bot.paused || allPaused) && <PausedBanner bot={bot} all={allPaused} />}
      <Composer ref={composer} bot={bot} files={files} busy={busy} onSent={() => (stick.current = true)} />
    </section>
  );
}

/** "10:42", or "Yesterday 10:42" for an earlier day. */
const whenText = (iso: string) => (dayLabel(iso) === 'Today' ? clock(iso) : `${dayLabel(iso)} ${clock(iso)}`);

/**
 * Desktop only, in the header's free corner: what the Boton did on its own lately, quiet turns included (they leave
 * nothing in the chat), opening the Activity tab that lists each with its quiet note and steps. Read again when a
 * turn ends and every minute.
 */
function BackgroundLine({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const [data, setData] = useState<{ botId: string; a: BackgroundActivity } | null>(null);
  const idle = bot.status.state === 'idle';
  const lastAt = bot.lastMessage?.createdAt;
  useEffect(() => {
    let live = true;
    const load = () =>
      api.background(bot.id).then(
        (a) => live && setData({ botId: bot.id, a }),
        () => {},
      );
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bot.id, idle, lastAt]);
  const a = data?.botId === bot.id ? data.a : null;
  const text = a ? backgroundText(a, whenText) : null;
  if (!a || !text) return null;
  return (
    <button
      type="button"
      className="background-line desktop-only"
      onClick={onOpen}
      title={`Routines, webhooks, connector updates, other Botons and follow-ups that woke ${bot.name}. A quiet one posts nothing in the chat; open Activity for each one and its note. Latest: ${dateTime(a.lastAt!)}`}
    >
      <ClockIcon size={13} />
      <span>{text}</span>
    </button>
  );
}

/** The Boton itself, small, with its thinking ring, beside the words that say what it is doing (decorative: the words carry it). */
const Thinking = ({ bot }: { bot: Pick<Bot, 'look' | 'id'> }) => (
  <span className="typing-boton" aria-hidden="true">
    <BotonAvatar look={bot.look} size={26} state="working" seed={bot.id} />
  </span>
);

function PausedBanner({ bot, all }: { bot: Bot; all: boolean }) {
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    setBusy(true);
    await attempt(all ? 'resume all Botons' : `resume ${bot.name}`, () => (all ? actions.pauseAll(false) : actions.pauseBot(bot.id, false)));
    setBusy(false);
  };
  return (
    <div className="paused-banner" role="status">
      <PauseIcon size={16} />
      <span>
        <strong>{all ? 'All Botons are paused.' : `${bot.name} is paused.`}</strong> Nothing runs, and messages wait, until you resume.
      </span>
      <button className="btn small" disabled={busy} onClick={() => void resume()}>
        <PlayIcon size={14} /> {all ? 'Resume all' : 'Resume'}
      </button>
    </div>
  );
}

function ChatLoadError({ bot, error }: { bot: Bot; error: string }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="chat-load-error" role="alert" data-edge="">
      <AlertIcon size={16} className="error-icon" />
      <span>Couldn't load messages: {error}</span>
      <button
        className="btn small"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          await actions.retryMessages(bot.id);
          setRetrying(false);
        }}
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

const author = (m: Message) => (m.meta?.fromBotId ? `boton:${m.meta.fromBotId}` : m.meta?.kind === 'reaction.followup' ? 'chip' : m.role);
/** Close to the one before it, by the same author: no gap. A boolean, so a change to the row before (a reaction, a pin) doesn't re-render this one. */
const grouped = (prev: Message | undefined, m: Message) => !!prev && author(prev) === author(m) && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 120_000;

interface RowProps {
  bot: RowBot;
  m: Message;
  grouped: boolean;
  onOpenRoutine: (id: string) => void;
  onOpenFile: (path: string) => void;
  onOpenBot: (id: string) => void;
}

/** Another Boton a row names, by id: only its name and look, so its turns don't re-render the row. */
function useBoton(id: string | undefined) {
  const name = useStore((s) => (id ? s.bots.find((b) => b.id === id)?.name : undefined));
  const look = useStore((s) => (id ? s.bots.find((b) => b.id === id)?.look : undefined));
  return id && name !== undefined && look ? { id, name, look } : undefined;
}

/** A run's chip (a routine's, a webhook's, a work update's) shows its own time, so no time goes above it. */
const showsOwnTime = (m: Message) => (m.role === 'event' && m.meta?.kind === 'routine.run') || (m.role === 'user' && (m.meta?.kind === 'work.event' || m.meta?.kind === 'connector.granted'));

/** A message's exact time and date: always there for a screen reader, shown on hover, focus or a tap on the message. */
const MessageTime = ({ iso }: { iso: string }) => (
  <time className="msg-time" dateTime={iso}>
    {dateTime(iso)}
  </time>
);

/** A run chip's time, beside its label. */
const ChipTime = ({ iso }: { iso: string }) => (
  <time className="chip-time" dateTime={iso}>
    {clock(iso)}
  </time>
);

/**
 * A tap (or pen) on a message, anywhere but a link, a button or a field, shows its exact time until the next tap; a
 * mouse has hover for that. Selecting text shows nothing. One row's state, so only that row re-renders.
 */
function useTimeReveal() {
  const [shown, setShown] = useState(false);
  const onClick = useCallback((e: MouseEvent<HTMLElement>) => {
    if ((e.nativeEvent as PointerEvent).pointerType === 'mouse') return;
    if ((e.target as Element).closest('a, button, input, textarea, select, summary, label, [role="button"]')) return;
    if (getSelection()?.toString()) return;
    setShown((v) => !v);
  }, []);
  return { shown, onClick };
}

const MessageView = memo(function MessageView({ bot, m, grouped, onOpenRoutine, onOpenFile, onOpenBot }: RowProps) {
  // Before any return, so every row calls the same hooks whichever way it renders.
  const reveal = useTimeReveal();
  const timed = (content: ReactNode) => (
    <div className={cx('timed-row', reveal.shown && 'show-time')} onClick={reveal.onClick} title={dateTime(m.createdAt)}>
      {content}
      <MessageTime iso={m.createdAt} />
    </div>
  );
  if (m.role === 'event' && m.meta?.kind === 'approval.requested') return timed(<ApprovalCard bot={bot} m={m} onOpenRoutine={onOpenRoutine} />);
  if (m.role === 'event' && m.meta?.kind === 'browser.handoff') return timed(<HandoffCard bot={bot} m={m} />);
  if (m.role === 'user' && m.meta?.kind === 'browser.handed_back') {
    return timed(
      <div className="event-chip wake-label" title={dateTime(m.createdAt)}>
        <span>You handed the browser back</span>
        <ChipTime iso={m.createdAt} />
      </div>
    );
  }
  if (m.role === 'event' && m.meta?.kind === 'card.posted') return timed(<TranscriptCard bot={bot} m={m} onOpenFile={onOpenFile} onOpenRoutine={onOpenRoutine} />);
  // A decision is a chip: the user message that starts the follow-up turn, or an event (a skill's says what it did in its text).
  if (m.meta?.kind === 'approval.decided' && (m.role === 'user' || (m.role === 'event' && !m.meta.skillName))) return timed(<DecisionChip m={m} />);
  if (m.role === 'user' && m.meta?.kind === 'reaction.followup') return timed(<FollowUpChip m={m} bot={bot} />);
  // Written by the server to start a turn, not by you.
  if (m.role === 'user' && m.meta?.kind === 'work.event') {
    const link = m.meta.work?.link?.startsWith('https://') ? m.meta.work.link : null;
    const label = workLabel(m.meta.work);
    return timed(
      <div className={cx('event-chip wake-label', label.warn && 'warn')} title={`${label.detail} · ${dateTime(m.createdAt)}`}>
        <span>{label.text}</span>
        <ChipTime iso={m.createdAt} />
        {link && (
          <a href={link} target="_blank" rel="noreferrer noopener">
            Open
          </a>
        )}
      </div>
    );
  }
  if (m.role === 'user' && m.meta?.kind === 'connector.granted') {
    // The server's own words ("Connector fleet added"); an older one may say less.
    const text = /^Connector .{1,80} added$/.test(m.text) ? m.text : CHIP_LABEL['connector.granted'];
    return timed(
      <div className="event-chip wake-label" title={`${m.meta.connectorId ?? ''} · ${dateTime(m.createdAt)}`}>
        <span>{text}</span>
        <ChipTime iso={m.createdAt} />
      </div>
    );
  }
  if (m.role === 'event') return timed(<EventChip bot={bot} m={m} onOpenRoutine={onOpenRoutine} onOpenFile={onOpenFile} onOpenBot={onOpenBot} />);
  // Another Boton's ask, or its reply to this Boton's ask: never shown as the owner's.
  if (m.role === 'user' && m.meta?.fromBotId) return <BotonMessage m={m} grouped={grouped} onOpenBot={onOpenBot} />;
  const meta = turnText(m);
  const attached = m.meta?.attachments ?? [];
  return (
    <div className={cx('msg', m.role, grouped && 'grouped', reveal.shown && 'show-time')} onClick={reveal.onClick}>
      {m.meta?.kind === 'provider.summary' && <div className="msg-from">Summary for the move, from its session on {m.meta.providerLabel ?? 'the provider before'}</div>}
      {attached.length > 0 && <SentFiles bot={bot} files={attached} onOpen={onOpenFile} />}
      {(m.text || !attached.length) && (
        <div className="bubble" title={`${dateTime(m.createdAt)}${meta}`} onPointerDown={m.role === 'bot' ? (e) => onBubblePress(e, m) : undefined}>
          {m.role === 'error' && <AlertIcon size={16} className="error-icon" />}
          {m.role === 'user' ? (
            <p className="plain">{m.text}</p>
          ) : (
            <Markdown text={m.text} botId={bot.id} workspace={bot.workspace} onOpenFile={m.role === 'bot' ? onOpenFile : undefined} />
          )}
        </div>
      )}
      <ReactionBar m={m} bot={bot} />
      {!!m.meta?.steps && <StepsToggle count={m.meta.steps} load={messageSteps(m.id)} />}
      <div className="msg-foot">
        <MessageTime iso={m.createdAt} />
        <CopyButton m={m} />
        {m.role === 'bot' && <ReactButton m={m} bot={bot} />}
        {(m.role === 'user' || m.role === 'bot') && <PinButton m={m} />}
      </div>
    </div>
  );
});

const COPIED_MS = 1500;

/**
 * Copies the message as written (Markdown for a Boton, plain text for the owner), never its attachments, and says
 * Copied for a moment, to a screen reader too. Its own state, so a copy re-renders only the button.
 */
function CopyButton({ m }: { m: Message }) {
  const text = messageCopyText(m);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (text === null) return null;
  const onCopy = async () => {
    clearTimeout(timer.current);
    if (!(await copyText(text))) {
      setCopied(false);
      showToast({ kind: 'error', text: "Couldn't copy the message. Select its text and copy it instead." }, 6000);
      return;
    }
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <span className={cx('msg-copy', copied && 'done')}>
      <button type="button" className="msg-copy-btn" aria-label="Copy message" title="Copy" onClick={() => void onCopy()}>
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
      <span className="msg-copy-status" role="status" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}

/**
 * Pins a message for every new session the Boton starts (after a restart or a move to another provider), whatever
 * its age, up to a bound (a longer one is given as its start and end): the server keeps a few and refuses one more,
 * saying why. Starting the chat fresh takes the pins off.
 */
function PinButton({ m }: { m: Message }) {
  const pinned = !!m.meta?.pinned;
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    await attempt(pinned ? 'unpin it' : 'pin it', () => actions.pinMessage(m, !pinned));
    setBusy(false);
  };
  return (
    <button
      type="button"
      className={cx('msg-pin', pinned && 'on')}
      aria-pressed={pinned}
      aria-label={pinned ? 'Pinned' : 'Pin'}
      disabled={busy}
      onClick={() => void toggle()}
      title={
        pinned
          ? 'Pinned: every new session is given this message, whatever its age (a long one as its start and end only). Click to unpin.'
          : 'Pin it: every new session is given this message, whatever its age (a long one as its start and end only)'
      }
    >
      <PinIcon size={13} />
      <span className="msg-pin-label">{pinned ? 'Pinned' : 'Pin'}</span>
    </button>
  );
}

/** A routine run's label above its reply: "Routine:" and the routine, which opens it. */
function RunLabel({ m, onOpenRoutine }: { m: Message; onOpenRoutine: (id: string) => void }) {
  const label = routineLabel(m.meta);
  const name = m.meta?.routineName?.trim();
  return (
    <div className="event-chip wake-label" title={`${label.detail} · ${dateTime(m.createdAt)}`}>
      <span>Routine:</span>
      {name ? (
        <button className="chip-link" aria-label={label.text} onClick={() => m.meta?.routineId && onOpenRoutine(m.meta.routineId)} disabled={!m.meta?.routineId}>
          {label.text.slice('Routine: '.length)}
        </button>
      ) : (
        <span>{label.text.slice('Routine: '.length)}</span>
      )}
      <ChipTime iso={m.createdAt} />
    </div>
  );
}

function EventChip({ bot, m, onOpenRoutine, onOpenFile, onOpenBot }: Omit<RowProps, 'grouped'>) {
  if (m.meta?.kind === 'routine.run') return <RunLabel m={m} onOpenRoutine={onOpenRoutine} />;
  return <OtherEventChip bot={bot} m={m} onOpenRoutine={onOpenRoutine} onOpenFile={onOpenFile} onOpenBot={onOpenBot} />;
}

function OtherEventChip({ bot, m, onOpenRoutine, onOpenFile, onOpenBot }: Omit<RowProps, 'grouped'>) {
  const image = sharedImage(m);
  const to = useBoton(m.meta?.kind === 'ask.sent' ? m.meta.toBotId : undefined);
  const label = m.meta?.kind === 'notify.sent' && m.meta.priority === 'high' ? 'Sent an urgent notification' : (CHIP_LABEL[m.meta?.kind ?? ''] ?? m.text);
  const quote = chipQuote(m);
  return (
    <div className={cx('event-chip', (m.meta?.kind === 'ask.refused' || m.meta?.kind === 'approval.expired' || m.meta?.kind === 'instructions.restored' || m.meta?.kind === 'connector.reconnect') && 'warn')} title={quote ?? dateTime(m.createdAt)}>
      <span>{label}</span>
      {to && (
        <button className="chip-link" onClick={() => onOpenBot(to.id)} title={`Open ${to.name}'s chat`}>
          <BotonAvatar look={to.look} size={16} />
          {to.name}
        </button>
      )}
      {m.meta?.routineName && (
        <button
          className="chip-link"
          disabled={!m.meta.routineId || m.meta.kind === 'routine.deleted'}
          onClick={() => m.meta?.routineId && onOpenRoutine(m.meta.routineId)}
        >
          <ClockIcon size={14} />
          {m.meta.routineName}
        </button>
      )}
      {m.meta?.file && (
        <button className="chip-link" title={m.meta.file.path} onClick={() => onOpenFile(m.meta!.file!.path)}>
          <FileIcon size={14} />
          {m.meta.file.title || m.meta.file.name}
        </button>
      )}
      {quote && <span className="chip-quote">“{clip(quote, 60)}”</span>}
      {(m.meta?.kind === 'turn.stopped' || m.meta?.kind === 'turn.interrupted') && !!m.meta.steps && <StepsToggle count={m.meta.steps} load={messageSteps(m.id)} />}
      {image && (
        <div className="chip-image">
          <SentFiles bot={bot} files={[image]} onOpen={onOpenFile} />
        </div>
      )}
    </div>
  );
}

function BotonMessage({ m, grouped, onOpenBot }: { m: Message; grouped: boolean; onOpenBot: (id: string) => void }) {
  const sender = useBoton(m.meta?.fromBotId);
  const name = sender?.name ?? m.meta?.fromBotName ?? 'Another Boton';
  const reveal = useTimeReveal();
  return (
    <div className={cx('msg Boton', grouped && 'grouped', reveal.shown && 'show-time')} onClick={reveal.onClick}>
      {!grouped && (
        <div className="msg-from">
          {sender ? (
            <button className="chip-link" onClick={() => onOpenBot(sender.id)} title={`Open ${name}'s chat`}>
              <BotonAvatar look={sender.look} size={18} />
              {name}
            </button>
          ) : (
            <span>{name}</span>
          )}
          <span className="muted">{m.meta?.kind === 'ask.reply' ? 'replied to the ask' : 'asks'}</span>
        </div>
      )}
      <div className="bubble" title={`${dateTime(m.createdAt)} · from ${name}, another Boton`}>
        <Markdown text={m.text} />
      </div>
      <div className="msg-foot">
        <MessageTime iso={m.createdAt} />
        <CopyButton m={m} />
      </div>
    </div>
  );
}

function turnText(m: Message): string {
  const parts: string[] = [];
  if (m.meta?.durationMs) parts.push(duration(m.meta.durationMs));
  if (m.meta?.model) parts.push(m.meta.model);
  if (m.meta?.usage) parts.push(usageText(m.meta.usage));
  if (m.meta?.usage?.costUsd) parts.push(costText(m.meta.usage.costUsd));
  // An answer that broke off is counted at the most it could have cost: the provider may have billed it.
  if (m.meta?.usage?.costHeldUsd) parts.push(`${costText(m.meta.usage.costHeldUsd)} of it held for an answer that broke off`);
  return parts.map((p) => ` · ${p}`).join('');
}

function Welcome({ bot, onPick }: { bot: Bot; onPick: (t: string) => void }) {
  const ideas = [
    'What can you help me with?',
    'Every weekday at 8am, send me a short briefing on the top tech news.',
    bot.access === 'host' ? 'How much free disk space does this computer have?' : 'What files are in your workspace?',
  ];
  // A Boton whose brain can't think now greets you asleep, and says why: where to give it one, or when its limit resets.
  const restOf = (s: { providers: ProviderInfo[] }) => (s.providers.length ? brainRest(s.providers.find((p) => p.id === bot.provider)) : null);
  const restKind = useStore((s) => restOf(s)?.kind ?? null);
  const restUntil = useStore((s) => { const r = restOf(s); return r?.kind === 'limited' ? r.until : null; });
  return (
    <div className="welcome">
      <BotonAvatar look={bot.look} size={112} seed={bot.id} state={restKind ? 'asleep' : 'idle'} />
      <h1>{bot.name}</h1>
      {bot.title && <p className="muted">{bot.title}</p>}
      {restKind === 'limited' ? (
        <p className="welcome-copy">
          {bot.name}'s brain is at its usage limit{restUntil ? ` until ${dateTime(restUntil)}` : ''}. It resets by itself; messages wait until then.
        </p>
      ) : restKind ? (
        <p className="welcome-copy">{bot.name} has no working brain yet. Give it one in Settings → Brains, and it wakes up.</p>
      ) : (
        <p className="welcome-copy">Tell {bot.name} what to own. Ask for a routine in plain words and it will set one up.</p>
      )}
      <div className="ideas">
        {ideas.map((t) => (
          <button key={t} className="idea" onClick={() => onPick(t)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ComposerHandle {
  setDraft: (text: string) => void;
  focus: () => void;
}

function Composer(props: { ref: Ref<ComposerHandle>; bot: Bot; files: ReturnType<typeof useAttachments>; busy: boolean; onSent: () => void }) {
  const { bot, files } = props;
  const [draft, setDraft] = useState('');
  useImperativeHandle(props.ref, () => ({ setDraft, focus: () => ref.current?.focus() }), []);
  // Another Boton's chat starts with an empty composer.
  useEffect(() => {
    setDraft('');
  }, [bot.id]);
  const providers = useStore((s) => s.providers);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ text: string; offline: boolean } | null>(null);
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    if (connected) setError((e) => (e?.offline ? null : e));
  }, [connected]);
  const skillPicker = useSkillPicker(bot, draft, setDraft);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) ref.current?.focus();
  }, [bot.id]);

  const workspaceProblem = bot.access === 'workspace' ? providers.find(p => p.id === bot.provider)?.workspaceProblem : null;
  const canSend = !workspaceProblem && (!!draft.trim() || files.ready.length > 0) && !files.busy && !sending;

  const send = async () => {
    const text = draft.trim();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await actions.send(bot.id, text, files.ready);
      setDraft('');
      files.clear();
      props.onSent();
    } catch (e) {
      setError(sendError(e));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  // Pasted text stays text, even when an image comes with it.
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (!pasted.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    files.add(pasted);
  };

  return (
    <div className="composer-wrap">
      {workspaceProblem && <div className="hint" role="status"><strong>Can't run sandboxed on this server</strong><p>{workspaceProblem}</p><button className="btn small" type="button" disabled={sending} onClick={async () => { setSending(true); try { await actions.updateBot(bot.id, { access: 'host' }); } catch (e) { setError(sendError(e)); } finally { setSending(false); } }}>Switch to Full computer</button></div>}
      <BrainWarning providers={providers} provider={bot.provider} />
      {error && <p className="composer-error" role="alert">{error.text}</p>}
      <PendingFiles items={files.items} onRemove={files.remove} />
      {skillPicker.menu}
      <span className="sr-only" role="status">
        {skillPicker.announce}
      </span>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {/* No `accept`: on a phone the picker offers the camera, the photo library and files. */}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            files.add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <button type="button" className="icon-btn round attach-btn" aria-label="Attach files" title="Attach files or photos" onClick={() => picker.current?.click()}>
          <PaperclipIcon />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          placeholder={`Message ${bot.name} (/ for skills)`}
          aria-label={`Message ${bot.name}`}
          {...skillPicker.inputProps}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && skillPicker.onKey(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {props.busy && (
          <button type="button" className="icon-btn round stop-btn" aria-label="Stop" title="Stop" onClick={() => void stopTurn(bot)}>
            <StopIcon />
          </button>
        )}
        <button
          type="submit"
          className="icon-btn round send-btn"
          aria-label="Send"
          title={files.busy ? 'Waiting for the files to upload' : 'Send (Enter)'}
          disabled={!canSend}
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
