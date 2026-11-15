/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Season 2 Phase 12: pronunciation fixes for the PC voices (server shapes). */

export type FixKind = 'word' | 'pattern';

export interface PronunciationFix {
  id: number;
  /** null = the global list (Settings > Audiobooks). */
  bookId: string | null;
  kind: FixKind;
  match: string;
  reading: string;
  createdAt: number;
  updatedAt: number;
}

export interface FixLimits {
  wordMax: number;
  patternMax: number;
  readingMax: number;
  entriesPerList: number;
  timeoutSeconds: number | null;
}

export interface FixList {
  /** false when the server has no PC voices (generated audiobooks off). */
  available: boolean;
  entries: PronunciationFix[];
  limits: FixLimits;
}

export interface FixInput {
  kind: FixKind;
  match: string;
  reading: string;
}

/** One entry's places in a book (the text check). */
export interface FixCheck {
  id: number;
  places: number;
  /** Places the book's own furigana reads (the fix is skipped there). */
  skipped: number;
  /** Up to 3 sentences, with the reading the PC is given. */
  examples: { text: string; reading: string }[];
}

export interface PronunciationCheck {
  entries: FixCheck[];
  /** The linked audiobook when it was made on the PC; null otherwise. */
  audiobook: { version: number | null; madeWithCurrentFixes: boolean } | null;
}

/** What a job recorded about the fixes it used. */
export interface FixSummary {
  book: number;
  global: number;
  places: number;
  digest: string;
}
