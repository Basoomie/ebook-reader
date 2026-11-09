/**
 * Library records and their index state. A library is discovered automatically
 * but starts disabled with no language; its language is only ever set by the
 * user (CLI), never inferred.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type IndexStatus = 'idle' | 'settling' | 'snapshotting' | 'ingesting' | 'error';

export interface Library {
  id: string;
  folder: string;
  calibreLibraryUuid: string | null;
  name: string;
  language: string | null;
  enabled: boolean;
  available: boolean;
  srtArchivePath: string | null;
  discoveredAt: number;
  updatedAt: number;
}

export interface LibraryIndexState {
  libraryId: string;
  status: IndexStatus;
  sourceMtimeMs: number | null;
  sourceSize: number | null;
  snapshotAt: number | null;
  indexedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastWarning: string | null;
  lastWarningAt: number | null;
  booksIndexed: number;
  booksMissing: number;
  booksSkipped: number;
  reindexRequestedAt: number | null;
  allowMassMissing: boolean;
}

interface LibraryRow {
  id: string;
  folder: string;
  calibre_library_uuid: string | null;
  name: string;
  language: string | null;
  enabled: number;
  available: number;
  srt_archive_path: string | null;
  discovered_at: number;
  updated_at: number;
}

interface StateRow {
  library_id: string;
  status: IndexStatus;
  source_mtime_ms: number | null;
  source_size: number | null;
  snapshot_at: number | null;
  indexed_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  last_warning: string | null;
  last_warning_at: number | null;
  books_indexed: number;
  books_missing: number;
  books_skipped: number;
  reindex_requested_at: number | null;
  allow_mass_missing: number;
}

function toLibrary(r: LibraryRow): Library {
  return {
    id: r.id,
    folder: r.folder,
    calibreLibraryUuid: r.calibre_library_uuid,
    name: r.name,
    language: r.language,
    enabled: r.enabled === 1,
    available: r.available === 1,
    srtArchivePath: r.srt_archive_path,
    discoveredAt: r.discovered_at,
    updatedAt: r.updated_at,
  };
}

function toState(r: StateRow): LibraryIndexState {
  return {
    libraryId: r.library_id,
    status: r.status,
    sourceMtimeMs: r.source_mtime_ms,
    sourceSize: r.source_size,
    snapshotAt: r.snapshot_at,
    indexedAt: r.indexed_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    lastWarning: r.last_warning,
    lastWarningAt: r.last_warning_at,
    booksIndexed: r.books_indexed,
    booksMissing: r.books_missing,
    booksSkipped: r.books_skipped,
    reindexRequestedAt: r.reindex_requested_at,
    allowMassMissing: r.allow_mass_missing === 1,
  };
}

export function listLibraries(db: Database.Database): Library[] {
  return (db.prepare('SELECT * FROM libraries ORDER BY folder').all() as LibraryRow[]).map(
    toLibrary,
  );
}

export function getLibrary(db: Database.Database, id: string): Library | null {
  const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) as LibraryRow | undefined;
  return row ? toLibrary(row) : null;
}

export function getIndexState(db: Database.Database, libraryId: string): LibraryIndexState {
  const row = db
    .prepare('SELECT * FROM library_index_state WHERE library_id = ?')
    .get(libraryId) as StateRow | undefined;
  if (!row) throw new Error(`No index state for library ${libraryId}`);
  return toState(row);
}

/** Display name for a newly discovered folder ('' is the Calibre root itself). */
function defaultName(folder: string): string {
  return folder === '' ? 'Calibre' : folder;
}

/**
 * Brings the libraries table in line with the folders that currently hold a
 * metadata.db. New folders are inserted disabled, with no language; folders
 * that went away are marked unavailable (their books are left untouched).
 * Returns the newly discovered libraries.
 */
export function syncDiscoveredLibraries(
  db: Database.Database,
  folders: string[],
  now = Date.now(),
): Library[] {
  const present = new Set(folders);
  const added: Library[] = [];
  db.transaction(() => {
    const existing = listLibraries(db);
    const known = new Set(existing.map((l) => l.folder));
    for (const lib of existing) {
      const available = present.has(lib.folder);
      if (available !== lib.available) {
        db.prepare('UPDATE libraries SET available = ?, updated_at = ? WHERE id = ?').run(
          available ? 1 : 0,
          now,
          lib.id,
        );
      }
    }
    for (const folder of folders) {
      if (known.has(folder)) continue;
      const id = randomUUID();
      db.prepare(
        `INSERT INTO libraries (id, folder, name, discovered_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, folder, defaultName(folder), now, now);
      db.prepare('INSERT INTO library_index_state (library_id) VALUES (?)').run(id);
      added.push(getLibrary(db, id)!);
    }
  })();
  return added;
}

/**
 * A language tag as the user typed it, validated and canonicalized
 * (BCP 47, e.g. "ja", "en", "en-GB"). Returns null if it is not a valid tag.
 */
export function normalizeLanguage(tag: string): string | null {
  const trimmed = tag.trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(trimmed)) return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

export interface LibraryChanges {
  name?: string;
  language?: string;
  enabled?: boolean;
}

/** Applies user changes. Throws with a user-facing message on invalid input. */
export function updateLibrary(
  db: Database.Database,
  id: string,
  changes: LibraryChanges,
  now = Date.now(),
): Library {
  const lib = getLibrary(db, id);
  if (!lib) throw new Error(`No library with id ${id}`);

  let language = lib.language;
  if (changes.language !== undefined) {
    language = normalizeLanguage(changes.language);
    if (!language) {
      throw new Error(`"${changes.language}" is not a valid language tag (e.g. ja, en, en-GB).`);
    }
  }
  let name = lib.name;
  if (changes.name !== undefined) {
    name = changes.name.trim();
    if (!name) throw new Error('A library name cannot be empty.');
  }
  const enabled = changes.enabled ?? lib.enabled;
  if (enabled && !language) {
    throw new Error('Set a language before enabling a library (--language ja, en, ...).');
  }

  db.prepare(
    'UPDATE libraries SET name = ?, language = ?, enabled = ?, updated_at = ? WHERE id = ?',
  ).run(name, language, enabled ? 1 : 0, now, id);
  return getLibrary(db, id)!;
}

/**
 * Ties a library record to Calibre's library UUID from its first snapshot.
 *
 * - First snapshot: the UUID is stored.
 * - The UUID belongs to an unavailable library: the folder was renamed or
 *   moved. The old record (with its books and settings) takes over the new
 *   folder and the never-indexed new record is dropped.
 * - The UUID belongs to a library that is still there (two folders holding the
 *   same Calibre library, e.g. a backup copy), or the folder now holds a
 *   different Calibre library: an error, nothing is indexed.
 *
 * Returns the library to index into.
 */
export function adoptLibraryUuid(
  db: Database.Database,
  libraryId: string,
  uuid: string,
  now = Date.now(),
): Library {
  return db.transaction(() => {
    const lib = getLibrary(db, libraryId);
    if (!lib) throw new Error(`No library with id ${libraryId}`);
    if (lib.calibreLibraryUuid === uuid) return lib;
    if (lib.calibreLibraryUuid !== null) {
      throw new Error(
        `Folder "${lib.folder}" now holds a different Calibre library (UUID ${uuid}, ` +
          `was ${lib.calibreLibraryUuid}). Not indexed; nothing was changed.`,
      );
    }

    const other = db
      .prepare('SELECT * FROM libraries WHERE calibre_library_uuid = ? AND id <> ?')
      .get(uuid, lib.id) as LibraryRow | undefined;
    if (!other) {
      db.prepare('UPDATE libraries SET calibre_library_uuid = ?, updated_at = ? WHERE id = ?').run(
        uuid,
        now,
        lib.id,
      );
      return getLibrary(db, lib.id)!;
    }
    if (other.available === 1) {
      throw new Error(
        `Folder "${lib.folder}" holds the same Calibre library as "${other.folder}" ` +
          '(same library UUID, maybe a copy). Not indexed.',
      );
    }
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM books WHERE library_id = ?')
      .get(lib.id) as { n: number };
    if (n > 0) throw new Error(`Library ${lib.id} already has books; can't merge it.`);

    // Folder renamed: the old record moves to the new folder.
    db.prepare('DELETE FROM libraries WHERE id = ?').run(lib.id);
    db.prepare(
      `UPDATE libraries SET folder = ?, available = 1, language = COALESCE(language, ?),
         enabled = ?, updated_at = ? WHERE id = ?`,
    ).run(lib.folder, lib.language, lib.enabled || other.enabled === 1 ? 1 : 0, now, other.id);
    console.log(
      `Calibre: library "${other.name}" moved from folder "${other.folder}" to "${lib.folder}"`,
    );
    return getLibrary(db, other.id)!;
  })();
}

/** Asks the server to re-snapshot and re-ingest a library on its next poll. */
export function requestReindex(
  db: Database.Database,
  id: string,
  allowMassMissing: boolean,
  now = Date.now(),
): void {
  const res = db
    .prepare(
      `UPDATE library_index_state SET reindex_requested_at = ?, allow_mass_missing = ?
       WHERE library_id = ?`,
    )
    .run(now, allowMassMissing ? 1 : 0, id);
  if (res.changes === 0) throw new Error(`No library with id ${id}`);
}

const STATE_COLUMNS: Record<keyof Omit<LibraryIndexState, 'libraryId'>, string> = {
  status: 'status',
  sourceMtimeMs: 'source_mtime_ms',
  sourceSize: 'source_size',
  snapshotAt: 'snapshot_at',
  indexedAt: 'indexed_at',
  lastError: 'last_error',
  lastErrorAt: 'last_error_at',
  lastWarning: 'last_warning',
  lastWarningAt: 'last_warning_at',
  booksIndexed: 'books_indexed',
  booksMissing: 'books_missing',
  booksSkipped: 'books_skipped',
  reindexRequestedAt: 'reindex_requested_at',
  allowMassMissing: 'allow_mass_missing',
};

export function updateIndexState(
  db: Database.Database,
  libraryId: string,
  changes: Partial<Omit<LibraryIndexState, 'libraryId'>>,
): void {
  const keys = Object.keys(changes) as (keyof typeof STATE_COLUMNS)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${STATE_COLUMNS[k]} = ?`).join(', ');
  const values = keys.map((k) => {
    const v = changes[k];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
  db.prepare(`UPDATE library_index_state SET ${sets} WHERE library_id = ?`).run(
    ...values,
    libraryId,
  );
}
