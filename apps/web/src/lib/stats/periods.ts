/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Stats periods (WP12b). Pure date math on day keys (YYYY-MM-DD), done in UTC so
 * daylight-saving changes never shift a day. "Today" comes from the caller, already
 * under the global day boundary (`getDateKey(startDayHoursForTracker)`).
 * Weeks start on the global week start (0 = Sunday … 6 = Saturday); months are
 * calendar months.
 */

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

export const PERIOD_KINDS: { kind: Exclude<PeriodKind, 'custom'>; label: string }[] = [
  { kind: 'day', label: 'Day' },
  { kind: 'week', label: 'Week' },
  { kind: 'month', label: 'Month' },
  { kind: 'year', label: 'Year' },
  { kind: 'all', label: 'All' }
];

export interface StatsPeriod {
  kind: PeriodKind;
  /** First day (inclusive); null = from the beginning. */
  from: string | null;
  /** Last day (inclusive); null = no end. */
  to: string | null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
];

export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtc(day: string): Date {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Not a day key: ${day}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function fromUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${d}`;
}

export function addDays(day: string, days: number): string {
  const d = toUtc(day);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: string): number {
  return toUtc(day).getUTCDay();
}

/** Days from `from` to `to`, both included (0 when `to` is before `from`). */
export function daysBetween(from: string, to: string): number {
  const ms = toUtc(to).getTime() - toUtc(from).getTime();
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

export function normalizeWeekStart(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

/** The period of `kind` that contains `day`. */
export function periodContaining(
  kind: Exclude<PeriodKind, 'custom'>,
  day: string,
  weekStart: number
): StatsPeriod {
  const d = toUtc(day);
  switch (kind) {
    case 'day':
      return { kind, from: day, to: day };
    case 'week': {
      const back = (weekdayOf(day) - normalizeWeekStart(weekStart) + 7) % 7;
      const from = addDays(day, -back);
      return { kind, from, to: addDays(from, 6) };
    }
    case 'month': {
      const from = fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
      const to = fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
      return { kind, from, to };
    }
    case 'year':
      return { kind, from: `${day.slice(0, 4)}-01-01`, to: `${day.slice(0, 4)}-12-31` };
    case 'all':
    default:
      return { kind: 'all', from: null, to: null };
  }
}

/** The previous (-1) or next (+1) period of the same kind. Custom ranges move by their length. */
export function stepPeriod(period: StatsPeriod, direction: -1 | 1, weekStart: number): StatsPeriod {
  if (period.kind === 'all' || !period.from || !period.to) return period;
  if (period.kind === 'custom') {
    const length = daysBetween(period.from, period.to);
    return {
      kind: 'custom',
      from: addDays(period.from, direction * length),
      to: addDays(period.to, direction * length)
    };
  }
  const anchor = direction < 0 ? addDays(period.from, -1) : addDays(period.to, 1);
  return periodContaining(period.kind, anchor, weekStart);
}

/** A custom range, the two days put in order. */
export function customPeriod(a: string, b: string): StatsPeriod {
  return a <= b ? { kind: 'custom', from: a, to: b } : { kind: 'custom', from: b, to: a };
}

export function inPeriod(day: string, period: StatsPeriod): boolean {
  return (!period.from || day >= period.from) && (!period.to || day <= period.to);
}

function shortDate(day: string, withYear: boolean): string {
  const d = toUtc(day);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

/** "Thu 12 Nov 2026", "9 – 15 Nov 2026", "November 2026", "2026", "All time". */
export function periodLabel(period: StatsPeriod): string {
  if (period.kind === 'all' || !period.from || !period.to) return 'All time';
  const from = toUtc(period.from);
  switch (period.kind) {
    case 'day':
      return `${WEEKDAYS[from.getUTCDay()]} ${shortDate(period.from, true)}`;
    case 'month':
      return `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
    case 'year':
      return String(from.getUTCFullYear());
    default: {
      if (period.from === period.to) return shortDate(period.from, true);
      const sameYear = period.from.slice(0, 4) === period.to.slice(0, 4);
      const sameMonth = sameYear && period.from.slice(5, 7) === period.to.slice(5, 7);
      const start = sameMonth ? String(from.getUTCDate()) : shortDate(period.from, !sameYear);
      return `${start} – ${shortDate(period.to, true)}`;
    }
  }
}

/** The period as an address value: "week:2026-11-09", "all", "custom:2026-11-01~2026-11-12". */
export function periodToParam(period: StatsPeriod): string {
  if (period.kind === 'all' || !period.from) return 'all';
  if (period.kind === 'custom') return `custom:${period.from}~${period.to}`;
  return `${period.kind}:${period.from}`;
}

/** Reads `periodToParam`'s value; anything unreadable gives the week containing today. */
export function periodFromParam(
  value: string | null,
  today: string,
  weekStart: number
): StatsPeriod {
  if (value === 'all') return { kind: 'all', from: null, to: null };
  const [kind, rest] = (value ?? '').split(':');
  if (kind === 'custom') {
    const [a, b] = (rest ?? '').split('~');
    if (isDayKey(a) && isDayKey(b)) return customPeriod(a, b);
  } else if (
    (kind === 'day' || kind === 'week' || kind === 'month' || kind === 'year') &&
    isDayKey(rest)
  ) {
    return periodContaining(kind, rest, weekStart);
  }
  return periodContaining('week', today, weekStart);
}
