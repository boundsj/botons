import { useEffect, useMemo, useState } from 'react';
import type { Approval, ApprovalOrigin, Bot, Message } from '../../../shared/types.ts';
import { errorText, showToast } from '../feedback.ts';
import { actions, getState, pendingApprovals, useStore } from '../state.ts';
import { clip, clock, cx, dateTime, relative } from '../util.ts';
import { ClockIcon, ShieldIcon } from './Icons.tsx';
import { Markdown } from './Markdown.tsx';

function askedIn(from: ApprovalOrigin): string {
  if (from.trigger === 'chat') return from.askedBy.length ? `a chat turn, answering ${from.askedBy.join(' and ')}` : 'a chat turn';
  return `a ${from.trigger === 'schedule' ? 'scheduled' : from.trigger} run of`;
}

export function useWaiting(): Approval[] {
  const map = useStore((s) => s.approvals);
  return useMemo(() => pendingApprovals(map), [map]);
}

/** What a chat row knows of its Boton: the rows are memoized, so nothing that changes during a turn. */
export type RowBot = Pick<Bot, 'id' | 'name' | 'workspace'>;

export function ApprovalCard({ bot, m, onOpenRoutine }: { bot: RowBot; m: Message; onOpenRoutine: (id: string) => void }) {
  const id = m.meta?.approvalId ?? '';
  const a = useStore((s) => (id ? s.approvals[id] : undefined));
  const [failed, setFailed] = useState<string | null>(null);
  // The chat loads all of its requests; only one still missing after that is fetched on its own.
  useEffect(() => {
    if (!id || a) return;
    const t = setTimeout(() => {
      if (!getState().approvals[id]) actions.loadApproval(id).catch((e) => setFailed(errorText(e)));
    }, 800);
    return () => clearTimeout(t);
  }, [id, a]);

  if (!a) {
    return (
      <div className="approval-card loading" id={`approval-${id}`} aria-busy={!failed}>
        <div className="approval-head">
          <ShieldIcon size={16} />
          <span>{bot.name} asks for your approval</span>
        </div>
        <p className="approval-title">{m.meta?.approvalTitle ?? m.text}</p>
        <p className="hint">{failed ? `Couldn't load this request: ${failed}` : 'Loading…'}</p>
      </div>
    );
  }
  const skill = a.kind === 'skill';
  return (
    <div className={cx('approval-card', `is-${a.status}`, a.from.sandboxed && 'outside')} id={`approval-${a.id}`} role="group" aria-label={`Approval request: ${a.title}`}>
      <div className="approval-head">
        <ShieldIcon size={16} />
        <span>{skill ? `${bot.name} saved a skill for your approval` : `${bot.name} asks for your approval`}</span>
        <span className="approval-time" title={dateTime(a.createdAt)}>
          {clock(a.createdAt)}
        </span>
      </div>
      <p className="approval-title">{a.title}</p>
      {a.tool && (
        <>
          <p className="approval-rule">
            {a.tool.browser ? (
              <>
                {bot.name}'s browser is holding a request the page tried to send after {bot.name} clicked or typed. Exactly this is sent, once, if you allow it while{' '}
                {bot.name} waits. Labels and text from the page are the site's own, not proof of what it does:
              </>
            ) : a.tool.rule ? (
              <>
                A tool call your Ask first rule <code>{a.tool.rule}</code> paused. Exactly this runs if you allow it:
              </>
            ) : (
              <>A tool call Claude Code asked about (none of your Ask first rules names it). Exactly this runs if you allow it:</>
            )}
          </p>
          <pre className="approval-call" tabIndex={0}>
            {a.details}
          </pre>
        </>
      )}
      {!a.tool &&
        a.details &&
        // From a webhook run, as written: Markdown could hide text (a link's address, say).
        (a.from.sandboxed ? (
          <p className="approval-details plain">{a.details}</p>
        ) : (
          <div className="approval-details">
            <Markdown text={a.details} />
          </div>
        ))}
      {a.followUp && (
        // Never folded away: if allowed, this text (not the title) is what the Boton is told to do.
        <div className="approval-then">
          <p className="approval-then-label">
            {a.from.sandboxed ? `Exactly what ${bot.name} will be told to do, with its usual access and connectors:` : `What ${bot.name} will be told to do once allowed:`}
          </p>
          <p className="plain" tabIndex={a.followUp.length > 600 ? 0 : undefined}>
            {a.followUp}
          </p>
        </div>
      )}
      <p className="approval-origin">
        {skill ? 'Saved' : 'Asked'} in {askedIn(a.from)}
        {a.from.routineId && (
          <button className="chip-link" onClick={() => onOpenRoutine(a.from.routineId!)}>
            <ClockIcon size={14} />
            {a.from.routineName ?? 'a routine'}
          </button>
        )}
        {a.from.trigger === 'test' && <span> (a test run: it pushes nothing)</span>}
      </p>
      {a.from.sandboxed && (
        <p className="approval-warn">
          {a.tool
            ? `${bot.name} made this call during a webhook run, whose payload came from outside: read all of it before you allow it.`
            : `It was written during a webhook run, whose payload came from outside. If you allow it, ${bot.name} does ${a.followUp ? 'the text above' : 'what the title and details say'} with its usual access and connectors, so read all of it.`}
        </p>
      )}
      {a.status === 'pending' ? <Decide a={a} bot={bot} skill={skill} /> : <Outcome a={a} bot={bot} />}
    </div>
  );
}

function Decide({ a, bot, skill }: { a: Approval; bot: RowBot; skill: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [busy, setBusy] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const decide = async (decision: 'allow' | 'deny', always = false) => {
    setBusy(true);
    try {
      await actions.decideApproval(a.id, { decision, ...(always ? { always } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    } catch (e) {
      showToast({ kind: 'error', text: `Couldn't ${decision} “${a.title}”: ${errorText(e)}` }, 8000);
      // Decided elsewhere, or expired: show how it stands now.
      actions.loadApproval(a.id).catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {noting && (
        <textarea
          className="approval-note"
          rows={2}
          maxLength={2000}
          value={note}
          autoFocus
          placeholder={`A note for ${bot.name} with your decision (optional)`}
          aria-label={`Note for ${bot.name}`}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="approval-actions">
        <button className="btn small primary" disabled={busy} onClick={() => void decide('allow')}>
          {skill ? 'Approve for every Boton' : a.kind === 'connector' ? 'Allow' : 'Allow once'}
        </button>
        {a.action && (
          <button
            className="btn small"
            disabled={busy}
            onClick={() => void decide('allow', true)}
            title={a.tool ? `Allow this, and from now on let ${bot.name} make the calls “${a.tool.rule}” covers without asking` : `Allow this, and from now on let ${bot.name} do “${a.action}” without asking`}
          >
            Always allow “{a.tool?.rule ?? a.action}”
          </button>
        )}
        <button className="btn small danger" disabled={busy} onClick={() => void decide('deny')}>
          {skill ? `Keep it ${bot.name}'s` : 'Deny'}
        </button>
        {!noting && (
          <button className="link-btn" onClick={() => setNoting(true)}>
            Add a note
          </button>
        )}
      </div>
      {a.tool && new Date(a.tool.waitUntil).getTime() > now ? (
        <p className="approval-expiry is-waiting" title={dateTime(a.tool.waitUntil)}>
          {bot.name} is waiting for your answer, until {clock(a.tool.waitUntil)}. After that it carries on without {a.tool.browser ? 'sending it' : 'this call'}.
        </p>
      ) : (
        a.expiresAt && (
          <p className="approval-expiry" title={dateTime(a.expiresAt)}>
            {new Date(a.expiresAt).getTime() <= now ? 'Expiring…' : `Expires ${relative(a.expiresAt, now)}`} ·{' '}
            {a.tool ? `${bot.name} stopped waiting: if you allow it, ${bot.name} gets a turn in which this call is allowed once` : `${bot.name} gets a turn with your decision`}
          </p>
        )
      )}
      {skill && <p className="approval-expiry">Until you approve it, only {bot.name} can use it.</p>}
    </>
  );
}

function Outcome({ a, bot }: { a: Approval; bot: RowBot }) {
  const at = a.decidedAt ? ` · ${clock(a.decidedAt)}` : '';
  let text: string;
  switch (a.status) {
    case 'allowed': {
      const rule = a.tool?.rule ?? a.action;
      text = a.auto ? `Allowed without asking: “${rule}” is always allowed` : a.kind === 'skill' ? 'Approved for every Boton' : a.always ? `Allowed, and “${rule}” from now on` : 'Allowed';
      if (a.tool?.browser) {
        const d = a.tool.usedAt ? a.tool.delivery : null;
        text =
          d === 'sent'
            ? 'Allowed: sent once'
            : d === 'unknown'
              ? 'Allowed and sent, but the connection broke before the site answered: it may have arrived. Check on the site before asking for it again'
              : d === 'sending'
                ? 'Allowed: sending. If this stays, the server stopped mid-send and it may have arrived: check on the site'
                : d === 'not-sent'
                ? 'Allowed, but not sent: it failed before it left'
                  : 'Allowed, but not sent: the page, its cookies, the browser or the sites changed first';
      }
      else if (a.tool && !a.auto) text += a.tool.inTurn ? `: ${bot.name} went ahead` : a.tool.usedAt ? `: ${bot.name} made the call in a later turn` : `: ${bot.name} gets a turn to make the call`;
      break;
    }
    case 'denied':
      text = a.kind === 'skill' ? `Kept as ${bot.name}'s own` : a.tool?.browser ? 'Denied: not sent' : a.tool?.inTurn ? `Denied: ${bot.name}'s call failed` : 'Denied';
      break;
    case 'expired':
      text = 'Expired: nobody decided in time, so nothing was done';
      break;
    default:
      text = a.kind === 'skill' ? 'The skill was deleted' : a.tool?.browser ? 'Withdrawn: the browser step ended first, so nothing was sent' : `Withdrawn by ${bot.name}`;
  }
  return (
    <div className={cx('approval-outcome', `is-${a.status}`)} role="status">
      <span>
        {text}
        {at}
      </span>
      {a.note && <span className="chip-quote">“{a.note}”</span>}
    </div>
  );
}

export function DecisionChip({ m }: { m: Message }) {
  const allowed = m.meta?.decision === 'allowed';
  const title = m.meta?.approvalTitle ?? '';
  return (
    <div className={cx('event-chip decision', !allowed && 'warn')} title={dateTime(m.createdAt)}>
      <span>{allowed ? 'You allowed' : 'You denied'}</span>
      <span className="chip-title">“{clip(title, 80)}”</span>
      {m.meta?.note && <span className="chip-quote">“{clip(m.meta.note, 60)}”</span>}
    </div>
  );
}

export function WaitingBar({ bot }: { bot: Bot }) {
  const waiting = useWaiting().filter((a) => a.botId === bot.id);
  if (!waiting.length) return null;
  const first = waiting[0];
  const show = () => {
    const el = document.getElementById(`approval-${first.id}`);
    if (el) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    else showToast({ kind: 'info', text: 'The request is further up the chat: scroll up (Load earlier messages) to find it.' });
  };
  return (
    <div className="approvals-bar" role="status">
      <ShieldIcon size={16} />
      <span>
        <strong>{waiting.length === 1 ? 'Waiting for your approval:' : `${waiting.length} requests wait for your approval. The first:`}</strong> {first.title}
      </span>
      <button className="btn small" onClick={show}>
        Show
      </button>
    </div>
  );
}
