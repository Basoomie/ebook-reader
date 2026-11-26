/**
 * Bookmeter sync, step 1 (measuring; design `docs/design/bookmeter-sync.md`): a Bookmeter user's
 * four public lists (読んだ本, 読んでる本, 積読本, 読みたい本), saved as HTML pages, matched
 * against the reader's library: first by the saved `bookmeter` identifier, then by stage 4's own
 * acceptance (judgeBookmeter: today's checks, then the chosen rules) against the library's books
 * that share an author or the title. Also compares each matched book's state in the reader
 * (book-status, read-through, position records). Read only: a ttsu.db snapshot copy on this PC
 * and the saved pages; nothing fetched, nothing written but the output.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-sync-measure.ts --ttsu <ttsu.db copy>
 *     --html <folder with read-N.html, wish-N.html, reading-N.html, stacked-N.html>
 *     --out <file.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  judgeBookmeter,
  parseBookmeterSearch,
  type BookmeterHit,
} from '../src/cleanup/stage4/store-links';
import { N, NA } from '../src/cleanup/title-rules';
import { clean } from '../src/cleanup/stage4/rules-v3';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ttsuPath = arg('ttsu');
const htmlDir = arg('html');
const outPath = arg('out');
if (!ttsuPath || !htmlDir || !outPath) throw new Error('--ttsu, --html and --out are required');
if (/^[a-z]:\\ttsu|^\\\\|^y:/i.test(path.resolve(ttsuPath)))
  throw new Error('refusing a live path');

type List = 'read' | 'reading' | 'stacked' | 'wish';
interface Entry extends BookmeterHit {
  list: List;
  date: string | null;
}

function readLists(): Entry[] {
  const out: Entry[] = [];
  for (const list of ['read', 'reading', 'stacked', 'wish'] as List[]) {
    for (let p = 1; fs.existsSync(path.join(htmlDir!, `${list}-${p}.html`)); p++) {
      const html = fs.readFileSync(path.join(htmlDir!, `${list}-${p}.html`), 'utf8');
      const items = html.split('<li class="group__book">').slice(1);
      const hits = parseBookmeterSearch(html);
      if (hits.length !== items.length)
        throw new Error(`${list}-${p}: ${hits.length} of ${items.length}`);
      items.forEach((li, i) => {
        const d = /<div class="detail__date">([^<]*)<\/div>/.exec(li)?.[1].trim() ?? null;
        out.push({ ...hits[i], list, date: d && /^\d{4}\/\d{2}\/\d{2}$/.test(d) ? d : null });
      });
    }
  }
  return out;
}

const db = new Database(ttsuPath, { readonly: true, fileMustExist: true });
const libs = new Map(
  (db.prepare('SELECT id, name FROM libraries').all() as { id: string; name: string }[]).map(
    (l) => [l.id, l.name],
  ),
);
interface Book {
  id: string;
  lib: string;
  title: string;
  series: string | null;
  authors: string[];
}
const books = new Map<string, Book>();
for (const r of db
  .prepare(
    `SELECT b.id, b.library_id lib, b.title, s.name series FROM books b
     LEFT JOIN series s ON s.id = b.series_id`,
  )
  .all() as Omit<Book, 'authors'>[])
  books.set(r.id, { ...r, lib: libs.get(r.lib) ?? r.lib, authors: [] });
for (const r of db
  .prepare(
    'SELECT ba.book_id, a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id ORDER BY ba.position',
  )
  .all() as { book_id: string; name: string }[])
  books.get(r.book_id)?.authors.push(r.name);

const bySavedId = new Map<string, string[]>();
for (const r of db
  .prepare("SELECT book_id, value FROM book_identifiers WHERE type = 'bookmeter'")
  .all() as { book_id: string; value: string }[]) {
  const a = bySavedId.get(r.value) ?? [];
  a.push(r.book_id);
  bySavedId.set(r.value, a);
}
const byAuthor = new Map<string, Book[]>();
const byTitle = new Map<string, Book[]>();
const push = (m: Map<string, Book[]>, k: string, b: Book) => {
  if (!k) return;
  const a = m.get(k) ?? [];
  a.push(b);
  m.set(k, a);
};
for (const b of books.values()) {
  for (const a of b.authors) push(byAuthor, NA(a) ?? '', b);
  push(byTitle, N(clean(b.title)) ?? '', b);
}

// The reader's own state, per book (the user's records only; one user).
const state = new Map<string, { status?: string; finished?: string[]; position?: boolean }>();
const st = (id: string) => {
  let s = state.get(id);
  if (!s) state.set(id, (s = {}));
  return s;
};
for (const r of db
  .prepare(
    "SELECT kind, book_id, data FROM sync_records WHERE deleted_at IS NULL AND book_id IS NOT NULL AND kind IN ('book-status','read-through','position')",
  )
  .all() as { kind: string; book_id: string; data: string }[]) {
  const d = JSON.parse(r.data);
  if (r.kind === 'book-status') st(r.book_id).status = d.status;
  else if (r.kind === 'read-through' && d.finished)
    (st(r.book_id).finished ??= []).push(d.finishedOn);
  else if (r.kind === 'position') st(r.book_id).position = true;
}

const entries = readLists();
const rows = entries.map((e) => {
  const saved = (bySavedId.get(e.id) ?? []).map((id) => books.get(id)!).filter(Boolean);
  let how: 'saved-id' | 'rules' | 'rules-many' | 'none' = 'none';
  let matched: Book[] = saved;
  let near: Book[] = [];
  if (saved.length) how = 'saved-id';
  else {
    const cand = new Map<string, Book>();
    for (const a of e.authors) for (const b of byAuthor.get(NA(a) ?? '') ?? []) cand.set(b.id, b);
    for (const b of byTitle.get(N(clean(e.title)) ?? '') ?? []) cand.set(b.id, b);
    matched = [...cand.values()].filter((b) => {
      const j = judgeBookmeter([e], {
        title: b.title,
        authors: b.authors,
        own: [b.title],
        chosen: { series: b.series, fmt: null, calTitle: b.title },
      });
      return j.tier[0] !== null;
    });
    if (matched.length === 1) how = 'rules';
    else if (matched.length > 1) how = 'rules-many';
    // Near misses: same author and the title's first 6 characters (for the report only).
    const key = (N(clean(e.title)) ?? '').slice(0, 6);
    near = [...cand.values()].filter(
      (b) => !matched.includes(b) && key && (N(clean(b.title)) ?? '').startsWith(key),
    );
  }
  return {
    list: e.list,
    date: e.date,
    id: e.id,
    title: e.title,
    authors: e.authors,
    how,
    libraries: [...new Set(matched.map((b) => b.lib))],
    matched: matched.map((b) => ({
      id: b.id,
      lib: b.lib,
      title: b.title,
      reader: state.get(b.id) ?? null,
    })),
    near: near.slice(0, 3).map((b) => ({ lib: b.lib, title: b.title })),
  };
});

// The other way: books with a reader status or a finished read-through, and whether Bookmeter has them.
const onBookmeter = new Set(rows.flatMap((r) => r.matched.map((m) => m.id)));
const readerSide = [...state.entries()]
  .filter(([, s]) => s.status || s.finished)
  .map(([id, s]) => ({
    title: books.get(id)?.title ?? '(gone)',
    lib: books.get(id)?.lib ?? null,
    status: s.status ?? null,
    finished: s.finished ?? [],
    savedId:
      (
        db
          .prepare("SELECT value FROM book_identifiers WHERE book_id = ? AND type = 'bookmeter'")
          .get(id) as { value: string } | undefined
      )?.value ?? null,
    onBookmeter: onBookmeter.has(id)
      ? rows.filter((r) => r.matched.some((m) => m.id === id)).map((r) => r.list)
      : [],
  }));

const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
const summary: Record<string, unknown> = {};
for (const list of ['read', 'reading', 'stacked', 'wish'] as List[]) {
  const l = (r: (typeof rows)[number]) => r.list === list;
  summary[list] = {
    total: count(l),
    savedId: count((r) => l(r) && r.how === 'saved-id'),
    rules: count((r) => l(r) && r.how === 'rules'),
    rulesMany: count((r) => l(r) && r.how === 'rules-many'),
    none: count((r) => l(r) && r.how === 'none'),
    noneWithNear: count((r) => l(r) && r.how === 'none' && r.near.length > 0),
    savedIdManyBooks: count((r) => l(r) && r.how === 'saved-id' && r.matched.length > 1),
    manga: count((r) => l(r) && r.libraries.includes('manga-library')),
  };
}
fs.writeFileSync(outPath, JSON.stringify({ summary, readerSide, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log(`reader books with a status or finished read-through: ${readerSide.length}`);
