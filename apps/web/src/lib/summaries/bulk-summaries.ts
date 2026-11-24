/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The bulk "Mark completed" question about summaries (book summaries session 3): which of the
 * selected books would get an automatic summary (their first completion, no summary yet, text
 * to read) and about what it costs, from the measured cost per 100,000 characters. The server
 * answers it (it knows which books were completed before); offline the device works it out
 * from what it has.
 */

/** The accuracy test's measured cost (mixed setup), until the app has measured its own. */
export const DEFAULT_COST_PER_100K = 1.3;

export interface BulkPlan {
  books: string[];
  /** null: the cost isn't known (offline without an earlier estimate). */
  usd: number | null;
}

export function localBulkPlan(
  books: { id: string; charCount: number | null }[],
  o: {
    completedBefore: (id: string) => boolean;
    hasSummary: (id: string) => boolean;
    per100k: number | null;
  }
): BulkPlan {
  const picked = books.filter(
    (b) => (b.charCount ?? 0) > 0 && !o.completedBefore(b.id) && !o.hasSummary(b.id)
  );
  const chars = picked.reduce((a, b) => a + (b.charCount ?? 0), 0);
  return {
    books: picked.map((b) => b.id),
    usd: o.per100k === null ? null : (chars / 100_000) * o.per100k
  };
}

/** "$0.85", "$4.20", "$15": cents below $10, whole dollars above. */
export function aboutUsd(usd: number): string {
  if (usd < 10) return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** The dialog's line: "Make summaries for 12 books · about $15". */
export function bulkSummaryLine(count: number, usd: number | null): string {
  const what =
    count === 1
      ? 'Make a summary for 1 book'
      : `Make summaries for ${count.toLocaleString('en-US')} books`;
  return usd === null ? what : `${what} · about ${aboutUsd(usd)}`;
}
