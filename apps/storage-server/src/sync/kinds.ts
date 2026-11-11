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
}

/** What a font's record holds: exactly its `fonts` row. */
export function fontRecordData(row: FontRow): Record<string, unknown> {
  return {
    name: row.name,
    fileName: row.file_name,
    format: row.format,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

/**
 * kind "font": id = the font id, lww, deletable. data { name, fileName, format, size,
 * sha256, createdAt }. Written by the server when a font is uploaded
 * (POST /api/v1/fonts, as the uploading device). Devices may delete it (gone from
 * every device) or restore it, but the data must be exactly the stored font's: a
 * record without an uploaded file, or with another name or file, is refused.
 */
const fontKind: KindSpec = {
  policy: () => 'lww',
  deletable: true,
  validate(id, data, deleted, ctx) {
    if (!UUID_RE.test(id)) throw new RecordError('invalid_id', 'font ids are UUIDs');
    const row = ctx.db
      .prepare(
        'SELECT name, file_name, format, size, sha256, created_at FROM fonts WHERE id = ? AND user_id = ?',
      )
      .get(id, ctx.userId) as FontRow | undefined;
    if (!row) throw new RecordError('unknown_font', `No uploaded font ${id}`);
    if (deleted) return { bookId: null, data: {} };
    const obj = requireObject(data);
    const expected = fontRecordData(row);
    for (const [key, value] of Object.entries(expected)) {
      if (obj[key] !== value) {
        throw new RecordError('invalid_data', `${key} must be the uploaded font's`);
      }
    }
    return { bookId: null, data: expected };
  },
};

/** Smart-collection queries are checked with the search box's own parser. */
const parserCheck: QueryCheck = (query) => {
  const result = parseQuery(query);
  return result.ok ? null : result.error.message;
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
  collection: collectionKind(parserCheck),
  'collection-item': collectionItemKind,
  highlight: highlightKind,
  note: noteKind,
  bookmark: bookmarkKind,
  font: fontKind,
};
