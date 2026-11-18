import { log } from './log.ts';
import type { Teams } from './teams.ts';

/*
 * The team supervisor: every intervalMs it asks Teams to look at every active team (Teams.supervise). It never calls a
 * model and holds nothing of its own: every clock, count and budget it goes by is in the database, so a restart picks
 * up where it was. Tests drive it with tick() and Teams' injected clock instead of waiting.
 */
export interface TeamSupervisor {
  /** One look now (what each interval does). */
  tick(): ReturnType<Teams['supervise']>;
  stop(): void;
}

export function startTeamSupervisor(opts: { teams: Teams; intervalMs: number; onTick?: () => void }): TeamSupervisor {
  let running = false;
  const tick = () => {
    // A slow tick never overlaps the next.
    if (running) return { checkins: 0, escalations: 0 };
    running = true;
    try {
      return opts.teams.supervise();
    } catch (err) {
      log.error('the team supervisor failed', { err });
      return { checkins: 0, escalations: 0 };
    } finally {
      running = false;
      opts.onTick?.();
    }
  };
  const timer = setInterval(tick, opts.intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
