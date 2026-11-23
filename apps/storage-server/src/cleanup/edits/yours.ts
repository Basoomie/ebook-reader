/**
 * Fields that are the user's (cleanup.db user_fields): every field the user saves, confirms,
 * puts back with Undo, or changes in Calibre's own program. No cleanup pass changes them again
 * (the triggers of cleanup.db v29, the batch planner and the sidecar's verify).
 */
import type Database from 'better-sqlite3';
import { setUserValue } from '../ai-decide/values';
import { aiFieldOf, userKeysOf, type EditField, type UserFieldKey } from './fields';

export type YoursSource = 'edit' | 'confirm' | 'undo' | 'calibre' | 'carried' | 'shared_rename';

/**
 * A field becomes the user's. A field that already was keeps the change that first made it so
 * (`change_id`): only a save that made a field the user's lets it go again when nothing was
 * written (releaseUnwritten).
 */
export function markYours(
  db: Database.Database,
  ref: { libraryId: string; uuid: string },
  key: UserFieldKey,
  value: unknown,
  source: YoursSource,
  changeId: number | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO user_fields (library_id, calibre_uuid, field, value_json, source, since, change_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, calibre_uuid, field) DO UPDATE SET value_json = excluded.value_json,
       source = excluded.source, since = excluded.since`,
  ).run(ref.libraryId, ref.uuid, key, JSON.stringify(value ?? null), source, now, changeId);
}

/**
 * The stage-4 AI's value of a field the user set or confirmed (ai_values 'calibre4', source
 * user): the AI layer then counts it as confirmed and never asks or upgrades it again, and it
 * leaves /cleanup's "Best guesses".
 */
export function setAiYours(
  db: Database.Database,
  ref: { libraryId: string; uuid: string },
  key: UserFieldKey,
  value: unknown,
  now: number,
): void {
  const ai = aiFieldOf(key);
  if (!ai) return;
  setUserValue(db, 'calibre4', `${ref.libraryId}:${ref.uuid}`, ai.field, ai.value(value), now);
  if (key === 'series_index') {
    db.prepare(
      `UPDATE stage4_series_order SET guess = 0, src = 'user' WHERE library_id = ? AND calibre_uuid = ?`,
    ).run(ref.libraryId, ref.uuid);
  }
}

/** After an edit's write: the AI's values of the fields it wrote become the user's. */
export function aiYoursAfterWrite(
  db: Database.Database,
  ref: { libraryId: string; uuid: string },
  field: string,
  before: unknown,
  after: unknown,
  now: number,
): void {
  for (const key of userKeysOf(field as EditField, before, after))
    setAiYours(db, ref, key, after, now);
}

/** Fields an edit made the user's and that weren't written after all stop being theirs again. */
export function releaseUnwritten(db: Database.Database, batchId: string): number {
  return db
    .prepare(
      `DELETE FROM user_fields WHERE change_id IN (
         SELECT id FROM proposed_changes WHERE batch_id = ? AND state IN ('skipped', 'undone'))`,
    )
    .run(batchId).changes;
}

/** The user's fields of a book. */
export function yoursOf(
  db: Database.Database,
  libraryId: string,
  uuid: string,
): { field: string; source: string; since: number; changeId: number | null }[] {
  return (
    db
      .prepare(
        `SELECT field, source, since, change_id FROM user_fields
         WHERE library_id = ? AND calibre_uuid = ?`,
      )
      .all(libraryId, uuid) as {
      field: string;
      source: string;
      since: number;
      change_id: number | null;
    }[]
  ).map((r) => ({ field: r.field, source: r.source, since: r.since, changeId: r.change_id }));
}
