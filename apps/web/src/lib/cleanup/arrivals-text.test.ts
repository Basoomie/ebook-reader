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

  it('a source folder adds only after its first run and your “Add these”', () => {
    const p = {
      key: 'ja|books/japanese',
      id: 'ja',
      source: 'books/japanese',
      libraryId: 'L',
      firstRunId: null,
      firstDoneAt: null,
      approvedAt: null,
      wouldAdd: 0,
      added: 0
    };
    expect(pairLine(p)).toMatch(/First run not done/);
    expect(pairLine({ ...p, firstDoneAt: 1, wouldAdd: 120 })).toMatch(/120 books would be added/);
    expect(pairLine({ ...p, firstDoneAt: 1, approvedAt: 2, added: 5 })).toMatch(/5 added/);
  });
});
