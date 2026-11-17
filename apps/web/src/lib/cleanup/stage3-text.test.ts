/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { CleanupStage, Stage3Pair, Stage3Progress, Stage3Status } from './cleanup-api';
import {
  bookFactsLine,
  durationText,
  gateLines,
  keepLine,
  overlapLine,
  spreadLine,
  stage3ApplyProgress,
  stage3Lines,
  stage3PauseTitle,
  stage3Progress
} from './stage3-text';
import { turnOnContentDuplicatesCopy } from '$lib/confirm/confirm-copy';

const stage = (mode: CleanupStage['mode']): CleanupStage => ({
  stage: 3,
  name: 'Content duplicates',
  built: true,
  mode,
  state: 'analysing',
  pauseReason: null,
  pauseDetail: null,
  pausedAt: null,
  progress: {},
  precision: {},
  updatedAt: 0
});

const progress = (over: Partial<Stage3Progress>): Stage3Progress => ({
  analysisId: 'x',
  phase: 'done',
  startedAt: 0,
  finishedAt: 1,
  error: null,
  phaseStartedAt: 0,
  phaseStartDone: 0,
  times: { text: { ms: 26_000, items: 0 }, compare: { ms: 4_000, items: 0 } },
  textTotal: 100,
  textDone: 100,
  textRead: 100,
  textReadMs: 20_000,
  textErrors: 2,
  imageOnly: 3,
  readerCompared: 0,
  readerDiffering: 0,
  candidates: 40,
  compareTotal: 40,
  compareDone: 40,
  compareErrors: 0,
  omnibusByText: 1,
  qualityTotal: 10,
  qualityDone: 10,
  qualityErrors: 0,
  classes: { duplicate: 12, superset: 3, never: 9, different: 10, review: 4, keep_both: 1 },
  sets: 14,
  setsWithoutKeeper: 1,
  toRemove: 13,
  review: 6,
  removedWithData: 1,
  bothWithData: 0,
  tagsCopied: 2,
  ...over
});

const status = (p: Stage3Progress | null, counts: Record<string, number> = {}): Stage3Status => ({
  waiting: null,
  progress: p,
  gate: null,
  counts,
  skipReasons: [],
  pace: { removed: 0, firstAt: null },
  awaitingIngest: null
});

describe('stage 3 wording', () => {
  it('a progress bar per step of the analysis', () => {
    const bar = stage3Progress(
      stage('analyse'),
      status(progress({ phase: 'text', textDone: 25 })),
      1
    );
    expect(bar).toMatchObject({
      label: 'Step 1 of 5 · Reading every book’s text: 25 of 100 books',
      fraction: 0.25
    });
    expect(stage3Progress(stage('off'), status(progress({ phase: 'text' })))).toBeNull();
    expect(stage3Progress(stage('analyse'), status(progress({})))).toBeNull();
  });

  it('what the analysis found, with seconds per book', () => {
    const lines = stage3Lines(stage('analyse'), status(progress({})));
    expect(lines[0]).toBe(
      'Read 100 books (2 couldn’t be read), 3 of them picture books; 40 pairs share text.'
    );
    expect(lines[1]).toMatch(
      /^13 copies to remove\. Same text: 12 pairs · one holds the other: 3 · for review: 6/
    );
    expect(lines[2]).toMatch(/1 omnibus files found by their text/);
    expect(lines[3]).toBe('The analysis took 30 s (0.26 s per book read).');
    expect(stage3Lines(stage('analyse'), status(progress({ error: 'boom' })))).toEqual([
      'The analysis stopped: boom'
    ]);
  });

  it('while it runs, each line names the finished step it is about', () => {
    expect(stage3Lines(stage('analyse'), status(progress({ phase: 'text' })))).toEqual([]);
    expect(
      stage3Lines(stage('analyse'), status(progress({ phase: 'candidates', candidates: 0 })))
    ).toEqual([
      'Step 1 done · Reading every book’s text: 100 books read (2 couldn’t be read), 0.26 s per book.'
    ]);
    const compare = stage3Lines(
      stage('analyse'),
      status(progress({ phase: 'compare', candidates: 26272 }))
    );
    expect(compare).toEqual([
      'Step 1 done · Reading every book’s text: 100 books read (2 couldn’t be read), 0.26 s per book.',
      'Step 2 done · Finding books that share text: 26,272 pairs to compare.'
    ]);
    const quality = stage3Lines(
      stage('analyse'),
      status(progress({ phase: 'quality', compareDone: 39, compareErrors: 1 }))
    );
    expect(quality[2]).toBe(
      'Step 3 done · Comparing those books word for word: 39 pairs compared (1 couldn’t be compared).'
    );
    expect(quality).toHaveLength(3);
  });

  it('removing copies once on', () => {
    expect(
      stage3ApplyProgress(status(null, { applied: 3, proposed: 7 }), stage('on'))
    ).toMatchObject({
      label: 'Removing copies: 3 of 10'
    });
    expect(stage3ApplyProgress(status(null, { proposed: 7 }), stage('on'))).toBeNull();
  });

  it('the gate and pauses in words', () => {
    expect(
      gateLines({
        checkedAt: 0,
        passed: true,
        problems: [],
        pairs: {
          file: 'f',
          total: 118,
          sameAfterStage1: 3,
          notInLibrary: 0,
          checked: 115,
          asMeasured: 115
        },
        spread: { ok: true, detail: 'Commentary edition 11.0 %' },
        kinds: {
          guards: 11,
          recognized: 11,
          missed: [],
          imageOnly: 21,
          imageOnlyRecognized: 21,
          imageOnlyMissed: []
        },
        textLength: { compared: 790, equal: 790, differing: [] }
      })
    ).toEqual([
      'Measured pairs: 115 of 115 come out as measured (3 became one copy earlier).',
      'Commentary edition 11.0 %',
      'Labeled books: 11 of 11 previews, bonus stories and omnibus files recognized; 21 of 21 picture books.',
      'Text length equal to the reader’s count: 790 of 790 labeled books.'
    ]);
    expect(stage3PauseTitle('not_identical')).toBe('A copy’s file changed since the analysis');
    expect(durationText(3_725_000)).toBe('1 h 2 min');
  });

  const pair = (over: Partial<Stage3Pair>): Stage3Pair => ({
    id: 1,
    source: 'index',
    class: 'duplicate',
    rule: 'both_ways',
    reason: 'Same text',
    container: null,
    aInB: 0.998,
    bInA: 1,
    estAInB: 1,
    estBInA: 1,
    keepId: 2,
    error: null,
    spread: null,
    best: null,
    decision: null,
    a: {
      calibreId: 1,
      title: 'A',
      author: 'X',
      tags: [],
      formats: ['EPUB'],
      addedAt: null,
      chars: 1000,
      ruby: 3,
      vertical: 1,
      images: 2
    },
    b: { calibreId: 2, title: 'A', author: 'X', tags: [], formats: ['EPUB'], addedAt: null },
    ...over
  });

  it('a pair side by side', () => {
    expect(overlapLine(pair({}))).toBe(
      '99.8 % of the left copy’s text is in the right one, 100.0 % the other way.'
    );
    expect(keepLine(pair({}))).toBe('The right copy stays.');
    expect(keepLine(pair({ keepId: null }))).toMatch(/waiting for your decision/);
    expect(keepLine(pair({ decision: 'keep_both' }))).toBe('You chose: both copies stay.');
    expect(bookFactsLine(pair({}).a)).toBe('1,000 characters · 2 pictures · furigana · vertical');
    expect(
      spreadLine(
        pair({
          spread: {
            a: null,
            b: {
              extraChars: 1,
              runs: [],
              runCount: 12,
              interleavedRuns: 12,
              interleavedChars: 1,
              interleavedShare: 0.114,
              chaptersTouched: 10
            }
          }
        })
      )
    ).toBe(
      'The right copy has 11.4 % extra text inside the chapters (12 passages in 10 chapters).'
    );
  });

  it('turning stage 3 on asks first, with the counts', () => {
    const copy = turnOnContentDuplicatesCopy({ toRemove: 1234, review: 56 });
    expect(copy.title).toBe('Remove 1,234 copies whose text another copy has?');
    expect(copy.message.join(' ')).toMatch(/56 pairs where each copy is better somewhere/);
    expect(turnOnContentDuplicatesCopy({ toRemove: null, review: null }).title).toBe(
      'Remove the copies whose text another copy has?'
    );
  });
});
