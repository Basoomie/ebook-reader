/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';

/** Per-device Library page settings (WP6). */

/** How long a catalog request may take before the page reports the server as unreachable. 0 = no limit. */
export const libraryRequestTimeoutSeconds$ = writableNumberLocalStorageSubject()(
  'libraryRequestTimeoutSeconds',
  20
);

/**
 * The offline Library's quick server check: how long the Library, Collections, Home and
 * a book's details wait for the server's health answer before showing the books on this
 * device (away from home a request often gets no answer until the request timeout).
 * 0 = no quick check (the pages wait for their first request, as before).
 */
export const libraryServerCheckSeconds$ = writableNumberLocalStorageSubject()(
  'libraryServerCheckSeconds',
  5
);

/** The quick server check time in seconds (0 = off). */
export function serverCheckSeconds(): number {
  return Math.max(0, Number(libraryServerCheckSeconds$.getValue()) || 0);
}

/** Library picked in the Library page ('' = all libraries). */
export const libraryFilter$ = writableStringLocalStorageSubject()('libraryFilter', '');

/** Library view (WP7a): 'grid' (covers) or 'list' (rows). */
export const libraryView$ = writableStringLocalStorageSubject<'grid' | 'list'>()(
  'libraryView',
  'grid'
);

/** Show author, series number, character count and progress under covers. */
export const libraryInfoLine$ = writableBooleanLocalStorageSubject()('libraryInfoLine', true);

/**
 * WP19a: the last book sort picked outside a series or a manual collection ("title-asc";
 * '' = date added, newest first). See lib/library/sort.ts.
 */
export const librarySort$ = writableStringLocalStorageSubject()('librarySort', '');

/** WP19a: the last sort picked in the Series, Authors or Tags tab ('' = recently added). */
export const libraryGroupSort$ = writableStringLocalStorageSubject()('libraryGroupSort', '');

/**
 * Notes at scale (2026-11-21): the last sort picked on the Notes page, per view ("title-asc";
 * '' = recently changed / newest highlight first). A series filter still opens in series
 * order. See lib/notes/notes-view.ts.
 */
export const notesBookSort$ = writableStringLocalStorageSubject()('notesBookSort', '');
export const notesHighlightSort$ = writableStringLocalStorageSubject()('notesHighlightSort', '');

/**
 * WP19a: cover width in the grids, in px (Library, collections, the Collections page, Home
 * rows). 0 = automatic (columns by screen width, as before WP19a).
 */
export const libraryCoverSize$ = writableNumberLocalStorageSubject()('libraryCoverSize', 0);

/**
 * WP19b: light or dark for the catalogue pages: 'auto' (follow the reader theme), 'light'
 * or 'dark'. See lib/data/catalogue-look.ts.
 */
export const libraryLook$ = writableStringLocalStorageSubject()('libraryLook', 'auto');

/**
 * Season 2 §6: where the book page shows the book's illustrations: 'description' (a
 * full-width strip under the description and About this book, the default) or 'cover' (in
 * the cover's column, under the cover). Per device (decided 2026-11-15).
 */
export const bookIllustrationsPosition$ = writableStringLocalStorageSubject<
  'description' | 'cover'
>()('bookIllustrationsPosition', 'description');

/** WP19a: load the next page when the end of a list comes near (else a "Load more" button). */
export const libraryAutoLoad$ = writableBooleanLocalStorageSubject()('libraryAutoLoad', true);
