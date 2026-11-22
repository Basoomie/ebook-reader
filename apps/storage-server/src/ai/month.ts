/**
 * Calendar months in a time zone, for the monthly spending limit: a month starts on the 1st at
 * 00:00 local time (the Notifications time zone, default the server's). Works across daylight
 * saving changes: the instant is found from the zone's own offset at that time.
 */

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(ms: number, timeZone: string): Parts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms)))
    if (p.type !== 'literal' && p.type !== 'dayPeriod') out[p.type] = Number(p.value);
  return out as unknown as Parts;
}

/** The zone's offset from UTC at an instant (ms; Denver in winter: -7 h). */
function offsetAt(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant of a local midnight on year-month-01 in the zone. */
function localMonthStart(year: number, month: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, 1);
  // Two rounds settle an offset that differs on either side of a daylight saving change.
  let t = wall - offsetAt(wall, timeZone);
  t = wall - offsetAt(t, timeZone);
  return t;
}

/** The month containing `ms` in the zone: its key (YYYY-MM), start and end (exclusive). */
export function monthOf(ms: number, timeZone: string): { key: string; start: number; end: number } {
  const p = parts(ms, timeZone);
  const start = localMonthStart(p.year, p.month, timeZone);
  const next = p.month === 12 ? [p.year + 1, 1] : [p.year, p.month + 1];
  const end = localMonthStart(next[0], next[1], timeZone);
  return { key: `${p.year}-${String(p.month).padStart(2, '0')}`, start, end };
}
