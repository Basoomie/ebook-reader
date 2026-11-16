/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { lineUnits, paragraphUnits, sentenceUnits } from './pacer-units';

const chars = (text: string, blocks?: number[]) =>
  Array.from(text).map((ch, i) => ({ ch, block: blocks ? blocks[i] : 0 }));

const group = (text: string, units: number[]) => {
  const out: string[] = [];
  Array.from(text).forEach((ch, i) => {
    out[units[i]] = (out[units[i]] ?? '') + ch;
  });
  return out;
};

describe('pacer units', () => {
  it('splits paragraphs by block', () => {
    const c = chars('あいうえ', [1, 1, 2, 2]);
    expect(paragraphUnits(c)).toEqual([0, 0, 1, 1]);
  });

  it('splits sentences after the end marks and their closing brackets', () => {
    const t = '「行く。」と言った。……そうか！？はい';
    const c = chars(t);
    expect(
      group(
        t,
        sentenceUnits(c, (i) => c[i].ch)
      )
    ).toEqual(['「行く。」', 'と言った。……', 'そうか！？', 'はい']);
  });

  it('starts a new sentence at a new paragraph', () => {
    const t = 'あいうえ';
    const c = chars(t, [1, 1, 2, 2]);
    expect(sentenceUnits(c, (i) => c[i].ch)).toEqual([0, 0, 1, 1]);
  });

  it('splits lines where the block-axis position jumps, keeps boxless characters', () => {
    const c = chars('あいうえおか');
    // Vertical text: columns at x = 300, 300, 300, 260, (no box), 260.
    const boxes = [300, 301, 299, 260, null, 259].map((x) =>
      x === null ? null : { center: x, size: 20 }
    );
    expect(lineUnits(c, boxes)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('keeps ruby bases and sideways numbers on their line, new paragraph = new line', () => {
    const c = chars('漢字12あ', [1, 1, 1, 1, 2]);
    const boxes = [
      { center: 300, size: 24 },
      { center: 302, size: 24 },
      { center: 300, size: 24 },
      { center: 300, size: 24 },
      { center: 300, size: 24 }
    ];
    expect(lineUnits(c, boxes)).toEqual([0, 0, 0, 0, 1]);
  });
});
