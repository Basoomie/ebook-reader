/**
 * Audio links (WP15b, migration 11): the audiobook folder and subtitle file the user
 * confirmed for a book in the picker. Never written automatically.
 *
 * A link is stored by root-relative path. It is resolved against the index when read:
 * a folder that disappeared shows as missing, and nothing looks for a replacement (the
 * same path coming back makes it work again). Only reads the index tables; never
 * touches the audiobooks folder.
 */
import type Database from 'better-sqlite3';
import { getAudioFolderByRelPath, getSubtitleFileByRelPath } from './audio-index';
import {
  folderSummary,
  subtitleSummary,
  type FolderSummary,
  type SubtitleSummary,
} from './summary';

export type LinkState = 'linked' | 'none';
export type SubtitleState = 'linked' | 'none' | null;
export type LinkSource = 'library' | 'migrated';

export interface AudioLink {
  bookId: string;
  state: LinkState;
  /** Root-relative folder path; null when state is 'none'. */
  folderRelPath: string | null;
  /**
   * The linked audio file. Set for a single-file folder and (WP15f) for one file chosen
   * in a folder of several files or a merged file; null = the whole folder of several
   * files, which can't play.
   */
  fileName: string | null;
  subtitleState: SubtitleState;
  subtitleRelPath: string | null;
  source: LinkSource;
  confirmedAt: number;
}

/**
 * - ok: the folder (and the linked file) is in the index;
 * - missing: the folder is gone from the audiobooks folder (or was never indexed here);
 * - changed: a single-file link whose file is no longer in the folder.
 */
export type LinkStatus = 'ok' | 'missing' | 'changed';

export interface LinkedFileSummary {
  name: string;
  size: number;
  durationSeconds: number | null;
}

export interface ResolvedAudioLink extends AudioLink {
  folder: FolderSummary | null;
  /** null when state is 'none'. */
  status: LinkStatus | null;
  /** WP15f: linked to one file that is there (whispersync can play it). */
  playable: boolean;
  /** WP15f: the linked file as indexed; null for a folder link or a missing file. */
  file: LinkedFileSummary | null;
  subtitle: SubtitleSummary | null;
  /** null when no subtitle file is linked. */
  subtitleStatus: 'ok' | 'missing' | null;
}

interface LinkRow {
  book_id: string;
  state: LinkState;
  folder_rel_path: string | null;
  file_name: string | null;
  subtitle_state: 'linked' | 'none' | null;
  subtitle_rel_path: string | null;
  source: LinkSource;
  confirmed_at: number;
}

function toLink(r: LinkRow): AudioLink {
  return {
    bookId: r.book_id,
    state: r.state,
    folderRelPath: r.folder_rel_path,
    fileName: r.file_name,
    subtitleState: r.subtitle_state,
    subtitleRelPath: r.subtitle_rel_path,
    source: r.source,
    confirmedAt: r.confirmed_at,
  };
}

export function getLink(db: Database.Database, userId: string, bookId: string): AudioLink | null {
  const row = db
    .prepare('SELECT * FROM audio_links WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

export function listLinks(db: Database.Database, userId: string): AudioLink[] {
  return (
    db
      .prepare('SELECT * FROM audio_links WHERE user_id = ? ORDER BY book_id')
      .all(userId) as LinkRow[]
  ).map(toLink);
}

/** Writes the whole link (the route works out the merged state). */
export function saveLink(db: Database.Database, userId: string, link: AudioLink): void {
  db.prepare(
    `INSERT INTO audio_links (user_id, book_id, state, folder_rel_path, file_name,
       subtitle_rel_path, subtitle_state, source, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       state = excluded.state, folder_rel_path = excluded.folder_rel_path,
       file_name = excluded.file_name, subtitle_rel_path = excluded.subtitle_rel_path,
       subtitle_state = excluded.subtitle_state, source = excluded.source,
       confirmed_at = excluded.confirmed_at`,
  ).run(
    userId,
    link.bookId,
    link.state,
    link.folderRelPath,
    link.fileName,
    link.subtitleRelPath,
    link.subtitleState,
    link.source,
    link.confirmedAt,
  );
}

export function deleteLink(db: Database.Database, userId: string, bookId: string): boolean {
  return (
    db.prepare('DELETE FROM audio_links WHERE user_id = ? AND book_id = ?').run(userId, bookId)
      .changes > 0
  );
}

export function resolveLink(db: Database.Database, link: AudioLink): ResolvedAudioLink {
  let folder: FolderSummary | null = null;
  let status: LinkStatus | null = null;
  let file: LinkedFileSummary | null = null;
  if (link.state === 'linked' && link.folderRelPath !== null) {
    const row = getAudioFolderByRelPath(db, link.folderRelPath);
    folder = row ? folderSummary(row) : null;
    const entry = row?.files.find((f) => f.name === link.fileName);
    if (entry) {
      file = { name: entry.name, size: entry.size, durationSeconds: entry.durationSeconds };
    }
    if (!row || row.missingAt !== null) status = 'missing';
    else if (link.fileName !== null && !entry) status = 'changed';
    else status = 'ok';
  }
  const playable = status === 'ok' && link.fileName !== null;
  let subtitle: SubtitleSummary | null = null;
  let subtitleStatus: 'ok' | 'missing' | null = null;
  if (link.subtitleState === 'linked' && link.subtitleRelPath !== null) {
    const row = getSubtitleFileByRelPath(db, link.subtitleRelPath);
    subtitle = row ? subtitleSummary(row) : null;
    subtitleStatus = row && row.missingAt === null ? 'ok' : 'missing';
  }
  return { ...link, folder, status, playable, file, subtitle, subtitleStatus };
}
