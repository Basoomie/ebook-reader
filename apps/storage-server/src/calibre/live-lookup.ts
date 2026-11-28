/**
 * Where a Calibre book's EPUB is right now, read from the library's live metadata.db
 * (read-only; by the Calibre id first, see live-book.ts). Used when the indexed path no longer exists: Calibre moves
 * a book's folder when its title or first author changes, and the reader's index only takes
 * that in on its next run, so the book stays readable in between.
 */
import path from 'path';
import { lookupLiveBook, lookupLiveBookSync } from './live-book';
import { METADATA_DB, resolveInside, statFile } from './source-fs';

/**
 * The EPUB's current path relative to the library folder, or null when it can't be found. Read
 * on the live lookup's thread (live-book.ts), by the Calibre id first when it is known.
 */
export async function currentCalibreEpub(
  libraryDir: string,
  calibreUuid: string,
  calibreId?: number | null,
): Promise<string | null> {
  let rel: string | null = null;
  try {
    const book = await lookupLiveBook(path.join(libraryDir, METADATA_DB), {
      uuid: calibreUuid,
      calibreId,
    });
    rel = book?.formats.get('EPUB') ?? null;
  } catch {
    return null;
  }
  if (!rel) return null;
  try {
    const file = resolveInside(libraryDir, rel);
    return (await statFile(file)) ? rel : null;
  } catch {
    // A path that would leave the library folder is never followed.
    return null;
  }
}

/**
 * A book's title sort as Calibre holds it now (read-only, by its Calibre id; null when it can't
 * be read). calibredb can't list the sort through the content server (its --template is
 * refused for remote libraries, calibre 9.18), so the user's edit of the sort is checked here.
 * Synchronous (the batch report's check is): give the Calibre id, so it is one indexed read.
 */
export function liveTitleSort(
  libraryDir: string,
  calibreUuid: string,
  calibreId?: number | null,
): string | null {
  try {
    // A short wait for Calibre's write lock (milliseconds), never a long block.
    const b = lookupLiveBookSync(
      path.join(libraryDir, METADATA_DB),
      { uuid: calibreUuid, calibreId },
      1000,
    );
    return b ? b.sort : null;
  } catch {
    return null;
  }
}
