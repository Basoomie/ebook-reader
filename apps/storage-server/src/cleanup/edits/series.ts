/**
 * The series editor (design: "Edit series" on the series page, "Edit the whole series" from the
 * book form): rename the series for all its books, each volume's title and number (decimals:
 * 3.5 a side story, 3.1 a store bonus), confirm unconfirmed numbers, and merge the cleanup's
 * suggested series name pair.
 *
 * The pair is computed from the library as it is now with the rule of the stage-4 report
 * (wp20e-series-pairs.md; decided with the user 2026-11-23): one name, as stage 4 compares
 * spellings (seriesKey), is the start of the other; a pair that differs only by a trailing
 * シリーズ comes first. "Not the same series" is kept (series_pair_decisions) and that pair is
 * not suggested again; "Move them into this series" is a save of the other series' books.
 */
import type Database from 'better-sqlite3';
import { seriesKey } from '../stage4/series-spelling';

export interface SeriesPair {
  name: string;
  books: number;
  /** The two names differ only by a trailing シリーズ. */
  onlySeries: boolean;
}

/** The shorter name's key must be at least this long (a one-letter name starts too many). */
const MIN_KEY = 2;
const MAX_PAIRS = 8;

/** The suggested pairs of `name` among the library's series (pure). */
export function seriesPairsOf(
  name: string,
  all: { name: string; books: number }[],
  notSame: ReadonlySet<string>,
): SeriesPair[] {
  const key = seriesKey(name);
  if (key.length < MIN_KEY) return [];
  const out: SeriesPair[] = [];
  for (const s of all) {
    if (s.name === name || notSame.has(s.name)) continue;
    const k = seriesKey(s.name);
    if (k === key || k.length < MIN_KEY) continue;
    const [short, long] = k.length < key.length ? [k, key] : [key, k];
    if (!long.startsWith(short)) continue;
    out.push({ name: s.name, books: s.books, onlySeries: long === `${short}シリーズ` });
  }
  out.sort(
    (a, b) =>
      Number(b.onlySeries) - Number(a.onlySeries) ||
      b.books - a.books ||
      (a.name < b.name ? -1 : 1),
  );
  return out.slice(0, MAX_PAIRS);
}

/** The library's series with their present books (one query; 8,909 series on the NAS). */
export function librarySeries(
  main: Database.Database,
  libraryId: string,
): { name: string; books: number }[] {
  return main
    .prepare(
      `SELECT se.name, COUNT(*) AS books FROM series se JOIN books b ON b.series_id = se.id
       JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre' AND s.missing_at IS NULL
       WHERE s.library_id = ? GROUP BY se.id`,
    )
    .all(libraryId) as { name: string; books: number }[];
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** The names the user said are not the same series as `name`. */
export function notSameAs(
  cleanup: Database.Database,
  libraryId: string,
  name: string,
): Set<string> {
  const rows = cleanup
    .prepare(
      `SELECT name_a, name_b FROM series_pair_decisions
       WHERE library_id = ? AND decision = 'different' AND (name_a = ? OR name_b = ?)`,
    )
    .all(libraryId, name, name) as { name_a: string; name_b: string }[];
  return new Set(rows.map((r) => (r.name_a === name ? r.name_b : r.name_a)));
}

export function decidePair(
  cleanup: Database.Database,
  libraryId: string,
  a: string,
  b: string,
  decision: 'different' | 'merged',
  now = Date.now(),
): void {
  const [x, y] = pairKey(a, b);
  cleanup
    .prepare(
      `INSERT INTO series_pair_decisions (library_id, name_a, name_b, decision, decided_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(library_id, name_a, name_b) DO UPDATE SET decision = excluded.decision,
         decided_at = excluded.decided_at`,
    )
    .run(libraryId, x, y, decision, now);
}
