/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Season 2 Phase 12: the words of the pronunciation fix lists (plain words only). */

import type { FixCheck, FixSummary, PronunciationCheck, PronunciationFix } from './fix-types';

const times = (n: number) => (n === 1 ? 'once' : `${n.toLocaleString('en-US')} times`);

/** What the text check found for one entry in this book. */
export function placesText(check: FixCheck | undefined): string {
  if (!check) return '';
  const found = check.places ? `Found ${times(check.places)} in this book` : 'Not in this book';
  if (!check.skipped) return found;
  return `${found} · ${check.skipped.toLocaleString('en-US')} skipped: the book's own furigana`;
}

/** The kind shown next to an entry. */
export function kindText(fix: Pick<PronunciationFix, 'kind'>): string {
  return fix.kind === 'pattern' ? 'Pattern' : 'Word';
}

/** The book page's note when the linked audiobook made on the PC is out of date. */
export function versionNote(check: PronunciationCheck | null): string {
  const a = check?.audiobook;
  if (!a || a.madeWithCurrentFixes) return '';
  return 'This audiobook was made before the current pronunciation fixes for this book. Make it again (Text-to-speech > Make an audiobook with this voice) to use them.';
}

/** "2 pronunciation fixes" for a job's settings line; '' when none were used. */
export function jobFixesText(fixes: FixSummary | undefined): string {
  const n = (fixes?.book ?? 0) + (fixes?.global ?? 0);
  if (!n) return '';
  return n === 1 ? '1 pronunciation fix' : `${n} pronunciation fixes`;
}

/** The global entries that match in this book (the others aren't shown on the book page). */
export function globalHere(
  entries: PronunciationFix[],
  check: PronunciationCheck | null
): PronunciationFix[] {
  if (!check) return [];
  const by = new Map(check.entries.map((c) => [c.id, c]));
  return entries.filter((e) => {
    const c = by.get(e.id);
    return c && (c.places > 0 || c.skipped > 0);
  });
}
