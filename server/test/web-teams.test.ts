// The web app's Teams helpers (web/src/teams.ts), pure: addresses, live events against what the page holds, the
// board's groups, thread order, the badge and the words, read against the typed response fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Team, TeamItem, TeamMessage, TeamThread } from '../../shared/types.ts';
import { TEAM_LIMIT_DEFAULTS, TEAM_LIMITS } from '../../shared/teams.ts';
import {
  boardGroups,
  countsLine,
  draftOf,
  draftProblem,
  eventText,
  firstLine,
  lastLine,
  limitDraft,
  limitsPatch,
  matchParts,
  messageDelivery,
  needsYou,
  ownerActions,
  ownerActionsNote,
  readUpTo,
  stateChanges,
  teamStateText,
  threadDeliveryNote,
  threadPeople,
} from '../../web/src/team-words.ts';
import {
  emptyTeams,
  mergeMessages,
  mergeTeams,
  parseTeamsHash,
  putBoard,
  putItem,
  putThreads,
  readRoute,
  droppedSeatEdits,
  rebaseDraft,
  rosterChanged,
  rosterInput,
  teamsBadge,
  teamsEvent,
  teamsHash,
  titleCount,
  upsertTeam,
  type TeamDraft,
  type TeamsRoute,
  type TeamsSlice,
} from '../../web/src/teams.ts';
import { attention, doneTeam, items, messages, team, teamDetail, threads } from './fixtures/teams/contract.ts';

const NOW = Date.parse('2026-11-16T10:40:00.000Z');
const slice = (p: Partial<TeamsSlice> = {}): TeamsSlice => ({ ...emptyTeams(), ...p });
const ids = (list: { id: string }[]) => list.map((x) => x.id);

test('Teams addresses read and write back the same, beside the chat addresses', () => {
  const routes: [string, TeamsRoute][] = [
    ['#/teams', { view: 'list' }],
    ['#/teams/team_atlas', { view: 'team', teamId: 'team_atlas', tab: 'work' }],
    ['#/teams/team_atlas/conversations', { view: 'team', teamId: 'team_atlas', tab: 'conversations' }],
    ['#/teams/team_atlas/team', { view: 'team', teamId: 'team_atlas', tab: 'team' }],
    ['#/teams/direct', { view: 'direct' }],
    ['#/teams/t/thr_schema', { view: 'thread', threadId: 'thr_schema', messageId: null }],
    ['#/teams/t/thr_schema/tmsg_reply', { view: 'thread', threadId: 'thr_schema', messageId: 'tmsg_reply' }],
    ['#/teams/i/item_key', { view: 'item', itemId: 'item_key' }],
  ];
  for (const [hash, route] of routes) {
    assert.deepEqual(parseTeamsHash(hash), route, hash);
    assert.equal(teamsHash(route), hash);
    assert.deepEqual(readRoute(hash), { kind: 'teams', route });
  }
  // An unknown tab is the default one; junk under Teams is the list; anything else is not Teams.
  assert.deepEqual(parseTeamsHash('#/teams/team_atlas/nope'), { view: 'team', teamId: 'team_atlas', tab: 'work' });
  assert.deepEqual(parseTeamsHash('#/teams/t'), { view: 'list' });
  assert.deepEqual(parseTeamsHash('#/teams/i/item_key/extra'), { view: 'list' });
  assert.deepEqual(parseTeamsHash('#/teams/<script>'), { view: 'list' });
  assert.equal(parseTeamsHash('#/teamsx'), null);
  assert.equal(parseTeamsHash('#/m/bot_kevin'), null);
  assert.deepEqual(readRoute('#/m/bot_kevin'), { kind: 'chat', botId: 'bot_kevin', messageId: null });
  assert.deepEqual(readRoute('#/m/bot_kevin/msg_card'), { kind: 'chat', botId: 'bot_kevin', messageId: 'msg_card' });
  assert.equal(readRoute(''), null);
  assert.equal(readRoute('#/settings'), null);
});

test('the board groups what needs the owner first, then blocked, working, open, and finished work last', () => {
  const extra: TeamItem[] = [
    { ...items[0]!, id: 'item_lead', status: 'blocked', blockedNeed: 'lead', escalation: null, waiting: null, createdAt: '2026-11-16T09:01:00.000Z' },
    { ...items[3]!, id: 'item_gone', status: 'cancelled', closedAt: '2026-11-16T09:30:00.000Z' },
  ];
  const groups = boardGroups([...items, ...extra]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, ids(g.items)]),
    [
      ['needs_you', 'Needs you', ['item_key']],
      ['blocked', 'Blocked', ['item_lead']],
      ['working', 'Working', ['item_schema']],
      ['open', 'Open', ['item_guide']],
      // Finished work, newest first; a cancelled item says so in the group's name.
      ['done', 'Done or cancelled', ['item_gone', 'item_plan']],
    ],
  );
  assert.deepEqual(boardGroups([items[0]!]).map((g) => g.key), ['working'], 'empty groups are left out');
  assert.deepEqual(boardGroups([]), []);
});

test('a thread reads by seq, each message once, a later copy replacing the earlier', () => {
  const [assign, reply, system] = messages as [TeamMessage, TeamMessage, TeamMessage];
  const answered = { ...assign, delivery: { ...assign.delivery!, state: 'handled' as const } };
  const merged = mergeMessages([reply, assign], [system, answered, reply]);
  assert.deepEqual(merged.map((m) => m.seq), [30, 31, 32]);
  assert.equal(merged[0], answered, 'the copy that came last wins');
  assert.equal(readUpTo(merged), 32);
  assert.equal(readUpTo([]), 0);
});

test('a live message is added only to a thread the page holds, in seq order, never twice', () => {
  const [assign, reply, system] = messages as [TeamMessage, TeamMessage, TeamMessage];
  assert.equal(teamsEvent(slice(), { type: 'team.message.created', message: reply }), null, 'a thread not open is left alone');
  const held = slice({ threadMessages: { thr_schema: { items: [assign, system], hasMore: false } } });
  const once = teamsEvent(held, { type: 'team.message.created', message: reply })!;
  assert.deepEqual(once.threadMessages!.thr_schema!.items.map((m) => m.id), ['tmsg_assign', 'tmsg_reply', 'tmsg_system']);
  const twice = teamsEvent({ ...held, ...once }, { type: 'team.message.created', message: reply })!;
  assert.equal(twice.threadMessages!.thr_schema!.items.length, 3);
  assert.equal(teamsEvent(held, { type: 'team.message.created', message: { ...reply, threadId: 'thr_other' } }), null);
});

test('threads arrive in the lists they belong to, newest first; a team deleted takes its threads and items with it', () => {
  const [schema, direct] = threads as [TeamThread, TeamThread];
  let s = slice({ ...putThreads(slice(), 'all', [direct], false, false) });
  s = { ...s, ...putThreads(s, 'team_atlas', [], false, false) };
  // A newer team thread goes on top of All and into its team's list; Direct's list isn't loaded, so nothing there.
  s = { ...s, ...teamsEvent(s, { type: 'team.thread.upserted', thread: schema }) };
  assert.deepEqual(s.threadLists.all!.ids, ['thr_schema', 'thr_direct']);
  assert.deepEqual(s.threadLists.team_atlas!.ids, ['thr_schema']);
  assert.equal(s.threadLists.direct, undefined);
  // The Direct one moves on: it is newest now, in All, still not in the team's list.
  s = { ...s, ...teamsEvent(s, { type: 'team.thread.upserted', thread: { ...direct, lastSeq: 40 } }) };
  assert.deepEqual(s.threadLists.all!.ids, ['thr_direct', 'thr_schema']);
  assert.deepEqual(s.threadLists.team_atlas!.ids, ['thr_schema']);
  // A thread in no list loaded and not open is not kept.
  assert.equal(teamsEvent(slice(), { type: 'team.thread.upserted', thread: schema }), null);
  // An older page goes after the ones shown.
  const older = { ...direct, id: 'thr_old', lastSeq: 2 };
  assert.deepEqual(putThreads(s, 'all', [older], false, true).threadLists.all!.ids, ['thr_direct', 'thr_schema', 'thr_old']);

  s = { ...s, teams: [team, doneTeam], teamItems: putBoard({}, 'team_atlas', items), teamBoards: { team_atlas: teamDetail.events }, threadMessages: { thr_schema: { items: messages, hasMore: false } } };
  const gone = { ...s, ...teamsEvent(s, { type: 'team.deleted', teamId: 'team_atlas' }) };
  assert.deepEqual(ids(gone.teams!), ['team_borealis']);
  assert.deepEqual(Object.keys(gone.teamItems), []);
  assert.deepEqual(Object.keys(gone.teamBoards), []);
  assert.deepEqual(gone.threadLists.all!.ids, ['thr_direct']);
  assert.equal(gone.threadLists.team_atlas, undefined);
  assert.equal(gone.threadMessages.thr_schema, undefined);
});

test('teams and items stay live: archived last, items only of boards or items the page holds', () => {
  const archived: Team = { ...doneTeam, id: 'team_old', state: 'archived' };
  let s = slice({ teams: [archived, team] });
  s = { ...s, ...teamsEvent(s, { type: 'team.upserted', team: doneTeam }) };
  assert.deepEqual(ids(s.teams!), ['team_atlas', 'team_borealis', 'team_old']);
  s = { ...s, ...teamsEvent(s, { type: 'team.upserted', team: { ...team, name: 'Atlas 2' } }) };
  assert.equal(s.teams![0]!.name, 'Atlas 2');
  assert.equal(teamsEvent(slice(), { type: 'team.upserted', team }), null, 'the list is loaded with the first Teams visit');

  assert.equal(teamsEvent(s, { type: 'team.item.upserted', item: items[0]! }), null, 'no board, no item');
  s = { ...s, teamBoards: { team_atlas: [] } };
  const added = teamsEvent(s, { type: 'team.item.upserted', item: { ...items[0]!, id: 'item_new' } })!;
  assert.ok(added.teamItems!.item_new);
  // A board read again drops what the server no longer has for that team, and only that team.
  const other = { ...items[0]!, id: 'item_x', teamId: 'team_borealis' };
  assert.deepEqual(Object.keys(putBoard({ item_old: items[1]!, item_x: other }, 'team_atlas', [items[0]!])).sort(), ['item_schema', 'item_x']);

  assert.deepEqual(teamsEvent(s, { type: 'teams.attention', attention }), { teamsAttention: attention });
  assert.equal(teamsEvent(s, { type: 'hello', build: 'x' } as never), null, 'other events are not Teams');
});

test('a copy read before a live event never puts back an older version of a team or an item', () => {
  const newer: Team = { ...team, name: 'Atlas 2', version: team.version + 1 };
  // A list read before the event lands after it: the event's newer copy stays; the list's order and its gaps win.
  assert.deepEqual(mergeTeams([newer, doneTeam], [team]).map((t) => [t.id, t.name]), [['team_atlas', 'Atlas 2']]);
  assert.equal(upsertTeam([newer], team)[0], newer, 'an older answer is not applied');
  assert.equal(upsertTeam([team], newer)[0], newer);
  const s = slice({ teams: [newer] });
  assert.equal(teamsEvent(s, { type: 'team.upserted', team }), null);

  const item = items[0]!;
  const moved = { ...item, status: 'done' as const, version: item.version + 1 };
  assert.equal(putItem({ [item.id]: moved }, item)[item.id], moved);
  assert.equal(putItem({ [item.id]: item }, moved)[item.id], moved);
  assert.equal(putBoard({ [item.id]: moved }, 'team_atlas', [item])[item.id], moved);
  assert.equal(teamsEvent(slice({ teamItems: { [item.id]: moved } }), { type: 'team.item.upserted', item }), null);
});

test('the sidebar shows a number when something needs the owner, else a dot for unread conversations; the title counts only the number', () => {
  assert.deepEqual(teamsBadge(attention), { kind: 'count', count: 2, label: '2 things need you' });
  assert.deepEqual(teamsBadge({ count: 1, unreadThreads: 0 }), { kind: 'count', count: 1, label: '1 thing needs you' });
  assert.deepEqual(teamsBadge({ count: 0, unreadThreads: 3 }), { kind: 'dot', label: '3 unread conversations' });
  assert.equal(teamsBadge({ count: 0, unreadThreads: 0 }), null);
  assert.equal(teamsBadge(null), null);
  assert.equal(titleCount(4, attention), 6);
  assert.equal(titleCount(4, { count: 0, unreadThreads: 9 }), 4);
  assert.equal(titleCount(0, null), 0);
});

test('"Needs you" lists escalations, owner blocks and holds, budget or leaderless pauses, and finished teams to review', () => {
  const budget: Team = { ...team, id: 'team_budget', name: 'Cirrus', state: 'paused', pausedReason: 'budget' };
  const owner: Team = { ...team, id: 'team_mine', name: 'Dune', state: 'paused', pausedReason: 'owner' };
  const reviewed: Team = { ...doneTeam, id: 'team_reviewed', reviewedAt: '2026-11-16T10:00:00.000Z' };
  const held: TeamItem = { ...items[0]!, id: 'item_held', held: 'owner', createdAt: '2026-11-16T09:59:00.000Z' };
  const all = needsYou([team, doneTeam, budget, owner, reviewed], putBoard({ item_held: held }, 'team_atlas', [...items, held]), NOW);
  assert.deepEqual(
    all.map((n) => [n.key, n.why]),
    [
      ['item:item_key', 'waiting for you: escalated'],
      ['item:item_held', 'held for you'],
      ['team:team_borealis', 'Finished, review it'],
      ['team:team_budget', 'Paused: a daily budget ran out'],
    ],
  );
});

test('words: team states, counts, cards, thread rows, deliveries, history', () => {
  assert.equal(teamStateText(team), 'Active');
  assert.equal(teamStateText(doneTeam), 'Finished, review it', 'never "success"');
  assert.equal(teamStateText({ ...doneTeam, reviewedAt: '2026-11-16T10:00:00.000Z' }), 'Finished');
  assert.equal(teamStateText({ ...team, state: 'paused', pausedReason: 'no_lead' }), 'Paused: it has no lead');
  assert.equal(teamStateText({ ...team, state: 'paused', pausedReason: 'stopped' }), 'Stopped');
  assert.equal(teamStateText({ ...team, state: 'archived' }), 'Archived');
  assert.equal(countsLine(team.counts), '1 working · 1 blocked · 1 open · 1 done');
  assert.equal(countsLine({ open: 0, working: 0, blocked: 0, done: 0, cancelled: 0 }), 'No work yet');
  assert.equal(firstLine('\n  Ship the importer.\nThen the guide.'), 'Ship the importer.');
  assert.equal(firstLine('x'.repeat(200), 10), `${'x'.repeat(9)}…`);

  assert.equal(threadPeople(threads[0]!), 'Kevin → Stuart');
  assert.equal(threadPeople({ ...threads[0]!, participants: [...threads[0]!.participants, { botId: 'bot_bob', name: 'Bob' }] }), 'Kevin → Stuart +1');
  assert.equal(lastLine(threads[0]!), 'Stuart: Mapped 14 of 20 tables; the rest need the key.');

  const [assign, reply] = messages as [TeamMessage, TeamMessage];
  assert.equal(messageDelivery(assign), 'Answered in 50m');
  assert.equal(messageDelivery(reply), null, 'only requests have a delivery line');
  const waiting = { ...assign, delivery: { ...assign.delivery!, state: 'queued' as const, outcome: null, waitingOn: 'paused' as const } };
  assert.equal(messageDelivery(waiting), 'Waiting: Stuart is paused');
  assert.equal(threadDeliveryNote(messages), null, 'an answered request is plain');
  assert.equal(threadDeliveryNote([waiting, reply]), 'Waiting: Stuart is paused');
  assert.equal(threadDeliveryNote([{ ...assign, delivery: { ...assign.delivery!, outcome: 'failed' } }]), 'Could not answer');
  assert.equal(threadDeliveryNote(undefined), null);
  const queued = { state: 'queued', outcome: null, waitingOn: 'paused', chatMessageId: null, botId: 'bot_bob', queuedAt: '2026-11-16T09:00:00.000Z', at: '2026-11-16T09:00:00.000Z' } as const;
  assert.equal(threadDeliveryNote(undefined, { lastDelivery: queued, participants: [{ botId: 'bot_bob', name: 'Bob' }] }), 'Waiting: Bob is paused', 'a row not opened yet uses its own newest delivery');
  assert.equal(threadDeliveryNote([waiting, reply], { lastDelivery: null, participants: [] }), 'Waiting: Stuart is paused', 'loaded messages win');

  assert.deepEqual(matchParts('…the Key, the key.', 'KEY'), [
    { text: '…the ', match: false },
    { text: 'Key', match: true },
    { text: ', the ', match: false },
    { text: 'key', match: true },
    { text: '.', match: false },
  ]);
  assert.deepEqual(matchParts('no match', 'zzz'), [{ text: 'no match', match: false }]);
  assert.deepEqual(matchParts('a.b', '.'), [{ text: 'a', match: false }, { text: '.', match: true }, { text: 'b', match: false }], 'a query is text, never a pattern');

  const [escalated, blocked, created] = teamDetail.events;
  assert.equal(eventText(escalated!), 'Kevin escalated it to you');
  assert.equal(eventText(blocked!), 'Stuart marked it blocked');
  assert.equal(eventText(created!), 'You made the team');
  assert.equal(eventText({ kind: 'stalled', actor: { kind: 'server', botId: null, name: '' } }), 'Botons saw no progress');
});

test('a team that changes state is announced once, by name and in words', () => {
  assert.deepEqual(stateChanges(null, [team]), []);
  assert.deepEqual(stateChanges([team, doneTeam], [{ ...team, state: 'paused', pausedReason: 'owner' }, doneTeam]), ['Atlas: Paused.']);
  assert.deepEqual(stateChanges([team], [team, doneTeam]), [], 'a new team is not a change');
});

test('the owner may act on an item as its state allows', () => {
  assert.deepEqual(ownerActions(items[0]!), ['assign', 'done', 'cancel']);
  assert.deepEqual(ownerActions(items[1]!), ['assign', 'retry', 'cancel']);
  assert.deepEqual(ownerActions(items[3]!), ['cancel', 'reopen']);
  assert.deepEqual(ownerActions({ status: 'cancelled', assigneeBotId: null }), ['reopen']);
  assert.deepEqual(ownerActions(items[0]!, 'archived'), [], 'a finished or archived team is reopened or restored first');
  assert.deepEqual(ownerActions(items[3]!, 'done'), []);
  assert.match(ownerActionsNote('archived')!, /restore it/);
  assert.equal(ownerActionsNote('active'), null);
});

test('the team editor sends the whole roster with exactly one lead, and says what is missing first', () => {
  const d = draftOf(team);
  assert.equal(d.leadBotId, 'bot_kevin');
  assert.deepEqual(d.seats.map((s) => s.botId), ['bot_kevin', 'bot_stuart', 'bot_bob']);
  assert.equal(draftProblem(d), null);
  assert.equal(rosterChanged(team, d), false);
  assert.deepEqual(rosterInput(d).map((m) => [m.botId, m.role]), [['bot_kevin', 'lead'], ['bot_stuart', 'member'], ['bot_bob', 'member']]);

  const lead = { ...d, leadBotId: 'bot_stuart' };
  assert.equal(rosterChanged(team, lead), true);
  assert.deepEqual(rosterInput(lead).filter((m) => m.role === 'lead').map((m) => m.botId), ['bot_stuart']);
  assert.equal(rosterChanged(team, { ...d, seats: d.seats.map((s) => (s.botId === 'bot_bob' ? { ...s, roleTitle: 'Writer' } : s)) }), true);
  assert.equal(rosterChanged(team, { ...d, seats: d.seats.slice(0, 2) }), true);

  assert.equal(draftProblem(draftOf(null)), 'Give the team a name.');
  assert.equal(draftProblem({ ...d, seats: [] }), 'Choose the Botons on the team.');
  assert.equal(draftProblem({ ...d, leadBotId: null }), 'Choose one of them to lead the team.');
  assert.equal(draftProblem({ ...d, leadBotId: 'bot_dave' }), 'Choose one of them to lead the team.', 'the lead must be on the team');
  const many = Array.from({ length: TEAM_LIMITS.membersPerTeam + 1 }, (_, i) => ({ botId: `bot_${i}`, roleTitle: '', responsibilities: '' }));
  assert.match(draftProblem({ ...d, seats: many, leadBotId: 'bot_0' })!, /at most 8 Botons/);
  assert.match(draftProblem({ ...d, seats: [{ ...d.seats[0]!, responsibilities: 'x'.repeat(601) }] })!, /at most 600/);
});

test('limits are set in minutes and counts within their bounds, and only what changed is sent', () => {
  const d = limitDraft(TEAM_LIMIT_DEFAULTS);
  assert.deepEqual(d, { stallAfterMs: '30', startWithinMs: '15', maxAttempts: '3', messagesPerDay: '300', checkinsPerDay: '40' });
  assert.deepEqual(limitsPatch(d, TEAM_LIMIT_DEFAULTS), { patch: {} });
  assert.deepEqual(limitsPatch({ ...d, stallAfterMs: '45', maxAttempts: '5' }, TEAM_LIMIT_DEFAULTS), { patch: { stallAfterMs: 45 * 60_000, maxAttempts: 5 } });
  assert.deepEqual(limitsPatch({ ...d, stallAfterMs: '4' }, TEAM_LIMIT_DEFAULTS), { error: 'Stalled after: a whole number of minutes from 5 to 1440.', key: 'stallAfterMs' });
  assert.deepEqual(limitsPatch({ ...d, maxAttempts: '2.5' }, TEAM_LIMIT_DEFAULTS), { error: 'Attempts per item: a whole number of attempts from 1 to 6.', key: 'maxAttempts' });
  assert.equal('error' in limitsPatch({ ...d, messagesPerDay: '' }, TEAM_LIMIT_DEFAULTS), true);
});

test("a stale save moves the owner's edits onto the team as it is now, and never puts back what another device changed", () => {
  const origin: TeamDraft = {
    name: 'Atlas',
    goal: 'Ship the importer',
    seats: [
      { botId: 'bot_kevin', roleTitle: 'Lead', responsibilities: 'Plans the work' },
      { botId: 'bot_stuart', roleTitle: 'Backend', responsibilities: 'The importer' },
    ],
    leadBotId: 'bot_kevin',
  };
  // The owner renames the team, adds Bob and makes Stuart the lead.
  const draft: TeamDraft = { ...origin, name: 'Atlas two', seats: [...origin.seats, { botId: 'bot_bob', roleTitle: 'Docs', responsibilities: '' }], leadBotId: 'bot_stuart' };
  // Meanwhile another device changed the goal and Stuart's responsibilities, and added Dave.
  const latest: TeamDraft = {
    ...origin,
    goal: 'Ship the importer and its guide',
    seats: [origin.seats[0]!, { ...origin.seats[1]!, responsibilities: 'The importer and the schema' }, { botId: 'bot_dave', roleTitle: 'QA', responsibilities: 'Release checks' }],
  };
  const merged = rebaseDraft(origin, draft, latest);
  assert.equal(merged.name, 'Atlas two', "the owner's rename");
  assert.equal(merged.goal, 'Ship the importer and its guide', "the other device's goal, which the owner never touched");
  assert.deepEqual(merged.seats.map((s) => s.botId), ['bot_kevin', 'bot_stuart', 'bot_dave', 'bot_bob']);
  assert.equal(merged.seats[1]!.responsibilities, 'The importer and the schema', "Stuart's seat as changed elsewhere");
  assert.equal(merged.leadBotId, 'bot_stuart', "the owner's lead");
  // An owner's removal holds; a seat the owner edited keeps the owner's words.
  const edited = rebaseDraft(origin, { ...origin, seats: [{ ...origin.seats[0]!, responsibilities: 'Plans and reviews' }] }, latest);
  assert.deepEqual(edited.seats.map((s) => s.botId), ['bot_kevin', 'bot_dave']);
  assert.equal(edited.seats[0]!.responsibilities, 'Plans and reviews');
  assert.deepEqual(rebaseDraft(origin, origin, latest), latest, 'nothing edited: the team as it is now');
  // Both sides added Dave: the other device's words stay where the owner left the fields blank.
  const both = rebaseDraft(origin, { ...origin, seats: [...origin.seats, { botId: 'bot_dave', roleTitle: '', responsibilities: '' }] }, latest);
  assert.deepEqual(both.seats.find((s) => s.botId === 'bot_dave'), { botId: 'bot_dave', roleTitle: 'QA', responsibilities: 'Release checks' });
  // The owner edited Stuart's seat while another device removed Stuart: the removal stands, and it is named.
  const editedStuart: TeamDraft = { ...origin, seats: [origin.seats[0]!, { ...origin.seats[1]!, roleTitle: 'Data' }] };
  const gone: TeamDraft = { ...origin, seats: [origin.seats[0]!] };
  assert.deepEqual(rebaseDraft(origin, editedStuart, gone).seats.map((s) => s.botId), ['bot_kevin'], 'no resurrection');
  assert.deepEqual(droppedSeatEdits(origin, editedStuart, gone), ['bot_stuart']);
  assert.deepEqual(droppedSeatEdits(origin, origin, gone), [], 'an untouched seat removed elsewhere is no lost edit');
  assert.deepEqual(droppedSeatEdits(origin, editedStuart, latest), [], 'still on the team: nothing lost');
  // The lead: never one nobody picked, and a pick taken away elsewhere is named.
  const three: TeamDraft = { ...origin, seats: [origin.seats[1]!, origin.seats[0]!, { botId: 'bot_bob', roleTitle: '', responsibilities: '' }] };
  const bobLeads: TeamDraft = { ...three, leadBotId: 'bot_bob' };
  const withoutBob: TeamDraft = { ...three, seats: three.seats.filter((s) => s.botId !== 'bot_bob') };
  assert.equal(rebaseDraft(three, withoutBob, bobLeads).leadBotId, 'bot_kevin', "Bob is gone here: the owner's kept lead, not the first seat");
  const stuartLeads: TeamDraft = { ...three, leadBotId: 'bot_stuart' };
  const stuartGoneThere: TeamDraft = { ...three, seats: three.seats.filter((s) => s.botId !== 'bot_stuart') };
  assert.equal(rebaseDraft(three, stuartLeads, stuartGoneThere).leadBotId, 'bot_kevin');
  assert.deepEqual(droppedSeatEdits(three, stuartLeads, stuartGoneThere), ['bot_stuart'], 'the lead pick taken away is named');
});
