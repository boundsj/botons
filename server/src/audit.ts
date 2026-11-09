import type { DatabaseSync } from 'node:sqlite';
import type { AuditAction, AuditActorKind, AuditEvent } from '../../shared/types.ts';
import type { Principal } from './auth.ts';
import { log } from './log.ts';
import { nowIso, parseJson, type Row } from './util.ts';

/*
 * The audit log: who did what to which thing, for the actions that change who
 * can reach the server or what a Boton may do. Callers pass ids, names and
 * small facts only, never a token, code, secret, URL query or message text;
 * `clean` drops anything else that looks like one.
 */

/** Newest rows kept; older ones are deleted as new ones arrive. */
export const AUDIT_KEEP = 10_000;

export interface AuditActor {
  kind: AuditActorKind;
  id: string | null;
  label: string;
}

type Detail = string | number | boolean | null | string[];

export interface AuditEntry {
  action: AuditAction;
  target?: { kind: string; id: string; label?: string } | null;
  details?: Record<string, Detail | undefined>;
}

/** Someone at the server's machine (`npm run pair`): proven by access to the data folder. */
export const HOST_ACTOR: AuditActor = { kind: 'host', id: null, label: 'Server machine' };
export const SYSTEM_ACTOR: AuditActor = { kind: 'system', id: null, label: 'Botons' };

const SECRETISH = /(token|secret|password|code|key|authorization|cookie)/i;

function clean(details: Record<string, Detail | undefined> = {}): Record<string, Detail> {
  const out: Record<string, Detail> = {};
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || SECRETISH.test(k)) continue;
    if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => String(x).slice(0, 200));
    else out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

/**
 * Also used by `npm run pair`, which works on the database directly. Never throws: an audit row must not undo the
 * action. With `required`, it throws instead: inside the caller's transaction, so the action and its record are kept
 * together or not at all.
 */
export function recordAudit(db: DatabaseSync, actor: AuditActor, entry: AuditEntry, opts: { required?: boolean } = {}): void {
  try {
    db.prepare(
      'insert into audit_events (at, actor_kind, actor_id, actor_label, action, target_kind, target_id, target_label, details) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      nowIso(),
      actor.kind,
      actor.id,
      actor.label.slice(0, 120),
      entry.action,
      entry.target?.kind ?? null,
      entry.target?.id ?? null,
      (entry.target?.label ?? '').slice(0, 120),
      JSON.stringify(clean(entry.details)),
    );
    db.prepare('delete from audit_events where seq <= (select max(seq) from audit_events) - ?').run(AUDIT_KEEP);
  } catch (err) {
    log.error('could not write an audit event', { action: entry.action, required: opts.required || undefined, err });
    if (opts.required) throw err;
  }
}

function toEvent(r: Row): AuditEvent {
  return {
    seq: Number(r.seq),
    at: r.at,
    actor: { kind: r.actor_kind, id: r.actor_id ?? null, label: r.actor_label },
    action: r.action,
    target: r.target_kind ? { kind: r.target_kind, id: r.target_id ?? '', label: r.target_label } : null,
    details: parseJson(r.details, {}),
  };
}

export class Audit {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** The device's label or the Boton's name as they are now, so the row still reads after either is gone. */
  actorOf(principal: Principal | null): AuditActor {
    if (principal?.kind === 'boton') {
      const name = this.#db.prepare('select name from bots where id = ?').get(principal.botId)?.name;
      return { kind: 'boton', id: principal.botId, label: String(name ?? principal.botId) };
    }
    if (principal?.kind === 'device' && principal.deviceId) {
      const label = this.#db.prepare('select label from auth_tokens where id = ?').get(principal.deviceId)?.label;
      return { kind: 'device', id: principal.deviceId, label: String(label ?? principal.deviceId) };
    }
    // Only with BOTONS_AUTH=off and no token.
    return { kind: 'device', id: null, label: 'Unpaired (auth off)' };
  }

  record(by: Principal | null | AuditActor, entry: AuditEntry): void {
    const actor = by && 'label' in by ? by : this.actorOf(by);
    recordAudit(this.#db, actor, entry);
  }

  /** For an action that must not happen unrecorded: throws if the row can't be written, so the caller's transaction rolls back. */
  require(by: Principal | null | AuditActor, entry: AuditEntry): void {
    const actor = by && 'label' in by ? by : this.actorOf(by);
    recordAudit(this.#db, actor, entry, { required: true });
  }

  /**
   * Newest first: the connector's (or skill's) own events and projections of grant events naming it, read only from
   * that kind's own fields.
   * The global audit keeps the complete event; this view never includes unrelated grants or rules.
   */
  about(targets: { kind: string; id: string }[], mention: string, limit = 50, of: 'connector' | 'skill' = 'connector'): AuditEvent[] {
    const keys = of === 'skill' ? ['skills', 'skillsAdded', 'skillsRemoved'] : ['connections', 'connectionsAdded', 'connectionsRemoved'];
    const quoted = JSON.stringify(mention).replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const where = [...targets.map(() => '(target_kind = ? and target_id = ?)'), "details like ? escape '\\'"].join(' or ');
    const rows = this.#db
      .prepare(`select * from audit_events where ${where} order by seq desc limit 1000`)
      .all(...targets.flatMap((t) => [t.kind, t.id]), `%${quoted}%`)
      .map(toEvent);
    return rows.flatMap((e): AuditEvent[] => {
      if (e.target && targets.some((t) => t.kind === e.target!.kind && t.id === e.target!.id)) return [e];
      const details: AuditEvent['details'] = {};
      for (const key of keys) {
        const value = e.details[key];
        if (Array.isArray(value) && value.includes(mention)) details[key] = [mention];
      }
      if (of === 'connector' && e.details.connector === mention) {
        details.connector = mention;
        for (const key of ['connectorName', 'boton', 'kind', 'status', 'always', 'grant', 'decision']) {
          if (Object.hasOwn(e.details, key)) details[key] = e.details[key];
        }
      }
      if (!Object.keys(details).length) return [];
      if (e.details.via === of) details.via = of;
      if (of === 'skill' && e.details.everySkill === true) details.everySkill = true;
      return [{ ...e, details }];
    }).slice(0, limit);
  }

  /** Newest first. */
  list(opts: { before?: number; limit?: number } = {}): AuditEvent[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), 500);
    const rows = opts.before
      ? this.#db.prepare('select * from audit_events where seq < ? order by seq desc limit ?').all(opts.before, limit)
      : this.#db.prepare('select * from audit_events order by seq desc limit ?').all(limit);
    return rows.map(toEvent);
  }
}
