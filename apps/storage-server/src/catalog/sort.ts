/**
 * Library sorts (WP19a): date added, title, author, length and publication date (and the
 * Natively level, migration 32; the store ratings' Rating, Most rated and Most read, migration 33),
 * each
 * ascending or descending, keyset-paginated like the date-added list.
 *
 * Books without a value (no character count yet, no publication date, an upload without
 * an author sort) always come last, whichever the direction. A count of 0 sorts with the
 * books not counted (migration 28): shortest first starts at the shortest counted book. That needs a different
 * sort expression per direction (a high or a low stand-in for NULL), so each such sort
 * has two indexes (migration 9); title and date added have no NULLs and one index each,
 * which SQLite also walks backwards.
 *
 * The expressions here must stay exactly the ones in migration 9, or SQLite stops using
 * the indexes (catalog-sort.test.ts checks every plan).
 */
import { decodeCursor, encodeCursor, InvalidCursorError } from './queries';

export type BookSortKey =
  | 'added'
  | 'title'
  | 'author'
  | 'chars'
  | 'published'
  | 'level'
  | 'rating'
  | 'ratings'
  | 'readers';
export type SortDir = 'asc' | 'desc';

export interface BookSort {
  key: BookSortKey;
  dir: SortDir;
}

export const BOOK_SORT_KEYS: BookSortKey[] = [
  'added',
  'title',
  'author',
  'chars',
  'published',
  'level',
  'rating',
  'ratings',
  'readers',
];
export const SORT_DIRS: SortDir[] = ['asc', 'desc'];

/** The default list order: newest added first. Its cursor keeps the pre-WP19 shape. */
export const DEFAULT_BOOK_SORT: BookSort = { key: 'added', dir: 'desc' };

/** Stand-ins for NULL so that books without a value sort last. */
const HIGH_NUMBER = 9000000000000000;
const HIGH_TEXT = String.fromCodePoint(0x10ffff);

interface SortColumn {
  type: 'number' | 'string';
  /** SQL on the `b` alias, per direction. */
  sql: Record<SortDir, string>;
  /** The same value from a row, per direction. */
  value(row: SortRow, dir: SortDir): number | string;
}

export interface SortRow {
  id: string;
  title: string;
  title_sort: string | null;
  author_sort: string | null;
  char_count: number | null;
  published_at: number | null;
  added_at: number;
  natively_level: number | null;
  rating_score: number | null;
  rating_count: number | null;
  readers: number | null;
}

const COLUMNS: Record<BookSortKey, SortColumn> = {
  added: {
    type: 'number',
    sql: { asc: 'b.added_at', desc: 'b.added_at' },
    value: (r) => r.added_at,
  },
  title: {
    type: 'string',
    sql: { asc: 'COALESCE(b.title_sort, b.title)', desc: 'COALESCE(b.title_sort, b.title)' },
    value: (r) => r.title_sort ?? r.title,
  },
  author: {
    type: 'string',
    sql: { asc: 'IFNULL(b.author_sort, char(1114111))', desc: "IFNULL(b.author_sort, '')" },
    value: (r, dir) => r.author_sort ?? (dir === 'asc' ? HIGH_TEXT : ''),
  },
  chars: {
    type: 'number',
    sql: {
      asc: `IFNULL(NULLIF(b.char_count, 0), ${HIGH_NUMBER})`,
      desc: 'IFNULL(b.char_count, -1)',
    },
    value: (r, dir) => (dir === 'asc' ? r.char_count || HIGH_NUMBER : (r.char_count ?? -1)),
  },
  published: {
    type: 'number',
    sql: {
      asc: `IFNULL(b.published_at, ${HIGH_NUMBER})`,
      desc: `IFNULL(b.published_at, -${HIGH_NUMBER})`,
    },
    value: (r, dir) => r.published_at ?? (dir === 'asc' ? HIGH_NUMBER : -HIGH_NUMBER),
  },
  // The Natively level (migration 32's two indexes): books without one last.
  level: {
    type: 'number',
    sql: {
      asc: `IFNULL(b.natively_level, ${HIGH_NUMBER})`,
      desc: 'IFNULL(b.natively_level, -1)',
    },
    value: (r, dir) => r.natively_level ?? (dir === 'asc' ? HIGH_NUMBER : -1),
  },
  // Store ratings (migration 33's indexes): books without a value last.
  rating: {
    type: 'number',
    sql: {
      asc: `IFNULL(b.rating_score, ${HIGH_NUMBER})`,
      desc: 'IFNULL(b.rating_score, -1)',
    },
    value: (r, dir) => r.rating_score ?? (dir === 'asc' ? HIGH_NUMBER : -1),
  },
  ratings: {
    type: 'number',
    sql: {
      asc: `IFNULL(b.rating_count, ${HIGH_NUMBER})`,
      desc: 'IFNULL(b.rating_count, -1)',
    },
    value: (r, dir) => r.rating_count ?? (dir === 'asc' ? HIGH_NUMBER : -1),
  },
  readers: {
    type: 'number',
    sql: {
      asc: `IFNULL(b.readers, ${HIGH_NUMBER})`,
      desc: 'IFNULL(b.readers, -1)',
    },
    value: (r, dir) => r.readers ?? (dir === 'asc' ? HIGH_NUMBER : -1),
  },
};

export function isDefaultSort(sort: BookSort): boolean {
  return sort.key === DEFAULT_BOOK_SORT.key && sort.dir === DEFAULT_BOOK_SORT.dir;
}

/** ORDER BY for a sort (ties broken by id in the same direction). */
export function sortOrderSql(sort: BookSort): string {
  const d = sort.dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${COLUMNS[sort.key].sql[sort.dir]} ${d}, b.id ${d}`;
}

function sortTag(sort: BookSort): string {
  return `${sort.key}-${sort.dir}`;
}

/** The cursor after `row`. Date added newest first keeps the old [addedAt, id] shape. */
export function encodeSortCursor(sort: BookSort, row: SortRow): string {
  if (isDefaultSort(sort)) return encodeCursor([row.added_at, row.id]);
  return encodeCursor([sortTag(sort), COLUMNS[sort.key].value(row, sort.dir), row.id]);
}

/** The keyset condition for a cursor; InvalidCursorError when it was made for another sort. */
export function sortCursorSql(sort: BookSort, cursor: string): { sql: string; params: unknown[] } {
  const col = COLUMNS[sort.key];
  let value: number | string;
  let id: string;
  if (isDefaultSort(sort)) {
    [value, id] = decodeCursor(cursor, ['number', 'string']) as [number, string];
  } else {
    const [tag, v, i] = decodeCursor(cursor, ['string', col.type, 'string']);
    if (tag !== sortTag(sort)) throw new InvalidCursorError('Cursor from another sort');
    value = v;
    id = i as string;
  }
  const expr = col.sql[sort.dir];
  const op = sort.dir === 'asc' ? '>' : '<';
  return {
    sql: `(${expr} ${op} ? OR (${expr} = ? AND b.id ${op} ?))`,
    params: [value, value, id],
  };
}

/** Parses ?sort=&dir= (both optional). Returns null for an unknown value. */
export function parseBookSort(key: unknown, dir: unknown): BookSort | null | undefined {
  if (key === undefined && dir === undefined) return undefined;
  const k = key === undefined ? DEFAULT_BOOK_SORT.key : key;
  if (!BOOK_SORT_KEYS.includes(k as BookSortKey)) return null;
  const d =
    dir === undefined ? (k === 'title' || k === 'author' || k === 'level' ? 'asc' : 'desc') : dir;
  if (!SORT_DIRS.includes(d as SortDir)) return null;
  return { key: k as BookSortKey, dir: d as SortDir };
}

/** Group tabs (series, authors, tags): sorted in memory (groups.ts). */
export type GroupSortKey = 'newest' | 'name' | 'count';
export const GROUP_SORT_KEYS: GroupSortKey[] = ['newest', 'name', 'count'];

export interface GroupSort {
  key: GroupSortKey;
  dir: SortDir;
}

export const DEFAULT_GROUP_SORT: GroupSort = { key: 'newest', dir: 'desc' };

export function parseGroupSort(key: unknown, dir: unknown): GroupSort | null | undefined {
  if (key === undefined && dir === undefined) return undefined;
  const k = key === undefined ? DEFAULT_GROUP_SORT.key : key;
  if (!GROUP_SORT_KEYS.includes(k as GroupSortKey)) return null;
  const d = dir === undefined ? (k === 'name' ? 'asc' : 'desc') : dir;
  if (!SORT_DIRS.includes(d as SortDir)) return null;
  return { key: k as GroupSortKey, dir: d as SortDir };
}
