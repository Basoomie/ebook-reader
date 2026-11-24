/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookSortKey, GroupSortKey, ServerSort, SortDir } from '$lib/library/sort';
import type { CatalogBook } from '$lib/library/types';

/**
 * The server's list orders (apps/storage-server/src/catalog/sort.ts and groups.ts), for the
 * offline Library:
 *
 * - books: date added, title (Calibre's title sort, else the title), author (author sort),
 *   length, publication date, Natively level; ties by id in the same direction; books without a value
 *   always last (a high or low stand-in per direction, like the server's SQL);
 * - strings compare by code point (SQLite's BINARY collation on UTF-8);
 * - inside a series without a sort: series index (none = -1), then date added, then id;
 * - groups: newest book, name or size; "No series" always last; ties by name (A→Z,
 *   JavaScript string order as on the server).
 */

const HIGH_NUMBER = 9000000000000000;
const HIGH_TEXT = String.fromCodePoint(0x10ffff);

/** Code point order (SQLite BINARY on UTF-8), unlike `<` on UTF-16 code units. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function sortValue(book: CatalogBook, key: BookSortKey, dir: SortDir): number | string {
  const asc = dir === 'asc';
  switch (key) {
    case 'added':
      return book.addedAt;
    case 'title':
      return book.titleSort ?? book.title;
    case 'author':
      return book.authorSort ?? (asc ? HIGH_TEXT : '');
    case 'chars':
      // A count of 0 goes with the books not counted (the server's migration 28).
      return asc ? book.charCount || HIGH_NUMBER : (book.charCount ?? -1);
    case 'published':
      return book.publishedAt ?? (asc ? HIGH_NUMBER : -HIGH_NUMBER);
    case 'level':
      return book.nativelyLevel?.level ?? (asc ? HIGH_NUMBER : -1);
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  return compareCodePoints(String(a), String(b));
}

/** The default list order: newest added first. */
export const DEFAULT_SORT: ServerSort<BookSortKey> = { key: 'added', dir: 'desc' };

/** A book comparator for a sort (ties by id in the same direction). */
export function bookComparator(
  sort: ServerSort<BookSortKey> = DEFAULT_SORT
): (a: CatalogBook, b: CatalogBook) => number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return (a, b) =>
    sign *
    (compareValues(sortValue(a, sort.key, sort.dir), sortValue(b, sort.key, sort.dir)) ||
      compareCodePoints(a.id, b.id));
}

/** Series order: index (none = -1), date added, id. */
export function seriesOrder(a: CatalogBook, b: CatalogBook): number {
  const ai = a.series?.index ?? -1;
  const bi = b.series?.index ?? -1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return compareCodePoints(a.id, b.id);
}

/** Newest added first, then id descending (collages, collection members). */
export function newestFirst(a: CatalogBook, b: CatalogBook): number {
  if (a.addedAt !== b.addedAt) return a.addedAt > b.addedAt ? -1 : 1;
  return -compareCodePoints(a.id, b.id);
}

/** A collage's "lowest-index volume": index (none last), date added, id. */
export function volumeOrder(a: CatalogBook, b: CatalogBook): number {
  const ai = a.series?.index ?? 1e18;
  const bi = b.series?.index ?? 1e18;
  if (ai !== bi) return ai < bi ? -1 : 1;
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return compareCodePoints(a.id, b.id);
}

export interface GroupSortRow {
  name: string | null;
  bookCount: number;
  newestAddedAt: number;
}

/** groups.ts groupComparator: "No series" last; ties by name ascending. */
export function groupComparator(
  sort: ServerSort<GroupSortKey> = { key: 'newest', dir: 'desc' }
): (a: GroupSortRow, b: GroupSortRow) => number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const names = (a: GroupSortRow, b: GroupSortRow) => {
    const an = a.name ?? '';
    const bn = b.name ?? '';
    return an < bn ? -1 : an > bn ? 1 : 0;
  };
  return (a, b) => {
    if ((a.name === null) !== (b.name === null)) return a.name === null ? 1 : -1;
    if (sort.key === 'name') return sign * names(a, b);
    const diff =
      sort.key === 'count' ? a.bookCount - b.bookCount : a.newestAddedAt - b.newestAddedAt;
    if (diff !== 0) return sign * diff;
    return names(a, b);
  };
}
