/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** The storage server's audiobook index and audio links (WP15a, WP15b), as the API sends them. */

import type { AudiobookJob } from './tts-types';

export interface AudioFolderSummary {
  id: number;
  libraryId: string;
  /** Relative to the server's audiobooks folder. */
  relPath: string;
  name: string;
  parentName: string | null;
  fileCount: number;
  totalBytes: number;
  /** null while the server is still reading the files' lengths. */
  durationSeconds: number | null;
  volume: number | null;
  /**
   * A single-file folder: choosing it links its file. A folder of several files needs one
   * file chosen, or a merge (WP15f).
   */
  playable: boolean;
  missing: boolean;
  /** WP17: an audiobook made on the PC (in the generated audiobooks folder). */
  generated?: boolean;
}

export interface SubtitleFileSummary {
  id: number;
  libraryId: string;
  relPath: string;
  name: string;
  parentName: string | null;
  size: number;
  missing: boolean;
  /** WP17: made with an audiobook made on the PC. */
  generated?: boolean;
}

export type Ranked<T> = T & { score: number; tier: string };

export interface AudioCandidates {
  book: {
    id: string;
    title: string;
    seriesName: string | null;
    seriesIndex: number | null;
    libraryId: string;
  };
  libraryHasAudio: boolean;
  libraryHasSubtitles: boolean;
  audio: Ranked<AudioFolderSummary>[];
  subtitles: Ranked<SubtitleFileSummary>[];
}

export interface AudioLibraryStatus {
  id: string;
  name: string;
  audioDir: string | null;
  subtitleDir: string | null;
  status: 'idle' | 'scanning' | 'error';
  scannedAt: number | null;
  folders: number;
  subtitles: number;
  archivesSkipped: number;
  durationsPending: number;
  scanRequested: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface AudioStatus {
  /** false when the server has no usable audiobooks folder. */
  enabled: boolean;
  error: string | null;
  /** WP15f: whether "Merge into one file" works on this server, and why not. */
  merge?: { available: boolean; reason: string | null };
  libraries: AudioLibraryStatus[];
}

/** WP15f: one file of an audiobook folder. */
export interface AudioFolderFile {
  index: number;
  name: string;
  size: number;
  durationSeconds: number | null;
  url: string;
}

/** WP15f: a folder with its files (GET /audio/folders/:id). */
export interface AudioFolderDetail extends AudioFolderSummary {
  /** The files are long and almost the same length: probably copies, not parts. */
  looksLikeCopies: boolean;
  files: AudioFolderFile[];
}

export type AudioMergeState = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'cancelled';

/** WP15f: "Merge into one file". */
export interface AudioMergeJob {
  id: number;
  bookId: string;
  libraryId: string;
  folderRelPath: string;
  folderName: string;
  files: string[];
  state: AudioMergeState;
  mode: 'copy' | 'reencode' | null;
  /** 0..1 */
  progress: number;
  outputName: string | null;
  error: string | null;
  /** The book was linked to the merged file. */
  linked: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type SubtitleJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type SubtitleJobStage = 'downloading' | 'syncing' | 'uploading' | 'saving';

/** WP16: "Make subtitles on the PC" (SubPlz on the GPU worker). */
export interface SubtitleJob {
  id: number;
  bookId: string;
  bookTitle: string | null;
  kind: 'sync_subtitles';
  audioFileName: string;
  state: SubtitleJobState;
  stage: SubtitleJobStage | null;
  /** 0..1 within the stage, or null when unknown. */
  progress: number | null;
  message: string | null;
  cancelRequested: boolean;
  attempts: number;
  outputName: string | null;
  outputRelPath: string | null;
  linked: boolean;
  error: string | null;
  logTail: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

/** WP16: the GPU worker as the server last heard from it. */
export interface GpuWorkerStatus {
  /** false: this server has no job queue (no audiobooks folder). */
  available: boolean;
  online?: boolean;
  lastSeenAt?: number | null;
  paused?: boolean;
  version?: string | null;
  image?: string | null;
  /** WP17: the TTS program's image the PC reported. */
  ttsImage?: string | null;
  problem?: string | null;
  /** The user's waiting and running jobs (WP17: of every kind). */
  jobs?: (SubtitleJob | AudiobookJob)[];
}

export interface AudioLink {
  bookId: string;
  /** 'none' = "No audiobook". */
  state: 'linked' | 'none';
  folderRelPath: string | null;
  fileName: string | null;
  /** null = the subtitle step hasn't been answered yet. */
  subtitleState: 'linked' | 'none' | null;
  subtitleRelPath: string | null;
  source: 'library' | 'migrated';
  confirmedAt: number;
  folder: AudioFolderSummary | null;
  /** null when state is 'none'. */
  status: 'ok' | 'missing' | 'changed' | null;
  subtitle: SubtitleFileSummary | null;
  subtitleStatus: 'ok' | 'missing' | null;
  /** WP15f: linked to one file that is there. */
  playable?: boolean;
  /** WP15f: the linked file; null for a folder link or a missing file. */
  file?: { name: string; size: number; durationSeconds: number | null } | null;
  /** WP15c: the signed URL whispersync plays (links to one file that is there), else null. */
  playUrl?: string | null;
}

export interface AudioLinkListEntry extends AudioLink {
  book: { title: string; authors: string[]; missing: boolean } | null;
}

export interface AudioLinkChange {
  /** fileName (WP15f): one file of a folder of several. */
  audio?: { state: 'linked'; folderId: number; fileName?: string } | { state: 'none' };
  subtitle?: { state: 'linked'; subtitleId: number } | { state: 'none' } | { state: null };
}
