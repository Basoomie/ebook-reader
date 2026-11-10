/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { furthestPosition } from '$lib/library/progress';
import { bookStateFrom, isCurrentReadThroughPosition, type BookState } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * Home's Continue Reading row (WP7b), from the local mirror (works offline):
 * books whose current read has a place past the start on any device
 * (furthestPosition, so places from before "Start over" don't count), plus books
 * marked Reading without such a place. Completed and Dropped books are left out.
 * Newest activity first: the newest current-read position on any device; Reading
 * books without one come last.
 */
export function continueReadingIds(
  states: ReadonlyMap<string, BookState>,
  positions: ReadonlyMap<string, readonly LocalRecord[]>,
  limit: number
): string[] {
  const placed: { id: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const [bookId, records] of positions) {
    const state = states.get(bookId);
    if (state?.status === 'completed' || state?.status === 'dropped') continue;
    const current = (records as LocalRecord[]).filter(
      (r) =>
        r.deletedAt === null &&
        r.bookId === bookId &&
        isCurrentReadThroughPosition(state ?? bookStateFrom(bookId, []), r)
    );
    const best = furthestPosition(bookId, state, current, null);
    const pastStart =
      (best !== null && best.fraction > 0) ||
      current.some((r) => typeof r.data?.charPos === 'number' && r.data.charPos > 0);
    if (!pastStart) continue;
    placed.push({ id: bookId, at: Math.max(...current.map((r) => r.updatedAt)) });
    seen.add(bookId);
  }
  placed.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  const reading = [...states.values()]
    .filter((s) => s.status === 'reading' && !seen.has(s.bookId))
    .map((s) => s.bookId)
    .sort();
  return [...placed.map((p) => p.id), ...reading].slice(0, Math.max(0, limit));
}
