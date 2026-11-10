/**
 * The empty "Planned" collection (WP8b, decided with the user): created once per user,
 * by the server, so two devices can never both create one and a freshly paired device
 * with an empty mirror can never bring a deleted one back. After that it is an ordinary
 * collection the user may rename or delete.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { SyncStore } from '../sync/store';

export const PLANNED_SEED = 'planned-collection';
/** Fixed id (records are per user, so every user can have the same one). */
export const PLANNED_COLLECTION_ID = '5e7d2c1a-8b4f-4c3e-9a6d-0f1b2c3d4e5f';
export const PLANNED_NAME = 'Planned';
/** Name of the pseudo-device that writes the server's own records. */
export const SEED_DEVICE_NAME = 'Server';

/** Writes "Planned" for every user that hasn't had it yet. Returns the users seeded. */
export function seedPlannedCollections(
  db: Database.Database,
  store: SyncStore,
  now = Date.now(),
): string[] {
  const users = db
    .prepare(
      `SELECT u.id FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM user_seeds s WHERE s.user_id = u.id AND s.name = ?)`,
    )
    .all(PLANNED_SEED) as { id: string }[];
  const seeded: string[] = [];
  for (const { id: userId } of users) {
    db.transaction(() => {
      // Any record with that id, live or deleted, means it already exists (or existed).
      const existing = store.getRecord(userId, 'collection', PLANNED_COLLECTION_ID);
      let deviceId: string | null = null;
      if (!existing) {
        deviceId = randomUUID();
        db.prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, ?)').run(
          deviceId,
          userId,
          now,
        );
        for (const change of [
          { kind: 'device', id: deviceId, updatedAt: now, data: { name: SEED_DEVICE_NAME } },
          {
            kind: 'collection',
            id: PLANNED_COLLECTION_ID,
            updatedAt: now,
            data: { name: PLANNED_NAME, type: 'manual' },
          },
        ]) {
          const result = store.writeAs(userId, deviceId, change, now);
          if (result.status !== 'applied') {
            throw new Error(`seeding ${change.kind}: ${result.status}`);
          }
        }
        seeded.push(userId);
      }
      db.prepare(
        'INSERT INTO user_seeds (user_id, name, device_id, done_at) VALUES (?, ?, ?, ?)',
      ).run(userId, PLANNED_SEED, deviceId, now);
    })();
  }
  return seeded;
}
