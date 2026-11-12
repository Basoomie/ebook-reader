/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** The storage server's audiobook index and audio links (WP15a, WP15b), as the API sends them. */

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
  /** Single-file audiobooks only for now. */
  playable: boolean;
  missing: boolean;
}

export interface SubtitleFileSummary {
  id: number;
  libraryId: string;
  relPath: string;
  name: string;
  parentName: string | null;
  size: number;
  missing: boolean;
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
  libraries: AudioLibraryStatus[];
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
  /** WP15c: the signed URL whispersync plays (single-file links that are there), else null. */
  playUrl?: string | null;
}

export interface AudioLinkListEntry extends AudioLink {
  book: { title: string; authors: string[]; missing: boolean } | null;
}

export interface AudioLinkChange {
  audio?: { state: 'linked'; folderId: number } | { state: 'none' };
  subtitle?: { state: 'linked'; subtitleId: number } | { state: 'none' } | { state: null };
}
