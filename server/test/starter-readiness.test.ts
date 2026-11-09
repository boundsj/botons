import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, ProviderInfo, SetupCheck, TemplateReview } from '../../shared/types.ts';
import { CliChecker, type CliCheck } from '../src/providers/cli-check.ts';
import { CHECK_OUTDATED_MS } from '../src/providers/readiness.ts';
import { startServer, until } from './helpers.ts';

/*
 * A starter's review and setup check report the brains from their last checks only: they never start `--version` or
 * `auth status`, cold or with the cache past its time. The owner's explicit check still runs them.
 */

const s = await startServer({ env: { BOTONS_TZ: 'UTC' }, fakeClis: true });
const { app, call } = s;
const checks = () => s.claude.checks().length + s.codex.checks().length;
const review = () => call<TemplateReview>('POST', '/api/templates/builtin-web-watcher/review', { provider: 'claude-cli', access: 'workspace' });

test('cold, the review starts no check and says the brain was not checked', async () => {
  assert.equal(checks(), 0, 'nothing has checked the CLIs yet');
  const r = await review();
  assert.equal(r.status, 200, r.text);
  assert.equal(checks(), 0, 'no subprocess for the review');
  assert.equal(r.data.brain.state, 'warning');
  assert.equal(r.data.brain.ready, false);
  assert.match(r.data.brain.text, /not known whether it's ready, as it hasn't been checked since the server started/);
});

test('the setup check and review start no check when the cache has expired; the explicit check still runs them', async () => {
  const r = (await review()).data;
  const made = await call<Bot>('POST', '/api/bots', { name: 'Kevin', provider: 'claude-cli', access: 'workspace', templateId: 'builtin-web-watcher', starterConnectors: {}, reviewKey: r.reviewKey });
  assert.equal(made.status, 201, made.text);
  // The owner's explicit check runs the CLIs' checks.
  const beforeExplicit = checks();
  const listed = await call<ProviderInfo[]>('GET', '/api/providers?recheck=1');
  assert.equal(listed.status, 200);
  await until(() => checks() > beforeExplicit, 6000);
  await until(async () => (await call<ProviderInfo[]>('GET', '/api/providers')).data.find((p) => p.id === 'claude-cli')?.readiness.state === 'ready', 6000);
  // Past its time: the next info() would run a new check (as after CHECK_TTL_MS). The review and check must not.
  for (const id of ['claude-cli', 'codex-cli']) app.providers.get(id)!.recheck!();
  const before = checks();
  const c = await call<SetupCheck>('POST', `/api/bots/${made.data.id}/setup-check`, {});
  assert.equal(c.status, 200, c.text);
  const again = await review();
  assert.equal(checks(), before, 'no subprocess for the setup check or the review');
  const brain = c.data.items.find((i) => i.key === 'brain')!;
  assert.equal(brain.state, 'ok');
  assert.match(brain.text, /ready at its last check \(.* UTC\)\. This check didn't ask it anything/);
  assert.equal(again.data.brain.state, 'ok');

  // Too old to count (CHECK_OUTDATED_MS): unknown, said as such, still without a check.
  const later = app.providers.snapshots(Date.now() + CHECK_OUTDATED_MS + 60_000).find((p) => p.id === 'claude-cli')!;
  assert.deepEqual([later.readiness.state, later.readiness.problem], ['unknown', 'outdated']);
  assert.equal(checks(), before);
});

test('CliChecker.peek returns the last finished check and never runs one, however old', async () => {
  let runs = 0;
  let elapsed = 0;
  const clock = { elapsed: () => elapsed, now: () => Date.now() };
  const result = (): CliCheck => ({ installed: true, version: '1', loggedIn: true, reason: null, checkedAt: new Date().toISOString(), problem: null });
  const checker = new CliChecker('fake', async () => (runs++, result()), clock);
  assert.equal(checker.peek(), null, 'cold: nothing known, nothing run');
  assert.equal(runs, 0);
  await checker.get();
  assert.equal(runs, 1);
  elapsed += 60 * 60_000;
  assert.equal(checker.peek()?.version, '1', 'expired: the last one, as it was');
  checker.invalidate();
  assert.equal(checker.peek()?.version, '1');
  assert.equal(runs, 1, 'peek ran nothing');
  await checker.get();
  assert.equal(runs, 2, 'get() still runs a new one when the cached one is past its time');
});
