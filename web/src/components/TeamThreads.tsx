// What Botons say to each other: the conversations of a team or Direct, search across them, and the reader. All of
// it is read-only for the owner; the lead's chat is where the owner steers a team.
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TeamMessage, TeamSearchHit, TeamThread } from '../../../shared/types.ts';
import { itemStatusLine } from '../../../shared/teams.ts';
import { api } from '../api.ts';
import { attempt, errorText, showToast } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { lastLine, matchParts, MESSAGE_KIND_WORDS, messageDelivery, readUpTo, threadDeliveryNote, threadPeople } from '../team-words.ts';
import { chatHash, teamsHash } from '../teams.ts';
import { clip, clock, cx, dateTime, dayLabel, localDay, relative } from '../util.ts';
import { SearchIcon } from './Icons.tsx';
import { LoadError } from './Load.tsx';
import { Markdown } from './Markdown.tsx';
import { Row, Toggle } from './SettingRows.tsx';
import { Avatar, Loading, PageHeader, SteerLine, useNow, useTeamsLoad } from './TeamParts.tsx';

/** Kept from when Teams was turned on: asks from before are only in the two Botons' chats. */
const KEPT_FROM = 'Conversations are kept from when Teams was turned on; earlier asks are in the two Botons’ chats.';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * A search over what Botons said (messages, subjects, item titles): while it has words, its results stand in for
 * `children`. `scope`: `all` (every team and Direct), `direct`, or a team id.
 */
export function SearchBox({ scope, placeholder, children }: { scope: string; placeholder: string; children: ReactNode }) {
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  return (
    <>
      <div className="teams-search" role="search">
        <SearchIcon size={16} />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && q && (e.preventDefault(), e.stopPropagation(), setQ(''))}
          placeholder={placeholder}
          aria-label={scope === 'all' ? 'Search every team’s conversations and Direct' : scope === 'direct' ? 'Search Direct conversations' : 'Search this team’s conversations'}
        />
      </div>
      {query ? <SearchResults q={query} scope={scope} /> : children}
    </>
  );
}

/** Conversations newest first (with a search over them, unless only the newest few are shown). */
export function Conversations({ scope, limit, emptyText }: { scope: string; limit?: number; emptyText: string }) {
  const list = useStore((s) => s.threadLists[scope]);
  const threads = useStore((s) => s.teamThreads);
  const pages = useStore((s) => s.threadMessages);
  const load = useTeamsLoad(() => actions.loadThreads(scope), `threads:${scope}`);
  const now = useNow();
  const [more, setMore] = useState(false);
  const shown = (list?.ids ?? []).map((id) => threads[id]).filter((t): t is TeamThread => !!t);
  const rows = limit ? shown.slice(0, limit) : shown;
  const body = !list ? (
        load.error ? <LoadError what="the conversations" error={load.error} onRetry={load.retry} /> : <Loading what="conversations" />
      ) : rows.length === 0 ? (
        <div className="teams-empty">
          <p>{emptyText}</p>
          <p className="muted">{KEPT_FROM}</p>
        </div>
      ) : (
        <>
          <ul className="thread-list" aria-label="Conversations">
            {rows.map((t) => (
              <li key={t.id}>
                <ThreadRow thread={t} now={now} note={threadDeliveryNote(pages[t.id]?.items, t)} showTeam={scope === 'all'} />
              </li>
            ))}
          </ul>
          {!limit && list.hasMore && (
            <button
              type="button"
              className="btn small ghost load-more"
              disabled={more}
              onClick={() => {
                setMore(true);
                actions
                  .loadThreads(scope, true)
                  .catch((e) => showToast({ kind: 'error', text: `Couldn't load older conversations: ${errorText(e)}` }, 8000))
                  .finally(() => setMore(false));
              }}
            >
              {more ? 'Loading…' : 'Show older conversations'}
            </button>
          )}
        </>
      );
  return <div className="conversations">{limit ? body : <SearchBox scope={scope} placeholder="Search conversations">{body}</SearchBox>}</div>;
}

/** One conversation: who to whom, its subject and item, its last line and time; unread and an unusual delivery said in words. */
export function ThreadRow({ thread: t, now, note, showTeam }: { thread: TeamThread; now: number; note?: string | null; showTeam?: boolean }) {
  const [a, b] = t.participants;
  return (
    <a className={cx('thread-row', t.unread && 'unread')} href={teamsHash({ view: 'thread', threadId: t.id, messageId: null })}>
      <span className="thread-avatars" aria-hidden="true">
        <Avatar botId={a?.botId} size={30} />
        {b && <Avatar botId={b.botId} size={22} />}
      </span>
      <span className="thread-row-text">
        <span className="thread-row-top">
          <People text={threadPeople(t)} />
          <time className="thread-time" dateTime={t.lastAt} title={dateTime(t.lastAt)}>
            {relative(t.lastAt, now)}
          </time>
        </span>
        <span className="thread-subject">
          {t.subject}
          {t.itemTitle && t.itemTitle !== t.subject && <span className="item-chip">{clip(t.itemTitle, 40)}</span>}
          {showTeam && <span className="item-chip">{t.teamName ?? 'Direct'}</span>}
        </span>
        {t.last && <span className="thread-last">{lastLine(t)}</span>}
        {note && <span className="thread-note">{note}</span>}
      </span>
      {t.unread && (
        <span className="teams-dot" aria-hidden="true" title="Unread" />
      )}
      {t.unread && <span className="sr-only">Unread.</span>}
    </a>
  );
}

/** "Kevin → Stuart", read as "Kevin to Stuart". */
const People = ({ text }: { text: string }) => (
  <span className="thread-people">
    <span aria-hidden="true">{text}</span>
    <span className="sr-only">{text.replace(/ → /g, ' to ')}</span>
  </span>
);

function SearchResults({ q, scope }: { q: string; scope: string }) {
  const teams = useStore((s) => s.teams);
  const [result, setResult] = useState<{ q: string; hits: TeamSearchHit[] } | { q: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api.searchTeams(q, scope === 'all' ? undefined : scope).then(
      (hits) => live && setResult({ q, hits }),
      (e) => live && setResult({ q, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [q, scope, attempt]);
  if (!result || result.q !== q) return <Loading what="results" />;
  if ('error' in result) return <LoadError what="the results" error={result.error} onRetry={() => setAttempt((a) => a + 1)} />;
  const teamName = (id: string | null) => (id ? (teams?.find((t) => t.id === id)?.name ?? 'A team') : 'Direct');
  return (
    <>
      <p className="teams-count-line" role="status">
        {result.hits.length === 0 ? `Nothing matches “${q}”.` : result.hits.length === 1 ? '1 match' : `${result.hits.length >= 50 ? 'The newest 50' : result.hits.length} matches`}
      </p>
      {result.hits.length > 0 && (
        <ul className="thread-list" aria-label={`Matches for ${q}`}>
          {result.hits.map((h) => (
            <li key={`${h.threadId}:${h.messageId}`}>
              <a className="thread-row hit" href={teamsHash({ view: 'thread', threadId: h.threadId, messageId: h.messageId })}>
                <span className="thread-row-text">
                  <span className="thread-row-top">
                    <People text={h.to ? `${h.from} → ${h.to}` : h.from} />
                    <time className="thread-time" dateTime={h.at} title={dateTime(h.at)}>
                      {relative(h.at)}
                    </time>
                  </span>
                  <span className="thread-subject">
                    {h.subject}
                    <span className="item-chip">{teamName(h.teamId)}</span>
                  </span>
                  <span className="thread-last">
                    {matchParts(h.snippet, q).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Asks between Botons that share no team, and whether they may ask outside their teams at all. */
export function DirectPage() {
  const allowed = useStore((s) => s.settings?.asksOutsideTeams);
  const connected = useStore((s) => s.connected);
  const [busy, setBusy] = useState(false);
  const turn = async (on: boolean) => {
    setBusy(true);
    await attempt(on ? 'let Botons ask outside their teams' : 'keep asks within teams', () => actions.updateSettings({ asksOutsideTeams: on }));
    setBusy(false);
  };
  return (
    <>
      <PageHeader back={teamsHash({ view: 'list' })} backLabel="Back to Teams" title="Direct conversations" sub={<span className="muted">Botons asking each other outside a team</span>} />
      <div className="teams-scroll">
        <div className="teams-page">
          {typeof allowed === 'boolean' && (
            <div className="set-card">
              <Row
                label="Botons may ask Botons outside their teams"
                help={allowed ? 'Any Boton can ask any other, as it always could.' : 'Off: a Boton can ask only its teammates. These conversations stay readable.'}
                control={<Toggle label="Botons may ask Botons outside their teams" on={allowed} disabled={busy || !connected} onChange={(v) => void turn(v)} />}
              />
            </div>
          )}
          <Conversations scope="direct" emptyText="No conversations outside a team yet. When one Boton asks another that it shares no team with, it shows here." />
        </div>
      </div>
    </>
  );
}

/**
 * A conversation, read-only: its messages by seq with who wrote to whom, when, and how each request was delivered.
 * Reaching its end marks it read (on every device); opened at a message, that message is brought into view.
 */
export function ThreadPage({ threadId, messageId }: { threadId: string; messageId: string | null }) {
  const thread = useStore((s) => s.teamThreads[threadId]);
  const page = useStore((s) => s.threadMessages[threadId]);
  const team = useStore((s) => (thread?.teamId ? s.teams?.find((t) => t.id === thread.teamId) : null));
  const item = useStore((s) => (thread?.itemId ? s.teamItems[thread.itemId] : undefined));
  const connected = useStore((s) => s.connected);
  const load = useTeamsLoad(() => Promise.all([actions.loadThread(threadId), actions.loadThreadMessages(threadId)]), `thread:${threadId}`);
  const now = useNow();
  const [earlier, setEarlier] = useState(false);
  const messages = page?.items ?? [];

  // Reaching the end marks it read, while the page is in view (a message arriving at the end is read with it).
  const end = useRef<HTMLDivElement>(null);
  const atEnd = useRef(false);
  // The reader's own markup (and its end) shows once both the thread and its messages are here.
  const ready = !!thread && !!page;
  const unread = !!thread?.unread;
  const upTo = readUpTo(messages);
  const markIfRead = useRef(() => {});
  markIfRead.current = () => {
    if (!unread || !upTo || !atEnd.current || !connected) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    actions.markThreadRead(threadId, upTo);
  };
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      atEnd.current = true;
      markIfRead.current();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      atEnd.current = entries.some((e) => e.isIntersecting);
      markIfRead.current();
    });
    io.observe(el);
    const check = () => markIfRead.current();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      io.disconnect();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [ready]);
  useEffect(() => markIfRead.current(), [unread, upTo, connected]);

  // Opened at a message (a search hit): read back until it is loaded, then show it.
  const [focus, setFocus] = useState<string | null>(null);
  const tries = useRef(0);
  // Each address is acted on once: messages arriving later don't bring the view back to it.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!messageId || !page || earlier || handled.current === `${threadId}/${messageId}`) return;
    if (page.items.some((m) => m.id === messageId)) {
      handled.current = `${threadId}/${messageId}`;
      setFocus(messageId);
      return;
    }
    if (page.hasMore && tries.current < 5) {
      tries.current++;
      setEarlier(true);
      void actions.loadThreadMessages(threadId, true).finally(() => setEarlier(false));
      return;
    }
    handled.current = `${threadId}/${messageId}`;
    showToast({ kind: 'info', text: 'That message is no longer in the conversation.' });
  }, [messageId, page, earlier, threadId]);
  useLayoutEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`tmsg-${focus}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    const t = setTimeout(() => setFocus(null), 4000);
    return () => clearTimeout(t);
  }, [focus, ready]);

  const back = thread?.teamId ? teamsHash({ view: 'team', teamId: thread.teamId, tab: 'conversations' }) : teamsHash({ view: 'direct' });
  const backLabel = thread?.teamId ? `Back to ${thread.teamName ?? 'the team'}’s conversations` : 'Back to Direct conversations';

  if (!thread || !page) {
    return (
      <>
        <PageHeader back={back} backLabel={backLabel} title="Conversation" />
        <div className="teams-scroll">
          <div className="teams-page">
            {load.gone ? (
              <div className="teams-empty">
                <p>This conversation isn't kept here.</p>
                <p className="muted">{KEPT_FROM}</p>
              </div>
            ) : load.error ? (
              <LoadError what="the conversation" error={load.error} onRetry={load.retry} />
            ) : (
              <Loading what="the conversation" />
            )}
          </div>
        </div>
      </>
    );
  }

  const sub = (
    <span className="thread-context">
      {thread.teamId ? (
        <a className="chip-link" href={teamsHash({ view: 'team', teamId: thread.teamId, tab: 'work' })}>
          {thread.teamName ?? 'Team'}
        </a>
      ) : (
        <span>Direct</span>
      )}
      {thread.itemId && (
        <>
          <span aria-hidden="true">·</span>
          <a className="chip-link" href={teamsHash({ view: 'item', itemId: thread.itemId })}>
            {thread.itemTitle && thread.itemTitle !== thread.subject ? thread.itemTitle : 'Its work item'}
            {item && <span className="muted"> ({itemStatusLine(item, now, team?.lead?.name)})</span>}
          </a>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span className="thread-participants">
        {thread.participants.map((p, i) => (
          <Fragment key={p.botId}>
            {i > 0 && ', '}
            <span className="participant">
              <Avatar botId={p.botId} size={18} />
              {p.name}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );

  return (
    <>
      <PageHeader back={back} backLabel={backLabel} title={thread.subject} sub={sub} />
      <div className="teams-scroll">
        <div className="teams-page thread-page">
          {page.hasMore && (
            <button
              type="button"
              className="btn small ghost load-more"
              disabled={earlier}
              onClick={() => {
                setEarlier(true);
                actions
                  .loadThreadMessages(threadId, true)
                  .catch((e) => showToast({ kind: 'error', text: `Couldn't load earlier messages: ${errorText(e)}` }, 8000))
                  .finally(() => setEarlier(false));
              }}
            >
              {earlier ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {messages.length === 0 ? (
            <p className="muted">No messages yet.</p>
          ) : (
            <ol className="thread-messages" aria-label={`Messages in ${thread.subject}`}>
              {messages.map((m, i) => (
                <Fragment key={m.id}>
                  {(i === 0 || localDay(messages[i - 1]!.createdAt) !== localDay(m.createdAt)) && (
                    <li className="day-sep" aria-hidden="true">
                      <time dateTime={localDay(m.createdAt)}>{dayLabel(m.createdAt)}</time>
                    </li>
                  )}
                  <li>
                    <ThreadMessage m={m} focused={focus === m.id} />
                  </li>
                </Fragment>
              ))}
            </ol>
          )}
          <div ref={end} className="thread-end" />
          {thread.teamId ? (
            <SteerLine team={team ?? null} />
          ) : (
            <div className="steer-line">
              <p>This is between {thread.participants.map((p) => p.name).join(' and ')}. To step in, message one of them.</p>
              {thread.participants.map((p) => (
                <a key={p.botId} className="btn small" href={chatHash(p.botId)}>
                  <Avatar botId={p.botId} size={20} /> Message {p.name}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ThreadMessage({ m, focused }: { m: TeamMessage; focused: boolean }) {
  const delivery = messageDelivery(m);
  if (m.kind === 'system') {
    return (
      <article id={`tmsg-${m.id}`} tabIndex={-1} className={cx('thread-msg system', focused && 'focused')} aria-label={`Botons, ${dateTime(m.createdAt)}`}>
        <p>
          <span className="thread-kind">Botons</span> {m.text}{' '}
          <time dateTime={m.createdAt} title={dateTime(m.createdAt)}>
            {clock(m.createdAt)}
          </time>
        </p>
      </article>
    );
  }
  return (
    <article id={`tmsg-${m.id}`} tabIndex={-1} className={cx('thread-msg', m.kind, m.stale && 'stale', focused && 'focused')}>
      <header className="thread-msg-head">
        <Avatar botId={m.from.botId} size={26} />
        <strong>{m.from.name}</strong>
        {m.to.name && <span className="muted">to {m.to.name}</span>}
        <span className="thread-kind">{MESSAGE_KIND_WORDS[m.kind]}</span>
        <time dateTime={m.createdAt} title={dateTime(m.createdAt)}>
          {clock(m.createdAt)}
        </time>
      </header>
      {m.stale && <p className="stale-note">About a replaced assignment: it changed nothing.</p>}
      <div className="bubble">
        <Markdown text={m.text} />
      </div>
      {(delivery || (m.kind === 'request' && m.delivery?.chatMessageId)) && (
        <p className="delivery-line">
          {delivery && <span>{delivery}</span>}
          {m.kind === 'request' && m.delivery?.chatMessageId && (
            <a className="chip-link" href={chatHash(m.delivery.botId, m.delivery.chatMessageId)}>
              Open in {m.to.name}’s chat
            </a>
          )}
        </p>
      )}
    </article>
  );
}
