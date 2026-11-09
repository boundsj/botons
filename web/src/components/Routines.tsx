import { useEffect, useId, useRef, useState } from 'react';
import type {
  Bot,
  BotTemplate,
  CallbackDelivery,
  NotifyDelivery,
  NotifyPolicy,
  ProviderInfo,
  Routine,
  RoutineRun,
  RoutineSession,
  RunsAttention,
  SchedulePreview,
  StarterInstall,
  WebhookFilter,
  WebhookSource,
} from '../../../shared/types.ts';
import { ATTENTION_DAYS, durationText, isPastOneOff, MIN_TIME_LIMIT_MS } from '../../../shared/util.ts';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';
import { attempt } from '../feedback.ts';
import { shownEffort } from '../effort.ts';
import { clip, copy, costText, cx, dateTime, duration, isValidTimezone, type LimitUnit, limitBounds, limitFrom, limitInput, relative, tokens, totalTokens, usageText } from '../util.ts';
import { EffortField, TimezoneField } from './BotFields.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { StarterSetup } from './StarterSetup.tsx';
import { CopyIcon, EditIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon, WebhookIcon } from './Icons.tsx';
import { LoadError, useLoad } from './Load.tsx';
import { useActiveRef } from './PageActive.ts';
import { skillsFor } from '../skills.ts';
import { useSkills } from './SkillPicker.tsx';
import { runSteps, StepsToggle } from './Steps.tsx';

export function RoutinesTab({ bot, focusId }: { bot: Bot; focusId: string | null }) {
  const routines = useStore((s) => s.routines[bot.id]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(focusId);
  const load = useLoad(() => actions.loadRoutines(bot.id), bot.id);
  // A starter's routines waiting on the owner: turned on from its setup, never with Resume (the server refuses that).
  const [starter, setStarter] = useState<StarterInstall | null>(null);
  const [setup, setSetup] = useState<BotTemplate | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .starterInstall(bot.id)
      .then((x) => live && setStarter(x))
      .catch(() => live && setStarter(null));
    return () => {
      live = false;
    };
  }, [bot.id, routines]);
  const openSetup = () =>
    void attempt(
      'open its setup',
      async () => {
        const t = (await api.templates()).find((x) => x.id === starter?.templateId && x.needs);
        if (!t) throw new Error(`Its starter (${starter?.templateName}) is not on this server any more.`);
        setSetup(t);
      },
      setSetupError,
    );

  useEffect(() => {
    if (focusId) setOpen(focusId);
  }, [focusId]);

  return (
    <div className="tab-body">
      <div className="tab-intro">
        <p className="muted">
          Routines run on a schedule, from a webhook, or on demand. Results land in the chat. You can also just ask {bot.name} to set one up.
        </p>
        {!creating && (
          <button className="btn primary small" onClick={() => setCreating(true)}>
            <PlusIcon size={16} /> New routine
          </button>
        )}
      </div>
      {creating && (
        <RoutineEditor
          bot={bot}
          onDone={(r) => {
            setCreating(false);
            if (r) setOpen(r.id);
          }}
        />
      )}
      {routines === undefined && (load.error ? <LoadError what="routines" error={load.error} onRetry={load.retry} /> : <p className="muted">Loading…</p>)}
      {routines?.length === 0 && !creating && <p className="empty-note">No routines yet.</p>}
      <ul className="routine-list">
        {routines?.map((r) => (
          <li key={r.id}>
            <RoutineCard routine={r} bot={bot} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} starterPending={!!starter?.pending.includes(r.id)} onSetup={openSetup} />
          </li>
        ))}
      </ul>
      {setupError && <p className="form-error">{setupError}</p>}
      {setup && (
        <Dialog title={`Set up ${bot.name}`} onClose={() => setSetup(null)} wide>
          <StarterSetup bot={bot} template={setup} onDone={() => setSetup(null)} />
        </Dialog>
      )}
    </div>
  );
}

function RoutineCard(props: { routine: Routine; bot: Bot; open: boolean; onToggle: () => void; starterPending: boolean; onSetup: () => void }) {
  const { routine: r, bot, open, onToggle, starterPending, onSetup } = props;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const act = async (label: string, what: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    await attempt(what, fn, setError);
    setBusy(null);
  };

  if (editing) return <RoutineEditor bot={bot} routine={r} onDone={() => setEditing(false)} />;
  const done = !r.enabled && isPastOneOff(r.schedule);

  return (
    <article className={cx('routine-card', open && 'open', !r.enabled && 'paused')}>
      <button className="routine-head" onClick={onToggle} aria-expanded={open}>
        <span className="routine-title">
          {r.lastStatus && <span className={cx('status-dot', r.lastStatus)} title={`Last run ${r.lastStatus}`} />}
          {r.name}
        </span>
        <span className="routine-sub">
          {r.scheduleText ?? (r.webhook ? 'Webhook only' : 'On demand')}
          {r.webhook && r.schedule && (
            <span className="badge" title="Has a webhook">
              <WebhookIcon size={12} /> webhook
            </span>
          )}
        </span>
        <span className="routine-next">
          {done ? <span className="pill">Done</span> : !r.enabled ? <span className="pill">Paused</span> : r.nextRunAt ? `Next ${relative(r.nextRunAt)}` : r.lastRunAt ? `Ran ${relative(r.lastRunAt)}` : ''}
        </span>
      </button>

      {open && (
        <div className="routine-body">
          <p className="routine-instruction">{r.instruction}</p>
          {r.skill && (
            <p className="hint">
              Follows the skill <code>/{r.skill}</code>
            </p>
          )}
          <div className="routine-actions">
            <button className="btn small" disabled={!!busy} onClick={() => act('run', 'start a run', () => api.runRoutine(r.id))}>
              <PlayIcon size={14} /> {busy === 'run' ? 'Starting…' : 'Run now'}
            </button>
            {starterPending && !r.enabled ? (
              <button className="btn small primary" onClick={onSetup} title="It came with a starter: you turn it on from its setup, after a test run">
                <PlayIcon size={14} /> Set up to turn on
              </button>
            ) : !done && (
              <button
                className="btn small"
                disabled={!!busy}
                onClick={() => act('toggle', r.enabled ? 'pause the routine' : 'resume the routine', () => api.updateRoutine(r.id, { enabled: !r.enabled }))}
              >
                {r.enabled ? <PauseIcon size={14} /> : <PlayIcon size={14} />} {r.enabled ? 'Pause' : 'Resume'}
              </button>
            )}
            <button className="btn small" onClick={() => setEditing(true)}>
              <EditIcon size={14} /> Edit
            </button>
            <button className="btn small danger" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
              <TrashIcon size={14} /> Delete
            </button>
          </div>
          {confirmDelete && (
            <ConfirmDialog
              title={`Delete “${r.name}”?`}
              confirmLabel="Delete routine"
              what="delete the routine"
              danger
              onConfirm={() => api.deleteRoutine(r.id)}
              onClose={() => setConfirmDelete(false)}
            >
              <p>
                Its schedule stops{r.webhook ? ' and its webhook stops working (callers will get 401)' : ''}, queued runs are cancelled, and its run history is deleted. A
                run already in progress still finishes and posts its reply.
              </p>
            </ConfirmDialog>
          )}
          {error && <p className="form-error">{error}</p>}
          {done && <p className="hint">This one-off has run. Edit it and give it a new time to run it again.</p>}
          {(r.model || r.session === 'own') && (
            <p className="hint">
              {[r.model ? `Runs on ${r.model}` : null, r.session === 'own' ? 'in its own session (apart from the chat)' : null].filter(Boolean).join(' ')}
            </p>
          )}
          {r.timeLimitMs !== null && <p className="hint">Each run is stopped if it takes longer than {durationText(r.timeLimitMs)}</p>}
          {r.enabled && r.nextRunAt && <p className="hint">Next run {dateTime(r.nextRunAt, r.timezone)} ({r.timezone})</p>}
          {r.webhook ? (
            <WebhookBox routine={r} bot={bot} />
          ) : (
            <button className="link-btn" disabled={!!busy} onClick={() => act('hook', 'add a webhook', () => api.updateRoutine(r.id, { webhook: true }))}>
              <WebhookIcon size={14} /> Add a webhook trigger
            </button>
          )}
          <RunHistory routineId={r.id} />
        </div>
      )}
    </article>
  );
}

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <span className="field-label">{label}</span>
      <div className="copy-row">
        <code className="copy-value">{shown ? value : '•'.repeat(24)}</code>
        {secret && (
          <button className="link-btn" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </button>
        )}
        <button
          className="icon-btn small"
          aria-label={`Copy ${label}`}
          title="Copy"
          onClick={async () => {
            if (await copy(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
        >
          {copied ? '✓' : <CopyIcon size={14} />}
        </button>
      </div>
    </div>
  );
}

const SOURCES: { value: WebhookSource; label: string; setup?: string }[] = [
  { value: 'generic', label: 'Anything (callers send the key)' },
  { value: 'github', label: 'GitHub', setup: 'In the repository or organization: Settings → Webhooks → Add webhook. Payload URL: the URL above; Content type: application/json; Secret: the key above (or a secret of your own, saved in the routine editor). GitHub signs every delivery, and its ping is answered without a run.' },
  { value: 'linear', label: 'Linear', setup: 'In Linear: Settings → API → Webhooks → New webhook, with the URL above. Then copy the signing secret Linear shows into the routine editor; until then deliveries are refused.' },
  { value: 'slack', label: 'Slack', setup: "Save your Slack app's Signing Secret (Basic Information) in the routine editor first, then use the URL above as the Request URL (Event Subscriptions, Slash Commands or Interactivity). Slack's URL check is answered without a run, and its retries are dropped." },
  { value: 'sentry', label: 'Sentry', setup: "In Sentry: Settings → Developer Settings → a custom integration, with the URL above as its Webhook URL. Save the integration's Client Secret in the routine editor; until then deliveries are refused." },
];

function filterText(f: WebhookFilter): string {
  const values = f.values.length === 1 ? f.values[0] : `${f.values.slice(0, -1).join(', ')} or ${f.values.at(-1)}`;
  return `Runs only when ${f.kind === 'header' ? `the ${f.name} header` : `the body's ${f.name}`} is ${values}; other deliveries are skipped.`;
}

function WebhookBox({ routine: r, bot }: { routine: Routine; bot: Bot }) {
  const hook = r.webhook!;
  const [confirming, setConfirming] = useState<'rotate' | 'remove' | null>(null);
  const [testing, setTesting] = useState(false);
  const curl = `curl -X POST '${hook.url}' \\\n  -H 'Authorization: Bearer ${hook.key}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello": "world"}'`;
  const signed = hook.source !== 'generic';
  const source = SOURCES.find((s) => s.value === hook.source);
  const needsSecret = signed && hook.source !== 'github' && !hook.hasSecret;
  return (
    <div className="webhook-box">
      <h4>
        <WebhookIcon size={14} /> Webhook{signed ? ` from ${source?.label}` : ''}
      </h4>
      <CopyField label="POST to" value={hook.url} />
      <CopyField label={hook.source === 'github' && !hook.hasSecret ? 'Key (also the GitHub secret)' : signed ? 'Key' : 'Key (Bearer token)'} value={hook.key} secret />
      {needsSecret && <p className="hint warn">No signing secret saved yet: deliveries are refused (401) until you add it in the editor.</p>}
      {hook.filter && <p className="hint">{filterText(hook.filter)}</p>}
      {hook.callbackUrl && <p className="hint">Each finished run’s result (not a test run’s) is POSTed to {hook.callbackUrl}, signed with the key (X-Boton-Signature).</p>}
      {signed ? (
        <details>
          <summary>Setup</summary>
          <p className="hint">{source?.setup}</p>
          <p className="hint">Only deliveries with a valid signature run; the key alone is not enough.</p>
        </details>
      ) : (
        <details>
          <summary>Example</summary>
          <pre className="code">{curl}</pre>
          <p className="hint">
            The body is handed to the Boton with the instruction, marked as data from outside (never as instructions from you). Returns 202 once the run is queued,
            with a <code>Location</code> to poll (GET it with the same key); add <code>?wait=1</code> to wait for the result.
          </p>
        </details>
      )}
      {bot.access === 'host' && (
        <p className={cx('hint', !r.webhookWorkspace && 'warn')}>
          {r.webhookWorkspace ? 'Webhook runs use Workspace access (sandboxed).' : 'Webhook runs use Full computer access.'}
        </p>
      )}
      {testing && <TestBox routine={r} onClose={() => setTesting(false)} />}
      <div className="routine-actions">
        {!testing && (
          <button className="btn small" onClick={() => setTesting(true)}>
            <PlayIcon size={14} /> Test
          </button>
        )}
        <button className="btn small" onClick={() => setConfirming('rotate')}>
          New key
        </button>
        <button className="btn small" onClick={() => setConfirming('remove')}>
          Remove webhook
        </button>
      </div>
      {confirming === 'rotate' && (
        <ConfirmDialog
          title="Make a new webhook key?"
          confirmLabel="Make a new key"
          what="make a new key"
          danger
          onConfirm={() => api.updateRoutine(r.id, { rotateKey: true })}
          onClose={() => setConfirming(null)}
        >
          <p>The current key stops working at once. Callers using the old key will get 401 until you give them the new one.</p>
        </ConfirmDialog>
      )}
      {confirming === 'remove' && (
        <ConfirmDialog
          title="Remove the webhook?"
          confirmLabel="Remove webhook"
          what="remove the webhook"
          danger
          onConfirm={() => api.updateRoutine(r.id, { webhook: false })}
          onClose={() => setConfirming(null)}
        >
          <p>
            The URL stops accepting calls: callers will get 401. {r.schedule ? 'The schedule keeps running.' : 'The routine can still be run by hand.'} Adding a
            webhook again makes a new key.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

const SAMPLE_PAYLOAD = '{\n  "hello": "world"\n}';

function TestBox({ routine: r, onClose }: { routine: Routine; onClose: () => void }) {
  const [payload, setPayload] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const last = (await api.runs(r.id)).find((run) => run.trigger === 'webhook' && run.payloadBytes > 0);
        if (!last) return current && setPayload(SAMPLE_PAYLOAD);
        let text = (await api.runPayload(last.id)).payload ?? '';
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {}
        if (!current) return;
        setPayload(text);
        setFrom(last.startedAt);
      } catch {
        if (current) setPayload(SAMPLE_PAYLOAD);
      }
    })();
    return () => {
      current = false;
    };
  }, [r.id]);

  const run = async () => {
    setBusy(true);
    setError(null);
    if (await attempt('start a test run', () => api.runRoutine(r.id, { payload: payload ?? '' }), setError)) setQueued(true);
    setBusy(false);
  };

  return (
    <div className="test-box">
      <span className="field-label">Test payload</span>
      {payload === null ? (
        <p className="hint">Loading the last delivery…</p>
      ) : (
        <textarea value={payload} onChange={(e) => {
            setPayload(e.target.value);
            setQueued(false);
          }} rows={8} spellCheck={false} aria-label="Test payload" />
      )}
      <p className="hint">
        {from ? `From the last webhook delivery (${relative(from)}). ` : ''}Runs like a webhook call, as a dry run: the Boton is told to avoid anything hard to undo. It
        doesn’t change the status dot, push to your phone or send its result to the callback URL.
      </p>
      {error && <p className="form-error">{error}</p>}
      {queued && <p className="hint">Test run queued; its result shows in the run history and the chat.</p>}
      <div className="routine-actions">
        <button className="btn small primary" disabled={busy || payload === null} onClick={() => void run()}>
          <PlayIcon size={14} /> {busy ? 'Starting…' : 'Run test'}
        </button>
        <button className="btn small ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function RunHistory({ routineId }: { routineId: string }) {
  const runs = useStore((s) => s.runs[routineId]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const load = useLoad(() => actions.loadRuns(routineId), routineId);
  if (!runs) return load.error ? <LoadError what="run history" error={load.error} onRetry={load.retry} /> : null;
  return (
    <div className="runs">
      <h4>Run history</h4>
      {runs.length === 0 && <p className="hint">No runs yet. Try “Run now”.</p>}
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <button className="run-row" onClick={() => setOpenRun(openRun === run.id ? null : run.id)} aria-expanded={openRun === run.id}>
              <span className={cx('status-dot', run.quiet ? 'quiet' : run.meta?.cancelled ? 'skipped' : run.status)} />
              <span>{runLabel(run)}</span>
              <span className="run-trigger">{run.trigger}</span>
              <span className="run-time" title={dateTime(run.startedAt)}>
                {relative(run.startedAt)}
              </span>
            </button>
            {openRun === run.id && (run.status === 'queued' || run.status === 'running' || run.error || run.reply || run.payloadPreview || run.lastError || run.quiet || run.meta?.notifications?.length || run.meta?.callback || run.usage || run.steps > 0) && (
              <div className="run-detail">
                {run.quiet && <p className="hint">Nothing worth reporting, so nothing was posted in the chat.</p>}
                {run.status === 'queued' && run.retryAt && (
                  <p className="hint">
                    Trying again {dateTime(run.retryAt)}
                    {run.lastError ? `. Last attempt: ${run.lastError}` : ''}
                  </p>
                )}
                {(run.status === 'queued' || run.status === 'running') && <CancelRun run={run} />}
                {run.status !== 'queued' && run.lastError && run.lastError !== run.error && <p className="hint">An earlier attempt failed: {run.lastError}</p>}
                {run.meta?.retryOf && <p className="hint">Retry of an earlier run that failed{run.meta.retryOf.error ? `: ${run.meta.retryOf.error}` : ''}</p>}
                {run.meta?.cancelled ? (
                  <p className="hint">
                    {run.error ?? 'Cancelled'} {dateTime(run.meta.cancelled.at)}:{' '}
                    {run.meta.cancelled.started ? 'an attempt at it ran, so it may have partly run.' : 'it never started.'} It is not tried again by itself.
                  </p>
                ) : (
                  run.error && <p className={run.status === 'skipped' ? 'hint' : 'form-error'}>{run.error}</p>
                )}
                {run.meta?.timedOut && <p className="hint">It isn't tried again by itself. If it needs longer, edit the routine and raise its time limit.</p>}
                {run.status === 'failed' && <RetryRun run={run} />}
                {run.payloadPreview !== null && <RunPayloadView run={run} />}
                {run.reply && (
                  <>
                    <span className="field-label">{run.quiet ? 'Note' : 'Reply'}</span>
                    <p className="run-reply">{clip(run.reply, 600)}</p>
                  </>
                )}
                {run.meta?.notifications?.map((d, i) => (
                  <p key={i} className={cx('hint', !d.ok && 'warn')} title={dateTime(d.at)}>
                    {deliveryText(d)}
                  </p>
                ))}
                {run.meta?.callback && <CallbackStatus run={run} />}
                {run.steps > 0 && <StepsToggle count={run.steps} load={runSteps(run.id)} />}
                {run.usage && (
                  <p className="hint">
                    {usageText(run.usage)}
                    {run.model ? ` · ${run.model}` : ''}
                    {run.usage.costUsd ? ` · ${costText(run.usage.costUsd)}` : ''}
                    {run.attempts > 1 ? ` (${run.attempts} attempts together)` : ''}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A failed run is retried once, as its trigger with its payload: the owner checks the error first. */
function RetryRun({ run, onRetried }: { run: RoutineRun; onRetried?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (run.meta?.retriedAs) return <p className="hint">Retried: see the newer run above.</p>;
  const ran = !run.meta?.cancelled || run.meta.cancelled.started;
  const retry = () => {
    setBusy(true);
    void attempt('retry the run', () => api.retryRun(run.id), setError)
      .then((r) => r && onRetried?.())
      .finally(() => setBusy(false));
  };
  return (
    <>
      <p className="hint">
        {ran ? 'It may have partly run. ' : ''}
        {run.payloadBytes > 0 ? 'Retrying runs it again with the same payload' : 'Retrying runs it again'}
        {ran ? ', and the Boton is told to check what was already done.' : '.'}{' '}
        <button className="link-btn" onClick={retry} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry this run'}
        </button>
      </p>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}

/** Ends this run only: the Boton's chat and its other runs carry on. */
function CancelRun({ run, onCancelled }: { run: RoutineRun; onCancelled?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    setBusy(true);
    void attempt('cancel the run', () => api.cancelRun(run.id), setError)
      .then((r) => r && onCancelled?.())
      .finally(() => setBusy(false));
  };
  return (
    <>
      <p className="hint">
        {run.status === 'running'
          ? 'Cancelling stops its agent now; what it already did stays done.'
          : run.attempts > 0
            ? 'Cancelling means it is not tried again; its earlier attempt may have partly run.'
            : 'Cancelling means it never starts.'} It is not tried again by itself.{' '}
        <button className="link-btn" onClick={cancel} disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel this run'}
        </button>
      </p>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}

/** Where a run's result went; a failed callback can be sent again once the receiver is fixed. */
function CallbackStatus({ run, onSent }: { run: RoutineRun; onSent?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = run.meta!.callback!;
  const resend = () => {
    setBusy(true);
    void attempt('resend the result', () => api.resendCallback(run.id), setError)
      .then((r) => r && onSent?.())
      .finally(() => setBusy(false));
  };
  return (
    <>
      <p className={cx('hint', !d.ok && !d.pending && 'warn')} title={dateTime(d.at)}>
        {callbackText(d)}
        {!d.ok && !d.pending && (
          <>
            {' '}
            <button className="link-btn" onClick={resend} disabled={busy}>
              {busy ? 'Sending…' : 'Send it again'}
            </button>
          </>
        )}
      </p>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}

/** Settings: every Boton's failed runs nobody retried yet, and runs waiting to try again, so none is missed. */
export function RunsToCheck() {
  const [data, setData] = useState<RunsAttention | null>(null);
  const [refresh, setRefresh] = useState(0);
  const active = useActiveRef();
  useEffect(() => {
    const timer = window.setInterval(() => active.current && setRefresh((n) => n + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const load = useLoad(async () => setData(await api.runsAttention()), `runs-attention:${refresh}`);
  const reload = () => void api.runsAttention().then(setData, () => load.retry());
  return (
    <section className="server-info runs-to-check">
      <h4>Runs to check</h4>
      <p className="hint">
        Routine runs that failed in the last {ATTENTION_DAYS} days and were not retried, runs waiting to try again by themselves, and runs whose result never reached the callback URL. Test runs are not listed.
      </p>
      {!data && (load.error ? <LoadError what="runs to check" error={load.error} onRetry={load.retry} /> : <p className="hint">Loading…</p>)}
      {data && !data.failed.length && !data.held.length && !data.callbacks.length && <p className="hint">Nothing to check.</p>}
      {data && (data.failed.length > 0 || data.held.length > 0 || data.callbacks.length > 0) && (
        <ul className="device-list audit-list">
          {data.failed.map((run) => (
            <li key={run.id}>
              <span className="device-text">
                <span>
                  <span className="status-dot failed" aria-hidden="true" /> <strong>{run.botName}</strong> · {run.routineName}
                </span>
                <span className="hint">
                  {run.trigger} run, failed{' '}
                  <time dateTime={run.finishedAt ?? run.startedAt} title={dateTime(run.finishedAt ?? run.startedAt)}>
                    {relative(run.finishedAt ?? run.startedAt)}
                  </time>
                </span>
                {run.error && <span className="form-error">{clip(run.error, 300)}</span>}
                <RetryRun run={run} onRetried={reload} />
              </span>
            </li>
          ))}
          {data.held.map((run) => (
            <li key={run.id}>
              <span className="device-text">
                <span>
                  <span className="status-dot queued" aria-hidden="true" /> <strong>{run.botName}</strong> · {run.routineName}
                </span>
                <span className="hint">
                  {run.trigger} run, trying again {run.retryAt ? dateTime(run.retryAt) : 'soon'}
                  {run.lastError ? `. Last attempt: ${clip(run.lastError, 200)}` : ''}
                </span>
                <CancelRun run={run} onCancelled={reload} />
              </span>
            </li>
          ))}
          {data.callbacks.map((run) => (
            <li key={`callback-${run.id}`}>
              <span className="device-text">
                <span>
                  <span className="status-dot failed" aria-hidden="true" /> <strong>{run.botName}</strong> · {run.routineName}
                </span>
                <span className="hint">
                  {run.trigger} run, {run.status}{' '}
                  <time dateTime={run.finishedAt ?? run.startedAt} title={dateTime(run.finishedAt ?? run.startedAt)}>
                    {relative(run.finishedAt ?? run.startedAt)}
                  </time>
                  , result not delivered
                </span>
                <CallbackStatus run={run} onSent={reload} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunPayloadView({ run }: { run: RoutineRun }) {
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cut = new TextEncoder().encode(run.payloadPreview ?? '').length < run.payloadBytes;
  return (
    <>
      {run.headers && (
        <>
          <span className="field-label">Headers</span>
          <pre className="code">{Object.entries(run.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
        </>
      )}
      <span className="field-label">Payload{run.payloadBytes >= 1024 ? ` · ${Math.round(run.payloadBytes / 1024)} KB` : ''}</span>
      <pre className="code">
        {full ?? run.payloadPreview}
        {full === null && cut ? '…' : ''}
      </pre>
      {full === null && cut && (
        <button className="link-btn" onClick={() => attempt('load the payload', async () => setFull((await api.runPayload(run.id)).payload ?? ''), setError)}>
          Show all of it
        </button>
      )}
      {error && <p className="form-error">{error}</p>}
    </>
  );
}

function runLabel(run: RoutineRun): string {
  const tries = run.attempts > 1 ? ` · attempt ${run.attempts}` : '';
  if (run.status === 'running') return `Running${tries}`;
  if (run.status === 'queued') return run.retryAt ? `Waiting · tries again ${relative(run.retryAt)}` : 'Queued';
  if (run.status === 'skipped') return 'Skipped';
  const took = run.finishedAt ? ` · ${duration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())}` : '';
  const attempts = run.attempts > 1 ? ` · ${run.attempts} attempts` : '';
  const used = run.usage ? ` · ${tokens(totalTokens(run.usage))} tokens` : '';
  const note = run.quiet && run.reply ? ` · ${clip(run.reply, 60)}` : '';
  const outcome = run.quiet ? 'Quiet' : run.status === 'succeeded' ? 'Succeeded' : run.meta?.cancelled ? 'Cancelled' : run.meta?.timedOut ? 'Timed out' : 'Failed';
  return `${outcome}${took}${attempts}${used}${note}`;
}

const PUSH_REASON: Record<NotifyDelivery['reason'], string> = {
  failure: 'about the failure',
  result: 'with the result',
  notify: 'from botons notify',
  approval: 'about an approval request',
  test: 'test',
};

function callbackText(d: CallbackDelivery): string {
  if (d.pending) return `Sending the result to ${d.url}…`;
  const tries = d.attempts > 1 ? ` (${d.attempts} tries)` : '';
  return d.ok ? `Sent the result to ${d.url}${tries}` : `Couldn't send the result to ${d.url}${tries}: ${d.error ?? `HTTP ${d.status}`}`;
}

function deliveryText(d: NotifyDelivery): string {
  return d.ok ? `Pushed to your phone ${PUSH_REASON[d.reason]}` : `Push ${PUSH_REASON[d.reason]} failed: ${d.error ?? 'unknown error'}`;
}

const NOTIFY_OPTIONS: { value: NotifyPolicy; label: (name: string) => string }[] = [
  { value: 'auto', label: (name) => `When a run fails, or ${name} sends one` },
  { value: 'always', label: () => 'Every result (not quiet runs)' },
  { value: 'failures', label: () => 'Only when a run fails' },
  { value: 'never', label: () => 'Never' },
];

function scheduleInput(r?: Routine): string {
  if (!r?.schedule) return '';
  if (r.schedule.startsWith('cron ')) return r.schedule.slice(5);
  if (r.schedule.startsWith('once ')) return `at ${r.schedule.slice(5)}`;
  return r.schedule;
}

function RoutineModelField({ bot, providers, value, onChange }: { bot: Bot; providers: ProviderInfo[]; value: string; onChange: (m: string) => void }) {
  const provider = providers.find((p) => p.id === bot.provider);
  const models = (provider?.models ?? []).filter((m) => m.id);
  const own = provider?.models.find((m) => m.id === bot.model)?.label ?? (bot.model || 'its default');
  const [custom, setCustom] = useState(() => !!value && !models.some((m) => m.id === value));
  const known = models.some((m) => m.id === value);
  return (
    <label>
      <span className="field-label">Model</span>
      <select
        value={custom ? '__custom' : known ? value : ''}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === '__custom');
          onChange(v === '__custom' ? value : v);
        }}
      >
        <option value="">{`${bot.name}'s model (${own})`}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        <option value="__custom">Other model…</option>
      </select>
      {custom && <input aria-label="Model id" placeholder="Model id, e.g. claude-haiku-5-5" value={value} onChange={(e) => onChange(e.target.value)} />}
      <span className="hint">A smaller model keeps frequent, simple runs cheap; your chat keeps {bot.name}'s own.</span>
    </label>
  );
}

/**
 * From 1 second up to the server's limit for a turn, in minutes or seconds; the default is that limit. The amount is kept
 * exactly as typed, so a limit saved as it is shown is the same limit, and one past the server's can't be saved.
 */
function TimeLimitField({ bot, value, onChange }: { bot: Bot; value: number | null; onChange: (ms: number | null) => void }) {
  const serverMs = useStore((s) => s.info?.turnTimeoutMs ?? null);
  const longest = serverMs === null ? "the server's limit" : durationText(serverMs);
  const [entry, setEntry] = useState(() => limitInput(value ?? MIN_TIME_LIMIT_MS));
  const amountRef = useRef<HTMLInputElement>(null);
  const parsed = limitFrom(entry.amount, entry.unit, serverMs);
  const problem = 'error' in parsed ? parsed.error : '';
  // The browser's own check stops a save while the amount isn't a limit the server takes.
  useEffect(() => amountRef.current?.setCustomValidity(problem), [problem, value]);
  const enter = (next: { amount: string; unit: LimitUnit }) => {
    setEntry(next);
    const r = limitFrom(next.amount, next.unit, serverMs);
    if ('ms' in r) onChange(r.ms);
  };
  const { min, max } = limitBounds(entry.unit, serverMs);
  return (
    <div className="time-limit-field">
      <span className="field-label">Time limit</span>
      <select
        aria-label="Time limit"
        value={value === null ? 'default' : 'custom'}
        onChange={(e) => {
          const ms = e.target.value === 'custom' ? Math.min(10 * 60_000, serverMs ?? 10 * 60_000) : null;
          if (ms !== null) setEntry(limitInput(ms));
          onChange(ms);
        }}
      >
        <option value="default">{`Default (${longest})`}</option>
        <option value="custom">Shorter limit…</option>
      </select>
      {value !== null && (
        <span className="time-limit-amount">
          <input
            ref={amountRef}
            type="number"
            aria-label={`Time limit in ${entry.unit}`}
            min={min}
            max={max}
            step="any"
            required
            value={entry.amount}
            onChange={(e) => enter({ ...entry, amount: e.target.value })}
          />
          <select aria-label="Time limit unit" value={entry.unit} onChange={(e) => enter({ ...entry, unit: e.target.value as LimitUnit })}>
            <option value="minutes">minutes</option>
            <option value="seconds">seconds</option>
          </select>
        </span>
      )}
      {value !== null && problem && <span className="form-error">{problem}</span>}
      <span className="hint">
        {value !== null
          ? `A run still going ${durationText(value)} after ${bot.name} starts on it is stopped and fails as timed out. Time waiting its turn doesn't count, and it isn't tried again by itself. At most ${longest}.`
          : `A run still going ${longest} after ${bot.name} starts on it is stopped and fails as timed out: the longest this server lets any turn run.`}
      </span>
    </div>
  );
}

/** A routine's own effort, or its Boton's; the server refuses a Boton's level the routine's own model doesn't list. */
function RoutineEffortField(props: { bot: Bot; providers: ProviderInfo[]; model: string; value: string; onChange: (effort: string) => void }) {
  const { bot } = props;
  const brain = props.providers.find((p) => p.id === bot.provider);
  const own = props.model.trim();
  const label = (v: string) => brain?.effort.levels.find((l) => l.id === v)?.label ?? v;
  const inheritsMisfit = !props.value && !!own && !!bot.effort && !shownEffort(brain, own, bot.effort);
  return (
    <EffortField
      provider={brain}
      model={own || bot.model}
      value={props.value}
      onChange={props.onChange}
      inherit={bot.effort ? label(bot.effort) : 'its default'}
      note={inheritsMisfit ? `The Boton’s ${label(bot.effort)} isn’t in this model’s list: give the routine one of its own.` : undefined}
    />
  );
}

function RoutineEditor({ bot, routine, onDone }: { bot: Bot; routine?: Routine; onDone: (r: Routine | null) => void }) {
  const [name, setName] = useState(routine?.name ?? '');
  const [instruction, setInstruction] = useState(routine?.instruction ?? '');
  const [schedule, setSchedule] = useState(scheduleInput(routine));
  const [timezone, setTimezone] = useState(routine?.timezone ?? bot.timezone);
  const [webhook, setWebhook] = useState(!!routine?.webhook);
  const [notify, setNotify] = useState<NotifyPolicy>(routine?.notify ?? 'auto');
  const [webhookWorkspace, setWebhookWorkspace] = useState(routine?.webhookWorkspace ?? true);
  const secretId = useId();
  const [source, setSource] = useState<WebhookSource>(routine?.webhook?.source ?? 'generic');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [filterKind, setFilterKind] = useState<WebhookFilter['kind'] | 'none'>(routine?.webhook?.filter?.kind ?? 'none');
  const [filterName, setFilterName] = useState(routine?.webhook?.filter?.name ?? '');
  const [filterValues, setFilterValues] = useState(routine?.webhook?.filter?.values.join(', ') ?? '');
  const [callbackUrl, setCallbackUrl] = useState(routine?.webhook?.callbackUrl ?? '');
  const [skill, setSkill] = useState(routine?.skill ?? '');
  const usable = skillsFor(bot, useSkills().skills);
  const [model, setModel] = useState(routine?.model ?? '');
  const [effort, setEffort] = useState(routine?.effort ?? '');
  const [session, setSession] = useState<RoutineSession>(routine?.session ?? 'chat');
  // null: the server's limit.
  const [limitMs, setLimitMs] = useState<number | null>(routine?.timeLimitMs ?? null);
  const providers = useStore((s) => s.providers);
  const pushOn = useStore((s) => !!s.settings?.ntfy.enabled);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zoneOk = isValidTimezone(timezone);

  useEffect(() => {
    if (!schedule.trim() || !zoneOk) {
      setPreview(null);
      return;
    }
    let current = true;
    const t = setTimeout(() => {
      api.previewSchedule(schedule, timezone).then(
        (p) => current && setPreview(p),
        () => current && setPreview(null),
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [schedule, timezone, zoneOk]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const values = filterValues
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const hook = webhook
        ? {
            webhookSource: source,
            webhookFilter: filterKind === 'none' ? null : { kind: filterKind, name: filterName.trim(), values },
            callbackUrl: callbackUrl.trim() || null,
            ...(secret.trim() ? { webhookSecret: secret.trim() } : clearSecret ? { webhookSecret: null } : {}),
          }
        : {};
      const input = {
        name,
        instruction,
        schedule: schedule.trim() || null,
        timezone,
        webhook,
        notify,
        webhookWorkspace,
        skill: skill || null,
        model: model.trim() || null,
        effort: effort || null,
        session,
        timeLimitMs: limitMs,
        ...hook,
      };
      const r = routine ? await api.updateRoutine(routine.id, input) : await api.createRoutine(bot.id, input);
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="routine-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{routine ? 'Edit routine' : 'New routine'}</h3>
      <label>
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning brief" required maxLength={80} />
      </label>
      <label>
        <span className="field-label">What {bot.name} does each run</span>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          required
          placeholder="Summarize anything new in ~/Projects/foo since the last run. Only report if something changed."
        />
      </label>
      <label>
        <span className="field-label">Skill</span>
        <select value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="">None</option>
          {usable.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
          {skill && !usable.some((s) => s.name === skill) && <option value={skill}>{skill} (not available)</option>}
        </select>
        <span className="hint">Every run follows this procedure from the skills library, with the instruction above as its input.</span>
      </label>
      <label>
        <span className="field-label">When</span>
        <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="weekdays at 8am · every 2h · 0 9 * * 1 · leave empty for webhook/manual" />
      </label>
      {preview &&
        (preview.ok ? (
          <div className="hint schedule-preview">
            <span>{preview.text}</span>
            {preview.nextRuns.length > 0 ? (
              <ol aria-label="Next runs">
                {preview.nextRuns.map((iso) => (
                  <li key={iso}>{dateTime(iso, timezone)}</li>
                ))}
              </ol>
            ) : (
              <span> · no more runs</span>
            )}
          </div>
        ) : (
          <p className="hint warn">{preview.error}</p>
        ))}
      <TimezoneField label="Timezone" value={timezone} onChange={setTimezone} />
      <label className="check">
        <input type="checkbox" checked={webhook} onChange={(e) => setWebhook(e.target.checked)} />
        <span>Webhook trigger</span>
      </label>
      {webhook && (
        <>
          <label>
            <span className="field-label">Sent by</span>
            <select value={source} onChange={(e) => setSource(e.target.value as WebhookSource)}>
              {SOURCES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="hint">
              {source === 'generic'
                ? 'Callers send the routine’s key with each call.'
                : 'Each delivery must carry a valid signature; the key alone is refused.'}
            </span>
          </label>
          {source !== 'generic' && (
            <div className="check-group">
              <label htmlFor={secretId} className="field-label">
                Signing secret{source === 'github' ? ' (optional)' : ''}
              </label>
              <input
                id={secretId}
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={routine?.webhook?.hasSecret && !clearSecret ? 'Saved. Type a new one to replace it' : source === 'github' ? 'Leave empty to use the routine’s key' : 'Paste the secret the sender shows'}
              />
              {routine?.webhook?.hasSecret && !secret && (
                <label className="check">
                  <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} />
                  <span>Remove the saved secret</span>
                </label>
              )}
            </div>
          )}
          <label>
            <span className="field-label">Run for</span>
            <select value={filterKind} onChange={(e) => setFilterKind(e.target.value as WebhookFilter['kind'] | 'none')}>
              <option value="none">Every delivery</option>
              <option value="header">Deliveries with a header value</option>
              <option value="field">Deliveries with a JSON field value</option>
            </select>
          </label>
          {filterKind !== 'none' && (
            <div className="filter-fields">
              <input
                value={filterName}
                onChange={(e) => setFilterName(e.target.value)}
                aria-label={filterKind === 'header' ? 'Header name' : 'Field path'}
                placeholder={filterKind === 'header' ? (source === 'linear' ? 'Linear-Event' : 'X-GitHub-Event') : 'action or pull_request.base.ref'}
              />
              <input value={filterValues} onChange={(e) => setFilterValues(e.target.value)} aria-label="Values" placeholder="push, pull_request" />
              <span className="hint">Other deliveries are answered 200 with nothing run. Separate values with commas.</span>
            </div>
          )}
          <label>
            <span className="field-label">Send results to (optional)</span>
            <input type="url" value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} placeholder="https://example.com/boton-results" />
            <span className="hint">
              Each finished run’s status and reply are POSTed here as JSON, signed with the routine’s key (X-Boton-Signature). Addresses on this machine or your
              private network are refused.
            </span>
          </label>
        </>
      )}
      {webhook && bot.access === 'host' && (
        <div className="check-group">
          <label className="check">
            <input type="checkbox" checked={webhookWorkspace} onChange={(e) => setWebhookWorkspace(e.target.checked)} />
            <span>Webhook runs use Workspace access</span>
          </label>
          <span className="hint">
            {webhookWorkspace
              ? `Recommended. A webhook's payload comes from outside, so its runs are sandboxed even though ${bot.name} has Full computer access.`
              : `Webhook runs get Full computer access. Anyone who can call the webhook can put text in front of ${bot.name}.`}
          </span>
        </div>
      )}
      <RoutineModelField bot={bot} providers={providers} value={model} onChange={setModel} />
      <RoutineEffortField bot={bot} providers={providers} model={model} value={effort} onChange={setEffort} />
      <label>
        <span className="field-label">Session</span>
        <select value={session} onChange={(e) => setSession(e.target.value as RoutineSession)}>
          <option value="chat">{`${bot.name}'s chat session`}</option>
          <option value="own">Its own session</option>
        </select>
        <span className="hint">
          {session === 'own'
            ? `Runs remember each other but stay out of your chat's context; ${bot.name} still sees their latest results when you chat. Results are posted in the chat either way.`
            : `Runs happen in your conversation with ${bot.name}, so each one sees the chat and the chat sees it.`}
        </span>
      </label>
      <TimeLimitField bot={bot} value={limitMs} onChange={setLimitMs} />
      <label>
        <span className="field-label">Push to your phone</span>
        <select value={notify} onChange={(e) => setNotify(e.target.value as NotifyPolicy)}>
          {NOTIFY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label(bot.name)}
            </option>
          ))}
        </select>
        <span className="hint">
          {pushOn ? 'Runs with nothing to report stay quiet: no chat message and no push.' : 'Push notifications are off. Set them up in Settings.'}
        </span>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn primary"
          disabled={
            saving ||
            !name.trim() ||
            !instruction.trim() ||
            !zoneOk ||
            (preview !== null && !preview.ok) ||
            (webhook && filterKind !== 'none' && (!filterName.trim() || !filterValues.trim()))
          }
        >
          {saving ? 'Saving…' : routine ? 'Save' : 'Create routine'}
        </button>
      </div>
    </form>
  );
}
