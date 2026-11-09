import { useCallback, useEffect, useState } from 'react';
import type { BackgroundActivity, BackgroundItem, Bot } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText } from '../feedback.ts';
import { clock, cx, dateTime, dayLabel } from '../util.ts';
import { messageSteps, runSteps, StepsToggle } from './Steps.tsx';

const when = (iso: string) => (dayLabel(iso) === 'Today' ? clock(iso) : `${dayLabel(iso)} ${clock(iso)}`);

function outcomeText(i: BackgroundItem): string {
  if (i.quiet) return 'Quiet: nothing in the chat';
  if (i.outcome === 'ok') return i.runId || i.routineId ? 'Ran' : 'Replied in the chat';
  if (i.outcome === 'error') return 'Failed';
  if (i.outcome === 'running' || i.outcome === null) return 'Not done yet';
  return i.outcome.charAt(0).toUpperCase() + i.outcome.slice(1);
}

/**
 * What the Boton did in the background in the last day: each routine turn and automatic wake-up, quiet ones with the
 * note their turn kept (they leave nothing in the chat), and the steps of each. The chat's background line opens it.
 */
export function ActivityTab({ bot, onOpenRoutine }: { bot: Bot; onOpenRoutine: (id: string) => void }) {
  const [data, setData] = useState<{ botId: string; a: BackgroundActivity } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api.background(bot.id).then(
      (a) => setData({ botId: bot.id, a }),
      (e) => setError(errorText(e)),
    );
  }, [bot.id]);
  const lastAt = bot.lastMessage?.createdAt;
  const idle = bot.status.state === 'idle';
  useEffect(load, [load, idle, lastAt]);
  const a = data?.botId === bot.id ? data.a : null;
  return (
    <div className="tab-body activity-tab">
      <p className="muted">
        Routines, webhooks, connector updates, other Botons and follow-ups that woke {bot.name} in the last day. A quiet one posts nothing in the chat; its note is
        kept here.
      </p>
      {error && (
        <p className="form-error">
          Couldn't load the activity: {error}{' '}
          <button type="button" className="link-btn" onClick={load}>
            Retry
          </button>
        </p>
      )}
      {!a && !error && <p className="hint">Loading…</p>}
      {a && !a.recent.length && <p className="hint">Nothing in the last day.</p>}
      {a && a.recent.length > 0 && (
        <ol className="activity-list">
          {a.recent.map((i, n) => (
            <li key={`${i.at}-${n}`} className={cx('activity-item', i.quiet && 'quiet', i.warn && 'warn')}>
              <div className="activity-head">
                {i.routineId ? (
                  <button type="button" className="chip-link activity-label" onClick={() => onOpenRoutine(i.routineId!)} title={i.detail}>
                    {i.label}
                  </button>
                ) : (
                  <span className="activity-label" title={i.detail}>
                    {i.label}
                  </span>
                )}
                <time dateTime={i.at} title={dateTime(i.at)}>
                  {when(i.at)}
                </time>
              </div>
              <div className="activity-outcome muted">
                {outcomeText(i)}
                {i.quiet && i.note ? (
                  <>
                    {' · '}
                    <span className="activity-note">{i.note}</span>
                  </>
                ) : null}
              </div>
              {i.steps > 0 && (i.runId || i.stepsMessageId) && <StepsToggle count={i.steps} load={i.runId ? runSteps(i.runId) : messageSteps(i.stepsMessageId!)} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
