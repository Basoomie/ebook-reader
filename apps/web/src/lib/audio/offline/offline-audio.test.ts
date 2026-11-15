/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { AudioLink } from '$lib/audio/audio-types';
import { removeAudioCopy, removeFromDeviceCopy, replaceAudioCopy } from '$lib/confirm/confirm-copy';
import { deviceAudioBookIds } from '$lib/library/device-books';
import { parseQuery, usesBookState } from '$lib/library/query/parse';
import { copyFitsLink, copyIsOf, linkedFile } from './audio-identity';
import type { AudioCopy } from './audio-offline-db';
import {
  BOOK_FIRST_TEXT,
  HTTPS_ONLY_TEXT,
  deviceAudioView,
  type DeviceAudioInput
} from './offline-audio-text';
import { chooseSource, chooseSubtitle, shouldKeepSubtitle } from './play-choice';

const MB = 1024 * 1024;

function link(over: Partial<AudioLink> = {}): AudioLink {
  return {
    bookId: 'b',
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
    file: { name: '本.m4b', size: 1200 * MB, durationSeconds: 3600, version: 'v1' },
    playUrl: '/api/v1/audio/files/1/0?v=v1&u=u&s=s',
    ...over
  };
}

function copy(over: Partial<AudioCopy> = {}): AudioCopy {
  return {
    bookId: 'b',
    folderRelPath: 'japanese/本',
    fileName: '本.m4b',
    version: 'v1',
    size: 1200 * MB,
    contentType: 'audio/mp4',
    pieceSize: 8 * MB,
    piecesDone: 150,
    bytesDone: 1200 * MB,
    complete: true,
    stoppedBy: null,
    error: null,
    bytesNeeded: null,
    subtitle: { relPath: 'japanese-srt/本.srt', name: '本.srt', blob: new Blob(['x']) },
    startedAt: 1,
    completedAt: 2,
    ...over
  };
}

describe('which file a copy is', () => {
  it('needs a playable link with a version', () => {
    expect(linkedFile(link())).toEqual({
      folderRelPath: 'japanese/本',
      fileName: '本.m4b',
      version: 'v1',
      size: 1200 * MB
    });
    expect(linkedFile(null)).toBeNull();
    expect(linkedFile(link({ state: 'none' }))).toBeNull();
    expect(linkedFile(link({ playable: false }))).toBeNull();
    expect(linkedFile(link({ playUrl: null }))).toBeNull();
    // An older server: no version, nothing to download.
    expect(
      linkedFile(link({ file: { name: '本.m4b', size: 1, durationSeconds: null } }))
    ).toBeNull();
  });

  it('fits only the same folder, file, version and size, when complete', () => {
    expect(copyFitsLink(copy(), link())).toBe(true);
    expect(copyFitsLink(copy({ complete: false }), link())).toBe(false);
    expect(copyFitsLink(copy({ version: 'v0' }), link())).toBe(false);
    expect(copyFitsLink(copy({ folderRelPath: 'japanese/別' }), link())).toBe(false);
    expect(copyFitsLink(copy({ fileName: '別.m4b' }), link())).toBe(false);
    expect(copyFitsLink(copy({ size: 1 }), link())).toBe(false);
    expect(copyFitsLink(copy(), link({ state: 'none', playUrl: null }))).toBe(false);
    expect(copyFitsLink(null, link())).toBe(false);
    expect(copyIsOf(copy({ complete: false }), linkedFile(link()))).toBe(true);
  });
});

describe('what whispersync plays', () => {
  const online = (l: AudioLink | null) => ({ ok: true as const, link: l });
  const offline = { ok: false as const };

  it('plays the copy only when it is the linked file, else streams as before', () => {
    expect(chooseSource(online(link()), copy())).toBe('copy');
    expect(chooseSource(online(link()), copy({ version: 'v0' }))).toBe('stream');
    expect(chooseSource(online(link()), copy({ complete: false }))).toBe('stream');
    expect(chooseSource(online(link()), null)).toBe('stream');
    expect(chooseSource(online(null), copy())).toBe('none');
    expect(chooseSource(online(link({ state: 'none', playUrl: null })), copy())).toBe('none');
  });

  it('plays a finished copy when the link can not be read', () => {
    expect(chooseSource(offline, copy())).toBe('copy');
    expect(chooseSource(offline, copy({ version: 'old' }))).toBe('copy');
    expect(chooseSource(offline, copy({ complete: false }))).toBe('none');
    expect(chooseSource(offline, null)).toBe('none');
  });

  it('gets subtitles from the server online, from the copy offline', () => {
    expect(chooseSubtitle(online(link()), copy())).toBe('server');
    expect(chooseSubtitle(online(link({ subtitleState: 'none' })), copy())).toBe('none');
    expect(chooseSubtitle(online(link({ subtitleStatus: 'missing' })), copy())).toBe('none');
    expect(chooseSubtitle(offline, copy())).toBe('copy');
    expect(chooseSubtitle(offline, copy({ subtitle: null }))).toBe('none');
    expect(chooseSubtitle(offline, copy({ complete: false }))).toBe('none');
  });

  it('keeps the linked subtitles with a fitting copy that has other or none', () => {
    expect(shouldKeepSubtitle(link(), copy())).toBe(false);
    expect(shouldKeepSubtitle(link(), copy({ subtitle: null }))).toBe(true);
    expect(shouldKeepSubtitle(link({ subtitleRelPath: 'japanese-srt/新.srt' }), copy())).toBe(true);
    expect(shouldKeepSubtitle(link(), copy({ subtitle: null, version: 'v0' }))).toBe(false);
    expect(shouldKeepSubtitle(link({ subtitleRelPath: null }), copy({ subtitle: null }))).toBe(
      false
    );
  });
});

describe('the book page\'s "On this device" panel', () => {
  const base: DeviceAudioInput = {
    copy: null,
    running: false,
    problem: null,
    link: link(),
    linkKnown: true,
    bookOnDevice: true,
    secure: true
  };
  const view = (over: Partial<DeviceAudioInput>) => deviceAudioView({ ...base, ...over });

  it('offers the download only at https, with the book on the device', () => {
    expect(view({})).toMatchObject({
      state: 'ready',
      text: 'Download audio (1.2 GB)',
      canDownload: true,
      canRemove: false
    });
    expect(view({ secure: false })).toMatchObject({
      state: 'https-only',
      text: HTTPS_ONLY_TEXT,
      canDownload: false
    });
    expect(view({ bookOnDevice: false })).toMatchObject({
      state: 'book-first',
      text: BOOK_FIRST_TEXT,
      canDownload: false
    });
    expect(view({ link: link({ playable: false, playUrl: null }) }).state).toBe('hidden');
    expect(view({ link: null }).state).toBe('hidden');
    expect(view({ linkKnown: false, link: null }).state).toBe('hidden');
  });

  it('shows progress while downloading and where it stopped', () => {
    const half = copy({ complete: false, bytesDone: 600 * MB, piecesDone: 75 });
    const nbsp = String.fromCharCode(0xa0);
    expect(view({ copy: half, running: true })).toMatchObject({
      state: 'downloading',
      text: `Downloading audio… 50${nbsp}% (600 MB of 1.2 GB)`,
      percent: 50,
      canStop: true,
      canRemove: false
    });
    expect(view({ copy: { ...half, stoppedBy: 'user' } })).toMatchObject({
      state: 'stopped',
      text: `Download stopped at 50${nbsp}% (600 MB of 1.2 GB).`,
      note: '',
      canContinue: true,
      canRemove: true
    });
    expect(view({ copy: { ...half, stoppedBy: 'error', error: 'network' } }).note).toContain(
      'continues by itself'
    );
    expect(
      view({ copy: { ...half, stoppedBy: 'error', error: 'space', bytesNeeded: 600 * MB } }).note
    ).toBe("There isn't enough room on this device: 600 MB more are needed.");
    // The file changed: Start again instead of Continue.
    expect(view({ copy: { ...half, stoppedBy: 'error', error: 'changed' } })).toMatchObject({
      canContinue: false,
      canRestart: true,
      note: 'The audiobook file changed on the server since this download started.'
    });
    // Offline: Remove works, Continue waits.
    expect(view({ copy: half, linkKnown: false, link: null })).toMatchObject({
      state: 'stopped',
      canContinue: false,
      canRemove: true,
      note: 'It can continue once the library server can be reached.'
    });
  });

  it('shows a finished copy, also offline, and one of an earlier link', () => {
    expect(view({ copy: copy() })).toMatchObject({
      state: 'complete',
      text: 'Audio downloaded · 1.2 GB · with subtitles',
      canRemove: true,
      canDownload: false
    });
    expect(view({ copy: copy(), linkKnown: false, link: null }).state).toBe('complete');
    expect(view({ copy: copy({ subtitle: null }) }).text).toBe('Audio downloaded · 1.2 GB');

    const relinked = view({ copy: copy({ version: 'v0', size: 1100 * MB }) });
    expect(relinked).toMatchObject({
      state: 'earlier',
      text: 'The audio on this device is from an earlier link (本.m4b, 1.1 GB).',
      note: 'whispersync streams the current audiobook.',
      canReplace: true,
      canRemove: true
    });
    expect(view({ copy: copy(), link: link({ state: 'none', playUrl: null }) })).toMatchObject({
      state: 'earlier',
      note: "It isn't played while that link is gone.",
      canReplace: false
    });
    expect(view({ copy: copy({ version: 'v0' }), secure: false }).canReplace).toBe(false);
  });
});

describe('on:audio', () => {
  it("parses next to on:device and counts as this device's state", () => {
    const parsed = parseQuery('on:audio -on:device');
    expect(parsed.ok && parsed.query.terms.map((t) => [t.type, t.negated])).toEqual([
      ['deviceAudio', false],
      ['device', true]
    ]);
    expect(parsed.ok && usesBookState(parsed.query)).toBe(true);
    const bad = parseQuery('on:audiobook');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.message).toContain('on:audio');
  });

  it('lists only downloaded audio of books stored here', () => {
    expect(deviceAudioBookIds(['a', 'b', 'c'], ['c', 'x', 'a', 'a'])).toEqual(['a', 'c']);
    expect(deviceAudioBookIds([], ['a'])).toEqual([]);
  });
});

describe('confirmation words for downloaded audio', () => {
  it('says the link stays and the audio streams again', () => {
    const remove = removeAudioCopy('1.2 GB');
    expect(remove.title).toBe('Remove the audio from this device?');
    expect(remove.confirmLabel).toBe('Remove audio');
    expect(remove.message[0]).toContain('(1.2 GB) is removed');
    expect(remove.message[0]).toContain('streams it from the library server again');
    expect(remove.irreversible).toBeFalsy();

    const replace = replaceAudioCopy('本.m4b', '1.1 GB');
    expect(replace.title).toBe('Replace the audio on this device?');
    expect(replace.message[0]).toContain('“本.m4b”, 1.1 GB');
  });

  it('names the downloaded audio when the whole book is removed', () => {
    expect(removeFromDeviceCopy('本').message).toHaveLength(2);
    const withAudio = removeFromDeviceCopy('本', '1.2 GB');
    expect(withAudio.message).toHaveLength(3);
    expect(withAudio.message[1]).toContain('(1.2 GB) is removed too');
    expect(withAudio.message[1]).toContain('stays linked');
  });
});
