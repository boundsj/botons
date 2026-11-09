import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { attempt, modalStore } from '../feedback.ts';
import { CloseIcon } from './Icons.tsx';
import { Toasts } from './Toasts.tsx';

export function useModalOpen(): boolean {
  return useSyncExternalStore(modalStore.subscribe, () => modalStore.top() !== null, () => false);
}

export function Dialog({ title, onClose, children, wide, className }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState<number | null>(null);
  useEffect(() => {
    const opened = modalStore.open();
    setId(opened);
    return () => modalStore.close(opened);
  }, []);
  // Newest open dialog: it shows the toasts. Not until it has registered (never in a server render).
  const newest = useSyncExternalStore(modalStore.subscribe, modalStore.top, () => null);
  const top = id !== null && newest === id;
  // Closed, focus goes back to what opened it. A layout effect, so the cleanup runs while the dialog is still in the page.
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (!d.open) {
      d.showModal();
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    return () => {
      if (d.open) d.close();
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || d.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={['dialog', wide && 'wide', className].filter(Boolean).join(' ')}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn round" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
      {top && <Toasts />}
    </dialog>
  );
}

export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** For the error: "Couldn't <what>: …". */
  what: string;
  danger?: boolean;
  /** The confirm button's label while it works ("Working…" by default). */
  busyLabel?: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const ok = await attempt(props.what, props.onConfirm, setError);
    setBusy(false);
    if (ok) props.onClose();
  };
  // In <body>, so the dialog never ends up inside a form or a button.
  return createPortal(
    <Dialog title={props.title} onClose={() => !busy && props.onClose()}>
      <div className="confirm-body">{props.children}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={props.onClose} disabled={busy} data-autofocus={props.danger ? true : undefined}>
          Cancel
        </button>
        <button type="button" className={props.danger ? 'btn danger-solid' : 'btn primary'} onClick={() => void confirm()} disabled={busy} data-autofocus={props.danger ? undefined : true}>
          {busy ? (props.busyLabel ?? 'Working…') : props.confirmLabel}
        </button>
      </div>
    </Dialog>,
    document.body,
  );
}
