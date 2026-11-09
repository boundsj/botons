import { useState } from 'react';
import type { BrainRef, ProviderSwitchPreview } from '../../../shared/types.ts';
import { durationText } from '../../../shared/util.ts';
import { dateTime } from '../util.ts';
import { ConfirmDialog } from './Dialog.tsx';

const brain = (b: BrainRef) => `${b.label} (${b.model || 'its default model'})`;
const level = (effort: string) => effort || 'the default';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const n = (x: number) => x.toLocaleString();

/** What the new session is given of the chat: its budget, the pins and what fits now, said as the estimate it is. */
function replayText(p: ProviderSwitchPreview): string {
  const r = p.replayNow;
  const now = r.messages + r.routines
    ? `now ${plural(r.messages, 'message')}${r.routines ? ` and ${plural(r.routines, 'routine message')}` : ''}${r.since ? `, back to ${dateTime(r.since)}` : ''}`
    : 'nothing yet';
  const pins = p.replay.pinned
    ? `, plus ${plural(p.replay.pinned, 'pinned message')}, whatever ${p.replay.pinned === 1 ? 'its' : 'their'} age (a long one as its start and end)`
    : `; pin messages in the chat (up to ${p.replay.pinLimit}) to keep them whatever their age`;
  const long = r.excerpts ? `; ${plural(r.excerpts, 'long message')} as ${r.excerpts === 1 ? 'an excerpt' : 'excerpts'} (start and end, not a summary)` : '';
  return `This chat, replayed within ${n(p.replay.budget)} tokens (estimated high, as bytes) shared with the handoff note, on top of what every session starts with: the latest messages that fit (${now})${pins}${long}`;
}

/**
 * What moving a Boton to another provider keeps and loses, from the server's preview, before anything changes.
 * Confirming sends the preview's confirmation with the update (the one for a move with the summary, if the owner
 * asked for it); Cancel changes nothing. The summary is off until the owner turns it on: it is one more turn on the
 * old provider.
 */
export function SwitchDialog(props: { name: string; preview: ProviderSwitchPreview; onConfirm: (summary: boolean) => Promise<unknown>; onClose: () => void }) {
  const { name, preview: p } = props;
  const [summary, setSummary] = useState(false);
  const asked = summary && p.summary.available;
  const routines = p.sessions.routines.map((r) => `“${r.name}”`).join(', ');
  const sessions = [p.sessions.chat ? `${name}'s chat session` : null, routines ? `the own ${p.sessions.routines.length === 1 ? 'session' : 'sessions'} of routine ${routines}` : null].filter(Boolean);
  const changes = [
    p.from.effort !== p.to.effort
      ? `Effort: ${level(p.from.effort)} becomes ${level(p.to.effort)}${p.effortReset ? `: ${p.to.label} or this model doesn't have ${p.from.effort}` : ''}.`
      : null,
    ...p.routineModels.map((r) => `Routine “${r.name}” leaves ${r.model} (a ${p.from.label} model) for ${name}'s model.`),
    ...p.routineEfforts.map((r) => `Routine “${r.name}” leaves effort ${r.effort} for ${name}'s.`),
    ...p.connectors.map((c) => `Connector ${c.name} doesn't run on ${p.to.label}: it stays in ${name}'s settings but its turns go without it.`),
  ].filter((x): x is string => !!x);
  const ready =
    p.readiness.state === 'ready'
      ? null
      : p.readiness.state === 'unavailable'
        ? `${p.to.label} isn't usable on this server now${p.readiness.reason ? `: ${p.readiness.reason}` : ''}. Turns fail until it is.`
        : `Whether ${p.to.label} works here isn't known yet: the first turn shows it.`;
  return (
    <ConfirmDialog
      title={`Move ${name} to ${p.to.label}?`}
      confirmLabel={`Move to ${p.to.label}`}
      busyLabel={asked ? `Waiting for the summary…` : undefined}
      what={`move ${name}`}
      onConfirm={() => props.onConfirm(asked)}
      onClose={props.onClose}
    >
      <p>
        From {brain(p.from)} to {brain(p.to)}. {cap(sessions.join(' and '))} on {p.from.label} {sessions.length > 1 ? 'end' : 'ends'}: a session can't move between providers.
      </p>
      <div className="switch-lists">
        <div>
          <h4>Kept</h4>
          <ul>
            <li>{plural(p.kept.memories, 'memory', 'memories')} and {plural(p.kept.routines, 'routine')}</li>
            <li>The files in its workspace</li>
            <li>{replayText(p)}</li>
            <li>A handoff note from Botons: the move, its waiting requests, runs and recent decisions</li>
          </ul>
        </div>
        <div>
          <h4>Lost</h4>
          <ul>
            <li>What lived only in the {p.from.label} session: tool results, files it read, its reasoning</li>
            <li>{p.replayNow.olderLeftOut ? 'Older chat: it doesn’t fit the replay' : 'Chat older than what fits the replay, as the chat grows'}</li>
          </ul>
        </div>
      </div>
      <div className="switch-summary">
        <label className={p.summary.available ? undefined : 'disabled'}>
          <input type="checkbox" checked={asked} disabled={!p.summary.available} onChange={(e) => setSummary(e.target.checked)} />
          Ask its {p.from.label} session for a summary first
        </label>
        <p className="hint">
          {p.summary.available
            ? `One more turn on ${p.from.label} (it counts toward its usage), with no tools, for up to ${durationText(p.summary.timeoutMs)}: it writes down its open work, promises and the IDs the new session needs. You and the new session see it in the chat, at most ${p.summary.maxChars.toLocaleString()} characters, as its own account. If it can't be written, nothing moves.`
            : `Not available: ${p.summary.reason}.`}
        </p>
      </div>
      {changes.length > 0 && (
        <ul className="switch-changes">
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {p.working && (
        <p className="hint warn">
          {name} is in the middle of a turn on {p.from.label}. It finishes there, and what it does still happens (replies, files, actions it takes), but its
          session isn't kept: the next turn starts on {p.to.label}.
        </p>
      )}
      {p.queuedRuns > 0 && <p className="hint">{plural(p.queuedRuns, 'queued run')} {p.queuedRuns === 1 ? 'runs' : 'run'} on {p.to.label}.</p>}
      {p.oldUsageLimitUntil && <p className="hint">{p.from.label} is out of usage until {dateTime(p.oldUsageLimitUntil)}.</p>}
      {p.readiness.usageLimitUntil && <p className="hint warn">{p.to.label} is out of usage until {dateTime(p.readiness.usageLimitUntil)}.</p>}
      {ready && <p className="hint warn">{ready}</p>}
    </ConfirmDialog>
  );
}
