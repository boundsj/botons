import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { describeLook, LOOK_LABELS, type Part, PARTS, randomLook } from '../../../shared/look.ts';
import { STATES } from '../../../shared/boton.ts';
import type { AvatarState, BotonLook } from '../../../shared/types.ts';
import { cx } from '../util.ts';
import { BotonAvatar } from './Avatar.tsx';
import { DiceIcon } from './Icons.tsx';

/** The builder's names for the states, as the rest of the app says them. */
export const STATE_NAMES: Record<AvatarState, string> = { idle: 'Idle', working: 'Thinking', approval: 'Needs you', error: 'Error', asleep: 'No brain' };

type Tab = { id: string; label: string; parts: readonly (Part | 'cheeks')[] };
const TABS: readonly Tab[] = [
  { id: 'body', label: 'Body', parts: ['shape', 'shell', 'glow'] },
  { id: 'face', label: 'Face', parts: ['eyes', 'brows', 'mouth', 'cheeks'] },
  { id: 'parts', label: 'Parts', parts: ['top', 'ears', 'visor', 'panel'] },
  { id: 'scene', label: 'Pose', parts: ['arms', 'backdrop'] },
];
const PART_NAMES: Record<Part | 'cheeks', string> = { shape: 'Shape', shell: 'Shell', glow: 'Glow', cheeks: 'Cheeks', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', top: 'Top', ears: 'Ears', visor: 'Visor', panel: 'Panel', arms: 'Arms', backdrop: 'Backdrop' };

/** Arrow keys move through a row of choices and pick as they go, like native radio buttons; Home and End jump. */
function rovingKeys<T>(e: KeyboardEvent<HTMLElement>, values: readonly T[], value: T, pick: (v: T) => void): void {
  const i = values.indexOf(value);
  const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: values.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  const v = values[(next + values.length) % values.length];
  pick(v);
  // Focus follows the pick: the newly checked button is the group's one tab stop.
  const group = e.currentTarget.closest('[role="radiogroup"], [role="tablist"]');
  requestAnimationFrame(() => (group?.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus());
}

/** A part's choices: labelled buttons with a small, still drawing of the Boton with each one. */
function PartPicker({ part, look, onPick }: { part: Part; look: BotonLook; onPick: (l: BotonLook) => void }) {
  const values = PARTS[part] as readonly string[];
  const labels = LOOK_LABELS[part] as Record<string, string>;
  const value = look[part] as string;
  const pick = (v: string) => onPick({ ...look, [part]: v });
  return (
    <div className="part-picker" role="radiogroup" aria-label={PART_NAMES[part]}>
      <span className="field-label" aria-hidden="true">
        {PART_NAMES[part]}
      </span>
      <div className="part-options">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            tabIndex={v === value ? 0 : -1}
            className={cx('part-option', v === value && 'on')}
            onClick={() => pick(v)}
            onKeyDown={(e) => rovingKeys(e, values, value, pick)}
          >
            <BotonAvatar look={{ ...look, [part]: v }} size={44} still />
            <span>{labels[v]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CheeksPicker({ look, onPick }: { look: BotonLook; onPick: (l: BotonLook) => void }) {
  const values = [true, false] as const;
  const pick = (cheeks: boolean) => onPick({ ...look, cheeks });
  return (
    <div className="part-picker" role="radiogroup" aria-label="Cheeks">
      <span className="field-label" aria-hidden="true">
        Cheeks
      </span>
      <div className="part-options">
        {values.map((v) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={look.cheeks === v}
            tabIndex={look.cheeks === v ? 0 : -1}
            className={cx('part-option', look.cheeks === v && 'on')}
            onClick={() => pick(v)}
            onKeyDown={(e) => rovingKeys(e, values, look.cheeks, pick)}
          >
            <BotonAvatar look={{ ...look, cheeks: v }} size={44} still />
            <span>{v ? 'Rosy' : 'Plain'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The Boton builder: one editor wherever a Boton is made or changed (setup's first Boton, New Boton, the Boton's settings and
 * templates). Every choice is one of the look's fixed parts; the preview can show each state, so you see how the
 * Boton will look while it thinks, needs you or has no brain. `compact` keeps it to one column for narrow places.
 */
export function BotonBuilder({ look, onChange, compact }: { look: BotonLook; onChange: (l: BotonLook) => void; compact?: boolean }) {
  const id = useId();
  const [tab, setTab] = useState(TABS[0].id);
  const [state, setState] = useState<AvatarState>('idle');
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const description = useMemo(() => describeLook(look), [look]);
  return (
    <div className={cx('boton-builder', compact && 'compact')}>
      <div className="boton-stage">
        <BotonAvatar look={look} size={compact ? 96 : 128} state={state} seed="preview" label={`Preview, ${STATE_NAMES[state].toLowerCase()}: ${description}`} />
        <div className="stage-states" role="radiogroup" aria-label="Preview a state">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === state}
              tabIndex={s === state ? 0 : -1}
              className={cx('chip', s === state && 'on')}
              onClick={() => setState(s)}
              onKeyDown={(e) => rovingKeys(e, STATES, state, setState)}
            >
              {STATE_NAMES[s]}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost small" onClick={() => onChange(randomLook())}>
          <DiceIcon size={16} /> Surprise me
        </button>
      </div>
      <div className="boton-parts">
        <div className="boton-tabs" role="tablist" aria-label="Parts">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${id}-tab-${t.id}`}
              aria-controls={`${id}-panel`}
              aria-selected={t.id === active.id}
              tabIndex={t.id === active.id ? 0 : -1}
              className={cx('boton-tab', t.id === active.id && 'on')}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) =>
                rovingKeys(
                  e,
                  TABS.map((x) => x.id),
                  active.id,
                  setTab,
                )
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="boton-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active.id}`}>
          {active.parts.map((p) => (p === 'cheeks' ? <CheeksPicker key={p} look={look} onPick={onChange} /> : <PartPicker key={p} part={p} look={look} onPick={onChange} />))}
        </div>
      </div>
    </div>
  );
}
