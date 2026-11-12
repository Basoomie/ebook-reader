/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { formatFileSize } from '$lib/library/book-details';
import { formatDuration } from '$lib/stats/stats-format';
import type {
  AudioFolderFile,
  AudioFolderSummary,
  AudioLibraryStatus,
  AudioLink,
  AudioMergeJob,
  AudioStatus,
  GpuWorkerStatus,
  SubtitleFileSummary,
  SubtitleJob
} from './audio-types';

/**
 * WP15b: what the book details page's Audiobook section shows, as plain data (tested
 * without a page). Everyday words only.
 */

/**
 * - choose: no link yet; suggestions and search, nothing chosen until a tap;
 * - none: "No audiobook";
 * - linked: linked and playable (one file);
 * - split: linked to a whole folder of several files: choose one file or merge them;
 * - missing: the folder is no longer in the audiobooks folder;
 * - changed: the linked file is no longer in its folder.
 */
export type LinkView = 'choose' | 'none' | 'linked' | 'split' | 'missing' | 'changed';

export function linkView(link: AudioLink | null): LinkView {
  if (!link) return 'choose';
  if (link.state === 'none') return 'none';
  if (link.status === 'missing') return 'missing';
  if (link.status === 'changed') return 'changed';
  if (!linkPlayable(link)) return 'split';
  return 'linked';
}

/** WP15f: a link plays when it names one file that is there. */
export function linkPlayable(link: AudioLink): boolean {
  return link.playable ?? (link.status === 'ok' && link.fileName !== null);
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

/** WP15f: a link to a whole folder of several files. */
export function splitNotice(fileCount: number): string {
  return `This audiobook is in ${fileCount.toLocaleString('en-US')} files. Choose one file, or merge them into one.`;
}

/** WP15f: the note on a suggestion or search result of several files. */
export function severalFilesNote(fileCount: number): string {
  return `In ${fileCount.toLocaleString('en-US')} files: you choose one file, or merge them.`;
}

/** "9 h 41 min · 412.0 MB" for one file. */
export function fileDetails(file: { size: number; durationSeconds: number | null }): string {
  return [formatAudioLength(file.durationSeconds), formatFileSize(file.size)].join(' · ');
}

/** The linked panel's details: the linked file's, when it is one of several. */
export function linkDetails(link: AudioLink): string {
  if (!link.folder) return '';
  if (link.file && link.folder.fileCount > 1) {
    return `${fileDetails(link.file)} · one of ${fileCountLabel(link.folder.fileCount)}`;
  }
  return folderDetails(link.folder);
}

export const COPIES_HINT =
  'These files have almost the same length and look like copies of the same audiobook. You probably want to use one of them.';

/** Moves one entry of an ordered list up (-1) or down (+1); unchanged at the ends. */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = list.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The files to merge, in the order shown, that are ticked. */
export function mergeSelection(order: string[], ticked: Set<string>): string[] {
  return order.filter((name) => ticked.has(name));
}

/** About how big the merged file is: the files' sizes added up. */
export function mergeSizeEstimate(files: AudioFolderFile[], names: string[]): number {
  return files.filter((f) => names.includes(f.name)).reduce((n, f) => n + f.size, 0);
}

export function mergeActive(job: AudioMergeJob | null): boolean {
  return !!job && (job.state === 'queued' || job.state === 'running' || job.state === 'saving');
}

/** One line on a merge, in everyday words. */
export function mergeStatusText(job: AudioMergeJob): string {
  const pct = `${Math.floor(Math.max(0, Math.min(1, job.progress)) * 100)} %`;
  const name = job.outputName ? `“${job.outputName}”` : 'one file';
  switch (job.state) {
    case 'queued':
      return 'Waiting for another merge to finish…';
    case 'running':
      return `Merging: joining the files… ${pct}`;
    case 'saving':
      return `Saving into the audiobooks folder… ${pct}`;
    case 'done':
      return job.linked
        ? `Merged into ${name}. This book now uses it. Now choose the subtitles.`
        : `Merged into ${name}. The audiobook for this book was changed during the merge, so the new file was not linked.`;
    case 'cancelled':
      return 'The merge was stopped. Nothing was added to the audiobooks folder.';
    case 'failed':
      return job.outputName
        ? `The merge saved ${name} but then failed: ${job.error ?? 'unknown error'}.`
        : `The merge failed: ${job.error ?? 'unknown error'}. Nothing was added to the audiobooks folder.`;
  }
}

// ---- WP16: subtitles made on the PC

export function subtitleJobActive(job: SubtitleJob | null): boolean {
  return !!job && (job.state === 'queued' || job.state === 'running');
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function timeAgo(then: number, now: number): string {
  const min = Math.floor(Math.max(0, now - then) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function percent(p: number | null): string {
  return p === null ? '' : ` ${Math.floor(Math.max(0, Math.min(1, p)) * 100)} %`;
}

/** Why a waiting job waits, from what the server last heard from the PC. */
export function workerWaitText(
  job: SubtitleJob,
  worker: GpuWorkerStatus | null,
  now: number
): string {
  if (!worker || !worker.available) return 'Waiting for the PC…';
  if (worker.paused)
    return 'Waiting: making subtitles on the PC is paused (Settings > Audiobooks).';
  if (!worker.online) {
    return worker.lastSeenAt
      ? `Waiting for the PC to be switched on (last seen ${timeAgo(worker.lastSeenAt, now)}).`
      : 'Waiting for the PC. The subtitle program on the PC has not checked in yet.';
  }
  if (worker.problem) return `Waiting: ${worker.problem.replace(/\.$/, '')}.`;
  if ((worker.jobs ?? []).some((j) => j.state === 'running' && j.id !== job.id)) {
    return "Waiting for another book's subtitles to finish…";
  }
  return 'Waiting for the PC to start…';
}

/** One line on a subtitle job, in everyday words. */
export function subtitleJobText(
  job: SubtitleJob,
  worker: GpuWorkerStatus | null,
  now: number
): string {
  const name = job.outputName ? `“${job.outputName}”` : 'the new file';
  switch (job.state) {
    case 'queued': {
      const wait = workerWaitText(job, worker, now);
      return job.message ? `${job.message} ${wait}` : wait;
    }
    case 'running':
      if (job.cancelRequested) return 'Stopping…';
      switch (job.stage) {
        case 'downloading':
          return `The PC is downloading the book and the audiobook…${percent(job.progress)}`;
        case 'uploading':
          return 'The PC is sending the subtitles to the server…';
        case 'saving':
          return 'Saving into the subtitle folder…';
        default: {
          const since = job.startedAt ? ` Started ${timeAgo(job.startedAt, now)}.` : '';
          const pct = job.progress === null ? '…' : `:${percent(job.progress)}.`;
          return `SubPlz is matching the audiobook to the book's text${pct}${since}`;
        }
      }
    case 'done':
      return job.linked
        ? `Subtitles made: ${name}. This book now uses them.`
        : `Subtitles made: ${name}. The audiobook or subtitles of this book were changed meanwhile, so they were not chosen. Pick them under “Change subtitles”.`;
    case 'cancelled':
      return 'Making subtitles was stopped. Nothing was added to the subtitle folder.';
    case 'failed':
      return `Making subtitles failed: ${(job.error ?? 'unknown error').replace(/\.$/, '')}. Nothing was added to the subtitle folder.`;
  }
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
    marks.push(`${fileCountLabel(link.folder.fileCount)}: choose one or merge`);
  }
  const sub = subtitleView(link);
  if (sub === 'choose') marks.push('Subtitles not chosen yet');
  else if (sub === 'missing') marks.push('Subtitle file missing');
  return marks;
}
