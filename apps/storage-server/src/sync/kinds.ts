import type Database from 'better-sqlite3';

/**
 * Record kinds the sync engine accepts, with their conflict policy and
 * validation (WP4). Adding a kind is code only: no migration.
 *
 * Policies (decided in the WP4 plan):
 * - lww:    the higher (updatedAt, deviceId) wins, per record. A delete is a
 *           write with deletedAt; a newer edit revives a deleted record.
 * - owner:  only the device named in the id may write the record, so two
 *           devices never conflict; within that device it is lww.
 * - append: written once; later writes to the same id change nothing.
 */
export type SyncPolicy = 'lww' | 'owner' | 'append';

export interface KindContext {
  db: Database.Database;
  userId: string;
  /** The device making the change (from its token). */
  deviceId: string;
}

export interface ValidatedRecord {
  bookId: string | null;
  data: Record<string, unknown>;
}

export interface KindSpec {
  /** Policy for one record of this kind (it may depend on the id, e.g. settings). */
  policy(id: string): SyncPolicy;
  /** For owner records: the device allowed to write this id. */
  ownerOf?(id: string): string | null;
  /** Whether a deletion marker is allowed for this kind. */
  deletable: boolean;
  /**
   * Checks the id and payload and returns what is stored. `deleted` = the
   * change is a deletion marker (its data is not checked and is stored as {}).
   * Throws RecordError when the change must be rejected.
   */
  validate(id: string, data: unknown, deleted: boolean, ctx: KindContext): ValidatedRecord;
}

export type KindRegistry = Record<string, KindSpec>;

/** A change the server refuses. The client keeps it aside and never retries it. */
export class RecordError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETTING_KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
/** Largest payload of one record, as JSON. */
export const MAX_RECORD_BYTES = 64 * 1024;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(data: unknown): Record<string, unknown> {
  if (!isPlainObject(data)) throw new RecordError('invalid_data', 'data must be an object');
  return data;
}

function deviceExists(ctx: KindContext, id: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM devices WHERE id = ? AND user_id = ?').get(id, ctx.userId);
}

function bookExists(ctx: KindContext, id: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM books WHERE id = ?').get(id);
}

/** kind "device", id = device id, data { name }. Any device may rename any device. */
const deviceKind: KindSpec = {
  policy: () => 'lww',
  deletable: false,
  validate(id, data, _deleted, ctx) {
    if (!deviceExists(ctx, id)) throw new RecordError('unknown_device', `No device ${id}`);
    const { name } = requireObject(data);
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw new RecordError('invalid_data', 'name must be 1 to 100 characters');
    }
    return { bookId: null, data: { name: name.trim() } };
  },
};

/**
 * kind "setting":
 *   global:<key>             one value for every device (lww)
 *   device:<deviceId>:<key>  one device's own value, published so other devices
 *                            can copy it (owner)
 * data { value } with any JSON value.
 */
export function parseSettingId(
  id: string,
): { scope: 'global'; key: string } | { scope: 'device'; deviceId: string; key: string } | null {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global' && SETTING_KEY_RE.test(parts[1])) {
    return { scope: 'global', key: parts[1] };
  }
  if (
    parts.length === 3 &&
    parts[0] === 'device' &&
    UUID_RE.test(parts[1]) &&
    SETTING_KEY_RE.test(parts[2])
  ) {
    return { scope: 'device', deviceId: parts[1], key: parts[2] };
  }
  return null;
}

const settingKind: KindSpec = {
  policy: (id) => (parseSettingId(id)?.scope === 'device' ? 'owner' : 'lww'),
  ownerOf: (id) => {
    const parsed = parseSettingId(id);
    return parsed?.scope === 'device' ? parsed.deviceId : null;
  },
  deletable: true,
  validate(id, data, deleted) {
    if (!parseSettingId(id)) {
      throw new RecordError('invalid_id', 'setting ids are global:<key> or device:<id>:<key>');
    }
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    if (!('value' in obj)) throw new RecordError('invalid_data', 'data.value is missing');
    return { bookId: null, data: { value: obj.value } };
  },
};

/** kind "position": id <bookId>:<deviceId>, the latest place one device reached in a book. */
export function parsePositionId(id: string): { bookId: string; deviceId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !UUID_RE.test(parts[1])) {
    return null;
  }
  return { bookId: parts[0], deviceId: parts[1] };
}

const positionKind: KindSpec = {
  policy: () => 'owner',
  ownerOf: (id) => parsePositionId(id)?.deviceId ?? null,
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parsePositionId(id);
    if (!parsed) throw new RecordError('invalid_id', 'position ids are <bookId>:<deviceId>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const { charPos, progress, readThroughId } = requireObject(data);
    if (typeof charPos !== 'number' || !Number.isInteger(charPos) || charPos < 0) {
      throw new RecordError('invalid_data', 'charPos must be a whole number >= 0');
    }
    if (progress !== null && (typeof progress !== 'number' || !(progress >= 0 && progress <= 1))) {
      throw new RecordError('invalid_data', 'progress must be null or from 0 to 1');
    }
    if (
      readThroughId !== null &&
      readThroughId !== undefined &&
      typeof readThroughId !== 'string'
    ) {
      throw new RecordError('invalid_data', 'readThroughId must be null or a string');
    }
    return {
      bookId: parsed.bookId,
      data: { charPos, progress, readThroughId: readThroughId ?? null },
    };
  },
};

export const DEFAULT_KINDS: KindRegistry = {
  device: deviceKind,
  setting: settingKind,
  position: positionKind,
};
