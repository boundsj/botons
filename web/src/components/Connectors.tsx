import { useEffect, useId, useRef, useState } from 'react';
import type { Connector, ConnectorGrant, ConnectorNotice, ConnectorSource, ConnectorTest, McpServer, McpServerInput, OAuthConnection } from '../../../shared/types.ts';
import { presetFor, SERVICE_PRESETS, type ServicePreset } from '../../../shared/services.ts';
import { BROWSER_CONNECTOR } from '../../../shared/util.ts';
import { api } from '../api.ts';
import { attempt, errorText } from '../feedback.ts';
import { actions, getState, useStore } from '../state.ts';
import { headerPatch, type HeaderRow } from '../service-form.ts';
import { relative } from '../util.ts';
import { Segmented } from './BotFields.tsx';
import { withCode } from './BrainWarning.tsx';
import { ConnectorBotons, ConnectorPower, BotonsDisclosure } from './ConnectorAccess.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { AlertIcon, EditIcon, PlusIcon, TrashIcon } from './Icons.tsx';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const SOURCE_LABEL: Record<ConnectorSource, string> = {
  library: 'Your MCP servers (Settings)',
  oauth: 'Signed in with OAuth (Settings)',
};

/**
 * What the owner should know about this Boton's connectors: ones taken off it because Botons no longer uses the
 * CLIs' own servers (with a Botons connector to use instead, when one matches), and ones its last turn went without.
 */
/** `skip`: connectors whose notices aren't shown (the browser, on a brain that never gets it). */
export function ConnectorNotices(props: { botId: string; value: string[]; onChange: (ids: string[]) => void; skip?: string[] }) {
  const [notices, setNotices] = useState<ConnectorNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setNotices(null);
    void attempt('load the notices about its connectors', async () => {
      const list = await api.connectorNotices(props.botId);
      if (live) setNotices(list);
    }, setError);
    return () => {
      live = false;
    };
  }, [props.botId]);
  const dismiss = (n: ConnectorNotice) =>
    void attempt('dismiss the notice', async () => {
      await api.dismissConnectorNotice(props.botId, n.connectorId);
      setNotices((list) => list?.filter((x) => x.connectorId !== n.connectorId) ?? null);
    }, setError);
  if (error) return <p className="form-error">{error}</p>;
  const shown = notices?.filter((n) => !props.skip?.includes(n.connectorId));
  if (!shown?.length) return null;
  return (
    <div className="connections-group connector-notices" role="status">
      <span className="connections-source">Needs your attention</span>
      {shown.map((n) => (
        <div key={n.connectorId} className="connector-notice">
          <span className="connector-text">
            <span className="connector-name">
              <AlertIcon size={12} className="warn-icon" /> {n.connectorId === BROWSER_CONNECTOR ? 'Web browsing' : n.name}
              {n.kind === 'removed' ? <span className="badge warn-badge">removed</span> : <span className="badge warn-badge">left out</span>}
            </span>
            {n.target && (
              <span className="connector-target" title={n.target}>
                {n.target}
              </span>
            )}
            <span className="hint">
              {n.kind === 'skipped' ? `Its last turn (${relative(n.at)}) went without it: ${n.reason}.` : withCode(n.reason)}
            </span>
            {n.kind === 'removed' && !n.offer && <span className="hint">No Botons connector has this name or address: add one in Settings → Connectors to give it back.</span>}
          </span>
          <span className="connector-notice-actions">
            {n.offer &&
              (props.value.includes(n.offer.id) ? (
                <span className="hint">{n.offer.name} is on.</span>
              ) : (
                <button type="button" className="btn small" onClick={() => props.onChange([...props.value, n.offer!.id])} title={n.offer.target}>
                  Use {n.offer.name} ({n.offer.id.startsWith('oauth:') ? 'OAuth' : 'your MCP server'})
                </button>
              ))}
            {n.kind === 'removed' && (
              <button type="button" className="btn small ghost" onClick={() => dismiss(n)}>
                Dismiss
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Settings: Test, for a connector the server can reach itself, and what the last one found and covered. */
/** `autoRun`: test once as it opens (the guided flow, right after a save). */
function ConnectorTester({ id, label, testable, autoRun }: { id: string; label: string; testable: boolean; autoRun?: boolean }) {
  const c = useStore((s) => s.connectors?.connectors.find((x) => x.id === id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** An answer the server didn't keep (it changed while the test ran): why, since there is no result to show. */
  const [dropped, setDropped] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setDropped(null);
    try {
      const t = await actions.testConnector(id);
      const kept = getState().connectors?.connectors.find((x) => x.id === id)?.lastTest;
      if (kept?.at !== t.at) setDropped(t.problem);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const ran = useRef(false);
  useEffect(() => {
    if (!autoRun || !testable || ran.current) return;
    ran.current = true;
    void run();
  }, [autoRun, testable]);
  const t = c?.lastTest ?? null;
  return (
    <div className="connector-test" aria-live="polite">
      {!testable && c && <span className="hint">{withCode(c.basis)}</span>}
      {testable && (
        <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run()} aria-label={`Test ${label}`}>
          {busy ? 'Testing…' : 'Test'}
        </button>
      )}
      {testable && t && !busy && <TestResult test={t} />}
      {dropped && !busy && <span className="hint">{dropped}</span>}
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

function TestResult({ test }: { test: ConnectorTest }) {
  return (
    <div className="connector-test-result">
      {test.outcome === 'reached' && (
        <span className="hint">
          Reached {relative(test.at)}: {plural(test.toolCount, 'tool')}
          {test.toolCount > test.tools.length ? ` (the first ${test.tools.length} below)` : ''}.
        </span>
      )}
      {test.outcome === 'reached' && test.problem && (
        <span className="hint warn">
          <AlertIcon size={12} className="warn-icon" /> {test.problem}
        </span>
      )}
      {test.outcome === 'failed' && (
        <span className="hint warn">
          <AlertIcon size={12} className="warn-icon" /> Test failed {relative(test.at)}: {test.problem}
        </span>
      )}
      {test.outcome === 'untestable' && <span className="hint">Not tested.{test.problem ? ` ${test.problem}` : ''}</span>}
      <span className="hint">{withCode(test.scope)}</span>
      {test.tools.length > 0 && (
        <details>
          <summary>Its tools</summary>
          <ul className="connector-tools">
            {test.tools.map((name, i) => (
              <li key={`${i}-${name}`}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function McpLibrary() {
  const servers = useStore((s) => s.mcpServers);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!servers) void attempt('load your MCP servers', () => actions.loadMcpServers(), setError);
  }, [servers]);

  return (
    <section className="server-info mcp-library">
      <h4>MCP servers</h4>
      <p className="hint">Services added by a command or a URL. Give them to Botons in each Boton's settings.</p>
      <details className="set-more">
        <summary>Details</summary>
        <p className="hint">
        Servers Botons can be given as connectors, in each Boton's settings: a command to start (stdio) or a URL (http). Environment variables and headers
        are kept on this computer and only passed to the agent; they are never shown again. Botons doesn't use the MCP servers in your own Claude Code or
        Codex settings: add a server here (or sign in to one below) for Botons to use it, with either brain.
      </p>
      </details>
      {error && <p className="form-error">{error}</p>}
      {servers?.length === 0 && editing === null && <p className="empty-note">None yet.</p>}
      <ul className="mcp-list">
        {servers?.map((s) =>
          editing !== 'new' && editing?.name === s.name ? (
            <li key={s.name}>
              <McpServerForm server={s} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={s.name} className="mcp-item">
              <span className="connector-text">
                <span className="connector-name">{s.name}</span>
                <span className="connector-target">{s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</span>
                {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
                  <span className="hint">
                    {s.transport === 'stdio' ? 'Environment' : 'Headers'}: {(s.transport === 'stdio' ? s.envKeys : s.headerKeys).join(', ')}
                  </span>
                )}
                <ConnectorPower id={`lib:${s.name}`} />
                <ConnectorTester id={`lib:${s.name}`} label={s.name} testable={s.transport === 'http'} />
                <BotonsDisclosure id={`lib:${s.name}`} />
              </span>
              <button type="button" className="icon-btn small" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}>
                <EditIcon size={14} />
              </button>
              <button type="button" className="icon-btn small" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => setDeleting(s)}>
                <TrashIcon size={14} />
              </button>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <McpServerForm onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="btn small" onClick={() => setEditing('new')}>
          <PlusIcon size={14} /> Add an MCP server
        </button>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete"
          what={`delete ${deleting.name}`}
          danger
          onConfirm={() => actions.deleteMcpServer(deleting.name)}
          onClose={() => setDeleting(null)}
        >
          <p>Every Boton that has it loses it from its next turn on. Its saved environment variables or headers are deleted too.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

// "NAME=value" lines as a patch: a name with no value removes it.
function parsePairs(text: string, sep: '='): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(sep);
    const k = (i < 0 ? t : t.slice(0, i)).trim();
    const v = i < 0 ? '' : t.slice(i + 1).trim();
    out[k] = v === '' ? null : v;
  }
  return out;
}

/** A masked field with Show and Hide. Only what the owner typed can be shown: saved values never come back. */
function SecretInput(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; describedBy?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret-input">
      <input
        type={shown ? 'text' : 'password'}
        aria-label={props.label}
        aria-describedby={props.describedBy}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
      />
      <button type="button" className="btn small ghost" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${props.label}`} onClick={() => setShown(!shown)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}

/** Advanced: headers other than the key, masked, one row each; saved ones keep their value unless replaced or removed. */
function HeaderRows({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const edit = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="header-rows">
      {rows.map((r, i) => (
        <div key={i} className={r.remove ? 'header-row removed' : 'header-row'}>
          {r.saved ? (
            <code className="header-name">{r.name}</code>
          ) : (
            <input aria-label="Header name" value={r.name} onChange={(e) => edit(i, { name: e.target.value })} placeholder="X-Api-Key" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          )}
          {r.remove ? (
            <span className="hint">Removed when you save.</span>
          ) : (
            <SecretInput label={r.saved ? `New value for ${r.name}` : 'Header value'} value={r.value} onChange={(v) => edit(i, { value: v })} placeholder={r.saved ? 'Saved (hidden)' : 'Value'} />
          )}
          <button
            type="button"
            className="btn small ghost"
            onClick={() => (r.saved ? edit(i, { remove: !r.remove, value: '' }) : onChange(rows.filter((_, j) => j !== i)))}
          >
            {r.remove ? 'Keep' : 'Remove'}
          </button>
        </div>
      ))}
      <button type="button" className="btn small ghost" onClick={() => onChange([...rows, { name: '', value: '', saved: false, remove: false }])}>
        <PlusIcon size={14} /> Add a header
      </button>
    </div>
  );
}

/**
 * Add or edit one library server. `fixed`: the guided flow chose its type already; `preset`: a known service it
 * fills in; `onSaved` runs after a save.
 */
function McpServerForm({ server, onDone, fixed, preset, onSaved }: { server?: McpServer; onDone: () => void; fixed?: 'stdio' | 'http'; preset?: ServicePreset; onSaved?: (name: string) => void }) {
  const [name, setName] = useState(server?.name ?? preset?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? fixed ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).join('\n'));
  const [url, setUrl] = useState(server?.url ?? preset?.url ?? '');
  const [secrets, setSecrets] = useState('');
  const savedHeaders = server?.transport === 'http' ? server.headerKeys : [];
  const savedKey = savedHeaders.find((k) => k.toLowerCase() === 'authorization');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [rows, setRows] = useState<HeaderRow[]>(() => savedHeaders.filter((k) => k !== savedKey).map((k) => ({ name: k, value: '', saved: true, remove: false })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = preset ?? presetFor(url);
  const hintId = useId();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: McpServerInput =
        transport === 'stdio'
          ? { transport, command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), env: parsePairs(secrets, '=') }
          : { transport, url: url.trim(), headers: headerPatch(apiKey, removeKey, rows, savedHeaders) };
      await actions.saveMcpServer(server?.name ?? null, server ? input : { ...input, name: name.trim() });
      setApiKey('');
      if (onSaved) onSaved(server?.name ?? name.trim());
      else onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!server && (
        <label>
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" maxLength={40} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          <span className="hint">Lowercase letters, digits, - and _. Botons see its tools under this name.</span>
        </label>
      )}
      {!fixed && (
        <Segmented
          label="Type"
          options={[
            { value: 'stdio', label: 'Command (stdio)' },
            { value: 'http', label: 'URL (http)' },
          ]}
          value={transport}
          onChange={setTransport}
        />
      )}
      {transport === 'stdio' ? (
        <>
          <label>
            <span className="field-label">Command</span>
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" autoComplete="off" spellCheck={false} />
          </label>
          <label>
            <span className="field-label">Arguments, one per line</span>
            <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-github'} spellCheck={false} />
          </label>
          <label>
            <span className="field-label">Environment variables</span>
            <textarea value={secrets} onChange={(e) => setSecrets(e.target.value)} rows={2} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…" autoComplete="off" spellCheck={false} />
            <span className="hint">
              {server?.envKeys.length ? `Saved: ${server.envKeys.join(', ')} (values hidden). ` : ''}
              One per line, NAME=value. A line with only a name removes it; names you leave out keep their saved values.
            </span>
          </label>
        </>
      ) : (
        <>
          <label>
            <span className="field-label">URL</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" inputMode="url" autoComplete="off" spellCheck={false} />
          </label>
          <div className="secret-field">
            <span className="field-label">{known?.secretLabel ?? 'API key or token'}</span>
            {removeKey ? (
              <span className="hint">Removed when you save.</span>
            ) : (
              <SecretInput
                label={known?.secretLabel ?? 'API key or token'}
                value={apiKey}
                onChange={setApiKey}
                placeholder={savedKey ? 'Saved (hidden). Type a new one to replace it.' : (known?.secretPlaceholder ?? 'Paste it here')}
                describedBy={hintId}
              />
            )}
            <span className="hint" id={hintId}>
              Sent as <code>Authorization: Bearer …</code>. Kept on this computer, never shown again.
              {known && (
                <>
                  {' '}
                  {known.note}{' '}
                  <a href={known.help.url} target="_blank" rel="noreferrer noopener">
                    {known.help.text}
                  </a>
                </>
              )}
            </span>
            {savedKey && (
              <button
                type="button"
                className="btn small ghost secret-remove"
                onClick={() => {
                  setApiKey('');
                  setRemoveKey(!removeKey);
                }}
              >
                {removeKey ? 'Keep the saved key' : 'Remove the saved key'}
              </button>
            )}
          </div>
          <details className="set-more" open={rows.some((r) => r.saved) || undefined}>
            <summary>Advanced: other headers</summary>
            <p className="hint">For a service that wants its key in another header, such as X-Api-Key. Values are hidden.</p>
            <HeaderRows rows={rows} onChange={setRows} />
          </details>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onDone} disabled={busy}>
          {fixed ? 'Back' : 'Cancel'}
        </button>
        <button type="submit" className="btn primary" disabled={busy || (!server && !name.trim())}>
          {busy ? 'Saving…' : onSaved && transport === 'http' ? 'Save and test' : server ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  );
}

const STATUS_TEXT: Record<OAuthConnection['status'], string> = { new: 'not signed in', connected: 'connected', reconnect: 'sign in again' };

/** Settings: remote MCP servers signed in to with OAuth. A URL and Connect; the sign-in happens at the server. */
export function OAuthConnectors() {
  const oauth = useStore((s) => s.oauth);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<OAuthConnection | null>(null);

  useEffect(() => {
    if (!oauth) void attempt('load your OAuth connectors', () => actions.loadOAuth(), setError);
  }, [oauth]);

  const connect = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await actions.connectOAuth(id);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('new');
    setError(null);
    let created: OAuthConnection;
    try {
      created = await actions.addOAuth({ name: name.trim(), url: url.trim() });
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
      return;
    }
    setName('');
    setUrl('');
    await connect(created.id);
  };

  const ready = !!oauth?.redirectUri;
  return (
    <section className="server-info mcp-library oauth-connectors">
      <h4>Sign-in connectors (OAuth)</h4>
      <p className="hint">Services you sign in to with your account.</p>
      <details className="set-more">
        <summary>Details</summary>
        <p className="hint">
        Remote MCP servers you sign in to, such as a fleet gateway. Botons registers itself with the server, you approve it on the server's own page, and
        its tokens stay on this computer: Botons you give it to get only a short-lived access token for each turn.
      </p>
      </details>
      {oauth && !ready && (
        <p className="hint warn" role="note">
          Signing in needs an HTTPS address for the sign-in to come back to. Set <code>BOTONS_OAUTH_PUBLIC_URL</code> (see docs/connectors.md, "The HTTPS callback") and
          restart Botons.
        </p>
      )}
      {ready && <p className="hint">Sign-ins come back to <code>{oauth.redirectUri}</code>.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="mcp-list">
        {oauth?.connections.map((c) => (
          <li key={c.id} className="mcp-item oauth-item">
            <span className="connector-text">
              <span className="connector-name">
                {c.name}
                <span className={c.status === 'connected' ? 'badge' : 'badge warn-badge'}>{STATUS_TEXT[c.status]}</span>
                {c.feed && <span className="badge">work feed</span>}
              </span>
              <span className="connector-target" title={c.url}>
                {c.url}
              </span>
              {c.status === 'reconnect' && c.statusReason && <span className="hint warn">{c.statusReason}</span>}
              {c.refreshError && <span className="hint warn">The last token refresh failed and will be tried again: {c.refreshError}</span>}
              {c.feedError && <span className="hint warn">Work feed: {c.feedError}</span>}
              {c.status === 'connected' && (
                <span className="hint">
                  {c.issuer ? `Signed in at ${c.issuer}` : 'Signed in'}
                  {c.refreshedAt ? `, token refreshed ${relative(c.refreshedAt)}` : ''}.
                </span>
              )}
              <ConnectorPower id={`oauth:${c.name}`} />
              {c.status === 'connected' && <ConnectorTester id={`oauth:${c.name}`} label={c.name} testable />}
              <BotonsDisclosure id={`oauth:${c.name}`} />
              <label className="check">
                <input type="checkbox" checked={c.keepConnected} onChange={(e) => void attempt('change keep connected', () => actions.updateOAuth(c.id, { keepConnected: e.target.checked }), setError)} />
                <span>Keep connected (refresh weekly, so an unused sign-in doesn't lapse)</span>
              </label>
              {c.feed && (
                <label className="oauth-unknown">
                  <span className="field-label">Updates on work no Boton is known to have started</span>
                  <select value={c.unknownJobs} onChange={(e) => void attempt('change where updates go', () => actions.updateOAuth(c.id, { unknownJobs: e.target.value as 'nowhere' | 'primary' }), setError)}>
                    <option value="nowhere">Ignore them</option>
                    <option value="primary">Send them to the primary Boton</option>
                  </select>
                </label>
              )}
            </span>
            <span className="oauth-actions">
              <button type="button" className={c.status === 'connected' ? 'btn small ghost' : 'btn small primary'} disabled={!ready || busy !== null} onClick={() => void connect(c.id)}>
                {busy === c.id ? 'Opening…' : c.status === 'connected' ? 'Sign in again' : c.status === 'reconnect' ? 'Reconnect' : 'Connect'}
              </button>
              <button type="button" className="icon-btn small" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => setDeleting(c)}>
                <TrashIcon size={14} />
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form className="mcp-form oauth-form" onSubmit={(e) => void add(e)}>
        <label>
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="fleet" maxLength={40} autoComplete="off" autoCapitalize="off" spellCheck={false} required />
          <span className="hint">Lowercase letters, digits, - and _. Botons see its tools under this name.</span>
        </label>
        <label>
          <span className="field-label">MCP server URL</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" inputMode="url" autoComplete="off" spellCheck={false} required />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={!ready || busy !== null}>
            {busy === 'new' ? 'Connecting…' : 'Add and connect'}
          </button>
        </div>
      </form>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete"
          what={`delete ${deleting.name}`}
          danger
          onConfirm={() => actions.deleteOAuth(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          <p>Every Boton that has it loses it from its next turn on. Its tokens are deleted from this computer (sign out at the server too, to revoke them there).</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Settings: which connectors Botons may ask for themselves, and whether you approve each request. */
export function ConnectorRequests() {
  const catalog = useStore((s) => s.connectors);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!catalog) void attempt('load the connectors', () => actions.loadConnectors(), setError);
  }, [catalog]);
  const set = (c: Connector, input: { onRequest?: boolean; grant?: ConnectorGrant }) => void attempt(`change ${c.name}`, () => actions.setConnectorPolicy(c.id, input), setError);
  return (
    <section className="server-info mcp-library connector-requests">
      <h4>Connectors Botons can ask for</h4>
      <p className="hint">Services Botons may ask you for when they need one.</p>
      <details className="set-more">
        <summary>Details</summary>
        <p className="hint">
        A Boton uses only the connectors checked in its settings. Turn one on here and Botons can ask for it with <code>botons connector request</code>: you
        approve each request on a card, or let it be granted at once. Runs started by a webhook always need your approval.
      </p>
      </details>
      {error && <p className="form-error">{error}</p>}
      {catalog && !catalog.connectors.some((c) => !c.managed) && <p className="empty-note">No connectors yet.</p>}
      <ul className="mcp-list">
        {catalog?.connectors.filter((c) => !c.managed).map((c) => (
          <li key={c.id} className="mcp-item">
            <label className="check connector">
              <input type="checkbox" checked={c.onRequest} onChange={(e) => set(c, { onRequest: e.target.checked })} />
              <span className="connector-text">
                <span className="connector-name">{c.name}</span>
                <span className="hint">{SOURCE_LABEL[c.source]}</span>
              </span>
            </label>
            {c.onRequest && (
              <select aria-label={`How a request for ${c.name} is granted`} value={c.grant} onChange={(e) => set(c, { grant: e.target.value as ConnectorGrant })}>
                <option value="approval">Ask me</option>
                <option value="immediate">Grant at once</option>
              </select>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type ServiceKind = 'oauth' | 'http' | 'stdio';

const KINDS: { kind: ServiceKind; label: string; text: string }[] = [
  { kind: 'oauth', label: 'Sign in to it', text: "A remote MCP server with its own sign-in page (OAuth). You approve Botons there; its tokens stay on this computer." },
  { kind: 'http', label: 'A URL and an API key', text: 'A remote MCP server you reach with a key or token, sent in a header. The key is kept here and never shown again.' },
  { kind: 'stdio', label: 'A command on this computer', text: "A local MCP server (stdio) started inside each turn of a Boton that has it, in the Workspace sandbox whatever that Boton's access: it sees this computer's programs, the folders its command and arguments name and its own empty /tmp, with this computer's network, but no workspace, shared folder or data folder. Give the full path to a program kept outside those. Botons doesn't run it to test it." },
];

const STEPS = ['How it connects', 'Its details', 'Test it and choose Botons'];

/** The guided flow's step list, for the dialog and for review. */
export function ServiceSteps({ step }: { step: number }) {
  return (
    <ol className="service-steps" aria-label="Steps">
      {STEPS.map((label, i) => (
        <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

/** The guided flow's first step: how the service connects. */
export function ServiceKindPicker({ onPick, onPreset, oauthReady }: { onPick: (k: ServiceKind) => void; onPreset?: (p: ServicePreset) => void; oauthReady: boolean }) {
  return (
    <div className="service-kinds">
      {onPreset && (
        <div className="service-presets" role="group" aria-label="Known services">
          {SERVICE_PRESETS.map((p) => (
            <button key={p.id} type="button" className="service-kind service-preset" onClick={() => onPreset(p)}>
              <span className="connector-name">{p.label}</span>
              <span className="hint">{p.secretLabel}</span>
            </button>
          ))}
        </div>
      )}
      {KINDS.map((k) => (
        <button key={k.kind} type="button" className="service-kind" disabled={k.kind === 'oauth' && !oauthReady} onClick={() => onPick(k.kind)}>
          <span className="connector-name">{k.label}</span>
          <span className="hint">{k.text}</span>
          {k.kind === 'oauth' && !oauthReady && (
            <span className="hint warn">
              Needs <code>BOTONS_OAUTH_PUBLIC_URL</code>, an HTTPS address for the sign-in to come back to (see docs/connectors.md, "The HTTPS callback").
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Settings: Connect a service, step by step: how it connects, its details, then a test (for what Botons can reach
 * itself) and exactly which Botons get it. Each step saves through the same calls as the lists below it.
 */
export function ConnectService() {
  const [open, setOpen] = useState(false);
  return (
    <section className="server-info connect-service">
      <h4>Connect a service</h4>
      <p className="hint">Add a service Botons can use, such as GitHub, Linear or Slack, test it and choose exactly which Botons get it.</p>
      <button type="button" className="btn small primary" onClick={() => setOpen(true)}>
        <PlusIcon size={14} /> Connect a service
      </button>
      {open && <ConnectServiceDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

/** Also opened from a starter's review, when the owner has no connector to fill one of its slots. */
export function ConnectServiceDialog({ onClose }: { onClose: () => void }) {
  const oauth = useStore((s) => s.oauth);
  const [kind, setKind] = useState<ServiceKind | null>(null);
  const [preset, setPreset] = useState<ServicePreset | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!oauth) void attempt('load your OAuth connectors', () => actions.loadOAuth(), setError);
  }, [oauth]);
  const step = !kind ? 0 : !id ? 1 : 2;
  const record = id?.startsWith('oauth:') ? oauth?.connections.find((c) => `oauth:${c.name}` === id) : null;

  const addOAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await actions.addOAuth({ name: name.trim(), url: url.trim() });
      setId(`oauth:${c.name}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const signIn = async () => {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      await actions.connectOAuth(record.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Connect a service" onClose={onClose} wide>
      <ServiceSteps step={step} />
      {step === 0 && (
        <ServiceKindPicker
          oauthReady={!!oauth?.redirectUri}
          onPick={(k) => {
            setPreset(null);
            setKind(k);
          }}
          onPreset={(p) => {
            setPreset(p);
            setKind('http');
          }}
        />
      )}
      {step === 1 && kind === 'oauth' && (
        <form className="mcp-form" onSubmit={(e) => void addOAuth(e)}>
          <label>
            <span className="field-label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="fleet" maxLength={40} autoComplete="off" autoCapitalize="off" spellCheck={false} required />
            <span className="hint">Lowercase letters, digits, - and _. Botons see its tools under this name.</span>
          </label>
          <label>
            <span className="field-label">MCP server URL</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" inputMode="url" autoComplete="off" spellCheck={false} required />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setKind(null)} disabled={busy}>
              Back
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add it'}
            </button>
          </div>
        </form>
      )}
      {step === 1 && kind !== 'oauth' && (
        <McpServerForm key={preset?.id ?? kind} fixed={kind!} preset={preset ?? undefined} onDone={() => setKind(null)} onSaved={(n) => setId(`lib:${n}`)} />
      )}
      {step === 2 && id && (
        <div className="service-check">
          {kind === 'oauth' ? (
            record?.status === 'connected' ? (
              <ConnectorTester id={id} label={record.name} testable />
            ) : (
              <div className="connector-test">
                <span className="hint">
                  Not signed in yet: Botons you give it to go without it until you sign in. Sign in opens the server's own page and comes back to
                  Settings.
                </span>
                <button type="button" className="btn small primary" disabled={busy || !record} onClick={() => void signIn()}>
                  {busy ? 'Opening…' : 'Sign in'}
                </button>
              </div>
            )
          ) : (
            <ConnectorTester id={id} label={id.slice(4)} testable={kind === 'http'} autoRun />
          )}
          <h5>Which Botons can use it</h5>
          <ConnectorBotons id={id} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="hint">Save grant changes above before Done. Unsaved choices are discarded when you close.</p>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
