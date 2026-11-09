import { useEffect, useState } from 'react';
import type { ApiKeyState, ApiKeyTest, ApiKeyTestOutcome, ApiModel, ApiModelObservation, CapabilityEvidence } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';
import { cx, relative } from '../util.ts';

export const OUTCOME: Record<ApiKeyTestOutcome, string> = {
  ok: 'The key works',
  invalid: 'The provider refused this key (401). Check it was copied whole, or create a new one.',
  forbidden: 'The provider knows this key but it may not list models (403). Check its permissions or project.',
  rate_limited: 'The provider is limiting requests from this key (429). Wait a minute, then test again.',
  unavailable: 'The provider had a problem answering (5xx). Try again later.',
  unreachable: "No answer from the provider. Check this server's network, DNS and proxy.",
  unexpected: "The provider's answer wasn't one Botons could read.",
};

const EVIDENCE: Record<CapabilityEvidence, string> = { yes: 'yes', no: 'no', unknown: 'unknown' };

/** Realtime voice, speech-to-text and text-to-speech: one word when the list says the same of all three. */
function voiceAndSpeech(m: ApiModel): string {
  const all = [m.capabilities.realtimeVoice, m.capabilities.speechToText, m.capabilities.textToSpeech];
  return all.every((e) => e === all[0]) ? EVIDENCE[all[0]] : `voice ${EVIDENCE[all[0]]}, speech-to-text ${EVIDENCE[all[1]]}, text-to-speech ${EVIDENCE[all[2]]}`;
}

export function sourceText(k: ApiKeyState): string {
  if (k.source === 'saved') return k.environment ? `Saved key in use (it takes the place of ${k.envVar} in the server's environment)` : 'Saved key in use';
  if (k.source === 'environment') return `Using ${k.envVar} from the server's environment`;
  return 'No key';
}

/** What real turns on this key showed, per model: first seen; never seen is unknown, not "no". */
function Observed({ observed }: { observed: ApiModelObservation[] }) {
  if (!observed.length) return <p className="hint">No turns on this key yet: what its models can do is only what the model list says.</p>;
  const what = (o: ApiModelObservation) =>
    [o.chat && `chat (${relative(o.chat)})`, o.tools && `tool use (${relative(o.tools)})`, o.vision && `images (${relative(o.vision)})`].filter(Boolean).join(', ');
  return (
    <div className="api-key-observed">
      <p className="hint">Seen working in this key's own turns (first seen; something not seen yet is unknown, not "no"):</p>
      <ul>
        {observed.map((o) => (
          <li key={o.model} className="hint">
            <code>{o.model}</code>: {what(o)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TestResult({ test }: { test: ApiKeyTest }) {
  const ok = test.outcome === 'ok';
  return (
    <div className="api-key-test" data-outcome={test.outcome}>
      <p className={cx('hint', !ok && 'warn')}>
        {ok ? `${OUTCOME.ok}: it can list ${test.models.length} model${test.models.length === 1 ? '' : 's'}` : OUTCOME[test.outcome]}
        {' · '}
        {test.source === 'saved' ? 'saved key' : 'environment key'}, tested {relative(test.checkedAt)}
        {!test.current && ' · the key changed while this ran, so it says nothing about the key there is now'}
      </p>
      {ok && test.models.length > 0 && <ModelList provider={test.provider} models={test.models} omitted={test.omitted} truncated={test.truncated} />}
    </div>
  );
}

function ModelList({ provider, models, omitted, truncated }: { provider: string; models: ApiModel[]; omitted: number; truncated: boolean }) {
  return (
    <details className="api-key-models">
      <summary className="hint">Models and what the provider's list says about them</summary>
      <p className="hint">
        {provider === 'openai'
          ? "OpenAI's model list doesn't say what each model can do, so every capability here is unknown."
          : "Anthropic's model list says whether a model takes images and which effort levels it has. It doesn't say whether it does chat, tool use, realtime voice or speech, so those are unknown."}{' '}
        Botons doesn't guess a capability from a model's name.
        {omitted > 0 && ` ${omitted} left out (an id not of the expected shape, or past the first 500).`}
        {truncated && ' The list had more pages than Botons reads.'}
      </p>
      <table className="api-key-model-table">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Vision</th>
            <th scope="col">Tools</th>
            <th scope="col" title="Realtime voice, speech-to-text, text-to-speech">Voice and speech</th>
            <th scope="col">Effort</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td>
                <code>{m.id}</code>
                {m.displayName && <span className="hint"> {m.displayName}</span>}
                {m.lifecycle && m.lifecycle !== 'active' && <span className="hint warn"> {m.lifecycle}</span>}
              </td>
              <td>{EVIDENCE[m.capabilities.vision]}</td>
              <td>{EVIDENCE[m.capabilities.tools]}</td>
              <td>{voiceAndSpeech(m)}</td>
              <td>{m.effort === null ? 'unknown' : m.effort.length ? m.effort.join(', ') : 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function ApiKeyItem({ k }: { k: ApiKeyState }) {
  // The pasted key lives only here, in memory, until it is saved; then it is cleared. It is never stored in the page.
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | 'test' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<ApiKeyTest | null>(null);

  const run = async (what: 'save' | 'remove' | 'test', fn: () => Promise<string | null>) => {
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

  // Of the test shown, the saved one for the key there is now; a just-run test that came back about an older key too.
  const test = lastTest && !lastTest.current ? lastTest : k.test;
  const placeholder = k.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…';

  return (
    <li className="api-key-item" data-provider={k.provider} data-source={k.source}>
      <p className="brain-head">
        <strong>{k.label}</strong>: <span className={cx('brain-status', k.source === 'none' ? 'unknown' : 'ok')}>{sourceText(k)}</span>
        {k.savedAt && <span className="hint"> · saved {relative(k.savedAt)}</span>}
      </p>
      <p className="hint api-key-brain">
        {k.brain.available
          ? `Botons can run on this key: pick “${k.provider === 'anthropic' ? 'Claude (Anthropic API key)' : 'OpenAI (API key)'}” as a Boton's brain.`
          : k.brain.reason}
      </p>
      {k.testing && <p className="hint">Testing…</p>}
      {test && <TestResult test={test} />}
      {k.source !== 'none' && <Observed observed={k.observed} />}
      <form
        className="api-key-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run('save', async () => {
            const next = await api.saveApiKey(k.provider, key, k.generation);
            setKey('');
            setLastTest(null);
            actions.apiKeyChanged(next);
            return k.saved ? 'Replaced the saved key. Test it to see what it can use.' : 'Saved. Test it to see what it can use.';
          });
        }}
      >
        <label>
          <span className="field-label">{k.saved ? `Replace the saved ${k.label} key` : `Save a key for ${k.label}`}</span>
          <span className="topic-row">
            <input
              type="password"
              name={`api-key-${k.provider}`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={k.saved ? 'Saved. Paste a new key to replace it' : placeholder}
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
            />
            <button type="submit" className="btn small primary" disabled={!!busy || !key.trim()}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </span>
        </label>
      </form>
      <p className="hint">{k.testDescription}</p>
      <div className="form-actions api-key-actions">
        {k.saved && !confirming && (
          <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => setConfirming(true)}>
            Remove the saved key
          </button>
        )}
        <button
          type="button"
          className="btn small"
          disabled={!!busy || k.testing || k.source === 'none'}
          onClick={() =>
            run('test', async () => {
              const t = await api.testApiKey(k.provider);
              setLastTest(t);
              return null;
            })
          }
        >
          {busy === 'test' ? 'Testing…' : 'Test key'}
        </button>
      </div>
      {confirming && (
        <div className="api-key-confirm" role="group" aria-label={`Remove the saved ${k.label} key`}>
          <p className="hint warn">
            {k.environment
              ? `Remove the saved key? From then on Botons uses ${k.envVar} from the server's environment.`
              : `Remove the saved key? There will be no ${k.label} key.`}{' '}
            Revoke it with {k.label} too if it may have leaked: removing it here doesn't, and older backups still hold it.
          </p>
          <div className="form-actions">
            <button type="button" className="btn small ghost" onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn small danger"
              disabled={!!busy}
              onClick={() =>
                run('remove', async () => {
                  const next = await api.removeApiKey(k.provider, k.generation);
                  setConfirming(false);
                  setLastTest(null);
                  actions.apiKeyChanged(next);
                  return next.source === 'environment' ? `Removed. Now using ${next.envVar} from the server's environment.` : 'Removed. There is no key now.';
                })
              }
            >
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
      {k.source === 'environment' && !k.saved && (
        <p className="hint">To stop using it, remove {k.envVar} from the server's environment and restart the server. Saving a key here takes its place.</p>
      )}
      {error && <p className="form-error">{error}</p>}
      {result && <p className="hint">{result}</p>}
    </li>
  );
}

/** Settings → API keys: the owner's Anthropic and OpenAI keys, never shown once saved. */
export function ApiKeys() {
  const view = useStore((s) => s.apiKeys);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    actions.loadApiKeys().catch((err: Error) => setError(err.message));
  }, []);
  return (
    <section className="server-info api-keys">
      <h4>API keys</h4>
      <p className="hint">
        Your own Anthropic and OpenAI API keys, for brains that use the providers' APIs directly. Botons runs their agent loop itself: their commands and file edits
        run on this server (sandboxed for Workspace access), their connectors are Botons' own, and each turn's tokens and estimated cost are shown with its reply.
        Caps on what a Boton spends are in its settings, under Spending.
      </p>
      <p className="hint">
        A saved key is kept in Botons' database, like sign-in connector tokens: it is in every backup, it is never shown again, and Workspace Botons can't
        read it (Full computer Botons run as the server's user, so they could). Without a saved key, Botons uses ANTHROPIC_API_KEY or OPENAI_API_KEY from the
        server's environment, if set; agent CLIs are never given either.
      </p>
      {error && <p className="form-error">{error}</p>}
      {view && (
        <ul className="brain-list api-key-list">
          {view.providers.map((k) => (
            <ApiKeyItem key={k.provider} k={k} />
          ))}
        </ul>
      )}
    </section>
  );
}
