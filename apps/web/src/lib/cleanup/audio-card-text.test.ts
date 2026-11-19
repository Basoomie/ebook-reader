/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { diskBusy, gateSummary, stageSummary } from './audio-card-text';
import type { AudioStatus } from './cleanup-api';

const done = { phase: 'done' };
const status = {
  stage1: { progress: done, counts: { 'library.copy': 5581, 'torrents.torrent_only': 449 } },
  stage2: {
    progress: done,
    counts: {
      'torrents.single': 5960,
      'torrents.parts': 10,
      'torrents.likely_copies': 15,
      'torrents.unclear': 0,
      'torrents.health.damaged': 38,
      'torrents.health.unreadable': 1
    }
  },
  stage3: {
    progress: done,
    counts: {
      'decisions.auto.rule.identical': 860,
      'decisions.auto.rule.branding': 225,
      dropped: 1092,
      review: 62
    }
  },
  stage4: {
    progress: done,
    counts: { auto: 4664, review: 82, unknown: 23, none_expected: 129 }
  }
} as unknown as AudioStatus;

describe('the Audiobooks tab’s short lines', () => {
  it('one summary per finished stage', () => {
    expect(stageSummary(1, status)).toBe(
      '5,581 library files are copies of torrent files; 449 torrent files are not in the library.'
    );
    expect(stageSummary(2, status)).toBe(
      '5,985 books; 39 torrent files can’t be read or fail to play at an end.'
    );
    expect(stageSummary(3, status)).toBe(
      '1,085 recordings proven to have a copy not needed (1,092 copies); 62 to review.'
    );
    expect(stageSummary(4, status)).toBe(
      '4,664 matched, 82 to review, 23 not found, 129 not looked up.'
    );
    const running = {
      ...status,
      stage4: { ...status.stage4, progress: { phase: 'lookups' } }
    } as unknown as AudioStatus;
    expect(stageSummary(4, running)).toBeNull();
  });

  it('the gate in one line; the disk line only while a job uses the disk', () => {
    expect(
      gateSummary(4, { passed: true, checked: 200, misses: [], bySource: {}, error: null })
    ).toBe('Labeled books: ✓ passes (200 checked).');
    expect(
      gateSummary(4, {
        passed: false,
        checked: 200,
        misses: [{}, {}] as never,
        bySource: {},
        error: null
      })
    ).toBe('Labeled books: ✗ 2 books matched differently from their labels.');
    expect(
      gateSummary(3, {
        passed: true,
        checked: 94,
        correct: 94,
        sameChecked: 94,
        sameCorrect: 94,
        bestChecked: 60,
        bestCorrect: 60,
        skipped: 0,
        misses: [],
        error: null
      })
    ).toBe('Labeled pairs: ✓ 94 of 94 as labeled.');
    expect(diskBusy({ holder: null, waiting: [], calibreApplying: null })).toBe(false);
    expect(
      diskBusy({
        holder: { owner: 'Calibre stage 3', side: 'calibre', since: 0 },
        waiting: [],
        calibreApplying: null
      })
    ).toBe(true);
  });
});
