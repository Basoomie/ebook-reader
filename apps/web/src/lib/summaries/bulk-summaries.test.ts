/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { aboutUsd, bulkSummaryLine, localBulkPlan } from './bulk-summaries';

describe('the bulk "Mark completed" summary line', () => {
  it('names the books and about what they cost', () => {
    expect(bulkSummaryLine(12, 15.2)).toBe('Make summaries for 12 books · about $15');
    expect(bulkSummaryLine(1, 1.234)).toBe('Make a summary for 1 book · about $1.23');
    expect(bulkSummaryLine(3, null)).toBe('Make summaries for 3 books');
    expect(aboutUsd(0.849)).toBe('$0.85');
    expect(aboutUsd(1234.4)).toBe('$1,234');
  });

  it('offline: only first completions with text and no summary, at the measured rate', () => {
    const plan = localBulkPlan(
      [
        { id: 'a', charCount: 100_000 },
        { id: 'b', charCount: 50_000 },
        { id: 'read-before', charCount: 100_000 },
        { id: 'has-one', charCount: 100_000 },
        { id: 'pictures', charCount: 0 },
        { id: 'not-counted', charCount: null }
      ],
      {
        completedBefore: (id) => id === 'read-before',
        hasSummary: (id) => id === 'has-one',
        per100k: 1.3
      }
    );
    expect(plan.books).toEqual(['a', 'b']);
    expect(plan.usd).toBeCloseTo(1.95, 6);
  });
});
