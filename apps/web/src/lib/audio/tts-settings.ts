/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';

/**
 * WP17: pauses in audiobooks made on the PC (Settings > Audiobooks), for every device.
 * Sent with each audiobook and preview, and recorded with it.
 */
export const ttsSentencePauseMs$ = writableNumberLocalStorageSubject()('ttsSentencePauseMs', 300);
export const ttsParagraphPauseMs$ = writableNumberLocalStorageSubject()('ttsParagraphPauseMs', 700);
export const ttsChapterPauseMs$ = writableNumberLocalStorageSubject()('ttsChapterPauseMs', 2000);

const clampMs = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(10_000, Math.max(0, Math.round(n))) : fallback;
};

/** The pauses as they are sent with a job. */
export function currentPauses() {
  return {
    sentenceMs: clampMs(ttsSentencePauseMs$.getValue(), 300),
    paragraphMs: clampMs(ttsParagraphPauseMs$.getValue(), 700),
    chapterMs: clampMs(ttsChapterPauseMs$.getValue(), 2000)
  };
}
