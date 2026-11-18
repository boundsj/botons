import { createServer } from 'node:http';
import { BROWSER_CONNECTOR } from '../../shared/util.ts';
import type { BrowserActionResult } from '../../shared/types.ts';
import { startServer, freePort, until } from './helpers.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typingProblem } from '../src/browser-request.ts';

test('typing is refused into passwords, codes, card numbers and other secrets, judged from what the page says', () => {
  const field = (f: Partial<Parameters<typeof typingProblem>[0]>) => typingProblem({ tag: 'input', type: 'text', name: '', id: '', autocomplete: '', label: '', ...f });
  assert.equal(field({ name: 'q', label: 'Search' }), null);
  assert.equal(field({ tag: 'textarea', name: 'note' }), null);
  assert.equal(field({ name: 'footprint' }), null);
  for (const f of [
    { type: 'password' },
    { autocomplete: 'one-time-code' },
    { autocomplete: 'cc-number' },
    { autocomplete: 'section-pay cc-csc' },
    { autocomplete: 'current-password' },
    { name: 'passwd' },
    { name: 'otp' },
    { label: 'Verification code' },
    { id: 'card-number' },
    { name: 'cvv' },
    { label: 'Your PIN' },
    { name: 'api_key' },
    { type: 'file' },
    { type: 'hidden' },
    { tag: 'select' },
  ]) {
    assert.ok(field(f), JSON.stringify(f));
  }
});

test('agent UI actions allow normal page requests without network cards and retain field and ref safeguards', async () => {
  const hits: string[] = [];
  const site = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url !== '/') { res.end('ok'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<input aria-label="Search"><input type="password" aria-label="Password"><button>Search now</button><script>
      document.querySelector('input').oninput=()=>fetch('/suggest',{method:'POST',body:'fixture-query'});
      document.querySelector('button').onclick=()=>{fetch('/search',{method:'POST',body:'fixture-query'});fetch('/counts')};
      fetch('/initial',{method:'POST',body:'fixture-loading'});
    </script>`);
  });
  const port = await freePort();
  await new Promise<void>(r => site.listen(port, '127.0.0.1', r));
  const s = await startServer();
  try {
    const bot = await s.newBot('Kevin', { provider: 'claude-cli', access: 'host', connections: [BROWSER_CONNECTOR] });
    await s.call('PUT', `/api/bots/${bot.id}/browser`, { sites: [`127.0.0.1:${port}`] });
    const token = s.app.auth.mintBotonToken(bot.id);
    s.app.browser.beginTurn(bot.id, token.id);
    const act = async (body: Record<string, unknown>) => (await s.call<BrowserActionResult>('POST', `/api/bots/${bot.id}/browser/actions`, body, token.token)).data;
    await act({ action: 'open', url: `http://127.0.0.1:${port}/` });
    await until(() => hits.includes('POST /initial'));
    const read = await act({ action: 'read' });
    const controls = read.content!.controls;
    assert.equal((await act({ action: 'type', ref: controls.find(c => c.label === 'Password')!.ref, text: 'dummy-not-entered' })).outcome, 'refused');
    assert.equal((await act({ action: 'type', ref: controls.find(c => c.label === 'Search')!.ref, text: 'fixture-query' })).outcome, 'done');
    await until(() => hits.includes('POST /suggest'));
    assert.equal((await act({ action: 'click', ref: controls.find(c => c.label === 'Search now')!.ref })).outcome, 'done');
    await until(() => hits.includes('POST /search') && hits.includes('GET /counts'));
    assert.equal(s.app.store.db.prepare("select count(*) as n from approvals where tool_key like 'browser-op:%'").get()!.n, 0);
    await act({ action: 'open', url: `http://127.0.0.1:${port}/` });
    assert.equal((await act({ action: 'click', ref: controls.find(c => c.label === 'Search now')!.ref })).outcome, 'refused');
    await s.app.browser.endTurn(bot.id, token.id);
    token.revoke();
  } finally {
    await s.stop();
    site.closeAllConnections();
    await new Promise<void>(r => site.close(() => r()));
  }
});
