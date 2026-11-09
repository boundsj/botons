import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, BotTemplate, ReviewItemState, Routine, RoutineRun, SetupCheck, SetupCheckItem, TemplateReview } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText } from '../feedback.ts';
import { cx } from '../util.ts';
import { PlayIcon } from './Icons.tsx';

/*
 * A starter template, set up as the owner sees fit: the review before it is installed (what it needs, which of the
 * owner's connectors fill its slots, exactly what it grants), then, once installed with its routines paused, the
 * setup check, a test run per routine and turning each on. Every decision is the server's: this only shows it.
 */

export type Slots = Record<string, string | null>;

const STATE_WORD: Record<ReviewItemState | SetupCheckItem['state'], string> = { ok: 'OK', warning: 'Note', blocked: 'Blocked', problem: 'Problem', unverified: 'Not verified' };

function State({ state }: { state: ReviewItemState | SetupCheckItem['state'] }) {
  return <span className={cx('starter-state', `is-${state}`)}>{STATE_WORD[state]}</span>;
}

/** The review: shown under the New Boton form while a starter is picked. Reports the review it shows (or null). */
export function StarterReview(props: {
  template: BotTemplate;
  provider: string;
  access: 'workspace' | 'host';
  slots: Slots;
  onSlots: (s: Slots) => void;
  onReview: (r: TemplateReview | null) => void;
  /** Bumped by the dialog to ask for a fresh review (after a stale install, or a connector added). */
  refresh: number;
  /** Opens Connect a service: the dialog renders it outside its form, whose submit it must not reach. */
  onConnect: () => void;
}) {
  const { template, provider, access, slots, onSlots, onReview, refresh, onConnect } = props;
  const n = template.needs!;
  const [review, setReview] = useState<TemplateReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    onReview(null);
    try {
      const r = await api.reviewTemplate(template.id, { provider, access, connectors: slots });
      if (mine !== seq.current) return;
      setReview(r);
      setError(null);
      onReview(r);
    } catch (e) {
      if (mine !== seq.current) return;
      setReview(null);
      setError(errorText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [template.id, provider, access, slots, onReview]);

  useEffect(() => {
    void load();
  }, [load, refresh, checks]);

  return (
    <section className="starter-review" aria-label={`Review ${template.name}`}>
      <span className="field-label">What {template.name} needs</span>
      <dl className="starter-needs">
        <dt>Brain</dt>
        <dd>{n.brain.text}</dd>
        <dt>Access</dt>
        <dd>
          {n.access === 'workspace' ? 'Workspace access' : 'Full computer access'}. {n.accessWhy}
        </dd>
        <dt>Schedule</dt>
        <dd>{n.schedule}</dd>
        <dt>Output</dt>
        <dd>{n.output.text}</dd>
        <dt>If a run fails</dt>
        <dd>{n.failure}</dd>
      </dl>

      {n.connectors.length > 0 && (
        <div className="starter-slots">
          <span className="field-label">Connectors</span>
          {n.connectors.map((need) => {
            const slot = review?.slots.find((s) => s.slot === need.slot);
            return (
              <div key={need.slot} className="starter-slot" data-slot={need.slot}>
                <label>
                  <span>
                    {need.label} {need.required ? '(required)' : '(optional)'}: {need.purpose}
                  </span>
                  <select
                    value={slots[need.slot] ?? ''}
                    onChange={(e) => onSlots({ ...slots, [need.slot]: e.target.value || null })}
                    aria-label={`Connector for ${need.label}`}
                  >
                    <option value="">{need.required ? 'Choose one of yours…' : 'None'}</option>
                    {slot?.candidates.map((c) => (
                      <option key={c.id} value={c.id} disabled={!!c.problem && slots[need.slot] !== c.id}>
                        {c.name}
                        {c.suggested ? ' (suggested)' : ''}
                        {c.problem ? `: ${c.problem}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {slot && (
                  <p className="hint">
                    <State state={slot.state} /> {slot.text}
                  </p>
                )}
                {slot?.guidance && (
                  <div className="starter-guidance" role="note">
                    <p>{slot.guidance}</p>
                    <div className="routine-actions">
                      <button type="button" className="btn small" onClick={onConnect}>
                        Connect a service
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => setChecks((x) => x + 1)}>
                        Check again
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="starter-grants" aria-live="polite">
        <span className="field-label">Exactly what installing it grants</span>
        {loading && !review && <p className="hint">Reviewing…</p>}
        {error && <p className="form-error">Couldn't review it: {error}</p>}
        {review && (
          <>
            <ul>
              <li>
                <State state={review.brain.state} /> {review.brain.text}
              </li>
              <li>
                <State state={review.access.state} /> {review.access.text}
              </li>
              {review.grants.slice(2).map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            {review.blocked.length > 0 && (
              <div className="form-error" role="alert">
                <p>It can't be installed yet:</p>
                <ul>
                  {review.blocked.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="hint">Its text asks for things; only what is listed here is granted. Its routines start paused: after installing, check it, test it, then turn them on.</p>
          </>
        )}
      </div>
    </section>
  );
}

const finished = (r: RoutineRun) => r.status === 'succeeded' || r.status === 'failed' || r.status === 'skipped';

/**
 * After the install, or later from the Routines panel: the setup check, a test run per routine, and turning each on.
 * The starter and its slots are the ones the server saved at the install.
 */
export function StarterSetup({ bot, template, onDone }: { bot: Bot; template: BotTemplate; onDone: () => void }) {
  const [check, setCheck] = useState<SetupCheck | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const [c, list] = await Promise.all([api.setupCheck(bot.id), api.routines(bot.id)]);
      setCheck(c);
      setRoutines(list);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  }, [bot.id]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  return (
    <div className="starter-setup">
      <p>
        <strong>{bot.name}</strong> is installed from {template.name}.{' '}
        {template.routines.length ? 'Its routines stay paused until you turn them on here: nothing else, the Boton included, can turn them on first.' : 'It has no routines: it works when asked in chat.'}
      </p>
      <section aria-label="Setup check">
        <div className="starter-head">
          <span className="field-label">Setup check</span>
          <button type="button" className="btn small ghost" onClick={() => void recheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {check && (
          <>
            <ul className="starter-check">
              {check.items.map((i) => (
                <li key={i.key} data-key={i.key}>
                  <State state={i.state} /> <strong>{i.label}</strong>: {i.text}
                </li>
              ))}
            </ul>
            <p className="hint">{check.scope}</p>
            <details>
              <summary>What no check here can verify</summary>
              <ul>
                {check.notChecked.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>
      {routines?.map((r) => (
        <RoutineStep key={r.id} routine={r} sample={template.needs?.samplePayload ?? null} check={check} onChanged={recheck} />
      ))}
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={onDone}>
          Open {bot.name}
        </button>
      </div>
    </div>
  );
}

function RoutineStep({ routine: r, sample, check, onChanged }: { routine: Routine; sample: string | null; check: SetupCheck | null; onChanged: () => Promise<void> }) {
  const [payload, setPayload] = useState(sample ?? '');
  const [run, setRun] = useState<RoutineRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anyway, setAnyway] = useState(false);
  const gate = check?.routines.find((g) => g.routineId === r.id) ?? null;
  // A test of ours under way, or one the server says is: no earlier pass counts until it ends.
  const testing = (!!run && !finished(run)) || !!gate?.testing;
  const passed = !!gate?.tested && !testing;

  // Waits for the test run to finish, then has the check say how it went.
  useEffect(() => {
    if (!run || finished(run)) return;
    let live = true;
    const t = setInterval(async () => {
      try {
        const now = (await api.runs(r.id)).find((x) => x.id === run.id);
        if (!live || !now) return;
        setRun(now);
        if (finished(now)) void onChanged();
      } catch {}
    }, 700);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [run, r.id, onChanged]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setRun(await api.runRoutine(r.id, r.webhook ? { test: true, payload } : { test: true }));
      // At once, so an earlier pass stops showing as one while this runs.
      void onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.activateRoutine(r.id, passed ? {} : { override: true });
      setAnyway(false);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="starter-routine" aria-label={`Routine ${r.name}`} data-routine={r.name}>
      <span className="field-label">Routine: {r.name}</span>
      <p className="hint">
        A test run is a real turn on the Boton's brain. It is told to treat it as a dry run (read and check, but do nothing hard to undo or outside this computer, and say
        what it would have done), but nothing enforces that: it can use every tool it has. It pushes nothing and sends no callback.
        {r.webhook ? ' Like a webhook run, it is held to Workspace access and gets no connectors.' : " It has the Boton's access and connectors, so what it reads, and anything it does, is real."}
      </p>
      {r.webhook && (
        <label>
          <span className="field-label">Sample request</span>
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={4} spellCheck={false} aria-label={`Sample request for ${r.name}`} />
        </label>
      )}
      {run && (
        <div className={cx('starter-run', `is-${run.status}`)} role="status">
          {!finished(run) ? (
            <p>Test run {run.status}…</p>
          ) : run.status === 'succeeded' ? (
            <>
              <p>
                <strong>Test run finished without an error.</strong> That shows the brain ran it, not that the reply is right: read it.
              </p>
              <pre>{(run.reply ?? '').slice(0, 2000)}</pre>
            </>
          ) : (
            <p>
              <strong>Test run {run.status}:</strong> {run.error ?? 'no reason given'}. Fix what it says (its chat has the details), then test again.
            </p>
          )}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="routine-actions">
        <button type="button" className="btn small" onClick={() => void start()} disabled={busy || (!!run && !finished(run))}>
          <PlayIcon size={14} /> {run ? 'Test again' : 'Run a test'}
        </button>
        {r.enabled ? (
          <span className="starter-on">On</span>
        ) : (
          <button type="button" className="btn small primary" onClick={() => void turnOn()} disabled={busy || !gate || testing || (!passed && !anyway)}>
            Turn on {r.name}
          </button>
        )}
      </div>
      {gate && !r.enabled && <p className="hint">{gate.text}</p>}
      {!r.enabled && gate?.pending && !passed && !testing && (
        <label className="check">
          <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
          <span>Turn it on without a test run that passed on its current settings (recorded as an override)</span>
        </label>
      )}
    </section>
  );
}
