/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  bookRecordId,
  entryOf,
  filterEntries,
  fnv1a64,
  groupForBook,
  libraryKey,
  libraryRecordId,
  pruneIds,
  toPrune,
  type HistoryEntry
} from './search-history';

const lib = (query: string, usedAt: number): HistoryEntry => ({
  id: libraryRecordId(query),
  scope: 'lib',
  query,
  usedAt
});
const book = (bookKey: string, query: string, usedAt: number, title = ''): HistoryEntry => ({
  id: bookRecordId(bookKey, query),
  scope: 'book',
  query,
  usedAt,
  book: bookKey,
  title
});

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64 test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

describe('record ids', () => {
  it('gives the same library search one id however it is spaced', () => {
    expect(libraryKey('  author:西尾   tag:SF ')).toBe('author:西尾 tag:SF');
    expect(libraryRecordId('author:西尾  tag:SF')).toBe(libraryRecordId(' author:西尾 tag:SF'));
    expect(libraryRecordId('tag:SF')).not.toBe(libraryRecordId('tag:sf'));
    expect(libraryRecordId('x')).toMatch(/^lib:[0-9a-f]{16}$/);
  });

  it('gives a book search one id per book, folded like the search itself', () => {
    expect(bookRecordId('b1', 'ＡＢＣ　です')).toBe(bookRecordId('b1', 'abcです'));
    expect(bookRecordId('b1', '怪異')).not.toBe(bookRecordId('b2', '怪異'));
    expect(bookRecordId('b1', '怪異')).toMatch(/^book:[0-9a-f]{16}$/);
  });
});

describe('entryOf', () => {
  it('reads live records and skips deleted or broken ones', () => {
    const id = libraryRecordId('q');
    expect(entryOf({ id, deletedAt: null, data: { query: 'q', usedAt: 5 } })).toEqual({
      id,
      scope: 'lib',
      query: 'q',
      usedAt: 5
    });
    expect(entryOf({ id, deletedAt: 9, data: {} })).toBeNull();
    expect(entryOf({ id: 'book:1', deletedAt: null, data: { query: 'q', usedAt: 1 } })).toBeNull();
    expect(
      entryOf({ id: 'book:1', deletedAt: null, data: { query: 'q', usedAt: 1, book: 'b' } })
    ).toEqual({ id: 'book:1', scope: 'book', query: 'q', usedAt: 1, book: 'b', title: '' });
  });
});

describe('filterEntries', () => {
  const entries = [lib('author:西尾維新', 1), lib('series:物語', 3), lib('tag:SF', 2)];

  it('lists everything newest first when nothing is typed', () => {
    expect(filterEntries(entries, '').map((e) => e.query)).toEqual([
      'series:物語',
      'tag:SF',
      'author:西尾維新'
    ]);
  });

  it('narrows by every typed word, folding width, case and kana', () => {
    expect(filterEntries(entries, 'ｓｆ').map((e) => e.query)).toEqual(['tag:SF']);
    expect(filterEntries([lib('カタカナ', 1)], 'かたかな')).toHaveLength(1);
    expect(filterEntries(entries, 'author 西尾').map((e) => e.query)).toEqual(['author:西尾維新']);
  });

  it('leaves out the entry that is exactly what is typed', () => {
    expect(filterEntries(entries, ' tag:SF ').map((e) => e.query)).toEqual([]);
  });
});

describe('groupForBook', () => {
  it("puts this book's searches first and other books' once each", () => {
    const entries = [
      book('A', '怪異', 5, 'A'),
      book('B', '吸血鬼', 4, 'B'),
      book('C', '吸血鬼', 6, 'C'),
      book('B', '怪異', 7, 'B'),
      book('A', '忍野', 2, 'A'),
      lib('tag:SF', 9)
    ];
    const { thisBook, otherBooks } = groupForBook(entries, 'A');
    expect(thisBook.map((e) => e.query)).toEqual(['怪異', '忍野']);
    expect(otherBooks.map((e) => `${e.book}:${e.query}`)).toEqual(['C:吸血鬼']);
  });
});

describe('pruning', () => {
  it('removes the oldest beyond the limit', () => {
    const entries = [lib('a', 1), lib('b', 3), lib('c', 2)];
    expect(toPrune(entries, 2).map((e) => e.query)).toEqual(['a']);
    expect(toPrune(entries, 5)).toEqual([]);
  });

  it('keeps each book to its own limit', () => {
    const entries = [
      lib('x', 1),
      lib('y', 2),
      book('A', '1', 1),
      book('A', '2', 2),
      book('A', '3', 3),
      book('B', '1', 1)
    ];
    expect(new Set(pruneIds(entries, { library: 1, perBook: 2 }))).toEqual(
      new Set([libraryRecordId('x'), bookRecordId('A', '1')])
    );
  });
});
