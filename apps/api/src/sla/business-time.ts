/**
 * Business-time arithmetic for SLA timers (ADR 0014): adding business minutes
 * to an instant and counting the business minutes between two instants, in a
 * time zone with weekly open windows and holidays. Pure functions; DST-safe
 * because every local time is converted to UTC through the zone's own offset.
 */

export interface Hours {
  timezone: string;
  /** Open windows per weekday (0 = Sunday), "HH:MM" local time. Empty = always open. */
  schedule: Array<{ day: number; start: string; end: string }>;
  /** Local dates (YYYY-MM-DD) that are closed all day. */
  holidays: ReadonlySet<string>;
}

export const ALWAYS_OPEN: Hours = { timezone: 'UTC', schedule: [], holidays: new Set() };

const MINUTE = 60_000;
/** Far enough for a 90-day resolution target on a one-day-a-week schedule. */
const MAX_DAYS = 800;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The zone's wall-clock fields at an instant. */
function localParts(ms: number, tz: string) {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return p;
}

/** Offset of the zone from UTC at an instant, in minutes (local = UTC + offset). */
function offsetMinutes(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** The instant a local wall-clock time happens in a zone (the later one in a DST gap). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMinutes(guess, tz) * MINUTE;
  const second = guess - offsetMinutes(first, tz) * MINUTE;
  return second;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (s: string) => s.split(':').map(Number) as [number, number];

/** Open intervals [start, end) in UTC ms for the local calendar day `offset` days after `fromMs`'s local day. */
function dayIntervals(fromMs: number, offset: number, h: Hours): Array<[number, number]> {
  const p = localParts(fromMs, h.timezone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  const d = day.getUTCDate();
  if (h.holidays.has(`${y}-${pad(m)}-${pad(d)}`)) return [];
  return h.schedule
    .filter((w) => w.day === day.getUTCDay())
    .map((w) => {
      const [sh, sm] = hm(w.start);
      const [eh, em] = hm(w.end);
      return [zonedToUtc(y, m, d, sh, sm, h.timezone), zonedToUtc(y, m, d, eh, em, h.timezone)] as [
        number,
        number,
      ];
    })
    .sort((a, b) => a[0] - b[0]);
}

/** The instant after `minutes` business minutes from `start`. */
export function addBusinessMinutes(start: Date, minutes: number, h: Hours): Date {
  if (minutes <= 0) return new Date(start);
  if (!h.schedule.length) return new Date(start.getTime() + minutes * MINUTE);
  let remaining = minutes;
  const from = start.getTime();
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [ws, we] of dayIntervals(from, i, h)) {
      const s = Math.max(ws, from);
      if (s >= we) continue;
      const available = (we - s) / MINUTE;
      if (available >= remaining) return new Date(s + remaining * MINUTE);
      remaining -= available;
    }
  }
  throw new Error('The business hours never open');
}

/** Business minutes between two instants (0 when `end` is not after `start`). */
export function businessMinutesBetween(start: Date, end: Date, h: Hours): number {
  const a = start.getTime();
  const b = end.getTime();
  if (b <= a) return 0;
  if (!h.schedule.length) return Math.round((b - a) / MINUTE);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    const windows = dayIntervals(a, i, h);
    for (const [ws, we] of windows) {
      const s = Math.max(ws, a);
      const e = Math.min(we, b);
      if (e > s) total += (e - s) / MINUTE;
    }
    // Stop once the day being looked at starts after `end`.
    const p = localParts(a, h.timezone);
    const nextDay = zonedToUtc(p.year, p.month, p.day + i + 1, 0, 0, h.timezone);
    if (nextDay >= b) break;
  }
  return Math.round(total);
}
