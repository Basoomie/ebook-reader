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
 * How a collection shows its books' series, authors and tags (2026-11-24): 'tabs' (All /
 * Series / Authors / Tags, like the Library) or 'sections' (one list under headings, picked
 * with Group by). Per device.
 */
export const collectionGroupsAs$ = writableStringLocalStorageSubject<'tabs' | 'sections'>()(
  'collectionGroupsAs',
  'tabs'
);

/** Sections mode: the last Group by picked in a collection ('' = none). Per device. */
export const collectionSectionsBy$ = writableStringLocalStorageSubject<
  '' | 'series' | 'author' | 'tag'
>()('collectionSectionsBy', '');

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
 * Hidden covers on this device (2026-11-21, per device): 'rules' (blur what a tag, author,
 * series or collection rule says), 'all' or 'none'. A book's own setting still wins. See
 * lib/library/cover-blur.ts.
 */
export const libraryCoverBlur$ = writableStringLocalStorageSubject()('libraryCoverBlur', 'rules');

/**
 * Season 2 §6: where the book page shows the book's illustrations: 'description' (a
 * full-width strip under the description and About this book, the default) or 'cover' (in
 * the cover's column, under the cover). Per device (decided 2026-11-15).
 */
export const bookIllustrationsPosition$ = writableStringLocalStorageSubject<
  'description' | 'cover'
>()('bookIllustrationsPosition', 'description');

/**
 * Select mode's Download menu: how the files of several books arrive. 'zip' = one ZIP per
 * download (made by the server as it is sent, into the browser's downloads); 'files' =
 * each file on its own, like the book page's Download menu.
 */
export const libraryBulkDownloadMode$ = writableStringLocalStorageSubject<'zip' | 'files'>()(
  'libraryBulkDownloadMode',
  'zip'
);

/** Select mode's Download menu asks first above this many GB (0 = never asks). */
export const libraryDownloadConfirmGb$ = writableNumberLocalStorageSubject()(
  'libraryDownloadConfirmGb',
  5
);

/** WP19a: load the next page when the end of a list comes near (else a "Load more" button). */
export const libraryAutoLoad$ = writableBooleanLocalStorageSubject()('libraryAutoLoad', true);
