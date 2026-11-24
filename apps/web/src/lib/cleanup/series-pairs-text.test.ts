/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  bookLine,
  mergeBlocked,
  pairReason,
  pairSignalsLine,
  seriesPairsBar,
  seriesPairsLines,
  seriesQuery,
  type SeriesPair,
  type SeriesPairsStatus
} from './series-pairs-text';

const signals = {
  collisions: 0,
  collisionsWithin: 0,
  collisionExamples: [],
  sharedAuthors: ['西村京太郎'],
  longWithShortAuthor: 1,
  ranobedb: 'none' as const,
  amazon: 'same' as const,
  storeNamesOther: true,
  spinoff: null,
  mixed: null
};
const pair = (over: Partial<SeriesPair> = {}): SeriesPair => ({
  id: 1,
  short: '十津川警部',
  long: '十津川警部シリーズ',
  group: 'series_word',
  added: 'シリーズ',
  kept: '十津川警部',
  shortBooks: 8,
  longBooks: 1,
  answer: 'merge',
  rule: 'store-same',
  held: null,
  note: null,
  signals,
  books: { short: [], long: [] },
  decision: null,
  merge: {},
  ...over
});

const status = (over: Partial<SeriesPairsStatus['progress']> = {}): SeriesPairsStatus => ({
  mode: 'analyse',
  pausedReason: null,
  stage4Done: true,
  analysisId: 'series-pairs:1',
  progress: {
    run: 1,
    phase: 'write',
    pairs: 443,
    done: 443,
    counts: { merge: 104, separate: 232, review: 107 },
    propose: { books: 292, pairs: 104, yours: 0 },
    write: { batches: [], waiting: null, repointed: 0, closed: 0 },
    finishedAt: null,
    error: null,
    ...over
  },
  bar: null,
  proposals: { proposed: 292 }
});

describe('series under two names: the card', () => {
  it('says what Preview found and what is left to write', () => {
    expect(seriesPairsLines(status())).toEqual([
      '443 pairs: 104 to merge, 232 kept separate, 107 for you to decide.',
      'Books moved into the kept name: 0 written, 292 to write.'
    ]);
    expect(seriesPairsLines({ ...status(), mode: 'off' })).toEqual([]);
  });

  it('shows the bar with the time left', () => {
    const s = {
      ...status({ phase: 'signals' }),
      bar: { label: 'pairs', done: 100, total: 400, leftMs: 180_000 }
    };
    expect(seriesPairsBar(s)).toEqual({
      label: 'Reading each pair’s books and stores: 100 of 400 pairs',
      fraction: 0.25,
      eta: 'about 3 minutes left'
    });
    expect(seriesPairsBar(status())).toBeNull();
  });
});

describe('series under two names: a pair', () => {
  it('says why it has its answer', () => {
    expect(pairReason(pair())).toBe('A store lists both as one series');
    expect(pairReason(pair({ answer: 'review', held: 'collision' }))).toBe(
      'Not merged: a book of each name has the same number (A store lists both as one series)'
    );
    expect(
      pairReason(pair({ decision: { decision: 'different', by: 'you', note: null, at: 1 } }))
    ).toBe('You chose: keep separate');
  });

  it('shows the evidence in one line', () => {
    expect(pairSignalsLine(pair())).toBe('Same author (西村京太郎) · Amazon: one series');
  });

  it('refuses Merge where two books would share a number', () => {
    expect(mergeBlocked(pair())).toBeNull();
    expect(mergeBlocked(pair({ signals: { ...signals, collisions: 1 } }))).toMatch(
      /share a number/
    );
    expect(mergeBlocked(pair({ answer: 'review', held: 'yours' }))).toMatch(/series editor/);
  });

  it('writes a book line and the series search', () => {
    expect(
      bookLine({
        uuid: 'u',
        calibreId: 1,
        title: '寝台特急殺人事件',
        authors: ['西村京太郎'],
        index: 7.5,
        kind: 'full',
        links: []
      })
    ).toBe('#7.5 寝台特急殺人事件 — 西村京太郎');
    expect(seriesQuery('十津川警部')).toBe('series:"十津川警部"');
    expect(seriesQuery('a"b')).toBeNull();
  });
});
