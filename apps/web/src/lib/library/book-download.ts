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
import { formatFileSize } from './book-details';

export interface DownloadChoices {
  /** The EPUB: listed always, downloadable unless the book left the library. */
  book: boolean;
  /** The signed URL of the one linked audio file, or null (no item). */
  audio: string | null;
  /** A subtitle file is linked and still there. */
  subtitles: boolean;
  /** The book has a cover and is still in the library (the full-size image). */
  cover: boolean;
}

/**
 * Audiobook only for a link to one file that is there (the same rule as whispersync's
 * playback; a folder of several files with none chosen or merged shows no item, decided
 * with the user). Subtitles only when linked and still in the subtitle folder. Cover
 * only when the book has one (the catalog gives a thumbnail exactly then).
 */
export function downloadChoices(
  book: { missing?: boolean; thumbnail?: string | null },
  link: AudioLink | null
): DownloadChoices {
  const linked = link?.state === 'linked';
  return {
    book: !book.missing,
    audio: linked && link.playUrl ? link.playUrl : null,
    subtitles: linked && link.subtitleState === 'linked' && link.subtitleStatus === 'ok',
    cover: !book.missing && !!book.thumbnail
  };
}

export interface DownloadSizes {
  book: number | null;
  audio: number | null;
  subtitles: number | null;
}

/**
 * The sizes the page already knows, in bytes (null = unknown): the EPUB from the same
 * source as the "File size" row, the linked audio file, the linked subtitle file. The
 * cover's size isn't in the book's data: the menu asks the server for it.
 */
export function downloadSizes(
  book: { sources?: { fileSize: number | null; missingAt: number | null }[] },
  link: AudioLink | null
): DownloadSizes {
  const sources = book.sources ?? [];
  const source = sources.find((s) => !s.missingAt) ?? sources[0];
  return {
    book: source?.fileSize ?? null,
    audio: link?.file?.size ?? null,
    subtitles: link?.subtitle?.size ?? null
  };
}

const GB = 1024 * 1024 * 1024;

/** "2.1 MB", "820 KB", "1.4 GB" (audiobooks), or '' when unknown. */
export function formatDownloadSize(bytes: number | null | undefined): string {
  if (typeof bytes === 'number' && bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return formatFileSize(bytes);
}

/** `<title>.epub`, made safe for a file name. */
export function epubFileName(title: string | undefined): string {
  return `${fileTitle(title, 100) || 'book'}.epub`;
}

const COVER_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/** `<title>-cover.<ext>`, the extension from the image's type (the server sends the real one). */
export function coverFileName(title: string | undefined, type: string): string {
  const ext = COVER_EXTENSIONS[type.split(';')[0].trim().toLowerCase()] ?? 'jpg';
  return `${fileTitle(title, 100) || 'book'}-cover.${ext}`;
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
