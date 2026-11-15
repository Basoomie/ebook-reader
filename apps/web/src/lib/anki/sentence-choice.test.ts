/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { chooseSentence } from './sentence-choice';

const lookup = { sentence: 'lookup', at: 1000 };
const selection = (at: number, isLookup = false, sentence: string | null = 'selection') => ({
  at,
  isLookup,
  sentence: () => sentence
});

describe('sentence choice', () => {
  it('uses a selection made after the lookup', () => {
    expect(chooseSentence(lookup, selection(1500))).toBe('selection');
  });

  it('uses the lookup when it is newer than the selection', () => {
    expect(chooseSentence(lookup, selection(500))).toBe('lookup');
    expect(chooseSentence(lookup, selection(1000))).toBe('lookup');
  });

  it('treats the word Yomitan selected for the lookup as the lookup', () => {
    expect(chooseSentence(lookup, selection(1200, true))).toBe('lookup');
  });

  it('falls back to the lookup when the selection is not in the book', () => {
    expect(chooseSentence(lookup, selection(1500, false, null))).toBe('lookup');
  });

  it('without a lookup uses the selection, as before', () => {
    expect(chooseSentence(null, selection(0))).toBe('selection');
    expect(chooseSentence(null, selection(0, false, null))).toBeNull();
    expect(chooseSentence(null, null)).toBeNull();
  });

  it('without a selection uses the lookup', () => {
    expect(chooseSentence(lookup, null)).toBe('lookup');
  });

  it('does not work out the selection when the lookup wins', () => {
    let asked = 0;
    chooseSentence(lookup, {
      at: 10,
      isLookup: false,
      sentence: () => {
        asked += 1;
        return 'x';
      }
    });
    expect(asked).toBe(0);
  });
});
