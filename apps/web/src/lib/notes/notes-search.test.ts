/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { queryWords } from '$lib/settings/paged-list';
import { markParts } from './notes-search';

const marked = (text: string, query: string) =>
  markParts(text, queryWords(query))
    .map((p) => (p.hit ? `[${p.text}]` : p.text))
    .join('');

describe('markParts', () => {
  it('marks every place a word is found, merged when they touch', () => {
    expect(marked('涼宮ハルヒの憂鬱とハルヒ', 'ハルヒ')).toBe('涼宮[ハルヒ]の憂鬱と[ハルヒ]');
    expect(marked('abcabc', 'ab bc')).toBe('[abcabc]');
    expect(marked('憂鬱', 'xyz')).toBe('憂鬱');
    expect(marked('憂鬱', '')).toBe('憂鬱');
  });

  it('finds folded text and marks the original characters', () => {
    // Katakana as hiragana, either way.
    expect(marked('涼宮ハルヒ', 'はるひ')).toBe('涼宮[ハルヒ]');
    expect(marked('すずみや はるひ', 'ハルヒ')).toBe('すずみや [はるひ]');
    // Full width and case.
    expect(marked('ＡＢＣの本', 'abc')).toBe('[ＡＢＣ]の本');
    // Half-width kana with a voiced mark folds to one character (ｶﾞ → が).
    expect(marked('ｶﾞｯｺｳ', 'がっこう')).toBe('[ｶﾞｯｺｳ]');
    expect(marked('ﾊﾞｶ', 'か')).toBe('ﾊﾞ[ｶ]');
    // Characters outside the BMP keep their pairs.
    expect(marked('𠮷野家の𠮷', '𠮷')).toBe('[𠮷]野家の[𠮷]');
  });
});
