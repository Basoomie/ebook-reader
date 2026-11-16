/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  activeGoals,
  currentPeriod,
  formatGoalValue,
  goalProgress,
  goalProgressText,
  type GoalInput,
  type GoalProgress,
  type StatGoal
} from '$lib/stats/goals';
import { addDays, daysBetween, type StatsPeriod } from '$lib/stats/periods';

/**
 * The on-track dot while reading (Season 2 §9, decided 2026-11-14/15). Pure rules on top of
 * the reading goals (`goals.ts`): every device and book, calendar periods under the global
 * day boundary and week start.
 *
 * - Met: the goal's current period is met.
 * - Day goals: not met = behind (both rules).
 * - Week and month goals, rule `pace` (even pace, the default): on track when the period's
 *   total so far reaches target × (days so far, today included ÷ days in the period).
 *   Reading ahead carries over.
 * - Week and month goals, rule `share` (today's share): on track when today's reading
 *   reaches (target − reading before today) ÷ days left, today included.
 * - Speed goals: on track when the period's speed reaches the target; until the speed
 *   counts (`speedGoalMinMinutes`) there is no verdict (`waiting`).
 * - The dot: no active goal = `none`; any goal behind = `behind`; every goal met = `met`;
 *   otherwise `on-track`.
 */

export type OnTrackRule = 'pace' | 'share';
export type GoalTrackState = 'met' | 'on-track' | 'behind' | 'waiting';
export type OnTrackDotState = 'none' | 'met' | 'on-track' | 'behind';

export const ON_TRACK_RULES: { rule: OnTrackRule; label: string }[] = [
  { rule: 'pace', label: 'Even pace' },
  { rule: 'share', label: "Today's share" }
];

export function normalizeOnTrackRule(value: unknown): OnTrackRule {
  return value === 'share' ? 'share' : 'pace';
}

export interface GoalTrack {
  goal: StatGoal;
  period: StatsPeriod;
  progress: GoalProgress;
  state: GoalTrackState;
  /**
   * What on track needs, in the goal's unit: the goal's target (day goals), the period's
   * total by the end of today (`pace`), or today's reading (`share`); null for speed goals
   * and goals already met.
   */
  needed: number | null;
  /** What counts against `needed`: the period so far, or today's reading (`share`). */
  have: number | null;
  rule: OnTrackRule | null;
}

export interface OnTrackView {
  state: OnTrackDotState;
  goals: GoalTrack[];
}

function valueIn(goal: StatGoal, period: StatsPeriod, input: GoalInput): number {
  return goalProgress(goal, period, input).value;
}

export function goalTrack(
  goal: StatGoal,
  today: string,
  weekStart: number,
  input: GoalInput,
  rule: OnTrackRule
): GoalTrack {
  const period = currentPeriod(goal, today, weekStart);
  const progress = goalProgress(goal, period, input);
  const base = { goal, period, progress, needed: null, have: null, rule: null };

  if (progress.met) return { ...base, state: 'met' };

  if (goal.metric === 'speed') {
    return { ...base, state: progress.counted ? 'behind' : 'waiting' };
  }

  if (goal.period === 'day' || !period.from || !period.to) {
    return { ...base, state: 'behind', needed: goal.target, have: progress.value };
  }

  const days = daysBetween(period.from, period.to);

  if (rule === 'pace') {
    const daysSoFar = Math.min(days, Math.max(1, daysBetween(period.from, today)));
    const needed = Math.ceil((goal.target * daysSoFar) / days);
    return {
      ...base,
      rule,
      needed,
      have: progress.value,
      state: progress.value >= needed ? 'on-track' : 'behind'
    };
  }

  const before =
    today > period.from
      ? valueIn(goal, { kind: 'custom', from: period.from, to: addDays(today, -1) }, input)
      : 0;
  const todayValue = valueIn(goal, { kind: 'day', from: today, to: today }, input);
  const daysLeft = Math.max(1, daysBetween(today, period.to));
  const needed = Math.ceil(Math.max(0, goal.target - before) / daysLeft);
  return {
    ...base,
    rule,
    needed,
    have: todayValue,
    state: todayValue >= needed ? 'on-track' : 'behind'
  };
}

export function onTrackView(
  goals: StatGoal[],
  today: string,
  weekStart: number,
  input: GoalInput,
  rule: OnTrackRule
): OnTrackView {
  const tracks = activeGoals(goals, today).map((g) => goalTrack(g, today, weekStart, input, rule));
  return { state: dotState(tracks), goals: tracks };
}

export function dotState(tracks: Pick<GoalTrack, 'state'>[]): OnTrackDotState {
  if (!tracks.length) return 'none';
  if (tracks.some((t) => t.state === 'behind')) return 'behind';
  if (tracks.every((t) => t.state === 'met')) return 'met';
  return 'on-track';
}

export const DOT_STATE_LABELS: Record<OnTrackDotState, string> = {
  none: 'Reading goals: no goal yet',
  met: 'Reading goals: met',
  'on-track': 'Reading goals: on track',
  behind: 'Reading goals: behind'
};

/** Green (on track, met) and amber (behind) in a dark and a light shade. */
const DOT_SHADES = {
  fill: ['#15803d', '#22c55e'],
  ring: ['#b45309', '#f59e0b']
};

function rgbOf(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: string, b: string): number {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The dot's colours on the reader's background: of each colour's two shades, the one with
 * more contrast (the dark shades on light themes, the light ones on dark themes), so every
 * built-in and custom theme gets at least the better of the two.
 */
export function dotColors(background: string): { fill: string; ring: string } {
  const pick = ([dark, light]: string[]) =>
    contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light;
  return { fill: pick(DOT_SHADES.fill), ring: pick(DOT_SHADES.ring) };
}

/**
 * The goal card's status line, e.g. "41,000 of 100,000 (41%) · on track (42,858 by today)",
 * "35 min of 1 h 00 min (58%) · 25 min to go".
 */
export function goalTrackLine(track: GoalTrack, speedMinMinutes: number): string {
  const { goal, progress, state, needed, have, rule } = track;
  const text = goalProgressText(goal, progress, speedMinMinutes);

  if (state === 'met' || state === 'waiting') return text;
  if (goal.metric === 'speed') return `${text} · ${state === 'behind' ? 'behind' : 'on track'}`;
  if (needed === null || have === null) return text;

  if (rule === null) {
    return `${text} · ${formatGoalValue(goal.metric, Math.max(0, needed - have))} to go`;
  }

  const verdict = state === 'on-track' ? 'on track' : 'behind';

  if (rule === 'pace') {
    return `${text} · ${verdict} (${formatGoalValue(goal.metric, needed)} by today)`;
  }

  return `${text} · ${verdict} (today ${formatGoalValue(goal.metric, have)} of ${formatGoalValue(
    goal.metric,
    needed
  )})`;
}
