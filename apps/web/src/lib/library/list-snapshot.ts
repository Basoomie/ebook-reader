/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP19c: the Library list as it was when the page was left (books loaded so far, the
 * next cursor, the scroll position), so going back from a book's details page shows the
 * same place instead of the first page. Kept in memory only (one list, the last one
 * left), and only for back/forward to the very same address.
 */

export interface ListSnapshot<T> {
  url: string;
  scrollY: number;
  data: T;
  savedAt: number;
}

/** A snapshot older than this is not used (the list may have changed meanwhile). */
export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

let saved: ListSnapshot<unknown> | null = null;

export function saveListSnapshot<T>(url: string, scrollY: number, data: T, now = Date.now()) {
  saved = { url, scrollY, data, savedAt: now };
}

/** The snapshot of `url`, once (it is forgotten either way). */
export function takeListSnapshot<T>(url: string, now = Date.now()): ListSnapshot<T> | null {
  const s = saved;
  saved = null;
  if (!s || s.url !== url || now - s.savedAt > SNAPSHOT_MAX_AGE_MS) return null;
  return s as ListSnapshot<T>;
}
