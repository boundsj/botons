import { useEffect, useRef, useState } from 'react';
import type { CodexConfigRepair } from '../../../shared/types.ts';
import { api } from '../api.ts';

/** Paired-owner repair only. Opening this preview never changes a file. */
export function BrainConfigRepairs() {
  const [repairs, setRepairs] = useState<CodexConfigRepair[]>([]);
  const [selected, setSelected] = useState<CodexConfigRepair | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const confirmation = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (selected) confirmation.current?.focus(); }, [selected]);
  useEffect(() => { if (notice) status.current?.focus(); }, [notice]);
  useEffect(() => {
    let live = true;
    void api.brainConfigRepairs().then(next => { if (live) setRepairs(next); }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, []);
  const repair = async () => {
    if (!selected?.token) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.repairBrainConfig(selected.id, selected.token);
      setSelected(null);
      setNotice(`Repaired ${result.path}. The link backup is at ${result.backup}. ${result.warning ? result.warning : 'Retry your Boton’s turn.'}`);
    } catch (e) { setError((e as Error).message); setSelected(null); }
    finally {
      try { setRepairs(await api.brainConfigRepairs()); } catch (e) { setError((e as Error).message); }
      setBusy(false);
    }
  };
  return <div className="setup-field">
    {repairs.length > 0 && <><h3>Repair Codex config links</h3><p>These links can prevent Workspace turns from starting. Review a repair before changing any file.</p>
      <ul>{repairs.map(item => <li key={item.id}><p style={{overflowWrap: 'anywhere'}}><code>{item.path}</code></p>{item.problem ? <p>{item.problem}</p> : <button type="button" className="btn small" disabled={busy} onClick={() => { setSelected(item); setError(''); setNotice(''); }}>Fix it: review copy</button>}</li>)}</ul></>}
    {selected && <section ref={confirmation} tabIndex={-1} aria-label="Confirm Codex config repair" style={{overflowWrap: 'anywhere'}}>
      <h4>Replace this link with a regular copy?</h4>
      <p>Replace <code>{selected.path}</code> with a regular file containing the current bytes of <code>{selected.target}</code>, readable and writable only by the server user. The target stays unchanged.</p>
      <p>Keep the original symlink at <code>{selected.backup}</code>. This copy will stop following changes to the target. Relative backup links may not resolve until restored to the original path. Botons will record this repair in the audit log.</p>
      <div className="form-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void repair()}>{busy ? 'Repairing…' : 'Confirm repair'}</button><button type="button" className="btn" disabled={busy} onClick={() => setSelected(null)}>Cancel</button></div>
    </section>}
    <p ref={status} tabIndex={-1} role="status" style={{overflowWrap: 'anywhere'}}>{notice}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
