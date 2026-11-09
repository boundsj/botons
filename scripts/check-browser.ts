// `npm run check:browser` (in Docker: `botons check-browser`): starts the managed browser the way a Boton's turn
// does (server/src/browser.ts, openGuarded) on a temp profile, against a page this script serves on loopback, and
// checks that it reads the page, takes a screenshot, and that nothing else gets out: a request to another loopback
// port, a POST and a WebSocket to the allowed one. Touches no install: no data folder, no server, no network beyond
// 127.0.0.1. Exit 0 when the browser works with every guard, 1 when it doesn't (and why).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, loadPlaywright, openGuarded } from '../server/src/browser.ts';
import { loadConfig } from '../server/src/config.ts';

function listen(handler: (method: string, url: string) => { status?: number; body: string }): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const out = handler(req.method ?? '', req.url ?? '');
    res.writeHead(out.status ?? 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(out.body);
  });
  server.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as AddressInfo).port, hits })));
}

async function main(): Promise<string[]> {
  const cfg = loadConfig(process.env, () => ({ ip: null, dnsName: null }), { create: false });
  const problems: string[] = [];
  const other = await listen(() => ({ body: 'other' }));
  const site = await listen((method, url) =>
    url.startsWith('/page')
      ? {
          body: `<!doctype html><title>Botons browser check</title><p id="t">botons-browser-ok</p><script>
            fetch('http://127.0.0.1:${other.port}/fetch').catch(() => {});
            fetch('/post', { method: 'POST', body: 'x' }).catch(() => {});
            try { new WebSocket('ws://127.0.0.1:' + location.port + '/ws'); } catch (e) {}
          </script>`,
        }
      : { status: method === 'GET' ? 404 : 405, body: '' },
  );
  const profile = mkdtempSync(join(tmpdir(), 'botons-check-browser-'));
  // Only what the server's own availability check finds (BOTONS_BROWSER_PATH, Playwright's, the system's).
  const found = await findBrowser(cfg.browser.path);
  try {
    if (!found.available || !found.executable) return [found.why ?? 'no browser'];
    const blocked: string[] = [];
    const { context, page } = await openGuarded((await loadPlaywright())!, join(profile, 'profile'), {
      executable: found.executable,
      sandbox: cfg.browser.sandbox,
      headless: true,
      policy: () => ({ enabled: true, sites: [`127.0.0.1:${site.port}`] }),
      note: (url, why) => blocked.push(`${url}: ${why}`),
    });
    try {
      await page.goto(`http://127.0.0.1:${site.port}/page`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(1500);
      const text = await page.locator('#t').innerText({ timeout: 10_000 });
      if (text !== 'botons-browser-ok') problems.push(`the page read as ${JSON.stringify(text)}`);
      const png = await page.screenshot({ type: 'png' });
      if (png.subarray(1, 4).toString() !== 'PNG') problems.push('the screenshot is not a PNG');
      const reached = site.hits.filter((h) => h !== 'GET /page' && !h.startsWith('GET /favicon'));
      if (reached.length) problems.push(`the allowed site got more than reads of the page: ${reached.join(', ')}`);
      if (other.hits.length) problems.push(`another loopback port was reached: ${other.hits.join(', ')}`);
      if (blocked.length < 3) problems.push(`expected the fetch, the POST and the WebSocket to be blocked; blocked: ${blocked.join('; ') || 'nothing'}`);
    } finally {
      await context.close();
    }
    return problems;
  } catch (err) {
    // Playwright's message ends with Chromium's own log, where the reason (a sandbox that can't start, say) is.
    const lines = (err as Error).message.split('\n').map((l) => l.trim()).filter(Boolean);
    const why = lines.filter((l) => /sandbox|namespace|fatal|error/i.test(l)).slice(0, 5);
    return [`the browser did not start or failed: ${lines[0]?.slice(0, 300)}`, ...why.map((l) => l.slice(0, 300))];
  } finally {
    other.server.close();
    site.server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const problems = await main();
const sandbox = loadConfig(process.env, () => ({ ip: null, dnsName: null }), { create: false }).browser.sandbox ? 'with its sandbox' : 'without its sandbox (BOTONS_BROWSER_SANDBOX=0)';
if (problems.length) {
  console.error(`The managed browser does not work here (${sandbox}):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`The managed browser works here (${sandbox}): it read a page and took a screenshot, and nothing else got out.`);
