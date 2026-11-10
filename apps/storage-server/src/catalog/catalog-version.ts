/**
 * A cheap "has the catalog changed?" check for the browse caches (WP7a, groups.ts).
 * Every server-side writer of catalog data (indexer ingest, library records, character
 * counts) calls noteCatalogWrite(); writes from other connections (the CLI) show up in
 * PRAGMA data_version. Sync writes don't count: group numbers don't depend on them.
 */
import type Database from 'better-sqlite3';

const versions = new WeakMap<Database.Database, number>();

export function noteCatalogWrite(db: Database.Database): void {
  versions.set(db, (versions.get(db) ?? 0) + 1);
}

/** Changes whenever catalog data may have changed (compare with ===). */
export function catalogVersion(db: Database.Database): string {
  const external = db.pragma('data_version', { simple: true }) as number;
  return `${versions.get(db) ?? 0}:${external}`;
}
