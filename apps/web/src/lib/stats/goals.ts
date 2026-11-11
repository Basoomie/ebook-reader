/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { StatEntry } from '$lib/stats/aggregate';
import { addDays, periodContaining, stepPeriod, type StatsPeriod } from '$lib/stats/periods';
import { buildStatsView, type StatsBookInfo } from '$lib/stats/stats-view';
import type { ReadThrough } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * Reading goals (WP12c). Record `stat-goal` (id UUID, lww, deletable):
 * `{metric, period, target, startedOn, endedOn, createdAt}`. Pure rules.
 *
 * - Several goals can be active at once (e.g. a daily time goal and a speed goal).
 * - Periods are calendar ones: a day under the global day boundary, a week from the
 *   global week start, a calendar month.
 * - A goal applies to every period that overlaps [startedOn, endedOn]; changing it ends
 *   it before the current period and starts a new one there, so past periods keep the
 *   target they had. A goal made in the current period is simply edited or deleted.
 * - Values use every device and every book: time and speed from tracked reading,
 *   characters with manual completions (the Stats page's totals without filters).
 * - A speed goal counts for a period only after `speedMinSeconds` of tracked reading
 *   in it (global setting), so a few fast minutes don't meet it.
 * - The old `reading-goal` records are untouched and not shown (user, 2026-11-11).
 */

export const STAT_GOAL_KIND = 'stat-goal';

export type GoalMetric = 'time' | 'chars' | 'speed';
export type GoalPeriod = 'day' | 'week' | 'month';

export const GOAL_METRICS: { metric: GoalMetric; label: string; unit: string }[] = [
  { metric: 'time', label: 'Reading time', unit: 'minutes' },
  { metric: 'chars', label: 'Characters', unit: 'characters' },
  { metric: 'speed', label: 'Reading speed', unit: 'characters per hour' }
];

export const GOAL_PERIODS: { period: GoalPeriod; label: string; adjective: string }[] = [
  { period: 'day', label: 'Day', adjective: 'Daily' },
  { period: 'week', label: 'Week', adjective: 'Weekly' },
  { period: 'month', label: 'Month', adjective: 'Monthly' }
];

export interface StatGoal {
  id: string;
  metric: GoalMetric;
  period: GoalPeriod;
  /** Seconds (time), characters, or characters per hour (speed). */
  target: number;
  startedOn: string;
  endedOn: string | null;
  createdAt: number;
}

export interface GoalWrite {
  op: 'put' | 'remove';
  id: string;
  data?: Omit<StatGoal, 'id'>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRICS = new Set<string>(['time', 'chars', 'speed']);
const PERIODS = new Set<string>(['day', 'week', 'month']);

export function goalsFromRecords(records: LocalRecord[]): StatGoal[] {
  const out: StatGoal[] = [];
  for (const r of records) {
    if (r.kind !== STAT_GOAL_KIND || r.deletedAt !== null) continue;
    const d = r.data ?? {};
    if (
      !METRICS.has(String(d.metric)) ||
      !PERIODS.has(String(d.period)) ||
      typeof d.target !== 'number' ||
      !(d.target > 0) ||
      typeof d.startedOn !== 'string' ||
      !DAY_RE.test(d.startedOn)
    ) {
      continue;
    }
    out.push({
      id: r.id,
      metric: d.metric as GoalMetric,
      period: d.period as GoalPeriod,
      target: d.target,
      startedOn: d.startedOn,
      endedOn: typeof d.endedOn === 'string' && DAY_RE.test(d.endedOn) ? d.endedOn : null,
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Goals that apply to today's period (not ended before it). */
export function activeGoals(goals: StatGoal[], today: string): StatGoal[] {
  return goals.filter((g) => g.endedOn === null || g.endedOn >= today);
}

export function currentPeriod(goal: Pick<StatGoal, 'period'>, today: string, weekStart: number) {
  return periodContaining(goal.period, today, weekStart);
}

function overlaps(goal: StatGoal, period: StatsPeriod): boolean {
  if (!period.from || !period.to) return false;
  return goal.startedOn <= period.to && (goal.endedOn === null || goal.endedOn >= period.from);
}

export interface GoalInput {
  entries: StatEntry[];
  readThroughs: Map<string, ReadThrough[]>;
  books: Map<string, StatsBookInfo>;
  /** Tracked seconds a period needs before a speed goal counts. */
  speedMinSeconds: number;
}

export interface GoalProgress {
  value: number;
  target: number;
  /** value / target, 0 when nothing counts yet. */
  ratio: number;
  met: boolean;
  /** Speed goals: enough tracked time in the period for the speed to count. */
  counted: boolean;
  seconds: number;
}

export function goalProgress(goal: StatGoal, period: StatsPeriod, input: GoalInput): GoalProgress {
  const { summary } = buildStatsView({
    entries: input.entries,
    readThroughs: input.readThroughs,
    books: input.books,
    filter: { device: null, library: null, book: null },
    period
  });
  const value =
    goal.metric === 'time'
      ? summary.seconds
      : goal.metric === 'chars'
        ? summary.chars
        : summary.speed;
  const counted = goal.metric !== 'speed' || summary.seconds >= Math.max(0, input.speedMinSeconds);
  return {
    value,
    target: goal.target,
    ratio: counted && goal.target > 0 ? value / goal.target : 0,
    met: counted && value >= goal.target,
    counted,
    seconds: summary.seconds
  };
}

export type GoalPeriodState = 'met' | 'missed' | 'current' | 'none';

/**
 * The last `count` periods up to the current one, oldest first. Periods before this goal
 * use an earlier goal of the same metric and period that covered them (a changed target
 * keeps its history), with that goal's own target.
 */
export function goalHistory(
  goal: StatGoal,
  today: string,
  weekStart: number,
  input: GoalInput,
  count = 12,
  allGoals: StatGoal[] = []
): { period: StatsPeriod; state: GoalPeriodState; progress: GoalProgress | null }[] {
  const periods: StatsPeriod[] = [];
  let p = currentPeriod(goal, today, weekStart);
  for (let i = 0; i < count; i += 1) {
    periods.unshift(p);
    p = stepPeriod(p, -1, weekStart);
  }
  return periods.map((period, i) => {
    const applying = overlaps(goal, period)
      ? goal
      : allGoals.find(
          (g) =>
            g.id !== goal.id &&
            g.metric === goal.metric &&
            g.period === goal.period &&
            overlaps(g, period)
        );
    if (!applying) return { period, state: 'none' as const, progress: null };
    const progress = goalProgress(applying, period, input);
    if (i === periods.length - 1 && !progress.met)
      return { period, state: 'current' as const, progress };
    return { period, state: progress.met ? ('met' as const) : ('missed' as const), progress };
  });
}

export interface GoalDraft {
  metric: GoalMetric;
  period: GoalPeriod;
  target: number;
}

/**
 * The writes for adding (`existing` null) or changing a goal: a goal started in its
 * current period is edited in place; an older one ends the day before its current period
 * and a new one starts at the new current period.
 */
export function planGoalSave(
  existing: StatGoal | null,
  draft: GoalDraft,
  today: string,
  weekStart: number,
  newId: () => string,
  now: number
): GoalWrite[] {
  const target = Math.max(1, Math.round(draft.target));
  const startedOn = periodContaining(draft.period, today, weekStart).from ?? today;
  const fresh = (id: string, createdAt: number): GoalWrite => ({
    op: 'put',
    id,
    data: {
      metric: draft.metric,
      period: draft.period,
      target,
      startedOn,
      endedOn: null,
      createdAt
    }
  });
  if (!existing) return [fresh(newId(), now)];
  const existingStart = currentPeriod(existing, today, weekStart).from ?? today;
  if (existing.startedOn >= existingStart) {
    return [fresh(existing.id, existing.createdAt)];
  }
  return [...planGoalEnd(existing, today, weekStart), fresh(newId(), now)];
}

/** Ends a goal (keeps its past periods), or deletes it when it began in its current period. */
export function planGoalEnd(goal: StatGoal, today: string, weekStart: number): GoalWrite[] {
  const start = currentPeriod(goal, today, weekStart).from ?? today;
  if (goal.startedOn >= start) return [{ op: 'remove', id: goal.id }];
  const { id, ...data } = goal;
  return [{ op: 'put', id, data: { ...data, endedOn: addDays(start, -1) } }];
}

function formatGoalNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatGoalDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s ? `${s} s` : '0 min';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** A goal value in its unit: "1 h 00 min", "50,000", "30,000 / h". */
export function formatGoalValue(metric: GoalMetric, value: number): string {
  if (metric === 'time') return formatGoalDuration(value);
  if (metric === 'speed') return `${formatGoalNumber(value)} / h`;
  return formatGoalNumber(value);
}

/** "Daily reading time: 1 h 00 min". */
export function goalTitle(goal: Pick<StatGoal, 'metric' | 'period' | 'target'>): string {
  const period = GOAL_PERIODS.find((p) => p.period === goal.period)?.adjective ?? '';
  const metric = GOAL_METRICS.find((m) => m.metric === goal.metric)?.label.toLowerCase() ?? '';
  return `${period} ${metric}: ${formatGoalValue(goal.metric, goal.target)}`;
}

/** "35 min of 1 h 00 min (58%)", or why a speed goal doesn't count yet. */
export function goalProgressText(
  goal: Pick<StatGoal, 'metric'>,
  progress: GoalProgress,
  speedMinMinutes: number
): string {
  if (!progress.counted) {
    return `Speed counts after ${speedMinMinutes} min of reading (${formatGoalDuration(
      progress.seconds
    )} so far)`;
  }
  const pct = Math.round(progress.ratio * 100);
  return `${formatGoalValue(goal.metric, progress.value)} of ${formatGoalValue(
    goal.metric,
    progress.target
  )} (${pct}%)${progress.met ? ' · met' : ''}`;
}
