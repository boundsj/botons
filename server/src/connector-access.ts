import type { ConnectorAccess, ConnectorAccessInput, ConnectorEnabledInput } from '../../shared/types.ts';
import type { Audit } from './audit.ts';
import type { Principal } from './auth.ts';
import { type Connectors, countedConnections, MAX_CONNECTIONS } from './connectors.ts';
import { log } from './log.ts';
import { HttpError, type Store } from './store.ts';

/*
 * One connector's side of the grants: which Botons have it, which may ask for it and which can't use it, set from
 * the connector rather than one Boton at a time. A Boton's connectors are still its own list (bots.connections);
 * this reads and writes that list, so a turn gets exactly what a Boton's settings would show.
 */

export interface AccessDeps {
  connectors: Connectors;
  store: Pick<Store, 'listBots' | 'atomically' | 'setConnections'>;
  audit: Audit;
  /** The turns running now that were given this connector (Engine.turnsWith). */
  running?: (id: string) => { botId: string; turnId: string }[];
}

function connectorOf(deps: AccessDeps, id: string) {
  const c = deps.connectors.catalog().connectors.find((x) => x.id === id);
  if (!c) throw new HttpError(404, `No connector ${id}`);
  return c;
}

/** What was done to this connector and to who has it: its own events, and every grant naming it. */
function historyOf(deps: AccessDeps, id: string) {
  const name = id.slice(id.indexOf(':') + 1);
  const targets = [{ kind: 'connector', id }];
  if (id.startsWith('lib:')) targets.push({ kind: 'mcp_server', id: name });
  const rec = id.startsWith('oauth:') ? deps.connectors.oauth?.byName(name) : null;
  if (rec) targets.push({ kind: 'oauth', id: rec.id });
  return deps.audit.about(targets, id);
}

export function connectorAccess(deps: AccessDeps, id: string): ConnectorAccess {
  const c = connectorOf(deps, id);
  const botons = deps.store
    .listBots()
    .map((b) => {
      const has = b.connections.includes(id);
      const brainCanUse = c.providers.includes(b.provider);
      return {
        botId: b.id,
        name: b.name,
        provider: b.provider,
        has,
        mayAsk: !has && brainCanUse && !c.managed && c.onRequest && c.enabled,
        brainCanUse,
        withoutReason: has ? deps.connectors.withoutReason(b.id, id) : null,
      };
    })
    .sort((a, b) => Number(b.has) - Number(a.has) || a.name.localeCompare(b.name));
  const names = new Map(botons.map((m) => [m.botId, m.name]));
  return {
    connectorId: id,
    name: c.name,
    managed: !!c.managed,
    onRequest: c.onRequest,
    grant: c.grant,
    enabled: c.enabled,
    off: c.off,
    botons,
    running: (deps.running?.(id) ?? []).flatMap((t) => (names.has(t.botId) ? [{ ...t, name: names.get(t.botId)! }] : [])),
    history: historyOf(deps, id),
  };
}

const ids = (v: unknown, field: string, what = 'Boton ids'): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, `${field} must be a list of ${what}`);
  return [...new Set(v as string[])];
};

/**
 * Gives the connector to exactly `botIds` and takes it off every other Boton, all at once or not at all. Refused if
 * who had it is not what the owner was shown, for the managed browser (given in each Boton's settings, where its
 * sites are), and for a Boton whose brain can't use it. Each Boton changed is audited as its own grant change.
 */
export function setConnectorAccess(deps: AccessDeps, id: string, input: ConnectorAccessInput, by: Principal | null): ConnectorAccess {
  const c = connectorOf(deps, id);
  if (c.managed) throw new HttpError(400, `${c.name} is given in each Boton's settings, under Browser, where its sites are`);
  const wanted = ids(input?.botIds, 'botIds');
  const expected = ids(input?.expected, 'expected');
  const changed = deps.store.atomically(() => {
    const bots = deps.store.listBots();
    const byId = new Map(bots.map((b) => [b.id, b]));
    const unknown = wanted.find((b) => !byId.has(b));
    if (unknown) throw new HttpError(400, `No Boton with id ${unknown}`);
    const current = bots.filter((b) => b.connections.includes(id)).map((b) => b.id);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    if (!same(current, expected)) throw new HttpError(409, `Which Botons have ${c.name} changed since you looked: review it again`);
    const out: { botId: string; name: string; added: boolean }[] = [];
    for (const b of bots) {
      const add = wanted.includes(b.id) && !b.connections.includes(id);
      const remove = !wanted.includes(b.id) && b.connections.includes(id);
      if (add) {
        if (!c.providers.includes(b.provider)) throw new HttpError(400, `${b.name}'s brain can't use connectors`);
        if (countedConnections(b.connections) >= MAX_CONNECTIONS) throw new HttpError(400, `${b.name} already has ${MAX_CONNECTIONS} connectors, the most a Boton can have`);
        deps.store.setConnections(b.id, [...b.connections, id]);
      } else if (remove) deps.store.setConnections(b.id, b.connections.filter((x) => x !== id));
      if (add || remove) out.push({ botId: b.id, name: b.name, added: add });
    }
    return out;
  });
  for (const m of changed) {
    deps.audit.record(by, {
      action: 'boton.permissions_changed',
      target: { kind: 'boton', id: m.botId, label: m.name },
      details: { [m.added ? 'connectionsAdded' : 'connectionsRemoved']: [id], via: 'connector' },
    });
  }
  if (changed.length) {
    log.info("connector's Botons changed", { connector: id, added: changed.filter((m) => m.added).map((m) => m.botId), removed: changed.filter((m) => !m.added).map((m) => m.botId) });
  }
  return connectorAccess(deps, id);
}

/**
 * Turns the connector off or on for every Boton at once, keeping its setup, sign-in and grants. Refused if what the
 * owner was shown (on or off, and who had it) is not how it is now, and for the managed browser. Turning it off doesn't
 * reach into a turn already running with it, each of which keeps it until it ends, so it is refused as well while a
 * turn runs with it that the owner wasn't shown (by turn, not by Boton: a Boton's next turn is a new one). One shown
 * that has ended since is fine: what they were told still covers everything that keeps it. The state is compared, not
 * a count of switches: should it have been turned off and on again meanwhile, what they were shown is still exactly
 * true (who has it, what runs with it), and a card from before that is refused by the request-policy generation anyway.
 * Audited once, with the Botons that had it.
 */
export function setConnectorEnabled(deps: AccessDeps, id: string, input: ConnectorEnabledInput, by: Principal | null): ConnectorAccess {
  const c = connectorOf(deps, id);
  if (c.managed) throw new HttpError(400, `${c.name} is turned on and off in each Boton's settings, under Browser`);
  if (typeof input?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 200)) throw new HttpError(400, 'reason must be at most 200 characters');
  if (!input.expected || typeof input.expected !== 'object' || typeof input.expected.enabled !== 'boolean') throw new HttpError(400, 'expected must say whether it was on, and which Botons had it');
  const expected = ids(input.expected.botIds, 'expected.botIds');
  const shown = new Set(ids(input.expected.running, 'expected.running', 'turn ids'));
  const result = deps.store.atomically(() => {
    const now = connectorOf(deps, id);
    const had = deps.store
      .listBots()
      .filter((b) => b.connections.includes(id))
      .map((b) => ({ id: b.id, name: b.name }));
    const same = had.length === expected.length && had.every((b) => expected.includes(b.id));
    // In the same transaction (and tick) as the switch: no turn starts with it in between, and none after it is off.
    const unseen = (deps.running?.(id) ?? []).filter((t) => !shown.has(t.turnId));
    if (now.enabled !== input.expected.enabled || !same || unseen.length) throw new HttpError(409, `${c.name} changed since you looked: review it again`);
    return { changed: deps.connectors.setEnabled(id, input.enabled, input.reason ?? ''), had };
  });
  if (result.changed) {
    deps.audit.record(by, {
      action: input.enabled ? 'connector.enabled' : 'connector.disabled',
      target: { kind: 'connector', id, label: c.name },
      details: { botons: result.had.map((b) => b.name), botonIds: result.had.map((b) => b.id), reason: input.enabled ? undefined : input.reason?.trim() || undefined },
    });
  }
  return connectorAccess(deps, id);
}
