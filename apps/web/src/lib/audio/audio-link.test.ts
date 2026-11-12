/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  COPIES_HINT,
  fileDetails,
  folderDetails,
  formatAudioLength,
  linkDetails,
  linkMarks,
  mergeActive,
  mergeSelection,
  mergeSizeEstimate,
  mergeStatusText,
  moveItem,
  severalFilesNote,
  linkView,
  linkedFolderName,
  scanBusy,
  scanStatusText,
  linkedSubtitleName,
  splitNotice,
  subtitleDetails,
  subtitleView,
  subtitleJobActive,
  subtitleJobText,
  timeAgo,
  withoutIds
} from './audio-link';
import type {
  AudioFolderSummary,
  AudioLink,
  AudioMergeJob,
  GpuWorkerStatus,
  SubtitleJob
} from './audio-types';

const folder = (extra: Partial<AudioFolderSummary> = {}): AudioFolderSummary => ({
  id: 1,
  libraryId: 'lib',
  relPath: 'japanese/_Unknown/スパイ教室/Vol 2 - スパイ教室02',
  name: 'Vol 2 - スパイ教室02',
  parentName: 'スパイ教室',
  fileCount: 1,
  totalBytes: 412 * 1024 * 1024,
  durationSeconds: 9 * 3600 + 12 * 60,
  volume: 2,
  playable: true,
  missing: false,
  ...extra
});

const link = (extra: Partial<AudioLink> = {}): AudioLink => ({
  bookId: 'b',
  state: 'linked',
  folderRelPath: folder().relPath,
  fileName: 'a.m4b',
  subtitleState: null,
  subtitleRelPath: null,
  source: 'library',
  confirmedAt: 1,
  folder: folder(),
  status: 'ok',
  subtitle: null,
  subtitleStatus: null,
  ...extra
});

describe('audio link view', () => {
  it('says what the section shows', () => {
    expect(linkView(null)).toBe('choose');
    expect(linkView(link({ state: 'none', folder: null, status: null }))).toBe('none');
    expect(linkView(link())).toBe('linked');
    // WP15f: a whole folder of several files is "split"; one file of it plays.
    const several = folder({ fileCount: 3, playable: false });
    expect(linkView(link({ folder: several, fileName: null }))).toBe('split');
    expect(linkView(link({ folder: several, fileName: 'b.m4b' }))).toBe('linked');
    expect(linkView(link({ folder: several, fileName: 'b.m4b', playable: false }))).toBe('split');
    expect(linkView(link({ status: 'missing', folder: null }))).toBe('missing');
    expect(linkView(link({ status: 'changed' }))).toBe('changed');
  });

  it('asks for subtitles only once an audiobook is linked', () => {
    expect(subtitleView(null)).toBe('hidden');
    expect(subtitleView(link({ state: 'none' }))).toBe('hidden');
    expect(subtitleView(link())).toBe('choose');
    expect(subtitleView(link({ subtitleState: 'none' }))).toBe('none');
    expect(
      subtitleView(
        link({ subtitleState: 'linked', subtitleRelPath: 'x.srt', subtitleStatus: 'ok' })
      )
    ).toBe('linked');
    expect(
      subtitleView(
        link({ subtitleState: 'linked', subtitleRelPath: 'x.srt', subtitleStatus: 'missing' })
      )
    ).toBe('missing');
  });

  it('describes folders and subtitle files in everyday words', () => {
    expect(formatAudioLength(9 * 3600 + 5 * 60)).toBe('9 h 05 min');
    expect(formatAudioLength(null)).toBe('Length unknown');
    expect(folderDetails(folder())).toBe('1 file · 9 h 12 min · 412.0 MB');
    expect(folderDetails(folder({ fileCount: 2, durationSeconds: null, totalBytes: 0 }))).toBe(
      '2 files · Length unknown'
    );
    expect(
      subtitleDetails({
        id: 3,
        libraryId: 'lib',
        relPath: 'japanese-srt/subs-new/x.srt',
        name: 'x.srt',
        parentName: 'subs-new',
        size: 12_000,
        missing: false
      })
    ).toBe('subs-new · 12 KB');
    expect(splitNotice(3)).toBe(
      'This audiobook is in 3 files. Choose one file, or merge them into one.'
    );
    expect(severalFilesNote(2)).toBe('In 2 files: you choose one file, or merge them.');
    expect(fileDetails({ size: 2 * 1024 * 1024, durationSeconds: 3600 })).toBe(
      '1 h 00 min · 2.0 MB'
    );
    expect(
      linkDetails(
        link({
          folder: folder({ fileCount: 2, playable: false }),
          fileName: 'b.m4b',
          file: { name: 'b.m4b', size: 1024 * 1024, durationSeconds: 7200 }
        })
      )
    ).toBe('2 h 00 min · 1.0 MB · one of 2 files');
    expect(linkDetails(link())).toBe('1 file · 9 h 12 min · 412.0 MB');
    expect(COPIES_HINT).toMatch(/look like copies/);
  });

  it('names a link even when the index no longer has its folder', () => {
    expect(linkedFolderName(link())).toBe('Vol 2 - スパイ教室02');
    expect(linkedFolderName(link({ folder: null }))).toBe('Vol 2 - スパイ教室02');
    expect(
      linkedSubtitleName(link({ subtitleState: 'linked', subtitleRelPath: 'a/b/[2巻] x.srt' }))
    ).toBe('[2巻] x.srt');
  });

  it('marks problems on the Audiobooks page', () => {
    expect(linkMarks(link({ state: 'none', folder: null, status: null }))).toEqual([]);
    expect(linkMarks(link({ subtitleState: 'none' }))).toEqual([]);
    expect(linkMarks(link())).toEqual(['Subtitles not chosen yet']);
    expect(
      linkMarks(
        link({
          status: 'missing',
          folder: null,
          subtitleState: 'linked',
          subtitleRelPath: 'x.srt',
          subtitleStatus: 'missing'
        })
      )
    ).toEqual(['Audiobook missing', 'Subtitle file missing']);
    expect(
      linkMarks(
        link({
          folder: folder({ fileCount: 2, playable: false }),
          fileName: null,
          subtitleState: 'none'
        })
      )
    ).toEqual(['2 files: choose one or merge']);
    expect(
      linkMarks(
        link({
          folder: folder({ fileCount: 2, playable: false }),
          fileName: 'a.m4b',
          subtitleState: 'none'
        })
      )
    ).toEqual([]);
    expect(linkMarks(link({ status: 'changed', subtitleState: 'none' }))).toEqual([
      'Audio file changed'
    ]);
  });

  it('says what the scanner is doing', () => {
    const lib = {
      id: 'l',
      name: 'Japanese',
      audioDir: 'japanese',
      subtitleDir: 'japanese-srt',
      status: 'idle' as const,
      scannedAt: 5,
      folders: 1,
      subtitles: 1,
      archivesSkipped: 0,
      durationsPending: 0,
      scanRequested: false,
      lastError: null,
      lastErrorAt: null
    };
    expect(scanStatusText(lib)).toBe('Up to date.');
    expect(scanStatusText({ ...lib, scannedAt: null })).toBe('Not scanned yet.');
    expect(scanStatusText({ ...lib, scanRequested: true })).toBe('Scan requested…');
    expect(scanStatusText({ ...lib, status: 'scanning' })).toBe('Scanning…');
    expect(scanStatusText({ ...lib, status: 'error' })).toBe('The last scan failed.');
    expect(scanBusy(null)).toBe(false);
    expect(scanBusy({ enabled: true, error: null, libraries: [lib] })).toBe(false);
    expect(
      scanBusy({ enabled: true, error: null, libraries: [{ ...lib, scanRequested: true }] })
    ).toBe(true);
  });

  it('leaves out search results already suggested', () => {
    expect(withoutIds([{ id: 1 }, { id: 2 }], [{ id: 2 }])).toEqual([{ id: 1 }]);
  });
});

describe('WP15f: files and merges', () => {
  it('orders and picks the files to merge', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    const same = ['a', 'b'];
    expect(moveItem(same, 0, -1)).toBe(same);
    expect(moveItem(same, 1, 1)).toBe(same);
    expect(mergeSelection(['c', 'a', 'b'], new Set(['a', 'c']))).toEqual(['c', 'a']);
    const files = [
      { index: 0, name: 'a', size: 100, durationSeconds: 1, url: '' },
      { index: 1, name: 'b', size: 50, durationSeconds: 1, url: '' },
      { index: 2, name: 'c', size: 7, durationSeconds: 1, url: '' }
    ];
    expect(mergeSizeEstimate(files, ['a', 'c'])).toBe(107);
  });

  it('says how a merge is going in everyday words', () => {
    const job = (extra: Partial<AudioMergeJob>): AudioMergeJob => ({
      id: 1,
      bookId: 'b',
      libraryId: 'l',
      folderRelPath: 'japanese/x/Vol 1',
      folderName: 'Vol 1',
      files: ['a.m4b', 'b.m4b'],
      state: 'queued',
      mode: null,
      progress: 0,
      outputName: null,
      error: null,
      linked: false,
      createdAt: 1,
      startedAt: null,
      finishedAt: null,
      ...extra
    });
    expect(mergeStatusText(job({}))).toBe('Waiting for another merge to finish…');
    expect(mergeStatusText(job({ state: 'running', progress: 0.427 }))).toBe(
      'Merging: joining the files… 42 %'
    );
    expect(mergeStatusText(job({ state: 'saving', progress: 0.95 }))).toBe(
      'Saving into the audiobooks folder… 95 %'
    );
    expect(mergeStatusText(job({ state: 'done', linked: true, outputName: 'Vol 1.m4b' }))).toBe(
      'Merged into “Vol 1.m4b”. This book now uses it. Now choose the subtitles.'
    );
    expect(mergeStatusText(job({ state: 'done', outputName: 'Vol 1.m4b' }))).toMatch(
      /was not linked/
    );
    expect(mergeStatusText(job({ state: 'failed', error: 'ffmpeg failed: x' }))).toBe(
      'The merge failed: ffmpeg failed: x. Nothing was added to the audiobooks folder.'
    );
    expect(mergeStatusText(job({ state: 'cancelled' }))).toBe(
      'The merge was stopped. Nothing was added to the audiobooks folder.'
    );
    expect(mergeActive(job({ state: 'running' }))).toBe(true);
    expect(mergeActive(job({ state: 'done' }))).toBe(false);
    expect(mergeActive(null)).toBe(false);
  });
});

describe('subtitle jobs (WP16)', () => {
  const NOW = 1_800_000_000_000;
  const job = (extra: Partial<SubtitleJob> = {}): SubtitleJob => ({
    id: 1,
    bookId: 'b',
    bookTitle: '羊と鋼の森',
    kind: 'sync_subtitles',
    audioFileName: '羊と鋼の森.m4b',
    state: 'queued',
    stage: null,
    progress: null,
    message: null,
    cancelRequested: false,
    attempts: 0,
    outputName: null,
    outputRelPath: null,
    linked: false,
    error: null,
    logTail: null,
    createdAt: NOW - 1000,
    startedAt: null,
    finishedAt: null,
    updatedAt: NOW,
    ...extra
  });
  const worker = (extra: Partial<GpuWorkerStatus> = {}): GpuWorkerStatus => ({
    available: true,
    online: true,
    lastSeenAt: NOW - 5000,
    paused: false,
    problem: null,
    jobs: [],
    ...extra
  });

  it('says why a job waits', () => {
    expect(subtitleJobText(job(), worker(), NOW)).toBe('Waiting for the PC to start…');
    expect(subtitleJobText(job(), worker({ paused: true }), NOW)).toBe(
      'Waiting: making subtitles on the PC is paused (Settings > Audiobooks).'
    );
    expect(
      subtitleJobText(job(), worker({ online: false, lastSeenAt: NOW - 3 * 3600_000 }), NOW)
    ).toBe('Waiting for the PC to be switched on (last seen 3 h ago).');
    expect(subtitleJobText(job(), worker({ online: false, lastSeenAt: null }), NOW)).toBe(
      'Waiting for the PC. The subtitle program on the PC has not checked in yet.'
    );
    expect(
      subtitleJobText(job(), worker({ problem: 'Docker Desktop is not running on the PC' }), NOW)
    ).toBe('Waiting: Docker Desktop is not running on the PC.');
    expect(subtitleJobText(job(), worker({ jobs: [job({ id: 2, state: 'running' })] }), NOW)).toBe(
      "Waiting for another book's subtitles to finish…"
    );
    expect(
      subtitleJobText(
        job({ message: 'The PC stopped responding during the job; it will be tried again.' }),
        worker(),
        NOW
      )
    ).toBe(
      'The PC stopped responding during the job; it will be tried again. Waiting for the PC to start…'
    );
  });

  it('describes a running job, its end, and the time since', () => {
    const run = (extra: Partial<SubtitleJob>) => job({ state: 'running', ...extra });
    expect(subtitleJobText(run({ stage: 'downloading', progress: 0.256 }), worker(), NOW)).toBe(
      'The PC is downloading the book and the audiobook… 25 %'
    );
    expect(
      subtitleJobText(
        run({ stage: 'syncing', progress: 0.4, startedAt: NOW - 12 * 60_000 }),
        worker(),
        NOW
      )
    ).toBe("SubPlz is matching the audiobook to the book's text… 40 % Started 12 min ago.");
    expect(subtitleJobText(run({ stage: 'syncing' }), worker(), NOW)).toBe(
      "SubPlz is matching the audiobook to the book's text…"
    );
    expect(subtitleJobText(run({ stage: 'uploading' }), worker(), NOW)).toBe(
      'The PC is sending the subtitles to the server…'
    );
    expect(subtitleJobText(run({ stage: 'saving' }), worker(), NOW)).toBe(
      'Saving into the subtitle folder…'
    );
    expect(subtitleJobText(run({ cancelRequested: true }), worker(), NOW)).toBe('Stopping…');
    expect(
      subtitleJobText(job({ state: 'done', linked: true, outputName: 'a.srt' }), worker(), NOW)
    ).toBe('Subtitles made: “a.srt”. This book now uses them.');
    expect(subtitleJobText(job({ state: 'done', outputName: 'a.srt' }), worker(), NOW)).toMatch(
      /were not chosen/
    );
    expect(subtitleJobText(job({ state: 'failed', error: 'SubPlz failed.' }), worker(), NOW)).toBe(
      'Making subtitles failed: SubPlz failed. Nothing was added to the subtitle folder.'
    );
    expect(subtitleJobText(job({ state: 'cancelled' }), worker(), NOW)).toBe(
      'Making subtitles was stopped. Nothing was added to the subtitle folder.'
    );
    expect(subtitleJobActive(run({}))).toBe(true);
    expect(subtitleJobActive(job({ state: 'done' }))).toBe(false);
    expect(subtitleJobActive(null)).toBe(false);
    expect(timeAgo(NOW - 30_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
  });
});
