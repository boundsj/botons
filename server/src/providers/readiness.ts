import type { BrainCheckProblem, BrainReadiness, BrainState } from '../../../shared/types.ts';
import type { ProviderStatus } from './types.ts';

/** A check older than this says nothing about now (the checker runs a new one after 5 minutes, when asked). */
export const CHECK_OUTDATED_MS = 30 * 60_000;

/** What a check's fixed word means for the brain's state. */
const FROM_CHECK: Record<NonNullable<NonNullable<ProviderStatus['check']>['problem']>, BrainState> = {
  'not-found': 'not-installed',
  'not-runnable': 'unavailable',
  'incompatible-version': 'unavailable',
  'version-failed': 'unavailable',
  'timed-out': 'unknown',
  'login-unreadable': 'unknown',
  'signed-out': 'signed-out',
};

/**
 * How ready `p` is, from what its last check found and the usage limit its turns hit, if any. Ready only when a check
 * ran within CHECK_OUTDATED_MS and confirmed it installed and signed in; never a promise that a turn will work.
 */
export function brainReadiness(p: ProviderStatus, usageLimitUntil: string | null, now = Date.now(), boot = ''): BrainReadiness {
  const generation = p.check?.generation ?? 0;
  const at = p.checkedAt ? Date.parse(p.checkedAt) : Number.NaN;
  const out = (state: BrainState, problem: BrainCheckProblem | null): BrainReadiness => ({ state, problem, checkedAt: p.checkedAt, usageLimitUntil, boot, generation });
  let state: BrainState;
  let problem: BrainCheckProblem | null;
  if (Number.isNaN(at)) [state, problem] = ['unknown', 'not-checked'];
  // Stamped later than now: the clock was set back since, so how old the check is can't be told (the checker runs a
  // new one when next asked).
  else if (at > now) [state, problem] = ['unknown', 'clock-changed'];
  else if (now - at > CHECK_OUTDATED_MS) [state, problem] = ['unknown', 'outdated'];
  else if (p.check?.problem) [state, problem] = [FROM_CHECK[p.check.problem], p.check.problem];
  // A provider whose check doesn't name its problem.
  else if (!p.installed) [state, problem] = ['not-installed', 'not-found'];
  else if (p.loggedIn === false) [state, problem] = ['signed-out', 'signed-out'];
  else if (!p.available) [state, problem] = ['unavailable', 'unavailable'];
  else if (p.loggedIn !== true) [state, problem] = ['unknown', 'login-unreadable'];
  else [state, problem] = ['ready', null];
  // A turn that hit the limit got past the sign-in, whatever the check could tell.
  if (usageLimitUntil && (state === 'ready' || state === 'unknown')) return out('usage-limited', 'usage-limit');
  return out(state, problem);
}
