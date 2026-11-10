/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';
import { bookStateFrom, isCurrentReadThroughPosition, type BookState } from '$lib/sync/book-state';

/** A position record's place as a fraction of the book (null when it can't tell). */
function positionFraction(p: LocalRecord, charCount: number | null): number | null {
  const progress = p.data?.progress;
  let fraction: number | null = typeof progress === 'number' ? progress : null;
  const charPos = p.data?.charPos;
  if (fraction === null && typeof charPos === 'number' && charCount) fraction = charPos / charCount;
  if (fraction === null || !Number.isFinite(fraction)) return null;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * How far into the current read a book is, across every device (WP8b, decided with the
 * user): the furthest place any device saved for the current read, newest on a tie.
 * Places of an earlier read (before "Start over") don't count. Fractions compare
 * copies with different character counts correctly. Null when nothing is known.
 */
export function furthestPosition(
  bookId: string,
  state: BookState | undefined,
  positions: readonly LocalRecord[],
  charCount: number | null
): { record: LocalRecord; fraction: number } | null {
  const current = state ?? bookStateFrom(bookId, []);
  let best: { record: LocalRecord; fraction: number } | null = null;
  for (const p of positions) {
    if (p.deletedAt !== null || p.bookId !== bookId) continue;
    if (!isCurrentReadThroughPosition(current, p)) continue;
    const fraction = positionFraction(p, charCount);
    if (fraction === null) continue;
    if (
      !best ||
      fraction > best.fraction ||
      (fraction === best.fraction && p.updatedAt > best.record.updatedAt)
    ) {
      best = { record: p, fraction };
    }
  }
  return best;
}

/**
 * A book's progress for the library info line: "Finished" for Completed books,
 * otherwise the furthest place of the current read on any device (furthestPosition),
 * as a whole percent. Null when there is nothing to show (never opened, or no way to tell).
 */
export function bookProgressLabel(
  bookId: string,
  state: BookState | undefined,
  positions: readonly LocalRecord[],
  charCount: number | null
): string | null {
  if (state?.status === 'completed') return 'Finished';
  const best = furthestPosition(bookId, state, positions, charCount);
  return best ? `${Math.floor(best.fraction * 100)}%` : null;
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
