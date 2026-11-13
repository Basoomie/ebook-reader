/**
 * The reader's side of a removal (WP20a, "merged into" handoff), in ttsu.db.
 *
 * Every user-data record's id contains the reader book id (position <book>:<device>,
 * stat-session <book>:<device>:<uuid>, read-through <book>:<n>, highlight <book>:<uuid>, ...)
 * and stat-day/position records must never be rewritten (CLAUDE.md). So no record is moved.
 * Instead, when the removed Calibre copy B has reader data and the kept copy A has none,
 * the two Calibre sources swap reader books: the reader book holding the data now points
 * at A's Calibre record, and A's empty reader book takes B's identity (and goes missing
 * when the indexer sees B gone). Nothing else changes: stats, positions, read-throughs,
 * highlights, collections, audio links, attachments and Anki /open links stay valid, and
 * devices keep their local copy (the files are byte-identical).
 *
 * When both copies have reader data (decided with the user 2026-11-13): no swap, no merge;
 * each reader book keeps its own data and the removed one shows "No longer in the library".
 *
 * Undo reverses the swap; when Calibre gave the restored copy a new UUID (re-added from the
 * quarantine), the removed copy's source row is re-bound to it first so the reader book
 * keeps its id.
 */
import type Database from 'better-sqlite3';
import { noteCatalogWrite } from '../catalog/catalog-version';

export interface SourceRef {
  sourceId: string;
  bookId: string;
  missingAt: number | null;
}

export interface Handoff {
  /** What happened on the reader side. */
  kind: 'none' | 'swapped' | 'both-have-data' | 'no-source';
  /** The reader book that holds the user's data after the handoff (when swapped). */
  dataBookId?: string;
  /** A's former reader book, now holding B's Calibre identity (when swapped). */
  emptyBookId?: string;
  keptSourceId?: string;
  removedSourceId?: string;
  removedHadData?: boolean;
  keptHadData?: boolean;
}

export function findCalibreSource(
  db: Database.Database,
  libraryId: string,
  calibreUuid: string,
): SourceRef | null {
  const row = db
    .prepare(
      `SELECT id, book_id, missing_at FROM book_sources
       WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ?`,
    )
    .get(libraryId, calibreUuid) as
    | { id: string; book_id: string; missing_at: number | null }
    | undefined;
  return row ? { sourceId: row.id, bookId: row.book_id, missingAt: row.missing_at } : null;
}

/**
 * The reader books (of `bookIds`) that carry any user data: a live synced record (any user,
 * any kind with a book), a device that holds the book ("On this device"), an audiobook link,
 * a whispersync attachment, an old-sync migration link, or an active audio job.
 */
export function booksWithReaderData(db: Database.Database, bookIds: string[]): Set<string> {
  const ids = [...new Set(bookIds)];
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const wanted = new Set(ids);
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const inList = chunk.map(() => '?').join(',');
    const queries = [
      `SELECT DISTINCT book_id AS id FROM sync_records WHERE book_id IN (${inList}) AND deleted_at IS NULL`,
      `SELECT DISTINCT book_id AS id FROM audio_links WHERE book_id IN (${inList})`,
      `SELECT DISTINCT book_id AS id FROM book_attachments WHERE book_id IN (${inList})`,
      `SELECT DISTINCT book_id AS id FROM legacy_books WHERE book_id IN (${inList})`,
      `SELECT DISTINCT book_id AS id FROM worker_jobs WHERE book_id IN (${inList}) AND state IN ('queued', 'running')`,
      `SELECT DISTINCT book_id AS id FROM audio_merge_jobs WHERE book_id IN (${inList}) AND state IN ('queued', 'running', 'saving')`,
    ];
    for (const sql of queries) {
      for (const r of db.prepare(sql).all(...chunk) as { id: string }[]) out.add(r.id);
    }
  }
  // "On this device": device-books records list book ids in their data.
  const deviceBooks = db
    .prepare(`SELECT data FROM sync_records WHERE kind = 'device-books' AND deleted_at IS NULL`)
    .all() as { data: string }[];
  for (const r of deviceBooks) {
    try {
      const list = (JSON.parse(r.data) as { bookIds?: unknown }).bookIds;
      if (Array.isArray(list)) {
        for (const id of list) if (typeof id === 'string' && wanted.has(id)) out.add(id);
      }
    } catch {
      // A malformed record never blocks the cleanup.
    }
  }
  return out;
}

function swapSources(
  db: Database.Database,
  a: string,
  aBook: string,
  b: string,
  bBook: string,
  now: number,
) {
  const set = db.prepare(
    'UPDATE book_sources SET book_id = ?, meta_hash = NULL, updated_at = ? WHERE id = ?',
  );
  set.run(bBook, now, a);
  set.run(aBook, now, b);
}

/**
 * Runs after the sidecar removed copy B (kept copy A). One transaction; idempotent: a
 * repeated call with the same sources finds them already swapped and changes nothing.
 * `previous` is the handoff recorded on an earlier attempt (if any).
 */
export function applyHandoff(
  db: Database.Database,
  libraryId: string,
  keptUuid: string,
  removedUuid: string,
  previous: Handoff | null,
  now = Date.now(),
): Handoff {
  if (previous && previous.kind !== 'no-source') return previous;
  return db.transaction((): Handoff => {
    const kept = findCalibreSource(db, libraryId, keptUuid);
    const removed = findCalibreSource(db, libraryId, removedUuid);
    if (!kept || !removed) return { kind: 'no-source' };
    const withData = booksWithReaderData(db, [kept.bookId, removed.bookId]);
    const removedHadData = withData.has(removed.bookId);
    const keptHadData = withData.has(kept.bookId);
    const base = {
      keptSourceId: kept.sourceId,
      removedSourceId: removed.sourceId,
      removedHadData,
      keptHadData,
    };
    if (!removedHadData) return { kind: 'none', ...base };
    if (keptHadData) return { kind: 'both-have-data', ...base };
    swapSources(db, kept.sourceId, kept.bookId, removed.sourceId, removed.bookId, now);
    noteCatalogWrite(db);
    return {
      kind: 'swapped',
      ...base,
      dataBookId: removed.bookId,
      emptyBookId: kept.bookId,
    };
  })();
}

export type RebindResult = 'rebound' | 'same-uuid' | 'conflict' | 'no-source';

/**
 * Undo, re-added from the quarantine: Calibre gave the restored copy a new id and UUID.
 * The removed copy's source row takes them, so the next ingest finds the book under its
 * old reader id (data and links unchanged). Must run before the indexer ingests the
 * re-added book (the server holds ingest while an undo batch runs); if the indexer already
 * made a row for the new UUID, nothing is changed ('conflict').
 */
export function rebindRestoredSource(
  db: Database.Database,
  removedSourceId: string,
  newUuid: string,
  newCalibreId: number,
  now = Date.now(),
): RebindResult {
  return db.transaction((): RebindResult => {
    const row = db
      .prepare('SELECT library_id, calibre_uuid FROM book_sources WHERE id = ?')
      .get(removedSourceId) as { library_id: string; calibre_uuid: string } | undefined;
    if (!row) return 'no-source';
    if (row.calibre_uuid === newUuid) return 'same-uuid';
    if (findCalibreSource(db, row.library_id, newUuid)) return 'conflict';
    db.prepare(
      `UPDATE book_sources SET calibre_uuid = ?, calibre_id = ?, meta_hash = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(newUuid, newCalibreId, now, removedSourceId);
    noteCatalogWrite(db);
    return 'rebound';
  })();
}

/** Undo of a swap: each Calibre source gets its original reader book back. Idempotent. */
export function reverseHandoff(db: Database.Database, handoff: Handoff, now = Date.now()): boolean {
  if (handoff.kind !== 'swapped') return false;
  const { keptSourceId, removedSourceId, dataBookId, emptyBookId } = handoff;
  if (!keptSourceId || !removedSourceId || !dataBookId || !emptyBookId) return false;
  return db.transaction(() => {
    const get = db.prepare('SELECT book_id FROM book_sources WHERE id = ?');
    const kept = get.get(keptSourceId) as { book_id: string } | undefined;
    const removed = get.get(removedSourceId) as { book_id: string } | undefined;
    if (!kept || !removed) return false;
    if (kept.book_id === emptyBookId && removed.book_id === dataBookId) return true; // already
    if (kept.book_id !== dataBookId || removed.book_id !== emptyBookId) return false;
    swapSources(db, keptSourceId, dataBookId, removedSourceId, emptyBookId, now);
    noteCatalogWrite(db);
    return true;
  })();
}

/** Present (not missing) Calibre books of a library, for the batch size cap. */
export function presentBookCount(db: Database.Database, libraryId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM book_sources
         WHERE library_id = ? AND kind = 'calibre' AND missing_at IS NULL`,
      )
      .get(libraryId) as { n: number }
  ).n;
}
