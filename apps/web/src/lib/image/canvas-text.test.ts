/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  breakLines,
  clampLines,
  drawVerticalColumn,
  ellipsized,
  verticalPlacement
} from '$lib/image/canvas-text';
import { recordingCtx } from '$lib/image/recording-ctx';

/** Every character 10 px wide. */
const tens = (s: string) => [...s].length * 10;

describe('breakLines', () => {
  it('breaks at the width', () => {
    expect(breakLines('あいうえおかきくけこさ', 50, tens)).toEqual([
      'あいうえお',
      'かきくけこ',
      'さ'
    ]);
  });

  it('hangs closing punctuation on the line before', () => {
    expect(breakLines('あいうえお。かき', 50, tens)).toEqual(['あいうえお。', 'かき']);
    expect(breakLines('あいうえお」かき', 50, tens)).toEqual(['あいうえお」', 'かき']);
    expect(breakLines('あいうえおーか', 50, tens)).toEqual(['あいうえおー', 'か']);
  });

  it('moves an opening bracket to the next line', () => {
    expect(breakLines('あいうえ「おか」', 50, tens)).toEqual(['あいうえ', '「おか」']);
  });

  it('keeps the line breaks of the text', () => {
    expect(breakLines('あ\nい\r\nう', 50, tens)).toEqual(['あ', 'い', 'う']);
    expect(breakLines('', 50, tens)).toEqual(['']);
  });

  it('keeps surrogate pairs whole', () => {
    expect(breakLines('𠮷𠮷𠮷', 20, tens)).toEqual(['𠮷𠮷', '𠮷']);
  });
});

describe('clampLines and ellipsized', () => {
  it('cuts to a number of lines with an ellipsis', () => {
    expect(clampLines(['ab', 'cd', 'ef'], 2)).toEqual(['ab', 'c…']);
    expect(clampLines(['ab'], 2)).toEqual(['ab']);
  });

  it('cuts one line to a width', () => {
    const { ctx } = recordingCtx();
    ctx.font = '10px x';
    expect(ellipsized(ctx, 'abcdef', 60)).toBe('abcdef');
    expect(ellipsized(ctx, 'abcdefgh', 60)).toBe('abcde…');
  });
});

describe('vertical text', () => {
  it('places punctuation, small kana, brackets and Latin', () => {
    expect(verticalPlacement('あ')).toBe('upright');
    expect(verticalPlacement('漢')).toBe('upright');
    expect(verticalPlacement('、')).toBe('top-right');
    expect(verticalPlacement('。')).toBe('top-right');
    expect(verticalPlacement('っ')).toBe('small');
    expect(verticalPlacement('ー')).toBe('rotated');
    expect(verticalPlacement('「')).toBe('rotated');
    expect(verticalPlacement('…')).toBe('rotated');
    expect(verticalPlacement('A')).toBe('rotated');
  });

  it('draws one character per step, turning the rotated ones', () => {
    const { ctx, calls, texts } = recordingCtx();
    drawVerticalColumn(ctx, '「あー」。', 100, 0, 40, 44, '40px x', '#000');
    expect(texts()).toEqual(['「', 'あ', 'ー', '」', '。']);
    expect(calls.filter((c) => c.name === 'rotate')).toHaveLength(3);
    const ys = calls.filter((c) => c.name === 'fillText').map((c) => c.args[2] as number);
    // あ in the middle of its square, the second one down.
    expect(ys[1]).toBe(44 + 22);
    // 。 up and right of the middle of the fifth square.
    const last = calls.filter((c) => c.name === 'fillText').pop()!;
    expect(last.args[1]).toBeGreaterThan(100);
    expect(last.args[2]).toBeLessThan(4 * 44 + 22);
  });
});
