/**
 * Books without an EPUB: which books the pass looks at, and what the server can tell from the
 * record alone (read from the reader's snapshot of metadata.db, read only).
 *
 * - The file to convert: the first of CONVERT_ORDER the book has (a Kindle book before an
 *   archive; MOBI+PDF books convert their MOBI).
 * - Listed and left (decided with the user at stop 1, 2026-11-26): a book with no file (they join
 *   tier 4's records-without-files list), PDF only, KFX only, other formats only, and an archive
 *   whose title names several volumes ("第01-10巻", "1-22", "vol 01-08": a whole series in one
 *   archive). What the file itself is (DRM, an EPUB inside, pictures, mokuro…) the sidecar reads.
 * - Twins: EPUB books of the same library with the same title after the usual normalisation
 *   (stop 1's), the copy's own authors first; only a text comparison decides whether one is the
 *   same book (stop 1: 158 of the same-title "copies" were other books).
 */
import Database from 'better-sqlite3';

/** The formats converted (or extracted), in the order a book's file is chosen. */
export const CONVERT_ORDER = [
  'AZW3',
  'AZW',
  'MOBI',
  'PRC',
  'HTMLZ',
  'HTML',
  'TXT',
  'CBZ',
  'ZIP',
  'CBR',
  'RAR',
] as const;

export const ARCHIVE_FORMATS = ['CBZ', 'ZIP', 'CBR', 'RAR'];

export type ListedReason =
  | 'no_file'
  | 'pdf'
  | 'kfx'
  | 'other_format'
  | 'series'
  | 'drm'
  | 'pdf_inside'
  | 'kfx_inside'
  | 'archive_inside'
  | 'text_archive'
  | 'not_book'
  | 'unknown'
  | 'failed'
  | 'check_failed'
  | 'gone';

/** The card's words for each reason a book is listed and left. */
export const LISTED_TEXT: Record<ListedReason, string> = {
  no_file: 'No file at all (added to the records-without-files list)',
  pdf: 'PDF only (PDFs are left as they are)',
  kfx: 'KFX only (calibre can’t read it without a plugin)',
  other_format: 'Only formats the pass doesn’t convert',
  series: 'A whole series in one archive (left for now)',
  drm: 'Locked with DRM',
  pdf_inside: 'PDFs inside an archive (PDFs are left as they are)',
  kfx_inside: 'A KFX book inside an archive',
  archive_inside: 'An archive inside the archive',
  text_archive: 'Several text files in one archive',
  not_book: 'Not a book (audio files)',
  unknown: 'Nothing readable in the archive',
  failed: 'The conversion failed',
  check_failed: 'The EPUB did not pass the check',
  gone: 'No longer in Calibre as selected',
};

export interface FormatFile {
  format: string;
  name: string;
  size: number | null;
}

export interface FormatCandidate {
  calibreId: number;
  uuid: string;
  title: string;
  authors: string[];
  tags: string[];
  lastModified: string | null;
  formats: FormatFile[];
}

export interface Twin {
  calibreId: number;
  uuid: string;
  title: string;
  authors: string[];
  formats: string[];
  /** The EPUB's path inside the library folder. */
  epubPath: string;
}

/** stop 1's title key: NFKC, lower case, bracketed notes and spacing/punctuation dropped. */
export function titleKey(title: string): string {
  const t = (title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/【[^】]*】|[(（][^)）]*[)）]|\[[^\]]*\]/g, '');
  return t.replace(/[\s・:：!！?？~～〜-]/g, '');
}

const authorKey = (a: string) =>
  a
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・]/g, '');

/** A title naming several volumes of one archive ("第01-10巻", "1-22", "vol 01-08", "全8巻"). */
export function titleNamesSeveralVolumes(title: string): boolean {
  const t = (title ?? '').normalize('NFKC');
  const range = /(\d{1,3})\s*[-~〜～]\s*(\d{1,3})(?!\d)/.exec(t);
  if (range && Number(range[2]) > Number(range[1])) return true;
  return /全\s*\d{1,3}\s*巻|volumes?\s*\d+\s*(-|to)\s*\d+/i.test(t);
}

/** The file to convert, or why the book is listed and left. */
export function chooseFile(
  c: Pick<FormatCandidate, 'formats' | 'title'>,
): { file: FormatFile } | { listed: ListedReason } {
  if (c.formats.length === 0) return { listed: 'no_file' };
  for (const f of CONVERT_ORDER) {
    const file = c.formats.find((x) => x.format === f);
    if (!file) continue;
    if (ARCHIVE_FORMATS.includes(f) && titleNamesSeveralVolumes(c.title))
      return { listed: 'series' };
    return { file };
  }
  const fmts = c.formats.map((f) => f.format);
  if (fmts.every((f) => f === 'PDF')) return { listed: 'pdf' };
  if (fmts.every((f) => f === 'KFX' || f === 'PDF')) return { listed: 'kfx' };
  return { listed: 'other_format' };
}

/** The EPUB twins of a book, its own authors first, at most `max`. */
export function twinsOf(c: FormatCandidate, byTitle: Map<string, Twin[]>, max: number): Twin[] {
  const key = titleKey(c.title);
  if (!key) return [];
  const mine = new Set(c.authors.map(authorKey));
  return (byTitle.get(key) ?? [])
    .filter((t) => t.calibreId !== c.calibreId)
    .map((t) => ({ t, same: t.authors.some((a) => mine.has(authorKey(a))) ? 0 : 1 }))
    .sort((a, b) => a.same - b.same || a.t.calibreId - b.t.calibreId)
    .slice(0, max)
    .map((x) => x.t);
}

/** The UUIDs of a snapshot's books without an EPUB (one indexed query: the `done` phase's check). */
export function nonEpubUuids(file: string): string[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare(
          `SELECT b.uuid FROM books b WHERE b.uuid IS NOT NULL AND b.uuid <> ''
             AND NOT EXISTS (SELECT 1 FROM data d WHERE d.book = b.id AND d.format = 'EPUB')`,
        )
        .all() as { uuid: string }[]
    ).map((r) => r.uuid);
  } finally {
    db.close();
  }
}

/**
 * The library's books without an EPUB, and the EPUB books with one of their title keys (the
 * twins), from a metadata.db snapshot (read only). Only those books' authors, formats and tags
 * are read (the rehearsal on the live snapshot: reading all 61,000 books' took 1.9 s, which would
 * hold the server; the books without an EPUB are about 1,000).
 */
export function readFormatCandidates(file: string): {
  books: FormatCandidate[];
  byTitle: Map<string, Twin[]>;
} {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT b.id, b.uuid, b.title, b.path, b.last_modified,
                EXISTS (SELECT 1 FROM data d WHERE d.book = b.id AND d.format = 'EPUB') AS epub
         FROM books b WHERE b.uuid IS NOT NULL AND b.uuid <> '' ORDER BY b.id`,
      )
      .all() as {
      id: number;
      uuid: string;
      title: string;
      path: string;
      last_modified: string | null;
      epub: number;
    }[];
    const without = rows.filter((r) => r.epub === 0);
    const keys = new Set(without.map((r) => titleKey(r.title)).filter(Boolean));
    const twins = rows.filter((r) => r.epub === 1 && keys.has(titleKey(r.title)));
    const ids = [...without, ...twins].map((r) => r.id);
    const authors = new Map<number, string[]>();
    const formats = new Map<number, FormatFile[]>();
    const tags = new Map<number, string[]>();
    const push = <T>(m: Map<number, T[]>, k: number, v: T) => {
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    };
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const marks = chunk.map(() => '?').join(',');
      for (const r of db
        .prepare(
          `SELECT l.book, a.name FROM books_authors_link l JOIN authors a ON a.id = l.author
           WHERE l.book IN (${marks}) ORDER BY l.id`,
        )
        .all(...chunk) as { book: number; name: string }[])
        push(authors, r.book, r.name);
      for (const r of db
        .prepare(
          `SELECT book, format, name, uncompressed_size FROM data WHERE book IN (${marks}) ORDER BY format`,
        )
        .all(...chunk) as {
        book: number;
        format: string;
        name: string;
        uncompressed_size: number | null;
      }[])
        push(formats, r.book, {
          format: r.format.toUpperCase(),
          name: r.name,
          size: r.uncompressed_size,
        });
      for (const r of db
        .prepare(
          `SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag
           WHERE l.book IN (${marks}) ORDER BY t.name`,
        )
        .all(...chunk) as { book: number; name: string }[])
        push(tags, r.book, r.name);
    }
    const byTitle = new Map<string, Twin[]>();
    for (const b of twins) {
      const fs = formats.get(b.id) ?? [];
      const epub = fs.find((f) => f.format === 'EPUB');
      if (!epub) continue;
      const twin: Twin = {
        calibreId: b.id,
        uuid: b.uuid,
        title: b.title,
        authors: authors.get(b.id) ?? [],
        formats: fs.map((f) => f.format),
        epubPath: `${b.path}/${epub.name}.epub`,
      };
      const key = titleKey(b.title);
      const list = byTitle.get(key);
      if (list) list.push(twin);
      else byTitle.set(key, [twin]);
    }
    const books: FormatCandidate[] = without.map((b) => ({
      calibreId: b.id,
      uuid: b.uuid,
      title: b.title,
      authors: authors.get(b.id) ?? [],
      tags: tags.get(b.id) ?? [],
      lastModified: b.last_modified,
      formats: formats.get(b.id) ?? [],
    }));
    return { books, byTitle };
  } finally {
    db.close();
  }
}
