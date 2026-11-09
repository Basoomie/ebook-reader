/**
 * Builds throwaway Calibre-shaped libraries in temp folders for the indexer
 * tests. The DDL below covers the tables and columns the indexer reads, with
 * the same names and types as Calibre's (checked against the Calibre-made
 * fixture in tests/fixtures by calibre-schema.test.ts).
 *
 * Only tests write here; the code under test must never write to these folders.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { makeTempDir } from './spawn-server';

export const CALIBRE_FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'calibre-7.1');

export const FIXTURE_DDL = `
  CREATE TABLE books ( id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT 'Unknown' COLLATE NOCASE,
    sort TEXT COLLATE NOCASE, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, pubdate TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    series_index REAL NOT NULL DEFAULT 1.0, author_sort TEXT COLLATE NOCASE, path TEXT NOT NULL DEFAULT '',
    uuid TEXT, has_cover BOOL DEFAULT 0, last_modified TIMESTAMP NOT NULL DEFAULT '2000-01-01 00:00:00+00:00');
  CREATE TABLE authors ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE, UNIQUE(name));
  CREATE TABLE books_authors_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
  CREATE TABLE series ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE, UNIQUE (name));
  CREATE TABLE books_series_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
  CREATE TABLE tags ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, UNIQUE (name));
  CREATE TABLE books_tags_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
  CREATE TABLE publishers ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE, UNIQUE(name));
  CREATE TABLE books_publishers_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book));
  CREATE TABLE comments ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL COLLATE NOCASE, UNIQUE(book));
  CREATE TABLE data ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE,
    uncompressed_size INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(book, format));
  CREATE TABLE library_id ( id INTEGER PRIMARY KEY, uuid TEXT NOT NULL, UNIQUE(uuid));
`;

export type CoverKind = 'jpeg' | 'corrupt' | 'listed-missing' | 'none';

export interface FixtureBook {
  uuid?: string | null;
  title: string;
  sort?: string;
  authors?: string[];
  authorSort?: string;
  series?: { name: string; index: number };
  tags?: string[];
  comments?: string;
  publisher?: string;
  pubdate?: string;
  timestamp?: string;
  lastModified?: string;
  formats?: string[];
  cover?: CoverKind;
  /** Hue of the generated cover (to make a "new" cover). */
  coverHue?: number;
  /** Contents of the EPUB file (default: the single byte 'x'). */
  epub?: Buffer;
}

/** Calibre timestamp text for a JS date. */
export function calibreDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '000+00:00');
}

export async function makeJpeg(hue = 40, width = 600, height = 900): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: hue, g: 90, b: 255 - hue } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export class LibraryFixture {
  readonly dbFile: string;

  constructor(
    readonly dir: string,
    readonly uuid: string,
  ) {
    this.dbFile = path.join(dir, 'metadata.db');
  }

  private open(): Database.Database {
    // Rollback journal like Calibre (the indexer refuses WAL sources).
    const db = new Database(this.dbFile);
    db.pragma('journal_mode = DELETE');
    return db;
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const db = this.open();
    db.exec(FIXTURE_DDL);
    db.prepare('INSERT INTO library_id (uuid) VALUES (?)').run(this.uuid);
    db.close();
  }

  /** Adds a book like Calibre would and returns its Calibre id. */
  async addBook(book: FixtureBook): Promise<number> {
    const db = this.open();
    const now = calibreDate(new Date());
    const authors = book.authors ?? ['Unknown'];
    const cover = book.cover ?? 'jpeg';
    let id: number;
    try {
      id = db.transaction(() => {
        const res = db
          .prepare(
            `INSERT INTO books (title, sort, timestamp, pubdate, series_index, author_sort, path,
               uuid, has_cover, last_modified)
             VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
          )
          .run(
            book.title,
            book.sort ?? book.title,
            book.timestamp ?? now,
            book.pubdate ?? '0101-01-01 00:00:00+00:00',
            book.series?.index ?? 1,
            book.authorSort ?? authors.join(' & '),
            book.uuid === undefined ? randomUUID() : book.uuid,
            cover === 'none' ? 0 : 1,
            book.lastModified ?? now,
          );
        const bookId = Number(res.lastInsertRowid);
        // Transliterated-looking folder names, like Calibre's (never used for metadata).
        const bookPath = `Author ${bookId}/Book ${bookId} (${bookId})`;
        db.prepare('UPDATE books SET path = ? WHERE id = ?').run(bookPath, bookId);
        for (const name of authors) {
          db.prepare('INSERT OR IGNORE INTO authors (name, sort) VALUES (?, ?)').run(name, name);
          const a = db.prepare('SELECT id FROM authors WHERE name = ?').get(name) as { id: number };
          db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)').run(
            bookId,
            a.id,
          );
        }
        if (book.series) {
          db.prepare('INSERT OR IGNORE INTO series (name, sort) VALUES (?, ?)').run(
            book.series.name,
            book.series.name,
          );
          const s = db.prepare('SELECT id FROM series WHERE name = ?').get(book.series.name) as {
            id: number;
          };
          db.prepare('INSERT INTO books_series_link (book, series) VALUES (?, ?)').run(
            bookId,
            s.id,
          );
        }
        for (const tag of book.tags ?? []) {
          db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
          const t = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number };
          db.prepare('INSERT INTO books_tags_link (book, tag) VALUES (?, ?)').run(bookId, t.id);
        }
        if (book.publisher) {
          db.prepare('INSERT OR IGNORE INTO publishers (name) VALUES (?)').run(book.publisher);
          const p = db.prepare('SELECT id FROM publishers WHERE name = ?').get(book.publisher) as {
            id: number;
          };
          db.prepare('INSERT INTO books_publishers_link (book, publisher) VALUES (?, ?)').run(
            bookId,
            p.id,
          );
        }
        if (book.comments) {
          db.prepare('INSERT INTO comments (book, text) VALUES (?, ?)').run(bookId, book.comments);
        }
        for (const format of book.formats ?? ['EPUB']) {
          db.prepare(
            'INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)',
          ).run(
            bookId,
            format,
            format === 'EPUB' && book.epub ? book.epub.length : 1234,
            `Book ${bookId} - Author ${bookId}`,
          );
        }
        return bookId;
      })();
    } finally {
      db.close();
    }

    const folder = this.bookDir(id);
    fs.mkdirSync(folder, { recursive: true });
    for (const format of book.formats ?? ['EPUB']) {
      const data = format === 'EPUB' && book.epub ? book.epub : 'x';
      fs.writeFileSync(
        path.join(folder, `Book ${id} - Author ${id}.${format.toLowerCase()}`),
        data,
      );
    }
    if (cover === 'jpeg') {
      fs.writeFileSync(path.join(folder, 'cover.jpg'), await makeJpeg(book.coverHue));
    } else if (cover === 'corrupt') {
      fs.writeFileSync(path.join(folder, 'cover.jpg'), Buffer.from('not a jpeg at all'));
    }
    return id;
  }

  bookDir(calibreId: number): string {
    return path.join(this.dir, `Author ${calibreId}`, `Book ${calibreId} (${calibreId})`);
  }

  epubFile(calibreId: number): string {
    return path.join(this.bookDir(calibreId), `Book ${calibreId} - Author ${calibreId}.epub`);
  }

  /** Replaces the EPUB like Calibre does: new file, new size, newer last_modified. */
  replaceEpub(calibreId: number, epub: Buffer): void {
    fs.writeFileSync(this.epubFile(calibreId), epub);
    this.exec((db) => {
      db.prepare("UPDATE data SET uncompressed_size = ? WHERE book = ? AND format = 'EPUB'").run(
        epub.length,
        calibreId,
      );
      db.prepare('UPDATE books SET last_modified = ? WHERE id = ?').run(
        calibreDate(new Date(Date.now() + 1000)),
        calibreId,
      );
    });
  }

  /** Runs SQL against metadata.db as Calibre would (tests only). */
  exec(fn: (db: Database.Database) => void): void {
    const db = this.open();
    try {
      fn(db);
    } finally {
      db.close();
    }
  }

  removeBook(calibreId: number): void {
    this.exec((db) => {
      for (const t of [
        'books_authors_link',
        'books_tags_link',
        'books_series_link',
        'books_publishers_link',
        'comments',
        'data',
      ]) {
        db.prepare(`DELETE FROM ${t} WHERE book = ?`).run(calibreId);
      }
      db.prepare('DELETE FROM books WHERE id = ?').run(calibreId);
    });
  }

  setTitle(calibreId: number, title: string): void {
    this.exec((db) =>
      db
        .prepare('UPDATE books SET title = ?, last_modified = ? WHERE id = ?')
        .run(title, calibreDate(new Date()), calibreId),
    );
  }

  async setCover(calibreId: number, hue: number): Promise<void> {
    fs.writeFileSync(path.join(this.bookDir(calibreId), 'cover.jpg'), await makeJpeg(hue));
    this.exec((db) =>
      db
        .prepare('UPDATE books SET has_cover = 1, last_modified = ? WHERE id = ?')
        .run(calibreDate(new Date(Date.now() + 1000)), calibreId),
    );
  }

  /** Moves metadata.db's mtime into the past so the settle period has passed. */
  age(seconds = 3600): void {
    const t = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(this.dbFile, t, t);
  }
}

export class CalibreRoot {
  readonly dir: string;

  constructor(dir = makeTempDir('calibre')) {
    this.dir = dir;
  }

  library(folder: string, uuid = randomUUID()): LibraryFixture {
    const lib = new LibraryFixture(path.join(this.dir, folder), uuid);
    lib.init();
    return lib;
  }
}

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sha1: string;
}

/** Every file under `dir` with its size, mtime and hash (to prove nothing was written). */
export function fingerprint(dir: string): Record<string, FileFingerprint> {
  const out: Record<string, FileFingerprint> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out[path.relative(dir, full).replace(/\\/g, '/')] = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha1: createHash('sha1').update(fs.readFileSync(full)).digest('hex'),
        };
      }
    }
  };
  walk(dir);
  return out;
}

/** Copies the Calibre-made fixture library into a fresh temp root. */
export function copyRealFixture(): { root: string; folder: string } {
  const root = makeTempDir('calibre-real');
  fs.cpSync(CALIBRE_FIXTURE_DIR, root, { recursive: true });
  return { root, folder: 'japanese-test' };
}
