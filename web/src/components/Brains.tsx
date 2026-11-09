import { BrainCliActions } from './BrainCliActions.tsx';
import { BrainHomes } from './BrainHomes.tsx';
import { useActiveRef } from './PageActive.ts';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';
import { brainView, botonsOn, loginCommand, signInFinished } from '../brains.ts';

import { withCode } from './BrainWarning.tsx';
import { copyLine, terminalNote } from '../../../shared/versions.ts';

type Choice = { provider: string; model: string; cap: number | null };
export function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? 'Copied' : 'Copy'}</button>;
}
/** First-run setup's brain: one is enough, and it is the first Boton's. Settings → Brains is BrainSettings. */
export function BrainList({ onChoose }: { onChoose: (choice: Choice) => void }) {
  const providers = useStore(s => s.providers);
  const bots = useStore(s => s.bots);
  const paused = useStore(s => s.settings?.paused ?? false);
  const keys = useStore(s => s.apiKeys);
  const container = useStore(s => s.setup?.exposure.container ?? false);
  const [path, setPath] = useState<'subscription' | 'api' | null>(null);
  const [provider, setProvider] = useState('codex-cli');
  const [keyProvider, setKeyProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [separateLogin, setSeparateLogin] = useState(false);
  // A ready brain shows only "Change sign-in"; this opens its choices.
  const [changing, setChanging] = useState(false);
  const [login, setLogin] = useState<Awaited<ReturnType<typeof api.brainLogin>> | null>(null);
  const active = useActiveRef();
  // Choosing keeps the choices open; only a sign-in that finishes folds them back.
  const lastLogin = useRef(login?.state);
  useEffect(() => {
    if (signInFinished(lastLogin.current, login?.state)) { setChanging(false); setSeparateLogin(false); }
    lastLogin.current = login?.state;
  }, [login?.state]);
  const p = providers.find(p => p.id === provider);
  const k = keys?.providers.find(k => k.provider === keyProvider);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        await actions.loadProviders(true);
        const next = await api.brainLogin();
        if (live) setLogin(next);
      } catch { /* A transient poll failure leaves the last status visible. */ }
    };
    void actions.loadApiKeys().catch(() => {});
    void refresh();
    const timer = setInterval(() => active.current && void refresh(), 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const command = loginCommand(provider, container) ?? '';
  const choose = (nextModel = model) => onChoose({ provider: path === 'api' ? `${keyProvider}-api` : provider, model: path === 'api' ? nextModel : '', cap: cap ? Number(cap) : null });
  return <div className="brains">
    <h2>Give your Botons their brains</h2>
    <p>A Boton is the body; the brain is the AI model it thinks with: your Claude or ChatGPT plan, an API key, or the Claude Code and Codex CLIs. You need just one brain, and you can add others later in Settings → Brains.</p>
    <div className="setup-field" aria-label="Brain options">
      <button type="button" className={`access-option ${path === 'subscription' ? 'on' : ''}`} aria-pressed={path === 'subscription'} onClick={() => { setPath('subscription'); onChoose({provider, model: '', cap: null}); }}><strong>Use my Claude or ChatGPT subscription</strong><span>Sign in to your account. Your plan’s limits apply.</span></button>
      <button type="button" className={`access-option ${path === 'api' ? 'on' : ''}`} aria-pressed={path === 'api'} onClick={() => { setPath('api'); onChoose({provider: `${keyProvider}-api`, model, cap: cap ? Number(cap) : null}); }}><strong>Use an API key</strong><span>Pay per use, with an optional daily spending cap.</span></button>
    </div>
    {path === 'subscription' && <div className="setup-field">
      <label>Subscription<select value={provider} onChange={e => { setProvider(e.target.value); onChoose({provider: e.target.value, model: '', cap: null}); }}><option value="codex-cli">ChatGPT</option><option value="claude-cli">Claude</option></select></label>
      <BrainCliActions provider={provider as 'codex-cli' | 'claude-cli'} />
      {p && !separateLogin && !changing && login?.state !== 'waiting' && (p.readiness.state === 'ready' || p.readiness.state === 'usage-limited') ? <p role="status">{p.readiness.state === 'ready' ? '✓ Signed in' : brainView(p, {container}).why} · <button type="button" className="link-btn" aria-expanded="false" onClick={() => setChanging(true)}>Change sign-in</button></p> : <>
        <p className="hint">Approve sign-in with the provider. Botons never sees your password; the provider’s app keeps the credential on this server.</p>
        {provider === 'codex-cli' && <button type="button" className="btn primary" disabled={busy || login?.state === 'waiting'} onClick={() => void run(async () => { setLogin(await api.startBrainLogin()); choose(); })}>Sign in to ChatGPT</button>}
        {provider === 'codex-cli' && login?.state === 'waiting' && <div role="status"><p>Waiting for you to approve sign-in…</p>{login.url && login.code && <><p><code>{login.code}</code> <Copy text={login.code} /></p><a href={login.url} target="_blank" rel="noreferrer">Open sign-in page</a></>}<button type="button" className="btn small" onClick={() => void run(async () => setLogin(await api.cancelBrainLogin()))}>Cancel sign-in</button></div>}
        <p>In a terminal on this server (e.g. your ssh session) run:</p><p><code>{command}</code> <Copy text={command} /></p>
        {provider === 'claude-cli' && <p className="hint">Claude’s sign-in needs an interactive terminal. Follow its link and paste its approval code there. Leave this page open; it checks automatically.</p>}
        {login && ['fallback', 'timed-out'].includes(login.state) && <p role="status">Browser sign-in could not finish. Try again or use the terminal command above.</p>}
      </>}
    </div>}
    {path === 'subscription' && <BrainHomes open={changing} onOpen={setChanging} onSeparate={() => { setSeparateLogin(true); setPath('subscription'); setProvider('codex-cli'); void run(async () => { setLogin(await api.startBrainLogin()); }); }} />}
    {path === 'api' && <div className="setup-field">
      <label>Provider<select value={keyProvider} onChange={e => { setKeyProvider(e.target.value as 'anthropic' | 'openai'); setKey(''); setModel(''); onChoose({provider: `${e.target.value}-api`, model: '', cap: cap ? Number(cap) : null}); }}><option value="anthropic">Anthropic (Claude)</option><option value="openai">OpenAI</option></select></label>
      <label>API key<input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} data-1p-ignore /></label>
      <p className="hint">Saved keys are never shown again. They are stored in the server database and included in backups.</p>
      <div className="form-actions"><button type="button" className="btn primary" disabled={busy || !key.trim() || !k} onClick={() => void run(async () => { const next = await api.saveApiKey(keyProvider, key, k!.generation); setKey(''); actions.apiKeyChanged(next); await actions.loadProviders(true); })}>Save key</button><button type="button" className="btn" disabled={busy || !k || k.source === 'none'} onClick={() => void run(async () => { await api.testApiKey(keyProvider); await actions.loadApiKeys(); })}>Test key</button></div>
      {k?.source !== 'none' && k && <p role="status">✓ Key saved{ k.test ? ` · ${k.test.outcome === 'ok' ? 'The key works' : 'Test: ' + k.test.outcome}` : ''}</p>}
      <label>Model<input list="brain-models" value={model} placeholder="Provider’s model ID" onChange={e => { setModel(e.target.value); choose(e.target.value); }} /></label><datalist id="brain-models">{k?.test?.models.map(m => <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>)}</datalist>
      <label>Daily cap (USD, optional)<input type="number" min="0" max="100000" step="0.01" value={cap} onChange={e => { setCap(e.target.value); onChoose({provider: `${keyProvider}-api`, model, cap: e.target.value ? Number(e.target.value) : null}); }} /></label>
      <p className="hint">{k?.testDescription}</p>
    </div>}
    <details><summary>Details</summary><ul className="brain-list">{providers.map(p => {
      const view = brainView(p, {container});
      const failed = p.lastError && (!p.lastSuccessAt || p.lastError.at > p.lastSuccessAt) ? p.lastError : null;
      const copy = copyLine(p.version, p.copy), note = terminalNote(p.id, p.version, p.copy);
      return <li key={p.id} data-brain={p.id} data-state={p.readiness.state}><p><strong>{p.label}</strong>: {view.status}{copy && ` · ${copy}`}</p>{note && <p className="hint">{note}</p>}<p>{view.why && withCode(view.why)}</p>{view.fix && <p>{withCode(view.fix.text)} {view.fix.command && <code>{view.fix.command}</code>}</p>}<p>{view.work}</p>{failed && <p className="hint warn">Last turn failed: {failed.message}</p>}<p>{botonsOn(p.id, bots, paused).text}</p>{p.reason && <p>{p.reason}</p>}</li>;
    })}</ul></details>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
