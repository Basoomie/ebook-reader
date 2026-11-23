/**
 * A Calibre book as the reader's catalog (ttsu.db) holds it, in the edit form's values. Only
 * Calibre books can be edited (uploaded books stay parked: design 2026-11-23).
 */
import type Database from 'better-sqlite3';
import type { EditValues } from './fields';

export interface BookRef {
  bookId: string;
  libraryId: string;
  uuid: string;
  calibreId: number;
  title: string;
  path: string | null;
  hasCover: boolean;
  /** Calibre's last_modified the index last read (ms), null when unknown. */
  lastModified: number | null;
}

export function bookRef(main: Database.Database, bookId: string): BookRef | null {
  const r = main
    .prepare(
      `SELECT s.book_id, s.library_id, s.calibre_uuid, s.calibre_id, s.calibre_path, s.has_cover,
              s.calibre_last_modified, b.title
       FROM book_sources s JOIN books b ON b.id = s.book_id
       WHERE s.book_id = ? AND s.kind = 'calibre' AND s.missing_at IS NULL
       ORDER BY s.created_at LIMIT 1`,
    )
    .get(bookId) as
    | {
        book_id: string;
        library_id: string;
        calibre_uuid: string;
        calibre_id: number;
        calibre_path: string | null;
        has_cover: number | null;
        calibre_last_modified: number | null;
        title: string;
      }
    | undefined;
  if (!r || !r.calibre_uuid || r.calibre_id === null) return null;
  return {
    bookId: r.book_id,
    libraryId: r.library_id,
    uuid: r.calibre_uuid,
    calibreId: r.calibre_id,
    title: r.title,
    path: r.calibre_path,
    hasCover: r.has_cover === 1,
    lastModified: typeof r.calibre_last_modified === 'number' ? r.calibre_last_modified : null,
  };
}

/** The reader's book of a Calibre record (present), by its library and uuid. */
export function bookOfUuid(
  main: Database.Database,
  libraryId: string,
  uuid: string,
): string | null {
  const r = main
    .prepare(
      `SELECT book_id FROM book_sources
       WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ? AND missing_at IS NULL`,
    )
    .get(libraryId, uuid) as { book_id: string } | undefined;
  return r?.book_id ?? null;
}

/** The book's values as the index last read them from Calibre. */
export function catalogValues(main: Database.Database, bookId: string): EditValues | null {
  const b = main
    .prepare(
      `SELECT b.title, b.title_sort, b.author_sort, s.name AS series, b.series_index, b.publisher,
              b.published_at, b.description, b.rating, b.languages
       FROM books b LEFT JOIN series s ON s.id = b.series_id WHERE b.id = ?`,
    )
    .get(bookId) as
    | {
        title: string;
        title_sort: string | null;
        author_sort: string | null;
        series: string | null;
        series_index: number | null;
        publisher: string | null;
        published_at: number | null;
        description: string | null;
        rating: number | null;
        languages: string | null;
      }
    | undefined;
  if (!b) return null;
  const list = (sql: string) =>
    (main.prepare(sql).all(bookId) as { name: string }[]).map((r) => r.name);
  return {
    title: b.title,
    sort: b.title_sort ?? '',
    authors: list(
      `SELECT a.name FROM book_authors l JOIN authors a ON a.id = l.author_id
       WHERE l.book_id = ? ORDER BY l.position`,
    ),
    author_sort: b.author_sort ?? '',
    illustrator: list(
      `SELECT i.name FROM book_illustrators l JOIN illustrators i ON i.id = l.illustrator_id
       WHERE l.book_id = ? ORDER BY l.position`,
    ),
    series: b.series ? { name: b.series, index: b.series_index ?? 1 } : { name: null, index: null },
    publisher: b.publisher,
    pubdate: b.published_at,
    languages: b.languages ? (JSON.parse(b.languages) as string[]) : [],
    rating: b.rating && b.rating > 0 ? b.rating : null,
    description: b.description,
    tags: list(
      `SELECT t.name FROM book_tags l JOIN tags t ON t.id = l.tag_id WHERE l.book_id = ?
       ORDER BY t.name`,
    ),
    identifiers: Object.fromEntries(
      (
        main
          .prepare('SELECT type, value FROM book_identifiers WHERE book_id = ? ORDER BY type')
          .all(bookId) as { type: string; value: string }[]
      ).map((r) => [r.type, r.value]),
    ),
  };
}

/** The books (present) of a series, in its order, with what the series editor shows. */
export function seriesBooks(
  main: Database.Database,
  libraryId: string,
  name: string,
): {
  bookId: string;
  uuid: string;
  calibreId: number;
  title: string;
  index: number | null;
  firstAuthor: string;
}[] {
  return (
    main
      .prepare(
        `SELECT b.id AS book_id, s.calibre_uuid, s.calibre_id, b.title, b.series_index,
                (SELECT a.name FROM book_authors l JOIN authors a ON a.id = l.author_id
                 WHERE l.book_id = b.id ORDER BY l.position LIMIT 1) AS first_author
         FROM series se JOIN books b ON b.series_id = se.id
         JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre' AND s.missing_at IS NULL
         WHERE se.name = ? AND s.library_id = ?
         ORDER BY b.series_index, b.title`,
      )
      .all(name, libraryId) as {
      book_id: string;
      calibre_uuid: string;
      calibre_id: number;
      title: string;
      series_index: number | null;
      first_author: string | null;
    }[]
  ).map((r) => ({
    bookId: r.book_id,
    uuid: r.calibre_uuid,
    calibreId: r.calibre_id,
    title: r.title,
    index: r.series_index,
    firstAuthor: r.first_author ?? 'Unknown',
  }));
}
