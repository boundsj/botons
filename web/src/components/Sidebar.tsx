import { ThemeSetting } from './ThemeSetting.tsx';
import { Logo } from './Brand.tsx';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, SidebarLayout } from '../../../shared/types.ts';
import { attachSidebarDrag, type DragKind } from '../drag.ts';
import { attempt } from '../feedback.ts';
import { applyDrop, type Arranged, arrange, changesNothing, type Drop, search, type Section, stepIndex, type Summary, summarize, summaryText } from '../sidebar.ts';
import { actions, useStore } from '../state.ts';
import { cx, initials } from '../util.ts';
import { type BrainRest, brainRest, restText } from '../brains.ts';
import { useWaiting } from './Approvals.tsx';
import { avatarState, BotonAvatar } from './Avatar.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { BookIcon, ChevronIcon, CloseIcon, GearIcon, MoreIcon, PauseIcon, PlayIcon, PlusIcon, SearchIcon, ShieldIcon, StarIcon } from './Icons.tsx';
import { type MenuEntry, MenuButton } from './Menu.tsx';

function preview(bot: Bot, rest: BrainRest | null = null): string {
  if (bot.status.state === 'working') return bot.status.activity ? `${bot.status.activity}…` : 'Working…';
  if (bot.status.state === 'queued') return 'Up next…';
  if (bot.paused) return 'Paused';
  // The sleeping avatar says the same; words make sure it is never the only sign.
  if (rest) return restText(rest);
  if (!bot.lastMessage) return bot.title || 'New Boton';
  const prefix = bot.lastMessage.from ? `${bot.lastMessage.from}: ` : bot.lastMessage.role === 'user' ? 'You: ' : bot.lastMessage.role === 'error' ? 'Error: ' : '';
  const plain = bot.lastMessage.text
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(#+|>|[-*])\s+/gm, '')
    .replace(/\s+/g, ' ');
  // Only a message with files has no text.
  return prefix + (plain || (bot.lastMessage.role === 'user' ? 'Sent a file' : ''));
}

type GroupDialog =
  | { kind: 'create'; /** Move this Boton into the new group. */ moving?: Bot }
  | { kind: 'rename'; groupId: string; name: string }
  | { kind: 'delete'; groupId: string; name: string; count: number };

/** Focus the first of these that is on the page, once a change has rendered, unless the owner has moved on. */
function refocus(...selectors: string[]) {
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    for (const s of selectors) {
      const el = document.querySelector<HTMLElement>(s);
      if (el) return el.focus();
    }
  });
}
const rowMenu = (section: string, botId: string) => `[data-menu="${CSS.escape(`${section}:${botId}`)}"] button`;
const sectionToggle = (key: string) => `[data-section="${CSS.escape(key)}"]`;

export function Sidebar(props: { selectedId: string | null; onSelect: (id: string) => void; onNew: (groupId?: string) => void; onSettings: () => void; onSkills: () => void }) {
  const bots = useStore((s) => s.bots);
  const layout = useStore((s) => s.sidebar);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  // Why each brain can't think now, or null before they have loaded. A Boton on one that can't (missing, signed out,
  // at a usage limit) is drawn asleep, and says why. Only the providers make a new map, so a chat update re-renders one row.
  const brainRests = useMemo(() => (providers.length ? new Map(providers.map((p) => [p.id, brainRest(p)])) : null), [providers]);
  const allPaused = settings?.paused ?? false;
  const primaryId = settings?.primaryBotId ?? null;
  const [pausing, setPausing] = useState(false);
  const togglePauseAll = async () => {
    setPausing(true);
    await attempt(allPaused ? 'resume all Botons' : 'pause all Botons', () => actions.pauseAll(!allPaused));
    setPausing(false);
  };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<GroupDialog | null>(null);
  const waiting = useWaiting();
  const waitingFor = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of waiting) n.set(a.botId, (n.get(a.botId) ?? 0) + 1);
    return n;
  }, [waiting]);
  const waitingNames = [...new Set(waiting.map((a) => bots.find((b) => b.id === a.botId)?.name).filter(Boolean))];

  // A drop shows at once, as the server will answer it; the next layout from the server (its answer, or another
  // device's change) replaces it, and a refused drop puts the old one back.
  const [dropped, setDropped] = useState<{ on: SidebarLayout; layout: SidebarLayout } | null>(null);
  const shown = dropped && dropped.on === layout ? dropped.layout : layout;
  const arranged = useMemo(() => arrange(shown, bots), [shown, bots]);
  const results = useMemo(() => search(arranged, query), [arranged, query]);
  const searchingFor = query.trim() !== '';

  // Drag to arrange: rows, pinned tiles and group heads, with a mouse or a long press (see drag.ts). Only the start
  // and end of a drag render, so the places to drop that exist only while dragging can show.
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const announce = (text: string) => {
    if (said.current) said.current.textContent = text;
  };
  const drop = (d: Drop) => {
    // From what is on screen, so a drop made before the last one's answer builds on it.
    const l = shown;
    if (!l || !layout || changesNothing(l, d)) return announce('Nothing moved.');
    const a = now.current;
    const nameOf = (id: string) => bots.find((b) => b.id === id)?.name ?? 'the Boton';
    const where = d.kind === 'pin' ? 'Pinned' : d.kind === 'bot' ? (d.groupId === null ? 'Ungrouped' : (a.groups.find((g) => g.groupId === d.groupId)?.name ?? 'the group')) : '';
    const what = d.kind === 'group' ? `move ${a.groups.find((g) => g.groupId === d.groupId)?.name ?? 'the group'}` : `move ${nameOf(d.botId)} to ${where}`;
    setDropped({ on: layout, layout: applyDrop(l, d) });
    announce(d.kind === 'group' ? `Moved group to position ${d.index + 1}.` : `Moved ${nameOf(d.botId)} to ${where}.`);
    void attempt(what, () =>
      d.kind === 'group' ? actions.sidebar.moveGroup(d.groupId, d.index) : d.kind === 'pin' ? actions.sidebar.pin(d.botId, true, d.index) : actions.sidebar.moveBot(d.botId, d.groupId, d.index),
    ).then(() => setDropped(null));
  };
  const handlers = useRef({ onStart: setDragging, onEnd: () => setDragging(null), onDrop: drop, announce });
  handlers.current = { onStart: setDragging, onEnd: () => setDragging(null), onDrop: drop, announce };
  const canDrag = !!layout && !searchingFor;
  useEffect(() => {
    if (!canDrag || !navRef.current) return;
    return attachSidebarDrag(navRef.current, () => handlers.current);
  }, [canDrag]);

  // Row menus read the arrangement as it is when they open, so a row re-renders only when its own Boton changes.
  const now = useRef(arranged);
  now.current = arranged;
  const entriesFor = useCallback((sectionKey: string, bot: Bot): MenuEntry[] => menuEntries(now.current, sectionKey, bot, (moving) => setDialog({ kind: 'create', moving })), []);

  const toggle = (s: Section) => {
    void attempt(s.collapsed ? `expand ${s.name}` : `collapse ${s.name}`, () =>
      actions.sidebar.collapse(s.kind === 'group' ? { groupId: s.groupId! } : (s.kind as 'pinned' | 'ungrouped'), !s.collapsed),
    );
  };
  const groupEntries = (s: Section, i: number): MenuEntry[] => {
    const ids = arranged.groups.map((g) => g.key);
    const move = (step: -1 | 1) => {
      const to = stepIndex(ids, s.key, step);
      if (to === null) return;
      void attempt(`move ${s.name}`, () => actions.sidebar.moveGroup(s.groupId!, to)).then(() => refocus(`[data-group-menu="${CSS.escape(s.key)}"] button`));
    };
    return [
      { label: `New Boton in ${s.name}`, onSelect: () => props.onNew(s.groupId!) },
      { label: 'Rename group…', onSelect: () => setDialog({ kind: 'rename', groupId: s.groupId!, name: s.name }) },
      { label: 'Move group up', disabled: i === 0, onSelect: () => move(-1) },
      { label: 'Move group down', disabled: i === ids.length - 1, onSelect: () => move(1) },
      'separator',
      { label: 'Delete group…', danger: true, onSelect: () => setDialog({ kind: 'delete', groupId: s.groupId!, name: s.name, count: s.bots.length }) },
    ];
  };

  const showSections = arranged.groups.length > 0;
  const rowProps = { selectedId: props.selectedId, onSelect: props.onSelect, waitingFor, brainRests, allPaused, primaryId, entriesFor, draggable: canDrag };
  const draggingBot = dragging === 'bot';

  return (
    <nav className="sidebar" aria-label="Botons" ref={navRef}>
      <div className="sidebar-top">
        {searching ? (
          <div className="search">
            <SearchIcon size={16} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Botons"
              aria-label="Search Botons"
              aria-describedby="sidebar-search-hint"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setQuery('');
                  setSearching(false);
                } else if (e.key === 'Enter' && results[0]) {
                  // Quick switch: the first match, wherever it is (collapsed groups too).
                  e.preventDefault();
                  props.onSelect(results[0].id);
                }
              }}
            />
            <span id="sidebar-search-hint" className="sr-only">
              Enter opens the first match.
            </span>
            <button className="icon-btn small" aria-label="Close search" onClick={() => (setQuery(''), setSearching(false))}>
              <CloseIcon size={14} />
            </button>
          </div>
        ) : (
          <>
            <div className="brand">
              <Logo height={26} />
            </div>
            <button className="icon-btn round" aria-label="Search" title="Search" onClick={() => setSearching(true)}>
              <SearchIcon />
            </button>
            <button className="icon-btn round" aria-label="New Boton" title="New Boton" onClick={() => props.onNew()}>
              <PlusIcon />
            </button>
          </>
        )}
        {draggingBot && arranged.pinned.bots.length === 0 && (
          // Over the top bar, so nothing in the list moves when a drag starts, and every row can still take a drop.
          <div className="pin-zone" data-drop="pinned">
            Drop here to pin
          </div>
        )}
      </div>

      {allPaused && (
        <div className="paused-banner" role="status">
          <PauseIcon size={16} />
          <span>
            <strong>All Botons are paused.</strong> Nothing runs until you resume.
          </span>
          <button className="btn small" disabled={pausing} onClick={() => void togglePauseAll()}>
            <PlayIcon size={14} /> Resume all
          </button>
        </div>
      )}

      {waiting.length > 0 && (
        <button className="approvals-banner" onClick={() => props.onSelect(waiting[0].botId)} title="Open the oldest request">
          <ShieldIcon size={16} />
          <span>
            <strong>
              {waiting.length === 1 ? '1 approval waiting' : `${waiting.length} approvals waiting`}
            </strong>
            {waitingNames.length > 0 && ` · ${waitingNames.join(', ')}`}
          </span>
        </button>
      )}

      <p className="sr-only" aria-live="polite" ref={said} />
      <div className="sidebar-scroll" data-drag-scroll>

        {bots.length === 0 && (
          <div className="sidebar-empty">
            <p>No Botons yet.</p>
            <button className="btn primary" onClick={() => props.onNew()}>
              <PlusIcon size={16} /> New Boton
            </button>
          </div>
        )}

        {searchingFor ? (
          bots.length > 0 &&
          (results.length === 0 ? (
            <p className="sidebar-empty muted" role="status">
              No Botons match “{query}”.
            </p>
          ) : (
            <section className="group">
              <h2 className="group-title plain" role="status">
                {results.length === 1 ? '1 match' : `${results.length} matches`}
              </h2>
              <ul>
                {results.map((b) => (
                  <BotRow key={b.id} bot={b} {...rowProps} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <>
            {arranged.pinned.bots.length > 0 && (
              <section className="group pinned-section" aria-label="Pinned" data-drop="pinned" data-collapsed={arranged.pinned.collapsed || undefined}>
                <SectionHead section={arranged.pinned} summary={summarize(arranged.pinned.bots, waitingFor)} onToggle={() => toggle(arranged.pinned)} />
                {!arranged.pinned.collapsed && (
                  <ul className="pinned" id="sb-pinned">
                    {arranged.pinned.bots.map((b) => (
                      <PinnedTile key={b.id} bot={b} {...rowProps} />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {arranged.groups.map((g, i) => (
              <section key={g.key} className="group" aria-label={g.name} data-drop={g.key} data-drop-group={g.key} data-collapsed={g.collapsed || undefined}>
                <SectionHead
                  section={g}
                  summary={summarize(g.bots, waitingFor)}
                  onToggle={() => toggle(g)}
                  menu={
                    <MenuButton label={`Options for group ${g.name}`} className="icon-btn small group-menu-btn" entries={() => groupEntries(g, i)}>
                      <MoreIcon size={16} />
                    </MenuButton>
                  }
                  menuKey={g.key}
                  draggable={canDrag}
                />
                {!g.collapsed &&
                  (g.bots.length ? (
                    <ul id={`sb-${g.key}`}>
                      {g.bots.map((b) => (
                        <BotRow key={b.id} bot={b} sectionKey={g.key} {...rowProps} />
                      ))}
                    </ul>
                  ) : (
                    <p className="group-empty" id={`sb-${g.key}`}>
                      No Botons here yet. Drag one here, or move one in from its menu.
                    </p>
                  ))}
              </section>
            ))}

            {(arranged.ungrouped.bots.length > 0 || !showSections || draggingBot) && bots.length > 0 && (
              <section
                className="group"
                aria-label={showSections ? 'Ungrouped' : undefined}
                data-drop="ungrouped"
                data-collapsed={(showSections && arranged.ungrouped.collapsed) || undefined}
              >
                {showSections && <SectionHead section={arranged.ungrouped} summary={summarize(arranged.ungrouped.bots, waitingFor)} onToggle={() => toggle(arranged.ungrouped)} />}
                {(!showSections || !arranged.ungrouped.collapsed) &&
                  (arranged.ungrouped.bots.length ? (
                    <ul id="sb-ungrouped">
                      {arranged.ungrouped.bots.map((b) => (
                        <BotRow key={b.id} bot={b} sectionKey="ungrouped" {...rowProps} />
                      ))}
                    </ul>
                  ) : (
                    <p className="group-empty" id="sb-ungrouped">
                      Drop here to take it out of its group.
                    </p>
                  ))}
              </section>
            )}

            {bots.length > 0 && (
              <button type="button" className="new-group-btn" onClick={() => setDialog({ kind: 'create' })}>
                <PlusIcon size={15} /> New group
              </button>
            )}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <ThemeSetting quick />
        <span className="owner-chip" aria-hidden="true">
          {initials(settings?.ownerName ?? '')}
        </span>
        <span className="owner-name">{settings?.ownerName}</span>
        <button
          className={cx('icon-btn round', allPaused && 'on')}
          aria-label={allPaused ? 'Resume all Botons' : 'Pause all Botons'}
          title={allPaused ? 'Resume all Botons' : 'Pause all Botons'}
          disabled={pausing}
          onClick={() => void togglePauseAll()}
        >
          {allPaused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button className="icon-btn round" aria-label="Skills" title="Skills" onClick={props.onSkills}>
          <BookIcon />
        </button>
        <button className="icon-btn round" aria-label="Settings" title="Settings" onClick={props.onSettings}>
          <GearIcon />
        </button>
      </div>

      {dialog && (dialog.kind === 'delete' ? (
        <ConfirmDialog
          title={`Delete ${dialog.name}?`}
          confirmLabel="Delete group"
          what={`delete ${dialog.name}`}
          danger
          onConfirm={() => actions.sidebar.deleteGroup(dialog.groupId).then(() => refocus(sectionToggle('ungrouped'), '.new-group-btn'))}
          onClose={() => setDialog(null)}
        >
          <p>
            {dialog.count === 0
              ? 'The group is empty.'
              : `Its ${dialog.count === 1 ? 'Boton moves' : `${dialog.count} Botons move`} to Ungrouped, in the same order.`}{' '}
            No Boton is deleted, and pins stay.
          </p>
        </ConfirmDialog>
      ) : (
        <GroupNameDialog dialog={dialog} onClose={() => setDialog(null)} />
      ))}
    </nav>
  );
}

/** A row's menu: pin, move within its list, move to another group. In Pinned, the pinned order. */
function menuEntries(a: Arranged, sectionKey: string, bot: Bot, newGroupFor: (b: Bot) => void): MenuEntry[] {
  const name = bot.name;
  const pinnedIds = a.pinned.bots.map((b) => b.id);
  const pinned = pinnedIds.includes(bot.id);
  if (sectionKey === 'pinned') {
    const move = (step: -1 | 1) => {
      const to = stepIndex(pinnedIds, bot.id, step);
      if (to !== null) void attempt(`move ${name}`, () => actions.sidebar.pin(bot.id, true, to)).then(() => refocus(rowMenu('pinned', bot.id)));
    };
    return [
      { label: 'Move left', disabled: pinnedIds[0] === bot.id, onSelect: () => move(-1) },
      { label: 'Move right', disabled: pinnedIds.at(-1) === bot.id, onSelect: () => move(1) },
      'separator',
      { label: 'Unpin', onSelect: () => void attempt(`unpin ${name}`, () => actions.sidebar.pin(bot.id, false)).then(() => refocus(sectionToggle('pinned'), rowMenu(bot.groupId ?? 'ungrouped', bot.id))) },
    ];
  }
  const home = [...a.groups, a.ungrouped].find((s) => s.bots.some((b) => b.id === bot.id)) ?? a.ungrouped;
  const ids = home.bots.map((b) => b.id);
  const move = (step: -1 | 1) => {
    const to = stepIndex(ids, bot.id, step);
    if (to !== null) void attempt(`move ${name}`, () => actions.sidebar.moveBot(bot.id, home.groupId, to)).then(() => refocus(rowMenu(home.key, bot.id)));
  };
  const moveTo = (s: Section) => {
    if (s.key === home.key) return;
    void attempt(`move ${name} to ${s.name}`, () => actions.sidebar.moveBot(bot.id, s.groupId)).then(() => refocus(rowMenu(s.key, bot.id), sectionToggle(s.key)));
  };
  return [
    pinned
      ? { label: 'Unpin', onSelect: () => void attempt(`unpin ${name}`, () => actions.sidebar.pin(bot.id, false)) }
      : { label: 'Pin to top', onSelect: () => void attempt(`pin ${name}`, () => actions.sidebar.pin(bot.id, true)) },
    { label: 'Move up', disabled: ids[0] === bot.id, onSelect: () => move(-1) },
    { label: 'Move down', disabled: ids.at(-1) === bot.id, onSelect: () => move(1) },
    ...(a.groups.length
      ? [{ heading: 'Move to group', items: [...a.groups, a.ungrouped].map((s) => ({ label: s.name, checked: s.key === home.key, onSelect: () => moveTo(s) })) }]
      : []),
    { label: 'Move to a new group…', onSelect: () => newGroupFor(bot) },
  ];
}

function SectionHead(props: { section: Section; summary: Summary; onToggle: () => void; menu?: ReactNode; menuKey?: string; draggable?: boolean }) {
  const { section: s, summary } = props;
  const said = summaryText(summary);
  // Collapsed, its name says what it hides; the counts drawn next to it are for the eye.
  const label = s.collapsed ? [s.name, s.bots.length === 1 ? '1 Boton' : `${s.bots.length} Botons`, said].filter(Boolean).join(', ') : undefined;
  return (
    <div className="group-head" {...(props.draggable && s.groupId && { 'data-drag': 'group', 'data-group-id': s.groupId, 'data-name': s.name })}>
      <h2 className="group-title">
        <button
          type="button"
          className="group-toggle"
          data-section={s.key}
          aria-expanded={!s.collapsed}
          aria-controls={s.collapsed ? undefined : `sb-${s.key}`}
          aria-label={label}
          onClick={props.onToggle}
        >
          <ChevronIcon size={14} className="group-chevron" />
          <span className="group-name">{s.name}</span>
          {s.collapsed && (
            <>
              <span className="group-count" aria-hidden="true">
                {s.bots.length}
              </span>
              <span className="group-summary" aria-hidden="true">
                {summary.busy > 0 && (
                  <span className="busy-count" title={`${summary.busy} working`}>
                    {summary.busy}
                  </span>
                )}
                {summary.approvals > 0 && (
                  <span className="approval-badge" title={`${summary.approvals} waiting for your approval`}>
                    <ShieldIcon size={13} />
                    {summary.approvals > 9 ? '9+' : summary.approvals}
                  </span>
                )}
                {summary.unread > 0 && (
                  <span className="unread-badge" title={`${summary.unread} unread`}>
                    {summary.unread > 99 ? '99+' : summary.unread}
                  </span>
                )}
              </span>
            </>
          )}
        </button>
      </h2>
      {props.menu && <span data-group-menu={props.menuKey} className="group-menu">{props.menu}</span>}
    </div>
  );
}

interface RowProps {
  bot: Bot;
  /** The section the row is in; none in search results, which have no menu. */
  sectionKey?: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  waitingFor: ReadonlyMap<string, number>;
  /** Why each brain can't think now, by id (null before they have loaded; a brain not in it is missing). */
  brainRests: ReadonlyMap<string, BrainRest | null> | null;
  allPaused: boolean;
  primaryId: string | null;
  entriesFor: (sectionKey: string, bot: Bot) => MenuEntry[];
  /** Whether it can be dragged (not in search results, nor before the layout has loaded). */
  draggable?: boolean;
}

const BotRow = memo(function BotRow({ bot: b, sectionKey, selectedId, onSelect, waitingFor, brainRests, allPaused, primaryId, entriesFor, draggable }: RowProps) {
  const waits = waitingFor.get(b.id) ?? 0;
  const rest = brainRests ? (brainRests.has(b.provider) ? brainRests.get(b.provider)! : ({ kind: 'none' } as const)) : null;
  const asleep = !!rest;
  return (
    <li className="bot-item" {...(draggable && sectionKey && { 'data-drag': 'bot', 'data-bot-id': b.id, 'data-name': b.name })}>
      <button
        className={cx('bot-row', b.id === selectedId && 'selected', b.unread > 0 && 'unread')}
        onClick={() => onSelect(b.id)}
        aria-current={b.id === selectedId ? 'page' : undefined}
      >
        <span className={cx('avatar-wrap', b.status.state !== 'idle' && 'busy', (b.paused || allPaused) && 'paused')}>
          <BotonAvatar look={b.look} size={42} seed={b.id} state={avatarState(b, waits, asleep)} />
        </span>
        <span className="bot-row-text">
          <span className="bot-row-name">
            {b.id === primaryId && <PrimaryStar />}
            {b.name}
          </span>
          <span className={cx('bot-row-preview', b.status.state !== 'idle' && 'active', b.lastMessage?.role === 'error' && b.status.state === 'idle' && 'error')}>
            {preview(b, rest)}
          </span>
        </span>
        <ApprovalBadge count={waits} />
        {b.unread > 0 && <UnreadBadge count={b.unread} />}
      </button>
      {sectionKey && (
        <span className="row-menu" data-menu={`${sectionKey}:${b.id}`}>
          <MenuButton label={`Options for ${b.name}`} className="icon-btn small row-menu-btn" entries={() => entriesFor(sectionKey, b)}>
            <MoreIcon size={16} />
          </MenuButton>
        </span>
      )}
    </li>
  );
});

const PinnedTile = memo(function PinnedTile({ bot: b, selectedId, onSelect, waitingFor, brainRests, allPaused, primaryId, entriesFor, draggable }: RowProps) {
  const waits = waitingFor.get(b.id) ?? 0;
  const rest = brainRests ? (brainRests.has(b.provider) ? brainRests.get(b.provider)! : ({ kind: 'none' } as const)) : null;
  const asleep = !!rest;
  return (
    <li className="pinned-tile" {...(draggable && { 'data-drag': 'pinned', 'data-bot-id': b.id, 'data-name': b.name })}>
      <button
        className={cx('pinned-item', b.id === selectedId && 'selected', b.unread > 0 && 'unread')}
        onClick={() => onSelect(b.id)}
        aria-current={b.id === selectedId ? 'page' : undefined}
        aria-label={[b.name, rest && restText(rest).toLowerCase(), b.unread && `${b.unread} unread`].filter(Boolean).join(', ')}
      >
        <span className={cx('avatar-wrap', b.status.state !== 'idle' && 'busy', (b.paused || allPaused) && 'paused')}>
          <BotonAvatar look={b.look} size={60} seed={b.id} state={avatarState(b, waits, asleep)} />
          {b.unread > 0 && <UnreadBadge count={b.unread} />}
          <ApprovalBadge count={waits} />
        </span>
        <span className="pinned-name">
          {b.id === primaryId && <PrimaryStar />}
          {b.name}
        </span>
      </button>
      <span className="row-menu" data-menu={`pinned:${b.id}`}>
        <MenuButton label={`Options for ${b.name} in Pinned`} className="icon-btn small row-menu-btn" entries={() => entriesFor('pinned', b)}>
          <MoreIcon size={16} />
        </MenuButton>
      </span>
    </li>
  );
});

/** Names a new group (and moves a Boton into it, when made from its menu), or renames one. */
function GroupNameDialog({ dialog, onClose }: { dialog: Exclude<GroupDialog, { kind: 'delete' }>; onClose: () => void }) {
  const [name, setName] = useState(dialog.kind === 'rename' ? dialog.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = dialog.kind === 'rename' ? `Rename ${dialog.name}` : dialog.moving ? `New group for ${dialog.moving.name}` : 'New group';
  const save = async () => {
    const n = name.trim();
    if (!n) return setError('Give the group a name.');
    setBusy(true);
    setError(null);
    const ok = await attempt(
      dialog.kind === 'rename' ? `rename ${dialog.name}` : `make the group ${n}`,
      async () => {
        if (dialog.kind === 'rename') return void (n !== dialog.name && (await actions.sidebar.renameGroup(dialog.groupId, n)));
        const id = await actions.sidebar.createGroup(n);
        if (dialog.moving) await actions.sidebar.moveBot(dialog.moving.id, id);
      },
      setError,
    );
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title={title} onClose={() => !busy && onClose()}>
      <form
        className="group-name-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span className="field-label">Name</span>
          <input data-autofocus value={name} onChange={(e) => (setName(e.target.value), setError(null))} maxLength={40} placeholder="Work" aria-invalid={!!error || undefined} aria-describedby={error ? 'group-name-error' : undefined} />
        </label>
        {error && (
          <p className="form-error" id="group-name-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : dialog.kind === 'rename' ? 'Rename' : 'Make group'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PrimaryStar() {
  return (
    <span className="primary-star" title="Primary Boton">
      <StarIcon size={13} />
      <span className="sr-only">Primary Boton: </span>
    </span>
  );
}

function ApprovalBadge({ count }: { count?: number }) {
  if (!count) return null;
  const label = `${count} waiting for your approval`;
  return (
    <span className="approval-badge" title={label}>
      <ShieldIcon size={13} />
      <span aria-hidden="true">{count > 9 ? '9+' : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="unread-badge" title={`${count} unread`}>
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{count} unread</span>
    </span>
  );
}
