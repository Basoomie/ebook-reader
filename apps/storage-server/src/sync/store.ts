import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { DEFAULT_KINDS, isPlainObject, KindRegistry, MAX_RECORD_BYTES, RecordError } from './kinds';

/** A record as devices see it. */
export interface SyncRecord {
  kind: string;
  id: string;
  bookId: string | null;
  /** Last writer. */
  deviceId: string;
  updatedAt: number;
  deletedAt: number | null;
  rev: number;
  data: Record<string, unknown>;
}

/** A change pushed by a device. The device id always comes from the token, never the body. */
export interface SyncChange {
  kind: string;
  id: string;
  updatedAt: number;
  deletedAt?: number | null;
  data?: unknown;
}

export type ChangeResult =
  | { kind: string; id: string; status: 'applied' | 'duplicate'; rev: number }
  | { kind: string; id: string; status: 'stale'; record: SyncRecord }
  | { kind: string; id: string; status: 'rejected'; error: { code: string; message: string } };

export interface PullResult {
  records: SyncRecord[];
  /** Rev of the last record returned (or the requested rev when nothing changed). */
  rev: number;
  more: boolean;
}

export interface SyncStoreOptions {
  /** updatedAt further ahead of the server clock than this is set to the server time. */
  maxClockSkewMs: number;
  kinds?: KindRegistry;
}

export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;
export const MAX_ID_LENGTH = 300;

interface RecordRow {
  kind: string;
  id: string;
  book_id: string | null;
  device_id: string;
  updated_at: number;
  deleted_at: number | null;
  rev: number;
  data: string;
}

function toRecord(row: RecordRow): SyncRecord {
  return {
    kind: row.kind,
    id: row.id,
    bookId: row.book_id,
    deviceId: row.device_id,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    rev: row.rev,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** (updatedAt, deviceId) ordering: > 0 when a wins. */
function compareVersions(
  a: { updatedAt: number; deviceId: string },
  b: { updatedAt: number; deviceId: string },
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

export function newEpochValue(): string {
  return randomBytes(9).toString('base64url');
}

/**
 * Server side of the WP4 sync engine. Every push runs in one transaction; the
 * server alone decides which version of a record wins.
 */
export class SyncStore {
  private readonly kinds: KindRegistry;
  private readonly maxClockSkewMs: number;

  constructor(
    private readonly db: Database.Database,
    options: SyncStoreOptions = { maxClockSkewMs: DEFAULT_MAX_CLOCK_SKEW_SECONDS * 1000 },
  ) {
    this.kinds = options.kinds ?? DEFAULT_KINDS;
    this.maxClockSkewMs = options.maxClockSkewMs;
  }

  /** The user's epoch and newest rev (creates the state row on first use). */
  getState(userId: string): { epoch: string; lastRev: number } {
    this.db
      .prepare('INSERT OR IGNORE INTO sync_state (user_id, epoch, last_rev) VALUES (?, ?, 0)')
      .run(userId, newEpochValue());
    const row = this.db
      .prepare('SELECT epoch, last_rev FROM sync_state WHERE user_id = ?')
      .get(userId) as { epoch: string; last_rev: number };
    return { epoch: row.epoch, lastRev: row.last_rev };
  }

  /** Applies a device's changes. Returns one result per change, in order. */
  push(userId: string, deviceId: string, changes: SyncChange[], now = Date.now()): ChangeResult[] {
    return this.db.transaction(() => {
      this.getState(userId);
      return changes.map((change) => this.applyOne(userId, deviceId, change, now));
    })();
  }

  /** A write made by the server for a device (e.g. the device record at registration). */
  writeAs(userId: string, deviceId: string, change: SyncChange, now = Date.now()): ChangeResult {
    return this.push(userId, deviceId, [change], now)[0];
  }

  getRecord(userId: string, kind: string, id: string): SyncRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sync_records WHERE user_id = ? AND kind = ? AND id = ?')
      .get(userId, kind, id) as RecordRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Records with rev > sinceRev, oldest change first, deletion markers included. */
  pull(userId: string, sinceRev: number, limit: number): PullResult {
    const rows = this.db
      .prepare(
        `SELECT * FROM sync_records WHERE user_id = ? AND rev > ?
          ORDER BY rev LIMIT ?`,
      )
      .all(userId, sinceRev, limit + 1) as RecordRow[];
    const more = rows.length > limit;
    const records = rows.slice(0, limit).map(toRecord);
    return { records, rev: records.length ? records[records.length - 1].rev : sinceRev, more };
  }

  /** After restoring the database: every device's cursor becomes invalid and they reconcile. */
  newEpoch(): number {
    const users = this.db.prepare('SELECT user_id FROM sync_state').all() as { user_id: string }[];
    const update = this.db.prepare('UPDATE sync_state SET epoch = ? WHERE user_id = ?');
    this.db.transaction(() => {
      for (const u of users) update.run(newEpochValue(), u.user_id);
    })();
    return users.length;
  }

  /** Counts per kind (deleted ones separately), for the CLI. */
  counts(userId: string): { kind: string; live: number; deleted: number }[] {
    return this.db
      .prepare(
        `SELECT kind,
                SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END) AS deleted
           FROM sync_records WHERE user_id = ? GROUP BY kind ORDER BY kind`,
      )
      .all(userId) as { kind: string; live: number; deleted: number }[];
  }

  /** For the CLI: records filtered by kind and/or book, newest change first. */
  list(userId: string, filter: { kind?: string; bookId?: string }, limit = 100): SyncRecord[] {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.bookId) {
      where.push('book_id = ?');
      params.push(filter.bookId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM sync_records WHERE ${where.join(' AND ')} ORDER BY rev DESC LIMIT ?`)
      .all(...params, limit) as RecordRow[];
    return rows.map(toRecord);
  }

  private applyOne(
    userId: string,
    deviceId: string,
    change: SyncChange,
    now: number,
  ): ChangeResult {
    const kind = typeof change?.kind === 'string' ? change.kind : '';
    const id = typeof change?.id === 'string' ? change.id : '';
    const reject = (code: string, message: string): ChangeResult => ({
      kind,
      id,
      status: 'rejected',
      error: { code, message },
    });

    if (!isPlainObject(change)) return reject('invalid_change', 'A change must be an object');
    const spec = Object.prototype.hasOwnProperty.call(this.kinds, kind)
      ? this.kinds[kind]
      : undefined;
    if (!spec) return reject('unknown_kind', `Unknown kind "${kind}"`);
    if (!id || id.length > MAX_ID_LENGTH) return reject('invalid_id', 'Missing or too long id');
    if (!isTimestamp(change.updatedAt)) {
      return reject('invalid_change', 'updatedAt must be a timestamp in ms');
    }
    const deletedAtRaw = change.deletedAt ?? null;
    if (deletedAtRaw !== null && !isTimestamp(deletedAtRaw)) {
      return reject('invalid_change', 'deletedAt must be null or a timestamp in ms');
    }
    const deleted = deletedAtRaw !== null;
    if (deleted && !spec.deletable)
      return reject('not_deletable', `${kind} records can't be deleted`);

    const owner = spec.ownerOf?.(id);
    if (owner !== undefined && owner !== null && owner !== deviceId) {
      return reject('not_owner', 'Only the device that owns this record may change it');
    }

    let validated;
    try {
      validated = spec.validate(id, change.data, deleted, { db: this.db, userId, deviceId });
    } catch (err) {
      if (err instanceof RecordError) return reject(err.code, err.message);
      throw err;
    }
    const json = JSON.stringify(validated.data);
    if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) {
      return reject('too_large', `A record may hold at most ${MAX_RECORD_BYTES} bytes`);
    }

    // A clock far ahead must not win forever.
    const limit = now + this.maxClockSkewMs;
    const updatedAt = change.updatedAt > limit ? now : change.updatedAt;
    const deletedAt = deletedAtRaw === null ? null : Math.min(deletedAtRaw, updatedAt);

    const existing = this.getRecord(userId, kind, id);
    if (existing) {
      if (spec.policy(id) === 'append') {
        return { kind, id, status: 'duplicate', rev: existing.rev };
      }
      const order = compareVersions({ updatedAt, deviceId }, existing);
      if (order === 0) return { kind, id, status: 'duplicate', rev: existing.rev };
      if (order < 0) return { kind, id, status: 'stale', record: existing };
    }

    const rev = this.nextRev(userId);
    this.db
      .prepare(
        `INSERT INTO sync_records
           (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, kind, id) DO UPDATE SET
           book_id = excluded.book_id, device_id = excluded.device_id,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
           rev = excluded.rev, data = excluded.data, received_at = excluded.received_at`,
      )
      .run(userId, kind, id, validated.bookId, deviceId, updatedAt, deletedAt, rev, json, now);
    return { kind, id, status: 'applied', rev };
  }

  private nextRev(userId: string): number {
    const row = this.db
      .prepare('UPDATE sync_state SET last_rev = last_rev + 1 WHERE user_id = ? RETURNING last_rev')
      .get(userId) as { last_rev: number };
    return row.last_rev;
  }
}

/** Opaque pull cursor: base64url("<epoch>.<rev>"). */
export function encodeCursor(epoch: string, rev: number): string {
  return Buffer.from(`${epoch}.${rev}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { epoch: string; rev: number } | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^([A-Za-z0-9_-]{1,64})\.(\d{1,15})$/.exec(text);
  if (!match) return null;
  return { epoch: match[1], rev: Number(match[2]) };
}
