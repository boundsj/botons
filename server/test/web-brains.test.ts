// What the owner is told about each brain (web/src/brains.ts): from the readiness's fixed words only, the command to run
// on the server, what happens to its Botons' work, and which of two answers is kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, BrainReadiness, BrainState, ProviderInfo } from '../../shared/types.ts';
import { brainDown, brainRest, brainSetUp, brainUsers, brainView, checkOf, mergeProviders, botonsOn, restText, signInFinished, usedByText } from '../../web/src/brains.ts';

const RAW = 'Run `botons login claude` on myhost: sk-test-secret at /home/you/.claude';
const brain = (id: string, state: BrainState, over: Partial<BrainReadiness> = {}, generation = 5, boot = 'boot-a'): ProviderInfo =>
  ({
    id, label: id === 'codex-cli' ? 'Codex (OpenAI)' : 'Claude Code', available: state === 'ready', reason: RAW, lastError: null, lastSuccessAt: null,
    readiness: { state, problem: null, checkedAt: new Date(Date.now() - 120_000).toISOString(), usageLimitUntil: null, boot, generation, ...over },
  }) as ProviderInfo;
const all = (v: ReturnType<typeof brainView>) => [v.status, v.why, v.fix?.text, v.fix?.command, v.work].filter(Boolean).join(' | ');

test('every state says what it is, why and what to do, with the command for the install kind, and never the check\'s own text', () => {
  const cases: Array<[BrainState, Partial<BrainReadiness>]> = [
    ['ready', {}],
    ['signed-out', { problem: 'signed-out' }],
    ['not-installed', { problem: 'not-found' }],
    ['unavailable', { problem: 'not-runnable' }],
    ['unavailable', { problem: 'version-failed' }],
    ['unavailable', { problem: 'incompatible-version' }],
    ['usage-limited', { problem: 'usage-limit', usageLimitUntil: '2026-11-06T15:00:00.000Z' }],
    ['unknown', { problem: 'not-checked', checkedAt: null }],
    ['unknown', { problem: 'outdated' }],
    ['unknown', { problem: 'clock-changed' }],
    ['unknown', { problem: 'timed-out' }],
    ['unknown', { problem: 'login-unreadable' }],
  ];
  for (const [state, over] of cases) {
    for (const container of [false, true]) {
      const text = all(brainView(brain('claude-cli', state, over), { container }));
      for (const leak of ['myhost', 'sk-test', '/home/you']) assert.ok(!text.includes(leak), `${state} ${over.problem}: ${leak}`);
    }
  }
  assert.deepEqual(brainView(brain('claude-cli', 'ready'), { container: false }), { status: 'Ready', tone: 'ok', why: null, fix: null, work: null });

  const out = brainView(brain('claude-cli', 'signed-out', { problem: 'signed-out' }), { container: false });
  assert.equal(out.status, 'Not signed in');
  assert.equal(out.fix?.command, 'botons login claude');
  assert.match(out.fix!.text, /Botons never signs in for you/);
  assert.match(out.work!, /fail until it is ready.*isn't held/);
  assert.equal(brainView(brain('codex-cli', 'signed-out', { problem: 'signed-out' }), { container: true }).fix?.command, 'docker compose exec -it botons botons login codex');

  const missing = brainView(brain('codex-cli', 'not-installed', { problem: 'not-found' }), { container: false });
  assert.match(missing.fix!.text, /BOTONS_CODEX_BIN.*~\/\.config\/botons\/env/);
  assert.equal(brainView(brain('codex-cli', 'not-installed', { problem: 'not-found' }), { container: true }).fix?.command, 'docker compose up -d --build');

  const limited = brainView(brain('claude-cli', 'usage-limited', { problem: 'usage-limit', usageLimitUntil: '2026-11-06T15:00:00.000Z' }), { container: false, now: Date.parse('2026-11-06T12:00:00.000Z') });
  assert.equal(limited.fix, null, 'nothing to do but wait (or move a Boton)');
  assert.match(limited.work!, /carry on by themselves when it resets, unless paused/);

  const slow = brainView(brain('claude-cli', 'unknown', { problem: 'timed-out' }), { container: false });
  assert.equal(slow.status, 'Sign-in unconfirmed');
  assert.equal(slow.fix?.command, 'claude auth status');
  assert.match(slow.work!, /tried as usual/);
  const never = brainView({ ...brain('mock', 'unknown', { problem: 'not-checked', checkedAt: null }, 0), kind: 'api' }, { container: false });
  assert.deepEqual([never.status, never.fix], ['Not checked', null], 'no check to run again');
  assert.equal(brainView({ ...brain('claude-cli', 'unknown', { problem: 'not-checked', checkedAt: null }, 0), kind: 'cli' }, { container: false }).fix?.text, 'Check again.');
  const old = brainView(brain('claude-cli', 'unknown', { problem: 'outdated' }), { container: false, now: Date.now() });
  assert.match(old.why!, /last check was 2 min\. ago/);
  assert.equal(old.work, null);
});

test('down is a state its work can\'t get past by itself; unknown may well work', () => {
  for (const s of ['signed-out', 'not-installed', 'unavailable', 'usage-limited'] as const) assert.equal(brainDown(brain('claude-cli', s)), true, s);
  for (const s of ['ready', 'unknown'] as const) assert.equal(brainDown(brain('claude-cli', s)), false, s);
});

test('the Botons on a brain, paused ones said so, and only the first five by name', () => {
  const bots = ['Kevin', 'Stuart', 'Bob', 'Dave', 'Jerry', 'Phil', 'Tim'].map((name, i) => ({ id: `b${i}`, name, provider: i === 6 ? 'codex-cli' : 'claude-cli', paused: i === 1 }) as Bot);
  assert.deepEqual(botonsOn('claude-cli', bots, false), { count: 6, text: 'Used by Kevin, Stuart (paused), Bob, Dave, Jerry and 1 more.' });
  assert.deepEqual(botonsOn('codex-cli', bots, true), { count: 1, text: 'Used by Tim (all Botons are paused).' });
  assert.deepEqual(botonsOn('mock', bots, false), { count: 0, text: 'No Boton uses it.' });
});

test('Settings → Brains: each brain is used by the Botons whose own settings pick it, and a saved key is set up but moves none', () => {
  const bots = [{ name: 'Kevin', provider: 'claude-cli', paused: false }, { name: 'Stuart', provider: 'claude-cli', paused: true }, { name: 'Bob', provider: 'codex-cli', paused: false }] as Bot[];
  assert.equal(usedByText(brainUsers('claude-cli', bots)), 'Used by Kevin, Stuart (paused)');
  assert.equal(usedByText(brainUsers('anthropic-api', bots)), 'No Botons yet');
  assert.equal(brainSetUp(brain('anthropic-api', 'signed-out'), { source: 'saved' }), true);
  assert.equal(brainSetUp(brain('anthropic-api', 'ready'), { source: 'none' }), false);
  assert.equal(brainSetUp(brain('claude-cli', 'usage-limited'), undefined), true);
  assert.equal(brainSetUp(brain('codex-cli', 'signed-out'), undefined), false);
});

test('of two answers, each brain keeps the newer check, and of the same check the later request\'s: a slow answer never puts back an older one', () => {
  const shown = [brain('claude-cli', 'signed-out', {}, 9), brain('codex-cli', 'ready', {}, 4)];
  // A request asked before the owner's recheck answers after it: its claude is from the older check.
  const slow = [brain('claude-cli', 'ready', {}, 8), brain('codex-cli', 'ready', { usageLimitUntil: null }, 4)];
  const merged = mergeProviders(shown, slow, false);
  assert.equal(merged[0], shown[0], 'the newer check stays');
  assert.equal(merged[1], shown[1], 'same check, older request: what is shown stays');
  const later = [brain('claude-cli', 'ready', {}, 10), brain('codex-cli', 'usage-limited', {}, 4)];
  const next = mergeProviders(shown, later, true);
  assert.deepEqual(next.map((p) => p.readiness.state), ['ready', 'usage-limited']);
  // A brain the server no longer lists is dropped, a new one is taken.
  assert.equal(checkOf(shown[0]), 'boot-a:9');
  assert.deepEqual(mergeProviders(shown, [brain('mock', 'unknown', {}, 0)], false).map((p) => p.id), ['mock']);
});

test('after a restart the server counts its checks from 1 under a new boot: the later request\'s answer wins, a slow one from the old run never comes back', () => {
  // Shown: the old run's 50th check found it ready. The restarted server's first check finds it signed out.
  const shown = [brain('claude-cli', 'ready', {}, 50, 'boot-old')];
  const restarted = [brain('claude-cli', 'signed-out', { problem: 'signed-out' }, 1, 'boot-new')];
  const now = mergeProviders(shown, restarted, true);
  assert.equal(now[0].readiness.state, 'signed-out', 'a lower generation from a newer run is not older');
  // A request sent to the old run before the restart answers late: it never replaces the new run's answer.
  const late = [brain('claude-cli', 'ready', {}, 51, 'boot-old')];
  assert.equal(mergeProviders(now, late, false)[0], now[0]);
  // Within the new run, generations order again.
  assert.equal(mergeProviders(now, [brain('claude-cli', 'ready', {}, 2, 'boot-new')], false)[0].readiness.state, 'ready');
  assert.equal(mergeProviders(now, [brain('claude-cli', 'ready', {}, 1, 'boot-new')], false)[0], now[0], 'same check, older request');
  assert.notEqual(checkOf(shown[0]), checkOf(brain('claude-cli', 'ready', {}, 50, 'boot-new')), 'the same count in another run is another check');
});

test('a usage limit still holding a brain that is signed out, missing or can\'t run is said with it: held until the reset, then failing until fixed', () => {
  const NOW = Date.parse('2026-11-06T12:00:00.000Z');
  const until = '2026-11-06T15:00:00.000Z';
  const past = '2026-11-06T11:00:00.000Z';
  const view = (state: BrainState, over: Partial<BrainReadiness>, now = NOW) => brainView(brain('claude-cli', state, over), { container: false, now });
  for (const [state, problem] of [['signed-out', 'signed-out'], ['not-installed', 'not-found'], ['unavailable', 'not-runnable']] as const) {
    const plain = view(state, { problem });
    const held = view(state, { problem, usageLimitUntil: until });
    // The headline is still what the owner must fix.
    assert.deepEqual([held.status, held.tone, held.why, held.fix], [plain.status, plain.tone, plain.why, plain.fix], state);
    assert.match(held.work!, /also hit a usage limit.*wait until it resets.*Then they are tried, and fail until it is ready: the reset doesn't fix this/, state);
    assert.match(held.work!, /A paused Boton waits until you resume it/, state);
    assert.doesNotMatch(held.work!, /isn't held|another brain/, `${state}: no failing at once, no promise of moving`);
    // Once the reset has passed, it is as without one.
    assert.equal(view(state, { problem, usageLimitUntil: until }, Date.parse(until) + 1).work, plain.work, `${state} after the reset`);
    assert.equal(view(state, { problem, usageLimitUntil: past }).work, plain.work, `${state}, an old limit`);
  }
  // Ready or unknown with a limit: the server says usage-limited.
  const limited = view('usage-limited', { problem: 'usage-limit', usageLimitUntil: until });
  assert.deepEqual([limited.status, limited.tone, limited.fix], ['Out of usage', 'warn', null]);
  assert.match(limited.work!, /carry on by themselves when it resets, unless paused \(resume first\)/);
  // Shown past its reset: what it is now takes a new look, not a promise.
  const reset = view('usage-limited', { problem: 'usage-limit', usageLimitUntil: until }, Date.parse(until) + 1);
  assert.deepEqual([reset.status, reset.tone, reset.fix?.text], ['Usage limit reset', 'unknown', 'Check again.']);
  assert.match(reset.work!, /unless paused/);
  assert.doesNotMatch(reset.why!, /\bready\b(?! now)/);
  // Ready and unknown keep their words: a limit reaches them only as usage-limited.
  assert.equal(view('ready', {}).status, 'Ready');
  assert.match(view('unknown', { problem: 'timed-out' }).work!, /tried as usual/);
});

test('setup names the compatible Codex baseline and keeps Workspace sandboxing on', () => {
  const view = brainView(brain('codex-cli', 'unavailable', { problem: 'incompatible-version' }), { container: false });
  assert.equal(view.status, 'Upgrade needed');
  assert.match(view.why!, /0\.166\.0.*Bad file descriptor/);
  assert.match(view.fix!.text, /upgrade.*Check again.*Keep Workspace sandboxing enabled/i);
  assert.equal(view.fix!.command, 'npm install -g @openai/codex@latest');
});

test('replacing a CLI after an update replaces its stale higher-generation card', async () => {
  const { ProviderRegistry } = await import('../src/providers/index.ts');
  const { MockProvider } = await import('../src/providers/mock.ts');
  const registry = new ProviderRegistry({enableMock:false,claudeBin:'/no-such-botons-claude',codexBin:'/no-such-botons-codex'});
  const provider = (generation: number, ready: boolean) => {
    const p = new MockProvider(); p.id = 'codex-cli';
    p.info = async () => ({...p.snapshot(),kind:'cli',cli:'codex',checkedAt:new Date().toISOString(),installed:true,loggedIn:ready,available:ready,version:ready?'codex-cli 0.167.0':'codex-cli 0.160.0',check:{generation,problem:ready?null:'incompatible-version'}});
    return p;
  };
  registry.register(provider(12,false));
  const old = await registry.infos();
  registry.register(provider(1,true));
  const next = await registry.infos();
  const shown = mergeProviders(old,next,true).find(p=>p.id==='codex-cli')!;
  assert.equal(shown.readiness.state,'ready');
  assert.equal(shown.version,'codex-cli 0.167.0');
});

test('the fixture mock is explicitly ready for the first-boton flow without CLI credentials', async () => {
  const { ProviderRegistry } = await import('../src/providers/index.ts');
  const registry = new ProviderRegistry({enableMock:true,claudeBin:'/no-such-botons-claude',codexBin:'/no-such-botons-codex'});
  const mock = (await registry.infos()).find(p=>p.id==='mock')!;
  assert.equal(mock.readiness.state,'ready');
});

test('a resting Boton says why: no working brain, or a usage limit that resets by itself; unknown may well work', () => {
  assert.deepEqual(brainRest(undefined), { kind: 'none' });
  assert.equal(brainRest(brain('claude-cli', 'ready')), null);
  assert.equal(brainRest(brain('claude-cli', 'unknown')), null);
  assert.deepEqual(brainRest(brain('claude-cli', 'signed-out')), { kind: 'none' });
  const until = '2026-11-08T18:00:00.000Z';
  assert.deepEqual(brainRest(brain('claude-cli', 'usage-limited', { usageLimitUntil: until })), { kind: 'limited', until });
  assert.equal(restText({ kind: 'limited', until }), 'At its usage limit');
  assert.equal(restText({ kind: 'none' }), 'No working brain');
});

test('Change sign-in folds back only when a sign-in finishes, never while the owner is still choosing', () => {
  assert.equal(signInFinished('waiting', 'finished'), true);
  for (const [prev, next] of [[undefined, 'finished'], ['finished', 'finished'], ['idle', 'idle'], [undefined, 'idle'], ['waiting', 'waiting'], ['waiting', 'cancelled'], ['waiting', 'fallback'], ['waiting', 'timed-out']] as const)
    assert.equal(signInFinished(prev, next), false, `${prev} → ${next}`);
});
