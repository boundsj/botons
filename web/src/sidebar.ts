import type { Bot, SidebarLayout } from '../../shared/types.ts';

/** A section of the sidebar as shown: Pinned, a group, or Ungrouped, with its Botons in order. */
export interface Section {
  /** Stable across renders and devices: "pinned", "ungrouped" or the group's id. */
  key: string;
  kind: 'pinned' | 'group' | 'ungrouped';
  /** The group's id; null for Pinned and Ungrouped. */
  groupId: string | null;
  name: string;
  collapsed: boolean;
  bots: Bot[];
}

export interface Arranged {
  pinned: Section;
  groups: Section[];
  ungrouped: Section;
}

/**
 * The sidebar from the server's layout and the Botons this page holds. The two arrive as separate events, so for a
 * moment either can be ahead: an id with no Boton here is left out, and a Boton the layout doesn't list yet goes
 * last in its own group (or among the ungrouped), and last among the pinned if it is pinned. Before the layout has
 * loaded, groups come from the Botons themselves, by name.
 */
export function arrange(layout: SidebarLayout | null, bots: Bot[]): Arranged {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const pick = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  const l = layout ?? fallbackLayout(bots);

  const placed = new Set<string>();
  for (const g of l.groups) for (const id of g.botIds) placed.add(id);
  for (const id of l.ungrouped.botIds) placed.add(id);
  const groupIds = new Set(l.groups.map((g) => g.id));
  const extra = new Map<string | null, Bot[]>();
  for (const b of bots) {
    if (placed.has(b.id)) continue;
    const at = b.groupId && groupIds.has(b.groupId) ? b.groupId : null;
    extra.set(at, [...(extra.get(at) ?? []), b]);
  }
  const pinnedIds = new Set(l.pinned.botIds);

  return {
    pinned: {
      key: 'pinned',
      kind: 'pinned',
      groupId: null,
      name: 'Pinned',
      collapsed: l.pinned.collapsed,
      bots: [...pick(l.pinned.botIds), ...bots.filter((b) => b.pinned && !pinnedIds.has(b.id))],
    },
    groups: l.groups.map((g) => ({ key: g.id, kind: 'group', groupId: g.id, name: g.name, collapsed: g.collapsed, bots: [...pick(g.botIds), ...(extra.get(g.id) ?? [])] })),
    ungrouped: { key: 'ungrouped', kind: 'ungrouped', groupId: null, name: 'Ungrouped', collapsed: l.ungrouped.collapsed, bots: [...pick(l.ungrouped.botIds), ...(extra.get(null) ?? [])] },
  };
}

function fallbackLayout(bots: Bot[]): SidebarLayout {
  const groups = new Map<string, { id: string; name: string; botIds: string[] }>();
  for (const b of bots) {
    if (!b.groupId) continue;
    const g = groups.get(b.groupId) ?? { id: b.groupId, name: b.group, botIds: [] };
    g.botIds.push(b.id);
    groups.set(b.groupId, g);
  }
  return {
    pinned: { collapsed: false, botIds: bots.filter((b) => b.pinned).map((b) => b.id) },
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ ...g, collapsed: false })),
    ungrouped: { collapsed: false, botIds: bots.filter((b) => !b.groupId).map((b) => b.id) },
  };
}

/** What a collapsed section still shows, so nothing important hides in it. */
export interface Summary {
  unread: number;
  approvals: number;
  /** Botons working or with a turn up next. */
  busy: number;
}

export function summarize(bots: Bot[], waitingFor: ReadonlyMap<string, number>): Summary {
  let unread = 0;
  let approvals = 0;
  let busy = 0;
  for (const b of bots) {
    unread += b.unread;
    approvals += waitingFor.get(b.id) ?? 0;
    if (b.status.state !== 'idle') busy++;
  }
  return { unread, approvals, busy };
}

/** The words a screen reader hears for a summary: "3 unread, 1 waiting for approval, 2 working"; "" when quiet. */
export function summaryText(s: Summary): string {
  return [s.unread && `${s.unread} unread`, s.approvals && `${s.approvals} waiting for approval`, s.busy && `${s.busy} working`].filter(Boolean).join(', ');
}

/**
 * The Botons a search finds, in sidebar order, whether or not their section is collapsed: by name, role or group,
 * in any case. Each Boton once, even when pinned too.
 */
export function search(a: Arranged, query: string): Bot[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const out: Bot[] = [];
  for (const s of [a.pinned, ...a.groups, a.ungrouped]) {
    for (const b of s.bots) {
      if (seen.has(b.id)) continue;
      if (`${b.name} ${b.title} ${b.group}`.toLocaleLowerCase().includes(q)) {
        seen.add(b.id);
        out.push(b);
      }
    }
  }
  return out;
}

/** The index to send to move `id` one place up (-1) or down (+1) in `ids`; null at either end. */
export function stepIndex(ids: readonly string[], id: string, step: -1 | 1): number | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  const to = i + step;
  return to < 0 || to >= ids.length ? null : to;
}

/**
 * Where a drag puts something. A Boton goes into Pinned (pinning it, or reordering the pinned) or into a group or
 * Ungrouped (groupId null), at `index` among the others there; no index: last there, as when it is dropped on a
 * collapsed section's head. A group goes to `index` among the other groups.
 */
export type Drop =
  | { kind: 'pin'; botId: string; index?: number }
  | { kind: 'bot'; botId: string; groupId: string | null; index?: number }
  | { kind: 'group'; groupId: string; index: number };

/** `ids` with `id` taken out and put back at `index` (last when missing or past the end). */
function placed(ids: readonly string[], id: string, index: number | undefined): string[] {
  const rest = ids.filter((x) => x !== id);
  rest.splice(index === undefined ? rest.length : Math.min(Math.max(index, 0), rest.length), 0, id);
  return rest;
}

/**
 * The layout as the server will answer a drop, so the sidebar shows it at once; the server's answer replaces it. A
 * Boton dropped last into a section it is already in (a collapsed head) stays where it is.
 */
export function applyDrop(l: SidebarLayout, d: Drop): SidebarLayout {
  if (d.kind === 'group') {
    const g = l.groups.find((x) => x.id === d.groupId);
    if (!g) return l;
    const order = placed(l.groups.map((x) => x.id), d.groupId, d.index);
    return { ...l, groups: order.map((id) => l.groups.find((x) => x.id === id)!) };
  }
  if (d.kind === 'pin') {
    if (d.index === undefined && l.pinned.botIds.includes(d.botId)) return l;
    return { ...l, pinned: { ...l.pinned, botIds: placed(l.pinned.botIds, d.botId, d.index) } };
  }
  const into = d.groupId === null ? l.ungrouped : l.groups.find((g) => g.id === d.groupId);
  if (!into) return l;
  if (d.index === undefined && into.botIds.includes(d.botId)) return l;
  const without = (ids: string[]) => ids.filter((x) => x !== d.botId);
  const next = (s: { botIds: string[] }) => (s === into ? placed(s.botIds, d.botId, d.index) : without(s.botIds));
  return {
    ...l,
    groups: l.groups.map((g) => ({ ...g, botIds: next(g) })),
    ungrouped: { ...l.ungrouped, botIds: next(l.ungrouped) },
  };
}

/** Whether a drop changes nothing, so no request is sent. */
export function changesNothing(l: SidebarLayout, d: Drop): boolean {
  return JSON.stringify(applyDrop(l, d)) === JSON.stringify(l);
}

/**
 * The index a drop at `at` (the pointer's x or y) lands on, among items whose spans along the same axis are `spans`
 * (in order, the dragged item left out): before the first item whose middle is past the pointer.
 */
export function dropIndex(spans: readonly { start: number; end: number }[], at: number): number {
  const i = spans.findIndex((s) => at < (s.start + s.end) / 2);
  return i < 0 ? spans.length : i;
}
