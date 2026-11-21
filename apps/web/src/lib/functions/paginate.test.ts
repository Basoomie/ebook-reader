/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { pageOf, pageRangeText } from './paginate';

const list = Array.from({ length: 23 }, (_, i) => i + 1);

describe('pageOf', () => {
  it('shows the first page', () => {
    const p = pageOf(list, 0, 5);
    expect(p.items).toEqual([1, 2, 3, 4, 5]);
    expect(p).toMatchObject({ page: 0, pages: 5, from: 1, to: 5, total: 23 });
  });

  it('shows a short last page', () => {
    const p = pageOf(list, 4, 5);
    expect(p.items).toEqual([21, 22, 23]);
    expect(p).toMatchObject({ page: 4, from: 21, to: 23 });
  });

  it('clamps a page past the end (the list shrank)', () => {
    const p = pageOf(list.slice(0, 7), 4, 5);
    expect(p.page).toBe(1);
    expect(p.items).toEqual([6, 7]);
  });

  it('clamps a negative or broken page to the first', () => {
    expect(pageOf(list, -3, 5).page).toBe(0);
    expect(pageOf(list, Number.NaN, 5).page).toBe(0);
  });

  it('has one empty page for an empty list', () => {
    expect(pageOf([], 2, 5)).toEqual({ items: [], page: 0, pages: 1, from: 0, to: 0, total: 0 });
  });

  it('treats a size below 1 as 1', () => {
    expect(pageOf(list, 2, 0).items).toEqual([3]);
  });
});

describe('pageRangeText', () => {
  it('says which items show', () => {
    expect(pageRangeText(pageOf(list, 1, 5))).toBe('6–10 of 23');
    expect(pageRangeText({ from: 1, to: 10, total: 1234 })).toBe('1–10 of 1,234');
  });
});
