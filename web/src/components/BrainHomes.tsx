import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';
import { useActiveRef } from './PageActive.ts';
/** Botons' own sign-in for each CLI. A ready brain shows only "Change sign-in"; the choices are one tap away. */
/** `open`/`onOpen`: the owner chose Change sign-in (shared with the subscription panel's link). */
export function BrainHomes({ onSeparate, open, onOpen }: { onSeparate: () => void; open: boolean; onOpen: (open: boolean) => void }) {
  const [pending, setPending] = useState({ codex: false, claude: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const ready = {
    codex: useStore(s => s.providers.find(p => p.id === 'codex-cli')?.readiness.state === 'ready'),
    claude: useStore(s => s.providers.find(p => p.id === 'claude-cli')?.readiness.state === 'ready'),
  };
  const active = useActiveRef();
  useEffect(() => {
    let live = true;
    const refresh = () => void api.brainHomes().then(value => { if (live) setPending(value); }).catch(() => {});
    refresh();
    const timer = setInterval(() => active.current && refresh(), 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const copy = async () => {
    setBusy(true);
    try { await api.importCodexSignIn(); setPending(await api.brainHomes()); setMessage('Botons now has its own Codex sign-in.'); onOpen(false); await actions.loadProviders(true); }
    catch { setMessage('Could not copy the sign-in. Try signing in separately.'); }
    finally { setBusy(false); }
  };
  // A success says so for a moment, then goes: it must not linger as if it were news.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(''), 8000);
    return () => clearTimeout(t);
  }, [message]);
  if (!pending.codex && !pending.claude && !message) return null;
  const collapsed = !open && (pending.codex ? ready.codex : ready.claude);
  return <section aria-label="Botons sign-in">
    {pending.codex && !collapsed && <>
      <p>Botons can use your existing Codex sign-in, or one just for Botons.</p>
      <div className="form-actions"><button type="button" className="btn" disabled={busy} onClick={() => void copy()}>Use existing sign-in</button><button type="button" className="btn" disabled={busy} onClick={() => { onOpen(false); onSeparate(); }}>Sign in just for Botons</button></div>
      <p className="hint">Copies only the Codex sign-in file, never your instructions, skills or settings.</p>
    </>}
    {!pending.codex && pending.claude && !collapsed && <p className="hint">To sign in to Claude just for Botons, run <code>botons login claude</code> on the server.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
