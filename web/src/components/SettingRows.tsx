import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../util.ts';
import { ChevronIcon } from './Icons.tsx';

// Settings as grouped rows, shared by a Boton's Settings tab and the server's Settings.

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="set-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <div className="set-card">{children}</div>
    </section>
  );
}

/** One setting: its label and at most one line of help, the control on the right (or below, for wide ones). */
export function Row({ label, help, control, children, htmlFor }: { label: ReactNode; help?: ReactNode; control?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-row-text">
          {htmlFor ? (
            <label className="set-label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <span className="set-label">{label}</span>
          )}
          {help && <span className="set-help">{help}</span>}
        </div>
        {control && <div className="set-control">{control}</div>}
      </div>
      {children}
    </div>
  );
}

export function LinkRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button type="button" className="set-row set-link" onClick={onClick}>
      <span className="set-label">{label}</span>
      <span className="set-value">
        {value} <ChevronIcon size={14} />
      </span>
    </button>
  );
}

/** "Advanced" and "Details": what most owners never need, one tap away. */
export function More({ label, children, onOpen }: { label: string; children: ReactNode; onOpen?: () => void }) {
  return (
    <details className="set-more" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && onOpen?.()}>
      <summary>{label}</summary>
      <div className="set-more-body">{children}</div>
    </details>
  );
}

export function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx('toggle', on && 'on')} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="toggle-knob" aria-hidden />
    </button>
  );
}

/**
 * Text saved when the owner leaves the field (or presses Enter in a one-line one); Escape puts it back. Edited
 * elsewhere meanwhile, it shows that unless the owner is typing here.
 */
export function useDraft(value: string, save: (v: string) => void, valid: (v: string) => boolean = () => true) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const ref = useRef({ draft, value, save, valid });
  ref.current = { draft, value, save, valid };
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const done = () => {
    editing.current = false;
    const { draft, value, save, valid } = ref.current;
    if (draft === value) return;
    if (!valid(draft)) return setDraft(value);
    save(draft);
  };
  // Closed while typing (the panel, or another Boton picked): keep what was typed.
  useEffect(() => () => void (editing.current && done()), []);
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => {
      editing.current = true;
      setDraft(e.target.value);
    },
    onBlur: done,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        // Only the field goes back: not the dialog or panel it is in.
        e.preventDefault();
        e.stopPropagation();
        editing.current = false;
        setDraft(ref.current.value);
        requestAnimationFrame(() => (e.target as HTMLElement).blur());
      } else if (e.key === 'Enter' && e.currentTarget instanceof HTMLInputElement) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
  };
}

