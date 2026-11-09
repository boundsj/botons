import type { Engine } from './engine.ts';
import { log } from './log.ts';
import { nextRun } from './schedule.ts';
import type { Store } from './store.ts';

/** Fires due routines, once each however many slots were missed while the server was down. */
export function startScheduler(store: Store, engine: Engine, intervalMs: number, onTick: () => void = () => {}): () => void {
  const tick = () => {
    const now = new Date();
    for (const routine of store.dueRoutines(now)) {
      try {
        if (routine.schedule?.startsWith('once ')) store.retireOneOff(routine.id);
        else store.setNextRun(routine.id, routine.schedule ? nextRun(routine.schedule, routine.timezone, now) : null);
        engine.fireScheduled(routine);
      } catch (err) {
        log.error('scheduled routine failed to start', { botId: routine.botId, routineId: routine.id, trigger: 'schedule', err });
      }
    }
    onTick();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
