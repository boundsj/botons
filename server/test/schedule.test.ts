import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPastOneOff } from '../../shared/util.ts';
import { describeSchedule, nextRun, parseSchedule, toSpec } from '../src/schedule.ts';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-11-04T12:00:00Z'); // 4:00 AM PST, Wednesday
const spec = (s: string) => toSpec(parseSchedule(s, TZ, NOW));

test('parses natural and cron forms into specs, and refuses junk, too-frequent schedules and one-offs in the past', () => {
  const specs = [
    ['0 8 * * 1-5', 'cron 0 8 * * 1-5'], ['cron 30 7 * * *', 'cron 30 7 * * *'], ['every 30m', 'every 30m'], ['every 2 hours', 'every 120m'], ['every 1d', 'every 1440m'],
    ['daily at 8:00', 'cron 0 8 * * *'], ['daily at 3am', 'cron 0 3 * * *'], ['weekdays at 7:30am', 'cron 30 7 * * 1-5'], ['mondays at 9pm', 'cron 0 21 * * 1'],
    ['hourly', 'cron 0 * * * *'], ['in 10m', 'once 2026-11-04T12:10:00.000Z'],
    // 9:00 in Los Angeles on Nov 5 2026 (PST, UTC-8) is 17:00Z.
    ['at 2026-11-05 09:00', 'once 2026-11-05T17:00:00.000Z'], ['once 2026-11-05T09:00', 'once 2026-11-05T17:00:00.000Z'], ['at 2026-11-04 05:00', 'once 2026-11-04T13:00:00.000Z'],
  ];
  for (const [text, want] of specs) assert.equal(spec(text), want, text);

  assert.throws(() => spec('whenever you feel like it'), /Couldn't understand/);
  assert.throws(() => spec('every 0m'), /at least one minute/);
  assert.throws(() => spec('* * * * * *'), /at least one minute/);
  assert.throws(() => spec('61 * * * *'), /Invalid cron/);
  assert.throws(() => spec('at 2026-11-03 09:00'), /has already passed/);
  assert.throws(() => spec('2026-11-04T03:00'), /has already passed/);
  assert.throws(() => spec('once 2026-11-04T11:59:00Z'), /has already passed/);
});

test('next runs are in the routine timezone; isPastOneOff spots one-offs whose time has come', () => {
  assert.equal(nextRun('cron 0 8 * * 1-5', TZ, NOW)?.toISOString(), '2026-11-04T16:00:00.000Z');
  assert.equal(nextRun('every 30m', TZ, NOW)?.toISOString(), '2026-11-04T12:30:00.000Z');
  assert.equal(nextRun('once 2026-11-04T11:00:00.000Z', TZ, NOW), null);
  assert.equal(isPastOneOff('once 2026-11-04T11:00:00.000Z', NOW), true);
  assert.equal(isPastOneOff('once 2026-11-04T12:00:00.000Z', NOW), true);
  assert.equal(isPastOneOff('once 2026-11-04T13:00:00.000Z', NOW), false);
  assert.equal(isPastOneOff('every 30m', NOW), false);
  assert.equal(isPastOneOff(null, NOW), false);
});

test('describes schedules for people', () => {
  const described = [
    ['cron 0 8 * * 1-5', 'Weekdays at 8:00 AM'], ['cron 30 18 * * *', 'Every day at 6:30 PM'], ['cron 0 9 * * 1', 'Mondays at 9:00 AM'],
    ['every 120m', 'Every 2 hours'], ['every 1m', 'Every minute'], ['cron */15 * * * *', 'Every 15 minutes'],
  ];
  for (const [stored, want] of described) assert.equal(describeSchedule(stored, TZ), want, stored);
});
