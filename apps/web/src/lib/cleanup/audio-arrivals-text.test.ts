/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  absLine,
  changeLines,
  changeStep,
  changesLines,
  designLines,
  inZone,
  phaseLabel,
  reportLines,
  stage7Bar,
  stage7Summary
} from './audio-arrivals-text';
import type { AudioStage7Run, AudioStage7Status } from './cleanup-api';

const NOW = Date.parse('2026-11-21T12:00:00');

function run(over: Partial<AudioStage7Run> = {}): AudioStage7Run {
  return {
    runId: 3,
    trigger: 'schedule',
    mode: 'analyse',
    phase: 'archives',
    startedAt: NOW - 3_600_000,
    finishedAt: null,
    phaseStartedAt: NOW - 600_000,
    phaseStartDone: 0,
    phaseTimes: {},
    archives: {
      total: 93,
      waiting: 0,
      toList: 0,
      listed: 92,
      entries: 400,
      bytes: 80e9,
      extracted: 100,
      extractedBytes: 20e9,
      thisRun: 100,
      problems: { not_archive: 1, password: 2 }
    },
    classify: null,
    plan: null,
    build: {
      total: 0,
      done: 0,
      failed: 0,
      batches: 0,
      startedAt: null,
      lockWaitMs: 0,
      yields: 0,
      firstFailure: null
    },
    walks: {},
    check: null,
    abs: {
      library: null,
      before: null,
      after: null,
      found: 0,
      missing: 0,
      valuesOk: 0,
      valuesDiffer: 0,
      nudged: 0,
      waitingSince: null,
      error: null,
      precedence: null
    },
    waiting: null,
    error: null,
    ...over
  };
}

describe('stage 7 texts', () => {
  it('a bar with time left for unpacking, building and the walks', () => {
    const b = stage7Bar(run(), NOW)!;
    expect(b.label).toContain('18.6 GB of 74.5 GB unpacked (100 of 400 files)');
    expect(b.fraction).toBeCloseTo(0.25);
    expect(b.eta).toBe('about 30 min left');
    const build = stage7Bar(
      run({
        phase: 'build',
        build: { ...run().build, total: 200, done: 50, startedAt: NOW - 60_000 }
      }),
      NOW
    )!;
    expect(build.label).toBe('Adding the new books: 50 of 200 operations');
    expect(build.eta).toBe('about 3 min left');
    expect(stage7Bar(run({ finishedAt: NOW }), NOW)).toBeNull();
    expect(phaseLabel('stages')).toBe('Stages 2-5 run again');
  });

  it('the summary: next run, last run, Preview vs On', () => {
    const s: AudioStage7Status = {
      available: true,
      switched: true,
      running: false,
      nextRunAt: Date.parse('2026-11-22T05:00:00'),
      run: run({ finishedAt: NOW - 1000 }),
      report: {
        mode: 'analyse',
        added: 0,
        planned: 12,
        outcomes: { new: 12, identical: 40, duplicate: 3, waiting: 1 },
        newReview: 2,
        openReview: 5,
        aiCostUsd: 0.4,
        designs: { E: 4898, F: 0, J: 12 },
        times: {},
        lockWaitMs: 0,
        yields: 0,
        changedExisting: { differ: 0, same: 4773, rekeyed: 5 }
      }
    };
    expect(stage7Summary(s, NOW)).toBe(
      'Last run today 11:00 (Preview): 12 would be added, 43 copies recorded, 1 waiting. Next run tomorrow 05:00.'
    );
    expect(stage7Summary({ available: true, switched: false }, NOW)).toBe(
      'Starts after the switch to the new library'
    );
    // The schedule's own clock when its zone is not this browser's (a container without TZ).
    const t = Date.parse('2026-11-22T05:00:00Z');
    expect(inZone(t, 'UTC')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC' ? '' : ' (05:00 UTC)'
    );
    expect(inZone(t, Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('');
    expect(inZone(t, undefined)).toBe('');
    expect(reportLines(s).some((l) => l.includes('Archives: 93'))).toBe(true);
    expect(reportLines(s).some((l) => l.includes('2 need a password'))).toBe(true);
  });

  it('the Audiobookshelf line shows the real item counts, also when no book was added', () => {
    const abs = run().abs;
    expect(absLine({ ...abs, before: 4787, after: 4787 })).toBe(
      'Audiobookshelf: 4,787 → 4,787 items; no new books'
    );
    expect(absLine({ ...abs, before: 4787, after: 4790, found: 3, valuesOk: 3 })).toBe(
      'Audiobookshelf: 4,787 → 4,790 items; 3 new books shown, 0 not shown; values as written: 3, different: 0'
    );
    expect(absLine({ ...abs, error: 'Audiobookshelf is not set up (address and API key)' })).toBe(
      'Audiobookshelf: no new books; Audiobookshelf is not set up (address and API key)'
    );
    expect(absLine({ ...abs, before: 4787 })).toBe(
      'Audiobookshelf: 4,787 items before the run (not read after); no new books'
    );
    expect(absLine(abs)).not.toContain('?');
  });

  it('the E/F/J line says what an upgrade would re-check and leave out', () => {
    const lines = designLines({
      available: true,
      designs: { E: 4898, F: 0, J: 12 },
      upgrade: {
        F: { items: 551, fields: 900, costUsd: 5.5 },
        J: { items: 1200, fields: 3000, costUsd: 12 },
        includeDecided: false,
        models: ['claude-sonnet-5-5', 'gpt-6.1-sol']
      }
    });
    expect(lines[0]).toBe('Recordings by AI setup: E 4,898 · F 0 · J 12');
    expect(lines[1]).toContain('a J upgrade 3,000 fields of 1,200 recordings (about $12.00)');
    expect(lines[2]).toContain('are left out');
  });
});

describe('WP21f-2: the library changes on the card', () => {
  const counts = {
    changes: 13,
    metadata: 13,
    moves: 11,
    renames: 0,
    renamesHeld: 0,
    rmdirs: 7,
    readerFiles: 0,
    readerWaiting: 0,
    links: 0,
    reviews: 0,
    kept: 1,
    userFields: 0
  };
  const changes = {
    mode: 'analyse' as const,
    ledger: 4909,
    candidates: 14,
    counts,
    apply: { total: 0, done: 0, failed: 0, batches: 0, lockWaitMs: 0, yields: 0 },
    snapshot: null,
    remap: null,
    abs: {
      library: null,
      before: null,
      after: null,
      scannedAt: null,
      verified: 0,
      notYet: 0,
      problems: [],
      error: null
    },
    error: null,
    times: { plan: { ms: 4000, items: 4909 } }
  };

  it('Preview says what would change (the live copy’s counts)', () => {
    const lines = changesLines(changes);
    expect(lines[0]).toBe(
      'Books in the library: 4,909; 14 differ from their decisions now; 13 changes planned (Preview), 1 kept as built'
    );
    expect(lines[1]).toBe(
      '13 metadata.json to write, 11 folders to move, 0 files to number in story order, 7 emptied folders'
    );
    expect(lines.some((l) => l.startsWith('Time (waiting left out): comparing every book'))).toBe(
      true
    );
  });

  it('On reports ABS: one scan, every changed book seen, progress kept', () => {
    const lines = changesLines({
      ...changes,
      mode: 'on',
      remap: { changed: 1, resolveBefore: 1, resolveAfter: 1 },
      snapshot: 'pre-wp21e2-library-changes-x.db',
      abs: { ...changes.abs, before: 4787, after: 4787, scannedAt: 1, verified: 13 }
    });
    expect(lines.join('\n')).toContain('Reader links: 1 moved; 1 of 1 that played still play');
    expect(lines.join('\n')).toContain(
      'Audiobookshelf: 4787 → 4787 items after one library scan; 13 changed books seen at their folders, 0 not yet; progress and bookmarks as before'
    );
  });

  it('item 6: what ABS made of the writes, the older values it kept, the edit call', () => {
    const lines = changesLines({
      ...changes,
      mode: 'on',
      counts: { ...counts, reviews: 1, absKept: 1 },
      seen: { checked: 4787, proven: 4782, unproven: 5, notInAbs: 0, cursor: 0, skipped: null },
      abs: { ...changes.abs, before: 4787, after: 4787, scannedAt: 1, verified: 1, set: 1 }
    }).join('\n');
    expect(lines).toContain(
      'Your edits in Audiobookshelf kept: 0 fields; to look at: 1 (1 field where Audiobookshelf kept an older value)'
    );
    expect(lines).toContain(
      'What Audiobookshelf made of the cleanup’s metadata.json: 4,782 books proven (changed only by its own scan of the cleanup’s write), 5 not provable (a value there that differs from the cleanup’s counts as yours)'
    );
    expect(lines).toContain(
      '1 with the cleanup’s value set through its edit call where it had kept an older one'
    );
    expect(
      changesLines({
        ...changes,
        seen: {
          checked: 0,
          proven: 0,
          unproven: 0,
          notInAbs: 0,
          cursor: 0,
          skipped: 'Audiobookshelf is not set up'
        }
      }).join('\n')
    ).toContain(
      'What Audiobookshelf made of the cleanup’s metadata.json: Audiobookshelf is not set up'
    );
    expect(
      changesLines({
        ...changes,
        seen: { checked: 1, proven: 0, unproven: 0, notInAbs: 1, cursor: 0, skipped: null }
      }).join('\n')
    ).toContain(
      'What Audiobookshelf made of the cleanup’s metadata.json: 1 not in Audiobookshelf yet (asked again next run)'
    );
    expect(
      changeLines({
        id: 1,
        bookId: 1,
        state: 'review',
        folderFrom: 'japanese/今野敏/色シリーズ/Vol 3 - ST 黄',
        folderTo: null,
        fields: [],
        userFields: [],
        conflicts: [],
        absKept: [
          {
            field: 'series',
            from: ['STシリーズ', '色シリーズ #3'],
            to: ['STシリーズ', '色シリーズ #3'],
            mine: ['色シリーズ #3', 'STシリーズ #6']
          }
        ],
        renames: [],
        renamesHeld: false,
        reviews: [{ kind: 'abs_kept', text: 'Audiobookshelf kept an older value of series' }],
        skipped: null
      })[0]
    ).toBe(
      'Series: Audiobookshelf kept 色シリーズ #3、STシリーズ #6 · the cleanup wrote STシリーズ、色シリーズ #3'
    );
    expect(changeStep('seen')).toBe('what Audiobookshelf made of the cleanup’s metadata.json');
  });

  it('one change as lines: the move, each field old → new, yours kept, the names', () => {
    expect(
      changeLines({
        id: 1,
        bookId: 1,
        state: 'planned',
        folderFrom: 'japanese/芥川龍之介/芥川龍之介/Vol 3 - x',
        folderTo: 'japanese/芥川龍之介/芥川龍之介 03',
        fields: [{ field: 'series', from: ['芥川龍之介 #3'], to: [] }],
        userFields: ['title'],
        conflicts: [],
        renames: [{ from: 'a.mp3', to: '01 a.mp3' }],
        renamesHeld: true,
        reviews: [{ kind: 'rename_progress', text: 'Someone is listening' }],
        skipped: null
      })
    ).toEqual([
      'Folder → japanese/芥川龍之介/芥川龍之介 03',
      'Series: 芥川龍之介 #3 → —',
      'Yours in Audiobookshelf, kept: Title',
      'Not yet numbered: a.mp3 → 01 a.mp3',
      'Someone is listening'
    ]);
  });

  it('the bar of the changes step, and its waiting line', () => {
    const c = {
      ...changes,
      phase: 'read',
      phaseStartedAt: NOW - 120_000,
      startedAt: NOW - 20_000,
      phaseTimes: {},
      waitMs: 0,
      waitSince: null,
      waiting: null,
      done: 5,
      total: 10,
      preflightProblems: []
    };
    const bar = stage7Bar(run({ phase: 'changes', changes: c }), NOW)!;
    expect(bar.label).toBe(
      'Changes to books in the library: reading the books that differ (metadata.json, Audiobookshelf) (5 of 10)'
    );
    expect(bar.fraction).toBe(0.5);
    expect(bar.eta).not.toBeNull();
    const waiting = stage7Bar(
      run({
        phase: 'changes',
        changes: { ...c, waiting: 'Waiting while the Calibre cleanup uses the disk' }
      }),
      NOW
    )!;
    expect(waiting.label).toBe(
      'Changes to books in the library: Waiting while the Calibre cleanup uses the disk'
    );
    expect(phaseLabel('changes')).toBe('Changes to books in the library');
  });
});
