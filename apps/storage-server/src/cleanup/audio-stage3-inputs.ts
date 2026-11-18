/**
 * Stage 3's inputs from outside the audiobook roots (WP21b). Kept out of `cleanup/audio/`, whose
 * modules reach the file system only through that folder's one read-only module.
 *
 * - The labeled pairs of the reference sample (labels.json), read from
 *   `<DB_DIR>/cleanup/reference-sample/audio/labels.json` unless Settings names another file
 *   (plan section 1: the reference sample lives beside Calibre's in appdata).
 * - The audio files the reader wrote into the library (merges, WP15f), from ttsu.db's
 *   `audio_writes`: they never compete in stage 3 (design section 7).
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getSettings } from './settings';

export const AUDIO_LABELS_FILENAME = 'labels.json';

export function defaultAudioLabelsFile(dbDir: string): string {
  return path.join(dbDir, 'cleanup', 'reference-sample', 'audio', AUDIO_LABELS_FILENAME);
}

export function audioLabelsReader(
  cleanupDb: Database.Database,
  dbDir: string | null,
): () => { text: string | null; error: string | null } {
  return () => {
    const configured = getSettings(cleanupDb).gate.audiobookPairsFile;
    const file = configured || (dbDir ? defaultAudioLabelsFile(dbDir) : '');
    if (!file) return { text: null, error: 'No database folder: the labeled pairs can’t be found' };
    try {
      return { text: fs.readFileSync(file, 'utf8'), error: null };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        text: null,
        error:
          code === 'ENOENT'
            ? `The labeled pairs are not there: ${file}`
            : `${file}: ${(err as Error).message}`,
      };
    }
  };
}

/**
 * Library paths (relative to the cleanup's library root, e.g. `作者/本/本 (merged).m4b`) of
 * audio files the reader wrote. The reader's paths are relative to AUDIOBOOKS_DIR
 * (media/audiobooks), so only those under the library's folder (`libraryFolder`, the last part
 * of `libraryDir`, CLEANUP_AUDIO_LIBRARY_DIR, e.g. `japanese`) count, without that first part.
 */
export function readerWrittenFiles(mainDb: Database.Database, libraryDir: string): () => string[] {
  const libraryFolder = path.basename(libraryDir);
  return () => {
    try {
      const rows = mainDb
        .prepare(
          `SELECT final_rel_path FROM audio_writes WHERE state = 'done' AND final_rel_path IS NOT NULL`,
        )
        .all() as { final_rel_path: string }[];
      const prefix = `${libraryFolder}/`;
      return rows
        .map((r) => r.final_rel_path)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    } catch {
      return [];
    }
  };
}
