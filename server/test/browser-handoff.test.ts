// The browser handoff: the Boton's tool, the card's states (requested, taken, handed back, closed) and the note that
// wakes the Boton. Pure functions and a Store on a temp database: no browser, no server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BrowserHandoff, HANDOFF_REASON_MAX, HANDOFF_TTL_MS, handBackNote, handoffReason, handoffStep, requestHandoff } from '../../shared/handoff.ts';
import { BrowserHandoffs } from '../src/browser-handoff.ts';
import { actionInput, TOOLS } from '../src/cli/browser-mcp.ts';
import { loadConfig } from '../src/config.ts';
import { EventHub } from '../src/events.ts';
import type { PushRequest } from '../src/notify.ts';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const at = new Date('2026-01-05T10:00:00.000Z');
const later = (ms: number) => new Date(at.getTime() + ms).toISOString();

test('the card moves requested → taken → handed back, or requested → closed, and no other way', () => {
  const h = requestHandoff('Enter your password for example.com', 'https://example.com/login', at);
  assert.equal(h.state, 'requested');
  assert.equal(h.expiresAt, later(HANDOFF_TTL_MS));

  const taken = handoffStep(h, { type: 'take', at: later(1000), by: 'Phone' })!;
  assert.equal(taken.state, 'taken');
  assert.equal(taken.takenBy, 'Phone');
  const back = handoffStep(taken, { type: 'hand-back', at: later(2000), page: 'https://example.com/home', how: 'finished' })!;
  assert.deepEqual([back.state, back.page, back.how], ['handed-back', 'https://example.com/home', 'finished']);

  // Not from here: a request isn't handed back before it is taken, a taken one isn't taken again or closed, nothing
  // leaves handed-back or closed, and a request past its expiry can't be taken (only closed).
  const none: [BrowserHandoff, Parameters<typeof handoffStep>[1]][] = [
    [h, { type: 'hand-back', at: later(1), page: null, how: 'finished' }],
    [taken, { type: 'take', at: later(1), by: 'Laptop' }],
    [taken, { type: 'close', at: later(1), why: 'x' }],
    [back, { type: 'take', at: later(1), by: 'Phone' }],
    [back, { type: 'hand-back', at: later(1), page: null, how: 'finished' }],
    [h, { type: 'take', at: later(HANDOFF_TTL_MS), by: 'Phone' }],
  ];
  for (const [from, e] of none) assert.equal(handoffStep(from, e), null, `${from.state} + ${e.type}`);
  const closed = handoffStep(h, { type: 'close', at: later(HANDOFF_TTL_MS + 1), why: 'nobody took it in time' })!;
  assert.deepEqual([closed.state, closed.why], ['closed', 'nobody took it in time']);
  assert.equal(handoffStep(closed, { type: 'take', at: later(1), by: 'Phone' }), null);
});

test("the Boton's reason is one short clean line, and the hand-back note says where the page is in the server's words", () => {
  assert.equal(handoffReason('  Sign in\n to\u202e x.com '), 'Sign in to x.com');
  assert.ok(typeof handoffReason('') !== 'string');
  assert.ok(typeof handoffReason(42) !== 'string');
  assert.ok(typeof handoffReason('x'.repeat(HANDOFF_REASON_MAX + 1)) !== 'string');

  const h: BrowserHandoff = { ...requestHandoff('Sign in to x.com', null, at), state: 'handed-back', page: 'https://x.com/home', how: 'finished' };
  assert.match(handBackNote('Sam', h), /^\(From the Botons server: Sam finished in your browser and handed it back\. .*The page is now https:\/\/x\.com\/home/);
  assert.match(handBackNote('Sam', { ...h, how: 'nothing was sent for too long', page: null }), /Sam's turn in your browser ended \(nothing was sent for too long\)\..*No page was open\./);
});

test('browser_handoff is a tool that takes a reason, sent to the server as the handoff action', () => {
  const tool = TOOLS.find((t) => t.name === 'browser_handoff');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['reason']);
  assert.match(tool.description, /instead of telling your owner to find a setting/);
  assert.deepEqual(actionInput('browser_handoff', { reason: 'Sign in to x.com', url: 5 }), { action: 'handoff', reason: 'Sign in to x.com' });
  // The other tools point at it where the owner's step is needed.
  assert.match(TOOLS.find((t) => t.name === 'browser_type')!.description, /browser_handoff/);
});

function setup() {
  const home = tempDir('botons-handoff-');
  const store = new Store(loadConfig({ BOTONS_HOME: home, BOTONS_HOST: '127.0.0.1', BOTONS_NO_TAILSCALE: '1' }), new EventHub(), () => ({ state: 'idle', activity: null, since: null }));
  const bot = store.createBot({ name: 'Kevin', provider: 'mock' } as never, new Set(['mock']), 'mock');
  const pushes: PushRequest[] = [];
  const woken: string[] = [];
  const handoffs = new BrowserHandoffs({ store, push: async (r) => void pushes.push(r), wake: (id) => void woken.push(id) });
  const card = () => handoffs.open(bot.id)?.meta?.browserHandoff;
  return { store, bot, pushes, woken, handoffs, card };
}

test('asking posts a card and a push; taking it over and handing it back move the card, and the hand-back wakes the Boton with where the page is', () => {
  const { store, bot, pushes, woken, handoffs, card } = setup();
  const { message, already } = handoffs.request(bot.id, 'Enter your password for x.com', 'https://x.com/i/flow/login', null);
  assert.equal(already, null);
  assert.equal(message.meta?.kind, 'browser.handoff');
  assert.equal(card()?.state, 'requested');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].detail, /Your turn in Kevin's browser/);
  assert.throws(() => handoffs.request(bot.id, '', null, null), /reason/);

  handoffs.taken(bot.id, 'Phone');
  assert.equal(card()?.state, 'taken');
  // Asked again while the owner has it: the same card, no new push.
  assert.equal(handoffs.request(bot.id, 'Sign in', null, null).already, 'taken');
  assert.equal(pushes.length, 1);

  assert.equal(handoffs.handedBack(bot.id, 'https://x.com/home', 'finished'), true);
  const done = store.findMessage(message.id)!.meta!.browserHandoff!;
  assert.deepEqual([done.state, done.page, done.how], ['handed-back', 'https://x.com/home', 'finished']);
  assert.equal(handoffs.open(bot.id), null);
  assert.deepEqual(woken, [bot.id]);
  const note = store.listMessages(bot.id).at(-1)!;
  assert.equal(note.meta?.kind, 'browser.handed_back');
  assert.equal(store.hasPendingChat(bot.id), true);
  assert.match(note.text, /handed it back\. .*The page is now https:\/\/x\.com\/home/);
  // A handover that ends with nothing taken changes nothing and wakes nobody.
  assert.equal(handoffs.handedBack(bot.id, null, 'finished'), false);
  assert.equal(woken.length, 1);
});

test('a second ask replaces a waiting one; a browser turned off closes it; asked while the owner has the browser, it starts taken; a restart hands back a taken one', () => {
  const { bot, pushes, woken, handoffs, card, store } = setup();
  const first = handoffs.request(bot.id, 'Solve the captcha', null, null).message;
  handoffs.request(bot.id, 'Enter the code', null, null);
  assert.equal(store.findMessage(first.id)!.meta!.browserHandoff!.state, 'closed');
  assert.equal(card()?.reason, 'Enter the code');
  handoffs.closeWaiting(bot.id, 'its browser was turned off');
  assert.equal(handoffs.open(bot.id), null);

  const pushed = pushes.length;
  handoffs.request(bot.id, 'Sign in', null, 'Laptop');
  assert.deepEqual([card()?.state, card()?.takenBy], ['taken', 'Laptop']);
  assert.equal(pushes.length, pushed, 'no push when the owner already has it');

  handoffs.recover();
  assert.equal(handoffs.open(bot.id), null);
  assert.deepEqual(woken, [bot.id]);
  assert.match(store.listMessages(bot.id).at(-1)!.text, /the server restarted/);
});

test('recovery reaches every open handoff: a taken one behind many expired requests is still handed back, and those are closed', () => {
  const { store, bot, woken, handoffs } = setup();
  const taken = handoffs.request(bot.id, 'Sign in', null, 'Phone').message;
  const old = new Date(Date.now() - 2 * HANDOFF_TTL_MS);
  for (let i = 0; i < 60; i++) store.addMessage(bot.id, 'event', 'Your turn', { kind: 'browser.handoff', browserHandoff: requestHandoff(`Old ${i}`, null, old) });
  handoffs.recover();
  assert.equal(store.findMessage(taken.id)!.meta!.browserHandoff!.state, 'handed-back');
  assert.deepEqual(woken, [bot.id]);
  assert.equal(store.openHandoffs(bot.id).length, 0);
});
