/**
 * Manga part A: what the cleanup knows about a book follows it to its new library. A moved book
 * gets a new Calibre id and UUID (calibredb add makes a new record), and almost every cleanup
 * table keys a book by (reader library, Calibre UUID). This module points the live state at the
 * new identity in one cleanup.db transaction, and back again on Undo.
 *
 * Re-keyed (state that steers later work, so it must stay true of the book):
 * - every proposal of the book except the removal/move records themselves (field 'book'):
 *   open and review items point at the right book, and the never-again rules (a field written,
 *   kept or undone is never proposed again) still see what was done;
 * - applied_values (which value the cleanup wrote), user_fields (your fields stay yours),
 *   calibre_marks, evidence_records, stage4_books, stage4_series_order, calibre_title_fits,
 *   calibre_seen_changes, the More Bookmeter pass's rows, the More direct links pass's picks and spot check;
 * - the AI layer's items, requests, values and designs of the Calibre stages (item key
 *   "<library>:<uuid>"), so no answer is asked or paid for again and your values still win.
 *
 * Copied (kept for both libraries): series_pair_decisions of the book's series names.
 *
 * Kept as history under the old identity (found through calibre_moves): batches, batch_items,
 * field_undo, undo_records, the move/removal proposals, file_facts / text_facts / content_pairs /
 * pair_decisions (caches and stage 3's history: duplicates across libraries are part B),
 * calibre_arrival_* (the arrivals' own records) and audio_ebook_* (manga never pair).
 */
import type Database from 'better-sqlite3';

export interface BookIdentity {
  libraryId: string;
  calibreId: number;
  uuid: string;
}

/** The AI layer's stages whose item key is "<reader library>:<Calibre UUID>". */
export const CALIBRE_AI_STAGES = ['calibre4', 'calibre5', 'bookmeter-near', 'bookmeter-near2'];

/** Tables keyed by (library_id, calibre_uuid) with a calibre_id column too. */
const WITH_ID = [
  'stage4_books',
  'stage4_series_order',
  'calibre_title_fits',
  'calibre_seen_changes',
  'bookmeter_more_books',
  // More direct links (stage4/link-discovery.ts, cleanup.db v33): the picks per book and site.
  'link_discovery_picks',
];
/** Tables keyed by (library_id, calibre_uuid) without a calibre_id. */
const WITHOUT_ID = [
  'applied_values',
  'user_fields',
  'calibre_marks',
  'evidence_records',
  'bookmeter_more_waiters',
  'bookmeter_more_spot',
  'link_discovery_spot',
];

/**
 * Points the book's cleanup state at its new identity. Returns the rows changed per table.
 * Runs inside the caller's transaction when there is one (better-sqlite3 nests savepoints).
 */
export function rekeyCleanupState(
  db: Database.Database,
  from: BookIdentity,
  to: BookIdentity,
  seriesNames: string[] = [],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (name: string, n: number) => {
    if (n > 0) counts[name] = (counts[name] ?? 0) + n;
  };
  db.transaction(() => {
    add(
      'proposed_changes',
      db
        .prepare(
          `UPDATE proposed_changes SET library_id = ?, calibre_uuid = ?, calibre_id = ?
           WHERE library_id = ? AND calibre_uuid = ? AND field <> 'book'`,
        )
        .run(to.libraryId, to.uuid, to.calibreId, from.libraryId, from.uuid).changes,
    );
    for (const table of WITH_ID)
      add(
        table,
        db
          .prepare(
            `UPDATE ${table} SET library_id = ?, calibre_uuid = ?, calibre_id = ?
             WHERE library_id = ? AND calibre_uuid = ?`,
          )
          .run(to.libraryId, to.uuid, to.calibreId, from.libraryId, from.uuid).changes,
      );
    for (const table of WITHOUT_ID)
      add(
        table,
        db
          .prepare(
            `UPDATE ${table} SET library_id = ?, calibre_uuid = ?
             WHERE library_id = ? AND calibre_uuid = ?`,
          )
          .run(to.libraryId, to.uuid, from.libraryId, from.uuid).changes,
      );
    const oldKey = `${from.libraryId}:${from.uuid}`;
    const newKey = `${to.libraryId}:${to.uuid}`;
    const stages = CALIBRE_AI_STAGES.map(() => '?').join(',');
    for (const table of ['ai_items', 'ai_requests', 'ai_values', 'ai_item_designs'])
      add(
        table,
        db
          .prepare(`UPDATE ${table} SET item_key = ? WHERE stage IN (${stages}) AND item_key = ?`)
          .run(newKey, ...CALIBRE_AI_STAGES, oldKey).changes,
      );
    const names = [...new Set(seriesNames.filter((n) => n.trim() !== ''))];
    if (names.length > 0) {
      const inList = names.map(() => '?').join(',');
      add(
        'series_pair_decisions',
        db
          .prepare(
            `INSERT OR IGNORE INTO series_pair_decisions
               (library_id, name_a, name_b, decision, decided_at, decided_by, note)
             SELECT ?, name_a, name_b, decision, decided_at, decided_by, note
             FROM series_pair_decisions
             WHERE library_id = ? AND (name_a IN (${inList}) OR name_b IN (${inList}))`,
          )
          .run(to.libraryId, from.libraryId, ...names, ...names).changes,
      );
    }
  })();
  return counts;
}

/** The newest move of a book by its identity before the move (null when it never moved). */
export function movedFrom(
  db: Database.Database,
  libraryId: string,
  uuid: string,
): { toLibraryId: string; toCalibreId: number; toUuid: string; movedAt: number } | null {
  const r = db
    .prepare(
      `SELECT to_library_id, to_calibre_id, to_uuid, moved_at FROM calibre_moves
       WHERE from_library_id = ? AND from_uuid = ? AND state = 'moved'
       ORDER BY moved_at DESC LIMIT 1`,
    )
    .get(libraryId, uuid) as
    | { to_library_id: string; to_calibre_id: number; to_uuid: string; moved_at: number }
    | undefined;
  return r
    ? {
        toLibraryId: r.to_library_id,
        toCalibreId: r.to_calibre_id,
        toUuid: r.to_uuid,
        movedAt: r.moved_at,
      }
    : null;
}

/**
 * Every identity a book had before it came to (libraryId, uuid) by moves (newest first): the
 * book page's history looks these up too.
 */
export function earlierIdentities(
  db: Database.Database,
  libraryId: string,
  uuid: string,
): BookIdentity[] {
  const out: BookIdentity[] = [];
  const seen = new Set<string>([`${libraryId}:${uuid}`]);
  let cur = { libraryId, uuid };
  for (let i = 0; i < 20; i++) {
    const r = db
      .prepare(
        `SELECT from_library_id, from_calibre_id, from_uuid FROM calibre_moves
         WHERE to_library_id = ? AND to_uuid = ? AND state = 'moved'
         ORDER BY moved_at DESC LIMIT 1`,
      )
      .get(cur.libraryId, cur.uuid) as
      | { from_library_id: string; from_calibre_id: number; from_uuid: string }
      | undefined;
    if (!r) break;
    const key = `${r.from_library_id}:${r.from_uuid}`;
    if (seen.has(key)) break;
    seen.add(key);
    out.push({ libraryId: r.from_library_id, calibreId: r.from_calibre_id, uuid: r.from_uuid });
    cur = { libraryId: r.from_library_id, uuid: r.from_uuid };
  }
  return out;
}
