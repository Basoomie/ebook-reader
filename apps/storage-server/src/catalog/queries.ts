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
import { sourceKey, thumbnailVersion } from '../thumbnails/thumbnails';

export interface CatalogUser {
  id: string;
}

export interface LibraryView extends Library {
  index: LibraryIndexState;
}

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
  missing: boolean;
  /** Relative API URL of the cover thumbnail, or null when the book has no cover. */
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

export function listLibrariesFor(db: Database.Database, _user: CatalogUser): LibraryView[] {
  return listLibraries(db).map((lib) => ({ ...lib, index: getIndexState(db, lib.id) }));
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
  calibre_path: string;
  calibre_last_modified: number | null;
}

// A book is shown through its Calibre source (the only kind in WP2).
const BOOK_SELECT = `
  SELECT b.id, b.library_id, b.title, b.title_sort, b.author_sort, se.name AS series_name,
         b.series_index, b.publisher, b.published_at, b.added_at, b.char_count, b.description,
         (s.missing_at IS NOT NULL) AS missing, s.has_cover, s.calibre_path,
         s.calibre_last_modified
  FROM books b
  JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre'
  JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
  LEFT JOIN series se ON se.id = b.series_id`;

function attachLists(db: Database.Database, rows: BookRow[]): BookSummary[] {
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
    missing: r.missing === 1,
    thumbnail: r.has_cover
      ? `/api/v1/books/${r.id}/thumbnail?v=${thumbnailVersion(
          sourceKey({
            lastModified: r.calibre_last_modified,
            calibrePath: r.calibre_path,
            hasCover: r.has_cover === 1,
          }),
        )}`
      : null,
  }));
}

export interface ListBooksOptions {
  libraryId?: string;
  limit?: number;
  cursor?: string;
  includeMissing?: boolean;
}

export interface BookPage {
  books: BookSummary[];
  nextCursor: string | null;
}

export class InvalidCursorError extends Error {}

function encodeCursor(addedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([addedAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'string') {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError('Invalid cursor');
}

/** Books newest-added first, keyset-paginated. Only enabled libraries. */
export function listBooksFor(
  db: Database.Database,
  _user: CatalogUser,
  opts: ListBooksOptions = {},
): BookPage {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.libraryId) {
    where.push('b.library_id = ?');
    params.push(opts.libraryId);
  }
  if (!opts.includeMissing) where.push('s.missing_at IS NULL');
  if (opts.cursor) {
    const [addedAt, id] = decodeCursor(opts.cursor);
    where.push('(b.added_at < ? OR (b.added_at = ? AND b.id < ?))');
    params.push(addedAt, addedAt, id);
  }
  const rows = db
    .prepare(
      `${BOOK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY b.added_at DESC, b.id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as BookRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    books: attachLists(db, page),
    nextCursor: rows.length > limit && last ? encodeCursor(last.added_at, last.id) : null,
  };
}

export function getBookFor(
  db: Database.Database,
  _user: CatalogUser,
  bookId: string,
): BookDetail | null {
  const row = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(bookId) as BookRow | undefined;
  if (!row) return null;
  const [summary] = attachLists(db, [row]);
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
