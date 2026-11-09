import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { BotTemplate } from '../../shared/types.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import { findBrowser } from '../../server/src/browser.ts';
import { browserUsable, drivesBrowser, newBotonConnections } from '../../server/src/browser-policy.ts';
import { Connectors, countedConnections, MAX_CONNECTIONS } from '../../server/src/connectors.ts';
import { connectionIds } from '../../server/src/portable.ts';
import { openSchema } from '../../server/src/schema.ts';
import { STARTERS, starterConnections } from '../../server/src/starters.ts';

// In-process only: an in-memory database and a temp folder, no server, no Chromium, no turn.
const home = mkdtempSync(join(tmpdir(), 'botons-browser-defaults-'));
after(() => rmSync(home, { recursive: true, force: true }));
const db = new DatabaseSync(':memory:');
openSchema(db);
const connectors = new Connectors(db, { home, providers: { ids: () => [], get: () => undefined } as never, store: { atomically: (fn: () => unknown) => fn(), dropFromBots: () => {} } as never });
const fifty = Array.from({ length: MAX_CONNECTIONS }, (_, i) => `lib:c${i}`);
const starter = (id: string) => STARTERS.find((t) => t.id === id) as unknown as BotTemplate;

test('a new Boton gets the browser unless its request names its connectors; a template keeps every connector it had', () => {
  assert.deepEqual(newBotonConnections(undefined, [], true), [BROWSER_CONNECTOR]);
  assert.deepEqual(newBotonConnections(undefined, ['lib:notes'], true), [BROWSER_CONNECTOR, 'lib:notes']);
  assert.deepEqual(newBotonConnections(undefined, [BROWSER_CONNECTOR, 'lib:notes'], true), [BROWSER_CONNECTOR, 'lib:notes']);
  // An explicit choice, none included, is exactly what the Boton gets.
  assert.deepEqual(newBotonConnections([], ['lib:notes'], true), []);
  assert.deepEqual(newBotonConnections(['lib:notes'], [], true), ['lib:notes']);
  // Starters: the browser, then the owner's slot choices.
  assert.deepEqual(starterConnections(starter('builtin-morning-brief'), { calendar: null }, true), [BROWSER_CONNECTOR]);
  assert.deepEqual(starterConnections(starter('builtin-morning-brief'), { calendar: 'lib:cal' }, true), [BROWSER_CONNECTOR, 'lib:cal']);
});

test("a brain that can't run the browser (an API key's) gets none by default, not even a template's", () => {
  // The repo's own predicate: an agent CLI drives it; an API key brain (server-side tools) or the mock doesn't.
  assert.equal(drivesBrowser({ cli: { command: 'claude' } }), true);
  assert.equal(drivesBrowser({ serverTools: true } as never), false);
  assert.equal(drivesBrowser(undefined), false);
  assert.deepEqual(newBotonConnections(undefined, [], false), []);
  assert.deepEqual(newBotonConnections(undefined, [BROWSER_CONNECTOR, 'lib:notes'], false), ['lib:notes']);
  assert.deepEqual(starterConnections(starter('builtin-morning-brief'), { calendar: 'lib:cal' }, false), ['lib:cal']);
  // What the request names is still exactly what it gets.
  assert.deepEqual(newBotonConnections([BROWSER_CONNECTOR], [], false), [BROWSER_CONNECTOR]);
  // The catalog offers the browser only to the brains that can run it.
  const providers = new Map<string, object>([['claude-cli', { id: 'claude-cli', cli: { command: 'claude' } }], ['anthropic-api', { id: 'anthropic-api', serverTools: true }]]);
  const bothDb = new DatabaseSync(':memory:');
  openSchema(bothDb);
  const both = new Connectors(bothDb, { home, providers: { ids: () => providers.keys(), get: (id: string) => providers.get(id) } as never, store: { atomically: (fn: () => unknown) => fn(), dropFromBots: () => {} } as never });
  both.browser = { server: () => assert.fail('not resolved here'), unavailable: () => null };
  assert.deepEqual(both.catalog().connectors.find((c) => c.id === BROWSER_CONNECTOR)?.providers, ['claude-cli']);
});

test('the browser takes no place among the 50 connectors: a saved template with 50 still makes a Boton, with all 50', () => {
  connectors.browser = { server: () => ({ name: 'botons_browser', kind: 'stdio', command: 'x', args: [], env: {} }), unavailable: () => null };
  const ids = newBotonConnections(undefined, fifty, true);
  assert.equal(ids.length, MAX_CONNECTIONS + 1);
  assert.equal(countedConnections(ids), MAX_CONNECTIONS);
  // `current` stands in for the catalog here: these ids are taken as known.
  assert.deepEqual(connectors.check(ids, fifty), ids);
  assert.throws(() => connectors.check([...fifty, 'lib:c50'], [...fifty, 'lib:c50']), /at most 50 connectors/);
  // Exported and imported again just the same; 51 others are still too many.
  assert.deepEqual(connectionIds(ids, 'bots[0].connections'), ids);
  assert.throws(() => connectionIds([...fifty, 'lib:c50'], 'bots[0].connections'), /more than 50/);
  assert.throws(() => connectionIds([BROWSER_CONNECTOR, ...fifty, 'lib:c50'], 'bots[0].connections'), /more than 51 entries/);
});

test('no Chromium: the real lookup says why, and a Boton given the browser has none in its capabilities or turns', async () => {
  const a = await findBrowser(join(home, 'no-chromium'));
  assert.equal(a.available, false);
  assert.match(a.why ?? '', /BOTONS_BROWSER_PATH is .*no-chromium, which is not there/);
  assert.equal(browserUsable(true, a), false);
  assert.equal(browserUsable(true, null), true, 'before the server has looked');
  assert.equal(browserUsable(false, { available: true }), false);
  assert.equal(browserUsable(true, { available: true }), true);

  connectors.browser = { server: () => assert.fail('no server without Chromium'), unavailable: () => a.why };
  const cli = await connectors.resolve([BROWSER_CONNECTOR], { cli: { command: 'claude' } } as never);
  assert.deepEqual(cli.servers, []);
  assert.deepEqual(cli.skipped, [{ id: BROWSER_CONNECTOR, reason: a.why }]);
  // An API key brain is never handed the browser, Chromium or not.
  connectors.browser = { server: () => assert.fail('not for an API brain'), unavailable: () => null };
  const api = await connectors.resolve([BROWSER_CONNECTOR], { serverTools: true } as never);
  assert.deepEqual(api.servers, []);
  // Kept for a move back to a CLI brain, not a connector its turns went without (no notice, nothing in its context).
  assert.deepEqual(api.skipped, []);
});
