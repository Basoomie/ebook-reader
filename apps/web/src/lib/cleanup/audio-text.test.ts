/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  audioStage1Bar,
  audioStage1Lines,
  audioStage2Bar,
  booksLines,
  diskLine,
  durationText,
  identityLines,
  snapshotLine
} from './audio-text';
import type { AudioStage1Progress, AudioStage2Progress } from './cleanup-api';

const NOW = 1_800_000_000_000;

function s1(over: Partial<AudioStage1Progress> = {}): AudioStage1Progress {
  return {
    analysisId: 'a',
    phase: 'hash',
    startedAt: NOW - 3_600_000,
    finishedAt: null,
    walk: {
      startedAt: 0,
      finishedAt: 0,
      files: { torrents: 8431, library: 20443 },
      audio: { torrents: 6065, library: 5586 },
      bytes: { torrents: 2660 * 1024 ** 3, library: 2476 * 1024 ** 3 },
      skippedFolders: 0,
      links: 0,
      errors: [],
      gone: 0,
      rawNames: 0
    },
    hashTotal: 12_000,
    hashDone: 3_000,
    hashBytesTotal: 4_000_000_000_000,
    bytesHashed: 1_000_000_000_000,
    hashErrors: 0,
    hashChanged: 0,
    hashReused: 0,
    phaseStartedAt: NOW - 8_000_000,
    phaseStartBytes: 0,
    yields: 2,
    error: null,
    ...over
  };
}

describe('the Audiobooks tab wording', () => {
  it('names who reads the disk and who waits', () => {
    expect(diskLine({ holder: null, waiting: [] }, NOW)).toBe(
      'The disk is free: no cleanup job is reading it'
    );
    expect(
      diskLine(
        {
          holder: { owner: 'Audiobooks stage 1 (identity)', side: 'audio', since: NOW - 120_000 },
          waiting: [{ owner: 'Calibre stage 3 (content duplicates)', side: 'calibre', since: NOW }]
        },
        NOW
      )
    ).toBe(
      'Reading the disk: Audiobooks stage 1 (identity) (for 2 min) · waiting: Calibre stage 3 (content duplicates)'
    );
  });

  it('stage 1: bytes read, pace and time left', () => {
    const bar = audioStage1Bar(s1(), NOW)!;
    expect(bar.label).toMatch(/^Reading files to compare their contents: 931\.3 GB of 3725\.3 GB$/);
    expect(bar.fraction).toBeCloseTo(0.25);
    expect(bar.eta).toBe('about 6 h 40 min left');
    expect(audioStage1Bar(s1({ phase: 'walk' }), NOW)).toBeNull();
    const lines = audioStage1Lines(s1(), NOW);
    expect(lines[0]).toBe('Now: Reading files to compare their contents.');
    expect(lines[1]).toBe(
      'Found 6,065 audio files in the torrents (2660.0 GB) and 5,586 in the library (2476.0 GB).'
    );
    expect(lines[2]).toBe('3,000 of 12,000 files to compare read (125 MB/s).');
    expect(lines).toContain('Gave the disk to the Calibre cleanup 2 times.');
  });

  it('what stage 1 found', () => {
    const lines = identityLines({
      'library.copy': 5581,
      'library.copy.bytes': 2476 * 1024 ** 3,
      'library.library_only': 5,
      'torrents.torrent_only': 449,
      'torrents.torrent_only.bytes': 170 * 1024 ** 3,
      'torrents.copy_extra': 872,
      'torrents.copy_groups': 872,
      'library.ai_original': 122,
      'library.ai_original.bytes': 32.2 * 1024 ** 3,
      'torrents.archive': 93
    });
    expect(lines[0]).toBe('5,581 library files are exact copies of a torrent file (2476.0 GB).');
    expect(lines).toContain('5 library files have no torrent file of the same size.');
    expect(lines).toContain('449 torrent audio files are not in the library (170.0 GB).');
    expect(lines).toContain(
      '122 library files come from the AI folder (32.2 GB); they move to japanese-generated later.'
    );
    expect(lines.some((l) => /same size but other contents/.test(l))).toBe(false);
    const one = identityLines({
      'library.linked': 1,
      'torrents.archive': 1,
      'torrents.copy_extra': 1,
      'torrents.copy_groups': 1,
      'files.nlink_gt1': 2
    });
    expect(one).toContain('1 library file is already a hard link to its torrent file.');
    expect(one).toContain('1 archive in the torrents (.zip/.rar), to unpack later.');
    expect(one).toContain('1 torrent file is an exact copy of another torrent file (1 group).');
    expect(identityLines(null)).toEqual([]);
  });

  it('stage 2: files checked and what it found', () => {
    const p: AudioStage2Progress = {
      analysisId: 'b',
      phase: 'health',
      startedAt: NOW - 600_000,
      finishedAt: null,
      walk: null,
      books: 10_800,
      healthTotal: 11_651,
      healthDone: 5_000,
      healthReused: 0,
      phaseStartedAt: NOW - 500_000,
      phaseStartDone: 0,
      error: null
    };
    expect(audioStage2Bar(p, NOW)!.label).toBe('Checking each file: 5,000 of 11,651 files');
    const lines = booksLines({
      'torrents.single': 6000,
      'torrents.likely_copies': 3,
      'library.abs_items': 5354,
      'library.abs_items.multi': 176,
      'library.abs_items.no_torrent_book': 5,
      'library.health.mp4_no_chapters': 700,
      'books.decoded_names': 12
    });
    expect(lines[2]).toBe(
      'Library: 5,354 Audiobookshelf items recorded as they are (not used as books); 176 with several files, 5 whose files match no torrent book.'
    );
    expect(lines[lines.length - 1]).toMatch(/^12 book names are garbled Japanese/);
  });

  it('the snapshot and lengths', () => {
    expect(snapshotLine(null)).toBe('No snapshot yet.');
    expect(
      snapshotLine({
        takenAt: NOW,
        serverVersion: '2.37.1',
        libraries: 3,
        items: 5400,
        users: 1,
        progress: 15,
        finished: 5,
        inProgress: 10,
        notInAbs: 4,
        problems: 0
      })
    ).toBe(
      '3 libraries with 5,400 items; 1 user (Audiobookshelf 2.37.1); 15 books with listening progress: 5 finished, 10 started, 4 no longer in Audiobookshelf.'
    );
    // Every library on its own, not added up (user, 2026-11-18).
    expect(
      snapshotLine({
        takenAt: NOW,
        serverVersion: '2.37.1',
        libraries: 3,
        items: 5400,
        perLibrary: [
          { name: 'Japanese Audiobooks', items: 5354, progress: 14 },
          { name: 'English', items: 1, progress: 0 },
          { name: null, items: null, progress: 1 }
        ],
        users: 1,
        progress: 15,
        finished: 5,
        inProgress: 10,
        notInAbs: 0,
        problems: 0
      })
    ).toBe(
      '3 libraries: Japanese Audiobooks 5,354 items (14 with progress) · English 1 item · (no name) (items not known) (1 with progress); 1 user (Audiobookshelf 2.37.1); 15 books with listening progress: 5 finished, 10 started.'
    );
    expect(durationText(46_620)).toBe('12 h 57 min');
    expect(durationText(65)).toBe('1 min 5 s');
    expect(durationText(null)).toBe('–');
  });
});
