import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, ApiError, OfflineError } from '../../web/src/api.ts';
import { attempt, dismissToast, errorText, sendError, toastStore } from '../../web/src/feedback.ts';
import type { BrainState, ProviderInfo } from '../../shared/types.ts';
import { readyInstead } from '../../web/src/brains.ts';
import { BURST_GAP_MS, cachedFormatters, clock, dateTime, dayLabel, isValidTimezone, localDay, timeMarks, type LimitUnit, limitBounds, limitFrom, limitInput, timezones } from '../../web/src/util.ts';

test('timezone helpers accept real zones and never throw on half-typed ones', () => {
  assert.equal(isValidTimezone('America/New_York'), true);
  for (const bad of ['', 'America/New_Yrok', 'America/', 'Not a zone']) {
    assert.equal(isValidTimezone(bad), false, bad);
    assert.doesNotThrow(() => dateTime('2026-11-05T13:00:00.000Z', bad));
    assert.doesNotThrow(() => clock('2026-11-05T13:00:00.000Z', bad));
  }
  assert.match(dateTime('2026-11-05T13:00:00.000Z', 'Asia/Tokyo'), /\b(10:00|22:00)\b/);
  const zones = timezones();
  assert.ok(zones.includes('UTC') && zones.includes('America/New_York'));
  assert.ok(zones.every(isValidTimezone));
});

test('times read the same as toLocaleString with the same options, in the browser zone or a chosen one', () => {
  for (const iso of ['2026-11-05T13:00:00.000Z', '2026-03-29T00:30:00.000Z', '2024-02-29T23:59:00.000Z']) {
    const d = new Date(iso);
    for (const tz of [undefined, 'UTC', 'Asia/Tokyo', 'America/New_York', 'Not a zone']) {
      const zone = tz && isValidTimezone(tz) ? tz : undefined;
      assert.equal(clock(iso, tz), d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: zone }), `${iso} ${tz}`);
      assert.equal(dateTime(iso, tz), d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }), `${iso} ${tz}`);
    }
    const thisYear = d.getFullYear() === new Date().getFullYear();
    if (Date.now() - d.getTime() > 2 * 86_400_000) assert.equal(dayLabel(iso), d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: thisYear ? undefined : 'numeric' }));
  }
  assert.equal(dayLabel(new Date().toISOString()), 'Today');
});

test('day labels count calendar days in the browser zone: Today, Yesterday (across a clock change too), then the date', () => {
  const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi);
  const now = at(2026, 10, 7, 0, 30);
  assert.equal(dayLabel(at(2026, 10, 7, 0, 5).toISOString(), now), 'Today');
  // Under an hour ago, and still yesterday.
  assert.equal(dayLabel(at(2026, 10, 6, 23, 50).toISOString(), now), 'Yesterday');
  assert.equal(dayLabel(at(2026, 10, 6, 0, 1).toISOString(), now), 'Yesterday');
  const older = at(2026, 10, 5, 9);
  assert.equal(dayLabel(older.toISOString(), now), older.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
  const lastYear = at(2025, 10, 6, 9);
  assert.equal(dayLabel(lastYear.toISOString(), now), lastYear.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }));
  // The day after the clocks change (late March, early November in many zones): midnight to midnight is not 24 hours.
  for (const [y, mo, d] of [[2026, 2, 30], [2026, 9, 26], [2026, 10, 2], [2026, 2, 9]] as const) {
    assert.equal(dayLabel(at(y, mo, d - 1, 0, 10).toISOString(), at(y, mo, d, 23, 50)), 'Yesterday', `${y}-${mo + 1}-${d}`);
    assert.equal(dayLabel(at(y, mo, d - 1, 23, 59).toISOString(), at(y, mo, d, 0, 1)), 'Yesterday', `${y}-${mo + 1}-${d}`);
  }
  assert.equal(localDay(at(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('the chat marks a new day and a burst from the message before it in the window', () => {
  const t = (h: number, mi: number, d = 6) => new Date(2026, 10, d, h, mi).toISOString();
  assert.deepEqual(timeMarks(undefined, t(9, 0)), { day: true, time: true }, 'the first message loaded');
  assert.deepEqual(timeMarks(t(9, 0), t(9, 1)), { day: false, time: false });
  assert.deepEqual(timeMarks(t(9, 0), t(9, 30)), { day: false, time: false }, 'exactly the gap is the same burst');
  assert.equal(BURST_GAP_MS, 30 * 60_000);
  assert.deepEqual(timeMarks(t(9, 0), t(9, 31)), { day: false, time: true }, 'a longer pause starts one');
  assert.deepEqual(timeMarks(t(23, 55), t(0, 2, 7)), { day: true, time: true }, 'past midnight, however short the pause');
});

test('the time formatters stay a bounded cache however many zones are typed', () => {
  const iso = '2026-11-05T13:00:00.000Z';
  for (const tz of timezones().slice(0, 200)) {
    assert.equal(clock(iso, tz), new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz }));
    clock(iso, `${tz}x`);
  }
  assert.ok(cachedFormatters() <= 32, `${cachedFormatters()} formatters`);
});

test('a brain at its usage limit points to the other brains confirmed ready now, never the mock or one not confirmed', () => {
  const brain = (id: string, state: BrainState = 'ready') =>
    ({ id, label: id, available: true, loggedIn: true, usageLimit: null, readiness: { state, problem: null, checkedAt: null, usageLimitUntil: null, generation: 1 } }) as ProviderInfo;
  const claude = brain('claude', 'usage-limited');
  assert.deepEqual(readyInstead(claude, [claude, brain('codex'), brain('mock')]).map((p) => p.id), ['codex']);
  for (const state of ['unknown', 'signed-out', 'not-installed', 'unavailable', 'usage-limited'] as const) assert.deepEqual(readyInstead(claude, [claude, brain('codex', state)]), [], state);
});

test('attempt: a failed one-off action says what failed, in a toast or where the caller shows it', async () => {
  assert.equal(await attempt('do nothing', async () => {}), true);
  assert.deepEqual(toastStore.get(), []);

  assert.equal(await attempt('forget that', () => Promise.reject(new Error('Server unreachable'))), false);
  const [toast] = toastStore.get();
  assert.equal(toast.kind, 'error');
  assert.equal(toast.text, "Couldn't forget that: Server unreachable");
  dismissToast(toast.id);
  assert.deepEqual(toastStore.get(), []);

  const shown: string[] = [];
  assert.equal(await attempt('make a new key', () => Promise.reject(new Error('No routine with id rt_x')), (m) => shown.push(m)), false);
  assert.deepEqual(shown, ["Couldn't make a new key: No routine with id rt_x"]);
  assert.deepEqual(toastStore.get(), []);
});

test('a send that never reached the server says so in plain words; an aborted one stays an abort; a refused one says why', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const offline = await api.send('bot_x', 'hello').catch((e: unknown) => e);
  assert.ok(offline instanceof OfflineError, String(offline));
  assert.doesNotMatch(errorText(offline), /fetch/i);
  const text = "Couldn't reach the server, so your message wasn't sent. It's still in the box, ready to send again.";
  assert.deepEqual(sendError(offline), { text, offline: true });

  globalThis.fetch = () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  const aborted = await api.send('bot_x', 'hello').catch((e: unknown) => e);
  assert.ok(aborted instanceof DOMException && aborted.name === 'AbortError');

  globalThis.fetch = async () => Response.json({ error: 'Server is restarting; try again in a minute' }, { status: 503 });
  const refused = await api.send('bot_x', 'hello').catch((e: unknown) => e);
  assert.ok(refused instanceof ApiError && refused.status === 503);
  assert.deepEqual(sendError(refused), { text: "Couldn't send: Server is restarting; try again in a minute", offline: false });
});

test("a routine time limit's field shows a saved limit exactly, its bounds are the server's, and nothing in them saves past its limit", () => {
  // Shown as saved, and read back to the same ms: whole minutes, seconds, and limits below a minute.
  for (const ms of [1000, 1001, 1500, 30_000, 59_999, 60_000, 90_000, 600_000, 20 * 60_000, 2 * 3_600_000 + 1]) {
    const shown = limitInput(ms);
    assert.deepEqual(limitFrom(shown.amount, shown.unit, 3 * 3_600_000), { ms }, `${ms} as ${shown.amount} ${shown.unit}`);
  }
  assert.deepEqual(limitInput(1000), { amount: '1', unit: 'seconds' });
  assert.deepEqual(limitInput(10 * 60_000), { amount: '10', unit: 'minutes' });

  // A 1 second server limit: the only limit is 1 second, and the field's own bounds allow exactly that.
  assert.deepEqual(limitBounds('seconds', 1000), { min: 1, max: 1 });
  assert.deepEqual(limitFrom('1', 'seconds', 1000), { ms: 1000 });
  for (const [amount, unit] of [['0.6', 'seconds'], ['1.001', 'seconds'], ['0.01', 'minutes'], ['0.017', 'minutes'], ['0', 'seconds'], ['', 'minutes'], ['abc', 'seconds']] as const) {
    assert.ok('error' in limitFrom(amount, unit, 1000), `${amount} ${unit}`);
  }
  const { min, max } = limitBounds('minutes', 1000);
  assert.deepEqual(limitFrom(String(max), 'minutes', 1000), { ms: 1000 });
  assert.equal(min, max);

  // Any amount within the native bounds is one the server takes, at the cap and at the floor, in either unit.
  for (const serverMs of [1000, 1500, 59_999, 60_000, 20 * 60_000, 7_777_777]) {
    for (const unit of ['seconds', 'minutes'] as LimitUnit[]) {
      const b = limitBounds(unit, serverMs);
      for (const n of [b.min, b.max!, (b.min + b.max!) / 2, b.max! * (1 - 1e-12)]) {
        const r = limitFrom(String(n), unit, serverMs);
        assert.ok('ms' in r && r.ms >= 1000 && r.ms <= serverMs && Number.isInteger(r.ms), `${n} ${unit} of ${serverMs}: ${JSON.stringify(r)}`);
      }
      const over = limitFrom(String(b.max! * (1 + 1e-9) + (unit === 'seconds' ? 0.001 : 0.0001)), unit, serverMs);
      assert.ok('error' in over, `just past ${serverMs} in ${unit}`);
    }
  }
  assert.match((limitFrom('21', 'minutes', 20 * 60_000) as { error: string }).error, /Between 1 second and 20 minutes/);
  assert.equal((limitFrom('2', 'seconds', 1000) as { error: string }).error, "1 second: the server's limit.");
});
