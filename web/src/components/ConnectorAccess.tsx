import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConnectorAccess, ConnectorBotonAccess } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, errorText } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { relative } from '../util.ts';
import { Dialog } from './Dialog.tsx';
import { AlertIcon } from './Icons.tsx';
import { ACTIONS, detailText } from './Setup.tsx';

const names = (list: ConnectorBotonAccess[]) => list.map((m) => m.name).join(', ');

/** What saving would change, in the owner's words, or null if nothing. */
export function pendingText(access: ConnectorAccess, draft: ReadonlySet<string>): string | null {
  const gain = access.botons.filter((m) => !m.has && draft.has(m.botId));
  const lose = access.botons.filter((m) => m.has && !draft.has(m.botId));
  if (!gain.length && !lose.length) return null;
  const parts = [gain.length ? `gives ${access.name} to ${names(gain)}` : '', lose.length ? `takes it from ${names(lose)}` : ''].filter(Boolean);
  return `Saving ${parts.join(' and ')}, from their next turn on.`;
}

/** Where one Boton stands, and what saving would change for it (`wanted`: checked now). */
function BotonState({ m, wanted }: { m: ConnectorBotonAccess; wanted: boolean }) {
  if (m.has && !wanted) return <span className="badge warn-badge">loses it when you save</span>;
  if (!m.has && wanted) return <span className="badge">gets it when you save</span>;
  if (m.has) return <span className="badge">has it</span>;
  if (!m.brainCanUse) return <span className="badge muted-badge">its brain can't use connectors</span>;
  if (m.mayAsk) return <span className="badge muted-badge">may ask for it</span>;
  return null;
}

/**
 * Exactly which Botons may use one connector: the ones that have it (their turns get it), the ones that may ask for
 * it, and the ones whose brain can't use connectors; then what was done to it, newest first.
 */
export function ConnectorAccessView(props: {
  access: ConnectorAccess;
  draft: ReadonlySet<string>;
  onToggle: (botId: string, on: boolean) => void;
  onSave: () => void;
  onReset: () => void;
  busy: boolean;
  error: string | null;
  stale: boolean;
}) {
  const { access, draft } = props;
  const holders = access.botons.filter((m) => m.has);
  const pending = pendingText(access, draft);
  return (
    <div className="connector-access">
      {!access.enabled && (
        <p className="hint warn" role="note">
          <AlertIcon size={12} className="warn-icon" /> Turned off: the Botons checked here keep it, but no turn gets it and none may ask for it until you turn it
          on again.
        </p>
      )}
      <p className="hint" role="status">
        {holders.length ? `${holders.length === 1 ? '1 Boton has' : `${holders.length} Botons have`} it: ${names(holders)}.` : 'No Boton has it yet.'}{' '}
        {access.managed
          ? 'Give or take the browser in each Boton\'s settings, under Browser, where its sites are.'
          : !access.enabled
            ? 'Changes you save here take effect once it is on.'
            : access.onRequest
            ? `Others may ask for it, and ${access.grant === 'immediate' ? 'get it at once' : 'you approve each request'}.`
            : 'Only the Botons checked here get it; none can ask for it.'}
      </p>
      {access.botons.length === 0 && <p className="empty-note">No Botons yet.</p>}
      <ul className="connector-access-list">
        {access.botons.map((m) => (
          <li key={m.botId}>
            {access.managed ? (
              <span className="connector-text">
                <span className="connector-name">
                  {m.name} <BotonState m={m} wanted={m.has} />
                </span>
              </span>
            ) : (
              <label className="check connector">
                <input
                  type="checkbox"
                  checked={draft.has(m.botId)}
                  disabled={props.busy || (!m.brainCanUse && !m.has)}
                  onChange={(e) => props.onToggle(m.botId, e.target.checked)}
                />
                <span className="connector-text">
                  <span className="connector-name">
                    {m.name} <BotonState m={m} wanted={draft.has(m.botId)} />
                  </span>
                  {m.withoutReason && (
                    <span className="hint warn">
                      <AlertIcon size={12} className="warn-icon" /> Its last turn went without it: {m.withoutReason}.
                    </span>
                  )}
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
      {pending && <p className="hint">{pending}</p>}
      {props.error && (
        <p className="form-error" role="alert">
          {props.error}
        </p>
      )}
      {!access.managed && (pending || props.stale) && (
        <div className="form-actions">
          <button type="button" className="btn ghost small" disabled={props.busy} onClick={props.onReset}>
            {props.stale ? 'Review again' : 'Undo'}
          </button>
          {!props.stale && (
            <button type="button" className="btn primary small" disabled={props.busy} onClick={props.onSave}>
              {props.busy ? 'Saving…' : 'Save who has it'}
            </button>
          )}
        </div>
      )}
      <details className="connector-history">
        <summary>History ({access.history.length})</summary>
        {access.history.length === 0 ? (
          <p className="hint">Nothing recorded yet.</p>
        ) : (
          <ul className="audit-list">
            {access.history.map((e) => (
              <li key={e.seq}>
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
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

const holdersOf = (a: ConnectorAccess) => new Set(a.botons.filter((m) => m.has).map((m) => m.botId));

/** Loads one connector's Botons and saves the owner's choice, sending who had it so a stale view changes nothing. */
export function ConnectorBotons({ id }: { id: string }) {
  // Turned off or on meanwhile (in this list item's switch): what it shows is read again.
  const enabled = useStore((s) => s.connectors?.connectors.find((c) => c.id === id)?.enabled);
  const [access, setAccess] = useState<ConnectorAccess | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const show = (a: ConnectorAccess) => {
    setAccess(a);
    setDraft(holdersOf(a));
    setStale(false);
  };
  const load = async () => {
    setError(null);
    try {
      show(await api.connectorAccess(id));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    setAccess(null);
    void load();
  }, [id, enabled]);
  if (!access) return error ? <p className="form-error">{error}</p> : <p className="hint">Loading…</p>;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      show(await api.setConnectorAccess(id, { botIds: [...draft], expected: [...holdersOf(access)] }));
    } catch (e) {
      setError(errorText(e));
      if ((e as { status?: number }).status === 409) setStale(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConnectorAccessView
      access={access}
      draft={draft}
      busy={busy}
      error={error}
      stale={stale}
      onToggle={(botId, on) =>
        setDraft((d) => {
          const next = new Set(d);
          if (on) next.add(botId);
          else next.delete(botId);
          return next;
        })
      }
      onSave={() => void save()}
      onReset={() => (stale ? void load() : setDraft(holdersOf(access)))}
    />
  );
}

/** A connector's Botons in a list item, loaded when it is opened. */
export function BotonsDisclosure({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="connector-botons" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Which Botons can use it</summary>
      {open && <ConnectorBotons id={id} />}
    </details>
  );
}

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * A connector's on/off switch, in its Settings item. Off keeps its setup, sign-in and grants; the dialog says exactly
 * which Botons that touches, what a turn running now keeps, and what turning it on again gives back (only that).
 */
export function ConnectorPower({ id }: { id: string }) {
  const c = useStore((s) => s.connectors?.connectors.find((x) => x.id === id));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!c) void attempt('load the connectors', () => actions.loadConnectors(), setError);
  }, [c]);
  if (!c) return error ? <span className="form-error">{error}</span> : null;
  if (c.managed) return null;
  return (
    <span className={c.enabled ? 'connector-power' : 'connector-power off'}>
      {c.enabled ? (
        <span className="hint">On: Botons that have it get it in their turns.</span>
      ) : (
        <span className="hint warn">
          <AlertIcon size={12} className="warn-icon" /> Off since {relative(c.off?.at ?? '')}
          {c.off?.reason ? ` (${c.off.reason})` : ''}: no turn gets it and none may ask for it. Its setup{c.source === 'oauth' ? ', sign-in' : ''} and grants are kept.
        </span>
      )}
      <button type="button" className="btn small" onClick={() => setOpen(true)} aria-label={`${c.enabled ? 'Turn off' : 'Turn on'} ${c.name}`}>
        {c.enabled ? 'Turn off…' : 'Turn on…'}
      </button>
      {open && <PowerDialog id={id} name={c.name} oauth={c.source === 'oauth'} onClose={() => setOpen(false)} />}
    </span>
  );
}

function PowerDialog(props: { id: string; name: string; oauth: boolean; onClose: () => void }) {
  const [access, setAccess] = useState<ConnectorAccess | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const load = async () => {
    setError(null);
    setStale(false);
    try {
      setAccess(await api.connectorAccess(props.id));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, [props.id]);
  const turningOff = access?.enabled ?? true;
  const holders = access?.botons.filter((m) => m.has) ?? [];
  const running = access?.running ?? [];
  const confirm = async () => {
    if (!access) return;
    setBusy(true);
    setError(null);
    try {
      await api.setConnectorEnabled(props.id, {
        enabled: !access.enabled,
        ...(access.enabled && reason.trim() ? { reason: reason.trim() } : {}),
        // The turns it was shown running with it too: one started since means a new review, not a silent close.
        expected: { enabled: access.enabled, botIds: holders.map((m) => m.botId), running: running.map((t) => t.turnId) },
      });
      await actions.loadConnectors();
      props.onClose();
    } catch (e) {
      setError(errorText(e));
      if ((e as { status?: number }).status === 409) setStale(true);
    } finally {
      setBusy(false);
    }
  };
  const who = holders.length ? list(holders.map((m) => m.name)) : null;
  // In <body>, as ConfirmDialog is: never inside the Settings dialog's form or list.
  return createPortal(
    <Dialog title={`${turningOff ? 'Turn off' : 'Turn on'} ${props.name}?`} onClose={() => !busy && props.onClose()}>
      <div className="confirm-body">
        {!access && !error && <p className="hint">Loading…</p>}
        {access && turningOff && (
          <>
            <p>
              Nothing is deleted: its setup{props.oauth ? ', its sign-in (Keep connected still refreshes it)' : ''} and who has it are kept, so turning it on again
              puts back exactly what it had.
            </p>
            <p>
              {who
                ? `${who} ${holders.length === 1 ? 'keeps' : 'keep'} it, but ${holders.length === 1 ? 'its' : 'their'} turns go without it from the next one.`
                : 'No Boton has it now.'}{' '}
              No Boton may ask for it, and requests waiting on a card can't be allowed{props.oauth ? '; its work feed is not read' : ''}.
            </p>
            {running.length > 0 && (
              <p className="hint warn" role="note">
                <AlertIcon size={12} className="warn-icon" /> {list(running.map((m) => m.name))} {running.length === 1 ? 'has a turn' : 'have turns'} running with it now.
                Turning it off doesn't reach into {running.length === 1 ? 'that turn' : 'those turns'}: {running.length === 1 ? 'it keeps' : 'they keep'} {props.name} until{' '}
                {running.length === 1 ? 'it ends' : 'they end'}
                {props.oauth ? ", with the access token it was given (Botons can't take that back)" : ''}. To cut it sooner, stop {running.length === 1 ? 'that turn' : 'those turns'} in
                the chat.
              </p>
            )}
            <label className="oauth-unknown">
              <span className="field-label">Why (optional, kept in its history)</span>
              <input type="text" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rotating its key" />
            </label>
          </>
        )}
        {access && !turningOff && (
          <>
            <p>
              {who
                ? `${who} ${holders.length === 1 ? 'gets' : 'get'} it back from ${holders.length === 1 ? 'its' : 'their'} next turn: exactly the Botons that had it, no one else.`
                : 'No Boton has it, so no turn gets it until you give it to one.'}
            </p>
            <p className="hint">
              {access.onRequest
                ? `Others may ask for it again (${access.grant === 'immediate' ? 'granted at once' : 'you approve each request'}). Requests made before it was turned off stay refused.`
                : 'None may ask for it. Requests made before it was turned off stay refused.'}
            </p>
          </>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={props.onClose} disabled={busy}>
          Cancel
        </button>
        {stale ? (
          <button type="button" className="btn primary" onClick={() => void load()} disabled={busy}>
            Review again
          </button>
        ) : (
          <button
            type="button"
            className={turningOff ? 'btn danger-solid' : 'btn primary'}
            onClick={() => void confirm()}
            disabled={busy || !access}
          >
            {busy ? 'Saving…' : turningOff ? 'Turn it off' : 'Turn it on'}
          </button>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
