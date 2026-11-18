// Every new Teams response shape, typed against shared/types.ts: the web and native apps build against these (the JSON
// files beside this one are written from it; teams-rules.test.ts keeps them the same). Placeholder names only.
import type {
  AskResult,
  BotTeamsView,
  ServerEvent,
  Team,
  TeamDetail,
  TeamItem,
  TeamItemActionResult,
  TeamItemDetail,
  TeamMessage,
  TeamSearchHit,
  TeamThread,
  TeamThreadDetail,
  TeamsAttention,
} from '../../../../shared/types.ts';
import { TEAM_LIMIT_DEFAULTS } from '../../../../shared/teams.ts';

const at = (min: number) => new Date(Date.parse('2026-11-16T09:00:00.000Z') + min * 60_000).toISOString();

export const team: Team = {
  id: 'team_atlas',
  name: 'Atlas',
  goal: 'Ship the importer: read the export, map it to the new schema, and write the user guide.',
  state: 'active',
  pausedReason: null,
  lead: { botId: 'bot_kevin', name: 'Kevin' },
  members: [
    { botId: 'bot_kevin', name: 'Kevin', role: 'lead', roleTitle: 'Lead', responsibilities: 'Plans the work and reviews results.', state: 'idle', paused: false },
    { botId: 'bot_stuart', name: 'Stuart', role: 'member', roleTitle: 'Backend', responsibilities: 'The importer and the schema.', state: 'working', paused: false },
    { botId: 'bot_bob', name: 'Bob', role: 'member', roleTitle: 'Docs', responsibilities: 'The user guide.', state: 'idle', paused: true },
  ],
  counts: { open: 1, working: 1, blocked: 1, done: 1, cancelled: 0 },
  attention: 1,
  unreadThreads: 2,
  limits: TEAM_LIMIT_DEFAULTS,
  completion: null,
  reviewedAt: null,
  version: 4,
  createdAt: at(0),
  updatedAt: at(90),
};

export const doneTeam: Team = {
  ...team,
  id: 'team_borealis',
  name: 'Borealis',
  state: 'done',
  counts: { open: 0, working: 0, blocked: 0, done: 2, cancelled: 1 },
  attention: 1,
  unreadThreads: 0,
  completion: {
    summary: 'The importer is in the shared folder; the guide is in docs.',
    scope: 'The CSV variant was left out: no export uses it yet.',
    by: { botId: 'bot_kevin', name: 'Kevin' },
    at: at(300),
    done: [
      { itemId: 'item_import', title: 'Write the importer', result: 'importer.ts in the shared folder, with tests.' },
      { itemId: 'item_guide', title: 'User guide', result: 'docs/import.md' },
    ],
    cancelled: [{ itemId: 'item_csv', title: 'CSV variant', reason: 'No export uses CSV yet.', by: 'Kevin' }],
  },
  version: 9,
};

const itemBase = {
  teamId: 'team_atlas',
  detail: '',
  attempts: 1,
  nudges: 0,
  lifetime: { attempts: 1, checkins: 0, escalations: 0 },
  held: null,
  blockedReason: null,
  blockedNeed: null,
  result: null,
  closedReason: null,
  closedBy: null,
  waiting: null,
  evidence: [],
  escalation: null,
  version: 3,
  createdBy: 'bot_kevin',
  createdAt: at(5),
  closedAt: null,
} satisfies Partial<TeamItem>;

export const items: TeamItem[] = [
  {
    ...itemBase,
    id: 'item_schema',
    title: 'Map the export to the new schema',
    status: 'working',
    assigneeBotId: 'bot_stuart',
    assigneeName: 'Stuart',
    gen: 1,
    waiting: 'running',
    threadId: 'thr_schema',
    nextCheckAt: at(120),
    lastActivityAt: at(80),
    updatedAt: at(80),
  },
  {
    ...itemBase,
    id: 'item_key',
    title: 'Get read access to the export',
    status: 'blocked',
    assigneeBotId: 'bot_stuart',
    assigneeName: 'Stuart',
    gen: 2,
    attempts: 2,
    nudges: 1,
    lifetime: { attempts: 2, checkins: 1, escalations: 1 },
    blockedReason: 'The export needs a key only Sam has.',
    blockedNeed: 'owner',
    evidence: [
      { kind: 'blocked', gen: 2, detail: 'The export needs a key only Sam has.', at: at(40) },
      { kind: 'checkin', gen: 2, detail: 'Kevin was told; the item did not move.', at: at(70) },
    ],
    escalation: { cardMessageId: 'msg_card', botId: 'bot_kevin', by: 'lead', summary: 'The importer needs the export key.', need: 'Put the key in the shared folder.', at: at(75) },
    waiting: 'owner',
    threadId: 'thr_key',
    nextCheckAt: at(105),
    lastActivityAt: at(40),
    updatedAt: at(75),
  },
  {
    ...itemBase,
    id: 'item_guide',
    title: 'User guide',
    status: 'open',
    assigneeBotId: 'bot_bob',
    assigneeName: 'Bob',
    gen: 1,
    waiting: 'paused',
    threadId: 'thr_guide',
    nextCheckAt: at(110),
    lastActivityAt: at(20),
    updatedAt: at(20),
  },
  {
    ...itemBase,
    id: 'item_plan',
    title: 'Plan the import',
    status: 'done',
    assigneeBotId: 'bot_kevin',
    assigneeName: 'Kevin',
    gen: 2,
    result: 'Three items: schema, access, guide.',
    closedBy: 'bot_kevin',
    threadId: null,
    nextCheckAt: null,
    lastActivityAt: at(10),
    updatedAt: at(10),
    closedAt: at(10),
  },
];

export const teamDetail: TeamDetail = {
  team,
  items,
  events: [
    { seq: 12, teamId: 'team_atlas', itemId: 'item_key', gen: 2, kind: 'escalated', actor: { kind: 'boton', botId: 'bot_kevin', name: 'Kevin' }, detail: 'The importer needs the export key.', at: at(75) },
    { seq: 9, teamId: 'team_atlas', itemId: 'item_key', gen: 2, kind: 'blocked', actor: { kind: 'boton', botId: 'bot_stuart', name: 'Stuart' }, detail: 'The export needs a key only Sam has.', at: at(40) },
    { seq: 1, teamId: 'team_atlas', itemId: null, gen: null, kind: 'team_created', actor: { kind: 'owner', botId: null, name: 'Sam' }, detail: '', at: at(0) },
  ],
};

export const itemDetail: TeamItemDetail = { item: items[1]!, events: teamDetail.events.filter((e) => e.itemId === 'item_key') };

export const threads: TeamThread[] = [
  {
    id: 'thr_schema',
    teamId: 'team_atlas',
    teamName: 'Atlas',
    itemId: 'item_schema',
    itemTitle: 'Map the export to the new schema',
    subject: 'Map the export to the new schema',
    participants: [
      { botId: 'bot_kevin', name: 'Kevin' },
      { botId: 'bot_stuart', name: 'Stuart' },
    ],
    messageCount: 2,
    lastSeq: 31,
    lastAt: at(80),
    last: { fromName: 'Stuart', toName: 'Kevin', text: 'Mapped 14 of 20 tables; the rest need the key.' },
    lastDelivery: { state: 'handled', outcome: 'replied', waitingOn: null, chatMessageId: 'msg_req', botId: 'bot_stuart', queuedAt: at(30), at: at(80) },
    unread: true,
    closedAt: null,
  },
  {
    id: 'thr_direct',
    teamId: null,
    teamName: null,
    itemId: null,
    itemTitle: null,
    subject: 'Which timezone does the report use?',
    participants: [
      { botId: 'bot_dave', name: 'Dave' },
      { botId: 'bot_bob', name: 'Bob' },
    ],
    messageCount: 1,
    lastSeq: 25,
    lastAt: at(60),
    last: { fromName: 'Dave', toName: 'Bob', text: 'Which timezone does the report use?' },
    lastDelivery: { state: 'queued', outcome: null, waitingOn: 'paused', chatMessageId: null, botId: 'bot_bob', queuedAt: at(60), at: at(60) },
    unread: false,
    closedAt: null,
  },
];

export const messages: TeamMessage[] = [
  {
    seq: 30,
    id: 'tmsg_assign',
    threadId: 'thr_schema',
    teamId: 'team_atlas',
    itemId: 'item_schema',
    itemGen: 1,
    kind: 'request',
    from: { botId: 'bot_kevin', name: 'Kevin' },
    to: { botId: 'bot_stuart', name: 'Stuart' },
    text: 'Please map the export to the new schema. Mark it done with the mapping file.',
    hop: 1,
    inReplyTo: null,
    stale: false,
    createdAt: at(30),
    delivery: { state: 'handled', outcome: 'replied', waitingOn: null, chatMessageId: 'msg_req', botId: 'bot_stuart', queuedAt: at(30), at: at(80) },
  },
  {
    seq: 31,
    id: 'tmsg_reply',
    threadId: 'thr_schema',
    teamId: 'team_atlas',
    itemId: 'item_schema',
    itemGen: 1,
    kind: 'reply',
    from: { botId: 'bot_stuart', name: 'Stuart' },
    to: { botId: 'bot_kevin', name: 'Kevin' },
    text: 'Mapped 14 of 20 tables; the rest need the key.',
    hop: 1,
    inReplyTo: 'tmsg_assign',
    stale: false,
    createdAt: at(80),
    delivery: null,
  },
  {
    seq: 32,
    id: 'tmsg_system',
    threadId: 'thr_schema',
    teamId: 'team_atlas',
    itemId: 'item_schema',
    itemGen: 1,
    kind: 'system',
    from: { botId: null, name: 'Botons' },
    to: { botId: null, name: '' },
    text: "Stuart's turn ended without marking item_schema done or blocked.",
    hop: 1,
    inReplyTo: null,
    stale: false,
    createdAt: at(80),
    delivery: null,
  },
];

export const threadDetail: TeamThreadDetail = { thread: threads[0]!, team, item: items[0]! };

export const attention: TeamsAttention = { count: 2, unreadThreads: 2 };

export const searchHits: TeamSearchHit[] = [
  { threadId: 'thr_schema', messageId: 'tmsg_reply', seq: 31, teamId: 'team_atlas', itemId: 'item_schema', subject: 'Map the export to the new schema', from: 'Stuart', to: 'Kevin', snippet: '…Mapped 14 of 20 tables; the rest need the key.', at: at(80) },
];

export const actionResult: TeamItemActionResult = { item: items[0]!, duplicate: false };

export const askQueued: AskResult = { message: null, threadId: 'thr_schema', hop: 1, duplicate: false, state: 'queued', teamMessageId: 'tmsg_queued', ahead: 3 };

export const botTeams: BotTeamsView = {
  teams: [{ team, role: 'member', roleTitle: 'Backend', responsibilities: 'The importer and the schema.', items: items.filter((i) => i.assigneeBotId === 'bot_stuart') }],
};

export const events: ServerEvent[] = [
  { type: 'team.upserted', team },
  { type: 'team.item.upserted', item: items[0]! },
  { type: 'team.thread.upserted', thread: threads[0]! },
  { type: 'team.message.created', message: messages[1]! },
  { type: 'teams.attention', attention },
  { type: 'team.deleted', teamId: 'team_old' },
];

/** File name → value: what the JSON files beside this one hold. */
export const FILES: Record<string, unknown> = {
  'teams.json': [team, doneTeam],
  'team-detail.json': teamDetail,
  'team-item.json': itemDetail,
  'team-threads.json': threads,
  'team-thread.json': threadDetail,
  'team-messages.json': messages,
  'teams-attention.json': attention,
  'teams-search.json': searchHits,
  'team-item-action.json': actionResult,
  'ask-queued.json': askQueued,
  'bot-teams.json': botTeams,
  'team-events.json': events,
};
