/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  currentIndex,
  planPaint,
  readingEnd,
  readingStart,
  sameSpans,
  type PlanChar,
  type PlanInput
} from './pacer-plan';
import { advance, clampSpeed, stepSpeed } from './pacer-clock';

/** Ten counted characters, times 0..10, two paragraphs of five. */
const ten: PlanChar[] = Array.from({ length: 10 }, (_, i) => ({
  start: i,
  end: i + 1,
  counted: true
}));
const paras = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];

const input = (over: Partial<PlanInput>): PlanInput => ({
  chars: ten,
  point: 0,
  mode: 'reveal',
  keep: 3,
  paragraphs: paras,
  steps: null,
  ...over
});

describe('planPaint', () => {
  it('reveal: hides what starts after the point, character by character', () => {
    expect(planPaint(input({ point: 0 })).hide).toEqual([[1, 10]]);
    expect(planPaint(input({ point: 3.5 })).hide).toEqual([[4, 10]]);
    expect(planPaint(input({ point: 10 })).hide).toEqual([]);
  });

  it('reveal in steps: the whole current step shows at its start', () => {
    const steps = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2];
    expect(planPaint(input({ point: 0, steps })).hide).toEqual([[3, 10]]);
    expect(planPaint(input({ point: 2.9, steps })).hide).toEqual([[3, 10]]);
    expect(planPaint(input({ point: 3, steps })).hide).toEqual([[7, 10]]);
  });

  it('disappearing: hides text more than `keep` behind, fades just before', () => {
    const s = planPaint(input({ mode: 'disappear', point: 8, keep: 6 }));
    // ages: char i ends at i+1, age = 7 - i
    expect(s.hide).toEqual([[0, 2]]);
    expect(s.fade3).toEqual([[2, 3]]);
    expect(s.fade2).toEqual([[3, 4]]);
    expect(s.fade1).toEqual([[4, 5]]);
  });

  it('disappearing in steps: whole earlier steps, no fade', () => {
    const steps = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2];
    const s = planPaint(input({ mode: 'disappear', point: 7.5, keep: 3, steps }));
    // current step 2 starts at 7; step 0 ends at 3 <= 7 - 3 → hidden; step 1 ends at 7.
    expect(s.hide).toEqual([[0, 3]]);
    expect(s.fade1.length + s.fade2.length + s.fade3.length).toBe(0);
  });

  it('reveal + disappearing: only the stretch behind the point', () => {
    const s = planPaint(input({ mode: 'reveal-disappear', point: 6.5, keep: 3 }));
    expect(s.hide).toEqual([
      [0, 3],
      [7, 10]
    ]);
  });

  it('paragraph: dims every other paragraph, moves when the paragraph is done', () => {
    expect(planPaint(input({ mode: 'paragraph', point: 4.9 })).dim).toEqual([[5, 10]]);
    expect(planPaint(input({ mode: 'paragraph', point: 5 })).dim).toEqual([[0, 5]]);
  });

  it('paints nothing when off or without counted text', () => {
    expect(sameSpans(planPaint(input({ mode: 'off' })), planPaint(input({ chars: [] })))).toBe(
      true
    );
    const uncounted = [{ start: 0, end: 0, counted: false }];
    expect(planPaint(input({ chars: uncounted, paragraphs: [0] })).hide).toEqual([]);
  });

  it('finds the current character and the page reading start and end', () => {
    expect(currentIndex(ten, 0)).toBe(0);
    expect(currentIndex(ten, 4.2)).toBe(4);
    expect(currentIndex(ten, 99)).toBe(9);
    expect(readingEnd(ten, 2, 6)).toBe(7);
    expect(readingStart(ten, 2, 6)).toBe(2);
    expect(readingEnd([{ start: 0, end: 0, counted: false }], 0, 0)).toBeNull();
  });
});

describe('pacer clock', () => {
  it('moves at the speed in characters per hour', () => {
    // 18,000 / h = 5 characters a second.
    expect(advance(0, 1000, 18000, null)).toBeCloseTo(5);
    expect(advance(0, 200, 18000, null)).toBeCloseTo(1);
  });

  it('never moves past the cap and never more than one second at once', () => {
    expect(advance(0, 1000, 18000, 3)).toBe(3);
    expect(advance(0, 60000, 18000, null)).toBeCloseTo(5);
  });

  it('keeps the speed in range and in steps of 600', () => {
    expect(clampSpeed(5)).toBe(600);
    expect(clampSpeed(10 ** 9)).toBe(120000);
    expect(clampSpeed(NaN)).toBe(18000);
    expect(stepSpeed(18000, 1)).toBe(18600);
    expect(stepSpeed(18100, -1)).toBe(17400);
    expect(stepSpeed(600, -1)).toBe(600);
  });
});
