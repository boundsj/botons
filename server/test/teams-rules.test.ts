import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TEAM_LIFETIME,
  TEAM_LIMITS,
  TEAM_LIMIT_DEFAULTS,
  actorFor,
  addEvidence,
  afterCheckinMs,
  assess,
  assessTeam,
  audienceOf,
  boardGroup,
  chooseAudience,
  completionRefusal,
  deliveryLine,
  itemStatusLine,
  leadEscalationRefusal,
  limitsRefusal,
  scopeRefusal,
  teamLimits,
  transitionRefusal,
  type AssessFacts,
  type AssessItem,
} from '../../shared/teams.ts';
import type { TeamItem } from '../../shared/types.ts';

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const limits = TEAM_LIMIT_DEFAULTS;

const idle: AssessFacts = { assignee: 'idle', requestOpen: false, waitingOwner: false, usageLimitUntil: null, teammateAsked: false, teamPaused: false };
const working = (over: Partial<AssessItem> = {}): AssessItem => ({
  status: 'working',
  assigneeBotId: 'bot_stuart',
  nudges: 0,
  lastActivityAt: iso(T0),
  genStartedAt: iso(T0),
  held: null,
  escalation: null,
  lifetime: { attempts: 1, checkins: 0, escalations: 0 },
  ...over,
});

const item = (over: Partial<TeamItem> = {}) =>
  ({ id: 'item_a', status: 'open', assigneeBotId: 'bot_stuart', assigneeName: 'Stuart', held: null, lifetime: { attempts: 0, checkins: 0, escalations: 0 }, attempts: 0, gen: 1, ...over }) as TeamItem;

test('the one schedule: first check-in when the stall holds, then stallAfter × 2^n, escalation at the look after the third (0:30, 1:30, 3:30, 7:30)', () => {
  assert.deepEqual([1, 2, 3].map((n) => afterCheckinMs(n, limits) / MIN), [60, 120, 240]);
  // Walk a stuck item through the supervisor: each look happens at the time the previous one set.
  let it = working();
  let now = T0;
  const looks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = assess(it, idle, now, limits);
    if (a.kind === 'wait') {
      now = Date.parse(a.at);
      continue;
    }
    looks.push(`${a.kind}@${(now - T0) / MIN}`);
    if (a.kind !== 'checkin') break;
    it = { ...it, nudges: it.nudges + 1, lifetime: { ...it.lifetime, checkins: it.lifetime.checkins + 1 } };
    now += afterCheckinMs(it.nudges, limits);
  }
  assert.deepEqual(looks, ['checkin@30', 'checkin@90', 'checkin@210', 'escalate@450']);
});

test('progress keeps an item from stalling but never takes back a check-in; block keeps the count too', () => {
  const after1 = working({ nudges: 1, lastActivityAt: iso(T0 + 80 * MIN) });
  const a = assess(after1, idle, T0 + 90 * MIN, limits);
  assert.deepEqual(a, { kind: 'wait', at: iso(T0 + 110 * MIN) }, 'recent progress: look again a stall time after it');
  assert.deepEqual(assess(after1, idle, T0 + 110 * MIN, limits), { kind: 'checkin', reason: 'stalled' });
  // Progress every 20 minutes forever still meets the age bound.
  const chatty = working({ lastActivityAt: iso(T0 + TEAM_LIMITS.genOverdueMs - MIN) });
  assert.deepEqual(assess(chatty, idle, T0 + TEAM_LIMITS.genOverdueMs, limits), { kind: 'checkin', reason: 'overdue' });
  const blocked = working({ status: 'blocked', nudges: 2 });
  assert.deepEqual(assess(blocked, idle, T0 + 999 * MIN, limits), { kind: 'checkin', reason: 'blocked' });
  assert.deepEqual(assess({ ...blocked, nudges: 3 }, idle, T0 + 999 * MIN, limits), { kind: 'escalate' });
});

test('not started counts from the assignment, unassigned too; a missing assignee is reported at once', () => {
  const open = working({ status: 'open' });
  assert.deepEqual(assess(open, idle, T0 + 5 * MIN, limits), { kind: 'wait', at: iso(T0 + 15 * MIN) });
  assert.deepEqual(assess(open, idle, T0 + 15 * MIN, limits), { kind: 'checkin', reason: 'not_started' });
  assert.deepEqual(assess({ ...open, assigneeBotId: null }, { ...idle, assignee: 'missing' }, T0 + 15 * MIN, limits), { kind: 'checkin', reason: 'unassigned' });
  assert.deepEqual(assess(open, { ...idle, assignee: 'missing' }, T0 + MIN, limits), { kind: 'checkin', reason: 'unavailable' });
});

test('justified waits are holds, never stalls: running, queued, in flight, approval, usage limit, paused, a teammate, the team paused, an escalation, held', () => {
  const late = T0 + 1000 * MIN;
  const it = working();
  const hold = (facts: Partial<AssessFacts>, over: Partial<AssessItem> = {}) => {
    const a = assess({ ...it, ...over }, { ...idle, ...facts }, late, limits);
    return a.kind === 'hold' ? a.waiting : a.kind;
  };
  assert.equal(hold({ assignee: 'running' }), 'running');
  assert.equal(hold({ assignee: 'queued' }), 'running');
  assert.equal(hold({ requestOpen: true }), 'running');
  assert.equal(hold({ waitingOwner: true }), 'approval');
  assert.equal(hold({ usageLimitUntil: iso(late + 60 * MIN) }), 'usage_limit');
  assert.equal(hold({ usageLimitUntil: iso(late - MIN) }), 'checkin', 'a limit that has reset holds nothing');
  assert.equal(hold({ assignee: 'paused' }), 'paused');
  assert.equal(hold({ teammateAsked: true }), 'teammate');
  assert.equal(hold({ teamPaused: true }), 'team_paused');
  assert.equal(hold({}, { escalation: { cardMessageId: 'msg_c', botId: 'bot_kevin', by: 'lead', summary: 's', need: 'n', at: iso(T0) } }), 'owner');
  assert.equal(hold({}, { held: 'owner' }), 'held');
  // Past the age bound, work going on no longer holds the item: the lead hears it is overdue. A pause, a usage
  // limit, the team paused, an escalation and a hold still come first.
  const old = T0 + TEAM_LIMITS.genOverdueMs;
  const aged = (facts: Partial<AssessFacts>, over: Partial<AssessItem> = {}) => {
    const a = assess({ ...it, lastActivityAt: iso(old - MIN), ...over }, { ...idle, ...facts }, old, limits);
    return a.kind === 'hold' ? a.waiting : a.kind === 'checkin' ? a.reason : a.kind;
  };
  for (const f of [{ assignee: 'running' }, { assignee: 'queued' }, { requestOpen: true }, { waitingOwner: true }, { teammateAsked: true }] as Partial<AssessFacts>[]) {
    assert.equal(aged(f), 'overdue', JSON.stringify(f));
  }
  assert.equal(aged({ assignee: 'paused' }), 'paused');
  assert.equal(aged({ usageLimitUntil: iso(old + 60 * MIN) }), 'usage_limit');
  assert.equal(aged({ teamPaused: true }), 'team_paused');
  assert.equal(aged({}, { held: 'owner' }), 'held');
  assert.equal(aged({}, { escalation: { cardMessageId: 'msg_c', botId: 'bot_kevin', by: 'lead', summary: 's', need: 'n', at: iso(T0) } }), 'owner');
  // A blocked item has no age bound: an approval still holds it.
  assert.equal(aged({ waitingOwner: true }, { status: 'blocked' }), 'approval');
  const usage = assess(it, { ...idle, usageLimitUntil: iso(late + 60 * MIN) }, late, limits);
  assert.deepEqual(usage, { kind: 'hold', waiting: 'usage_limit', at: iso(late + 65 * MIN) });
  assert.deepEqual(assess({ ...it, status: 'done' }, idle, late, limits), { kind: 'none' });
});

test('lifetime bounds end every loop: check-ins and escalations past their bound hold the item for the owner', () => {
  // At the check-in bound the item is held (it waits for the owner), never escalated again: with or without nudges.
  const capped = working({ nudges: 1, lifetime: { attempts: 3, checkins: TEAM_LIFETIME.checkins, escalations: 0 } });
  assert.deepEqual(assess(capped, idle, T0 + 999 * MIN, limits), { kind: 'held' });
  assert.deepEqual(assess({ ...capped, nudges: 0 }, idle, T0 + 999 * MIN, limits), { kind: 'held' });
  assert.deepEqual(assess({ ...capped, nudges: TEAM_LIMITS.maxNudges }, idle, T0 + 999 * MIN, limits), { kind: 'held' });
  // At the escalation bound too, also before the nudge cap.
  const escalated = working({ nudges: 1, lifetime: { attempts: 3, checkins: 5, escalations: TEAM_LIFETIME.escalations } });
  assert.deepEqual(assess(escalated, idle, T0 + 999 * MIN, limits), { kind: 'held' });
  // Under both bounds: the nudge cap escalates, and short of it a check-in comes.
  const under = working({ nudges: TEAM_LIMITS.maxNudges, lifetime: { attempts: 3, checkins: TEAM_LIFETIME.checkins - 1, escalations: TEAM_LIFETIME.escalations - 1 } });
  assert.deepEqual(assess(under, idle, T0 + 999 * MIN, limits), { kind: 'escalate' });
  assert.deepEqual(assess({ ...under, nudges: 1 }, idle, T0 + 999 * MIN, limits), { kind: 'checkin', reason: 'stalled' });
  const lead = { teamState: 'active' as const, maxAttempts: 3 };
  assert.equal(transitionRefusal('retry', 'lead', item({ status: 'blocked', attempts: 3 }), lead)?.code, 'limit');
  assert.equal(transitionRefusal('assign', 'lead', item({ lifetime: { attempts: TEAM_LIFETIME.attempts, checkins: 0, escalations: 0 } }), { ...lead, input: { assigneeBotId: 'bot_bob' } })?.code, 'limit');
  assert.equal(transitionRefusal('retry', 'owner', item({ status: 'blocked', attempts: 3 }), lead), null, 'the owner is not bound by attempts');
  assert.equal(transitionRefusal('progress', 'assignee', { ...item({ status: 'working' }), progressNotes: TEAM_LIFETIME.progressPerGen }, { ...lead, input: { note: 'x' } })?.code, 'limit');
  // Held: nothing gives it out again, but the assignee ends its own work (a result is never lost) and the lead may cancel.
  const held = (status: TeamItem['status']) => item({ status, held: 'owner' });
  assert.equal(transitionRefusal('assign', 'lead', held('open'), { ...lead, input: { assigneeBotId: 'bot_bob' } })?.code, 'limit');
  assert.equal(transitionRefusal('retry', 'lead', held('blocked'), lead)?.code, 'limit');
  assert.equal(transitionRefusal('reopen', 'lead', held('done'), lead)?.code, 'limit');
  assert.equal(transitionRefusal('start', 'assignee', held('open'), lead), null);
  assert.equal(transitionRefusal('progress', 'assignee', held('working'), { ...lead, input: { note: 'x' } }), null);
  assert.equal(transitionRefusal('block', 'assignee', held('working'), { ...lead, input: { reason: 'x', need: 'owner' } }), null);
  assert.equal(transitionRefusal('done', 'assignee', held('working'), { ...lead, input: { result: 'the result' } }), null);
  assert.equal(transitionRefusal('cancel', 'lead', held('working'), { ...lead, input: { reason: 'x' } }), null);
  assert.equal(transitionRefusal('reopen', 'owner', held('done'), lead), null, 'the owner may');
});

test('team-wide wakes are looked at apart from items: kickoff with no items, all done with every item finished (no item has a next check)', () => {
  const counts = { open: 0, working: 0, blocked: 0, done: 0, cancelled: 0 };
  const team = { state: 'active' as const, counts, kickoffToldAt: null, wrapupToldAt: null, lastTerminalAt: null };
  assert.equal(assessTeam(team), 'kickoff');
  assert.equal(assessTeam({ ...team, kickoffToldAt: iso(T0) }), null);
  const finished = { ...team, kickoffToldAt: iso(T0), counts: { ...counts, done: 2, cancelled: 1 }, lastTerminalAt: iso(T0 + MIN) };
  assert.equal(assessTeam(finished), 'all_done');
  assert.equal(assessTeam({ ...finished, wrapupToldAt: iso(T0 + 2 * MIN) }), null, 'told once');
  assert.equal(assessTeam({ ...finished, wrapupToldAt: iso(T0 + 2 * MIN), lastTerminalAt: iso(T0 + 3 * MIN) }), 'all_done', 'again after a reopened item finishes');
  assert.equal(assessTeam({ ...finished, counts: { ...counts, cancelled: 2 } }), null, 'only cancelled is not done');
  assert.equal(assessTeam({ ...finished, state: 'paused' }), null);
});

test('who may do what: the transition table by role, a lead holding its own item, and a paused team', () => {
  const ctx = { teamState: 'active' as const, maxAttempts: 3 };
  assert.equal(transitionRefusal('assign', 'member', item(), { ...ctx, input: { assigneeBotId: 'bot_bob' } })?.code, 'not_allowed');
  assert.equal(transitionRefusal('cancel', 'assignee', item(), { ...ctx, input: { reason: 'x' } })?.code, 'not_allowed');
  assert.equal(transitionRefusal('start', 'assignee', item(), ctx), null);
  assert.equal(transitionRefusal('start', 'lead', item(), { ...ctx, leadIsAssignee: true }), null);
  assert.equal(transitionRefusal('start', 'lead', item(), ctx)?.code, 'not_allowed');
  assert.equal(transitionRefusal('block', 'assignee', item(), { ...ctx, input: { reason: 'no access', need: 'boss' } })?.code, 'not_allowed');
  assert.equal(transitionRefusal('done', 'assignee', item({ status: 'working' }), ctx)?.message, 'done needs --result.');
  assert.equal(transitionRefusal('reopen', 'lead', item({ status: 'open' }), ctx)?.code, 'not_allowed');
  const paused = { ...ctx, teamState: 'paused' as const };
  assert.equal(transitionRefusal('assign', 'lead', item(), { ...paused, input: { assigneeBotId: 'bot_bob' } })?.code, 'team_not_active');
  assert.equal(transitionRefusal('done', 'assignee', item({ status: 'working' }), { ...paused, input: { result: 'shipped' } }), null, 'a running turn can still end its work');
  assert.equal(transitionRefusal('done', 'lead', item({ status: 'working' }), { ...ctx, teamState: 'done', input: { result: 'x' } })?.code, 'team_not_active');
  assert.equal(actorFor({ botId: 'bot_kevin', leadBotId: 'bot_kevin', assigneeBotId: 'bot_kevin' }), 'lead');
  assert.equal(actorFor({ botId: 'bot_bob', leadBotId: 'bot_kevin', assigneeBotId: 'bot_stuart' }), 'member');
});

test('assignment fencing: a turn acts only on the gens it started with or made, reading changes nothing, and each refusal says not to retry', () => {
  const it = item({ gen: 3, status: 'working', assigneeName: 'Stuart' });
  assert.equal(scopeRefusal(new Map([['item_a', 3]]), it, 'assignee'), null);
  const old = scopeRefusal(new Map([['item_a', 2]]), it, 'assignee');
  assert.equal(old?.code, 'replaced');
  assert.match(old!.message, /Assignment 2 of item_a was replaced \(now assignment 3, working, Stuart\)/);
  assert.equal(scopeRefusal(new Map([['item_a', 2]]), it, 'lead')?.code, 'changed');
  const later = scopeRefusal(new Map(), it, 'assignee');
  assert.equal(later?.code, 'not_in_turn');
  assert.match(later!.message, /don't act on it in this turn/);
  assert.equal(scopeRefusal(null, it, 'assignee')?.code, 'not_in_turn');
  assert.equal(scopeRefusal(null, it, 'owner'), null);
});

test('escalation gates: evidence the server recorded, something tried unless the owner is needed, every field, one budget', () => {
  const base = { id: 'item_a', status: 'blocked' as const, attempts: 1, nudges: 0, blockedNeed: 'lead' as const, evidence: [], escalation: null, gen: 2, assigneeName: 'Stuart' };
  const input = { summary: 'Importer needs a key', tried: 'Retried once', need: 'Add the key to the shared folder' };
  const ctx = { maxAttempts: 3, leadTried: false, escalationsToday: 0, input };
  assert.match(leadEscalationRefusal(base, ctx)!.message, /^Nothing on record shows this is blocked/);
  const evidence = addEvidence([], { kind: 'blocked', gen: 2, detail: 'no key', at: iso(T0) });
  assert.match(leadEscalationRefusal({ ...base, evidence }, ctx)!.message, /^Try something first/);
  assert.equal(leadEscalationRefusal({ ...base, evidence, blockedNeed: 'owner' }, ctx), null);
  assert.equal(leadEscalationRefusal({ ...base, evidence }, { ...ctx, leadTried: true }), null);
  assert.match(leadEscalationRefusal({ ...base, evidence }, { ...ctx, leadTried: true, input: { ...input, tried: ' ' } })!.message, /--tried/);
  assert.equal(leadEscalationRefusal({ ...base, evidence }, { ...ctx, leadTried: true, escalationsToday: 5 })?.code, 'limit');
  assert.equal(leadEscalationRefusal({ ...base, evidence: addEvidence([], { kind: 'blocked', gen: 1, detail: '', at: iso(T0) }) }, { ...ctx, leadTried: true })?.code, 'gate', 'evidence of an older gen does not count');
  assert.equal(leadEscalationRefusal({ ...base, status: 'working' as never, evidence }, { ...ctx, leadTried: true })?.code, 'gate');
  // Evidence keeps only facts, only of the current gen, at most six.
  let list = addEvidence([], { kind: 'progress', gen: 2, detail: '', at: iso(T0) });
  assert.deepEqual(list, []);
  for (let i = 0; i < 9; i++) list = addEvidence(list, { kind: 'checkin', gen: 2, detail: String(i), at: iso(T0 + i) });
  assert.deepEqual(list.map((e) => e.detail), ['3', '4', '5', '6', '7', '8']);
  assert.deepEqual(addEvidence(list, { kind: 'stalled', gen: 3, detail: 'x', at: iso(T0) }).map((e) => e.gen), [3]);
});

test('finishing a team is reviewable: nothing live, something done, a summary, and a scope when the lead cancelled work', () => {
  const ctx = { leadBotId: 'bot_kevin', summary: 'Shipped the importer' };
  assert.match(completionRefusal([{ id: 'item_a', status: 'working', closedBy: null }], ctx)!.message, /item_a is not finished/);
  assert.match(completionRefusal([{ id: 'item_a', status: 'cancelled', closedBy: 'bot_kevin' }], ctx)!.message, /No item is done/);
  const mixed = [
    { id: 'item_a', status: 'done' as const, closedBy: 'bot_stuart' },
    { id: 'item_b', status: 'cancelled' as const, closedBy: 'bot_kevin' },
  ];
  assert.match(completionRefusal(mixed, ctx)!.message, /--scope/);
  assert.equal(completionRefusal(mixed, { ...ctx, scope: 'Docs moved to next month' }), null);
  assert.equal(completionRefusal([mixed[0]!, { ...mixed[1]!, closedBy: 'owner' }], ctx), null, "the owner's cancel needs no scope from the lead");
  assert.match(completionRefusal([mixed[0]!], { leadBotId: 'bot_kevin' })!.message, /--summary/);
});

test('the owner first, with starvation bounded at ten minutes, and audiences that keep team turns apart', () => {
  const at = (min: number) => iso(T0 + min * MIN);
  assert.equal(chooseAudience([], T0), null);
  assert.equal(chooseAudience([{ audience: 'ask:bot_kevin', createdAt: at(0) }, { audience: 'owner', createdAt: at(1) }], T0 + 2 * MIN), 'owner');
  assert.equal(chooseAudience([{ audience: 'ask:bot_kevin', createdAt: at(0) }, { audience: 'owner', createdAt: at(1) }], T0 + 10 * MIN), 'ask:bot_kevin');
  assert.equal(chooseAudience([{ audience: 'team:team_a', createdAt: at(0) }], T0), 'team:team_a');
  assert.equal(audienceOf({ kind: 'ask', fromBotId: 'bot_kevin' }), 'ask:bot_kevin');
  assert.equal(audienceOf({ kind: 'team.checkin', teamId: 'team_a' }), 'team:team_a');
  assert.equal(audienceOf({ kind: 'ask.reply', teamId: 'team_a' }), 'team:team_a');
  assert.equal(audienceOf({ kind: 'ask.reply' }), 'owner', 'a Direct reply is the owner-facing turn it always was');
  assert.equal(audienceOf(null), 'owner');
});

test('limits read leniently and change within bounds only', () => {
  assert.deepEqual(teamLimits({ maxAttempts: 5, stallAfterMs: 1, extra: 3 }), { ...TEAM_LIMIT_DEFAULTS, maxAttempts: 5 });
  assert.deepEqual(teamLimits('nope'), TEAM_LIMIT_DEFAULTS);
  assert.equal(limitsRefusal({ maxAttempts: 4 }), null);
  assert.match(limitsRefusal({ maxAttempts: 40 })!, /from 1 to 6/);
  assert.match(limitsRefusal({ maxNudges: 4 })!, /Unknown limit/);
});

test('words: status lines, delivery lines and board groups', () => {
  const base = { status: 'working' as const, assigneeName: 'Stuart', blockedNeed: null, blockedReason: null, waiting: null, nudges: 0, lastActivityAt: iso(T0 - 12 * MIN), escalation: null, held: null };
  assert.equal(itemStatusLine(base, T0), 'working · updated 12m ago');
  assert.equal(itemStatusLine({ ...base, nudges: 2 }, T0), 'working · updated 12m ago · check-in 2 of 3');
  assert.equal(itemStatusLine({ ...base, waiting: 'approval' }, T0), 'waiting for you: approval');
  assert.equal(itemStatusLine({ ...base, status: 'blocked', blockedNeed: 'lead' }, T0, 'Kevin'), 'blocked: needs Kevin');
  assert.equal(itemStatusLine({ ...base, status: 'open', assigneeName: null }, T0), 'open · not assigned');
  assert.equal(deliveryLine({ state: 'queued', outcome: null, waitingOn: 'paused', at: iso(T0) }, 'Stuart'), 'Waiting: Stuart is paused');
  assert.equal(deliveryLine({ state: 'handled', outcome: 'replied', waitingOn: null, queuedAt: iso(T0), at: iso(T0 + 2 * MIN) }, 'Stuart'), 'Answered in 2m');
  assert.equal(deliveryLine({ state: 'handled', outcome: 'failed', waitingOn: null, at: iso(T0) }, 'Stuart'), 'Could not answer');
  assert.equal(boardGroup({ status: 'blocked', blockedNeed: 'owner', escalation: null, held: null }), 'needs_you');
  assert.equal(boardGroup({ status: 'cancelled', blockedNeed: null, escalation: null, held: null }), 'done');
});

test('the contract fixtures the web and native apps build against are the typed ones', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { FILES } = await import('./fixtures/teams/contract.ts');
  const dir = join(import.meta.dirname, 'fixtures/teams');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.json')).sort(), Object.keys(FILES).sort());
  for (const [name, value] of Object.entries(FILES)) assert.deepEqual(JSON.parse(readFileSync(join(dir, name), 'utf8')), value, name);
});
