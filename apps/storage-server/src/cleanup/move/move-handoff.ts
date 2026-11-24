/**
 * Manga part A, the reader's side of a move (ttsu.db). Decided with the user (2026-11-24): the
 * reader keeps the very same book. Its Calibre source row is re-bound to the new library's copy
 * (library, Calibre id and UUID), the way stage 1's Undo by re-add re-binds a restored copy
 * (handoff.ts rebindRestoredSource), so the reader book id and everything keyed by it (status,
 * collections, highlights, history, positions, audio links, counts, devices' copies) stays, and
 * no second book is made.
 *
 * The row's hashes and Calibre last_modified are cleared: the next index of the new library
 * rewrites the book's record and takes it as a book that appeared there, not as fields changed in
 * Calibre (ingest.ts: nothing becomes "yours"). The book's library moves with it at once, so the
 * Library shows it under the new library; reading finds the file through the new library's live
 * metadata.db until the index has run (calibre/live-lookup.ts).
 *
 * If the new library's index already made a row for the new copy (its ingest ran although the
 * batch holds it, e.g. after a lost lease), the two rows swap reader books instead (stage 1's
 * swap, across libraries): the data-holding reader book takes the new copy's row; the empty one
 * stays with the old row and goes missing.
 *
 * The caller holds the ingest of both libraries while the batch is claimed.
 */
import type Database from 'better-sqlite3';
import { noteCatalogWrite } from '../../catalog/catalog-version';
import { findCalibreSource } from '../handoff';

export interface MoveTarget {
  libraryId: string;
  calibreId: number;
  uuid: string;
}

export interface MoveHandoff {
  kind: 'rebound' | 'swapped' | 'no-source';
  /** The Calibre source row that moved (rebound) or that held the data before the swap. */
  sourceId?: string;
  /** The reader book with the user's data (it stays the same book). */
  bookId?: string;
  /** swapped: the new library's own row and its empty reader book. */
  otherSourceId?: string;
  otherBookId?: string;
  /** Where the source pointed before (library, Calibre id, UUID). */
  before?: MoveTarget;
}

function clearAndPoint(db: Database.Database, sourceId: string, to: MoveTarget, now: number) {
  db.prepare(
    `UPDATE book_sources SET library_id = ?, calibre_uuid = ?, calibre_id = ?, meta_hash = NULL,
       meta2_hash = NULL, calibre_last_modified = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(to.libraryId, to.uuid, to.calibreId, now, sourceId);
}

function setBookLibrary(db: Database.Database, bookId: string, libraryId: string, now: number) {
  db.prepare('UPDATE books SET library_id = ?, updated_at = ? WHERE id = ?').run(
    libraryId,
    now,
    bookId,
  );
}

function swapBooks(
  db: Database.Database,
  a: { sourceId: string; bookId: string },
  b: { sourceId: string; bookId: string },
  now: number,
) {
  const set = db.prepare(
    'UPDATE book_sources SET book_id = ?, meta_hash = NULL, meta2_hash = NULL, updated_at = ? WHERE id = ?',
  );
  set.run(b.bookId, now, a.sourceId);
  set.run(a.bookId, now, b.sourceId);
}

/**
 * Points the moved book's reader source at its new copy. Idempotent: a repeated call finds the
 * row already pointing there (or the earlier swap) and changes nothing.
 */
export function moveReaderSource(
  db: Database.Database,
  from: MoveTarget,
  to: MoveTarget,
  previous: MoveHandoff | null,
  now = Date.now(),
): MoveHandoff {
  if (previous && previous.kind !== 'no-source') return previous;
  return db.transaction((): MoveHandoff => {
    const src = findCalibreSource(db, from.libraryId, from.uuid);
    const there = findCalibreSource(db, to.libraryId, to.uuid);
    if (!src) {
      // Already re-bound on an earlier attempt whose answer was lost.
      return there
        ? { kind: 'rebound', sourceId: there.sourceId, bookId: there.bookId }
        : { kind: 'no-source' };
    }
    const before = { ...from };
    if (!there) {
      clearAndPoint(db, src.sourceId, to, now);
      setBookLibrary(db, src.bookId, to.libraryId, now);
      noteCatalogWrite(db);
      return { kind: 'rebound', sourceId: src.sourceId, bookId: src.bookId, before };
    }
    swapBooks(db, src, there, now);
    setBookLibrary(db, src.bookId, to.libraryId, now);
    setBookLibrary(db, there.bookId, from.libraryId, now);
    noteCatalogWrite(db);
    return {
      kind: 'swapped',
      sourceId: src.sourceId,
      bookId: src.bookId,
      otherSourceId: there.sourceId,
      otherBookId: there.bookId,
      before,
    };
  })();
}

/**
 * Undo of a move: the reader book goes back to the copy restored in the old library (`back`: the
 * same UUID from Calibre's trash, or a new one when re-added from the quarantine). Must run before
 * the old library's index takes in the restored copy (the undo batch holds it). If that index
 * already made a row for it, the rows swap reader books as above.
 */
export function moveReaderSourceBack(
  db: Database.Database,
  handoff: MoveHandoff,
  movedTo: MoveTarget,
  back: MoveTarget,
  now = Date.now(),
): MoveHandoff {
  return db.transaction((): MoveHandoff => {
    const at = findCalibreSource(db, movedTo.libraryId, movedTo.uuid);
    const there = findCalibreSource(db, back.libraryId, back.uuid);
    // The book that holds the user's data: the moved row's book (also after a swap: the moved
    // copy's row got it).
    const dataBook = at?.bookId ?? handoff.bookId;
    if (!dataBook) return { kind: 'no-source' };
    if (there && there.bookId === dataBook)
      return { kind: 'rebound', sourceId: there.sourceId, bookId: dataBook };
    if (at && !there) {
      clearAndPoint(db, at.sourceId, back, now);
      setBookLibrary(db, at.bookId, back.libraryId, now);
      noteCatalogWrite(db);
      return { kind: 'rebound', sourceId: at.sourceId, bookId: at.bookId, before: movedTo };
    }
    if (at && there) {
      swapBooks(db, at, there, now);
      setBookLibrary(db, at.bookId, back.libraryId, now);
      setBookLibrary(db, there.bookId, movedTo.libraryId, now);
      noteCatalogWrite(db);
      return {
        kind: 'swapped',
        sourceId: at.sourceId,
        bookId: at.bookId,
        otherSourceId: there.sourceId,
        otherBookId: there.bookId,
        before: movedTo,
      };
    }
    // The moved row is gone (indexed away); the restored copy's row, if any, is left as it is.
    return { kind: 'no-source' };
  })();
}
