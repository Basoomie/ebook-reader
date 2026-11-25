/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  arrivalsBar,
  arrivalsReportLines,
  arrivalsSummary,
  pairLine,
  type ArrivalsStatus
} from './arrivals-text';

const base: ArrivalsStatus = {
  mode: 'analyse',
  pause: null,
  nextRunAt: null,
  timeZone: 'America/Los_Angeles',
  importProblem: null,
  design: 'J',
  pairs: [],
  reviews: 0,
  run: null,
  last: null
};

describe('the new arrivals card', () => {
  it('names the step and its time left; bytes decide the reading steps', () => {
    const bar = arrivalsBar({
      ...base,
      run: {
        id: 1,
        trigger: 'schedule',
        mode: 'analyse',
        phase: 'identify',
        startedAt: 0,
        waiting: null,
        scope: { import: 0, hand: 0 },
        cost: 0,
        jGate: null,
        times: {},
        bar: {
          phase: 'identify',
          index: 2,
          phases: 19,
          done: 10,
          total: 40,
          bytesDone: 100,
          bytesTotal: 400,
          secondsLeft: 600
        }
      }
    })!;
    expect(bar.label).toBe('Step 3 of 19: Reading the new files');
    expect(bar.fraction).toBe(0.25);
    expect(bar.eta).toBe('about 10 min left');
  });

  it('names the part of the compare step the count and the time left are for', () => {
    const run = (stage: string, index: number) =>
      arrivalsBar({
        ...base,
        run: {
          id: 1,
          trigger: 'now',
          mode: 'analyse',
          phase: 'compare',
          startedAt: 0,
          waiting: null,
          scope: { import: 0, hand: 0 },
          cost: 0,
          jGate: null,
          times: {},
          bar: {
            phase: 'compare',
            index: 3,
            phases: 19,
            done: 1505,
            total: 61064,
            bytesDone: null,
            bytesTotal: null,
            secondsLeft: 3 * 3600,
            part: { index, count: 6, stage }
          }
        }
      })!;
    const measuring = run('measure', 4);
    expect(measuring.label).toBe(
      'Step 4 of 19: Comparing them with the library, part 5 of 6: measuring the pairs with the same text (1,505 of 61,064)'
    );
    // Only deciding (minutes) is left after measuring: the time left is the whole step's.
    expect(measuring.eta).toBe('about 3 h left');
    // Before measuring, the later parts' size is not known yet: the time left is this part's.
    const reading = run('text', 2);
    expect(reading.label).toContain('part 3 of 6: reading the new books');
    expect(reading.eta).toBe('about 3 h left in this part');
  });

  it('names the parts of stage 1 and the AI check, with the time left', () => {
    const run = (phase: string, index: number, stage: string, part = true) =>
      arrivalsBar({
        ...base,
        run: {
          id: 1,
          trigger: 'now',
          mode: 'on',
          phase,
          startedAt: 0,
          waiting: null,
          scope: { import: 0, hand: 0 },
          cost: 0,
          jGate: null,
          times: {},
          bar: {
            phase,
            index,
            phases: 20,
            done: 2833,
            total: 11690,
            bytesDone: null,
            bytesTotal: null,
            secondsLeft: 540,
            part: part
              ? { index: stage === 'stat' || stage === 'cheap' ? 0 : 1, count: 2, stage }
              : null
          }
        }
      })!;
    const stat = run('stage1', 7, 'stat');
    expect(stat.label).toBe(
      'Step 8 of 20: Stage 1: identical files, part 1 of 2: reading the new books’ file sizes (2,833 of 11,690)'
    );
    expect(stat.eta).toBe('about 9 min left in this part');
    expect(stat.fraction).toBeCloseTo(2833 / 11690);
    expect(run('stage1', 7, 'match').eta).toBe('about 9 min left');
    expect(run('ai', 13, 'strong').label).toContain('part 2 of 2: the stronger pair answering');
    // A step with a count and no parts: its count and the whole step's time left.
    const write = run('write2', 11, '', false);
    expect(write.label).toBe('Step 12 of 20: Writing stage 2’s changes (2,833 of 11,690)');
    expect(write.eta).toBe('about 9 min left');
  });

  it('says what the last run did, Preview and On', () => {
    expect(arrivalsSummary(base)).toBe('No run yet.');
    const report = {
      mode: 'analyse' as const,
      outcomes: { new: 3, identical: 10, duplicate: 2, not_imported: 5, waiting: 1 },
      formats: { EPUB: 16, AZW3: 5 },
      added: 0,
      hand: 0,
      written: {},
      reviews: 0,
      newReview: 1,
      bestGuesses: 0,
      existingSeriesChanges: 2,
      aiCost: 0,
      check: null,
      estimate: { books: 3, aiUsd: 0.02, seconds: 7300 }
    };
    const s = {
      ...base,
      last: {
        id: 1,
        trigger: 'now',
        mode: 'analyse',
        state: 'done',
        startedAt: 0,
        finishedAt: 1,
        error: null,
        report
      }
    };
    expect(arrivalsSummary(s)).toBe(
      'Last run: 3 would be added (Preview), 12 copies of library books, 5 not imported, 1 waiting, 1 to look at.'
    );
    const lines = arrivalsReportLines(s);
    expect(lines[0]).toBe('Files looked at by format: EPUB 16, AZW3 5.');
    expect(lines.join('\n')).toContain('On would add 3 books: AI about $0.02, about 2 h');
    expect(lines.join('\n')).toContain('2 books already in Calibre would get another number');
  });

  it('a source folder adds only after its first run, once On (no “Add these”)', () => {
    const p = {
      key: 'ja|books/japanese',
      id: 'ja',
      source: 'books/japanese',
      libraryId: 'L',
      firstRunId: null,
      firstDoneAt: null,
      wouldAdd: 0,
      added: 0
    };
    expect(pairLine(p)).toMatch(/First run not done/);
    expect(pairLine({ ...p, waiting: 98572, settleMinutes: 30 })).toBe(
      'First run not done yet: 98,572 files wait until they have been unchanged for 30 minutes; a run looks at them then by itself (a Preview).'
    );
    expect(pairLine({ ...p, firstDoneAt: 1, wouldAdd: 120 })).toBe(
      'First run done: 120 books would be added once New arrivals is On.'
    );
    expect(pairLine({ ...p, firstDoneAt: 1, added: 5 }, 'on')).toMatch(/5 added so far/);
  });
});
