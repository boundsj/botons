import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { diagnose } from '../../scripts/doctor.ts';
import { effortProblem, PROVIDER_EFFORT } from '../../shared/effort.ts';
import type { Bot, Message, ProviderInfo, Routine } from '../../shared/types.ts';
import type { App } from '../src/app.ts';
import { claudeArgs } from '../src/providers/claude-cli.ts';
import { codexArgs, codexModel } from '../src/providers/codex-cli.ts';
import { effortPatch, shownEffort } from '../../web/src/effort.ts';
import { botonCli, noRealClis, startServer, tempDir, until, useTestCodexHome } from './helpers.ts';

const codexHome = useTestCodexHome(tempDir('botons-effort-'));
mkdirSync(codexHome, { recursive: true });
// Codex's own model list, as its models_cache.json has it: each model's levels and default.
writeFileSync(
  join(codexHome, 'models_cache.json'),
  JSON.stringify({
    models: [
      {
        slug: 'gpt-test',
        display_name: 'GPT Test',
        visibility: 'list',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
          { effort: 'high', description: 'Deep' },
          { effort: 'xhigh', description: 'Deepest' },
        ],
      },
      { slug: 'gpt-plain', display_name: 'GPT Plain', visibility: 'list' },
      { slug: 'gpt-hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    ],
  }),
);
const { app, home, port, base, call, claude, codex, mock, chat, newBot, newRoutine, storeBot, turnsOf } = await startServer({
  fakeClis: true,
  env: { BOTONS_SCHEDULER_MS: '1h' },
});

const argOf = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
/** Codex's `-c` overrides that set the reasoning effort. */
const codexEffort = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === '-c' && a.startsWith('model_reasoning_effort='));

async function runNow(app: App, routine: Routine) {
  const run = app.engine.triggerRoutine(routine.id, 'manual', null);
  return until(() => {
    const r = app.store.findRun(run.id);
    return r && (r.status === 'succeeded' || r.status === 'failed') && app.engine.statusOf(routine.botId).state === 'idle' && r;
  });
}

test('the CLIs are told the effort their way: Claude Code --effort, Codex model_reasoning_effort; nothing when it is the default', () => {
  const req = { systemPrompt: 'sys', model: 'opus', sessionId: null, access: 'host' as const, privatePaths: [], cwd: '/tmp/w' };
  assert.equal(argOf(claudeArgs({ ...req, effort: 'high' }), '--effort'), 'high');
  for (const effort of [undefined, '']) {
    const argv = claudeArgs({ ...req, effort });
    assert.ok(!argv.includes('--effort'), argv.join(' '));
    assert.deepEqual(argv, claudeArgs(req), 'the same command as without the setting');
  }
  const resumed = codexArgs({ ...req, effort: 'xhigh', sessionId: 'thread-1' });
  assert.deepEqual(codexEffort(resumed), ['model_reasoning_effort="xhigh"']);
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(codexEffort(codexArgs({ ...req, effort: 'low' })), ['model_reasoning_effort="low"']);
  assert.deepEqual(codexArgs({ ...req, effort: '' }), codexArgs(req));
  assert.deepEqual(codexEffort(codexArgs(req)), []);
});

test('levels are checked per provider, with the levels it has in the refusal', () => {
  assert.equal(effortProblem('claude-cli', ''), null);
  assert.equal(effortProblem('claude-cli', 'max'), null);
  assert.equal(effortProblem('codex-cli', 'minimal'), null);
  assert.match(effortProblem('claude-cli', 'minimal') ?? '', /no effort level "minimal": use one of low, medium, high, xhigh, max, or "" for its default/);
  assert.match(effortProblem('codex-cli', 'turbo') ?? '', /use one of none, minimal, low, medium, high, xhigh, max, ultra/);
  assert.match(effortProblem('some-other-cli', 'high') ?? '', /has no effort setting/);
  // Every provider Botons runs has its levels written down.
  for (const id of app.providers.ids()) assert.ok(PROVIDER_EFFORT[id], id);
});

test("GET /api/providers says each brain's levels, how they reach it, and which levels each Codex model lists", async () => {
  const { data } = await call<ProviderInfo[]>('GET', '/api/providers');
  const by = Object.fromEntries(data.map((p) => [p.id, p]));
  assert.deepEqual(
    by['claude-cli'].effort.levels.map((l) => l.id),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.match(by['claude-cli'].effort.via ?? '', /--effort/);
  assert.match(by['codex-cli'].effort.via ?? '', /model_reasoning_effort/);
  assert.equal(by['claude-cli'].effort.reason, null);
  const models = Object.fromEntries(by['codex-cli'].models.map((m) => [m.id, m]));
  assert.deepEqual([models['gpt-test'].efforts, models['gpt-test'].defaultEffort], [['low', 'medium', 'high', 'xhigh'], 'medium']);
  assert.deepEqual([models['gpt-plain'].efforts, models['gpt-plain'].defaultEffort], [undefined, undefined]);
  assert.ok(!models['gpt-hidden']);
  // A level name that isn't one is left out, not passed on.
  assert.deepEqual(codexModel({ slug: 'x', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'NOT A LEVEL' }, {}], default_reasoning_level: 7 }), { id: 'x', label: 'x', efforts: ['high'] });
});

test('Carl at high with a routine at low: the next chat turn starts with high, the routine run with low, in the same session', async () => {
  const carl = await newBot('Carl', { provider: 'claude-cli', model: 'sonnet', effort: 'high' });
  assert.equal(carl.effort, 'high');
  const check = await newRoutine(carl.id, { name: 'Quick check', instruction: 'Check', effort: 'low' });
  assert.equal(check.effort, 'low');

  claude.script('claude/reply');
  const reply = await chat(carl.id, 'hello');
  const [first] = claude.calls();
  assert.equal(argOf(first.argv, '--effort'), 'high');
  assert.equal(reply.meta?.effort, 'high');
  // The Boton is told what it runs on, outside the system prompt.
  assert.match(first.stdin, /^Requested: Claude, model sonnet, effort high, which the CLI may change for a model that lacks it$/m);
  const session = app.store.getBot(carl.id).sessionId;
  assert.ok(session);

  claude.script('claude/reply');
  await runNow(app, check);
  const [run] = claude.calls();
  assert.equal(argOf(run.argv, '--effort'), 'low');
  assert.equal(argOf(run.argv, '--resume'), session, 'a level of its own keeps the chat session');
  assert.match(run.stdin, /^Requested: Claude, model sonnet, effort low \(the routine's own\), which the CLI may change for a model that lacks it$/m);
  assert.match(run.stdin, /"Quick check": [^\n]*effort low/);

  // A new level for the Boton keeps its session too: effort is not part of the system prompt.
  await call('PATCH', `/api/bots/${carl.id}`, { effort: 'max' });
  claude.script('claude/reply');
  await chat(carl.id, 'again');
  const [again] = claude.calls();
  assert.deepEqual([argOf(again.argv, '--effort'), argOf(again.argv, '--resume')], ['max', session]);
});

test('Codex Carl at high with a routine at low: model_reasoning_effort on each turn', async () => {
  const carl = await newBot('Codex Carl', { provider: 'codex-cli', model: 'gpt-test', effort: 'high' });
  const check = await newRoutine(carl.id, { name: 'Quick check', instruction: 'Check', effort: 'low' });
  codex.script('codex/reply');
  await chat(carl.id, 'hello');
  assert.deepEqual(codexEffort(codex.calls()[0].argv), ['model_reasoning_effort="high"']);
  codex.script('codex/resume');
  await runNow(app, check);
  const [run] = codex.calls();
  assert.deepEqual(codexEffort(run.argv), ['model_reasoning_effort="low"']);
  assert.deepEqual(run.argv.slice(0, 2), ['exec', 'resume']);
});

test('a Boton without the setting runs exactly as before: no effort flag, no meta, "no effort level" in its context', async () => {
  const plain = await newBot('Kevin', { provider: 'claude-cli', model: 'sonnet' });
  assert.equal(plain.effort, '');
  claude.script('claude/reply');
  const reply = await chat(plain.id, 'hello');
  const [first] = claude.calls();
  assert.ok(!first.argv.includes('--effort'), first.argv.join(' '));
  assert.equal(reply.meta?.effort, undefined);
  assert.match(first.stdin, /^Requested: Claude, model sonnet, no effort level \(the CLI's default for the model\)$/m);
  const routine = await newRoutine(plain.id, { name: 'Plain' });
  assert.equal(routine.effort, null);
  claude.script('claude/reply');
  await runNow(app, routine);
  assert.ok(!claude.calls()[0].argv.includes('--effort'));

  const codexPlain = await newBot('Stuart', { provider: 'codex-cli' });
  codex.script('codex/reply');
  await chat(codexPlain.id, 'hello');
  assert.deepEqual(codexEffort(codex.calls()[0].argv), []);
});

test('the API refuses a level the provider does not have, and says which it has', async () => {
  const bad = await call('POST', '/api/bots', { name: 'Bob', provider: 'claude-cli', effort: 'minimal' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /no effort level "minimal": use one of low, medium, high, xhigh, max/);
  assert.equal((await call('POST', '/api/bots', { name: 'Bob', provider: 'claude-cli', effort: 7 })).status, 400);
  const bob = await newBot('Bob', { provider: 'codex-cli', effort: 'minimal' });
  assert.equal(bob.effort, 'minimal');
  const patch = await call('PATCH', `/api/bots/${bob.id}`, { effort: 'turbo' });
  assert.equal(patch.status, 400);
  assert.match(patch.data.error, /no effort level "turbo"/);
  assert.equal(app.store.getBot(bob.id).effort, 'minimal');
  const routine = await call('POST', `/api/bots/${bob.id}/routines`, { name: 'R', instruction: 'Do', effort: 'turbo' });
  assert.equal(routine.status, 400);
  assert.match(routine.data.error, /no effort level "turbo"/);
  const r = await newRoutine(bob.id, { effort: 'high' });
  assert.equal((await call('PATCH', `/api/routines/${r.id}`, { effort: 'nope' })).status, 400);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${r.id}`, { effort: '' })).data.effort, null);
  // Setting the provider and a level together checks the level against the new provider.
  assert.equal((await call('PATCH', `/api/bots/${bob.id}`, { provider: 'claude-cli', effort: 'minimal' })).status, 400);
  assert.equal((await call<Bot>('PATCH', `/api/bots/${bob.id}`, { provider: 'claude-cli', effort: 'max' })).data.effort, 'max');
});

test("moving to a provider without the Boton's or a routine's level: back to the default, with chips; levels it has stay", async () => {
  const dave = storeBot('Dave', 'claude-cli', { effort: 'max' });
  const deep = app.store.createRoutine(dave.id, { name: 'Deep dive', instruction: 'Dig', effort: 'xhigh' });
  const quick = app.store.createRoutine(dave.id, { name: 'Quick', instruction: 'Look', effort: 'low' });
  await app.engine.updateBot(dave.id, { provider: 'mock' }, app.providers.ids());
  assert.equal(app.store.getBot(dave.id).effort, '');
  assert.deepEqual([app.store.getRoutine(deep.id).effort, app.store.getRoutine(quick.id).effort], [null, 'low']);
  const chips = app.store.listMessages(dave.id).filter((m: Message) => m.meta?.kind === 'effort.reset');
  assert.deepEqual(
    chips.map((m) => m.text),
    [
      "Mock has no effort level “xhigh”, so routine “Deep dive” (was xhigh) now uses the Boton's effort",
      'Mock has no effort level “max”, so this Boton now asks for none: the CLI uses its default',
    ],
  );
  assert.equal(chips[0].meta?.routineId, deep.id);

  // Levels both have stay; an explicit default says nothing.
  const jerry = storeBot('Jerry', 'claude-cli', { effort: 'high' });
  await app.engine.updateBot(jerry.id, { provider: 'codex-cli' }, app.providers.ids());
  assert.equal(app.store.getBot(jerry.id).effort, 'high');
  const phil = storeBot('Phil', 'claude-cli', { effort: 'max' });
  await app.engine.updateBot(phil.id, { provider: 'mock', effort: '' }, app.providers.ids());
  assert.equal(app.store.listMessages(phil.id).filter((m: Message) => m.meta?.kind === 'effort.reset').length, 0);

  // The mock turn after the move asks for no level.
  await chat(dave.id, 'hi');
  assert.equal(turnsOf(dave.id).at(-1)!.effort, undefined);
});

test('a Boton sets and clears a routine\'s effort with the `botons` CLI; a level its provider lacks is refused with the list', async () => {
  const bot = storeBot('Clia', 'claude-cli');
  const cli = (...args: string[]) => botonCli(app, base, bot.id, ...args);
  const created = await cli('routine', 'create', '--name', 'Quick check', '--instruction', 'Look', '--schedule', 'every 15m', '--effort', 'low', '--json');
  assert.equal(created.code, 0, created.stderr);
  const r = JSON.parse(created.stdout) as Routine;
  assert.equal(r.effort, 'low');
  assert.match((await cli('routine', 'list')).stdout, /Quick check {2}\(Every 15 minutes, active, next [^)]*, effort low\)/);
  assert.equal((await cli('routine', 'update', r.id, '--effort', 'max')).code, 0);
  assert.equal(app.store.getRoutine(r.id).effort, 'max');
  assert.equal((await cli('routine', 'update', r.id, '--no-effort')).code, 0);
  assert.equal(app.store.getRoutine(r.id).effort, null);
  assert.equal((await cli('routine', 'update', r.id, '--effort', 'high')).code, 0);
  assert.equal((await cli('routine', 'update', r.id, '--effort', '')).code, 0);
  assert.equal(app.store.getRoutine(r.id).effort, null);
  const bad = await cli('routine', 'update', r.id, '--effort', 'ludicrous');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no effort level "ludicrous": use one of low, medium, high, xhigh, max/);
  assert.match((await cli('help')).stdout, /\[--effort <level> \| --no-effort\]/);
});

test('the mock provider is handed the level, so engine tests see it', async () => {
  const bot = storeBot('Mel', 'mock', { effort: 'medium' });
  await chat(bot.id, 'hi');
  assert.equal(turnsOf(bot.id).at(-1)!.effort, 'medium');
  assert.ok(mock.turns.length > 0);
});

test("a Codex model's own list is checked: a level it leaves out is refused with its levels; a model the list doesn't know takes the provider's", async () => {
  const bad = await call('POST', '/api/bots', { name: 'Tim', provider: 'codex-cli', model: 'gpt-test', effort: 'minimal' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /model list has no effort level "minimal" for GPT Test \(gpt-test\): use one of low, medium, high, xhigh, or "" for its default \(medium, as the list says\)/);
  // Nothing is known about these: only Codex's own levels are checked, and none is made up for the model.
  for (const model of ['gpt-plain', 'gpt-unlisted', '']) assert.equal((await newBot(`Tim ${model}`, { provider: 'codex-cli', model, effort: 'minimal' })).effort, 'minimal', model);
  const tim = await newBot('Tim', { provider: 'codex-cli', model: 'gpt-test', effort: 'xhigh' });
  assert.equal((await call('PATCH', `/api/bots/${tim.id}`, { effort: 'minimal' })).status, 400);
  assert.equal((await call('PATCH', `/api/bots/${tim.id}`, { model: 'gpt-plain', effort: 'minimal' })).status, 200);
  assert.equal((await call('PATCH', `/api/bots/${tim.id}`, { model: 'gpt-test', effort: 'minimal' })).status, 400, 'a new model and a level together are checked together');
  assert.equal(app.store.getBot(tim.id).model, 'gpt-plain');
});

test("a new model without the Boton's level: back to the default with a chip saying why; a level it has, or no level, stays without one", async () => {
  const mel = await newBot('Mel', { provider: 'codex-cli', model: 'gpt-plain', effort: 'minimal' });
  const chips = (id: string) => app.store.listMessages(id).filter((m: Message) => m.meta?.kind === 'effort.reset').map((m) => m.text);
  assert.equal((await call<Bot>('PATCH', `/api/bots/${mel.id}`, { model: 'gpt-test' })).data.effort, '');
  assert.deepEqual(chips(mel.id), ["Codex's model list has no effort level “minimal” for gpt-test, so this Boton now asks for none: the CLI uses its default"]);
  const ok = await newBot('Ok', { provider: 'codex-cli', model: 'gpt-plain', effort: 'high' });
  assert.equal((await call<Bot>('PATCH', `/api/bots/${ok.id}`, { model: 'gpt-test' })).data.effort, 'high');
  const none = await newBot('None', { provider: 'codex-cli', model: 'gpt-plain' });
  assert.equal((await call<Bot>('PATCH', `/api/bots/${none.id}`, { model: 'gpt-test', name: 'None 2' })).data.effort, '');
  assert.deepEqual([chips(ok.id), chips(none.id)], [[], []]);
  // A routine's own level the Boton's new model leaves out goes back to the Boton's.
  const rae = await newBot('Rae', { provider: 'codex-cli', model: 'gpt-plain' });
  const own = await newRoutine(rae.id, { name: 'Own', effort: 'minimal' });
  await call('PATCH', `/api/bots/${rae.id}`, { model: 'gpt-test' });
  assert.equal(app.store.getRoutine(own.id).effort, null);
  assert.deepEqual(chips(rae.id), ["Codex's model list has no effort level “minimal” for gpt-test, so routine “Own” (was minimal) now uses the Boton's effort"]);
});

test("a routine's own model is checked with the effort it runs at, its own or the Boton's, on create and update, over the API and the `botons` CLI", async () => {
  const bob = await newBot('Bobby', { provider: 'codex-cli', model: 'gpt-plain', effort: 'minimal' });
  const inherits = await call('POST', `/api/bots/${bob.id}/routines`, { name: 'R', instruction: 'Do', model: 'gpt-test' });
  assert.equal(inherits.status, 400);
  assert.match(inherits.data.error, /no effort level "minimal" \(the Boton's\) for gpt-test: give the routine its own effort, one of low, medium, high, xhigh/);
  const own = await call('POST', `/api/bots/${bob.id}/routines`, { name: 'R', instruction: 'Do', model: 'gpt-test', effort: 'minimal' });
  assert.equal(own.status, 400);
  assert.match(own.data.error, /no effort level "minimal" for GPT Test \(gpt-test\): use one of low, medium, high, xhigh, or leave it out for the Boton's effort$/);
  const r = await newRoutine(bob.id, { name: 'Fits', model: 'gpt-test', effort: 'low' });
  assert.equal((await call('PATCH', `/api/routines/${r.id}`, { effort: null })).status, 400, "back to the Boton's minimal on gpt-test");
  assert.equal((await call('PATCH', `/api/routines/${r.id}`, { effort: 'minimal' })).status, 400);
  assert.equal((await call<Routine>('PATCH', `/api/routines/${r.id}`, { model: null, effort: null })).data.effort, null, 'the Boton’s model takes the Boton’s level');
  const plain = await newRoutine(bob.id, { name: 'Plain' });
  assert.equal((await call('PATCH', `/api/routines/${plain.id}`, { model: 'gpt-test' })).status, 400);
  // A combination that stopped fitting doesn't block other changes, the editor sending both back with them.
  app.store.db.prepare("update routines set model = 'gpt-test', effort = null where id = ?").run(plain.id);
  assert.equal((await call('PATCH', `/api/routines/${plain.id}`, { name: 'Plain 2', model: 'gpt-test', effort: null })).status, 200);

  const cli = (...args: string[]) => botonCli(app, base, bob.id, ...args);
  const refused = await cli('routine', 'create', '--name', 'Quick', '--instruction', 'Look', '--model', 'gpt-test');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /\(the Boton's\) for gpt-test: give the routine its own effort, one of low, medium, high, xhigh/);
  const made = await cli('routine', 'create', '--name', 'Quick', '--instruction', 'Look', '--model', 'gpt-test', '--effort', 'low', '--json');
  assert.equal(made.code, 0, made.stderr);
  const id = (JSON.parse(made.stdout) as Routine).id;
  assert.equal((await cli('routine', 'update', id, '--no-effort')).code, 1);
  assert.equal((await cli('routine', 'update', id, '--effort', 'xhigh')).code, 0);
});

test("a turn asks for no level the model's list leaves out, and its context says what it asked for and what the list gives as the default", async () => {
  const kev = await newBot('Kev', { provider: 'codex-cli', model: 'gpt-plain', effort: 'minimal' });
  const r = await newRoutine(kev.id, { name: 'On test', model: 'gpt-test', effort: 'low' });
  // Left behind by a change the store can't see, such as a new model list.
  app.store.db.prepare('update routines set effort = null where id = ?').run(r.id);
  codex.script('codex/reply');
  await runNow(app, r);
  const [run] = codex.calls();
  assert.deepEqual(codexEffort(run.argv), []);
  assert.match(run.stdin, /^Requested: Codex, model gpt-test \(the routine's own\), no effort level \(the CLI's default for the model, medium in its model list; “minimal” left out: the model's list doesn't have it\)$/m);

  const def = await newBot('Def', { provider: 'codex-cli', model: 'gpt-test' });
  codex.script('codex/reply');
  const reply = await chat(def.id, 'hi');
  assert.match(codex.calls()[0].stdin, /^Requested: Codex, model gpt-test, no effort level \(the CLI's default for the model, medium in its model list\)$/m);
  assert.equal(reply.meta?.effort, undefined, 'nothing is claimed about the level that ran');

  // A Boton's new level its routines' own model leaves out: the chat says those runs ask for none.
  await call('PATCH', `/api/bots/${kev.id}`, { effort: 'none' });
  const chip = app.store.listMessages(kev.id).filter((m: Message) => m.meta?.kind === 'effort.reset').at(-1);
  assert.equal(chip?.text, "Codex's model list has no effort level “none” for gpt-test, so routine “On test” asks for none on its runs: give it an effort of its own");
});

test('the form keeps a level the next brain has, and a save it did not pick sends none, so the server resets and says so', async () => {
  const { data: providers } = await call<ProviderInfo[]>('GET', '/api/providers');
  const brain = (id: string) => providers.find((p) => p.id === id);
  // Claude Code at high, moved to Codex: Codex has high, so the form keeps it and the save keeps it.
  const ann = await newBot('Ann', { provider: 'claude-cli', model: 'sonnet', effort: 'high' });
  let shown = shownEffort(brain('codex-cli'), '', ann.effort);
  assert.equal(shown, 'high');
  let patch = { provider: 'codex-cli', model: '', ...effortPatch({ picked: false, wanted: ann.effort, shown, savedShown: shown }) };
  assert.equal((await call<Bot>('PATCH', `/api/bots/${ann.id}`, patch)).data.effort, 'high');
  // Back and forth through a brain without it, as the form holds the wanted level: it comes back.
  assert.equal(shownEffort(brain('mock'), '', 'max'), '');
  assert.equal(shownEffort(brain('claude-cli'), 'sonnet', 'max'), 'max');
  assert.equal(shownEffort(brain('codex-cli'), 'gpt-test', 'minimal'), '');

  // Max moved to the mock, which lacks it: the form shows the default, the save leaves effort out, the chat says why.
  const max = await newBot('Maxine', { provider: 'claude-cli', effort: 'max' });
  shown = shownEffort(brain('mock'), '', max.effort);
  patch = { provider: 'mock', model: '', ...effortPatch({ picked: false, wanted: max.effort, shown, savedShown: shown }) };
  assert.equal('effort' in patch, false);
  assert.equal((await call<Bot>('PATCH', `/api/bots/${max.id}`, patch)).data.effort, '');
  assert.equal(app.store.listMessages(max.id).filter((m: Message) => m.meta?.kind === 'effort.reset').length, 1);

  // The owner picking the default: their choice, said nowhere.
  const pick = await newBot('Pick', { provider: 'claude-cli', effort: 'max' });
  patch = { provider: 'claude-cli', model: '', ...effortPatch({ picked: true, wanted: '', shown: '', savedShown: 'max' }) };
  assert.deepEqual((await call<Bot>('PATCH', `/api/bots/${pick.id}`, patch)).data.effort, '');
  assert.equal(app.store.listMessages(pick.id).filter((m: Message) => m.meta?.kind === 'effort.reset').length, 0);
  // Picked max, then moved to a brain without it where the saved high fits: the default, as the form says.
  assert.deepEqual(effortPatch({ picked: true, wanted: 'max', shown: '', savedShown: 'high' }), { effort: '' });
  assert.deepEqual(effortPatch({ picked: true, wanted: 'max', shown: '', savedShown: '' }), {});
});


test('doctor labels cache-drifted effort as configured while the turn omits it', async () => {
  const bot = await newBot('Dave', { provider: 'codex-cli', model: 'gpt-test', effort: 'high' });
  const file = join(codexHome, 'models_cache.json');
  const original = readFileSync(file, 'utf8');
  try {
    const cache = JSON.parse(original);
    cache.models.find((m: { slug: string }) => m.slug === 'gpt-test').supported_reasoning_levels = [{ effort: 'low' }];
    writeFileSync(file, JSON.stringify(cache));
    const findings = await diagnose({ egress: async () => ({ v4: true, v6: true }), 
      env: { BOTONS_HOME: home, BOTONS_PORT: String(port), BOTONS_NO_TAILSCALE: '1', XDG_CONFIG_HOME: join(home, 'xdg'), CODEX_HOME: codexHome, ...noRealClis(home) },
      container: false, skipClis: true,
    });
    const brain = findings.find((f) => f.check === 'brain' && f.message.startsWith('Dave: codex-cli, model gpt-test,'));
    assert.match(brain?.message ?? '', /configured effort high/);
    assert.doesNotMatch(brain?.message ?? '', /requested effort/);
    codex.script('codex/reply');
    const reply = await chat(bot.id, 'hi');
    assert.deepEqual(codexEffort(codex.calls()[0].argv), []);
    assert.equal(reply.meta?.effort, undefined);
    assert.match(codex.calls()[0].stdin, /“high” left out: the model's list doesn't have it/);
  } finally {
    writeFileSync(file, original);
  }
});
