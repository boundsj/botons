import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { devEnv, webAllowedHosts } from '../../scripts/dev-env.ts';
import { loadConfig } from '../src/config.ts';
import { freePort, sleep, tempDir } from './helpers.ts';

const webDir = resolve(import.meta.dirname, '../../web');
const hooks = (env: Record<string, string | undefined>) => [env.BOTONS_HOOKS_PORT, env.BOTONS_HOOKS_HOST, env.BOTONS_HOOKS_PUBLIC_URL];

test('npm run dev gets its own data dir, port, loopback address and no hooks listener, each overridable', () => {
  const repo = tempDir('botons-dev-test-');
  const live = { BOTONS_HOOKS_PORT: '7780', BOTONS_HOOKS_HOST: '0.0.0.0', BOTONS_HOOKS_PUBLIC_URL: 'https://myhost.example-tailnet.ts.net' };
  const dev = devEnv({ PATH: '/usr/bin', HOME: '/home/someone', ...live }, repo);
  assert.deepEqual([dev.PATH, dev.BOTONS_HOME, dev.BOTONS_PORT, dev.BOTONS_HOST], ['/usr/bin', join(repo, '.botons-dev'), '7778', '127.0.0.1']);
  assert.deepEqual([dev.BOTONS_NO_TAILSCALE, dev.BOTONS_ENABLE_MOCK, dev.BOTONS_API], ['1', '1', 'http://127.0.0.1:7778']);
  assert.equal(dev.BOTONS_DRAIN_MS, '5s', 'node --watch waits for the old server to exit, so a long drain would stall every restart');
  assert.deepEqual(hooks(dev), [undefined, undefined, undefined]);

  const cfg = loadConfig(dev);
  assert.deepEqual([cfg.home, cfg.port, cfg.hosts, cfg.urls], [join(repo, '.botons-dev'), 7778, ['127.0.0.1'], ['http://127.0.0.1:7778']]);
  assert.deepEqual([cfg.enableMock, cfg.drainMs, cfg.hooks.port], [true, 5000, null]);

  const env = devEnv({ BOTONS_HOME: 'some/dir', BOTONS_PORT: '18123', BOTONS_HOST: '0.0.0.0', BOTONS_NO_TAILSCALE: '', BOTONS_ENABLE_MOCK: '0', BOTONS_DRAIN_MS: '2m' }, '/repo');
  assert.deepEqual(
    [env.BOTONS_HOME, env.BOTONS_PORT, env.BOTONS_HOST, env.BOTONS_NO_TAILSCALE, env.BOTONS_ENABLE_MOCK, env.BOTONS_DRAIN_MS, env.BOTONS_API],
    [resolve('some/dir'), '18123', '0.0.0.0', '', '0', '2m', 'http://127.0.0.1:18123'],
  );
  assert.equal(devEnv({ BOTONS_HOST: '::1' }, '/repo').BOTONS_API, 'http://[::1]:7778');
  assert.equal(devEnv({ BOTONS_API: 'http://127.0.0.1:18999' }, '/repo').BOTONS_API, 'http://127.0.0.1:18999');

  // BOTONS_PORT wins over PORT, and the server gets BOTONS_PORT alone so Vite and the server agree.
  const port = devEnv({ PORT: '18200', BOTONS_PORT: '18300' }, '/repo');
  assert.deepEqual([port.BOTONS_PORT, port.PORT, port.BOTONS_API], ['18300', undefined, 'http://127.0.0.1:18300']);
  assert.equal(devEnv({ PORT: '18200' }, '/repo').BOTONS_PORT, '18200');

  const opted = devEnv({ ...live, BOTONS_DEV_HOOKS_PORT: '17781', BOTONS_DEV_HOOKS_PUBLIC_URL: 'https://dev.example' }, '/repo');
  assert.deepEqual(hooks(opted), ['17781', undefined, 'https://dev.example']);
  assert.equal(opted.BOTONS_DEV_HOOKS_PORT, undefined);
});

function statusFor(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('the Vite dev server answers the BOTONS_ALLOWED_HOSTS names (say, MagicDNS) and still blocks other names', async () => {
  assert.equal(webAllowedHosts({}), undefined);
  assert.equal(webAllowedHosts({ BOTONS_ALLOWED_HOSTS: ' , ' }), undefined);
  assert.deepEqual(webAllowedHosts({ BOTONS_ALLOWED_HOSTS: ' MyHost.example-tailnet.ts.net, ,other.example ' }), ['myhost.example-tailnet.ts.net', 'other.example']);

  const port = await freePort();
  const viteBin = join(dirname(createRequire(join(webDir, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');
  const vite = spawn(process.execPath, [viteBin, '--strictPort'], {
    cwd: webDir,
    env: { ...process.env, BOTONS_WEB_HOST: '127.0.0.1', BOTONS_WEB_PORT: String(port), BOTONS_ALLOWED_HOSTS: 'myhost.example-tailnet.ts.net', BOTONS_API: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  vite.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exited = new Promise<void>((resolve) => vite.on('exit', () => resolve()));
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await statusFor(port, 'localhost');
        break;
      } catch (err) {
        if (Date.now() > deadline || vite.exitCode !== null) throw new Error(`Vite did not start: ${stderr || (err as Error).message}`);
        await sleep(100);
      }
    }
    assert.equal(await statusFor(port, `myhost.example-tailnet.ts.net:${port}`), 200);
    assert.equal(await statusFor(port, `evil.example:${port}`), 403);
  } finally {
    vite.kill('SIGTERM');
    await exited;
  }
});

