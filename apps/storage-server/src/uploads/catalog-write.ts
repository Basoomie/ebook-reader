/**
 * Adds an uploaded book to the catalog (WP7b): one `books` row in the chosen library,
 * its authors and series, and one `book_sources` row of kind 'upload'. A book has
 * exactly one source: "Use the library copy" never adds an upload to an existing book.
 *
 * Existing author and series names are reused as they are (Calibre's sort values are
 * never overwritten). The indexer's ingest only touches kind 'calibre' sources, so a
 * re-index never updates, flags or deletes an uploaded book.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { noteCatalogWrite } from '../catalog/catalog-version';
import { foldForSearch } from '../catalog/fold';

export interface UploadedBookInput {
  bookId: string;
  libraryId: string;
  title: string;
  authors: string[];
  series: { name: string; index: number | null } | null;
  /** Stored path relative to DATA_DIR/.uploads. */
  filePath: string;
  fileSize: number;
  sha256: string;
  hasCover: boolean;
  now: number;
}

export function addUploadedBook(db: Database.Database, input: UploadedBookInput): void {
  const nameId = (table: 'authors' | 'series', name: string): number => {
    db.prepare(
      `INSERT INTO ${table} (name, sort, name_fold) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`,
    ).run(name, name, foldForSearch(name));
    return (db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name) as { id: number }).id;
  };
  db.transaction(() => {
    const seriesId = input.series ? nameId('series', input.series.name) : null;
    db.prepare(
      `INSERT INTO books (id, library_id, title, title_fold, title_sort, author_sort, series_id,
         series_index, description, publisher, published_at, added_at, created_at, updated_at)
       VALUES (@id, @libraryId, @title, @titleFold, @title, @authorSort, @seriesId,
         @seriesIndex, NULL, NULL, NULL, @now, @now, @now)`,
    ).run({
      id: input.bookId,
      libraryId: input.libraryId,
      title: input.title,
      titleFold: foldForSearch(input.title),
      authorSort: input.authors.length ? input.authors.join(' & ') : null,
      seriesId,
      seriesIndex: input.series?.index ?? null,
      now: input.now,
    });
    const link = db.prepare(
      'INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)',
    );
    input.authors.forEach((name, position) =>
      link.run(input.bookId, nameId('authors', name), position),
    );
    db.prepare(
      `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, calibre_id,
         calibre_path, file_path, file_size, has_cover, calibre_last_modified, meta_hash,
         content_hash, missing_at, created_at, updated_at)
       VALUES (?, ?, 'upload', ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(
      randomUUID(),
      input.bookId,
      input.libraryId,
      input.filePath,
      input.fileSize,
      input.hasCover ? 1 : 0,
      input.sha256,
      input.now,
      input.now,
    );
  })();
  noteCatalogWrite(db);
}
