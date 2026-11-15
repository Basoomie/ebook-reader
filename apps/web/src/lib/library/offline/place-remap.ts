/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  buildBookTextIndex,
  parseBookHtml,
  type BookTextIndex
} from '$lib/components/book-reader/book-search';
import { bookmarkPlaceAt, placeBookmark } from '$lib/notes/bookmarks';

/**
 * Season 2 "Cached book whose Calibre file changed" (decided: the saved place is found
 * again by its text): the reading place of this device in a replaced copy. The place is
 * treated like a named bookmark (WP11b): the text at it in the old copy is found in the new
 * copy (`placeBookmark`, the same rules as highlights), else the place keeps its fraction.
 */

/** The reader's index of a stored book's HTML (the reader drops `.placeholder-br` too). */
export function storedTextIndex(html: string): BookTextIndex {
  const root = parseBookHtml(html);
  root.querySelectorAll('.placeholder-br').forEach((el) => el.remove());
  return buildBookTextIndex(root);
}

export interface RemappedPlace {
  position: number;
  /** found: by its text; fraction: the same share of the new text; start: nothing saved. */
  how: 'found' | 'fraction' | 'start';
}

export function remapPlace(
  oldHtml: string,
  newHtml: string,
  position: number,
  maxDistance: number
): RemappedPlace {
  if (!(position > 0)) return { position: 0, how: 'start' };
  const before = storedTextIndex(oldHtml);
  const after = storedTextIndex(newHtml);
  const place = bookmarkPlaceAt(before, Math.min(position, before.total));
  if (place.text) {
    const found = placeBookmark(after, place, maxDistance);
    if (found !== null) return { position: Math.min(found, after.total), how: 'found' };
  }
  const fraction = before.total > 0 ? Math.min(1, position / before.total) : 0;
  return { position: Math.round(fraction * after.total), how: 'fraction' };
}
