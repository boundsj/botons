import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { UPLOAD_MAX_BYTES } from '../../shared/files.ts';
import type { Bot, FileListing, FileRef, Message, ShareResult } from '../../shared/types.ts';
import { disposition, safeName, servingOf } from '../src/files.ts';
import { transcriptBlock } from '../src/prompt.ts';
import { codexArgs } from '../src/providers/codex-cli.ts';
import { failOnEscapedErrors, sleep, startServer, tempDir, until } from './helpers.ts';

const s = await startServer();
const { app, base, token: device, call, newBot, messagesOf } = s;
failOnEscapedErrors();
/** Outside every workspace: nothing here may reveal it. */
const secretDir = tempDir('botons-files-secret-');
writeFileSync(join(secretDir, 'secret.txt'), 'TOP SECRET');

const raw = (bot: Bot, path: string, token: string | null = device, extra = '', init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) =>
  fetch(`${base}/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(path)}${extra}`, { ...init, headers: { ...(token && { authorization: `Bearer ${token}` }), ...init.headers } });
const list = (bot: Bot, path?: string, token?: string | null) => call<FileListing>('GET', `/api/bots/${bot.id}/files${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`, undefined, token);

const upload = (bot: Bot, name: string, body: Buffer | string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/bots/${bot.id}/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${device}`, 'content-type': 'application/octet-stream', ...headers },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });
const uploaded = async (bot: Bot, name: string, body: Buffer | string) => (await (await upload(bot, name, body)).json()) as FileRef;
const inboxOf = (bot: Bot) => (existsSync(join(bot.workspace, 'inbox')) ? readdirSync(join(bot.workspace, 'inbox')) : []);

/** A file in the workspace, modified `minutesAgo`. */
function put(bot: Bot, rel: string, content: string | Buffer, minutesAgo = 0) {
  const p = join(bot.workspace, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  const t = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(p, t, t);
}

/** Attachment protocol tests use an existing workspace file; upload confinement is tested separately. */
function attachment(bot: Bot, name: string, body: Buffer | string): FileRef {
  const path = `inbox/${name}`;
  put(bot, path, body);
  return { name, path, size: Buffer.byteLength(body), type: name.endsWith('.png') ? 'image/png' : 'text/plain' };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The `botons` CLI in `cwd`, with a turn's environment. */
const botonCli = (env: Record<string, string>, cwd: string, ...args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    execFile(
      join(import.meta.dirname, '../bin/botons'),
      args,
      { cwd, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', BOTONS_API: env.BOTONS_API, BOTON_BOT_ID: env.BOTON_BOT_ID, BOTON_TOKEN: env.BOTON_TOKEN } },
      (err, stdout, stderr) => done({ code: err ? (err.code as number | null) : 0, stdout, stderr }),
    ),
  );

test('the Files listing shows a folder newest first, and folders open by path', { skip: process.platform !== 'linux' && 'Requires Linux directory handles' }, async () => {
  const bot = await newBot('Lister');
  put(bot, 'old.txt', 'old', 60);
  put(bot, 'reports/weekly.md', '# Weekly', 30);
  put(bot, 'new.png', PNG, 1);
  utimesSync(join(bot.workspace, 'reports'), new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));

  const { status, data } = await list(bot);
  assert.equal(status, 200);
  assert.equal(data.path, '');
  assert.equal(data.truncated, false);
  assert.deepEqual(
    data.entries.map((e) => [e.name, e.isDir]),
    [
      ['new.png', false],
      ['reports', true],
      ['old.txt', false],
    ],
  );
  const png = data.entries[0];
  assert.equal(png.path, 'new.png');
  assert.equal(png.size, PNG.length);
  assert.ok(!Number.isNaN(Date.parse(png.mtime)));

  const sub = await list(bot, 'reports');
  assert.equal(sub.status, 200);
  assert.equal(sub.data.path, 'reports');
  assert.deepEqual(sub.data.entries.map((e) => e.path), ['reports/weekly.md']);

  assert.equal((await list(bot, 'old.txt')).status, 400);
  assert.equal((await list(bot, 'nope')).status, 404);
});

test('raw files: images, SVG, PDFs and text show inline with a fixed type; HTML and the rest download, never as a document of the app', { skip: process.platform !== 'linux' && 'Requires Linux directory handles' }, async () => {
  const bot = await newBot('Previewer');
  put(bot, 'reports/weekly.md', '# Weekly\n\n- shipped files');
  put(bot, 'chart.png', PNG);
  put(bot, 'doc.pdf', '%PDF-1.4\n%%EOF\n');

  const md = await raw(bot, 'reports/weekly.md');
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(md.headers.get('x-content-type-options'), 'nosniff');
  assert.match(md.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(md.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.match(md.headers.get('content-disposition') ?? '', /^inline; filename="weekly.md"/);
  assert.equal(await md.text(), '# Weekly\n\n- shipped files');

  const png = await raw(bot, 'chart.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition') ?? '', /^inline/);
  assert.match(png.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(png.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  assert.equal((await raw(bot, 'chart.png', device, '', { headers: { 'if-none-match': png.headers.get('etag')! } })).status, 304);

  const pdf = await raw(bot, 'doc.pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition') ?? '', /^inline/);
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');

  const dl = await raw(bot, 'chart.png', device, '&download=1');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename="chart.png"/);
  await dl.arrayBuffer();

  assert.equal((await raw(bot, 'reports')).status, 400);
  assert.equal((await raw(bot, 'missing.txt')).status, 404);

  const script = '<script>fetch("/api/bots",{method:"POST"})</script>';
  put(bot, 'page.html', `<html><body>${script}</body></html>`);
  put(bot, 'Page.HTM', script);
  put(bot, 'noext', script);
  // HTML dressed up as an image: the type comes from the extension, and nosniff stops browsers guessing.
  put(bot, 'fake.png', script);
  for (const name of ['page.html', 'Page.HTM', 'noext']) {
    const res = await raw(bot, name);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/, name);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
    assert.match(res.headers.get('content-security-policy') ?? '', /(^|; )sandbox($|;)/, name);
    await res.text();
  }
  const fake = await raw(bot, 'fake.png');
  assert.equal(fake.headers.get('content-type'), 'image/png');
  assert.equal(fake.headers.get('x-content-type-options'), 'nosniff');
  assert.match(fake.headers.get('content-security-policy') ?? '', /sandbox/);
  await fake.text();
});

test('a FIFO (or other special file) is refused at once, and never ties up the server', { skip: process.platform === 'win32' }, async () => {
  const bot = await newBot('Piper');
  put(bot, 'ok.txt', 'still here');
  // More than libuv's default threadpool of 4: a blocking open of each would stall all file I/O.
  const names = Array.from({ length: 6 }, (_, i) => `pipe-${i}.png`);
  for (const n of names) execFileSync('mkfifo', [join(bot.workspace, n)]);
  try {
    const answers = await Promise.all(names.map(async (n) => {
      const res = await raw(bot, n, device, '', { signal: AbortSignal.timeout(2000) });
      await res.text();
      return res.status;
    }));
    assert.deepEqual(answers, names.map(() => 400));
    const ok = await raw(bot, 'ok.txt');
    if (process.platform === 'linux') assert.equal(await ok.text(), 'still here');
    else assert.equal(ok.status, 501);
    assert.equal((await call('POST', `/api/bots/${bot.id}/messages`, { text: 'hi', attachments: [{ path: 'pipe-0.png' }] })).status, 400);
    if (process.platform === 'linux') assert.deepEqual((await list(bot)).data.entries.map((e) => e.name), ['ok.txt']);
    else assert.equal((await list(bot)).status, 501);
  } finally {
    // If an open did block, a writer lets it go so the test can finish.
    for (const n of names) {
      try {
        closeSync(openSync(join(bot.workspace, n), constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {}
    }
  }
});

test('paths with ../, absolute paths and symlinks that lead outside the workspace are 403, nothing outside is read, and listings leave such links out', { skip: process.platform !== 'linux' && 'Requires Linux directory handles' }, async () => {
  const bot = await newBot('Jailed');
  const other = await newBot('Neighbor');
  put(other, 'private.txt', 'NEIGHBOR SECRET');
  put(bot, 'inside/ok.txt', 'fine');
  symlinkSync(secretDir, join(bot.workspace, 'escape-dir'));
  symlinkSync(join(secretDir, 'secret.txt'), join(bot.workspace, 'escape.txt'));
  symlinkSync(join(bot.workspace, 'inside/ok.txt'), join(bot.workspace, 'alias.txt'));
  symlinkSync(join(bot.workspace, 'gone'), join(bot.workspace, 'broken'));
  // Up to the temp folder, where secretDir is.
  symlinkSync('../../../..', join(bot.workspace, 'inside/up'));
  const outside = [
    '../secret.txt',
    'inside/../../x',
    `../${other.workspace.split('/').pop()}/private.txt`,
    join(secretDir, 'secret.txt'),
    join(other.workspace, 'private.txt'),
    '/etc/passwd',
    'escape.txt',
    'escape-dir/secret.txt',
    'escape-dir',
    'inside/up',
    `inside/up/${secretDir.split('/').pop()}/secret.txt`,
  ];
  for (const path of outside) {
    const file = await raw(bot, path);
    const body = await file.text();
    assert.equal(file.status, 403, `raw ${path}: ${body}`);
    assert.ok(!body.includes('SECRET'), path);
    assert.equal((await list(bot, path)).status, 403, `list ${path}`);
  }
  assert.equal((await call('GET', `/api/bots/${bot.id}/files/raw?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status, 403);
  assert.equal(await (await raw(bot, join(bot.workspace, 'inside/ok.txt'))).text(), 'fine');
  assert.equal(await (await raw(bot, 'inside/../inside/ok.txt')).text(), 'fine');
  assert.equal((await raw(bot, 'inside/ok.txt\0.png')).status, 400);
  assert.deepEqual((await list(bot)).data.entries.map((e) => e.name).sort(), ['alias.txt', 'inside']);
});

test('only paired devices can browse, fetch or upload; a Boton token cannot', async () => {
  const bot = await newBot('Guarded');
  put(bot, 'a.txt', 'a');
  assert.equal((await list(bot, undefined, null)).status, 401);
  assert.equal((await raw(bot, 'a.txt', null)).status, 401);
  const { token, revoke } = app.auth.mintBotonToken(bot.id);
  try {
    assert.equal((await list(bot, undefined, token)).status, 403);
    assert.equal((await raw(bot, 'a.txt', token)).status, 403);
    const up = await upload(bot, 'x.txt', 'x', { authorization: `Bearer ${token}` });
    assert.equal(up.status, 403);
    await up.text();
  } finally {
    revoke();
  }
  assert.deepEqual(inboxOf(bot), []);
});

test('an upload lands in inbox/ as <date>-<safe name>, never replaces a file, and needs octet-stream', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const bot = await newBot('Receiver');
  const first = await upload(bot, 'Screen Shot 2026.png', PNG);
  assert.equal(first.status, 201);
  const ref = (await first.json()) as FileRef;
  assert.match(ref.name, /^\d{4}-\d{2}-\d{2}-Screen-Shot-2026\.png$/);
  assert.equal(ref.path, `inbox/${ref.name}`);
  assert.equal(ref.size, PNG.length);
  assert.equal(ref.type, 'image/png');
  assert.deepEqual(readFileSync(join(bot.workspace, ref.path)), PNG);

  assert.equal((await uploaded(bot, 'Screen Shot 2026.png', 'other')).name, ref.name.replace('.png', '-2.png'));
  assert.deepEqual(readFileSync(join(bot.workspace, ref.path)), PNG, 'the first one is untouched');

  assert.match((await uploaded(bot, '../../.bashrc', 'echo hi')).path, /^inbox\/\d{4}-\d{2}-\d{2}-bashrc$/);
  assert.deepEqual(inboxOf(bot).filter((n) => n.startsWith('.')), []);

  const json = await upload(bot, 'x.json', '{}', { 'content-type': 'application/json' });
  assert.equal(json.status, 415);
  await json.text();
});

/** Sends a chunked body of UPLOAD_MAX_BYTES + 1 bytes, never ending it, and resolves with the whole answer. */
function overLimitChunked(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(Number(new URL(base).port), '127.0.0.1');
    const got: Buffer[] = [];
    const whole = () => {
      const text = Buffer.concat(got).toString('latin1');
      const at = text.indexOf('\r\n\r\n');
      if (at < 0) return null;
      const [line, ...fields] = text.slice(0, at).split('\r\n');
      const head = Object.fromEntries(fields.map((f) => [f.slice(0, f.indexOf(':')).toLowerCase(), f.slice(f.indexOf(':') + 1).trim()]));
      let rest = text.slice(at + 4);
      let body = '';
      if (head['transfer-encoding'] !== 'chunked') return Number(head['content-length']) === rest.length ? { status: Number(line!.split(' ')[1]), headers: head, body: rest } : null;
      for (;;) {
        const eol = rest.indexOf('\r\n');
        const n = eol < 0 ? NaN : parseInt(rest.slice(0, eol), 16);
        if (!(n >= 0) || rest.length < eol + 4 + n) return null;
        if (n === 0) return { status: Number(line!.split(' ')[1]), headers: head, body };
        body += rest.slice(eol + 2, eol + 2 + n);
        rest = rest.slice(eol + 4 + n);
      }
    };
    // A reset is tolerated only after a whole answer; a lost or cut-off one fails.
    const settle = (err?: Error) => {
      const answer = whole();
      socket.destroy();
      if (answer) done(answer);
      else fail(err ?? new Error(`no whole answer: ${JSON.stringify(Buffer.concat(got).toString('latin1').slice(0, 300))}`));
    };
    socket.on('data', (d: Buffer) => got.push(d));
    socket.once('end', () => settle());
    socket.once('error', settle);
    const fields = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.write(`POST ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\n${fields}transfer-encoding: chunked\r\n\r\n`);
    let sent = 0;
    const next = () => {
      if (got.length) return; // answered early: stop
      const n = Math.min(1024 * 1024, UPLOAD_MAX_BYTES - sent);
      if (n > 0) return void socket.write(`${n.toString(16)}\r\n${'7'.repeat(n)}\r\n`, () => ((sent += n), next()));
      socket.write('1\r\n7'); // byte UPLOAD_MAX_BYTES + 1, and the last one written
    };
    next();
  });
}

test('an upload over the limit is 413 and leaves no partial file, whether or not it says its size', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const bot = await newBot('Bounded');
  const declared = await upload(bot, 'big.bin', Buffer.alloc(UPLOAD_MAX_BYTES + 1, 7));
  assert.equal(declared.status, 413);
  assert.match(((await declared.json()) as { error: string }).error, /too big/);

  // No Content-Length: the server counts and stops. The byte over the limit is the last one sent, so the
  // server's 413 and close can't land while the client still writes (a write after that reset fails with EPIPE
  // and takes the unread answer with it); the answer must arrive whole while the body is still open.
  const chunked = await overLimitChunked(`/api/bots/${bot.id}/uploads?name=big.bin`, { authorization: `Bearer ${device}`, 'content-type': 'application/octet-stream' });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.headers.connection, 'close');
  assert.match((JSON.parse(chunked.body) as { error: string }).error, /too big/);
  assert.deepEqual(inboxOf(bot), [], 'no partial or temp file');

  const ok = await upload(bot, 'max.bin', Buffer.alloc(UPLOAD_MAX_BYTES, 1));
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as FileRef).size, UPLOAD_MAX_BYTES);
});

test('an upload that is cut off leaves no partial file, and temp files a killed server left are cleared by the next upload once old', { skip: process.platform !== 'linux' && 'Requires Linux directory handles for confined file operations' }, async () => {
  const bot = await newBot('Interrupted');
  await new Promise<void>((done) => {
    const r = request(`${base}/api/bots/${bot.id}/uploads?name=half.bin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${device}`, 'content-type': 'application/octet-stream', 'content-length': '100000' },
    });
    r.on('error', () => done());
    r.write(Buffer.alloc(50_000, 1), () => setTimeout(() => r.destroy(), 100));
  });
  await until(() => inboxOf(bot).length === 0);
  await sleep(100);
  assert.deepEqual(inboxOf(bot), []);

  put(bot, 'inbox/.upload-0123456789abcdef.part', 'left by a crash', 61);
  put(bot, 'inbox/.upload-fedcba9876543210.part', 'another upload, still going');
  put(bot, 'inbox/.upload-notours.part', 'not a name uploads use', 61);
  put(bot, 'inbox/old-notes.txt', 'kept', 61);
  const res = await upload(bot, 'new.txt', 'hello');
  assert.equal(res.status, 201);
  const saved = (await res.json()) as FileRef;
  assert.deepEqual(inboxOf(bot).sort(), ['.upload-fedcba9876543210.part', '.upload-notours.part', saved.name, 'old-notes.txt'].sort());
});

test('an inbox that is a symlink is refused, and nothing is written where it points', async () => {
  const bot = await newBot('Swapped');
  const target = tempDir('botons-files-inbox-');
  symlinkSync(target, join(bot.workspace, 'inbox'));
  const res = await upload(bot, 'a.txt', 'hello');
  assert.equal(res.status, 409);
  await res.text();
  assert.deepEqual(readdirSync(target), []);
});

test('only uploads may skip JSON: other mutating /api routes still refuse non-JSON bodies, and cross-site uploads are refused', async () => {
  const bot = await newBot('Strict');
  for (const [method, path] of [
    ['POST', '/api/bots'],
    ['POST', `/api/bots/${bot.id}/messages`],
    ['PATCH', `/api/bots/${bot.id}`],
    ['POST', `/api/bots/${bot.id}/share`],
    ['POST', `/api/bots/${bot.id}/uploads/x`],
    ['PUT', `/api/bots/${bot.id}/uploads`],
  ]) {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${device}`, 'content-type': 'application/octet-stream' }, body: '{"text":"hi","name":"x"}' });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(((await res.json()) as { error: string }).error, /application\/json/);
  }
  const refused: Record<string, string>[] = [{ 'content-type': 'text/plain' }, { 'content-type': 'multipart/form-data; boundary=x' }, { 'content-type': 'application/x-www-form-urlencoded' }, { origin: 'https://evil.example' }];
  for (const headers of refused) {
    const res = await upload(bot, 'x.txt', 'x', headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    await res.text();
  }
  assert.deepEqual(inboxOf(bot), []);
});

test('a message with attachments: meta lists them, the prompt gives their absolute paths, and Codex gets the images', async () => {
  const bot = await newBot('Looker');
  const shot = attachment(bot, 'screenshot.png', PNG);
  const log = attachment(bot, 'server.log', 'boom\n');
  const sent = await call<Message>('POST', `/api/bots/${bot.id}/messages`, { text: 'What is wrong here?', attachments: [{ path: shot.path }, { path: log.path }] });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.data.meta?.attachments, [shot, log]);
  await s.untilState(bot.id, 'idle');
  const [turn] = s.turnsOf(bot.id);
  const shotPath = join(bot.workspace, shot.path);
  assert.ok(turn.prompt.includes('What is wrong here?'));
  assert.ok(turn.prompt.includes(`- ${shotPath} (image/png, `), turn.prompt);
  assert.ok(turn.prompt.includes(`- ${join(bot.workspace, log.path)} (text/plain, 5 B)`));
  assert.deepEqual(turn.images, [shotPath]);
  const argv = codexArgs({ ...turn, sessionId: 'thread-1' });
  assert.deepEqual(argv.slice(0, 5), ['exec', 'resume', '--image', shotPath, '--json']);
  assert.deepEqual(argv.slice(-2), ['thread-1', '-']);

  const photoOnly = await call<Message>('POST', `/api/bots/${bot.id}/messages`, { attachments: [{ path: shot.path }] });
  assert.equal(photoOnly.status, 202);
  assert.equal(photoOnly.data.text, '');
  await s.untilState(bot.id, 'idle');
  assert.match(s.turnsOf(bot.id).at(-1)!.prompt, /attached a file, saved in your workspace/);

  const t = transcriptBlock(await messagesOf(bot.id), { ownerName: 'Sam' }, 'UTC');
  assert.ok(t.includes(`What is wrong here? (attached: ${shot.path}, ${log.path})`), t);
});

test('attachments must be files inside the workspace', async () => {
  const bot = await newBot('Picky');
  put(bot, 'folder/a.txt', 'a');
  const send = (attachments: unknown, text: unknown = 'hi') => call('POST', `/api/bots/${bot.id}/messages`, { text, attachments });
  assert.equal((await send([{ path: '../../etc/passwd' }])).status, 403);
  assert.equal((await send([{ path: join(secretDir, 'secret.txt') }])).status, 403);
  assert.equal((await send([{ path: 'nope.png' }])).status, 404);
  assert.equal((await send([{ path: 'folder' }])).status, 400);
  assert.equal((await send('folder/a.txt')).status, 400);
  assert.equal((await send(Array.from({ length: 11 }, () => ({ path: 'folder/a.txt' })))).status, 400);
  assert.equal((await send([], '')).status, 400, 'no text and no files');
  assert.equal((await send(undefined, 5)).status, 400);
  assert.deepEqual((await messagesOf(bot.id)).filter((m) => m.role === 'user'), []);
});

test('attachments are checked again when the turn starts: one swapped for a link outside is neither read nor named', async () => {
  const bot = await newBot('Swapper');
  const other = await newBot('Bystander');
  put(other, 'inbox/private.png', PNG);
  const shot = attachment(bot, 'shot.png', PNG);
  const kept = attachment(bot, 'kept.png', PNG);
  // A slow turn first, so the message waits in the queue.
  assert.equal((await s.send(bot.id, 'SLOW_PLEASE:400')).status, 202);
  await until(() => app.engine.statusOf(bot.id).state !== 'idle');
  assert.equal((await call('POST', `/api/bots/${bot.id}/messages`, { text: 'Look', attachments: [{ path: shot.path }, { path: kept.path }] })).status, 202);
  rmSync(join(bot.workspace, shot.path));
  symlinkSync(join(other.workspace, 'inbox/private.png'), join(bot.workspace, shot.path));
  const turn = await until(() => s.turnsOf(bot.id).slice(1).find((t) => t.prompt.includes('Look')));
  await s.untilState(bot.id, 'idle');
  const keptPath = join(bot.workspace, kept.path);
  assert.deepEqual(turn.images, [keptPath]);
  assert.ok(turn.prompt.includes(`- ${join(bot.workspace, shot.path)} (no longer there)`), turn.prompt);
  assert.ok(turn.prompt.includes(`- ${keptPath} (image/png, `), turn.prompt);
  assert.ok(!turn.prompt.includes(other.workspace), turn.prompt);
});

test('`botons share reports/weekly.md` posts a chip that opens the file; a Boton can share only its own files', async () => {
  const bot = await newBot('Reporter');
  put(bot, 'reports/weekly.md', '# Weekly report\n\nAll good.');
  put(bot, 'reports/data.csv', 'a,b\n1,2\n');
  symlinkSync(join(secretDir, 'secret.txt'), join(bot.workspace, 'leak.txt'));
  // During a slow turn, with its environment.
  assert.equal((await s.send(bot.id, 'SLOW_PLEASE')).status, 202);
  const { env } = await until(() => s.turnsOf(bot.id)[0]);
  const share = (...args: string[]) => botonCli(env, bot.workspace, 'share', ...args);
  const out = await share('reports/weekly.md', '--title', 'Weekly report');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Shared reports\/weekly\.md/);
  const sub = await botonCli(env, join(bot.workspace, 'reports'), 'share', 'data.csv', '--json');
  assert.equal(sub.code, 0, sub.stderr);
  assert.equal((JSON.parse(sub.stdout) as ShareResult).file.path, 'reports/data.csv');
  for (const bad of ['../../etc/passwd', join(secretDir, 'secret.txt'), 'leak.txt']) {
    const refused = await share(bad);
    assert.equal(refused.code, 1, bad);
    assert.match(refused.stderr, /outside the workspace/, bad);
  }
  const folder = await share('reports');
  assert.equal(folder.code, 1);
  assert.match(folder.stderr, /is a folder/);
  assert.equal((await share('nope.md')).code, 1);
  await call('POST', `/api/bots/${bot.id}/stop`);
  await s.untilState(bot.id, 'idle');

  const chips = (await messagesOf(bot.id)).filter((m) => m.meta?.kind === 'file.shared');
  assert.equal(chips.length, 2);
  assert.equal(chips[0].role, 'event');
  assert.equal(chips[0].text, 'Shared reports/weekly.md');
  assert.deepEqual(chips[0].meta?.file, { name: 'weekly.md', path: 'reports/weekly.md', size: 26, type: 'text/markdown', title: 'Weekly report' });
  const opened = await raw(bot, chips[0].meta!.file!.path);
  assert.equal(opened.status, process.platform === 'linux' ? 200 : 501);
  if (process.platform === 'linux') assert.equal(await opened.text(), '# Weekly report\n\nAll good.');
  else assert.match(await opened.text(), /needs Linux directory handles/);

  const other = await newBot('Theirs');
  put(other, 'x.md', 'x');
  const { token, revoke } = app.auth.mintBotonToken(bot.id);
  try {
    const shareAs = (botId: string, body: unknown) => call('POST', `/api/bots/${botId}/share`, body, token);
    assert.equal((await shareAs(other.id, { path: 'x.md' })).status, 403);
    assert.equal((await shareAs(bot.id, { path: join(other.workspace, 'x.md') })).status, 403);
    assert.equal((await shareAs(bot.id, {})).status, 400);
    assert.equal((await shareAs(bot.id, { path: 'x.md', title: 'x'.repeat(201) })).status, 400);
  } finally {
    revoke();
  }
});

test('safeName keeps letters, digits, dots, dashes and underscores; servingOf shows only raster images, SVG, PDFs and text, and HTML only as its preview page; disposition encodes any name', () => {
  assert.equal(safeName('Screen Shot 2026-11-05 at 9.41.12 AM.png'), 'Screen-Shot-2026-11-05-at-9.41.12-AM.png');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(safeName('.env'), 'env');
  assert.equal(safeName('...'), 'file');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('a"b<c>d|e?.txt'), 'a-b-c-d-e.txt');
  assert.equal(safeName('résumé.pdf'), 'résumé.pdf');
  assert.equal(safeName('a,b.png'), 'a-b.png');
  const long = safeName(`${'x'.repeat(300)}.markdown`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('.markdown'));

  assert.deepEqual(servingOf('a.png', 10, 'raw').inline, true);
  assert.deepEqual(servingOf('a.JPG', 10, 'raw').type, 'image/jpeg');
  assert.deepEqual(servingOf('a.md', 10, 'raw').type, 'text/plain; charset=utf-8');
  assert.equal(servingOf('a.pdf', 10, 'raw').csp, null);
  assert.equal(servingOf('a.svg', 10, 'raw').type, 'image/svg+xml');
  assert.match(servingOf('a.svg', 10, 'raw').csp ?? '', /(^|; )sandbox($|;)/);
  assert.equal(servingOf('a.HTML', 10, 'preview').type, 'text/html; charset=utf-8');
  assert.throws(() => servingOf('a.txt', 10, 'preview'), /Only HTML/);
  assert.throws(() => servingOf('a.html', 30 * 1024 * 1024, 'preview'), /Too big/);
  for (const name of ['a.html', 'a.htm', 'a.xhtml', 'a.xml', 'a', 'a.exe', 'a.heic']) {
    const s = servingOf(name, 10, 'raw');
    assert.equal(s.inline, false, name);
    assert.equal(s.type, 'application/octet-stream', name);
    assert.match(s.csp ?? '', /sandbox/, name);
  }
  assert.equal(servingOf('a.png', 30 * 1024 * 1024, 'raw').inline, false, 'too big to preview');
  assert.equal(servingOf('a.png', 10, 'download').inline, false);

  assert.equal(disposition('inline', 'weekly.md'), `inline; filename="weekly.md"; filename*=UTF-8''weekly.md`);
  const d = disposition('attachment', 'a "b"; c\r\n.txt');
  assert.ok(!/[\r\n]/.test(d));
  assert.match(d, /^attachment; filename="a _b__ c__.txt"; filename\*=UTF-8''a%20%22b%22%3B%20c%0D%0A\.txt$/);
});

test('without Linux directory handles browsing and downloads refuse without exposing files', { skip: process.platform === 'linux' && 'Covers hosts without Linux directory handles' }, async () => {
  const bot = await newBot('Kevin');
  put(bot, 'private.txt', 'FILE-CONTENT-MARKER');
  for (const path of ['', 'folder', '../outside']) {
    const res = await list(bot, path);
    assert.equal(res.status, 501);
    assert.doesNotMatch(JSON.stringify(res.data), /private.txt|FILE-CONTENT-MARKER/);
  }
  const res = await raw(bot, 'private.txt');
  assert.equal(res.status, 501);
  const body = await res.text();
  assert.match(body, /needs Linux directory handles/);
  assert.doesNotMatch(body, /FILE-CONTENT-MARKER/);
});
