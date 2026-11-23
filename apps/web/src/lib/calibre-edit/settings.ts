/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';

/**
 * Calibre metadata editing (Settings › Library), per device and copied by "Copy settings from
 * another device" (design 2026-11-23).
 */

/** The book's edit form: a side panel (the default) or a modal. */
export const bookEditAs$ = writableStringLocalStorageSubject<'panel' | 'modal'>()(
  'bookEditAs',
  'panel'
);

/** The series editor: a side panel (the default) or a modal; its own setting. */
export const seriesEditAs$ = writableStringLocalStorageSubject<'panel' | 'modal'>()(
  'seriesEditAs',
  'panel'
);

/** A book without a rating: hide the line under the byline (the default) or say "No rating". */
export const bookRatingEmpty$ = writableStringLocalStorageSubject<'hide' | 'show'>()(
  'bookRatingEmpty',
  'hide'
);
