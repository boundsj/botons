import { newerRelease, terminalNote, updatedLine } from '../../../shared/versions.ts';
import { useEffect, useState } from 'react';
import type { BrainReleaseStatus } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';
import { useActiveRef } from './PageActive.ts';

export function BrainCliActions({ provider }: { provider: 'codex-cli' | 'claude-cli' }) {
  const [status, setStatus] = useState<BrainReleaseStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const p = useStore(s => s.providers.find(p => p.id === provider));
  const active = useActiveRef();
  useEffect(() => { setConfirm(false); setError(''); setDone(false); }, [provider]);
  useEffect(() => {
    let live = true;
    const load = () => { void actions.loadProviders().catch(() => {}); void api.brainClis().then(value => { if (live) setStatus(value); }).catch(() => { if (live) setError('Could not check CLI installation options. Reopen Brains to try again.'); }); };
    load(); const timer = setInterval(() => active.current && load(), 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const release = status?.checks[provider];
  const plan = status?.installs?.find(plan => plan.provider === provider);
  const required = p?.readiness.problem === 'incompatible-version';
  const ready = p?.readiness.state === 'ready';
  const needsInstall = p?.readiness.state === 'not-installed';
  const available = newerRelease(p?.version ?? null, release?.latest ?? null);
  const note = terminalNote(provider, p?.version ?? null, p?.copy);
  const botons = newerRelease(status?.botonsVersion ?? null, status?.checks.botons?.latest ?? null);
  const install = async () => {
    if (!plan?.available) return;
    setBusy(true); setError(''); setDone(false);
    try {
      await api.installBrainCli(provider, plan.command);
      await actions.loadProviders(true);
      setStatus(await api.brainClis()); setConfirm(false); setDone(true);
    } catch (e) {
      setError((e as Error).message); setConfirm(false);
      try { setStatus(await api.brainClis()); } catch {}
    } finally { setBusy(false); }
  };
  return <div className="cli-actions">
    {(required || available) && <p role="status" className="hint warn"><strong>{required ? 'Needs update' : 'Update available'}</strong>{release?.latest ? ` · Latest available: ${release.latest}` : ''}{release?.failed && ' · Last known release; the latest check failed.'}</p>}
    {done && <p role="status">✓ {updatedLine(provider, p?.version ?? null)}{!ready && ' Sign in below if needed.'}</p>}
    {done && note && <p className="hint">{note}</p>}
    {plan?.available && (required || available || needsInstall) && !confirm && <button type="button" className="btn small" disabled={busy || status?.installing} onClick={() => setConfirm(true)}>{p?.installed ? 'Update now' : 'Install CLI'}</button>}
    {confirm && (required || available || needsInstall) && plan?.available && <div className="setup-field">
      <p>Install the official {provider === 'codex-cli' ? 'Codex' : 'Claude Code'} package for this server user, then use that copy in Botons? No sudo is needed. Any system copy stays in place.</p>
      <p>Exact command:</p><code>{plan.command}</code>
      <p>Running turns finish first. Queued work waits, then resumes. Sign-in stays with the provider. Updates never run automatically.</p>
      <div className="form-actions"><button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="btn primary" disabled={busy || status?.installing} onClick={() => void install()}>Install and use this copy</button></div>
    </div>}
    {busy && <p role="status">Waiting for running turns, then installing… Keep this page open.</p>}
    {plan && !plan.available && (required || available || needsInstall) && <p className="hint">{plan.reason}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {botons && <p role="status" className="hint">A newer Botons release is available ({status?.checks.botons?.latest}). For installer installs, run <code>botons upgrade</code> with the release source. Botons never upgrades itself automatically.</p>}
  </div>;
}
