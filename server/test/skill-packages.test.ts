import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AuditEvent, Bot, Skill, SkillAccess, SkillDetails, SkillPackageReview, SkillPackagesList } from '../../shared/types.ts';
import { lineDiff, listPackages, parseSkillMd, type Pinned, readPackage } from '../src/skill-packages.ts';
import { SKILL_HISTORY_KEEP, SKILL_NAME } from '../src/skills.ts';
import { startServer, tempDir } from './helpers.ts';

const s = await startServer();
const { app, home, call } = s;
const dir = join(home, 'skill-packages');
/** Written by a package's script if anything ever ran it. */
const RAN = join(tempDir('botons-skill-ran-'), 'ran');

const md = (name: string, description: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

function pkg(folder: string, text: string, files: Record<string, string> = {}): string {
  const p = join(dir, folder);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'SKILL.md'), text);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(p, rel, '..'), { recursive: true });
    writeFileSync(join(p, rel), content);
  }
  return p;
}

const list = async () => {
  const r = await call<SkillPackagesList>('GET', '/api/skill-packages');
  assert.equal(r.status, 200, r.text);
  return r.data;
};
const review = async (folder: string) => {
  const r = await call<SkillPackageReview>('GET', `/api/skill-packages/${folder}`);
  assert.equal(r.status, 200, r.text);
  return r.data;
};
const holders = (botons: { botId: string; has: boolean }[]) => botons.filter((m) => m.has).map((m) => m.botId);
/** Install exactly as reviewed, giving it to `botIds`; `over` changes one part of what is sent. */
const install = (r: SkillPackageReview, botIds: string[], over: Record<string, unknown> = {}, token?: string) =>
  call<Skill & { error?: string }>(
    'POST',
    `/api/skill-packages/${r.folder}/install`,
    { version: r.version, fingerprint: r.fingerprint, current: r.installed?.version ?? null, accept: r.newAsks, botIds, expected: holders(r.botons), ...over },
    token,
  );
const bot = (id: string) => app.store.getBot(id);
const skillAudit = async () => (await call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.target?.kind === 'skill' || e.details.via === 'skill');

let kevin: Bot;
let stuart: Bot;
let bob: Bot;

test('the packages folder lists nothing until it exists, and says where it is', async () => {
  const l = await list();
  assert.equal(l.dir, dir);
  assert.equal(l.exists, false);
  assert.deepEqual(l.packages, []);
  kevin = await s.newBot('Kevin', { skills: [] });
  stuart = await s.newBot('Stuart'); // every skill
  bob = await s.newBot('Bob', { skills: [] });
});

test('a package with anything Botons does not read safely is listed with why, and nothing in a folder is ever run', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const script = `#!/bin/sh\ntouch ${RAN}\n`;
  const ok = pkg('git-digest', md('git-digest', 'Summarize recent commits.', 'Run `botons ask` with the summary.'), { 'scripts/run.sh': script, 'docs/notes.md': 'notes' });
  chmodSync(join(ok, 'scripts/run.sh'), 0o755);
  symlinkSync('/etc/hostname', join(ok, 'docs/elsewhere'));
  const outside = tempDir('botons-skill-outside-');
  writeFileSync(join(outside, 'SKILL.md'), md('linked-folder', 'A folder that is a link.', 'Steps.'));
  symlinkSync(outside, join(dir, 'linked-folder'));
  mkdirSync(join(dir, 'linked-file'));
  symlinkSync(join(outside, 'SKILL.md'), join(dir, 'linked-file', 'SKILL.md'));
  mkdirSync(join(dir, 'hard-linked'));
  linkSync(join(outside, 'SKILL.md'), join(dir, 'hard-linked', 'SKILL.md'));
  writeFileSync(join(dir, 'bundle.zip'), 'PK\x03\x04');
  writeFileSync(join(dir, 'notes.txt'), 'not a package');
  pkg('Bad_Name', md('Bad_Name', 'x', 'y'));
  mkdirSync(join(dir, 'empty-folder'));
  pkg('mismatch', md('other-name', 'Named otherwise.', 'Steps.'));
  pkg('too-large', md('too-large', 'Too large.', 'x'.repeat(70 * 1024)));
  pkg('not-utf8', '');
  writeFileSync(join(dir, 'not-utf8', 'SKILL.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
  pkg('no-frontmatter', '# Just a procedure\n');
  pkg('twice', '---\nname: twice\nname: twice\ndescription: x\n---\nBody\n');

  const why = Object.fromEntries((await list()).packages.map((p) => [p.folder, [p.state, p.problems.join(' ')]]));
  assert.deepEqual(why['git-digest'], ['new', '']);
  const expect: Record<string, RegExp> = {
    'linked-folder': /is a link/,
    'linked-file': /SKILL\.md is a link/,
    'hard-linked': /other hard links/,
    'bundle.zip': /archive.*doesn't unpack/,
    'notes.txt': /not a folder/,
    Bad_Name: /not a skill name/,
    'empty-folder': /no SKILL\.md/,
    mismatch: /named other-name, but its folder is mismatch/,
    'too-large': /too large/,
    'not-utf8': /not UTF-8/,
    'no-frontmatter': /no frontmatter/,
    twice: /name twice/,
  };
  for (const [folder, problem] of Object.entries(expect)) {
    assert.equal(why[folder]?.[0], 'invalid', folder);
    assert.match(why[folder][1], problem, folder);
  }
  const r = await review('git-digest');
  assert.deepEqual(r.otherFiles, ['docs/elsewhere (a link, not followed)', 'docs/notes.md', 'scripts/run.sh']);
  // Invalid packages can't be installed, whatever is sent.
  for (const folder of ['linked-file', 'hard-linked', 'too-large']) {
    const res = await call('POST', `/api/skill-packages/${folder}/install`, { version: 'x', fingerprint: 'x', current: null, accept: [], botIds: [], expected: [] });
    assert.equal(res.status, 400, folder);
  }
  assert.equal((await call('GET', '/api/skill-packages/linked-folder')).data.state, 'invalid');
  assert.equal((await call('GET', '/api/skill-packages/..%2Fetc')).status, 404);
  assert.equal((await call('GET', '/api/skill-packages/nope')).status, 404);
  assert.equal(existsSync(RAN), false, 'nothing in a package ran');
  for (const folder of Object.keys(expect)) rmSync(join(dir, folder), { recursive: true, force: true });
});

test('a new package installs only exactly as reviewed, to exactly the Botons chosen, all at once or not at all', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  pkg(
    'weekly-report',
    md('weekly-report', 'Write the weekly report.', '1. Read https://status.example.com/feed.\n2. Send it with `botons ask`.', 'version: 1.0.0\nallowed-tools: Bash(git:*)\nlicense: MIT\n'),
  );
  const r = await review('weekly-report');
  assert.equal(r.state, 'new');
  assert.equal(r.label, '1.0.0');
  assert.equal(r.installed, null);
  assert.deepEqual(r.fields, { 'allowed-tools': 'Bash(git:*)', license: 'MIT' });
  assert.deepEqual(r.asks, ['asks for allowed-tools: Bash(git:*)', 'links to status.example.com', 'runs botons ask']);
  assert.deepEqual(r.newAsks, r.asks);
  assert.ok(r.diff.body.every((l) => l.op === 'add'));
  // A new skill would reach the Botons with every skill: Stuart.
  assert.deepEqual(holders(r.botons), [stuart.id]);

  const refused: [Record<string, unknown>, number, RegExp][] = [
    [{ accept: [] }, 409, /asks for has changed/],
    [{ version: 'abc' }, 409, /package weekly-report has changed/],
    [{ fingerprint: 'abc' }, 409, /package weekly-report has changed/],
    [{ fingerprint: undefined }, 400, /fingerprint is required/],
    [{ current: 'abc' }, 409, /skill weekly-report has changed/],
    [{ expected: [] }, 409, /Which Botons have weekly-report changed/],
    [{ botIds: ['bot_nobody'] }, 400, /No Boton with id/],
    [{ accept: 'all' }, 400, /accept must list/],
  ];
  for (const [over, status, message] of refused) {
    const res = await install(r, [kevin.id], over);
    assert.equal(res.status, status, JSON.stringify(over));
    assert.match(res.data.error ?? '', message);
    assert.equal(app.skills.find('weekly-report'), null, 'nothing installed');
    assert.deepEqual([bot(kevin.id).skills, bot(stuart.id).skills], [[], null], 'no grant changed');
  }
  // A Boton can't install, whatever it sends.
  const boton = app.auth.mintBotonToken(kevin.id).token;
  assert.ok([401, 403].includes((await install(r, [kevin.id], {}, boton)).status));
  assert.ok([401, 403].includes((await call('GET', '/api/skill-packages', undefined, boton)).status));

  // The file changes after the review: refused.
  pkg('weekly-report', md('weekly-report', 'Write the weekly report.', 'Something else.', 'version: 1.0.0\n'));
  assert.equal((await install(r, [kevin.id])).status, 409);
  pkg(
    'weekly-report',
    md('weekly-report', 'Write the weekly report.', '1. Read https://status.example.com/feed.\n2. Send it with `botons ask`.', 'version: 1.0.0\nallowed-tools: Bash(git:*)\nlicense: MIT\n'),
  );

  const ok = await install(r, [kevin.id]);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.version, r.version);
  assert.deepEqual(ok.data.createdBy, { kind: 'owner' });
  assert.equal(ok.data.pending, false);
  assert.deepEqual({ ...ok.data.source, installedAt: '' }, { kind: 'folder', folder: 'weekly-report', label: '1.0.0', installed: r.version, installedAt: '', fields: r.fields, files: [], reviewed: r.fingerprint });
  // Kevin gets it; Stuart, who had every skill, now lists every other skill instead (none yet).
  assert.deepEqual([bot(kevin.id).skills, bot(stuart.id).skills, bot(bob.id).skills], [['weekly-report'], [], []]);
  assert.deepEqual(app.skills.index(bot(kevin.id)).map((x) => x.name), ['weekly-report']);
  assert.deepEqual(app.skills.index(bot(stuart.id)), []);
  assert.equal((await review('weekly-report')).state, 'current');

  const events = await skillAudit();
  const installed = events.find((e) => e.action === 'skill.installed')!;
  assert.deepEqual(installed.details, { package: 'weekly-report', label: '1.0.0', version: r.version, from: null, accepted: ['asks for allowed-tools', 'links to status.example.com', 'runs botons ask'] });
  const grants = events.filter((e) => e.action === 'boton.permissions_changed').map((e) => [e.target?.label, e.details]);
  assert.deepEqual(grants.sort(), [
    ['Kevin', { skillsAdded: ['weekly-report'], via: 'skill' }],
    ['Stuart', { skillsRemoved: ['weekly-report'], via: 'skill', everySkill: true }],
  ]);
});

test('an update shows the diff and only what is new, keeps who has it, and keeps the old text to put back', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const before = app.skills.get('weekly-report');
  pkg(
    'weekly-report',
    md('weekly-report', 'Write the weekly report.', '1. Read https://status.example.com/feed.\n2. Also read https://metrics.example.net/api.\n2. Send it with `botons ask`.', 'version: 1.1.0\nallowed-tools: Bash(git:*)\nlicense: MIT\n'),
  );
  const r = await review('weekly-report');
  assert.equal(r.state, 'update');
  assert.equal(r.installed?.version, before.version);
  assert.deepEqual(r.newAsks, ['links to metrics.example.net']);
  assert.deepEqual(r.diff.body.filter((l) => l.op !== 'same'), [{ op: 'add', text: '2. Also read https://metrics.example.net/api.' }]);
  assert.ok(r.diff.description.every((l) => l.op === 'same'));
  assert.deepEqual(holders(r.botons), [kevin.id]);
  assert.equal((await install(r, [kevin.id], { accept: [] })).status, 409, 'the new site must be accepted');
  const ok = await install(r, [kevin.id]);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.source?.label, '1.1.0');
  assert.deepEqual(bot(kevin.id).skills, ['weekly-report']);

  const d = (await call<SkillDetails>('GET', '/api/skills/weekly-report/details')).data;
  assert.deepEqual(
    d.history.map((h) => [h.version, h.source?.label, h.replacedBy]),
    [[before.version, '1.0.0', { kind: 'owner' }]],
  );
  assert.deepEqual(holders(d.access.botons), [kevin.id]);
  assert.ok(d.audit.some((e) => e.action === 'skill.installed' && e.details.from === before.version));
  assert.ok(d.audit.every((e) => e.target?.kind === 'skill' || Array.isArray(e.details.skillsAdded) || Array.isArray(e.details.skillsRemoved)));

  // Put the old text back: its source comes back with it, so the package is an update again.
  assert.equal((await call('POST', '/api/skills/weekly-report/restore', { id: d.history[0].id, current: 'stale' })).status, 409);
  const back = await call<Skill>('POST', '/api/skills/weekly-report/restore', { id: d.history[0].id, current: ok.data.version });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.data.version, before.version);
  assert.equal(back.data.source?.label, '1.0.0');
  assert.equal((await review('weekly-report')).state, 'update');
  const after = (await call<SkillDetails>('GET', '/api/skills/weekly-report/details')).data;
  assert.equal(after.history[0].version, ok.data.version, 'the text it replaced is kept too');
  assert.ok(after.audit.some((e) => e.action === 'skill.restored' && e.details.from === ok.data.version && e.details.to === before.version));
});

test('an installed skill changed here is "changed"; a skill not from the package blocks it', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const current = app.skills.get('weekly-report');
  pkg('weekly-report', md('weekly-report', 'Write the weekly report.', '1. Read https://status.example.com/feed.\n2. Send it with `botons ask`.', 'version: 1.0.0\nallowed-tools: Bash(git:*)\nlicense: MIT\n'));
  assert.equal((await review('weekly-report')).state, 'current');
  assert.equal((await call('PATCH', '/api/skills/weekly-report', { body: 'My own steps.' })).status, 200);
  const r = await review('weekly-report');
  assert.equal(r.state, 'changed');
  assert.equal(app.skills.get('weekly-report').source?.installed, current.version);
  assert.deepEqual(r.newAsks, ['links to status.example.com', 'runs botons ask'], 'what the edit dropped counts as new again');

  await call('POST', '/api/skills', { name: 'standup', description: 'Written here.', body: 'Steps.' });
  pkg('standup', md('standup', 'From a package.', 'Other steps.'));
  const c = await review('standup');
  assert.equal(c.state, 'conflict');
  assert.match(c.problems[0], /was not installed from this package/);
  assert.equal((await install(c, [])).status, 409);
  assert.equal(app.skills.get('standup').body, 'Steps.');
});

test('a package is current only while everything reviewed of it is: its label, fields and other files count, not just its text', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const STEPS = '1. List what shipped.\n2. Write it up.';
  const notes = (extra: string, body = STEPS) => pkg('release-notes', md('release-notes', 'Write the release notes.', body, extra));
  notes('version: 1\nlicense: MIT\n');
  const first = await review('release-notes');
  assert.equal((await install(first, [])).status, 200);
  assert.equal((await review('release-notes')).state, 'current');

  // Only the label and the license change: the text is the same, but it is an update, with the change shown.
  notes('version: 2\nlicense: Apache-2.0\n');
  const relabeled = await review('release-notes');
  assert.equal(relabeled.version, first.version, 'the same text');
  assert.equal(relabeled.state, 'update');
  assert.notEqual(relabeled.fingerprint, first.fingerprint);
  assert.deepEqual(relabeled.diff.details.filter((l) => l.op !== 'same'), [
    { op: 'remove', text: 'version: 1' },
    { op: 'remove', text: 'license: MIT' },
    { op: 'add', text: 'version: 2' },
    { op: 'add', text: 'license: Apache-2.0' },
  ]);
  // A review from before the change can't install what it didn't show.
  const stale = await install(first, [], { current: app.skills.get('release-notes').version });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(app.skills.get('release-notes').source?.label, '1');
  const ok = await install(relabeled, []);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.data.source?.label, ok.data.source?.fields], ['2', { license: 'Apache-2.0' }]);
  assert.equal((await review('release-notes')).state, 'current');

  // A field that asks for something, added alone: an update, and it must be accepted.
  notes('version: 2\nlicense: Apache-2.0\nallowed-tools: Bash\n');
  const asks = await review('release-notes');
  assert.equal(asks.state, 'update');
  assert.deepEqual(asks.newAsks, ['asks for allowed-tools: Bash']);
  assert.equal((await install(asks, [], { accept: [] })).status, 409);
  assert.equal((await install(asks, [])).status, 200);
  assert.equal((await review('release-notes')).state, 'current');

  // A file added to the folder, and a change past where a long field is cut: updates too, and shown.
  pkg('release-notes', md('release-notes', 'Write the release notes.', STEPS, 'version: 2\nlicense: Apache-2.0\nallowed-tools: Bash\n'), { 'template.md': '# Notes' });
  const file = await review('release-notes');
  assert.equal(file.state, 'update');
  assert.deepEqual(file.diff.details.filter((l) => l.op !== 'same'), [{ op: 'add', text: 'other file: template.md' }]);
  assert.equal((await install(file, [])).status, 200);
  assert.deepEqual(app.skills.get('release-notes').source?.files, ['template.md']);
  const long = (end: string) => `version: 2\nlicense: Apache-2.0\nallowed-tools: Bash\ncompatibility: ${'x'.repeat(400)}${end}\n`;
  notes(long('a'));
  assert.equal((await install(await review('release-notes'), [])).status, 200);
  notes(long('b'));
  const cut = await review('release-notes');
  assert.equal(cut.state, 'update');
  assert.equal(cut.diff.details.filter((l) => l.op !== 'same').length, 2, 'the cut values differ');

  // Changed here and a new package detail: an update, which replaces the change (kept in its earlier texts).
  assert.equal((await call('PATCH', '/api/skills/release-notes', { body: 'My own steps.' })).status, 200);
  assert.equal((await review('release-notes')).state, 'update');
  notes(long('a'));
  assert.equal((await review('release-notes')).state, 'changed', 'the package as installed, the skill changed here');
  assert.equal(existsSync(RAN), false);
});

test('metadata review binds full values and prototype-named fields', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const name = 'metadata-review';
  const write = (extra: string) => pkg(name, md(name, 'Review the package.', 'Read the notes.', extra));
  write(`compatibility: ${'x'.repeat(400)}20907\n`);
  const first = await review(name);
  assert.equal((await install(first, [])).status, 200);
  write(`compatibility: ${'x'.repeat(400)}27742\n`);
  const changed = await review(name);
  assert.notEqual(changed.fingerprint, first.fingerprint, 'full metadata differs despite the short display-hash collision');
  assert.equal(changed.state, 'update');
  assert.equal((await install(first, [])).status, 409, 'an old review cannot install changed metadata');
  assert.equal((await install(changed, [])).status, 200);
  write(`compatibility: ${'x'.repeat(400)}27742\n__proto__: first value\n`);
  const proto = await review(name);
  assert.ok(Object.hasOwn(proto.fields, '__proto__'));
  assert.equal(proto.fields.__proto__, 'first value');
  assert.notEqual(proto.fingerprint, changed.fingerprint);
  assert.equal((await install(changed, [])).status, 409);
  assert.equal((await install(proto, [])).status, 200);
  write(`compatibility: ${'x'.repeat(400)}27742\n__proto__: second value\n`);
  assert.equal((await install(proto, [])).status, 409);
  const parsed = parseSkillMd(md(name, 'Review.', 'Read.', '__proto__: one\n__proto__: two\n'));
  assert.ok('problem' in parsed, 'duplicate prototype-named keys are rejected too');
});

test('who can use a skill is set exactly, refused when stale, and audited per Boton', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const get = async () => (await call<SkillDetails>('GET', '/api/skills/standup/details')).data.access;
  let a: SkillAccess = await get();
  // standup came after Stuart lost "every skill": only nobody has it now.
  assert.deepEqual(holders(a.botons), []);
  assert.equal((await call('PUT', '/api/skills/standup/access', { botIds: [kevin.id], expected: [bob.id] })).status, 409);
  assert.deepEqual(bot(kevin.id).skills, ['weekly-report']);
  const ok = await call<SkillAccess>('PUT', '/api/skills/standup/access', { botIds: [kevin.id, bob.id], expected: [] });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(holders(ok.data.botons).sort(), [kevin.id, bob.id].sort());
  assert.deepEqual(bot(bob.id).skills, ['standup']);
  a = await get();
  await call('PUT', '/api/skills/standup/access', { botIds: [kevin.id], expected: holders(a.botons) });
  assert.deepEqual(bot(bob.id).skills, []);
  const events = (await call<SkillDetails>('GET', '/api/skills/standup/details')).data.audit.filter((e) => e.action === 'boton.permissions_changed');
  // Newest first: Bob losing it, then both getting it in one save.
  assert.deepEqual(events[0].details, { skillsRemoved: ['standup'], via: 'skill' });
  assert.equal(events[0].target?.label, 'Bob');
  assert.deepEqual(
    events.slice(1).map((e) => [e.target?.label, e.details]).sort(),
    [
      ['Bob', { skillsAdded: ['standup'], via: 'skill' }],
      ['Kevin', { skillsAdded: ['standup'], via: 'skill' }],
    ],
  );
  const boton = app.auth.mintBotonToken(kevin.id).token;
  assert.ok([401, 403].includes((await call('PUT', '/api/skills/standup/access', { botIds: [kevin.id], expected: [kevin.id] }, boton)).status));
});

test('a skill turned off reaches no Boton and no routine until it is turned on', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const k = bot(kevin.id);
  assert.ok(app.skills.enabledFor(k, 'standup'));
  const off = await call<Skill>('PUT', '/api/skills/standup/enabled', { enabled: false });
  assert.equal(off.data.disabled, true);
  assert.equal(app.skills.enabledFor(k, 'standup'), null);
  assert.ok(!app.skills.index(k).some((x) => x.name === 'standup'));
  assert.equal(app.skills.invoked(k, '/standup now'), null);
  assert.throws(() => app.skills.checkRoutineSkill(kevin.id, 'standup'), /turned off/);
  assert.deepEqual(bot(kevin.id).skills, ['weekly-report', 'standup'], 'turning it off takes no grant away');
  assert.equal((await call('PUT', '/api/skills/standup/enabled', { enabled: 'no' })).status, 400);
  await call('PUT', '/api/skills/standup/enabled', { enabled: true });
  assert.ok(app.skills.enabledFor(bot(kevin.id), 'standup'));
  const actions = (await call<SkillDetails>('GET', '/api/skills/standup/details')).data.audit.map((e) => e.action);
  assert.deepEqual(actions.filter((a) => a.startsWith('skill.')), ['skill.enabled', 'skill.disabled']);
});

test('a skill keeps its last few texts, and deleting it drops them', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  for (let i = 0; i < SKILL_HISTORY_KEEP + 3; i++) await call('PATCH', '/api/skills/standup', { body: `Steps ${i}.` });
  // Saving the same text again keeps nothing new.
  await call('PATCH', '/api/skills/standup', { body: `Steps ${SKILL_HISTORY_KEEP + 2}.` });
  const h = app.skills.history('standup');
  assert.equal(h.length, SKILL_HISTORY_KEEP);
  assert.equal(h[0].body, `Steps ${SKILL_HISTORY_KEEP + 1}.`);
  await call('DELETE', '/api/skills/standup');
  assert.equal(app.store.db.prepare("select count(*) as n from skill_history where name = 'standup'").get()!.n, 0);
});

test('a folder swapped for a link while it is read, or the packages folder replaced, reads nothing outside it', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, () => {
  const base = tempDir('botons-skill-swap-');
  const root = join(base, 'packages');
  const outside = join(base, 'outside');
  const OUT = md('swap-me', 'Outside.', 'OUTSIDE TEXT');
  for (const f of ['', 'swap-me', 'evil']) mkdirSync(join(outside, f), { recursive: true });
  writeFileSync(join(outside, 'SKILL.md'), OUT);
  writeFileSync(join(outside, 'swap-me', 'SKILL.md'), OUT);
  writeFileSync(join(outside, 'evil', 'SKILL.md'), md('evil', 'Outside.', 'OUTSIDE TEXT'));
  const snapshot = (d: string): string[] =>
    readdirSync(d, { recursive: true, encoding: 'utf8' }).sort().map((f) => {
      const st = statSync(join(d, f));
      return `${f} ${st.mtimeMs} ${st.isFile() ? readFileSync(join(d, f), 'utf8') : '/'}`;
    });
  const before = snapshot(outside);
  mkdirSync(join(root, 'swap-me', 'sub'), { recursive: true });
  writeFileSync(join(root, 'swap-me', 'SKILL.md'), md('swap-me', 'Inside.', 'Inside steps.'));
  writeFileSync(join(root, 'swap-me', 'sub', 'a.txt'), 'a');
  const ok = (n: string) => SKILL_NAME.test(n);
  const seen = (p: { body: string | null; problems: string[]; otherFiles: string[] } | null) => p && [p.body, p.problems, p.otherFiles];
  const INSIDE = ['Inside steps.', [], ['sub/a.txt']];

  // The package folder is renamed away and a link to outside put in its place once it is open: still the folder opened.
  const swapFolder: Pinned = (f) => {
    if (f !== 'swap-me') return;
    renameSync(join(root, 'swap-me'), join(base, 'moved'));
    symlinkSync(outside, join(root, 'swap-me'));
  };
  assert.deepEqual(seen(readPackage(root, 'swap-me', ok, swapFolder)), INSIDE);
  assert.match(readPackage(root, 'swap-me', ok)!.problems.join(' '), /is a link/, 'and next time it is a link');
  rmSync(join(root, 'swap-me'));
  renameSync(join(base, 'moved'), join(root, 'swap-me'));

  // The same while listing; and a subfolder made a link is listed, not followed.
  assert.deepEqual(listPackages(root, ok, swapFolder)!.map(seen), [INSIDE]);
  rmSync(join(root, 'swap-me'));
  renameSync(join(base, 'moved'), join(root, 'swap-me'));
  const swapSub: Pinned = (f) => {
    if (f !== 'swap-me') return;
    renameSync(join(root, 'swap-me', 'sub'), join(base, 'sub'));
    symlinkSync(outside, join(root, 'swap-me', 'sub'));
  };
  assert.deepEqual(seen(readPackage(root, 'swap-me', ok, swapSub)), ['Inside steps.', [], ['sub (a link, not followed)']]);
  rmSync(join(root, 'swap-me', 'sub'));
  renameSync(join(base, 'sub'), join(root, 'swap-me', 'sub'));

  // The packages folder itself replaced by a link to outside once it is open: still the folder opened.
  const swapRoot: Pinned = (f) => {
    if (f !== null) return;
    renameSync(root, join(base, 'old-root'));
    symlinkSync(outside, root);
  };
  const restoreRoot = () => {
    rmSync(root);
    renameSync(join(base, 'old-root'), root);
  };
  assert.deepEqual(listPackages(root, ok, swapRoot)!.map((p) => [p.folder, ...seen(p)!]), [['swap-me', ...INSIDE]]);
  restoreRoot();
  assert.deepEqual(seen(readPackage(root, 'swap-me', ok, swapRoot)), INSIDE);
  restoreRoot();
  assert.equal(readPackage(root, 'evil', ok, swapRoot), null, 'a package only outside is not found');
  restoreRoot();

  assert.deepEqual(snapshot(outside), before, 'nothing outside was written');
  rmSync(base, { recursive: true, force: true });
});

test('SKILL.md frontmatter: quoted and folded values, comments; the diff keeps common lines', () => {
  const p = parseSkillMd("﻿---\r\nname: \"x-y\"\r\n# a comment\r\ndescription: >\r\n  Two\r\n  lines.\r\nversion: '2'\r\nmetadata:\r\n  a: b\r\n---\r\nBody\r\n");
  assert.ok('metadataHash' in p && /^[a-f0-9]{64}$/.test(p.metadataHash));
  const { metadataHash, ...displayed } = p as Exclude<typeof p, { problem: string }>;
  assert.deepEqual(displayed, { name: 'x-y', description: 'Two lines.', label: '2', fields: { metadata: 'a: b' }, body: 'Body' });
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc'), [
    { op: 'same', text: 'a' },
    { op: 'remove', text: 'b' },
    { op: 'add', text: 'x' },
    { op: 'same', text: 'c' },
  ]);
  assert.deepEqual(lineDiff('', 'a'), [{ op: 'add', text: 'a' }]);
});

test('without Linux directory handles packages expose no text and cannot install', { skip: process.platform === 'linux' && 'Covers hosts without Linux directory handles' }, async () => {
  const name = 'macos-refused';
  pkg(name, md(name, 'Fixture package.', 'DO-NOT-READ-MARKER'));
  const entry = (await list()).packages.find(p => p.folder === name)!;
  assert.equal(entry.state, 'invalid');
  assert.match(entry.problems.join(' '), /needs Linux/);
  assert.doesNotMatch(JSON.stringify(entry), /DO-NOT-READ-MARKER/);
  const result = await call('POST', `/api/skill-packages/${name}/install`, { version: 'x', fingerprint: 'x', current: null, accept: [], botIds: [], expected: [] });
  assert.equal(result.status, 400);
  assert.equal((await call('GET', `/api/skills/${name}`)).status, 404);
});
