/**
 * Library search folding (fix-search-width-folding): the form both a search term and the
 * stored names are compared in. NFKC on the whole string, then lower case, so full-width
 * and half-width letters and digits match alike (ＧＪ = GJ = gj, ２０ = 20), half-width
 * kana match full-width kana, and a kana stored with a separate voiced mark (て + ゛) matches
 * the composed one (で). Hiragana and katakana stay distinct; whitespace is not removed
 * (a full-width space becomes a normal one).
 *
 * The folded copies live only in the reader's own database: books.title_fold and
 * authors/series/tags.name_fold, written by the catalog writers and filled by
 * fillSearchFolds() when a database is opened. Displayed text never uses them.
 * /regex/ patterns run on the original text.
 */
import type Database from 'better-sqlite3';

export function foldForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** Each searchable text column and its folded copy. */
export const FOLDED_COLUMNS = [
  { table: 'books', column: 'title', fold: 'title_fold' },
  { table: 'authors', column: 'name', fold: 'name_fold' },
  { table: 'series', column: 'name', fold: 'name_fold' },
  { table: 'tags', column: 'name', fold: 'name_fold' },
] as const;

/**
 * Fills every missing folded copy (the backfill after migration 16, and any row written
 * without one, e.g. by hand). Returns how many rows were filled. On an up-to-date database
 * it only reads.
 */
export function fillSearchFolds(db: Database.Database): number {
  let filled = 0;
  db.transaction(() => {
    for (const { table, column, fold } of FOLDED_COLUMNS) {
      const rows = db
        .prepare(`SELECT rowid AS r, ${column} AS v FROM ${table} WHERE ${fold} IS NULL`)
        .raw()
        .all() as [number, string][];
      if (rows.length === 0) continue;
      const set = db.prepare(`UPDATE ${table} SET ${fold} = ? WHERE rowid = ?`);
      for (const [r, v] of rows) set.run(foldForSearch(v), r);
      filled += rows.length;
    }
  })();
  return filled;
}
