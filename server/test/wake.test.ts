// Which automatic wake-ups the transcript leaves out, and the labels the others get (shared/wake.ts), run in Node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, MessageMeta, MessageRole, WorkEvent } from '../../shared/types.ts';
import { backgroundText, isAutomaticWake, jobTitle, parseQuiet, pullRequestOf, quietMessageIds, routineLabel, TURN_ACTIVITY, wakeLabel, workLabel } from '../../shared/wake.ts';

let seq = 0;
const msg = (role: MessageRole, text: string, meta: MessageMeta | null = null): Message => ({ id: `msg_${++seq}`, botId: 'bot_kevin', role, text, meta, createdAt: new Date(1_800_000_000_000 + seq * 1000).toISOString() });

const WAKES: Record<string, MessageMeta> = {
  'work.event': { kind: 'work.event', work: { connectorId: 'oauth:fleet', jobId: 'job_abc123', kind: 'finished', state: 'idle', link: null } },
  ask: { kind: 'ask', fromBotId: 'bot_stuart', fromBotName: 'Stuart' },
  'ask.reply': { kind: 'ask.reply', fromBotId: 'bot_stuart', fromBotName: 'Stuart' },
  'approval.decided': { kind: 'approval.decided', decision: 'allowed', approvalTitle: 'Deploy' },
  'connector.granted': { kind: 'connector.granted', connectorId: 'oauth:fleet' },
  'reaction.followup': { kind: 'reaction.followup', emoji: '👎' } as MessageMeta,
};

test('wake-ups are the messages the server wrote to start a turn; the owner’s and their card answers are not', () => {
  for (const [kind, meta] of Object.entries(WAKES)) assert.ok(isAutomaticWake(msg('user', 'x', meta)), kind);
  assert.equal(isAutomaticWake(msg('user', 'Hello Kevin')), false);
  assert.equal(isAutomaticWake(msg('user', 'Yes', { kind: 'card.answered', cardId: 'msg_card' })), false);
  for (const role of ['bot', 'event', 'error'] as const) assert.equal(isAutomaticWake(msg(role, 'x', WAKES['work.event'])), false, role);
});

for (const [kind, meta] of Object.entries(WAKES)) {
  test(`${kind}: quiet leaves the wake-up out, not quiet keeps it and its reply`, () => {
    const quiet = msg('user', 'wake', { ...meta, quiet: true });
    const owner = msg('user', 'Thanks');
    assert.deepEqual([...quietMessageIds([owner, quiet])], [quiet.id]);
    const loud = msg('user', 'wake', meta);
    const reply = msg('bot', 'The job finished: all tests pass.');
    assert.equal(quietMessageIds([loud, reply]).size, 0);
  });
  test(`${kind}: what the server marked of a quiet turn leaves with it, whatever else is loaded`, () => {
    const before = msg('bot', 'Earlier answer');
    const wake = msg('user', 'wake', { ...meta, quiet: true });
    const chip = msg('event', 'Saved to memory', { kind: 'memory.saved', byTurn: 'turn_1', quiet: true });
    const shared = msg('event', 'Shared notes.md', { kind: 'file.shared', byTurn: 'turn_1', quiet: true });
    const reply = msg('bot', '[quiet] nothing new', { quiet: true });
    // Unmarked, [quiet] text is the server's to decide (it reads the turn records, not this page).
    const unmarked = msg('bot', '[quiet] older');
    assert.deepEqual([...quietMessageIds([before, wake, chip, shared, reply, unmarked])].sort(), [wake.id, chip.id, shared.id, reply.id].sort());
    assert.deepEqual([...quietMessageIds([chip])], [chip.id], 'on a page of its own');
  });
}

test('never left out: the owner’s messages, card answers, errors, approval cards, failed turns', () => {
  const owner = msg('user', 'Ping', { quiet: true });
  const answer = msg('user', 'Yes', { kind: 'card.answered', cardId: 'c', quiet: true });
  const error = msg('error', 'The CLI crashed', { quiet: true });
  const card = msg('event', 'Approve?', { kind: 'approval.requested', quiet: true });
  const posted = msg('event', 'Posted a card: pick', { kind: 'card.posted', quiet: true });
  const stopped = msg('event', 'Stopped', { kind: 'turn.stopped', quiet: true });
  const refused = msg('event', 'Refused', { kind: 'ask.refused', quiet: true });
  assert.equal(quietMessageIds([posted, stopped, refused]).size, 0);
  // A wake-up whose turn failed: its error follows it, and both show.
  const wake = msg('user', 'wake', WAKES['work.event']);
  const failed = msg('error', 'Stopped: the turn ran past its time limit');
  assert.equal(quietMessageIds([owner, answer, error, card, wake, failed]).size, 0);
  // A [quiet] reply that answered the owner (no reaction, so it was posted) stays, as does a mixed turn's.
  const asked = msg('user', 'Anything?');
  const quietReply = msg('bot', '[quiet]');
  assert.equal(quietMessageIds([asked, quietReply]).size, 0);
  const mixedWake = msg('user', 'wake', WAKES.ask);
  const mixedOwner = msg('user', 'And this?');
  assert.equal(quietMessageIds([mixedWake, mixedOwner, msg('bot', '[quiet] ok')]).size, 0);
  // Words after [quiet] that aren't a note: a reply.
  assert.equal(quietMessageIds([msg('user', 'w', WAKES.ask), msg('bot', '[quiet]er things')]).size, 0);
});

for (const trigger of ['schedule', 'manual', 'webhook'] as const) {
  test(`${trigger} routine: a quiet reply marked with its run chip leaves with it; a real one shows`, () => {
    const meta = { kind: 'routine.run', routineId: 'rt_1', routineName: 'Deploy watch', runId: `run_${trigger}`, trigger } as MessageMeta;
    const chip = msg('event', 'Ran routine', { ...meta, quiet: true });
    const reply = msg('bot', '[quiet] all clear', { routineId: 'rt_1', routineName: 'Deploy watch', runId: `run_${trigger}`, quiet: true });
    const other = msg('event', 'Ran routine', { ...meta, runId: 'run_other' });
    const real = msg('bot', 'The deploy failed on step 3.', { routineId: 'rt_1', routineName: 'Deploy watch', runId: 'run_other' });
    assert.deepEqual([...quietMessageIds([chip, reply, other, real])].sort(), [chip.id, reply.id].sort());
  });
}

test('parseQuiet takes the marker and a note only', () => {
  assert.equal(parseQuiet('[quiet]'), '');
  assert.equal(parseQuiet('  **[QUIET]** — nothing new'), 'nothing new');
  assert.equal(parseQuiet('[quiet]er'), null);
  assert.equal(parseQuiet('Done. [quiet]'), null);
});

const work = (over: Partial<WorkEvent> = {}): WorkEvent => ({ connectorId: 'oauth:fleet', jobId: 'job_7f3a9c1e', kind: 'finished', state: 'idle', link: null, eventId: '42', ...over });

test('a work update reads as its connector, a pull request when its link is one, and what happened; ids only in the tooltip', () => {
  const pr = workLabel(work({ link: 'https://github.com/example/app/pull/128' }));
  assert.equal(pr.text, 'fleet: PR #128 finished');
  assert.match(pr.detail, /job_7f3a9c1e/);
  assert.match(pr.detail, /state idle/);
  assert.equal(workLabel(work({ link: 't3-thread://v1/thr-kevin' })).text, 'fleet: work finished');
  assert.equal(workLabel(work({ kind: 'needs_input', state: 'needs_input' })).text, 'fleet: work needs input');
  const failed = workLabel(work({ kind: 'failed' }));
  assert.equal(failed.text, 'fleet: work failed');
  assert.equal(failed.warn, true);
  assert.equal(workLabel(work({ kind: 'cancelled', state: null })).text, 'fleet: work was cancelled');
  assert.equal(workLabel(work({ kind: 'delegated_ended' })).text, 'fleet: delegated work ended');
  assert.equal(workLabel(work({ connectorId: '' })).text, 'A connector: work finished');
  assert.equal(workLabel(undefined).text, 'Work update');
  for (const k of ['finished', 'needs_input', 'failed', 'cancelled', 'delegated_ended'] as const) {
    for (const link of [null, 'https://github.com/example/app/pull/9', 'https://example.com/jobs/job_7f3a9c1e']) {
      assert.ok(!workLabel(work({ kind: k, link })).text.includes('job_7f3a9c1e'), `${k} ${link}: no job id`);
    }
  }
  assert.equal(pullRequestOf('https://gitlab.example.com/group/app/merge_requests/7'), 'PR #7');
  assert.equal(pullRequestOf('https://github.com/example/app/issues/7'), null);
  assert.equal(pullRequestOf(null), null);
});

test('a routine run reads as Routine: its name, how it started when not by schedule, and a retry; never its run id', () => {
  const base = { kind: 'routine.run', routineId: 'rt_1', routineName: 'Deploy watch', runId: 'run_9z8y7x' } as MessageMeta;
  assert.equal(routineLabel({ ...base, trigger: 'schedule' }).text, 'Routine: Deploy watch');
  assert.equal(routineLabel({ ...base, trigger: 'manual' }).text, 'Routine: Deploy watch · manual');
  assert.equal(routineLabel({ ...base, trigger: 'webhook', attempt: 2 }).text, 'Routine: Deploy watch · webhook · attempt 2');
  assert.equal(routineLabel({ ...base, routineName: '  ' }).text, 'Routine: a routine');
  assert.equal(routineLabel(null).text, 'Routine: a routine');
  for (const t of ['schedule', 'manual', 'webhook', 'test'] as const) assert.ok(!routineLabel({ ...base, trigger: t }).text.includes('run_9z8y7x'));
  assert.match(routineLabel(base).detail, /run_9z8y7x/);
});

test('the background line', () => {
  const at = (iso: string) => `at ${iso.slice(11, 16)}`;
  assert.equal(backgroundText({ lastHour: 0, quietLastHour: 0, lastAt: null }, at), null);
  assert.equal(backgroundText({ lastHour: 0, quietLastHour: 0, lastAt: '2026-11-08T09:15:00.000Z' }, at), 'No background updates in the last hour · last at 09:15');
  assert.equal(backgroundText({ lastHour: 1, quietLastHour: 1, lastAt: '2026-11-08T10:42:00.000Z' }, at), '1 background update in the last hour, quiet · last at 10:42');
  assert.equal(backgroundText({ lastHour: 5, quietLastHour: 5, lastAt: '2026-11-08T10:42:00.000Z' }, at), '5 background updates in the last hour, all quiet · last at 10:42');
  assert.equal(backgroundText({ lastHour: 5, quietLastHour: 3, lastAt: '2026-11-08T10:42:00.000Z' }, at), '5 background updates in the last hour, 3 quiet · last at 10:42');
  assert.equal(backgroundText({ lastHour: 2, quietLastHour: 0, lastAt: '2026-11-08T10:42:00.000Z' }, at), '2 background updates in the last hour · last at 10:42');
});

test('a job title is one short plain line for the owner', () => {
  assert.equal(jobTitle('  Fix the\nlogin\u202epage\u0000 '), 'Fix the login page');
  assert.equal(jobTitle(''), null);
  assert.equal(jobTitle(42), null);
  assert.equal(jobTitle('\u200b\u200b'), null);
  const long = jobTitle('x'.repeat(200))!;
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith('…'));
});

test('a work label says the job title when there is one, with the pull request; ids stay in the tooltip', () => {
  const work: WorkEvent = { connectorId: 'oauth:fleet', jobId: 'job_abc123', kind: 'finished', state: 'idle', link: 'https://github.com/example/app/pull/12', title: 'Fix the login page' };
  assert.equal(workLabel(work).text, 'fleet: “Fix the login page” (PR #12) finished');
  assert.equal(workLabel({ ...work, link: null }).text, 'fleet: “Fix the login page” finished');
  assert.equal(workLabel({ ...work, title: 'a\nb' }).text, 'fleet: “a b” (PR #12) finished');
  assert.ok(!workLabel(work).text.includes('job_abc123') && workLabel(work).detail.includes('job_abc123'));
});

test('wake labels in the activity list name what woke the Boton, never an id', () => {
  assert.equal(wakeLabel(msg('user', 'x', WAKES.ask)).text, 'Stuart asked');
  assert.equal(wakeLabel(msg('user', 'x', WAKES['ask.reply'])).text, 'Stuart replied to an ask');
  assert.equal(wakeLabel(msg('user', 'x', WAKES['approval.decided'])).text, 'Allowed: Deploy');
  assert.equal(wakeLabel(msg('user', 'Connector fleet added', WAKES['connector.granted'])).text, 'Connector fleet added');
  assert.equal(wakeLabel(msg('user', 'x', WAKES['reaction.followup'])).text, 'Follow-up to your 👎 reaction');
  assert.equal(wakeLabel(msg('user', 'x', WAKES['work.event'])).text, 'fleet: work finished');
  for (const kind of ['approval.requested', 'card.posted', 'card.answered', 'turn.stopped', 'turn.interrupted', 'ask.refused', 'session.reset', 'routine.run']) assert.ok(!TURN_ACTIVITY.has(kind), kind);
  for (const kind of ['memory.saved', 'memory.forgotten', 'file.shared', 'notify.sent', 'ask.sent', 'routine.created', 'routine.updated', 'routine.paused', 'routine.resumed', 'routine.deleted', 'skill.created', 'skill.updated'])
    assert.ok(TURN_ACTIVITY.has(kind), kind);
});
