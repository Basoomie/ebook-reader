/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  customPeriod,
  daysBetween,
  inPeriod,
  isDayKey,
  periodContaining,
  periodFromParam,
  periodLabel,
  periodToParam,
  stepPeriod,
  weekdayOf
} from '$lib/stats/periods';

describe('periods', () => {
  it('does day math across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(weekdayOf('2026-11-12')).toBe(4); // Thursday
    expect(daysBetween('2026-11-01', '2026-11-30')).toBe(30);
    expect(daysBetween('2026-11-02', '2026-11-01')).toBe(0);
    expect(isDayKey('2026-02-29')).toBe(false);
    expect(isDayKey('2028-02-29')).toBe(true);
  });

  it('starts weeks on any day', () => {
    // Thursday 2026-11-12
    expect(periodContaining('week', '2026-11-12', 1)).toMatchObject({
      from: '2026-11-09',
      to: '2026-11-15'
    });
    expect(periodContaining('week', '2026-11-12', 0)).toMatchObject({
      from: '2026-11-08',
      to: '2026-11-14'
    });
    expect(periodContaining('week', '2026-11-12', 4)).toMatchObject({
      from: '2026-11-12',
      to: '2026-11-18'
    });
    expect(periodContaining('week', '2026-11-12', 5)).toMatchObject({
      from: '2026-11-06',
      to: '2026-11-12'
    });
  });

  it('uses calendar months and years, and steps between them', () => {
    const feb = periodContaining('month', '2028-02-10', 1);
    expect(feb).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(stepPeriod(feb, 1, 1)).toMatchObject({ from: '2028-03-01', to: '2028-03-31' });
    expect(stepPeriod(feb, -1, 1)).toMatchObject({ from: '2028-01-01', to: '2028-01-31' });
    const week = periodContaining('week', '2026-12-30', 1);
    expect(stepPeriod(week, 1, 1)).toMatchObject({ from: '2027-01-04', to: '2027-01-10' });
    expect(periodContaining('year', '2026-06-01', 1)).toMatchObject({
      from: '2026-01-01',
      to: '2026-12-31'
    });
    const custom = customPeriod('2026-11-10', '2026-11-01');
    expect(custom).toMatchObject({ from: '2026-11-01', to: '2026-11-10' });
    expect(stepPeriod(custom, 1, 1)).toMatchObject({ from: '2026-11-11', to: '2026-11-20' });
    const all = periodContaining('all', '2026-11-12', 1);
    expect(stepPeriod(all, 1, 1)).toBe(all);
    expect(inPeriod('1999-01-01', all)).toBe(true);
    expect(inPeriod('2026-11-11', custom)).toBe(false);
  });

  it('labels periods', () => {
    expect(periodLabel(periodContaining('day', '2026-11-12', 1))).toBe('Thu 12 Nov 2026');
    expect(periodLabel(periodContaining('week', '2026-11-12', 1))).toBe('9 – 15 Nov 2026');
    expect(periodLabel(periodContaining('week', '2026-12-30', 1))).toBe('28 Dec 2026 – 3 Jan 2027');
    expect(periodLabel(periodContaining('week', '2026-10-30', 1))).toBe('26 Oct – 1 Nov 2026');
    expect(periodLabel(periodContaining('month', '2026-11-12', 1))).toBe('November 2026');
    expect(periodLabel(periodContaining('year', '2026-11-12', 1))).toBe('2026');
    expect(periodLabel(periodContaining('all', '2026-11-12', 1))).toBe('All time');
  });

  it("round-trips through the address, with today's week as the fallback", () => {
    for (const p of [
      periodContaining('day', '2026-11-12', 1),
      periodContaining('week', '2026-11-12', 3),
      periodContaining('month', '2026-11-12', 1),
      periodContaining('all', '2026-11-12', 1),
      customPeriod('2026-11-01', '2026-11-12')
    ]) {
      expect(periodFromParam(periodToParam(p), '2026-11-12', 3)).toEqual(p);
    }
    expect(periodFromParam('nonsense', '2026-11-12', 1)).toMatchObject({
      kind: 'week',
      from: '2026-11-09'
    });
    expect(periodFromParam('day:2026-02-30', '2026-11-12', 1).kind).toBe('week');
  });
});
