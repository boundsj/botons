// A Boton's settings apply as the owner changes them, each with an Undo, instead of a form with Save and Revert. The
// state here is kept apart from the components so a test can run it.
import type { Bot, UpdateBotInput } from '../../shared/types.ts';

/** What the settings page changes on a Boton: every field of an update except `group` (picked by id here). */
export type LivePatch = Omit<UpdateBotInput, 'group'>;
type Key = keyof LivePatch;

/** Changes sent and not yet answered, by field: the value shown meanwhile, and which change set it. */
export type Pending = Partial<Record<Key, { value: unknown; seq: number }>>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The Boton as the page shows it: as saved, with the changes still on their way laid over it. */
export function overlay(bot: Bot, pending: Pending): Bot {
  const out: Record<string, unknown> = { ...bot };
  for (const [k, p] of Object.entries(pending)) if (p) out[k] = p.value;
  return out as unknown as Bot;
}

/** Only the fields of `patch` that differ from the Boton as shown; empty when it changes nothing. */
export function changed(shown: Bot, patch: LivePatch): LivePatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && !same((shown as unknown as Record<string, unknown>)[k], v)) out[k] = v;
  return out as LivePatch;
}

/**
 * What Undo sends: the values `patch` replaces, as the page showed them when it was made. A brain change also puts
 * the effort back, since the server resets a level the new brain or model doesn't have.
 */
export function undoPatch(shown: Bot, patch: LivePatch): LivePatch {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(patch);
  if ((keys.includes('provider') || keys.includes('model')) && !keys.includes('effort')) keys.push('effort');
  for (const k of keys) out[k] = (shown as unknown as Record<string, unknown>)[k];
  return out as LivePatch;
}

/** A change sent as change number `seq`. */
export function addPending(pending: Pending, patch: LivePatch, seq: number): Pending {
  const out: Pending = { ...pending };
  for (const [k, v] of Object.entries(patch)) out[k as Key] = { value: v, seq };
  return out;
}

/** Change `seq` answered (saved or refused): its fields show the Boton as saved again, unless a later change set them. */
export function settle(pending: Pending, patch: LivePatch, seq: number): Pending {
  const out: Pending = { ...pending };
  for (const k of Object.keys(patch) as Key[]) if (out[k]?.seq === seq) delete out[k];
  return out;
}

/**
 * Runs changes one at a time, in the order made: a second toggle a moment after the first is sent after the first is
 * saved, so neither overwrites the other with a list from before it.
 */
export function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** `list` with `id` in it or out of it, keeping the order of the rest. */
export const toggled = (list: readonly string[], id: string, on: boolean): string[] => (on ? (list.includes(id) ? [...list] : [...list, id]) : list.filter((x) => x !== id));

/** The toast after a change: what happened, in a few words. `names` gives connectors' names by id. */
export function changeText(before: Bot, patch: LivePatch, names: (id: string) => string = (id) => id): string {
  const keys = Object.keys(patch) as Key[];
  if (keys.length !== 1) {
    if (keys.includes('provider') || keys.includes('model')) return 'Brain changed';
    return 'Saved';
  }
  const k = keys[0];
  switch (k) {
    case 'name':
      return 'Name saved';
    case 'title':
      return 'Role saved';
    case 'instructions':
      return 'Instructions saved';
    case 'look':
      return 'Look saved';
    case 'provider':
    case 'model':
      return 'Brain changed';
    case 'effort':
      return 'Effort changed';
    case 'access':
      return patch.access === 'host' ? `${before.name} has full computer access` : `${before.name} works in its own folder`;
    case 'timezone':
      return 'Timezone saved';
    case 'pinned':
      return patch.pinned ? 'Pinned to the top' : 'Unpinned';
    case 'groupId':
      return 'Group changed';
    case 'skills':
      return 'Skills updated';
    case 'askFirst':
    case 'alwaysAllow':
      return 'Approval rules saved';
    case 'connections': {
      const next = patch.connections ?? [];
      const added = next.filter((id) => !before.connections.includes(id));
      const removed = before.connections.filter((id) => !next.includes(id));
      if (added.length === 1 && !removed.length) return `${names(added[0])} on`;
      if (removed.length === 1 && !added.length) return `${names(removed[0])} off`;
      return 'Connectors updated';
    }
    default:
      return 'Saved';
  }
}

/** The sites line under Web browsing: "All public sites", "3 sites", or none yet. */
export function sitesSummary(sites: readonly string[]): string {
  if (sites.includes('*')) {
    const others = sites.length - 1;
    return others ? `All public sites + ${others} more` : 'All public sites';
  }
  if (!sites.length) return 'No sites yet';
  return sites.length === 1 ? sites[0] : `${sites.length} sites`;
}

/** A site as typed or pasted (a whole address, say), as the host the server takes: no scheme, path or trailing dot. */
export function cleanSite(text: string): string {
  let t = text.trim().toLowerCase();
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  t = t.replace(/[/?#].*$/, '');
  return t.replace(/\.$/, '');
}
