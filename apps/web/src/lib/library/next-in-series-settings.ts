/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';

/**
 * Next in your series (docs/design/next-in-series.md), global settings (synced; the server
 * reads both, as `global:nextInSeriesOn` and `global:nextInSeriesBonus`).
 * Off: the Home row shows nothing and status:next matches nothing.
 */
export const nextInSeriesOn$ = writableBooleanLocalStorageSubject()('nextInSeriesOn', true);

/** Bonus books (N.1) can be the next volume. */
export const nextInSeriesBonus$ = writableBooleanLocalStorageSubject()('nextInSeriesBonus', false);
