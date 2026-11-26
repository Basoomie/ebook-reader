/**
 * Next in your series (docs/design/next-in-series.md): for each series within one library,
 * the first volume after the furthest one you finished that you haven't started. Worked out
 * live in SQL (nothing stored), for `status:next` (search-sql.ts) and the Home row
 * (GET /next-in-series). The web app's offline Library runs the same rule in TypeScript
 * (apps/web/src/lib/library/next-in-series.ts); both pass tests/fixtures/next-in-series.json.
 *
 * - Finished: status Completed or any finished read-through (a reread keeps it finished).
 *   Books missing from Calibre or in a disabled library still count as finished.
 * - Furthest finished: the highest series_index among them (books without one don't count).
 * - Next: the lowest series_index above it among the books the library shows (enabled
 *   library, not missing); omnibus volumes (N.9) never, bonus books (N.1) only with the
 *   setting `nextInSeriesBonus`. Two books on one number: the one added first. The series
 *   is left out when a book on that number was started (any status but Unread), and when
 *   you hid it (`series-next-hide` records, matched by library and series name).
 * - `nextInSeriesOn` off: nothing.
 * - Order: the series whose volume you finished last first, by the finished read-throughs'
 *   finishedOn only (the day the Completed collection sorts by, and the web's rule), then by
 *   book id; a series with no such day last. Never when a record was saved: a bulk import
 *   saves every completion at once (2026-11-25, the row came out in save order).
 */
import type Database from 'better-sqlite3';
import { SQL_CATALOG_SOURCE } from './queries';

export const SERIES_NEXT_HIDE_KIND = 'series-next-hide';

/** A synced global boolean in SQL, as the web reads it (`!!+value`); `fallback` without one. */
function settingSql(key: string, fallback: boolean): string {
  return `COALESCE((SELECT CAST(json_extract(st.data, '$.value') AS INTEGER) FROM sync_records st
           WHERE st.user_id = ? AND st.kind = 'setting' AND st.id = 'global:${key}'
             AND st.deleted_at IS NULL), ${fallback ? 1 : 0}) <> 0`;
}

/**
 * The rule as one SELECT of (id, at) rows: the next volumes and when their series' last
 * finished volume was finished (ms). Parameters: the user id, six times.
 */
export function nextInSeriesSelect(userId: string): { sql: string; params: unknown[] } {
  // Fraction of the number: CAST truncates, as Math.trunc in the web's rule.
  const frac = 'ROUND(c.series_index - CAST(c.series_index AS INTEGER), 3)';
  const sql = `
    WITH fin_books AS (
      SELECT r.id AS book_id, 0 AS at FROM sync_records r
       WHERE r.user_id = ? AND r.kind = 'book-status' AND r.deleted_at IS NULL
         AND json_extract(r.data, '$.status') = 'completed'
      UNION ALL
      SELECT r.book_id,
             IFNULL(CAST(strftime('%s', json_extract(r.data, '$.finishedOn')) AS INTEGER) * 1000, 0)
        FROM sync_records r
       WHERE r.user_id = ? AND r.kind = 'read-through' AND r.deleted_at IS NULL
         AND json_extract(r.data, '$.finished') = 1
    ),
    fin AS (
      SELECT fb.library_id AS lib, fb.series_id AS sid, MAX(fb.series_index) AS top, MAX(f.at) AS at
        FROM fin_books f JOIN books fb ON fb.id = f.book_id
       WHERE fb.series_id IS NOT NULL AND fb.series_index IS NOT NULL
       GROUP BY fb.library_id, fb.series_id
    ),
    cand AS (
      SELECT c.id, c.added_at, fin.lib, fin.sid, fin.at, c.series_index AS idx,
             MIN(c.series_index) OVER (PARTITION BY fin.lib, fin.sid) AS first_idx
        FROM fin
        JOIN books c ON c.series_id = fin.sid AND c.library_id = fin.lib AND c.series_index > fin.top
        JOIN book_sources s ON s.book_id = c.id AND ${SQL_CATALOG_SOURCE} AND s.missing_at IS NULL
        JOIN libraries l ON l.id = c.library_id AND l.enabled = 1
       WHERE ${frac} <> 0.9 AND (${frac} <> 0.1 OR ${settingSql('nextInSeriesBonus', false)})
    ),
    firsts AS (
      SELECT cand.*,
             ROW_NUMBER() OVER (PARTITION BY lib, sid ORDER BY added_at, id) AS rn,
             MAX(cand.id IN (SELECT r.id FROM sync_records r
                              WHERE r.user_id = ? AND r.kind = 'book-status' AND r.deleted_at IS NULL
                                AND json_extract(r.data, '$.status') <> 'unread'))
               OVER (PARTITION BY lib, sid) AS started
        FROM cand WHERE idx = first_idx
    )
    SELECT f.id, f.at FROM firsts f JOIN series se ON se.id = f.sid
     WHERE f.rn = 1 AND f.started = 0
       AND ${settingSql('nextInSeriesOn', true)}
       AND NOT EXISTS (SELECT 1 FROM sync_records h
                        WHERE h.user_id = ? AND h.kind = '${SERIES_NEXT_HIDE_KIND}' AND h.deleted_at IS NULL
                          AND json_extract(h.data, '$.library') = f.lib
                          AND json_extract(h.data, '$.name') = se.name)`;
  // fin_books x2, bonus setting, started, on setting, hidden.
  return { sql, params: [userId, userId, userId, userId, userId, userId] };
}

/** The next volumes' ids in the Home row's order. */
export function nextInSeriesIds(db: Database.Database, userId: string): string[] {
  const { sql, params } = nextInSeriesSelect(userId);
  const rows = db.prepare(`SELECT id FROM (${sql}) ORDER BY at DESC, id`).all(...params) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}
