/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  folderDetails,
  formatAudioLength,
  linkMarks,
  linkView,
  linkedFolderName,
  scanBusy,
  scanStatusText,
  linkedSubtitleName,
  splitNotice,
  subtitleDetails,
  subtitleView,
  withoutIds
} from './audio-link';
import type { AudioFolderSummary, AudioLink } from './audio-types';

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
    expect(linkView(link({ folder: folder({ fileCount: 3, playable: false }) }))).toBe('split');
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
    expect(splitNotice(3)).toBe("This audiobook is in 3 files and can't play yet.");
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
      linkMarks(link({ folder: folder({ fileCount: 2, playable: false }), subtitleState: 'none' }))
    ).toEqual(["2 files: can't play yet"]);
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
