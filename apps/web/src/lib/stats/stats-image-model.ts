/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  goalProgress,
  goalTitle,
  type GoalInput,
  type GoalPeriodState,
  type StatGoal
} from '$lib/stats/goals';
import { formatDuration, formatNumber } from '$lib/stats/stats-format';
import {
  addDays,
  daysBetween,
  periodContaining,
  periodLabel,
  stepPeriod,
  weekdayOf,
  type StatsPeriod
} from '$lib/stats/periods';
import type { StatsView } from '$lib/stats/stats-view';

/**
 * What the Stats image shows (WP12d, draft approved by the user 2026-11-11): the Stats
 * page's period and filters, characters as the large number, reading time, speed, days
 * read, books completed, dictionary lookups, books read, a bar chart, the goals of the
 * period and the covers of the books completed in it. Pure: the canvas drawing is in
 * stats-image.ts.
 */

export interface StatsImageGoal {
  title: string;
  result: string;
  /** One state per goal period inside the image's period; null when there are too many. */
  dots: GoalPeriodState[] | null;
}

export interface StatsImageModel {
  header: string;
  period: string;
  /** "Device: Boox · Book: …", or '' without filters. */
  filter: string;
  chars: string;
  time: string;
  speed: string;
  daysRead: string;
  completed: string;
  lookups: string;
  booksRead: string;
  chart: { title: string; values: number[]; labels: string[] } | null;
  goals: StatsImageGoal[];
  covers: { title: string; url: string | null }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MAX_COVERS = 6;
const MAX_DOTS = 31;

export interface StatsImageInput {
  view: StatsView;
  period: StatsPeriod;
  /** Already worded filter labels, e.g. ["Device: Boox"]. */
  filters: string[];
  today: string;
  weekStart: number;
  goals: StatGoal[];
  goalInput: GoalInput;
  /** Thumbnail URL per book id (catalog), when known. */
  thumbnails: Map<string, string | null>;
}

function dayChars(view: StatsView, day: string): number {
  return view.heatmapDays.get(day)?.chars ?? 0;
}

/** The chart: by hour for a day, by day up to 31 days, by month up to 2 years, else by year. */
export function chartFor(view: StatsView, period: StatsPeriod, today: string) {
  if (period.kind === 'day' && period.from) {
    const values = new Array(24).fill(0) as number[];
    for (const day of view.days) {
      if (day.day !== period.from) continue;
      for (const e of day.entries) {
        if (e.excluded || e.startedAt === null) continue;
        values[new Date(e.startedAt).getHours()] += e.chars;
      }
    }
    return {
      title: 'Characters by hour',
      values,
      labels: values.map((_, h) => (h % 6 === 0 ? String(h) : ''))
    };
  }
  let from = period.from;
  let to = period.to;
  if (!from || !to) {
    const days = [...view.heatmapDays.keys()].sort();
    if (!days.length) return null;
    from = `${days[0].slice(0, 4)}-01-01`;
    to = `${today.slice(0, 4)}-12-31`;
  }
  const length = daysBetween(from, to);
  if (length <= 31) {
    const values: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < length; i += 1) {
      const day = addDays(from, i);
      values.push(dayChars(view, day));
      labels.push(
        length <= 7
          ? WEEKDAYS[weekdayOf(day)]
          : [1, 8, 15, 22, 29].includes(Number(day.slice(8, 10)))
            ? String(Number(day.slice(8, 10)))
            : ''
      );
    }
    return { title: 'Characters per day', values, labels };
  }
  const byMonth = length <= 731;
  const buckets = new Map<string, number>();
  for (const [day, totals] of view.heatmapDays) {
    if (day < from || day > to) continue;
    const key = byMonth ? day.slice(0, 7) : day.slice(0, 4);
    buckets.set(key, (buckets.get(key) ?? 0) + totals.chars);
  }
  const keys: string[] = [];
  if (byMonth) {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const end = to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > end) break;
      keys.push(key);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  } else {
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1)
      keys.push(String(y));
  }
  return {
    title: byMonth ? 'Characters per month' : 'Characters per year',
    values: keys.map((k) => buckets.get(k) ?? 0),
    labels: keys.map((k) =>
      byMonth
        ? keys.length <= 12 || k.endsWith('-01')
          ? MONTHS[Number(k.slice(5, 7)) - 1]
          : ''
        : k
    )
  };
}

const UNIT: Record<StatGoal['period'], [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months']
};

/** Each goal active in the period, with its goal periods inside it (up to today). */
export function goalsFor(
  goals: StatGoal[],
  period: StatsPeriod,
  today: string,
  weekStart: number,
  input: GoalInput
): StatsImageGoal[] {
  if (!period.from || !period.to) return [];
  const end = period.to < today ? period.to : today;
  const out: StatsImageGoal[] = [];
  for (const goal of goals) {
    if (goal.startedOn > end || (goal.endedOn !== null && goal.endedOn < period.from)) continue;
    const states: GoalPeriodState[] = [];
    let p = periodContaining(goal.period, period.from, weekStart);
    let guard = 0;
    while (p.from && p.from <= end && guard < 400) {
      guard += 1;
      const active =
        goal.startedOn <= (p.to ?? '') && (goal.endedOn === null || goal.endedOn >= (p.from ?? ''));
      if (!active) states.push('none');
      else {
        const progress = goalProgress(goal, p, input);
        const isCurrent = !!p.to && p.to >= today;
        states.push(progress.met ? 'met' : isCurrent ? 'current' : 'missed');
      }
      p = stepPeriod(p, 1, weekStart);
    }
    const counted = states.filter((s) => s !== 'none');
    const met = counted.filter((s) => s === 'met').length;
    const result =
      counted.length <= 1
        ? met
          ? 'met ✓'
          : counted[0] === 'current'
            ? 'in progress'
            : 'not met'
        : `met ${met} of ${counted.length} ${UNIT[goal.period][1]}`;
    out.push({
      title: goalTitle(goal),
      result,
      dots: states.length > 1 && states.length <= MAX_DOTS ? states : null
    });
  }
  return out;
}

export function buildStatsImageModel(input: StatsImageInput): StatsImageModel {
  const { view, period, today } = input;
  const s = view.summary;
  let daysRead = String(s.daysRead);
  if (period.from && period.to) {
    const end = period.to < today ? period.to : today;
    const elapsed = end >= period.from ? daysBetween(period.from, end) : 0;
    if (elapsed > 0) daysRead = `${s.daysRead} / ${elapsed}`;
  }
  const completedBooks = view.books.filter((b) => b.completed);
  const booksRead = view.books.filter((b) => b.seconds > 0 || b.chars > 0).length;
  return {
    header: 'ッツ READER',
    period: periodLabel(period),
    filter: input.filters.join(' · '),
    chars: formatNumber(s.chars),
    time: formatDuration(s.seconds),
    speed: s.speed ? `${formatNumber(s.speed)} / h` : '–',
    daysRead,
    completed: String(s.booksCompleted),
    lookups: formatNumber(s.lookups),
    booksRead: String(booksRead),
    chart: chartFor(view, period, today),
    goals: goalsFor(input.goals, period, today, input.weekStart, input.goalInput),
    covers: completedBooks.slice(0, MAX_COVERS).map((b) => ({
      title: b.title,
      url: input.thumbnails.get(b.bookId) ?? null
    }))
  };
}

/** The image's file name: ttsu-stats-2026-11.png, ttsu-stats-week-2026-11-09.png, … */
export function statsImageFileName(period: StatsPeriod): string {
  if (period.kind === 'all' || !period.from) return 'ttsu-stats-all.png';
  if (period.kind === 'month') return `ttsu-stats-${period.from.slice(0, 7)}.png`;
  if (period.kind === 'year') return `ttsu-stats-${period.from.slice(0, 4)}.png`;
  if (period.kind === 'day') return `ttsu-stats-${period.from}.png`;
  if (period.kind === 'week') return `ttsu-stats-week-${period.from}.png`;
  return `ttsu-stats-${period.from}-to-${period.to}.png`;
}
