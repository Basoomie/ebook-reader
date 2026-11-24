/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';

/**
 * Search history (2026-11-24), the same on every device like the history itself.
 * Off: nothing is remembered and no list is shown; what was kept stays until cleared.
 */
export const searchHistoryOn$ = writableBooleanLocalStorageSubject()('searchHistoryOn', true);

/** How many library searches are kept (the oldest beyond this are removed). */
export const searchHistoryLimit$ = writableNumberLocalStorageSubject()('searchHistoryLimit', 30);

/** "Search in this book": off = nothing remembered, no list. */
export const bookSearchHistoryOn$ = writableBooleanLocalStorageSubject()(
  'bookSearchHistoryOn',
  true
);

/** How many searches are kept for each book. */
export const bookSearchHistoryLimit$ = writableNumberLocalStorageSubject()(
  'bookSearchHistoryLimit',
  20
);

export const SEARCH_HISTORY_LIMIT_MIN = 1;
export const SEARCH_HISTORY_LIMIT_MAX = 200;

/** A stored limit as a usable count (a bad value reads as the given default). */
export function historyLimit(value: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SEARCH_HISTORY_LIMIT_MAX, Math.max(SEARCH_HISTORY_LIMIT_MIN, n));
}
