/**
 * The series-arrival alert's rules (docs/design/series-arrivals.md section 2), read from
 * ttsu.db: the series you're reading and how one arrived book is decided. Read only.
 */
import type Database from 'better-sqlite3';
import { SERIES_NEXT_HIDE_KIND } from '../catalog/next-in-series';
import { SQL_CATALOG_SOURCE } from '../catalog/queries';

export interface ReadingSeries {
  libraryId: string;
  seriesId: number;
}

/**
 * The series (within one library) you're reading: a volume with status Reading or Completed,
 * or a finished read-through, and not Dropped (a Dropped volume never counts, so a series
 * whose started volumes are all Dropped is left out). Series hidden from Next in your series
 * (`series-next-hide`, by library and name) are left out.
 */
export function readingSeries(db: Database.Database, userId: string): ReadingSeries[] {
  const rows = db
    .prepare(
      `WITH st AS (
         SELECT r.id AS book_id, json_extract(r.data, '$.status') AS status FROM sync_records r
          WHERE r.user_id = ? AND r.kind = 'book-status' AND r.deleted_at IS NULL
       ),
       ev AS (
         SELECT book_id FROM st WHERE status IN ('reading', 'completed')
         UNION
         SELECT r.book_id FROM sync_records r
          WHERE r.user_id = ? AND r.kind = 'read-through' AND r.deleted_at IS NULL
            AND json_extract(r.data, '$.finished') = 1
            AND NOT EXISTS (SELECT 1 FROM st WHERE st.book_id = r.book_id AND st.status = 'dropped')
       )
       SELECT DISTINCT b.library_id AS libraryId, b.series_id AS seriesId
         FROM ev JOIN books b ON b.id = ev.book_id
         JOIN series se ON se.id = b.series_id
        WHERE NOT EXISTS (SELECT 1 FROM sync_records h
                           WHERE h.user_id = ? AND h.kind = '${SERIES_NEXT_HIDE_KIND}'
                             AND h.deleted_at IS NULL
                             AND json_extract(h.data, '$.library') = b.library_id
                             AND json_extract(h.data, '$.name') = se.name)`,
    )
    .all(userId, userId, userId) as ReadingSeries[];
  return rows;
}

/** A book that arrived while the alert was on and isn't decided yet. */
export interface PendingBook {
  id: string;
  title: string;
  libraryId: string;
  seriesId: number | null;
  seriesName: string | null;
  seriesIndex: number | null;
  createdAt: number;
  /** In the catalog: an enabled library and a source that isn't missing. */
  shown: number;
  /** Another book of this library, series and number was there before it (missing ones too). */
  copy: number;
  /** Its status, if it has one. */
  status: string | null;
  /** A finished read-through. */
  finished: number;
}

/** How many books created after `onSince` this user has no decision for yet. */
export function countPending(db: Database.Database, userId: string, onSince: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM books b WHERE b.created_at > ?
           AND NOT EXISTS (SELECT 1 FROM series_arrival_books d WHERE d.user_id = ? AND d.book_id = b.id)`,
      )
      .get(onSince, userId) as { n: number }
  ).n;
}

/**
 * The books created after `onSince` and before `before` (settled) that this user has no
 * decision for yet, oldest first.
 */
export function pendingBooks(
  db: Database.Database,
  userId: string,
  onSince: number,
  before: number,
): PendingBook[] {
  return db
    .prepare(
      `SELECT b.id, b.title, b.library_id AS libraryId, b.series_id AS seriesId,
              se.name AS seriesName, b.series_index AS seriesIndex, b.created_at AS createdAt,
              (EXISTS (SELECT 1 FROM book_sources s JOIN libraries l ON l.id = b.library_id
                        WHERE s.book_id = b.id AND ${SQL_CATALOG_SOURCE} AND s.missing_at IS NULL
                          AND l.enabled = 1)) AS shown,
              (b.series_id IS NOT NULL AND b.series_index IS NOT NULL AND EXISTS (
                 SELECT 1 FROM books c
                  WHERE c.series_id = b.series_id AND c.series_index = b.series_index
                    AND c.library_id = b.library_id AND c.id <> b.id
                    AND (c.created_at < b.created_at OR (c.created_at = b.created_at AND c.id < b.id))
               )) AS copy,
              (SELECT json_extract(r.data, '$.status') FROM sync_records r
                WHERE r.user_id = ? AND r.kind = 'book-status' AND r.id = b.id
                  AND r.deleted_at IS NULL) AS status,
              (EXISTS (SELECT 1 FROM sync_records r
                        WHERE r.user_id = ? AND r.kind = 'read-through' AND r.book_id = b.id
                          AND r.deleted_at IS NULL AND json_extract(r.data, '$.finished') = 1)) AS finished
         FROM books b LEFT JOIN series se ON se.id = b.series_id
        WHERE b.created_at > ? AND b.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM series_arrival_books d
                           WHERE d.user_id = ? AND d.book_id = b.id)
        ORDER BY b.created_at, b.id`,
    )
    .all(userId, userId, onSince, before, userId) as PendingBook[];
}

export type Decision =
  | 'told'
  | 'not_shown'
  | 'no_series'
  | 'not_reading'
  | 'before_series'
  | 'omnibus'
  | 'touched'
  | 'copy';

/** Fraction of a series number, as Next in your series reads it (N.9 omnibus, N.1 bonus). */
export function fraction(index: number): number {
  return Math.round((index - Math.trunc(index)) * 1000) / 1000;
}

/**
 * How a settled book is decided (section 2). `since` is when its series first counted as read
 * (undefined: the series isn't read).
 */
export function decide(b: PendingBook, since: number | undefined): Decision {
  if (!b.shown) return 'not_shown';
  if (b.seriesId === null) return 'no_series';
  if (since === undefined) return 'not_reading';
  if (b.createdAt <= since) return 'before_series';
  if (b.seriesIndex !== null && fraction(b.seriesIndex) === 0.9) return 'omnibus';
  if ((b.status && b.status !== 'unread') || b.finished) return 'touched';
  if (b.copy) return 'copy';
  return 'told';
}
