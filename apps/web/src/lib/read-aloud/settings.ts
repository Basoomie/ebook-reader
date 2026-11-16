/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableBooleanLocalStorageSubject } from '$lib/data/internal/writable-boolean-local-storage-subject';
import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';

/**
 * Season 2 Phase 12 session 3: read-aloud's settings, all per device (copied by Settings >
 * Data "Copy settings from another device"). The voice is the book's PC voice (else the one
 * in Settings > Anki) and the pauses are the PC voices' own (every device); how long the PC
 * keeps the voice loaded is in Settings > Audiobooks (stored on the server).
 */

/** Playback speed (the voice keeps its pitch). */
export const readAloudSpeed$ = writableNumberLocalStorageSubject()('readAloudSpeed', 1);

/** Audio the PC reads ahead of what is playing (seconds). */
export const readAloudAheadSeconds$ = writableNumberLocalStorageSubject()(
  'readAloudAheadSeconds',
  60
);

/** After a lookup popup closes, read-aloud goes on after this many seconds (0 = stays paused). */
export const readAloudLookupResume$ = writableNumberLocalStorageSubject()(
  'readAloudLookupResume',
  1
);

/** A read-aloud button in the reader's bottom bar (it also shows while read-aloud is on). */
export const readAloudBottomBarButton$ = writableBooleanLocalStorageSubject()(
  'readAloudBottomBarButton',
  false
);

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.1;

/** A speed one step up or down, kept in range (one decimal). */
export function stepSpeed(speed: number, direction: 1 | -1): number {
  const base = Number.isFinite(speed) ? speed : 1;
  const next = Math.round((base + direction * SPEED_STEP) * 10) / 10;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, next));
}

/** A stored speed as used (a bad value plays at 1×). */
export function usableSpeed(speed: unknown): number {
  const n = Number(speed);
  return Number.isFinite(n) && n >= SPEED_MIN && n <= SPEED_MAX ? n : 1;
}
