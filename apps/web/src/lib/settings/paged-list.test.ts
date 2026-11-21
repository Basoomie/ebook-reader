/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { compareText, matchesQuery, pageOf, queryWords, rangeText, searchKey } from './paged-list';

const items = Array.from({ length: 45 }, (_, i) => ({ n: i + 1, title: `本 ${i + 1}` }));

describe('pageOf', () => {
  it('cuts the list into pages and clamps the page', () => {
    const first = pageOf(items, { page: 1, pageSize: 20 });
    expect(first.rows.map((r) => r.n)).toEqual(items.slice(0, 20).map((r) => r.n));
    expect(first.pages).toBe(3);
    expect(first.matched).toBe(45);
    expect(first.total).toBe(45);

    const last = pageOf(items, { page: 3, pageSize: 20 });
    expect(last.rows.map((r) => r.n)).toEqual([41, 42, 43, 44, 45]);
    expect(last.start).toBe(40);

    expect(pageOf(items, { page: 99, pageSize: 20 }).page).toBe(3);
    expect(pageOf(items, { page: 0, pageSize: 20 }).page).toBe(1);
    expect(pageOf([], { page: 4, pageSize: 20 })).toMatchObject({ page: 1, pages: 1, matched: 0 });
  });

  it('filters, searches and sorts before paging, without changing the input', () => {
    const copy = [...items];
    const result = pageOf(items, {
      query: '1',
      text: (i) => i.title,
      filter: { id: 'odd', label: 'Odd', test: (i) => i.n % 2 === 1 },
      sort: { id: 'desc', label: 'Newest', compare: (a, b) => b.n - a.n },
      page: 1,
      pageSize: 3
    });
    // Odd numbers containing "1": 1, 11, 13, 15, 17, 19, 21, 31, 41.
    expect(result.matched).toBe(9);
    expect(result.rows.map((r) => r.n)).toEqual([41, 31, 21]);
    expect(result.total).toBe(45);
    expect(items).toEqual(copy);
  });

  it('needs every word of the query, in any order', () => {
    const books = [
      { t: '涼宮ハルヒの憂鬱 小説' },
      { t: '涼宮ハルヒの溜息' },
      { t: '小説の書き方' }
    ];
    const r = pageOf(books, { query: '小説 涼宮', text: (b) => b.t, page: 1, pageSize: 10 });
    expect(r.rows.map((b) => b.t)).toEqual(['涼宮ハルヒの憂鬱 小説']);
  });
});

describe('search folding', () => {
  it('matches katakana with hiragana, full-width with half-width, any case', () => {
    expect(searchKey('ハルヒ ＡＢＣ')).toBe('はるひ abc');
    expect(matchesQuery('涼宮ハルヒ', queryWords('はるひ'))).toBe(true);
    expect(matchesQuery('Pixel 8 · Chrome', queryWords('ｃｈｒｏｍｅ'))).toBe(true);
    expect(matchesQuery('Pixel 8', queryWords('pixel 9'))).toBe(false);
    expect(matchesQuery('anything', [])).toBe(true);
  });
});

describe('rangeText and compareText', () => {
  it('shows the range with thousands separators', () => {
    expect(rangeText({ start: 20, rows: new Array(20), matched: 4812 })).toBe('21–40 of 4,812');
    expect(rangeText({ start: 0, rows: [], matched: 0 })).toBe('');
  });

  it('orders numbers in titles by value', () => {
    expect(['第10巻', '第2巻', '第1巻'].sort(compareText)).toEqual(['第1巻', '第2巻', '第10巻']);
  });
});
