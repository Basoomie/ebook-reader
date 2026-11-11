/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { detailRows, formatDate, formatFileSize } from './book-details';
import type { CatalogBookDetail } from './types';

const book: CatalogBookDetail = {
  id: 'b1',
  libraryId: 'lib',
  title: '月と灯台 3',
  authors: [
    { name: '水瀬 葵', sort: null },
    { name: '七尾 ゆき', sort: null }
  ],
  series: { name: '月と灯台', index: 3 },
  tags: ['青春'],
  addedAt: Date.UTC(2026, 9, 2),
  publishedAt: Date.UTC(2024, 2, 15),
  publisher: '灯台文庫',
  charCount: 182406,
  charCountStatus: 'counted',
  missing: false,
  thumbnail: null,
  source: 'calibre',
  sources: [
    {
      kind: 'calibre',
      libraryId: 'lib',
      calibreUuid: 'u',
      calibreId: 1,
      filePath: 'a.epub',
      fileSize: 4.4 * 1024 * 1024,
      missingAt: null
    }
  ]
};

describe('book details', () => {
  it('formats dates and sizes', () => {
    expect(formatDate(Date.UTC(2024, 2, 15))).toBe('2024-03-15');
    expect(formatDate(null)).toBe('');
    expect(formatFileSize(4.4 * 1024 * 1024)).toBe('4.4 MB');
    expect(formatFileSize(500_000)).toBe('488 KB');
    expect(formatFileSize(0)).toBe('');
  });

  it('lists the known details and leaves out the empty ones', () => {
    expect(detailRows(book, 'Light novels').map((r) => `${r.label}: ${r.value}`)).toEqual([
      'Title: 月と灯台 3',
      'Author: 水瀬 葵, 七尾 ゆき',
      'Series: 月と灯台 · #3',
      'Publisher: 灯台文庫',
      'Published: 2024-03-15',
      'Added: 2026-10-02',
      'Length: 182,406 characters',
      'File size: 4.4 MB',
      'Library: Light novels · Calibre'
    ]);
    const upload = {
      ...book,
      series: null,
      publisher: null,
      publishedAt: null,
      source: 'upload' as const
    };
    const labels = detailRows(upload, '').map((r) => r.label);
    expect(labels).not.toContain('Series');
    expect(labels).not.toContain('Publisher');
    expect(detailRows(upload, '').find((r) => r.label === 'Library')?.value).toBe('Uploaded');
    const counting = { ...book, charCount: null, charCountStatus: 'pending' as const };
    expect(detailRows(counting, '').find((r) => r.label === 'Length')?.value).toBe('Counting…');
  });
});
