/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { BookNotes, HighlightColor, HighlightItem, NoteItem } from './highlights';
import {
  activeFilterCount,
  bookChoices,
  buildNotesView,
  defaultBookSort,
  defaultHighlightSort,
  EMPTY_FILTER,
  flattenNotesView,
  highlightCount,
  isFiltered,
  notesFilterQuery,
  notesPage,
  notesPageQuery,
  parseNotesFilter,
  parseNotesPage,
  percentOf,
  seriesChoices,
  seriesHighlightCounts,
  unplacedCount,
  viewTotals,
  type NotesBookInfo
} from './notes-view';
import { clearPendingJump, setPendingJump, takePendingJump } from './pending-jump';

const hl = (
  bookId: string,
  n: number,
  color: HighlightColor,
  updatedAt = n,
  note?: string
): HighlightItem => ({
  id: `${bookId}:h${n}`,
  bookId,
  start: n * 100,
  end: n * 100 + 5,
  text: `text ${n}`,
  before: '',
  after: '',
  color,
  chapter: null,
  createdAt: updatedAt,
  updatedAt,
  note: note
    ? {
        id: `${bookId}:h:h${n}`,
        bookId,
        body: note,
        highlightId: `${bookId}:h${n}`,
        quote: null,
        createdAt: updatedAt,
        updatedAt
      }
    : undefined
});

const bookNote = (bookId: string, updatedAt: number): NoteItem => ({
  id: `${bookId}:n${updatedAt}`,
  bookId,
  body: 'about the book',
  highlightId: null,
  quote: null,
  createdAt: updatedAt,
  updatedAt
});

const info = (
  id: string,
  title: string,
  series: string | null = null,
  index: number | null = null
): NotesBookInfo => ({
  id,
  title,
  series: series ? { name: series, index } : null,
  charCount: 1000
});

const ALL = new Map<string, BookNotes>([
  ['v2', { highlights: [hl('v2', 1, 1, 50), hl('v2', 3, 2, 10, 'n')], notes: [] }],
  ['v1', { highlights: [hl('v1', 2, 2, 20)], notes: [bookNote('v1', 30)] }],
  ['other', { highlights: [], notes: [bookNote('other', 90)] }],
  ['gone', { highlights: [hl('gone', 1, 5, 5)], notes: [] }]
]);

const INFO = new Map<string, NotesBookInfo>([
  ['v1', info('v1', '巻一', 'シリーズ', 1)],
  ['v2', info('v2', '巻二', 'シリーズ', 2)],
  ['other', info('other', '別の本')]
]);

const ids = (groups: ReturnType<typeof buildNotesView>) => groups.map((g) => g.info.id);

describe('notes filter', () => {
  it('reads and writes the address bar query', () => {
    const filter = parseNotesFilter(
      new URLSearchParams('book=b1&series=%E3%82%B7&color=3,1,9,x&unplaced=1')
    );
    expect(filter).toEqual({
      book: 'b1',
      series: 'シ',
      noSeries: false,
      colors: new Set([3, 1]),
      withNote: false,
      unplacedOnly: true,
      query: ''
    });
    expect(notesFilterQuery(filter)).toBe('?book=b1&series=%E3%82%B7&color=1%2C3&unplaced=1');
    expect(notesFilterQuery(EMPTY_FILTER)).toBe('');
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
    expect(isFiltered(filter)).toBe(true);
  });

  it('keeps the search, the new filters, the view, the sort and the page', () => {
    const address =
      '?q=%E3%83%8F%E3%83%AB%E3%83%92&noseries=1&note=1&view=highlights&sort=book-desc&page=3';
    const state = parseNotesPage(new URLSearchParams(address));
    expect(state).toEqual({
      filter: { ...EMPTY_FILTER, query: 'ハルヒ', noSeries: true, withNote: true },
      view: 'highlights',
      sort: { key: 'book', dir: 'desc' },
      page: 3
    });
    expect(notesPageQuery(state)).toBe(address);
    expect(activeFilterCount(state.filter)).toBe(2);
    expect(isFiltered({ ...EMPTY_FILTER, query: ' x ' })).toBe(true);
    expect(activeFilterCount({ ...EMPTY_FILTER, query: 'x' })).toBe(0);
    // A sort of the other view, a bad page and "no series" beside a series are dropped.
    expect(
      parseNotesPage(new URLSearchParams('sort=book-asc&page=-2&series=S&noseries=1'))
    ).toEqual({
      filter: { ...EMPTY_FILTER, series: 'S' },
      view: 'books',
      sort: null,
      page: 1
    });
    // Old links (the Library's "Open on the Notes page") still read.
    expect(parseNotesPage(new URLSearchParams('series=S')).filter.series).toBe('S');
    expect(notesPageQuery({ filter: EMPTY_FILTER, view: 'books', sort: null, page: 1 })).toBe('');
  });
});

describe('buildNotesView', () => {
  it('orders books by the newest change and keeps unknown books', () => {
    const groups = buildNotesView(ALL, INFO, new Set(), EMPTY_FILTER);
    expect(ids(groups)).toEqual(['other', 'v2', 'v1', 'gone']);
    expect(groups[3].info).toMatchObject({ title: 'Unknown book', unknown: true });
    expect(groups[1].highlights.map((r) => r.item.id)).toEqual(['v2:h1', 'v2:h3']);
    expect(groups[2].notes.map((n) => n.body)).toEqual(['about the book']);
  });

  it('filters by book, series (in series order), color and unplaced', () => {
    expect(ids(buildNotesView(ALL, INFO, new Set(), { ...EMPTY_FILTER, book: 'v1' }))).toEqual([
      'v1'
    ]);
    expect(
      ids(buildNotesView(ALL, INFO, new Set(), { ...EMPTY_FILTER, series: 'シリーズ' }))
    ).toEqual(['v1', 'v2']);
    const green = buildNotesView(ALL, INFO, new Set(), { ...EMPTY_FILTER, colors: new Set([2]) });
    expect(ids(green)).toEqual(['v2', 'v1']);
    expect(green.flatMap((g) => g.highlights.map((r) => r.item.id))).toEqual(['v2:h3', 'v1:h2']);
    // Notes about a book have no color: left out by a color filter.
    expect(green.find((g) => g.info.id === 'v1')?.notes).toEqual([]);
    const unplaced = buildNotesView(ALL, INFO, new Set(['v2:h3']), {
      ...EMPTY_FILTER,
      unplacedOnly: true
    });
    expect(unplaced.flatMap((g) => g.highlights)).toEqual([
      { item: expect.objectContaining({ id: 'v2:h3' }), unplaced: true }
    ]);
  });

  it('follows a given book order (the Library series order)', () => {
    const order = ids(buildNotesView(ALL, INFO, new Set(), EMPTY_FILTER, { order: ['v2', 'v1'] }));
    expect(order.slice(0, 2)).toEqual(['v2', 'v1']);
    expect(new Set(order.slice(2))).toEqual(new Set(['other', 'gone']));
  });

  it('lists books, series and counts for the pickers', () => {
    const titles = bookChoices(ALL, INFO).map((b) => b.title);
    expect(titles).toHaveLength(4);
    expect(titles.indexOf('巻一')).toBeLessThan(titles.indexOf('巻二'));
    expect(new Set(titles)).toEqual(new Set(['Unknown book', '別の本', '巻一', '巻二']));
    expect(seriesChoices(ALL, INFO)).toEqual(['シリーズ']);
    expect(highlightCount(ALL, ['v1', 'v2', 'missing'])).toBe(3);
    expect(percentOf(250, 1000)).toBe('25.0%');
    expect(percentOf(250, null)).toBe('');
  });
});

const BIG = new Map<string, BookNotes>([
  [
    'h1',
    {
      highlights: [
        { ...hl('h1', 1, 1, 10), text: '涼宮ハルヒの憂鬱', chapter: 'プロローグ' },
        { ...hl('h1', 2, 3, 40, 'SOS団のこと'), text: '別の文' }
      ],
      notes: [{ ...bookNote('h1', 30), body: 'キョンの語り' }]
    }
  ],
  ['h2', { highlights: [{ ...hl('h2', 1, 2, 20), text: '消失した長門' }], notes: [] }],
  ['x', { highlights: [hl('x', 1, 1, 5), hl('x', 2, 1, 6), hl('x', 3, 1, 7)], notes: [] }],
  ['solo', { highlights: [{ ...hl('solo', 1, 4, 60), text: 'ＡＢＣの本' }], notes: [] }]
]);

const BIG_INFO = new Map<string, NotesBookInfo>([
  ['h1', { ...info('h1', '涼宮ハルヒの憂鬱', '涼宮ハルヒ', 1), authors: ['谷川流'] }],
  ['h2', { ...info('h2', '涼宮ハルヒの消失', '涼宮ハルヒ', 4), authors: ['谷川流'] }],
  ['x', { ...info('x', 'Another', 'アナザー', null), authors: ['綾辻行人'] }],
  ['solo', info('solo', '一冊だけ')]
]);

const q = (query: string) =>
  buildNotesView(
    BIG,
    BIG_INFO,
    new Set(),
    { ...EMPTY_FILTER, query },
    { sort: { key: 'title', dir: 'asc' } }
  );
const shownIds = (groups: ReturnType<typeof buildNotesView>) =>
  groups.flatMap((g) => [...g.highlights.map((r) => r.item.id), ...g.notes.map((n) => n.id)]);

describe('notes search', () => {
  it('a book that matches by title, author or series shows everything', () => {
    const groups = q('はるひ');
    expect(ids(groups).sort()).toEqual(['h1', 'h2']);
    expect(groups.every((g) => g.hit === 'book')).toBe(true);
    expect(groups.find((g) => g.info.id === 'h1')).toMatchObject({ total: 3 });
    expect(shownIds(q('谷川'))).toHaveLength(4);
  });

  it('otherwise only the items that match: text, note, chapter, book note', () => {
    expect(shownIds(q('別の文'))).toEqual(['h1:h2']);
    expect(shownIds(q('sos団'))).toEqual(['h1:h2']);
    expect(shownIds(q('ぷろろーぐ'))).toEqual(['h1:h1']);
    expect(shownIds(q('きょん'))).toEqual(['h1:n30']);
    expect(q('きょん')[0]).toMatchObject({ hit: 'items', total: 3 });
    // Width and case fold.
    expect(shownIds(q('abc'))).toEqual(['solo:h1']);
    expect(q('nothing here')).toEqual([]);
  });

  it('words may be split between the book and the item, in any order', () => {
    expect(shownIds(q('長門 ハルヒ'))).toEqual(['h2:h1']);
    expect(shownIds(q('ハルヒ 長門 キョン'))).toEqual([]);
  });

  it('combines with the filters', () => {
    const noted = buildNotesView(BIG, BIG_INFO, new Set(), { ...EMPTY_FILTER, withNote: true });
    expect(shownIds(noted)).toEqual(['h1:h2']);
    const noSeries = buildNotesView(BIG, BIG_INFO, new Set(), { ...EMPTY_FILTER, noSeries: true });
    expect(ids(noSeries)).toEqual(['solo']);
    const searchedSeries = buildNotesView(BIG, BIG_INFO, new Set(), {
      ...EMPTY_FILTER,
      series: '涼宮ハルヒ',
      query: '長門'
    });
    expect(shownIds(searchedSeries)).toEqual(['h2:h1']);
  });
});

describe('notes sorts, views and pages', () => {
  const sorted = (key: string, dir: 'asc' | 'desc') =>
    ids(buildNotesView(BIG, BIG_INFO, new Set(), EMPTY_FILTER, { sort: { key, dir } }));

  it('sorts books by change, title, author, series and count', () => {
    expect(sorted('changed', 'desc')).toEqual(['solo', 'h1', 'h2', 'x']);
    expect(sorted('changed', 'asc')).toEqual(['x', 'h2', 'h1', 'solo']);
    expect(sorted('title', 'asc')[0]).toBe('x');
    expect(sorted('title', 'desc')).toEqual([...sorted('title', 'asc')].reverse());
    // No author or no series goes last either way; a series keeps its volume order.
    expect(sorted('author', 'asc').at(-1)).toBe('solo');
    expect(sorted('author', 'desc').at(-1)).toBe('solo');
    const series = sorted('series', 'asc');
    expect(series.at(-1)).toBe('solo');
    expect(series.indexOf('h1')).toBe(series.indexOf('h2') - 1);
    expect(sorted('series', 'desc').at(-1)).toBe('solo');
    expect(sorted('count', 'desc')).toEqual(['x', 'h1', 'solo', 'h2']);
  });

  it('defaults: series order with a series filter, else the remembered or newest change', () => {
    expect(defaultBookSort({ ...EMPTY_FILTER, series: 'S' }, 'title-asc')).toEqual({
      key: 'series',
      dir: 'asc'
    });
    expect(defaultBookSort(EMPTY_FILTER, 'title-desc')).toEqual({ key: 'title', dir: 'desc' });
    expect(defaultBookSort(EMPTY_FILTER, 'bogus')).toEqual({ key: 'changed', dir: 'desc' });
    expect(defaultHighlightSort('')).toEqual({ key: 'created', dir: 'desc' });
    expect(defaultHighlightSort('book-asc')).toEqual({ key: 'book', dir: 'asc' });
  });

  it('flattens highlights and book notes, newest, oldest or by book', () => {
    const groups = buildNotesView(BIG, BIG_INFO, new Set(), EMPTY_FILTER);
    const newest = flattenNotesView(groups, { key: 'created', dir: 'desc' }).map((r) => r.key);
    expect(newest.slice(0, 3)).toEqual(['solo:h1', 'h1:h2', 'h1:n30']);
    expect(newest).toHaveLength(8);
    const oldest = flattenNotesView(groups, { key: 'created', dir: 'asc' }).map((r) => r.key);
    expect(oldest).toEqual([...newest].reverse());
    const byBook = flattenNotesView(groups, { key: 'book', dir: 'asc' });
    expect(byBook.slice(0, 3).map((r) => r.key)).toEqual(['x:h1', 'x:h2', 'x:h3']);
    // Within a book: its highlights in place order, then its notes.
    const h1 = byBook.filter((r) => r.book.id === 'h1').map((r) => r.key);
    expect(h1).toEqual(['h1:h1', 'h1:h2', 'h1:n30']);
    expect(byBook.find((r) => r.key === 'h1:n30')).toMatchObject({ highlight: null });
  });

  it('counts, pages and the pickers', () => {
    const groups = buildNotesView(BIG, BIG_INFO, new Set(), EMPTY_FILTER);
    expect(viewTotals(groups)).toEqual({ books: 4, highlights: 7, notes: 2 });
    const items = Array.from({ length: 45 }, (_, i) => i);
    expect(notesPage(items, 3, 20)).toMatchObject({
      items: [40, 41, 42, 43, 44],
      page: 2,
      from: 41
    });
    expect(notesPage(items, 9, 20).page).toBe(2);
    expect(notesPage(items, 0, 20).page).toBe(0);
    expect(notesPage([], 1, 20)).toMatchObject({ items: [], pages: 1 });
    expect(seriesHighlightCounts(BIG, BIG_INFO)).toEqual(
      new Map([
        ['涼宮ハルヒ', 4],
        ['アナザー', 3],
        ['', 1]
      ])
    );
    expect(unplacedCount(BIG, new Set(['x:h2', 'gone:h1']))).toBe(1);
    expect(unplacedCount(BIG, new Set())).toBe(0);
  });
});

describe('pending jump', () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map
    };
  };

  it('is taken once, by the reader of the same book', () => {
    const s = storage();
    setPendingJump({ bookId: 'b1', highlightId: 'b1:h', position: 120 }, s);
    expect(takePendingJump('b1', s)).toEqual({ bookId: 'b1', highlightId: 'b1:h', position: 120 });
    expect(takePendingJump('b1', s)).toBeUndefined();
  });

  it('another book clears it; it survives a page load through sessionStorage', () => {
    const s = storage();
    setPendingJump({ bookId: 'b1', highlightId: null, position: 5 }, s);
    expect(takePendingJump('b2', s)).toBeUndefined();
    expect(takePendingJump('b1', s)).toBeUndefined();

    s.map.set('ttu-pending-jump', JSON.stringify({ bookId: 'b1', highlightId: null, position: 7 }));
    expect(takePendingJump('b1', s)).toMatchObject({ position: 7 });
    s.map.set('ttu-pending-jump', '{"bookId":"b1","position":"x"}');
    expect(takePendingJump('b1', s)).toBeUndefined();
    setPendingJump({ bookId: 'b1', highlightId: null, position: 5 }, s);
    clearPendingJump(s);
    expect(takePendingJump('b1', s)).toBeUndefined();
  });
});
