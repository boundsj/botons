// The rule a held browser request's card is matched by: a site's own cookie churn and client hints are not a
// different request, a different method, address, body or other header is, and a cookie the browser never held means
// no card. Pure functions: no browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeRequest, type HeldRequest, heldCookies, type JarCookie, sameRequest, staleCookies } from '../src/browser-request.ts';

const url = 'https://x.example.com/i/api/onboarding/task.json?flow=login';
const c = (name: string, value: string, extra: Partial<JarCookie> = {}): JarCookie => ({ name, value, domain: '.example.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax', ...extra });
const ok = (v: ReturnType<typeof heldCookies>) => {
  assert.ok('changed' in v, JSON.stringify(v));
  return v.changed;
};
const no = (v: ReturnType<typeof heldCookies>) => assert.match('why' in v ? v.why : 'carried', /a cookie the browser does not hold/);

test("cookie churn on the site's own cookies while the step runs is fine, and is named; a cookie the browser never held is not", () => {
  const start = [c('guest', 'g1'), c('ct0', 'OLD'), c('other', '1', { domain: 'elsewhere.example.org' })];
  // Unchanged, in any order, or none at all.
  assert.deepEqual(ok(heldCookies('guest=g1; ct0=OLD', url, start, start)), []);
  assert.deepEqual(ok(heldCookies('ct0=OLD; guest=g1', url, start, start)), []);
  assert.deepEqual(ok(heldCookies(undefined, url, start, start)), []);
  // The site's script refreshed ct0 and set att as it acted: the request carries the new values, which it named.
  const now = [c('guest', 'g1'), c('ct0', 'NEW'), c('att', 'a1')];
  assert.deepEqual(ok(heldCookies('guest=g1; ct0=NEW; att=a1', url, start, now)), ['att', 'ct0']);
  // Written before the change (the old value) is fine too: the browser held it as the step began.
  assert.deepEqual(ok(heldCookies('guest=g1; ct0=OLD', url, start, now)), []);
  // Fewer than the jar holds (SameSite, a partition, credentials omitted): fine.
  assert.deepEqual(ok(heldCookies('guest=g1', url, start, now)), []);
  // A value the browser never held, a cookie of another site, one counted twice, an unreadable start: no card.
  no(heldCookies('ct0=FORGED', url, start, now));
  no(heldCookies('other=1', url, start, now));
  no(heldCookies('guest=g1; guest=g1', url, start, now));
  no(heldCookies('secure=1', 'http://x.example.com/', [c('secure', '1')], [c('secure', '1')]));
  assert.match((heldCookies('ct0=OLD', url, null, now) as { why: string }).why, /could not be read/);
  // Checked again as it goes, against the jar as the step began and as the card was made: the site changing ct0 once
  // more while the owner reads the card doesn't take back the value the request was held with.
  const later = [c('guest', 'g1'), c('ct0', 'NEXT'), c('att', 'a1')];
  assert.ok('changed' in heldCookies('guest=g1; ct0=NEW; att=a1', url, [...start, ...now], later));
  no(heldCookies('guest=g1; ct0=NEW; att=a1', url, start, later));
});

const held = (extra: Partial<HeldRequest> = {}): HeldRequest => ({
  method: 'POST',
  url,
  headers: { 'content-type': 'application/json', cookie: 'guest=g1; ct0=OLD', 'sec-ch-ua': '"Chromium";v="1"', 'x-csrf-token': 'OLD' },
  body: Buffer.from('{"flow_token":"t1"}'),
  ...extra,
});

test('the request on a card matches with its cookies and client hints changed; a different method, address, body or other header is a different request', () => {
  const card = held();
  assert.equal(sameRequest(card, held({ headers: { ...card.headers, cookie: 'guest=g1; ct0=NEW; att=a1', 'sec-ch-ua': '"Chromium";v="2"', 'Sec-CH-UA-Platform': '"Linux"' } })), null);
  assert.match(sameRequest(card, held({ method: 'PUT' }))!, /method/);
  assert.match(sameRequest(card, held({ url: `${url}&x=1` }))!, /address/);
  assert.match(sameRequest(card, held({ body: Buffer.from('{"flow_token":"t2"}') }))!, /carries/);
  assert.match(sameRequest(card, held({ body: null }))!, /carries/);
  assert.match(sameRequest(card, held({ headers: { ...card.headers, 'x-csrf-token': 'NEW' } }))!, /headers/);
  assert.match(sameRequest(card, held({ headers: { ...card.headers, authorization: 'Bearer x' } }))!, /headers/);
});

test('the card names the cookies it goes with, never their values, and says which the site changed as it acted', () => {
  const d = describeRequest({ ...held(), changed: ['ct0'] }, null, 'k'.repeat(64));
  assert.ok(!('why' in d));
  assert.match(d.details, /It goes with the browser's own cookies for x\.example\.com \(values not shown\): guest, ct0\./);
  assert.match(d.details, /The site set or changed ct0 while the browser acted/);
  assert.ok(!d.details.includes('OLD'), d.details);
  assert.ok(!d.details.includes('g1'), d.details);
});

test("a handover's whole jar given back: the cookies it dropped go, each by its whole identity, its partition included", () => {
  const c = (value: string, o: Partial<JarCookie> = {}): JarCookie => ({ name: 'sid', value, domain: 'a.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None', ...o });
  const one = c('dummy-a', { partitionKey: 'https://one.example' });
  const two = c('dummy-b', { partitionKey: 'https://two.example' });
  const plain = c('dummy-c');
  // The site dropped partition two's sid: it goes, though partition one keeps a sid of that name, domain and path.
  assert.deepEqual(staleCookies([one, two, plain], [one, plain]), [two]);
  // Unpartitioned and partitioned are different cookies too, either way.
  assert.deepEqual(staleCookies([one, plain], [plain]), [one]);
  assert.deepEqual(staleCookies([one, plain], [one]), [plain]);
  // A value changed is the same cookie (kept as given back), and another path or domain is another one.
  assert.deepEqual(staleCookies([c('old'), c('x', { path: '/app' }), c('y', { domain: '.example.com' })], [c('new')]), [c('x', { path: '/app' }), c('y', { domain: '.example.com' })]);
  assert.deepEqual(staleCookies([one, two], [one, two]), []);
  // One partition's site, with and without a cross-site ancestor, is two partitions; unsaid is with one, as Playwright sets it.
  const crossed = c('dummy-x', { partitionKey: 'https://one.example', _crHasCrossSiteAncestor: true });
  const direct = c('dummy-y', { partitionKey: 'https://one.example', _crHasCrossSiteAncestor: false });
  assert.deepEqual(staleCookies([crossed, direct], [crossed]), [direct]);
  assert.deepEqual(staleCookies([crossed, direct], [direct]), [crossed]);
  assert.deepEqual(staleCookies([crossed, direct], [one]), [direct]);
  assert.deepEqual(staleCookies([direct, plain], [plain, { ...direct, _crHasCrossSiteAncestor: undefined }]), [direct]);
});
