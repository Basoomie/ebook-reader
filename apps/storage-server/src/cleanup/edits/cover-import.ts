/**
 * Book covers: the one-time import of the earlier covers the apply sidecar kept in its
 * quarantine (`<quarantine>/<batch>/<calibre id>/old-cover.jpg`, named by field_undo's
 * old_cover_path) into the server's cover archive, so nothing about covers needs the quarantine
 * afterwards (docs/design/book-covers.md, part 1 step 4).
 *
 * Only the sidecar can read the quarantine (the storage server doesn't mount it), so the
 * sidecar's one-shot program `import-covers.js` asks the server for the list and sends each
 * picture with its SHA-256; the server keeps it under the book's current identity (a book the
 * manga move re-keyed is followed to where it is now).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { movedFrom } from '../move/rekey';
import type { CoverArchive } from './cover-archive';

export interface QuarantineCover {
  changeId: number;
  calibreId: number;
  /** The path as the sidecar sees it (inside its quarantine folder). */
  path: string;
}

/** The cover writes whose earlier picture is in the quarantine and not yet in the archive. */
export function quarantineCovers(db: Database.Database): QuarantineCover[] {
  return (
    db
      .prepare(
        `SELECT f.change_id, f.calibre_id, f.old_cover_path FROM field_undo f
         WHERE f.field = 'cover' AND f.old_cover_path IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM cover_archive a WHERE a.change_id = f.change_id
                             AND a.source IN ('before', 'quarantine'))
         ORDER BY f.change_id`,
      )
      .all() as { change_id: number; calibre_id: number; old_cover_path: string }[]
  ).map((r) => ({ changeId: r.change_id, calibreId: r.calibre_id, path: r.old_cover_path }));
}

export class ImportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Keeps one quarantine picture (checked against the SHA-256 the sidecar read). */
export async function importQuarantineCover(
  db: Database.Database,
  archive: CoverArchive,
  changeId: number,
  bytes: Buffer,
  sha256: string | null,
  now = Date.now(),
): Promise<{ sha256: string }> {
  const row = db
    .prepare(
      `SELECT library_id, calibre_id, calibre_uuid FROM field_undo
       WHERE change_id = ? AND field = 'cover' AND old_cover_path IS NOT NULL LIMIT 1`,
    )
    .get(changeId) as { library_id: string; calibre_id: number; calibre_uuid: string } | undefined;
  if (!row) throw new ImportError(404, 'not_found', 'No cover write with an earlier picture');
  const got = createHash('sha256').update(bytes).digest('hex');
  if (!sha256 || got !== sha256)
    throw new ImportError(422, 'sha_mismatch', 'The picture arrived incomplete');
  // Follow the book to where it is now (manga part A re-keys a moved book's state).
  let book = { libraryId: row.library_id, uuid: row.calibre_uuid, calibreId: row.calibre_id };
  for (let i = 0; i < 10; i++) {
    const m = movedFrom(db, book.libraryId, book.uuid);
    if (!m) break;
    book = { libraryId: m.toLibraryId, uuid: m.toUuid, calibreId: m.toCalibreId };
  }
  try {
    const kept = await archive.keep(book, bytes, 'quarantine', changeId, now);
    return { sha256: kept };
  } catch (err) {
    throw new ImportError(422, 'not_kept', (err as Error).message);
  }
}
