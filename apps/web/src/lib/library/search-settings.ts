/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';

/**
 * The library search box's help (search palette step 1, 2026-11-24), the same on every
 * device. Suggestions: field names and values while typing. Reads as: the search in plain
 * words under the box.
 */
export const searchSuggestionsOn$ = writableBooleanLocalStorageSubject()(
  'searchSuggestionsOn',
  true
);

export const searchReadsAsOn$ = writableBooleanLocalStorageSubject()('searchReadsAsOn', true);
