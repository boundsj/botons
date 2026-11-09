import { useEffect, useState } from 'react';

export function useLoad(load: (isCurrent: () => boolean) => Promise<unknown>, key: string, retainError = false): { error: string | null; retry: () => void } {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    if (!retainError) setError(null);
    load(() => current).then(() => {
      if (current) setError(null);
    }).catch((e: unknown) => {
      if (current) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      current = false;
    };
    // `load` is a fresh closure every render; `key` says what it loads.
  }, [key, attempt, retainError]);
  return { error, retry: () => setAttempt((a) => a + 1) };
}

export function LoadError({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <p className="load-error" role="alert">
      <span>
        Couldn't load {what}: {error}
      </span>
      <button type="button" className="link-btn" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}
