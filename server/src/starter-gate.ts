import { createHmac } from 'node:crypto';
import type { Routine, RoutineRun, StarterRoutineGate } from '../../shared/types.ts';
import type { Connectors } from './connectors.ts';
import type { Skills } from './skills.ts';
import { type BotRecord, HttpError, type StarterRecord, type Store } from './store.ts';
import { nowIso } from './util.ts';

/*
 * When a starter's routine may be turned on. Installing a starter saves a record (Store.starterRecord) listing its
 * routines as pending; while one is, Store.updateRoutine refuses to turn it on for anyone, so a PATCH, the `botons`
 * CLI, the Routines panel or a copy of the Boton can't. Only activate() turns it on: for the owner (its route is
 * theirs alone), when the latest test run finished without an error on exactly the settings it has now, or when the
 * owner overrides that. Either way it is then an ordinary routine.
 *
 * "Exactly the settings": a test run's turn notes what it ran on (noteTest) as keyed hashes of each part below, taken
 * from the very records the turn used. Turning on compares them with the same parts computed now, in one synchronous
 * step with the enabling write, so nothing can change between the comparison and the grant. A finished test run is no
 * proof its output was right, only that the brain's process ended without an error on these settings: the owner reads
 * its reply. A test run is a real turn told to act as a dry run; nothing here enforces that.
 */

/** What a test run ran on, part by part, for saying which changed since. */
export const PARTS = {
  boton: "the Boton's settings (brain, model, effort, access, instructions, name, timezone, or what it may do without asking)",
  routine: 'the routine (its instruction, schedule, webhook, skill, model, effort, session or time limit)',
  connectors: 'its connectors (which ones it has, or their setup, sign-in or on and off)',
  skills: 'its skills',
  browser: 'its browser or the sites it may read',
} as const;
export type Part = keyof typeof PARTS;
export type Parts = Record<Part, string>;

const KEEP_TESTS = 5;

export interface GateDeps {
  store: Store;
  connectors: Pick<Connectors, 'revision'>;
  skills: Pick<Skills, 'list'>;
  browser: { enabled(botId: string): boolean; sites(botId: string): string[] } | null;
}

export class StarterGate {
  #d: GateDeps;
  constructor(deps: GateDeps) {
    this.#d = deps;
  }

  /** A keyed hash: opaque to anyone without the server's key, so it may reach a client. */
  mac(v: unknown): string {
    return createHmac('sha256', this.#d.store.starterSecret()).update(JSON.stringify(v)).digest('hex').slice(0, 32);
  }

  /** What connector `id` is now (Connectors.revision), as a keyed hash; one that is gone has its own. */
  connectorRevision(id: string): string {
    return this.mac({ id, revision: this.#d.connectors.revision(id) });
  }

  /** What a turn of `routine` on `bot` runs on, from these very records (not read again). */
  parts(bot: BotRecord, routine: Routine): Parts {
    const { store, skills, browser } = this.#d;
    const boton = {
      id: bot.id,
      name: bot.name,
      title: bot.title,
      instructions: bot.instructions,
      provider: bot.provider,
      model: bot.model,
      effort: bot.effort,
      access: bot.access,
      timezone: bot.timezone,
      skills: bot.skills,
      alwaysAllow: bot.alwaysAllow,
      askFirst: bot.askFirst,
      owner: store.getSettings().ownerName,
    };
    const hook = routine.webhook;
    const r = {
      id: routine.id,
      name: routine.name,
      instruction: routine.instruction,
      schedule: routine.schedule,
      timezone: routine.timezone,
      webhook: hook ? { source: hook.source, filter: hook.filter, secret: hook.hasSecret, callback: hook.callbackUrl } : null,
      webhookWorkspace: routine.webhookWorkspace,
      notify: routine.notify,
      skill: routine.skill,
      model: routine.model,
      effort: routine.effort,
      session: routine.session,
      timeLimitMs: routine.timeLimitMs,
    };
    const wanted = new Set([...(bot.skills ?? skills.list().map((s) => s.name)), ...(routine.skill ? [routine.skill] : [])]);
    const skillParts = skills
      .list()
      .filter((s) => wanted.has(s.name))
      .map((s) => [s.name, s.updatedAt, s.version, s.disabled, s.pending, s.updatedBy]);
    return {
      boton: this.mac({ boton }),
      routine: this.mac({ r }),
      connectors: this.mac({ connectors: bot.connections.map((id) => [id, this.connectorRevision(id)]) }),
      skills: this.mac({ skills: skillParts, missing: [...wanted].filter((n) => !skillParts.some(([x]) => x === n)).sort() }),
      browser: this.mac({ browser: browser ? { on: browser.enabled(bot.id), sites: browser.sites(bot.id) } : null }),
    };
  }

  /** The parts routine `id` would run on now. */
  current(id: string): Parts {
    const routine = this.#d.store.getRoutine(id);
    return this.parts(this.#d.store.getBot(routine.botId), routine);
  }

  /**
   * The engine, as a test run's turn starts: what it runs on. `before` was taken before the turn waited on its
   * connectors and `after` when it stopped waiting; if they differ, something changed while it was set up, and the run
   * can't count for turning the routine on.
   */
  noteTest(run: Pick<RoutineRun, 'id' | 'routineId' | 'botId' | 'trigger'>, before: Parts, after: Parts): void {
    if (run.trigger !== 'test') return;
    const { store } = this.#d;
    const rec = store.starterRecord(run.botId);
    if (!rec?.pending.includes(run.routineId)) return;
    const same = (Object.keys(PARTS) as Part[]).every((k) => before[k] === after[k]);
    const tests = [{ runId: run.id, routineId: run.routineId, at: nowIso(), parts: same ? after : null }, ...rec.tests.filter((t) => t.runId !== run.id)];
    const kept = tests.filter((t, i) => tests.slice(0, i).filter((x) => x.routineId === t.routineId).length < KEEP_TESTS);
    store.saveStarterRecord(run.botId, { ...rec, tests: kept });
  }

  /** Whether routine `id` of a starter can be turned on without an override now, and why. */
  verdict(id: string, rec: StarterRecord | null = null): StarterRoutineGate {
    const { store } = this.#d;
    const routine = store.getRoutine(id);
    const record = rec ?? store.starterRecord(routine.botId);
    const pending = !!record?.pending.includes(id);
    const out = (tested: boolean, testing: boolean, runId: string | null, text: string): StarterRoutineGate => ({ routineId: id, pending, tested, testing, runId, text });
    if (!pending) return out(false, false, null, routine.enabled ? 'Turned on by you: an ordinary routine now.' : 'Turned on by you before: an ordinary routine now.');
    const test = store.listRuns(id).find((x) => x.trigger === 'test');
    if (!test) return out(false, false, null, 'Not tested yet: run a test, read its reply, then turn it on.');
    if (test.status === 'queued' || test.status === 'running') return out(false, true, test.id, `A test run is ${test.status}: wait for it to end.`);
    const when = (test.finishedAt ?? test.startedAt).replace('T', ' ').slice(0, 16);
    if (test.status !== 'succeeded') return out(false, false, test.id, `The latest test run ${test.status === 'failed' ? 'failed' : 'was skipped'} at ${when} UTC: fix what it says, then test again.`);
    const noted = record!.tests.find((t) => t.runId === test.id);
    if (!noted) return out(false, false, test.id, `The latest test run (${when} UTC) ran before this server noted what it ran on: test again.`);
    if (!noted.parts) return out(false, false, test.id, `Its settings changed while the latest test run (${when} UTC) was being set up: test again.`);
    const now = this.current(id);
    const changed = (Object.keys(PARTS) as Part[]).filter((k) => noted.parts![k] !== now[k]);
    if (changed.length) return out(false, false, test.id, `Changed since the latest test run (${when} UTC): ${changed.map((k) => PARTS[k]).join('; ')}. Test again.`);
    return out(true, false, test.id, `The latest test run (${when} UTC) finished without an error on its current settings. That doesn't show its output was right: read its reply.`);
  }

  /**
   * The owner turns a starter's routine on (the route is theirs alone). Refused while a test run is under way, and
   * without `override` unless verdict() says tested; all in one synchronous step with the write.
   */
  activate(id: string, override: boolean): { routine: Routine; gate: StarterRoutineGate } {
    const { store } = this.#d;
    return store.atomically(() => {
      const routine = store.getRoutine(id);
      const rec = store.starterRecord(routine.botId);
      if (!rec?.pending.includes(id)) throw new HttpError(400, `“${routine.name}” is not a starter's routine waiting to be turned on: turn it on as any other routine`);
      const gate = this.verdict(id, rec);
      if (gate.testing) throw new HttpError(409, gate.text);
      if (!gate.tested && !override) throw new HttpError(409, `${gate.text} Or turn it on without a passing test run (override).`);
      const on = store.updateRoutine(id, { enabled: true }, { starterActivation: true });
      store.saveStarterRecord(routine.botId, { ...rec, pending: rec.pending.filter((x) => x !== id), tests: rec.tests.filter((t) => t.routineId !== id) });
      return { routine: on, gate };
    });
  }
}
