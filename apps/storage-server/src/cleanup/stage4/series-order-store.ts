/**
 * The series step's choices in cleanup.db (stage4_series_order, v22) and the Best guesses list
 * (series-order follow-up, 2026-11-22). Every book of a series has a row (src 'calibre' for books
 * stage 4 doesn't change), so the list shows each series whole, in order.
 */
import type Database from 'better-sqlite3';
import type { SeriesChoice } from './series-order';

export interface SeriesOrderRow {
  calibreUuid: string;
  calibreId: number;
  series: string;
  seriesKey: string;
  index: number | null;
  src: string;
  guess: boolean;
  reason: string | null;
  /** The title after On (this step's when titleSrc is set). */
  title: string | null;
  titleSrc: string | null;
  review: string | null;
}

export function clearSeriesOrder(db: Database.Database, libraryId: string): void {
  db.prepare('DELETE FROM stage4_series_order WHERE library_id = ?').run(libraryId);
}

export function writeSeriesOrder(
  db: Database.Database,
  libraryId: string,
  rows: SeriesOrderRow[],
  now = Date.now(),
): void {
  const ins = db.prepare(
    `INSERT INTO stage4_series_order (library_id, calibre_uuid, calibre_id, series, series_key, idx,
       src, guess, reason, title, title_src, review, run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, calibre_uuid) DO UPDATE SET calibre_id = excluded.calibre_id,
       series = excluded.series, series_key = excluded.series_key, idx = excluded.idx,
       src = excluded.src, guess = excluded.guess, reason = excluded.reason, title = excluded.title,
       title_src = excluded.title_src, review = excluded.review, run_at = excluded.run_at`,
  );
  db.transaction(() => {
    for (const r of rows)
      ins.run(
        libraryId,
        r.calibreUuid,
        r.calibreId,
        r.series,
        r.seriesKey,
        r.index,
        r.src,
        r.guess ? 1 : 0,
        r.reason,
        r.title,
        r.titleSrc,
        r.review,
        now,
      );
  })();
}

/** The step's choice for one book, or null (no row, or Calibre's own series). */
export function seriesChoiceOf(
  db: Database.Database,
  libraryId: string,
  uuid: string,
): SeriesChoice | null {
  const r = db
    .prepare(
      `SELECT idx, src, guess, reason, title, title_src, review FROM stage4_series_order
       WHERE library_id = ? AND calibre_uuid = ?`,
    )
    .get(libraryId, uuid) as
    | {
        idx: number | null;
        src: string;
        guess: number;
        reason: string | null;
        title: string | null;
        title_src: string | null;
        review: string | null;
      }
    | undefined;
  if (!r || r.src === 'calibre') return null;
  return {
    uuid,
    index: r.idx,
    from: r.src,
    guess: r.guess === 1,
    reason: r.reason,
    // The title column holds the title after On; title_src says whether this step changed it.
    ...(r.title !== null && r.title_src !== null ? { title: r.title, titleFrom: r.title_src } : {}),
    ...(r.review !== null ? { review: r.review } : {}),
  };
}

export interface GuessBook {
  calibreId: number;
  title: string;
  index: number | null;
  /** This book's number is a best guess (with why), or a problem for review. */
  guess: boolean;
  reason: string | null;
  review: string | null;
  from: string;
  /** Other fields of the book that are best guesses (the models' flagged values). */
  fields: { field: string; reason: string | null }[];
}
export interface GuessSeries {
  series: string;
  books: GuessBook[];
}

/** Series with a best guess or a review item, a page at a time, each whole and in order. */
export function listSeriesGuesses(
  db: Database.Database,
  libraryId: string,
  offset: number,
  limit: number,
): { total: number; series: GuessSeries[] } {
  const total = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT series_key) AS n FROM stage4_series_order INDEXED BY stage4_series_order_flagged
         WHERE library_id = ? AND (guess = 1 OR review IS NOT NULL)`,
      )
      .get(libraryId) as { n: number }
  ).n;
  const keys = (
    db
      .prepare(
        `SELECT DISTINCT series_key FROM stage4_series_order INDEXED BY stage4_series_order_flagged
         WHERE library_id = ? AND (guess = 1 OR review IS NOT NULL) ORDER BY series_key LIMIT ? OFFSET ?`,
      )
      .all(libraryId, limit, offset) as { series_key: string }[]
  ).map((r) => r.series_key);
  const rowsOf = db.prepare(
    `SELECT calibre_uuid, calibre_id, series, idx, src, guess, reason, title, review
     FROM stage4_series_order INDEXED BY stage4_series_order_series
     WHERE library_id = ? AND series_key = ? ORDER BY idx, calibre_id`,
  );
  const flaggedOf = db.prepare(
    `SELECT field, reason FROM ai_values INDEXED BY ai_values_flagged
     WHERE stage = 'calibre4' AND item_key = ? AND flagged = 1 AND field NOT IN ('ix')`,
  );
  const series: GuessSeries[] = [];
  for (const key of keys) {
    const rows = rowsOf.all(libraryId, key) as {
      calibre_uuid: string;
      calibre_id: number;
      series: string;
      idx: number | null;
      src: string;
      guess: number;
      reason: string | null;
      title: string | null;
      review: string | null;
    }[];
    if (!rows.length) continue;
    series.push({
      series: rows[0].series,
      books: rows.map((r) => {
        return {
          calibreId: r.calibre_id,
          title: r.title ?? '',
          index: r.idx,
          guess: r.guess === 1,
          reason: r.reason,
          review: r.review,
          from: r.src,
          fields: (
            flaggedOf.all(`${libraryId}:${r.calibre_uuid}`) as {
              field: string;
              reason: string | null;
            }[]
          ).map((f) => ({ field: f.field, reason: f.reason })),
        };
      }),
    });
  }
  return { total, series };
}

export interface GuessOther {
  calibreId: number;
  title: string;
  fields: { field: string; value: unknown; reason: string | null }[];
}

/**
 * Books outside every series with a best guess (the models' flagged values written at On), a
 * page at a time: their title, authors, illustrators or format the sources don't confirm.
 */
export function listOtherGuesses(
  db: Database.Database,
  libraryId: string,
  offset: number,
  limit: number,
): { total: number; books: GuessOther[] } {
  const base = `FROM ai_values v INDEXED BY ai_values_flagged
     WHERE v.stage = 'calibre4' AND v.flagged = 1 AND v.item_key >= ? AND v.item_key < ?
       AND v.field IN ('t', 'au', 'il', 'fmt')
       AND NOT EXISTS (SELECT 1 FROM stage4_series_order o
         WHERE o.library_id = ? AND o.calibre_uuid = substr(v.item_key, length(?) + 2))
       AND EXISTS (SELECT 1 FROM ai_values a WHERE a.stage = 'calibre4' AND a.item_key = v.item_key
         AND a.field = 'asked' AND a.value_json = 'true')`;
  const lo = `${libraryId}:`;
  const hi = `${libraryId};`;
  const total = (
    db
      .prepare(`SELECT COUNT(DISTINCT v.item_key) AS n ${base}`)
      .get(lo, hi, libraryId, libraryId) as {
      n: number;
    }
  ).n;
  const keys = (
    db
      .prepare(`SELECT DISTINCT v.item_key ${base} ORDER BY v.item_key LIMIT ? OFFSET ?`)
      .all(lo, hi, libraryId, libraryId, limit, offset) as { item_key: string }[]
  ).map((r) => r.item_key);
  const fieldsOf = db.prepare(
    `SELECT field, value_json, flagged, reason FROM ai_values WHERE stage = 'calibre4' AND item_key = ?`,
  );
  const idOf = db.prepare(
    'SELECT calibre_id FROM stage4_books WHERE library_id = ? AND calibre_uuid = ?',
  );
  const books: GuessOther[] = [];
  for (const k of keys) {
    const uuid = k.slice(libraryId.length + 1);
    const rows = fieldsOf.all(k) as {
      field: string;
      value_json: string | null;
      flagged: number;
      reason: string | null;
    }[];
    const t = rows.find((r) => r.field === 't');
    books.push({
      calibreId: (idOf.get(libraryId, uuid) as { calibre_id: number } | undefined)?.calibre_id ?? 0,
      title: t?.value_json ? (JSON.parse(t.value_json) as string) : '',
      fields: rows
        .filter((r) => r.flagged === 1 && ['t', 'au', 'il', 'fmt'].includes(r.field))
        .map((r) => ({
          field: r.field,
          value: r.value_json === null ? null : (JSON.parse(r.value_json) as unknown),
          reason: r.reason,
        })),
    });
  }
  return { total, books };
}
