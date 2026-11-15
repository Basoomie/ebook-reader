/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { emptyTotals, readingSpeed, type StatTotals } from '$lib/stats/aggregate';
import { formatDay, formatDuration, formatNumber } from '$lib/stats/stats-format';
import {
  addDays,
  daysBetween,
  isDayKey,
  periodLabel,
  stepPeriod,
  weekdayOf,
  type StatsPeriod
} from '$lib/stats/periods';
import type { StatsSummary, StatsView } from '$lib/stats/stats-view';

/**
 * Season 2 Phase 11: a week, month or year compared with the one before it, and the
 * charts of both. Pure: values come from `buildStatsView` (the Stats page's rules) and
 * its per-day totals.
 *
 * Decided (user, 2026-11-15):
 * - A period that is still running (today inside it) is compared with the same days of
 *   the previous period (week: as many days; month: day 1 to the same day of the month,
 *   at most the month's end; year: 1 January to the same date, 29 Feb → 28 Feb), and the
 *   previous period's whole total is shown beside it. A finished period is compared
 *   whole with whole. A period after today has no comparison.
 * - Charts: paired bars (one per day, by day of the month, or per month) and running
 *   totals; measures characters, reading time, speed and dictionary lookups.
 */

export type ComparedKind = 'week' | 'month' | 'year';
export type ComparisonState = 'running' | 'done' | 'future';

export interface PeriodComparison {
  kind: ComparedKind;
  state: ComparisonState;
  /** The period on screen. */
  period: StatsPeriod;
  /** What is compared: the period up to today when running, else the whole period. */
  current: StatsPeriod;
  /** The whole previous period. */
  previous: StatsPeriod;
  /** The previous period's same days (= `previous` unless running). */
  previousSame: StatsPeriod;
}

export function isComparedKind(kind: string): kind is ComparedKind {
  return kind === 'week' || kind === 'month' || kind === 'year';
}

/** The comparison for a week, month or year; null for any other period. */
export function periodComparison(
  period: StatsPeriod,
  today: string,
  weekStart: number
): PeriodComparison | null {
  if (!isComparedKind(period.kind) || !period.from || !period.to) return null;
  const kind = period.kind;
  const previous = stepPeriod(period, -1, weekStart);
  const base = { kind, period, previous };
  if (today > period.to) {
    return { ...base, state: 'done', current: period, previousSame: previous };
  }
  if (today < period.from) {
    return { ...base, state: 'future', current: period, previousSame: previous };
  }
  return {
    ...base,
    state: 'running',
    current: { kind: 'custom', from: period.from, to: today },
    previousSame: {
      kind: 'custom',
      from: previous.from,
      to: sameDayBefore(kind, period, previous, today)
    }
  };
}

/** The last day of the previous period's "same days" for `today` in `period`. */
function sameDayBefore(
  kind: ComparedKind,
  period: StatsPeriod,
  previous: StatsPeriod,
  today: string
): string {
  const prevFrom = previous.from as string;
  const prevTo = previous.to as string;
  let day: string;
  if (kind === 'week') day = addDays(prevFrom, daysBetween(period.from as string, today) - 1);
  else if (kind === 'month') day = `${prevFrom.slice(0, 7)}-${today.slice(8, 10)}`;
  else day = `${prevFrom.slice(0, 4)}-${today.slice(5, 10)}`;
  // 31 Mar → the end of February; 29 Feb → 28 Feb. Day keys compare as strings.
  if (!isDayKey(day) || day > prevTo) {
    day = kind === 'year' ? `${prevFrom.slice(0, 4)}-02-28` : prevTo;
  }
  return day;
}

const UNIT: Record<ComparedKind, string> = { week: 'week', month: 'month', year: 'year' };

/** "same days last week", or the previous period's label when the period is over. */
export function comparedWith(c: PeriodComparison): string {
  return c.state === 'running' ? `same days last ${UNIT[c.kind]}` : periodLabel(c.previous);
}

/** "Whole last week", for the second line of a running period. */
export function wholeLabel(c: PeriodComparison): string {
  return `Whole last ${UNIT[c.kind]}`;
}

/** Whether the running period's second line (the whole previous period) adds anything. */
export function showsWhole(c: PeriodComparison): boolean {
  return c.state === 'running' && c.previousSame.to !== c.previous.to;
}

export type SummaryKey = 'seconds' | 'chars' | 'speed' | 'booksCompleted' | 'lookups' | 'daysRead';

/** How a total is written on its tile. */
export function formatSummaryValue(key: SummaryKey, value: number): string {
  if (key === 'seconds') return formatDuration(value);
  if (key === 'speed') return value ? `${formatNumber(value)} / h` : '–';
  return formatNumber(value);
}

const MINUS = '−';

/**
 * One tile's change line: "+12,345 (+18%) vs same days last week", "−3 (−20%) vs
 * October 2026", "No change vs …", "+5 vs … (none then)". Speed without tracked
 * reading in either span has no line (null): a speed of 0 means "no speed", not "slow".
 */
export function changeLine(
  key: SummaryKey,
  current: StatsSummary,
  previous: StatsSummary,
  against: string
): string | null {
  const cur = current[key];
  const prev = previous[key];
  if (key === 'speed' && (!cur || !prev)) {
    return !cur ? null : `${formatSummaryValue(key, cur)} vs no tracked reading ${against}`;
  }
  const diff = cur - prev;
  if (diff === 0) return `No change vs ${against}`;
  const sign = diff > 0 ? '+' : MINUS;
  const amount =
    key === 'seconds'
      ? formatDuration(Math.abs(diff))
      : key === 'speed'
        ? `${formatNumber(Math.abs(diff))} / h`
        : formatNumber(Math.abs(diff));
  if (!prev) return `${sign}${amount} vs ${against} (none then)`;
  const percent = (Math.abs(diff) / prev) * 100;
  const pct = percent < 1 ? '<1' : String(Math.round(percent));
  return `${sign}${amount} (${sign}${pct}%) vs ${against}`;
}

// ---------------------------------------------------------------------------------
// Charts

export type ChartMeasure = 'chars' | 'time' | 'speed' | 'lookups';

export const CHART_MEASURES: { measure: ChartMeasure; label: string }[] = [
  { measure: 'chars', label: 'Characters' },
  { measure: 'time', label: 'Reading time' },
  { measure: 'speed', label: 'Speed' },
  { measure: 'lookups', label: 'Lookups' }
];

export function chartMeasureFromParam(value: string | null): ChartMeasure {
  return CHART_MEASURES.some((m) => m.measure === value) ? (value as ChartMeasure) : 'chars';
}

/** The measure of some totals; null = nothing to show (speed without tracked time). */
export function measureOf(totals: StatTotals, measure: ChartMeasure): number | null {
  switch (measure) {
    case 'time':
      return totals.seconds;
    case 'lookups':
      return totals.lookups;
    case 'speed':
      return totals.speedSeconds > 0 ? readingSpeed(totals) : null;
    case 'chars':
    default:
      return totals.chars;
  }
}

export function formatMeasure(measure: ChartMeasure, value: number | null): string {
  if (value === null) return '–';
  if (measure === 'time') return formatDuration(value);
  if (measure === 'speed') return `${formatNumber(value)} / h`;
  return formatNumber(value);
}

export interface ChartBucket {
  /** Under the axis ('' = no label at this bucket). */
  tick: string;
  /** For the readout: "Tue 10 Nov", "November 2026". */
  currentLabel: string | null;
  previousLabel: string | null;
  /** null = no such day (a shorter month) or after today. */
  current: number | null;
  previous: number | null;
}

export interface RunningSeries {
  /** Day keys from each period's start; the longer period sets the length. */
  currentDays: (string | null)[];
  previousDays: (string | null)[];
  /** The running value after each day; null after today or past the period's end. */
  current: (number | null)[];
  previous: (number | null)[];
  /** Axis labels per day index ('' = none). */
  ticks: string[];
}

export interface PeriodChart {
  measure: ChartMeasure;
  buckets: ChartBucket[];
  running: RunningSeries;
  /** The bucket / running index of today when the period is running, else the last one. */
  selectedBucket: number;
  selectedDay: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
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
const MONTH_TICKS = [1, 8, 15, 22, 29];

function sumDays(days: Map<string, StatTotals>, keys: string[]): StatTotals {
  const out = emptyTotals();
  for (const key of keys) {
    const t = days.get(key);
    if (!t) continue;
    out.seconds += t.seconds;
    out.chars += t.chars;
    out.lookups += t.lookups;
    out.speedSeconds += t.speedSeconds;
    out.speedChars += t.speedChars;
    out.entries += t.entries;
  }
  return out;
}

function daysOf(period: StatsPeriod): string[] {
  const out: string[] = [];
  if (!period.from || !period.to) return out;
  for (let d = period.from; d <= period.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "Tue 10 Nov" (with the year when it isn't today's year). */
function dayLabel(day: string, today: string): string {
  return formatDay(day, today.slice(0, 4));
}

/**
 * Both charts of a week, month or year and the period before it, from the view's
 * per-day totals (all time, the page's filters applied, manual completions' characters
 * on their finish day). Null for a period after today.
 */
export function periodChart(
  view: StatsView,
  c: PeriodComparison,
  measure: ChartMeasure,
  today: string
): PeriodChart | null {
  if (c.state === 'future') return null;
  const days = view.heatmapDays;
  const value = (keys: string[]) => measureOf(sumDays(days, keys), measure);
  const curFrom = c.period.from as string;
  const prevFrom = c.previous.from as string;
  const buckets: ChartBucket[] = [];

  if (c.kind === 'year') {
    for (let m = 0; m < 12; m += 1) {
      const mm = String(m + 1).padStart(2, '0');
      const curMonth = `${curFrom.slice(0, 4)}-${mm}`;
      const prevMonth = `${prevFrom.slice(0, 4)}-${mm}`;
      const curDays = daysOf(c.period).filter((d) => d.startsWith(curMonth) && d <= today);
      const prevDays = daysOf(c.previous).filter((d) => d.startsWith(prevMonth));
      buckets.push({
        tick: MONTHS[m],
        currentLabel: `${MONTH_NAMES[m]} ${curFrom.slice(0, 4)}`,
        previousLabel: `${MONTH_NAMES[m]} ${prevFrom.slice(0, 4)}`,
        current: curDays.length ? value(curDays) : null,
        previous: value(prevDays)
      });
    }
  } else {
    const length = c.kind === 'week' ? 7 : 31;
    for (let i = 0; i < length; i += 1) {
      const cur =
        c.kind === 'week'
          ? addDays(curFrom, i)
          : `${curFrom.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`;
      const prev =
        c.kind === 'week'
          ? addDays(prevFrom, i)
          : `${prevFrom.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`;
      const curOk = isDayKey(cur) && cur <= (c.period.to as string);
      const prevOk = isDayKey(prev) && prev <= (c.previous.to as string);
      buckets.push({
        tick:
          c.kind === 'week'
            ? WEEKDAYS[weekdayOf(cur)]
            : MONTH_TICKS.includes(i + 1)
              ? String(i + 1)
              : '',
        currentLabel: curOk ? dayLabel(cur, today) : null,
        previousLabel: prevOk ? dayLabel(prev, today) : null,
        current: curOk && cur <= today ? value([cur]) : null,
        previous: prevOk ? value([prev]) : null
      });
    }
  }

  // Running totals, one point per day from each period's start.
  const curDays = daysOf(c.period);
  const prevDays = daysOf(c.previous);
  const length = Math.max(curDays.length, prevDays.length);
  const running: RunningSeries = {
    currentDays: [],
    previousDays: [],
    current: [],
    previous: [],
    ticks: []
  };
  const curSum = emptyTotals();
  const prevSum = emptyTotals();
  for (let i = 0; i < length; i += 1) {
    const cur = curDays[i] ?? null;
    const prev = prevDays[i] ?? null;
    running.currentDays.push(cur);
    running.previousDays.push(prev);
    if (cur && cur <= today) {
      addInto(curSum, days.get(cur));
      running.current.push(measureOf(curSum, measure));
    } else running.current.push(null);
    if (prev) {
      addInto(prevSum, days.get(prev));
      running.previous.push(measureOf(prevSum, measure));
    } else running.previous.push(null);
    const tickDay = cur ?? prev;
    running.ticks.push(tickDay ? runningTick(c.kind, tickDay) : '');
  }

  const selectedBucket =
    c.state === 'running'
      ? c.kind === 'year'
        ? Number(today.slice(5, 7)) - 1
        : c.kind === 'week'
          ? daysBetween(curFrom, today) - 1
          : Number(today.slice(8, 10)) - 1
      : lastIndex(buckets.map((b) => (b.current !== null || b.previous !== null ? 1 : null)));
  const selectedDay =
    c.state === 'running' ? daysBetween(curFrom, today) - 1 : Math.max(0, curDays.length - 1);
  return { measure, buckets, running, selectedBucket, selectedDay };
}

function addInto(sum: StatTotals, t: StatTotals | undefined) {
  if (!t) return;
  sum.seconds += t.seconds;
  sum.chars += t.chars;
  sum.lookups += t.lookups;
  sum.speedSeconds += t.speedSeconds;
  sum.speedChars += t.speedChars;
  sum.entries += t.entries;
}

function runningTick(kind: ComparedKind, day: string): string {
  if (kind === 'week') return WEEKDAYS[weekdayOf(day)];
  const date = Number(day.slice(8, 10));
  if (kind === 'month') return MONTH_TICKS.includes(date) ? String(date) : '';
  return date === 1 ? MONTHS[Number(day.slice(5, 7)) - 1] : '';
}

function lastIndex(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return i;
  return Math.max(0, values.length - 1);
}

/** The readout line under the bars: "Tue 10 Nov: 12,345 · Tue 3 Nov: 9,876". */
export function bucketReadout(chart: PeriodChart, index: number): string {
  const b = chart.buckets[index];
  if (!b) return '';
  const parts: string[] = [];
  if (b.currentLabel) parts.push(`${b.currentLabel}: ${formatMeasure(chart.measure, b.current)}`);
  if (b.previousLabel)
    parts.push(`${b.previousLabel}: ${formatMeasure(chart.measure, b.previous)}`);
  return parts.join(' · ');
}

/** The readout under the running totals: "Up to Tue 10 Nov: 52,000 · Up to Tue 3 Nov: 40,000". */
export function runningReadout(chart: PeriodChart, index: number, today: string): string {
  const r = chart.running;
  const parts: string[] = [];
  const cur = r.currentDays[index];
  const prev = r.previousDays[index];
  if (cur) {
    parts.push(
      `Up to ${dayLabel(cur, today)}: ${cur <= today ? formatMeasure(chart.measure, r.current[index]) : '–'}`
    );
  }
  if (prev)
    parts.push(
      `Up to ${dayLabel(prev, today)}: ${formatMeasure(chart.measure, r.previous[index])}`
    );
  return parts.join(' · ');
}
