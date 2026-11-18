import assert from 'node:assert/strict';
import { test } from 'node:test';
import {staleCookies, type JarCookie} from '../src/browser-request.ts';

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
