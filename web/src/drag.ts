import { type Drop, dropIndex } from './sidebar.ts';

/**
 * Drag to arrange the sidebar, with a mouse or by touch. It works on the page as rendered and marks it with data
 * attributes: nothing re-renders while the pointer moves, only when a drag starts, ends and drops.
 *
 * What it reads, set by the sidebar:
 * - `[data-drag="bot"|"pinned"|"group"]`: what can be picked up (a Boton's row, a pinned tile, a group's head), with
 *   `data-bot-id` or `data-group-id`. Its menu button never starts a drag.
 * - `[data-drop]`: a section a Boton can go into ("pinned", "ungrouped" or a group's id), with `data-collapsed` when
 *   only its head shows; its `[data-drag]` items are the places to drop between. `[data-drop-group]`: a group's
 *   section, for moving groups.
 * - `[data-drag-scroll]`: the list that scrolls when a drag nears its top or bottom edge.
 *
 * A mouse drag starts once the pointer has moved a few pixels with the button down; a touch (or pen) drag starts
 * after a long press that hasn't moved, so a swipe scrolls as usual. Escape, leaving the sidebar, or a cancelled
 * pointer drops nothing.
 */
export interface DragHandlers {
  /** A drag has started: the sidebar can show places to drop that only exist while dragging. */
  onStart: (kind: DragKind) => void;
  /** It ended, dropped or not. */
  onEnd: () => void;
  onDrop: (drop: Drop) => void;
  /** For a screen reader: what was picked up, or that it was put back. */
  announce: (text: string) => void;
}
export type DragKind = 'bot' | 'pinned' | 'group';

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 450;
const EDGE = 48;

interface Target {
  drop: Drop;
  /** Where the line between items goes, or the element that takes the drop as a whole. */
  line?: { x: number; y: number; length: number; vertical: boolean };
  over?: HTMLElement;
}

export function attachSidebarDrag(root: HTMLElement, handlers: () => DragHandlers): () => void {
  let pending: { id: number; x: number; y: number; el: HTMLElement; touch: boolean; timer?: ReturnType<typeof setTimeout> } | null = null;
  let active: {
    id: number;
    kind: DragKind;
    el: HTMLElement;
    name: string;
    ghost: HTMLElement;
    line: HTMLElement;
    dx: number;
    dy: number;
    x: number;
    y: number;
    target: Target | null;
    over: HTMLElement | null;
    frame: number;
  } | null = null;

  let cancelledPointer: number | null = null;
  const swallowClick = () => {
    const swallow = (ev: Event) => (ev.preventDefault(), ev.stopPropagation());
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  };

  const scroller = () => root.querySelector<HTMLElement>('[data-drag-scroll]');

  const clearCancelledPointer = () => {
    if (cancelledPointer !== null) {
      cancelledPointer = null;
      window.removeEventListener('pointerup', onUp, true);
    }
  };

  const onDown = (e: PointerEvent) => {
    if (active || pending || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = e.target as Element;
    if (t.closest('.row-menu, .group-menu, input, dialog, .menu')) return;
    const el = t.closest<HTMLElement>('[data-drag]');
    if (!el || !root.contains(el)) return;
    const touch = e.pointerType !== 'mouse';
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY, el, touch };
    if (touch) pending.timer = setTimeout(() => pending && start(pending.x, pending.y), LONG_PRESS_MS);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  };

  const onMove = (e: PointerEvent) => {
    if (active) {
      if (e.pointerId !== active.id) return;
      active.x = e.clientX;
      active.y = e.clientY;
      return;
    }
    if (!pending || e.pointerId !== pending.id) return;
    const moved = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.touch) {
      // Moved before the long press: it's a scroll, and the browser has it.
      if (moved > TOUCH_SLOP) stop();
    } else if (moved > MOUSE_SLOP) start(e.clientX, e.clientY);
  };

  const start = (x: number, y: number) => {
    if (!pending) return;
    const { el, id } = pending;
    clearTimeout(pending.timer);
    pending = null;
    const kind = el.dataset.drag as DragKind;
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('data-drag');
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    ghost.className = `${ghost.className} drag-ghost`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    const line = document.createElement('div');
    line.className = 'drop-line';
    line.hidden = true;
    document.body.append(ghost, line);
    el.setAttribute('data-drag-source', '');
    document.documentElement.setAttribute('data-dragging', kind);
    const name = el.dataset.name ?? '';
    active = { id, kind, el, name, ghost, line, dx: x - r.left, dy: y - r.top, x, y, target: null, over: null, frame: 0 };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    if (navigator.vibrate && kind !== 'group') navigator.vibrate(8);
    handlers().onStart(kind);
    handlers().announce(`Picked up ${name}. Escape puts it back.`);
    active.frame = requestAnimationFrame(tick);
  };

  /** Once a frame: follow the pointer, scroll near the edges, and find where it would drop. */
  const tick = () => {
    if (!active) return;
    const a = active;
    a.ghost.style.transform = `translate(${a.x - a.dx}px, ${a.y - a.dy}px)`;
    const list = scroller();
    if (list) {
      const r = list.getBoundingClientRect();
      const inside = a.x >= r.left && a.x <= r.right;
      if (inside && a.y < r.top + EDGE) list.scrollTop -= Math.ceil((r.top + EDGE - a.y) / 4);
      else if (inside && a.y > r.bottom - EDGE) list.scrollTop += Math.ceil((a.y - (r.bottom - EDGE)) / 4);
    }
    const pinned = root.querySelector<HTMLElement>('.pinned');
    if (pinned && a.kind !== 'group') {
      const r = pinned.getBoundingClientRect();
      if (a.y >= r.top && a.y <= r.bottom && a.x >= r.left && a.x <= r.right) {
        if (a.x < r.left + EDGE) pinned.scrollLeft -= Math.ceil((r.left + EDGE - a.x) / 4);
        else if (a.x > r.right - EDGE) pinned.scrollLeft += Math.ceil((a.x - (r.right - EDGE)) / 4);
      }
    }
    show(a, find(a));
    a.frame = requestAnimationFrame(tick);
  };

  const find = (a: NonNullable<typeof active>): Target | null => {
    const list = scroller();
    if (!list) return null;
    const box = list.getBoundingClientRect();
    if (a.x < box.left || a.x > box.right || a.y > box.bottom) return null;
    if (a.y < box.top && !(a.kind !== 'group' && document.elementFromPoint(a.x, a.y)?.closest('.pin-zone'))) return a.y < box.top - EDGE ? null : a.target;
    if (a.kind === 'group') {
      const groupId = a.el.dataset.groupId!;
      const others = [...root.querySelectorAll<HTMLElement>('[data-drop-group]')].filter((s) => s.dataset.dropGroup !== groupId);
      if (!others.length) return null;
      const rects = others.map((s) => s.getBoundingClientRect());
      const index = dropIndex(rects.map((r) => ({ start: r.top, end: r.bottom })), a.y);
      const y = index < rects.length ? rects[index].top - 5 : rects[rects.length - 1].bottom + 5;
      return { drop: { kind: 'group', groupId, index }, line: { x: box.left + 8, y, length: box.width - 16, vertical: false } };
    }
    const zone = document.elementFromPoint(a.x, a.y)?.closest<HTMLElement>('.pin-zone');
    const hit = zone ?? document.elementFromPoint(Math.min(Math.max(a.x, box.left + 1), box.right - 1), a.y);
    const section = hit?.closest<HTMLElement>('[data-drop]');
    if (!section || !root.contains(section)) return a.target;
    const key = section.dataset.drop!;
    const botId = a.el.dataset.botId!;
    // A pinned tile is reordered among the pinned; out of Pinned it goes back (Unpin is in its menu).
    if (a.kind === 'pinned' && key !== 'pinned') return null;
    const make = (index?: number): Drop => (key === 'pinned' ? { kind: 'pin', botId, index } : { kind: 'bot', botId, groupId: key === 'ungrouped' ? null : key, index });
    const items = section.hasAttribute('data-collapsed') ? [] : [...section.querySelectorAll<HTMLElement>('[data-drag="bot"], [data-drag="pinned"]')].filter((i) => i.dataset.botId !== botId);
    if (!items.length) return { drop: make(section.hasAttribute('data-collapsed') ? undefined : 0), over: section };
    const vertical = key === 'pinned';
    const rects = items.map((i) => i.getBoundingClientRect());
    const index = dropIndex(rects.map((r) => (vertical ? { start: r.left, end: r.right } : { start: r.top, end: r.bottom })), vertical ? a.x : a.y);
    const before = rects[index];
    const after = rects[index - 1];
    if (vertical) {
      const ref = before ?? after;
      const x = before ? before.left - 2 : after.right + 2;
      return { drop: make(index), line: { x, y: ref.top + 4, length: ref.height - 8, vertical: true } };
    }
    const ref = before ?? after;
    const y = before ? before.top - 1 : after.bottom + 1;
    return { drop: make(index), line: { x: ref.left + 6, y, length: ref.width - 12, vertical: false } };
  };

  const show = (a: NonNullable<typeof active>, t: Target | null) => {
    a.target = t;
    const over = t?.over ?? null;
    if (over !== a.over) {
      a.over?.removeAttribute('data-drop-over');
      over?.setAttribute('data-drop-over', '');
      a.over = over;
    }
    const l = t?.line;
    a.line.hidden = !l;
    if (l) {
      a.line.classList.toggle('vertical', l.vertical);
      a.line.style.transform = `translate(${l.x}px, ${l.y}px)`;
      a.line.style[l.vertical ? 'height' : 'width'] = `${l.length}px`;
      a.line.style[l.vertical ? 'width' : 'height'] = '';
    }
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId === cancelledPointer) {
      cancelledPointer = null;
      swallowClick();
      window.removeEventListener('pointerup', onUp, true);
      return;
    }
    if (active && e.pointerId === active.id) {
      const drop = (show(active, find(active)), active.target?.drop);
      const name = active.name;
      // The click that follows a drag isn't a click on the row.
      swallowClick();
      stop();
      if (drop) handlers().onDrop(drop);
      else handlers().announce(`${name} put back.`);
      return;
    }
    if (pending && e.pointerId === pending.id) stop();
  };

  const onCancel = (e: PointerEvent) => {
    if ((active && e.pointerId === active.id) || (pending && e.pointerId === pending.id)) cancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !active) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const onBlur = () => cancel();
  const cancel = () => {
    const name = active?.name;
    const id = active?.id;
    stop();
    if (id !== undefined) {
      cancelledPointer = id;
      window.addEventListener('pointerup', onUp, true);
    }
    if (name !== undefined) handlers().announce(`${name} put back.`);
  };

  const stop = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    if (!active) return;
    const a = active;
    active = null;
    cancelAnimationFrame(a.frame);
    a.ghost.remove();
    a.line.remove();
    a.over?.removeAttribute('data-drop-over');
    a.el.removeAttribute('data-drag-source');
    document.documentElement.removeAttribute('data-dragging');
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    handlers().onEnd();
  };

  // While a long press is waiting or a touch drag is on, the page must not scroll or open its own menu. The browser
  // asks this listener before it scrolls (so it can't be passive); it lets every other touch scroll as usual.
  const onTouchMove = (e: TouchEvent) => {
    if (active && e.cancelable) e.preventDefault();
  };
  const onContextMenu = (e: Event) => {
    if (active || pending?.touch) e.preventDefault();
  };
  window.addEventListener('pointerdown', clearCancelledPointer, true);
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('contextmenu', onContextMenu);
  return () => {
    stop();
    cancelledPointer = null;
    window.removeEventListener('pointerdown', clearCancelledPointer, true);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('touchmove', onTouchMove);
    root.removeEventListener('contextmenu', onContextMenu);
  };
}
