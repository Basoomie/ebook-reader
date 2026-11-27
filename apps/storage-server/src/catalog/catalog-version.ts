/**
 * A cheap "has the catalog changed?" check for the browse caches (WP7a, groups.ts).
 * Every server-side writer of catalog data (indexer ingest, library records, character
 * counts) calls noteCatalogWrite(); writes from other connections (the CLI) show up in
 * PRAGMA data_version. Sync writes don't count: group numbers don't depend on them.
 *
 * Writers that change only a book's figures (store ratings, Natively levels, character counts)
 * call noteFiguresWrite() instead: catalogVersion moves (sorts and filters read the figures), the
 * book list's version doesn't (2026-11-26: every saved rating rebuilt 読書メーター's 5 s library
 * index and recounted the cleanup's present books, so the server stalled for seconds per answer).
 */
import type Database from 'better-sqlite3';

const versions = new WeakMap<Database.Database, number>();
const listVersions = new WeakMap<Database.Database, number>();

const bump = (m: WeakMap<Database.Database, number>, db: Database.Database) =>
  m.set(db, (m.get(db) ?? 0) + 1);

/** Books, their sources, names, series or identifiers changed. */
export function noteCatalogWrite(db: Database.Database): void {
  bump(versions, db);
  bump(listVersions, db);
}

/** Only figures of books changed (ratings, levels, character counts). */
export function noteFiguresWrite(db: Database.Database): void {
  bump(versions, db);
}

/** Changes whenever catalog data may have changed (compare with ===). */
export function catalogVersion(db: Database.Database): string {
  const external = db.pragma('data_version', { simple: true }) as number;
  return `${versions.get(db) ?? 0}:${external}`;
}

/**
 * Changes whenever the book list may have changed: books, sources, titles, authors, series,
 * identifiers (not their figures). Other connections' writes count, as in catalogVersion.
 */
export function bookListVersion(db: Database.Database): string {
  const external = db.pragma('data_version', { simple: true }) as number;
  return `${listVersions.get(db) ?? 0}:${external}`;
}
