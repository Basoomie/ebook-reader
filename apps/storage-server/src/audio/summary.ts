/**
 * What the API shows of an indexed audiobook folder or subtitle file (WP15a), shared by
 * the index routes and audio links (WP15b).
 */
import type { AudioFolder, SubtitleFile } from './audio-index';

export interface FolderSummary {
  id: number;
  libraryId: string;
  relPath: string;
  name: string;
  parentName: string | null;
  fileCount: number;
  totalBytes: number;
  durationSeconds: number | null;
  volume: number | null;
  /** WP15 plays single-file audiobooks only (decided 2026-11-11). */
  playable: boolean;
  missing: boolean;
}

export interface SubtitleSummary {
  id: number;
  libraryId: string;
  relPath: string;
  name: string;
  parentName: string | null;
  size: number;
  missing: boolean;
}

export function folderSummary(f: AudioFolder): FolderSummary {
  return {
    id: f.id,
    libraryId: f.libraryId,
    relPath: f.relPath,
    name: f.name,
    parentName: f.parentName,
    fileCount: f.fileCount,
    totalBytes: f.totalBytes,
    durationSeconds: f.durationSeconds,
    volume: f.volume,
    playable: f.fileCount === 1,
    missing: f.missingAt !== null,
  };
}

export function subtitleSummary(s: SubtitleFile): SubtitleSummary {
  return {
    id: s.id,
    libraryId: s.libraryId,
    relPath: s.relPath,
    name: s.name,
    parentName: s.parentName,
    size: s.size,
    missing: s.missingAt !== null,
  };
}
