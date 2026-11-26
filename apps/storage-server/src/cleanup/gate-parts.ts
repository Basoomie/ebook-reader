/**
 * Manga part B (answer 2 at stop 0, 2026-11-25): one gate per stage across the Calibre
 * libraries. Each library's analysis saves what it found for its own labeled books (the labeled
 * books follow their move: mapLabeledIds); the gate is scored over every library's saved part
 * together, and its verdict pauses or lifts the field in every library (stage_field_pauses,
 * library ''). With one library this is exactly the gate as before.
 */
import type Database from 'better-sqlite3';

/** Saves one library's part of a stage's gate (replaces its earlier one). */
export function saveGatePart(
  db: Database.Database,
  stage: number,
  part: string,
  libraryId: string,
  data: unknown,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO stage_gate_parts (stage, part, library_id, data_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(stage, part, library_id) DO UPDATE SET data_json = excluded.data_json,
       updated_at = excluded.updated_at`,
  ).run(stage, part, libraryId, JSON.stringify(data), now);
}

/** Every library's saved part of a stage's gate (the library that asks first). */
export function gateParts<T>(
  db: Database.Database,
  stage: number,
  part: string,
  first?: string,
): { libraryId: string; data: T }[] {
  const rows = db
    .prepare(
      'SELECT library_id, data_json FROM stage_gate_parts WHERE stage = ? AND part = ? ORDER BY library_id',
    )
    .all(stage, part) as { library_id: string; data_json: string }[];
  const out = rows.map((r) => ({ libraryId: r.library_id, data: JSON.parse(r.data_json) as T }));
  if (first) out.sort((a, b) => (a.libraryId === first ? -1 : b.libraryId === first ? 1 : 0));
  return out;
}

/** The union of every library's list (one library's part saved just before). */
export function unionOfParts<T>(
  db: Database.Database,
  stage: number,
  part: string,
  libraryId: string,
): T[] {
  return gateParts<T[]>(db, stage, part, libraryId).flatMap((p) => p.data);
}
