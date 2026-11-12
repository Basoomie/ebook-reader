/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The book details page's Download menu: which files a book offers, and their names
 * and addresses.
 */

import type { AudioLink } from '$lib/audio/audio-types';
import { fileTitle } from '$lib/functions/download-blob';

export interface DownloadChoices {
  /** The EPUB: listed always, downloadable unless the book left the library. */
  book: boolean;
  /** The signed URL of the one linked audio file, or null (no item). */
  audio: string | null;
  /** A subtitle file is linked and still there. */
  subtitles: boolean;
}

/**
 * Audiobook only for a link to one file that is there (the same rule as whispersync's
 * playback; a folder of several files with none chosen or merged shows no item, decided
 * with the user). Subtitles only when linked and still in the subtitle folder.
 */
export function downloadChoices(
  book: { missing?: boolean },
  link: AudioLink | null
): DownloadChoices {
  const linked = link?.state === 'linked';
  return {
    book: !book.missing,
    audio: linked && link.playUrl ? link.playUrl : null,
    subtitles: linked && link.subtitleState === 'linked' && link.subtitleStatus === 'ok'
  };
}

/** `<title>.epub`, made safe for a file name. */
export function epubFileName(title: string | undefined): string {
  return `${fileTitle(title, 100) || 'book'}.epub`;
}

/**
 * The linked subtitle file's own name. Taken from the link: the server's
 * Content-Disposition isn't readable across origins (CORS doesn't expose it).
 */
export function subtitleFileName(link: AudioLink | null): string {
  const name = link?.subtitle?.name || link?.subtitleRelPath?.split('/').pop();
  return name || 'subtitles.srt';
}

/** The signed audio URL as a download (the server then sends it as an attachment). */
export function audioDownloadUrl(absolute: (relative: string) => string, playUrl: string): string {
  return `${absolute(playUrl)}${playUrl.includes('?') ? '&' : '?'}download=1`;
}
