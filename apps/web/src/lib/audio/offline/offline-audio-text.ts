/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { AudioLink } from '$lib/audio/audio-types';
import { formatBytes } from '$lib/diagnostics/diagnostics-text';
import { copyIsOf, linkedFile } from './audio-identity';
import type { AudioCopy, AudioCopyError } from './audio-offline-db';

/**
 * What the book page's "On this device" part of the Audiobook section shows (Season 2
 * Phase 9), as plain data so it is tested without a page. Everyday words only.
 */

/** Keeps "42 %" on one line. */
const NBSP = String.fromCharCode(0xa0);

export interface DeviceAudioInput {
  copy: AudioCopy | null;
  running: boolean;
  /** A problem from a start that stored nothing. */
  problem: AudioCopyError | null;
  link: AudioLink | null;
  /** The link was read from the server (false: it can't be reached). */
  linkKnown: boolean;
  /** The book's own copy is on this device. */
  bookOnDevice: boolean;
  /** An https address (downloads are offered only there). */
  secure: boolean;
}

export type DeviceAudioState =
  /** Nothing to show. */
  | 'hidden'
  /** Plain http: downloads need the https address. */
  | 'https-only'
  /** The book itself isn't on this device yet. */
  | 'book-first'
  /** Linked and playable, nothing downloaded: "Download audio". */
  | 'ready'
  | 'downloading'
  /** Part of the linked file is stored: "Continue download". */
  | 'stopped'
  /** The whole linked file is stored. */
  | 'complete'
  /** What is stored is of another file than the link's (or the link is gone). */
  | 'earlier';

export interface DeviceAudioView {
  state: DeviceAudioState;
  /** The line(s) shown. */
  text: string;
  /** A second line: why a download stopped, or a note. */
  note: string;
  /** 0-100 for the bar (downloading and stopped). */
  percent: number;
  canDownload: boolean;
  canStop: boolean;
  canContinue: boolean;
  /** "Start again" (the file changed since the download began). */
  canRestart: boolean;
  /** "Download the current audio" (replaces a copy of an earlier link). */
  canReplace: boolean;
  canRemove: boolean;
}

export const HTTPS_ONLY_TEXT = 'Downloading audio for offline use needs the https address.';
export const BOOK_FIRST_TEXT =
  'Open the book once to keep it on this device, then download its audio.';

export function problemText(error: AudioCopyError | null, bytesNeeded: number | null): string {
  switch (error) {
    case 'network':
      return "The connection was lost. The download continues by itself when it's back while the app is open.";
    case 'changed':
      return 'The audiobook file changed on the server since this download started.';
    case 'missing':
      return "The audiobook file can't be found on the server.";
    case 'space':
      return bytesNeeded && bytesNeeded > 0
        ? `There isn't enough room on this device: ${formatBytes(bytesNeeded)} more are needed.`
        : "There isn't enough room on this device.";
    case 'server':
      return "The library server didn't send the audio, so the download stopped.";
    default:
      return '';
  }
}

function percentOf(copy: AudioCopy): number {
  return copy.size > 0 ? Math.min(100, Math.floor((copy.bytesDone / copy.size) * 100)) : 0;
}

/** "42 % (500 MB of 1.2 GB)". */
export function progressText(copy: AudioCopy): string {
  return `${percentOf(copy)}${NBSP}% (${formatBytes(copy.bytesDone)} of ${formatBytes(copy.size)})`;
}

/** "Audio downloaded · 1.2 GB · with subtitles" (under the panel's "On this device"). */
export function completeText(copy: AudioCopy): string {
  return ['Audio downloaded', formatBytes(copy.size), copy.subtitle ? 'with subtitles' : '']
    .filter(Boolean)
    .join(' · ');
}

export function downloadLabel(size: number): string {
  return `Download audio (${formatBytes(size)})`;
}

const NONE: Omit<DeviceAudioView, 'state' | 'text'> = {
  note: '',
  percent: 0,
  canDownload: false,
  canStop: false,
  canContinue: false,
  canRestart: false,
  canReplace: false,
  canRemove: false
};

export function deviceAudioView(input: DeviceAudioInput): DeviceAudioView {
  const { copy, running, link, linkKnown, bookOnDevice, secure } = input;
  const file = linkKnown ? linkedFile(link) : null;
  const mayDownload = !!file && secure && bookOnDevice;

  if (running && copy) {
    return {
      ...NONE,
      state: 'downloading',
      text: `Downloading audio… ${progressText(copy)}`,
      percent: percentOf(copy),
      canStop: true
    };
  }
  if (running) {
    return { ...NONE, state: 'downloading', text: 'Downloading audio…', canStop: true };
  }

  if (!copy) {
    if (!file) {
      return input.problem && linkKnown
        ? { ...NONE, state: 'hidden', text: '', note: problemText(input.problem, null) }
        : { ...NONE, state: 'hidden', text: '' };
    }
    if (!secure) return { ...NONE, state: 'https-only', text: HTTPS_ONLY_TEXT };
    if (!bookOnDevice) return { ...NONE, state: 'book-first', text: BOOK_FIRST_TEXT };
    return {
      ...NONE,
      state: 'ready',
      text: downloadLabel(file.size),
      note: problemText(input.problem, null),
      canDownload: true
    };
  }

  // Offline, the device can't know about a change: what it has is what plays.
  if (linkKnown && !copyIsOf(copy, file)) {
    const playable = !!link?.playUrl;
    return {
      ...NONE,
      state: 'earlier',
      text: `The audio on this device is from an earlier link (${copy.fileName}, ${formatBytes(copy.size)}).`,
      note: playable
        ? 'whispersync streams the current audiobook.'
        : "It isn't played while that link is gone.",
      canReplace: mayDownload,
      canRemove: true
    };
  }

  if (copy.complete) {
    return { ...NONE, state: 'complete', text: completeText(copy), canRemove: true };
  }

  const changed = copy.error === 'changed';
  return {
    ...NONE,
    state: 'stopped',
    text: `Download stopped at ${progressText(copy)}.`,
    note: linkKnown
      ? problemText(copy.error, copy.bytesNeeded)
      : 'It can continue once the library server can be reached.',
    percent: percentOf(copy),
    canContinue: linkKnown && secure && bookOnDevice && !changed,
    canRestart: linkKnown && secure && bookOnDevice && changed,
    canRemove: true
  };
}
