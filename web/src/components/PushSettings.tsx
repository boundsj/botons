import { useState } from 'react';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';

const randomTopic = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `botons-${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
};


/** What a saved token belongs to (as the server decides): the push server's scheme, host and port. */
const originOf = (server: string) => {
  try {
    return server ? new URL(server).origin : '';
  } catch {
    return '';
  }
};

export function PushSettings() {
  const saved = useStore((s) => s.settings?.ntfy);
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [server, setServer] = useState(saved?.server ?? '');
  const [topic, setTopic] = useState(saved?.topic ?? '');
  // A new token to save; "" keeps the saved one.
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState(saved?.preview ?? false);
  const [busy, setBusy] = useState<'save' | 'test' | 'token' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const dirty =
    !!saved && (enabled !== saved.enabled || server.trim() !== saved.server || topic.trim() !== saved.topic || preview !== saved.preview || token.trim() !== '');

  const run = async (what: 'save' | 'test' | 'token', fn: () => Promise<string | null>) => {
    setBusy(what);
    setError(null);
    setResult(null);
    try {
      setResult(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    actions.updateSettings({
      ntfy: { enabled, server: server.trim(), topic: topic.trim(), preview, ...(token.trim() ? { token: token.trim() } : {}) },
    });

  return (
    <form
      className="server-info push-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void run('save', async () => {
          await save();
          setToken('');
          return 'Saved.';
        });
      }}
    >
      <h4>Push notifications</h4>
      <p className="hint">
        Failed routine runs, and whatever a Boton sends with <code>botons notify</code>, reach your phone through{' '}
        <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
          ntfy
        </a>
        . Install the ntfy app, subscribe to the topic below, and tap a push to open that Boton's chat.
      </p>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Send push notifications</span>
      </label>
      <label>
        <span className="field-label">ntfy server</span>
        <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://ntfy.sh" inputMode="url" autoComplete="off" />
      </label>
      <label>
        <span className="field-label">Topic</span>
        <span className="topic-row">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="botons-…" autoComplete="off" spellCheck={false} maxLength={64} />
          <button type="button" className="btn small ghost" onClick={() => setTopic(randomTopic())}>
            Random
          </button>
        </span>
        <span className="hint">On a public server anyone who knows the topic can read it, so pick a long random one, or run ntfy on your tailnet.</span>
      </label>
      <label>
        <span className="field-label">Access token (optional)</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={saved?.hasToken ? 'Saved. Type a new one to replace it' : 'tk_… for a protected topic'}
          autoComplete="off"
        />
        {saved?.hasToken && !token.trim() && originOf(server.trim()) !== originOf(saved.server) && (
          <span className="hint warn">The saved token is for {originOf(saved.server) || 'another server'}: saving this server without a new token removes it, so it is never sent anywhere else.</span>
        )}
        {saved?.hasToken && (
          <button
            type="button"
            className="link-btn"
            disabled={!!busy}
            onClick={() =>
              run('token', async () => {
                await actions.updateSettings({ ntfy: { token: null } });
                return 'Removed the token.';
              })
            }
          >
            Remove the saved token
          </button>
        )}
      </label>
      <label className="check">
        <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
        <span>Show text in pushes</span>
      </label>
      <p className="hint">
        {preview
          ? 'Pushes include up to 200 characters of the error, result or notification text (never a webhook payload).'
          : 'Pushes only name the Boton and say what happened, such as “A routine failed.” Open the chat for the rest.'}
      </p>
      {error && <p className="form-error">{error}</p>}
      {result && <p className="hint">{result}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={!!busy || !server.trim() || !topic.trim()}
          onClick={() =>
            run('test', async () => {
              if (dirty) await save();
              setToken('');
              const d = await api.testPush();
              return d.ok ? 'Sent a test push. Check your phone.' : `The test push failed: ${d.error}`;
            })
          }
        >
          {busy === 'test' ? 'Sending…' : 'Send a test'}
        </button>
        <button type="submit" className="btn primary" disabled={!!busy || !dirty}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
