/**
 * Manga part A (manga-library.md): which books move to the manga library, and which are held for
 * review. Pure rules over what the reader's snapshot of the library and its index say; no file is
 * read and nothing is written here.
 *
 * Decided with the user (2026-11-23/24):
 * - every book tagged マンガ or 画像のみ moves (settings.move.tags);
 * - a book whose counted characters show real text (settings.move.realTextChars, 5,000: stage 4's
 *   own line between a text book and manga/image-only) is not moved automatically: review;
 * - there is no full list to look through: the held books and a 30-book spot check before On.
 *
 * Also held (each with its reason on the card): a book without an EPUB (the reader shows EPUB
 * only and counts nothing else: the mokuro ZIP books), a book without a trusted count (counted
 * on another file or not counted), and a book whose Calibre folder or file name would pass 255
 * bytes in the new library (lessons 2: every write renames).
 */
import Database from 'better-sqlite3';
import { calibreNameBytes, NAME_MAX_BYTES } from '../calibre-names';

export interface MoveCandidate {
  calibreId: number;
  uuid: string;
  title: string;
  authors: string[];
  lastModified: string | null;
  /** The book's folder in the library ("Author/Title (id)"). */
  path: string;
  /** The EPUB relative to the library folder, or null when the book has none. */
  epubPath: string | null;
  /** Calibre's size of the EPUB (data.uncompressed_size), when it has one. */
  epubSize: number | null;
  formats: string[];
  tags: string[];
  /** The move tags this book carries (as written in the settings). */
  matched: string[];
  series: string | null;
}

/** What the reader's index knows of a book: its count and whether it holds the user's data. */
export interface ReaderFacts {
  sourceId: string;
  bookId: string;
  /** The reader's counted characters, when counted on this very file (null otherwise). */
  chars: number | null;
  /** Why there is no trusted count (null when there is one). */
  noCount: 'not_counted' | 'count_failed' | 'other_file' | null;
  hasData: boolean;
}

export type HoldReason = 'real_text' | 'no_epub' | 'no_count' | 'too_long' | 'not_in_reader';

export const HOLD_TEXT: Record<HoldReason, string> = {
  real_text: 'Its character count shows real text',
  no_epub: 'It has no EPUB (the reader shows EPUB only)',
  no_count: "The reader hasn't counted this file's characters",
  too_long: 'Its title or author would make a Calibre folder or file name the disk refuses',
  not_in_reader: "The reader's index doesn't have this book",
};

export interface MoveDecision {
  candidate: MoveCandidate;
  reader: ReaderFacts | null;
  /** null: moved automatically. */
  hold: HoldReason | null;
  detail: string | null;
}

/** The decision for one tagged book. */
export function decideMove(
  c: MoveCandidate,
  reader: ReaderFacts | null,
  realTextChars: number,
): MoveDecision {
  const out = (hold: HoldReason | null, detail: string | null = null): MoveDecision => ({
    candidate: c,
    reader,
    hold,
    detail,
  });
  if (!c.epubPath) return out('no_epub', `Formats: ${c.formats.join(', ') || 'none'}`);
  if (!reader) return out('not_in_reader');
  if (reader.chars === null)
    return out(
      'no_count',
      reader.noCount === 'count_failed'
        ? 'The count failed'
        : reader.noCount === 'other_file'
          ? 'The count is of another version of the file'
          : 'Not counted yet',
    );
  if (reader.chars >= realTextChars)
    return out('real_text', `${reader.chars.toLocaleString('en-US')} characters`);
  // The worst case: a new library numbers its books from 1, but any id up to 7 digits must fit.
  const bytes = calibreNameBytes(9_999_999, c.title, c.authors[0] ?? '');
  if (bytes > NAME_MAX_BYTES) return out('too_long', `${bytes} bytes`);
  return out(null);
}

/**
 * The books of a metadata.db snapshot that carry any of the tags (case-insensitive), with what
 * the move needs: formats, the EPUB's path and size, authors in Calibre's order, every tag.
 */
export function readMoveCandidates(file: string, tags: string[]): MoveCandidate[] {
  const wanted = new Map(tags.map((t) => [t.toLowerCase(), t]));
  if (wanted.size === 0) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const marks = [...wanted.keys()];
    const rows = db
      .prepare(
        `SELECT DISTINCT b.id, b.uuid, b.title, b.last_modified, b.path FROM books b
         JOIN books_tags_link l ON l.book = b.id JOIN tags t ON t.id = l.tag
         WHERE lower(t.name) IN (${marks.map(() => '?').join(',')})
           AND b.uuid IS NOT NULL AND b.uuid <> ''
         ORDER BY b.id`,
      )
      .all(...marks) as {
      id: number;
      uuid: string;
      title: string;
      last_modified: string | null;
      path: string;
    }[];
    const byId = new Map<number, MoveCandidate>();
    for (const r of rows)
      byId.set(r.id, {
        calibreId: r.id,
        uuid: r.uuid,
        title: r.title,
        authors: [],
        lastModified: r.last_modified,
        path: r.path,
        epubPath: null,
        epubSize: null,
        formats: [],
        tags: [],
        matched: [],
        series: null,
      });
    if (byId.size === 0) return [];
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const inList = chunk.map(() => '?').join(',');
      for (const f of db
        .prepare(
          `SELECT book, format, name, uncompressed_size FROM data WHERE book IN (${inList}) ORDER BY format`,
        )
        .all(...chunk) as {
        book: number;
        format: string;
        name: string;
        uncompressed_size: number | null;
      }[]) {
        const c = byId.get(f.book)!;
        const fmt = f.format.toUpperCase();
        c.formats.push(fmt);
        if (fmt === 'EPUB') {
          c.epubPath = `${c.path}/${f.name}.epub`;
          c.epubSize = f.uncompressed_size;
        }
      }
      for (const a of db
        .prepare(
          `SELECT l.book, a.name FROM books_authors_link l JOIN authors a ON a.id = l.author
           WHERE l.book IN (${inList}) ORDER BY l.book, l.id`,
        )
        .all(...chunk) as { book: number; name: string }[])
        byId.get(a.book)!.authors.push(a.name);
      for (const t of db
        .prepare(
          `SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag
           WHERE l.book IN (${inList}) ORDER BY t.name`,
        )
        .all(...chunk) as { book: number; name: string }[]) {
        const c = byId.get(t.book)!;
        c.tags.push(t.name);
        const m = wanted.get(t.name.toLowerCase());
        if (m && !c.matched.includes(m)) c.matched.push(m);
      }
      for (const s of db
        .prepare(
          `SELECT l.book, s.name FROM books_series_link l JOIN series s ON s.id = l.series
           WHERE l.book IN (${inList})`,
        )
        .all(...chunk) as { book: number; name: string }[])
        byId.get(s.book)!.series = s.name;
    }
    return [...byId.values()];
  } finally {
    db.close();
  }
}

/**
 * What the reader's index knows of these books (ttsu.db, read only): the Calibre source and its
 * reader book, the count (trusted only when counted on a file of this size, as stage 3 does),
 * and whether the reader book holds the user's data.
 */
export function readReaderFacts(
  main: Database.Database,
  libraryId: string,
  books: { uuid: string; epubSize: number | null }[],
  withData: (bookIds: string[]) => Set<string>,
): Map<string, ReaderFacts> {
  const out = new Map<string, ReaderFacts>();
  const sizes = new Map(books.map((b) => [b.uuid, b.epubSize]));
  const uuids = books.map((b) => b.uuid);
  const rows: {
    id: string;
    book_id: string;
    calibre_uuid: string;
    file_size: number | null;
    status: string | null;
    characters: number | null;
    file_bytes: number | null;
  }[] = [];
  for (let i = 0; i < uuids.length; i += 400) {
    const chunk = uuids.slice(i, i + 400);
    rows.push(
      ...(main
        .prepare(
          `SELECT s.id, s.book_id, s.calibre_uuid, s.file_size, c.status, c.characters, c.file_bytes
           FROM book_sources s LEFT JOIN char_counts c ON c.book_id = s.book_id
           WHERE s.library_id = ? AND s.kind = 'calibre' AND s.missing_at IS NULL
             AND s.calibre_uuid IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(libraryId, ...chunk) as typeof rows),
    );
  }
  const data = withData(rows.map((r) => r.book_id));
  for (const r of rows) {
    const size = sizes.get(r.calibre_uuid) ?? r.file_size;
    let chars: number | null = null;
    let noCount: ReaderFacts['noCount'] = null;
    if (r.status === null) noCount = 'not_counted';
    else if (r.status !== 'ok' || r.characters === null) noCount = 'count_failed';
    else if (r.file_bytes === null || (r.file_bytes !== size && r.file_bytes !== r.file_size))
      noCount = 'other_file';
    else chars = r.characters;
    out.set(r.calibre_uuid, {
      sourceId: r.id,
      bookId: r.book_id,
      chars,
      noCount,
      hasData: data.has(r.book_id),
    });
  }
  return out;
}

/**
 * The spot check's books: `size` books drawn from the automatic moves in proportion to their
 * tags (the books tagged with the first tag, then those with only a later one), each group in a
 * fixed pseudo-random order (sha-like key of the run and the UUID) so the draw never changes
 * while the run stays the same.
 */
export function drawSpot<T extends { uuid: string; matched: string[] }>(
  books: T[],
  tags: string[],
  size: number,
  orderKey: (uuid: string) => string,
): T[] {
  const groups = tags.map(() => [] as T[]);
  for (const b of books) {
    const i = tags.findIndex((t) => b.matched.includes(t));
    groups[i < 0 ? 0 : i].push(b);
  }
  const total = books.length;
  if (total === 0) return [];
  const want = Math.min(size, total);
  // Largest remainder, at least one from every group that has books.
  const exact = groups.map((g) => (g.length * want) / total);
  const shares = exact.map((x, i) => (groups[i].length > 0 ? Math.max(1, Math.floor(x)) : 0));
  let left = want - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length * 2; k++) {
    const { i } = order[k % order.length];
    if (shares[i] < groups[i].length) {
      shares[i]++;
      left--;
    }
  }
  while (left < 0) {
    const i = shares.indexOf(Math.max(...shares));
    shares[i]--;
    left++;
  }
  const out: T[] = [];
  groups.forEach((g, i) => {
    const sorted = [...g].sort((a, b) =>
      orderKey(a.uuid) < orderKey(b.uuid) ? -1 : orderKey(a.uuid) > orderKey(b.uuid) ? 1 : 0,
    );
    out.push(...sorted.slice(0, shares[i]));
  });
  return out;
}
