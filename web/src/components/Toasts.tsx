import { useSyncExternalStore } from 'react';
import { dismissToast, modalStore, toastStore } from '../feedback.ts';
import { cx } from '../util.ts';
import { CloseIcon } from './Icons.tsx';

const NONE: ReturnType<typeof toastStore.get> = [];
const noToasts = () => NONE;

/** `page`: the page's own; it gives way to the newest open modal, which shows them inside it (see modalStore). */
export function Toasts({ page = false }: { page?: boolean }) {
  // A server render has no toasts and no open dialog.
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.get, noToasts);
  const modal = useSyncExternalStore(modalStore.subscribe, () => modalStore.top() !== null, () => false);
  if (page && modal) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn small" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
