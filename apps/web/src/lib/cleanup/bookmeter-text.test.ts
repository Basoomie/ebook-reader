/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  addedText,
  bookmeterBar,
  bookmeterLines,
  sourceText,
  spotLine,
  type BookmeterMatch,
  type BookmeterStatus
} from './bookmeter-text';

function status(over: Partial<BookmeterStatus> = {}): BookmeterStatus {
  return {
    mode: 'analyse',
    pausedReason: null,
    pausedDetail: null,
    stage4Done: true,
    progress: {
      run: 1,
      phase: 'stores',
      books: 52120,
      counts: {
        looked: 52120,
        before: 13508,
        yours: 2,
        hasId: 0,
        notSearched: 0,
        leftOut: 61,
        rules: 23017,
        near: 6878,
        second: 1062,
        none: 7594
      },
      ai: { items: 6878, accepted: 4800, notAccepted: 2078, wait: null, costUsd: 2.71 },
      second: { books: 1062, asked: 1700, found: 300 },
      stores: { asked: 28117, answered: 100, failed: 2 },
      propose: { proposed: 0, held: 0, nothing: 0, yours: 0 },
      spot: { drawnAt: null, size: 0 },
      write: { waiting: null, batches: [], finishedAt: null },
      labeled: null,
      finishedAt: null
    },
    bar: { phase: 'stores', done: 100, total: 28117, leftMs: 5 * 3600_000, measured: false },
    books: {},
    proposals: {},
    spot: { size: 0, right: 0, wrong: 0, open: 0 },
    spotPassed: false,
    siteWait: null,
    ...over
  };
}

describe('More Bookmeter matches: the card text', () => {
  it("shows the step, its count and the time left at Bookmeter's pace until measured", () => {
    expect(bookmeterBar(status())).toEqual({
      label: 'Step 4 of 5: Reading the store lists (100 of 28,117)',
      fraction: 100 / 28117,
      eta: "about 5 h left (counted at Bookmeter's pace until measured)"
    });
    expect(bookmeterBar(status({ mode: 'off' }))).toBeNull();
  });

  it('says what was found by source and what is left alone', () => {
    const lines = bookmeterLines(status());
    expect(lines[0]).toBe(
      'Looked at 52,120 of 52,120 books: 13,508 already matched (kept), 23,017 new by the rules, 6,878 near misses for the AI check, 1,062 with no results to search again, 7,594 without a match.'
    );
    expect(lines[1]).toBe(
      'Left alone: 2 with store links you edited, 61 bonus stories or omnibus editions (not searched again).'
    );
    expect(lines[2]).toBe(
      'AI check: 4,800 of 6,878 accepted (both models said yes), $2.71 so far.'
    );
    expect(lines).toContain('Store lists: 100 of 28,117 read (2 failed: the Bookmeter id alone).');
  });

  it("says the spot check's state and when On can be switched on", () => {
    expect(spotLine(status())).toBe('');
    expect(spotLine(status({ spot: { size: 50, right: 40, wrong: 1, open: 9 } }))).toBe(
      'Spot check: 41 of 50 marked, 1 wrong. On needs every book marked and at most 1 wrong.'
    );
    expect(
      spotLine(status({ spot: { size: 50, right: 49, wrong: 1, open: 0 }, spotPassed: true }))
    ).toBe('Spot check: 50 of 50 marked, 1 wrong. Passed: On can be switched on.');
    expect(spotLine(status({ spot: { size: 50, right: 48, wrong: 2, open: 0 } }))).toContain(
      'On stays off'
    );
  });

  it('names the source of a match and the ids it adds', () => {
    const m = {
      source: 'second',
      result: { query: 'q2' },
      proposal: { state: 'proposed', added: { bookmeter: '44', isbn: '978' }, reason: null }
    } as unknown as BookmeterMatch;
    expect(sourceText(m)).toBe('the second search (title and author)');
    expect(addedText(m)).toBe('bookmeter 44, isbn 978');
    expect(addedText({ ...m, proposal: null })).toBe('nothing to add');
  });
});
