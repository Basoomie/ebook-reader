/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP14: the link field holds only the book-and-position part; the note type's card
 * template adds the address (decided with the user), e.g.
 * `<a href="http://192.168.1.5:3080{{text:ReaderLink}}">`. The path opens /open, which
 * finds or downloads the book on that device and jumps to the passage.
 */

export const OPEN_ROUTE = '/open';

/** `/open?book=<library id>&pos=<characters>` */
export function readerLinkPath(bookId: string, position: number): string {
  const pos = Math.max(0, Math.round(Number.isFinite(position) ? position : 0));

  return `${OPEN_ROUTE}?book=${encodeURIComponent(bookId)}&pos=${pos}`;
}

export interface ReaderLinkTarget {
  bookId: string;
  position: number;
}

/** The target of an /open address's query, or null when it names no book. */
export function parseReaderLink(search: string | URLSearchParams): ReaderLinkTarget | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const bookId = (params.get('book') ?? '').trim();

  if (!bookId) {
    return null;
  }

  const raw = Number(params.get('pos'));

  return { bookId, position: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0 };
}

/**
 * The book-title tag: the library title with whitespace runs turned into `_` (Anki
 * tags can't hold spaces) and `"` removed, after an optional prefix such as `book::`.
 */
export function titleTag(title: string, prefix = ''): string | null {
  const clean = (s: string) => s.normalize('NFC').replace(/"/g, '').replace(/\s+/gu, '_');
  const tag = clean(title.trim()).replace(/^_+|_+$/g, '');

  if (!tag) {
    return null;
  }

  return `${clean(prefix.trim())}${tag}`;
}
