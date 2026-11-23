/**
 * The list of shortened titles on /cleanup (decided with the user 2026-11-22): every title the
 * cleanup shortened or cut to fit Calibre's folder names (calibre_title_fits, cleanup.db v26),
 * with the original, the title written and the step, so you can correct them by hand in Calibre.
 * A later stage never overwrites your correction (a title changed in Calibre after the cleanup
 * wrote it goes to review; title-fit is never applied to it). Cleaned-only titles are not listed.
 */
import type Database from 'better-sqlite3';

export interface TitleFitRow {
  id: number;
  calibreId: number | null;
  /** 2, 4 or 5 (the stage whose change it is); 0: a new arrival's add. */
  stage: number;
  original: string;
  written: string;
  step: 'shortened' | 'cut';
  rules: string[];
  /** proposed | queued | applied | undone | skipped | kept, or the arrival's outcome. */
  state: string;
  /** Calibre's title now (the reader's index), when the book is in Calibre. */
  now: string | null;
}

export function listTitleFits(
  db: Database.Database,
  main: Database.Database | null,
  libraryId: string,
  offset: number,
  limit: number,
): { total: number; items: TitleFitRow[] } {
  const total = (
    db
      .prepare('SELECT COUNT(*) AS n FROM calibre_title_fits WHERE library_id = ?')
      .get(libraryId) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT f.id, f.stage, f.original, f.written, f.step, f.rules_json,
         COALESCE(f.calibre_id, a.calibre_id) AS calibre_id,
         COALESCE(f.calibre_uuid, a.calibre_uuid) AS calibre_uuid,
         COALESCE(p.state, a.outcome) AS state
       FROM calibre_title_fits f
       LEFT JOIN proposed_changes p ON p.id = f.change_id
       LEFT JOIN calibre_arrival_files a ON a.id = f.arrival_file_id
       WHERE f.library_id = ? ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    )
    .all(libraryId, limit, offset) as {
    id: number;
    stage: number;
    original: string;
    written: string;
    step: 'shortened' | 'cut';
    rules_json: string;
    calibre_id: number | null;
    calibre_uuid: string | null;
    state: string | null;
  }[];
  const titleNow = main?.prepare(
    `SELECT b.title FROM book_sources s JOIN books b ON b.id = s.book_id
     WHERE s.library_id = ? AND s.calibre_uuid = ? AND s.missing_at IS NULL`,
  );
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      calibreId: r.calibre_id,
      stage: r.stage,
      original: r.original,
      written: r.written,
      step: r.step,
      rules: JSON.parse(r.rules_json) as string[],
      state: r.state ?? 'proposed',
      now:
        r.calibre_uuid && titleNow
          ? ((titleNow.get(libraryId, r.calibre_uuid) as { title: string } | undefined)?.title ??
            null)
          : null,
    })),
  };
}
