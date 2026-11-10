/**
 * Character count records (WP3b): the char_counts table and the queries the API and
 * the CLI need. No counting happens here (see count-service).
 */
import type Database from 'better-sqlite3';
import { noteCatalogWrite } from '../catalog/catalog-version';
import type { CountErrorCode } from './count-worker';

export interface CountSource {
  bookId: string;
  /** 'upload' (WP7b): filePath is relative to DATA_DIR/.uploads. */
  kind: 'calibre' | 'upload';
  libraryFolder: string;
  /** EPUB path relative to the library folder, forward slashes. */
  filePath: string;
  fileSize: number | null;
  lastModified: number | null;
}

export function countSourceKey(src: Pick<CountSource, 'lastModified' | 'filePath' | 'fileSize'>) {
  return `${src.lastModified ?? ''}|${src.filePath}|${src.fileSize ?? ''}`;
}

/** Same as countSourceKey(), in SQL, over book_sources aliased as `s`. */
export const SQL_COUNT_SOURCE_KEY =
  "(COALESCE(s.calibre_last_modified, '') || '|' || s.file_path || '|' || COALESCE(s.file_size, ''))";

/**
 * A count row (`c`) that matches the book's current source (`s`) and the current
 * spec (named parameter @spec; NULL = any spec).
 */
export const SQL_CURRENT = `(c.book_id IS NOT NULL AND c.source_key = ${SQL_COUNT_SOURCE_KEY}
  AND (@spec IS NULL OR c.spec = @spec))`;

/** Position in the newest-first walk of the background pass. */
export interface PendingCursor {
  addedAt: number;
  bookId: string;
}

export type CountStatus = 'ok' | 'error';

export interface CountRecord {
  bookId: string;
  status: CountStatus;
  sourceKey: string;
  spec: string;
  characters: number | null;
  build: string | null;
  attempts: number;
  errorCode: CountErrorCode | null;
  error: string | null;
  durationMs: number | null;
  bytesRead: number | null;
  countedAt: number;
}

interface CountRow {
  book_id: string;
  status: CountStatus;
  source_key: string;
  spec: string;
  characters: number | null;
  build: string | null;
  attempts: number;
  error_code: CountErrorCode | null;
  error: string | null;
  duration_ms: number | null;
  bytes_read: number | null;
  counted_at: number;
}

export function getCountRecord(db: Database.Database, bookId: string): CountRecord | null {
  const r = db.prepare('SELECT * FROM char_counts WHERE book_id = ?').get(bookId) as
    | CountRow
    | undefined;
  if (!r) return null;
  return {
    bookId: r.book_id,
    status: r.status,
    sourceKey: r.source_key,
    spec: r.spec,
    characters: r.characters,
    build: r.build,
    attempts: r.attempts,
    errorCode: r.error_code,
    error: r.error,
    durationMs: r.duration_ms,
    bytesRead: r.bytes_read,
    countedAt: r.counted_at,
  };
}

export type CountScope =
  | { all: true }
  | { bookId: string }
  | { libraryId: string }
  /** Only books whose last count failed. */
  | { errors: true };

/**
 * Forgets counts so the background pass makes them again. books.char_count keeps
 * the old value until then (shown as pending).
 */
export function forgetCounts(db: Database.Database, scope: CountScope): number {
  noteCatalogWrite(db);
  if ('all' in scope) return db.prepare('DELETE FROM char_counts').run().changes;
  if ('errors' in scope) {
    return db.prepare("DELETE FROM char_counts WHERE status = 'error'").run().changes;
  }
  if ('bookId' in scope) {
    return db.prepare('DELETE FROM char_counts WHERE book_id = ?').run(scope.bookId).changes;
  }
  return db
    .prepare('DELETE FROM char_counts WHERE book_id IN (SELECT id FROM books WHERE library_id = ?)')
    .run(scope.libraryId).changes;
}

export interface CountTotals {
  counted: number;
  pending: number;
  errors: number;
}

/**
 * Per library: books (present in Calibre, or uploaded: WP7b) with a current count, waiting for one,
 * and whose count failed. `spec` null = any spec counts as current (the counter is
 * off or its bundle is unreadable).
 */
export function countTotalsByLibrary(
  db: Database.Database,
  spec: string | null,
): Map<string, CountTotals> {
  const rows = db
    .prepare(
      `SELECT b.library_id,
              SUM(CASE WHEN ${SQL_CURRENT} AND c.status = 'ok' THEN 1 ELSE 0 END) AS counted,
              SUM(CASE WHEN ${SQL_CURRENT} AND c.status = 'error' THEN 1 ELSE 0 END) AS errors,
              COUNT(*) AS total
         FROM books b
         JOIN book_sources s
           ON s.book_id = b.id AND s.kind IN ('calibre', 'upload') AND s.missing_at IS NULL
         LEFT JOIN char_counts c ON c.book_id = b.id
        GROUP BY b.library_id`,
    )
    .all({ spec }) as { library_id: string; counted: number; errors: number; total: number }[];
  return new Map(
    rows.map((r) => [
      r.library_id,
      { counted: r.counted, errors: r.errors, pending: r.total - r.counted - r.errors },
    ]),
  );
}

/** The most recent failures, for `cli counts status`. */
export function recentCountErrors(
  db: Database.Database,
  limit: number,
): { bookId: string; title: string; errorCode: string; error: string; countedAt: number }[] {
  return (
    db
      .prepare(
        `SELECT c.book_id, b.title, c.error_code, c.error, c.counted_at
           FROM char_counts c JOIN books b ON b.id = c.book_id
          WHERE c.status = 'error'
          ORDER BY c.counted_at DESC LIMIT ?`,
      )
      .all(limit) as {
      book_id: string;
      title: string;
      error_code: string;
      error: string;
      counted_at: number;
    }[]
  ).map((r) => ({
    bookId: r.book_id,
    title: r.title,
    errorCode: r.error_code,
    error: r.error,
    countedAt: r.counted_at,
  }));
}
