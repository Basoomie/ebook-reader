/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  AbsSnapshotSummary,
  AudioStage1Progress,
  AudioStage2Progress,
  AudioStageMode,
  DiskLockState
} from './cleanup-api';
import { bytesText, eta, n, type ProgressBar } from './cleanup-text';

/** Plain wording for the Audiobooks tab of /cleanup (WP21a). Nothing here changes any file. */

export const AUDIO_MODE_LABELS: Record<AudioStageMode, string> = {
  off: 'Off',
  analyse: 'Preview'
};

export const AUDIO_STAGE_HINTS: Record<number, Record<AudioStageMode, string>> = {
  1: {
    off: 'Nothing runs.',
    analyse:
      'Reads every audio file in the torrents and the library folder and finds which library files are copies of which torrent files. Nothing is moved, linked or changed.'
  },
  2: {
    off: 'Nothing runs.',
    analyse:
      'Groups the files into books and checks each file (format, length, chapters, cover, and a short play at the start and the end). Nothing is changed.'
  }
};

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Who is reading the disk now, and who waits (shared with the Calibre cleanup). */
export function diskLine(lock: DiskLockState | null | undefined, now = Date.now()): string {
  if (!lock) return '';
  const parts: string[] = [];
  if (lock.holder)
    parts.push(`Reading the disk: ${lock.holder.owner} (for ${minutes(now - lock.holder.since)})`);
  else parts.push('The disk is free: no cleanup job is reading it');
  for (const w of lock.waiting) parts.push(`waiting: ${w.owner}`);
  return parts.join(' · ');
}

const STAGE1_PHASES: Record<AudioStage1Progress['phase'], string> = {
  walk: 'Listing the files in both folders',
  hash: 'Reading files to compare their contents',
  classify: 'Sorting the results',
  done: 'Done'
};

const STAGE2_PHASES: Record<AudioStage2Progress['phase'], string> = {
  walk: 'Listing the files in both folders',
  units: 'Grouping the files into books',
  health: 'Checking each file',
  classify: 'Sorting the results',
  done: 'Done'
};

/** Stage 1's progress bar (bytes read), with the time left from the pace since the step started. */
export function audioStage1Bar(
  p: AudioStage1Progress | null,
  now = Date.now()
): ProgressBar | null {
  if (!p || p.phase !== 'hash') return null;
  const total = p.hashBytesTotal;
  const done = p.bytesHashed - p.phaseStartBytes;
  if (total <= 0) return { label: STAGE1_PHASES.hash, fraction: 0, eta: null };
  return {
    label: `${STAGE1_PHASES.hash}: ${bytesText(done)} of ${bytesText(total)}`,
    fraction: Math.min(1, done / total),
    eta: eta(done, total, p.phaseStartedAt, 0, now)
  };
}

export function audioStage2Bar(
  p: AudioStage2Progress | null,
  now = Date.now()
): ProgressBar | null {
  if (!p || p.phase !== 'health') return null;
  return {
    label: `${STAGE2_PHASES.health}: ${n(p.healthDone)} of ${n(p.healthTotal)} files`,
    fraction: p.healthTotal > 0 ? Math.min(1, p.healthDone / p.healthTotal) : 0,
    eta: eta(p.healthDone, p.healthTotal, p.phaseStartedAt, p.phaseStartDone, now)
  };
}

function mbPerSecond(bytes: number, ms: number): string {
  return ms > 0 ? `${(bytes / 1e6 / (ms / 1000)).toFixed(0)} MB/s` : '';
}

export function audioStage1Lines(p: AudioStage1Progress | null, now = Date.now()): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.phase !== 'done') out.push(`Now: ${STAGE1_PHASES[p.phase]}.`);
  if (p.walk) {
    out.push(
      `Found ${n(p.walk.audio.torrents)} audio files in the torrents (${bytesText(p.walk.bytes.torrents)}) and ${n(p.walk.audio.library)} in the library (${bytesText(p.walk.bytes.library)}).`
    );
  }
  if (p.hashTotal > 0) {
    const pace =
      p.phase === 'hash'
        ? mbPerSecond(p.bytesHashed - p.phaseStartBytes, now - p.phaseStartedAt)
        : '';
    out.push(
      `${n(p.hashDone)} of ${n(p.hashTotal)} files to compare are read${pace ? ` (${pace})` : ''}.`
    );
  }
  if (p.hashReused) out.push(`${n(p.hashReused)} were already known and not read again.`);
  if (p.hashChanged)
    out.push(`${n(p.hashChanged)} changed while being read; they are read again next time.`);
  if (p.hashErrors) out.push(`${n(p.hashErrors)} could not be read (listed below).`);
  if (p.yields) out.push(`Gave the disk to the Calibre cleanup ${n(p.yields)} times.`);
  if (p.walk && p.walk.errors.length)
    out.push(`Folders that could not be listed: ${p.walk.errors.slice(0, 3).join('; ')}`);
  if (p.error) out.push(`The analysis failed: ${p.error}`);
  if (p.phase === 'done' && p.finishedAt) {
    out.push(`Finished in ${minutes(p.finishedAt - p.startedAt)}.`);
  }
  return out;
}

const c = (counts: Record<string, number>, key: string) => counts[key] ?? 0;

/** What stage 1 found, one line each (counts from the server). */
export function identityLines(counts: Record<string, number> | null): string[] {
  if (!counts) return [];
  const lines = [
    `${n(c(counts, 'library.copy'))} library files are exact copies of a torrent file (${bytesText(c(counts, 'library.copy.bytes'))}).`,
    `${n(c(counts, 'library.linked'))} library files are already hard links to their torrent file.`,
    `${n(c(counts, 'library.library_only'))} library files have no torrent file of the same size.`,
    `${n(c(counts, 'torrents.torrent_only'))} torrent audio files are not in the library (${bytesText(c(counts, 'torrents.torrent_only.bytes'))}).`,
    `${n(c(counts, 'torrents.copy_extra'))} torrent files are exact copies of another torrent file (${n(c(counts, 'torrents.copy_groups'))} groups).`,
    `${n(c(counts, 'library.ai_original'))} library files come from the AI folder (${bytesText(c(counts, 'library.ai_original.bytes'))}); they move to japanese-generated later.`,
    `${n(c(counts, 'torrents.archive'))} archives in the torrents (.zip/.rar), to unpack later.`
  ];
  if (c(counts, 'library.size_only')) {
    lines.push(
      `${n(c(counts, 'library.size_only'))} library files have a torrent file of the same size but other contents.`
    );
  }
  if (c(counts, 'library.unhashed')) {
    lines.push(
      `${n(c(counts, 'library.unhashed'))} library files could not be compared (read error or changed).`
    );
  }
  if (c(counts, 'files.nlink_gt1')) {
    lines.push(
      `${n(c(counts, 'files.nlink_gt1'))} files have more than one name on the disk (hard links).`
    );
  }
  return lines;
}

export function audioStage2Lines(p: AudioStage2Progress | null): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.phase !== 'done') out.push(`Now: ${STAGE2_PHASES[p.phase]}.`);
  if (p.books) out.push(`${n(p.books)} books in both folders.`);
  if (p.healthReused)
    out.push(`${n(p.healthReused)} files were checked before and had not changed.`);
  if (p.error) out.push(`The analysis failed: ${p.error}`);
  if (p.phase === 'done' && p.finishedAt)
    out.push(`Finished in ${minutes(p.finishedAt - p.startedAt)}.`);
  return out;
}

/** What stage 2 found (counts from the server). */
export function booksLines(counts: Record<string, number> | null): string[] {
  if (!counts) return [];
  const lines: string[] = [];
  for (const root of ['torrents', 'library'] as const) {
    const where = root === 'torrents' ? 'Torrents' : 'Library';
    const books =
      c(counts, `${root}.single`) +
      c(counts, `${root}.parts`) +
      c(counts, `${root}.likely_copies`) +
      c(counts, `${root}.unclear`);
    lines.push(
      `${where}: ${n(books)} books; ${n(c(counts, `${root}.likely_copies`))} folders look like two or more full copies, ${n(c(counts, `${root}.parts`))} are in parts, ${n(c(counts, `${root}.unclear`))} are unclear.`
    );
    lines.push(
      `${where}: ${n(c(counts, `${root}.health.unreadable`))} files can’t be read, ${n(c(counts, `${root}.health.damaged`))} fail to play at the start or the end, ${n(c(counts, `${root}.health.mp4_no_chapters`))} m4b/m4a without chapters, ${n(c(counts, `${root}.health.no_cover`))} without a cover, ${n(c(counts, `${root}.health.ext_mismatch`))} named as another format.`
    );
  }
  if (c(counts, 'books.decoded_names')) {
    lines.push(
      `${n(c(counts, 'books.decoded_names'))} book names are garbled Japanese that could be read back (shown below; nothing is renamed).`
    );
  }
  return lines;
}

export function snapshotLine(s: AbsSnapshotSummary | null | undefined): string {
  if (!s) return 'No snapshot yet.';
  const version = s.serverVersion ? ` (Audiobookshelf ${s.serverVersion})` : '';
  return `${n(s.libraries)} libraries with ${n(s.items)} items, ${n(s.users)} users${version}; ${n(s.progress)} books with listening progress: ${n(s.finished)} finished, ${n(s.inProgress)} started${s.notInAbs ? `, ${n(s.notInAbs)} no longer in Audiobookshelf` : ''}.`;
}

export function durationText(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '–';
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${t % 60} s`;
}

/** Stage 1 and 2's lists, in the order the page offers them. */
export const FILE_LISTS: { id: string; label: string; stage: 1 | 2 }[] = [
  { id: 'library_only', label: 'Library files with no torrent file', stage: 1 },
  { id: 'torrent_only', label: 'Torrent audio not in the library', stage: 1 },
  { id: 'torrent_copy', label: 'Torrent files that are copies of other torrent files', stage: 1 },
  { id: 'ai', label: 'Library files from the AI folder', stage: 1 },
  { id: 'archive_torrents', label: 'Archives in the torrents', stage: 1 },
  { id: 'size_only', label: 'Same size, other contents', stage: 1 },
  { id: 'unhashed', label: 'Could not be compared', stage: 1 },
  { id: 'linked', label: 'Already hard links', stage: 1 },
  { id: 'unreadable', label: 'Files that can’t be read', stage: 2 },
  { id: 'damaged', label: 'Files that fail to play at the start or end', stage: 2 },
  { id: 'ext_mismatch', label: 'Files named as another format', stage: 2 },
  { id: 'mojibake', label: 'Garbled Japanese names', stage: 2 },
  { id: 'raw_names', label: 'Names that are not UTF-8', stage: 2 }
];

export const BOOK_LISTS: { id: string; label: string }[] = [
  { id: 'likely_copies', label: 'Folders that look like full copies' },
  { id: 'unclear', label: 'Folders that are unclear' },
  { id: 'parts', label: 'Books in parts' },
  { id: 'decoded', label: 'Books with garbled names' }
];
