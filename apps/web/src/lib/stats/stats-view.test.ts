/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { BEFORE_DEVICE_TRACKING, statEntriesFromRecords } from '$lib/stats/aggregate';
import { customPeriod, periodContaining } from '$lib/stats/periods';
import {
  buildStatsView,
  devicesIn,
  tmwLog,
  type StatsBookInfo,
  type StatsViewInput
} from '$lib/stats/stats-view';
import type { ReadThrough } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '44444444-4444-4444-8444-444444444444';
const A = '22222222-2222-4222-8222-222222222222';
const PHONE = '33333333-3333-4333-8333-333333333333';
let n = 0;

function record(
  kind: string,
  id: string,
  bookId: string,
  data: Record<string, unknown>
): LocalRecord {
  return { kind, id, bookId, deviceId: A, updatedAt: 1, deletedAt: null, rev: 1, data };
}
const session = (
  book: string,
  device: string,
  day: string,
  seconds: number,
  chars: number,
  extra = {}
) =>
  record(
    'stat-session',
    `${book}:${device}:00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    book,
    {
      day,
      startedAt: n,
      endedAt: n + 1,
      seconds,
      chars,
      lookups: 2,
      readThroughId: null,
      source: 'tracker',
      closed: true,
      ...extra
    }
  );
const statDay = (book: string, day: string, seconds: number, chars: number) =>
  record('stat-day', `${book}:${day}`, book, {
    dateKey: day,
    readingTime: seconds,
    charactersRead: chars
  });

const rt = (book: string, number: number, extra: Partial<ReadThrough> = {}): ReadThrough => ({
  id: `${book}:${number}`,
  number,
  origin: 'completion',
  startedOn: null,
  finished: false,
  finishedOn: null,
  manual: false,
  charCount: null,
  ...extra
});

const books = new Map<string, StatsBookInfo>([
  [B1, { title: '本一', libraryId: 'lib-ja', missing: false, charCount: 100_000 }],
  [B2, { title: '消えた本', libraryId: 'lib-en', missing: true, charCount: 50_000 }]
]);

function input(records: LocalRecord[], extra: Partial<StatsViewInput> = {}): StatsViewInput {
  return {
    entries: statEntriesFromRecords(records),
    readThroughs: new Map(),
    books,
    filter: { device: null, library: null, book: null },
    period: periodContaining('week', '2026-11-12', 1),
    ...extra
  };
}

const records = [
  session(B1, A, '2026-11-10', 3600, 30_000),
  session(B1, PHONE, '2026-11-10', 1800, 12_000),
  session(B2, PHONE, '2026-11-12', 600, 5_000),
  session(B1, A, '2026-11-02', 600, 6_000), // the week before
  statDay(B1, '2026-10-01', 1200, 9_000)
];

describe('buildStatsView', () => {
  it('sums the period, per book and per day, keeping deleted books by name', () => {
    const view = buildStatsView(input(records));
    expect(view.summary).toMatchObject({
      seconds: 6000,
      chars: 47_000,
      lookups: 6,
      daysRead: 2,
      booksCompleted: 0,
      speed: Math.ceil((3600 * 47_000) / 6000)
    });
    expect(view.books.map((b) => [b.title, b.seconds, b.chars, b.missing])).toEqual([
      ['本一', 5400, 42_000, false],
      ['消えた本', 600, 5_000, true]
    ]);
    expect(view.days.map((d) => [d.day, d.entries.length])).toEqual([
      ['2026-11-12', 1],
      ['2026-11-10', 2]
    ]);
    // The heatmap covers all time.
    expect([...view.heatmapDays.keys()].sort()).toEqual([
      '2026-10-01',
      '2026-11-02',
      '2026-11-10',
      '2026-11-12'
    ]);
  });

  it('filters by device, before device tracking, library and book', () => {
    const all = periodContaining('all', '2026-11-12', 1);
    expect(
      buildStatsView(
        input(records, { period: all, filter: { device: PHONE, library: null, book: null } })
      ).summary
    ).toMatchObject({ seconds: 2400, chars: 17_000 });
    expect(
      buildStatsView(
        input(records, {
          period: all,
          filter: { device: BEFORE_DEVICE_TRACKING, library: null, book: null }
        })
      ).summary
    ).toMatchObject({ seconds: 1200, chars: 9_000, lookups: 0 });
    expect(
      buildStatsView(
        input(records, { period: all, filter: { device: null, library: 'lib-en', book: null } })
      ).summary
    ).toMatchObject({ seconds: 600, chars: 5_000 });
    expect(
      buildStatsView(
        input(records, { period: all, filter: { device: null, library: null, book: B1 } })
      ).summary
    ).toMatchObject({ seconds: 7200, chars: 57_000 });
  });

  it('counts completions in their period; manual ones add characters only, without a device filter', () => {
    const readThroughs = new Map([
      [B1, [rt(B1, 1, { finished: true, finishedOn: '2026-11-11', manual: false })]],
      [B2, [rt(B2, 1, { finished: true, finishedOn: '2026-11-12', manual: true })]]
    ]);
    const view = buildStatsView(input(records, { readThroughs }));
    // B2's tracked 5,000 are replaced by its 50,000 characters; time stays.
    expect(view.summary).toMatchObject({
      booksCompleted: 2,
      manualChars: 50_000,
      chars: 42_000 + 50_000,
      seconds: 6000
    });
    expect(view.summary.speed).toBe(Math.ceil((3600 * 42_000) / 6000));
    expect(view.books.find((b) => b.bookId === B2)).toMatchObject({
      completed: true,
      manual: true,
      chars: 50_000
    });
    const byPhone = buildStatsView(
      input(records, { readThroughs, filter: { device: PHONE, library: null, book: null } })
    );
    expect(byPhone.summary).toMatchObject({ manualChars: 0, chars: 12_000 });
    // The next week has no completion.
    const next = buildStatsView(
      input(records, { readThroughs, period: periodContaining('week', '2026-11-19', 1) })
    );
    expect(next.summary.booksCompleted).toBe(0);
  });

  it('keeps excluded sessions listed but out of every total', () => {
    const s = session(B1, A, '2026-11-11', 9999, 1);
    const view = buildStatsView(
      input([...records, s, record('stat-session-fix', s.id, B1, { excluded: true })])
    );
    expect(view.summary.seconds).toBe(6000);
    const day = view.days.find((d) => d.day === '2026-11-11');
    expect(day?.entries.map((e) => e.excluded)).toEqual([true]);
    expect(view.summary.daysRead).toBe(2);
  });

  it('lists devices and writes the TMW log', () => {
    const entries = statEntriesFromRecords(records);
    expect(
      devicesIn(
        entries,
        new Map([
          [A, 'Desktop'],
          [PHONE, 'Boox']
        ])
      )
    ).toEqual([
      { id: PHONE, name: 'Boox' },
      { id: A, name: 'Desktop' },
      { id: BEFORE_DEVICE_TRACKING, name: 'Before device tracking' }
    ]);
    const view = buildStatsView(
      input(records, { period: customPeriod('2026-11-10', '2026-11-10') })
    );
    expect(tmwLog(view, '10 Nov 2026', 'chars')).toBe(
      'Reading Data for 10 Nov 2026\n\n.log reading 42000 本一'
    );
    expect(tmwLog(view, '10 Nov 2026', 'minutes')).toBe(
      'Reading Data for 10 Nov 2026\n\n.log readtime 90 本一'
    );
    expect(tmwLog(buildStatsView(input([])), 'x', 'chars')).toBeNull();
  });
});
