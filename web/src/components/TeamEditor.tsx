// Making a team, or changing one: its name and goal, which Botons are on it, which of them leads, and each one's role
// title and responsibilities. The roster is saved in one step (the whole of it, exactly one lead).
import { useId, useState } from 'react';
import type { Team } from '../../../shared/types.ts';
import { TEAM_LIMITS, TEAM_TEXT } from '../../../shared/teams.ts';
import { ApiError } from '../api.ts';
import { attempt } from '../feedback.ts';
import { actions, getState, useStore } from '../state.ts';
import { draftOf, draftProblem } from '../team-words.ts';
import { droppedSeatEdits, rebaseDraft, type SeatDraft, type TeamDraft } from '../teams.ts';
import { BotonAvatar } from './Avatar.tsx';
import { Dialog } from './Dialog.tsx';

export function TeamEditor({ team, onClose, onSaved }: { team: Team | null; onClose: () => void; onSaved: (t: Team) => void }) {
  const bots = useStore((s) => s.bots);
  const [d, setD] = useState<TeamDraft>(() => draftOf(team));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What a save goes from: the team as it opened, or the latest after a save was refused as stale (the draft is kept).
  const [base, setBase] = useState<Team | null>(team);
  const id = useId();
  const editing = !!team;
  const chosen = new Set(d.seats.map((s) => s.botId));
  const full = d.seats.length >= TEAM_LIMITS.membersPerTeam;
  const nameOf = (botId: string) => bots.find((b) => b.id === botId)?.name ?? team?.members.find((m) => m.botId === botId)?.name ?? 'A Boton';
  // Botons in the order they are listed, and seats of Botons that are gone kept at the end (so saving can drop them).
  const listed = [...bots.map((b) => b.id), ...d.seats.map((s) => s.botId).filter((x) => !bots.some((b) => b.id === x))];

  const change = (patch: Partial<TeamDraft>) => {
    setD((cur) => ({ ...cur, ...patch }));
    setProblem(null);
  };
  const toggle = (botId: string, on: boolean) =>
    setD((cur) => {
      const seats = on ? [...cur.seats, { botId, roleTitle: '', responsibilities: '' }] : cur.seats.filter((s) => s.botId !== botId);
      const leadBotId = seats.some((s) => s.botId === cur.leadBotId) ? cur.leadBotId : (seats[0]?.botId ?? null);
      setProblem(null);
      return { ...cur, seats, leadBotId };
    });
  const seat = (botId: string, patch: Partial<SeatDraft>) => change({ seats: d.seats.map((s) => (s.botId === botId ? { ...s, ...patch } : s)) });

  const save = async () => {
    const p = draftProblem(d);
    if (p) return setProblem(p);
    setBusy(true);
    const out: { team?: Team; stale?: boolean } = {};
    await attempt(editing ? `save ${team.name}` : `make the team ${d.name.trim()}`, async () => {
      try {
        out.team = editing && base ? await actions.saveTeam(base, d) : await actions.createTeam(d);
      } catch (e) {
        if (!(editing && e instanceof ApiError && e.code === 'stale_version')) throw e;
        out.stale = true;
      }
    });
    if (out.stale && team) {
      // Changed elsewhere while it was open: load what is there now, move the owner's edits onto it (what they didn't
      // touch shows the team as it is now), and Save again sends only their edits.
      await actions.loadTeam(team.id).catch(() => {});
      const latest = getState().teams?.find((t) => t.id === team.id);
      let lost: string[] = [];
      if (latest && base) {
        lost = droppedSeatEdits(draftOf(base), d, draftOf(latest));
        setD((cur) => rebaseDraft(draftOf(base), cur, draftOf(latest)));
        setBase(latest);
      }
      // A removal elsewhere stands: say whose edits it took, never drop them silently.
      const removed = lost.length ? ` ${lost.map(nameOf).join(' and ')} ${lost.length === 1 ? 'was' : 'were'} removed from the team there, so your changes to ${lost.length === 1 ? 'that seat' : 'those seats'} couldn't be applied.` : '';
      setProblem(`This team changed on another device. Its latest version is loaded with your edits kept: Save again to apply them.${removed}`);
    }
    setBusy(false);
    if (out.team) onSaved(out.team);
  };

  const lead = d.leadBotId ? nameOf(d.leadBotId) : null;
  return (
    <Dialog title={editing ? `Edit ${team.name}` : 'New team'} onClose={() => !busy && onClose()} wide className="team-editor">
      <form
        className="team-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span className="field-label">Name</span>
          <input data-autofocus value={d.name} maxLength={TEAM_TEXT.name} onChange={(e) => change({ name: e.target.value })} placeholder="Atlas" />
        </label>
        <label>
          <span className="field-label">Goal</span>
          <textarea rows={4} value={d.goal} maxLength={TEAM_TEXT.goal} onChange={(e) => change({ goal: e.target.value })} placeholder="What the team is for, and what done looks like." aria-describedby={`${id}-goal`} />
          <span className="hint" id={`${id}-goal`}>
            The lead turns it into work and hands it out.
          </span>
        </label>

        <fieldset className="team-botons">
          <legend className="field-label">Botons on the team</legend>
          {bots.length === 0 ? (
            <p className="hint">Make a Boton first: a team is made of Botons.</p>
          ) : (
            <ul>
              {listed.map((botId) => {
                const b = bots.find((x) => x.id === botId);
                const on = chosen.has(botId);
                return (
                  <li key={botId}>
                    <label className="check team-check">
                      <input type="checkbox" checked={on} disabled={!on && full} onChange={(e) => toggle(botId, e.target.checked)} />
                      {b ? <BotonAvatar look={b.look} size={28} seed={b.id} /> : <span className="avatar-gap" />}
                      <span className="team-check-name">
                        {nameOf(botId)}
                        {b?.title && <span className="muted"> · {b.title}</span>}
                        {!b && <span className="muted"> · deleted</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {full && <p className="hint">A team has at most {TEAM_LIMITS.membersPerTeam} Botons.</p>}
        </fieldset>

        {d.seats.length > 0 && (
          <fieldset className="team-roles">
            <legend className="field-label">Roles</legend>
            {d.seats.map((s) => {
              const name = nameOf(s.botId);
              return (
                <div key={s.botId} className="team-role">
                  <div className="team-role-head">
                    <strong>{name}</strong>
                    <label className="check">
                      <input type="radio" name={`${id}-lead`} checked={d.leadBotId === s.botId} onChange={() => change({ leadBotId: s.botId })} aria-label={`${name} leads the team`} />
                      Leads the team
                    </label>
                  </div>
                  <label>
                    <span className="field-label">Role title</span>
                    <input value={s.roleTitle} maxLength={TEAM_TEXT.roleTitle} onChange={(e) => seat(s.botId, { roleTitle: e.target.value })} placeholder={d.leadBotId === s.botId ? 'Lead' : 'Backend'} aria-label={`${name}'s role title`} />
                  </label>
                  <label>
                    <span className="field-label">Responsibilities</span>
                    <textarea
                      rows={2}
                      value={s.responsibilities}
                      maxLength={TEAM_TEXT.responsibilities}
                      onChange={(e) => seat(s.botId, { responsibilities: e.target.value })}
                      placeholder={d.leadBotId === s.botId ? 'Plans the work and checks results.' : 'What it owns on this team.'}
                      aria-label={`${name}'s responsibilities`}
                    />
                  </label>
                </div>
              );
            })}
          </fieldset>
        )}

        <p className="hint">
          {editing
            ? 'Each Boton sees its team, role and teammates on its next turn. Editing a team starts no new conversation for any of them.'
            : lead
              ? `Making it starts the team: ${lead} gets a check-in to plan the work. A team's work never needs more access: each Boton keeps its own.`
              : 'Making it starts the team: its lead gets a check-in to plan the work.'}
        </p>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Make team'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
