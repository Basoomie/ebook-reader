#!/usr/bin/env node
/**
 * WP20a tests: stands in for calibredb talking to a content server. It works on a test
 * library made by tests/helpers/calibre-fixture.ts (FAKE_CALIBRE_LIBRARY), the way the
 * content server would: remove moves a book to .caltrash/b/<id>, trash restore brings it
 * back with the same id and UUID, add makes a new book with a new UUID.
 *
 * Env: FAKE_CALIBRE_LIBRARY (library folder), FAKE_PASSWORD (expected on stdin),
 * FAKE_VERSION (default 9.18.0), FAKE_LIBRARY_ID (default japanese-library),
 * FAKE_ILLUSTRATOR (1 = the #illustrator column exists), FAKE_LOG (argv of each call is
 * appended), FAKE_FAIL (a command name that fails).
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const lib = process.env.FAKE_CALIBRE_LIBRARY;
const version = process.env.FAKE_VERSION || '9.18.0';
const libraryId = process.env.FAKE_LIBRARY_ID || 'japanese-library';

if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + '\n');

function fail(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

if (argv[0] === '--version') {
  process.stdout.write(`calibredb (calibre ${version})\n`);
  process.exit(0);
}

function opt(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}
function has(name) {
  return argv.includes(name);
}

const withLibrary = opt('--with-library') || '';
if (!/^https?:\/\//.test(withLibrary)) fail('Only remote use is simulated');
if (opt('--password') !== '<stdin>') fail('The password must come through stdin');
if (has('--permanent')) fail('--permanent is never allowed in these tests', 3);

const stdin = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (stdin !== process.env.FAKE_PASSWORD) fail('Invalid username/password');

const sub = argv[0] === 'trash' ? `trash ${argv[1]}` : argv[0];
if (process.env.FAKE_FAIL && process.env.FAKE_FAIL === sub) fail(`simulated failure of ${sub}`, 2);

const wanted = withLibrary.split('#')[1];
if (sub === 'list' && wanted === '-') {
  process.stdout.write(`${libraryId}\n`);
  process.exit(0);
}
if (wanted !== libraryId) fail(`No library with id: ${wanted}`);

const db = new Database(path.join(lib, 'metadata.db'));
db.pragma('journal_mode = DELETE');
const trashDir = path.join(lib, '.caltrash', 'b');

function bookRow(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}
function formats(id) {
  return db.prepare('SELECT format, name FROM data WHERE book = ? ORDER BY format').all(id);
}
function tags(id) {
  return db
    .prepare(
      'SELECT t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = ? ORDER BY t.name',
    )
    .all(id)
    .map((r) => r.name);
}
function iso(ts) {
  // "2026-11-09 04:00:11.251060+00:00" -> ISO like calibredb --for-machine
  return String(ts).replace(' ', 'T');
}
function ids() {
  // The positional book ids: numbers that are not option values.
  const optsWithValue = new Set([
    '--with-library',
    '--username',
    '--password',
    '--to-dir',
    '--template',
    '--search',
    '--fields',
    '--limit',
  ]);
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (optsWithValue.has(argv[i])) {
      i++;
      continue;
    }
    if (/^\d+$/.test(argv[i])) out.push(Number(argv[i]));
  }
  return out;
}

function deleteRows(id) {
  for (const t of [
    'books_authors_link',
    'books_tags_link',
    'books_series_link',
    'books_publishers_link',
    'comments',
    'data',
  ]) {
    db.prepare(`DELETE FROM ${t} WHERE book = ?`).run(id);
  }
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
}

function touchDb() {
  const now = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(lib, 'metadata.db'), now, now);
}

function opf(book, t) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">${book.id}</dc:identifier>
    <dc:identifier opf:scheme="uuid" id="uuid_id">${book.uuid}</dc:identifier>
    <dc:title>${esc(book.title)}</dc:title>
${t.map((x) => `    <dc:subject>${esc(x)}</dc:subject>`).join('\n')}
  </metadata>
</package>
`;
}

switch (sub) {
  case 'list': {
    const search = opt('--search') || '';
    let rows;
    let m;
    if ((m = /^id:=(\d+)$/.exec(search))) rows = [bookRow(Number(m[1]))].filter(Boolean);
    else if ((m = /^title:"=(.*)"$/.exec(search))) {
      const title = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      rows = db.prepare('SELECT * FROM books WHERE title = ?').all(title);
    } else rows = db.prepare('SELECT * FROM books').all();
    const limit = opt('--limit');
    if (limit !== undefined) rows = rows.slice(0, Number(limit));
    const out = rows.map((b) => ({
      id: b.id,
      uuid: b.uuid,
      title: b.title,
      last_modified: iso(b.last_modified),
      formats: formats(b.id).map((f) => f.format),
    }));
    process.stdout.write(JSON.stringify(out));
    break;
  }
  case 'custom_columns': {
    if (process.env.FAKE_ILLUSTRATOR === '1') {
      process.stdout.write(
        "illustrator (1)\n  label: illustrator\n  name: Illustrator\n  datatype: text\n  is_multiple: {'cache_to_list': '|', 'ui_to_list': ',', 'list_to_ui': ', '}\n\n",
      );
    }
    break;
  }
  case 'export': {
    const dir = opt('--to-dir');
    for (const id of ids()) {
      const b = bookRow(id);
      if (!b) fail(`No book with id ${id}`);
      const folder = path.join(lib, ...b.path.split('/'));
      for (const f of formats(id)) {
        fs.copyFileSync(
          path.join(folder, `${f.name}.${f.format.toLowerCase()}`),
          path.join(dir, `book.${f.format.toLowerCase()}`),
        );
      }
      if (fs.existsSync(path.join(folder, 'cover.jpg')))
        fs.copyFileSync(path.join(folder, 'cover.jpg'), path.join(dir, 'book.jpg'));
      fs.writeFileSync(path.join(dir, 'book.opf'), opf(b, tags(id)));
    }
    break;
  }
  case 'remove': {
    for (const id of ids()) {
      const b = bookRow(id);
      if (!b) continue;
      const folder = path.join(lib, ...b.path.split('/'));
      const dest = path.join(trashDir, String(id));
      fs.mkdirSync(trashDir, { recursive: true });
      fs.cpSync(folder, dest, { recursive: true });
      fs.rmSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(dest, 'row.json'),
        JSON.stringify({ book: b, formats: formats(id), tags: tags(id) }),
      );
      deleteRows(id);
    }
    touchDb();
    break;
  }
  case 'trash list': {
    const out = fs.existsSync(trashDir)
      ? fs.readdirSync(trashDir).map((d) => {
          const r = JSON.parse(fs.readFileSync(path.join(trashDir, d, 'row.json'), 'utf8'));
          return { book_id: Number(d), title: r.book.title };
        })
      : [];
    process.stdout.write(JSON.stringify(out));
    break;
  }
  case 'trash restore': {
    for (const id of ids()) {
      const src = path.join(trashDir, String(id));
      if (!fs.existsSync(src)) fail(`Book ${id} is not in the trash`);
      const r = JSON.parse(fs.readFileSync(path.join(src, 'row.json'), 'utf8'));
      const b = r.book;
      db.prepare(
        `INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, uuid, has_cover, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        b.id,
        b.title,
        b.sort,
        b.timestamp,
        b.pubdate,
        b.series_index,
        b.author_sort,
        b.path,
        b.uuid,
        b.has_cover,
        new Date().toISOString().replace('T', ' ').replace('Z', '000+00:00'),
      );
      for (const f of r.formats)
        db.prepare(
          'INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, 1, ?)',
        ).run(id, f.format, f.name);
      for (const t of r.tags) {
        db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(t);
        const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(t);
        db.prepare('INSERT INTO books_tags_link (book, tag) VALUES (?, ?)').run(id, tag.id);
      }
      const folder = path.join(lib, ...b.path.split('/'));
      fs.mkdirSync(folder, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        if (name !== 'row.json') fs.copyFileSync(path.join(src, name), path.join(folder, name));
      }
      fs.rmSync(src, { recursive: true });
    }
    touchDb();
    break;
  }
  case 'add': {
    if (!has('--duplicates') || !has('--one-book-per-directory'))
      fail('add needs --duplicates and --one-book-per-directory here');
    const dir = argv[argv.length - 1];
    const names = fs.readdirSync(dir);
    const opfText = fs.readFileSync(
      path.join(
        dir,
        names.find((n) => n.endsWith('.opf')),
      ),
      'utf8',
    );
    const title = /<dc:title>([^<]*)<\/dc:title>/
      .exec(opfText)[1]
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
    const subjects = [...opfText.matchAll(/<dc:subject>([^<]*)<\/dc:subject>/g)].map((m) => m[1]);
    const uuid = randomUUID();
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '000+00:00');
    const id = Number(
      db
        .prepare(
          `INSERT INTO books (title, sort, timestamp, pubdate, series_index, author_sort, path, uuid, has_cover, last_modified)
         VALUES (?, ?, ?, ?, 1, 'Unknown', '', ?, 1, ?)`,
        )
        .run(title, title, now, '0101-01-01 00:00:00+00:00', uuid, now).lastInsertRowid,
    );
    const bookPath = `Author ${id}/Book ${id} (${id})`;
    db.prepare('UPDATE books SET path = ? WHERE id = ?').run(bookPath, id);
    const folder = path.join(lib, ...bookPath.split('/'));
    fs.mkdirSync(folder, { recursive: true });
    for (const n of names) {
      const ext = path.extname(n).slice(1).toLowerCase();
      if (['opf', 'json'].includes(ext)) continue;
      if (ext === 'jpg') {
        fs.copyFileSync(path.join(dir, n), path.join(folder, 'cover.jpg'));
        continue;
      }
      const name = `Book ${id} - Author ${id}`;
      fs.copyFileSync(path.join(dir, n), path.join(folder, `${name}.${ext}`));
      db.prepare(
        'INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)',
      ).run(id, ext.toUpperCase(), fs.statSync(path.join(dir, n)).size, name);
    }
    for (const t of subjects) {
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(t);
      const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(t);
      db.prepare('INSERT INTO books_tags_link (book, tag) VALUES (?, ?)').run(id, tag.id);
    }
    touchDb();
    process.stdout.write(`Added book ids: ${id}\n`);
    break;
  }
  default:
    fail(`Unknown command ${sub}`);
}
db.close();
