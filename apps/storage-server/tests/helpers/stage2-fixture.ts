/**
 * WP20b test helpers: EPUBs with real OPF metadata (EPUB2 opf:role, EPUB3 refines, covers),
 * and the Calibre tables stage 2 reads that the basic fixture leaves out (identifiers,
 * languages, the #illustrator custom column), with Calibre's own column names.
 * Only tests write these files.
 */
import Database from 'better-sqlite3';
import path from 'path';
import sharp from 'sharp';
import type { LibraryFixture } from './calibre-fixture';
import { makeZip } from './epub-fixture';

export interface MetaCreator {
  name: string;
  role?: string;
  /** EPUB3: the role as <meta refines="#id" property="role"> instead of opf:role. */
  refines?: boolean;
}

export interface MetaEpubSpec {
  title?: string;
  creators?: MetaCreator[];
  publisher?: string;
  language?: string;
  identifiers?: { value: string; scheme?: string }[];
  /** The cover image and how it is declared. */
  cover?: { data: Buffer; mediaType?: string; declared?: 'epub3' | 'meta' | 'name-only' | 'none' };
  /** Spine documents' body HTML (default: one page of text). */
  pages?: string[];
  version?: '2.0' | '3.0';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function makeMetaEpub(spec: MetaEpubSpec): Buffer {
  const version = spec.version ?? '3.0';
  const creators = (spec.creators ?? []).map((c, i) => {
    const id = `cre${i}`;
    if (c.role && c.refines) {
      return `<dc:creator id="${id}">${esc(c.name)}</dc:creator>\n<meta refines="#${id}" property="role" scheme="marc:relators">${c.role}</meta>`;
    }
    return `<dc:creator id="${id}"${c.role ? ` opf:role="${c.role}"` : ''}>${esc(c.name)}</dc:creator>`;
  });
  const pages = spec.pages ?? ['<p>本文です。</p>'];
  const cover = spec.cover;
  const coverMedia = cover?.mediaType ?? 'image/jpeg';
  const coverHref = coverMedia === 'image/png' ? 'images/cover.png' : 'images/cover.jpg';
  const declared = cover?.declared ?? 'epub3';
  const manifest = [
    ...pages.map(
      (_, i) => `<item id="p${i}" href="p${i}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
    ...(cover
      ? [
          `<item id="${declared === 'name-only' ? 'cover-image' : 'img1'}" href="${coverHref}" media-type="${coverMedia}"${declared === 'epub3' ? ' properties="cover-image"' : ''}/>`,
        ]
      : []),
  ];
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${spec.title !== undefined ? `<dc:title>${esc(spec.title)}</dc:title>` : ''}
${creators.join('\n')}
${spec.publisher ? `<dc:publisher>${esc(spec.publisher)}</dc:publisher>` : ''}
${spec.language ? `<dc:language>${spec.language}</dc:language>` : ''}
${(spec.identifiers ?? []).map((i, n) => `<dc:identifier id="${n === 0 ? 'uid' : `id${n}`}"${i.scheme ? ` opf:scheme="${i.scheme}"` : ''}>${esc(i.value)}</dc:identifier>`).join('\n')}
${cover && declared === 'meta' ? '<meta name="cover" content="img1"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine>
${pages.map((_, i) => `<itemref idref="p${i}"/>`).join('\n')}
</spine>
</package>`;
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate: true },
    ...pages.map((body, i) => ({
      name: `OEBPS/p${i}.xhtml`,
      data: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>見出し</title></head><body>${body}</body></html>`,
      deflate: true,
    })),
    ...(cover ? [{ name: `OEBPS/${coverHref}`, data: cover.data }] : []),
  ]);
}

/** A cover image of the given size and color (JPEG unless png is asked for). */
export async function coverImage(
  width: number,
  height: number,
  hue = 0,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
): Promise<Buffer> {
  // Two halves of different brightness so the difference hash isn't flat.
  const left = await sharp({
    create: {
      width: Math.ceil(width / 2),
      height,
      channels: 3,
      background: { r: hue % 256, g: 40, b: 90 },
    },
  })
    .png()
    .toBuffer();
  const img = sharp({
    create: { width, height, channels: 3, background: { r: 230, g: (hue * 7) % 256, b: 200 } },
  }).composite([{ input: left, left: 0, top: 0 }]);
  return format === 'png'
    ? img.png().toBuffer()
    : format === 'webp'
      ? img.webp().toBuffer()
      : img.jpeg({ quality: 90 }).toBuffer();
}

export const STAGE2_DDL = `
  CREATE TABLE IF NOT EXISTS identifiers ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
  CREATE TABLE IF NOT EXISTS languages ( id INTEGER PRIMARY KEY, lang_code TEXT NOT NULL COLLATE NOCASE,
    link TEXT NOT NULL DEFAULT '', UNIQUE(lang_code));
  CREATE TABLE IF NOT EXISTS books_languages_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL,
    lang_code INTEGER NOT NULL, item_order INTEGER NOT NULL DEFAULT 0, UNIQUE(book, lang_code));
  CREATE TABLE IF NOT EXISTS custom_columns ( id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
    name TEXT NOT NULL, datatype TEXT NOT NULL, mark_for_delete BOOL DEFAULT 0 NOT NULL,
    editable BOOL DEFAULT 1 NOT NULL, display TEXT DEFAULT '{}' NOT NULL, is_multiple BOOL DEFAULT 0 NOT NULL,
    normalized BOOL NOT NULL, UNIQUE(label));
  CREATE TABLE IF NOT EXISTS custom_column_1 ( id INTEGER PRIMARY KEY AUTOINCREMENT,
    value TEXT NOT NULL COLLATE NOCASE, link TEXT NOT NULL DEFAULT '', UNIQUE(value));
  CREATE TABLE IF NOT EXISTS books_custom_column_1_link ( id INTEGER PRIMARY KEY AUTOINCREMENT,
    book INTEGER NOT NULL, value INTEGER NOT NULL, UNIQUE(book, value));
  INSERT OR IGNORE INTO custom_columns (id, label, name, datatype, is_multiple, normalized)
    VALUES (1, 'illustrator', 'Illustrator', 'text', 1, 1);
`;

function libDb(lib: LibraryFixture): Database.Database {
  return new Database(path.join(lib.dir, 'metadata.db'));
}

export function addStage2Tables(lib: LibraryFixture): void {
  const db = libDb(lib);
  try {
    db.exec(STAGE2_DDL);
  } finally {
    db.close();
  }
}

/** Sets a book's identifiers, languages and #illustrator values in the test library. */
export function setStage2Fields(
  lib: LibraryFixture,
  calibreId: number,
  f: {
    identifiers?: Record<string, string>;
    languages?: string[];
    illustrators?: string[];
    lastModified?: string;
  },
): void {
  const db = libDb(lib);
  try {
    db.transaction(() => {
      if (f.identifiers) {
        db.prepare('DELETE FROM identifiers WHERE book = ?').run(calibreId);
        for (const [k, v] of Object.entries(f.identifiers)) {
          db.prepare('INSERT INTO identifiers (book, type, val) VALUES (?, ?, ?)').run(
            calibreId,
            k,
            v,
          );
        }
      }
      if (f.languages) {
        db.prepare('DELETE FROM books_languages_link WHERE book = ?').run(calibreId);
        f.languages.forEach((code, i) => {
          db.prepare('INSERT OR IGNORE INTO languages (lang_code) VALUES (?)').run(code);
          const l = db.prepare('SELECT id FROM languages WHERE lang_code = ?').get(code) as {
            id: number;
          };
          db.prepare(
            'INSERT INTO books_languages_link (book, lang_code, item_order) VALUES (?, ?, ?)',
          ).run(calibreId, l.id, i);
        });
      }
      if (f.illustrators) {
        db.prepare('DELETE FROM books_custom_column_1_link WHERE book = ?').run(calibreId);
        for (const n of f.illustrators) {
          db.prepare('INSERT OR IGNORE INTO custom_column_1 (value) VALUES (?)').run(n);
          const v = db.prepare('SELECT id FROM custom_column_1 WHERE value = ?').get(n) as {
            id: number;
          };
          db.prepare('INSERT INTO books_custom_column_1_link (book, value) VALUES (?, ?)').run(
            calibreId,
            v.id,
          );
        }
      }
      if (f.lastModified)
        db.prepare('UPDATE books SET last_modified = ? WHERE id = ?').run(
          f.lastModified,
          calibreId,
        );
    })();
  } finally {
    db.close();
  }
}

/** Edits a Calibre record the way the user would in the GUI (title/authors + last_modified). */
export function editInCalibre(
  lib: LibraryFixture,
  calibreId: number,
  e: { title?: string; authors?: string[] },
): void {
  const db = libDb(lib);
  try {
    db.transaction(() => {
      if (e.title) db.prepare('UPDATE books SET title = ? WHERE id = ?').run(e.title, calibreId);
      if (e.authors) {
        db.prepare('DELETE FROM books_authors_link WHERE book = ?').run(calibreId);
        for (const n of e.authors) {
          db.prepare('INSERT OR IGNORE INTO authors (name, sort) VALUES (?, ?)').run(n, n);
          const a = db.prepare('SELECT id FROM authors WHERE name = ?').get(n) as { id: number };
          db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)').run(
            calibreId,
            a.id,
          );
        }
      }
      db.prepare('UPDATE books SET last_modified = ? WHERE id = ?').run(
        new Date().toISOString().replace('T', ' ').replace('Z', '000+00:00'),
        calibreId,
      );
    })();
  } finally {
    db.close();
  }
}

/** Calibre's current record of a book in the test library (for assertions). */
export function calibreRecord(lib: LibraryFixture, calibreId: number) {
  const db = libDb(lib);
  try {
    const b = db.prepare('SELECT * FROM books WHERE id = ?').get(calibreId) as
      | Record<string, unknown>
      | undefined;
    if (!b) return null;
    const authors = (
      db
        .prepare(
          'SELECT a.name FROM books_authors_link l JOIN authors a ON a.id = l.author WHERE l.book = ? ORDER BY l.id',
        )
        .all(calibreId) as { name: string }[]
    ).map((r) => r.name);
    const identifiers = Object.fromEntries(
      (
        db.prepare('SELECT type, val FROM identifiers WHERE book = ?').all(calibreId) as {
          type: string;
          val: string;
        }[]
      ).map((r) => [r.type, r.val]),
    );
    const publisher =
      (
        db
          .prepare(
            'SELECT p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher WHERE l.book = ?',
          )
          .get(calibreId) as { name: string } | undefined
      )?.name ?? null;
    const languages = (
      db
        .prepare(
          'SELECT g.lang_code FROM books_languages_link l JOIN languages g ON g.id = l.lang_code WHERE l.book = ? ORDER BY l.item_order',
        )
        .all(calibreId) as { lang_code: string }[]
    ).map((r) => r.lang_code);
    const illustrators = (
      db
        .prepare(
          'SELECT v.value FROM books_custom_column_1_link l JOIN custom_column_1 v ON v.id = l.value WHERE l.book = ? ORDER BY l.id',
        )
        .all(calibreId) as { value: string }[]
    ).map((r) => r.value);
    return {
      title: b.title as string,
      sort: b.sort as string,
      authorSort: b.author_sort as string,
      hasCover: b.has_cover === 1,
      path: b.path as string,
      lastModified: b.last_modified as string,
      authors,
      identifiers,
      publisher,
      languages,
      illustrators,
    };
  } finally {
    db.close();
  }
}
