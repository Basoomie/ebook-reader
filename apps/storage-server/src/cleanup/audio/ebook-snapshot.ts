/**
 * Audiobook stage 8 (WP21g): what it reads of the Calibre library. Only the indexer's snapshot
 * copy (`<CACHE_DIR>/calibre/<libraryId>.db`, calibre/snapshot.ts) is opened, read only; the live
 * metadata.db never is. One pass reads every book's fields the pairing and the values use.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { statFileSync } from '../../calibre/source-fs';
import type { EbookFacts } from './ebook-pair';

export interface EbookBook extends EbookFacts {
  uuid: string | null;
  authorSorts: (string | null)[];
  authorSort: string | null;
  description: string | null;
  hasCover: boolean;
  /** The book's folder inside the library (Calibre's `path`). */
  path: string;
  lastModified: string | null;
  /** sha1 of every field stage 8 uses (a change is noticed without last_modified). */
  fp: string;
}

export interface EbookSnapshot {
  file: string;
  mtimeMs: number;
  size: number;
  books: Map<number, EbookBook>;
}

const SEP = '\u001f';

/** The snapshot file's identity now (one stat). */
export function snapshotIdentity(file: string): { mtimeMs: number; size: number } | null {
  try {
    return statFileSync(file);
  } catch {
    return null;
  }
}

/** Plain text of Calibre's comments (HTML): tags dropped, paragraphs as line breaks. */
export function commentsText(html: string | null): string | null {
  if (!html) return null;
  const t = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t || null;
}

function fingerprint(b: Omit<EbookBook, 'fp'>): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        b.title,
        b.authors,
        b.authorSorts,
        b.authorSort,
        b.series,
        b.index,
        [...b.tags].sort(),
        b.description,
        b.hasCover,
        b.path,
        b.lastModified,
      ]),
    )
    .digest('hex');
}

/** Every book of the snapshot copy (read only, one pass: scripts and tests). */
export function readEbookSnapshot(file: string): EbookSnapshot {
  const id = snapshotIdentity(file);
  if (!id) throw new Error(`The Calibre snapshot ${file} can't be read`);
  const books = new Map<number, EbookBook>();
  for (let after = 0; ; ) {
    const page = readEbookPage(file, after, 5000);
    for (const b of page) books.set(b.id, b);
    if (page.length < 5000) break;
    after = page[page.length - 1].id;
  }
  return { file, mtimeMs: id.mtimeMs, size: id.size, books };
}

/** The books after id `after`, at most `limit` (read only; the stage reads a page per step). */
export function readEbookPage(file: string, after: number, limit: number): EbookBook[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const where = `WHERE b.id > ?`;
    const rows = db
      .prepare(
        `SELECT b.id, b.uuid, b.title, b.author_sort, b.series_index, b.has_cover, b.path,
                b.last_modified,
                (SELECT group_concat(a.name || '${SEP}' || COALESCE(a.sort, ''), '${SEP}${SEP}')
                   FROM (SELECT a.name, a.sort FROM books_authors_link l JOIN authors a ON a.id = l.author
                         WHERE l.book = b.id ORDER BY l.id) a) AS authors,
                (SELECT s.name FROM books_series_link sl JOIN series s ON s.id = sl.series
                   WHERE sl.book = b.id) AS series,
                (SELECT group_concat(t.name, '${SEP}') FROM books_tags_link tl JOIN tags t ON t.id = tl.tag
                   WHERE tl.book = b.id) AS tags,
                (SELECT c.text FROM comments c WHERE c.book = b.id) AS comments
         FROM books b ${where} ORDER BY b.id LIMIT ?`,
      )
      .all(after, limit) as {
      id: number;
      uuid: string | null;
      title: string;
      author_sort: string | null;
      series_index: number | null;
      has_cover: number;
      path: string;
      last_modified: string | null;
      authors: string | null;
      series: string | null;
      tags: string | null;
      comments: string | null;
    }[];
    const books: EbookBook[] = [];
    for (const r of rows) {
      const pairs = r.authors ? r.authors.split(SEP + SEP).map((x) => x.split(SEP)) : [];
      const b: Omit<EbookBook, 'fp'> = {
        id: r.id,
        uuid: r.uuid,
        title: r.title ?? '',
        // Calibre stores "," in a name as "|".
        authors: pairs.map((p) => (p[0] ?? '').split('|').join(',')),
        authorSorts: pairs.map((p) => (p[1] ? p[1] : null)),
        authorSort: r.author_sort,
        series: r.series,
        index: r.series ? (r.series_index ?? 1) : null,
        tags: r.tags ? r.tags.split(SEP) : [],
        description: commentsText(r.comments),
        hasCover: r.has_cover === 1,
        path: r.path,
        lastModified: r.last_modified,
      };
      books.push({ ...b, fp: fingerprint(b) });
    }
    return books;
  } finally {
    db.close();
  }
}

/** Every book's id and last_modified (the daily check's first, cheap look). */
export function readEbookIds(file: string): Map<number, string | null> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const out = new Map<number, string | null>();
    for (const r of db.prepare('SELECT id, last_modified FROM books').all() as {
      id: number;
      last_modified: string | null;
    }[])
      out.set(r.id, r.last_modified);
    return out;
  } finally {
    db.close();
  }
}
