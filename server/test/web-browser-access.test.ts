import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserStatus } from '../../shared/types.ts';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import { applyPolicy, effectiveSites, NEW_BOTON_SITES, NO_BROWSER, siteFor, withBrowser } from '../../server/src/browser-policy.ts';
import { answerWebAccess, suggestsWebAccess, unavailableLine, WEB_ACCESS_QUESTION, webAccessAnswered, withAnySite } from '../../web/src/browser-access.ts';

const status = (o: Partial<BrowserStatus>) => ({ available: true, enabled: false, policy: { sites: [], updatedAt: null }, handover: null, ...o }) as BrowserStatus;

test('a new Boton gets the browser for any public site, at either access, and nothing private comes with it', () => {
  assert.deepEqual(NEW_BOTON_SITES, ['*']);
  assert.deepEqual(withBrowser([]), [BROWSER_CONNECTOR]);
  assert.deepEqual(withBrowser(['lib:notes']), [BROWSER_CONNECTOR, 'lib:notes']);
  assert.deepEqual(withBrowser([BROWSER_CONNECTOR, 'lib:notes']), [BROWSER_CONNECTOR, 'lib:notes']);
  for (const access of ['workspace', 'host'] as const) {
    assert.deepEqual(applyPolicy(NO_BROWSER, { sites: NEW_BOTON_SITES }, access, []).sites, ['*'], access);
    assert.deepEqual(effectiveSites(['*'], access, []), ['*'], access);
    // "*" is public only: loopback and private addresses need their own host:port entry.
    for (const [host, port] of [['127.0.0.1', 8080], ['localhost', 80], ['10.0.0.2', 443], ['::1', 9000], ['192.168.1.4', 80]] as const) {
      assert.equal(siteFor(['*'], host, port), null, `${host}:${port}`);
    }
    assert.ok(siteFor(['*'], 'example.com', 443));
  }
  // Workspace still can't name a private address the operator didn't allow, nor any private one without its port.
  assert.throws(() => applyPolicy(NO_BROWSER, { sites: ['*', '127.0.0.1:8080'] }, 'workspace', []), /Workspace Boton's browser can't reach/);
  assert.throws(() => applyPolicy(NO_BROWSER, { sites: ['*', 'localhost'] }, 'host', []), /with its port/);
  assert.deepEqual(effectiveSites(['*', '127.0.0.1:8080'], 'workspace', []), ['*']);
});

test('the web-access suggestion asks once, only where the browser could reach every public site, and says the exact words', () => {
  assert.equal(WEB_ACCESS_QUESTION, 'Turn on web access for all public sites?');
  assert.equal(suggestsWebAccess(status({}), true, false), true);
  assert.equal(suggestsWebAccess(status({ enabled: true, policy: { sites: ['example.com'], updatedAt: null } }), true, false), true);
  assert.equal(suggestsWebAccess(status({ enabled: false, policy: { sites: ['*'], updatedAt: null } }), true, false), true);
  assert.equal(suggestsWebAccess(status({ enabled: true, policy: { sites: ['*'], updatedAt: null } }), true, false), false);
  assert.equal(suggestsWebAccess(status({}), true, true), false, 'answered');
  assert.equal(suggestsWebAccess(status({}), false, false), false, "a brain that can't use connectors");
  assert.equal(suggestsWebAccess(status({ available: false, why: 'No Chromium' }), true, false), false, 'no Chromium');
  assert.equal(suggestsWebAccess(status({ handover: {} as BrowserStatus['handover'] }), true, false), false, 'in a handover');
  assert.deepEqual(withAnySite(['example.com']), ['*']);
  assert.deepEqual(withAnySite(['*']), ['*']);
  // A full list of 50 takes "*" too: "*" stands in for the public names it covers, every host:port the owner named stays.
  const named = ['127.0.0.1:8080', '[::1]:9000', '192.168.1.4:80', 'example.org:8443'];
  const full = [...Array.from({ length: 50 - named.length }, (_, i) => `site${i}.example.com`), ...named];
  const after = withAnySite(full)!;
  assert.deepEqual(after, [...named, '*']);
  assert.deepEqual(applyPolicy(NO_BROWSER, { sites: after }, 'host', []).sites, after, 'the server takes it');
  for (const raw of named) {
    const [host, port] = raw.startsWith('[') ? ['::1', 9000] : [raw.split(':')[0], Number(raw.split(':')[1])];
    assert.ok(siteFor(after, host, port), raw);
  }
  // Fifty host:port entries leave no room for "*": no suggestion, rather than one the server refuses.
  const ports = Array.from({ length: 50 }, (_, i) => `127.0.0.1:${8000 + i}`);
  assert.equal(withAnySite(ports), null);
  assert.equal(suggestsWebAccess(status({ policy: { sites: ports, updatedAt: null } }), true, false), false);
  assert.ok(withAnySite(ports.slice(1)));
  const kept = new Map<string, string>();
  const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  assert.equal(webAccessAnswered('bot_kevin', store), false);
  answerWebAccess('bot_kevin', store);
  assert.equal(webAccessAnswered('bot_kevin', store), true);
  assert.equal(webAccessAnswered('bot_stuart', store), false);
  assert.equal(webAccessAnswered('bot_kevin', null), false);
  assert.doesNotThrow(() => answerWebAccess('bot_kevin', { setItem: () => { throw new Error('full'); } }));
});

test('no Chromium: the browser reads as off on one line, whatever the Boton was given', () => {
  assert.equal(unavailableLine('No Chromium found on this computer:\n install one.'), 'Off: No Chromium found on this computer: install one.');
  assert.equal(unavailableLine(null), 'Off: this server has no managed browser');
  assert.doesNotMatch(unavailableLine('a\nb'), /\n/);
});
