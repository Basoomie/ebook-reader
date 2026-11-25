/**
 * Store ratings (2026-11-25): the saved figures per site and id (ttsu.db `store_ratings`,
 * migration 33) and the pooled columns on `books` (kept by migration 33's triggers; the score's
 * `m`/`c` in `store_rating_params`).
 */
import type Database from 'better-sqlite3';
import { noteCatalogWrite } from '../catalog/catalog-version';
import { BOOK_RATING_SET } from '../db/migrations';
import type { ParsedRating } from './parse';

/** The identifier types ratings are read for (store_ratings.site). */
export type RatingSite = 'amazon_jp' | 'bookwalker' | 'bookmeter' | 'natively';
export const RATING_SITES: RatingSite[] = ['amazon_jp', 'bookwalker', 'bookmeter', 'natively'];
/** The sites the pooled star rating is made of. */
export const POOLED_SITES: RatingSite[] = ['amazon_jp', 'bookwalker'];

/** What a saved id must look like (lib/book-links/links.ts idPattern). */
export const SITE_ID_RE: Record<RatingSite, RegExp> = {
  amazon_jp: /^[0-9A-Z]{10}$/,
  bookwalker: /^[0-9a-f-]{36}$/i,
  bookmeter: /^\d+$/,
  natively: /^[0-9a-z]+$/i,
};

export interface RatingRow {
  site: RatingSite;
  siteId: string;
  avg: number | null;
  count: number | null;
  reviews: number | null;
  state: 'ok' | 'none' | 'gone' | 'error';
  checkedAt: number;
  fails: number;
}

interface DbRow {
  site: RatingSite;
  site_id: string;
  avg: number | null;
  count: number | null;
  reviews: number | null;
  state: RatingRow['state'];
  checked_at: number;
  fails: number;
}

const toRow = (r: DbRow): RatingRow => ({
  site: r.site,
  siteId: r.site_id,
  avg: r.avg,
  count: r.count,
  reviews: r.reviews,
  state: r.state,
  checkedAt: r.checked_at,
  fails: r.fails,
});

export function savedRating(
  db: Database.Database,
  site: RatingSite,
  siteId: string,
): RatingRow | null {
  const r = db
    .prepare('SELECT * FROM store_ratings WHERE site = ? AND site_id = ?')
    .get(site, siteId) as DbRow | undefined;
  return r ? toRow(r) : null;
}

/** A region-blocked page's error text and failure count (the due query's daily retries stop at 3). */
export const BLOCKED_ERROR = "sold only in Japan: the store hides it from the VPN's country";
export const BLOCKED_FAILS = 3;

/**
 * Saves an answer. `rating`/`none` replace the figures; `gone` clears them; `unreadable` and
 * errors keep the last good figures and count a failure. `blocked` (the store hides the book from
 * the fetcher's country) is an error that waits at once at the old-book pace: asking again daily
 * can't help. Returns true when a shown figure changed.
 */
export function saveRating(
  db: Database.Database,
  site: RatingSite,
  siteId: string,
  answer: ParsedRating | { kind: 'gone' } | { kind: 'error'; error: string },
  checkedAt: number,
): boolean {
  const before = savedRating(db, site, siteId);
  if (answer.kind === 'blocked') {
    db.prepare(
      `INSERT INTO store_ratings (site, site_id, avg, count, reviews, state, checked_at, error, fails)
       VALUES (?, ?, NULL, NULL, NULL, 'error', ?, ?, ?)
       ON CONFLICT(site, site_id) DO UPDATE SET state = 'error', error = excluded.error,
         checked_at = excluded.checked_at, fails = MAX(fails + 1, excluded.fails)`,
    ).run(site, siteId, checkedAt, BLOCKED_ERROR, BLOCKED_FAILS);
    return false;
  }
  if (answer.kind === 'unreadable' || answer.kind === 'error') {
    const error = answer.kind === 'error' ? answer.error : "the page's rating couldn't be read";
    db.prepare(
      `INSERT INTO store_ratings (site, site_id, avg, count, reviews, state, checked_at, error, fails)
       VALUES (?, ?, NULL, NULL, NULL, 'error', ?, ?, 1)
       ON CONFLICT(site, site_id) DO UPDATE SET state = 'error', error = excluded.error,
         checked_at = excluded.checked_at, fails = fails + 1`,
    ).run(site, siteId, checkedAt, error);
    return false;
  }
  const v =
    answer.kind === 'rating'
      ? { avg: answer.avg, count: answer.count, reviews: answer.reviews, state: 'ok' }
      : answer.kind === 'none'
        ? { avg: null, count: 0, reviews: site === 'bookmeter' ? 0 : null, state: 'none' }
        : { avg: null, count: null, reviews: null, state: 'gone' };
  db.prepare(
    `INSERT INTO store_ratings (site, site_id, avg, count, reviews, state, checked_at, error, fails)
     VALUES (@site, @siteId, @avg, @count, @reviews, @state, @checkedAt, NULL, 0)
     ON CONFLICT(site, site_id) DO UPDATE SET avg = excluded.avg, count = excluded.count,
       reviews = excluded.reviews, state = excluded.state, checked_at = excluded.checked_at,
       error = NULL, fails = 0`,
  ).run({ site, siteId, checkedAt, ...v });
  const changed =
    !before || before.avg !== v.avg || before.count !== v.count || before.reviews !== v.reviews;
  if (changed && site !== 'natively') noteCatalogWrite(db);
  return changed;
}

/** Every saved figure of a book, by site (the ids its links use). */
export function bookRatings(db: Database.Database, bookId: string): Map<RatingSite, RatingRow> {
  const rows = db
    .prepare(
      `SELECT r.* FROM book_identifiers bi
       JOIN store_ratings r ON r.site = bi.type AND r.site_id = bi.value
       WHERE bi.book_id = ?`,
    )
    .all(bookId) as DbRow[];
  return new Map(rows.map((r) => [r.site, toRow(r)]));
}

/** The book's saved id per site (only ids of the form the links use). */
export function bookSiteIds(db: Database.Database, bookId: string): Map<RatingSite, string> {
  const rows = db
    .prepare(
      `SELECT type, value FROM book_identifiers WHERE book_id = ?
       AND type IN ('amazon_jp', 'bookwalker', 'bookmeter', 'natively')`,
    )
    .all(bookId) as { type: RatingSite; value: string }[];
  const out = new Map<RatingSite, string>();
  for (const r of rows) {
    const id = r.value.trim();
    if (SITE_ID_RE[r.type].test(id)) out.set(r.type, id);
  }
  return out;
}

export interface ScoreParams {
  /** The middle the score pulls toward (the median pooled average). */
  m: number;
  /** How many imagined ratings at `m` every book starts with. */
  c: number;
}

export function readScoreParams(db: Database.Database): ScoreParams {
  const r = db.prepare('SELECT m, c FROM store_rating_params WHERE id = 1').get() as
    | ScoreParams
    | undefined;
  return r ?? { m: 4.1, c: 20 };
}

/** The median pooled average (x10 / 10) of rated books, or null with none. */
export function medianPooledAverage(db: Database.Database): number | null {
  const n = (
    db.prepare('SELECT COUNT(*) AS n FROM books WHERE rating_x10 IS NOT NULL').get() as {
      n: number;
    }
  ).n;
  if (n === 0) return null;
  const r = db
    .prepare(
      'SELECT rating_x10 AS v FROM books WHERE rating_x10 IS NOT NULL ORDER BY rating_x10 LIMIT 1 OFFSET ?',
    )
    .get(Math.floor(n / 2)) as { v: number };
  return r.v / 10;
}

/**
 * Sets the score's parameters and works every book's score out again (one statement) when they
 * changed. `m` null = the median of the saved ratings.
 */
export function updateScoreParams(
  db: Database.Database,
  c: number,
  m: number | null = medianPooledAverage(db),
): boolean {
  const now = readScoreParams(db);
  const next = { m: m ?? now.m, c };
  if (next.m === now.m && next.c === now.c) return false;
  db.transaction(() => {
    db.prepare('UPDATE store_rating_params SET m = ?, c = ? WHERE id = 1').run(next.m, next.c);
    recomputeBooks(db, 'rating_count IS NOT NULL');
  })();
  noteCatalogWrite(db);
  return true;
}

/** Recomputes the rating columns of the books matching `where` (SQL on `books`). */
export function recomputeBooks(
  db: Database.Database,
  where: string,
  params: unknown[] = [],
): number {
  return db.prepare(`UPDATE books SET ${BOOK_RATING_SET} WHERE ${where}`).run(...params).changes;
}
