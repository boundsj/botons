import { useState } from 'react';
import type { StepKind, TurnSteps } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText } from '../feedback.ts';
import { clock, cx } from '../util.ts';

const KIND: Record<StepKind, string> = {
  command: 'Ran',
  read: 'Read',
  edit: 'Edited',
  search: 'Searched',
  web: 'Web',
  tool: 'Tool',
};

function StepList({ turn }: { turn: TurnSteps }) {
  return (
    <>
      <ol className="step-list">
        {turn.steps.map((s, i) => (
          <li key={i} title={`${s.label} · ${clock(s.at)}`}>
            <span className={cx('step-kind', s.kind)}>{KIND[s.kind] ?? s.kind}</span>
            <code className="step-detail">{s.detail || s.label}</code>
          </li>
        ))}
      </ol>
      {turn.total > turn.steps.length && <p className="hint">… and {turn.total - turn.steps.length} more (only the first {turn.steps.length} are kept).</p>}
    </>
  );
}

export function StepsToggle({ count, load }: { count: number; load: () => Promise<TurnSteps[]> }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TurnSteps[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchSteps = async () => {
    setError(null);
    try {
      setTurns(await load());
    } catch (e) {
      setError(errorText(e));
    }
  };
  const toggle = () => {
    setOpen(!open);
    if (!open && !turns) void fetchSteps();
  };
  return (
    <div className={cx('steps', open && 'open')}>
      <button type="button" className="steps-toggle" aria-expanded={open} onClick={toggle}>
        <span className="steps-caret" aria-hidden="true">
          ›
        </span>
        {count === 1 ? 'Ran 1 step' : `Ran ${count} steps`}
      </button>
      {open && (
        <div className="steps-body">
          {error && (
            <p className="form-error">
              Couldn't load the steps: {error}{' '}
              <button type="button" className="link-btn" onClick={() => void fetchSteps()}>
                Retry
              </button>
            </p>
          )}
          {!turns && !error && <p className="hint">Loading…</p>}
          {turns?.map((t, i) => (
            <div key={t.turnId}>
              {turns.length > 1 && (
                <p className="steps-attempt">
                  Attempt {i + 1}
                  {t.outcome !== 'ok' ? ` · ${t.outcome}` : ''}
                </p>
              )}
              {t.steps.length ? <StepList turn={t} /> : <p className="hint">No steps.</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const messageSteps = (id: string) => () => api.messageSteps(id).then((t) => [t]);
export const runSteps = (id: string) => () => api.runSteps(id);
