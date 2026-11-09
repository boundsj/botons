// The owner's app is never shown inside another page: every response of it says so to the browser (CSP
// frame-ancestors 'none', and X-Frame-Options for browsers without it), so no site can lay it under its own and
// steer the owner's clicks onto an approval. A generated file's preview keeps its own policy (files.ts), apart.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { PREVIEW_CSP } from '../src/files.ts';
import { serveStatic } from '../src/http.ts';
import { tempDir } from './helpers.ts';

async function headersOf(root: string, paths: string[]) {
  const server = createServer((req, res) => serveStatic(root, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname), res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    return await Promise.all(
      paths.map(
        (p) =>
          new Promise<{ path: string; status: number; csp: unknown; xfo: unknown }>((resolve, reject) =>
            get({ host: '127.0.0.1', port, path: p }, (res) => {
              res.resume();
              resolve({ path: p, status: res.statusCode ?? 0, csp: res.headers['content-security-policy'], xfo: res.headers['x-frame-options'] });
            }).on('error', reject),
          ),
      ),
    );
  } finally {
    server.close();
  }
}

test("the owner's app refuses to be framed: its page, the app's fallback, its assets, and the not-built page", async () => {
  const root = tempDir();
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Botons</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'void 0');
  const got = await headersOf(root, ['/', '/index.html', '/bots/kevin/approvals', '/assets/app.js']);
  for (const r of got) assert.deepEqual(r, { path: r.path, status: 200, csp: "frame-ancestors 'none'", xfo: 'DENY' });
  const [missing] = await headersOf(tempDir(), ['/']);
  assert.deepEqual(missing, { path: '/', status: 503, csp: "frame-ancestors 'none'", xfo: 'DENY' });
});

test("a generated file's preview keeps its own framing policy: shown only inside the owner's app", () => {
  assert.match(PREVIEW_CSP, /frame-ancestors 'self'/);
  assert.doesNotMatch(PREVIEW_CSP, /frame-ancestors 'none'/);
});
