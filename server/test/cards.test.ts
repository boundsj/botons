import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CardError, parseAnswer, parseCard } from '../../shared/cards.ts';
import type { AuditEvent, ConnectorAccess, Message } from '../../shared/types.ts';
import { addConnector as addOAuthConnector, OAUTH_ENV, setup as oauthSetup } from './oauth-helpers.ts';
import { failOnEscapedErrors, botonCli, startServer, type TestServer, tempDir, until, useTestCodexHome } from './helpers.ts';

failOnEscapedErrors();
useTestCodexHome(tempDir('botons-cards-codex-'));

const choice = (title = 'Which report?') => ({
  v: 1,
  title,
  blocks: [
    { type: 'text', text: 'Two drafts are ready.\nPick one.' },
    { type: 'choice', id: 'pick', prompt: 'Send which one?', options: [{ id: 'short', label: 'The short one' }, { id: 'long', label: 'The long one' }] },
  ],
});

const form = {
  v: 1,
  title: 'Trip details',
  blocks: [
    {
      type: 'form',
      id: 'trip',
      fields: [
        { id: 'city', label: 'City', kind: 'text', required: true },
        { id: 'nights', label: 'Nights', kind: 'number', min: 1, max: 30 },
        { id: 'room', label: 'Room', kind: 'select', options: [{ id: 'single', label: 'Single' }, { id: 'double', label: 'Double' }] },
        { id: 'notes', label: 'Notes', kind: 'textarea' },
        { id: 'ok', label: 'Book it', kind: 'checkbox' },
      ],
    },
  ],
};

const refusesWith = (input: unknown, re: RegExp) => assert.throws(() => parseCard(input), (e: unknown) => e instanceof CardError && re.test(e.message));

test('the card protocol: known blocks only, bounded, plain data, at most one question, never a secret, https links only', () => {
  const ok = parseCard(choice());
  assert.equal(ok.blocks.length, 2);
  refusesWith({ ...choice(), v: 2 }, /card\.v must be 1/);
  refusesWith({ ...choice(), extra: 1 }, /unknown field "extra"/);
  refusesWith(JSON.parse('{"v":1,"title":"x","blocks":[{"type":"text","text":"a"}],"__proto__":{"polluted":true}}'), /not allowed: __proto__/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'html', html: '<b>x</b>' }] }, /type must be one of/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'text', text: 'a', onClick: 'alert(1)' }] }, /unknown field "onClick"/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'text', text: 'a', style: 'color:red' }] }, /unknown field "style"/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'text', text: () => 1 }] }, /must be a string/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'text', text: new Date() }] }, /must be a string/);
  refusesWith({ v: 1, title: 'x', blocks: [choice().blocks[1], { type: 'connector', connectorId: 'lib:github' }] }, /at most one choice, form or connector/);
  refusesWith({ v: 1, title: 'x', blocks: Array.from({ length: 21 }, () => ({ type: 'text', text: 'a' })) }, /1 to 20 items/);
  refusesWith({ v: 1, title: 'x', blocks: Array.from({ length: 20 }, () => ({ type: 'text', text: 'a'.repeat(1999) })) }, /too big/);
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'http://example.com/', 'https://sam:pw@example.com/', 'file:///etc/passwd', 'https://localhost/', '//example.com/x']) {
    refusesWith({ v: 1, title: 'x', blocks: [{ type: 'link', url, label: 'Open' }] }, /url /);
  }
  assert.deepEqual(parseCard({ v: 1, title: 'x', blocks: [{ type: 'link', url: 'https://example.com/a?b=1', label: 'Open' }] }).blocks[0], { type: 'link', url: 'https://example.com/a?b=1', label: 'Open' });
  for (const label of ['Password', 'Your API key', 'GitHub token', 'One-time code', '2FA', 'Card number']) {
    refusesWith({ v: 1, title: 'x', blocks: [{ type: 'form', id: 'f', fields: [{ id: 'a', label, kind: 'text' }] }] }, /Cards never take secrets/);
  }
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'form', id: 'f', fields: [{ id: 'constructor', label: 'A', kind: 'text' }] }] }, /short id/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'choice', id: 'c', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }] }, /twice/);
  refusesWith({ v: 1, title: 'x', blocks: [{ type: 'table', columns: ['a', 'b'], rows: [['1']] }] }, /must have 2 items/);
  // Control and direction characters go; the text itself is kept as text.
  const cleaned = parseCard({ v: 1, title: 'A‮B\u0007', blocks: [{ type: 'text', text: '<img src=x onerror=alert(1)>\u0000' }] });
  assert.equal(cleaned.title, 'AB');
  assert.deepEqual(cleaned.blocks[0], { type: 'text', text: '<img src=x onerror=alert(1)>' });

  // Answers are checked against the saved card.
  const f = parseCard(form);
  assert.deepEqual(parseAnswer(f, { action: 'submit', values: { city: ' Paris ', nights: '3', room: 'double', ok: true } }), {
    action: 'submit',
    values: { city: 'Paris', nights: 3, room: 'double', ok: true },
  });
  const refusedAnswer = (input: unknown, re: RegExp, card = f) => assert.throws(() => parseAnswer(card, input), (e: unknown) => e instanceof CardError && re.test(e.message));
  refusedAnswer({ action: 'submit', values: {} }, /City is required/);
  refusedAnswer({ action: 'submit', values: { city: 'x', nights: 99 } }, /at most 30/);
  refusedAnswer({ action: 'submit', values: { city: 'x', room: 'suite' } }, /one of its options/);
  refusedAnswer({ action: 'submit', values: { city: 'x', admin: true } }, /unknown field "admin"/);
  refusedAnswer({ action: 'submit', values: { city: 'x' }, botId: 'other' }, /unknown field "botId"/);
  refusedAnswer({ action: 'grant' }, /no connector/);
  refusedAnswer({ action: 'choose', option: 'short' }, /no choice/);
  refusedAnswer({ action: 'run', code: 'x' }, /action must be one of/);
  refusedAnswer({ action: 'choose', option: 'nope' }, /one of the card/, parseCard(choice()));
});

const tokenFor = (s: TestServer, botId: string, sandboxed = false) => s.app.auth.mintBotonToken(botId, { sandboxed }).token;
const post = (s: TestServer, botId: string, body: unknown, token = tokenFor(s, botId)) => s.call<{ message: Message; duplicate: boolean; error?: string }>('POST', `/api/bots/${botId}/cards`, body, token);
const answer = (s: TestServer, botId: string, id: string, body: unknown, token?: string) => s.call<Message & { error?: string }>('POST', `/api/bots/${botId}/cards/${id}/answer`, body, token);
const audits = async (s: TestServer, action: string) => (await s.call<AuditEvent[]>('GET', '/api/audit')).data.filter((e) => e.action === action);

test('cards end to end: Botons post, only the owner answers, once, checked against the saved card, audited without values', async () => {
  const s = await startServer();
  const kevin = s.storeBot('Kevin');
  const stuart = s.storeBot('Stuart');

  // Only a Boton posts, for itself.
  assert.equal((await s.call('POST', `/api/bots/${kevin.id}/cards`, { card: choice() })).status, 400);
  assert.equal((await post(s, kevin.id, { card: choice() }, tokenFor(s, stuart.id))).status, 403);
  assert.equal((await post(s, kevin.id, { card: choice(), onAnswer: 'https://example.com/hook' })).status, 400);
  const bad = await post(s, kevin.id, { card: { v: 1, title: 'x', blocks: [{ type: 'link', url: 'javascript:alert(1)', label: 'x' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error!, /https/);

  const first = await post(s, kevin.id, { card: choice() });
  assert.equal(first.status, 201, first.text);
  const id = first.data.message.id;
  assert.equal(first.data.message.meta?.kind, 'card.posted');
  assert.equal(first.data.message.meta?.card?.status, 'pending');
  // The same card again (a retry): the one already waiting.
  const again = await post(s, kevin.id, { card: choice() });
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.message.id, id);

  // Boton tokens never answer, their own card or another's; another Boton can't read it either.
  assert.equal((await answer(s, kevin.id, id, { action: 'choose', option: 'short' }, tokenFor(s, kevin.id))).status, 403);
  assert.equal((await answer(s, kevin.id, id, { action: 'choose', option: 'short' }, tokenFor(s, stuart.id))).status, 403);
  assert.equal((await s.call('GET', `/api/cards/${id}`, undefined, tokenFor(s, stuart.id))).status, 403);
  assert.equal((await s.call('GET', `/api/cards/${id}`, undefined, tokenFor(s, kevin.id))).status, 200);
  // The card belongs to Kevin: not answerable as Stuart's, and a plain message is no card.
  assert.equal((await answer(s, stuart.id, id, { action: 'choose', option: 'short' })).status, 404);
  const plain = s.app.store.addMessage(kevin.id, 'event', 'Not a card', { kind: 'notify.sent' });
  assert.equal((await answer(s, kevin.id, plain.id, { action: 'decline' })).status, 404);
  // Malformed answers change nothing.
  for (const body of [{ action: 'choose', option: 'nope' }, { action: 'grant' }, { action: 'choose', option: 'short', extra: 1 }, null, 'choose']) {
    assert.equal((await answer(s, kevin.id, id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(s.app.store.findMessage(id)!.meta?.card?.status, 'pending');

  // The owner answers; twice at once still counts once.
  const [a1, a2] = await Promise.all([answer(s, kevin.id, id, { action: 'choose', option: 'long' }), answer(s, kevin.id, id, { action: 'choose', option: 'short' })]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 409]);
  const won = a1.status === 200 ? a1 : a2;
  const card = s.app.store.findMessage(id)!.meta!.card!;
  assert.equal(card.status, 'answered');
  assert.equal(card.answer!.option!.id, won === a1 ? 'long' : 'short');
  assert.equal((await answer(s, kevin.id, id, { action: 'decline' })).status, 409);

  // Kevin gets a turn with the answer, marked as the owner's answer to that card.
  await until(() => s.turnsOf(kevin.id).some((t) => t.prompt.includes(`answer to your card ${id}`)));
  const turn = s.turnsOf(kevin.id).find((t) => t.prompt.includes(`answer to your card ${id}`))!;
  assert.match(turn.prompt, /Answered “Which report\?”: The (long|short) one/);

  // A form: values are cleaned and go to the Boton, but the audit names the fields only.
  const f = await post(s, kevin.id, { card: form });
  const filled = await answer(s, kevin.id, f.data.message.id, { action: 'submit', values: { city: 'Lisbon-unique-value', nights: 2, ok: true } });
  assert.equal(filled.status, 200, filled.text);
  assert.deepEqual(filled.data.meta?.card?.answer?.values, { city: 'Lisbon-unique-value', nights: 2, ok: true });
  await until(() => s.turnsOf(kevin.id).some((t) => t.prompt.includes('City: Lisbon-unique-value')));
  const answered = await audits(s, 'card.answered');
  assert.equal(answered.length, 2);
  const formAudit = answered.find((e) => e.target?.id === f.data.message.id)!;
  assert.deepEqual(formAudit.details, { boton: kevin.id, answer: 'submit', result: 'answered', fields: ['city', 'nights', 'ok'] });
  assert.equal(formAudit.actor.kind, 'device');
  assert.ok(!JSON.stringify(answered).includes('Lisbon-unique-value'), 'no typed values in the audit log');

  // Expired: refused, and closed as expired.
  const late = await post(s, kevin.id, { card: choice('Late question'), expiresIn: '1m' });
  s.app.store.db.prepare("update messages set meta = json_set(meta, '$.card.expiresAt', '2000-01-01T00:00:00.000Z') where id = ?").run(late.data.message.id);
  const expired = await answer(s, kevin.id, late.data.message.id, { action: 'choose', option: 'short' });
  assert.equal(expired.status, 409);
  assert.match(expired.data.error!, /expired/);
  assert.equal(s.app.store.findMessage(late.data.message.id)!.meta?.card?.status, 'expired');

  // A card with nothing to ask is just shown; nothing answers it.
  const shown = await post(s, kevin.id, { card: { v: 1, title: 'Build', blocks: [{ type: 'progress', label: 'Tests', value: 3, max: 10 }, { type: 'status', tone: 'working', text: 'Running' }] } });
  assert.equal(shown.data.message.meta?.card?.status, 'shown');
  assert.equal((await answer(s, kevin.id, shown.data.message.id, { action: 'decline' })).status, 409);

  // A webhook run may post a question, marked as from outside; never a connector card.
  const fromHook = await post(s, stuart.id, { card: choice('From a webhook') }, tokenFor(s, stuart.id, true));
  assert.equal(fromHook.status, 201);
  assert.equal(fromHook.data.message.meta?.card?.from.sandboxed, true);
  assert.equal((await post(s, stuart.id, { card: { v: 1, title: 'x', blocks: [{ type: 'connector', connectorId: 'lib:github' }] } }, tokenFor(s, stuart.id, true))).status, 403);

  // Secrets: refused at the post.
  const secret = await post(s, stuart.id, { card: { v: 1, title: 'Sign in', blocks: [{ type: 'form', id: 'f', fields: [{ id: 'pw', label: 'Password', kind: 'text' }] }] } });
  assert.equal(secret.status, 400);

  // At most ten waiting.
  for (let i = 0; i < 9; i++) assert.equal((await post(s, stuart.id, { card: choice(`Question ${i}`) })).status, 201);
  assert.equal((await post(s, stuart.id, { card: choice('One too many') })).status, 409);

  // Files: only regular files in the Boton's own workspace, by the resolved path.
  mkdirSync(join(kevin.workspace, 'reports'), { recursive: true });
  writeFileSync(join(kevin.workspace, 'reports', 'weekly.md'), '# Weekly');
  const withFile = await post(s, kevin.id, { card: { v: 1, title: 'Report', blocks: [{ type: 'file', path: './reports/../reports/weekly.md' }] } });
  assert.equal(withFile.status, 201, withFile.text);
  assert.deepEqual(withFile.data.message.meta?.card?.descriptor.blocks[0], { type: 'file', path: 'reports/weekly.md' });
  assert.equal((await post(s, kevin.id, { card: { v: 1, title: 'x', blocks: [{ type: 'file', path: '/etc/hostname' }] } })).status, 403);
  assert.equal((await post(s, kevin.id, { card: { v: 1, title: 'x', blocks: [{ type: 'file', path: 'missing.md' }] } })).status, 404);
  assert.equal((await post(s, kevin.id, { card: { v: 1, title: 'x', blocks: [{ type: 'file', path: 'reports' }] } })).status, 400);

  // The CLI posts one too, as JSON given inline or from a workspace file, and says what to do next.
  const cli = await botonCli(s.app, s.base, kevin.id, 'card', 'post', '--card', JSON.stringify(choice('From the CLI')), '--expires', '2h');
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Posted the card "From the CLI" \(msg_[^)]+\); it waits for your owner until .*end your turn/);
  const cliBad = await botonCli(s.app, s.base, kevin.id, 'card', 'post', '--card', '{"v":1,"title":"x","blocks":[{"type":"script","src":"x"}]}');
  assert.equal(cliBad.code, 1);
  assert.match(cliBad.stderr, /type must be one of/);

  // Every change went out as an event, for the app.
  assert.ok(s.app.store.findMessage(id)!.meta?.card?.answer);
});

test('a connector card: the owner gives the connector in the chat, checked again at the click, audited as Settings records it', async () => {
  const s = await startServer({ fakeClis: true });
  s.claude.script('claude/reply');
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' })).status, 201);
  const kevin = s.storeBot('Kevin', 'claude-cli');
  const dave = s.storeBot('Dave', 'claude-cli');
  const card = { v: 1, title: 'I need GitHub', blocks: [{ type: 'text', text: 'To open the pull request.' }, { type: 'connector', connectorId: 'lib:github' }] };

  // Not on request: a card can't ask for it either.
  const off = await post(s, kevin.id, { card });
  assert.equal(off.status, 403);
  assert.match(off.data.error!, /not available on request/);
  assert.equal((await post(s, kevin.id, { card: { ...card, blocks: [{ type: 'connector', connectorId: 'lib:nope' }] } })).status, 404);

  assert.equal((await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true })).status, 200);
  const posted = await post(s, kevin.id, { card });
  assert.equal(posted.status, 201, posted.text);
  assert.deepEqual(posted.data.message.meta?.card?.connector, { id: 'lib:github', name: 'github', generation: s.app.connectors.policyOf('lib:github').generation });
  assert.ok(posted.data.message.meta!.card!.connector!.generation < 0);

  // The CLI shows it too.
  const shown = await botonCli(s.app, s.base, kevin.id, 'card', 'show', posted.data.message.id);
  assert.match(shown.stdout, /I need GitHub {2}\(pending\)/);

  const given = await answer(s, kevin.id, posted.data.message.id, { action: 'grant' });
  assert.equal(given.status, 200, given.text);
  assert.equal(given.data.meta?.card?.answer?.result, 'granted');
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['lib:github']);
  // The connector's own follow-up turn.
  await until(() => s.claude.calls().some((c) => c.stdin.includes('the connector lib:github you asked for was added')));

  // The same record Settings makes, so the connector's history shows who gave it, and how.
  const changed = await audits(s, 'boton.permissions_changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].actor.kind, 'device');
  assert.deepEqual(changed[0].target, { kind: 'boton', id: kevin.id, label: 'Kevin' });
  assert.deepEqual(changed[0].details, { connectionsAdded: ['lib:github'], via: 'card', card: posted.data.message.id });
  const access = (await s.call<ConnectorAccess>('GET', '/api/connectors/lib%3Agithub/access')).data;
  assert.ok(access.history.some((e) => e.action === 'boton.permissions_changed' && e.target?.id === kevin.id));
  assert.ok(access.botons.find((m) => m.botId === kevin.id)!.has);
  assert.ok(access.history.some((e) => e.action === 'card.answered'));

  // Stale: the owner changed the policy after the card was posted, so the click gives nothing and closes it.
  const asked = await post(s, dave.id, { card });
  assert.equal(asked.status, 201);
  assert.equal((await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { grant: 'immediate' })).status, 200);
  const stale = await answer(s, dave.id, asked.data.message.id, { action: 'grant' });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error!, /changed since the request was made/);
  assert.deepEqual(s.app.store.getBot(dave.id).connections, []);
  assert.equal(s.app.store.findMessage(asked.data.message.id)!.meta?.card?.status, 'refused');
  assert.equal((await answer(s, dave.id, asked.data.message.id, { action: 'grant' })).status, 409, 'closed for good');
  assert.equal((await audits(s, 'boton.permissions_changed')).length, 1);

  // Off request after posting: refused as well.
  const later = await post(s, dave.id, { card });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: false });
  assert.equal((await answer(s, dave.id, later.data.message.id, { action: 'grant' })).status, 409);
  assert.deepEqual(s.app.store.getBot(dave.id).connections, []);

  // Declining one tells the Boton, and gives nothing.
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true });
  const declined = await post(s, dave.id, { card });
  assert.equal((await answer(s, dave.id, declined.data.message.id, { action: 'decline' })).data.meta?.card?.status, 'declined');
  assert.deepEqual(s.app.store.getBot(dave.id).connections, []);
  await until(() => s.claude.calls().some((c) => c.stdin.includes('Declined “I need GitHub”')));
});

test('a connector card is bound to the connector it was posted for: deleted and added again, even the same, it gives nothing', async () => {
  const s = await startServer({ fakeClis: true });
  s.claude.script('claude/reply');
  const kevin = s.storeBot('Kevin', 'claude-cli');
  const card = { v: 1, title: 'I need GitHub', blocks: [{ type: 'connector', connectorId: 'lib:github' }] };
  const userTurns = () => s.app.store.listMessages(kevin.id, { limit: 1000 }).filter((m) => m.role === 'user').length;

  for (const url of ['https://other.example.com/mcp', 'https://mcp.example.com/mcp']) {
    assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' })).status, 201);
    assert.equal((await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true })).status, 200);
    const posted = await post(s, kevin.id, { card });
    assert.equal(posted.status, 201, posted.text);

    // Deleted: its request policy goes with it, so the one added under the same name starts off request.
    assert.equal((await s.call('DELETE', '/api/mcp-servers/github')).status, 200);
    assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url })).status, 201);
    const fresh = (await s.call<{ connectors: { id: string; onRequest: boolean; grant: string }[] }>('GET', '/api/connectors')).data.connectors.find((c) => c.id === 'lib:github')!;
    assert.equal(fresh.onRequest, false);
    assert.equal(fresh.grant, 'approval');
    // The owner puts the new one on request: the old card still asks for the connector that was deleted.
    assert.equal((await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true })).status, 200);
    const turnsBefore = userTurns();
    const old = await answer(s, kevin.id, posted.data.message.id, { action: 'grant' });
    assert.equal(old.status, 409, `${url}: ${old.text}`);
    assert.match(old.data.error!, /changed since the request was made/);
    assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);
    assert.equal(s.app.store.findMessage(posted.data.message.id)!.meta?.card?.status, 'refused');
    assert.equal(userTurns(), turnsBefore, 'no turn for a refused card');
    assert.equal((await audits(s, 'boton.permissions_changed')).length, 0);
    assert.equal((await s.call('DELETE', '/api/mcp-servers/github')).status, 200);
  }

  // A card posted for the connector as it is now still works.
  assert.equal((await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' })).status, 201);
  assert.equal((await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true })).status, 200);
  const now = await post(s, kevin.id, { card });
  assert.equal((await answer(s, kevin.id, now.data.message.id, { action: 'grant' })).status, 200);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['lib:github']);
  assert.equal((await audits(s, 'boton.permissions_changed')).length, 1);
});

test('a connector request waiting for approval is bound to the connector too: deleted and added again, allowing it gives nothing', async () => {
  const s = await startServer({ fakeClis: true });
  const kevin = s.storeBot('Kevin', 'claude-cli');
  await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true });
  const asked = await s.call<{ outcome: string; approval: { id: string } }>('POST', `/api/bots/${kevin.id}/connector-requests`, { connector: 'lib:github' }, tokenFor(s, kevin.id));
  assert.equal(asked.data.outcome, 'pending', asked.text);
  await s.call('DELETE', '/api/mcp-servers/github');
  await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true });
  const allowed = await s.call<{ error?: string }>('POST', `/api/approvals/${asked.data.approval.id}/decide`, { decision: 'allow' });
  assert.equal(allowed.status, 409, allowed.text);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);
});

test('a connector card for an OAuth connector: refused while it is not signed in, at the post and at the click', async () => {
  const { s, fake } = await oauthSetup();
  s.claude.script('claude/reply');
  const kevin = s.storeBot('Kevin', 'claude-cli');
  const conn = await addOAuthConnector(s, fake, 'fleet');
  const signed = (status: 'new' | 'connected' | 'reconnect') => s.app.store.db.prepare('update oauth_connections set status = ? where id = ?').run(status, conn.id);
  const card = { v: 1, title: 'I need the fleet', blocks: [{ type: 'connector', connectorId: 'oauth:fleet' }] };
  assert.equal((await s.call('PATCH', '/api/connectors/oauth%3Afleet/policy', { onRequest: true })).status, 200);

  // What `botons connector list` says (not usable), the card says too: it can't be posted.
  assert.equal((await s.call<{ id: string; usable: boolean }[]>('GET', `/api/bots/${kevin.id}/connectors`, undefined, tokenFor(s, kevin.id))).data.find((c) => c.id === 'oauth:fleet')?.usable, false);
  const unsigned = await post(s, kevin.id, { card });
  assert.equal(unsigned.status, 403, unsigned.text);
  assert.match(unsigned.data.error!, /not signed in/);

  // Signed in when posted, signed out by the click: nothing given, the card closed with the reason.
  signed('connected');
  const posted = await post(s, kevin.id, { card });
  assert.equal(posted.status, 201, posted.text);
  signed('reconnect');
  const click = await answer(s, kevin.id, posted.data.message.id, { action: 'grant' });
  assert.equal(click.status, 409, click.text);
  assert.match(click.data.error!, /not signed in/);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);
  assert.equal(s.app.store.findMessage(posted.data.message.id)!.meta?.card?.status, 'refused');
  assert.equal((await audits(s, 'boton.permissions_changed')).length, 0);

  // Deleted and added again under the same name, signed in and on request: an old card still gives nothing.
  signed('connected');
  const before = await post(s, kevin.id, { card });
  assert.equal(before.status, 201, before.text);
  assert.equal((await s.call('DELETE', `/api/oauth-connections/${conn.id}`)).status, 200);
  const again = await addOAuthConnector(s, fake, 'fleet');
  s.app.store.db.prepare("update oauth_connections set status = 'connected' where id = ?").run(again.id);
  assert.equal((await s.call('PATCH', '/api/connectors/oauth%3Afleet/policy', { onRequest: true })).status, 200);
  assert.equal((await answer(s, kevin.id, before.data.message.id, { action: 'grant' })).status, 409);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);

  // Signed in throughout: given.
  const ok = await post(s, kevin.id, { card });
  assert.equal((await answer(s, kevin.id, ok.data.message.id, { action: 'grant' })).status, 200);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['oauth:fleet']);
});

test('a card answer and its audit rows are one transaction: a real failing audit write (either row) gives nothing, starts no turn and publishes nothing', async () => {
  const s = await startServer({ fakeClis: true });
  s.claude.script('claude/reply');
  const kevin = s.storeBot('Kevin', 'claude-cli');
  await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true });
  const db = s.app.store.db;
  const refuse = (action: string) => db.exec(`create trigger refuse_audit before insert on audit_events when new.action = '${action}' begin select raise(abort, 'the audit log refused it'); end`);
  const allow = () => db.exec('drop trigger refuse_audit');
  const rows = (action: string) => Number((db.prepare('select count(*) as n from audit_events where action = ?').get(action) as { n: number }).n);
  const userMessages = () => s.app.store.listMessages(kevin.id, { limit: 1000 }).filter((m) => m.role === 'user');
  const card = { v: 1, title: 'I need GitHub', blocks: [{ type: 'connector', connectorId: 'lib:github' }] };

  // The grant writes boton.permissions_changed first and card.answered second: each one failing undoes both.
  for (const failing of ['boton.permissions_changed', 'card.answered']) {
    const posted = await post(s, kevin.id, { card });
    assert.equal(posted.status, 201, posted.text);
    const id = posted.data.message.id;
    const calls = s.claude.calls().length;
    const sse = await s.events();
    refuse(failing);
    const failed = await answer(s, kevin.id, id, { action: 'grant' });
    allow();
    assert.equal(failed.status, 500, `${failing}: ${failed.text}`);
    assert.deepEqual(s.app.store.getBot(kevin.id).connections, [], failing);
    assert.equal(s.app.store.findMessage(id)!.meta?.card?.status, 'pending', failing);
    assert.equal(rows('boton.permissions_changed'), 0, `${failing}: no row of the grant without the other`);
    assert.equal(rows('card.answered'), 0, failing);
    assert.deepEqual(userMessages(), [], `${failing}: no follow-up turn`);
    // A round trip through the stream: nothing about the card, the grant or the Boton went out.
    await s.call('POST', '/api/mcp-servers', { name: `probe-${rows('card.answered')}-${failing.length}`, transport: 'http', url: 'https://mcp.example.com/mcp' });
    await until(() => sse.events.length > 0);
    sse.close();
    assert.ok(!sse.events.some((e) => (e.type === 'message.updated' || e.type === 'message.created') && e.message.botId === kevin.id), `${failing}: ${JSON.stringify(sse.events.map((e) => e.type))}`);
    assert.ok(!sse.events.some((e) => e.type === 'bot.upserted' && e.bot.id === kevin.id), failing);
    assert.equal(s.claude.calls().length, calls, `${failing}: not woken`);

    // Answered again once the log takes it: given once, with both rows once.
    const ok = await answer(s, kevin.id, id, { action: 'grant' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['lib:github']);
    assert.equal(rows('boton.permissions_changed'), 1);
    assert.equal(rows('card.answered'), 1);
    assert.equal(userMessages().filter((m) => m.meta?.kind === 'connector.granted').length, 1);
    assert.equal((await answer(s, kevin.id, id, { action: 'grant' })).status, 409);
    await until(() => s.claude.calls().length > calls);
    await until(() => s.app.engine.statusOf(kevin.id).state === 'idle' && !s.app.store.hasPendingChat(kevin.id));
    // Off again for the next round.
    s.app.store.setConnections(kevin.id, []);
    db.exec("delete from audit_events where action in ('boton.permissions_changed', 'card.answered')");
    db.prepare('delete from messages where bot_id = ?').run(kevin.id);
  }

  // A question card: its answer and its row too.
  const asked = await post(s, kevin.id, { card: choice() });
  refuse('card.answered');
  assert.equal((await answer(s, kevin.id, asked.data.message.id, { action: 'choose', option: 'short' })).status, 500);
  allow();
  assert.equal(s.app.store.findMessage(asked.data.message.id)!.meta?.card?.status, 'pending');
  assert.deepEqual(userMessages(), []);
  assert.equal((await answer(s, kevin.id, asked.data.message.id, { action: 'choose', option: 'short' })).status, 200);
  assert.equal(rows('card.answered'), 1);

  // A refusal is recorded or not made: with its row refused the card still waits, then it is refused with its row.
  const stale = await post(s, kevin.id, { card });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { grant: 'immediate' });
  refuse('card.answered');
  assert.equal((await answer(s, kevin.id, stale.data.message.id, { action: 'grant' })).status, 500);
  allow();
  assert.equal(s.app.store.findMessage(stale.data.message.id)!.meta?.card?.status, 'pending');
  const refused = await answer(s, kevin.id, stale.data.message.id, { action: 'grant' });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(s.app.store.findMessage(stale.data.message.id)!.meta?.card?.status, 'refused');
  assert.equal(rows('card.answered'), 2);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);
  assert.equal(rows('boton.permissions_changed'), 0);
});

/*
 * What a server before request policies had their generations as now leaves in a database: generations counted up
 * from 1 per row, a deleted connector's policy row deleted with it, and its requests still pending with the number
 * it had. Written here with SQL into a stopped server's database, exactly as that server's statements did.
 */
test('connector requests and cards recorded under an unissued generation are never allowed: deleted, added again and matching, after a restart', async () => {
  const cases: { kind: 'lib' | 'oauth'; others: number[]; url: string }[] = [
    { kind: 'lib', others: [], url: 'https://mcp.example.com/mcp' },
    { kind: 'lib', others: [1], url: 'https://other.example.com/mcp' },
    { kind: 'lib', others: [9], url: 'https://mcp.example.com/mcp' },
    { kind: 'oauth', others: [], url: '' },
    { kind: 'oauth', others: [1, 9], url: '' },
  ];
  for (const { kind, others, url } of cases) {
    const label = `${kind} with ${others.join(',') || 'no'} other policies`;
    const { s, fake } = kind === 'oauth' ? await oauthSetup() : { s: await startServer({ fakeClis: true }), fake: null };
    s.claude?.script('claude/reply');
    const kevin = s.storeBot('Kevin', 'claude-cli');
    const id = kind === 'lib' ? 'lib:github' : 'oauth:fleet';
    const path = encodeURIComponent(id);
    let conn = kind === 'oauth' ? await addOAuthConnector(s, fake!, 'fleet') : null;
    if (kind === 'lib') await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
    const signIn = () => kind === 'oauth' && s.app.store.db.prepare("update oauth_connections set status = 'connected' where name = 'fleet'").run();
    signIn();
    await s.call('PATCH', `/api/connectors/${path}/policy`, { onRequest: true });
    const asked = await s.call<{ outcome: string; approval: { id: string } }>('POST', `/api/bots/${kevin.id}/connector-requests`, { connector: id }, tokenFor(s, kevin.id));
    assert.equal(asked.data.outcome, 'pending', `${label}: ${asked.text}`);
    const card = await post(s, kevin.id, { card: { v: 1, title: 'I need it', blocks: [{ type: 'connector', connectorId: id }] } });
    assert.equal(card.status, 201, card.text);
    // Something else waiting on the owner, not about a connector: it is kept as it is.
    const other = await s.call<{ approval: { id: string } }>('POST', `/api/bots/${kevin.id}/approvals`, { title: 'Post the triage to #eng' }, tokenFor(s, kevin.id));
    assert.equal(other.status, 201, other.text);
    const { home, token } = s;
    await s.stop();

    // The old server: generation 2, both records asked under it; then the connector deleted with its policy row.
    const db = new DatabaseSync(join(home, 'botons.db'));
    db.exec("delete from connector_policies");
    for (const [i, g] of others.entries()) db.prepare("insert into connector_policies (connector_id, on_request, grant_mode, generation, updated_at) values (?, 1, 'approval', ?, '2026-01-01T00:00:00.000Z')").run(`lib:other${i}`, g);
    db.prepare('update approvals set connector_generation = 2 where id = ?').run(asked.data.approval.id);
    db.prepare("update messages set meta = json_set(meta, '$.card.connector.generation', 2) where id = ?").run(card.data.message.id);
    if (kind === 'lib') db.exec("delete from mcp_servers where name = 'github'");
    else db.exec("delete from oauth_connections where name = 'fleet'");
    db.close();

    const s2 = await startServer({ fakeClis: true, home, token, ...(kind === 'oauth' ? { env: OAUTH_ENV } : {}) });
    // Added again under the same name and put on request, then changed until a counter from 1 would be back at 2.
    if (kind === 'lib') assert.equal((await s2.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url })).status, 201);
    else conn = await addOAuthConnector(s2, fake!, 'fleet');
    if (kind === 'oauth') s2.app.store.db.prepare("update oauth_connections set status = 'connected' where name = 'fleet'").run();
    await s2.call('PATCH', `/api/connectors/${path}/policy`, { onRequest: true });
    await s2.call('PATCH', `/api/connectors/${path}/policy`, { grant: 'approval' });
    for (const enabled of [false, true]) await s2.call('PUT', `/api/connectors/${path}/enabled`, { enabled, expected: { enabled: !enabled, botIds: [], running: [] } });
    const generations = s2.app.store.db.prepare('select connector_id, generation from connector_policies').all() as { connector_id: string; generation: number }[];
    assert.ok(generations.every((r) => r.generation < 0), `${label}: ${JSON.stringify(generations)}`);

    const allowed = await s2.call<{ error?: string }>('POST', `/api/approvals/${asked.data.approval.id}/decide`, { decision: 'allow' });
    assert.equal(allowed.status, 409, `${label}: ${allowed.text}`);
    assert.match(allowed.data.error!, /can't be matched to .* as it is set up now .* has to ask for it again, so this request was withdrawn/);
    const clicked = await answer(s2, kevin.id, card.data.message.id, { action: 'grant' });
    assert.equal(clicked.status, 409, `${label}: ${clicked.text}`);
    assert.match(clicked.data.error!, /has to ask for it again/);
    assert.equal(s2.app.store.findMessage(card.data.message.id)!.meta?.card?.status, 'refused');
    assert.deepEqual(s2.app.store.getBot(kevin.id).connections, [], label);
    assert.equal((await audits(s2, 'boton.permissions_changed')).length, 0, label);
    assert.equal((await s2.call<{ status: string }>('GET', `/api/approvals/${other.data.approval.id}`)).data.status, 'pending', `${label}: the other approval is kept`);

    // Asked again now: allowed.
    const again = await s2.call<{ outcome: string; approval: { id: string } }>('POST', `/api/bots/${kevin.id}/connector-requests`, { connector: id }, tokenFor(s2, kevin.id));
    assert.equal(again.data.outcome, 'pending', again.text);
    assert.equal((await s2.call('POST', `/api/approvals/${again.data.approval.id}/decide`, { decision: 'allow' })).status, 200, label);
    assert.deepEqual(s2.app.store.getBot(kevin.id).connections, [id], label);
    assert.ok(conn || kind === 'lib');
    await s2.stop();
  }
});

test('a policy still there with a generation not issued now gets one at start: what was asked under it waits for a new request, what is asked after is allowed', async () => {
  const s = await startServer({ fakeClis: true });
  const kevin = s.storeBot('Kevin', 'claude-cli');
  await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true });
  const asked = await s.call<{ approval: { id: string } }>('POST', `/api/bots/${kevin.id}/connector-requests`, { connector: 'lib:github' }, tokenFor(s, kevin.id));
  const { home, token } = s;
  await s.stop();
  const db = new DatabaseSync(join(home, 'botons.db'));
  db.exec("update connector_policies set generation = 3; update approvals set connector_generation = 3 where kind = 'connector'");
  const nulls = db.prepare("select count(*) as n from approvals where connector_generation is null and kind = 'connector'").get() as { n: number };
  assert.equal(Number(nulls.n), 0);
  db.close();

  const s2 = await startServer({ fakeClis: true, home, token });
  const g = (s2.app.store.db.prepare("select generation from connector_policies where connector_id = 'lib:github'").get() as { generation: number }).generation;
  assert.ok(g < 0, String(g));
  // Same connector, same setup, never deleted: still not allowed, as nothing tells this 3 from a 3 of a deleted one.
  const allowed = await s2.call<{ error?: string }>('POST', `/api/approvals/${asked.data.approval.id}/decide`, { decision: 'allow' });
  assert.equal(allowed.status, 409, allowed.text);
  assert.match(allowed.data.error!, /has to ask for it again/);
  // One with none recorded is refused the same way.
  s2.app.store.db.prepare("update approvals set status = 'pending', connector_generation = null where id = ?").run(asked.data.approval.id);
  assert.equal((await s2.call('POST', `/api/approvals/${asked.data.approval.id}/decide`, { decision: 'allow' })).status, 409);
  assert.deepEqual(s2.app.store.getBot(kevin.id).connections, []);
  const again = await s2.call<{ approval: { id: string } }>('POST', `/api/bots/${kevin.id}/connector-requests`, { connector: 'lib:github' }, tokenFor(s2, kevin.id));
  assert.equal((await s2.call('POST', `/api/approvals/${again.data.approval.id}/decide`, { decision: 'allow' })).status, 200);
  assert.deepEqual(s2.app.store.getBot(kevin.id).connections, ['lib:github']);
  // A restart issues nothing new for a policy already issued: what is waiting stays allowable.
  await s2.stop();
  const s3 = await startServer({ fakeClis: true, home, token });
  assert.equal((s3.app.store.db.prepare("select generation from connector_policies where connector_id = 'lib:github'").get() as { generation: number }).generation, g);
});

test('generations are never issued twice for a connector: every change, switch, deletion and addition goes below every one before', async () => {
  const s = await startServer({ fakeClis: true });
  const seen = new Map<string, Set<number>>();
  const note = () => {
    for (const r of s.app.store.db.prepare('select connector_id, generation from connector_policies').all() as { connector_id: string; generation: number }[]) {
      const set = seen.get(r.connector_id) ?? new Set<number>();
      seen.set(r.connector_id, set);
      set.add(r.generation);
    }
  };
  let issued = 0;
  const lowest = () => Number((s.app.store.db.prepare('select min(generation) as g from connector_policies').get() as { g: number }).g);
  for (let round = 0; round < 3; round++) {
    for (const name of ['github', 'linear']) {
      const path = `lib%3A${name}`;
      await s.call('POST', '/api/mcp-servers', { name, transport: 'http', url: `https://${round}.example.com/mcp` });
      for (const body of [{ onRequest: true }, { grant: 'immediate' }, { grant: 'approval' }]) {
        const before = lowest();
        await s.call('PATCH', `/api/connectors/${path}/policy`, body);
        assert.ok(lowest() < (Number.isNaN(before) ? 0 : before));
        issued++;
        note();
      }
      for (const enabled of [false, true]) {
        await s.call('PUT', `/api/connectors/${path}/enabled`, { enabled, expected: { enabled: !enabled, botIds: [], running: [] } });
        note();
      }
      assert.equal((await s.call('DELETE', `/api/mcp-servers/${name}`)).status, 200);
      note();
      issued += 3;
    }
  }
  assert.equal([...seen.values()].reduce((n, set) => n + set.size, 0), issued, 'every one issued once, and kept for its connector only');
});

test('a connector card and the connector turned off: refused at the post and at the click, and off then on again still voids an old card', async () => {
  const s = await startServer({ fakeClis: true });
  s.claude.script('claude/reply');
  const kevin = s.storeBot('Kevin', 'claude-cli');
  const card = { v: 1, title: 'I need GitHub', blocks: [{ type: 'connector', connectorId: 'lib:github' }] };
  const switchTo = async (enabled: boolean) => {
    const r = await s.call('PUT', '/api/connectors/lib%3Agithub/enabled', { enabled, expected: { enabled: !enabled, botIds: [], running: [] } });
    assert.equal(r.status, 200, r.text);
  };
  await s.call('POST', '/api/mcp-servers', { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp' });
  await s.call('PATCH', '/api/connectors/lib%3Agithub/policy', { onRequest: true });

  // Off: a card can't ask for it.
  await switchTo(false);
  const whileOff = await post(s, kevin.id, { card });
  assert.equal(whileOff.status, 403, whileOff.text);
  assert.match(whileOff.data.error!, /turned off/);

  // Posted while on, turned off before the click: refused, closed, nothing given.
  await switchTo(true);
  const posted = await post(s, kevin.id, { card });
  assert.equal(posted.status, 201, posted.text);
  await switchTo(false);
  const click = await answer(s, kevin.id, posted.data.message.id, { action: 'grant' });
  assert.equal(click.status, 409, click.text);
  assert.match(click.data.error!, /turned off/);
  assert.equal(s.app.store.findMessage(posted.data.message.id)!.meta?.card?.status, 'refused');
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);

  // Posted while on, turned off and on again before the click: the card was asked under the old policy.
  await switchTo(true);
  const before = await post(s, kevin.id, { card });
  assert.equal(before.status, 201, before.text);
  await switchTo(false);
  await switchTo(true);
  const stale = await answer(s, kevin.id, before.data.message.id, { action: 'grant' });
  assert.equal(stale.status, 409, stale.text);
  assert.match(stale.data.error!, /changed since the request was made/);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, []);
  assert.equal((await audits(s, 'boton.permissions_changed')).length, 0);

  // On throughout: given.
  const now = await post(s, kevin.id, { card });
  assert.equal((await answer(s, kevin.id, now.data.message.id, { action: 'grant' })).status, 200);
  assert.deepEqual(s.app.store.getBot(kevin.id).connections, ['lib:github']);
});
