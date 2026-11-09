import { Fragment, useState } from 'react';
import type { ProviderInfo } from '../../../shared/types.ts';
import { brainDown, brainView, checkOf, shortLabel } from '../brains.ts';
import { attempt } from '../feedback.ts';
import { actions, getState, useStore } from '../state.ts';
import { cx } from '../util.ts';
import { AlertIcon } from './Icons.tsx';

/** Text with `code` spans, as the server writes its reasons and notes. */
export function withCode(text: string) {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>));
}

/** The owner's "check again": runs the server's checks anew, and says so when the server answered with its last ones. */
export function CheckAgain({ className }: { className?: string }) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className={cx('brain-check', className)}>
      <button
        type="button"
        className="btn small"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          setNote(null);
          const before = new Map(getState().providers.map((p) => [p.id, checkOf(p)]));
          if (await attempt('check again', () => actions.loadProviders(true))) {
            const checked = getState().providers.filter((p) => p.readiness.generation > 0);
            const same = checked.length > 0 && checked.every((p) => checkOf(p) === before.get(p.id));
            setNote(same ? 'The server checked moments ago, so this is that check: try again in a minute.' : null);
          }
          setChecking(false);
        }}
      >
        {checking ? 'Checking…' : 'Check again'}
      </button>
      {note && (
        <span className="hint" role="status">
          {note}
        </span>
      )}
    </span>
  );
}

/**
 * Above a Boton's chat and in its settings: its brain isn't ready, or the server couldn't confirm it is. Nothing
 * for one that is ready, or that no check has looked at yet.
 */
export function BrainWarning({ providers, provider }: { providers: ProviderInfo[]; provider: string }) {
  const container = useStore((s) => s.setup?.exposure.container ?? false);
  const p = providers.find((x) => x.id === provider);
  if (!providers.length) return null;
  if (!p) {
    return (
      <div className="brain-warning" role="status">
        <AlertIcon size={16} className="warn-icon" />
        <span>This brain ({provider}) is not on this server: its turns fail. Move the Boton to another in its settings.</span>
      </div>
    );
  }
  const r = p.readiness;
  if (!brainDown(p) && !(r.state === 'unknown' && r.problem !== 'not-checked' && r.problem !== 'outdated' && r.problem !== 'clock-changed')) return null;
  const view = brainView(p, { container });
  return (
    <div className="brain-warning" role="status" data-state={r.state}>
      <AlertIcon size={16} className="warn-icon" />
      <span>
        {shortLabel(p)}: {view.status}. {view.why && withCode(view.why)} {view.fix && withCode(view.fix.text)}
        {view.fix?.command && (
          <>
            {' '}
            <code>{view.fix.command}</code>
          </>
        )}
        {view.work && <> {view.work}</>}
      </span>
      {view.fix && <CheckAgain />}
    </div>
  );
}
