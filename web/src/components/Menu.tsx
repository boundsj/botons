import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../util.ts';

export interface MenuAction {
  label: string;
  onSelect: () => void;
  /** Shown but not chosen: why not is in the label ("Move up" on the first). */
  disabled?: boolean;
  /** A choice of several (menuitemradio): the one it is now. */
  checked?: boolean;
  danger?: boolean;
}
export type MenuEntry = MenuAction | { heading: string; items: MenuAction[] } | 'separator';

/**
 * A button that opens a menu of actions: arrow keys, Home and End move between them, Enter or Space picks one,
 * Escape, Tab or a click elsewhere closes it, and focus goes back to the button. The menu is a popover in the top
 * layer, so the scrolling sidebar never clips it, and its entries are made only while it is open.
 */
export function MenuButton(props: { label: string; className?: string; entries: () => MenuEntry[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Pressing the button while the menu is open closes it (light dismiss) before the click lands: don't reopen.
  const pressedOpen = useRef(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={props.className}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={() => (pressedOpen.current = open)}
        onClick={() => {
          setOpen((o) => !o && !pressedOpen.current);
          pressedOpen.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
      {open && <MenuPopover label={props.label} anchor={button} entries={props.entries()} onClose={close} />}
    </>
  );
}

function MenuPopover({ label, anchor, entries, onClose }: { label: string; anchor: RefObject<HTMLButtonElement | null>; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    const at = anchor.current;
    if (!menu || !at) return;
    menu.showPopover();
    // Under the button, its right edges lined up, inside the window; above it if there is no room below.
    const r = at.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
    const below = r.bottom + 4;
    const top = below + m.height <= window.innerHeight - 8 ? below : Math.max(8, r.top - m.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    items(menu)[0]?.focus();
    return () => {
      // Back to the button, unless the owner went somewhere else (a click on another control).
      const lost = !document.activeElement || document.activeElement === document.body || menu.contains(document.activeElement);
      if (menu.matches(':popover-open')) menu.hidePopover();
      if (lost && at.isConnected) at.focus({ preventScroll: true });
    };
  }, [anchor]);

  const pick = (a: MenuAction) => {
    if (a.disabled) return;
    onClose();
    a.onSelect();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items(e.currentTarget);
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Tab') onClose();
    else if (e.key === 'Escape') {
      // Handled here: the same key must not also close the panel behind the menu.
      e.preventDefault();
      onClose();
    }
  };
  const item = (a: MenuAction, radio: boolean, key: string) => (
    <button
      key={key}
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? !!a.checked : undefined}
      aria-disabled={a.disabled || undefined}
      tabIndex={-1}
      className={cx('menu-item', a.danger && 'danger', a.checked && 'checked')}
      onClick={() => pick(a)}
    >
      {a.label}
    </button>
  );

  return (
    <div
      ref={ref}
      popover="auto"
      role="menu"
      aria-label={label}
      className="menu"
      onKeyDown={onKeyDown}
      // Escape or a click outside closes the popover by itself; this keeps React in step.
      onToggle={(e) => (e as unknown as ToggleEvent).newState === 'closed' && onClose()}
    >
      {entries.map((e, i) =>
        e === 'separator' ? (
          <div key={`sep${i}`} role="separator" className="menu-sep" />
        ) : 'heading' in e ? (
          <div key={`group${i}`} role="group" aria-label={e.heading}>
            <div className="menu-heading" aria-hidden="true">
              {e.heading}
            </div>
            {e.items.map((a, j) => item(a, true, `${i}.${j}`))}
          </div>
        ) : (
          item(e, false, String(i))
        ),
      )}
    </div>
  );
}

const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role^=menuitem]')];
