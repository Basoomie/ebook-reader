/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink } from '$lib/library/library-db';

/** Kind of the record listing the books a device stores (id = the device). */
export const DEVICE_BOOKS_KIND = 'device-books';

/**
 * WP15e: the books this device stores, by library book id, for the built-in collection
 * "On this device" (on:device). A book counts when its library link points at a local
 * copy that still exists, the same rule as the cards' "on this device" badge. Pure.
 */
export function deviceBookIds(links: readonly CalibreLink[], existing: Set<number>): string[] {
  return [...new Set(links.filter((l) => existing.has(l.localId)).map((l) => l.bookId))].sort();
}

/** The local copies of one library book (normally one). */
export function localIdsOfBook(
  links: readonly CalibreLink[],
  existing: Set<number>,
  bookId: string
): number[] {
  return [
    ...new Set(
      links.filter((l) => l.bookId === bookId && existing.has(l.localId)).map((l) => l.localId)
    )
  ];
}

/** Whether the stored record already lists exactly these ids (then nothing is written). */
export function sameBookIds(stored: unknown, ids: readonly string[]): boolean {
  if (!Array.isArray(stored) || stored.length !== ids.length) return false;
  const sorted = [...stored].sort();
  return sorted.every((id, i) => id === ids[i]);
}

/** A record above this size would be refused by the server (64 KB per record). */
export const MAX_DEVICE_BOOKS_BYTES = 60 * 1024;
