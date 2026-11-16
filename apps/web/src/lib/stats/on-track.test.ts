/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { getDateKey } from '$lib/functions/statistic-util';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import type { GoalInput, StatGoal } from '$lib/stats/goals';
import {
  contrastRatio,
  dotColors,
  dotState,
  goalTrack,
  goalTrackLine,
  normalizeOnTrackRule,
  onTrackView
} from '$lib/stats/on-track';
import type { ReadThrough } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '44444444-4444-4444-8444-444444444444';
const A = '22222222-2222-4222-8222-222222222222';
const D2 = '33333333-3333-4333-8333-333333333333';
let n = 0;

function session(book: string, day: string, seconds: number, chars: number, device = A) {
  const endedAt = ++n;
  return {
    kind: 'stat-session',
    id: `${book}:${device}:00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    bookId: book,
    deviceId: device,
    updatedAt: 1,
    deletedAt: null,
    rev: 1,
    data: {
      day,
      startedAt: endedAt - seconds * 1000,
      endedAt,
      seconds,
      chars,
      lookups: 0,
      readThroughId: null,
      source: 'tracker',
      closed: true
    }
  } as LocalRecord;
}

const goal = (extra: Partial<StatGoal> = {}): StatGoal => ({
  id: 'g1',
  metric: 'chars',
  period: 'week',
  target: 100_000,
  startedOn: '2026-10-05',
  endedOn: null,
  createdAt: 1,
  ...extra
});

function input(
  records: LocalRecord[],
  readThroughs = new Map<string, ReadThrough[]>(),
  speedMinSeconds = 900
): GoalInput {
  return {
    entries: statEntriesFromRecords(records),
    readThroughs,
    books: new Map(),
    speedMinSeconds
  };
}

// 2026-11-16 is a Monday; the week Mon 16 – Sun 22 Nov.
const MON = 1;

describe('on-track dot', () => {
  it('day goals are behind until met, with what is left', () => {
    const g = goal({ metric: 'time', period: 'day', target: 3600 });
    const half = goalTrack(
      g,
      '2026-11-18',
      MON,
      input([session(B1, '2026-11-18', 2100, 1)]),
      'pace'
    );
    expect(half).toMatchObject({ state: 'behind', needed: 3600, have: 2100, rule: null });
    expect(goalTrackLine(half, 15)).toBe('35 min of 1 h 00 min (58%) · 25 min to go');
    // Same under today's share.
    expect(
      goalTrack(g, '2026-11-18', MON, input([session(B1, '2026-11-18', 2100, 1)]), 'share').state
    ).toBe('behind');
    const done = goalTrack(
      g,
      '2026-11-18',
      MON,
      input([session(B1, '2026-11-18', 2100, 1), session(B2, '2026-11-18', 1500, 1, D2)]),
      'pace'
    );
    expect(done.state).toBe('met');
    expect(goalTrackLine(done, 15)).toBe('1 h 00 min of 1 h 00 min (100%) · met');
  });

  it('even pace: total so far against the share of days so far; reading ahead carries over', () => {
    const g = goal();
    // Day 1 (Monday): needs 1/7 of 100,000 = 14,286.
    const day1 = goalTrack(
      g,
      '2026-11-16',
      MON,
      input([session(B1, '2026-11-16', 600, 14_286)]),
      'pace'
    );
    expect(day1).toMatchObject({ state: 'on-track', needed: 14_286, have: 14_286 });
    expect(
      goalTrack(g, '2026-11-16', MON, input([session(B1, '2026-11-16', 600, 14_285)]), 'pace').state
    ).toBe('behind');
    // Day 3 (Wednesday): 42,858 by today. Read ahead on Monday, nothing since: still on track.
    const ahead = input([session(B1, '2026-11-16', 600, 50_000)]);
    const day3 = goalTrack(g, '2026-11-18', MON, ahead, 'pace');
    expect(day3).toMatchObject({ state: 'on-track', needed: 42_858, have: 50_000 });
    expect(goalTrackLine(day3, 15)).toBe('50,000 of 100,000 (50%) · on track (42,858 by today)');
    // Day 7 (Sunday): the whole target.
    const day7 = goalTrack(g, '2026-11-22', MON, ahead, 'pace');
    expect(day7).toMatchObject({ state: 'behind', needed: 100_000 });
    expect(goalTrackLine(day7, 15)).toBe('50,000 of 100,000 (50%) · behind (100,000 by today)');
  });

  it("today's share: what is left over the days left; a missed day raises it", () => {
    const g = goal({ target: 70_000 });
    // Monday 10,000 (on pace), Tuesday nothing; Wednesday: (70,000 − 10,000) / 5 = 12,000.
    const data = (todayChars: number) =>
      input([session(B1, '2026-11-16', 600, 10_000), session(B2, '2026-11-18', 600, todayChars)]);
    const wed = goalTrack(g, '2026-11-18', MON, data(11_999), 'share');
    expect(wed).toMatchObject({ state: 'behind', needed: 12_000, have: 11_999, rule: 'share' });
    expect(goalTrackLine(wed, 15)).toBe('21,999 of 70,000 (31%) · behind (today 11,999 of 12,000)');
    expect(goalTrack(g, '2026-11-18', MON, data(12_000), 'share').state).toBe('on-track');
    // The same reading under even pace (30,000 by Wednesday): behind.
    expect(goalTrack(g, '2026-11-18', MON, data(12_000), 'pace').state).toBe('behind');
    // Read ahead before today: today still needs its share of what is left.
    const ahead = input([session(B1, '2026-11-16', 600, 40_000)]);
    const tue = goalTrack(g, '2026-11-17', MON, ahead, 'share');
    expect(tue).toMatchObject({ state: 'behind', needed: 5_000, have: 0 });
    // The first day of the period: nothing before.
    expect(goalTrack(g, '2026-11-16', MON, input([]), 'share').needed).toBe(10_000);
  });

  it('months of 28, 30 and 31 days', () => {
    const g = goal({ period: 'month', target: 31_000 });
    expect(goalTrack(g, '2026-12-10', MON, input([]), 'pace').needed).toBe(10_000);
    const g30 = goal({ period: 'month', target: 30_000 });
    expect(goalTrack(g30, '2026-11-10', MON, input([]), 'pace').needed).toBe(10_000);
    const g28 = goal({ period: 'month', target: 28_000 });
    expect(goalTrack(g28, '2027-02-10', MON, input([]), 'pace').needed).toBe(10_000);
    expect(goalTrack(g28, '2027-02-28', MON, input([]), 'pace').needed).toBe(28_000);
    // Today's share on the last day: everything left.
    expect(
      goalTrack(g28, '2027-02-28', MON, input([session(B1, '2027-02-01', 60, 20_000)]), 'share')
        .needed
    ).toBe(8_000);
  });

  it('follows the week start', () => {
    const g = goal({ target: 70_000 });
    // Wednesday 18 Nov: day 3 from Monday, day 4 from Sunday.
    expect(goalTrack(g, '2026-11-18', 1, input([]), 'pace').needed).toBe(30_000);
    expect(goalTrack(g, '2026-11-18', 0, input([]), 'pace').needed).toBe(40_000);
    // Reading on Sunday 15 Nov counts only in the week starting Sunday.
    const sun = input([session(B1, '2026-11-15', 60, 40_000)]);
    expect(goalTrack(g, '2026-11-18', 0, sun, 'pace').state).toBe('on-track');
    expect(goalTrack(g, '2026-11-18', 1, sun, 'pace').state).toBe('behind');
  });

  it('today before the day boundary is the previous day', () => {
    const early = new Date(2026, 10, 18, 3, 30);
    expect(getDateKey(4, early)).toBe('2026-11-17');
    expect(getDateKey(0, early)).toBe('2026-11-18');
    const g = goal({ metric: 'time', period: 'day', target: 600 });
    const data = input([session(B1, '2026-11-17', 900, 1)]);
    expect(goalTrack(g, getDateKey(4, early), MON, data, 'pace').state).toBe('met');
    expect(goalTrack(g, getDateKey(0, early), MON, data, 'pace').state).toBe('behind');
  });

  it('speed goals: waiting until the speed counts, then the speed against the target', () => {
    const g = goal({ metric: 'speed', target: 30_000 });
    const waiting = goalTrack(
      g,
      '2026-11-18',
      MON,
      input([session(B1, '2026-11-18', 300, 5_000)]),
      'pace'
    );
    expect(waiting).toMatchObject({ state: 'waiting', needed: null });
    expect(goalTrackLine(waiting, 15)).toBe('Speed counts after 15 min of reading (5 min so far)');
    const slow = goalTrack(
      g,
      '2026-11-18',
      MON,
      input([session(B1, '2026-11-18', 3600, 20_000)]),
      'share'
    );
    expect(slow.state).toBe('behind');
    expect(goalTrackLine(slow, 15)).toBe('20,000 / h of 30,000 / h (67%) · behind');
    const fast = goalTrack(
      g,
      '2026-11-18',
      MON,
      input([session(B1, '2026-11-18', 3600, 31_000)]),
      'pace'
    );
    expect(fast.state).toBe('met');
    // A waiting speed goal never makes the dot behind.
    expect(dotState([{ state: 'waiting' }])).toBe('on-track');
    expect(dotState([{ state: 'waiting' }, { state: 'met' }])).toBe('on-track');
  });

  it('several goals: the worst decides; ended goals are ignored; none without goals', () => {
    const data = input([session(B1, '2026-11-18', 3600, 50_000)]);
    const daily = goal({ id: 'a', metric: 'time', period: 'day', target: 1800 });
    const weekly = goal({ id: 'b', target: 100_000 });
    const behind = goal({ id: 'c', period: 'month', target: 1_000_000 });
    const ended = goal({
      id: 'd',
      metric: 'time',
      period: 'day',
      target: 99_999,
      endedOn: '2026-11-15'
    });
    expect(onTrackView([daily], '2026-11-18', MON, data, 'pace').state).toBe('met');
    const two = onTrackView([daily, weekly, ended], '2026-11-18', MON, data, 'pace');
    expect(two.state).toBe('on-track');
    expect(two.goals.map((t) => [t.goal.id, t.state])).toEqual([
      ['a', 'met'],
      ['b', 'on-track']
    ]);
    expect(onTrackView([daily, weekly, behind], '2026-11-18', MON, data, 'pace').state).toBe(
      'behind'
    );
    expect(onTrackView([], '2026-11-18', MON, data, 'pace')).toEqual({ state: 'none', goals: [] });
    expect(onTrackView([ended], '2026-11-18', MON, data, 'pace').state).toBe('none');
  });

  it('counts every device and manual completions, like the goals', () => {
    const g = goal({ target: 60_000 });
    const readThroughs = new Map<string, ReadThrough[]>([
      [
        B2,
        [
          {
            id: 'rt1',
            number: 1,
            origin: 'completion',
            startedOn: null,
            finished: true,
            finishedOn: '2026-11-17',
            manual: true,
            charCount: 25_000
          } as ReadThrough
        ]
      ]
    ]);
    const data = input([session(B1, '2026-11-16', 600, 5_000, D2)], readThroughs);
    // Wednesday: 25,715 by today; 5,000 from the other device + 25,000 marked finished.
    expect(goalTrack(g, '2026-11-18', MON, data, 'pace')).toMatchObject({
      state: 'on-track',
      have: 30_000,
      needed: 25_715
    });
  });

  it('picks dot colours with at least 3:1 on every built-in theme', () => {
    const themes = {
      light: 'rgba(255, 255, 255, 1)',
      ecru: 'rgba(247, 246, 235, 1)',
      water: 'rgba(223, 236, 244, 1)',
      gray: 'rgba(35, 39, 42, 1)',
      dark: 'rgba(18, 18, 18, 1)',
      black: 'rgba(0, 0, 0, 1)'
    };
    for (const [name, bg] of Object.entries(themes)) {
      const { fill, ring } = dotColors(bg);
      expect(contrastRatio(fill, bg), `${name} fill`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(ring, bg), `${name} ring`).toBeGreaterThanOrEqual(3);
    }
    expect(dotColors(themes.light)).toEqual({ fill: '#15803d', ring: '#b45309' });
    expect(dotColors(themes.gray)).toEqual({ fill: '#22c55e', ring: '#f59e0b' });
    expect(dotColors('#ffffff')).toEqual(dotColors(themes.light));
    // Unreadable colour: the dark shades.
    expect(dotColors('transparent')).toEqual({ fill: '#15803d', ring: '#b45309' });
  });

  it('reads the rule setting', () => {
    expect(normalizeOnTrackRule('share')).toBe('share');
    expect(normalizeOnTrackRule('pace')).toBe('pace');
    expect(normalizeOnTrackRule('')).toBe('pace');
    expect(normalizeOnTrackRule(undefined)).toBe('pace');
  });
});
