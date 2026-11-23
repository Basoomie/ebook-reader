/**
 * The one-time import of the accuracy test's summaries (book summaries session 3;
 * book-summaries.md "Summaries on the server"): the 13 summaries made on the PC's test copy
 * (`scripts/summaries-import-build.ts` writes the file, with the flagged items corrected), each
 * matched to the real library's book and stored as the app stores a summary, marked with the
 * setup and the date it was made.
 *
 * A book matches by its title (folded), else by series and volume, and only when its character
 * count is the test's: the same text. Every quote is found again in the live book (positions as
 * the reader counts them there). Nothing is stored unless every summary matches one book and
 * every quote is found (a dry run by default).
 */
import type Database from 'better-sqlite3';
import type { BookScript } from '../audio/book-script';
import { QuoteIndex } from './book-text';
import { SummaryStore } from './store';
import type { Summary } from './types';

export interface ImportEntry {
  key: string;
  run: string;
  title: string;
  series: string | null;
  volume: number | null;
  characters: number;
  background: boolean;
  round: string;
  madeAt: number;
  summary: Summary;
  corrections?: { ref: string; what: string }[];
}

export interface ImportFile {
  version: 1;
  summaries: ImportEntry[];
}

export interface ImportLine {
  key: string;
  title: string;
  bookId: string | null;
  liveTitle: string | null;
  how: string;
  quotes: number;
  moved: number;
  missing: string[];
  problem: string | null;
}

/** Titles compared without width, case, spaces or brackets' kind. */
export function foldTitle(t: string): string {
  return (
    t
      .normalize('NFKC')
      .toLowerCase()
      // \s covers the ideographic space too.
      .replace(/[\s・･]/g, '')
      .replace(/[（(]/g, '(')
      .replace(/[）)]/g, ')')
  );
}

interface LiveBook {
  id: string;
  title: string;
  char_count: number | null;
  series: string | null;
  series_index: number | null;
}

export function matchBook(
  e: ImportEntry,
  books: LiveBook[],
): { book: LiveBook | null; how: string; problem: string | null } {
  const sameText = books.filter((b) => b.char_count === e.characters);
  const byTitle = sameText.filter((b) => foldTitle(b.title) === foldTitle(e.title));
  if (byTitle.length === 1) return { book: byTitle[0], how: 'title', problem: null };
  if (byTitle.length > 1)
    return {
      book: null,
      how: 'title',
      problem: `${byTitle.length} books with this title and text`,
    };
  const bySeries =
    e.series && e.volume !== null
      ? sameText.filter(
          (b) =>
            b.series_index === e.volume &&
            !!b.series &&
            (foldTitle(b.series).includes(foldTitle(e.series!)) ||
              foldTitle(b.title).includes(foldTitle(e.series!))),
        )
      : [];
  if (bySeries.length === 1) return { book: bySeries[0], how: 'series and volume', problem: null };
  const similar = books.filter((b) => foldTitle(b.title) === foldTitle(e.title));
  if (similar.length)
    return {
      book: null,
      how: 'title',
      problem: `the title matches but not the text (${similar.map((b) => b.char_count).join(', ')} characters, the test had ${e.characters})`,
    };
  return {
    book: null,
    how: '-',
    problem: 'no book with this title (or series and volume) and text',
  };
}

/** Every quote found again in the live book; positions as the reader counts them there. */
export function refindQuotes(
  s: Summary,
  script: BookScript,
): { summary: Summary; quotes: number; moved: number; missing: string[] } {
  const idx = new QuoteIndex(script);
  let quotes = 0;
  let moved = 0;
  const missing: string[] = [];
  const sections = s.sections.map((sec) => ({
    ...sec,
    groups: sec.groups.map((g) => ({
      ...g,
      items: g.items.map((it) => {
        if (!it.quote) return it;
        quotes++;
        const hit = idx.find(it.quote, g.chapter);
        if (!hit) {
          missing.push(it.ref);
          return it;
        }
        if (hit.position !== it.position) moved++;
        return { ...it, position: hit.position };
      }),
    })),
  }));
  return { summary: { ...s, sections }, quotes, moved, missing };
}

export async function importSummaries(o: {
  main: Database.Database;
  sdb: Database.Database;
  file: ImportFile;
  apply: boolean;
  readScript: (bookId: string) => Promise<BookScript>;
  now?: () => number;
}): Promise<{ lines: ImportLine[]; ok: boolean; stored: number }> {
  if (o.file?.version !== 1 || !Array.isArray(o.file.summaries))
    throw new Error('Not a summaries import file (version 1)');
  // Only books with a file in the library: the copies the cleanup removed stay in the catalog
  // marked missing, with the same title and text as the one kept.
  const books = o.main
    .prepare(
      `SELECT b.id, b.title, b.char_count, s.name AS series, b.series_index
       FROM books b LEFT JOIN series s ON s.id = b.series_id
       WHERE EXISTS (SELECT 1 FROM book_sources bs WHERE bs.book_id = b.id AND bs.missing_at IS NULL)`,
    )
    .all() as LiveBook[];
  const store = new SummaryStore(o.sdb, o.now);
  const lines: ImportLine[] = [];
  const ready: { e: ImportEntry; bookId: string; summary: Summary }[] = [];
  const taken = new Set<string>();
  for (const e of o.file.summaries) {
    const m = matchBook(e, books);
    const line: ImportLine = {
      key: e.key,
      title: e.title,
      bookId: m.book?.id ?? null,
      liveTitle: m.book?.title ?? null,
      how: m.how,
      quotes: 0,
      moved: 0,
      missing: [],
      problem: m.problem,
    };
    lines.push(line);
    if (!m.book) continue;
    if (taken.has(m.book.id)) {
      line.problem = 'another summary of the file matched the same book';
      continue;
    }
    taken.add(m.book.id);
    if (store.currentMeta(m.book.id)) {
      line.problem = 'the book has a summary already (left as it is)';
      continue;
    }
    try {
      const script = await o.readScript(m.book.id);
      const r = refindQuotes(e.summary, script);
      line.quotes = r.quotes;
      line.moved = r.moved;
      line.missing = r.missing;
      if (r.missing.length) line.problem = `${r.missing.length} quotes not found in the book`;
      // The library's own title (the test copy's could differ: the cleanup renames books).
      else ready.push({ e, bookId: m.book.id, summary: { ...r.summary, bookTitle: m.book.title } });
    } catch (err) {
      line.problem = `the book could not be read: ${(err as Error).message}`;
    }
  }
  const ok = lines.every((l) => !l.problem);
  let stored = 0;
  if (o.apply && ok) {
    o.sdb.transaction(() => {
      for (const r of ready) {
        store.save(r.bookId, r.summary, {
          origin: 'import',
          setup: 'mixed',
          background: r.e.background,
          current: true,
          madeAt: r.e.madeAt,
          note: `accuracy test ${r.e.round} (${r.e.run})`,
          report: { characters: r.e.characters, corrections: r.e.corrections ?? [] },
        });
        o.sdb
          .prepare(
            `INSERT INTO summary_books (book_id, outcome) VALUES (?, 'made')
             ON CONFLICT(book_id) DO UPDATE SET outcome = 'made', note = NULL, note_at = NULL`,
          )
          .run(r.bookId);
        stored++;
      }
    })();
  }
  return { lines, ok, stored };
}
