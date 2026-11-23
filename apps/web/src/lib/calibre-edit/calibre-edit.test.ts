/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  changedFields,
  dateInputValue,
  descriptionText,
  ratingText,
  starGlyphs,
  tapStar,
  valueText,
  whoText
} from './format';
import { NAME_MAX_BYTES, authorNameBytes, calibreNameBytes } from './names';
import { editableBook, notWritten, stillWaiting, withSaved } from './overlay';
import type { EditValues, HistoryEntry } from './types';
import type { CatalogBookDetail } from '$lib/library/types';

const values: EditValues = {
  title: '題名',
  sort: 'だいめい',
  authors: ['作者'],
  author_sort: 'サクシャ',
  illustrator: [],
  series: { name: 'S', index: 1 },
  publisher: null,
  pubdate: Date.UTC(2020, 4, 1, 15),
  languages: ['jpn'],
  rating: null,
  description: 'あらすじ',
  tags: ['B', 'a'],
  identifiers: { amazon_jp: 'B0X' }
};

describe('the edit form’s helpers', () => {
  it('rates in half stars: a second tap on the same star is a half star', () => {
    expect(tapStar(null, 4)).toBe(8);
    expect(tapStar(8, 4)).toBe(7);
    expect(tapStar(7, 4)).toBe(8);
    expect(starGlyphs(7)).toEqual(['full', 'full', 'full', 'half', 'empty']);
    expect(ratingText(9)).toBe('4.5 of 5');
    expect(ratingText(null)).toBe('No rating');
  });

  it('sends only what changed (tags as a set, a date by its day, empty ids dropped)', () => {
    const now = structuredClone(values);
    now.tags = ['a', 'B'];
    now.pubdate = Date.UTC(2020, 4, 1, 12);
    now.identifiers = { amazon_jp: 'B0X', isbn: '' };
    expect(changedFields(values, now)).toEqual([]);
    now.title = '新しい';
    now.rating = 9;
    expect(changedFields(values, now)).toEqual(['title', 'rating']);
  });

  it('shows dates, descriptions and values in plain words', () => {
    expect(dateInputValue(Date.UTC(2020, 4, 1, 12))).toBe('2020-05-01');
    expect(dateInputValue(null)).toBe('');
    expect(descriptionText('<p>一</p><p>二</p>')).toBe('一\n\n二');
    expect(valueText('series', { name: 'S', index: 3.5 })).toBe('S · #3.5');
    expect(valueText('tags', { added: ['x'] })).toBe('+ x');
    expect(valueText('rating', 7)).toBe('3.5 of 5');
    expect(valueText('authors', [])).toBe('(none)');
    const e = { who: 'cleanup', stage: 4, via: null } as HistoryEntry;
    expect(whoText(e)).toBe('Cleanup · stage 4');
    expect(whoText({ ...e, who: 'calibre' })).toBe('Changed in Calibre');
  });

  it('counts Calibre’s names like the server', () => {
    expect(calibreNameBytes(48213, '月と灯台', '水瀬 葵')).toBeLessThan(NAME_MAX_BYTES);
    expect(calibreNameBytes(1, '長'.repeat(90), '作者')).toBeGreaterThan(NAME_MAX_BYTES);
    expect(authorNameBytes(1, 'A'.repeat(300))).toBeLessThan(NAME_MAX_BYTES);
    expect(authorNameBytes(1, 'あ'.repeat(100))).toBeGreaterThan(NAME_MAX_BYTES);
  });
});

describe('the page after a save', () => {
  const book = {
    id: 'b',
    libraryId: 'l',
    title: '古い',
    authors: [{ name: 'A', sort: null }],
    series: null,
    tags: [],
    addedAt: 0,
    charCount: null,
    missing: false,
    thumbnail: null,
    sources: [
      {
        kind: 'calibre',
        libraryId: 'l',
        calibreUuid: 'u',
        calibreId: 1,
        filePath: 'f',
        fileSize: 1,
        missingAt: null
      }
    ]
  } as unknown as CatalogBookDetail;

  it('shows the saved values over the library’s until it has them', () => {
    const shown = withSaved(book, { title: '新しい', series: { name: 'S', index: 2 }, rating: 8 });
    expect(shown).toMatchObject({ title: '新しい', series: { name: 'S', index: 2 }, rating: 8 });
    expect(withSaved(book, null)).toBe(book);
    expect(stillWaiting([{ state: 'written' } as never])).toBe(true);
    expect(stillWaiting([{ state: 'shown' } as never])).toBe(false);
    expect(notWritten([{ state: 'not_written', field: 'title' } as never])).toHaveLength(1);
  });

  it('only a Calibre book in the library can be edited', () => {
    expect(editableBook(book)).toBe(true);
    expect(editableBook({ ...book, missing: true })).toBe(false);
    expect(editableBook({ ...book, sources: [{ ...book.sources[0], kind: 'upload' }] })).toBe(
      false
    );
  });
});
