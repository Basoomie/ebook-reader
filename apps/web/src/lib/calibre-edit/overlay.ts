/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CatalogBookDetail } from '$lib/library/types';
import type { EditValues, FieldStatus } from './types';

/**
 * The book as the page shows it right after a save (design: "the page shows the new values at
 * once ... until the index catches up"): the saved values over the library's.
 */
export function withSaved(
  book: CatalogBookDetail,
  saved: Partial<EditValues> | null
): CatalogBookDetail {
  if (!saved) return book;
  const out: CatalogBookDetail = { ...book };
  if (saved.title !== undefined) out.title = saved.title;
  if (saved.sort !== undefined) out.titleSort = saved.sort;
  if (saved.authors !== undefined)
    out.authors = saved.authors.map((name) => ({ name, sort: null }));
  if (saved.author_sort !== undefined) out.authorSort = saved.author_sort;
  if (saved.illustrator !== undefined) out.illustrators = saved.illustrator;
  if (saved.series !== undefined)
    out.series = saved.series.name ? { name: saved.series.name, index: saved.series.index } : null;
  if (saved.publisher !== undefined) out.publisher = saved.publisher;
  if (saved.pubdate !== undefined) out.publishedAt = saved.pubdate;
  if (saved.tags !== undefined) out.tags = saved.tags;
  if (saved.description !== undefined) out.description = saved.description;
  if (saved.rating !== undefined) out.rating = saved.rating;
  if (saved.languages !== undefined) out.languages = saved.languages;
  if (saved.identifiers !== undefined) out.identifiers = saved.identifiers;
  return out;
}

/** Whether the library still has to show a saved edit (the page keeps polling). */
export function stillWaiting(status: FieldStatus[]): boolean {
  return status.some(
    (s) => s.state === 'waiting' || s.state === 'writing' || s.state === 'written'
  );
}

/** The fields the library didn't take, with why (shown on the page). */
export function notWritten(status: FieldStatus[]): FieldStatus[] {
  return status.filter((s) => s.state === 'not_written');
}

/** Whether a Calibre book (present) can be edited at all. */
export function editableBook(book: CatalogBookDetail | null): boolean {
  return (
    !!book &&
    !book.missing &&
    book.sources.some((s) => s.kind === 'calibre' && s.missingAt === null)
  );
}
