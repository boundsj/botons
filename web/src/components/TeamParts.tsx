// Pieces every Teams screen uses: the header, the state chip, a Boton named by id, and the owner's way to steer.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Team } from '../../../shared/types.ts';
import { DEFAULT_LOOK } from '../../../shared/look.ts';
import { ApiError } from '../api.ts';
import { errorText } from '../feedback.ts';
import { useStore } from '../state.ts';
import { teamStateText, teamStateTone } from '../team-words.ts';
import { chatHash } from '../teams.ts';
import { cx } from '../util.ts';
import { BotonAvatar } from './Avatar.tsx';
import { BackIcon } from './Icons.tsx';

/** A Teams screen's header: back (a link up, or on a phone back to the list of Botons), its title, its actions. */
export function PageHeader(props: { back: string | (() => void); backLabel: string; mobileBackOnly?: boolean; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  const cls = cx('icon-btn round', props.mobileBackOnly && 'mobile-only');
  return (
    <header className="teams-header">
      {typeof props.back === 'string' ? (
        <a className={cls} href={props.back} aria-label={props.backLabel} title={props.backLabel}>
          <BackIcon />
        </a>
      ) : (
        <button type="button" className={cls} aria-label={props.backLabel} title={props.backLabel} onClick={props.back}>
          <BackIcon />
        </button>
      )}
      <div className="teams-heading">
        <h1 className="teams-title" tabIndex={-1}>
          {props.title}
        </h1>
        {props.sub && <div className="teams-sub">{props.sub}</div>}
      </div>
      {props.children && <div className="teams-actions">{props.children}</div>}
    </header>
  );
}

/** A team's state in words; the tint only repeats them. */
export function StateChip({ team }: { team: Pick<Team, 'state' | 'pausedReason' | 'reviewedAt'> }) {
  return <span className={cx('state-chip', `is-${teamStateTone(team)}`)}>{teamStateText(team)}</span>;
}

/** A Boton's look by id (a placeholder for one that is gone); its turns don't re-render the caller. */
export function useLook(botId: string | null | undefined) {
  return useStore((s) => (botId ? s.bots.find((b) => b.id === botId)?.look : undefined)) ?? DEFAULT_LOOK;
}

export function Avatar({ botId, size = 28 }: { botId: string | null | undefined; size?: number }) {
  const look = useLook(botId);
  return <BotonAvatar look={look} size={size} seed={botId ?? ''} />;
}

/** The owner's voice to a team is its lead's chat: the threads are the Botons' own and read-only here. */
export function SteerLine({ team }: { team: Pick<Team, 'lead'> | null }) {
  const lead = team?.lead;
  return (
    <div className="steer-line">
      <p>{lead ? 'To steer this team, message the lead.' : 'This team has no lead now: give it one in Edit team.'}</p>
      {lead && (
        <a className="btn small" href={chatHash(lead.botId)}>
          <Avatar botId={lead.botId} size={20} /> Message {lead.name}
        </a>
      )}
    </div>
  );
}

/** "Loading…", said to a screen reader too. */
export const Loading = ({ what }: { what?: string }) => (
  <p className="muted teams-loading" role="status">
    Loading{what ? ` ${what}` : ''}…
  </p>
);

/** A polite live region: what changed out of sight (a team paused, a refusal undone) is said once. */
export function useAnnouncer(): [ReactNode, (text: string) => void] {
  const ref = useRef<HTMLParagraphElement>(null);
  const node = <p className="sr-only" aria-live="polite" ref={ref} />;
  return [
    node,
    (text: string) => {
      const el = ref.current;
      if (!el) return;
      // Cleared first, so the same words said again are said again.
      el.textContent = '';
      requestAnimationFrame(() => (el.textContent = text));
    },
  ];
}

/** Time moves on in status lines ("updated 12m ago"): the screen re-renders once a minute. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Loads what a screen shows, again when `key` changes and on Retry. `gone`: the server no longer has it (404), which
 * a screen says in its own words rather than as an error.
 */
export function useTeamsLoad(load: () => Promise<unknown>, key: string): { loading: boolean; error: string | null; gone: boolean; retry: () => void } {
  const [s, setS] = useState<{ key: string; loading: boolean; error: string | null; gone: boolean }>({ key, loading: true, error: null, gone: false });
  const [attempt, setAttempt] = useState(0);
  const run = useRef(load);
  run.current = load;
  useEffect(() => {
    let current = true;
    setS({ key, loading: true, error: null, gone: false });
    run.current().then(
      () => current && setS({ key, loading: false, error: null, gone: false }),
      (e: unknown) => current && setS({ key, loading: false, error: errorText(e), gone: e instanceof ApiError && e.status === 404 }),
    );
    return () => {
      current = false;
    };
  }, [key, attempt]);
  const now = s.key === key ? s : { loading: true, error: null, gone: false };
  return { loading: now.loading, error: now.error, gone: now.gone, retry: () => setAttempt((a) => a + 1) };
}
