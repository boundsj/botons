// Settings → Health: GET /api/operations carries fixed words, counts, times and checked versions, never error text,
// paths, addresses or a CLI's own output, while GET /api/health keeps its details for paired devices.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Health, OperationsStatus } from '../../shared/types.ts';
import { buildSha, versionNumber } from '../../shared/util.ts';
import type { Config } from '../src/config.ts';
import type { Engine } from '../src/engine.ts';
import { databaseProblem, HealthMonitor } from '../src/health.ts';
import type { ProviderRegistry } from '../src/providers/index.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import type { Store } from '../src/store.ts';
import { fakeCli } from './fixtures/fake-cli.ts';
import { startServer, tempDir } from './helpers.ts';

const ODD = 'sam@example.com at /home/you/private';

// A claude CLI whose --version prints an account and a path; everything else is the usual fake CLI.
const home = tempDir();
const inner = fakeCli(home, 'claude-inner');
const wrapper = join(home, 'claude');
writeFileSync(
  wrapper,
  `#!${process.execPath} --no-warnings
if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(`${ODD}\n`)}); }
else { const r = (await import('node:child_process')).spawnSync(${JSON.stringify(inner.bin)}, process.argv.slice(2), { stdio: 'inherit' }); process.exitCode = r.status ?? 1; }
`,
);
chmodSync(wrapper, 0o755);
const s = await startServer({ home, env: { BOTONS_CLAUDE_BIN: wrapper } });

test('operations: a CLI version, provider errors and missing CLI paths never reach the owner view (web-operations checks its summary)', async () => {
  s.app.providers.recordTurn('mock', { ok: false, error: `auth failed for ${ODD}` });
  const raw = await s.call<Health>('GET', '/api/health');
  const claudeRaw = raw.data.details?.providers.find((p) => p.id === 'claude-cli');
  assert.equal(claudeRaw?.installed, true, 'the CLI is ready as before: the version is only parsed for display');
  assert.equal(claudeRaw?.loggedIn, true);
  assert.equal(claudeRaw?.version, ODD, '/api/health keeps its contract');

  const r = await s.call<OperationsStatus>('GET', '/api/operations');
  assert.equal(r.status, 200);
  const brains = r.data.health.details.providers;
  const claude = brains.find((p) => p.id === 'claude-cli');
  assert.deepEqual({ available: claude?.available, version: claude?.version, problem: claude?.problem }, { available: true, version: null, problem: null });
  const codex = brains.find((p) => p.id === 'codex-cli');
  assert.equal(codex?.problem, 'not-installed');
  const mock = brains.find((p) => p.id === 'mock');
  assert.ok(mock?.lastErrorAt, 'when the last turn failed is kept');
  assert.equal(r.data.schema, SCHEMA_VERSION);
  assert.equal(r.data.health.details.database.problem, null);
  const shown = r.text;
  for (const secret of ['sam@example.com', '/home/you', 'private', 'auth failed', s.home, 'reason', 'message']) assert.ok(!shown.includes(secret), secret);
});

/** A HealthMonitor over a database that throws `err`. */
function failingDb(err: Error) {
  const store = { db: { prepare: () => { throw err; } } } as unknown as Store;
  const cfg = { schedulerIntervalMs: 10_000, build: 'not a sha /home/you' } as Config;
  const engine = { draining: false } as Engine;
  const providers = { infos: async () => [] } as unknown as ProviderRegistry;
  return new HealthMonitor({ cfg, store, engine, providers });
}

test('operations: a database failure is a fixed word for the owner, the error text stays in /api/health', async () => {
  const err = Object.assign(new Error('unable to open database file: /home/you/.botons/botons.db'), { code: 'ERR_SQLITE_ERROR', errcode: 14, errstr: 'unable to open database file' });
  const monitor = failingDb(err);
  const owner = await monitor.owner();
  assert.deepEqual(owner.details.database, { ok: false, problem: 'cannot-open' });
  assert.equal(owner.build, null, 'a build that is not a sha is not shown');
  assert.deepEqual(owner.failing, ['database', 'providers']);
  assert.ok(!JSON.stringify(owner).includes('/home/you'));
  assert.match((await monitor.check()).details.database.error ?? '', /unable to open/);
});

test('database problems: SQLite codes, extended codes included, map to fixed words', () => {
  const e = (errcode: number) => Object.assign(new Error('x'), { errcode });
  assert.equal(databaseProblem(e(5)), 'busy');
  assert.equal(databaseProblem(e(517)), 'busy', 'SQLITE_BUSY_SNAPSHOT');
  assert.equal(databaseProblem(e(11)), 'corrupt');
  assert.equal(databaseProblem(e(26)), 'corrupt');
  assert.equal(databaseProblem(e(8)), 'read-only');
  assert.equal(databaseProblem(e(13)), 'disk-full');
  assert.equal(databaseProblem(e(14)), 'cannot-open');
  assert.equal(databaseProblem(e(522)), 'io-error', 'SQLITE_IOERR_SHORT_READ');
  assert.equal(databaseProblem(e(1)), 'other');
  assert.equal(databaseProblem(new Error('database is not open')), 'other');
});

test('versions and builds: only their expected shapes are kept', () => {
  assert.equal(versionNumber('2.1.316 (Claude Code)'), '2.1.316');
  assert.equal(versionNumber('codex-cli 0.46.0'), '0.46.0');
  assert.equal(versionNumber('codex-cli 0.47.0-alpha.2'), '0.47.0-alpha.2');
  assert.equal(versionNumber('v1.2.3'), '1.2.3');
  assert.equal(versionNumber(ODD), null);
  assert.equal(versionNumber('reached 10.0.0.1 as sam@example.com'), null, 'an address is not a version');
  assert.equal(versionNumber('/home/you/1.2.3/bin'), null, 'nor a path segment');
  assert.equal(versionNumber(null), null);
  assert.equal(buildSha('546c9c968cdebd5dbab145cd9e1b38702f7ee710'), '546c9c968cdebd5dbab145cd9e1b38702f7ee710');
  assert.equal(buildSha('abc1234'), 'abc1234');
  assert.equal(buildSha('abc12'), null);
  assert.equal(buildSha('myhost'), null);
  assert.equal(buildSha(null), null);
});
