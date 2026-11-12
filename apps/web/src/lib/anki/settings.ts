/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';
import { writableObjectLocalStorageSubject } from '$lib/data/internal/writable-object-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';
import type { EnrichMapping } from './mapping';

/** WP14 "Enrich last card" settings (Settings > Anki). */

// --- This device ---

/** AnkiConnect's address as this device reaches it (the Boox can use the PC's Anki). */
export const ankiConnectUrl$ = writableStringLocalStorageSubject()(
  'ankiConnectUrl',
  'http://127.0.0.1:8765'
);

/** How long an AnkiConnect request may take (seconds). */
export const ankiConnectTimeoutSeconds$ = writableNumberLocalStorageSubject()(
  'ankiConnectTimeoutSeconds',
  10
);

/** An Anki button in the reader's bottom bar (off: new bottom-bar items are opt-in). */
export const ankiBottomBarButton$ = writableBooleanLocalStorageSubject()(
  'ankiBottomBarButton',
  false
);

/** The message after enriching a card closes by itself after this many seconds (0 = stays). */
export const ankiNoticeSeconds$ = writableNumberLocalStorageSubject()('ankiNoticeSeconds', 5);

/** AnkiConnect's API key, if it asks for one. Never leaves this device. */
export const ankiConnectKey$ = writableStringLocalStorageSubject()('ankiConnectKey', '');

// --- Every device ---

/** Fields per note type (see mapping.ts). */
export const ankiFieldMapping$ = writableObjectLocalStorageSubject<EnrichMapping>()(
  'ankiFieldMapping',
  {}
);

/** The newest note added in the last N days is the one enriched. */
export const ankiLookBackDays$ = writableNumberLocalStorageSubject()('ankiLookBackDays', 1);

/** Put before the book-title tag, e.g. "book::" ('' = the title alone). */
export const ankiTagPrefix$ = writableStringLocalStorageSubject()('ankiTagPrefix', '');

/** Least similarity (0-1) for subtitle lines that don't contain the sentence exactly. */
export const ankiAudioMatchThreshold$ = writableNumberLocalStorageSubject()(
  'ankiAudioMatchThreshold',
  0.6
);

/** Longest sentence audio (seconds); a longer one is left out. */
export const ankiAudioMaxSeconds$ = writableNumberLocalStorageSubject()('ankiAudioMaxSeconds', 30);
