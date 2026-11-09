import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrainLogin } from '../src/brain-login.ts';
import { until, startServer } from './helpers.ts';

test('device login exposes only verification data, rejects overlap and cancels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botons-login-'));
  const bin = join(dir, 'fake-codex');
  writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("secret-output-must-not-escape");console.log("https://evil.example.com/steal");console.log("https://auth.openai.com/codex/device");console.log("ABCD-EFGHJ");setInterval(()=>{},1000);');
  chmodSync(bin, 0o700);
  const login = new BrainLogin(bin);
  try {
    assert.equal(login.start().state, 'waiting');
    assert.throws(() => login.start(), /already running/);
    await until(() => login.view().code);
    assert.deepEqual(login.view(), { state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHJ' });
    assert.equal(login.cancel().state, 'cancelled');
    assert.equal(login.view().code, null);
    login.start();
    assert.equal(login.cancel().url, null);
  } finally { login.cancel(); rmSync(dir, {recursive:true, force:true}); }
});

test('missing login binary produces fixed fallback without command errors', async () => {
  const login = new BrainLogin('/no-such-botons-cli');
  login.start();
  await until(() => login.view().state === 'fallback');
  assert.deepEqual(login.view(), {state:'fallback', url:null, code:null});
});

test('login endpoints require a paired device and audit starts and cancels', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('POST', '/api/brain-login', undefined, null)).status, 401);
    assert.equal((await s.call('POST', '/api/brain-login')).status, 200);
    assert.equal((await s.call('DELETE', '/api/brain-login')).status, 200);
    const audit = (await s.call('GET', '/api/audit')).data;
    assert.ok(JSON.stringify(audit).includes('brain.signin_started'));
    assert.ok(JSON.stringify(audit).includes('brain.signin_cancelled'));
  } finally { await s.stop(); }
});

 test('a waiting flow expires and clears the verification code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botons-login-'));
  const bin = join(dir, 'fake-codex');
  writeFileSync(bin, '#!/usr/bin/env node\nsetInterval(()=>{},1000);');
  chmodSync(bin, 0o700);
  const login = new BrainLogin(bin, 30);
  try {
    login.start();
    await until(() => login.view().state === 'timed-out');
    assert.equal(login.view().code, null);
  } finally { login.cancel(); rmSync(dir, {recursive:true, force:true}); }
});

test('cancel ignores buffered output from the previous child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botons-login-'));
  const bin = join(dir, 'fake-codex');
  writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("https://auth.openai.com/codex/device\\nABCD-EFGHJ");setInterval(()=>{},1000);');
  chmodSync(bin, 0o700);
  const login = new BrainLogin(bin);
  try {
    for (let i = 0; i < 20; i++) {
      login.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      login.cancel();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(login.view(), {state:'cancelled', url:null, code:null});
    }
  } finally { login.cancel(); rmSync(dir, {recursive:true, force:true}); }
});

test('creating a Boton and its daily cap is atomic, including validation failure', async () => {
  const s = await startServer();
  try {
    const rejected = await s.call('POST', '/api/bots', {name:'Kevin', provider:'mock', dailyCapUsd:100001});
    assert.equal(rejected.status, 400);
    assert.equal((await s.call('GET', '/api/bots')).data.length, 0);
    const created = await s.call('POST', '/api/bots', {name:'Kevin', provider:'mock', dailyCapUsd:2});
    assert.equal(created.status, 201);
    assert.equal((await s.call('GET', `/api/bots/${created.data.id}/spending`)).data.dailyCapUsd, 2);
  } finally { await s.stop(); }
});

for (const outcome of ['cancelled', 'timed-out'] as const) {
  test(`${outcome} kills a launcher's credential-writing worker`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botons-login-'));
    const bin = join(dir, 'fake-launcher');
    const marker = join(dir, 'credential-write');
    const worker = join(dir, 'worker.cjs');
    const trigger = join(dir, 'write-now');
    let expire: (() => void) | undefined;
    writeFileSync(worker, `const fs = require('node:fs'); console.log('ABCD-EFGHJ'); setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(marker)}, 'credential'); }, 10);`);
    writeFileSync(bin, `#!/usr/bin/env node\nconst {spawn} = require('node:child_process'); spawn(process.execPath, [${JSON.stringify(worker)}], {stdio:'inherit'});`);
    chmodSync(bin, 0o700);
    const login = new BrainLogin(bin, 5000, (fn) => { expire = fn; return setTimeout(() => {}, 60_000); });
    try {
      login.start();
      await until(() => login.view().code);
      if (outcome === 'cancelled') login.cancel();
      else { assert.ok(expire); expire(); assert.equal(login.view().state, 'timed-out'); }
      writeFileSync(trigger, 'go');
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(existsSync(marker), false, 'the worker cannot finish its credential write');
      assert.deepEqual(login.view(), {state:outcome, url:null, code:null});
    } finally { login.cancel(); rmSync(dir, {recursive:true, force:true}); }
  });
}

test('existing sign-in import requires paired consent and records the copy', async () => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { cliHome } = await import('../src/cli-homes.ts');
  const { tempDir } = await import('./helpers.ts');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempDir('botons-personal-auth-');
  writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), '{"tokens":{"access_token":"test-only"}}');
  const s = await startServer();
  try {
    const view = await s.call('GET', '/api/brain-homes');
    assert.equal(view.data.codex, true);
    assert.equal((await s.call('POST', '/api/brain-homes/codex/import', {consent:true}, null)).status, 401);
    assert.equal((await s.call('POST', '/api/brain-homes/codex/import', {})).status, 400);
    assert.equal((await s.call('POST', '/api/brain-homes/codex/import', {consent:true})).status, 200);
    const audit = JSON.stringify((await s.call('GET', '/api/audit')).data);
    assert.ok(audit.includes('brain.signin_import_completed'));
    assert.ok(!audit.includes('test-only'));
    assert.equal((await s.call('GET', '/api/brain-homes')).data.codex, false);
  } finally { await s.stop(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
