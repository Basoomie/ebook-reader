/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CatalogBook, CatalogLibrary } from './types';

/**
 * The count shown on a library row: "84,786 chars", "Counting…" while the server has
 * not counted the current EPUB, '' when it could not be counted. Plain text only, so
 * e-ink screens never animate.
 */
export function formatBookCharCount(
  book: Pick<CatalogBook, 'charCount' | 'charCountStatus'>
): string {
  const status = book.charCountStatus ?? (book.charCount === null ? 'pending' : 'counted');

  if (status === 'error') return '';
  if (status === 'pending' || book.charCount === null) return 'Counting…';

  return `${book.charCount.toLocaleString()} chars`;
}

/** "Character counts: 41,200 of 65,464 (12 failed)" over the given libraries, or ''. */
export function summarizeCharCounts(libraries: CatalogLibrary[]): string {
  let counted = 0;
  let errors = 0;
  let total = 0;
  let any = false;

  for (const { counts } of libraries) {
    if (!counts) continue;
    any = true;
    counted += counts.counted;
    errors += counts.errors;
    total += counts.counted + counts.pending + counts.errors;
  }

  if (!any) return '';

  return (
    `Character counts: ${counted.toLocaleString()} of ${total.toLocaleString()}` +
    (errors ? ` (${errors.toLocaleString()} failed)` : '')
  );
}
