/**
 * Reads a metadata.db SNAPSHOT (never the live file) and upserts its EPUB
 * books into the catalog.
 *
 * - Books are matched by (library, Calibre UUID); a book keeps its reader ID
 *   for as long as Calibre keeps the UUID.
 * - Metadata comes only from metadata.db, never from file or folder names.
 * - Only books with an EPUB format are indexed.
 * - Books that disappear are flagged missing, never deleted, so user data
 *   attached to them survives. They are un-flagged if they come back.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';

export const INGEST_BATCH_SIZE = 500;

export interface CalibreBook {
  calibreId: number;
  uuid: string;
  title: string;
  titleSort: string | null;
  authorSort: string | null;
  authors: { name: string; sort: string | null }[];
  series: { name: string; sort: string | null } | null;
  seriesIndex: number | null;
  tags: string[];
  description: string | null;
  publisher: string | null;
  publishedAt: number | null;
  addedAt: number;
  lastModified: number | null;
  path: string;
  filePath: string;
  fileSize: number | null;
  hasCover: boolean;
}

export interface IngestOptions {
  libraryId: string;
  maxMissingPercent: number;
  allowMassMissing: boolean;
  batchSize?: number;
  now?: number;
}

export interface IngestResult {
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Books without a Calibre UUID (can't be tracked, not indexed). */
  skippedNoUuid: number;
  missingMarked: number;
  /** Set when the mass-missing guard stopped missing-marking. */
  massMissingWarning: string | null;
  /** Books of this library currently present / flagged missing. */
  present: number;
  missing: number;
}

/**
 * Parses a Calibre timestamp ("2026-11-09 04:00:11.251060+00:00") to ms UTC.
 * Calibre's "undefined date" (year 101) and anything unparsable become null.
 */
export function parseCalibreDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const year = Number(y);
  if (year <= 101) return null;
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  let t = Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
    t -= sign * offset;
  }
  return Number.isNaN(t) ? null : t;
}

/** Calibre stores commas in author names as '|'. */
function authorName(name: string): string {
  return name.replace(/\|/g, ',');
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

interface CalibreBookRow {
  id: number;
  uuid: string | null;
  title: string;
  sort: string | null;
  author_sort: string | null;
  timestamp: string | null;
  pubdate: string | null;
  series_index: number | null;
  path: string;
  has_cover: number | null;
  last_modified: string | null;
  file_name: string;
  file_size: number | null;
}

function groupBy<T extends { book: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const list = map.get(row.book);
    if (list) list.push(row);
    else map.set(row.book, [row]);
  }
  return map;
}

/** Reads EPUB books from a Calibre metadata.db snapshot, in batches ordered by Calibre id. */
export class CalibreReader {
  private readonly db: Database.Database;

  constructor(snapshotFile: string) {
    this.db = new Database(snapshotFile, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  /** Number of books (any format) without a UUID. */
  countWithoutUuid(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM books b
           WHERE (b.uuid IS NULL OR b.uuid = '')
             AND EXISTS (SELECT 1 FROM data d WHERE d.book = b.id AND d.format = 'EPUB')`,
        )
        .get() as { n: number }
    ).n;
  }

  readBatch(afterId: number, limit: number): CalibreBook[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.uuid, b.title, b.sort, b.author_sort, b.timestamp, b.pubdate,
                b.series_index, b.path, b.has_cover, b.last_modified,
                d.name AS file_name, d.uncompressed_size AS file_size
         FROM books b JOIN data d ON d.book = b.id AND d.format = 'EPUB'
         WHERE b.id > ? AND b.uuid IS NOT NULL AND b.uuid <> ''
         ORDER BY b.id LIMIT ?`,
      )
      .all(afterId, limit) as CalibreBookRow[];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const inList = ids.map(() => '?').join(',');
    const authors = groupBy(
      this.db
        .prepare(
          `SELECT l.book, a.name, a.sort FROM books_authors_link l
           JOIN authors a ON a.id = l.author
           WHERE l.book IN (${inList}) ORDER BY l.book, l.id`,
        )
        .all(...ids) as { book: number; name: string; sort: string | null }[],
    );
    const tags = groupBy(
      this.db
        .prepare(
          `SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag
           WHERE l.book IN (${inList}) ORDER BY l.book, t.name`,
        )
        .all(...ids) as { book: number; name: string }[],
    );
    const series = groupBy(
      this.db
        .prepare(
          `SELECT l.book, s.name, s.sort FROM books_series_link l JOIN series s ON s.id = l.series
           WHERE l.book IN (${inList})`,
        )
        .all(...ids) as { book: number; name: string; sort: string | null }[],
    );
    const publishers = groupBy(
      this.db
        .prepare(
          `SELECT l.book, p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher
           WHERE l.book IN (${inList})`,
        )
        .all(...ids) as { book: number; name: string }[],
    );
    const comments = groupBy(
      this.db.prepare(`SELECT book, text FROM comments WHERE book IN (${inList})`).all(...ids) as {
        book: number;
        text: string;
      }[],
    );

    return rows.map((r): CalibreBook => {
      const s = series.get(r.id)?.[0];
      const lastModified = parseCalibreDate(r.last_modified);
      return {
        calibreId: r.id,
        uuid: r.uuid!,
        title: cleanText(r.title) ?? 'Unknown',
        titleSort: cleanText(r.sort),
        authorSort: cleanText(r.author_sort),
        authors: (authors.get(r.id) ?? []).map((a) => ({
          name: authorName(a.name),
          sort: cleanText(a.sort),
        })),
        series: s ? { name: s.name, sort: cleanText(s.sort) } : null,
        seriesIndex: s ? (r.series_index ?? 1) : null,
        tags: (tags.get(r.id) ?? []).map((t) => t.name),
        description: cleanText(comments.get(r.id)?.[0]?.text),
        publisher: cleanText(publishers.get(r.id)?.[0]?.name),
        publishedAt: parseCalibreDate(r.pubdate),
        addedAt: parseCalibreDate(r.timestamp) ?? lastModified ?? 0,
        lastModified,
        path: r.path,
        filePath: `${r.path}/${r.file_name}.epub`,
        fileSize: r.file_size,
        hasCover: r.has_cover === 1,
      };
    });
  }
}

export function metaHash(book: CalibreBook): string {
  return createHash('sha1').update(JSON.stringify(book)).digest('hex');
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Upserts every EPUB book of the snapshot into the catalog. Works in batches
 * (one transaction each) and yields between them so requests keep flowing.
 */
export async function ingestSnapshot(
  db: Database.Database,
  snapshotFile: string,
  opts: IngestOptions,
): Promise<IngestResult> {
  const { libraryId, maxMissingPercent, allowMassMissing } = opts;
  const batchSize = opts.batchSize ?? INGEST_BATCH_SIZE;
  const now = opts.now ?? Date.now();

  const presentBefore = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM book_sources
         WHERE library_id = ? AND kind = 'calibre' AND missing_at IS NULL`,
      )
      .get(libraryId) as { n: number }
  ).n;

  const findSource = db.prepare(
    `SELECT id, book_id, meta_hash, missing_at FROM book_sources
     WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ?`,
  );
  const insertBook = db.prepare(
    `INSERT INTO books (id, library_id, title, title_sort, author_sort, series_id, series_index,
       description, publisher, published_at, added_at, created_at, updated_at)
     VALUES (@id, @libraryId, @title, @titleSort, @authorSort, @seriesId, @seriesIndex,
       @description, @publisher, @publishedAt, @addedAt, @now, @now)`,
  );
  const updateBook = db.prepare(
    `UPDATE books SET library_id = @libraryId, title = @title, title_sort = @titleSort,
       author_sort = @authorSort, series_id = @seriesId, series_index = @seriesIndex,
       description = @description, publisher = @publisher, published_at = @publishedAt,
       added_at = @addedAt, updated_at = @now
     WHERE id = @id`,
  );
  const insertSource = db.prepare(
    `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, calibre_id,
       calibre_path, file_path, file_size, has_cover, calibre_last_modified, meta_hash,
       missing_at, created_at, updated_at)
     VALUES (@id, @bookId, 'calibre', @libraryId, @uuid, @calibreId, @path, @filePath,
       @fileSize, @hasCover, @lastModified, @metaHash, NULL, @now, @now)`,
  );
  const updateSource = db.prepare(
    `UPDATE book_sources SET calibre_id = @calibreId, calibre_path = @path,
       file_path = @filePath, file_size = @fileSize, has_cover = @hasCover,
       calibre_last_modified = @lastModified, meta_hash = @metaHash, missing_at = NULL,
       updated_at = @now
     WHERE id = @id`,
  );
  const upsertAuthor = db.prepare(
    `INSERT INTO authors (name, sort) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET sort = excluded.sort RETURNING id`,
  );
  const upsertSeries = db.prepare(
    `INSERT INTO series (name, sort) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET sort = excluded.sort RETURNING id`,
  );
  const upsertTag = db.prepare(
    `INSERT INTO tags (name) VALUES (?)
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  );
  const clearAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
  const linkAuthor = db.prepare(
    'INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)',
  );
  const clearTags = db.prepare('DELETE FROM book_tags WHERE book_id = ?');
  const linkTag = db.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)');

  const result: IngestResult = {
    total: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    skippedNoUuid: 0,
    missingMarked: 0,
    massMissingWarning: null,
    present: 0,
    missing: 0,
  };
  const seen = new Set<string>();

  const writeBook = (book: CalibreBook) => {
    const hash = metaHash(book);
    const existing = findSource.get(libraryId, book.uuid) as
      | { id: string; book_id: string; meta_hash: string | null; missing_at: number | null }
      | undefined;
    if (existing && existing.meta_hash === hash && existing.missing_at === null) {
      result.unchanged++;
      return;
    }

    const seriesId = book.series
      ? (upsertSeries.get(book.series.name, book.series.sort) as { id: number }).id
      : null;
    const bookId = existing?.book_id ?? randomUUID();
    const bookParams = {
      id: bookId,
      libraryId,
      title: book.title,
      titleSort: book.titleSort,
      authorSort: book.authorSort,
      seriesId,
      seriesIndex: book.seriesIndex,
      description: book.description,
      publisher: book.publisher,
      publishedAt: book.publishedAt,
      addedAt: book.addedAt,
      now,
    };
    const sourceParams = {
      bookId,
      libraryId,
      uuid: book.uuid,
      calibreId: book.calibreId,
      path: book.path,
      filePath: book.filePath,
      fileSize: book.fileSize,
      hasCover: book.hasCover ? 1 : 0,
      lastModified: book.lastModified,
      metaHash: hash,
      now,
    };
    if (existing) {
      updateBook.run(bookParams);
      updateSource.run({ ...sourceParams, id: existing.id });
      result.updated++;
    } else {
      insertBook.run(bookParams);
      insertSource.run({ ...sourceParams, id: randomUUID() });
      result.added++;
    }

    clearAuthors.run(bookId);
    book.authors.forEach((a, position) => {
      const { id } = upsertAuthor.get(a.name, a.sort) as { id: number };
      linkAuthor.run(bookId, id, position);
    });
    clearTags.run(bookId);
    for (const tag of book.tags) {
      const { id } = upsertTag.get(tag) as { id: number };
      linkTag.run(bookId, id);
    }
  };

  const reader = new CalibreReader(snapshotFile);
  try {
    result.skippedNoUuid = reader.countWithoutUuid();
    let afterId = 0;
    for (;;) {
      const batch = reader.readBatch(afterId, batchSize);
      if (batch.length === 0) break;
      db.transaction(() => {
        for (const book of batch) {
          seen.add(book.uuid);
          writeBook(book);
        }
      })();
      result.total += batch.length;
      afterId = batch[batch.length - 1].calibreId;
      await yieldToEventLoop();
    }
  } finally {
    reader.close();
  }

  // Flag books that are gone (never delete them).
  const present = db
    .prepare(
      `SELECT id, calibre_uuid FROM book_sources
       WHERE library_id = ? AND kind = 'calibre' AND missing_at IS NULL`,
    )
    .all(libraryId) as { id: string; calibre_uuid: string }[];
  const gone = present.filter((s) => !seen.has(s.calibre_uuid));
  const percent = presentBefore > 0 ? (gone.length / presentBefore) * 100 : 0;
  if (gone.length > 0 && percent > maxMissingPercent && !allowMassMissing) {
    result.massMissingWarning =
      `${gone.length} of ${presentBefore} books (${percent.toFixed(1)}%) are no longer in ` +
      `metadata.db, more than CALIBRE_MAX_MISSING_PERCENT=${maxMissingPercent}. They were NOT ` +
      'flagged missing. If this is intended, run: cli index run <library> --allow-mass-missing';
  } else if (gone.length > 0) {
    const markMissing = db.prepare(
      'UPDATE book_sources SET missing_at = ?, updated_at = ? WHERE id = ?',
    );
    db.transaction(() => {
      for (const s of gone) markMissing.run(now, now, s.id);
    })();
    result.missingMarked = gone.length;
  }

  // Drop names nothing refers to any more (catalog only; user data never points here).
  db.transaction(() => {
    db.prepare('DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors)').run();
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM book_tags)').run();
    db.prepare(
      'DELETE FROM series WHERE id NOT IN (SELECT series_id FROM books WHERE series_id IS NOT NULL)',
    ).run();
  })();

  const counts = db
    .prepare(
      `SELECT SUM(missing_at IS NULL) AS present, SUM(missing_at IS NOT NULL) AS missing
       FROM book_sources WHERE library_id = ? AND kind = 'calibre'`,
    )
    .get(libraryId) as { present: number | null; missing: number | null };
  result.present = counts.present ?? 0;
  result.missing = counts.missing ?? 0;
  return result;
}
