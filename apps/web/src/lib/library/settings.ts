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
 * WP19a: cover width in the grids, in px (Library, collections, the Collections page, Home
 * rows). 0 = automatic (columns by screen width, as before WP19a).
 */
export const libraryCoverSize$ = writableNumberLocalStorageSubject()('libraryCoverSize', 0);

/**
 * WP19b: light or dark for the catalogue pages: 'auto' (follow the reader theme), 'light'
 * or 'dark'. See lib/data/catalogue-look.ts.
 */
export const libraryLook$ = writableStringLocalStorageSubject()('libraryLook', 'auto');

/** WP19a: load the next page when the end of a list comes near (else a "Load more" button). */
export const libraryAutoLoad$ = writableBooleanLocalStorageSubject()('libraryAutoLoad', true);
