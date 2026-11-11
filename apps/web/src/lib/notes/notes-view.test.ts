/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { BookNotes, HighlightColor, HighlightItem, NoteItem } from './highlights';
import {
  bookChoices,
  buildNotesView,
  EMPTY_FILTER,
  highlightCount,
  isFiltered,
  notesFilterQuery,
  parseNotesFilter,
  percentOf,
  seriesChoices,
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
      colors: new Set([3, 1]),
      unplacedOnly: true
    });
    expect(notesFilterQuery(filter)).toBe('?book=b1&series=%E3%82%B7&color=1%2C3&unplaced=1');
    expect(notesFilterQuery(EMPTY_FILTER)).toBe('');
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
    expect(isFiltered(filter)).toBe(true);
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
