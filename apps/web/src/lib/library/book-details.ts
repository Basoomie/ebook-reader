/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { formatBookCharCount } from './char-counts';
import { formatSeriesIndex } from './format';
import type { CatalogBookDetail } from './types';

/**
 * WP19c: what the book details page shows, as plain data (tested without a page).
 */

/** "2024-03-15" (UTC, as Calibre stores dates), or ''. */
export function formatDate(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** "4.4 MB", "820 KB", or ''. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface DetailRow {
  /** The small Japanese label (書名, 著者…). */
  jp: string;
  label: string;
  value: string;
}

/** The "About this book" rows; rows without a value are left out. */
export function detailRows(book: CatalogBookDetail, libraryName: string): DetailRow[] {
  const source = book.sources.find((s) => !s.missingAt) ?? book.sources[0];
  const length =
    book.charCount !== null && (book.charCountStatus ?? 'counted') === 'counted'
      ? `${book.charCount.toLocaleString('en')} characters`
      : formatBookCharCount(book);
  const rows: DetailRow[] = [
    { jp: '書名', label: 'Title', value: book.title },
    { jp: '著者', label: 'Author', value: book.authors.map((a) => a.name).join(', ') },
    {
      jp: '叢書',
      label: 'Series',
      value: book.series
        ? `${book.series.name}${book.series.index !== null ? ` · #${formatSeriesIndex(book.series.index)}` : ''}`
        : ''
    },
    { jp: '出版', label: 'Publisher', value: book.publisher ?? '' },
    { jp: '刊行', label: 'Published', value: formatDate(book.publishedAt) },
    { jp: '追加', label: 'Added', value: formatDate(book.addedAt) },
    { jp: '文字数', label: 'Length', value: length },
    { jp: '容量', label: 'File size', value: formatFileSize(source?.fileSize) },
    {
      jp: '所蔵',
      label: 'Library',
      value: [libraryName, book.source === 'upload' ? 'Uploaded' : 'Calibre']
        .filter(Boolean)
        .join(' · ')
    }
  ];
  return rows.filter((r) => r.value);
}
