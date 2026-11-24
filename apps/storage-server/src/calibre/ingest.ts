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
import { noteCatalogWrite } from '../catalog/catalog-version';
import { foldForSearch } from '../catalog/fold';

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
  /** Calibre's #illustrator column (several names, in Calibre's order); [] without the column. */
  illustrators: string[];
  /** Calibre's identifiers, type lower-cased -> value (amazon_jp, bookwalker, isbn, ...). */
  identifiers: Record<string, string>;
  description: string | null;
  publisher: string | null;
  publishedAt: number | null;
  addedAt: number;
  lastModified: number | null;
  path: string;
  filePath: string;
  fileSize: number | null;
  hasCover: boolean;
  /**
   * Calibre's rating, 0-10 (half stars; 9 = four and a half), null without one. Kept out of
   * metaHash (meta2Hash covers it) so adding it never rewrote the whole catalog.
   */
  rating?: number | null;
  /** Calibre's language codes in its order ("jpn"); kept out of metaHash like the rating. */
  languages?: string[];
}

export interface IngestOptions {
  libraryId: string;
  maxMissingPercent: number;
  allowMassMissing: boolean;
  batchSize?: number;
  now?: number;
  /**
   * The size and mtime of a book's cover.jpg ("size:mtimeMs"), read for books whose record
   * changed (the "changed in Calibre" check for covers); null when it can't be read.
   */
  coverSig?: (bookPath: string) => Promise<string | null>;
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

/** Calibre's identifiers as type (lower-cased) -> value; empty types or values are skipped. */
function identifierMap(rows: { type: string; val: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const type = cleanText(row.type)?.toLowerCase();
    const val = cleanText(row.val);
    if (type && val && !(type in out)) out[type] = val;
  }
  return out;
}

/** Reads EPUB books from a Calibre metadata.db snapshot, in batches ordered by Calibre id. */
export class CalibreReader {
  private readonly db: Database.Database;
  /** The #illustrator column's tables, found by label (the id differs per library), or null. */
  private readonly illustratorTables: { value: string; link: string } | null;
  private readonly hasIdentifiers: boolean;

  constructor(snapshotFile: string) {
    this.db = new Database(snapshotFile, { readonly: true, fileMustExist: true });
    this.illustratorTables = this.findIllustratorColumn();
    this.hasIdentifiers = this.tableExists('identifiers');
    this.hasRatings = this.tableExists('books_ratings_link') && this.tableExists('ratings');
    this.hasLanguages = this.tableExists('books_languages_link') && this.tableExists('languages');
  }

  private readonly hasRatings: boolean;
  private readonly hasLanguages: boolean;

  private tableExists(name: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
  }

  private findIllustratorColumn(): { value: string; link: string } | null {
    if (!this.tableExists('custom_columns')) return null;
    const col = this.db
      .prepare(`SELECT id FROM custom_columns WHERE label = 'illustrator'`)
      .get() as { id: number } | undefined;
    if (!col || !Number.isInteger(col.id)) return null;
    const value = `custom_column_${col.id}`;
    const link = `books_custom_column_${col.id}_link`;
    return this.tableExists(value) && this.tableExists(link) ? { value, link } : null;
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

    const illustrators = this.illustratorTables
      ? groupBy(
          this.db
            .prepare(
              `SELECT l.book, v.value FROM ${this.illustratorTables.link} l
               JOIN ${this.illustratorTables.value} v ON v.id = l.value
               WHERE l.book IN (${inList}) ORDER BY l.book, l.id`,
            )
            .all(...ids) as { book: number; value: string }[],
        )
      : new Map<number, { book: number; value: string }[]>();
    const identifiers = this.hasIdentifiers
      ? groupBy(
          this.db
            .prepare(
              `SELECT book, type, val FROM identifiers WHERE book IN (${inList}) ORDER BY book, type`,
            )
            .all(...ids) as { book: number; type: string; val: string }[],
        )
      : new Map<number, { book: number; type: string; val: string }[]>();

    const ratings = this.hasRatings
      ? groupBy(
          this.db
            .prepare(
              `SELECT l.book, r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating
               WHERE l.book IN (${inList})`,
            )
            .all(...ids) as { book: number; rating: number | null }[],
        )
      : new Map<number, { book: number; rating: number | null }[]>();
    const languages = this.hasLanguages
      ? groupBy(
          this.db
            .prepare(
              `SELECT l.book, g.lang_code FROM books_languages_link l
               JOIN languages g ON g.id = l.lang_code
               WHERE l.book IN (${inList}) ORDER BY l.book, l.item_order`,
            )
            .all(...ids) as { book: number; lang_code: string }[],
        )
      : new Map<number, { book: number; lang_code: string }[]>();

    return rows.map((r): CalibreBook => {
      const s = series.get(r.id)?.[0];
      const rating = ratings.get(r.id)?.[0]?.rating ?? null;
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
        illustrators: [
          ...new Set(
            (illustrators.get(r.id) ?? [])
              .map((v) => cleanText(authorName(v.value)))
              .filter((v): v is string => v !== null),
          ),
        ],
        identifiers: identifierMap(identifiers.get(r.id) ?? []),
        description: cleanText(comments.get(r.id)?.[0]?.text),
        publisher: cleanText(publishers.get(r.id)?.[0]?.name),
        publishedAt: parseCalibreDate(r.pubdate),
        addedAt: parseCalibreDate(r.timestamp) ?? lastModified ?? 0,
        lastModified,
        path: r.path,
        filePath: `${r.path}/${r.file_name}.epub`,
        fileSize: r.file_size,
        hasCover: r.has_cover === 1,
        rating: typeof rating === 'number' && rating > 0 ? Math.min(10, Math.round(rating)) : null,
        languages: (languages.get(r.id) ?? [])
          .map((l) => cleanText(l.lang_code))
          .filter((l): l is string => l !== null),
      };
    });
  }
}

/** The record's change hash, without the rating and languages (meta2Hash: migration 31). */
export function metaHash(book: CalibreBook): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rating, languages, ...rest } = book;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

/** The rating and the languages: a change hash of their own (migration 31). */
export function meta2Hash(book: CalibreBook): string {
  return createHash('sha1')
    .update(JSON.stringify([book.rating ?? null, book.languages ?? []]))
    .digest('hex');
}

/** A field the index saw change in Calibre (old and new as the catalog stores them). */
export interface FieldChange {
  field: string;
  old: unknown;
  new: unknown;
}

/** What the catalog holds of a book before the index writes Calibre's record over it. */
export interface StoredFields {
  title: string;
  titleSort: string | null;
  authorSort: string | null;
  authors: string[];
  illustrators: string[];
  series: string | null;
  seriesIndex: number | null;
  publisher: string | null;
  publishedAt: number | null;
  description: string | null;
  tags: string[];
  identifiers: Record<string, string>;
  /** undefined: not stored yet (the first index after migration 31). */
  rating?: number | null;
  languages?: string[];
  coverSig?: string | null;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedIds = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The fields that differ between what the catalog holds of a book and Calibre's record now,
 * named as the cleanup's proposals name them (title, sort, authors, author_sort, illustrator,
 * series, series_index, publisher, pubdate, description, tags, identifiers, rating, languages,
 * cover). Tags compare as a set, identifiers as a map; a field not stored yet never counts.
 */
export function diffBook(
  old: StoredFields,
  now: CalibreBook,
  coverSig: string | null | undefined,
): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: string, a: unknown, b: unknown) => {
    if (!sameJson(a, b)) out.push({ field, old: a, new: b });
  };
  add('title', old.title, now.title);
  add('sort', old.titleSort, now.titleSort);
  add(
    'authors',
    old.authors,
    now.authors.map((a) => a.name),
  );
  add('author_sort', old.authorSort, now.authorSort);
  add('illustrator', old.illustrators, now.illustrators);
  add('series', old.series, now.series?.name ?? null);
  if (old.series !== null && now.series !== null)
    add('series_index', old.seriesIndex, now.seriesIndex);
  add('publisher', old.publisher, now.publisher);
  add('pubdate', old.publishedAt, now.publishedAt);
  add('description', old.description, now.description);
  add('tags', [...old.tags].sort(), [...now.tags].sort());
  add('identifiers', sortedIds(old.identifiers), sortedIds(now.identifiers));
  if (old.rating !== undefined) add('rating', old.rating, now.rating ?? null);
  if (old.languages !== undefined) add('languages', old.languages, now.languages ?? []);
  if (old.coverSig && coverSig && old.coverSig !== 'none' && old.coverSig !== coverSig)
    out.push({ field: 'cover', old: old.coverSig, new: coverSig });
  return out;
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
    `SELECT id, book_id, meta_hash, meta2_hash, cover_sig, has_cover, calibre_last_modified, missing_at FROM book_sources
     WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ?`,
  );
  // Migration 31: the rating and languages, with their own hash (a light update when only they
  // changed or were never stored), and what changed per field for books already indexed.
  const updateMeta2 = db.prepare(
    `UPDATE books SET rating = @rating, languages = @languages WHERE id = @bookId`,
  );
  const updateMeta2Source = db.prepare(
    `UPDATE book_sources SET meta2_hash = @meta2, cover_sig = COALESCE(@coverSig, cover_sig)
     WHERE id = @id`,
  );
  const oldBook = db.prepare(
    `SELECT b.title, b.title_sort, b.author_sort, s.name AS series, b.series_index, b.publisher,
            b.published_at, b.description, b.rating, b.languages
     FROM books b LEFT JOIN series s ON s.id = b.series_id WHERE b.id = ?`,
  );
  const oldAuthors = db.prepare(
    `SELECT a.name FROM book_authors l JOIN authors a ON a.id = l.author_id
     WHERE l.book_id = ? ORDER BY l.position`,
  );
  const oldTags = db.prepare(
    'SELECT t.name FROM book_tags l JOIN tags t ON t.id = l.tag_id WHERE l.book_id = ?',
  );
  const oldIllustrators = db.prepare(
    `SELECT i.name FROM book_illustrators l JOIN illustrators i ON i.id = l.illustrator_id
     WHERE l.book_id = ? ORDER BY l.position`,
  );
  const oldIdentifiers = db.prepare('SELECT type, value FROM book_identifiers WHERE book_id = ?');
  const queueChange = db.prepare(
    `INSERT INTO calibre_field_changes (library_id, calibre_uuid, calibre_id, book_id, field,
       old_json, new_json, last_modified, before_modified, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const coverSigs = new Map<string, string | null>();
  const insertBook = db.prepare(
    `INSERT INTO books (id, library_id, title, title_fold, title_sort, author_sort, series_id,
       series_index, description, publisher, published_at, added_at, created_at, updated_at)
     VALUES (@id, @libraryId, @title, @titleFold, @titleSort, @authorSort, @seriesId,
       @seriesIndex, @description, @publisher, @publishedAt, @addedAt, @now, @now)`,
  );
  const updateBook = db.prepare(
    `UPDATE books SET library_id = @libraryId, title = @title, title_fold = @titleFold,
       title_sort = @titleSort, author_sort = @authorSort, series_id = @seriesId,
       series_index = @seriesIndex, description = @description, publisher = @publisher,
       published_at = @publishedAt, added_at = @addedAt, updated_at = @now
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
    `INSERT INTO authors (name, sort, name_fold) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET sort = excluded.sort, name_fold = excluded.name_fold
     RETURNING id`,
  );
  const upsertSeries = db.prepare(
    `INSERT INTO series (name, sort, name_fold) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET sort = excluded.sort, name_fold = excluded.name_fold
     RETURNING id`,
  );
  const upsertTag = db.prepare(
    `INSERT INTO tags (name, name_fold) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold
     RETURNING id`,
  );
  const clearAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
  const linkAuthor = db.prepare(
    'INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)',
  );
  const clearTags = db.prepare('DELETE FROM book_tags WHERE book_id = ?');
  const linkTag = db.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)');
  const upsertIllustrator = db.prepare(
    `INSERT INTO illustrators (name, name_fold) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET name_fold = excluded.name_fold
     RETURNING id`,
  );
  const clearIllustrators = db.prepare('DELETE FROM book_illustrators WHERE book_id = ?');
  const linkIllustrator = db.prepare(
    'INSERT INTO book_illustrators (book_id, illustrator_id, position) VALUES (?, ?, ?)',
  );
  const clearIdentifiers = db.prepare('DELETE FROM book_identifiers WHERE book_id = ?');
  const insertIdentifier = db.prepare(
    'INSERT OR REPLACE INTO book_identifiers (book_id, type, value) VALUES (?, ?, ?)',
  );

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

  type Existing = {
    id: string;
    book_id: string;
    meta_hash: string | null;
    meta2_hash: string | null;
    cover_sig: string | null;
    has_cover: number | null;
    calibre_last_modified: number | null;
    missing_at: number | null;
  };

  const recordChanges = (existing: Existing, book: CalibreBook) => {
    const ob = oldBook.get(existing.book_id) as
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
    if (!ob) return;
    const known = existing.meta2_hash !== null;
    const changes = diffBook(
      {
        title: ob.title,
        titleSort: ob.title_sort,
        authorSort: ob.author_sort,
        authors: (oldAuthors.all(existing.book_id) as { name: string }[]).map((a) => a.name),
        illustrators: (oldIllustrators.all(existing.book_id) as { name: string }[]).map(
          (a) => a.name,
        ),
        series: ob.series,
        seriesIndex: ob.series ? ob.series_index : null,
        publisher: ob.publisher,
        publishedAt: ob.published_at,
        description: ob.description,
        tags: (oldTags.all(existing.book_id) as { name: string }[]).map((t) => t.name),
        identifiers: Object.fromEntries(
          (oldIdentifiers.all(existing.book_id) as { type: string; value: string }[]).map((r) => [
            r.type,
            r.value,
          ]),
        ),
        rating: known ? ob.rating : undefined,
        languages: known ? (JSON.parse(ob.languages ?? '[]') as string[]) : undefined,
        // A cover added or taken away counts too ('nocover' on either side).
        coverSig: existing.has_cover === 1 ? existing.cover_sig : 'nocover',
      },
      book,
      book.hasCover ? coverSigs.get(book.uuid) : 'nocover',
    );
    for (const c of changes) {
      queueChange.run(
        libraryId,
        book.uuid,
        book.calibreId,
        existing.book_id,
        c.field,
        JSON.stringify(c.old ?? null),
        JSON.stringify(c.new ?? null),
        book.lastModified,
        existing.calibre_last_modified,
        now,
      );
    }
  };

  const writeBook = (book: CalibreBook) => {
    const hash = metaHash(book);
    const hash2 = meta2Hash(book);
    const existing = findSource.get(libraryId, book.uuid) as Existing | undefined;
    const meta2Params = {
      rating: book.rating ?? null,
      languages: JSON.stringify(book.languages ?? []),
    };
    if (existing && existing.meta_hash === hash && existing.missing_at === null) {
      if (existing.meta2_hash !== hash2) {
        // Only the rating or the languages changed (or were never stored: migration 31).
        if (existing.meta2_hash !== null) recordChanges(existing, book);
        updateMeta2.run({ ...meta2Params, bookId: existing.book_id });
        updateMeta2Source.run({ meta2: hash2, coverSig: null, id: existing.id });
        result.updated++;
        return;
      }
      result.unchanged++;
      return;
    }
    // What changed per field, for a book the catalog already has (never a new book or one
    // coming back from missing: nothing was changed there, it appeared). A source the cleanup
    // re-bound from another library (manga part A: its Calibre last_modified cleared) appeared
    // here too: its fields came along with the book, nobody changed them.
    if (existing && existing.missing_at === null && existing.calibre_last_modified !== null)
      recordChanges(existing, book);

    const seriesId = book.series
      ? (
          upsertSeries.get(book.series.name, book.series.sort, foldForSearch(book.series.name)) as {
            id: number;
          }
        ).id
      : null;
    const bookId = existing?.book_id ?? randomUUID();
    const bookParams = {
      id: bookId,
      libraryId,
      title: book.title,
      titleFold: foldForSearch(book.title),
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
      const { id } = upsertAuthor.get(a.name, a.sort, foldForSearch(a.name)) as { id: number };
      linkAuthor.run(bookId, id, position);
    });
    clearTags.run(bookId);
    for (const tag of book.tags) {
      const { id } = upsertTag.get(tag, foldForSearch(tag)) as { id: number };
      linkTag.run(bookId, id);
    }
    clearIllustrators.run(bookId);
    book.illustrators.forEach((name, position) => {
      const { id } = upsertIllustrator.get(name, foldForSearch(name)) as { id: number };
      linkIllustrator.run(bookId, id, position);
    });
    clearIdentifiers.run(bookId);
    for (const [type, value] of Object.entries(book.identifiers)) {
      insertIdentifier.run(bookId, type, value);
    }
    updateMeta2.run({ ...meta2Params, bookId });
    const sourceId = existing?.id ?? (findSource.get(libraryId, book.uuid) as Existing).id;
    updateMeta2Source.run({
      meta2: hash2,
      coverSig: coverSigs.get(book.uuid) ?? null,
      id: sourceId,
    });
  };

  const reader = new CalibreReader(snapshotFile);
  try {
    result.skippedNoUuid = reader.countWithoutUuid();
    let afterId = 0;
    for (;;) {
      const batch = reader.readBatch(afterId, batchSize);
      if (batch.length === 0) break;
      // Covers: their size and mtime, read only for books whose record changed (a cover changed
      // in Calibre changes its last_modified); the rest get theirs from the indexer's slow
      // background pass (fillCoverSigs), never all at once here.
      coverSigs.clear();
      if (opts.coverSig) {
        const want = db.transaction(() =>
          batch.filter((b) => {
            if (!b.hasCover) return false;
            const e = findSource.get(libraryId, b.uuid) as Existing | undefined;
            return !e || e.meta_hash !== metaHash(b);
          }),
        )();
        for (const b of want) {
          coverSigs.set(b.uuid, await opts.coverSig(b.path).catch(() => null));
        }
      }
      db.transaction(() => {
        for (const book of batch) {
          seen.add(book.uuid);
          writeBook(book);
        }
      })();
      noteCatalogWrite(db);
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
    noteCatalogWrite(db);
    result.missingMarked = gone.length;
  }

  // Drop names nothing refers to any more (catalog only; user data never points here).
  db.transaction(() => {
    db.prepare('DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors)').run();
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM book_tags)').run();
    db.prepare(
      'DELETE FROM illustrators WHERE id NOT IN (SELECT illustrator_id FROM book_illustrators)',
    ).run();
    db.prepare(
      'DELETE FROM series WHERE id NOT IN (SELECT series_id FROM books WHERE series_id IS NOT NULL)',
    ).run();
  })();
  noteCatalogWrite(db);

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
