import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandMark } from './Brand.tsx';
import type { AuthStatus, PairingRequest } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { actions } from '../state.ts';

// First match wins: an iPhone's user agent also says "Mac OS X", Edge's also "Chrome".
const BROWSERS: [RegExp, string][] = [[/Edg\//, 'Edge'], [/Firefox\//, 'Firefox'], [/Chrome\/|CriOS\//, 'Chrome'], [/Safari\//, 'Safari']];
const SYSTEMS: [RegExp, string][] = [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Mac OS X/, 'Mac'], [/Windows/, 'Windows'], [/Linux/, 'Linux']];

function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Browser';
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return os ? `${browser} on ${os}` : browser;
}

/** How often a waiting device asks whether it was approved. */
const POLL_MS = 2000;

/**
 * This device asks to pair and shows its code; it signs in once the owner approves that code on the
 * server's machine or a paired device. Its secret stays in this page: the code alone pairs nothing.
 */
export function PairScreen({ status }: { status: AuthStatus }) {
  const [request, setRequest] = useState<PairingRequest | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = status.ownerPairing;
  const done = useRef(false);

  const ask = useCallback(async () => {
    setError(null);
    setExpired(false);
    try {
      setRequest(await api.pairRequest(browserLabel()));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    void ask();
  }, [ask]);

  const signIn = async (secret?: string) => {
    await api.pair({ secret, label: browserLabel() });
    done.current = true;
    await actions.init();
  };

  useEffect(() => {
    if (!request || expired) return;
    let stop = false;
    const tick = async () => {
      if (stop || done.current) return;
      try {
        await signIn(request.secret);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          if (Date.parse(request.expiresAt) <= Date.now()) setExpired(true);
        } else if (err instanceof ApiError && err.status === 400) {
          setExpired(true);
          return;
        } else {
          setError((err as Error).message);
        }
      }
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [request, expired]);

  const pairAsOwner = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="pair-screen">
      <div className="pair-card">
        <BrandMark size={56} />
        <h1>{status.claimed ? 'Pair this device' : 'Claim this server'}</h1>
        {status.claimed ? (
          <p className="welcome-copy">Botons only answers devices you have paired, so nobody else can drive your Botons, and they can't drive each other.</p>
        ) : (
          <p className="welcome-copy">This Botons server has no owner yet. The first device you approve becomes its owner's device. Prove you control the server by approving this device on <span data-server-hostname>{status.hostname}</span>.</p>
        )}
        {owner && (
          <div className="pair-owner">
            <button className="btn primary" onClick={() => void pairAsOwner()} disabled={busy} autoFocus>
              Pair as {owner.login}
            </button>
            <p className="hint">
              <strong>{owner.node}</strong> is signed in to your tailnet as {owner.login}. Or approve the code below.
            </p>
          </div>
        )}
        {request && !expired && (
          <div className="pair-code-shown" aria-live="polite">
            <span className="field-label">This device's code</span>
            <code className="big-code">{request.code}</code>
            <p className="hint">
              {status.claimed ? 'Approve it from a paired device (Settings → Devices → Approve a device), or on ' : 'Approve it on '}
              <span data-server-hostname>{status.hostname}</span> with <code>{request.approveCommand}</code>. This page signs in by itself once you do; the code lasts 15 minutes.
            </p>
          </div>
        )}
        {expired && (
          <div className="pair-code-shown">
            <p className="hint">That code expired before it was approved.</p>
            <button type="button" className="btn" onClick={() => void ask()}>
              Get a new code
            </button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <p className="hint">
          Only an approval from you pairs this device: seeing the code gets nobody in, so it is safe to leave this page open. Approve only a code you read off this screen.
        </p>
      </div>
    </main>
  );
}
