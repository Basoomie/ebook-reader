/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CatalogBook, CatalogGroup, GroupChars } from '$lib/library/types';

/** Library wording (WP7a): everyday words only, no design-doc terms. */

export function formatSeriesIndex(index: number): string {
  return Number.isInteger(index) ? String(index) : index.toFixed(1);
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * A group's character total and how complete it is:
 * "1,234,567 chars", "1,234,567+ chars · 2 still counting",
 * "1,234,567+ chars · 1 couldn't be counted", or "Counting…" before any count.
 */
export function formatGroupChars(chars: GroupChars): string {
  if (chars.counted === 0 && chars.total === 0) {
    return chars.pending > 0 ? 'Counting…' : '';
  }
  const incomplete = chars.pending + chars.failed > 0;
  const parts = [`${chars.total.toLocaleString()}${incomplete ? '+' : ''} chars`];
  if (chars.pending > 0) parts.push(`${chars.pending.toLocaleString()} still counting`);
  if (chars.failed > 0) parts.push(`${chars.failed.toLocaleString()} couldn't be counted`);
  return parts.join(' · ');
}

export function groupTitle(group: Pick<CatalogGroup, 'by' | 'name'>): string {
  return group.name ?? 'No series';
}

/** "12 volumes" for a series, "12 books" otherwise. */
export function groupCount(group: Pick<CatalogGroup, 'by' | 'name' | 'bookCount'>): string {
  return group.by === 'series' && group.name !== null
    ? plural(group.bookCount, 'volume', 'volumes')
    : plural(group.bookCount, 'book', 'books');
}

export function authorNames(book: Pick<CatalogBook, 'authors'>): string {
  return book.authors.map((a) => a.name).join(', ');
}

/**
 * WP19a: the Library page of an author (the Authors tab, opened on that author), keeping
 * the picked library when there is one. `pagePath` is the app's base path.
 */
export function authorHref(pagePath: string, name: string, library = ''): string {
  const params = new URLSearchParams({ tab: 'authors', group: name });
  if (library) params.set('lib', library);
  return `${pagePath}/library?${params.toString()}`;
}

/** WP19c: a catalog book's details page. */
export function bookDetailsHref(pagePath: string, bookId: string): string {
  return `${pagePath}/library/book?id=${encodeURIComponent(bookId)}`;
}

/** "#3" when the book has a series number. */
export function seriesNumber(book: Pick<CatalogBook, 'series'>): string {
  return book.series?.index !== null && book.series?.index !== undefined
    ? `#${formatSeriesIndex(book.series.index)}`
    : '';
}
