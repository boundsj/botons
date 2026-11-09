import { createHash } from 'node:crypto';
import { RENAMED } from '../../shared/legacy-names.mjs';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, BotTemplate, NewBotInput, Routine, SaveTemplateInput, TemplateBot, TemplateRoutine } from '../../shared/types.ts';
import { effortProblem } from '../../shared/effort.ts';
import { isPastOneOff, isValidTimezone, MIN_TIME_LIMIT_MS } from '../../shared/util.ts';
import { log } from './log.ts';
import { describeSchedule, parseSchedule, toSpec } from './schedule.ts';
import { SKILL_NAME, type Skills } from './skills.ts';
import { STARTERS, type StoredStarter } from './starters.ts';
import { type BotRecord, clean, flag, HttpError, MAX_ROUTINES_PER_BOT, NOTIFY_POLICIES, type Store, storedLook } from './store.ts';
import { newId, nowIso, orNull } from './util.ts';
import { isWebhookSource, parseFilter } from './webhooks.ts';

// A saved template (BOTONS_HOME/templates/<id>.json) never holds chat, memories, sessions, webhook keys, signing secrets or callback URLs.

export type StoredTemplate = StoredStarter;

const SAVED_ID = /^tpl_[a-z0-9]{8}$/;

/**
 * Templates an import committed but whose files may not be in place yet: a settings row ([{ id, sha }]) written in
 * the import's own transaction. Its files wait beside the others as <id>.json.staged (which list() never reads)
 * until publish() checks each against its sha and renames it into place. So a template is shown exactly when its
 * import committed: a crash before the commit leaves only staged files (removed at the next start), one after it a
 * row that the next start, or the next read, publishes.
 */
const OUTBOX = 'templateOutbox';
const STAGED = '.staged';
const SHA = /^[0-9a-f]{64}$/;
type Pending = { id: string; sha: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Read only a regular file, through the descriptor that was opened without following its final link. */
function readPlain(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a plain file');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Its data on disk before anything says it is there (a power cut, not only a crash). */
function syncPath(path: string, dir = false): void {
  const fd = openSync(path, dir ? 'r' : 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function scheduleText(r: Pick<TemplateRoutine, 'schedule' | 'timezone'>, tz: string): string | null {
  if (!r.schedule) return null;
  try {
    const zone = r.timezone ?? tz;
    return describeSchedule(toSpec(parseSchedule(r.schedule, zone)), zone);
  } catch {
    return r.schedule;
  }
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);

export function readRoutine(v: any): Omit<TemplateRoutine, 'scheduleText'> | null {
  if (!v || typeof v !== 'object') return null;
  const name = str(v.name, 80);
  const instruction = str(v.instruction, 20_000);
  if (!name?.trim() || !instruction?.trim()) return null;
  return {
    name,
    instruction,
    schedule: typeof v.schedule === 'string' && v.schedule.trim() ? v.schedule : null,
    timezone: typeof v.timezone === 'string' && isValidTimezone(v.timezone) ? v.timezone : null,
    webhook: v.webhook === true,
    notify: NOTIFY_POLICIES.includes(v.notify) ? v.notify : 'auto',
    webhookWorkspace: v.webhookWorkspace !== false,
    webhookSource: v.webhook === true && isWebhookSource(v.webhookSource) ? v.webhookSource : 'generic',
    webhookFilter: v.webhook === true ? orNull(() => parseFilter(v.webhookFilter)) : null,
    skill: typeof v.skill === 'string' && SKILL_NAME.test(v.skill) ? v.skill : null,
    model: str(v.model, 120)?.trim() || null,
    effort: str(v.effort, 24)?.trim() || null,
    session: v.session === 'own' ? 'own' : 'chat',
    timeLimitMs: Number.isInteger(v.timeLimitMs) && v.timeLimitMs >= MIN_TIME_LIMIT_MS ? v.timeLimitMs : null,
  };
}

function readTemplate(id: string, v: any): StoredTemplate | null {
  if (!v || typeof v !== 'object' || !v.bot || typeof v.bot !== 'object') return null;
  const b = v.bot;
  const name = str(v.name, 60);
  if (!name?.trim()) return null;
  const routines = Array.isArray(v.routines) ? v.routines.map(readRoutine) : [];
  if (routines.some((r: unknown) => r === null)) return null;
  return {
    id,
    name,
    description: str(v.description, 300) ?? '',
    builtin: false,
    createdAt: str(v.createdAt, 40),
    bot: {
      name: str(b.name, 60) ?? '',
      title: str(b.title, 80) ?? '',
      instructions: str(b.instructions, 20_000) ?? '',
      // A file saved with an earlier look (a Critter or a capsule) gets its closest Boton; anything else, none.
      look: storedLook(b.look, `template:${id}`),
      provider: str(b.provider, 80),
      model: str(b.model, 120) ?? '',
      effort: str(b.effort, 24)?.trim() ?? '',
      access: b.access === 'host' ? 'host' : 'workspace',
      group: str(b.group, 40) ?? '',
      timezone: typeof b.timezone === 'string' && isValidTimezone(b.timezone) ? b.timezone : null,
      // A template saved under the browser connector's deprecated id reads with its current one (shared/legacy-names.mjs).
      connections: (strings(b.connections) ?? []).map((c) => (c === `lib:${RENAMED.botons_browser}` ? 'lib:botons_browser' : c)),
      skills: b.skills === null || b.skills === undefined ? null : (strings(b.skills) ?? null),
    },
    routines,
    // Only a built-in starter declares needs: a saved file can't make itself one.
    needs: null,
  };
}

export class Templates {
  #dir: string;
  #store: Store;
  #skills: Skills;
  /** The server's limit for a turn: a template's routine made here gets no longer one than that. */
  #maxTimeLimitMs: number;

  constructor(dir: string, store: Store, skills: Skills, maxTimeLimitMs: number) {
    this.#dir = dir;
    this.#store = store;
    this.#skills = skills;
    this.#maxTimeLimitMs = maxTimeLimitMs;
    this.publish();
    this.#sweep();
  }

  #pending(): Pending[] {
    const raw = (this.#store.db.prepare('select value from settings where key = ?').get(OUTBOX) as { value: string } | undefined)?.value;
    if (raw === undefined) return [];
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter((x): x is Pending => !!x && SAVED_ID.test(x.id) && SHA.test(x.sha));
    } catch {}
    log.error('the list of imported templates waiting to be put in place is unreadable: it is dropped');
    return [];
  }

  #setPending(list: Pending[]): void {
    if (list.length) this.#store.db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(OUTBOX, JSON.stringify(list));
    else this.#store.db.prepare('delete from settings where key = ?').run(OUTBOX);
  }

  /**
   * Puts in place every template an import committed (see OUTBOX): each staged file that is a plain file with the
   * sha its import recorded is renamed to <id>.json; one that is missing, not a plain file or different is never
   * shown, and is named in the log. One that fails (a folder it can't write) stays listed and is tried again at the
   * next read or start. Idempotent: one already in place is done.
   */
  publish(): void {
    const pending = this.#pending();
    if (!pending.length) return;
    const left: Pending[] = [];
    let placed = 0;
    for (const p of pending) {
      const final = join(this.#dir, `${p.id}.json`);
      const staged = `${final}${STAGED}`;
      try {
        const here = lstatSync(final, { throwIfNoEntry: false });
        if (here) {
          if (!here.isFile() || sha256(readPlain(final)) !== p.sha) throw new Error('the existing final file is not the reviewed artifact; keeping its recovery record and staged file');
          syncPath(this.#dir, true);
          rmSync(staged, { force: true });
          continue;
        }
        const st = lstatSync(staged, { throwIfNoEntry: false });
        if (!st?.isFile() || sha256(readPlain(staged)) !== p.sha) throw new Error('the reviewed staged artifact is missing, linked or changed; keeping its recovery record');
        renameSync(staged, final);
        syncPath(this.#dir, true);
        placed++;
      } catch (err) {
        log.warn(`imported template ${p.id} is not in place yet (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); trying again at the next read`);
        left.push(p);
      }
    }
    if (placed) log.info('templates imported', { templates: placed });
    this.#setPending(left);
  }

  /** At start: staged files no committed import lists (it crashed before its commit), and save()'s half-written ones. */
  #sweep(): void {
    if (!existsSync(this.#dir)) return;
    const listed = new Set(this.#pending().map((p) => `${p.id}.json${STAGED}`));
    for (const f of readdirSync(this.#dir)) {
      const id = f.replace(/\.json(?:\.tmp|\.staged)$/, '');
      if (f === id || !SAVED_ID.test(id) || listed.has(f)) continue;
      try {
        rmSync(join(this.#dir, f), { force: true });
        log.info(`removed ${join(this.#dir, f)}: no committed import or save wrote it whole`);
      } catch (err) {
        log.warn(`cannot remove ${join(this.#dir, f)}: ${(err as Error).message}`);
      }
    }
  }

  list(): BotTemplate[] {
    const tz = this.#store.getSettings().timezone;
    const withText = (t: StoredTemplate): BotTemplate => ({
      ...t,
      routines: t.routines.map((r) => ({ ...r, scheduleText: scheduleText(r, t.bot.timezone ?? tz) })),
    });
    const saved = this.#saved().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return [...STARTERS, ...saved].map(withText);
  }

  get(id: string): BotTemplate {
    const t = this.find(id);
    if (!t) throw new HttpError(404, `No template with id ${id}`);
    return t;
  }

  find(id: unknown): BotTemplate | null {
    return this.list().find((x) => x.id === id) ?? null;
  }

  #saved(): StoredTemplate[] {
    // What committed imports hold is shown, so put it in place first (nothing to do almost always).
    this.publish();
    if (!existsSync(this.#dir)) return [];
    const blocked = new Set(this.#pending().map((p) => p.id));
    const out = [];
    for (const file of readdirSync(this.#dir)) {
      const id = file.replace(/\.json$/, '');
      if (!file.endsWith('.json') || !SAVED_ID.test(id) || blocked.has(id)) continue;
      try {
        const t = readTemplate(id, JSON.parse(readPlain(join(this.#dir, file))));
        if (t) out.push(t);
        else log.warn(`skipping ${join(this.#dir, file)}: it is not a Botons template`);
      } catch (err) {
        log.warn(`skipping ${join(this.#dir, file)}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  save(input: SaveTemplateInput): BotTemplate {
    if (typeof input.fromBotId !== 'string') throw new HttpError(400, 'fromBotId is required');
    const bot = this.#store.getBot(input.fromBotId);
    const name = clean(input.name, 'name', 60) || bot.name;
    const description = clean(input.description, 'description', 300) || (bot.title ? `${bot.title}, saved from ${bot.name}.` : `Saved from ${bot.name}.`);
    const routines = this.#store.listRoutines(bot.id).filter((r) => !(r.schedule?.startsWith('once ')));
    const id = newId('tpl');
    const file = {
      version: 1,
      name,
      description,
      createdAt: nowIso(),
      bot: templateBot(bot),
      routines: routines.map((r) => templateRoutine(r, bot)),
    };
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const path = join(this.#dir, `${id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    log.info('template saved', { botId: bot.id, templateId: id, routines: routines.length });
    return this.get(id);
  }

  /** The owner's saved templates as stored (never the built-in ones), by name: for the configuration file. */
  savedTemplates(): StoredTemplate[] {
    return this.#saved().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /**
   * Saved templates from a configuration file (portable.ts), each under a new id, as OUTBOX describes: stage() writes
   * their files aside (synced, never over an existing one) before the import's transaction; record(), inside it,
   * lists them in the outbox and publishes them once it commits; discard() removes the files of a transaction that
   * didn't commit (any its outbox doesn't list).
   */
  stage(entries: Pick<StoredTemplate, 'name' | 'description' | 'bot' | 'routines'>[]): { ids: string[]; record(): void; discard(): void } {
    const files = entries.map((t) => {
      const body = `${JSON.stringify({ version: 1, name: t.name, description: t.description, createdAt: nowIso(), bot: t.bot, routines: t.routines }, null, 2)}\n`;
      return { id: newId('tpl'), body, sha: sha256(body) };
    });
    const staged = (id: string) => join(this.#dir, `${id}.json${STAGED}`);
    const discard = () => {
      const committed = new Set(this.#pending().map((p) => p.id));
      for (const f of files) if (!committed.has(f.id)) rmSync(staged(f.id), { force: true });
    };
    try {
      if (files.length) mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      for (const f of files) {
        // 'wx': a new file, never through a link or over one that is there.
        writeFileSync(staged(f.id), f.body, { mode: 0o600, flag: 'wx' });
        chmodSync(staged(f.id), 0o600);
        syncPath(staged(f.id));
      }
      if (files.length) syncPath(this.#dir, true);
    } catch (err) {
      discard();
      const code = (err as NodeJS.ErrnoException).code;
      throw new HttpError(500, `Couldn't write the imported templates (${code ?? (err as Error).message}): nothing was imported.`);
    }
    return {
      ids: files.map((f) => f.id),
      record: () => {
        if (!files.length) return;
        if (!this.#store.db.isTransaction) throw new Error('templates are recorded inside the import\'s transaction');
        this.#setPending([...this.#pending(), ...files.map((f) => ({ id: f.id, sha: f.sha }))]);
        this.#store.afterCommit(() => this.publish());
      },
      discard,
    };
  }

  delete(id: string): void {
    if (STARTERS.some((t) => t.id === id)) throw new HttpError(400, "Built-in templates can't be deleted");
    if (!SAVED_ID.test(id) || !existsSync(join(this.#dir, `${id}.json`))) throw new HttpError(404, `No template with id ${id}`);
    rmSync(join(this.#dir, `${id}.json`));
  }

  /** `input` is what the New Boton form holds (the template only filled it in); the template adds its routines. */
  createBot(input: NewBotInput, providers: Set<string>, defaultProvider: string): Bot {
    const template = this.#templateFor(input.templateId);
    const start = flag(input.startRoutines, 'startRoutines', false);
    // A starter's routines are turned on by the owner after its setup check, never by installing it.
    if (template.needs && start) throw new HttpError(400, `${template.name}'s routines start paused: turn them on after its setup check`);
    const { templateId: _t, startRoutines: _s, reviewKey: _k, starterConnectors: slots, ...fields } = input;
    const tz = fields.timezone ?? this.#store.getSettings().timezone;
    if (template.routines.length > MAX_ROUTINES_PER_BOT) throw new HttpError(400, `A Boton can own at most ${MAX_ROUTINES_PER_BOT} routines`);
    for (const r of template.routines) {
      const zone = r.timezone ?? tz;
      if (!isValidTimezone(zone)) throw new HttpError(400, `Template routine “${r.name}” has an unknown timezone ${zone}`);
      if (r.schedule) {
        try {
          parseSchedule(r.schedule, zone);
        } catch (err) {
          throw new HttpError(400, `Template routine “${r.name}”: ${(err as Error).message}`);
        }
      }
    }
    // All or nothing, so a failed routine leaves no half-made Boton for a retry to make again.
    const bot = this.#store.atomically(() => {
      const made = this.#store.createBot(fields, providers, defaultProvider);
      const sameProvider = made.provider === template.bot.provider;
      const routineIds: string[] = [];
      for (const r of template.routines) {
        const routine = this.#store.createRoutine(
          made.id,
          {
            name: r.name,
            instruction: r.instruction,
            schedule: r.schedule,
            timezone: r.timezone ?? made.timezone,
            webhook: r.webhook,
            enabled: start,
            notify: r.notify,
            webhookWorkspace: r.webhookWorkspace,
            ...(r.webhook ? { webhookSource: r.webhookSource, webhookFilter: r.webhookFilter } : {}),
            // A skill the new Boton may not use (left off its list, deleted, or another Boton's pending one) is left out.
            skill: r.skill && this.#skills.enabledFor(made, r.skill) ? r.skill : null,
            model: sameProvider ? r.model : null,
            // Levels are named alike across providers; one the new Boton's provider or the run's model doesn't have is left out.
            effort: r.effort && !effortProblem(made.provider, r.effort, this.#store.effortCaps(made.provider, (sameProvider && r.model) || made.model)) ? r.effort : null,
            session: r.session,
            // Saved on a server that lets turns run longer: as long as this one does.
            timeLimitMs: r.timeLimitMs === null ? null : Math.min(r.timeLimitMs, this.#maxTimeLimitMs),
          },
          { chip: false },
        );
        routineIds.push(routine.id);
      }
      // A starter's routines wait on the owner's decision (starter-gate.ts), in the same transaction they are made in.
      if (template.needs) {
        const chosen = Object.fromEntries((template.needs.connectors ?? []).map((n) => [n.slot, slots?.[n.slot] ?? null]));
        this.#store.saveStarterRecord(made.id, {
          templateId: template.id,
          templateName: template.name,
          version: template.needs.version,
          slots: chosen,
          installedAt: nowIso(),
          pending: routineIds,
          tests: [],
        });
      }
      const count = template.routines.length;
      const what = count ? `; ${count === 1 ? '1 routine' : `${count} routines`}${start ? '' : ', paused'}` : '';
      this.#store.addMessage(made.id, 'event', `Started from template “${template.name}”${what}`, {
        kind: 'bot.from_template',
        templateId: template.id,
        sourceName: template.name,
        copiedRoutines: count,
      });
      return this.#store.publicBot(this.#store.getBot(made.id));
    });
    log.info('Boton created from a template', { botId: bot.id, templateId: template.id, routines: template.routines.length });
    return bot;
  }

  #templateFor(id: unknown): BotTemplate {
    if (typeof id !== 'string' || !id) throw new HttpError(400, 'templateId must be a template id');
    try {
      return this.get(id);
    } catch {
      throw new HttpError(400, `No template with id ${id}`);
    }
  }
}

function templateBot(bot: BotRecord): TemplateBot {
  return {
    name: bot.name,
    title: bot.title,
    instructions: bot.instructions,
    look: bot.look,
    provider: bot.provider,
    model: bot.model,
    effort: bot.effort,
    access: bot.access,
    group: bot.group,
    timezone: bot.timezone,
    connections: bot.connections,
    skills: bot.skills,
  };
}

export function templateRoutine(r: Routine, bot: Pick<Bot, 'timezone'>): Omit<TemplateRoutine, 'scheduleText'> {
  return {
    name: r.name,
    instruction: r.instruction,
    schedule: r.schedule && !isPastOneOff(r.schedule) ? r.schedule : null,
    // The Boton's own timezone becomes the new Boton's.
    timezone: r.timezone === bot.timezone ? null : r.timezone,
    webhook: !!r.webhook,
    notify: r.notify,
    webhookWorkspace: r.webhookWorkspace,
    webhookSource: r.webhook?.source ?? 'generic',
    webhookFilter: r.webhook?.filter ?? null,
    skill: r.skill,
    model: r.model,
    effort: r.effort,
    session: r.session,
    timeLimitMs: r.timeLimitMs,
  };
}
