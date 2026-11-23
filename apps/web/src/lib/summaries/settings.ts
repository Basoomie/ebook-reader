/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableArrayLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';

/**
 * Book summaries (session 3): the languages a summary can be shown in, the same on every device
 * (book-summaries.md "Languages"; its row in Settings > Library comes in session 4). A summary
 * is written in its book's language; another one is a translation, made item by item the first
 * time it is chosen.
 */
export const summaryLanguages$ = writableArrayLocalStorageSubject<string>()('summaryLanguages', [
  'en',
  'ja'
]);
