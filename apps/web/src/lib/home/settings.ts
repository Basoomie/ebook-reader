/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';
import { writableArrayLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';
import { DEFAULT_HOME_ROWS, type HomeRow } from './rows';

/** Per-device Home and start-up settings (WP7b). */

export type AppOpenTarget = 'last-book' | 'home';

/** What opening the app shows: the last book you read (default, as before) or Home. */
export const appOpenTarget$ = writableStringLocalStorageSubject<AppOpenTarget>()(
  'appOpenTarget',
  'last-book'
);

/** Home's rows on this device, in order (see rows.ts; read through normalizeRows). */
export const homeRows$ = writableArrayLocalStorageSubject<HomeRow>()('homeRows', [
  ...DEFAULT_HOME_ROWS
]);

/** How many books each Home row shows. */
export const homeRowLength$ = writableNumberLocalStorageSubject()('homeRowLength', 20);
