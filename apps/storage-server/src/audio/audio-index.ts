/**
 * The audiobook and subtitle index tables (WP15a, migration 10): what the last
 * scan found under the read-only audiobooks root. Only the scan service writes
 * here; the matcher, the API and the CLI read.
 */
import type Database from 'better-sqlite3';

export interface AudioFileEntry {
  name: string;
  size: number;
  mtimeMs: number;
  /** null until measured (or when the header couldn't be read, see durationFailed). */
  durationSeconds: number | null;
  durationFailed?: boolean;
}

export interface AudioFolder {
  id: number;
  libraryId: string;
  /** Relative to the audiobooks root, forward slashes. */
  relPath: string;
  name: string;
  parentName: string | null;
  titleKey: string;
  looseKey: string;
  volume: number | null;
  metaTitle: string | null;
  metaSeries: string | null;
  metaSequence: string | null;
  asin: string | null;
  files: AudioFileEntry[];
  fileCount: number;
  totalBytes: number;
  /** Sum of the files' durations once every file is measured; otherwise null. */
  durationSeconds: number | null;
  seenAt: number;
  missingAt: number | null;
  /** WP17: found under the library's `<audio folder>-generated/` (a generated audiobook). */
  generated: boolean;
}

export interface SubtitleFile {
  id: number;
  libraryId: string;
  relPath: string;
  name: string;
  parentName: string | null;
  titleKey: string;
  looseKey: string;
  volume: number | null;
  size: number;
  mtimeMs: number;
  seenAt: number;
  missingAt: number | null;
  /** WP17: next to a generated audiobook in `<audio folder>-generated/`. */
  generated: boolean;
}

export type AudioScanStatus = 'idle' | 'scanning' | 'error';

export interface AudioScanState {
  libraryId: string;
  status: AudioScanStatus;
  scannedAt: number | null;
  folders: number;
  subtitles: number;
  archivesSkipped: number;
  lastError: string | null;
  lastErrorAt: number | null;
  scanRequestedAt: number | null;
}

interface FolderRow {
  id: number;
  library_id: string;
  rel_path: string;
  name: string;
  parent_name: string | null;
  title_key: string;
  loose_key: string;
  volume: number | null;
  meta_title: string | null;
  meta_series: string | null;
  meta_sequence: string | null;
  asin: string | null;
  files: string;
  file_count: number;
  total_bytes: number;
  duration_seconds: number | null;
  seen_at: number;
  missing_at: number | null;
  generated: number;
}

interface SubtitleRow {
  id: number;
  library_id: string;
  rel_path: string;
  name: string;
  parent_name: string | null;
  title_key: string;
  loose_key: string;
  volume: number | null;
  size: number;
  mtime_ms: number;
  seen_at: number;
  missing_at: number | null;
  generated: number;
}

function toFolder(r: FolderRow): AudioFolder {
  return {
    id: r.id,
    libraryId: r.library_id,
    relPath: r.rel_path,
    name: r.name,
    parentName: r.parent_name,
    titleKey: r.title_key,
    looseKey: r.loose_key,
    volume: r.volume,
    metaTitle: r.meta_title,
    metaSeries: r.meta_series,
    metaSequence: r.meta_sequence,
    asin: r.asin,
    files: JSON.parse(r.files) as AudioFileEntry[],
    fileCount: r.file_count,
    totalBytes: r.total_bytes,
    durationSeconds: r.duration_seconds,
    seenAt: r.seen_at,
    missingAt: r.missing_at,
    generated: r.generated === 1,
  };
}

function toSubtitle(r: SubtitleRow): SubtitleFile {
  return {
    id: r.id,
    libraryId: r.library_id,
    relPath: r.rel_path,
    name: r.name,
    parentName: r.parent_name,
    titleKey: r.title_key,
    looseKey: r.loose_key,
    volume: r.volume,
    size: r.size,
    mtimeMs: r.mtime_ms,
    seenAt: r.seen_at,
    missingAt: r.missing_at,
    generated: r.generated === 1,
  };
}

export function getAudioFolder(db: Database.Database, id: number): AudioFolder | null {
  const row = db.prepare('SELECT * FROM audio_folders WHERE id = ?').get(id) as
    | FolderRow
    | undefined;
  return row ? toFolder(row) : null;
}

export function getAudioFolderByPath(
  db: Database.Database,
  libraryId: string,
  relPath: string,
): AudioFolder | null {
  const row = db
    .prepare('SELECT * FROM audio_folders WHERE library_id = ? AND rel_path = ?')
    .get(libraryId, relPath) as FolderRow | undefined;
  return row ? toFolder(row) : null;
}

/** Folders of one library (present ones only unless `includeMissing`). */
export function listAudioFolders(
  db: Database.Database,
  libraryId: string,
  { includeMissing = false }: { includeMissing?: boolean } = {},
): AudioFolder[] {
  return (
    db
      .prepare(
        `SELECT * FROM audio_folders WHERE library_id = ? ${includeMissing ? '' : 'AND missing_at IS NULL'}
         ORDER BY rel_path`,
      )
      .all(libraryId) as FolderRow[]
  ).map(toFolder);
}

export function getSubtitleFile(db: Database.Database, id: number): SubtitleFile | null {
  const row = db.prepare('SELECT * FROM subtitle_files WHERE id = ?').get(id) as
    | SubtitleRow
    | undefined;
  return row ? toSubtitle(row) : null;
}

/**
 * A folder by its root-relative path in any library (an audio link stores only the
 * path). A present row wins over a missing one.
 */
export function getAudioFolderByRelPath(
  db: Database.Database,
  relPath: string,
): AudioFolder | null {
  const row = db
    .prepare(
      `SELECT * FROM audio_folders WHERE rel_path = ?
       ORDER BY missing_at IS NOT NULL, id LIMIT 1`,
    )
    .get(relPath) as FolderRow | undefined;
  return row ? toFolder(row) : null;
}

/** A subtitle file by its root-relative path in any library; a present row wins. */
export function getSubtitleFileByRelPath(
  db: Database.Database,
  relPath: string,
): SubtitleFile | null {
  const row = db
    .prepare(
      `SELECT * FROM subtitle_files WHERE rel_path = ?
       ORDER BY missing_at IS NOT NULL, id LIMIT 1`,
    )
    .get(relPath) as SubtitleRow | undefined;
  return row ? toSubtitle(row) : null;
}

export function listSubtitleFiles(
  db: Database.Database,
  libraryId: string,
  { includeMissing = false }: { includeMissing?: boolean } = {},
): SubtitleFile[] {
  return (
    db
      .prepare(
        `SELECT * FROM subtitle_files WHERE library_id = ? ${includeMissing ? '' : 'AND missing_at IS NULL'}
         ORDER BY rel_path`,
      )
      .all(libraryId) as SubtitleRow[]
  ).map(toSubtitle);
}

/** Total duration when every file is measured, else null. */
export function totalDuration(files: AudioFileEntry[]): number | null {
  let sum = 0;
  for (const f of files) {
    if (f.durationSeconds === null) return null;
    sum += f.durationSeconds;
  }
  return Math.round(sum * 1000) / 1000;
}

export type FolderInput = Omit<
  AudioFolder,
  'id' | 'missingAt' | 'durationSeconds' | 'fileCount' | 'totalBytes' | 'generated'
> & { generated?: boolean };

/**
 * Inserts or updates a folder seen by a scan. Durations already measured for a
 * file with the same name, size and mtime are kept, so a rescan reads no headers
 * again.
 */
export function upsertAudioFolder(db: Database.Database, input: FolderInput): AudioFolder {
  const previous = getAudioFolderByPath(db, input.libraryId, input.relPath);
  const files = input.files.map((f) => {
    const old = previous?.files.find(
      (p) => p.name === f.name && p.size === f.size && p.mtimeMs === f.mtimeMs,
    );
    return old
      ? { ...f, durationSeconds: old.durationSeconds, durationFailed: old.durationFailed }
      : f;
  });
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  db.prepare(
    `INSERT INTO audio_folders (library_id, rel_path, name, parent_name, title_key, loose_key, volume,
       meta_title, meta_series, meta_sequence, asin, files, file_count, total_bytes, duration_seconds,
       seen_at, missing_at, generated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (library_id, rel_path) DO UPDATE SET generated = excluded.generated,
       name = excluded.name, parent_name = excluded.parent_name, title_key = excluded.title_key,
       loose_key = excluded.loose_key, volume = excluded.volume, meta_title = excluded.meta_title,
       meta_series = excluded.meta_series, meta_sequence = excluded.meta_sequence, asin = excluded.asin,
       files = excluded.files, file_count = excluded.file_count, total_bytes = excluded.total_bytes,
       duration_seconds = excluded.duration_seconds, seen_at = excluded.seen_at, missing_at = NULL`,
  ).run(
    input.libraryId,
    input.relPath,
    input.name,
    input.parentName,
    input.titleKey,
    input.looseKey,
    input.volume,
    input.metaTitle,
    input.metaSeries,
    input.metaSequence,
    input.asin,
    JSON.stringify(files),
    files.length,
    totalBytes,
    totalDuration(files),
    input.seenAt,
    input.generated ? 1 : 0,
  );
  return getAudioFolderByPath(db, input.libraryId, input.relPath)!;
}

export function setFolderFiles(db: Database.Database, id: number, files: AudioFileEntry[]): void {
  db.prepare('UPDATE audio_folders SET files = ?, duration_seconds = ? WHERE id = ?').run(
    JSON.stringify(files),
    totalDuration(files),
    id,
  );
}

/** Folders with at least one file whose duration was never tried. */
export function foldersNeedingDurations(db: Database.Database, libraryId: string): AudioFolder[] {
  return listAudioFolders(db, libraryId).filter((f) =>
    f.files.some((file) => file.durationSeconds === null && !file.durationFailed),
  );
}

export type SubtitleInput = Omit<SubtitleFile, 'id' | 'missingAt' | 'generated'> & {
  generated?: boolean;
};

export function upsertSubtitleFile(db: Database.Database, input: SubtitleInput): void {
  db.prepare(
    `INSERT INTO subtitle_files (library_id, rel_path, name, parent_name, title_key, loose_key, volume,
       size, mtime_ms, seen_at, missing_at, generated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (library_id, rel_path) DO UPDATE SET generated = excluded.generated,
       name = excluded.name, parent_name = excluded.parent_name, title_key = excluded.title_key,
       loose_key = excluded.loose_key, volume = excluded.volume, size = excluded.size,
       mtime_ms = excluded.mtime_ms, seen_at = excluded.seen_at, missing_at = NULL`,
  ).run(
    input.libraryId,
    input.relPath,
    input.name,
    input.parentName,
    input.titleKey,
    input.looseKey,
    input.volume,
    input.size,
    input.mtimeMs,
    input.seenAt,
    input.generated ? 1 : 0,
  );
}

/** WP17: present rows outside (or inside) the generated folder, for the empty-scan guard. */
export function countPresentOf(
  db: Database.Database,
  table: 'audio_folders' | 'subtitle_files',
  libraryId: string,
  generated: boolean,
): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE library_id = ? AND missing_at IS NULL AND generated = ?`,
      )
      .get(libraryId, generated ? 1 : 0) as { n: number }
  ).n;
}

/** Marks rows a finished scan did not see as missing (never deletes them). Returns how many. */
export function markUnseenMissing(
  db: Database.Database,
  table: 'audio_folders' | 'subtitle_files',
  libraryId: string,
  scanStartedAt: number,
  now: number,
): number {
  return db
    .prepare(
      `UPDATE ${table} SET missing_at = ? WHERE library_id = ? AND seen_at < ? AND missing_at IS NULL`,
    )
    .run(now, libraryId, scanStartedAt).changes;
}

export function countPresent(
  db: Database.Database,
  table: 'audio_folders' | 'subtitle_files',
  libraryId: string,
): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE library_id = ? AND missing_at IS NULL`)
      .get(libraryId) as { n: number }
  ).n;
}

const SCAN_STATE_DEFAULTS = {
  status: 'idle' as AudioScanStatus,
  scannedAt: null,
  folders: 0,
  subtitles: 0,
  archivesSkipped: 0,
  lastError: null,
  lastErrorAt: null,
  scanRequestedAt: null,
};

export function getScanState(db: Database.Database, libraryId: string): AudioScanState {
  const r = db.prepare('SELECT * FROM audio_scan_state WHERE library_id = ?').get(libraryId) as
    | {
        library_id: string;
        status: AudioScanStatus;
        scanned_at: number | null;
        folders: number;
        subtitles: number;
        archives_skipped: number;
        last_error: string | null;
        last_error_at: number | null;
        scan_requested_at: number | null;
      }
    | undefined;
  if (!r) return { libraryId, ...SCAN_STATE_DEFAULTS };
  return {
    libraryId,
    status: r.status,
    scannedAt: r.scanned_at,
    folders: r.folders,
    subtitles: r.subtitles,
    archivesSkipped: r.archives_skipped,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    scanRequestedAt: r.scan_requested_at,
  };
}

export function updateScanState(
  db: Database.Database,
  libraryId: string,
  changes: Partial<Omit<AudioScanState, 'libraryId'>>,
): void {
  const s = { ...getScanState(db, libraryId), ...changes };
  db.prepare(
    `INSERT INTO audio_scan_state (library_id, status, scanned_at, folders, subtitles, archives_skipped,
       last_error, last_error_at, scan_requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (library_id) DO UPDATE SET status = excluded.status, scanned_at = excluded.scanned_at,
       folders = excluded.folders, subtitles = excluded.subtitles,
       archives_skipped = excluded.archives_skipped, last_error = excluded.last_error,
       last_error_at = excluded.last_error_at, scan_requested_at = excluded.scan_requested_at`,
  ).run(
    libraryId,
    s.status,
    s.scannedAt,
    s.folders,
    s.subtitles,
    s.archivesSkipped,
    s.lastError,
    s.lastErrorAt,
    s.scanRequestedAt,
  );
}

/** What the CLI and the API call: the server scans on its next poll. */
export function requestAudioScan(db: Database.Database, libraryId: string, now = Date.now()): void {
  updateScanState(db, libraryId, { scanRequestedAt: now });
}
