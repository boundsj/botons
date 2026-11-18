// Teams, in the main column where a chat goes: the list (what needs the owner first), a team's Work, Conversations
// and Team tabs, an item with the owner's actions, and the thread reader (TeamThreads.tsx). Loaded when first opened.
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Team, TeamItem, TeamItemActionInput, TeamSeat } from '../../../shared/types.ts';
import { DEFAULT_LOOK } from '../../../shared/look.ts';
import { boardGroup, itemStatusLine, TEAM_LIFETIME, TEAM_LIMITS, TEAM_TEXT } from '../../../shared/teams.ts';
import { ApiError } from '../api.ts';
import { attempt, errorText, showToast } from '../feedback.ts';
import { actions, getState, useStore } from '../state.ts';
import {
  actionKey,
  type BoardGroup,
  boardGroups,
  countsLine,
  eventText,
  evidenceText,
  firstLine,
  LIMIT_FIELDS,
  limitBoundsOf,
  limitDraft,
  limitsPatch,
  needsYou,
  type NeedsYou,
  OWNER_ACTION_WORDS,
  type OwnerItemAction,
  ownerActions,
  ownerActionsNote,
  seatStateText,
  stateChanges,
} from '../team-words.ts';
import { chatHash, itemsOf, rosterOrder, teamsHash, type TeamsRoute, type TeamsTab } from '../teams.ts';
import { clip, cx, dateTime, relative } from '../util.ts';
import { avatarState, BotonAvatar } from './Avatar.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { AlertIcon, EditIcon, PauseIcon, PeopleIcon, PlayIcon, PlusIcon, StopIcon } from './Icons.tsx';
import { LoadError } from './Load.tsx';
import { Markdown } from './Markdown.tsx';
import { More, Row, Section } from './SettingRows.tsx';
import { TeamEditor } from './TeamEditor.tsx';
import { Avatar, Loading, PageHeader, StateChip, SteerLine, useAnnouncer, useNow, useTeamsLoad } from './TeamParts.tsx';
import { Conversations, DirectPage, SearchBox, ThreadPage } from './TeamThreads.tsx';

export function TeamsView({ route, onBack }: { route: TeamsRoute; onBack: () => void }) {
  const teams = useStore((s) => s.teams);
  const load = useTeamsLoad(() => actions.loadTeams(), 'teams');
  const [announcer, announce] = useAnnouncer();
  // A team paused, stopped or finished out of sight (a budget ran out, another device) is said once.
  const seen = useRef(teams);
  useEffect(() => {
    for (const text of stateChanges(seen.current, teams)) announce(text);
    seen.current = teams;
  }, [teams]);
  // The team as it was when the editor opened: saving with its version is refused if it changed meanwhile.
  const [editor, setEditor] = useState<{ team: Team | null } | null>(null);

  // A new screen: its heading takes focus, so a screen reader says where it is (a tab change keeps focus on its tab).
  const main = useRef<HTMLElement>(null);
  const place = route.view === 'team' ? `team:${route.teamId}` : route.view === 'thread' ? `thread:${route.threadId}` : route.view === 'item' ? `item:${route.itemId}` : route.view;
  useEffect(() => {
    main.current?.querySelector<HTMLElement>('.teams-title')?.focus({ preventScroll: true });
  }, [place]);

  const view =
    route.view === 'team' ? (
      <TeamPage key={route.teamId} teamId={route.teamId} tab={route.tab} onEdit={(team) => setEditor({ team })} />
    ) : route.view === 'direct' ? (
      <DirectPage />
    ) : route.view === 'thread' ? (
      <ThreadPage key={route.threadId} threadId={route.threadId} messageId={route.messageId} />
    ) : route.view === 'item' ? (
      <ItemPage key={route.itemId} itemId={route.itemId} />
    ) : (
      <TeamsHome load={load} onBack={onBack} onNew={() => setEditor({ team: null })} />
    );
  return (
    <main className="teams-main" aria-label="Teams" ref={main}>
      {announcer}
      {view}
      {editor && (
        <TeamEditor
          team={editor.team}
          onClose={() => setEditor(null)}
          onSaved={(t) => {
            const made = !editor.team;
            setEditor(null);
            if (made) location.hash = teamsHash({ view: 'team', teamId: t.id, tab: 'work' });
            showToast({ kind: 'info', text: made ? `Made ${t.name}. ${t.lead ? `${t.lead.name} plans the work next.` : ''}`.trim() : `Saved ${t.name}.` });
          }}
        />
      )}
    </main>
  );
}

// ------------------------------------------------------------------ the list

function TeamsHome({ load, onBack, onNew }: { load: ReturnType<typeof useTeamsLoad>; onBack: () => void; onNew: () => void }) {
  const teams = useStore((s) => s.teams);
  const items = useStore((s) => s.teamItems);
  const now = useNow();
  const ids = { needs: useId(), teams: useId(), direct: useId() };
  // The items behind a team's attention are on its board: those boards are read, once each (live after that).
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const t of teams ?? []) {
      if (t.attention === 0 || t.state === 'archived' || asked.current.has(t.id) || getState().teamBoards[t.id]) continue;
      asked.current.add(t.id);
      void actions.loadTeam(t.id).catch(() => asked.current.delete(t.id));
    }
  }, [teams]);
  const needs = useMemo(() => (teams ? needsYou(teams, items, now) : []), [teams, items, now]);
  const live = teams?.filter((t) => t.state !== 'archived') ?? [];
  const archived = teams?.filter((t) => t.state === 'archived') ?? [];
  return (
    <>
      <PageHeader back={onBack} backLabel="Back to Botons" mobileBackOnly title="Teams">
        <button type="button" className="btn small primary" onClick={onNew}>
          <PlusIcon size={15} /> New team
        </button>
      </PageHeader>
      <div className="teams-scroll">
        <div className="teams-page">
          {!teams ? (
            load.error ? (
              <LoadError what="Teams" error={load.error} onRetry={load.retry} />
            ) : (
              <Loading what="teams" />
            )
          ) : (
            <SearchBox scope="all" placeholder="Search every conversation">
              {needs.length > 0 && (
                <section className="teams-section needs-you" aria-labelledby={ids.needs}>
                  <h2 id={ids.needs}>Needs you</h2>
                  <ul className="needs-list">
                    {needs.map((n) => (
                      <li key={n.key}>
                        <NeedsRow n={n} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {teams.length === 0 ? (
                <div className="teams-empty intro">
                  <PeopleIcon size={30} />
                  <h2>Botons can work as a team</h2>
                  <p>A team is a few Botons with one goal: one of them leads, splits the goal into work and checks the results, and each of the others owns its part.</p>
                  <p>You can read everything they say to each other, and they come to you only when something needs you.</p>
                  <button type="button" className="btn primary" onClick={onNew}>
                    <PlusIcon size={16} /> New team
                  </button>
                </div>
              ) : (
                <section className="teams-section" aria-labelledby={ids.teams}>
                  <h2 id={ids.teams}>Teams</h2>
                  <ul className="team-cards">
                    {live.map((t) => (
                      <li key={t.id}>
                        <TeamCard team={t} />
                      </li>
                    ))}
                  </ul>
                  {archived.length > 0 && (
                    <details className="archived-teams">
                      <summary>Archived ({archived.length})</summary>
                      <ul className="team-cards">
                        {archived.map((t) => (
                          <li key={t.id}>
                            <TeamCard team={t} />
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              )}
              <section className="teams-section" aria-labelledby={ids.direct}>
                <div className="teams-section-head">
                  <h2 id={ids.direct}>Direct conversations</h2>
                  <a className="link-btn" href={teamsHash({ view: 'direct' })}>
                    All and search
                  </a>
                </div>
                <Conversations scope="direct" limit={3} emptyText="No conversations outside a team yet: when one Boton asks another it shares no team with, it shows here." />
              </section>
            </SearchBox>
          )}
        </div>
      </div>
    </>
  );
}

function NeedsRow({ n }: { n: NeedsYou }) {
  const href = n.kind === 'item' ? teamsHash({ view: 'item', itemId: n.item.id }) : teamsHash({ view: 'team', teamId: n.team.id, tab: n.team.state === 'done' ? 'team' : 'work' });
  return (
    <a className="needs-row" href={href}>
      <AlertIcon size={18} className="needs-icon" />
      <span className="needs-text">
        <span className="needs-title">{n.kind === 'item' ? n.item.title : n.team.name}</span>
        <span className="needs-why">
          {n.kind === 'item' && `${n.team.name} · `}
          {n.why}
        </span>
      </span>
    </a>
  );
}

function TeamCard({ team: t }: { team: Team }) {
  const members = rosterOrder(t.members);
  const others = members.filter((m) => m.role !== 'lead').map((m) => m.name);
  const said = [t.attention > 0 && (t.attention === 1 ? '1 thing needs you' : `${t.attention} things need you`), t.unreadThreads > 0 && (t.unreadThreads === 1 ? '1 unread conversation' : `${t.unreadThreads} unread conversations`)].filter(Boolean);
  return (
    <a className={cx('team-card', t.attention > 0 && 'needs')} href={teamsHash({ view: 'team', teamId: t.id, tab: 'work' })}>
      <span className="team-card-head">
        <span className="team-card-name">{t.name}</span>
        <StateChip team={t} />
        {t.attention > 0 ? (
          <span className="teams-count" aria-hidden="true">
            {t.attention}
          </span>
        ) : (
          t.unreadThreads > 0 && <span className="teams-dot" aria-hidden="true" />
        )}
        {said.length > 0 && <span className="sr-only">{said.join(', ')}.</span>}
      </span>
      {t.goal && <span className="team-card-goal">{firstLine(t.goal)}</span>}
      <span className="team-card-foot">
        <span className="avatar-stack" aria-hidden="true">
          {members.slice(0, 5).map((m) => (
            <Avatar key={m.botId} botId={m.botId} size={m.role === 'lead' ? 28 : 22} />
          ))}
        </span>
        <span className="team-card-people">
          {t.lead ? `${t.lead.name} leads` : 'No lead'}
          {others.length > 0 && `, with ${others.join(', ')}`}
        </span>
        <span className="team-card-counts">{countsLine(t.counts)}</span>
      </span>
    </a>
  );
}

// ------------------------------------------------------------------ a team

const TAB_LABELS: Record<TeamsTab, string> = { work: 'Work', conversations: 'Conversations', team: 'Team' };

function TeamPage({ teamId, tab, onEdit }: { teamId: string; tab: TeamsTab; onEdit: (t: Team) => void }) {
  const team = useStore((s) => s.teams?.find((t) => t.id === teamId));
  const load = useTeamsLoad(() => actions.loadTeam(teamId), `team:${teamId}`);
  const tabsId = useId();
  if (!team) {
    return (
      <>
        <PageHeader back={teamsHash({ view: 'list' })} backLabel="Back to Teams" title="Team" />
        <div className="teams-scroll">
          <div className="teams-page">
            {load.gone ? <p className="teams-empty">This team isn't here any more: it was deleted.</p> : load.error ? <LoadError what="the team" error={load.error} onRetry={load.retry} /> : <Loading what="the team" />}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader
        back={teamsHash({ view: 'list' })}
        backLabel="Back to Teams"
        title={team.name}
        sub={
          <>
            <StateChip team={team} />
            <span className="muted">{countsLine(team.counts)}</span>
          </>
        }
      />
      <TeamTabs team={team} tab={tab} id={tabsId} />
      <div className="teams-scroll" role="tabpanel" id={`${tabsId}-${tab}`} aria-labelledby={`${tabsId}-${tab}-tab`}>
        <div className="teams-page">
          <TeamBanner team={team} tab={tab} />
          {tab === 'work' && <WorkTab team={team} load={load} />}
          {tab === 'conversations' && <Conversations scope={team.id} emptyText="No conversations in this team yet: the lead's requests and the replies show here." />}
          {tab === 'team' && <TeamTab team={team} onEdit={() => onEdit(team)} />}
        </div>
      </div>
    </>
  );
}

/** A real tablist: arrows, Home and End move between the tabs, and only the chosen one is in the tab order. */
function TeamTabs({ team, tab, id }: { team: Team; tab: TeamsTab; id: string }) {
  const keys: TeamsTab[] = ['work', 'conversations', 'team'];
  // What needs the owner goes on the tab that has it: the review of a finished team, a leaderless or spent team on
  // Team, the rest (items) on Work. A number there; unread conversations only get a dot. Both said in words.
  const onTeam = (team.state === 'done' && !team.reviewedAt) || (team.state === 'paused' && (team.pausedReason === 'budget' || team.pausedReason === 'no_lead')) ? 1 : 0;
  const onWork = Math.max(0, team.attention - onTeam);
  const needs = (n: number) => (n === 1 ? '1 needs you' : `${n} need you`);
  const marks: Partial<Record<TeamsTab, { count: number | null; said: string }>> = {
    ...(onWork > 0 && { work: { count: onWork, said: needs(onWork) } }),
    ...(team.unreadThreads > 0 && { conversations: { count: null, said: 'unread' } }),
    ...(onTeam > 0 && { team: { count: 1, said: team.state === 'done' ? 'finished, review it' : 'needs you' } }),
  };
  const go = (k: TeamsTab) => {
    location.hash = teamsHash({ view: 'team', teamId: team.id, tab: k });
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: keys.length - 1 } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const k = keys[(to + keys.length) % keys.length]!;
    go(k);
    requestAnimationFrame(() => document.getElementById(`${id}-${k}-tab`)?.focus());
  };
  return (
    <div className="teams-tabs-row">
      <div className="tabs teams-tabs" role="tablist" aria-label={team.name}>
        {keys.map((k, i) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`${id}-${k}-tab`}
            aria-selected={tab === k}
            aria-controls={tab === k ? `${id}-${k}` : undefined}
            tabIndex={tab === k ? 0 : -1}
            className={cx('tab', tab === k && 'on')}
            aria-label={marks[k] ? `${TAB_LABELS[k]}, ${marks[k]!.said}` : undefined}
            onClick={() => go(k)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {TAB_LABELS[k]}
            {marks[k] && (
              <>
                {marks[k]!.count === null ? (
                  <span className="tab-mark" aria-hidden="true" />
                ) : (
                  <span className="teams-count tab-count" aria-hidden="true">
                    {marks[k]!.count}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Why a team isn't doing anything, in words, with what puts it right. */
function TeamBanner({ team, tab }: { team: Team; tab: TeamsTab }) {
  const [busy, setBusy] = useState(false);
  const online = useStore((s) => s.connected);
  if (team.state === 'active') return null;
  const resume = async () => {
    setBusy(true);
    await attempt(`resume ${team.name}`, () => actions.setTeamState(team, { state: 'active' }));
    setBusy(false);
  };
  const why =
    team.state === 'done'
      ? team.reviewedAt
        ? 'You reviewed it. Reopen it to carry on, or archive it.'
        : `${team.completion?.by.name ?? 'The lead'} says the work is done. Read what it did and what was left out, then mark it reviewed.`
      : team.state === 'archived'
        ? 'It does nothing now. Its conversations stay readable.'
        : team.pausedReason === 'budget'
          ? 'It used up a daily budget of messages or check-ins. Nothing is sent and the lead gets no check-ins until you resume it.'
          : team.pausedReason === 'no_lead'
            ? 'It has no lead to wake. Give it one in Edit team, then resume it.'
            : team.pausedReason === 'stopped'
              ? 'You stopped its work: what was being worked on is blocked until you look at it. Resume it when you are ready.'
              : 'Nothing is sent and the lead gets no check-ins until you resume it.';
  return (
    <div className={cx('team-banner', (team.pausedReason === 'budget' || team.pausedReason === 'no_lead' || (team.state === 'done' && !team.reviewedAt)) && 'warn')} role="status">
      <span>
        <strong>{team.state === 'done' ? (team.reviewedAt ? 'Finished.' : 'Finished, review it.') : team.state === 'archived' ? 'Archived.' : `${team.pausedReason === 'stopped' ? 'Stopped' : 'Paused'}.`}</strong> {why}
      </span>
      {team.state === 'paused' && team.pausedReason !== 'no_lead' && (
        <button type="button" className="btn small" disabled={busy || !online} onClick={() => void resume()}>
          <PlayIcon size={14} /> Resume
        </button>
      )}
      {team.state === 'done' && tab !== 'team' && (
        <a className="btn small" href={teamsHash({ view: 'team', teamId: team.id, tab: 'team' })}>
          Review it
        </a>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Work

function WorkTab({ team, load }: { team: Team; load: ReturnType<typeof useTeamsLoad> }) {
  const all = useStore((s) => s.teamItems);
  const loaded = useStore((s) => !!s.teamBoards[team.id]);
  const online = useStore((s) => s.connected);
  const items = useMemo(() => itemsOf(all, team.id), [all, team.id]);
  const groups = useMemo(() => boardGroups(items), [items]);
  const now = useNow();
  const [adding, setAdding] = useState(false);
  if (!loaded) return load.error ? <LoadError what="the work" error={load.error} onRetry={load.retry} /> : <Loading what="the work" />;
  return (
    <>
      {(team.state === 'active' || team.state === 'paused') && (
        <div className="work-head">
          <button type="button" className="btn small" disabled={!online} onClick={() => setAdding(true)}>
            <PlusIcon size={15} /> Add work
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <div className="teams-empty">
          <p>No work yet.</p>
          <p className="muted">
            {team.lead ? `${team.lead.name} plans it: when the team starts, it gets a check-in to turn the goal into work and hand it out.` : 'Give the team a lead to plan its work.'} You can add work yourself too.
          </p>
        </div>
      ) : (
        groups.map((g) => <BoardSection key={g.key} group={g} team={team} now={now} />)
      )}
      {adding && <AddItemDialog team={team} onClose={() => setAdding(false)} />}
    </>
  );
}

function BoardSection({ group, team, now }: { group: BoardGroup; team: Team; now: number }) {
  const hid = useId();
  const rows = (
    <ul className="item-list" aria-labelledby={hid}>
      {group.items.map((i) => (
        <li key={i.id}>
          <ItemRow item={i} team={team} now={now} />
        </li>
      ))}
    </ul>
  );
  const title = (
    <>
      <span id={hid}>{group.label}</span> <span className="group-count">{group.items.length}</span>
    </>
  );
  if (group.key === 'done') {
    return (
      <details className="board-group">
        <summary className="board-title">{title}</summary>
        {rows}
      </details>
    );
  }
  return (
    <section className={cx('board-group', group.key === 'needs_you' && 'needs')}>
      <h2 className="board-title">{title}</h2>
      {rows}
    </section>
  );
}

function ItemRow({ item, team, now }: { item: TeamItem; team: Team; now: number }) {
  const status = itemStatusLine(item, now, team.lead?.name);
  return (
    <a className={cx('item-row', boardGroup(item) === 'needs_you' && 'needs')} href={teamsHash({ view: 'item', itemId: item.id })}>
      {item.assigneeBotId ? <Avatar botId={item.assigneeBotId} size={30} /> : <span className="avatar-gap" aria-hidden="true" />}
      <span className="item-row-text">
        <span className="item-row-title">{item.title}</span>
        <span className="item-row-status">
          {item.assigneeName && `${item.assigneeName} · `}
          {status}
        </span>
      </span>
    </a>
  );
}

function AddItemDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [assignee, setAssignee] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(actionKey, []);
  const id = useId();
  const who = team.members.find((m) => m.botId === assignee)?.name;
  const save = async () => {
    if (!title.trim()) return setProblem('Give it a title.');
    setBusy(true);
    const ok = await attempt('add the work', () => actions.addTeamItem(team.id, { title: title.trim(), detail: detail.trim() || undefined, assigneeBotId: assignee || null, key }));
    setBusy(false);
    if (!ok) return;
    onClose();
    showToast({ kind: 'info', text: who ? `Added it, and asked ${who} to do it.` : `Added it to ${team.name}'s work.` });
  };
  return (
    <Dialog title={`Add work to ${team.name}`} onClose={() => !busy && onClose()}>
      <form
        className="team-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span className="field-label">Title</span>
          <input data-autofocus value={title} maxLength={TEAM_TEXT.itemTitle} onChange={(e) => (setTitle(e.target.value), setProblem(null))} aria-invalid={!!problem || undefined} aria-describedby={problem ? `${id}-problem` : undefined} />
        </label>
        <label>
          <span className="field-label">Detail (optional)</span>
          <textarea rows={4} value={detail} maxLength={TEAM_TEXT.itemDetail} onChange={(e) => setDetail(e.target.value)} placeholder="What done looks like, and anything it needs to know." />
        </label>
        <label>
          <span className="field-label">Give it to</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">No one yet: the lead decides</option>
            {rosterOrder(team.members).map((m) => (
              <option key={m.botId} value={m.botId}>
                {m.name}
                {m.roleTitle ? ` (${m.roleTitle})` : ''}
              </option>
            ))}
          </select>
          {who && <span className="hint">{who} gets a request for it now.</span>}
        </label>
        {problem && (
          <p className="form-error" id={`${id}-problem`} role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add work'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ an item

/** A name for who did something: the owner, a member, or a Boton the page knows. */
function useWho(team: Team | undefined) {
  const bots = useStore((s) => s.bots);
  return (id: string | null) => {
    if (!id) return null;
    if (id === 'owner') return 'you';
    return team?.members.find((m) => m.botId === id)?.name ?? bots.find((b) => b.id === id)?.name ?? 'a Boton';
  };
}

function ItemPage({ itemId }: { itemId: string }) {
  const item = useStore((s) => s.teamItems[itemId]);
  const events = useStore((s) => s.itemEvents[itemId]);
  const team = useStore((s) => (item ? s.teams?.find((t) => t.id === item.teamId) : undefined));
  const online = useStore((s) => s.connected);
  const load = useTeamsLoad(() => actions.loadTeamItem(itemId), `item:${itemId}`);
  const who = useWho(team);
  const now = useNow();
  const [action, setAction] = useState<OwnerItemAction | null>(null);
  const ids = { facts: useId(), history: useId(), escalation: useId() };
  // Its history moves on with it: a new version (from here or anywhere) reads it again.
  const version = item?.version;
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current !== undefined && version !== undefined && version !== seenVersion.current) void actions.loadTeamItem(itemId).catch(() => {});
    seenVersion.current = version;
  }, [version, itemId]);

  const back = item ? teamsHash({ view: 'team', teamId: item.teamId, tab: 'work' }) : teamsHash({ view: 'list' });
  const backLabel = team ? `Back to ${team.name}` : 'Back to Teams';
  if (!item) {
    return (
      <>
        <PageHeader back={back} backLabel={backLabel} title="Work item" />
        <div className="teams-scroll">
          <div className="teams-page">
            {load.gone ? <p className="teams-empty">This item isn't here any more: its team was deleted.</p> : load.error ? <LoadError what="the item" error={load.error} onRetry={load.retry} /> : <Loading what="the item" />}
          </div>
        </div>
      </>
    );
  }
  const status = itemStatusLine(item, now, team?.lead?.name);
  const esc = item.escalation;
  const escBot = esc ? (who(esc.botId) ?? 'the lead') : null;
  const history = [...(events ?? [])].sort((a, b) => b.seq - a.seq);
  return (
    <>
      <PageHeader
        back={back}
        backLabel={backLabel}
        title={item.title}
        sub={
          <>
            {team && (
              <a className="chip-link" href={teamsHash({ view: 'team', teamId: team.id, tab: 'work' })}>
                {team.name}
              </a>
            )}
            <span className={cx('item-status', boardGroup(item) === 'needs_you' && 'warn')}>{status}</span>
          </>
        }
      />
      <div className="teams-scroll">
        <div className="teams-page item-page">
          {esc && (
            <section className="escalation" aria-labelledby={ids.escalation}>
              <h2 id={ids.escalation}>{esc.by === 'server' ? 'Botons escalated this to you' : `${escBot} escalated this to you`}</h2>
              <p>{esc.summary}</p>
              <p>
                <strong>Needs from you:</strong> {esc.need}
              </p>
              <p className="muted">
                {esc.by === 'server' ? 'The lead got check-ins about it and nothing moved, so the server brought it to you.' : 'The lead tried what it could first; the evidence below is what the server recorded.'}{' '}
                {relative(esc.at, now)}.
              </p>
              <a className="btn primary small" href={chatHash(esc.botId, esc.cardMessageId)}>
                Answer in {escBot}’s chat
              </a>
            </section>
          )}
          {item.held && !esc && (
            <div className="team-banner warn" role="status">
              <span>
                <strong>Held for you.</strong> It reached a limit on how often it may be tried or checked on, so nothing more happens to it until you act: reassign it, try again, mark it done or cancel it.
              </span>
            </div>
          )}

          <section className="item-facts" aria-labelledby={ids.facts}>
            <h2 className="sr-only" id={ids.facts}>
              About this item
            </h2>
            <dl>
              <dt>Status</dt>
              <dd>{status}</dd>
              <dt>Assigned to</dt>
              <dd>
                {item.assigneeBotId ? (
                  <a className="chip-link" href={chatHash(item.assigneeBotId)}>
                    <Avatar botId={item.assigneeBotId} size={20} />
                    {item.assigneeName ?? who(item.assigneeBotId)}
                  </a>
                ) : (
                  'No one'
                )}
              </dd>
              {item.status === 'blocked' && item.blockedReason && (
                <>
                  <dt>Blocked</dt>
                  <dd>
                    {item.blockedReason} <span className="muted">({item.blockedNeed === 'owner' ? 'needs you' : `needs ${team?.lead?.name ?? 'the lead'}`})</span>
                  </dd>
                </>
              )}
              {item.result && (
                <>
                  <dt>Result</dt>
                  <dd>
                    <Markdown text={item.result} />
                  </dd>
                </>
              )}
              {item.status === 'cancelled' && (
                <>
                  <dt>Cancelled</dt>
                  <dd>
                    {item.closedReason || 'No reason given'} <span className="muted">(by {who(item.closedBy) ?? 'someone'})</span>
                  </dd>
                </>
              )}
              <dt>Attempts</dt>
              <dd>
                {item.attempts} of {team?.limits.maxAttempts ?? '?'}
                {item.nudges > 0 && `, check-in ${item.nudges} of ${TEAM_LIMITS.maxNudges}`}
              </dd>
              <dt>In all</dt>
              <dd>
                {plural(item.lifetime.attempts, 'attempt')} of {TEAM_LIFETIME.attempts}, {plural(item.lifetime.checkins, 'check-in')} of {TEAM_LIFETIME.checkins}, {plural(item.lifetime.escalations, 'escalation')} of {TEAM_LIFETIME.escalations}
              </dd>
              <dt>Last activity</dt>
              <dd title={dateTime(item.lastActivityAt)}>{relative(item.lastActivityAt, now)}</dd>
              <dt>Added</dt>
              <dd title={dateTime(item.createdAt)}>
                {relative(item.createdAt, now)} by {who(item.createdBy) ?? 'someone'}
              </dd>
            </dl>
          </section>

          {item.detail && (
            <Section title="Detail">
              <div className="item-detail">
                <Markdown text={item.detail} />
              </div>
            </Section>
          )}

          {item.evidence.length > 0 && (
            <Section title="What the server recorded">
              <ul className="evidence-list">
                {[...item.evidence].reverse().map((e, i) => (
                  <li key={`${e.at}:${i}`}>
                    <strong>{evidenceText(e.kind)}</strong>
                    {e.detail && <span> {e.detail}</span>}
                    <time className="muted" dateTime={e.at} title={dateTime(e.at)}>
                      {' '}
                      · {relative(e.at, now)}
                    </time>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="What you can do">
            <div className="item-actions">
              {ownerActions(item, team?.state).map((a) => (
                <button key={a} type="button" className={cx('btn small', a === 'cancel' && 'danger')} disabled={!online} onClick={() => setAction(a)}>
                  {a === 'assign' && !item.assigneeBotId ? 'Assign' : OWNER_ACTION_WORDS[a]}…
                </button>
              ))}
            </div>
            {ownerActionsNote(team?.state) && <p className="set-help">{ownerActionsNote(team?.state)}</p>}
            {!online && <p className="set-help">Offline: these work again once the server is reachable.</p>}
          </Section>

          {item.threadId && (
            <a className="btn small item-thread" href={teamsHash({ view: 'thread', threadId: item.threadId, messageId: null })}>
              Open its conversation
            </a>
          )}

          <section className="item-history" aria-labelledby={ids.history}>
            <h2 className="board-title" id={ids.history}>
              History
            </h2>
            {!events ? (
              <Loading what="its history" />
            ) : history.length === 0 ? (
              <p className="muted">Nothing yet.</p>
            ) : (
              <ol className="event-list">
                {history.map((e) => (
                  <li key={e.seq}>
                    <span>{eventText(e)}</span>
                    {e.detail && <span className="event-detail"> “{clip(e.detail, 200)}”</span>}
                    <time className="muted" dateTime={e.at} title={dateTime(e.at)}>
                      {' '}
                      · {relative(e.at, now)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <SteerLine team={team ?? null} />
        </div>
      </div>
      {action && <ItemActionDialog item={item} team={team} action={action} onClose={() => setAction(null)} />}
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ACTION_FIELDS: Record<OwnerItemAction, { field: 'note' | 'result' | 'reason' | null; label: string; required: boolean; max: number }> = {
  assign: { field: 'note', label: 'A note for them (optional)', required: false, max: TEAM_TEXT.note },
  retry: { field: 'note', label: 'A note for them (optional)', required: false, max: TEAM_TEXT.note },
  done: { field: 'result', label: 'Result: what was done, and where it is', required: true, max: TEAM_TEXT.result },
  cancel: { field: 'reason', label: 'Why it is cancelled', required: true, max: TEAM_TEXT.reason },
  reopen: { field: null, label: '', required: false, max: 0 },
};

/** For "Couldn't …": what the action was. */
const ACTION_WHAT: Record<OwnerItemAction, string> = { assign: 'give it to them', retry: 'try it again', done: 'mark it done', cancel: 'cancel it', reopen: 'reopen it' };

/** One owner action on an item, with what it needs; sent with the item's version, so a stale page is refused. */
function ItemActionDialog({ item, team, action, onClose }: { item: TeamItem; team: Team | undefined; action: OwnerItemAction; onClose: () => void }) {
  const members = team ? rosterOrder(team.members) : [];
  const [assignee, setAssignee] = useState(() => members.find((m) => m.botId !== item.assigneeBotId)?.botId ?? item.assigneeBotId ?? '');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(actionKey, []);
  const id = useId();
  const spec = ACTION_FIELDS[action];
  const verb = action === 'assign' && !item.assigneeBotId ? 'Assign' : OWNER_ACTION_WORDS[action];
  const to = members.find((m) => m.botId === assignee)?.name ?? 'them';
  const help: Record<OwnerItemAction, string> = {
    assign: item.assigneeBotId
      ? `${to} gets a request for it now. If ${item.assigneeName ?? 'the earlier assignee'} hasn't started its request yet, that one is called back.`
      : `${to} gets a request for it now.`,
    retry: `${item.assigneeName ?? 'Its assignee'} gets a new request for it. This counts as an attempt.`,
    done: 'It closes as done with your result; the lead sees it.',
    cancel: 'The reason is kept with it, and the lead sees it. A request not yet started is called back.',
    reopen: 'It goes back to Open with no one on it: you or the lead assign it again.',
  };
  const submit = async () => {
    if (action === 'assign' && !assignee) return setProblem('Choose who gets it.');
    if (spec.required && !text.trim()) return setProblem(`${spec.label.split(':')[0]} is needed.`);
    setBusy(true);
    const input: Omit<TeamItemActionInput, 'version'> = { action, key, ...(action === 'assign' && { assigneeBotId: assignee }), ...(spec.field && text.trim() && { [spec.field]: text.trim() }) };
    try {
      const r = await actions.itemAction(item, input);
      onClose();
      showToast({ kind: 'info', text: r.duplicate ? 'That was already done.' : doneText(action, to, item) });
    } catch (e) {
      showToast({ kind: 'error', text: `Couldn't ${ACTION_WHAT[action]}: ${errorText(e)}` }, 8000);
      // Refused because it moved on: show it as it is now.
      if (e instanceof ApiError && e.status === 409) void actions.loadTeamItem(item.id).catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`${verb} “${clip(item.title, 50)}”`} onClose={() => !busy && onClose()}>
      <form
        className="team-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {action === 'assign' && (
          <label>
            <span className="field-label">Give it to</span>
            <select data-autofocus value={assignee} onChange={(e) => (setAssignee(e.target.value), setProblem(null))}>
              {members.map((m) => (
                <option key={m.botId} value={m.botId}>
                  {m.name}
                  {m.roleTitle ? ` (${m.roleTitle})` : ''}
                  {m.botId === item.assigneeBotId ? ', has it now' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {spec.field && (
          <label>
            <span className="field-label">{spec.label}</span>
            <textarea
              rows={3}
              value={text}
              maxLength={spec.max}
              data-autofocus={action !== 'assign' || undefined}
              onChange={(e) => (setText(e.target.value), setProblem(null))}
              aria-invalid={!!problem || undefined}
              aria-describedby={`${id}-help${problem ? ` ${id}-problem` : ''}`}
            />
          </label>
        )}
        <p className="hint" id={`${id}-help`}>
          {help[action]}
        </p>
        {problem && (
          <p className="form-error" id={`${id}-problem`} role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy} data-autofocus={action === 'reopen' || undefined}>
            Back
          </button>
          <button type="submit" className={action === 'cancel' ? 'btn danger-solid' : 'btn primary'} disabled={busy}>
            {busy ? 'Working…' : action === 'cancel' ? 'Cancel the item' : verb}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function doneText(action: OwnerItemAction, to: string, item: TeamItem): string {
  switch (action) {
    case 'assign':
      return `Gave it to ${to}.`;
    case 'retry':
      return `Asked ${item.assigneeName ?? 'its assignee'} to try again.`;
    case 'done':
      return 'Marked it done.';
    case 'cancel':
      return 'Cancelled it.';
    case 'reopen':
      return 'Reopened it.';
  }
}

// ------------------------------------------------------------------ Team

function TeamTab({ team, onEdit }: { team: Team; onEdit: () => void }) {
  return (
    <div className="boton-settings team-tab">
      {team.completion && <Completion team={team} />}
      <Section title="Goal">
        <div className="team-goal">{team.goal ? <p>{team.goal}</p> : <p className="muted">No goal written yet: Edit team to give it one.</p>}</div>
      </Section>
      <Section title={`Members (${team.members.length})`}>
        {rosterOrder(team.members).map((m) => (
          <SeatRow key={m.botId} seat={m} />
        ))}
        {team.members.length === 0 && <p className="set-help">No one is on the team.</p>}
      </Section>
      <ManageTeam team={team} onEdit={onEdit} />
      {team.state !== 'archived' && (
        <More label="Limits">
          <LimitsForm team={team} />
        </More>
      )}
    </div>
  );
}

/** A seat, with the Boton's state as it is now (from the live Botons when the page has it). */
function SeatRow({ seat }: { seat: TeamSeat }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === seat.botId));
  const live = bot ? { state: bot.status.state, paused: bot.paused } : seat;
  return (
    <div className="seat-row">
      <span className={cx('avatar-wrap', live.state !== 'idle' && 'busy', live.paused && 'paused')}>
        <BotonAvatar look={bot?.look ?? DEFAULT_LOOK} size={38} seed={seat.botId} state={bot ? avatarState(bot, 0) : 'idle'} />
      </span>
      <span className="seat-text">
        <span className="seat-name">
          <a className="chip-link" href={chatHash(seat.botId)} title={`Open ${seat.name}'s chat`}>
            {seat.name}
          </a>
          {seat.role === 'lead' && <span className="badge lead-badge">Lead</span>}
          {seat.roleTitle && <span className="muted">{seat.roleTitle}</span>}
        </span>
        {seat.responsibilities && <span className="seat-resp">{seat.responsibilities}</span>}
      </span>
      <span className={cx('seat-state', live.state !== 'idle' && 'active')}>{seatStateText(live)}</span>
    </div>
  );
}

/** What the lead reported when it finished, beside the server's own record of every item: to be checked, not celebrated. */
function Completion({ team }: { team: Team }) {
  const c = team.completion!;
  const reviewed = !!team.reviewedAt;
  const online = useStore((s) => s.connected);
  const [busy, setBusy] = useState(false);
  const hid = useId();
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    await attempt(what, fn);
    setBusy(false);
  };
  return (
    <section className={cx('completion', !reviewed && 'to-review')} aria-labelledby={hid}>
      <h2 id={hid}>{reviewed ? 'Finished' : 'Finished, review it'}</h2>
      <p className="muted">
        {c.by.name} finished it {relative(c.at)} ({dateTime(c.at)}). Check what it says against the work before you mark it reviewed.
      </p>
      <h3>What it says it delivered</h3>
      <Markdown text={c.summary} />
      {c.scope && (
        <>
          <h3>What was left out, and why</h3>
          <Markdown text={c.scope} />
        </>
      )}
      <h3>Done ({c.done.length})</h3>
      <ul className="completion-list">
        {c.done.map((d) => (
          <li key={d.itemId}>
            <a className="chip-link" href={teamsHash({ view: 'item', itemId: d.itemId })}>
              {d.title}
            </a>
            : {d.result}
          </li>
        ))}
      </ul>
      {c.cancelled.length > 0 && (
        <>
          <h3>Cancelled ({c.cancelled.length})</h3>
          <ul className="completion-list">
            {c.cancelled.map((x) => (
              <li key={x.itemId}>
                <a className="chip-link" href={teamsHash({ view: 'item', itemId: x.itemId })}>
                  {x.title}
                </a>
                : {x.reason} <span className="muted">(cancelled by {x.by})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="completion-actions">
        {!reviewed && (
          <button type="button" className="btn small primary" disabled={busy || !online} onClick={() => void run(`mark ${team.name} reviewed`, () => actions.reviewTeam(team))}>
            Mark reviewed
          </button>
        )}
        {team.state === 'done' && (
          <button type="button" className="btn small" disabled={busy || !online} onClick={() => void run(`reopen ${team.name}`, () => actions.setTeamState(team, { state: 'active' }))}>
            Reopen
          </button>
        )}
      </div>
    </section>
  );
}

function ManageTeam({ team, onEdit }: { team: Team; onEdit: () => void }) {
  const online = useStore((s) => s.connected);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'stop' | 'archive' | 'delete' | null>(null);
  const change = async (what: string, input: { state: 'active' | 'paused' | 'archived'; stop?: boolean }) => {
    setBusy(true);
    await attempt(what, () => actions.setTeamState(team, input));
    setBusy(false);
  };
  const off = busy || !online;
  const name = team.name;
  return (
    <Section title="Manage">
      {team.state !== 'archived' && (
        <Row
          label="Edit team"
          help="Name, goal, members, the lead and each one's role."
          control={
            <button type="button" className="btn small" disabled={!online} onClick={onEdit}>
              <EditIcon size={14} /> Edit
            </button>
          }
        />
      )}
      {team.state === 'active' && (
        <Row
          label="Pause"
          help="Nothing is sent and the lead gets no check-ins. Turns already running finish."
          control={
            <button type="button" className="btn small" disabled={off} onClick={() => void change(`pause ${name}`, { state: 'paused' })}>
              <PauseIcon size={14} /> Pause
            </button>
          }
        />
      )}
      {team.state === 'paused' && (
        <Row
          label="Resume"
          help={team.pausedReason === 'no_lead' ? 'Give it a lead first, in Edit team.' : 'Requests waiting are sent again in order, and its clocks start over.'}
          control={
            <button type="button" className="btn small" disabled={off} onClick={() => void change(`resume ${name}`, { state: 'active' })}>
              <PlayIcon size={14} /> Resume
            </button>
          }
        />
      )}
      {(team.state === 'active' || (team.state === 'paused' && team.pausedReason !== 'stopped')) && (
        <Row
          label="Stop work"
          help="Pause it, and stop its Botons' turns on its work now."
          control={
            <button type="button" className="btn small danger" disabled={off} onClick={() => setConfirm('stop')}>
              <StopIcon size={14} /> Stop work…
            </button>
          }
        />
      )}
      {team.state === 'done' && (
        <Row
          label="Reopen"
          help="It becomes active again, and its lead carries on."
          control={
            <button type="button" className="btn small" disabled={off} onClick={() => void change(`reopen ${name}`, { state: 'active' })}>
              Reopen
            </button>
          }
        />
      )}
      {team.state !== 'archived' ? (
        <Row
          label="Archive"
          help="It stops for good and moves to the end of the list. Its conversations stay readable."
          control={
            <button type="button" className="btn small danger" disabled={off} onClick={() => setConfirm('archive')}>
              Archive…
            </button>
          }
        />
      ) : (
        <>
          <Row
            label="Restore"
            help="It becomes active again."
            control={
              <button type="button" className="btn small" disabled={off} onClick={() => void change(`restore ${name}`, { state: 'active' })}>
                Restore
              </button>
            }
          />
          <Row
            label="Delete"
            help="Its work, history and conversations are deleted."
            control={
              <button type="button" className="btn small danger" disabled={off} onClick={() => setConfirm('delete')}>
                Delete…
              </button>
            }
          />
        </>
      )}
      {confirm === 'stop' && (
        <ConfirmDialog title={`Stop work on ${name}?`} confirmLabel="Stop work" what={`stop work on ${name}`} danger onConfirm={() => actions.setTeamState(team, { state: 'paused', stop: true })} onClose={() => setConfirm(null)}>
          <p>The team pauses, and the turns its Botons are running on its work stop now. Requests not yet started are called back, and work in progress becomes blocked until you look at it.</p>
          <p>Nothing else about the Botons changes. Resume the team when you are ready.</p>
        </ConfirmDialog>
      )}
      {confirm === 'archive' && (
        <ConfirmDialog title={`Archive ${name}?`} confirmLabel="Archive" what={`archive ${name}`} danger onConfirm={() => actions.setTeamState(team, { state: 'archived' })} onClose={() => setConfirm(null)}>
          <p>It stops: nothing is sent, and no one is woken about its work. Its work and conversations stay readable, and you can restore it or delete it later.</p>
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          confirmLabel="Delete team"
          what={`delete ${name}`}
          danger
          onConfirm={async () => {
            await actions.deleteTeam(team);
            location.hash = teamsHash({ view: 'list' });
          }}
          onClose={() => setConfirm(null)}
        >
          <p>Its work items, history and conversations are deleted, and this can't be undone. The Botons themselves stay as they are.</p>
        </ConfirmDialog>
      )}
    </Section>
  );
}

/** The few limits the owner may tune, within their bounds; the rest are fixed. */
function LimitsForm({ team }: { team: Team }) {
  const online = useStore((s) => s.connected);
  const [d, setD] = useState(() => limitDraft(team.limits));
  const [problem, setProblem] = useState<{ error: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const id = useId();
  const limits = JSON.stringify(team.limits);
  useEffect(() => {
    if (!dirty.current) setD(limitDraft(team.limits));
  }, [limits]);
  const save = async () => {
    const r = limitsPatch(d, team.limits);
    if ('error' in r) {
      setProblem(r);
      document.getElementById(`${id}-${r.key}`)?.focus();
      return;
    }
    if (!Object.keys(r.patch).length) return showToast({ kind: 'info', text: 'Nothing changed.' });
    setBusy(true);
    const ok = await attempt('save the limits', () => actions.setTeamLimits(team, r.patch));
    setBusy(false);
    if (ok) {
      dirty.current = false;
      showToast({ kind: 'info', text: `Saved ${team.name}'s limits.` });
    }
  };
  return (
    <form
      className="limits-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {LIMIT_FIELDS.map((f) => {
        const [min, max] = limitBoundsOf(f.key);
        const wrong = problem?.key === f.key;
        return (
          <label key={f.key} className="limit-field">
            <span className="field-label">{f.label}</span>
            <span className="limit-input">
              <input
                id={`${id}-${f.key}`}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={d[f.key]}
                aria-invalid={wrong || undefined}
                aria-describedby={`${id}-${f.key}-help${wrong ? ` ${id}-problem` : ''}`}
                onChange={(e) => {
                  dirty.current = true;
                  setProblem(null);
                  setD({ ...d, [f.key]: e.target.value });
                }}
              />
              <span className="muted">{f.unit}</span>
            </span>
            <span className="hint" id={`${id}-${f.key}-help`}>
              {f.help} {min} to {max}.
            </span>
          </label>
        );
      })}
      {problem && (
        <p className="form-error" id={`${id}-problem`} role="alert">
          {problem.error}
        </p>
      )}
      <p className="hint">The rest is fixed: at most {TEAM_LIMITS.maxNudges} check-ins about one item before it comes to you, and {TEAM_LIMITS.escalationsPerTeamPerDay} escalations a day.</p>
      <div className="form-actions">
        <button type="submit" className="btn small primary" disabled={busy || !online}>
          {busy ? 'Saving…' : 'Save limits'}
        </button>
      </div>
    </form>
  );
}
