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
import { catalogVersion } from '../catalog/catalog-version';

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

/** The books in the library now, indexed for matching; rebuilt when the catalog changed. */
export function libraryIndex(db: Database.Database): LibraryIndex {
  const version = catalogVersion(db);
  if (cached && cached.db === db && cached.index.version === version) return cached.index;
  const books = new Map<string, IndexedBook>();
  for (const r of db
    .prepare(
      `SELECT b.id, b.library_id AS libraryId, b.title, s.name AS series, b.created_at AS createdAt,
              bi.value AS savedId
       FROM books b
       LEFT JOIN series s ON s.id = b.series_id
       LEFT JOIN book_identifiers bi ON bi.book_id = b.id AND bi.type = 'bookmeter'
       WHERE EXISTS (SELECT 1 FROM book_sources src WHERE src.book_id = b.id AND src.missing_at IS NULL)`,
    )
    .all() as Omit<IndexedBook, 'authors' | 'key'>[]) {
    books.set(r.id, {
      ...r,
      savedId: r.savedId?.trim() || null,
      authors: [],
      key: titleKey(r.title),
    });
  }
  for (const r of db
    .prepare(
      `SELECT ba.book_id, a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
       ORDER BY ba.book_id, ba.position`,
    )
    .all() as { book_id: string; name: string }[]) {
    books.get(r.book_id)?.authors.push(r.name);
  }
  const index: LibraryIndex = {
    version,
    books,
    bySavedId: new Map(),
    byAuthor: new Map(),
    byTitle: new Map(),
  };
  for (const b of books.values()) {
    if (b.savedId) push(index.bySavedId, b.savedId, b);
    for (const a of b.authors) push(index.byAuthor, NA(a), b);
    push(index.byTitle, b.key, b);
  }
  cached = { db, index };
  return index;
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
