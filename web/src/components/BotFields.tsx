import { useId, useMemo } from 'react';
import type { AccessLevel, ProviderInfo } from '../../../shared/types.ts';
import { knownEfforts, shownEffort } from '../effort.ts';
import { cx, isValidTimezone, timezones } from '../util.ts';
import { BrainWarning } from './BrainWarning.tsx';

export function Segmented<T extends string | number>(props: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented-field">
      <span className="field-label">{props.label}</span>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === props.value}
            className={cx(o.value === props.value && 'on')}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BrainPicker(props: {
  providers: ProviderInfo[];
  provider: string;
  model: string;
  /** The level wanted (the saved one, or the owner's pick); the control shows it where this brain has it. */
  effort: string;
  onChange: (provider: string, model: string) => void;
  onEffort: (effort: string) => void;
  /** What happens to a wanted level this brain doesn't have, said under the control. */
  droppedText?: string;
}) {
  const id = useId();
  const current = props.providers.find((p) => p.id === props.provider);
  const known = current?.models.some((m) => m.id === props.model) ?? false;
  const shown = shownEffort(current, props.model, props.effort);
  return (
    <div className="brain-picker">
      <label htmlFor={`${id}-p`}>
        <span className="field-label">Brain</span>
      </label>
      <div className="brain-row">
        <select
          id={`${id}-p`}
          value={props.provider}
          onChange={(e) => {
            const next = props.providers.find((p) => p.id === e.target.value);
            props.onChange(e.target.value, next?.defaultModel ?? '');
          }}
        >
          {props.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.available ? '' : ' (not set up)'}
            </option>
          ))}
        </select>
        <select
          aria-label="Model"
          value={known ? props.model : '__custom'}
          onChange={(e) => props.onChange(props.provider, e.target.value === '__custom' ? props.model || ' ' : e.target.value)}
        >
          {current?.models.map((m) => (
            <option key={m.id || '__default'} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="__custom">Custom…</option>
        </select>
      </div>
      {!known && (
        <input
          aria-label="Model id"
          placeholder="Model id, e.g. claude-opus-5-5"
          value={props.model.trim()}
          onChange={(e) => props.onChange(props.provider, e.target.value)}
        />
      )}
      <EffortField
        provider={current}
        model={props.model}
        value={shown}
        onChange={props.onEffort}
        note={props.effort && shown !== props.effort ? `${effortLabel(current, props.effort)} isn’t a level ${modelName(current, props.model)} has, so it goes back to the default${props.droppedText ? ` ${props.droppedText}` : ''}.` : undefined}
      />
      <BrainWarning providers={props.providers} provider={props.provider} />
    </div>
  );
}

const effortLabel = (provider: ProviderInfo | undefined, v: string) => provider?.effort.levels.find((l) => l.id === v)?.label ?? v;
const modelName = (provider: ProviderInfo | undefined, model: string) => {
  const known = knownEfforts(provider, model);
  return known ? `${known.label} (in ${provider?.label ?? 'its'} model list)` : (provider?.label ?? 'this brain');
};

/**
 * How hard the Boton (or a routine, with `inherit`) asks its CLI to think: its provider's levels, the ones the model
 * lists when the provider's model list says. Off, with the reason, for a provider that has no effort setting. Only the
 * request is shown: a CLI may run a level the model lacks as another, and doesn't report which ran.
 */
export function EffortField(props: {
  provider: ProviderInfo | undefined;
  model: string;
  value: string;
  onChange: (effort: string) => void;
  /** The routine form's "the Boton's effort" option, with what that is. */
  inherit?: string;
  /** Said first under the control: what happens to a level that doesn't fit. */
  note?: string;
}) {
  const id = useId();
  const effort = props.provider?.effort;
  const known = knownEfforts(props.provider, props.model);
  const all = effort?.levels ?? [];
  const levels = known ? all.filter((l) => known.levels.includes(l.id)) : all;
  const off = !all.length;
  const stray = props.value && !levels.some((l) => l.id === props.value);
  const defaultText = known?.defaultEffort ? `${effort?.defaultText ?? 'its default'}: ${known.defaultEffort} in its model list` : (effort?.defaultText ?? 'its default');
  const fit = off
    ? (effort?.reason ?? 'This brain has no effort setting, so it runs at its own default.')
    : known
      ? `Requested with ${effort?.via ?? 'the CLI'}; these are the levels its model list gives this model.`
      : `Requested with ${effort?.via ?? 'the CLI'}. Which of these this model takes isn’t known here: the CLI may run another level for one it lacks.`;
  return (
    <div className="effort-field">
      <label htmlFor={id}>
        <span className="field-label">Effort</span>
      </label>
      <select id={id} value={props.value} disabled={off && !props.value} onChange={(e) => props.onChange(e.target.value)} aria-describedby={`${id}-hint`}>
        <option value="">{props.inherit !== undefined ? `Boton's effort (${props.inherit})` : `Provider default (${defaultText})`}</option>
        {levels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
        {stray && <option value={props.value}>{effortLabel(props.provider, props.value)} — not listed for this model</option>}
      </select>
      <span className="hint" id={`${id}-hint`}>
        {props.note && (
          <>
            <strong>{props.note}</strong>{' '}
          </>
        )}
        How hard it thinks before answering; higher is slower and uses more tokens. {fit}
      </span>
    </div>
  );
}

export function AccessPicker({ value, onChange, problem }: { value: AccessLevel; onChange: (a: AccessLevel) => void; problem?: string | null }) {
  return (
    <div className="access-picker" role="radiogroup" aria-label="Computer access">
      <span className="field-label">Computer access</span>
      <button type="button" role="radio" aria-checked={value === 'workspace'} disabled={!!problem} className={cx('access-option', value === 'workspace' && 'on')} onClick={() => onChange('workspace')}>
        <strong>Workspace</strong>
        <span>Sandboxed: writes only inside its own folder and can't read your keys, logins or other Botons' data. It can read other files, and with Codex its commands can reach the network.</span>
      </button>
      {problem && <div className="hint" role="status">{problem}<details><summary>Why?</summary><p>Workspace protects keys, logins and other Botons’ data, and limits writes to its folder. Full computer runs as the server user. On a dedicated cloud VM, the VM itself is the main boundary.</p></details></div>}
      <button type="button" role="radio" aria-checked={value === 'host'} className={cx('access-option', value === 'host' && 'on')} onClick={() => onChange('host')}>
        <strong>Full computer</strong>
        <span>Runs commands as the server user.</span>
      </button>
    </div>
  );
}

export function TimezoneField({ label, value, onChange }: { label: string; value: string; onChange: (tz: string) => void }) {
  const id = useId();
  const options = useMemo(() => timezones().map((z) => <option key={z} value={z} />), []);
  const valid = isValidTimezone(value);
  return (
    <label>
      <span className="field-label">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={`${id}-zones`}
        placeholder="e.g. America/New_York"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!valid}
        aria-describedby={!valid ? `${id}-error` : undefined}
      />
      <datalist id={`${id}-zones`}>{options}</datalist>
      {!valid && (
        <span id={`${id}-error`} className="field-error">
          {value.trim() ? `Unknown timezone “${value}”` : 'Choose a timezone'}
        </span>
      )}
    </label>
  );
}
