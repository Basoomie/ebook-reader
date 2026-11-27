/**
 * Bookmeter sync (2026-11-25, docs/design/bookmeter-sync.md): which reader books a Bookmeter
 * entry is. Measured on the user's lists (step 1): the saved `bookmeter` id took 187 of 250, the
 * rules 35, every one checked right.
 *
 *   1. the user's own choice (Link / Not in my library) — never decided again;
 *   2. the saved id: Calibre's `bookmeter` identifier is the entry's listing;
 *   3. the rules: stage 4's own acceptance (judgeBookmeter: today's checks, then the chosen
 *      rules) against the books that share an author or the cleaned title.
 *
 * Only books of the account's libraries that are in the library now count. Several copies of
 * one book all match (the search finds every copy; the status goes on one, `targetBook`).
 */
import type Database from 'better-sqlite3';
import { judgeBookmeter } from '../cleanup/stage4/store-links';
import { titleSimilarity } from '../cleanup/stage4/bookmeter-rules';
import { clean } from '../cleanup/stage4/rules-v3';
import { N, NA } from '../cleanup/title-rules';
import { bookListVersion } from '../catalog/catalog-version';

export interface IndexedBook {
  id: string;
  libraryId: string;
  title: string;
  series: string | null;
  authors: string[];
  createdAt: number;
  savedId: string | null;
  /** The cleaned title (titleKey). */
  key: string;
}

export interface LibraryIndex {
  version: string;
  books: Map<string, IndexedBook>;
  bySavedId: Map<string, IndexedBook[]>;
  byAuthor: Map<string, IndexedBook[]>;
  byTitle: Map<string, IndexedBook[]>;
}

const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
  if (!k) return;
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

export const titleKey = (t: string): string => N(clean(t)) ?? '';

let cached: { db: Database.Database; index: LibraryIndex } | null = null;
/** Titles' keys from the last build (titleKey is the slow part: 0.5 s for 60,000 books). */
let keys = new Map<string, string>();

/** Book rowids per slice of an index build: about 15 ms on the PC (the NAS is ~2.5x slower). */
const ROWS_PER_SLICE = 500;

type BookRow = Omit<IndexedBook, 'authors' | 'key'>;

/**
 * Builds the index in slices of book rowids (the order of a plain scan of books), each slice a
 * short synchronous step; `between` runs after each slice (the async build yields there).
 * The version is the one read before the first slice: a change during the build builds again.
 */
function* buildSlices(db: Database.Database): Generator<void, LibraryIndex> {
  const version = bookListVersion(db);
  const maxRow =
    (db.prepare('SELECT MAX(rowid) AS m FROM books').get() as { m: number | null }).m ?? 0;
  const slice = db.prepare(
    `SELECT b.id, b.library_id AS libraryId, b.title, s.name AS series, b.created_at AS createdAt,
            bi.value AS savedId
     FROM books b
     LEFT JOIN series s ON s.id = b.series_id
     LEFT JOIN book_identifiers bi ON bi.book_id = b.id AND bi.type = 'bookmeter'
     WHERE b.rowid > ? AND b.rowid <= ?
       AND EXISTS (SELECT 1 FROM book_sources src WHERE src.book_id = b.id AND src.missing_at IS NULL)
     ORDER BY b.rowid`,
  );
  const authorsOf = db.prepare(
    `SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
     WHERE ba.book_id = ? ORDER BY ba.position`,
  );
  authorsOf.pluck();
  const books = new Map<string, IndexedBook>();
  const nextKeys = new Map<string, string>();
  for (let from = 0; from < maxRow; from += ROWS_PER_SLICE) {
    for (const r of slice.all(from, from + ROWS_PER_SLICE) as BookRow[]) {
      let key = nextKeys.get(r.title) ?? keys.get(r.title);
      if (key === undefined) key = titleKey(r.title);
      nextKeys.set(r.title, key);
      books.set(r.id, {
        ...r,
        savedId: r.savedId?.trim() || null,
        authors: authorsOf.all(r.id) as string[],
        key,
      });
    }
    yield;
  }
  keys = nextKeys;
  const index: LibraryIndex = {
    version,
    books,
    bySavedId: new Map(),
    byAuthor: new Map(),
    byTitle: new Map(),
  };
  let n = 0;
  for (const b of books.values()) {
    if (b.savedId) push(index.bySavedId, b.savedId, b);
    for (const a of b.authors) push(index.byAuthor, NA(a), b);
    push(index.byTitle, b.key, b);
    if (++n % (ROWS_PER_SLICE * 10) === 0) yield;
  }
  return index;
}

const isFresh = (db: Database.Database) =>
  !!cached && cached.db === db && cached.index.version === bookListVersion(db);

/**
 * The books in the library now, indexed for matching; rebuilt when the book list changed (not
 * when only figures such as ratings did). Synchronous: the loop builds it ahead with
 * libraryIndexAsync, so a route finds it built.
 */
export function libraryIndex(db: Database.Database): LibraryIndex {
  if (isFresh(db)) return cached!.index;
  const it = buildSlices(db);
  let r = it.next();
  while (!r.done) r = it.next();
  cached = { db, index: r.value };
  return r.value;
}

/** The same index, built in slices with a turn of the event loop between them. */
export async function libraryIndexAsync(db: Database.Database): Promise<LibraryIndex> {
  if (isFresh(db)) return cached!.index;
  const it = buildSlices(db);
  let r = it.next();
  while (!r.done) {
    await new Promise<void>((res) => setImmediate(res));
    // A synchronous build finished meanwhile (a route): use it.
    if (isFresh(db)) return cached!.index;
    r = it.next();
  }
  cached = { db, index: r.value };
  return r.value;
}

export interface EntryToMatch {
  listingId: string;
  title: string;
  authors: string[];
}

export type LinkHow = 'saved-id' | 'rules' | 'user';

export interface MatchResult {
  links: { bookId: string; how: LinkHow }[];
}

/** The account's books: every library when `libraries` is empty. */
const inScope = (b: IndexedBook, libraries: string[]) =>
  libraries.length === 0 || libraries.includes(b.libraryId);

function candidates(index: LibraryIndex, e: EntryToMatch, libraries: string[]): IndexedBook[] {
  const out = new Map<string, IndexedBook>();
  for (const a of e.authors) for (const b of index.byAuthor.get(NA(a)) ?? []) out.set(b.id, b);
  for (const b of index.byTitle.get(titleKey(e.title)) ?? []) out.set(b.id, b);
  return [...out.values()].filter((b) => inScope(b, libraries));
}

/**
 * The reader books an entry is. `choice`: the user's own (a book id, or null for "not in my
 * library"); undefined when they made none.
 */
export function matchEntry(
  index: LibraryIndex,
  e: EntryToMatch,
  libraries: string[],
  choice: string | null | undefined,
): MatchResult {
  if (choice !== undefined) {
    // Still only the account's libraries: a library it stopped covering belongs to another account.
    const b = choice === null ? undefined : index.books.get(choice);
    return { links: b && inScope(b, libraries) ? [{ bookId: b.id, how: 'user' }] : [] };
  }
  const saved = (index.bySavedId.get(e.listingId) ?? []).filter((b) => inScope(b, libraries));
  if (saved.length) return { links: saved.map((b) => ({ bookId: b.id, how: 'saved-id' })) };
  const hit = {
    id: e.listingId,
    title: e.title,
    authors: e.authors,
    pages: null,
  };
  const matched = candidates(index, e, libraries).filter((b) => {
    const j = judgeBookmeter([hit], {
      title: b.title,
      authors: b.authors,
      own: [b.title],
      chosen: { series: b.series, fmt: null, calTitle: b.title },
    });
    return j.tier[0] !== null;
  });
  return { links: matched.map((b) => ({ bookId: b.id, how: 'rules' })) };
}

export interface NearBook {
  id: string;
  libraryId: string;
  title: string;
  authors: string[];
  score: number;
}

/** For an entry nothing matched: the closest books by the same author or title (the Link list). */
export function nearBooks(
  index: LibraryIndex,
  e: EntryToMatch,
  libraries: string[],
  limit = 6,
): NearBook[] {
  return candidates(index, e, libraries)
    .map((b) => ({
      id: b.id,
      libraryId: b.libraryId,
      title: b.title,
      authors: b.authors,
      score: titleSimilarity(b.title, e.title),
    }))
    .filter((b) => b.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Books whose title has the words (the Link dialog's search), in the account's libraries. */
export function searchBooks(
  index: LibraryIndex,
  q: string,
  libraries: string[],
  limit = 20,
): NearBook[] {
  const key = titleKey(q);
  if (!key) return [];
  const out: NearBook[] = [];
  for (const b of index.books.values()) {
    if (!inScope(b, libraries)) continue;
    if (!b.key.includes(key)) continue;
    out.push({
      id: b.id,
      libraryId: b.libraryId,
      title: b.title,
      authors: b.authors,
      score: titleSimilarity(b.title, q),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

export interface BookActivity {
  /** A status record or a finished/started read-through. */
  state: boolean;
  /** A saved place (position record). */
  position: boolean;
}

/**
 * The copy a status goes on: the one you have read or opened (a status or read-through first,
 * then a saved place), else the one whose saved id is the listing, else the oldest. Ties: the
 * oldest. Pure.
 */
export function targetBook(
  books: { id: string; createdAt: number; savedId: string | null }[],
  listingId: string,
  activity: Map<string, BookActivity>,
): string | null {
  if (books.length === 0) return null;
  const rank = (b: (typeof books)[number]) => {
    const a = activity.get(b.id);
    if (a?.state) return 0;
    if (a?.position) return 1;
    if (b.savedId === listingId) return 2;
    return 3;
  };
  const sorted = [...books].sort(
    (x, y) => rank(x) - rank(y) || x.createdAt - y.createdAt || x.id.localeCompare(y.id),
  );
  return sorted[0].id;
}
