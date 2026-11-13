/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { AudioLink } from '$lib/audio/audio-types';
import { audioDownloadUrl, downloadChoices, epubFileName, subtitleFileName } from './book-download';

const PLAY = '/api/v1/audio/files/7/0?v=10-20&u=u1&s=sig';

function link(change: Partial<AudioLink> = {}): AudioLink {
  return {
    bookId: 'b1',
    state: 'linked',
    folderRelPath: 'japanese/本',
    fileName: '本.m4b',
    subtitleState: 'linked',
    subtitleRelPath: 'japanese-srt/本.srt',
    source: 'library',
    confirmedAt: 1,
    folder: null,
    status: 'ok',
    subtitle: null,
    subtitleStatus: 'ok',
    playable: true,
    file: { name: '本.m4b', size: 100, durationSeconds: 60 },
    playUrl: PLAY,
    ...change
  };
}

describe('downloadChoices', () => {
  it('offers only the book when nothing is linked', () => {
    expect(downloadChoices({}, null)).toEqual({ book: true, audio: null, subtitles: false });
    const none = link({ state: 'none', playUrl: null, subtitleState: null, subtitleStatus: null });
    expect(downloadChoices({}, none)).toEqual({ book: true, audio: null, subtitles: false });
  });

  it('offers the audiobook and subtitles of a link to one file', () => {
    expect(downloadChoices({ missing: false }, link())).toEqual({
      book: true,
      audio: PLAY,
      subtitles: true
    });
  });

  it('hides the audiobook for a folder of several files, a missing or a changed file', () => {
    const folder = link({ fileName: null, playable: false, file: null, playUrl: null });
    expect(downloadChoices({}, folder).audio).toBeNull();
    expect(downloadChoices({}, link({ status: 'missing', playUrl: null })).audio).toBeNull();
    expect(downloadChoices({}, link({ status: 'changed', playUrl: null })).audio).toBeNull();
    // An older server without playUrl.
    expect(downloadChoices({}, link({ playUrl: undefined })).audio).toBeNull();
  });

  it('offers subtitles only when linked and still there', () => {
    expect(downloadChoices({}, link({ subtitleStatus: 'missing' })).subtitles).toBe(false);
    const notAnswered = link({ subtitleState: null, subtitleRelPath: null, subtitleStatus: null });
    expect(downloadChoices({}, notAnswered).subtitles).toBe(false);
    const declined = link({ subtitleState: 'none', subtitleRelPath: null, subtitleStatus: null });
    expect(downloadChoices({}, declined).subtitles).toBe(false);
  });

  it('keeps subtitles when the audio file is gone', () => {
    const gone = link({ status: 'missing', playable: false, playUrl: null });
    expect(downloadChoices({}, gone)).toEqual({ book: true, audio: null, subtitles: true });
  });

  it('marks the book unavailable once it left the library', () => {
    expect(downloadChoices({ missing: true }, null).book).toBe(false);
  });
});

describe('file names and addresses', () => {
  it('names the EPUB after its title', () => {
    expect(epubFileName('月と灯台 3')).toBe('月と灯台-3.epub');
    expect(epubFileName('a/b:c?')).toBe('a-b-c.epub');
    expect(epubFileName('')).toBe('book.epub');
    expect(epubFileName('長'.repeat(150))).toBe(`${'長'.repeat(100)}.epub`);
  });

  it('names the subtitles after the linked file', () => {
    const sub = {
      id: 3,
      libraryId: 'lib',
      relPath: 'japanese-srt/本/本 1.srt',
      name: '本 1.srt',
      parentName: '本',
      size: 10,
      missing: false
    };
    expect(subtitleFileName(link({ subtitle: sub }))).toBe('本 1.srt');
    expect(subtitleFileName(link({ subtitle: null }))).toBe('本.srt');
    expect(subtitleFileName(null)).toBe('subtitles.srt');
  });

  it('asks the server for an attachment', () => {
    const absolute = (p: string) => `http://nas:3000${p}`;
    expect(audioDownloadUrl(absolute, PLAY)).toBe(`http://nas:3000${PLAY}&download=1`);
    expect(audioDownloadUrl(absolute, '/x')).toBe('http://nas:3000/x?download=1');
  });
});
