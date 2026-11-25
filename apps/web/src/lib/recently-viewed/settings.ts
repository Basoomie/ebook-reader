/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';
import {
  DWELL_DEFAULT,
  DWELL_MAX,
  KEEP_BOOKS_DEFAULT,
  KEEP_BOOKS_MAX,
  KEEP_BOOKS_MIN,
  KEEP_DAYS_DEFAULT,
  KEEP_DAYS_MAX,
  KEEP_DAYS_MIN,
  clampSetting,
  keepMode,
  type Keep,
  type KeepMode
} from './recently-viewed';

/**
 * Recently viewed (2026-11-24), the same on every device like the list itself (every
 * device trims it the same way). Off: nothing new is remembered and the row shows nothing;
 * what was kept stays until cleared.
 */
export const recentlyViewedOn$ = writableBooleanLocalStorageSubject()('recentlyViewedOn', true);

/** How long a book's details page stays open (and visible) before it counts; 0 = at once. */
export const recentlyViewedDwellSeconds$ = writableNumberLocalStorageSubject()(
  'recentlyViewedDwellSeconds',
  DWELL_DEFAULT
);

/** What is kept: the last N books, the last N days, or everything. */
export const recentlyViewedKeep$ = writableStringLocalStorageSubject<KeepMode>()(
  'recentlyViewedKeep',
  'books'
);
export const recentlyViewedKeepBooks$ = writableNumberLocalStorageSubject()(
  'recentlyViewedKeepBooks',
  KEEP_BOOKS_DEFAULT
);
export const recentlyViewedKeepDays$ = writableNumberLocalStorageSubject()(
  'recentlyViewedKeepDays',
  KEEP_DAYS_DEFAULT
);

/** The current limit, with bad stored values read as the defaults. */
export function currentKeep(): Keep {
  return {
    mode: keepMode(recentlyViewedKeep$.getValue()),
    books: clampSetting(
      recentlyViewedKeepBooks$.getValue(),
      KEEP_BOOKS_MIN,
      KEEP_BOOKS_MAX,
      KEEP_BOOKS_DEFAULT
    ),
    days: clampSetting(
      recentlyViewedKeepDays$.getValue(),
      KEEP_DAYS_MIN,
      KEEP_DAYS_MAX,
      KEEP_DAYS_DEFAULT
    )
  };
}

export function currentDwellSeconds(): number {
  return clampSetting(recentlyViewedDwellSeconds$.getValue(), 0, DWELL_MAX, DWELL_DEFAULT);
}
