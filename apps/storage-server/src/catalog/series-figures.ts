/**
 * Series and author figures on the server (docs/design/series-figures.md): what the Series and
 * Authors tabs sort and search by, and the `kept:` search everywhere. The rules are the web
 * app's own (`apps/web/src/lib/library/series-figures.ts`), run from the query bundle, so the
 * offline Library works out the same figures.
 *
 * Worked out live, never stored: one read of the books numbered 1-3 in a series (and, for the
 * Authors tab, of the author links), kept until the catalog, the store ratings, the score's
 * pull, your thresholds or the day change. A search term on a figure becomes the list of
 * series that match, bound as one JSON value, so it runs the same in the search worker.
 */
import type Database from 'better-sqlite3';
import { catalogVersion } from './catalog-version';
import { QUERY_BUNDLE, type QueryTerm } from './query-parser';
import { SQL_BOOK_FROM } from './queries';
import type { FigureTermSql, SqlCondition } from './search-sql';
import { globalSetting } from '../sync/global-setting';

export interface FigureRating {
  avg: number;
  count: number;
  score: number;
}

export interface SeriesFigure {
  rating: FigureRating | null;
  readers: number | null;
  kept: number | null;
}

export type FigureKey = 'rating' | 'ratings' | 'readers' | 'kept';

export interface KeptRules {
  minReaders: number;
  neighbourPercent: number;
  maxPercent: number;
  minMonths: number;
}

interface FigureVolume {
  id: string;
  library: string;
  series: string;
  index: number;
  ratingX10: number | null;
  ratingCount: number | null;
  ratingScore: number | null;
  readers: number | null;
  publishedAt: number | null;
}

interface FiguresBundle {
  seriesFigures(
    volumes: Iterable<FigureVolume>,
    rules: KeptRules,
    now: number,
  ): Map<string, SeriesFigure>;
  pickFigure(figures: readonly (SeriesFigure | undefined)[]): SeriesFigure | null;
  worksFigure(
    works: Iterable<{ rating: FigureRating | null; readers: number | null }>,
    params: { m: number; c: number },
  ): SeriesFigure;
  figureKey(library: string, series: string | number): string;
  figureSortValue(f: SeriesFigure | null | undefined, key: FigureKey): number | null;
  figureTermValue(f: SeriesFigure | null | undefined, key: FigureKey): number | null;
  figureMatches(
    value: number | null,
    min: number | null,
    max: number | null,
    negated: boolean,
  ): boolean;
  DEFAULT_KEPT_RULES: KeptRules;
  DEFAULT_SCORE_PARAMS: { m: number; c: number };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(QUERY_BUNDLE) as FiguresBundle;

export const pickFigure = bundle.pickFigure;
export const figureSortValue = bundle.figureSortValue;
export const DEFAULT_KEPT_RULES = bundle.DEFAULT_KEPT_RULES;

/** The synced settings of "Went on to vol 2" (web: lib/library/series-figures-settings.ts). */
export const KEPT_SETTING_KEYS: Record<keyof KeptRules, string> = {
  minReaders: 'seriesKeptMinReaders',
  neighbourPercent: 'seriesKeptNeighbourPercent',
  maxPercent: 'seriesKeptMaxPercent',
  minMonths: 'seriesKeptMinMonths',
};

/** Your thresholds (synced global settings; the defaults when unset or not a number). */
export function keptRules(db: Database.Database, userId: string): KeptRules {
  const out = { ...DEFAULT_KEPT_RULES };
  for (const key of Object.keys(KEPT_SETTING_KEYS) as (keyof KeptRules)[]) {
    const raw = globalSetting(db, userId, KEPT_SETTING_KEYS[key]);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

function scoreParams(db: Database.Database): { m: number; c: number } {
  const row = db.prepare('SELECT m, c FROM store_rating_params WHERE id = 1').get() as
    | { m: number; c: number }
    | undefined;
  return row ?? bundle.DEFAULT_SCORE_PARAMS;
}

/**
 * Changes when a book's ratings may have: a store page read (the triggers write books then),
 * or the score's pull. Each site's newest check comes from the store_ratings_due index.
 */
function ratingsStamp(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT (SELECT MAX(checked_at) FROM store_ratings WHERE site = 'amazon_jp') AS a,
              (SELECT MAX(checked_at) FROM store_ratings WHERE site = 'bookwalker') AS w,
              (SELECT MAX(checked_at) FROM store_ratings WHERE site = 'bookmeter') AS m`,
    )
    .get() as { a: number | null; w: number | null; m: number | null };
  const p = scoreParams(db);
  // The refresher reads a store page every few seconds while it runs: a page read moves the
  // figures at most once per window (catalog changes still count at once), so the Series and
  // Authors tabs aren't worked out again on every request (measured: 170-650 ms each).
  const w = (t: number | null) => Math.floor((t ?? 0) / RATINGS_WINDOW_MS);
  return `${w(row.a)}:${w(row.w)}:${w(row.m)}:${p.m}:${p.c}`;
}

const DAY = 24 * 60 * 60 * 1000;
/** How long a store page read may wait before the figures include it (ratingsStamp). */
const RATINGS_WINDOW_MS = 10 * 60 * 1000;

export interface FigureIndex {
  /** figureKey(library, series id) → that library's series figures. */
  byKey: Map<string, SeriesFigure>;
  /** series id → library → figures. */
  bySeries: Map<number, Map<string, SeriesFigure>>;
}

const indexCache = new WeakMap<Database.Database, Map<string, FigureIndex>>();

function stamp(db: Database.Database): string {
  return `${catalogVersion(db)}|${ratingsStamp(db)}|${Math.floor(Date.now() / DAY)}`;
}

/** Every series' figures (the books the Library shows: not missing, enabled libraries). */
export function figureIndex(db: Database.Database, userId: string, now = Date.now()): FigureIndex {
  const rules = keptRules(db, userId);
  const key = `${stamp(db)}|${JSON.stringify(rules)}`;
  let cache = indexCache.get(db);
  if (!cache) {
    cache = new Map();
    indexCache.set(db, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const volumes: FigureVolume[] = [];
  for (const r of db
    .prepare(
      `SELECT b.id, b.library_id, b.series_id, b.series_index, b.rating_x10, b.rating_count,
              b.rating_score, b.readers, b.published_at
         ${SQL_BOOK_FROM}
        WHERE s.missing_at IS NULL AND b.series_id IS NOT NULL AND b.series_index IN (1, 2, 3)`,
    )
    .raw()
    .iterate() as IterableIterator<
    [
      string,
      string,
      number,
      number,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ]
  >) {
    volumes.push({
      id: r[0],
      library: r[1],
      series: String(r[2]),
      index: r[3],
      ratingX10: r[4],
      ratingCount: r[5],
      ratingScore: r[6],
      readers: r[7],
      publishedAt: r[8],
    });
  }
  const byKey = bundle.seriesFigures(volumes, rules, now);
  const bySeries = new Map<number, Map<string, SeriesFigure>>();
  for (const v of volumes) {
    const sid = Number(v.series);
    let libs = bySeries.get(sid);
    if (!libs) {
      libs = new Map();
      bySeries.set(sid, libs);
    }
    const f = byKey.get(bundle.figureKey(v.library, v.series));
    if (f) libs.set(v.library, f);
  }
  const index = { byKey, bySeries };
  // Older stamps are of no use again: keep only the newest per database.
  cache.clear();
  cache.set(key, index);
  return index;
}

/** A series group's figures: the library asked for, else the one whose volume 1 has the most readers. */
export function groupFigure(
  index: FigureIndex,
  seriesId: number | null,
  libraryId?: string,
): SeriesFigure | null {
  if (seriesId === null) return null;
  const libs = index.bySeries.get(seriesId);
  if (!libs) return null;
  if (libraryId) return libs.get(libraryId) ?? null;
  return bundle.pickFigure([...libs.values()]);
}

/** An author's book, as the works figures read it. */
type AuthorRow = [
  authorId: number,
  bookId: string,
  library: string,
  seriesId: number | null,
  ratingX10: number | null,
  ratingCount: number | null,
  ratingScore: number | null,
  readers: number | null,
];

const authorRowsCache = new WeakMap<
  Database.Database,
  { base: string; key: string; rows: AuthorRow[] }[]
>();

function authorRows(
  db: Database.Database,
  opts: { libraryId?: string; includeMissing?: boolean },
): AuthorRow[] {
  const base = `${catalogVersion(db)}|${ratingsStamp(db)}`;
  const key = `${opts.libraryId ?? ''}|${!!opts.includeMissing}`;
  // Only the current catalog's rows are kept (a few library/missing variants of it).
  const list = (authorRowsCache.get(db) ?? []).filter((e) => e.base === base);
  authorRowsCache.set(db, list);
  const hit = list.find((e) => e.key === key);
  if (hit) return hit.rows;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.libraryId) {
    conds.push('b.library_id = ?');
    params.push(opts.libraryId);
  }
  if (!opts.includeMissing) conds.push('s.missing_at IS NULL');
  const rows = db
    .prepare(
      `SELECT ba.author_id, b.id, b.library_id, b.series_id, b.rating_x10, b.rating_count,
              b.rating_score, b.readers
         ${SQL_BOOK_FROM}
         JOIN book_authors ba ON ba.book_id = b.id
         ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}`,
    )
    .raw()
    .all(...params) as AuthorRow[];
  list.push({ base, key, rows });
  while (list.length > 4) list.shift();
  return rows;
}

/**
 * Every author's figures over their works: each series once (its figures in that library),
 * each book without a series on its own. With `books`, only those books count (a collection).
 */
export function authorFigures(
  db: Database.Database,
  index: FigureIndex,
  opts: { libraryId?: string; includeMissing?: boolean },
  books?: ReadonlySet<string>,
): Map<number, SeriesFigure> {
  // The whole library's (not a collection's) are kept with the index they were made from.
  if (books) return worksOf(db, index, opts, books);
  const key = `${opts.libraryId ?? ''}|${!!opts.includeMissing}|${scoreStamp(db)}`;
  let byOpts = authorCache.get(index);
  if (!byOpts) {
    byOpts = new Map();
    authorCache.set(index, byOpts);
  }
  const hit = byOpts.get(key);
  if (hit && hit.rows === authorRows(db, opts)) return hit.figures;
  const figures = worksOf(db, index, opts);
  byOpts.set(key, { rows: authorRows(db, opts), figures });
  return figures;
}

const authorCache = new WeakMap<
  FigureIndex,
  Map<string, { rows: AuthorRow[]; figures: Map<number, SeriesFigure> }>
>();

function scoreStamp(db: Database.Database): string {
  const p = scoreParams(db);
  return `${p.m}:${p.c}`;
}

function worksOf(
  db: Database.Database,
  index: FigureIndex,
  opts: { libraryId?: string; includeMissing?: boolean },
  books?: ReadonlySet<string>,
): Map<number, SeriesFigure> {
  const works = new Map<
    number,
    Map<string, { rating: FigureRating | null; readers: number | null }>
  >();
  for (const [authorId, bookId, library, seriesId, x10, count, score, readers] of authorRows(
    db,
    opts,
  )) {
    if (books && !books.has(bookId)) continue;
    let mine = works.get(authorId);
    if (!mine) {
      mine = new Map();
      works.set(authorId, mine);
    }
    if (seriesId !== null) {
      const key = `s${bundle.figureKey(library, seriesId)}`;
      if (mine.has(key)) continue;
      const f = index.byKey.get(bundle.figureKey(library, seriesId));
      mine.set(key, { rating: f?.rating ?? null, readers: f?.readers ?? null });
    } else {
      mine.set(`b${bookId}`, {
        rating:
          x10 !== null && count !== null && score !== null ? { avg: x10 / 10, count, score } : null,
        readers,
      });
    }
  }
  const params = scoreParams(db);
  const out = new Map<number, SeriesFigure>();
  for (const [authorId, mine] of works)
    out.set(authorId, bundle.worksFigure(mine.values(), params));
  return out;
}

const FIGURE_TERMS = new Set(['rating', 'ratings', 'readers']);

/**
 * Search terms on figures: `kept:` everywhere (a book carries its series' figure in its own
 * library); on the Series tab also rating:, ratings: and readers:, which test the series'
 * figures (volume 1) and not each book. Other terms: null (search-sql.ts handles them).
 */
export function figureTerms(
  db: Database.Database,
  userId: string,
  opts: { seriesTab: boolean; libraryId?: string },
): FigureTermSql {
  let index: FigureIndex | null = null;
  const get = () => (index ??= figureIndex(db, userId));
  return {
    termSql(term: QueryTerm): SqlCondition | null {
      const onSeries = opts.seriesTab && FIGURE_TERMS.has(term.type);
      if (term.type !== 'kept' && !onSeries) return null;
      const t = term as Extract<QueryTerm, { min: number | null; max: number | null }>;
      const key = term.type as FigureKey;
      const idx = get();
      if (opts.seriesTab) {
        const ids: number[] = [];
        for (const sid of idx.bySeries.keys()) {
          const value = bundle.figureTermValue(groupFigure(idx, sid, opts.libraryId), key);
          if (bundle.figureMatches(value, t.min, t.max, t.negated)) ids.push(sid);
        }
        return {
          sql: 'b.series_id IN (SELECT value FROM json_each(?))',
          params: [JSON.stringify(ids)],
        };
      }
      const keys: string[] = [];
      for (const [k, f] of idx.byKey) {
        if (bundle.figureMatches(bundle.figureTermValue(f, key), t.min, t.max, t.negated))
          keys.push(k);
      }
      return {
        sql: "(b.library_id || ':' || b.series_id) IN (SELECT value FROM json_each(?))",
        params: [JSON.stringify(keys)],
      };
    },
  };
}
