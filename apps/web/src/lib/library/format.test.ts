/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { formatGroupChars, groupCount, groupTitle, seriesNumber } from './format';
import { boxesOverlap, boxFrom, rangeIds, toggled, withAll } from './selection';

const n = (v: number) => v.toLocaleString();

describe('group wording', () => {
  it('says how complete a character total is', () => {
    expect(formatGroupChars({ total: 1234567, counted: 12, pending: 0, failed: 0 })).toBe(
      `${n(1234567)} chars`
    );
    expect(formatGroupChars({ total: 1234567, counted: 10, pending: 2, failed: 0 })).toBe(
      `${n(1234567)}+ chars · 2 still counting`
    );
    expect(formatGroupChars({ total: 100, counted: 1, pending: 0, failed: 1 })).toBe(
      "100+ chars · 1 couldn't be counted"
    );
    expect(formatGroupChars({ total: 0, counted: 0, pending: 3, failed: 0 })).toBe('Counting…');
    expect(formatGroupChars({ total: 0, counted: 0, pending: 0, failed: 2 })).toBe('');
  });

  it('names groups and counts their books', () => {
    expect(groupTitle({ by: 'series', name: null })).toBe('No series');
    expect(groupCount({ by: 'series', name: 'S', bookCount: 1 })).toBe('1 volume');
    expect(groupCount({ by: 'series', name: null, bookCount: 12 })).toBe('12 books');
    expect(groupCount({ by: 'tag', name: 'T', bookCount: 1200 })).toBe(`${n(1200)} books`);
    expect(seriesNumber({ series: { name: 'S', index: 1.5 } })).toBe('#1.5');
    expect(seriesNumber({ series: null })).toBe('');
  });
});

describe('selection', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('selects ranges in either direction', () => {
    expect(rangeIds(ids, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'x', 'c')).toEqual(['c']);
  });

  it('hit-tests boxes', () => {
    const box = boxFrom(10, 10, 0, 0);
    expect(box).toEqual({ left: 0, top: 0, right: 10, bottom: 10 });
    expect(boxesOverlap(box, { left: 9, top: 9, right: 20, bottom: 20 })).toBe(true);
    expect(boxesOverlap(box, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
  });

  it('toggles and adds without changing the old set', () => {
    const old = new Set(['a']);
    expect([...toggled(old, 'a')]).toEqual([]);
    expect([...withAll(old, ['b'])]).toEqual(['a', 'b']);
    expect([...old]).toEqual(['a']);
  });
});
