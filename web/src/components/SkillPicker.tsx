import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';
import type { Bot, Skill } from '../../../shared/types.ts';
import { attempt } from '../feedback.ts';
import { skillsFor } from '../skills.ts';
import { actions, useStore } from '../state.ts';
import { cx } from '../util.ts';

export function useSkills(): { skills: Skill[] | null; error: string | null } {
  const skills = useStore((s) => s.skills);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!skills) void attempt('load the skills', () => actions.loadSkills(), setError);
  }, [skills]);
  return { skills, error };
}

// An ARIA 1.2 combobox: the composer spreads `inputProps`, and focus stays in the text box.
const NONE: Skill[] = [];
/** The longest skill name the server accepts. */
const SKILL_NAME_MAX = 64;

export function useSkillPicker(bot: Bot, draft: string, setDraft: (s: string) => void) {
  const { skills } = useSkills();
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const id = useId();
  // Only a draft that is all one "/name" can match: anything longer or not starting with "/" costs nothing per keystroke.
  const typed = draft.length <= SKILL_NAME_MAX + 1 && draft.startsWith('/') ? /^\/([a-z0-9-]*)$/.exec(draft)?.[1] : undefined;
  const closed = typed === undefined || dismissed === draft;
  const items = useMemo(
    () => (closed ? NONE : skillsFor(bot, skills).filter((s) => s.name.startsWith(typed) || (typed.length > 1 && s.name.includes(typed)))),
    [closed, typed, skills, bot.id, bot.skills],
  );
  const at = Math.min(index, Math.max(0, items.length - 1));
  useEffect(() => setIndex(0), [typed]);
  const optionId = (i: number) => `${id}-skill-${i}`;
  useEffect(() => {
    if (items.length) document.getElementById(optionId(at))?.scrollIntoView?.({ block: 'nearest' });
  }, [at, items.length]);

  const pick = (s: Skill) => {
    setDraft(`/${s.name} `);
    setDismissed(null);
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setIndex((at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pick(items[at]);
    } else if (e.key === 'Escape') {
      setDismissed(draft);
    } else return false;
    e.preventDefault();
    return true;
  };

  const open = items.length > 0;
  const menu = open ? (
    <ul className="skill-picker" id={`${id}-skills`} role="listbox" aria-label="Skills">
      {items.map((s, i) => (
        <li
          key={s.name}
          id={optionId(i)}
          role="option"
          aria-selected={i === at}
          className={cx(i === at && 'on')}
          // Keep focus (and the caret) in the text box.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(s)}
          onMouseEnter={() => setIndex(i)}
        >
          <code>/{s.name}</code>
          <span>{s.description}</span>
        </li>
      ))}
    </ul>
  ) : null;
  const announce = open ? `${items.length === 1 ? '1 skill matches' : `${items.length} skills match`}: up and down arrows to choose, Enter to use it.` : '';

  const inputProps = {
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': open,
    'aria-controls': open ? `${id}-skills` : undefined,
    'aria-activedescendant': open ? optionId(at) : undefined,
  } as const;

  return { menu, onKey, inputProps, announce };
}
