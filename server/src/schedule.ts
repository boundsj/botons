import { Cron } from 'croner';

type Schedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'every'; minutes: number }
  | { kind: 'once'; at: Date };

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SCHEDULE_HELP =
  'Use a 5-field cron expression like "0 8 * * 1-5", "every 30m" / "every 2h" / "every 1d", ' +
  '"daily at 8:00", "weekdays at 7:30am", "mondays at 9am", "in 10m", or "at 2026-11-05 09:00".';

export function parseSchedule(input: string, tz: string, now = new Date()): Schedule {
  const s = parseAny(input, tz, now);
  if (s.kind === 'once' && s.at.getTime() <= now.getTime()) {
    throw new Error(`"${input.trim()}" (${describeSchedule(toSpec(s), tz).replace(/^Once, /, '')}) has already passed. A one-off routine needs a time in the future.`);
  }
  return s;
}

function parseAny(input: string, tz: string, now: Date): Schedule {
  const raw = input.trim();
  const s = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!s) throw new Error(`Empty schedule. ${SCHEDULE_HELP}`);

  if (s.startsWith('cron ') || s.startsWith('cron:')) return cron(raw.slice(5).trim(), tz);
  if (/^every \d/.test(s)) return { kind: 'every', minutes: parseDuration(s.slice(6), raw) };
  if (s === 'every minute') return { kind: 'every', minutes: 1 };
  if (s === 'hourly' || s === 'every hour') return cron('0 * * * *', tz);
  if (s.startsWith('once ')) return parseAny(raw.replace(/^once\s+/i, 'at '), tz, now);
  if (s.startsWith('in ')) return { kind: 'once', at: new Date(now.getTime() + parseDuration(s.slice(3), raw) * 60_000) };
  if (s.startsWith('at ') && /\d{4}-\d{2}-\d{2}/.test(s)) return { kind: 'once', at: parseDateTime(raw.slice(3).trim(), tz) };

  const timed = /^(?:every )?(day|daily|weekday|weekdays|weekend|weekends|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s? at (.+)$/.exec(
    s.replace(/^daily at/, 'day at'),
  );
  if (timed) {
    const { h, m } = parseClock(timed[2], raw);
    const word = timed[1];
    let dow = '*';
    if (word.startsWith('weekday')) dow = '1-5';
    else if (word.startsWith('weekend')) dow = '0,6';
    else if (DAYS.includes(word)) dow = String(DAYS.indexOf(word));
    return cron(`${m} ${h} * * ${dow}`, tz);
  }

  // Bare cron: numeric-ish minute and hour fields rule out ordinary words.
  const fields = raw.split(/\s+/);
  if ((fields.length === 5 || fields.length === 6) && fields.slice(0, 2).every((f) => /^[\d*/,\-]+$/.test(f))) return cron(raw, tz);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { kind: 'once', at: parseDateTime(raw, tz) };

  throw new Error(`Couldn't understand schedule "${raw}". ${SCHEDULE_HELP}`);
}

function cron(expr: string, tz: string): Schedule {
  let job: Cron;
  try {
    job = new Cron(expr, { timezone: tz, paused: true });
  } catch (e) {
    throw new Error(`Invalid cron expression "${expr}": ${(e as Error).message}. ${SCHEDULE_HELP}`);
  }
  const runs = job.nextRuns(2);
  if (runs.length === 2 && runs[1].getTime() - runs[0].getTime() < 60_000) {
    throw new Error('Schedules must be at least one minute apart.');
  }
  return { kind: 'cron', expr };
}

function parseDuration(text: string, raw: string): number {
  const m = /^(\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(text.trim());
  if (!m) throw new Error(`Couldn't read the interval in "${raw}". ${SCHEDULE_HELP}`);
  const n = Number(m[1]);
  const unit = m[2][0];
  const minutes = Math.round(unit === 'm' ? n : unit === 'h' ? n * 60 : n * 1440);
  if (minutes < 1) throw new Error('Schedules must be at least one minute apart.');
  return minutes;
}

function parseClock(text: string, raw: string): { h: number; m: number } {
  const m = /^(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?$/.exec(text.trim());
  if (!m) throw new Error(`Couldn't read the time in "${raw}". ${SCHEDULE_HELP}`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) throw new Error(`Invalid time in "${raw}".`);
  return { h, m: min };
}

function parseDateTime(text: string, tz: string): Date {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${text}".`);
    return d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(text.trim());
  if (!m) throw new Error(`Invalid date "${text}". Use YYYY-MM-DD HH:MM.`);
  return zonedToUtc(+m[1], +m[2], +m[3], +(m[4] ?? 9), +(m[5] ?? 0), tz);
}

function tzOffset(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(ts / 1000) * 1000;
}

export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffset(guess, tz);
  let utc = guess - off1;
  const off2 = tzOffset(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

export function toSpec(s: Schedule): string {
  if (s.kind === 'cron') return `cron ${s.expr}`;
  if (s.kind === 'every') return `every ${s.minutes}m`;
  return `once ${s.at.toISOString()}`;
}

function fromSpec(spec: string): Schedule {
  if (spec.startsWith('cron ')) return { kind: 'cron', expr: spec.slice(5) };
  if (spec.startsWith('every ')) return { kind: 'every', minutes: parseInt(spec.slice(6), 10) };
  if (spec.startsWith('once ')) return { kind: 'once', at: new Date(spec.slice(5)) };
  throw new Error(`Bad schedule spec: ${spec}`);
}

/** Strictly after `after`; null once a one-off has passed. */
export function nextRun(spec: string, tz: string, after: Date): Date | null {
  const s = fromSpec(spec);
  if (s.kind === 'cron') return new Cron(s.expr, { timezone: tz, paused: true }).nextRun(after);
  if (s.kind === 'every') return new Date(after.getTime() + s.minutes * 60_000);
  return s.at.getTime() > after.getTime() ? s.at : null;
}

export function nextRuns(spec: string, tz: string, n: number, after = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < n; i++) {
    const next = nextRun(spec, tz, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function clock(h: number, m: number): string {
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

export function describeSchedule(spec: string, tz: string): string {
  const s = fromSpec(spec);
  if (s.kind === 'every') {
    if (s.minutes % 1440 === 0) return plural(s.minutes / 1440, 'day');
    if (s.minutes % 60 === 0) return plural(s.minutes / 60, 'hour');
    return plural(s.minutes, 'minute');
  }
  if (s.kind === 'once') {
    const when = s.at.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `Once, ${when}`;
  }
  const f = s.expr.split(/\s+/);
  if (f.length !== 5) return `Cron: ${s.expr}`;
  const [min, hour, dom, mon, dow] = f;
  const num = (x: string) => /^\d+$/.test(x);
  if (num(min) && num(hour) && dom === '*' && mon === '*') {
    const at = clock(+hour, +min);
    if (dow === '*') return `Every day at ${at}`;
    if (dow === '1-5') return `Weekdays at ${at}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${at}`;
    if (/^[0-6](,[0-6])*$/.test(dow)) {
      const days = dow.split(',').map((d) => DAY_ABBR[+d]);
      return days.length === 1 ? `${DAYS[+dow][0].toUpperCase()}${DAYS[+dow].slice(1)}s at ${at}` : `${days.join(', ')} at ${at}`;
    }
  }
  if (num(min) && num(hour) && num(dom) && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${clock(+hour, +min)}`;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    if (min === '*') return 'Every minute';
    if (/^\*\/\d+$/.test(min)) return plural(+min.slice(2), 'minute');
    if (num(min)) return `Every hour at :${min.padStart(2, '0')}`;
  }
  if (num(min) && /^\*\/\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return plural(+hour.slice(2), 'hour');
  }
  return `Cron: ${s.expr}`;
}
