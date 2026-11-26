/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  barLine,
  bookFacts,
  formatsLines,
  type FormatsBook,
  type FormatsStatus
} from './formats-text';

const status = (over: Partial<FormatsStatus> = {}): FormatsStatus => ({
  mode: 'analyse',
  pausedReason: null,
  pausedDetail: null,
  analysisId: 'formats:1',
  progress: {
    run: 1,
    phase: 'spot',
    write: { batches: [], waiting: null, startedAt: null },
    finishedAt: null,
    error: null
  },
  bars: [],
  counts: {
    byState: { listed: 133, proposed: 950 },
    listed: { pdf: 85 },
    proposals: {
      'epub:auto:proposed': 600,
      'fold:auto:proposed': 300,
      'fold:review:proposed': 5,
      'epub:auto:applied': 2
    },
    written: { convert: 0, fold: 0, undone: 0 },
    stored: {}
  },
  listedText: { pdf: 'PDF only' },
  spot: { total: 30, right: 10, wrong: 0, open: 20 },
  spotPassed: false,
  sidecar: { ready: true, need: '1.7.0' },
  library: { id: 'l', folder: 'japanese-library' },
  ...over
});

describe('the books-without-an-EPUB card', () => {
  it('says what was found, what is to write and what the spot check waits for', () => {
    expect(formatsLines(status())).toEqual([
      '1,083 books without an EPUB: 950 to convert or compare, 133 listed and left.',
      'To write: 600 EPUBs for their own books, 300 copies folded into their EPUB book; 5 near copies for you to look at.',
      'The spot check: 10 of 30 marked. On waits for every book marked and none wrong.'
    ]);
    expect(formatsLines(status({ sidecar: { ready: false, need: '1.7.0' } }))[0]).toMatch(
      /sidecar must be 1\.7\.0/
    );
  });

  it('shows each bar with the time left from what is open', () => {
    expect(
      barLine({
        phase: 'convert',
        label: 'Converted',
        done: 120,
        total: 1066,
        leftMs: 3 * 3600_000,
        note: null
      })
    ).toBe('Converted: 120 of 1,066 · about 3 h left');
    expect(
      barLine({ phase: 'convert', label: 'Converted', done: 5, total: 5, leftMs: 0, note: null })
    ).toBe('Converted: 5 of 5');
  });

  it("lists a book's facts for the spot check", () => {
    const b = {
      sourceFormat: 'CBZ',
      group: 'picture',
      sourceChars: null,
      epubChars: null,
      readerChars: 2,
      sourceImages: 3,
      epubImages: 4,
      epubSize: 3 * 1024 * 1024
    } as FormatsBook;
    expect(bookFacts(b)).toBe(
      'CBZ → EPUB · picture book · the reader counts 2 · 4 pictures (3 in the archive) · 3.0 MB'
    );
  });
});
