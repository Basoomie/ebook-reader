/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Select mode's Download menu (the Library): what the selected books offer per kind and
 * the sizes, as the server plans them (storage server `catalog/bulk-download.ts`, the
 * same rules as the book page's Download menu), and when to ask first.
 */

import { formatTimeLeft } from '$lib/stats/time-left';
import { formatDownloadSize } from './book-download';

export const DOWNLOAD_KINDS = ['book', 'cover', 'audio', 'subtitles'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

export interface KindTotal {
  /** Books that offer this kind. */
  count: number;
  /** The known sizes added up. */
  bytes: number;
  /** Books of `count` whose size isn't known (left out of `bytes`). */
  unknown: number;
}

export interface DownloadPlanItem {
  id: string;
  title: string;
  book: { size: number | null } | null;
  cover: { size: number | null } | null;
  /** The signed URL of the linked audio file (relative). */
  audio: { size: number | null; name: string; url: string } | null;
  subtitles: { size: number | null; name: string } | null;
}

export interface DownloadPlan {
  /** Selected ids the server doesn't show. */
  unknown: number;
  totals: Record<DownloadKind, KindTotal>;
  items?: DownloadPlanItem[];
}

/** How far the server is with a ZIP (GET /books/download-zip/:token). */
export type ZipStatus =
  | { state: 'preparing'; done: number; total: number }
  | { state: 'failed' | 'cancelled'; done: number; total: number; error?: string }
  | {
      state: 'ready';
      /** Relative: `absolute()` it. A plain link (the server sends an attachment). */
      url: string;
      fileName: string;
      size: number;
      count: number;
      /** Titles whose file couldn't be found (left out). */
      skipped: string[];
    };

/** The menu's names (the book page's menu says the same). */
export const KIND_LABELS: Record<DownloadKind, string> = {
  book: 'Books',
  cover: 'Covers',
  audio: 'Audiobooks',
  subtitles: 'SRT'
};

/** "340 MB", "1.2 GB", with "+" when some sizes aren't known; '' when none is known. */
export function totalSizeLabel(total: KindTotal): string {
  if (!total.count) return '';
  if (total.unknown === total.count) return '';
  const size = formatDownloadSize(total.bytes) || '0 KB';
  return total.unknown ? `${size}+` : size;
}

/** The confirmation's words for each kind ("12 audiobooks"). */
export const KIND_NOUNS: Record<DownloadKind, string> = {
  book: 'books',
  cover: 'covers',
  audio: 'audiobooks',
  subtitles: 'SRT files'
};

/**
 * A progress bar's percent and the time left from the pace so far ('' until there is a
 * pace: something done and at least two seconds gone).
 */
export function progressView(
  done: number,
  total: number,
  startedAt: number,
  now = Date.now()
): { percent: number; timeLeft: string } {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const elapsed = (now - startedAt) / 1000;
  if (done <= 0 || total <= done || elapsed < 2) return { percent, timeLeft: '' };
  const seconds = (elapsed / done) * (total - done);
  return { percent, timeLeft: `${formatTimeLeft(seconds)} left` };
}

const GB = 1024 * 1024 * 1024;

/** Whether a download of `bytes` asks first (`thresholdGb` 0 or less = never). */
export function needsSizeConfirm(bytes: number, thresholdGb: number): boolean {
  const limit = Number(thresholdGb);
  return Number.isFinite(limit) && limit > 0 && bytes > limit * GB;
}
