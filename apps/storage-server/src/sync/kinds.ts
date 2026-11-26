import type Database from 'better-sqlite3';
import { parseQuery } from '../catalog/query-parser';

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
  /**
   * Optional: checks a validated change that would win against the record the
   * server holds (never called for stale or duplicate changes). Throws
   * RecordError to refuse it; the refusal then carries the server's copy.
   */
  checkReplace?(next: ValidatedRecord, deleted: boolean, existing: ExistingRecord): void;
}

/** The server's current version of a record, as checkReplace sees it. */
export interface ExistingRecord {
  deletedAt: number | null;
  data: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// WP5: migration off the old file sync
// ---------------------------------------------------------------------------

/** The pseudo-device the server writes migration records as ("Old sync (imported)"). */
export function migrationDeviceId(ctx: KindContext): string | null {
  const row = ctx.db
    .prepare('SELECT import_device_id FROM migration_state WHERE user_id = ?')
    .get(ctx.userId) as { import_device_id: string | null } | undefined;
  return row?.import_device_id ?? null;
}

const LEGACY_BOOK_ID_RE = /^t:[0-9a-f]{64}$/;
export const LINK_METHODS = ['calibre-link', 'fingerprint', 'user'] as const;

/**
 * kind "legacy-book": id t:<sha256(title)>, one old-sync book title -> its
 * catalog book. Written only by the server (the migration pseudo-device);
 * devices read it to find the book id of a manually imported book.
 */
const legacyBookKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    if (!LEGACY_BOOK_ID_RE.test(id)) throw new RecordError('invalid_id', 'ids are t:<sha256>');
    if (ctx.deviceId !== migrationDeviceId(ctx)) {
      throw new RecordError('server_only', 'Only the server writes legacy-book records');
    }
    if (deleted) return { bookId: null, data: {} };
    const { title, bookId, method } = requireObject(data);
    if (typeof title !== 'string' || !title || title.length > 1000) {
      throw new RecordError('invalid_data', 'title must be 1 to 1000 characters');
    }
    if (typeof bookId !== 'string' || !UUID_RE.test(bookId) || !bookExists(ctx, bookId)) {
      throw new RecordError('unknown_book', `No book ${String(bookId)}`);
    }
    if (!LINK_METHODS.includes(method as (typeof LINK_METHODS)[number])) {
      throw new RecordError('invalid_data', 'unknown method');
    }
    return { bookId, data: { title, bookId, method } };
  },
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAT_NUMBERS = [
  'charactersRead',
  'readingTime',
  'minReadingSpeed',
  'altMinReadingSpeed',
  'lastReadingSpeed',
  'maxReadingSpeed',
] as const;

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RecordError('invalid_data', `${field} must be a number`);
  }
  return value;
}

/**
 * completedData keeps the old shape as is: a flat object of numbers, short
 * strings (dateKey, finishDate 'na'), booleans and nulls (NaN becomes null in
 * JSON). Nested values are refused; a title is dropped.
 */
function completedData(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value))
    throw new RecordError('invalid_data', 'completedData must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'title') continue;
    if (
      v === null ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= 200)
    ) {
      out[k] = v;
    } else {
      throw new RecordError('invalid_data', `completedData.${k} is invalid`);
    }
  }
  return out;
}

export function parseStatDayId(id: string): { bookId: string; dateKey: string } | null {
  const parts = id.split(':');
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !DATE_KEY_RE.test(parts[1])) return null;
  return { bookId: parts[0], dateKey: parts[1] };
}

/**
 * kind "stat-day": id <bookId>:<YYYY-MM-DD>, one book's statistics for one
 * day, exactly the old per-title daily row (minus title). lww, like the old
 * sync's per-day "newest lastStatisticModified wins" (until WP12's sessions).
 */
const statDayKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseStatDayId(id);
    if (!parsed) throw new RecordError('invalid_id', 'stat-day ids are <bookId>:<YYYY-MM-DD>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    if (obj.dateKey !== parsed.dateKey) {
      throw new RecordError('invalid_data', 'dateKey must match the id');
    }
    const out: Record<string, unknown> = { dateKey: parsed.dateKey };
    for (const field of STAT_NUMBERS) out[field] = finiteNumber(obj[field], field);
    const modified = finiteNumber(obj.lastStatisticModified, 'lastStatisticModified');
    if (modified < 0) throw new RecordError('invalid_data', 'lastStatisticModified must be >= 0');
    out.lastStatisticModified = modified;
    if (obj.completedBook !== undefined) {
      out.completedBook = finiteNumber(obj.completedBook, 'completedBook');
    }
    if (obj.completedData !== undefined) out.completedData = completedData(obj.completedData);
    return { bookId: parsed.bookId, data: out };
  },
};

/**
 * kind "reading-goal": id = the goal's start date (YYYY-MM-DD), the old
 * IndexedDB readingGoal row as is. lww.
 */
const readingGoalKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    if (!DATE_KEY_RE.test(id))
      throw new RecordError('invalid_id', 'reading-goal ids are YYYY-MM-DD');
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    if (obj.goalStartDate !== id) {
      throw new RecordError('invalid_data', 'goalStartDate must match the id');
    }
    const dateOrEmpty = (v: unknown, field: string) => {
      if (v === undefined || v === '') return '';
      if (typeof v === 'string' && DATE_KEY_RE.test(v)) return v;
      throw new RecordError('invalid_data', `${field} must be YYYY-MM-DD or empty`);
    };
    if (typeof obj.goalFrequency !== 'string' || obj.goalFrequency.length > 20) {
      throw new RecordError('invalid_data', 'goalFrequency must be a short string');
    }
    return {
      bookId: null,
      data: {
        timeGoal: finiteNumber(obj.timeGoal, 'timeGoal'),
        characterGoal: finiteNumber(obj.characterGoal, 'characterGoal'),
        goalFrequency: obj.goalFrequency,
        goalStartDate: id,
        goalEndDate: dateOrEmpty(obj.goalEndDate, 'goalEndDate'),
        goalOriginalEndDate: dateOrEmpty(obj.goalOriginalEndDate, 'goalOriginalEndDate'),
        lastGoalModified: finiteNumber(obj.lastGoalModified, 'lastGoalModified'),
      },
    };
  },
};

/**
 * kind "migration": switches every device obeys.
 *   legacy-sync      { enabled }   the old file sync for reading data (no record = on)
 *   settings-source  { deviceId }  the device whose global settings were published first
 */
const migrationKind: KindSpec = {
  policy: () => 'lww',
  deletable: false,
  validate(id, data, _deleted, ctx) {
    const obj = requireObject(data);
    if (id === 'legacy-sync') {
      if (typeof obj.enabled !== 'boolean') {
        throw new RecordError('invalid_data', 'enabled must be true or false');
      }
      return { bookId: null, data: { enabled: obj.enabled } };
    }
    if (id === 'settings-source') {
      if (typeof obj.deviceId !== 'string' || !deviceExists(ctx, obj.deviceId)) {
        throw new RecordError('unknown_device', 'deviceId must be a device of this user');
      }
      return { bookId: null, data: { deviceId: obj.deviceId } };
    }
    throw new RecordError('invalid_id', 'migration ids are legacy-sync or settings-source');
  },
};

// ---------------------------------------------------------------------------
// WP8a: book state (status, favorite, cover blur, read-throughs)
// ---------------------------------------------------------------------------

export const BOOK_STATUSES = ['unread', 'reading', 'completed', 'dropped'] as const;
export const BOOK_BLURS = ['inherit', 'always', 'never'] as const;
export const READ_THROUGH_ORIGINS = ['start-over', 'completion'] as const;
const MAX_READ_THROUGH_NUMBER = 9999;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RecordError('invalid_data', `${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean')
    throw new RecordError('invalid_data', `${field} must be true or false`);
  return value;
}

function dateOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && DATE_KEY_RE.test(value)) return value;
  throw new RecordError('invalid_data', `${field} must be YYYY-MM-DD or null`);
}

/**
 * One value per book (status, favorite, blur): id = the book id, lww. Kept as
 * separate records so an edit of one field never overwrites another field
 * edited on another device. No deletion: "no record" means the default.
 */
function perBookKind(field: string, check: (value: unknown) => unknown): KindSpec {
  return {
    policy: () => 'lww',
    deletable: false,
    validate(id, data, _deleted, ctx) {
      if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the book id');
      if (!bookExists(ctx, id)) throw new RecordError('unknown_book', `No book ${id}`);
      const obj = requireObject(data);
      return { bookId: id, data: { [field]: check(obj[field]) } };
    },
  };
}

/** kind "book-status": data { status, auto }. No record = unread. */
const bookStatusKind: KindSpec = {
  policy: () => 'lww',
  deletable: false,
  validate(id, data, _deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the book id');
    if (!bookExists(ctx, id)) throw new RecordError('unknown_book', `No book ${id}`);
    const obj = requireObject(data);
    return {
      bookId: id,
      data: { status: oneOf(obj.status, BOOK_STATUSES, 'status'), auto: bool(obj.auto, 'auto') },
    };
  },
};

export function parseReadThroughId(id: string): { bookId: string; number: number } | null {
  const parts = id.split(':');
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !/^[1-9]\d{0,3}$/.test(parts[1])) {
    return null;
  }
  const number = Number(parts[1]);
  return number <= MAX_READ_THROUGH_NUMBER ? { bookId: parts[0], number } : null;
}

/**
 * kind "read-through": id <bookId>:<n>, one reading of a book. Numbered ids
 * are deterministic, so two devices starting over offline make the same
 * record. Stats are not copied into it: stat days belong to a read-through by
 * date (client-side rule).
 */
const readThroughKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseReadThroughId(id);
    if (!parsed) throw new RecordError('invalid_id', 'read-through ids are <bookId>:<1-9999>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    if (obj.number !== parsed.number) {
      throw new RecordError('invalid_data', 'number must match the id');
    }
    const finished = bool(obj.finished, 'finished');
    const finishedOn = dateOrNull(obj.finishedOn, 'finishedOn');
    if (!finished && finishedOn !== null) {
      throw new RecordError('invalid_data', 'finishedOn needs finished');
    }
    const charCount = obj.charCount ?? null;
    if (
      charCount !== null &&
      (typeof charCount !== 'number' || !Number.isInteger(charCount) || charCount < 0)
    ) {
      throw new RecordError('invalid_data', 'charCount must be null or a whole number >= 0');
    }
    return {
      bookId: parsed.bookId,
      data: {
        number: parsed.number,
        origin: oneOf(obj.origin, READ_THROUGH_ORIGINS, 'origin'),
        startedOn: dateOrNull(obj.startedOn, 'startedOn'),
        finished,
        finishedOn,
        manual: bool(obj.manual, 'manual'),
        charCount,
      },
    };
  },
  /**
   * An open read-through never replaces a finished one (decided 2026-11-10): a device
   * whose mirror is behind plans Start over as a number that may already exist
   * elsewhere as a finished read-through, and lww would wipe its finish. The device
   * re-plans with the next free number after adopting the server's copy.
   */
  checkReplace(next, deleted, existing) {
    if (deleted || existing.deletedAt !== null) return;
    if (next.data.finished === false && existing.data.finished === true) {
      throw new RecordError(
        'read_through_finished',
        'This read-through is already finished; start over as the next number',
      );
    }
  },
};

// ---------------------------------------------------------------------------
// WP7a: cover blur rules per tag
// ---------------------------------------------------------------------------

/**
 * kind "tag-blur": id = the tag name (as Calibre spells it), data { blur: true }, lww.
 * A rule blurs the covers of books with that tag unless the book's own "book-blur"
 * says otherwise. Deleting the record removes the rule. The tag need not exist (a rule
 * survives re-indexing and tags that come back).
 */
const tagBlurKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    if (id.trim() === '' || id !== id.trim()) {
      throw new RecordError('invalid_id', 'tag-blur ids are the tag name');
    }
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    if (obj.blur !== true) throw new RecordError('invalid_data', 'blur must be true');
    return { bookId: null, data: { blur: true } };
  },
};

/**
 * kind "blur-rule" (2026-11-21): cover blur rules for an author, a series or a collection,
 * beside the tag rules. id = "author:<name>", "series:<name>" (names as Calibre spells them)
 * or "collection:<collection or built-in id>"; data { blur: true }, lww. Deleting the record
 * removes the rule. Like tag rules, the device decides what is blurred (the book's own
 * "book-blur" wins); the name or collection need not exist.
 */
export const BLUR_RULE_TARGETS = ['author', 'series', 'collection'] as const;
const blurRuleKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    const colon = id.indexOf(':');
    const target = colon > 0 ? id.slice(0, colon) : '';
    const name = colon > 0 ? id.slice(colon + 1) : '';
    if (
      !(BLUR_RULE_TARGETS as readonly string[]).includes(target) ||
      name.trim() === '' ||
      name !== name.trim()
    ) {
      throw new RecordError(
        'invalid_id',
        'blur-rule ids are "author:<name>", "series:<name>" or "collection:<id>"',
      );
    }
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    if (obj.blur !== true) throw new RecordError('invalid_data', 'blur must be true');
    return { bookId: null, data: { blur: true } };
  },
};

// ---------------------------------------------------------------------------
// WP8b: collections
// ---------------------------------------------------------------------------

export const COLLECTION_TYPES = ['manual', 'smart'] as const;
export const MAX_COLLECTION_NAME = 200;
/** Same as the search box (QUERY_LIMITS.maxLength in the parser). */
export const MAX_COLLECTION_QUERY = 500;
export const MAX_ORDER_KEY = 200;
/** Base-62 order keys (apps/web/src/lib/collections/order-key.ts). */
const ORDER_KEY_RE = /^[0-9A-Za-z]+$/;

/** Smart collections store a search (WP7a language); returns the problem or null. */
export type QueryCheck = (query: string) => string | null;

/**
 * kind "collection": id = a UUID, data { name, type, query? }, lww, deletable.
 * Manual collections keep their books as "collection-item" records (one per book), so
 * adding, removing and moving books on two devices merge per book. Built-in
 * collections (Reading, Completed, ...) are not records.
 */
function collectionKind(checkQuery: QueryCheck): KindSpec {
  return {
    policy: () => 'lww',
    deletable: true,
    validate(id, data, deleted) {
      if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'collection ids are UUIDs');
      if (deleted) return { bookId: null, data: {} };
      const obj = requireObject(data);
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (name === '' || name.length > MAX_COLLECTION_NAME) {
        throw new RecordError('invalid_data', `name must be 1-${MAX_COLLECTION_NAME} characters`);
      }
      const type = oneOf(obj.type, COLLECTION_TYPES, 'type');
      if (type === 'manual') {
        if (obj.query !== undefined && obj.query !== null) {
          throw new RecordError('invalid_data', 'only a smart collection has a query');
        }
        return { bookId: null, data: { name, type } };
      }
      const query = typeof obj.query === 'string' ? obj.query.trim() : '';
      if (query === '' || query.length > MAX_COLLECTION_QUERY) {
        throw new RecordError('invalid_data', `query must be 1-${MAX_COLLECTION_QUERY} characters`);
      }
      const problem = checkQuery(query);
      if (problem !== null) throw new RecordError('invalid_data', `query: ${problem}`);
      return { bookId: null, data: { name, type, query } };
    },
  };
}

export function parseCollectionItemId(id: string): { collectionId: string; bookId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !UUID_RE.test(parts[1])) return null;
  return { collectionId: parts[0], bookId: parts[1] };
}

/**
 * kind "collection-item": id <collectionId>:<bookId>, data { key }, lww, deletable
 * (delete = removed from the collection). `key` orders the books: a fractional key
 * between its neighbours' keys, so moving a book rewrites only that book's record and
 * two devices reordering offline keep each other's moves. The collection need not be
 * known yet (records of one push arrive in any order).
 */
const collectionItemKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseCollectionItemId(id);
    if (!parsed) throw new RecordError('invalid_id', 'ids are <collectionId>:<bookId>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    const key = obj.key;
    if (typeof key !== 'string' || key.length > MAX_ORDER_KEY || !ORDER_KEY_RE.test(key)) {
      throw new RecordError('invalid_data', `key must be 1-${MAX_ORDER_KEY} letters or digits`);
    }
    return { bookId: parsed.bookId, data: { key } };
  },
};

// ---------------------------------------------------------------------------
// WP11a: highlights and notes
// ---------------------------------------------------------------------------

export const HIGHLIGHT_COLORS = [1, 2, 3, 4, 5] as const;
/** Longest highlighted text, in characters (code points). */
export const MAX_HIGHLIGHT_TEXT = 10_000;
/** Context kept on each side of a highlight, to find it again in a changed file. */
export const MAX_ANCHOR_CONTEXT = 32;
export const MAX_CHAPTER_NAME = 200;
export const MAX_NOTE_BODY = 20_000;
/** A note keeps the start of its highlight's text, so it stays readable on its own. */
export const MAX_NOTE_QUOTE = 300;

function charLength(value: string): number {
  return Array.from(value).length;
}

function wholeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RecordError('invalid_data', `${field} must be a whole number >= 0`);
  }
  return value;
}

function boundedString(value: unknown, field: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || charLength(value) > max || (!allowEmpty && !value.trim())) {
    throw new RecordError(
      'invalid_data',
      `${field} must be ${allowEmpty ? 'at most' : '1 to'} ${max} characters`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, field, max, true);
}

function createdAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RecordError('invalid_data', 'createdAt must be a timestamp');
  }
  return value;
}

/**
 * Ids of book-owned records: `<bookId>:<uuid>`. The book is part of the id so a
 * deletion marker (which carries no data) still names its book.
 */
export function parseBookItemId(id: string): { bookId: string; itemId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || !UUID_RE.test(parts[1])) return null;
  return { bookId: parts[0], itemId: parts[1] };
}

/**
 * kind "highlight": id <bookId>:<uuid>, lww, deletable. data { start, end, text,
 * before, after, color 1-5, chapter, createdAt }. start/end are the reader's
 * character positions; text and its context let each device find the highlight again
 * when its copy of the book differs. Only `color` changes after creation. Highlights
 * belong to the book, not to a read-through.
 */
const highlightKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseBookItemId(id);
    if (!parsed) throw new RecordError('invalid_id', 'highlight ids are <bookId>:<uuid>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    const start = wholeNumber(obj.start, 'start');
    const end = wholeNumber(obj.end, 'end');
    if (end < start) throw new RecordError('invalid_data', 'end must not be before start');
    const color = obj.color;
    if (!HIGHLIGHT_COLORS.includes(color as (typeof HIGHLIGHT_COLORS)[number])) {
      throw new RecordError('invalid_data', 'color must be 1 to 5');
    }
    return {
      bookId: parsed.bookId,
      data: {
        start,
        end,
        text: boundedString(obj.text, 'text', MAX_HIGHLIGHT_TEXT, false),
        before: boundedString(obj.before ?? '', 'before', MAX_ANCHOR_CONTEXT, true),
        after: boundedString(obj.after ?? '', 'after', MAX_ANCHOR_CONTEXT, true),
        color,
        chapter: optionalString(obj.chapter, 'chapter', MAX_CHAPTER_NAME),
        createdAt: createdAt(obj.createdAt),
      },
    };
  },
};

/**
 * Note ids: `<bookId>:<uuid>` for a free note about the book, `<bookId>:h:<uuid>` for
 * the note on the highlight `<bookId>:<uuid>` (one per highlight, so two devices
 * writing it offline edit the same record).
 */
export function parseNoteId(
  id: string,
): { bookId: string; highlightId: string | null; itemId: string } | null {
  const parts = id.split(':');
  if (parts.length === 2 && UUID_RE.test(parts[0]) && UUID_RE.test(parts[1])) {
    return { bookId: parts[0], highlightId: null, itemId: parts[1] };
  }
  if (parts.length === 3 && UUID_RE.test(parts[0]) && parts[1] === 'h' && UUID_RE.test(parts[2])) {
    return { bookId: parts[0], highlightId: `${parts[0]}:${parts[2]}`, itemId: parts[2] };
  }
  return null;
}

/**
 * kind "note": lww, deletable. data { body, highlightId, quote, createdAt }. A separate
 * record from its highlight, so a color change and a note edit made on two devices both
 * survive. `highlightId` must agree with the id. The highlight need not exist (records
 * of one push arrive in any order; a note whose highlight was deleted elsewhere is
 * shown as a book note with its quote).
 */
const noteKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseNoteId(id);
    if (!parsed) {
      throw new RecordError('invalid_id', 'note ids are <bookId>:<uuid> or <bookId>:h:<uuid>');
    }
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    if ((obj.highlightId ?? null) !== parsed.highlightId) {
      throw new RecordError('invalid_data', 'highlightId must match the id');
    }
    return {
      bookId: parsed.bookId,
      data: {
        body: boundedString(obj.body, 'body', MAX_NOTE_BODY, false),
        highlightId: parsed.highlightId,
        quote: optionalString(obj.quote, 'quote', MAX_NOTE_QUOTE),
        createdAt: createdAt(obj.createdAt),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// WP11b: named bookmarks
// ---------------------------------------------------------------------------

export const MAX_BOOKMARK_NAME = 200;

/**
 * kind "bookmark": id <bookId>:<uuid>, lww, deletable. data { pos, text, before, after,
 * name, chapter, createdAt }: a named place in a book, separate from the reading position
 * (a bookmark never moves it). `text` is the start of the text at `pos` and, with its
 * context, finds the place again in a changed copy of the book. Belongs to the book.
 */
const bookmarkKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseBookItemId(id);
    if (!parsed) throw new RecordError('invalid_id', 'bookmark ids are <bookId>:<uuid>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name || charLength(name) > MAX_BOOKMARK_NAME) {
      throw new RecordError('invalid_data', `name must be 1 to ${MAX_BOOKMARK_NAME} characters`);
    }
    return {
      bookId: parsed.bookId,
      data: {
        pos: wholeNumber(obj.pos, 'pos'),
        text: boundedString(obj.text ?? '', 'text', MAX_ANCHOR_CONTEXT, true),
        before: boundedString(obj.before ?? '', 'before', MAX_ANCHOR_CONTEXT, true),
        after: boundedString(obj.after ?? '', 'after', MAX_ANCHOR_CONTEXT, true),
        name,
        chapter: optionalString(obj.chapter, 'chapter', MAX_CHAPTER_NAME),
        createdAt: createdAt(obj.createdAt),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// WP13: custom fonts
// ---------------------------------------------------------------------------

interface FontRow {
  name: string;
  file_name: string;
  format: string;
  size: number;
  sha256: string;
  created_at: number;
  /** Phase 10 (migration 19); absent in rows read by older code paths. */
  source?: string;
  copyright?: string | null;
  license_url?: string | null;
}

/** A font's other weights (Phase 10: a Google font's bold), lightest first. */
export interface FontFaceRow {
  weight: number;
  format: string;
  size: number;
  sha256: string;
}

/**
 * What a font's record holds: exactly its `fonts` row. A Google font (Phase 10) also has
 * source, copyright, licenseUrl and faces (its other weights); an uploaded font's record
 * keeps exactly the WP13 fields, so it is unchanged by Phase 10.
 */
export function fontRecordData(
  row: FontRow,
  faces: readonly FontFaceRow[] = [],
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: row.name,
    fileName: row.file_name,
    format: row.format,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
  if (row.source === 'google') {
    data.source = 'google';
    data.copyright = row.copyright ?? null;
    data.licenseUrl = row.license_url ?? null;
    data.faces = faces.map((f) => ({
      weight: f.weight,
      format: f.format,
      size: f.size,
      sha256: f.sha256,
    }));
  }
  return data;
}

/** A font's other weights as its record lists them. */
export function fontFaceRows(db: Database.Database, fontId: string): FontFaceRow[] {
  return db
    .prepare(
      'SELECT weight, format, size, sha256 FROM font_faces WHERE font_id = ? ORDER BY weight',
    )
    .all(fontId) as FontFaceRow[];
}

/**
 * kind "font": id = the font id, lww, deletable. data { name, fileName, format, size,
 * sha256, createdAt } (+ source, copyright, licenseUrl, faces for a Google font).
 * Written by the server when a font is uploaded (POST /api/v1/fonts) or added from Google
 * Fonts (POST /api/v1/fonts/google), as the asking device. Devices may delete it (gone
 * from every device) or restore it, but the data must be exactly the stored font's: a
 * record without a stored file, or with another name or file, is refused.
 */
const fontKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'font ids are UUIDs');
    const row = ctx.db
      .prepare(
        `SELECT name, file_name, format, size, sha256, created_at, source, copyright, license_url
           FROM fonts WHERE id = ? AND user_id = ?`,
      )
      .get(id, ctx.userId) as FontRow | undefined;
    if (!row) throw new RecordError('unknown_font', `No uploaded font ${id}`);
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    const expected = fontRecordData(row, fontFaceRows(ctx.db, id));
    for (const [key, value] of Object.entries(expected)) {
      if (JSON.stringify(obj[key]) !== JSON.stringify(value)) {
        throw new RecordError('invalid_data', `${key} must be the stored font's`);
      }
    }
    return { bookId: null, data: expected };
  },
};

// ---------------------------------------------------------------------------
// WP12: reading sessions, the only source of reading time and characters
// ---------------------------------------------------------------------------

export const STAT_SESSION_SOURCES = ['tracker', 'completion'] as const;
/** Longest session one record may claim (two days; the tracker splits at every day change). */
const MAX_SESSION_SECONDS = 2 * 86_400;
const MAX_SESSION_CHARS = 10_000_000;
const MAX_SESSION_LOOKUPS = 1_000_000;

/** id <bookId>:<deviceId>:<sessionUuid> (the book is in the id, like highlights). */
export function parseStatSessionId(
  id: string,
): { bookId: string; deviceId: string; sessionId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || !parts.every((p) => UUID_RE.test(p))) return null;
  return { bookId: parts[0], deviceId: parts[1], sessionId: parts[2] };
}

function boundedWhole(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new RecordError('invalid_data', `${field} must be a whole number from 0 to ${max}`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RecordError('invalid_data', `${field} must be a timestamp in ms`);
  }
  return value;
}

/**
 * kind "stat-session": one stretch of reading of one book on one device (decided
 * 2026-11-10, fix option 1 for the same-day loss). Only the device in the id writes
 * it (owner), so no other device can overwrite its reading. The device updates it
 * while the session is open and finally writes it with `closed: true`; after that
 * the server refuses every change (sealed). Never deleted: mistakes are corrected
 * with "stat-session-fix". Day totals are sums of sessions.
 *   day            the day key (YYYY-MM-DD) under the day boundary in effect when written
 *   seconds, chars tracked time and characters; lookups = dictionary popups opened
 *   readThroughId  the book's current read-through when it started (null = the first)
 *   source         tracker | completion ("Complete Book" adding the characters left:
 *                  characters only, never time or speed)
 */
const statSessionKind: KindSpec = {
  policy: () => 'owner',
  ownerOf: (id) => parseStatSessionId(id)?.deviceId ?? null,
  deletable: false,
  validate(id, data, _deleted, ctx) {
    const parsed = parseStatSessionId(id);
    if (!parsed) {
      throw new RecordError('invalid_id', 'stat-session ids are <bookId>:<deviceId>:<uuid>');
    }
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    const obj = requireObject(data);
    if (typeof obj.day !== 'string' || !DATE_KEY_RE.test(obj.day)) {
      throw new RecordError('invalid_data', 'day must be YYYY-MM-DD');
    }
    const startedAt = timestamp(obj.startedAt, 'startedAt');
    const endedAt = timestamp(obj.endedAt, 'endedAt');
    if (endedAt < startedAt) throw new RecordError('invalid_data', 'endedAt is before startedAt');
    const source = oneOf(obj.source, STAT_SESSION_SOURCES, 'source');
    const seconds = boundedWhole(obj.seconds, 'seconds', MAX_SESSION_SECONDS);
    const chars = boundedWhole(obj.chars, 'chars', MAX_SESSION_CHARS);
    const lookups = boundedWhole(obj.lookups, 'lookups', MAX_SESSION_LOOKUPS);
    if (source === 'completion' && (seconds !== 0 || lookups !== 0)) {
      throw new RecordError('invalid_data', 'a completion session has characters only');
    }
    const readThroughId = obj.readThroughId ?? null;
    if (readThroughId !== null) {
      const rt = typeof readThroughId === 'string' ? parseReadThroughId(readThroughId) : null;
      if (!rt || rt.bookId !== parsed.bookId) {
        throw new RecordError('invalid_data', "readThroughId must be null or this book's");
      }
    }
    return {
      bookId: parsed.bookId,
      data: {
        day: obj.day,
        startedAt,
        endedAt,
        seconds,
        chars,
        lookups,
        readThroughId,
        source,
        closed: bool(obj.closed, 'closed'),
      },
    };
  },
  checkReplace(_next, _deleted, existing) {
    if (existing.data.closed === true) {
      throw new RecordError('session_sealed', 'This session is closed and can no longer change');
    }
  },
};

/**
 * kind "stat-session-fix": id = the session's id, a correction any device may make
 * (decided with the user, WP12 plan): `{excluded: true}` leaves the session out of
 * every total; `seconds` / `chars` replace its numbers; `{deleted: true}` (the Stats
 * page's Delete, 2026-11-22) hides the session from the log and every total. The
 * session itself is never changed. Deleting the record undoes the correction. The
 * session need not have arrived yet (records of one push come in any order).
 */
const statSessionFixKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseStatSessionId(id);
    if (!parsed) {
      throw new RecordError('invalid_id', 'stat-session-fix ids are the session id');
    }
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const obj = requireObject(data);
    const out: Record<string, unknown> = {};
    if (obj.excluded !== undefined) {
      if (obj.excluded !== true) throw new RecordError('invalid_data', 'excluded must be true');
      out.excluded = true;
    }
    if (obj.deleted !== undefined) {
      if (obj.deleted !== true) throw new RecordError('invalid_data', 'deleted must be true');
      out.deleted = true;
    }
    if (obj.seconds !== undefined) {
      out.seconds = boundedWhole(obj.seconds, 'seconds', MAX_SESSION_SECONDS);
    }
    if (obj.chars !== undefined) out.chars = boundedWhole(obj.chars, 'chars', MAX_SESSION_CHARS);
    if (!Object.keys(out).length) {
      throw new RecordError('invalid_data', 'a fix needs excluded, deleted, seconds or chars');
    }
    return { bookId: parsed.bookId, data: out };
  },
};

export const STAT_GOAL_METRICS = ['time', 'chars', 'speed'] as const;
export const STAT_GOAL_PERIODS = ['day', 'week', 'month'] as const;
const MAX_GOAL_TARGET = 1_000_000_000;

/**
 * kind "stat-goal" (WP12c): id = a UUID, lww, deletable. One reading goal:
 *   metric     time (target in seconds) | chars | speed (characters per hour)
 *   period     day | week | month (calendar periods under the global day boundary and
 *              week start)
 *   startedOn  the first day of the first period it applies to
 *   endedOn    the last day it applies to (null = still active). Changing a goal ends
 *              it and starts a new one, so past periods keep their target.
 * Several goals can be active at once. The old "reading-goal" records are untouched.
 */
const statGoalKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'stat-goal ids are UUIDs');
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    const startedOn = dateOrNull(obj.startedOn, 'startedOn');
    if (!startedOn) throw new RecordError('invalid_data', 'startedOn must be YYYY-MM-DD');
    const endedOn = dateOrNull(obj.endedOn, 'endedOn');
    if (endedOn !== null && endedOn < startedOn) {
      throw new RecordError('invalid_data', 'endedOn is before startedOn');
    }
    const target = obj.target;
    if (
      typeof target !== 'number' ||
      !Number.isInteger(target) ||
      target < 1 ||
      target > MAX_GOAL_TARGET
    ) {
      throw new RecordError('invalid_data', 'target must be a whole number from 1');
    }
    return {
      bookId: null,
      data: {
        metric: oneOf(obj.metric, STAT_GOAL_METRICS, 'metric'),
        period: oneOf(obj.period, STAT_GOAL_PERIODS, 'period'),
        target,
        startedOn,
        endedOn,
        createdAt: timestamp(obj.createdAt, 'createdAt'),
      },
    };
  },
};

/** Smart-collection queries are checked with the search box's own parser. */
const parserCheck: QueryCheck = (query) => {
  const result = parseQuery(query);
  return result.ok ? null : result.error.message;
};

// ---------------------------------------------------------------------------
// WP15c: whispersync's playback position and book attachments
// ---------------------------------------------------------------------------

/** Longest playback position accepted (a day of audio, in seconds, is far beyond any book). */
const MAX_PLAYBACK_SECONDS = 7 * 24 * 3600;

/**
 * kind "audiobook-position": id = the book id, lww (the newest position wins, as with
 * the old sync), deletable ("Reset all" in whispersync). data { position (seconds),
 * modifiedAt (when the device saved it) }.
 */
const audiobookPositionKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the book id');
    if (!bookExists(ctx, id)) throw new RecordError('unknown_book', `No book ${id}`);
    if (deleted) return { bookId: id, data: {} };
    const obj = requireObject(data);
    const position = finiteNumber(obj.position, 'position');
    if (position < 0 || position > MAX_PLAYBACK_SECONDS) {
      throw new RecordError('invalid_data', 'position must be 0 or more seconds');
    }
    return { bookId: id, data: { position, modifiedAt: timestamp(obj.modifiedAt, 'modifiedAt') } };
  },
};

export const BOOK_ATTACHMENT_KIND = 'book-attachment';
export const BOOK_ATTACHMENT_NAMES = ['whispersync-subtitles', 'whispersync-match'] as const;

export function attachmentRecordId(bookId: string, name: string): string {
  return `${bookId}:${name}`;
}

export function parseAttachmentId(id: string): { bookId: string; name: string } | null {
  const i = id.indexOf(':');
  if (i < 0) return null;
  const bookId = id.slice(0, i);
  const name = id.slice(i + 1);
  if (!UUID_RE.test(bookId) || !(BOOK_ATTACHMENT_NAMES as readonly string[]).includes(name)) {
    return null;
  }
  return { bookId, name };
}

/**
 * kind "book-attachment": id = <bookId>:<name>, lww, deletable. data { size, sha256,
 * modifiedAt }. Written by the server when a device uploads the file
 * (PUT /api/v1/books/:id/attachments/:name). Devices may delete it (a reset, on every
 * device) or restore it, but the data must be exactly the stored file's.
 */
const bookAttachmentKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    const parsed = parseAttachmentId(id);
    if (!parsed) throw new RecordError('invalid_id', 'ids are <book id>:<attachment name>');
    if (!bookExists(ctx, parsed.bookId)) {
      throw new RecordError('unknown_book', `No book ${parsed.bookId}`);
    }
    if (deleted) return { bookId: parsed.bookId, data: {} };
    const row = ctx.db
      .prepare(
        'SELECT size, sha256, modified_at FROM book_attachments WHERE user_id = ? AND book_id = ? AND name = ?',
      )
      .get(ctx.userId, parsed.bookId, parsed.name) as
      | { size: number; sha256: string; modified_at: number }
      | undefined;
    if (!row) throw new RecordError('unknown_attachment', `No uploaded file for ${id}`);
    const obj = requireObject(data);
    const expected = { size: row.size, sha256: row.sha256, modifiedAt: row.modified_at };
    for (const [key, value] of Object.entries(expected)) {
      if (obj[key] !== value) {
        throw new RecordError('invalid_data', `${key} must be the uploaded file's`);
      }
    }
    return { bookId: parsed.bookId, data: expected };
  },
};

/**
 * kind "book-summary" (book summaries session 3): id = the book id, lww. What every device
 * knows of the book's summary: { summary: { id, origin, setup, models, lang, madeAt, editedAt,
 * background, langs: { <lang>: <digest> } } | null, making, outcome, note }. Written only by the
 * summaries' server device (user_seeds "summaries-device"); the summary itself is fetched over
 * REST (/api/v1/summaries/:bookId) because it is larger than a record may be.
 */
const bookSummaryKind: KindSpec = {
  policy: () => 'lww',
  deletable: false,
  validate(id, data, _deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the book id');
    const own = ctx.db
      .prepare(
        `SELECT 1 FROM user_seeds WHERE user_id = ? AND name = 'summaries-device' AND device_id = ?`,
      )
      .get(ctx.userId, ctx.deviceId);
    if (!own) throw new RecordError('read_only', 'Book summaries are written by the server');
    return { bookId: bookExists(ctx, id) ? id : null, data: requireObject(data) };
  },
};

/**
 * kind "series-recap" (book summaries session 5): id = the series name, lww. What every device
 * knows of a series' "story so far": { series, recap: { id, lang, madeAt, volumes, langs } | null,
 * making, phase, since, due, outcome, note }. Written only by the summaries' server device; the
 * recap itself is fetched over REST (/api/v1/summaries/series-recap?series=).
 */
const seriesRecapKind: KindSpec = {
  policy: () => 'lww',
  deletable: false,
  validate(id, data, _deleted, ctx) {
    if (!id.trim()) throw new RecordError('invalid_id', 'ids are the series name');
    const own = ctx.db
      .prepare(
        `SELECT 1 FROM user_seeds WHERE user_id = ? AND name = 'summaries-device' AND device_id = ?`,
      )
      .get(ctx.userId, ctx.deviceId);
    if (!own) throw new RecordError('read_only', 'Series recaps are written by the server');
    return { bookId: null, data: requireObject(data) };
  },
};

/**
 * kind "summary-skip" (book summaries session 3): id = the book id, lww, data {}. Written by a
 * device when the bulk "Mark completed" was told not to make summaries, before the completions
 * (the same push): the server then makes no automatic summary for the book's first completion.
 */
const summarySkipKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, _data, deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the book id');
    if (!bookExists(ctx, id)) throw new RecordError('unknown_book', `No book ${id}`);
    void deleted;
    return { bookId: id, data: {} };
  },
};

// ---------------------------------------------------------------------------
// Search history (2026-11-24)
// ---------------------------------------------------------------------------

export const SEARCH_HISTORY_KIND = 'search-history';
/** Same as the library search box (QUERY_LIMITS.maxLength in the parser). */
export const MAX_LIBRARY_SEARCH = 500;
export const MAX_BOOK_SEARCH = 200;
export const MAX_SEARCH_TITLE = 200;
const SEARCH_HISTORY_ID_RE = /^(lib|book):[0-9a-f]{16}$/;
/** A book the catalog doesn't know: local:<deviceId>:<the device's own book id>. */
const LOCAL_BOOK_RE =
  /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,15}$/;

/**
 * kind "search-history": one record per remembered search, lww, deletable (a removed or
 * pruned search is a deletion marker, stored as {}, so no text is kept).
 *   lib:<hash>   the library search box, data { query, usedAt }
 *   book:<hash>  "Search in this book", data { query, book, title, usedAt }; `book` is the
 *                server book id, or local:<deviceId>:<id> for a book outside the catalog
 * The hash (16 hex, FNV-1a 64, made by the device) is of the search's key (and the book's),
 * so the same search on any device is the same record: it moves to the top, never twice.
 * The book is not checked against the catalog: a book that left Calibre is still a search.
 */
const searchHistoryKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    const match = SEARCH_HISTORY_ID_RE.exec(id);
    if (!match) throw new RecordError('invalid_id', 'ids are lib:<16 hex> or book:<16 hex>');
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    const scope = match[1];
    const max = scope === 'lib' ? MAX_LIBRARY_SEARCH : MAX_BOOK_SEARCH;
    const query = typeof obj.query === 'string' ? obj.query.trim() : '';
    if (query === '' || query.length > max) {
      throw new RecordError('invalid_data', `query must be 1-${max} characters`);
    }
    const usedAt = obj.usedAt;
    if (typeof usedAt !== 'number' || !Number.isFinite(usedAt) || usedAt < 0) {
      throw new RecordError('invalid_data', 'usedAt must be a time');
    }
    if (scope === 'lib') {
      if (obj.book !== undefined || obj.title !== undefined) {
        throw new RecordError('invalid_data', 'a library search has no book');
      }
      return { bookId: null, data: { query, usedAt } };
    }
    const book = obj.book;
    if (typeof book !== 'string' || !(UUID_RE.test(book) || LOCAL_BOOK_RE.test(book))) {
      throw new RecordError('invalid_data', 'book must be a book id or local:<device>:<id>');
    }
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (title.length > MAX_SEARCH_TITLE) {
      throw new RecordError('invalid_data', `title must be at most ${MAX_SEARCH_TITLE} characters`);
    }
    return { bookId: null, data: { query, book, title, usedAt } };
  },
};

// ---------------------------------------------------------------------------
// Recently viewed (2026-11-24, docs/design/recently-viewed.md)
// ---------------------------------------------------------------------------

export const RECENTLY_VIEWED_KIND = 'recently-viewed';

/**
 * kind "recently-viewed": one record per book whose details page was viewed, lww,
 * deletable (a removed, cleared or trimmed book is a deletion marker stored as {}).
 * id = the server book id; data { viewedAt } only: the card comes from the catalog, so no
 * title is kept. The book is not checked against the catalog: one that left the library
 * simply isn't shown.
 */
const recentlyViewedKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are book ids');
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    const keys = Object.keys(obj);
    if (keys.some((k) => k !== 'viewedAt')) {
      throw new RecordError('invalid_data', 'only viewedAt is stored');
    }
    const viewedAt = obj.viewedAt;
    if (typeof viewedAt !== 'number' || !Number.isFinite(viewedAt) || viewedAt < 0) {
      throw new RecordError('invalid_data', 'viewedAt must be a time');
    }
    return { bookId: null, data: { viewedAt } };
  },
};

// ---------------------------------------------------------------------------
// Next in your series (2026-11-25, docs/design/next-in-series.md)
// ---------------------------------------------------------------------------

/** The same name as catalog/next-in-series.ts SERIES_NEXT_HIDE_KIND. */
export const SERIES_NEXT_HIDE_KIND = 'series-next-hide';
const SERIES_NEXT_HIDE_ID_RE = /^[0-9a-f]{16}$/;
const MAX_HIDE_NAME = 1000;

/**
 * kind "series-next-hide": a series hidden from Next in your series, lww, deletable (Show
 * again is a deletion marker stored as {}). id = FNV-1a 64 of "<library id>\0<series name>",
 * made by the device, so the same series is the same record on every device. data
 * { library, name, hiddenAt }: the series is matched by library and name (series ids are
 * not stable across devices), and Settings lists it by name. Neither is checked against the
 * catalog: a hidden series that is renamed or removed simply matches nothing.
 */
const seriesNextHideKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted) {
    if (!SERIES_NEXT_HIDE_ID_RE.test(id)) throw new RecordError('invalid_id', 'ids are 16 hex');
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    if (Object.keys(obj).some((k) => k !== 'library' && k !== 'name' && k !== 'hiddenAt')) {
      throw new RecordError('invalid_data', 'only library, name and hiddenAt are stored');
    }
    const { library, name, hiddenAt } = obj;
    if (typeof library !== 'string' || library === '' || library.length > MAX_HIDE_NAME) {
      throw new RecordError('invalid_data', 'library must be a library id');
    }
    if (typeof name !== 'string' || name === '' || name.length > MAX_HIDE_NAME) {
      throw new RecordError('invalid_data', `name must be 1-${MAX_HIDE_NAME} characters`);
    }
    if (typeof hiddenAt !== 'number' || !Number.isFinite(hiddenAt) || hiddenAt < 0) {
      throw new RecordError('invalid_data', 'hiddenAt must be a time');
    }
    return { bookId: null, data: { library, name, hiddenAt } };
  },
};

// ---------------------------------------------------------------------------
// Bookmeter sync (2026-11-25, docs/design/bookmeter-sync.md)
// ---------------------------------------------------------------------------

/**
 * kind "bookmeter-entry": one entry of a 読書メーター list, id `<account id>:<listing id>`, lww,
 * deletable (gone from Bookmeter). data { account, listing, list, date, title, authors, cover,
 * rank, books, target, how, statuses, wish }: `books` the reader books it matched (every copy),
 * `target` the copy a status goes on. Written only by the server's Bookmeter device
 * (user_seeds "bookmeter-device"); devices read it to apply statuses and for bookmeter: searches.
 */
const bookmeterEntryKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    if (!/^[0-9a-f-]{36}:\d{1,12}$/.test(id))
      throw new RecordError('invalid_id', 'ids are <account>:<listing>');
    const own = ctx.db
      .prepare(
        `SELECT 1 FROM user_seeds WHERE user_id = ? AND name = 'bookmeter-device' AND device_id = ?`,
      )
      .get(ctx.userId, ctx.deviceId);
    if (!own) throw new RecordError('read_only', 'Bookmeter entries are written by the server');
    if (deleted) return { bookId: null, data: {} };
    return { bookId: null, data: requireObject(data) };
  },
};

/** held: left unticked in Review: still waiting, never applied without asking. */
const BOOKMETER_APPLIED_OUTCOMES = ['applied', 'skipped', 'held'] as const;

/**
 * kind "bookmeter-applied": a Bookmeter change a device applied to a book (or the user
 * skipped), so it happens once on any device. id = the book id, lww. data { account, listing,
 * list: read|reading, date (YYYY-MM-DD or null), outcome: applied|skipped|held, at }.
 */
const bookmeterAppliedKind: KindSpec = {
  policy: () => 'lww',
  deletable: false,
  validate(id, data, _deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the book id');
    const obj = requireObject(data);
    const keys = new Set(['account', 'listing', 'list', 'date', 'outcome', 'at']);
    if (Object.keys(obj).some((k) => !keys.has(k)))
      throw new RecordError('invalid_data', 'only account, listing, list, date, outcome and at');
    if (typeof obj.account !== 'string' || !UUID_RE.test(obj.account))
      throw new RecordError('invalid_data', 'account must be an account id');
    if (typeof obj.listing !== 'string' || !/^\d{1,12}$/.test(obj.listing))
      throw new RecordError('invalid_data', 'listing must be a Bookmeter listing id');
    const list = oneOf(obj.list, ['read', 'reading'] as const, 'list');
    const date = dateOrNull(obj.date, 'date');
    const outcome = oneOf(obj.outcome, BOOKMETER_APPLIED_OUTCOMES, 'outcome');
    if (typeof obj.at !== 'number' || !Number.isFinite(obj.at) || obj.at < 0)
      throw new RecordError('invalid_data', 'at must be a time');
    return {
      bookId: bookExists(ctx, id) ? id : null,
      data: { account: obj.account, listing: obj.listing, list, date, outcome, at: obj.at },
    };
  },
};

export const DEVICE_BOOKS_KIND = 'device-books';

/**
 * kind "device-books" (WP15e): id = a device id, owner (only that device writes it),
 * deletable. data { bookIds }: the library book ids whose copy that device stores, so the
 * built-in "On this device" (on:device) can be answered for the device that asks. Ids
 * are not checked against the catalog: a book that left Calibre simply matches nothing.
 *
 * Season 2 Phase 9: optional `audioBookIds`, the books of `bookIds` whose linked audio
 * that device has downloaded (on:audio). Ids not in `bookIds` are dropped (a device
 * downloads audio only for a book it stores). Left out when absent, so a device on an
 * older version keeps writing the WP15e shape.
 */
const deviceBooksKind: KindSpec = {
  policy: () => 'owner',
  ownerOf: (id) => (UUID_RE.test(id) ? id : null),
  deletable: true,
  validate(id, data, deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'ids are the device id');
    if (!deviceExists(ctx, id)) throw new RecordError('unknown_device', `No device ${id}`);
    if (deleted) return { bookId: null, data: {} };
    const { bookIds, audioBookIds } = requireObject(data);
    const isIdList = (list: unknown): list is string[] =>
      Array.isArray(list) && list.every((b) => typeof b === 'string' && UUID_RE.test(b));
    if (!isIdList(bookIds)) {
      throw new RecordError('invalid_data', 'bookIds must be a list of book ids');
    }
    const books = [...new Set(bookIds)].sort();
    if (audioBookIds === undefined) return { bookId: null, data: { bookIds: books } };
    if (!isIdList(audioBookIds)) {
      throw new RecordError('invalid_data', 'audioBookIds must be a list of book ids');
    }
    const stored = new Set(books);
    const audio = [...new Set(audioBookIds)].filter((b) => stored.has(b)).sort();
    return { bookId: null, data: { bookIds: books, audioBookIds: audio } };
  },
};

export const DEFAULT_KINDS: KindRegistry = {
  device: deviceKind,
  setting: settingKind,
  position: positionKind,
  'legacy-book': legacyBookKind,
  'stat-day': statDayKind,
  'reading-goal': readingGoalKind,
  migration: migrationKind,
  'book-status': bookStatusKind,
  'book-favorite': perBookKind('favorite', (v) => bool(v, 'favorite')),
  'book-blur': perBookKind('blur', (v) => oneOf(v, BOOK_BLURS, 'blur')),
  'read-through': readThroughKind,
  'tag-blur': tagBlurKind,
  'blur-rule': blurRuleKind,
  collection: collectionKind(parserCheck),
  'collection-item': collectionItemKind,
  highlight: highlightKind,
  note: noteKind,
  bookmark: bookmarkKind,
  font: fontKind,
  'stat-session': statSessionKind,
  'stat-session-fix': statSessionFixKind,
  'stat-goal': statGoalKind,
  'audiobook-position': audiobookPositionKind,
  [BOOK_ATTACHMENT_KIND]: bookAttachmentKind,
  [DEVICE_BOOKS_KIND]: deviceBooksKind,
  'book-summary': bookSummaryKind,
  'summary-skip': summarySkipKind,
  'series-recap': seriesRecapKind,
  [SEARCH_HISTORY_KIND]: searchHistoryKind,
  [RECENTLY_VIEWED_KIND]: recentlyViewedKind,
  [SERIES_NEXT_HIDE_KIND]: seriesNextHideKind,
  'bookmeter-entry': bookmeterEntryKind,
  'bookmeter-applied': bookmeterAppliedKind,
};
