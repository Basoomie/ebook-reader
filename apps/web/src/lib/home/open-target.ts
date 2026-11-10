/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { AppOpenTarget } from './settings';

/**
 * Where opening the app (the `/` route) goes (WP7b, decided with the user): with
 * "Last book" (the default) and a remembered book, straight into that book; otherwise
 * Home. The reader remembers every book it opens; leaving it for Home, Library or
 * Collections forgets it, leaving for Settings or Statistics keeps it. Deleting a book
 * also forgets it, so a remembered book exists.
 */
export function appOpenPath(
  target: AppOpenTarget | string,
  lastBookId: number | undefined,
  base: string
): string {
  if (target !== 'home' && lastBookId !== undefined && lastBookId > 0) {
    return `${base}/b?id=${lastBookId}`;
  }
  return `${base}/home`;
}

/**
 * Whether leaving the reader for a page forgets the last book (WP7b): going back to
 * the lists does, a detour to Settings or Statistics doesn't.
 */
export function leavingForgetsLastBook(routeId: string): boolean {
  return routeId !== '/settings' && routeId !== '/statistics';
}
