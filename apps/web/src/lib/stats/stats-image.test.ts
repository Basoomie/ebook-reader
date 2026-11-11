/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import type { StatGoal } from '$lib/stats/goals';
import { customPeriod, periodContaining } from '$lib/stats/periods';
import { drawStatsImage } from '$lib/stats/stats-image';
import {
  buildStatsImageModel,
  chartFor,
  goalsFor,
  statsImageFileName
} from '$lib/stats/stats-image-model';
import { buildStatsView, type StatsBookInfo } from '$lib/stats/stats-view';
import type { ReadThrough } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '44444444-4444-4444-8444-444444444444';
const A = '22222222-2222-4222-8222-222222222222';
let n = 0;
const session = (
  book: string,
  day: string,
  seconds: number,
  chars: number,
  hour = 21
): LocalRecord => {
  const startedAt = new Date(`${day}T${String(hour).padStart(2, '0')}:10:00`).getTime();
  return {
    kind: 'stat-session',
    id: `${book}:${A}:00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    bookId: book,
    deviceId: A,
    updatedAt: 1,
    deletedAt: null,
    rev: 1,
    data: {
      day,
      startedAt,
      endedAt: startedAt + seconds * 1000,
      seconds,
      chars,
      lookups: 3,
      readThroughId: null,
      source: 'tracker',
      closed: true
    }
  };
};

const records = [
  session(B1, '2026-11-02', 3600, 30_000, 7),
  session(B1, '2026-11-10', 1800, 15_000, 21),
  session(B2, '2026-11-10', 1200, 9_000, 22),
  session(B2, '2026-11-11', 2400, 20_000, 8)
];
const entries = statEntriesFromRecords(records);
const readThroughs = new Map<string, ReadThrough[]>([
  [
    B2,
    [
      {
        id: `${B2}:1`,
        number: 1,
        origin: 'completion',
        startedOn: null,
        finished: true,
        finishedOn: '2026-11-11',
        manual: false,
        charCount: null
      }
    ]
  ]
]);
const books = new Map<string, StatsBookInfo>([
  [
    B1,
    {
      title: '夜明けの図書館',
      libraryId: 'l',
      missing: false,
      charCount: 90_000,
      thumbnail: 'http://x/1.webp'
    }
  ],
  [
    B2,
    { title: '坂の上の時計', libraryId: 'l', missing: false, charCount: 60_000, thumbnail: null }
  ]
]);
const goalInput = { entries, readThroughs, books, speedMinSeconds: 0 };
const view = (period = periodContaining('month', '2026-11-12', 1)) =>
  buildStatsView({
    entries,
    readThroughs,
    books,
    filter: { device: null, library: null, book: null },
    period
  });
const goal = (extra: Partial<StatGoal>): StatGoal => ({
  id: 'g',
  metric: 'time',
  period: 'day',
  target: 1800,
  startedOn: '2026-11-01',
  endedOn: null,
  createdAt: 1,
  ...extra
});

describe('stats image model', () => {
  it('builds the month image', () => {
    const period = periodContaining('month', '2026-11-12', 1);
    const model = buildStatsImageModel({
      view: view(period),
      period,
      filters: [],
      today: '2026-11-12',
      weekStart: 1,
      goals: [goal({}), goal({ id: 'speed', metric: 'speed', period: 'month', target: 20_000 })],
      goalInput,
      thumbnails: new Map([...books].map(([id, b]) => [id, b.thumbnail ?? null]))
    });
    expect(model).toMatchObject({
      header: 'ッツ READER',
      period: 'November 2026',
      filter: '',
      chars: '74,000',
      time: '2 h 30 min',
      daysRead: '3 / 12',
      completed: '1',
      lookups: '12',
      booksRead: '2',
      covers: [{ title: '坂の上の時計', url: null }]
    });
    expect(model.chart?.title).toBe('Characters per day');
    expect(model.chart?.values).toHaveLength(30);
    expect(model.chart?.values[9]).toBe(24_000);
    expect(model.chart?.labels.filter(Boolean)).toEqual(['1', '8', '15', '22', '29']);
    expect(model.goals.map((g) => [g.title, g.result, g.dots?.length])).toEqual([
      ['Daily reading time: 30 min', 'met 3 of 12 days', 12],
      ['Monthly reading speed: 20,000 / h', 'met ✓', undefined]
    ]);
  });

  it('charts a day by hour, a week by weekday, a year by month', () => {
    const day = periodContaining('day', '2026-11-10', 1);
    const byHour = chartFor(view(day), day, '2026-11-12');
    expect(byHour?.values[21]).toBe(15_000);
    expect(byHour?.values[22]).toBe(9_000);
    const week = periodContaining('week', '2026-11-12', 1);
    expect(chartFor(view(week), week, '2026-11-12')?.labels).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun'
    ]);
    const year = periodContaining('year', '2026-11-12', 1);
    const byMonth = chartFor(view(year), year, '2026-11-12');
    expect(byMonth?.title).toBe('Characters per month');
    expect(byMonth?.values[10]).toBe(74_000);
    // All with reading in one year only: by month (two years or less), not one bar.
    const all = periodContaining('all', '2026-11-12', 1);
    expect(chartFor(view(all), all, '2026-11-12')?.title).toBe('Characters per month');
    const long = customPeriod('2026-01-01', '2026-12-31');
    expect(chartFor(view(long), long, '2026-11-12')?.values).toHaveLength(12);
  });

  it('marks goal periods in the image period and skips goals outside it', () => {
    const week = periodContaining('week', '2026-11-12', 1);
    const [daily] = goalsFor([goal({ startedOn: '2026-11-10' })], week, '2026-11-12', 1, goalInput);
    expect(daily.dots).toEqual(['none', 'met', 'met', 'current']);
    expect(daily.result).toBe('met 2 of 3 days');
    expect(goalsFor([goal({ endedOn: '2026-10-31' })], week, '2026-11-12', 1, goalInput)).toEqual(
      []
    );
    expect(
      goalsFor([goal({})], periodContaining('all', '2026-11-12', 1), '2026-11-12', 1, goalInput)
    ).toEqual([]);
  });

  it('names the file after the period', () => {
    expect(statsImageFileName(periodContaining('month', '2026-11-12', 1))).toBe(
      'ttsu-stats-2026-11.png'
    );
    expect(statsImageFileName(periodContaining('week', '2026-11-12', 1))).toBe(
      'ttsu-stats-week-2026-11-09.png'
    );
    expect(statsImageFileName(periodContaining('day', '2026-11-12', 1))).toBe(
      'ttsu-stats-2026-11-12.png'
    );
    expect(statsImageFileName(customPeriod('2026-11-01', '2026-11-05'))).toBe(
      'ttsu-stats-2026-11-01-to-2026-11-05.png'
    );
    expect(statsImageFileName(periodContaining('all', '2026-11-12', 1))).toBe('ttsu-stats-all.png');
  });
});

describe('drawStatsImage', () => {
  it('draws every part without a real canvas, covers as cards when not loaded', () => {
    const texts: string[] = [];
    const calls: string[] = [];
    const ctx = new Proxy(
      { measureText: (t: string) => ({ width: t.length * 10 }) } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          return (...args: unknown[]) => {
            calls.push(prop);
            if (prop === 'fillText') texts.push(String(args[0]));
          };
        },
        set(target, prop: string, value) {
          target[prop] = value;
          return true;
        }
      }
    ) as unknown as CanvasRenderingContext2D;
    const period = periodContaining('month', '2026-11-12', 1);
    const model = buildStatsImageModel({
      view: view(period),
      period,
      filters: ['Device: Boox'],
      today: '2026-11-12',
      weekStart: 1,
      goals: [goal({})],
      goalInput,
      thumbnails: new Map()
    });
    drawStatsImage(ctx, model, [null]);
    for (const t of [
      'ッツ READER',
      'November 2026',
      'Device: Boox',
      '74,000',
      '3 / 12',
      'Goals',
      'completed'
    ]) {
      expect(texts).toContain(t);
    }
    // 読書記録 down the edge, one character at a time; the cover card's vertical title.
    expect(texts).toEqual(expect.arrayContaining(['読', '書', '記', '録', '坂', '上']));
    expect(calls.filter((c) => c === 'arc')).toHaveLength(12);
    expect(calls).not.toContain('drawImage');
  });
});
