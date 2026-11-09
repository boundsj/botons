import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Bot,
  CreateSkillInput,
  InstallSkillInput,
  Skill,
  SkillAccess,
  SkillAccessInput,
  SkillAuthor,
  SkillHistoryEntry,
  SkillPackage,
  SkillPackageReview,
  SkillPackagesList,
  SkillSource,
  UpdateSkillInput,
} from '../../shared/types.ts';
import type { Approvals } from './approvals.ts';
import type { EventHub } from './events.ts';
import { log } from './log.ts';
import type { SkillIndexEntry } from './prompt.ts';
import { asksOf, lineDiff, listPackages, packageDetails, type PackageRead, readPackage } from './skill-packages.ts';
import { HttpError, type Store } from './store.ts';
import { nowIso, parseJson, type Row, truncate } from './util.ts';

// Skills live in the database and never in the system prompt, so changing them keeps every provider session.
// A skill a Boton saved or changed last is pending: only that Boton uses it until the owner approves (or
// edits) it, so a Boton that read something crafted can't hand every other Boton a procedure.

/** A SKILL.md name: lowercase letters and digits in words joined by single hyphens. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const BODY_MAX = 50_000;
const INDEX_DESCRIPTION_MAX = 200;
/** Replaced texts kept per skill, newest first. */
export const SKILL_HISTORY_KEEP = 10;

/** What the owner reads before approving or installing: the description and the body. */
export const skillVersion = (description: string, body: string) => createHash('sha256').update(description).update('\0').update(body).digest('hex').slice(0, 32);

/** Everything the owner reviews of a package: its text (as skillVersion) and its details (packageDetails). */
export const packageFingerprint = (description: string, body: string, details: string) =>
  createHash('sha256').update('package\0').update(skillVersion(description, body)).update('\0').update(details).digest('hex').slice(0, 32);

/** The details a skill was installed with, as packageDetails writes a package's; empty for one written here. */
const sourceDetails = (source: SkillSource | null) => (source ? packageDetails({ label: source.label, fields: source.fields, otherFiles: source.files ?? [] }) : '');

const OWNER: SkillAuthor = { kind: 'owner' };

/** A Boton's change to who has a skill, for the audit log. */
export interface SkillGrantChange {
  botId: string;
  name: string;
  added: boolean;
  /** It had every skill, and now lists every other one. */
  wasEvery: boolean;
}

const ids = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, `${field} must be a list of Boton ids`);
  return [...new Set(v as string[])];
};
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const has = (bot: Pick<Bot, 'skills'>, name: string) => bot.skills === null || bot.skills.includes(name);

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return t;
}

/** "Juniper (a Boton)" for a skill a Boton wrote. */
const byline = (a: SkillAuthor) => (a.kind === 'boton' ? `${a.name} (a Boton)` : null);

export class Skills {
  #db: DatabaseSync;
  #store: Store;
  #packagesDir: string;
  approvals!: Approvals;

  constructor(db: DatabaseSync, opts: { hub: EventHub; store: Store; packagesDir: string }) {
    this.#db = db;
    this.#store = opts.store;
    this.#packagesDir = opts.packagesDir;
  }

  #toSkill(r: Row): Skill {
    const updatedBy: SkillAuthor = JSON.parse(r.updated_by);
    return {
      name: r.name,
      description: r.description,
      body: r.body,
      createdBy: JSON.parse(r.created_by),
      updatedBy,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: skillVersion(r.description, r.body),
      pending: updatedBy.kind === 'boton',
      disabled: !!r.disabled,
      source: parseJson<SkillSource | null>(r.source, null),
    };
  }

  list(): Skill[] {
    return this.#db
      .prepare('select * from skills order by name')
      .all()
      .map((r) => this.#toSkill(r as Row));
  }

  find(name: string): Skill | null {
    const r = this.#db.prepare('select * from skills where name = ?').get(name) as Row | undefined;
    return r ? this.#toSkill(r) : null;
  }

  get(name: string): Skill {
    const s = this.find(name);
    if (!s) throw new HttpError(404, `No skill named ${name}`);
    return s;
  }

  #emit(name: string): Skill {
    const skill = this.get(name);
    this.#store.publish({ type: 'skill.upserted', skill });
    return skill;
  }

  /** Keeps the skill's text as it is now, before it is replaced, and drops the oldest past SKILL_HISTORY_KEEP. */
  #remember(name: string, by: SkillAuthor): void {
    const r = this.#db.prepare('select * from skills where name = ?').get(name) as Row;
    this.#db
      .prepare('insert into skill_history (name, version, description, body, source, replaced_at, replaced_by) values (?, ?, ?, ?, ?, ?, ?)')
      .run(name, skillVersion(r.description, r.body), r.description, r.body, r.source ?? null, nowIso(), JSON.stringify(by));
    this.#db.prepare('delete from skill_history where name = ? and id not in (select id from skill_history where name = ? order by id desc limit ?)').run(name, name, SKILL_HISTORY_KEEP);
  }

  /** The texts it had before, newest first. */
  history(name: string): SkillHistoryEntry[] {
    this.get(name);
    return (this.#db.prepare('select * from skill_history where name = ? order by id desc').all(name) as Row[]).map((r) => ({
      id: Number(r.id),
      version: r.version,
      description: r.description,
      body: r.body,
      source: parseJson<SkillSource | null>(r.source, null),
      replacedAt: r.replaced_at,
      replacedBy: JSON.parse(r.replaced_by),
    }));
  }

  /**
   * The owner puts back an earlier text (and the source it came from), from the version they read: 409 if the skill
   * changed since. The text it replaces is kept too, so a restore can be undone the same way.
   */
  restore(name: string, input: { id?: unknown; current?: unknown }): { skill: Skill; from: string; to: string } {
    const out = this.#store.atomically(() => {
      const skill = this.get(name);
      if (typeof input?.current !== 'string' || skill.version !== input.current) throw new HttpError(409, `The skill ${name} has changed since you read it: look again.`);
      const entry = this.history(name).find((h) => h.id === input.id);
      if (!entry) throw new HttpError(404, `The skill ${name} has no earlier text with id ${String(input?.id)}`);
      this.#remember(name, OWNER);
      this.#db
        .prepare('update skills set description = ?, body = ?, source = ?, updated_by = ?, updated_at = ? where name = ?')
        .run(entry.description, entry.body, entry.source ? JSON.stringify(entry.source) : null, JSON.stringify(OWNER), nowIso(), name);
      return { from: skill.version, to: entry.version };
    });
    log.info('skill restored', { skill: name, from: out.from, to: out.to });
    this.approvals.resolveSkill(name, 'allowed');
    return { skill: this.#emit(name), ...out };
  }

  /** Off: no Boton sees it, /name is plain text, and routines that follow it run without it. */
  setEnabled(name: string, enabled: unknown): Skill {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    const skill = this.get(name);
    if (skill.disabled === !enabled) return skill;
    this.#db.prepare('update skills set disabled = ? where name = ?').run(enabled ? 0 : 1, name);
    if (enabled) log.info('skill turned on', { skill: name });
    else log.info('skill turned off', { skill: name });
    return this.#emit(name);
  }

  /** Every Boton, and whether it has the skill (in its list, or every skill). Pending and off skills too: having one is still a grant. */
  access(name: string): SkillAccess {
    return {
      name,
      botons: this.#store
        .listBots()
        .map((b) => ({ botId: b.id, name: b.name, has: has(b, name), every: b.skills === null }))
        .sort((a, b) => Number(b.has) - Number(a.has) || a.name.localeCompare(b.name)),
    };
  }

  /**
   * Gives the skill to exactly `botIds` and takes it off every other Boton, all at once or not at all; refused (409)
   * if who had it is not `expected`. A Boton with every skill that loses it lists every other skill in the library
   * instead, so it keeps the rest but no longer gets new ones without being given them.
   */
  setAccess(name: string, input: SkillAccessInput): SkillGrantChange[] {
    const wanted = ids(input?.botIds, 'botIds');
    const expected = ids(input?.expected, 'expected');
    return this.#store.atomically(() => {
      this.get(name);
      const bots = this.#store.listBots();
      const unknown = wanted.find((id) => !bots.some((b) => b.id === id));
      if (unknown) throw new HttpError(400, `No Boton with id ${unknown}`);
      if (!sameSet(bots.filter((b) => has(b, name)).map((b) => b.id), expected)) throw new HttpError(409, `Which Botons have ${name} changed since you looked: review it again`);
      const library = this.list().map((s) => s.name);
      const out: SkillGrantChange[] = [];
      for (const b of bots) {
        const add = wanted.includes(b.id) && !has(b, name);
        const remove = !wanted.includes(b.id) && has(b, name);
        if (add) this.#store.setSkills(b.id, [...(b.skills ?? []), name]);
        else if (remove) this.#store.setSkills(b.id, b.skills === null ? library.filter((n) => n !== name) : b.skills.filter((n) => n !== name));
        if (add || remove) out.push({ botId: b.id, name: b.name, added: add, wasEvery: remove && b.skills === null });
      }
      return out;
    });
  }

  get packagesDir(): string {
    return this.#packagesDir;
  }

  /** Current only while both the skill's text and everything reviewed of the package are as they were installed. */
  #state(p: PackageRead, version: string | null, fingerprint: string | null, installed: Skill | null): SkillPackage['state'] {
    if (p.problems.length || !version || !fingerprint) return 'invalid';
    if (!installed) return 'new';
    if (!installed.source || installed.source.folder !== p.folder) return 'conflict';
    if (installed.source.reviewed !== fingerprint) return 'update';
    return installed.version === version ? 'current' : 'changed';
  }

  #package(p: PackageRead): SkillPackage {
    const version = p.description && p.body ? skillVersion(p.description, p.body) : null;
    const fingerprint = version ? packageFingerprint(p.description!, p.body!, JSON.stringify([p.metadataHash, packageDetails(p)])) : null;
    const installed = p.name === p.folder ? this.find(p.folder) : null;
    const state = this.#state(p, version, fingerprint, installed);
    const asks = version ? asksOf({ description: p.description!, body: p.body!, fields: p.fields }) : [];
    const had = installed?.source ? asksOf({ description: installed.description, body: installed.body, fields: installed.source.fields }) : [];
    return {
      folder: p.folder,
      state,
      problems: state === 'conflict' ? [`A skill named ${p.folder} was not installed from this package. Rename or delete it to install this one.`] : p.problems,
      name: p.name,
      description: p.description,
      body: p.body,
      label: p.label,
      version,
      fingerprint,
      fields: p.fields,
      otherFiles: p.otherFiles,
      asks,
      newAsks: asks.filter((a) => !had.includes(a)),
    };
  }

  /** What is in the skill packages folder. Reads files only: nothing in it is run. */
  packages(): SkillPackagesList {
    const read = listPackages(this.#packagesDir, (n) => n.length <= NAME_MAX && SKILL_NAME.test(n));
    return { dir: this.#packagesDir, exists: read !== null, packages: (read ?? []).map((p) => this.#package(p)) };
  }

  #read(folder: string): SkillPackage {
    const p = readPackage(this.#packagesDir, folder, (n) => n.length <= NAME_MAX && SKILL_NAME.test(n));
    if (!p) throw new HttpError(404, `No skill package named ${folder} in ${this.#packagesDir}`);
    return this.#package(p);
  }

  /** One package and what installing it would change. */
  review(folder: string): SkillPackageReview {
    const pkg = this.#read(folder);
    const installed = pkg.state === 'invalid' ? null : this.find(folder);
    const shown = pkg.state === 'conflict' ? null : installed;
    return {
      ...pkg,
      installed,
      diff: {
        description: lineDiff(shown?.description ?? '', pkg.description ?? ''),
        body: lineDiff(shown?.body ?? '', pkg.body ?? ''),
        details: lineDiff(sourceDetails(shown?.source ?? null), packageDetails(pkg)),
      },
      // For a new skill, who would have it once it is in the library: the Botons with every skill.
      botons: installed ? this.access(folder).botons : this.access(folder).botons.map((m) => ({ ...m, has: m.every })),
    };
  }

  /**
   * Installs or updates a skill from its package, exactly as the owner reviewed it, and gives it to exactly the
   * Botons they chose, all at once or not at all. Its text is read again here and must be the version reviewed; the
   * skill must be the one reviewed; what it asks for that the installed one didn't must be what the owner accepted.
   * The text replaced is kept in its history.
   */
  install(folder: string, input: InstallSkillInput): { skill: Skill; from: string | null; label: string | null; accepted: string[]; grants: SkillGrantChange[] } {
    if (typeof input?.version !== 'string' || !input.version) throw new HttpError(400, 'version is required: the version of the package you reviewed');
    if (typeof input.fingerprint !== 'string' || !input.fingerprint) throw new HttpError(400, 'fingerprint is required: the fingerprint of the package you reviewed');
    if (input.current !== null && typeof input.current !== 'string') throw new HttpError(400, 'current must be the version of the installed skill you reviewed, or null for a new one');
    if (!Array.isArray(input.accept) || !input.accept.every((a) => typeof a === 'string')) throw new HttpError(400, "accept must list what the package asks for that you accepted (its newAsks)");
    const out = this.#store.atomically(() => {
      const pkg = this.#read(folder);
      if (pkg.state === 'invalid') throw new HttpError(400, `The package ${folder} can't be installed: ${pkg.problems.join(' ')}`);
      if (pkg.state === 'conflict') throw new HttpError(409, pkg.problems[0]);
      if (pkg.version !== input.version || pkg.fingerprint !== input.fingerprint) throw new HttpError(409, `The package ${folder} has changed since you reviewed it: review it again.`);
      const installed = this.find(folder);
      if ((installed?.version ?? null) !== input.current) throw new HttpError(409, `The skill ${folder} has changed since you reviewed it: review it again.`);
      if (!sameSet(pkg.newAsks, [...new Set(input.accept as string[])])) throw new HttpError(409, `What ${folder} asks for has changed since you reviewed it: review it again.`);
      const source: SkillSource = { kind: 'folder', folder, label: pkg.label, installed: pkg.version, installedAt: nowIso(), fields: pkg.fields, files: pkg.otherFiles, reviewed: pkg.fingerprint! };
      const now = nowIso();
      if (installed) {
        this.#remember(folder, OWNER);
        this.#db
          .prepare('update skills set description = ?, body = ?, source = ?, updated_by = ?, updated_at = ? where name = ?')
          .run(pkg.description, pkg.body, JSON.stringify(source), JSON.stringify(OWNER), now, folder);
      } else {
        this.#db
          .prepare('insert into skills (name, description, body, created_by, updated_by, created_at, updated_at, source) values (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(folder, pkg.description, pkg.body, JSON.stringify(OWNER), JSON.stringify(OWNER), now, now, JSON.stringify(source));
      }
      const grants = this.setAccess(folder, { botIds: input.botIds, expected: input.expected });
      return { from: installed?.version ?? null, label: pkg.label, accepted: pkg.newAsks, grants };
    });
    log.info('skill installed', { skill: folder, from: out.from });
    return { skill: this.#emit(folder), ...out };
  }

  create(input: CreateSkillInput, by: SkillAuthor = { kind: 'owner' }): Skill {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > NAME_MAX || !SKILL_NAME.test(name)) {
      throw new HttpError(400, `name must be lowercase letters and digits, words joined by single hyphens (like weekly-report), at most ${NAME_MAX}`);
    }
    if (this.find(name)) throw new HttpError(409, `There is already a skill named ${name}`);
    const description = text(input.description, 'description', DESCRIPTION_MAX);
    const body = text(input.body, 'body', BODY_MAX);
    const now = nowIso();
    const who = JSON.stringify(by);
    this.#db
      .prepare('insert into skills (name, description, body, created_by, updated_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(name, description, body, who, who, now, now);
    log.info('skill saved', { skill: name, by: by.kind === 'boton' ? by.botId : 'owner' });
    return this.#emit(name);
  }

  update(name: string, input: UpdateSkillInput, by: SkillAuthor = { kind: 'owner' }): Skill {
    const current = this.get(name);
    const rename = (input as { name?: unknown }).name;
    if (rename !== undefined && rename !== name) {
      throw new HttpError(400, "A skill's name can't change; save it under the new name and delete the old one");
    }
    const sets: string[] = [];
    const vals: string[] = [];
    if (input.description !== undefined) {
      sets.push('description = ?');
      vals.push(text(input.description, 'description', DESCRIPTION_MAX));
    }
    if (input.body !== undefined) {
      sets.push('body = ?');
      vals.push(text(input.body, 'body', BODY_MAX));
    }
    if (!sets.length) return this.get(name);
    const next = { description: input.description !== undefined ? vals[0] : current.description, body: input.body !== undefined ? vals.at(-1)! : current.body };
    if (skillVersion(next.description, next.body) !== current.version) this.#remember(name, by);
    this.#db.prepare(`update skills set ${sets.join(', ')}, updated_by = ?, updated_at = ? where name = ?`).run(...vals, JSON.stringify(by), nowIso(), name);
    log.info('skill changed', { skill: name, by: by.kind === 'boton' ? by.botId : 'owner' });
    // The owner's edit approves it.
    if (by.kind === 'owner') this.approvals.resolveSkill(name, 'allowed');
    return this.#emit(name);
  }

  /** The owner approves a pending skill at the `version` they read (409 if it changed since). */
  approve(name: string, version: unknown): Skill {
    if (typeof version !== 'string' || !version) throw new HttpError(400, 'version is required: the version of the skill you read (Skill.version)');
    const skill = this.get(name);
    if (skill.version !== version) {
      throw new HttpError(409, `The skill ${name} has changed since you read it${skill.pending ? '. Read it again before approving it' : ''}.`);
    }
    if (!skill.pending) return skill;
    this.#db.prepare('update skills set updated_by = ?, updated_at = ? where name = ?').run(JSON.stringify({ kind: 'owner' } satisfies SkillAuthor), nowIso(), name);
    log.info('skill approved', { skill: name, by: skill.updatedBy.kind === 'boton' ? skill.updatedBy.botId : 'owner' });
    this.approvals.resolveSkill(name, 'allowed');
    return this.#emit(name);
  }

  /** Refused while a routine follows it; Botons that had it in their list lose it. */
  delete(name: string): void {
    this.get(name);
    const users = this.#db
      .prepare('select r.name as routine, b.name as bot from routines r join bots b on b.id = r.bot_id where r.skill = ? order by b.name, r.name')
      .all(name) as Row[];
    if (users.length) {
      const list = users.map((u) => `“${u.routine}” (${u.bot})`).join(', ');
      throw new HttpError(409, `Routine${users.length > 1 ? 's' : ''} ${list} follow${users.length > 1 ? '' : 's'} this skill. Change ${users.length > 1 ? 'them' : 'it'} first.`);
    }
    this.#db.prepare('delete from skills where name = ?').run(name);
    this.#db.prepare('delete from skill_history where name = ?').run(name);
    this.#store.dropFromBots('skills', name);
    this.#store.publish({ type: 'skill.deleted', name });
    this.approvals.resolveSkill(name, 'cancelled');
    log.info('skill deleted', { skill: name });
  }

  /**
   * A skill from a configuration file (portable.ts), inside the caller's transaction: made, or with `replace` put in
   * place of the one here (whose text goes to its history first). Its text, author, source and earlier texts are
   * kept as given; what it grants is nothing, as for any skill. A Boton's skill stays pending until approved.
   */
  importSkill(
    entry: { name: string; description: string; body: string; disabled: boolean; author: SkillAuthor; source: SkillSource | null; history: { description: string; body: string; source: SkillSource | null; replacedAt: string }[] },
    replace: boolean,
  ): Skill {
    const now = nowIso();
    const by = JSON.stringify(entry.author);
    const source = entry.source ? JSON.stringify(entry.source) : null;
    if (replace) {
      this.get(entry.name);
      this.#remember(entry.name, OWNER);
      this.#db
        .prepare('update skills set description = ?, body = ?, source = ?, disabled = ?, updated_by = ?, updated_at = ? where name = ?')
        .run(entry.description, entry.body, source, entry.disabled ? 1 : 0, by, now, entry.name);
    } else {
      if (this.find(entry.name)) throw new HttpError(409, `There is already a skill named ${entry.name}`);
      this.#db
        .prepare('insert into skills (name, description, body, created_by, updated_by, created_at, updated_at, source, disabled) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(entry.name, entry.description, entry.body, by, by, now, now, source, entry.disabled ? 1 : 0);
      // Oldest first, so the newest gets the highest id, as history() reads them.
      const add = this.#db.prepare('insert into skill_history (name, version, description, body, source, replaced_at, replaced_by) values (?, ?, ?, ?, ?, ?, ?)');
      for (const h of [...entry.history].slice(0, SKILL_HISTORY_KEEP).reverse()) {
        add.run(entry.name, skillVersion(h.description, h.body), h.description, h.body, h.source ? JSON.stringify(h.source) : null, h.replacedAt, JSON.stringify(OWNER));
      }
    }
    log.info('skill imported', { skill: entry.name });
    // A card waiting on the text it replaced no longer describes it: the owner's import approves it, a Boton's withdraws it.
    if (replace) this.approvals.resolveSkill(entry.name, entry.author.kind === 'owner' ? 'allowed' : 'cancelled');
    return this.#emit(entry.name);
  }

  /** In the Boton's list (null: every skill), and not pending unless the Boton wrote it. */
  #usable(bot: Pick<Bot, 'id' | 'skills'>, skill: Skill): boolean {
    if (skill.disabled) return false;
    if (bot.skills !== null && !bot.skills.includes(skill.name)) return false;
    return !skill.pending || (skill.updatedBy.kind === 'boton' && skill.updatedBy.botId === bot.id);
  }

  forBot(bot: Pick<Bot, 'id' | 'skills'>): Skill[] {
    return this.list().filter((s) => this.#usable(bot, s));
  }

  enabledFor(bot: Pick<Bot, 'id' | 'skills'>, name: string): Skill | null {
    const skill = this.find(name);
    return skill && this.#usable(bot, skill) ? skill : null;
  }

  getFor(botId: string, name: string): Skill {
    const skill = this.enabledFor(this.#store.getBot(botId), name);
    if (!skill) throw new HttpError(404, `No skill named ${name} is enabled for this Boton`);
    return skill;
  }

  /** `botons skill create`: the Boton's own (added to its list, if it has one), with a chip and an approval card. */
  createByBoton(botId: string, input: CreateSkillInput): Skill {
    const bot = this.#store.getBot(botId);
    const skill = this.create(input, { kind: 'boton', botId, name: bot.name });
    if (bot.skills !== null) {
      this.#db.prepare('update bots set skills = ? where id = ?').run(JSON.stringify([...bot.skills, skill.name]), botId);
      this.#store.emitBot(botId);
    }
    this.#store.addMessage(botId, 'event', 'Saved a skill', { kind: 'skill.created', skillName: skill.name });
    this.approvals.forSkill(botId, skill);
    return skill;
  }

  /** `botons skill update`: only a skill this Boton wrote, until anyone else changed it. */
  updateByBoton(botId: string, name: string, input: UpdateSkillInput): Skill {
    const bot = this.#store.getBot(botId);
    const skill = this.get(name);
    const mine = (a: SkillAuthor) => a.kind === 'boton' && a.botId === botId;
    if (!mine(skill.createdBy) || !mine(skill.updatedBy)) {
      const owner = this.#store.getSettings().ownerName;
      throw new HttpError(403, `Only ${owner} can change the skill ${name}: a Boton can only change the skills it wrote, until ${owner} edits or approves them. Save yours under a new name instead.`);
    }
    const updated = this.update(name, input, { kind: 'boton', botId, name: bot.name });
    this.#store.addMessage(botId, 'event', 'Updated a skill', { kind: 'skill.updated', skillName: name });
    this.approvals.forSkill(botId, updated);
    return updated;
  }

  /** A Boton's list of skills as given: null (every skill), or names in the library (it may keep ones that are gone). */
  checkAllowlist(value: unknown, current: string[] | null): string[] | null {
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((n) => typeof n === 'string')) throw new HttpError(400, 'skills must be a list of skill names, or null for every skill');
    const list = [...new Set(value as string[])];
    const unknown = list.find((n) => !this.find(n) && !(current ?? []).includes(n));
    if (unknown) throw new HttpError(400, `No skill named ${unknown}`);
    return list;
  }

  /** A routine's skill as given: null, or one its Boton may use. */
  checkRoutineSkill(botId: string, value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new HttpError(400, 'skill must be a skill name or null');
    const skill = this.find(value);
    if (!skill) throw new HttpError(400, `No skill named ${value}`);
    if (!this.#usable(this.#store.getBot(botId), skill)) {
      throw new HttpError(400, skill.disabled ? `The skill ${value} is turned off` : skill.pending ? `The skill ${value} was written by another Boton and is waiting for approval` : `The skill ${value} is not enabled for this Boton`);
    }
    return value;
  }

  /** The context block's index of the skills the Boton may use. */
  index(bot: Pick<Bot, 'id' | 'skills'>): SkillIndexEntry[] {
    return this.forBot(bot).map((s) => ({
      name: s.name,
      description: truncate(s.description, INDEX_DESCRIPTION_MAX),
      by: byline(s.updatedBy) ?? byline(s.createdBy),
      pending: s.pending,
    }));
  }

  /** The skill a chat message invokes with a leading /<name>, if the Boton may use it. */
  invoked(bot: Pick<Bot, 'id' | 'skills'>, message: string): { skill: Skill; input: string } | null {
    const m = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(message.trim());
    if (!m) return null;
    const skill = this.enabledFor(bot, m[1]);
    return skill ? { skill, input: (m[2] ?? '').trim() } : null;
  }
}
