/**
 * Where a Calibre book's EPUB is right now, read from the library's live metadata.db
 * (read-only, one query by UUID). Used when the indexed path no longer exists: Calibre moves
 * a book's folder when its title or first author changes, and the reader's index only takes
 * that in on its next run, so the book stays readable in between.
 */
import path from 'path';
import { METADATA_DB, openSourceDatabase, resolveInside, statFile } from './source-fs';

/** The EPUB's current path relative to the library folder, or null when it can't be found. */
export async function currentCalibreEpub(
  libraryDir: string,
  calibreUuid: string,
): Promise<string | null> {
  let row: { path: string; name: string } | undefined;
  try {
    const db = openSourceDatabase(path.join(libraryDir, METADATA_DB));
    try {
      // Calibre holds its write lock for milliseconds; wait for it rather than fail.
      db.pragma('busy_timeout = 3000');
      row = db
        .prepare(
          `SELECT b.path AS path, d.name AS name FROM books b
             JOIN data d ON d.book = b.id AND d.format = 'EPUB'
            WHERE b.uuid = ? LIMIT 1`,
        )
        .get(calibreUuid) as { path: string; name: string } | undefined;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  if (!row) return null;
  const rel = `${row.path}/${row.name}.epub`;
  try {
    const file = resolveInside(libraryDir, rel);
    return (await statFile(file)) ? rel : null;
  } catch {
    // A path that would leave the library folder is never followed.
    return null;
  }
}

/**
 * A book's title sort as Calibre holds it now (read-only, one query by UUID; null when it can't
 * be read). calibredb can't list the sort through the content server (its --template is
 * refused for remote libraries, calibre 9.18), so the user's edit of the sort is checked here.
 */
export function liveTitleSort(libraryDir: string, calibreUuid: string): string | null {
  try {
    const db = openSourceDatabase(path.join(libraryDir, METADATA_DB));
    try {
      // A short wait for Calibre's write lock (milliseconds), never a long block.
      db.pragma('busy_timeout = 1000');
      const r = db.prepare('SELECT sort FROM books WHERE uuid = ?').get(calibreUuid) as
        | { sort: string | null }
        | undefined;
      return r ? (r.sort ?? '') : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
