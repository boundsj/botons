import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { guardRequest } from '../src/http.ts';
import { freePort, startServer } from './helpers.ts';

const origins = new Set(['https://app.example.com', 'https://oauth.example.com']);
const url = new URL('http://local/api/auth/pair');
const guard = (origin: string, extra: Record<string, string> = {}, method = 'POST') => guardRequest({ method, headers: { host: '127.0.0.1:17777', origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra } } as IncomingMessage, url, new Set(), origins);

test('configured public origins survive a rewritten Host without weakening mutation checks', () => {
  for (const origin of ['https://app.example.com', 'HTTPS://APP.EXAMPLE.COM', 'https://oauth.example.com']) assert.equal(guard(origin), null);
  for (const origin of ['https://foreign.example.com', 'http://app.example.com', 'https://app.example.com:444', 'https://app.example.com/path']) assert.match(guard(origin)!, /Cross-origin/);
  assert.match(guard('null')!, /opaque origin/);
  assert.match(guard('https://app.example.com', { 'sec-fetch-site': 'cross-site' })!, /Cross-site/);
  assert.match(guard('https://app.example.com', { 'content-type': 'text/plain' })!, /Content-Type/);
  assert.match(guard('https://foreign.example.com', { 'x-forwarded-host': 'foreign.example.com' })!, /Cross-origin/);
  assert.match(guard('https://app.example.com', { host: 'foreign.example.com' })!, /not allowed/);
  assert.equal(guard('http://127.0.0.1:17777'), null);
});

test('fresh app renders pairing through a Host-rewriting proxy in Chromium', async (t) => {
  const webDist = resolve('web/dist');
  if (!existsSync(resolve(webDist, 'index.html'))) {
    t.skip('Built web app absent; run npm run build to exercise pairing in Chromium');
    return;
  }
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const server = await startServer({ token: null, env: { BOTONS_PUBLIC_URL: publicUrl }, configure: (cfg) => { cfg.webDist = webDist; } });
  const seen: { origin?: string; status: number }[] = [];
  const proxy = createServer((req, res) => {
    const upstream = request(`${server.base}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(server.base).host } }, (reply) => {
      seen.push({ origin: req.headers.origin, status: reply.statusCode! });
      res.writeHead(reply.statusCode!, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(publicUrl);
    await page.locator('.big-code').waitFor();
    assert.match(await page.locator('.big-code').innerText(), /[A-Z0-9]/);
    assert.match(await page.locator('body').innerText(), /Botons/);
    // Force the Origin-bearing asset request that triggered the blank page.
    const asset = await page.locator('script[type="module"]').getAttribute('src');
    assert.ok(asset);
    const response = await fetch(`${publicUrl}${asset}`, { headers: { origin: publicUrl } });
    assert.equal(response.status, 200);
    assert.ok(seen.some((r) => r.origin === publicUrl && r.status === 200));
  } finally {
    await browser.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
