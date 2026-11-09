import { useEffect, useId, useState } from 'react';
import { randomLook } from '../../../shared/look.ts';
import { BotonAvatar } from './Avatar.tsx';
import { BrandMark } from './Brand.tsx';
import { BotonBuilder } from './BotonBuilder.tsx';
import type { AccessMode, AuditEvent, Bot, Health, SetupStatus, SetupWarning } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { cx, relative } from '../util.ts';
import { AccessPicker } from './BotFields.tsx';
import { BrainList } from './Brains.tsx';

export function AccessModePicker({ setup, value, onChange }: { setup: SetupStatus; value: AccessMode | null; onChange: (m: AccessMode) => void }) {
  const id = useId();
  const chosen = setup.modes.find((m) => m.mode === value) ?? null;
  const renderOption = (mode: AccessMode) => {
    const m = setup.modes.find(m => m.mode === mode)!;
    return <button key={mode} type="button" role="radio" aria-checked={value === mode}
      disabled={!m.available} className={cx('access-option', value === mode && 'on', !m.available && 'unavailable')}
      onClick={() => onChange(mode)}>
      <strong>{m.label}{m.available && mode === setup.recommendedMode && <span className="device-tag">recommended</span>}</strong>
      <span>{m.available ? m.summary : m.reason}</span>
    </button>;
  };
  return (
    <div className="access-picker" role="radiogroup" aria-labelledby={`${id}-label`}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(b => !b.disabled && b.getClientRects().length);
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0 || !options.length) return;
        event.preventDefault();
        const next = options[(current + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
        next.focus();
        next.click();
      }}>
      <span className="field-label" id={`${id}-label`}>
        Who can connect
      </span>
      <span className="hint">{setup.recommendedMode === 'public' ? 'This connection appears forwarded or public; HTTPS access is recommended.' : setup.recommendedMode === 'tailscale' ? 'This connection uses a Tailscale address.' : setup.recommendedMode === 'lan' ? 'This connection uses a private network address.' : setup.recommendedMode === 'local' ? 'This connection appears local to the server.' : 'This connection appears forwarded or public; set up HTTPS to continue.'}</span>
      {(['public', 'tailscale'] as const).filter(m => m !== 'tailscale' || setup.exposure.tailscale || setup.recommendedMode === 'tailscale' || value === 'tailscale').map(renderOption)}
      <details open={value === 'local' || value === 'lan' ? true : undefined}>
        <summary>More options</summary>
        {(['lan', 'local'] as const).map(renderOption)}
      </details>
      <details className="setup-steps">
        <summary>Details</summary>
        <p className="hint">Listeners: {setup.exposure.listeners.join(', ')} · {setup.exposure.publicUrl}</p>
        <SetupWarnings warnings={setup.warnings} except={chosen?.limits} />
        {!setup.modes.find(m => m.mode === 'public')?.available && chosen?.mode !== 'public' && <>
          <h5>Set up HTTPS access</h5>
          <ol>{setup.modes.find(m => m.mode === 'public')?.steps.map(step => <li key={step}><Code text={step} /></li>)}</ol>
        </>}
        {chosen && <>
          <ul>{chosen.limits.map(l => <li key={l}>{l}</li>)}</ul>
          <ol>{chosen.steps.map(step => <li key={step}><Code text={step} /></li>)}</ol>
        </>}
      </details>
    </div>
  );
}

/** `code` spans for text in backticks. */
function Code({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))}
    </>
  );
}

/** `except`: texts shown already (the chosen mode's limits), so they are not said twice. */
export function SetupWarnings({ warnings, except = [] }: { warnings: SetupWarning[]; except?: string[] }) {
  const shown = warnings.filter((w) => !except.includes(w.text));
  if (!shown.length) return null;
  return (
    <ul className="setup-warnings">
      {shown.map((w) => (
        <li key={w.text} className={cx('setup-warning', w.level)}>
          <Code text={w.text} />
        </li>
      ))}
    </ul>
  );
}

type Step = 'owner' | 'access' | 'brains' | 'boton' | 'done';
const STEPS: Step[] = ['owner', 'access', 'brains', 'boton', 'done'];
const TITLES: Record<Step, string> = {
  owner: 'Welcome to Botons',
  access: 'Who can connect',
  brains: 'Bring the brains',
  boton: 'Your first Boton',
  done: 'Lights on',
};

/** The first-run setup, after the first device has claimed the server. Every step can be changed later in Settings. */
export function SetupWizard({ onDone }: { onDone: (botId: string | null) => void }) {
  const setup = useStore((s) => s.setup)!;
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const bots = useStore((s) => s.bots);
  const [step, setStep] = useState<Step>('owner');
  const [ownerName, setOwnerName] = useState(settings?.ownerName ?? '');
  const [mode, setMode] = useState<AccessMode | null>(setup.modes.some(m => m.mode === setup.accessMode && m.available) ? setup.accessMode : setup.recommendedMode);
  const [name, setName] = useState('');
  // A random look is ready before anyone opens the builder; Surprise me draws another.
  const [look, setLook] = useState(() => randomLook());
  const ready = providers.filter((p) => p.readiness.state === 'ready');
  const confirmed = providers.some((p) => p.readiness.state === 'ready');
  const [provider, setProvider] = useState('');
  const [checkingBrains, setCheckingBrains] = useState(false);
  const [brainsChecked, setBrainsChecked] = useState(false);
  const workspaceProblem = providers.find(p => p.id === provider)?.workspaceProblem;
  const [access, setAccess] = useState<'workspace' | 'host'>('workspace');
  useEffect(() => { setAccess(workspaceProblem ? 'host' : 'workspace'); }, [workspaceProblem, provider]);
  const [brainModel, setBrainModel] = useState('');
  const [brainCap, setBrainCap] = useState<number | null>(null);
  const [created, setCreated] = useState<Bot | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = STEPS.indexOf(step);
  const boton = created ?? bots[0] ?? null;

  useEffect(() => {
    if (step === 'boton' && brainsChecked && !checkingBrains && !ready.some(p => p.id === provider)) {
      setProvider(ready[0]?.id ?? ''); setBrainModel(''); setBrainCap(null);
    }
  }, [step, provider, providers, brainsChecked, checkingBrains]);

  const checkBrains = async () => {
    setCheckingBrains(true); setError(null);
    try { await actions.loadProviders(true); setBrainsChecked(true); } catch (e) { setBrainsChecked(false); setError(errorText(e)); }
    finally { setCheckingBrains(false); }
  };
  useEffect(() => { setBrainsChecked(false); if (step === 'boton') void checkBrains(); }, [step]);

  useEffect(() => {
    if (step !== 'done') return;
    let live = true;
    const check = () =>
      api.health().then(
        (h) => live && setHealth(h),
        () => {},
      );
    void check();
    const t = setInterval(check, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [step]);

  const go = async (fn: () => Promise<unknown>, next: Step) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setStep(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await actions.updateSetup({ complete: true });
      onDone(boton?.id ?? null);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <main className="pair-screen setup-screen">
      <form
        className="pair-card setup-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'owner') void go(() => actions.updateSettings({ ownerName: ownerName.trim() }), 'access');
          else if (step === 'access') void go(() => actions.updateSetup({ accessMode: mode }), 'brains');
          else if (step === 'brains') setStep('boton');
          else if (step === 'boton') {
            if (bots.length && !name.trim()) return setStep('done');
            if (!ready.some(p => p.id === provider)) { setError('No brain is ready yet — go back to Brains.'); return; }
            void go(async () => {
              const bot = await actions.createBot({ name: name.trim(), look, provider, model: brainModel, dailyCapUsd: brainCap, access });
              setCreated(bot);
              await actions.updateSettings({ primaryBotId: bot.id });
            }, 'done');
          } else void finish();
        }}
      >
        <BrandMark size={48} />
        <p className="hint" aria-live="polite">
          Step {index + 1} of {STEPS.length}
        </p>
        <h1>{TITLES[step]}</h1>

        {step === 'owner' && (
          <>
            <p className="welcome-copy">
              This device claimed the server{setup.owner.claimedAt ? ` ${relative(setup.owner.claimedAt)}` : ''}: it is yours now, and only devices you pair can use it.
            </p>
            <label className="setup-field">
              <span className="field-label">Your name</span>
              <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required maxLength={60} autoComplete="name" data-autofocus autoFocus />
              <span className="hint">Botons use it when they talk about you.</span>
            </label>
          </>
        )}

        {step === 'access' && (
          <div className="setup-field">
            <AccessModePicker setup={setup} value={mode} onChange={setMode} />
          </div>
        )}

        {step === 'brains' && (
          <div className="setup-field">
            {/* Your first Boton, asleep until a brain is ready to wake it. The words say the same, in a line whose height
                never changes, so nothing below moves when a brain becomes ready. */}
            <div className="brains-stage">
              <BotonAvatar look={look} size={88} state={confirmed ? 'idle' : 'asleep'} seed="setup" />
              <p role="status">{confirmed ? 'Awake: a brain is ready, so your Botons can think.' : "No brain yet. Connect one below to wake your Botons up. You can go on, but they can't answer until one is ready."}</p>
            </div>
            <BrainList onChoose={(choice) => { setProvider(choice.provider); setBrainModel(choice.model); setBrainCap(choice.cap); }} />
          </div>
        )}

        {step === 'boton' && (
          <div className="setup-field">

            {bots.length > 0 && <p className="hint">You already have {bots.length === 1 ? 'a Boton' : `${bots.length} Botons`}. Add another, or leave the name empty to go on.</p>}
            <label>
              <span className="field-label">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required={!bots.length} maxLength={60} placeholder="e.g. Juniper" autoFocus />
            </label>
            <BotonBuilder look={look} onChange={setLook} compact />
            <label>
              <span className="field-label">Brain</span>
              <select value={provider} onChange={(e) => { setProvider(e.target.value); setBrainModel(''); setBrainCap(null); }} disabled={!ready.length || checkingBrains}>
                {!ready.length && <option value="">No brain is ready</option>}
                {ready.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn small" disabled={checkingBrains} onClick={() => void checkBrains()}>{checkingBrains ? 'Checking brains…' : 'Check again'}</button>
            {!ready.length && <p role="status">No brain is ready yet — <button type="button" className="btn ghost" onClick={() => setStep('brains')}>go back to Brains</button>.</p>}
            <AccessPicker value={access} onChange={setAccess} problem={workspaceProblem} />
          </div>
        )}

        {step === 'done' && (
          <div className="setup-field">
            <ul className="setup-providers">
              {(['database', 'scheduler', 'providers'] as const).map((check) => {
                const ok = health ? !health.failing.includes(check) : null;
                return (
                  <li key={check}>
                    <span className={cx('status-dot', ok === null ? 'skipped' : ok ? 'succeeded' : 'failed')} aria-hidden />
                    <span className="device-text">
                      <span className="device-name">{{ database: 'Database', scheduler: 'Scheduler', providers: 'A brain is ready' }[check]}</span>
                      <span className="hint">{ok === null ? 'Checking…' : ok ? 'OK' : 'Not yet'}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="hint">
              {boton ? `Say hello to ${boton.name}.` : 'Create a Boton any time with New Boton.'} Access, devices and the audit log are in Settings.
            </p>
          </div>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions setup-actions">
          {index > 0 && step !== 'done' && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep(STEPS[index - 1])}>
              Back
            </button>
          )}
          <button type="submit" className="btn primary" disabled={busy || (step === 'access' && !setup.modes.some(m => m.mode === mode && m.available)) || (step === 'boton' && (!brainsChecked || checkingBrains || ((!bots.length || !!name.trim()) && (!ready.some(p => p.id === provider)))))}>
            {step === 'done' ? (boton ? `Open ${boton.name}` : 'Finish') : step === 'boton' && (!bots.length || name.trim()) ? 'Create' : 'Continue'}
          </button>
        </div>
        {step !== 'done' && (
          <button type="button" className="link-btn hint" disabled={busy} onClick={() => void finish()}>
            Skip setup
          </button>
        )}
      </form>
    </main>
  );
}

/** Settings: owner, access mode, what is exposed. */
export function AccessSettings() {
  const setup = useStore((s) => s.setup);
  const [mode, setMode] = useState<AccessMode | null>(setup?.modes.some(m => m.mode === setup.accessMode && m.available) ? setup.accessMode : setup?.recommendedMode ?? null);
  useEffect(() => {
    if (setup) setMode(current => setup.modes.some(m => m.mode === current && m.available) ? current : setup.recommendedMode);
  }, [setup]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void actions.loadSetup().catch(() => {});
  }, []);
  if (!setup) return null;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await actions.updateSetup({ accessMode: mode });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  const { owner } = setup;
  return (
    <section className="server-info access-settings">
      <h4>Access</h4>
      <p className="hint">
        Owner: {owner.name || 'not named'}
        {owner.claimedAt ? ` · claimed ${relative(owner.claimedAt)}${owner.claimedBy ? ` from ${owner.claimedBy}` : ''}` : ''} · {owner.devices} paired device{owner.devices === 1 ? '' : 's'}
      </p>
      <AccessModePicker setup={setup} value={mode} onChange={setMode} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="button" className="btn small" disabled={saving || mode === setup.accessMode || !setup.modes.some(m => m.mode === mode && m.available)} onClick={() => void save()}>
          Save access mode
        </button>
      </div>
    </section>
  );
}

export const ACTIONS: Record<AuditEvent['action'], string> = {
  'device.paired': 'paired a device',
  'device.revoked': 'revoked a device',
  'devices.revoked_all': 'revoked every device',
  'pairing_request.approved': 'approved a device to pair',
  'access_mode.changed': 'changed the access mode',
  'setup.completed': 'finished setup',
  'settings.notifications_changed': 'changed notifications',
  'notifications.tested': 'sent a test push',
  'backup.rehearsed': 'rehearsed restoring a backup',
  'boton.created': 'created a Boton',
  'boton.deleted': 'deleted a Boton',
  'boton.access_changed': "changed a Boton's computer access",
  'boton.spending_changed': "changed a Boton's spending caps",
  'boton.permissions_changed': "changed a Boton's connectors, skills or rules",
  'routine.permissions_changed': "changed a routine's webhook access or callback",
  'routine.starter_activated': "turned on a starter's routine",
  'run.retried': 'retried a failed routine run',
  'run.cancelled': 'cancelled a routine run',
  'run.callback_resent': "resent a routine run's result to its callback URL",
  'approval.decided': 'decided an approval',
  'card.answered': 'answered a card in the chat',
  'skill.approved': 'approved a skill',
  'skill.installed': 'installed or updated a skill from its package',
  'skill.restored': 'put back an earlier text of a skill',
  'skill.enabled': 'turned a skill on',
  'skill.disabled': 'turned a skill off',
  'connector.policy_changed': 'changed who may ask for a connector',
  'connector.granted': 'got a connector it asked for (granted at once by policy)',
  'connector.tested': 'tested a connector',
  'connector.disabled': 'turned a connector off (its setup, sign-in and grants kept)',
  'connector.enabled': 'turned a connector back on',
  'mcp_server.created': 'added an MCP server',
  'mcp_server.changed': 'changed an MCP server',
  'mcp_server.deleted': 'removed an MCP server',
  'oauth.created': 'added a sign-in connector',
  'oauth.deleted': 'removed a sign-in connector',
  'oauth.signin_started': 'started a connector sign-in',
  'oauth.connected': 'connected a sign-in connector',
  'brain.cli_install_started': 'started an owner-confirmed CLI installation',
  'brain.cli_install_succeeded': 'installed and selected a managed CLI',
  'brain.cli_install_failed': 'could not finish a CLI installation',
  'brain.signin_started': 'started a brain sign-in',
  'brain.signin_cancelled': 'cancelled a brain sign-in',
  'brain.signin_import_confirmed': 'confirmed using an existing sign-in',
  'brain.signin_import_completed': 'copied a sign-in for Botons',
  'brain.config_repair_confirmed': 'confirmed a brain config repair',
  'brain.config_repair_completed': 'repaired a brain config link',
  'brain.config_repair_failed': 'could not repair a brain config link',
  'api_key.saved': 'saved an API key',
  'api_key.removed': 'removed a saved API key',
  'api_key.tested': 'tested an API key',
  'browser.sites_changed': "changed the sites a Boton's browser may read",
  'browser.stopped': "stopped a Boton's browser",
  'browser.handover_started': "took a Boton's browser over (to sign it in)",
  'browser.handover_ended': "gave a Boton's browser back",
  'config.exported': 'exported the configuration',
  'config.imported': 'imported a configuration',
  'files.trashed': "moved a Boton's files to the trash",
  'files.restored': 'restored a file from the trash',
  'files.purged': 'deleted files from the trash for good',
  'inbox.cleared': "cleared a Boton's inbox",
  'inbox.cleaned_up': "moved a Boton's old inbox files to the trash",
};

export function detailText(details: AuditEvent['details']): string {
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');
}

/** Settings: who did what, newest first. */
export function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async (before?: number) => {
    setError(null);
    try {
      const page = await api.audit(before);
      setEvents((cur) => (before && cur ? [...cur, ...page] : page));
      setMore(page.length === 50);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="server-info audit-log">
      <h4>Audit log</h4>
      <p className="hint">Pairings, access changes, approvals and what Botons were given. It never records secrets or message text.</p>
      {events === null && !error && <p className="hint">Loading…</p>}
      {events && !events.length && <p className="hint">Nothing yet.</p>}
      {events && events.length > 0 && (
        <ul className="device-list audit-list">
          {events.map((e) => (
            <li key={e.seq}>
              <span className="device-text">
                <span>
                  <strong>{e.actor.label}</strong> {ACTIONS[e.action] ?? e.action}
                  {e.target ? `: ${e.target.label || e.target.id}` : ''}
                </span>
                <span className="hint">
                  <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                    {relative(e.at)}
                  </time>
                  {detailText(e.details) && ` · ${detailText(e.details)}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {events && more && (
        <div>
          <button type="button" className="btn small ghost" onClick={() => void load(events.at(-1)?.seq)}>
            Show older
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
