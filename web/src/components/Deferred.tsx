import { type ReactNode, useEffect, useState } from 'react';
import { CloseIcon } from './Icons.tsx';
import { Dialog } from './Dialog.tsx';

/**
 * A part of the page whose code is in a chunk of its own, fetched the first time it shows: the page
 * starts with the chat and keeps the rest (settings, the panel, setup) out of memory until it is opened.
 * A failed fetch is not kept, so trying again fetches again.
 */
export interface Deferred<M> {
  load(): Promise<M>;
  loaded(): M | undefined;
}

export function deferred<M>(load: () => Promise<M>): Deferred<M> {
  let mod: M | undefined;
  let pending: Promise<M> | null = null;
  return {
    loaded: () => mod,
    load: () =>
      (pending ??= load().then(
        (m) => (mod = m),
        (e: unknown) => {
          pending = null;
          throw e;
        },
      )),
  };
}

export function useDeferred<M>(part: Deferred<M>): { mod: M | undefined; failed: boolean; retry: () => void } {
  const [owner, setOwner] = useState(part);
  const [mod, setMod] = useState<M | undefined>(() => part.loaded());
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A new part must never render with the module or error belonging to its predecessor.
  if (owner !== part) {
    setOwner(part);
    setMod(() => part.loaded());
    setFailed(false);
    setAttempt(0);
  }
  useEffect(() => {
    if (owner !== part || mod) return;
    let current = true;
    setFailed(false);
    part.load().then(
      (m) => current && setMod(() => m),
      (e: unknown) => {
        console.error('[Botons] could not load part of the page', e);
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [part, owner, mod, attempt]);
  return { mod: owner === part ? mod : part.loaded(), failed: owner === part && failed, retry: () => setAttempt((a) => a + 1) };
}

/** Its code fetches again on Retry; a reload helps when the server was updated and the old chunk is gone. */
function DeferredError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="load-error" role="alert">
      <span>Couldn't load {what}. Check the connection to the server, or reload the page if Botons was updated.</span>
      <span className="deferred-actions">
        <button type="button" className="link-btn" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="link-btn" onClick={() => location.reload()}>
          Reload
        </button>
      </span>
    </div>
  );
}

function Loading() {
  return (
    <p className="muted deferred-loading" role="status">
      Loading…
    </p>
  );
}

/** A dialog in a chunk of its own: the same dialog frame says it is loading, or that it couldn't. */
export function DeferredDialog<M>(props: { part: Deferred<M>; title: string; onClose: () => void; children: (m: M) => ReactNode }) {
  const { mod, failed, retry } = useDeferred(props.part);
  if (mod) return props.children(mod);
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      {failed ? <DeferredError what={props.title} onRetry={retry} /> : <Loading />}
    </Dialog>
  );
}

/** The side panel while its code loads. */
export function DeferredPanel<M>(props: { part: Deferred<M>; label: string; onClose: () => void; children: (m: M) => ReactNode }) {
  const { mod, failed, retry } = useDeferred(props.part);
  if (mod) return props.children(mod);
  return (
    <aside className="panel" aria-label={props.label}>
      <header className="panel-header">
        <div className="tabs" />
        <button className="icon-btn round" aria-label="Close panel" onClick={props.onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="panel-scroll">
        <div className="tab-body">{failed ? <DeferredError what="the panel" onRetry={retry} /> : <Loading />}</div>
      </div>
    </aside>
  );
}

/** A whole screen (setup, pairing) while its code loads. */
export function DeferredScreen<M>(props: { part: Deferred<M>; what: string; children: (m: M) => ReactNode }) {
  const { mod, failed, retry } = useDeferred(props.part);
  if (mod) return props.children(mod);
  if (!failed) return <div className="boot muted">Loading…</div>;
  return (
    <div className="boot">
      <DeferredError what={props.what} onRetry={retry} />
    </div>
  );
}
