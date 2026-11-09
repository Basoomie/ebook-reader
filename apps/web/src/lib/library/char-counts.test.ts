/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { formatBookCharCount, summarizeCharCounts } from './char-counts';
import type { CatalogLibrary } from './types';

function library(counts?: CatalogLibrary['counts']): CatalogLibrary {
  return {
    id: 'l',
    folder: 'f',
    calibreLibraryUuid: null,
    name: 'L',
    language: 'ja',
    enabled: true,
    available: true,
    counts
  };
}

describe('formatBookCharCount', () => {
  it('shows a current count with thousands separators', () => {
    expect(formatBookCharCount({ charCount: 84786, charCountStatus: 'counted' })).toBe(
      `${(84786).toLocaleString()} chars`
    );
  });

  it('says Counting… while pending, also when an old count is still stored', () => {
    expect(formatBookCharCount({ charCount: null, charCountStatus: 'pending' })).toBe('Counting…');
    expect(formatBookCharCount({ charCount: 120, charCountStatus: 'pending' })).toBe('Counting…');
  });

  it('shows nothing when the book could not be counted', () => {
    expect(formatBookCharCount({ charCount: null, charCountStatus: 'error' })).toBe('');
  });

  it('works with servers that send no status', () => {
    expect(formatBookCharCount({ charCount: null })).toBe('Counting…');
    expect(formatBookCharCount({ charCount: 5 })).toBe('5 chars');
  });
});

describe('summarizeCharCounts', () => {
  it('adds up the libraries and mentions failures only when there are some', () => {
    expect(
      summarizeCharCounts([
        library({ counted: 41000, pending: 24000, errors: 12 }),
        library({ counted: 200, pending: 252, errors: 0 })
      ])
    ).toBe(
      `Character counts: ${(41200).toLocaleString()} of ${(65464).toLocaleString()} (12 failed)`
    );
    expect(summarizeCharCounts([library({ counted: 3, pending: 0, errors: 0 })])).toBe(
      'Character counts: 3 of 3'
    );
  });

  it('is empty for servers without counts', () => {
    expect(summarizeCharCounts([library()])).toBe('');
  });
});
