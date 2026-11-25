/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { holdLine, moveBar, moveBookLine, moveLines, spotLine, type MoveStatus } from './move-text';

function status(over: Partial<MoveStatus> = {}): MoveStatus {
  return {
    mode: 'analyse',
    pausedReason: null,
    pausedDetail: null,
    analysisId: 'move:1',
    progress: {
      run: 1,
      phase: 'spot',
      counts: {
        tagged: 1725,
        auto: 1700,
        held: { real_text: 20, no_epub: 5 },
        withData: 31,
        alreadyMoved: 0
      },
      write: { batches: [], waiting: null, startedAt: null },
      finishedAt: null,
      error: null
    },
    bar: null,
    proposals: { 'auto:proposed': 1700 },
    moved: 0,
    spot: { total: 30, right: 10, wrong: 0, open: 20 },
    spotPassed: false,
    target: { folder: 'manga-library', enabled: true, language: 'ja' },
    source: { id: 'j', folder: 'japanese-library' },
    ...over
  };
}

describe('the move card', () => {
  it('says what was found, the reading data, and the spot check', () => {
    expect(moveLines(status())).toEqual([
      '1,725 books tagged マンガ or 画像のみ: 1,700 to move, 25 held for you to look at.',
      '31 of them have your reading data; it stays with each book (the same book in the reader).',
      'Spot check: 10 of 30 marked. Mark every book before On.'
    ]);
    expect(moveLines(status({ mode: 'off' }))).toEqual([]);
  });

  it('asks for the library to be switched on before On', () => {
    expect(
      moveLines(status({ target: { folder: 'manga-library', enabled: false, language: null } }))[0]
    ).toBe('Switch the library "manga-library" on in the reader (with its language) before On.');
  });

  it('the spot check: passed, wrong, open', () => {
    expect(
      spotLine(status({ spotPassed: true, spot: { total: 30, right: 30, wrong: 0, open: 0 } }))
    ).toBe('Spot check passed: 30 of 30 marked right.');
    expect(spotLine(status({ spot: { total: 30, right: 29, wrong: 1, open: 0 } }))).toMatch(
      /1 marked wrong/
    );
  });

  it('the bar and a book line', () => {
    const b = moveBar(
      status({ bar: { label: 'books', done: 500, total: 1700, leftMs: 30 * 60000 } })
    );
    expect(b?.label).toBe('Moving the books: 500 of 1,700');
    expect(b?.eta).toBe('about 30 min left');
    expect(
      moveBar(status({ bar: { label: 'books', done: 5, total: 1700, leftMs: 130 * 60000 } }))?.eta
    ).toBe('about 2 h 10 min left');
    const book = {
      changeId: 1,
      calibreId: 2,
      uuid: 'u',
      title: '画集',
      authors: ['画家'],
      series: null,
      tags: [],
      matched: ['画像のみ'],
      formats: ['EPUB'],
      chars: 6200,
      hold: 'real_text' as const,
      holdText: 'Its character count shows real text',
      holdDetail: '6,200 characters',
      readerBookId: 'b1',
      readerHasData: false,
      state: 'proposed',
      klass: 'review',
      decidedBy: null
    };
    expect(moveBookLine(book)).toBe('画集 · 画家 · 6,200 characters · EPUB');
    expect(holdLine(book)).toBe('Its character count shows real text: 6,200 characters');
    expect(holdLine({ ...book, state: 'kept' })).toBe('Kept here (your choice)');
  });
});
