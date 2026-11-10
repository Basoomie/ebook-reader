/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';
import { bookStateFrom, isCurrentReadThroughPosition, type BookState } from '$lib/sync/book-state';

/**
 * A book's progress for the library info line (WP7a): "Finished" for Completed books,
 * otherwise the newest place of the current read (any device), as a whole percent.
 * Null when there is nothing to show (never opened, or no way to tell).
 */
export function bookProgressLabel(
  bookId: string,
  state: BookState | undefined,
  positions: readonly LocalRecord[],
  charCount: number | null
): string | null {
  if (state?.status === 'completed') return 'Finished';
  const current = state ?? bookStateFrom(bookId, []);
  let newest: LocalRecord | null = null;
  for (const p of positions) {
    if (p.deletedAt !== null || p.bookId !== bookId) continue;
    if (!isCurrentReadThroughPosition(current, p)) continue;
    if (!newest || p.updatedAt > newest.updatedAt) newest = p;
  }
  if (!newest) return null;
  const progress = newest.data?.progress;
  let fraction: number | null = typeof progress === 'number' ? progress : null;
  const charPos = newest.data?.charPos;
  if (fraction === null && typeof charPos === 'number' && charCount) fraction = charPos / charCount;
  if (fraction === null || !Number.isFinite(fraction)) return null;
  const percent = Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
  return `${percent}%`;
}

/** Positions grouped by book, for many books at once. */
export function positionsByBook(records: readonly LocalRecord[]): Map<string, LocalRecord[]> {
  const out = new Map<string, LocalRecord[]>();
  for (const r of records) {
    if (!r.bookId) continue;
    const list = out.get(r.bookId) ?? [];
    list.push(r);
    out.set(r.bookId, list);
  }
  return out;
}

/** "3/12 read": how many of a series' books are Completed. */
export function seriesReadCount(
  bookIds: readonly string[],
  states: ReadonlyMap<string, BookState>
): number {
  return bookIds.filter((id) => states.get(id)?.status === 'completed').length;
}
