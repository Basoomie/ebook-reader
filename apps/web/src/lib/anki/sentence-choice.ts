/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Which sentence Enrich uses (Phase 8, decided with the user 2026-11-15): the newer of the
 * last lookup and the user's selection. So selecting several sentences after a lookup and
 * tapping Enrich uses the selection (with Overwrite, it replaces the one sentence Yomitan
 * put on the card). A selection that is the lookup's own (Yomitan's "select matched text")
 * counts as the lookup. Without a lookup the selection is used, as before.
 */

export interface LookupChoice<T> {
  sentence: T;
  /** When the lookup was recorded (ms). */
  at: number;
}

export interface SelectionChoice<T> {
  /** When the selection was last changed (ms). */
  at: number;
  /** The selection is the word the last lookup selected. */
  isLookup: boolean;
  /** The selection as the sentence (null when it isn't in the book's text). */
  sentence: () => T | null;
}

export function chooseSentence<T>(
  lookup: LookupChoice<T> | null,
  selection: SelectionChoice<T> | null
): T | null {
  if (!lookup) {
    return selection ? selection.sentence() : null;
  }

  if (selection && !selection.isLookup && selection.at > lookup.at) {
    return selection.sentence() ?? lookup.sentence;
  }

  return lookup.sentence;
}
