/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import {
  activeGoals,
  goalHistory,
  goalProgress,
  goalsFromRecords,
  planGoalEnd,
  planGoalSave,
  type GoalInput,
  type StatGoal
} from '$lib/stats/goals';
import { periodContaining } from '$lib/stats/periods';
import { formatTimeLeft, secondsLeft, speedEstimate } from '$lib/stats/time-left';
import type { LocalRecord } from '$lib/sync/sync-db';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '44444444-4444-4444-8444-444444444444';
const A = '22222222-2222-4222-8222-222222222222';
let n = 0;
function record(
  kind: string,
  id: string,
  data: Record<string, unknown>,
  bookId: string | null = B1
): LocalRecord {
  return { kind, id, bookId, deviceId: A, updatedAt: 1, deletedAt: null, rev: 1, data };
}
const session = (book: string, day: string, seconds: number, chars: number, endedAt = ++n) =>
  record(
    'stat-session',
    `${book}:${A}:00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    {
      day,
      startedAt: endedAt - seconds * 1000,
      endedAt,
      seconds,
      chars,
      lookups: 0,
      readThroughId: null,
      source: 'tracker',
      closed: true
    },
    book
  );

const goal = (extra: Partial<StatGoal> = {}): StatGoal => ({
  id: 'g1',
  metric: 'time',
  period: 'day',
  target: 3600,
  startedOn: '2026-11-01',
  endedOn: null,
  createdAt: 1,
  ...extra
});

function input(records: LocalRecord[], speedMinSeconds = 900): GoalInput {
  return {
    entries: statEntriesFromRecords(records),
    readThroughs: new Map(),
    books: new Map(),
    speedMinSeconds
  };
}

describe('goals', () => {
  it('reads goal records and keeps the active ones', () => {
    const goals = goalsFromRecords([
      record(
        'stat-goal',
        'a',
        {
          metric: 'time',
          period: 'day',
          target: 60,
          startedOn: '2026-11-01',
          endedOn: null,
          createdAt: 2
        },
        null
      ),
      record(
        'stat-goal',
        'b',
        {
          metric: 'chars',
          period: 'week',
          target: 9,
          startedOn: '2026-10-01',
          endedOn: '2026-10-31',
          createdAt: 1
        },
        null
      ),
      record(
        'stat-goal',
        'c',
        { metric: 'pages', period: 'day', target: 1, startedOn: '2026-11-01' },
        null
      )
    ]);
    expect(goals.map((g) => g.id)).toEqual(['b', 'a']);
    expect(activeGoals(goals, '2026-11-12').map((g) => g.id)).toEqual(['a']);
  });

  it('measures time, characters and speed in a period', () => {
    const data = input([
      session(B1, '2026-11-12', 1800, 15_000),
      session(B2, '2026-11-12', 1200, 9_000),
      session(B1, '2026-11-11', 600, 6_000)
    ]);
    const day = periodContaining('day', '2026-11-12', 1);
    expect(goalProgress(goal(), day, data)).toMatchObject({ value: 3000, met: false });
    expect(goalProgress(goal({ metric: 'chars', target: 24_000 }), day, data)).toMatchObject({
      value: 24_000,
      met: true,
      ratio: 1
    });
    const speed = goalProgress(goal({ metric: 'speed', target: 28_000 }), day, data);
    expect(speed).toMatchObject({ value: 28_800, met: true, counted: true });
    // Too little reading for the speed to count.
    const short = goalProgress(
      goal({ metric: 'speed', target: 28_000 }),
      day,
      input([session(B1, '2026-11-12', 300, 5_000)])
    );
    expect(short).toMatchObject({ met: false, counted: false, ratio: 0 });
  });

  it('shows the last 12 periods: met, missed, current and before the goal', () => {
    const data = input([
      session(B1, '2026-11-10', 3600, 1),
      session(B1, '2026-11-11', 600, 1),
      session(B1, '2026-11-12', 100, 1)
    ]);
    const history = goalHistory(goal({ startedOn: '2026-11-10' }), '2026-11-12', 1, data);
    expect(history).toHaveLength(12);
    expect(history.slice(-4).map((h) => h.state)).toEqual(['none', 'met', 'missed', 'current']);
    const weekly = goalHistory(
      goal({ period: 'week', target: 4000, startedOn: '2026-11-09' }),
      '2026-11-12',
      1,
      data
    );
    expect(weekly.at(-1)).toMatchObject({ state: 'met' });
    expect(weekly.at(-2)?.state).toBe('none');
    // A changed target keeps the earlier weeks of the goal it replaced (no reading there).
    const earlier = goal({
      id: 'old',
      period: 'week',
      target: 100,
      startedOn: '2026-10-26',
      endedOn: '2026-11-08'
    });
    const continued = goalHistory(
      goal({ period: 'week', target: 4000, startedOn: '2026-11-09' }),
      '2026-11-12',
      1,
      data,
      12,
      [earlier]
    );
    expect(continued.slice(-3).map((h) => h.state)).toEqual(['missed', 'missed', 'met']);
    expect(continued.at(-2)?.progress?.target).toBe(100);
  });

  it('edits a goal made in its current period, ends an older one and starts a new one', () => {
    let id = 0;
    const newId = () => `new${++id}`;
    expect(
      planGoalSave(
        null,
        { metric: 'chars', period: 'week', target: 50_000 },
        '2026-11-12',
        1,
        newId,
        5
      )
    ).toEqual([
      {
        op: 'put',
        id: 'new1',
        data: {
          metric: 'chars',
          period: 'week',
          target: 50_000,
          startedOn: '2026-11-09',
          endedOn: null,
          createdAt: 5
        }
      }
    ]);
    const thisWeek = goal({ period: 'week', startedOn: '2026-11-09' });
    expect(
      planGoalSave(
        thisWeek,
        { metric: 'time', period: 'week', target: 7200 },
        '2026-11-12',
        1,
        newId,
        6
      )
    ).toEqual([
      {
        op: 'put',
        id: 'g1',
        data: expect.objectContaining({ target: 7200, startedOn: '2026-11-09', createdAt: 1 })
      }
    ]);
    const older = goal({ period: 'week', startedOn: '2026-10-05' });
    expect(
      planGoalSave(
        older,
        { metric: 'time', period: 'day', target: 1800 },
        '2026-11-12',
        1,
        newId,
        7
      )
    ).toEqual([
      { op: 'put', id: 'g1', data: expect.objectContaining({ endedOn: '2026-11-08' }) },
      {
        op: 'put',
        id: 'new2',
        data: expect.objectContaining({ period: 'day', target: 1800, startedOn: '2026-11-12' })
      }
    ]);
    expect(planGoalEnd(thisWeek, '2026-11-12', 1)).toEqual([{ op: 'remove', id: 'g1' }]);
    expect(planGoalEnd(older, '2026-11-12', 1)).toEqual([
      { op: 'put', id: 'g1', data: expect.objectContaining({ endedOn: '2026-11-08' }) }
    ]);
  });
});

describe('time left', () => {
  it('uses the newest reading in the book, else the overall speed', () => {
    const entries = statEntriesFromRecords([
      session(B1, '2026-11-01', 3600, 10_000, 1000),
      session(B1, '2026-11-12', 1800, 20_000, 3000),
      session(B1, '2026-11-12', 1800, 10_000, 2000),
      session(B2, '2026-11-12', 3600, 36_000, 4000)
    ]);
    // The newest hour of B1: 20k + 10k in 3600 s.
    expect(speedEstimate(B1, entries, 3600, 600)).toEqual({
      speed: 30_000,
      source: 'book',
      seconds: 3600
    });
    // A new book with nothing yet: the overall average.
    const overall = speedEstimate('55555555-5555-4555-8555-555555555555', entries, 3600, 600);
    expect(overall).toMatchObject({
      source: 'overall',
      speed: Math.ceil((3600 * 76_000) / 10_800)
    });
    expect(speedEstimate(B1, [], 3600, 600)).toBeNull();
    expect(secondsLeft(15_000, { speed: 30_000, source: 'book', seconds: 1 })).toBe(1800);
    expect(secondsLeft(1, null)).toBeNull();
    expect([
      formatTimeLeft(null),
      formatTimeLeft(30),
      formatTimeLeft(1800),
      formatTimeLeft(11_100)
    ]).toEqual(['–', '< 1 min', '30 min', '3 h 05 min']);
  });
});
