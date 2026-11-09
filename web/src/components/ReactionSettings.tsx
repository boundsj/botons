import { useState } from 'react';
import { DEFAULT_REACTION_FOLLOW_UPS, REACTION_FOLLOW_UP_MAX, reactionEmoji } from '../../../shared/reactions.ts';
import { errorText } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { CloseIcon } from './Icons.tsx';

/** Offered to add with one click: the reactions whose meaning a follow-up turn is told. */
const SUGGESTED = ['👎', '😕', '❓'];

/**
 * Settings.reactionFollowUps: which of the owner's reactions also start a short follow-up turn. Shown as the server
 * has it; each change is saved at once and shows when the server answers (or says why not).
 */
export function ReactionSettings() {
  const current = useStore((s) => s.settings?.reactionFollowUps);
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = current ?? [];
  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await actions.updateSettings({ reactionFollowUps: next });
      return true;
    } catch (e) {
      setError(`Couldn't save the follow-up reactions: ${errorText(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (input: string) => {
    const emoji = reactionEmoji(input);
    if (!emoji) return setError('One emoji, with no text: say 👎');
    if (list.includes(emoji)) return setError(`${emoji} already asks for a follow-up`);
    if (list.length >= REACTION_FOLLOW_UP_MAX) return setError(`At most ${REACTION_FOLLOW_UP_MAX}: take one off first`);
    if (await save([...list, emoji])) setOwn('');
  };
  const isDefault = list.length === DEFAULT_REACTION_FOLLOW_UPS.length && list.every((e, i) => e === DEFAULT_REACTION_FOLLOW_UPS[i]);
  return (
    <section className="server-info reaction-settings" aria-labelledby="reaction-settings-title">
      <h4 id="reaction-settings-title">Reactions</h4>
      <p className="hint">
        A reaction on a Boton's message is feedback: the Boton is given it on its next turn. It starts no turn and sends no notification, and it never answers an approval or a card,
        which have their own buttons.
      </p>
      <p className="hint">{list.length ? 'These reactions also ask the Boton for a short follow-up about that message, once per message:' : 'No reaction asks for a follow-up.'}</p>
      {list.length > 0 && (
        <ul className="follow-up-list" aria-label="Reactions that ask for a follow-up">
          {list.map((e) => (
            <li key={e} className="follow-up-emoji">
              <span aria-hidden="true">{e}</span>
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                aria-label={`Stop ${e} asking for a follow-up`}
                title={`Stop ${e} asking for a follow-up`}
                onClick={() => void save(list.filter((x) => x !== e))}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="follow-up-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add(own);
        }}
      >
        {SUGGESTED.filter((e) => !list.includes(e)).map((e) => (
          <button key={e} type="button" className="btn small" disabled={busy} aria-label={`Add ${e}`} onClick={() => void add(e)}>
            + {e}
          </button>
        ))}
        <input
          value={own}
          onChange={(e) => {
            setOwn(e.target.value);
            setError(null);
          }}
          placeholder="Any emoji"
          aria-label="Add an emoji that asks for a follow-up"
          autoComplete="off"
        />
        <button type="submit" className="btn small" disabled={busy || !own.trim()}>
          Add
        </button>
      </form>
      <div className="follow-up-actions">
        {list.length > 0 && (
          <button type="button" className="link-btn" disabled={busy} onClick={() => void save([])}>
            Turn follow-ups off
          </button>
        )}
        {!isDefault && (
          <button type="button" className="link-btn" disabled={busy} onClick={() => void save([...DEFAULT_REACTION_FOLLOW_UPS])}>
            Back to {DEFAULT_REACTION_FOLLOW_UPS.join(' ')} alone
          </button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
