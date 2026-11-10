/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';

/** Per-device record sync settings (WP4). */

/** Off = this device keeps writing locally but never talks to /sync. */
export const recordSyncEnabled$ = writableBooleanLocalStorageSubject()('recordSyncEnabled', true);

/** Wait this long after a local change before syncing (more changes in that time join the same sync). */
export const syncDebounceSeconds$ = writableNumberLocalStorageSubject()('syncDebounceSeconds', 5);

/** Sync this often while the app is visible, to pick up other devices' changes. 0 = only on changes. */
export const syncIntervalMinutes$ = writableNumberLocalStorageSubject()('syncIntervalMinutes', 5);

/** WP9: offer another device's place when it is further along in a Calibre book. */
export const positionPromptEnabled$ = writableBooleanLocalStorageSubject()(
  'positionPromptEnabled',
  true
);

/** WP9: how many characters further along another device must be before it is offered (about a page on a phone). */
export const positionPromptMinChars$ = writableNumberLocalStorageSubject()(
  'positionPromptMinChars',
  500
);

/**
 * WP8a: a book becomes "Reading" on its first real page turn. Page changes
 * within this many seconds of the previous one while the book loads (position
 * restore, layout) are treated as settling, not as a page turn.
 */
export const readingStatusSettleSeconds$ = writableNumberLocalStorageSubject()(
  'readingStatusSettleSeconds',
  3
);
