/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { NativelyLevelAnswer } from './api';
import { hasDirectNatively, timeLeftText, withNativelyLevel } from './natively-level';
import { summaryOf } from './offline/copies';
import { bookComparator } from './offline/sort';
import type { CatalogBookDetail } from './types';

function book(id: string, over: Partial<CatalogBookDetail> = {}): CatalogBookDetail {
  return {
    id,
    libraryId: 'lib1',
    title: `Title ${id}`,
    authors: [{ name: 'A', sort: null }],
    series: null,
    tags: [],
    addedAt: 1,
    charCount: 1000,
    missing: false,
    thumbnail: null,
    source: 'calibre',
    description: null,
    sources: [],
    ...over
  };
}

const answer = (level: number | null, temporary = false): NativelyLevelAnswer => ({
  nativelyId: 'abc123',
  level,
  temporary,
  state: level === null ? 'none' : 'ok',
  checkedAt: 1
});

describe('hasDirectNatively', () => {
  it('needs a saved Natively id the links take as direct', () => {
    expect(hasDirectNatively(book('a', { identifiers: { natively: 'f1d9f42920' } }))).toBe(true);
    expect(hasDirectNatively(book('b', { identifiers: { natively: 'not an id' } }))).toBe(false);
    expect(hasDirectNatively(book('c', { identifiers: {} }))).toBe(false);
    expect(hasDirectNatively(book('d'))).toBe(false);
    expect(
      hasDirectNatively(book('e', { source: 'upload', identifiers: { natively: 'abc' } }))
    ).toBe(false);
  });
});

describe('withNativelyLevel', () => {
  it('lays a fresh answer over the book, and keeps the same object when nothing changed', () => {
    const b = book('a', { nativelyLevel: { level: 29, temporary: false } });
    expect(withNativelyLevel(b, answer(29))).toBe(b);
    expect(withNativelyLevel(b, answer(25, true)).nativelyLevel).toEqual({
      level: 25,
      temporary: true
    });
    expect(withNativelyLevel(b, answer(null)).nativelyLevel).toBeNull();
    const none = book('n');
    expect(withNativelyLevel(none, answer(null))).toBe(none);
  });
});

describe('the level offline', () => {
  it('is part of the summary, so a changed level refreshes the offline copy', () => {
    const before = summaryOf(book('a', { nativelyLevel: { level: 29, temporary: true } }));
    const after = summaryOf(book('a', { nativelyLevel: { level: 29, temporary: false } }));
    expect(before.nativelyLevel).toEqual({ level: 29, temporary: true });
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });

  it('sorts easiest or hardest first, books without a level last', () => {
    const books = [
      book('none'),
      book('hard', { nativelyLevel: { level: 31, temporary: false } }),
      book('easy', { nativelyLevel: { level: 12, temporary: true } })
    ];
    const ids = (dir: 'asc' | 'desc') =>
      [...books].sort(bookComparator({ key: 'level', dir })).map((b) => b.id);
    expect(ids('asc')).toEqual(['easy', 'hard', 'none']);
    expect(ids('desc')).toEqual(['hard', 'easy', 'none']);
  });
});

describe('timeLeftText', () => {
  it('says the first pass time left in plain words', () => {
    expect(timeLeftText(0)).toBe('');
    expect(timeLeftText(30)).toBe('less than a minute left');
    expect(timeLeftText(12 * 60)).toBe('about 12 min left');
    expect(timeLeftText(5 * 3600 + 12 * 60)).toBe('about 5 h 12 min left');
    expect(timeLeftText(7 * 3600)).toBe('about 7 h left');
  });
});
