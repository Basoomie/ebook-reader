/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  linksBar,
  linksLines,
  linksSpotLine,
  picksOf,
  seriesText,
  type LinkItem,
  type LinksStatus
} from './links-text';

function status(over: Partial<LinksStatus> = {}): LinksStatus {
  return {
    mode: 'analyse',
    pausedReason: null,
    pausedDetail: null,
    stage4Done: true,
    progress: {
      run: 1,
      phase: 'record',
      books: 52120,
      record: {
        looked: 0,
        yours: 0,
        noFacts: 0,
        picked: { amazon: 0, ranobedb: 0, bookwalker: 0 },
        taken: 0
      },
      series: {
        total: 0,
        done: 0,
        picked: { amazon: 0, ranobedb: 0, bookwalker: 0 },
        agree: 0,
        differ: 0,
        saved: 0
      },
      settle: { clash: 0 },
      propose: { total: 0, done: 0, proposed: 0, held: 0, nothing: 0, yours: 0, natively: 0 },
      spot: { drawnAt: null, size: 0 },
      write: { rebuilt: false, batches: [], waiting: null },
      labeled: null,
      finishedAt: null
    },
    bar: { phase: 'record', done: 0, total: 52120, leftMs: null },
    picks: {},
    proposals: {},
    spot: { size: 0, right: 0, wrong: 0, open: 0 },
    spotPassed: false,
    spotSize: 50,
    ...over
  };
}

describe('More direct links: the card’s words', () => {
  it('shows no bar while Off, at the spot check or when done', () => {
    expect(linksBar(null)).toBeNull();
    expect(linksBar(status({ mode: 'off' }))).toBeNull();
    for (const phase of ['spot', 'done', 'settle'] as const)
      expect(linksBar(status({ bar: { phase, done: 0, total: null, leftMs: null } }))).toBeNull();
  });

  it('names the step with its count and the time left', () => {
    const b = linksBar(
      status({ bar: { phase: 'series', done: 3131, total: 6262, leftMs: 30_000 } })
    );
    expect(b?.label).toBe('Step 2 of 3: Checking the lists of each series (3,131 of 6,262)');
    expect(b?.fraction).toBe(0.5);
    expect(b?.eta).toBeTruthy();
    const w = linksBar(status({ bar: { phase: 'write', done: 10, total: 100, leftMs: null } }));
    expect(w?.label).toBe('Writing the links to Calibre (10 of 100)');
    expect(w?.eta).toBeNull();
  });

  it('says what was found, what was set aside and what is listed only', () => {
    const s = status();
    s.progress.record = {
      looked: 52120,
      yours: 2,
      noFacts: 0,
      picked: { amazon: 3204, ranobedb: 3177, bookwalker: 1917 },
      taken: 86
    };
    s.progress.series = {
      total: 6262,
      done: 6262,
      picked: { amazon: 1591, ranobedb: 672, bookwalker: 631 },
      agree: 3172,
      differ: 3,
      saved: 99
    };
    s.progress.settle.clash = 262;
    s.progress.propose.natively = 178;
    s.proposals = { proposed: 7658 };
    const lines = linksLines(s);
    expect(lines[0]).toBe(
      'Looked at 52,120 of 52,120 books. From the page found for the book: Amazon 3,204, RanobeDB 3,177, BOOK☆WALKER 1,917.'
    );
    expect(lines[1]).toContain('From a series’ list'.replace('’', "'"));
    expect(lines).toContain(
      'Set aside, no link: 3 where the two ways disagree, 262 where two books claim one page, 86 whose page another book already has.'
    );
    expect(lines).toContain('Left alone: 2 with store links you edited.');
    expect(lines).toContain(
      'Links: 7,658 books to write, 0 written; 178 of them also get a Natively link.'
    );
    expect(lines.some((l) => l.startsWith('99 saved links differ'))).toBe(true);
  });

  it('waits for stage 4 in so many words', () => {
    expect(linksLines(status({ stage4Done: false }))[0]).toMatch(/Waits for stage 4/);
    expect(linksLines(status({ stage4Done: false, mode: 'off' }))).toEqual([]);
  });

  it('needs every link of the spot check marked and none wrong', () => {
    expect(linksSpotLine(status())).toBe('');
    expect(linksSpotLine(status({ spot: { size: 50, right: 10, wrong: 0, open: 40 } }))).toBe(
      'Spot check: 10 of 50 marked, 0 wrong. On needs every link marked and none wrong.'
    );
    expect(linksSpotLine(status({ spot: { size: 50, right: 49, wrong: 1, open: 0 } }))).toMatch(
      /A wrong link was found: On stays off/
    );
    expect(
      linksSpotLine(status({ spot: { size: 50, right: 50, wrong: 0, open: 0 }, spotPassed: true }))
    ).toMatch(/Passed: On can be switched on/);
  });

  it('adds up the picks of a state per site', () => {
    const s = status({
      picks: {
        'ok:amazon:record': 3187,
        'ok:amazon:series': 1516,
        'ok:ranobedb:record': 3066,
        'clash:amazon:record': 17,
        'saved:ranobedb:series': 9
      }
    });
    expect(picksOf(s, 'ok')).toEqual({ amazon: 4703, ranobedb: 3066, bookwalker: 0, all: 7769 });
    expect(picksOf(s, 'saved').all).toBe(9);
  });

  it('writes a book’s series with its number', () => {
    const m = { book: { series: '花嫁', number: 7.5 } } as LinkItem;
    expect(seriesText(m)).toBe('花嫁 7.5');
    expect(seriesText({ book: { series: null, number: null } } as LinkItem)).toBe('');
  });
});
