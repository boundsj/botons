// The skills the web app offers a Boton (web/src/skills.ts): the same ones the server delivers, so a /name the
// picker completes is never plain text and a routine's choices are never refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Skill, SkillAuthor } from '../../shared/types.ts';
import { skillsFor } from '../../web/src/skills.ts';

const skill = (name: string, over: Partial<Skill> = {}): Skill => ({
  name, description: `${name} steps`, body: 'Do it.', createdBy: { kind: 'owner' }, updatedBy: { kind: 'owner' },
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', version: name, pending: false, disabled: false, source: null, ...over,
});
const byKevin: SkillAuthor = { kind: 'boton', botId: 'kevin', name: 'Kevin' };

test('a skill turned off is not offered, though the Boton keeps it in its list', () => {
  const library = [skill('daily-notes'), skill('weekly-report', { disabled: true }), skill('draft', { pending: true, updatedBy: byKevin }), skill('other-draft', { pending: true, updatedBy: { ...byKevin, botId: 'bob' } })];
  const names = (bot: { id: string; skills: string[] | null }) => skillsFor(bot, library).map((s) => s.name);
  assert.deepEqual(names({ id: 'kevin', skills: null }), ['daily-notes', 'draft']);
  const listed = { id: 'stuart', skills: ['weekly-report', 'daily-notes'] };
  assert.deepEqual(names(listed), ['daily-notes']);
  assert.deepEqual(listed.skills, ['weekly-report', 'daily-notes'], 'the grant stays as it was');
  assert.deepEqual(skillsFor({ id: 'kevin', skills: null }, null), []);
});
