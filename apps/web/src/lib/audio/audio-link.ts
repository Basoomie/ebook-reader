/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { formatFileSize } from '$lib/library/book-details';
import { formatDuration } from '$lib/stats/stats-format';
import type {
  AudioFolderSummary,
  AudioLibraryStatus,
  AudioLink,
  AudioStatus,
  SubtitleFileSummary
} from './audio-types';

/**
 * WP15b: what the book details page's Audiobook section shows, as plain data (tested
 * without a page). Everyday words only.
 */

/**
 * - choose: no link yet; suggestions and search, nothing chosen until a tap;
 * - none: "No audiobook";
 * - linked: linked and playable;
 * - split: linked, but in several files (can't play yet);
 * - missing: the folder is no longer in the audiobooks folder;
 * - changed: the linked file is no longer in its folder.
 */
export type LinkView = 'choose' | 'none' | 'linked' | 'split' | 'missing' | 'changed';

export function linkView(link: AudioLink | null): LinkView {
  if (!link) return 'choose';
  if (link.state === 'none') return 'none';
  if (link.status === 'missing') return 'missing';
  if (link.status === 'changed') return 'changed';
  if (link.folder && !link.folder.playable) return 'split';
  return 'linked';
}

/** The subtitle step: only once an audiobook is linked. */
export type SubtitleView = 'hidden' | 'choose' | 'linked' | 'none' | 'missing';

export function subtitleView(link: AudioLink | null): SubtitleView {
  if (!link || link.state !== 'linked') return 'hidden';
  if (link.subtitleState === null) return 'choose';
  if (link.subtitleState === 'none') return 'none';
  return link.subtitleStatus === 'missing' ? 'missing' : 'linked';
}

/** "9 h 05 min" (as on the Stats page); "Length unknown" while the server reads the files. */
export function formatAudioLength(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Length unknown';
  return formatDuration(seconds);
}

export function fileCountLabel(n: number): string {
  return n === 1 ? '1 file' : `${n.toLocaleString('en-US')} files`;
}

/** "1 file · 9 h 12 min · 412.0 MB". */
export function folderDetails(folder: AudioFolderSummary): string {
  return [
    fileCountLabel(folder.fileCount),
    formatAudioLength(folder.durationSeconds),
    formatFileSize(folder.totalBytes)
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "subs-new · 12 KB". */
export function subtitleDetails(file: SubtitleFileSummary): string {
  return [file.parentName ?? '', formatFileSize(file.size)].filter(Boolean).join(' · ');
}

/** The user's wording (decided 2026-11-11): WP15 plays single-file audiobooks only. */
export function splitNotice(fileCount: number): string {
  return `This audiobook is in ${fileCount.toLocaleString('en-US')} files and can't play yet.`;
}

export const MISSING_NOTICE = 'This audiobook is no longer in the audiobooks folder.';
export const CHANGED_NOTICE =
  'The audio file of this audiobook is no longer in its folder. Choose the audiobook again.';
export const SUBTITLE_MISSING_NOTICE = 'This subtitle file is no longer in the subtitle folder.';

/** The folder's name, or the last part of its stored path when the index has no row. */
export function linkedFolderName(link: AudioLink): string {
  if (link.folder) return link.folder.name;
  const path = link.folderRelPath ?? '';
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

export function linkedSubtitleName(link: AudioLink): string {
  if (link.subtitle) return link.subtitle.name;
  const path = link.subtitleRelPath ?? '';
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** Leaves out entries already shown above (search results under the suggestions). */
export function withoutIds<T extends { id: number }>(list: T[], shown: { id: number }[]): T[] {
  const ids = new Set(shown.map((s) => s.id));
  return list.filter((x) => !ids.has(x.id));
}

// ---- The Audiobooks page

/** One line on a library's scan: what the server is doing or did last. */
export function scanStatusText(lib: AudioLibraryStatus): string {
  if (lib.status === 'scanning') return 'Scanning…';
  if (lib.scanRequested) return 'Scan requested…';
  if (lib.status === 'error') return 'The last scan failed.';
  if (lib.scannedAt === null) return 'Not scanned yet.';
  return 'Up to date.';
}

/** True while a scan is asked for or running (the page checks again every few seconds). */
export function scanBusy(status: AudioStatus | null): boolean {
  return !!status?.libraries.some((l) => l.status === 'scanning' || l.scanRequested);
}

/** Short marks on a linked book's row, problems first. */
export function linkMarks(link: AudioLink): string[] {
  if (link.state !== 'linked') return [];
  const marks: string[] = [];
  const view = linkView(link);
  if (view === 'missing') marks.push('Audiobook missing');
  else if (view === 'changed') marks.push('Audio file changed');
  else if (view === 'split' && link.folder) {
    marks.push(`${fileCountLabel(link.folder.fileCount)}: can't play yet`);
  }
  const sub = subtitleView(link);
  if (sub === 'choose') marks.push('Subtitles not chosen yet');
  else if (sub === 'missing') marks.push('Subtitle file missing');
  return marks;
}
