export function upsert<T extends { id: string }>(list: T[], item: T, where: 'start' | 'end' = 'end'): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) {
    const copy = list.slice();
    copy[i] = item;
    return copy;
  }
  return where === 'start' ? [item, ...list] : [...list, item];
}

/**
 * Merge the newest page of a chat into the list on screen, keeping older pages and newer stream
 * arrivals. Null when they share no message (more than a page was missed): replace the list then.
 */
export function mergeLatest<T extends { id: string }>(current: T[], latest: T[]): { items: T[]; keptOlder: boolean } | null {
  const fresh = new Set(latest.map((m) => m.id));
  const i = current.findIndex((m) => fresh.has(m.id));
  if (i < 0) return null;
  const newer = current.slice(i).filter((m) => !fresh.has(m.id));
  return { items: [...current.slice(0, i), ...latest, ...newer], keptOlder: i > 0 };
}

/**
 * `next`, with every item equal to one in `current` kept as that same object, and `current` itself when
 * nothing differs: a refetch that only repeats what is on screen gives memoized rows nothing to re-render.
 */
export function keepUnchanged<T extends { id: string }>(current: T[], next: T[]): T[] {
  const had = new Map(current.map((m) => [m.id, m]));
  let same = current.length === next.length;
  const items = next.map((m, i) => {
    const old = had.get(m.id);
    const kept = old !== undefined && (old === m || JSON.stringify(old) === JSON.stringify(m)) ? old : m;
    if (kept !== current[i]) same = false;
    return kept;
  });
  return same ? current : items;
}

/** Null when the list no longer starts at `before` (it was replaced while the page loaded). */
export function prependOlder<T extends { id: string }>(current: T[], before: string, older: T[]): T[] | null {
  if (current[0]?.id !== before) return null;
  const have = new Set(current.map((m) => m.id));
  return [...older.filter((m) => !have.has(m.id)), ...current];
}

/** Null when the list no longer ends at `after` (it was replaced while the page loaded). */
export function appendNewer<T extends { id: string }>(current: T[], after: string, newer: T[]): T[] | null {
  if (current.at(-1)?.id !== after) return null;
  const have = new Set(current.map((m) => m.id));
  return [...current, ...newer.filter((m) => !have.has(m.id))];
}

/**
 * What `current` holds that `latest` lacks and arrived live after the server read the page, which replacing
 * the list with the page would lose: what is newer than the page's last message or, for an empty page, what
 * wasn't in the list (`known`) when the page was asked for. What was there and the page lacks stays gone.
 */
export function arrivedAfter<T extends { id: string; createdAt: string }>(current: T[], latest: T[], known: ReadonlySet<string>): T[] {
  const last = latest.at(-1)?.createdAt;
  const fresh = new Set(latest.map((m) => m.id));
  return current.filter((m) => !fresh.has(m.id) && (last === undefined ? !known.has(m.id) : m.createdAt > last));
}

/** Where the "New" divider goes: the oldest of the last `unread` bot and error messages (what the server counts). */
export function firstUnreadId(messages: { id: string; role: string }[], unread: number): string | null {
  if (unread <= 0) return null;
  let oldest: string | null = null;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < unread; i--) {
    if (messages[i].role !== 'bot' && messages[i].role !== 'error') continue;
    oldest = messages[i].id;
    seen++;
  }
  return oldest;
}
