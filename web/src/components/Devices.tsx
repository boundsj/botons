import { useEffect, useState } from 'react';
import type { Device } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { actions } from '../state.ts';
import { relative } from '../util.ts';

export function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  // The approve form: open, the code typed, and what the last approval said.
  const [approving, setApproving] = useState(false);
  const [code, setCode] = useState('');
  const [approved, setApproved] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .devices()
      .then(setDevices)
      .catch((err) => setError((err as Error).message));
  useEffect(() => {
    void load();
  }, []);

  // The device signs in within a couple of seconds of its approval; list it then.
  useEffect(() => {
    if (!approved) return;
    const t = setTimeout(() => void load(), 4000);
    return () => clearTimeout(t);
  }, [approved]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = (d: Device) =>
    act(async () => {
      setConfirming(null);
      if (d.current) return actions.signOut();
      await api.revokeDevice(d.id);
      await load();
    });

  const approve = () =>
    act(async () => {
      const done = await api.approvePairing({ code });
      setApproved(done.label);
      setCode('');
      setApproving(false);
    });

  return (
    <section className="server-info devices">
      <h4>Devices</h4>
      <p className="hint">Paired devices can use Botons. Revoking one signs it out at once.</p>
      {devices === null && !error && <p className="hint">Loading…</p>}
      {devices && (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id}>
              <span className="device-text">
                <span className="device-name">
                  {d.label}
                  {d.current && <span className="device-tag">this device</span>}
                </span>
                <span className="hint">
                  Paired {relative(d.createdAt)}
                  {d.lastUsedAt && !d.current ? ` · used ${relative(d.lastUsedAt)}` : ''}
                </span>
              </span>
              {confirming === d.id ? (
                <span className="device-actions">
                  <button type="button" className="btn small ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn small danger" onClick={() => revoke(d)}>
                    {d.current ? 'Sign out' : 'Revoke'}
                  </button>
                </span>
              ) : (
                <button type="button" className="btn small ghost" onClick={() => setConfirming(d.id)}>
                  {d.current ? 'Sign out' : 'Revoke'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {approved && <p className="hint">Approved “{approved}”. It signs in within a few seconds.</p>}
      {approving ? (
        <form
          className="pair-code"
          onSubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <label>
            <span className="field-label">The code the new device shows</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <p className="hint warn">
            Type the code from the screen of the device you are holding. A Boton can ask to pair too: never approve a code that reached you in a chat or a message.
          </p>
          <span className="device-actions">
            <button type="button" className="btn small ghost" onClick={() => setApproving(false)}>
              Cancel
            </button>
            <button type="submit" className="btn small" disabled={!code.trim()}>
              Approve
            </button>
          </span>
        </form>
      ) : (
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setApproved(null);
            setApproving(true);
          }}
        >
          Approve a device
        </button>
      )}
      <p className="hint">To pair a new device, open Botons on it: it shows a code to approve here.</p>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
