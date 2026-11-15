/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { getDateKey } from '$lib/functions/statistic-util';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import {
  bucketReadout,
  changeLine,
  chartMeasureFromParam,
  comparedWith,
  periodChart,
  periodComparison,
  runningReadout,
  showsWhole,
  type PeriodComparison
} from '$lib/stats/period-compare';
import { periodContaining, type StatsPeriod } from '$lib/stats/periods';
import { buildStatsView, type StatsBookInfo, type StatsViewInput } from '$lib/stats/stats-view';
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
const session = (book: string, device: string, day: string, seconds: number, chars: number) =>
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
      lookups: 1,
      readThroughId: null,
      source: 'tracker',
      closed: true
    }
  );
const books = new Map<string, StatsBookInfo>([
  [B1, { title: '本一', libraryId: 'lib-ja', missing: false, charCount: 100_000 }],
  [B2, { title: '本二', libraryId: 'lib-ja', missing: false, charCount: 50_000 }]
]);

function view(records: LocalRecord[], period: StatsPeriod, extra: Partial<StatsViewInput> = {}) {
  return buildStatsView({
    entries: statEntriesFromRecords(records),
    readThroughs: new Map(),
    books,
    filter: { device: null, library: null, book: null },
    period,
    ...extra
  });
}

const cmp = (kind: 'week' | 'month' | 'year', day: string, today: string, weekStart = 1) =>
  periodComparison(periodContaining(kind, day, weekStart), today, weekStart) as PeriodComparison;
const span = (p: StatsPeriod) => `${p.from}~${p.to}`;

describe('periodComparison', () => {
  it('compares a running week with the same days, for any week start', () => {
    // Thu 12 Nov 2026, weeks from Monday: Mon 9 – Thu 12 vs Mon 2 – Thu 5.
    const mon = cmp('week', '2026-11-12', '2026-11-12', 1);
    expect(mon.state).toBe('running');
    expect(span(mon.current)).toBe('2026-11-09~2026-11-12');
    expect(span(mon.previousSame)).toBe('2026-11-02~2026-11-05');
    expect(span(mon.previous)).toBe('2026-11-02~2026-11-08');
    expect(comparedWith(mon)).toBe('same days last week');
    expect(showsWhole(mon)).toBe(true);
    // From Sunday: Sun 8 – Thu 12 vs Sun 1 – Thu 5.
    const sun = cmp('week', '2026-11-12', '2026-11-12', 0);
    expect(span(sun.current)).toBe('2026-11-08~2026-11-12');
    expect(span(sun.previousSame)).toBe('2026-11-01~2026-11-05');
  });

  it('handles the first and last day of a period and a week across the year end', () => {
    const first = cmp('week', '2026-11-09', '2026-11-09');
    expect(span(first.current)).toBe('2026-11-09~2026-11-09');
    expect(span(first.previousSame)).toBe('2026-11-02~2026-11-02');
    const last = cmp('week', '2026-11-15', '2026-11-15');
    expect(span(last.previousSame)).toBe('2026-11-02~2026-11-08');
    expect(showsWhole(last)).toBe(false);
    // Mon 28 Dec 2026 – Sun 3 Jan 2027, today Fri 1 Jan.
    const yearEnd = cmp('week', '2027-01-01', '2027-01-01');
    expect(span(yearEnd.period)).toBe('2026-12-28~2027-01-03');
    expect(span(yearEnd.current)).toBe('2026-12-28~2027-01-01');
    expect(span(yearEnd.previousSame)).toBe('2026-12-21~2026-12-25');
  });

  it('compares months by day of the month, at most to the previous month’s end', () => {
    expect(span(cmp('month', '2026-11-15', '2026-11-15').previousSame)).toBe(
      '2026-10-01~2026-10-15'
    );
    // 31 Dec → all of November (30 days).
    expect(span(cmp('month', '2026-12-31', '2026-12-31').previousSame)).toBe(
      '2026-11-01~2026-11-30'
    );
    // 31 Mar / 30 Mar → all of February; 2028 is a leap year.
    expect(span(cmp('month', '2027-03-31', '2027-03-31').previousSame)).toBe(
      '2027-02-01~2027-02-28'
    );
    expect(span(cmp('month', '2028-03-30', '2028-03-30').previousSame)).toBe(
      '2028-02-01~2028-02-29'
    );
    expect(span(cmp('month', '2028-03-29', '2028-03-29').previousSame)).toBe(
      '2028-02-01~2028-02-29'
    );
    // 31 Jan → December of the year before.
    expect(span(cmp('month', '2027-01-31', '2027-01-31').previousSame)).toBe(
      '2026-12-01~2026-12-31'
    );
  });

  it('compares years by date, 29 Feb with 28 Feb', () => {
    expect(span(cmp('year', '2026-11-15', '2026-11-15').previousSame)).toBe(
      '2025-01-01~2025-11-15'
    );
    expect(span(cmp('year', '2028-02-29', '2028-02-29').previousSame)).toBe(
      '2027-01-01~2027-02-28'
    );
    expect(cmp('year', '2026-11-15', '2026-11-15').previous.to).toBe('2025-12-31');
  });

  it('compares a finished period whole with whole and a future one not at all', () => {
    const done = cmp('month', '2026-10-01', '2026-11-15');
    expect(done.state).toBe('done');
    expect(span(done.current)).toBe('2026-10-01~2026-10-31');
    expect(span(done.previousSame)).toBe('2026-09-01~2026-09-30');
    expect(comparedWith(done)).toBe('September 2026');
    expect(showsWhole(done)).toBe(false);
    const future = cmp('week', '2026-11-20', '2026-11-15');
    expect(future.state).toBe('future');
    expect(periodChart(view([], future.period), future, 'chars', '2026-11-15')).toBeNull();
    // Only week, month and year are compared.
    expect(periodComparison(periodContaining('day', '2026-11-15', 1), '2026-11-15', 1)).toBeNull();
    expect(periodComparison(periodContaining('all', '2026-11-15', 1), '2026-11-15', 1)).toBeNull();
  });

  it('takes today under the day boundary (01:00 with a 4 o’clock boundary is still yesterday)', () => {
    const today = getDateKey(4, new Date(2026, 10, 9, 1, 0));
    expect(today).toBe('2026-11-08');
    const c = cmp('week', today, today);
    // Sunday 8 Nov is the last day of the week from Monday 2 Nov.
    expect(span(c.current)).toBe('2026-11-02~2026-11-08');
  });
});

describe('changeLine', () => {
  const summary = (values: Partial<Record<string, number>>) => ({
    seconds: 0,
    chars: 0,
    speed: 0,
    lookups: 0,
    booksCompleted: 0,
    daysRead: 0,
    manualChars: 0,
    ...values
  });
  it('writes increases, decreases, no change and an empty previous period', () => {
    const w = 'same days last week';
    expect(changeLine('chars', summary({ chars: 11800 }), summary({ chars: 10000 }), w)).toBe(
      '+1,800 (+18%) vs same days last week'
    );
    expect(changeLine('booksCompleted', summary({}), summary({ booksCompleted: 2 }), w)).toBe(
      '−2 (−100%) vs same days last week'
    );
    expect(changeLine('seconds', summary({ seconds: 600 }), summary({ seconds: 600 }), w)).toBe(
      'No change vs same days last week'
    );
    expect(changeLine('lookups', summary({}), summary({}), w)).toBe(
      'No change vs same days last week'
    );
    expect(changeLine('seconds', summary({ seconds: 3900 }), summary({}), w)).toBe(
      '+1 h 05 min vs same days last week (none then)'
    );
    expect(changeLine('chars', summary({ chars: 1001 }), summary({ chars: 1000 }), w)).toBe(
      '+1 (+<1%) vs same days last week'
    );
  });
  it('gives speed a line only when this period has tracked reading', () => {
    const w = 'October 2026';
    expect(changeLine('speed', summary({ speed: 9000 }), summary({ speed: 10000 }), w)).toBe(
      '−1,000 / h (−10%) vs October 2026'
    );
    expect(changeLine('speed', summary({}), summary({ speed: 10000 }), w)).toBeNull();
    expect(changeLine('speed', summary({ speed: 9000 }), summary({}), w)).toBe(
      '9,000 / h vs no tracked reading October 2026'
    );
  });
});

describe('comparing values with the Stats page rules', () => {
  const records = [
    session(B1, A, '2026-11-09', 3600, 30_000), // this week, Mon
    session(B1, PHONE, '2026-11-11', 1800, 12_000), // this week, Wed
    session(B1, A, '2026-11-02', 600, 6_000), // last week, Mon
    session(B2, PHONE, '2026-11-04', 1200, 8_000), // last week, Wed
    session(B2, A, '2026-11-07', 900, 9_000) // last week, Sat (not in the same days)
  ];
  const c = cmp('week', '2026-11-11', '2026-11-11');

  it('sums the same days and the whole previous week', () => {
    const cur = view(records, c.current).summary;
    const same = view(records, c.previousSame).summary;
    const whole = view(records, c.previous).summary;
    expect([cur.chars, same.chars, whole.chars]).toEqual([42_000, 14_000, 23_000]);
    expect([cur.seconds, same.seconds, whole.seconds]).toEqual([5400, 1800, 2700]);
    expect([cur.daysRead, same.daysRead, whole.daysRead]).toEqual([2, 2, 3]);
    expect(changeLine('chars', cur, same, comparedWith(c))).toBe(
      '+28,000 (+200%) vs same days last week'
    );
  });

  it('applies the device filter, exclusions, corrections and manual completions', () => {
    const excluded = session(B1, A, '2026-11-03', 999, 99_999);
    const corrected = session(B1, A, '2026-11-03', 100, 1_000);
    const all = [
      ...records,
      excluded,
      record('stat-session-fix', excluded.id, B1, { excluded: true }),
      corrected,
      record('stat-session-fix', corrected.id, B1, { seconds: 200, chars: 2_000 })
    ];
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
            finishedOn: '2026-11-04',
            manual: true,
            charCount: null
          }
        ]
      ]
    ]);
    const same = view(all, c.previousSame, { readThroughs }).summary;
    // 6,000 + 2,000 corrected; B2's tracked 8,000 replaced by its 50,000 characters.
    expect(same.chars).toBe(6_000 + 2_000 + 50_000);
    expect(same.booksCompleted).toBe(1);
    const phone = view(all, c.previousSame, {
      readThroughs,
      filter: { device: PHONE, library: null, book: null }
    }).summary;
    // A manual completion has no device: not under a device filter.
    expect(phone.chars).toBe(0);
    expect(phone.seconds).toBe(1200);
  });
});

describe('periodChart', () => {
  const records = [
    session(B1, A, '2026-11-09', 3600, 30_000),
    session(B1, PHONE, '2026-11-11', 1800, 12_000),
    session(B1, A, '2026-11-02', 600, 6_000),
    session(B2, PHONE, '2026-11-04', 1200, 8_000),
    session(B2, A, '2026-11-07', 900, 9_000),
    session(B1, A, '2026-10-31', 1000, 5_000),
    session(B1, A, '2025-11-20', 2000, 20_000)
  ];

  it('draws a week day by day with last week beside it, nothing after today', () => {
    const c = cmp('week', '2026-11-11', '2026-11-11');
    const chart = periodChart(view(records, c.period), c, 'chars', '2026-11-11');
    expect(chart).not.toBeNull();
    if (!chart) return;
    expect(chart.buckets.map((b) => b.tick)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun'
    ]);
    expect(chart.buckets.map((b) => b.current)).toEqual([
      30_000,
      0,
      12_000,
      null,
      null,
      null,
      null
    ]);
    expect(chart.buckets.map((b) => b.previous)).toEqual([6_000, 0, 8_000, 0, 0, 9_000, 0]);
    expect(chart.selectedBucket).toBe(2);
    expect(bucketReadout(chart, 0)).toBe('Mon 9 Nov: 30,000 · Mon 2 Nov: 6,000');
    // Running totals stop at today.
    expect(chart.running.current).toEqual([30_000, 30_000, 42_000, null, null, null, null]);
    expect(chart.running.previous).toEqual([6_000, 6_000, 14_000, 14_000, 14_000, 23_000, 23_000]);
    expect(runningReadout(chart, 2, '2026-11-11')).toBe(
      'Up to Wed 11 Nov: 42,000 · Up to Wed 4 Nov: 14,000'
    );
    // Weeks from Sunday start the bars on Sunday.
    const sun = cmp('week', '2026-11-11', '2026-11-11', 0);
    expect(
      periodChart(view(records, sun.period), sun, 'chars', '2026-11-11')?.buckets[0].tick
    ).toBe('Sun');
  });

  it('measures time, lookups and speed (no bar without tracked time)', () => {
    const c = cmp('week', '2026-11-11', '2026-11-11');
    const v = view(records, c.period);
    expect(periodChart(v, c, 'time', '2026-11-11')?.buckets[0].current).toBe(3600);
    expect(periodChart(v, c, 'lookups', '2026-11-11')?.buckets[0].current).toBe(1);
    const speed = periodChart(v, c, 'speed', '2026-11-11');
    expect(speed?.buckets.map((b) => b.current)).toEqual([
      30_000,
      null,
      24_000,
      null,
      null,
      null,
      null
    ]);
    // Running speed = characters so far / time so far.
    expect(speed?.running.current.slice(0, 3)).toEqual([
      30_000,
      30_000,
      Math.ceil((3600 * 42_000) / 5400)
    ]);
    expect(bucketReadout(speed!, 1)).toBe('Tue 10 Nov: – · Tue 3 Nov: –');
  });

  it('draws a month by day of the month; a shorter previous month has no last bars', () => {
    const c = cmp('month', '2026-12-31', '2026-12-31');
    const chart = periodChart(view(records, c.period), c, 'chars', '2026-12-31');
    expect(chart?.buckets).toHaveLength(31);
    expect(chart?.buckets.map((b) => b.tick).filter(Boolean)).toEqual(['1', '8', '15', '22', '29']);
    expect(chart?.buckets[30].previous).toBeNull();
    expect(chart?.buckets[30].previousLabel).toBeNull();
    expect(chart?.buckets[29].previous).toBe(0);
    // November: 2+4+7+9+11 = 6,000+8,000+9,000+30,000+12,000.
    expect(chart?.running.previous[29]).toBe(65_000);
    expect(chart?.running.previous[30]).toBeNull();
    expect(chart?.running.current).toHaveLength(31);
    // November is compared with October, which has a 31st.
    const nov = cmp('month', '2026-11-30', '2026-11-30');
    const novChart = periodChart(view(records, nov.period), nov, 'chars', '2026-11-30');
    expect(novChart?.buckets[30].current).toBeNull();
    expect(novChart?.buckets[30].previous).toBe(5_000);
    expect(novChart?.running.current[30]).toBeNull();
    expect(novChart?.running.currentDays[30]).toBeNull();
  });

  it('draws a year by month, with last year’s months', () => {
    const c = cmp('year', '2026-11-11', '2026-11-11');
    const chart = periodChart(view(records, c.period), c, 'chars', '2026-11-11');
    expect(chart?.buckets.map((b) => b.tick)).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ]);
    expect(chart?.buckets[10].current).toBe(30_000 + 12_000 + 6_000 + 8_000 + 9_000);
    expect(chart?.buckets[9].current).toBe(5_000);
    expect(chart?.buckets[11].current).toBeNull();
    expect(chart?.buckets[10].previous).toBe(20_000);
    expect(chart?.selectedBucket).toBe(10);
    expect(bucketReadout(chart!, 10)).toBe('November 2026: 65,000 · November 2025: 20,000');
    expect(chart?.running.current).toHaveLength(365);
    expect(chart?.running.ticks.filter(Boolean)).toHaveLength(12);
    // A finished year selects its last month.
    const done = cmp('year', '2025-06-01', '2026-11-11');
    expect(
      periodChart(view(records, done.period), done, 'chars', '2026-11-11')?.selectedBucket
    ).toBe(11);
  });

  it('reads the measure from the address', () => {
    expect(chartMeasureFromParam('speed')).toBe('speed');
    expect(chartMeasureFromParam('nonsense')).toBe('chars');
    expect(chartMeasureFromParam(null)).toBe('chars');
  });
});
