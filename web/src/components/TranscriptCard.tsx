import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import {
  type CardAnswerInput,
  type CardBlock,
  type CardField,
  type InteractiveBlock,
  interactiveBlock,
  safeLinkProblem,
  type TranscriptCard as Card,
} from '../../../shared/cards.ts';
import type { Message } from '../../../shared/types.ts';
import { errorText } from '../feedback.ts';
import { actions } from '../state.ts';
import { clock, cx, dateTime, relative } from '../util.ts';
import type { RowBot } from './Approvals.tsx';
import { ClockIcon, ExternalIcon, FileIcon } from './Icons.tsx';

/*
 * A card a Boton posted (shared/cards.ts), drawn from the server's checked copy. Every string is plain text: no
 * Markdown, no HTML, no styles from the card. Links are https only and show their host; files open in the app's own
 * viewer. What a button does is the server's: the client sends only which button, option or values.
 */

function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function TranscriptCard({ bot, m, onOpenFile, onOpenRoutine }: { bot: RowBot; m: Message; onOpenFile: (path: string) => void; onOpenRoutine: (id: string) => void }) {
  const card = m.meta?.card;
  const now = useNow();
  const headId = useId();
  if (!card) return null;
  const ask = interactiveBlock(card.descriptor);
  // The server closes a card past its expiry when it is next read or answered; until then it reads as expired here too.
  const status = card.status === 'pending' && new Date(card.expiresAt).getTime() <= now ? 'expired' : card.status;
  return (
    <section className={cx('tcard', `is-${status}`, card.from.sandboxed && 'outside')} id={`card-${m.id}`} aria-labelledby={headId}>
      <div className="tcard-head">
        <span>{ask ? `${bot.name} asks you` : `${bot.name} posted a card`}</span>
        <span className="tcard-time" title={dateTime(m.createdAt)}>
          {clock(m.createdAt)}
        </span>
      </div>
      <h3 className="tcard-title" id={headId}>
        {card.descriptor.title}
      </h3>
      {card.descriptor.blocks.map((b, i) => (
        // The blocks never change: a card is saved once.
        <Block key={i} b={b} bot={bot} card={card} onOpenFile={onOpenFile} />
      ))}
      {(card.from.routineId || card.from.sandboxed) && (
        <p className="approval-origin">
          Posted in {card.from.trigger === 'chat' ? 'a chat turn' : `a ${card.from.trigger === 'schedule' ? 'scheduled' : card.from.trigger} run of`}
          {card.from.routineId && (
            <button className="chip-link" onClick={() => onOpenRoutine(card.from.routineId!)}>
              <ClockIcon size={14} />
              {card.from.routineName ?? 'a routine'}
            </button>
          )}
        </p>
      )}
      {card.from.sandboxed && ask && (
        <p className="approval-warn">{bot.name} posted this during a webhook run, whose payload came from outside: its text may not be {bot.name}'s own words. Read all of it before you answer.</p>
      )}
      {ask && (status === 'pending' ? <Answer m={m} bot={bot} card={card} ask={ask} now={now} /> : <Outcome card={card} status={status} bot={bot} />)}
    </section>
  );
}

function Block({ b, bot, card, onOpenFile }: { b: CardBlock; bot: RowBot; card: Card; onOpenFile: (path: string) => void }) {
  switch (b.type) {
    case 'text':
      return <p className="plain tcard-text">{b.text}</p>;
    case 'status':
      return (
        <p className={cx('tcard-status', `tone-${b.tone}`)}>
          <span className="tcard-tone">{TONE[b.tone]}</span>
          {b.text}
        </p>
      );
    case 'progress': {
      const pct = Math.round((b.value / b.max) * 100);
      return (
        <div className="tcard-progress">
          <div className="tcard-progress-label">
            <span>{b.label}</span>
            <span className="tcard-faint">
              {b.value.toLocaleString()} of {b.max.toLocaleString()} ({pct}%)
            </span>
          </div>
          <progress value={b.value} max={b.max} aria-label={`${b.label}: ${b.value} of ${b.max}`} />
        </div>
      );
    }
    case 'table':
      return (
        <div className="tcard-table" role="region" aria-label={`Table: ${b.columns.join(', ')}`} tabIndex={0}>
          <table>
            <thead>
              <tr>
                {b.columns.map((c, i) => (
                  <th key={i} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.length === 0 ? (
                <tr>
                  <td colSpan={b.columns.length} className="tcard-faint">
                    No rows
                  </td>
                </tr>
              ) : (
                b.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} className={typeof c === 'number' ? 'num' : undefined}>
                        {c === null ? '—' : typeof c === 'number' ? c.toLocaleString() : c}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      );
    case 'file':
      return (
        <button className="chip-link tcard-file" onClick={() => onOpenFile(b.path)} title={`Open ${b.path} from ${bot.name}'s workspace`}>
          <FileIcon size={14} />
          <span>{b.title ?? b.path}</span>
          {b.title && <span className="tcard-faint">{b.path}</span>}
        </button>
      );
    case 'link': {
      // Checked by the server when posted; checked again here, so only an https link ever becomes one.
      if (safeLinkProblem(b.url)) return <p className="plain tcard-text">{b.label}</p>;
      const host = new URL(b.url).host;
      return (
        <a className="tcard-link" href={b.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
          <span>{b.label}</span>
          <span className="tcard-faint">{host}</span>
          <ExternalIcon size={13} />
        </a>
      );
    }
    case 'choice':
      return <p className="tcard-prompt">{b.prompt}</p>;
    case 'form':
      return b.prompt ? <p className="tcard-prompt">{b.prompt}</p> : null;
    case 'connector':
      return (
        <p className="tcard-text">
          {bot.name} asks for the connector <strong>{card.connector?.name ?? b.connectorId}</strong> <span className="tcard-faint">({b.connectorId})</span>. If you give it, it becomes one of {bot.name}'s connectors from its next
          turn, until you take it off in its settings, the same as giving it there.
        </p>
      );
  }
}

const TONE: Record<string, string> = { info: 'Note', success: 'Done', warning: 'Warning', error: 'Problem', working: 'In progress' };

function Answer({ m, bot, card, ask, now }: { m: Message; bot: RowBot; card: Card; ask: InteractiveBlock; now: number }) {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (input: CardAnswerInput) => {
    setBusy(true);
    setError(null);
    try {
      await actions.answerCard(m.botId, m.id, input);
    } catch (e) {
      setError(errorText(e));
      // Answered elsewhere, expired or refused: show how it stands now (keeps the error if it is still pending).
      actions.reloadCard(m.id).catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !online;
  const decline = (
    <button type="button" className="btn small" disabled={disabled} onClick={() => void send({ action: 'decline' })}>
      {ask.type === 'connector' ? 'Decline' : 'Decline to answer'}
    </button>
  );
  return (
    <div className="tcard-answer" aria-busy={busy}>
      {ask.type === 'choice' && (
        <div className="approval-actions" role="group" aria-label={ask.prompt}>
          {ask.options.map((o) => (
            <button key={o.id} type="button" className="btn small" disabled={disabled} onClick={() => void send({ action: 'choose', option: o.id })}>
              {o.label}
            </button>
          ))}
          {decline}
        </div>
      )}
      {ask.type === 'form' && <CardForm ask={ask} bot={bot} disabled={disabled} decline={decline} onSubmit={(values) => void send({ action: 'submit', values })} />}
      {ask.type === 'connector' && (
        <div className="approval-actions">
          <button type="button" className="btn small primary" disabled={disabled} onClick={() => void send({ action: 'grant' })}>
            Give {bot.name} {card.connector?.name ?? ask.connectorId}
          </button>
          {decline}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          Couldn't send your answer: {error}
        </p>
      )}
      {!online && <p className="hint">You're offline: answer once you're back online.</p>}
      <p className="approval-expiry" title={dateTime(card.expiresAt)}>
        Expires {relative(card.expiresAt, now)} · {bot.name} gets a turn with your answer
      </p>
    </div>
  );
}

function CardForm({ ask, bot, disabled, decline, onSubmit }: { ask: Extract<InteractiveBlock, { type: 'form' }>; bot: RowBot; disabled: boolean; decline: ReactNode; onSubmit: (v: Record<string, string | number | boolean>) => void }) {
  const base = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(ask.fields.map((f) => [f.id, f.kind === 'checkbox' ? false : ''])));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out: Record<string, string | number | boolean> = {};
    for (const f of ask.fields) {
      const v = values[f.id];
      if (typeof v === 'boolean') out[f.id] = v;
      else if (v.trim() !== '') out[f.id] = f.kind === 'number' ? Number(v) : v;
    }
    onSubmit(out);
  };
  const set = (f: CardField, v: string | boolean) => setValues((s) => ({ ...s, [f.id]: v }));
  return (
    <form className="tcard-form" onSubmit={submit}>
      {ask.fields.map((f) => {
        const id = `${base}-${f.id}`;
        if (f.kind === 'checkbox') {
          return (
            <label key={f.id} className="tcard-check" htmlFor={id}>
              <input id={id} type="checkbox" checked={values[f.id] === true} required={f.required} disabled={disabled} onChange={(e) => set(f, e.target.checked)} />
              <span>{f.label}</span>
            </label>
          );
        }
        return (
          <div key={f.id} className="tcard-field">
            <label className="field-label" htmlFor={id}>
              {f.label}
              {f.required && <span aria-hidden="true"> *</span>}
            </label>
            {f.kind === 'select' ? (
              <select id={id} value={String(values[f.id])} required={f.required} disabled={disabled} onChange={(e) => set(f, e.target.value)}>
                <option value="">Choose…</option>
                {f.options!.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.kind === 'textarea' ? (
              <textarea id={id} rows={3} value={String(values[f.id])} maxLength={f.maxLength ?? 2000} required={f.required} disabled={disabled} placeholder={f.placeholder} onChange={(e) => set(f, e.target.value)} />
            ) : (
              <input
                id={id}
                type={f.kind === 'number' ? 'number' : 'text'}
                inputMode={f.kind === 'number' ? 'decimal' : undefined}
                step={f.kind === 'number' ? 'any' : undefined}
                min={f.min}
                max={f.max}
                value={String(values[f.id])}
                maxLength={f.kind === 'text' ? (f.maxLength ?? 2000) : undefined}
                required={f.required}
                disabled={disabled}
                placeholder={f.placeholder}
                autoComplete="off"
                onChange={(e) => set(f, e.target.value)}
              />
            )}
          </div>
        );
      })}
      <p className="hint">Your answer goes to {bot.name} and stays in this chat. Never type a password, key or code here.</p>
      <div className="approval-actions">
        <button type="submit" className="btn small primary" disabled={disabled}>
          {ask.submit ?? 'Send answer'}
        </button>
        {decline}
      </div>
    </form>
  );
}

function Outcome({ card, status, bot }: { card: Card; status: Card['status']; bot: RowBot }) {
  const a = card.answer;
  const at = a ? ` · ${clock(a.at)}` : '';
  let text: string;
  switch (status) {
    case 'answered':
      text =
        a?.action === 'grant'
          ? a.result === 'already'
            ? `${bot.name} already had ${card.connector?.name ?? 'the connector'}: nothing changed`
            : `You gave ${bot.name} ${card.connector?.name ?? 'the connector'}`
          : a?.action === 'choose'
            ? `You chose “${a.option?.label ?? ''}”`
            : 'You sent your answer';
      break;
    case 'declined':
      text = 'You declined';
      break;
    case 'expired':
      text = 'Expired: nobody answered in time, so nothing was done';
      break;
    default:
      text = `Closed without doing anything: ${card.reason ?? 'it could no longer be done'}`;
  }
  return (
    <div className={cx('approval-outcome', status === 'answered' ? 'is-allowed' : status === 'expired' ? 'is-expired' : status === 'refused' ? 'is-denied' : '')} role="status">
      <span>
        {text}
        {at}
      </span>
    </div>
  );
}
