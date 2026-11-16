/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Which sentence Enrich uses, decided once the card is known (fix of 2026-11-15).
 *
 * Yomitan by default keeps its popup in a closed shadow root, so the page can't see a
 * lookup; and with "Select matched text" (on by default) it selects the looked-up word in the
 * page, which is not a sentence. The card itself is the record of the lookup: Yomitan put
 * the sentence in its Sentence field. So, in this order:
 *
 * 1. the user's own selection (made while pressed or by keyboard, not Yomitan's word
 *    selection: `selectionByUser` in lib/dictionary/popup-watch.ts), made after the card was
 *    added (a note id is the time it was added): the user chose these sentences for this
 *    card (e.g. several sentences, with Overwrite);
 * 2. the card's own sentence (its mapped Sentence field), placed in the book;
 * 3. the last lookup the reader saw (only where the dictionary popup is visible to the page);
 * 4. none.
 */

export interface SelectionCandidate<T> {
  /** When the selection was last changed (ms). */
  at: number;
  /** Made by the user (while pressed or by keyboard), not set by a script such as Yomitan. */
  byUser: boolean;
  /** The selection as the sentence (null when it isn't in the book's text). */
  sentence: () => T | null;
}

export interface SentenceCandidates<T> {
  selection: SelectionCandidate<T> | null;
  /** The last lookup's sentence, or null. */
  lookup: T | null;
}

export type SentenceSource = 'selection' | 'card' | 'lookup';

export interface ChosenSentence<T> {
  sentence: T;
  source: SentenceSource;
}

/**
 * `noteAddedAt` is the card's note id; `card` gives the card's own sentence (null when the
 * note type maps no Sentence field or the field is empty). Each candidate is worked out only
 * when it is needed.
 */
export function chooseSentence<T>(
  candidates: SentenceCandidates<T>,
  noteAddedAt: number,
  card: () => T | null
): ChosenSentence<T> | null {
  const { selection, lookup } = candidates;

  if (selection && selection.byUser && selection.at > noteAddedAt) {
    const sentence = selection.sentence();
    if (sentence) return { sentence, source: 'selection' };
  }

  const own = card();
  if (own) return { sentence: own, source: 'card' };

  if (lookup) return { sentence: lookup, source: 'lookup' };

  return null;
}
