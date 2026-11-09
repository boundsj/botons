import assert from 'node:assert/strict';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { heldLookups } from '../src/held-dir.ts';
const fileTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !heldLookups && 'safe workspace file reads require Linux folder handles' }, fn);
import type { AuthStatus, Bot, FilePreviewLink } from '../../shared/types.ts';
import { PREVIEW_KEY_TTL_MS } from '../src/auth.ts';
import { PREVIEW_MAX_BYTES } from '../../shared/files.ts';
import { PREVIEW_CSP, PREVIEW_ERROR_CSP } from '../src/files.ts';
import { failOnEscapedErrors, pairDevice, startServer } from './helpers.ts';

// An HTML file a Boton wrote runs its script in the viewer, so its page must never be a document of
// the app: these check the headers that make it one in an opaque origin, and the key that opens it.
// scripts/check-preview.ts checks the same in a real browser.

const s = await startServer();
const { app, base, token: device, call, newBot } = s;
failOnEscapedErrors();

function put(bot: Bot, rel: string, content: string) {
  const p = join(bot.workspace, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>Directions</title><svg id="art"></svg><script>document.getElementById("art").innerHTML = "<circle r=10 />"</script>';

const mint = (bot: Bot, path: string, as: string | null = device) => call<FilePreviewLink>('POST', `/api/bots/${bot.id}/files/preview`, { path }, as);
const get = (url: string, headers: Record<string, string> = {}) => fetch(base + url, { headers });
const withParam = (url: string, name: string, value: string) => {
  const u = new URL(url, base);
  u.searchParams.set(name, value);
  return u.pathname + u.search;
};

fileTest("an HTML file's preview page runs in a sandbox with an opaque origin, no network and no forms", async () => {
  const bot = await newBot('Kevin');
  put(bot, 'design/avatar directions.html', PAGE);
  const { status, data: link } = await mint(bot, 'design/avatar directions.html');
  assert.equal(status, 200, JSON.stringify(link));
  assert.match(link.url, new RegExp(`^/api/bots/${bot.id}/files/preview\\?path=design%2Favatar%20directions\\.html&key=`));
  assert.ok(link.expiresAt && Date.parse(link.expiresAt) > Date.now());
  assert.ok(!link.url.includes((await call<AuthStatus>('GET', '/api/auth/status')).data.urlKeys!.files), 'never the device files key');

  const res = await get(link.url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), PAGE);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(res.headers.get('content-disposition') ?? '', /^inline; /);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('etag'), null);
  assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(\).*microphone=\(\).*geolocation=\(\)/);

  const csp = res.headers.get('content-security-policy') ?? '';
  assert.equal(csp, PREVIEW_CSP);
  const directives = new Map(csp.split(/;\s*/).map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
  // Scripts run, in an opaque origin: never allow-same-origin (it could read the device token), nor anything that leaves the frame.
  assert.deepEqual(directives.get('sandbox'), ['allow-scripts']);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/);
  assert.deepEqual(directives.get('connect-src'), ["'none'"]);
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'self'"]);
  assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  // Nothing from the network or this server: inline and data: only, so no request can carry the page or its key anywhere.
  for (const [name, sources] of directives) {
    if (name === 'sandbox') continue;
    for (const src of sources) assert.match(src, /^('none'|'self'|'unsafe-inline'|'unsafe-eval'|data:|blob:)$/, `${name} ${src}`);
    if (name !== 'frame-ancestors') assert.ok(!sources.includes("'self'"), `${name} must not allow this server`);
  }
});

fileTest("a preview key opens only its own Boton's file at its own path, only until it expires, and only while its device is paired", async () => {
  const bot = await newBot('Stuart');
  const other = await newBot('Bob');
  put(bot, 'a.html', PAGE);
  put(bot, 'b.html', '<p>b</p>');
  put(bot, 'secret.txt', 'TOP SECRET');
  put(other, 'a.html', '<p>other</p>');
  const { data: link } = await mint(bot, 'a.html');
  const key = new URL(link.url, base).searchParams.get('key')!;
  const refused = async (url: string, why: string) => {
    const res = await get(url);
    assert.equal(res.status, 401, why);
    assert.doesNotMatch(await res.text(), /TOP SECRET|<p>(b|other)<\/p>|Directions/, why);
  };

  await refused(withParam(link.url, 'path', 'b.html'), 'another file');
  await refused(withParam(link.url, 'path', './a.html'), 'the same file by another path');
  await refused(link.url.replace(bot.id, other.id), "another Boton's file at that path");
  await refused(`/api/bots/${bot.id}/files/raw?path=secret.txt&key=${encodeURIComponent(key)}`, 'the raw endpoint');
  await refused(`/api/bots/${bot.id}/files/preview?path=a.html`, 'no key');
  await refused(withParam(link.url, 'key', 'garbage'), 'a bogus key');
  // A different expiry under the same MAC.
  const [dev, , mac] = key.split('.');
  await refused(withParam(link.url, 'key', `${dev}.${(Date.now() + 10 * 60_000).toString(36)}.${mac}`), 'a changed expiry');
  // The device's files key is for <img> and links, not preview pages.
  const filesKey = (await call<AuthStatus>('GET', '/api/auth/status')).data.urlKeys!.files;
  await refused(withParam(link.url, 'key', filesKey), "the device's files key");
  // Nobody without a key learns which Botons exist.
  await refused('/api/bots/bot_doesnotexist/files/preview?path=a.html', 'an unknown Boton');

  const deviceId = (await call<AuthStatus>('GET', '/api/auth/status')).data.deviceId!;
  const old = app.auth.previewKey(deviceId, bot.id, 'a.html', Date.now() - PREVIEW_KEY_TTL_MS - 1000)!;
  await refused(withParam(link.url, 'key', old.key), 'an expired key');
  const future = app.auth.previewKey(deviceId, bot.id, 'a.html', Date.now() + PREVIEW_KEY_TTL_MS)!;
  await refused(withParam(link.url, 'key', future.key), 'a key that lasts longer than a key may');
  assert.equal((await get(link.url)).status, 200, 'the real key still works');

  // Revoking the device ends its preview keys.
  const second = await pairDevice(app, base, 'Phone');
  const { data: phoneLink } = await mint(bot, 'a.html', second);
  assert.equal((await get(phoneLink.url)).status, 200);
  const phoneId = (await call<AuthStatus>('GET', '/api/auth/status', undefined, second)).data.deviceId!;
  assert.equal((await call('DELETE', `/api/devices/${phoneId}`)).status, 200);
  await refused(phoneLink.url, 'a revoked device');
});

fileTest('only a paired device gets a preview link, and only for an HTML file inside the workspace', async () => {
  const bot = await newBot('Dave');
  put(bot, 'page.htm', PAGE);
  put(bot, 'notes.txt', 'notes');
  put(bot, 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put(bot, 'folder.html/inside.txt', 'x');

  assert.equal((await mint(bot, 'page.htm', null)).status, 401);
  const { token, revoke } = app.auth.mintBotonToken(bot.id);
  try {
    assert.equal((await mint(bot, 'page.htm', token)).status, 403, 'a Boton cannot open previews for itself');
  } finally {
    revoke();
  }
  assert.equal((await mint(bot, 'page.htm')).status, 200);
  assert.equal((await mint(bot, 'notes.txt')).status, 400);
  assert.equal((await mint(bot, 'logo.svg')).status, 400);
  assert.equal((await mint(bot, 'folder.html')).status, 400);
  assert.equal((await mint(bot, '../page.htm')).status, 403);
  assert.equal((await mint(bot, 'missing.html')).status, 404);

  // A key that was signed for a file which is no longer HTML (swapped meanwhile) still never serves it as a page.
  const deviceId = (await call<AuthStatus>('GET', '/api/auth/status')).data.deviceId!;
  const signed = app.auth.previewKey(deviceId, bot.id, 'notes.txt')!;
  const res = await get(`/api/bots/${bot.id}/files/preview?path=notes.txt&key=${encodeURIComponent(signed.key)}`);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('content-security-policy'), PREVIEW_ERROR_CSP, 'only the error page, never the file');
  assert.doesNotMatch(await res.text(), /notes/);
});

/** The page the preview frame gets when it can't have the file: why, its status for the viewer, and nothing else. */
async function errorPage(res: Response, status: number, why: string) {
  assert.equal(res.status, status, why);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', why);
  assert.equal(res.headers.get('cache-control'), 'private, no-store', why);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', why);
  assert.equal(res.headers.get('content-security-policy'), PREVIEW_ERROR_CSP, why);
  const body = await res.text();
  assert.match(body, new RegExp(`<html lang="en" data-status="${status}">`), why);
  assert.match(body, /parent\.postMessage\(\{ botonsPreview: 'failed', status: /, why);
  return body;
}

test('the preview error page runs only its own script, in a sandbox, and holds no key', async () => {
  const directives = new Map(PREVIEW_ERROR_CSP.split(/;\s*/).map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
  assert.deepEqual(directives.get('sandbox'), ['allow-scripts']);
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.match(directives.get('script-src')!.join(' '), /^'sha256-[A-Za-z0-9+/]+=*'$/, 'its one script by hash, no inline script of the file');
  assert.deepEqual(directives.get('frame-ancestors'), ["'self'"]);
  assert.doesNotMatch(PREVIEW_ERROR_CSP, /unsafe|allow-same-origin|connect-src (?!'none')/);

  const bot = await newBot('Kevin');
  const body = await errorPage(await get(`/api/bots/${bot.id}/files/preview?path=a.html&key=garbage`), 401, 'a bad key');
  assert.doesNotMatch(body, /garbage/);
  const filesKey = (await call<AuthStatus>('GET', '/api/auth/status')).data.urlKeys!.files;
  assert.ok(!body.includes(filesKey) && !body.includes(device), 'never a device key or token');
});

fileTest('the link is refused for a file over the limit by its size now, whatever the listing said', async () => {
  const bot = await newBot('Bob');
  put(bot, 'big.html', '<p>small at first</p>');
  const listed = await call<{ entries: { name: string; size: number }[] }>('GET', `/api/bots/${bot.id}/files`);
  assert.ok(listed.data.entries.find((e) => e.name === 'big.html')!.size < 100, 'the listing says small');
  // It grows past the limit after the listing (or is opened from a chip, with no listing size at all).
  truncateSync(join(bot.workspace, 'big.html'), PREVIEW_MAX_BYTES + 1);
  const res = await mint(bot, 'big.html');
  assert.equal(res.status, 413, JSON.stringify(res.data));
  assert.match((res.data as unknown as { error: string }).error, /Too big to preview \(over 25 MB\)/);

  // At the limit, it gets a link, with its size.
  truncateSync(join(bot.workspace, 'big.html'), PREVIEW_MAX_BYTES);
  const ok = await mint(bot, 'big.html');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.size, PREVIEW_MAX_BYTES);
});

fileTest("a file deleted, grown or swapped after its link was made gets the error page, not the file or the server's JSON", async () => {
  const bot = await newBot('Dave');
  put(bot, 'gone.html', PAGE);
  put(bot, 'grows.html', PAGE);
  const gone = (await mint(bot, 'gone.html')).data;
  const grows = (await mint(bot, 'grows.html')).data;
  assert.equal(gone.size, PAGE.length);

  rmSync(join(bot.workspace, 'gone.html'));
  await errorPage(await get(gone.url), 404, 'deleted after the link was made');

  truncateSync(join(bot.workspace, 'grows.html'), PREVIEW_MAX_BYTES + 1);
  const body = await errorPage(await get(grows.url), 413, 'grown past the limit after the link was made');
  assert.match(body, /Too big to preview/);
  assert.doesNotMatch(body, /Directions/);

  // Put back, the same link serves it again.
  writeFileSync(join(bot.workspace, 'gone.html'), PAGE);
  const back = await get(gone.url);
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-security-policy'), PREVIEW_CSP);
  await back.text();
});

fileTest('the raw endpoint never serves HTML as a page; SVG shows inline with no script', async () => {
  const bot = await newBot('Kevin');
  put(bot, 'page.html', PAGE);
  put(bot, 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const raw = (path: string) => fetch(`${base}/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${device}` } });

  const html = await raw('page.html');
  assert.equal(html.headers.get('content-type'), 'application/octet-stream');
  assert.match(html.headers.get('content-disposition') ?? '', /^attachment;/);
  await html.text();

  const svg = await raw('logo.svg');
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-disposition') ?? '', /^inline;/);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  const csp = svg.headers.get('content-security-policy') ?? '';
  assert.match(csp, /(^|; )sandbox($|;)/, 'a bare sandbox: no script at all');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /allow-/);
  await svg.text();
});

fileTest('with BOTONS_AUTH=off the preview link needs no key, and still gets the sandbox', async () => {
  const off = await startServer({ env: { BOTONS_AUTH: 'off' }, token: null });
  const bot = await off.newBot('Stuart');
  put(bot, 'a.html', PAGE);
  const { status, data: link } = await off.call<FilePreviewLink>('POST', `/api/bots/${bot.id}/files/preview`, { path: 'a.html' }, null);
  assert.equal(status, 200);
  assert.equal(link.expiresAt, null);
  assert.doesNotMatch(link.url, /key=/);
  const res = await fetch(off.base + link.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), PREVIEW_CSP);
  await res.text();
  await off.stop();
});
