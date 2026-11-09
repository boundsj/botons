import type { Bot, Skill } from '../../shared/types.ts';

/** The Boton waiting for the owner's approval of a skill it wrote, if any. */
export const pendingFor = (s: Skill) => (s.pending && s.updatedBy.kind === 'boton' ? s.updatedBy : null);

/**
 * The skills a Boton may use now, as the server delivers them (Skills.#usable): on, in its list (null: every skill),
 * and approved unless it wrote them. A skill turned off stays in the Boton's list; it just isn't offered.
 */
export function skillsFor(bot: Pick<Bot, 'id' | 'skills'>, skills: Skill[] | null): Skill[] {
  if (!skills) return [];
  return skills.filter((s) => !s.disabled && (bot.skills === null || bot.skills.includes(s.name)) && (!s.pending || pendingFor(s)?.botId === bot.id));
}
