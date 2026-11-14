/**
 * Stage 2 (WP20b): the Calibre side of each book, read from the indexer's metadata.db
 * snapshot (a read-only copy in CACHE_DIR, never the live library): title and its sort,
 * authors in order and author_sort, tags, cover flag, identifiers, publisher, languages and
 * the #illustrator custom column, plus every author/publisher/illustrator name in the
 * library (Calibre matches those names ignoring case, decision D4).
 */
import Database from 'better-sqlite3';
import type { CalibreFacts, CoverFacts, SpellingLookup } from './stage2-rules';

export interface Stage2Book {
  calibreId: number;
  uuid: string;
  title: string;
  titleSort: string | null;
  authors: string[];
  authorSort: string | null;
  tags: string[];
  hasCover: boolean;
  /** The book folder, relative to the library. */
  path: string;
  /** The EPUB, relative to the library; null when the book has no EPUB. */
  filePath: string | null;
  lastModified: string | null;
  identifiers: Record<string, string>;
  publisher: string | null;
  languages: string[];
  /** null when the library has no #illustrator column. */
  illustrators: string[] | null;
}

export interface Stage2Snapshot {
  books: Map<number, Stage2Book>;
  /** Lower-case name → Calibre's spelling, per kind. */
  names: Record<'author' | 'publisher' | 'illustrator', Map<string, string>>;
  illustratorColumn: boolean;
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function readStage2Snapshot(file: string): Stage2Snapshot {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const books = new Map<number, Stage2Book>();
    const rows = db
      .prepare(
        `SELECT b.id, b.uuid, b.title, b.sort, b.author_sort, b.has_cover, b.path, b.last_modified,
                (SELECT d.name FROM data d WHERE d.book = b.id AND d.format = 'EPUB' LIMIT 1) AS epub
         FROM books b WHERE b.uuid IS NOT NULL AND b.uuid <> '' ORDER BY b.id`,
      )
      .all() as {
      id: number;
      uuid: string;
      title: string | null;
      sort: string | null;
      author_sort: string | null;
      has_cover: number | null;
      path: string;
      last_modified: string | null;
      epub: string | null;
    }[];
    for (const r of rows) {
      books.set(r.id, {
        calibreId: r.id,
        uuid: r.uuid,
        title: r.title ?? '',
        titleSort: r.sort,
        authors: [],
        authorSort: r.author_sort,
        tags: [],
        hasCover: r.has_cover === 1,
        path: r.path,
        filePath: r.epub !== null ? `${r.path}/${r.epub}.epub` : null,
        lastModified: r.last_modified,
        identifiers: {},
        publisher: null,
        languages: [],
        illustrators: null,
      });
    }
    const names: Stage2Snapshot['names'] = {
      author: new Map(),
      publisher: new Map(),
      illustrator: new Map(),
    };
    for (const a of db
      .prepare(
        `SELECT l.book, a.name FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id`,
      )
      .all() as { book: number; name: string }[]) {
      // Calibre stores a comma inside an author name as '|'.
      books.get(a.book)?.authors.push(a.name.replace(/\|/g, ','));
    }
    for (const a of db.prepare('SELECT name FROM authors').all() as { name: string }[]) {
      const n = a.name.replace(/\|/g, ',');
      names.author.set(n.toLowerCase(), n);
    }
    for (const t of db
      .prepare(
        `SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag ORDER BY t.name`,
      )
      .all() as { book: number; name: string }[]) {
      books.get(t.book)?.tags.push(t.name);
    }
    if (tableExists(db, 'identifiers')) {
      for (const i of db.prepare('SELECT book, type, val FROM identifiers').all() as {
        book: number;
        type: string;
        val: string;
      }[]) {
        const b = books.get(i.book);
        if (b) b.identifiers[i.type.toLowerCase()] = i.val;
      }
    }
    if (tableExists(db, 'publishers')) {
      for (const p of db
        .prepare(
          `SELECT l.book, p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher`,
        )
        .all() as { book: number; name: string }[]) {
        const b = books.get(p.book);
        if (b && b.publisher === null) b.publisher = p.name;
      }
      for (const p of db.prepare('SELECT name FROM publishers').all() as { name: string }[]) {
        names.publisher.set(p.name.toLowerCase(), p.name);
      }
    }
    if (tableExists(db, 'books_languages_link') && tableExists(db, 'languages')) {
      for (const l of db
        .prepare(
          `SELECT l.book, g.lang_code FROM books_languages_link l JOIN languages g ON g.id = l.lang_code
           ORDER BY l.book, l.item_order`,
        )
        .all() as { book: number; lang_code: string }[]) {
        books.get(l.book)?.languages.push(l.lang_code);
      }
    }
    let illustratorColumn = false;
    if (tableExists(db, 'custom_columns')) {
      const col = db.prepare(`SELECT id FROM custom_columns WHERE label = 'illustrator'`).get() as
        | { id: number }
        | undefined;
      const value = col ? `custom_column_${col.id}` : null;
      const link = col ? `books_custom_column_${col.id}_link` : null;
      if (value && link && tableExists(db, value) && tableExists(db, link)) {
        illustratorColumn = true;
        for (const b of books.values()) b.illustrators = [];
        for (const v of db
          .prepare(
            `SELECT l.book, v.value FROM ${link} l JOIN ${value} v ON v.id = l.value ORDER BY l.id`,
          )
          .all() as { book: number; value: string }[]) {
          books.get(v.book)?.illustrators?.push(v.value);
        }
        for (const v of db.prepare(`SELECT value FROM ${value}`).all() as { value: string }[]) {
          names.illustrator.set(v.value.toLowerCase(), v.value);
        }
      }
    }
    return { books, names, illustratorColumn };
  } finally {
    db.close();
  }
}

export function calibreFactsOf(book: Stage2Book, cover: CoverFacts | null): CalibreFacts {
  return {
    title: book.title,
    titleSort: book.titleSort,
    authors: book.authors,
    authorSort: book.authorSort,
    tags: book.tags,
    hasCover: book.hasCover,
    cover,
    identifiers: book.identifiers,
    publisher: book.publisher,
    languages: book.languages,
    illustrators: book.illustrators,
  };
}

/**
 * Calibre's spelling of a name that matches ignoring case, else the name itself; names used
 * earlier in the same analysis count too, so two books never bring in two spellings.
 */
export function spellingLookup(names: Stage2Snapshot['names']): SpellingLookup {
  const own: Stage2Snapshot['names'] = {
    author: new Map(names.author),
    publisher: new Map(names.publisher),
    illustrator: new Map(names.illustrator),
  };
  return (kind, name) => {
    const key = name.toLowerCase();
    const found = own[kind].get(key);
    if (found !== undefined) return found;
    own[kind].set(key, name);
    return name;
  };
}
