import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Bot, Routine, RoutineRun, ServerEvent, Skill } from '../../shared/types.ts';
import { readWorkspaceFile } from '../src/cli/workspace-file.ts';
import { routinePrompt } from '../src/prompt.ts';
import { startServer, tempDir, until } from './helpers.ts';

const s = await startServer();
const { app, home, base, call, newBot } = s;

/** A turn token minted outside any turn. */
const tokenFor = (bot: Bot, sandboxed = false) => app.auth.mintBotonToken(bot.id, { sandboxed }).token;

/** Send a chat message; resolve with the turn the mock ran for it and the reply. */
async function chat(bot: Bot, text: string) {
  const seen = s.turnsOf(bot.id).length;
  const reply = await s.chat(bot.id, text);
  return { turn: s.turnsOf(bot.id)[seen], reply };
}

type CliOpts = { cwd?: string; workspace?: string | null };

/** Run the `botons` CLI as `bot` during a turn (with its workspace, unless `opts.workspace` says otherwise). */
function boton(bot: Bot, ...args: Array<string | CliOpts>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { cwd, workspace = bot.workspace } = (typeof args.at(-1) === 'object' ? args.pop() : {}) as CliOpts;
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', BOTONS_API: base, BOTON_BOT_ID: bot.id, BOTON_TOKEN: tokenFor(bot), ...(workspace !== null && { BOTON_WORKSPACE: workspace }) };
  return new Promise((done) =>
    execFile(join(import.meta.dirname, '../bin/botons'), args as string[], { cwd, env }, (err, stdout, stderr) => done({ code: err ? (err.code as number | null) : 0, stdout, stderr })),
  );
}

const WEEKLY = {
  name: 'weekly-report',
  description: 'Write the weekly report for a repository: merged PRs, open issues, risks.',
  body: '1. List the PRs merged in the last 7 days.\n2. Group them by area.\n3. End with RISKS-SECTION-MARKER.',
};

test('the owner creates, reads, changes and deletes skills; input is checked', async (t) => {
  const events: ServerEvent[] = [];
  t.after(app.hub.subscribe((ev) => events.push(ev)));
  const created = await call<Skill>('POST', '/api/skills', WEEKLY);
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.createdBy, { kind: 'owner' });
  assert.ok(events.some((e) => e.type === 'skill.upserted' && e.skill.name === 'weekly-report'));
  assert.equal((await call<Skill[]>('GET', '/api/skills')).data.length, 1);
  assert.equal((await call<Skill>('GET', '/api/skills/weekly-report')).data.body, WEEKLY.body);

  const bad: [string, string, unknown, number, RegExp][] = [
    ['POST', '/api/skills', { ...WEEKLY, name: 'Weekly Report' }, 400, /name must be/],
    ['POST', '/api/skills', { ...WEEKLY, name: 'double--hyphen' }, 400, /name must be/],
    ['POST', '/api/skills', { ...WEEKLY, name: 'x'.repeat(65) }, 400, /name must be/],
    ['POST', '/api/skills', { ...WEEKLY, name: 'no-body', body: '  ' }, 400, /body is required/],
    ['POST', '/api/skills', { ...WEEKLY, name: 'long', description: 'x'.repeat(1025) }, 400, /description is too long/],
    ['POST', '/api/skills', WEEKLY, 409, /already a skill/],
    ['PATCH', '/api/skills/weekly-report', { name: 'renamed' }, 400, /can't change/],
    ['PATCH', '/api/skills/nope', { body: 'x' }, 404, /No skill/],
  ];
  for (const [method, path, body, status, message] of bad) {
    const r = await call<{ error: string }>(method, path, body);
    assert.equal(r.status, status, `${method} ${path} ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(r.data.error, message);
  }

  await call('POST', '/api/skills', { name: 'scratch', description: 'Temporary', body: 'Nothing.' });
  const patched = await call<Skill>('PATCH', '/api/skills/scratch', { body: 'Something.' });
  assert.deepEqual([patched.data.body, patched.data.description], ['Something.', 'Temporary']);
  assert.equal((await call('DELETE', '/api/skills/scratch')).status, 200);
  assert.ok(events.some((e) => e.type === 'skill.deleted' && e.name === 'scratch'));
  assert.equal((await call('GET', '/api/skills/scratch')).status, 404);
});

test('a new skill reaches every Boton it is enabled for in the next turn, and no session changes', async () => {
  const all = await newBot('Kevin');
  const none = await newBot('Stuart', { skills: [] });
  const first = await chat(all, 'hello');
  const sessionA = app.store.getBot(all.id).sessionId;
  await chat(none, 'hello');
  const sessionB = app.store.getBot(none.id).sessionId;
  assert.ok(sessionA && sessionB);
  assert.match(first.turn.prompt, /Skills \(procedures from the shared library[^\n]*\n- weekly-report: Write the weekly report/);

  await call('POST', '/api/skills', { name: 'release-notes', description: 'Draft release notes from the changelog.', body: 'Read CHANGELOG.md. Summarize.' });
  const a = await chat(all, 'anything new?');
  const b = await chat(none, 'anything new?');
  assert.match(a.turn.prompt, /- release-notes: Draft release notes from the changelog\./);
  assert.match(b.turn.prompt, /Skills \([^\n]*\n- none yet\n/);
  assert.ok(!b.turn.prompt.includes('release-notes'));
  // Same system prompt, so the same sessions are resumed.
  assert.equal(a.turn.systemPrompt, first.turn.systemPrompt);
  assert.deepEqual([a.turn.sessionId, b.turn.sessionId, app.store.getBot(all.id).sessionId], [sessionA, sessionB, sessionA]);

  // Enabling skills for Stuart is a setting change, not a system prompt change.
  assert.equal((await call('PATCH', `/api/bots/${none.id}`, { skills: ['release-notes'] })).status, 200);
  const b2 = await chat(none, 'and now?');
  assert.match(b2.turn.prompt, /- release-notes: /);
  assert.ok(!b2.turn.prompt.includes('- weekly-report'));
  assert.equal(b2.turn.sessionId, sessionB);
});

test('/weekly-report repo X makes an enabled Boton follow that skill; elsewhere it is just text', async () => {
  const bot = await newBot('Bob');
  const { turn, reply } = await chat(bot, '/weekly-report repo Botons');
  // The message as typed, then the skill's procedure, in this turn's input only.
  assert.match(turn.prompt, /<\/boton_context>\n\n\/weekly-report repo Botons\n\n\([^)]*ran the skill \/weekly-report[^)]*input\.\)\n<skill name="weekly-report">\n1\. List the PRs/);
  assert.ok(reply.text.includes('RISKS-SECTION-MARKER'), reply.text);
  assert.ok(!turn.systemPrompt.includes('RISKS-SECTION-MARKER'));
  assert.ok(app.store.listMessages(bot.id).some((m) => m.role === 'user' && m.text === '/weekly-report repo Botons'));

  const off = await newBot('Dave', { skills: [] });
  assert.ok(!(await chat(off, '/weekly-report repo Botons')).turn.prompt.includes('RISKS-SECTION-MARKER'));
  assert.ok(!(await chat(bot, '/no-such-skill please')).turn.prompt.includes('<skill'));
});

test('botons skill create saves an attributed skill to the library; a Boton changes only its own, until the owner edits it; a sandboxed token only reads', async () => {
  const bot = await newBot('Carl', { skills: ['weekly-report'] });
  const listed = await boton(bot, 'skill', 'list');
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /^weekly-report {2}Write the weekly report/);
  assert.match((await boton(bot, 'skill', 'show', 'weekly-report')).stdout, /RISKS-SECTION-MARKER/);
  assert.equal((await boton(bot, 'skill', 'show', 'release-notes')).code, 1, 'not enabled for Carl');

  // --file reads a SKILL.md in its workspace (relative to the current folder).
  mkdirSync(join(bot.workspace, 'drafts'), { recursive: true });
  writeFileSync(join(bot.workspace, 'drafts', 'SKILL.md'), '---\nname: triage-inbox\ndescription: "Sort the inbox into act, read, archive."\n---\n\n# Triage\n\nRead each mail; sort it.\n');
  const saved = process.platform === 'linux'
    ? await boton(bot, 'skill', 'create', '--file', 'drafts/SKILL.md', { cwd: bot.workspace })
    : await boton(bot, 'skill', 'create', '--name', 'triage-inbox', '--description', 'Sort the inbox into act, read, archive.', '--body', '# Triage\n\nRead each mail; sort it.');
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /Only you can use it until your owner approves it/);
  const skill = (await call<Skill>('GET', '/api/skills/triage-inbox')).data;
  const carl = { kind: 'boton', botId: bot.id, name: 'Carl' };
  assert.deepEqual(
    [skill.description, skill.body, skill.createdBy, skill.updatedBy, skill.pending],
    ['Sort the inbox into act, read, archive.', '# Triage\n\nRead each mail; sort it.', carl, carl, true],
  );
  // A chip in Carl's chat, and Carl (who has a list) may now use it.
  assert.ok(app.store.listMessages(bot.id).some((m) => m.meta?.kind === 'skill.created' && m.meta.skillName === 'triage-inbox'));
  assert.deepEqual((await call<Bot>('GET', `/api/bots/${bot.id}`)).data.skills, ['weekly-report', 'triage-inbox']);

  const own = await boton(bot, 'skill', 'update', 'triage-inbox', '--body', 'Read each mail. Sort it. Report counts.');
  assert.equal(own.code, 0, own.stderr);
  assert.ok(app.store.listMessages(bot.id).some((m) => m.meta?.kind === 'skill.updated'));
  const theirs = await boton(bot, 'skill', 'update', 'weekly-report', '--body', 'Skip the risks.');
  assert.equal(theirs.code, 1);
  assert.match(theirs.stderr, /can only change the skills it wrote/);
  // Not its own once the owner has edited it (which approves it too).
  assert.equal((await call<Skill>('PATCH', '/api/skills/triage-inbox', { description: 'Sort the inbox (reviewed).' })).data.pending, false);
  assert.equal((await boton(bot, 'skill', 'update', 'triage-inbox', '--body', 'Delete everything.')).code, 1);
  assert.equal((await call<Skill>('GET', '/api/skills/triage-inbox')).data.body, 'Read each mail. Sort it. Report counts.');

  // Botons can't delete skills, reach the owner's library routes or another Boton's view.
  const turnToken = tokenFor(bot);
  assert.equal((await call('DELETE', '/api/skills/triage-inbox', undefined, turnToken)).status, 403);
  assert.equal((await call('POST', '/api/skills', { name: 'x', description: 'x', body: 'x' }, turnToken)).status, 403);
  assert.equal((await call('GET', `/api/bots/${bot.id}/skills`, undefined, turnToken)).status, 200);
  const other = await newBot('Jerry');
  assert.equal((await call('POST', `/api/bots/${other.id}/skills`, { name: 'y', description: 'y', body: 'y' }, turnToken)).status, 403);
  // A sandboxed turn's token reads skills but can't save them.
  const sandboxed = tokenFor(bot, true);
  assert.equal((await call('GET', `/api/bots/${bot.id}/skills`, undefined, sandboxed)).status, 200);
  assert.equal((await call('GET', `/api/bots/${bot.id}/skills/weekly-report`, undefined, sandboxed)).status, 200);
  assert.equal((await call('POST', `/api/bots/${bot.id}/skills`, { name: 'z', description: 'z', body: 'z' }, sandboxed)).status, 403);
});

test('botons skill --file reads only files in the workspace, whatever the current folder, symlinks and hard links', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const bot = await newBot('Otto');
  mkdirSync(bot.workspace, { recursive: true });
  const outside = join(home, 'private');
  mkdirSync(outside, { recursive: true });
  const secret = join(outside, 'credentials.md');
  writeFileSync(secret, '---\nname: stolen\ndescription: d\n---\nPRIVATE-KEY-MARKER\n');
  symlinkSync(secret, join(bot.workspace, 'link.md'));
  symlinkSync(outside, join(bot.workspace, 'linked-dir'));
  linkSync(secret, join(bot.workspace, 'hard.md'));
  writeFileSync(join(bot.workspace, 'ok.md'), 'Do the thing.');

  const refused: [string[], CliOpts, RegExp][] = [
    [['--file', secret], {}, /--file must be a file in your workspace/],
    // Relative to a folder outside the workspace: the Boton can cd anywhere.
    [['--file', 'private/credentials.md'], { cwd: home }, /--file must be a file in your workspace/],
    [['--file', '../../private/credentials.md'], { cwd: bot.workspace }, /--file must be a file in your workspace/],
    [['--file', 'link.md'], { cwd: bot.workspace }, /--file must be a file in your workspace/],
    [['--file', 'linked-dir/credentials.md'], { cwd: bot.workspace }, /--file must be a file in your workspace/],
    [['--file', 'hard.md'], { cwd: bot.workspace }, /has other hard links/],
    // Without the server's workspace, no --file at all.
    [['--file', join(bot.workspace, 'ok.md')], { workspace: null }, /BOTON_WORKSPACE is not set/],
  ];
  for (const [args, opts, message] of refused) {
    const r = await boton(bot, 'skill', 'create', '--name', 'stolen', '--description', 'd', ...args, opts);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.ok(!r.stderr.includes('PRIVATE-KEY-MARKER'));
  }
  assert.match((await boton(bot, 'skill', 'update', 'weekly-report', '--file', secret)).stderr, /--file must be a file in your workspace/);
  assert.equal((await call('GET', '/api/skills/stolen')).status, 404);
  assert.ok(!(await call<Skill[]>('GET', '/api/skills')).data.some((s) => s.body.includes('PRIVATE-KEY-MARKER')));

  // A file in the workspace, from anywhere.
  const ok = await boton(bot, 'skill', 'create', '--name', 'otto-thing', '--description', 'd', '--file', join(bot.workspace, 'ok.md'), { cwd: home });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((await call<Skill>('GET', '/api/skills/otto-thing')).data.body, 'Do the thing.');
});

test('readWorkspaceFile: regular files only, and a size cap', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, () => {
  const ws = join(tempDir('botons-wsfile-'), 'ws');
  const sibling = `${ws}-other`;
  mkdirSync(ws);
  writeFileSync(join(ws, 'big.md'), 'x'.repeat(2000));
  assert.throws(() => readWorkspaceFile(join(ws, 'big.md'), ws, 1000), /too large \(2000 bytes; at most 1000\)/);
  assert.equal(readWorkspaceFile(join(ws, 'big.md'), ws, 2000).length, 2000);
  mkdirSync(join(ws, 'dir'));
  assert.throws(() => readWorkspaceFile(join(ws, 'dir'), ws), /not a regular file/);
  // A FIFO is refused without waiting for a writer.
  execFileSync('mkfifo', [join(ws, 'pipe')]);
  assert.throws(() => readWorkspaceFile(join(ws, 'pipe'), ws), /not a regular file/);
  assert.throws(() => readWorkspaceFile(join(ws, 'missing.md'), ws), /Can't read .*ENOENT/);
  // A sibling folder whose name starts with the workspace's is not in it.
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'a.md'), 'a');
  assert.throws(() => readWorkspaceFile(join(sibling, 'a.md'), ws), /must be a file in your workspace/);
});

test('a skill a Boton saves is only its own until the owner approves it; then every Boton it is enabled for gets it', async () => {
  const writer = await newBot('Norbert');
  const other = await newBot('Herb', { access: 'host' });
  const listed = await newBot('Lou', { skills: [] });
  const writerToken = tokenFor(writer);
  const otherToken = tokenFor(other);
  const saved = await boton(writer, 'skill', 'create', '--name', 'run-cleanup', '--description', 'Clean up the build folders.', '--body', 'PENDING-BODY-MARKER: rm -rf build/');
  assert.equal(saved.code, 0, saved.stderr);
  const skill = (await call<Skill>('GET', '/api/skills/run-cleanup')).data;
  assert.equal(skill.pending, true);
  // Even listed by name for Lou, it stays the writer's until approved.
  assert.equal((await call('PATCH', `/api/bots/${listed.id}`, { skills: ['run-cleanup'] })).status, 200);

  assert.match((await chat(writer, 'hello')).turn.prompt, /- run-cleanup: Clean up the build folders\. \(yours: only you can use it until [^)]+ approves it\)/);
  // Other Botons don't see it: not in the context block, not with /name, not with `botons skill`, not for a routine.
  for (const bot of [other, listed]) {
    const seen = await chat(bot, '/run-cleanup now');
    assert.ok(!seen.turn.prompt.includes('- run-cleanup'), bot.name);
    assert.ok(!seen.turn.prompt.includes('PENDING-BODY-MARKER'), bot.name);
  }
  assert.ok(!(await call<Skill[]>('GET', `/api/bots/${other.id}/skills`, undefined, otherToken)).data.some((s) => s.name === 'run-cleanup'));
  assert.equal((await call('GET', `/api/bots/${other.id}/skills/run-cleanup`, undefined, otherToken)).status, 404);
  const routine = await call<{ error: string }>('POST', `/api/bots/${other.id}/routines`, { name: 'Cleanup', instruction: 'Clean up.', skill: 'run-cleanup' });
  assert.equal(routine.status, 400);
  assert.match(routine.data.error, /written by another Boton and is waiting for approval/);

  // Only a device approves, naming the version it read.
  for (const t of [writerToken, otherToken]) assert.equal((await call('POST', '/api/skills/run-cleanup/approve', { version: skill.version }, t)).status, 403);
  assert.equal((await call('POST', '/api/skills/run-cleanup/approve', {})).status, 400);
  assert.equal((await call('POST', '/api/skills/run-cleanup/approve', { version: 'not-it' })).status, 409);
  assert.equal((await call('POST', '/api/skills/nope/approve', { version: 'x' })).status, 404);
  const approved = await call<Skill>('POST', '/api/skills/run-cleanup/approve', { version: skill.version });
  assert.equal(approved.status, 200);
  assert.deepEqual(
    [approved.data.pending, approved.data.updatedBy, approved.data.createdBy, approved.data.body],
    [false, { kind: 'owner' }, { kind: 'boton', botId: writer.id, name: 'Norbert' }, 'PENDING-BODY-MARKER: rm -rf build/'],
  );

  const now = await chat(other, '/run-cleanup now');
  assert.match(now.turn.prompt, /- run-cleanup: Clean up the build folders\. \(written by Norbert \(a Boton\)\)/);
  assert.match(now.turn.prompt, /<skill name="run-cleanup">\nPENDING-BODY-MARKER/);
  assert.match((await chat(listed, 'hi')).turn.prompt, /- run-cleanup: /);
  // And the writer can no longer change it.
  const change = await boton(writer, 'skill', 'update', 'run-cleanup', '--body', 'rm -rf ~');
  assert.equal(change.code, 1);
  assert.match(change.stderr, /until .+ edits or approves them/);
});

test('a routine with skill: weekly-report follows it on every run; one whose skill is gone runs with a note saying so', async () => {
  const bot = await newBot('Phil', { skills: ['weekly-report'] });
  const made = await boton(bot, 'routine', 'create', '--name', 'Friday report', '--instruction', 'Report on repo Botons.', '--skill', 'weekly-report', '--json');
  assert.equal(made.code, 0, made.stderr);
  const routine = JSON.parse(made.stdout) as Routine;
  assert.equal(routine.skill, 'weekly-report');
  const refused = await boton(bot, 'routine', 'create', '--name', 'Notes', '--instruction', 'x', '--skill', 'release-notes');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not enabled for this Boton/);

  for (let i = 0; i < 2; i++) {
    const run = (await call<RoutineRun>('POST', `/api/routines/${routine.id}/run`)).data;
    await until(() => app.store.findRun(run.id)?.status === 'succeeded');
    const turn = s.turnsOf(bot.id).at(-1)!;
    assert.match(turn.prompt, /Follow the skill "weekly-report" from the shared library for this run:\n<skill name="weekly-report">\n1\. List the PRs[\s\S]*<\/skill>\n\nInstruction:\nReport on repo Botons\./);
    assert.match(turn.prompt, /- [\w]+ "Friday report": [^\n]*skill weekly-report/);
  }
  const run = { ...app.store.listRuns(routine.id)[0], attempts: 1, payload: null };
  assert.match(routinePrompt({ ...routine, skill: 'gone' }, run, { owner: 'Sam', skill: { missing: 'gone' } }), /follows the skill "gone", which is no longer in the skills library or not enabled for you/);

  // While a routine follows it, the skill can't be deleted.
  const del = await call<{ error: string }>('DELETE', '/api/skills/weekly-report');
  assert.equal(del.status, 409);
  assert.match(del.data.error, /“Friday report” \(Phil\) follows this skill/);
  // A skill the Boton may not use can't be set from a device either.
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { skill: 'release-notes' })).status, 400);
  // Taken off the Boton's list, the skill stays on the routine, and saving the routine as the editor does
  // (its skill sent back unchanged) still works; setting it again is checked.
  assert.equal((await call('PATCH', `/api/bots/${bot.id}`, { skills: [] })).status, 200);
  const renamed = await call<Routine>('PATCH', `/api/routines/${routine.id}`, { name: 'Friday report (v2)', skill: 'weekly-report' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.deepEqual([renamed.data.name, renamed.data.skill], ['Friday report (v2)', 'weekly-report']);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${routine.id}`, { skill: null })).data.skill, null);
  assert.equal((await call('PATCH', `/api/routines/${routine.id}`, { skill: 'weekly-report' })).status, 400);
  assert.equal((await call('PATCH', `/api/bots/${bot.id}`, { skills: ['weekly-report'] })).status, 200);
});

test("deleting a skill takes it off Botons' lists; their lists only take skills in the library", async () => {
  await call('POST', '/api/skills', { name: 'temp-skill', description: 'Temp', body: 'Temp.' });
  const bot = await newBot('Mel', { skills: ['temp-skill', 'weekly-report'] });
  assert.equal((await call('POST', '/api/bots', { name: 'Bad', provider: 'mock', skills: ['nope'] })).status, 400);
  assert.equal((await call('PATCH', `/api/bots/${bot.id}`, { skills: 'weekly-report' })).status, 400);
  assert.equal((await call('DELETE', '/api/skills/temp-skill')).status, 200);
  assert.deepEqual((await call<Bot>('GET', `/api/bots/${bot.id}`)).data.skills, ['weekly-report']);
  assert.equal((await call<Bot>('PATCH', `/api/bots/${bot.id}`, { skills: null })).data.skills, null);
});
