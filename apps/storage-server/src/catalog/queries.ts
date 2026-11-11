/**
 * All catalog reads for the API go through this module.
 *
 * The catalog (libraries, books, sources) is shared by all users (decisions.md,
 * WP2). Every function takes the requesting user so that per-user library
 * visibility (a user_libraries table, planned with multi-user support) can be
 * added here, in one place.
 */
import type Database from 'better-sqlite3';
import { getIndexState, Library, LibraryIndexState, listLibraries } from '../calibre/libraries';
import { countTotalsByLibrary, CountTotals, SQL_COUNT_SOURCE_KEY } from '../counts/count-records';
import { getOrCreateSecret, sign, THUMBNAIL_URL_SECRET, verify } from '../db/secrets';
import { sourceKey, thumbnailVersion } from '../thumbnails/thumbnails';
import { parseOrThrow, usesRegex } from './query-parser';
import { registerRegexp } from './regexp';
import { querySql, setPrefix, type SqlCondition } from './search-sql';
import {
  type BookSort,
  DEFAULT_BOOK_SORT,
  encodeSortCursor,
  sortCursorSql,
  sortOrderSql,
} from './sort';

export interface CatalogUser {
  id: string;
}

export interface LibraryView extends Library {
  index: LibraryIndexState;
  /** Character counts of the library's books (WP3b). */
  counts: CountTotals;
}

/**
 * - counted: charCount is the count of the book's current EPUB.
 * - pending: not counted yet, or the EPUB changed since; charCount is null or the
 *   previous count.
 * - error: the current EPUB could not be counted; charCount is null.
 */
export type CharCountStatus = 'counted' | 'pending' | 'error';

export interface BookSummary {
  id: string;
  libraryId: string;
  title: string;
  titleSort: string | null;
  authors: { name: string; sort: string | null }[];
  authorSort: string | null;
  series: { name: string; index: number | null } | null;
  tags: string[];
  publisher: string | null;
  publishedAt: number | null;
  addedAt: number;
  charCount: number | null;
  charCountStatus: CharCountStatus;
  missing: boolean;
  /** Where the book comes from: a Calibre library, or an upload (WP7b, "Uploaded" badge). */
  source: 'calibre' | 'upload';
  /**
   * Relative API URL of the cover thumbnail, or null when the book has no cover.
   * The URL is signed for this user, so a plain <img> can load it without the token.
   */
  thumbnail: string | null;
}

export interface BookSourceView {
  kind: 'calibre' | 'upload';
  libraryId: string;
  calibreUuid: string | null;
  calibreId: number | null;
  filePath: string | null;
  fileSize: number | null;
  missingAt: number | null;
}

export interface BookDetail extends BookSummary {
  description: string | null;
  sources: BookSourceView[];
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** `countSpec`: the counter's current spec (null when counting is unavailable). */
export function listLibrariesFor(
  db: Database.Database,
  _user: CatalogUser,
  countSpec: string | null = null,
): LibraryView[] {
  const totals = countTotalsByLibrary(db, countSpec);
  return listLibraries(db).map((lib) => ({
    ...lib,
    index: getIndexState(db, lib.id),
    counts: totals.get(lib.id) ?? { counted: 0, pending: 0, errors: 0 },
  }));
}

interface BookRow {
  id: string;
  library_id: string;
  title: string;
  title_sort: string | null;
  author_sort: string | null;
  series_name: string | null;
  series_index: number | null;
  publisher: string | null;
  published_at: number | null;
  added_at: number;
  char_count: number | null;
  description: string | null;
  missing: number;
  has_cover: number;
  source_kind: 'calibre' | 'upload';
  calibre_path: string | null;
  content_hash: string | null;
  calibre_last_modified: number | null;
  count_status: 'ok' | 'error' | null;
  count_spec: string | null;
  count_key_current: number | null;
}

/**
 * The sources a catalog book is shown through: Calibre (WP2) and uploads (WP7b). A
 * book has exactly one source ("Use the library copy" never adds an upload to an
 * existing book), so joining on it never repeats a book.
 */
export const SQL_CATALOG_SOURCE = "s.kind IN ('calibre', 'upload')";

// A book is shown through its one source.
// CROSS JOIN makes SQLite walk books first (books_added index, already in page
// order) instead of every Calibre source followed by a sort: on 60k books the
// first page drops from ~580 ms to ~1 ms (WP6 benchmark).
const BOOK_SELECT = `
  SELECT b.id, b.library_id, b.title, b.title_sort, b.author_sort, se.name AS series_name,
         b.series_index, b.publisher, b.published_at, b.added_at, b.char_count, b.description,
         (s.missing_at IS NOT NULL) AS missing, s.has_cover, s.kind AS source_kind,
         s.calibre_path, s.content_hash, s.calibre_last_modified, c.status AS count_status, c.spec AS count_spec,
         (c.source_key = ${SQL_COUNT_SOURCE_KEY}) AS count_key_current
  FROM books b
  CROSS JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
  JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
  LEFT JOIN series se ON se.id = b.series_id
  LEFT JOIN char_counts c ON c.book_id = b.id`;

function charCountStatus(r: BookRow, countSpec: string | null): CharCountStatus {
  if (!r.count_status || r.count_key_current !== 1) return 'pending';
  if (countSpec !== null && r.count_spec !== countSpec) return 'pending';
  return r.count_status === 'ok' ? 'counted' : 'error';
}

function thumbnailMessage(userId: string, bookId: string, version: string): string {
  return `${userId}:${bookId}:${version}`;
}

/** Signed thumbnail URL: the signature unlocks only this book's thumbnail at this version. */
function thumbnailUrl(key: Buffer, user: CatalogUser, bookId: string, version: string): string {
  const sig = sign(key, thumbnailMessage(user.id, bookId, version));
  return `/api/v1/books/${bookId}/thumbnail?v=${version}&u=${encodeURIComponent(user.id)}&s=${sig}`;
}

/** Checks the u/v/s parameters of a thumbnail URL made by thumbnailUrl(). */
export function verifyThumbnailUrl(
  db: Database.Database,
  bookId: string,
  params: { u?: string; v?: string; s?: string },
): CatalogUser | null {
  if (!params.u || !params.v || !params.s) return null;
  const key = getOrCreateSecret(db, THUMBNAIL_URL_SECRET);
  return verify(key, thumbnailMessage(params.u, bookId, params.v), params.s)
    ? { id: params.u }
    : null;
}

function attachLists(
  db: Database.Database,
  user: CatalogUser,
  rows: BookRow[],
  countSpec: string | null,
): BookSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const inList = ids.map(() => '?').join(',');
  const authors = new Map<string, { name: string; sort: string | null }[]>();
  for (const a of db
    .prepare(
      `SELECT ba.book_id, a.name, a.sort FROM book_authors ba JOIN authors a ON a.id = ba.author_id
       WHERE ba.book_id IN (${inList}) ORDER BY ba.book_id, ba.position`,
    )
    .all(...ids) as { book_id: string; name: string; sort: string | null }[]) {
    const list = authors.get(a.book_id) ?? [];
    list.push({ name: a.name, sort: a.sort });
    authors.set(a.book_id, list);
  }
  const tags = new Map<string, string[]>();
  for (const t of db
    .prepare(
      `SELECT bt.book_id, t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.book_id IN (${inList}) ORDER BY bt.book_id, t.name`,
    )
    .all(...ids) as { book_id: string; name: string }[]) {
    const list = tags.get(t.book_id) ?? [];
    list.push(t.name);
    tags.set(t.book_id, list);
  }
  const key = getOrCreateSecret(db, THUMBNAIL_URL_SECRET);
  return rows.map((r) => ({
    id: r.id,
    libraryId: r.library_id,
    title: r.title,
    titleSort: r.title_sort,
    authors: authors.get(r.id) ?? [],
    authorSort: r.author_sort,
    series: r.series_name ? { name: r.series_name, index: r.series_index } : null,
    tags: tags.get(r.id) ?? [],
    publisher: r.publisher,
    publishedAt: r.published_at,
    addedAt: r.added_at,
    charCount: r.char_count,
    charCountStatus: charCountStatus(r, countSpec),
    missing: r.missing === 1,
    source: r.source_kind,
    thumbnail: r.has_cover
      ? thumbnailUrl(
          key,
          user,
          r.id,
          thumbnailVersion(
            sourceKey({
              lastModified: r.calibre_last_modified,
              calibrePath: r.calibre_path,
              contentHash: r.content_hash,
              hasCover: r.has_cover === 1,
            }),
          ),
        )
      : null,
  }));
}

export type GroupBy = 'series' | 'author' | 'tag';

/** One group of a browse tab: a series, author or tag by name; series null = "No series". */
export interface GroupRef {
  by: GroupBy;
  name: string | null;
}

export interface ListBooksOptions {
  libraryId?: string;
  /** Library search (WP7a, query-parser.ts). Plain text keeps the WP6 meaning. */
  query?: string;
  /**
   * A second search that must also match, parsed on its own (WP8b: a saved search or
   * built-in collection, with the search box applied inside it).
   */
  scope?: string;
  /** Only the books of one group; a series is ordered by series index (unless `sort` is set). */
  group?: GroupRef;
  /** Only the books of one of the user's manual collections (WP19a: sorted lists). */
  collection?: string;
  /** WP19a. Absent: newest added first (inside a series group: series order). */
  sort?: BookSort;
  limit?: number;
  cursor?: string;
  includeMissing?: boolean;
  /** The counter's current spec, for charCountStatus (null = any spec is current). */
  countSpec?: string | null;
}

export interface BookPage {
  books: BookSummary[];
  nextCursor: string | null;
}

export class InvalidCursorError extends Error {}

export function encodeCursor(values: (number | string)[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/** Decodes a cursor made by encodeCursor with the given element types. */
export function decodeCursor(cursor: string, shape: ('number' | 'string')[]): (number | string)[] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === shape.length &&
      value.every((v, i) => typeof v === shape[i])
    ) {
      return value;
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError('Invalid cursor');
}

export { likePattern } from './search-sql';

/** A query to run (on the main connection, or in the search worker when `regex`). */
export interface PlannedQuery<T> {
  sql: string;
  params: unknown[];
  /** Uses ttu_regexp(): run it through SearchRunner. */
  regex: boolean;
  finish(rows: unknown[]): T;
}

/** Membership of a book in a group, as a condition on `b`. */
export function groupMemberSql(group: GroupRef, db?: Database.Database): SqlCondition {
  // A big author or tag walks books in date order; a small one starts from its books
  // (search-sql.ts, SMALL_SET).
  const size = (sql: string) =>
    db ? (db.prepare(sql).get(group.name) as { n: number }).n : Infinity;
  switch (group.by) {
    case 'series':
      return group.name === null
        ? // "+" keeps SQLite walking books in date order (not ~20k NULL index entries + a sort).
          { sql: '+b.series_id IS NULL', params: [] }
        : { sql: 'b.series_id = (SELECT id FROM series WHERE name = ?)', params: [group.name] };
    case 'author':
      return {
        sql: `${setPrefix(size('SELECT COUNT(*) AS n FROM book_authors WHERE author_id = (SELECT id FROM authors WHERE name = ?)'))}b.id IN (SELECT book_id FROM book_authors
                       WHERE author_id = (SELECT id FROM authors WHERE name = ?))`,
        params: [group.name],
      };
    case 'tag':
      return {
        sql: `${setPrefix(size('SELECT COUNT(*) AS n FROM book_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?)'))}b.id IN (SELECT book_id FROM book_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?))`,
        params: [group.name],
      };
  }
}

/** The library and missing-book conditions every catalog list shares. */
export function visibilitySql(opts: {
  libraryId?: string;
  includeMissing?: boolean;
}): SqlCondition[] {
  const out: SqlCondition[] = [];
  if (opts.libraryId) out.push({ sql: 'b.library_id = ?', params: [opts.libraryId] });
  if (!opts.includeMissing) out.push({ sql: 's.missing_at IS NULL', params: [] });
  return out;
}

/** Membership of a book in one of the user's manual collections (live collection-item records). */
export function collectionMemberSql(userId: string, collectionId: string): SqlCondition {
  return {
    sql: `b.id IN (SELECT book_id FROM sync_records
                    WHERE user_id = ? AND kind = 'collection-item' AND id >= ? AND id < ?
                      AND deleted_at IS NULL AND book_id IS NOT NULL)`,
    params: [userId, `${collectionId}:`, `${collectionId};`],
  };
}

type ListFilter = Pick<
  ListBooksOptions,
  'libraryId' | 'query' | 'scope' | 'group' | 'collection' | 'includeMissing'
>;

/** The conditions of a list (everything but the cursor). Throws InvalidQueryError. */
function listConditions(
  db: Database.Database,
  user: CatalogUser,
  opts: ListFilter,
): { conds: SqlCondition[]; regex: boolean } {
  const parsed = parseOrThrow(opts.query);
  const scoped = opts.scope ? parseOrThrow(opts.scope) : null;
  const conds: SqlCondition[] = [...visibilitySql(opts)];
  if (opts.group) conds.push(groupMemberSql(opts.group, db));
  if (opts.collection) conds.push(collectionMemberSql(user.id, opts.collection));
  if (scoped) conds.push(...querySql(scoped, user.id, db));
  conds.push(...querySql(parsed, user.id, db));
  return { conds, regex: usesRegex(parsed) || (scoped !== null && usesRegex(scoped)) };
}

/**
 * Books newest-added first (inside a series: by series index), or in the given sort
 * (sort.ts), keyset-paginated. Only enabled libraries. Throws InvalidQueryError /
 * InvalidCursorError.
 */
export function planBooks(
  db: Database.Database,
  user: CatalogUser,
  opts: ListBooksOptions = {},
): PlannedQuery<BookPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const { conds, regex } = listConditions(db, user, opts);
  const bySeriesIndex = !opts.sort && opts.group?.by === 'series' && opts.group.name !== null;
  const sort = opts.sort ?? DEFAULT_BOOK_SORT;
  const order = bySeriesIndex
    ? 'ORDER BY IFNULL(b.series_index, -1), b.added_at, b.id'
    : sortOrderSql(sort);
  if (opts.cursor) {
    if (bySeriesIndex) {
      const [index, addedAt, id] = decodeCursor(opts.cursor, ['number', 'number', 'string']);
      conds.push({
        sql: `(IFNULL(b.series_index, -1) > ? OR (IFNULL(b.series_index, -1) = ?
                AND (b.added_at > ? OR (b.added_at = ? AND b.id > ?))))`,
        params: [index, index, addedAt, addedAt, id],
      });
    } else {
      conds.push(sortCursorSql(sort, opts.cursor));
    }
  }
  const where = conds.length ? `WHERE ${conds.map((c) => c.sql).join(' AND ')}` : '';
  return {
    sql: `${BOOK_SELECT} ${where} ${order} LIMIT ?`,
    params: [...conds.flatMap((c) => c.params), limit + 1],
    regex,
    finish(raw) {
      const rows = raw as BookRow[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      let nextCursor: string | null = null;
      if (rows.length > limit && last) {
        nextCursor = bySeriesIndex
          ? encodeCursor([last.series_index ?? -1, last.added_at, last.id])
          : encodeSortCursor(sort, last);
      }
      return { books: attachLists(db, user, page, opts.countSpec ?? null), nextCursor };
    },
  };
}

/**
 * How many books a list has (WP19a: "1,234 books"). It visits every match, so the API
 * caches it (catalog-routes.ts); a pattern search runs in the search worker like the list.
 */
export function planCount(
  db: Database.Database,
  user: CatalogUser,
  opts: ListFilter = {},
): PlannedQuery<{ count: number }> {
  const { conds, regex } = listConditions(db, user, opts);
  const where = conds.length ? `WHERE ${conds.map((c) => c.sql).join(' AND ')}` : '';
  return {
    sql: `SELECT COUNT(*) AS n ${SQL_BOOK_FROM} ${where}`,
    params: conds.flatMap((c) => c.params),
    regex,
    finish(raw) {
      const [row] = raw as { n: number }[];
      return { count: row?.n ?? 0 };
    },
  };
}

/** planBooks run on this connection (regexes unprotected; the API uses SearchRunner). */
export function listBooksFor(
  db: Database.Database,
  user: CatalogUser,
  opts: ListBooksOptions = {},
): BookPage {
  const plan = planBooks(db, user, opts);
  if (plan.regex) registerRegexp(db);
  return plan.finish(db.prepare(plan.sql).all(...plan.params));
}

/** Most ids one lookup takes (WP8b: a manual collection's books, a page at a time). */
export const MAX_LOOKUP_IDS = 200;

/**
 * The given books in the given order, leaving out the ones that are hidden (missing,
 * disabled library, unknown id) or don't match `query`. Throws InvalidQueryError.
 * `includeMissing` (WP12 stats: reading is kept for books removed from Calibre) keeps
 * missing books; they come back with `missing: true`.
 */
export function planLookup(
  db: Database.Database,
  user: CatalogUser,
  ids: string[],
  opts: { query?: string; countSpec?: string | null; includeMissing?: boolean } = {},
): PlannedQuery<{ books: BookSummary[] }> {
  const parsed = parseOrThrow(opts.query);
  const unique = [...new Set(ids)].slice(0, MAX_LOOKUP_IDS);
  const conds: SqlCondition[] = [
    ...visibilitySql({ includeMissing: opts.includeMissing }),
    {
      sql: unique.length ? `b.id IN (${unique.map(() => '?').join(',')})` : '0',
      params: unique,
    },
    ...querySql(parsed, user.id, db),
  ];
  return {
    sql: `${BOOK_SELECT} WHERE ${conds.map((c) => c.sql).join(' AND ')}`,
    params: conds.flatMap((c) => c.params),
    regex: usesRegex(parsed),
    finish(raw) {
      const order = new Map(unique.map((id, i) => [id, i]));
      const rows = (raw as BookRow[]).sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      );
      return { books: attachLists(db, user, rows, opts.countSpec ?? null) };
    },
  };
}

/** Summaries of the given visible books, by id (for collage tiles and covers). */
export function summariesByIds(
  db: Database.Database,
  user: CatalogUser,
  ids: string[],
  countSpec: string | null,
): Map<string, BookSummary> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(`${BOOK_SELECT} WHERE b.id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as BookRow[];
  return new Map(attachLists(db, user, rows, countSpec).map((b) => [b.id, b]));
}

export const SQL_BOOK_FROM = `
  FROM books b
  CROSS JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
  JOIN libraries l ON l.id = b.library_id AND l.enabled = 1`;

export function getBookFor(
  db: Database.Database,
  user: CatalogUser,
  bookId: string,
  countSpec: string | null = null,
): BookDetail | null {
  const row = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(bookId) as BookRow | undefined;
  if (!row) return null;
  const [summary] = attachLists(db, user, [row], countSpec);
  const sources = (
    db
      .prepare(
        `SELECT kind, library_id, calibre_uuid, calibre_id, file_path, file_size, missing_at
         FROM book_sources WHERE book_id = ? ORDER BY created_at`,
      )
      .all(bookId) as {
      kind: 'calibre' | 'upload';
      library_id: string;
      calibre_uuid: string | null;
      calibre_id: number | null;
      file_path: string | null;
      file_size: number | null;
      missing_at: number | null;
    }[]
  ).map((s) => ({
    kind: s.kind,
    libraryId: s.library_id,
    calibreUuid: s.calibre_uuid,
    calibreId: s.calibre_id,
    filePath: s.file_path,
    fileSize: s.file_size,
    missingAt: s.missing_at,
  }));
  return { ...summary, description: row.description, sources };
}

export interface BookFileLocation {
  /** 'upload': filePath is relative to DATA_DIR/.uploads (WP7b). */
  kind: 'calibre' | 'upload';
  contentHash: string | null;
  /** Library folder relative to CALIBRE_DIR ('' = the root itself). */
  libraryFolder: string;
  /** EPUB path relative to the library folder, forward slashes. */
  filePath: string;
  fileSize: number | null;
  calibreLastModified: number | null;
  missing: boolean;
}

/** Where a visible book's EPUB lives, or null when the book is unknown or not visible. */
export function getBookFileFor(
  db: Database.Database,
  _user: CatalogUser,
  bookId: string,
): BookFileLocation | null {
  const row = db
    .prepare(
      `SELECT s.kind, s.content_hash, l.folder, s.file_path, s.file_size,
              s.calibre_last_modified, (s.missing_at IS NOT NULL) AS missing
         FROM books b
         JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
         JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
        WHERE b.id = ?`,
    )
    .get(bookId) as
    | {
        kind: 'calibre' | 'upload';
        content_hash: string | null;
        folder: string;
        file_path: string | null;
        file_size: number | null;
        calibre_last_modified: number | null;
        missing: number;
      }
    | undefined;
  if (!row || !row.file_path) return null;
  return {
    kind: row.kind,
    contentHash: row.content_hash,
    libraryFolder: row.folder,
    filePath: row.file_path,
    fileSize: row.file_size,
    calibreLastModified: row.calibre_last_modified,
    missing: row.missing === 1,
  };
}
