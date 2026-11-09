import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { UUID_RE } from '../sync/kinds';
import type { SyncStore } from '../sync/store';
import type { AuthenticatedToken } from './tokens';

/**
 * Devices (WP4). A device chooses its own id once (a UUID kept in its browser
 * storage) and keeps it across re-pairing, so its records stay its own. Each
 * token is bound to at most one device. The device's name is a synced record
 * (kind "device") so a rename shows up everywhere.
 */
export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export class DeviceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface DeviceRow {
  id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number | null;
}

function deviceName(store: SyncStore, userId: string, id: string, fallback: string): string {
  const name = store.getRecord(userId, 'device', id)?.data.name;
  return typeof name === 'string' ? name : fallback;
}

/**
 * Binds the calling token to a device and returns it.
 * - Token already bound: returns that device (a different requested id is a 409).
 * - Requested id known for this user: re-attaches it (re-pairing).
 * - Requested id unknown: creates the device with that id.
 * - No id: creates one with a new id.
 * The device's name starts as `name` or the token's label.
 */
export function registerDevice(
  db: Database.Database,
  store: SyncStore,
  auth: AuthenticatedToken,
  request: { deviceId?: unknown; name?: unknown },
  now = Date.now(),
): Device {
  const userId = auth.user.id;
  const requested = request.deviceId;
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string' || !UUID_RE.test(requested)) {
      throw new DeviceError(400, 'invalid_device_id', 'deviceId must be a lowercase UUID');
    }
  }
  const requestedName =
    typeof request.name === 'string' && request.name.trim()
      ? request.name.trim().slice(0, 100)
      : null;

  return db.transaction(() => {
    const bound = auth.token.deviceId;
    if (bound) {
      if (requested && requested !== bound) {
        throw new DeviceError(
          409,
          'token_bound_to_other_device',
          'This token already belongs to another device; pair this device again',
        );
      }
      return getDevice(db, store, userId, bound, auth.token.label)!;
    }

    const id = typeof requested === 'string' ? requested : randomUUID();
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
    if (row && row.user_id !== userId) {
      throw new DeviceError(409, 'device_id_taken', 'This device id belongs to another user');
    }
    if (!row) {
      db.prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, ?)').run(
        id,
        userId,
        now,
      );
    }
    db.prepare('UPDATE api_tokens SET device_id = ? WHERE id = ?').run(id, auth.token.id);

    if (!store.getRecord(userId, 'device', id)) {
      const result = store.writeAs(
        userId,
        id,
        { kind: 'device', id, updatedAt: now, data: { name: requestedName ?? auth.token.label } },
        now,
      );
      if (result.status === 'rejected') throw new Error(result.error.message);
    }
    return getDevice(db, store, userId, id, auth.token.label)!;
  })();
}

export function getDevice(
  db: Database.Database,
  store: SyncStore,
  userId: string,
  id: string,
  fallbackName = '',
): Device | null {
  const row = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, userId) as
    | DeviceRow
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: deviceName(store, userId, row.id, fallbackName),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function listDevices(db: Database.Database, store: SyncStore, userId: string): Device[] {
  const rows = db
    .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at')
    .all(userId) as DeviceRow[];
  return rows.map((row) => ({
    id: row.id,
    name: deviceName(store, userId, row.id, ''),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export function touchDevice(db: Database.Database, id: string, now = Date.now()): void {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
}
