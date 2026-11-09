import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { QUICK_REACTIONS, reactionEmoji } from '../../../shared/reactions.ts';
import type { Message } from '../../../shared/types.ts';
import { cx } from '../util.ts';
import { deferred, useDeferred } from './Deferred.tsx';

/*
 * The reaction picker (Reactions.tsx opens it; a chunk of its own): the quick row, and the full picker under More, a
 * searchable catalog (a chunk of its own again) and a field that takes any emoji, typed or pasted, say from the
 * system's emoji keyboard. A popover in the top layer: Escape or a press outside closes it, and so does Tab out of
 * it; arrow keys move within the quick row and the grid, each one tab stop. Picking an emoji the owner has on the
 * message takes it off.
 */

const catalogPart = deferred(() => import('../emoji-catalog.ts'));

/** The React button that opened it: pressing it again closes the picker itself, so the press doesn't too. */
const isTrigger = (el: Element) => !!el.closest('.msg-react[aria-expanded="true"]');

export function ReactionPicker(props: {
  m: Message;
  botName: string;
  anchor: HTMLElement;
  followUps: string[];
  onPick: (emoji: string) => void;
  /** refocus: put focus back where it was (not when the owner clicked elsewhere). */
  onClose: (refocus: boolean) => void;
}) {
  const { m, botName, anchor, followUps, onPick, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const mine = new Set((m.reactions ?? []).filter((r) => r.by === 'owner').map((r) => r.emoji));
  const closing = useRef(false);
  const close = (refocus: boolean) => {
    if (closing.current) return;
    closing.current = true;
    onClose(refocus);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showPopover();
    el.querySelector<HTMLElement>('.quick-reactions [tabindex="0"]')?.focus({ preventScroll: true });
    // A manual popover, closed by a press outside it: an automatic one would close on the lift of the long press that
    // opened it. The React button closes it itself (Reactions.tsx).
    const outside = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && !el.contains(t) && !isTrigger(t)) close(false);
    };
    addEventListener('pointerdown', outside, true);
    return () => {
      removeEventListener('pointerdown', outside, true);
      if (el.matches(':popover-open')) el.hidePopover();
    };
  }, []);
  // Above the bubble, its left edges lined up, inside the window; below it if there is no room above. Again when the
  // full picker opens, the window resizes, or the chat scrolls under it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - p.width - 8));
      const above = r.top - p.height - 6;
      const top = above >= 8 ? above : Math.min(r.bottom + 6, Math.max(8, window.innerHeight - p.height - 8));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    addEventListener('resize', place);
    const scroller = anchor.closest('.messages');
    scroller?.addEventListener('scroll', place, { passive: true });
    return () => {
      observer.disconnect();
      removeEventListener('resize', place);
      scroller?.removeEventListener('scroll', place);
    };
  }, [anchor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Handled here: the same key must not also close the panel or dialog behind it.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };
  const label = `React to ${botName}'s message`;
  return (
    <div
      ref={ref}
      popover="manual"
      role="dialog"
      aria-label={label}
      className={cx('reaction-picker', more && 'full')}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Tab out of it: closed, focus stays where it went.
        const to = e.relatedTarget as Element | null;
        if (to && !e.currentTarget.contains(to) && !isTrigger(to)) close(false);
      }}
    >
      <div className="quick-row">
        <Roving className="quick-reactions" label="Quick reactions" columns={0}>
          {QUICK_REACTIONS.map((e, i) => (
            <EmojiButton key={e} emoji={e} on={mine.has(e)} followUp={followUps.includes(e)} botName={botName} first={i === 0} onPick={onPick} />
          ))}
        </Roving>
        <button type="button" className="reaction-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {more ? 'Less' : 'More…'}
        </button>
      </div>
      {more && <FullPicker mine={mine} followUps={followUps} botName={botName} onPick={onPick} />}
      <p className="reaction-note">
        {followUps.length
          ? `Feedback for ${botName}'s next turn. ${followUps.join(' ')} also ${followUps.length === 1 ? 'asks' : 'ask'} for a short follow-up now.`
          : `Feedback for ${botName}'s next turn: no reaction starts one.`}
      </p>
    </div>
  );
}

function EmojiButton(props: { emoji: string; on: boolean; followUp: boolean; botName: string; first?: boolean; onPick: (e: string) => void }) {
  const { emoji, on, followUp, botName } = props;
  const title = on ? `Take off your ${emoji}` : followUp ? `React ${emoji}: ${botName} follows up on it` : `React ${emoji}`;
  return (
    <button
      type="button"
      className={cx('emoji-btn', on && 'on')}
      aria-pressed={on}
      aria-label={followUp && !on ? `${emoji}, asks for a follow-up` : emoji}
      title={title}
      tabIndex={props.first ? 0 : -1}
      onClick={() => props.onPick(emoji)}
    >
      {emoji}
    </button>
  );
}

/**
 * Buttons that are one tab stop, the arrow keys moving between them: in a row (columns 0: left and right, Home,
 * End) or a grid laid out by the browser (up and down go to the nearest button in the row above or below).
 */
function Roving(props: { className: string; label: string; columns: number; children: ReactNode; role?: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let to = -1;
    if (e.key === 'ArrowRight') to = Math.min(all.length - 1, i + 1);
    else if (e.key === 'ArrowLeft') to = Math.max(0, i - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = all.length - 1;
    else if (props.columns && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) to = vertical(all, i, e.key === 'ArrowDown');
    if (to < 0) return;
    e.preventDefault();
    all[i].tabIndex = -1;
    all[to].tabIndex = 0;
    all[to].focus();
    all[to].scrollIntoView({ block: 'nearest' });
  };
  return (
    <div className={props.className} role={props.role ?? 'toolbar'} aria-label={props.label} onKeyDown={onKeyDown}>
      {props.children}
    </div>
  );
}

/** The button in the next row of buttons (by position on screen) nearest this one's column; this one at the edge. */
function vertical(all: HTMLElement[], i: number, down: boolean): number {
  const from = all[i].getBoundingClientRect();
  let best = i;
  let bestRow = Infinity;
  let bestDx = Infinity;
  all.forEach((b, j) => {
    const r = b.getBoundingClientRect();
    const dy = down ? r.top - from.top : from.top - r.top;
    if (dy < from.height / 2) return;
    const dx = Math.abs(r.left - from.left);
    if (dy < bestRow - 1 || (Math.abs(dy - bestRow) <= 1 && dx < bestDx)) {
      bestRow = dy;
      bestDx = dx;
      best = j;
    }
  });
  return best;
}

function FullPicker(props: { mine: Set<string>; followUps: string[]; botName: string; onPick: (e: string) => void }) {
  const { mod, failed, retry } = useDeferred(catalogPart);
  const [query, setQuery] = useState('');
  const [own, setOwn] = useState('');
  const [ownError, setOwnError] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  // Not on a touch screen: its keyboard would come up over the grid.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) search.current?.focus();
  }, []);
  const found = mod && query.trim() ? mod.searchEmoji(query) : null;
  const groups = found ? [{ name: `Results for “${query.trim()}”`, emoji: found }] : (mod?.CATEGORIES ?? []);
  let first = true;
  const button = (emoji: string) => {
    const b = <EmojiButton key={emoji} emoji={emoji} on={props.mine.has(emoji)} followUp={props.followUps.includes(emoji)} botName={props.botName} first={first} onPick={props.onPick} />;
    first = false;
    return b;
  };
  return (
    <div className="full-picker">
      <input
        ref={search}
        type="search"
        className="emoji-search"
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter picks the first match; down goes into the grid.
          if (e.key === 'Enter' && found?.length) {
            e.preventDefault();
            props.onPick(found[0].emoji);
          } else if (e.key === 'ArrowDown') {
            const at = e.currentTarget.parentElement?.querySelector<HTMLElement>('.emoji-grid [tabindex="0"]');
            if (at) {
              e.preventDefault();
              at.focus();
            }
          }
        }}
      />
      <span className="sr-only" role="status">
        {found ? `${found.length} emoji found` : ''}
      </span>
      {failed ? (
        <p className="muted emoji-empty" role="alert">
          Couldn't load the emoji.{' '}
          <button type="button" className="link-btn" onClick={retry}>
            Retry
          </button>
        </p>
      ) : !mod ? (
        <p className="muted emoji-empty" role="status">
          Loading…
        </p>
      ) : found && !found.length ? (
        <p className="muted emoji-empty">No emoji called that here: type or paste any emoji below.</p>
      ) : (
        <Roving className="emoji-grid" label="Emoji" columns={1} role="group">
          {groups.map((g) => (
            <div key={g.name} className="emoji-group" role="group" aria-label={g.name}>
              <div className="emoji-group-name" aria-hidden="true">
                {g.name}
              </div>
              <div className="emoji-cells">{g.emoji.map((e) => button(e.emoji))}</div>
            </div>
          ))}
        </Roving>
      )}
      <form
        className="emoji-own"
        onSubmit={(e) => {
          e.preventDefault();
          const emoji = reactionEmoji(own);
          if (!emoji) return setOwnError('One emoji, with no text: say 🦖');
          setOwnError(null);
          props.onPick(emoji);
        }}
      >
        <input
          value={own}
          onChange={(e) => {
            setOwn(e.target.value);
            setOwnError(null);
          }}
          placeholder="Any emoji"
          aria-label="Type or paste any emoji"
          aria-invalid={!!ownError}
          aria-describedby={ownError ? 'emoji-own-error' : undefined}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button type="submit" className="btn small" disabled={!own.trim()}>
          React
        </button>
        {ownError && (
          <span id="emoji-own-error" className="form-error" role="alert">
            {ownError}
          </span>
        )}
      </form>
    </div>
  );
}
