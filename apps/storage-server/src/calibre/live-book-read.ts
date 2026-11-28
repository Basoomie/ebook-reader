/**
 * One Calibre book as the library's live metadata.db holds it now (read only), found by its
 * Calibre id first and its UUID only when the id doesn't name it (2026-11-28).
 *
 * Calibre's `books` table has no index on `uuid` (calibre 9.18: books_idx on sort, authors_idx,
 * data_idx, formats_idx), so `WHERE uuid = ?` reads the whole table: on the NAS, cold through
 * Unraid's FUSE layer while the disk is busy, 6-10 s per lookup. The id is the table's primary
 * key (a few pages). An id can name another book (a book removed and its id taken again, or the
 * id of another library), so the row counts only when its UUID is the one asked for.
 *
 * Pure: no worker or file handling here (live-book.ts runs it; the worker imports this file).
 */
import type Database from 'better-sqlite3';

export interface LiveBookKey {
  uuid: string;
  /** The book's Calibre id when known (looked up first). */
  calibreId?: number | null;
}

export interface LiveBook {
  id: number;
  uuid: string;
  /** The book's folder inside the library. */
  path: string;
  hasCover: boolean;
  sort: string;
  /** Format (upper case) → file path inside the library folder. */
  formats: Map<string, string>;
}

interface BookRow {
  id: number;
  uuid: string | null;
  path: string;
  has_cover: number;
  sort: string | null;
}

const COLUMNS = 'id, uuid, path, has_cover, sort';

/** The book's row, or null when Calibre has no book with that UUID. */
export function readLiveBook(db: Database.Database, key: LiveBookKey): LiveBook | null {
  let row: BookRow | undefined;
  if (key.calibreId != null && Number.isInteger(key.calibreId)) {
    row = db.prepare(`SELECT ${COLUMNS} FROM books WHERE id = ?`).get(key.calibreId) as
      | BookRow
      | undefined;
    if (row && row.uuid !== key.uuid) row = undefined;
  }
  // No id, or the id names another book (or none): the whole-table search by UUID.
  row ??= db.prepare(`SELECT ${COLUMNS} FROM books WHERE uuid = ?`).get(key.uuid) as
    | BookRow
    | undefined;
  if (!row) return null;
  const formats = new Map<string, string>();
  for (const d of db.prepare('SELECT format, name FROM data WHERE book = ?').all(row.id) as {
    format: string;
    name: string;
  }[])
    formats.set(d.format.toUpperCase(), `${row.path}/${d.name}.${d.format.toLowerCase()}`);
  return {
    id: row.id,
    uuid: key.uuid,
    path: row.path,
    hasCover: row.has_cover === 1,
    sort: row.sort ?? '',
    formats,
  };
}
