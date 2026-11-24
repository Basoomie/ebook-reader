/**
 * A synced global setting as the server sees it: the `setting` record `global:<key>` that the
 * settings-source device writes with the localStorage text as `value` (web app
 * `lib/sync/settings-sync.ts`). Booleans are "1"/"0", numbers their text.
 */
import type Database from 'better-sqlite3';

/** The raw value, or null (no record, deleted, or never set on the source = the default). */
export function globalSetting(db: Database.Database, userId: string, key: string): string | null {
  const row = db
    .prepare(
      `SELECT data FROM sync_records WHERE user_id = ? AND kind = 'setting' AND id = ?
         AND deleted_at IS NULL`,
    )
    .get(userId, `global:${key}`) as { data: string | null } | undefined;
  if (!row?.data) return null;
  try {
    const value = (JSON.parse(row.data) as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** A global boolean setting (the web's writableBooleanLocalStorageSubject: "1"/"0"). */
export function globalBoolean(
  db: Database.Database,
  userId: string,
  key: string,
  fallback: boolean,
): boolean {
  const raw = globalSetting(db, userId, key);
  if (raw === null) return fallback;
  // As the web reads it (`!!+x`): anything but a non-zero number is off.
  return !!+raw;
}
